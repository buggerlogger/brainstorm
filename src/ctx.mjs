#!/usr/bin/env node
// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
//
// ctx — unpack a Claude Code session into editable text, change it, and build a
// session that resumes with your changes.
//
//   node ctx.mjs list [--cwd <dir>] [--all]
//   node ctx.mjs extract --session <uuid|path> [--dir <out>]
//   node ctx.mjs status  [--dir <out>] [--top N]
//   node ctx.mjs build   [--dir <out>] [--out <file>] [--install] [--new-id <uuid>]
//                        [--rename old=new ...] [--no-sync-mirrors]
//   node ctx.mjs verify  --file <built.jsonl>
//   node ctx.mjs ui      [--dir <out>] [--port 7777]
//
// WHY THIS REPLACED ctx-tool.mjs
//
// Four defects, each MEASURED on a 53-line throwaway session rather than
// reasoned about:
//
//  1. EDITS WERE INCOMPLETE. Editing a user message rewrote the `user` record
//     and left the same text in `attachment` (x4), `last-prompt` (x4) and
//     `queue-operation` (x1). It happened to work because resume reads the
//     message chain -- but `attachment` records carry system-reminder payloads
//     that DO re-enter context, so the old text was one step from coming back.
//     Fixed by construction here: every text-bearing record is a block, so
//     there is nowhere for a stale copy to hide.
//
//  2. --install-to DOUBLE-ENCODED THE PATH. Given a projects directory it
//     produced C--Users-ASOO-.claude-projects-C--Users-... and installed into a
//     folder Claude Code will never look in. It wants a CWD. Here the flag is
//     --install, the cwd comes from the session's own record, and the derived
//     path is printed and checked before anything is written.
//
//  3. THE ORIGINAL SESSION WAS HARDCODED. On a session with no compaction at
//     all it still announced "base compaction summary at Lnull", claimed
//     "L6851..6877 hold errors" (line numbers from a 6,877-line transcript that
//     has nothing to do with the input) and wrote 3,267 bytes of unrelated
//     findings into 02_HANDOVER_ADDENDUM.md. Nothing in this file knows about
//     any particular session.
//
//  4. TOKENS WERE GUESSED. A hardcoded 3.8 chars/token understated every
//     estimate by ~51%: the transcript records real usage, and measuring the
//     slope between two of those records gave 4.98 for that session. (An
//     earlier 2.52 was wrong three ways: it billed each turn its own output,
//     counted the api-request-blob duplicate, and used endpoints not a
//     median. It is now a median over well-separated pairs.) The ratio
//     is per-session -- dense tool JSON tokenises far worse than prose -- so it
//     is measured per transcript, and the intercept gives the irreducible
//     system+tools floor.
//
//  5. A TOOL EDIT SYNCED NOTHING. Measured by swapping a loaded Skill: editing
//     the Skill tool_use from alpha-protocol to omega-protocol and rebuilding
//     printed "mirrors synced 9" while SIX copies of the old skill survived in
//     the file -- wireToolInputs, toolUseResult.commandName, attributionSkill,
//     and a Stop hook that had quoted the first ~150 chars of the turn. The
//     cause was one line asserting "a tool input appears nowhere else". Tool
//     inputs now mirror by leaf value into TOOL_MIRROR_KEYS, build re-reads the
//     artefact and REPORTS whatever it could not reach, and --rename handles
//     the derived and truncated copies no structural rule can.

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync,
} from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not hand-stripping the url: on Windows import.meta.url is
// file:///C:/... and a manual slice leaves a leading slash that fails to open.
//
// Inside brainstorm.exe the engine is bundled, import.meta.url is gone and
// there is no source file to read -- selfPath() is then null, and every caller
// has a packaged-mode branch rather than crashing at --help.
const selfPath = () => {
  try { return import.meta && import.meta.url ? fileURLToPath(import.meta.url) : null; } catch { return null; }
};

const PROJECTS = join(homedir(), '.claude', 'projects');
const argv = process.argv.slice(2);
const cmd = argv[0];

function opt(name, dflt = null) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const has = (name) => argv.includes(`--${name}`);

