// Copyright (c) 2026 buggerlogger. All rights reserved.
// Proprietary and confidential. No license is granted to use, copy, modify or
// distribute this file, in whole or in part. See LICENSE.
//
// launch.test.mjs — launching brainstorm.exe the way a double-click does.
//
//   node test/launch.test.mjs [path/to/brainstorm.exe]
//
// Opens a real app window (and closes it again). Checks:
//   - the visible launcher exits at once and leaves NO console window behind:
//     a console you can close is a server you can kill by accident
//   - the background copy got its arguments (--child) -- detached: true has
//     dropped argv on this machine before, so it is checked, not assumed
//   - the app window was started with the anti-throttling switches, so the
//     page keeps working while it is behind the terminal
//   - closing the window ends the app

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.argv[2] || join(ROOT, 'dist', 'brainstorm.exe');
// An isolated home: its own lock file and window profile, so this test never
// finds -- and opens a window onto -- the copy a person is actually using.
const APPDATA = mkdtempSync(join(tmpdir(), 'bs-launch-home-'));
const ENV = { ...process.env, BRAINSTORM_HOME: APPDATA };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);

function ps(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').trim();
}

function procs(name, contains) {
  const out = ps(`Get-CimInstance Win32_Process -Filter "Name='${name}'" | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine }`);
  return out.split(/\r?\n/).filter(Boolean)
    .map((l) => { const i = l.indexOf('|'); return { pid: Number(l.slice(0, i)), cmd: l.slice(i + 1) }; })
    .filter((p) => !contains || p.cmd.includes(contains));
}

if (!existsSync(EXE)) { console.log(`  SKIP  no exe at ${EXE}`); process.exit(0); }

let edgePid = null;
let childPid = null;
try {
  step('launch with no arguments, as a double-click does');
  const before = new Set(procs('brainstorm.exe').map((p) => p.pid));
  const t0 = Date.now();
  const launcher = spawn(EXE, [], { stdio: 'ignore', env: ENV });
  const launcherExit = await new Promise((ok) => launcher.on('exit', (code) => ok({ code, ms: Date.now() - t0 })));
  check(launcherExit.code === 0 && launcherExit.ms < 5000, 'the visible launcher exits at once', `${launcherExit.ms} ms, code ${launcherExit.code}`);

  let child = null;
  for (let i = 0; i < 40 && !child; i++) {
    child = procs('brainstorm.exe').find((p) => !before.has(p.pid) && p.pid !== launcher.pid);
    if (!child) await sleep(250);
  }
  check(!!child, 'a background copy is running', child && `pid ${child.pid}`);
  childPid = child?.pid;
  check(!!child && child.cmd.includes('--child'), 'it received its arguments (--child survived the detach)', child?.cmd.replace(/^.*brainstorm\.exe"?/, 'brainstorm.exe'));

  const hasWindow = ps(`(Get-Process -Id ${childPid}).MainWindowHandle -ne 0`);
  check(hasWindow === 'False', 'the background copy has NO console window to close by accident', `MainWindowHandle nonzero: ${hasWindow}`);

  step('the server and the app window');
  let lock = null;
  for (let i = 0; i < 40; i++) {
    try { lock = JSON.parse(readFileSync(join(APPDATA, 'server.lock.json'), 'utf8')); } catch { /* not yet */ }
    if (lock && lock.pid === childPid) break;
    await sleep(250);
  }
  check(lock?.pid === childPid, 'the lock file names the background copy', lock && `port ${lock.port}`);
  const up = await fetch(`http://127.0.0.1:${lock.port}/api/version`).then((r) => r.ok).catch(() => false);
  check(up, 'the server answers');

  let edge = null;
  for (let i = 0; i < 40 && !edge; i++) {
    edge = procs('msedge.exe', `--app=http://127.0.0.1:${lock.port}/`)[0];
    if (!edge) await sleep(250);
  }
  check(!!edge, 'an Edge app window opened on that server', edge && `pid ${edge.pid}`);
  edgePid = edge?.pid;
  for (const sw of ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']) {
    check(!!edge && edge.cmd.includes(sw), `window started with ${sw}`);
  }
  check(!!edge && /window-profile-[0-9a-f]{8}/.test(edge.cmd), 'window uses brainstorm\'s own profile (named after its flags), not the person\'s browser');

  let windows = 0;
  for (let i = 0; i < 60 && windows < 1; i++) {
    windows = await fetch(`http://127.0.0.1:${lock.port}/api/version`).then((r) => r.json()).then((v) => v.windows || 0).catch(() => 0);
    if (windows < 1) await sleep(250);
  }
  check(windows >= 1, 'the page connected its presence stream', `${windows} window(s)`);

  const log = existsSync(join(APPDATA, 'app.log')) ? readFileSync(join(APPDATA, 'app.log'), 'utf8') : '';
  check(/brainstorm IDE/.test(log), 'the background copy logs to %APPDATA%\\brainstorm\\app.log', log.trim().split('\n').find((l) => l.includes('http')) || '');

  step('close the window: the app must follow');
  const t1 = Date.now();
  spawnSync('taskkill', ['/PID', String(edgePid), '/T', '/F'], { windowsHide: true });
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    gone = ps(`[bool](Get-Process -Id ${childPid} -ErrorAction SilentlyContinue)`) === 'False';
    if (!gone) await sleep(500);
  }
  check(gone, 'the background copy exited after the window closed', gone ? `${((Date.now() - t1) / 1000).toFixed(1)} s` : 'still running');
  childPid = gone ? null : childPid;
  edgePid = null;
} catch (err) {
  console.error(`\n  ERROR  ${err.stack || err.message}`);
  failures++;
} finally {
  if (edgePid) spawnSync('taskkill', ['/PID', String(edgePid), '/T', '/F'], { windowsHide: true });
  if (childPid) spawnSync('taskkill', ['/PID', String(childPid), '/T', '/F'], { windowsHide: true });
  await sleep(800);
  try { rmSync(APPDATA, { recursive: true, force: true }); } catch { /* Edge may hold it briefly */ }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
