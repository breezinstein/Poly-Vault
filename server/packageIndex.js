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

const sha1 = (value) => crypto.createHash('sha1').update(value).digest('hex');
const NOTIFY_MS = 20000;          // at most one ETag bump per 20 s while busy
const PREVIEW_BUDGET = 64 * 1024 * 1024;
const FULL_BUDGET = 256 * 1024 * 1024;
const TIMEOUT_MS = 45000;
const MAX_CONTENTS = 120;

function createPackageIndex({ dir, enabled = true, maxPackageBytes = 4096 * 1024 * 1024, onUpdate = null, log = console }) {
  const cacheDir = path.join(dir, 'packages');
  const previewDir = path.join(cacheDir, 'previews');
  const metaDir = path.join(cacheDir, 'meta');

  if (enabled) {
    for (const d of [cacheDir, previewDir, metaDir]) {
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
  let pendingReply = null;
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
      const reply = pendingReply;
      pendingReply = null;
      if (reply) reply(msg);
    });
    worker.on('error', (err) => {
      log.warn(`[poly-vault] package worker failed: ${err.message}`);
      const reply = pendingReply;
      pendingReply = null;
      worker = null;
      if (reply) reply({ ok: false, error: err.message });
    });
    worker.on('exit', () => { worker = null; });
    return worker;
  }

  function parseInWorker(file, mode, mtimeMs) {
    return new Promise((resolve) => {
      pendingReply = resolve;
      try {
        ensureWorker().postMessage({
          id: `${file}:${mode}`,
          file,
          mode,
          previewPath: previewPath(file, mtimeMs),
          maxUncompressedBytes: mode === 'preview' ? PREVIEW_BUDGET : FULL_BUDGET,
          timeoutMs: TIMEOUT_MS,
        });
      } catch (err) {
        pendingReply = null;
        resolve({ ok: false, error: err.message });
      }
    });
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
    saveEntry(entry);
    refreshCachedTotals();
    stats.indexed += 1;
    stats.bytesRead += entry.scannedBytes || 0;
    if (entry.previewPath) stats.previews += 1;
    if (entry.mode === 'full') stats.fullPasses += 1;

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
      while (queue.length) {
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
  function enqueue(file, mtimeMs, size) {
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

    const existing = readEntry(file, mtime, bytes);
    // `previewTried` remembers a pass that found no preview (editor-only tools
    // often have none): without it those packages would be re-read forever.
    const needsPreview = !existing || (!existing.previewPath && !existing.previewTried);
    const needsContents = Boolean(existing) && existing.mode !== 'full' && bytes <= maxPackageBytes;
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
    };
  }

  function close() {
    if (notifyTimer) clearTimeout(notifyTimer);
    if (worker) { try { worker.terminate(); } catch (_) { /* ignore */ } worker = null; }
  }

  return { get, enqueue, status, close, cacheDir, previewDir };
}

module.exports = { createPackageIndex };