function die(msg, code = 2) {
  console.error(`ctx: ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// project key
// ---------------------------------------------------------------------------

// Claude Code names a project folder after the cwd with every separator
// flattened to a dash.
//
// ⛔ VERIFIED against two real folders rather than guessed, because getting it
// wrong installs a session somewhere nothing will ever read:
//
//   C:\Users\ASOO\Desktop\my-work\ctf challenge
//     -> C--Users-ASOO-Desktop-my-work-ctf-challenge        (space becomes -)
//   C:\Users\ASOO\AppData\Local\Temp\claude\...\scratchpad\ctxtest
//     -> C--Users-ASOO-AppData-Local-Temp-claude-...-scratchpad-ctxtest
//
// Dots survive (`.claude` stays `.claude`) and existing dashes survive, so the
// rule is: anything outside [A-Za-z0-9._-] becomes a dash.
export function projectKeyForCwd(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9._-]/g, '-');
}

function projectDirForCwd(cwd) {
  return join(PROJECTS, projectKeyForCwd(cwd));
}

// ---------------------------------------------------------------------------
// transcript io
// ---------------------------------------------------------------------------

function readJsonl(file) {
  const out = [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    try {
      out.push({ lineNo: i + 1, obj: JSON.parse(raw), raw });
    } catch {
      // A malformed line is kept verbatim so a build never silently drops it.
      out.push({ lineNo: i + 1, obj: null, raw });
    }
  }
  return out;
}

function resolveSession(input) {
  if (!input) die('--session is required (a uuid or a path to a .jsonl)');
  if (input.endsWith('.jsonl')) {
    const p = resolve(input);
    if (!existsSync(p)) die(`no such file: ${p}`);
    return p;
  }
  // A bare uuid: search every project for it.
  //
  // ⛔ COLLECT EVERY MATCH, DO NOT RETURN THE FIRST.
  //
  // The same session id can exist under more than one project key -- resuming
  // a session from a different cwd writes a second copy, and that is exactly
  // what happened while testing this tool: one id, two folders, differing
  // content. Returning the first match resolves the ambiguity BY DIRECTORY
  // ORDER, so the tool silently edits a copy the user was not looking at and
  // every later number describes the wrong file. Ambiguity has to be the
  // user's to settle, so this lists the candidates and stops.
  if (!existsSync(PROJECTS)) die(`no projects directory at ${PROJECTS}`);
  const hits = [];
  for (const proj of readdirSync(PROJECTS)) {
    const p = join(PROJECTS, proj, `${input}.jsonl`);
    if (existsSync(p)) hits.push(p);
  }
  if (hits.length === 1) return hits[0];
  if (!hits.length) die(`session ${input} not found under ${PROJECTS}`);

  const rows = hits
    .map((p) => {
      const st = statSync(p);
      return { p, size: st.size, mtime: st.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  console.error(`ctx: session ${input} exists in ${hits.length} projects -- pass the full path to pick one:`);
  for (const r of rows) {
    console.error(`  ${r.mtime.toISOString().slice(0, 19)}  ${String(r.size).padStart(10)} B  ${r.p}`);
  }
  console.error(`\n  newest first. Re-run with: --session \"${rows[0].p}\"`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// token calibration
// ---------------------------------------------------------------------------

function usageTokens(o) {
  const u = o?.message?.usage;
  if (!u) return 0;
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
}

function contentChars(o) {
  const c = o?.message?.content;
  if (!c) return 0;
  if (typeof c === 'string') return c.length;
  if (!Array.isArray(c)) return 0;
  let n = 0;
  for (const p of c) {
    if (p?.text) n += p.text.length;
    if (p?.thinking) n += p.thinking.length;
    if (p?.input) n += JSON.stringify(p.input).length;
    if (p?.content) n += typeof p.content === 'string' ? p.content.length : JSON.stringify(p.content).length;
  }
  return n;
}

// Records that are actually SENT to the API as the conversation.
//
// ⛔ THIS SET IS THE WHOLE CORRECTNESS OF THE RATIO. A transcript also
// stores `api-request-blob`, which holds a copy of the entire request payload,
// plus `attachment`, `last-prompt` and `queue-operation` mirrors. Counting
// those inflates the character total two to three fold and the measured ratio
// with it. MEASURED on a 6,877-line session: 10.33 chars/token counting every
// record, 4.99 counting only these three. The first number is an artifact of
// counting the payload twice.
const CONVERSATION_TYPES = new Set(['user', 'assistant', 'system']);

// Measure chars-per-token and the fixed overhead from the transcript's own
// usage records.
//
// Three things this gets right that the obvious version does not:
//
//  1. CHARS ARE COUNTED BEFORE EACH RECORD. The usage on an assistant turn
//     bills the INPUT of that request, which cannot include that turn's own
//     output. Counting the record itself credits ~59k characters to a request
//     that was billed 837 tokens, which is where a 12.25 ratio came from.
//  2. ONLY CONVERSATION RECORDS COUNT -- see CONVERSATION_TYPES.
//  3. THE SLOPE IS A MEDIAN OF WELL-SEPARATED PAIRS, not the two endpoints.
//     Adjacent usage records can share a token count while differing by a few
//     characters, and dividing by that difference produces nonsense.
//
// When the spread is too small to measure -- a short session is mostly fixed
// overhead -- it REFUSES and says so rather than presenting a guess as a
// measurement. A 53-line session has 315 characters of real conversation;
// there is no slope in that, and claiming one would be worse than admitting it.
const FALLBACK_RATIO = 4.0;
const MIN_TOKEN_SPREAD = 200;
const MIN_CHAR_SPREAD = 2000;

export function calibrate(entries, fromLine = 1) {
  let cum = 0;
  const pts = [];
  for (const e of entries) {
    if (!e.obj || e.lineNo < fromLine) continue;
    const t = usageTokens(e.obj);
    if (t > 0) pts.push({ lineNo: e.lineNo, tokens: t, chars: cum });
    if (CONVERSATION_TYPES.has(e.obj.type)) cum += contentChars(e.obj);
  }

  const peak = pts.length ? Math.max(...pts.map((q) => q.tokens)) : 0;
  const peakAt = pts.find((q) => q.tokens === peak);
  const refuse = (why) => ({
    ratio: FALLBACK_RATIO,
    floor: 0,
    measured: false,
    why,
    points: pts.length,
    peak,
    peakLine: peakAt ? peakAt.lineNo : 0,
    convChars: cum,
  });

  if (pts.length < 2) return refuse(`only ${pts.length} usage record(s)`);

  const slopes = [];
  const floors = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dT = pts[j].tokens - pts[i].tokens;
      const dC = pts[j].chars - pts[i].chars;
      if (dT < MIN_TOKEN_SPREAD || dC < MIN_CHAR_SPREAD) continue;
      const r = dC / dT;
      slopes.push(r);
      floors.push(pts[i].tokens - pts[i].chars / r);
    }
  }
  if (!slopes.length) {
    return refuse(`no pair of usage records differs by ${MIN_TOKEN_SPREAD}+ tokens and ${MIN_CHAR_SPREAD}+ chars`);
  }

  const median = (xs) => {
    const v = [...xs].sort((x, y) => x - y);
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  const ratio = median(slopes);
  return {
    ratio,
    floor: Math.max(0, Math.round(median(floors))),
    measured: true,
    points: pts.length,
    pairs: slopes.length,
    peak,
    peakLine: peakAt ? peakAt.lineNo : 0,
    convChars: cum,
  };
}

// ---------------------------------------------------------------------------
// blocks
// ---------------------------------------------------------------------------

// Every editable piece of text in the transcript, in line order.
//
// ⛔ THIS INCLUDES THE AUX RECORDS, and that is the whole point. The previous
// tool extracted only user/assistant message parts, so an edit left the old
// text sitting in `attachment`, `last-prompt` and `queue-operation`. Those are
// addressed here with a `path` describing exactly where the string lives, so
// applying an edit is a write-back to the same place it was read from and
// nothing can be missed.
// ⛔ AUX TEXT IS FOUND BY WALKING, NOT BY GUESSING FIELD NAMES.
//
// The same prompt string is stored in EIGHT different places in a single real
// transcript, measured:
//
//   last-prompt       lastPrompt                      x4
//   attachment        attachment.content              x3
//   attachment        attachment.stdout               x3
//   api-request-blob  message.content[].text          x2
//   queue-operation   content                         x1
//   attachment        rendered[].content              x1
//   user              message.content                 x1
//   assistant         message.content[].text          x1
//
// The first attempt listed field names to look in (content, prompt, text,
// value) and silently missed lastPrompt, attachment.stdout and
// rendered[].content -- which is exactly how the old tool left stale copies
// behind. A deep walk cannot miss a field it has never heard of, so new
// transcript formats keep working.
//
// MIN_AUX_CHARS keeps hashes, uuids and ids out of the block list: a 16-hex
// digest and a 36-char uuid are both below it, and a prompt worth editing is
// not. ID-shaped strings are skipped explicitly as well, because a long base64
// blob is noise in an editor.
const MIN_AUX_CHARS = 40;
const ID_LIKE = /^[0-9a-f]{8,}$|^[0-9a-f-]{32,40}$|^[A-Za-z0-9+/=_-]{60,}$/;

function walkStrings(node, path, out) {
  if (typeof node === 'string') {
    if (node.length >= MIN_AUX_CHARS && !ID_LIKE.test(node)) out.push({ path: [...path], text: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => walkStrings(v, [...path, i], out));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      // Skip the bookkeeping that is never worth editing and would bury the
      // real content: ids, timestamps, versions, digests.
      if (/^(uuid|parentUuid|sessionId|leafUuid|timestamp|version|type|digests?|slug|entrypoint|userType|gitBranch|cwd)$/.test(k)) continue;
      walkStrings(v, [...path, k], out);
    }
  }
}

const pathToString = (p) => p.map((k) => (typeof k === 'number' ? `[${k}]` : k)).join('.').replace(/\.\[/g, '[');

function getByPath(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[k];
  }
  return cur;
}

function setByPath(obj, path, value) {
  if (!path.length) return false;
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur === null || cur === undefined) return false;
    cur = cur[path[i]];
  }
  if (cur === null || cur === undefined) return false;
  cur[path[path.length - 1]] = value;
  return true;
}

