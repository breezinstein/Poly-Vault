'use strict';

// Poly Vault — team web front door.
//
// Wraps the upstream Poly Vault core (src/main/library.js, bridgeServer.js,
// store.js, enrichment.js, unityAssetStore.js) in a single HTTP service so a
// team can share one library over the network instead of running the Electron
// desktop app. Upstream Electron files (src/main/index.js, src/preload.js) are
// not used.
//
//   browser  --HTTP-->  this server  --loopback-->  bridge (unmodified API)
//
// The bridge keeps its original loopback-only bind; this process is the only
// listener exposed to the network, so auth, TLS termination (via a proxy),
// CORS policy and scan caching all live here.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const zlib = require('zlib');
const crypto = require('crypto');
const { Worker } = require('worker_threads');

const { JsonStore } = require('../src/main/store');
const { startBridge } = require('../src/main/bridgeServer');
const { scanLibrary, hashString, IMPORTABLE_EXTENSIONS } = require('../src/main/library');
const { streamZip } = require('./zipStream');
const metrics = require('./metrics');
const { createAudit } = require('./audit');
const { createThumbCache, clampWidth } = require('./thumbs');
const { createPackageIndex } = require('./packageIndex');
const { kindForPath } = require('./unityPackage');
const { findAndFetchDescription } = require('../src/main/unityAssetStore');
const { createEnrichment, mergeMetaEntry } = require('../src/main/enrichment');

// ---------------------------------------------------------------------------
// Configuration (all via environment; see README)
// ---------------------------------------------------------------------------

const env = process.env;
const APP_VERSION = require('../package.json').version;
const DATA_DIR = path.resolve(env.PV_DATA_DIR || '/data');
const WEB_HOST = env.PV_HOST || '0.0.0.0';
const WEB_PORT = Number(env.PV_PORT || 8080);
const BRIDGE_PORT = Number(env.PV_BRIDGE_PORT || 7100);
const SCAN_MAX_AGE_MS = Number(env.PV_SCAN_MAX_AGE_MS || env.PV_SCAN_TTL_MS || 120000);
const TOKEN = String(env.PV_TOKEN || '').trim();
// Optional per-artist tokens: "alice:tok-a,bob:tok-b". Gives every person an
// identity (job targeting, attribution) while staying a "shared token" model.
const USERS = new Map((env.PV_USERS || '')
  .split(',').map((pair) => pair.trim()).filter(Boolean)
  .map((pair) => {
    const i = pair.indexOf(':');
    return i > 0 ? [pair.slice(0, i).trim(), pair.slice(i + 1).trim()] : null;
  })
  .filter(Boolean));
const DOWNLOAD_MAX_BYTES = Number(env.PV_DOWNLOAD_MAX_BYTES || 2 * 1024 * 1024 * 1024);
const ZIP_CONCURRENCY = Number(env.PV_ZIP_CONCURRENCY || 2);
const RATE_LIMIT_PER_MIN = Number(env.PV_RATE_LIMIT_PER_MIN || 240);
const THUMB_MAX_FILES = Number(env.PV_THUMB_CACHE_MAX_FILES || 20000);
const PACKAGE_INDEX_ENABLED = env.PV_PACKAGE_INDEX !== '0';
// Optional three.js model viewer (vendored at build time). The per-user switch
// lives in the UI; this is only the capability + the default it starts from.
const WEBGL_AVAILABLE = fs.existsSync(path.join(__dirname, '..', 'ui', 'webgl', 'viewer.js'))
  && fs.existsSync(path.join(__dirname, '..', 'ui', 'webgl', 'vendor', 'three.module.min.js'));
const WEBGL_DEFAULT = env.PV_WEBGL !== '0';
const packagesCacheDir = path.join(DATA_DIR, 'packages');
const PACKAGE_INDEX_MAX_MB = Number(env.PV_PACKAGE_INDEX_MAX_MB || 4096);
const ENRICH_ROOTS = (env.PV_ENRICH_ROOTS || '')
  .split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
const TRUST_PROXY_AUTH = env.PV_TRUST_PROXY_AUTH === '1';
const ADMIN_TOKEN = String(env.PV_ADMIN_TOKEN || TOKEN).trim();
const LIBRARY_ROOTS = (env.PV_LIBRARY_ROOTS || '/assets')
  .split(path.delimiter).filter(Boolean).map((p) => path.resolve(p));
// Libraries registered on every boot. Defaults to the mounted asset root.
const SEED_LIBRARIES = (env.PV_LIBRARIES || env.PV_LIBRARY_ROOTS || '/assets')
  .split(path.delimiter).filter(Boolean);
const PUBLIC_ORIGIN = String(env.PV_PUBLIC_ORIGIN || '').replace(/\/+$/, '');

fs.mkdirSync(DATA_DIR, { recursive: true });

// The Unity add-on shipped in the image (built from the same patched source),
// offered for download from the UI so the editor matches this server.
const PLUGIN_DIR = path.resolve(env.PV_PLUGIN_DIR || path.join(__dirname, '..', 'plugin'));
const plugin = (() => {
  try {
    const files = fs.readdirSync(PLUGIN_DIR);
    const pick = (ext) => {
      const name = files.find((f) => f.toLowerCase().endsWith(ext));
      if (!name) return null;
      const full = path.join(PLUGIN_DIR, name);
      return { file: full, name, size: fs.statSync(full).size };
    };
    const tgz = pick('.tgz');
    const zip = pick('.zip');
    if (!tgz && !zip) return null;
    const version = ((tgz || zip).name.match(/-([0-9][\w.\-]*)\.(tgz|zip)$/) || [])[1] || '';
    return { version, tgz, zip };
  } catch (_) {
    return null;
  }
})();

// ---------------------------------------------------------------------------
// Stores (same files and seeds as the desktop app, so a data folder is portable)
// ---------------------------------------------------------------------------

const settings = new JsonStore(path.join(DATA_DIR, 'asset-vault-settings.json'), {
  libraries: [], server: { host: '127.0.0.1', port: BRIDGE_PORT },
});
const jobsStore = new JsonStore(path.join(DATA_DIR, 'asset-vault-jobs.json'), { jobs: [] });
const tagsStore = new JsonStore(path.join(DATA_DIR, 'asset-vault-tags.json'), { tags: {} });
const metaStore = new JsonStore(path.join(DATA_DIR, 'asset-vault-meta.json'), { meta: {} });

function registerLibrary(absPath) {
  const normalized = path.resolve(absPath);
  if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) return null;
  const libs = settings.get('libraries') || [];
  const existing = libs.find((l) => path.resolve(l.path) === normalized);
  if (existing) return existing;
  const lib = {
    id: `lib_${hashString(normalized)}`,
    name: path.basename(normalized) || normalized,
    path: normalized,
    addedAt: new Date().toISOString(),
  };
  libs.push(lib);
  settings.set('libraries', libs);
  return lib;
}

// Mounted libraries are declared by the operator (read-only volume).
for (const p of SEED_LIBRARIES) {
  if (!registerLibrary(p)) console.warn(`[poly-vault] seeded library not found: ${p}`);
}

