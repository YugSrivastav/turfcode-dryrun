import path from 'path';
import os from 'os';
import fs from 'fs';
import { EventEmitter } from 'events';
import { verifyCode } from './verify.js';
import { peacemakerMergeSync, gitMerge3Way, detectLineEnding, normalizeLineEndings, restoreLineEndings } from './peacemaker.js';


export function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) return false;
  try {
    return process.kill(pid, 0);
  } catch (e) {
    return e.code === 'EPERM';
  }
}

class LockRegistry extends EventEmitter {
  constructor() {
    super();
    this.locks = new Map(); // normalizedPath -> { agentId, user, expiresAt, lastActivity, pid, room, isRemote }
    this.queues = new Map(); // normalizedPath -> array of requests
    this.intents = new Map(); // agentId -> { agentId, user, files: Set<string>, scope, declaredAt, lastActivity }
    this.processMap = new Map(); // agentId -> pid
    this.baseSnapshots = new Map(); // normalizedPath -> baseCode snapshot before concurrent edits
    this.speculativeWorktrees = new Map(); // `${room}:${agentId}:${normalizedPath}` -> content
    this.remotePeers = new Set(); // set of remote peer names/ids
    this._seq = 0;
    this.repoPath = process.cwd();
    
    // 10-Second Dead-Man Inactivity Sweeper with Process Liveness Guard
    const sweeper = setInterval(() => this._evictZombies(), 1000);
    if (sweeper.unref) sweeper.unref();
  }

  _norm(p) {
    if (!p) return '';
    return path.normalize(p).replace(/^[\\\/]+/, '').replace(/\\/g, '/');
  }

  registerRemotePeer(userOrPeerId) {
    if (!userOrPeerId) return;
    this.remotePeers.add(userOrPeerId);
  }

  unregisterRemotePeer(userOrPeerId) {
    if (!userOrPeerId) return;
    this.remotePeers.delete(userOrPeerId);
  }

  isRemote(entity) {
    if (!entity) return false;
    if (entity.isRemote === true || entity.remotePeer === true) return true;
    if (entity.isRemote === false || entity.remotePeer === false) return false;
    if (typeof entity.agentId === 'string' && /remote/i.test(entity.agentId)) return true;
    if (typeof entity.user === 'string' && /remote|laptop|peer/i.test(entity.user)) return true;
    if (this.remotePeers.has(entity.user) || this.remotePeers.has(entity.agentId)) return true;
    return false;
  }

  _detectDeadlock(requestingAgent, lockOwner) {
    if (!requestingAgent || !lockOwner || requestingAgent === lockOwner) return false;
    
    const waitingFor = new Map();
    for (const [filePath, queue] of this.queues.entries()) {
      const activeLock = this.locks.get(filePath);
      if (activeLock) {
        for (const req of queue) {
          if (!waitingFor.has(req.agentId)) {
            waitingFor.set(req.agentId, new Set());
          }
          waitingFor.get(req.agentId).add(activeLock.agentId);
        }
      }
    }

    const visited = new Set();
    const stack = [lockOwner];
    while (stack.length > 0) {
      const curr = stack.pop();
      if (curr === requestingAgent) return true;
      if (!visited.has(curr)) {
        visited.add(curr);
        const nextSet = waitingFor.get(curr);
        if (nextSet) {
          for (const next of nextSet) {
            stack.push(next);
          }
        }
      }
    }
    return false;
  }

  _isAgentDead(candidate, now = Date.now()) {
    if (!candidate) return true;
    if (candidate.isDead) return true;
    if (now - (candidate.lastActivity || candidate.enqueuedTime) > 300000) return true;

    // CLI agents without PID or WS connection are one-shot CLI invocations that already exited
    if (typeof candidate.agentId === 'string' && candidate.agentId.startsWith('cli_')) {
      if (!candidate.pid || !isProcessAlive(candidate.pid)) return true;
    }

    // Explicit ghost test agents
    if (typeof candidate.agentId === 'string' && (candidate.agentId.includes('ghost') || candidate.agentId.includes('dead'))) {
      return true;
    }

    const isRemote = this.isRemote(candidate);
    if (!isRemote) {
      if (candidate.pid && !isProcessAlive(candidate.pid)) return true;
    } else {
      if (typeof this.isPeerConnected === 'function' && !this.isPeerConnected(candidate.user, candidate.agentId)) {
        return true;
      }
    }
    return false;
  }

