// LLM providers Booky can use. Two wire formats: Anthropic's Messages API and the
// OpenAI-compatible chat/completions API (which OpenAI, Gemini, OpenRouter, Groq,
// Ollama, LM Studio, vLLM, etc. all speak). Pick a preset or point "custom" at any
// OpenAI-compatible server.
//
// `models` are suggestions only — the model field is free text, so a model that
// shipped after this list was written still works.

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    api: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    needsKey: true,
    keyPlaceholder: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    defaultModel: 'claude-opus-5',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  },
  openai: {
    label: 'OpenAI',
    api: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    keyPlaceholder: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    defaultModel: 'gpt-5-mini',
    models: ['gpt-5-mini', 'gpt-5-nano', 'gpt-5', 'gpt-4.1-mini'],
    extra: { reasoning_effort: 'low' },
  },
  gemini: {
    label: 'Google Gemini',
    api: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsKey: true,
    keyPlaceholder: 'AIza…',
    keyUrl: 'https://aistudio.google.com/apikey',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
  },
  openrouter: {
    label: 'OpenRouter',
    api: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    keyPlaceholder: 'sk-or-…',
    keyUrl: 'https://openrouter.ai/keys',
    defaultModel: 'anthropic/claude-haiku-4.5',
    models: ['anthropic/claude-haiku-4.5', 'openai/gpt-5-mini', 'google/gemini-2.5-flash', 'meta-llama/llama-3.3-70b-instruct'],
  },
  groq: {
    label: 'Groq',
    api: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    keyPlaceholder: 'gsk_…',
    keyUrl: 'https://console.groq.com/keys',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'],
  },
  ollama: {
    label: 'Ollama (local, free)',
    api: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    keyPlaceholder: '(not needed)',
    keyUrl: 'https://ollama.com/download',
    defaultModel: 'llama3.2',
    models: ['llama3.2', 'qwen2.5', 'gemma3', 'mistral'],
  },
  custom: {
    label: 'Custom (OpenAI-compatible)',
    api: 'openai',
    baseUrl: '',
    needsKey: false,
    keyPlaceholder: '(if your server needs one)',
    keyUrl: '',
    defaultModel: '',
    models: [],
  },
};

export const DEFAULT_PROVIDER = 'anthropic';

/** Preset for a provider id, falling back to the default when the id is unknown. */
export function providerInfo(id) {
  return PROVIDERS[id] || PROVIDERS[DEFAULT_PROVIDER];
}

/** Effective base URL: the user's override if set, else the preset's. No trailing slash. */
export function resolveBaseUrl(settings) {
  const url = (settings.baseUrl || providerInfo(settings.provider).baseUrl || '').trim();
  return url.replace(/\/+$/, '');
}

/** Chrome match pattern covering the base URL's origin, for chrome.permissions. */
export function originPattern(baseUrl) {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return null;
  }
}
