/** Provider catalog for Settings — token prefix → provider → suggested models. */
export const PROVIDERS = [
  { id: "xai", label: "xAI (Grok)", hint: /^xai-/i, models: ["grok-2-latest", "grok-2"] },
  { id: "openai", label: "OpenAI", hint: /^sk-(?!or-)/i, models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1-mini"] },
  { id: "gemini", label: "Google Gemini", hint: /^AIza/i, models: ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite"] },
  { id: "openrouter", label: "OpenRouter", hint: /^sk-or-/i, models: ["openai/gpt-4o-mini", "deepseek/deepseek-chat"] },
  { id: "mistral", label: "Mistral", hint: null, models: ["mistral-large-latest", "mistral-small-latest"] },
  { id: "deepseek", label: "DeepSeek", hint: null, models: ["deepseek-chat", "deepseek-reasoner"] },
  { id: "groq", label: "Groq", hint: /^gsk_/i, models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"] },
  { id: "ollama", label: "Ollama (local)", hint: null, models: ["llama3.1", "llama3", "qwen2.5"] },
  { id: "lmstudio", label: "LM Studio (local)", hint: null, models: ["local-model"] },
  { id: "local", label: "Local OpenAI-compatible", hint: null, models: ["local-model"] },
];

export function detectProviderFromToken(token) {
  const t = String(token || "").trim();
  if (!t) return "";
  for (const p of PROVIDERS) {
    if (p.hint && p.hint.test(t)) return p.id;
  }
  return "";
}

export function modelsFor(provider) {
  return (PROVIDERS.find((p) => p.id === provider) || {}).models || [];
}

export function catalogPublic() {
  return PROVIDERS.map(({ id, label, models }) => ({ id, label, models }));
}
