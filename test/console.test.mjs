// Copyright (c) 2026 buggerlogger. All rights reserved.
// Proprietary and confidential. No license is granted to use, copy, modify or
// distribute this file, in whole or in part. See LICENSE.
//
// console.test.mjs — the real terminal window and the attach list.
//
//   node test/console.test.mjs [http://127.0.0.1:7788] [--open]
//
// --open actually pops a console window on the desktop. Off by default so a
// test run does not litter the screen; the rest of the checks run either way.
//
// The claim under test is the x64dbg one: you run the program, the tool
// attaches to it. So this starts a session the server did NOT spawn (a
// detached process of its own) and asserts the attach list finds it, marks it
// live, and can attach the editor to it.

import { spawn } from 'node:child_process';

const BASE = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:7788';
const OPEN = process.argv.includes('--open');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body) {
  const opt = body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(BASE + path, opt);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 300) }; }
  if (!res.ok || data.error) throw new Error(data.error || `${res.status} ${path}`);
  return data;
}

try {
  step('what terminals exist on this machine');
  const consoles = await api('/api/console');
  check(consoles.consoles.length > 0, 'at least one terminal is available', consoles.consoles.map((c) => c.label).join(', '));
  check(!!consoles.cwd, 'it knows which directory to open in', consoles.cwd);

  step('the attach list');
  const list0 = await api('/api/sessions');
  check(Array.isArray(list0.sessions), 'the attach list answers', `${list0.sessions.length} session(s) in ${list0.dir}`);
  check(typeof list0.autoAttach === 'boolean', 'auto-attach has a state', String(list0.autoAttach));
  check(list0.sessions.every((s) => typeof s.live === 'boolean' && typeof s.idleMs === 'number'), 'every row says whether it is live and how idle');

  step('a bad cwd is refused rather than opening a window somewhere random');
  let refused = false;
  try {
    await api('/api/console', { kind: consoles.consoles[0].id, cwd: 'C:/definitely/not/a/real/place/xyzzy' });
  } catch (err) { refused = /not a directory/.test(err.message); }
  check(refused, 'a non-existent cwd is refused');

  step('start a Claude session the server did NOT spawn');
  // Detached, its own process, exactly as if you had typed it in your own
  // terminal window. The watcher must find it anyway, because it watches the
  // transcript directory and not a process it owns.
  const cwd = consoles.cwd;
  const before = new Set(list0.sessions.map((s) => s.id));
  const child = spawn(
    'claude -p "reply with exactly: ATTACH-OK" --permission-mode bypassPermissions',
    { cwd, shell: true, detached: true, stdio: 'ignore' },
  );
  child.unref();
  console.log(`    spawned detached pid ${child.pid} in ${cwd}`);

  let found = null;
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    const r = await api('/api/sessions');
    found = r.sessions.find((s) => !before.has(s.id));
    if (found) break;
    await sleep(1000);
  }
  check(!!found, 'the attach list found a session nobody told it about', found && `${found.id} (${found.live ? 'live' : 'idle'})`);

  if (found) {
    step('attach to it, like attaching to a running process');
    const r = await api('/api/live', { action: 'attach', session: found.id });
    check(!!r.state?.open, 'the editor attached', r.state?.config?.sessionId);
    check(r.state.totals.blocks > 0, 'its context is readable as blocks', `${r.state.totals.blocks} blocks`);

    const after = await api('/api/sessions');
    const row = after.sessions.find((s) => s.id === found.id);
    check(!!row?.attached, 'the list marks it attached');
  }

  step('auto-attach toggles');
  const on = await api('/api/sessions', { autoAttach: true });
  check(on.autoAttach === true, 'auto-attach can be turned on');
  const off = await api('/api/sessions', { autoAttach: false });
  check(off.autoAttach === false, 'and off again');

  if (OPEN) {
    step('open a real window and make it describe its own console');
    // The claim is that the window is INTERACTIVE -- that you can type
    // `claude` into it. A console can exist and still have its stdio pointed
    // at NUL, which looks identical from outside and is useless. Measured:
    // a detached spawn gave inRedir=True outRedir=True; wt.exe gave False and
    // False. So the window is asked to report its own redirection state.
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { existsSync, readFileSync, rmSync } = await import('node:fs');
    const probeFile = join(tmpdir(), `brainstorm-tty-${Date.now()}.txt`).split('\\').join('/');
    try { rmSync(probeFile); } catch { /* not there */ }
    const D = String.fromCharCode(36);
    const run = `Set-Content -Path '${probeFile}' -Value ("w=" + ${D}Host.UI.RawUI.WindowSize.Width`
      + ` + " inRedir=" + [Console]::IsInputRedirected + " outRedir=" + [Console]::IsOutputRedirected)`;
    const r = await api('/api/console', { kind: 'powershell', run });
    check(!!r.pid, 'a window was launched', `${r.kind} via ${r.host}, pid ${r.pid}`);
    console.log(`    ${r.exe} ${(r.args || []).join(' ')}`);

    let said = null;
    const until = Date.now() + 25000;
    while (Date.now() < until) {
      if (existsSync(probeFile)) { said = readFileSync(probeFile, 'utf8').trim(); break; }
      await sleep(700);
    }
    check(!!said, 'the window ran the command it was given', said || 'nothing was written');
    if (said) {
      check(/inRedir=False/.test(said), 'its INPUT is a real console, not a pipe', said);
      check(/outRedir=False/.test(said), 'its OUTPUT is a real console, not a pipe', said);
      check(/w=\d+/.test(said), 'it has a window width', said);
    }
    try { rmSync(probeFile); } catch { /* fine */ }
  } else {
    console.log('\n  (pass --open to pop a window and check it is a real TTY)');
  }
} catch (err) {
  console.error(`\n  ERROR  ${err.message}`);
  failures++;
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
