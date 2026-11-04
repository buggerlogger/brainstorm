// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
/* live.js — what claude is doing RIGHT NOW, from inside it.

   The brainstorm-live mod hooks Claude Code's own engine (turn.step streams
   each model request chunk by chunk; tool.call fires before a tool runs) and
   posts every event as it happens; the server keeps them (src/core/live.mjs).
   This draws the request in flight: what was sent, and how long each phase
   has taken so far --

     waiting for the API   sent, and nothing back yet: the API is taking the
                           request in (the usage later says how much of it
                           came from the prompt cache and how much was new)
     thinking              thinking chunks are arriving; until the first text
                           or tool call nothing visible exists. They arrive
                           empty but keep coming while it thinks, so the
                           newest one is shown as a sign of life
     writing               text or a tool call is streaming

   -- with each tool call as it is chosen and run. Every time shown is an
   event's own time; nothing is estimated.

   Claude Code asks the API to leave the thinking TEXT out ("display":
   "omitted", measured on the wire), so its words are not available to any
   hook: the panel shows when thinking happened and for how long, and shows
   the words only if they ever arrive.

   Clicking a tool call opens what it was given and what came back. Once the
   recorder has read the same call from the transcript (they share the
   tool_use_id), it jumps to that recorded frame instead. */

'use strict';

