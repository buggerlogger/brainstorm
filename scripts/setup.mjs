// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// setup.mjs — everything in one command: the latest code, the live plugin in
// Claude Code, and the app built into a folder on the Desktop.
//
//   npm run setup                                   in a clone
//   npx github:buggerlogger/brainstorm setup        with no clone at all
//
//   --download      take the latest release's exe instead of compiling
//   --no-plugin     leave Claude Code's plugins alone
//   --to <folder>   where the app goes (default: Desktop\brainstorm-app)
//
//   1. code     a clone with no local changes is fast-forwarded; npx has
//               just fetched the code from GitHub itself
//   2. plugin   brainstorm-live installed from this repo's marketplace, then
//               updated: install alone leaves an older copy as it is
//   3. app      scripts/build-exe.mjs, run as its own process so it is the
//               pulled code that builds. Node older than 24 cannot build the
//               exe, so the latest release is downloaded instead and checked
//               against the digest GitHub publishes for it
//   4. folder   brainstorm.exe and version.txt (what it was made from, when)

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'buggerlogger/brainstorm';
const IS_WIN = process.platform === 'win32';
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };

const step = (s) => console.log(`\n== ${s}`);
const fail = (msg) => { console.error(`\nsetup stopped: ${msg}`); process.exit(1); };
function run(cmd, args, { capture = false } = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  return { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}
// claude installed through npm is a .cmd shim, which cannot be spawned
// directly on Windows. cmd.exe is called explicitly, with the bare name so
// cmd finds it on PATH: a full path with a space in it would break /s's
// quote handling, and shell:true would concatenate the args unescaped (DEP0190).
const claude = (args, o) => (IS_WIN ? run('cmd.exe', ['/d', '/s', '/c', 'claude', ...args], o) : run('claude', args, o));

async function sha256(file) {
  const h = createHash('sha256');
  for await (const c of createReadStream(file)) h.update(c);
  return h.digest('hex');
}

// What the code is: a clone's commit, or the commit npx fetched (npm records
// it in the lockfile of the folder it installed into).
function madeFrom() {
  if (existsSync(join(ROOT, '.git'))) {
    const r = run('git', ['log', '-1', '--format=%h %cs'], { capture: true });
    if (r.code === 0 && r.out) { const [hash, day] = r.out.split(' '); return `git ${hash} (${day})`; }
  }
  try {
    const lock = JSON.parse(readFileSync(join(ROOT, '..', '.package-lock.json'), 'utf8'));
    const sha = String(lock.packages?.['node_modules/brainstorm']?.resolved || '').split('#')[1];
    if (sha) return `git ${sha.slice(0, 7)} (fetched by npx)`;
  } catch { /* not installed by npm */ }
  return ROOT;
}

// The Desktop is not always ~/Desktop: OneDrive moves it, and Windows knows where.
function desktop() {
  if (IS_WIN) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8' });
    const p = (r.stdout || '').trim();
    if (r.status === 0 && p && existsSync(p)) return p;
  }
  return join(homedir(), 'Desktop');
}

async function downloadLatest() {
  const headers = { 'user-agent': 'brainstorm-setup' };
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { ...headers, accept: 'application/vnd.github+json' } });
  if (!res.ok) fail(`could not ask GitHub for the latest release (HTTP ${res.status})`);
  const rel = await res.json();
  const asset = (rel.assets || []).find((a) => a.name === 'brainstorm.exe');
  if (!asset) fail(`the latest release (${rel.tag_name}) has no brainstorm.exe`);
  console.log(`   ${rel.tag_name}: ${asset.browser_download_url} (${(asset.size / 1024 / 1024).toFixed(1)} MB)`);
  const to = join(ROOT, 'dist', 'brainstorm.download.exe');
  mkdirSync(dirname(to), { recursive: true });
  const got = await fetch(asset.browser_download_url, { headers });
  if (!got.ok) fail(`the download failed (HTTP ${got.status})`);
  await pipeline(Readable.fromWeb(got.body), createWriteStream(to));
  const digest = `sha256:${await sha256(to)}`;
  if (asset.digest && asset.digest !== digest) {
    rmSync(to, { force: true });
    fail(`the download does not match the digest GitHub published for it (${asset.digest}, got ${digest})`);
  }
  console.log(`   ${asset.digest ? 'matches the digest GitHub published' : 'GitHub published no digest to check it against'}`);
  return { exe: to, from: `release ${rel.tag_name}`, staged: true };
}

