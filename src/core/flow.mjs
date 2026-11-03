// Copyright (c) 2026 buggerlogger. All rights reserved.
// Proprietary and confidential. No license is granted to use, copy, modify or
// distribute this file, in whole or in part. See LICENSE.
//
// flow.mjs — reconstruct, in order, everything that entered the model's
// context on each API call, so it can be stepped through like a debugger.
//
// This is NOT a model of how context "probably" works. Claude Code records the
// request it actually sent:
//
//   api-request-shape  { shapeHash, shape: { system[], tools[] } }
//   api-request-blob   { hash, message }        -- one message, content parts
//   api-request        { shapeHash, keep, tail[], cacheControl[] }
//
// `keep` is how many messages were carried over from the previous call (the
// cached prefix) and `tail` lists the hashes appended after them. So the exact
// message list for call N is:
//
//   messages(N) = messages(N-1).slice(0, keep) ++ tail.map(resolve)
//
// Some hashes have an api-request-blob (the injected system-reminder bundles);
// the rest are ordinary chain messages, which are resolved POSITIONALLY in
// chain order. Every frame says which of the two it was, and a request whose
// tail cannot be fully resolved is reported as degraded rather than guessed at.

import { chainMessages, chars } from './transcript.mjs';

const FALLBACK_RATIO = 4.0;

export function indexRequests(records) {
  const shapes = new Map();
  const blobs = new Map();
  const requests = [];
  for (const r of records) {
    const o = r.obj;
    if (!o) continue;
    if (o.type === 'api-request-shape' && o.shapeHash) shapes.set(o.shapeHash, { line: r.line, shape: o.shape || {} });
    else if (o.type === 'api-request-blob' && o.hash) blobs.set(o.hash, { line: r.line, message: o.message || {} });
    else if (o.type === 'api-request') requests.push({ line: r.line, obj: o });
  }
  return { shapes, blobs, requests };
}

// cacheMarks turns cacheControl paths into a lookup keyed the way frames are
// addressed, so a breakpoint shows up ON the frame it applies to.
function cacheMarks(cacheControl) {
  const marks = new Map();
  for (const c of cacheControl || []) {
    if (!Array.isArray(c.path)) continue;
    marks.set(c.path.join('.'), c.value || { type: 'ephemeral' });
  }
  return marks;
}

function frame(f) {
  return {
    kind: f.kind,
    label: f.label,
    detail: f.detail || '',
    chars: f.chars || 0,
    tokens: 0,
    text: f.text || '',
    source: f.source || null,      // { line } in the transcript, when known
    resolved: f.resolved || 'exact',
    cache: f.cache || null,
    path: f.path || '',
  };
}

