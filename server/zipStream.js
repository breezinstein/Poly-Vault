'use strict';

// Minimal streaming ZIP writer (deflate, UTF-8 names, data descriptors).
//
// Why hand-rolled: the runtime image has no zip/python and the root filesystem
// is read-only, so we cannot shell out or buffer gigabytes in /tmp (tmpfs =
// RAM). This streams straight to the HTTP response. Asset libraries are mostly
// already-compressed payloads (png/fbx/unitypackage), so deflate level 1 is a
// good speed/size trade-off.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Transform } = require('stream');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32Update(crc, buf) {
  let c = crc ^ -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const U32_MAX = 0xffffffff;
const EOCD = 0x06054b50;
const CDIR = 0x02014b50;
const LOCAL = 0x04034b50;
const DESCRIPTOR = 0x08074b50;

function dosDateTime(date) {
  const d = date || new Date();
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const day = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, day };
}

function localHeader(nameBuf, method, mtime) {
  const { time, day } = dosDateTime(mtime);
  const buf = Buffer.alloc(30);
  buf.writeUInt32LE(LOCAL, 0);
  buf.writeUInt16LE(20, 4);        // version needed
  buf.writeUInt16LE(0x0808, 6);    // bit 3 (descriptor) + bit 11 (UTF-8)
  buf.writeUInt16LE(method, 8);
  buf.writeUInt16LE(time, 10);
  buf.writeUInt16LE(day, 12);
  buf.writeUInt32LE(0, 14);        // crc (in descriptor)
  buf.writeUInt32LE(0, 18);        // compressed size (in descriptor)
  buf.writeUInt32LE(0, 22);        // uncompressed size (in descriptor)
  buf.writeUInt16LE(nameBuf.length, 26);
  buf.writeUInt16LE(0, 28);        // extra length
  return Buffer.concat([buf, nameBuf]);
}

function descriptor(crc, compressed, uncompressed) {
  const buf = Buffer.alloc(16);
  buf.writeUInt32LE(DESCRIPTOR, 0);
  buf.writeUInt32LE(crc, 4);
  buf.writeUInt32LE(compressed, 8);
  buf.writeUInt32LE(uncompressed, 12);
  return buf;
}

function centralHeader(entry) {
  const { time, day } = dosDateTime(entry.mtime);
  const buf = Buffer.alloc(46);
  buf.writeUInt32LE(CDIR, 0);
  buf.writeUInt16LE(20, 4);                    // version made by
  buf.writeUInt16LE(20, 6);                    // version needed
  buf.writeUInt16LE(0x0808, 8);                // same flags as local header
  buf.writeUInt16LE(entry.method, 10);
  buf.writeUInt16LE(time, 12);
  buf.writeUInt16LE(day, 14);
  buf.writeUInt32LE(entry.crc, 16);
  buf.writeUInt32LE(entry.compressed, 20);
  buf.writeUInt32LE(entry.uncompressed, 24);
  buf.writeUInt16LE(entry.name.length, 28);
  buf.writeUInt16LE(0, 30);                    // extra
  buf.writeUInt16LE(0, 32);                    // comment
  buf.writeUInt16LE(0, 34);                    // disk number
  buf.writeUInt16LE(0, 36);                    // internal attrs
  buf.writeUInt32LE(0, 38);                    // external attrs
  buf.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([buf, entry.name]);
}

async function writeChunk(res, buf) {
  if (res.destroyed) throw new Error('client disconnected');
  if (res.write(buf)) return;
  await new Promise((resolve, reject) => {
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('client disconnected')); };
    const cleanup = () => { res.off('drain', onDrain); res.off('close', onClose); };
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

/**
 * Streams a ZIP archive of `files` to `res`.
 *
 * @param {import('http').ServerResponse} res
 * @param {{abs:string, rel:string}[]} files
 * @param {object} [options]
 * @param {number} [options.maxTotalBytes] hard cap for the uncompressed total
 */
async function streamZip(res, files, options = {}) {
  const maxTotal = options.maxTotalBytes || 2 * 1024 * 1024 * 1024;
  let total = 0;
  for (const f of files) {
    total += f.size || 0;
    if (total > maxTotal) {
      const err = new Error(`archive exceeds ${Math.round(maxTotal / 1024 / 1024)} MiB`);
      err.code = 'ETOOLARGE';
      throw err;
    }
  }
  if (files.length > 60000) {
    const err = new Error('too many files for a single archive');
    err.code = 'ETOOLARGE';
    throw err;
  }

  const central = [];
  let offset = 0;
  let written = 0;

  for (const file of files) {
    const name = Buffer.from(file.rel.split(path.sep).join('/'), 'utf8');
    const headerOffset = offset;
    const header = localHeader(name, 8, file.mtime);
    await writeChunk(res, header);
    offset += header.length;

    let crc = 0;
    let uncompressed = 0;
    let compressed = 0;

    // CRC and the uncompressed size must be computed over the *source* bytes,
    // so the counter sits between the file stream and the deflater.
    const counter = new Transform({
      transform(chunk, _enc, done) {
        crc = crc32Update(crc, chunk);
        uncompressed += chunk.length;
        done(null, chunk);
      },
    });
    const deflate = zlib.createDeflateRaw({ level: 1 });
    const source = fs.createReadStream(file.abs);

    source.on('error', (err) => counter.destroy(err));
    counter.on('error', (err) => deflate.destroy(err));
    source.pipe(counter).pipe(deflate);

    try {
      for await (const chunk of deflate) {
        compressed += chunk.length;
        await writeChunk(res, chunk);
      }
    } finally {
      source.destroy();
      counter.destroy();
    }

    const desc = descriptor(crc, compressed, uncompressed);
    await writeChunk(res, desc);
    offset += compressed + desc.length;
    written += compressed;

    if (offset > U32_MAX) {
      const err = new Error('archive exceeds the 4 GiB zip limit');
      err.code = 'ETOOLARGE';
      throw err;
    }

    central.push({
      name,
      method: 8,
      mtime: file.mtime,
      crc,
      compressed,
      uncompressed,
      offset: headerOffset,
    });
  }

  const centralParts = central.map(centralHeader);
  const centralSize = centralParts.reduce((n, b) => n + b.length, 0);
  const centralOffset = offset;

  for (const part of centralParts) await writeChunk(res, part);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(0, 4);                 // disk number
  end.writeUInt16LE(0, 6);                 // central dir disk
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);                // comment length
  await writeChunk(res, end);

  return { files: central.length, compressedBytes: written, uncompressedBytes: total };
}

module.exports = { streamZip, crc32Update };
