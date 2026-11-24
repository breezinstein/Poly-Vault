'use strict';
// HTTP-facing glue for "show this model the way Unity does":
//
//   GET /api/model/manifest?path=<package|model file>&entry=<path in package>
//   GET /api/model/texture?path=<package|asset folder>&key=<texKey>&w=<px>
//
// The manifest extracts the model and the textures it is likely to need in a
// single pass over the archive (a second pass only when the model itself names
// more textures), so opening a model costs at most two reads of a package.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { resolveModel, MODEL_EXT } = require('./modelResolver');
const { resolvePrefab } = require('./prefabResolver');
const tex = require('./textureConvert');

const sha1 = (v) => crypto.createHash('sha1').update(v).digest('hex');
const TEXTURE_SIZES = [256, 512, 1024, 2048, 4096];

// Unique temp name per write: concurrent requests for the same output never
// share one (the loser would otherwise fail the rename or interleave bytes).
function writeAtomic(out, data) {
  const tmp = `${out}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, out);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function createModelService({
  packageIndex, entryCachePath, dataDir, resolveInLibrary, libraryRootOf, log = console, maxTextureFiles = 20000,
  maxModelBytes = 256 * 1024 * 1024, maxConvertedFiles = 5000,
}) {
  const texDir = path.join(dataDir, 'packages', 'textures');
  fs.mkdirSync(texDir, { recursive: true });
  const inFlight = new Map();
  let writes = 0;
  const stats = { manifests: 0, passes: 0, textures: 0, textureHits: 0, textureErrors: 0 };

  // --- sources: a package (archive) or a loose Unity folder ---------------------

  async function openSource(target, entry) {
    const real = resolveInLibrary(target);
    if (!real) return { error: 404, message: 'not found in any library' };
    const stat = fs.statSync(real);
    if (stat.isFile() && real.toLowerCase().endsWith('.unitypackage')) {
      const graph = packageIndex.getGraph(real, stat.mtimeMs, stat.size);
      if (!graph) {
        packageIndex.enqueueGraph(real, stat.mtimeMs, stat.size, { priority: true });
        const st = packageIndex.graphState(real, stat.mtimeMs, stat.size);
        // States that waiting will not fix: answer now instead of "pending".
        if (st.state === 'disabled') return { error: 503, message: 'link maps are turned off on this server (PV_PACKAGE_GRAPH=0)' };
        if (st.state === 'failed') return { error: 409, message: `this package's link map could not be built${st.error ? `: ${st.error}` : ''}` };
        return { pending: true, real, ...st };
      }
      return { kind: 'package', real, stat, graph, entry: String(entry || '') };
    }
    // Loose file in a folder library: its asset folder is the graph root.
    const root = libraryRootOf(real);
    if (!root) return { error: 404, message: 'not in a library' };
    let file = stat.isFile() ? real : null;
    let fileStat = stat;
    if (!file && entry) {
      // Folder + entry (the browse view): the file inside that folder.
      const parts = String(entry).split('/');
      if (parts.some((seg) => seg === '..' || seg === '' || seg.includes('\u0000'))) return { error: 400, message: 'invalid entry path' };
      try {
        file = fs.realpathSync(path.join(real, ...parts));
        fileStat = fs.statSync(file);
      } catch (_) { return { error: 404, message: 'not found in this folder' }; }
      if (!file.startsWith(real + path.sep) || !fileStat.isFile()) return { error: 404, message: 'not found in this folder' };
    }
    // The graph root is the top folder under the library root, so references
    // between sibling folders (Meshes/ -> Materials/) resolve whichever folder
    // the request names.
    const rel = path.relative(root, file || real).split(path.sep).filter(Boolean);
    const assetDir = (file ? rel.length > 1 : rel.length > 0) ? path.join(root, rel[0]) : root;
    // A loose model directly in a library root: map only the root's own files,
    // never the whole library.
    const graph = await packageIndex.folderGraph(assetDir, { shallow: assetDir === root });
    if (!graph) return { error: 500, message: 'could not read the folder' };
    const relEntry = file ? path.relative(assetDir, file).split(path.sep).join('/') : String(entry || '');
    return { kind: 'folder', real: assetDir, file, stat: fileStat, graph, entry: relEntry };
  }

  const cachePathFor = (src, guid) => (src.kind === 'package'
    ? entryCachePath(src.real, src.stat, src.graph.paths[guid])
    : path.join(src.real, ...src.graph.paths[guid].split('/')));

  async function ensureExtracted(src, guids) {
    if (src.kind !== 'package') return {};
    const missing = [...new Set(guids)].filter((g) => src.graph.paths[g] && !fs.existsSync(cachePathFor(src, g)));
    if (!missing.length) return {};
    stats.passes += 1;
    const res = await packageIndex.extractMany(src.real, missing.map((g) => ({ guid: g, outPath: cachePathFor(src, g) })));
    if (!res.ok) throw new Error(res.error || 'extraction failed');
    return res.results || {};
  }

  // Path of an extracted (package) or loose (folder) file, checked to stay inside.
  function sourcePath(src, guid) {
    const p = cachePathFor(src, guid);
    if (src.kind === 'folder') {
      const real = fs.realpathSync(p);
      if (!real.startsWith(src.real + path.sep)) throw new Error('outside asset folder');
      return real;
    }
    return p;
  }
  const readSourceFile = (src, guid) => fs.readFileSync(sourcePath(src, guid));

  // --- model worker (read, inspect, convert: never on the HTTP thread) ------------

  let worker = null;
  let seq = 0;
  const waiting = new Map();
  function failAll(error) {
    for (const done of waiting.values()) done({ ok: false, error });
    waiting.clear();
    worker = null;
  }
  function callWorker(msg) {
    if (!worker) {
      // A crafted file must not take the server down: the worker has its own,
      // smaller heap and is restarted on the next request if it dies.
      worker = new Worker(path.join(__dirname, 'modelWorker.js'), { resourceLimits: { maxOldGenerationSizeMb: 768 } });
      worker.unref();
      worker.on('message', (m) => {
        const done = waiting.get(m.id);
        if (done) { waiting.delete(m.id); done(m); }
      });
      worker.on('error', (err) => failAll(`model worker: ${err.message}`));
      worker.on('exit', () => failAll('model worker stopped'));
    }
    const id = ++seq;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      worker.postMessage({ ...msg, id, maxBytes: maxModelBytes });
    });
  }
  const formatOf = (entry) => path.extname(entry).slice(1).toLowerCase();

  // --- conversion to GLB (FBX 6, Unity mesh assets) -------------------------------

  const convDir = path.join(dataDir, 'packages', 'converted');
  fs.mkdirSync(convDir, { recursive: true });
  // Bump CONVERTER_VERSION when converter output changes: files from older
  // versions are no longer used (they stay until packages/converted is cleared).
  const CONVERTER_VERSION = 2;
  const PREFAB_MODEL_CAP = 256;
  const convPath = (src, entry) => path.join(convDir, `${sha1(`${src.real}\u0000${Math.trunc(src.stat.mtimeMs)}\u0000${entry}\u0000v${CONVERTER_VERSION}`)}.glb`);
  let convWrites = 0;
  // Converted GLBs are a disposable cache: keep the newest maxConvertedFiles.
  function noteConverted(conv) {
    if (!conv || !conv.ok) return;
    stats.converted = (stats.converted || 0) + 1;
    convWrites += 1;
    if (convWrites % 100 === 0) pruneDir(convDir, maxConvertedFiles);
  }

  /** The converted GLB of an FBX 6 model or a Unity mesh asset (built by the manifest). */
  async function converted(target, entry) {
    const src = await openSource(target, entry);
    if (src.error) return src;
    if (src.pending) return { error: 409, message: 'package link map not ready' };
    const out = convPath(src, src.entry);
    if (fs.existsSync(out)) return { file: out };
    const guid = Object.entries(src.graph.paths).find(([, p]) => p === src.entry);
    if (!guid) return { error: 404, message: 'entry not found' };
    await ensureExtracted(src, [guid[0]]);
    const res = await callWorker({ action: 'convert', file: sourcePath(src, guid[0]), format: formatOf(src.entry), out });
    if (!res.ok) return { error: 415, message: res.error };
    noteConverted(res.converted);
    return res.converted.ok ? { file: res.converted.file } : { error: 415, message: res.converted.error };
  }

  // --- manifest ----------------------------------------------------------------

  function modelUrl(src, entry) {
    if (src.kind === 'package') return `/api/file?path=${encodeURIComponent(src.real)}&entry=${encodeURIComponent(entry)}`;
    return `/api/file?path=${encodeURIComponent(path.join(src.real, ...entry.split('/')))}`;
  }
  function textureUrl(src, key) {
    return `/api/model/texture?path=${encodeURIComponent(src.real)}&key=${encodeURIComponent(key)}`;
  }

  // URL the viewer loads for a model file; FBX 6 and Unity mesh assets are
  // served converted to GLB (`info` is the worker's inspect reply).
  function modelFileUrl(src, entry, info) {
    const format = formatOf(entry);
    const convertedUrl = `/api/model/converted?path=${encodeURIComponent(src.real)}&entry=${encodeURIComponent(entry)}`;
    const conv = info.converted;
    if (format === 'asset') {
      return conv && conv.ok ? { url: convertedUrl, format: 'glb', meshAsset: true } : { missing: true, error: (conv && conv.error) || 'not converted' };
    }
    if (format === 'fbx' && conv && conv.ok) {
      return { url: convertedUrl, format: 'glb', converted: `FBX ${(info.fbxVersion / 1000).toFixed(1)}` };
    }
    return { url: modelUrl(src, entry), format };
  }

  // Read + inspect (+ convert when needed) one model in the worker.
  async function inspect(src, guid, entry, file) {
    const res = await callWorker({ action: 'inspect', file, format: formatOf(entry), convertTo: convPath(src, entry) });
    if (res.ok) noteConverted(res.converted);
    return res;
  }

  // Models a prefab (and its nested prefabs, to depth 4) uses.
  function prefabModels(graph, guid, depth = 0, out = new Set()) {
    const pf = graph.prefabs[guid];
    if (!pf || depth > 4) return out;
    for (const o of Object.values(pf.o || {})) {
      const ref = o.c === 33 || o.c === 137 ? o.mesh : o.c === 1001 ? o.src : null;
      if (!ref || !ref.g || !graph.paths[ref.g]) continue;
      if (MODEL_EXT.test(graph.paths[ref.g]) || (o.c !== 1001 && /\.asset$/i.test(graph.paths[ref.g]))) out.add(ref.g);
      else if (/\.prefab$/i.test(graph.paths[ref.g])) prefabModels(graph, ref.g, depth + 1, out);
    }
    return out;
  }

  async function buildPrefabManifest(src) {
    const g = src.graph;
    const guid = Object.entries(g.paths).find(([, p]) => p === src.entry);
    if (!guid) return { error: 404, message: 'prefab not in this package' };
    // Vehicle/character prefabs built from mesh assets use one file per part
    // (98 for one vehicle seen in practice), so the cap is generous; past it, say so.
    const allModels = [...prefabModels(g, guid[0])];
    const models = allModels.slice(0, PREFAB_MODEL_CAP);
    // Pass 1: every model the prefab tree uses.
    await ensureExtracted(src, models);
    const structures = new Map();
    const infoOf = new Map();
    for (const m of models) {
      let file;
      try { file = sourcePath(src, m); } catch (_) { continue; }   // not extracted: shown as missing
      if (!fs.existsSync(file)) continue;
      const info = await inspect(src, m, g.paths[m], file);
      if (!info.ok) { infoOf.set(m, info); continue; }
      infoOf.set(m, info);
      structures.set(m, info.structure);
    }
    const manifest = resolvePrefab(g, src.entry, (m) => structures.get(m) || null);
    // Pass 2: textures.
    await ensureExtracted(src, Object.values(manifest.textures).map((t) => t.guid));
    for (const [key, t] of Object.entries(manifest.textures)) {
      t.url = textureUrl(src, key);
      delete t.guid;
      if (t.role === 'orm') delete t.recipe;
    }
    for (const [m, info] of Object.entries(manifest.models)) {
      const got = infoOf.get(m);
      if (!got) { info.missing = true; continue; }
      if (!got.ok) {
        info.missing = true;
        manifest.notes.push(`${path.basename(g.paths[m])}: could not be read (${got.error})`);
        continue;
      }
      Object.assign(info, modelFileUrl(src, g.paths[m], got));
      if (info.error) manifest.notes.push(`${path.basename(g.paths[m])}: could not be converted (${info.error})`);
      if (info.converted) manifest.notes.push(`${path.basename(g.paths[m])}: ${info.converted} converted for the browser (no skinning or animation)`);
    }
    if (allModels.length > models.length) {
      manifest.notes.push(`this prefab uses ${allModels.length} model files; only the first ${models.length} are loaded`);
    }
    manifest.model = { guid: guid[0], path: src.entry, format: 'prefab' };
    manifest.source = { kind: src.kind, path: src.real, entry: src.entry };
    manifest.notes = [...new Set(manifest.notes)];
    stats.manifests += 1;
    return { ok: true, manifest };
  }

  async function buildManifest(src) {
    const entry = src.entry;
    if (/\.prefab$/i.test(entry)) return buildPrefabManifest(src);
    const meshAsset = /\.asset$/i.test(entry);
    if (!MODEL_EXT.test(entry) && !meshAsset) return { error: 400, message: 'not a model or prefab file' };
    const byPath = new Map(Object.entries(src.graph.paths).map(([g, p]) => [p, g]));
    const guid = byPath.get(entry);
    if (!guid && src.kind === 'package') return { error: 404, message: 'entry not in package' };

    // Pass 1: the model plus every texture that remaps/prefabs already point at.
    const guess = resolveModel(src.graph, entry, { meshes: [], materials: [], textures: [], models: [], hasGeometry: true });
    const firstWave = [guid, ...Object.values(guess.textures).map((t) => t.guid)].filter(Boolean);
    const p1 = await ensureExtracted(src, firstWave);
    if (guid && p1[guid] && !p1[guid].ok) return { error: 502, message: `model: ${p1[guid].error}` };

    const format = formatOf(entry);
    const info = await inspect(src, guid, entry, guid ? sourcePath(src, guid) : src.file);
    if (!info.ok) return { error: 422, message: info.error };
    const { structure } = info;
    // A .asset that is not a mesh (ScriptableObject, terrain data, ...).
    if (meshAsset && !structure.ok) return { error: 415, message: structure.error || 'not a mesh asset' };
    const manifest = resolveModel(src.graph, entry, structure);

    // Pass 2 (only if needed): textures the model file itself references.
    await ensureExtracted(src, Object.values(manifest.textures).map((t) => t.guid));

    for (const [key, t] of Object.entries(manifest.textures)) {
      t.url = textureUrl(src, key);
      delete t.guid;
      if (t.role === 'orm') delete t.recipe;
    }
    manifest.model.url = modelUrl(src, entry);
    manifest.model.bytes = info.size;
    // FBX 6 (pre-2011): the browser loader cannot read it; serve a converted
    // static GLB instead (meshes, material groups, hierarchy).
    if (format === 'fbx') {
      const v = info.fbxVersion;
      if (v > 0 && v < 7000) {
        const conv = info.converted || { ok: false, error: 'not converted' };
        if (conv.ok) {
          manifest.model.url = `/api/model/converted?path=${encodeURIComponent(src.real)}&entry=${encodeURIComponent(entry)}`;
          manifest.model.format = 'glb';
          manifest.model.converted = `FBX ${(v / 1000).toFixed(1)}`;
          manifest.notes.push(`FBX ${(v / 1000).toFixed(1)} file converted for the browser (shown without skinning or animation)`);
        } else {
          manifest.notes.push(`FBX ${(v / 1000).toFixed(1)} file could not be converted: ${conv.error}`);
        }
      }
    }
    // Unity mesh asset: always served as a converted GLB.
    if (meshAsset) {
      const conv = info.converted || { ok: false, error: 'not converted' };
      if (!conv.ok) return { error: 415, message: `mesh asset could not be converted: ${conv.error}` };
      manifest.model.url = `/api/model/converted?path=${encodeURIComponent(src.real)}&entry=${encodeURIComponent(entry)}`;
      manifest.model.format = 'glb';
      manifest.model.converted = 'Unity mesh';
      manifest.model.meshAsset = true;
    }
    manifest.info = { meshes: structure.meshes.length, materials: structure.materials.length, textures: structure.textures.length };
    manifest.source = { kind: src.kind, path: src.real, entry };
    stats.manifests += 1;
    return { ok: true, manifest };
  }

  async function manifest(target, entry) {
    const src = await openSource(target, entry);
    if (src.error) return src;
    if (src.pending) return { pending: true, state: src.state, position: src.position, error: src.error };
    const key = `${src.real}\u0000${src.entry}\u0000${src.graph.builtAt || ''}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const job = buildManifest(src).then((res) => {
      // A partial folder link map (file or time limit) can miss materials.
      if (res && res.ok && src.kind === 'folder' && src.graph.truncated) {
        res.manifest.notes.push(`this folder's link map is partial (${src.graph.truncated}): some materials or textures may not be found`);
      }
      return res;
    }).catch((err) => ({ error: 500, message: err.message }));
    inFlight.set(key, job);
    job.finally(() => inFlight.delete(key));
    return job;
  }

  // --- textures ------------------------------------------------------------------

  function parseKey(key) {
    const m = /^(albedo|normal|emission|orm):([0-9a-f]{32})(?::(.*))?$/.exec(String(key || ''));
    if (!m) return null;
    const out = { role: m[1], guid: m[2], recipe: {} };
    if (m[1] === 'orm') {
      for (const part of String(m[3] || '').split('&')) {
        const [k, v] = part.split('=');
        if (k) out.recipe[k] = v;
      }
    }
    return out;
  }

  // Drop the least recently used 10% of a cache folder once it holds more
  // than `max` files (also clears temp files left by a crash).
  function pruneDir(dir, max) {
    try {
      const files = fs.readdirSync(dir).map((f) => {
        const p = path.join(dir, f);
        try { return { p, t: fs.statSync(p).atimeMs, tmp: f.endsWith('.tmp') }; } catch (_) { return null; }
      }).filter(Boolean);
      const now = Date.now();
      for (const f of files) if (f.tmp && now - f.t > 3600e3) fs.rmSync(f.p, { force: true });
      if (files.length <= max) return;
      files.sort((a, b) => a.t - b.t);
      for (const f of files.slice(0, Math.ceil(files.length * 0.1))) fs.rmSync(f.p, { force: true });
    } catch (_) { /* best effort */ }
  }
  function prune() {
    writes += 1;
    if (writes % 200 === 0) pruneDir(texDir, maxTextureFiles);
  }

  async function texture(target, key, width) {
    const parsed = parseKey(key);
    if (!parsed) return { error: 400, message: 'bad texture key' };
    const size = TEXTURE_SIZES.includes(Number(width)) ? Number(width) : 2048;
    const src = await openSource(target, '');
    if (src.error) return src;
    if (src.pending) return { error: 409, message: 'package link map not ready' };
    const g = src.graph;
    // Only files that really are textures in this package/folder can be read.
    const isTexture = (guid) => Boolean(g.paths[guid]) && /\.(png|jpe?g|tga|psd|tiff?|bmp|gif|webp)$/i.test(g.paths[guid]);
    const guids = [parsed.guid, parsed.recipe.mg, parsed.recipe.ao, parsed.recipe.sa].filter(Boolean);
    for (const guid of guids) {
      if (!/^[0-9a-f]{32}$/.test(guid) || !isTexture(guid)) return { error: 404, message: 'texture not in this package' };
    }
    const out = path.join(texDir, `${sha1(`${src.real}\u0000${Math.trunc(src.stat.mtimeMs)}\u0000${key}\u0000${size}`)}.webp`);
    if (fs.existsSync(out)) {
      stats.textureHits += 1;
      return { file: out };
    }
    await ensureExtracted(src, guids);
    try {
      let buffer;
      if (parsed.role === 'orm') {
        const r = parsed.recipe;
        buffer = await tex.buildOrm({
          kind: r.k || 'none',
          mg: r.mg ? readSourceFile(src, r.mg) : null,
          mgName: r.mg ? g.paths[r.mg] : '',
          ao: r.ao ? readSourceFile(src, r.ao) : null,
          aoName: r.ao ? g.paths[r.ao] : '',
          albedo: r.sa ? readSourceFile(src, r.sa) : null,
          albedoName: r.sa ? g.paths[r.sa] : '',
          aoStrength: Math.max(0, Math.min(1, Number(r.ao_s ?? 1))),
          smoothScale: Math.max(0, Math.min(1, Number(r.ss ?? 1))),
          metallic: Math.max(0, Math.min(1, Number(r.m ?? 0))),
        }, size);
      } else {
        buffer = await tex.convertTexture(readSourceFile(src, parsed.guid), g.paths[parsed.guid], parsed.role, size);
      }
      writeAtomic(out, buffer);
      stats.textures += 1;
      prune();
      return { file: out };
    } catch (err) {
      stats.textureErrors += 1;
      if (!(err instanceof tex.TextureError)) log.warn(`[poly-vault] texture ${g.paths[parsed.guid]}: ${err.message}`);
      return { error: 415, message: err.message };
    }
  }

  return { manifest, texture, converted, stats: () => ({ ...stats, sharp: tex.available(), psd: tex.psdAvailable() }) };
}

module.exports = { createModelService };
