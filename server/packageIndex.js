'use strict';

// Background index for `.unitypackage` files.
//
// Why: Unity's Asset Store cache has no per-package folders and no previews, so
// a 632-package library renders as 632 letter avatars with no indication of
// what is inside. A .unitypackage is a gzipped tar that already contains
// Unity's own preview images and the real asset paths (the same trick the
// "package-extractor" browser tool uses), so we can derive:
//
//   - a card thumbnail, without touching assetstore.unity.com
//   - honest "what's inside" counts and a content list
//
// Constraints that shaped this:
//   - packages range from 10 KB to >12 GB, so work is budgeted: pass 1 stops as
//     soon as a usable preview is found (~10 MB of decompression), pass 2 walks
//     the whole archive only for packages under PV_PACKAGE_INDEX_MAX_MB
//   - parsing runs in a worker thread (pkgWorker.js): gunzip must not block HTTP
//   - everything is cached per (path, mtime, size) under PV_DATA_DIR/packages,
//     so restarts resume instead of re-reading 100 GB from the NAS
//   - one package at a time: indexing must never compete with the UI

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');

const { GRAPH_SCHEMA, graphSummary } = require('./unityGraph');
const { contentsFromGraph } = require('./unityPackage');

const sha1 = (value) => crypto.createHash('sha1').update(value).digest('hex');
const NOTIFY_MS = 20000;          // at most one ETag bump per 20 s while busy
const PREVIEW_BUDGET = 64 * 1024 * 1024;
const FULL_BUDGET = 256 * 1024 * 1024;
const TIMEOUT_MS = 45000;
const MAX_CONTENTS = 4000;
const CONTENTS_CAP = MAX_CONTENTS;

