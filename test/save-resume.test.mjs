// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// save-resume.test.mjs — the whole loop the UI's Save & Resume button runs.
//
//   node test/save-resume.test.mjs [http://127.0.0.1:7788]
//
// Opens a REAL terminal window. "claude" is a stub (.cmd that logs its args and
// waits), set through the claudePath setting and restored afterwards, so the
// test needs no interactive session:
//
//   open a session -> edit a block -> Save & Resume
//     -> build + install produce a new session id N1
//     -> a window opens running `claude --resume N1`
//   edit again -> Save & Resume
//     -> a new id N2, and the SAME window switches to `--resume N2`
//
// "Same window" is checked by the runner's own pid. The edit is checked in the
// transcript the stub was pointed at, so a resume of the wrong file fails.

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = process.argv[2] || 'http://127.0.0.1:7788';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(BASE + path, opt);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 300) }; }
  if (!res.ok || data.error) throw new Error(data.error || `${res.status} ${path}`);
  return data;
}

async function waitFor(pred, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(500);
  }
  return null;
}

const work = mkdtempSync(join(tmpdir(), 'bs-saveresume-'));
const argLog = join(work, 'args.log');
const stub = join(work, 'fake-claude.cmd');
writeFileSync(stub, ['@echo off', `echo %* >> "${argLog}"`, 'ping -n 600 127.0.0.1 > nul'].join('\r\n'));

let original = null;
let tag = null;
try {
  original = (await api('/api/settings')).settings;
  await api('/api/settings', { claudePath: stub, resumeOnSave: true, claudeArgs: '' });

  step('open a small session');
  const { results } = await api('/api/find-sessions?q=');
  const pick = results.find((r) => r.bytes > 20000 && r.bytes < 2.5e6 && !r.duplicate);
  check(!!pick, 'picked a session', pick?.id);
  const st = await api('/api/open', { session: pick.path });
  check(st.open, 'opened', `${st.totals.blocks} blocks`);
  const target = st.groups.flatMap((g) => g.blocks).find((b) => b.kind === 'text');
  check(!!target, 'found a text block to edit', `#${target?.id}`);

  step('edit #1 -> Save & Resume');
  const MARK1 = `SAVE-RESUME-ONE-${Date.now()}`;
  const b0 = await api(`/api/block?id=${target.id}`);
  await api('/api/block', { id: target.id, text: `${b0.text}\n${MARK1}` });
  const r1 = await api('/api/save-resume', {});
  check(r1.ok === true, 'build + install succeeded', r1.summary?.newId);
  check(!!r1.window && r1.window.reused === false, 'a session window was opened', r1.window && `tag ${r1.window.tag}`);
  tag = r1.window?.tag;
  const n1 = r1.summary.newId;
  check(readFileSync(r1.summary.installed, 'utf8').includes(MARK1), 'the installed transcript carries the edit');
  check(r1.state?.config?.sessionId === n1, 'the editor moved to the new session', n1);

  const started1 = await waitFor(() => existsSync(argLog) && readFileSync(argLog, 'utf8').includes(`--resume ${n1}`));
  check(!!started1, `the window started claude --resume ${n1.slice(0, 8)}…`);
  const runnerPid = await waitFor(async () => {
    const w = await api('/api/window', { action: 'log' });
    const m = w.log.match(/runner started pid (\d+)/);
    return m ? Number(m[1]) : null;
  });
  check(!!runnerPid, 'the runner recorded its pid', String(runnerPid));

  step('edit #2 -> Save & Resume again');
  const MARK2 = `SAVE-RESUME-TWO-${Date.now()}`;
  const fresh = (await api('/api/state')).groups.flatMap((g) => g.blocks).find((b) => b.kind === 'text');
  const b1 = await api(`/api/block?id=${fresh.id}`);
  await api('/api/block', { id: fresh.id, text: `${b1.text}\n${MARK2}` });
  const r2 = await api('/api/save-resume', {});
  check(r2.ok === true, 'second build + install succeeded', r2.summary?.newId);
  const n2 = r2.summary.newId;
  check(n2 !== n1, 'it produced a different session id', `${n1.slice(0, 8)} -> ${n2.slice(0, 8)}`);
  check(r2.window?.reused === true && r2.window.tag === tag, 'it REUSED the same window', r2.window && `tag ${r2.window.tag}`);
  check(r2.window?.ended === true, 'the running claude was ended so the window could switch');

  const started2 = await waitFor(() => readFileSync(argLog, 'utf8').includes(`--resume ${n2}`));
  check(!!started2, `the same window started claude --resume ${n2.slice(0, 8)}…`);
  const raw2 = readFileSync(r2.summary.installed, 'utf8');
  check(raw2.includes(MARK1) && raw2.includes(MARK2), 'the second session carries BOTH edits');

  const log = (await api('/api/window', { action: 'log' })).log;
  check(new RegExp(`runner started pid ${runnerPid}`).test(log) && (log.match(/runner started/g) || []).length === 1,
    'one runner for both sessions: the window was never replaced', `runner ${runnerPid}`);

  const lines = readFileSync(argLog, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.trim());
  check(lines.length === 2 && lines[0].endsWith(n1) && lines[1].endsWith(n2), 'claude was started exactly twice, N1 then N2', JSON.stringify(lines.map((l) => l.slice(-12))));
} catch (err) {
  console.error(`\n  ERROR  ${err.stack || err.message}`);
  failures++;
} finally {
  try { if (tag) await api('/api/window', { action: 'stop', tag }); } catch { /* already stopped */ }
  try {
    if (original) await api('/api/settings', { claudePath: original.claudePath, resumeOnSave: original.resumeOnSave, claudeArgs: original.claudeArgs });
  } catch { /* report below */ }
  const restored = original ? (await api('/api/settings')).settings.claudePath === original.claudePath : false;
  console.log(`\n  settings restored: ${restored}`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
