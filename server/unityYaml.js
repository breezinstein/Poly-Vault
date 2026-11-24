'use strict';
// Minimal parser for Unity's YAML dialect, plus compact extractors for the
// three kinds of text asset that link a model to its look:
//
//   .meta      importer settings: material remaps (externalObjects), sub-asset
//              name tables, material search rules, texture type / colour space
//   .mat       shader, texture slots (guid + tiling/offset), floats, colours
//   .prefab    GameObjects, transforms, MeshFilter/Renderer (mesh + materials),
//              nested PrefabInstances with their overrides, LOD groups
//
// Unity's serializer emits a small, regular subset of YAML: block mappings,
// block sequences written at the *same* indent as their key, flow mappings
// `{a: b, c: {d: e}}`, flow sequences `[]`, plain scalars that may wrap onto
// deeper-indented continuation lines, and documents introduced by
// `--- !u!<classId> &<fileID>` (optionally ` stripped`). This parser handles
// exactly that; it is not a general YAML implementation.

// ---------------------------------------------------------------------------
// Scalars and flow collections
// ---------------------------------------------------------------------------

function scalar(text) {
  const t = text.trim();
  if (t === '') return '';
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

function parseFlow(text, start = 0) {
  // Returns [value, nextIndex]. Handles nested {} and [] with plain scalars.
  let i = start;
  const skip = () => { while (i < text.length && text[i] === ' ') i += 1; };
  skip();
  if (text[i] === '{') {
    i += 1;
    const obj = {};
    for (;;) {
      skip();
      if (text[i] === '}') { i += 1; break; }
      if (i >= text.length) break;
      let k = i;
      while (k < text.length && text[k] !== ':' && text[k] !== '}' && text[k] !== ',') k += 1;
      const key = text.slice(i, k).trim();
      i = k;
      let value = '';
      if (text[i] === ':') {
        i += 1;
        skip();
        if (text[i] === '{' || text[i] === '[') {
          [value, i] = parseFlow(text, i);
        } else {
          let depth = 0;
          let k2 = i;
          while (k2 < text.length && !((text[k2] === ',' || text[k2] === '}') && depth === 0)) {
            if (text[k2] === '{' || text[k2] === '[') depth += 1;
            if (text[k2] === '}' || text[k2] === ']') depth -= 1;
            k2 += 1;
          }
          value = scalar(text.slice(i, k2));
          i = k2;
        }
      }
      if (key) obj[key] = value;
      skip();
      if (text[i] === ',') i += 1;
    }
    return [obj, i];
  }
  if (text[i] === '[') {
    i += 1;
    const arr = [];
    for (;;) {
      skip();
      if (text[i] === ']') { i += 1; break; }
      if (i >= text.length) break;
      if (text[i] === '{' || text[i] === '[') {
        let v;
        [v, i] = parseFlow(text, i);
        arr.push(v);
      } else {
        let k = i;
        while (k < text.length && text[k] !== ',' && text[k] !== ']') k += 1;
        arr.push(scalar(text.slice(i, k)));
        i = k;
      }
      skip();
      if (text[i] === ',') i += 1;
    }
    return [arr, i];
  }
  return [scalar(text.slice(i)), text.length];
}

function value(text) {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) return parseFlow(t)[0];
  return scalar(t);
}

// ---------------------------------------------------------------------------
// Block structure
// ---------------------------------------------------------------------------

function toLines(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    out.push({ indent, text: raw.trim() });
  }
  return out;
}

// "key: value" | "key:" -> [key, rest|null]; keys never contain ": ".
// Keys may carry an index, as in skinned meshes' `m_Skin` (`weight[0]: 1`).
function splitKey(text) {
  const m = /^((?:[^:{}[\]]|\[\d+\])+?):(?:\s+(.*))?$/.exec(text);
  if (!m) return null;
  return [m[1].trim(), m[2] === undefined ? null : m[2]];
}

function parseBlock(lines, i, indent) {
  if (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('-')) {
    return parseSeq(lines, i, indent);
  }
  return parseMap(lines, i, indent);
}

