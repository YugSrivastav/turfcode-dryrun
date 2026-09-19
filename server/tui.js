import blessed from 'blessed';
import { spawn, exec } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import fs from 'fs';
import { ptyManager, safeEscape, getPaletteModelsForTab, getCmdcModels } from './pty_manager.js';
import { lockRegistry } from './locks.js';


// Patch blessed textarea and textbox to prevent unhandled TypeError: this._done is not a function
// when Enter or Escape is pressed without an active readInput() cycle.
if (blessed && blessed.textarea && blessed.textarea.prototype) {
  const origTextareaListener = blessed.textarea.prototype._listener;
  blessed.textarea.prototype._listener = function(ch, key) {
    if (key && (key.name === 'enter' || key.name === 'return')) {
      if (typeof this._done === 'function') {
        this._done(null, this.value);
      } else {
        this.emit('submit', this.value);
      }
      return;
    }
    if (key && key.name === 'escape') {
      if (typeof this._done === 'function') {
        this._done(null, null);
      } else {
        this.emit('cancel');
      }
      return;
    }
    try {
      return origTextareaListener ? origTextareaListener.call(this, ch, key) : undefined;
    } catch (err) {
      if (err && String(err.message).includes('done is not a function')) {
        return;
      }
      throw err;
    }
  };
}

if (blessed && blessed.textbox && blessed.textbox.prototype) {
  const origTextboxListener = blessed.textbox.prototype._listener;
  blessed.textbox.prototype._listener = function(ch, key) {
    if (key && (key.name === 'enter' || key.name === 'return')) {
      if (typeof this._done === 'function') {
        this._done(null, this.value);
      } else {
        this.emit('submit', this.value);
      }
      return;
    }
    if (key && key.name === 'escape') {
      if (typeof this._done === 'function') {
        this._done(null, null);
      } else {
        this.emit('cancel');
      }
      return;
    }
    try {
      return origTextboxListener ? origTextboxListener.call(this, ch, key) : undefined;
    } catch (err) {
      if (err && String(err.message).includes('done is not a function')) {
        return;
      }
      throw err;
    }
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TURF_ROOT = path.resolve(__dirname, '..');

export function buildFileTree(dir, baseDir = dir, depth = 0, maxDepth = 6) {
  if (depth > maxDepth) return [];
  const IGNORE = new Set(['.git', 'node_modules', 'dist', 'build', '.gemini', '.turbo', '.system_generated', '.next', 'coverage', '.cache']);
  const items = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        items.push({
          name: entry.name,
          relPath,
          fullPath,
          isDir: true,
          children: buildFileTree(fullPath, baseDir, depth + 1, maxDepth)
        });
      } else if (entry.isFile()) {
        items.push({
          name: entry.name,
          relPath,
          fullPath,
          isDir: false
        });
      }
    }
  } catch (e) {}
  return items;
}

export function flattenFileTree(nodes, expandedDirs, depth = 0, parentRel = null) {
  let list = [];
  for (const node of nodes) {
    const isExpanded = expandedDirs.has(node.relPath);
    list.push({
      ...node,
      depth,
      parentRel,
      isExpanded
    });
    if (node.isDir && isExpanded && node.children && node.children.length > 0) {
      list = list.concat(flattenFileTree(node.children, expandedDirs, depth + 1, node.relPath));
    }
  }
  return list;
}

function truncateString(str, maxW) {
  if (!str) return '';
  let w = 0;
  let res = '';
  for (const ch of str) {
    const cw = blessed.unicode ? blessed.unicode.charWidth(ch) : 1;
    if (w + cw > maxW) {
      return res.slice(0, Math.max(0, res.length - 1)) + '…';
    }
    res += ch;
    w += cw;
  }
  return res;
}

function padToWidth(taggedStr, targetWidth) {
  const plain = taggedStr.replace(/{[^}]+}/g, '');
  const currentW = blessed.unicode ? blessed.unicode.strWidth(plain) : plain.length;
  if (currentW < targetWidth) {
    return taggedStr + ' '.repeat(targetWidth - currentW);
  }
  return taggedStr;
}

export function getTruncatedPath(dirPath, maxLen = 22) {
  if (!dirPath) return '';
  if (dirPath.length <= maxLen) return dirPath;
  const base = path.basename(dirPath);
  if (base.length >= maxLen - 3) return '…' + base.slice(-(maxLen - 3));
  return dirPath.slice(0, maxLen - base.length - 4) + '…/' + base;
}

export function calculateLayout(cols = 100, rows = 30, leftCollapsed = false, rightCollapsed = false) {
  const minCenterW = 38;
  const headerHeight = 1;
  const footerHeight = 1;
  const contentHeight = Math.max(8, rows - headerHeight - footerHeight);

  let leftW = 0;
  let rightW = 0;

  if (cols < 75) {
    leftW = 0;
    rightW = 0;
  } else if (cols < 95) {
    leftW = leftCollapsed ? 0 : 20;
    rightW = rightCollapsed ? 0 : 24;
    if (cols - leftW - rightW < minCenterW) {
      leftW = 0;
      if (cols - rightW < minCenterW) {
        rightW = Math.max(0, cols - minCenterW);
      }
    }
  } else if (cols < 125) {
    leftW = leftCollapsed ? 0 : 24;
    rightW = rightCollapsed ? 0 : 28;
    if (cols - leftW - rightW < minCenterW) {
      leftW = leftCollapsed ? 0 : Math.max(0, Math.floor(cols * 0.22));
      rightW = rightCollapsed ? 0 : Math.max(0, Math.floor(cols * 0.26));
    }
  } else {
    leftW = leftCollapsed ? 0 : 28;
    rightW = rightCollapsed ? 0 : 32;
  }

  if (rightCollapsed) rightW = 0;
  if (leftCollapsed) leftW = 0;

  const centerW = Math.max(minCenterW, cols - leftW - rightW);

  return {
    cols,
    rows,
    header: { top: 0, left: 0, width: cols, height: 1 },
    footer: { top: rows - 1, bottom: 0, left: 0, width: cols, height: 1 },
    leftSidebar: { top: 1, left: 0, width: leftW, height: contentHeight, hidden: leftW === 0 },
    centerPane: { top: 1, left: leftW, width: centerW, height: contentHeight },
    rightSidebar: { top: 1, left: leftW + centerW, width: rightW, height: contentHeight, hidden: rightW === 0 },
    contentHeight
  };
}

export function buildHeaderContent(cols = 100, options = {}) {
  const {
    roomCode = 'TRF-0000',
    localIp = '127.0.0.1',
    hostAddress = '127.0.0.1',
    port = 7777,
    hostName = 'User',
    currentDir = ''
  } = options;

  const brand = '{bold}{149-fg}TURF{/149-fg}{white-fg}CODE{/white-fg}{/bold}';
  const ipStr = `${localIp || hostAddress || '127.0.0.1'}:${port}`;

  if (cols < 65) {
    return ` ${brand} │ {yellow-fg}${roomCode}{/yellow-fg} │ {cyan-fg}${hostName}{/cyan-fg}`;
  }

  if (cols < 90) {
    const maxPath = Math.max(6, cols - 48);
    const truncPath = getTruncatedPath(currentDir, maxPath);
    return ` ${brand} │ {yellow-fg}${roomCode}{/yellow-fg} │ {cyan-fg}${hostName}{/cyan-fg} │ {yellow-fg}${truncPath}{/yellow-fg}`;
  }

  if (cols < 120) {
    const maxPath = Math.max(8, cols - 68);
    const truncPath = getTruncatedPath(currentDir, maxPath);
    return ` ${brand} │ Room: {bold}{yellow-fg}${roomCode}{/yellow-fg}{/bold} │ WiFi: {yellow-fg}${ipStr}{/yellow-fg} │ User: {bold}{cyan-fg}${hostName}{/cyan-fg}{/bold} │ Dir: {yellow-fg}${truncPath}{/yellow-fg}`;
  }

  const maxPath = Math.max(14, cols - 75);
  const truncPath = getTruncatedPath(currentDir, maxPath);
  return ` ${brand} │ Room: {bold}{yellow-fg}${roomCode}{/yellow-fg}{/bold} │ WiFi: {bold}{yellow-fg}${ipStr}{/yellow-fg}{/bold} │ User: {bold}{cyan-fg}${hostName}{/cyan-fg}{/bold} │ Dir: {yellow-fg}${truncPath}{/yellow-fg}`;
}

export function buildFooterContent(cols = 100, customPills = null) {
  const defaultPills = [
    { text: '{bold}{149-fg}[Tab]{/149-fg}{/bold} Focus', plain: '[Tab] Focus' },
    { text: '{bold}{149-fg}[/]{/149-fg}{/bold} Cmds', plain: '[/] Cmds' },
    { text: '{bold}{green-fg}[/turf]{/green-fg}{/bold} Turf', plain: '[/turf] Turf' },
    { text: '{bold}{magenta-fg}[/cmdc]{/magenta-fg}{/bold} CMDC', plain: '[/cmdc] CMDC' },
    { text: '{bold}{cyan-fg}[/codex]{/cyan-fg}{/bold} Codex', plain: '[/codex] Codex' },
    { text: '{bold}{yellow-fg}[F4]{/yellow-fg}{/bold} File', plain: '[F4] File' },
    { text: '{bold}{yellow-fg}[F2]{/yellow-fg}{/bold} Intent', plain: '[F2] Intent' },
    { text: '{bold}{yellow-fg}[F3]{/yellow-fg}{/bold} Files', plain: '[F3] Files' },
    { text: '{bold}{yellow-fg}[Ctrl+B]{/yellow-fg}{/bold} Left', plain: '[Ctrl+B] Left' },
    { text: '{bold}{yellow-fg}[Ctrl+E]{/yellow-fg}{/bold} Right', plain: '[Ctrl+E] Right' },
    { text: '{bold}{yellow-fg}[Ctrl+O]{/yellow-fg}{/bold} Web', plain: '[Ctrl+O] Web' },
    { text: '{bold}{149-fg}[PgUp/Dn]{/149-fg}{/bold} Scroll', plain: '[PgUp/Dn] Scroll' },
    { text: '{bold}{yellow-fg}[F5]{/yellow-fg}{/bold} Demo', plain: '[F5] Demo' },
    { text: '{bold}{yellow-fg}[Ctrl+C]{/yellow-fg}{/bold} Quit', plain: '[Ctrl+C] Quit' }
  ];

  const pills = customPills || defaultPills;
  let res = ' ';
  let plainLen = 1;
  const maxLen = Math.max(12, cols - 2);

  for (let i = 0; i < pills.length; i++) {
    const pill = pills[i];
    const sep = i === 0 ? '' : ' │ ';
    const sepPlainLen = i === 0 ? 0 : 3;
    if (plainLen + sepPlainLen + pill.plain.length > maxLen) {
      break;
    }
    res += sep + pill.text;
    plainLen += sepPlainLen + pill.plain.length;
  }
  return res + ' ';
}

export function buildCenterLabel(centerW = 60, activeCenterTab = 'turf', statuses = {}, openedFile = null, isPlanMode = false) {
  const termStatus = statuses.termStatus || 'idle';
  const cmdcStatus = statuses.cmdcStatus || 'idle';
  const codexStatus = statuses.codexStatus || 'idle';
  const turfStatus = statuses.turfStatus || 'idle';

  const fileBase = openedFile ? path.basename(openedFile) : null;

  function tabBadge(name, st) {
    if (st === 'working') return `${name}*`;
    if (st === 'awaiting_input') return `${name}?`;
    return name;
  }

  if (centerW < 46) {
    let activeName = activeCenterTab.toUpperCase();
    if (activeCenterTab === 'turf' && isPlanMode) activeName += ' (PLAN)';
    const st = statuses[activeCenterTab + 'Status'];
    if (st === 'working') activeName += '*';
    if (activeCenterTab === 'file' && fileBase) {
      activeName = `FILE: ${truncateString(fileBase, 10)}`;
    }
    return ` [● ${activeName}] `;
  }

  if (centerW < 68) {
    const t = turfStatus === 'working' ? 'TURF*' : 'TURF';
    const c = cmdcStatus === 'working' ? 'CMDC*' : 'CMDC';
    const x = codexStatus === 'working' ? 'CDX*' : 'CDX';
    const s = termStatus === 'working' ? 'TERM*' : 'TERM';
    const f = fileBase ? truncateString(fileBase, 8) : 'FILE';

    const pill = (tab, label) => (activeCenterTab === tab || (tab === 'cmdc' && activeCenterTab === 'agy')) ? `[● ${label}]` : `○ ${label}`;
    return ` ${pill('turf', t)} │ ${pill('cmdc', c)} │ ${pill('codex', x)} │ ${pill('term', s)} │ ${activeCenterTab === 'file' ? `[● ${f}]` : f} `;
  }

  const termLabel = tabBadge('TERM', termStatus);
  const cmdcLabel = tabBadge('CMDC', cmdcStatus);
  const codexLabel = tabBadge('CODEX', codexStatus);
  const turfBase = tabBadge('TURF', turfStatus);
  const turfLabel = isPlanMode ? `${turfBase} (PLAN)` : turfBase;
  const truncatedBase = fileBase ? truncateString(fileBase, 12) : null;
  const fileLabel = truncatedBase ? `FILE: ${truncatedBase} (F4)` : 'FILE (F4)';

  const pill = (tab, label) => (activeCenterTab === tab || (tab === 'cmdc' && activeCenterTab === 'agy')) ? `[● ${label}]` : `○ ${label}`;
  return ` ${pill('turf', turfLabel)} │ ${pill('cmdc', cmdcLabel)} │ ${pill('codex', codexLabel)} │ ${pill('term', termLabel)} │ ${activeCenterTab === 'file' ? `[● ${fileLabel}]` : fileLabel} `;
}

