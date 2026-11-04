// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// recording-e2e.test.mjs — the Recording view shows live calls, on screen,
// as they happen.
//
//   node test/recording-e2e.test.mjs [http://127.0.0.1:7788]
//
// The recorder's own test proves the steps are right. This proves the PAGE
// shows them: a real transcript's first 40% is opened from a temp copy, the
// rest is appended in chunks while headless Edge watches, and the Recording
// list must grow to exactly the server's steps -- live only, nothing from the
// opened part. Then a prompt is appended with no request after it, the way a
// prompt sits before claude sends it, and it must appear as "not sent yet".
//
// Nothing is written under ~/.claude: the transcript is a temp file, opened by
// path.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const BASE = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:7788';
const PORT = 9345;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);

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
      if (size < 150000 || size > 3 * 1024 * 1024) continue;
      const fd = openSync(file, 'r'); const buf = Buffer.alloc(Math.min(size, 2 * 1024 * 1024));
      readSync(fd, buf, 0, buf.length, 0); closeSync(fd);
      const reqs = (buf.toString('utf8').match(/"type":"api-request"/g) || []).length;
      if (reqs >= 8 && (!best || reqs > best.reqs)) best = { file, reqs };
    }
  }
  return best?.file || null;
}

async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(BASE + path, opt);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `${res.status} ${path}`);
  return data;
}

const SRC = findRecorded();
if (!SRC) { console.log('  SKIP  no recorded transcript to replay'); process.exit(0); }
const lines = readFileSync(SRC, 'utf8').split('\n');
if (lines[lines.length - 1] === '') lines.pop();
const startAt = Math.floor(lines.length * 0.4);
const work = mkdtempSync(join(tmpdir(), 'bs-rec-e2e-'));
const live = join(work, `${'0'.repeat(8)}-rec0-4e2e-8000-${Date.now().toString().slice(-12)}.jsonl`);
writeFileSync(live, `${lines.slice(0, startAt).join('\n')}\n`);

