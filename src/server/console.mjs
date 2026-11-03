// console.mjs — pop a REAL terminal window on the desktop.
//
// The in-page terminal is pipes, so a full-screen TUI cannot render there and
// interactive `claude` will not run in it. Rather than fake a pty, open the
// genuine article: a terminal window owned by the desktop, with a real TTY, in
// the project's directory.
//
// This is the x64dbg shape. The debugger does not try to BE the program; it
// attaches to one that is already running. You run `claude` yourself in a
// terminal that behaves like every other terminal you have, and the watcher
// attaches to the session it produces -- it polls the transcript directory, so
// it never needed to own the process.
//
// ── HOW THE LAUNCH WAS CHOSEN ─────────────────────────────────────────────
// Five strategies were measured on Windows 11 with Windows Terminal set as the
// default terminal application. The probe had the new window write its own
// console state to a file:
//
//   wt.exe -d <cwd> powershell -NoExit -File <script>   ok  inRedir=False outRedir=False
//   powershell spawned with stdio:'inherit'             ok  inRedir=True  outRedir=True
//   powershell spawned with detached:true               FAILED: argv dropped entirely
//   cmd /c start "title" /D <cwd> powershell ...        FAILED (detached and not)
//   conhost.exe powershell ...                          FAILED
//
// Two things that look obvious are therefore wrong here. `detached: true` --
// the documented way to give a child its own console -- loses the command line
// on this machine: the spawned processes showed up in Win32_Process as a bare
// `"powershell.exe"` with no arguments. And `start`, the canonical way to open
// a window, never ran its command either. Both are consequences of the default
// terminal handoff: conhost hands the new console to Windows Terminal, and the
// arguments do not survive the trip.
//
// Only wt.exe produced a window with BOTH input and output unredirected, which
// is what "interactive" actually means -- a window you can type `claude` into.
// So wt is used when it exists. The `start` fallback is kept for machines with
// no Windows Terminal, where it is the correct approach, and is marked as
// untested rather than claimed to work.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { platform, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

const IS_WIN = platform() === 'win32';

function which(exe) {
  const probe = IS_WIN ? spawnSync('where', [exe], { encoding: 'utf8' }) : spawnSync('which', [exe], { encoding: 'utf8' });
  if (probe.status !== 0) return null;
  const first = String(probe.stdout || '').split(/\r?\n/).find((l) => l.trim());
  return first ? first.trim() : null;
}

let wtCache;
const haveWt = () => {
  if (wtCache === undefined) wtCache = IS_WIN ? !!which('wt.exe') : false;
  return wtCache;
};

// The choice is which SHELL to open. Which window HOSTS it is decided here,
// because that is a property of the machine, not something to ask about.
export function availableConsoles() {
  if (IS_WIN) {
    const host = haveWt() ? 'Windows Terminal' : 'console window';
    const out = [
      { id: 'powershell', label: `PowerShell (${host})`, note: 'real TTY — run claude here' },
      { id: 'cmd', label: `Command Prompt (${host})`, note: 'real TTY' },
    ];
    if (which('pwsh.exe')) out.unshift({ id: 'pwsh', label: `PowerShell 7 (${host})`, note: 'real TTY' });
    return out;
  }
  const out = [];
  if (platform() === 'darwin') out.push({ id: 'terminal-app', label: 'Terminal.app', note: 'real TTY' });
  for (const [id, exe, label] of [
    ['gnome-terminal', 'gnome-terminal', 'GNOME Terminal'],
    ['konsole', 'konsole', 'Konsole'],
    ['xterm', 'xterm', 'xterm'],
  ]) if (which(exe)) out.push({ id, label, note: 'real TTY' });
  return out;
}

// `run` goes into a script file rather than onto a command line. Quoting a
// command through cmd AND PowerShell AND wt is three chances to corrupt it --
// an earlier version "escaped" it by STRIPPING double quotes, which silently
// changed what the window ran. A path has no quoting problems.
function scriptFor(kind, run) {
  if (!run) return null;
  const dir = join(tmpdir(), 'brainstorm-console');
  mkdirSync(dir, { recursive: true });
  const ext = kind === 'cmd' ? 'cmd' : 'ps1';
  const file = join(dir, `run-${randomUUID().slice(0, 8)}.${ext}`);
  const body = kind === 'cmd' ? `@echo off\r\n${run}\r\n` : `${run}\n`;
  writeFileSync(file, body, 'utf8');
  return file;
}

function shellArgv(kind, script) {
  if (kind === 'cmd') return ['cmd.exe', script ? ['/K', script] : ['/K']];
  const exe = kind === 'pwsh' ? 'pwsh.exe' : 'powershell.exe';
  // -NoExit keeps the window open after the script, so you can keep typing.
  return [exe, script ? ['-NoLogo', '-NoExit', '-File', script] : ['-NoLogo', '-NoExit']];
}

export function openConsole({ kind, cwd, run = '' } = {}) {
  if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`cwd ${JSON.stringify(cwd)} is not a directory`);
  }
  const kinds = availableConsoles().map((c) => c.id);
  const use = kinds.includes(kind) ? kind : kinds[0];
  if (!use) throw new Error('no terminal emulator found on this machine');

  // Newlines are stripped so one field cannot silently become several
  // commands; quotes are left alone because nothing re-parses them.
  const cmd = String(run).replace(/[\r\n]+/g, ' ').trim();

  let exe;
  let args;
  let host;

  if (IS_WIN) {
    const script = scriptFor(use, cmd);
    const [shExe, shArgs] = shellArgv(use, script);
    if (haveWt()) {
      host = 'wt';
      exe = 'wt.exe';
      // -w new: its OWN window. Without it wt opens a TAB in whatever Windows
      // Terminal window is already running, so pressing the button silently
      // adds tabs to the terminal you were using for something else.
      args = ['-w', 'new', '-d', cwd, shExe, ...shArgs];
    } else {
      // Untested on the machine this was written on (it has Windows Terminal).
      host = 'start';
      exe = 'cmd.exe';
      args = ['/c', 'start', 'brainstorm', '/D', cwd, shExe, ...shArgs];
    }
  } else if (use === 'terminal-app') {
    host = 'open';
    exe = 'open';
    args = ['-a', 'Terminal', cwd];
  } else if (use === 'gnome-terminal') {
    host = use;
    exe = 'gnome-terminal';
    args = ['--working-directory', cwd, ...(cmd ? ['--', 'bash', '-lc', `${cmd}; exec bash`] : [])];
  } else if (use === 'konsole') {
    host = use;
    exe = 'konsole';
    args = ['--workdir', cwd, ...(cmd ? ['-e', 'bash', '-lc', `${cmd}; exec bash`] : [])];
  } else {
    host = 'xterm';
    exe = 'xterm';
    args = ['-e', 'bash', '-lc', `cd ${cwd}; ${cmd || ''}; exec bash`];
  }

  // NOT detached: detached loses the argv here (measured, see the header).
  // The window still outlives this request -- Windows does not put a child in
  // a job object by default, and wt.exe is its own process either way.
  const child = spawn(exe, args, { cwd, stdio: 'ignore', windowsHide: false });
  child.unref();

  return { kind: use, host, cwd, exe, args, pid: child.pid ?? null, tty: host === 'wt' || !IS_WIN };
}
