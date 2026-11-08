'use strict';

// Worker that parses one .unitypackage and writes its preview image.
//
// Parsing means gunzipping (up to hundreds of MB) and walking a tar stream, so
// it must not run on the HTTP thread — same reasoning as the scanner worker.
// The preview is written here so multi-megabyte buffers never cross threads.

const fs = require('fs');
const path = require('path');
const { parentPort } = require('worker_threads');
const { readUnityPackage, extractEntry } = require('./unityPackage');

let extractChain = Promise.resolve();

parentPort.on('message', (msg) => {
  if (msg.action === 'extract') {
    // One extraction at a time: they are CPU/IO heavy and share the tar reader.
    extractChain = extractChain.then(() => handleExtract(msg)).catch(() => undefined);
    return;
  }
  handleIndex(msg);
});

async function handleExtract(msg) {
  const { id, file } = msg;

  try {
    const result = await extractEntry(file, msg.entry, { maxBytes: msg.maxBytes, timeoutMs: msg.timeoutMs });
    if (!result.ok) {
      parentPort.postMessage({ id, ok: false, error: result.error || 'not found' });
      return;
    }
    const out = msg.outPath;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, result.data);
    let previewPath = '';
    if (result.preview && result.preview.length > 0 && msg.previewOutPath) {
      fs.mkdirSync(path.dirname(msg.previewOutPath), { recursive: true });
      fs.writeFileSync(msg.previewOutPath, result.preview);
      previewPath = msg.previewOutPath;
    }
    parentPort.postMessage({ id, ok: true, size: result.data.length, outPath: out, previewPath });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
}

async function handleIndex(msg) {
  const { id, file } = msg;
  const { mode, previewPath: outPath, maxUncompressedBytes, timeoutMs } = msg;
  try {
    const stat = fs.statSync(file);
    const result = await readUnityPackage(file, {
      previewOnly: mode === 'preview',
      maxUncompressedBytes,
      timeoutMs,
      maxContents: 4000,
    });

    let previewPath = '';
    let previewBytes = 0;
    if (result.preview && result.preview.buffer.length > 0) {
      const dir = path.dirname(outPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outPath, result.preview.buffer);
      previewPath = outPath;
      previewBytes = result.preview.buffer.length;
    }

    parentPort.postMessage({
      id,
      ok: true,
      entry: {
        path: file,
        mtimeMs: Math.trunc(stat.mtimeMs),
        size: stat.size,
        mode,
        previewPath,
        previewBytes,
        previewSource: result.preview ? result.preview.sourceAsset : '',
        counts: result.counts,
        totalAssets: result.totalAssets,
        totalBytes: result.totalBytes,
        folders: result.folders,
        contents: result.assets,
        partial: result.partial,
        truncated: result.truncated,
        scannedBytes: result.scannedBytes,
        indexedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
}
