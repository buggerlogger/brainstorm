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
};

/* ------------------------------------------------------------------ api --- */

async function api(path, body) {
  const opt = body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(path, opt);
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

function node({ depth = 0, twisty = '', icon = '', iconCls = '', label, meta = '', cls = '', onClick, onAux, onMenu }) {
  const n = el('div', `node d${depth} ${cls}`);
  n.appendChild(el('span', 'tw', twisty));
  if (icon) n.appendChild(el('span', `ico ${iconCls}`, icon));
  n.appendChild(el('span', 'lbl', label));
  if (meta !== '') n.appendChild(el('span', 'meta', meta));
  if (onClick) n.addEventListener('click', onClick);
  if (onMenu) {
    n.title = 'right-click: rewind to here';
    n.addEventListener('contextmenu', (e) => { e.preventDefault(); onMenu(); });
  }
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
          onMenu: () => rewind(b.id, b.title),
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
      });
      n.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const k = `${ci}:${fi}`;
        if (S.breakpoints.has(k)) S.breakpoints.delete(k); else S.breakpoints.add(k);
        renderFlowTree();
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
  box.replaceChildren(dl, pre);
  selectPanel('flow');
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

const history = [];
let histAt = -1;

async function runCmd(cmd) {
  termWrite(`$ ${cmd}`, 'cmd');
  history.push(cmd);
  histAt = history.length;
  try {
    const r = await api('/api/terminal', { cmd });
    if (r.out) termWrite(r.out, r.code === 0 ? '' : 'err');
    if (r.code !== 0) status(`exit ${r.code}`, 'err');
    S.state = await api('/api/state');
    renderAll();
  } catch (err) { termWrite(err.message, 'err'); }
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
  for (const b of document.querySelectorAll('.ptab')) b.classList.toggle('selected', b.dataset.panel === p);
  for (const s of document.querySelectorAll('.panel-body')) s.hidden = s.dataset.panel !== p;
}

document.querySelectorAll('.act').forEach((b) => b.addEventListener('click', () => selectView(b.dataset.view)));
document.querySelectorAll('.ptab').forEach((b) => b.addEventListener('click', () => selectPanel(b.dataset.panel)));

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
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); build(false); return; }
  if (e.key === 'F10') { e.preventDefault(); stepFrames(1); return; }
  if (e.key === 'F5') { e.preventDefault(); runToBreakpoint(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); selectView('probe'); }
});

/* ------------------------------------------------------------------ boot --- */

(async function boot() {
  termWrite('brainstorm IDE — the terminal runs the engine, not a shell.', 'dim');
  termWrite('try: status · build --install · verify --file built.jsonl · help', 'dim');
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
})();
