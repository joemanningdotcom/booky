import { getSettings, saveSettings, getApiKeys, setApiKey, clearLog, getCorrections } from './settings.js';
import { allFolders } from './bookmarks.js';
import { PROVIDERS, providerInfo, resolveBaseUrl, originPattern } from './providers.js';

const $ = (id) => document.getElementById(id);

// Keys typed for each provider this session, so switching back and forth doesn't lose them.
let apiKeys = {};

function fillFolderSelect(select, folders, selectedId, extraFirst) {
  select.innerHTML = '';
  if (extraFirst) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = extraFirst;
    select.appendChild(o);
  }
  for (const f of folders) {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = f.path;
    select.appendChild(o);
  }
  select.value = selectedId || '';
}

function fillProviderSelect(select, selected) {
  select.innerHTML = '';
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = p.label;
    select.appendChild(o);
  }
  select.value = PROVIDERS[selected] ? selected : 'anthropic';
}

/** Re-render the provider-dependent fields. `reset` = user just switched provider. */
function applyProvider(reset) {
  const id = $('provider').value;
  const info = providerInfo(id);

  $('modelSuggestions').innerHTML = info.models.map((m) => `<option value="${m}">`).join('');
  if (reset) $('model').value = info.defaultModel;

  $('apiKey').placeholder = info.keyPlaceholder;
  $('apiKey').value = apiKeys[id] || '';
  $('apiKey').disabled = !info.needsKey && id !== 'custom';
  $('keyUrl').hidden = !info.keyUrl;
  $('keyUrl').href = info.keyUrl || '#';
  $('keyUrl').textContent = info.needsKey ? 'get one ↗' : 'download ↗';

  $('baseUrl').placeholder = info.baseUrl || 'https://your-server.example/v1';
  if (reset) $('baseUrl').value = id === 'custom' || id === 'ollama' ? info.baseUrl : '';
  $('keyStatus').textContent = '';
}

function readClassifierFields() {
  return {
    provider: $('provider').value,
    model: $('model').value.trim(),
    baseUrl: $('baseUrl').value.trim(),
  };
}

/**
 * The service worker can only fetch hosts the extension holds permission for.
 * Ask for the chosen endpoint's origin (must happen from a user gesture, hence here
 * rather than in the background). Returns an error string, or null when granted.
 */
async function ensureHostPermission(settingsPatch) {
  const baseUrl = resolveBaseUrl(settingsPatch);
  const pattern = originPattern(baseUrl);
  if (!pattern) return `Endpoint "${baseUrl || '(empty)'}" is not a valid http(s) URL.`;
  if (await chrome.permissions.contains({ origins: [pattern] })) return null;
  const granted = await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
  return granted ? null : `Permission to reach ${pattern.slice(0, -2)} was declined; Booky will use local matching until it's granted.`;
}

async function load() {
  const settings = await getSettings();
  const folders = await allFolders();
  apiKeys = await getApiKeys();

  fillFolderSelect($('inboxFolder'), folders, settings.inboxFolderId);
  fillFolderSelect($('rootFolder'), folders, settings.rootFolderId, 'Same folder as the inbox (default)');

  $('allowNewFolders').checked = settings.allowNewFolders;
  fillProviderSelect($('provider'), settings.provider);
  $('model').value = settings.model;
  $('baseUrl').value = settings.baseUrl || '';
  applyProvider(false);
  $('examplesPerFolder').value = settings.examplesPerFolder;
  $('debounceMs').value = Math.round(settings.debounceMs / 1000);
  $('localMinScore').value = settings.localMinScore;

  const corrections = await getCorrections();
  $('correctionsCount').textContent = corrections.length ? `(${corrections.length} remembered)` : '';
}

$('provider').addEventListener('change', () => applyProvider(true));
$('apiKey').addEventListener('input', () => { apiKeys[$('provider').value] = $('apiKey').value; });

$('save').addEventListener('click', async () => {
  const classifier = readClassifierFields();
  await saveSettings({
    inboxFolderId: $('inboxFolder').value || null,
    rootFolderId: $('rootFolder').value || null,
    allowNewFolders: $('allowNewFolders').checked,
    ...classifier,
    examplesPerFolder: clamp(parseInt($('examplesPerFolder').value, 10), 0, 30, 8),
    debounceMs: clamp(parseInt($('debounceMs').value, 10), 1, 120, 4) * 1000,
    localMinScore: clamp(parseFloat($('localMinScore').value), 1, 20, 4),
  });
  await setApiKey(classifier.provider, $('apiKey').value);
  const problem = await ensureHostPermission(classifier);
  $('saved').textContent = problem || 'Saved';
  $('saved').className = problem ? 'err' : 'muted';
  setTimeout(() => ($('saved').textContent = ''), problem ? 8000 : 2000);
});

$('testKey').addEventListener('click', async () => {
  const classifier = readClassifierFields();
  await setApiKey(classifier.provider, $('apiKey').value);
  await saveSettings(classifier);
  $('keyStatus').textContent = 'Testing…';
  $('keyStatus').className = 'muted';
  const problem = await ensureHostPermission(classifier);
  const res = problem ? { ok: false, error: problem } : await chrome.runtime.sendMessage({ type: 'testProvider' });
  $('keyStatus').textContent = res.ok ? '✓ Works.' : `✗ ${res.error}`;
  $('keyStatus').className = res.ok ? 'ok' : 'err';
});

$('clearCorrections').addEventListener('click', async () => {
  await chrome.storage.local.set({ corrections: [] });
  $('correctionsCount').textContent = '';
});

$('clearLog').addEventListener('click', async () => {
  await clearLog();
});

function clamp(n, min, max, fallback) {
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

load();
