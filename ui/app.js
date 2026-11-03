// Copyright (c) 2026 buggerlogger. All rights reserved.
// Proprietary and confidential. No license is granted to use, copy, modify or
// distribute this file, in whole or in part. See LICENSE.

/* brainstorm IDE — front end. No framework, no CDN: it has to work offline
   and outlive whatever is fashionable.

   State lives in one object. Every mutation goes through render(), so the tree,
   the editor, the status bar and the debugger can never disagree about what is
   open or what is dirty -- the class of bug that makes an editor untrustworthy. */

'use strict';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const S = {
  projects: [],
  expanded: new Set(),          // tree node keys
  state: null,                  // /api/state
  tabs: [],                     // { key, kind:'block'|'frame', id, label, text, readonly, meta, dirty }
  active: null,                 // tab key
  trace: null,                  // /api/flow
  cursor: { call: 0, frame: -1 },
  breakpoints: new Set(),       // "call:frame"
  probeHits: [],
  probeAt: -1,
  panel: 'terminal',
  view: 'explorer',
  editingPin: null,   // pin id being edited, or 'new'
  shellSeq: 0,
  liveSeq: 0,
  liveEvents: [],
  liveUnread: 0,
};

/* ------------------------------------------------------------------ api --- */

async function api(path, body) {
  const opt = body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  let res;
  try {
    res = await fetch(path, opt);
  } catch (err) {
    // A network failure here means the server process is gone. Say THAT --
    // "Failed to fetch" under a search box reads like "no such session".
    window.brainstorm?.offline?.();
    throw new Error('the brainstorm server is not running — reopen brainstorm.exe');
  }
  window.brainstorm?.online?.();
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!res.ok || data.error) throw new Error(data.error || `${res.status} ${path}`);
  return data;
}

function status(msg, kind) {
  const n = $('#st-msg');
  n.textContent = msg;
  n.style.color = kind === 'err' ? '#ffd0cc' : '';
}

function termWrite(text, cls) {
  const t = $('#term');
  const span = el('span', cls || '', text.endsWith('\n') ? text : `${text}\n`);
  t.appendChild(span);
  t.scrollTop = t.scrollHeight;
}

function outputWrite(text) {
  const t = $('#output');
  t.appendChild(el('span', '', text.endsWith('\n') ? text : `${text}\n`));
  t.scrollTop = t.scrollHeight;
}

/* -------------------------------------------------------------- explorer --- */

async function loadProjects() {
  $('#tree').replaceChildren(el('div', 'muted pad', 'Scanning ~/.claude/projects…'));
  try {
    const { projects } = await api('/api/projects');
    S.projects = projects;
    renderTree();
    status(`${projects.length} project(s)`);
  } catch (err) {
    $('#tree').replaceChildren(el('div', 'muted pad', `scan failed: ${err.message}`));
  }
}

function node({ depth = 0, twisty = '', icon = '', iconCls = '', label, meta = '', cls = '', onClick, onAux, data = null }) {
  const n = el('div', `node d${depth} ${cls}`);
  n.appendChild(el('span', 'tw', twisty));
  if (icon) n.appendChild(el('span', `ico ${iconCls}`, icon));
  n.appendChild(el('span', 'lbl', label));
  if (meta !== '') n.appendChild(el('span', 'meta', meta));
  if (onClick) n.addEventListener('click', onClick);
  // What this node IS, for the context menu: data-block-id, data-folder,
  // data-call/data-frame, data-session-path. The menu reads these rather than
  // every node carrying its own right-click handler.
  if (data) for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== null) n.dataset[k] = String(v);
  if (onAux) {
    const eye = el('span', 'eye', '◉');
    eye.title = 'include / drop this block';
    eye.addEventListener('click', (e) => { e.stopPropagation(); onAux(); });
    n.appendChild(eye);
  }
  return n;
}

function renderTree() {
  const tree = $('#tree');
  const frag = document.createDocumentFragment();

  // --- open session's blocks first: that is what you work on ---
  if (S.state?.open) {
    const cfg = S.state.config;
    frag.appendChild(node({
      depth: 0, twisty: '▾', icon: '◼', iconCls: 'user',
      label: cfg.sessionId.slice(0, 8), meta: `${S.state.totals.blocks} blocks`,
      cls: 'selected',
    }));
    for (const g of S.state.groups) {
      const key = `g:${g.name}`;
      const open = S.expanded.has(key);
      frag.appendChild(node({
        depth: 1, twisty: open ? '▾' : '▸', icon: '🗀', label: g.name,
        meta: `${g.blocks.length}`,
        onClick: () => { toggle(key); renderTree(); },
        data: { folder: g.name },
      }));
      if (!open) continue;
      for (const b of g.blocks) {
        frag.appendChild(node({
          depth: 2,
          icon: glyph(b.kind, b.role), iconCls: b.kind === 'text' ? b.role : b.kind,
          label: `#${b.id} ${b.title}`,
          meta: fmt(b.chars),
          cls: `${b.keep ? '' : 'dropped'} ${b.dirty ? 'dirty' : ''} ${S.active === `block:${b.id}` ? 'selected' : ''}`,
          onClick: () => openBlock(b.id),
          onAux: () => toggleKeep(b.id, !b.keep),
          data: { blockId: b.id, folder: g.name },
        }));
      }
    }
    frag.appendChild(el('div', 'view-head', 'Sessions'));
  }

  for (const p of S.projects) {
    const key = `p:${p.dir}`;
    const open = S.expanded.has(key);
    frag.appendChild(node({
      depth: 0, twisty: open ? '▾' : '▸', icon: '🗀',
      label: p.cwd ? p.cwd.split(/[\\/]/).pop() || p.dir : p.dir,
      meta: `${p.sessions.length}`,
      onClick: () => { toggle(key); renderTree(); },
    }));
    if (!open) continue;
    for (const s of p.sessions) {
      frag.appendChild(node({
        depth: 1, icon: '▤',
        label: `${s.id.slice(0, 8)} ${s.firstPrompt ? `— ${s.firstPrompt.slice(0, 40)}` : ''}`,
        meta: `${fmt(s.bytes)}B`,
        cls: S.state?.config?.sessionId === s.id ? 'selected' : '',
        onClick: () => openSession(s.id, s.path),
        data: { sessionId: s.id, sessionPath: s.path },
      }));
    }
  }
  tree.replaceChildren(frag);
}

