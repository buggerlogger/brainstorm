// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// settings.mjs — everything a person can set, in one file, with one schema.
//
// The schema is the source of truth for three things at once: the defaults,
// the validation of what the UI sends back, and the Settings panel itself
// (which is rendered FROM this list). Adding an option is one entry here, not
// a default in one file, a check in another and a form field in a third that
// drift apart.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { appDataDir } from '../runtime.mjs';

const FILE = () => join(appDataDir(), 'settings.json');

export const SCHEMA = [
  // --- session ---
  { key: 'autoOpenConsole', group: 'Session', type: 'bool', default: true,
    label: 'Open a terminal when a session loads',
    help: 'Pops a real terminal in the session folder, running claude --resume on it.' },
  { key: 'shell', group: 'Session', type: 'enum', default: 'powershell', options: ['powershell', 'pwsh', 'cmd'],
    label: 'Terminal shell' },
  { key: 'resumeOnSave', group: 'Session', type: 'bool', default: true,
    label: 'Save & Resume restarts claude on the edited session',
    help: 'Builds, installs, then restarts claude inside the same terminal window on the new session id.' },
  { key: 'claudePath', group: 'Session', type: 'path', default: 'claude',
    label: 'claude executable',
    help: 'A name on PATH or a full path. Change it if claude is installed somewhere PATH does not reach.' },
  { key: 'claudeArgs', group: 'Session', type: 'string', default: '',
    label: 'Extra arguments for claude',
    help: 'Appended to every claude --resume the tool starts, e.g. --permission-mode acceptEdits' },

  // --- debugger ---
  { key: 'autoRecord', group: 'Debugger', type: 'bool', default: true,
    label: 'Record automatically when a session opens',
    help: 'Live only: what claude does from now on. Nothing already in the session is replayed.' },
  { key: 'follow', group: 'Debugger', type: 'bool', default: true,
    label: 'Auto-jump: open each recorded frame as it arrives',
    help: 'Can be stopped at any time from the Recording view.' },
  { key: 'followDelayMs', group: 'Debugger', type: 'int', default: 300, min: 0, max: 5000,
    label: 'Auto-jump step delay (ms)', help: '0 jumps straight to the newest frame.' },
  { key: 'followOnly', group: 'Debugger', type: 'enum', default: 'all', options: ['all', 'tools', 'prompts'],
    label: 'Auto-jump to which frames',
    help: 'all = every input and output; tools = tool calls and their results; prompts = what you typed and the replies.' },
  { key: 'autoAttach', group: 'Debugger', type: 'bool', default: true,
    label: 'Auto-attach to new sessions in the project',
    help: 'Skipped while there are unsaved edits.' },

  // --- export ---
  { key: 'exportDir', group: 'Export', type: 'path', default: join(homedir(), 'Desktop', 'brainstorm-exports'),
    label: 'Export folder' },
  { key: 'exportFlow', group: 'Export', type: 'enum', default: 'last', options: ['none', 'last', 'all'],
    label: 'Include the context flow',
    help: 'last = every frame of the final API call; all = the tail added by each call (bounded, not N copies).' },
  { key: 'exportAgents', group: 'Export', type: 'bool', default: true, label: 'Include subagents' },
  { key: 'revealAfterExport', group: 'Export', type: 'bool', default: true, label: 'Show the export in Explorer' },

  // --- appearance ---
  { key: 'theme', group: 'Appearance', type: 'enum', default: 'dark', options: ['dark', 'light'], label: 'Theme' },
  { key: 'fontSize', group: 'Appearance', type: 'int', default: 12, min: 9, max: 22, label: 'Editor font size' },
  { key: 'wrap', group: 'Appearance', type: 'bool', default: false, label: 'Wrap long lines in the editor' },

  // --- polling ---
  { key: 'pollShellMs', group: 'Advanced', type: 'int', default: 600, min: 150, max: 10000, label: 'Shell poll (ms)' },
  { key: 'pollLiveMs', group: 'Advanced', type: 'int', default: 1000, min: 250, max: 10000, label: 'Live poll (ms)' },
];

const DEFAULTS = Object.fromEntries(SCHEMA.map((s) => [s.key, s.default]));

function coerce(spec, v) {
  if (v === undefined) return spec.default;
  switch (spec.type) {
    case 'bool': return v === true || v === 'true' || v === 1;
    case 'int': {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n)) return spec.default;
      return Math.max(spec.min ?? -Infinity, Math.min(spec.max ?? Infinity, n));
    }
    case 'enum': return spec.options.includes(v) ? v : spec.default;
    case 'path':
    case 'string': return typeof v === 'string' ? v.slice(0, 2000) : spec.default;
    default: return spec.default;
  }
}

let cache = null;

export function loadSettings() {
  if (cache) return cache;
  let raw = {};
  try {
    if (existsSync(FILE())) raw = JSON.parse(readFileSync(FILE(), 'utf8'));
  } catch {
    // A hand-edited file that no longer parses must not stop the app opening.
    raw = {};
  }
  const out = { ...DEFAULTS };
  for (const spec of SCHEMA) out[spec.key] = coerce(spec, raw[spec.key]);
  out.recent = Array.isArray(raw.recent) ? raw.recent.slice(0, 20) : [];
  cache = out;
  return out;
}

export function saveSettings(patch = {}) {
  const cur = loadSettings();
  const next = { ...cur };
  for (const spec of SCHEMA) if (spec.key in patch) next[spec.key] = coerce(spec, patch[spec.key]);
  if (Array.isArray(patch.recent)) next.recent = patch.recent.slice(0, 20);
  mkdirSync(appDataDir(), { recursive: true });
  writeFileSync(FILE(), JSON.stringify(next, null, 2));
  cache = next;
  return next;
}

export function rememberRecent({ id, cwd, path }) {
  const cur = loadSettings();
  const recent = [{ id, cwd, path, at: new Date().toISOString() }, ...cur.recent.filter((r) => r.id !== id)];
  return saveSettings({ recent });
}

export const settingsFile = FILE;
