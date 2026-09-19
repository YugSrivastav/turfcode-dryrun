// turf-guard-loader.mjs
// Node.js preload hook for Command Code (cmdc) and other Node-based agents.
// Transparently intercepts fs writes to enforce pre-touch Intent Locks
// without modifying external CLI packages.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK_SCRIPT = path.join(__dirname, 'turf-hook.js');

const daemon = process.env.TURF_DAEMON || 'http://127.0.0.1:7873';
const room = process.env.TURF_ROOM || 'TRF-XXXX';
const user = process.env.TURF_USER || 'cmdc';
const agentId = process.env.TURF_AGENT_ID || 'cmdc';

function shouldGuard(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const norm = targetPath.replace(/\\/g, '/');
  if (norm.includes('node_modules/') || norm.includes('.git/') || norm.includes('.turf-worktrees/')) {
    return false;
  }
  // Only guard files within the working tree
  const abs = path.resolve(process.cwd(), targetPath);
  const cwd = process.cwd();
  return abs.startsWith(cwd);
}

function syncWorktreeToDaemon(relPath, worktreeFilePath) {
  if (!daemon || !relPath) return;
  try {
    const content = fs.existsSync(worktreeFilePath) ? fs.readFileSync(worktreeFilePath, 'utf8') : '';
    fetch(`${daemon}/api/locks/worktree`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filePath: relPath, agentId, room, user, content })
    }).catch(() => {});
  } catch (e) {}
}

function checkLock(targetPath) {
  if (!shouldGuard(targetPath) || !fs.existsSync(HOOK_SCRIPT)) {
    return { ok: true, redirectPath: null, rel: null };
  }
  const rel = path.relative(process.cwd(), path.resolve(process.cwd(), targetPath)).replace(/\\/g, '/');
  try {
    const res = spawnSync(
      process.execPath,
      [HOOK_SCRIPT, '--daemon', daemon, '--room', room, '--user', user, '--agent', agentId, '--file', rel],
      { timeout: 3000, encoding: 'utf8' }
    );
    if (res.status === 0) {
      return { ok: true, redirectPath: null, rel };
    }
    if (res.status === 2 && res.stdout) {
      // Conflict: parse local or daemon worktree path
      const data = JSON.parse(res.stdout);
      const targetWorktree = data.localWorktreePath || data.worktreePath;
      if (targetWorktree) {
        const redirected = path.join(targetWorktree, rel);
        try {
          fs.mkdirSync(path.dirname(redirected), { recursive: true });
          const origFile = path.resolve(process.cwd(), targetPath);
          if (!fs.existsSync(redirected) && fs.existsSync(origFile)) {
            fs.copyFileSync(origFile, redirected);
          }
        } catch (e) {}
        return { ok: true, redirectPath: redirected, rel };
      }
    }
  } catch (e) {
    // Fail open
  }
  return { ok: true, redirectPath: null, rel };
}

// Patch fs.writeFileSync
const origWriteFileSync = fs.writeFileSync;
fs.writeFileSync = function (file, data, options) {
  if (typeof file === 'string') {
    const check = checkLock(file);
    if (check.redirectPath) {
      const res = origWriteFileSync.call(fs, check.redirectPath, data, options);
      syncWorktreeToDaemon(check.rel, check.redirectPath);
      return res;
    }
  }
  return origWriteFileSync.apply(fs, arguments);
};

// Patch fs.promises.writeFile
if (fs.promises && fs.promises.writeFile) {
  const origPromisesWriteFile = fs.promises.writeFile;
  fs.promises.writeFile = async function (file, data, options) {
    if (typeof file === 'string') {
      const check = checkLock(file);
      if (check.redirectPath) {
        const res = await origPromisesWriteFile.call(fs.promises, check.redirectPath, data, options);
        syncWorktreeToDaemon(check.rel, check.redirectPath);
        return res;
      }
    }
    return origPromisesWriteFile.apply(fs.promises, arguments);
  };
}

// Patch fs.appendFileSync
const origAppendFileSync = fs.appendFileSync;
fs.appendFileSync = function (file, data, options) {
  if (typeof file === 'string') {
    const check = checkLock(file);
    if (check.redirectPath) {
      const res = origAppendFileSync.call(fs, check.redirectPath, data, options);
      syncWorktreeToDaemon(check.rel, check.redirectPath);
      return res;
    }
  }
  return origAppendFileSync.apply(fs, arguments);
};

// Patch fs.writeFile (callback)
const origWriteFile = fs.writeFile;
fs.writeFile = function (file, data, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  if (typeof file === 'string') {
    const check = checkLock(file);
    if (check.redirectPath) {
      return origWriteFile.call(fs, check.redirectPath, data, options, (err) => {
        if (!err) syncWorktreeToDaemon(check.rel, check.redirectPath);
        if (callback) callback(err);
      });
    }
  }
  return origWriteFile.call(fs, file, data, options, callback);
};

// Patch fs.promises.appendFile
if (fs.promises && fs.promises.appendFile) {
  const origPromisesAppendFile = fs.promises.appendFile;
  fs.promises.appendFile = async function (file, data, options) {
    if (typeof file === 'string') {
      const check = checkLock(file);
      if (check.redirectPath) {
        const res = await origPromisesAppendFile.call(fs.promises, check.redirectPath, data, options);
        syncWorktreeToDaemon(check.rel, check.redirectPath);
        return res;
      }
    }
    return origPromisesAppendFile.apply(fs.promises, arguments);
  };
}
