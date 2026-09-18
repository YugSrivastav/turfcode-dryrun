import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnHostDaemon } from '../server/index.js';
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
    'server/events.js', 'server/rooms.js', 'server/locks.js'
  ];
  for (const file of files) {
    try {
      execSync(`node --check ${path.join(TURF_ROOT, file)}`);
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

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'peer:join', user: 'TestPeer', role: 'Peer' }));
    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'chat:send', user: 'TestPeer', message: 'Hello World' }));
    }, 200);
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
  });

  await new Promise(resolve => setTimeout(resolve, 1000));
  
  assert(peerUpdateReceived, 'Peer update broadcasted on join');
  assert(chatMessageReceived, 'Chat message broadcasted and received');

  console.log('\n--- E2E Tests Complete ---');
  console.log(`Passed: ${passed}, Failed: ${failed}`);

  ws.close();
  wss.clients.forEach(c => c.close());
  wss.close();
  server.close();
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(console.error);
