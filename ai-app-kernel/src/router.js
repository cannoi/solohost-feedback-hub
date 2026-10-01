import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Provider priority: higher first when multiple tokens exist.
 * Local is last among cloud, but can be preferred via AI_PROVIDER=local.
 */
export const PROVIDER_PRIORITY = [
  'xai',
  'openai',
  'gemini',
  'openrouter',
  'mistral',
  'deepseek',
  'groq',
  'ollama',
  'lmstudio',
  'local',
  'custom',
];

const TOKEN_HINTS = [
  { re: /^gsk_/i, provider: 'groq' },
  { re: /^sk-or-/i, provider: 'openrouter' },
  { re: /^xai-/i, provider: 'xai' },
  { re: /^AIza/i, provider: 'gemini' },
  { re: /^sk-/i, provider: 'openai' },
];

const DEFAULT_MODELS = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1-mini'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  openrouter: ['openai/gpt-4o-mini', 'deepseek/deepseek-chat'],
  mistral: ['mistral-large-latest', 'mistral-small-latest'],
  xai: ['grok-2-latest', 'grok-2'],
  gemini: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-2.0-flash-001'],
  ollama: ['llama3.1', 'llama3', 'qwen2.5'],
  lmstudio: ['local-model'],
  local: ['local-model'],
  custom: ['gpt-4o-mini'],
};

function env(name) {
  return String(process.env[name] || '').trim();
}

export function detectProviderFromToken(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  for (const hint of TOKEN_HINTS) {
    if (hint.re.test(t)) return hint.provider;
  }
  return null;
}

/** A secret may only be sent to the provider it belongs to. */
export function keyBelongsToProvider(token, provider) {
  const id = String(provider || '').toLowerCase();
  if (!token || !id) return false;
  if (isLocalProvider(id) || id === 'custom') return false;
  const hinted = detectProviderFromToken(token);
  if (!hinted) return false;
  return hinted === id;
}

export function collectAvailableKeys() {
  const keys = {};
  const generic = env('AI_API_KEY') || env('OPENAI_API_KEY');
  const hinted = detectProviderFromToken(generic);
  if (hinted && generic) keys[hinted] = generic;
  for (const id of PROVIDER_PRIORITY) {
    const specific = env(`${id.toUpperCase()}_API_KEY`);
    if (specific) keys[id] = specific;
  }
  const selected = env('AI_PROVIDER').toLowerCase();
  if (selected && generic && !isLocalProvider(selected)) keys[selected] = keys[selected] || generic;
  if (generic && !Object.keys(keys).length) keys.openai = generic;
  return keys;
}

export function isLocalProvider(id) {
  return id === 'local' || id === 'ollama' || id === 'lmstudio';
}

export function defaultBaseUrl(id) {
  if (id === 'ollama') return env('OLLAMA_BASE_URL') || 'http://127.0.0.1:11434/v1/chat/completions';
  if (id === 'lmstudio') return env('LMSTUDIO_BASE_URL') || 'http://127.0.0.1:1234/v1/chat/completions';
  if (id === 'local') return env('LOCAL_AI_BASE_URL') || env('AI_BASE_URL') || 'http://127.0.0.1:11434/v1/chat/completions';
  return '';
}

export function modelsFor(provider) {
  const override = env('AI_MODEL');
  const list = DEFAULT_MODELS[provider] || ['gpt-4o-mini'];
  if (override) return [override, ...list.filter((m) => m !== override)];
  return list;
}

/**
 * Choose provider: explicit option/env first, else highest-priority token,
 * else local if configured, else first catalog default.
 */
export function pickProvider({ requested, keys, localAvailable = false } = {}) {
  const req = String(requested || env('AI_PROVIDER') || '').trim();
  if (req) return req;
  for (const id of PROVIDER_PRIORITY) {
    if (keys?.[id]) return id;
  }
  if (localAvailable || env('LOCAL_AI_BASE_URL') || env('OLLAMA_BASE_URL') || env('LMSTUDIO_BASE_URL')) {
    if (env('LMSTUDIO_BASE_URL')) return 'lmstudio';
    if (env('LOCAL_AI_BASE_URL')) return 'local';
    return 'ollama';
  }
  return 'openai';
}