// blocksOf returns ONLY the conversation: the parts of user and assistant
// messages. That is what a person edits.
//
// ⛔ THE AUX COPIES ARE DELIBERATELY NOT BLOCKS. Walking every record for
// editable strings is complete but unusable: on a 53-line throwaway session it
// produced 818 blocks, 700 of them `attachment` system-reminders. The old tool
// missed the copies; listing them all drowns the person instead. Neither is an
// editor.
//
// So the person edits the conversation, and build SYNCS the mirrors: any aux
// string containing the original text gets the same substitution. Complete and
// usable, and the count is reported rather than done silently.
function blocksOf(entries) {
  const blocks = [];
  let id = 0;
  const push = (b) => blocks.push({ id: ++id, keep: true, ...b });

  for (const e of entries) {
    const o = e.obj;
    if (!o || !o.uuid || !o.message) continue;
    const role = o.message.role || o.type || '';
    const c = o.message.content;
    if (typeof c === 'string') {
      push({ lineNo: e.lineNo, role, kind: 'text', path: ['message', 'content'], text: c, uuid: o.uuid });
      continue;
    }
    if (!Array.isArray(c)) continue;
    c.forEach((part, pi) => {
      if (!part || typeof part !== 'object') return;
      const base = ['message', 'content', pi];
      if (typeof part.text === 'string') {
        push({ lineNo: e.lineNo, role, kind: 'text', path: [...base, 'text'], text: part.text, uuid: o.uuid });
      } else if (typeof part.thinking === 'string') {
        push({ lineNo: e.lineNo, role, kind: 'thinking', path: [...base, 'thinking'], text: part.thinking, uuid: o.uuid });
      } else if (part.type === 'tool_use') {
        push({
          lineNo: e.lineNo, role, kind: 'tool_use', path: [...base, 'input'],
          text: JSON.stringify(part.input ?? {}, null, 2), json: true,
          toolName: part.name || '', toolId: part.id || '', uuid: o.uuid,
        });
      } else if (part.type === 'tool_result') {
        const isStr = typeof part.content === 'string';
        push({
          lineNo: e.lineNo, role, kind: 'tool_result', path: [...base, 'content'],
          text: isStr ? part.content : JSON.stringify(part.content ?? '', null, 2), json: !isStr,
          toolId: part.tool_use_id || '', uuid: o.uuid,
        });
      }
    });
  }
  return blocks;
}

// The conversation claude actually resumes: from the newest message record,
// back along parentUuid. A rewind leaves the branch it left in the file, and
// a compaction leaves everything before its boundary; neither is sent again.
// MEASURED on a real session: 37 of 360 blocks were on no such path, so
// editing or deleting them changed nothing claude sends.
function activeChainUuids(entries) {
  const byUuid = new Map();
  let leaf = null;
  for (const e of entries) {
    const o = e.obj;
    if (!o?.uuid) continue;
    byUuid.set(o.uuid, o);
    if (o.message && (o.type === 'user' || o.type === 'assistant') && !o.isSidechain) leaf = o;
  }
  const on = new Set();
  for (let o = leaf; o && !on.has(o.uuid); o = o.parentUuid ? byUuid.get(o.parentUuid) : null) on.add(o.uuid);
  return on;
}

// What the API refuses as message content. MEASURED, on a compacted session
// whose summary was cleared: an empty string is "400 messages.0: user
// messages must have non-empty content", and whitespace is "400 text content
// blocks must contain non-whitespace text". Dropping the block instead was
// accepted, and the fact it held was gone.
const isBlank = (v) => typeof v === 'string' && !v.trim();
function blankContent(c) {
  if (typeof c === 'string') return isBlank(c);
  if (Array.isArray(c)) return c.length === 0 || c.every((p) => p && p.type === 'text' && isBlank(p.text ?? ''));
  return false;
}

// syncMirrors applies one edit everywhere the ORIGINAL text also appears
// outside the message chain.
//
// Measured on a real transcript: one prompt string lives in eight places --
// lastPrompt (x4), attachment.content (x3), attachment.stdout (x3),
// api-request-blob message.content[].text (x2), queue-operation.content,
// attachment rendered[].content -- besides the user message itself. Editing
// only the message leaves the rest stale, and `attachment` payloads can
// re-enter context, so a stale copy is one step from coming back.
//
// Substring, not equality: api-request-blob holds the prompt inside a much
// larger payload.
function syncMirrors(obj, oldText, newText, minLen = 8) {
  if (!oldText || oldText === newText || oldText.length < minLen) return 0;
  let n = 0;
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        if (typeof v === 'string') {
          if (v.includes(oldText)) {
            node[i] = v.split(oldText).join(newText);
            n++;
          }
        } else walk(v);
      });
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string') {
          if (v.includes(oldText)) {
            node[k] = v.split(oldText).join(newText);
            n++;
          }
        } else walk(v);
      }
    }
  };
  walk(obj);
  return n;
}

// Fields that carry a SECOND copy of tool traffic. MEASURED: editing a Skill
// tool_use from alpha-protocol to omega-protocol and rebuilding left THREE
// records still naming alpha -- wireToolInputs on the assistant record,
// toolUseResult.commandName on the result record, and attributionSkill on the
// answer. The old comment "a tool input is JSON and appears nowhere else" was
// wrong, and because a tool_use edit pushed no substitution at all, the mirror
// pass never even looked.
//
// Scoped to these keys on purpose. Rewriting the leaf value everywhere would
// also rename the entry in the available-skills system-reminder, which
// legitimately lists every skill ON DISK -- that is an inventory, not a stale
// copy, and rewriting it would print the same name twice.
const TOOL_MIRROR_KEYS = new Set(['wireToolInputs', 'toolUseResult', 'attributionSkill']);

function syncToolMirrors(obj, subs) {
  if (!subs.length) return 0;
  let n = 0;
  const hit = (node, key) => {
    for (const [from, to] of subs) {
      if (typeof node[key] === 'string' && node[key].includes(from)) {
        node[key] = node[key].split(from).join(to);
        n++;
      }
    }
  };
  // Inside a mirror key every string is fair game; outside one, nothing is.
  const deep = (node) => {
    if (Array.isArray(node)) {
      node.forEach((v, k) => (typeof v === 'string' ? hit(node, k) : deep(v)));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) (typeof v === 'string' ? hit(node, k) : deep(v));
  };
  const find = (node) => {
    if (Array.isArray(node)) { node.forEach(find); return; }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (TOOL_MIRROR_KEYS.has(k)) (typeof v === 'string' ? hit(node, k) : deep(v));
      else find(v);
    }
  };
  find(obj);
  return n;
}

