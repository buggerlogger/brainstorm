// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.

/* panels.js — settings, agents, search for strings, who-read-it, export,
   Save & Resume, and the app heartbeat. */

'use strict';

(() => {
  const B = (window.brainstorm = window.brainstorm || {});
  B.settings = B.settings || null;

  /* ------------------------------------------------------------- presence --- */
  // The window holds one connection open to the server for as long as it is
  // open. That -- not a timer -- is how the server knows a window exists: a
  // timer heartbeat got throttled to once a minute in a background window, the
  // server took the silence for a closed window and exited under it.
  //
  // EventSource reconnects by itself. If it cannot, the server is gone, and
  // the page says so instead of answering every search with "no matches".
  let offlineTimer = null;
  function setOffline(off) {
    const b = $('#offline');
    if (!b) return;
    if (off) {
      if (offlineTimer || !b.hidden) return;
      // a reload or a brief blip reconnects within a second or two
      offlineTimer = setTimeout(() => { b.hidden = false; offlineTimer = null; }, 2500);
    } else {
      clearTimeout(offlineTimer);
      offlineTimer = null;
      b.hidden = true;
    }
  }
  const presence = new EventSource('/api/presence');
  presence.addEventListener('hello', () => setOffline(false));
  presence.addEventListener('error', () => setOffline(true));
  B.offline = () => setOffline(true);
  B.online = () => setOffline(false);

  /* ------------------------------------------------------------- settings --- */

  function applySettings(s) {
    if (!s) return;
    document.documentElement.dataset.theme = s.theme === 'light' ? 'light' : 'dark';
    const px = `${s.fontSize || 12}px`;
    $('#editor').style.fontSize = px;
    $('#gutter').style.fontSize = px;
    $('#opt-wrap').checked = !!s.wrap;
    $('#editor').classList.toggle('wrap', !!s.wrap);
    $('#gutter').classList.toggle('wrap', !!s.wrap);
  }

  async function loadSettings() {
    try {
      const r = await api('/api/settings');
      B.settings = r.settings;
      B.schema = r.schema;
      $('#settings-file').textContent = r.file;
      applySettings(r.settings);
      renderSettings();
    } catch (err) { status(`settings: ${err.message}`, 'err'); }
  }

  function renderSettings() {
    const box = $('#settings-form');
    if (!B.schema) return;
    const frag = document.createDocumentFragment();
    let group = null;
    for (const spec of B.schema) {
      if (spec.group !== group) { frag.appendChild(el('div', 'grp', spec.group)); group = spec.group; }
      const v = B.settings[spec.key];
      const opt = el('div', 'opt');
      const lab = el('label');
      let input;
      if (spec.type === 'bool') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!v;
        lab.appendChild(input);
        lab.appendChild(el('span', 'lbl', spec.label));
        opt.appendChild(lab);
      } else {
        lab.appendChild(el('span', 'lbl', spec.label));
        opt.appendChild(lab);
        if (spec.type === 'enum') {
          input = document.createElement('select');
          for (const o of spec.options) {
            const op = document.createElement('option');
            op.value = o;
            op.textContent = o;
            input.appendChild(op);
          }
          input.value = v;
        } else {
          input = document.createElement('input');
          input.type = spec.type === 'int' ? 'number' : 'text';
          if (spec.type === 'int') { input.min = spec.min; input.max = spec.max; }
          input.value = v ?? '';
        }
        input.className = 'input';
        opt.appendChild(input);
      }
      input.dataset.key = spec.key;
      input.dataset.type = spec.type;
      if (spec.help) opt.appendChild(el('div', 'help', spec.help));
      frag.appendChild(opt);
    }
    box.replaceChildren(frag);
  }

  async function saveSettingsForm() {
    const patch = {};
    for (const inp of $('#settings-form').querySelectorAll('[data-key]')) {
      const t = inp.dataset.type;
      patch[inp.dataset.key] = t === 'bool' ? inp.checked : t === 'int' ? Number(inp.value) : inp.value;
    }
    try {
      const r = await api('/api/settings', patch);
      B.settings = r.settings;
      applySettings(r.settings);
      renderSettings();
      if (S.following !== !!r.settings.follow) B.setFollow?.(!!r.settings.follow, false);
      status('settings saved');
    } catch (err) { status(err.message, 'err'); }
  }

  $('#settings-save').addEventListener('click', saveSettingsForm);
  $('#btn-theme').addEventListener('click', () => {
    // app.js flips the attribute; persist what it flipped to.
    setTimeout(() => api('/api/settings', { theme: document.documentElement.dataset.theme })
      .then((r) => { B.settings = r.settings; renderSettings(); }).catch(() => {}), 0);
  });

  /* --------------------------------------------------------------- agents --- */

  function ensureFlowOption(value, label) {
    const sel = $('#flow-of');
    let o = [...sel.options].find((x) => x.value === value);
    if (!o) {
      o = document.createElement('option');
      o.value = value;
      sel.appendChild(o);
    }
    o.textContent = label;
    return o;
  }

  async function refreshAgents() {
    const box = $('#agent-list');
    if (!S.state?.open) { box.replaceChildren(el('div', 'muted pad small', 'Open a session first.')); return; }
    try {
      const r = await api('/api/agents');
      const frag = document.createDocumentFragment();
      // drop stale agent options from a previous session
      for (const o of [...$('#flow-of').options]) if (o.value.startsWith('agent:')) o.remove();
      r.agents.forEach((a, i) => {
        const isMain = a.id === 'main';
        const meta = a.calls == null ? '' : `${a.calls} call${a.calls === 1 ? '' : 's'}`;
        const detail = isMain ? '' : [
          a.kind,
          a.spawnLine ? `spawned at L${a.spawnLine}` : null,
          a.inheritsThroughLine ? `inherits parent ≤ L${a.inheritsThroughLine}` : null,
        ].filter(Boolean).join(' · ');
        frag.appendChild(node({
          depth: isMain ? 0 : 1,
          icon: isMain ? '◉' : (a.kind === 'fork' ? '⑂' : '◎'),
          iconCls: isMain ? 'user' : 'system',
          label: isMain ? 'main agent' : a.label,
          meta,
          onClick: () => openAgentFlow(a),
        }));
        if (detail) frag.appendChild(node({ depth: 2, label: detail, cls: 'muted' }));
        if (!isMain) ensureFlowOption(`agent:${a.id}`, `↳ ${a.label.slice(0, 40)}`);
        if (i === 0 && r.agents.length === 1) frag.appendChild(el('div', 'muted pad small', 'No subagents in this session.'));
      });
      box.replaceChildren(frag);
    } catch (err) { box.replaceChildren(el('div', 'muted pad small', err.message)); }
  }

  async function openAgentFlow(a) {
    const value = a.id === 'main' ? 'source' : `agent:${a.id}`;
    if (a.id !== 'main') ensureFlowOption(value, `↳ ${a.label.slice(0, 40)}`);
    $('#flow-of').value = value;
    // the debugger view is gone (Recording is the debugger): the flow opens in
    // the Flow panel at its first frame, and F10 / F5 step through it
    await trace(value);
    if (S.trace?.calls?.length) jumpTo(0, 0);
    selectPanel('flow');
    status(`${a.id === 'main' ? 'main agent' : a.label}: ${S.trace?.calls.length ?? 0} call(s)`);
  }

  $('#agents-refresh').addEventListener('click', refreshAgents);

  /* ------------------------------------------------------- who read it? --- */

  async function showReaders({ blockId = null, text = null, line = null } = {}) {
    const body = blockId != null ? { blockId } : { text, line };
    let r;
    try { r = await api('/api/readers', body); } catch (err) { status(err.message, 'err'); return; }
    let box = $('#frame-readers');
    if (!box) {
      box = el('div', 'readers');
      box.id = 'frame-readers';
      $('#flow-detail').replaceChildren(box);
    }
    renderReaders(box, r);
    selectPanel('flow');
  }

  function renderReaders(box, r) {
    const frag = document.createDocumentFragment();
    frag.appendChild(el('h4', '', 'read by'));
    if (r.note) frag.appendChild(el('div', 'muted small', r.note));
    if (!r.readers.length && !r.note) frag.appendChild(el('div', 'muted small', 'No agent had this text in context.'));
    for (const rd of r.readers) {
      const row = el('div', 'reader');
      row.appendChild(el('span', 'who', rd.agent === 'main' ? 'main agent' : rd.label));
      if (rd.error) { row.appendChild(el('span', 'calls', rd.error)); frag.appendChild(row); continue; }
      const calls = el('span', 'calls');
      const shown = rd.calls.slice(0, 24);
      shown.forEach((ci, k) => {
        const a = el('a', '', `call ${ci}`);
        a.title = 'jump to the first frame of this call that contains the text';
        a.addEventListener('click', () => jumpToReader(rd, ci, r.needle));
        calls.appendChild(a);
        if (k < shown.length - 1) calls.appendChild(document.createTextNode(', '));
      });
      if (rd.calls.length > shown.length) calls.appendChild(document.createTextNode(` … +${rd.calls.length - shown.length}`));
      if (!rd.calls.length) calls.appendChild(document.createTextNode('—'));
      row.appendChild(calls);
      if (rd.inherited) row.appendChild(el('span', 'tag', 'inherited from the parent (fork)'));
      if (rd.mode === 'reconstructed') row.appendChild(el('span', 'tag', 'reconstructed'));
      frag.appendChild(row);
    }
    box.replaceChildren(frag);
  }

  async function jumpToReader(rd, ci, needle) {
    const value = rd.agent === 'main' ? 'source' : `agent:${rd.agent}`;
    if (rd.agent !== 'main') ensureFlowOption(value, `↳ ${rd.label.slice(0, 40)}`);
    $('#flow-of').value = value;
    await trace(value, { quiet: true });
    try {
      const p = await api('/api/probe', { needle, of: value });
      const hit = p.hits.find((h) => h.call === ci) || p.hits[0];
      if (hit) { S.expanded.add(`c:${hit.call}`); jumpTo(hit.call, hit.frame); return; }
    } catch { /* fall through */ }
    jumpTo(ci, 0);
  }

  // Every frame opened in the debugger shows who else read it.
  const prevFrame = B.onFrame;
  B.onFrame = (f, ci, fi) => {
    prevFrame?.(f, ci, fi);
    const box = $('#frame-readers');
    if (!box || !f.text || f.text.length < 12) return;
    box.replaceChildren(el('div', 'muted small', 'finding who read this…'));
    api('/api/readers', { text: f.text, line: f.source?.line ?? null })
      .then((r) => { if ($('#frame-readers') === box) renderReaders(box, r); })
      .catch((err) => { box.replaceChildren(el('div', 'muted small', err.message)); });
  };

  /* ------------------------------------------------- search for strings --- */

  let lastStrings = null;

  function searchStrings(q, scope) {
    selectPanel('strings');
    if (scope) $('#strings-scope').value = scope;
    const inp = $('#strings-q');
    if (typeof q === 'string') inp.value = q;
    inp.focus();
    inp.select();
    if (inp.value) runStrings();
  }

  function highlight(ex, q, isRegex, cs) {
    const frag = document.createDocumentFragment();
    if (isRegex || !q) { frag.appendChild(document.createTextNode(ex)); return frag; }
    const hay = cs ? ex : ex.toLowerCase();
    const n = cs ? q : q.toLowerCase();
    let i = 0;
    for (;;) {
      const at = hay.indexOf(n, i);
      if (at < 0) { frag.appendChild(document.createTextNode(ex.slice(i))); break; }
      frag.appendChild(document.createTextNode(ex.slice(i, at)));
      frag.appendChild(el('mark', '', ex.slice(at, at + n.length)));
      i = at + n.length;
    }
    return frag;
  }

  async function runStrings() {
    const query = $('#strings-q').value;
    if (!query) return;
    const scope = $('#strings-scope').value;
    const caseSensitive = $('#strings-case').checked;
    const regex = $('#strings-regex').checked;
    $('#strings-status').textContent = 'searching…';
    try {
      const r = await api('/api/strings', { query, scope, caseSensitive, regex, limit: 2000 });
      lastStrings = r;
      const box = $('#strings-results');
      const frag = document.createDocumentFragment();
      for (const h of r.hits) {
        const row = el('div', 'srow');
        row.appendChild(el('span', 'ag', h.agent === 'main' ? (h.where === 'block' ? 'block (editable)' : 'main agent') : h.agentLabel));
        row.appendChild(el('span', 'loc', h.where === 'block' ? `#${h.blockId} L${h.line} ${h.kind}` : `call ${h.call} · ${h.path}`));
        row.appendChild(el('span', 'n', `×${h.occurrences}`));
        const ex = el('span', 'ex');
        ex.appendChild(highlight(h.excerpt, query, regex, caseSensitive));
        row.appendChild(ex);
        row.addEventListener('click', () => openHit(h));
        frag.appendChild(row);
      }
      if (!r.hits.length) frag.appendChild(el('div', 'muted pad small', 'not found'));
      box.replaceChildren(frag);
      $('#strings-status').textContent = `${r.hits.length}${r.truncated ? '+ (truncated)' : ''} hit(s)`;
    } catch (err) {
      $('#strings-status').textContent = err.message;
    }
  }

  // Open a hit AT the hit. Three things used to defeat that: the editor opened
  // at line 1; a frame hit re-traced the whole session first (seconds, on a big
  // one); and jumping switched the bottom panel to Flow, so the results list
  // you were clicking through vanished.
  async function openHit(h) {
    const q = $('#strings-q').value;
    const opts = { caseSensitive: $('#strings-case').checked, regex: $('#strings-regex').checked };
    if (h.where === 'block') {
      await openBlock(h.blockId);
    } else {
      const value = h.agent === 'main' ? 'source' : `agent:${h.agent}`;
      if (h.agent !== 'main') ensureFlowOption(value, `↳ ${String(h.agentLabel).slice(0, 40)}`);
      if ($('#flow-of').value !== value) {
        $('#flow-of').value = value;
        S.trace = null;          // the tree belongs to the other source; do not show it as this one
      }
      S.expanded.add(`c:${h.call}`);
      const f = await jumpTo(h.call, h.frame, { keepPanel: true });
      if (!f) return;
    }
    if (!revealInEditor(q, opts)) status('opened; the match is not in the visible text (it may be past the shown part)');
    else status(`${h.where === 'block' ? `block #${h.blockId}` : `call ${h.call} · ${h.path}`} — match selected`);
  }

  $('#strings-go').addEventListener('click', runStrings);
  $('#strings-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runStrings(); } });

  /* ---------------------------------------------------------- probe text --- */

  function probeText(text) {
    const t = String(text || '').trim();
    if (!t) return;
    selectView('probe');
    // A long needle is still exact; it just should not be the whole block.
    $('#probe-text').value = t.length > 160 ? t.slice(0, 160) : t;
    runProbe();
  }

  /* --------------------------------------------------------------- export --- */

  async function exportContext({ format = 'folder', folder = null } = {}) {
    status(`exporting${folder ? ` "${folder}"` : ''}…`);
    try {
      const r = await api('/api/export', { format, folder });
      termWrite(`[export ${r.format}] ${r.files} files -> ${r.path}`, 'sys');
      status(`exported ${r.files} files`);
    } catch (err) { status(err.message, 'err'); termWrite(err.message, 'err'); }
  }

  /* ---------------------------------------------------------- save+resume --- */

  async function saveResume() {
    if (!S.state?.open) return;
    // flush the active editor first, exactly as Save does
    const t = activeTab();
    if (t && t.kind === 'block' && !t.readonly) await api('/api/block', { id: t.id, text: t.text });
    // the same warning as Save: Save & Resume saves an edited message too, and
    // a rewind in the resumed claude would delete it
    const mainTab = S.tabs.find((x) => x.kind === 'main' && x.dirty);
    if (mainTab) await saveMain(mainTab);
    try { S.state = await api('/api/state'); } catch { /* the call below reports it */ }
    const risky = rewindRisk();
    if (risky.length) {
      const choice = await rewindWarning(risky);
      if (choice === 'cancel') { status('not saved — nothing was resumed'); return; }
      if (choice === 'main') await moveToMain(risky);
    }
    status('saving, building, installing…');
    termWrite('$ save & resume', 'cmd');
    try {
      const r = await api('/api/save-resume', {});
      if (!r.ok) {
        termWrite(r.out || 'build failed', 'err');
        renderProblems({ ok: false, summary: r.summary || {}, out: r.out, diff: [] });
        selectPanel('problems');
        status('build failed — nothing was resumed', 'err');
        return;
      }
      for (const tab of S.tabs) tab.dirty = false;
      S.tabs = S.tabs.filter((x) => x.kind !== 'block');
      S.state = r.state;
      const mt = S.tabs.find((x) => x.kind === 'main');
      if (mt && r.state?.main) mt.meta = mainMeta(r.state.main);
      renderAll();
      renderProblems({ ok: true, summary: r.summary, out: r.out, diff: [] });
      const w = r.window;
      if (w) {
        const how = w.reused ? `restarted claude in window ${w.tag} (same window)` : `opened window ${w.tag}`;
        termWrite(`[resume] ${how} on ${r.summary.newId}`, 'ok');
        status(`resumed ${r.summary.newId.slice(0, 8)} — ${how}`);
      } else {
        termWrite(`[built] ${r.summary.newId} (resumeOnSave is off)`, 'ok');
        status(`built ${r.summary.newId.slice(0, 8)}`);
      }
      await refreshAgents();
      await trace('source', { quiet: true });
    } catch (err) {
      status(err.message, 'err');
      termWrite(err.message, 'err');
    }
  }

  $('#btn-save-resume').addEventListener('click', saveResume);
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveResume(); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); searchStrings(); }
    else if (e.key === 'F9' && S.cursor && S.cursor.frame >= 0) {
      e.preventDefault();
      const k = `${S.cursor.call}:${S.cursor.frame}`;
      if (S.breakpoints.has(k)) S.breakpoints.delete(k); else S.breakpoints.add(k);
      renderFlowTree();
    }
  });

  /* ---------------------------------------------------------------- hooks --- */

  const prevOpened = B.onSessionOpened;
  B.onSessionOpened = (st) => {
    prevOpened?.(st);
    refreshAgents();
  };

  const prevBoot = B.onBoot;
  B.onBoot = () => {
    prevBoot?.();
    if (S.state?.open) { refreshAgents(); if (B.settings?.follow) B.setFollow?.(true, false); }
  };

  // Refresh the agent list whenever its view is opened.
  document.querySelectorAll('.act[data-view="agents"]').forEach((b) => b.addEventListener('click', refreshAgents));
  document.querySelectorAll('.act[data-view="settings"]').forEach((b) => b.addEventListener('click', renderSettings));

  B.showReaders = showReaders;
  B.searchStrings = searchStrings;
  B.probeText = probeText;
  B.exportContext = exportContext;
  B.saveResume = saveResume;
  B.refreshAgents = refreshAgents;

  loadSettings();
})();
