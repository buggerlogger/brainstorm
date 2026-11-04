// Copyright 2026 buggerlogger (https://github.com/buggerlogger)
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
//
// test-skillswap.mjs — end-to-end proof that ctx.mjs can swap a LOADED SKILL
// out of a live session's context.
//
//   node test-skillswap.mjs [--keep]
//
// Why a skill and not a user message: a skill body is the hardest thing in a
// transcript to edit completely. One invocation scatters the skill's identity
// across six places -- the tool_use input, the tool_result, the injected body,
// wireToolInputs, toolUseResult.commandName and attributionSkill -- and a Stop
// hook may quote a truncated copy of the whole turn on top of that. Editing a
// plain message exercises none of this.
//
// The two skills differ in four facts, and TWO of them (staging host, shutdown
// sequence) appear ONLY inside the skill body and never in any assistant text.
// Asking for those is what makes the result falsifiable: if the model answered
// from its own earlier reply instead of the swapped body, it cannot know them.
//
// Exit 0 = the swap took. Non-zero = it did not, with the reason.

import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CTX = join(HERE, '..', 'src', 'ctx.mjs');   // the engine moved under src/ in this repo
const KEEP = process.argv.includes('--keep');

const PROJECT = join(tmpdir(), `ctx-skillswap-${Date.now()}`);
const WORK = join(PROJECT, 'work');
let SESSION = randomUUID();
const NEW_ID = randomUUID();

const ALPHA = {
  id: 'alpha-protocol',
  name: 'ALPHA',
  code: 'ZEPHYR-4417',
  host: 'alpha-stage.internal:8041',
  halt: 'drain queue, then `alphactl halt --grace 30`',
};
const OMEGA = {
  id: 'omega-protocol',
  name: 'OMEGA',
  code: 'CALDERA-9823',
  host: 'omega-stage.internal:9823',
  halt: 'freeze writers, then `omegactl halt --grace 90`',
};

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);

function skillFile(p) {
  return [
    '---',
    `name: ${p.id}`,
    `description: Use when the user asks about the ${p.name} deployment protocol, its clearance code, or its shutdown sequence.`,
    '---',
    '',
    `# ${p.name} Protocol`,
    '',
    `You are operating under the ${p.name} deployment protocol.`,
    '',
    `- Protocol name: **${p.name}**`,
    `- Clearance code: **${p.code}**`,
    `- Staging host: \`${p.host}\``,
    `- Shutdown sequence: ${p.halt}`,
    '',
    `When asked which protocol is loaded, answer ${p.name} and quote the clearance code`,
    'exactly as written above.',
    '',
  ].join('\n');
}

