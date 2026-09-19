import { fileURLToPath } from 'url';
import 'dotenv/config';
import path from 'path';
import express from 'express';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import http from 'http';
import os from 'os';
import net from 'net';
import { createRoom } from './rooms.js';
import { lockRegistry } from './locks.js';
import { handleEvent } from './events.js';
import { packDirectoryToTarGz } from './sync.js';
import { exec, execSync } from 'child_process';

export function getLocalIp() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const name of Object.keys(interfaces)) {
    const lowerName = name.toLowerCase();
    // Exclude virtual/container/tunnel interfaces
    if (
      lowerName.includes('virtual') ||
      lowerName.includes('vethernet') ||
      lowerName.includes('wsl') ||
      lowerName.includes('tailscale') ||
      lowerName.includes('docker') ||
      lowerName.includes('vmware') ||
      lowerName.includes('vbox') ||
      lowerName.includes('loopback')
    ) {
      continue;
    }

    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        // Discard link-local APIPA addresses (169.254.x.x)
        if (iface.address.startsWith('169.254.')) continue;

        let score = 0;
        if (/wi-?fi|wlan|wireless/i.test(name)) score += 100;
        else if (/ethernet|eth|en0|local area connection/i.test(name)) score += 50;

        if (iface.address.startsWith('192.168.')) score += 40;
        else if (iface.address.startsWith('10.')) score += 30;
        else if (iface.address.startsWith('172.')) score += 10;

        candidates.push({ address: iface.address, score });
      }
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].address;
  }

  // Fallback: check any non-internal IPv4 that isn't link-local
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
        return iface.address;
      }
    }
  }

  return '127.0.0.1';
}

export function killProcessOnPort(port) {
  try {
    if (process.platform === 'win32') {
      const output = execSync(`netstat -ano | findstr :${port}`).toString();
      const lines = output.trim().split('\n');
      for (const line of lines) {
        if (line.includes(`LISTENING`)) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          if (pid && pid !== '0' && pid !== String(process.pid)) {
            execSync(`taskkill /F /PID ${pid} 2>nul`);
          }
        }
      }
    } else {
      try { execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' }); } catch (e) {}
      try { execSync(`lsof -ti :${port} | xargs kill -9`, { stdio: 'ignore' }); } catch (e) {}
    }
  } catch (e) {
    // Ignore errors if process killing fails or netstat returns nothing
  }
}

export async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => {
      resolve(false);
    });
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, '0.0.0.0');
  });
}

export async function findAvailablePort(startPort = 7873, maxTries = 20) {
  for (let i = 0; i < maxTries; i++) {
    const port = startPort + i;
    const available = await isPortAvailable(port);
    if (available) return port;
  }
  return startPort;
}

