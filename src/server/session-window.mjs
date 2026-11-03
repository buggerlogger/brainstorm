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
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
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
  runner: join(DIR(), `${tag}.runner.ps1`),
  meta: join(DIR(), `${tag}.meta.json`),
  log: join(DIR(), `${tag}.log`),
});

// PowerShell single-quoted literal: double any single quote. Used only for
// paths this module generated itself.
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

function runnerScript(tag) {
  const p = paths(tag);
  // Written as an array of lines so no shell ever re-parses it.
  return [
    '$ErrorActionPreference = "Continue"',
    `$ctl = ${psq(p.control)}`,
    `$pidFile = ${psq(p.pid)}`,
    `$log = ${psq(p.log)}`,
    `$Host.UI.RawUI.WindowTitle = "brainstorm ${tag}"`,
    'function Read-Ctl { try { Get-Content -Raw -LiteralPath $ctl | ConvertFrom-Json } catch { $null } }',
    'function Note($m) { Add-Content -LiteralPath $log -Value ((Get-Date -Format o) + "  " + $m) }',
    'Note "runner started pid $PID"',
    'while ($true) {',
    '  $c = Read-Ctl',
    '  if ($null -eq $c -or $c.stop) { Note "stop requested"; break }',
    '  $exe = if ($c.claude) { $c.claude } else { "claude" }',
    '  $cmd = Get-Command $exe -ErrorAction SilentlyContinue',
    '  if ($null -eq $cmd) { Write-Host "brainstorm: cannot find $exe on PATH" -ForegroundColor Red; Note "missing $exe"; break }',
    '  $argv = @("--resume", $c.resume) + @($c.args | Where-Object { $_ })',
    '  Write-Host ""',
    '  Write-Host ("brainstorm: claude --resume " + $c.resume) -ForegroundColor Cyan',
    '  Note ("start " + $cmd.Source + " " + ($argv -join " "))',
    // Start-Process -NoNewWindow shares THIS console, so claude gets the real
    // TTY; -PassThru gives the pid to record; -Wait blocks until it ends.
    '  $p = Start-Process -FilePath $cmd.Source -ArgumentList $argv -NoNewWindow -PassThru',
    '  Set-Content -LiteralPath $pidFile -Value $p.Id',
    '  $p.WaitForExit()',
    '  Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue',
    '  Note ("exit " + $p.ExitCode + " for " + $c.resume)',
    '  $after = Read-Ctl',
    '  if ($null -eq $after -or $after.stop) { Note "stop after exit"; break }',
    '  if ($after.resume -eq $c.resume -and $after.seq -eq $c.seq) { Note "claude ended by the user"; break }',
    '  Write-Host ""',
    '  Write-Host ("brainstorm: switching to edited session " + $after.resume) -ForegroundColor Yellow',
    '}',
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

export function openSessionWindow({ sessionId, cwd, shell = 'powershell', claudeArgs = '', claude = 'claude' } = {}) {
  if (!IS_WIN) throw new Error('session windows are implemented for Windows only so far');
  if (!sessionId || !cwd) throw new Error('need sessionId and cwd');
  mkdirSync(DIR(), { recursive: true });
  const tag = randomUUID().slice(0, 8);
  const p = paths(tag);
  writeControl(tag, { resume: sessionId, args: splitArgs(claudeArgs), claude, seq: 1, stop: false });
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
  child.unref();
  return { tag, sessionId, cwd, host: hasWt ? 'wt' : 'start', runner: p.runner };
}

// Switch a window to another session: write the id, then end ONLY the claude
// this window started. The runner resumes the new id in the same window.
export function resumeInWindow(tag, sessionId) {
  const cur = readControl(tag);
  if (!cur) throw new Error(`no window ${tag}`);
  writeControl(tag, { ...cur, resume: sessionId, seq: (cur.seq || 0) + 1, stop: false });
  const pid = claudePid(tag);
  const alive = pidAlive(pid);
  const killed = alive ? killTree(pid) : false;
  return { tag, sessionId, previous: cur.resume, claudePid: pid, wasRunning: alive, ended: killed };
}

export function stopWindow(tag) {
  const cur = readControl(tag);
  if (!cur) throw new Error(`no window ${tag}`);
  writeControl(tag, { ...cur, stop: true });
  const pid = claudePid(tag);
  const ended = pidAlive(pid) ? killTree(pid) : false;
  return { tag, ended };
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
      return { ...meta, tag, session: ctl?.resume ?? null, seq: ctl?.seq ?? null, stopped: !!ctl?.stop, claudePid: pid, claudeRunning: pidAlive(pid) };
    })
    .sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
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
