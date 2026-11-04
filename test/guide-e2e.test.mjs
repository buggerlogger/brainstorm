// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// guide-e2e.test.mjs — the first-edit guide under the conditions of a real
// first run: auto-jump on, and claude still writing to the session while the
// guide points at it. Headless Edge, its own server and home, a MADE-UP
// session; no claude, no network.
//
//   node test/guide-e2e.test.mjs [--shot <folder>]
//
// MEASURED on the first real run: auto-jump moved the app to the Recording
// view as claude's calls arrived, so "click your message" pointed at a tree
// that was not on screen -- everything blurred, nothing to click, only Skip.
// The last step here is the control: once the guide is closed, the same new
// activity does move the view, so this test reproduces what it guards.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7815;
const CDP = 9462;
const shotDir = (() => { const i = process.argv.indexOf('--shot'); return i > 0 ? process.argv[i + 1] : null; })();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);

function findEdge() {
  for (const r of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)) {
    const p = join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    if (existsSync(p)) return p;
  }
  return null;
}
const edgePath = findEdge();
if (!edgePath) { console.log('  SKIP  Edge not found'); process.exit(0); }

const home = mkdtempSync(join(tmpdir(), 'bs-guide-home-'));
const work = mkdtempSync(join(tmpdir(), 'bs-guide-work-'));
const profile = mkdtempSync(join(tmpdir(), 'bs-guide-edge-'));

// the made-up session, and claude still at work on it: an exchange appended
const sid = randomUUID();
let n = 0;
let parent = null;
const rec = (type, content) => {
  const uuid = randomUUID();
  const r = { type, uuid, parentUuid: parent, sessionId: sid, cwd: work, timestamp: new Date(Date.now() - 600000 + (n++) * 1000).toISOString(), message: { role: type, content } };
  parent = uuid;
  return JSON.stringify(r);
};
const session = join(work, `${sid}.jsonl`);
writeFileSync(session, `${[rec('user', 'My favourite colour is green. Remember it.'), rec('assistant', [{ type: 'text', text: 'Got it: green.' }])].join('\n')}\n`);
const claudeWorks = (word) => appendFileSync(session, `${[rec('user', `Also note ${word}.`), rec('assistant', [{ type: 'text', text: `Noted: ${word}.` }])].join('\n')}\n`);

const srv = spawn(process.execPath, [join(ROOT, 'bin', 'app.mjs'), '--no-window', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, BRAINSTORM_HOME: home } });
const edge = spawn(edgePath, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });

let ws;
let seq = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((ok) => { const i = ++seq; pending.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;
const until = async (expr, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await sleep(200); } return false; };
const titleIs = (t) => until(`document.querySelector('#guide-title').textContent === ${JSON.stringify(t)}`);
const click = (label) => ev(`[...document.querySelectorAll('#guide-actions button')].find((b)=>b.textContent===${JSON.stringify(label)}).click()`);
const ringAround = (sel) => ev(`(()=>{ const t=${sel}; const g=document.querySelector('#guide-ring'); if(!t||g.hidden) return false;
  const a=t.getBoundingClientRect(), b=g.getBoundingClientRect(); return b.left<=a.left&&b.top<=a.top&&b.right>=a.right&&b.bottom>=a.bottom; })()`);
const lastUserMessage = `[...document.querySelectorAll('#tree .node[data-folder="User messages"][data-block-id]')].pop()`;
const shot = async (name) => {
  if (!shotDir) return;
  mkdirSync(shotDir, { recursive: true });
  await sleep(400);
  const s = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shotDir, `${name}.png`), Buffer.from(s.data, 'base64'));
};

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/version`)).ok) break; } catch { /* not yet */ } await sleep(250); }
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not yet */ }
    if (!target) await sleep(250);
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); } });
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  // ?app=1 is how the app's own window loads: a first start, fresh settings
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?app=1` });

  step('a first start, as a person meets it');
  check(await until(`!document.querySelector('#guide').hidden && document.querySelector('#guide-title').textContent === 'Welcome to brainstorm'`), 'the guide starts by itself');
  check(await ev(`brainstorm.settings?.follow === true && brainstorm.settings?.autoRecord === true`), 'with auto-jump and auto-record on (the defaults)');
  await click('Start');
  await titleIs('Create a session');
  check(await ev(`!document.querySelector('#guide-wait').hidden && /click Create session/.test(document.querySelector('#guide-wait-text').textContent)`), 'an action step says what it waits for, with a spinner', await ev(`document.querySelector('#guide-wait-text').textContent`));
  check(await ev(`[...document.querySelectorAll('#guide-actions button')].some((b)=>b.textContent==='Next')`), 'and has a Next button, so nobody is stuck');
  await click('Use one of my sessions');
  await titleIs('Open one of your sessions');
  await ev(`brainstorm.openSessionPath(${JSON.stringify(session)}, false)`);
  check(await until(`document.querySelector('#guide-title').textContent === 'This is the context'`, 30000), 'the session opens: "This is the context"');

  step('claude keeps working while the guide points at the tree');
  await sleep(1500);   // recording starts at the end of the file
  claudeWorks('blue');
  await sleep(4000);   // the recorder has seen the new call by now
  check(await ev(`S.view`) === 'explorer', 'the Explorer stays on screen', await ev(`S.view`));
  check(await ev(`S.following`) === false, 'auto-jump is paused while the guide runs');
  check(await ev(`document.querySelector('#guide-title').textContent`) === 'This is the context', 'the step is still there');
  check(await ringAround(lastUserMessage), 'the ring is around your message, in the tree on screen');
  check(await ev(`!document.querySelector('#guide-wait').hidden`), 'waiting for you to open it', await ev(`document.querySelector('#guide-wait-text').textContent`));
  await shot('context-while-claude-works');

  step('on through the steps');
  await ev(`${lastUserMessage}.click()`);
  check(await titleIs('Change what claude remembers'), 'opening the message moves on by itself');
  claudeWorks('red');
  await sleep(4000);
  check(await ev(`activeTab()?.kind === 'block'`), 'claude\'s new call does not replace the tab being edited', await ev(`activeTab()?.label`));
  check(await ringAround(`document.querySelector('#editor')`), 'the ring is around the editor');
  await ev(`(()=>{ const e=document.querySelector('#editor'); e.value=e.value.replace(/green|blue/,'purple'); e.dispatchEvent(new Event('input')); })()`);
  check(await titleIs('Save & Resume'), 'the edit moves on by itself');
  check(await ringAround(`document.querySelector('#btn-save-resume')`), 'the ring is around Save & Resume');
  await click('Next');
  check(await titleIs('Ask claude'), 'Next moves on by hand');
  check(await ev(`S.view`) === 'recording' && await ringAround(`document.querySelector('#live')`), 'Ask claude puts the Live panel on screen, ringed');
  await click('I asked it');
  check(await titleIs('Did claude get your edit?'), 'on to the last card');
  await click('Done');
  check(await until(`document.querySelector('#guide').hidden`), 'Done closes it');
  check(await until(`S.following === true`, 3000), 'auto-jump is back on, as it was');

  step('the control: without the guide, new activity does move the view');
  await ev(`selectView('explorer')`);
  claudeWorks('yellow');
  check(await until(`S.view === 'recording'`, 8000), 'auto-jump moved it to Recording: what the guide holds back', await ev(`S.view`));
} catch (err) {
  console.error(`\n  ERROR  ${err.stack || err.message}`);
  failures++;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { edge.kill(); } catch { /* ignore */ }
  try { srv.kill(); } catch { /* ignore */ }
  await sleep(1500);
  for (const d of [home, work, profile]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* held briefly */ } }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
