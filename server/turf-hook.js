#!/usr/bin/env node
// turf-hook: PreToolUse intent-lock helper for the Turf agent fork.
// The fork shells out before every write/edit/bash:
//   node turf-hook.js --daemon http://192.168.1.15:7873 --room TRF-4829 \
//     --user Yug --agent turf --file src/checkout.js
// Exit 0 = granted (write to main), exit 2 = conflict (fork to worktreePath),
// exit 1 = hook error (fail open: proceed, daemon unreachable).
// ponytail: thin fetch wrapper over /api/locks, no deps beyond node 20 global fetch.

const args = process.argv.slice(2);
const get = (flag, fallback = null) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const daemon = (get('--daemon', 'http://127.0.0.1:7873') || '').replace(/\/$/, '');
const room = get('--room', 'TRF-XXXX');
const user = get('--user', 'turf');
const agentId = get('--agent', 'turf');
const filePath = get('--file');
const release = args.includes('--release');
const tier = parseInt(get('--tier', '1'), 10);

if (!filePath) {
  console.error(JSON.stringify({ status: 'error', message: 'missing --file' }));
  process.exit(1);
}

try {
  const endpoint = release ? `${daemon}/api/locks/release` : `${daemon}/api/locks/request`;
  const body = release
    ? { filePath, agentId }
    : { filePath, agentId, user, priorityTier: tier, room };
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000)
  });
  const data = await res.json();
  console.log(JSON.stringify(data));
  if (!release && data.status === 'conflict') process.exit(2);
  process.exit(0);
} catch (err) {
  // fail open: never block the agent on hook infra failure
  console.error(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
}
