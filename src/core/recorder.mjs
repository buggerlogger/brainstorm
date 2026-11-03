// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// recorder.mjs — record what a running Claude session does, as it does it.
//
// LIVE ONLY. Recording starts at the END of the transcript: nothing that
// happened before it is shown. The old follow mode re-traced the WHOLE file on
// every event and replayed old messages one by one; MEASURED, a full re-trace
// of a 44 MB session is 17 s, during which the server answered nothing. This
// reads only the bytes appended since the last look.
//
// What a STEP is. One model call: the new input that went in, then the output
// that came back.
//
//   recorded mode       the transcript has api-request records (keep + tail).
//                       A step starts at each api-request; its inputs are the
//                       tail messages that call appended, minus assistant
//                       messages (those were already shown as the previous
//                       step's output). Outputs are the assistant records that
//                       follow, until the next api-request.
//   reconstructed mode  no request records. Inputs are user / tool_result
//                       records; outputs are assistant records; a new step
//                       starts when input arrives after output.
//
// The state needed to resolve a recorded call (blobs, the message chain, the
// previous call's list) is built from the whole file once, at start, in
// slices that yield to the event loop -- so even that never freezes the app.

import { openSync, readSync, closeSync, fstatSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { CONVERSATION_TYPES } from './transcript.mjs';

const TEXT_CAP = 200000;          // per frame, sent to the page once
const SLICE_LINES = 1500;         // baseline parsing, per event-loop turn

const firstLine = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > 140 ? `${t.slice(0, 137)}...` : t;
};

// Parts of an API-shaped message -- a record's message or a stored blob, which
// have the same shape. The ids are kept: tool_use.id and tool_result's
// tool_use_id are what tie a result to the call that asked for it.
function partsOfMessage(message) {
  const c = message?.content;
  if (typeof c === 'string') return [{ kind: 'text', text: c }];
  if (!Array.isArray(c)) return [];
  return c.map((p) => {
    if (p == null) return null;
    if (p.type === 'text') return { kind: 'text', text: p.text || '' };
    if (p.type === 'thinking') return { kind: 'thinking', text: p.thinking || '' };
    if (p.type === 'tool_use') return { kind: 'tool_use', tool: p.name, id: p.id || null, text: JSON.stringify(p.input ?? {}, null, 2) };
    if (p.type === 'tool_result') {
      const v = p.content;
      const text = typeof v === 'string' ? v
        : Array.isArray(v) ? v.map((x) => (x && x.type === 'text' ? x.text : '')).join('\n') : JSON.stringify(v ?? '');
      return { kind: 'tool_result', toolUseId: p.tool_use_id || null, text };
    }
    // An image is base64; as a "frame" it would be megabytes of noise.
    if (p.type === 'image') return { kind: 'image', text: '[image]' };
    return { kind: p.type || 'unknown', text: typeof p.text === 'string' ? p.text : JSON.stringify(p) };
  }).filter(Boolean);
}

// Identity of an input within one step, so the same thing arriving twice --
// once inside the request's stored blob, once as its own record -- shows once.
const inputKey = (p) => (p.kind === 'tool_result' && p.toolUseId ? `tr:${p.toolUseId}` : `${p.kind}:${p.text}`);

// The same identity, hashed, for the recording-wide "has this ever existed"
// set: on a 44 MB session that set would otherwise hold every message twice.
const hashKey = (p) => createHash('sha1').update(inputKey(p)).digest('base64').slice(0, 20);

