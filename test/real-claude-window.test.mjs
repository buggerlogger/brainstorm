// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// real-claude-window.test.mjs — the session window with the REAL claude.
//
//   node test/real-claude-window.test.mjs
//
// The stub-based tests passed while the real thing was broken: the runner
// resolved `claude` to npm's claude.ps1 and Start-Process opened it by file
// association instead of running it, so claude never started. A fake .cmd
// cannot catch that. This uses whatever `claude` is on PATH, in interactive
// mode -- it just sits at its prompt, which is all the check needs: the right
// process, with the right --resume id, alive in the window. Then it switches
// sessions and checks the old process is gone and a new one has the new id.
// No prompt is ever sent, so no API call is made.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readdirSync, existsSync } from 'node:fs';
import { openSessionWindow, resumeInWindow, stopWindow, windowLog } from '../src/server/session-window.mjs';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function claudeProcsFor(id) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--resume ${id}*' -and $_.Name -ne 'powershell.exe' } | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.Name }`],
  { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '').split(/\r?\n/).filter(Boolean).map((l) => ({ pid: Number(l.split('|')[0]), name: l.split('|')[1] }));
}

async function waitFor(pred, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(700); }
  return null;
}

// Two real sessions from one project folder, so --resume finds both.
const cwd = join(homedir(), 'Desktop', 'my-work', 'ctxtest-skill');
const proj = join(homedir(), '.claude', 'projects', cwd.replace(/[:\\/.]/g, '-'));
const ids = existsSync(proj) ? readdirSync(proj).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, '')).slice(0, 2) : [];
if (ids.length < 2 || !existsSync(cwd)) {
  console.log(`  SKIP  need two sessions under ${proj}`);
  process.exit(0);
}
const [A, B] = ids;

let tag = null;
try {
  step(`open a window running the real claude --resume ${A.slice(0, 8)}`);
  const w = openSessionWindow({ sessionId: A, cwd });
  tag = w.tag;
  check(!!tag, 'window opened', `${w.host}, tag ${tag}`);

  const startLine = await waitFor(() => (windowLog(tag).match(/start (\S+) (\S+)/) || [])[0]);
  check(!!startLine, 'the runner started something', startLine);
  check(/start Application /.test(startLine || ''), 'it resolved claude to a PROGRAM, not claude.ps1', startLine);

  const procA = await waitFor(() => claudeProcsFor(A)[0]);
  check(!!procA, `a real claude process is running with --resume ${A.slice(0, 8)}…`, procA && `${procA.name} pid ${procA.pid}`);
  await sleep(4000);
  check(!!claudeProcsFor(A)[0], 'and it STAYS running (interactive, waiting at its prompt)');

  step(`switch the window to ${B.slice(0, 8)}, as Save & Resume does`);
  const sw = resumeInWindow(tag, B);
  check(sw.wasRunning && sw.ended, 'the running claude was ended', `pid ${sw.claudePid}`);
  const procB = await waitFor(() => claudeProcsFor(B)[0]);
  check(!!procB, `a real claude is running with --resume ${B.slice(0, 8)}…`, procB && `${procB.name} pid ${procB.pid}`);
  check(claudeProcsFor(A).length === 0, `nothing is left running --resume ${A.slice(0, 8)}…`);
  check((windowLog(tag).match(/runner started/g) || []).length === 1, 'still ONE runner: the same window');
} catch (err) {
  console.error(`\n  ERROR  ${err.stack || err.message}`);
  failures++;
} finally {
  if (tag) { try { stopWindow(tag, { close: true }); } catch { /* already stopped */ } }
  console.log(`\n  runner log:\n${windowLog(tag || '').split(/\r?\n/).filter(Boolean).map((l) => `    ${l}`).join('\n')}`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
