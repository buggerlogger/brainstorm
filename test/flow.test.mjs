// Copyright (c) 2026 buggerlogger. All rights reserved.
// Proprietary and confidential. No license is granted to use, copy, modify or
// distribute this file, in whole or in part. See LICENSE.
//
// flow.test.mjs — assert the flow reconstruction against a real transcript.
//
// The claim under test: messages(N) = messages(N-1).slice(0, keep) ++ tail.
// If that is wrong, every frame index in the debugger is wrong, so it is
// checked against a recorded session rather than reasoned about.
//
//   node test/flow.test.mjs <session.jsonl>

import { readTranscript, summarise } from '../src/core/transcript.mjs';
import { traceFlow, indexRequests, probe } from '../src/core/flow.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node test/flow.test.mjs <session.jsonl>');
  process.exit(2);
}

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

const records = readTranscript(file);
const sum = summarise(records);
console.log(`\n${file}`);
console.log(`  ${sum.lines} lines, ${sum.bytes} bytes, ${sum.chainNodes} chain nodes`);
console.log(`  types: ${sum.types.map((t) => `${t.type}x${t.count}`).join(' ')}\n`);

const { shapes, blobs, requests } = indexRequests(records);
check(requests.length > 0, 'found api-request records', `${requests.length}`);
check(shapes.size > 0, 'found api-request-shape records', `${shapes.size}`);

const trace = traceFlow(records, 4.0);
check(trace.calls.length === requests.length, 'one call per api-request');

for (const [i, call] of trace.calls.entries()) {
  console.log(`\n  call ${i} (L${call.line})  keep=${call.keep} tail=${call.tailCount} frames=${call.totals.frames}`);
  console.log(`    chars  system ${call.totals.system}  tools ${call.totals.tools}  conversation ${call.totals.conversation}`);
  check(call.problems.length === 0, `call ${i} resolved every tail hash`, call.problems.join('; '));
  const unresolved = call.frames.filter((f) => f.resolved === 'unresolved');
  check(unresolved.length === 0, `call ${i} has no unresolved frames`, `${unresolved.length}`);
  // keep must never exceed the previous call's message count
  if (i > 0) {
    const prevMsgs = new Set(trace.calls[i - 1].frames.filter((f) => f.path.startsWith('messages.')).map((f) => f.path.split('.')[1]));
    check(call.keep <= prevMsgs.size, `call ${i} keep (${call.keep}) <= previous message count (${prevMsgs.size})`);
  }
  // every frame must be addressable
  check(call.frames.every((f) => f.path), `call ${i} every frame has a path`);
  // the system prompt must come before any message
  const firstMsg = call.frames.findIndex((f) => f.path.startsWith('messages.'));
  const lastSys = call.frames.reduce((acc, f, k) => (f.kind === 'system' ? k : acc), -1);
  check(lastSys < firstMsg || firstMsg === -1, `call ${i} system blocks precede messages`);
}

// ---------------------------------------------------------------------------
// The invariant that catches an off-by-one in positional resolution.
//
// Every conversation message in the transcript must appear in the LAST call's
// message list exactly once. When a blob failed to consume the chain pointer,
// the first prompt appeared twice and the tool_result message appeared zero
// times -- and every per-call check above still passed, because each call was
// internally consistent. Only counting against the chain caught it.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// The keep/tail model, checked against the file's own cross-reference.
//
// cacheControl paths address messages by index: ["messages", 4, "content", 0].
// So the reconstructed list must be at least maxIndex+1 long, and if the model
// is right it is EXACTLY that -- the last cache breakpoint sits on the last
// message. MEASURED across 10 calls of a 195-line session: slice(0,keep)++tail
// gives 5,5,5,5,4,4,4,4,4,4 and every one is tight. An accumulating model
// gives 5,7,9,11,14,16,18,20,22,24 and is never tight, so it is wrong.
//
// This replaced a chain-coverage check that assumed every recorded message
// stays in context. It does not: that session re-packs its history and drops
// old turns, so messages legitimately leave the window.
// ---------------------------------------------------------------------------
console.log('\n  keep/tail model vs cacheControl indices:');
{
  let tight = 0;
  let short = 0;
  let noMarks = 0;
  for (const [i, call] of trace.calls.entries()) {
    const idxs = new Set();
    for (const f of call.frames) {
      const m = f.path.match(/^messages\.(\d+)/);
      if (m) idxs.add(Number(m[1]));
    }
    const listLen = idxs.size ? Math.max(...idxs) + 1 : 0;
    const req = records.find((r) => r.line === call.line)?.obj;
    let maxMark = -1;
    for (const c of req?.cacheControl || []) {
      if (Array.isArray(c.path) && c.path[0] === 'messages') maxMark = Math.max(maxMark, c.path[1]);
    }
    if (maxMark < 0) { noMarks++; continue; }
    const need = maxMark + 1;
    if (need > listLen) { short++; console.log(`    SHORT  call ${i}: cacheControl needs ${need} messages, model built ${listLen}`); }
    else if (need === listLen) tight++;
    else console.log(`    loose  call ${i}: needs ${need}, model built ${listLen}`);
  }
  console.log(`    ${tight} tight, ${short} short, ${noMarks} without message-level cache marks`);
  check(short === 0, 'no call is missing messages the cacheControl addresses', `${short} short`);
  check(tight > 0, 'the message-list length matches the last cache breakpoint', `${tight} tight call(s)`);
}

const last = trace.calls[trace.calls.length - 1];
if (last) {
  // Informational: context legitimately drops turns, so this is reported, not
  // asserted. A number that moves when you change the model is still useful.
  const frameText = last.frames.filter((f) => f.path.startsWith('messages.')).map((f) => f.text);
  let absent = 0;
  for (const m of trace.chain) {
    const texts = m.parts.map((p) => p.text).filter((t) => t && t.length >= 8);
    if (!texts.length) continue;
    if (!texts.every((w) => frameText.some((t) => t === w || t.includes(w)))) absent++;
  }
  console.log(`\n  ${trace.chain.length} chain messages, ${absent} of them no longer in the final call's context`);
  const resolutions = new Map();
  for (const f of last.frames) resolutions.set(f.resolved, (resolutions.get(f.resolved) || 0) + 1);
  console.log(`  frame resolution mix: ${[...resolutions].map(([k, v]) => `${k}x${v}`).join(' ')}`);
}

// probe must find a string that is definitely in context: the first user text.
const firstUserFrame = trace.calls[0]?.frames.find((f) => f.path.startsWith('messages.') && f.text.length > 20);
if (firstUserFrame) {
  const needle = firstUserFrame.text.slice(0, 24);
  const hits = probe(trace, needle);
  check(hits.length > 0, 'probe finds a known in-context string', `${hits.length} frame(s) for ${JSON.stringify(needle)}`);
  console.log(`\n  probe ${JSON.stringify(needle)}:`);
  for (const h of hits.slice(0, 8)) console.log(`    call ${h.call} ${h.path.padEnd(26)} ${h.kind.padEnd(12)} x${h.occurrences} (L${h.line})`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