// changedLeaves diffs the old and new tool input and returns only the string
// leaves that actually changed. A mirror stores the input re-serialised, so
// matching the whole object as text never matches; matching the leaf does.
function changedLeaves(a, b, minLen = 8, out = []) {
  if (typeof a === 'string' && typeof b === 'string') {
    if (a !== b && a.length >= minLen) out.push([a, b]);
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let k = 0; k < Math.min(a.length, b.length); k++) changedLeaves(a[k], b[k], minLen, out);
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of Object.keys(a)) if (k in b) changedLeaves(a[k], b[k], minLen, out);
  }
  return out;
}

// locate: every JSON path whose string value contains needle.
function locate(node, needle, path = [], out = []) {
  if (typeof node === 'string') {
    if (node.includes(needle)) out.push(path.join('.') || '(root)');
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v, k) => locate(v, needle, path.concat(String(k)), out));
    return out;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) locate(v, needle, path.concat(k), out);
  }
  return out;
}

// residueOf re-reads the BUILT records and reports every surviving copy of
// text an edit was supposed to remove. It is the only check a bug in the
// mirror pass cannot fool, which is exactly how the three misses above were
// caught: build printed "mirrors synced 9" and the file still said ALPHA.
//
// Truncated copies have to be hunted separately. A Stop hook stores roughly
// the first 150 chars of the turn and ends them with "...", so the full text
// can never match -- a prefix, and that prefix in JSON-escaped form, can.
const RESIDUE_PREFIX = 48;

function residueNeedles(pairs) {
  const needles = [];
  const add = (text, how) => {
    if (text && text.length >= 12 && !needles.some((x) => x.text === text)) needles.push({ text, how });
  };
  for (const [from] of pairs) {
    add(from, 'full');
    if (from.length > RESIDUE_PREFIX) {
      const pre = from.slice(0, RESIDUE_PREFIX);
      add(pre, 'prefix');
      add(JSON.stringify(pre).slice(1, -1), 'escaped');
    }
  }
  return needles;
}

function residueOf(builtLines, pairs) {
  const needles = residueNeedles(pairs);
  const found = [];
  builtLines.forEach((line, k) => {
    let o;
    try { o = JSON.parse(line); } catch { return; }
    for (const nd of needles) {
      if (!line.includes(nd.text)) continue;
      for (const where of locate(o, nd.text, [], [])) {
        found.push({ line: k + 1, type: o.type, path: where, how: nd.how, text: nd.text });
      }
    }
  });
  return found;
}

// --rename old=new, repeatable. For the copies no structural rule can reach:
// a derived field, or a hook payload holding a truncated quote. Operator
// declared, applied to every record, and counted -- never silent.
function collectRenames() {
  const out = [];
  for (let k = 0; k < argv.length; k++) {
    if (argv[k] !== '--rename') continue;
    const v = argv[k + 1];
    if (!v || v.startsWith('--') || !v.includes('=')) {
      console.error('ctx: --rename takes old=new (repeatable)');
      process.exit(2);
    }
    const eq = v.indexOf('=');
    out.push([v.slice(0, eq), v.slice(eq + 1)]);
  }
  return out;
}

function residuePolicy(residue, installing) {
  // TODO(human): decide what build does when residue survives.
  //
  // `residue` is an array of { line, type, path, how, text } -- one entry per
  // surviving copy of text an edit was meant to remove. `installing` is true
  // when --install was passed.
  //
  // Return 'ok' to say nothing, 'warn' to print the table and carry on, or
  // 'block' to print it and refuse to install.
  //
  // Worth weighing: residue in a consumed hook's stdout is inert, but residue
  // in an `attachment` record can re-enter context on resume, which is the
  // entire reason this tool exists. Both arrive in the same array.
  return 'warn';
}

// ---------------------------------------------------------------------------
// editable folder
// ---------------------------------------------------------------------------

const BLOCK_RE = /^<!--\s*@B\s+(\{.*\})\s*-->$/;
const SEP = '<!-- @END -->';

function writeEditDir(dir, config, blocks) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CONFIG.json'), JSON.stringify(config, null, 2));

  const out = [];
  out.push('# Editable context');
  out.push('');
  out.push(`Session \`${config.sessionId}\` — ${config.lines} lines, ${blocks.length} editable blocks.`);
  out.push('');
  out.push('Edit the text between the markers. Set `"keep":false` to drop a block.');
  out.push('Do not change `id` or `path` — those address where the text goes back.');
  out.push('');
  out.push('Then: `node ctx.mjs status` to see the cost, `node ctx.mjs build --install` to apply.');
  out.push('');
  out.push('---');
  out.push('');
  for (const b of blocks) {
    const meta = { id: b.id, keep: b.keep, line: b.lineNo, role: b.role, kind: b.kind, path: b.path };
    meta.at = pathToString(b.path);
    if (b.toolName) meta.tool = b.toolName;
    if (b.json) meta.json = true;
    if (b.sent === false) meta.sent = false;
    out.push(`<!-- @B ${JSON.stringify(meta)} -->`);
    out.push(b.text);
    out.push(SEP);
    out.push('');
  }
  writeFileSync(join(dir, 'BLOCKS.md'), out.join('\n'));
}

function readEditDir(dir) {
  const cfgPath = join(dir, 'CONFIG.json');
  if (!existsSync(cfgPath)) die(`no CONFIG.json in ${dir} — run extract first`);
  const config = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const mdPath = join(dir, 'BLOCKS.md');
  if (!existsSync(mdPath)) die(`no BLOCKS.md in ${dir}`);

  const lines = readFileSync(mdPath, 'utf8').split(/\r?\n/);
  const blocks = [];
  let meta = null;
  let buf = [];
  for (const line of lines) {
    const m = line.match(BLOCK_RE);
    if (m) {
      try {
        meta = JSON.parse(m[1]);
      } catch {
        meta = null;
      }
      buf = [];
      continue;
    }
    if (meta && line.trim() === SEP) {
      // Trailing blank lines are an artefact of the file format, not content.
      while (buf.length && buf[buf.length - 1] === '') buf.pop();
      blocks.push({ ...meta, text: buf.join('\n') });
      meta = null;
      buf = [];
      continue;
    }
    if (meta) buf.push(line);
  }
  return { config, blocks };
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

function cmdList() {
  const all = has('all');
  const cwd = opt('cwd', process.cwd());
  const dirs = all
    ? readdirSync(PROJECTS).map((d) => join(PROJECTS, d))
    : [projectDirForCwd(cwd)];

  let found = 0;
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    const files = readdirSync(d).filter((f) => f.endsWith('.jsonl'));
    if (!files.length) continue;
    console.log(`\n${basename(d)}`);
    const rows = files.map((f) => {
      const p = join(d, f);
      const st = statSync(p);
      return { f, p, size: st.size, mtime: st.mtime };
    }).sort((a, b) => b.mtime - a.mtime);
    for (const r of rows.slice(0, all ? 5 : 40)) {
      found++;
      console.log(`  ${r.f.replace('.jsonl', '')}  ${(r.size / 1024).toFixed(0).padStart(7)} KB  ${r.mtime.toISOString().slice(0, 16).replace('T', ' ')}`);
    }
  }
  if (!found) {
    console.log(`\nno sessions for cwd ${cwd}`);
    console.log(`  expected project dir: ${projectDirForCwd(cwd)}`);
    console.log('  try --all');
  }
  console.log('');
}

