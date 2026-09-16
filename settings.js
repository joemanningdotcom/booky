// Settings live in chrome.storage.sync (small, roams with the profile) — except
// folder ids: bookmark ids differ per device even with sync on, so those stay local.
// API keys and the activity log also live in chrome.storage.local (never synced).

import { DEFAULT_PROVIDER, providerInfo } from './providers.js';

export const DEFAULTS = {
  enabled: true,
  inboxFolderId: null,       // resolved lazily; falls back to a folder named `inboxName`
  inboxName: 'Inbox',
  rootFolderId: null,        // where categories live; null = same parent as the Inbox folder
  allowNewFolders: true,
  provider: DEFAULT_PROVIDER, // key of PROVIDERS in providers.js
  model: providerInfo(DEFAULT_PROVIDER).defaultModel,
  baseUrl: '',               // override the provider's endpoint; '' = the preset's default
  debounceMs: 4000,          // wait after a bookmark lands in Inbox before filing it
  examplesPerFolder: 8,      // how many existing bookmarks per folder to show the classifier
  localMinScore: 4,          // heuristic fallback: minimum score to file into an existing folder
};

const LOCAL_KEYS = new Set(['inboxFolderId', 'rootFolderId']);

export async function getSettings() {
  const [synced, local] = await Promise.all([
    chrome.storage.sync.get(DEFAULTS),
    chrome.storage.local.get([...LOCAL_KEYS]),
  ]);
  return { ...DEFAULTS, ...synced, ...local };
}

export async function saveSettings(patch) {
  const toSync = {};
  const toLocal = {};
  for (const [k, v] of Object.entries(patch)) (LOCAL_KEYS.has(k) ? toLocal : toSync)[k] = v;
  await Promise.all([
    Object.keys(toSync).length ? chrome.storage.sync.set(toSync) : null,
    Object.keys(toLocal).length ? chrome.storage.local.set(toLocal) : null,
  ]);
}

// ---- API keys: one per provider, so switching providers doesn't lose a key. ----
// Older versions stored a single Anthropic key under `apiKey`; that's read as a
// fallback and migrated on the next save.

export async function getApiKeys() {
  const { apiKeys, apiKey } = await chrome.storage.local.get(['apiKeys', 'apiKey']);
  const keys = { ...(apiKeys || {}) };
  if (apiKey && !keys.anthropic) keys.anthropic = apiKey;
  return keys;
}

export async function getApiKey(provider = DEFAULT_PROVIDER) {
  return (await getApiKeys())[provider] || '';
}

export async function setApiKey(provider, apiKey) {
  const keys = await getApiKeys();
  keys[provider] = (apiKey || '').trim();
  await chrome.storage.local.set({ apiKeys: keys });
  await chrome.storage.local.remove('apiKey');
}

/** True when the configured provider is usable: has a key, or doesn't need one. */
export async function llmConfigured(settings) {
  const info = providerInfo(settings.provider);
  if (!info.needsKey) return Boolean(settings.model);
  return Boolean(settings.model && (await getApiKey(settings.provider)));
}

// ---- Activity log (last 200 moves) ----

const LOG_MAX = 200;

export async function getLog() {
  const { log } = await chrome.storage.local.get('log');
  return log || [];
}

export async function appendLog(entry) {
  const log = await getLog();
  log.unshift({ ts: Date.now(), ...entry });
  await chrome.storage.local.set({ log: log.slice(0, LOG_MAX) });
}

export async function clearLog() {
  await chrome.storage.local.set({ log: [] });
}

// ---- Corrections: the user moved something we filed. Used as few-shot hints. ----

const CORRECTIONS_MAX = 60;

export async function getCorrections() {
  const { corrections } = await chrome.storage.local.get('corrections');
  return corrections || [];
}

export async function addCorrection(c) {
  const list = await getCorrections();
  list.unshift({ ts: Date.now(), ...c });
  await chrome.storage.local.set({ corrections: list.slice(0, CORRECTIONS_MAX) });
}

/** Folders the person has rejected for a given bookmark (via Undo or dragging it out). */
export async function getRejected() {
  const map = new Map();
  for (const c of await getCorrections()) {
    if (!c.bookmarkId || !c.fromId) continue;
    if (!map.has(c.bookmarkId)) map.set(c.bookmarkId, new Set());
    map.get(c.bookmarkId).add(c.fromId);
  }
  return map;
}
