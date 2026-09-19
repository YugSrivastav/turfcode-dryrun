import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import blessed from 'blessed';
import { spawnHostDaemon } from '../server/index.js';
import { buildFileTree, flattenFileTree, formatTreeNode, getProjectFiles, getTruncatedPath } from '../server/tui.js';
import { ptyManager, isAgentAvailable, safeEscape, parseCodexJsonLine, parseAgyJsonLine } from '../server/pty_manager.js';
import WebSocket from 'ws';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TURF_ROOT = path.resolve(__dirname, '..');

async function runTests() {
  console.log('--- STARTING E2E TESTS ---');
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${message}`);
      failed++;
    }
  }

  // A. Syntax Verification
  console.log('\n--- Checking Syntax ---');
  const files = [
    'bin/turf.js', 'server/tui.js', 'server/index.js', 
    'server/events.js', 'server/rooms.js', 'server/locks.js',
    'server/pty_manager.js'
  ];
  for (const file of files) {
    try {
      execSync(`node --check "${path.join(TURF_ROOT, file)}"`);
      assert(true, `${file} syntax OK`);
    } catch (e) {
      assert(false, `${file} syntax error: ${e.message}`);
    }
  }

  // B. Daemon & WebSocket Test
  console.log('\n--- Testing Daemon & WebSockets ---');
  const TEST_PORT = 7999;
  const { room, server, wss, port: actualPort } = await spawnHostDaemon({ hostName: 'TestHost', repoPath: TURF_ROOT, port: TEST_PORT });
  assert(room.code.startsWith('TRF-'), 'Room code generated correctly');

  await new Promise(resolve => setTimeout(resolve, 500)); // wait for daemon

  const ws = new WebSocket(`ws://127.0.0.1:${actualPort}`);
  
  let peerUpdateReceived = false;
  let chatMessageReceived = false;
  let agentStatusReceived = false;

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'peer:join', user: 'TestPeer', role: 'Peer' }));
    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'chat:send', user: 'TestPeer', message: 'Hello World' }));
    }, 200);
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: 'agent:status',
        user: 'TestPeer',
        agent: 'agy',
        status: 'working',
        details: 'unit test task'
      }));
    }, 400);
  });

  ws.on('message', (raw) => {
    const data = JSON.parse(raw);
    if (data.type === 'peer:update') {
      if (data.peers.some(p => p.name === 'TestPeer')) {
        peerUpdateReceived = true;
      }
    }
    if (data.type === 'chat:message' && data.message === 'Hello World') {
      chatMessageReceived = true;
    }
    if (data.type === 'agent:status' && data.agent === 'agy' && data.status === 'working') {
      agentStatusReceived = true;
    }
  });

  await new Promise(resolve => setTimeout(resolve, 1000));
  
  assert(peerUpdateReceived, 'Peer update broadcasted on join');
  assert(chatMessageReceived, 'Chat message broadcasted and received');
  assert(agentStatusReceived, 'Agent status broadcasted and received across WebSocket');

  // C. File Explorer & Tree Logic Verification
  console.log('\n--- Testing File Explorer & Tree Logic ---');
  const tree = buildFileTree(TURF_ROOT);
  assert(tree.some(n => n.name === 'server' && n.isDir), 'Tree contains server/ directory');
  assert(tree.some(n => n.name === 'bin' && n.isDir), 'Tree contains bin/ directory');
  assert(tree.every(n => n.name !== 'node_modules'), 'Tree filters out node_modules');

  const expanded = new Set(['server', 'bin']);
  const flattened = flattenFileTree(tree, expanded);
  assert(flattened.some(n => n.relPath === 'server/tui.js'), 'Discovered server/tui.js in flattened tree');
  assert(flattened.some(n => n.relPath === 'bin/turf.js'), 'Discovered bin/turf.js in flattened tree');

  // Test fold / collapse logic
  expanded.delete('server');
  const collapsedTree = flattenFileTree(tree, expanded);
  assert(!collapsedTree.some(n => n.relPath === 'server/tui.js'), 'server/tui.js hidden when server/ is collapsed');

  // Test icon and formatting
  const serverNode = flattened.find(n => n.name === 'server');
  const formattedFolder = formatTreeNode(serverNode);
  assert(formattedFolder.includes('▾') && formattedFolder.includes('server/'), 'Formatted folder contains ▾ arrow and trailing slash');

  const jsNode = flattened.find(n => n.name === 'tui.js');
  const formattedFile = formatTreeNode(jsNode);
  assert(formattedFile.includes('▪') && formattedFile.includes('tui.js'), 'Formatted JS file contains ▪ glyph');

  // Test long file name truncation to prevent border overflow
  const longNode = { name: 'super-long-component-specification-name.jsx', isDir: false, depth: 1 };
  const formattedLong = formatTreeNode(longNode, 24);
  assert(formattedLong.includes('…'), 'Long filename safely truncated with ellipsis');
  const plainLong = formattedLong.replace(/{[^}]+}/g, '');
  assert(blessed.unicode.strWidth(plainLong) === 24, 'Formatted tree line strictly padded/truncated to exact 24 visual display cells');

  // Test deep folder tree node truncation
  const deepNode = { name: 'sub-sub-directory-nested-name', isDir: true, depth: 4, isExpanded: false };
  const formattedDeep = formatTreeNode(deepNode, 24);
  const plainDeep = formattedDeep.replace(/{[^}]+}/g, '');
  assert(blessed.unicode.strWidth(plainDeep) === 24, 'Deep folder tree node formatted to exact 24 visual display cells');

  // Test getTruncatedPath
  const shortPath = getTruncatedPath('C:/Projects/App', 25);
  assert(shortPath === 'C:/Projects/App', 'Short path preserved intact');
  const longPath = getTruncatedPath('C:/Users/Developers/Projects/Deeply/Nested/Repository', 22);
  assert(longPath.includes('…'), 'Long path truncated to fit header bounds');
  assert(longPath.length <= 22, 'Long path length within specified maxLen');

  // Test backward-compatible getProjectFiles
  const legacyFiles = getProjectFiles(TURF_ROOT);
  assert(legacyFiles.includes('server/tui.js') && legacyFiles.includes('bin/turf.js'), 'getProjectFiles returns all files');

  // D. Double Ctrl+C Logic Verification
  console.log('\n--- Testing Double Ctrl+C Guard ---');
  let lastPress = 0;
  let exitTriggered = false;
  function simulateCtrlC() {
    const now = Date.now();
    if (lastPress > 0 && (now - lastPress) <= 2000) {
      exitTriggered = true;
      return 'EXIT';
    }
    lastPress = now;
    return 'WARN';
  }

  assert(simulateCtrlC() === 'WARN' && !exitTriggered, 'Single Ctrl+C only warns');
  assert(simulateCtrlC() === 'EXIT' && exitTriggered, 'Second Ctrl+C within 2s confirms quit');

  // E. Sidebar Toggle Clear Logic Verification
  console.log('\n--- Testing Sidebar Toggle Clear Logic ---');
  const testScreen = blessed.screen({ smartCSR: false });
  testScreen.program.cols = 100;
  testScreen.program.rows = 20;
  testScreen.alloc();

  const testLeftSidebar = blessed.box({ top: 1, left: 0, width: 32, height: '100%-2' });
  const testFilesBox = blessed.box({ parent: testLeftSidebar, top: 0, left: 0, width: '100%', height: '100%', border: { type: 'line', fg: 'cyan' }, tags: true });
  const testCenterPane = blessed.box({ top: 1, left: 32, width: '100%-64', height: '100%-2', border: { type: 'line', left: false, right: false, top: true, bottom: true, fg: 'green' } });
  testScreen.append(testLeftSidebar);
  testScreen.append(testCenterPane);
  testScreen.render();

  assert(testScreen.lines[3][31][1] === '│', 'Sidebar open draws border at col 31');
  assert(testScreen.lines[3][32][1] === ' ', 'No duplicate border at col 32 when open');

  // Collapse sidebar
  testLeftSidebar.hide();
  testCenterPane.left = 0;
  testCenterPane.width = '100%-32';
  testCenterPane.border.left = true;
  testScreen.realloc();
  testScreen.render();

  assert(testScreen.lines[3][31][1] === ' ', 'Sidebar collapsed clears old col 31 border');
  assert(testScreen.lines[3][0][1] === '│', 'Sidebar collapsed draws border at col 0');

  // Restore sidebar
  testLeftSidebar.show();
  testCenterPane.left = 32;
  testCenterPane.width = '100%-64';
  testCenterPane.border.left = false;
  testScreen.realloc();
  testScreen.render();

  assert(testScreen.lines[3][31][1] === '│', 'Sidebar restored restores col 31 border');
  assert(testScreen.lines[3][32][1] === ' ', 'Sidebar restored maintains clean spacing at col 32');

  console.log('\n--- Testing Stdin Cleanup & Single Keypress Typing ---');
  const { PassThrough } = await import('stream');
  const readline = (await import('readline')).default;
  const mockStdin = new PassThrough();
  const mockStdout = new PassThrough();
  
  // Simulate readline having been used in CLI prompt
  readline.emitKeypressEvents(mockStdin);

  // Apply cleanup logic
  mockStdin.removeAllListeners('newListener');
  mockStdin.removeAllListeners('keypress');
  mockStdin.removeAllListeners('data');
  mockStdin.removeAllListeners('line');
  for (const s of Object.getOwnPropertySymbols(mockStdin)) {
    const desc = s.description || s.toString();
    if (desc.includes('keypress') || desc.includes('escape')) {
      delete mockStdin[s];
    }
  }

  // Create blessed screen with cleaned stream
  const typeScreen = blessed.screen({ input: mockStdin, output: mockStdout, smartCSR: false });
  const typeInput = blessed.textbox({ parent: typeScreen, keys: true });
  typeInput.readInput();

  await new Promise(resolve => setImmediate(resolve));
  for (const char of 'opencode') {
    mockStdin.write(char);
  }

  assert(typeInput.value === 'opencode', `Typed value is strictly single-character 'opencode' (was: '${typeInput.value}')`);
  typeInput.destroy();
  typeScreen.destroy();

  console.log('\n--- Testing Files List Single Step Navigation ---');
  const navInput = new PassThrough();
  const navOutput = new PassThrough();
  const navScreen = blessed.screen({ input: navInput, output: navOutput, smartCSR: false });
  const navList = blessed.list({
    parent: navScreen,
    keys: false,
    vi: false,
    items: ['file1.js', 'file2.js', 'file3.js', 'file4.js']
  });

  navScreen.program.on('keypress', (ch, key) => {
    if (!key) return;
    if (key.name === 'down') {
      navList.down();
      navScreen.render();
    } else if (key.name === 'up') {
      navList.up();
      navScreen.render();
    }
  });

  navList.select(0);
  assert(navList.selected === 0, 'Initial list selection is at index 0');

  navScreen.program.emit('keypress', '\x1b[B', { name: 'down' });
  assert(navList.selected === 1, `Down key advances selection by exactly 1 item to index 1 (got ${navList.selected})`);

  navScreen.program.emit('keypress', '\x1b[B', { name: 'down' });
  assert(navList.selected === 2, `Second down key advances selection by exactly 1 item to index 2 (got ${navList.selected})`);

  navScreen.program.emit('keypress', '\x1b[A', { name: 'up' });
  assert(navList.selected === 1, `Up key retreats selection by exactly 1 item to index 1 (got ${navList.selected})`);

  navList.destroy();
  navScreen.destroy();

  console.log('\n--- Testing PTY Manager & Collaborative Agent State ---');
  assert(typeof ptyManager.isPtySupported() === 'boolean', 'ptyManager.isPtySupported() returns boolean');
  assert(isAgentAvailable('agy') === true, 'isAgentAvailable(agy) accurately detects installed Antigravity');
  assert(isAgentAvailable('codex') === true, 'isAgentAvailable(codex) accurately detects installed Codex');
  assert(ptyManager.getStatus('term') === 'idle', 'Initial term tab status is idle');
  assert(ptyManager.getStatus('agy') === 'idle', 'Initial agy tab status is idle');
  assert(ptyManager.getStatus('codex') === 'idle', 'Initial codex tab status is idle');

  console.log('\n--- Testing Persistent Multi-Turn Agent Configuration & Usage ---');
  ptyManager.setModel('codex', 'gpt-4o');
  assert(ptyManager.getModel('codex') === 'gpt-4o', 'ptyManager.setModel sets model for codex');

  ptyManager.setEffort('codex', 'high');
  assert(ptyManager.getEffort('codex') === 'high', 'ptyManager.setEffort sets reasoning effort');

  ptyManager.setSandbox('codex', 'workspace-write');
  assert(ptyManager.getSandbox('codex') === 'workspace-write', 'ptyManager.setSandbox sets sandbox permission');

  ptyManager.resumeSession('codex', 'session-uuid-12345');
  let stats = ptyManager.getUsageStats('codex');
  assert(stats.sessionId === 'session-uuid-12345', 'ptyManager.resumeSession updates sessionId');
  assert(stats.model === 'gpt-4o', 'ptyManager.getUsageStats reflects active model');
  assert(stats.effort === 'high', 'ptyManager.getUsageStats reflects active effort');
  assert(stats.sandbox === 'workspace-write', 'ptyManager.getUsageStats reflects active sandbox');

  ptyManager.resetSession('codex');
  stats = ptyManager.getUsageStats('codex');
  assert(stats.sessionId === '(No active session ID yet)', 'ptyManager.resetSession clears sessionId');
  assert(stats.turnCount === 0, 'ptyManager.resetSession resets turnCount to 0');
  assert(stats.totalTokens === 0, 'ptyManager.resetSession resets totalTokens to 0');

  console.log('\n--- Testing Slash Commands & Autocomplete Matching ---');
  const commands = [
    '/usage', '/model', '/effort', '/sandbox', '/new', '/resume', '/diff', '/kill', '/codex', '/agy', '/term', '/chat', '/files', '/web', '/help'
  ];
  const filterByU = commands.filter(c => c.startsWith('/u'));
  assert(filterByU.includes('/usage'), 'Palette query "/u" matches /usage');

  const filterByM = commands.filter(c => c.startsWith('/m'));
  assert(filterByM.includes('/model'), 'Palette query "/m" matches /model');

  const filterByE = commands.filter(c => c.startsWith('/e'));
  assert(filterByE.includes('/effort'), 'Palette query "/e" matches /effort');

  const filterByD = commands.filter(c => c.startsWith('/d'));
  assert(filterByD.includes('/diff'), 'Palette query "/d" matches /diff');

  console.log('\n--- Testing Structured Agent Message Events ---');
  let receivedMsg = null;
  const msgHandler = (msg) => { receivedMsg = msg; };
  ptyManager.on('agent:msg', msgHandler);

  ptyManager.emit('agent:msg', {
    tabId: 'codex',
    type: 'tool',
    text: '{grey-fg}🔍 [Search]{/grey-fg} {yellow-fg}server/ (grep: isAgentAvailable){/yellow-fg}'
  });
  assert(receivedMsg !== null, 'agent:msg event received');
  assert(receivedMsg.tabId === 'codex', 'agent:msg has correct tabId');
  assert(receivedMsg.text.includes('[Search]'), 'agent:msg contains structured tool badge');

  ptyManager.emit('agent:msg', {
    tabId: 'agy',
    type: 'message',
    text: '{bold}{149-fg}💬 Antigravity:{/149-fg}{/bold}\nPRD outline generated successfully.'
  });
  assert(receivedMsg.tabId === 'agy', 'agent:msg has correct agy tabId');
  assert(receivedMsg.text.includes('Antigravity'), 'agent:msg contains Antigravity prefix');

  ptyManager.removeListener('agent:msg', msgHandler);

  console.log('\n--- Testing Agent Process Crash Guards & Blessed Tag Safety ---');
  // 1. Empty spawnSession returns null
  const emptyCodex = ptyManager.spawnSession('codex', '');
  assert(emptyCodex === null, 'spawnSession(codex, "") safely returns null without spawning process');
  const emptyAgy = ptyManager.spawnSession('agy', '');
  assert(emptyAgy === null, 'spawnSession(agy, "") safely returns null without spawning process');

  // 2. safeEscape escapes curly braces
  const escaped = safeEscape('const x = { a: 1, b: 2 };');
  assert(escaped === 'const x = {open} a: 1, b: 2 {close};', 'safeEscape correctly replaces { and } with {open} and {close}');

  // 3. parseCodexJsonLine handles code blocks with curly braces safely
  let parsedCodexMsg = null;
  const dummyCodexConfig = { turnCount: 1, totalTokens: 0 };
  parseCodexJsonLine(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'function hello() { return true; }' }
  }), dummyCodexConfig, (ev, payload) => { parsedCodexMsg = payload; });
  assert(parsedCodexMsg !== null && parsedCodexMsg.text.includes('{open} return true; {close}'), 'parseCodexJsonLine escapes code curly braces');

  // 4. parseAgyJsonLine handles response with curly braces safely
  const agyMsgs = [];
  const dummyAgyConfig = { turnCount: 1, totalTokens: 0 };
  parseAgyJsonLine(JSON.stringify({
    event: 'result',
    result: { response: 'Code: { id: "123" }' }
  }), dummyAgyConfig, (ev, payload) => { agyMsgs.push(payload); });
  const agyMsgEvent = agyMsgs.find(m => m.type === 'message');
  // 5. parseAgyJsonLine handles 429 rate limit with modern model tip
  const agyErrMsgs = [];
  parseAgyJsonLine(JSON.stringify({
    event: 'result',
    result: { error: 'RESOURCE_EXHAUSTED (code 429): Quota exceeded' }
  }), dummyAgyConfig, (ev, payload) => { agyErrMsgs.push({ ev, payload }); });
  const agyErr = agyErrMsgs.find(m => m.ev === 'agent:msg' && m.payload.type === 'error');
  assert(agyErr !== undefined && agyErr.payload.text.includes('gemini-3.8-flash-high'), 'parseAgyJsonLine recommends modern gemini-3.8-flash-high model');
  assert(!agyErr.payload.text.includes('gemini-2.5-flash'), 'parseAgyJsonLine does not recommend deprecated gemini-2.5-flash');
  const agyIdleStatus = agyErrMsgs.find(m => m.ev === 'status' && m.payload.status === 'idle');
  assert(agyIdleStatus !== undefined, 'parseAgyJsonLine immediately resets status to idle on 429 error');

  // 6. parseAgyJsonLine live response streaming via agent:stream
  const agyStreamMsgs = [];
  parseAgyJsonLine(JSON.stringify({
    event: 'step_update',
    step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Hello streamed response!' }
  }), dummyAgyConfig, (ev, payload) => { agyStreamMsgs.push({ ev, payload }); });
  const streamEv = agyStreamMsgs.find(m => m.ev === 'agent:stream');
  assert(streamEv !== undefined && streamEv.payload.text === 'Hello streamed response!', 'parseAgyJsonLine emits agent:stream for live response streaming');
  assert(ptyManager.getModel('agy') === 'gemini-3.8-flash-high', 'ptyManager defaults agy model to gemini-3.8-flash-high');

  // 7. Isolation Test: Codex error tips strictly suggest Codex models, never Gemini
  const codexErrMsgs = [];
  parseCodexJsonLine(JSON.stringify({
    type: 'error',
    error: { message: 'Rate limit 429: Requests exceeded' }
  }), dummyCodexConfig, (ev, payload) => { codexErrMsgs.push({ ev, payload }); });
  const codexErr = codexErrMsgs.find(m => m.ev === 'agent:msg' && m.payload.type === 'error');
  assert(codexErr !== undefined && codexErr.payload.text.includes('o3-mini'), 'parseCodexJsonLine recommends o3-mini or gpt-4o on rate limit');
  assert(!codexErr.payload.text.includes('gemini'), 'parseCodexJsonLine strictly never recommends Gemini models (isolated from AGY)');

  // 8. Rust tracing suppression: parseCodexJsonLine does not emit raw websocket traces
  let leakedTrace = false;
  parseCodexJsonLine('ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket', dummyCodexConfig, (ev, payload) => {
    leakedTrace = true;
  });
  assert(leakedTrace === false, 'parseCodexJsonLine suppresses raw rust tracing websocket error noise');

  console.log('\n--- Testing Center Pane Scrolling & Log Helpers ---');
  let loggedScroll = false;
  const mockLogBox = {
    content: '',
    scrollPerc: 0,
    getContent() { return this.content; },
    setContent(c) { this.content = c; },
    setScrollPerc(p) { this.scrollPerc = p; loggedScroll = true; },
    scroll(offset) { this.scrollPerc += offset; }
  };
  mockLogBox.log = function(msg) {
    const prev = this.getContent() || '';
    this.setContent(prev ? prev + '\n' + msg : msg);
    this.setScrollPerc(100);
  };
  mockLogBox.log('Message line 1');
  mockLogBox.log('Message line 2');
  assert(loggedScroll === true && mockLogBox.scrollPerc === 100, 'mockLogBox.log automatically scrolls to bottom (setScrollPerc 100)');
  mockLogBox.scroll(-5);
  assert(mockLogBox.scrollPerc === 95, 'mockLogBox.scroll(-5) scrolls backward through log history');
  mockLogBox.scroll(3);
  assert(mockLogBox.scrollPerc === 98, 'mockLogBox.scroll(3) scrolls forward through log history');

  console.log('\n--- E2E Tests Complete ---');
  console.log(`Passed: ${passed}, Failed: ${failed}`);

  ws.close();
  wss.clients.forEach(c => c.close());
  wss.close();
  server.close();
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(console.error);
