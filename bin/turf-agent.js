#!/usr/bin/env node
// turf: Turfcode's built-in coding agent entry point.
// Thin wrapper over Pi (@earendil-works/pi-coding-agent, MIT) that always
// loads the turf-lock extension (intent locks before write/edit).
// Usage: turf [--mode json] [-c|--session <id>] [--model m] [--thinking l] [--tools ...] [prompt...]
// Env: TURF_DAEMON (default http://127.0.0.1:7873), TURF_ROOM, TURF_USER, TURF_AGENT_ID.
// ponytail: arg forwarding + env defaults, no arg parsing framework.
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import dotenv from 'dotenv';
import { getNextGroqApiKey } from '../server/model_discovery.js';

dotenv.config();
const globalEnv = path.join(os.homedir(), '.turf', '.env');
if (fs.existsSync(globalEnv)) {
  dotenv.config({ path: globalEnv, override: true });
}
if (fs.existsSync(path.join(process.cwd(), '.env'))) {
  dotenv.config({ path: path.join(process.cwd(), '.env'), override: true });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PI_CLI = path.join(ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
const EXT = path.join(ROOT, 'agent', 'turf-lock', 'index.ts');
const HOOK = path.join(ROOT, 'server', 'turf-hook.js');

if (!fs.existsSync(PI_CLI)) {
  console.error('turf: Pi engine missing. Run `npm install` in the turfcode repo first.');
  process.exit(1);
}

const rotatedGroq = getNextGroqApiKey(process.cwd());
const env = {
  ...process.env,
  ...(rotatedGroq ? { GROQ_API_KEY: rotatedGroq } : {}),
  TURF_DAEMON: process.env.TURF_DAEMON || 'http://127.0.0.1:7873',
  TURF_ROOM: process.env.TURF_ROOM || 'TRF-XXXX',
  TURF_USER: process.env.TURF_USER || 'turf',
  TURF_AGENT_ID: process.env.TURF_AGENT_ID || 'turf',
  TURF_HOOK: HOOK
};

const rawArgs = process.argv.slice(2);
const optionsWithValues = new Set([
  '--mode', '-c', '--session', '--model', '-m', '--thinking',
  '--tools', '-t', '--exclude-tools', '-xt', '--extension', '-e',
  '--skill', '--prompt-template', '-np', '--theme', '--use-theme',
  '--export', '--provider'
]);

const parsedFlags = [];
const positionalPrompts = [];

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--') {
    positionalPrompts.push(...rawArgs.slice(i + 1));
    break;
  }
  if (arg.startsWith('-')) {
    parsedFlags.push(arg);
    if (!arg.includes('=') && optionsWithValues.has(arg) && i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('-')) {
      parsedFlags.push(rawArgs[++i]);
    }
  } else {
    positionalPrompts.push(arg);
  }
}

if (fs.existsSync(EXT) && !parsedFlags.includes('--no-extensions') && !parsedFlags.includes('-ne')) {
  parsedFlags.push('-e', EXT);
}

// Optimize token usage on free tiers by avoiding unnecessary reasoning bloat
if (!parsedFlags.includes('--thinking') && !parsedFlags.some(a => a.startsWith('--thinking='))) {
  parsedFlags.push('--thinking', 'off');
}

// Ensure non-interactive execution flag (-p) when prompt or --mode is provided
const args = parsedFlags;
const hasPrint = args.includes('-p') || args.includes('--print');
const isModeJson = args.includes('--mode') && args[args.indexOf('--mode') + 1] === 'json';
const hasPositionalPrompt = positionalPrompts.length > 0;

if (!hasPrint && (isModeJson || hasPositionalPrompt)) {
  args.unshift('-p');
}

// Auto-configure provider if not explicitly given
if (!parsedFlags.includes('--provider') && !parsedFlags.some(a => a.startsWith('--provider='))) {
  if (env.DEEPSEEK_API_KEY && !parsedFlags.includes('--model') && !parsedFlags.some(a => a.startsWith('--model='))) {
    parsedFlags.push('--provider', 'deepseek', '--model', 'deepseek-v4-flash');
  } else if (env.GROQ_API_KEY && !parsedFlags.includes('--model') && !parsedFlags.some(a => a.startsWith('--model='))) {
    parsedFlags.push('--provider', 'groq', '--model', 'llama-3.3-70b-versatile');
  } else if (env.OPENAI_API_KEY && !parsedFlags.includes('--model') && !parsedFlags.some(a => a.startsWith('--model='))) {
    parsedFlags.push('--provider', 'openai', '--model', 'gpt-4o');
  } else if (env.GEMINI_API_KEY && !parsedFlags.includes('--model') && !parsedFlags.some(a => a.startsWith('--model='))) {
    parsedFlags.push('--provider', 'google', '--model', 'gemini-2.0-flash');
  }
}

const finalArgs = [...parsedFlags, ...positionalPrompts];
const res = spawnSync(process.execPath, [PI_CLI, ...finalArgs], { stdio: 'inherit', env });
process.exit(res.status ?? 1);