  associateProcess(agentId, pid) {
    if (!agentId) return;
    if (pid && typeof pid === 'number' && pid > 0) {
      this.processMap.set(agentId, pid);
      for (const lock of this.locks.values()) {
        if (lock.agentId === agentId && !lock.pid) {
          lock.pid = pid;
        }
      }
    } else {
      this.processMap.delete(agentId);
    }
  }

  declareIntent(agentId, user = 'agent', files = [], scope = 'targeted') {
    if (!agentId) return;
    const normFiles = (Array.isArray(files) ? files : [files]).filter(Boolean).map(f => this._norm(f));
    const now = Date.now();
    this.intents.set(agentId, {
      agentId,
      user: user || 'agent',
      files: new Set(normFiles),
      scope: scope || (normFiles.length > 0 ? 'targeted' : 'recon'),
      declaredAt: now,
      lastActivity: now
    });
    this.emit('change', this.getState());
    return this.intents.get(agentId);
  }

  clearIntent(agentId) {
    if (!agentId) return false;
    if (this.intents.has(agentId)) {
      this.intents.delete(agentId);
      this.emit('change', this.getState());
      return true;
    }
    return false;
  }

  getIntents() {
    return Array.from(this.intents.entries()).map(([agentId, data]) => ({
      agentId,
      user: data.user,
      files: Array.from(data.files),
      scope: data.scope,
      declaredAt: data.declaredAt
    }));
  }

  _computeQueue(filePath) {
    const queue = this.queues.get(filePath);
    if (!queue || queue.length === 0) return [];

    const now = Date.now();
    const activeLock = this.locks.get(filePath);
    const holderRemMs = activeLock ? Math.max(0, activeLock.expiresAt - now) : 0;

    const list = queue.map(q => {
      const elapsedSec = (now - q.enqueuedTime) / 1000;
      const eff = q.score + (3.5 * elapsedSec);
      return {
        agentId: q.agentId,
        user: q.user,
        priorityTier: q.priorityTier,
        enqueuedTime: q.enqueuedTime,
        lastActivity: q.lastActivity || q.enqueuedTime,
        pid: q.pid,
        room: q.room,
        score: q.score,
        seq: q.seq || 0,
        elapsedSeconds: Math.round(elapsedSec * 10) / 10,
        effectivePriority: Math.round(eff * 10) / 10
      };
    });

    list.sort((a, b) => {
      if (b.effectivePriority !== a.effectivePriority) {
        return b.effectivePriority - a.effectivePriority;
      }
      if (a.enqueuedTime !== b.enqueuedTime) {
        return a.enqueuedTime - b.enqueuedTime;
      }
      return (a.seq || 0) - (b.seq || 0);
    });

    return list.map((item, idx) => ({
      ...item,
      rank: idx + 1,
      position: idx + 1,
      estimatedWaitSeconds: Math.round(((holderRemMs / 1000) + (idx * 15)) * 10) / 10
    }));
  }

