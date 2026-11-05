// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// search.mjs — find a session, and find a string inside one.
//
// findSessions answers the start gate: you type something, it lists sessions.
// Ranked, because "a16c" should put the session whose id STARTS with a16c above
// one whose first prompt happens to contain those letters.
//
// searchStrings is the x64dbg "search for strings" view: every place a piece
// of text occurs, in blocks you can edit and in the frames the model was sent,
// across the main agent and its subagents.

import { listProjects } from './sessions.mjs';

const RANK = { exact: 0, prefix: 1, idPart: 2, cwd: 3, prompt: 4 };

export function findSessions(query, { limit = 60 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const rows = [];
  for (const p of listProjects()) {
    for (const s of p.sessions) {
      const id = s.id.toLowerCase();
      const cwd = String(s.cwd || p.cwd || '').toLowerCase();
      const prompt = String(s.firstPrompt || '').toLowerCase();
      let why = null;
      if (!q) why = 'recent';
      else if (id === q) why = 'exact';
      else if (id.startsWith(q)) why = 'prefix';
      else if (id.includes(q)) why = 'idPart';
      else if (cwd.includes(q)) why = 'cwd';
      else if (prompt.includes(q)) why = 'prompt';
      if (!why) continue;
      rows.push({
        id: s.id,
        path: s.path,
        cwd: s.cwd || p.cwd || null,
        project: p.dir,
        bytes: s.bytes,
        mtime: s.mtime,
        firstPrompt: s.firstPrompt || '',
        hasMessage: !!s.hasMessage,
        why,
      });
    }
  }
  rows.sort((a, b) => {
    const r = (RANK[a.why] ?? 9) - (RANK[b.why] ?? 9);
    return r !== 0 ? r : (a.mtime < b.mtime ? 1 : -1);
  });
  // The same uuid can exist in two project folders with DIFFERENT contents.
  // Mark it rather than silently keeping one: the gate has to let the person
  // see that there are two and choose.
  const counts = new Map();
  for (const r of rows) counts.set(r.id, (counts.get(r.id) || 0) + 1);
  for (const r of rows) r.duplicate = counts.get(r.id) > 1;
  return { query: q, total: rows.length, results: rows.slice(0, limit) };
}

// searchStrings over already-traced sources. `sources` is a list of
// { agent, label, blocks?, trace? } so the caller decides what is in scope.
export function searchStrings(sources, query, { caseSensitive = false, limit = 500, regex = false } = {}) {
  if (!query) return { query, hits: [], truncated: false };
  let test;
  if (regex) {
    let re;
    try { re = new RegExp(query, caseSensitive ? 'g' : 'gi'); } catch (err) { throw new Error(`bad regex: ${err.message}`); }
    test = (text) => {
      re.lastIndex = 0;
      const m = re.exec(text);
      if (!m) return null;
      let n = 1;
      while (re.exec(text)) n++;
      return { at: m.index, len: m[0].length, n };
    };
  } else {
    const needle = caseSensitive ? query : query.toLowerCase();
    test = (text) => {
      const hay = caseSensitive ? text : text.toLowerCase();
      const at = hay.indexOf(needle);
      if (at < 0) return null;
      let n = 0;
      for (let i = at; i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
      return { at, len: needle.length, n };
    };
  }

  const hits = [];
  const excerpt = (text, at, len) => text.slice(Math.max(0, at - 70), at + len + 70).replace(/\s+/g, ' ');
  let truncated = false;

  outer: for (const src of sources) {
    for (const b of src.blocks || []) {
      const m = test(b.text || '');
      if (!m) continue;
      hits.push({
        agent: src.agent, agentLabel: src.label, where: 'block', blockId: b.id, line: b.line,
        kind: b.kind, role: b.role, occurrences: m.n, excerpt: excerpt(b.text, m.at, m.len),
      });
      if (hits.length >= limit) { truncated = true; break outer; }
    }
    (src.trace?.calls || []).forEach((c, ci) => {
      if (truncated) return;
      c.frames.forEach((f, fi) => {
        if (truncated || !f.text) return;
        const m = test(f.text);
        if (!m) return;
        hits.push({
          agent: src.agent, agentLabel: src.label, where: 'frame', call: ci, frame: fi, path: f.path,
          kind: f.kind, line: f.source?.line ?? null, occurrences: m.n, excerpt: excerpt(f.text, m.at, m.len),
        });
        if (hits.length >= limit) truncated = true;
      });
    });
    if (truncated) break;
  }
  return { query, hits, truncated };
}
