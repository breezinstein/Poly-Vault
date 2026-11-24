'use strict';
// Works out what a model looks like in Unity, from its package's link map.
//
// Input: the link map (unityGraph), the model's GUID, and what is inside the
// model file (meshes, materials, texture links — see modelStructure()). Output: a
// manifest the browser viewer applies to the loaded model:
//
//   {
//     model:     { guid, path, format, scale, rig }
//     bindings:  [{ mesh, key, materials:[matKey|null] }]  per mesh, from prefabs
//     byName:    { sanitizedFbxMaterialName: matKey|'embedded'|'default' }
//     fallback:  'embedded' | 'default'                 anything unmatched
//     materials: { matKey: materialSpec }              translated for three.js
//     textures:  { texKey: { guid, path, role, srgb } } what to fetch
//     fileTextures: { basename: texKey }               FBX-referenced files
//     rendered:  [{ mesh, slot, source, material, fidelity }]  every sub-mesh
//     fidelity:  'exact' | 'approximate' | 'missing' | 'none' (no geometry)
//     notes:     [string]
//   }
//
// Unity's own order is followed for every material slot of the model:
//   1. remap     ModelImporter externalObjects (explicit, authoritative)
//   2. prefab    a prefab in the package renders this mesh with materials
//   3. search    legacy material search (materialName/materialSearch rules)
//   4. embedded  materials described inside the FBX (materialLocation = 1),
//                textures found by file name like Unity does
//   5. default   import mode "None": Unity shows its default material
//   6. missing

const path = require('path');
const { unityFileId } = require('./xxhash64');

const BUILTIN = '0000000000000000f000000000000000';
const SHADERS = {
  [`${BUILTIN}:46`]: { family: 'standard', name: 'Standard' },
  [`${BUILTIN}:45`]: { family: 'standard-specular', name: 'Standard (Specular setup)' },
  '933532a4fcc9baf4fa0491de14d08ed7': { family: 'urp-lit', name: 'Universal Render Pipeline/Lit' },
  '8d2bb70cbf9db8d4da26e15b26e74248': { family: 'urp-simple', name: 'Universal Render Pipeline/Simple Lit' },
  '650dd9526735d5b46b79224bc6e94025': { family: 'urp-unlit', name: 'Universal Render Pipeline/Unlit' },
  '0ca6dca7396eb48e5849247ffd444914': { family: 'urp-baked', name: 'Universal Render Pipeline/Baked Lit' },
  '6e4ae4064600d784cac1e41a9e6f2e59': { family: 'hdrp-lit', name: 'HDRP/Lit' },
  'c4edd00ff2db5b24391a4fcb1762e459': { family: 'hdrp-unlit', name: 'HDRP/Unlit' },
};

const TEXTURE_EXT = /\.(png|jpe?g|tga|psd|tiff?|bmp|gif|webp|exr|hdr|dds)$/i;
const MODEL_EXT = /\.(fbx|obj|dae|3ds|dxf|glb|gltf|blend|max|ma|mb)$/i;
const sanitize = (name) => String(name || '').replace(/\s/g, '_').replace(/[[\]./:]/g, '');

// --- shader translation --------------------------------------------------------

function shaderInfo(graph, sh) {
  if (!sh) return { family: 'default', name: 'Default-Material', exact: true };
  if (sh.g === BUILTIN) {
    const known = SHADERS[`${BUILTIN}:${sh.f}`];
    if (known) return { ...known, exact: true };
    // Other built-ins (Legacy/*, Mobile/*, Unlit/*) use the classic property
    // names (_MainTex, _Color, _BumpMap, _Cutoff), which translate directly.
    return { family: 'legacy', name: `Built-in shader #${sh.f}`, exact: true };
  }
  const known = sh.g && SHADERS[sh.g];
  if (known) return { ...known, exact: true };
  const p = sh.g && graph.paths[sh.g];
  return { family: 'custom', name: p ? path.basename(p) : 'custom shader (not in this package)', exact: false };
}

const first = (obj, names) => {
  for (const n of names) if (obj && obj[n] !== undefined) return [n, obj[n]];
  return [null, undefined];
};

