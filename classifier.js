// Decides where each inbox bookmark goes.
//
// Input:  items   = [{ id, title, url }]
//         folders = [{ id, title, path, depth, bookmarks: [{title,url}] }]   (candidates)
// Output: Map<itemId, { folderId?: string, newFolderName?: string, confidence, reason, method }>
//
// Two backends: an LLM (any provider from providers.js, if configured) and a local
// token-overlap heuristic. Both see the same folder list, so renaming a folder is
// picked up automatically — nothing is keyed by folder name.

import { hostnameOf } from './bookmarks.js';
import { providerInfo } from './providers.js';

// ---------------------------------------------------------------------------
// LLM backend — shared prompt, two wire formats
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You file browser bookmarks into folders for one person.

You are given:
- The person's existing folders (with a numeric index, the folder path, and a few example bookmarks already in each).
- Corrections: cases where the person moved a bookmark out of the folder it was auto-filed into. Treat these as strong hints about how they think about their categories.
- A batch of new bookmarks (title + URL) sitting in their Inbox.

For each new bookmark, choose the single best existing folder. Prefer existing folders — the person curates these names and they reflect how they think. Only propose a new folder when nothing existing fits reasonably; when you do, use a short, broad, human name (2–3 words max, Title Case, e.g. "Recipes", "Home Improvement", "AI Tools") that would plausibly collect several future bookmarks, not something specific to one page. If several new bookmarks in this batch belong together, give them the same new folder name. Never propose a new folder that duplicates an existing one under a slightly different name.

Confidence is 0–1: how sure you are this is where the person would have put it themselves.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          bookmarkId: { type: 'string' },
          folderIndex: { type: ['integer', 'null'], description: 'Index of an existing folder, or null when proposing a new one.' },
          newFolderName: { type: ['string', 'null'], description: 'Name for a new folder; null when using an existing one.' },
          confidence: { type: 'number' },
          reason: { type: 'string', description: 'One short sentence.' },
        },
        required: ['bookmarkId', 'folderIndex', 'newFolderName', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['decisions'],
  additionalProperties: false,
};

function buildUserMessage(items, folders, corrections, opts) {
  const folderLines = folders.map((f, i) => {
    const examples = f.bookmarks
      .slice(0, opts.examplesPerFolder)
      .map((b) => `    - ${truncate(b.title, 80)}  <${hostnameOf(b.url)}>`)
      .join('\n');
    return `[${i}] ${f.path}${examples ? '\n' + examples : '\n    (empty)'}`;
  });

  const correctionLines = corrections.slice(0, 30).map((c) =>
    `- "${truncate(c.title, 80)}" <${hostnameOf(c.url)}>: auto-filed to "${c.fromPath}", person moved it to "${c.toPath}"`,
  );

  const indexById = new Map(folders.map((f, i) => [f.id, i]));
  const itemLines = items.map((it) => {
    const rejected = [...(opts.rejected?.get(it.id) || [])]
      .map((id) => indexById.get(id))
      .filter((i) => i !== undefined);
    const note = rejected.length ? `  NOT folder ${rejected.map((i) => `[${i}]`).join(' or ')} (person rejected it)` : '';
    return `- id=${it.id}  title="${truncate(it.title, 120)}"  url=${truncate(it.url, 200)}${note}`;
  });

  return [
    '## Existing folders',
    folderLines.length ? folderLines.join('\n') : '(none yet)',
    '',
    '## Corrections',
    correctionLines.length ? correctionLines.join('\n') : '(none)',
    '',
    opts.allowNewFolders
      ? '## New bookmarks to file (new folders allowed when nothing fits)'
      : '## New bookmarks to file (you MUST pick an existing folder; new folders are disabled)',
    itemLines.join('\n'),
  ].join('\n');
}

async function errorDetail(res) {
  try {
    const j = await res.json();
    return j.error?.message || (typeof j.error === 'string' ? j.error : '') || j.message || '';
  } catch { return ''; }
}

async function detailSuffix(res) {
  const d = await errorDetail(res);
  return d ? ': ' + d : '';
}

function describeFetchError(err, baseUrl) {
  const msg = String(err?.message || err);
  if (/Failed to fetch|NetworkError|network/i.test(msg)) {
    return `Could not reach ${baseUrl}. Is the server running, and did you save Settings so Booky has permission for that host?`;
  }
  return msg;
}

