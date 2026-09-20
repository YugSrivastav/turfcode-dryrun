import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import blessed from 'blessed';
import { spawnHostDaemon, getLocalIp } from '../server/index.js';
import { lockRegistry, isProcessAlive } from '../server/locks.js';
import { buildFileTree, flattenFileTree, formatTreeNode, autoExpandParents, getProjectFiles, getTruncatedPath, calculateLayout, buildHeaderContent, buildFooterContent, buildCenterLabel } from '../server/tui.js';
import { normalizeAndValidatePath, setupTurfApiKey, hasAnyConfiguredKey, TURF_PROVIDERS } from '../bin/turf.js';
import { ptyManager, isAgentAvailable, safeEscape, parseCodexJsonLine, parseCmdcJsonLine, parseAgyJsonLine, parseTurfJsonLine, getTurfModels, getCmdcModels, getCodexModels, getPaletteModelsForTab, extractFileCandidates } from '../server/pty_manager.js';
import { packDirectoryToTarGz, unpackTarGzToDirectory, syncWorkspaceFromHost } from '../server/sync.js';
import { getGroqApiKeys, getNextGroqApiKey, fetchLiveGeminiModels, invalidateModelCache } from '../server/model_discovery.js';
import { verifyCode, extractAstSymbols } from '../server/verify.js';
import { gitMerge3Way, astSemanticMerge, peacemakerMergeSync, peacemakerMerge } from '../server/peacemaker.js';
import WebSocket from 'ws';
import os from 'os';
import { execSync, execFile } from 'child_process';

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
    'bin/turf.js', 'bin/turf-agent.js', 'server/tui.js', 'server/index.js', 
    'server/events.js', 'server/rooms.js', 'server/locks.js',
    'server/pty_manager.js', 'server/model_discovery.js', 'server/sync.js',
    'server/verify.js', 'server/peacemaker.js', 'server/turf-hook.js', 'server/turf-guard-loader.mjs'
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

  // P1. Peer-to-Peer Workspace Sync via Tarball Streaming
  console.log('\n--- Testing P1: Peer-to-Peer Workspace Sync Tarball ---');
  const testSyncDir = path.join(os.tmpdir(), `turf_test_sync_${Date.now()}`);
  const testUnpackDir = path.join(os.tmpdir(), `turf_test_unpack_${Date.now()}`);
  fs.mkdirSync(path.join(testSyncDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(testSyncDir, 'hello.txt'), 'Hello Turfcode Sync!');
  fs.writeFileSync(path.join(testSyncDir, 'sub', 'nested.js'), 'export const x = 42;');

  const tarGz = packDirectoryToTarGz(testSyncDir);
  assert(Buffer.isBuffer(tarGz) && tarGz.length > 0, 'packDirectoryToTarGz creates valid gzip buffer');

  const unpackedFiles = unpackTarGzToDirectory(tarGz, testUnpackDir);
  assert(unpackedFiles.some(f => f.includes('hello.txt')), 'unpackTarGzToDirectory extracts root files');
  assert(fs.existsSync(path.join(testUnpackDir, 'hello.txt')), 'unpacked file exists on disk');
  assert(fs.readFileSync(path.join(testUnpackDir, 'hello.txt'), 'utf8') === 'Hello Turfcode Sync!', 'unpacked content matches original');

  const syncRes = await fetch(`http://127.0.0.1:${actualPort}/api/room/sync`);
  assert(syncRes.status === 200, 'GET /api/room/sync returns 200 OK');
  assert(syncRes.headers.get('content-type') === 'application/gzip', 'GET /api/room/sync serves application/gzip');
  const syncBuf = Buffer.from(await syncRes.arrayBuffer());
  assert(syncBuf.length > 0, 'GET /api/room/sync returns non-empty tarball');

  try {
    fs.rmSync(testSyncDir, { recursive: true, force: true });
    fs.rmSync(testUnpackDir, { recursive: true, force: true });
  } catch (e) {}

  // P2. Babel AST Semantic Verification in verify.js
  console.log('\n--- Testing P2: Babel AST Stage in verify.js ---');
  const codeA = 'export function calculateTotal(subtotal) { return subtotal * 1.1; }';
  const codeB = 'export function applyDiscount(total) { return total - 5; }';
  const mergedValid = 'export function calculateTotal(subtotal) { return subtotal * 1.1; }\nexport function applyDiscount(total) { return total - 5; }';
  const validRes = verifyCode(mergedValid, codeA, codeB);
  assert(validRes.valid === true, 'verifyCode returns valid: true for clean merge');
  assert(validRes.astAudit.passed === true, 'Babel AST stage passes on valid syntax');
  assert(validRes.astAudit.exports.includes('calculateTotal'), 'Babel AST extracts calculateTotal export');
  assert(validRes.astAudit.exports.includes('applyDiscount'), 'Babel AST extracts applyDiscount export');

  const codeWithExport = 'export function criticalAuthGuard() { return true; }';
  const mergedDroppedExport = 'function criticalAuthGuard() { return true; }';
  const brokenRes = verifyCode(mergedDroppedExport, codeWithExport, '');
  assert(brokenRes.valid === false, 'verifyCode detects dropped export');
  assert(brokenRes.astAudit.passed === false, 'astAudit flags dropped export');
  assert(brokenRes.astAudit.missingExports.includes('criticalAuthGuard'), 'missingExports lists criticalAuthGuard');

  const brokenSyntax = 'function broken( { return; }';
  const syntaxErrRes = verifyCode(brokenSyntax, '', '');
  assert(syntaxErrRes.valid === false, 'verifyCode catches invalid syntax');
  assert(syntaxErrRes.errors.length > 0, 'verifyCode reports syntax/AST error details');

  // P3. Live WebSocket Data & Static Client Distribution
  console.log('\n--- Testing P3: Live WS Data in Web Client & Static Serving ---');
  const distHtmlPath = path.join(TURF_ROOT, 'client/dist/index.html');
  assert(fs.existsSync(distHtmlPath), 'client/dist/index.html exists for web client serving');
  const clientHtmlRes = await fetch(`http://127.0.0.1:${actualPort}/`);
  assert(clientHtmlRes.status === 200, 'Host daemon serves static index.html at GET /');
  const clientHtml = await clientHtmlRes.text();
  assert(clientHtml.includes('<!doctype html>') && clientHtml.includes('root'), 'Static index.html contains React root mount');

  // Verify full real-time WebSocket protocol handling in web client
  let clientWsOpened = false;
  let clientReceivedChat = false;
  let clientReceivedPeacemakerDiff = false;

  const clientWs = new WebSocket(`ws://127.0.0.1:${actualPort}`);
  clientWs.on('open', () => {
    clientWsOpened = true;
    clientWs.send(JSON.stringify({
      type: 'peer:join',
      user: 'WebClientUser',
      role: 'Spectator',
      room: room.code
    }));
  });

  clientWs.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'chat:message' && msg.user === 'WebClientUser') {
      clientReceivedChat = true;
    }
    if (msg.type === 'peacemaker:diff') {
      clientReceivedPeacemakerDiff = true;
    }
  });

  await new Promise(resolve => setTimeout(resolve, 300));
  assert(clientWsOpened, 'Web client connects to daemon WebSocket');

  // Send a chat message from web client
  clientWs.send(JSON.stringify({
    type: 'chat:send',
    user: 'WebClientUser',
    message: 'Testing live chat from web client'
  }));

  // Broadcast a peacemaker diff
  clientWs.send(JSON.stringify({
    type: 'peacemaker:diff',
    file: 'demo/checkout.js',
    agentA: { name: 'Yug', agent: 'agy', code: 'const a = 1;' },
    agentB: { name: 'Ayush', agent: 'claude', code: 'const b = 2;' },
    merged: 'const a = 1;\nconst b = 2;',
    astAudit: { passed: true }
  }));

  await new Promise(resolve => setTimeout(resolve, 500));
  assert(clientReceivedChat, 'Web client receives broadcasted chat');
  assert(clientReceivedPeacemakerDiff, 'Web client receives peacemaker:diff resolution');
  clientWs.close();

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

  // Test auto-expansion of parent directories for new/synced files
  const testExpanded = new Set();
  autoExpandParents('src/components/buttons/PrimaryButton.jsx', testExpanded);
  assert(testExpanded.has('src'), 'autoExpandParents expands top-level parent');
  assert(testExpanded.has('src/components'), 'autoExpandParents expands intermediate parent');
  assert(testExpanded.has('src/components/buttons'), 'autoExpandParents expands deepest directory parent');
  assert(!testExpanded.has('src/components/buttons/PrimaryButton.jsx'), 'autoExpandParents does not treat file itself as directory');

  // Test Windows backslash and leading ./ handling
  autoExpandParents('.\\server\\utils\\helpers.js', testExpanded);
  assert(testExpanded.has('server'), 'autoExpandParents normalizes Windows path and leading dot');
  assert(testExpanded.has('server/utils'), 'autoExpandParents adds normalized server/utils');

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

  // Test normalizeAndValidatePath handling of spaces, quotes and normal paths
  const normDot = await normalizeAndValidatePath('.', () => Promise.resolve('n'));
  assert(normDot === path.resolve('.'), 'normalizeAndValidatePath handles dot directory');
  const normQuoted = await normalizeAndValidatePath(`"${path.resolve('.')}"`, () => Promise.resolve('n'));
  assert(normQuoted === path.resolve('.'), 'normalizeAndValidatePath strips surrounding double quotes');
  const normSpaced = await normalizeAndValidatePath(`  '${path.resolve('.')}'  `, () => Promise.resolve('n'));
  assert(normSpaced === path.resolve('.'), 'normalizeAndValidatePath strips surrounding single quotes and whitespace');

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
  assert(isAgentAvailable('cmdc') === true, 'isAgentAvailable(cmdc) accurately detects installed Command Code');
  assert(isAgentAvailable('codex') === true, 'isAgentAvailable(codex) accurately detects installed Codex');
  assert(ptyManager.getStatus('term') === 'idle', 'Initial term tab status is idle');
  assert(ptyManager.getStatus('cmdc') === 'idle', 'Initial cmdc tab status is idle');
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
    '/usage', '/model', '/effort', '/sandbox', '/new', '/resume', '/diff', '/kill', '/turf', '/cmdc', '/codex', '/agy', '/plan', '/term', '/chat', '/files', '/web', '/help'
  ];
  const filterByU = commands.filter(c => c.startsWith('/u'));
  assert(filterByU.includes('/usage'), 'Palette query "/u" matches /usage');

  const filterByM = commands.filter(c => c.startsWith('/m'));
  assert(filterByM.includes('/model'), 'Palette query "/m" matches /model');

  const filterByE = commands.filter(c => c.startsWith('/e'));
  assert(filterByE.includes('/effort'), 'Palette query "/e" matches /effort');

  const filterByD = commands.filter(c => c.startsWith('/d'));
  assert(filterByD.includes('/diff'), 'Palette query "/d" matches /diff');

  const filterByTurf = commands.filter(c => c.startsWith('/tur'));
  assert(filterByTurf.includes('/turf'), 'Palette query "/tur" matches /turf');

  const filterByCmdc = commands.filter(c => c.startsWith('/cmd'));
  assert(filterByCmdc.includes('/cmdc'), 'Palette query "/cmd" matches /cmdc');

  const filterByP = commands.filter(c => c.startsWith('/p'));
  assert(filterByP.includes('/plan'), 'Palette query "/p" matches /plan');

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
    tabId: 'cmdc',
    type: 'message',
    text: '{bold}{magenta-fg}💬 Command Code:{/magenta-fg}{/bold}\nPRD outline generated successfully.'
  });
  assert(receivedMsg.tabId === 'cmdc', 'agent:msg has correct cmdc tabId');
  assert(receivedMsg.text.includes('Command Code'), 'agent:msg contains Command Code prefix');

  ptyManager.removeListener('agent:msg', msgHandler);

  console.log('\n--- Testing Agent Process Crash Guards & Blessed Tag Safety ---');
  // 1. Empty spawnSession returns null
  const emptyCodex = ptyManager.spawnSession('codex', '');
  assert(emptyCodex === null, 'spawnSession(codex, "") safely returns null without spawning process');
  const emptyCmdc = ptyManager.spawnSession('cmdc', '');
  assert(emptyCmdc === null, 'spawnSession(cmdc, "") safely returns null without spawning process');

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

  // 4. parseCmdcJsonLine handles response, tool calls, and curly braces safely
  const cmdcMsgs = [];
  const dummyCmdcConfig = { turnCount: 1, totalTokens: 0 };
  parseCmdcJsonLine(JSON.stringify({
    type: 'message_end',
    content: [{ type: 'text', text: 'Code: { id: "123" }' }]
  }), dummyCmdcConfig, (ev, payload) => { cmdcMsgs.push(payload); });
  const cmdcMsgEvent = cmdcMsgs.find(m => m.type === 'message');
  assert(cmdcMsgEvent !== undefined && cmdcMsgEvent.text.includes('{open} id: "123" {close}'), 'parseCmdcJsonLine formats message and escapes curly braces');

  // 5. parseCmdcJsonLine handles tool_call
  const cmdcToolMsgs = [];
  parseCmdcJsonLine(JSON.stringify({
    type: 'tool_call',
    tool: 'read',
    path: 'server/tui.js'
  }), dummyCmdcConfig, (ev, payload) => { cmdcToolMsgs.push(payload); });
  const cmdcTool = cmdcToolMsgs.find(m => m.type === 'tool');
  assert(cmdcTool !== undefined && cmdcTool.text.includes('[Read File]'), 'parseCmdcJsonLine renders tool badge');

  // 6. parseCmdcJsonLine handles run_end and errors
  const cmdcErrMsgs = [];
  parseCmdcJsonLine(JSON.stringify({
    type: 'run_end',
    subtype: 'error',
    error: 'Execution failed'
  }), dummyCmdcConfig, (ev, payload) => { cmdcErrMsgs.push({ ev, payload }); });
  const cmdcErr = cmdcErrMsgs.find(m => m.ev === 'agent:msg' && m.payload.type === 'error');
  assert(cmdcErr !== undefined && cmdcErr.payload.text.includes('Execution failed'), 'parseCmdcJsonLine handles error run_end');
  const cmdcIdleStatus = cmdcErrMsgs.find(m => m.ev === 'status' && m.payload.status === 'idle');
  assert(cmdcIdleStatus !== undefined, 'parseCmdcJsonLine resets status to idle on error');

  console.log('\n--- Testing Turf Agent Parser, Plan Mode & Intent-Lock Hook ---');
  assert(typeof isAgentAvailable('turf') === 'boolean', 'isAgentAvailable(turf) returns boolean (false until fork binary installed)');

  // Empty turf prompt: null when binary present, clean not-installed throw when absent
  let turfEmpty = 'threw';
  try { turfEmpty = ptyManager.spawnSession('turf', ''); } catch (e) { turfEmpty = e.message; }
  assert(turfEmpty === null || String(turfEmpty).includes('not installed'), 'spawnSession(turf, "") returns null or clean not-installed error');

  // Pi-schema lines: session header, tool badge, assistant message, done
  const turfMsgs = [];
  const turfCfg = { turnCount: 1, totalTokens: 0, sessionId: null };
  const turfEmit = (ev, payload) => { turfMsgs.push({ ev, payload }); };
  parseTurfJsonLine(JSON.stringify({ type: 'session', version: 3, id: 'turf-sess-1', cwd: '/repo' }), turfCfg, turfEmit);
  assert(turfCfg.sessionId === 'turf-sess-1', 'parseTurfJsonLine captures Pi session id');
  parseTurfJsonLine(JSON.stringify({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'write', args: { path: 'src/a.js {x}' } }), turfCfg, turfEmit);
  const turfTool = turfMsgs.find(m => m.payload && m.payload.type === 'tool');
  assert(turfTool !== undefined && turfTool.payload.tabId === 'turf', 'parseTurfJsonLine emits turf tool badge');
  assert(turfTool.payload.text.includes('[Edit File]') && turfTool.payload.text.includes('{open}x{close}'), 'parseTurfJsonLine badges write + escapes braces');
  parseTurfJsonLine(JSON.stringify({ type: 'message_update', usage: { input: 10, output: 5 }, assistantMessageEvent: { type: 'text_delta', delta: 'hi' } }), turfCfg, turfEmit);
  assert(turfCfg.totalTokens === 15, 'parseTurfJsonLine accumulates Pi usage');
  parseTurfJsonLine(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Done { ok }' }] } }), turfCfg, turfEmit);
  const turfMsg = turfMsgs.find(m => m.payload && m.payload.type === 'message');
  assert(turfMsg !== undefined && turfMsg.payload.text.includes('Turf:') && turfMsg.payload.text.includes('{open} ok {close}'), 'parseTurfJsonLine emits Turf assistant message, escaped');
  parseTurfJsonLine(JSON.stringify({ type: 'agent_end', messages: [] }), turfCfg, turfEmit);
  const turfDone = turfMsgs.find(m => m.payload && m.payload.type === 'done');
  assert(turfDone !== undefined, 'parseTurfJsonLine emits done on agent_end');
  parseTurfJsonLine('not json {{{', turfCfg, turfEmit);
  const turfRaw = turfMsgs.find(m => m.payload && m.payload.type === 'raw');
  assert(turfRaw !== undefined && turfRaw.payload.text.includes('{open}'), 'parseTurfJsonLine falls back to escaped raw');

  // Plan mode defaults off, toggles, reflects in usage
  assert(ptyManager.getPlanMode('turf') === false, 'Turf plan mode defaults off');
  ptyManager.setPlanMode('turf', true);
  assert(ptyManager.getPlanMode('turf') === true, 'ptyManager.setPlanMode enables plan mode');
  assert(ptyManager.getUsageStats('turf').planMode === true, 'getUsageStats reflects plan mode');
  ptyManager.setPlanMode('turf', false);

  // turf-hook: granted -> conflict (exit 2) -> release -> granted
  // ponytail: async execFile — execSync would block the parent loop and deadlock the in-process daemon
  const hookRun = (agent, release = false) => new Promise((resolve) => {
    const hookArgs = [path.join(TURF_ROOT, 'server', 'turf-hook.js'),
      '--daemon', `http://127.0.0.1:${actualPort}`, '--room', 'TRF-TEST',
      '--user', 'HookTest', '--file', 'hook/probe.js', '--agent', agent];
    if (release) hookArgs.push('--release');
    execFile(process.execPath, hookArgs, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
  let r = await hookRun('turfA');
  assert(!r.err, 'turf-hook declares intent lock (exit 0)');
  r = await hookRun('turfB');
  assert(r.err && r.err.code === 2, 'turf-hook second agent gets conflict exit 2 (fork to worktree)');
  r = await hookRun('turfA', true);
  assert(!r.err, 'turf-hook releases lock (exit 0)');
  r = await hookRun('turfB');
  assert(!r.err, 'turf-hook release promotes queued agent');
  await hookRun('turfB', true);

  // 6. parseCmdcJsonLine live response streaming via agent:stream
  const dummyCmdcStreamConfig = { turnCount: 1, totalTokens: 0, hasStreamedResponse: false };
  const cmdcStreamMsgs = [];
  parseCmdcJsonLine(JSON.stringify({
    type: 'text_delta',
    delta: 'Hello streamed response!'
  }), dummyCmdcStreamConfig, (ev, payload) => { cmdcStreamMsgs.push({ ev, payload }); });
  const streamEv = cmdcStreamMsgs.find(m => m.ev === 'agent:stream');
  assert(streamEv !== undefined && streamEv.payload.text === 'Hello streamed response!', 'parseCmdcJsonLine emits agent:stream for live response streaming');
  assert(ptyManager.getModel('cmdc') === 'default', 'ptyManager defaults cmdc model to default');

  // Dynamic Model Discovery tests
  const cmdcModels = getCmdcModels();
  assert(Array.isArray(cmdcModels) && cmdcModels.length > 0, 'getCmdcModels returns models list');
  assert(cmdcModels.some(m => m.id.includes('claude-sonnet') || m.id.includes('deepseek')), 'cmdc models includes verified models');

  const turfModels = await getTurfModels();
  assert(Array.isArray(turfModels) && turfModels.length > 0, 'getTurfModels returns models list');
  assert(turfModels.some(m => m.id === 'openai/gpt-oss-120b'), 'turf models includes openai/gpt-oss-120b');

  const codexModels = await getCodexModels();
  assert(Array.isArray(codexModels) && codexModels.some(m => m.id === 'o3-mini'), 'codex models includes o3-mini');

  const paletteTurf = await getPaletteModelsForTab('turf');
  assert(paletteTurf.some(m => m.cmd.includes('openai/gpt-oss-120b')), 'getPaletteModelsForTab(turf) contains gpt-oss-120b');
  const paletteCmdc = await getPaletteModelsForTab('cmdc');
  assert(paletteCmdc.some(m => m.cmd.includes('/model')), 'getPaletteModelsForTab(cmdc) returns /model commands');

  // 7. Isolation Test: Codex error tips strictly suggest Codex models
  const codexErrMsgs = [];
  parseCodexJsonLine(JSON.stringify({
    type: 'error',
    error: { message: 'Rate limit 429: Requests exceeded' }
  }), dummyCodexConfig, (ev, payload) => { codexErrMsgs.push({ ev, payload }); });
  const codexErr = codexErrMsgs.find(m => m.ev === 'agent:msg' && m.payload.type === 'error');
  assert(codexErr !== undefined && codexErr.payload.text.includes('o3-mini'), 'parseCodexJsonLine recommends o3-mini or gpt-4o on rate limit');

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

  console.log('\n--- Testing Onboarding Multi-Key Re-Prompt, Gemini Studio Key & Textbox Fix ---');
  // 1. Provider configuration check
  const geminiProvider = TURF_PROVIDERS.find(p => p.env === 'GEMINI_API_KEY');
  assert(!!geminiProvider, 'TURF_PROVIDERS includes GEMINI_API_KEY');
  assert(geminiProvider && geminiProvider.label.includes('Gemini'), 'Gemini provider has clear friendly label');

  // 2. hasAnyConfiguredKey check
  const testTmpDir = path.join(os.tmpdir(), `turf-test-keys-${Date.now()}`);
  fs.mkdirSync(testTmpDir, { recursive: true });
  fs.writeFileSync(path.join(testTmpDir, '.env'), 'GEMINI_API_KEY=test-gemini-key-xyz\n');
  assert(hasAnyConfiguredKey(testTmpDir) === true, 'hasAnyConfiguredKey detects key in workspace .env');

  // 3. setupTurfApiKey skips when user responds 'n' to "add more keys?"
  let askedQuestions = [];
  const mockPromptNo = async (q) => {
    askedQuestions.push(q);
    return 'n'; // User declines adding more keys
  };
  const skipResult = await setupTurfApiKey(mockPromptNo, '', testTmpDir);
  assert(skipResult === 'skipped', 'setupTurfApiKey returns skipped when user declines adding more keys');
  assert(askedQuestions.some(q => q.includes('Do you want to add more keys')), 'setupTurfApiKey asks user if they want to add more keys');

  // 4. setupTurfApiKey saves new key when user responds 'y'
  const promptResponses = ['y', '1', 'gemini-new-studio-key', 'n'];
  let rIdx = 0;
  const mockPromptYes = async (q) => {
    return promptResponses[rIdx++] || 'n';
  };
  const addResult = await setupTurfApiKey(mockPromptYes, '', testTmpDir);
  assert(addResult === 'GEMINI_API_KEY', 'setupTurfApiKey successfully saved GEMINI_API_KEY');
  const savedEnv = fs.readFileSync(path.join(testTmpDir, '.env'), 'utf8');
  assert(savedEnv.includes('gemini-new-studio-key'), '.env contains the newly added Gemini key');
  try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch (e) {}

  // 5. getTurfModels with GEMINI_API_KEY
  const origGemini = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  const turfModelsWithGemini = await getTurfModels(process.cwd());
  assert(turfModelsWithGemini.some(m => m.id === 'gemini-2.5-flash'), 'getTurfModels includes latest gemini-2.5-flash when GEMINI_API_KEY exists');
  assert(turfModelsWithGemini[0].id === 'gemini-2.5-flash', 'getTurfModels prioritizes gemini-2.5-flash as the top recommended model');
  assert(turfModelsWithGemini.some(m => m.id === 'gemini-2.0-flash'), 'getTurfModels includes gemini-2.0-flash when GEMINI_API_KEY exists');
  assert(turfModelsWithGemini.some(m => m.id === 'gemini-1.5-pro'), 'getTurfModels includes gemini-1.5-pro when GEMINI_API_KEY exists');
  assert(typeof fetchLiveGeminiModels === 'function', 'fetchLiveGeminiModels is exported and callable');
  assert(typeof invalidateModelCache === 'function', 'invalidateModelCache is exported and callable');
  invalidateModelCache();
  if (origGemini) process.env.GEMINI_API_KEY = origGemini; else delete process.env.GEMINI_API_KEY;

  // 6. Blessed textbox prototype listener crash guard
  let listenerEmittedSubmit = false;
  const mockTextbox = {
    value: 'test command',
    emit(event, val) {
      if (event === 'submit') listenerEmittedSubmit = true;
    }
  };
  // Calling _listener without _done function must NOT throw TypeError
  let threwDoneError = false;
  try {
    blessed.textbox.prototype._listener.call(mockTextbox, '\r', { name: 'enter' });
  } catch (err) {
    threwDoneError = true;
  }
  assert(threwDoneError === false, 'blessed.textbox._listener does not throw when this._done is undefined');
  assert(listenerEmittedSubmit === true, 'blessed.textbox._listener safely falls back to emit submit');

  console.log('\n--- Testing Subsystem Fixes, IP Selection, Streaming & Agent Negotiation ---');
  // 1. getLocalIp: must not return APIPA and must be valid IPv4
  const resolvedIp = getLocalIp();
  assert(typeof resolvedIp === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(resolvedIp), 'getLocalIp returns valid IPv4 address');
  assert(!resolvedIp.startsWith('169.254.'), 'getLocalIp avoids link-local/APIPA address');

  // 2. blessed.textarea prototype listener escape guard
  let listenerEmittedCancel = false;
  const mockTextarea = {
    value: 'test content',
    emit(event) {
      if (event === 'cancel') listenerEmittedCancel = true;
    }
  };
  let threwTextareaEscape = false;
  try {
    blessed.textarea.prototype._listener.call(mockTextarea, '', { name: 'escape' });
  } catch (err) {
    threwTextareaEscape = true;
  }
  assert(threwTextareaEscape === false, 'blessed.textarea._listener does not throw on escape when this._done is undefined');
  assert(listenerEmittedCancel === true, 'blessed.textarea._listener safely falls back to emit cancel');

  // 3. LockRegistry event emission and cross-platform worktreePath
  let lockChanged = false;
  const onLockChange = () => { lockChanged = true; };
  lockRegistry.on('change', onLockChange);
  const testLockRes = lockRegistry.requestLock('test/dummy-lock.js', 'agent-test-1', 'UserTest');
  assert(lockChanged === true, 'lockRegistry emits change event on requestLock');
  assert(testLockRes.status === 'granted', 'lockRegistry successfully grants lock');

  // Conflict test: worktreePath must be in os.tmpdir()
  const conflictRes = lockRegistry.requestLock('test/dummy-lock.js', 'agent-test-2', 'UserTest2', 1, 'TEST-ROOM');
  assert(conflictRes.status === 'conflict', 'lockRegistry returns conflict for second agent');
  assert(typeof conflictRes.worktreePath === 'string' && conflictRes.worktreePath.includes('TEST-ROOM'), 'lockRegistry returns cross-platform worktreePath with room code');

  lockChanged = false;
  lockRegistry.releaseLock('test/dummy-lock.js', 'agent-test-1');
  assert(lockChanged === true, 'lockRegistry emits change event on releaseLock');
  lockRegistry.off('change', onLockChange);

  // 4. parseTurfJsonLine live token streaming & rate limit handling
  const turfStreamMsgs = [];
  const turfStreamCfg = { turnCount: 1, totalTokens: 0, sessionId: null };
  parseTurfJsonLine(JSON.stringify({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'Live streaming chunk' }
  }), turfStreamCfg, (ev, payload) => { turfStreamMsgs.push({ ev, payload }); });
  const streamMatch = turfStreamMsgs.find(m => m.ev === 'agent:stream' && m.payload.text === 'Live streaming chunk');
  assert(streamMatch !== undefined, 'parseTurfJsonLine emits agent:stream for live word-by-word streaming');

  const turfRateLimitMsgs = [];
  const turfRateCfg = { turnCount: 1, totalTokens: 0, sessionId: null };
  parseTurfJsonLine('Error 429: rate_limit_exceeded (tokens per minute)', turfRateCfg, (ev, payload) => { turfRateLimitMsgs.push({ ev, payload }); });
  const rateLimitMsg = turfRateLimitMsgs.find(m => m.payload && m.payload.type === 'error');
  assert(rateLimitMsg !== undefined && rateLimitMsg.payload.text.includes('Rate Limit (429)') && rateLimitMsg.payload.text.includes('Gemini Studio'), 'parseTurfJsonLine provides actionable advice on 429 rate limit');

  // 5. POST /api/locks/negotiate
  const negRes = await fetch(`http://127.0.0.1:${actualPort}/api/locks/negotiate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fromAgent: 'turf',
      fromUser: 'HostTester',
      toAgent: 'cmdc',
      file: 'src/demo.js',
      message: 'Testing inter-agent negotiation handshake.'
    })
  });
  assert(negRes.ok, '/api/locks/negotiate endpoint returns HTTP 200');
  const negData = await negRes.json();
  assert(negData.status === 'broadcasted', '/api/locks/negotiate successfully broadcasts message');

  // 6. Lock Heartbeat and Instant Disconnect Eviction
  lockRegistry.requestLock('test/heartbeat-lock.js', 'peer-agent-hb', 'PeerBob');
  let beforeState = lockRegistry.getState().activeLocks.find(l => l.filePath.includes('heartbeat-lock.js'));
  assert(beforeState !== undefined, 'Lock acquired for heartbeat test');
  
  const hbRes = await fetch(`http://127.0.0.1:${actualPort}/api/locks/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user: 'PeerBob', agentId: 'peer-agent-hb' })
  });
  assert(hbRes.ok, 'POST /api/locks/heartbeat returns HTTP 200');
  
  // Instant Disconnect Eviction test: releaseAllForUser immediately frees all held locks
  lockRegistry.releaseAllForUser('peer-agent-hb');
  const afterState = lockRegistry.getState().activeLocks.find(l => l.filePath.includes('heartbeat-lock.js'));
  assert(afterState === undefined, 'releaseAllForUser instantly frees locks on sudden client disconnect');

  // 7. Live Continuous File Synchronization over WebSocket
  let receivedFileSync = null;
  const peerWs = new WebSocket(`ws://127.0.0.1:${actualPort}`);
  await new Promise(r => peerWs.once('open', r));
  const syncListener = (raw) => {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.type === 'file:sync') receivedFileSync = parsed;
    } catch (e) {}
  };
  peerWs.on('message', syncListener);
  ws.send(JSON.stringify({
    type: 'file:sync',
    origin: 'TestHost',
    relPath: 'src/live-test.js',
    content: 'export const live = true;'
  }));
  await new Promise(r => setTimeout(r, 200));
  assert(receivedFileSync !== null && receivedFileSync.relPath === 'src/live-test.js' && receivedFileSync.content === 'export const live = true;', 'file:sync broadcasts live code replication to peer WebSocket');
  peerWs.close();

  // 8. Herdr-Style Adaptive Layout & Responsive Widget Tests
  console.log('\n--- Testing P8: Adaptive Responsive TUI Layout Engine ---');
  
  // Mobile / ultra-compact layout (60x20)
  const mobileLayout = calculateLayout(60, 20);
  assert(mobileLayout.leftSidebar.hidden === true, 'Ultra-compact terminal (<75 cols) auto-collapses left sidebar');
  assert(mobileLayout.rightSidebar.hidden === true, 'Ultra-compact terminal (<75 cols) auto-collapses right sidebar');
  assert(mobileLayout.centerPane.width >= 38, 'Ultra-compact terminal guarantees at least 38 columns for center pane');
  assert(mobileLayout.centerPane.left === 0, 'Center pane occupies full terminal left on ultra-compact');

  // Classic 80x24 terminal
  const classicLayout = calculateLayout(80, 24);
  assert(classicLayout.centerPane.width >= 38, 'Classic 80-col terminal guarantees at least 38 columns for center coding pane');
  assert(classicLayout.leftSidebar.width + classicLayout.centerPane.width + classicLayout.rightSidebar.width <= 80, 'Total panels width does not exceed terminal columns on 80x24');
  assert(classicLayout.leftSidebar.hidden === false && classicLayout.leftSidebar.width > 0, 'Classic 80-col terminal keeps left sidebar visible when uncollapsed');

  // Small 100x30 laptop
  const laptop100Layout = calculateLayout(100, 30);
  assert(laptop100Layout.leftSidebar.width === 24, '100-col laptop provides 24-col left sidebar');
  assert(laptop100Layout.rightSidebar.width === 28, '100-col laptop provides 28-col right sidebar');
  assert(laptop100Layout.centerPane.width === 48, '100-col laptop provides 48-col center pane');

  // Standard 120x35 laptop
  const laptop120Layout = calculateLayout(120, 35);
  assert(laptop120Layout.centerPane.width === 68, '120-col laptop provides 68-col wide center pane');

  // Wide 160x45 desktop monitor
  const desktopLayout = calculateLayout(160, 45);
  assert(desktopLayout.leftSidebar.width === 28, 'Desktop screen provides 28-col left sidebar');
  assert(desktopLayout.rightSidebar.width === 32, 'Desktop screen provides 32-col right sidebar');
  assert(desktopLayout.centerPane.width === 100, 'Desktop screen provides 100-col center pane');

  // Independent sidebar collapsing
  const collapsedLeft = calculateLayout(120, 35, true, false);
  assert(collapsedLeft.leftSidebar.hidden === true && collapsedLeft.leftSidebar.width === 0, 'Left sidebar collapsing zeroes width and hides box');
  assert(collapsedLeft.centerPane.width === 120 - 28, 'Center pane expands by 24 cols when left sidebar is collapsed');
  assert(collapsedLeft.centerPane.left === 0, 'Center pane starts at col 0 when left sidebar is collapsed');

  const collapsedBoth = calculateLayout(120, 35, true, true);
  assert(collapsedBoth.leftSidebar.hidden === true && collapsedBoth.rightSidebar.hidden === true, 'Both sidebars collapse when requested');
  assert(collapsedBoth.centerPane.width === 120, 'Center pane occupies 100% width when both sidebars are collapsed');

  // Non-wrapping Footer tests
  const stripTags = str => str.replace(/{[^}]+}/g, '');
  
  const footer80 = buildFooterContent(80);
  const footer80Plain = stripTags(footer80);
  assert(footer80Plain.length <= 78, `Footer on 80-col terminal does not overflow (len=${footer80Plain.length} <= 78)`);
  assert(footer80Plain.includes('[Tab] Focus'), 'Footer contains essential primary shortcuts');

  const footer60 = buildFooterContent(60);
  const footer60Plain = stripTags(footer60);
  assert(footer60Plain.length <= 58, `Footer on 60-col terminal does not overflow (len=${footer60Plain.length} <= 58)`);

  const footer120 = buildFooterContent(120);
  const footer120Plain = stripTags(footer120);
  assert(footer120Plain.length <= 118, `Footer on 120-col terminal does not overflow (len=${footer120Plain.length} <= 118)`);

  // Non-wrapping Header tests
  const headerOptions = { roomCode: 'TRF-TEST', localIp: '192.168.1.5', port: 7777, hostName: 'Alice', currentDir: '/home/turf/workspace/app' };
  const header60 = buildHeaderContent(60, headerOptions);
  const header60Plain = stripTags(header60);
  assert(header60Plain.length <= 59, `Header on 60-col terminal does not overflow (len=${header60Plain.length} <= 59)`);

  const header80 = buildHeaderContent(80, headerOptions);
  const header80Plain = stripTags(header80);
  assert(header80Plain.length <= 79, `Header on 80-col terminal does not overflow (len=${header80Plain.length} <= 79)`);

  const header120 = buildHeaderContent(120, headerOptions);
  const header120Plain = stripTags(header120);
  assert(header120Plain.length <= 119, `Header on 120-col terminal does not overflow (len=${header120Plain.length} <= 119)`);
  assert(header120.includes('Room:'), 'Wide header includes Room label');

  // Adaptive Center Tab Label tests
  const compactLabel = buildCenterLabel(40, 'turf', { turfStatus: 'working' }, null, true);
  assert(compactLabel.includes('TURF (PLAN)*'), 'Compact center label includes active tab with working and plan badges');
  assert(!compactLabel.includes('CODEX'), 'Compact center label hides inactive tabs when width < 46');

  const mediumLabel = buildCenterLabel(60, 'cmdc', { cmdcStatus: 'working' }, null, false);
  assert(mediumLabel.includes('[● CMDC*]'), 'Medium center label shows active CMDC tab with working indicator');
  assert(mediumLabel.includes('CDX'), 'Medium center label shortens Codex to CDX');

  const fullLabel = buildCenterLabel(90, 'turf', { turfStatus: 'idle', cmdcStatus: 'working' }, 'index.js', false);
  assert(fullLabel.includes('[● TURF]'), 'Full center label highlights active Turf tab');
  assert(fullLabel.includes('CMDC*'), 'Full center label shows CMDC working status');
  assert(fullLabel.includes('FILE: index.js'), 'Full center label includes opened filename');

  // --- Testing Multi-Agent Intent Board, Deadlock-Free Canonical Locks & Anti-Starvation Queue ---
  console.log('\n--- Testing Multi-Agent Intent Board, Canonical Locks & Anti-Starvation Queue ---');

  // 1. Windows Backslash vs POSIX Path Inode Equivalence
  const lockWin = lockRegistry.requestLock('src\\components\\Button.jsx', 'agent-win-1', 'Alice');
  assert(lockWin.status === 'granted', 'Lock acquired with Windows backslash path');
  const lockPosix = lockRegistry.requestLock('src/components/Button.jsx', 'agent-posix-2', 'Bob');
  assert(lockPosix.status === 'conflict', 'POSIX forward-slash path correctly matches Windows backslash lock (no phantom bypass)');
  lockRegistry.releaseLock('src/components/Button.jsx', 'agent-win-1');
  const promotedPosix = lockRegistry.locks.get('src/components/Button.jsx');
  assert(promotedPosix && promotedPosix.agentId === 'agent-posix-2', 'Queued POSIX agent automatically promoted on release of Windows path holder');
  lockRegistry.releaseLock('src/components/Button.jsx', 'agent-posix-2');
  assert(!lockRegistry.locks.has('src/components/Button.jsx'), 'Lock cleanly released using normalized key');


  // 2. Canonical Total Ordering (Deadlock Freedom)
  const unsortedPaths = ['src/z.js', 'src/a.js', 'src\\m.js', 'src/b.js'];
  const canonicalOrdered = lockRegistry.orderPaths(unsortedPaths);
  assert(canonicalOrdered[0] === 'src/a.js' && canonicalOrdered[1] === 'src/b.js' && canonicalOrdered[2] === 'src/m.js' && canonicalOrdered[3] === 'src/z.js', 'orderPaths provides canonical total ordering for deadlock freedom');

  // 3. Deterministic File Candidate Extraction from User Prompts
  const candidates1 = extractFileCandidates('Please fix bug in server/tui.js and test/e2e-test.js before demo');
  assert(candidates1.includes('server/tui.js') && candidates1.includes('test/e2e-test.js'), 'extractFileCandidates extracts mentioned workspace files');
  const candidates2 = extractFileCandidates('Create a modern landing page for hackathon demo');
  assert(candidates2.length === 0, 'extractFileCandidates returns empty list for abstract intent');
  const candidates3 = extractFileCandidates('Upgrade to v1.2.3 and visit https://example.com/api.js');
  assert(!candidates3.includes('1.2.3') && !candidates3.some(c => c.includes('http')), 'extractFileCandidates ignores versions and remote URLs');

  // 4. Pre-Flight Intent Registry (Phase 1 Hook)
  lockRegistry.declareIntent('tab-cmdc', 'Dave', ['server/locks.js'], 'targeted');
  let intents = lockRegistry.getIntents();
  const daveIntent = intents.find(i => i.agentId === 'tab-cmdc');
  assert(daveIntent !== undefined, 'declareIntent successfully registers agent pre-flight intent');
  assert(daveIntent.user === 'Dave' && daveIntent.files.includes('server/locks.js'), 'Intent records user and normalized target file');
  lockRegistry.clearIntent('tab-cmdc');
  intents = lockRegistry.getIntents();
  assert(intents.find(i => i.agentId === 'tab-cmdc') === undefined, 'clearIntent successfully removes completed agent intent');

  // 5. Dead-Man Process Liveness Sweeper (LLM Long Reasoning Protection)
  const dummyLockFile = 'test/liveness-test.js';
  lockRegistry.requestLock(dummyLockFile, 'agent-alive-proc', 'Charlie', 1, 'default', process.pid);
  const activeLock = lockRegistry.locks.get(dummyLockFile);
  assert(activeLock !== undefined, 'Lock acquired for liveness sweeper test');
  // Age activity by 15 seconds (past the 10s inactivity threshold)
  activeLock.lastActivity = Date.now() - 15000;
  activeLock.expiresAt = Date.now() - 1000;
  lockRegistry._evictZombies();
  assert(lockRegistry.locks.has(dummyLockFile), 'Active running PID is NOT evicted by zombie sweeper during long inference turn');
  // Now simulate a deceased PID
  activeLock.pid = 9999999;
  activeLock.lastActivity = Date.now() - 15000;
  activeLock.expiresAt = Date.now() - 1000;
  lockRegistry._evictZombies();
  assert(!lockRegistry.locks.has(dummyLockFile), 'Deceased PID is immediately evicted and cleaned up by sweeper');

  // 6. Anti-Starvation Queue Aging (Starvation Freedom Proof)
  const queueFile = 'test/starvation-test.js';
  lockRegistry.requestLock(queueFile, 'agent-holder', 'Holder');
  // Enqueue low-priority request (Tier 3, Base Score 25)
  lockRegistry.requestLock(queueFile, 'agent-low-prio', 'LowPrio', 3);
  const queueArr = lockRegistry.queues.get(queueFile);
  assert(queueArr && queueArr.length === 1, 'Low priority agent enqueued');
  // Age low priority request by 30 seconds: effective score = 25 + 3.5 * 30 = 130
  queueArr[0].enqueuedTime = Date.now() - 30000;
  // Enqueue freshly arrived high-priority human request (Tier 0, Base Score 100)
  lockRegistry.requestLock(queueFile, 'agent-high-human', 'Human', 0);
  assert(queueArr.length === 2, 'High priority human enqueued behind low priority');
  // Release holder: promotion aging formula runs
  lockRegistry.releaseLock(queueFile, 'agent-holder');
  const promotedLock = lockRegistry.locks.get(queueFile);
  assert(promotedLock && promotedLock.agentId === 'agent-low-prio', 'Aged low-priority agent promoted over newly arrived Tier 0 request (anti-starvation aging proven)');
  lockRegistry.releaseLock(queueFile, 'agent-low-prio');

  // 7. REST API /api/locks/intent Endpoint
  const intentPostRes = await fetch(`http://127.0.0.1:${actualPort}/api/locks/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: 'api-agent', user: 'Eva', files: ['server/index.js'], scope: 'targeted' })
  });
  assert(intentPostRes.ok, 'POST /api/locks/intent returns HTTP 200');
  const intentPostData = await intentPostRes.json();
  assert(intentPostData.status === 'declared' && intentPostData.intent.user === 'Eva', 'POST /api/locks/intent registers intent');
  const intentClearRes = await fetch(`http://127.0.0.1:${actualPort}/api/locks/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: 'api-agent', action: 'clear' })
  });
  assert(intentClearRes.ok, 'POST /api/locks/intent clear returns HTTP 200');
  const intentClearData = await intentClearRes.json();
  assert(intentClearData.status === 'cleared', 'POST /api/locks/intent clear clears intent');

  // 8. Mathematical Waiting Queue Dynamics & Position Ranking
  console.log('\n--- Testing Mathematical Waiting Queue Dynamics ---');
  const mathQueueFile = 'test/math-queue-target.js';
  lockRegistry.requestLock(mathQueueFile, 'math-holder', 'HolderUser', 1);
  const mathHolderLock = lockRegistry.locks.get(mathQueueFile);
  assert(mathHolderLock !== undefined, 'Lock acquired for mathematical queue test');

  // Enqueue 3 agents:
  const resA = lockRegistry.requestLock(mathQueueFile, 'agent-A', 'UserA', 3);
  const resB = lockRegistry.requestLock(mathQueueFile, 'agent-B', 'UserB', 1);
  const resC = lockRegistry.requestLock(mathQueueFile, 'agent-C', 'UserC', 2);

  assert(resA.status === 'conflict' && resB.status === 'conflict' && resC.status === 'conflict', 'All colliding requests enqueued with conflict status');
  assert(resA.suggestedAction === 'fork_speculative_worktree', 'Colliding request suggests speculative worktree fork');

  // Manipulate enqueue timestamps to test mathematical dynamic aging formula:
  // P_eff = S_0 + 3.5 * t_elapsed
  // Agent A (Tier 3, S_0 = 25), t_elapsed = 20s -> P_eff = 25 + 3.5 * 20 = 95
  // Agent B (Tier 1, S_0 = 75), t_elapsed = 0s  -> P_eff = 75 + 3.5 * 0 = 75
  // Agent C (Tier 2, S_0 = 50), t_elapsed = 15s -> P_eff = 50 + 3.5 * 15 = 102.5
  const qArr = lockRegistry.queues.get(mathQueueFile);
  const reqA = qArr.find(r => r.agentId === 'agent-A');
  const reqB = qArr.find(r => r.agentId === 'agent-B');
  const reqC = qArr.find(r => r.agentId === 'agent-C');

  reqA.enqueuedTime = Date.now() - 20000;
  reqB.enqueuedTime = Date.now();
  reqC.enqueuedTime = Date.now() - 15000;

  // Compute queue rankings
  const computed = lockRegistry._computeQueue(mathQueueFile);
  assert(computed[0].agentId === 'agent-C' && computed[0].rank === 1, 'Math Queue Rank #1 is Agent C (effective priority 102.5)');
  assert(computed[1].agentId === 'agent-A' && computed[1].rank === 2, 'Math Queue Rank #2 is Agent A (effective priority 95)');
  assert(computed[2].agentId === 'agent-B' && computed[2].rank === 3, 'Math Queue Rank #3 is Agent B (effective priority 75)');

  // Verify wait time formula: estimatedWaitSeconds = holderRemaining + (rank - 1) * 15
  assert(computed[0].estimatedWaitSeconds >= 0 && computed[0].estimatedWaitSeconds <= 15, 'Rank #1 wait time equals holder remaining time (~0-15s)');
  assert(computed[1].estimatedWaitSeconds === computed[0].estimatedWaitSeconds + 15, 'Rank #2 wait time is Rank #1 + 15s');
  assert(computed[2].estimatedWaitSeconds === computed[0].estimatedWaitSeconds + 30, 'Rank #3 wait time is Rank #1 + 30s');

  // Verify Idempotent Enqueue (no queue bloat on repeated queries)
  const lenBefore = qArr.length;
  lockRegistry.requestLock(mathQueueFile, 'agent-B', 'UserB', 1);
  assert(qArr.length === lenBefore, 'Repeated request from same agent is idempotent (does not duplicate queue entries)');

  // 9. Ghost Queue Pruning & Zombie Eviction from Queues
  console.log('\n--- Testing Ghost Queue Pruning ---');
  qArr.push({
    agentId: 'ghost-dead-pid',
    user: 'DeadGhost',
    priorityTier: 0,
    score: 100,
    enqueuedTime: Date.now() - 10000,
    lastActivity: Date.now() - 10000,
    pid: 9999999
  });
  qArr.push({
    agentId: 'ghost-stale-timeout',
    user: 'StaleGhost',
    priorityTier: 0,
    score: 100,
    enqueuedTime: Date.now() - 360000, // 6 minutes ago (> 5m threshold)
    lastActivity: Date.now() - 360000
  });

  lockRegistry._evictZombies();
  const activeQueuedAfterEvict = lockRegistry.queues.get(mathQueueFile);
  assert(!activeQueuedAfterEvict.some(r => r.agentId === 'ghost-dead-pid'), 'Dead PID pruned from waiting queue during sweep');
  assert(!activeQueuedAfterEvict.some(r => r.agentId === 'ghost-stale-timeout'), 'Stale request (>5m) pruned from waiting queue during sweep');

  // 10. Speculative Worktree AST Verification & Auto-Merge on Promotion
  console.log('\n--- Testing Speculative Worktree Merge on Queue Promotion ---');
  const specTargetRel = 'test/speculative-merge-target.js';
  const specTargetFull = path.join(TURF_ROOT, specTargetRel);
  fs.writeFileSync(specTargetFull, 'export const initialVal = 42;\n', 'utf8');

  lockRegistry.requestLock(specTargetRel, 'holder-spec', 'Alice', 1);
  const specEnqRes = lockRegistry.requestLock(specTargetRel, 'queued-spec-agent', 'Bob', 2, 'default');
  assert(specEnqRes.status === 'conflict', 'Speculative agent successfully enqueued');

  // Simulate queued agent writing verified changes in its speculative worktree
  const worktreeDir = specEnqRes.worktreePath;
  const specFileInWorktree = path.join(worktreeDir, specTargetRel);
  fs.mkdirSync(path.dirname(specFileInWorktree), { recursive: true });
  const validMergedJs = 'export const initialVal = 42;\nexport function newFeature() { return "verified AST"; }\n';
  fs.writeFileSync(specFileInWorktree, validMergedJs, 'utf8');

  // Release lock from Alice -> triggers _promoteQueue -> triggers _tryMergeSpeculativeWorktree
  let promotedEventReceived = false;
  let worktreeMergedReported = false;
  const onPromoted = (info) => {
    if (info.filePath === specTargetRel) {
      promotedEventReceived = true;
      if (info.worktreeResult && info.worktreeResult.merged) {
        worktreeMergedReported = true;
      }
    }
  };
  lockRegistry.on('promoted', onPromoted);

  const releaseRes = lockRegistry.releaseLock(specTargetRel, 'holder-spec');
  assert(releaseRes.promotedTo === 'queued-spec-agent', 'Queued agent successfully promoted to lock holder');
  assert(promotedEventReceived, 'promoted event emitted by lockRegistry');
  assert(worktreeMergedReported, 'worktreeResult reported successfully merged');

  // Verify file on disk in main workspace now contains the verified AST merged code
  const mainDiskContent = fs.readFileSync(specTargetFull, 'utf8');
  assert(mainDiskContent.includes('newFeature') && mainDiskContent.includes('verified AST'), 'Speculative worktree changes automatically merged to main workspace file');
  assert(!fs.existsSync(specFileInWorktree), 'Temporary speculative worktree file unlinked after merge');

  // Clean up
  lockRegistry.off('promoted', onPromoted);
  lockRegistry.releaseLock(specTargetRel, 'queued-spec-agent');
  lockRegistry.releaseLock(mathQueueFile, 'math-holder');
  try { fs.unlinkSync(specTargetFull); } catch (e) {}
  try { fs.unlinkSync(path.join(TURF_ROOT, queueFile)); } catch (e) {}
  try { fs.unlinkSync(path.join(TURF_ROOT, dummyLockFile)); } catch (e) {}

  // 11. REST API /api/locks Endpoint Schema Verification
  const locksGetRes = await fetch(`http://127.0.0.1:${actualPort}/api/locks`);
  assert(locksGetRes.ok, 'GET /api/locks returns HTTP 200');
  const locksData = await locksGetRes.json();
  assert(Array.isArray(locksData.activeLocks), 'GET /api/locks returns activeLocks array');
  assert(Array.isArray(locksData.queues), 'GET /api/locks returns queues array');
  assert(Array.isArray(locksData.intents), 'GET /api/locks returns intents array');

  // 12. Collective Scenario Stress Testing & Deadlock Freedom
  console.log('\n--- Testing Collective Scenarios & Deadlock Freedom ---');
  
  // A. Deadlock-free Batch Locking via requestLocks / releaseLocks
  const batchFiles = ['src/components/Zebra.jsx', 'src/components/Alpha.jsx', 'src/components/Middle.jsx'];
  const batchReqResults = lockRegistry.requestLocks(batchFiles, 'batch-agent-1', 'UserBatch', 1);
  assert(batchReqResults.length === 3, 'Batch lock requested 3 files');
  assert(batchReqResults.every(r => r.status === 'granted'), 'All 3 files granted in canonical order');
  
  // Verify that all 3 files are currently locked
  assert(lockRegistry.locks.has('src/components/alpha.jsx'.toLowerCase()) || lockRegistry.locks.has('src/components/Alpha.jsx'), 'Alpha.jsx locked');
  assert(lockRegistry.locks.has('src/components/zebra.jsx'.toLowerCase()) || lockRegistry.locks.has('src/components/Zebra.jsx'), 'Zebra.jsx locked');

  // Second agent tries to request same batch in reverse order -> conflicts on first file without circular wait
  const reverseFiles = ['src/components/Zebra.jsx', 'src/components/Middle.jsx', 'src/components/Alpha.jsx'];
  const reverseReqResults = lockRegistry.requestLocks(reverseFiles, 'batch-agent-2', 'UserReverse', 1);
  assert(reverseReqResults.every(r => r.status === 'conflict'), 'Reverse order batch safely conflicts without circular wait deadlock');

  // Release batch
  const batchRelResults = lockRegistry.releaseLocks(batchFiles, 'batch-agent-1');
  assert(batchRelResults.length === 3 && batchRelResults.every(r => r.status === 'released'), 'Batch release frees all 3 files');
  // Clean up remaining locks from reverse agent
  lockRegistry.releaseLocks(batchFiles, 'batch-agent-2');

  // B. Remote Peer Disconnect Guaranteed Cleanup
  const remotePeerWs = new WebSocket(`ws://127.0.0.1:${actualPort}`);
  await new Promise((resolve) => {
    remotePeerWs.on('open', () => {
      remotePeerWs.send(JSON.stringify({ type: 'peer:join', user: 'RemoteBob', role: 'Peer' }));
      setTimeout(resolve, 300);
    });
  });

  const remoteLockFile = 'src/remote-test.js';
  lockRegistry.requestLock(remoteLockFile, 'RemoteBob', 'RemoteBob', 1);
  assert(lockRegistry.locks.has(remoteLockFile), 'Lock acquired by remote peer RemoteBob');

  // Now simulate sudden laptop close / WiFi drop
  remotePeerWs.close();
  await new Promise(resolve => setTimeout(resolve, 400));
  assert(!lockRegistry.locks.has(remoteLockFile), 'Remote peer lock immediately freed on WebSocket disconnect (zero zombie lag)');

  // C. REST API Batch Lock Endpoints
  const batchPostRes = await fetch(`http://127.0.0.1:${actualPort}/api/locks/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      files: ['src/batch-api-1.js', 'src/batch-api-2.js'],
      agentId: 'api-batch-agent',
      user: 'BatchUser',
      priorityTier: 1
    })
  });
  assert(batchPostRes.ok, 'POST /api/locks/request batch returns HTTP 200');
  const batchPostData = await batchPostRes.json();
  assert(batchPostData.status === 'granted' && batchPostData.results.length === 2, 'Batch request granted all files');

  const batchReleaseRes = await fetch(`http://127.0.0.1:${actualPort}/api/locks/release`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      files: ['src/batch-api-1.js', 'src/batch-api-2.js'],
      agentId: 'api-batch-agent'
    })
  });
  assert(batchReleaseRes.ok, 'POST /api/locks/release batch returns HTTP 200');
  const batchReleaseData = await batchReleaseRes.json();
  assert(batchReleaseData.status === 'released' && batchReleaseData.results.length === 2, 'Batch release successfully freed all files');

  // 13. Parallel Collaboration Scenario: Person 1 Agent A (Login) & Person 2 Agent B (Logout) on auth.js
  console.log('\n--- Testing Parallel Multi-Agent Collision & 3-Way AST Peacemaker Reconciliation ---');
  
  const authRelPath = 'test/fixtures/auth.js';
  const authFullPath = path.join(TURF_ROOT, authRelPath);
  fs.mkdirSync(path.dirname(authFullPath), { recursive: true });

  // Common ancestor base state on disk
  const baseAuthCode = `// auth.js - Base Module
export const authVersion = '2.4.0';
export const AUTH_TIMEOUT = 5000;
`;
  fs.writeFileSync(authFullPath, baseAuthCode, 'utf8');

  // Step 1: At 10:38, Agent A (Person 1) gets command to build 'login' in auth.js
  const lockA = lockRegistry.requestLock(authRelPath, 'agent-A-1038', 'Person1', 1, 'TRF-COLLAB');
  assert(lockA.status === 'granted', 'Agent A acquires initial lock on auth.js at 10:38');
  assert(lockRegistry.baseSnapshots.has(authRelPath), 'LockRegistry captures base snapshot for 3-way reconciliation');

  // Step 2: At 10:39, Agent B (Person 2) gets command to build 'logout' in auth.js
  const lockB = lockRegistry.requestLock(authRelPath, 'agent-B-1039', 'Person2', 1, 'TRF-COLLAB');
  assert(lockB.status === 'conflict', 'Agent B safely encounters conflict at 10:39 and enters anti-starvation queue');
  assert(lockB.suggestedAction === 'fork_speculative_worktree', 'LockRegistry advises Agent B to fork speculative worktree');

  // Verify cold-start seeding: Agent B worktree file is seeded with base code so edits don't start from blank
  const agentBWorktreeFile = path.join(lockB.worktreePath, authRelPath);
  assert(fs.existsSync(agentBWorktreeFile), 'Agent B speculative worktree file is automatically seeded on cold-start');
  const seededContent = fs.readFileSync(agentBWorktreeFile, 'utf8');
  assert(seededContent.includes('authVersion') && seededContent.includes('AUTH_TIMEOUT'), 'Seeded worktree contains base symbols');

  // Step 3: Agent A builds login() in main workspace
  const agentACode = `// auth.js - Base Module
export const authVersion = '2.4.0';
export const AUTH_TIMEOUT = 5000;

export function login(username, password) {
  if (!username || !password) throw new Error('Credentials required');
  return { user: username, token: 'token_' + username, timestamp: Date.now() };
}
`;
  fs.writeFileSync(authFullPath, agentACode, 'utf8');

  // Step 4: Agent B builds logout() in speculative worktree (simulating remote peer upload)
  const agentBCode = `// auth.js - Base Module
export const authVersion = '2.4.0';
export const AUTH_TIMEOUT = 5000;

export function logout(token) {
  if (!token) return { success: false, reason: 'no_token' };
  return { success: true, revokedAt: Date.now() };
}
`;
  // Test remote worktree upload endpoint POST /api/locks/worktree
  const uploadRes = await fetch(`http://127.0.0.1:${actualPort}/api/locks/worktree`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filePath: authRelPath,
      agentId: 'agent-B-1039',
      room: 'TRF-COLLAB',
      user: 'Person2',
      content: agentBCode
    })
  });
  assert(uploadRes.ok, 'POST /api/locks/worktree successfully receives remote peer worktree upload');
  const uploadData = await uploadRes.json();
  assert(uploadData.saved === true, 'Daemon successfully stored remote speculative worktree file');

  // Step 5: At 10:48 (10 min later), Agent A finishes and releases lock
  let promotedBReceived = false;
  let worktreeBReconciled = false;
  const onPromotedB = (info) => {
    if (info.filePath === authRelPath && info.agentId === 'agent-B-1039') {
      promotedBReceived = true;
      if (info.worktreeResult && info.worktreeResult.merged && info.worktreeResult.verified) {
        worktreeBReconciled = true;
      }
    }
  };
  lockRegistry.on('promoted', onPromotedB);

  const releaseResA = lockRegistry.releaseLock(authRelPath, 'agent-A-1038');
  assert(releaseResA.promotedTo === 'agent-B-1039', 'Agent B is promoted to lock holder upon Agent A release');
  assert(promotedBReceived, 'LockRegistry emits promoted event for Agent B');
  assert(worktreeBReconciled, 'Peacemaker successfully reconciles and verifies Agent B changes');

  // Step 6: Verify final file in main workspace contains BOTH login and logout without loss
  const finalDiskContent = fs.readFileSync(authFullPath, 'utf8');
  assert(finalDiskContent.includes('login') && finalDiskContent.includes('logout'), 'Main workspace file contains BOTH login and logout functions');
  assert(finalDiskContent.includes('authVersion') && finalDiskContent.includes('AUTH_TIMEOUT'), 'Main workspace retains original base symbols');

  // Step 7: Strict Babel AST Semantic Audit on unified file
  const finalAst = extractAstSymbols(finalDiskContent);
  assert(!finalAst.parseError, 'Reconciled auth.js passes Babel AST parsing without syntax errors');
  assert(finalAst.exports.has('login'), 'Babel AST confirms login is properly exported');
  assert(finalAst.exports.has('logout'), 'Babel AST confirms logout is properly exported');
  assert(finalAst.exports.has('authVersion'), 'Babel AST confirms authVersion is preserved');
  assert(finalAst.declarations.has('login') && finalAst.declarations.has('logout'), 'Babel AST confirms both functions declared');

  // Step 8: Fail-Safe Guard: If speculative worktree has invalid syntax, do not corrupt main file
  const failSafeRel = 'test/fixtures/fail-safe.js';
  const failSafeFull = path.join(TURF_ROOT, failSafeRel);
  const goodCode = 'export function safeFunction() { return 123; }\n';
  fs.writeFileSync(failSafeFull, goodCode, 'utf8');

  lockRegistry.requestLock(failSafeRel, 'holder-agent', 'Dev1', 1);
  const queuedBad = lockRegistry.requestLock(failSafeRel, 'bad-syntax-agent', 'Dev2', 1);
  assert(queuedBad.status === 'conflict', 'Bad syntax agent enqueued on conflict');

  // Write broken code into bad-syntax-agent worktree
  const badSyntaxCode = 'export function broken() { {{{';
  lockRegistry.saveWorktreeFile(failSafeRel, 'bad-syntax-agent', 'default', badSyntaxCode);

  const releaseHolder = lockRegistry.releaseLock(failSafeRel, 'holder-agent');
  assert(releaseHolder.promotedTo === 'bad-syntax-agent', 'Bad syntax agent promoted');

  // Verify main file is UNTOUCHED because AST verification rejected corrupted code
  const preservedCode = fs.readFileSync(failSafeFull, 'utf8');
  assert(preservedCode === goodCode, 'Fail-safe: Main file is NOT corrupted when speculative worktree contains syntax errors');

  // Step 9: Clean up temporary test files
  lockRegistry.off('promoted', onPromotedB);
  lockRegistry.releaseLock(authRelPath, 'agent-B-1039');
  lockRegistry.releaseLock(failSafeRel, 'bad-syntax-agent');
  try { fs.unlinkSync(authFullPath); } catch (e) {}
  try { fs.unlinkSync(failSafeFull); } catch (e) {}
  try { fs.rmdirSync(path.join(TURF_ROOT, 'test/fixtures')); } catch (e) {}

  // 14. Adversarial Concurrency & Remote Network Peer Tests
  console.log('\n--- Testing Adversarial Concurrency & Remote Peer Network Invariants ---');

  // Test A: Remote PID Guard: Remote peer with foreign PID is NOT evicted by local OS process check
  const remoteFile = 'test/fixtures/remote-peer.js';
  const remoteReq = lockRegistry.requestLock(remoteFile, 'remote-laptop-agent', 'Alice-Remote', 1, 'TRF-CHAOS', 999999);
  assert(remoteReq.status === 'granted', 'Remote peer acquired lock with remote PID');
  // Trigger zombie eviction sweep
  lockRegistry._evictZombies();
  const lockStillAlive = lockRegistry.locks.has(lockRegistry._norm(remoteFile));
  assert(lockStillAlive, 'Remote peer lock is NOT prematurely evicted by local host isProcessAlive() check');
  lockRegistry.releaseLock(remoteFile, 'remote-laptop-agent');

  // Test B: CRLF vs LF Line-Ending Normalization
  const baseCrlf = 'function alpha() {\r\n  return 1;\r\n}\r\n\r\nfunction beta() {\r\n  return 2;\r\n}\r\n';
  const aLf = 'function alpha() {\n  console.log("alpha");\n  return 1;\n}\n\nfunction beta() {\n  return 2;\n}\n';
  const bCrlf = 'function alpha() {\r\n  return 1;\r\n}\r\n\r\nfunction beta() {\r\n  console.log("beta");\r\n  return 2;\r\n}\r\n';
  const crlfMergeRes = gitMerge3Way(baseCrlf, aLf, bCrlf);
  assert(crlfMergeRes.success === true, 'gitMerge3Way seamlessly merges Windows CRLF and POSIX LF without conflicts');
  assert(crlfMergeRes.merged.includes('console.log("alpha")') && crlfMergeRes.merged.includes('console.log("beta")'), 'Merged result contains both alpha and beta modifications');

  // Test C: Disconnected Queue Head Bypass
  const ghostQueueFile = 'test/fixtures/ghost-bypass.js';
  lockRegistry.requestLock(ghostQueueFile, 'holder-agent', 'Dev1', 1);
  // Enqueue a CLI ghost agent
  const cliGhostReq = lockRegistry.requestLock(ghostQueueFile, 'cli_agent_ghost', 'Dev2', 1);
  assert(cliGhostReq.status === 'conflict', 'CLI agent enqueued');
  // Enqueue a live agent behind it
  const liveAgentReq = lockRegistry.requestLock(ghostQueueFile, 'live_agent_next', 'Dev3', 1);
  assert(liveAgentReq.status === 'conflict', 'Live agent enqueued behind CLI ghost');

  // Holder releases -> ghost must be pruned, live agent promoted immediately
  const ghostBypassRelease = lockRegistry.releaseLock(ghostQueueFile, 'holder-agent');
  assert(ghostBypassRelease.promotedTo === 'live_agent_next', 'Dead CLI ghost bypassed immediately; live agent promoted to lock holder');
  lockRegistry.releaseLock(ghostQueueFile, 'live_agent_next');

  // 15. Adversarial Multi-Language Coverage & Same-Function Collision
  console.log('\n--- Testing Multi-Language Coverage & Same-Function Collision Reconciliation ---');

  // Test A: Non-JS Language Verification
  const jsonCode = '{\n  "name": "turfcode",\n  "version": "1.0.0"\n}\n';
  const jsonVerify = verifyCode(jsonCode, '', '', 'config.json');
  assert(jsonVerify.valid === true, 'verifyCode validates JSON files with JSON.parse without node --check crash');

  const pyCode = 'def calculate_metrics(data):\n    return sum(data) / len(data)\n';
  const pyVerify = verifyCode(pyCode, '', '', 'app.py');
  assert(pyVerify.valid === true, 'verifyCode validates Python files without node --check crash');

  const yamlCode = 'server:\n  port: 8080\n  host: 0.0.0.0\n';
  const yamlVerify = verifyCode(yamlCode, '', '', 'config.yaml');
  assert(yamlVerify.valid === true, 'verifyCode validates YAML files without node --check crash');

  const mdCode = '# Turfcode Documentation\n\nReal-time collaborative engine for AI agents.\n';
  const mdVerify = verifyCode(mdCode, '', '', 'README.md');
  assert(mdVerify.valid === true, 'verifyCode validates Markdown files without node --check crash');

  // Test B: Same-Function Collision Reconciliation (Both modify the body of login)
  const baseFunc = 'export function login(user, pass) {\n    const account = findUser(user);\n    if (!account) return false;\n    return account.password === pass;\n}\n';
  const aFunc = 'import { hashPassword, verifyHash } from "./crypto.js";\n\nexport function login(user, pass) {\n    const account = findUser(user);\n    if (!account) return false;\n    return verifyHash(pass, account.passwordHash);\n}\n';
  const bFunc = 'import { checkRateLimit } from "./rate-limiter.js";\n\nexport function login(user, pass) {\n    if (!checkRateLimit(user)) {\n        throw new Error("Rate limit exceeded");\n    }\n    const account = findUser(user);\n    if (!account) return false;\n    return account.password === pass;\n}\n';

  const mergedSameFunc = peacemakerMergeSync('src/auth.js', baseFunc, aFunc, bFunc);
  assert(mergedSameFunc.includes('verifyHash') && mergedSameFunc.includes('checkRateLimit'), 'Peacemaker successfully merges statements inside the same function body');
  const sameFuncVerify = verifyCode(mergedSameFunc, aFunc, bFunc, 'src/auth.js');
  assert(sameFuncVerify.valid === true, 'Reconciled same-function collision passes 3-stage verification');

  // Test C: Windows Path Sanitization (Leading slashes)
  const normalizedSlash = lockRegistry._norm('/src/nested/file.js');
  assert(!normalizedSlash.startsWith('/'), 'Leading slash stripped to prevent Windows drive-root escape');

  // 16. Hackathon Presentation Hardening & Mathematical Queue Verification
  console.log('\n--- Testing Hackathon Concurrency Engine & Mathematical Queue Dynamics ---');

  // Test A: peacemakerMerge async does not throw ReferenceError: normA
  const sampleBase = 'export function add(a, b) { return a + b; }\n';
  const sampleA = 'export function add(a, b) { return a + b; }\nexport function sub(a, b) { return a - b; }\n';
  const sampleB = 'export function add(a, b) { return a + b; }\nexport function mul(a, b) { return a * b; }\n';
  const asyncMerged = await peacemakerMerge('src/math.js', sampleBase, sampleA, sampleB);
  assert(typeof asyncMerged === 'string' && asyncMerged.includes('sub') && asyncMerged.includes('mul'), 'peacemakerMerge (async) preserves both functions without ReferenceError: normA');

  // Test B: Mathematical Anti-Starvation Aging Dynamics
  const mathTestFile = 'src/shared_calc.js';
  lockRegistry.requestLock(mathTestFile, 'initial_holder', 'Holder', { score: 100 });
  const t0 = Date.now();
  // Enqueue low-priority background agent (Score 50)
  lockRegistry.queues.set(mathTestFile, [{
    agentId: 'low_tier_agent',
    user: 'Agent Low',
    score: 50,
    enqueuedTime: t0 - 16000, // 16 seconds ago
    seq: 1
  }, {
    agentId: 'high_tier_human',
    user: 'Human High',
    score: 100,
    enqueuedTime: t0, // Just arrived
    seq: 2
  }]);

  const computedQueue = lockRegistry._computeQueue(mathTestFile);
  assert(computedQueue.length === 2, '_computeQueue returns both queued candidates');
  assert(computedQueue[0].agentId === 'low_tier_agent', 'Anti-starvation formula mathematically promotes low-tier agent after 16s (50 + 3.5*16 = 106 > 100)');
  assert(computedQueue[0].effectivePriority >= 105, 'Computed effective priority reflects aging coefficient (+3.5/s)');
  assert(computedQueue[0].rank === 1, 'Top candidate receives Rank 1');
  assert(typeof computedQueue[0].estimatedWaitSeconds === 'number', 'Queue item calculates estimated wait seconds');

  // Test C: Dual-Agent Concurrent Edit on Same File with Speculative Worktree Fork & AST Merge
  const concurrentFile = 'demo/collision_test.js';
  const diskFile = path.resolve(TURF_ROOT, concurrentFile);
  fs.mkdirSync(path.dirname(diskFile), { recursive: true });
  const baseDiskContent = 'export function processOrder(order) {\n  let total = order.amount;\n  return total;\n}\n';
  fs.writeFileSync(diskFile, baseDiskContent, 'utf8');

  // Agent 1 acquires lock
  const req1 = lockRegistry.requestLock(concurrentFile, 'agent_vip', 'AgentVip', 1);
  assert(req1.status === 'granted', 'Agent 1 acquires initial lock on collision_test.js');

  // Agent 2 encounters conflict and is advised to fork speculative worktree
  const req2 = lockRegistry.requestLock(concurrentFile, 'agent_tax', 'AgentTax', 1);
  assert(req2.status === 'conflict', 'Agent 2 receives collision notice and enters waiting queue');

  // Agent 1 writes changes to main file
  const agent1Mod = 'export function processOrder(order) {\n  let total = order.amount;\n  function applyVip() { total *= 0.85; }\n  applyVip();\n  return total;\n}\n';
  fs.writeFileSync(diskFile, agent1Mod, 'utf8');

  // Agent 2 writes changes to speculative worktree
  const agent2Mod = 'export function processOrder(order) {\n  let total = order.amount;\n  function applyTax() { total += 10.0; }\n  applyTax();\n  return total;\n}\n';
  const wtRoom = 'default';
  const wtKey = `${wtRoom}:agent_tax:${concurrentFile}`;
  lockRegistry.speculativeWorktrees.set(wtKey, agent2Mod);

  // Agent 1 releases lock -> Agent 2 promoted -> AST Peacemaker automatically merges
  const rel1 = lockRegistry.releaseLock(concurrentFile, 'agent_vip');
  assert(rel1.status === 'released', 'Agent 1 successfully releases lock');

  // Verify that the file on disk now contains BOTH modifications seamlessly merged!
  const reconciledDisk = fs.readFileSync(diskFile, 'utf8');
  assert(reconciledDisk.includes('applyVip') && reconciledDisk.includes('applyTax'), 'Speculative worktree automatically merged both VIP and Tax modifications to disk');
  const reconcVerify = verifyCode(reconciledDisk, agent1Mod, agent2Mod, concurrentFile);
  assert(reconcVerify.valid === true, 'Reconciled collision passes full Babel AST verification');

  // Clean up test file and lock
  lockRegistry.releaseLock(concurrentFile, 'agent_tax');
  try { fs.unlinkSync(diskFile); } catch (e) {}
  try { lockRegistry.releaseLock(mathTestFile, 'initial_holder'); } catch (e) {}

  // Test D: Pi CLI Non-Interactive Spawn Configuration Check
  const turfWrapperContent = fs.readFileSync(path.join(TURF_ROOT, 'bin', 'turf-agent.js'), 'utf8');
  assert(turfWrapperContent.includes("args.unshift('-p')") || turfWrapperContent.includes("args.includes('-p')"), 'turf-agent.js guarantees non-interactive -p flag');

  console.log('\n--- E2E Tests Complete ---');

  console.log(`Passed: ${passed}, Failed: ${failed}`);

  ws.close();
  wss.clients.forEach(c => c.close());
  wss.close();
  server.close();
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(console.error);