function parseMap(lines, i, indent) {
  const obj = {};
  // Unity 4/5 serialised maps as repeated `data:` keys; a repeated key becomes
  // an array of its values instead of overwriting.
  const dup = new Set();
  const set = (key, v) => {
    if (!(key in obj)) { obj[key] = v; return; }
    if (!dup.has(key)) { obj[key] = [obj[key]]; dup.add(key); }
    obj[key].push(v);
  };
  while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ') && lines[i].text !== '-') {
    const kv = splitKey(lines[i].text);
    if (!kv) { i += 1; continue; }
    const [key, rest] = kv;
    i += 1;
    if (rest !== null && rest !== '') {
      let text = rest;
      // Wrapped plain scalar: deeper lines that are not structure.
      const open = (text.match(/[{[]/g) || []).length - (text.match(/[}\]]/g) || []).length;
      let depth = open;
      while (i < lines.length && lines[i].indent > indent && (depth > 0 || (!splitKey(lines[i].text) && !lines[i].text.startsWith('- ')))) {
        text += ` ${lines[i].text}`;
        depth += (lines[i].text.match(/[{[]/g) || []).length - (lines[i].text.match(/[}\]]/g) || []).length;
        i += 1;
      }
      set(key, value(text));
      continue;
    }
    let v = '';
    if (i < lines.length && lines[i].indent > indent) {
      [v, i] = parseBlock(lines, i, lines[i].indent);
    } else if (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
      [v, i] = parseSeq(lines, i, indent);
    }
    set(key, v);
  }
  return [obj, i];
}

function parseSeq(lines, i, indent) {
  const arr = [];
  while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
    const item = lines[i].text === '-' ? '' : lines[i].text.slice(2);
    if (item === '') {
      i += 1;
      if (i < lines.length && lines[i].indent > indent) {
        let v;
        [v, i] = parseBlock(lines, i, lines[i].indent);
        arr.push(v);
      } else arr.push('');
      continue;
    }
    if (item.startsWith('{') || item.startsWith('[')) {
      arr.push(value(item));
      i += 1;
      continue;
    }
    if (splitKey(item)) {
      // "- key: ..." starts a mapping whose keys sit at indent + 2.
      const inner = indent + 2;
      lines[i] = { indent: inner, text: item };
      let v;
      [v, i] = parseMap(lines, i, inner);
      arr.push(v);
      continue;
    }
    arr.push(scalar(item));
    i += 1;
  }
  return [arr, i];
}

/** Parse a single-document YAML text (e.g. a .meta file) into an object. */
function parseYaml(text) {
  const lines = toLines(text).filter((l) => !l.text.startsWith('%') && !l.text.startsWith('---'));
  if (!lines.length) return {};
  return parseBlock(lines, 0, lines[0].indent)[0];
}

/**
 * Split a Unity asset into documents.
 * @returns {{classId:number, fileID:string, stripped:boolean, type:string, body:object}[]}
 */
function parseDocuments(text) {
  const docs = [];
  const re = /^--- !u!(\d+) &(-?\d+)( stripped)?\s*$/gm;
  const heads = [];
  let m;
  while ((m = re.exec(text))) heads.push({ classId: Number(m[1]), fileID: m[2], stripped: Boolean(m[3]), start: m.index, bodyStart: re.lastIndex });
  for (let k = 0; k < heads.length; k += 1) {
    const h = heads[k];
    const end = k + 1 < heads.length ? heads[k + 1].start : text.length;
    const lines = toLines(text.slice(h.bodyStart, end));
    if (!lines.length) continue;
    const [root] = parseMap(lines, 0, lines[0].indent);
    const type = Object.keys(root)[0] || '';
    docs.push({ classId: h.classId, fileID: h.fileID, stripped: h.stripped, type, body: root[type] || {} });
  }
  return docs;
}

// ---------------------------------------------------------------------------
// Compact extractors (what the graph stores)
// ---------------------------------------------------------------------------

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const isGuid = (g) => typeof g === 'string' && /^[0-9a-f]{32}$/.test(g) && !/^0+$/.test(g);
const ref = (r) => (r && typeof r === 'object' && (isGuid(r.guid) || (r.fileID && r.fileID !== '0'))
  ? { f: String(r.fileID || '0'), ...(isGuid(r.guid) ? { g: r.guid } : {}) }
  : null);
const vec = (v, keys) => (v && typeof v === 'object' ? keys.map((k) => num(v[k])) : null);

/**
 * .meta -> { imp, ext?, ids?, mat?, tex?, anim? }
 *   imp  importer name ("ModelImporter", "TextureImporter", ...)
 *   ext  [{type, name, g, f}]  explicit sub-asset remaps (materials mostly)
 *   ids  {fileID: name}        legacy / explicit sub-asset name tables
 *   mat  {mode, name, search, location, legacy}  material import rules
 *   tex  {type, srgb, alpha}   texture import type (1 = normal map)
 *   anim {type}                rig type (0 none, 1 legacy, 2 generic, 3 humanoid)
 */