const toggle = (k) => (S.expanded.has(k) ? S.expanded.delete(k) : S.expanded.add(k));

function glyph(kind, role) {
  if (kind === 'tool_use') return 'ƒ';
  if (kind === 'tool_result') return '↩';
  if (kind === 'thinking') return '◌';
  if (role === 'assistant') return '◆';
  if (role === 'system') return '⚙';
  return '▸';
}

const fmt = (n) => (n >= 1000000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

async function openSession(id, path) {
  status(`extracting ${id.slice(0, 8)}…`);
  termWrite(`$ ctx extract --session ${id}`, 'cmd');
  try {
    const st = await api('/api/open', { session: path || id });
    S.state = st;
    if (st.engineOut) termWrite(st.engineOut, 'dim');
    S.expanded.add(`g:${st.groups[0]?.name}`);
    S.tabs = [];
    S.active = null;
    S.trace = null;
    renderAll();
    status(`${st.totals.blocks} blocks · ${st.measured ? 'measured' : 'estimated'} ${st.ratio} ch/tok`);
    $('#chat-target').textContent = `will resume: ${st.config.sessionId} in ${st.config.cwd}`;
  } catch (err) {
    termWrite(err.message, 'err');
    status(err.message, 'err');
  }
}

/* ---------------------------------------------------------------- editor --- */

async function openBlock(id) {
  const key = `block:${id}`;
  let tab = S.tabs.find((t) => t.key === key);
  if (!tab) {
    const b = await api(`/api/block?id=${id}`);
    tab = {
      key, kind: 'block', id, label: `#${id} ${b.kind}`,
      text: b.text, readonly: false, dirty: !!b.dirty,
      meta: `${b.role} · ${b.kind} · line ${b.line} · ${b.at}${b.tool ? ` · ${b.tool}` : ''}`,
    };
    S.tabs.push(tab);
  }
  S.active = key;
  renderAll();
}

function activeTab() { return S.tabs.find((t) => t.key === S.active) || null; }

function renderTabs() {
  const frag = document.createDocumentFragment();
  for (const t of S.tabs) {
    const n = el('div', `tab ${t.key === S.active ? 'selected' : ''} ${t.readonly ? 'readonly' : ''}`);
    n.appendChild(el('span', 'lbl', t.label + (t.dirty ? ' ●' : '')));
    const x = el('span', 'x', '✕');
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      S.tabs = S.tabs.filter((o) => o.key !== t.key);
      if (S.active === t.key) S.active = S.tabs.length ? S.tabs[S.tabs.length - 1].key : null;
      renderAll();
    });
    n.appendChild(x);
    n.addEventListener('click', () => { S.active = t.key; renderAll(); });
    frag.appendChild(n);
  }
  $('#tabs').replaceChildren(frag);
}

function renderEditor() {
  const t = activeTab();
  const ed = $('#editor');
  if (!t) {
    ed.value = '';
    ed.readOnly = true;
    $('#editor-meta').textContent = 'Open a block from the Explorer, or a frame from the debugger.';
    $('#gutter').textContent = '';
    return;
  }
  if (ed.value !== t.text) ed.value = t.text;
  ed.readOnly = !!t.readonly;
  $('#editor-meta').textContent = `${t.meta}  ·  ${t.text.length} ch${t.readonly ? '  ·  read only' : ''}`;
  renderGutter();
}

function renderGutter() {
  const lines = $('#editor').value.split('\n').length;
  const g = $('#gutter');
  let s = '';
  for (let i = 1; i <= lines; i++) s += `${i}\n`;
  g.textContent = s;
  g.scrollTop = $('#editor').scrollTop;
}

function renderStatus() {
  const st = S.state;
  if (!st?.open) {
    $('#st-blocks').textContent = 'no session';
    $('#st-chars').textContent = '';
    $('#st-tokens').textContent = '';
    $('#st-ratio').textContent = '';
    return;
  }
  const d = st.totals.dirty.length;
  $('#st-blocks').textContent = `${st.totals.kept}/${st.totals.blocks} blocks${st.totals.dropped ? ` · ${st.totals.dropped} dropped` : ''}`;
  $('#st-chars').textContent = `${fmt(st.totals.chars)} ch`;
  $('#st-tokens').textContent = `~${fmt(st.totals.tokens)} tok`;
  $('#st-ratio').textContent = st.measured
    ? `${st.ratio} ch/tok measured`
    : `${st.ratio} ch/tok ESTIMATE${st.why ? ` (${st.why})` : ''}`;
  $('#title-session').textContent = `${st.config.sessionId}  —  ${st.config.cwd}`;
  $('#title-dirty').hidden = d === 0;
  $('#title-dirty').textContent = `${d} unsaved`;
}

function renderAll() { renderTree(); renderTabs(); renderEditor(); renderStatus(); renderPins(); }

/* --------------------------------------------------------------- editing --- */

let pushTimer = null;
$('#editor').addEventListener('input', () => {
  const t = activeTab();
  if (!t || t.readonly) return;
  t.text = $('#editor').value;
  t.dirty = true;
  renderGutter();
  renderTabs();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushBlock(t), 400);
});
$('#editor').addEventListener('scroll', () => { $('#gutter').scrollTop = $('#editor').scrollTop; });

