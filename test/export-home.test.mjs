// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// export-home.test.mjs — the exportDir default follows BRAINSTORM_HOME.
//
//   node test/export-home.test.mjs
//
// Every case runs settings.mjs in a fresh child process, because the schema
// default is read once at import time and loadSettings() caches its result.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};

const HERE = dirname(fileURLToPath(import.meta.url));
const SETTINGS = join(HERE, '..', 'src', 'core', 'settings.mjs');

// Prints loadSettings().exportDir from a child that imports settings.mjs for
// the first time under the env we hand it. `setup` runs before the import.
function exportDirWith(env, setup = '') {
  const script = `${setup}; import(${JSON.stringify(new URL('file:///' + SETTINGS.replace(/\\/g, '/')).href)})
    .then((m) => console.log(m.loadSettings().exportDir))`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env });
  if (r.status !== 0) return { err: (r.stderr || '').trim() };
  return { dir: r.stdout.trim() };
}

const noHome = { ...process.env };
delete noHome.BRAINSTORM_HOME;

// 1. With BRAINSTORM_HOME, the default lives inside it.
{
  const home = mkdtempSync(join(tmpdir(), 'bs-export-home-'));
  const { dir, err } = exportDirWith({ ...noHome, BRAINSTORM_HOME: home });
  check(dir === join(home, 'exports'), 'with BRAINSTORM_HOME the export dir defaults into it',
    err || dir);
}

// 2. Without it, nothing changes: still the Desktop folder.
{
  // A temp APPDATA keeps the person's real settings.json out of the way.
  const detachedAppData = mkdtempSync(join(tmpdir(), 'bs-export-appdata-'));
  const { dir, err } = exportDirWith({ ...noHome, APPDATA: detachedAppData });
  const expected = join(noHome.USERPROFILE || noHome.HOME || '', 'Desktop', 'brainstorm-exports');
  check(dir === expected, 'without BRAINSTORM_HOME the default stays on the Desktop', err || dir);
}

// 3. A setting someone chose by hand always wins.
{
  const home = mkdtempSync(join(tmpdir(), 'bs-export-home-'));
  const chosen = join(home, 'my-exports');
  const setup = `
    require('node:fs').writeFileSync(
      require('node:path').join(process.env.BRAINSTORM_HOME, 'settings.json'),
      JSON.stringify({ exportDir: process.env.BS_CHOSEN }));`;
  const { dir, err } = exportDirWith({ ...noHome, BRAINSTORM_HOME: home, BS_CHOSEN: chosen }, setup);
  check(dir === chosen, 'an explicit exportDir in settings.json wins', err || dir);
}

process.exit(failures === 0 ? 0 : 1);
