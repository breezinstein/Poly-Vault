'use strict';
// The Rigged library: where Mesh2Motion's "Save to vault" lands.
//
//   POST /api/web/rigged?name=&kind=&src=&entry=&from=     body: FBX or GLB
//   POST /api/web/rigged/preview?folder=                    body: PNG or JPEG
//
// Each save becomes its own asset folder, so the scanner shows it as a card:
//
//   <rigged>/<Name>/<Name>__rigged.fbx   (+ preview.jpg|png)
//
// Uploads stream to a hidden staging folder on the same filesystem and are
// renamed into place, so a dropped connection never leaves a half file in the
// library. Content is checked by magic bytes, not by the name it claims.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODEL_MAGIC = {
  glb: (b) => b.length >= 4 && b.readUInt32LE(0) === 0x46546c67,
  fbx: (b) => b.subarray(0, 18).toString('latin1') === 'Kaydara FBX Binary'
    || /FBXHeaderExtension|^\s*; FBX/.test(b.subarray(0, 2048).toString('latin1')),
};
const IMAGE_MAGIC = {
  png: (b) => b.length >= 8 && b.readUInt32BE(0) === 0x89504e47,
  jpg: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
};

function safeName(raw) {
  const base = String(raw || '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '')
    .replace(/__rigged$/i, '')
    .replace(/[^\w .()+-]+/g, '_').replace(/\s+/g, ' ').trim()
    .replace(/^[.\s]+/, '')
    .slice(0, 80);
  return base || 'model';
}

function createRiggedStore({ dir, maxBytes = 256 * 1024 * 1024, log = console }) {
  const root = dir ? path.resolve(dir) : null;
  const staging = root ? path.join(root, '.incoming') : null;

  function available() {
    if (!root) return false;
    try {
      fs.mkdirSync(staging, { recursive: true });
      fs.accessSync(root, fs.constants.W_OK);
      return true;
    } catch (_) {
      return false;
    }
  }

  const humanSize = (n) => (n >= 1048576 ? `${Number((n / 1048576).toFixed(1))} MB` : `${Math.ceil(n / 1024)} KB`);
  const tooLarge = (limit) => Object.assign(new Error(`larger than ${humanSize(limit)}`), { status: 413 });

  // Refuse the rest of an oversize body without resetting the socket, so the
  // client gets the 413: keep reading (and discarding) for a while, then give
  // up on a client that never stops sending.
  function drain(req) {
    req.removeAllListeners('data');
    req.on('data', () => {});
    req.resume();
    const t = setTimeout(() => req.destroy(), 30000);
    t.unref();
    req.once('end', () => clearTimeout(t));
    req.once('close', () => clearTimeout(t));
  }

  // Stream the request body to a staging file, enforcing the size cap.
  function receive(req, limit) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > limit) { reject(tooLarge(limit)); drain(req); return; }
      const tmp = path.join(staging, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.part`);
      const out = fs.createWriteStream(tmp, { flags: 'wx' });
      let size = 0;
      let head = Buffer.alloc(0);
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        out.destroy();
        fs.rm(tmp, { force: true }, () => {});
        reject(err);
      };
      req.on('data', (chunk) => {
        size += chunk.length;
        if (head.length < 4096) head = Buffer.concat([head, chunk.subarray(0, 4096 - head.length)]);
        if (size > limit) { fail(tooLarge(limit)); drain(req); return; }
        if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
      });
      req.on('end', () => { if (!failed) out.end(() => resolve({ tmp, size, head })); });
      req.on('error', fail);
      req.on('aborted', () => fail(new Error('upload aborted')));
      out.on('error', fail);
    });
  }

  // Create a new folder named after the model, "<name> (2)" etc. when taken.
  // mkdir itself is the check (EEXIST -> next name), so two saves of the same
  // name at the same moment never get the same folder.
  function createUniqueFolder(name) {
    for (let i = 1; i <= 1000; i += 1) {
      const candidate = i === 1 ? name : `${name} (${i})`;
      try {
        fs.mkdirSync(path.join(root, candidate));
        return candidate;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
    throw Object.assign(new Error(`too many saved models named "${name}"`), { status: 409 });
  }

  /** Store a rigged model. @returns {Promise<{folder:string, file:string, ext:string, size:number}>} */
  async function saveModel(req, query) {
    if (!available()) throw Object.assign(new Error('the Rigged library is not writable on this server'), { status: 503 });
    const ext = String(query.name || '').split('.').pop().toLowerCase();
    if (!MODEL_MAGIC[ext]) throw Object.assign(new Error('only .fbx and .glb can be saved'), { status: 415 });
    const { tmp, size, head } = await receive(req, maxBytes);
    if (!MODEL_MAGIC[ext](head)) {
      fs.rmSync(tmp, { force: true });
      throw Object.assign(new Error(`the file is not a valid ${ext.toUpperCase()}`), { status: 415 });
    }
    const name = safeName(query.from || query.name);
    let folder;
    try {
      folder = createUniqueFolder(name);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    const dirPath = path.join(root, folder);
    const file = path.join(dirPath, `${name}__rigged.${ext}`);
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      // Never leave an empty card in the library.
      fs.rmSync(dirPath, { recursive: true, force: true });
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    return { folder, dir: dirPath, file, ext, size };
  }

  /** Store a card preview for a folder created by saveModel. */
  async function savePreview(req, query) {
    if (!available()) throw Object.assign(new Error('the Rigged library is not writable'), { status: 503 });
    const folder = String(query.folder || '');
    if (!folder || folder.includes('/') || folder.includes('\\') || folder.startsWith('.')) throw Object.assign(new Error('bad folder'), { status: 400 });
    const dirPath = path.join(root, folder);
    let real;
    try { real = fs.realpathSync(dirPath); } catch (_) { throw Object.assign(new Error('no such rigged model'), { status: 404 }); }
    if (path.dirname(real) !== fs.realpathSync(root)) throw Object.assign(new Error('bad folder'), { status: 400 });
    const { tmp, head } = await receive(req, 4 * 1024 * 1024);
    const type = IMAGE_MAGIC.png(head) ? 'png' : IMAGE_MAGIC.jpg(head) ? 'jpg' : null;
    if (!type) { fs.rmSync(tmp, { force: true }); throw Object.assign(new Error('preview must be PNG or JPEG'), { status: 415 }); }
    for (const old of ['preview.png', 'preview.jpg']) fs.rmSync(path.join(real, old), { force: true });
    const file = path.join(real, `preview.${type}`);
    fs.renameSync(tmp, file);
    return { folder, file };
  }

  // Leftovers from interrupted uploads.
  function cleanStaging(maxAgeMs = 6 * 3600 * 1000) {
    if (!staging) return;
    try {
      for (const f of fs.readdirSync(staging)) {
        const p = path.join(staging, f);
        if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { force: true });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`[poly-vault] rigged staging cleanup: ${err.message}`);
    }
  }

  return { root, available, saveModel, savePreview, cleanStaging, safeName };
}

module.exports = { createRiggedStore, safeName };