/** Models sometimes wrap JSON in a code fence or a sentence; dig the object out. */
function parseDecisions(text) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('model returned no JSON');
  const parsed = JSON.parse(s.slice(start, end + 1));
  if (!Array.isArray(parsed.decisions)) throw new Error('model JSON has no "decisions" array');
  return parsed.decisions;
}

/** Map raw model decisions onto folder ids, dropping anything unusable. */
function toDecisionMap(decisions, { items, folders, rejected, allowNewFolders }) {
  const out = new Map();
  const itemIds = new Set(items.map((i) => i.id));

  for (const d of decisions) {
    if (!itemIds.has(d.bookmarkId)) continue;
    const decision = { confidence: d.confidence ?? 0.5, reason: d.reason || '', method: 'llm' };
    if (d.folderIndex !== null && d.folderIndex !== undefined && folders[d.folderIndex]) {
      decision.folderId = folders[d.folderIndex].id;
      if (rejected?.get(d.bookmarkId)?.has(decision.folderId)) continue; // hard guard, whatever the model said
    } else if (allowNewFolders && d.newFolderName) {
      decision.newFolderName = d.newFolderName;
    } else {
      continue; // unusable decision; leave in inbox
    }
    out.set(d.bookmarkId, decision);
  }
  return out;
}

/**
 * Classify with whichever provider is configured.
 * `provider` is a key of PROVIDERS; `baseUrl` is the resolved endpoint root.
 */
export async function classifyWithLLM(args) {
  const info = providerInfo(args.provider);
  const userMessage = buildUserMessage(args.items, args.folders, args.corrections, {
    allowNewFolders: args.allowNewFolders,
    examplesPerFolder: args.examplesPerFolder,
    rejected: args.rejected,
  });
  const text = info.api === 'anthropic'
    ? await completeAnthropic({ ...args, userMessage })
    : await completeOpenAI({ ...args, userMessage, extra: info.extra });
  return toDecisionMap(parseDecisions(text), args);
}

/** Cheap connectivity check for the options page. */
export async function testProvider({ provider, baseUrl, apiKey, model }) {
  const info = providerInfo(provider);
  try {
    const res = info.api === 'anthropic'
      ? await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: anthropicHeaders(apiKey),
          body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }),
        })
      : await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: openaiHeaders(apiKey),
          body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with the single word: pong' }] }),
        });
    if (res.ok) return { ok: true };
    return { ok: false, error: `${res.status}${await detailSuffix(res)}` };
  } catch (err) {
    return { ok: false, error: describeFetchError(err, baseUrl) };
  }
}

// ---- Anthropic Messages API ----

function anthropicHeaders(apiKey) {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

async function completeAnthropic({ baseUrl, apiKey, model, userMessage }) {
  const body = {
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
    messages: [{ role: 'user', content: userMessage }],
  };

  let res;
  try {
    res = await fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: anthropicHeaders(apiKey), body: JSON.stringify(body) });
  } catch (err) {
    throw new Error(describeFetchError(err, baseUrl));
  }
  if (!res.ok) throw new Error(`API ${res.status}${await detailSuffix(res)}`);

  const msg = await res.json();
  if (msg.stop_reason === 'refusal') throw new Error('the model declined the request');
  const text = (msg.content || []).find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('the model returned no text');
  return text;
}

// ---- OpenAI-compatible chat/completions ----

function openaiHeaders(apiKey) {
  const h = { 'content-type': 'application/json' };
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return h;
}

// Not every OpenAI-compatible server supports strict JSON-schema output, and some
// reject `response_format` outright. Ask for the strictest mode first and step down
// on a 400; the schema is also spelled out in the prompt so plain-text mode still works.
const RESPONSE_FORMATS = [
  { type: 'json_schema', json_schema: { name: 'bookmark_decisions', strict: true, schema: OUTPUT_SCHEMA } },
  { type: 'json_object' },
  null,
];

async function completeOpenAI({ baseUrl, apiKey, model, userMessage, extra }) {
  const system = `${SYSTEM_PROMPT}\n\nRespond with JSON only — no prose, no code fence — matching this schema:\n${JSON.stringify(OUTPUT_SCHEMA)}`;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userMessage },
  ];

  let lastError = null;
  for (const response_format of RESPONSE_FORMATS) {
    const body = { model, messages, ...(extra || {}) };
    if (response_format) body.response_format = response_format;

    let res;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers: openaiHeaders(apiKey), body: JSON.stringify(body) });
    } catch (err) {
      throw new Error(describeFetchError(err, baseUrl));
    }
    if (res.status === 400 && response_format) {
      lastError = `API 400${await detailSuffix(res)}`;
      continue; // try a looser output mode
    }
    if (!res.ok) throw new Error(`API ${res.status}${await detailSuffix(res)}`);

    const data = await res.json();
    const choice = data.choices?.[0];
    if (choice?.message?.refusal) throw new Error('the model declined the request');
    const content = choice?.message?.content;
    const text = Array.isArray(content) ? content.map((p) => p.text || '').join('') : content;
    if (!text) throw new Error('the model returned no text');
    return text;
  }
  throw new Error(lastError || 'request failed');
}