// Name heuristics for custom shaders, most specific first.
const GUESS = [
  ['normal', /(normal|bump)/i],
  ['emission', /emiss/i],
  ['mask', /(mask|metal|rough|smooth|gloss|spec|orm|mra|mrao)/i],
  ['ao', /(occlusion|^_?ao$|_ao_|ambient)/i],
  ['albedo', /(albedo|base|main|diffuse|color|colour|^_?tex(ture)?\d*$|^_?atlas)/i],
];
function guessSlot(prop) {
  if (/detail|splat|control|noise|dissolve|ramp|matcap|cube|reflection|height|parallax|flow|lightmap/i.test(prop)) return null;
  for (const [role, re] of GUESS) if (re.test(prop)) return role;
  return null;
}

function texRef(ctx, guid, role, extra = {}) {
  if (!guid || !ctx.graph.paths[guid]) return null;
  const meta = ctx.graph.metas[guid];
  const tex = meta && meta.tex;
  const p = ctx.graph.paths[guid];
  if (!TEXTURE_EXT.test(p)) return null;
  const key = role === 'orm' ? `orm:${guid}:${extra.recipe}` : `${role}:${guid}`;
  if (!ctx.textures[key]) {
    ctx.textures[key] = {
      guid,
      path: p,
      role,
      srgb: role === 'albedo' || role === 'emission' ? 1 : 0,
      ...(tex && tex.type === 1 ? { normalImport: 1 } : {}),
      ...extra,
    };
  }
  return key;
}

// --- fuzzy texture matching (last resort, always "approximate") ----------------
// Packs rename files between the DCC tool and Unity ("semi_cab.tga" ->
// "Lorry_cab.tga") and Unity 4 named materials after textures ("blocks.mat" ->
// "blocks_texture.png"). Compare word tokens, ignoring filler words, with the
// model's own name as extra context; never pick a normal/mask/etc. map.
const FILLER = new Set(['texture', 'textures', 'tex', 'mat', 'mtl', 'material', 'materials', 'diffuse', 'diff', 'd', 'albedo',
  'color', 'colour', 'col', 'base', 'basecolor', 'map', 'main', 'default', 'new', 'final', 'c', 'df', 'dif']);
const NOT_ALBEDO = /(normal|_n$|_nrm|bump|spec|gloss|rough|metal|_ao$|occlusion|height|_h$|mask|emiss|_e$|disp|cavity|curv|opacity|alpha)/i;
function tokens(name) {
  return new Set(String(name || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !FILLER.has(t) && !/^\d{1,2}$/.test(t)));
}
function fuzzyTexture(ctx, name, nearPath, contextNames = []) {
  const want = tokens(name);
  if (!want.size) return null;
  const ctxTokens = new Set(contextNames.flatMap((n) => [...tokens(n)]));
  const pool = new Set([...want, ...ctxTokens]);
  let best = null;
  let bestScore = 0;
  let bestShared = 0;
  for (const [guid, p] of Object.entries(ctx.graph.paths)) {
    if (!TEXTURE_EXT.test(p)) continue;
    const stem = path.basename(p, path.extname(p));
    if (NOT_ALBEDO.test(stem)) continue;
    const have = tokens(stem);
    if (!have.size) continue;
    let shared = 0;
    let sharedWant = 0;
    for (const t of have) { if (pool.has(t)) shared += 1; if (want.has(t)) sharedWant += 1; }
    if (!sharedWant) continue;                        // must share a word with the name itself
    const score = shared / new Set([...pool, ...have]).size + sharedWant / (want.size + have.size);
    const tie = score === bestScore && best && closestByPath(ctx.graph, [best, guid], nearPath) === guid;
    if (score > bestScore || tie) { best = guid; bestScore = score; bestShared = shared; }
  }
  return bestScore >= 0.5 && bestShared ? best : null;
}

