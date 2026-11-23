'use strict';
// The "link map" of a Unity package or folder: which file is which GUID, and
// the parsed text assets that link models to materials and textures.
//
//   {
//     schema, kind: 'package'|'folder', path, mtimeMs, size,
//     complete, truncated, scannedBytes, ms, builtAt,
//     paths:   { guid: "Assets/…/file.ext" }          every asset
//     metas:   { guid: compactMeta }                   model + texture importers,
//                                                      and anything with remaps
//     mats:    { guid: compactMaterial }
//     prefabs: { guid: compactPrefab }
//     errors:  { guid: "reason" }                       bounded
//   }
//
// Built by streaming the archive once and keeping only small text entries,
// so the whole 109 GB library can be mapped without holding anything large.

const fs = require('fs');
const path = require('path');
const { walkUnityPackage } = require('./tarWalk');
const { compactMeta, compactMaterial, compactPrefab } = require('./unityYaml');

const GRAPH_SCHEMA = 1;
const YAML_MAGIC = Buffer.from('%YAML');
const LIMITS = {
  pathname: 8 * 1024,
  meta: 64 * 1024,
  mat: 256 * 1024,
  prefab: 4 * 1024 * 1024,
  errors: 200,
};

const extOf = (p) => path.extname(p || '').toLowerCase();

function keepMeta(meta) {
  return meta.imp === 'ModelImporter' || meta.imp === 'TextureImporter' || Boolean(meta.ext) || Boolean(meta.ids);
}

function emptyGraph(kind, file, stat) {
  return {
    schema: GRAPH_SCHEMA,
    kind,
    path: file,
    mtimeMs: stat ? Math.trunc(stat.mtimeMs) : 0,
    size: stat ? stat.size : 0,
    complete: false,
    truncated: '',
    scannedBytes: 0,
    ms: 0,
    builtAt: '',
    paths: {},
    metas: {},
    mats: {},
    prefabs: {},
    errors: {},
  };
}

function addError(graph, guid, message) {
  if (Object.keys(graph.errors).length >= LIMITS.errors) return;
  graph.errors[guid] = String(message).slice(0, 200);
}

/** Interpret one GUID's captured entries once its pathname is known. */
function finishGuid(graph, guid, group) {
  const p = group.pathname || '';
  if (!p || p.endsWith('/')) return;
  // Package folder records carry a pathname but no asset body.
  if (graph.kind === 'package' && !group.hasAsset) return;
  graph.paths[guid] = p;
  const ext = extOf(p);
  if (group.meta) {
    try {
      const meta = compactMeta(group.meta);
      if (keepMeta(meta)) graph.metas[guid] = meta;
    } catch (err) { addError(graph, guid, `meta: ${err.message}`); }
  }
  if (!group.yaml && group.hasAsset && (ext === '.mat' || ext === '.prefab')) {
    // Unity 4 "force binary" serialisation: the asset exists but is not text.
    // Recorded so the resolver can fall back to name matching and say why.
    if (ext === '.mat') graph.mats[guid] = { n: path.basename(p, ext), bin: 1 };
    else graph.prefabs[guid] = { o: {}, bin: 1 };
    return;
  }
  if (group.yaml && (ext === '.mat' || ext === '.prefab')) {
    if (group.yamlTruncated) { addError(graph, guid, `${ext} larger than ${ext === '.mat' ? LIMITS.mat : LIMITS.prefab} bytes`); return; }
    try {
      if (ext === '.mat') {
        const mat = compactMaterial(group.yaml);
        if (mat) graph.mats[guid] = mat;
      } else {
        graph.prefabs[guid] = compactPrefab(group.yaml);
      }
    } catch (err) { addError(graph, guid, `${ext}: ${err.message}`); }
  }
}

/**
 * Build the link map of a .unitypackage in one streaming pass.
 * @param {string} file
 * @param {{timeoutMs?:number}} [opts]
 */