function withinRoots(p, roots) {
  const resolved = path.resolve(p);
  return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

function getState() {
  return {
    name: 'Poly Vault',
    version: APP_VERSION,
    libraries: (settings.get('libraries') || []).map((l) => (fs.existsSync(l.path) ? l : { ...l, missing: true })),
    jobs: jobsStore.get('jobs') || [],
  };
}

// ---------------------------------------------------------------------------
// Tags / meta / enrichment (mirrors src/main/index.js wiring)
// ---------------------------------------------------------------------------

// Bumped whenever stored data changes, so the cached scan is invalidated.
let dataVersion = 1;
const bump = () => { dataVersion += 1; };

const metaOf = (p) => (metaStore.get('meta') || {})[path.resolve(p)] || null;
const writeMetaEntry = (p, entry) => {
  const all = metaStore.get('meta') || {};
  const key = path.resolve(p);
  all[key] = mergeMetaEntry(all[key], entry);
  metaStore.set('meta', all);
  bump();
  return all[key];
};
const tagsMap = () => tagsStore.get('tags') || {};
const tagOf = (p) => {
  const v = tagsMap()[path.resolve(p)];
  return Array.isArray(v) ? v : [];
};
const setTagsFor = (entries) => {
  const all = tagsMap();
  for (const e of entries) {
    const key = path.resolve(e.path);
    if (!e.tags || !e.tags.length) delete all[key]; else all[key] = e.tags;
  }
  tagsStore.set('tags', all);
  bump();
};

const audit = createAudit(DATA_DIR);
const thumbs = createThumbCache({ dir: DATA_DIR, maxFiles: THUMB_MAX_FILES });
const packageIndex = createPackageIndex({
  dir: DATA_DIR,
  enabled: PACKAGE_INDEX_ENABLED,
  maxPackageBytes: PACKAGE_INDEX_MAX_MB * 1024 * 1024,
  onUpdate: () => { scanGeneration += 1; }, // new preview/metadata -> new ETag
});

const enrichment = createEnrichment({
  getMeta: metaOf,
  setMeta: writeMetaEntry,
  getTags: tagOf,
  setTags: setTagsFor,
  lookup: findAndFetchDescription,
});
const enrichmentEnabled = env.ASSETVAULT_NO_ENRICH !== '1';

// ---------------------------------------------------------------------------
// Scan cache: per-library, watch-invalidated
// ---------------------------------------------------------------------------
//
// Upstream rescans every library synchronously on each GET /api/library. With
// one desktop client that is fine; with a team it is a blocking O(files) walk
// per poll, per client. Here each library is scanned at most once and reused
// until (a) its tags/descriptions change, (b) fs.watch reports a change under
// its root, or (c) PV_SCAN_MAX_AGE_MS elapses — the last one because inotify
// does not work on most NFS/SMB mounts, so watches can be silent there.

let scanGeneration = 0;                // bumped whenever any library is rescanned
const libCache = new Map();            // lib.id -> { version, at, data }
const dirtyLibs = new Set();           // invalidated by fs.watch
const watchers = new Map();            // lib.path -> fs.FSWatcher
const scanStats = { scans: 0, hits: 0, lastMs: 0, lastLibrary: '', watchEvents: 0, watchErrors: 0 };


function scanOptions() {
  const tagMap = tagsMap();
  const metaMap = metaStore.get('meta') || {};
  return {
    getTags: (p) => {
      const v = tagMap[path.resolve(p)];
      return Array.isArray(v) ? v : [];
    },
    getMeta: (p) => {
      const e = metaMap[path.resolve(p)];
      return e && e.description ? e.description : '';
    },
  };
}

// Prune caches for libraries that were removed.
function pruneLibCache(libs) {
  const alive = new Set(libs.map((l) => l.id));
  for (const id of libCache.keys()) if (!alive.has(id)) libCache.delete(id);
  const roots = new Set(libs.map((l) => l.path));
  for (const [root, watcher] of watchers) {
    if (roots.has(root)) continue;
    try { watcher.close(); } catch (_) { /* ignore */ }
    watchers.delete(root);
  }
}

let watchDebounce = null;
function watchLibraries(libs) {
  for (const lib of libs) {
    if (watchers.has(lib.path)) continue;
    try {
      const watcher = fs.watch(lib.path, { recursive: true }, (eventType, filename) => {
        // Mark only the library that contains the changed path, and coalesce
        // bursts (copying 500 files must cause one rescan, not 500).
        const changed = filename ? path.join(lib.path, String(filename)) : lib.path;
        for (const l of settings.get('libraries') || []) {
          const root = path.resolve(l.path);
          if (changed === root || String(changed).startsWith(root + path.sep)) dirtyLibs.add(l.id);
        }
        scanStats.watchEvents += 1;
        if (watchDebounce) return;
        watchDebounce = setTimeout(() => { watchDebounce = null; }, 750);
      });
      watcher.on('error', () => {
        scanStats.watchErrors += 1;
        try { watcher.close(); } catch (_) { /* ignore */ }
        watchers.delete(lib.path);
      });
      watcher.unref?.();
      watchers.set(lib.path, watcher);
    } catch (_) {
      // ENOENT (not mounted yet) or ENOSPC (watch limit): TTL polling covers us.
      scanStats.watchErrors += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Off-thread scanning
// ---------------------------------------------------------------------------
// The upstream scanner is synchronous; over NFS one library can take ~10 s.
// Scans run in a worker thread and are single-flighted per library, so requests
// stay responsive and a burst of clients still causes exactly one walk.

let worker = null;
let workerSeq = 0;
const workerPending = new Map();   // id -> {resolve, reject}
const scanInFlight = new Map();    // lib.id -> Promise<data>

function getWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'scanWorker.js'));
  worker.unref();
  worker.on('message', (msg) => {
    const pending = workerPending.get(msg.id);
    if (!pending) return;
    workerPending.delete(msg.id);
    if (msg.ok) pending.resolve(msg.data);
    else pending.reject(new Error(msg.error));
  });
  worker.on('error', (err) => {
    console.error('[poly-vault] scan worker failed, falling back to in-process scans:', err.message);
    for (const [, pending] of workerPending) pending.reject(err);
    workerPending.clear();
    worker = null;
  });
  worker.on('exit', () => { worker = null; });
  return worker;
}

function scanInWorker(lib) {
  const id = (workerSeq += 1);
  const payload = {
    id,
    lib: { id: lib.id, name: lib.name, path: lib.path },
    tags: tagsMap(),
    meta: metaStore.get('meta') || {},
  };
  return new Promise((resolve, reject) => {
    workerPending.set(id, { resolve, reject });
    try {
      getWorker().postMessage(payload);
    } catch (err) {
      workerPending.delete(id);
      reject(err);
    }
  });
}

async function scanOne(lib, force = false) {
  const cached = libCache.get(lib.id);
  const fresh = !force
    && cached
    && cached.version === dataVersion
    && !dirtyLibs.has(lib.id)
    && Date.now() - cached.at < SCAN_MAX_AGE_MS;
  if (fresh) {
    scanStats.hits += 1;
    return cached.data;
  }

  const flightKey = `${lib.id}:${dataVersion}`;
  if (scanInFlight.has(flightKey)) {
    scanStats.hits += 1;
    return scanInFlight.get(flightKey);
  }

  const job = (async () => {
    const started = Date.now();
    let data;
    try {
      data = await scanInWorker(lib);
      metrics.counter('pv_scan_worker_total');
    } catch (_) {
      // Worker unavailable: correctness first, accept the blocking scan.
      metrics.counter('pv_scan_inline_total');
      data = scanLibrary(lib, scanOptions());
    }
    const elapsed = Date.now() - started;

    // Only bump the generation (and therefore the API ETag) when the *content*
    // changed. A periodic rescan of an untouched library then keeps answering
    // 304s instead of re-sending the whole payload to every client.
    const { scannedAt, ...stable } = data;
    const sig = crypto.createHash('sha1').update(JSON.stringify(stable)).digest('hex');
    const current = libCache.get(lib.id);
    if (!current || current.sig !== sig) scanGeneration += 1;

    libCache.set(lib.id, { version: dataVersion, at: Date.now(), data, sig });
    dirtyLibs.delete(lib.id);
    scanStats.scans += 1;
    scanStats.lastMs = elapsed;
    scanStats.lastLibrary = lib.name;
    metrics.gauge('pv_scan_last_ms', elapsed);
    return data;
  })();

  scanInFlight.set(flightKey, job);
  try {
    return await job;
  } finally {
    scanInFlight.delete(flightKey);
  }
}

// Merges indexed package metadata (previews, contents, type counts) into a
// scan result. Purely in-memory: the scan itself is never invalidated by the
// indexer, only the API ETag is bumped when new entries land.
function decoratePackages(libs) {
  for (const lib of libs) {
    for (const a of lib.assets || []) {
      if (!a.packageFile) continue;
      const mtimeMs = a.updated ? Date.parse(a.updated) : 0;
      // Ask for indexing first (no-op when already done); it uses the scan's
      // mtime/size so polling never stats the NAS again.
      packageIndex.enqueue(a.folder, mtimeMs, a.sizeBytes);
      const entry = packageIndex.get(a.folder, mtimeMs, a.sizeBytes);
      if (!entry) continue;
      if (entry.previewPath) a.preview = { path: entry.previewPath, rel: '', cached: true };
      if (entry.totalAssets) {
        a.fileCount = entry.totalAssets;
        a.kindCounts = entry.counts;
        // Only counts go in the poll payload (5 MB otherwise); the file list is
        // fetched per asset from /api/package when the detail panel opens.
        a.contentsTotal = entry.totalAssets;
        a.contentsPartial = entry.partial;
        a.packageFolders = entry.folders;
        const kinds = Object.keys(entry.counts || {});
        a.kinds = kinds.sort();
      }
    }
  }
  return libs;
}

async function scanAll(force = false) {
  const libs = settings.get('libraries') || [];
  pruneLibCache(libs);
  watchLibraries(libs);
  const scanned = await Promise.all(libs.map((lib) => scanOne(lib, force)));
  libs.forEach((lib, i) => decoratePackages([scanned[i]]));
  return scanned;
}

async function currentScan(force = false) {
  return scanAll(force);
}

function invalidateAll() {
  libCache.clear();
  dirtyLibs.clear();
  for (const l of settings.get('libraries') || []) dirtyLibs.add(l.id);
}

// The bridge asks for one library at a time; serve it from the same cache.
const bridgeScan = (lib) => {
  watchLibraries([lib]);
  return scanOne(lib).then((data) => decoratePackages([data])[0]);
};

// Prewarm so the first browser request is fast and the mount is validated.
setImmediate(async () => {
  try {
    const libs = await currentScan();
    const summary = libs.map((l) => `${l.name}: ${l.assetCount} assets`).join(', ') || 'no libraries';
    console.log(`[poly-vault] scan ready in ${scanStats.lastMs}ms — ${summary}`);
  } catch (err) {
    console.error('[poly-vault] initial scan failed:', err);
  }
});

// ---------------------------------------------------------------------------
// Loopback bridge (unmodified API surface consumed by ui/renderer.js)
// ---------------------------------------------------------------------------

const bridge = startBridge({
  host: '127.0.0.1',
  port: BRIDGE_PORT,
  corsOrigin: null, // same-origin only; no wildcard CORS on a shared server
  getState,
  scan: bridgeScan,
  tags: {
    getAll: () => tagsStore.get('tags') || {},
    set: (p, list) => {
      const all = tagsStore.get('tags') || {};
      const key = path.resolve(p);
      if (!list || list.length === 0) delete all[key]; else all[key] = list;
      tagsStore.set('tags', all);
      bump();
      return all[key] || [];
    },
    applyBulk: (entries) => { setTagsFor(entries); return entries.length; },
  },
  meta: {
    getAll: () => metaStore.get('meta') || {},
    set: (p, description) => {
      const all = metaStore.get('meta') || {};
      const key = path.resolve(p);
      if (!description) delete all[key]; else all[key] = { ...(all[key] || {}), description };
      metaStore.set('meta', all);
      bump();
      return all[key] ? all[key].description : '';
    },
  },
  enrichment: enrichmentEnabled
    ? {
      // Optional per-library scope: some teams want lookups only for the
      // "downloaded packs" library, not for in-house art.
      request: (items, opts) => {
        const scoped = ENRICH_ROOTS.length
          ? items.filter((i) => ENRICH_ROOTS.some((root) => path.resolve(i.path).startsWith(root + path.sep) || path.resolve(i.path) === root))
          : items;
        return enrichment.request(scoped, opts);
      },
      status: () => enrichment.status(),
    }
    : null,
  update: {
    run: async (scope) => {
      bump();
      invalidateAll(); // "Update" means: walk the disk again, no cache
      const libraries = await currentScan();
      const findNode = (nodes, rel) => {
        for (const n of nodes) {
          if (n.rel === rel) return n;
          if (n.children) {
            const hit = findNode(n.children, rel);
            if (hit) return hit;
          }
        }
        return null;
      };
      const collect = (node, out = []) => {
        if (node.type === 'asset') out.push(node.path);
        else for (const c of node.children || []) collect(c, out);
        return out;
      };
      const targets = [];
      for (const lib of libraries) {
        if (scope.type === 'all' || (scope.type === 'library' && lib.id === (scope.libId || null))) {
          targets.push(...(lib.assets || []).map((a) => ({ path: a.folder, name: a.name })));
        }
      }
      if ((scope.type === 'asset' || scope.type === 'container') && scope.libId) {
        const lib = libraries.find((l) => l.id === scope.libId);
        if (lib) {
          const node = findNode(lib.tree || [], scope.rel);
          if (node) {
            if (node.type === 'asset') targets.push({ path: node.path, name: node.name });
            else {
              const paths = new Set(collect(node));
              for (const a of lib.assets || []) if (paths.has(a.folder)) targets.push({ path: a.folder, name: a.name });
            }
          }
        }
      }
      return { libraries, targets };
    },
  },
  onJobsChanged: () => jobsStore.save(),
  onDiag: async () => ({ error: 'diag endpoint is disabled in the web build' }),
});

// ---------------------------------------------------------------------------
// Front door: auth, static UI, /api/web/*, proxy to the bridge
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'ui');
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return require('crypto').timingSafeEqual(ab, bb);
}