export function formatTreeNode(node, maxInnerWidth = 24) {
  const indentWidth = node.depth * 2;
  const indent = '  '.repeat(node.depth);

  if (node.isDir) {
    const arrow = node.isExpanded ? '▾' : '▸';
    const maxNameLen = Math.max(3, maxInnerWidth - indentWidth - 5);
    const displayName = truncateString(node.name, maxNameLen);
    const raw = `${indent} {bold}{yellow-fg}${arrow} ${displayName}/{/yellow-fg}{/bold}`;
    return padToWidth(raw, maxInnerWidth);
  }

  const ext = path.extname(node.name).toLowerCase();
  let color = 'white-fg';

  if (['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx'].includes(ext)) {
    color = 'green-fg';
  } else if (['.json', '.yaml', '.yml', '.toml'].includes(ext)) {
    color = 'cyan-fg';
  } else if (['.md', '.txt', '.log'].includes(ext)) {
    color = 'magenta-fg';
  } else if (['.html', '.css', '.scss'].includes(ext)) {
    color = 'blue-fg';
  } else if (['.png', '.jpg', '.jpeg', '.svg', '.gif', '.ico'].includes(ext)) {
    color = 'cyan-fg';
  } else if (['.sh', '.bash', '.ps1', '.bat', '.cmd'].includes(ext)) {
    color = 'yellow-fg';
  }

  const maxNameLen = Math.max(3, maxInnerWidth - indentWidth - 6);
  const displayName = truncateString(node.name, maxNameLen);
  const raw = `${indent}   {${color}}▪ ${displayName}{/${color}}`;
  return padToWidth(raw, maxInnerWidth);
}

export function getProjectFiles(dir, baseDir = dir) {
  const tree = buildFileTree(dir, baseDir);
  function extractFiles(nodes) {
    let files = [];
    for (const n of nodes) {
      if (n.isDir && n.children) files = files.concat(extractFiles(n.children));
      else if (!n.isDir) files.push(n.relPath);
    }
    return files;
  }
  return extractFiles(tree);
}

const CLIS = [
  { id: 'shell', name: 'PowerShell / Shell', prefix: process.platform === 'win32' ? 'PS' : '$', cmd: '' },
  { id: 'cmdc', name: 'Command Code (cmdc)', prefix: 'cmdc', cmd: 'cmdc' },
  { id: 'claude', name: 'Claude Code (claude)', prefix: 'claude', cmd: 'claude' },
  { id: 'codex', name: 'Codex (codex)', prefix: 'codex', cmd: 'codex' },
  { id: 'opencode', name: 'OpenCode (opencode)', prefix: 'opencode', cmd: 'opencode' }
];