function createPackageIndex({
  dir, enabled = true, maxPackageBytes = 4096 * 1024 * 1024, onUpdate = null, log = console,
  graphEnabled = true, graphTimeoutMs = 30 * 60 * 1000,
}) {
  const cacheDir = path.join(dir, 'packages');
  const previewDir = path.join(cacheDir, 'previews');
  const metaDir = path.join(cacheDir, 'meta');
  // Link maps (guid -> path, materials, prefabs, importer settings). Named
  // <sha1(file)>-<mtime>-<size>-s<schema>.json so freshness is a name lookup.
  const graphDir = path.join(cacheDir, 'graph');
  const graphFailFile = path.join(graphDir, 'failed.json');
  const useGraph = enabled && graphEnabled;

  if (enabled) {
    for (const d of [cacheDir, previewDir, metaDir, ...(useGraph ? [graphDir] : [])]) {
      try { fs.mkdirSync(d, { recursive: true }); } catch (err) { log.warn(`[poly-vault] package cache unavailable: ${err.message}`); }
    }
  }

  // Counts of what is already on disk, so status is meaningful after a restart
  // (the per-session counters start at zero).
  const cachedCounts = { entries: 0, previews: 0 };
  try {
    cachedCounts.entries = fs.readdirSync(metaDir).filter((f) => f.endsWith('.json')).length;
    cachedCounts.previews = fs.readdirSync(previewDir).filter((f) => f.endsWith('.png')).length;
  } catch (_) { /* directory not created yet */ }

  const memory = new Map();   // absPath -> entry
  const queue = [];           // { file, size, mtimeMs, mode }
  const queued = new Map();   // absPath -> mode
  const inFlight = new Set();
  const failures = new Map();   // absPath -> consecutive failures
  let worker = null;
  // Every worker message carries a unique id; replies are routed by it, so
  // index, link-map, extraction and folder requests can be in flight together.
  const pendingReplies = new Map();   // message id -> resolve
  let msgSeq = 0;
  const nextId = (kind) => `${kind}:${(msgSeq += 1)}`;
  function sendToWorker(msg, resolve) {
    pendingReplies.set(msg.id, resolve);
    try {
      ensureWorker().postMessage(msg);
    } catch (err) {
      pendingReplies.delete(msg.id);
      resolve({ ok: false, error: err.message });
    }
  }
  let extractChain = Promise.resolve();
  const extractInFlight = new Map();   // "file\u0000entry" -> promise
  let draining = false;
  let lastNotify = 0;
  let notifyTimer = null;
  let version = 0;

  const stats = {
    enabled,
    // On-disk totals (survive restarts); `indexed`/`previews` below count the
    // work done by this process.
    cachedPackages: 0,
    cachedPreviews: 0,
    indexed: 0,
    previews: 0,
    fullPasses: 0,
    failed: 0,
    skipped: 0,
    bytesRead: 0,
    active: 0,
    lastFile: '',
    lastMs: 0,
    cacheDir,
  };

  function refreshCachedTotals() {
    try { stats.cachedPackages = fs.readdirSync(metaDir).length; } catch (_) { stats.cachedPackages = 0; }
    try { stats.cachedPreviews = fs.readdirSync(previewDir).length; } catch (_) { stats.cachedPreviews = 0; }
  }
  if (enabled) refreshCachedTotals();

  // --- link-map state --------------------------------------------------------
  const graphIndex = new Map();       // sha1(file) -> { mtimeMs, size, schema, name }
  const graphQueue = [];              // { file, size, mtimeMs }
  const graphQueued = new Set();
  const graphCache = new Map();       // file -> parsed graph (small LRU)
  let graphActiveFile = '';
  let graphFailures = {};             // file -> { mtimeMs, size, error, count, at }
  const graphStats = { built: 0, failed: 0, bytesRead: 0, lastFile: '', lastMs: 0 };
  const GRAPH_NAME = /^([0-9a-f]{40})-(\d+)-(\d+)-s(\d+)\.json$/;
  if (useGraph) {
    try {
      for (const name of fs.readdirSync(graphDir)) {
        const m = GRAPH_NAME.exec(name);
        if (!m || Number(m[4]) !== GRAPH_SCHEMA) continue;
        const prev = graphIndex.get(m[1]);
        if (!prev || Number(m[2]) > prev.mtimeMs) graphIndex.set(m[1], { mtimeMs: Number(m[2]), size: Number(m[3]), schema: Number(m[4]), name });
      }
    } catch (_) { /* first run */ }
    try { graphFailures = JSON.parse(fs.readFileSync(graphFailFile, 'utf8')) || {}; } catch (_) { graphFailures = {}; }
  }
  const graphPath = (file, mtimeMs, size) => path.join(graphDir, `${sha1(file)}-${Math.trunc(mtimeMs)}-${size}-s${GRAPH_SCHEMA}.json`);
  const graphFresh = (file, mtimeMs, size) => {
    const g = graphIndex.get(sha1(file));
    return g && Math.abs(g.mtimeMs - Math.trunc(mtimeMs)) <= 2 && g.size === size ? g : null;
  };
  const graphFailed = (file, mtimeMs, size) => {
    const f = graphFailures[file];
    return f && Math.abs(f.mtimeMs - Math.trunc(mtimeMs)) <= 2 && f.size === size ? f : null;
  };
  const saveGraphFailures = () => {
    try { fs.writeFileSync(graphFailFile, JSON.stringify(graphFailures)); } catch (_) { /* best effort */ }
  };

  const metaPath = (file) => path.join(metaDir, `${sha1(file)}.json`);
  const previewPath = (file, mtimeMs) => path.join(previewDir, `${sha1(file)}-${Math.trunc(mtimeMs)}.png`);

  function notify(force = false) {
    if (!onUpdate) return;
    const now = Date.now();
    if (!force && now - lastNotify < NOTIFY_MS) {
      if (!notifyTimer) {
        notifyTimer = setTimeout(() => {
          notifyTimer = null;
          lastNotify = Date.now();
          try { onUpdate(); } catch (_) { /* ignore */ }
        }, NOTIFY_MS);
        notifyTimer.unref?.();
      }
      return;
    }
    lastNotify = now;
    try { onUpdate(); } catch (_) { /* ignore */ }
  }

  // NFS reports sub-millisecond mtimes; the scanner round-trips them through an
  // ISO string, which can land 1 ms off. Compare with a tiny tolerance.
  const sameFile = (entry, mtimeMs, size) => Boolean(entry)
    && Math.abs(entry.mtimeMs - Math.trunc(mtimeMs)) <= 2
    && entry.size === size;

  function readEntry(file, mtimeMs, size) {
    const cached = memory.get(file);
    if (sameFile(cached, mtimeMs, size)) return cached;
    try {
      const entry = JSON.parse(fs.readFileSync(metaPath(file), 'utf8'));
      if (sameFile(entry, mtimeMs, size)) {
        if (entry.previewPath && !fs.existsSync(entry.previewPath)) entry.previewPath = '';
        memory.set(file, entry);
        return entry;
      }
    } catch (_) { /* not indexed yet */ }
    return null;
  }

  function saveEntry(entry) {
    try {
      fs.writeFileSync(metaPath(entry.path), JSON.stringify(entry));
      memory.set(entry.path, entry);
      version += 1;
    } catch (err) {
      log.warn(`[poly-vault] could not write package metadata: ${err.message}`);
    }
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(path.join(__dirname, 'pkgWorker.js'));
    worker.unref();
    worker.on('message', (msg) => {
      const reply = pendingReplies.get(msg.id);
      pendingReplies.delete(msg.id);
      if (reply) reply(msg);
    });
    // A dead worker answers nothing: fail what was in flight (it restarts on
    // the next request) instead of leaving callers waiting forever.
    const failAll = (error) => {
      const waiting = [...pendingReplies.values()];
      pendingReplies.clear();
      worker = null;
      for (const reply of waiting) reply({ ok: false, error });
    };
    worker.on('error', (err) => {
      log.warn(`[poly-vault] package worker failed: ${err.message}`);
      failAll(err.message);
    });
    worker.on('exit', () => failAll('package worker stopped'));
    return worker;
  }

  function parseInWorker(file, mode, mtimeMs) {
    return new Promise((resolve) => sendToWorker({
      id: nextId('index'),
      file,
      mode,
      previewPath: previewPath(file, mtimeMs),
      maxUncompressedBytes: mode === 'preview' ? PREVIEW_BUDGET : FULL_BUDGET,
      timeoutMs: TIMEOUT_MS,
    }, resolve));
  }

  /**
   * Extracts one entry to `outPath` on the worker thread.
   * @returns {Promise<{ok:boolean, size?:number, error?:string}>}
   */
  function extractTo(file, entry, outPath, maxBytes = 512 * 1024 * 1024, previewOutPath = null) {
    if (!enabled) return Promise.resolve({ ok: false, error: 'package index disabled' });

    // The worker handles one message at a time; two concurrent requests for the
    // same entry (card thumbnail + large preview) must share one extraction, and
    // different entries must not interleave or they truncate each other's file.
    const key = `${file}\u0000${entry}\u0000${outPath}`;
    if (extractInFlight.has(key)) return extractInFlight.get(key);

    const job = extractChain.then(() => new Promise((resolve) => sendToWorker({
      id: nextId('extract'), action: 'extract', file, entry, outPath, maxBytes, previewOutPath, timeoutMs: TIMEOUT_MS,
    }, resolve)));

    extractInFlight.set(key, job);
    extractChain = job.then(() => undefined, () => undefined);
    job.finally(() => extractInFlight.delete(key));
    return job;
  }

  /**
   * Extracts several assets (by GUID) in one archive pass on the worker.
   * @param {{guid:string,outPath:string,maxBytes?:number}[]} targets
   * @returns {Promise<{ok:boolean, results?:Object, scannedBytes?:number, error?:string}>}
   */
  function extractMany(file, targets) {
    if (!enabled) return Promise.resolve({ ok: false, error: 'package index disabled' });
    if (!targets.length) return Promise.resolve({ ok: true, results: {}, scannedBytes: 0 });
    const job = extractChain.then(() => new Promise((resolve) => sendToWorker({
      id: nextId('extract'), action: 'extractMany', file, targets, timeoutMs: graphTimeoutMs,
    }, resolve)));
    extractChain = job.then(() => undefined, () => undefined);
    return job;
  }

  // --- link maps --------------------------------------------------------------

  function graphMessage(file, outPath) {
    return new Promise((resolve) => sendToWorker({
      id: nextId('graph'), action: 'graph', file, outPath, timeoutMs: graphTimeoutMs,
    }, resolve));
  }

  async function processGraph(job) {
    let stat;
    try { stat = fs.statSync(job.file); } catch (err) {
      graphStats.failed += 1;
      graphFailures[job.file] = { mtimeMs: job.mtimeMs, size: job.size, error: `stat: ${err.code || err.message}`, count: 3, at: new Date().toISOString() };
      saveGraphFailures();
      return;
    }
    const mtime = Math.trunc(stat.mtimeMs);
    if (graphFresh(job.file, mtime, stat.size)) return;
    graphActiveFile = job.file;
    const started = Date.now();
    const out = graphPath(job.file, mtime, stat.size);
    const reply = await graphMessage(job.file, out);
    graphActiveFile = '';
    graphStats.lastMs = Date.now() - started;
    graphStats.lastFile = path.basename(job.file);
    if (!reply.ok) {
      graphStats.failed += 1;
      const prev = graphFailed(job.file, mtime, stat.size);
      graphFailures[job.file] = { mtimeMs: mtime, size: stat.size, error: reply.error, count: (prev ? prev.count : 0) + 1, at: new Date().toISOString() };
      saveGraphFailures();
      log.warn(`[poly-vault] link map failed for ${path.basename(job.file)}: ${reply.error}`);
      return;
    }
    const key = sha1(job.file);
    const old = graphIndex.get(key);
    if (old && old.name !== path.basename(out)) {
      try { fs.unlinkSync(path.join(graphDir, old.name)); } catch (_) { /* ignore */ }
    }
    graphIndex.set(key, { mtimeMs: mtime, size: stat.size, schema: GRAPH_SCHEMA, name: path.basename(out) });
    graphCache.delete(job.file);
    if (graphFailures[job.file]) { delete graphFailures[job.file]; saveGraphFailures(); }
    graphStats.built += 1;
    fillFromGraph(job.file, mtime, stat.size);
    graphStats.bytesRead += (reply.summary && reply.summary.scannedBytes) || 0;
    // No ETag bump: link maps are not part of the library payload, and the
    // eager pass would otherwise make every browser refetch it every 20 s.
  }

  function enqueueGraph(file, mtimeMs, size, opts = {}) {
    if (!useGraph || !file || !mtimeMs || !size) return false;
    if (graphFresh(file, mtimeMs, size)) return false;
    if (graphQueued.has(file) || graphActiveFile === file) return false;
    const failed = graphFailed(file, mtimeMs, size);
    if (failed && failed.count >= 3 && !opts.force) return false;
    const item = { file, size, mtimeMs: Math.trunc(mtimeMs) };
    // On-demand requests (someone opened a model) jump the background queue.
    if (opts.priority) graphQueue.unshift(item); else graphQueue.push(item);
    graphQueued.add(file);
    drain().catch((err) => log.warn(`[poly-vault] package index drain failed: ${err.message}`));
    return true;
  }

  // Loose folders (assets with .meta siblings): built on demand on the worker,
  // cached on disk for FOLDER_TTL_MS (folders change rarely; "Update" clears).
  const FOLDER_TTL_MS = 10 * 60 * 1000;
  // A folder walk (one stat + read per .meta, over NFS) must not hold the
  // worker indefinitely: past this it stops and the graph says it is partial.
  const FOLDER_TIME_BUDGET_MS = Number(process.env.PV_FOLDER_GRAPH_BUDGET_MS || 60000);
  const folderInFlight = new Map();
  // `shallow`: only the folder's own files (used when a model sits directly
  // in a library root, so one click never maps a whole library).
  const folderKey = (dirPath, shallow) => `dir:${dirPath}${shallow ? '\u0000shallow' : ''}`;
  const folderOut = (dirPath, shallow) => path.join(graphDir, 'folders', `${sha1(folderKey(dirPath, shallow))}.json`);
  function folderGraph(dirPath, opts = {}) {
    if (!useGraph) return Promise.resolve(null);
    const shallow = Boolean(opts.shallow);
    const key = folderKey(dirPath, shallow);
    const out = folderOut(dirPath, shallow);
    const cached = graphCache.get(key);
    if (!opts.force && cached && Date.now() - cached.at < FOLDER_TTL_MS) return Promise.resolve(cached.graph);
    if (!opts.force) {
      try {
        const st = fs.statSync(out);
        if (Date.now() - st.mtimeMs < FOLDER_TTL_MS) {
          const graph = JSON.parse(fs.readFileSync(out, 'utf8'));
          graphCache.set(key, { at: st.mtimeMs, graph, dir: dirPath, shallow });
          return Promise.resolve(graph);
        }
      } catch (_) { /* build it */ }
    }
    if (folderInFlight.has(key)) return folderInFlight.get(key);
    const job = new Promise((resolve) => sendToWorker({
      id: nextId('folder'), action: 'folderGraph', dir: dirPath, outPath: out, shallow,
      maxFiles: opts.maxFiles || 50000, timeBudgetMs: opts.timeBudgetMs || FOLDER_TIME_BUDGET_MS,
    }, (msg) => {
      if (!msg.ok) { log.warn(`[poly-vault] folder link map failed for ${dirPath}: ${msg.error}`); resolve(null); return; }
      try {
        const graph = JSON.parse(fs.readFileSync(out, 'utf8'));
        graphCache.set(key, { at: Date.now(), graph, dir: dirPath, shallow });
        if (graph.truncated) log.warn(`[poly-vault] folder link map for ${dirPath} is partial (${graph.truncated})`);
        resolve(graph);
      } catch (_) { resolve(null); }
    }));
    folderInFlight.set(key, job);
    job.finally(() => folderInFlight.delete(key));
    return job;
  }

  /**
   * Drop cached folder link maps affected by a change at `changedPath` (all of
   * them when omitted, e.g. the "Update" button): the folder itself, any folder
   * containing it, and for a shallow map only a change directly inside it.
   */
  function invalidateFolders(changedPath) {
    const changed = changedPath ? path.resolve(changedPath) : null;
    const affected = (dir, shallow) => {
      if (!changed) return true;
      if (changed === dir) return true;
      if (!changed.startsWith(dir + path.sep)) return false;
      return !shallow || path.dirname(changed) === dir;
    };
    for (const [key, entry] of [...graphCache.entries()]) {
      if (!key.startsWith('dir:') || !affected(entry.dir, entry.shallow)) continue;
      graphCache.delete(key);
      // Synchronously: the next request must not read the stale file back.
      fs.rmSync(folderOut(entry.dir, entry.shallow), { force: true });
    }
    if (!changed) {
      // Maps not in memory (evicted, or from before a restart) are on disk only.
      let names = [];
      try { names = fs.readdirSync(path.join(graphDir, 'folders')); } catch (_) { names = []; }
      for (const n of names) fs.rmSync(path.join(graphDir, 'folders', n), { force: true });
    }
  }

  /** Parsed link map of a package, or null when it is not built yet. */
  function getGraph(file, mtimeMs, size) {
    if (!useGraph) return null;
    const g = graphFresh(file, mtimeMs, size);
    if (!g) return null;
    const cached = graphCache.get(file);
    if (cached && cached.name === g.name) return cached.graph;
    try {
      const graph = JSON.parse(fs.readFileSync(path.join(graphDir, g.name), 'utf8'));
      graphCache.set(file, { name: g.name, graph });
      while (graphCache.size > 8) graphCache.delete(graphCache.keys().next().value);
      return graph;
    } catch (_) {
      graphIndex.delete(sha1(file));
      return null;
    }
  }

  function graphState(file, mtimeMs, size) {
    if (!useGraph) return { state: 'disabled' };
    if (graphFresh(file, mtimeMs, size)) return { state: 'ready' };
    if (graphActiveFile === file) return { state: 'building' };
    if (graphQueued.has(file)) return { state: 'queued', position: graphQueue.findIndex((j) => j.file === file) + 1 };
    const failed = graphFailed(file, mtimeMs, size);
    if (failed) return { state: failed.count >= 3 ? 'failed' : 'retrying', error: failed.error, attempts: failed.count };
    return { state: 'missing' };
  }

  async function processOne(job) {
    let stat;
    try { stat = fs.statSync(job.file); } catch (_) { stats.failed += 1; return; }

    const started = Date.now();
    const reply = await parseInWorker(job.file, job.mode, stat.mtimeMs);
    stats.lastMs = Date.now() - started;
    stats.lastFile = path.basename(job.file);

    if (!reply.ok) {
      stats.failed += 1;
      failures.set(job.file, (failures.get(job.file) || 0) + 1);
      log.warn(`[poly-vault] package index failed for ${path.basename(job.file)}: ${reply.error}`);
      return;
    }
    failures.delete(job.file);

    const previous = readEntry(job.file, stat.mtimeMs, stat.size);
    const entry = reply.entry;
    entry.contents = (entry.contents || []).slice(0, MAX_CONTENTS);

    // A preview pass must not discard accurate contents from an earlier full pass.
    if (previous && previous.mode === 'full' && entry.mode === 'preview') {
      entry.counts = previous.counts;
      entry.totalAssets = previous.totalAssets;
      entry.totalBytes = previous.totalBytes;
      entry.folders = previous.folders;
      entry.contents = previous.contents;
      entry.partial = previous.partial;
      entry.truncated = previous.truncated;
      entry.mode = 'full';
      if (!entry.previewPath) entry.previewPath = previous.previewPath;
    }
    if (previous && previous.previewPath) {
      if (!entry.previewPath) {
        // This pass stopped before finding a preview (byte/time budget): keep
        // the one we already have instead of degrading the card to an initial.
        entry.previewPath = previous.previewPath;
        entry.previewBytes = previous.previewBytes || 0;
        entry.previewSource = previous.previewSource || '';
      } else if (previous.previewPath !== entry.previewPath) {
        try { fs.unlinkSync(previous.previewPath); } catch (_) { /* ignore */ }
      }
    }

    entry.previewTried = true;
    entry.contentsCap = CONTENTS_CAP;
    saveEntry(entry);
    refreshCachedTotals();
    stats.indexed += 1;
    stats.bytesRead += entry.scannedBytes || 0;
    if (entry.previewPath) stats.previews += 1;
    if (entry.mode === 'full') stats.fullPasses += 1;
    fillFromGraph(job.file, stat.mtimeMs, stat.size);

    // Second pass: accurate contents for packages small enough to be worth it.
    if (entry.mode === 'preview' && stat.size <= maxPackageBytes) {
      queue.push({ file: job.file, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs), mode: 'full' });
      queued.set(job.file, 'full');
    }
    notify();
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length || graphQueue.length) {
        // Previews/contents first (cards), link maps when that queue is idle.
        if (!queue.length) {
          const g = graphQueue.shift();
          graphQueued.delete(g.file);
          try {
            await processGraph(g);
          } catch (err) {
            graphStats.failed += 1;
            graphActiveFile = '';
            log.warn(`[poly-vault] link map error: ${err.message}`);
          }
          continue;
        }
        const job = queue.shift();
        queued.delete(job.file);
        if (inFlight.has(job.file)) continue;
        inFlight.add(job.file);
        stats.active = 1;
        try {
          await processOne(job);
        } catch (err) {
          stats.failed += 1;
          log.warn(`[poly-vault] package index error: ${err.message}`);
        } finally {
          inFlight.delete(job.file);
          stats.active = 0;
        }
      }
    } finally {
      stats.active = 0;
      draining = false;
      if (queue.length === 0) notify(true); // final bump so clients see everything
    }
  }

  // `mtimeMs`/`size` come from the scan result, so a poll never stats the NAS.
  function enqueue(file, mtimeMs, size, opts = {}) {
    if (!enabled || !file) return false;

    let mtime = Math.trunc(mtimeMs || 0);
    let bytes = Math.trunc(size || 0);
    if (!mtime || !bytes) {
      try {
        const stat = fs.statSync(file);
        mtime = Math.trunc(stat.mtimeMs);
        bytes = stat.size;
      } catch (_) { stats.skipped += 1; return false; }
    }

    // Every package gets a link map, eagerly, behind previews and contents.
    enqueueGraph(file, mtime, bytes);

    const existing = readEntry(file, mtime, bytes);
    // `previewTried` remembers a pass that found no preview (editor-only tools
    // often have none): without it those packages would be re-read forever.
    const needsPreview = !existing || (!existing.previewPath && !existing.previewTried);
    const needsContents = bytes <= maxPackageBytes
      && Boolean(existing)
      && (existing.mode !== 'full' || Boolean(opts.force));
    if (!needsPreview && !needsContents) return false;
    if (queued.has(file) || inFlight.has(file)) return false;
    if ((failures.get(file) || 0) >= 3) return false;

    const mode = needsPreview ? 'preview' : 'full';
    queue.push({ file, size: bytes, mtimeMs: mtime, mode });
    queued.set(file, mode);
    drain().catch((err) => log.warn(`[poly-vault] package index drain failed: ${err.message}`));
    return true;
  }

  function get(file, mtimeMs, size) {
    if (!enabled || !file) return null;
    return readEntry(file, mtimeMs, size);
  }

  // Big packages: the contents pass stops at its byte budget, but the link map
  // walks every header. Fill "what's inside" (counts, file list) from it.
  function fillFromGraph(file, mtimeMs, size) {
    if (!enabled || !useGraph) return false;
    const entry = readEntry(file, mtimeMs, size);
    if (!entry || entry.contentsSource === 'graph' || (!entry.partial && entry.mode === 'full')) return false;
    const merged = contentsFromGraph(entry, getGraph(file, mtimeMs, size), MAX_CONTENTS);
    if (!merged) return false;
    saveEntry({ ...entry, ...merged });
    notify();
    return true;
  }

  // Once per start: entries indexed before this existed.
  if (enabled && useGraph) {
    const t = setTimeout(() => {
      let filled = 0;
      let names = [];
      try { names = fs.readdirSync(metaDir); } catch (_) { names = []; }
      for (const name of names) {
        let e;
        try { e = JSON.parse(fs.readFileSync(path.join(metaDir, name), 'utf8')); } catch (_) { continue; }
        if (!e || !e.path || e.contentsSource === 'graph' || (!e.partial && e.mode === 'full')) continue;
        if (fillFromGraph(e.path, e.mtimeMs, e.size)) filled += 1;
      }
      if (filled) log.info?.(`[poly-vault] filled contents of ${filled} large package(s) from their link maps`);
    }, 2000);
    t.unref?.();
  }

  function status() {
    return {
      ...stats,
      cached: { ...cachedCounts },
      queued: queue.length,
      queue: queue.length,
      version,
      maxPackageBytes,
      previewBudgetBytes: PREVIEW_BUDGET,
      fullBudgetBytes: FULL_BUDGET,
      graph: {
        enabled: useGraph,
        schema: GRAPH_SCHEMA,
        ready: graphIndex.size,
        queued: graphQueue.length,
        building: graphActiveFile ? path.basename(graphActiveFile) : '',
        failed: Object.values(graphFailures).filter((f) => f.count >= 3).length,
        builtThisRun: graphStats.built,
        failedThisRun: graphStats.failed,
        bytesRead: graphStats.bytesRead,
        lastFile: graphStats.lastFile,
        lastMs: graphStats.lastMs,
      },
    };
  }

  function graphFailuresList() {
    return Object.entries(graphFailures).map(([file, f]) => ({ file, ...f }));
  }

  function close() {
    if (notifyTimer) clearTimeout(notifyTimer);
    if (worker) { try { worker.terminate(); } catch (_) { /* ignore */ } worker = null; }
  }

  return {
    get, enqueue, extractTo, extractMany, status, close, cacheDir, previewDir, contentsCap: CONTENTS_CAP,
    enqueueGraph, getGraph, graphState, graphSummary, graphFailuresList, folderGraph, invalidateFolders,
  };
}

module.exports = { createPackageIndex };
