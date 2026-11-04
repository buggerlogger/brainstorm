// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// claude-cli.mjs — start the real claude from a test, without shell:true.
//
// npm installs claude as a .cmd shim, which Windows cannot start directly.
// shell:true with an args array made Node join the args unescaped (DEP0190,
// printed on every run), so each prompt was hand-wrapped in quotes to survive
// it. Here cmd.exe is called explicitly with the bare name, as
// scripts/setup.mjs does: Node quotes every argument, cmd finds claude on
// PATH, and the shim passes them on with %*.
//
// ⛔ Inside quotes cmd still expands %VAR% and a " ends the quoted text, so an
// argument holding either is refused rather than handed over changed.

import { spawnSync } from 'node:child_process';

const IS_WIN = process.platform === 'win32';

export function runClaude(args, opts = {}) {
  if (!IS_WIN) return spawnSync('claude', args, opts);
  const bad = args.find((a) => /["%]/.test(String(a)));
  if (bad !== undefined) throw new Error(`runClaude: cmd.exe would change this argument (" or %): ${bad}`);
  return spawnSync('cmd.exe', ['/d', '/s', '/c', 'claude', ...args], opts);
}