function cmdExtract() {
  const src = resolveSession(opt('session'));
  const entries = readJsonl(src);
  const chainEntries = entries.filter((e) => e.obj?.uuid && e.obj?.message);
  if (!chainEntries.length) die(`${src} has no conversation records`);

  // Everything about the session comes FROM the session. Nothing is assumed.
  const first = chainEntries[0].obj;
  const last = chainEntries[chainEntries.length - 1].obj;
  const cal = calibrate(entries);
  const blocks = blocksOf(entries);
  const onChain = activeChainUuids(entries);
  for (const b of blocks) if (!onChain.has(b.uuid)) b.sent = false;

  // A compaction boundary is a `summary`/`system` record that actually exists;
  // sessions often have none, and inventing one injects a summary that was
  // never there.
  const compactions = entries
    .filter((e) => e.obj && (e.obj.type === 'summary' || (e.obj.type === 'system' && !e.obj.parentUuid)))
    .map((e) => e.lineNo);

  const config = {
    source: src,
    sessionId: last.sessionId || first.sessionId || basename(src, '.jsonl'),
    cwd: last.cwd || first.cwd || '',
    gitBranch: last.gitBranch || first.gitBranch || '',
    version: last.version || first.version || '',
    lines: entries.length,
    chainRecords: chainEntries.length,
    blocks: blocks.length,
    compactionLines: compactions,
    tokens: {
      measured: cal.measured,
      charsPerToken: Number(cal.ratio.toFixed(3)),
      why: cal.why || null,
      fixedFloor: cal.floor,
      usageRecords: cal.points,
      peak: cal.peak,
      peakLine: cal.peakLine || null,
    },
    extractedAt: new Date().toISOString(),
  };

  const dir = resolve(opt('dir', join(dirname(src), `${config.sessionId}.ctx`)));
  writeEditDir(dir, config, blocks);

  console.log('\nctx extract');
  console.log(`  source     ${src}`);
  console.log(`  session    ${config.sessionId}`);
  console.log(`  cwd        ${config.cwd || '(not recorded)'}`);
  console.log(`  lines      ${config.lines} (${config.chainRecords} conversation records)`);
  console.log(`  blocks     ${blocks.length} editable`);
  console.log(`  compaction ${compactions.length ? `${compactions.length} boundary(ies) at L${compactions.join(', L')}` : 'none in this session'}`);
  if (cal.measured) {
    console.log(`  tokens     ${cal.ratio.toFixed(2)} chars/token measured from ${cal.pairs.toLocaleString()} well-separated pairs of ${cal.points} usage records`);
    console.log(`             floor ~${cal.floor.toLocaleString()} tokens of system prompt + tool definitions (irreducible)`);
  } else {
    console.log(`  tokens     NOT measurable -- ${cal.why}`);
    console.log(`             estimates fall back to ${FALLBACK_RATIO.toFixed(2)} chars/token; treat them as rough`);
  }
  console.log(`  -> ${dir}`);
  console.log(`     CONFIG.json, BLOCKS.md`);
  console.log('');
}

function blockCosts(blocks, ratio) {
  let kept = 0;
  const byKind = {};
  for (const b of blocks) {
    const n = (b.text || '').length;
    if (!b.keep) continue;
    kept += n;
    byKind[b.kind] = (byKind[b.kind] || 0) + n;
  }
  return { kept, byKind, tokens: Math.round(kept / ratio) };
}

