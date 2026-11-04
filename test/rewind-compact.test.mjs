// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// rewind-compact.test.mjs — what brainstorm shows and builds after a rewind or
// a /compact in claude. No claude: a made-up transcript, written the way
// Claude Code writes them, and a brainstorm with its own BRAINSTORM_HOME.
//
//   node test/rewind-compact.test.mjs
//
// MEASURED on a real session before this test existed: the main context went
// into line 4 -- a message from before two compactions, never sent -- and a
// rewind in claude left the abandoned messages looking sent.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7787;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);
async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(BASE + path, opt);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `${res.status} ${path}`);
  return data;
}
async function until(pred, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(300); }
  return null;
}

const W = mkdtempSync(join(tmpdir(), 'bs-rwc-'));
const SID = '22222222-3333-4444-8555-666666666666';
let n = 0;
const rec = (type, uuid, parentUuid, content, extra = {}) => ({
  type, uuid, parentUuid, sessionId: SID, cwd: W, timestamp: new Date(Date.UTC(2026, 10, 4, 9, 0, ++n)).toISOString(),
  ...(type === 'user' || type === 'assistant' ? { message: { role: type, content } } : {}),
  ...extra,
});
const line = (r) => `${JSON.stringify(r)}\n`;
const src = join(W, `${SID}.jsonl`);
writeFileSync(src, [
  rec('user', 'a1', null, 'old prompt before the compaction'),
  rec('assistant', 'a2', 'a1', [{ type: 'text', text: 'old answer' }]),
  rec('system', 'c0', null, null, { subtype: 'compact_boundary', content: 'Conversation compacted' }),
  rec('user', 's1', 'c0', 'This session is being continued from a previous conversation. Summary one.', { isCompactSummary: true }),
  rec('assistant', 'b1', 's1', [{ type: 'text', text: 'ok' }]),
  rec('user', 'u2', 'b1', 'second prompt'),
  rec('assistant', 'b2', 'u2', [{ type: 'text', text: 'second answer' }]),
].map(line).join(''));

const home = mkdtempSync(join(tmpdir(), 'bs-rwc-home-'));
writeFileSync(join(home, 'settings.json'), JSON.stringify({ autoOpenConsole: false, follow: false, autoRecord: false }));
const srv = spawn(process.execPath, [join(ROOT, 'bin', 'app.mjs'), '--no-window', '--port', String(PORT)], {
  cwd: ROOT, stdio: 'ignore', env: { ...process.env, BRAINSTORM_HOME: home },
});
const blockAt = (st, ln) => st.groups.flatMap((g) => g.blocks).find((b) => b.line === ln);
try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${BASE}/api/version`)).ok; } catch { await sleep(250); } }
  check(up, 'a brainstorm with its own BRAINSTORM_HOME started');

  step('a compacted session: the main context goes into the summary, not before it');
  let st = await api('/api/open', { session: src });
  check(st.totals.notSent === 2, 'the 2 blocks before the compaction are not sent', `${st.totals.notSent}`);
  const m = await api('/api/main', { text: 'MAIN-CONTEXT-FACT' });
  check(m.main.applied && m.main.blockId === blockAt(m.state, 4).id, 'the main context is in the summary (line 4)', `#${m.main.blockId}, summary is #${blockAt(m.state, 4).id}`);
  check(!(await api(`/api/block?id=${blockAt(m.state, 1).id}`)).text.includes('MAIN-CONTEXT-FACT'), 'and NOT in line 1, which claude never sends');

  step('a rewind in claude: the abandoned messages move to Not sent by themselves');
  const epoch0 = (await api('/api/hooks')).sentEpoch;
  // what a rewind leaves: a new prompt whose parent is an EARLIER message
  appendFileSync(src, line(rec('user', 'x1', 'b1', 'rewritten prompt')) + line(rec('assistant', 'x2', 'x1', [{ type: 'text', text: 'new answer' }])));
  const moved = await until(async () => { const h = await api('/api/hooks'); return h.sentEpoch !== epoch0 ? h : null; });
  check(!!moved, 'the server noticed within seconds', moved ? `epoch ${epoch0} -> ${moved.sentEpoch}` : 'never');
  st = await api('/api/state');
  check(st.totals.notSent === 4 && blockAt(st, 6).sent === false && blockAt(st, 7).sent === false, 'the rewound prompt and its answer are now not sent', `${st.totals.notSent} not sent`);
  check(st.stale?.grew === true, 'and the tree says the transcript has newer messages', JSON.stringify(st.stale));

  step('refresh: the new branch becomes blocks; nothing is lost');
  const rf = await api('/api/refresh', {});
  check(!!blockAt(rf.state, 8) && !!blockAt(rf.state, 9), 'the rewritten prompt and its answer are blocks now', `${rf.before} -> ${rf.after} blocks`);
  check(rf.state.main.applied && rf.state.main.blockId === blockAt(rf.state, 4).id, 'the main context is still in the summary');

  step('a /compact in claude: the tree says so; Save & Resume would refresh first');
  const before = await api('/api/hooks');
  appendFileSync(src, [
    rec('system', 'c1', null, null, { subtype: 'compact_boundary', content: 'Conversation compacted' }),
    rec('user', 's2', 'c1', 'This session is being continued from a previous conversation. Summary two.', { isCompactSummary: true }),
    rec('assistant', 'b3', 's2', [{ type: 'text', text: 'ok again' }]),
  ].map(line).join(''));
  const comp = await until(async () => { const h = await api('/api/hooks'); return h.stale?.compacted ? h : null; });
  check(!!comp, 'the server sees the new compaction', comp ? JSON.stringify(comp.stale) : JSON.stringify(before.stale));
  st = await api('/api/state');
  check(blockAt(st, 4).sent === false, 'the old summary is not sent any more');

  step('the main context saved again lands in the NEW summary');
  // saved AFTER the compaction: counted from the transcript as it is now, so a
  // build that refreshes first does not pause it straight away
  await api('/api/main', { text: 'MAIN-CONTEXT-FACT' });
  const b = await api('/api/build', {});
  check(b.ok !== false, 'build ran (it refreshes first: the transcript grew)', (b.out || '').split('\n').find((l) => /verify/.test(l))?.trim() || '');
  st = b.state || (await api('/api/state'));
  // 7 records, 2 from the rewind, then the boundary (L10) and the summary (L11)
  const s2 = blockAt(st, 11);
  check(!!s2 && s2.sent !== false, 'the new summary is a block, and sent', s2 ? `#${s2.id}` : 'none');
  check(st.main.applied && s2 && st.main.blockId === s2.id && !st.main.paused, 'the main context is in it, not paused', JSON.stringify({ applied: st.main.applied, block: st.main.blockId, paused: st.main.paused }));
  const built = readFileSync(join(st.dir, 'built.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const s2rec = built.find((r) => r.uuid === 's2');
  check(!!s2rec && JSON.stringify(s2rec.message.content).includes('MAIN-CONTEXT-FACT'), 'and the built transcript carries it in the summary claude will be sent');
} catch (err) {
  console.error(`\n  ERROR  ${err.stack || err.message}`);
  failures++;
} finally {
  srv.kill();
  await sleep(400);
  for (const d of [W, home]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* held */ } }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
