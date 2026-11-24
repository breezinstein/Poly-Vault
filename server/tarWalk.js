'use strict';
// Generic streaming walker for .unitypackage files (gzipped tar).
//
// The caller decides per entry what to keep, from the tar header alone:
//
//   onHeader(guid, leaf, size) -> null                       skip the body
//                               | { capture: maxBytes }       keep up to N bytes
//                               | { capture, sniff: Buffer }  keep only if the body
//                                                             starts with `sniff`
//                               | { write: fd, maxBytes }     stream into a file
//   onEntry(guid, leaf, buffer|null, { size, truncated })     after a capture/write
//   shouldStop()                                              checked per chunk
//
// Nothing else is buffered, so a 12 GB package costs a few MB of memory. Unity
// writes entries grouped per GUID in the order asset, asset.meta, preview.png,
// pathname — the path arrives *last*, which is why sniffing exists: a material
// or prefab is recognised by its "%YAML" header before its name is known.

const fs = require('fs');
const zlib = require('zlib');

const BLOCK = 512;

/**
 * @returns {Promise<{complete:boolean, truncated:string, scannedBytes:number}>}
 */
async function walkUnityPackage(filePath, opts) {
  const onHeader = opts.onHeader || (() => null);
  const onEntry = opts.onEntry || (() => {});
  const shouldStop = opts.shouldStop || (() => false);
  const timeoutMs = opts.timeoutMs || 0;
  const maxUncompressed = opts.maxUncompressedBytes || 0;

  let headerBuf = Buffer.alloc(0);
  let bodyLeft = 0;
  let padLeft = 0;
  let entry = null;      // { guid, leaf, size, plan, chunks, kept, written, rejected }
  let sawEnd = false;
  let scannedBytes = 0;
  let truncated = '';
  const startedAt = Date.now();

  function finishEntry() {
    if (entry && entry.plan && !entry.rejected) {
      const wasTruncated = entry.kept < entry.size && !entry.plan.write;
      if (entry.plan.write !== undefined) {
        onEntry(entry.guid, entry.leaf, null, { size: entry.size, truncated: entry.written < entry.size, written: entry.written });
      } else {
        onEntry(entry.guid, entry.leaf, Buffer.concat(entry.chunks), { size: entry.size, truncated: wasTruncated });
      }
    }
    padLeft = (BLOCK - (entry ? entry.size % BLOCK : 0)) % BLOCK;
    entry = null;
    bodyLeft = 0;
  }

  function parseHeader(header) {
    if (header.every((b) => b === 0)) { sawEnd = true; return; }
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim(), 8);
    const typeflag = String.fromCharCode(header[156] || 48);
    if (!name || Number.isNaN(size)) { sawEnd = true; return; }
    const isFile = typeflag === '0' || typeflag === '\0' || typeflag === '';
    const slash = name.indexOf('/');
    const guid = slash > 0 ? name.slice(0, slash) : name.replace(/\/+$/, '');
    const leaf = slash > 0 ? name.slice(slash + 1) : '';

    if (size === 0) {
      // Zero-size files still matter to the caller (e.g. an empty pathname).
      if (isFile && leaf) onHeader(guid, leaf, 0);
      return;
    }
    // Directories with a body, pax/GNU extension headers: skip the body.
    const plan = isFile && leaf ? onHeader(guid, leaf, size) : null;
    entry = { guid, leaf, size, plan, chunks: [], kept: 0, written: 0, rejected: false, sniffed: false };
    bodyLeft = size;
  }

  function takeBody(chunk) {
    const plan = entry.plan;
    if (!plan || entry.rejected) return;
    if (plan.write !== undefined) {
      const room = (plan.maxBytes || Infinity) - entry.written;
      if (room <= 0) return;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      fs.writeSync(plan.write, part);
      entry.written += part.length;
      return;
    }
    const room = plan.capture - entry.kept;
    if (room <= 0) return;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    entry.chunks.push(Buffer.from(part));
    entry.kept += part.length;
    if (plan.sniff && !entry.sniffed && entry.kept >= Math.min(plan.sniff.length, entry.size)) {
      entry.sniffed = true;
      const head = Buffer.concat(entry.chunks).subarray(0, plan.sniff.length);
      if (!head.equals(plan.sniff.subarray(0, head.length))) {
        entry.rejected = true;
        entry.chunks = [];
      }
    }
  }

  function consume(chunk) {
    let off = 0;
    while (off < chunk.length) {
      if (bodyLeft > 0) {
        const n = Math.min(chunk.length - off, bodyLeft);
        takeBody(chunk.subarray(off, off + n));
        bodyLeft -= n;
        off += n;
        scannedBytes += n;
        if (bodyLeft === 0) finishEntry();
        continue;
      }
      if (padLeft > 0) {
        const n = Math.min(chunk.length - off, padLeft);
        padLeft -= n;
        off += n;
        continue;
      }
      const need = BLOCK - headerBuf.length;
      const n = Math.min(chunk.length - off, need);
      headerBuf = headerBuf.length ? Buffer.concat([headerBuf, chunk.subarray(off, off + n)]) : Buffer.from(chunk.subarray(off, off + n));
      off += n;
      if (headerBuf.length === BLOCK) {
        const header = headerBuf;
        headerBuf = Buffer.alloc(0);
        parseHeader(header);
        if (sawEnd) return;
      }
    }
  }

  const source = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  const gunzip = zlib.createGunzip({ chunkSize: 1024 * 1024 });
  source.on('error', (err) => gunzip.destroy(err));
  source.pipe(gunzip);
  let error = null;
  try {
    for await (const chunk of gunzip) {
      consume(chunk);
      if (sawEnd) break;
      if (shouldStop()) { truncated = 'stopped'; break; }
      if (maxUncompressed && scannedBytes > maxUncompressed) { truncated = 'byte-budget'; break; }
      if (timeoutMs && Date.now() - startedAt > timeoutMs) { truncated = 'time-budget'; break; }
    }
  } catch (err) {
    error = err;
  } finally {
    source.destroy();
    gunzip.destroy();
  }
  if (!sawEnd && !truncated) truncated = error ? `archive-error: ${error.message}` : 'archive-truncated';
  return { complete: sawEnd, truncated: sawEnd ? '' : truncated, scannedBytes };
}

module.exports = { walkUnityPackage };
