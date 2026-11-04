// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
/* recording.js — the live Recording view.

   What it shows: the calls claude makes FROM NOW ON, as they happen, each with
   what went in and what came out. Nothing already in the session is replayed
   -- the server's recorder starts at the end of the transcript and reads only
   what claude appends.

   This replaced follow.js, which re-traced the WHOLE session on every live
   event and then stepped through old messages one by one; on a session with
   no request records it queued every frame of the history. That was the
   "jumps load old messages" problem, and it is gone by construction here.

   Auto-jump opens each new frame as it arrives, in one reused preview tab so
   a long recording does not pile up hundreds of tabs. It can be stopped at
   any moment -- the checkbox, the REC chip, or Escape. */

'use strict';

(() => {
  const B = (window.brainstorm = window.brainstorm || {});
  const R = { seq: 0, steps: [], frames: new Map(), byStep: new Map(), pending: [], recording: false, status: 'idle', session: null, mode: null };
  const queue = [];
  let pumping = false;
  let selected = null;      // frame seq shown in the editor
  const opened = new Set(); // step ids expanded in the list
  S.following = false;      // app.js reads this: "auto-jump is on"

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cfg = () => B.settings || {};

  /* ---------------------------------------------------------------- state --- */

  function absorb(r) {
    R.recording = !!r.recording;
    R.status = r.status;
    R.mode = r.mode;
    if (r.session && r.session !== R.session) {
      // A different session is being recorded now (opened, or Save & Resume
      // moved claude to a new id). Start the list over: live only.
      R.session = r.session;
      R.steps = [];
      R.frames.clear();
      R.byStep.clear();
      opened.clear();
      queue.length = 0;
      R.seq = 0;
    }
    R.steps = r.steps || R.steps;
    R.pending = r.pending || [];
    const fresh = [];
    for (const f of r.frames || []) {
      if (R.frames.has(f.seq)) continue;
      R.frames.set(f.seq, f);
      if (!R.byStep.has(f.step)) R.byStep.set(f.step, []);
      R.byStep.get(f.step).push(f);
      fresh.push(f);
      if (f.seq > R.seq) R.seq = f.seq;
    }
    return fresh;
  }

  const wanted = (f) => {
    const only = cfg().followOnly || 'all';
    if (only === 'tools') return f.kind === 'tool_use' || f.kind === 'tool_result';
    if (only === 'prompts') return (f.io === 'in' && f.kind === 'text') || (f.io === 'out' && f.kind === 'text');
    return true;
  };

  async function poll() {
    if (!S.state || !S.state.open) return;
    let r;
    try {
      r = await api(`/api/record?since=${R.seq}`);
    } catch { return; }
    const fresh = absorb(r);
    if (fresh.length) {
      if (S.following) {
        for (const f of fresh) if (wanted(f)) queue.push(f.seq);
        // The first live call opens the Recording view by itself.
        if (S.view !== 'recording' && !document.body.classList.contains('gated')) selectView('recording');
        pump();
      }
      const steps = new Set(fresh.map((f) => f.step));
      for (const id of steps) opened.add(id);
    }
    render();
  }

  /* --------------------------------------------------------------- jumping --- */

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length && S.following) {
        const delay = Number(cfg().followDelayMs ?? 300);
        const seq = delay <= 0 ? queue.splice(0).pop() : queue.shift();
        show(seq, { flash: true });
        paintChip();
        if (delay > 0) await sleep(delay);
      }
    } finally {
      pumping = false;
      paintChip();
    }
  }

  // One reused preview tab, like an editor's preview: auto-jump replaces its
  // contents instead of opening a tab per frame.
  function show(seq, { flash = false } = {}) {
    const f = R.frames.get(seq);
    if (!f) return;
    selected = seq;
    const step = R.steps.find((s) => s.id === f.step);
    const callTxt = step && step.call !== null && step.call !== undefined ? `call ${step.call}` : `step ${f.step}`;
    const key = 'rec:preview';
    let tab = S.tabs.find((t) => t.key === key);
    if (!tab) { tab = { key, kind: 'frame', readonly: true }; S.tabs.push(tab); }
    tab.label = `● ${callTxt} ${f.io === 'in' ? '→' : '←'} ${f.kind}`;
    tab.text = f.text || '(no text)';
    tab.meta = `recorded live · ${callTxt} · ${f.io === 'in' ? 'input' : 'output'} · ${f.role} ${f.kind}${f.tool ? ` ${f.tool}` : ''} · ${fmt(f.chars)} ch · transcript L${f.line}${f.truncated ? ' · truncated for display' : ''}`;
    S.active = key;
    renderTabs();
    renderEditor();
    opened.add(f.step);
    render();
    if (flash) {
      const n = document.querySelector(`#rec-list [data-rec-seq="${seq}"]`);
      if (n) {
        n.classList.remove('flash');
        void n.offsetWidth;
        n.classList.add('flash');
        n.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  /* ---------------------------------------------------------------- render --- */

  function paintChip() {
    const chip = $('#rec-chip');
    chip.hidden = !R.recording;
    chip.textContent = S.following ? (queue.length ? `● REC  ${queue.length} queued` : '● REC  auto-jump') : '● REC';
    chip.title = S.following ? 'Recording, auto-jumping to each new frame. Click to stop auto-jump.' : 'Recording. Click to resume auto-jump.';
    $('#rec-autojump').checked = S.following;
    $('#rec-toggle').textContent = R.recording ? '■ Stop recording' : '● Record';
    $('#rec-toggle').classList.toggle('primary', !R.recording);
  }

  function render() {
    paintChip();
    const st = $('#rec-status');
    const frames = R.frames.size;
    if (!S.state || !S.state.open) st.textContent = 'Open a session to record it.';
    else if (R.recording) st.textContent = `recording ${String(R.session || '').slice(0, 8)} · ${R.steps.length} call${R.steps.length === 1 ? '' : 's'} · ${frames} frame${frames === 1 ? '' : 's'} · ${R.mode || ''}`;
    else st.textContent = `${R.status === 'stopped' ? 'stopped' : 'not recording'} · ${R.steps.length} call(s) kept`;

    const box = $('#rec-list');
    const frag = document.createDocumentFragment();
    if (!R.steps.length) {
      frag.appendChild(el('div', 'muted pad small', R.recording
        ? 'Waiting for claude. Send a prompt in the terminal; each call it makes appears here as it happens.'
        : 'Not recording. Press ● Record.'));
    }
    for (const s of R.steps) {
      const isOpen = opened.has(s.id);
      const callTxt = s.call !== null && s.call !== undefined ? `call ${s.call}` : `step ${s.id}`;
      const tools = s.tools.length ? ` · ${s.tools.slice(0, 4).join(', ')}${s.tools.length > 4 ? '…' : ''}` : '';
      const head = node({
        depth: 0,
        twisty: isOpen ? '▾' : '▸',
        icon: '●',
        iconCls: s.outputs ? 'assistant' : 'user',
        label: `${callTxt}${s.startedBefore ? ' (was in flight)' : ''}${tools}`,
        meta: `${s.inputs} in · ${s.outputs} out`,
        onClick: (e) => {
          // Clicking a call opens it -- its first frame -- and expands it. The
          // twisty alone just folds it.
          if (e && e.target && e.target.classList.contains('tw')) {
            if (isOpen) opened.delete(s.id); else opened.add(s.id);
            render();
            return;
          }
          stopAutoJump(true);
          const fs = R.byStep.get(s.id) || [];
          if (fs.length) show(fs[0].seq);
          opened.add(s.id);
          render();
        },
      });
      head.dataset.recStep = String(s.id);
      frag.appendChild(head);
      if (s.prompt) frag.appendChild(node({ depth: 1, label: `“${s.prompt}”`, cls: 'muted' }));
      if (!isOpen) continue;
      for (const f of R.byStep.get(s.id) || []) {
        const n = node({
          depth: 2,
          icon: f.io === 'in' ? '→' : '←',
          iconCls: f.kind === 'tool_use' ? 'tool_use' : f.kind === 'tool_result' ? 'tool_result' : f.role,
          label: `${f.kind}${f.tool ? ` ${f.tool}` : ''} — ${f.detail || ''}`,
          meta: fmt(f.chars),
          cls: selected === f.seq ? 'selected' : '',
          onClick: () => { stopAutoJump(true); show(f.seq); },
        });
        addPen(n, { line: f.line, kind: f.kind });
        n.dataset.recSeq = String(f.seq);
        frag.appendChild(n);
      }
    }
    // Written but not sent with any call yet: a prompt waiting for its
    // request, or an interrupt (Esc) that ended the turn. Without this an
    // action in the terminal was invisible until -- or unless -- a call sent it.
    if (R.pending.length) {
      frag.appendChild(node({
        depth: 0, twisty: '▾', icon: '○', iconCls: 'thinking',
        label: 'next call — not sent yet',
        meta: `${R.pending.length} waiting`,
      }));
      R.pending.forEach((w) => {
        frag.appendChild(node({
          depth: 2, icon: '→', iconCls: w.kind === 'tool_result' ? 'tool_result' : w.role,
          label: `${w.kind} — ${w.detail || ''}`,
          cls: 'muted',
          onClick: () => {
            stopAutoJump(true);
            const key = 'rec:preview';
            let tab = S.tabs.find((t) => t.key === key);
            if (!tab) { tab = { key, kind: 'frame', readonly: true }; S.tabs.push(tab); }
            tab.label = `○ waiting ${w.kind}`;
            tab.text = w.text || '(no text)';
            tab.meta = `written, not sent yet · ${w.role} ${w.kind} · transcript L${w.line}`;
            S.active = key;
            renderTabs();
            renderEditor();
          },
        }));
      });
    }
    box.replaceChildren(frag);
  }

  /* -------------------------------------------------------------- controls --- */

  function setAutoJump(on, persist = true) {
    S.following = !!on;
    if (!S.following) queue.length = 0;
    paintChip();
    if (persist) api('/api/settings', { follow: S.following }).then((r) => { B.settings = r.settings; }).catch(() => {});
    status(S.following ? 'auto-jump on: each new frame opens as it arrives' : 'auto-jump stopped');
  }

  // Clicking something yourself means you want to look at THAT; carrying on
  // jumping would yank it away. Pause rather than fight the person.
  function stopAutoJump(quiet) {
    if (!S.following) return;
    S.following = false;
    queue.length = 0;
    paintChip();
    if (!quiet) status('auto-jump stopped');
    else status('auto-jump paused while you look — tick auto-jump to resume');
  }

  async function toggleRecording() {
    try {
      const r = await api('/api/record', { action: R.recording ? 'stop' : 'start' });
      absorb(r);
      render();
      status(r.recording ? 'recording: live calls only' : 'recording stopped');
    } catch (err) { status(err.message, 'err'); }
  }

  $('#rec-toggle').addEventListener('click', toggleRecording);
  $('#rec-autojump').addEventListener('change', (e) => setAutoJump(e.target.checked));
  $('#rec-clear').addEventListener('click', async () => {
    try { absorb(await api('/api/record', { action: 'clear' })); } catch { /* ignore */ }
    R.steps = []; R.frames.clear(); R.byStep.clear(); opened.clear(); queue.length = 0;
    render();
  });
  $('#rec-chip').addEventListener('click', () => setAutoJump(!S.following));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.following && queue.length && !document.body.classList.contains('gated')) {
      setAutoJump(false);
    }
  });

  /* ----------------------------------------------------------------- hooks --- */

  const prevOpened = B.onSessionOpened;
  B.onSessionOpened = (st) => {
    prevOpened?.(st);
    R.session = null;         // the next poll adopts whatever is being recorded
    if (cfg().follow !== false) setAutoJump(true, false);
    poll();
  };

  const prevBoot = B.onBoot;
  B.onBoot = () => {
    prevBoot?.();
    if (cfg().follow !== false) setAutoJump(true, false);
    poll();
  };

  B.setFollow = setAutoJump;
  B.pauseAutoJump = () => stopAutoJump(true);
  // The live panel's tool calls jump here once the transcript has them. Same
  // tool_use_id, so it is the very block the call put into the context; the
  // RESULT is preferred, because that is what the model was given to read.
  B.showToolFrame = (id) => {
    let hit = null;
    for (const f of R.frames.values()) if (id && f.toolUseId === id && (!hit || f.kind === 'tool_result')) hit = f;
    if (!hit) return false;
    show(hit.seq, { flash: true });
    return true;
  };
  B.recording = () => ({ ...R, frames: R.frames.size, queue: queue.length });
  setInterval(poll, 700);
  render();
})();
