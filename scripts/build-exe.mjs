// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// build-exe.mjs — produce dist/brainstorm.exe, a single file with no install.
//
//   node scripts/build-exe.mjs
//
// Node's Single Executable Application support (node:sea):
//
//   1. esbuild bundles bin/app.mjs and everything it imports into ONE CommonJS
//      file. SEA's main script must be a single file, and CommonJS is what this
//      Node release accepts there.
//   2. The UI files are registered as SEA assets, so the exe serves them from
//      inside itself -- there is no ui/ folder next to it.
//   3. `node --experimental-sea-config` writes the blob; postject injects it
//      into a copy of node.exe.
//
// The exe is unsigned. Windows SmartScreen may warn on first run; that is a
// code-signing certificate this repo does not have, not a defect.

import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync, readdirSync, statSync, existsSync, rmSync, renameSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const IS_WIN = process.platform === 'win32';
const EXE = join(DIST, IS_WIN ? 'brainstorm.exe' : 'brainstorm');
const npx = IS_WIN ? 'npx.cmd' : 'npx';

const step = (s) => console.log(`\n== ${s}`);
function run(cmd, args, opts = {}) {
  console.log(`   $ ${cmd} ${args.join(' ')}`);
  // A .cmd shim cannot be spawned directly on Windows. Going through cmd.exe
  // explicitly, rather than `shell: true` with an args array, avoids DEP0190:
  // with shell:true Node concatenates the args unescaped.
  const viaCmd = IS_WIN && cmd.endsWith('.cmd');
  const r = viaCmd
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', cmd, ...args], { cwd: ROOT, stdio: 'inherit', ...opts })
    : spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (r.status !== 0) {
    console.error(`\nbuild failed at: ${cmd} ${args.join(' ')} (exit ${r.status})`);
    process.exit(1);
  }
}

// ⛔ Do not rmSync the whole of dist/. If the app is OPEN, Windows locks the
// running brainstorm.exe against deletion and the build died with EPERM --
// i.e. you could not rebuild while using the app. A running image CAN be
// renamed, though, so it is moved aside (it keeps running from the new name)
// and the new exe is written in its place. Leftover .old files are removed
// on the next build once nothing runs them.
mkdirSync(DIST, { recursive: true });
for (const f of readdirSync(DIST)) {
  const p = join(DIST, f);
  try {
    rmSync(p, { recursive: true, force: true });
  } catch (err) {
    if (f === (IS_WIN ? 'brainstorm.exe' : 'brainstorm') && (err.code === 'EPERM' || err.code === 'EBUSY')) {
      const aside = join(DIST, `brainstorm.old-${Date.now()}.exe`);
      renameSync(p, aside);
      console.log(`   the app is running; moved the running exe aside to ${aside}`);
    } else if (!/\.old-\d+\.exe$/.test(f)) {
      throw err;
    }
  }
}

step('bundle');
run(npx, ['--yes', 'esbuild@0.28.2',
  'bin/app.mjs',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node24',
  `--outfile=${join('dist', 'app.cjs')}`,
  '--log-level=warning',
  // import.meta has no meaning in CommonJS; runtime.mjs and ctx.mjs read it
  // defensively, so this warning is expected and silenced rather than ignored.
  '--log-override:empty-import-meta=silent',
]);

step('assets');
const assets = {};
for (const f of readdirSync(join(ROOT, 'ui'))) {
  const p = join(ROOT, 'ui', f);
  if (statSync(p).isFile()) assets[`ui/${f}`] = relative(ROOT, p).split('\\').join('/');
}
console.log(`   ${Object.keys(assets).length} UI files: ${Object.keys(assets).join(', ')}`);

const seaConfig = {
  main: 'dist/app.cjs',
  output: 'dist/sea-prep.blob',
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
};
writeFileSync(join(DIST, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));

step('blob');
run(process.execPath, ['--experimental-sea-config', join('dist', 'sea-config.json')]);

step('executable');
copyFileSync(process.execPath, EXE);
// The copied node.exe carries Node's signature, which injection invalidates.
// Removing it first keeps postject from producing a file with a broken one.
if (IS_WIN) {
  const st = spawnSync('signtool', ['remove', '/s', EXE], { encoding: 'utf8' });
  if (st.status !== 0) console.log('   (signtool not available; the stale signature is left and simply fails validation)');
}
run(npx, ['--yes', 'postject@1.0.0-alpha.6',
  EXE,
  'NODE_SEA_BLOB',
  join('dist', 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
]);

step('smoke test');
const v = spawnSync(EXE, ['--version'], { encoding: 'utf8' });
console.log(`   ${EXE} --version -> ${(v.stdout || v.stderr || '').trim()} (exit ${v.status})`);
if (v.status !== 0 || !/brainstorm/.test(v.stdout)) {
  console.error('the exe did not start');
  process.exit(1);
}
const e = spawnSync(EXE, ['--engine', '--help'], { encoding: 'utf8' });
console.log(`   --engine --help -> exit ${e.status}: ${(e.stdout || '').split('\n')[0]}`);
if (e.status !== 0) {
  console.error('the bundled engine did not start');
  process.exit(1);
}

const mb = (statSync(EXE).size / 1024 / 1024).toFixed(1);
console.log(`\nbuilt ${EXE}  (${mb} MB)`);