export async function discoverModels({ provider, apiKey = '', baseUrl = '' } = {}) {
  const id = String(provider || '').toLowerCase();
  if (!id || id === 'custom') return [];
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey && !isLocalProvider(id)) headers.Authorization = `Bearer ${apiKey}`;
  let url = '';
  if (id === 'gemini') url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(apiKey);
  else if (id === 'ollama') url = (env('OLLAMA_BASE_URL') || 'http://127.0.0.1:11434/v1/chat/completions').replace(/\/v1\/chat\/completions\/?$/, '') + '/api/tags';
  else if (id === 'lmstudio') url = (baseUrl || env('LMSTUDIO_BASE_URL') || 'http://127.0.0.1:1234/v1/chat/completions').replace(/\/chat\/completions\/?$/, '/models');
  else if (id === 'local') url = (baseUrl || env('LOCAL_AI_BASE_URL') || env('AI_BASE_URL') || 'http://127.0.0.1:11434/v1/chat/completions').replace(/\/chat\/completions\/?$/, '/models');
  else {
    const chat = {
      openai: 'https://api.openai.com/v1/chat/completions',
      deepseek: 'https://api.deepseek.com/chat/completions',
      groq: 'https://api.groq.com/openai/v1/chat/completions',
      openrouter: 'https://openrouter.ai/api/v1/chat/completions',
      mistral: 'https://api.mistral.ai/v1/chat/completions',
      xai: 'https://api.x.ai/v1/chat/completions',
    }[id];
    if (!chat) return [];
    url = chat.replace(/\/chat\/completions\/?$/, '/models');
  }
  try {
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) return [];
    const data = await res.json();
    const raw = id === 'ollama' ? (data.models || []).map(x => x.name) : (data.models || []).map(x => x.id || x.name);
    return raw.filter(Boolean).filter((m, i, a) => a.indexOf(m) === i).slice(0, 40);
  } catch {
    return [];
  }
}

export function createStickyRouter(options = {}) {
  const filePath = options.stickyFile || env('AI_STICKY_FILE') || path.join(process.cwd(), '.ai-kernel-sticky.json');
  let mem = { provider: '', model: '', okAt: 0, failCount: 0 };

  async function load() {
    try {
      mem = { ...mem, ...JSON.parse(await fs.readFile(filePath, 'utf8')) };
    } catch {
      /* first run */
    }
    return mem;
  }

  async function save() {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(mem, null, 2));
    } catch {
      /* non-fatal */
    }
  }

  return {
    async snapshot() {
      await load();
      return { ...mem };
    },
    async rememberSuccess(provider, model) {
      mem = { provider, model, okAt: Date.now(), failCount: 0 };
      await save();
    },
    async rememberFailure(provider, model) {
      await load();
      if (mem.provider === provider && mem.model === model) mem.failCount = (mem.failCount || 0) + 1;
      await save();
    },
    async resolve({ requestedProvider, requestedModel, keys, localAvailable }) {
      await load();
      const providerLocked = Boolean(requestedProvider || env('AI_PROVIDER'));
      const modelLocked = Boolean(requestedModel || env('AI_MODEL'));
      const provider = pickProvider({ requested: requestedProvider, keys, localAvailable });

      if (!providerLocked && mem.provider && mem.failCount < 2) {
        const stillHasKey = isLocalProvider(mem.provider) || Boolean(keys?.[mem.provider]);
        if (stillHasKey) {
          return {
            provider: mem.provider,
            model: modelLocked ? (requestedModel || env('AI_MODEL')) : (mem.model || modelsFor(mem.provider)[0]),
            sticky: true,
            candidates: modelsFor(mem.provider),
          };
        }
      }

      const candidates = modelsFor(provider);
      return {
        provider,
        model: modelLocked ? (requestedModel || env('AI_MODEL')) : candidates[0],
        sticky: false,
        candidates,
      };
    },
  };
}

export function classifyProviderError(err) {
  const m = String((err && err.message) || err || '');
  const status = Number((m.match(/HTTP\s+(\d+)/i) || [])[1] || 0);
  if (status === 402 || /insufficient.?balance|billing|quota exceeded|precondition.*balance/i.test(m))
    return { kind: 'billing', retryModel: false, retryProvider: true };
  if (status === 401 || status === 403 || /invalid.?api.?key|incorrect api key|token.*reject|permission.?denied/i.test(m))
    return { kind: 'auth', retryModel: false, retryProvider: true };
  if (status === 404 || /is not found for api version|model.*not found|not_found/i.test(m))
    return { kind: 'model', retryModel: true, retryProvider: false };
  if (status === 429)
    return { kind: 'rate', retryModel: false, retryProvider: true };
  return { kind: 'other', retryModel: true, retryProvider: true };
}

export function normalizeModel(provider, model) {
  const m = String(model || '').trim();
  if (provider === 'gemini') {
    if (!m || /gemini-1\.5/i.test(m) || /gemini-pro/i.test(m)) return 'gemini-2.5-flash';
    if (m === 'gemini-flash' || m === 'flash') return 'gemini-2.0-flash';
  }
  return m;
}

export function friendlyAiError(err) {
  const { kind } = classifyProviderError(err);
  const raw = String((err && err.message) || err || '').slice(0, 180);
  if (kind === 'billing') return { kind, text: 'Nhà cung cấp hết credit / chưa thanh toán (HTTP 402). Chọn nhà khác hoặc nạp số dư. / Provider out of credit — pick another or top up.' };
  if (kind === 'auth') return { kind, text: 'Token bị từ chối (sai key hoặc không đủ quyền). Kiểm tra key và nhà cung cấp. / Token rejected — check key and provider.' };
  if (kind === 'model') return { kind, text: 'Model không tồn tại trên API này. Để trống ô Model để tự chọn. / Model not found — leave Model empty.' };
  if (kind === 'rate') return { kind, text: 'Quá nhiều request. Đợi rồi thử lại. / Rate limited.' };
  return { kind, text: raw || 'AI provider error' };
}