// Identity of the caller: proxy-injected user header (SSO) or session cookie.
function identity(req) {
  if (TRUST_PROXY_AUTH) {
    const user = String(req.headers['x-auth-request-user'] || req.headers['x-forwarded-user'] || '').trim();
    if (user) return user;
    return '';
  }
  const presented = presentedToken(req);
  // Order matters: a per-artist token wins, then the shared team token (so a
  // single-token deployment is "shared", not "admin"), then an admin-only token.
  for (const [name, token] of USERS) {
    if (presented && timingSafeEqual(presented, token)) return name;
  }
  if (TOKEN && presented && timingSafeEqual(presented, TOKEN)) return 'shared';
  if (ADMIN_TOKEN && presented && timingSafeEqual(presented, ADMIN_TOKEN)) return 'admin';
  if (!TOKEN && !USERS.size) return 'anonymous';
  return '';
}

function presentedToken(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return parseCookies(req.headers.cookie).pv_session || '';
}

function isAdmin(req) {
  if (TRUST_PROXY_AUTH) {
    const groups = String(req.headers['x-auth-request-groups'] || '').toLowerCase();
    return groups.split(/[,\s]+/).includes('polyvault-admin');
  }
  if (!ADMIN_TOKEN) return false;
  const token = presentedToken(req);
  return Boolean(token) && timingSafeEqual(token, ADMIN_TOKEN);
}

