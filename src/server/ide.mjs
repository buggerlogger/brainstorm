// ide.mjs — the IDE's HTTP API. Loopback only.
//
// Division of labour, on purpose:
//
//   this file          reads BLOCKS.md, serves the tree, traces the flow
//   src/ctx.mjs (CLI)  every mutation of a transcript, every build, every install
//
// The server never writes a .jsonl. It writes BLOCKS.md and then shells out to
// the engine, which re-reads its own artefact and verifies it. That means the
// UI cannot invent a new way to corrupt a session: it can only be wrong about
// text, and the engine's verify + residue scan then say so.
//
// The terminal is NOT a shell. It accepts the engine's own verbs and nothing
// else -- a browser tab that can run arbitrary commands is a browser tab that
// can run arbitrary commands.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, extname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import { listProjects, resolveSession } from '../core/sessions.mjs';
import { parseBlocks, writeBlocks, groupBlocks } from '../core/blocksmd.mjs';
import { readTranscript, summarise } from '../core/transcript.mjs';
import { traceFlow, probe, diffFlow } from '../core/flow.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = pathResolve(HERE, '..', '..');
const ENGINE = join(ROOT, 'src', 'ctx.mjs');
const UI_DIR = join(ROOT, 'ui');

// Engine verbs the terminal may run. Anything else is refused by name.
const VERBS = new Set(['list', 'extract', 'status', 'build', 'verify', 'help', '--help']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// ---------------------------------------------------------------------------
// workspace: one open session at a time, like one IDE window
// ---------------------------------------------------------------------------

const ws = {
  dir: null,          // the extract folder
  config: null,       // CONFIG.json
  header: '',         // BLOCKS.md preamble, preserved verbatim
  blocks: [],
  dirty: new Set(),   // block ids edited since the last build
  baseline: null,     // flow trace of the session as opened
  lastBuild: null,
  log: [],
};

const logLine = (s) => {
  const line = `${new Date().toISOString().slice(11, 19)}  ${s}`;
  ws.log.push(line);
  if (ws.log.length > 2000) ws.log.splice(0, ws.log.length - 2000);
  return line;
};

function engine(args, { timeout = 600000 } = {}) {
  const r = spawnSync(process.execPath, [ENGINE, ...args], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 256 * 1024 * 1024,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  logLine(`ctx ${args.join(' ')}  -> exit ${r.status ?? 'null'}`);
  return { code: r.status ?? 1, out };
}

function workDirFor(sessionId) {
  const base = join(tmpdir(), 'brainstorm-ide');
  mkdirSync(base, { recursive: true });
  return join(base, sessionId);
}

function loadWorkspace(dir) {
  const configPath = join(dir, 'CONFIG.json');
  const blocksPath = join(dir, 'BLOCKS.md');
  if (!existsSync(configPath) || !existsSync(blocksPath)) {
    throw new Error(`${dir} does not look like an extract folder (no CONFIG.json / BLOCKS.md)`);
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const { header, blocks } = parseBlocks(blocksPath);
  ws.dir = dir;
  ws.config = config;
  ws.header = header;
  ws.blocks = blocks;
  ws.dirty = new Set();
  ws.baseline = traceOf(config.source, config.tokens?.charsPerToken || 4);
  return ws;
}

// Tracing a 42 MB transcript takes seconds, and the debugger calls /api/frame
// on every single step. Cache by file identity + mtime, so an edit invalidates
// it on its own and stepping stays instant.
const traceCache = new Map();
const TRACE_CACHE_MAX = 4;

function traceOf(file, ratio) {
  if (!file || !existsSync(file)) return null;
  const st = statSync(file);
  const key = `${file}|${st.mtimeMs}|${st.size}|${ratio}`;
  const hit = traceCache.get(key);
  if (hit) return hit;
  const records = readTranscript(file);
  const trace = traceFlow(records, ratio);
  trace.summary = summarise(records);
  trace.file = file;
  if (traceCache.size >= TRACE_CACHE_MAX) traceCache.delete(traceCache.keys().next().value);
  traceCache.set(key, trace);
  logLine(`traced ${file} -> ${trace.mode}, ${trace.calls.length} call(s)`);
  return trace;
}

function flushBlocks() {
  if (!ws.dir) throw new Error('no session open');
  writeBlocks(join(ws.dir, 'BLOCKS.md'), ws.header, ws.blocks);
  logLine(`wrote BLOCKS.md (${ws.blocks.length} blocks, ${ws.dirty.size} edited)`);
}

// state is what the UI renders: the tree, the totals, and the cost model.
function stateView() {
  if (!ws.dir) return { open: false };
  const groups = groupBlocks(ws.blocks);
  const chars = ws.blocks.reduce((a, b) => (b.keep === false ? a : a + b.text.length), 0);
  const ratio = ws.config.tokens?.charsPerToken || 4;
  return {
    open: true,
    dir: ws.dir,
    config: ws.config,
    ratio,
    measured: !!ws.config.tokens?.measured,
    why: ws.config.tokens?.why || null,
    floor: ws.config.tokens?.fixedFloor || 0,
    totals: {
      blocks: ws.blocks.length,
      kept: ws.blocks.filter((b) => b.keep !== false).length,
      dropped: ws.blocks.filter((b) => b.keep === false).length,
      chars,
      tokens: Math.round(chars / ratio),
      dirty: [...ws.dirty],
    },
    groups: groups.map((g) => ({
      name: g.name,
      chars: g.chars,
      dropped: g.dropped,
      blocks: g.blocks.map((b) => ({
        id: b.id,
        line: b.line,
        role: b.role,
        kind: b.kind,
        tool: b.tool || null,
        at: b.at,
        keep: b.keep !== false,
        chars: b.text.length,
        tokens: Math.round(b.text.length / ratio),
        title: titleOf(b),
        dirty: ws.dirty.has(b.id),
      })),
    })),
  };
}

function titleOf(b) {
  if (b.kind === 'tool_use') {
    try {
      const o = JSON.parse(b.text);
      const first = Object.values(o)[0];
      return `${b.tool || 'tool'}(${typeof first === 'string' ? first.slice(0, 40) : ''})`;
    } catch {
      return b.tool || 'tool';
    }
  }
  const t = b.text.replace(/\s+/g, ' ').trim();
  return t.length > 72 ? `${t.slice(0, 69)}...` : t || '(empty)';
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const routes = {
  'GET /api/projects': () => ({ projects: listProjects() }),

  'GET /api/state': () => stateView(),

  'GET /api/log': () => ({ lines: ws.log.slice(-400) }),

  'POST /api/open': (body) => {
    const { session, dir } = body;
    if (dir) {
      loadWorkspace(dir);
      logLine(`opened extract folder ${dir}`);
      return stateView();
    }
    if (!session) throw new Error('open needs { session } or { dir }');
    const { path } = resolveSession(session);
    const out = workDirFor(session);
    const r = engine(['extract', '--session', path, '--dir', out]);
    if (r.code !== 0) throw new Error(`extract failed:\n${r.out}`);
    loadWorkspace(out);
    logLine(`opened session ${session}`);
    return { ...stateView(), engineOut: r.out };
  },

  'POST /api/block': (body) => {
    if (!ws.dir) throw new Error('no session open');
    const { id } = body;
    const b = ws.blocks.find((x) => x.id === id);
    if (!b) throw new Error(`no block ${id}`);
    let changed = false;
    if (typeof body.text === 'string' && body.text !== b.text) { b.text = body.text; changed = true; }
    if (typeof body.keep === 'boolean' && body.keep !== (b.keep !== false)) { b.keep = body.keep; changed = true; }
    if (changed) ws.dirty.add(id);
    return { ok: true, changed, block: { id: b.id, chars: b.text.length, keep: b.keep !== false } };
  },

  'GET /api/block': (body, url) => {
    if (!ws.dir) throw new Error('no session open');
    const id = Number(url.searchParams.get('id'));
    const b = ws.blocks.find((x) => x.id === id);
    if (!b) throw new Error(`no block ${id}`);
    return { ...b, dirty: ws.dirty.has(b.id) };
  },

  'POST /api/save': () => {
    flushBlocks();
    // ⛔ Clear the dirty set HERE. It used to be returned and kept, so every
    // block stayed marked unsaved after a successful write and the "unsaved"
    // chip never went away -- an indicator that is always on tells you
    // nothing, and worse, it hides the blocks that really are unsaved.
    const written = [...ws.dirty];
    ws.dirty = new Set();
    return { ok: true, written: ws.blocks.length, saved: written, dirty: [] };
  },

  'POST /api/build': (body) => {
    if (!ws.dir) throw new Error('no session open');
    flushBlocks();
    const args = ['build', '--dir', ws.dir];
    if (body.newId) args.push('--new-id', String(body.newId));
    for (const r of body.renames || []) {
      if (!r.from) continue;
      args.push('--rename', `${r.from}=${r.to ?? ''}`);
    }
    if (body.install) args.push('--install');
    const r = engine(args);
    const built = join(ws.dir, 'built.jsonl');
    const parsed = parseBuild(r.out);
    ws.lastBuild = { ...parsed, code: r.code, out: r.out, at: new Date().toISOString() };
    const after = r.code === 0 ? traceOf(built, ws.config.tokens?.charsPerToken || 4) : null;
    return {
      ok: r.code === 0,
      out: r.out,
      summary: parsed,
      diff: after && ws.baseline ? diffFlow(ws.baseline, after) : [],
    };
  },

  'GET /api/flow': (body, url) => {
    const which = url.searchParams.get('of') || 'source';
    const ratio = ws.config?.tokens?.charsPerToken || 4;
    let file;
    if (which === 'built') file = join(ws.dir || '', 'built.jsonl');
    else if (which === 'source') file = ws.config?.source;
    else file = which;
    const trace = traceOf(file, ratio);
    if (!trace) throw new Error(`no transcript to trace at ${file}`);
    // The frames carry full text; strip it for the list view and fetch one
    // frame's text on demand. A 25 MB trace must not cross the wire twice.
    // MEASURED: a 20,653-line session reconstructs to 7,623 frames, so the
    // list is also capped -- and says what it capped, rather than looking
    // complete while silently truncating.
    const limit = Math.max(1, Math.min(20000, Number(url.searchParams.get('limit') || 1500)));
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
    return {
      file,
      ratio,
      mode: trace.mode,
      why: trace.why,
      summary: trace.summary,
      chainMessages: trace.chainMessages,
      calls: trace.calls.map((c) => ({
        ...c,
        framesTotal: c.frames.length,
        frameOffset: offset,
        frames: c.frames.slice(offset, offset + limit)
          .map(({ text, ...rest }, i) => ({ ...rest, index: offset + i, hasText: !!text })),
      })),
    };
  },

  'GET /api/frame': (body, url) => {
    const which = url.searchParams.get('of') || 'source';
    const ci = Number(url.searchParams.get('call'));
    const fi = Number(url.searchParams.get('frame'));
    const file = which === 'built' ? join(ws.dir || '', 'built.jsonl') : ws.config?.source;
    const trace = traceOf(file, ws.config?.tokens?.charsPerToken || 4);
    const f = trace?.calls?.[ci]?.frames?.[fi];
    if (!f) throw new Error(`no frame ${ci}/${fi}`);
    return f;
  },

  'POST /api/probe': (body) => {
    const which = body.of || 'source';
    const file = which === 'built' ? join(ws.dir || '', 'built.jsonl') : ws.config?.source;
    const trace = traceOf(file, ws.config?.tokens?.charsPerToken || 4);
    if (!trace) throw new Error('nothing to probe');
    const hits = probe(trace, body.needle || '', { caseSensitive: !!body.caseSensitive });
    logLine(`probe ${JSON.stringify((body.needle || '').slice(0, 40))} -> ${hits.length} frame(s)`);
    return { needle: body.needle, hits };
  },

  'POST /api/terminal': (body) => {
    const argv = String(body.cmd || '').trim().split(/\s+/).filter(Boolean);
    if (!argv.length) return { code: 0, out: '' };
    const verb = argv[0] === 'ctx' ? argv[1] : argv[0];
    const args = argv[0] === 'ctx' ? argv.slice(1) : argv;
    if (!VERBS.has(verb)) {
      return {
        code: 2,
        out: `brainstorm: "${verb}" is not an engine verb.\nallowed: ${[...VERBS].join(' ')}\nthis terminal runs the engine, not a shell.`,
      };
    }
    // Default --dir to the open workspace so the terminal and the UI agree.
    if (ws.dir && !args.includes('--dir') && ['extract', 'status', 'build', 'ui'].includes(verb)) {
      args.push('--dir', ws.dir);
    }
    return engine(args);
  },

  'POST /api/send': async (body) => {
    const msg = String(body.message || '').trim();
    if (!msg) throw new Error('send needs { message }');
    const sessionId = body.sessionId || ws.lastBuild?.newId || ws.config?.sessionId;
    const cwd = body.cwd || ws.config?.cwd;
    if (!sessionId || !cwd) throw new Error('no session id / cwd to resume');
    logLine(`resume ${sessionId} <- ${JSON.stringify(msg.slice(0, 60))}`);
    const r = await run('claude', ['-p', '--resume', sessionId, msg, '--permission-mode', 'bypassPermissions'], cwd);
    logLine(`resume exit ${r.code}`);
    return { ...r, sessionId, cwd };
  },
};

function parseBuild(out) {
  const num = (re) => {
    const m = out.match(re);
    return m ? Number(m[1]) : null;
  };
  const str = (re) => {
    const m = out.match(re);
    return m ? m[1].trim() : null;
  };
  return {
    edited: num(/blocks edited\s+(\d+)/),
    droppedParts: num(/parts dropped\s+(\d+)/),
    mirrors: num(/mirrors synced\s+(\d+)/),
    toolMirrors: num(/tool mirrors\s+(\d+)/),
    renames: num(/renames applied\s+(\d+)/),
    recordsDropped: num(/records dropped\s+(\d+)/),
    repaired: num(/chain repaired\s+(\d+)/),
    newId: str(/new session id\s+(\S+)/),
    residue: num(/residue\s+(\d+)/),
    verified: /verify\s+OK/.test(out),
    installed: str(/installed\s+(.+)/),
  };
}

function run(cmd, args, cwd) {
  return new Promise((ok) => {
    const p = spawn(cmd, args, { cwd, shell: true, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', (err) => ok({ code: 1, out: `${out}\n${err.message}` }));
    p.on('close', (code) => ok({ code, out }));
  });
}

// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((ok, no) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 64 * 1024 * 1024) no(new Error('body too large'));
    });
    req.on('end', () => {
      if (!s) return ok({});
      try { ok(JSON.parse(s)); } catch (err) { no(new Error(`bad JSON body: ${err.message}`)); }
    });
    req.on('error', no);
  });
}

const json = (res, code, obj) => {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  // No path traversal: resolve and require the result to stay under ui/.
  const file = pathResolve(UI_DIR, rel);
  if (!file.startsWith(UI_DIR) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'content-length': body.length });
  res.end(body);
}

export function startIde({ port = 7788, dir = null, session = null } = {}) {
  if (dir) loadWorkspace(dir);
  else if (session) {
    const { path } = resolveSession(session);
    const out = workDirFor(session);
    const r = engine(['extract', '--session', path, '--dir', out]);
    if (r.code !== 0) throw new Error(`extract failed:\n${r.out}`);
    loadWorkspace(out);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];
    if (!handler) {
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
      return json(res, 404, { error: `no route ${key}` });
    }
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const out = await handler(body, url);
      json(res, 200, out);
    } catch (err) {
      json(res, 500, { error: err.message, candidates: err.candidates || undefined });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`\n  brainstorm IDE   http://127.0.0.1:${port}`);
    if (ws.dir) console.log(`  workspace        ${ws.dir}`);
    console.log('  loopback only. Ctrl+C to stop.\n');
  });
  return server;
}
