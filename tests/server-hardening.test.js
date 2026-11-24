'use strict';
// Unit tests for the server's concurrency and safety edges: worker replies
// routed by id while several kinds of request are in flight, folder link maps
// (shallow, time budget, invalidation), race-free "Save to vault" folders and
// refused oversize uploads.
//
//   node tests/server-hardening.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

const { createPackageIndex } = require('../server/packageIndex');
const { buildFolderGraph } = require('../server/unityGraph');
const { createRiggedStore } = require('../server/riggedStore');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-hardening-'));
const quiet = { info() {}, warn() {}, log() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- helpers ---------------------------------------------------------------------

function tarEntry(name, body) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136);
  h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += h[i];
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512, 0)]);
}
function unityPackage(assets) {
  const parts = [];
  for (const a of assets) {
    parts.push(tarEntry(`${a.guid}/asset`, a.asset));
    parts.push(tarEntry(`${a.guid}/asset.meta`, `fileFormatVersion: 2\nguid: ${a.guid}\n`));
    parts.push(tarEntry(`${a.guid}/pathname`, `${a.path}\n00`));
  }
  parts.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(parts));
}
const guid = (n) => `b2${String(n).padStart(30, '0')}`;
function looseAsset(dir, rel, n, body = 'x') {
  const file = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.writeFileSync(`${file}.meta`, `fileFormatVersion: 2\nguid: ${guid(n)}\n`);
}
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(50);
  }
}
function fakeUpload(body, headers = {}) {
  const req = Readable.from([body]);
  req.headers = headers;
  return req;
}
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(60, 1)]);

// --- item 9: replies routed by id --------------------------------------------------

test('package worker: index, link map, extraction and folder map in flight together each get their own reply', async () => {
  const dataDir = fs.mkdtempSync(path.join(work, 'data-'));
  const pkg = path.join(work, 'Kit.unitypackage');
  fs.writeFileSync(pkg, unityPackage([
    { guid: guid(1), path: 'Assets/Kit/a.txt', asset: 'alpha' },
    { guid: guid(2), path: 'Assets/Kit/b.txt', asset: 'bravo-bravo' },
  ]));
  const folder = path.join(work, 'Loose');
  looseAsset(folder, 'Models/m.txt', 3);

  const idx = createPackageIndex({ dir: dataDir, log: quiet });
  try {
    const st = fs.statSync(pkg);
    const out = path.join(work, 'extracted-b.txt');
    idx.enqueue(pkg, st.mtimeMs, st.size);
    idx.enqueueGraph(pkg, st.mtimeMs, st.size, { priority: true });
    const [folderGraph, extracted] = await Promise.all([
      idx.folderGraph(folder),
      idx.extractMany(pkg, [{ guid: guid(2), outPath: out }]),
    ]);
    assert.ok(folderGraph && folderGraph.paths[guid(3)] === 'Models/m.txt', 'folder map is the folder\'s, not another reply');
    assert.strictEqual(extracted.ok, true);
    assert.strictEqual(fs.readFileSync(out, 'utf8'), 'bravo-bravo');
    const entry = await until(() => idx.get(pkg, st.mtimeMs, st.size));
    assert.strictEqual(entry.totalAssets, 2, 'index entry is the index reply');
    const graph = await until(() => idx.getGraph(pkg, st.mtimeMs, st.size));
    assert.strictEqual(graph.kind, 'package');
    assert.strictEqual(graph.paths[guid(1)], 'Assets/Kit/a.txt');
  } finally {
    idx.close();
  }
});

// --- item 10 + 13: folder link maps ----------------------------------------------------

test('folder map: shallow maps only the folder itself; an expired time budget marks it partial', () => {
  const root = path.join(work, 'Root');
  looseAsset(root, 'top.txt', 10);
  looseAsset(root, 'Pack/inner.txt', 11);
  const deep = buildFolderGraph(root);
  assert.deepStrictEqual(Object.values(deep.paths).sort(), ['Pack/inner.txt', 'top.txt']);
  const shallow = buildFolderGraph(root, { shallow: true });
  assert.deepStrictEqual(Object.values(shallow.paths), ['top.txt']);
  const timed = buildFolderGraph(root, { timeBudgetMs: -1 });
  assert.strictEqual(timed.truncated, 'time-limit');
  assert.strictEqual(timed.complete, false);
});

test('folder map: a change inside the folder drops the cached map; unrelated changes do not', async () => {
  const dataDir = fs.mkdtempSync(path.join(work, 'data-'));
  const folder = path.join(work, 'Watched');
  looseAsset(folder, 'a.txt', 20);
  const idx = createPackageIndex({ dir: dataDir, log: quiet });
  try {
    const first = await idx.folderGraph(folder);
    assert.ok(first.paths[guid(20)]);
    looseAsset(folder, 'Sub/b.txt', 21);
    assert.ok(!(await idx.folderGraph(folder)).paths[guid(21)], 'cached until something says it changed');
    idx.invalidateFolders(path.join(work, 'Elsewhere', 'x.txt'));
    assert.ok(!(await idx.folderGraph(folder)).paths[guid(21)], 'a change elsewhere keeps the cache');
    idx.invalidateFolders(path.join(folder, 'Sub', 'b.txt'));
    assert.ok((await idx.folderGraph(folder)).paths[guid(21)], 'rebuilt after a change inside it');
  } finally {
    idx.close();
  }
});

// --- item 11 + 7: Save to vault --------------------------------------------------------

test('save to vault: simultaneous saves of the same name get separate folders', async () => {
  const dir = fs.mkdtempSync(path.join(work, 'rigged-'));
  const store = createRiggedStore({ dir, log: quiet });
  const saves = await Promise.all([1, 2, 3].map(() => store.saveModel(fakeUpload(GLB), { name: 'Hero.glb', from: 'Hero' })));
  assert.deepStrictEqual(saves.map((s) => s.folder).sort(), ['Hero', 'Hero (2)', 'Hero (3)']);
  for (const s of saves) assert.ok(fs.existsSync(s.file));
});

test('save to vault: a failed move into place leaves no empty folder behind', async () => {
  const dir = fs.mkdtempSync(path.join(work, 'rigged-'));
  const store = createRiggedStore({ dir, log: quiet });
  const real = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('EIO: simulated'), { code: 'EIO' }); };
  try {
    await assert.rejects(store.saveModel(fakeUpload(GLB), { name: 'Broken.glb' }), /simulated/);
  } finally {
    fs.renameSync = real;
  }
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => !f.startsWith('.')), []);
});

test('save to vault: an oversize upload is refused with 413 and a readable size', async () => {
  const dir = fs.mkdtempSync(path.join(work, 'rigged-'));
  const store = createRiggedStore({ dir, maxBytes: 300000, log: quiet });
  const big = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(400000, 1)]);
  const req = fakeUpload(big);   // no Content-Length: the streaming check
  let ended = false;
  req.on('end', () => { ended = true; });
  const err = await store.saveModel(req, { name: 'Big.glb' }).then(() => null, (e) => e);
  assert.ok(err && err.status === 413, 'status 413');
  assert.match(err.message, /larger than 293 KB/);
  await until(() => ended, 2000).catch(() => {});
  assert.ok(ended, 'the body is read to the end (drained), not reset');
});

(async () => {
  let failed = 0;
  let passed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  PASS ${t.name}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL ${t.name}\n       ${String((err && err.stack) || err).split('\n').slice(0, 4).join('\n       ')}`);
    }
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\nserver-hardening: passed ${passed}, failed ${failed}`);
  process.exit(failed ? 1 : 0);
})();