const linearColor = (c) => (Array.isArray(c) ? c.slice(0, 4) : null);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Translate one compact material into a three.js-ready spec. */
function translateMaterial(ctx, matGuid) {
  const mat = ctx.graph.mats[matGuid];
  if (!mat) return null;
  if (mat.bin) {
    // Unity 4 binary .mat: unreadable, but its texture is nearly always named
    // like the material (Unity 4 named materials after their texture).
    const spec = { name: mat.n, shader: 'binary material (Unity 4)', family: 'binary', exact: false, maps: {}, color: [1, 1, 1, 1], metalness: 0, roughness: 0.8, alpha: 'opaque', cutoff: 0.5, note: 'material is stored in binary form; texture matched by name' };
    const matPath = ctx.graph.paths[matGuid] || '';
    const hits = ctx.idx && ctx.idx.texByBase.get(String(mat.n).toLowerCase());
    // Unity 4 generated "<texDir>/Materials/<name>.mat" from "<texDir>/<name>.*".
    const g = (hits && closestByPath(ctx.graph, hits, matPath))
      || fuzzyTexture(ctx, mat.n, matPath, ctx.modelNames || []);
    const key = g ? texRef(ctx, g, 'albedo') : null;
    if (key) spec.maps.map = { tex: key, s: [1, 1], o: [0, 0] };
    else spec.note = 'material is stored in binary form and no texture has its name';
    return spec;
  }
  const sh = shaderInfo(ctx.graph, mat.sh);
  const tex = mat.tex || {};
  const f = mat.f || {};
  const c = mat.c || {};
  const kw = new Set(mat.kw || []);
  const spec = {
    name: mat.n,
    shader: sh.name,
    family: sh.family,
    exact: sh.exact,
    color: [1, 1, 1, 1],
    maps: {},
    metalness: 0,
    roughness: 0.5,
    alpha: 'opaque',
    cutoff: 0.5,
    doubleSided: false,
    unlit: /unlit/.test(sh.family),
  };

  // --- albedo + tint -----------------------------------------------------------
  let albedoProp;
  let colorProp;
  const fam = sh.family;
  if (fam.startsWith('urp') || fam.startsWith('hdrp')) {
    albedoProp = first(tex, fam.startsWith('hdrp') ? ['_BaseColorMap', '_MainTex'] : ['_BaseMap', '_MainTex'])[0];
    colorProp = first(c, ['_BaseColor', '_Color'])[0];
  } else if (fam === 'custom') {
    albedoProp = Object.keys(tex).find((k) => guessSlot(k) === 'albedo');
    colorProp = first(c, ['_BaseColor', '_Color', '_MainColor', '_Tint', '_TintColor', '_AlbedoColor'])[0];
    if (!colorProp) colorProp = Object.keys(c).find((k) => /(base|main|albedo|tint|^_color$)/i.test(k) && !/emiss|spec|rim|shadow|outline/i.test(k));
  } else {
    albedoProp = first(tex, ['_MainTex'])[0];
    colorProp = first(c, ['_Color'])[0];
  }
  if (colorProp) spec.color = linearColor(c[colorProp]) || spec.color;
  if (albedoProp) {
    const t = tex[albedoProp];
    const key = texRef(ctx, t.g, 'albedo');
    if (key) spec.maps.map = { tex: key, s: t.s, o: t.o };
  }
  // Many legacy/Mobile built-ins ignore _Color, and old files leave it at
  // black: a black tint over a texture would hide the texture entirely.
  if (fam === 'legacy' && spec.maps.map && spec.color[0] + spec.color[1] + spec.color[2] < 0.001) {
    spec.color = [1, 1, 1, spec.color[3] ?? 1];
  }
  // Standard applies the main texture's tiling to every map.
  const tiling = spec.maps.map ? { s: spec.maps.map.s, o: spec.maps.map.o } : { s: [1, 1], o: [0, 0] };

  // --- normal ------------------------------------------------------------------
  const normalProp = fam === 'custom'
    ? Object.keys(tex).find((k) => guessSlot(k) === 'normal')
    : first(tex, fam.startsWith('hdrp') ? ['_NormalMap', '_BumpMap'] : ['_BumpMap', '_NormalMap'])[0];
  if (normalProp) {
    const key = texRef(ctx, tex[normalProp].g, 'normal');
    if (key) spec.maps.normalMap = { tex: key, ...tiling, scale: Number(first(f, ['_BumpScale', '_NormalScale'])[1] ?? 1) };
  }

  // --- metal / smoothness / occlusion -> one ORM texture ------------------------
  const smoothness = Number(first(f, ['_Smoothness', '_Glossiness'])[1] ?? 0.5);
  const metallic = Number(first(f, ['_Metallic'])[1] ?? 0);
  const glossScale = Number(first(f, ['_GlossMapScale', '_Smoothness'])[1] ?? 1);
  const fromAlbedoAlpha = Number(f._SmoothnessTextureChannel || 0) === 1;
  let mgProp = null;
  let kind = null;
  if (fam.startsWith('hdrp') && tex._MaskMap) { mgProp = '_MaskMap'; kind = 'mask'; }
  else if (tex._MetallicGlossMap && fam !== 'standard-specular') { mgProp = '_MetallicGlossMap'; kind = 'metallic'; }
  else if (tex._SpecGlossMap) { mgProp = '_SpecGlossMap'; kind = 'specular'; }
  else if (fam === 'custom') {
    mgProp = Object.keys(tex).find((k) => guessSlot(k) === 'mask') || null;
    kind = mgProp ? 'mask' : null;
  }
  const aoProp = first(tex, ['_OcclusionMap'])[0] || (fam === 'custom' ? Object.keys(tex).find((k) => guessSlot(k) === 'ao') : null);
  const aoStrength = Number(first(f, ['_OcclusionStrength', '_AORemapMax'])[1] ?? 1);

  spec.metalness = fam === 'standard-specular' || fam === 'legacy' ? 0 : clamp01(metallic);
  spec.roughness = clamp01(1 - smoothness);
  if (fam === 'legacy') spec.roughness = 0.8;
  if (mgProp || aoProp || (fromAlbedoAlpha && spec.maps.map)) {
    const recipe = [
      `k=${kind || 'none'}`,
      mgProp ? `mg=${tex[mgProp].g}` : '',
      aoProp ? `ao=${tex[aoProp].g}` : '',
      `ao_s=${clamp01(aoStrength).toFixed(3)}`,
      `ss=${(kind ? glossScale : smoothness).toFixed(3)}`,
      fromAlbedoAlpha && spec.maps.map ? `sa=${tex[albedoProp].g}` : '',
      `m=${spec.metalness.toFixed(3)}`,
    ].filter(Boolean).join('&');
    const base = (mgProp && tex[mgProp].g) || (aoProp && tex[aoProp].g) || tex[albedoProp].g;
    const key = texRef(ctx, base, 'orm', { recipe });
    if (key) {
      spec.maps.ormMap = { tex: key, ...tiling };
      // The recipe bakes the scalars in: the map carries the final values.
      if (kind === 'metallic' || kind === 'mask') spec.metalness = 1;
      if (kind || (fromAlbedoAlpha && spec.maps.map)) spec.roughness = 1;
      spec.aoMap = Boolean(aoProp || kind === 'mask');
    }
  }

  // --- emission ------------------------------------------------------------------
  const emissionOn = kw.has('_EMISSION') || fam.startsWith('hdrp') || fam === 'custom';
  const [, emissiveColor] = first(c, ['_EmissionColor', '_EmissiveColor']);
  const emissionProp = first(tex, ['_EmissionMap', '_EmissiveColorMap'])[0] || (fam === 'custom' ? Object.keys(tex).find((k) => guessSlot(k) === 'emission') : null);
  if (emissionOn && Array.isArray(emissiveColor) && (emissiveColor[0] + emissiveColor[1] + emissiveColor[2]) > 0.001) {
    const m = Math.max(emissiveColor[0], emissiveColor[1], emissiveColor[2]);
    spec.emissive = m > 1 ? emissiveColor.slice(0, 3).map((v) => v / m) : emissiveColor.slice(0, 3);
    spec.emissiveIntensity = Math.min(m > 1 ? m : 1, 4);
    if (emissionProp) {
      const key = texRef(ctx, tex[emissionProp].g, 'emission');
      if (key) spec.maps.emissiveMap = { tex: key, ...tiling };
    }
  }

  // --- transparency -------------------------------------------------------------
  const mode = Number(f._Mode ?? -1);
  const surface = Number(first(f, ['_Surface', '_SurfaceType'])[1] ?? 0);
  const alphaClip = Number(first(f, ['_AlphaClip', '_AlphaCutoffEnable'])[1] ?? 0);
  const renderType = (mat.tags && mat.tags.RenderType) || '';
  if (mode === 1 || alphaClip === 1 || kw.has('_ALPHATEST_ON') || renderType === 'TransparentCutout' || (mat.q >= 2450 && mat.q < 3000)) spec.alpha = 'mask';
  if (mode === 2 || mode === 3 || surface === 1 || kw.has('_ALPHABLEND_ON') || kw.has('_SURFACE_TYPE_TRANSPARENT') || renderType === 'Transparent' || mat.q >= 3000) spec.alpha = 'blend';
  spec.cutoff = Number(first(f, ['_Cutoff', '_AlphaCutoff'])[1] ?? 0.5);

  // --- culling ---------------------------------------------------------------------
  const cull = first(f, ['_Cull', '_CullMode'])[1];
  if (Number(f._DoubleSidedEnable || 0) === 1 || (cull !== undefined && Number(cull) === 0)) spec.doubleSided = true;

  // A custom shader whose albedo we could not identify: vertex colours are the
  // usual reason (low-poly packs), so let the viewer use them when present.
  if (fam === 'custom' && !spec.maps.map) spec.vertexColors = true;
  if (fam === 'custom') spec.note = `custom shader "${sh.name}": texture slots matched by name`;
  return spec;
}

