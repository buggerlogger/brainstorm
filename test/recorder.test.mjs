// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// recorder.test.mjs — the live recorder agrees with the full tracer.
//
//   node test/recorder.test.mjs [session.jsonl] [--start-pct 60]
//
// A real transcript is replayed as if it were being written: the first part
// is the "past", the recorder starts there, and the rest is appended in small
// chunks with a tick after each, the way a running claude writes it.
//
// Every recorded step is then compared with what traceFlow -- the full tracer,
// validated on 3,566 calls -- says that call added. They must match frame for
// frame. And nothing from before the start may appear: live only.

import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { Recorder } from '../src/core/recorder.mjs';
import { readTranscript } from '../src/core/transcript.mjs';
import { traceFlow } from '../src/core/flow.mjs';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

function findRecorded(maxBytes = 6 * 1024 * 1024) {
  const P = join(homedir(), '.claude', 'projects');
  let best = null;
  for (const d of readdirSync(P)) {
    const dir = join(P, d);
    let st; try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = join(dir, f);
      const size = statSync(file).size;
      if (size < 200000 || size > maxBytes) continue;
      const fd = openSync(file, 'r');
      const buf = Buffer.alloc(Math.min(size, 2 * 1024 * 1024));
      readSync(fd, buf, 0, buf.length, 0);
      closeSync(fd);
      const s = buf.toString('utf8');
      const reqs = (s.match(/"type":"api-request"/g) || []).length;
      if (reqs >= 6 && (!best || reqs > best.reqs)) best = { file, reqs };
    }
  }
  return best?.file || null;
}

const argFile = process.argv.slice(2).find((a) => a.endsWith('.jsonl'));
const pctArg = process.argv.indexOf('--start-pct');
const START_PCT = pctArg > 0 ? Number(process.argv[pctArg + 1]) : 60;
const SRC = argFile || findRecorded();
if (!SRC || !existsSync(SRC)) { console.log('  SKIP  no recorded-mode transcript found'); process.exit(0); }

const lines = readFileSync(SRC, 'utf8').split('\n');
if (lines[lines.length - 1] === '') lines.pop();
const startAt = Math.floor((lines.length * START_PCT) / 100);
console.log(`\n${SRC}\n  ${lines.length} lines; the recorder starts after line ${startAt} (${START_PCT}%)\n`);

// What the full tracer says each call added, for calls after the start.
const records = readTranscript(SRC);
const trace = traceFlow(records, 4);
const reqLines = trace.calls.map((c) => c.line);
// Which call produced an assistant record: its `requestRef` names the
// api-request exactly. Line ranges ("the latest request before this line")
// misplace records written out of order -- 6 of 220 on the session this was
// measured on -- so they are NOT used as ground truth here.
const callOfRequestId = new Map();
records.filter((r) => r.obj?.type === 'api-request').forEach((r, ci) => { if (r.obj.id) callOfRequestId.set(r.obj.id, ci); });
const callOf = (r) => {
  if (r.obj?.requestRef && callOfRequestId.has(r.obj.requestRef)) return callOfRequestId.get(r.obj.requestRef);
  let c = -1;
  for (let i = 0; i < reqLines.length; i++) if (reqLines[i] < r.line) c = i;
  return c;
};
const expected = [];
// Calls whose output arrives after the start. One whose REQUEST was before the
// start is the call in flight: a real step (marked startedBefore), no inputs.
const liveOutputCalls = new Set(records.filter((r) => r.line > startAt && r.obj?.type === 'assistant').map(callOf));
trace.calls.forEach((c, ci) => {
  const inFlight = c.line <= startAt;
  if (inFlight && !liveOutputCalls.has(ci)) return;
  const outputs = [];
  for (const r of records) {
    if (r.line <= startAt || callOf(r) !== ci) continue;
    const o = r.obj;
    if (!o || o.type !== 'assistant' || !o.message) continue;
    const content = o.message.content;
    const parts = typeof content === 'string' ? [content] : (content || []).map((p) => (p.type === 'text' ? p.text : p.type === 'thinking' ? p.thinking : p.type === 'tool_use' ? JSON.stringify(p.input ?? {}, null, 2) : null)).filter((x) => x !== null);
    outputs.push(...parts);
  }
  // An in-flight call is a step only if some of its output arrived live.
  if (inFlight && !outputs.length) return;
  expected.push({ call: ci, outputs });
});