function cmdStatus(quiet = false) {
  const dir = resolve(opt('dir', '.'));
  const { config, blocks } = readEditDir(dir);
  const ratio = config.tokens?.charsPerToken || FALLBACK_RATIO;
  const floor = config.tokens?.fixedFloor || 0;
  const { kept, byKind, tokens } = blockCosts(blocks, ratio);
  const dropped = blocks.filter((b) => !b.keep).length;
  const projected = tokens + floor;

  if (quiet) return { config, blocks, ratio, floor, kept, tokens, projected, byKind, dropped };

  console.log('\nctx status');
  console.log(`  dir        ${dir}`);
  console.log(`  session    ${config.sessionId}`);
  console.log(`  blocks     ${blocks.length} (${blocks.length - dropped} kept, ${dropped} dropped)`);
  console.log('');
  if (config.tokens?.measured) {
    console.log(`  ratio      ${ratio} chars/token, measured from ${config.tokens.usageRecords} usage records`);
    console.log(`  floor      ~${floor.toLocaleString()} tokens of system prompt + tool definitions (irreducible)`);
  } else {
    console.log(`  ratio      ${ratio} chars/token ESTIMATED — too few usage records to measure`);
  }
  console.log('');
  console.log(`  kept       ${(kept / 1024).toFixed(1)} KB -> ~${tokens.toLocaleString()} tokens`);
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(16)}${(n / 1024).toFixed(1).padStart(8)} KB  ${String(Math.round((100 * n) / Math.max(1, kept))).padStart(3)}%`);
  }
  console.log('');
  console.log(`  PROJECTED  ~${projected.toLocaleString()} tokens on resume (${tokens.toLocaleString()} content + ${floor.toLocaleString()} fixed)`);
  if (config.tokens?.peak) {
    const d = config.tokens.peak - projected;
    const w = d >= 0 ? 'down' : 'UP';
    console.log(`             ${w} ${Math.abs(d).toLocaleString()} vs ${config.tokens.peak.toLocaleString()} at L${config.tokens.peakLine}`);
  }

  const top = Number(opt('top', '12'));
  if (top > 0) {
    const costs = blocks.filter((b) => b.keep).sort((a, b) => (b.text || '').length - (a.text || '').length).slice(0, top);
    if (costs.length) {
      console.log('\n  most expensive kept blocks — drop these first:');
      console.log(`    ${'id'.padEnd(6)}${'line'.padEnd(8)}${'kind'.padEnd(16)}${'KB'.padStart(8)}${'tokens'.padStart(10)}  share`);
      for (const b of costs) {
        const n = (b.text || '').length;
        console.log(`    ${String(b.id).padEnd(6)}${('L' + b.line).padEnd(8)}${b.kind.padEnd(16)}${(n / 1024).toFixed(1).padStart(8)}${Math.round(n / ratio).toLocaleString().padStart(10)}  ${((100 * n) / Math.max(1, kept)).toFixed(1)}%`);
      }
    }
  }
  console.log('');
  return null;
}

function cmdBuild() {
  const dir = resolve(opt('dir', '.'));
  const { config, blocks } = readEditDir(dir);
  const entries = readJsonl(config.source);

  const byId = new Map(blocks.map((b) => [b.id, b]));
  const original = blocksOf(entries);
  const newId = opt('new-id', randomUUID());

  let edited = 0;
  let droppedParts = 0;
  let mirrored = 0;
  let toolMirrored = 0;
  let renamed = 0;
  const droppedLines = new Set();
  // oldText -> newText for every change the person made, applied to mirror
  // copies in records that have no editable block of their own.
  const substitutions = [];
  // The same, for the string leaves of an edited tool input: those are
  // mirrored into TOOL_MIRROR_KEYS, never as the whole serialised object.
  const toolSubs = [];
  const renames = collectRenames();
  const syncOff = has('no-sync-mirrors');

  // Clearing a block IS dropping it: an empty message is refused by the API
  // and dropping is what a person who cleared it meant (both measured). A
  // tool result can be empty, so it is left as written.
  const emptiedIds = [];
  const emptied = (ob, eb) => eb.keep !== false && eb.text !== ob.text && isBlank(eb.text) && ob.kind !== 'tool_result';
  // A dropped tool call takes its result with it: a result without its call
  // is refused (verify, and measured), and the pair is what "drop this call"
  // means.
  const droppedCalls = new Set();
  for (const ob of original) {
    const eb = byId.get(ob.id);
    if (eb && ob.kind === 'tool_use' && ob.toolId && (eb.keep === false || emptied(ob, eb))) droppedCalls.add(ob.toolId);
  }
  const forced = new Map();
  for (const ob of original) {
    const eb = byId.get(ob.id);
    if (eb && ob.kind === 'tool_result' && droppedCalls.has(ob.toolId) && eb.keep !== false) forced.set(eb.id, ob.toolId);
  }
  let blankMessages = 0;
  let blankParts = 0;

  // Group the edits by source line so each record is rewritten once.
  const perLine = new Map();
  for (const ob of original) {
    const eb = byId.get(ob.id);
    if (!eb) continue;
    if (!perLine.has(ob.lineNo)) perLine.set(ob.lineNo, []);
    perLine.get(ob.lineNo).push({ ob, eb });
  }

  const out = [];
  for (const e of entries) {
    if (!e.obj) {
      out.push(e.raw);
      continue;
    }
    const o = JSON.parse(JSON.stringify(e.obj));
    const edits = perLine.get(e.lineNo) || [];

    let anyKept = edits.length === 0;
    const dropPaths = [];
    for (const { ob, eb } of edits) {
      const cleared = emptied(ob, eb);
      if (cleared) emptiedIds.push(eb.id);
      if (eb.keep === false || cleared || forced.has(eb.id)) {
        dropPaths.push(ob.path);
        droppedParts++;
        continue;
      }
      anyKept = true;
      if (eb.text !== ob.text) {
        let value = eb.text;
        if (ob.json) {
          try {
            value = JSON.parse(eb.text);
          } catch {
            // Keep it as text rather than refuse the whole build: a hand-edited
            // tool input that is no longer valid JSON is the operator's choice,
            // and failing here would discard every other edit too.
            console.error(`  warn: block ${eb.id} (${pathToString(ob.path)}) is not valid JSON any more; writing it as a string`);
          }
        }
        if (setByPath(o, ob.path, value)) {
          edited++;
          if (!ob.json && typeof value === 'string') {
            substitutions.push([ob.text, value]);
          } else if (ob.json) {
            // A tool input IS mirrored -- into wireToolInputs, toolUseResult
            // and attributionSkill -- just re-serialised, so the leaf strings
            // are what to chase. Skipping this is why an edited Skill call
            // left three records naming the old skill.
            try {
              for (const s of changedLeaves(JSON.parse(ob.text), value)) toolSubs.push(s);
            } catch {
              // ob.text was not parseable as JSON; nothing reliable to mirror.
            }
          }
        }
        else console.error(`  warn: block ${eb.id} could not be written back to ${pathToString(ob.path)}`);
      }
    }

    // A record whose every block was dropped is removed entirely.
    if (edits.length && !anyKept) {
      droppedLines.add(e.lineNo);
      continue;
    }
    // Drop individual content parts, back to front so indices stay valid.
    if (dropPaths.length && Array.isArray(o.message?.content)) {
      // Back to front so earlier indices stay valid while splicing.
      const idxs = dropPaths
        .filter((p) => p[0] === 'message' && p[1] === 'content' && typeof p[2] === 'number')
        .map((p) => p[2])
        .sort((a, b) => b - a);
      for (const i of idxs) o.message.content.splice(i, 1);
      if (!o.message.content.length) {
        droppedLines.add(e.lineNo);
        continue;
      }
    }

    // Repair what the API refuses, whoever wrote it: a blank text part inside a
    // message is removed, and a message left with nothing is dropped (the
    // chain is re-linked below). This also heals a session that an earlier
    // build left with an empty message.
    if (o.message && Array.isArray(o.message.content)) {
      const before = o.message.content.length;
      o.message.content = o.message.content.filter((p) => !(p && p.type === 'text' && isBlank(p.text ?? '')));
      blankParts += before - o.message.content.length;
    }
    if (o.uuid && o.message && (o.type === 'user' || o.type === 'assistant') && blankContent(o.message.content)) {
      droppedLines.add(e.lineNo);
      blankMessages++;
      continue;
    }

    o.sessionId = newId;
    out.push(JSON.stringify(o));
  }

  // Mirror pass. Separate from the rewrite above because a stale copy can sit
  // on an EARLIER line than the message it mirrors -- last-prompt and
  // queue-operation both do -- so a single forward pass would miss them.
  if (substitutions.length && !syncOff) {
    for (let i = 0; i < out.length; i++) {
      let o;
      try {
        o = JSON.parse(out[i]);
      } catch {
        continue;
      }
      let hit = 0;
      for (const [from, to] of substitutions) hit += syncMirrors(o, from, to);
      if (hit) {
        mirrored += hit;
        out[i] = JSON.stringify(o);
      }
    }
  }

  // Tool-mirror pass. Narrow by key (see TOOL_MIRROR_KEYS) because the same
  // leaf value also appears in inventories that are not copies at all.
  if (toolSubs.length && !syncOff) {
    for (let i = 0; i < out.length; i++) {
      let o;
      try {
        o = JSON.parse(out[i]);
      } catch {
        continue;
      }
      const hit = syncToolMirrors(o, toolSubs);
      if (hit) {
        toolMirrored += hit;
        out[i] = JSON.stringify(o);
      }
    }
  }

  // Operator renames. Unscoped and unconditional by design -- they exist for
  // copies no rule can reach, so minLen is 1 and the count is printed.
  if (renames.length) {
    for (let i = 0; i < out.length; i++) {
      let o;
      try {
        o = JSON.parse(out[i]);
      } catch {
        continue;
      }
      let hit = 0;
      for (const [from, to] of renames) hit += syncMirrors(o, from, to, 1);
      if (hit) {
        renamed += hit;
        out[i] = JSON.stringify(o);
      }
    }
  }

  // Repair the parent chain across anything removed, so resume can still walk
  // it. Without this a dropped record leaves the next one pointing at nothing.
  const records = out.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  });
  const present = new Set(records.filter((r) => r?.uuid).map((r) => r.uuid));
  const origParent = new Map();
  for (const e of entries) if (e.obj?.uuid) origParent.set(e.obj.uuid, e.obj.parentUuid || null);
  let repaired = 0;
  for (const r of records) {
    if (!r?.parentUuid || present.has(r.parentUuid)) continue;
    let cur = origParent.get(r.parentUuid) || null;
    while (cur && !present.has(cur)) cur = origParent.get(cur) || null;
    r.parentUuid = cur;
    repaired++;
  }
  const finalLines = records.map((r, i) => (r ? JSON.stringify(r) : out[i]));

  const outFile = resolve(opt('out', join(dir, 'built.jsonl')));
  writeFileSync(outFile, finalLines.join('\n') + '\n');

  console.log('\nctx build');
  console.log(`  blocks edited   ${edited}`);
  console.log(`  parts dropped   ${droppedParts}`);
  console.log(`  mirrors synced  ${mirrored}${syncOff ? ' (--no-sync-mirrors: stale copies LEFT in place)' : ''}`);
  console.log(`  tool mirrors    ${toolMirrored}`);
  if (renames.length) console.log(`  renames applied ${renamed} (${renames.map(([a, b]) => `${a}->${b}`).join(', ')})`);
  console.log(`  records dropped ${droppedLines.size}`);
  console.log(`  emptied         ${emptiedIds.length}${emptiedIds.length ? ` -> dropped (#${emptiedIds.join(', #')}): an empty message is refused by the API` : ''}`);
  console.log(`  paired drops    ${forced.size}${forced.size ? ` tool result(s) dropped with their call (#${[...forced.keys()].join(', #')})` : ''}`);
  console.log(`  blank repaired  ${blankMessages} message(s), ${blankParts} text part(s)`);
  console.log(`  chain repaired  ${repaired} parentUuid link(s)`);
  console.log(`  new session id  ${newId}`);
  console.log(`  -> ${outFile} (${finalLines.length} lines)`);

  const problems = verifyFile(outFile, true);
  if (problems.length) {
    console.log(`\n  VERIFY FAILED (${problems.length}) — not installing:`);
    for (const p of problems.slice(0, 10)) console.log(`    x ${p}`);
    console.log('');
    process.exit(1);
  }
  console.log('  verify          OK (chain intact, tools paired, ids unique)');

  // Residue scan. Re-reads the artefact rather than trusting the counters
  // above, because "mirrors synced 9" was printed by a build that left six
  // copies of the old text in the file.
  const residue = residueOf(finalLines, substitutions.concat(toolSubs));
  const verdict = residue.length ? residuePolicy(residue, has('install')) : 'ok';
  if (residue.length && verdict !== 'ok') {
    const byRec = new Map();
    for (const r of residue) {
      const k = `${r.line}|${r.type}|${r.path}`;
      if (!byRec.has(k)) byRec.set(k, r);
    }
    console.log(`\n  residue         ${byRec.size} surviving cop${byRec.size === 1 ? 'y' : 'ies'} of edited text:`);
    for (const r of [...byRec.values()].slice(0, 12)) {
      console.log(`    L${String(r.line).padStart(3)} ${String(r.type).padEnd(16)} ${r.path}  [${r.how}]`);
    }
    if (byRec.size > 12) console.log(`    ... and ${byRec.size - 12} more`);
    console.log('    a derived or truncated copy needs --rename old=new');
  } else if (!residue.length && (substitutions.length || toolSubs.length)) {
    console.log('  residue         0 (no surviving copy of any edited text)');
  }
  if (verdict === 'block' && has('install')) {
    console.log('\n  NOT INSTALLING (residue policy)\n');
    process.exit(1);
  }

  if (has('install')) {
    const cwd = opt('cwd', config.cwd);
    if (!cwd) die('cannot install: the session recorded no cwd; pass --cwd <dir>');
    const pdir = projectDirForCwd(cwd);
    mkdirSync(pdir, { recursive: true });
    const dest = join(pdir, `${newId}.jsonl`);
    copyFileSync(outFile, dest);
    console.log('');
    console.log(`  installed       ${dest}`);
    console.log('');
    console.log('  resume it with:');
    console.log(`    cd "${cwd}"`);
    console.log(`    claude --resume ${newId}`);
  } else {
    console.log('');
    console.log('  not installed (pass --install)');
  }
  console.log('');
}

// verifyFile asserts what decides whether the API and Claude Code accept the
// file. build repairs these; this re-reads the artefact, which is the only
// check a bug in build cannot fool.
function verifyFile(file, silent = false) {
  const problems = [];
  const warnings = [];
  const raw = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const objs = [];
  const uuids = new Set();
  const dupes = new Set();

  raw.forEach((line, i) => {
    let o;
    try {
      o = JSON.parse(line);
    } catch (err) {
      problems.push(`L${i + 1}: not valid JSON — ${err.message}`);
      return;
    }
    objs.push({ n: i + 1, o });
    if (o.uuid) {
      if (uuids.has(o.uuid)) dupes.add(o.uuid);
      uuids.add(o.uuid);
    }
  });
  for (const d of dupes) problems.push(`duplicate uuid ${d} — resume walks the chain and would loop`);

  // ⛔ Only uuid-bearing records are chain nodes. A transcript is mostly
  // bookkeeping (api-request, mode, last-prompt, cost-state) with no uuid at
  // all; counting those as roots made the old check report "2457 root entries"
  // on a healthy file, which is a warning that fires always and says nothing.
  let roots = 0;
  let nonChain = 0;
  const rootTypes = new Map();
  for (const { n, o } of objs) {
    if (!o.uuid) {
      nonChain++;
      continue;
    }
    if (!o.parentUuid) {
      roots++;
      rootTypes.set(o.type || '(none)', (rootTypes.get(o.type || '(none)') || 0) + 1);
      continue;
    }
    if (!uuids.has(o.parentUuid)) problems.push(`L${n}: parentUuid ${o.parentUuid} is not in the file — the chain is broken`);
  }
  if (!roots) problems.push('no chain root — nothing to resume from');

  // Blank content: what the API refuses (measured). build repairs it, so on
  // a built file this only fires for a hand edit -- before it reaches claude.
  for (const { n, o } of objs) {
    if (!o.uuid || !o.message || (o.type !== 'user' && o.type !== 'assistant')) continue;
    const c = o.message.content;
    if (blankContent(c)) problems.push(`L${n}: ${o.type} message has empty content -- the API refuses it ("user messages must have non-empty content")`);
    else if (Array.isArray(c) && c.some((x) => x && x.type === 'text' && isBlank(x.text ?? ''))) problems.push(`L${n}: a text part is blank -- the API refuses it ("text content blocks must contain non-whitespace text")`);
  }

  const toolUses = new Set();
  const results = new Set();
  for (const { n, o } of objs) {
    const c = o.message?.content;
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      if (p?.type === 'tool_use' && p.id) toolUses.add(p.id);
      if (p?.type === 'tool_result' && p.tool_use_id) {
        results.add(p.tool_use_id);
        if (!toolUses.has(p.tool_use_id)) problems.push(`L${n}: tool_result ${p.tool_use_id} has no preceding tool_use — the API rejects this`);
      }
    }
  }
  for (const id of toolUses) if (!results.has(id)) warnings.push(`tool_use ${id} has no tool_result (ok only on the final turn)`);

  const sids = new Set(objs.map(({ o }) => o.sessionId).filter(Boolean));
  if (sids.size > 1) problems.push(`${sids.size} sessionIds in one file: ${[...sids].join(', ')}`);

  if (!silent) {
    const rt = [...rootTypes.entries()].map(([t, c]) => `${c} ${t}`).join(', ');
    console.log('\nctx verify');
    console.log(`  file              ${file}`);
    console.log(`  lines             ${raw.length} (${objs.length} parsed)`);
    console.log(`  unique uuids      ${uuids.size}`);
    console.log(`  chain roots       ${roots}${rt ? ` (${rt})` : ''}`);
    console.log(`  non-chain records ${nonChain} (no uuid — api-request, mode, cost-state, ...)`);
    console.log(`  tool_use/result   ${toolUses.size} / ${results.size}`);
    console.log(`  session ids       ${[...sids].join(', ') || '(none)'}`);
    if (warnings.length) {
      console.log(`\n  warnings (${warnings.length}):`);
      for (const w of warnings.slice(0, 10)) console.log(`    - ${w}`);
    }
    if (problems.length) {
      console.log(`\n  PROBLEMS (${problems.length}) — NOT safe to resume:`);
      for (const p of problems.slice(0, 30)) console.log(`    x ${p}`);
      console.log('');
      process.exit(1);
    }
    console.log('\n  OK — chain intact, tools paired, ids unique. Safe to resume.\n');
  }
  return problems;
}

function cmdVerify() {
  const file = resolve(opt('file', 'built.jsonl'));
  if (!existsSync(file)) die(`no such file: ${file}`);
  verifyFile(file, false);
}

// ---------------------------------------------------------------------------
// ui
// ---------------------------------------------------------------------------

function cmdUi() {
  const dir = resolve(opt('dir', '.'));
  readEditDir(dir); // fail fast if the folder is wrong
  const port = Number(opt('port', '7777'));
  if (!selfPath()) die('the legacy `ui` verb is not bundled; run brainstorm.exe itself');
  const uiFile = join(dirname(selfPath()), 'ctx-ui.html');

  const json = (res, code, body) => {
    const s = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(s);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      if (url.pathname === '/' && req.method === 'GET') {
        if (!existsSync(uiFile)) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          return res.end(`ctx-ui.html not found next to ctx.mjs (looked at ${uiFile})`);
        }
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        });
        return res.end(readFileSync(uiFile));
      }

      if (url.pathname === '/api/state' && req.method === 'GET') {
        const { config, blocks } = readEditDir(dir);
        const ratio = config.tokens?.charsPerToken || FALLBACK_RATIO;
        const floor = config.tokens?.fixedFloor || 0;
        const { kept, tokens, byKind } = blockCosts(blocks, ratio);
        return json(res, 200, {
          config,
          ratio,
          floor,
          totals: { keptChars: kept, keptTokens: tokens, projected: tokens + floor, byKind },
          blocks: blocks.map((b) => ({
            id: b.id, keep: b.keep !== false, line: b.line, role: b.role, kind: b.kind,
            at: b.at || '', tool: b.tool || '', json: Boolean(b.json),
            chars: (b.text || '').length, tokens: Math.round((b.text || '').length / ratio),
            text: b.text || '',
          })),
        });
      }

      if (url.pathname === '/api/save' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const { config, blocks } = readEditDir(dir);
        const map = new Map(blocks.map((b) => [b.id, b]));
        let n = 0;
        for (const patch of body.blocks || []) {
          const b = map.get(patch.id);
          if (!b) continue;
          if (typeof patch.keep === 'boolean') b.keep = patch.keep;
          if (typeof patch.text === 'string') b.text = patch.text;
          n++;
        }
        // Written through the same writer extract uses, so the file the CLI
        // reads and the file the UI writes can never drift apart.
        writeEditDir(dir, config, blocks.map((b) => ({ ...b, lineNo: b.line })));
        return json(res, 200, { saved: n });
      }

      if (url.pathname === '/api/build' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const out = runCli(['build', '--dir', dir, ...(body.install ? ['--install'] : [])]);
        return json(res, out.code === 0 ? 200 : 500, out);
      }

      if (url.pathname === '/api/verify' && req.method === 'POST') {
        const out = runCli(['verify', '--file', join(dir, 'built.jsonl')]);
        return json(res, 200, out);
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (err) {
      json(res, 500, { error: String(err && err.message ? err.message : err) });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`\nctx ui   http://127.0.0.1:${port}`);
    console.log(`  dir    ${dir}`);
    console.log('  loopback only. Ctrl+C to stop.\n');
  });
}

