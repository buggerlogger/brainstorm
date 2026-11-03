// export.test.mjs — the zip writer and the export tree, checked by an
// INDEPENDENT reader.
//
//   node test/export.test.mjs
//
// A zip writer that only ever reads back its own output proves nothing: the
// writer and the reader would share every misunderstanding of the format. So
// the archive is listed and extracted by bsdtar (`tar`, shipped with Windows
// 10+) and, where present, PowerShell's Expand-Archive.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeZip } from '../src/core/zip.mjs';
import { buildEntries, writeFolder, safeName } from '../src/core/export.mjs';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
};
const step = (s) => console.log(`\n== ${s}`);

const work = mkdtempSync(join(tmpdir(), 'bs-export-'));

// ⛔ Name bsdtar by its full path. A bare `tar` resolved to GNU tar from Git
// Bash, which reads "C:\..." as host "C" plus a remote path and failed with
// "Cannot connect to C: resolve failed" -- an error about the TOOL, reported as
// if the archive were broken. Windows' own tar.exe is bsdtar and reads zip.
const TAR = process.platform === 'win32'
  ? join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe')
  : 'bsdtar';

try {
  step('the writer is spec-correct: a UTF-8 name, read by .NET');
  // The WRITER must handle any name correctly; .NET's System.IO.Compression is
  // an independent implementation and reads UTF-8 names exactly.
  {
    const uz = join(work, 'unicode.zip');
    const UNAME = 'root/02 العربية/0002 نص.txt';
    const UBODY = 'unicode body: مرحبا';
    writeZip(uz, [{ path: UNAME, content: UBODY }]);
    const raw = readFileSync(uz);
    check((raw.readUInt16LE(6) & 0x800) !== 0, 'general purpose bit 11 (UTF-8 names) is set');
    const ps1 = join(work, 'u.ps1');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(ps1, [
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `$z = [IO.Compression.ZipFile]::OpenRead('${uz}')`,
      '$e = $z.Entries[0]',
      '$r = New-Object IO.StreamReader($e.Open(), [Text.Encoding]::UTF8)',
      '$t = $r.ReadToEnd(); $r.Close(); $z.Dispose()',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
      '"NAME=" + $e.FullName',
      '"BODY=" + $t',
    ].join('\r\n'), 'utf8');
    const ps = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { encoding: 'utf8' });
    const got = Object.fromEntries(ps.stdout.split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    check(got.NAME === UNAME, '.NET reads the UTF-8 name exactly', got.NAME);
    check(got.BODY === UBODY, '.NET reads the UTF-8 body exactly');
  }

  step('an export zip survives EVERY reader, bsdtar included');
  // Export names are ASCII on purpose (see safeName): bsdtar on Windows skips
  // a non-ANSI name outright, even with hdrcharset=UTF-8. Contents stay UTF-8.
  const entries = [
    { path: 'root/README.txt', content: 'hello\n' },
    { path: `root/context/01 Task notifications/${safeName('0001 note')}.txt`, content: 'x'.repeat(5000) },   // deflated
    { path: `root/context/02 ${safeName('العربية')}/${safeName('0002 نص')}.txt`, content: 'unicode body: مرحبا\n' },
    { path: `root/context/03 ${safeName('Résumé café')}/x.txt`, content: 'accents fold\n' },
    { path: 'root/bin/random.dat', content: Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 2654435761) & 255)) }, // stored
    { path: 'root/empty.txt', content: '' },
  ];
  check(entries.every((e) => /^[\x20-\x7e]+$/.test(e.path)), 'every export name is printable ASCII');
  check(entries[3].path.includes('Resume cafe'), 'accents fold to their base letter rather than vanishing', entries[3].path);

  const zip = join(work, 'test.zip');
  const r = writeZip(zip, entries);
  check(existsSync(zip) && r.bytes > 0, 'archive written', `${r.entries} entries, ${r.bytes} B`);

  const list = spawnSync(TAR, ['-tf', zip], { encoding: 'utf8' });
  check(list.status === 0, 'bsdtar lists it with no error', list.stderr.trim());
  const listed = list.stdout.split(/\r?\n/).filter(Boolean);
  check(listed.length === entries.length, 'bsdtar sees every entry', `${listed.length} of ${entries.length}`);

  const out = join(work, 'x');
  spawnSync('cmd.exe', ['/c', 'mkdir', out]);
  const ex = spawnSync(TAR, ['-xf', zip, '-C', out], { encoding: 'utf8' });
  check(ex.status === 0, 'bsdtar extracts it with no error', ex.stderr.trim());
  for (const e of entries) {
    const f = join(out, ...e.path.split('/'));
    const want = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content, 'utf8');
    const got = existsSync(f) ? readFileSync(f) : null;
    check(!!got && got.equals(want), `byte-identical after bsdtar: ${e.path.split('/').pop()}`, got ? `${got.length} B` : 'missing');
  }

  const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; ([IO.Compression.ZipFile]::OpenRead('${zip}')).Entries.Count`],
  { encoding: 'utf8' });
  if (ps.status === 0) check(Number(ps.stdout.trim()) === entries.length, '.NET ZipFile agrees on the entry count', ps.stdout.trim());

  step('safe names for Windows');
  check(safeName('a<b>c:d"e/f\\g|h?i*j') === 'a_b_c_d_e_f_g_h_i_j', 'reserved characters are replaced');
  check(safeName('trailing dots...') === 'trailing dots', 'trailing dots are trimmed (Windows drops them silently)');
  check(safeName('') === '_', 'an empty name becomes a placeholder, not a missing file');

  step('the export tree from a real extract');
  // Any extract folder the IDE left behind will do.
  const base = join(tmpdir(), 'brainstorm-ide');
  const dir = existsSync(base) ? readdirSync(base).map((d) => join(base, d)).find((d) => existsSync(join(d, 'BLOCKS.md'))) : null;
  if (!dir) {
    console.log('  SKIP  no extract folder yet (open a session in the IDE once)');
  } else {
    const { parseBlocks } = await import('../src/core/blocksmd.mjs');
    const { readTranscript } = await import('../src/core/transcript.mjs');
    const { traceFlow } = await import('../src/core/flow.mjs');
    const config = JSON.parse(readFileSync(join(dir, 'CONFIG.json'), 'utf8'));
    const { header, blocks } = parseBlocks(join(dir, 'BLOCKS.md'));
    const trace = existsSync(config.source) ? traceFlow(readTranscript(config.source), 4) : null;
    const tree = buildEntries({ name: 'exp', config, blocks, header, trace, settings: { exportFlow: 'last' } });

    const ctx = tree.filter((e) => e.path.includes('/context/'));
    check(ctx.length === blocks.length, 'one context file per block', `${ctx.length} files, ${blocks.length} blocks`);
    check(tree.some((e) => e.path.endsWith('README.txt')), 'README written');
    check(tree.some((e) => e.path.endsWith('session/BLOCKS.md')), 'BLOCKS.md included so the export can be re-imported');
    const sorted = tree.map((e) => e.path);
    check(sorted.every((p, i) => i === 0 || sorted[i - 1] <= p), 'entries are sorted, so zip order matches folder order');

    const fdir = join(work, 'folder');
    const w = writeFolder(fdir, tree);
    check(w.files === tree.length, 'folder export wrote every file', `${w.files} files, ${w.bytes} B`);

    // every block's text must be recoverable from its file
    const firstCtx = ctx[0];
    const onDisk = readFileSync(join(fdir, ...firstCtx.path.split('/')), 'utf8');
    check(onDisk === firstCtx.content, 'a context file holds the block text exactly');

    const z = writeZip(join(work, 'session.zip'), tree);
    const l2 = spawnSync(TAR, ['-tf', z.file], { encoding: 'utf8' });
    check(l2.status === 0 && l2.stdout.split(/\r?\n/).filter(Boolean).length === tree.length, 'the session zip lists cleanly in bsdtar', `${tree.length} entries`);
  }
} catch (err) {
  console.error(`\n  ERROR  ${err.stack || err.message}`);
  failures++;
} finally {
  try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures ? 1 : 0);
