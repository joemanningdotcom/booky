// Booky service worker: watches the Inbox folder and files whatever lands there.

import { getSettings, saveSettings, getApiKey, llmConfigured, appendLog, getLog, addCorrection, getCorrections, getRejected } from './settings.js';
import { resolveInbox, resolveRoot, collectFolders, ensureFolder, getChildren, getNode } from './bookmarks.js';
import { classifyWithLLM, classifyLocally, rankLocally, testProvider } from './classifier.js';
import { providerInfo, resolveBaseUrl, originPattern } from './providers.js';

const SWEEP_ALARM = 'booky-sweep';
const SWEEP_PERIOD_MIN = 15;
const MAX_BATCH = 40;

// Bookmark ids we are moving ourselves, so onMoved can tell our moves from the user's.
const selfMoves = new Set();

let debounceTimer = null;
let running = false;
let rerunRequested = false;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: SWEEP_PERIOD_MIN });
  const settings = await getSettings();
  const inbox = await resolveInbox(settings);
  if (inbox.id !== settings.inboxFolderId) await saveSettings({ inboxFolderId: inbox.id });
  await refreshBadge();
  scheduleSort(settings.debounceMs);
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: SWEEP_PERIOD_MIN });
  await refreshBadge();
  scheduleSort(2000);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.enabled) refreshBadge().catch(() => {});
  // A new key, provider, or model means the classifier just changed: re-sort what's waiting.
  if ((area === 'local' && changes.apiKeys) || (area === 'sync' && (changes.provider || changes.model || changes.baseUrl))) {
    setSeen({}).then(() => scheduleSort(500)).catch(() => {});
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM) sortInbox().catch(reportError);
});

// ---------------------------------------------------------------------------
// Bookmark events
// ---------------------------------------------------------------------------

chrome.bookmarks.onCreated.addListener(async (id, node) => {
  if (!node.url) return;
  refreshBadge().catch(() => {});
  const settings = await getSettings();
  if (!settings.enabled) return;
  const inbox = await resolveInbox(settings);
  if (node.parentId === inbox.id) scheduleSort(settings.debounceMs);
});

chrome.bookmarks.onChanged.addListener(async (id) => {
  // Title edits in Chrome's bookmark bubble arrive as onChanged; re-arm the debounce
  // so we classify the final title rather than the page's default one.
  const settings = await getSettings();
  if (!settings.enabled) return;
  const inbox = await resolveInbox(settings);
  const node = await getNode(id).catch(() => null);
  if (node?.url && node.parentId === inbox.id) scheduleSort(settings.debounceMs);
});

chrome.bookmarks.onMoved.addListener(async (id, info) => {
  refreshBadge().catch(() => {});
  if (selfMoves.has(id)) {
    selfMoves.delete(id);
    return;
  }
  const settings = await getSettings();
  const inbox = await resolveInbox(settings);

  if (info.parentId === inbox.id) {
    // User dragged something (back) into the Inbox: sort it. If it came out of a
    // folder we filed it into, that folder is now off the table for this bookmark.
    const log = await getLog();
    const entry = log.find((e) => e.bookmarkId === id && e.to === info.oldParentId && !e.undone);
    if (entry) await rejectFolder(id, entry, 'moved back to Inbox by the person');
    await forgetSeen(id);
    if (settings.enabled) scheduleSort(settings.debounceMs);
    return;
  }

  if (info.oldParentId === inbox.id) return; // user filed it by hand; nothing to learn from that

  // Did the user move something *we* filed? If so, remember it as a correction.
  const log = await getLog();
  const entry = log.find((e) => e.bookmarkId === id && e.to === info.oldParentId && !e.undone);
  if (!entry) return;
  const node = await getNode(id).catch(() => null);
  if (!node?.url) return;
  await addCorrection({
    bookmarkId: id,
    title: node.title,
    url: node.url,
    fromId: info.oldParentId,
    fromPath: await folderPath(info.oldParentId),
    toId: info.parentId,
    toPath: await folderPath(info.parentId),
  });
});

chrome.bookmarks.onRemoved.addListener(() => {
  refreshBadge().catch(() => {});
});

// ---------------------------------------------------------------------------
// Messages from popup / options
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'status':
        return sendResponse(await getStatus());
      case 'sortNow':
        await sortInbox({ force: true });
        return sendResponse(await getStatus());
      case 'undo':
        await undo(msg.ts, msg.bookmarkId);
        return sendResponse(await getStatus());
      case 'fileTo':
        await fileTo(msg.bookmarkId, msg.folderId, msg.newFolderName);
        return sendResponse(await getStatus());
      case 'testProvider': {
        const settings = await getSettings();
        const info = providerInfo(settings.provider);
        const apiKey = await getApiKey(settings.provider);
        if (info.needsKey && !apiKey) return sendResponse({ ok: false, error: 'No API key saved' });
        if (!settings.model) return sendResponse({ ok: false, error: 'No model set' });
        const baseUrl = resolveBaseUrl(settings);
        const denied = await missingHostPermission(baseUrl);
        if (denied) return sendResponse({ ok: false, error: denied });
        return sendResponse(await testProvider({ provider: settings.provider, baseUrl, apiKey, model: settings.model }));
      }
      default:
        return sendResponse({ error: 'unknown message' });
    }
  })().catch((err) => sendResponse({ error: String(err?.message || err) }));
  return true; // keep the channel open for the async response
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function scheduleSort(delayMs) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => sortInbox().catch(reportError), delayMs);
}

