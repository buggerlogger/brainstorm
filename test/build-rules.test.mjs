// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// build-rules.test.mjs — what build must never write, and what extract must
// say is not sent. No claude, no network: a made-up transcript.
//
//   node test/build-rules.test.mjs
//
// Every rule here was MEASURED against the real API first (a compacted
// session whose summary was cleared -- exactly what broke a real session):
//
//   summary emptied ""          -> 400 messages.0: user messages must have non-empty content
//   summary left as whitespace  -> 400 text content blocks must contain non-whitespace text
//   summary dropped (keep:false) -> accepted, and the fact it held was gone
//   a tool call dropped alone    -> its result is refused without it
//
// So: clearing a block drops it; a dropped call takes its result; an empty
// message already in a session is repaired; verify refuses one written by
// hand; and blocks on no path claude resumes are marked not sent.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CTX = join(ROOT, 'src', 'ctx.mjs');
const { parseBlocks, writeBlocks, groupBlocks, NOT_SENT } = await import(pathToFileURL(join(ROOT, 'src', 'core', 'blocksmd.mjs')).href);

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);
const ctx = (args) => { const r = spawnSync(process.execPath, [CTX, ...args], { encoding: 'utf8' }); return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }; };

const W = mkdtempSync(join(tmpdir(), 'bs-rules-unit-'));
const SID = '11111111-2222-4333-8444-555555555555';
const at = (n) => `2026-11-04T08:${String(n).padStart(2, '0')}:00.000Z`;
const rec = (n, type, uuid, parentUuid, content, extra = {}) => ({
  type, uuid, parentUuid, sessionId: SID, cwd: W, timestamp: at(n),
  ...(type === 'user' || type === 'assistant' ? { message: { role: type, content } } : {}),
  ...extra,
});
// before the compaction | the compaction | a rewound branch | the live path
const base = [
  rec(1, 'user', 'a1', null, 'old prompt FACT-OLD'),
  rec(2, 'assistant', 'a2', 'a1', [{ type: 'text', text: 'old answer' }]),
  rec(3, 'system', 'c0', null, null, { subtype: 'compact_boundary', content: 'Conversation compacted' }),
  rec(4, 'user', 's1', 'c0', 'This session is being continued from a previous conversation. FACT-SUM', { isCompactSummary: true }),
  rec(5, 'assistant', 'b1', 's1', [{ type: 'text', text: 'ok' }]),
  rec(6, 'user', 'u2', 'b1', 'please run ls'),
  rec(7, 'assistant', 'b2', 'u2', [{ type: 'tool_use', id: 'toolu_T1', name: 'Bash', input: { command: 'ls' } }]),
  rec(8, 'user', 'u3', 'b2', [{ type: 'tool_result', tool_use_id: 'toolu_T1', content: 'a.txt' }]),
  rec(9, 'assistant', 'b3', 'u3', [{ type: 'text', text: 'done' }]),
  rec(10, 'user', 'x1', 'b3', 'abandoned prompt'),
  rec(11, 'assistant', 'x2', 'x1', [{ type: 'text', text: 'abandoned answer' }]),
  rec(12, 'user', 'u4', 'b3', 'final prompt'),
  rec(13, 'assistant', 'b4', 'u4', [{ type: 'text', text: 'final answer' }]),
];
const writeSession = (name, recs) => {
  const f = join(W, `${name}.jsonl`);
  writeFileSync(f, `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return f;
};
const chainOf = (file) => {
  const recs = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const by = new Map(recs.filter((r) => r.uuid).map((r) => [r.uuid, r]));
  const leaf = [...recs].reverse().find((r) => (r.type === 'user' || r.type === 'assistant') && r.message);
  const out = [];
  for (let r = leaf; r; r = r.parentUuid ? by.get(r.parentUuid) : null) out.unshift(r);
  return { recs, chain: out };
};
const blankMsg = (r) => {
  const c = r.message?.content;
  return (typeof c === 'string' && !c.trim()) || (Array.isArray(c) && (!c.length || c.every((p) => p.type === 'text' && !String(p.text || '').trim())));
};

// extract once; each variant edits a copy of the blocks and builds
const src = writeSession('source', base);
const X = join(W, 'x');
const ex = ctx(['extract', '--session', src, '--dir', X]);
check(ex.code === 0, 'extract ran', ex.code === 0 ? '' : ex.out.slice(-300));
const { header, blocks } = parseBlocks(join(X, 'BLOCKS.md'));
const byLine = (n) => blocks.find((b) => b.line === n);

step('extract: blocks on no path claude resumes are marked not sent');
{
  const off = blocks.filter((b) => b.sent === false).map((b) => b.line).sort((a, b) => a - b);
  check(off.join(',') === '1,2,10,11', 'before the compaction (L1, L2) and the rewound branch (L10, L11)', `not sent: L${off.join(', L')}`);
  check(blocks.filter((b) => b.sent !== false).every((b) => [4, 5, 6, 7, 8, 9, 12, 13].includes(b.line)), 'everything else is on the live path');
  const groups = groupBlocks(blocks);
  const ns = groups.find((g) => g.name === NOT_SENT);
  check(ns && ns.blocks.length === 4 && groups[groups.length - 1].name === NOT_SENT, 'the tree files them in their own folder, last', ns ? `${ns.blocks.length} in "${NOT_SENT}"` : 'none');
}

function build(name, mutate, recs = null) {
  const dir = join(W, name);
  let srcFile = src;
  if (recs) {
    srcFile = writeSession(`${name}-src`, recs);
    ctx(['extract', '--session', srcFile, '--dir', dir]);
  } else {
    ctx(['extract', '--session', src, '--dir', dir]);
  }
  const p = parseBlocks(join(dir, 'BLOCKS.md'));
  mutate(p.blocks);
  writeBlocks(join(dir, 'BLOCKS.md'), p.header, p.blocks);
  const built = join(dir, 'built.jsonl');
  const r = ctx(['build', '--dir', dir, '--out', built]);
  return { ...r, file: built };   // r.out is what build printed
}

step('a cleared summary is dropped, never written empty');
for (const [label, text] of [['emptied ""', ''], ['whitespace only', '   \n  ']]) {
  const r = build(`sum-${text.length}`, (bs) => { bs.find((b) => b.line === 4).text = text; });
  check(r.code === 0 && /emptied\s+1 -> dropped/.test(r.out), `${label}: build reports it as dropped`, (r.out.match(/emptied.*$/m) || [''])[0].trim());
  const { recs, chain } = chainOf(r.file);
  check(!recs.some((x) => x.uuid === 's1'), `${label}: the summary record is gone`);
  check(!chain.some(blankMsg), `${label}: no empty message on the path claude resumes`);
  check(chain.find((x) => x.uuid === 'b1')?.parentUuid === 'c0', `${label}: the chain is re-linked across it`, `b1 -> ${chain.find((x) => x.uuid === 'b1')?.parentUuid}`);
  check(!JSON.stringify(chain).includes('FACT-SUM'), `${label}: and the fact it held is gone`);
}

step('a dropped tool call takes its result with it');
{
  const r = build('drop-call', (bs) => { bs.find((b) => b.kind === 'tool_use').keep = false; });
  check(r.code === 0 && /paired drops\s+1/.test(r.out), 'build drops the result too, and says so', (r.out.match(/paired drops.*$/m) || [''])[0].trim());
  const { recs } = chainOf(r.file);
  check(!recs.some((x) => JSON.stringify(x.message?.content || '').includes('toolu_T1')), 'neither the call nor its result is left');
  check(/verify\s+OK/.test(r.out), 'and verify passes', (r.out.match(/verify.*$/m) || [''])[0].trim());
}

step('an empty message already in a session is repaired');
{
  const broken = base.map((x) => (x.uuid === 'u2' ? { ...x, message: { role: 'user', content: '' } } : x));
  const v = ctx(['verify', '--file', writeSession('broken', broken)]);
  check(v.code !== 0 && /empty content/.test(v.out), 'verify refuses the broken session as it is', (v.out.match(/x L.*$/m) || [''])[0].trim());
  const r = build('repair', () => {}, broken);
  check(r.code === 0 && /blank repaired\s+1 message/.test(r.out), 'build removes it and says so', (r.out.match(/blank repaired.*$/m) || [''])[0].trim());
  check(!chainOf(r.file).chain.some(blankMsg), 'no empty message is left');
}

step('edits that are fine are left alone');
{
  const r = build('edit', (bs) => { bs.find((b) => b.line === 4).text = 'This session is being continued. FACT-NEW'; });
  const { chain } = chainOf(r.file);
  check(r.code === 0 && /emptied\s+0/.test(r.out) && /paired drops\s+0/.test(r.out), 'nothing is dropped for a normal edit');
  check(JSON.stringify(chain).includes('FACT-NEW') && !JSON.stringify(chain).includes('FACT-SUM'), 'the edit is what claude will be sent');
}

step('an edit that only ADDS text leaves no residue');
{
  // Claude Code keeps a copy of the last prompt in a `last-prompt` record: a
  // mirror. Appending to the prompt (what the main context does) leaves the old
  // text inside the new one -- that is no residue, and used to count as one.
  const withMirror = [...base, { type: 'last-prompt', sessionId: SID, lastPrompt: 'final prompt' }];
  const r = build('append', (bs) => { const b = bs.find((x) => x.line === 12); b.text = `${b.text}\n\nADDED-LATER`; }, withMirror);
  check(r.code === 0 && /residue\s+0 \(no surviving/.test(r.out), 'build reports no residue for an append (it was 2 before the fix)', (r.out.match(/residue.*$/m) || [''])[0].trim());
  const replace = build('replace', (bs) => { bs.find((x) => x.line === 12).text = 'a different prompt entirely'; }, withMirror);
  check(/residue\s+0/.test(replace.out), 'a replacement is mirrored too, so nothing of it survives either', (replace.out.match(/residue.*$/m) || [''])[0].trim());
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
