// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// real-compact.test.mjs — editing a COMPACTED context, with a real claude.
//
//   node test/real-compact.test.mjs
//
// The flow a person used and saw fail: chat, /compact, open the compacted
// context in brainstorm, edit the summary, add a main context, Save & Resume,
// and ask claude whether it knows what was added. Then compact AGAIN after
// resuming, and do it once more.
//
// MEASURED before the fixes this proves: the main context went into a message
// from before the compaction (never sent), and the summary made by a /compact
// after opening was no block at all until a refresh.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7779;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const note = (label, detail = '') => console.log(`  NOTE  ${label}${detail ? `  -- ${detail}` : ''}`);
const step = (s) => console.log(`\n== ${s}`);

const SESSION_VARS = ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH'];
const env = { ...process.env };
for (const k of SESSION_VARS) delete env[k];
const W = mkdtempSync(join(tmpdir(), 'bs-real-compact-'));
const PROJ = join(homedir(), '.claude', 'projects', W.replace(/[:\\/.]/g, '-'));
const apiError = (out) => /API Error|Message ID: msg_|overloaded|rate limit/i.test(out);
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
function claude(prompt, args = [], { retries = 2 } = {}) {
  let out = '';
  for (let i = 0; i <= retries; i++) {
    const r = spawnSync('claude', ['-p', `"${prompt}"`, ...args], { cwd: W, env, shell: true, encoding: 'utf8', input: '', maxBuffer: 32 * 1024 * 1024, timeout: 400000 });
    out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    if (!apiError(out) || /400/.test(out)) break;
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
const recsOf = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l, i) => ({ ...JSON.parse(l), _l: i + 1 }));
function chainOf(file) {
  const recs = recsOf(file);
  const by = new Map(recs.filter((r) => r.uuid).map((r) => [r.uuid, r]));
  const leaf = [...recs].reverse().find((r) => (r.type === 'user' || r.type === 'assistant') && r.message && !r.isSidechain);
  const chain = [];
  for (let r = leaf; r; r = r.parentUuid ? by.get(r.parentUuid) : null) chain.unshift(r);
  return { recs, chain };
}
const summaryOf = (file) => {
  const { chain } = chainOf(file);
  return chain.find((r) => r.isCompactSummary) || null;
};

