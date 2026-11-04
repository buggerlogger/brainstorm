// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// live-compact.test.mjs — the Live feed through a /compact, and requests that
// never said they ended. No server, no claude.
//
//   node test/live-compact.test.mjs
//
// MEASURED: a /compact sends no turn.step at all -- its model request is the
// compaction's own; the mod reports it through session.compact (35 s, 47,741
// -> 15,602 tokens). A request cut off when /compact was typed never sent its
// end, and stayed "in flight" for good: 109.6 s and counting.

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { LiveFeed } = await import(pathToFileURL(join(ROOT, 'src', 'core', 'live.mjs')).href);
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);
const S = 'sess';
const ev = (at, type, x = {}) => ({ type, at, ...x });

step('a request cut off by /compact is closed by the compaction');
{
  const f = new LiveFeed();
  f.ingest({ sessionId: S, events: [
    ev(1000, 'turn.start', { turnId: 'T1' }),
    ev(1010, 'step.start', { turnId: 'T1', step: 1, model: 'm', messageCount: 38 }),
    ev(2000, 'step.first', { turnId: 'T1', step: 1 }),
  ] });
  check(f.since(0).current?.messageCount === 38, 'the request is in flight');
  f.ingest({ sessionId: S, events: [ev(5000, 'compact.start', { trigger: 'manual', messageCount: 38 })] });
  let r = f.since(0);
  check(r.current === null, 'the compaction closes it: it is not "in flight" any more');
  check(r.steps[0].stopReason === 'interrupted' && r.steps[0].endAt === 5000, 'and says why', `${r.steps[0].stopReason} at ${r.steps[0].endAt}`);
  check(r.compacting && r.compacting.trigger === 'manual' && r.compacting.messageCount === 38, 'the compaction itself is shown while it runs', JSON.stringify(r.compacting));
  f.ingest({ sessionId: S, events: [ev(23000, 'compact.end', { trigger: 'manual', skipped: null, messageCount: 3, tokensBefore: 180000, tokensAfter: 9000 })] });
  r = f.since(0);
  check(r.compacting === null && r.compactions.length === 1, 'when it ends, it is kept with the others');
  const c = r.compactions[0];
  check(c.startAt === 5000 && c.endAt === 23000 && c.tokensBefore === 180000 && c.tokensAfter === 9000 && c.messagesAfter === 3, 'with how long it took and what it left', JSON.stringify({ ms: c.endAt - c.startAt, before: c.tokensBefore, after: c.tokensAfter, messages: c.messagesAfter }));
}

step('the mod now says "aborted" itself; the end of the turn closes the rest');
{
  const f = new LiveFeed();
  f.ingest({ sessionId: S, events: [
    ev(1000, 'step.start', { turnId: 'T2', step: 0, model: 'm', messageCount: 5 }),
    ev(1500, 'step.end', { turnId: 'T2', step: 0, stopReason: 'aborted', usage: null }),
  ] });
  check(f.since(0).current === null && f.since(0).steps[0].stopReason === 'aborted', 'an aborted request is closed, as aborted');
  const g = new LiveFeed();
  g.ingest({ sessionId: S, events: [
    ev(1000, 'step.start', { turnId: 'T3', step: 0, model: 'm', messageCount: 5 }),
    ev(9000, 'turn.end', { turnId: 'T3', reason: 'aborted', durationMs: 8000 }),
  ] });
  check(g.since(0).current === null && g.since(0).steps[0].stopReason === 'aborted', 'an older mod: the end of its turn closes it');
}

step('a newer request closes one that never ended');
{
  const f = new LiveFeed();
  f.ingest({ sessionId: S, events: [
    ev(1000, 'step.start', { turnId: 'T4', step: 0, model: 'm', messageCount: 5 }),
    ev(4000, 'step.start', { turnId: 'T5', step: 0, model: 'm', messageCount: 7 }),
  ] });
  const r = f.since(0);
  check(r.current?.turnId === 'T5', 'the newer one is in flight');
  check(r.steps.find((s) => s.turnId === 'T4').stopReason === 'superseded', 'the older one is closed as superseded');
  const other = new LiveFeed();
  other.ingest({ sessionId: S, events: [
    ev(1000, 'step.start', { turnId: 'T6', step: 0, model: 'm', messageCount: 5 }),
    ev(2000, 'step.start', { turnId: 'A1', step: 0, model: 'm', messageCount: 2, agentId: 'agent-1' }),
  ] });
  check(other.since(0).steps.find((s) => s.turnId === 'T6').endAt === null, 'but a subagent\'s request does not close the main loop\'s');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
