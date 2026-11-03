// Copyright (c) 2026 buggerlogger. All rights reserved.
// Proprietary and confidential. No license is granted to use, copy, modify or
// distribute this file, in whole or in part. See LICENSE.

/* follow.js — follow the live session: every time claude makes an API call,
   jump to each frame that call added, one at a time.

   "Which frames are new" is not guessed. A recorded call says how many
   messages it kept from the previous one (keep); everything at message index
   keep or later is the tail it appended, which is exactly what changed. A
   transcript with no request records (mode "reconstructed") has one synthetic
   call, so there the new frames are simply the ones past the previous count.

   Following never switches the editor out from under unsaved edits: if the
   live session is a different one and you have changes, it says so and waits. */

'use strict';

(() => {
  const B = (window.brainstorm = window.brainstorm || {});
  S.following = false;
  let queue = [];
  let pumping = false;
  let refreshTimer = null;
  let handling = Promise.resolve();
  let seenFrames = 0;        // frame count of the last call, for reconstructed mode

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cfg = () => B.settings || {};

  function paint() {
    $('#follow-chip').hidden = !S.following;
    $('#opt-follow').checked = S.following;
    $('#follow-queue').textContent = queue.length ? `${queue.length} frame(s) queued` : (S.following ? 'waiting for the next call…' : '');
  }

  function setFollow(on, persist = true) {
    S.following = !!on;
    if (!S.following) queue = [];
    paint();
    if (persist) api('/api/settings', { follow: S.following }).then((r) => { B.settings = r.settings; }).catch(() => {});
    status(S.following ? 'following the live session' : 'follow off');
  }

  function tailOf(call, mode) {
    if (!call) return [];
    const only = cfg().followOnly || 'new';
    if (only === 'all') return call.frames.map((f, i) => i);
    if (only === 'calls') return call.frames.map((f, i) => (f.kind === 'tool_call' ? i : -1)).filter((i) => i >= 0);
    if (mode === 'reconstructed') {
      const from = Math.min(seenFrames, call.frames.length);
      return call.frames.map((f, i) => i).slice(from);
    }
    return call.frames
      .map((f, i) => {
        const m = /^messages\.(\d+)/.exec(f.path);
        return m && Number(m[1]) >= (call.keep || 0) ? i : -1;
      })
      .filter((i) => i >= 0);
  }

  function flashFrame(ci, fi) {
    const n = document.querySelector(`#flow-tree [data-call="${ci}"][data-frame="${fi}"]`);
    if (!n) return;
    n.classList.remove('flash');
    void n.offsetWidth; // restart the animation
    n.classList.add('flash');
    n.scrollIntoView({ block: 'nearest' });
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length && S.following) {
        const delay = Number(cfg().followDelayMs ?? 300);
        let next;
        if (delay <= 0) { next = queue[queue.length - 1]; queue = []; } else next = queue.shift();
        S.expanded.add(`c:${next.ci}`);
        await jumpTo(next.ci, next.fi);
        flashFrame(next.ci, next.fi);
        paint();
        if (delay > 0) await sleep(delay);
      }
    } finally {
      pumping = false;
      paint();
    }
  }

  async function handle(events) {
    const interesting = events.filter((e) => e.type === 'jump' || e.type === 'call' || e.type === 'grew');
    if (!interesting.length) return;
    const target = interesting[interesting.length - 1].session;
    const current = S.state?.config?.sessionId;

    // A different session is the live one -- claude --resume can start a new
    // session file. Move to it, unless that would discard edits.
    if (target && target !== current) {
      if (S.state?.totals?.dirty?.length) {
        status(`live session ${target.slice(0, 8)} is running; save your ${S.state.totals.dirty.length} edit(s) to follow it`, 'err');
        return;
      }
      const r = await api('/api/live', { action: 'attach', session: target });
      if (r.state) { S.state = r.state; renderAll(); }
      termWrite(`[follow] now following ${target}`, 'sys');
      S.trace = null;
      seenFrames = 0;
    }

    const before = S.trace ? S.trace.calls.length : 0;
    const prevFrames = S.trace && S.trace.calls.length ? S.trace.calls[S.trace.calls.length - 1].framesTotal || 0 : seenFrames;
    if ($('#flow-of').value !== 'source') $('#flow-of').value = 'source';
    await trace('source', { quiet: true });
    if (!S.trace) return;

    const mode = S.trace.mode;
    seenFrames = prevFrames;
    const from = mode === 'reconstructed' ? 0 : Math.max(0, before === 0 ? S.trace.calls.length - 1 : before);
    for (let ci = from; ci < S.trace.calls.length; ci++) {
      for (const fi of tailOf(S.trace.calls[ci], mode)) queue.push({ ci, fi });
    }
    const last = S.trace.calls[S.trace.calls.length - 1];
    if (last) seenFrames = last.framesTotal || last.frames.length;
    paint();
    pump();

    // Refresh the editable blocks a moment after the burst ends, so the tree
    // shows the turn that just happened -- but never over unsaved edits.
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      if (S.state?.totals?.dirty?.length || !S.state?.config) return;
      try {
        const r = await api('/api/live', { action: 'attach', session: S.state.config.sessionId });
        if (r.state) { S.state = r.state; renderTree(); renderStatus(); }
      } catch { /* the next event retries */ }
    }, 2500);
  }

  // Serialise: two bursts must not interleave their re-trace and their queue.
  const prevLive = B.onLive;
  B.onLive = (events) => {
    prevLive?.(events);
    if (!S.following) return;
    handling = handling.then(() => handle(events)).catch((err) => status(err.message, 'err'));
  };

  const prevOpened = B.onSessionOpened;
  B.onSessionOpened = (st) => {
    prevOpened?.(st);
    seenFrames = 0;
    queue = [];
    if (cfg().follow) setFollow(true, false);
    else paint();
  };

  $('#opt-follow').addEventListener('change', (e) => setFollow(e.target.checked));
  $('#follow-chip').addEventListener('click', () => setFollow(false));

  B.setFollow = setFollow;
  B.followQueue = () => queue.slice();
})();
