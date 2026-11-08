'use strict';

// Reads metadata and preview images out of a Unity `.unitypackage` file.
//
// A .unitypackage is a gzipped tar archive laid out as:
//
//   <guid>/pathname      -> text file: the asset's real project path
//   <guid>/asset         -> the raw asset bytes
//   <guid>/asset.meta    -> the .meta file (or `<guid>/metaData` in old packages)
//   <guid>/preview.png   -> Unity's generated thumbnail for that asset
//
// (This is the same structure the browser tool "package-extractor" inspects.)
//
// Everything is streamed: the archive can be hundreds of megabytes and these
// live on an NFS share, so we never hold the package in memory — only the tar
// headers, a bounded set of small text entries, and the best preview image.
// The preview gives a package card a real thumbnail (no Asset Store network
// access needed), and the pathnames give honest "what's inside" type counts.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLOCK = 512;
const MAX_PATHNAME_BYTES = 8 * 1024;
const MAX_PREVIEW_BYTES = 6 * 1024 * 1024;
// Packages in the wild range from 10 KB to >12 GB. Reading 100 GB of NFS just
// to build an index is not acceptable, so the reader is budgeted:
//   - preview pass: stop as soon as a usable preview is found (usually < 10 MB
//     of decompression, because Unity writes previews next to every asset)
//   - full pass (accurate "what's inside") only below PV_PACKAGE_INDEX_MAX_MB
const DEFAULT_MAX_UNCOMPRESSED = 256 * 1024 * 1024; // 256 MiB per pass
const DEFAULT_TIMEOUT_MS = 45000;
const GOOD_PREVIEW_BYTES = 24 * 1024;

// Extension -> display bucket, matching the vocabulary the UI already uses for
// regular asset folders (`kindCounts` pills). Kept local so this module has no
// hidden dependency on upstream internals.
const KIND_BY_EXT = new Map(Object.entries({
  '.fbx': 'mesh', '.obj': 'mesh', '.glb': 'mesh', '.gltf': 'mesh', '.blend': 'mesh',
  '.dae': 'mesh', '.3ds': 'mesh', '.dxf': 'mesh', '.stl': 'mesh', '.ply': 'mesh',
  '.max': 'mesh', '.ma': 'mesh', '.mb': 'mesh', '.abc': 'mesh', '.lwo': 'mesh',
  '.png': 'texture', '.jpg': 'texture', '.jpeg': 'texture', '.tga': 'texture',
  '.psd': 'texture', '.tif': 'texture', '.tiff': 'texture', '.bmp': 'texture',
  '.exr': 'texture', '.hdr': 'texture', '.dds': 'texture', '.ktx': 'texture',
  '.wav': 'audio', '.mp3': 'audio', '.ogg': 'audio', '.aif': 'audio', '.aiff': 'audio',
  '.flac': 'audio', '.xm': 'audio', '.mod': 'audio', '.it': 'audio',
  '.mp4': 'video', '.mov': 'video', '.avi': 'video', '.webm': 'video', '.m4v': 'video',
  '.ttf': 'font', '.otf': 'font', '.dfont': 'font',
  '.cs': 'script', '.dll': 'script', '.asmdef': 'script', '.shader': 'script',
  '.cginc': 'script', '.hlsl': 'script',
  '.mat': 'material', '.physicmaterial': 'material',
  '.prefab': 'prefab', '.scene': 'scene', '.unity': 'scene',
  '.anim': 'animation', '.controller': 'animation', '.overridecontroller': 'animation',
  '.mask': 'animation', '.mixer': 'animation',
  '.asset': 'asset', '.spriteatlas': 'asset', '.rendertexture': 'asset',
  '.flare': 'asset', '.lighting': 'asset', '.shadervariants': 'asset',
  '.json': 'data', '.txt': 'data', '.xml': 'data', '.csv': 'data', '.bytes': 'data',
  '.cubemap': 'texture', '.renderTexture': 'asset',
}));

function kindForPath(p) {
  const ext = path.extname(p).toLowerCase();
  return KIND_BY_EXT.get(ext) || (ext ? ext.slice(1) : 'other');
}

function isFolderAsset(p) {
  // Unity packages carry folder records as asset entries too; they are not
  // "files inside" and would inflate the counts.
  const base = path.basename(p);
  return !base || base === p.replace(/\/+$/, '');
}

/**
 * @param {string} filePath
 * @param {object} [options]
 * @param {number} [options.maxUncompressedBytes]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxContents] how many content entries to return
 * @param {boolean} [options.previewOnly] stop once a good preview is found
 * @param {number} [options.goodPreviewBytes] size that counts as "good"
 * @param {number} [options.stopAfterPreview] stop early (defaults to previewOnly)
 * @returns {Promise<{ok:boolean, error?:string, preview?:{buffer:Buffer,sourceAsset:string,bytes:number}|null,
 *   assets:{path:string,size:number}[], counts:Object<string,number>, totalAssets:number,
 *   totalBytes:number, folders:number, partial:boolean, scannedBytes:number}>}
 */
