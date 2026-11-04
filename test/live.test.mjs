// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// live.test.mjs — the live feed, the live.json claim, and adopting a running
// terminal. No claude, no network, no window is opened.
//
//   node test/live.test.mjs
//
// 1. LiveFeed folds the mod's events into one record per model request, with
//    the moment of each phase. The sequence below has the shape MEASURED from
//    a real claude -p run through the mod (see live-mod.test.mjs for the real
//    thing): step.start, step.first, tool.begin, tool.input x15, tool.call,
//    step.stop, step.end, tool.done, then a second request with an EMPTY
//    thinking chunk (Claude Code asks for display: "omitted").
// 2. A server never takes live.json from a brainstorm that is running, and
//    claims it once that one is gone.
// 3. 'ensure' adopts a claude already running the session instead of opening
//    a second terminal, and opens nothing when the settings say no terminal.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);

const { LiveFeed } = await import(pathToFileURL(join(ROOT, 'src', 'core', 'live.mjs')).href);

/* ------------------------------------------------------------ 1. the feed --- */
step('one model request, folded');
{
  const feed = new LiveFeed();
  const S = 'sess-1';
  const T = 'turn-1';
  const base = 1000000;
  const ev = (dt, type, x = {}) => ({ type, at: base + dt, turnId: T, ...x });
  const evs = [
    ev(0, 'turn.start', { text: 'read note.txt' }),
    ev(6, 'step.start', { step: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 16 }),
    ev(1352, 'step.first', { step: 0 }),
    ev(1354, 'tool.begin', { step: 0, block: 0, id: 'toolu_A', name: 'Read' }),
    ...Array.from({ length: 15 }, (_, i) => ev(1357 + i * 50, 'tool.input', { step: 0, block: 0, json: i === 0 ? '' : '{"file_path":"x"}'.slice((i - 1) % 5, ((i - 1) % 5) + 1) })),
    ev(2154, 'tool.call', { id: 'toolu_A', tool: 'Read', input: { file_path: 'C:\\work\\note.txt' } }),
    ev(2211, 'step.stop', { step: 0, stopReason: 'tool_use', usage: { input_tokens: 2, output_tokens: 141, cache_read_input_tokens: 0, cache_creation_input_tokens: 41414 } }),
    ev(2243, 'step.end', { step: 0, stopReason: 'tool_use' }),
  ];
  feed.ingest({ sessionId: S, events: evs });
  let r = feed.since(0);
  const s0 = r.steps.find((s) => s.step === 0);
  check(!!s0, 'the request has a record');
  check(s0.messageCount === 16 && s0.model === 'claude-opus-5-5' && s0.effort === 'xhigh', 'it keeps what was sent', `${s0.model} ${s0.effort} ${s0.messageCount} messages`);
  check(s0.sentAt < s0.firstAt && s0.firstAt <= s0.visibleAt && s0.visibleAt < s0.stopAt && s0.stopAt <= s0.endAt,
    'its phases are in order: sent < first chunk <= first visible < stop <= end',
    `wait ${s0.firstAt - s0.sentAt} ms, visible after ${s0.visibleAt - s0.firstAt} ms`);
  check(s0.tools.length === 1 && s0.tools[0].name === 'Read' && s0.tools[0].id === 'toolu_A', 'the tool call it chose is on it, by tool_use_id');
  check(s0.usage?.cache_creation_input_tokens === 41414, 'it carries the usage the API reported', JSON.stringify(s0.usage));
  check(r.current === null, 'nothing is in flight once the request ended');
  const call = r.tools.find((t) => t.id === 'toolu_A');
  check(call && call.input.file_path.endsWith('note.txt') && call.doneAt === null, 'the tool call is kept, running until tool.done arrives');

  feed.ingest({ sessionId: S, events: [
    ev(2796, 'tool.done', { id: 'toolu_A', tool: 'Read', isError: false, text: '1\tnumbers: 21 37 49' }),
    ev(2832, 'step.start', { step: 1, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 22 }),
  ] });
  r = feed.since(0);
  check(r.tools.find((t) => t.id === 'toolu_A').doneAt === base + 2796, 'tool.done closes the call with what came back');
  check(r.current && r.current.step === 1, 'the second request is the one in flight', `messages ${r.current?.messageCount}`);
  check(r.current.firstAt === null, 'before its first chunk it is still "reading the context"');

  // ⛔ block 0 is falsy: an `!last` test counted every chunk of block 0 as a
  // new thinking block. Two chunks of ONE block must count once.
  feed.ingest({ sessionId: S, events: [
    ev(3940, 'step.first', { step: 1 }),
    ev(4273, 'thinking', { step: 1, block: 0, text: '' }),
    ev(4274, 'thinking', { step: 1, block: 0, text: '' }),
    ev(4284, 'text', { step: 1, block: 1, text: '37' }),
    ev(4290, 'step.stop', { step: 1, stopReason: 'end_turn', usage: { input_tokens: 2, output_tokens: 35, cache_read_input_tokens: 41414, cache_creation_input_tokens: 3336 } }),
    ev(4296, 'step.end', { step: 1 }),
    ev(5270, 'turn.end', { reason: 'answer', durationMs: 6098 }),
  ] });
  r = feed.since(0);
  const s1 = r.steps.find((s) => s.step === 1);
  check(s1.thinkingBlocks === 1, 'two chunks of one thinking block count as one block', `${s1.thinkingBlocks}`);
  check(s1.thinkingAt === base + 4273 && s1.thinkingChars === 0, 'an EMPTY thinking chunk still marks when thinking happened (its words are not sent)');
  check(s1.text === '37' && s1.visibleAt === base + 4284, 'the visible text and when it began');
  check(s1.usage.cache_read_input_tokens === 41414, 'the second request read the first one\'s context from the cache', `${s1.usage.cache_read_input_tokens} read, ${s1.usage.cache_creation_input_tokens} new`);
  check(r.turns[0].reason === 'answer' && r.turns[0].durationMs === 6098, 'the turn ended, with its length');
  const later = feed.since(r.seq - 2);
  check(later.events.length === 2, 'since(n) returns only the events after n', `${later.events.length}`);
  check(feed.ingest({ events: [{ nope: 1 }, null, 'x'] }).accepted === 0, 'malformed events are ignored, not stored');

  const bounded = new LiveFeed({ keepSteps: 3 });
  for (let i = 0; i < 10; i++) bounded.ingest({ sessionId: S, events: [{ type: 'step.start', at: i, turnId: 't', step: i }] });
  check(bounded.since(0).steps.length === 3, 'the feed keeps a bounded number of requests', `${bounded.since(0).steps.length}`);
}

