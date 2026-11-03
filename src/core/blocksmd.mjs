// Copyright (c) 2026 buggerlogger. All rights reserved.
// Proprietary and confidential. No license is granted to use, copy, modify or
// distribute this file, in whole or in part. See LICENSE.
//
// blocksmd.mjs — parse and write the BLOCKS.md the engine produces.
//
// Format, one block:
//
//   <!-- @B {"id":5,"keep":true,"line":31,"role":"user","kind":"text",...} -->
//   ...text...
//   <!-- @END -->
//
// The IDE reads this to populate the tree and the editor, and writes it back
// before asking the engine to build. The engine stays the only thing that
// touches the transcript itself, so the IDE cannot invent a new way to corrupt
// one -- it can only be wrong about text, which the engine then verifies.

import { readFileSync, writeFileSync } from 'node:fs';

const OPEN = /^<!--\s*@B\s+(\{.*\})\s*-->$/;
const CLOSE = '<!-- @END -->';

export function parseBlocks(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const blocks = [];
  const header = [];
  let seenFirst = false;
  let i = 0;

  while (i < lines.length) {
    const m = lines[i].match(OPEN);
    if (!m) {
      if (!seenFirst) header.push(lines[i]);
      i++;
      continue;
    }
    seenFirst = true;
    let meta;
    try {
      meta = JSON.parse(m[1]);
    } catch (err) {
      throw new Error(`BLOCKS.md line ${i + 1}: block header is not valid JSON -- ${err.message}`);
    }
    const body = [];
    i++;
    let closed = false;
    while (i < lines.length) {
      if (lines[i] === CLOSE) { closed = true; i++; break; }
      body.push(lines[i]);
      i++;
    }
    if (!closed) throw new Error(`BLOCKS.md: block ${meta.id} has no ${CLOSE}`);
    // The engine writes one blank line after the text; strip exactly one so a
    // round trip is byte-identical when nothing was edited.
    if (body.length && body[body.length - 1] === '') body.pop();
    blocks.push({ ...meta, text: body.join('\n') });
  }

  return { header: header.join('\n').replace(/\s+$/, ''), blocks };
}

export function writeBlocks(file, header, blocks) {
  const out = [header, '', ''];
  for (const b of blocks) {
    const meta = { ...b };
    delete meta.text;
    out.push(`<!-- @B ${JSON.stringify(meta)} -->`);
    out.push(b.text);
    out.push(CLOSE);
    out.push('');
  }
  writeFileSync(file, `${out.join('\n')}`);
}

// Content classes that deserve a folder of their own. A `user` record is not
// always a person talking: on one 15,045-line session the user role carried 7
// task notifications, 22 local-command results, 11 slash commands and 28
// pastes. Filed together they bury the turns you actually wrote.
//
// Matching is on the WHOLE text, anchored, not a loose `includes`. A paste
// quoted inside a reply must not reclassify the reply -- which is why each
// test checks the text starts with its marker.
const CONTENT_CLASSES = [
  {
    folder: 'Task notifications',
    test: (t) => t.startsWith('<task-notification>') || /^\[SYSTEM NOTIFICATION[^\]]*\]/.test(t),
  },
  {
    folder: 'Slash commands',
    test: (t) => t.startsWith('<command-name>') || t.startsWith('<local-command-'),
  },
  {
    folder: 'Pasted content',
    // A message that is nothing but a paste. One with your own words around it
    // is still your message and belongs with your turns.
    test: (t) => t.startsWith('<pasted_content') && t.endsWith('</pasted_content>'),
  },
  {
    folder: 'System reminders',
    test: (t) => t.startsWith('<system-reminder>') && t.endsWith('</system-reminder>'),
  },
];

export function classifyBlock(b) {
  const t = (b.text || '').trim();
  if (b.kind === 'text' || b.kind === undefined) {
    for (const c of CONTENT_CLASSES) {
      try {
        if (c.test(t)) return c.folder;
      } catch { /* a class must never take the tree down */ }
    }
  }
  if (b.kind === 'tool_use') return 'Tool calls';
  if (b.kind === 'tool_result') return 'Tool results';
  if (b.kind === 'thinking') return 'Thinking';
  if (b.role === 'user') return 'User messages';
  if (b.role === 'assistant') return 'Assistant messages';
  if (b.role === 'system') return 'System injections';
  return 'Other';
}

// Folders for the tree. A flat list of 2,057 blocks is unusable; these are the
// groupings a person actually navigates by.
const ORDER = [
  'User messages',
  'Assistant messages',
  'Task notifications',
  'Slash commands',
  'Pasted content',
  'System reminders',
  'System injections',
  'Tool calls',
  'Tool results',
  'Thinking',
  'Other',
];

export function groupBlocks(blocks) {
  const groups = new Map();
  for (const b of blocks) {
    const folder = classifyBlock(b);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(b);
  }
  return ORDER.filter((k) => groups.has(k)).map((name) => ({
    name,
    blocks: groups.get(name),
    chars: groups.get(name).reduce((a, b) => a + b.text.length, 0),
    dropped: groups.get(name).filter((b) => b.keep === false).length,
  }));
}
