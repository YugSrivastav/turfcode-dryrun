import { createRequire } from 'module';
import { EventEmitter } from 'events';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import dotenv from 'dotenv';

import pkgHeadless from '@xterm/headless';
const { Terminal } = pkgHeadless;
import pkgSerialize from '@xterm/addon-serialize';
const { SerializeAddon } = pkgSerialize;
import { getTurfModels, getCmdcModels, getCodexModels, getPaletteModelsForTab, invalidateModelCache } from './model_discovery.js';
import { lockRegistry } from './locks.js';

const require = createRequire(import.meta.url);

// Repo root (server/pty_manager.js -> repo root) for the built-in turf wrapper.
const TURF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TURF_WRAPPER = path.join(TURF_ROOT, 'bin', 'turf-agent.js');
const TURF_GUARD_LOADER = path.join(TURF_ROOT, 'server', 'turf-guard-loader.mjs');

export function extractFileCandidates(prompt, cwd = process.cwd()) {
  if (!prompt || typeof prompt !== 'string') return [];
  const candidates = new Set();
  const fileRegex = /\b([a-zA-Z0-9_\-\.\/\\]+\.[a-zA-Z0-9_\-]+)\b/g;
  let match;
  while ((match = fileRegex.exec(prompt)) !== null) {
    let candidate = match[1].replace(/\\/g, '/').replace(/^\.\//, '');
    if (/^\d+(\.\d+)+$/.test(candidate) || candidate.includes('http:') || candidate.includes('https:')) {
      continue;
    }
    if (candidate.startsWith('-')) continue;

    try {
      const full = path.resolve(cwd, candidate);
      if (fs.existsSync(full)) {
        candidates.add(candidate);
      } else if (candidate.includes('/') || /\.(js|ts|jsx|tsx|json|md|html|css|py|rs|go|sh)$/i.test(candidate)) {
        candidates.add(candidate);
      }
    } catch (e) {
      if (candidate.includes('/')) candidates.add(candidate);
    }
  }
  return Array.from(candidates);
}


function resolveTurf() {
  // Prefer a globally installed `turf` binary, fall back to the built-in wrapper.
  const global = findBinary('turf');
  if (global) return { file: global, prefix: [] };
  if (fs.existsSync(TURF_WRAPPER)) return { file: process.execPath, prefix: [TURF_WRAPPER] };
  return null;
}

let ptyModule = null;
try {
  ptyModule = require('node-pty');
} catch (e) {
  ptyModule = null;
}

export function findBinary(name) {
  if (process.platform === 'win32') {
    try {
      const out = execSync(`where.exe ${name}`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
      const first = out.trim().split(/\r?\n/)[0];
      if (first && fs.existsSync(first)) return first;
    } catch (e) {}

    const localAppData = process.env.LOCALAPPDATA || '';
    const appData = process.env.APPDATA || '';

    if (name === 'cmdc' || name === 'command-code') {
      const npmCmdc = path.join(appData, 'npm', 'cmdc.cmd');
      if (fs.existsSync(npmCmdc)) return npmCmdc;
      const npmCmd = path.join(appData, 'npm', 'cmd.cmd');
      if (fs.existsSync(npmCmd)) return npmCmd;
      const npmCommandCode = path.join(appData, 'npm', 'command-code.cmd');
      if (fs.existsSync(npmCommandCode)) return npmCommandCode;
    }
    if (name === 'agy') {
      const agyPath = path.join(localAppData, 'agy', 'bin', 'agy.exe');
      if (fs.existsSync(agyPath)) return agyPath;
    }
    if (name === 'codex') {
      const codexPath = path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
      if (fs.existsSync(codexPath)) return codexPath;
    }
    if (name === 'turf') {
      const turfPath = path.join(localAppData, 'turf', 'bin', 'turf.exe');
      if (fs.existsSync(turfPath)) return turfPath;
    }
  } else {
    try {
      const out = execSync(`which ${name}`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
      const first = out.trim().split(/\r?\n/)[0];
      if (first && fs.existsSync(first)) return first;
    } catch (e) {}
  }
  return null;
}

export { getTurfModels, getCmdcModels, getCodexModels, getPaletteModelsForTab, invalidateModelCache };

export function safeEscape(str) {
  if (!str) return '';
  return String(str).replace(/[{}]/g, (ch) => (ch === '{' ? '{open}' : '{close}'));
}

export function parseCodexJsonLine(line, config, emit) {
  if (!line || !line.trim()) return;
  try {
    const data = JSON.parse(line);
    if (data.type === 'thread.started' && data.thread_id) {
      config.sessionId = data.thread_id;
      emit('agent:msg', { tabId: 'codex', type: 'session', text: `{grey-fg}Session ID: {yellow-fg}${safeEscape(data.thread_id)}{/yellow-fg}{/grey-fg}` });
    } else if (data.type === 'turn.started') {
      emit('status', { tabId: 'codex', status: 'working', details: 'Thinking' });
    } else if (data.type === 'item.completed' && data.item) {
      const item = data.item;
      if (item.type === 'agent_message' && item.text) {
        emit('agent:msg', { tabId: 'codex', type: 'message', text: `{bold}{cyan-fg}💬 Codex:{/cyan-fg}{/bold}\n${safeEscape(item.text.trim())}` });
      } else if (item.type === 'command_execution') {
        const cmd = item.command || '';
        let badge = '{grey-fg}⚙️ [Run]{/grey-fg}';
        if (/^(grep|ripgrep|rg|findstr)\s/i.test(cmd)) {
          badge = '{grey-fg}🔍 [Search]{/grey-fg}';
        } else if (/^(cat|type|head|tail|Get-Content)\s/i.test(cmd)) {
          badge = '{grey-fg}📖 [Read File]{/grey-fg}';
        } else if (/^(git diff|git status)/i.test(cmd)) {
          badge = '{grey-fg}📊 [Git]{/grey-fg}';
        }
        emit('agent:msg', { tabId: 'codex', type: 'tool', text: `${badge} {white-fg}${safeEscape(cmd.slice(0, 85))}{/white-fg}` });
        emit('status', { tabId: 'codex', status: 'working', details: cmd.slice(0, 16) });
      }
    } else if (data.type === 'turn.completed' && data.usage) {
      const u = data.usage;
      const tokens = (u.input_tokens || 0) + (u.output_tokens || 0);
      config.totalTokens += tokens;
      emit('agent:msg', { tabId: 'codex', type: 'done', text: `{bold}{green-fg}✓ [Codex Turn #${config.turnCount} Complete]{/green-fg}{/bold} {grey-fg}│ Tokens: ${tokens.toLocaleString()}{/grey-fg}` });
    } else if (data.type === 'error' || data.error) {
      const errText = data.error && (data.error.message || data.error) || 'Codex execution error';
      let tip = '';
      if (errText.includes('429') || errText.toLowerCase().includes('rate')) {
        tip = '\n{yellow-fg}💡 Tip: OpenAI Codex rate limit. Try switching model: /model o3-mini or /model gpt-4o{/yellow-fg}';
      } else if (errText.includes('No such host') || errText.includes('websocket') || errText.includes('11001')) {
        tip = '\n{yellow-fg}💡 Network Error: DNS/Internet resolution failed. Check your internet connection.{/yellow-fg}';
      }
      emit('agent:msg', { tabId: 'codex', type: 'error', text: `{bold}{red-fg}❌ Codex Error: ${safeEscape(errText)}{/red-fg}{/bold}${tip}` });
      emit('status', { tabId: 'codex', status: 'idle', details: 'Error' });
    }
  } catch (e) {
    const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
    if (clean && !clean.startsWith('Reading additional input') && !clean.startsWith('[?')) {
      if (clean.includes('responses_websocket') || clean.includes('ERROR codex_api::') || clean.includes('No such host is known')) {
        return;
      }
      emit('agent:msg', { tabId: 'codex', type: 'raw', text: `{grey-fg}${safeEscape(clean)}{/grey-fg}` });
    }
  }
}

export function parseCmdcJsonLine(line, config, emit) {
  if (!line || !line.trim()) return;
  try {
    const data = JSON.parse(line);
    const event = data.event || data;
    const type = event.type || data.type;

    if (type === 'run_start' && (event.sessionId || data.sessionId)) {
      const sid = event.sessionId || data.sessionId;
      config.sessionId = sid;
      emit('agent:msg', { tabId: 'cmdc', type: 'session', text: `{bold}{magenta-fg}⚡ [Session ID:{/magenta-fg}{/bold} {yellow-fg}${safeEscape(sid.slice(0, 18))}...{/yellow-fg}{bold}{magenta-fg}]{/magenta-fg}{/bold}` });
    } else if (type === 'turn_start') {
      emit('status', { tabId: 'cmdc', status: 'working', details: 'Thinking' });
    } else if (type === 'model_request_start' && event.model) {
      emit('status', { tabId: 'cmdc', status: 'working', details: String(event.model).slice(0, 16) });
    } else if (type === 'text_delta' && event.delta) {
      config.hasStreamedResponse = true;
      emit('agent:stream', { tabId: 'cmdc', text: event.delta });
    } else if (type === 'tool_call' || type === 'tool_use') {
      const tool = event.tool || event.name || 'tool';
      let badge = '{magenta-fg}🔧 [Tool]{/magenta-fg}';
      let detail = event.command || event.path || event.query || (typeof event.input === 'string' ? event.input : JSON.stringify(event.input || ''));
      if (tool === 'run' || tool === 'bash' || tool === 'execute') {
        badge = '{white-fg}⚙️ [Run]{/white-fg}';
      } else if (tool === 'read' || tool === 'view_file') {
        badge = '{cyan-fg}📖 [Read File]{/cyan-fg}';
      } else if (tool === 'write' || tool === 'edit') {
        badge = '{green-fg}✏️ [Edit File]{/green-fg}';
      } else if (tool === 'grep' || tool === 'find') {
        badge = '{yellow-fg}🔍 [Search]{/yellow-fg}';
      }
      emit('agent:msg', { tabId: 'cmdc', type: 'tool', text: `${badge} {yellow-fg}${safeEscape(String(detail).slice(0, 85))}{/yellow-fg}` });
      emit('status', { tabId: 'cmdc', status: 'working', details: tool.slice(0, 16) });
    } else if (type === 'message_end' && event.content && !config.hasStreamedResponse) {
      const text = Array.isArray(event.content) ? event.content.map(c => c.text || '').join('') : (event.content || '');
      if (String(text).trim()) {
        emit('agent:msg', { tabId: 'cmdc', type: 'message', text: `{bold}{magenta-fg}💬 Command Code:{/magenta-fg}{/bold}\n${safeEscape(String(text).trim())}` });
      }
    } else if (type === 'run_end' || data.type === 'result') {
      const usage = event.usage || (data.result && data.result.usage) || data.usage;
      const tokens = usage ? (usage.inputTokens || 0) + (usage.outputTokens || 0) : 0;
      config.totalTokens += tokens;
      config.hasStreamedResponse = false;
      if (data.subtype === 'error' || event.subtype === 'error') {
        const errText = data.error || event.error || (data.result && data.result.error) || 'Command Code execution error';
        emit('agent:msg', { tabId: 'cmdc', type: 'error', text: `{bold}{red-fg}❌ Command Code Error: ${safeEscape(errText)}{/red-fg}{/bold}` });
        emit('status', { tabId: 'cmdc', status: 'idle', details: 'Error' });
      } else {
        emit('agent:msg', { tabId: 'cmdc', type: 'done', text: `{bold}{green-fg}✓ [Command Code Turn #${config.turnCount} Complete]{/green-fg}{/bold} {white-fg}│ Tokens: ${tokens.toLocaleString()}{/white-fg}` });
        emit('status', { tabId: 'cmdc', status: 'done', details: 'Done' });
      }
    }
  } catch (e) {
    const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
    if (clean && !clean.startsWith('[?') && clean !== 'default' && clean !== 'true' && clean !== 'false') {
      emit('agent:msg', { tabId: 'cmdc', type: 'raw', text: `{white-fg}${safeEscape(clean)}{/white-fg}` });
    }
  }
}

export function parseAgyJsonLine(line, config, emit) {
  parseCmdcJsonLine(line, config, emit);
}

function turfMessageText(message) {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (b.type === 'text' || typeof b.text === 'string'))
      .map((b) => b.text || '')
      .join('');
  }
  return '';
}

function turfAddUsage(config, usage) {
  if (!usage || typeof usage !== 'object') return;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  // Pi reports usage.totalTokens; fall back to input+output sum for other shapes
  const tokens = n(usage.totalTokens) || (n(usage.input) + n(usage.input_tokens) + n(usage.output) + n(usage.output_tokens));
  if (tokens > 0) config.totalTokens += tokens;
}

export function parseTurfJsonLine(line, config, emit) {
  if (!line || !line.trim()) return;
  let data;
  try {
    data = JSON.parse(line);
  } catch (e) {
    const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
    if (!clean || clean.startsWith('[?') || clean.startsWith('npm exec')) return;

    // Check for authentication error line e.g. `401 {"type":"error",...}` or `API key not valid`
    if (clean.includes('401') || clean.includes('authentication_error') || clean.includes('invalid x-api-key') || clean.includes('invalid_api_key') || clean.includes('API key not valid') || clean.includes('API_KEY_INVALID')) {
      config.lastTurnFailed = true;
      emit('agent:msg', {
        tabId: 'turf',
        type: 'error',
        text: `{bold}{red-fg}❌ Turf Authentication Error: Missing or invalid API key.{/red-fg}{/bold}\n{yellow-fg}💡 Tip: Use /key gemini <your-key> to configure API key, or press [F5] / type /demo for live rehearsal.{/yellow-fg}`
      });
      emit('status', { tabId: 'turf', status: 'idle', details: 'Auth Error' });
      return;
    }

    // Check for 429 rate limit error
    if (clean.includes('429') || clean.toLowerCase().includes('rate_limit') || clean.toLowerCase().includes('tokens per minute')) {
      config.lastTurnFailed = true;
      emit('agent:msg', {
        tabId: 'turf',
        type: 'error',
        text: `{bold}{red-fg}❌ Turf Rate Limit (429): Token limit reached on current provider.{/red-fg}{/bold}\n{yellow-fg}💡 Tip: Free Groq keys have a 20,000 TPM limit. Use Google Gemini Studio (1,000,000 TPM) or configure an Anthropic/OpenAI key.{/yellow-fg}`
      });
      emit('status', { tabId: 'turf', status: 'idle', details: 'Rate Limit' });
      return;
    }

    // Suppress standalone raw UUID session IDs from dumping into UI
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean)) {
      if (!config.sessionId) config.sessionId = clean;
      return;
    }

    emit('agent:msg', { tabId: 'turf', type: 'raw', text: `{grey-fg}${safeEscape(clean)}{/grey-fg}` });
    return;
  }
  if (!data || typeof data !== 'object') return;

  if (data.type === 'session' && data.id) {
    config.sessionId = data.id;
    emit('agent:msg', { tabId: 'turf', type: 'session', text: `{grey-fg}Session ID: {yellow-fg}${safeEscape(String(data.id))}{/yellow-fg}{/grey-fg}` });
  } else if (data.type === 'turn_start') {
    config.lastTurnFailed = false;
    config.hasStreamedResponse = false;
    emit('status', { tabId: 'turf', status: 'working', details: 'Thinking' });
  } else if (data.type === 'message_update') {
    turfAddUsage(config, data.usage);
    const ev = data.assistantMessageEvent;
    if (ev) {
      const delta = ev.delta || ev.text || (typeof ev.content === 'string' ? ev.content : '');
      if (delta && (ev.type === 'text_delta' || ev.event === 'text_delta' || !ev.type)) {
        config.hasStreamedResponse = true;
        emit('agent:stream', { tabId: 'turf', text: delta });
      } else if (delta && (ev.type === 'thought_delta' || ev.type === 'thinking_delta' || ev.event === 'thought_delta')) {
        emit('agent:stream', { tabId: 'turf', text: `{grey-fg}${safeEscape(delta)}{/grey-fg}` });
      }
    }
  } else if (data.type === 'message_end' && data.message && data.message.role === 'assistant') {
    const text = turfMessageText(data.message).trim();
    if (text) {
      emit('agent:msg', { tabId: 'turf', type: 'message', text: `{bold}{green-fg}Turf:{/green-fg}{/bold}\n${safeEscape(text)}` });
    } else if (data.message.errorMessage) {
      config.lastTurnFailed = true;
      const errStr = String(data.message.errorMessage);
      let friendlyError = '';
      let advice = '';

      if (errStr.includes('API key not valid') || errStr.includes('API_KEY_INVALID') || errStr.includes('401') || errStr.includes('authentication_error')) {
        friendlyError = 'Invalid or missing API key.';
        advice = '\n{yellow-fg}💡 Quick Fix: Use /key gemini <your-key> to set key, or press [F5] / type /demo for automated rehearsal.{/yellow-fg}';
      } else if (errStr.includes('429') || errStr.toLowerCase().includes('rate limit')) {
        friendlyError = 'Rate limit (429) reached on current provider.';
        advice = '\n{yellow-fg}💡 Tip: Free Groq keys have a 20,000 TPM limit. Switch to Google Gemini Studio for 1,000,000 TPM limit.{/yellow-fg}';
      } else {
        friendlyError = errStr.slice(0, 300);
      }
      emit('agent:msg', { tabId: 'turf', type: 'error', text: `{bold}{red-fg}❌ Turf Error: ${safeEscape(friendlyError)}{/red-fg}{/bold}${advice}` });
      emit('status', { tabId: 'turf', status: 'idle', details: 'Error' });
    }
    config.hasStreamedResponse = false;
  } else if (data.type === 'tool_execution_start' && data.toolName) {
    const name = String(data.toolName);
    let badge = '{grey-fg}⚙️ [Run]{/grey-fg}';
    if (/^(read)$/i.test(name)) badge = '{grey-fg}📖 [Read File]{/grey-fg}';
    else if (/^(write|edit)$/i.test(name)) badge = '{grey-fg}✏️ [Edit File]{/grey-fg}';
    else if (/^(grep|find|ls)$/i.test(name)) badge = '{grey-fg}🔍 [Search]{/grey-fg}';
    const arg = data.args && (data.args.path || data.args.command || data.args.pattern || '');
    emit('agent:msg', { tabId: 'turf', type: 'tool', text: `${badge} {white-fg}${safeEscape(String(arg).slice(0, 85))}{/white-fg}` });
    emit('status', { tabId: 'turf', status: 'working', details: name.slice(0, 16) });
  } else if (data.type === 'tool_execution_end' && data.isError) {
    const result = typeof data.result === 'string' ? data.result : JSON.stringify(data.result || 'tool failed');
    emit('agent:msg', { tabId: 'turf', type: 'error', text: `{red-fg}${safeEscape(result.slice(0, 300))}{/red-fg}` });
  } else if (data.type === 'agent_end') {
    config.hasStreamedResponse = false;
    if (!config.lastTurnFailed) {
      emit('agent:msg', { tabId: 'turf', type: 'done', text: `{bold}{green-fg}✓ [Turf Turn #${config.turnCount} Complete]{/green-fg}{/bold} {grey-fg}│ Tokens: ${config.totalTokens.toLocaleString()}{/grey-fg}` });
      emit('status', { tabId: 'turf', status: 'done', details: 'Done' });
    }
    config.lastTurnFailed = false;
  }
}

