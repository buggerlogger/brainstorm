// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// session-window.mjs — a terminal window that runs claude, and can be told to
// switch sessions without being closed.
//
// THE LOOP. The window runs a small PowerShell runner:
//
//     loop:
//       read control.json            { resume: <session id>, args, claude, stop }
//       start claude --resume <id>   (records its pid, waits for it)
//       read control.json again
//       if the id changed           -> loop, resuming the NEW id
//       otherwise                   -> stop: you quit claude yourself
//
// Save & Resume therefore does two things: write the new session id into the
// control file, and end the running claude. The runner notices, and resumes
// the edited session in the SAME window -- no new window, no dead tab left
// saying "[process exited with code 1]", no lost scrollback or position.
//
// Ending claude is the one forceful step. It is aimed precisely: the runner
// writes claude's pid to a file, and only that process tree is ended. Nothing
// is found by searching command lines, so an unrelated claude in another
// terminal can never be the one that gets stopped.

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { appDataDir } from '../runtime.mjs';
import { availableConsoles } from './console.mjs';

const IS_WIN = platform() === 'win32';
const DIR = () => join(appDataDir(), 'windows');

const paths = (tag) => ({
  control: join(DIR(), `${tag}.control.json`),
  pid: join(DIR(), `${tag}.claude.pid`),
  runnerPid: join(DIR(), `${tag}.runner.pid`),
  runner: join(DIR(), `${tag}.runner.ps1`),
  meta: join(DIR(), `${tag}.meta.json`),
  log: join(DIR(), `${tag}.log`),
});