async function pushBlock(t) {
  if (t.kind !== 'block') return;
  try {
    await api('/api/block', { id: t.id, text: t.text });
    S.state = await api('/api/state');
    renderTree();
    renderStatus();
  } catch (err) {
    status(err.message, 'err');
  }
}

async function toggleKeep(id, keep) {
  try {
    await api('/api/block', { id, keep });
    S.state = await api('/api/state');
    renderAll();
    status(`block #${id} ${keep ? 'included' : 'dropped'}`);
  } catch (err) { status(err.message, 'err'); }
}

async function save() {
  const t = activeTab();
  if (t && t.kind === 'block' && !t.readonly) await pushBlock(t);
  try {
    const r = await api('/api/save', {});
    for (const tab of S.tabs) tab.dirty = false;
    S.state = await api('/api/state');
    renderAll();
    termWrite(`$ save  -> BLOCKS.md (${r.written} blocks)`, 'ok');
    status(`saved ${r.written} blocks`);
    // "when saving also should do this": re-trace so the flow reflects the edit
    if (S.trace) await trace($('#flow-of').value, { quiet: true });
  } catch (err) {
    termWrite(err.message, 'err');
    status(err.message, 'err');
  }
}

async function build(install) {
  try {
    status(install ? 'building and installing…' : 'building…');
    termWrite(`$ ctx build --dir <workspace>${install ? ' --install' : ''}`, 'cmd');
    const r = await api('/api/build', { install });
    termWrite(r.out, r.ok ? 'ok' : 'err');
    outputWrite(r.out);
    renderProblems(r);
    S.state = await api('/api/state');
    renderAll();
    if (r.summary?.newId) $('#chat-target').textContent = `will resume: ${r.summary.newId} in ${S.state.config.cwd}`;
    status(r.ok ? `built${r.summary?.installed ? ' + installed' : ''}` : 'build failed', r.ok ? '' : 'err');
    selectPanel('problems');
  } catch (err) {
    termWrite(err.message, 'err');
    status(err.message, 'err');
  }
}

function renderProblems(r) {
  const box = $('#problems');
  const frag = document.createDocumentFragment();
  const add = (sev, text, where) => {
    const n = el('div', `prob ${sev}`);
    n.appendChild(el('span', 'sev', sev === 'err' ? '✖' : sev === 'warn' ? '▲' : '✔'));
    n.appendChild(el('span', 'txt', text));
    if (where) n.appendChild(el('span', 'where', where));
    frag.appendChild(n);
  };
  const s = r.summary || {};
  add(r.ok ? 'okk' : 'err', r.ok ? 'build succeeded' : 'build failed', s.newId || '');
  if (s.verified) add('okk', 'verify OK — chain intact, tools paired, ids unique');
  add('okk', `blocks edited ${s.edited ?? 0} · mirrors ${s.mirrors ?? 0} · tool mirrors ${s.toolMirrors ?? 0}`);
  if (s.renames) add('okk', `renames applied ${s.renames}`);
  if (s.residue) add('warn', `${s.residue} surviving copies of edited text (residue)`, 'see Output for the table');
  else add('okk', 'no residue — nothing stale survived the edit');
  if (s.installed) add('okk', 'installed', s.installed);
  for (const d of r.diff || []) {
    add('okk', `call ${d.call}: ${fmt(d.charsBefore)} → ${fmt(d.charsAfter)} ch (~${fmt(d.tokensBefore)} → ~${fmt(d.tokensAfter)} tok)`);
    for (const f of d.frames || []) add('warn', `  frame ${f.frame} ${f.change}: ${f.label}`, f.charsBefore !== undefined ? `${f.charsBefore} → ${f.charsAfter} ch` : '');
  }
  box.replaceChildren(frag);
  const n = (r.summary?.residue || 0) + (r.ok ? 0 : 1);
  $('#badge-problems').hidden = n === 0;
  $('#badge-problems').textContent = String(n);
}

/* -------------------------------------------------------------- debugger --- */

async function trace(of, { quiet = false } = {}) {
  try {
    if (!quiet) status('tracing…');
    const t = await api(`/api/flow?of=${encodeURIComponent(of)}`);
    S.trace = t;
    S.cursor = { call: 0, frame: -1 };
    renderFlowTree();
    const calls = t.calls.length;
    const frames = t.calls.reduce((a, c) => a + c.frames.length, 0);
    $('#dbg-status').textContent = `${calls} API call(s), ${frames} frames · ${t.ratio} ch/tok`;
    if (!quiet) {
      termWrite(`$ flow ${of}  -> ${calls} call(s), ${frames} frames`, 'ok');
      status(`${calls} call(s), ${frames} frames`);
    }
  } catch (err) {
    $('#dbg-status').textContent = err.message;
    status(err.message, 'err');
  }
}

function renderFlowTree() {
  const box = $('#flow-tree');
  if (!S.trace) { box.replaceChildren(); return; }
  const frag = document.createDocumentFragment();
  S.trace.calls.forEach((c, ci) => {
    const key = `c:${ci}`;
    const open = S.expanded.has(key) || ci === S.cursor.call;
    frag.appendChild(node({
      depth: 0, twisty: open ? '▾' : '▸', icon: '▶',
      label: `call ${ci}  L${c.line}`,
      meta: `~${fmt(c.totals.tokens)} tok`,
      onClick: () => { toggle(key); renderFlowTree(); },
      data: { call: ci },
    }));
    if (!open) return;
    frag.appendChild(node({
      depth: 1, icon: '∑', label: `system ${fmt(c.totals.system)} · tools ${fmt(c.totals.tools)} · convo ${fmt(c.totals.conversation)}`,
      meta: `${c.totals.frames} frames`,
    }));
    c.frames.forEach((f, fi) => {
      const bp = S.breakpoints.has(`${ci}:${fi}`);
      const cur = S.cursor.call === ci && S.cursor.frame === fi;
      const n = node({
        depth: 2, icon: frameGlyph(f.kind), iconCls: f.kind,
        label: f.label,
        meta: `${fmt(f.chars)}${f.cache ? ' ⛁' : ''}`,
        cls: `${bp ? 'bp' : ''} ${cur ? 'cur' : ''}`,
        onClick: () => jumpTo(ci, fi),
        data: { call: ci, frame: fi },
      });
      frag.appendChild(n);
    });
    for (const p of c.problems) frag.appendChild(node({ depth: 2, icon: '!', label: p, iconCls: 'tool_result' }));
  });
  box.replaceChildren(frag);
}