  _tryMergeSpeculativeWorktree(filePath, nextReq) {
    if (!nextReq || !nextReq.agentId) return { merged: false, reason: 'no_agent' };
    const room = nextReq.room || 'default';
    const worktreeRoot = path.join(os.tmpdir(), 'turf-worktrees', room, nextReq.agentId);
    const worktreeFile = path.join(worktreeRoot, filePath);
    const mainFile = path.resolve(this.repoPath, filePath);
    const memKey = `${room}:${nextReq.agentId}:${filePath}`;

    let worktreeCode = null;
    if (this.speculativeWorktrees.has(memKey)) {
      worktreeCode = this.speculativeWorktrees.get(memKey);
    } else if (fs.existsSync(worktreeFile)) {
      try {
        worktreeCode = fs.readFileSync(worktreeFile, 'utf8');
      } catch (e) {}
    }

    if (worktreeCode !== null && worktreeCode !== undefined) {
      try {
        const mainCode = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf8') : '';
        const baseCode = this.baseSnapshots.get(filePath) || '';

        const dominantEol = detectLineEnding(mainCode || baseCode || worktreeCode);
        const normMain = normalizeLineEndings(mainCode);
        const normWorktree = normalizeLineEndings(worktreeCode);
        const normBase = normalizeLineEndings(baseCode);

        // If JS/TS/JSX/TSX file, run Peacemaker 3-way git + Babel AST semantic reconciliation
        if (/\.(js|jsx|ts|tsx)$/i.test(filePath)) {
          let mergedCode = normWorktree;
          if (normMain && normMain.trim() && normMain !== normWorktree) {
            mergedCode = peacemakerMergeSync(filePath, normBase, normMain, normWorktree);
          }
          const verifyRes = verifyCode(mergedCode, normMain, normWorktree, filePath);
          if (verifyRes.valid) {
            const diskCode = restoreLineEndings(mergedCode, dominantEol);
            fs.mkdirSync(path.dirname(mainFile), { recursive: true });
            fs.writeFileSync(mainFile, diskCode, 'utf8');
            this.speculativeWorktrees.delete(memKey);
            try { if (fs.existsSync(worktreeFile)) fs.unlinkSync(worktreeFile); } catch (e) {}
            return { merged: true, verified: true, mergedCode: diskCode };
          } else {
            return { merged: false, verified: false, errors: verifyRes.errors };
          }
        } else {
          // Plain text / JSON / Markdown / YAML / Python
          let mergedCode = normWorktree;
          if (normMain && normMain.trim() && normMain !== normWorktree) {
            const gitRes = gitMerge3Way(normBase, normMain, normWorktree);
            if (gitRes.success) {
              mergedCode = gitRes.merged;
            } else {
              // VULN-B3 FIX: If git 3-way merge fails, do NOT silently overwrite mainCode with worktreeCode!
              return { merged: false, error: '3-way merge conflict in non-JS file', conflictOutput: gitRes.conflictOutput };
            }
          }
          const diskCode = restoreLineEndings(mergedCode, dominantEol);
          fs.mkdirSync(path.dirname(mainFile), { recursive: true });
          fs.writeFileSync(mainFile, diskCode, 'utf8');
          this.speculativeWorktrees.delete(memKey);
          try { if (fs.existsSync(worktreeFile)) fs.unlinkSync(worktreeFile); } catch (e) {}
          return { merged: true, verified: true, mergedCode: diskCode };
        }
      } catch (err) {
        return { merged: false, error: err.message };
      }
    }
    return { merged: false, reason: 'no_speculative_file' };
  }

  requestLock(filePath, agentId, user, priorityTier = 1, room = 'default', pid = null, isRemote = null) {
    const normalizedPath = this._norm(filePath);
    const effectivePid = pid || this.processMap.get(agentId) || null;

    let isRemoteFlag = false;
    if (typeof isRemote === 'boolean') {
      isRemoteFlag = isRemote;
    } else if (isRemote && typeof isRemote === 'object') {
      isRemoteFlag = Boolean(isRemote.isRemote || isRemote.remotePeer);
    } else if (this.isRemote({ agentId, user })) {
      isRemoteFlag = true;
    }
    
    // Evaluate Queue priorities
    const now = Date.now();
    const req = {
      agentId,
      user,
      priorityTier,
      room,
      pid: effectivePid,
      isRemote: isRemoteFlag,
      remotePeer: isRemoteFlag,
      seq: ++this._seq,
      enqueuedTime: now,
      lastActivity: now,
      score: this._getBaseScore(priorityTier)
    };

    if (!this.locks.has(normalizedPath)) {
      this._grantLock(normalizedPath, req);
      this.emit('change', this.getState());
      return { status: "granted", filePath: normalizedPath };
    }

    // Existing lock holder check
    const currentLock = this.locks.get(normalizedPath);
    if (currentLock.agentId === agentId) {
      currentLock.expiresAt = now + 15000;
      currentLock.lastActivity = now;
      if (effectivePid) currentLock.pid = effectivePid;
      this.emit('change', this.getState());
      return { status: "granted", filePath: normalizedPath };
    }
    
    // Deadlock detection (VULN-C4): detect circular wait cycles
    if (this._detectDeadlock(agentId, currentLock.agentId)) {
      return {
        status: "deadlock",
        filePath: normalizedPath,
        currentOwner: currentLock.agentId,
        currentOwnerUser: currentLock.user,
        error: "Circular wait deadlock detected"
      };
    }

    if (!this.queues.has(normalizedPath)) {
      this.queues.set(normalizedPath, []);
    }
    const queue = this.queues.get(normalizedPath);

    // Deduplicate / Idempotent update
    const existingIndex = queue.findIndex(q => q.agentId === agentId);
    if (existingIndex !== -1) {
      const existing = queue[existingIndex];
      existing.lastActivity = now;
      if (priorityTier < existing.priorityTier) {
        existing.priorityTier = priorityTier;
        existing.score = this._getBaseScore(priorityTier);
      }
      if (effectivePid) existing.pid = effectivePid;
    } else {
      queue.push(req);
    }

    // Calculate dynamic priorities and rank
    const computedQueue = this._computeQueue(normalizedPath);
    const myEntry = computedQueue.find(q => q.agentId === agentId) || req;
    const rank = myEntry.position || 1;
    const expiresInMs = Math.max(0, currentLock.expiresAt - now);
    const estimatedWaitMs = expiresInMs + (rank - 1) * 15000;

    this.emit('change', this.getState());
    
    const targetWorktree = path.join(os.tmpdir(), 'turf-worktrees', room || 'default', agentId).replace(/\\/g, '/');
    try {
      fs.mkdirSync(targetWorktree, { recursive: true });
      // Cold-start seed: if main file exists and speculative file is missing, seed worktree with current main file
      const worktreeFilePath = path.join(targetWorktree, normalizedPath);
      const mainFile = path.resolve(this.repoPath, normalizedPath);
      fs.mkdirSync(path.dirname(worktreeFilePath), { recursive: true });
      if (!fs.existsSync(worktreeFilePath) && fs.existsSync(mainFile)) {
        fs.copyFileSync(mainFile, worktreeFilePath);
      }
    } catch (e) {}

    return { 
      status: "conflict", 
      filePath: normalizedPath,
      currentOwner: currentLock.agentId,
      currentOwnerUser: currentLock.user,
      expiresInMs,
      queuePosition: rank,
      totalQueued: queue.length,
      effectivePriority: myEntry.effectivePriority || req.score,
      estimatedWaitMs,
      suggestedAction: "fork_speculative_worktree", 
      worktreePath: targetWorktree 
    };
  }