// --- model contents --------------------------------------------------------------

const { scanFbx } = require('./fbxScan');
const { scanCollada } = require('./colladaScan');
const { meshAssetStructure } = require('./unityMesh');

/**
 * What a model file says about itself, in one shape for every format:
 *   { meshes:[{name, materials:[name]}], materials:[{name, diffuse, normal}],
 *     textures:[file], models:[name], hasGeometry }
 */
function modelStructure(buffer, format) {
  if (format === 'fbx') {
    const s = scanFbx(buffer);
    if (s.ok) return s;
    return { ok: false, error: s.error, meshes: [], materials: [], textures: [], models: [], hasGeometry: true };
  }
  if (format === 'dae') return scanCollada(buffer);
  if (format === 'asset') return meshAssetStructure(buffer);
  if (format === 'obj') {
    const text = buffer.toString('utf8');
    const meshes = [];
    let current = { name: 'default', materials: [] };
    for (const line of text.split(/\r?\n/)) {
      const o = /^[og]\s+(.+)$/.exec(line);
      if (o) { current = { name: o[1].trim(), materials: [] }; meshes.push(current); continue; }
      const u = /^usemtl\s+(.+)$/.exec(line);
      if (u) {
        if (!meshes.includes(current)) meshes.push(current);
        if (!current.materials.includes(u[1].trim())) current.materials.push(u[1].trim());
      }
    }
    const names = [...new Set(meshes.flatMap((m) => m.materials))];
    return { ok: true, meshes, materials: names.map((n) => ({ name: n, diffuse: null, normal: null })), textures: [], models: meshes.map((m) => m.name), hasGeometry: true };
  }
  return { ok: true, meshes: [], materials: [], textures: [], models: [], hasGeometry: true, opaque: true };
}

