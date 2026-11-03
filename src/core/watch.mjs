// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// watch.mjs — notice when a Claude session runs, and report what it did to
// the context, call by call.
//
// Detection watches the TRANSCRIPT DIRECTORY for the project, not the shell
// process. That is deliberate and it is the stronger design:
//
//   * it works whether you start `claude` in the IDE's terminal, in your own
//     Windows Terminal, in an IDE extension, or from a script
//   * it survives the shell being restarted mid-session
//   * it needs no cooperation from the CLI, no wrapper, no flags
//
// A session writes its .jsonl as it goes, so polling the directory for new or
// grown files finds the active one within a tick. What is reported is the
// DIFFERENCE between traces: new API calls (jumps) and new tool_use frames
// (calls), which is the live version of the debugger's step view.

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readTranscript } from './transcript.mjs';
import { traceFlow } from './flow.mjs';

const PROJECTS = join(homedir(), '.claude', 'projects');

// Claude Code encodes the cwd by replacing every : \ / and . with a dash. It
// is lossy and MUST NOT be reversed -- but it can be computed forwards, which
// is all a watcher needs.
export function projectDirForCwd(cwd) {
  return join(PROJECTS, String(cwd).replace(/[:\\/.]/g, '-'));
}

export class SessionWatcher {
  constructor({ cwd, ratio = 4, onEvent = () => {} } = {}) {
    this.cwd = cwd;
    this.ratio = ratio;
    this.onEvent = onEvent;
    this.dir = cwd ? projectDirForCwd(cwd) : null;
    this.seen = new Map();      // file -> { size, mtimeMs, calls, toolCalls }
    this.events = [];
    this.seq = 0;
    this.timer = null;
    this.active = null;         // the file currently being written
    this.pollMs = 1000;
  }

  start() {
    if (this.timer) return;
    this.prime();
    this.timer = setInterval(() => {
      try { this.tick(); } catch (err) { this.emit('error', { message: err.message }); }
    }, this.pollMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setCwd(cwd) {
    if (cwd === this.cwd) return;
    this.cwd = cwd;
    this.dir = cwd ? projectDirForCwd(cwd) : null;
    this.seen.clear();
    this.active = null;
    this.prime();
  }

  list() {
    if (!this.dir || !existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const p = join(this.dir, f);
        try {
          const st = statSync(p);
          return { file: p, id: f.replace(/\.jsonl$/, ''), size: st.size, mtimeMs: st.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  // prime records what is already on disk WITHOUT emitting events, so opening
  // the IDE does not replay every call of every past session as if it were
  // happening now.
  prime() {
    for (const f of this.list()) {
      this.seen.set(f.file, { size: f.size, mtimeMs: f.mtimeMs, calls: -1, toolCalls: -1 });
    }
  }

  emit(type, data) {
    const ev = { seq: ++this.seq, at: new Date().toISOString(), type, ...data };
    this.events.push(ev);
    if (this.events.length > 2000) this.events.splice(0, this.events.length - 2000);
    this.onEvent(ev);
    return ev;
  }

  tick() {
    for (const f of this.list()) {
      const prev = this.seen.get(f.file);
      if (prev && prev.size === f.size && prev.mtimeMs === f.mtimeMs) continue;
      const fresh = !prev;
      this.seen.set(f.file, { ...(prev || {}), size: f.size, mtimeMs: f.mtimeMs });
      if (fresh) this.emit('session-started', { session: f.id, file: f.file });
      this.inspect(f, fresh);
    }
  }

  inspect(f, fresh) {
    let trace;
    try {
      trace = traceFlow(readTranscript(f.file), this.ratio);
    } catch (err) {
      this.emit('error', { session: f.id, message: `trace failed: ${err.message}` });
      return;
    }
    const prev = this.seen.get(f.file) || {};
    const calls = trace.calls.length;
    const toolCalls = trace.calls.reduce((a, c) => a + c.frames.filter((x) => x.kind === 'tool_call').length, 0);
    const prevCalls = prev.calls ?? (fresh ? 0 : -1);
    const prevTools = prev.toolCalls ?? (fresh ? 0 : -1);

    this.active = f.file;
    this.seen.set(f.file, { ...prev, calls, toolCalls });

    // First sight of a pre-existing file: record the counts, say nothing.
    if (prevCalls < 0 || prevTools < 0) return;

    // JUMPS: each new api-request is one hop of the context into the model.
    for (let i = prevCalls; i < calls; i++) {
      const c = trace.calls[i];
      this.emit('jump', {
        session: f.id,
        file: f.file,
        call: i,
        line: c.line,
        model: c.model,
        keep: c.keep,
        frames: c.totals.frames,
        chars: c.totals.chars,
        tokens: c.totals.tokens,
        system: c.totals.system,
        tools: c.totals.tools,
        conversation: c.totals.conversation,
        mode: trace.mode,
      });
    }

    // CALLS: tool invocations that appeared since the last look.
    if (toolCalls > prevTools) {
      const all = [];
      trace.calls.forEach((c, ci) => c.frames.forEach((fr, fi) => {
        if (fr.kind === 'tool_call') all.push({ ci, fi, fr });
      }));
      for (const { ci, fi, fr } of all.slice(prevTools)) {
        this.emit('call', {
          session: f.id,
          file: f.file,
          call: ci,
          frame: fi,
          label: fr.label,
          detail: fr.detail,
          chars: fr.chars,
          path: fr.path,
          line: fr.source?.line ?? null,
        });
      }
    }

    if (trace.mode === 'reconstructed' && calls === 0 && !fresh) {
      // A growing transcript with no api-request records still deserves a
      // heartbeat, or a cli-entrypoint session looks like nothing is happening.
      this.emit('grew', { session: f.id, file: f.file, bytes: f.size, mode: trace.mode });
    }
  }

  since(n) {
    const from = Number(n) || 0;
    return this.events.filter((e) => e.seq > from);
  }

  status() {
    return {
      cwd: this.cwd,
      dir: this.dir,
      watching: !!this.timer,
      files: this.seen.size,
      active: this.active,
      seq: this.seq,
      pollMs: this.pollMs,
    };
  }
}
