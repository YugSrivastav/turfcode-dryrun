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
import { isAgentAvailable } from '../server/pty_manager.js';

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
});

process.on('unhandledRejection', (reason) => {
  try {
    const logLine = `[${new Date().toISOString()}] Unhandled Rejection: ${reason && (reason.stack || reason)}\n`;
    fs.appendFileSync(path.join(process.cwd(), 'turf-error.log'), logLine);
  } catch (e) {}
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
      if (s === '\x1b' || s.startsWith('\x1b')) {
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
    let clean = input || '.';
    clean = clean.replace(/^(&\s*)?["']|["']$/g, '').trim();
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

async function main() {
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
    cleanupStdinForBlessed();
    launchTUI({ hostName: flags.name || 'Peer', roomCode: 'TRF-XXXX', repoPath: 'Remote Sync', port: targetPort, hostAddress: hostIp, isPeer: true });
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
      
      console.log('\n' + pad + accent('●') + ' ' + dim(`Starting daemon on port ${flags.port}...`));
      const daemon = await spawnHostDaemon({ hostName, repoPath: targetPath, port: flags.port, tunnel: flags.tunnel, forceKill: flags.forceKill });
      cleanupStdinForBlessed();
      launchTUI({ hostName, roomCode: daemon.room.code, repoPath: targetPath, port: daemon.port, localIp: getLocalIp(), hostAddress: '127.0.0.1', isPeer: false, serverInstance: daemon.server, wssInstance: daemon.wss, detectedAgents: detectInstalledAgents() });
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
      
      console.log('\n' + pad + accent('●') + ' ' + dim(`Connecting to ${hostIp}:${targetPort}...`));
      cleanupStdinForBlessed();
      launchTUI({ hostName: userName, roomCode: 'SYNC', repoPath: 'Remote Sync', port: targetPort, hostAddress: hostIp, isPeer: true, detectedAgents: detectInstalledAgents() });
      break;
    }
  }
}

main().catch(err => {
  process.stdout.write('\x1b[?1049l\x1b[?25h');
  console.error('Turfcode Startup Error:', err);
  process.exit(1);
});
