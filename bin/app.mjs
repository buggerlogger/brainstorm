// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// app.mjs — the entry point of brainstorm.exe.
//
//   brainstorm.exe                 open the app window
//   brainstorm.exe --engine <verb> run the bundled engine (the server calls this)
//   brainstorm.exe --port 7788     fixed port instead of a free one
//   brainstorm.exe --no-window     server only, for debugging
//
// WHY AN EDGE APP WINDOW, NOT ELECTRON. Every Windows 11 machine has Edge and
// the WebView2 runtime. `msedge --app=<url>` opens a chromeless window with its
// own taskbar entry that is, to the person using it, an application. Electron
// would add ~150 MB and a second browser engine to keep patched, for a window
// that looks the same.
//
// The window gets its OWN profile directory under %APPDATA%\brainstorm. It
// never touches the person's browser profile: no cookies, history, extensions
// or fingerprint of theirs are read or used.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { createHash } from 'node:crypto';
import { appDataDir, IS_SEA, VERSION } from '../src/runtime.mjs';

// From source argv is [node, app.mjs, ...]. Inside the exe it is [exe, ...]
// or [exe, exe, ...] depending on the Node release, so a leading copy of the
// exe's own path is dropped by comparing PATHS, not strings -- case and
// slashes differ on Windows. The engine branch finds --engine by index, so it
// is immune to either shape.
const samePath = (a, b) => {
  const n = (x) => String(x || '').replace(/\//g, '\\').toLowerCase();
  return platform() === 'win32' ? n(a) === n(b) : a === b;
};
const argv = IS_SEA
  ? process.argv.slice(1).filter((a, i) => !(i === 0 && samePath(a, process.execPath)))
  : process.argv.slice(2);

async function runEngine(rest) {
  // The engine reads process.argv at module load, so present it exactly the
  // argv it would have had as `node ctx.mjs <verb> ...`.
  process.argv = [process.argv[0], 'ctx', ...rest];
  await import('../src/ctx.mjs');
}

function opt(name, dflt = null) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function findEdge() {
  if (platform() !== 'win32') return null;
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  for (const r of roots) {
    const p = join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    if (existsSync(p)) return p;
  }
  const w = spawnSync('where', ['msedge.exe'], { encoding: 'utf8' });
  return w.status === 0 ? w.stdout.split(/\r?\n/)[0].trim() || null : null;
}

const WINDOW_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,msEdgeSidebarV2,msHubApps',
  // A debugger has to keep working while you are in another window -- that is
  // the whole point of following a live session from the terminal. Without
  // these, Edge throttles a background window's timers to about one wake-up a
  // MINUTE after five minutes, and live polling stalled with it.
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
];

// ⛔ The profile folder is named after the flags. Edge runs ONE browser process
// per profile, and a second launch hands its URL to that process and exits --
// so the new window gets the OLD process's flags. MEASURED: a window from the
// previous build was still open, and the fixed build's window opened inside
// it, without the anti-throttling switches. A flag change now means a new
// profile, which means a fresh browser process that actually has the flags.
function profileDir() {
  const tag = createHash('sha256').update(WINDOW_FLAGS.join('\n')).digest('hex').slice(0, 8);
  return join(appDataDir(), `window-profile-${tag}`);
}

function openWindow(url) {
  const edge = findEdge();
  const profile = profileDir();
  mkdirSync(profile, { recursive: true });
  if (edge) {
    const child = spawn(edge, [
      `--app=${url}`,
      `--user-data-dir=${profile}`,
      ...WINDOW_FLAGS,
      '--window-size=1560,980',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    return 'edge-app';
  }
  // No Edge: the default browser. Still works; it just looks like a tab.
  const opener = platform() === 'win32' ? ['cmd.exe', ['/c', 'start', '', url]]
    : platform() === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref();
  return 'browser';
}

// One app, one server. A second launch finds the running one through a lock
// file and just opens another window onto it, instead of starting a second
// server that would fight the first over the same session windows.
async function existingServer() {
  const lock = join(appDataDir(), 'server.lock.json');
  if (!existsSync(lock)) return null;
  try {
    const { port } = JSON.parse(readFileSync(lock, 'utf8'));
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 800);
    const r = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: ctl.signal });
    clearTimeout(t);
    if (r.ok) return port;
  } catch { /* stale lock */ }
  return null;
}

async function main() {
  const ei = argv.indexOf('--engine');
  if (ei >= 0) {
    await runEngine(argv.slice(ei + 1));
    return;
  }
  if (argv.includes('--version')) {
    console.log(`brainstorm ${VERSION}${IS_SEA ? ' (exe)' : ' (source)'}`);
    return;
  }

  const noWindow = argv.includes('--no-window');

  // ⛔ No visible console. brainstorm.exe is a console-subsystem binary, so a
  // double-click opens a black console window beside the app -- and closing
  // that window kills the server, leaving the app window open with nothing
  // behind it. So the visible process starts a copy of itself with NO console
  // (detached: true is DETACHED_PROCESS on Windows) and exits. The copy logs to
  // %APPDATA%\brainstorm\app.log. --console keeps the old behaviour.
  if (IS_SEA && platform() === 'win32' && !noWindow && !argv.includes('--console') && !argv.includes('--child')) {
    mkdirSync(appDataDir(), { recursive: true });
    const logFile = join(appDataDir(), 'app.log');
    try { if (existsSync(logFile)) renameSync(logFile, join(appDataDir(), 'app.prev.log')); } catch { /* in use */ }
    const fd = openSync(logFile, 'a');
    const child = spawn(process.execPath, [...argv, '--child'], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    return;
  }

  const running = noWindow ? null : await existingServer();
  if (running) {
    openWindow(`http://127.0.0.1:${running}/`);
    console.log(`brainstorm is already running on ${running}; opened another window.`);
    return;
  }

  const { startIde } = await import('../src/server/ide.mjs');
  const port = Number(opt('port', 0));
  startIde({
    port,
    // --exit-when-closed lets a test exercise the presence rule without a window.
    exitWhenClosed: !noWindow || argv.includes('--exit-when-closed'),
    onListening: (real) => {
      mkdirSync(appDataDir(), { recursive: true });
      writeFileSync(join(appDataDir(), 'server.lock.json'), JSON.stringify({ port: real, pid: process.pid, at: new Date().toISOString() }));
      if (!noWindow) {
        const how = openWindow(`http://127.0.0.1:${real}/`);
        console.log(`  window          ${how}`);
      }
    },
  });
}

main().catch((err) => {
  console.error(`brainstorm: ${err.stack || err.message}`);
  process.exit(1);
});