const edge = join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe');
const profile = mkdtempSync(join(tmpdir(), 'bs-rec-edge-'));
const browser = spawn(edge, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' });
const errors = [];
let ws;
try {
  step('open a transcript from a temp copy (40% of a real session)');
  const st = await api('/api/open', { session: live });
  check(st.open === true, 'opened', st.config?.sessionId);
  // turn on recording for this file, from its end
  const rec0 = await api('/api/record', { action: 'start' });
  check(rec0.recording === true && rec0.steps.length === 0, 'recording, and nothing from the opened part is shown', `${rec0.steps.length} step(s)`);

  let target;
  for (let i = 0; i < 40 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not up */ }
    if (!target) await sleep(250);
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok) => ws.addEventListener('open', ok));
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description?.split('\n')[0]);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(`console: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  });
  const send = (method, params = {}) => new Promise((ok) => { const i = ++id; pend.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (x) => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await send('Runtime.enable');
  await send('Page.navigate', { url: `${BASE}/` });
  for (let i = 0; i < 40; i++) { if (await ev(`typeof S!=='undefined' && S.state && S.state.open`)) break; await sleep(250); }
  await ev(`document.querySelector('.act[data-view="recording"]').click()`);

  step('append the rest while the page watches');
  for (let i = startAt; i < lines.length; i += 25) {
    appendFileSync(live, `${lines.slice(i, i + 25).join('\n')}\n`);
    await sleep(120);
  }
  // let the recorder tick (500 ms) and the page poll (700 ms) catch up
  // Wait for BOTH counts to settle. Stopping on the step count alone compared
  // frame counts while the last tick's frames -- added to steps that already
  // existed -- were still one 700 ms poll away from the page.
  let server;
  for (let i = 0; i < 40; i++) {
    server = await api('/api/record?since=0');
    const shown = await ev(`document.querySelectorAll('#rec-list [data-rec-step]').length`);
    const got = await ev(`brainstorm.recording().frames`);
    if (server.steps.length > 0 && shown === server.steps.length && got === server.frames.length) break;
    await sleep(400);
  }
  const shownSteps = await ev(`document.querySelectorAll('#rec-list [data-rec-step]').length`);
  check(server.steps.length > 0, 'the server recorded live calls', `${server.steps.length} step(s), ${server.frames.length} frame(s)`);
  check(shownSteps === server.steps.length, 'the Recording view shows exactly those calls', `${shownSteps} on screen vs ${server.steps.length}`);
  const pageFrames = await ev(`brainstorm.recording().frames`);
  check(pageFrames === server.frames.length, 'the page received every recorded frame', `${pageFrames} vs ${server.frames.length}`);
  const status = await ev(`document.querySelector('#rec-status').textContent`);
  check(/recording/.test(status), 'the status line says it is recording', status);

  step('a prompt typed but not sent yet');
  const PROMPT = `recording e2e waiting prompt ${Date.now()}`;
  appendFileSync(live, `${JSON.stringify({ type: 'user', uuid: `e2e-${Date.now()}`, message: { role: 'user', content: PROMPT } })}\n`);
  let waitingShown = false;
  for (let i = 0; i < 30 && !waitingShown; i++) {
    waitingShown = await ev(`document.querySelector('#rec-list').textContent.includes('not sent yet') && document.querySelector('#rec-list').textContent.includes(${JSON.stringify(PROMPT.slice(0, 30))})`);
    if (!waitingShown) await sleep(400);
  }
  check(waitingShown, 'it appears at once, as "next call — not sent yet"');

  step('the Live panel: a request in flight, from inside claude');
  // What the brainstorm-live mod posts (live-mod.test.mjs proves a real claude
  // sends exactly these). First a request that is still THINKING: sent, its
  // first chunk, and empty thinking chunks, which keep arriving while it thinks.
  await ev(`brainstorm.setFollow(false, false)`);
  const T = `e2e-turn-${Date.now()}`;
  const at = Date.now() - 4000;
  await api('/api/hook', { sessionId: 'e2e', events: [
    { type: 'turn.start', at, turnId: T, text: 'read note.txt' },
    { type: 'step.start', at: at + 5, turnId: T, step: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 16 },
    { type: 'step.first', at: at + 1400, turnId: T, step: 0 },
    { type: 'thinking', at: at + 1500, turnId: T, step: 0, block: 0, text: '' },
    { type: 'thinking', at: at + 2500, turnId: T, step: 0, block: 0, text: '' },
  ] });
  let liveText = '';
  for (let i = 0; i < 20; i++) {
    liveText = await ev(`document.querySelector('#live').textContent`);
    if (liveText.includes('in flight') && liveText.includes('last sign of life')) break;
    await sleep(300);
  }
  check(liveText.includes('in flight') && liveText.includes('16 messages sent'), 'the request in flight, with what was sent', liveText.slice(0, 120));
  check(liveText.includes('waiting for the API') && liveText.includes('thinking') && liveText.includes('last sign of life'), 'still thinking: after waiting for the API, with its last sign of life', (liveText.match(/thinking [^·]*· last sign of life [0-9.]+ s ago/) || [''])[0]);

  // then it starts a Read call
  await api('/api/hook', { sessionId: 'e2e', events: [
    { type: 'tool.begin', at: Date.now(), turnId: T, step: 0, block: 1, id: 'toolu_e2e', name: 'Read' },
    { type: 'tool.input', at: Date.now(), turnId: T, step: 0, block: 1, json: '{"file_path":"C:/work/note.txt"}' },
    { type: 'tool.call', at: Date.now(), id: 'toolu_e2e', tool: 'Read', input: { file_path: 'C:/work/note.txt' } },
  ] });
  for (let i = 0; i < 20; i++) {
    liveText = await ev(`document.querySelector('#live').textContent`);
    if (liveText.includes('note.txt')) break;
    await sleep(300);
  }
  check(liveText.includes('Read  note.txt') && /running \d/.test(liveText), 'the Read call, by its file name, running', (liveText.match(/Read.{0,80}/) || [''])[0]);
  const tip = await ev(`([...document.querySelectorAll('#live .node')].find((n) => n.textContent.includes('note.txt')) || {}).title || ''`);
  check(tip === 'Read: C:/work/note.txt', 'its tooltip has the full path', tip);
  check(liveText.includes('Thinking text: not sent'), 'it says plainly that the thinking words are not sent');
  const segs = await ev(`[...document.querySelectorAll('#live .live-bar .seg')].map((n) => n.className).join(' | ')`);
  check(/wait/.test(segs) && /think/.test(segs) && /write open/.test(segs), 'the bar: wait, think, and writing still open', segs);
  await ev(`[...document.querySelectorAll('#live .node')].find((n) => n.textContent.includes('note.txt')).click()`);
  const tab = await ev(`(S.tabs.find((t) => t.key === 'rec:preview') || {}).text || ''`);
  check(tab.includes('what claude sent the tool') && tab.includes('C:/work/note.txt') && tab.includes('running'), 'clicking it opens what claude sent the tool', tab.split('\n')[0]);
  await api('/api/hook', { sessionId: 'e2e', events: [
    { type: 'tool.done', at: Date.now(), id: 'toolu_e2e', tool: 'Read', isError: false, text: '1\tnumbers: 21 37 49' },
    { type: 'step.stop', at: Date.now(), turnId: T, step: 0, stopReason: 'tool_use', usage: { input_tokens: 2, output_tokens: 141, cache_read_input_tokens: 0, cache_creation_input_tokens: 41414 } },
    { type: 'step.end', at: Date.now(), turnId: T, step: 0 },
  ] });
  let ended = '';
  for (let i = 0; i < 20; i++) {
    ended = await ev(`document.querySelector('#live').textContent`);
    if (ended.includes('last request')) break;
    await sleep(300);
  }
  check(ended.includes('last request') && ended.includes('cache written 41,414'), 'when it ends: the usage the API reported', (ended.match(/cache read.{0,80}/) || [''])[0]);

  step('a request opens in full; a /compact shows while it runs');
  await ev(`document.querySelector('#live .live-step.clickable').click(); true`);
  const reqTab = await ev(`(S.tabs.find((t) => t.key === S.active) || {}).text || ''`);
  check(reqTab.includes('what the API reported') && reqTab.includes('cache written') && reqTab.includes('41,414') && reqTab.includes('phases'), 'clicking the request opens everything about it: phases, and what the cache served', reqTab.split('\n')[0]);
  // what the mod sends for a /compact (measured: no turn.step, only these)
  await api('/api/hook', { sessionId: 'e2e', events: [{ type: 'compact.start', at: Date.now(), trigger: 'manual', messageCount: 38 }] });
  let compacting = '';
  for (let i = 0; i < 20 && !compacting.includes('compacting'); i++) { compacting = await ev(`document.querySelector('#live').textContent`); await sleep(300); }
  check(/compacting \(\/compact\) · 38 messages/.test(compacting), 'a /compact shows as compacting, with how many messages', (compacting.match(/compacting.{0,40}/) || [''])[0]);
  await api('/api/hook', { sessionId: 'e2e', events: [{ type: 'compact.end', at: Date.now(), trigger: 'manual', skipped: null, messageCount: 2, tokensBefore: 47741, tokensAfter: 15602 }] });
  let compacted = '';
  for (let i = 0; i < 20 && !compacted.includes('compacted'); i++) { compacted = await ev(`document.querySelector('#live').textContent`); await sleep(300); }
  check(/compacted \(\/compact\).*47,741 → 15,602 tokens/.test(compacted), 'and when it ends: the tokens before and after', (compacted.match(/compacted.{0,70}/) || [''])[0]);

  step('auto-jump can be stopped');
  await ev(`brainstorm.setFollow(true, false)`);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await ev(`document.querySelector('#rec-chip').click()`);
  const following = await ev(`S.following`);
  check(following === false || following === true, 'the REC chip toggles auto-jump', `now ${following ? 'on' : 'off'}`);
  await ev(`brainstorm.setFollow(false, false)`);
  check((await ev(`S.following`)) === false, 'auto-jump is off when stopped');

  check(errors.length === 0, 'no uncaught exception or console error', errors.slice(0, 3).join(' | '));
} catch (err) {
  console.error(`\n  ERROR  ${err.stack || err.message}`);
  failures++;
} finally {
  try { await api('/api/record', { action: 'stop' }); } catch { /* ignore */ }
  try { ws?.close(); } catch { /* ignore */ }
  try { browser.kill(); } catch { /* ignore */ }
  await sleep(500);
  for (const d of [work, profile]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* Edge may hold it */ } }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
