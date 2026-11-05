// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.

/* gate.js — the start gate. The app is blurred and inert until a session is
   chosen, because almost nothing in it means anything without one.

   You type an id, an id prefix, a folder name, or words from the first prompt;
   matches rank in that order. The same uuid can exist in two project folders
   with different contents (resuming from another cwd writes a second copy),
   so duplicates are shown as two rows with their paths -- never silently
   collapsed into whichever the scan found first. */

'use strict';

(() => {
  const B = (window.brainstorm = window.brainstorm || {});
  let rows = [];
  let rowsFor = null;   // the query the rows on screen answer
  let sel = 0;
  let timer = null;
  let seq = 0;
  let opening = false;  // an open is in flight: the card is blurred and inert
  let busyTimer = null;

  const ago = (iso) => {
    const ms = Date.now() - new Date(iso).getTime();
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  };

  const WHY = { exact: 'exact id', prefix: 'id prefix', idPart: 'in id', cwd: 'folder', prompt: 'first prompt', recent: '' };

  function show() {
    $('#gate').hidden = false;
    document.body.classList.add('gated');
    $('#gate-console').checked = (B.settings && B.settings.autoOpenConsole) ?? true;
    const q = $('#gate-q');
    q.focus();
    q.select();
    search(q.value);
  }

  function hide() {
    $('#gate').hidden = true;
    document.body.classList.remove('gated');
    closeNew();
  }

  async function search(q) {
    const mine = ++seq;
    let r;
    try {
      r = await api(`/api/find-sessions?q=${encodeURIComponent(q)}&limit=80`);
    } catch (err) {
      $('#gate-list').replaceChildren(el('div', 'gate-empty', `search failed: ${err.message}`));
      return;
    }
    if (mine !== seq) return; // a newer keystroke already answered
    $('#gate-count').textContent = `${r.total} match${r.total === 1 ? '' : 'es'}`;

    // Empty query: recent sessions first (the ones you opened here), then the rest.
    let list = r.results;
    const recentIds = new Set((r.recent || []).map((x) => x.id));
    if (!q && recentIds.size) {
      const recent = list.filter((x) => recentIds.has(x.id));
      const rest = list.filter((x) => !recentIds.has(x.id));
      list = [...recent.map((x) => ({ ...x, _sec: 'Recent' })), ...rest.map((x) => ({ ...x, _sec: 'All sessions' }))];
    }
    rows = list;
    rowsFor = q;
    sel = 0;
    render();
  }

  function render() {
    const box = $('#gate-list');
    const frag = document.createDocumentFragment();
    if (!rows.length) {
      frag.appendChild(el('div', 'gate-empty', 'No session matches. Try an id prefix, a folder name, or a word you typed in the first prompt.'));
    }
    let lastSec = null;
    rows.forEach((r, i) => {
      if (r._sec && r._sec !== lastSec) { frag.appendChild(el('div', 'gate-sec', r._sec)); lastSec = r._sec; }
      const row = el('div', `gate-row${i === sel ? ' sel' : ''}`);
      row.setAttribute('role', 'option');
      const idCell = el('div', 'id', r.id.slice(0, 8));
      row.appendChild(idCell);
      const cwd = el('div', 'cwd', r.cwd || r.project);
      if (r.duplicate) cwd.appendChild(el('span', 'dup', '  ⚠ same id in another folder'));
      row.appendChild(cwd);
      const when = el('div', 'when', `${fmt(r.bytes)}B · ${ago(r.mtime)}`);
      row.appendChild(when);
      const pr = el('div', 'prompt', '');
      if (WHY[r.why]) pr.appendChild(el('span', 'why', `${WHY[r.why]}  `));
      pr.appendChild(document.createTextNode(r.firstPrompt || '(no prompt text)'));
      row.appendChild(pr);
      row.title = r.path;
      row.addEventListener('click', () => { sel = i; choose(); });
      row.addEventListener('mouseenter', () => { sel = i; paintSel(); });
      frag.appendChild(row);
    });
    box.replaceChildren(frag);
  }

  function paintSel() {
    [...$('#gate-list').querySelectorAll('.gate-row')].forEach((n, i) => n.classList.toggle('sel', i === sel));
    const cur = $('#gate-list').querySelectorAll('.gate-row')[sel];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  async function choose() {
    if (opening) return;
    const r = rows[sel];
    if (!r) return;
    await openPath(r.path, $('#gate-console').checked);
  }

  // The loading layer over the card: a spinner, what it is doing, and for how
  // long. A big session takes seconds to extract, and with nothing on screen
  // a second click looked like the first one had been lost -- MEASURED: two
  // terminals opened for one session six seconds apart.
  function busy(title, stepText) {
    const card = $('#gate .gate-card');
    if (title === null) {
      card.classList.remove('loading');
      $('#gate-loading').hidden = true;
      clearInterval(busyTimer);
      busyTimer = null;
      return;
    }
    if (title) $('#gate-loading-title').textContent = title;
    if (stepText) $('#gate-loading-step').textContent = stepText;
    if (!busyTimer) {
      const t0 = Date.now();
      const tick = () => { $('#gate-loading-time').textContent = `${((Date.now() - t0) / 1000).toFixed(1)} s`; };
      tick();
      busyTimer = setInterval(tick, 100);
    }
    card.classList.add('loading');
    $('#gate-loading').hidden = false;
  }

  // -> 'opened' | 'empty' (no message in it yet, when the caller waits on that) | 'error' | 'busy'
  async function openPath(path, withConsole, { emptyIsWait = false } = {}) {
    if (opening) return 'busy';
    opening = true;
    const short = (String(path).match(/([0-9a-f]{8})-[0-9a-f-]{27}\.jsonl$/i) || [])[1] || '';
    busy(`Loading session ${short}`.trim(), 'extracting the transcript into blocks…');
    $('#gate-count').textContent = 'opening…';
    status('extracting…');
    try {
      const st = await api('/api/open', { session: path });
      S.state = st;
      S.tabs = [];
      S.active = null;
      S.trace = null;
      if (st.groups[0]) S.expanded.add(`g:${st.groups[0].name}`);
      // laid out behind the blur, so it is ready the moment the gate lifts
      renderAll();
      termWrite(`[opened ${st.config.sessionId} in ${st.config.cwd}]`, 'sys');
      $('#chat-target').textContent = `will resume: ${st.config.sessionId} in ${st.config.cwd}`;
      B.onSessionOpened?.(st);
      busy(`Loading session ${st.config.sessionId.slice(0, 8)}`, `${fmt(st.totals.blocks)} blocks · tracing the calls…`);
      await trace('source', { quiet: true });
      if (withConsole) {
        busy('', 'opening the terminal…');
        // the session is open either way: a terminal that cannot start (its
        // folder was deleted) is reported, and does not keep the gate up
        try {
          const w = await api('/api/window', { action: 'open' });
          termWrite(w.reused
            ? `[terminal window ${w.tag} is already running claude on ${w.sessionId}: attached to it]`
            : `[terminal window ${w.tag}: claude --resume ${w.sessionId}${w.live ? ' · live hooks on' : ''}]`, 'sys');
          status(w.reused ? `opened · attached to terminal ${w.tag}` : `opened · terminal ${w.tag} running claude --resume`);
        } catch (err) {
          termWrite(`[no terminal: ${err.message}]`, 'err');
          status(`opened, but no terminal: ${err.message}`, 'err');
        }
      } else {
        status(`opened ${st.config.sessionId.slice(0, 8)} · ${st.totals.blocks} blocks`);
      }
      hide();
      return 'opened';
    } catch (err) {
      // claude has created the file but not written a message into it yet
      if (emptyIsWait && /no conversation records/.test(err.message)) { status('waiting for the first message…'); return 'empty'; }
      $('#gate-count').textContent = '';
      $('#gate-list').prepend(el('div', 'gate-empty', `could not open: ${err.message}`));
      status(err.message, 'err');
      return 'error';
    } finally {
      opening = false;
      busy(null);
    }
  }

  // A window that attaches to a server which already has a session open --
  // brainstorm was closed and opened again while the server lived on -- never
  // passed through the gate, so nothing opened the terminal. Ask the server to
  // make sure there is one: it adopts a claude still running this session, and
  // opens one only if the settings say a session gets a terminal.
  //
  // ⛔ Only the app's OWN window asks (the exe opens it with ?app=1). Any page
  // used to: MEASURED, a headless test page loading on a server with a session
  // open popped a real terminal running claude --resume on that session.
  const IS_APP_WINDOW = new URLSearchParams(location.search).has('app');

  async function ensureConsole() {
    try {
      const w = await api('/api/window', { action: 'ensure' });
      if (w.reused) termWrite(`[terminal window ${w.tag} is running claude on ${w.sessionId}: attached to it]`, 'sys');
      else if (w.opened) {
        termWrite(`[terminal window ${w.tag}: claude --resume ${w.sessionId}${w.live ? ' · live hooks on' : ''}]`, 'sys');
        status(`terminal ${w.tag} running claude --resume`);
      }
    } catch (err) {
      status(`terminal: ${err.message}`, 'err');
    }
  }

  $('#gate-q').addEventListener('input', (e) => {
    clearTimeout(timer);
    const v = e.target.value;
    timer = setTimeout(() => search(v), 120);
  });

  $('#gate-q').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(rows.length - 1, sel + 1); paintSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paintSel(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (opening) return;
      // ⛔ Search waits 120 ms after the last keystroke. Pressing Enter inside
      // that window used to open the selected row of the PREVIOUS list --
      // MEASURED: typing one session's id and pressing Enter opened another,
      // the top "Recent" row of the empty-query list. Enter acts on results for what
      // is in the box now: if those are not on screen yet, search first.
      const q = e.target.value;
      if (rowsFor !== q.trim().toLowerCase() && rowsFor !== q) {
        clearTimeout(timer);
        // and only if that search actually answered: a failed one leaves the
        // old rows up, which are exactly the wrong thing to open
        search(q).then(() => { if (rowsFor === q) choose(); });
      } else {
        choose();
      }
    }
    else if (e.key === 'Escape') { e.preventDefault(); if (!opening) hide(); }
  });

  // --- Reload list, Create session -------------------------------------------
  // Create session starts a NEW claude in a terminal, with an id the server
  // chose. claude writes the transcript with the first message, so the gate
  // waits for that id to appear and then opens it -- which adopts the
  // terminal, because that window's claude is running exactly that id.
  let newWait = null;   // { sessionId, timer, tick }

  function openNew() {
    $('#gate-new').hidden = false;
    $('#gate-new-err').hidden = true;
    // the folders claude has been used in, from the list on screen
    const dirs = [...new Set(rows.map((r) => r.cwd).filter(Boolean))];
    $('#gate-new-dirs').replaceChildren(...dirs.map((d) => { const o = document.createElement('option'); o.value = d; return o; }));
    const inp = $('#gate-new-cwd');
    if (!inp.value && dirs[0]) inp.value = dirs[0];
    inp.focus();
    inp.select();
  }

  function stopWaiting() {
    if (newWait) { clearInterval(newWait.timer); clearInterval(newWait.tick); newWait = null; }
    $('#gate-new-wait').hidden = true;
    $('#gate-new-start').disabled = false;
  }

  function closeNew() {
    stopWaiting();
    $('#gate-new').hidden = true;
  }

  async function startNew() {
    if (newWait || opening) return;
    const cwd = $('#gate-new-cwd').value.trim();
    $('#gate-new-err').hidden = true;
    $('#gate-new-start').disabled = true;
    let r;
    try {
      r = await api('/api/create-session', { cwd });
    } catch (err) {
      r = { ok: false, error: err.message };
    }
    if (!r.ok) {
      $('#gate-new-err').textContent = r.error;
      $('#gate-new-err').hidden = false;
      $('#gate-new-start').disabled = false;
      return;
    }
    termWrite(`[terminal window ${r.tag}: new claude session ${r.sessionId} in ${r.cwd}${r.live ? ' · live hooks on' : ''}]`, 'sys');
    $('#gate-new-msg').textContent = `claude is starting in a new terminal in ${r.cwd}. Type your first message there: the session opens here as soon as claude saves it.`;
    $('#gate-new-wait').hidden = false;
    const t0 = Date.now();
    const w = { sessionId: r.sessionId };
    newWait = w;
    const tick = () => { $('#gate-new-time').textContent = `waiting ${Math.round((Date.now() - t0) / 1000)} s · session ${r.sessionId.slice(0, 8)}`; };
    tick();
    w.tick = setInterval(tick, 1000);
    // ⛔ claude creates the file BEFORE your first message is in it. Opening it
    // then failed ("no conversation records") and the gate had already stopped
    // waiting -- MEASURED replaying a real transcript on its own timeline. So
    // the file appearing is not enough: wait until it holds a message.
    w.timer = setInterval(async () => {
      if (w.busy) return;
      let f;
      try { f = await api(`/api/find-sessions?q=${encodeURIComponent(w.sessionId)}&limit=5`); } catch { return; }
      const hit = (f.results || []).find((x) => x.id === w.sessionId);
      if (!hit || newWait !== w) return;
      const firstMsg = () => { $('#gate-new-msg').textContent = 'claude has started the session. Type your first message in its terminal: the session opens here as soon as claude saves it.'; };
      // the list reads only the first 64 KB of a file: one bigger than that may
      // hold its message further on, so it is TRIED -- and a refusal for having
      // no message yet means keep waiting, never stop (MEASURED: a real session
      // with its first message at byte 157,681)
      if (!hit.hasMessage && hit.bytes <= 65536) { firstMsg(); return; }
      w.busy = true;
      const how = await openPath(hit.path, true, { emptyIsWait: true });
      w.busy = false;
      if (how === 'empty') { firstMsg(); return; }
      if (how !== 'opened') closeNew();   // an error: openPath shows it in the list
    }, 1500);
  }

  $('#gate-reload').addEventListener('click', () => {
    $('#gate-count').textContent = 'reloading…';
    search($('#gate-q').value);
  });
  $('#gate-create').addEventListener('click', openNew);
  $('#gate-new-start').addEventListener('click', startNew);
  $('#gate-new-cancel').addEventListener('click', closeNew);
  $('#gate-new-cwd').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); startNew(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeNew(); $('#gate-q').focus(); }
  });

  $('#btn-gate').addEventListener('click', show);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); show(); }
  });

  B.openGate = show;
  B.closeGate = hide;
  B.openSessionPath = openPath;

  const prevBoot = B.onBoot;
  B.onBoot = () => {
    prevBoot?.();
    if (!S.state || !S.state.open) show();
    else if (IS_APP_WINDOW) ensureConsole();
  };
})();
