// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// real-flow.test.mjs — the whole loop with a REAL claude, in a new folder.
//
//   node test/real-flow.test.mjs
//
// 1. a new session does a small task that puts a fact in the context:
//    codename LARK-21, owner Maya (in the prompt, a tool call, its result and
//    the reply)
// 2. brainstorm opens it; the fact is edited everywhere (HERON-77, Noor) and
//    one message is CLEARED -- what broke a real session with "400
//    messages.0: user messages must have non-empty content"
// 3. Save & Resume (the same route the button calls; the terminal window part
//    has tests of its own, and an interactive claude cannot be asked questions
//    here), and the installed session is checked on disk
// 4. claude is asked, without tools, what the conversation says -- the edit
//    must be what it answers -- and is given a new small task
// 5. round two: reopened, the tool call of that task dropped, a main context
//    set; Save & Resume again; claude asked again
//
// A brainstorm with its own BRAINSTORM_HOME; the folder and the project's
// transcripts are removed at the end.

import { spawn, spawnSync } from 'node:child_process';
import { runClaude } from './claude-cli.mjs';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CTX = join(ROOT, 'src', 'ctx.mjs');
const PORT = 7785;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);

const SESSION_VARS = ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH'];
const env = { ...process.env };
for (const k of SESSION_VARS) delete env[k];

const W = mkdtempSync(join(tmpdir(), 'bs-real-flow-'));
const PROJ = join(homedir(), '.claude', 'projects', W.replace(/[:\\/.]/g, '-'));
const apiError = (out) => /API Error|Message ID: msg_|overloaded|rate limit/i.test(out);
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
function claude(prompt, args = [], { retries = 2 } = {}) {
  let out = '';
  for (let i = 0; i <= retries; i++) {
    const r = runClaude(['-p', prompt, ...args], { cwd: W, env, encoding: 'utf8', input: '', maxBuffer: 32 * 1024 * 1024, timeout: 300000 });
    out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    if (!apiError(out) || /400/.test(out)) break;   // a 400 is OURS: never retried away
    console.log(`    the Claude API returned an error; retrying (${i + 1})`);
  }
  return out;
}
async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(BASE + path, opt);
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `${res.status} ${path}`);
  return data;
}
const chainText = (file) => {
  const recs = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const by = new Map(recs.filter((r) => r.uuid).map((r) => [r.uuid, r]));
  const leaf = [...recs].reverse().find((r) => (r.type === 'user' || r.type === 'assistant') && r.message);
  const chain = [];
  for (let r = leaf; r; r = r.parentUuid ? by.get(r.parentUuid) : null) chain.unshift(r);
  return { chain, text: JSON.stringify(chain.map((r) => r.message?.content ?? '')) };
};
const blankMsg = (r) => {
  const c = r.message?.content;
  return r.message && ((typeof c === 'string' && !c.trim()) || (Array.isArray(c) && (!c.length || c.every((p) => p.type === 'text' && !String(p.text || '').trim()))));
};
const memoryMentions = (needle) => {
  const m = join(PROJ, 'memory');
  if (!existsSync(m)) return [];
  return readdirSync(m).filter((f) => readFileSync(join(m, f), 'utf8').includes(needle));
};

