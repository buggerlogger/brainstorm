// presence.test.mjs — the server lives exactly as long as a window has it open,
// and a window in the BACKGROUND counts as open.
//
//   node test/presence.test.mjs [path/to/brainstorm.exe]
//
// The bug this guards: presence used to be a timer heartbeat, Edge throttled
// it in a background window to about once a minute, and the server exited
// under an open window -- every search afterwards answered "not found". So
// the decisive check is: hold the presence connection open and send NOTHING
// else for longer than the old grace, and the server must still be there.
//
// Runs from source by default; pass the exe to test the packaged build.

import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.argv[2] || null;
const PORT = 7797;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);

const alive = async () => {
  try { return (await fetch(`${BASE}/api/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
};

// A window, as far as the server can tell: one held-open /api/presence stream.
function openWindow() {
  const ctl = new AbortController();
  const ready = fetch(`${BASE}/api/presence`, { signal: ctl.signal }).then(async (r) => {
    const reader = r.body.getReader();
    const first = await reader.read();         // the "hello" event
    (async () => { try { for (;;) { const x = await reader.read(); if (x.done) break; } } catch { /* aborted */ } })();
    return new TextDecoder().decode(first.value || new Uint8Array());
  });
  return { ready, close: () => ctl.abort() };
}

const cmd = EXE || process.execPath;
const args = EXE
  ? ['--no-window', '--exit-when-closed', '--port', String(PORT)]
  : [join(ROOT, 'bin', 'app.mjs'), '--no-window', '--exit-when-closed', '--port', String(PORT)];
const srv = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
let exited = null;
srv.on('exit', (code) => { exited = { code, at: Date.now() }; });

try {
  step(`start ${EXE ? 'the exe' : 'from source'} with the presence rule on`);
  for (let i = 0; i < 40 && !(await alive()); i++) await sleep(250);
  check(await alive(), 'server is up');

  step('no window has connected yet: the server must not exit on its own');
  await sleep(12000);
  check(await alive(), 'still up 12 s after start with no window (it waits for a first window)');

  step('a window connects, then sends NOTHING for 35 s');
  const w = openWindow();
  const hello = await w.ready;
  check(/event: hello/.test(hello), 'the presence stream says hello', hello.trim().split('\n')[0]);
  // The old timer heartbeat would have declared this window closed at 15 s.
  // A background window whose timers are throttled looks exactly like this.
  await sleep(35000);
  check(await alive(), 'still up after 35 s of silence from an open window (the throttled-background case)');

  step('a reload: the connection drops and comes back within the grace');
  w.close();
  await sleep(2000);
  const w2 = openWindow();
  await w2.ready;
  await sleep(12000);
  check(await alive(), 'a quick reconnect does not shut the app down');

  step('the window closes for real');
  const t0 = Date.now();
  w2.close();
  for (let i = 0; i < 40 && !exited; i++) await sleep(500);
  const secs = exited ? ((exited.at - t0) / 1000).toFixed(1) : null;
  check(!!exited, 'the server exits once no window is connected', exited ? `after ${secs} s, code ${exited.code}` : 'still running');
  check(!!exited && exited.at - t0 < 15000, 'and promptly, within ~10 s of grace');
} catch (err) {
  console.error(`\n  ERROR  ${err.stack || err.message}`);
  failures++;
} finally {
  if (!exited) srv.kill();
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
