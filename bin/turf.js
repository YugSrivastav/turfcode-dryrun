#!/usr/bin/env node

import readline from 'readline';
import { spawnHostDaemon, getLocalIp, killProcessOnPort } from '../server/index.js';
import { connectToHost } from '../server/rooms.js';
import { launchTUI } from '../server/tui.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync, exec } from 'child_process';
import chalk from 'chalk';
import 'dotenv/config';
import { fileURLToPath } from 'url';
import { isAgentAvailable } from '../server/pty_manager.js';
import { syncWorkspaceFromHost } from '../server/sync.js';

const brandTurf = chalk.hex('#BBE15A').bold;
const brandCode = chalk.hex('#FFFFFF').bold;
const accent = chalk.hex('#BBE15A');
const dim = chalk.hex('#8B949E');
const bright = chalk.hex('#FFFFFF').bold;
const border = chalk.hex('#30363D');

process.on('uncaughtException', (err) => {
  try {
    const logLine = `[${new Date().toISOString()}] Uncaught Exception: ${err.stack || err}\n`;
    fs.appendFileSync(path.join(process.cwd(), 'turf-error.log'), logLine);
  } catch (e) {}
  console.error('\n❌ Uncaught error:', err);
});

process.on('unhandledRejection', (reason) => {
  try {
    const logLine = `[${new Date().toISOString()}] Unhandled Rejection: ${reason && (reason.stack || reason)}\n`;
    fs.appendFileSync(path.join(process.cwd(), 'turf-error.log'), logLine);
  } catch (e) {}
  console.error('\n❌ Unhandled rejection:', reason);
});

let rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});
readline.emitKeypressEvents(process.stdin);

function cleanupStdinForBlessed() {
  try {
    rl.close();
  } catch (e) {}
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
}

function resetRl() {
  try {
    rl.close();
  } catch (e) {}
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  rl.on('SIGINT', () => {
    process.stdout.write('\x1b[?1049l\x1b[?25h');
    process.exit(0);
  });
}

rl.on('SIGINT', () => {
  process.stdout.write('\x1b[?1049l\x1b[?25h');
  process.exit(0);
});

const args = process.argv.slice(2);

if (process.platform === 'win32') {
  try {
    execSync('chcp 65001', { stdio: 'ignore' });
  } catch (e) {}
}

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function center(str) {
  const width = process.stdout.columns || 80;
  const visibleLen = stripAnsi(str).length;
  const leftPad = Math.max(0, Math.floor((width - visibleLen) / 2));
  return ' '.repeat(leftPad) + str;
}

function getBlockPad(blockWidth = 58) {
  const width = process.stdout.columns || 80;
  const leftPad = Math.max(2, Math.floor((width - blockWidth) / 2));
  return ' '.repeat(leftPad);
}

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

function getTopPad(totalLines = 14) {
  const height = process.stdout.rows || 24;
  return Math.max(1, Math.floor((height - totalLines) / 2));
}

function printLogo() {
  const l1 = brandTurf(' _____ _   _ ___  ___  ') + brandCode('  ___ ___  ___  ___ ');
  const l2 = brandTurf('|_   _| | | | _ \\| __| ') + brandCode(' / __/ _ \\|   \\| __|');
  const l3 = brandTurf('  | | | |_| |   /| _|  ') + brandCode('| (_| (_) | |) | _| ');
  const l4 = brandTurf('  |_|  \\___/|_|_\\|_|   ') + brandCode(' \\___\\___/|___/|___|');
  console.log(center(l1));
  console.log(center(l2));
  console.log(center(l3));
  console.log(center(l4));
}

let _cachedAgents = null;
function detectInstalledAgents() {
  if (_cachedAgents) return _cachedAgents;
  _cachedAgents = {
    agy: isAgentAvailable('agy'),
    codex: isAgentAvailable('codex')
  };
  return _cachedAgents;
}

