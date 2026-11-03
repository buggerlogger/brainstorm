// Copyright (c) 2026 buggerlogger. All rights reserved.
// Proprietary and confidential. No license is granted to use, copy, modify or
// distribute this file, in whole or in part. See LICENSE.
//
// sweep.mjs — run the flow model over every transcript on this machine.
//
//   node test/sweep.mjs [--max-mb 40]
//
// One transcript proves a model is possible; a sweep proves it is not a
// coincidence. Two separate reconstruction bugs here passed every per-call
// check on the session they were written against and only showed up on the
// next session, so the sweep is the real gate.

import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { readTranscript } from '../src/core/transcript.mjs';
import { traceFlow } from '../src/core/flow.mjs';

const MAX_MB = Number((process.argv.find((a) => a.startsWith('--max-mb=')) || '').split('=')[1] || 40);
const P = join(homedir(), '.claude', 'projects');

function hasRequests(file, size) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(2 * 1024 * 1024, size));
    readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8').includes('"api-request-shape"');
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

const all = [];
for (const d of readdirSync(P)) {
  const dir = join(P, d);
  let st;
  try { st = statSync(dir); } catch { continue; }
  if (!st.isDirectory()) continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const file = join(dir, f);
    const size = statSync(file).size;
    if (size > MAX_MB * 1024 * 1024) continue;
    all.push({ file, size, recorded: hasRequests(file, size) });
  }
}

const recorded = all.filter((x) => x.recorded);
console.log(`\n${all.length} transcripts under ${MAX_MB} MB; ${recorded.length} record api-request data\n`);

let calls = 0;
let tight = 0;
let loose = 0;
let short = 0;
let unresolved = 0;
let traced = 0;
const problems = [];

for (const { file } of recorded) {
  let records;
  let trace;
  try {
    records = readTranscript(file);
    trace = traceFlow(records, 4.98);
  } catch (err) {
    problems.push(`${basename(file)}  threw: ${err.message}`);
    continue;
  }
  if (trace.mode !== 'recorded') continue;
  traced++;
  const byLine = new Map(records.map((r) => [r.line, r.obj]));
  for (const [i, c] of trace.calls.entries()) {
    calls++;
    unresolved += c.frames.filter((f) => f.resolved === 'unresolved').length;
    const idxs = new Set();
    for (const f of c.frames) {
      const m = f.path.match(/^messages\.(\d+)/);
      if (m) idxs.add(Number(m[1]));
    }
    const listLen = idxs.size ? Math.max(...idxs) + 1 : 0;
    let mx = -1;
    for (const cc of byLine.get(c.line)?.cacheControl || []) {
      if (Array.isArray(cc.path) && cc.path[0] === 'messages') mx = Math.max(mx, cc.path[1]);
    }
    if (mx < 0) continue;
    const need = mx + 1;
    if (need > listLen) {
      short++;
      if (problems.length < 10) problems.push(`${basename(file)} call ${i}: cacheControl needs ${need} messages, model built ${listLen}`);
    } else if (need === listLen) tight++;
    else loose++;
  }
}

console.log(`traced            ${traced} transcripts, ${calls} API calls`);
console.log(`cache-index fit   tight ${tight}   loose ${loose}   SHORT ${short}`);
console.log(`unresolved frames ${unresolved}`);
if (problems.length) {
  console.log('\nproblems:');
  for (const p of problems) console.log(`  ${p}`);
} else {
  console.log('\nno problems');
}

// A SHORT call means the model built a message list the file's own
// cacheControl contradicts: that is a wrong model and it fails the sweep.
//
// An unresolved FRAME is different. It is one tail hash the resolver could not
// name, and it is labelled `unresolved` everywhere it surfaces -- in the tree,
// the frame detail and the CLI -- so it misleads nobody. Baseline on this
// machine after the hash-memo fix: 3 frames across 3,566 calls, one each in
// three sessions that this tool itself built and then resumed. The sweep
// fails if that grows, rather than demanding a zero it has not earned.
const UNRESOLVED_BUDGET = 10;
if (unresolved > UNRESOLVED_BUDGET) {
  console.log(`\nunresolved frames ${unresolved} exceeds the budget of ${UNRESOLVED_BUDGET}`);
}
console.log('');
process.exit(short === 0 && !problems.length && unresolved <= UNRESOLVED_BUDGET ? 0 : 1);