// MEASURED on this machine: 39 of 189 transcripts carry api-request-shape.
// The other 150 (every `cli` entrypoint session) record no request data at
// all, so an exact-only debugger would be dead on 79% of real sessions. When
// the records are absent the flow is RECONSTRUCTED from the message chain and
// says so in `mode` -- the system prompt and tool definitions are genuinely
// unknown there, and are reported as unknown rather than invented.
export function traceFlow(records, charsPerToken = FALLBACK_RATIO) {
  const { shapes, blobs, requests } = indexRequests(records);
  const chain = chainMessages(records);
  const ratio = charsPerToken > 0 ? charsPerToken : FALLBACK_RATIO;

  if (!requests.length) return reconstructFlow(chain, ratio);

  let chainPtr = 0;          // next unconsumed chain message
  let prevList = [];         // resolved message list of the previous request
  const calls = [];
  let consumedTotal = 0;     // chain messages the resolver has claimed

  // ⛔ A hash identifies CONTENT, so the same hash in two tails is the same
  // message re-sent, not a new one. Resolving it twice consumed two chain
  // messages for one message and starved every later lookup. MEASURED over
  // 3,566 calls: that produced 21,286 unresolved frames, 99% of them in one
  // 341-call session whose non-blob tails (1,101) far outnumbered its chain
  // messages (806). Resolve once, then reuse.
  const seen = new Map();

  for (const req of requests) {
    const o = req.obj;
    const marks = cacheMarks(o.cacheControl);
    const shapeEntry = o.shapeHash ? shapes.get(o.shapeHash) : null;
    const shape = shapeEntry?.shape || {};
    const frames = [];
    const problems = [];

    // --- system prompt blocks -------------------------------------------------
    (shape.system || []).forEach((s, i) => {
      const path = `system.${i}`;
      frames.push(frame({
        kind: 'system',
        label: `system[${i}]`,
        detail: firstLine(s.text),
        chars: chars(s.text),
        text: s.text || '',
        source: shapeEntry ? { line: shapeEntry.line } : null,
        cache: marks.get(path) || null,
        path,
      }));
    });

    // --- tool definitions ----------------------------------------------------
    // One frame per tool: they are a large, usually invisible slice of the
    // window, and seeing them in the flow is the point of the flow.
    (shape.tools || []).forEach((t, i) => {
      const body = `${t.name}\n${t.description || ''}\n${JSON.stringify(t.input_schema || t.parameters || {})}`;
      frames.push(frame({
        kind: 'tool',
        label: `tool: ${t.name}`,
        detail: `${chars(t.description)} ch description`,
        chars: chars(body),
        text: body,
        source: shapeEntry ? { line: shapeEntry.line } : null,
        cache: marks.get(`tools.${i}`) || null,
        path: `tools.${i}`,
      }));
    });

    // --- messages ------------------------------------------------------------
    const keep = Number.isInteger(o.keep) ? o.keep : 0;
    const list = prevList.slice(0, keep);
    for (const h of o.tail || []) {
      const already = seen.get(h);
      if (already) { list.push(already); continue; }
      const blob = blobs.get(h);
      if (blob) {
        // ⛔ A blob can BE a chain message. The first user turn is stored as a
        // blob because the client prepends system-reminders to it, and the
        // same text is also an ordinary `user` record. If the blob does not
        // consume the chain pointer, every later positional match is off by
        // one: MEASURED on a 2-call session, the prompt appeared twice as
        // messages[0] and messages[2] and the tool_result message vanished.
        const consumed = blobConsumesChain(blob.message, chain[chainPtr]);
        if (consumed) { chainPtr++; consumedTotal++; }
        const entry = {
          hash: h,
          message: blob.message,
          source: { line: blob.line },
          resolved: consumed ? 'blob+chain' : 'blob',
        };
        seen.set(h, entry);
        list.push(entry);
        continue;
      }
      const cm = chain[chainPtr];
      if (cm) {
        chainPtr++;
        consumedTotal++;
        const entry = { hash: h, chainMessage: cm, source: { line: cm.lines[0] }, resolved: 'positional' };
        seen.set(h, entry);
        list.push(entry);
      } else {
        problems.push(`tail hash ${h.slice(0, 12)} has no blob and no chain message left to match`);
        list.push({ hash: h, resolved: 'unresolved' });
      }
    }

    list.forEach((m, mi) => {
      if (m.resolved === 'unresolved') {
        frames.push(frame({
          kind: 'message',
          label: `messages[${mi}] UNRESOLVED`,
          detail: m.hash.slice(0, 12),
          resolved: 'unresolved',
          path: `messages.${mi}`,
        }));
        return;
      }
      const parts = m.blobParts || partsOf(m);
      const role = m.chainMessage?.role || m.message?.role || 'unknown';
      parts.forEach((p, pi) => {
        const path = `messages.${mi}.content.${pi}`;
        frames.push(frame({
          kind: p.kind === 'tool_use' ? 'tool_call' : p.kind === 'tool_result' ? 'tool_result' : 'message',
          label: `messages[${mi}].${role} ${p.kind}${p.tool ? ` ${p.tool}` : ''}`,
          detail: firstLine(p.text),
          chars: chars(p.text),
          text: p.text || '',
          source: p.line ? { line: p.line } : m.source,
          resolved: m.resolved,
          cache: marks.get(path) || null,
          path,
        }));
      });
      if (!parts.length) {
        frames.push(frame({
          kind: 'message',
          label: `messages[${mi}].${role} (no text)`,
          source: m.source,
          resolved: m.resolved,
          path: `messages.${mi}`,
        }));
      }
    });

    for (const f of frames) f.tokens = Math.round(f.chars / ratio);
    const totalChars = frames.reduce((a, f) => a + f.chars, 0);

    calls.push({
      line: req.line,
      id: o.id || null,
      timestamp: o.timestamp || null,
      model: o.params?.model || null,
      keep,
      tailCount: (o.tail || []).length,
      shapeLine: shapeEntry?.line ?? null,
      frames,
      problems,
      totals: {
        frames: frames.length,
        chars: totalChars,
        tokens: Math.round(totalChars / ratio),
        system: sumKind(frames, 'system'),
        tools: sumKind(frames, 'tool'),
        conversation: totalChars - sumKind(frames, 'system') - sumKind(frames, 'tool'),
      },
    });

    prevList = list;
  }

  // chainConsumed is what the chain-coverage invariant is asserted against:
  // it must equal the number of chain messages recorded BEFORE the last
  // api-request, because anything after it is an OUTPUT, never an input.
  return { mode: 'recorded', why: null, calls, ratio, chainMessages: chain.length, chainConsumed: consumedTotal, chain };
}