async function readUnityPackage(filePath, options = {}) {
  const maxUncompressed = options.maxUncompressedBytes || DEFAULT_MAX_UNCOMPRESSED;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxContents = options.maxContents || 400;
  const previewOnly = Boolean(options.previewOnly);
  const goodPreviewBytes = options.goodPreviewBytes || GOOD_PREVIEW_BYTES;

  const byGuid = new Map();          // guid -> { path, size }
  let bestPreview = null;            // { buffer, guid, bytes }
  let scannedBytes = 0;
  let partial = false;
  let truncated = '';
  let sawEnd = false;

  // tar state
  let headerBuf = Buffer.alloc(0);
  let bodyLeft = 0;
  let padLeft = 0;
  let capLeft = 0;
  let capChunks = [];
  let entry = null;                  // { guid, leaf, size }
  let assetSize = 0;                 // size of the entry body, for 'asset'

  const startedAt = Date.now();

  function recordGuid(guid, patch) {
    const current = byGuid.get(guid) || { path: '', size: 0 };
    byGuid.set(guid, { ...current, ...patch });
  }

  function finishEntry() {
    if (entry && entry.leaf === 'pathname' && capChunks.length) {
      const text = Buffer.concat(capChunks).toString('utf8').split('\n')[0].trim();
      if (text) recordGuid(entry.guid, { path: text });
    } else if (entry && entry.leaf === 'preview.png' && capChunks.length) {
      const buffer = Buffer.concat(capChunks);
      if (buffer.length > 0 && (!bestPreview || buffer.length > bestPreview.bytes)) {
        bestPreview = { buffer, guid: entry.guid, bytes: buffer.length };
      }
    }
    if (entry && entry.guid) recordGuid(entry.guid, {});
    padLeft = (BLOCK - (assetSize % BLOCK)) % BLOCK;
    bodyLeft = 0;
    capLeft = 0;
    capChunks = [];
    entry = null;
  }

  function parseHeader(header) {
    if (header.every((b) => b === 0)) { sawEnd = true; return; }
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const sizeField = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const typeflag = String.fromCharCode(header[156] || 48);
    const size = parseInt(sizeField, 8);
    if (!name || Number.isNaN(size)) { sawEnd = true; return; }

    const slash = name.indexOf('/');
    const guid = slash > 0 ? name.slice(0, slash) : '';
    const leaf = slash > 0 ? name.slice(slash + 1) : '';
    const isFile = typeflag === '0' || typeflag === '\0' || typeflag === '';

    if (!isFile || size === 0) {
      entry = null;
      assetSize = 0;
      bodyLeft = 0;
      padLeft = 0;
      return;
    }

    entry = { guid, leaf, size };
    assetSize = size;
    bodyLeft = size;
    padLeft = 0;
    if (leaf === 'pathname') capLeft = MAX_PATHNAME_BYTES;
    else if (leaf === 'preview.png') capLeft = MAX_PREVIEW_BYTES;
    else if (leaf === 'asset') recordGuid(guid, { size });
    else capLeft = 0;
    capChunks = [];
  }

  function consume(chunk) {
    let off = 0;
    while (off < chunk.length) {
      if (bodyLeft > 0) {
        const n = Math.min(chunk.length - off, bodyLeft);
        if (capLeft > 0) {
          const keep = Math.min(n, capLeft);
          if (keep > 0) { capChunks.push(Buffer.from(chunk.subarray(off, off + keep))); capLeft -= keep; }
        }
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
      // header bytes
      const need = BLOCK - headerBuf.length;
      const n = Math.min(chunk.length - off, need);
      headerBuf = headerBuf.length
        ? Buffer.concat([headerBuf, chunk.subarray(off, off + n)])
        : Buffer.from(chunk.subarray(off, off + n));
      off += n;
      if (headerBuf.length === BLOCK) {
        const header = headerBuf;
        headerBuf = Buffer.alloc(0);
        parseHeader(header);
      }
    }
  }

  const source = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  const gunzip = zlib.createGunzip({ chunkSize: 1024 * 1024 });
  source.pipe(gunzip);
  source.on('error', (err) => gunzip.destroy(err));

  try {
    for await (const chunk of gunzip) {
      consume(chunk);
      if (sawEnd) break;
      if (previewOnly && bestPreview && bestPreview.bytes >= goodPreviewBytes) {
        // Good enough for a card: stop reading (a 12 GB package may take
        // minutes to walk, and the thumbnail is all we wanted here).
        truncated = 'preview-found';
        partial = true;
        break;
      }
      if (scannedBytes > maxUncompressed) { truncated = 'byte-budget'; partial = true; break; }
      if (Date.now() - startedAt > timeoutMs) { truncated = 'time-budget'; partial = true; break; }
    }
  } catch (err) {
    if (!sawEnd) {
      // Truncated/corrupt archive: return what we managed to read.
      partial = true;
    }
  } finally {
    source.destroy();
    gunzip.destroy();
  }

  const assets = [];
  const counts = {};
  let totalBytes = 0;
  let folders = 0;
  for (const item of byGuid.values()) {
    if (!item.path) continue;
    if (item.path.endsWith('/')) { folders += 1; continue; }
    const kind = kindForPath(item.path);
    counts[kind] = (counts[kind] || 0) + 1;
    totalBytes += item.size || 0;
    if (assets.length < maxContents) assets.push({ path: item.path, size: item.size || 0 });
  }
  assets.sort((a, b) => b.size - a.size);

  const preview = bestPreview
    ? { buffer: bestPreview.buffer, bytes: bestPreview.bytes, sourceAsset: (byGuid.get(bestPreview.guid) || {}).path || '' }
    : null;

  return {
    ok: sawEnd || assets.length > 0,
    preview,
    assets,
    counts,
    totalAssets: Object.values(counts).reduce((n, v) => n + v, 0),
    totalBytes,
    folders,
    partial: partial || !sawEnd,
    truncated: truncated || (sawEnd ? '' : 'archive-truncated'),
    scannedBytes,
  };
}

module.exports = { readUnityPackage, kindForPath };