async function buildPackageGraph(file, opts = {}) {
  const started = Date.now();
  const stat = fs.statSync(file);
  const graph = emptyGraph('package', file, stat);
  const groups = new Map();   // guid -> { pathname, meta, yaml, yamlTruncated }
  let current = '';

  const flush = (guid) => {
    const group = groups.get(guid);
    if (!group) return;
    groups.delete(guid);
    finishGuid(graph, guid, group);
  };

  const result = await walkUnityPackage(file, {
    timeoutMs: opts.timeoutMs || 0,
    onHeader(guid, leaf, size) {
      if (guid !== current) {
        // Entries are grouped per GUID: the previous one is complete. Keep a
        // couple around in case a package interleaves (cheap: text only).
        if (current && groups.has(current) && groups.get(current).pathname) flush(current);
        current = guid;
      }
      if (!groups.has(guid)) groups.set(guid, {});
      if (leaf === 'asset') groups.get(guid).hasAsset = true;
      if (size === 0) return null;
      if (leaf === 'pathname') return { capture: LIMITS.pathname };
      if (leaf === 'asset.meta' || leaf === 'metaData') return { capture: LIMITS.meta };
      if (leaf === 'asset') return { capture: LIMITS.prefab, sniff: YAML_MAGIC };
      return null;
    },
    onEntry(guid, leaf, buffer, info) {
      const group = groups.get(guid) || {};
      groups.set(guid, group);
      if (leaf === 'pathname') group.pathname = buffer.toString('utf8').split('\n')[0].trim();
      else if (leaf === 'asset.meta' || leaf === 'metaData') group.meta = buffer.toString('utf8');
      else if (leaf === 'asset') {
        group.yaml = buffer.toString('utf8');
        group.yamlTruncated = info.truncated;
        // Materials have a lower cap than prefabs; enforced once the path is known.
        if (!info.truncated && buffer.length > LIMITS.mat) group.bigYaml = true;
      }
      if (leaf === 'pathname' && group.bigYaml && extOf(group.pathname) === '.mat') group.yamlTruncated = true;
    },
  });
  for (const guid of [...groups.keys()]) flush(guid);

  graph.complete = result.complete;
  graph.truncated = result.truncated;
  graph.scannedBytes = result.scannedBytes;
  graph.ms = Date.now() - started;
  graph.builtAt = new Date().toISOString();
  return graph;
}

/**
 * Build the link map of a loose Unity folder (assets with .meta siblings).
 * Paths are relative to `dir`, mirroring a package's "Assets/…" paths.
 */
function buildFolderGraph(dir, opts = {}) {
  const started = Date.now();
  const maxFiles = opts.maxFiles || 50000;
  const graph = emptyGraph('folder', dir, null);
  let seen = 0;
  let newest = 0;
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (seen >= maxFiles) { graph.truncated = 'file-limit'; return; }
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(childAbs, childRel); continue; }
      if (!e.name.endsWith('.meta')) continue;
      seen += 1;
      const target = childAbs.slice(0, -'.meta'.length);
      const targetRel = childRel.slice(0, -'.meta'.length);
      let metaText;
      let st;
      try {
        st = fs.statSync(childAbs);
        if (st.size > LIMITS.meta) continue;
        metaText = fs.readFileSync(childAbs, 'utf8');
      } catch (_) { continue; }
      newest = Math.max(newest, st.mtimeMs);
      const guid = (/^guid:\s*([0-9a-f]{32})/m.exec(metaText) || [])[1];
      if (!guid) continue;
      let isDir = false;
      try { isDir = fs.statSync(target).isDirectory(); } catch (_) { continue; }
      if (isDir) continue;
      const group = { pathname: targetRel, meta: metaText };
      const ext = extOf(targetRel);
      if (ext === '.mat' || ext === '.prefab') {
        try {
          const tst = fs.statSync(target);
          newest = Math.max(newest, tst.mtimeMs);
          if (tst.size <= (ext === '.mat' ? LIMITS.mat : LIMITS.prefab)) {
            const text = fs.readFileSync(target, 'utf8');
            if (text.startsWith('%YAML')) group.yaml = text;
          } else group.yamlTruncated = true;
          if (!group.yaml && !group.yamlTruncated) group.yaml = '';
        } catch (_) { /* unreadable: skip body */ }
      }
      finishGuid(graph, guid, group);
    }
  };
  walk(dir, '');
  graph.complete = !graph.truncated;
  graph.mtimeMs = Math.trunc(newest);
  graph.ms = Date.now() - started;
  graph.builtAt = new Date().toISOString();
  return graph;
}

