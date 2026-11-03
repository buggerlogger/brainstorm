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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
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

function openWindow(url) {
  const edge = findEdge();
  const profile = join(appDataDir(), 'window-profile');
  mkdirSync(profile, { recursive: true });
  if (edge) {
    const child = spawn(edge, [
      `--app=${url}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,msEdgeSidebarV2,msHubApps',
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
    exitWhenClosed: !noWindow,
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