export class Recorder {
  constructor({ projectDir, onEvent = () => {} } = {}) {
    this.projectDir = projectDir;
    this.onEvent = onEvent;
    this.recording = false;
    this.file = null;
    this.frames = [];
    this.steps = [];
    this.seq = 0;
    this.status = 'idle';
    this.timer = null;
    this.sizes = new Map();       // every top-level session file -> last seen size
    this.lastGrowth = 0;
    // Step ids only ever go up. They used to be steps.length + 1, so removing a
    // step let the next one REUSE its id -- and the page, which files frames by
    // step id, would merge two different steps into one.
    this.stepSeq = 0;
    // A later start() supersedes an earlier one that is still reading its
    // baseline. Save & Resume used to start the recorder twice on the same
    // file within milliseconds; both baselines then ran interleaved over one
    // shared read offset, and both installed a tick timer.
    this.gen = 0;
    this.ticking = false;
    // Lines parsed per event-loop turn. A test lowers it to force the yields
    // where two readers could interleave; at 1,500 a small replay never yields.
    this.sliceLines = SLICE_LINES;
    this.resetState();
  }

  resetState() {
    this.offset = 0;
    this.decoder = new StringDecoder('utf8');
    this.partial = '';
    this.line = 0;
    this.mode = 'reconstructed';
    this.blobs = new Map();
    this.calls = 0;
    this.live = false;            // false while building baseline state
    this.cur = null;              // the step being filled
    this.toolOwner = new Map();   // tool_use id -> index of the call that output it
    this.stepByCall = new Map();  // call index -> its recorded step
    this.pending = [];            // inputs written before the call that sends them
    this.requestCall = new Map(); // api-request id -> call index (assistant.requestRef points here)
    this.seenInputs = new Set();  // hashed keys of every input that has existed, live or not
    this.tailInputs = [];         // baseline inputs written since the last past request
    // tool_use ids whose result is already on screen. A result is the input of
    // exactly ONE call; a later request that re-sends it must not show it again.
    this.shownResults = new Set();
  }

  // ------------------------------------------------------------ lifecycle --

  async start(file) {
    const gen = ++this.gen;
    this.stopTimer();
    this.file = file || this.file;
    if (!this.file || !existsSync(this.file)) throw new Error(`nothing to record: ${this.file}`);
    this.resetState();
    this.frames = [];
    this.steps = [];
    this.recording = true;
    this.status = 'starting';
    await this.consumeTo(statSync(this.file).size, false, gen);   // baseline: state only
    if (gen !== this.gen) return;   // superseded: a newer start owns the state now
    this.adoptBaselineTail();
    this.live = true;
    this.status = 'recording';
    this.snapshotSizes();
    this.emit('started', { file: this.file, session: basename(this.file, '.jsonl'), mode: this.mode });
    this.timer = setInterval(() => this.safeTick(), 500);
    this.timer.unref?.();
  }

  // ⛔ One tick at a time. The interval fires every 500 ms but a tick that
  // reads a large append yields between slices, so a second tick could start
  // while the first was still reading -- two readers over one offset, which
  // duplicates or skips lines.
  safeTick() {
    if (this.ticking) return;
    this.ticking = true;
    this.tick()
      .catch((err) => this.emit('error', { message: err.message }))
      .finally(() => { this.ticking = false; });
  }

  stop() {
    this.gen++;                     // an in-progress start must not install a timer after this
    this.stopTimer();
    this.recording = false;
    this.status = 'stopped';
    this.emit('stopped', {});
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  clear() {
    this.frames = [];
    this.steps = [];
    this.cur = null;
  }

  // ------------------------------------------------------------------ io --

  snapshotSizes() {
    if (!this.projectDir || !existsSync(this.projectDir)) return;
    for (const f of readdirSync(this.projectDir)) {
      if (!f.endsWith('.jsonl')) continue;
      try { this.sizes.set(join(this.projectDir, f), statSync(join(this.projectDir, f)).size); } catch { /* gone */ }
    }
  }

  // Read appended bytes up to `end` and process complete lines. `gen` is the
  // start() that owns this read; if a newer start() has begun, this one stops
  // at its next yield instead of carrying on over state it no longer owns.
  async consumeTo(end, live, gen = this.gen) {
    const fd = openSync(this.file, 'r');
    try {
      const size = Math.min(end, fstatSync(fd).size);
      if (size < this.offset) {
        // The file shrank: it was rewritten. Start over from its new end.
        this.resetState();
        this.offset = size;
        return;
      }
      const CHUNK = 4 * 1024 * 1024;
      let pending = [];
      while (this.offset < size) {
        const len = Math.min(CHUNK, size - this.offset);
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, this.offset);
        this.offset += n;
        const text = this.partial + this.decoder.write(buf.subarray(0, n));
        const parts = text.split('\n');
        this.partial = parts.pop();
        pending = pending.concat(parts);
        // Process in slices, yielding so a 44 MB baseline never freezes the
        // server.
        while (pending.length >= this.sliceLines) {
          this.processLines(pending.splice(0, this.sliceLines), live);
          await new Promise((r) => setImmediate(r));
          if (gen !== this.gen) return;
        }
      }
      if (gen !== this.gen) return;
      if (pending.length) this.processLines(pending, live);
    } finally {
      closeSync(fd);
    }
  }