const LOGIN_PAGE = `<!doctype html><meta charset="utf-8"><title>Poly Vault — sign in</title>
<style>body{font:15px/1.5 system-ui;background:#1e1f24;color:#e8e6e1;display:grid;place-items:center;height:100vh;margin:0}
form{background:#26272d;padding:28px 32px;border-radius:14px;display:grid;gap:12px;min-width:280px}
input,button{font:inherit;padding:9px 12px;border-radius:8px;border:1px solid #3a3c44;background:#1e1f24;color:inherit}
button{background:#c8734a;border:0;font-weight:600;cursor:pointer}small{opacity:.6}</style>
<form method="POST" action="/login"><strong>Poly Vault</strong><small>Team library access</small>
<input name="token" type="password" placeholder="Access token" autofocus required autocomplete="current-password">
<button type="submit">Sign in</button></form>`;

function checkOrigin(req) {
  // Same-origin only: blocks drive-by CSRF from other sites and from other
  // hosts on the LAN, which the upstream wildcard CORS policy allowed.
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client (curl, Unity plugin, scripts)
  const allowed = new Set();
  if (PUBLIC_ORIGIN) allowed.add(PUBLIC_ORIGIN);
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (host) {
    allowed.add(`http://${host}`);
    allowed.add(`https://${host}`);
  }
  return allowed.has(origin);
}

/**
 * JSON responses are gzipped and revalidated with an ETag. The library payload
 * is ~1.7 MB per 1,000 assets and every browser polls it every 20 s, so this is
 * the difference between ~50 MB/min and ~50 KB/min for a team of ten.
 *
 * The ETag is derived from the server's own change counters (stored data
 * version + scan generation), so no body hashing is needed and a 304 can be
 * answered without touching the bridge at all.
 */
// Cache location for one extracted entry and for its embedded preview.
function entryCacheDir(pkgReal, stat) {
  return path.join(packagesCacheDir, 'extracted', crypto.createHash('sha1')
    .update(`${pkgReal}\u0000${Math.trunc(stat.mtimeMs)}`).digest('hex'));
}

function entryCachePath(pkgReal, stat, entryPath) {
  return path.join(entryCacheDir(pkgReal, stat), crypto.createHash('sha1').update(entryPath).digest('hex'));
}

function entryPreviewPath(pkgReal, stat, entryPath) {
  return `${entryCachePath(pkgReal, stat, entryPath)}.preview.png`;
}

function apiEtag() {
  return `W/"pv-${dataVersion}-${scanGeneration}-p${packageIndex.status().version}"`;
}

function proxyToBridge(req, res, url, identity, options = {}) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.origin;
  delete headers.referer;

  // Never trust identity headers from the client: they are set here.
  headers['x-pv-user'] = identity || '';
  headers['x-pv-artist'] = identity || '';

  const cacheable = Boolean(options.cacheable) && req.method === 'GET';
  const etag = cacheable ? (options.etag || apiEtag()) : null;

  const upstream = http.request({
    host: '127.0.0.1',
    port: BRIDGE_PORT,
    path: url.pathname + url.search,
    method: req.method,
    headers,
  }, (up) => {
    const out = { ...up.headers };
    delete out['access-control-allow-origin'];
    delete out['access-control-allow-methods'];
    delete out['access-control-allow-headers'];

    if (up.statusCode >= 400) {
      metrics.counter(`pv_api_errors_total{status="${up.statusCode}"}`);
    }

    if (cacheable) {
      out.etag = etag;
      // The bridge says "no-store"; the browser must keep the body around to
      // make If-None-Match useful, so downgrade to "store, always revalidate".
      out['cache-control'] = 'private, no-cache';
      out.vary = 'Accept-Encoding, Authorization, Cookie';
    }

    // gzip JSON only: previews and downloads are already-compressed binaries.
    const type = String(out['content-type'] || '');
    const acceptsGzip = String(req.headers['accept-encoding'] || '').includes('gzip');
    const alreadyEncoded = Boolean(out['content-encoding']);
    const bigEnough = Number(out['content-length'] || 0) > 1024;
    if (type.startsWith('application/json') && acceptsGzip && !alreadyEncoded && bigEnough && up.statusCode === 200) {
      metrics.counter('pv_api_gzip_total');
      delete out['content-length'];
      out['content-encoding'] = 'gzip';
      res.writeHead(up.statusCode, out);
      pipeline(up, zlib.createGzip({ level: 6 }), res, () => {});
      return;
    }

    res.writeHead(up.statusCode, out);
    pipeline(up, res, () => {});
  });
  upstream.on('error', (err) => {
    if (!res.headersSent) sendJson(res, 502, { ok: false, error: `bridge unavailable: ${err.message}` });
    else res.end();
  });
  req.pipe(upstream);
}

