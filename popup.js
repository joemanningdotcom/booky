import { saveSettings } from './settings.js';

const $ = (id) => document.getElementById(id);

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

function timeAgo(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function render(status) {
  if (status.error) {
    $('lastError').textContent = status.error;
    $('lastError').hidden = false;
    return;
  }
  $('enabled').checked = status.enabled;
  $('dot').className = 'dot ' + (status.enabled ? (status.mode === 'llm' ? 'on' : 'local') : 'off');
  $('mode').textContent = status.mode === 'llm' ? `· ${status.model}` : '· local matching';
  $('count').textContent = status.inboxCount;
  $('inboxName').textContent = status.inboxName;
  $('inboxName2').textContent = status.inboxName;
  $('sortNow').disabled = status.inboxCount === 0;

  $('lastError').hidden = !status.lastError;
  $('lastError').textContent = status.lastError || '';
  $('lastRun').textContent = status.lastRun ? `Last run ${timeAgo(status.lastRun)}` : '';

  renderPending(status);

  const list = $('log');
  list.innerHTML = '';
  const entries = (status.log || []).slice(0, 12);
  $('empty').hidden = entries.length > 0;
  for (const e of entries) {
    const li = document.createElement('li');
    li.className = e.undone ? 'undone' : '';
    li.innerHTML = `
      <div class="row">
        <a class="title" href="${escapeAttr(e.url)}" target="_blank" title="${escapeAttr(e.url)}">${escapeHtml(e.title || e.url)}</a>
        ${e.undone ? '<span class="pill">undone</span>' : '<button class="undo" title="Wrong folder — put it back and re-sort without that folder">Undo</button>'}
      </div>
      <div class="meta">
        → <b>${escapeHtml(e.toPath)}</b>${e.createdFolder ? ' <span class="pill new">new folder</span>' : ''}
        <span class="muted">· ${e.method === 'local' ? 'local' : 'AI'} · ${timeAgo(e.ts)}</span>
      </div>
      ${e.reason ? `<div class="reason muted">${escapeHtml(e.reason)}</div>` : ''}
    `;
    li.querySelector('.undo')?.addEventListener('click', async () => {
      li.querySelector('.undo').disabled = true;
      render(await send({ type: 'undo', ts: e.ts, bookmarkId: e.bookmarkId }));
    });
    list.appendChild(li);
  }
}

// Items still in the inbox: show the matcher's best guesses as one-click chips,
// plus a folder picker for everything else. Filing by hand is how the local
// matcher learns, so make it cheap.
function renderPending(status) {
  const section = $('pendingSection');
  const list = $('pending');
  const pending = status.pending || [];
  section.hidden = pending.length === 0;
  list.innerHTML = '';

  for (const p of pending) {
    const li = document.createElement('li');
    const guesses = status.mode === 'llm' ? [] : p.guesses; // local scores are noise when the model decides
    const chips = guesses.map((g) =>
      `<button class="chip" data-folder="${escapeAttr(g.folderId)}" title="${escapeAttr(g.why || '')}">${escapeHtml(leaf(g.path))} <span class="score">${g.score.toFixed(1)}</span></button>`,
    ).join('');
    const options = ['<option value="">Move to…</option>']
      .concat((status.folders || []).map((f) => `<option value="${escapeAttr(f.id)}">${escapeHtml(f.path)}</option>`))
      .concat('<option value="__new__">＋ New folder…</option>')
      .join('');
    const notThere = p.rejectedPaths?.length ? ` Not: ${p.rejectedPaths.map(leaf).join(', ')}.` : '';
    const explain = (status.mode === 'llm'
      ? `Waiting for the next run — click Sort now to file it with ${status.providerLabel || 'the model'}.`
      : p.guesses.length
        ? `Best guess scored ${p.guesses[0].score.toFixed(1)}; needs ${status.minScore} to file automatically.`
        : 'Nothing similar in your folders yet.') + notThere;
    li.innerHTML = `
      <div class="row">
        <a class="title" href="${escapeAttr(p.url)}" target="_blank" title="${escapeAttr(p.url)}">${escapeHtml(p.title || p.url)}</a>
      </div>
      <div class="chips">${chips}<select class="picker">${options}</select></div>
      <div class="reason muted">${escapeHtml(explain)}</div>
    `;
    for (const btn of li.querySelectorAll('.chip')) {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        render(await send({ type: 'fileTo', bookmarkId: p.id, folderId: btn.dataset.folder }));
      });
    }
    li.querySelector('.picker').addEventListener('change', async (ev) => {
      const v = ev.target.value;
      if (!v) return;
      if (v === '__new__') {
        const name = prompt('New folder name:');
        if (!name?.trim()) { ev.target.value = ''; return; }
        render(await send({ type: 'fileTo', bookmarkId: p.id, newFolderName: name.trim() }));
      } else {
        render(await send({ type: 'fileTo', bookmarkId: p.id, folderId: v }));
      }
    });
    list.appendChild(li);
  }
}

function leaf(path) {
  const parts = String(path || '').split(' / ');
  return parts[parts.length - 1];
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}

$('sortNow').addEventListener('click', async () => {
  $('sortNow').disabled = true;
  $('sortNow').textContent = 'Sorting…';
  try {
    render(await send({ type: 'sortNow' }));
  } finally {
    $('sortNow').textContent = 'Sort now';
  }
});

$('enabled').addEventListener('change', async (ev) => {
  await saveSettings({ enabled: ev.target.checked });
  render(await send({ type: 'status' }));
});

$('openOptions').addEventListener('click', (ev) => {
  ev.preventDefault();
  chrome.runtime.openOptionsPage();
});

send({ type: 'status' }).then(render);
