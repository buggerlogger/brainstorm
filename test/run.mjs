// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// run.mjs — the test runner.
//
//   node test/run.mjs            fast: syntax, UI wiring, flow model, zip/export
//   node test/run.mjs --all      also everything that needs a server, a browser,
//                                a terminal window, or real Claude sessions
//   node test/run.mjs --exe      also build dist/brainstorm.exe and test it
//
// The slow suites are opt-in because they open windows on screen and start
// real `claude -p` sessions. They are the only tests that prove the thing
// works, so they are not optional before a release -- only before a quick edit.

import { spawnSync, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ALL = process.argv.includes('--all');
const EXE = process.argv.includes('--exe');
const PORT = 7799;
const EXE_PORT = 7798;

let failed = 0;
// ⛔ A test run gets an app data folder of its OWN. The servers and windows
// the tests start used to share the person's: settings, session windows,
// live.json. When a server crashed mid-test, save-resume's stub claude was
// left as the claudePath setting -- MEASURED: the person's next terminal ran
// the stub (it prints nothing and waits) instead of claude. Every child
// inherits this; tests that need a home of their own still set one.
if (!process.env.BRAINSTORM_HOME) process.env.BRAINSTORM_HOME = mkdtempSync(join(tmpdir(), 'bs-test-home-'));
console.log(`app data for this run: ${process.env.BRAINSTORM_HOME}`);

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(label, file, args = []) {
  process.stdout.write(`\n──── ${label}\n`);
  const r = spawnSync(process.execPath, [join(HERE, file), ...args], { stdio: 'inherit', cwd: ROOT });
  const ok = r.status === 0;
  results.push({ label, ok });
  if (!ok) failed++;
  return ok;
}

// A transcript that records api-request data, for the flow test. Only a
// minority of sessions have it, so one is SEARCHED for rather than hardcoded:
// a hardcoded path is how the old tool came to report line numbers from a
// session that had nothing to do with its input.
function findRecordedTranscript() {
  const P = join(homedir(), '.claude', 'projects');
  if (!existsSync(P)) return null;
  for (const d of readdirSync(P)) {
    const dir = join(P, d);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = join(dir, f);
      const size = statSync(file).size;
      if (size < 1000 || size > 8 * 1024 * 1024) continue;
      let fd;
      try {
        fd = openSync(file, 'r');
        const buf = Buffer.alloc(Math.min(2 * 1024 * 1024, size));
        readSync(fd, buf, 0, buf.length, 0);
        if (buf.toString('utf8').includes('"api-request-shape"')) return file;
      } catch { /* skip */ } finally {
        if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
      }
    }
  }
  return null;
}

async function startServer(cmd, args, port) {
  const srv = spawn(cmd, args, { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/version`)).ok) return srv; } catch { /* not yet */ }
    await sleep(250);
  }
  srv.kill();
  throw new Error(`server on ${port} did not start`);
}

console.log(`brainstorm tests  ${ALL ? '(all)' : '(fast; --all for the rest)'}${EXE ? ' + exe' : ''}`);

// 1. syntax of every source file
{
  process.stdout.write('\n──── syntax\n');
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) { if (!['node_modules', '.git', 'dist'].includes(f)) walk(p); }
      else if (f.endsWith('.mjs') || (f.endsWith('.js') && dirname(p).endsWith('ui'))) files.push(p);
    }
  };
  walk(ROOT);
  let bad = 0;
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) { bad++; console.log(`  FAIL  ${f.replace(ROOT, '.')}\n${r.stderr}`); }
  }
  console.log(`  ${files.length - bad}/${files.length} files parse`);
  results.push({ label: 'syntax', ok: bad === 0 });
  if (bad) failed++;
}

// 2. fast, no server
run('ui wiring', 'ui.test.mjs');
run('zip + export', 'export.test.mjs');
run('export dir follows BRAINSTORM_HOME', 'export-home.test.mjs');
{
  const t = findRecordedTranscript();
  if (t) run('flow (recorded mode)', 'flow.test.mjs', [t]);
  else { console.log('\n──── flow\n  SKIP  no transcript with api-request records on this machine'); results.push({ label: 'flow (skipped)', ok: true }); }
}

// recorder: replayed transcripts, so it needs no claude and no network
run("recorder: live calls match the transcript", "recorder.test.mjs");
run("recorder: double start + overlapping ticks", "recorder-concurrency.test.mjs");
// live hooks: the feed, live.json, adopting a terminal -- its own server, no claude
run("live hooks: feed, live.json, adopting a terminal", "live.test.mjs");
run("main context: survives a rewind, paused by a compaction", "pins.test.mjs");
run("build rules: never an empty message; a dropped call takes its result", "build-rules.test.mjs");
run("after a rewind or a /compact in claude: what is sent, where pins go", "rewind-compact.test.mjs");
run("the Live feed through a /compact; requests that never ended", "live-compact.test.mjs");

// 3. everything that needs a server
if (ALL) {
  const srv = await startServer(process.execPath, [join(ROOT, 'bin', 'app.mjs'), '--no-window', '--port', String(PORT)], PORT);
  const base = `http://127.0.0.1:${PORT}`;
  try {
    run('ui end to end (headless Edge)', 'ui-e2e.test.mjs', [base]);
    run('recording view: live calls on screen', 'recording-e2e.test.mjs', [base]);
    run('api: edit, pins, rewind, integrity', 'api.test.mjs', [base]);
    run('shell + live detection (real claude -p)', 'shell.test.mjs', [base]);
    run('real terminal window + attach', 'console.test.mjs', [base, '--open']);
    run('save & resume, same window', 'save-resume.test.mjs', [base]);
  } finally {
    srv.kill();
  }
  run('presence: background window keeps the app alive', 'presence.test.mjs');
  run('session window switches in place', 'window.test.mjs');
  run('editing from the debugger, the rewind warning, resizable panes', 'edit-e2e.test.mjs');
  run('live hooks inside a real claude (brainstorm-live mod)', 'live-mod.test.mjs');
  run('the REAL claude in the session window', 'real-claude-window.test.mjs');
  run('skill swap (two real claude sessions)', 'skillswap.test.mjs');
  run('the whole loop with a real claude: edit, Save & Resume, ask, task, twice', 'real-flow.test.mjs');
  run('editing a COMPACTED context with a real claude, compacted twice', 'real-compact.test.mjs');
}

// 4. the packaged exe
if (EXE) {
  process.stdout.write('\n──── build dist/brainstorm.exe\n');
  const b = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-exe.mjs')], { stdio: 'inherit', cwd: ROOT });
  results.push({ label: 'build exe', ok: b.status === 0 });
  if (b.status !== 0) failed++;
  else {
    const exe = join(ROOT, 'dist', process.platform === 'win32' ? 'brainstorm.exe' : 'brainstorm');
    const srv = await startServer(exe, ['--no-window', '--port', String(EXE_PORT)], EXE_PORT);
    try { run('exe end to end', 'exe.test.mjs', [`http://127.0.0.1:${EXE_PORT}`]); } finally { srv.kill(); }
    run('exe presence', 'presence.test.mjs', [exe]);
    run('exe launch: no console, flags, close ends it', 'launch.test.mjs', [exe]);
  }
}

console.log('\n════ summary');
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}`);
console.log(`\n${failed === 0 ? 'ALL SUITES PASSED' : `${failed} SUITE(S) FAILED`}\n`);
process.exit(failed ? 1 : 0);