  async tick() {
    if (!this.recording || !this.file) return;
    // Which file is live? Normally this one. If another session file in the
    // project grows while this one is quiet, claude has moved to it (a fresh
    // session, or a resume that forked) -- follow it.
    let active = this.file;
    let activeFrom = 0;
    if (this.projectDir && existsSync(this.projectDir) && Date.now() - this.lastGrowth > 3000) {
      for (const f of readdirSync(this.projectDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = join(this.projectDir, f);
        let size;
        try { size = statSync(p).size; } catch { continue; }
        const prev = this.sizes.get(p);
        this.sizes.set(p, size);
        if (p === this.file || active !== this.file) continue;
        if (prev !== undefined && size > prev) {
          // Record from where it WAS: the growth that made it the live file
          // is the first thing to show, not something to skip.
          active = p;
          activeFrom = prev;
        } else if (prev === undefined) {
          // A brand-new file. A fresh session starts tiny: record all of it. A
          // resume fork starts with the whole old conversation copied in --
          // that copy is history, not something that just happened, so it is
          // followed from its size NOW. Ignoring a big new file outright left
          // the recording silent while claude carried on writing there.
          active = p;
          activeFrom = size < 64 * 1024 ? 0 : size;
        }
      }
    }
    const gen = this.gen;
    if (active !== this.file) await this.switchTo(active, activeFrom);
    if (gen !== this.gen) return;
    const size = statSync(this.file).size;
    if (size > this.offset) {
      this.lastGrowth = Date.now();
      await this.consumeTo(size, true, gen);
    }
  }

  // Follow a different file: build its state from the start, then record
  // everything after `liveFrom` bytes.
  async switchTo(file, liveFrom) {
    const gen = this.gen;
    this.file = file;
    this.resetState();
    this.live = false;
    await this.consumeTo(Math.max(0, liveFrom), false, gen);
    if (gen !== this.gen) return;
    this.adoptBaselineTail();
    this.live = true;
    this.emit('switched', { file, session: basename(file, '.jsonl') });
  }

  // ⛔ The first live call is shown WHOLE. Inputs written just before
  // recording began -- the tool results a call is about to send, a prompt
  // typed while the previous call was finishing -- belong to the NEXT call,
  // which is live. They used to be dropped with the rest of the baseline, so
  // the first call appeared to send 1 of its 3 tool results (MEASURED on a real
  // session: call 86, results 68JXx7 and 5JKe5x written before the start,
  // WPf4eN after). "Live only" means no past CALLS, not a cut-off first call.
  adoptBaselineTail() {
    const last = this.calls - 1;
    for (const it of this.tailInputs) {
      const p = it.part;
      if (p.kind === 'tool_result' && p.toolUseId) {
        // Answers the last past call: it goes out with the next one. Answers an
        // older call: that call's successor is in the past too -- history.
        if (this.toolOwner.get(p.toolUseId) === last) this.pending.push(it);
        continue;
      }
      this.pending.push(it);
    }
    this.tailInputs = [];
  }

  // ----------------------------------------------------------- records --

  processLines(lines, live) {
    for (const raw of lines) {
      this.line++;
      if (!raw.trim()) continue;
      let o;
      try { o = JSON.parse(raw); } catch { continue; }
      this.processRecord(o, this.line, live);
    }
  }

  processRecord(o, line, live) {
    if (o.type === 'api-request-blob' && o.hash) { this.blobs.set(o.hash, o.message || {}); return; }
    if (o.type === 'api-request') {
      if (live && this.mode !== 'recorded') this.adoptReconstructed();
      this.mode = 'recorded';
      this.onRequest(o, line, live);
      return;
    }
    if (!CONVERSATION_TYPES.has(o.type) || !o.message) return;
    const role = o.message.role || o.type;
    const parts = partsOfMessage(o.message);
    if (!parts.length) return;

    if (this.mode === 'recorded') {
      if (role === 'assistant') {
        // Which call produced this? `requestRef` names its api-request exactly.
        // MEASURED: 218 of 218 assistant records carry one that matches an
        // api-request id, while "the latest request before this line" put 6 of
        // them under the wrong call -- the same write-order race as above.
        const call = o.requestRef && this.requestCall.has(o.requestRef)
          ? this.requestCall.get(o.requestRef)
          : this.calls - 1;
        for (const p of parts) if (p.kind === 'tool_use' && p.id) this.toolOwner.set(p.id, call);
        if (!live || call < 0) return;
        let step = this.stepByCall.get(call);
        if (!step) {
          // ⛔ The call was IN FLIGHT when recording started: its request is in
          // the past, its output is arriving now. It is that call finishing,
          // not a new one -- opening a fresh step shifted every later step by
          // one, measured on a real transcript replay. If live steps already
          // exist (its output was written late), it still goes FIRST.
          const hadLive = this.steps.length > 0;
          const keepCur = this.cur;
          step = this.trackStep(this.newStep(call, line, { startedBefore: true }));
          if (hadLive) {
            this.steps.splice(this.steps.indexOf(step), 1);
            this.steps.unshift(step);
            this.cur = keepCur;
          }
        }
        for (const p of parts) this.pushFrame(step, p, 'out', role, line);
        return;
      }
      if (live) this.routeInputs(parts, role, line);
      else {
        for (const p of parts) {
          this.seenInputs.add(hashKey(p));
          // kept in case they turn out to be the first live call's inputs
          this.tailInputs.push({ part: p, role, line });
        }
      }
      return;
    }

    if (!live) return;
    // reconstructed: inputs and outputs straight from the records
    if (role === 'assistant') {
      if (!this.cur) this.newStep(null, line);
      this.addFrames(parts, 'out', role, line);
    } else {
      if (!this.cur || this.cur.outputs > 0) this.newStep(null, line);
      // Note what is now on screen, so the first request record -- which
      // re-sends this history in its blobs -- is not taken for new input.
      // MEASURED: without this a tool result showed under a step with no
      // call AND under call 0, on two sessions recorded from 10%.
      for (const p of parts) this.seenInputs.add(hashKey(p));
      this.addFrames(parts, 'in', role, line);
    }
  }

  // ⛔ INPUTS ARE ATTRIBUTED BY ID, NOT BY POSITION.
  //
  // This used to resolve each tail hash positionally against the message
  // chain, like the full tracer does. MEASURED against tool_use_id on a real
  // transcript, that was wrong on 6 of 30 calls -- for the tracer too --
  // because Claude Code sometimes writes an api-request record BEFORE the
  // tool_result records that request already carried (request at L566, one of
  // its results at L567). Every later positional match then shifts by one.
  //
  // Ids do not care about write order:
  //   a tool_result answers a tool_use; the call that OUTPUT the tool_use is
  //   known, so the result is an input to the call after it -- attached there
  //   whether that call's record was written before the result or after.
  //   other input (a prompt, a notification) goes to the next call, or to the
  //   call in flight if that call has not produced any output yet.
  //   injected context (system-reminder bundles and the like) comes from the
  //   request's own tail blobs, which are exact by hash.
  onRequest(o, line, live) {
    const ci = this.calls++;
    if (o.id) this.requestCall.set(o.id, ci);
    if (!live) {
      // Inputs before this past request went out with it: history.
      this.tailInputs = [];
      // Remember what already existed, so a later request that re-sends it is
      // not mistaken for something new.
      for (const h of o.tail || []) {
        const blob = this.blobs.get(h);
        if (blob) for (const p of partsOfMessage(blob)) this.seenInputs.add(hashKey(p));
      }
      return;
    }
    const step = this.trackStep(this.newStep(ci, line, { keep: Number.isInteger(o.keep) ? o.keep : 0, model: o.params?.model || null }));
    for (const it of this.pending) this.attachInput(step, it.part, it.role, it.line);
    this.pending = [];
    for (const h of o.tail || []) {
      const blob = this.blobs.get(h);
      if (!blob || blob.role === 'assistant') continue;   // assistant turns were shown as outputs
      for (const p of partsOfMessage(blob)) {
        // ⛔ A tail blob is not always new. A request that REBUILDS its message
        // list re-sends history as fresh blobs -- MEASURED: one call carried
        // 93 old tool results that way, and they all showed up as its input.
        // A tool result is new only if it answers the previous call; anything
        // else from a blob is new only if it has never existed before.
        if (p.kind === 'tool_result' && p.toolUseId && this.shownResults.has(p.toolUseId)) continue;
        if (p.kind === 'tool_result' && p.toolUseId && this.toolOwner.has(p.toolUseId)) {
          if (this.toolOwner.get(p.toolUseId) !== ci - 1) continue;
        } else if (this.seenInputs.has(hashKey(p))) {
          continue;
        }
        this.attachInput(step, p, blob.role || 'user', line);
      }
    }
  }

  trackStep(step) {
    if (step.call !== null && step.call !== undefined) this.stepByCall.set(step.call, step);
    return step;
  }

  // ⛔ A session's FIRST request record is written after the prompt it sends.
  // Recording a fresh session therefore starts in reconstructed mode (no
  // request records yet), files the prompt under a step with no call, and
  // then the request arrives. MEASURED on a real session started at 10%: 11
  // steps for 10 calls, every later step attributed to the wrong call. Steps
  // that are still waiting for their output were this request's input; their
  // frames are re-filed under it, and the phantom steps removed.
  adoptReconstructed() {
    const orphans = this.steps.filter((s) => (s.call === null || s.call === undefined) && s.outputs === 0);
    if (!orphans.length) return;
    const ids = new Set(orphans.map((s) => s.id));
    for (const f of this.frames) {
      if (!ids.has(f.step)) continue;
      this.pending.push({ part: { kind: f.kind, text: f.text, tool: f.tool, toolUseId: f.toolUseId, id: f.toolUseId }, role: f.role, line: f.line });
    }
    this.frames = this.frames.filter((f) => !ids.has(f.step));
    this.steps = this.steps.filter((s) => !ids.has(s.id));
    if (this.cur && ids.has(this.cur.id)) this.cur = null;
    this.emit('rewired', { removedSteps: [...ids] });
  }

  routeInputs(parts, role, line) {
    for (const p of parts) {
      let target = null;
      if (p.kind === 'tool_result' && p.toolUseId && this.shownResults.has(p.toolUseId)) continue;
      const owner = p.kind === 'tool_result' && p.toolUseId ? this.toolOwner.get(p.toolUseId) : undefined;
      if (owner !== undefined) {
        // The call after the one that asked. If its record is already in, this
        // result was written late; attach it there. If not, it waits.
        const sentBy = owner + 1;
        if (sentBy < this.calls) {
          target = this.stepByCall.get(sentBy) || null;
          // ⛔ Its request exists but is in the PAST (no live step): the result
          // went out with a call that is history. It used to be parked as
          // pending and then pinned onto the next live call -- the wrong one,
          // and shown under two calls once that call's blob carried it too.
          if (!target) continue;
        }
      } else if (this.cur && this.cur.call !== null && this.cur.outputs === 0) {
        // Arrived while a call is in flight with nothing back yet: it went out
        // with that call.
        target = this.cur;
      }
      if (target) this.attachInput(target, p, role, line);
      else this.pending.push({ part: p, role, line });
    }
  }

  attachInput(step, p, role, line) {
    if (!step.keys) Object.defineProperty(step, 'keys', { value: new Set(), enumerable: false });
    const key = inputKey(p);
    if (step.keys.has(key)) return;            // already there, from the blob or the record
    step.keys.add(key);
    this.seenInputs.add(hashKey(p));
    this.pushFrame(step, p, 'in', role, line);
  }

  // ------------------------------------------------------------- output --

  newStep(call, line, extra = {}) {
    const step = {
      id: ++this.stepSeq,
      at: new Date().toISOString(),
      mode: this.mode,
      call,
      line,
      inputs: 0,
      outputs: 0,
      chars: 0,
      first: null,
      tools: [],
      prompt: null,
      ...extra,
    };
    this.steps.push(step);
    this.cur = step;
    this.emit('step', { step: step.id, call });
    return step;
  }

  addFrames(parts, io, role, line) {
    if (!this.cur) this.newStep(null, line);
    for (const p of parts) this.pushFrame(this.cur, p, io, role, line);
    // keep memory bounded on a very long recording
    if (this.frames.length > 20000) this.frames.splice(0, this.frames.length - 20000);
  }

  // One frame into a given step -- not necessarily the current one: a result
  // written late belongs to the call that sent it, which may be behind `cur`.
  pushFrame(s, p, io, role, line) {
    const text = p.text || '';
    const f = {
      seq: ++this.seq,
      step: s.id,
      io,
      role,
      kind: p.kind,
      tool: p.tool || null,
      toolUseId: p.toolUseId || p.id || null,
      chars: text.length,
      label: `${io === 'in' ? '→' : '←'} ${role} ${p.kind}${p.tool ? ` ${p.tool}` : ''}`,
      detail: firstLine(text),
      text: text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text,
      truncated: text.length > TEXT_CAP,
      line,
      at: new Date().toISOString(),
    };
    this.frames.push(f);
    if (io === 'in' && p.kind === 'tool_result' && f.toolUseId) this.shownResults.add(f.toolUseId);
    if (io === 'in') s.inputs++; else s.outputs++;
    s.chars += text.length;
    if (s.first === null) s.first = f.seq;
    if (p.tool && !s.tools.includes(p.tool)) s.tools.push(p.tool);
    if (io === 'in' && role === 'user' && p.kind === 'text' && !s.prompt && !text.startsWith('<')) s.prompt = firstLine(text).slice(0, 90);
  }

  emit(type, data) { this.onEvent({ type, at: new Date().toISOString(), ...data }); }

  since(n) {
    const from = Number(n) || 0;
    return {
      recording: this.recording,
      status: this.status,
      file: this.file,
      session: this.file ? basename(this.file, '.jsonl') : null,
      mode: this.mode,
      seq: this.seq,
      steps: this.steps,
      frames: this.frames.filter((f) => f.seq > from),
      // Typed (or otherwise written) but not sent with any call yet -- a
      // prompt waiting for its request, or an interrupt that ended the
      // session. Shown as the next call, so an action in the terminal is
      // never invisible just because no call has carried it yet.
      pending: this.live ? this.pending.map((it) => ({ kind: it.part.kind, role: it.role, line: it.line, toolUseId: it.part.toolUseId || null, detail: firstLine(it.part.text), text: String(it.part.text || '').slice(0, TEXT_CAP) })) : [],
    };
  }
}