function compactMeta(text) {
  const root = parseYaml(text);
  const imp = Object.keys(root).find((k) => k.endsWith('Importer')) || '';
  const body = (imp && root[imp]) || {};
  const out = { imp };
  const ext = [];
  for (const item of Array.isArray(body.externalObjects) ? body.externalObjects : []) {
    const first = item && item.first;
    const second = ref(item && item.second);
    if (first && second && second.g) ext.push({ type: String(first.type || ''), name: String(first.name || ''), g: second.g, f: second.f });
  }
  if (ext.length) out.ext = ext;

  const ids = {};
  if (Array.isArray(body.internalIDToNameTable)) {
    for (const item of body.internalIDToNameTable) {
      const first = item && item.first;
      if (!first || typeof first !== 'object') continue;
      for (const [cls, id] of Object.entries(first)) ids[String(id)] = { c: Number(cls), n: String(item.second || '') };
    }
  }
  if (body.fileIDToRecycleName && typeof body.fileIDToRecycleName === 'object') {
    for (const [id, name] of Object.entries(body.fileIDToRecycleName)) {
      ids[String(id)] = { c: Math.floor(Number(id) / 100000), n: String(name) };
    }
  }
  if (Object.keys(ids).length) out.ids = ids;

  if (imp === 'ModelImporter') {
    const mats = body.materials || {};
    out.mat = {
      mode: num(mats.materialImportMode, mats.importMaterials !== undefined ? num(mats.importMaterials) : 1),
      name: num(mats.materialName),
      search: num(mats.materialSearch, 1),
      location: num(mats.materialLocation, 0),
    };
    out.anim = { type: num(body.animationType, 0) };
    if (body.meshes && body.meshes.globalScale !== undefined) out.scale = num(body.meshes.globalScale, 1);
    // Unity 5 stores the file-unit scale it applied (e.g. 0.01 for cm).
    if (body.meshes && body.meshes.fileScale !== undefined && num(body.meshes.useFileScale, 1) !== 0) {
      out.fileScale = num(body.meshes.fileScale, 1);
    }
  }
  if (imp === 'TextureImporter') {
    const mip = body.mipmaps || {};
    out.tex = {
      type: num(body.textureType, 0),
      srgb: mip.sRGBTexture !== undefined ? num(mip.sRGBTexture, 1) : (num(body.linearTexture, 0) ? 0 : 1),
      alpha: num(body.alphaIsTransparency, 0),
    };
  }
  return out;
}

// Property lists come in three shapes:
//   5.6+   - _MainTex: {...}                        (sequence of one-key maps)
//   5.x    - first: {name: _MainTex}  second: {...} (sequence of pairs)
//   4.x    data: {first: {name}, second}  repeated  (map with duplicate keys)
function propEntries(list) {
  const out = [];
  let items = Array.isArray(list) ? list : [];
  if (list && !Array.isArray(list) && typeof list === 'object' && list.data) {
    items = Array.isArray(list.data) ? list.data : [list.data];
  }
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.first && typeof item.first === 'object' && 'name' in item.first) {
      out.push([String(item.first.name), item.second]);
    } else {
      for (const [k, v] of Object.entries(item)) out.push([k, v]);
    }
  }
  return out;
}

/**
 * .mat -> { n, sh, kw, tex, f, c, tags, q }
 *   sh   shader ref {f, g?}; tex {prop: {g, s:[x,y], o:[x,y]}} (bound slots only)
 */
function compactMaterial(text) {
  const doc = parseDocuments(text).find((d) => d.classId === 21);
  if (!doc) return null;
  const b = doc.body;
  const props = b.m_SavedProperties || {};
  const tex = {};
  for (const [name, v] of propEntries(props.m_TexEnvs)) {
    const r = ref(v && v.m_Texture);
    if (!r || !r.g) continue;
    tex[name] = { g: r.g, s: vec(v.m_Scale, ['x', 'y']) || [1, 1], o: vec(v.m_Offset, ['x', 'y']) || [0, 0] };
  }
  const f = {};
  for (const [name, v] of propEntries(props.m_Floats)) f[name] = num(v);
  for (const [name, v] of propEntries(props.m_Ints)) f[name] = num(v);
  const c = {};
  for (const [name, v] of propEntries(props.m_Colors)) {
    const col = vec(v, ['r', 'g', 'b', 'a']);
    if (col) c[name] = col;
  }
  const kw = [];
  if (Array.isArray(b.m_ValidKeywords)) kw.push(...b.m_ValidKeywords.map(String));
  if (typeof b.m_ShaderKeywords === 'string') kw.push(...b.m_ShaderKeywords.split(/\s+/).filter(Boolean));
  const out = { n: String(b.m_Name || ''), sh: ref(b.m_Shader), kw: [...new Set(kw)], tex, f, c };
  if (b.stringTagMap && typeof b.stringTagMap === 'object' && Object.keys(b.stringTagMap).length) out.tags = b.stringTagMap;
  if (b.m_CustomRenderQueue !== undefined && num(b.m_CustomRenderQueue, -1) !== -1) out.q = num(b.m_CustomRenderQueue);
  return out;
}