export async function spawnHostDaemon({ hostName, repoPath, port = 7873, tunnel = false, autoPort = true, forceKill = true }) {
  let bindPort = port;
  
  const available = await isPortAvailable(bindPort);
  if (!available) {
    if (forceKill) {
      killProcessOnPort(bindPort);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const checkAgain = await isPortAvailable(bindPort);
    if (!checkAgain && autoPort) {
      bindPort = await findAvailablePort(bindPort + 1);
    }
  }

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  app.use(cors());
  app.use(express.json());

  const startTime = Date.now();
  const room = createRoom(hostName, repoPath);

  app.get('/api/health', (req, res) => {
    res.json({
      status: "ok",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      version: "1.0.0"
    });
  });

  app.get('/api/room', (req, res) => {
    res.json(room.getMetadata());
  });

  app.get('/api/room/sync', (req, res) => {
    try {
      const archive = packDirectoryToTarGz(repoPath);
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', 'attachment; filename="turf-sync.tar.gz"');
      res.setHeader('Content-Length', archive.length);
      res.end(archive);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  const broadcastLocks = () => {
    try {
      const state = lockRegistry.getState();
      const payload = JSON.stringify({
        type: 'locks:update',
        activeLocks: state.activeLocks,
        queues: state.queues,
        intents: state.intents
      });
      wss.clients.forEach(client => {
        if (client.readyState === 1) client.send(payload);
      });
    } catch (e) {}
  };

  lockRegistry.on('change', broadcastLocks);

  lockRegistry.on('promoted', (info) => {
    try {
      const payload = JSON.stringify({
        type: 'queue:promoted',
        ...info,
        timestamp: Date.now()
      });
      wss.clients.forEach(client => {
        if (client.readyState === 1) client.send(payload);
      });
      if (info.worktreeResult && info.worktreeResult.merged) {
        const mergeNotice = JSON.stringify({
          type: 'chat:message',
          user: 'SYSTEM',
          message: `🔀 Auto-merged speculative worktree for ${info.filePath} (${info.user}) after queue promotion.`,
          timestamp: Date.now()
        });
        wss.clients.forEach(client => {
          if (client.readyState === 1) client.send(mergeNotice);
        });
      }
    } catch (e) {}
  });

  app.get('/api/locks', (req, res) => {
    res.json(lockRegistry.getState());
  });

  app.post('/api/locks/intent', (req, res) => {
    const { agentId, user, files, scope, action } = req.body;
    if (action === 'clear') {
      lockRegistry.clearIntent(agentId);
      return res.json({ status: 'cleared' });
    }
    const intent = lockRegistry.declareIntent(agentId, user, files, scope);
    res.json({ status: 'declared', intent });
  });

  app.post('/api/locks/request', (req, res) => {
    const { filePath, files, agentId, user, priorityTier, room: reqRoom, pid, isRemote, remotePeer } = req.body;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const isLocalIp = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1' || clientIp.endsWith('127.0.0.1');
    const isRemoteClient = Boolean(isRemote || remotePeer || (!isLocalIp && user !== 'Host' && user !== 'LocalHost'));

    // Associate unassigned WebSocket connections if any client connected from this request
    if (user || agentId) {
      for (const client of wss.clients) {
        if (!client.user && !client.peerId) {
          client.user = user;
          client.agentId = agentId;
          break;
        }
      }
    }

    if (Array.isArray(files) && files.length > 0) {
      const results = lockRegistry.requestLocks(files, agentId, user, priorityTier, reqRoom || room.code, pid, isRemoteClient);
      const anyConflict = results.some(r => r.status === 'conflict');
      return res.json({ status: anyConflict ? 'conflict' : 'granted', results });
    }
    const result = lockRegistry.requestLock(filePath, agentId, user, priorityTier, reqRoom || room.code, pid, isRemoteClient);
    if (result && result.status === 'conflict') {
      try {
        const negMsg = {
          type: 'agent:negotiate',
          fromUser: user || 'Peer',
          fromAgent: agentId || 'turf',
          toUser: 'All',
          toAgent: 'agent',
          file: filePath,
          intent: 'fork_speculative_worktree',
          message: `File lock collision on ${filePath}. Yielding to active lease holder and branching speculative worktree.`,
          timestamp: Date.now()
        };
        handleEvent(null, wss, room, negMsg);

        const conflictMsg = JSON.stringify({
          type: 'lock:conflict',
          filePath,
          agentId,
          user: user || 'Peer',
          priorityTier: priorityTier || 1,
          queuePosition: result.queuePosition,
          effectivePriority: result.effectivePriority,
          estimatedWaitMs: result.estimatedWaitMs,
          totalQueued: result.totalQueued,
          timestamp: Date.now()
        });
        wss.clients.forEach(client => {
          if (client.readyState === 1) client.send(conflictMsg);
        });
      } catch (e) {}
    }
    res.json(result);
  });

  app.post('/api/locks/release', (req, res) => {
    const { filePath, files, agentId } = req.body;
    if (Array.isArray(files) && files.length > 0) {
      const results = lockRegistry.releaseLocks(files, agentId);
      return res.json({ status: 'released', results });
    }
    const result = lockRegistry.releaseLock(filePath, agentId);
    res.json(result);
  });

  app.post('/api/locks/worktree', (req, res) => {
    const { filePath, agentId, room: worktreeRoom, content } = req.body;
    if (!filePath || !agentId) {
      return res.status(400).json({ error: 'filePath and agentId required' });
    }
    const result = lockRegistry.saveWorktreeFile(filePath, agentId, worktreeRoom || room || 'default', content || '');
    res.json(result);
  });

  app.post('/api/locks/negotiate', (req, res) => {
    const { fromAgent, fromUser, toAgent, toUser, file, message } = req.body;
    const negMsg = {
      type: 'agent:negotiate',
      fromUser: fromUser || 'Host',
      fromAgent: fromAgent || 'turf',
      toUser: toUser || 'All',
      toAgent: toAgent || 'cmdc',
      file: file || 'workspace',
      message: message || `Negotiating access to ${file || 'file'}.`,
      timestamp: Date.now()
    };
    handleEvent(null, wss, room, negMsg);
    res.json({ status: 'broadcasted' });
  });

  app.post('/api/locks/heartbeat', (req, res) => {
    const { user, agentId } = req.body;
    lockRegistry.heartbeat(agentId || user);
    res.json({ status: 'ok' });
  });


  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const clientDistPath = path.resolve(__dirname, '../client/dist');
  const indexHtmlPath = path.join(clientDistPath, 'index.html');

  app.use(express.static(clientDistPath));

  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
    res.sendFile(indexHtmlPath);
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Send initial lock registry state to connecting client
    try {
      const initialLocks = JSON.stringify({
        type: 'locks:update',
        activeLocks: lockRegistry.getState().activeLocks,
        queues: lockRegistry.getState().queues,
        intents: lockRegistry.getState().intents
      });
      ws.send(initialLocks);
    } catch (e) {}

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        handleEvent(ws, wss, room, data);
      } catch (e) {
        console.error('Invalid WS message', e);
      }
    });
    
    ws.on('close', () => {
      if (ws.peerId) {
        room.removePeer(ws.peerId);
        lockRegistry.unregisterRemotePeer(ws.peerId);
        lockRegistry.releaseAllForUser(ws.peerId);
      }
      if (ws.user) {
        lockRegistry.unregisterRemotePeer(ws.user);
        lockRegistry.releaseAllForUser(ws.user);
      }
      if (ws.agentId) {
        lockRegistry.releaseAllForUser(ws.agentId);
      }
      if (ws.peerId) {
        const msgString = JSON.stringify({ type: 'peer:update', peers: room.getMetadata().peers });
        wss.clients.forEach(client => {
          if (client.readyState === 1) client.send(msgString);
        });
      }
    });
  });

  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 3000);

  wss.on('close', () => {
    clearInterval(interval);
  });

  server.on('error', (err) => {
    console.error('Daemon Server Error:', err.message);
  });

  await new Promise((resolve, reject) => {
    server.listen(bindPort, '0.0.0.0', () => {
      resolve();
    });
    server.once('error', reject);
  });

  return { room, server, wss, port: bindPort };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  spawnHostDaemon({ hostName: 'LocalHost', repoPath: process.cwd() });
}
