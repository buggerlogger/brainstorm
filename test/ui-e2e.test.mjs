// ui-e2e.test.mjs — drive the real UI in headless Edge over the DevTools
// protocol, and fail on ANY uncaught exception or console error.
//
//   node test/ui-e2e.test.mjs [http://127.0.0.1:7788] [--shot out.png]
//
// The server must be running with NO session open, so the start gate shows.
//
// Why this exists: ui.test.mjs checks wiring statically, and a TypeError at
// boot passes every static check. This loads the page, uses it the way a
// person would -- search the gate, open a session, right-click, search for
// strings, open settings -- and collects every Runtime.exceptionThrown and
// console error on the way. A throwaway profile directory is used, so nothing
// from anyone's real browser is read.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:7788';
const SHOT = (() => { const i = process.argv.indexOf('--shot'); return i > 0 ? process.argv[i + 1] : null; })();
const PORT = 9339;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findEdge() {
  for (const r of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)) {
    const p = join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    if (existsSync(p)) return p;
  }
  return null;
}

// --- a minimal CDP client ---------------------------------------------------
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { ok, no } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) no(new Error(msg.error.message)); else ok(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) h(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, no) => this.pending.set(id, { ok, no }));
  }
  on(fn) { this.handlers.push(fn); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}

async function waitFor(cdp, expr, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await cdp.eval(expr)) return true; } catch { /* page still loading */ }
    await sleep(250);
  }
  return false;
}

const edge = findEdge();
if (!edge) { console.log('  SKIP  Edge not found'); process.exit(0); }
const profile = mkdtempSync(join(tmpdir(), 'bs-e2e-'));
const browser = spawn(edge, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1500,950', 'about:blank',
], { stdio: 'ignore' });