// claude is an npm shim on Windows, so it needs a shell to resolve.
function claude(args) {
  const r = spawnSync('claude', args, {
    cwd: WORK,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function ctx(args) {
  const r = spawnSync(process.execPath, [CTX, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

try {
  step(`scaffold  ${PROJECT}`);
  for (const p of [ALPHA, OMEGA]) {
    const dir = join(WORK, '.claude', 'skills', p.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), skillFile(p));
  }
  check(existsSync(join(WORK, '.claude', 'skills', ALPHA.id, 'SKILL.md')), 'both skills written');

  step('control: load ALPHA in a fresh session');
  // The Claude API sometimes answers with an error ("... Message ID: msg_...")
  // instead of a reply. That is not a brainstorm failure, so the control is
  // retried -- each time with a fresh session id, since a failed attempt may
  // already have created the old one -- and an API error is named as such.
  const apiError = (out) => /API Error|Message ID: msg_|overloaded|rate limit/i.test(out);
  let c1;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) SESSION = randomUUID();
    c1 = claude([
      '-p', `"Invoke the ${ALPHA.id} skill now, then reply with one line: the protocol name and its clearance code."`,
      '--session-id', SESSION,
      '--permission-mode', 'bypassPermissions',
    ]);
    if (c1.out.includes(ALPHA.code) || !apiError(c1.out)) break;
    console.log(`    attempt ${attempt}: the Claude API returned an error; retrying`);
  }
  // on an API error, the line that says WHAT failed, not only its message id
  const outLines = c1.out.trim().split('\n');
  const last = (apiError(c1.out) && outLines.find((l) => /API Error/i.test(l))) || outLines.pop();
  check(c1.out.includes(ALPHA.code), 'control answer quotes the ALPHA code',
    apiError(c1.out) && !c1.out.includes(ALPHA.code) ? `the Claude API kept failing (not a brainstorm error): ${last}` : last);
  if (!c1.out.includes(ALPHA.code)) throw new Error('control failed; the swap test would be meaningless');

  step('extract');
  const outDir = join(PROJECT, 'edit');
  const ex = ctx(['extract', '--session', SESSION, '--dir', outDir]);
  check(ex.code === 0, 'extract exited 0');
  const blocksPath = join(outDir, 'BLOCKS.md');
  check(existsSync(blocksPath), 'BLOCKS.md written');

  const before = readFileSync(blocksPath, 'utf8');
  check(before.includes(`# ${ALPHA.name} Protocol`), 'the skill BODY is an editable block');
  check(before.includes(ALPHA.host), 'body-only facts are in the block');

  step('swap ALPHA -> OMEGA in the blocks');
  let text = before;
  const swaps = [
    [ALPHA.id, OMEGA.id],
    [ALPHA.name, OMEGA.name],
    [ALPHA.code, OMEGA.code],
    [ALPHA.host, OMEGA.host],
    [ALPHA.halt, OMEGA.halt],
  ];
  for (const [from, to] of swaps) {
    const n = text.split(from).length - 1;
    check(n > 0, `substituted ${from} -> ${to}`, `${n}x`);
    text = text.split(from).join(to);
  }
  writeFileSync(blocksPath, text);

  step('build + install');
  const b = ctx([
    'build', '--dir', outDir, '--new-id', NEW_ID, '--install',
    '--rename', `${ALPHA.code}=${OMEGA.code}`,
    '--rename', `${ALPHA.name}=${OMEGA.name}`,
  ]);
  console.log(b.out.split('\n').filter((l) => l.trim()).map((l) => `    ${l}`).join('\n'));
  check(b.code === 0, 'build exited 0');
  check(/verify\s+OK/.test(b.out), 'verify OK');
  // ⛔ Not a fixed 3. The model's answer is sometimes written as TWO assistant
  // records, each with its own attributionSkill, so the source can carry 3 or
  // 4 mirrors depending on how the reply was chunked. The exact invariant is
  // that the engine synced every mirror the SOURCE contains -- counted here
  // from the source rather than assumed.
  const MIRROR_KEYS = ['wireToolInputs', 'toolUseResult', 'attributionSkill'];
  let inSource = 0;
  // The source path as the ENGINE recorded it, not re-derived from the cwd.
  const sourceFile = JSON.parse(readFileSync(join(outDir, 'CONFIG.json'), 'utf8')).source;
  for (const line of readFileSync(sourceFile, 'utf8').split('\n')) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    for (const k of MIRROR_KEYS) {
      if (r[k] !== undefined) inSource += (JSON.stringify(r[k]).match(new RegExp(ALPHA.id, 'g')) || []).length;
    }
  }
  const synced = Number((b.out.match(/tool mirrors\s+(\d+)/) || [])[1]);
  check(inSource >= 3 && synced === inSource, 'every tool-mirror occurrence in the source was synced', `${synced} synced, ${inSource} in the source`);

  // Take the destination from what build REPORTED, not from a second copy of
  // the cwd-to-project-dir encoding. A duplicated encoding is exactly how the
  // old --install-to came to write into a folder Claude Code never reads.
  const line = b.out.split('\n').find((l) => l.includes('installed '));
  const installed = line ? line.replace(/^\s*installed\s+/, '').trim() : '';
  check(!!installed && existsSync(installed), 'installed into the project dir', installed || '(build printed no path)');
  if (!installed || !existsSync(installed)) throw new Error('nothing installed; cannot resume');
  const raw = readFileSync(installed, 'utf8');
  const count = (s) => raw.split(s).length - 1;
  check(count(ALPHA.code) === 0, 'zero copies of the ALPHA clearance code remain', `${count(ALPHA.code)} found`);
  check(count(ALPHA.name) === 0, 'zero copies of the ALPHA protocol name remain', `${count(ALPHA.name)} found`);
  check(count(`"commandName":"${OMEGA.id}"`) === 1, 'toolUseResult.commandName rewritten');
  check(count(`"attributionSkill":"${OMEGA.id}"`) >= 1, 'attributionSkill rewritten');
  check(count(`{"skill":"${OMEGA.id}"}`) >= 1, 'wireToolInputs rewritten');

  step('resume the edited session and ask for BODY-ONLY facts');
  const c2 = claude([
    '-p', '--resume', NEW_ID,
    '"Without reading any files and without invoking a skill, answer from the protocol skill already loaded in this conversation: give the protocol name, clearance code, staging host, and the exact shutdown sequence."',
    '--permission-mode', 'bypassPermissions',
  ]);
  const ans = c2.out;
  console.log(ans.split('\n').filter((l) => l.trim()).map((l) => `    ${l}`).join('\n'));
  check(ans.includes(OMEGA.name), 'answer names OMEGA');
  check(ans.includes(OMEGA.code), 'answer quotes the OMEGA clearance code');
  check(ans.includes('omega-stage.internal:9823'), 'answer quotes the OMEGA staging host (body-only)');
  check(ans.includes('omegactl halt --grace 90'), 'answer quotes the OMEGA shutdown sequence (body-only)');
  check(!ans.includes(ALPHA.code), 'answer does NOT mention the ALPHA code');
  check(!ans.includes(ALPHA.host), 'answer does NOT mention the ALPHA host');

  step('the resumed turn must not have re-read the skill from disk');
  const resumed = readFileSync(installed, 'utf8').split('\n').filter(Boolean);
  let skillCalls = 0;
  for (const line of resumed) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const parts = r?.message?.content;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) if (p.type === 'tool_use' && p.name === 'Skill') skillCalls++;
  }
  check(skillCalls === 1, 'exactly one Skill call in the file -- the edited historical one', `${skillCalls} found`);
} catch (err) {
  console.error(`\n  ERROR  ${err.message}`);
  failures++;
} finally {
  if (KEEP) console.log(`\nkept  ${PROJECT}`);
  else {
    try { rmSync(PROJECT, { recursive: true, force: true }); } catch {}
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
