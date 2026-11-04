// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// edit-e2e.test.mjs — editing from the debugger, the rewind warning, the main
// context, and the panes that must stay resizable. In headless Edge.
//
//   node test/edit-e2e.test.mjs
//
// A brainstorm with its own BRAINSTORM_HOME (so no setting, window or pin of a
// real project is touched) opens a temp copy of a real transcript's first 40%.
//
//   1. the pen on a debugger frame opens the very block that frame came from
//   2. saving an edited message warns, over a blur, that a rewind deletes it:
//      "move my text to the main context" moves only what was ADDED and puts
//      the message back; "save here anyway" saves; Esc saves nothing
//   3. the rest of the transcript is appended: the pen on a call recorded
//      since refreshes the blocks, carrying the saved edit over by line
//   4. a rewind to the first message leaves the main context in place
//   5. at a 1000 px window the sidebar still resizes, and the Live panel folds
//      and resizes
//
// Nothing is written under ~/.claude: the transcript is a temp copy.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7783;
const CDP = 9347;
const BASE = `http://127.0.0.1:${PORT}`;
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
    let fs; try { fs = readdirSync(dir); } catch { continue; }
    for (const f of fs) {
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
if (!SRC) { console.log('  SKIP  no recorded transcript to copy'); process.exit(0); }
const lines = readFileSync(SRC, 'utf8').split('\n');
if (lines[lines.length - 1] === '') lines.pop();
const startAt = Math.floor(lines.length * 0.4);
const work = mkdtempSync(join(tmpdir(), 'bs-edit-e2e-'));
const live = join(work, `${'0'.repeat(8)}-ed17-4e2e-8000-${Date.now().toString().slice(-12)}.jsonl`);
writeFileSync(live, `${lines.slice(0, startAt).join('\n')}\n`);

const home = mkdtempSync(join(tmpdir(), 'bs-edit-home-'));
writeFileSync(join(home, 'settings.json'), JSON.stringify({ autoOpenConsole: false, follow: false }));
const srv = spawn(process.execPath, [join(ROOT, 'bin', 'app.mjs'), '--no-window', '--port', String(PORT)], {
  cwd: ROOT, stdio: 'ignore', env: { ...process.env, BRAINSTORM_HOME: home },
});
const edge = join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe');
const profile = mkdtempSync(join(tmpdir(), 'bs-edit-edge-'));
let browser;
let ws;
const errors = [];
try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${BASE}/api/version`)).ok; } catch { await sleep(250); } }
  check(up, 'a brainstorm with its own BRAINSTORM_HOME started');

  browser = spawn(edge, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not up */ }
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
  const until = async (x, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await ev(x); if (v) return v; await sleep(200); } return null; };
  await send('Runtime.enable');
  await send('Page.navigate', { url: `${BASE}/` });
  await until(`typeof brainstorm !== 'undefined' && !!brainstorm.openSessionPath`);

  step('open a temp copy (40% of a real session)');
  await ev(`brainstorm.openSessionPath(${JSON.stringify(live)}, false).then(() => true)`);
  const opened = await until(`S.state && S.state.open && document.querySelector('#gate').hidden`, 30000);
  check(!!opened, 'opened, the gate lifted');
  const firstUser = await ev(`(() => { for (const g of S.state.groups) for (const b of g.blocks) if (b.role === 'user' && b.kind === 'text' && b.keep) return b.id; return null; })()`);
  const users = await ev(`(() => { const out = []; for (const g of S.state.groups) for (const b of g.blocks) if (b.role === 'user' && b.kind === 'text' && b.keep && !b.title.startsWith('<')) out.push(b.id); return out; })()`);
  check(users.length >= 3, 'the copy has user messages to edit', `${users.length}: first #${firstUser}`);

  step('1. the pen on a debugger frame opens the block it came from');
  await ev(`trace('source', { quiet: true }).then(() => true)`);
  const pick = await ev(`(() => { const calls = (S.trace || {}).calls || []; for (let ci = 0; ci < calls.length; ci++) { const fi = calls[ci].frames.findIndex((f) => f.kind === 'message' && f.blockLine); const off = calls[ci].frames.findIndex((f) => !f.blockLine); if (fi >= 0) return { ci, fi, off, line: calls[ci].frames[fi].blockLine, srcLine: calls[ci].frames[fi].source && calls[ci].frames[fi].source.line }; } return null; })()`);
  check(!!pick, 'the debugger has a call with a message frame that has a block', JSON.stringify(pick));
  // the debugger view is gone (Recording is the debugger); its tree still renders the flow
  check(await ev(`!document.querySelector('.act[data-view="debug"]')`), 'the Context debugger tab is gone');
  check(!(await ev(`document.querySelector('#tree').textContent`)).includes('Sessions'), 'the Explorer lists no other sessions');
  await ev(`S.expanded.add('c:${pick.ci}'); renderFlowTree(); true`);
  const pens = await ev(`[...document.querySelectorAll('#flow-tree .node .pen')].length`);
  const offs = await ev(`[...document.querySelectorAll('#flow-tree .node .pen.off')].length`);
  check(pens > 0, 'every frame row has a pen', `${pens} pen(s), ${offs} off (system prompt, tool list, request-only text: no block)`);
  if (pick.off >= 0) check(await ev(`!!document.querySelector('#flow-tree [data-call="${pick.ci}"][data-frame="${pick.off}"] .pen.off')`), 'a frame with no block has its pen switched off');
  await ev(`document.querySelector('#flow-tree [data-call="${pick.ci}"][data-frame="${pick.fi}"] .pen').click(); true`);
  const tabMeta = await until(`S.active && S.active.startsWith('block:') && S.tabs.find((t) => t.key === S.active).meta`);
  check(!!tabMeta && tabMeta.includes(`line ${pick.line} `), 'its block opened in the editor: the same transcript line', tabMeta);
  check(await ev(`!document.querySelector('#editor').readOnly`), 'and it is editable');

  const editBlock = async (bid, add) => {
    await ev(`openBlock(${bid}).then(() => true)`);
    await ev(`(() => { const ed = document.querySelector('#editor'); ed.value = ed.value + ${JSON.stringify(`\n${add}`)}; ed.dispatchEvent(new Event('input')); return true; })()`);
    await sleep(800);   // the editor pushes 400 ms after the last key
  };

  step('2a. save an edited message: the warning, over a blur');
  const T = Date.now();
  const A = users[1];
  await editBlock(A, `E2E-ADDED-${T}`);
  await ev(`(window.__saving = save(), true)`);
  const shown = await until(`!document.querySelector('#rewind-warn').hidden`);
  check(!!shown, 'saving it shows the warning');
  const blur = await ev(`getComputedStyle(document.querySelector('#rewind-warn')).backdropFilter`);
  check(/blur/.test(blur), 'the app behind it is blurred', blur);
  check((await ev(`document.querySelector('#rw-list').textContent`)).includes(`#${A}`), 'it names the edited message', `#${A}`);

  step('2b. "move my text to the main context"');
  await ev(`document.querySelector('#rw-main').click(); window.__saving.then(() => true)`);
  await until(`S.tabs.some((t) => t.key === 'main' && !t.dirty)`);
  const bA = await api(`/api/block?id=${A}`);
  check(!bA.text.includes(`E2E-ADDED-${T}`) && bA.text === bA.original, 'the message is back as it was');
  let st = await api('/api/state');
  check(st.main.exists && st.main.text.includes(`E2E-ADDED-${T}`), 'only the ADDED line moved into the main context', JSON.stringify(st.main.text.slice(0, 80)));
  check(st.main.applied && st.main.blockId === firstUser, 'which is pinned into the first user message', `#${st.main.blockId}`);
  const onDisk = readFileSync(join(st.dir, 'BLOCKS.md'), 'utf8');
  check(new RegExp(`<!-- pin:${st.main.id} -->[\\s\\S]*E2E-ADDED-${T}[\\s\\S]*<!-- /pin:${st.main.id} -->`).test(onDisk), 'BLOCKS.md carries it inside its pin markers');
  check((await ev(`document.querySelector('#tree').textContent`)).includes('main context'), 'the tree shows the main context');

  step('2c. "save here anyway"');
  const Bk = users[2];
  await editBlock(Bk, `E2E-KEPT-${T}`);
  await ev(`(window.__saving = save(), true)`);
  await until(`!document.querySelector('#rewind-warn').hidden`);
  await ev(`document.querySelector('#rw-save').click(); window.__saving.then(() => true)`);
  st = await api('/api/state');
  check(!st.totals.dirty.includes(Bk) && (await api(`/api/block?id=${Bk}`)).text.includes(`E2E-KEPT-${T}`), 'it is saved in the message itself');

  step('2d. Esc saves nothing');
  const Cn = users[3] || users[2];
  await editBlock(Cn, `E2E-CANCEL-${T}`);
  await ev(`(window.__saving = save(), true)`);
  await until(`!document.querySelector('#rewind-warn').hidden`);
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.__saving.then(() => true)`);
  check(await ev(`document.querySelector('#rewind-warn').hidden`), 'the warning closed');
  st = await api('/api/state');
  check(st.totals.dirty.includes(Cn), 'and the edit is still unsaved', `dirty: ${st.totals.dirty.join(',')}`);
  await api('/api/block', { id: Cn, text: (await api(`/api/block?id=${Cn}`)).original });

  step('3. the pen on a call recorded after opening refreshes the blocks');
  await ev(`document.querySelector('.act[data-view="recording"]').click(); true`);
  const lastLine = await ev(`Math.max(...S.state.groups.flatMap((g) => g.blocks.map((b) => b.line)))`);
  for (let i = startAt; i < lines.length; i += 40) { appendFileSync(live, `${lines.slice(i, i + 40).join('\n')}\n`); await sleep(60); }
  const frame = await until(`(() => { const R = brainstorm.recording(); for (const fs of R.byStep.values()) for (const f of fs) if (f.line > ${lastLine} && document.querySelector('#rec-list [data-rec-seq="' + f.seq + '"] .pen')) return { seq: f.seq, line: f.line, kind: f.kind }; return null; })()`, 20000);
  check(!!frame, 'a recorded frame newer than the opened blocks, with a pen', JSON.stringify(frame));
  const vis = await ev(`(() => { const pen = document.querySelector('#rec-list [data-rec-seq="${frame.seq}"] .pen'); const pr = pen.getBoundingClientRect(); const tr = document.querySelector('#rec-list').getBoundingClientRect(); return { inside: pr.width > 0 && pr.right <= tr.right + 1 && pr.left >= tr.left, opacity: Number(getComputedStyle(pen).opacity) }; })()`);
  check(vis.inside && vis.opacity >= 0.85, 'and the pen is visible: inside the panel, not faint', JSON.stringify(vis));
  await ev(`document.querySelector('#rec-list [data-rec-seq="${frame.seq}"] .pen').click(); true`);
  check(!!(await until(`!document.querySelector('#confirmbar').hidden`)), 'it asks before refreshing', await ev(`document.querySelector('#confirm-text').textContent.slice(0, 90)`));
  await ev(`document.querySelector('#confirm-yes').click(); true`);
  const meta2 = await until(`S.active && S.active.startsWith('block:') && (S.tabs.find((t) => t.key === S.active).meta || '').includes('line ${frame.line} ') && S.tabs.find((t) => t.key === S.active).meta`, 30000);
  check(!!meta2, 'after the refresh, that frame\'s block opened', meta2 || '');
  st = await api('/api/state');
  check(st.totals.blocks > users.length, 'the blocks now reach the new calls', `${st.totals.blocks} blocks`);
  check((await api(`/api/block?id=${Bk}`)).text.includes(`E2E-KEPT-${T}`), 'the saved edit was carried over by its line');
  check(st.main.applied && st.main.text.includes(`E2E-ADDED-${T}`), 'the main context is still pinned');

  step('4. a rewind to the first message leaves the main context in place');
  const rw = await api('/api/rewind', { blockId: firstUser });
  check(rw.dropped.length > 0, 'the rewind dropped the rest', `${rw.dropped.length} block(s)`);
  st = rw.state;
  check(st.main.applied && st.main.blockId === firstUser, 'the main context is still in the first message', `#${st.main.blockId}`);
  check((await api(`/api/block?id=${firstUser}`)).text.includes(`E2E-ADDED-${T}`), 'with its text');

  step('5. at a 1000 px window the panes still resize');
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 820, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const side = () => ev(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)`);
  const drag = async (sel, dx, dy) => {
    const r = JSON.parse(await ev(`JSON.stringify(document.querySelector('${sel}').getBoundingClientRect())`));
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 8; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + (dx * i) / 8, y: y + (dy * i) / 8, button: 'left' });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + dx, y: y + dy, button: 'left', clickCount: 1 });
    await sleep(150);
  };
  const w0 = await side();
  await drag('#split-side', 120, 0);
  const w1 = await side();
  check(w1 - w0 >= 100, 'dragging the sidebar splitter resizes it', `${w0} -> ${w1} px`);
  const cols = await ev(`getComputedStyle(document.querySelector('.shell')).gridTemplateColumns.split(' ').length`);
  check(cols === 4, 'the splitter keeps its own column', `${cols} columns`);
  await drag('#split-side', 2000, 0);
  const editorW = await ev(`Math.round(document.querySelector('.main, .editor-area, #editor').getBoundingClientRect().width)`);
  check(editorW >= 250, 'dragged to the edge, the editor keeps room', `${editorW} px`);
  await ev(`document.querySelector('#split-side').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);

  step('5b. the Live panel folds and resizes');
  const maxH = await ev(`getComputedStyle(document.querySelector('#live')).maxHeight`);
  check(maxH !== 'none', 'the Live panel has a height limit', maxH);
  await ev(`document.querySelector('#live .live-head').click(); true`);
  check(await ev(`document.querySelector('#live').classList.contains('folded')`), 'its header folds it');
  await ev(`document.querySelector('#live .live-head').click(); true`);
  check(await ev(`!document.querySelector('#live').classList.contains('folded')`), 'and unfolds it');
  const h0 = await ev(`Math.round(document.querySelector('#live').getBoundingClientRect().height)`);
  await drag('#split-live', 0, 120);
  const h1 = await ev(`Math.round(document.querySelector('#live').getBoundingClientRect().height)`);
  check(h1 - h0 >= 80, 'dragging its handle DOWN makes it taller (it used to snap back)', `${h0} -> ${h1} px`);
  const lh = await ev(`document.querySelector('#live').style.getPropertyValue('--live-h')`);
  check(/^\d+px$/.test(lh), 'its handle sets its height', lh);

  check(errors.length === 0, 'no uncaught exception or console error', errors.slice(0, 3).join(' | '));
} catch (err) {
  console.error(`\n  ERROR  ${err.stack || err.message}`);
  failures++;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  try { browser?.kill(); } catch { /* ignore */ }
  srv.kill();
  await sleep(500);
  for (const d of [work, profile, home]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* Edge may hold it */ } }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
