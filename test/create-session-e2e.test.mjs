// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// create-session-e2e.test.mjs — Create session in the start gate, with
// claude's real write order. Headless Edge, its own server and home, REAL
// terminal windows whose "claude" is a stand-in; no claude, no network.
//
//   node test/create-session-e2e.test.mjs
//
// MEASURED: claude creates the transcript BEFORE the first message is in it
// (mode, permission-mode, system, file-history-snapshot come first). The gate
// opened it the moment it appeared, extract refused it ("no conversation
// records"), and the gate had already stopped waiting: the session never
// opened, and clicking it did nothing while the failed open was shown. The
// stand-in here writes in that order, with the message 5 s later.
//
// Twice: once as a new session normally starts, and once with 100 KB of setup
// before the message -- past the 64 KB the session list reads, so the list
// cannot see the message and the gate has to find out by trying.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7818;
const CDP = 9464;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== '' ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);

if (process.platform !== 'win32') { console.log('  SKIP  session windows are Windows only'); process.exit(0); }
const edgePath = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)
  .map((r) => join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find(existsSync);
if (!edgePath) { console.log('  SKIP  Edge not found'); process.exit(0); }

const home = mkdtempSync(join(tmpdir(), 'bs-create-home-'));
const profile = mkdtempSync(join(tmpdir(), 'bs-create-edge-'));
const made = [];   // folders and project folders to remove

// The stand-in claude: started with --session-id X it writes X.jsonl the way
// claude does -- the setup records at once (STUB_BIG: 100 KB more of them),
// the first message 5 s later, then the answer -- and stays running.
const stubJs = join(home, 'fake-claude.mjs');
writeFileSync(stubJs, `
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const a = process.argv.slice(2);
const i = a.indexOf('--session-id');
appendFileSync(process.env.STUB_LOG, 'args: ' + a.join(' ') + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (i >= 0) (async () => {
  const id = a[i + 1];
  mkdirSync(process.env.STUB_DIR, { recursive: true });
  const out = join(process.env.STUB_DIR, id + '.jsonl');
  const base = { sessionId: id, cwd: process.cwd(), version: '2.1.311', userType: 'external', isSidechain: false };
  const write = (r) => appendFileSync(out, JSON.stringify(r) + '\\n');
  write({ type: 'mode', mode: 'default' });
  write({ type: 'permission-mode', permissionMode: 'default' });
  write({ ...base, type: 'system', subtype: 'init', uuid: 's0', parentUuid: null, timestamp: new Date().toISOString(), content: 'started' });
  write({ type: 'file-history-snapshot', messageId: 'm0', snapshot: process.env.STUB_BIG ? { pad: 'x'.repeat(100000) } : {} });
  appendFileSync(process.env.STUB_LOG, 'setup records written\\n');
  await sleep(5000);
  write({ ...base, type: 'user', uuid: 'u1', parentUuid: 's0', timestamp: new Date().toISOString(), message: { role: 'user', content: 'My favourite colour is green. Remember it.' } });
  await sleep(500);
  write({ ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: new Date().toISOString(), message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'Got it: green.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } });
  appendFileSync(process.env.STUB_LOG, 'message written\\n');
})();
setInterval(() => {}, 1000);
`);

function stand_in(name, big) {
  const work = mkdtempSync(join(tmpdir(), `bs-create-${name}-`));
  const projDir = join(homedir(), '.claude', 'projects', work.replace(/[^A-Za-z0-9._-]/g, '-'));
  made.push(work, projDir);
  const log = join(home, `${name}.log`);
  const cmd = join(home, `fake-claude-${name}.cmd`);
  writeFileSync(cmd, ['@echo off', `set "STUB_DIR=${projDir}"`, `set "STUB_LOG=${log}"`, big ? 'set "STUB_BIG=1"' : 'set "STUB_BIG="', `"${process.execPath}" "${stubJs}" %*`].join('\r\n'));
  return { work, log, cmd };
}
const said = (log, what) => { try { return readFileSync(log, 'utf8').includes(what); } catch { return false; } };

writeFileSync(join(home, 'settings.json'), JSON.stringify({ liveHooks: false, autoOpenConsole: true }));
const srv = spawn(process.execPath, [join(ROOT, 'bin', 'app.mjs'), '--no-window', '--port', String(PORT)], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, BRAINSTORM_HOME: home } });
const edge = spawn(edgePath, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });

