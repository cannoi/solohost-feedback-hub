// Offline tests for the AI token / model discovery fix. Run: node tests/ai-discovery.test.js
import assert from 'node:assert/strict';
import { parseModelList, discoverModelsDetailed, discoverModels } from '../ai-app-kernel/src/router.js';
import { verifyProvider } from '../ai-app-kernel/src/providers.js';

let n = 0; const ok = (m, c) => { assert.ok(c, m); n++; };
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const seen = [];
const mock = (routes) => async (url, init = {}) => { seen.push({ url, headers: init.headers || {} }); for (const [re, fn] of routes) if (re.test(url)) return fn(url, init); throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };

// 1) the original bug: OpenAI-style APIs answer { data: [...] }, not { models: [...] }
ok('openai {data:[]} parsed', parseModelList('openai', { data: [{ id: 'gpt-4o-mini' }, { id: 'text-embedding-3-small' }, { id: 'gpt-4o' }] }).join() === 'gpt-4o,gpt-4o-mini');
ok('deepseek {data:[]} parsed', parseModelList('deepseek', { data: [{ id: 'deepseek-reasoner' }, { id: 'deepseek-chat' }] }).join() === 'deepseek-chat,deepseek-reasoner');
ok('gemini strips models/ and keeps generateContent only', parseModelList('gemini', { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }] }).join() === 'gemini-2.5-flash');
ok('ollama tags parsed', parseModelList('ollama', { models: [{ name: 'llama3.1:8b' }] }).join() === 'llama3.1:8b');
ok('bare array tolerated', parseModelList('local', ['a', 'b']).length === 2);
ok('only non-chat models -> still returned (never empty by filtering)', parseModelList('openai', { data: [{ id: 'whisper-1' }] }).length === 1);

// 2) discovery: auth header per provider, key not in URL, clear error kinds
{ seen.length = 0;
  const r = await discoverModelsDetailed({ provider: 'gemini', apiKey: 'AIzaKEY', fetchImpl: mock([[/generativelanguage/, () => reply(200, { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] })]]) });
  ok('gemini ok', r.ok && r.models[0] === 'gemini-2.5-flash'); ok('gemini key sent in header, not URL', seen[0].headers['x-goog-api-key'] === 'AIzaKEY' && !seen[0].url.includes('AIzaKEY')); }
{ const r = await discoverModelsDetailed({ provider: 'deepseek', apiKey: 'sk-x', fetchImpl: mock([[/deepseek/, (u, i) => { ok('bearer header', i.headers.Authorization === 'Bearer sk-x'); return reply(200, { data: [{ id: 'deepseek-chat' }] }); }]]) }); ok('deepseek ok', r.ok && r.models[0] === 'deepseek-chat'); }
{ const r = await discoverModelsDetailed({ provider: 'openai', apiKey: 'bad', fetchImpl: mock([[/openai/, () => reply(401, { error: { message: 'Incorrect API key provided' } })]]) }); ok('401 -> auth + detail', !r.ok && r.kind === 'auth' && /Incorrect/.test(r.detail)); }
{ const r = await discoverModelsDetailed({ provider: 'groq', apiKey: 'k', fetchImpl: mock([]) }); ok('network failure -> kind network (not silent [])', !r.ok && r.kind === 'network' && /ENOTFOUND/.test(r.detail)); }
{ const r = await discoverModelsDetailed({ provider: 'mistral', apiKey: 'k', fetchImpl: mock([[/mistral/, () => reply(200, 'not json')]]) }); ok('non-JSON -> parse', r.kind === 'parse'); }
{ const r = await discoverModelsDetailed({ provider: 'xai', apiKey: 'k', fetchImpl: mock([[/x\.ai/, () => reply(200, { data: [] })]]) }); ok('empty list -> empty', r.kind === 'empty'); }
{ const r = await discoverModelsDetailed({ provider: 'custom' }); ok('custom -> no endpoint, no throw', !r.ok); }
ok('legacy discoverModels still returns an array', Array.isArray(await discoverModels({ provider: 'openai', apiKey: 'k', fetchImpl: mock([]) })));

// 3) verifyProvider: list -> chat ping fallback -> exact reason
{ const v = await verifyProvider({ provider: 'deepseek', apiKey: 'sk-ok', fetchImpl: mock([[/deepseek/, () => reply(200, { data: [{ id: 'deepseek-chat' }] })]]) }); ok('listed -> verified', v.ok && v.verified && v.kind === 'ok' && v.models[0] === 'deepseek-chat'); }
{ const v = await verifyProvider({ provider: 'openai', apiKey: 'sk-bad', fetchImpl: mock([[/openai/, () => reply(401, { error: { message: 'bad key' } })]]) }); ok('bad key -> ok:false + reason + DeepSeek hint', !v.ok && v.kind === 'auth' && /401/.test(v.warning) && /DeepSeek/.test(v.warning)); }
{ let pinged = 0; const v = await verifyProvider({ provider: 'mistral', apiKey: 'k', fetchImpl: mock([[/mistral/, () => reply(404, {})]]), chat: async () => { pinged++; return { text: 'OK' }; } }); ok('no /models endpoint but chat works -> ok', v.ok && v.verified && v.kind === 'chat_ok' && pinged === 1 && v.models.length > 0); }
{ const v = await verifyProvider({ provider: 'groq', apiKey: 'k', fetchImpl: mock([]), chat: async () => { throw new Error('fetch failed'); } }); ok('unreachable -> ok:false network', !v.ok && v.kind === 'network' && /mạng|network/i.test(v.warning)); }
{ const v = await verifyProvider({ provider: 'groq', apiKey: 'k', fetchImpl: mock([[/groq/, () => reply(500, {})]]), chat: async () => { throw new Error('groq HTTP 401: nope'); } }); ok('chat 401 after list failure -> auth', !v.ok && v.kind === 'auth'); }
{ const v = await verifyProvider({ provider: 'xai', apiKey: 'k', fetchImpl: mock([[/x\.ai/, () => reply(429, {})]]), chat: async () => { throw new Error('xai HTTP 404: model'); } }); ok('suggested model unknown but key accepted -> ok, not verified', v.ok && !v.verified && v.kind === 'model_unknown'); }
{ const v = await verifyProvider({ provider: 'ollama', fetchImpl: mock([[/api\/tags/, () => reply(200, { models: [{ name: 'llama3.1' }] })]]) }); ok('local provider needs no key', v.ok && v.models[0] === 'llama3.1'); }
console.log('ai-discovery: ' + n + ' checks passed');
