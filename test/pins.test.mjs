// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// pins.test.mjs — the main context: survives a rewind, paused by a compaction.
//
//   node test/pins.test.mjs
//
// No server, no claude. The pin store is a temp BRAINSTORM_HOME, so nothing
// is written into the pins of a real project.

import { mkdtempSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.BRAINSTORM_HOME = mkdtempSync(join(tmpdir(), 'bs-pins-home-'));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = await import(pathToFileURL(join(ROOT, 'src', 'core', 'pins.mjs')).href);

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);

const blocks = () => [
  { id: 1, role: 'user', kind: 'text', text: 'first prompt', keep: true },
  { id: 2, role: 'assistant', kind: 'text', text: 'first answer', keep: true },
  { id: 3, role: 'user', kind: 'text', text: 'second prompt', keep: true },
  { id: 4, role: 'assistant', kind: 'text', text: 'second answer', keep: true },
];

step('the main context lives in the first user message');
{
  const main = P.newPin({ text: 'ALWAYS USE THE STAGING DB', main: true, compactions: 1 });
  check(main.main === true && main.anchor === 'first-user' && main.label === 'main context', 'a main pin is anchored to the first user message', `${main.anchor}, "${main.label}"`);
  const bs = blocks();
  const r = P.applyPins(bs, [main], { compactions: 1 });
  check(r[0].applied && r[0].blockId === 1 && bs[0].text.includes('ALWAYS USE THE STAGING DB'), 'it is applied into block #1', JSON.stringify(r[0]));
  check(P.mainPinOf([P.newPin({ text: 'x' }), main]) === main, 'mainPinOf finds it among other pins');
}

step('a rewind cannot delete it');
{
  const main = P.newPin({ text: 'KEEP ME', main: true, compactions: 0 });
  const bs = blocks();
  P.applyPins(bs, [main], { compactions: 0 });
  // rewound to the very first block: everything after it is dropped
  const res = P.rewindTo(bs, 1);
  check(res.dropped.join(',') === '2,3,4', 'the rewind dropped every block after #1', res.dropped.join(','));
  const r = P.applyPins(bs, [main], { compactions: 0 });
  check(r[0].applied && bs[0].text.includes('KEEP ME'), 'after the rewind the main context is still there', bs[0].text.replace(/\n/g, ' | '));
  check((bs[0].text.match(/KEEP ME/g) || []).length === 1, 'and only once: re-applying never duplicates it');
}

step('a compaction pauses it; saving it again pins it again');
{
  const main = P.newPin({ text: 'PAUSE ME', main: true, compactions: 1 });
  const bs = blocks();
  P.applyPins(bs, [main], { compactions: 1 });
  check(bs[0].text.includes('PAUSE ME'), 'before: applied');
  // Claude compacted: the session now has 2 boundaries
  const r = P.applyPins(bs, [main], { compactions: 2 });
  check(!r[0].applied && r[0].paused && r[0].reason === 'compacted' && r[0].compactionsSince === 1, 'after a compaction it is paused, not re-inserted', JSON.stringify(r[0]));
  check(!bs[0].text.includes('PAUSE ME'), 'and its old copy is taken out of the block (the summary carries it now)');
  // the person saves it again: its count moves to the current one
  main.compactions = 2;
  const r2 = P.applyPins(bs, [main], { compactions: 2 });
  check(r2[0].applied && bs[0].text.includes('PAUSE ME'), 'saved again, it is pinned again');
}

step('ordinary pins do not care about compactions');
{
  const pin = P.newPin({ text: 'ordinary', anchor: 'last-user' });
  const bs = blocks();
  const r = P.applyPins(bs, [pin], { compactions: 9 });
  check(r[0].applied && r[0].blockId === 3, 'an ordinary pin is applied whatever the compaction count', `#${r[0].blockId}`);
}

step('stripAllPins: an edit can be told apart from applied pins');
{
  const a = P.newPin({ text: 'AAA', main: true, compactions: 0 });
  const b = P.newPin({ text: 'BBB', anchor: 'first-user' });
  const bs = blocks();
  P.applyPins(bs, [a, b], { compactions: 0 });
  check(bs[0].text.includes('AAA') && bs[0].text.includes('BBB'), 'two pins applied into one block');
  check(P.stripAllPins(bs[0].text) === 'first prompt', 'stripped of every pin, the block is its own text again', JSON.stringify(P.stripAllPins(bs[0].text)));
  check(P.stripAllPins('half <!-- pin:abcd1234 -->\nlost its closing marker') === 'half', 'a region whose closing marker was lost is stripped to the end');
}

step('the store follows BRAINSTORM_HOME');
{
  P.savePins('C:\\some\\project', [P.newPin({ text: 'x', main: true, compactions: 0 })]);
  check(existsSync(join(process.env.BRAINSTORM_HOME, 'pins.json')), 'pins.json is written in BRAINSTORM_HOME, not in ~/.brainstorm');
  check(P.loadPins('c:\\SOME\\project')[0]?.main === true, 'and read back by project folder');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