// fileID of a mesh inside a model -> its node name (Unity naming rules).
function meshNameFor(fileId, meta, structure) {
  // Unity mesh assets: the prefab names the Mesh object by its own fileID.
  if (structure && structure.fileIds) return structure.fileIds[fileId] || null;
  if (meta && meta.ids && meta.ids[fileId]) return meta.ids[fileId].n;
  const names = [...new Set([...(structure.meshes || []).map((m) => m.name), ...(structure.models || [])])];
  for (const n of names) for (let i = 0; i < 4; i += 1) if (unityFileId('Mesh', n, i) === fileId) return n;
  if (/^43000\d\d$/.test(fileId)) {
    const idx = (Number(fileId) - 4300000) / 2;
    return (structure.meshes[idx] && structure.meshes[idx].name) || null;
  }
  return null;
}

// --- resolution --------------------------------------------------------------------

function indexGraph(graph) {
  const byPath = new Map();
  const matsByName = new Map();      // lower name -> [guid]
  const texByBase = new Map();       // lower file name and stem -> [guid]
  const push = (map, k, v) => (map.get(k) || map.set(k, []).get(k)).push(v);
  for (const [guid, p] of Object.entries(graph.paths)) {
    byPath.set(p, guid);
    const ext = path.extname(p).toLowerCase();
    const stem = path.basename(p, ext).toLowerCase();
    if (ext === '.mat') push(matsByName, stem, guid);
    if (TEXTURE_EXT.test(p)) {
      push(texByBase, path.basename(p).toLowerCase(), guid);
      push(texByBase, stem, guid);
    }
  }
  return { byPath, matsByName, texByBase };
}

