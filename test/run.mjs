// run.mjs — the test runner.
//
//   node test/run.mjs            unit + flow tests (fast, no network)
//   node test/run.mjs --all      also the end-to-end tests that spawn Claude
//
// The end-to-end tests are opt-in because each one starts real `claude -p`
// sessions and takes minutes. They are the only tests that prove the thing
// actually works, so they are not optional before a release -- only before a
// quick edit.

import { spawnSync, spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ALL = process.argv.includes('--all');

let failed = 0;
const results = [];

function run(label, args, { optional = false } = {}) {
  process.stdout.write(`\n──── ${label}\n`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT });
  const ok = r.status === 0;
  results.push({ label, ok, optional });
  if (!ok && !optional) failed++;
  return ok;
}

// A transcript that actually records api-request data, for the flow test.
// Only 39 of 189 sessions on this machine had it, so one is SEARCHED for
// rather than hardcoded -- a hardcoded path is how the old tool ended up
// reporting line numbers from a session that had nothing to do with the input.
function findRecordedTranscript() {
  const P = join(homedir(), '.claude', 'projects');
  if (!existsSync(P)) return null;
  const { openSync, readSync, closeSync } = require('node:fs');
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
        if (fd !== undefined) try { closeSync(fd); } catch {}
      }
    }
  }
  return null;
}

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

console.log(`brainstorm tests  ${ALL ? '(including end-to-end)' : '(fast; pass --all for end-to-end)'}`);

// 1. syntax of every source file
{
  process.stdout.write('\n──── syntax\n');
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) { if (!['node_modules', '.git'].includes(f)) walk(p); }
      else if (f.endsWith('.mjs') || (f.endsWith('.js') && p.includes('ui'))) files.push(p);
    }
  };
  walk(ROOT);
  let bad = 0;
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) { bad++; console.log(`  FAIL  ${f.replace(ROOT, '.')}\n${r.stderr}`); }
    else console.log(`  ok    ${f.replace(ROOT, '.')}`);
  }
  results.push({ label: 'syntax', ok: bad === 0, optional: false });
  if (bad) failed++;
}

// 2. front-end wiring (no browser)
run('ui wiring', [join(HERE, 'ui.test.mjs')]);

// 3. flow reconstruction against a real transcript
{
  const t = findRecordedTranscript();
  if (t) run('flow (recorded mode)', [join(HERE, 'flow.test.mjs'), t]);
  else {
    console.log('\n──── flow\n  SKIP  no transcript with api-request records found on this machine');
    results.push({ label: 'flow', ok: true, optional: true });
  }
}

// 4. the HTTP API, against a server this runner starts and stops
if (ALL) {
  process.stdout.write('\n──── api (starts an IDE server)\n');
  const t = findRecordedTranscript();
  if (!t) {
    console.log('  SKIP  needs a session to open');
    results.push({ label: 'api', ok: true, optional: true });
  } else {
    const port = 7799;
    const srv = spawn(process.execPath, [join(ROOT, 'bin', 'brainstorm.mjs'), 'ide', '--port', String(port), '--session', t], {
      cwd: ROOT, stdio: 'ignore', detached: false,
    });
    await new Promise((r) => setTimeout(r, 2500));
    const ok = run('api', [join(HERE, 'api.test.mjs'), `http://127.0.0.1:${port}`]);
    srv.kill();
    if (!ok) failed++;
  }
}

// 5. the end-to-end skill swap: two real Claude sessions
if (ALL) run('skill swap (end to end)', [join(HERE, 'skillswap.test.mjs')]);

console.log('\n════ summary');
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.optional && r.ok ? '' : ''}`);
console.log(`\n${failed === 0 ? 'ALL SUITES PASSED' : `${failed} SUITE(S) FAILED`}\n`);
process.exit(failed ? 1 : 0);
