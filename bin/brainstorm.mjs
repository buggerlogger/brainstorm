#!/usr/bin/env node
// brainstorm — a context IDE for Claude Code sessions.
//
//   brainstorm ide [--port 7788] [--session <uuid|path>] [--dir <extract>]
//   brainstorm flow --session <uuid|path> [--call N] [--probe "text"]
//   brainstorm <engine verb> ...        list | extract | status | build | verify
//
// `ide` opens the editor. Everything else is the engine (src/ctx.mjs), passed
// through unchanged so the terminal inside the IDE, this CLI and the UI all run
// one implementation.

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ENGINE = join(ROOT, 'src', 'ctx.mjs');

// ⛔ A dynamic import() of a Windows absolute path fails: the ESM loader reads
// "C:\..." as the URL scheme "c:" and refuses it. Every lazy import below has
// to go through pathToFileURL. (The engine documents the mirror image of this
// trap: fileURLToPath, because import.meta.url is file:///C:/...)
const mod = (...parts) => import(pathToFileURL(join(ROOT, ...parts)).href);

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const HELP = `brainstorm — a context IDE for Claude Code sessions

  brainstorm ide [--port 7788] [--session <uuid|path>] [--dir <extract folder>]
      Open the editor: tree on the left, editor in the middle, terminal and
      context debugger below. Loopback only.

  brainstorm flow --session <uuid|path> [--call N] [--probe "text"]
      Print what entered the model's context, in order, for each API call the
      transcript recorded. --probe lists every frame a string appears in.

  brainstorm list | extract | status | build | verify ...
      The engine, unchanged. 'brainstorm help' shows its own flags.
`;

async function main() {
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  if (cmd === 'ide') {
    const { startIde } = await mod('src', 'server', 'ide.mjs');
    const port = Number(opt('port', 7788));
    try {
      startIde({ port, session: opt('session'), dir: opt('dir') });
    } catch (err) {
      console.error(`brainstorm ide: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === 'flow') {
    const { readTranscript, summarise } = await mod('src', 'core', 'transcript.mjs');
    const { traceFlow, probe } = await mod('src', 'core', 'flow.mjs');
    const { resolveSession } = await mod('src', 'core', 'sessions.mjs');
    const target = opt('session');
    if (!target) {
      console.error('brainstorm flow: --session <uuid|path> is required');
      process.exit(2);
    }
    let path;
    try {
      ({ path } = resolveSession(String(target)));
    } catch (err) {
      console.error(`brainstorm flow: ${err.message}`);
      process.exit(2);
    }
    const records = readTranscript(path);
    const sum = summarise(records);
    const trace = traceFlow(records, Number(opt('ratio', 4)));

    console.log(`\n${path}`);
    console.log(`  ${sum.lines} lines, ${(sum.bytes / 1024).toFixed(1)} KB, ${trace.calls.length} API call(s)\n`);

    const needle = opt('probe');
    if (typeof needle === 'string') {
      const hits = probe(trace, needle);
      console.log(`probe ${JSON.stringify(needle)} -> ${hits.length} frame(s)\n`);
      for (const h of hits) {
        console.log(`  call ${h.call}  ${h.path.padEnd(28)} ${h.kind.padEnd(12)} x${h.occurrences}  L${h.line ?? '?'}`);
      }
      console.log('');
      return;
    }

    const only = opt('call');
    for (const [i, call] of trace.calls.entries()) {
      if (only !== null && only !== true && Number(only) !== i) continue;
      console.log(`call ${i}  L${call.line}  keep=${call.keep} tail=${call.tailCount}  ${call.model || ''}`);
      console.log(`  ${call.totals.frames} frames  ${call.totals.chars} ch  ~${call.totals.tokens} tok`);
      console.log(`  system ${call.totals.system} ch   tools ${call.totals.tools} ch   conversation ${call.totals.conversation} ch`);
      for (const [j, f] of call.frames.entries()) {
        const mark = f.cache ? ' [cache]' : '';
        const warn = f.resolved === 'exact' ? '' : ` (${f.resolved})`;
        console.log(`    ${String(j).padStart(3)}  ${f.kind.padEnd(12)} ${String(f.chars).padStart(7)} ch  ${f.label}${mark}${warn}`);
        if (f.detail) console.log(`         ${f.detail}`);
      }
      for (const p of call.problems) console.log(`    ! ${p}`);
      console.log('');
    }
    return;
  }

  // Everything else is the engine.
  const r = spawnSync(process.execPath, [ENGINE, ...argv], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

main();
