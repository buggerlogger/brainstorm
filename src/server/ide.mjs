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
import { join, dirname, extname, basename } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import { IS_SEA, VERSION, engineCommand, readUi, appDataDir } from '../runtime.mjs';
import { loadSettings, saveSettings, rememberRecent, SCHEMA, settingsFile } from '../core/settings.mjs';
import { findSessions, searchStrings } from '../core/search.mjs';
import { listAgents, traceAgent, readersOf } from '../core/agents.mjs';
import { buildEntries, writeFolder, writeArchive, stampName, safeName } from '../core/export.mjs';
import { openSessionWindow, resumeInWindow, stopWindow, listWindows, windowLog } from './session-window.mjs';

import { listProjects, resolveSession } from '../core/sessions.mjs';
import { parseBlocks, writeBlocks, groupBlocks } from '../core/blocksmd.mjs';
import { readTranscript, summarise } from '../core/transcript.mjs';
import { traceFlow, probe, diffFlow } from '../core/flow.mjs';
import { loadPins, savePins, newPin, applyPins, purgePin, rewindTo, ANCHORS } from '../core/pins.mjs';
import { Shell, SHELLS, DEFAULT_SHELL } from './shell.mjs';
import { SessionWatcher } from '../core/watch.mjs';
import { openConsole, availableConsoles } from './console.mjs';

// Paths and the engine command come from runtime.mjs, which knows whether
// this is running from source or packaged inside brainstorm.exe.
let lastBeat = 0;

// Window presence: one held-open server-sent-events connection per window.
let presenceOpen = 0;
let presenceSeen = false;
let presenceZeroAt = 0;

function presence(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  presenceOpen++;
  presenceSeen = true;
  presenceZeroAt = 0;
  res.write(`event: hello\ndata: ${JSON.stringify({ version: VERSION, windows: presenceOpen })}\n\n`);
  // A comment every 20 s keeps any intermediary from idling the stream out.
  const keep = setInterval(() => res.write(': keep-alive\n\n'), 20000);
  keep.unref();
  const gone = () => {
    clearInterval(keep);
    presenceOpen = Math.max(0, presenceOpen - 1);
    req.off('close', gone);
  };
  req.on('close', gone);
}

// Engine verbs, still usable from the terminal as a shorthand that runs the
// bundled engine rather than whatever `ctx` happens to be on PATH.
const VERBS = new Set(['list', 'extract', 'status', 'build', 'verify', 'help', '--help']);

// The shell and the session watcher live for the life of the server.
let shell = null;
let watcher = null;

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
  pins: [],          // sticky context, loaded by cwd, re-applied on every build
  pinReport: [],
  window: null,      // tag of the session window claude runs in, if any
  log: [],
};

const logLine = (s) => {
  const line = `${new Date().toISOString().slice(11, 19)}  ${s}`;
  ws.log.push(line);
  if (ws.log.length > 2000) ws.log.splice(0, ws.log.length - 2000);
  return line;
};

