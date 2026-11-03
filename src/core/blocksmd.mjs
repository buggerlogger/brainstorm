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

// Folders for the tree. A flat list of 2,057 blocks is unusable; these are the
// groupings a person actually navigates by. `kind` and `role` come from the
// engine, so no new classification is invented here.
export function groupBlocks(blocks) {
  const groups = new Map();
  const put = (folder, b) => {
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(b);
  };
  for (const b of blocks) {
    if (b.kind === 'tool_use') put('Tool calls', b);
    else if (b.kind === 'tool_result') put('Tool results', b);
    else if (b.kind === 'thinking') put('Thinking', b);
    else if (b.role === 'user') put('User messages', b);
    else if (b.role === 'assistant') put('Assistant messages', b);
    else if (b.role === 'system') put('System injections', b);
    else put('Other', b);
  }
  // Stable, meaningful order rather than insertion order.
  const ORDER = ['User messages', 'Assistant messages', 'System injections', 'Tool calls', 'Tool results', 'Thinking', 'Other'];
  return ORDER.filter((k) => groups.has(k)).map((name) => ({
    name,
    blocks: groups.get(name),
    chars: groups.get(name).reduce((a, b) => a + b.text.length, 0),
    dropped: groups.get(name).filter((b) => b.keep === false).length,
  }));
}
