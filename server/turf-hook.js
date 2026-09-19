#!/usr/bin/env node
// turf-hook: PreToolUse intent-lock helper for the Turf agent fork.
// The fork shells out before every write/edit/bash:
//   node turf-hook.js --daemon http://192.168.1.15:7873 --room TRF-4829 \
//     --user Yug --agent turf --file src/checkout.js
// Exit 0 = granted (write to main), exit 2 = conflict (fork to worktreePath),
// exit 1 = hook error (fail open: proceed, daemon unreachable).
// ponytail: thin fetch wrapper over /api/locks, no deps beyond node 20 global fetch.

import fs from 'fs';
import os from 'os';
import path from 'path';

const args = process.argv.slice(2);
const get = (flag, fallback = null) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const daemon = (get('--daemon', 'http://127.0.0.1:7873') || '').replace(/\/$/, '');
const room = get('--room', 'TRF-XXXX');
const user = get('--user', 'turf');
const agentId = get('--agent', 'turf');
const rawFilePath = get('--file');
const release = args.includes('--release');
const syncWorktree = args.includes('--sync-worktree');
const tier = parseInt(get('--tier', '1'), 10);

if (!rawFilePath) {
  console.error(JSON.stringify({ status: 'error', message: 'missing --file' }));
  process.exit(1);
}

const filePath = rawFilePath.replace(/\\/g, '/');

try {
  if (syncWorktree) {
    let content = get('--content');
    if (content === null || content === undefined) {
      if (fs.existsSync(rawFilePath)) {
        content = fs.readFileSync(rawFilePath, 'utf8');
      } else {
        const localWorktree = path.join(os.tmpdir(), 'turf-worktrees', room, agentId);
        const localFile = path.join(localWorktree, filePath);
        content = fs.existsSync(localFile) ? fs.readFileSync(localFile, 'utf8') : '';
      }
    }
    const res = await fetch(`${daemon}/api/locks/worktree`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath, agentId, room, user, content }),
      signal: AbortSignal.timeout(3000)
    });
    const data = await res.json();
    console.log(JSON.stringify(data));
    process.exit(0);
  }

  const isRemoteDaemon = Boolean(
    args.includes('--remote') ||
    (daemon && !daemon.includes('127.0.0.1') && !daemon.includes('localhost'))
  );
  const endpoint = release ? `${daemon}/api/locks/release` : `${daemon}/api/locks/request`;
  const body = release
    ? { filePath, agentId }
    : { filePath, agentId, user, priorityTier: tier, room, pid: process.pid, isRemote: isRemoteDaemon, remotePeer: isRemoteDaemon };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000)
  });
  const data = await res.json();
  
  if (!release && data.status === 'conflict') {
    // Client-local worktree guarantee for cross-laptop/cross-platform peer execution
    const localWorktree = path.join(os.tmpdir(), 'turf-worktrees', room, agentId).replace(/\\/g, '/');
    try {
      fs.mkdirSync(localWorktree, { recursive: true });
      const localWorktreeFile = path.join(localWorktree, filePath);
      fs.mkdirSync(path.dirname(localWorktreeFile), { recursive: true });
      // Cold-start seed: copy existing file into local worktree if available
      if (!fs.existsSync(localWorktreeFile) && fs.existsSync(rawFilePath)) {
        fs.copyFileSync(rawFilePath, localWorktreeFile);
      }
      data.localWorktreePath = localWorktree;
    } catch (e) {}
    console.log(JSON.stringify(data));
    process.exit(2);
  }

  console.log(JSON.stringify(data));
  process.exit(0);
} catch (err) {
  // fail open: never block the agent on hook infra failure
  console.error(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
}
