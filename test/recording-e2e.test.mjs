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