/* ------------------------------------------------- 2 + 3. the server side --- */
const home = mkdtempSync(join(tmpdir(), 'bs-live-home-'));
const PORT = 7797;
const BASE = `http://127.0.0.1:${PORT}`;
const liveJson = join(home, 'live.json');
// settings: no terminal pops for a session (this test must never open one)
writeFileSync(join(home, 'settings.json'), JSON.stringify({ autoOpenConsole: false }));
// live.json names a brainstorm that IS running: this test process
writeFileSync(liveJson, JSON.stringify({ port: 1, pid: process.pid, at: new Date().toISOString() }));

async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(BASE + path, opt);
  return { status: res.status, data: await res.json() };
}

const srv = spawn(process.execPath, [join(ROOT, 'bin', 'app.mjs'), '--no-window', '--port', String(PORT)], {
  cwd: ROOT, stdio: 'ignore', env: { ...process.env, BRAINSTORM_HOME: home },
});
const work = mkdtempSync(join(tmpdir(), 'bs-live-work-'));
try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${BASE}/api/version`)).ok; } catch { await sleep(250); } }
  check(up, 'a brainstorm with its own BRAINSTORM_HOME started');

  step('live.json: never taken from a running brainstorm');
  await sleep(500);
  let live = (await api('/api/hooks')).data;
  check(live.claimed === false, 'the server did not claim it', `claimed ${live.claimed}`);
  check(JSON.parse(readFileSync(liveJson, 'utf8')).pid === process.pid, 'the file still names the running one');

  step('...and claimed once that one is gone');
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(liveJson, JSON.stringify({ port: 1, pid: dead, at: new Date().toISOString() }));
  let claimed = null;
  for (let i = 0; i < 24 && !claimed; i++) {
    await sleep(250);
    try { const j = JSON.parse(readFileSync(liveJson, 'utf8')); if (j.port === PORT) claimed = j; } catch { /* being written */ }
  }
  check(!!claimed, 'within a few seconds the file names this server', claimed ? `port ${claimed.port} pid ${claimed.pid}` : 'never');
  live = (await api('/api/hooks')).data;
  check(live.claimed === true, '/api/hooks says it receives the events');

  step('the mod\'s events, posted to /api/hook');
  const posted = await api('/api/hook', { sessionId: 's', events: [
    { type: 'step.start', at: Date.now(), turnId: 't', step: 0, model: 'm', messageCount: 3 },
    { type: 'step.first', at: Date.now() + 5, turnId: 't', step: 0 },
  ] });
  check(posted.status === 200 && posted.data.accepted === 2, 'accepted', JSON.stringify(posted.data));
  live = (await api('/api/hooks?since=0')).data;
  check(live.current && live.current.messageCount === 3 && live.current.firstAt !== null, 'the request is in flight on /api/hooks, past its first chunk');

  step('ensure: adopt a running claude, never open a second one');
  const src = (() => {
    const P = join(homedir(), '.claude', 'projects');
    for (const d of readdirSync(P)) {
      let fs = []; try { fs = readdirSync(join(P, d)); } catch { continue; }
      for (const f of fs) {
        const p = join(P, d, f);
        if (!f.endsWith('.jsonl')) continue;
        try { const z = statSync(p).size; if (z > 20000 && z < 2 * 1024 * 1024) return p; } catch { /* skip */ }
      }
    }
    return null;
  })();
  if (!src) {
    console.log('  SKIP  no transcript on this machine to open');
  } else {
    // a temp COPY, opened by path: nothing under ~/.claude is touched
    const copy = join(work, src.split(/[\\/]/).pop());
    copyFileSync(src, copy);
    const op = await api('/api/open', { session: copy });
    check(op.status === 200 && op.data.open, 'a session is open', op.data.config?.sessionId);
    const sid = op.data.config.sessionId;

    const none = await api('/api/window', { action: 'ensure' });
    check(none.status === 200 && none.data.opened === false && none.data.reused === false, 'with no terminal setting and none running, nothing is opened', JSON.stringify(none.data));

    // a window whose claude is running this session: this process stands in
    const wdir = join(home, 'windows');
    mkdirSync(wdir, { recursive: true });
    writeFileSync(join(wdir, 'feedf00d.meta.json'), JSON.stringify({ tag: 'feedf00d', cwd: work, openedAt: new Date().toISOString(), firstSession: sid }));
    writeFileSync(join(wdir, 'feedf00d.control.json'), JSON.stringify({ resume: sid, seq: 1, stop: false }));
    writeFileSync(join(wdir, 'feedf00d.claude.pid'), String(process.pid));
    const adopt = await api('/api/window', { action: 'ensure' });
    check(adopt.data.reused === true && adopt.data.tag === 'feedf00d', 'the running window is adopted', JSON.stringify(adopt.data));
    const again = await api('/api/window', { action: 'open' });
    check(again.data.reused === true && again.data.tag === 'feedf00d', 'an explicit open of the same session adopts it too, instead of a second claude', JSON.stringify(again.data));
    // the adopted window runs in another folder than the session's own: a
    // switch of it to this session must be refused, not resumed where claude
    // cannot find the session
    let refused = '';
    try { await api('/api/window', { action: 'resume', tag: 'feedf00d', sessionId: sid }); } catch { /* status below */ }
    const rr = await fetch(`${BASE}/api/window`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'resume', tag: 'feedf00d', sessionId: sid }) });
    refused = (await rr.json()).error || '';
    check(/runs in .* belongs to/.test(refused), 'a terminal in another folder is not switched to this session', refused.slice(0, 120));
    const others = readdirSync(wdir).filter((f) => f.endsWith('.meta.json') && !f.startsWith('feedf00d'));
    check(others.length === 0, 'no new window was created', others.join(', '));

    step('a claude that started and said nothing is asking something in its window');
    // the adopted window's claude started (its pid file) after this server did,
    // and no event has come since: what a folder-trust question looks like
    await sleep(8600);
    let h = (await api('/api/hooks')).data;
    check(h.waiting && h.waiting.tag === 'feedf00d', 'the panel is told claude is waiting', JSON.stringify(h.waiting));
    await api('/api/hook', { sessionId: sid, events: [{ type: 'session.start', at: Date.now(), cwd: work }] });
    h = (await api('/api/hooks')).data;
    check(h.waiting === null, 'and not once the session has started', JSON.stringify(h.waiting));
  }
} catch (err) {
  console.error(`\n  ERROR  ${err.stack || err.message}`);
  failures++;
} finally {
  srv.kill();
  await sleep(400);
  for (const d of [home, work]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* still held */ } }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