console.log(`brainstorm ${VERSION} setup  (${ROOT})`);

step('code');
const changed = existsSync(join(ROOT, '.git')) && !!run('git', ['status', '--porcelain', '--untracked-files=no'], { capture: true }).out;
if (!existsSync(join(ROOT, '.git'))) {
  console.log('   not a clone: the code npm installed (npx github:... fetches the latest commit)');
} else if (changed) {
  // ⛔ Never pull over work in progress: a clone being worked in often holds
  // edits nobody has committed yet.
  console.log('   this clone has local changes: not pulling, building it as it is');
} else if (run('git', ['pull', '--ff-only']).code !== 0) {
  console.log('   could not fast-forward (offline, no upstream, or commits of its own): building it as it is');
}

step('plugin');
if (has('no-plugin')) {
  console.log('   left alone (--no-plugin)');
} else if (claude(['--version'], { capture: true }).code !== 0) {
  console.log('   Claude Code was not found. Install it, then run setup again, or in claude:');
  console.log(`   /plugin install brainstorm-live --marketplace ${REPO}`);
} else {
  for (const args of [
    ['plugin', 'install', 'brainstorm-live', '--marketplace', REPO],
    ['plugin', 'marketplace', 'update', 'brainstorm'],
    ['plugin', 'update', 'brainstorm-live@brainstorm'],
  ]) {
    if (claude(args).code !== 0) { console.log(`   claude ${args.join(' ')} failed (above); the app works without it`); break; }
  }
  console.log('   claude sessions already open load it after /reload-plugins');
}

if (!IS_WIN) {
  console.log('\nbrainstorm.exe is Windows only for now. From this folder: node bin/app.mjs');
  process.exit(0);
}

step('app');
const major = Number(process.versions.node.split('.')[0]);
let made;
if (has('download')) {
  made = await downloadLatest();
} else if (major < 24) {
  console.log(`   Node ${process.versions.node} cannot build the exe (it needs 24 or newer): taking the latest release instead`);
  made = await downloadLatest();
} else {
  if (run(process.execPath, [join(ROOT, 'scripts', 'build-exe.mjs')]).code !== 0) fail('the build failed (above). `--download` takes the latest release instead');
  made = { exe: join(ROOT, 'dist', 'brainstorm.exe'), from: `built from ${madeFrom()}${changed ? ' + local changes' : ''}` };
}

step('folder');
const dest = resolve(opt('to') || join(desktop(), 'brainstorm-app'));
const target = join(dest, 'brainstorm.exe');
mkdirSync(dest, { recursive: true });
for (const f of readdirSync(dest)) {
  if (/^brainstorm\.old-\d+\.exe$/.test(f)) { try { rmSync(join(dest, f)); } catch { /* still running */ } }
}
try {
  copyFileSync(made.exe, target);
} catch (err) {
  if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
  // ⛔ Windows refuses to overwrite an exe that is running, but lets it be
  // renamed: the open app keeps running from the new name, and the next start
  // is the new one. The leftover goes on the next setup.
  renameSync(target, join(dest, `brainstorm.old-${Date.now()}.exe`));
  copyFileSync(made.exe, target);
  console.log('   brainstorm is running from here: that copy was moved aside, the new one starts next time');
}
if (made.staged) rmSync(made.exe, { force: true });
const v = spawnSync(target, ['--version'], { encoding: 'utf8' });
if (v.status !== 0 || !/brainstorm/.test(v.stdout)) fail(`${target} did not start`);
const digest = await sha256(target);
writeFileSync(join(dest, 'version.txt'), [
  v.stdout.trim(),
  made.from,
  `sha256 ${digest}`,
  `put here ${new Date().toISOString()}`,
  '',
].join('\r\n'));
console.log(`   ${target}\n   ${v.stdout.trim()} · ${made.from}`);
console.log(`\ndone. Start it: ${target}`);
