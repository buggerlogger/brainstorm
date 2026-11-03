// export.mjs — dump a session's context to sorted folders, or to a .zip.
//
// The tree is the same either way, and every name sorts into the order you
// would read it in: folders are numbered in the Explorer's order, files are
// numbered by block id and carry the transcript line, so `dir` and a zip
// listing both read top to bottom as the conversation happened.
//
//   README.txt
//   session/CONFIG.json  session/BLOCKS.md
//   context/01 User messages/0001 L000004 user text - Invoke the alpha....txt
//   flow/calls.tsv
//   flow/last-call/0000 system system[0].txt        (exportFlow = last)
//   flow/tails/call-003/0012 message ....txt        (exportFlow = all)
//   agents/agents.tsv
//   agents/01 Audio DSP and UA guard/...
//
// "all" exports only the frames each call ADDED. A recorded session repeats
// its whole prefix in every call; writing every frame of every call would
// write the same 50K-char system prompt thousands of times.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { groupBlocks } from './blocksmd.mjs';
import { writeZip } from './zip.mjs';

const BAD = /[<>:"/\\|?*\u0000-\u001f]/g;

// ⛔ File NAMES are ASCII; file CONTENTS keep every character.
//
// MEASURED: an entry named "0002 نص.txt" in a spec-correct archive (bit 11
// set, valid UTF-8) is read exactly by .NET's ZipFile -- name and body -- but
// Windows' own tar.exe (bsdtar) SKIPS it with "Archive entry has empty or
// unreadable filename", even when told --options hdrcharset=UTF-8. A reader
// that silently drops a file is data loss from the person's side, so names
// are made ASCII in folder AND zip exports alike (the trees stay identical).
// Accents fold to their base letter; anything else non-ASCII becomes "_".
// The id and transcript-line prefix keep every name unique regardless.
export function safeName(s, max = 90) {
  const t = String(s ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(BAD, '_')
    .replace(/_{2,}/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return (t.length > max ? t.slice(0, max).trim() : t) || '_';
}

const pad = (n, w) => String(n).padStart(w, '0');
const words = (text, n = 8) => String(text || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, n).join(' ');

function blockFile(b) {
  const head = words(b.text, 7);
  return `${pad(b.id, 4)} L${pad(b.line ?? 0, 6)} ${b.role || ''} ${b.kind || ''}${b.tool ? ` ${b.tool}` : ''}${head ? ` - ${head}` : ''}`;
}

function frameFile(f, i) {
  return `${pad(i, 4)} ${f.kind} ${f.label}`;
}

function frameBody(f) {
  const meta = [
    `# ${f.label}`,
    `# path      ${f.path}`,
    `# kind      ${f.kind}`,
    `# chars     ${f.chars}   ~${f.tokens} tok`,
    `# resolved  ${f.resolved}`,
    `# cache     ${f.cache ? JSON.stringify(f.cache) : '-'}`,
    `# line      ${f.source?.line ?? '-'}`,
    '',
  ];
  return `${meta.join('\n')}${f.text || ''}\n`;
}

// buildEntries produces the whole tree as { path, content } without touching
// the disk, so folder and zip export are literally the same data.
export function buildEntries({ name, config, blocks, header, trace, agents = [], agentTraces = new Map(), settings = {}, scopeFolder = null }) {
  const root = safeName(name, 120);
  const out = [];
  const add = (rel, content) => out.push({ path: `${root}/${rel}`, content });

  const groups = groupBlocks(blocks).filter((g) => !scopeFolder || g.name === scopeFolder);

  // --- README ---
  const lines = [
    `brainstorm export`,
    ``,
    `session     ${config.sessionId}`,
    `cwd         ${config.cwd}`,
    `source      ${config.source}`,
    `exported    ${new Date().toISOString()}`,
    `scope       ${scopeFolder ? `folder "${scopeFolder}"` : 'whole session'}`,
    `tokens      ${config.tokens?.charsPerToken ?? '?'} chars/token ${config.tokens?.measured ? 'MEASURED' : 'ESTIMATE'}${config.tokens?.why ? ` (${config.tokens.why})` : ''}`,
    ``,
    `context/ folders`,
    ...groups.map((g, i) => `  ${pad(i + 1, 2)} ${g.name.padEnd(22)} ${String(g.blocks.length).padStart(6)} blocks  ${String(g.chars).padStart(10)} ch${g.dropped ? `  (${g.dropped} dropped)` : ''}`),
    ``,
  ];
  if (trace) {
    lines.push(`flow        ${trace.mode}, ${trace.calls.length} API call(s), exported: ${settings.exportFlow || 'last'}`);
    if (trace.mode === 'reconstructed') lines.push(`            ${trace.why}`);
  }
  if (agents.length > 1) lines.push(`agents      ${agents.length - 1} subagent(s)`);
  lines.push('', 'Blocks marked keep:false were dropped from the context; their files are prefixed DROPPED.');
  add('README.txt', `${lines.join('\n')}\n`);

  // --- session ---
  add('session/CONFIG.json', JSON.stringify(config, null, 2));
  if (header !== undefined) {
    const md = [header, '', ''];
    for (const b of blocks) {
      const meta = { ...b };
      delete meta.text;
      md.push(`<!-- @B ${JSON.stringify(meta)} -->`, b.text, '<!-- @END -->', '');
    }
    add('session/BLOCKS.md', md.join('\n'));
  }

  // --- context ---
  groups.forEach((g, gi) => {
    const folder = `context/${pad(gi + 1, 2)} ${safeName(g.name)}`;
    for (const b of g.blocks) {
      const prefix = b.keep === false ? 'DROPPED ' : '';
      add(`${folder}/${prefix}${safeName(blockFile(b))}.txt`, `${b.text}\n`);
    }
  });

  // --- flow ---
  const mode = settings.exportFlow || 'last';
  if (trace && mode !== 'none' && !scopeFolder) {
    const tsv = ['call\tline\tmodel\tkeep\ttail\tframes\tchars\ttokens\tsystem\ttools\tconversation'];
    trace.calls.forEach((c, i) => tsv.push([i, c.line, c.model || '', c.keep, c.tailCount, c.totals.frames,
      c.totals.chars, c.totals.tokens, c.totals.system, c.totals.tools, c.totals.conversation].join('\t')));
    add('flow/calls.tsv', `${tsv.join('\n')}\n`);

    if (mode === 'last' && trace.calls.length) {
      const last = trace.calls[trace.calls.length - 1];
      last.frames.forEach((f, i) => add(`flow/last-call/${safeName(frameFile(f, i))}.txt`, frameBody(f)));
    } else if (mode === 'all') {
      // Only the frames each call added. Identity is the frame's text: the
      // prefix a call inherits is byte-identical to the previous call's.
      let prev = new Set();
      trace.calls.forEach((c, ci) => {
        const cur = new Set();
        c.frames.forEach((f, fi) => {
          const key = `${f.path}|${f.text}`;
          cur.add(key);
          if (prev.has(key)) return;
          add(`flow/tails/call-${pad(ci, 3)}/${safeName(frameFile(f, fi))}.txt`, frameBody(f));
        });
        prev = cur;
      });
    }
  }

  // --- agents ---
  if (settings.exportAgents !== false && agents.length > 1 && !scopeFolder) {
    const tsv = ['n\tid\tkind\tlabel\tspawnLine\tinheritsThroughLine\tbytes'];
    agents.forEach((a, i) => tsv.push([i, a.id, a.kind, a.label, a.spawnLine ?? '', a.inheritsThroughLine ?? '', a.bytes].join('\t')));
    add('agents/agents.tsv', `${tsv.join('\n')}\n`);
    agents.slice(1).forEach((a, i) => {
      const t = agentTraces.get(a.id);
      const folder = `agents/${pad(i + 1, 2)} ${safeName(a.label, 60)} [${a.id.slice(0, 8)}]`;
      add(`${folder}/agent.json`, JSON.stringify(a, null, 2));
      if (!t || !t.calls.length) return;
      const last = t.calls[t.calls.length - 1];
      last.frames.forEach((f, fi) => add(`${folder}/${safeName(frameFile(f, fi))}.txt`, frameBody(f)));
    });
  }

  // Sort so a zip listing reads in the same order as the folder does.
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export function writeFolder(base, entries) {
  let bytes = 0;
  for (const e of entries) {
    const file = join(base, ...e.path.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, e.content);
    bytes += Buffer.byteLength(e.content);
  }
  return { dir: join(base, entries[0]?.path.split('/')[0] || ''), files: entries.length, bytes };
}

export function writeArchive(file, entries) {
  return writeZip(file, entries);
}

export function stampName(sessionId, scope) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${sessionId.slice(0, 8)}${scope ? `-${scope}` : ''}-${ts}`;
}