// reconstructFlow: the fallback for a transcript with no api-request records.
//
// One call, representing the context a resume would send: every chain message
// in order, one frame per content part. What is NOT here is stated plainly --
// the system prompt and the tool definitions were never written to the file,
// and on the session measured above those were 10,400 and 41,761 chars, so
// pretending the total is complete would understate the window by ~52K chars.
function reconstructFlow(chain, ratio) {
  const frames = [];
  frames.push(frame({
    kind: 'unknown',
    label: 'system prompt + tool definitions NOT RECORDED',
    detail: 'this transcript has no api-request-shape; on a comparable session these were ~52K chars',
    resolved: 'unknown',
    path: 'system',
  }));
  chain.forEach((m, mi) => {
    m.parts.forEach((p, pi) => {
      frames.push(frame({
        kind: p.kind === 'tool_use' ? 'tool_call' : p.kind === 'tool_result' ? 'tool_result' : 'message',
        label: `messages[${mi}].${m.role} ${p.kind}${p.tool ? ` ${p.tool}` : ''}`,
        detail: firstLine(p.text),
        chars: chars(p.text),
        text: p.text || '',
        source: { line: p.line ?? m.lines[0] },
        resolved: 'reconstructed',
        path: `messages.${mi}.content.${pi}`,
      }));
    });
  });
  for (const f of frames) f.tokens = Math.round(f.chars / ratio);
  const totalChars = frames.reduce((a, f) => a + f.chars, 0);
  return {
    mode: 'reconstructed',
    why: 'no api-request records in this transcript; frames are the message chain only, and the system prompt and tool definitions are unknown',
    ratio,
    chainMessages: chain.length,
    chainConsumed: chain.length,
    chain,
    calls: [{
      line: chain[0]?.lines?.[0] ?? 1,
      id: null,
      timestamp: null,
      model: null,
      keep: 0,
      tailCount: chain.length,
      shapeLine: null,
      frames,
      problems: [],
      totals: {
        frames: frames.length,
        chars: totalChars,
        tokens: Math.round(totalChars / ratio),
        system: 0,
        tools: 0,
        conversation: totalChars,
      },
    }],
  };
}

// blobConsumesChain: is this stored blob the API-shaped version of the next
// chain message? True when the roles agree and every text the chain message
// carries is present in the blob -- the blob may carry MORE (the injected
// system-reminders), which is exactly why it was stored separately.
//
// Deliberately conservative: a short coincidental substring must not consume a
// chain message, so the chain side has to contribute real text.
const MIN_CHAIN_MATCH = 8;

