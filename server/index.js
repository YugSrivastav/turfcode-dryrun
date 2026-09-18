import { fileURLToPath } from 'url';
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
import { exec, execSync } from 'child_process';

export function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
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
          if (pid && pid !== '0') {
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
    res.json({ files: [] }); 
  });

  app.get('/api/locks', (req, res) => {
    res.json(lockRegistry.getState());
  });

  app.post('/api/locks/request', (req, res) => {
    const { filePath, agentId, user, priorityTier } = req.body;
    const result = lockRegistry.requestLock(filePath, agentId, user, priorityTier);
    res.json(result);
  });

  app.post('/api/locks/release', (req, res) => {
    const { filePath, agentId } = req.body;
    const result = lockRegistry.releaseLock(filePath, agentId);
    res.json(result);
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

  server.listen(bindPort, '0.0.0.0', () => {
    // Background daemon started silently
  });

  return { room, server, wss, port: bindPort };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  spawnHostDaemon({ hostName: 'LocalHost', repoPath: process.cwd() });
}