function engine(args, { timeout = 600000 } = {}) {
  const [exe, argv] = engineCommand(args);
  const r = spawnSync(exe, argv, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 256 * 1024 * 1024,
    // The app's server runs with no console. Without this every extract and
    // build would flash a black console window on screen for its duration.
    windowsHide: true,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  logLine(`ctx ${args.join(' ')}  -> exit ${r.status ?? 'null'}`);
  return { code: r.status ?? 1, out };
}

// ⛔ Takes the session ID, never whatever the caller passed. The UI sends the
// full .jsonl PATH as `session` (it has one, and resolveSession accepts it), so
// joining that under tmpdir produced
//   C:\...\Temp\brainstorm-ide\C:\Users\...\<id>.jsonl
// and every extract died with ENOENT on mkdir. Same class as the old
// --install-to defect: a value used as a name after being used as a path.
function workDirFor(idOrPath) {
  const base = join(tmpdir(), 'brainstorm-ide');
  mkdirSync(base, { recursive: true });
  const id = basename(String(idOrPath)).replace(/\.jsonl$/i, '');
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(id)) throw new Error(`refusing to build a work dir from ${JSON.stringify(idOrPath)}`);
  return join(base, id);
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
  ws.pins = loadPins(config.cwd);
  // Re-apply on open: a session rebuilt from a pinned one already carries the
  // pin text in its blocks, and a fresh sibling session does not. Applying is
  // idempotent, so doing it unconditionally is what keeps the two in step.
  ws.pinReport = applyPins(ws.blocks, ws.pins);
  const landed = ws.pinReport.filter((r) => r.applied).length;
  if (ws.pins.length) logLine(`pins: ${landed}/${ws.pins.length} applied for ${config.cwd}`);
  ws.baseline = traceOf(config.source, config.tokens?.charsPerToken || 4);
  // Point the live watcher and the shell at this project.
  ensureWatcher(config.cwd, config.tokens?.charsPerToken || 4);
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
    pins: ws.pins.map((p) => {
      const r = ws.pinReport.find((x) => x.id === p.id);
      return { ...p, applied: !!r?.applied, blockApplied: r?.blockId ?? null, rehomed: !!r?.rehomed, reason: r?.reason || null };
    }),
    anchors: ANCHORS,
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

function ensureWatcher(cwd, ratio) {
  if (!watcher) {
    watcher = new SessionWatcher({ cwd, ratio, onEvent: (ev) => {
      if (ev.type === 'jump') logLine(`live jump  call ${ev.call}  ~${ev.tokens} tok  (${ev.session.slice(0, 8)})`);
      else if (ev.type === 'call') logLine(`live call  ${ev.label}`);
      else if (ev.type === 'session-started') {
        logLine(`live session ${ev.session.slice(0, 8)} started`);
        // Auto-attach is opt-in. Switching the editor out from under someone
        // mid-edit because a background session happened to start is the kind
        // of helpfulness that loses work.
        if (watcher.autoAttach && !ws.dirty.size) {
          try {
            const out = workDirFor(ev.file);
            const r = engine(['extract', '--session', ev.file, '--dir', out]);
            if (r.code === 0) { loadWorkspace(out); logLine(`auto-attached ${ev.session.slice(0, 8)}`); }
          } catch (err) { logLine(`auto-attach failed: ${err.message}`); }
        } else if (watcher.autoAttach) {
          logLine(`auto-attach skipped: ${ws.dirty.size} unsaved edit(s)`);
        }
      }
    } });
    watcher.autoAttach = !!loadSettings().autoAttach;
    watcher.start();
    logLine(`watching ${watcher.dir}`);
  } else {
    watcher.ratio = ratio;
    watcher.setCwd(cwd);
  }
  return watcher;
}

function ensureShell(cwd) {
  if (!shell) shell = new Shell({ cwd: cwd || ws.config?.cwd || process.cwd() });
  return shell;
}

// The open session's agents. Cached per source file + size: listing reads
// every subagent's meta and first record, which is cheap but not free.
let agentsCache = { key: null, agents: [] };
function agentsOf() {
  if (!ws.config?.source || !existsSync(ws.config.source)) return [];
  const st = statSync(ws.config.source);
  const key = `${ws.config.source}|${st.size}|${st.mtimeMs}`;
  if (agentsCache.key !== key) agentsCache = { key, agents: listAgents(ws.config.source) };
  return agentsCache.agents;
}

// Which transcript a debugger request means. An ALLOW-LIST, never a path:
// the first version fell through to `file = which`, so any request could hand
// the tracer an arbitrary file on disk and read it back as frames.
//
//   source         the session as opened
//   built          the last build
//   agent:<id>     a subagent of the open session (or agent:main)
function traceFor(which) {
  const ratio = ws.config?.tokens?.charsPerToken || 4;
  if (which === 'source') return { trace: traceOf(ws.config?.source, ratio), file: ws.config?.source };
  if (which === 'built') {
    const file = join(ws.dir || '', 'built.jsonl');
    return { trace: traceOf(file, ratio), file };
  }
  if (typeof which === 'string' && which.startsWith('agent:')) {
    const id = which.slice(6);
    if (id === 'main') return { trace: traceOf(ws.config?.source, ratio), file: ws.config?.source };
    const a = agentsOf().find((x) => x.id === id);
    if (!a) throw new Error(`no agent ${id} in this session`);
    return { trace: traceAgent(a, ratio), file: a.file };
  }
  throw new Error(`unknown flow source ${JSON.stringify(which)} (expected source, built or agent:<id>)`);
}

// Show a file or folder in Explorer, selected. explorer.exe exits 1 even on
// success, so its exit code is not an error signal and is ignored.
function reveal(path) {
  if (process.platform === 'win32') {
    spawn('explorer.exe', [`/select,${path}`], { detached: false, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', ['-R', path], { stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [dirname(path)], { stdio: 'ignore' }).unref();
  }
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

const routes = {
  // --- app: version, heartbeat, settings ------------------------------------

  'GET /api/version': () => ({ version: VERSION, sea: IS_SEA, node: process.version, appData: appDataDir(), windows: presenceOpen }),

  // The app window pings this. When the window is closed the pings stop and
  // the server exits (see startIde) -- otherwise closing the app would leave a
  // headless server running in the background with no way to see it.
  'POST /api/heartbeat': () => { lastBeat = Date.now(); return { ok: true }; },

  'GET /api/settings': () => ({ settings: loadSettings(), schema: SCHEMA, file: settingsFile() }),

  'POST /api/settings': (body) => {
    const next = saveSettings(body || {});
    if (watcher) watcher.autoAttach = !!next.autoAttach;
    logLine('settings saved');
    return { settings: next, schema: SCHEMA };
  },

  // --- the start gate -------------------------------------------------------

  'GET /api/find-sessions': (body, url) => {
    const r = findSessions(url.searchParams.get('q') || '', { limit: Number(url.searchParams.get('limit') || 60) });
    return { ...r, recent: loadSettings().recent };
  },

  // --- agents and who-read-what --------------------------------------------

  'GET /api/agents': () => {
    if (!ws.config) throw new Error('no session open');
    const agents = agentsOf();
    const ratio = ws.config.tokens?.charsPerToken || 4;
    return {
      agents: agents.map((a) => {
        let calls = null;
        let mode = null;
        try { const t = traceAgent(a, ratio); calls = t.calls.length; mode = t.mode; } catch { /* reported as null */ }
        return { ...a, calls, mode };
      }),
    };
  },

  'GET /api/agent-flow': (body, url) => {
    if (!ws.config) throw new Error('no session open');
    const id = url.searchParams.get('id') || 'main';
    const a = agentsOf().find((x) => x.id === id);
    if (!a) throw new Error(`no agent ${id}`);
    const t = traceAgent(a, ws.config.tokens?.charsPerToken || 4);
    return {
      agent: a,
      mode: t.mode,
      why: t.why,
      calls: t.calls.map((c) => ({ ...c, framesTotal: c.frames.length, frames: c.frames.slice(0, 1500).map(({ text, ...rest }, i) => ({ ...rest, index: i, hasText: !!text })) })),
    };
  },

  'POST /api/readers': (body) => {
    if (!ws.config) throw new Error('no session open');
    let text = String(body.text || '');
    let line = body.line ?? null;
    if (!text && body.blockId != null) {
      const b = ws.blocks.find((x) => x.id === Number(body.blockId));
      if (!b) throw new Error(`no block ${body.blockId}`);
      text = b.text;
      line = b.line;
    }
    return readersOf(agentsOf(), text, { line, ratio: ws.config.tokens?.charsPerToken || 4 });
  },

  // --- search for strings --------------------------------------------------

  'POST /api/strings': (body) => {
    if (!ws.config) throw new Error('no session open');
    const ratio = ws.config.tokens?.charsPerToken || 4;
    const scope = body.scope || 'all';
    const sources = [];
    if (scope === 'all' || scope === 'blocks') sources.push({ agent: 'main', label: 'blocks (editable)', blocks: ws.blocks });
    if (scope === 'all' || scope === 'flow') sources.push({ agent: 'main', label: 'main agent', trace: traceOf(ws.config.source, ratio) });
    if (scope === 'all' || scope === 'agents') {
      for (const a of agentsOf().slice(1)) {
        try { sources.push({ agent: a.id, label: a.label, trace: traceAgent(a, ratio) }); } catch { /* skip unreadable */ }
      }
    }
    const r = searchStrings(sources, String(body.query || ''), {
      caseSensitive: !!body.caseSensitive, regex: !!body.regex, limit: Math.min(5000, Number(body.limit || 1000)),
    });
    logLine(`strings ${JSON.stringify(String(body.query || '').slice(0, 40))} -> ${r.hits.length}${r.truncated ? '+' : ''}`);
    return r;
  },

  // --- export ---------------------------------------------------------------

  'POST /api/export': (body) => {
    if (!ws.config) throw new Error('no session open');
    const settings = loadSettings();
    const ratio = ws.config.tokens?.charsPerToken || 4;
    const folder = body.folder || null;
    const trace = traceOf(ws.config.source, ratio);
    const agents = settings.exportAgents ? agentsOf() : [];
    const agentTraces = new Map();
    for (const a of agents.slice(1)) { try { agentTraces.set(a.id, traceAgent(a, ratio)); } catch { /* skip */ } }
    const name = stampName(ws.config.sessionId, folder ? safeName(folder, 30) : '');
    const entries = buildEntries({
      name, config: ws.config, blocks: ws.blocks, header: ws.header, trace, agents, agentTraces,
      settings, scopeFolder: folder,
    });
    const base = body.dir || settings.exportDir;
    mkdirSync(base, { recursive: true });
    let result;
    if (body.format === 'zip') {
      result = writeArchive(join(base, `${name}.zip`), entries);
      result.path = result.file;
    } else {
      result = writeFolder(base, entries);
      result.path = result.dir;
    }
    logLine(`export ${body.format || 'folder'} -> ${result.path} (${entries.length} files)`);
    if (settings.revealAfterExport && body.reveal !== false) reveal(result.path);
    return { ok: true, format: body.format || 'folder', path: result.path, files: entries.length, bytes: result.bytes };
  },

  'POST /api/reveal': (body) => {
    const p = String(body.path || '');
    if (!p || !existsSync(p)) throw new Error(`nothing at ${p}`);
    reveal(p);
    return { ok: true };
  },

  // --- the session window (claude runs here; Save & Resume restarts it) -----

  'GET /api/windows': () => ({ windows: listWindows() }),

  'POST /api/window': (body) => {
    const action = body.action || 'open';
    const settings = loadSettings();
    if (action === 'open') {
      const sessionId = body.sessionId || ws.config?.sessionId;
      const cwd = body.cwd || ws.config?.cwd;
      if (!sessionId || !cwd) throw new Error('open a session first');
      const w = openSessionWindow({ sessionId, cwd, shell: settings.shell, claudeArgs: settings.claudeArgs, claude: settings.claudePath || 'claude' });
      ws.window = w.tag;
      ensureWatcher(cwd, ws.config?.tokens?.charsPerToken || 4);
      logLine(`window ${w.tag} opened: claude --resume ${sessionId}`);
      return w;
    }
    const tag = body.tag || ws.window;
    if (!tag) throw new Error('no session window is open');
    if (action === 'resume') return resumeInWindow(tag, body.sessionId);
    if (action === 'stop') return stopWindow(tag);
    if (action === 'log') return { tag, log: windowLog(tag) };
    throw new Error('window action must be open | resume | stop | log');
  },

  // Save & Resume: the whole loop in one call.
  //   pins -> BLOCKS.md -> build --install -> switch the window to the new id
  //   -> reopen the editor on the session that is now running.
  'POST /api/save-resume': (body) => {
    if (!ws.dir) throw new Error('no session open');
    const settings = loadSettings();
    ws.pinReport = applyPins(ws.blocks, ws.pins);
    flushBlocks();
    const r = engine(['build', '--dir', ws.dir, '--install']);
    const parsed = parseBuild(r.out);
    if (r.code !== 0 || !parsed.newId || !parsed.installed) {
      return { ok: false, stage: 'build', out: r.out, summary: parsed };
    }
    const cwd = ws.config.cwd;
    let win = null;
    if (settings.resumeOnSave && body.resume !== false) {
      const tag = ws.window && listWindows().some((w) => w.tag === ws.window) ? ws.window : null;
      win = tag
        ? { ...resumeInWindow(tag, parsed.newId), reused: true }
        : { ...openSessionWindow({ sessionId: parsed.newId, cwd, shell: settings.shell, claudeArgs: settings.claudeArgs, claude: settings.claudePath || 'claude' }), reused: false };
      ws.window = win.tag;
    }
    // Reopen on the NEW session so the tree is the context that is now live.
    const out = workDirFor(parsed.installed);
    const ex = engine(['extract', '--session', parsed.installed, '--dir', out]);
    if (ex.code === 0) loadWorkspace(out);
    rememberRecent({ id: parsed.newId, cwd, path: parsed.installed });
    logLine(`save & resume -> ${parsed.newId}${win ? ` in window ${win.tag}${win.reused ? ' (same window)' : ' (new window)'}` : ''}`);
    return { ok: true, summary: parsed, out: r.out, window: win, state: stateView() };
  },

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
    const out = workDirFor(path);
    const r = engine(['extract', '--session', path, '--dir', out]);
    if (r.code !== 0) throw new Error(`extract failed:\n${r.out}`);
    loadWorkspace(out);
    rememberRecent({ id: ws.config.sessionId, cwd: ws.config.cwd, path });
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
    // Pins go in BEFORE the engine sees the blocks, every single build. That
    // is the whole guarantee: rewind, rebuild, resume -- the pin is re-applied
    // from its own store each time, so it cannot be edited or rewound away.
    ws.pinReport = applyPins(ws.blocks, ws.pins);
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
      pins: ws.pinReport,
    };
  },

  'GET /api/flow': (body, url) => {
    const which = url.searchParams.get('of') || 'source';
    const ratio = ws.config?.tokens?.charsPerToken || 4;
    const { trace, file } = traceFor(which);
    if (!trace) throw new Error(`no transcript to trace for ${which}`);
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
    const { trace } = traceFor(which);
    const f = trace?.calls?.[ci]?.frames?.[fi];
    if (!f) throw new Error(`no frame ${ci}/${fi}`);
    return f;
  },

  'POST /api/probe': (body) => {
    const { trace } = traceFor(body.of || 'source');
    if (!trace) throw new Error('nothing to probe');
    const hits = probe(trace, body.needle || '', { caseSensitive: !!body.caseSensitive });
    logLine(`probe ${JSON.stringify((body.needle || '').slice(0, 40))} -> ${hits.length} frame(s)`);
    return { needle: body.needle, hits };
  },

  // The engine, run synchronously, for the UI's own buttons. The interactive
  // terminal is /api/shell/* below.
  'POST /api/terminal': (body) => {
    const argv = String(body.cmd || '').trim().split(/\s+/).filter(Boolean);
    if (!argv.length) return { code: 0, out: '' };
    const verb = argv[0] === 'ctx' ? argv[1] : argv[0];
    const args = argv[0] === 'ctx' ? argv.slice(1) : argv;
    if (!VERBS.has(verb)) {
      return { code: 2, out: `brainstorm: "${verb}" is not an engine verb (allowed: ${[...VERBS].join(' ')}). Use the shell for anything else.` };
    }
    if (ws.dir && !args.includes('--dir') && ['extract', 'status', 'build'].includes(verb)) {
      args.push('--dir', ws.dir);
    }
    return engine(args);
  },

  // --- the shell ------------------------------------------------------------

  'GET /api/shell': (body, url) => {
    const sh = ensureShell();
    const since = Number(url.searchParams.get('since') || 0);
    return { ...sh.status(), lines: sh.since(since) };
  },

  'POST /api/shell': (body) => {
    const sh = ensureShell(body.cwd);
    const action = body.action || 'write';
    if (action === 'write') {
      const data = String(body.data ?? '');
      // An engine verb typed into the shell runs the BUNDLED engine, so the
      // terminal and the UI cannot drift onto two different implementations.
      const argv = data.trim().split(/\s+/).filter(Boolean);
      const verb = argv[0] === 'ctx' ? argv[1] : argv[0];
      if (argv.length && VERBS.has(verb) && argv[0] !== 'node') {
        const args = argv[0] === 'ctx' ? argv.slice(1) : argv;
        if (ws.dir && !args.includes('--dir') && ['extract', 'status', 'build'].includes(verb)) args.push('--dir', ws.dir);
        sh.push('in', data.trim());
        const r = engine(args);
        sh.push(r.code === 0 ? 'out' : 'err', r.out.replace(/\s+$/, ''));
        return { ...sh.status(), ran: 'engine' };
      }
      sh.write(data);
      return { ...sh.status(), ran: 'shell' };
    }
    if (action === 'interrupt') { sh.interrupt(); return sh.status(); }
    if (action === 'restart') { sh.restart(body.kind, body.cwd); return sh.status(); }
    throw new Error('shell action must be write | interrupt | restart');
  },

  // --- live session debugging ----------------------------------------------

  // --- a real terminal window on the desktop --------------------------------

  'GET /api/console': () => ({
    consoles: availableConsoles(),
    cwd: ws.config?.cwd || process.cwd(),
  }),

  'POST /api/console': (body) => {
    const cwd = body.cwd || ws.config?.cwd || process.cwd();
    const r = openConsole({ kind: body.kind, cwd, run: body.run || '' });
    logLine(`opened ${r.kind} window in ${cwd}${body.run ? ` running ${JSON.stringify(String(body.run).slice(0, 80))}` : ''}`);
    // Make sure the watcher is pointed at the directory that window will write
    // into, or a session started there would go unnoticed.
    ensureWatcher(cwd, ws.config?.tokens?.charsPerToken || 4);
    return r;
  },

  // --- the attach list: sessions, like a process list -----------------------

  'GET /api/sessions': (body, url) => {
    const cwd = url.searchParams.get('cwd') || ws.config?.cwd || process.cwd();
    const w = ensureWatcher(cwd, ws.config?.tokens?.charsPerToken || 4);
    const now = Date.now();
    const HOT_MS = 15000;
    const rows = w.list()
      .map((f) => ({
        ...f,
        idleMs: Math.max(0, now - f.mtimeMs),
        live: now - f.mtimeMs < HOT_MS,
        attached: ws.config?.sessionId === f.id,
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return {
      cwd,
      dir: w.dir,
      autoAttach: !!w.autoAttach,
      hotMs: HOT_MS,
      sessions: rows,
    };
  },

  'POST /api/sessions': (body) => {
    const w = ensureWatcher(body.cwd || ws.config?.cwd, ws.config?.tokens?.charsPerToken || 4);
    if (body.autoAttach !== undefined) {
      w.autoAttach = !!body.autoAttach;
      logLine(`auto-attach ${w.autoAttach ? 'on' : 'off'}`);
    }
    return { autoAttach: !!w.autoAttach };
  },

  'GET /api/live': (body, url) => {
    if (!watcher) return { watching: false, events: [], seq: 0 };
    const since = Number(url.searchParams.get('since') || 0);
    return { ...watcher.status(), events: watcher.since(since) };
  },

  'POST /api/live': (body) => {
    const w = ensureWatcher(body.cwd || ws.config?.cwd, ws.config?.tokens?.charsPerToken || 4);
    if (body.action === 'stop') { w.stop(); return w.status(); }
    if (body.action === 'start') { w.start(); return w.status(); }
    if (body.action === 'attach' && body.session) {
      // Open the session the watcher saw, so its blocks are editable at once.
      const { path } = resolveSession(body.session);
      const out = workDirFor(path);
      const r = engine(['extract', '--session', path, '--dir', out]);
      if (r.code !== 0) throw new Error(`extract failed:\n${r.out}`);
      loadWorkspace(out);
      return { ...w.status(), state: stateView() };
    }
    throw new Error('live action must be start | stop | attach');
  },

  // --- sticky context -------------------------------------------------------

  'POST /api/pin': (body) => {
    if (!ws.config) throw new Error('no session open');
    const { action } = body;
    if (action === 'add') {
      const pin = newPin({ text: body.text || '', anchor: body.anchor, blockId: body.blockId, label: body.label });
      ws.pins.push(pin);
    } else if (action === 'update') {
      const pin = ws.pins.find((p) => p.id === body.id);
      if (!pin) throw new Error(`no pin ${body.id}`);
      if (typeof body.text === 'string') pin.text = body.text;
      if (typeof body.label === 'string') pin.label = body.label;
      if (typeof body.enabled === 'boolean') pin.enabled = body.enabled;
      if (body.anchor) pin.anchor = body.anchor;
      if (body.blockId !== undefined) pin.blockId = body.blockId;
    } else if (action === 'remove') {
      // Strip it from the blocks BEFORE forgetting it exists.
      const gone = purgePin(ws.blocks, body.id);
      logLine(`pin remove ${body.id}: stripped from ${gone} block(s)`);
      ws.pins = ws.pins.filter((p) => p.id !== body.id);
    } else {
      throw new Error('pin needs action: add | update | remove');
    }
    savePins(ws.config.cwd, ws.pins);
    ws.pinReport = applyPins(ws.blocks, ws.pins);
    flushBlocks();
    logLine(`pin ${action} -> ${ws.pins.length} pin(s) for ${ws.config.cwd}`);
    return { ok: true, pins: ws.pins, report: ws.pinReport, state: stateView() };
  },

  // --- rewind ---------------------------------------------------------------

  'POST /api/rewind': (body) => {
    if (!ws.dir) throw new Error('no session open');
    const id = Number(body.blockId);
    const res = rewindTo(ws.blocks, id);
    for (const dropped of res.dropped) ws.dirty.add(dropped);
    // Re-apply AFTER the drop so a pin whose anchor just vanished re-homes
    // onto a block that survived instead of disappearing with it.
    ws.pinReport = applyPins(ws.blocks, ws.pins);
    flushBlocks();
    logLine(`rewind to block ${id}: dropped ${res.dropped.length}, pins re-applied`);
    return {
      ok: true,
      ...res,
      pins: ws.pinReport,
      state: stateView(),
    };
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

    // Re-open the session so the turn that just happened becomes editable
    // blocks immediately. `claude --resume` appends to the same transcript, so
    // re-extracting is what makes "every action shows its context" true rather
    // than a claim -- without it the tree still shows the pre-send session.
    let reopened = null;
    if (r.code === 0 && body.reopen !== false) {
      try {
        const { path } = resolveSession(sessionId);
        const out = workDirFor(path);
        const ex = engine(['extract', '--session', path, '--dir', out]);
        if (ex.code === 0) {
          loadWorkspace(out);
          reopened = stateView();
        } else {
          logLine(`re-extract after send failed: ${ex.out.split('\n')[0]}`);
        }
      } catch (err) {
        logLine(`re-extract after send failed: ${err.message}`);
      }
    }
    return { ...r, sessionId, cwd, state: reopened };
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
  // readUi refuses traversal, and inside the exe only registered assets exist.
  const body = readUi(rel);
  if (!body) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(rel)] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function startIde({ port = 7788, dir = null, session = null, exitWhenClosed = false, onListening = null } = {}) {
  if (dir) loadWorkspace(dir);
  else if (session) {
    const { path } = resolveSession(session);
    const out = workDirFor(path);
    const r = engine(['extract', '--session', path, '--dir', out]);
    if (r.code !== 0) throw new Error(`extract failed:\n${r.out}`);
    loadWorkspace(out);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/presence') return presence(req, res);
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
    const real = server.address().port;
    console.log(`\n  brainstorm IDE   http://127.0.0.1:${real}`);
    if (ws.dir) console.log(`  workspace        ${ws.dir}`);
    console.log('  loopback only. Ctrl+C to stop.\n');
    if (onListening) onListening(real);
  });

  // App mode: the server lives exactly as long as some window has it open.
  //
  // ⛔ This used to be a TIMER heartbeat: the page POSTed every 4 s and the
  // server exited after 15 s of silence. Edge throttles timers in a window
  // that is in the background, and after 5 minutes hidden it lets them fire
  // about once a MINUTE -- so the server decided the window had closed while
  // it was simply behind the terminal, exited, and left an open window whose
  // every request failed. Measured on a real report: the window had been
  // open 6 minutes and its port had nothing listening.
  //
  // Presence is now a held-open connection (/api/presence). A closed window
  // drops it at once; a background window keeps it, because throttling
  // delays timers and never closes sockets. The grace only covers a reload,
  // where the connection drops and comes straight back.
  if (exitWhenClosed) {
    const GRACE_MS = 10000;
    const t = setInterval(() => {
      if (!presenceSeen || presenceOpen > 0) { presenceZeroAt = 0; return; }
      if (!presenceZeroAt) presenceZeroAt = Date.now();
      if (Date.now() - presenceZeroAt > GRACE_MS) {
        console.log(`  ${new Date().toISOString()}  no window has been connected for ${GRACE_MS / 1000}s; exiting`);
        try { shell?.dispose(); } catch { /* ignore */ }
        process.exit(0);
      }
    }, 1000);
    t.unref();
  }
  return server;
}
