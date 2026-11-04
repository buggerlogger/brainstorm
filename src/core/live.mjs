// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// live.mjs — what the brainstorm-live mod reports from INSIDE claude, kept for
// the page.
//
// The recorder reads the transcript, and the transcript gets a block only when
// the block is complete: a minute of thinking is a minute of nothing, then
// everything at once. The mod (mod/brainstorm-live) hooks Claude Code's own
// engine events instead -- turn.step streams each model request chunk by
// chunk, tool.call fires before a tool runs -- and posts them here. Nothing in
// this file infers anything: every time below is a time an event happened.
//
// One record per model request ("step"), with the moment of each phase:
//
//   sentAt      the engine is sending the request (model, how many messages)
//   firstAt     its first chunk came back: before this, the API was reading
//               the context (what the usage reports as cache read / written)
//   thinkingAt  a thinking block began. Claude Code asks the API not to send
//               the thinking TEXT (display: "omitted", measured on the wire),
//               so its chunks arrive EMPTY -- but they keep arriving while
//               it thinks (MEASURED: 4 empty chunks from 0.4 s after the
//               first one, about a second apart, until the text began).
//               thinkingLastAt is the newest: a sign of life, so a long
//               think can be told from a stalled request. The words are not
//               available to any hook.
//   visibleAt   the first text or tool call: thinking is over by here
//   stopAt      the response is whole, with the usage the API reported
//
// Tool calls are kept by tool_use_id, the same id the transcript records, so
// the page can jump from a live call to the exact frame the recorder later
// reads for it.

const CAP = 20000;    // the most text one step keeps per kind
const OWNER_MS = 15000;  // quiet this long, and another copy of the mod takes over

const cut = (s, n = CAP) => (s.length > n ? s.slice(s.length - n) : s);

export class LiveFeed {
  constructor({ keep = 4000, keepSteps = 200 } = {}) {
    this.keep = keep;
    this.keepSteps = keepSteps;
    this.seq = 0;
    this.events = [];
    this.steps = new Map();   // key -> step record, insertion order = time
    this.tools = new Map();   // tool_use_id -> call record
    this.turns = new Map();   // turnId -> turn record
    this.compacting = null;   // the compaction running now
    this.compactions = [];    // the ones that ended, newest last
    this.owners = new Map();  // sessionId -> the mod copy whose events are kept
    this.lastAt = 0;          // when the mod last posted (our clock)
  }

  // A request that never reported its end is closed when something later
  // proves it is over: a newer request of the same loop, the end of its turn,
  // or a compaction. The mod sends 'aborted' now, but a claude started before
  // that mod does not -- and its request stayed "in flight" for good.
  closeOpen(pred, at, why) {
    for (const s of this.steps.values()) {
      if (s.endAt === null && pred(s)) { s.endAt = at; s.stopReason ??= why; }
    }
  }

  ingest({ sessionId = '', src = null, events = [] } = {}) {
    const now = Date.now();
    // Two copies of the mod can run in one claude: brainstorm's own (its
    // terminals pass --plugin-dir) and one installed from the marketplace. Both
    // post every event. The first copy heard for a session keeps it; another
    // is taken only once that one has been quiet for OWNER_MS. A post with no
    // src (an older mod) is always taken.
    if (src && sessionId) {
      const owner = this.owners.get(sessionId);
      if (owner && owner.src !== src && now - owner.lastAt < OWNER_MS) {
        return { ok: true, accepted: 0, duplicate: true, seq: this.seq };
      }
      this.owners.set(sessionId, { src, lastAt: now });
    }
    let n = 0;
    for (const raw of Array.isArray(events) ? events : []) {
      if (!raw || typeof raw.type !== 'string') continue;
      const e = { ...raw, sessionId: raw.sessionId || sessionId, seq: ++this.seq, recvAt: now };
      this.events.push(e);
      this.fold(e);
      n++;
    }
    if (this.events.length > this.keep) this.events.splice(0, this.events.length - this.keep);
    if (n) this.lastAt = now;
    return { ok: true, accepted: n, seq: this.seq };
  }

  stepKey(e) {
    return `${e.sessionId}|${e.agentId || ''}|${e.turnId}|${e.step}`;
  }