async function sortInbox({ force = false } = {}) {
  if (running) {
    rerunRequested = true;
    return;
  }
  running = true;
  try {
    do {
      rerunRequested = false;
      await sortInboxOnce({ force });
    } while (rerunRequested);
  } finally {
    running = false;
  }
}

async function sortInboxOnce({ force }) {
  const settings = await getSettings();
  if (!settings.enabled && !force) return;

  const inbox = await resolveInbox(settings);
  if (inbox.id !== settings.inboxFolderId) await saveSettings({ inboxFolderId: inbox.id });
  const root = await resolveRoot(settings, inbox);

  const rejected = await getRejected();
  const inInbox = (await getChildren(inbox.id))
    .filter((n) => n.url)
    .map((n) => ({ id: n.id, title: n.title, url: n.url }));

  // Only spend a request on bookmarks the classifier hasn't already looked at in
  // their current form. "Sort now" (force) asks about everything again.
  const seen = await getSeen();
  for (const id of Object.keys(seen)) if (!inInbox.some((n) => n.id === id)) delete seen[id]; // prune
  const items = inInbox
    .filter((n) => force || seen[n.id] !== fingerprint(n))
    .slice(0, MAX_BATCH);
  if (!items.length) {
    await setSeen(seen);
    await setState({ lastRun: Date.now(), lastSkipped: inInbox.length });
    return;
  }

  const folders = await collectFolders(root.id, inbox.id);

  let decisions;
  let mode = 'local';
  let lastError = null;

  if (await llmConfigured(settings)) {
    const label = providerInfo(settings.provider).label;
    try {
      const baseUrl = resolveBaseUrl(settings);
      const denied = await missingHostPermission(baseUrl);
      if (denied) throw new Error(denied);
      decisions = await classifyWithLLM({
        items,
        folders,
        corrections: await getCorrections(),
        rejected,
        provider: settings.provider,
        baseUrl,
        apiKey: await getApiKey(settings.provider),
        model: settings.model,
        allowNewFolders: settings.allowNewFolders,
        examplesPerFolder: settings.examplesPerFolder,
      });
      mode = 'llm';
    } catch (err) {
      lastError = `${label} failed (${err.message}); used local matching instead`;
      console.warn('[booky]', lastError);
    }
  }
  if (!decisions) {
    decisions = classifyLocally({
      items,
      folders,
      rejected,
      allowNewFolders: settings.allowNewFolders,
      minScore: settings.localMinScore,
    });
  }

  // Mark as looked-at only when the intended classifier actually ran; if the model
  // failed and local matching stood in, the next sweep should give the model another go.
  if (!lastError) {
    for (const item of items) seen[item.id] = fingerprint(item);
    await setSeen(seen);
  }

  // Apply. New folders created in this run are cached so a batch shares them.
  const createdThisRun = new Map();
  let moved = 0;
  for (const item of items) {
    const d = decisions.get(item.id);
    if (!d) continue;

    let targetId = d.folderId;
    let targetCreated = false;
    if (!targetId && d.newFolderName) {
      const key = d.newFolderName.trim().toLowerCase();
      if (createdThisRun.has(key)) {
        targetId = createdThisRun.get(key);
      } else {
        const { node, created } = await ensureFolder(root.id, d.newFolderName);
        targetId = node.id;
        targetCreated = created;
        createdThisRun.set(key, node.id);
      }
    }
    if (!targetId || targetId === inbox.id) continue;

    selfMoves.add(item.id);
    try {
      await chrome.bookmarks.move(item.id, { parentId: targetId });
    } catch (err) {
      selfMoves.delete(item.id);
      console.warn('[booky] move failed', item, err);
      continue;
    }
    moved++;
    await appendLog({
      bookmarkId: item.id,
      title: item.title,
      url: item.url,
      from: inbox.id,
      to: targetId,
      toPath: await folderPath(targetId),
      createdFolder: targetCreated,
      method: d.method,
      confidence: d.confidence,
      reason: d.reason,
    });
  }

  await setState({ lastRun: Date.now(), lastMode: mode, lastError, lastMoved: moved, lastSkipped: 0 });
  await refreshBadge();
}

// ---- "Already looked at" bookkeeping (chrome.storage.local, keyed by bookmark id) ----

function fingerprint(n) {
  return `${n.title}\u0000${n.url}`;
}

async function getSeen() {
  const { seen } = await chrome.storage.local.get('seen');
  return seen || {};
}

async function setSeen(seen) {
  await chrome.storage.local.set({ seen });
}

async function forgetSeen(id) {
  const seen = await getSeen();
  if (id in seen) {
    delete seen[id];
    await setSeen(seen);
  }
}

