'use strict';
// Model work off the HTTP thread: reading a model file, scanning what it
// contains (meshes, materials, textures) and converting FBX 6 / Unity mesh
// assets to GLB. All of it is synchronous JavaScript over buffers that can be
// hundreds of MB, so it runs here, one request at a time, and only small
// results (the structure summary, a file path) cross back.
//
// Protocol (every message carries an `id`, echoed in the reply):
//   { action: 'inspect', file, format, maxBytes, convertTo? }
//     -> { ok, structure, size, fbxVersion, converted? }
//        `converted` is set when convertTo was given and the file needs it
//        (Unity mesh asset, FBX older than 7.0).
//   { action: 'convert', file, format, maxBytes, out } -> { ok, converted }

const fs = require('fs');
const crypto = require('crypto');
const { parentPort } = require('worker_threads');
const { modelStructure } = require('./modelResolver');
const { convertFbx6, fbxVersion } = require('./fbx6');
const { convertMeshAsset } = require('./unityMesh');

const MB = 1024 * 1024;

function readCapped(file, maxBytes) {
  const st = fs.statSync(file);
  if (maxBytes && st.size > maxBytes) {
    throw new Error(`the file is ${Math.ceil(st.size / MB)} MB, over the ${Math.floor(maxBytes / MB)} MB preview limit`);
  }
  return fs.readFileSync(file);
}

// Unique temp name per write: two requests for the same output never share it.
function writeAtomic(out, data) {
  const tmp = `${out}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, out);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function needsConversion(format, version) {
  return format === 'asset' || (format === 'fbx' && version > 0 && version < 7000);
}

function convert(bytes, format, out) {
  if (fs.existsSync(out)) return { ok: true, file: out };
  try {
    const { glb } = format === 'asset' ? convertMeshAsset(bytes) : convertFbx6(bytes);
    writeAtomic(out, glb);
    return { ok: true, file: out };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

parentPort.on('message', (msg) => {
  const reply = (body) => parentPort.postMessage({ id: msg.id, ...body });
  try {
    const bytes = readCapped(msg.file, msg.maxBytes);
    const version = msg.format === 'fbx' ? fbxVersion(bytes) : 0;
    if (msg.action === 'inspect') {
      const structure = modelStructure(bytes, msg.format);
      const converted = msg.convertTo && needsConversion(msg.format, version) ? convert(bytes, msg.format, msg.convertTo) : null;
      reply({ ok: true, structure, size: bytes.length, fbxVersion: version, converted });
      return;
    }
    if (msg.action === 'convert') {
      reply({ ok: true, converted: convert(bytes, msg.format, msg.out) });
      return;
    }
    reply({ ok: false, error: `unknown action ${msg.action}` });
  } catch (err) {
    reply({ ok: false, error: String((err && err.message) || err) });
  }
});
