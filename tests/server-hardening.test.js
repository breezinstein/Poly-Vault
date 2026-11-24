'use strict';
// Unit tests for the server's concurrency and safety edges: worker replies
// routed by id while several kinds of request are in flight, folder link maps
// (shallow, time budget, invalidation), race-free "Save to vault" folders,
// refused oversize uploads, crafted FBX files, the model worker watchdog,
// texture cache freshness and partial package link maps.
//
//   node tests/server-hardening.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const { spawnSync } = require('child_process');

const { createPackageIndex } = require('../server/packageIndex');
const { buildFolderGraph } = require('../server/unityGraph');
const { createRiggedStore } = require('../server/riggedStore');
const { createModelService } = require('../server/modelService');
const tex = require('../server/textureConvert');

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

// Binary FBX with 32-bit node records (version < 7500).
function fbxHeader(version) {
  const h = Buffer.alloc(27);
  h.write('Kaydara FBX Binary  \u0000', 0, 'latin1');
  h[21] = 0x1a;
  h.writeUInt32LE(version, 23);
  return h;
}
function fbxNode(end, name) {
  const b = Buffer.alloc(13 + name.length);
  b.writeUInt32LE(end, 0);
  b[12] = name.length;
  b.write(name, 13, 'ascii');
  return b;
}
const pad200 = (b) => Buffer.concat([b, Buffer.alloc(Math.max(0, 200 - b.length))]);
// Two top-level records whose ends point at each other (nothing allocated).
const pingPongFbx = (version) => pad200(Buffer.concat([fbxHeader(version), fbxNode(41, 'Z'), fbxNode(27, 'Z')]));
// A child record that ends where it starts (allocates a child per turn).
const selfChildFbx = (version) => pad200(Buffer.concat([fbxHeader(version), fbxNode(200, 'Objects'), fbxNode(47, 'Model')]));
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what}: no answer after ${ms} ms`); })]);
function stubService(opts = {}) {
  return createModelService({
    packageIndex: {}, entryCachePath: () => '', dataDir: fs.mkdtempSync(path.join(work, 'svc-')),
    resolveInLibrary: () => null, libraryRootOf: () => null, log: quiet, ...opts,
  });
}

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

// --- second review P0: crafted FBX files must fail, not spin ------------------------

test('fbx readers: records that point backwards or at themselves throw instead of looping', () => {
  // In a child process with a timeout: a regression would hang, not fail.
  const script = `
    const { scanFbx } = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'fbxScan.js'))});
    const { convertFbx6 } = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'fbx6.js'))});
    const cases = JSON.parse(process.argv[1]).map((c) => Buffer.from(c, 'base64'));
    const out = [];
    for (const [i, buf] of cases.entries()) {
      out.push(i < 2 ? scanFbx(buf).error || 'no error' : (() => { try { convertFbx6(buf); return 'no error'; } catch (e) { return e.message; } })());
    }
    console.log(JSON.stringify(out));`;
  const cases = [pingPongFbx(7400), selfChildFbx(7400), pingPongFbx(6100), selfChildFbx(6100)].map((b) => b.toString('base64'));
  const run = spawnSync(process.execPath, ['-e', script, JSON.stringify(cases)], { timeout: 10000, encoding: 'utf8' });
  assert.ok(!run.error, `the readers hung or crashed: ${run.error && run.error.message}`);
  const errors = JSON.parse(run.stdout.trim());
  for (const e of errors) assert.match(e, /bad end offset/);
});

test('model worker: a crafted FBX gets an answer and the next model still works', async () => {
  const svc = stubService();
  try {
    const bad = path.join(work, 'crafted.fbx');
    fs.writeFileSync(bad, selfChildFbx(7400));
    const good = path.join(work, 'good.obj');
    fs.writeFileSync(good, 'o Cube\nusemtl Wood\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    const r1 = await withTimeout(svc.callWorker({ action: 'inspect', file: bad, format: 'fbx' }), 10000, 'crafted FBX');
    assert.ok(!r1.ok || r1.structure.ok === false, 'the crafted file is reported as unreadable');
    const r2 = await withTimeout(svc.callWorker({ action: 'inspect', file: good, format: 'obj' }), 10000, 'good model');
    assert.strictEqual(r2.ok, true);
    assert.deepStrictEqual(r2.structure.meshes.map((m) => m.name), ['Cube']);
  } finally {
    svc.close();
  }
});

test('model worker watchdog: a stuck request fails, queued ones move to a new worker, the file is skipped next time', async () => {
  const svc = stubService({ workerTimeoutMs: 400, workerFile: path.join(__dirname, 'fixtures', 'hang-worker.js') });
  try {
    const [hang, ok1, ok2] = ['hang.bin', 'ok1.bin', 'ok2.bin'].map((n) => {
      const f = path.join(work, n);
      fs.writeFileSync(f, n);
      return f;
    });
    const started = Date.now();
    const [stuck, queued] = await withTimeout(Promise.all([
      svc.callWorker({ action: 'inspect', file: hang }),
      svc.callWorker({ action: 'inspect', file: ok1 }),
    ]), 10000, 'watchdog');
    assert.strictEqual(stuck.ok, false);
    assert.match(stuck.error, /gave up after/);
    assert.ok(Date.now() - started < 5000, 'ended by the watchdog, not by luck');
    assert.strictEqual(queued.ok, true, 'the request queued behind it was answered by a fresh worker');
    const again = await svc.callWorker({ action: 'inspect', file: hang });
    assert.strictEqual(again.ok, false, 'a file that timed out is not retried until it changes');
    assert.strictEqual((await svc.callWorker({ action: 'inspect', file: ok2 })).ok, true);
    const st = svc.stats();
    assert.strictEqual(st.workerTimeouts, 1);
    assert.strictEqual(st.skippedFiles, 1);
  } finally {
    svc.close();
  }
});

// --- second review P1: texture cache follows the texture file ----------------------

test('textures: re-exporting a texture in a loose folder serves the new image', async () => {
  if (!tex.available()) { console.log('  (skipped: sharp not installed)'); return; }
  const sharp = require('sharp');
  const lib = path.join(work, 'TexLib');
  const folder = path.join(lib, 'Props');
  const png = (r, g, b) => sharp({ create: { width: 8, height: 8, channels: 3, background: { r, g, b } } }).png().toBuffer();
  looseAsset(folder, 'crate.png', 40, await png(255, 0, 0));
  const idx = createPackageIndex({ dir: fs.mkdtempSync(path.join(work, 'data-')), log: quiet });
  const svc = createModelService({
    packageIndex: idx, entryCachePath: () => '', dataDir: fs.mkdtempSync(path.join(work, 'svc-')),
    resolveInLibrary: (p) => p, libraryRootOf: () => lib, log: quiet,
  });
  try {
    const key = `albedo:${guid(40)}`;
    const first = await svc.texture(folder, key, 256);
    assert.ok(first.file, first.message);
    const before = await sharp(first.file).raw().toBuffer();
    // Overwrite in place: the folder's own mtime does not change.
    const file = path.join(folder, 'crate.png');
    fs.writeFileSync(file, await png(0, 0, 255));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    const second = await svc.texture(folder, key, 256);
    assert.ok(second.file, second.message);
    assert.notStrictEqual(second.file, first.file, 'a new cache entry');
    const after = await sharp(second.file).raw().toBuffer();
    assert.ok(before[0] > 200 && after[2] > 200 && after[0] < 50, 'red before, blue after');
  } finally {
    svc.close();
    idx.close();
  }
});

// --- second review P1: unreadable package link maps -----------------------------

test('link map: a package that cannot be read fully is marked partial, reported and retried', async () => {
  const dataDir = fs.mkdtempSync(path.join(work, 'data-'));
  const pkg = path.join(work, 'Corrupt.unitypackage');
  const good = unityPackage([{ guid: guid(50), path: 'Assets/a.txt', asset: 'a' }]);
  fs.writeFileSync(pkg, Buffer.concat([good.subarray(0, 10), Buffer.alloc(5000, 7)]));   // gzip header, then junk
  const st = fs.statSync(pkg);
  let idx = createPackageIndex({ dir: dataDir, log: quiet, partialRetryMs: 0 });
  try {
    idx.enqueueGraph(pkg, st.mtimeMs, st.size, { priority: true });
    await until(() => idx.graphState(pkg, st.mtimeMs, st.size).attempts);
    const state = idx.graphState(pkg, st.mtimeMs, st.size);
    assert.strictEqual(state.state, 'ready', 'the partial map is still used');
    assert.match(state.partial, /^archive-/);
    assert.strictEqual(state.retrying, true);
    const listed = idx.graphFailuresList().find((f) => f.file === pkg);
    assert.ok(listed && listed.partial, 'listed in graph-failures');
    assert.strictEqual(idx.status().graph.partial, 1, 'counted in /healthz');
    // Retried (no wait in this test), and the attempt is counted.
    assert.strictEqual(idx.enqueueGraph(pkg, st.mtimeMs, st.size), true);
    await until(() => idx.graphState(pkg, st.mtimeMs, st.size).attempts === 2);
    idx.close();
    // After a restart the record survives, so it is still retried.
    idx = createPackageIndex({ dir: dataDir, log: quiet, partialRetryMs: 0 });
    assert.strictEqual(idx.graphState(pkg, st.mtimeMs, st.size).attempts, 2);
    assert.strictEqual(idx.enqueueGraph(pkg, st.mtimeMs, st.size), true);
    await until(() => idx.graphState(pkg, st.mtimeMs, st.size).attempts === 3);
    assert.strictEqual(idx.graphState(pkg, st.mtimeMs, st.size).retrying, false, 'three attempts, then it stops');
    assert.strictEqual(idx.enqueueGraph(pkg, st.mtimeMs, st.size), false);
  } finally {
    idx.close();
  }
});

// --- second review P2: invalidation reaches maps the LRU evicted ----------------

test('folder map: a change invalidates the map even after package graphs pushed it out of memory', async () => {
  const dataDir = fs.mkdtempSync(path.join(work, 'data-'));
  const folder = path.join(work, 'Evicted');
  looseAsset(folder, 'a.txt', 60);
  const idx = createPackageIndex({ dir: dataDir, log: quiet });
  try {
    await idx.folderGraph(folder);
    // Nine package graphs read through the 8-entry cache evict the folder map.
    for (let i = 0; i < 9; i += 1) {
      const pkg = path.join(work, `Evict${i}.unitypackage`);
      fs.writeFileSync(pkg, unityPackage([{ guid: guid(70 + i), path: `Assets/${i}.txt`, asset: String(i) }]));
      const st = fs.statSync(pkg);
      idx.enqueueGraph(pkg, st.mtimeMs, st.size, { priority: true });
      await until(() => idx.getGraph(pkg, st.mtimeMs, st.size));
    }
    looseAsset(folder, 'b.txt', 61);
    idx.invalidateFolders(path.join(folder, 'b.txt'));
    assert.ok((await idx.folderGraph(folder)).paths[guid(61)], 'rebuilt, not read back from disk');
  } finally {
    idx.close();
  }
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