function readBody(req) {
  return new Promise((ok, no) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 64 * 1024 * 1024) no(new Error('body too large'));
    });
    req.on('end', () => ok(s));
    req.on('error', no);
  });
}

// runCli shells out to this same file so the UI and the terminal run EXACTLY
// the same code path. Re-implementing build in the server is how the two drift.
function runCli(args) {
  // Packaged: the exe IS the engine, re-invoked with --engine.
  const r = selfPath()
    ? spawnSync(process.execPath, [selfPath(), ...args], { encoding: 'utf8', windowsHide: true })
    : spawnSync(process.execPath, ['--engine', ...args], { encoding: 'utf8', windowsHide: true });
  return { code: r.status ?? 1, out: (r.stdout || '') + (r.stderr || '') };
}

// ---------------------------------------------------------------------------

const COMMANDS = { list: cmdList, extract: cmdExtract, status: cmdStatus, build: cmdBuild, verify: cmdVerify, ui: cmdUi };

const HELP_FLAGS = new Set(['--help', '-h', 'help']);

function printHelp() {
  // takeWhile a comment line instead of a hardcoded line count. The header
  // comment grew past 30 lines, so `ctx --help` truncated mid-sentence and
  // defects 3 and 4 were never printed at all. A count literal is a second
  // copy of the header's length that nothing keeps in sync.
  const out = [];
  if (!selfPath()) {
    console.log('ctx engine, bundled in brainstorm.exe\n\n  list | extract | status | build | verify\n\nRun from source for the full help.');
    return;
  }
  for (const line of readFileSync(selfPath(), 'utf8').split('\n').slice(1)) {
    if (!line.startsWith('//')) break;
    out.push(line.replace(/^\/\/ ?/, ''));
  }
  console.log(out.join('\n'));
}

// ⛔ An explicit --help is a SUCCESS. It used to fall through to the
// unknown-command branch -- '--help' is truthy and is not a key of COMMANDS --
// so `ctx --help` printed the help and then exited 2, which breaks every
// script, Makefile and CI step that calls it to check the tool is installed.
// Asking for help and getting a command wrong are different outcomes and need
// different exit codes.
if (!cmd || HELP_FLAGS.has(cmd)) {
  printHelp();
  process.exit(0);
} else if (!COMMANDS[cmd]) {
  printHelp();
  console.error(`\nctx: unknown command \"${cmd}\"`);
  process.exit(2);
} else {
  COMMANDS[cmd]();
}