const KEEP_MOD = /^(m_LocalPosition|m_LocalRotation|m_LocalScale|m_Name|m_IsActive|m_Materials\.Array\.data\[\d+\]|m_Mesh|m_Enabled)/;

/**
 * .prefab -> { o: {fileID: object} } with only the classes that affect looks:
 *   1 GameObject {n, a, comps}; 4/224 Transform {go, p, r, s, fa, ch}
 *   33 MeshFilter {go, mesh}; 23 MeshRenderer / 137 SkinnedMeshRenderer {go, mats, mesh?, en}
 *   1001 PrefabInstance {src, pa, mods}; 205 LODGroup {go, lods:[[rendererIds]]}
 *   stripped objects {src, pi}: placeholders for objects of a nested prefab
 */
function compactPrefab(text) {
  const o = {};
  for (const d of parseDocuments(text)) {
    const b = d.body;
    if (d.stripped) {
      const src = ref(b.m_CorrespondingSourceObject);
      const pi = ref(b.m_PrefabInstance);
      o[d.fileID] = { c: d.classId, st: 1, ...(src ? { src } : {}), ...(pi ? { pi: pi.f } : {}) };
      continue;
    }
    const go = ref(b.m_GameObject);
    switch (d.classId) {
      case 1:
        o[d.fileID] = {
          c: 1,
          n: String(b.m_Name || ''),
          a: num(b.m_IsActive, 1),
          comps: (Array.isArray(b.m_Component) ? b.m_Component : [])
            .map((x) => ref(x && (x.component || Object.values(x)[0])))
            .filter(Boolean).map((r) => r.f),
        };
        break;
      case 4:
      case 224:
        o[d.fileID] = {
          c: d.classId,
          go: go && go.f,
          p: vec(b.m_LocalPosition, ['x', 'y', 'z']) || [0, 0, 0],
          r: vec(b.m_LocalRotation, ['x', 'y', 'z', 'w']) || [0, 0, 0, 1],
          s: vec(b.m_LocalScale, ['x', 'y', 'z']) || [1, 1, 1],
          fa: (ref(b.m_Father) || {}).f || '0',
          ch: (Array.isArray(b.m_Children) ? b.m_Children : []).map((x) => (ref(x) || {}).f).filter(Boolean),
        };
        break;
      case 33:
        o[d.fileID] = { c: 33, go: go && go.f, mesh: ref(b.m_Mesh) };
        break;
      case 23:
      case 137:
        o[d.fileID] = {
          c: d.classId,
          go: go && go.f,
          en: num(b.m_Enabled, 1),
          mats: (Array.isArray(b.m_Materials) ? b.m_Materials : []).map((x) => ref(x)),
          ...(d.classId === 137 ? { mesh: ref(b.m_Mesh) } : {}),
        };
        break;
      case 205:
        o[d.fileID] = {
          c: 205,
          go: go && go.f,
          lods: (Array.isArray(b.m_LODs) ? b.m_LODs : []).map((lod) => (Array.isArray(lod && lod.renderers) ? lod.renderers : [])
            .map((r) => (ref(r && r.renderer) || {}).f).filter(Boolean)),
        };
        break;
      case 1001: {
        const mod = b.m_Modification || {};
        const mods = [];
        for (const m of Array.isArray(mod.m_Modifications) ? mod.m_Modifications : []) {
          const prop = String((m && m.propertyPath) || '');
          if (!KEEP_MOD.test(prop)) continue;
          const t = ref(m.target);
          const objRef = ref(m.objectReference);
          mods.push({ t: t ? { f: t.f, ...(t.g ? { g: t.g } : {}) } : null, p: prop, v: String(m.value ?? ''), ...(objRef ? { r: objRef } : {}) });
        }
        o[d.fileID] = {
          c: 1001,
          src: ref(b.m_SourcePrefab),
          pa: (ref(mod.m_TransformParent) || {}).f || '0',
          mods,
          rm: (Array.isArray(mod.m_RemovedComponents) ? mod.m_RemovedComponents : []).map((x) => ref(x)).filter(Boolean),
        };
        break;
      }
      default:
        break;
    }
  }
  return { o };
}

module.exports = { parseYaml, parseDocuments, compactMeta, compactMaterial, compactPrefab, parseFlow, isGuid };