function printBanner() {
  clearScreen();
  console.log('\n'.repeat(getTopPad(17)));
  printLogo();
  console.log('');
  console.log(center(accent('●') + ' ' + dim('The Real-Time Intent Network for Multi-Agent Coding') + ' ' + brandTurf('v1.0')));
  console.log(center(border('──────────────────────────────────────────────────────────')));
  console.log('');

  const agents = detectInstalledAgents();
  const pad = getBlockPad(58);
  console.log(pad + dim('Coding Agents Detected:'));
  console.log(pad + '  ' + (agents.agy ? accent('●') + ' ' + bright('Antigravity (agy)    ') + accent('[INSTALLED]') : dim('○ Antigravity (agy)    [NOT FOUND]')));
  console.log(pad + '  ' + (agents.codex ? chalk.cyan('●') + ' ' + bright('OpenAI Codex (codex) ') + chalk.cyan('[INSTALLED]') : dim('○ OpenAI Codex (codex) [NOT FOUND - fallback available]')));
  console.log('');
  console.log(pad + brandTurf('[1]') + ' ' + bright('Create Turf') + '  ' + dim('— Host a new collaborative session'));
  console.log(pad + brandTurf('[2]') + ' ' + bright('Join Turf  ') + '  ' + dim('— Connect to an existing team room'));
  console.log('');
}

function printSetupHeader(title, subtitle) {
  clearScreen();
  console.log('\n'.repeat(getTopPad(13)));
  printLogo();
  console.log('');
  console.log(center(accent('●') + ' ' + bright(title) + '  ' + dim(subtitle) + '  ' + dim('[Esc: Back]')));
  console.log(center(border('──────────────────────────────────────────────────────────')));
  console.log('');
}

async function prompt(question) {
  return new Promise((resolve) => {
    let resolved = false;
    const cleanup = () => {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.removeListener('data', onData);
    };
    const onKeypress = (str, key) => {
      if (key && key.ctrl && key.name === 'c') {
        cleanup();
        process.stdout.write('\x1b[?1049l\x1b[?25h');
        process.exit(0);
      }
      if (key && (key.name === 'escape' || key.sequence === '\x1b')) {
        cleanup();
        resetRl();
        resolved = true;
        resolve('__BACK__');
      }
    };
    const onData = (data) => {
      const s = data.toString();
      // ponytail: lone ESC only — focus/mouse/arrow sequences (\x1b[.., \x1bO..) must not bounce to start
      if (s === '\x1b') {
        cleanup();
        resetRl();
        resolved = true;
        resolve('__BACK__');
      }
      if (s === '\x03' || s.includes('\x03')) {
        cleanup();
        process.stdout.write('\x1b[?1049l\x1b[?25h');
        process.exit(0);
      }
    };
    process.stdin.on('keypress', onKeypress);
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      if (!resolved) {
        cleanup();
        const trimmed = answer.trim();
        if (['b', 'back', 'esc', 'exit'].includes(trimmed.toLowerCase())) {
          resetRl();
          resolve('__BACK__');
        } else {
          resolve(trimmed);
        }
      }
    });
  });
}