  fold(e) {
    if (e.type === 'compact.start') {
      this.closeOpen((s) => s.sessionId === e.sessionId && (s.agentId || null) === (e.agentId || null), e.at, 'interrupted');
      this.compacting = { sessionId: e.sessionId, agentId: e.agentId || null, trigger: e.trigger, messageCount: e.messageCount, instructions: e.instructions || '', startAt: e.at, endAt: null };
      return;
    }
    if (e.type === 'compact.end') {
      const c = this.compacting && (this.compacting.agentId || null) === (e.agentId || null) ? this.compacting : { sessionId: e.sessionId, agentId: e.agentId || null, trigger: e.trigger, startAt: null };
      Object.assign(c, { endAt: e.at, skipped: e.skipped ?? null, messagesAfter: e.messageCount ?? null, tokensBefore: e.tokensBefore ?? null, tokensAfter: e.tokensAfter ?? null, usage: e.usage || null });
      this.compactions.push(c);
      if (this.compactions.length > 20) this.compactions.shift();
      if (c === this.compacting) this.compacting = null;
      return;
    }
    if (e.type === 'step.start') {
      this.closeOpen((s) => s.sessionId === e.sessionId && (s.agentId || null) === (e.agentId || null), e.at, 'superseded');
      this.steps.set(this.stepKey(e), {
        key: this.stepKey(e), sessionId: e.sessionId, agentId: e.agentId || null, turnId: e.turnId, step: e.step,
        model: e.model, effort: e.effort ?? null, messageCount: e.messageCount,
        sentAt: e.at, firstAt: null, thinkingAt: null, thinkingLastAt: null, visibleAt: null, stopAt: null, endAt: null,
        thinking: '', thinkingChars: 0, thinkingBlocks: 0, lastThinkingBlock: null, text: '', tools: [], stopReason: null, usage: null,
      });
      while (this.steps.size > this.keepSteps) this.steps.delete(this.steps.keys().next().value);
      return;
    }
    if (e.type === 'turn.start') {
      this.turns.set(e.turnId, { turnId: e.turnId, sessionId: e.sessionId, agentId: e.agentId || null, text: e.text || '', startAt: e.at, endAt: null, reason: null, durationMs: null, usage: null });
      while (this.turns.size > this.keepSteps) this.turns.delete(this.turns.keys().next().value);
      return;
    }
    if (e.type === 'turn.end') {
      const t = this.turns.get(e.turnId);
      if (t) Object.assign(t, { endAt: e.at, reason: e.reason, durationMs: e.durationMs, usage: e.usage || null });
      this.closeOpen((s) => s.turnId === e.turnId, e.at, e.reason === 'aborted' ? 'aborted' : 'ended with its turn');
      return;
    }
    if (e.type === 'tool.call') {
      this.tools.set(e.id || `noid-${e.seq}`, { id: e.id || null, tool: e.tool, input: e.input, agentId: e.agentId || null, sessionId: e.sessionId, startAt: e.at, doneAt: null, isError: false, deny: null, text: null });
      while (this.tools.size > this.keepSteps * 4) this.tools.delete(this.tools.keys().next().value);
      return;
    }
    if (e.type === 'tool.done') {
      const t = this.tools.get(e.id);
      if (t) Object.assign(t, { doneAt: e.at, isError: !!e.isError, deny: e.deny || null, text: e.text ?? null });
      return;
    }

    const s = this.steps.get(this.stepKey(e));
    if (!s) return;   // a step whose start this server never saw (it was not running)
    switch (e.type) {
      case 'step.first':
        s.firstAt ??= e.at;
        break;
      case 'thinking':
        if (s.thinkingAt === null) s.thinkingAt = e.at;
        s.thinkingLastAt = e.at;
        if (s.lastThinkingBlock !== e.block) { s.thinkingBlocks++; s.lastThinkingBlock = e.block; }
        s.thinkingChars += (e.text || '').length;
        s.thinking = cut(s.thinking + (e.text || ''));
        break;
      case 'text':
        s.visibleAt ??= e.at;
        s.text = cut(s.text + (e.text || ''));
        break;
      case 'tool.begin':
        s.visibleAt ??= e.at;
        s.tools.push({ id: e.id, name: e.name, block: e.block, json: '', at: e.at });
        break;
      case 'tool.input': {
        const t = s.tools.find((x) => x.block === e.block);
        if (t) t.json = cut(t.json + (e.json || ''), 8000);
        break;
      }
      case 'step.stop':
        s.stopAt = e.at;
        s.stopReason = e.stopReason ?? null;
        s.usage = e.usage || null;
        break;
      case 'step.end':
        s.endAt = e.at;
        s.stopReason ??= e.stopReason ?? null;
        s.usage ??= e.usage || null;
        break;
      default:
        break;
    }
  }

  // The step being answered right now: the newest one that has not ended.
  current() {
    const all = [...this.steps.values()];
    for (let i = all.length - 1; i >= 0; i--) if (all[i].endAt === null) return all[i];
    return null;
  }

  since(n, { steps = 30, tools = 60 } = {}) {
    const from = Number(n) || 0;
    const strip = ({ lastThinkingBlock, ...s }) => s;
    return {
      seq: this.seq,
      now: Date.now(),
      lastAt: this.lastAt,
      events: this.events.filter((e) => e.seq > from).map((e) => ({ seq: e.seq, type: e.type, at: e.at, sessionId: e.sessionId, turnId: e.turnId, step: e.step, id: e.id, tool: e.tool })),
      current: this.current() ? strip(this.current()) : null,
      steps: [...this.steps.values()].slice(-steps).map(strip),
      tools: [...this.tools.values()].slice(-tools),
      turns: [...this.turns.values()].slice(-20),
      compacting: this.compacting,
      compactions: this.compactions.slice(-10),
    };
  }

  clear() {
    this.events = [];
    this.steps.clear();
    this.tools.clear();
    this.turns.clear();
    this.compacting = null;
    this.compactions = [];
  }
}
