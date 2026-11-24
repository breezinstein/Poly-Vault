'use strict';
// A .prefab, assembled the way Unity shows it.
//
// Output (merged into the same manifest shape the viewer already applies):
//   kind: 'prefab'
//   nodes: [{ id, name, parent, t:[x,y,z], r:[x,y,z,w], s:[x,y,z], active,
//             mesh?:     { model, name, materials:[matKey|null], skinned }
//             instance?: { model, byName, bindings, overrides:{node: [matKey]} } }]
//   models: { modelGuid: { path, format, fileScale } }   files the viewer loads
//
// Transforms stay in Unity's (left-handed) space; the viewer converts them.
//
// What is exact:   GameObject hierarchy, transforms, MeshFilter/MeshRenderer
//                  meshes (Unity's hashed mesh fileIDs) and their materials,
//                  nested prefabs (to depth 4) placed by their root override.
// What is not:     overrides inside nested prefabs other than the root's
//                  transform; material overrides on model instances whose
//                  renderer cannot be identified (modern hashed component IDs)
//                  — those fall back to the model's own materials (noted).

const path = require('path');
const { resolveModel, translateMaterial, meshNameFor, sanitize } = require('./modelResolver');
const { unityFileId } = require('./xxhash64');

const MAX_DEPTH = 4;
// Unity's built-in meshes (Library/unity default resources).
const BUILTIN_MESH_GUID = '0000000000000000e000000000000000';
const BUILTIN_MESHES = { 10202: 'cube', 10206: 'cylinder', 10207: 'sphere', 10208: 'capsule', 10209: 'plane', 10210: 'quad' };
const MODEL_EXT = /\.(fbx|obj|dae|3ds|blend|glb|gltf)$/i;
// Meshes a MeshFilter can point at: model files, and Unity mesh assets.
const MESH_SOURCE = /\.(fbx|obj|dae|3ds|blend|glb|gltf|asset)$/i;

// Unity writes the instance root's full transform for every PrefabInstance.
function rootTransformMods(mods) {
  const byTarget = new Map();
  for (const m of mods) {
    if (!m.t || !/^m_Local(Position|Rotation|Scale)\./.test(m.p)) continue;
    const k = m.t.f;
    if (!byTarget.has(k)) byTarget.set(k, []);
    byTarget.get(k).push(m);
  }
  let best = null;
  for (const [, list] of byTarget) {
    const props = new Set(list.map((m) => m.p));
    const score = ['x', 'y', 'z'].filter((a) => props.has(`m_LocalPosition.${a}`)).length
      + ['x', 'y', 'z', 'w'].filter((a) => props.has(`m_LocalRotation.${a}`)).length;
    if (!best || score > best.score) best = { score, list };
  }
  return best && best.score >= 3 ? best.list : [];
}

function applyTransformMods(node, list) {
  for (const m of list) {
    const [prop, axis] = m.p.split('.');
    const v = Number(m.v);
    if (!Number.isFinite(v)) continue;
    const key = { m_LocalPosition: 't', m_LocalRotation: 'r', m_LocalScale: 's' }[prop];
    const idx = { x: 0, y: 1, z: 2, w: 3 }[axis];
    if (key && idx !== undefined && node[key].length > idx) node[key][idx] = v;
  }
}

/**
 * @param {object} graph
 * @param {string} entryPath     the .prefab inside the package/folder
 * @param {(guid:string)=>object|null} structureOf   modelStructure() of a model, or null
 */
