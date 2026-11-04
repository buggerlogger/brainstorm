// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// live-mod.test.mjs — the brainstorm-live mod inside a REAL claude.
//
//   node test/live-mod.test.mjs
//
// A brainstorm with its own BRAINSTORM_HOME is started; claude -p runs with
// --plugin-dir on mod/brainstorm-live and BRAINSTORM_LIVE naming that
// brainstorm's live.json, and is asked to read a file and answer. Everything
// the Live panel draws must then be on the server, from claude's own engine:
// each model request with what was sent and the moment of each phase, the
// Read call with its arguments before it ran and what came back, the usage,
// and the end of the turn.

import { spawn } from 'node:child_process';
import { runClaude } from './claude-cli.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MOD = join(ROOT, 'mod', 'brainstorm-live');
const PORT = 7796;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);

// This session's own variables would make the child think it is a child of
// THIS claude; everything else (PATH, a git-bash path) is kept.
const SESSION_VARS = ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH'];

const home = mkdtempSync(join(tmpdir(), 'bs-livemod-home-'));
const work = mkdtempSync(join(tmpdir(), 'bs-livemod-work-'));
writeFileSync(join(work, 'note.txt'), 'numbers: 21 37 49\n');

const srv = spawn(process.execPath, [join(ROOT, 'bin', 'app.mjs'), '--no-window', '--port', String(PORT)], {
  cwd: ROOT, stdio: 'ignore', env: { ...process.env, BRAINSTORM_HOME: home },
});
try {
  step('a brainstorm to post to');
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${BASE}/api/version`)).ok; } catch { await sleep(250); } }
  check(up, 'started with its own home');
  const liveJson = join(home, 'live.json');
  let named = null;
  for (let i = 0; i < 20 && !named; i++) { try { const j = JSON.parse(readFileSync(liveJson, 'utf8')); if (j.port === PORT) named = j; } catch { await sleep(250); } }
  check(!!named, 'live.json names it', named ? `port ${named.port}` : 'missing');
  if (!named) throw new Error('nothing for the mod to find');

  step('claude -p with the mod');
  const env = { ...process.env, BRAINSTORM_LIVE: liveJson };
  for (const k of SESSION_VARS) delete env[k];
  const apiError = (out) => /API Error|Message ID: msg_|overloaded|rate limit/i.test(out);
  let out = '';
  let t0 = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await fetch(`${BASE}/api/hooks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'clear' }) });
    t0 = Date.now();
    const r = runClaude([
      '-p', 'Read note.txt, then work out which of its numbers is prime. Reply with just that number.',
      '--plugin-dir', MOD,
      '--permission-mode', 'bypassPermissions',
    ], { cwd: work, env, encoding: 'utf8', input: '', maxBuffer: 16 * 1024 * 1024, timeout: 240000 });
    out = `${r.stdout || ''}${r.stderr || ''}`;
    if (out.includes('37') || !apiError(out)) break;
    console.log(`    attempt ${attempt}: the Claude API returned an error; retrying`);
  }
  check(out.trim().split('\n').pop().includes('37'), 'claude answered', out.trim().split('\n').pop());
  check(!/brainstorm-live/.test(out), 'no complaint about the mod on stderr', out.match(/.*brainstorm-live.*/)?.[0] || '');

  step('what reached brainstorm, from inside claude');
  await sleep(800);   // the last posts are not awaited by claude
  const live = await (await fetch(`${BASE}/api/hooks?since=0`)).json();
  const steps = live.steps;
  check(steps.length >= 2, 'one record per model request', `${steps.length} request(s)`);
  const first = steps[0];
  const second = steps[1];
  if (first) {
    check(first.messageCount > 0 && typeof first.model === 'string', 'the first request: what was sent', `${first.model} · ${first.messageCount} messages · effort ${first.effort}`);
    check(first.sentAt >= t0 && first.firstAt > first.sentAt && first.stopAt >= first.firstAt,
      'and when: sent, first chunk, stop', `waited ${first.firstAt - first.sentAt} ms for the first chunk`);
    // the model picks the tool (Read one run, Bash cat the next): the test is that
    // it called ONE, not which
    check(first.stopReason === 'tool_use' && first.tools.length > 0, 'it stopped to call a tool', `${first.stopReason}: ${first.tools.map((t) => t.name).join(', ')}`);
    const u = first.usage || {};
    check(Number.isFinite(u.cache_read_input_tokens) && Number.isFinite(u.cache_creation_input_tokens) && Number.isFinite(u.output_tokens),
      'with the usage the API reported', `cache read ${u.cache_read_input_tokens} · written ${u.cache_creation_input_tokens} · new ${u.input_tokens} · out ${u.output_tokens}`);
  }
  const read = live.tools.find((t) => JSON.stringify(t.input || {}).includes('note.txt'));
  check(!!read, 'the tool call that read note.txt, with what it was given', read ? `${read.tool} ${JSON.stringify(read.input).slice(0, 90)}` : 'none');
  if (read) {
    check(read.doneAt !== null && read.doneAt >= read.startAt && String(read.text || '').includes('21 37 49'), 'and what came back to the model', `${(read.text || '').length} chars in ${read.doneAt - read.startAt} ms`);
    check(first && first.tools.some((t) => t.id === read.id), 'the call and the request that chose it share one tool_use_id', read.id);
    if (second) check(second.sentAt >= read.doneAt, 'the next request went out only after the tool came back', `${second.sentAt - read.doneAt} ms later`);
  }
  if (second) {
    check(second.messageCount > first.messageCount, 'the second request carried more messages: the call and its result', `${first.messageCount} -> ${second.messageCount}`);
    check((second.usage?.cache_read_input_tokens || 0) > 0, 'and read the first one\'s context from the prompt cache', `${second.usage?.cache_read_input_tokens} tokens`);
    check(second.text.includes('37'), 'its visible text is the answer', JSON.stringify(second.text));
  }
  const turn = live.turns[live.turns.length - 1];
  check(turn && turn.reason === 'answer' && turn.durationMs > 0, 'the turn ended with an answer', turn ? `${turn.durationMs} ms` : 'none');

  step('installed from the marketplace: no BRAINSTORM_LIVE, it finds brainstorm by itself');
  // what a marketplace install looks like: nothing tells the mod where
  // brainstorm is, so it looks where the app keeps its data (BRAINSTORM_HOME
  // here, so the person's own app is never the one that hears it)
  await fetch(`${BASE}/api/hooks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'clear' }) });
  const env2 = { ...env, BRAINSTORM_HOME: home };
  delete env2.BRAINSTORM_LIVE;
  runClaude(['-p', 'Reply with one word: ok', '--plugin-dir', MOD], { cwd: work, env: env2, encoding: 'utf8', input: '', timeout: 240000 });
  await sleep(800);
  const live2 = await (await fetch(`${BASE}/api/hooks?since=0`)).json();
  check(live2.steps.length >= 1 && live2.turns.length >= 1, 'its request reached brainstorm all the same', `${live2.steps.length} request(s), ${live2.turns.length} turn(s)`);
} catch (err) {
  console.error(`\n  ERROR  ${err.stack || err.message}`);
  failures++;
} finally {
  srv.kill();
  await sleep(400);
  for (const d of [home, work]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* still held */ } }
  // claude writes the types beside a --plugin-dir mod it loads; they are not the repo's
  if (existsSync(join(MOD, '.claude-plugin', 'types'))) console.log('  (claude laid its types in mod/brainstorm-live/.claude-plugin/types: ignored by .gitignore)');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
