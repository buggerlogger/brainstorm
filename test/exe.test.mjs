// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// exe.test.mjs — brainstorm.exe does everything the source tree does.
//
//   node test/exe.test.mjs [http://127.0.0.1:7790]
//
// Run against `dist/brainstorm.exe --no-window --port 7790`. The interesting
// path is the engine: opening a session makes the exe re-invoke ITSELF as
// `brainstorm.exe --engine extract ...`, because inside a single executable
// there is no ctx.mjs on disk to hand to node. If that branch were wrong,
// every page would still load and nothing would ever open.

const BASE = process.argv[2] || 'http://127.0.0.1:7790';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);

async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(BASE + path, opt);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 300) }; }
  if (!res.ok || data.error) throw new Error(data.error || `${res.status} ${path}`);
  return data;
}

try {
  step('it is the packaged build');
  const v = await api('/api/version');
  check(v.sea === true, 'running as a single executable', `${v.version}, node ${v.node}`);

  step('the live mod is written out for claude to load');
  // There is no mod folder inside an exe: liveModDir() writes the embedded
  // copy next to the app's data. It must be the repo's mod, byte for byte.
  const { readFileSync: readF, existsSync: exists } = await import('node:fs');
  const { join: pj, dirname: dn } = await import('node:path');
  const { fileURLToPath: f2p } = await import('node:url');
  const repoMod = pj(dn(f2p(import.meta.url)), '..', 'mod', 'brainstorm-live');
  check(!!v.liveMod && exists(pj(v.liveMod, 'hooks', 'register.ts')), 'the mod is on disk', v.liveMod);
  for (const rel of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.ts']) {
    const a = exists(pj(v.liveMod || '', ...rel.split('/'))) ? readF(pj(v.liveMod, ...rel.split('/'))) : null;
    const b = readF(pj(repoMod, ...rel.split('/')));
    check(a && a.equals(b), `${rel} is the repo's`, a ? `${a.length} B` : 'missing');
  }

  step('the start gate can find sessions');
  const all = await api('/api/find-sessions?q=');
  check(all.total > 0, 'lists sessions with an empty query', `${all.total} sessions`);
  const pick = all.results.find((r) => r.bytes > 20000 && r.bytes < 4 * 1024 * 1024 && !r.duplicate);
  check(!!pick, 'found a modest session to open', pick && `${pick.id} ${(pick.bytes / 1024).toFixed(0)} KB`);

  const byPrefix = await api(`/api/find-sessions?q=${pick.id.slice(0, 6)}`);
  check(byPrefix.results[0]?.id.startsWith(pick.id.slice(0, 6)), 'an id prefix ranks that session first', `${byPrefix.results[0]?.why}`);

  step('open it -- this runs the ENGINE inside the exe');
  const st = await api('/api/open', { session: pick.path });
  check(st.open === true, 'the bundled engine extracted the session', `${st.totals.blocks} blocks`);
  check(Array.isArray(st.groups) && st.groups.length > 0, 'blocks arrive in folders', st.groups.map((g) => g.name).join(', '));

  step('build through the exe engine (no install)');
  const b = await api('/api/build', {});
  check(b.ok === true && b.summary?.verified, 'build + verify ran in the exe', b.summary?.newId);

  step('settings round trip');
  const s0 = await api('/api/settings');
  check(Array.isArray(s0.schema) && s0.schema.length > 5, 'settings schema served', `${s0.schema.length} options`);
  const flipped = !s0.settings.wrap;
  const s1 = await api('/api/settings', { wrap: flipped });
  check(s1.settings.wrap === flipped, 'a setting persists');
  await api('/api/settings', { wrap: s0.settings.wrap });

  step('agents');
  const ag = await api('/api/agents');
  check(ag.agents[0]?.id === 'main', 'the main agent is listed first', `${ag.agents.length} agent(s)`);

  step('strings');
  const firstWord = (st.groups[0].blocks[0]?.title || 'the').split(' ').find((w) => w.length > 4) || 'the';
  const sr = await api('/api/strings', { query: firstWord, scope: 'all' });
  check(sr.hits.length > 0, 'search for strings finds a known word', `${JSON.stringify(firstWord)} -> ${sr.hits.length} hit(s)`);

  step('export (zip) from the exe');
  const ex = await api('/api/export', { format: 'zip', reveal: false });
  check(ex.ok && /\.zip$/.test(ex.path), 'exported a zip', `${ex.files} files -> ${ex.path}`);
} catch (err) {
  console.error(`\n  ERROR  ${err.message}`);
  failures++;
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
