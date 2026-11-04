// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// brainstorm-live — Claude Code's own engine events, mirrored to brainstorm
// while they happen.
//
// The transcript gets a block when the block is COMPLETE, so a minute of
// thinking shows nothing until it ends. These hooks sit inside the engine:
//
//   turn.start     the prompt a turn begins with
//   turn.step      each model request: sent (model, how many messages), its
//                  first chunk, every piece of thinking / text / tool
//                  arguments as it streams, and the stop with the usage the
//                  API reported (cache read, cache written, new input, output)
//   tool.call      each tool call with its arguments before it runs, and how
//                  it ended
//   turn.complete  how long the turn took and why it ended
//
// Nothing is changed: every chunk is yielded on unchanged and at once, and
// every call goes on to next(e). Events are posted without being awaited, so
// a slow or closed brainstorm never slows claude down; with no brainstorm
// listening they are dropped.
//
// Where to post comes from brainstorm's live file (BRAINSTORM_LIVE names it;
// the session window sets it) and is read again when a post fails: brainstorm can be
// closed and opened on a new port while this claude keeps running, and the
// events find the new one.

import type { Register, EngineInterface } from 'claude-code'

type Ev = { type: string } & Record<string, unknown>

// The longest string one event carries; the transcript has the rest.
const CLIP = 4000

const clip = (v: unknown): unknown => {
  if (typeof v === 'string') return v.length > CLIP ? `${v.slice(0, CLIP)}… [${v.length} chars]` : v
  if (Array.isArray(v)) return v.map(clip)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)]))
  return v
}

// Module state. A reload of the module starts it over, which is right: the
// file is read again and the queue was best effort anyway.
let livePath: string | undefined
let base: string | undefined
let baseAt = 0
let sessionId = ''
let queue: Ev[] = []
let flushing = false
let seq = 0

async function target($: EngineInterface): Promise<string | undefined> {
  if (!livePath) return undefined
  if (base && Date.now() - baseAt < 10000) return base
  baseAt = Date.now()
  try {
    const { port } = JSON.parse(String(await $.fs.read(livePath)))
    base = port ? `http://127.0.0.1:${port}` : undefined
  } catch {
    base = undefined
  }
  return base
}

// One post at a time; what arrives meanwhile goes in the next one, so a
// burst of small chunks becomes a few posts, not one each.
async function flush($: EngineInterface) {
  if (flushing) return
  flushing = true
  try {
    while (queue.length) {
      const events = queue
      queue = []
      const url = await target($)
      if (!url) continue
      const r = await $.http
        .fetch(`${url}/api/hook`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, events }),
        })
        .catch(() => null)
      if (!r?.ok) base = undefined // closed or moved: read the file again
    }
  } finally {
    flushing = false
  }
}

function send($: EngineInterface, ev: Ev) {
  if (!livePath) return
  queue.push({ ...ev, seq: ++seq, at: Date.now() })
  void flush($)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    livePath = await $.env.get('BRAINSTORM_LIVE')
    sessionId = await $.session.id().catch(() => '')
    send($, { type: 'session.start', cwd: e.cwd, interactive: e.isInteractive })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // a /resume or /clear moves the id; read it again at every turn
    sessionId = await $.session.id().catch(() => sessionId)
    send($, { type: 'turn.start', turnId: e.turnId, agentId: e.agentId, text: clip(e.text) })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const step = { turnId: e.turnId, step: e.index, agentId: e.agentId }
    send($, { type: 'step.start', ...step, model: e.model, effort: e.effort, messageCount: e.messageCount })
    const stream = next(e)
    let first = true
    for await (const c of stream) {
      if (first) {
        first = false
        send($, { type: 'step.first', ...step })
      }
      if (c.kind === 'thinking') send($, { type: 'thinking', ...step, block: c.index, text: c.text })
      else if (c.kind === 'text') send($, { type: 'text', ...step, block: c.index, text: c.text })
      else if (c.kind === 'tool') send($, { type: 'tool.begin', ...step, block: c.index, id: c.id, name: c.name })
      else if (c.kind === 'input') send($, { type: 'tool.input', ...step, block: c.index, json: c.json })
      else if (c.kind === 'stop') send($, { type: 'step.stop', ...step, stopReason: c.stopReason, usage: c.usage })
      yield c
    }
    const r = await stream.result
    send($, { type: 'step.end', ...step, stopReason: r.stopReason, usage: r.usage })
    return r
  })

  on('tool.call', async ($, e, next) => {
    // what is left after the envelope is the tool's own arguments
    const { tool, tool_use_id, agentId, requestMeta: _meta, ...args } = e as unknown as
      { tool: string; tool_use_id?: string; agentId?: string; requestMeta?: unknown } & Record<string, unknown>
    send($, { type: 'tool.call', id: tool_use_id, tool, agentId, input: clip(args) })
    const r = await next(e)
    const done = r as { text?: string; isError?: boolean; deny?: string }
    send($, { type: 'tool.done', id: tool_use_id, tool, agentId, isError: !!done.isError, deny: done.deny, text: clip(done.text) })
    return r
  })

  on('turn.complete', async ($, e, next) => {
    send($, { type: 'turn.end', turnId: e.turnId, agentId: e.agentId, reason: e.reason, durationMs: e.durationMs, usage: e.usage })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    send($, { type: 'session.end' })
    await flush($)
    return next(e)
  })
}