(() => {
  const B = (window.brainstorm = window.brainstorm || {});
  const L = { seq: 0, data: null, offset: 0 };
  const followed = new Set();   // tool_use_ids auto-jump already opened

  // ⛔ The panel had no height limit: with a long request on it, the call
  // list under it was squeezed to a line or two (a real screenshot: one call
  // visible). It is bounded now, its handle resizes it, and its header folds
  // it to one line. Both are remembered, per viewer.
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window */ } },
  };
  let folded = store.get('brainstorm.livefold') === '1';
  function setFolded(v) {
    folded = !!v;
    store.set('brainstorm.livefold', folded ? '1' : '0');
    render();
  }
  function setLiveHeight(px) {
    const box = $('#live');
    const view = box.parentElement;
    const max = Math.max(120, view.clientHeight - 140);
    const v = Math.max(80, Math.min(max, Math.round(px)));
    box.style.setProperty('--live-h', `${v}px`);
    box.classList.add('sized');
    store.set('brainstorm.liveh', String(v));
  }
  const savedH = Number(store.get('brainstorm.liveh'));
  if (savedH) { $('#live').style.setProperty('--live-h', `${savedH}px`); $('#live').classList.add('sized'); }
  {
    const h = $('#split-live');
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      h.classList.add('dragging');
      const top = $('#live').getBoundingClientRect().top;
      if (folded) setFolded(false);
      const move = (ev) => setLiveHeight(ev.clientY - top);
      const up = () => {
        h.classList.remove('dragging');
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
    });
    h.addEventListener('dblclick', () => { $('#live').style.removeProperty('--live-h'); $('#live').classList.remove('sized'); store.set('brainstorm.liveh', ''); });
  }

  const secs = (ms) => `${Math.max(0, ms / 1000).toFixed(1)} s`;
  const now = () => Date.now() + L.offset;
  const n = (x) => (x === null || x === undefined ? '–' : Number(x).toLocaleString());

  async function poll() {
    if (!S.state || !S.state.open) return;
    let r;
    try {
      r = await api(`/api/hooks?since=${L.seq}`);
    } catch { return; }
    // same machine, but the page's clock and the server's are kept agreeing
    L.offset = r.now - Date.now();
    L.seq = r.seq;
    L.data = r;
    // the server recomputed what claude is sent (a rewind or a /compact in
    // claude moved messages off the conversation): the tree follows
    if (L.sentEpoch !== undefined && r.sentEpoch !== L.sentEpoch) {
      const before = S.state?.totals?.notSent ?? 0;
      try {
        S.state = await api('/api/state');
        renderTree();
        renderStatus();
        const now = S.state.totals.notSent ?? 0;
        status(`the conversation changed in claude (a rewind or a compaction): ${now} block(s) are not sent now${now !== before ? ` (was ${before})` : ''}`);
      } catch { /* the next poll tries again */ }
    }
    L.sentEpoch = r.sentEpoch;
    // the transcript grew or was compacted since the blocks were made: the tree
    // offers a refresh (Save & Resume does it by itself)
    const staleNow = JSON.stringify(r.stale || {});
    if (L.stale !== undefined && staleNow !== L.stale) {
      try { S.state = await api('/api/state'); renderTree(); } catch { /* next poll */ }
    }
    L.stale = staleNow;
    if (S.following) {
      for (const e of r.events || []) {
        if (e.type === 'tool.call' && e.id && !followed.has(e.id)) {
          followed.add(e.id);
          openTool(e.id, { auto: true });
        }
      }
    }
    render();
  }

  /* --------------------------------------------------------------- phases --- */

  function phases(s, t) {
    const end = s.stopAt ?? s.endAt;
    const out = [{
      k: 'wait', label: 'waiting for the API',
      from: s.sentAt, to: s.firstAt ?? end ?? t, open: s.firstAt === null && end === null,
    }];
    if (s.firstAt !== null) {
      const thought = s.thinkingAt !== null;
      out.push({
        k: thought ? 'think' : 'quiet',
        label: thought ? 'thinking' : 'no visible output yet',
        from: s.firstAt, to: s.visibleAt ?? end ?? t, open: s.visibleAt === null && end === null,
      });
      if (s.visibleAt !== null) {
        out.push({
          k: 'write', label: s.tools.length && !s.text ? 'writing the tool call' : 'writing',
          from: s.visibleAt, to: end ?? t, open: end === null,
        });
      }
    }
    return out.filter((p) => p.to - p.from >= 0);
  }

  function bar(s, t) {
    const ps = phases(s, t);
    const total = Math.max(1, ps.reduce((a, p) => a + (p.to - p.from), 0));
    const box = el('div', 'live-bar');
    for (const p of ps) {
      const seg = el('div', `seg ${p.k}${p.open ? ' open' : ''}`);
      seg.style.flexGrow = String(Math.max(0.02, (p.to - p.from) / total));
      seg.title = `${p.label}: ${secs(p.to - p.from)}`;
      box.appendChild(seg);
    }
    const legend = el('div', 'live-legend');
    for (const p of ps) {
      const it = el('span', `lg ${p.k}${p.open ? ' open' : ''}`);
      it.appendChild(el('i', ''));
      // a long think, still alive: when its last chunk came
      const life = p.k === 'think' && p.open && s.thinkingLastAt !== null ? ` · last sign of life ${secs(t - s.thinkingLastAt)} ago` : '';
      it.appendChild(document.createTextNode(`${p.label} ${secs(p.to - p.from)}${life}`));
      legend.appendChild(it);
    }
    return [box, legend];
  }

  function usageLine(u) {
    if (!u) return null;
    const parts = [
      `cache read ${n(u.cache_read_input_tokens)}`,
      `cache written ${n(u.cache_creation_input_tokens)}`,
      `new input ${n(u.input_tokens)}`,
      `output ${n(u.output_tokens)}`,
    ];
    return el('div', 'live-usage', parts.join(' · '));
  }

  /* ---------------------------------------------------------------- tools --- */

  // What the call is about, short enough for the sidebar: a file by its name
  // (the full path is the row's tooltip), anything else by its first line.
  const toolWhat = (t) => {
    const i = t.input || {};
    const file = i.file_path || i.notebook_path;
    if (file) return String(file);
    return String(i.pattern || i.command || i.url || i.query || i.path || i.description || i.prompt || '').split('\n')[0];
  };
  const toolLabel = (t) => {
    const i = t.input || {};
    const what = toolWhat(t);
    const short = i.file_path || i.notebook_path ? what.split(/[\\/]/).pop() : what.slice(0, 120);
    return `${t.tool}${short ? `  ${short}` : ''}`;
  };

  function openTool(id, { auto = false } = {}) {
    // the recorded frame, once the transcript has it, is the context itself
    if (B.showToolFrame?.(id)) return;
    const t = (L.data?.tools || []).find((x) => x.id === id);
    if (!t) return;
    const key = 'rec:preview';
    let tab = S.tabs.find((x) => x.key === key);
    if (!tab) { tab = { key, kind: 'frame', readonly: true }; S.tabs.push(tab); }
    tab.label = `◉ live ${t.tool}`;
    tab.text = [
      `${t.tool} — what claude sent the tool:`,
      JSON.stringify(t.input ?? {}, null, 2),
      '',
      t.doneAt === null ? '(running…)' : `${t.isError ? 'ERROR — ' : ''}${t.deny ? `refused: ${t.deny}` : 'what came back:'}`,
      t.text ?? '',
    ].join('\n');
    tab.meta = `live, from inside claude · tool_use_id ${t.id || '?'}${t.doneAt !== null ? ` · ran ${secs(t.doneAt - t.startAt)}` : ' · running'}${auto ? ' · auto-jump' : ''}`;
    S.active = key;
    renderTabs();
    renderEditor();
  }

  /* ------------------------------------------------- one request, in full --- */

  // Everything known about one request, as the API reported it. The cache
  // numbers are tokens, not text: the API says HOW MUCH came from the cache,
  // never which words. What it serves is the start of the request that is the
  // same as one sent before (system prompt, tools, the earlier conversation),
  // so the request before it says where that shared start ends.
  function openStep(s) {
    const r = L.data || { steps: [], tools: [] };
    const t = now();
    const prev = [...r.steps].reverse().find((x) => x.sessionId === s.sessionId && (x.agentId || null) === (s.agentId || null) && x.sentAt < s.sentAt) || null;
    const clock = (ms) => new Date(ms - L.offset).toLocaleTimeString();
    const pad = (k, v, why = '') => `  ${k.padEnd(16)}${String(v).padStart(10)}${why ? `   ${why}` : ''}`;
    const u = s.usage;
    const out = [
      `request ${s.step + 1} of its turn · ${s.model}${s.effort ? ` · effort ${s.effort}` : ''}${s.agentId ? ` · subagent ${s.agentId}` : ''}`,
      `sent at ${clock(s.sentAt)} · ${n(s.messageCount)} messages`,
      s.stopReason ? `ended: ${s.stopReason}` : 'still in flight',
      '',
      'phases',
      ...phases(s, t).map((p) => `  ${p.label.padEnd(24)}${secs(p.to - p.from).padStart(9)}${p.open ? '   (still going)' : ''}`),
      '',
      'what the API reported, in tokens',
      ...(u ? [
        pad('cache read', n(u.cache_read_input_tokens), 'the start of this request that was the same as before: served from the prompt cache'),
        pad('cache written', n(u.cache_creation_input_tokens), 'context stored in the cache now, so the next request can read it'),
        pad('new input', n(u.input_tokens), 'neither read from nor stored in the cache'),
        pad('output', n(u.output_tokens), 'what the model wrote, thinking included'),
      ] : ['  (no usage: the request ended before a response, or was refused)']),
      '',
      prev
        ? `the request before it sent ${n(prev.messageCount)} messages; this one ${n(s.messageCount)}. What they share at the start is what the cache served; the ${n(Math.max(0, s.messageCount - prev.messageCount))} after it are new.`
        : 'the first request seen in this session: nothing before it to compare with.',
    ];
    if (s.tools.length) {
      out.push('', 'tool calls it made');
      for (const tl of s.tools) {
        const run = r.tools.find((x) => x.id === tl.id);
        out.push(`  ${run ? toolLabel(run) : tl.name}${run && run.doneAt !== null ? `   ${secs(run.doneAt - run.startAt)}, ${fmt((run.text || '').length)} ch back` : ''}`);
      }
    }
    if (s.text) out.push('', 'what it wrote', s.text);
    if (s.thinkingAt !== null && !s.thinkingChars) out.push('', 'thinking: it thought, but Claude Code asks the API to leave the words out');
    const key = `live:req:${s.key}`;
    let tab = S.tabs.find((x) => x.key === key);
    if (!tab) { tab = { key, kind: 'frame', readonly: true }; S.tabs.push(tab); }
    tab.label = `◉ request ${s.step + 1}`;
    tab.text = out.join('\n');
    tab.meta = 'live, from inside claude · the numbers are the API\'s own';
    S.active = key;
    renderTabs();
    renderEditor();
  }

  /* --------------------------------------------------------------- render --- */

  function render() {
    const box = $('#live');
    if (!box) return;
    const r = L.data;
    const frag = document.createDocumentFragment();
    const head = el('div', 'live-head');
    head.appendChild(el('span', 'fold', folded ? '▸' : '▾'));
    head.title = folded ? 'click to unfold the Live panel' : 'click to fold the Live panel';
    head.addEventListener('click', () => setFolded(!folded));
    head.appendChild(el('span', 'live-dot', '◉'));
    head.appendChild(el('span', 'live-title', 'LIVE · from inside claude'));
    const since = r?.lastAt ? Math.round((Date.now() - (r.lastAt - L.offset)) / 1000) : null;
    head.appendChild(el('span', 'muted small grow-left', r?.lastAt
      ? `mod connected · last event ${since}s ago`
      : 'no events yet'));
    frag.appendChild(head);
    box.classList.toggle('folded', folded);
    if (folded) {
      // one line: the request in flight and the phase it is in
      const cur = r?.current;
      if (cur) {
        const ps = phases(cur, now());
        const p = ps[ps.length - 1];
        frag.appendChild(el('div', 'live-note small', `▶ request ${cur.step + 1} · ${p.label} ${secs(p.to - p.from)}${cur.tools.length ? ` · ${cur.tools.map((x) => x.name).join(', ')}` : ''}`));
      } else if (r?.waiting) {
        frag.appendChild(el('div', 'live-note small warn', `claude is waiting in terminal ${r.waiting.tag}: look there`));
      }
      box.replaceChildren(frag);
      return;
    }

    if (r && r.claimed === false) {
      frag.appendChild(el('div', 'live-note warn', `Another brainstorm that is running receives the live events (${r.file}). Close it, or use that window.`));
    }
    if (r && r.waiting) {
      frag.appendChild(el('div', 'live-note warn', `Terminal ${r.waiting.tag}: claude has been running ${Math.round(r.waiting.runningFor / 1000)} s and has not started its session. It is asking something in its window — look there. For a folder it does not trust yet it asks whether to trust it, and the highlighted answer is “No, exit”: press ↓ for “Yes”, then Enter.`));
    }
    if (!r || (!r.steps.length && !r.tools.length)) {
      frag.appendChild(el('div', 'live-note', 'Nothing yet. A terminal opened from this version starts claude with the brainstorm-live mod (Settings → Live hooks), and each request appears here the moment it is sent. A claude that was already running before then has no mod: Save & Resume, or open its terminal again.'));
      box.replaceChildren(frag);
      return;
    }

    const t = now();
    // A compaction makes its own request, which turn.step never sees: the mod
    // reports it on its own, start and end.
    if (r.compacting) {
      const c = r.compacting;
      const card = el('div', 'live-card inflight');
      card.appendChild(el('div', 'live-step', `◌ compacting (${c.trigger === 'manual' ? '/compact' : c.trigger}) · ${n(c.messageCount)} messages · ${secs(t - c.startAt)}`));
      card.appendChild(el('div', 'live-note small', 'Claude is writing the summary that replaces the conversation. When it is done, everything before it is no longer sent, and moves to "Not sent" in the Explorer.'));
      frag.appendChild(card);
    }
    const lastCompaction = r.compactions?.[r.compactions.length - 1];
    if (lastCompaction && !r.compacting && t - lastCompaction.endAt < 10 * 60 * 1000) {
      const c = lastCompaction;
      frag.appendChild(el('div', 'live-note small', c.skipped
        ? `compaction ${c.skipped === 'failed' ? 'failed' : `skipped: ${c.skipped}`}`
        : `compacted (${c.trigger === 'manual' ? '/compact' : c.trigger})${c.startAt ? ` in ${secs(c.endAt - c.startAt)}` : ''}${c.tokensBefore ? ` · ${n(c.tokensBefore)} → ${n(c.tokensAfter)} tokens` : ''}${c.messagesAfter !== null ? ` · ${n(c.messagesAfter)} message(s) after` : ''}`));
    }
    const cur = r.current;
    const shown = cur || r.steps[r.steps.length - 1];
    if (shown) {
      const card = el('div', `live-card${cur ? ' inflight' : ''}`);
      const title = el('div', 'live-step');
      const ended = !cur && shown.stopReason && !['end_turn', 'tool_use', 'stop_sequence', 'max_tokens'].includes(shown.stopReason) ? ` · ${shown.stopReason}` : '';
      title.textContent = `${cur ? '▶ in flight' : '■ last request'}${ended} · request ${shown.step + 1} of its turn${shown.agentId ? ` · subagent ${String(shown.agentId).slice(0, 8)}` : ''} · ${shown.model}${shown.effort ? ` · effort ${shown.effort}` : ''} · ${n(shown.messageCount)} messages sent`;
      title.title = 'click: everything about this request';
      title.classList.add('clickable');
      title.addEventListener('click', () => { B.pauseAutoJump?.(); openStep(shown); });
      card.appendChild(title);
      for (const x of bar(shown, t)) card.appendChild(x);
      const u = usageLine(shown.usage);
      if (u) card.appendChild(u);
      if (shown.thinkingAt !== null && !shown.thinkingChars) {
        card.appendChild(el('div', 'live-note small', 'Thinking text: not sent. Claude Code asks the API to leave it out, so no hook can show the words — only when and how long.'));
      }
      if (shown.thinking) card.appendChild(el('pre', 'live-text thinking', shown.thinking.slice(-1200)));
      if (shown.text) card.appendChild(el('pre', 'live-text', shown.text.slice(-1200)));
      for (const tl of shown.tools) {
        const run = r.tools.find((x) => x.id === tl.id);
        const meta = !run ? 'writing its arguments…' : run.doneAt === null ? `running ${secs(t - run.startAt)}` : `${run.isError ? 'error · ' : ''}${secs(run.doneAt - run.startAt)} · ${fmt((run.text || '').length)} ch back`;
        const row = node({
          depth: 1, icon: '→', iconCls: 'tool_use',
          label: run ? toolLabel(run) : `${tl.name}  ${tl.json.slice(0, 120)}`,
          meta,
          onClick: () => { B.pauseAutoJump?.(); openTool(tl.id); },
        });
        row.title = run ? `${run.tool}: ${toolWhat(run)}` : tl.name;
        card.appendChild(row);
      }
      frag.appendChild(card);
    }

    // Earlier requests, newest first: each one's phases at a glance.
    const past = r.steps.filter((s) => s !== shown && s.key !== shown?.key).slice(-8).reverse();
    if (past.length) {
      frag.appendChild(el('div', 'live-sub', 'earlier requests'));
      for (const s of past) {
        const ps = phases(s, t).map((p) => `${{ wait: 'wait', think: 'think', write: 'write', quiet: 'quiet' }[p.k]} ${secs(p.to - p.from)}`);
        frag.appendChild(node({
          depth: 0, icon: '●', iconCls: s.tools.length ? 'tool_use' : 'assistant',
          label: `request ${s.step + 1} · ${ps.join(' · ')}${s.tools.length ? ` · ${s.tools.map((x) => x.name).join(', ')}` : ''}`,
          // a request that ended without usage (a refusal the engine then retried,
          // an error) says how it ended instead
          meta: s.usage ? `${fmt(s.usage.cache_read_input_tokens || 0)} cached · ${fmt(s.usage.output_tokens || 0)} out` : (s.stopReason || ''),
          // every request opens: what was sent, the phases, what the cache served
          onClick: () => { B.pauseAutoJump?.(); openStep(s); },
        }));
        frag.lastChild.title = `request ${s.step + 1}: ${ps.join(' · ')}${s.stopReason ? ` · stopped: ${s.stopReason}` : ''}`;
      }
    }
    box.replaceChildren(frag);
  }

  // The bar keeps counting between polls while a request is in flight.
  setInterval(() => { if (L.data?.current) render(); }, 250);
  setInterval(poll, 600);

  const prevOpened = B.onSessionOpened;
  B.onSessionOpened = (st) => { prevOpened?.(st); poll(); };
  const prevBoot = B.onBoot;
  B.onBoot = () => { prevBoot?.(); poll(); };

  B.live = () => L.data;
  B.openLiveTool = openTool;
  B.openLiveStep = openStep;
})();