export function isAgentAvailable(agentName) {
  return findBinary(agentName) !== null;
}

export class PtyManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map(); // tabId -> active session info
    this.agentConfigs = new Map(); // tabId -> persistent session config and usage stats

    this.agentConfigs.set('codex', {
      sessionId: null,
      turnCount: 0,
      model: 'default',
      effort: 'medium',
      sandbox: 'workspace-write',
      totalTokens: 0
    });
    this.agentConfigs.set('cmdc', {
      sessionId: null,
      turnCount: 0,
      model: 'default',
      effort: 'medium',
      sandbox: 'workspace-write',
      totalTokens: 0,
      planMode: false
    });
    this.agentConfigs.set('agy', {
      sessionId: null,
      turnCount: 0,
      model: 'default',
      effort: 'medium',
      sandbox: 'workspace-write',
      totalTokens: 0,
      planMode: false
    });
    this.agentConfigs.set('turf', {
      sessionId: null,
      turnCount: 0,
      model: 'default',
      effort: 'medium',
      sandbox: 'workspace-write',
      totalTokens: 0,
      planMode: false
    });
    this.agentConfigs.set('term', {
      sessionId: null,
      turnCount: 0,
      model: 'none',
      effort: 'none',
      sandbox: 'system',
      totalTokens: 0
    });
  }

  isPtySupported() {
    return ptyModule !== null && typeof ptyModule.spawn === 'function';
  }

  isAgentInstalled(agentName) {
    return isAgentAvailable(agentName);
  }

  getAgentConfig(tabId) {
    if (!this.agentConfigs.has(tabId)) {
      this.agentConfigs.set(tabId, {
        sessionId: null,
        turnCount: 0,
        model: 'default',
        effort: 'medium',
        sandbox: 'workspace-write',
        totalTokens: 0,
        planMode: false
      });
    }
    return this.agentConfigs.get(tabId);
  }

  setModel(tabId, model) {
    const config = this.getAgentConfig(tabId);
    config.model = model;
    return config.model;
  }

  getModel(tabId) {
    return this.getAgentConfig(tabId).model;
  }

  setEffort(tabId, effort) {
    const valid = ['low', 'medium', 'high'];
    const norm = (effort || '').toLowerCase();
    if (valid.includes(norm)) {
      const config = this.getAgentConfig(tabId);
      config.effort = norm;
      return config.effort;
    }
    return null;
  }

  getEffort(tabId) {
    return this.getAgentConfig(tabId).effort;
  }

  setSandbox(tabId, sandbox) {
    const config = this.getAgentConfig(tabId);
    config.sandbox = sandbox;
    return config.sandbox;
  }

  getSandbox(tabId) {
    return this.getAgentConfig(tabId).sandbox;
  }

  resetSession(tabId) {
    const config = this.getAgentConfig(tabId);
    config.sessionId = null;
    config.turnCount = 0;
    config.totalTokens = 0;
    const session = this.sessions.get(tabId);
    if (session) session.currentScreen = '';
  }

  resumeSession(tabId, sessionId) {
    const config = this.getAgentConfig(tabId);
    config.sessionId = sessionId;
  }

  getUsageStats(tabId) {
    const config = this.getAgentConfig(tabId);
    return {
      tabId,
      sessionId: config.sessionId || '(No active session ID yet)',
      turnCount: config.turnCount,
      model: config.model,
      effort: config.effort,
      sandbox: config.sandbox,
      totalTokens: config.totalTokens,
      planMode: !!config.planMode
    };
  }

  setPlanMode(tabId, enabled) {
    const config = this.getAgentConfig(tabId);
    config.planMode = !!enabled;
    return config.planMode;
  }

  getPlanMode(tabId) {
    return !!this.getAgentConfig(tabId).planMode;
  }

  getStatus(tabId) {
    const session = this.sessions.get(tabId);
    return session ? session.status : 'idle';
  }

  getDetails(tabId) {
    const session = this.sessions.get(tabId);
    return session ? session.details : '';
  }

  getScreenContent(tabId) {
    const session = this.sessions.get(tabId);
    return session ? (session.currentScreen || '') : '';
  }

  isSessionActive(tabId) {
    const session = this.sessions.get(tabId);
    return !!(session && session.proc);
  }

  spawnSession(tabId, inputCmd, options = {}) {
    this.killSession(tabId);

    const isWin = process.platform === 'win32';
    const cwd = options.cwd || process.cwd();
    const cols = options.cols || 100;
    const rows = options.rows || 28;
    const env = {
      ...process.env,
      ...(() => {
        const envPaths = [
          path.join(os.homedir(), '.turf', '.env'),
          path.join(process.cwd(), '.env'),
          path.join(cwd, '.env')
        ];
        let merged = {};
        for (const p of envPaths) {
          if (fs.existsSync(p)) {
            try { Object.assign(merged, dotenv.parse(fs.readFileSync(p, 'utf8'))); } catch (e) {}
          }
        }
        return merged;
      })(),
      ...(options.env || {}),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      CLOUD_CODE_URL: 'https://cloudcode-pa.googleapis.com',
      CLOUD_ENV: 'CLOUD_ENVIRONMENT_PROD'
    };

    const isAgentTab = (tabId === 'codex' || tabId === 'cmdc' || tabId === 'agy' || tabId === 'turf');
    const prompt = inputCmd ? inputCmd.trim() : '';

    if (isAgentTab) {
      if (!prompt) {
        return null;
      }
      // Phase 1: Pre-Flight Intent Declaration
      const candidateFiles = extractFileCandidates(prompt, cwd);
      const user = options.user || process.env.TURF_USER || (tabId === 'turf' ? 'turf' : (tabId === 'codex' ? 'codex' : 'cmdc'));
      lockRegistry.declareIntent(tabId, user, candidateFiles, candidateFiles.length > 0 ? 'targeted' : 'recon');
      env.TURF_DAEMON = process.env.TURF_DAEMON || 'http://127.0.0.1:7873';
      env.TURF_ROOM = options.room || process.env.TURF_ROOM || 'TRF-XXXX';
      env.TURF_USER = user;
      env.TURF_AGENT_ID = tabId;
    }

    let file = '';
    let args = [];

    if (tabId === 'codex') {
      const bin = findBinary('codex');
      if (!bin) {
        throw new Error('OpenAI Codex CLI is not installed or not in PATH.');
      }
      file = bin;
      const config = this.getAgentConfig('codex');

      if (config.sessionId) {
        // Resume existing multi-turn session with full history
        args = ['exec', 'resume', '--json', '--dangerously-bypass-approvals-and-sandbox'];
        if (config.model && config.model !== 'default') {
          args.push('-m', config.model);
        }
        if (config.effort && config.effort !== 'medium') {
          args.push('-c', `model_reasoning_effort="${config.effort}"`);
        }
        args.push(config.sessionId, prompt);
      } else if (config.turnCount > 0) {
        // Resume most recent recorded session for this workspace
        args = ['exec', 'resume', '--last', '--json', '--dangerously-bypass-approvals-and-sandbox'];
        if (config.model && config.model !== 'default') {
          args.push('-m', config.model);
        }
        if (config.effort && config.effort !== 'medium') {
          args.push('-c', `model_reasoning_effort="${config.effort}"`);
        }
        args.push(prompt);
      } else {
        // Start new session with workspace-write permissions
        args = ['exec', '--json', '-s', config.sandbox, '--dangerously-bypass-approvals-and-sandbox'];
        if (config.model && config.model !== 'default') {
          args.push('-m', config.model);
        }
        if (config.effort && config.effort !== 'medium') {
          args.push('-c', `model_reasoning_effort="${config.effort}"`);
        }
        args.push(prompt);
      }
      config.turnCount++;
    } else if (tabId === 'cmdc' || tabId === 'agy') {
      const appData = process.env.APPDATA || '';
      const mjsPath = isWin ? path.join(appData, 'npm', 'node_modules', 'command-code', 'dist', 'index.mjs') : null;
      let bin = (mjsPath && fs.existsSync(mjsPath)) ? mjsPath : (findBinary('cmdc') || findBinary('command-code') || findBinary('agy'));
      if (!bin) {
        throw new Error('Command Code (cmdc) CLI is not installed or not in PATH.');
      }
      const config = this.getAgentConfig(tabId);

      if (bin.endsWith('.mjs') || bin.endsWith('.js')) {
        file = process.execPath;
        args = [bin, '-p', prompt, '--output-format', 'json', '--trust'];
        if (fs.existsSync(TURF_GUARD_LOADER)) {
          args.unshift('--import', pathToFileURL(TURF_GUARD_LOADER).href);
        }
      } else {
        file = bin;
        args = ['-p', prompt, '--output-format', 'json', '--trust'];
        if (fs.existsSync(TURF_GUARD_LOADER)) {
          env.NODE_OPTIONS = (env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : '') + `--import "${pathToFileURL(TURF_GUARD_LOADER).href}"`;
        }
      }

      if (config.sessionId) {
        args.push('--resume', config.sessionId);
      } else if (config.turnCount > 0) {
        args.push('-c');
      }

      if (config.model && config.model !== 'default') {
        args.push('--model', config.model);
      }

      if (config.planMode) {
        args.push('--mode', 'plan');
      }
      config.turnCount++;
    } else if (tabId === 'turf') {
      const resolved = resolveTurf();
      if (!resolved) {
        throw new Error('Turf agent is not installed. Run `npm install` in the turfcode repo first.');
      }
      file = resolved.file;
      const config = this.getAgentConfig('turf');


      // Pi-native flags: --mode json event stream, -p non-interactive, -c/--session resume,
      // --thinking effort, --tools allowlist as the read-only/plan gate.
      args = [...resolved.prefix, '--mode', 'json', '-p'];
      if (config.sessionId) {
        args.push('--session', config.sessionId);
      } else if (config.turnCount > 0) {
        args.push('-c');
      }

      if (config.model && config.model !== 'default') {
        let m = config.model;
        if (m.startsWith('deepseek') && !m.includes('/')) {
          const modelId = (m === 'deepseek-chat' || m === 'deepseek-flash') ? 'deepseek-v4-flash' : (m === 'deepseek-reasoner' ? 'deepseek-v4-pro' : m);
          args.push('--provider', 'deepseek', '--model', modelId);
        } else if ((m.startsWith('llama') || m.includes('qwen') || m.includes('gpt-oss') || m.includes('compound')) && !m.includes('/')) {
          args.push('--provider', 'groq', '--model', m);
        } else if ((m.startsWith('gemini') || m.startsWith('gemma')) && !m.includes('/')) {
          args.push('--provider', 'google', '--model', m);
        } else {
          args.push('--model', m);
        }
      } else if (env.DEEPSEEK_API_KEY) {
        args.push('--provider', 'deepseek', '--model', 'deepseek-v4-flash');
      } else if (!env.ANTHROPIC_API_KEY && env.GROQ_API_KEY) {
        args.push('--provider', 'groq', '--model', 'openai/gpt-oss-120b');
      } else if (!env.ANTHROPIC_API_KEY && env.OPENAI_API_KEY) {
        args.push('--provider', 'openai', '--model', 'gpt-4o');
      } else if (env.GEMINI_API_KEY) {
        args.push('--provider', 'google', '--model', 'gemini-2.0-flash');
      }
      if (config.effort && config.effort !== 'medium') {
        args.push('--thinking', config.effort);
      }
      if (config.planMode || config.sandbox === 'read-only') {
        args.push('--tools', 'read,grep,find,ls');
      }
      args.push(prompt);
      config.turnCount++;
    } else {
      // Shell / Terminal tab
      if (isWin) {
        file = 'powershell.exe';
        args = inputCmd ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', inputCmd] : ['-NoProfile', '-ExecutionPolicy', 'Bypass'];
      } else {
        file = process.env.SHELL || 'bash';
        args = inputCmd ? ['-c', inputCmd] : [];
      }
    }

    let proc = null;
    let isPty = false;

    if (isAgentTab) {
      try {
        proc = spawn(file, args, {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        isPty = false;
      } catch (err) {
        proc = null;
      }
    } else if (this.isPtySupported()) {
      try {
        proc = ptyModule.spawn(file, args, {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env
        });
        isPty = true;
      } catch (err) {
        if (isWin) {
          try {
            proc = ptyModule.spawn('cmd.exe', ['/c', file, ...args], {
              name: 'xterm-256color',
              cols,
              rows,
              cwd,
              env
            });
            isPty = true;
          } catch (e2) {
            proc = null;
          }
        }
      }
    }

    if (!proc) {
      throw new Error(`Failed to spawn process for ${tabId} (${file})`);
    }

    if (proc && proc.pid) {
      lockRegistry.associateProcess(tabId, proc.pid);
    }


    const virtualTerminal = isAgentTab ? null : new Terminal({
      cols,
      rows,
      allowProposedApi: true
    });
    const serializeAddon = isAgentTab ? null : new SerializeAddon();
    if (virtualTerminal && serializeAddon) {
      virtualTerminal.loadAddon(serializeAddon);
    }

    const session = {
      proc,
      isPty,
      tabId,
      status: 'working',
      details: inputCmd ? inputCmd.slice(0, 24) : 'Active',
      virtualTerminal,
      serializeAddon,
      currentScreen: '',
      startTime: Date.now()
    };
    this.sessions.set(tabId, session);

    this.emit('status', { tabId, status: 'working', details: session.details });

    proc.on('error', (err) => {
      session.proc = null;
      session.status = 'idle';
      session.details = 'Error';
      if (isAgentTab) {
        this.emit('agent:msg', {
          tabId,
          type: 'error',
          text: `{bold}{red-fg}[${tabId.toUpperCase()} Process Error: ${safeEscape(err.message)}]{/red-fg}{/bold}`
        });
      } else {
        this.emit('data', { tabId, data: `\r\n[Process error: ${safeEscape(err.message)}]\r\n` });
      }
      this.emit('status', { tabId, status: 'idle', details: 'Error' });
      this.emit('exit', { tabId, exitCode: 1 });
    });

    if (isAgentTab) {
      if (proc.stdout) proc.stdout.on('error', () => {});
      if (proc.stderr) proc.stderr.on('error', () => {});
      if (proc.stdin) proc.stdin.on('error', () => {});

      const config = this.getAgentConfig(tabId);
      let lineBuf = '';
      proc.stdout.on('data', (chunk) => {
        lineBuf += chunk.toString();
        const lines = lineBuf.split(/\r?\n/);
        lineBuf = lines.pop();
        for (const line of lines) {
          if (tabId === 'codex') {
            parseCodexJsonLine(line, config, (ev, pl) => this.emit(ev, pl));
          } else if (tabId === 'cmdc' || tabId === 'agy') {
            parseCmdcJsonLine(line, config, (ev, pl) => this.emit(ev, pl));
          } else if (tabId === 'turf') {
            parseTurfJsonLine(line, config, (ev, pl) => this.emit(ev, pl));
          }
        }
        this.emit('data', { tabId, data: chunk.toString() });
      });

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
        if (!text || text.startsWith('Reading additional input') || text.includes('npm exec') || text.startsWith('[?')) {
          return;
        }

        if (tabId === 'cmdc' || tabId === 'agy') {
          this.emit('agent:msg', { tabId, type: 'error', text: `{red-fg}${safeEscape(text)}{/red-fg}` });
        } else if (tabId === 'codex') {
          // OpenAI Codex network / websocket DNS failure check
          if (text.includes('No such host is known') || text.includes('failed to connect to websocket') || text.includes('os error 11001')) {
            if (!session._notifiedNetworkError) {
              session._notifiedNetworkError = true;
              this.emit('agent:msg', {
                tabId: 'codex',
                type: 'error',
                text: `{bold}{red-fg}📡 Codex Network Error: Unable to reach OpenAI ChatGPT (DNS/Internet disconnected).{/red-fg}{/bold}\n{yellow-fg}💡 Check your internet connection and try again.{/yellow-fg}`
              });
              this.emit('status', { tabId: 'codex', status: 'idle', details: 'Network Error' });
            }
            return;
          }

          // Suppress repetitive Rust tracing stderr logs from Codex CLI
          if (text.includes('ERROR codex_api::') || text.includes('responses_websocket')) {
            return;
          }

          // OpenAI Codex rate limit check
          if (text.includes('429') || text.toLowerCase().includes('rate_limit') || text.toLowerCase().includes('rate limit')) {
            this.emit('agent:msg', {
              tabId: 'codex',
              type: 'error',
              text: `{bold}{red-fg}⚠️ OpenAI Codex Rate Limit Reached (429).{/red-fg}{/bold}\n{yellow-fg}💡 Tip: Switch Codex model with /model (e.g. /model o3-mini or /model gpt-4o){/yellow-fg}`
            });
            this.emit('status', { tabId: 'codex', status: 'idle', details: 'Rate Limit' });
            return;
          }

          this.emit('agent:msg', { tabId: 'codex', type: 'error', text: `{red-fg}${safeEscape(text)}{/red-fg}` });
        } else {
          this.emit('agent:msg', { tabId, type: 'error', text: `{red-fg}${safeEscape(text)}{/red-fg}` });
        }
      });

      proc.on('close', (exitCode) => {
        if (lineBuf && lineBuf.trim()) {
          if (tabId === 'codex') parseCodexJsonLine(lineBuf, config, (ev, pl) => this.emit(ev, pl));
          else if (tabId === 'cmdc' || tabId === 'agy') parseCmdcJsonLine(lineBuf, config, (ev, pl) => this.emit(ev, pl));
          else if (tabId === 'turf') parseTurfJsonLine(lineBuf, config, (ev, pl) => this.emit(ev, pl));
        }
      });
    } else {
      // Shell tab PTY
      proc.on('data', (data) => {
        const text = typeof data === 'string' ? data : data.toString();
        if (virtualTerminal && serializeAddon) {
          virtualTerminal.write(text, () => {
            try {
              const rendered = serializeAddon.serialize();
              session.currentScreen = rendered;
              this.emit('screen', { tabId, content: rendered });
            } catch (e) {}
          });
        }
        this.emit('data', { tabId, data: text });
      });
    }

    proc.on('exit', (exitCode) => {
      lockRegistry.clearIntent(tabId);
      lockRegistry.releaseAllForUser(tabId);
      session.proc = null;
      session.status = exitCode === 0 ? 'done' : 'idle';
      session.details = exitCode === 0 ? 'Done' : (exitCode !== null ? `Exited (${exitCode})` : '');
      this.emit('status', { tabId, status: session.status, details: session.details });
      this.emit('exit', { tabId, exitCode });
    });

    return session;
  }

  write(tabId, data) {
    const session = this.sessions.get(tabId);
    if (!session || !session.proc) return false;
    try {
      if (session.isPty) {
        session.proc.write(data);
      } else if (session.proc.stdin && !session.proc.stdin.destroyed) {
        session.proc.stdin.write(data);
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  resize(tabId, cols, rows) {
    const session = this.sessions.get(tabId);
    if (session && session.proc && session.isPty && typeof session.proc.resize === 'function') {
      try {
        session.proc.resize(Math.max(10, cols), Math.max(5, rows));
        if (session.virtualTerminal) {
          session.virtualTerminal.resize(Math.max(10, cols), Math.max(5, rows));
        }
      } catch (e) {}
    }
  }

  killSession(tabId) {
    lockRegistry.clearIntent(tabId);
    lockRegistry.releaseAllForUser(tabId);
    const session = this.sessions.get(tabId);
    if (!session || !session.proc) return;
    try {
      if (session.isPty && typeof session.proc.kill === 'function') {
        session.proc.kill();
      } else if (session.proc.pid) {
        if (process.platform === 'win32') {
          const { exec } = require('child_process');
          exec('taskkill /F /T /PID ' + session.proc.pid, () => {});
        } else {
          session.proc.kill('SIGKILL');
        }
      }
    } catch (e) {}
    session.proc = null;
    session.status = 'idle';
    session.details = '';
    this.emit('status', { tabId, status: 'idle', details: '' });
  }

  killAll() {
    for (const tabId of this.sessions.keys()) {
      this.killSession(tabId);
    }
  }
}

export const ptyManager = new PtyManager();