// PowerShell single-quoted literal: double any single quote. Used only for
// paths this module generated itself.
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Exported for test/runner-reset.test.mjs, which runs pieces of it.
export function runnerScript(tag) {
  const p = paths(tag);
  // Written as an array of lines so no shell ever re-parses it.
  return [
    '$ErrorActionPreference = "Continue"',
    `$ctl = ${psq(p.control)}`,
    `$pidFile = ${psq(p.pid)}`,
    `$log = ${psq(p.log)}`,
    `$Host.UI.RawUI.WindowTitle = "brainstorm ${tag}"`,
    // ⛔ Every file this runner touches is retried. A file another process has
    // open at that instant (a reader, a virus scan right after each write)
    // makes the write fail -- MEASURED: log lines lost at random, 2 runs in 4,
    // including "runner started pid", the line stop/close find the runner by.
    // A failed read of the control file was worse: it returned nothing, and
    // nothing means STOP, so a Save & Resume could end the window instead of
    // switching it. .NET calls are used because they throw, so Retry sees it.
    'function Retry([scriptblock]$Do) { for ($i = 0; $i -lt 40; $i++) { try { return (& $Do) } catch { Start-Sleep -Milliseconds 25 } }; $null }',
    // a half-written file is no answer either: -ErrorAction Stop makes bad JSON throw
    'function Read-Ctl { Retry { $j = [System.IO.File]::ReadAllText($ctl) | ConvertFrom-Json -ErrorAction Stop; if ($null -eq $j) { throw "empty" }; $j } }',
    'function Note($m) { $line = (Get-Date -Format o) + "  " + $m; [void](Retry { [System.IO.File]::AppendAllText($log, $line + [Environment]::NewLine); $true }) }',
    // ⛔ Put the terminal back after claude. claude's interactive screen turns
    // MOUSE REPORTING on. Save & Resume (and stop) end claude with a hard kill,
    // so it never turns it off again -- and every mouse move or drag in the
    // window then arrives as typed text: "[555;102;30M[555;105;30M..." filling
    // the prompt, exactly as reported. Every mouse mode is switched off, along
    // with bracketed paste, the alternate screen and a hidden cursor, and the
    // input already queued is thrown away so the garbage typed while claude
    // was gone never reaches the shell or the next claude.
    //
    // ⛔ ...but ?1049l (leave the alternate screen) also RESTORES THE SAVED
    // CURSOR, alternate screen or not. MEASURED in a plain window: after it,
    // output landed on row 1 (where a program had saved the cursor) or row 0
    // (nothing saved), on top of what was there. So after every Save & Resume
    // the runner's own reset sent the cursor back to where the old claude
    // began, and the new claude drew over the old conversation: the chat
    // "reset". It is sent only when claude may have been fullscreen; with
    // keepChat the classic renderer is forced and there is no screen to leave.
    // Then the cursor is where claude left it, at its input box, so 0J clears
    // from there down: the dead claude's prompt box and status line, never the
    // conversation above it. (Not without keepChat: the cursor may be at the
    // top by then, and 0J would wipe everything.)
    'function Reset-Terminal {',
    "  $modes = @('?1000l', '?1001l', '?1002l', '?1003l', '?1005l', '?1006l', '?1015l', '?2004l', '?25h', '0m')",
    "  if ($env:CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN -ne '1') { $modes = @('?1049l') + $modes } else { $modes += '0J' }",
    "  [Console]::Write((($modes | ForEach-Object { [char]27 + '[' + $_ }) -join ''))",
    '  try { $Host.UI.RawUI.FlushInputBuffer() } catch { }',
    '}',
    'Reset-Terminal',
    'Note "runner started pid $PID"',
    'while ($true) {',
    '  $c = Read-Ctl',
    '  if ($null -eq $c -or $c.stop) { Note "stop requested"; break }',
    '  $exe = if ($c.claude) { $c.claude } else { "claude" }',
    // ⛔ -CommandType Application. A bare Get-Command resolves npm's `claude` to
    // claude.ps1 FIRST (an ExternalScript), and Start-Process on a .ps1 does
    // not run it in this console -- it opens it by file association. Save &
    // Resume then "restarted" nothing: claude never came back. MEASURED on the
    // machine this broke on: ExternalScript claude.ps1, then Application
    // claude.cmd, then Application claude. The stub test passed only because
    // its fake claude was a .cmd.
    '  $cmd = Get-Command $exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1',
    '  $viaPs1 = $false',
    '  if ($null -eq $cmd) {',
    '    $cmd = Get-Command $exe -CommandType ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1',
    '    $viaPs1 = $null -ne $cmd',
    '  }',
    '  if ($null -eq $cmd) { Write-Host "brainstorm: cannot find $exe on PATH" -ForegroundColor Red; Note "missing $exe"; break }',
    // The brainstorm-live mod and where it posts. Set on THIS process, so the
    // claude it starts inherits them; a control file without them runs claude
    // exactly as before.
    '  if ($c.env) { foreach ($kv in $c.env.PSObject.Properties) { Set-Item -LiteralPath ("Env:" + $kv.Name) -Value ([string]$kv.Value) } }',
    '  $plugins = @($c.plugins | Where-Object { $_ } | ForEach-Object { "--plugin-dir"; $_ })',
    // A NEW session (Create session) starts with --session-id: the id is
    // brainstorm's, so it knows which transcript to wait for. Every start
    // after that, a Save & Resume included, resumes.
    '  $first = if ($c.fresh) { @("--session-id", $c.resume) } else { @("--resume", $c.resume) }',
    '  $argv = $first + $plugins + @($c.args | Where-Object { $_ })',
    // ⛔ Start-Process joins -ArgumentList with spaces and quotes NOTHING
    // (Windows PowerShell 5.1): a plugin folder under a user name with a space
    // would reach claude as two arguments.
    '  $argv = @($argv | ForEach-Object { if ("$_".Contains(" ")) { [char]34 + $_ + [char]34 } else { $_ } })',
    '  Write-Host ""',
    '  if ($c.fresh) { Write-Host ("brainstorm: new claude session " + $c.resume + " - type your first message") -ForegroundColor Cyan }',
    '  else { Write-Host ("brainstorm: claude --resume " + $c.resume) -ForegroundColor Cyan }',
    '  if ($plugins.Count) { Write-Host "brainstorm: live hooks on (brainstorm-live mod)" -ForegroundColor DarkGray }',
    '  Note ("start " + $cmd.CommandType + " " + $cmd.Source + " " + ($argv -join " "))',
    // Start-Process -NoNewWindow shares THIS console, so claude gets the real
    // TTY; -PassThru gives the pid to record. A script that is the only option
    // runs through powershell -File, which is how a .ps1 actually executes.
    '  if ($viaPs1) {',
    '    $p = Start-Process -FilePath "powershell.exe" -ArgumentList (@("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $cmd.Source) + $argv) -NoNewWindow -PassThru',
    '  } else {',
    '    $p = Start-Process -FilePath $cmd.Source -ArgumentList $argv -NoNewWindow -PassThru',
    '  }',
    '  [void](Retry { [System.IO.File]::WriteAllText($pidFile, [string]$p.Id); $true })',
    '  $p.WaitForExit()',
    '  [void](Retry { if ([System.IO.File]::Exists($pidFile)) { [System.IO.File]::Delete($pidFile) }; $true })',
    // Whether claude quit or was killed, the terminal may be left in its modes.
    '  Reset-Terminal',
    '  Note ("exit " + $p.ExitCode + " for " + $c.resume + "; terminal reset")',
    '  $after = Read-Ctl',
    '  if ($null -eq $after -or $after.stop) { Note "stop after exit"; break }',
    '  if ($after.resume -eq $c.resume -and $after.seq -eq $c.seq) { Note "claude ended by the user"; break }',
    '  Write-Host ""',
    '  Write-Host ("brainstorm: switching to edited session " + $after.resume) -ForegroundColor Yellow',
    '}',
    // A window asked to CLOSE (tests do this) exits instead of staying open as
    // a shell -- test windows used to pile up on the desktop after every run.
    '$fin = Read-Ctl',
    // NOT `exit`: under -NoExit, `exit` in a script ends the SCRIPT and leaves
    // the shell open -- measured, the window stayed. Environment.Exit ends the
    // process, with code 0, so Windows Terminal closes the tab cleanly.
    'if ($fin -and $fin.close) { Note "closing the window"; [Environment]::Exit(0) }',
    'Write-Host ""',
    'Write-Host "brainstorm: claude is not running. This is a normal shell now." -ForegroundColor DarkGray',
  ].join('\r\n');
}

