// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// agents.mjs — which agent read what.
//
// A session is not one context. Every Agent tool call starts a subagent with a
// context of its own, written to its own transcript:
//
//   <project>/<session>.jsonl                         the main agent
//   <project>/<session>/subagents/agent-<id>.jsonl    each subagent
//   <project>/<session>/subagents/agent-<id>.meta.json
//       { agentType, description, toolUseId, spawnDepth, model, isFork }
//
// A FORK also inherits the parent's conversation: its first record is
//   { type: "fork-context-ref", parentSessionId, parentLastUuid, contextLength }
// so every parent message up to parentLastUuid was in the fork's context too,
// without appearing in the fork's own file. A reader that only searched the
// fork's transcript would say the fork never saw them, which is false.
//
// Measured: 1,296 subagent transcripts on the machine this was written on.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { readTranscript } from './transcript.mjs';
import { traceFlow } from './flow.mjs';

export function subagentDir(sessionFile) {
  const id = basename(sessionFile).replace(/\.jsonl$/i, '');
  return join(dirname(sessionFile), id, 'subagents');
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function firstRecord(file) {
  try {
    const head = readFileSync(file, 'utf8').slice(0, 8192).split('\n')[0];
    return JSON.parse(head);
  } catch {
    return null;
  }
}

// Locate the parent line a uuid or a tool_use id lives on, so a subagent can be
// placed in the parent's timeline.
function indexParent(records) {
  const byUuid = new Map();
  const byToolUse = new Map();
  for (const r of records) {
    const o = r.obj;
    if (!o) continue;
    if (o.uuid) byUuid.set(o.uuid, r.line);
    const parts = o.message?.content;
    if (Array.isArray(parts)) {
      for (const p of parts) if (p?.type === 'tool_use' && p.id) byToolUse.set(p.id, r.line);
    }
  }
  return { byUuid, byToolUse };
}

export function listAgents(sessionFile, { parentRecords = null } = {}) {
  const agents = [{
    id: 'main',
    label: 'main agent',
    file: sessionFile,
    kind: 'main',
    bytes: existsSync(sessionFile) ? statSync(sessionFile).size : 0,
  }];
  const dir = subagentDir(sessionFile);
  if (!existsSync(dir)) return agents;

  const parent = parentRecords || readTranscript(sessionFile);
  const { byUuid, byToolUse } = indexParent(parent);

  for (const f of readdirSync(dir).filter((x) => /^agent-.*\.jsonl$/.test(x)).sort()) {
    const file = join(dir, f);
    const id = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const meta = readJson(join(dir, `agent-${id}.meta.json`)) || {};
    const first = firstRecord(file);
    const fork = first?.type === 'fork-context-ref' ? first : null;
    agents.push({
      id,
      label: meta.description || `agent ${id.slice(0, 8)}`,
      file,
      kind: meta.isFork || fork ? 'fork' : (meta.agentType || 'subagent'),
      agentType: meta.agentType || null,
      model: meta.model || null,
      spawnDepth: meta.spawnDepth ?? null,
      toolUseId: meta.toolUseId || null,
      // where in the parent it was started, and how much parent context it saw
      spawnLine: meta.toolUseId ? byToolUse.get(meta.toolUseId) ?? null : null,
      inheritsThroughLine: fork?.parentLastUuid ? byUuid.get(fork.parentLastUuid) ?? null : null,
      inheritedMessages: fork?.contextLength ?? null,
      bytes: statSync(file).size,
      mtime: statSync(file).mtime.toISOString(),
    });
  }
  return agents;
}

// Traces are cached by file identity: the reader runs on every click and a
// subagent transcript is often a megabyte.
const cache = new Map();
export function traceAgent(agent, ratio = 4) {
  const st = statSync(agent.file);
  const key = `${agent.file}|${st.size}|${st.mtimeMs}|${ratio}`;
  if (cache.has(key)) return cache.get(key);
  const records = readTranscript(agent.file);
  const trace = traceFlow(records, ratio);
  if (cache.size > 24) cache.delete(cache.keys().next().value);
  cache.set(key, trace);
  return trace;
}

// readersOf: for a piece of text (and optionally the parent line it lives on),
// every agent that had it in context, and on which calls.
//
//   seen      the text is in a frame of that agent's own trace
//   inherited a fork whose inherited range covers the line the text is on
export function readersOf(agents, needle, { line = null, ratio = 4, minLen = 12 } = {}) {
  const text = String(needle || '');
  const probe = text.length > 400 ? text.slice(0, 400) : text;
  if (probe.length < minLen) return { needle: probe, readers: [], note: `needle shorter than ${minLen} chars is too common to attribute` };
  const readers = [];
  for (const a of agents) {
    let trace;
    try { trace = traceAgent(a, ratio); } catch (err) {
      readers.push({ agent: a.id, label: a.label, kind: a.kind, error: err.message });
      continue;
    }
    const calls = [];
    trace.calls.forEach((c, ci) => {
      if (c.frames.some((f) => f.text && f.text.includes(probe))) calls.push(ci);
    });
    const inherited = a.kind === 'fork' && line != null && a.inheritsThroughLine != null && line <= a.inheritsThroughLine;
    if (calls.length || inherited) {
      readers.push({
        agent: a.id,
        label: a.label,
        kind: a.kind,
        mode: trace.mode,
        calls,
        firstCall: calls.length ? calls[0] : null,
        callCount: trace.calls.length,
        inherited,
      });
    }
  }
  return { needle: probe, readers };
}
