import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Cache for live models with TTL (5 minutes)
const modelCache = {
  deepseek: { timestamp: 0, models: [] },
  groq: { timestamp: 0, models: [] },
  gemini: { timestamp: 0, models: [] },
  openai: { timestamp: 0, models: [] },
  cmdc: { timestamp: 0, models: [] }
};
const CACHE_TTL_MS = 5 * 60 * 1000;

export function invalidateModelCache() {
  modelCache.deepseek = { timestamp: 0, models: [] };
  modelCache.groq = { timestamp: 0, models: [] };
  modelCache.gemini = { timestamp: 0, models: [] };
  modelCache.openai = { timestamp: 0, models: [] };
  modelCache.cmdc = { timestamp: 0, models: [] };
}

function ensureEnv(cwd) {
  if (cwd && fs.existsSync(path.join(cwd, '.env'))) {
    try {
      const parsed = dotenv.parse(fs.readFileSync(path.join(cwd, '.env')));
      for (const [k, v] of Object.entries(parsed)) {
        if (!process.env[k]) process.env[k] = v;
      }
    } catch (e) {}
  }
}

/**
 * Fetch live available models from DeepSeek API in real time using DEEPSEEK_API_KEY
 */
export async function fetchLiveDeepSeekModels(apiKey) {
  if (!apiKey) return [];
  const now = Date.now();
  if (modelCache.deepseek && modelCache.deepseek.models.length > 0 && (now - modelCache.deepseek.timestamp) < CACHE_TTL_MS) {
    return modelCache.deepseek.models;
  }

  try {
    const res = await fetch('https://api.deepseek.com/models', {
      headers: { 'Authorization': `Bearer ${apiKey.trim()}` },
      signal: AbortSignal.timeout(3500)
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data || !Array.isArray(data.data)) return [];

    const models = [
      { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', desc: 'DeepSeek V4 Flash (Flagship coder - Ultra-fast - Recommended)' },
      { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro', desc: 'DeepSeek V4 Pro (Deep reasoning, math & architecture)' }
    ];

    modelCache.deepseek = { timestamp: now, models };
    return models;
  } catch (err) {
    return [];
  }
}

/**
 * Fetch live available models from Groq API in real time using GROQ_API_KEY
 */
export async function fetchLiveGroqModels(apiKey) {
  if (!apiKey) return [];
  const now = Date.now();
  if (modelCache.groq.models.length > 0 && (now - modelCache.groq.timestamp) < CACHE_TTL_MS) {
    return modelCache.groq.models;
  }

  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey.trim()}` },
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data || !Array.isArray(data.data)) return [];

    // Filter out non-chat models (whisper, prompt-guard, etc.)
    const chatModels = data.data
      .map(m => m.id)
      .filter(id => {
        const lower = id.toLowerCase();
        if (lower.includes('whisper')) return false;
        if (lower.includes('prompt-guard')) return false;
        if (lower.includes('safeguard')) return false;
        if (lower.includes('orpheus')) return false;
        return true;
      });

    const mapped = chatModels.map(id => {
      let desc = 'Groq cloud acceleration';
      if (id.includes('gpt-oss-120b')) desc = 'GPT-OSS 120B (Deep reasoning, 500 t/s)';
      else if (id.includes('gpt-oss-20b')) desc = 'GPT-OSS 20B (High speed, low latency)';
      else if (id.includes('qwen')) desc = 'Qwen 3.8 (Multilingual & coding)';
      else if (id.includes('compound')) desc = 'Groq Compound (Agentic router)';
      else if (id.includes('llama')) desc = 'Meta Llama (Groq fast tier)';
      return { id, label: id, desc };
    });

    // Prioritize 120b first, then 20b, then qwen
    mapped.sort((a, b) => {
      if (a.id.includes('120b')) return -1;
      if (b.id.includes('120b')) return 1;
      if (a.id.includes('20b')) return -1;
      if (b.id.includes('20b')) return 1;
      return a.id.localeCompare(b.id);
    });

    modelCache.groq = { timestamp: now, models: mapped };
    return mapped;
  } catch (err) {
    return [];
  }
}

/**
 * Fetch live available models from Google Gemini API in real time using GEMINI_API_KEY
 */
export async function fetchLiveGeminiModels(apiKey) {
  if (!apiKey) return [];
  const now = Date.now();
  if (modelCache.gemini && modelCache.gemini.models.length > 0 && (now - modelCache.gemini.timestamp) < CACHE_TTL_MS) {
    return modelCache.gemini.models;
  }

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey.trim()}`, {
      signal: AbortSignal.timeout(3500)
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data || !Array.isArray(data.models)) return [];

    const contentModels = data.models
      .filter(m => {
        const methods = m.supportedGenerationMethods || [];
        return methods.includes('generateContent');
      })
      .map(m => {
        const id = m.name.replace(/^models\//, '');
        const displayName = m.displayName || id;
        let desc = m.description || 'Google Gemini Model';
        if (id.includes('2.5-flash')) desc = `${displayName} (Latest flagship - 1M TPM Free - Recommended)`;
        else if (id.includes('2.5-pro')) desc = `${displayName} (Advanced reasoning & coding)`;
        else if (id.includes('2.0-flash-lite')) desc = `${displayName} (High speed, cost efficient)`;
        else if (id.includes('2.0-flash')) desc = `${displayName} (High speed multimodal)`;
        else if (id.includes('1.5-pro')) desc = `${displayName} (Deep context)`;
        else if (id.includes('1.5-flash')) desc = `${displayName} (Fast inference)`;
        return { id, label: id, desc };
      })
      .filter(m => {
        const lower = m.id.toLowerCase();
        return (lower.includes('gemini') || lower.includes('gemma')) &&
          !lower.includes('embedding') &&
          !lower.includes('aqa') &&
          !lower.includes('imagen');
      });

    contentModels.sort((a, b) => {
      const rank = (id) => {
        if (id === 'gemini-2.5-flash') return 1;
        if (id === 'gemini-2.5-pro') return 2;
        if (id === 'gemini-2.0-flash') return 3;
        if (id === 'gemini-2.0-flash-lite') return 4;
        if (id.includes('2.5')) return 5;
        if (id.includes('2.0')) return 6;
        if (id.includes('1.5-pro')) return 7;
        if (id.includes('1.5-flash')) return 8;
        return 9;
      };
      return rank(a.id) - rank(b.id);
    });

    if (contentModels.length > 0) {
      modelCache.gemini = { timestamp: now, models: contentModels };
      return contentModels;
    }
    return [];
  } catch (err) {
    return [];
  }
}

/**
 * Fetch live available models from OpenAI API in real time using OPENAI_API_KEY
 */
export async function fetchLiveOpenAIModels(apiKey) {
  if (!apiKey) return [];
  const now = Date.now();
  if (modelCache.openai && modelCache.openai.models.length > 0 && (now - modelCache.openai.timestamp) < CACHE_TTL_MS) {
    return modelCache.openai.models;
  }

  try {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey.trim()}` },
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data || !Array.isArray(data.data)) return [];

    const allowed = ['o3-mini', 'o1', 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4.5-preview'];
    const filtered = data.data
      .map(m => m.id)
      .filter(id => allowed.includes(id) || id.startsWith('gpt-4') || id.startsWith('o1') || id.startsWith('o3'))
      .map(id => {
        let desc = 'OpenAI model';
        if (id === 'o3-mini') desc = 'OpenAI o3-mini (High reasoning, fast)';
        else if (id === 'gpt-4o') desc = 'OpenAI GPT-4o (Multimodal intelligence)';
        else if (id === 'gpt-4o-mini') desc = 'OpenAI GPT-4o Mini (Fast & affordable)';
        else if (id === 'o1') desc = 'OpenAI o1 (Full reasoning depth)';
        return { id, label: id, desc };
      });

    filtered.sort((a, b) => {
      const order = ['o3-mini', 'gpt-4o', 'gpt-4o-mini', 'o1'];
      const aIdx = order.indexOf(a.id);
      const bIdx = order.indexOf(b.id);
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return a.id.localeCompare(b.id);
    });

    if (filtered.length > 0) {
      modelCache.openai = { timestamp: now, models: filtered };
      return filtered;
    }
    return [];
  } catch (err) {
    return [];
  }
}

let currentKeyIndex = 0;

/**
 * Returns all configured Groq API keys for key rotation
 */
export function getGroqApiKeys(cwd) {
  ensureEnv(cwd);
  const keys = [];
  if (process.env.GROQ_API_KEYS) {
    keys.push(...process.env.GROQ_API_KEYS.split(',').map(k => k.trim()).filter(Boolean));
  }
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`GROQ_API_KEY_${i}`];
    if (k && k.trim()) keys.push(k.trim());
  }
  if (process.env.GROQ_API_KEY && !keys.includes(process.env.GROQ_API_KEY.trim())) {
    keys.push(process.env.GROQ_API_KEY.trim());
  }
  return keys;
}

/**
 * Get next available Groq key from rotation pool
 */
export function getNextGroqApiKey(cwd) {
  const keys = getGroqApiKeys(cwd);
  if (keys.length === 0) return null;
  const key = keys[currentKeyIndex % keys.length];
  currentKeyIndex = (currentKeyIndex + 1) % keys.length;
  return key;
}

/**
 * Get dynamic models for the Turf agent based on configured provider keys
 */
export async function getTurfModels(cwd) {
  ensureEnv(cwd);

  const models = [];
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  const groqKey = getNextGroqApiKey(cwd) || process.env.GROQ_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (deepseekKey) {
    const liveDeepSeek = await fetchLiveDeepSeekModels(deepseekKey);
    if (liveDeepSeek.length > 0) {
      models.push(...liveDeepSeek);
    } else {
      models.push(
        { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', desc: 'DeepSeek V4 Flash (Flagship coder - Ultra-fast - Recommended)' },
        { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro', desc: 'DeepSeek V4 Pro (Deep reasoning, math & architecture)' }
      );
    }
  }

  if (groqKey) {
    const live = await fetchLiveGroqModels(groqKey);
    if (live.length > 0) {
      if (!live.some(m => m.id === 'llama-3.1-8b-instant')) {
        live.unshift({ id: 'llama-3.1-8b-instant', label: 'llama-3.1-8b-instant', desc: 'Llama 3.1 8B (20,000 TPM Free Tier - Never exhausts)' });
      }
      models.push(...live);
    } else {
      models.push(
        { id: 'llama-3.1-8b-instant', label: 'llama-3.1-8b-instant', desc: 'Llama 3.1 8B (20,000 TPM Free Tier - Never exhausts)' },
        { id: 'openai/gpt-oss-120b', label: 'openai/gpt-oss-120b', desc: 'GPT-OSS 120B (Deep reasoning, ultra-fast)' },
        { id: 'openai/gpt-oss-20b', label: 'openai/gpt-oss-20b', desc: 'GPT-OSS 20B (High speed, low latency)' },
        { id: 'qwen/qwen3.8-27b', label: 'qwen/qwen3.8-27b', desc: 'Qwen 3.8 27B (Coding & reasoning)' },
        { id: 'groq/compound', label: 'groq/compound', desc: 'Groq Compound (Agentic router)' }
      );
    }
  }

  if (geminiKey) {
    const liveGemini = await fetchLiveGeminiModels(geminiKey);
    if (liveGemini.length > 0) {
      models.push(...liveGemini);
    } else {
      models.push(
        { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash', desc: 'Google Gemini 2.5 Flash (Latest 1M TPM Free - Recommended)' },
        { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro', desc: 'Google Gemini 2.5 Pro (Deep reasoning & coding)' },
        { id: 'gemini-2.0-flash', label: 'gemini-2.0-flash', desc: 'Google Gemini 2.0 Flash (1,000,000 TPM Free Tier)' },
        { id: 'gemini-2.0-flash-lite', label: 'gemini-2.0-flash-lite', desc: 'Google Gemini 2.0 Flash Lite (Ultra-fast)' },
        { id: 'gemini-1.5-pro', label: 'gemini-1.5-pro', desc: 'Google Gemini 1.5 Pro (Long context)' },
        { id: 'gemini-1.5-flash', label: 'gemini-1.5-flash', desc: 'Google Gemini 1.5 Flash (Ultra-fast Free Tier)' }
      );
    }
  }

  if (anthropicKey) {
    models.push(
      { id: 'claude-3-7-sonnet', label: 'claude-3-7-sonnet', desc: 'Anthropic Claude 3.7 Sonnet (Hybrid reasoning & coding)' },
      { id: 'claude-3-5-sonnet', label: 'claude-3-5-sonnet', desc: 'Anthropic Claude 3.5 Sonnet (Default coding)' },
      { id: 'claude-3-5-haiku', label: 'claude-3-5-haiku', desc: 'Anthropic Claude 3.5 Haiku (Fast & light)' }
    );
  }

  if (openaiKey) {
    const liveOpenAI = await fetchLiveOpenAIModels(openaiKey);
    if (liveOpenAI.length > 0) {
      models.push(...liveOpenAI);
    } else {
      models.push(
        { id: 'gpt-4o', label: 'gpt-4o', desc: 'OpenAI GPT-4o (Multimodal intelligence)' },
        { id: 'o3-mini', label: 'o3-mini', desc: 'OpenAI o3-mini (High reasoning speed)' }
      );
    }
  }

  if (models.length > 0) {
    const seen = new Set();
    return models.filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }

  return [
    { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash', desc: 'DeepSeek V4 Flash (Flagship coder - Ultra-fast - Recommended)' },
    { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro', desc: 'DeepSeek V4 Pro (Deep reasoning, math & architecture)' },
    { id: 'llama-3.1-8b-instant', label: 'llama-3.1-8b-instant', desc: 'Groq Llama 3.1 8B (20,000 TPM Free Tier)' },
    { id: 'openai/gpt-oss-120b', label: 'openai/gpt-oss-120b', desc: 'Groq GPT-OSS 120B (Deep reasoning, ultra-fast)' },
    { id: 'claude-3-7-sonnet', label: 'claude-3-7-sonnet', desc: 'Anthropic Claude 3.7 Sonnet' },
    { id: 'claude-3-5-sonnet', label: 'claude-3-5-sonnet', desc: 'Anthropic Claude 3.5 Sonnet' },
    { id: 'gpt-4o', label: 'gpt-4o', desc: 'OpenAI GPT-4o' },
    { id: 'o3-mini', label: 'o3-mini', desc: 'OpenAI o3-mini' }
  ];
}

/**
 * Get verified models supported by Command Code (cmdc)
 */
export function getCmdcModels() {
  return [
    { id: 'deepseek/deepseek-v4-flash', label: 'deepseek/deepseek-v4-flash', desc: 'DeepSeek V4 Flash (Default, ultra-fast & capable)' },
    { id: 'deepseek/deepseek-v4-pro', label: 'deepseek/deepseek-v4-pro', desc: 'DeepSeek V4 Pro (Deep architectural reasoning)' },
    { id: 'claude-sonnet-5', label: 'claude-sonnet-5', desc: 'Claude Sonnet 5 (Recommended speed & intelligence)' },
    { id: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6', desc: 'Claude Sonnet 4.6 (Solid multi-step agent)' },
    { id: 'claude-opus-5', label: 'claude-opus-5', desc: 'Claude Opus 5 (Maximum reasoning depth)' },
    { id: 'gpt-5.6-sol', label: 'gpt-5.6-sol', desc: 'GPT-5.6 Sol (Cutting edge reasoning)' },
    { id: 'gpt-5.5', label: 'gpt-5.5', desc: 'GPT-5.5 (High general intelligence)' },
    { id: 'moonshotai/Kimi-K3', label: 'moonshotai/Kimi-K3', desc: 'Kimi K3 (Long-context specialist)' },
    { id: 'Qwen/Qwen3.8-27B', label: 'Qwen/Qwen3.8-27B', desc: 'Qwen 3.8 27B (Open-weight coder)' },
    { id: 'google/gemini-3.7-flash', label: 'google/gemini-3.7-flash', desc: 'Gemini 3.7 Flash (High reasoning)' }
  ];
}

/**
 * Get verified models supported by OpenAI Codex
 */
export async function getCodexModels(cwd) {
  ensureEnv(cwd);
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    const live = await fetchLiveOpenAIModels(openaiKey);
    if (live.length > 0) return live;
  }
  return [
    { id: 'o3-mini', label: 'o3-mini', desc: 'OpenAI o3-mini (High reasoning, fast)' },
    { id: 'gpt-4o', label: 'gpt-4o', desc: 'OpenAI GPT-4o (Fast multimodal intelligence)' },
    { id: 'o1', label: 'o1', desc: 'OpenAI o1 (Full reasoning depth)' }
  ];
}

/**
 * Returns formatted command palette items for the currently active tab
 */
export async function getPaletteModelsForTab(tabId, cwd) {
  let models = [];
  if (tabId === 'turf') {
    models = await getTurfModels(cwd);
  } else if (tabId === 'cmdc') {
    models = getCmdcModels();
  } else if (tabId === 'codex') {
    models = await getCodexModels(cwd);
  } else {
    models = await getTurfModels(cwd);
  }

  return models.map(m => ({
    cmd: `/model ${m.id}`,
    desc: m.desc
  }));
}
