// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// recorder-concurrency.test.mjs — the recorder stays correct when it is
// started twice at once and when its ticks overlap.
//
//   node test/recorder-concurrency.test.mjs [session.jsonl]
//
// Both happen in real use. Save & Resume starts recording the new session from
// loadWorkspace AND again explicitly, milliseconds apart -- two baselines
// reading one shared offset. And the 500 ms interval can fire while a tick
// that reads a large append is still yielding between slices.
//
// The check is exact: the recording must equal a clean, single-start,
// one-tick-at-a-time run of the same replay, frame for frame.

import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { Recorder } from '../src/core/recorder.mjs';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findRecorded() {
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
      if (size < 200000 || size > 6 * 1024 * 1024) continue;
      const fd = openSync(file, 'r');
      const buf = Buffer.alloc(Math.min(size, 2 * 1024 * 1024));
      readSync(fd, buf, 0, buf.length, 0);
      closeSync(fd);
      const reqs = (buf.toString('utf8').match(/"type":"api-request"/g) || []).length;
      if (reqs >= 6 && (!best || reqs > best.reqs)) best = { file, reqs };
    }
  }
  return best?.file || null;
}

const SRC = process.argv.slice(2).find((a) => a.endsWith('.jsonl')) || findRecorded();
if (!SRC || !existsSync(SRC)) { console.log('  SKIP  no recorded-mode transcript found'); process.exit(0); }
const lines = readFileSync(SRC, 'utf8').split('\n');
if (lines[lines.length - 1] === '') lines.pop();
const startAt = Math.floor(lines.length * 0.4);

// Frames reduced to what must be identical between runs. seq, step ids and
// timestamps legitimately differ; the call a frame belongs to does not.
function shape(rec) {
  const out = rec.since(0);
  const callOf = new Map(out.steps.map((s) => [s.id, s.call]));
  return out.frames.map((f) => `${callOf.get(f.step)}|${f.io}|${f.kind}|${f.line}|${f.toolUseId || ''}|${f.chars}`);
}

async function replay({ doubleStart, overlapTicks }) {
  const work = mkdtempSync(join(tmpdir(), 'bs-rec-cc-'));
  const live = join(work, 'session.jsonl');
  writeFileSync(live, `${lines.slice(0, startAt).join('\n')}\n`);
  const rec = new Recorder({ projectDir: work });
  // Yield every 7 lines, so a second reader really can slip in between
  // slices -- at the default 1,500 a small replay never yields and the test
  // would pass whether or not the guards exist.
  rec.sliceLines = 7;

  // Count the tick timers start() installs: a superseded start must install none.
  const realSetInterval = globalThis.setInterval;
  let timers = 0;
  globalThis.setInterval = (fn, ms, ...a) => { timers++; return realSetInterval(fn, ms, ...a); };
  try {
    if (doubleStart) {
      // exactly what Save & Resume does: one start not awaited, one awaited
      const first = rec.start(live);
      await rec.start(live);
      await first;
    } else {
      await rec.start(live);
    }
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  rec.stopTimer();   // ticks are driven by hand below

  for (let i = startAt; i < lines.length; i += 40) {
    appendFileSync(live, `${lines.slice(i, i + 40).join('\n')}\n`);
    rec.lastGrowth = Date.now();
    if (overlapTicks) {
      // three ticks fired back to back, as an interval does when a tick is slow
      rec.safeTick(); rec.safeTick(); rec.safeTick();
      while (rec.ticking) await sleep(5);
    } else {
      await rec.tick();
    }
  }
  const result = { frames: shape(rec), steps: rec.since(0).steps.length, timers };
  rec.stop();
  try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  return result;
}

console.log(`\n${SRC}\n  ${lines.length} lines, recording from line ${startAt}\n`);
try {
  const clean = await replay({ doubleStart: false, overlapTicks: false });
  console.log(`  clean run: ${clean.steps} step(s), ${clean.frames.length} frame(s)`);
  check(clean.frames.length > 0, 'the clean run recorded something to compare against');

  const both = await replay({ doubleStart: true, overlapTicks: true });
  console.log(`  double start + overlapping ticks: ${both.steps} step(s), ${both.frames.length} frame(s)\n`);
  check(both.timers === 1, 'only the winning start installs a tick timer', `${both.timers} timer(s)`);
  check(both.steps === clean.steps, 'same number of steps as the clean run', `${both.steps} vs ${clean.steps}`);
  check(both.frames.length === clean.frames.length, 'same number of frames as the clean run', `${both.frames.length} vs ${clean.frames.length}`);
  const diff = both.frames.findIndex((f, i) => f !== clean.frames[i]);
  check(diff === -1, 'every frame identical to the clean run, in order', diff === -1 ? '' : `first difference at frame ${diff}`);
  const dupes = both.frames.length - new Set(both.frames).size;
  check(dupes === clean.frames.length - new Set(clean.frames).size, 'no frame duplicated by a second reader', `${dupes} repeated`);
} catch (err) {
  console.error(`\n  ERROR  ${err.stack || err.message}`);
  failures++;
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
