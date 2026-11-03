// api.test.mjs — exercise the IDE's HTTP API the way the UI does.
//
//   node test/api.test.mjs [http://127.0.0.1:7788]
//
// The server must already be running with a session open. This drives the real
// write path: edit a block, save, build, install, then confirm the installed
// transcript and the traced flow both reflect the edit. Nothing here is mocked,
// because every bug worth catching lived in the seam between the two.

import { readFileSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:7788';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);

async function api(path, body) {
  const opt = body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(BASE + path, opt);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 400) }; }
  if (!res.ok || data.error) throw new Error(data.error || `${res.status} ${path}`);
  return data;
}

try {
  step('open a session BY FULL PATH (what the UI sends)');
  // Regression: /api/open passed its own argument to workDirFor, so a path
  // argument produced   <temp>\brainstorm-ide\C:\Users\...\<id>.jsonl
  // and every extract died with ENOENT on mkdir. The work dir must come from
  // the session id, never from whatever the caller happened to pass.
  // ⛔ Pick deterministically, and verify the pick. "the first session" chose a
  // ONE-BLOCK transcript that an earlier run of this very test had built, and
  // the run then died on `victim` being undefined. A test that depends on
  // whatever is lying around is a test that fails for reasons unrelated to the
  // code. Needs >= 4 blocks so there is something to drop, edit and rewind.
  const { projects } = await api('/api/projects');
  const pool = projects
    .flatMap((p) => p.sessions)
    .filter((s) => s.bytes > 20000 && s.bytes < 8 * 1024 * 1024)
    .sort((a, b) => b.bytes - a.bytes);
  check(pool.length > 0, 'there are sessions to choose from', `${pool.length}`);

  let opened = null;
  let candidate = null;
  for (const s of pool.slice(0, 12)) {
    const st = await api('/api/open', { session: s.path });
    if (st.totals.blocks >= 4) { opened = st; candidate = s; break; }
  }
  check(!!opened, 'found a session with at least 4 blocks', candidate && `${candidate.id} (${opened?.totals.blocks} blocks)`);
  if (!opened) throw new Error('no suitable session on this machine');
  check(opened.open === true, 'opening by full path works', opened.config?.sessionId);
  check(
    !/brainstorm-ide[\\/].*[a-zA-Z]:[\\/]/.test(opened.dir) && opened.dir.includes('brainstorm-ide'),
    'the work dir is a flat folder under temp, not a nested path',
    opened.dir,
  );

  step('state');
  const st0 = await api('/api/state');
  check(st0.open === true, 'a session is open', st0.config?.sessionId);
  check(st0.groups.length > 0, 'blocks are grouped into folders', st0.groups.map((g) => `${g.name}(${g.blocks.length})`).join(' '));

  step('find the largest text block and edit it');
  const all = st0.groups.flatMap((g) => g.blocks);
  const target = all.filter((b) => b.kind === 'text').sort((a, b) => b.chars - a.chars)[0];
  check(!!target, 'found a text block to edit', target && `#${target.id} ${target.chars} ch`);

  const before = await api(`/api/block?id=${target.id}`);
  const MARK = `BRAINSTORM-IDE-MARK-${Date.now()}`;
  const edited = `${before.text}\n\n${MARK}\n`;
  const put = await api('/api/block', { id: target.id, text: edited });
  check(put.changed === true, 'POST /api/block reports the change', `${before.text.length} -> ${put.block.chars} ch`);

  const st1 = await api('/api/state');
  check(st1.totals.dirty.includes(target.id), 'the block shows as dirty before saving', JSON.stringify(st1.totals.dirty));

  step('save');
  const saved = await api('/api/save', {});
  check(saved.ok === true, 'POST /api/save wrote BLOCKS.md', `${saved.written} blocks`);

  step('keep toggle (drop a block, then restore it)');
  const victim = all.find((b) => b.id !== target.id);
  check(!!victim, 'there is a second block to drop', victim && `#${victim.id}`);
  if (!victim) throw new Error('need at least two blocks');
  await api('/api/block', { id: victim.id, keep: false });
  const st2 = await api('/api/state');
  check(st2.totals.dropped === 1, 'dropping a block is reflected in the totals', `dropped ${st2.totals.dropped}`);
  check(st2.totals.chars < st1.totals.chars, 'dropping reduces the counted chars', `${st1.totals.chars} -> ${st2.totals.chars}`);
  await api('/api/block', { id: victim.id, keep: true });
  const st3 = await api('/api/state');
  check(st3.totals.dropped === 0, 'restoring a block is reflected too');

  step('build + install');
  const built = await api('/api/build', { install: true });
  check(built.ok === true, 'build succeeded', built.summary?.newId);
  check(built.summary?.verified === true, 'the engine verified the artefact');
  check(built.summary?.edited >= 1, 'the engine applied the edit', `blocks edited ${built.summary?.edited}`);
  check(!!built.summary?.installed, 'installed', built.summary?.installed);

  step('the installed transcript must contain the edit');
  const raw = readFileSync(built.summary.installed, 'utf8');
  check(raw.includes(MARK), 'the mark reached the installed .jsonl');

  step('the traced flow of the built file must contain the edit');
  const flow = await api('/api/flow?of=built');
  check(flow.calls.length > 0, 'built file traces', `mode ${flow.mode}, ${flow.calls.length} call(s)`);
  const probed = await api('/api/probe', { needle: MARK, of: 'built' });
  check(probed.hits.length > 0, 'probe finds the edit in the context flow', `${probed.hits.length} frame(s): ${probed.hits.map((h) => h.path).join(', ')}`);

  step('diff: the build reports what the edit did to the context');
  check(Array.isArray(built.diff), 'build returned a flow diff', `${built.diff.length} changed call(s)`);
  for (const d of built.diff) console.log(`    call ${d.call}: ${d.charsBefore} -> ${d.charsAfter} ch, ${d.frames.length} frame(s) changed`);

  step('frame fetch (what the debugger does on every step)');
  const f0 = await api('/api/frame?of=source&call=0&frame=0');
  check(!!f0.kind, 'GET /api/frame returns a frame', `${f0.kind} ${f0.chars} ch`);

  step('PINNED CONTEXT: added by me, must survive a rewind');
  // The point of a pin: text you add stays in context even when the turn it
  // was attached to is rewound away. Stored by cwd, re-applied on every build.
  const PIN = `PINNED-FACT-${Date.now()}: the deploy key rotates on Tuesdays.`;
  const added = await api('/api/pin', { action: 'add', text: PIN, anchor: 'last-user' });
  check(added.ok === true, 'pin added', `${added.pins.length} pin(s)`);
  const pinId = added.pins[added.pins.length - 1].id;
  const landed = added.report.find((r) => r.id === pinId);
  check(!!landed?.applied, 'pin landed on a block', `block #${landed?.blockId}`);

  const stPin = await api('/api/state');
  const pinnedBlockId = landed.blockId;
  const pinnedBlock = await api(`/api/block?id=${pinnedBlockId}`);
  check(pinnedBlock.text.includes(PIN), 'the pin text is in the block');
  check(stPin.pins.some((p) => p.id === pinId && p.applied), 'state reports the pin as applied');

  step('rewind past the block the pin was sitting on');
  const allBlocks = stPin.groups.flatMap((g) => g.blocks).sort((a, b) => a.id - b.id);
  const earliest = allBlocks[0];
  check(pinnedBlockId !== earliest.id, 'the pin is NOT on the block we rewind to', `pin on #${pinnedBlockId}, rewinding to #${earliest.id}`);
  const rw = await api('/api/rewind', { blockId: earliest.id });
  check(rw.ok === true, 'rewind ran', `dropped ${rw.dropped.length} block(s): ${rw.dropped.join(',')}`);
  check(rw.dropped.includes(pinnedBlockId), 'the block the pin was on WAS dropped', `#${pinnedBlockId}`);

  const after = rw.pins.find((r) => r.id === pinId);
  check(!!after?.applied, 'the pin is STILL applied after the rewind', after?.applied ? `re-homed onto block #${after.blockId}` : after?.reason);
  check(after?.blockId !== pinnedBlockId, 'it re-homed onto a block that survived', `#${pinnedBlockId} -> #${after?.blockId}`);
  const survivor = await api(`/api/block?id=${after.blockId}`);
  check(survivor.text.includes(PIN), 'the pin text is present in the surviving block');

  step('build after the rewind: the pin must reach the transcript');
  const builtPinned = await api('/api/build', { install: true });
  check(builtPinned.ok === true, 'build after rewind succeeded', builtPinned.summary?.newId);
  const rawPinned = readFileSync(builtPinned.summary.installed, 'utf8');
  check(rawPinned.includes(PIN), 'the pinned fact is in the rebuilt transcript');
  check(builtPinned.summary.recordsDropped > 0 || rw.dropped.length > 0, 'the rewind actually removed turns', `records dropped ${builtPinned.summary?.recordsDropped}`);

  step('remove the pin: it must leave no trace');
  const removed = await api('/api/pin', { action: 'remove', id: pinId });
  check(removed.ok === true, 'pin removed', `${removed.pins.length} left`);
  const afterRemove = await api('/api/state');
  // ⛔ Sequentially, not Promise.all. Firing ~500 concurrent fetches at the
  // loopback server exhausted the client's sockets and the run died with a
  // bare "fetch failed" while the server itself stayed up and healthy. The UI
  // never does this (it fetches one block per click), so the fix belongs here.
  const ids = afterRemove.groups.flatMap((g) => g.blocks).map((b) => b.id);
  let withText = 0;
  let withMarkers = 0;
  for (const id of ids) {
    const t = await api(`/api/block?id=${id}`);
    if (t.text.includes(PIN)) withText++;
    if (t.text.includes(`pin:${pinId}`)) withMarkers++;
  }
  check(withText === 0, 'no block still contains the pin text', `${withText} of ${ids.length}`);
  check(withMarkers === 0, 'no block still contains the pin markers', `${withMarkers} of ${ids.length}`);

  step('the terminal must refuse anything that is not an engine verb');
  const bad = await api('/api/terminal', { cmd: 'rm -rf /' });
  check(bad.code === 2 && /not an engine verb/.test(bad.out), 'arbitrary commands are refused', bad.out.split('\n')[0]);
  const good = await api('/api/terminal', { cmd: 'status' });
  check(good.code === 0, 'engine verbs run', good.out.split('\n').find((l) => l.trim()) || '');

  step('re-open the session: a fresh extract must discard every edit above');
  // Not a tidy-up -- a check. The workspace is a working copy; re-extracting
  // has to return the ORIGINAL transcript, or an edit has leaked into the
  // source file, which is the one thing this tool must never do.
  const reopened2 = await api('/api/open', { session: candidate.path });
  check(reopened2.totals.blocks === st0.totals.blocks, 'block count matches the original extract', `${reopened2.totals.blocks} vs ${st0.totals.blocks}`);
  check(reopened2.totals.dropped === 0, 'no block is still dropped after re-extract', `${reopened2.totals.dropped}`);
  const fresh = await api(`/api/block?id=${target.id}`);
  check(fresh.text === before.text, 'the edited block is back to its original text', `${fresh.text.length} vs ${before.text.length} ch`);
  check(!fresh.text.includes(MARK), 'the test mark is gone from the source');
} catch (err) {
  console.error(`\n  ERROR  ${err.message}`);
  failures++;
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
