// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
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
const envLog = join(work, 'stub-env.log');
// A plugin folder with a SPACE in its path: Start-Process quotes nothing, so
// without the runner's own quoting it would reach claude as two arguments.
const pluginDir = join(work, 'with space', 'brainstorm-live');
const stub = join(work, 'fake-claude.cmd');
// a second claude: what the claudePath setting names AFTER the window opened
const argLog2 = join(work, 'stub2-args.log');
const stub2 = join(work, 'fake-claude-2.cmd');
writeFileSync(stub2, ['@echo off', `echo %* >> "${argLog2}"`, 'ping -n 600 127.0.0.1 > nul'].join('\r\n'));
// The stub: append the arguments it was given, then wait ~10 minutes.
writeFileSync(stub, [
  '@echo off',
  `echo %* >> "${argLog}"`,
  `echo %BRAINSTORM_LIVE%>> "${envLog}"`,
  'ping -n 600 127.0.0.1 > nul',
].join('\r\n'));

// a third, for Create session's fresh start
const argLog3 = join(work, 'stub3-args.log');
const stub3 = join(work, 'fake-claude-3.cmd');
writeFileSync(stub3, ['@echo off', `echo %* >> "${argLog3}"`, 'ping -n 600 127.0.0.1 > nul'].join('\r\n'));

let tag = null;
let tag2 = null;
try {
  step('open a session window whose claude is the stub');
  const w = openSessionWindow({ sessionId: 'AAA-session', cwd: work, claude: stub, plugins: [pluginDir], env: { BRAINSTORM_LIVE: join(work, 'live.json') } });
  tag = w.tag;
  check(!!tag, 'window opened', `tag ${tag} via ${w.host}`);

  const first = await waitFor(() => existsSync(argLog) && readFileSync(argLog, 'utf8').includes('--resume AAA-session'));
  check(!!first, 'the stub was started with --resume AAA-session');
  const raw = existsSync(argLog) ? readFileSync(argLog, 'utf8').split(/\r?\n/)[0] : '';
  check(raw.includes(`--plugin-dir "${pluginDir}"`), 'claude got --plugin-dir with the mod folder as ONE argument, quoted', raw.trim());
  const envSeen = await waitFor(() => existsSync(envLog) && readFileSync(envLog, 'utf8').trim());
  check(envSeen && envSeen.split(/\r?\n/)[0].trim() === join(work, 'live.json'), 'claude inherited BRAINSTORM_LIVE from the runner', String(envSeen).split(/\r?\n/)[0]);

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

  step('a switch uses the launch settings as they are NOW');
  // ⛔ the window kept the claude it was opened with: a claudePath corrected
  // since (a stub left there by a crashed test) never reached an open window
  const sw2 = resumeInWindow(tag, 'CCC-session', { claude: stub2, claudeArgs: '', plugins: [], env: {} });
  check(sw2.wasRunning && sw2.ended, 'the running claude was ended');
  const third = await waitFor(() => existsSync(argLog2) && readFileSync(argLog2, 'utf8').includes('--resume CCC-session'));
  check(!!third, 'it started the claude the settings name now, not the one the window opened with');
  check(!readFileSync(argLog, 'utf8').includes('CCC-session'), 'the claude it was opened with was not started again');

  step('stop the window');
  const st = stopWindow(tag, { close: true });
  check(st.ended, 'stop ended the running stub');
  const stopped = await waitFor(() => /stop/.test(windowLog(tag)));
  check(!!stopped, 'the runner left its loop', (windowLog(tag).trim().split(/\r?\n/).pop() || '').slice(0, 80));

  // The terminal is put back every time claude ends -- a hard kill leaves
  // claude's mouse reporting on, and every drag then types "[555;102;30M".
  const resets = (windowLog(tag).match(/terminal reset/g) || []).length;
  check(resets === 3, 'the terminal was reset after each claude ended (killed by two switches, and by the stop)', `${resets} reset(s)`);

  const closed = await waitFor(() => /closing the window/.test(windowLog(tag)));
  check(!!closed, 'close: true closes the window instead of leaving a stray shell');
  const gone = await waitFor(() => !pidAlive(runnerPid), 15000);
  check(!!gone, 'the window\'s process is gone', `runner ${runnerPid}`);
  const lines2 = readFileSync(argLog, 'utf8').split(/\r?\n/).filter(Boolean);
  check(lines2.length === 2, 'stopping did not start a third session');

  step('Create session: a NEW claude first, then resumes like any other');
  // the start gate's Create session: brainstorm picks the id, claude starts
  // the session with it, and every start after that (Save & Resume) resumes
  const w2 = openSessionWindow({ sessionId: 'NEW-session', cwd: work, claude: stub3, fresh: true });
  tag2 = w2.tag;
  const fresh = await waitFor(() => existsSync(argLog3) && readFileSync(argLog3, 'utf8').includes('--session-id NEW-session'));
  check(!!fresh, 'the first start is claude --session-id NEW-session');
  check(!readFileSync(argLog3, 'utf8').includes('--resume NEW-session'), 'not --resume: that session does not exist yet');
  await waitFor(() => listWindows().find((x) => x.tag === tag2)?.claudePid);
  resumeInWindow(tag2, 'BUILT-session');
  const resumed = await waitFor(() => readFileSync(argLog3, 'utf8').includes('--resume BUILT-session'));
  check(!!resumed, 'after a switch it resumes: --resume BUILT-session');
  check(!readFileSync(argLog3, 'utf8').includes('--session-id BUILT-session'), 'and never --session-id again');
  stopWindow(tag2, { close: true });
} catch (err) {
  console.error(`\n  ERROR  ${err.stack || err.message}`);
  failures++;
} finally {
  if (tag) { try { stopWindow(tag, { close: true }); } catch { /* already stopped */ } }
  if (tag2) { try { stopWindow(tag2, { close: true }); } catch { /* already stopped */ } }
  console.log(`\n  runner log:\n${windowLog(tag || '').split(/\r?\n/).filter(Boolean).map((l) => `    ${l}`).join('\n')}`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
