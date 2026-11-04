// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// runtime.mjs — the one place that knows whether this is running from source
// or from inside brainstorm.exe.
//
// From source, the UI is files under ui/ and the engine is src/ctx.mjs, run as
// `node src/ctx.mjs <verb>`. Inside the exe there are no files: the UI is
// embedded as SEA assets and the engine is the exe itself, re-invoked as
// `brainstorm.exe --engine <verb>`. Every caller that used to compute a path
// from import.meta.url now asks this module instead, so there is exactly one
// branch on "am I packaged?" rather than four that could disagree.
//
// import.meta.url does not survive bundling to CommonJS (esbuild leaves an
// empty object), which is why it is read defensively and never at the top
// level of any other module.

import * as seaModule from 'node:sea';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, normalize, sep } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';

export const IS_SEA = (() => {
  try { return !!seaModule.isSea?.(); } catch { return false; }
})();

const META_URL = (() => {
  try { return import.meta && import.meta.url ? import.meta.url : null; } catch { return null; }
})();

// src/runtime.mjs -> the repo root is one level up.
export const ROOT = IS_SEA
  ? dirname(process.execPath)
  : resolve(dirname(fileURLToPath(META_URL)), '..');

export const ENGINE_FILE = join(ROOT, 'src', 'ctx.mjs');

// [executable, args] for running an engine verb in a child process.
export function engineCommand(args) {
  if (IS_SEA) return [process.execPath, ['--engine', ...args]];
  return [process.execPath, [ENGINE_FILE, ...args]];
}

// The UI, as bytes. Returns null for anything that is not a UI file, which is
// also how path traversal is refused: the key has to normalise to something
// under ui/, and inside the exe it has to be a registered asset.
export function readUi(rel) {
  const clean = normalize(String(rel || 'index.html').replace(/^[/\\]+/, '')).split(sep).join('/');
  if (!clean || clean.startsWith('..') || clean.includes('/../')) return null;
  if (IS_SEA) {
    try {
      return Buffer.from(seaModule.getAsset(`ui/${clean}`));
    } catch {
      return null;
    }
  }
  const uiDir = join(ROOT, 'ui');
  const file = resolve(uiDir, clean);
  if (!file.startsWith(uiDir) || !existsSync(file) || !statSync(file).isFile()) return null;
  return readFileSync(file);
}

// Where per-user state lives. Not next to the exe: Program Files is not
// writable, and a portable exe on a USB stick should not scatter files there.
export function appDataDir() {
  // BRAINSTORM_HOME isolates an instance completely -- its own lock file,
  // settings, window profile and logs. Tests use it so they never attach to
  // the copy a person has open; it also makes a portable copy possible.
  if (process.env.BRAINSTORM_HOME) return process.env.BRAINSTORM_HOME;
  if (platform() === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'brainstorm');
  }
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', 'brainstorm');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'brainstorm');
}

export const VERSION = '0.2.0';

// The brainstorm-live mod (mod/brainstorm-live): the folder claude is given
// with --plugin-dir, so its hooks report the engine's events from inside.
// From source it is the repo's own folder. Inside the exe there is no folder,
// and claude needs real files to load, so the embedded copy is written out to
// the app data folder -- again whenever this build's copy differs, so an
// updated exe never runs an old mod.
export const LIVE_MOD_FILES = ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.ts'];

export function liveModDir() {
  if (!IS_SEA) return join(ROOT, 'mod', 'brainstorm-live');
  const dir = join(appDataDir(), 'mod', 'brainstorm-live');
  for (const rel of LIVE_MOD_FILES) {
    const want = Buffer.from(seaModule.getAsset(`mod/brainstorm-live/${rel}`));
    const file = join(dir, ...rel.split('/'));
    let have = null;
    try { have = readFileSync(file); } catch { /* not written yet */ }
    if (!have || !have.equals(want)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, want);
    }
  }
  return dir;
}

// Where the server says which port it is on, for the mod: { port, pid }.
// A claude started by one run of brainstorm keeps running after brainstorm
// closes; the mod reads this again when a post fails, and finds the next run.
export function liveFile() {
  return join(appDataDir(), 'live.json');
}
