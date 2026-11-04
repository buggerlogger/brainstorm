// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// runner-reset.test.mjs — after claude exits, the session window's runner must
// not send the cursor back over the conversation. No window, no claude.
//
//   node test/runner-reset.test.mjs
//
// MEASURED in a real window: ESC[?1049l (leave the alternate screen) also
// restores the saved cursor, alternate screen or not -- output after it landed
// on row 1, or row 0 when nothing was saved. The runner sent it after every
// Save & Resume, so the resumed claude drew over the old conversation:
// "the chat was reset". With keepChat the classic renderer is forced
// (CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1), there is no screen to leave, and
// ESC[0J clears only the dead claude's prompt box below the cursor.
//
// This runs the runner's own Reset-Terminal, cut from the script the window
// writes, in PowerShell, and checks the exact bytes it sends.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.BRAINSTORM_HOME = mkdtempSync(join(tmpdir(), 'bs-runner-reset-'));
const { runnerScript } = await import('../src/server/session-window.mjs');

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);
const ESC = '\u001b';
const shown = (s) => JSON.stringify(s.split(ESC).join('ESC'));

if (process.platform !== 'win32') {
  console.log('  SKIP  the runner is PowerShell, on Windows');
  process.exit(0);
}

const lines = runnerScript('t0000000').split('\r\n');
const start = lines.indexOf('function Reset-Terminal {');
const end = lines.indexOf('}', start);
check(start >= 0 && end > start, 'the runner defines Reset-Terminal', `lines ${start}..${end}`);
const ps1 = join(process.env.BRAINSTORM_HOME, 'reset.ps1');
writeFileSync(ps1, [...lines.slice(start, end + 1), 'Reset-Terminal'].join('\r\n'));

function reset(value) {
  const env = { ...process.env };
  if (value === undefined) delete env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN;
  else env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = value;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], { env, encoding: 'latin1', windowsHide: true });
  return r.stdout || '';
}

try {
  step('keepChat on: the classic renderer is forced');
  const kept = reset('1');
  check(!kept.includes(`${ESC}[?1049l`), 'no ?1049l: the cursor stays below the conversation', shown(kept));
  check(kept.includes(`${ESC}[0J`), 'clears from the cursor down: only the dead claude\'s prompt box');
  check(kept.includes(`${ESC}[?1000l`) && kept.includes(`${ESC}[?2004l`) && kept.includes(`${ESC}[?25h`), 'and still turns mouse reporting and bracketed paste off, the cursor on');

  step('keepChat off: claude may have been fullscreen');
  const full = reset(undefined);
  check(full.includes(`${ESC}[?1049l`), 'leaves the alternate screen', shown(full));
  check(!full.includes(`${ESC}[0J`), 'and clears nothing: the cursor may be at the top by then');
} finally {
  rmSync(process.env.BRAINSTORM_HOME, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