export function blobConsumesChain(blobMessage, chainMsg) {
  if (!blobMessage || !chainMsg) return false;
  if ((blobMessage.role || '') !== chainMsg.role) return false;
  const want = chainMsg.parts.map((p) => p.text).filter((t) => typeof t === 'string' && t.length);
  if (!want.length) return false;
  if (want.reduce((a, t) => a + t.length, 0) < MIN_CHAIN_MATCH) return false;
  const have = partsOf({ message: blobMessage }).map((p) => p.text).filter(Boolean);
  return want.every((w) => have.some((h) => h === w || h.includes(w)));
}

function partsOf(m) {
  if (m.chainMessage) return m.chainMessage.parts;
  const content = m.message?.content;
  if (typeof content === 'string') return [{ kind: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((p) => {
    if (p == null) return { kind: 'text', text: '' };
    if (p.type === 'text') return { kind: 'text', text: p.text || '' };
    if (p.type === 'thinking') return { kind: 'thinking', text: p.thinking || '' };
    if (p.type === 'tool_use') return { kind: 'tool_use', tool: p.name, text: JSON.stringify(p.input ?? {}, null, 2) };
    if (p.type === 'tool_result') {
      const c = p.content;
      return { kind: 'tool_result', text: typeof c === 'string' ? c : JSON.stringify(c ?? '') };
    }
    // tool_addition and anything else the client invents later: keep it
    // visible rather than dropping it, with whatever text it carries.
    return { kind: p.type || 'unknown', text: typeof p.text === 'string' ? p.text : JSON.stringify(p) };
  });
}

const sumKind = (frames, kind) => frames.filter((f) => f.kind === kind).reduce((a, f) => a + f.chars, 0);

function firstLine(s) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

// probe answers the question the debugger exists for: "where does this text
// enter my context?" It returns every frame of every call that contains the
// needle, in flow order, so the UI can jump from one to the next until the
// flow is finished.
export function probe(trace, needle, { caseSensitive = false } = {}) {
  if (!needle) return [];
  const hay = (s) => (caseSensitive ? s : s.toLowerCase());
  const n = hay(needle);
  const hits = [];
  trace.calls.forEach((call, ci) => {
    call.frames.forEach((f, fi) => {
      if (!f.text) return;
      const text = hay(f.text);
      let at = text.indexOf(n);
      let count = 0;
      while (at >= 0) {
        count++;
        at = text.indexOf(n, at + n.length);
      }
      if (!count) return;
      const first = text.indexOf(n);
      hits.push({
        call: ci,
        callLine: call.line,
        frame: fi,
        kind: f.kind,
        label: f.label,
        path: f.path,
        occurrences: count,
        line: f.source?.line ?? null,
        excerpt: f.text.slice(Math.max(0, first - 60), first + needle.length + 60),
      });
    });
  });
  return hits;
}

// diffFlow compares two traces frame by frame so "what did my edit change in
// the context?" has an answer that is not a guess. Used after a save.
export function diffFlow(before, after) {
  const a = before?.calls ?? [];
  const b = after?.calls ?? [];
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (!x) { out.push({ call: i, change: 'added', frames: y.totals.frames, chars: y.totals.chars }); continue; }
    if (!y) { out.push({ call: i, change: 'removed', frames: x.totals.frames, chars: x.totals.chars }); continue; }
    const frames = [];
    const m = Math.max(x.frames.length, y.frames.length);
    for (let j = 0; j < m; j++) {
      const fx = x.frames[j];
      const fy = y.frames[j];
      if (!fx) { frames.push({ frame: j, change: 'added', label: fy.label, chars: fy.chars }); continue; }
      if (!fy) { frames.push({ frame: j, change: 'removed', label: fx.label, chars: fx.chars }); continue; }
      if (fx.text !== fy.text) {
        frames.push({ frame: j, change: 'edited', label: fy.label, charsBefore: fx.chars, charsAfter: fy.chars });
      }
    }
    if (frames.length || x.totals.chars !== y.totals.chars) {
      out.push({
        call: i,
        change: 'changed',
        charsBefore: x.totals.chars,
        charsAfter: y.totals.chars,
        tokensBefore: x.totals.tokens,
        tokensAfter: y.totals.tokens,
        frames,
      });
    }
  }
  return out;
}