// ---------------------------------------------------------------------------
// Local heuristic backend (no API key)
// ---------------------------------------------------------------------------

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'by', 'at', 'is',
  'how', 'what', 'why', 'your', 'you', 'my', 'this', 'that', 'from', 'com', 'org', 'net', 'io', 'www', 'html',
  'htm', 'php', 'index', 'home', 'page', 'new', 'best', 'top', 'free', 'online', 'official', 'site', 'app']);

function tokens(str) {
  return (str || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t))
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t)); // crude plural folding
}

function bookmarkTokens(b) {
  const host = hostnameOf(b.url);
  return new Set([...tokens(b.title), ...tokens(host.split('.').slice(0, -1).join(' '))]);
}

// Domain → built-in category. Each category also lists words that, if they appear
// in one of the person's existing folder names, mean "use that folder instead of
// creating a new one" (Netflix → their "Streaming" folder, not a new "Movies & TV").
const DOMAIN_CATEGORIES = [
  [/github\.com|gitlab\.com|stackoverflow\.com|npmjs\.com|pypi\.org|developer\.mozilla|docs\.rs|crates\.io/, 'Development', ['dev', 'development', 'code', 'coding', 'programming', 'github', 'tech']],
  [/youtube\.com|youtu\.be|vimeo\.com|twitch\.tv/, 'Videos', ['video', 'videos', 'youtube', 'watch', 'streaming']],
  [/amazon\.|ebay\.|etsy\.com|walmart\.com|bestbuy\.com|aliexpress|target\.com/, 'Shopping', ['shopping', 'shop', 'buy', 'store', 'wishlist', 'gear']],
  [/reddit\.com/, 'Reddit', ['reddit', 'social', 'forums']],
  [/twitter\.com|x\.com|bsky\.app|mastodon|threads\.net/, 'Social', ['social', 'twitter']],
  [/news|nytimes|washingtonpost|theguardian|bbc\.|cnn\.|reuters|apnews|bloomberg|wsj\.com/, 'News', ['news', 'current', 'politics']],
  [/wikipedia\.org|britannica/, 'Reference', ['reference', 'wiki', 'info']],
  [/allrecipes|seriouseats|bonappetit|foodnetwork|recipe|epicurious/, 'Recipes', ['recipe', 'recipes', 'cooking', 'food', 'kitchen', 'meals']],
  [/arxiv\.org|scholar\.google|pubmed|jstor|semanticscholar/, 'Papers', ['papers', 'research', 'academic', 'science']],
  [/spotify\.com|soundcloud|bandcamp|music\.apple|last\.fm/, 'Music', ['music', 'songs', 'playlists', 'audio']],
  [/netflix|hulu|disneyplus|imdb\.com|letterboxd|rottentomatoes|max\.com|peacocktv|paramountplus/, 'Movies & TV', ['movies', 'tv', 'streaming', 'film', 'films', 'shows', 'watch', 'entertainment']],
  [/medium\.com|substack\.com|dev\.to|hashnode/, 'Articles', ['articles', 'reading', 'read', 'blogs', 'later']],
  [/docs\.google|notion\.so|figma\.com|airtable|trello|asana|slack\.com|linear\.app|atlassian/, 'Work Tools', ['work', 'tools', 'productivity', 'office']],
  [/openai\.com|anthropic\.com|huggingface\.co|claude\.ai|chatgpt|perplexity\.ai|midjourney/, 'AI Tools', ['ai', 'llm', 'gpt', 'ml']],
  [/booking\.com|airbnb|expedia|tripadvisor|kayak|hotels\.com|skyscanner|vrbo/, 'Travel', ['travel', 'trips', 'trip', 'vacation', 'flights', 'hotels']],
  [/steam(powered|community)|epicgames|ign\.com|gamespot|itch\.io|nexusmods/, 'Games', ['games', 'gaming', 'game']],
  [/linkedin\.com|indeed\.com|glassdoor|lever\.co|greenhouse\.io/, 'Jobs', ['jobs', 'career', 'careers', 'hustle', 'work']],
  [/coursera|udemy|edx\.org|khanacademy|pluralsight|skillshare/, 'Learning', ['learning', 'courses', 'education', 'study', 'school']],
  [/strava|myfitnesspal|bodybuilding|nike\.com|garmin|peloton/, 'Fitness', ['fitness', 'gym', 'workout', 'health', 'running']],
  [/mint\.com|nerdwallet|investopedia|robinhood|fidelity|vanguard|schwab|bank/, 'Finance', ['finance', 'money', 'investing', 'budget', 'banking']],
  [/zillow|redfin|realtor\.com|homedepot|lowes\.com|ikea/, 'Home', ['home', 'house', 'diy', 'garden']],
];