function readJsonBody(req, limitBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

// ---- simple per-identity token bucket for mutating requests --------------
const rateBuckets = new Map(); // identity -> { tokens, at }
function allowMutation(who) {
  if (!RATE_LIMIT_PER_MIN) return true;
  const now = Date.now();
  const bucket = rateBuckets.get(who) || { tokens: RATE_LIMIT_PER_MIN, at: now };
  const refill = ((now - bucket.at) / 60000) * RATE_LIMIT_PER_MIN;
  bucket.tokens = Math.min(RATE_LIMIT_PER_MIN, bucket.tokens + refill);
  bucket.at = now;
  if (bucket.tokens < 1) {
    rateBuckets.set(who, bucket);
    return false;
  }
  bucket.tokens -= 1;
  rateBuckets.set(who, bucket);
  if (rateBuckets.size > 5000) rateBuckets.clear(); // keep it bounded
  return true;
}

let activeZips = 0;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://internal');
  const route = url.pathname;
  const startedAt = process.hrtime.bigint();
  metrics.counter('pv_http_requests_total');
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    metrics.counter(`pv_http_responses_total{status="${res.statusCode}"}`);
    metrics.gauge('pv_last_request_ms', Math.round(ms));
  });

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  if (route === '/healthz') {
    // Public on purpose: this is the container healthcheck. Minimal, so an
    // unauthenticated probe learns nothing about the library contents.
    if (!identity(req)) {
      sendJson(res, 200, { ok: true, version: APP_VERSION, uptimeSeconds: Math.round(process.uptime()) });
      return;
    }
    // Authenticated callers fall through to the detailed block below.
  }

  if (!TRUST_PROXY_AUTH && (TOKEN || USERS.size) && route === '/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      const given = new URLSearchParams(body).get('token') || '';
      const known = Boolean(TOKEN) && timingSafeEqual(given, TOKEN);
      const asUser = [...USERS.values()].some((t) => timingSafeEqual(given, t));
      const asAdmin = Boolean(ADMIN_TOKEN) && timingSafeEqual(given, ADMIN_TOKEN);
      if (known || asUser || asAdmin) {
        audit('login_ok', { ip: req.socket.remoteAddress || '' });
        // Store the *presented* token, not the shared one: otherwise every
        // artist would be identified as "shared" and job targeting breaks.
        // Mark the session cookie Secure when we are served through a TLS
        // terminator, so it never travels over plain HTTP by accident.
        const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
          || Boolean(req.socket.encrypted);
        res.writeHead(302, {
          'Set-Cookie': `pv_session=${encodeURIComponent(given)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure ? '; Secure' : ''}`,
          Location: '/',
        });
        res.end();
      } else {
        metrics.counter('pv_login_failed_total');
        audit('login_failed', { ip: req.socket.remoteAddress || '' });
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid access token');
      }
    });
    return;
  }

  if (route === '/logout') {
    res.writeHead(302, { 'Set-Cookie': 'pv_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0', Location: '/login' });
    res.end();
    return;
  }

  const who = identity(req);
  if (!who) {
    // Machine endpoints answer JSON; only page navigations get the login form.
    if (route.startsWith('/api/') || route === '/metrics' || route.startsWith('/plugin/')) {
      sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    // Navigations get the sign-in page with 200 so browsers don't log an
    // error on every visit; API calls keep the 401 above.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(LOGIN_PAGE);
    return;
  }

  if (route === '/metrics') {
    // Prometheus scrape target. Same auth as everything else (bearer token).
    const extra = {
      pv_scan_total: scanStats.scans,
      pv_scan_cache_hits_total: scanStats.hits,
      pv_scan_last_ms: scanStats.lastMs,
      pv_watch_events_total: scanStats.watchEvents,
      pv_watch_errors_total: scanStats.watchErrors,
      pv_libs_cached: libCache.size,
      pv_data_version: dataVersion,
      pv_scan_generation: scanGeneration,
      pv_zips_active: activeZips,
      pv_thumbs_generated_total: thumbs.stats.generated,
      pv_thumbs_cache_hits_total: thumbs.stats.hits,
      pv_thumbs_failed_total: thumbs.stats.failed,
      pv_thumbs_bytes: thumbs.stats.bytes,
      pv_uptime_seconds: Math.round(process.uptime()),
      pv_enrichment_pending: enrichmentEnabled ? enrichment.status().pending : 0,
      pv_packages_indexed: packageIndex.status().indexed,
      pv_packages_queued: packageIndex.status().queued,
      pv_packages_failed: packageIndex.status().failed,
      pv_packages_bytes_read: packageIndex.status().bytesRead,
    };
    const body = metrics.render(extra);
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(body);
    return;
  }

  if (route === '/healthz') {
    const libs = getState().libraries;
    sendJson(res, 200, {
      ok: true,
      version: APP_VERSION,
      libraries: libs.map((l) => ({ name: l.name, missing: Boolean(l.missing), path: l.path })),
      scan: {
        ...scanStats,
        maxAgeMs: SCAN_MAX_AGE_MS,
        librariesCached: libCache.size,
        dirty: [...dirtyLibs],
        generation: scanGeneration,
        dataVersion,
      },
      plugin: plugin ? {
        version: plugin.version,
        tgzBytes: plugin.tgz ? plugin.tgz.size : 0,
        zipBytes: plugin.zip ? plugin.zip.size : 0,
      } : null,
      packages: packageIndex.status(),
      thumbs: {
        available: thumbs.isAvailable(),
        generated: thumbs.stats.generated,
        hits: thumbs.stats.hits,
        failed: thumbs.stats.failed,
      },
      enrichment: enrichmentEnabled ? enrichment.status() : { state: 'disabled' },
      uptimeSeconds: Math.round(process.uptime()),
    });
    return;
  }

  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  if (mutating && !checkOrigin(req)) {
    metrics.counter('pv_csrf_rejected_total');
    sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' });
    return;
  }
  if (mutating && !allowMutation(who)) {
    metrics.counter('pv_rate_limited_total');
    audit('rate_limited', { user: who, method: req.method, route });
    res.setHeader('Retry-After', '10');
    sendJson(res, 429, { ok: false, error: 'rate limit exceeded, retry shortly' });
    return;
  }

  // --- web-only session/state endpoints (replace Electron IPC) --------------
  if (route.startsWith('/api/web/') && !['/api/web/state', '/api/web/session', '/api/web/libraries'].includes(route)) {
    sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }
  if (route === '/api/web/state') {
    sendJson(res, 200, getState());
    return;
  }
  if (route === '/api/web/session') {
    // `PV_SHOW_TOKEN=0` hides the token from the settings panel (the UI then
    // tells people to ask an admin). Showing it is the default because a shared
    // team token has to reach each artist's Unity window somehow.
    const showToken = env.PV_SHOW_TOKEN !== '0';
    const presented = presentedToken(req);
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
      || (req.socket.encrypted ? 'https' : 'http');
    sendJson(res, 200, {
      origin: PUBLIC_ORIGIN || '',
      serverUrl: PUBLIC_ORIGIN || `${proto}://${req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1:8080'}`,
      user: who,
      admin: isAdmin(req),
      version: APP_VERSION,
      // The UI uses this to tell artists where "Import to Unity" will land.
      targeted: who !== 'shared' && who !== 'anonymous',
      token: showToken ? presented : '',
      tokenHidden: !showToken,
      webgl: {
        available: WEBGL_AVAILABLE,
        // The Settings panel toggle defaults to this and is remembered per browser.
        defaultEnabled: WEBGL_AVAILABLE && WEBGL_DEFAULT,
      },
      plugin: plugin
        ? {
          version: plugin.version,
          tgz: plugin.tgz ? { url: '/plugin/unity-package.tgz', name: plugin.tgz.name, bytes: plugin.tgz.size } : null,
          zip: plugin.zip ? { url: '/plugin/unity-package.zip', name: plugin.zip.name, bytes: plugin.zip.size } : null,
        }
        : null,
    });
    return;
  }
  if (route === '/api/web/libraries' && req.method === 'POST') {
    if (!isAdmin(req)) { sendJson(res, 403, { ok: false, error: 'admin token required' }); return; }
    let body;
    try { body = await readJsonBody(req); } catch (err) { sendJson(res, 400, { ok: false, error: err.message }); return; }
    const target = String(body && body.path || '').trim();
    if (!target) { sendJson(res, 400, { ok: false, error: 'missing path' }); return; }
    if (!withinRoots(target, LIBRARY_ROOTS)) {
      sendJson(res, 403, { ok: false, error: `path must live under ${LIBRARY_ROOTS.join(', ')}` });
      return;
    }
    const lib = registerLibrary(target);
    if (!lib) { sendJson(res, 404, { ok: false, error: 'path not found or not a directory' }); return; }
    bump();
    console.log(`[poly-vault] library added by ${who}: ${lib.path}`);
    audit('library_added', { user: who, path: lib.path });
    sendJson(res, 200, { ...getState(), added: lib });
    return;
  }
  if (route === '/api/web/libraries' && req.method === 'DELETE') {
    if (!isAdmin(req)) { sendJson(res, 403, { ok: false, error: 'admin token required' }); return; }
    let body;
    try { body = await readJsonBody(req); } catch (err) { sendJson(res, 400, { ok: false, error: err.message }); return; }
    const id = String(body && body.id || '');
    settings.set('libraries', (settings.get('libraries') || []).filter((l) => l.id !== id));
    bump();
    console.log(`[poly-vault] library removed by ${who}: ${id}`);
    audit('library_removed', { user: who, id });
    sendJson(res, 200, getState());
    return;
  }

  // --- preview image Unity embedded for one file inside a package -----------
  // Textures preview as themselves; models/audio have Unity's rendered thumbnail.
  if (route === '/api/package/preview') {
    const target = String(url.searchParams.get('path') || '').trim();
    const entryPath = String(url.searchParams.get('entry') || '').trim();
    if (!target || !entryPath) { sendJson(res, 400, { ok: false, error: 'missing path or entry' }); return; }

    let real;
    let stat;
    try {
      real = fs.realpathSync(target);
      stat = fs.statSync(real);
    } catch (_) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
    if (!stat.isFile()) { sendJson(res, 400, { ok: false, error: 'not a file' }); return; }

    const previewFile = entryPreviewPath(real, stat, entryPath);
    if (!fs.existsSync(previewFile)) {
      // Extraction produces the preview as a side effect; do it once.
      const result = await packageIndex.extractTo(real, entryPath, entryCachePath(real, stat, entryPath), undefined, previewFile);
      if (!result.ok || !result.previewPath) {
        sendJson(res, 404, { ok: false, error: 'no preview inside the package for this file' });
        return;
      }
    }
    metrics.counter('pv_entry_preview_total');
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, max-age=3600',
      ETag: `W/"ep-${path.basename(previewFile)}"`,
    });
    pipeline(fs.createReadStream(previewFile), res, () => {});
    return;
  }

  // --- contents tree of one package (lazy tree expansion in the UI) ---------
  if (route === '/api/package/tree') {
    const target = String(url.searchParams.get('path') || '').trim();
    if (!target) { sendJson(res, 400, { ok: false, error: 'missing path' }); return; }
    if (!PACKAGE_INDEX_ENABLED) { sendJson(res, 503, { ok: false, error: 'package index disabled' }); return; }

    let real;
    let stat;
    try {
      real = fs.realpathSync(target);
      stat = fs.statSync(real);
    } catch (_) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
    if (!stat.isFile()) { sendJson(res, 400, { ok: false, error: 'not a file' }); return; }

    const entry = packageIndex.get(real, stat.mtimeMs, stat.size);
    const current = packageIndex.contentsCap;
    if (!entry || (entry.contentsCap || 0) < current) {
      // Indexed before the full listing existed (or never): re-read this one
      // package on demand instead of re-reading the whole library.
      packageIndex.enqueue(real, stat.mtimeMs, stat.size, { force: true });
      metrics.counter('pv_package_tree_pending_total');
      sendJson(res, 202, { ok: false, indexing: true, cached: entry ? (entry.contents || []).length : 0 });
      return;
    }

    const MAX_NODES = 1200;
    const roots = [];
    const dirs = new Map();       // entry dir path -> node
    let leaves = 0;
    const sorted = (entry.contents || []).slice().sort((a, b) => b.size - a.size);

    function dirNode(dirPath) {
      if (!dirPath) return null;
      if (dirs.has(dirPath)) return dirs.get(dirPath);
      const parts = dirPath.split('/');
      const name = parts[parts.length - 1];
      const parentDir = parts.slice(0, -1).join('/');
      const node = { type: 'container', name, path: dirPath, children: [] };
      dirs.set(dirPath, node);
      const parent = dirNode(parentDir);
      if (parent) parent.children.push(node); else roots.push(node);
      return node;
    }

    for (const item of sorted) {
      if (leaves >= MAX_NODES) break;
      const parts = item.path.split('/');
      const name = parts.pop();
      if (!name) continue;
      const parent = dirNode(parts.join('/'));
      const leaf = {
        type: 'asset',
        name,
        path: item.path,
        size: item.size || 0,
        kind: kindForPath(item.path),
      };
      (parent ? parent.children : roots).push(leaf);
      leaves += 1;
    }

    const sortTree = (nodes) => {
      nodes.sort((a, b) => (a.type === b.type
        ? (a.type === 'container' ? a.name.localeCompare(b.name) : b.size - a.size)
        : (a.type === 'container' ? -1 : 1)));
      for (const n of nodes) if (n.children) sortTree(n.children);
    };
    sortTree(roots);

    metrics.counter('pv_package_tree_total');
    sendJson(res, 200, {
      ok: true,
      path: real,
      totalAssets: entry.totalAssets || 0,
      listed: (entry.contents || []).length,
      shown: leaves,
      partial: Boolean(entry.partial),
      truncated: leaves >= MAX_NODES,
      tree: roots,
    });
    return;
  }

  // --- Unity package download ----------------------------------------------
  if (route === '/plugin/unity-package.tgz' || route === '/plugin/unity-package.zip') {
    const artifact = route.endsWith('.zip') ? (plugin && plugin.zip) : (plugin && plugin.tgz);
    if (!artifact) { sendJson(res, 404, { ok: false, error: 'Unity package not bundled in this image' }); return; }
    metrics.counter('pv_plugin_downloads_total');
    audit('plugin_download', { user: who, version: plugin.version, name: artifact.name });
    res.writeHead(200, {
      'Content-Type': route.endsWith('.zip') ? 'application/zip' : 'application/gzip',
      'Content-Length': artifact.size,
      'Content-Disposition': `attachment; filename="${artifact.name}"`,
      'Cache-Control': 'private, max-age=300',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    pipeline(fs.createReadStream(artifact.file), res, () => {});
    return;
  }

  // --- package contents (on demand, for the detail panel) -------------------
  if (route === '/api/package') {
    const target = String(url.searchParams.get('path') || '').trim();
    if (!target) { sendJson(res, 400, { ok: false, error: 'missing path' }); return; }
    if (!PACKAGE_INDEX_ENABLED) { sendJson(res, 503, { ok: false, error: 'package index disabled' }); return; }

    let real;
    let stat;
    try {
      real = fs.realpathSync(target);
      stat = fs.statSync(real);
    } catch (_) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
    if (!stat.isFile()) { sendJson(res, 400, { ok: false, error: 'not a file' }); return; }

    const entry = packageIndex.get(real, stat.mtimeMs, stat.size);
    if (!entry) {
      // Not indexed yet: make sure it is queued, and tell the UI to retry later.
      packageIndex.enqueue(real, stat.mtimeMs, stat.size);
      metrics.counter('pv_package_contents_pending_total');
      sendJson(res, 202, { ok: false, error: 'indexing', retry: true });
      return;
    }
    metrics.counter('pv_package_contents_total');
    sendJson(res, 200, {
      ok: true,
      path: real,
      mode: entry.mode,
      counts: entry.counts || {},
      totalAssets: entry.totalAssets || 0,
      totalBytes: entry.totalBytes || 0,
      folders: entry.folders || 0,
      contents: entry.contents || [],
      partial: Boolean(entry.partial),
      truncated: entry.truncated || '',
    });
    return;
  }

  // --- thumbnails -----------------------------------------------------------
  // Cards ask for a small WebP instead of the artist's original preview, which
  // is cached on disk per (file, mtime, width) so the work happens once.
  const generatedImageRoot = packageIndex.cacheDir; // /data/packages (disposable)
  if (route === '/api/thumb') {
    const target = String(url.searchParams.get('path') || '').trim();
    if (!target) { sendJson(res, 400, { ok: false, error: 'missing path' }); return; }
    const width = clampWidth(url.searchParams.get('w'));

    const libs = getState().libraries;
    const insideLibrary = (p) => libs.some((lib) => {
      if (lib.missing) return false;
      const root = path.resolve(lib.path);
      return p === root || p.startsWith(root + path.sep);
    });

    let real;
    let stat;
    try {
      real = fs.realpathSync(target);
      const fromCache = real === generatedImageRoot || real.startsWith(generatedImageRoot + path.sep);
      if (!fromCache && !insideLibrary(real)) { sendJson(res, 403, { ok: false, error: 'path outside libraries' }); return; }
      stat = fs.statSync(real);
    } catch (_) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
    if (!stat.isFile()) { sendJson(res, 400, { ok: false, error: 'not a file' }); return; }
    const ext = path.extname(real).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
      sendJson(res, 403, { ok: false, error: 'not an image' });
      return;
    }

    const etag = `W/"t-${Math.trunc(stat.mtimeMs).toString(16)}-${width}"`;
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((t) => t.trim() === etag)) {
      metrics.counter('pv_thumb_304_total');
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, max-age=600' });
      res.end();
      return;
    }

    try {
      const { file, cacheHit } = await thumbs.get(real, stat.mtimeMs, width);
      if (cacheHit) metrics.counter('pv_thumb_cache_hit_total');
      const size = fs.statSync(file).size;
      res.writeHead(200, {
        'Content-Type': 'image/webp',
        'Content-Length': size,
        'Cache-Control': 'private, max-age=600, must-revalidate',
        ETag: etag,
        'X-PV-Thumb': cacheHit ? 'hit' : 'miss',
      });
      pipeline(fs.createReadStream(file), res, () => {});
    } catch (err) {
      // No resizer, or an image sharp cannot read: fall back to the original
      // preview so the grid still renders.
      metrics.counter('pv_thumb_fallback_total');
      res.writeHead(302, { Location: `/api/preview?path=${encodeURIComponent(target)}`, 'Cache-Control': 'no-store' });
      res.end();
    }
    return;
  }

  // --- asset downloads (browser + Unity plugin over HTTP) ------------------
  // `/api/file` streams one file; `/api/download` streams a zip of a folder so
  // "Open folder" becomes "Download" and the Unity add-on can fetch assets
  // without a shared filesystem.
  if (route === '/api/file' || route === '/api/download') {
    const rawTarget = String(url.searchParams.get('path') || '').trim();
    if (!rawTarget) { sendJson(res, 400, { ok: false, error: 'missing path' }); return; }
    // "<package>#<entry>" is how add-ons older than 0.6.0 address a file inside
    // a package (they have no `entry` field). 0.6.0+ sends `&entry=` instead.
    let target = rawTarget;
    let entryPath = String(url.searchParams.get('entry') || '').trim();
    const hashAt = rawTarget.indexOf('#');
    if (!entryPath && hashAt > 0) {
      target = rawTarget.slice(0, hashAt);
      entryPath = rawTarget.slice(hashAt + 1);
    }

    const libs = getState().libraries;
    const insideLibrary = (p) => libs.some((lib) => {
      if (lib.missing) return false;
      const root = path.resolve(lib.path);
      return p === root || p.startsWith(root + path.sep);
    });

    let real;
    let stat;
    try {
      real = fs.realpathSync(target);       // symlinks must not escape the library
      if (!insideLibrary(real)) { sendJson(res, 403, { ok: false, error: 'path outside libraries' }); return; }
      stat = fs.statSync(real);
    } catch (_) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }

    // One file *inside* a .unitypackage: extract it (cached) and stream it, so a
    // single texture/model/audio file can be imported without the whole package.
    if (stat.isFile() && entryPath) {
      if (!PACKAGE_INDEX_ENABLED) { sendJson(res, 503, { ok: false, error: 'package index disabled' }); return; }
      if (entryPath.includes('\u0000') || entryPath.split('/').some((seg) => seg === '..')) {
        sendJson(res, 400, { ok: false, error: 'invalid entry path' });
        return;
      }
      const base = path.basename(entryPath);
      const cached = entryCachePath(real, stat, entryPath);
      let extractedPath = cached;
      let size = 0;
      try {
        size = fs.statSync(cached).size;
        metrics.counter('pv_entry_cache_hit_total');
      } catch (_) {
        // Extract the file and, alongside it, Unity's own preview for that asset
        // (used as the card thumbnail and the model preview).
        const result = await packageIndex.extractTo(real, entryPath, cached, undefined, entryPreviewPath(real, stat, entryPath));
        if (!result.ok) {
          sendJson(res, 404, { ok: false, error: result.error || 'entry not found' });
          return;
        }
        size = result.size;
        metrics.counter('pv_entry_extract_total');
        audit('package_entry_download', { user: who, package: real, entry: entryPath, bytes: size });
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': size,
        'Content-Disposition': `attachment; filename="${base.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(base)}`,
        'Cache-Control': 'private, max-age=0, must-revalidate',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      pipeline(fs.createReadStream(extractedPath), res, () => {});
      return;
    }

    // A file-backed asset (one .unitypackage from Unity's Asset Store cache)
    // is downloaded as-is, from either endpoint.
    if (stat.isFile()) {
      const ext = path.extname(real).toLowerCase();
      if (!IMPORTABLE_EXTENSIONS.has(ext)) {
        sendJson(res, 403, { ok: false, error: 'not an importable asset file' });
        return;
      }
      const name = path.basename(real);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'private, max-age=0, must-revalidate',
        ETag: `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`,
        'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
      });
      if (req.method === 'HEAD') { res.end(); return; }
      metrics.counter('pv_file_downloads_total');
      metrics.counter('pv_file_bytes_total', stat.size);
      audit('asset_file_download', { user: who, path: real, bytes: stat.size });
      pipeline(fs.createReadStream(real), res, () => {});
      return;
    }

    if (route === '/api/file') { sendJson(res, 400, { ok: false, error: 'not a file' }); return; }

    // --- folder -> zip -----------------------------------------------------
    if (!stat.isDirectory()) { sendJson(res, 400, { ok: false, error: 'not a directory' }); return; }
    if (activeZips >= ZIP_CONCURRENCY) {
      sendJson(res, 429, { ok: false, error: 'too many concurrent downloads, retry shortly' });
      return;
    }

    const MAX_FILES = 4000;
    const files = [];
    let total = 0;
    const walk = (dir, relBase, depth) => {
      if (files.length >= MAX_FILES || depth > 12) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        if (files.length >= MAX_FILES) break;
        if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
        const abs = path.join(dir, entry.name);
        const rel = relBase ? path.join(relBase, entry.name) : entry.name;
        if (entry.isDirectory()) { walk(abs, rel, depth + 1); continue; }
        if (!entry.isFile()) continue;
        let fstat;
        try { fstat = fs.statSync(abs); } catch (_) { continue; }
        total += fstat.size;
        if (total > DOWNLOAD_MAX_BYTES) {
          const err = new Error(`folder is larger than the ${Math.round(DOWNLOAD_MAX_BYTES / 1024 / 1024)} MiB download limit`);
          err.code = 'ETOOLARGE';
          throw err;
        }
        files.push({ abs, rel, size: fstat.size, mtime: fstat.mtime });
      }
    };

    activeZips += 1;
    try {
      walk(real, '', 0);
      if (!files.length) { sendJson(res, 404, { ok: false, error: 'nothing to download' }); return; }
      const zipName = `${path.basename(real) || 'asset'}.zip`;
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
        'Cache-Control': 'private, max-age=0, must-revalidate',
        'X-PolyVault-Files': String(files.length),
      });
      const stats = await streamZip(res, files, { maxTotalBytes: DOWNLOAD_MAX_BYTES });
      console.log(`[poly-vault] zip ${zipName} for ${who}: ${stats.files} files, ${stats.compressedBytes} B`);
      metrics.counter('pv_zip_downloads_total');
      metrics.counter('pv_zip_bytes_total', stats.compressedBytes);
      audit('asset_download', { user: who, path: real, files: stats.files, bytes: stats.compressedBytes });
      res.end();
    } catch (err) {
      if (err.code === 'ETOOLARGE') {
        if (!res.headersSent) sendJson(res, 413, { ok: false, error: err.message });
        else res.destroy();
        return;
      }
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(err.message || err) });
      else res.destroy();
      return;
    } finally {
      activeZips -= 1;
    }
    return;
  }

  // --- everything else that looks like API goes to the loopback bridge ------
  if (route.startsWith('/api/')) {
    if (route === '/__diag' || route.startsWith('/__diag/')) { sendJson(res, 404, { ok: false, error: 'not found' }); return; }

    // Previews generated by the package index live outside the libraries, so
    // the bridge would refuse them. Serve those directly.
    if (route === '/api/preview') {
      const target = String(url.searchParams.get('path') || '').trim();
      let real = null;
      try { real = fs.realpathSync(target); } catch (_) { real = null; }
      if (real && (real === packageIndex.cacheDir || real.startsWith(packageIndex.cacheDir + path.sep))) {
        const ext = path.extname(real).toLowerCase();
        const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
        if (!types[ext]) { sendJson(res, 403, { ok: false, error: 'forbidden extension' }); return; }
        try {
          const st = fs.statSync(real);
          res.writeHead(200, {
            'Content-Type': types[ext],
            'Content-Length': st.size,
            'Cache-Control': 'private, max-age=600',
            ETag: `W/"c-${Math.trunc(st.mtimeMs).toString(16)}"`,
          });
          pipeline(fs.createReadStream(real), res, () => {});
        } catch (_) {
          sendJson(res, 404, { ok: false, error: 'not found' });
        }
        return;
      }
    }
    // 'shared'/'anonymous' mean "no per-person identity": jobs stay open to
    // every Unity editor, which is upstream's single-user behaviour.
    const pwUser = who === 'shared' || who === 'anonymous' ? '' : who;
    const cacheable = ['/api/library', '/api/tags', '/api/meta'].includes(route);
    let etag = null;
    if (cacheable && !mutating) {
      // Refresh the scan *before* computing the ETag, otherwise the header
      // would describe the previous generation while the body is new.
      await scanAll();
      etag = apiEtag();
      metrics.counter('pv_api_revalidations_total');
      const inm = req.headers['if-none-match'];
      if (inm && inm.split(',').some((t) => t.trim() === etag)) {
        metrics.counter('pv_api_304_total');
        res.writeHead(304, {
          ETag: etag,
          'Cache-Control': 'private, no-cache',
          Vary: 'Accept-Encoding, Authorization, Cookie',
        });
        res.end();
        return;
      }
    }
    if (mutating) {
      // Body-less audit for every mutation; the interesting ones are also
      // logged with detail by the handlers below.
      audit('api_mutation', {
        user: who,
        method: req.method,
        route,
        bytes: Number(req.headers['content-length'] || 0),
      });
    }
    proxyToBridge(req, res, url, pwUser, { cacheable, etag });
    return;
  }

  // --- static UI ------------------------------------------------------------
  let rel = route === '/' ? 'index.html' : route.slice(1);
  if (rel === 'web-shim.js') {
    const shim = fs.readFileSync(path.join(__dirname, 'web-shim.js'), 'utf8');
    res.writeHead(200, { 'Content-Type': STATIC_MIME['.js'], 'Cache-Control': 'no-cache' });
    res.end(shim);
    return;
  }
  const file = path.join(UI_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(UI_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': STATIC_MIME[ext] || 'application/octet-stream',
    'Cache-Control': rel === 'index.html' ? 'no-cache' : 'public, max-age=300',
  });
  fs.createReadStream(file).pipe(res);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[poly-vault] ${signal} received, shutting down`);
  try { server.close(); } catch (_) { /* ignore */ }
  try { bridge.server.close(); } catch (_) { /* ignore */ }
  try { packageIndex.close(); } catch (_) { /* ignore */ }
  for (const s of [settings, jobsStore, tagsStore, metaStore]) {
    try { s.save(); } catch (err) { console.error('[poly-vault] failed to persist store:', err.message); }
  }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (err) => console.error('[poly-vault] unhandled rejection:', err));
process.on('uncaughtException', (err) => { console.error('[poly-vault] uncaught exception:', err); shutdown('uncaughtException'); });

bridge.listen()
  .then(() => {
    server.listen(WEB_PORT, WEB_HOST, () => {
      console.log(`[poly-vault] v${APP_VERSION} listening on http://${WEB_HOST}:${WEB_PORT}`);
      console.log(`[poly-vault] data=${DATA_DIR} libraries=${LIBRARY_ROOTS.join(',')} auth=${TRUST_PROXY_AUTH ? 'proxy' : TOKEN ? 'token' : 'NONE (loopback only!)'}`);
      if (!TRUST_PROXY_AUTH && !TOKEN && WEB_HOST !== '127.0.0.1') {
        console.warn('[poly-vault] WARNING: listening on a non-loopback address with no auth configured.');
      }
    });
  })
  .catch((err) => {
    console.error('[poly-vault] failed to start bridge:', err);
    process.exit(1);
  });
