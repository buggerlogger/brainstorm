// window.test.mjs — the session window really switches sessions in place.
//
//   node test/window.test.mjs
//
// Opens a REAL terminal window (it will appear on screen) whose "claude" is a
// stub: a .cmd that logs its arguments and then waits. That makes the claim
// testable without an interactive session:
//
//   1. the window starts the stub with --resume AAA
//   2. resumeInWindow switches it to BBB
//   3. the stub for AAA is ended, a stub for BBB starts
//   4. it is the SAME window -- the runner's pid never changes
//
// Point 4 is the one that matters. "Close it and open a new one" also passes
// 1-3, and it is exactly what this design exists to avoid.

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSessionWindow, resumeInWindow, stopWindow, listWindows, windowLog } from '../src/server/session-window.mjs';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, ms = 30000, every = 500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = pred();
    if (v) return v;
    await sleep(every);
  }
  return null;
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

const work = mkdtempSync(join(tmpdir(), 'bs-window-'));
const argLog = join(work, 'stub-args.log');
const stub = join(work, 'fake-claude.cmd');
// The stub: append the arguments it was given, then wait ~10 minutes.
writeFileSync(stub, [
  '@echo off',
  `echo %* >> "${argLog}"`,
  'ping -n 600 127.0.0.1 > nul',
].join('\r\n'));

let tag = null;
try {
  step('open a session window whose claude is the stub');
  const w = openSessionWindow({ sessionId: 'AAA-session', cwd: work, claude: stub });
  tag = w.tag;
  check(!!tag, 'window opened', `tag ${tag} via ${w.host}`);

  const first = await waitFor(() => existsSync(argLog) && readFileSync(argLog, 'utf8').includes('--resume AAA-session'));
  check(!!first, 'the stub was started with --resume AAA-session');

  const runnerPid = await waitFor(() => {
    const m = windowLog(tag).match(/runner started pid (\d+)/);
    return m ? Number(m[1]) : null;
  });
  check(!!runnerPid, 'the runner recorded its own pid', String(runnerPid));

  const pidA = await waitFor(() => listWindows().find((x) => x.tag === tag)?.claudePid);
  check(!!pidA && pidAlive(pidA), 'the stub for AAA is running', `pid ${pidA}`);

  step('switch the window to BBB, as Save & Resume does');
  const sw = resumeInWindow(tag, 'BBB-session');
  check(sw.wasRunning && sw.ended, 'the running stub was ended', `pid ${sw.claudePid}`);
  check(sw.previous === 'AAA-session', 'it knew what it was switching from', sw.previous);

  const second = await waitFor(() => readFileSync(argLog, 'utf8').includes('--resume BBB-session'));
  check(!!second, 'the stub was started again with --resume BBB-session');

  const pidB = await waitFor(() => {
    const cur = listWindows().find((x) => x.tag === tag);
    return cur?.claudePid && cur.claudePid !== pidA ? cur.claudePid : null;
  });
  check(!!pidB && pidAlive(pidB), 'a NEW stub process is running for BBB', `pid ${pidB}`);
  check(!pidAlive(pidA), 'the old stub for AAA is gone', `pid ${pidA}`);

  // The claim this design exists for.
  check(pidAlive(runnerPid), 'it is the SAME window: the runner pid never changed', `runner ${runnerPid}`);

  const lines = readFileSync(argLog, 'utf8').split(/\r?\n/).filter(Boolean);
  check(lines.length === 2, 'exactly two starts, AAA then BBB', JSON.stringify(lines.map((l) => l.trim())));

  step('stop the window');
  const st = stopWindow(tag);
  check(st.ended, 'stop ended the running stub');
  const stopped = await waitFor(() => /stop/.test(windowLog(tag)));
  check(!!stopped, 'the runner left its loop', (windowLog(tag).trim().split(/\r?\n/).pop() || '').slice(0, 80));
  const lines2 = readFileSync(argLog, 'utf8').split(/\r?\n/).filter(Boolean);
  check(lines2.length === 2, 'stopping did not start a third session');
} catch (err) {
  console.error(`\n  ERROR  ${err.stack || err.message}`);
  failures++;
} finally {
  if (tag) { try { stopWindow(tag); } catch { /* already stopped */ } }
  console.log(`\n  runner log:\n${windowLog(tag || '').split(/\r?\n/).filter(Boolean).map((l) => `    ${l}`).join('\n')}`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