const work = mkdtempSync(join(tmpdir(), 'bs-rec-'));
const live = join(work, 'session.jsonl');
writeFileSync(live, `${lines.slice(0, startAt).join('\n')}\n`);

try {
  const rec = new Recorder({ projectDir: work });
  const t0 = Date.now();
  await rec.start(live);
  rec.stopTimer();          // ticks are driven by hand below, deterministically
  console.log(`  baseline built in ${Date.now() - t0} ms, mode ${rec.mode}, ${rec.calls} past call(s) absorbed`);
  check(rec.since(0).frames.length === 0, 'nothing from before the start is shown (live only)');

  // Append the rest the way claude does: a few records at a time.
  for (let i = startAt; i < lines.length; i += 7) {
    appendFileSync(live, `${lines.slice(i, i + 7).join('\n')}\n`);
    rec.lastGrowth = Date.now();
    await rec.tick();
  }

  const out = rec.since(0);
  const steps = out.steps;
  console.log(`  recorded ${steps.length} step(s), ${out.frames.length} frame(s); the tracer says ${expected.length} call(s) happened after the start\n`);
  check(steps.length === expected.length, 'one recorded step per API call made after the start', `${steps.length} vs ${expected.length}`);

  let callMismatch = 0;
  let outMismatch = 0;
  steps.forEach((s, i) => {
    const e = expected[i];
    if (!e) return;
    const fout = out.frames.filter((f) => f.step === s.id && f.io === 'out').map((f) => f.text);
    const same = (a, b) => a.length === b.length && a.every((x, k) => x === b[k]);
    if (s.call !== e.call) callMismatch++;
    if (!same(fout, e.outputs)) {
      outMismatch++;
      if (outMismatch <= 3) console.log(`    step ${s.id}: outputs ${fout.length} vs expected ${e.outputs.length}`);
    }
  });
  check(callMismatch === 0, 'each step is the right API call', `${callMismatch} mismatched`);
  check(outMismatch === 0, 'every step\'s OUTPUTS match the assistant records that followed the call', `${outMismatch} mismatched`);

  // ---------------------------------------------------------------------------
  // INPUTS, against tool_use_id -- not against the tracer.
  //
  // This used to require the recorder to match traceFlow frame for frame, and
  // it failed on 16 of 45 steps. The tracer was the one that was wrong: it
  // resolves tail hashes BY POSITION, and Claude Code sometimes writes an
  // api-request record before the tool_result records that request already
  // carried (MEASURED: request at L566, one of its results at L567), so every
  // later positional match shifts by one. Judged by tool_use_id, both
  // implementations were wrong on the same 6 of 30 calls.
  //
  // tool_use_id is ground truth that depends on neither: a call's tool results
  // are exactly the answers to the tools the PREVIOUS call asked for.
  // ---------------------------------------------------------------------------
  const resultIds = new Set();
  for (const r of records) {
    const parts = r.obj?.message?.content;
    if (r.obj?.type !== 'user' || !Array.isArray(parts)) continue;
    for (const p of parts) if (p?.type === 'tool_result' && p.tool_use_id) resultIds.add(p.tool_use_id);
  }
  const usesOfCall = (ci) => {
    const ids = [];
    for (const r of records) {
      if (r.obj?.type !== 'assistant' || callOf(r) !== ci) continue;
      const parts = r.obj?.message?.content;
      if (r.obj?.type !== 'assistant' || !Array.isArray(parts)) continue;
      for (const p of parts) if (p?.type === 'tool_use' && p.id && resultIds.has(p.id)) ids.push(p.id);
    }
    return ids;
  };

  let idMismatch = 0;
  let judged = 0;
  const attached = new Map();   // tool_use_id -> steps it was attached to
  for (const s of steps) {
    const got = out.frames.filter((f) => f.step === s.id && f.io === 'in' && f.kind === 'tool_result').map((f) => f.toolUseId);
    for (const id of got) attached.set(id, (attached.get(id) || 0) + 1);
    if (s.call === null || s.call === undefined || s.startedBefore || s.call === 0) continue;
    const want = usesOfCall(s.call - 1);
    judged++;
    const a = new Set(got);
    const okSet = want.length === a.size && want.every((id) => a.has(id));
    if (!okSet) {
      idMismatch++;
      if (idMismatch <= 3) console.log(`    step ${s.id} call ${s.call}: tool results ${[...a].map((x) => x.slice(-6)).join(',') || '-'} vs the previous call's tools ${want.map((x) => x.slice(-6)).join(',') || '-'}`);
    }
  }
  check(idMismatch === 0, 'every step\'s tool results answer exactly the tools the previous call asked for', `${idMismatch} of ${judged} mismatched`);
  const twice = [...attached.values()].filter((n) => n > 1).length;
  check(twice === 0, 'no tool result is shown under two calls', `${twice} duplicated`);

  // Every prompt typed after the start lands in exactly one step.
  const prompts = [];
  for (const r of records) {
    if (r.line <= startAt || r.obj?.type !== 'user') continue;
    const c = r.obj.message?.content;
    const texts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text) : [];
    for (const t of texts) if (t && !t.startsWith('<')) prompts.push(t);
  }
  const shownTexts = out.frames.filter((f) => f.io === 'in' && f.kind === 'text').map((f) => f.text);
  const lost = prompts.filter((t) => !shownTexts.includes(t));
  check(lost.length === 0, 'every prompt typed after the start is shown as an input', `${prompts.length - lost.length}/${prompts.length}`);

  // LIVE ONLY, stated exactly. No PAST call is shown: every step is a call
  // whose request came after the start, or the one call in flight at the
  // start (its output, never its inputs). A frame written before the start
  // may appear only as an INPUT of a live call -- the tool results and the
  // prompt that call sends. (This replaced "the earliest frame is after the
  // start line", which encoded a bug: it required the first live call to be
  // shown with some of its own inputs missing.)
  const pastCalls = trace.calls.filter((c) => c.line <= startAt).length;
  const pastShown = steps.filter((s) => s.call !== null && s.call !== undefined && s.call < pastCalls && !s.startedBefore);
  check(pastShown.length === 0, 'no past call is shown', pastShown.map((s) => `call ${s.call}`).join(', '));
  const inFlightWithInputs = steps.filter((s) => s.startedBefore && s.inputs > 0);
  check(inFlightWithInputs.length === 0, 'the call in flight at the start shows its output only', inFlightWithInputs.map((s) => `call ${s.call}`).join(', '));
  const earlyNotInput = out.frames.filter((f) => f.line <= startAt && f.io !== 'in');
  check(earlyNotInput.length === 0, 'anything written before the start appears only as a live call\'s input', `${earlyNotInput.length} frame(s)`);
  const earlyInputs = out.frames.filter((f) => f.line <= startAt && f.io === 'in');
  if (earlyInputs.length) console.log(`    ${earlyInputs.length} input(s) written just before the start, shown with the live call that sent them`);

  if (steps[0]) {
    const s = steps[0];
    console.log(`\n  first step: call ${s.call}, ${s.inputs} in / ${s.outputs} out, tools ${s.tools.join(', ') || '-'}${s.prompt ? `, prompt "${s.prompt}"` : ''}`);
  }
} catch (err) {
  console.error(`\n  ERROR  ${err.stack || err.message}`);
  failures++;
} finally {
  try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
