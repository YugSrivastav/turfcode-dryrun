import blessed from 'blessed';
import { spawn, exec } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TURF_ROOT = path.resolve(__dirname, '..');

const CLIS = [
  { id: 'shell', name: 'PowerShell / Shell', prefix: process.platform === 'win32' ? 'PS' : '$', cmd: '' },
  { id: 'agy', name: 'Antigravity (agy)', prefix: 'agy', cmd: 'agy' },
  { id: 'claude', name: 'Claude Code (claude)', prefix: 'claude', cmd: 'claude' },
  { id: 'codex', name: 'Codex (codex)', prefix: 'codex', cmd: 'codex' },
  { id: 'opencode', name: 'OpenCode (opencode)', prefix: 'opencode', cmd: 'opencode' }
];

export function launchTUI({ hostName, roomCode, repoPath, port, localIp, hostAddress, isPeer, serverInstance, wssInstance }) {
  const screen = blessed.screen({
    smartCSR: true,
    title: 'Turfcode',
    dockBorders: true,
    useBCE: true,
    fullUnicode: true
  });

  let activeCliIndex = 0;
  let currentCli = CLIS[activeCliIndex];
  let currentDir = repoPath;
  let activeProc = null;

  const ws = new WebSocket(`ws://${hostAddress || '127.0.0.1'}:${port}`);
  
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'peer:join', user: hostName, role: isPeer ? 'Peer' : 'Host' }));
  });

  const header = blessed.box({
    top: 0,
    left: 0,
    width: '100%',
    height: 1,
    content: ` {bold}{green-fg} TURFCODE {/green-fg}{/bold}│ Room: {bold}{yellow-fg}${roomCode}{/yellow-fg}{/bold} │ WiFi Join: {bold}{yellow-fg}${localIp || hostAddress}:${port}{/yellow-fg}{/bold} │ User: {bold}{cyan-fg}${hostName}{/cyan-fg}{/bold}`,
    tags: true,
    style: {
      fg: 'white',
      bg: 'black',
      bold: true
    }
  });
  screen.append(header);

  const leftSidebar = blessed.box({
    top: 1,
    left: 0,
    width: 24,
    height: '100%-2',
  });
  screen.append(leftSidebar);

  const peopleBox = blessed.box({
    parent: leftSidebar,
    top: 0,
    left: 0,
    width: '100%',
    height: '40%',
    label: '{bold}{cyan-fg} 👥 PEOPLE {/cyan-fg}{/bold}',
    border: { type: 'line', fg: 'cyan' },
    tags: true,
    content: ` {green-fg}●{/green-fg} {bold}${hostName}{/bold} (You)\n {grey-fg}(Solo session — invite peers with room code: ${roomCode}){/grey-fg}`
  });

  function updatePeopleBox(peers) {
    if (!peers || peers.length === 0) return;
    let content = '';
    peers.forEach(p => {
      if (p.name === hostName) {
        content += ` {green-fg}●{/green-fg} {bold}${p.name} (You){/bold}\n`;
      } else {
        content += ` {green-fg}●{/green-fg} ${p.name} {cyan-fg}[${p.role}]{/cyan-fg}\n`;
      }
    });
    peopleBox.setContent(content);
    screen.render();
  }

  const intentBox = blessed.box({
    parent: leftSidebar,
    top: '40%',
    left: 0,
    width: '100%',
    height: '100%-3',
    label: '{bold}{yellow-fg} 🔒 INTENT {/yellow-fg}{/bold}',
    border: { type: 'line', fg: 'yellow' },
    tags: true,
    content: `{bold}ACTIVE TURFS:{/bold}\n {grey-fg}(No active file locks){/grey-fg}\n\n{bold}LIVE ALERTS:{/bold}\n {grey-fg}(No alerts){/grey-fg}`
  });

  const collapseBtn = blessed.button({
    parent: leftSidebar,
    bottom: 0,
    left: 0,
    width: '100%',
    height: 3,
    content: ' {bold}«{/bold}',
    border: { type: 'line', fg: 'grey' },
    tags: true,
    mouse: true,
    style: {
      hover: { bg: 'grey' },
      focus: { bg: 'grey' }
    }
  });

  const centerPane = blessed.box({
    top: 1,
    left: 24,
    width: '100%-62',
    height: '100%-2',
    label: `{bold} TERMINAL {/bold}│ {yellow-fg}${currentDir}{/yellow-fg}`,
    border: { type: 'line', fg: 'green' },
    tags: true
  });
  screen.append(centerPane);

  let isSidebarCollapsed = false;
  function toggleSidebar() {
    isSidebarCollapsed = !isSidebarCollapsed;
    if (isSidebarCollapsed) {
      leftSidebar.width = 4;
      peopleBox.hide();
      intentBox.hide();
      collapseBtn.setContent(' {bold}»{/bold}');
      centerPane.left = 4;
      centerPane.width = '100%-42';
    } else {
      leftSidebar.width = 24;
      peopleBox.show();
      intentBox.show();
      collapseBtn.setContent(' {bold}«{/bold}');
      centerPane.left = 24;
      centerPane.width = '100%-62';
    }
    screen.render();
  }
  collapseBtn.on('press', toggleSidebar);

  const terminalLog = blessed.log({
    parent: centerPane,
    top: 0,
    left: 0,
    width: '100%-2',
    height: '100%-3',
    scrollable: true,
    alwaysScroll: true,
    tags: true,
    keys: true,
    vi: true
  });

  function printWelcomeBanner() {
    terminalLog.log(`{cyan-fg}┌─────────────────────────────────────────────────────────────┐{/cyan-fg}`);
    terminalLog.log(`{cyan-fg}│{/cyan-fg}  {bold}{white-fg}TURFCODE TERMINAL v1.0{/white-fg}{/bold} — {green-fg}READY{/green-fg}                              {cyan-fg}│{/cyan-fg}`);
    terminalLog.log(`{cyan-fg}│{/cyan-fg}  Directory: {yellow-fg}${currentDir}{/yellow-fg}                                     {cyan-fg}│{/cyan-fg}`);
    terminalLog.log(`{cyan-fg}│{/cyan-fg}  Run any shell command directly (git, npm, agy, claude)     {cyan-fg}│{/cyan-fg}`);
    terminalLog.log(`{cyan-fg}│{/cyan-fg}  [/chat] Team Chat  │  [F5] Demo  │  [o] Web UI             {cyan-fg}│{/cyan-fg}`);
    terminalLog.log(`{cyan-fg}└─────────────────────────────────────────────────────────────┘{/cyan-fg}\n`);
  }
  printWelcomeBanner();

  const promptStr = process.platform === 'win32' ? 'PS>' : '$>';
  
  const promptPrefix = blessed.text({
    parent: centerPane,
    bottom: 0,
    left: 1,
    tags: true,
    content: `{green-fg}${promptStr}{/green-fg} `
  });

  const terminalInput = blessed.textbox({
    parent: centerPane,
    bottom: 0,
    left: promptStr.length + 2,
    width: '100%-15',
    height: 1,
    keys: true,
    mouse: true,
    inputOnFocus: true,
    style: {
      fg: 'white',
      bg: 'black'
    }
  });

  const rightSidebar = blessed.box({
    top: 1,
    right: 0,
    width: 38,
    height: '100%-2',
  });
  screen.append(rightSidebar);

  const queueBox = blessed.box({
    parent: rightSidebar,
    top: 0,
    left: 0,
    width: '100%',
    height: '35%',
    label: '{bold}{magenta-fg} 📋 FILE QUEUE {/magenta-fg}{/bold}',
    border: { type: 'line', fg: 'magenta' },
    tags: true,
    content: ` {grey-fg}(Queue is empty — 0 agents waiting){/grey-fg}`
  });

  const chatLogBox = blessed.log({
    parent: rightSidebar,
    top: '35%',
    left: 0,
    width: '100%',
    bottom: 3,
    label: '{bold}{blue-fg} 💬 TEAM CHAT {/blue-fg}{/bold}',
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
    label: '{bold} ✍️ Write Message (/term to return) {/bold}',
    border: { type: 'line', fg: 'cyan' },
    tags: true,
    mouse: true
  });

  const chatInput = blessed.textbox({
    parent: chatInputBox,
    top: 0,
    left: 1,
    width: '100%-4',
    height: 1,
    keys: true,
    mouse: true,
    inputOnFocus: true,
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
    content: ` {bold}{yellow-fg}[Tab]{/yellow-fg}{/bold} Focus Chat/Term │ {bold}{yellow-fg}[F5]{/yellow-fg}{/bold} Demo │ {bold}{yellow-fg}[o]{/yellow-fg}{/bold} Web UI │ {bold}{yellow-fg}[Ctrl+C]{/yellow-fg}{/bold} Cancel/Quit `,
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
        const color = data.user === 'SYSTEM' ? 'yellow-fg' : (data.user === hostName ? 'green-fg' : 'cyan-fg');
        chatLogBox.log(` {${color}}[${time}] ${data.user}:{/${color}}\n   ${data.message}`);
        screen.render();
      } else if (data.type === 'peer:update') {
        updatePeopleBox(data.peers);
      }
    } catch (e) {}
  });

  let focusIndex = 0;
  
  function focusTerminal() {
    focusIndex = 0;
    updateFocusStyles();
    terminalInput.focus();
    terminalInput.readInput();
    screen.render();
  }

  function focusChat() {
    focusIndex = 1;
    updateFocusStyles();
    chatInput.focus();
    chatInput.readInput();
    screen.render();
  }
  
  function updateFocusStyles() {
    if (focusIndex === 0) {
      centerPane.style.border.fg = 'green';
      chatLogBox.style.border.fg = 'blue';
      chatInputBox.style.border.fg = 'grey';
      chatInputBox.setLabel('{grey-fg} ✍️ Chat [/chat or Tab] {/grey-fg}');
    } else {
      centerPane.style.border.fg = 'grey';
      chatLogBox.style.border.fg = 'green';
      chatInputBox.style.border.fg = 'green';
      chatInputBox.setLabel('{bold}{green-fg} ✍️ Chat [Enter: Send, /term: Exit] {/green-fg}{/bold}');
    }
    screen.render();
  }

  function switchFocus() {
    if (focusIndex === 0) {
      focusChat();
    } else {
      focusTerminal();
    }
  }

  screen.key(['tab', 'C-t'], () => {
    switchFocus();
  });

  screen.key(['C-b'], () => {
    toggleSidebar();
  });

  chatInputBox.on('click', focusChat);
  chatLogBox.on('click', focusChat);
  centerPane.on('click', focusTerminal);
  terminalLog.on('click', focusTerminal);

  screen.key(['escape'], () => {
    // Escaping out of prompt is no longer needed
  });

  screen.key(['f5'], () => {
    if (activeProc) return;
    terminalLog.log(`{cyan-fg}SYSTEM>{/cyan-fg} Spawning automated demo...`);
    screen.render();
    const proc = spawn('node', [path.join(TURF_ROOT, 'demo', 'run-demo.js')], { shell: true, cwd: TURF_ROOT });
    
    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        if (line) terminalLog.log(line.trimEnd());
      });
      screen.render();
    });
    proc.stderr.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        if (line) terminalLog.log(`{red-fg}${line.trimEnd()}{/red-fg}`);
      });
      screen.render();
    });
  });

  screen.key(['o'], () => {
    const url = `http://localhost:${port}/?room=${roomCode}&user=${encodeURIComponent(hostName)}`;
    if (process.platform === 'win32') {
      exec(`cmd.exe /c start "" "${url}"`);
    } else {
      exec(`cmd.exe /c start "" "${url}" 2>/dev/null || xdg-open "${url}" 2>/dev/null`);
    }
  });

  screen.key(['C-c'], () => {
    if (activeProc) {
      if (process.platform === 'win32') {
        exec('taskkill /F /T /PID ' + activeProc.pid);
      } else {
        try {
          process.kill(-activeProc.pid, 'SIGKILL');
        } catch (e) {
          activeProc.kill('SIGKILL');
        }
      }
      terminalLog.log(`{red-fg}^C (Interrupted){/red-fg}`);
      activeProc = null;
      promptPrefix.setContent(`{green-fg}${currentCli.prefix}>{/green-fg} `);
      terminalInput.left = promptPrefix.content.replace(/{[^}]+}/g, '').length + 1;
      focusTerminal();
      return;
    }
    
    if (wssInstance) {
      wssInstance.clients.forEach(c => c.close());
      wssInstance.close();
    }
    if (serverInstance) serverInstance.close();
    
    screen.destroy();
    process.exit(0);
  });

  terminalInput.on('submit', (value) => {
    const inputStr = value.trim();
    if (!inputStr && !activeProc) {
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr === '/kill' || inputStr === '/stop') {
      if (activeProc) {
        if (process.platform === 'win32') {
          exec('taskkill /F /T /PID ' + activeProc.pid);
        } else {
          try {
            process.kill(-activeProc.pid, 'SIGKILL');
          } catch (e) {
            activeProc.kill('SIGKILL');
          }
        }
        terminalLog.log(`{red-fg}Process killed manually.{/red-fg}`);
        activeProc = null;
      } else {
        terminalLog.log(`{grey-fg}No active process to kill.{/grey-fg}`);
      }
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (activeProc) {
      activeProc.stdin.write(inputStr + '\n');
      terminalLog.log(`{white-fg}> ${inputStr}{/white-fg}`);
      terminalInput.clearValue();
      focusTerminal();
      return;
    }

    if (inputStr.startsWith('/chat') || inputStr.startsWith('/c ') || inputStr === '/c' || inputStr === 'chat') {
      const msg = inputStr.replace(/^(\/chat|\/c|chat)\s*/, '').trim();
      if (msg) {
        ws.send(JSON.stringify({ type: 'chat:send', user: hostName, message: msg }));
        terminalLog.log(`{cyan-fg}[Chat Sent]:{/cyan-fg} ${msg}`);
      } else {
        terminalLog.log('{cyan-fg}Switched to Team Chat. Type your message below.{/cyan-fg}');
      }
      focusChat();
      terminalInput.clearValue();
      return;
    }

    if (inputStr.startsWith('/term') || inputStr.startsWith('/t ') || inputStr === '/t' || inputStr === 'term') {
      terminalInput.clearValue();
      terminalLog.log('{cyan-fg}ℹ️ You are in the Terminal pane. (Type /chat to switch).{/cyan-fg}');
      focusTerminal();
      return;
    }
    
    if (inputStr === 'cls' || inputStr === 'clear') {
      terminalLog.setContent('');
      printWelcomeBanner();
      terminalInput.clearValue();
      focusTerminal();
      return;
    }
    
    if (inputStr.startsWith('cd ')) {
      const target = inputStr.substring(3).trim();
      currentDir = path.resolve(currentDir, target);
      centerPane.setLabel(`{bold} TERMINAL {/bold}│ {yellow-fg}${currentDir}{/yellow-fg}`);
      terminalLog.log(`{cyan-fg}Directory changed to:{/cyan-fg} {yellow-fg}${currentDir}{/yellow-fg}`);
      terminalInput.clearValue();
      focusTerminal();
      return;
    }
    
    terminalLog.log(`{green-fg}${promptStr}{/green-fg} {yellow-fg}${inputStr}{/yellow-fg}`);
    
    let execCmd = inputStr;
    const isKnownShellCmd = /^(dir|ls|git|npm|cd|cls|node|python|py)\s/i.test(inputStr + ' ') || inputStr.startsWith('!');

    if (inputStr.startsWith('agy "') || inputStr.startsWith('agy <')) {
      const prompt = inputStr.substring(4).replace(/^["<]|[">]$/g, '').trim();
      execCmd = `agy -p "${prompt}" --dangerously-skip-permissions`;
    } else if (inputStr.startsWith('claude "') || inputStr.startsWith('claude <')) {
      const prompt = inputStr.substring(7).replace(/^["<]|[">]$/g, '').trim();
      execCmd = `claude -p "${prompt}" --dangerously-skip-permissions`;
    } else if (inputStr.startsWith('codex "') || inputStr.startsWith('codex <')) {
      const prompt = inputStr.substring(6).replace(/^["<]|[">]$/g, '').trim();
      execCmd = `codex exec "${prompt}"`;
    } else if (currentCli.id !== 'shell' && !isKnownShellCmd) {
      if (currentCli.id === 'agy') execCmd = `agy -p "${inputStr}" --dangerously-skip-permissions`;
      else if (currentCli.id === 'claude') execCmd = `claude -p "${inputStr}" --dangerously-skip-permissions`;
      else if (currentCli.id === 'codex') execCmd = `codex exec "${inputStr}"`;
      else if (currentCli.id === 'opencode') execCmd = `opencode "${inputStr}"`;
    } else if (inputStr.startsWith('!')) {
      execCmd = inputStr.substring(1).trim();
    }
    
    terminalInput.clearValue();
    spawnTerminalProcess(execCmd);
  });

  function spawnTerminalProcess(cmdStr) {
    const isWin = process.platform === 'win32';
    const shellExe = isWin ? 'powershell.exe' : (process.env.SHELL || 'bash');
    const shellArgs = isWin ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmdStr] : ['-c', cmdStr];
    const env = {
      ...process.env,
      CLOUD_CODE_URL: 'https://cloudcode-pa.googleapis.com',
      CLOUD_ENV: 'CLOUD_ENVIRONMENT_PROD'
    };
    
    activeProc = spawn(shellExe, shellArgs, { cwd: currentDir, env, detached: !isWin });
    
    activeProc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        if (line) terminalLog.log(line.trimEnd());
      });
      screen.render();
    });
    
    activeProc.stderr.on('data', (data) => {
      const lines = data.toString().split('\n');
      lines.forEach(line => {
        if (line) terminalLog.log(`{red-fg}${line.trimEnd()}{/red-fg}`);
      });
      screen.render();
    });
    
    activeProc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        terminalLog.log(`{grey-fg}Process exited with code ${code}{/grey-fg}`);
      }
      activeProc = null;
      promptPrefix.setContent(`{green-fg}${currentCli.prefix}>{/green-fg} `);
      terminalInput.left = promptPrefix.content.replace(/{[^}]+}/g, '').length + 1;
      focusTerminal();
    });
    focusTerminal();
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

  focusTerminal();
}