const home = mkdtempSync(join(tmpdir(), 'bs-real-flow-home-'));
writeFileSync(join(home, 'settings.json'), JSON.stringify({ autoOpenConsole: false, follow: false }));
const srv = spawn(process.execPath, [join(ROOT, 'bin', 'app.mjs'), '--no-window', '--port', String(PORT)], {
  cwd: ROOT, stdio: 'ignore', env: { ...process.env, BRAINSTORM_HOME: home },
});
try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${BASE}/api/version`)).ok; } catch { await sleep(250); } }
  check(up, 'a brainstorm with its own BRAINSTORM_HOME started');

  step('1. a new session in a new folder, with a small task');
  const S = randomUUID();
  const o1 = claude('Do not save anything to memory. Create a file plan.md containing exactly: Codename LARK-21. Owner Maya. Then reply with one line: the codename and the owner.', ['--session-id', S, '--permission-mode', 'bypassPermissions']);
  check(/LARK-21/.test(o1) && existsSync(join(W, 'plan.md')), 'claude did the task', lines(o1).pop());
  const o2 = claude('Without using any tools, reply with one line: who is the owner?', ['--resume', S]);
  check(/Maya/.test(o2), 'and knows the owner (control)', lines(o2).pop());
  const leaked = memoryMentions('LARK-21');
  check(leaked.length === 0, 'claude did not save the fact to its memory files (an edit could not reach those)', leaked.join(', '));
  const src = join(PROJ, `${S}.jsonl`);

  step('2. open it in brainstorm, edit the fact everywhere, clear one message');
  let st = await api('/api/open', { session: src });
  check(st.open && st.config.sessionId === S, 'opened', `${st.totals.blocks} blocks`);
  const all = st.groups.flatMap((g) => g.blocks);
  let edited = 0;
  for (const b of all) {
    const full = await api(`/api/block?id=${b.id}`);
    if (!/LARK-21|Maya/.test(full.text)) continue;
    await api('/api/block', { id: b.id, text: full.text.replaceAll('LARK-21', 'HERON-77').replaceAll('Maya', 'Noor') });
    edited++;
  }
  check(edited >= 3, 'the fact was in several blocks; all edited', `${edited} block(s)`);
  const question = all.find((b) => b.role === 'user' && b.kind === 'text' && /who is the owner/.test(b.title));
  check(!!question, 'the control question is a block', question ? `#${question.id}` : 'none');
  if (question) await api('/api/block', { id: question.id, text: '' });
  await api('/api/save', {});

  step('3. Save & Resume');
  const sr1 = await api('/api/save-resume', { resume: false });
  const N1 = sr1.summary?.newId;
  check(sr1.ok && !!N1 && sr1.state.config.sessionId === N1, 'built, installed, and the editor moved to the new session', N1);
  check(/emptied\s+1 -> dropped/.test(sr1.out), 'the cleared message was DROPPED, not written empty', (sr1.out.match(/emptied.*$/m) || [''])[0].trim());
  const f1 = join(PROJ, `${N1}.jsonl`);
  const c1 = chainText(f1);
  check(!c1.chain.some(blankMsg), 'no empty message on the path claude resumes');
  check(!/LARK-21|Maya/.test(c1.text) && /HERON-77/.test(c1.text) && /Noor/.test(c1.text), 'the old fact is nowhere on it, the new one is');
  const v1 = spawnSync(process.execPath, [CTX, 'verify', '--file', f1], { encoding: 'utf8' });
  check(v1.status === 0, 'the engine verifies the installed session', lines(v1.stdout).pop());

  step('4. ask claude about the edit, then give it a small task');
  const a1 = claude('Without using any tools, reply with one line: the project codename and the owner, as this conversation states them.', ['--resume', N1]);
  check(!apiError(a1), 'claude answers (no API error)', apiError(a1) ? lines(a1).find((l) => /API Error/.test(l)) : '');
  check(/HERON-77/.test(a1) && /Noor/.test(a1) && !/LARK-21|Maya/.test(a1), 'it answers with the EDITED fact', lines(a1).pop());
  const t1 = claude('Create a file done.txt containing the word finished. Then reply with one line: OK.', ['--resume', N1, '--permission-mode', 'bypassPermissions']);
  check(existsSync(join(W, 'done.txt')) && /OK/i.test(lines(t1).pop() || ''), 'and does a new task in the resumed session', lines(t1).pop());

  step('5. round two: drop that task\'s tool call, set a main context, Save & Resume again');
  st = await api('/api/open', { session: f1 });
  check(st.config.sessionId === N1, 'reopened the resumed session, with the new turn in it', `${st.totals.blocks} blocks`);
  const blocks2 = st.groups.flatMap((g) => g.blocks);
  // by its full text: a tool call's title does not carry its arguments
  let call = null;
  let callFull = null;
  for (const b of blocks2.filter((x) => x.kind === 'tool_use')) {
    const full = await api(`/api/block?id=${b.id}`);
    if (full.text.includes('done.txt')) { call = b; callFull = full; break; }
  }
  check(!!callFull && callFull.text.includes('done.txt'), 'the done.txt tool call is a block', call ? `#${call.id}` : 'none');
  if (call) await api('/api/block', { id: call.id, keep: false });
  // a FACT only the main context holds: whether claude can state it is what
  // shows the text arrived (an instruction only shows whether it was obeyed --
  // measured: "end every reply with ROGER" was followed twice, then not)
  const main = await api('/api/main', { text: 'The release date is 14 March 2027.' });
  check(main.main.applied, 'the main context is pinned into the first user message', `#${main.main.blockId}`);
  await api('/api/save', {});
  const sr2 = await api('/api/save-resume', { resume: false });
  const N2 = sr2.summary?.newId;
  check(sr2.ok && !!N2, 'built and installed again', N2);
  check(/paired drops\s+1/.test(sr2.out), 'the call\'s result was dropped with it', (sr2.out.match(/paired drops.*$/m) || [''])[0].trim());
  const c2 = chainText(join(PROJ, `${N2}.jsonl`));
  const calls2 = c2.chain.flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : []))
    .filter((x) => x.type === 'tool_use' && JSON.stringify(x.input || {}).includes('done.txt'));
  check(calls2.length === 0, 'the tool call is gone from what claude resumes', `${calls2.length} left`);
  check(!c2.chain.some(blankMsg), 'still no empty message');
  const a2 = claude('Without using any tools, reply with one line: the project codename, and the release date if this conversation states one.', ['--resume', N2]);
  check(!apiError(a2), 'claude answers (no API error)', apiError(a2) ? lines(a2).find((l) => /API Error/.test(l)) : '');
  check(/HERON-77/.test(a2), 'the edit from round one survived round two', lines(a2).pop());
  check(/14 March/i.test(a2), 'and the main context reached claude: it states the release date only the main context holds', lines(a2).pop());
} catch (err) {
  console.error(`\n  ERROR  ${err.stack || err.message}`);
  failures++;
} finally {
  srv.kill();
  await sleep(500);
  // this test's own folder, its own sessions, its own app data
  for (const d of [W, home, PROJ]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* held */ } }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
