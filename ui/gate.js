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
  let sel = 0;
  let timer = null;
  let seq = 0;

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
    const r = rows[sel];
    if (!r) return;
    await openPath(r.path, $('#gate-console').checked);
  }

  async function openPath(path, withConsole) {
    $('#gate-count').textContent = 'opening…';
    status('extracting…');
    try {
      const st = await api('/api/open', { session: path });
      S.state = st;
      S.tabs = [];
      S.active = null;
      S.trace = null;
      if (st.groups[0]) S.expanded.add(`g:${st.groups[0].name}`);
      hide();
      renderAll();
      termWrite(`[opened ${st.config.sessionId} in ${st.config.cwd}]`, 'sys');
      $('#chat-target').textContent = `will resume: ${st.config.sessionId} in ${st.config.cwd}`;
      B.onSessionOpened?.(st);
      await trace('source', { quiet: true });
      if (withConsole) {
        const w = await api('/api/window', { action: 'open' });
        termWrite(`[terminal window ${w.tag}: claude --resume ${w.sessionId}]`, 'sys');
        status(`opened · terminal ${w.tag} running claude --resume`);
      } else {
        status(`opened ${st.config.sessionId.slice(0, 8)} · ${st.totals.blocks} blocks`);
      }
    } catch (err) {
      $('#gate-count').textContent = '';
      $('#gate-list').prepend(el('div', 'gate-empty', `could not open: ${err.message}`));
      status(err.message, 'err');
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
    else if (e.key === 'Enter') { e.preventDefault(); choose(); }
    else if (e.key === 'Escape') { e.preventDefault(); hide(); }
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
  };
})();