const home = mkdtempSync(join(tmpdir(), 'bs-real-compact-home-'));
writeFileSync(join(home, 'settings.json'), JSON.stringify({ autoOpenConsole: false, follow: false }));
const srv = spawn(process.execPath, [join(ROOT, 'bin', 'app.mjs'), '--no-window', '--port', String(PORT)], {
  cwd: ROOT, stdio: 'ignore', env: { ...process.env, BRAINSTORM_HOME: home },
});
const ASK = 'Without using any tools, reply with one line: the codename, the owner, the deploy day, and the release date, as this conversation states them; say unknown for any it does not state.';
try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(`${BASE}/api/version`)).ok; } catch { await sleep(250); } }
  check(up, 'a brainstorm with its own BRAINSTORM_HOME started');

  step('1. a new chat in a new folder: a fact and a small task');
  const S = randomUUID();
  const o1 = claude('Do not save anything to memory. For this project the codename is KITE-9 and the owner is Lina. Create a file notes.txt containing the word draft. Then reply with one line: OK.', ['--session-id', S, '--permission-mode', 'bypassPermissions']);
  check(existsSync(join(W, 'notes.txt')), 'claude did the task', lines(o1).pop());
  claude('Without using any tools, reply with one line: what is 7 times 6?', ['--resume', S]);

  step('2. /compact in the chat');
  claude('/compact', ['--resume', S]);
  const src = join(PROJ, `${S}.jsonl`);
  const sum1 = summaryOf(src);
  check(!!sum1, 'the session was compacted: its conversation now starts at a summary', sum1 ? `L${sum1._l}` : 'no summary');

  step('3. open it in brainstorm and read the compacted context');
  let st = await api('/api/open', { session: src });
  const all = st.groups.flatMap((g) => g.blocks);
  const sb = all.find((b) => b.line === sum1?._l);
  check(!!sb && sb.sent !== false, 'the summary is a block, and the one claude is sent', sb ? `#${sb.id}` : 'none');
  check(st.totals.notSent >= 2, 'the messages from before the compaction are filed as not sent', `${st.totals.notSent} not sent`);
  const sumText = sb ? (await api(`/api/block?id=${sb.id}`)).text : '';
  const kept = { codename: /KITE-9/.test(sumText), owner: /Lina/.test(sumText) };
  note('what claude kept in its summary', JSON.stringify(kept));

  step('4. edit the summary, and add a main context');
  await api('/api/block', { id: sb.id, text: `${sumText}\n\nAlso: the deploy day is Thursday.` });
  const m = await api('/api/main', { text: 'The release date is 14 March 2027.' });
  check(m.main.applied && m.main.blockId === sb.id, 'the main context went into the summary: the first message claude is sent', `#${m.main.blockId}`);
  await api('/api/save', {});

  step('5. Save & Resume, and ask');
  const sr1 = await api('/api/save-resume', { resume: false });
  const N1 = sr1.summary?.newId;
  check(sr1.ok && !!N1, 'built and installed', N1);
  const s1 = summaryOf(join(PROJ, `${N1}.jsonl`));
  check(!!s1 && /Thursday/.test(JSON.stringify(s1.message.content)) && /14 March 2027/.test(JSON.stringify(s1.message.content)), 'the summary claude resumes carries the edit and the main context');
  const a1 = claude(ASK, ['--resume', N1]);
  check(!apiError(a1), 'claude answers (no API error)', apiError(a1) ? lines(a1).find((l) => /API Error/.test(l)) : '');
  check(/Thursday/i.test(a1), 'it knows the deploy day added to the summary', lines(a1).pop());
  check(/14 March/i.test(a1), 'it knows the release date from the main context', lines(a1).pop());
  if (kept.codename) check(/KITE-9/.test(a1), 'and the codename the summary kept', lines(a1).pop());

  step('6. /compact AGAIN after resuming; brainstorm notices; once more');
  claude('/compact', ['--resume', N1]);
  const f1 = join(PROJ, `${N1}.jsonl`);
  const sum2 = summaryOf(f1);
  check(!!sum2 && sum2._l !== s1?._l, 'the resumed session compacted again', sum2 ? `new summary at L${sum2._l}` : 'none');
  let stale = null;
  for (let i = 0; i < 20 && !stale; i++) { const h = await api('/api/hooks'); if (h.stale?.compacted) stale = h.stale; else await sleep(500); }
  check(!!stale, 'brainstorm sees the new compaction and offers a refresh', JSON.stringify(stale));
  const sum2Text = JSON.stringify(sum2?.message?.content || '');
  note('what the second summary kept', JSON.stringify({ deployDay: /Thursday/.test(sum2Text), releaseDate: /14 March/.test(sum2Text) }));
  // the main context was saved before this compaction: paused by design until saved again
  const rf = await api('/api/refresh', {});
  const sb2 = rf.state.groups.flatMap((g) => g.blocks).find((b) => b.line === sum2?._l);
  check(!!sb2 && sb2.sent !== false, 'after a refresh the new summary is a block, and sent', sb2 ? `#${sb2.id}` : 'none');
  check(rf.state.main.paused === true, 'the main context is paused: Claude compacted since it was saved', JSON.stringify({ paused: rf.state.main.paused }));
  const m2 = await api('/api/main', { text: 'The release date is 14 March 2027.' });
  check(m2.main.applied && m2.main.blockId === sb2?.id, 'saved again, it goes into the NEW summary', `#${m2.main.blockId}`);
  const sr2 = await api('/api/save-resume', { resume: false });
  const N2 = sr2.summary?.newId;
  check(sr2.ok && !!N2, 'built and installed again', N2);
  const a2 = claude(ASK, ['--resume', N2]);
  check(!apiError(a2), 'claude answers (no API error)', apiError(a2) ? lines(a2).find((l) => /API Error/.test(l)) : '');
  check(/14 March/i.test(a2), 'after two compactions it still knows the main context', lines(a2).pop());
} catch (err) {
  console.error(`\n  ERROR  ${err.stack || err.message}`);
  failures++;
} finally {
  srv.kill();
  await sleep(500);
  for (const d of [W, home, PROJ]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* held */ } }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
