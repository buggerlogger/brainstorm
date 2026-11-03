// Copyright (c) 2026 buggerlogger. All rights reserved.
// Proprietary and confidential. No license is granted to use, copy, modify or
// distribute this file, in whole or in part. See LICENSE.
//
// sessions.mjs — find the sessions on this machine.
//
// ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
//
// The folder name is a LOSSY encoding of the cwd (every one of : \ / . becomes
// -), so it cannot be decoded back into a path. Do not try: each transcript
// records its own `cwd`, and that is the only trustworthy source. Reversing the
// encoding is the bug that made an older tool install into a directory Claude
// Code never reads.

import { readdirSync, statSync, readFileSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const PROJECTS = join(homedir(), '.claude', 'projects');

// Read just the head of the file: a transcript can be 25 MB and all we need is
// the first record that carries a cwd.
function headOf(file, bytes = 65536) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.slice(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

function metaOf(file) {
  const head = headOf(file);
  const out = { cwd: null, gitBranch: null, version: null, firstPrompt: null };
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!out.cwd && o.cwd) out.cwd = o.cwd;
    if (!out.gitBranch && o.gitBranch) out.gitBranch = o.gitBranch;
    if (!out.version && o.version) out.version = o.version;
    if (!out.firstPrompt && o.type === 'user' && typeof o.message?.content === 'string') {
      out.firstPrompt = o.message.content.slice(0, 160);
    }
    if (out.cwd && out.firstPrompt) break;
  }
  return out;
}

export function listProjects({ withMeta = true } = {}) {
  if (!existsSync(PROJECTS)) return [];
  const projects = [];
  for (const dir of readdirSync(PROJECTS)) {
    const full = join(PROJECTS, dir);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;
    const sessions = [];
    for (const f of readdirSync(full)) {
      if (!f.endsWith('.jsonl')) continue;
      const path = join(full, f);
      let fst;
      try { fst = statSync(path); } catch { continue; }
      const entry = {
        id: f.replace(/\.jsonl$/, ''),
        path,
        bytes: fst.size,
        mtime: fst.mtime.toISOString(),
      };
      if (withMeta) Object.assign(entry, metaOf(path));
      sessions.push(entry);
    }
    if (!sessions.length) continue;
    sessions.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    projects.push({
      dir,
      path: full,
      cwd: sessions.find((s) => s.cwd)?.cwd || null,
      sessions,
      bytes: sessions.reduce((a, s) => a + s.bytes, 0),
      mtime: sessions[0].mtime,
    });
  }
  projects.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return projects;
}

// resolveSession refuses ambiguity instead of picking. The same uuid can exist
// under two project folders with DIFFERENT contents, because resuming from
// another cwd writes a second copy -- taking the first match silently edits the
// file you were not looking at.
export function resolveSession(idOrPath) {
  if (!idOrPath) throw new Error('no session given');
  if (idOrPath.endsWith('.jsonl') && existsSync(idOrPath)) return { path: idOrPath, candidates: [] };
  const matches = [];
  for (const p of listProjects({ withMeta: false })) {
    for (const s of p.sessions) if (s.id === idOrPath) matches.push({ ...s, project: p.dir });
  }
  if (!matches.length) throw new Error(`session ${idOrPath} not found under ${PROJECTS}`);
  if (matches.length > 1) {
    const err = new Error(
      `session ${idOrPath} exists in ${matches.length} projects -- pass the full path:\n${
        matches.map((m) => `  ${m.mtime}  ${String(m.bytes).padStart(9)} B  ${m.path}`).join('\n')}`,
    );
    err.candidates = matches;
    throw err;
  }
  return { path: matches[0].path, candidates: matches };
}