async function undo(ts, bookmarkId) {
  const log = await getLog();
  const entry = log.find((e) => e.ts === ts && e.bookmarkId === bookmarkId);
  if (!entry || entry.undone) return;

  const node = await getNode(bookmarkId).catch(() => null);
  if (node) {
    selfMoves.add(bookmarkId);
    await chrome.bookmarks.move(bookmarkId, { parentId: entry.from });
    await rejectFolder(bookmarkId, entry, 'undone by the person');
  }
  // Remove the folder if we created it for this one bookmark and it is now empty.
  if (entry.createdFolder) {
    const kids = await getChildren(entry.to).catch(() => null);
    if (kids && kids.length === 0) await chrome.bookmarks.remove(entry.to).catch(() => {});
  }
  entry.undone = true;
  await chrome.storage.local.set({ log });
  // Back in the inbox with that folder ruled out: try again right away.
  await forgetSeen(bookmarkId);
  scheduleSort(500);
}

/** "Not that folder" for this bookmark; the classifier is told and the folder is excluded. */
async function rejectFolder(bookmarkId, entry, how) {
  const node = await getNode(bookmarkId).catch(() => null);
  if (!node?.url) return;
  await addCorrection({
    bookmarkId,
    title: node.title,
    url: node.url,
    fromId: entry.to,
    fromPath: entry.toPath,
    toId: entry.from,
    toPath: `(${how} — "${entry.toPath}" was the wrong folder)`,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * MV3 service workers can only fetch hosts the extension has permission for. The
 * options page requests the origin when settings are saved; this explains what to
 * do if that didn't happen (or was declined).
 */
async function missingHostPermission(baseUrl) {
  const pattern = originPattern(baseUrl);
  if (!pattern) return `"${baseUrl || '(empty)'}" is not a valid http(s) URL`;
  const ok = await chrome.permissions.contains({ origins: [pattern] }).catch(() => false);
  return ok ? null : `Booky doesn't have permission to reach ${pattern.slice(0, -2)} — open Settings and click Save to grant it`;
}

async function folderPath(id) {
  const parts = [];
  let cur = id;
  for (let i = 0; i < 20 && cur && cur !== '0'; i++) {
    const node = await getNode(cur).catch(() => null);
    if (!node) break;
    parts.unshift(node.title);
    cur = node.parentId;
  }
  return parts.join(' / ');
}

async function getStatus() {
  const settings = await getSettings();
  const inbox = await resolveInbox(settings);
  const rejected = await getRejected();
  const kids = await getChildren(inbox.id);
  const { state } = await chrome.storage.local.get('state');
  const useLLM = await llmConfigured(settings);

  // What's still waiting, with the local matcher's top guesses so the popup can
  // explain itself and offer one-click filing.
  const root = await resolveRoot(settings, inbox);
  const folders = await collectFolders(root.id, inbox.id);
  const seen = await getSeen();
  const pending = kids
    .filter((k) => k.url)
    .map((k) => ({
      id: k.id,
      title: k.title,
      url: k.url,
      seen: seen[k.id] === fingerprint(k),
      rejectedPaths: [...(rejected.get(k.id) || [])].map((id) => folders.find((f) => f.id === id)?.path).filter(Boolean),
      guesses: rankLocally({ id: k.id, title: k.title, url: k.url }, folders)
        .filter((g) => g.score > 0 && !rejected.get(k.id)?.has(g.folderId))
        .slice(0, 3),
    }));

  return {
    enabled: settings.enabled,
    inboxName: inbox.title,
    inboxId: inbox.id,
    inboxCount: pending.length,
    mode: useLLM ? 'llm' : 'local',
    model: settings.model,
    providerLabel: providerInfo(settings.provider).label,
    minScore: settings.localMinScore,
    pending,
    folders: folders.map((f) => ({ id: f.id, path: f.path })),
    ...(state || {}),
    log: (await getLog()).slice(0, 30),
  };
}

/** User picked a folder from the popup. Counts as a manual move (not a correction). */
async function fileTo(bookmarkId, folderId, newFolderName) {
  const settings = await getSettings();
  const inbox = await resolveInbox(settings);
  let targetId = folderId;
  if (!targetId && newFolderName) {
    const root = await resolveRoot(settings, inbox);
    targetId = (await ensureFolder(root.id, newFolderName)).node.id;
  }
  if (!targetId) return;
  // Not a selfMove: onMoved should treat it as the user's own filing.
  await chrome.bookmarks.move(bookmarkId, { parentId: targetId });
}

async function setState(patch) {
  const { state } = await chrome.storage.local.get('state');
  await chrome.storage.local.set({ state: { ...(state || {}), ...patch } });
}

/** Toolbar badge = number of bookmarks waiting in the Inbox (whatever their state). */
async function refreshBadge() {
  const settings = await getSettings();
  const inbox = await resolveInbox(settings);
  const count = (await getChildren(inbox.id)).filter((k) => k.url).length;
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
  if (count) {
    await chrome.action.setBadgeBackgroundColor({ color: settings.enabled ? '#2f6df6' : '#8a8a8a' });
    await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  }
}

function reportError(err) {
  console.error('[booky]', err);
  setState({ lastError: String(err?.message || err) }).catch(() => {});
}