function frameGlyph(kind) {
  return kind === 'system' ? '⚙' : kind === 'tool' ? 'ƒ' : kind === 'tool_call' ? '→' : kind === 'tool_result' ? '↩' : '▸';
}

async function jumpTo(ci, fi) {
  S.cursor = { call: ci, frame: fi };
  const of = $('#flow-of').value;
  try {
    const f = await api(`/api/frame?of=${encodeURIComponent(of)}&call=${ci}&frame=${fi}`);
    const key = `frame:${of}:${ci}:${fi}`;
    let tab = S.tabs.find((t) => t.key === key);
    if (!tab) {
      tab = {
        key, kind: 'frame', label: `${ci}/${fi} ${f.kind}`, readonly: true,
        text: f.text || '(no text)',
        meta: `call ${ci} · ${f.path} · ${f.kind} · ${f.chars} ch · ~${f.tokens} tok${f.cache ? ' · cache breakpoint' : ''}${f.source ? ` · transcript L${f.source.line}` : ''}${f.resolved !== 'exact' ? ` · ${f.resolved}` : ''}`,
      };
      S.tabs.push(tab);
    }
    S.active = key;
    $('#st-frame').textContent = `frame ${ci}/${fi} · ${f.path}`;
    renderFrameDetail(f, ci, fi);
    renderAll();
    renderFlowTree();
  } catch (err) { status(err.message, 'err'); }
}

function renderFrameDetail(f, ci, fi) {
  const box = $('#flow-detail');
  const dl = el('dl', 'kv');
  const put = (k, v) => { dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', String(v))); };
  put('call / frame', `${ci} / ${fi}`);
  put('path', f.path);
  put('kind', f.kind);
  put('label', f.label);
  put('chars', f.chars);
  put('est tokens', f.tokens);
  put('resolved', f.resolved);
  put('cache', f.cache ? JSON.stringify(f.cache) : 'no breakpoint here');
  put('transcript line', f.source?.line ?? '—');
  const pre = el('pre', 'frame-text', (f.text || '').slice(0, 20000));
  const readers = el('div', 'readers');
  readers.id = 'frame-readers';
  box.replaceChildren(dl, readers, pre);
  if (!S.following) selectPanel('flow');
  window.brainstorm?.onFrame?.(f, ci, fi);
}

function stepFrames(dir) {
  if (!S.trace) return;
  let { call, frame } = S.cursor;
  const calls = S.trace.calls;
  frame += dir;
  while (call >= 0 && call < calls.length) {
    const n = calls[call].frames.length;
    if (frame >= n) { call++; frame = 0; continue; }
    if (frame < 0) { call--; frame = call >= 0 ? calls[call].frames.length - 1 : -1; continue; }
    jumpTo(call, frame);
    return;
  }
  status(dir > 0 ? 'end of flow' : 'start of flow');
}

function runToBreakpoint() {
  if (!S.trace) return;
  let { call, frame } = S.cursor;
  const calls = S.trace.calls;
  frame++;
  while (call < calls.length) {
    if (frame >= calls[call].frames.length) { call++; frame = 0; continue; }
    if (S.breakpoints.has(`${call}:${frame}`)) { jumpTo(call, frame); status(`breakpoint ${call}:${frame}`); return; }
    frame++;
  }
  const last = calls.length - 1;
  jumpTo(last, calls[last].frames.length - 1);
  status('no further breakpoint — flow finished');
}

/* ----------------------------------------------------------------- probe --- */

async function runProbe() {
  const needle = $('#probe-text').value;
  if (!needle) return;
  try {
    const r = await api('/api/probe', { needle, of: $('#flow-of').value, caseSensitive: $('#probe-case').checked });
    S.probeHits = r.hits;
    S.probeAt = -1;
    const box = $('#probe-hits');
    const frag = document.createDocumentFragment();
    if (!r.hits.length) frag.appendChild(el('div', 'muted pad', 'not found in any frame'));
    r.hits.forEach((h, i) => {
      frag.appendChild(node({
        depth: 0, icon: frameGlyph(h.kind), iconCls: h.kind,
        label: `call ${h.call} · ${h.path}`,
        meta: `x${h.occurrences}`,
        onClick: () => { S.probeAt = i; jumpTo(h.call, h.frame); },
      }));
      frag.appendChild(node({ depth: 1, label: h.excerpt.replace(/\s+/g, ' ').slice(0, 90), cls: 'muted' }));
    });
    box.replaceChildren(frag);
    $('#probe-status').textContent = `${r.hits.length} frame(s) · Enter steps through them`;
    termWrite(`$ probe ${JSON.stringify(needle)}  -> ${r.hits.length} frame(s)`, 'ok');
    if (r.hits.length) { S.probeAt = 0; jumpTo(r.hits[0].call, r.hits[0].frame); }
  } catch (err) { status(err.message, 'err'); }
}

function probeNext(dir) {
  if (!S.probeHits.length) return;
  S.probeAt = (S.probeAt + dir + S.probeHits.length) % S.probeHits.length;
  const h = S.probeHits[S.probeAt];
  jumpTo(h.call, h.frame);
  status(`hit ${S.probeAt + 1}/${S.probeHits.length} · ${h.path}`);
}

/* ------------------------------------------------------------- rewind/pins --- */

// askConfirm is a PROMISE, not window.confirm. A native dialog halts the
// document: a rewind prompt left the IDE unable to even reload until someone
// clicked it, and no script could drive the page past that point.
function askConfirm(text) {
  return new Promise((resolve) => {
    const bar = $('#confirmbar');
    $('#confirm-text').textContent = text;
    bar.hidden = false;
    const done = (v) => {
      bar.hidden = true;
      $('#confirm-yes').onclick = null;
      $('#confirm-no').onclick = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); done(true); }
    };
    $('#confirm-yes').onclick = () => done(true);
    $('#confirm-no').onclick = () => done(false);
    document.addEventListener('keydown', onKey, true);
  });
}