function resolvePrefab(graph, entryPath, structureOf) {
  const byPath = new Map(Object.entries(graph.paths).map(([g, p]) => [p, g]));
  const rootGuid = byPath.get(entryPath);
  const out = {
    kind: 'prefab',
    nodes: [],
    models: {},
    materials: {},
    textures: {},
    rendered: [],
    notes: [],
  };
  const ctx = { graph, textures: out.textures, idx: null, modelNames: [] };
  const matKey = (g) => {
    if (!g || !graph.mats[g]) return null;
    if (!out.materials[g]) out.materials[g] = translateMaterial(ctx, g);
    return g;
  };
  // A renderer slot pointing at a material embedded in a model file (FBX
  // "Use Embedded Materials"): find its name (name table or Unity's hashed
  // fileID), then resolve it the way that model resolves its own materials.
  const modelMats = new Map();
  const modelMatKey = (ref, fallbackStructure) => {
    const id = `${ref.g}:${ref.f}`;
    if (modelMats.has(id)) return modelMats.get(id);
    let key = null;
    const own = structureOf(ref.g);
    const meta = graph.metas[ref.g] || {};
    const candidates = [own, fallbackStructure].filter((x) => x && x.materials && x.materials.length);
    let name = meta.ids && meta.ids[ref.f] ? meta.ids[ref.f].n : null;
    for (const st of candidates) {
      for (const m of st.materials) for (let i = 0; i < 4 && !name; i += 1) if (unityFileId('Material', m.name, i) === ref.f) name = m.name;
      if (name) break;
    }
    if (name) {
      const st = candidates.find((x) => x.materials.some((m) => m.name === name))
        || { ok: true, meshes: [], materials: [{ name, diffuse: null, normal: null }], textures: [], models: [], hasGeometry: true };
      const res = resolveModel(graph, graph.paths[ref.g], st);
      Object.assign(out.textures, res.textures);
      const k = res.byName[sanitize(name)];
      if (k && k !== 'embedded' && k !== 'default' && res.materials[k]) {
        out.materials[k] = res.materials[k];
        key = k;
      } else {
        const emb = res.embedded[sanitize(name)] || {};
        key = `model:${ref.g}:${sanitize(name)}`;
        out.materials[key] = {
          name,
          family: 'embedded',
          shader: `embedded in ${path.basename(graph.paths[ref.g])}`,
          exact: Boolean(emb.map),
          color: emb.map ? [1, 1, 1, 1] : [0.8, 0.8, 0.8, 1],
          metalness: 0,
          roughness: 0.7,
          alpha: 'opaque',
          maps: { ...(emb.map ? { map: { tex: emb.map } } : {}), ...(emb.normalMap ? { normalMap: { tex: emb.normalMap, scale: 1 } } : {}) },
        };
      }
    }
    modelMats.set(id, key);
    return key;
  };
  const slotKey = (m, meshStructure) => {
    if (!m || !m.g) return null;
    if (graph.mats[m.g]) return matKey(m.g);
    if (graph.paths[m.g] && MODEL_EXT.test(graph.paths[m.g])) return modelMatKey(m, meshStructure);
    return null;
  };
  let unresolvedOverrides = 0;
  let deepOverrides = 0;
  let missingMeshes = 0;
  const unreadable = new Set();
  let unreadableParts = 0;
  const absentMats = new Set();
  let seq = 0;

  const useModel = (guid) => {
    if (!out.models[guid]) {
      const s = structureOf(guid);
      const meta = graph.metas[guid] || {};
      // Unity scales model files to metres: the importer's stored file scale
      // (Unity 5), else the FBX unit (cm = 1 -> 0.01), times Global Scale.
      const fileScale = meta.fileScale || (s && s.unitScale ? s.unitScale / 100 : 1);
      out.models[guid] = {
        path: graph.paths[guid],
        format: path.extname(graph.paths[guid]).slice(1).toLowerCase(),
        fileScale: fileScale * (meta.scale || 1),
      };
    }
    return out.models[guid];
  };

  function expand(prefabGuid, parentId, depth, rootMods) {
    const prefab = graph.prefabs[prefabGuid];
    if (!prefab || prefab.bin) {
      out.notes.push(`${path.basename(graph.paths[prefabGuid] || 'prefab')}: ${prefab && prefab.bin ? 'stored in binary form (Unity 4)' : 'not found'} — not shown`);
      return;
    }
    const o = prefab.o || {};
    // Stripped transforms are placeholders for objects of nested instances.
    const transforms = Object.entries(o).filter(([, x]) => (x.c === 4 || x.c === 224) && !x.st);
    const idOf = new Map();                       // transform fileID -> node id
    const goOfTransform = new Map(transforms.map(([id, t]) => [id, t.go]));
    const strippedToInstance = new Map();          // stripped transform -> instance node id
    // Renderers and filters per GameObject.
    const filterOf = {};
    const rendererOf = {};
    for (const x of Object.values(o)) {
      if (x.c === 33 && x.go) filterOf[x.go] = x;
      if ((x.c === 23 || x.c === 137) && x.go) rendererOf[x.go] = x;
    }
    // LOD groups: only LOD0 renderers are shown.
    const hiddenRenderers = new Set();
    for (const x of Object.values(o)) {
      if (x.c !== 205) continue;
      (x.lods || []).slice(1).forEach((lod) => lod.forEach((r) => hiddenRenderers.add(r)));
      for (const r of (x.lods || [])[0] || []) hiddenRenderers.delete(r);
    }
    const rendererId = new Map(Object.entries(o).filter(([, x]) => x.c === 23 || x.c === 137).map(([id, x]) => [x, id]));

    // Stripped objects stand for objects of nested instances (parents for
    // things this prefab adds under them).
    for (const [sid, x] of Object.entries(o)) if (x.st && x.pi) strippedToInstance.set(sid, `pi:${prefabGuid}:${x.pi}`);

    // Transforms in parent-first order.
    const ordered = [];
    const seen = new Set();
    const visit = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const t = o[id];
      if (t && t.fa && t.fa !== '0' && o[t.fa] && !o[t.fa].st) visit(t.fa);
      ordered.push(id);
    };
    for (const [id] of transforms) visit(id);

    let isRoot = true;
    for (const id of ordered) {
      const t = o[id];
      const go = o[t.go] || {};
      const node = {
        id: `n${(seq += 1)}`,
        name: go.n || 'GameObject',
        parent: null,
        t: [...t.p],
        r: [...t.r],
        s: [...t.s],
        active: go.a !== 0,
      };
      if (t.fa && t.fa !== '0') node.parent = idOf.get(t.fa) || strippedToInstance.get(t.fa) || parentId;
      else node.parent = parentId;
      if (isRoot && (!t.fa || t.fa === '0') && rootMods && rootMods.length) applyTransformMods(node, rootMods);
      if (!t.fa || t.fa === '0') isRoot = false;
      idOf.set(id, node.id);

      const filter = filterOf[t.go];
      const renderer = rendererOf[t.go];
      if (renderer && renderer.en !== 0 && !hiddenRenderers.has(rendererId.get(renderer))) {
        const meshRef = renderer.c === 137 ? renderer.mesh : (filter && filter.mesh);
        const meshStructure = meshRef && meshRef.g && graph.paths[meshRef.g] ? structureOf(meshRef.g) : null;
        const mats = (renderer.mats || []).map((m) => slotKey(m, meshStructure));
        if (meshRef && meshRef.g && graph.paths[meshRef.g] && MESH_SOURCE.test(graph.paths[meshRef.g])) {
          const structure = meshStructure;
          useModel(meshRef.g);
          const meshName = structure ? (meshNameFor(meshRef.f, graph.metas[meshRef.g], structure)
            || (structure.meshes.length === 1 ? structure.meshes[0].name : null)) : null;
          if (meshName) {
            node.mesh = { model: meshRef.g, name: meshName, key: sanitize(meshName), materials: mats, skinned: renderer.c === 137 };
            (renderer.mats || []).forEach((ref, i) => { if (ref && ref.g && !mats[i]) absentMats.add(ref.g); });
            for (const m of mats) {
              const spec = m && out.materials[m];
              out.rendered.push({ mesh: node.name, slot: spec ? spec.name : null, source: 'prefab', material: m, fidelity: !m ? 'missing' : spec && spec.exact ? 'exact' : 'approximate' });
            }
          } else {
            missingMeshes += 1;
            if (structure && structure.error) { unreadableParts += 1; unreadable.add(`${path.basename(graph.paths[meshRef.g])}: ${structure.error}`); }
            out.rendered.push({ mesh: node.name, slot: null, source: 'missing', material: null, fidelity: 'missing' });
          }
        } else if (meshRef && meshRef.g === BUILTIN_MESH_GUID && BUILTIN_MESHES[meshRef.f]) {
          node.builtin = { shape: BUILTIN_MESHES[meshRef.f], materials: mats };
          for (const m of mats.length ? mats : [null]) {
            const spec = m && out.materials[m];
            out.rendered.push({ mesh: node.name, slot: spec ? spec.name : null, source: 'prefab', material: m || 'default', fidelity: !m || (spec && spec.exact) ? 'exact' : 'approximate' });
          }
        } else if (meshRef && meshRef.f && meshRef.f !== '0') {
          // Built-in meshes (Cube, Sphere, …) or meshes in other packages.
          missingMeshes += 1;
          out.rendered.push({ mesh: node.name, slot: null, source: 'missing', material: null, fidelity: 'missing' });
        }
      }
      out.nodes.push(node);
    }

    // Nested prefab / model instances.
    for (const [pid, inst] of Object.entries(o)) {
      if (inst.c !== 1001 || !inst.src || !inst.src.g) continue;
      const srcPath = graph.paths[inst.src.g] || '';
      const parent = idOf.get(inst.pa) || strippedToInstance.get(inst.pa) || parentId;
      const rootMods = rootTransformMods(inst.mods || []);
      const others = (inst.mods || []).filter((m) => !rootMods.includes(m));
      if (MODEL_EXT.test(srcPath)) {
        // A model placed as a prefab instance: the whole model, with overrides.
        const structure = structureOf(inst.src.g);
        const model = useModel(inst.src.g);
        const base = structure ? resolveModel(graph, srcPath, structure) : null;
        if (base) {
          Object.assign(out.materials, base.materials);
          Object.assign(out.textures, base.textures);
          out.rendered.push(...base.rendered.map((r) => ({ ...r, mesh: `${path.basename(srcPath)} › ${r.mesh}` })));
        }
        const overrides = {};
        const meta = graph.metas[inst.src.g] || {};
        const singleRenderer = structure && structure.meshes.length === 1 ? structure.meshes[0].name : null;
        for (const m of others) {
          const slot = /^m_Materials\.Array\.data\[(\d+)\]$/.exec(m.p);
          if (!slot || !m.r || !m.r.g) continue;
          const named = meta.ids && meta.ids[m.t.f] ? meta.ids[m.t.f].n : null;
          const target = named && named !== '//RootNode' ? named : singleRenderer;
          if (!target) { unresolvedOverrides += 1; continue; }
          const key = sanitize(target);
          (overrides[key] = overrides[key] || [])[Number(slot[1])] = slotKey(m.r, structure);
        }
        const node = {
          id: `pi:${prefabGuid}:${pid}`,
          name: path.basename(srcPath, path.extname(srcPath)),
          parent,
          t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1],
          active: true,
          instance: {
            model: inst.src.g,
            byName: base ? base.byName : {},
            bindings: base ? base.bindings : [],
            embedded: base ? base.embedded : {},
            fallback: base ? base.fallback : 'default',
            fileTextures: base ? base.fileTextures : {},
            overrides,
          },
        };
        applyTransformMods(node, rootMods);
        void model;
        out.nodes.push(node);
      } else if (/\.prefab$/i.test(srcPath)) {
        if (depth >= MAX_DEPTH) { out.notes.push(`nested prefabs deeper than ${MAX_DEPTH} levels are not shown`); continue; }
        if (others.length) deepOverrides += others.length;
        const holder = { id: `pi:${prefabGuid}:${pid}`, name: path.basename(srcPath, '.prefab'), parent, t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1], active: true };
        out.nodes.push(holder);
        expand(inst.src.g, holder.id, depth + 1, rootMods);
      }
    }
  }

  if (!rootGuid || !graph.prefabs[rootGuid]) {
    out.fidelity = 'missing';
    out.notes.push('prefab not found in the link map');
    return out;
  }
  expand(rootGuid, null, 0, null);

  if (unresolvedOverrides) out.notes.push(`${unresolvedOverrides} material override(s) on nested models could not be matched to a part — their own materials are shown`);
  if (deepOverrides) out.notes.push(`${deepOverrides} override(s) inside nested prefabs are not applied (only their placement)`);
  for (const u of [...unreadable].slice(0, 5)) out.notes.push(u);
  if (absentMats.size) out.notes.push(`${absentMats.size} material(s) used here are not in this package`);
  if (missingMeshes > unreadableParts) out.notes.push(`${missingMeshes - unreadableParts} part(s) use meshes that are not in this package`);
  for (const spec of Object.values(out.materials)) if (spec.note) out.notes.push(`${spec.name}: ${spec.note}`);
  out.notes = [...new Set(out.notes)];

  const r = out.rendered;
  const hasGeometry = out.nodes.some((n) => n.mesh || n.instance || n.builtin) || missingMeshes > 0;
  if (!hasGeometry) out.fidelity = 'none';
  else if (r.length && r.every((x) => x.fidelity === 'exact') && !unresolvedOverrides && !deepOverrides) out.fidelity = 'exact';
  else if (r.length && r.every((x) => x.fidelity === 'missing')) out.fidelity = 'missing';
  else out.fidelity = 'approximate';
  out.counts = {
    exact: r.filter((x) => x.fidelity === 'exact').length,
    approximate: r.filter((x) => x.fidelity === 'approximate').length,
    missing: r.filter((x) => x.fidelity === 'missing').length,
  };
  return out;
}

module.exports = { resolvePrefab, rootTransformMods };
