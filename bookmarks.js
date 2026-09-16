// Thin helpers over chrome.bookmarks.

const ROOT_ID = '0';
const BAR_ID = '1';

export function isFolder(node) {
  return !node.url;
}

export async function getNode(id) {
  const [node] = await chrome.bookmarks.get(id);
  return node;
}

export async function getChildren(id) {
  return chrome.bookmarks.getChildren(id);
}

/** Find (or create) the Inbox folder. Prefers the stored id, then a folder named `inboxName`. */
export async function resolveInbox(settings) {
  if (settings.inboxFolderId) {
    try {
      const node = await getNode(settings.inboxFolderId);
      if (node && isFolder(node)) return node;
    } catch { /* deleted; fall through */ }
  }
  const matches = (await chrome.bookmarks.search({ title: settings.inboxName }))
    .filter(isFolder);
  if (matches.length) return matches[0];
  return chrome.bookmarks.create({ parentId: BAR_ID, title: settings.inboxName });
}

/** The folder that categories are created under. */
export async function resolveRoot(settings, inbox) {
  if (settings.rootFolderId) {
    try {
      const node = await getNode(settings.rootFolderId);
      if (node && isFolder(node)) return node;
    } catch { /* deleted */ }
  }
  return getNode(inbox.parentId);
}

/**
 * All folders under `root` (recursively), excluding the Inbox subtree.
 * Each entry: { id, title, path, depth, bookmarks: [{title,url}] }
 * `bookmarks` holds only that folder's direct bookmark children.
 */
export async function collectFolders(rootId, inboxId) {
  const [rootNode] = await chrome.bookmarks.getSubTree(rootId);
  const out = [];
  const walk = (node, pathParts, depth) => {
    for (const child of node.children || []) {
      if (!isFolder(child) || child.id === inboxId) continue;
      const path = [...pathParts, child.title];
      const bookmarks = (child.children || [])
        .filter((c) => c.url)
        .map((c) => ({ title: c.title, url: c.url, dateAdded: c.dateAdded || 0 }))
        .sort((a, b) => b.dateAdded - a.dateAdded);
      out.push({ id: child.id, title: child.title, path: path.join(' / '), depth, bookmarks });
      walk(child, path, depth + 1);
    }
  };
  walk(rootNode, [], 0);
  return out;
}

/** Every folder in the profile, flattened with paths — used by the options page pickers. */
export async function allFolders() {
  const tree = await chrome.bookmarks.getTree();
  const out = [];
  const walk = (node, pathParts) => {
    for (const child of node.children || []) {
      if (!isFolder(child)) continue;
      const path = [...pathParts, child.title];
      out.push({ id: child.id, title: child.title, path: path.join(' / ') });
      walk(child, path);
    }
  };
  walk(tree[0], []);
  return out;
}

/** Find a direct child folder of `parentId` by (case-insensitive) title, or create it. */
export async function ensureFolder(parentId, title) {
  const kids = await getChildren(parentId);
  const hit = kids.find((k) => isFolder(k) && k.title.trim().toLowerCase() === title.trim().toLowerCase());
  if (hit) return { node: hit, created: false };
  const node = await chrome.bookmarks.create({ parentId, title: title.trim() });
  return { node, created: true };
}

export function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