async function normalizeAndValidatePath(input, promptFn, pad = '') {
  while (true) {
    if (input === '__BACK__') return '__BACK__';
    let clean = (input || '.').trim();
    clean = clean.replace(/^(&\s*)?["']|["']$/g, '').trim();
    clean = clean.replace(/^["']|["']$/g, '').trim();
    if (clean.toLowerCase() === 'back' || clean.toLowerCase() === 'b' || clean.toLowerCase() === 'esc') {
      return '__BACK__';
    }
    if (clean.startsWith('~')) {
      clean = path.join(os.homedir(), clean.slice(1));
    }
    clean = clean.replace(/%([^%]+)%/g, (_, n) => process.env[n] || '');
    
    let resolvedPath = path.resolve(clean);
    
    if (process.platform !== 'win32' && clean.match(/^[a-zA-Z]:[\\/]/)) {
      const drive = clean[0].toLowerCase();
      const rest = clean.substring(2).replace(/\\/g, '/');
      const wslPath = path.join('/mnt', drive, rest);
      if (fs.existsSync(wslPath)) {
        resolvedPath = wslPath;
      }
    }
    
    if (!fs.existsSync(resolvedPath)) {
      const answer = await promptFn(`\n${pad}⚠️  Folder does not exist: "${resolvedPath}". Create it? [y/N]: `);
      if (answer === '__BACK__') return '__BACK__';
      if (answer.toLowerCase() === 'y') {
        try {
          fs.mkdirSync(resolvedPath, { recursive: true });
        } catch (err) {
          console.log(`\n${pad}❌ Failed to create directory: ${err.message}\n`);
          input = await promptFn(`${pad}› Path to project/repo [default: .]: `);
          continue;
        }
      } else {
        input = await promptFn(`${pad}› Path to project/repo [default: .]: `);
        continue;
      }
    }
    
    if (!fs.statSync(resolvedPath).isDirectory()) {
      const parent = path.dirname(resolvedPath);
      const answer = await promptFn(`\n${pad}⚠️  "${resolvedPath}" is a file, not a directory. Use parent folder: "${parent}"? [Y/n]: `);
      if (answer === '__BACK__') return '__BACK__';
      if (answer.toLowerCase() !== 'n') {
        resolvedPath = parent;
      } else {
        input = await promptFn(`${pad}› Path to project/repo [default: .]: `);
        continue;
      }
    }
    
    try {
      fs.accessSync(resolvedPath, fs.constants.W_OK);
    } catch (err) {
      console.log(`\n${pad}❌ No write permission for directory: "${resolvedPath}"\n`);
      input = await promptFn(`${pad}› Path to project/repo [default: .]: `);
      continue;
    }
    
    if (!fs.existsSync(path.join(resolvedPath, '.git'))) {
      try {
        execSync('git init', { cwd: resolvedPath, stdio: 'ignore' });
        console.log(`${pad}ℹ️  Initialized git repository in ${resolvedPath}`);
      } catch (err) {
        console.log(`\n${pad}⚠️  Failed to initialize git repository: ${err.message}`);
      }
    }
    
    return resolvedPath;
  }
}

// LLM providers the Turf agent can call (env names per Pi provider docs).
const TURF_PROVIDERS = [
  { label: 'Google Gemini Studio (FREE tier - 1,000,000 TPM - Recommended)', env: 'GEMINI_API_KEY' },
  { label: 'Groq (FREE tier - 20,000 TPM)', env: 'GROQ_API_KEY' },
  { label: 'Anthropic', env: 'ANTHROPIC_API_KEY' },
  { label: 'OpenAI', env: 'OPENAI_API_KEY' },
  { label: 'DeepSeek', env: 'DEEPSEEK_API_KEY' },
  { label: 'OpenRouter', env: 'OPENROUTER_API_KEY' },
  { label: 'Cerebras (free tier)', env: 'CEREBRAS_API_KEY' }
];

// ponytail: session env + gitignored .env write, no keyring abstractions
const TURF_KEY_MARKER = path.join(os.homedir(), '.turf', 'key-setup-done');

function hasAnyConfiguredKey(destDir) {
  const envFile = path.join(destDir || process.cwd(), '.env');
  const globalEnv = path.join(os.homedir(), '.turf', '.env');
  let envContent = '';
  try {
    if (fs.existsSync(envFile)) envContent += fs.readFileSync(envFile, 'utf8') + '\n';
  } catch {}
  try {
    if (fs.existsSync(globalEnv)) envContent += fs.readFileSync(globalEnv, 'utf8') + '\n';
  } catch {}
  return TURF_PROVIDERS.some((p) => (process.env[p.env] && process.env[p.env].trim()) || new RegExp(`^${p.env}=.+`, 'm').test(envContent));
}

function keySetupDone() {
  return hasAnyConfiguredKey(process.cwd());
}

function markKeySetupDone() {
  try {
    fs.mkdirSync(path.dirname(TURF_KEY_MARKER), { recursive: true });
    fs.writeFileSync(TURF_KEY_MARKER, new Date().toISOString(), 'utf8');
  } catch {}
}

function writeKeyToEnv(targetFile, envVar, keyVal) {
  try {
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    let content = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8') : '';
    if (!content.endsWith('\n') && content.length > 0) content += '\n';

    if (envVar === 'GROQ_API_KEY') {
      const existingGroq = process.env.GROQ_API_KEY;
      if (existingGroq && existingGroq !== keyVal) {
        let keysList = process.env.GROQ_API_KEYS ? process.env.GROQ_API_KEYS.split(',').map(k => k.trim()).filter(Boolean) : [existingGroq];
        if (!keysList.includes(keyVal)) keysList.push(keyVal);
        const keysStr = keysList.join(',');
        process.env.GROQ_API_KEYS = keysStr;
        const multiRe = /^GROQ_API_KEYS=.*$/m;
        content = multiRe.test(content)
          ? content.replace(multiRe, `GROQ_API_KEYS=${keysStr}`)
          : content + `GROQ_API_KEYS=${keysStr}\n`;
      }
    }

    const lineRe = new RegExp(`^${envVar}=.*$`, 'm');
    content = lineRe.test(content)
      ? content.replace(lineRe, `${envVar}=${keyVal}`)
      : content + `${envVar}=${keyVal}\n`;

    fs.writeFileSync(targetFile, content, 'utf8');
  } catch (err) {}
}

async function setupTurfApiKey(promptFn, pad, destDir, force = false) {
  const envFile = path.join(destDir || process.cwd(), '.env');
  const globalEnv = path.join(os.homedir(), '.turf', '.env');
  let envContent = '';
  try {
    if (fs.existsSync(envFile)) envContent += fs.readFileSync(envFile, 'utf8') + '\n';
  } catch {}
  try {
    if (fs.existsSync(globalEnv)) envContent += fs.readFileSync(globalEnv, 'utf8') + '\n';
  } catch {}

  const hasKey = hasAnyConfiguredKey(destDir);
  if (!force && hasKey) {
    const askMore = await promptFn('\n' + pad + accent('›') + ' ' + bright('API key already configured. Do you want to add more keys?') + dim(' [y/N]: '));
    if (askMore === '__BACK__') return '__BACK__';
    if (askMore.toLowerCase() !== 'y' && askMore.toLowerCase() !== 'yes') {
      return 'skipped';
    }
  }

  const finish = (res) => { markKeySetupDone(); return res; };

  while (true) {
    envContent = '';
    try {
      if (fs.existsSync(envFile)) envContent += fs.readFileSync(envFile, 'utf8') + '\n';
    } catch {}
    try {
      if (fs.existsSync(globalEnv)) envContent += fs.readFileSync(globalEnv, 'utf8') + '\n';
    } catch {}

    console.log('\n' + pad + bright('Turf agent LLM key') + ' ' + dim('(BYOK — saved to .env, never git)'));
    TURF_PROVIDERS.forEach((p, i) => {
      const isConfigured = !!(process.env[p.env] && process.env[p.env].trim()) || new RegExp(`^${p.env}=.+`, 'm').test(envContent);
      const tag = isConfigured ? chalk.green(' [Configured]') : '';
      console.log(pad + '  ' + brandTurf(`[${i + 1}]`) + ' ' + p.label + tag);
    });
    console.log(pad + '  ' + dim(`[${TURF_PROVIDERS.length + 1}] Done / Skip`));

    const choice = await promptFn(pad + accent('›') + ' ' + bright('Pick a provider') + dim(` [1-${TURF_PROVIDERS.length + 1}]: `));
    if (choice === '__BACK__') return '__BACK__';
    const idx = parseInt(choice, 10);
    if (!idx || idx < 1 || idx > TURF_PROVIDERS.length + 1 || idx === TURF_PROVIDERS.length + 1) {
      return finish('skipped');
    }

    const provider = TURF_PROVIDERS[idx - 1];
    const key = await promptFn(pad + accent('›') + ' ' + bright(`Paste ${provider.env}`) + ' ' + dim('(input visible, Enter to save): '));
    if (key === '__BACK__') return '__BACK__';
    if (!key.trim()) continue;

    const trimmedKey = key.trim();
    process.env[provider.env] = trimmedKey;

    try {
      writeKeyToEnv(envFile, provider.env, trimmedKey);
      writeKeyToEnv(globalEnv, provider.env, trimmedKey);
      console.log(pad + accent('●') + ' ' + dim(`Saved ${provider.env} to .env and global ~/.turf/.env`));
    } catch (err) {
      console.log(pad + dim(`(session-only: could not write .env — ${err.message})`));
    }

    const another = await promptFn(pad + accent('›') + ' ' + bright('Do you want to add another key?') + dim(' [y/N]: '));
    if (another === '__BACK__') return finish(provider.env);
    if (another.toLowerCase() !== 'y' && another.toLowerCase() !== 'yes') {
      return finish(provider.env);
    }
  }
}

async function main() {
  if (args.includes('--key')) {
    // On-demand key setup (onboarding asks only once ever)
    const pad = getBlockPad(58);
    const res = await setupTurfApiKey((q) => prompt(q), pad, process.cwd(), true);
    console.log(res === '__BACK__' ? 'Cancelled.' : res === 'skipped' ? 'No changes.' : `Active: ${res} (restart Turf to apply)`);
    rl.close();
    process.exit(0);
  }

  if (args.includes('kill') || args.includes('stop') || args.includes('clean') || args.includes('--kill')) {
    rl.close();
    console.log('Killing any stale Turfcode process on port 7873...');
    killProcessOnPort(7873);
    console.log('Done.');
    process.exit(0);
  }

  // Switch to alternate screen buffer immediately for a clean fullscreen app experience
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[3J\x1b[H');
  const restoreScreen = () => {
    process.stdout.write('\x1b[?1049l\x1b[?25h');
  };
  process.on('SIGINT', () => {
    restoreScreen();
    process.exit(0);
  });
  process.on('exit', () => {
    restoreScreen();
  });

  const flags = {
    host: args.includes('--host'),
    join: args.includes('--join') ? args[args.indexOf('--join') + 1] : null,
    name: args.includes('--name') ? args[args.indexOf('--name') + 1] : null,
    port: args.includes('--port') ? parseInt(args[args.indexOf('--port') + 1], 10) : 7873,
    tunnel: args.includes('--tunnel'),
    forceKill: args.includes('--force') || args.includes('-f')
  };

  if (flags.host) {
    const repoPath = process.cwd();
    const daemon = await spawnHostDaemon({ hostName: flags.name || 'Host', repoPath, port: flags.port, tunnel: flags.tunnel, forceKill: flags.forceKill });
    cleanupStdinForBlessed();
    launchTUI({ hostName: flags.name || 'Host', roomCode: daemon.room.code, repoPath, port: daemon.port, localIp: getLocalIp(), hostAddress: '127.0.0.1', isPeer: false, serverInstance: daemon.server, wssInstance: daemon.wss });
    return;
  }

  if (flags.join) {
    let hostIp = flags.join;
    let targetPort = flags.port;
    if (hostIp.includes(':')) {
      const parts = hostIp.split(':');
      hostIp = parts[0];
      targetPort = parseInt(parts[1], 10);
    }
    let detectedRoomCode = 'SYNC';
    try {
      const roomRes = await fetch(`http://${hostIp}:${targetPort}/api/room`, { signal: AbortSignal.timeout(5000) });
      if (roomRes.ok) {
        const meta = await roomRes.json();
        if (meta && meta.code) detectedRoomCode = meta.code;
      }
    } catch (e) {}
    let peerRepoPath = path.join(os.homedir(), '.turf', 'rooms', detectedRoomCode, 'repo');
    try {
      await syncWorkspaceFromHost(hostIp, targetPort, peerRepoPath, (received, total) => {
        const mb = (received / 1024 / 1024).toFixed(1);
        process.stdout.write(`\rDownloading workspace: ${mb} MB...`);
      });
      process.stdout.write('\n');
    } catch (e) {
      console.error(`\n❌ Could not synchronize workspace from host (${e.message}).`);
      peerRepoPath = process.cwd();
    }
    cleanupStdinForBlessed();
    launchTUI({ hostName: flags.name || 'Peer', roomCode: detectedRoomCode, repoPath: peerRepoPath, port: targetPort, hostAddress: hostIp, isPeer: true });
    return;
  }

  while (true) {
    let option = '';
    while (option !== '1' && option !== '2') {
      printBanner();
      const pad = getBlockPad(58);
      option = await prompt(pad + accent('›') + ' ' + bright('Select an option') + ' ' + dim('[1/2]: '));
      if (option === '__BACK__') {
        continue;
      }
    }

    const pad = getBlockPad(58);

    if (option === '1') {
      printSetupHeader('Host Collaborative Session', '— Create a team room');
      const defaultName = os.userInfo()?.username || 'Host';
      const hostNameInput = await prompt(pad + accent('›') + ' ' + bright('Enter your name') + dim(` [default: ${defaultName}]: `));
      if (hostNameInput === '__BACK__') continue;
      const hostName = hostNameInput.trim() || defaultName;

      const repoPathInput = await prompt(pad + accent('›') + ' ' + bright('Path to project/repo') + ' ' + dim('[default: .]: '));
      if (repoPathInput === '__BACK__') continue;
      const targetPath = await normalizeAndValidatePath(repoPathInput, (q) => prompt(q), pad);
      if (targetPath === '__BACK__') continue;

      const keyRes = await setupTurfApiKey((q) => prompt(q), pad, targetPath);
      if (keyRes === '__BACK__') continue;
      
      console.log('\n' + pad + accent('●') + ' ' + dim(`Starting daemon on port ${flags.port}...`));
      const daemon = await spawnHostDaemon({ hostName, repoPath: targetPath, port: flags.port, tunnel: flags.tunnel, forceKill: flags.forceKill });
      cleanupStdinForBlessed();
      try {
        launchTUI({ hostName, roomCode: daemon.room.code, repoPath: targetPath, port: daemon.port, localIp: getLocalIp(), hostAddress: '127.0.0.1', isPeer: false, serverInstance: daemon.server, wssInstance: daemon.wss, detectedAgents: detectInstalledAgents() });
      } catch (err) {
        process.stdout.write('\x1b[?1049l\x1b[?25h');
        console.error('\n❌ Fatal error launching Turf TUI:', err);
        try {
          fs.appendFileSync(path.join(targetPath, 'turf-error.log'), `[TUI Launch Error] ${err.stack || err}\n`);
        } catch (e) {}
        process.exit(1);
      }
      break;
    } else if (option === '2') {
      printSetupHeader('Join Collaborative Session', '— Connect to a team room');
      const joinAddress = await prompt(pad + accent('›') + ' ' + bright('Enter Host IP or IP:port') + ' ' + dim('[e.g. 192.168.1.50:7873]: '));
      if (joinAddress === '__BACK__') continue;
      let hostIp = joinAddress.trim() || '127.0.0.1';
      let targetPort = flags.port;
      if (hostIp.includes(':')) {
        const parts = hostIp.split(':');
        hostIp = parts[0];
        targetPort = parseInt(parts[1], 10);
      }
      const defaultPeer = os.userInfo()?.username || 'Peer';
      const userNameInput = await prompt(pad + accent('›') + ' ' + bright('Enter your name') + dim(` [default: ${defaultPeer}]: `));
      if (userNameInput === '__BACK__') continue;
      const userName = userNameInput.trim() || defaultPeer;

      const keyRes = await setupTurfApiKey((q) => prompt(q), pad, process.cwd());
      if (keyRes === '__BACK__') continue;
      
      let syncSuccess = false;
      let peerRepoPath = '';

      while (!syncSuccess) {
        console.log('\n' + pad + accent('●') + ' ' + dim(`Connecting and synchronizing repository from ${hostIp}:${targetPort}...`));
        let detectedRoomCode = 'SYNC';
        try {
          const roomRes = await fetch(`http://${hostIp}:${targetPort}/api/room`, { signal: AbortSignal.timeout(5000) });
          if (roomRes.ok) {
            const meta = await roomRes.json();
            if (meta && meta.code) detectedRoomCode = meta.code;
          }
        } catch (e) {}

        peerRepoPath = path.join(os.homedir(), '.turf', 'rooms', detectedRoomCode, 'repo');

        let lastProgressLine = '';
        const onProgress = (received, total) => {
          const mbReceived = (received / 1024 / 1024).toFixed(1);
          let progressStr = '';
          if (total > 0) {
            const mbTotal = (total / 1024 / 1024).toFixed(1);
            const pct = Math.min(100, Math.floor((received / total) * 100));
            const barWidth = 20;
            const filled = Math.floor((pct / 100) * barWidth);
            const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
            progressStr = `[${bar}] ${pct}% (${mbReceived} MB / ${mbTotal} MB)`;
          } else {
            progressStr = `(${mbReceived} MB received)`;
          }
          lastProgressLine = pad + accent('↓') + ' ' + bright('Downloading workspace: ') + dim(progressStr);
          process.stdout.write(`\r${lastProgressLine}`);
        };

        try {
          const files = await syncWorkspaceFromHost(hostIp, targetPort, peerRepoPath, onProgress);
          if (lastProgressLine) process.stdout.write('\n');
          console.log(pad + accent('✓') + ' ' + dim(`Workspace synchronized (${files.length} files) at ${peerRepoPath}`));
          syncSuccess = true;
        } catch (err) {
          if (lastProgressLine) process.stdout.write('\n');
          console.log('\n' + pad + chalk.red('❌ Workspace sync failed:') + ' ' + dim(err.message));
          console.log(pad + bright('Options:'));
          console.log(pad + '  ' + brandTurf('[1]') + ' Retry download from host');
          console.log(pad + '  ' + brandTurf('[2]') + ' Select existing local folder/clone on your PC');
          console.log(pad + '  ' + brandTurf('[3]') + ' Cancel / Back');

          const failChoice = await prompt(pad + accent('›') + ' ' + bright('Action') + dim(' [1/2/3]: '));
          if (failChoice === '__BACK__' || failChoice === '3') {
            break;
          }
          if (failChoice === '2') {
            const customPathInput = await prompt(pad + accent('›') + ' ' + bright('Path to local project/repo') + ' ' + dim('[default: .]: '));
            if (customPathInput === '__BACK__') break;
            const chosenPath = await normalizeAndValidatePath(customPathInput, (q) => prompt(q), pad);
            if (chosenPath === '__BACK__') break;
            peerRepoPath = chosenPath;
            syncSuccess = true;
          }
          // Option 1 loops and retries download
        }
      }

      if (!syncSuccess) {
        continue;
      }

      cleanupStdinForBlessed();
      try {
        launchTUI({ hostName: userName, roomCode: detectedRoomCode, repoPath: peerRepoPath, port: targetPort, hostAddress: hostIp, isPeer: true, detectedAgents: detectInstalledAgents() });
      } catch (err) {
        process.stdout.write('\x1b[?1049l\x1b[?25h');
        console.error('\n❌ Fatal error connecting to session:', err);
        process.exit(1);
      }
      break;
    }
  }
}

const isMain = process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('turf.js') ||
  process.argv[1].endsWith('turf')
);

if (isMain) {
  main().catch(err => {
    process.stdout.write('\x1b[?1049l\x1b[?25h');
    console.error('Turfcode Startup Error:', err);
    process.exit(1);
  });
}

export { normalizeAndValidatePath, setupTurfApiKey, hasAnyConfiguredKey, TURF_PROVIDERS };
