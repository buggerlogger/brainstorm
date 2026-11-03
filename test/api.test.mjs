// api.test.mjs — exercise the IDE's HTTP API the way the UI does.
//
//   node test/api.test.mjs [http://127.0.0.1:7788]
//
// The server must already be running with a session open. This drives the real
// write path: edit a block, save, build, install, then confirm the installed
// transcript and the traced flow both reflect the edit. Nothing here is mocked,
// because every bug worth catching lived in the seam between the two.

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
  const { readFileSync } = await import('node:fs');
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

  step('the terminal must refuse anything that is not an engine verb');
  const bad = await api('/api/terminal', { cmd: 'rm -rf /' });
  check(bad.code === 2 && /not an engine verb/.test(bad.out), 'arbitrary commands are refused', bad.out.split('\n')[0]);
  const good = await api('/api/terminal', { cmd: 'status' });
  check(good.code === 0, 'engine verbs run', good.out.split('\n').find((l) => l.trim()) || '');

  step('restore the block so the workspace is left as found');
  await api('/api/block', { id: target.id, text: before.text });
  await api('/api/save', {});
  const st4 = await api('/api/state');
  check(st4.totals.chars === st0.totals.chars, 'workspace restored', `${st4.totals.chars} ch`);
} catch (err) {
  console.error(`\n  ERROR  ${err.message}`);
  failures++;
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
