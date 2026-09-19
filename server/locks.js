import path from 'path';
import os from 'os';
import fs from 'fs';
import { EventEmitter } from 'events';

class LockRegistry extends EventEmitter {
  constructor() {
    super();
    this.locks = new Map(); // filePath -> { agentId, user, expiresAt, lastActivity }
    this.queues = new Map(); // filePath -> array of requests
    this.repoPath = process.cwd();
    
    // 10-Second Dead-Man Inactivity Sweeper
    const sweeper = setInterval(() => this._evictZombies(), 1000);
    if (sweeper.unref) sweeper.unref();
  }

  requestLock(filePath, agentId, user, priorityTier = 1, room = 'default') {
    const normalizedPath = path.normalize(filePath);
    
    // Evaluate Queue priorities
    const now = Date.now();
    const req = {
      agentId,
      user,
      priorityTier,
      room,
      enqueuedTime: now,
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
      this.emit('change', this.getState());
      return { status: "granted", filePath: normalizedPath };
    }
    
    if (!this.queues.has(normalizedPath)) {
      this.queues.set(normalizedPath, []);
    }
    this.queues.get(normalizedPath).push(req);
    this.emit('change', this.getState());
    
    const targetWorktree = path.join(os.tmpdir(), 'turf-worktrees', room || 'default', agentId).replace(/\\/g, '/');
    try {
      fs.mkdirSync(targetWorktree, { recursive: true });
    } catch (e) {}

    return { 
      status: "conflict", 
      suggestedAction: "fork_speculative_worktree", 
      worktreePath: targetWorktree 
    };
  }

  releaseLock(filePath, agentId) {
    const normalizedPath = path.normalize(filePath);
    const lock = this.locks.get(normalizedPath);
    
    if (lock && lock.agentId === agentId) {
      this.locks.delete(normalizedPath);
      this._promoteQueue(normalizedPath);
      this.emit('change', this.getState());
      return { status: "released", filePath: normalizedPath };
    }
    return { status: "ignored" };
  }
  
  touch(filePath, agentId) {
     const normalizedPath = path.normalize(filePath);
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
      expiresAt: now + 15000,
      lastActivity: now
    });
  }

  _promoteQueue(filePath) {
    const queue = this.queues.get(filePath);
    if (!queue || queue.length === 0) return;
    
    const now = Date.now();
    // Anti-starvation aging formula: EffectivePriority = BaseScore + 3.5 * (ElapsedSeconds)
    queue.forEach(q => {
      const elapsedSeconds = (now - q.enqueuedTime) / 1000;
      q.effectivePriority = q.score + (3.5 * elapsedSeconds);
    });
    
    queue.sort((a, b) => b.effectivePriority - a.effectivePriority);
    
    const nextReq = queue.shift();
    this._grantLock(filePath, nextReq);
    this.emit('change', this.getState());
  }

  _evictZombies() {
    const now = Date.now();
    let changed = false;
    for (const [filePath, lock] of this.locks.entries()) {
      // 10-Second Dead-Man Inactivity Sweeper
      if (now - lock.lastActivity > 10000 || now > lock.expiresAt) {
        this.locks.delete(filePath);
        this._promoteQueue(filePath);
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
    for (const [filePath, lock] of this.locks.entries()) {
      if (lock.agentId === userOrAgentId || lock.user === userOrAgentId) {
        lock.expiresAt = now + 15000;
        lock.lastActivity = now;
        touched = true;
      }
    }
    if (touched) {
      this.emit('change', this.getState());
    }
  }

  releaseAllForUser(userOrAgentId) {
    if (!userOrAgentId) return;
    let released = false;
    for (const [filePath, lock] of this.locks.entries()) {
      if (lock.agentId === userOrAgentId || lock.user === userOrAgentId) {
        this.locks.delete(filePath);
        this._promoteQueue(filePath);
        released = true;
      }
    }
    // Also remove from all queues
    for (const [filePath, queue] of this.queues.entries()) {
      const filtered = queue.filter(q => q.agentId !== userOrAgentId && q.user !== userOrAgentId);
      if (filtered.length !== queue.length) {
        this.queues.set(filePath, filtered);
        released = true;
      }
    }
    if (released) {
      this.emit('change', this.getState());
    }
  }

  orderPaths(paths) {
    return [...paths].map(p => path.normalize(p)).sort();
  }

  getState() {
    return {
      activeLocks: Array.from(this.locks.entries()).map(([filePath, lock]) => ({ filePath, ...lock })),
      queues: Array.from(this.queues.entries()).map(([filePath, q]) => ({ filePath, size: q.length }))
    };
  }
}

export const lockRegistry = new LockRegistry();