async function rewind(blockId, title) {
  const ok = await askConfirm(
    'Rewind to block #' + blockId + '?  ' + title + '  —  every block after it is '
    + 'dropped from the context. Pinned context re-homes onto a block that survives.',
  );
  if (!ok) return;
  try {
    const r = await api('/api/rewind', { blockId });
    S.state = r.state;
    renderAll();
    termWrite('$ rewind to #' + blockId + '  -> dropped ' + r.dropped.length + ' block(s)', 'ok');
    const rehomed = (r.pins || []).filter((x) => x.applied);
    if (rehomed.length) {
      termWrite('  ' + rehomed.length + ' pin(s) re-applied: '
        + rehomed.map((x) => x.label + ' -> #' + x.blockId).join(', '), 'dim');
    }
    status('rewound: ' + r.dropped.length + ' block(s) dropped');
  } catch (err) { status(err.message, 'err'); termWrite(err.message, 'err'); }
}

function renderPins() {
  const box = $('#pin-list');
  if (!box) return;
  const pins = (S.state && S.state.pins) || [];
  const frag = document.createDocumentFragment();
  if (!pins.length) frag.appendChild(el('div', 'muted pad small', 'No pins. Use + to add context that survives rewind.'));
  for (const p of pins) {
    const where = p.applied ? ('#' + p.blockApplied + (p.rehomed ? ' (re-homed)' : '')) : (p.reason || 'not applied');
    frag.appendChild(node({
      depth: 0,
      icon: p.enabled ? (p.applied ? '◉' : '◌') : '○',
      iconCls: p.applied ? 'assistant' : 'thinking',
      label: p.label,
      meta: where,
      cls: S.editingPin === p.id ? 'selected' : '',
      onClick: () => editPin(p.id),
      onAux: () => togglePin(p),
    }));
  }
  box.replaceChildren(frag);
}

function editPin(id) {
  const p = ((S.state && S.state.pins) || []).find((x) => x.id === id);
  S.editingPin = id;
  $('#pin-edit').hidden = false;
  $('#pin-label').value = p ? p.label : '';
  $('#pin-text').value = p ? p.text : '';
  $('#pin-anchor').value = p ? p.anchor : 'last-user';
  $('#pin-delete').hidden = !p;
  renderPins();
  $('#pin-text').focus();
}

async function togglePin(p) {
  try {
    const r = await api('/api/pin', { action: 'update', id: p.id, enabled: !p.enabled });
    S.state = r.state;
    renderAll();
    status('pin ' + p.label + (p.enabled ? ' disabled' : ' enabled'));
  } catch (err) { status(err.message, 'err'); }
}

async function savePin() {
  const text = $('#pin-text').value;
  const label = $('#pin-label').value.trim();
  const anchor = $('#pin-anchor').value;
  const at = activeTab();
  const blockId = anchor === 'block' && at && at.kind === 'block' ? at.id : null;
  if (anchor === 'block' && blockId === null) {
    status('open the block you want to anchor to first', 'err');
    return;
  }
  try {
    const body = S.editingPin === 'new'
      ? { action: 'add', text, label, anchor, blockId }
      : { action: 'update', id: S.editingPin, text, label, anchor, blockId };
    const r = await api('/api/pin', body);
    S.state = r.state;
    S.editingPin = null;
    $('#pin-edit').hidden = true;
    renderAll();
    const applied = (r.report || []).filter((x) => x.applied).length;
    termWrite('$ pin saved  -> ' + applied + '/' + r.pins.length + ' applied', 'ok');
    status(r.pins.length + ' pin(s), ' + applied + ' applied');
  } catch (err) { status(err.message, 'err'); termWrite(err.message, 'err'); }
}

async function deletePin() {
  if (!S.editingPin || S.editingPin === 'new') return;
  if (!await askConfirm('Delete this pin? Its text is stripped from every block.')) return;
  try {
    const r = await api('/api/pin', { action: 'remove', id: S.editingPin });
    S.state = r.state;
    S.editingPin = null;
    $('#pin-edit').hidden = true;
    renderAll();
    termWrite('$ pin removed', 'ok');
  } catch (err) { status(err.message, 'err'); }
}

/* ------------------------------------------------------------------ chat --- */

async function send() {
  const msg = $('#chat-msg').value.trim();
  if (!msg) return;
  addMsg('me', msg);
  $('#chat-msg').value = '';
  $('#btn-send').disabled = true;
  status('resuming the session…');
  try {
    const r = await api('/api/send', { message: msg });
    addMsg(`claude (${r.sessionId.slice(0, 8)})`, r.out.trim() || '(no output)');
    termWrite(`$ claude -p --resume ${r.sessionId}  -> exit ${r.code}`, r.code === 0 ? 'ok' : 'err');
    // The server re-extracts after the turn, so the new messages are already
    // editable blocks. Showing them at once is the point: every action's
    // context lands in the tree where it can be changed.
    if (r.state) {
      S.state = r.state;
      S.tabs = S.tabs.filter((t) => t.kind !== 'block');
      renderAll();
      termWrite('  context refreshed: ' + r.state.totals.blocks + ' blocks', 'dim');
    }
    status(`resume exit ${r.code}`);
    if ($('#chat-retrace').checked) await trace($('#flow-of').value);
  } catch (err) {
    addMsg('error', err.message);
    status(err.message, 'err');
  } finally {
    $('#btn-send').disabled = false;
  }
}