// The candidate with the longest common path prefix with `fromPath`.
function closestByPath(graph, guids, fromPath) {
  if (!guids || !guids.length) return null;
  const parts = fromPath.split('/');
  let best = null;
  let bestScore = -1;
  for (const g of guids) {
    const q = graph.paths[g].split('/');
    let k = 0;
    while (k < parts.length && k < q.length && parts[k] === q[k]) k += 1;
    if (k > bestScore) { best = g; bestScore = k; }
  }
  return best;
}

// Unity's legacy search: <dir>/Materials/<name>.mat, then walking up (1), or
// anywhere in the project (2).
function searchMaterial(graph, idx, modelPath, name, searchMode) {
  const candidates = idx.matsByName.get(String(name).toLowerCase()) || [];
  if (!candidates.length) return null;
  let dir = path.posix.dirname(modelPath);
  const dirs = [dir];
  if (searchMode >= 1) {
    while (dir && dir !== '.' && dir !== '/') { dir = path.posix.dirname(dir); dirs.push(dir); }
  }
  for (const d of dirs) {
    const want = d === '.' ? 'Materials' : `${d}/Materials`;
    const hit = candidates.find((g) => path.posix.dirname(graph.paths[g]) === want);
    if (hit) return hit;
  }
  return searchMode >= 2 ? closestByPath(graph, candidates, modelPath) : null;
}

const stemOf = (file) => {
  const base = String(file || '').split(/[\\/]/).pop();
  return base ? base.slice(0, base.length - path.extname(base).length) : '';
};

// Unity's ModelImporterMaterialName rules.
function legacyNames(rule, modelBase, mat) {
  const tex = stemOf(mat.diffuse);
  const own = mat.name || 'No Name';
  switch (rule) {
    case 1: return [own];
    case 2: return [`${modelBase}-${own}`];
    case 3: return tex ? [tex] : [`${modelBase}-${own}`];
    default: return tex ? [tex] : [own];
  }
}

/**
 * @param {object} graph       link map
 * @param {string} entryPath   model path inside the package/folder
 * @param {object} structure   modelStructure() of the model file
 */