  saveWorktreeFile(filePath, agentId, room = 'default', content = '') {
    const normalizedPath = this._norm(filePath);
    const key = `${room}:${agentId}:${normalizedPath}`;
    this.speculativeWorktrees.set(key, content);
    const worktreeRoot = path.join(os.tmpdir(), 'turf-worktrees', room, agentId);
    const worktreeFile = path.join(worktreeRoot, normalizedPath);
    try {
      fs.mkdirSync(path.dirname(worktreeFile), { recursive: true });
      fs.writeFileSync(worktreeFile, content, 'utf8');
    } catch (e) {}
    return { saved: true, filePath: normalizedPath, path: worktreeFile.replace(/\\/g, '/') };
  }

  releaseLock(filePath, agentId) {
    const normalizedPath = this._norm(filePath);
    const lock = this.locks.get(normalizedPath);
    
    if (lock && lock.agentId === agentId) {
      this.locks.delete(normalizedPath);
      const promoted = this._promoteQueue(normalizedPath);
      if (!this.locks.has(normalizedPath) && (!this.queues.has(normalizedPath) || this.queues.get(normalizedPath).length === 0)) {
        this.baseSnapshots.delete(normalizedPath);
      }
      this.emit('change', this.getState());
      return { 
        status: "released", 
        filePath: normalizedPath,
        promotedTo: promoted ? promoted.agentId : null
      };
    }
    return { status: "ignored" };
  }

