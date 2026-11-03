// Copyright (c) 2026 buggerlogger. All rights reserved.
// Proprietary and confidential. No license is granted to use, copy, modify or
// distribute this file, in whole or in part. See LICENSE.
//
// shell.test.mjs — the real terminal and live session detection.
//
//   node test/shell.test.mjs [http://127.0.0.1:7788]
//
// The claim under test is the one that is easy to fake: that starting a Claude
// session is DETECTED and reported as jumps and calls. So this test actually
// runs `claude -p` through the IDE's own shell and asserts the watcher saw it.

const BASE = process.argv[2] || 'http://127.0.0.1:7788';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body) {
  const opt = body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(BASE + path, opt);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 300) }; }
  if (!res.ok || data.error) throw new Error(data.error || `${res.status} ${path}`);
  return data;
}

// Wait until `pred` is true of the shell output, or give up.
async function waitForOutput(sinceSeq, pred, ms = 30000) {
  const end = Date.now() + ms;
  let seq = sinceSeq;
  let acc = [];
  while (Date.now() < end) {
    const r = await api(`/api/shell?since=${seq}`);
    if (r.lines.length) {
      seq = r.lines[r.lines.length - 1].seq;
      acc = acc.concat(r.lines);
      if (pred(acc)) return { ok: true, seq, lines: acc };
    }
    await sleep(400);
  }
  return { ok: false, seq, lines: acc };
}

try {
  step('shell status');
  const st = await api('/api/shell');
  check(st.running === true, 'a shell is running', `${st.kind} pid ${st.pid}`);
  check(st.pty === false, 'it reports honestly that it is NOT a pty', st.note?.slice(0, 60));
  check(Array.isArray(st.shells) && st.shells.length > 0, 'it lists the shells available here', st.shells.join(', '));
  let seq = st.seq;

  step('run an ordinary command, like a normal terminal');
  await api('/api/shell', { action: 'write', data: 'echo brainstorm-shell-probe-7731' });
  const echoed = await waitForOutput(seq, (ls) => ls.some((l) => l.stream !== 'in' && l.text.includes('brainstorm-shell-probe-7731')));
  check(echoed.ok, 'the command ran and its output came back', echoed.lines.filter((l) => l.text.trim()).slice(-1)[0]?.text);
  seq = echoed.seq;

  step('the typed line is echoed back (a pipe gives no terminal echo)');
  check(echoed.lines.some((l) => l.stream === 'in' && l.text.includes('echo brainstorm-shell-probe')), 'input appears in the stream');

  step('an engine verb typed into the shell runs the BUNDLED engine');
  await api('/api/shell', { action: 'write', data: 'status' });
  const eng = await waitForOutput(seq, (ls) => ls.some((l) => /blocks|no session|ctx status|session/i.test(l.text)));
  check(eng.ok, 'the engine answered', eng.lines.filter((l) => l.stream !== 'in' && l.text.trim()).slice(-1)[0]?.text?.slice(0, 70));
  seq = eng.seq;

  step('live watcher');
  const live0 = await api('/api/live');
  check(live0.watching === true, 'the watcher is running', live0.dir);
  let liveSeq = live0.seq;

  step('start a real Claude session IN THE SHELL and see it detected');
  // -p so it completes without a TTY. The watcher does not care how it was
  // started; it watches the transcript directory.
  await api('/api/shell', {
    action: 'write',
    data: 'claude -p "reply with exactly: BRAINSTORM-LIVE-OK" --permission-mode bypassPermissions',
  });

  const end = Date.now() + 180000;
  let events = [];
  while (Date.now() < end) {
    const r = await api(`/api/live?since=${liveSeq}`);
    if (r.events.length) {
      liveSeq = r.events[r.events.length - 1].seq;
      events = events.concat(r.events);
      if (events.some((e) => e.type === 'jump')) break;
    }
    await sleep(900);
  }

  const started = events.filter((e) => e.type === 'session-started');
  const jumps = events.filter((e) => e.type === 'jump');
  const calls = events.filter((e) => e.type === 'call');
  console.log(`    events: ${events.map((e) => e.type).join(', ') || '(none)'}`);
  check(started.length > 0 || jumps.length > 0, 'the watcher noticed a session', `${started.length} started, ${jumps.length} jump(s)`);
  check(jumps.length > 0, 'at least one JUMP was reported (an API call into the model)', jumps.length ? `call ${jumps[0].call}, ~${jumps[0].tokens} tok, ${jumps[0].frames} frames` : 'none');
  if (jumps.length) {
    const j = jumps[0];
    check(j.chars > 0 && j.tokens > 0, 'the jump carries a real context size', `${j.chars} ch / ~${j.tokens} tok`);
    check(typeof j.session === 'string' && j.session.length > 8, 'the jump names its session', j.session);
  }
  console.log(`    calls reported: ${calls.length}${calls.length ? ` (${calls.slice(0, 3).map((c) => c.label).join('; ')})` : ''}`);

  step('attach the IDE to the session the watcher saw');
  const target = (jumps[0] || started[0])?.session;
  if (target) {
    const att = await api('/api/live', { action: 'attach', session: target });
    check(!!att.state?.open, 'the IDE opened the live session', att.state?.config?.sessionId);
    check(att.state.totals.blocks > 0, 'its blocks are editable', `${att.state.totals.blocks} blocks`);
    const folders = att.state.groups.map((g) => g.name);
    console.log(`    folders: ${folders.join(' · ')}`);
  } else {
    check(false, 'had a session to attach to');
  }
} catch (err) {
  console.error(`\n  ERROR  ${err.message}`);
  failures++;
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