function writeControl(tag, ctl) {
  writeFileSync(paths(tag).control, JSON.stringify(ctl, null, 2));
}

export function readControl(tag) {
  try { return JSON.parse(readFileSync(paths(tag).control, 'utf8')); } catch { return null; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function claudePid(tag) {
  try {
    const n = Number(readFileSync(paths(tag).pid, 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function killTree(pid) {
  if (!pid) return false;
  if (IS_WIN) {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
    return r.status === 0;
  }
  try { process.kill(-pid, 'SIGTERM'); return true; } catch { try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; } }
}

function splitArgs(s) {
  // A simple shell-ish split that honours "double quotes". The args go into a
  // JSON control file and an argv array, never back through a shell.
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(s || '')))) out.push(m[1] ?? m[2]);
  return out;
}

// plugins: folders claude is given with --plugin-dir (the brainstorm-live mod);
// env: variables the runner sets before it starts claude (where the mod posts).
// fresh: start a NEW claude session with this id (--session-id), not resume one.
export function openSessionWindow({ sessionId, cwd, shell = 'powershell', claudeArgs = '', claude = 'claude', plugins = [], env = {}, fresh = false } = {}) {
  if (!IS_WIN) throw new Error('session windows are implemented for Windows only so far');
  if (!sessionId || !cwd) throw new Error('need sessionId and cwd');
  // ⛔ claude --resume finds a session by the folder it runs in, so there is
  // no other folder to fall back to -- and spawning into a folder that is
  // gone used to take the WHOLE SERVER down: wt.exe failed with ENOENT on an
  // 'error' event nothing handled (measured: a session from a deleted temp
  // folder, opened by Save & Resume).
  if (!existsSync(cwd)) throw new Error(`the session's folder no longer exists: ${cwd} -- claude --resume has to run there`);
  mkdirSync(DIR(), { recursive: true });
  const tag = randomUUID().slice(0, 8);
  const p = paths(tag);
  writeControl(tag, { resume: sessionId, fresh: !!fresh, args: splitArgs(claudeArgs), claude, plugins, env, seq: 1, stop: false });
  writeFileSync(p.runner, runnerScript(tag), 'utf8');
  writeFileSync(p.meta, JSON.stringify({ tag, cwd, shell, openedAt: new Date().toISOString(), firstSession: sessionId }, null, 2));

  // The runner is PowerShell regardless of the shell setting: it is the loop,
  // and it hands the window to claude. cmd cannot express the loop cleanly.
  const hasWt = availableConsoles().some((c) => c.label.includes('Windows Terminal'));
  const ps = shell === 'pwsh' ? 'pwsh.exe' : 'powershell.exe';
  const psArgs = ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', p.runner];
  let exe;
  let args;
  if (hasWt) {
    exe = 'wt.exe';
    args = ['-w', 'new', '--title', `brainstorm ${tag}`, '-d', cwd, ps, ...psArgs];
  } else {
    exe = 'cmd.exe';
    args = ['/c', 'start', `brainstorm ${tag}`, '/D', cwd, ps, ...psArgs];
  }
  const child = spawn(exe, args, { cwd, stdio: 'ignore', windowsHide: false });
  // a window that fails to start is this window's problem, never the server's
  child.on('error', (err) => {
    try { appendFileSync(p.log, `${new Date().toISOString()}  could not start the window: ${err.message}\r\n`); } catch { /* nowhere to say it */ }
  });
  child.unref();
  return { tag, sessionId, cwd, host: hasWt ? 'wt' : 'start', runner: p.runner };
}

// Switch a window to another session: write the id, then end ONLY the claude
// this window started. The runner resumes the new id in the same window.
//
// launch: how claude is started from now on ({ claude, claudeArgs, plugins,
// env }), as the settings are NOW. Without it the window kept what it was
// opened with, so a corrected claudePath never reached a window already open.
export function resumeInWindow(tag, sessionId, launch = null) {
  const cur = readControl(tag);
  if (!cur) throw new Error(`no window ${tag}`);
  const now = launch ? {
    claude: launch.claude || 'claude',
    args: splitArgs(launch.claudeArgs),
    plugins: launch.plugins || [],
    env: launch.env || {},
  } : {};
  // ⛔ fresh is for the FIRST start only: a switch resumes a session that
  // exists, and --session-id on an id already used would be refused
  writeControl(tag, { ...cur, ...now, resume: sessionId, fresh: false, seq: (cur.seq || 0) + 1, stop: false });
  const pid = claudePid(tag);
  const alive = pidAlive(pid);
  const killed = alive ? killTree(pid) : false;
  return { tag, sessionId, previous: cur.resume, claudePid: pid, wasRunning: alive, ended: killed };
}

// close: true also closes the WINDOW (tests use it, so their windows do not
// pile up). The runner exits cleanly when it sees it; if its loop already
// ended -- claude was quit by hand -- the runner process itself is ended.
export function stopWindow(tag, { close = false } = {}) {
  const cur = readControl(tag);
  if (!cur) throw new Error(`no window ${tag}`);
  writeControl(tag, { ...cur, stop: true, close: !!close });
  const pid = claudePid(tag);
  const ended = pidAlive(pid) ? killTree(pid) : false;
  if (close && !ended) {
    const m = windowLog(tag).match(/runner started pid (\d+)/);
    const runner = m ? Number(m[1]) : null;
    if (runner && pidAlive(runner)) killTree(runner);
  }
  return { tag, ended, closed: !!close };
}

export function listWindows() {
  if (!existsSync(DIR())) return [];
  return readdirSync(DIR())
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => {
      const tag = f.replace(/\.meta\.json$/, '');
      let meta = {};
      try { meta = JSON.parse(readFileSync(join(DIR(), f), 'utf8')); } catch { /* ignore */ }
      const ctl = readControl(tag);
      const pid = claudePid(tag);
      let claudeSince = null;
      try { claudeSince = statSync(paths(tag).pid).mtimeMs; } catch { /* not running */ }
      return { ...meta, tag, session: ctl?.resume ?? null, seq: ctl?.seq ?? null, stopped: !!ctl?.stop, claudePid: pid, claudeRunning: pidAlive(pid), claudeSince };
    })
    .sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
}

// A window whose claude is running this session right now. Opening the
// session again ADOPTS it rather than starting a second claude on the same
// transcript -- after brainstorm was closed and opened again, and when the
// open is asked for twice (measured: two windows for one session six
// seconds apart, a second click while the first open was still loading).
export function findRunningWindow(sessionId) {
  if (!sessionId) return null;
  return listWindows().find((w) => w.claudeRunning && w.session === sessionId) || null;
}

export function windowLog(tag) {
  try { return readFileSync(paths(tag).log, 'utf8'); } catch { return ''; }
}

// Forget windows whose claude is gone and whose control says stop, so the
// list does not grow forever. Never touches a window that is still running.
export function pruneWindows() {
  let n = 0;
  for (const w of listWindows()) {
    if (w.claudeRunning || !w.stopped) continue;
    for (const f of Object.values(paths(w.tag))) { try { rmSync(f); } catch { /* ignore */ } }
    n++;
  }
  return n;
}
