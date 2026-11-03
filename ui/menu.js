// Copyright (c) 2026 buggerlogger. All rights reserved.
// Proprietary and confidential. No license is granted to use, copy, modify or
// distribute this file, in whole or in part. See LICENSE.

/* menu.js — one right-click menu for the whole app.

   Every tree node says what it is through data-* attributes (data-block-id,
   data-folder, data-call/data-frame, data-session-path), and this file decides
   what can be done to it. Before this, two nodes each carried their own
   contextmenu handler -- rewind on blocks, breakpoint on frames -- which meant
   right-click did something different and invisible in each place, and
   nothing at all everywhere else. */

'use strict';

(() => {
  const B = (window.brainstorm = window.brainstorm || {});
  const box = () => $('#ctxmenu');
  let items = [];
  let sel = -1;

  function close() {
    box().hidden = true;
    items = [];
    sel = -1;
  }

  function open(x, y, list) {
    items = list.filter(Boolean);
    const m = box();
    m.replaceChildren();
    items.forEach((it, i) => {
      if (it.sep) { m.appendChild(el('div', 'sep')); return; }
      if (it.header) { m.appendChild(el('div', 'hd', it.header)); return; }
      const row = el('div', `mi${it.disabled ? ' off' : ''}`);
      row.setAttribute('role', 'menuitem');
      row.appendChild(el('span', 'ic', it.icon || ''));
      row.appendChild(el('span', 'lb', it.label));
      if (it.key) row.appendChild(el('span', 'k', it.key));
      row.addEventListener('click', (e) => { e.stopPropagation(); run(i); });
      row.addEventListener('mouseenter', () => highlight(i));
      it.row = row;
      m.appendChild(row);
    });
    m.hidden = false;
    // Keep it on screen: flip left/up when it would overflow the window.
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
    m.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  }

  function highlight(i) {
    items.forEach((it, k) => it.row && it.row.classList.toggle('sel', k === i));
    sel = i;
  }

  async function run(i) {
    const it = items[i];
    if (!it || it.disabled || !it.action) return;
    close();
    try { await it.action(); } catch (err) { status(err.message, 'err'); termWrite(err.message, 'err'); }
  }

  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      status(`copied ${text.length} chars`);
    } catch {
      status('clipboard not available', 'err');
    }
  };

  async function blockText(id) {
    const b = await api(`/api/block?id=${id}`);
    return b;
  }

  // --- menus per target ------------------------------------------------------

  function forBlock(node) {
    const id = Number(node.dataset.blockId);
    const folder = node.dataset.folder;
    const meta = S.state?.groups.flatMap((g) => g.blocks).find((b) => b.id === id);
    const kept = meta ? meta.keep : true;
    return [
      { header: `block #${id}${meta ? ` · ${meta.kind} · ${fmt(meta.chars)} ch` : ''}` },
      { icon: '↗', label: 'Open', action: () => openBlock(id) },
      { icon: '⌕', label: 'Where does it load in context?', action: async () => {
        const b = await blockText(id);
        B.probeText(b.text);
      } },
      { icon: '◎', label: 'Who read it?', key: 'agents', action: () => B.showReaders({ blockId: id }) },
      { icon: '≣', label: 'Search in strings…', action: async () => {
        const b = await blockText(id);
        B.searchStrings(firstLine(b.text));
      } },
      { sep: true },
      { icon: '⧉', label: 'Copy text', action: async () => copy((await blockText(id)).text) },
      { icon: '⊕', label: 'Pin a copy (survives rewind)', action: async () => {
        const b = await blockText(id);
        const r = await api('/api/pin', { action: 'add', text: b.text, anchor: 'block', blockId: id, label: `copy of #${id}` });
        S.state = r.state;
        renderAll();
        status('pinned');
      } },
      { icon: kept ? '◌' : '◉', label: kept ? 'Drop from context' : 'Restore to context', action: () => toggleKeep(id, !kept) },
      { icon: '⏮', label: 'Rewind to here…', action: () => rewind(id, meta ? meta.title : `#${id}`) },
      { sep: true },
      { icon: '🗀', label: `Export "${folder}" to folder`, action: () => B.exportContext({ format: 'folder', folder }) },
      { icon: '🗜', label: `Export "${folder}" as ZIP`, action: () => B.exportContext({ format: 'zip', folder }) },
    ];
  }

  function forFolder(node) {
    const folder = node.dataset.folder;
    const key = `g:${folder}`;
    return [
      { header: folder },
      { icon: S.expanded.has(key) ? '▸' : '▾', label: S.expanded.has(key) ? 'Collapse' : 'Expand', action: () => { toggle(key); renderTree(); } },
      { icon: '≣', label: 'Search in strings (blocks)…', action: () => B.searchStrings('', 'blocks') },
      { sep: true },
      { icon: '🗀', label: 'Dump folder to files', action: () => B.exportContext({ format: 'folder', folder }) },
      { icon: '🗜', label: 'Export folder as ZIP', action: () => B.exportContext({ format: 'zip', folder }) },
    ];
  }

  function forFrame(node) {
    const ci = Number(node.dataset.call);
    const fi = Number(node.dataset.frame);
    const k = `${ci}:${fi}`;
    const bp = S.breakpoints.has(k);
    const frameApi = () => api(`/api/frame?of=${encodeURIComponent($('#flow-of').value)}&call=${ci}&frame=${fi}`);
    return [
      { header: `call ${ci} · frame ${fi}` },
      { icon: '↗', label: 'Open frame', action: () => jumpTo(ci, fi) },
      { icon: '◎', label: 'Who read it?', action: async () => {
        const f = await frameApi();
        B.showReaders({ text: f.text, line: f.source?.line ?? null });
      } },
      { icon: bp ? '○' : '●', label: bp ? 'Remove breakpoint' : 'Set breakpoint', key: 'F9', action: () => {
        if (bp) S.breakpoints.delete(k); else S.breakpoints.add(k);
        renderFlowTree();
      } },
      { icon: '▶', label: 'Run from here to the next breakpoint', key: 'F5', action: () => { S.cursor = { call: ci, frame: fi }; runToBreakpoint(); } },
      { sep: true },
      { icon: '⧉', label: 'Copy frame text', action: async () => copy((await frameApi()).text || '') },
      { icon: '⌕', label: 'Where else does this load?', action: async () => B.probeText((await frameApi()).text || '') },
      { icon: '≣', label: 'Search in strings…', action: async () => B.searchStrings(firstLine((await frameApi()).text || '')) },
    ];
  }

  function forCall(node) {
    const ci = Number(node.dataset.call);
    return [
      { header: `API call ${ci}` },
      { icon: '▶', label: 'Step from the first frame', action: () => jumpTo(ci, 0) },
      { icon: '▸', label: 'Expand / collapse', action: () => { toggle(`c:${ci}`); renderFlowTree(); } },
    ];
  }

  function forSession(node) {
    const path = node.dataset.sessionPath;
    const id = node.dataset.sessionId;
    return [
      { header: id },
      { icon: '↗', label: 'Open', action: () => B.openSessionPath(path, false) },
      { icon: '▣', label: 'Open + terminal (claude --resume)', action: () => B.openSessionPath(path, true) },
      { sep: true },
      { icon: '🗀', label: 'Show the .jsonl in Explorer', action: () => api('/api/reveal', { path }) },
      { icon: '⧉', label: 'Copy session id', action: () => copy(id) },
      { icon: '⧉', label: 'Copy path', action: () => copy(path) },
    ];
  }

  function forEditor() {
    const ed = $('#editor');
    const selText = ed.value.slice(ed.selectionStart, ed.selectionEnd);
    const has = selText.length > 0;
    const t = activeTab();
    return [
      { header: has ? `${selText.length} chars selected` : 'editor' },
      { icon: '⧉', label: 'Copy', key: 'Ctrl+C', disabled: !has, action: () => copy(selText) },
      { icon: '≣', label: 'Search selection in strings', disabled: !has, action: () => B.searchStrings(selText) },
      { icon: '⌕', label: 'Where does the selection load?', disabled: !has, action: () => B.probeText(selText) },
      { icon: '◎', label: 'Who read the selection?', disabled: !has, action: () => B.showReaders({ text: selText }) },
      { icon: '⊕', label: 'Pin the selection (survives rewind)', disabled: !has, action: async () => {
        const r = await api('/api/pin', { action: 'add', text: selText, anchor: 'last-user' });
        S.state = r.state;
        renderAll();
        status('pinned the selection');
      } },
      { sep: true },
      { icon: '💾', label: 'Save', key: 'Ctrl+S', disabled: !t || t.readonly, action: () => save() },
    ];
  }

  function global() {
    const open = !!S.state?.open;
    return [
      { icon: '↗', label: 'Open a session…', key: 'Ctrl+O', action: () => B.openGate() },
      { icon: '≣', label: 'Search in strings…', key: 'Ctrl+Shift+F', disabled: !open, action: () => B.searchStrings('') },
      { sep: true },
      { icon: '🗀', label: 'Dump the whole context to folders', disabled: !open, action: () => B.exportContext({ format: 'folder' }) },
      { icon: '🗜', label: 'Export the whole context as ZIP', disabled: !open, action: () => B.exportContext({ format: 'zip' }) },
      { sep: true },
      { icon: '⟳', label: 'Save & Resume', key: 'Ctrl+Shift+S', disabled: !open, action: () => B.saveResume() },
      { icon: '⚙', label: 'Settings', action: () => selectView('settings') },
    ];
  }

  function firstLine(t) {
    const line = String(t || '').split('\n').map((l) => l.trim()).find((l) => l.length > 3) || '';
    return line.slice(0, 80);
  }

  document.addEventListener('contextmenu', (e) => {
    // Inputs and textareas other than the editor keep the browser's own menu,
    // which is the one that knows about spellcheck and paste.
    const t = e.target;
    if ((t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.id !== 'editor') return;
    if (document.body.classList.contains('gated')) return;
    e.preventDefault();
    let list;
    const block = t.closest('[data-block-id]');
    const frame = t.closest('[data-frame]');
    const call = t.closest('[data-call]');
    const folder = t.closest('[data-folder]');
    const sess = t.closest('[data-session-path]');
    if (t.id === 'editor') list = forEditor();
    else if (block) list = forBlock(block);
    else if (frame) list = forFrame(frame);
    else if (call) list = forCall(call);
    else if (folder) list = forFolder(folder);
    else if (sess) list = forSession(sess);
    else list = global();
    open(e.clientX, e.clientY, list);
  });

  document.addEventListener('click', (e) => { if (!box().hidden && !box().contains(e.target)) close(); });
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  document.addEventListener('keydown', (e) => {
    if (box().hidden) return;
    const live = items.map((it, i) => ({ it, i })).filter(({ it }) => it.label && !it.disabled);
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const pos = live.findIndex((x) => x.i === sel);
      const next = e.key === 'ArrowDown' ? (pos + 1) % live.length : (pos - 1 + live.length) % live.length;
      if (live[next]) highlight(live[next].i);
      return;
    }
    if (e.key === 'Enter' && sel >= 0) { e.preventDefault(); run(sel); }
  }, true);

  B.menu = { open, close };
})();
