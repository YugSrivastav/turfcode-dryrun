#!/usr/bin/env node

import readline from 'readline';
import { spawnHostDaemon, getLocalIp, killProcessOnPort } from '../server/index.js';
import { connectToHost } from '../server/rooms.js';
import { launchTUI } from '../server/tui.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync, exec } from 'child_process';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const args = process.argv.slice(2);

function printBanner() {
  console.log(`
╔═════════════════════════════════════════════════════════════╗
║                     WELCOME TO TURFCODE                     ║
║    The Real-Time Intent Network for Multi-Agent Coding      ║
╚═════════════════════════════════════════════════════════════╝
`);
}

async function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function normalizeAndValidatePath(input, promptFn) {
  while (true) {
    let clean = input || '.';
    clean = clean.replace(/^(&\s*)?["']|["']$/g, '').trim();
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
      const answer = await promptFn(`\n⚠️ Folder does not exist: "${resolvedPath}". Create it? [y/N]: `);
      if (answer.toLowerCase() === 'y') {
        try {
          fs.mkdirSync(resolvedPath, { recursive: true });
        } catch (err) {
          console.log(`\n❌ Failed to create directory: ${err.message}\n`);
          input = await promptFn('  > Path to project/repo to collaborate on [default: .]: ');
          continue;
        }
      } else {
        input = await promptFn('  > Path to project/repo to collaborate on [default: .]: ');
        continue;
      }
    }
    
    if (!fs.statSync(resolvedPath).isDirectory()) {
      const parent = path.dirname(resolvedPath);
      const answer = await promptFn(`\n⚠️ "${resolvedPath}" is a file, not a directory. Use parent folder: "${parent}"? [Y/n]: `);
      if (answer.toLowerCase() !== 'n') {
        resolvedPath = parent;
      } else {
        input = await promptFn('  > Path to project/repo to collaborate on [default: .]: ');
        continue;
      }
    }
    
    try {
      fs.accessSync(resolvedPath, fs.constants.W_OK);
    } catch (err) {
      console.log(`\n❌ No write permission for directory: "${resolvedPath}"\n`);
      input = await promptFn('  > Path to project/repo to collaborate on [default: .]: ');
      continue;
    }
    
    if (!fs.existsSync(path.join(resolvedPath, '.git'))) {
      try {
        execSync('git init', { cwd: resolvedPath, stdio: 'ignore' });
        console.log(`ℹ️ Initialized git repository in ${resolvedPath}`);
      } catch (err) {
        console.log(`\n⚠️ Failed to initialize git repository: ${err.message}`);
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
    rl.close();
    process.stdin.removeAllListeners('data');
    process.stdin.removeAllListeners('keypress');
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
    rl.close();
    process.stdin.removeAllListeners('data');
    process.stdin.removeAllListeners('keypress');
    launchTUI({ hostName: flags.name || 'Peer', roomCode: 'TRF-XXXX', repoPath: 'Remote Sync', port: targetPort, hostAddress: hostIp, isPeer: true });
    return;
  }

  printBanner();
  console.log('  [1] Create Turf  (Host a new collaborative session)');
  console.log('  [2] Join Turf    (Connect to an existing team room)\n');
  
  const option = await prompt('  > Select an option [1/2]: ');
  
  if (option === '1') {
    const hostName = await prompt('  > Enter your name: ');
    if (process.platform === 'win32') {
      exec('explorer.exe .');
    } else {
      exec('cmd.exe /c start explorer.exe . 2>/dev/null || explorer.exe . 2>/dev/null || xdg-open . 2>/dev/null');
    }
    const repoPathInput = await prompt('  > Path to project/repo to collaborate on [default: .]: ');
    const targetPath = await normalizeAndValidatePath(repoPathInput, prompt);
    
    const daemon = await spawnHostDaemon({ hostName, repoPath: targetPath, port: flags.port, tunnel: flags.tunnel, forceKill: flags.forceKill });
    rl.close();
    process.stdin.removeAllListeners('data');
    process.stdin.removeAllListeners('keypress');
    launchTUI({ hostName, roomCode: daemon.room.code, repoPath: targetPath, port: daemon.port, localIp: getLocalIp(), hostAddress: '127.0.0.1', isPeer: false, serverInstance: daemon.server, wssInstance: daemon.wss });
  } else if (option === '2') {
    const joinAddress = await prompt('  > Enter Host IP or IP:port [e.g. 192.168.1.50:7873]: ');
    let hostIp = joinAddress.trim() || '127.0.0.1';
    let targetPort = flags.port;
    if (hostIp.includes(':')) {
      const parts = hostIp.split(':');
      hostIp = parts[0];
      targetPort = parseInt(parts[1], 10);
    }
    const userName = await prompt('  > Enter your name: ');
    rl.close();
    process.stdin.removeAllListeners('data');
    process.stdin.removeAllListeners('keypress');
    launchTUI({ hostName: userName, roomCode: 'SYNC', repoPath: 'Remote Sync', port: targetPort, hostAddress: hostIp, isPeer: true });
  } else {
    console.log('Invalid option.');
    rl.close();
    process.stdin.removeAllListeners('data');
    process.stdin.removeAllListeners('keypress');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
