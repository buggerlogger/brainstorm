// zip.mjs — write a .zip with nothing but node:zlib.
//
// PKZIP 2.0: local header + deflated data per entry, a central directory, and
// an end record. UTF-8 names (general-purpose bit 11), so a folder called
// "Task notifications" or a file name in Arabic survives the round trip.
// CRC-32 is zlib.crc32 (Node 22+), the same polynomial ZIP uses.
//
// No ZIP64: the classic format caps at 65,535 entries and 4 GiB. An export
// that would exceed either is REFUSED with a reason rather than written as an
// archive that every unzip tool reports as corrupt.

import { openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';

const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export function writeZip(file, entries) {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`${entries.length} entries exceeds the ZIP limit of ${MAX_ENTRIES}; export to a folder instead`);
  }
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, 'w');
  const central = [];
  let offset = 0;
  const now = dosTime(new Date());

  const put = (buf) => {
    writeSync(fd, buf);
    offset += buf.length;
    if (offset > MAX_BYTES) throw new Error('archive exceeds 4 GiB; export to a folder instead');
  };

  try {
    for (const e of entries) {
      const name = Buffer.from(e.path.replace(/\\/g, '/'), 'utf8');
      const raw = Buffer.isBuffer(e.content) ? e.content : Buffer.from(String(e.content ?? ''), 'utf8');
      const deflated = deflateRawSync(raw, { level: 6 });
      // Store instead of deflate when compression does not help -- already
      // compressed data, or tiny files where the deflate header costs more.
      const useStore = deflated.length >= raw.length;
      const data = useStore ? raw : deflated;
      const method = useStore ? 0 : 8;
      const crc = crc32(raw) >>> 0;
      const localOffset = offset;

      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0);
      h.writeUInt16LE(20, 4);           // version needed
      h.writeUInt16LE(0x0800, 6);       // UTF-8 names
      h.writeUInt16LE(method, 8);
      h.writeUInt16LE(now.time, 10);
      h.writeUInt16LE(now.date, 12);
      h.writeUInt32LE(crc, 14);
      h.writeUInt32LE(data.length, 18);
      h.writeUInt32LE(raw.length, 22);
      h.writeUInt16LE(name.length, 26);
      h.writeUInt16LE(0, 28);
      put(h);
      put(name);
      put(data);

      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);           // made by
      c.writeUInt16LE(20, 6);           // needed
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(method, 10);
      c.writeUInt16LE(now.time, 12);
      c.writeUInt16LE(now.date, 14);
      c.writeUInt32LE(crc, 16);
      c.writeUInt32LE(data.length, 20);
      c.writeUInt32LE(raw.length, 24);
      c.writeUInt16LE(name.length, 28);
      c.writeUInt16LE(0, 30);           // extra
      c.writeUInt16LE(0, 32);           // comment
      c.writeUInt16LE(0, 34);           // disk
      c.writeUInt16LE(0, 36);           // internal attrs
      c.writeUInt32LE(0, 38);           // external attrs
      c.writeUInt32LE(localOffset, 42);
      central.push(Buffer.concat([c, name]));
    }

    const cdStart = offset;
    for (const c of central) put(c);
    const cdSize = offset - cdStart;

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdStart, 16);
    end.writeUInt16LE(0, 20);
    put(end);
  } finally {
    closeSync(fd);
  }
  return { file, entries: entries.length, bytes: offset };
}
