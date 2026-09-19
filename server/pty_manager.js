import { createRequire } from 'module';
import { EventEmitter } from 'events';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import pkgHeadless from '@xterm/headless';
const { Terminal } = pkgHeadless;
import pkgSerialize from '@xterm/addon-serialize';
const { SerializeAddon } = pkgSerialize;

const require = createRequire(import.meta.url);

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
    if (name === 'agy') {
      const agyPath = path.join(localAppData, 'agy', 'bin', 'agy.exe');
      if (fs.existsSync(agyPath)) return agyPath;
    }
    if (name === 'codex') {
      const codexPath = path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
      if (fs.existsSync(codexPath)) return codexPath;
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

export function parseAgyJsonLine(line, config, emit) {
  if (!line || !line.trim()) return;
  try {
    const data = JSON.parse(line);
    if ((data.event === 'init' || data.event === 'session_started') && data.conversation_id) {
      config.sessionId = data.conversation_id;
      emit('agent:msg', { tabId: 'agy', type: 'session', text: `{bold}{149-fg}⚡ [Session ID:{/149-fg}{/bold} {yellow-fg}${safeEscape(data.conversation_id.slice(0, 18))}...{/yellow-fg}{bold}{149-fg}]{/149-fg}{/bold}` });
    } else if (data.event === 'step_update' && data.step_update) {
      const su = data.step_update;
      if (su.conversation_id && !config.sessionId) config.sessionId = su.conversation_id;

      if (su.step_type === 'tool' && su.state === 'ACTIVE') {
        const tName = su.tool_name || (su.tool_info && su.tool_info.name) || 'tool';
        const p = su.tool_info && su.tool_info.parameters ? su.tool_info.parameters : {};
        if (tName === 'run_command' && p.CommandLine) {
          emit('agent:msg', { tabId: 'agy', type: 'tool', text: `{white-fg}⚙️ [Run]{/white-fg} {yellow-fg}${safeEscape(p.CommandLine.slice(0, 85))}{/yellow-fg}` });
        } else if (tName === 'view_file') {
          const fn = path.basename(p.TargetFile || p.AbsolutePath || '');
          emit('agent:msg', { tabId: 'agy', type: 'tool', text: `{white-fg}📖 [Read File]{/white-fg} {cyan-fg}${safeEscape(fn)}{/cyan-fg}` });
        } else if (tName === 'replace_file_content' || tName === 'write_to_file') {
          const fn = path.basename(p.TargetFile || '');
          emit('agent:msg', { tabId: 'agy', type: 'tool', text: `{white-fg}✏️ [Edit File]{/white-fg} {green-fg}${safeEscape(fn)}{/green-fg}` });
        } else if (tName === 'grep_search' || tName === 'find_by_name') {
          emit('agent:msg', { tabId: 'agy', type: 'tool', text: `{white-fg}🔍 [Search Code]{/white-fg} {yellow-fg}${safeEscape(p.Query || p.Pattern || '')}{/yellow-fg}` });
        } else {
          emit('agent:msg', { tabId: 'agy', type: 'tool', text: `{white-fg}🔧 [${safeEscape(tName)}]{/white-fg}` });
        }
        emit('status', { tabId: 'agy', status: 'working', details: tName });
      } else if (su.step_type === 'agent_response') {
        if (su.text_delta) {
          config.hasStreamedResponse = true;
          emit('agent:stream', { tabId: 'agy', text: su.text_delta });
        }
        if (su.state === 'ACTIVE') {
          emit('status', { tabId: 'agy', status: 'working', details: 'Responding' });
        } else if (su.state === 'DONE' && su.usage) {
          config.totalTokens += (su.usage.total_tokens || 0);
        }
      }
    } else if (data.event === 'result' && data.result) {
      const res = data.result;
      if (res.conversation_id && !config.sessionId) config.sessionId = res.conversation_id;
      if (res.response && !config.hasStreamedResponse) {
        emit('agent:msg', { tabId: 'agy', type: 'message', text: `{bold}{149-fg}💬 Antigravity:{/149-fg}{/bold}\n${safeEscape(res.response.trim())}` });
      }
      config.hasStreamedResponse = false;
      if (res.error || res.status === 'ERROR') {
        const errStr = res.error || 'Execution encountered an error';
        let tip = '';
        if (errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED')) {
          tip = '\n{yellow-fg}💡 Tip: Rate limit exhausted (429). Try switching model: /model gemini-3.8-flash-high or /model gemini-3.7-flash-high or /model claude-sonnet-4-6{/yellow-fg}';
        }
        emit('agent:msg', { tabId: 'agy', type: 'error', text: `{bold}{red-fg}❌ Antigravity Error: ${safeEscape(errStr)}{/red-fg}{/bold}${tip}` });
        emit('status', { tabId: 'agy', status: 'idle', details: 'Error' });
      } else {
        const tokens = res.usage ? res.usage.total_tokens : 0;
        emit('agent:msg', { tabId: 'agy', type: 'done', text: `{bold}{green-fg}✓ [Antigravity Turn #${config.turnCount} Complete]{/green-fg}{/bold} {white-fg}│ Tokens: ${(tokens || 0).toLocaleString()}{/white-fg}` });
        emit('status', { tabId: 'agy', status: 'done', details: 'Done' });
      }
    }
  } catch (e) {
    const clean = line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
    if (clean && !clean.startsWith('[?') && !clean.startsWith('npm exec') && clean !== 'default' && clean !== 'true' && clean !== 'false') {
      emit('agent:msg', { tabId: 'agy', type: 'raw', text: `{white-fg}${safeEscape(clean)}{/white-fg}` });
    }
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
    this.agentConfigs.set('agy', {
      sessionId: null,
      turnCount: 0,
      model: 'gemini-3.8-flash-high',
      effort: 'medium',
      sandbox: 'workspace-write',
      totalTokens: 0,
      hasStreamedResponse: false
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
        totalTokens: 0
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
      totalTokens: config.totalTokens
    };
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
      ...(options.env || {}),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      CLOUD_CODE_URL: 'https://cloudcode-pa.googleapis.com',
      CLOUD_ENV: 'CLOUD_ENVIRONMENT_PROD'
    };

    let file = '';
    let args = [];

    if (tabId === 'codex') {
      const bin = findBinary('codex');
      if (!bin) {
        throw new Error('OpenAI Codex CLI is not installed or not in PATH.');
      }
      file = bin;
      const config = this.getAgentConfig('codex');
      const prompt = inputCmd ? inputCmd.trim() : '';

      if (!prompt) {
        return null;
      }

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
    } else if (tabId === 'agy') {
      const bin = findBinary('agy');
      if (!bin) {
        throw new Error('Antigravity (agy) CLI is not installed or not in PATH.');
      }
      file = bin;
      const config = this.getAgentConfig('agy');
      const prompt = inputCmd ? inputCmd.trim() : '';

      if (!prompt) {
        return null;
      }

      args = ['-p', prompt, '--output-format', 'stream-json', '--dangerously-skip-permissions', '--disable-slash-commands'];
      if (config.sessionId) {
        args.push('--conversation', config.sessionId);
      } else if (config.turnCount > 0) {
        args.push('-c');
      }

      // Always pass modern high-quota model for Antigravity (default to gemini-3.8-flash-high)
      const agyModel = (config.model && config.model !== 'default') ? config.model : 'gemini-3.8-flash-high';
      args.push('--model', agyModel);

      if (config.effort && config.effort !== 'medium') {
        args.push('--effort', config.effort);
      }
      config.hasStreamedResponse = false;
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

    const isAgentTab = (tabId === 'codex' || tabId === 'agy');
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
          } else if (tabId === 'agy') {
            parseAgyJsonLine(line, config, (ev, pl) => this.emit(ev, pl));
          }
        }
        this.emit('data', { tabId, data: chunk.toString() });
      });

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
        if (!text || text.startsWith('Reading additional input') || text.includes('npm exec') || text.startsWith('[?')) {
          return;
        }

        if (tabId === 'agy') {
          // Antigravity (Google Cloud Code) network / DNS failure check
          if (text.includes('no such host') || text.includes('lookup cloudcode') || text.includes('Eligibility check failed') || text.includes('dial tcp')) {
            this.emit('agent:msg', {
              tabId: 'agy',
              type: 'error',
              text: `{bold}{red-fg}📡 Antigravity Network Error: Unable to reach Google Cloud Code (DNS/Internet disconnected).{/red-fg}{/bold}\n{yellow-fg}💡 Check your internet connection and try again.{/yellow-fg}`
            });
            this.emit('status', { tabId: 'agy', status: 'idle', details: 'Network Error' });
            return;
          }

          // Antigravity rate limit / quota exhaustion check
          if (text.includes('RESOURCE_EXHAUSTED') || text.includes('429')) {
            this.emit('agent:msg', {
              tabId: 'agy',
              type: 'error',
              text: `{bold}{red-fg}⚠️ Antigravity Rate limit reached (429 Resource Exhausted).{/red-fg}{/bold}\n{yellow-fg}💡 Tip: Switch model with /model (e.g. /model gemini-3.8-flash-high or /model gemini-3.7-flash-high or /model claude-sonnet-4-6){/yellow-fg}`
            });
            this.emit('status', { tabId: 'agy', status: 'idle', details: 'Rate Limit' });
            return;
          }

          this.emit('agent:msg', { tabId: 'agy', type: 'error', text: `{red-fg}${safeEscape(text)}{/red-fg}` });
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
          else if (tabId === 'agy') parseAgyJsonLine(lineBuf, config, (ev, pl) => this.emit(ev, pl));
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