let ws;
let seq = 0;
const pending = new Map();
const errors = [];
const send = (method, params = {}) => new Promise((ok) => { const i = ++seq; pending.set(i, ok); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;
const until = async (expr, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await ev(expr)) return true; await sleep(250); } return false; };

async function scenario(name, big) {
  const s = stand_in(name, big);
  await fetch(`http://127.0.0.1:${PORT}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claudePath: s.cmd }) });
  await ev(`brainstorm.openGate()`);
  check(await until(`!document.querySelector('#gate').hidden && document.querySelectorAll('#gate-list .gate-row').length > 0`, 20000), 'the start gate is up');
  await ev(`document.querySelector('#gate-create').click()`);
  await ev(`(()=>{ document.querySelector('#gate-new-cwd').value = ${JSON.stringify(s.work)}; document.querySelector('#gate-new-start').click(); })()`);
  check(await until(`!document.querySelector('#gate-new-wait').hidden`), 'it waits for the session');
  for (let i = 0; i < 60 && !said(s.log, 'args:'); i++) await sleep(250);
  const id = (readFileSync(s.log, 'utf8').match(/--session-id (\S+)/) || [])[1];
  check(!!id, 'claude was started with --session-id', id);

  for (let i = 0; i < 40 && !said(s.log, 'setup records written'); i++) await sleep(250);
  await sleep(3000);   // two polls see the file with no message in it
  check(!said(s.log, 'message written'), '(the file is there, the first message is not)');
  check(await ev(`!document.querySelector('#gate').hidden && !document.querySelector('#gate-new-wait').hidden`), 'the gate is still waiting', await ev(`document.querySelector('#gate-new-time').textContent`));
  check(await ev(`![...document.querySelectorAll('#gate-list .gate-empty')].some((n)=>/could not open/.test(n.textContent))`), 'no "could not open"');
  check(await ev(`/first message/.test(document.querySelector('#gate-new-msg').textContent)`), 'it says it waits for the first message');

  check(await until(`S.state && S.state.open && S.state.config.sessionId === ${JSON.stringify(id)}`, 30000), 'when the message arrives, the session opens by itself');
  check(await until(`document.querySelector('#gate').hidden`, 30000), 'the gate is gone');
  const wdir = join(home, 'windows');
  const forIt = readdirSync(wdir).filter((f) => f.endsWith('.control.json')).filter((f) => JSON.parse(readFileSync(join(wdir, f), 'utf8')).resume === id).length;
  check(forIt === 1, 'the terminal claude runs in was adopted, not a second one opened', `${forIt} window(s) on it`);
}

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/version`)).ok) break; } catch { /* not yet */ } await sleep(250); }
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not yet */ }
    if (!target) await sleep(250);
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); }
    else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails?.exception?.description || 'exception');
  });
  await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await until(`typeof brainstorm !== 'undefined' && !!brainstorm.openGate`, 20000);

  step('a new session as claude starts one');
  await scenario('normal', false);
  step('100 KB of setup before the first message (past what the list reads)');
  await scenario('big', true);
  check(errors.length === 0, 'no exception on the page', errors.slice(0, 3).join(' | '));
} catch (err) {
  console.error(`\n  ERROR  ${err.stack || err.message}`);
  failures++;
} finally {
  const wdir = join(home, 'windows');
  for (const f of existsSync(wdir) ? readdirSync(wdir).filter((x) => x.endsWith('.control.json')) : []) {
    try { await fetch(`http://127.0.0.1:${PORT}/api/window`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'stop', tag: f.split('.')[0], close: true }) }); } catch { /* server gone */ }
  }
  try { ws?.close(); } catch { /* ignore */ }
  try { edge.kill(); } catch { /* ignore */ }
  try { srv.kill(); } catch { /* ignore */ }
  await sleep(2500);
  for (const d of [...made, home, profile]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* held briefly */ } }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