function domainCategory(item) {
  const host = hostnameOf(item.url);
  for (const [re, name, synonyms] of DOMAIN_CATEGORIES) {
    if (re.test(host) || re.test(item.url)) return { name, synonyms };
  }
  return null;
}

function buildProfiles(folders) {
  const profiles = folders.map((f) => {
    const nameTokens = new Set(tokens(f.title));
    const bag = new Map();
    const hosts = new Set();
    for (const b of f.bookmarks) {
      hosts.add(hostnameOf(b.url));
      for (const t of bookmarkTokens(b)) bag.set(t, (bag.get(t) || 0) + 1);
    }
    return { folder: f, nameTokens, bag, hosts, size: f.bookmarks.length };
  });
  // How many folders each token appears in — a word unique to one folder is a much
  // stronger hint than one that shows up everywhere.
  const df = new Map();
  for (const p of profiles) for (const t of p.bag.keys()) df.set(t, (df.get(t) || 0) + 1);
  return { profiles, df };
}

/** Score every folder for one bookmark; returns candidates sorted best-first. */
export function rankLocally(item, folders, prebuilt) {
  const { profiles, df } = prebuilt || buildProfiles(folders);
  const host = hostnameOf(item.url);
  const itemTokens = bookmarkTokens(item);

  const ranked = [];
  for (const p of profiles) {
    let score = 0;
    const why = [];
    // Same site already filed here: strong signal.
    if (host && p.hosts.has(host)) { score += 5; why.push('same site as others in it'); }
    // Folder name appears in the title/host: enough on its own to file it.
    for (const t of p.nameTokens) if (itemTokens.has(t)) { score += 4; why.push(`title mentions "${t}"`); }
    // Words shared with bookmarks already in the folder, weighted by how rare the word is.
    let overlap = 0;
    const shared = [];
    for (const t of itemTokens) {
      if (!p.bag.has(t)) continue;
      overlap += 2 / (df.get(t) || 1);
      shared.push(t);
    }
    overlap = Math.min(overlap, 6);
    if (overlap > 0) { score += overlap; why.push(`shares words: ${shared.slice(0, 4).join(', ')}`); }
    ranked.push({ folderId: p.folder.id, path: p.folder.path, score, why: why.join('; ') });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

export function classifyLocally({ items, folders, rejected, allowNewFolders, minScore }) {
  const prebuilt = buildProfiles(folders);
  const out = new Map();

  for (const item of items) {
    const banned = rejected?.get(item.id);
    const [best] = rankLocally(item, folders, prebuilt).filter((g) => !banned?.has(g.folderId));

    if (best && best.score >= minScore) {
      out.set(item.id, {
        folderId: best.folderId,
        confidence: Math.min(1, best.score / 10),
        reason: `Matched "${best.path}" (score ${best.score.toFixed(1)}: ${best.why})`,
        method: 'local',
      });
      continue;
    }

    const cat = domainCategory(item);
    if (!cat) continue;

    // Prefer an existing folder whose name means the same thing as the built-in category.
    const synonymHit = folders.find((f) => {
      if (banned?.has(f.id)) return false;
      const ft = new Set(tokens(f.title).concat(f.title.toLowerCase().split(/\s+/)));
      return f.title.toLowerCase() === cat.name.toLowerCase() || cat.synonyms.some((syn) => ft.has(syn));
    });
    if (synonymHit) {
      out.set(item.id, { folderId: synonymHit.id, confidence: 0.6, reason: `Site type "${cat.name}" → "${synonymHit.path}"`, method: 'local' });
    } else if (allowNewFolders) {
      out.set(item.id, { newFolderName: cat.name, confidence: 0.5, reason: `Site type → new folder "${cat.name}"`, method: 'local' });
    }
  }
  return out;
}

function truncate(s, n) {
  s = s || '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