const errors = [];
let cdp;
try {
  step('launch headless Edge with a throwaway profile');
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
    if (!target) await sleep(250);
  }
  check(!!target, 'DevTools endpoint is up');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.addEventListener('open', ok); ws.addEventListener('error', no); });
  cdp = new Cdp(ws);
  cdp.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push(`exception: ${d.exception?.description?.split('\n')[0] || d.text} @ ${d.url || ''}:${d.lineNumber}`);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !/favicon/.test(m.params.entry.url || '')) {
      errors.push(`log: ${m.params.entry.text} ${m.params.entry.url || ''}`);
    }
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: `${BASE}/` });

  step('the start gate');
  // A fresh app has no session, so the gate is up at boot. If the server
  // already has one open (a reload, or a previous run), the gate correctly
  // stays down -- and Ctrl+O must bring it up. Both paths are real; the test
  // takes whichever this server is in and says which.
  await waitFor(cdp, `typeof S !== 'undefined' && S.state !== null && document.readyState === 'complete'`);
  const preOpen = await cdp.eval(`!!(S.state && S.state.open)`);
  if (preOpen) {
    console.log('    (server already has a session open: the gate stays down at boot, as it should)');
    check(await cdp.eval(`document.querySelector('#gate').hidden`), 'with a session open, the gate does not block a reload');
    await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'o',ctrlKey:true,bubbles:true}))`);
    check(await waitFor(cdp, `!document.querySelector('#gate').hidden`), 'Ctrl+O opens the gate');
  } else {
    check(await waitFor(cdp, `!!document.querySelector('#gate') && !document.querySelector('#gate').hidden`), 'with no session, the gate is shown at boot');
  }
  check(await cdp.eval(`document.body.classList.contains('gated')`), 'the app behind it is blurred and inert (body.gated)');
  check(await cdp.eval(`getComputedStyle(document.querySelector('#gate')).backdropFilter.includes('blur')`), 'the backdrop really is a blur filter');
  check(await waitFor(cdp, `document.querySelectorAll('#gate-list .gate-row').length > 0`), 'sessions are listed with an empty query');
  if (SHOT) {
    await sleep(300);
    const g = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const gateShot = SHOT.replace(/\.png$/i, '') + '-gate.png';
    writeFileSync(gateShot, Buffer.from(g.data, 'base64'));
    console.log(`    gate screenshot -> ${gateShot}`);
  }
  const total = await cdp.eval(`document.querySelector('#gate-count').textContent`);
  console.log(`    ${total}`);

  step('type in the gate and open a session');
  // Pick a modest session through the API so the test does not depend on
  // which sessions happen to be newest.
  const pick = await cdp.eval(`fetch('/api/find-sessions?q=').then(r=>r.json()).then(r=>{
    const s=r.results.find(x=>x.bytes>20000&&x.bytes<3e6&&!x.duplicate); return s?{id:s.id,path:s.path}:null })`);
  check(!!pick, 'found a session to open', pick?.id);
  await cdp.eval(`(()=>{const q=document.querySelector('#gate-q'); q.value=${JSON.stringify(pick.id.slice(0, 8))}; q.dispatchEvent(new Event('input'));})()`);
  check(await waitFor(cdp, `[...document.querySelectorAll('#gate-list .gate-row .id')].some(n=>n.textContent===${JSON.stringify(pick.id.slice(0, 8))})`), 'typing an id prefix finds it');
  check(await cdp.eval(`document.querySelector('#gate-list .gate-row.sel .id')?.textContent === ${JSON.stringify(pick.id.slice(0, 8))}`), 'and ranks it first');
  // no terminal window in a test
  await cdp.eval(`document.querySelector('#gate-console').checked = false`);
  await cdp.eval(`document.querySelector('#gate-q').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`);
  check(await waitFor(cdp, `document.querySelector('#gate').hidden && !document.body.classList.contains('gated')`, 30000), 'Enter opens it and the gate goes away');
  check(await waitFor(cdp, `S.state && S.state.open && S.state.config.sessionId === ${JSON.stringify(pick.id)}`), 'the editor is on that session');
  check(await waitFor(cdp, `document.querySelectorAll('#tree .node[data-folder]').length > 0`), 'the Explorer shows folders');

  step('right-click menus');
  // The gate expands the first folder on open, so a blind click would
  // COLLAPSE it. Expand one only if no block is showing yet.
  await cdp.eval(`(()=>{
    if (document.querySelector('#tree .node[data-block-id]')) return;
    const f=[...document.querySelectorAll('#tree .node[data-folder]')].find(n=>n.querySelector('.tw').textContent==='▸');
    if (f) f.click(); })()`);
  check(await waitFor(cdp, `!!document.querySelector('#tree .node[data-block-id]')`), 'a folder is expanded and shows its blocks');
  const menuItems = await cdp.eval(`(()=>{
    const n=document.querySelector('#tree .node[data-block-id]');
    const r=n.getBoundingClientRect();
    n.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+20,clientY:r.top+5}));
    const m=document.querySelector('#ctxmenu');
    return m.hidden ? null : [...m.querySelectorAll('.mi .lb')].map(x=>x.textContent) })()`);
  check(Array.isArray(menuItems) && menuItems.length > 5, 'right-clicking a block opens its menu', menuItems ? `${menuItems.length} items` : 'no menu');
  for (const want of ['Who read it?', 'Search in strings…', 'Rewind to here…']) {
    check(!!menuItems?.includes(want), `block menu has "${want}"`);
  }
  check(!!menuItems?.some((m) => /as ZIP/.test(m)), 'block menu offers a ZIP export of its folder');
  await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  check(await cdp.eval(`document.querySelector('#ctxmenu').hidden`), 'Escape closes the menu');

  const globalItems = await cdp.eval(`(()=>{
    const t=document.querySelector('.editor-meta');
    t.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:600,clientY:80}));
    return [...document.querySelectorAll('#ctxmenu .mi .lb')].map(x=>x.textContent) })()`);
  check(globalItems.some((x) => /Dump the whole context/.test(x)), 'the general menu offers "dump context to folders"');
  await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);

  step('who read it');
  await cdp.eval(`brainstorm.showReaders({ blockId: Number(document.querySelector('#tree .node[data-block-id]').dataset.blockId) })`);
  check(await waitFor(cdp, `!!document.querySelector('#frame-readers h4')`), 'the readers panel renders');
  const readers = await cdp.eval(`document.querySelector('#frame-readers').textContent`);
  console.log(`    ${readers.replace(/\s+/g, ' ').slice(0, 120)}`);

  step('search for strings');
  await cdp.eval(`brainstorm.searchStrings('the')`);
  check(await waitFor(cdp, `document.querySelectorAll('#strings-results .srow').length > 0`, 20000), 'strings search returns rows');
  check(await cdp.eval(`!!document.querySelector('#strings-results mark')`), 'matches are highlighted');

  step('settings');
  await cdp.eval(`document.querySelector('.act[data-view="settings"]').click()`);
  check(await waitFor(cdp, `document.querySelectorAll('#settings-form [data-key]').length > 10`), 'the settings form renders from the schema');

  step('debugger + follow');
  await cdp.eval(`document.querySelector('.act[data-view="debug"]').click()`);
  check(await waitFor(cdp, `S.trace && S.trace.calls.length > 0`, 20000), 'the session was traced on open');
  check(await cdp.eval(`!!document.querySelector('#opt-follow')`), 'the follow toggle exists');

  if (SHOT) {
    await cdp.eval(`document.querySelector('.act[data-view="explorer"]').click()`);
    await sleep(400);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`\n  screenshot -> ${SHOT}`);
  }

  step('no runtime errors anywhere along the way');
  check(errors.length === 0, 'no uncaught exception, no console error', errors.length ? `\n      ${errors.slice(0, 10).join('\n      ')}` : '');
} catch (err) {
  console.error(`\n  ERROR  ${err.stack || err.message}`);
  if (errors.length) console.error(`  page errors:\n    ${errors.join('\n    ')}`);
  failures++;
} finally {
  try { cdp?.ws.close(); } catch { /* ignore */ }
  try { browser.kill(); } catch { /* ignore */ }
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* locked briefly by Edge; harmless */ }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