function resolveModel(graph, entryPath, structure) {
  const idx = indexGraph(graph);
  const guid = idx.byPath.get(entryPath) || null;
  const meta = (guid && graph.metas[guid]) || null;
  const format = path.extname(entryPath).slice(1).toLowerCase();
  const modelBase = path.basename(entryPath, path.extname(entryPath));
  const ctx = { graph, textures: {}, idx, modelNames: [modelBase] };
  const materials = {};
  const notes = [];
  const matKey = (g) => {
    if (!g || !graph.mats[g]) return null;
    if (!materials[g]) materials[g] = translateMaterial(ctx, g);
    return g;
  };
  // No .meta: an old (Unity 4) package. Unity 4's defaults apply.
  const rules = (meta && meta.mat) || { mode: 1, name: 0, search: 1, location: 0 };
  if (!meta) notes.push('no import settings in the package (Unity 4 era): Unity 4 defaults assumed');

  // --- 1. explicit remaps ----------------------------------------------------------
  const remaps = {};
  for (const e of (meta && meta.ext) || []) if (/Material$/.test(e.type)) remaps[e.name] = e.g;

  // --- 2. prefabs rendering this model's meshes ------------------------------------
  const bindings = {};
  const bindingFrom = {};
  if (guid) {
    // Prefabs first (named like the model, then shallowest), then scenes:
    // Unity 4-era packs often only assign materials on scene objects.
    const rank = ([g, , kind]) => (kind === 'scene' ? 2 : path.basename(graph.paths[g] || '', '.prefab') === modelBase ? 0 : 1);
    const prefabs = [
      ...Object.entries(graph.prefabs).map(([g, p]) => [g, p, 'prefab']),
      ...Object.entries(graph.scenes || {}).map(([g, p]) => [g, p, 'scene']),
    ].sort((a, b) => rank(a) - rank(b) || (graph.paths[a[0]] || '').length - (graph.paths[b[0]] || '').length);
    for (const [, prefab, kind] of prefabs) {
      const objs = prefab.o || {};
      const filters = {};
      for (const o of Object.values(objs)) if (o.c === 33 && o.mesh && o.mesh.g === guid) filters[o.go] = o.mesh;
      for (const o of Object.values(objs)) {
        if (o.c !== 23 && o.c !== 137) continue;
        const mesh = o.c === 137 ? (o.mesh && o.mesh.g === guid ? o.mesh : null) : filters[o.go];
        if (!mesh) continue;
        const name = meshNameFor(mesh.f, meta, structure)
          || (structure.meshes.length === 1 ? structure.meshes[0].name : null);
        if (!name || bindings[name]) continue;
        const mats = (o.mats || []).map((m) => (m && m.g ? matKey(m.g) : null));
        if (mats.some(Boolean)) { bindings[name] = mats; bindingFrom[name] = kind; }
      }
    }
  }

  // --- 3-6. each FBX material Unity would import ------------------------------------
  const fbxMats = new Map(structure.materials.map((m) => [m.name, m]));
  const usedNames = [...new Set(structure.meshes.flatMap((m) => m.materials))];
  const slotByName = {};
  for (const name of usedNames) {
    const mat = fbxMats.get(name) || { name, diffuse: null, normal: null };
    let key = null;
    let source = 'missing';
    if (remaps[name] && matKey(remaps[name])) { key = remaps[name]; source = 'remap'; }
    if (!key && rules.mode !== 0 && rules.location === 0) {
      for (const want of legacyNames(rules.name, modelBase, mat)) {
        const hit = searchMaterial(graph, idx, entryPath, want, rules.search);
        if (hit && matKey(hit)) { key = hit; source = 'search'; break; }
      }
    }
    if (!key && rules.mode !== 0 && rules.location === 1) { key = 'embedded'; source = 'embedded'; }
    if (!key && rules.mode !== 0) {
      // Not where Unity would look, but a material named by one of Unity's
      // rules exists elsewhere in the package: almost always the intent.
      const wanted = [...new Set([...legacyNames(rules.name, modelBase, mat), name, stemOf(mat.diffuse)].filter(Boolean))];
      for (const want of wanted) {
        const near = closestByPath(graph, idx.matsByName.get(want.toLowerCase()), entryPath);
        if (near && matKey(near)) { key = near; source = 'name'; break; }
      }
    }
    // Nothing found: on import Unity *generates* the material from the FBX's own
    // description (legacy: into a Materials folder), so the FBX material is
    // exactly what a user would see.
    if (!key && rules.mode !== 0) { key = 'embedded'; source = 'generated'; }
    if (!key && rules.mode === 0) {
      // "None": materials come from prefabs/scenes. When those are unreadable
      // (Unity 4 binary) or absent, a material named by Unity's own rules is
      // still the author's look — shown, but marked approximate.
      const wanted = [...new Set([stemOf(mat.diffuse), name, `${modelBase}-${name}`].filter(Boolean))];
      for (const want of wanted) {
        const near = closestByPath(graph, idx.matsByName.get(want.toLowerCase()), entryPath);
        if (near && matKey(near)) { key = near; source = 'name'; break; }
      }
      // Still nothing, but the model names its own texture and the package has
      // it: show that (approximate) rather than plain grey.
      if (!key && mat.diffuse) { key = 'embedded'; source = 'model-texture'; }
      if (!key) { key = 'default'; source = 'default'; }
    }
    slotByName[name] = { key, source };
  }

  // Textures the model file references (used by embedded materials).
  const fileTextures = {};
  let fileTexturesMissing = 0;
  let fileTexturesRenamed = 0;
  for (const file of structure.textures || []) {
    const lower = path.basename(file).toLowerCase();
    const g = closestByPath(graph, idx.texByBase.get(lower) || idx.texByBase.get(stemOf(lower)), entryPath);
    const isNormal = structure.materials.some((m) => m.normal && m.normal.toLowerCase() === lower);
    let key = g ? texRef(ctx, g, isNormal ? 'normal' : 'albedo') : null;
    if (!key && !isNormal) {
      const fz = fuzzyTexture(ctx, stemOf(file), entryPath, [modelBase]);
      if (fz) { key = texRef(ctx, fz, 'albedo'); fileTexturesRenamed += 1; }
    }
    if (key) fileTextures[lower] = key; else fileTexturesMissing += 1;
  }

  // Embedded/generated materials, described by the model file itself: its
  // diffuse and normal textures, found in the package by file name.
  const embedded = {};
  for (const m of structure.materials) {
    const diffuse = m.diffuse ? fileTextures[path.basename(m.diffuse).toLowerCase()] : null;
    const normal = m.normal ? fileTextures[path.basename(m.normal).toLowerCase()] : null;
    if (diffuse || normal) embedded[sanitize(m.name)] = { name: m.name, map: diffuse || null, normalMap: normal || null };
  }

  // A binary (Unity 4) material with no name-matched texture: the FBX slot it
  // stands for still names its diffuse file, which is what Unity 4 used.
  for (const [name, s] of Object.entries(slotByName)) {
    const spec = s.key && materials[s.key];
    const emb = embedded[sanitize(name)];
    if (spec && spec.family === 'binary' && !spec.maps.map && emb && emb.map) {
      spec.maps.map = { tex: emb.map, s: [1, 1], o: [0, 0] };
      spec.note = 'material is stored in binary form; texture taken from the model';
    }
  }

  // --- what is actually rendered: every (mesh, sub-mesh) ---------------------------
  const rendered = [];
  for (const mesh of structure.meshes) {
    const names = mesh.materials.length ? mesh.materials : [null];
    names.forEach((name, i) => {
      const bound = bindings[mesh.name] && bindings[mesh.name][Math.min(i, bindings[mesh.name].length - 1)];
      if (bound) { rendered.push({ mesh: mesh.name, slot: name, source: bindingFrom[mesh.name] || 'prefab', material: bound }); return; }
      if (name === null) { rendered.push({ mesh: mesh.name, slot: null, source: 'default', material: 'default' }); return; }
      const s = slotByName[name];
      rendered.push({ mesh: mesh.name, slot: name, source: s.source, material: s.key });
    });
  }
  const fidelityOf = (r) => {
    if (r.source === 'missing' || !r.material) return 'missing';
    if (r.source === 'name') return 'approximate';
    if (r.material === 'embedded') return r.source === 'model-texture' || fileTexturesMissing || fileTexturesRenamed || !meta ? 'approximate' : 'exact';
    if (r.material === 'default') return 'exact';
    const spec = materials[r.material];
    return spec && spec.exact ? 'exact' : 'approximate';
  };
  for (const r of rendered) r.fidelity = fidelityOf(r);

  let fidelity;
  if (!structure.hasGeometry) fidelity = 'none';
  else if (!rendered.length) fidelity = structure.opaque ? 'approximate' : 'exact';
  else if (rendered.every((r) => r.fidelity === 'exact')) fidelity = 'exact';
  else if (rendered.every((r) => r.fidelity === 'missing')) fidelity = 'missing';
  else fidelity = 'approximate';

  if (!structure.hasGeometry) notes.push('no meshes in this file (animation or rig only)');
  if (structure.ok === false) notes.push(`could not read the model's structure: ${structure.error}`);
  if (rules.mode === 0) notes.push('the model imports no materials ("None"): Unity shows prefab materials or its default material');
  if (fileTexturesMissing) notes.push(`${fileTexturesMissing} texture file(s) referenced by the model are not in the package`);
  if (fileTexturesRenamed) notes.push(`${fileTexturesRenamed} texture file(s) referenced by the model were matched to differently named files`);
  for (const spec of Object.values(materials)) if (spec.note) notes.push(`${spec.name}: ${spec.note}`);

  // Per FBX material name (sanitized like three.js names them).
  const byName = {};
  for (const [name, s] of Object.entries(slotByName)) if (s.key) byName[sanitize(name)] = s.key;
  const meshBindings = Object.entries(bindings).map(([mesh, mats]) => ({ mesh, key: sanitize(mesh), materials: mats }));

  return {
    model: { guid, path: entryPath, format, scale: (meta && meta.scale) || 1, rig: (meta && meta.anim && meta.anim.type) || 0 },
    bindings: meshBindings,
    byName,
    fallback: rendered.some((r) => r.material === 'embedded') ? 'embedded' : 'default',
    materials,
    textures: ctx.textures,
    fileTextures,
    embedded,
    rendered,
    fidelity,
    counts: {
      exact: rendered.filter((r) => r.fidelity === 'exact').length,
      approximate: rendered.filter((r) => r.fidelity === 'approximate').length,
      missing: rendered.filter((r) => r.fidelity === 'missing').length,
    },
    notes: [...new Set(notes)],
  };
}

module.exports = {
  resolveModel, translateMaterial, modelStructure, meshNameFor, shaderInfo, sanitize, MODEL_EXT, TEXTURE_EXT,
};