function addMsg(who, body) {
  const n = el('div', `msg ${who === 'me' ? 'me' : ''}`);
  n.appendChild(el('div', 'who', who));
  n.appendChild(el('div', 'body', body));
  $('#chat-log').appendChild(n);
  $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
}

/* -------------------------------------------------------------- terminal --- */
/* A real shell over pipes. Output is polled rather than pushed: a poll that
   returns nothing costs one small request, and it reconnects by itself after
   the server restarts, which a dropped socket does not. */

const history = [];
let histAt = -1;

const CLASS_FOR = { in: 'in', out: 'out', err: 'err', sys: 'sys' };

function shellRender(lines) {
  const t = $('#term');
  const atBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 40;
  for (const l of lines) {
    const prefix = l.stream === 'in' ? '> ' : '';
    t.appendChild(el('span', CLASS_FOR[l.stream] || '', prefix + l.text + '\n'));
  }
  while (t.childNodes.length > 4000) t.removeChild(t.firstChild);
  if (atBottom) t.scrollTop = t.scrollHeight;
}

function shellStatus(st) {
  if (!st || !st.shells) return;
  $('#shell-state').textContent = st.running ? (st.kind + ' · pid ' + st.pid) : 'not running';
  $('#shell-state').style.color = st.running ? '' : 'var(--red)';
  $('#shell-cwd').textContent = st.cwd || '';
  $('#shell-cwd').title = st.note || '';
  $('#term-prompt').textContent = st.kind === 'cmd' ? 'C:\\>' : st.kind === 'powershell' ? 'PS >' : '$';
  const sel = $('#shell-kind');
  if (sel.options.length !== st.shells.length) {
    sel.replaceChildren(...st.shells.map((k) => {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = k;
      return o;
    }));
  }
  sel.value = st.kind;
}

async function pollShell() {
  try {
    const r = await api('/api/shell?since=' + S.shellSeq);
    if (r.lines && r.lines.length) {
      S.shellSeq = r.lines[r.lines.length - 1].seq;
      shellRender(r.lines);
    }
    shellStatus(r);
  } catch (err) { /* server restarting: the next tick retries */ }
}

async function runCmd(cmd) {
  history.push(cmd);
  histAt = history.length;
  try {
    const r = await api('/api/shell', { action: 'write', data: cmd });
    shellStatus(r);
    await pollShell();
    // An engine verb may have changed the workspace underneath us.
    if (r.ran === 'engine') { S.state = await api('/api/state'); renderAll(); }
  } catch (err) { termWrite(err.message, 'err'); }
}

/* ------------------------------------------------------------------ live --- */
/* Jumps and calls as they happen. The watcher polls the project's transcript
   directory, so a session started in ANY terminal is seen -- this one, your own
   Windows Terminal, or an editor extension. It needs no cooperation from the
   CLI: no wrapper, no flag, no environment variable. */

function liveRender(events) {
  const box = $('#livelog');
  const follow = $('#live-follow').checked;
  for (const e of events) {
    const n = el('div', 'ev ' + e.type);
    n.appendChild(el('span', 't', (e.at || '').slice(11, 19)));
    n.appendChild(el('span', 'tag', e.type === 'session-started' ? 'session' : e.type));
    let msg = '';
    let num = '';
    if (e.type === 'jump') {
      msg = 'call ' + e.call + ' -> model' + (e.model ? ' (' + e.model + ')' : '')
        + ' · ' + e.frames + ' frames · system ' + fmt(e.system)
        + ' tools ' + fmt(e.tools) + ' convo ' + fmt(e.conversation);
      num = '~' + fmt(e.tokens) + ' tok';
    } else if (e.type === 'call') {
      msg = e.label + (e.detail ? ' — ' + e.detail : '');
      num = fmt(e.chars) + ' ch';
    } else if (e.type === 'session-started') {
      msg = e.session + ' started';
    } else if (e.type === 'grew') {
      msg = e.session + ' grew (' + e.mode + ')';
      num = fmt(e.bytes) + ' B';
    } else {
      msg = e.message || e.type;
    }
    n.appendChild(el('span', 'msg', msg));
    if (num) n.appendChild(el('span', 'num', num));
    n.addEventListener('click', () => attachLive(e));
    box.appendChild(n);
  }
  while (box.childNodes.length > 800) box.removeChild(box.firstChild);
  if (follow) box.scrollTop = box.scrollHeight;
}

async function attachLive(e) {
  if (!e.session) return;
  try {
    status('attaching to ' + e.session.slice(0, 8) + '…');
    const r = await api('/api/live', { action: 'attach', session: e.session });
    if (r.state) { S.state = r.state; renderAll(); }
    await trace('source', { quiet: true });
    if (typeof e.call === 'number') jumpTo(e.call, typeof e.frame === 'number' ? e.frame : 0);
    status('attached to ' + e.session.slice(0, 8));
  } catch (err) { status(err.message, 'err'); }
}

async function pollLive() {
  try {
    const r = await api('/api/live?since=' + S.liveSeq);
    $('#live-state').textContent = r.watching
      ? ('watching ' + (r.dir || '')).trim()
      : 'not watching — open a session first';
    if (r.events && r.events.length) {
      S.liveSeq = r.events[r.events.length - 1].seq;
      S.liveEvents = S.liveEvents.concat(r.events).slice(-800);
      liveRender(r.events);
      window.brainstorm?.onLive?.(r.events);
      if (S.panel !== 'live') {
        S.liveUnread += r.events.filter((e) => e.type === 'jump' || e.type === 'call').length;
        if (S.liveUnread) {
          $('#badge-live').hidden = false;
          $('#badge-live').textContent = String(S.liveUnread);
        }
      }
      for (const e of r.events) {
        if (e.type === 'jump') termWrite('[live] jump  call ' + e.call + '  ~' + fmt(e.tokens) + ' tok', 'dim');
        if (e.type === 'session-started') termWrite('[live] session ' + e.session.slice(0, 8) + ' started', 'dim');
      }
    }
  } catch (err) { /* retry next tick */ }
}

