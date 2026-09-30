import {
  collectAvailableKeys,
  defaultBaseUrl,
  detectProviderFromToken,
  isLocalProvider,
  normalizeModel,
} from './router.js';

const CATALOG = {
  openai: { name: 'OpenAI', url: 'https://api.openai.com/v1/chat/completions', kind: 'openai' },
  deepseek: { name: 'DeepSeek', url: 'https://api.deepseek.com/chat/completions', kind: 'openai' },
  groq: { name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', kind: 'openai' },
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', kind: 'openai' },
  mistral: { name: 'Mistral', url: 'https://api.mistral.ai/v1/chat/completions', kind: 'openai' },
  xai: { name: 'xAI', url: 'https://api.x.ai/v1/chat/completions', kind: 'openai' },
  gemini: { name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta', kind: 'gemini' },
  ollama: { name: 'Ollama (local)', url: 'http://127.0.0.1:11434/v1/chat/completions', kind: 'openai', local: true },
  lmstudio: { name: 'LM Studio (local)', url: 'http://127.0.0.1:1234/v1/chat/completions', kind: 'openai', local: true },
  local: { name: 'Local OpenAI-compatible', url: '', kind: 'openai', local: true },
  custom: { name: 'Custom', url: '', kind: 'openai' },
};

function envKey(id) {
  const specific = process.env[`${String(id).toUpperCase()}_API_KEY`] || '';
  if (specific) return specific;
  const generic = process.env.AI_API_KEY || '';
  if (generic && detectProviderFromToken(generic) === id) return generic;
  if (id === 'openai' && process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  return '';
}

export function listProviders() {
  return Object.entries(CATALOG).map(([id, p]) => ({
    id,
    name: p.name,
    kind: p.kind,
    local: Boolean(p.local),
  }));
}

export { detectProviderFromToken, collectAvailableKeys, isLocalProvider };

export async function completeChat({
  provider = process.env.AI_PROVIDER || 'openai',
  model = process.env.AI_MODEL || '',
  apiKey = '',
  baseUrl = '',
  system = '',
  messages = [],
  tools = [],
  json = false,
  temperature = 0.2,
}) {
  const meta = CATALOG[provider] || CATALOG.custom;
  const local = Boolean(meta.local) || isLocalProvider(provider);
  const key = apiKey || envKey(provider) || (local ? 'local' : '');
  if (!key && !local) {
    throw new Error(`AI key missing for provider "${provider}". Set ${String(provider).toUpperCase()}_API_KEY or AI_API_KEY.`);
  }
  if (meta.kind === 'gemini' || provider === 'gemini') {
    return geminiChat({ key, model: normalizeModel('gemini', model || 'gemini-2.5-flash'), system, messages, tools, json });
  }
  const url = baseUrl || defaultBaseUrl(provider) || meta.url;
  if (!url) throw new Error('Custom/local provider needs baseUrl (LOCAL_AI_BASE_URL or AI_BASE_URL).');
  const body = {
    model: model || defaultModel(provider),
    temperature,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages,
    ],
  };
  if (tools.length) body.tools = tools.map(openaiTool);
  if (json) body.response_format = { type: 'json_object' };
  const headers = { 'Content-Type': 'application/json' };
  if (key && key !== 'local') headers.Authorization = `Bearer ${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${provider} HTTP ${res.status}: ${text.slice(0, 500)}`);
  const data = JSON.parse(text);
  const msg = data.choices?.[0]?.message || {};
  return {
    provider,
    model: data.model || body.model,
    text: msg.content || '',
    toolCalls: (msg.tool_calls || []).map((c) => ({
      id: c.id,
      name: c.function?.name,
      arguments: safeJson(c.function?.arguments),
    })),
    raw: data,
  };
}

function defaultModel(provider) {
  return ({
    openai: 'gpt-4o-mini',
    deepseek: 'deepseek-chat',
    groq: 'llama-3.1-8b-instant',
    openrouter: 'openai/gpt-4o-mini',
    mistral: 'mistral-small-latest',
    xai: 'grok-2-latest',
    ollama: 'llama3.1',
    lmstudio: 'local-model',
    local: 'local-model',
  })[provider] || 'gpt-4o-mini';
}

function openaiTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || { type: 'object', properties: {} },
    },
  };
}

async function geminiChat({ key, model, system, messages, tools, json }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const contents = [];
  for (const m of messages) {
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }],
    });
  }
  const body = {
    contents,
    generationConfig: json ? { responseMimeType: 'application/json' } : {},
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools.length) {
    body.tools = [{
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} },
      })),
    }];
  }
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`gemini HTTP ${res.status}: ${text.slice(0, 500)}`);
  const data = JSON.parse(text);
  const parts = data.candidates?.[0]?.content?.parts || [];
  const fn = parts.find((p) => p.functionCall);
  return {
    provider: 'gemini',
    model,
    text: parts.map((p) => p.text || '').join('\n').trim(),
    toolCalls: fn ? [{ id: 'gemini-1', name: fn.functionCall.name, arguments: fn.functionCall.args || {} }] : [],
    raw: data,
  };
}

function safeJson(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { return { _raw: String(value || '') }; }
}
