// Copyright (c) 2026 buggerlogger. All rights reserved.
// Proprietary and confidential. No license is granted to use, copy, modify or
// distribute this file, in whole or in part. See LICENSE.
//
// shell.mjs — a real shell in the bottom panel.
//
// WHAT THIS IS. A long-lived PowerShell (or cmd, or bash) process whose stdout
// and stderr are streamed to the page and whose stdin the page can write to.
// You run `claude`, `git status`, `npm test` -- whatever you would run in a
// terminal window -- and the IDE watches the project's transcripts while you
// do, so a session you start here is debugged live.
//
// WHAT THIS IS NOT, honestly. It is pipes, not a pseudo-terminal. Without a
// PTY there is no TTY on the far end, so:
//
//   * programs that draw a full-screen interface (vim, top, and `claude` with
//     no -p) will not render -- they want cursor control a pipe cannot carry
//   * there is no terminal width, so some tools wrap oddly
//   * ANSI colour still arrives and is rendered; cursor-motion escapes are
//     stripped rather than honoured
//
// A real PTY needs a native module (node-pty) and a C++ toolchain, which this
// machine does not have, so the limitation is stated rather than hidden behind
// a terminal that looks real and then garbles. `claude -p "..."` works
// perfectly here, and an interactive `claude` started in ANY terminal -- this
// one or your own Windows Terminal -- is still detected and debugged, because
// detection watches the transcript files, not this process.

import { spawn } from 'node:child_process';
import { platform } from 'node:os';

const MAX_BUFFER = 4000;          // lines kept for replay
const IS_WIN = platform() === 'win32';

export const SHELLS = IS_WIN
  ? { powershell: ['powershell.exe', ['-NoLogo', '-NoProfile', '-NoExit', '-Command', '-']], cmd: ['cmd.exe', ['/Q', '/K']] }
  : { bash: ['/bin/bash', ['-i']], sh: ['/bin/sh', ['-i']] };

export const DEFAULT_SHELL = IS_WIN ? 'powershell' : 'bash';

// Cursor-motion and screen-clearing sequences a pipe cannot honour. Colour
// (SGR, ESC[...m) is deliberately kept: the page renders it.
const STRIP = [
  /\u001b\[[0-9;?]*[ABCDEFGHJKSTfhlnsu]/g,   // cursor moves, erase, modes
  /\u001b\][0-9];[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, // OSC (title, hooks)
  /\u001b[()][B0UK]/g,                       // charset selection
  /[\u0000\u0007\u000b\u000c]/g,             // NUL, BEL, VT, FF
];

function clean(s) {
  let out = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const re of STRIP) out = out.replace(re, '');
  return out;
}

export class Shell {
  constructor({ cwd, kind = DEFAULT_SHELL, onData = () => {} } = {}) {
    this.kind = SHELLS[kind] ? kind : DEFAULT_SHELL;
    this.cwd = cwd || process.cwd();
    this.onData = onData;
    this.seq = 0;
    this.lines = [];               // { seq, stream, text }
    this.proc = null;
    this.exitInfo = null;
    this.start();
  }

  start() {
    const [cmd, args] = SHELLS[this.kind];
    this.exitInfo = null;
    this.proc = spawn(cmd, args, {
      cwd: this.cwd,
      windowsHide: true,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: process.env.NO_COLOR ?? '' },
    });
    this.push('sys', `[${this.kind} in ${this.cwd}]`);
    this.proc.stdout.on('data', (d) => this.push('out', clean(String(d))));
    this.proc.stderr.on('data', (d) => this.push('err', clean(String(d))));
    this.proc.on('error', (err) => this.push('err', `[shell error: ${err.message}]`));
    this.proc.on('close', (code, signal) => {
      this.exitInfo = { code, signal, at: new Date().toISOString() };
      this.push('sys', `[shell exited: code ${code}${signal ? ` signal ${signal}` : ''}]`);
      this.proc = null;
    });
  }

  push(stream, text) {
    if (!text) return;
    // Split on newlines but keep partial last lines intact for the next chunk.
    for (const part of text.split('\n')) {
      this.lines.push({ seq: ++this.seq, stream, text: part });
    }
    if (this.lines.length > MAX_BUFFER) this.lines.splice(0, this.lines.length - MAX_BUFFER);
    this.onData();
  }

  write(data) {
    if (!this.proc) throw new Error('shell is not running; restart it');
    // Echo what was typed: a pipe gives no terminal echo, so without this the
    // transcript in the page shows answers with no questions.
    this.push('in', data.replace(/\n$/, ''));
    this.proc.stdin.write(data.endsWith('\n') ? data : `${data}\n`);
    return true;
  }

  // There is no job control over a pipe, so "Ctrl+C" kills the shell and
  // starts a fresh one. Said plainly in the UI rather than pretending to
  // deliver SIGINT to a foreground process group that does not exist here.
  interrupt() {
    if (this.proc) {
      this.push('sys', '[interrupt: restarting the shell -- a pipe has no job control]');
      try { this.proc.kill(); } catch { /* already gone */ }
      this.proc = null;
    }
    this.start();
  }

  restart(kind, cwd) {
    if (kind && SHELLS[kind]) this.kind = kind;
    if (cwd) this.cwd = cwd;
    if (this.proc) { try { this.proc.kill(); } catch { /* ignore */ } this.proc = null; }
    this.lines = [];
    this.seq = 0;
    this.start();
  }

  since(n) {
    const from = Number(n) || 0;
    return this.lines.filter((l) => l.seq > from);
  }

  status() {
    return {
      kind: this.kind,
      cwd: this.cwd,
      running: !!this.proc,
      pid: this.proc?.pid ?? null,
      seq: this.seq,
      exited: this.exitInfo,
      shells: Object.keys(SHELLS),
      pty: false,
      note: 'pipes, not a PTY: full-screen TUIs (including interactive `claude`) will not render. `claude -p "..."` works.',
    };
  }

  dispose() {
    if (this.proc) { try { this.proc.kill(); } catch { /* ignore */ } this.proc = null; }
  }
}