/* ---------------------------------------------------------------- attach --- */
/* The x64dbg shape: you run the program, the debugger attaches to it. The
   session list is the process list -- every transcript in the watched project,
   newest first, with the live ones marked. */

async function openRealTerminal(kind) {
  try {
    const r = await api('/api/console', { kind, cwd: S.state && S.state.config ? S.state.config.cwd : undefined });
    termWrite('[opened ' + r.kind + ' window in ' + r.cwd + ']', 'sys');
    status('terminal opened — run claude there, then Attach');
    await refreshSessions();
  } catch (err) { status(err.message, 'err'); termWrite(err.message, 'err'); }
}

async function loadConsoleKinds() {
  try {
    const r = await api('/api/console');
    const sel = $('#console-kind');
    sel.replaceChildren(...r.consoles.map((c) => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.label;
      o.title = c.note || '';
      return o;
    }));
    $('#console-cwd').textContent = r.cwd || '';
  } catch (err) { /* no session open yet */ }
}

const ago = (ms) => {
  if (ms < 1000) return 'now';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 48) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
};

async function refreshSessions() {
  try {
    const r = await api('/api/sessions');
    $('#attach-dir').textContent = r.dir || '';
    $('#auto-attach').checked = !!r.autoAttach;
    const box = $('#attach-list');
    const frag = document.createDocumentFragment();
    if (!r.sessions.length) {
      frag.appendChild(el('div', 'muted pad small', 'No sessions in this project yet. Open a terminal and run claude.'));
    }
    for (const sess of r.sessions) {
      const row = el('div', 'proc' + (sess.attached ? ' attached' : '') + (sess.live ? ' live' : ''));
      row.appendChild(el('span', 'dot', sess.live ? '●' : '○'));
      row.appendChild(el('span', 'pid', sess.id.slice(0, 8)));
      row.appendChild(el('span', 'msg', sess.attached ? 'attached' : (sess.live ? 'running' : 'idle')));
      row.appendChild(el('span', 'num', fmt(sess.bytes) + 'B · ' + ago(sess.idleMs)));
      const btn = el('button', 'btn sm' + (sess.attached ? '' : ' primary'), sess.attached ? 'Re-read' : 'Attach');
      btn.addEventListener('click', (e) => { e.stopPropagation(); attachSession(sess.id); });
      row.appendChild(btn);
      frag.appendChild(row);
    }
    box.replaceChildren(frag);
  } catch (err) { /* no workspace yet */ }
}

async function attachSession(id) {
  try {
    status('attaching to ' + id.slice(0, 8) + '…');
    const r = await api('/api/live', { action: 'attach', session: id });
    if (r.state) { S.state = r.state; renderAll(); }
    await trace('source', { quiet: true });
    termWrite('[attached ' + id + ']', 'sys');
    status('attached to ' + id.slice(0, 8));
    await refreshSessions();
  } catch (err) { status(err.message, 'err'); termWrite(err.message, 'err'); }
}

/* ------------------------------------------------------------- splitters --- */
/* Drag to resize. The sizes are CSS custom properties on <body>, so the grid
   stays the single source of truth and nothing is laid out by hand.
   localStorage is wrapped: it throws in a private window and must not take the
   layout down with it. */

const LIMITS = { side: [160, 760], panel: [28, 900] };

function setSize(which, px) {
  const [lo, hi] = LIMITS[which];
  const v = Math.max(lo, Math.min(hi, Math.round(px)));
  document.body.style.setProperty(which === 'side' ? '--side-w' : '--panel-h', v + 'px');
  try { localStorage.setItem('brainstorm.' + which, String(v)); } catch (err) { /* private window */ }
  return v;
}

function restoreSizes() {
  for (const which of ['side', 'panel']) {
    let v = null;
    try { v = localStorage.getItem('brainstorm.' + which); } catch (err) { v = null; }
    if (v) setSize(which, Number(v));
  }
}

function wireSplitter(id, which, axis) {
  const h = $(id);
  if (!h) return;
  h.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    h.classList.add('dragging');
    document.body.classList.add('resizing');
    const move = (ev) => {
      // 48 = activity bar, 22 = status bar. Measured from the layout, not guessed.
      if (axis === 'x') setSize(which, ev.clientX - 48);
      else setSize(which, window.innerHeight - ev.clientY - 22);
    };
    const up = () => {
      h.classList.remove('dragging');
      document.body.classList.remove('resizing');
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      renderGutter();
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
  });
  // Double-click restores the default rather than leaving a pane unusable.
  h.addEventListener('dblclick', () => setSize(which, which === 'side' ? 290 : 240));
}

/* ------------------------------------------------------------------- ui ---- */

function selectView(v) {
  S.view = v;
  for (const b of document.querySelectorAll('.act')) b.classList.toggle('selected', b.dataset.view === v);
  for (const s of document.querySelectorAll('.view')) s.hidden = s.dataset.view !== v;
  if (v === 'probe') $('#probe-text').focus();
  if (v === 'chat') $('#chat-msg').focus();
}

function selectPanel(p) {
  S.panel = p;
  if (p === 'live') { S.liveUnread = 0; $('#badge-live').hidden = true; }
  if (p === 'attach') refreshSessions();
  for (const b of document.querySelectorAll('.ptab')) b.classList.toggle('selected', b.dataset.panel === p);
  for (const s of document.querySelectorAll('.panel-body')) s.hidden = s.dataset.panel !== p;
}