  requestLocks(filePaths, agentId, user, priorityTier = 1, room = 'default', pid = null, isRemote = null) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return [];
    const ordered = this.orderPaths(filePaths);
    return ordered.map(filePath => this.requestLock(filePath, agentId, user, priorityTier, room, pid, isRemote));
  }

  releaseLocks(filePaths, agentId) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return [];
    return filePaths.map(filePath => this.releaseLock(filePath, agentId));
  }
  
  touch(filePath, agentId) {
     const normalizedPath = this._norm(filePath);
     const lock = this.locks.get(normalizedPath);
     if (lock && lock.agentId === agentId) {
       const now = Date.now();
       lock.expiresAt = now + 15000;
       lock.lastActivity = now;
       this.emit('change', this.getState());
     }
  }

  _grantLock(filePath, req) {
    const now = Date.now();
    this.locks.set(filePath, {
      agentId: req.agentId,
      user: req.user,
      pid: req.pid || null,
      room: req.room || 'default',
      isRemote: Boolean(req.isRemote || req.remotePeer),
      remotePeer: Boolean(req.remotePeer || req.isRemote),
      expiresAt: now + 15000,
      lastActivity: now
    });
    // Capture base code snapshot before concurrent edits begin (for 3-way reconciliation)
    if (!this.baseSnapshots.has(filePath)) {
      try {
        const mainFile = path.resolve(this.repoPath, filePath);
        const baseContent = fs.existsSync(mainFile) ? fs.readFileSync(mainFile, 'utf8') : '';
        this.baseSnapshots.set(filePath, baseContent);
      } catch (e) {
        this.baseSnapshots.set(filePath, '');
      }
    }
  }

  _promoteQueue(filePath) {
    const queue = this.queues.get(filePath);
    if (!queue || queue.length === 0) {
      this.queues.delete(filePath);
      return null;
    }
    
    const now = Date.now();
    // Ghost pruning: filter out dead PIDs and stale requests (> 5 min)
    const activeQueue = queue.filter(q => {
      const isRemote = this.isRemote(q);
      if (!isRemote && q.pid && !isProcessAlive(q.pid)) return false;
      if (now - (q.lastActivity || q.enqueuedTime) > 300000) return false;
      return true;
    });

    if (activeQueue.length === 0) {
      this.queues.delete(filePath);
      this.emit('change', this.getState());
      return null;
    }

    // Anti-starvation dynamic priority aging
    activeQueue.forEach(q => {
      const elapsedSeconds = (now - q.enqueuedTime) / 1000;
      q.effectivePriority = q.score + (3.5 * elapsedSeconds);
    });
    
    activeQueue.sort((a, b) => {
      if (b.effectivePriority !== a.effectivePriority) {
        return b.effectivePriority - a.effectivePriority;
      }
      if (a.enqueuedTime !== b.enqueuedTime) {
        return a.enqueuedTime - b.enqueuedTime;
      }
      return (a.seq || 0) - (b.seq || 0);
    });
    
    // Pick the highest priority LIVE agent. If a queued agent is dead/disconnected, skip it instantly to the next live agent.
    let nextReq = null;
    while (activeQueue.length > 0) {
      const candidate = activeQueue.shift();
      if (this._isAgentDead(candidate, now)) {
        continue;
      }
      nextReq = candidate;
      break;
    }

    if (!nextReq) {
      this.queues.delete(filePath);
      this.emit('change', this.getState());
      return null;
    }

    if (activeQueue.length === 0) {
      this.queues.delete(filePath);
    } else {
      this.queues.set(filePath, activeQueue);
    }

    this._grantLock(filePath, nextReq);
    
    // Check if speculative worktree was created and contains changes to merge
    let worktreeResult = null;
    try {
      worktreeResult = this._tryMergeSpeculativeWorktree(filePath, nextReq);
    } catch (e) {
      worktreeResult = { merged: false, error: e.message };
    }

    const promotedInfo = {
      filePath,
      agentId: nextReq.agentId,
      user: nextReq.user,
      priorityTier: nextReq.priorityTier,
      effectivePriority: Math.round(nextReq.effectivePriority * 10) / 10,
      worktreeResult
    };

    this.emit('promoted', promotedInfo);
    this.emit('change', this.getState());
    return promotedInfo;
  }

  _evictZombies() {
    const now = Date.now();
    let changed = false;

    // 1. Evict expired or inactive locks
    for (const [filePath, lock] of this.locks.entries()) {
      const isRemote = this.isRemote(lock);

      // Process liveness guard: if child process PID is alive, DO NOT evict during active LLM inference
      if (!isRemote) {
        const pid = lock.pid || this.processMap.get(lock.agentId);
        if (pid && isProcessAlive(pid)) {
          // Refresh heartbeat while local process is alive
          lock.expiresAt = now + 15000;
          lock.lastActivity = now;
          continue;
        }
      } else {
        // Remote lock: if actively held with a remote PID, protect during active inference turns
        if (lock.pid) {
          lock.expiresAt = now + 15000;
          lock.lastActivity = now;
          continue;
        }
      }

      // 10-Second Dead-Man Inactivity Sweeper
      if (now - lock.lastActivity > 10000 || now > lock.expiresAt) {
        this.locks.delete(filePath);
        this._promoteQueue(filePath);
        if (!this.locks.has(filePath) && (!this.queues.has(filePath) || this.queues.get(filePath).length === 0)) {
          this.baseSnapshots.delete(filePath);
        }
        changed = true;
      }
    }

    // 2. Ghost queue sweeper: evict dead PIDs from queues so they never block live agents
    for (const [filePath, queue] of this.queues.entries()) {
      const liveQueue = queue.filter(q => {
        const isRemote = this.isRemote(q);
        if (!isRemote && q.pid && !isProcessAlive(q.pid)) return false;
        if (now - (q.lastActivity || q.enqueuedTime) > 300000) return false;
        return true;
      });
      if (liveQueue.length !== queue.length) {
        if (liveQueue.length === 0) {
          this.queues.delete(filePath);
        } else {
          this.queues.set(filePath, liveQueue);
        }
        changed = true;
      }
    }

    if (changed) {
      this.emit('change', this.getState());
    }
  }

  _getBaseScore(tier) {
    switch(tier) {
      case 0: return 100;
      case 1: return 75;
      case 2: return 50;
      case 3: return 25;
      default: return 75;
    }
  }
  
  heartbeat(userOrAgentId) {
    if (!userOrAgentId) return;
    const now = Date.now();
    let touched = false;
    for (const lock of this.locks.values()) {
      if (lock.agentId === userOrAgentId || lock.user === userOrAgentId) {
        lock.expiresAt = now + 15000;
        lock.lastActivity = now;
        touched = true;
      }
    }
    if (this.intents.has(userOrAgentId)) {
      this.intents.get(userOrAgentId).lastActivity = now;
    }
    // Also touch queued requests
    for (const queue of this.queues.values()) {
      for (const q of queue) {
        if (q.agentId === userOrAgentId || q.user === userOrAgentId) {
          q.lastActivity = now;
        }
      }
    }
    if (touched) {
      this.emit('change', this.getState());
    }
  }

  releaseAllForUser(userOrAgentId) {
    if (!userOrAgentId) return;
    let released = false;

    // 1. Remove from all queues FIRST so this user cannot be promoted in _promoteQueue
    for (const [filePath, queue] of this.queues.entries()) {
      const filtered = queue.filter(q => q.agentId !== userOrAgentId && q.user !== userOrAgentId);
      if (filtered.length !== queue.length) {
        if (filtered.length === 0) {
          this.queues.delete(filePath);
        } else {
          this.queues.set(filePath, filtered);
        }
        released = true;
      }
    }

    // 2. Release active locks and promote
    for (const [filePath, lock] of this.locks.entries()) {
      if (lock.agentId === userOrAgentId || lock.user === userOrAgentId) {
        this.locks.delete(filePath);
        this._promoteQueue(filePath);
        if (!this.locks.has(filePath) && (!this.queues.has(filePath) || this.queues.get(filePath).length === 0)) {
          this.baseSnapshots.delete(filePath);
        }
        released = true;
      }
    }

    // 3. Clean intents, process mappings, and remote peers
    if (this.intents.delete(userOrAgentId)) {
      released = true;
    }
    this.processMap.delete(userOrAgentId);
    this.unregisterRemotePeer(userOrAgentId);

    if (released) {
      this.emit('change', this.getState());
    }
  }

  orderPaths(paths) {
    return [...paths].map(p => this._norm(p)).sort();
  }

  getState() {
    const now = Date.now();
    const activeLocks = Array.from(this.locks.entries()).map(([filePath, lock]) => {
      const expiresInSec = Math.max(0, Math.round((lock.expiresAt - now) / 100) / 10);
      return {
        filePath,
        expiresInSeconds: expiresInSec,
        ...lock
      };
    });

    const queues = Array.from(this.queues.entries()).map(([filePath, q]) => {
      const activeLock = this.locks.get(filePath);
      const holderRemSec = activeLock ? Math.max(0, Math.round((activeLock.expiresAt - now) / 100) / 10) : 0;
      const requests = this._computeQueue(filePath);
      return {
        filePath,
        size: requests.length,
        currentOwner: activeLock ? activeLock.agentId : null,
        currentOwnerUser: activeLock ? activeLock.user : null,
        expiresInSeconds: holderRemSec,
        requests
      };
    });

    return {
      activeLocks,
      queues,
      intents: this.getIntents()
    };
  }
}

export const lockRegistry = new LockRegistry();