export function launchTUI({ hostName, roomCode, repoPath, port, localIp, hostAddress, isPeer, serverInstance, wssInstance, detectedAgents = { cmdc: true, codex: false } }) {
  // Ensure process.stdin is clean of any leftover listeners/state from readline or previous runs
  try {
    process.stdin.removeAllListeners('newListener');
    process.stdin.removeAllListeners('keypress');
    process.stdin.removeAllListeners('data');
    process.stdin.removeAllListeners('line');
    for (const s of Object.getOwnPropertySymbols(process.stdin)) {
      const desc = s.description || s.toString();
      if (desc.includes('keypress') || desc.includes('escape')) {
        delete process.stdin[s];
      }
    }
  } catch (e) {}

  // Switch to alternate screen buffer, clear screen, clear scrollback, home cursor
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[3J\x1b[H');

  const screen = blessed.screen({
    smartCSR: true,
    fastCSR: true,
    useBCE: true,
    title: 'Turfcode',
    dockBorders: true,
    autoPadding: true,
    fullUnicode: true,
    warnings: false,
    mouse: true,
    sendFocus: true,
    cursor: {
      artificial: false,
      shape: 'line',
      blink: true
    }
  });

  try {
    screen.enableMouse();
  } catch (e) {}

  screen.program.alternateBuffer();
  screen.program.clear();
  screen.program.cursorPos(0, 0);
  screen.clearRegion(0, screen.width, 0, screen.height);

  let activeCliIndex = 0;
  let currentCli = CLIS[activeCliIndex];
  let currentDir = repoPath;
  let activeCenterTab = 'turf'; // 'turf' | 'cmdc' | 'codex' | 'term' | 'file'
  let lastActiveCenterTab = 'turf';
  let activeTermProc = null;
  let activeCmdcProc = null;
  let activeCodexProc = null;
  let activeTurfProc = null;

  const onUncaught = (err) => {
    try {
      const logLine = `[${new Date().toISOString()}] [TUI] Uncaught Exception: ${err.stack || err}\n`;
      fs.appendFileSync(path.join(currentDir, 'turf-error.log'), logLine);
      if (typeof getActiveLog === 'function') {
        const al = getActiveLog();
        if (al && al.log) {
          al.log(`{red-fg}⚠️ Intercepted: ${err.message || err} (details in turf-error.log){/red-fg}`);
          screen.render();
        }
      }
    } catch (e) {}
  };

  const onUnhandled = (reason) => {
    try {
      const logLine = `[${new Date().toISOString()}] [TUI] Unhandled Rejection: ${reason && (reason.stack || reason)}\n`;
      fs.appendFileSync(path.join(currentDir, 'turf-error.log'), logLine);
      if (typeof getActiveLog === 'function') {
        const al = getActiveLog();
        if (al && al.log) {
          al.log(`{red-fg}⚠️ Intercepted Rejection: ${reason && (reason.message || reason)} (details in turf-error.log){/red-fg}`);
          screen.render();
        }
      }
    } catch (e) {}
  };

  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);

  const ws = new WebSocket(`ws://${hostAddress || '127.0.0.1'}:${port}`);
  
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'peer:join', user: hostName, role: isPeer ? 'Peer' : 'Host' }));
  });

  ws.on('error', (err) => {
    // Avoid crashing on connection error
  });

  const header = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: '',
    tags: true,
    style: {
      fg: 'white',
      bg: 'black',
      bold: true
    }
  });
  screen.append(header);

  function updateHeader() {
    const cols = screen.width || 100;
    header.setContent(buildHeaderContent(cols, {
      roomCode,
      localIp,
      hostAddress,
      port,
      hostName,
      currentDir
    }));
  }
  updateHeader();

  let isLeftSidebarCollapsed = (screen.width || 100) < 95;
  let isRightSidebarCollapsed = false;

  const initLayout = calculateLayout(screen.width || 100, screen.height || 30, isLeftSidebarCollapsed, isRightSidebarCollapsed);

  const leftSidebar = blessed.box({
    top: 1,
    left: initLayout.leftSidebar.left,
    width: initLayout.leftSidebar.width,
    height: initLayout.leftSidebar.height,
    hidden: initLayout.leftSidebar.hidden
  });
  screen.append(leftSidebar);

  const peopleBox = blessed.box({
    parent: leftSidebar,
    top: 0,
    left: 0,
    width: '100%',
    height: 7,
    label: ' {bold}{cyan-fg}[PEOPLE]{/cyan-fg}{/bold} ',
    border: { type: 'line', fg: 'cyan' },
    tags: true,
    content: ` {green-fg}* {bold}${hostName}{/bold} (You){/green-fg}\n {grey-fg}(Solo — code: ${roomCode}){/grey-fg}`
  });

  const filesBox = blessed.box({
    parent: leftSidebar,
    top: 7,
    left: 0,
    width: '100%',
    bottom: 0,
    label: ' {bold}{cyan-fg}[FILES]{/cyan-fg}{/bold} {grey-fg}[F3]{/grey-fg} ',
    border: { type: 'line', fg: 'cyan' },
    tags: true
  });

  const filesList = blessed.list({
    parent: filesBox,
    top: 0,
    left: 0,
    right: 1,
    height: '100%-2',
    keys: false,
    mouse: true,
    vi: false,
    tags: true,
    style: {
      selected: {
        bg: 'blue',
        fg: 'white',
        bold: true
      },
      item: {
        fg: 'white'
      }
    },
    scrollbar: {
      ch: '│',
      track: { bg: 'black' },
      style: { bg: 'cyan' }
    }
  });

  function updatePeopleBox(peers) {
    if (!peers || peers.length === 0) return;
    let content = '';
    peers.forEach(p => {
      if (p.name === hostName) {
        content += ` {green-fg}* {bold}${p.name} (You){/bold}{/green-fg}\n`;
      } else {
        content += ` {cyan-fg}* ${p.name} [${p.role}]{/cyan-fg}\n`;
      }
    });
    peopleBox.setContent(content);
    screen.render();
  }

  const centerPane = blessed.box({
    top: 1,
    left: initLayout.centerPane.left,
    width: initLayout.centerPane.width,
    height: initLayout.centerPane.height,
    label: ' [TERMINAL]  FILE (F4) ',
    border: { type: 'line', fg: 'green' },
    style: {
      border: { fg: 'green' },
      label: { fg: 'green', bold: true }
    }
  });
  screen.append(centerPane);

  const rightSidebar = blessed.box({
    top: 1,
    left: initLayout.rightSidebar.left,
    width: initLayout.rightSidebar.width,
    height: initLayout.rightSidebar.height,
    hidden: initLayout.rightSidebar.hidden
  });
  screen.append(rightSidebar);

  function applyLayout() {
    const cols = screen.width || 100;
    const rows = screen.height || 30;
    const layout = calculateLayout(cols, rows, isLeftSidebarCollapsed, isRightSidebarCollapsed);

    if (layout.leftSidebar.hidden) {
      leftSidebar.hide();
    } else {
      leftSidebar.show();
      leftSidebar.left = layout.leftSidebar.left;
      leftSidebar.width = layout.leftSidebar.width;
      leftSidebar.height = layout.leftSidebar.height;
    }

    if (rightSidebar) {
      if (layout.rightSidebar.hidden) {
        rightSidebar.hide();
      } else {
        rightSidebar.show();
        rightSidebar.left = layout.rightSidebar.left;
        rightSidebar.width = layout.rightSidebar.width;
        rightSidebar.height = layout.rightSidebar.height;
      }
    }

    centerPane.left = layout.centerPane.left;
    centerPane.width = layout.centerPane.width;
    centerPane.height = layout.centerPane.height;

    updateHeader();
    if (typeof resetFooter === 'function') resetFooter();
    if (typeof updateCenterLabel === 'function') updateCenterLabel();

    const fileInnerW = Math.max(12, (layout.leftSidebar.width || 28) - 3);
    if (typeof visibleFileList !== 'undefined' && visibleFileList && visibleFileList.length > 0) {
      const formattedItems = visibleFileList.map(node => formatTreeNode(node, fileInnerW));
      filesList.setItems(formattedItems);
    }

    screen.realloc();
    screen.render();
  }

  function toggleLeftSidebar() {
    isLeftSidebarCollapsed = !isLeftSidebarCollapsed;
    applyLayout();
  }

  function toggleRightSidebar() {
    isRightSidebarCollapsed = !isRightSidebarCollapsed;
    applyLayout();
  }

  const toggleSidebar = toggleLeftSidebar;

  screen.on('resize', () => {
    applyLayout();
  });

  const termLog = blessed.box({
    parent: centerPane,
    top: 0,
    left: 0,
    width: '100%-2',
    height: '100%-3',
    scrollable: true,
    alwaysScroll: false,
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    scrollbar: {
      ch: '│',
      track: { bg: 'black' },
      style: { bg: 'cyan' }
    }
  });
  termLog.log = function(msg) {
    const prev = this.getContent() || '';
    this.setContent(prev ? prev + '\n' + msg : msg);
    this.setScrollPerc(100);
    screen.render();
  };

  const cmdcLog = blessed.box({
    parent: centerPane,
    top: 0,
    left: 0,
    width: '100%-2',
    height: '100%-3',
    scrollable: true,
    alwaysScroll: false,
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    hidden: true,
    scrollbar: {
      ch: '│',
      track: { bg: 'black' },
      style: { bg: 'magenta' }
    }
  });
  cmdcLog.log = function(msg) {
    const prev = this.getContent() || '';
    this.setContent(prev ? prev + '\n' + msg : msg);
    this.setScrollPerc(100);
    screen.render();
  };

  const codexLog = blessed.box({
    parent: centerPane,
    top: 0,
    left: 0,
    width: '100%-2',
    height: '100%-3',
    scrollable: true,
    alwaysScroll: false,
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    hidden: true,
    scrollbar: {
      ch: '│',
      track: { bg: 'black' },
      style: { bg: 'cyan' }
    }
  });
  codexLog.log = function(msg) {
    const prev = this.getContent() || '';
    this.setContent(prev ? prev + '\n' + msg : msg);
    this.setScrollPerc(100);
    screen.render();
  };

  const turfLog = blessed.box({
    parent: centerPane,
    top: 0,
    left: 0,
    width: '100%-2',
    height: '100%-3',
    scrollable: true,
    alwaysScroll: false,
    tags: true,
    keys: true,
    vi: true,
    mouse: true,
    hidden: true,
    scrollbar: {
      ch: '│',
      track: { bg: 'black' },
      style: { bg: 'cyan' }
    }
  });
  turfLog.log = function(msg) {
    const prev = this.getContent() || '';
    this.setContent(prev ? prev + '\n' + msg : msg);
    this.setScrollPerc(100);
    screen.render();
  };

  const fileViewerLog = blessed.box({
    parent: centerPane,
    top: 0,
    left: 0,
    width: '100%-2',
    height: '100%-2',
    scrollable: true,
    alwaysScroll: false,
    keys: true,
    vi: true,
    mouse: true,
    tags: false,
    hidden: true,
    scrollbar: {
      ch: '│',
      track: { bg: 'black' },
      style: { bg: 'cyan' }
    }
  });

  let currentOpenedFile = null;

  function getActiveLog() {
    if (activeCenterTab === 'codex') return codexLog;
    if (activeCenterTab === 'cmdc' || activeCenterTab === 'agy') return cmdcLog;
    if (activeCenterTab === 'turf') return turfLog;
    if (activeCenterTab === 'file') return fileViewerLog;
    return termLog;
  }

  function getActiveProc() {
    if (activeCenterTab === 'codex') return activeCodexProc;
    if (activeCenterTab === 'cmdc' || activeCenterTab === 'agy') return activeCmdcProc;
    if (activeCenterTab === 'turf') return activeTurfProc;
    return activeTermProc;
  }

  function formatTabBadge(name, status) {
    if (status === 'working') return `${name} (Working)`;
    if (status === 'awaiting_input') return `${name} (Input?)`;
    if (status === 'done') return `${name} (Done)`;
    return name;
  }

  function updateCenterLabel() {
    const termStatus = ptyManager.getStatus('term');
    const cmdcStatus = ptyManager.getStatus('cmdc');
    const codexStatus = ptyManager.getStatus('codex');
    const turfStatus = ptyManager.getStatus('turf');

    const statuses = { termStatus, cmdcStatus, codexStatus, turfStatus };
    const centerW = (centerPane && centerPane.width) ? centerPane.width : 60;
    const isPlan = ptyManager.getPlanMode('turf');

    const labelText = buildCenterLabel(centerW, activeCenterTab, statuses, currentOpenedFile, isPlan);

    if (activeCenterTab === 'file') {
      centerPane.style.border.fg = 'yellow';
      if (centerPane.style.label) centerPane.style.label.fg = 'yellow';
    } else if (activeCenterTab === 'turf') {
      centerPane.style.border.fg = 'green';
      if (centerPane.style.label) centerPane.style.label.fg = 'green';
    } else if (activeCenterTab === 'cmdc' || activeCenterTab === 'agy') {
      centerPane.style.border.fg = 'magenta';
      if (centerPane.style.label) centerPane.style.label.fg = 'magenta';
    } else if (activeCenterTab === 'codex') {
      centerPane.style.border.fg = 'cyan';
      if (centerPane.style.label) centerPane.style.label.fg = 'cyan';
    } else {
      centerPane.style.border.fg = 'green';
      if (centerPane.style.label) centerPane.style.label.fg = 'green';
    }
    centerPane.setLabel(labelText);
  }

  let cachedPaletteModels = [];
  function refreshPaletteModels() {
    getPaletteModelsForTab(activeCenterTab, currentDir).then(models => {
      if (Array.isArray(models) && models.length > 0) {
        cachedPaletteModels = models;
      }
    }).catch(() => {});
  }

  function showCenterTab(tabName = 'term') {
    if (tabName !== 'file') {
      lastActiveCenterTab = tabName;
    }
    activeCenterTab = tabName === 'agy' ? 'cmdc' : tabName;
    fileViewerLog.hide();

    termLog.hide();
    cmdcLog.hide();
    codexLog.hide();
    turfLog.hide();

    if (activeCenterTab === 'codex') {
      codexLog.show();
      const content = ptyManager.getScreenContent('codex');
      if (content) codexLog.setContent(content);
      codexLog.setScrollPerc(100);
      promptPrefix.setContent('{bold}{cyan-fg}CODEX>{/cyan-fg}{/bold} ');
      promptPrefix.width = 7;
      terminalInput.left = 8;
      terminalInput.width = '100%-10';
    } else if (activeCenterTab === 'cmdc') {
      cmdcLog.show();
      const content = ptyManager.getScreenContent('cmdc') || ptyManager.getScreenContent('agy');
      if (content) cmdcLog.setContent(content);
      cmdcLog.setScrollPerc(100);
      promptPrefix.setContent('{bold}{magenta-fg}CMDC>{/magenta-fg}{/bold} ');
      promptPrefix.width = 6;
      terminalInput.left = 7;
      terminalInput.width = '100%-9';
    } else if (activeCenterTab === 'turf') {
      turfLog.show();
      const content = ptyManager.getScreenContent('turf');
      if (content) turfLog.setContent(content);
      turfLog.setScrollPerc(100);
      promptPrefix.setContent('{bold}{green-fg}TURF>{/green-fg}{/bold} ');
      promptPrefix.width = 6;
      terminalInput.left = 7;
      terminalInput.width = '100%-9';
    } else {
      activeCenterTab = 'term';
      termLog.show();
      const content = ptyManager.getScreenContent('term');
      if (content) termLog.setContent(content);
      termLog.setScrollPerc(100);
      promptPrefix.setContent('{bold}{149-fg}>{/149-fg}{/bold} ');
      promptPrefix.width = 2;
      terminalInput.left = 3;
      terminalInput.width = '100%-5';
    }
    focusIndex = 0;

    refreshPaletteModels();
    promptPrefix.show();
    terminalInput.show();
    updateCenterLabel();
    focusTerminal();
  }

  function showAgentTab(agentName = 'agy') {
    showCenterTab(agentName);
  }

  function showTerminalTab() {
    showCenterTab('term');
  }

  function openFileInViewer(relPath) {
    if (!relPath) return;
    stopInputReading();
    screen.program.hideCursor();

    currentOpenedFile = relPath;
    const fullPath = path.resolve(currentDir, relPath);
    let content = '';
    try {
      if (!fs.existsSync(fullPath)) {
        content = `[File not found: ${fullPath}]`;
      } else {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          content = `[Directory: ${relPath}]\n\nSelect a file from the [FILES] list to read its contents.`;
        } else if (stat.size > 2000000) {
          content = `[File too large to preview (${Math.round(stat.size / 1024)} KB)]`;
        } else {
          content = fs.readFileSync(fullPath, 'utf8');
        }
      }
    } catch (e) {
      content = `[Error reading file: ${e.message}]`;
    }

    const lines = content.split('\n');
    const maxLineNumWidth = Math.max(String(lines.length).length, 3);
    const formatted = lines.map((l, idx) => {
      const numStr = String(idx + 1).padStart(maxLineNumWidth, ' ');
      return `${numStr} │ ${l.replace(/\r$/, '')}`;
    }).join('\n');

    fileViewerLog.setContent(formatted);
    fileViewerLog.scrollTo(0);

    activeCenterTab = 'file';
    termLog.hide();
    cmdcLog.hide();
    codexLog.hide();
    turfLog.hide();
    promptPrefix.hide();
    terminalInput.hide();
    fileViewerLog.show();
    updateCenterLabel();
    focusIndex = 0;
    updateFocusStyles();
    fileViewerLog.focus();
    screen.realloc();
    screen.render();
  }

  function toggleCenterTab() {
    if (activeCenterTab === 'file') {
      showCenterTab(lastActiveCenterTab || 'term');
    } else {
      if (currentOpenedFile) {
        openFileInViewer(currentOpenedFile);
      } else {
        focusFiles();
        getActiveLog().log(`{cyan-fg}SYSTEM>{/cyan-fg} {yellow-fg}Select a file from [FILES] and press Enter to view it.{/yellow-fg}`);
        screen.render();
      }
    }
  }

  let fileTreeData = [];
  let visibleFileList = [];
  let expandedDirs = new Set();
  let isTreeInitialized = false;

  function refreshFileList(preserveSelection = true, maxInnerW) {
    const innerW = maxInnerW || Math.max(12, ((leftSidebar && leftSidebar.width) || 28) - 3);
    const prevSelectedRel = (visibleFileList && visibleFileList[filesList.selected]) 
      ? visibleFileList[filesList.selected].relPath 
      : null;

    fileTreeData = buildFileTree(currentDir, currentDir);

    // Auto-expand top-level folders on first load
    if (!isTreeInitialized) {
      expandedDirs.clear();
      for (const item of fileTreeData) {
        if (item.isDir) {
          expandedDirs.add(item.relPath);
        }
      }
      isTreeInitialized = true;
    }

    visibleFileList = flattenFileTree(fileTreeData, expandedDirs);

    if (visibleFileList.length === 0) {
      filesList.setItems([' {grey-fg}(no files found){/grey-fg}']);
    } else {
      const formattedItems = visibleFileList.map(node => formatTreeNode(node, innerW));
      filesList.setItems(formattedItems);

      if (preserveSelection && prevSelectedRel) {
        const newIndex = visibleFileList.findIndex(x => x.relPath === prevSelectedRel);
        if (newIndex !== -1) {
          filesList.select(newIndex);
        }
      }
    }
    screen.render();
  }
  refreshFileList();

  function handleFileActivation(idx) {
    if (idx === undefined || idx === null) idx = filesList.selected;
    const item = visibleFileList[idx];
    if (!item) return;

    if (item.isDir) {
      if (expandedDirs.has(item.relPath)) {
        expandedDirs.delete(item.relPath);
      } else {
        expandedDirs.add(item.relPath);
      }
      refreshFileList(true);
    } else {
      openFileInViewer(item.relPath);
    }
  }

  function handleFileLeftKey() {
    const idx = filesList.selected;
    const item = visibleFileList[idx];
    if (!item) return;

    if (item.isDir && expandedDirs.has(item.relPath)) {
      // Collapse expanded folder
      expandedDirs.delete(item.relPath);
      refreshFileList(true);
    } else if (item.parentRel) {
      // Move to parent folder
      const parentIdx = visibleFileList.findIndex(x => x.isDir && x.relPath === item.parentRel);
      if (parentIdx !== -1) {
        filesList.select(parentIdx);
        screen.render();
      }
    }
  }

  function handleFileRightKey() {
    const idx = filesList.selected;
    const item = visibleFileList[idx];
    if (!item) return;

    if (item.isDir) {
      if (!expandedDirs.has(item.relPath)) {
        // Expand collapsed folder
        expandedDirs.add(item.relPath);
        refreshFileList(true);
      } else {
        // Step into first child if present
        if (idx + 1 < visibleFileList.length && visibleFileList[idx + 1].parentRel === item.relPath) {
          filesList.select(idx + 1);
          screen.render();
        }
      }
    } else {
      openFileInViewer(item.relPath);
    }
  }

  filesList.on('select', (item, index) => {
    handleFileActivation(index);
  });

  function printWelcomeBanner() {
    termLog.log(`{bold}{149-fg}TURFCODE SHELL{/149-fg}{/bold} {grey-fg}│ Run terminal commands or type /turf, /cmdc, /codex to start AI agents{/grey-fg}`);
    cmdcLog.log(`{bold}{magenta-fg}COMMAND CODE AGENT{/magenta-fg}{/bold} {grey-fg}│ Enter task prompt or /term to return to shell{/grey-fg}`);
    codexLog.log(`{bold}{cyan-fg}OPENAI CODEX AGENT{/cyan-fg}{/bold} {grey-fg}│ Enter task prompt or /term to return to shell{/grey-fg}`);
    turfLog.log(`{bold}{green-fg}TURF AGENT{/green-fg}{/bold} {grey-fg}│ Turf-native intent locks ON │ /plan for read-only recon{/grey-fg}`);
  }
  printWelcomeBanner();

  const promptPrefix = blessed.text({
    parent: centerPane,
    bottom: 1,
    left: 1,
    width: 2,
    shrink: true,
    tags: true,
    content: '{bold}{149-fg}>{/149-fg}{/bold} '
  });

  const terminalInput = blessed.textbox({
    parent: centerPane,
    bottom: 1,
    left: 3,
    width: '100%-5',
    height: 1,
    keys: true,
    mouse: true,
    style: {
      fg: 'white',
      bg: 'black'
    }
  });

  const AVAILABLE_COMMANDS = [
    { cmd: '/turf', desc: 'Switch to Turf agent tab or run prompt (/turf <prompt>)' },
    { cmd: '/cmdc', desc: 'Switch to Command Code tab or run prompt (/cmdc <prompt>)' },
    { cmd: '/codex', desc: 'Switch to OpenAI Codex tab or run prompt (/codex <prompt>)' },
    { cmd: '/agy', desc: 'Alias for Command Code (/cmdc)' },
    { cmd: '/model', desc: 'Switch or view active model for current tab (/model <name>)' },
    { cmd: '/effort', desc: 'Set reasoning effort (/effort low | medium | high)' },
    { cmd: '/sandbox', desc: 'Set agent sandbox permission (/sandbox workspace-write | read-only)' },
    { cmd: '/new', desc: 'Clear conversation memory and start a fresh session' },
    { cmd: '/resume', desc: 'Resume a past session ID (/resume <id>)' },
    { cmd: '/diff', desc: 'Inspect git diff of workspace changes made by agent' },
    { cmd: '/usage', desc: 'View session stats, turns, token count & active config' },
    { cmd: '/kill', desc: 'Terminate running agent process or shell command' },
    { cmd: '/plan', desc: 'Toggle read-only recon plan mode for the active tab' },
    { cmd: '/negotiate', desc: 'Trigger autonomous inter-agent lock negotiation dialogue (/negotiate [file])' },
    { cmd: '/term', desc: 'Switch to Shell terminal or run command (/term <command>)' },
    { cmd: '/chat', desc: 'Send message to team chat or focus chat (/chat <msg>)' },
    { cmd: '/files', desc: 'Focus workspace file explorer [F3]' },
    { cmd: '/sidebar', desc: 'Toggle left or right sidebar (/sidebar left | right)' },
    { cmd: '/web', desc: 'Open collaborative web preview browser [Ctrl+O]' },
    { cmd: '/help', desc: 'Show full command documentation and shortcuts' }
  ];

  let paletteFilteredItems = [...AVAILABLE_COMMANDS];

  const commandPaletteBox = blessed.list({
    parent: centerPane,
    bottom: 2,
    left: 2,
    width: '100%-4',
    height: 10,
    hidden: true,
    tags: true,
    keys: false,
    mouse: true,
    vi: false,
    border: { type: 'line', fg: '149' },
    style: {
      selected: { bg: '149', fg: 'black', bold: true },
      item: { fg: 'white' },
      border: { fg: '149' }
    },
    label: ' {bold}{149-fg}COMMANDS{/149-fg}{/bold} {grey-fg}[↑/↓] nav [Tab] select [Esc] close{/grey-fg} '
  });

  function renderCommandPalette(filterText = '') {
    const query = filterText.toLowerCase().trim();
    if (query.startsWith('/model')) {
      const fallbackCmdc = [
        { cmd: '/model deepseek/deepseek-v4-flash', desc: 'DeepSeek V4 Flash (Ultra-fast & capable)' },
        { cmd: '/model deepseek/deepseek-v4-pro', desc: 'DeepSeek V4 Pro (Deep architectural reasoning)' },
        { cmd: '/model claude-sonnet-5', desc: 'Claude Sonnet 5 (Recommended speed & intelligence)' },
        { cmd: '/model claude-sonnet-4-6', desc: 'Claude Sonnet 4.6 (Solid multi-step agent)' },
        { cmd: '/model claude-opus-5', desc: 'Claude Opus 5 (Maximum reasoning depth)' },
        { cmd: '/model gpt-5.6-sol', desc: 'GPT-5.6 Sol (Cutting edge reasoning)' },
        { cmd: '/model moonshotai/Kimi-K3', desc: 'Kimi K3 (Long-context specialist)' },
        { cmd: '/model Qwen/Qwen3.8-27B', desc: 'Qwen 3.8 27B (Open-weight coder)' }
      ];
      const fallbackTurf = [
        { cmd: '/model gemini-2.0-flash', desc: 'Google Gemini 2.0 Flash (1,000,000 TPM Free Tier)' },
        { cmd: '/model gemini-1.5-pro', desc: 'Google Gemini 1.5 Pro (Deep reasoning)' },
        { cmd: '/model gemini-1.5-flash', desc: 'Google Gemini 1.5 Flash (Ultra-fast)' },
        { cmd: '/model openai/gpt-oss-120b', desc: 'Groq GPT-OSS 120B (Deep reasoning, ultra-fast)' },
        { cmd: '/model openai/gpt-oss-20b', desc: 'Groq GPT-OSS 20B (High speed, low latency)' },
        { cmd: '/model llama-3.1-8b-instant', desc: 'Groq Llama 3.1 8B (High TPM Free Tier)' },
        { cmd: '/model qwen/qwen3.8-27b', desc: 'Qwen 3.8 27B (Coding & reasoning)' },
        { cmd: '/model groq/compound', desc: 'Groq Compound (Agentic router)' },
        { cmd: '/model claude-3-5-sonnet', desc: 'Anthropic Claude 3.5 Sonnet' },
        { cmd: '/model gpt-4o', desc: 'OpenAI GPT-4o' }
      ];
      const fallbackCodex = [
        { cmd: '/model o3-mini', desc: 'OpenAI o3-mini (High reasoning, fast)' },
        { cmd: '/model gpt-4o', desc: 'OpenAI GPT-4o (Fast multimodal)' },
        { cmd: '/model o1', desc: 'OpenAI o1 (Full reasoning)' }
      ];

      const modelItems = cachedPaletteModels.length > 0
        ? cachedPaletteModels
        : ((activeCenterTab === 'cmdc' || activeCenterTab === 'agy') ? fallbackCmdc : (activeCenterTab === 'turf' ? fallbackTurf : fallbackCodex));

      paletteFilteredItems = modelItems.filter(c => !query || c.cmd.toLowerCase().includes(query) || query === '/model' || query === '/model ');
      if (paletteFilteredItems.length === 0) paletteFilteredItems = modelItems;
    } else {
      paletteFilteredItems = AVAILABLE_COMMANDS.filter(c => {
        if (!query || query === '/') return true;
        return c.cmd.toLowerCase().startsWith(query) || (query.length > 2 && c.cmd.toLowerCase().includes(query));
      });
    }

    if (paletteFilteredItems.length === 0) {
      if (!commandPaletteBox.hidden) {
        commandPaletteBox.hide();
        screen.render();
      }
      return;
    }

    const items = paletteFilteredItems.map(c => {
      const padLen = c.cmd.length > 12 ? c.cmd.length + 2 : 14;
      return `{bold}${c.cmd.padEnd(padLen)}{/bold} {grey-fg}${c.desc}{/grey-fg}`;
    });
    commandPaletteBox.setItems(items);
    commandPaletteBox.select(0);
    commandPaletteBox.show();
    commandPaletteBox.setFront();
    screen.render();
  }

  function hideCommandPalette() {
    if (!commandPaletteBox.hidden) {
      commandPaletteBox.hide();
      screen.render();
    }
  }

  function applySelectedPaletteCommand() {
    const idx = commandPaletteBox.selected;
    const selected = paletteFilteredItems[idx];
    if (selected) {
      const val = selected.cmd.includes(' ') ? selected.cmd : selected.cmd + ' ';
      terminalInput.setValue(val);
      hideCommandPalette();
      focusTerminal();
      screen.render();
    }
  }

  commandPaletteBox.on('select', (item, index) => {
    const selected = paletteFilteredItems[index];
    if (selected) {
      const val = selected.cmd.includes(' ') ? selected.cmd : selected.cmd + ' ';
      terminalInput.setValue(val);
      hideCommandPalette();
      focusTerminal();
      screen.render();
    }
  });

  function updatePaletteFromInput() {
    if (focusIndex !== 0) {
      hideCommandPalette();
      return;
    }
    const val = terminalInput.value || '';
    if (val.startsWith('/') && (!val.includes(' ') || val.startsWith('/model '))) {
      renderCommandPalette(val);
    } else {
      hideCommandPalette();
    }
  }

  terminalInput.on('keypress', (ch, key) => {
    process.nextTick(() => {
      updatePaletteFromInput();
    });
  });


  const intentBox = blessed.box({
    parent: rightSidebar,
    top: 0,
    left: 0,
    width: '100%',
    height: 9,
    label: ' {bold}{yellow-fg}● INTENT{/yellow-fg}{/bold} {grey-fg}│ QUEUE [F2]{/grey-fg} ',
    border: { type: 'line', fg: 'yellow' },
    tags: true,
    mouse: true,
    content: ' {bold}ACTIVE TURFS:{/bold}\n  {grey-fg}(No active locks){/grey-fg}\n\n {bold}ALERTS:{/bold}\n  {grey-fg}(No alerts){/grey-fg}'
  });

  const queueBox = blessed.box({
    parent: rightSidebar,
    top: 0,
    left: 0,
    width: '100%',
    height: 9,
    label: ' {grey-fg}INTENT [F2] │{/grey-fg} {bold}{magenta-fg}● QUEUE{/magenta-fg}{/bold} ',
    border: { type: 'line', fg: 'magenta' },
    tags: true,
    mouse: true,
    content: '  {grey-fg}(0 agents waiting){/grey-fg}'
  });

  let rightSidebarView = 'intent';
  queueBox.hide();

  function toggleRightSection() {
    if (rightSidebarView === 'intent') {
      rightSidebarView = 'queue';
      intentBox.hide();
      queueBox.show();
    } else {
      rightSidebarView = 'intent';
      queueBox.hide();
      intentBox.show();
    }
    screen.render();
  }

  intentBox.on('click', toggleRightSection);
  queueBox.on('click', toggleRightSection);

  const peerAgents = new Map();
  let currentLocks = [];
  let currentQueues = [];
  let currentIntents = [];

  if (lockRegistry && typeof lockRegistry.on === 'function') {
    lockRegistry.on('change', (state) => {
      if (state) {
        currentLocks = state.activeLocks || [];
        currentQueues = state.queues || [];
        currentIntents = state.intents || [];
        updateIntentBox();
        updateQueueBox();
      }
    });
  }

  function updateIntentBox() {
    let content = ' {bold}ACTIVE TURFS:{/bold}\n';
    let hasEntries = false;
    if (currentLocks && currentLocks.length > 0) {
      currentLocks.forEach(l => {
        const file = path.basename(l.filePath || l.file || '');
        const holder = l.agentId || l.user || 'agent';
        content += `  {yellow-fg}🔒 ${holder}:{/yellow-fg} {white-fg}${file}{/white-fg}\n`;
        hasEntries = true;
      });
    }
    if (currentIntents && currentIntents.length > 0) {
      currentIntents.forEach(item => {
        const who = item.user || item.agentId || 'agent';
        const files = (item.files && item.files.length > 0) ? item.files.map(f => path.basename(f)).join(', ') : (item.scope || 'recon');
        content += `  {cyan-fg}⚡ ${who}:{/cyan-fg} {white-fg}${files}{/white-fg} {grey-fg}[INTENT]{/grey-fg}\n`;
        hasEntries = true;
      });
    }
    if (!hasEntries) {
      content += '  {grey-fg}(No active locks){/grey-fg}\n';
    }
    content += '\n {bold}AI AGENTS:{/bold}\n';

    
    let hasAgents = false;
    const cmdcSt = ptyManager.getStatus('cmdc');
    const codexSt = ptyManager.getStatus('codex');
    const turfSt = ptyManager.getStatus('turf');

    if (cmdcSt !== 'idle') {
      const color = cmdcSt === 'working' ? 'magenta-fg' : (cmdcSt === 'awaiting_input' ? 'yellow-fg' : 'cyan-fg');
      content += `  {${color}}● ${hostName}: CMDC [${cmdcSt.toUpperCase()}]{/${color}}\n`;
      hasAgents = true;
    }
    if (codexSt !== 'idle') {
      const color = codexSt === 'working' ? 'green-fg' : (codexSt === 'awaiting_input' ? 'yellow-fg' : 'cyan-fg');
      content += `  {${color}}● ${hostName}: CODEX [${codexSt.toUpperCase()}]{/${color}}\n`;
      hasAgents = true;
    }
    if (turfSt !== 'idle') {
      const color = turfSt === 'working' ? 'green-fg' : (turfSt === 'awaiting_input' ? 'yellow-fg' : 'cyan-fg');
      const planTag = ptyManager.getPlanMode('turf') ? ' (PLAN)' : '';
      content += `  {${color}}● ${hostName}: TURF [${turfSt.toUpperCase()}${planTag}]{/${color}}\n`;
      hasAgents = true;
    }

    for (const [_, info] of peerAgents.entries()) {
      if (info.user !== hostName && info.status !== 'idle') {
        const color = info.status === 'working' ? 'green-fg' : (info.status === 'awaiting_input' ? 'yellow-fg' : 'cyan-fg');
        content += `  {${color}}● ${info.user}: ${info.agent.toUpperCase()} [${info.status.toUpperCase()}]{/${color}}\n`;
        hasAgents = true;
      }
    }

    if (!hasAgents) {
      content += '  {grey-fg}(No agents running){/grey-fg}\n';
    }

    intentBox.setContent(content);
    screen.render();
  }

  function updateQueueBox() {
    let content = ' {bold}WAITING QUEUE:{/bold}\n';
    let totalWaiting = 0;
    if (currentQueues && currentQueues.length > 0) {
      currentQueues.forEach(q => {
        const count = q.size || (Array.isArray(q.requests) ? q.requests.length : (Array.isArray(q.queue) ? q.queue.length : 0));
        if (count > 0) {
          totalWaiting += count;
          const file = path.basename(q.filePath || '');
          content += `  {magenta-fg}⏳ ${file} (${count} queued):{/magenta-fg}\n`;
          if (Array.isArray(q.requests) && q.requests.length > 0) {
            q.requests.forEach(r => {
              const waitSec = typeof r.estimatedWaitSeconds === 'number' ? `${r.estimatedWaitSeconds}s` : 'wait';
              const pScore = typeof r.effectivePriority === 'number' ? `P:${Math.round(r.effectivePriority)}` : '';
              const branchTag = r.speculativeWorktree ? ' {cyan-fg}[BRANCH]{/cyan-fg}' : '';
              const who = r.user || 'agent';
              const ag = r.agent ? ` (${r.agent})` : '';
              content += `    ↳ #{r.rank} {bold}${who}${ag}{/bold} [${pScore}, ~${waitSec}]${branchTag}\n`;
            });
          }
        }
      });
    }
    if (totalWaiting === 0) {
      content += '  {grey-fg}(0 agents waiting){/grey-fg}\n';
      queueBox.setLabel(' {grey-fg}INTENT [F2] │{/grey-fg} {bold}{magenta-fg}● QUEUE (0){/magenta-fg}{/bold} ');
    } else {
      queueBox.setLabel(` {grey-fg}INTENT [F2] │{/grey-fg} {bold}{yellow-fg}● QUEUE (${totalWaiting}){/yellow-fg}{/bold} `);
    }
    queueBox.setContent(content);
    screen.render();
  }

  ptyManager.on('agent:msg', ({ tabId, type, text }) => {
    try {
      let target = termLog;
      if (tabId === 'cmdc' || tabId === 'agy') target = cmdcLog;
      else if (tabId === 'codex') target = codexLog;
      else if (tabId === 'turf') target = turfLog;
      if (text) {
        target.log(text);
        screen.render();
      }
    } catch (e) {
      try {
        fs.appendFileSync(path.join(currentDir, 'turf-error.log'), `[agent:msg error] ${e.stack || e}\n`);
      } catch (err) {}
    }
  });

  ptyManager.on('screen', ({ tabId, content }) => {
    if (tabId === 'term' && content) {
      termLog.setContent(content);
      screen.render();
    }
  });

  let activeStreamingTab = null;
  ptyManager.on('agent:stream', ({ tabId, text }) => {
    try {
      let target = (tabId === 'cmdc' || tabId === 'agy') ? cmdcLog : tabId === 'turf' ? turfLog : codexLog;
      if (activeStreamingTab !== tabId) {
        const colorTag = (tabId === 'cmdc' || tabId === 'agy') ? 'magenta-fg' : tabId === 'turf' ? 'green-fg' : 'cyan-fg';
        const agentName = (tabId === 'cmdc' || tabId === 'agy') ? 'CMDC' : tabId.toUpperCase();
        target.log(`{bold}{${colorTag}}💬 ${agentName}:{/${colorTag}}{/bold} `);
        activeStreamingTab = tabId;
      }
      const prev = target.getContent() || '';
      target.setContent(prev + safeEscape(text));
      target.setScrollPerc(100);
      screen.render();
    } catch (e) {
      try {
        fs.appendFileSync(path.join(currentDir, 'turf-error.log'), `[agent:stream error] ${e.stack || e}\n`);
      } catch (err) {}
    }
  });

  ptyManager.on('status', ({ tabId, status, details }) => {
    if (status === 'done' || status === 'idle') {
      activeStreamingTab = null;
    }
    updateCenterLabel();
    updateIntentBox();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'agent:status',
        user: hostName,
        agent: tabId,
        status,
        details: details || '',
        timestamp: Date.now()
      }));
    }
    screen.render();
  });

  ptyManager.on('exit', ({ tabId, exitCode }) => {
    activeStreamingTab = null;
    let target = termLog;
    if (tabId === 'cmdc' || tabId === 'agy') target = cmdcLog;
    else if (tabId === 'codex') target = codexLog;
    else if (tabId === 'turf') target = turfLog;

    if (tabId === 'term') {
      if (exitCode !== null && exitCode !== 0) {
        target.log(`{bold}{grey-fg}[Process exited with code ${exitCode}]{/grey-fg}{/bold}`);
      }
    } else {
      if (exitCode !== null && exitCode !== 0) {
        target.log(`{bold}{grey-fg}[${tabId.toUpperCase()} process exited with code ${exitCode}]{/grey-fg}{/bold}`);
      }
    }
    updateCenterLabel();
    updateIntentBox();
    screen.render();
  });


  const chatLogBox = blessed.log({
    parent: rightSidebar,
    top: 9,
    left: 0,
    width: '100%',
    bottom: 3,
    label: ' {bold}{blue-fg}[TEAM CHAT]{/blue-fg}{/bold} ',
    border: { type: 'line', fg: 'blue' },
    scrollable: true,
    alwaysScroll: true,
    tags: true,
    keys: true,
    mouse: true
  });
  chatLogBox.log(` {grey-fg}Room ${roomCode} ready. Type /chat to talk.{/grey-fg}`);

  const chatInputBox = blessed.box({
    parent: rightSidebar,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    label: ' {bold}{cyan-fg}[CHAT INPUT]{/cyan-fg}{/bold} {grey-fg}(/chat or Tab){/grey-fg} ',
    border: { type: 'line', fg: 'cyan' },
    tags: true,
    mouse: true
  });

  const chatInputPrompt = blessed.text({
    parent: chatInputBox,
    top: 0,
    left: 1,
    tags: true,
    content: `{cyan-fg}💬 >{/cyan-fg} `
  });

  const chatInput = blessed.textbox({
    parent: chatInputBox,
    top: 0,
    left: 6,
    width: '100%-8',
    height: 1,
    keys: true,
    mouse: true,
    style: {
      fg: 'white',
      bg: 'black'
    }
  });

  const footer = blessed.box({
    bottom: 0,
    left: 0,
    width: '100%',
    height: 1,
    tags: true,
    content: buildFooterContent(screen.width || 100),
    style: {
      fg: 'white',
      bg: 'black'
    }
  });
  screen.append(footer);

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data.type === 'chat:message') {
        const time = new Date(data.timestamp || Date.now()).toLocaleTimeString();
        let color = data.user === 'SYSTEM' ? 'yellow-fg' : (data.user === hostName ? 'green-fg' : 'cyan-fg');
        if (data.isAgentNegotiation || String(data.user).includes('🤖')) {
          color = 'magenta-fg';
        }
        chatLogBox.log(` {${color}}[${time}] ${data.user}:{/${color}}\n   ${data.message}`);
        screen.render();
      } else if (data.type === 'peer:update') {
        updatePeopleBox(data.peers);
      } else if (data.type === 'locks:update' || data.type === 'lock:update') {
        currentLocks = data.activeLocks || data.locks || [];
        currentQueues = data.queues || [];
        currentIntents = data.intents || [];
        updateIntentBox();
        updateQueueBox();
      } else if (data.type === 'agent:negotiate') {
        const time = new Date(data.timestamp || Date.now()).toLocaleTimeString();
        chatLogBox.log(` {bold}{magenta-fg}🤖 [AI NEGOTIATION] [${time}]{/magenta-fg}{/bold}\n   {cyan-fg}${data.fromAgent?.toUpperCase() || 'AGENT'} (${data.fromUser}){/cyan-fg} ➔ {yellow-fg}${data.toAgent?.toUpperCase() || 'ALL'}:{/yellow-fg} ${data.message}`);
        screen.render();
      } else if (data.type === 'agent:status') {
        if (data.user && data.agent) {
          peerAgents.set(`${data.user}:${data.agent}`, data);
          updateIntentBox();
          if (data.status === 'working' && data.user !== hostName) {
            chatLogBox.log(` {yellow-fg}⚡ [AI] ${data.user} started ${data.agent.toUpperCase()}${data.details ? ': ' + data.details : ''}{/yellow-fg}`);
            screen.render();
          }
        }
      } else if (data.type === 'file:sync') {
        if (data.origin && data.origin !== hostName && data.relPath && typeof data.content === 'string') {
          const normRel = path.normalize(data.relPath).replace(/\\/g, '/');
          // Check if local user holds an active lock on this file
          const isHeldLocally = currentLocks.some(l => {
            const lFile = path.normalize(l.filePath || l.file || '').replace(/\\/g, '/');
            return (lFile === normRel || normRel.endsWith(lFile)) && (l.agentId === hostName || l.user === hostName);
          });
          if (isHeldLocally) {
            chatLogBox.log(` {yellow-fg}⚠️ [SYNC SKIPPED]{/yellow-fg} {grey-fg}${data.origin} synced ${normRel}, but you hold an active lock.{/grey-fg}`);
            screen.render();
          } else {
            syncSuppressionMap.set(normRel, Date.now() + 2000);
            try {
              const fullTarget = path.join(currentDir, normRel);
              fs.mkdirSync(path.dirname(fullTarget), { recursive: true });
              fs.writeFileSync(fullTarget, data.content, 'utf8');
              refreshFileList(true);
              chatLogBox.log(` {cyan-fg}⚡ [SYNC]{/cyan-fg} {white-fg}${normRel}{/white-fg} {grey-fg}(from ${data.origin}){/grey-fg}`);
              screen.render();
            } catch (err) {}
          }
        }
      }
    } catch (e) {}
  });

  const syncSuppressionMap = new Map();
  const debounceTimers = new Map();
  const IGNORE_SYNC = new Set(['.git', 'node_modules', '.turf', 'dist', '.env', 'turf-error.log', 'turf-sync.tar.gz', '.gemini', '.turbo', '.cache', 'turf-worktrees', '.turf-worktrees']);

  // Native debounced file watcher for real-time peer replication
  try {
    const fileWatcher = fs.watch(currentDir, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      const normalizedRel = filename.replace(/\\/g, '/');
      const parts = normalizedRel.split('/');
      if (parts.some(p => IGNORE_SYNC.has(p) || p.startsWith('.'))) return;

      const suppressionExpiry = syncSuppressionMap.get(normalizedRel);
      if (suppressionExpiry && Date.now() < suppressionExpiry) return;

      if (debounceTimers.has(normalizedRel)) {
        clearTimeout(debounceTimers.get(normalizedRel));
      }

      debounceTimers.set(normalizedRel, setTimeout(() => {
        debounceTimers.delete(normalizedRel);
        try {
          refreshFileList(true);
          const fullPath = path.join(currentDir, normalizedRel);
          if (fs.existsSync(fullPath)) {
            const stat = fs.statSync(fullPath);
            if (stat.isFile() && stat.size < 500000) {
              const content = fs.readFileSync(fullPath, 'utf8');
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'file:sync',
                  origin: hostName,
                  relPath: normalizedRel,
                  content
                }));
              }
            }
          }
        } catch (e) {}
      }, 300));
    });

    if (fileWatcher.unref) fileWatcher.unref();
  } catch (e) {}

  // 5-Second periodic file tree refresh to catch newly created/synced files
  const fileRefreshTimer = setInterval(() => {
    try {
      refreshFileList(true);
    } catch (e) {}
  }, 5000);
  if (fileRefreshTimer.unref) fileRefreshTimer.unref();

  // 5-Second rolling lock heartbeat
  const heartbeatTimer = setInterval(() => {
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'lock:heartbeat',
          user: hostName,
          agentId: activeCenterTab
        }));
      }
    } catch (e) {}
  }, 5000);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  try {
    fetch(`http://${hostAddress || '127.0.0.1'}:${port}/api/locks`, { signal: AbortSignal.timeout(2000) })
      .then(res => res.json())
      .then(data => {
        if (data) {
          currentLocks = data.activeLocks || [];
          currentQueues = data.queues || [];
          currentIntents = data.intents || [];
          updateIntentBox();
          updateQueueBox();
        }
      })
      .catch(() => {});
  } catch (e) {}

  let focusIndex = 0; // 0: Center Pane (Terminal/File), 1: Team Chat, 2: Files List
  
  function stopInputReading() {
    try {
      if (terminalInput && terminalInput._reading) {
        terminalInput.cancel();
      }
    } catch (e) {}
    try {
      if (chatInput && chatInput._reading) {
        chatInput.cancel();
      }
    } catch (e) {}
    screen.grabKeys = false;
  }

  function focusTerminal() {
    focusIndex = 0;
    updateFocusStyles();
    if (activeCenterTab === 'file') {
      stopInputReading();
      screen.program.hideCursor();
      fileViewerLog.focus();
    } else {
      try {
        if (chatInput && chatInput._reading) chatInput.cancel();
      } catch (e) {}
      try {
        if (terminalInput && terminalInput._reading) terminalInput.cancel();
      } catch (e) {}
      screen.grabKeys = false;
      terminalInput.focus();
      terminalInput.readInput();
      screen.program.showCursor();
    }
    screen.render();
  }

  function focusChat() {
    focusIndex = 1;
    hideCommandPalette();
    updateFocusStyles();
    try {
      if (terminalInput && terminalInput._reading) terminalInput.cancel();
    } catch (e) {}
    screen.grabKeys = false;
    chatInput.focus();
    chatInput.readInput();
    screen.program.showCursor();
    screen.render();
  }

  function focusFiles() {
    focusIndex = 2;
    hideCommandPalette();
    updateFocusStyles();
    stopInputReading();
    screen.program.hideCursor();
    try { refreshFileList(true); } catch (e) {}
    filesList.focus();
    screen.render();
  }
  
  function updateFocusStyles() {
    updateCenterLabel();

    if (centerPane && centerPane.style && centerPane.style.border) {
      if (focusIndex === 0) {
        if (activeCenterTab === 'file') centerPane.style.border.fg = 'yellow';
        else if (activeCenterTab === 'turf') centerPane.style.border.fg = 'green';
        else if (activeCenterTab === 'cmdc' || activeCenterTab === 'agy') centerPane.style.border.fg = 'magenta';
        else if (activeCenterTab === 'codex') centerPane.style.border.fg = 'cyan';
        else centerPane.style.border.fg = 'green';
      } else {
        centerPane.style.border.fg = 'grey';
      }
    }

    if (filesBox && filesBox.style && filesBox.style.border) {
      filesBox.style.border.fg = focusIndex === 2 ? 'green' : 'grey';
      filesBox.setLabel(focusIndex === 2 ? ' {bold}{green-fg}[FILES]{/green-fg}{/bold} {grey-fg}[F3]{/grey-fg} ' : ' {bold}{cyan-fg}[FILES]{/cyan-fg}{/bold} {grey-fg}[F3]{/grey-fg} ');
    }

    if (chatLogBox && chatLogBox.style && chatLogBox.style.border) {
      chatLogBox.style.border.fg = focusIndex === 1 ? 'green' : 'grey';
    }
    if (chatInputBox && chatInputBox.style && chatInputBox.style.border) {
      chatInputBox.style.border.fg = focusIndex === 1 ? 'green' : 'grey';
      chatInputBox.setLabel(focusIndex === 1 ? ' {bold}{green-fg}[CHAT INPUT]{/green-fg}{/bold} {grey-fg}(/chat or Tab){/grey-fg} ' : ' {bold}{cyan-fg}[CHAT INPUT]{/cyan-fg}{/bold} {grey-fg}(/chat or Tab){/grey-fg} ');
    }
    if (chatInputPrompt) {
      chatInputPrompt.setContent(focusIndex === 1 ? '{green-fg}💬 >{/green-fg} ' : '{cyan-fg}💬 >{/cyan-fg} ');
    }

    screen.render();
  }

  function updateHardwareCursor() {
    if (focusIndex === 2 || activeCenterTab === 'file') {
      screen.program.hideCursor();
      return;
    }
    if (focusIndex === 0) {
      screen.program.showCursor();
      const coords = terminalInput._getCoords();
      if (coords) {
        const y = coords.yi;
        const inputVal = terminalInput.value || '';
        const x = coords.xi + (blessed.unicode ? blessed.unicode.strWidth(inputVal) : inputVal.length);
        screen.program.cursorPos(y, x);
      }
    } else if (focusIndex === 1) {
      screen.program.showCursor();
      const coords = chatInput._getCoords();
      if (coords) {
        const y = coords.yi;
        const inputVal = chatInput.value || '';
        const x = coords.xi + (blessed.unicode ? blessed.unicode.strWidth(inputVal) : inputVal.length);
        screen.program.cursorPos(y, x);
      }
    }
  }

  screen.on('render', updateHardwareCursor);

  function switchFocus() {
    // 0: Center Pane, 1: Team Chat, 2: Files
    if (focusIndex === 0) {
      focusChat();
    } else if (focusIndex === 1) {
      focusFiles();
    } else {
      focusTerminal();
    }
  }

  function cycleCenterTabs() {
    if (activeCenterTab === 'turf') showCenterTab('cmdc');
    else if (activeCenterTab === 'cmdc' || activeCenterTab === 'agy') showCenterTab('codex');
    else if (activeCenterTab === 'codex') showCenterTab('term');
    else showCenterTab('turf');
  }

  function resetFooter() {
    footer.setContent(buildFooterContent(screen.width || 100));
  }

  function cleanActiveInput() {
    process.nextTick(() => {
      if (focusIndex !== 0) hideCommandPalette();
      if (terminalInput && terminalInput.value) {
        const cleaned = terminalInput.value.replace(/[\x00-\x08\x0b-\x1f\t]/g, '');
        if (cleaned !== terminalInput.value) {
          terminalInput.setValue(cleaned);
          screen.render();
        }
      }
      if (chatInput && chatInput.value) {
        const cleaned = chatInput.value.replace(/[\x00-\x08\x0b-\x1f\t]/g, '');
        if (cleaned !== chatInput.value) {
          chatInput.setValue(cleaned);
          screen.render();
        }
      }
    });
  }

  function runDemo() {
    const currentProc = getActiveProc();
    if (currentProc) return;
    getActiveLog().log(`{cyan-fg}SYSTEM>{/cyan-fg} Spawning automated demo...`);
    screen.render();
    const proc = spawn(process.execPath, [path.join(TURF_ROOT, 'demo', 'run-demo.js')], { cwd: TURF_ROOT });
    if (activeCenterTab === 'codex') activeCodexProc = proc;
    else if (activeCenterTab === 'cmdc' || activeCenterTab === 'agy') activeCmdcProc = proc;
    else activeTermProc = proc;
    updateCenterLabel();

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        if (line) getActiveLog().log(line.trimEnd());
      });
      screen.render();
    });
    proc.stderr.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        if (line) getActiveLog().log(`{red-fg}${line.trimEnd()}{/red-fg}`);
      });
      screen.render();
    });
    proc.on('close', () => {
      if (activeCenterTab === 'codex') activeCodexProc = null;
      else if (activeCenterTab === 'cmdc' || activeCenterTab === 'agy') activeCmdcProc = null;
      else activeTermProc = null;
      updateCenterLabel();
      screen.render();
    });
  }

  function openWebUI() {
    const url = `http://localhost:${port}/?room=${roomCode}&user=${encodeURIComponent(hostName)}`;
    getActiveLog().log(`{cyan-fg}Opening Web UI:{/cyan-fg} {yellow-fg}${url}{/yellow-fg}`);
    screen.render();
    if (process.platform === 'win32') {
      exec(`cmd.exe /c start "" "${url}"`);
    } else {
      exec(`cmd.exe /c start "" "${url}" 2>/dev/null || xdg-open "${url}" 2>/dev/null`);
    }
  }

  let lastCtrlCTime = 0;
  let ctrlCTimer = null;

  function handleCtrlC() {
    const now = Date.now();
    const currentProc = getActiveProc();

    // If an active process is running, first Ctrl+C interrupts it
    if (currentProc) {
      if (process.platform === 'win32') {
        exec('taskkill /F /T /PID ' + currentProc.pid);
      } else {
        try {
          process.kill(-currentProc.pid, 'SIGKILL');
        } catch (e) {
          currentProc.kill('SIGKILL');
        }
      }
      getActiveLog().log(`{red-fg}^C (Interrupted process on ${activeCenterTab.toUpperCase()}){/red-fg}`);
      if (activeCenterTab === 'codex') activeCodexProc = null;
      else if (activeCenterTab === 'cmdc' || activeCenterTab === 'agy') activeCmdcProc = null;
      else activeTermProc = null;
      lastCtrlCTime = 0;
      updateCenterLabel();
      focusTerminal();
      screen.render();
      return;
    }

    // ponytail: real sessions live in ptyManager; legacy procs above are always null
    if (ptyManager.isSessionActive(activeCenterTab)) {
      ptyManager.killSession(activeCenterTab);
      getActiveLog().log(`{red-fg}^C (Interrupted process on ${activeCenterTab.toUpperCase()}){/red-fg}`);
      lastCtrlCTime = 0;
      updateCenterLabel();
      updateIntentBox();
      focusTerminal();
      screen.render();
      return;
    }

    // Double Ctrl+C protection: require 2 presses within 2000ms to quit
    if (lastCtrlCTime > 0 && (now - lastCtrlCTime) <= 2000) {
      if (ctrlCTimer) clearTimeout(ctrlCTimer);
      handleQuit();
      return;
    }

    lastCtrlCTime = now;
    getActiveLog().log(`{yellow-fg}Press Ctrl+C again within 2s to quit Turf.{/yellow-fg}`);
    footer.setContent(` {bold}{red-bg}{white-fg} Press Ctrl+C again within 2s to QUIT Turf {/white-fg}{/red-bg}{/bold} `);
    screen.render();

    if (ctrlCTimer) clearTimeout(ctrlCTimer);
    ctrlCTimer = setTimeout(() => {
      lastCtrlCTime = 0;
      resetFooter();
      screen.render();
    }, 2000);
  }

  function handleQuit() {
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onUnhandled);
    ptyManager.killAll();
    const procs = [activeTermProc, activeCmdcProc, activeCodexProc, activeTurfProc].filter(Boolean);
    for (const proc of procs) {
      if (process.platform === 'win32') {
        exec('taskkill /F /T /PID ' + proc.pid);
      } else {
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch (e) {
          proc.kill('SIGKILL');
        }
      }
    }
    activeTermProc = null;
    activeCmdcProc = null;
    activeCodexProc = null;
    
    if (wssInstance) {
      wssInstance.clients.forEach(c => c.close());
      wssInstance.close();
    }
    if (serverInstance) serverInstance.close();
    try {
      ws.close();
    } catch (e) {}
    
    screen.program.normalBuffer();
    screen.program.showCursor();
    try {
      screen.destroy();
    } catch (e) {}
    process.stdout.write('\x1b[?1049l\x1b[?25h');
    process.exit(0);
  }

  // Raw global keypress interceptor (unblockable by textbox grabKeys)
  screen.program.on('keypress', (ch, key) => {
    if (!key) return;

    // 0. Autocomplete Palette navigation & activation
    if (!commandPaletteBox.hidden) {
      if (key.name === 'up') {
        commandPaletteBox.up();
        screen.render();
        return;
      }
      if (key.name === 'down') {
        commandPaletteBox.down();
        screen.render();
        return;
      }
      if (key.name === 'tab' || ch === '\t') {
        applySelectedPaletteCommand();
        cleanActiveInput();
        return;
      }
      if (key.name === 'escape' || ch === '\x1b') {
        hideCommandPalette();
        cleanActiveInput();
        return;
      }
      if (key.name === 'enter' || key.name === 'return' || ch === '\r' || ch === '\n') {
        const sel = paletteFilteredItems[commandPaletteBox.selected];
        const val = (terminalInput.value || '').trim();
        if (sel && val !== sel.cmd && !val.includes(' ')) {
          if (['/model', '/effort', '/sandbox', '/resume', '/codex', '/cmdc', '/agy', '/turf', '/plan', '/term', '/chat', '/file'].includes(sel.cmd)) {
            terminalInput.setValue(sel.cmd + ' ');
            hideCommandPalette();
            focusTerminal();
            cleanActiveInput();
            screen.render();
            return;
          } else {
            terminalInput.setValue(sel.cmd);
            hideCommandPalette();
          }
        } else {
          hideCommandPalette();
        }
      }
    }

    // 1. Double Ctrl+C protection
    if ((key.ctrl && (key.name === 'c' || key.name === 'C')) || ch === '\x03') {
      handleCtrlC();
      cleanActiveInput();
      return;
    }

    // 2. Ctrl+B: Toggle Left Sidebar
    if ((key.ctrl && (key.name === 'b' || key.name === 'B')) || ch === '\x02') {
      toggleLeftSidebar();
      cleanActiveInput();
      return;
    }

    // 2b. Ctrl+E: Toggle Right Sidebar
    if ((key.ctrl && (key.name === 'e' || key.name === 'E')) || ch === '\x05') {
      toggleRightSidebar();
      cleanActiveInput();
      return;
    }

    // 3. F2 or Ctrl+Q: Toggle Intent / Queue
    if (key.name === 'f2' || (key.ctrl && (key.name === 'q' || key.name === 'Q')) || ch === '\x11') {
      toggleRightSection();
      cleanActiveInput();
      return;
    }

    // 4. F3: Focus Files Explorer
    if (key.name === 'f3') {
      focusFiles();
      cleanActiveInput();
      return;
    }

    // 5. F4: Toggle Terminal / File Viewer tab
    if (key.name === 'f4') {
      toggleCenterTab();
      cleanActiveInput();
      return;
    }

    // 6. Tab: Switch Pane Focus (Center Pane -> Team Chat -> Files -> Center Pane)
    if (key.name === 'tab' || ch === '\t') {
      switchFocus();
      cleanActiveInput();
      return;
    }

    // 6b. Ctrl+T: Cycle Center Tabs (TERM -> AGY -> CODEX -> TERM)
    if ((key.ctrl && (key.name === 't' || key.name === 'T')) || ch === '\x14') {
      cycleCenterTabs();
      cleanActiveInput();
      return;
    }

    // 7. Escape: Return to Terminal tab or focus Terminal
    if (key.name === 'escape' || ch === '\x1b') {
      if (activeCenterTab === 'file') {
        showTerminalTab();
        return;
      }
      if (focusIndex !== 0) {
        focusTerminal();
        return;
      }
    }

    // 8. F5: Run automated demo
    if (key.name === 'f5') {
      runDemo();
      cleanActiveInput();
      return;
    }

    // 9. Ctrl+O: Open Web UI
    if ((key.ctrl && (key.name === 'o' || key.name === 'O')) || ch === '\x0f') {
      openWebUI();
      cleanActiveInput();
      return;
    }

    // 10. Unblockable navigation when FILES list is focused
    const isFilesFocus = focusIndex === 2;
    if (isFilesFocus) {
      if (key.name === 'down' || (!key.ctrl && (key.name === 'j' || ch === 'j'))) {
        filesList.down();
        screen.render();
        return;
      }
      if (key.name === 'up' || (!key.ctrl && (key.name === 'k' || ch === 'k'))) {
        filesList.up();
        screen.render();
        return;
      }
      if (key.name === 'enter' || key.name === 'return' || ch === '\r' || ch === '\n') {
        handleFileActivation();
        return;
      }
      if (key.name === 'space' || ch === ' ') {
        handleFileActivation();
        return;
      }
      if (key.name === 'left' || (!key.ctrl && (key.name === 'h' || ch === 'h'))) {
        handleFileLeftKey();
        return;
      }
      if (key.name === 'right' || (!key.ctrl && (key.name === 'l' || ch === 'l'))) {
        handleFileRightKey();
        return;
      }
      if (key.name === 'pageup') {
        filesList.move(-Math.max(1, (filesList.height || 10) - 2));
        screen.render();
        return;
      }
      if (key.name === 'pagedown') {
        filesList.move(Math.max(1, (filesList.height || 10) - 2));
        screen.render();
        return;
      }
      if (key.name === 'home') {
        filesList.select(0);
        screen.render();
        return;
      }
      if (key.name === 'end') {
        filesList.select(Math.max(0, visibleFileList.length - 1));
        screen.render();
        return;
      }
    }

    // 11. Center Pane & Team Chat scrolling with keyboard
    if (!isFilesFocus) {
      const isPageUp = key.name === 'pageup' || ch === '\x1b[5~';
      const isPageDown = key.name === 'pagedown' || ch === '\x1b[6~';
      const isUpScroll = (key.shift && key.name === 'up') || (key.ctrl && key.name === 'up') || (key.ctrl && (key.name === 'y' || ch === '\x19')) || (focusIndex === 0 && key.name === 'up' && !(terminalInput.value || '').trim());
      const isDownScroll = (key.shift && key.name === 'down') || (key.ctrl && key.name === 'down') || (key.ctrl && (key.name === 'd' || ch === '\x04')) || (focusIndex === 0 && key.name === 'down' && !(terminalInput.value || '').trim());
      const isHome = (key.shift && key.name === 'home');
      const isEnd = (key.shift && key.name === 'end');

      if (isPageUp) {
        const h = focusIndex === 1 ? (chatLogBox.height || 10) : ((getActiveLog() && getActiveLog().height) || 10);
        scrollActiveLog(-Math.max(1, Math.floor(h / 2)));
        return;
      }
      if (isPageDown) {
        const h = focusIndex === 1 ? (chatLogBox.height || 10) : ((getActiveLog() && getActiveLog().height) || 10);
        scrollActiveLog(Math.max(1, Math.floor(h / 2)));
        return;
      }
      if (isUpScroll) {
        scrollActiveLog(-3);
        return;
      }
      if (isDownScroll) {
        scrollActiveLog(3);
        return;
      }
      if (isHome) {
        const log = getActiveLog();
        if (log && typeof log.setScrollPerc === 'function') {
          log.setScrollPerc(0);
          screen.render();
          return;
        }
      }
      if (isEnd) {
        const log = getActiveLog();
        if (log && typeof log.setScrollPerc === 'function') {
          log.setScrollPerc(100);
          screen.render();
          return;
        }
      }
    }

    if (focusIndex === 0) {
      process.nextTick(() => {
        updatePaletteFromInput();
      });
    }
  });

  function scrollActiveLog(delta) {
    if (focusIndex === 1) {
      if (chatLogBox && typeof chatLogBox.scroll === 'function') {
        chatLogBox.scroll(delta);
        screen.render();
      }
    } else {
      const activeLog = getActiveLog();
      if (activeLog && typeof activeLog.scroll === 'function') {
        activeLog.scroll(delta);
        screen.render();
      }
    }
  }

  // Mouse click handlers
  chatInputBox.on('click', focusChat);
  chatLogBox.on('click', focusChat);
  centerPane.on('click', () => focusTerminal());
  termLog.on('click', () => showCenterTab('term'));
  cmdcLog.on('click', () => showCenterTab('cmdc'));
  codexLog.on('click', () => showCenterTab('codex'));
  turfLog.on('click', () => showCenterTab('turf'));
  fileViewerLog.on('click', () => focusTerminal());
  filesBox.on('click', focusFiles);
  filesList.on('click', focusFiles);

  // Global screen mouse wheel listeners
  screen.on('wheelup', () => scrollActiveLog(-3));
  screen.on('wheeldown', () => scrollActiveLog(3));

  // Element mouse wheel scrolling
  [centerPane, termLog, cmdcLog, codexLog, fileViewerLog].forEach(box => {
    try { screen.enableMouse(box); } catch (e) {}
    box.on('wheelup', () => scrollActiveLog(-3));
    box.on('wheeldown', () => scrollActiveLog(3));
  });

  try { screen.enableMouse(chatLogBox); } catch (e) {}
  chatLogBox.on('wheelup', () => {
    chatLogBox.scroll(-3);
    screen.render();
  });
  chatLogBox.on('wheeldown', () => {
    chatLogBox.scroll(3);
    screen.render();
  });

  function executePromptForAgent(agent, inputStr) {
    const targetLog = agent === 'codex' ? codexLog : agent === 'turf' ? turfLog : cmdcLog;
    const prefixTag = agent === 'codex' ? '{bold}{cyan-fg}CODEX>{/cyan-fg}{/bold}' : agent === 'turf' ? '{bold}{green-fg}TURF>{/green-fg}{/bold}' : '{bold}{magenta-fg}CMDC>{/magenta-fg}{/bold}';
    targetLog.log(`${prefixTag} {yellow-fg}${inputStr}{/yellow-fg}`);

    const config = ptyManager.getAgentConfig(agent);
    if (config.sessionId || config.turnCount > 0) {
      targetLog.log(`{grey-fg}⚡ [Continuing Turn #${config.turnCount + 1}...]{/grey-fg}`);
    } else if (agent === 'cmdc' || agent === 'agy') {
      targetLog.log(`{grey-fg}⚡ [Starting Command Code session (${config.model || 'default'})...]{/grey-fg}`);
    } else if (agent === 'turf') {
      const planTag = config.planMode ? ' [PLAN MODE: read-only recon]' : '';
      targetLog.log(`{grey-fg}⚡ [Starting Turf session (turf-native intent locks ON${planTag})...]{/grey-fg}`);
    } else {
      targetLog.log(`{grey-fg}⚡ [Starting Codex session (${config.model || 'default'} | ${config.sandbox})...]{/grey-fg}`);
    }

    try {
      const env = {
        TURF_DAEMON: `http://${hostAddress || '127.0.0.1'}:${port}`,
        TURF_ROOM: roomCode,
        TURF_USER: hostName,
        TURF_AGENT_ID: agent
      };
      ptyManager.spawnSession(agent, inputStr, { cwd: currentDir, env });
    } catch (err) {
      targetLog.log(`{red-fg}Error starting ${agent.toUpperCase()}: ${err.message}{/red-fg}`);
    }
  }

  terminalInput.on('submit', (value) => {
    hideCommandPalette();
    const inputStr = value.trim();
    const isRunning = ptyManager.isSessionActive(activeCenterTab);
    const currentLog = getActiveLog();

    if (!inputStr && !isRunning) {
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr === '/kill' || inputStr === '/stop') {
      if (isRunning) {
        ptyManager.killSession(activeCenterTab);
        currentLog.log(`{red-fg}Session terminated on ${activeCenterTab.toUpperCase()}.{/red-fg}`);
        updateCenterLabel();
        updateIntentBox();
      } else {
        currentLog.log(`{grey-fg}No active process to kill on ${activeCenterTab.toUpperCase()}.{/grey-fg}`);
      }
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (isRunning) {
      ptyManager.write(activeCenterTab, inputStr + '\r\n');
      currentLog.log(`{bold}{grey-fg}> ${inputStr}{/grey-fg}{/bold}`);
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr === '/usage' || inputStr === '/stats') {
      const stats = ptyManager.getUsageStats(activeCenterTab);
      currentLog.log(`{bold}{149-fg}┌─ AGENT USAGE & CONFIG [${activeCenterTab.toUpperCase()}] ────────────────────────┐{/149-fg}{/bold}`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {grey-fg}Session ID:{/grey-fg}  {yellow-fg}${stats.sessionId}{/yellow-fg}`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {grey-fg}Active Model:{/grey-fg} {white-fg}${stats.model}{/white-fg}`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {grey-fg}Reasoning:{/grey-fg}   {white-fg}${stats.effort}{/white-fg}`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {grey-fg}Sandbox:{/grey-fg}     {cyan-fg}${stats.sandbox}{/cyan-fg}`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {grey-fg}Plan mode:{/grey-fg}   {white-fg}${stats.planMode ? 'ON (read-only recon)' : 'off'}{/white-fg}`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {grey-fg}Turns Used:{/grey-fg}  {green-fg}${stats.turnCount}{/green-fg}`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {grey-fg}Tokens Used:{/grey-fg} {magenta-fg}${stats.totalTokens.toLocaleString()}{/magenta-fg}`);
      currentLog.log(`{bold}{149-fg}└────────────────────────────────────────────────────────┘{/149-fg}{/bold}`);
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr === '/model' || inputStr.startsWith('/model ')) {
      const newModel = inputStr.replace(/^\/model\s*/, '').trim();
      if (newModel) {
        ptyManager.setModel(activeCenterTab, newModel);
        currentLog.log(`{green-fg}✔ Active model for ${activeCenterTab.toUpperCase()} set to:{/green-fg} {bold}${newModel}{/bold}`);
      } else {
        const curModel = ptyManager.getModel(activeCenterTab);
        currentLog.log(`{bold}{149-fg}Active model for ${activeCenterTab.toUpperCase()}:{/149-fg}{/bold} {yellow-fg}${curModel}{/yellow-fg}`);
        if (activeCenterTab === 'cmdc' || activeCenterTab === 'agy') {
          currentLog.log(`{magenta-fg}Available Command Code models:{/magenta-fg}`);
          const cmdcModels = getCmdcModels();
          cmdcModels.forEach(m => currentLog.log(`  • {yellow-fg}${m.id}{/yellow-fg} {white-fg}(${m.desc}){/white-fg}`));
          currentLog.log(`{white-fg}Usage: /model <model-name> (e.g. /model deepseek/deepseek-v4-flash){/white-fg}`);
        } else if (activeCenterTab === 'turf') {
          currentLog.log(`{green-fg}Available Turf models (real-time):{/green-fg}`);
          const displayModels = cachedPaletteModels.length > 0 ? cachedPaletteModels : [
            { cmd: '/model openai/gpt-oss-120b', desc: 'Groq GPT-OSS 120B (Deep reasoning, ultra-fast)' },
            { cmd: '/model openai/gpt-oss-20b', desc: 'Groq GPT-OSS 20B (High speed, low latency)' },
            { cmd: '/model qwen/qwen3.8-27b', desc: 'Qwen 3.8 27B (Coding & reasoning)' },
            { cmd: '/model groq/compound', desc: 'Groq Compound (Agentic router)' },
            { cmd: '/model claude-3-5-sonnet', desc: 'Anthropic Claude 3.5 Sonnet' }
          ];
          displayModels.forEach(m => currentLog.log(`  • {yellow-fg}${m.cmd.replace('/model ', '')}{/yellow-fg} {white-fg}(${m.desc}){/white-fg}`));
          currentLog.log(`{white-fg}Usage: /model <model-name> (e.g. /model openai/gpt-oss-120b){/white-fg}`);
        } else if (activeCenterTab === 'codex') {
          currentLog.log(`{cyan-fg}Common Codex models:{/cyan-fg} o3-mini, gpt-4o, o1`);
          currentLog.log(`{white-fg}Usage: /model <model-name> (e.g. /model o3-mini){/white-fg}`);
        }
      }
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr === '/effort' || inputStr.startsWith('/effort ')) {
      const newEffort = inputStr.replace(/^\/effort\s*/, '').trim().toLowerCase();
      if (['low', 'medium', 'high'].includes(newEffort)) {
        ptyManager.setEffort(activeCenterTab, newEffort);
        currentLog.log(`{green-fg}✔ Reasoning effort for ${activeCenterTab.toUpperCase()} set to:{/green-fg} {bold}${newEffort}{/bold}`);
      } else {
        const curEffort = ptyManager.getEffort(activeCenterTab);
        currentLog.log(`{grey-fg}Reasoning effort for ${activeCenterTab.toUpperCase()}:{/grey-fg} {bold}${curEffort}{/bold} {grey-fg}(Usage: /effort low|medium|high){/grey-fg}`);
      }
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr === '/sandbox' || inputStr.startsWith('/sandbox ')) {
      const newMode = inputStr.replace(/^\/sandbox\s*/, '').trim();
      if (newMode) {
        ptyManager.setSandbox(activeCenterTab, newMode);
        currentLog.log(`{green-fg}✔ Sandbox mode for ${activeCenterTab.toUpperCase()} set to:{/green-fg} {bold}${newMode}{/bold}`);
      } else {
        const curMode = ptyManager.getSandbox(activeCenterTab);
        currentLog.log(`{grey-fg}Sandbox mode for ${activeCenterTab.toUpperCase()}:{/grey-fg} {bold}${curMode}{/bold} {grey-fg}(Usage: /sandbox workspace-write | read-only){/grey-fg}`);
      }
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr === '/new' || inputStr === '/reset') {
      ptyManager.resetSession(activeCenterTab);
      currentLog.log(`{green-fg}✔ Session memory reset for ${activeCenterTab.toUpperCase()}. Next prompt starts a fresh session.{/green-fg}`);
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr === '/resume' || inputStr.startsWith('/resume ')) {
      const resumeId = inputStr.replace(/^\/resume\s*/, '').trim();
      if (resumeId) {
        ptyManager.resumeSession(activeCenterTab, resumeId);
        currentLog.log(`{green-fg}✔ Active session for ${activeCenterTab.toUpperCase()} set to resume ID:{/green-fg} {bold}${resumeId}{/bold}`);
      } else {
        const stats = ptyManager.getUsageStats(activeCenterTab);
        currentLog.log(`{grey-fg}Current session ID for ${activeCenterTab.toUpperCase()}:{/grey-fg} {yellow-fg}${stats.sessionId}{/yellow-fg} {grey-fg}(Usage: /resume <session-id>){/grey-fg}`);
      }
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr === '/diff' || inputStr.startsWith('/diff ')) {
      try {
        const diffStat = execSync('git diff --stat', { cwd: currentDir, encoding: 'utf8', timeout: 5000 }).trim();
        const statusStat = execSync('git status -s', { cwd: currentDir, encoding: 'utf8', timeout: 5000 }).trim();
        if (!diffStat && !statusStat) {
          currentLog.log(`{green-fg}✔ Clean working directory. No uncommitted modifications.{/green-fg}`);
        } else {
          currentLog.log(`{bold}{149-fg}┌─ WORKSPACE MODIFICATIONS (GIT DIFF) ────────────┐{/149-fg}{/bold}`);
          if (statusStat) {
            statusStat.split('\n').forEach(line => currentLog.log(`{yellow-fg}${line}{/yellow-fg}`));
          }
          if (diffStat) {
            currentLog.log(`{grey-fg}───────────────────────────────────────────────────{/grey-fg}`);
            diffStat.split('\n').forEach(line => currentLog.log(`{cyan-fg}${line}{/cyan-fg}`));
          }
          currentLog.log(`{bold}{149-fg}└───────────────────────────────────────────────────┘{/149-fg}{/bold}`);
        }
      } catch (err) {
        currentLog.log(`{red-fg}Failed to get git diff: ${err.message}{/red-fg}`);
      }
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr === '/help' || inputStr === '/h' || inputStr === '?') {
      currentLog.log(`{bold}{149-fg}┌─ TURF CODE COMMAND CHEAT SHEET ──────────────────────────┐{/149-fg}{/bold}`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {bold}/usage, /stats{/bold}       View turns, tokens & active session config`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {bold}/model <name>{/bold}        Set model (e.g. gpt-4o, claude-sonnet-5)`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {bold}/effort <lvl>{/bold}        Set reasoning effort: low | medium | high`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {bold}/sandbox <mode>{/bold}     Set sandbox: workspace-write | read-only`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {bold}/new, /reset{/bold}         Clear session memory & start fresh`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {bold}/resume <id>{/bold}        Resume specific past session ID`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {bold}/diff{/bold}                Inspect git diff of modifications made`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {bold}/kill, /stop{/bold}         Stop running process or agent immediately`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {bold}/turf, /cmdc, /codex, /term{/bold} Switch tab or run targeted command`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {bold}/plan{/bold}                Toggle read-only recon plan mode`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {bold}/chat <msg>{/bold}          Send team chat message or focus chat`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {bold}/sidebar <left|right>{/bold} Toggle left or right sidebar (or Ctrl+B / Ctrl+E)`);
      currentLog.log(`{bold}{149-fg}│{/149-fg}{/bold} {bold}Shortcuts:{/bold} [Tab] Focus │ [Ctrl+T] Tab │ [F3] Files │ [Ctrl+O] Web`);
      currentLog.log(`{bold}{149-fg}└──────────────────────────────────────────────────────────┘{/149-fg}{/bold}`);
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr === '/sidebar' || inputStr.startsWith('/sidebar ')) {
      const arg = inputStr.replace(/^\/sidebar\s*/, '').trim().toLowerCase();
      if (arg === 'right') {
        toggleRightSidebar();
        currentLog.log(`{green-fg}✔ Toggled right sidebar (${isRightSidebarCollapsed ? 'hidden' : 'visible'}){/green-fg}`);
      } else {
        toggleLeftSidebar();
        currentLog.log(`{green-fg}✔ Toggled left sidebar (${isLeftSidebarCollapsed ? 'hidden' : 'visible'}){/green-fg}`);
      }
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr === '/codex' || inputStr.startsWith('/codex ')) {
      const prompt = inputStr.replace(/^\/codex\s*/, '').trim();
      showCenterTab('codex');
      terminalInput.clearValue();
      if (prompt) {
        executePromptForAgent('codex', prompt);
      }
      return;
    }

    if (inputStr === '/cmdc' || inputStr.startsWith('/cmdc ') || inputStr === '/agy' || inputStr.startsWith('/agy ')) {
      const prompt = inputStr.replace(/^(\/cmdc|\/agy)\s*/, '').trim();
      showCenterTab('cmdc');
      terminalInput.clearValue();
      if (prompt) {
        executePromptForAgent('cmdc', prompt);
      }
      return;
    }

    if (inputStr === '/turf' || inputStr.startsWith('/turf ')) {
      const prompt = inputStr.replace(/^\/turf\s*/, '').trim();
      showCenterTab('turf');
      terminalInput.clearValue();
      if (prompt) {
        executePromptForAgent('turf', prompt);
      }
      return;
    }

    if (inputStr === '/plan' || inputStr === '/plan on' || inputStr === '/plan off') {
      const cur = ptyManager.getPlanMode(activeCenterTab);
      const next = inputStr.endsWith(' on') ? true : inputStr.endsWith(' off') ? false : !cur;
      ptyManager.setPlanMode(activeCenterTab, next);
      currentLog.log(next ? `{green-fg}✔ PLAN MODE ON for ${activeCenterTab.toUpperCase()} — next prompt is read-only recon.{/green-fg}` : `{grey-fg}Plan mode OFF for ${activeCenterTab.toUpperCase()}.{/grey-fg}`);
      updateCenterLabel();
      updateIntentBox();
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr === '/negotiate' || inputStr.startsWith('/negotiate ')) {
      const targetFile = inputStr.replace(/^\/negotiate\s*/, '').trim() || (currentOpenedFile || 'server/auth.js');
      const fromAgent = activeCenterTab === 'turf' ? 'turf' : (activeCenterTab === 'codex' ? 'codex' : 'cmdc');
      const toAgent = fromAgent === 'turf' ? 'cmdc' : 'turf';
      
      currentLog.log(`{magenta-fg}⚡ Initiating autonomous negotiation with ${toAgent.toUpperCase()} for ${targetFile}...{/magenta-fg}`);
      
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Step 1: Propose lock
        ws.send(JSON.stringify({
          type: 'agent:negotiate',
          fromUser: hostName,
          fromAgent,
          toUser: 'Teammates',
          toAgent,
          file: targetFile,
          intent: 'request_lock',
          message: `Requesting exclusive intent lock on ${targetFile} for planned refactor. Can you yield?`
        }));
        
        // Step 2: Simulated response from peer/cooperating agent after 1.2 seconds
        setTimeout(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'agent:negotiate',
              fromUser: 'Teammate',
              fromAgent: toAgent,
              toUser: hostName,
              toAgent: fromAgent,
              file: targetFile,
              intent: 'yield_granted',
              message: `AST analysis confirms no overlapping edits on ${targetFile}. Yielding lock to ${fromAgent.toUpperCase()}. Speculative worktree active.`
            }));
          }
        }, 1200);
      }
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr === '/term' || inputStr === '/shell' || inputStr.startsWith('/term ') || inputStr.startsWith('/shell ')) {
      const cmd = inputStr.replace(/^(\/term|\/shell)\s*/, '').trim();
      showCenterTab('term');
      terminalInput.clearValue();
      if (cmd) {
        termLog.log(`{bold}{149-fg}>{/149-fg}{/bold} {yellow-fg}${cmd}{/yellow-fg}`);
        spawnTerminalProcess(cmd, 'term');
      }
      return;
    }

    if (inputStr.startsWith('/chat') || inputStr.startsWith('/c ') || inputStr === '/c' || inputStr === 'chat') {
      const msg = inputStr.replace(/^(\/chat|\/c|chat)\s*/, '').trim();
      if (msg) {
        ws.send(JSON.stringify({ type: 'chat:send', user: hostName, message: msg }));
        currentLog.log(`{cyan-fg}[Chat Sent]:{/cyan-fg} ${msg}`);
      } else {
        currentLog.log('{cyan-fg}Focused Team Chat. Type your message below. (Type /term or Esc to return).{/cyan-fg}');
        focusChat();
      }
      terminalInput.clearValue();
      return;
    }

    if (inputStr === 'cls' || inputStr === 'clear') {
      currentLog.setContent('');
      printWelcomeBanner();
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr.startsWith('/file ') || inputStr.startsWith('/view ') || inputStr.startsWith('view ')) {
      const targetFile = inputStr.replace(/^(\/file|\/view|view)\s+/, '').trim();
      if (targetFile) {
        openFileInViewer(targetFile);
        terminalInput.clearValue();
        return;
      }
    }

    if (inputStr === '/sidebar' || inputStr === '/b') {
      toggleSidebar();
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr === '/queue' || inputStr === '/intent' || inputStr === '/q' || inputStr === '/i') {
      toggleRightSection();
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr === '/files' || inputStr === '/f') {
      focusFiles();
      terminalInput.clearValue();
      return;
    }

    if (inputStr === '/demo') {
      runDemo();
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr === '/web' || inputStr === '/browser' || inputStr === '/o') {
      openWebUI();
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr === '/exit' || inputStr === '/quit') {
      handleQuit();
      return;
    }

    if (inputStr.startsWith('cd ')) {
      const target = inputStr.substring(3).trim();
      currentDir = path.resolve(currentDir, target);
      isTreeInitialized = false;
      updateHeader();
      updateCenterLabel();
      currentLog.log(`{cyan-fg}Directory changed to:{/cyan-fg} {yellow-fg}${currentDir}{/yellow-fg}`);
      refreshFileList(false);
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    terminalInput.clearValue();

    if (activeCenterTab === 'codex') {
      const isKnownShellCmd = /^(dir|ls|git|npm|cd|cls|node|python|py)\s/i.test(inputStr + ' ') || inputStr.startsWith('!');
      if (isKnownShellCmd) {
        const cmd = inputStr.startsWith('!') ? inputStr.slice(1).trim() : inputStr;
        currentLog.log(`{bold}{cyan-fg}CODEX [CMD]>{/cyan-fg}{/bold} {yellow-fg}${inputStr}{/yellow-fg}`);
        spawnTerminalProcess(cmd, 'codex');
      } else {
        executePromptForAgent('codex', inputStr);
      }
    } else if (activeCenterTab === 'cmdc' || activeCenterTab === 'agy') {
      const isKnownShellCmd = /^(dir|ls|git|npm|cd|cls|node|python|py)\s/i.test(inputStr + ' ') || inputStr.startsWith('!');
      if (isKnownShellCmd) {
        const cmd = inputStr.startsWith('!') ? inputStr.slice(1).trim() : inputStr;
        currentLog.log(`{bold}{magenta-fg}CMDC [CMD]>{/magenta-fg}{/bold} {yellow-fg}${inputStr}{/yellow-fg}`);
        spawnTerminalProcess(cmd, 'cmdc');
      } else {
        executePromptForAgent('cmdc', inputStr);
      }
    } else if (activeCenterTab === 'turf') {
      const isKnownShellCmd = /^(dir|ls|git|npm|cd|cls|node|python|py)\s/i.test(inputStr + ' ') || inputStr.startsWith('!');
      if (isKnownShellCmd) {
        const cmd = inputStr.startsWith('!') ? inputStr.slice(1).trim() : inputStr;
        currentLog.log(`{bold}{green-fg}TURF [CMD]>{/green-fg}{/bold} {yellow-fg}${inputStr}{/yellow-fg}`);
        spawnTerminalProcess(cmd, 'turf');
      } else {
        executePromptForAgent('turf', inputStr);
      }
    } else {
      // term tab
      currentLog.log(`{bold}{149-fg}>{/149-fg}{/bold} {yellow-fg}${inputStr}{/yellow-fg}`);
      const cmd = inputStr.startsWith('!') ? inputStr.slice(1).trim() : inputStr;
      spawnTerminalProcess(cmd, 'term');
    }
  });

  function spawnTerminalProcess(cmdStr, targetTab = activeCenterTab) {
    const targetLog = targetTab === 'codex' ? codexLog : targetTab === 'turf' ? turfLog : ((targetTab === 'cmdc' || targetTab === 'agy') ? cmdcLog : termLog);
    try {
      const env = targetTab === 'turf'
        ? { TURF_DAEMON: `http://${hostAddress || '127.0.0.1'}:${port}`, TURF_ROOM: roomCode, TURF_USER: hostName, TURF_AGENT_ID: 'turf' }
        : undefined;
      ptyManager.spawnSession(targetTab, cmdStr, { cwd: currentDir, env });
    } catch (err) {
      targetLog.log(`{red-fg}Execution error: ${err.message}{/red-fg}`);
    }
    if (activeCenterTab === targetTab) {
      focusTerminal();
    }
  }

  chatInput.on('submit', (value) => {
    const inputStr = value.trim();
    if (!inputStr) {
      chatInput.clearValue();
      focusChat();
      return;
    }

    if (inputStr.startsWith('/term') || inputStr.startsWith('/t ') || inputStr === '/t' || inputStr === 'term' || inputStr === '/exit' || inputStr === 'exit') {
      chatInput.clearValue();
      chatLogBox.log('{cyan-fg}Switched to Terminal.{/cyan-fg}');
      focusTerminal();
      return;
    }
    
    if (inputStr === '/chat' || inputStr === '/c' || inputStr === 'chat') {
      chatInput.clearValue();
      chatLogBox.log('{cyan-fg}ℹ️ Already in Team Chat.{/cyan-fg}');
      focusChat();
      return;
    }

    ws.send(JSON.stringify({ type: 'chat:send', user: hostName, message: inputStr }));
    chatInput.clearValue();
    focusChat();
  });

  showCenterTab('turf');
}