document.querySelectorAll('.act').forEach((b) => b.addEventListener('click', () => selectView(b.dataset.view)));
document.querySelectorAll('.ptab').forEach((b) => b.addEventListener('click', () => selectPanel(b.dataset.panel)));

$('#shell-interrupt').addEventListener('click', async () => {
  try { shellStatus(await api('/api/shell', { action: 'interrupt' })); } catch (err) { status(err.message, 'err'); }
});
const restartShell = async (kind) => {
  try {
    const r = await api('/api/shell', { action: 'restart', kind });
    $('#term').replaceChildren();
    S.shellSeq = 0;
    shellStatus(r);
  } catch (err) { status(err.message, 'err'); }
};
$('#shell-restart').addEventListener('click', () => restartShell($('#shell-kind').value));
$('#shell-kind').addEventListener('change', (e) => restartShell(e.target.value));
$('#live-clear').addEventListener('click', () => { $('#livelog').replaceChildren(); S.liveEvents = []; });
$('#console-open').addEventListener('click', () => openRealTerminal($('#console-kind').value));
$('#attach-refresh').addEventListener('click', refreshSessions);
$('#auto-attach').addEventListener('change', async (e) => {
  try {
    await api('/api/sessions', { autoAttach: e.target.checked });
    status('auto-attach ' + (e.target.checked ? 'on' : 'off'));
  } catch (err) { status(err.message, 'err'); }
});
$('#pin-add').addEventListener('click', () => editPin('new'));
$('#pin-save').addEventListener('click', savePin);
$('#pin-cancel').addEventListener('click', () => { S.editingPin = null; $('#pin-edit').hidden = true; renderPins(); });
$('#pin-delete').addEventListener('click', deletePin);
$('#btn-refresh').addEventListener('click', loadProjects);
$('#btn-save').addEventListener('click', save);
$('#btn-build').addEventListener('click', () => build(false));
$('#btn-install').addEventListener('click', () => build(true));
$('#btn-trace').addEventListener('click', () => trace($('#flow-of').value));
$('#dbg-step').addEventListener('click', () => stepFrames(1));
$('#dbg-prev').addEventListener('click', () => stepFrames(-1));
$('#dbg-run').addEventListener('click', runToBreakpoint);
$('#dbg-restart').addEventListener('click', () => { S.cursor = { call: 0, frame: -1 }; stepFrames(1); });
$('#btn-probe').addEventListener('click', runProbe);
$('#btn-send').addEventListener('click', send);
$('#btn-panel-clear').addEventListener('click', () => {
  if (S.panel === 'terminal') $('#term').replaceChildren();
  else if (S.panel === 'output') $('#output').replaceChildren();
  else if (S.panel === 'problems') $('#problems').replaceChildren(el('div', 'muted pad', 'cleared'));
});
$('#btn-panel-toggle').addEventListener('click', () => {
  const cur = getComputedStyle(document.body).getPropertyValue('--panel-h').trim();
  document.body.style.setProperty('--panel-h', cur === '28px' ? '240px' : '28px');
});
$('#opt-wrap').addEventListener('change', (e) => {
  $('#editor').classList.toggle('wrap', e.target.checked);
  $('#gutter').classList.toggle('wrap', e.target.checked);
});
$('#btn-theme').addEventListener('click', () => {
  const r = document.documentElement;
  r.dataset.theme = r.dataset.theme === 'light' ? 'dark' : 'light';
});

$('#probe-text').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (S.probeHits.length && $('#probe-text').value) probeNext(e.shiftKey ? -1 : 1);
  else runProbe();
});

$('#term-cmd').addEventListener('keydown', (e) => {
  const inp = e.currentTarget;
  if (e.key === 'Enter') {
    const cmd = inp.value.trim();
    inp.value = '';
    if (cmd) runCmd(cmd);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (histAt > 0) inp.value = history[--histAt] || '';
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (histAt < history.length - 1) inp.value = history[++histAt] || '';
    else { histAt = history.length; inp.value = ''; }
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); build(false); return; }
  if (e.key === 'F10') { e.preventDefault(); stepFrames(1); return; }
  if (e.key === 'F5') { e.preventDefault(); runToBreakpoint(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); selectView('probe'); }
});

/* ------------------------------------------------------------------ boot --- */

(async function boot() {
  restoreSizes();
  wireSplitter('#split-side', 'side', 'x');
  wireSplitter('#split-panel', 'panel', 'y');
  termWrite('brainstorm — a real shell. Engine verbs (status, build, verify) run the bundled engine.', 'sys');
  termWrite('Start a Claude session here or in your own terminal; its jumps and calls appear in Live.', 'sys');
  termWrite('Pipes, not a PTY: full-screen TUIs will not render. claude -p "..." works.', 'dim');
  selectPanel('terminal');
  selectView('explorer');
  try {
    S.state = await api('/api/state');
    if (S.state.open) {
      S.expanded.add(`g:${S.state.groups[0]?.name}`);
      $('#chat-target').textContent = `will resume: ${S.state.config.sessionId} in ${S.state.config.cwd}`;
      termWrite(`workspace ${S.state.dir}`, 'ok');
    }
  } catch { /* nothing open yet */ }
  renderAll();
  await loadProjects();
  await pollShell();
  await pollLive();
  await loadConsoleKinds();
  await refreshSessions();
  window.brainstorm?.onBoot?.();
  const cfg = window.brainstorm?.settings || {};
  setInterval(pollShell, cfg.pollShellMs || 600);
  setInterval(pollLive, cfg.pollLiveMs || 1000);
  // Only while the Attach panel is open: a process list nobody is looking
  // at does not need rescanning every two seconds.
  setInterval(() => { if (S.panel === 'attach') refreshSessions(); }, 2000);
})();
