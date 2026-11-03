// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// transcript.mjs — read a Claude Code session file and group it the way the
// API actually sees it.
//
// A transcript is NOT a conversation. It is a conversation plus bookkeeping:
// api-request, api-request-shape, api-request-blob, attachment, last-prompt,
// queue-operation, cost-state, mode, tools-used, atis-latch. Only some records
// are chain nodes (they carry a uuid and a parentUuid); the rest are sidecars,
// several of which hold a SECOND copy of text that is also in the chain.
//
// Everything downstream of this file depends on that distinction, so it is made
// here once rather than re-guessed per feature.

import { readFileSync } from 'node:fs';

// Records that carry conversation text the model was shown.
export const CONVERSATION_TYPES = new Set(['user', 'assistant', 'system']);

export function readTranscript(file) {
  const raw = readFileSync(file, 'utf8').split(/\r?\n/);
  const records = [];
  raw.forEach((line, i) => {
    if (!line.trim()) return;
    let obj = null;
    let error = null;
    try {
      obj = JSON.parse(line);
    } catch (err) {
      error = err.message;
    }
    records.push({ line: i + 1, raw: line, obj, error, bytes: line.length });
  });
  return records;
}

export function summarise(records) {
  const byType = new Map();
  let bytes = 0;
  let chainNodes = 0;
  for (const r of records) {
    bytes += r.bytes;
    const t = r.obj?.type ?? (r.error ? 'UNPARSEABLE' : 'unknown');
    byType.set(t, (byType.get(t) || 0) + 1);
    if (r.obj?.uuid) chainNodes++;
  }
  return {
    lines: records.length,
    bytes,
    chainNodes,
    types: [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count })),
  };
}

// textOf pulls every string the model would have read out of one record, in
// order, with the JSON path that addresses it. The path matters: it is how the
// IDE highlights a frame back in the tree, and how an edit is written back.
export function textOf(obj) {
  const out = [];
  const content = obj?.message?.content;
  if (typeof content === 'string') {
    out.push({ path: ['message', 'content'], kind: 'text', text: content });
    return out;
  }
  if (!Array.isArray(content)) return out;
  content.forEach((part, i) => {
    const base = ['message', 'content', i];
    if (part == null) return;
    if (typeof part === 'string') {
      out.push({ path: base, kind: 'text', text: part });
      return;
    }
    if (part.type === 'text' && typeof part.text === 'string') {
      out.push({ path: [...base, 'text'], kind: 'text', text: part.text });
    } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
      out.push({ path: [...base, 'thinking'], kind: 'thinking', text: part.thinking });
    } else if (part.type === 'tool_use') {
      out.push({
        path: [...base, 'input'],
        kind: 'tool_use',
        tool: part.name,
        json: true,
        text: JSON.stringify(part.input ?? {}, null, 2),
      });
    } else if (part.type === 'tool_result') {
      const c = part.content;
      if (typeof c === 'string') {
        out.push({ path: [...base, 'content'], kind: 'tool_result', text: c });
      } else if (Array.isArray(c)) {
        c.forEach((sub, j) => {
          if (sub && sub.type === 'text' && typeof sub.text === 'string') {
            out.push({ path: [...base, 'content', j, 'text'], kind: 'tool_result', text: sub.text });
          }
        });
      }
    }
  });
  return out;
}

// chainMessages merges the records into the message list an API request is
// built from. Consecutive records of the same role are ONE message with
// several content parts -- an assistant turn that says something and then
// calls a tool is a single message, and so is the tool_result plus the text
// that follows it. Getting this wrong makes every frame index off by one.
export function chainMessages(records) {
  const msgs = [];
  let boundary = false;
  for (const r of records) {
    const o = r.obj;
    if (!o) continue;
    // ⛔ An api-request ENDS a message. Two user records on either side of one
    // are two turns, not one merged message -- MEASURED on a 195-line session
    // where user records at L51 and L60 sit around a request and merging them
    // made 7 chain messages resolve as 3, so two turns went missing from the
    // reconstruction entirely.
    if (o.type === 'api-request') { boundary = true; continue; }
    if (!CONVERSATION_TYPES.has(o.type)) continue;
    if (!o.message) continue;
    const role = o.message.role || o.type;
    const parts = textOf(o);
    if (!parts.length) continue;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role && !boundary) {
      last.parts.push(...parts.map((p) => ({ ...p, line: r.line })));
      last.lines.push(r.line);
    } else {
      msgs.push({ role, parts: parts.map((p) => ({ ...p, line: r.line })), lines: [r.line] });
    }
    boundary = false;
  }
  return msgs;
}

export const chars = (s) => (typeof s === 'string' ? s.length : 0);