/**
 * Extract several assets from a package in one pass, by GUID.
 * @param {string} file
 * @param {{guid:string, outPath:string, maxBytes?:number}[]} targets
 * @returns {Promise<{results:Object<string,{ok:boolean,size?:number,error?:string}>, scannedBytes:number}>}
 */
async function extractMany(file, targets, opts = {}) {
  const byGuid = new Map(targets.map((t) => [t.guid, t]));
  const results = {};
  const open = new Map();   // guid -> { fd, tmp }
  let remaining = byGuid.size;
  const walk = await walkUnityPackage(file, {
    timeoutMs: opts.timeoutMs || 0,
    shouldStop: () => remaining === 0,
    onHeader(guid, leaf) {
      if (leaf !== 'asset') return null;
      const t = byGuid.get(guid);
      if (!t || results[guid]) return null;
      fs.mkdirSync(path.dirname(t.outPath), { recursive: true });
      const tmp = `${t.outPath}.${process.pid}.tmp`;
      const fd = fs.openSync(tmp, 'w');
      open.set(guid, { fd, tmp });
      return { write: fd, maxBytes: t.maxBytes || 512 * 1024 * 1024 };
    },
    onEntry(guid, leaf, _buffer, info) {
      const handle = open.get(guid);
      if (!handle) return;
      open.delete(guid);
      fs.closeSync(handle.fd);
      const t = byGuid.get(guid);
      if (info.truncated) {
        fs.rmSync(handle.tmp, { force: true });
        results[guid] = { ok: false, error: 'larger than the extraction limit' };
      } else {
        fs.renameSync(handle.tmp, t.outPath);
        results[guid] = { ok: true, size: info.written };
      }
      remaining -= 1;
    },
  });
  for (const [guid, handle] of open) {
    try { fs.closeSync(handle.fd); } catch (_) { /* ignore */ }
    fs.rmSync(handle.tmp, { force: true });
    results[guid] = { ok: false, error: 'archive ended mid-entry' };
  }
  for (const guid of byGuid.keys()) if (!results[guid]) results[guid] = { ok: false, error: 'not in package' };
  return { results, scannedBytes: walk.scannedBytes };
}

/**
 * Node names inside an FBX (binary or ASCII) — what Unity names the meshes it
 * imports. Used to turn hashed mesh fileIDs back into names.
 */
function fbxNodeNames(buffer) {
  const names = { model: new Set(), geometry: new Set() };
  const s = buffer.toString('latin1');
  // Binary FBX 7.x: "<name>\x00\x01<Class>"
  for (const m of s.matchAll(/([\x20-\x7e]{1,200})\x00\x01(Model|Geometry)/g)) {
    (m[2] === 'Model' ? names.model : names.geometry).add(m[1]);
  }
  // ASCII FBX: Model: 123, "Model::Name", "Mesh"
  for (const m of s.matchAll(/"(Model|Geometry)::([^"]{1,200})"/g)) {
    (m[1] === 'Model' ? names.model : names.geometry).add(m[2]);
  }
  return { model: [...names.model], geometry: [...names.geometry] };
}

/** Summary counts for status endpoints. */
function graphSummary(graph) {
  if (!graph) return null;
  const counts = { assets: 0, models: 0, textures: 0, materials: 0, prefabs: 0, remaps: 0 };
  counts.assets = Object.keys(graph.paths).length;
  for (const meta of Object.values(graph.metas)) {
    if (meta.imp === 'ModelImporter') counts.models += 1;
    if (meta.imp === 'TextureImporter') counts.textures += 1;
    if (meta.ext) counts.remaps += meta.ext.length;
  }
  counts.materials = Object.keys(graph.mats).length;
  counts.prefabs = Object.keys(graph.prefabs).length;
  return {
    schema: graph.schema,
    kind: graph.kind,
    complete: graph.complete,
    truncated: graph.truncated,
    scannedBytes: graph.scannedBytes,
    ms: graph.ms,
    builtAt: graph.builtAt,
    counts,
    errors: Object.keys(graph.errors).length,
  };
}

module.exports = {
  GRAPH_SCHEMA, buildPackageGraph, buildFolderGraph, extractMany, fbxNodeNames, graphSummary, LIMITS,
};
