'use strict';
// Unit tests for the link map: xxHash64 fileIDs, Unity YAML (all material
// formats, meta name tables, prefabs), the tar walker, package/folder graphs and
// one-pass multi-extraction. No framework, no network, no NAS:
//
//   node tests/unity-graph.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { xxh64, unityFileId } = require('../server/xxhash64');
const { compactMeta, compactMaterial, compactPrefab, parseYaml } = require('../server/unityYaml');
const { buildPackageGraph, buildFolderGraph, extractMany, fbxNodeNames, graphSummary } = require('../server/unityGraph');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// --- helpers -----------------------------------------------------------------

function tarHeader(name, size, type = '0') {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

function tarEntry(name, body, type = '0') {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  return Buffer.concat([tarHeader(name, data.length, type), data, pad]);
}

/** Unity order per GUID: asset, asset.meta, preview.png, pathname. */
function unityPackage(assets, extra = []) {
  const parts = [...extra];
  for (const a of assets) {
    if (a.asset !== undefined) parts.push(tarEntry(`${a.guid}/asset`, a.asset));
    if (a.meta !== undefined) parts.push(tarEntry(`${a.guid}/asset.meta`, a.meta));
    parts.push(tarEntry(`${a.guid}/pathname`, `${a.path}\n00`));
  }
  parts.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(parts));
}

const G = {
  fbx: 'a1000000000000000000000000000001',
  mat: 'a1000000000000000000000000000002',
  tex: 'a1000000000000000000000000000003',
  nrm: 'a1000000000000000000000000000004',
  prefab: 'a1000000000000000000000000000007',
  binmat: 'a1000000000000000000000000000005',
  nested: 'a1000000000000000000000000000006',
};

const FBX_META = `fileFormatVersion: 2
guid: ${G.fbx}
ModelImporter:
  serializedVersion: 22200
  internalIDToNameTable: []
  externalObjects:
  - first:
      type: UnityEngine:Material
      assembly: UnityEngine.CoreModule
      name: BladeMat
    second: {fileID: 2100000, guid: ${G.mat}, type: 2}
  materials:
    materialImportMode: 2
    materialName: 0
    materialSearch: 1
    materialLocation: 1
  animationType: 2
  meshes:
    globalScale: 1
`;

const URP_MAT = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!114 &-1684792018029768221
MonoBehaviour:
  m_ObjectHideFlags: 11
  version: 7
--- !u!21 &2100000
Material:
  serializedVersion: 8
  m_Name: BladeMat
  m_Shader: {fileID: 4800000, guid: 933532a4fcc9baf4fa0491de14d08ed7, type: 3}
  m_ValidKeywords:
  - _NORMALMAP
  m_InvalidKeywords: []
  m_CustomRenderQueue: -1
  stringTagMap:
    RenderType: Opaque
  m_SavedProperties:
    serializedVersion: 3
    m_TexEnvs:
    - _BaseMap:
        m_Texture: {fileID: 2800000, guid: ${G.tex}, type: 3}
        m_Scale: {x: 2, y: 3}
        m_Offset: {x: 0.5, y: 0}
    - _BumpMap:
        m_Texture: {fileID: 2800000, guid: ${G.nrm}, type: 3}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    - _EmissionMap:
        m_Texture: {fileID: 0}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    m_Ints: []
    m_Floats:
    - _Metallic: 0.25
    - _Smoothness: 0.75
    m_Colors:
    - _BaseColor: {r: 1, g: 0.5, b: 0.25, a: 1}
`;

const PREFAB = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &100
GameObject:
  m_Component:
  - component: {fileID: 400}
  - component: {fileID: 3300}
  - component: {fileID: 2300}
  m_Name: Blade.002
  m_IsActive: 1
--- !u!4 &400
Transform:
  m_GameObject: {fileID: 100}
  m_LocalRotation: {x: 0, y: -0, z: -0, w: 1}
  m_LocalPosition: {x: 1, y: 2, z: 3}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Children:
  - {fileID: 9001}
  m_Father: {fileID: 0}
--- !u!33 &3300
MeshFilter:
  m_GameObject: {fileID: 100}
  m_Mesh: {fileID: -690554794711785509, guid: ${G.fbx}, type: 3}
--- !u!23 &2300
MeshRenderer:
  m_GameObject: {fileID: 100}
  m_Enabled: 1
  m_Materials:
  - {fileID: 2100000, guid: ${G.mat}, type: 2}
  - {fileID: 0}
--- !u!1001 &7000
PrefabInstance:
  m_ObjectHideFlags: 0
  serializedVersion: 2
  m_Modification:
    serializedVersion: 3
    m_TransformParent: {fileID: 400}
    m_Modifications:
    - target: {fileID: 11, guid: ${G.nested}, type: 3}
      propertyPath: m_LocalPosition.x
      value: 4.5
      objectReference: {fileID: 0}
    - target: {fileID: 12, guid: ${G.nested}, type: 3}
      propertyPath: m_Materials.Array.data[0]
      value:
      objectReference: {fileID: 2100000, guid: ${G.mat}, type: 2}
    - target: {fileID: 13, guid: ${G.nested}, type: 3}
      propertyPath: m_CastShadows
      value: 0
      objectReference: {fileID: 0}
    m_RemovedComponents: []
  m_SourcePrefab: {fileID: 100100000, guid: ${G.nested}, type: 3}
--- !u!4 &9001 stripped
Transform:
  m_CorrespondingSourceObject: {fileID: 11, guid: ${G.nested}, type: 3}
  m_PrefabInstance: {fileID: 7000}
  m_PrefabAsset: {fileID: 0}
--- !u!205 &20500
LODGroup:
  m_GameObject: {fileID: 100}
  m_LODs:
  - screenRelativeHeight: 0.5
    renderers:
    - renderer: {fileID: 2300}
  - screenRelativeHeight: 0.1
    renderers: []
`;

// A binary FBX fragment: Unity names meshes after the Model node.
const FBX_BODY = Buffer.concat([
  Buffer.from('Kaydara FBX Binary  \0\x1a\0'),
  Buffer.from('Blade.001\0\x01Model'),
  Buffer.alloc(64, 7),
  Buffer.from('Blade.001\0\x01Geometry'),
]);

// --- tests -------------------------------------------------------------------

test('xxHash64 reference vectors', () => {
  assert.strictEqual(xxh64('').toString(16), 'ef46db3751d8e999');
  assert.strictEqual(xxh64('abc').toString(16), '44bc2cf5ad770999');
  assert.strictEqual(xxh64('Nobody inspects the spammish repetition').toString(16), 'fbcea83c8a378bf1');
});

test('Unity mesh fileID from type and name (xxHash64)', () => {
  // regression vector; the scheme was checked against real prefab references
  assert.strictEqual(unityFileId('Mesh', 'Blade.001', 0), '-690554794711785509');
  assert.strictEqual(unityFileId('Mesh', 'Poleaxe.004', 0), '1168451493278543444');
});

test('meta: material remaps, rules, rig type', () => {
  const m = compactMeta(FBX_META);
  assert.strictEqual(m.imp, 'ModelImporter');
  assert.deepStrictEqual(m.ext, [{ type: 'UnityEngine:Material', name: 'BladeMat', g: G.mat, f: '2100000' }]);
  assert.deepStrictEqual(m.mat, { mode: 2, name: 0, search: 1, location: 1 });
  assert.strictEqual(m.anim.type, 2);
});

test('meta: legacy fileIDToRecycleName and internalIDToNameTable', () => {
  const legacy = compactMeta(`guid: x\nModelImporter:\n  fileIDToRecycleName:\n    100000: //RootNode\n    4300000: Crate\n    4300002: Lid\n  materials:\n    importMaterials: 1\n    materialName: 1\n    materialSearch: 2\n`);
  assert.deepStrictEqual(legacy.ids['4300002'], { c: 43, n: 'Lid' });
  assert.strictEqual(legacy.mat.name, 1);
  assert.strictEqual(legacy.mat.search, 2);
  const table = compactMeta(`guid: x\nModelImporter:\n  internalIDToNameTable:\n  - first:\n      43: -6219848395766016546\n    second: Body\n  - first:\n      74: 1827226128182048838\n    second: Take 001\n`);
  assert.deepStrictEqual(table.ids['-6219848395766016546'], { c: 43, n: 'Body' });
  assert.deepStrictEqual(table.ids['1827226128182048838'], { c: 74, n: 'Take 001' });
});

test('meta: texture importer (normal map, colour space)', () => {
  const t = compactMeta(`guid: x\nTextureImporter:\n  mipmaps:\n    sRGBTexture: 0\n  textureType: 1\n  alphaIsTransparency: 1\n`);
  assert.deepStrictEqual(t.tex, { type: 1, srgb: 0, alpha: 1 });
  const old = compactMeta(`guid: x\nTextureImporter:\n  linearTexture: 1\n  textureType: 0\n`);
  assert.strictEqual(old.tex.srgb, 0);
});

test('material: 5.6+ format (URP), bound slots only', () => {
  const m = compactMaterial(URP_MAT);
  assert.strictEqual(m.n, 'BladeMat');
  assert.deepStrictEqual(m.sh, { f: '4800000', g: '933532a4fcc9baf4fa0491de14d08ed7' });
  assert.deepStrictEqual(Object.keys(m.tex).sort(), ['_BaseMap', '_BumpMap']);
  assert.deepStrictEqual(m.tex._BaseMap, { g: G.tex, s: [2, 3], o: [0.5, 0] });
  assert.strictEqual(m.f._Smoothness, 0.75);
  assert.deepStrictEqual(m.c._BaseColor, [1, 0.5, 0.25, 1]);
  assert.deepStrictEqual(m.kw, ['_NORMALMAP']);
  assert.deepStrictEqual(m.tags, { RenderType: 'Opaque' });
});

test('material: 5.x pair format and 4.x repeated data: keys', () => {
  const v5 = compactMaterial(`--- !u!21 &2100000\nMaterial:\n  m_Name: A\n  m_Shader: {fileID: 46, guid: 0000000000000000f000000000000000, type: 0}\n  m_ShaderKeywords: _NORMALMAP _EMISSION\n  m_SavedProperties:\n    m_TexEnvs:\n    - first:\n        name: _MainTex\n      second:\n        m_Texture: {fileID: 2800000, guid: ${G.tex}, type: 3}\n        m_Scale: {x: 1, y: 1}\n        m_Offset: {x: 0, y: 0}\n    m_Floats:\n    - first:\n        name: _Glossiness\n      second: 0.25\n`);
  assert.strictEqual(v5.tex._MainTex.g, G.tex);
  assert.strictEqual(v5.f._Glossiness, 0.25);
  assert.deepStrictEqual(v5.kw, ['_NORMALMAP', '_EMISSION']);
  const v4 = compactMaterial(`--- !u!21 &2100000\nMaterial:\n  m_Name: B\n  m_Shader: {fileID: 10703, guid: 0000000000000000f000000000000000, type: 0}\n  m_SavedProperties:\n    m_TexEnvs:\n      data:\n        first:\n          name: _MainTex\n        second:\n          m_Texture: {fileID: 2800000, guid: ${G.tex}, type: 3}\n          m_Scale: {x: 2, y: 1}\n          m_Offset: {x: 0, y: 0}\n      data:\n        first:\n          name: _BumpMap\n        second:\n          m_Texture: {fileID: 2800000, guid: ${G.nrm}, type: 3}\n          m_Scale: {x: 1, y: 1}\n          m_Offset: {x: 0, y: 0}\n    m_Floats: {}\n    m_Colors:\n      data:\n        first:\n          name: _Color\n        second: {r: 0, g: 0, b: 0, a: 1}\n`);
  assert.deepStrictEqual(Object.keys(v4.tex), ['_MainTex', '_BumpMap']);
  assert.deepStrictEqual(v4.tex._MainTex.s, [2, 1]);
  assert.deepStrictEqual(v4.c._Color, [0, 0, 0, 1]);
});

test('prefab: renderers, transforms, nested instance overrides, stripped, LODs', () => {
  const { o } = compactPrefab(PREFAB);
  assert.strictEqual(o['100'].n, 'Blade.002');
  assert.deepStrictEqual(o['100'].comps, ['400', '3300', '2300']);
  assert.deepStrictEqual(o['400'].p, [1, 2, 3]);
  assert.deepStrictEqual(o['400'].ch, ['9001']);
  assert.deepStrictEqual(o['3300'].mesh, { f: '-690554794711785509', g: G.fbx });
  assert.deepStrictEqual(o['2300'].mats, [{ f: '2100000', g: G.mat }, null]);
  assert.strictEqual(o['7000'].c, 1001);
  assert.strictEqual(o['7000'].pa, '400');
  assert.deepStrictEqual(o['7000'].src, { f: '100100000', g: G.nested });
  // m_CastShadows is irrelevant to looks and dropped; position + material kept
  assert.deepStrictEqual(o['7000'].mods.map((m) => m.p), ['m_LocalPosition.x', 'm_Materials.Array.data[0]']);
  assert.deepStrictEqual(o['7000'].mods[1].r, { f: '2100000', g: G.mat });
  assert.deepStrictEqual(o['9001'], { c: 4, st: 1, src: { f: '11', g: G.nested }, pi: '7000' });
  assert.deepStrictEqual(o['20500'].lods, [['2300'], []]);
});

test('yaml: flow values, wrapped scalars, empty values', () => {
  const y = parseYaml('a: {x: 1, y: {z: 2}}\nb: [1, 2]\nc:\nd: long text\n  continues here\ne: []\n');
  assert.deepStrictEqual(y.a, { x: '1', y: { z: '2' } });
  assert.deepStrictEqual(y.b, ['1', '2']);
  assert.strictEqual(y.c, '');
  assert.strictEqual(y.d, 'long text continues here');
  assert.deepStrictEqual(y.e, []);
});

test('fbx node names (binary and ASCII)', () => {
  assert.deepStrictEqual(fbxNodeNames(FBX_BODY), { model: ['Blade.001'], geometry: ['Blade.001'] });
  const ascii = fbxNodeNames(Buffer.from('Model: 1, "Model::Crate", "Mesh" {\n Geometry: 2, "Geometry::CrateGeo", "Mesh"'));
  assert.deepStrictEqual(ascii, { model: ['Crate'], geometry: ['CrateGeo'] });
});

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-graph-'));
const pkg = path.join(work, 'Kit.unitypackage');
fs.writeFileSync(pkg, unityPackage([
  { guid: G.fbx, path: 'Assets/Kit/Mesh/Blade.001.fbx', asset: FBX_BODY, meta: FBX_META },
  { guid: G.mat, path: 'Assets/Kit/Material/BladeMat.mat', asset: URP_MAT, meta: `guid: ${G.mat}\nNativeFormatImporter:\n  mainObjectFileID: 2100000\n` },
  { guid: G.tex, path: 'Assets/Kit/Texture/Albedo.png', asset: Buffer.alloc(3000, 1), meta: `guid: ${G.tex}\nTextureImporter:\n  textureType: 0\n` },
  { guid: G.nrm, path: 'Assets/Kit/Texture/Normal.tga', asset: Buffer.alloc(5000, 2), meta: `guid: ${G.nrm}\nTextureImporter:\n  textureType: 1\n  mipmaps:\n    sRGBTexture: 0\n` },
  { guid: G.prefab, path: 'Assets/Kit/Prefab/Blade.002.prefab', asset: PREFAB, meta: `guid: ${G.prefab}\nPrefabImporter:\n  externalObjects: {}\n` },
  { guid: G.binmat, path: 'Assets/Kit/Material/Old.mat', asset: Buffer.from([0, 0, 0, 0x73, 0x12, 0xff, 0x01]) },
  { guid: 'ffffffffffffffffffffffffffffffff', path: 'Assets/Kit/Mesh' },
], [tarEntry('pax_global_header', 'comment=ignored\n'.repeat(40), 'g')]));

test('package graph: one pass, paths, metas, materials, prefabs, binary', async () => {
  const g = await buildPackageGraph(pkg);
  assert.strictEqual(g.complete, true);
  assert.strictEqual(g.paths[G.fbx], 'Assets/Kit/Mesh/Blade.001.fbx');
  assert.ok(!('ffffffffffffffffffffffffffffffff' in g.paths), 'folders are not assets');
  assert.strictEqual(g.metas[G.fbx].ext[0].g, G.mat);
  assert.strictEqual(g.metas[G.nrm].tex.type, 1);
  assert.strictEqual(g.mats[G.mat].tex._BaseMap.g, G.tex);
  assert.deepStrictEqual(g.mats[G.binmat], { n: 'Old', bin: 1 });
  assert.strictEqual(g.prefabs[G.prefab].o['3300'].mesh.g, G.fbx);
  const s = graphSummary(g);
  assert.deepStrictEqual(s.counts, { assets: 6, models: 1, textures: 2, materials: 2, prefabs: 1, scenes: 0, remaps: 1 });
});

test('extractMany: several assets in one pass, atomic writes', async () => {
  const out = path.join(work, 'out');
  const r = await extractMany(pkg, [
    { guid: G.fbx, outPath: path.join(out, 'fbx') },
    { guid: G.nrm, outPath: path.join(out, 'nrm') },
    { guid: '00000000000000000000000000000001', outPath: path.join(out, 'missing') },
    { guid: G.tex, outPath: path.join(out, 'tex'), maxBytes: 100 },
  ]);
  assert.deepStrictEqual(r.results[G.fbx], { ok: true, size: FBX_BODY.length });
  assert.ok(fs.readFileSync(path.join(out, 'fbx')).equals(FBX_BODY));
  assert.strictEqual(fs.statSync(path.join(out, 'nrm')).size, 5000);
  assert.strictEqual(r.results['00000000000000000000000000000001'].ok, false);
  assert.strictEqual(r.results[G.tex].ok, false, 'over the limit is refused');
  assert.ok(!fs.existsSync(path.join(out, 'tex')), 'no partial file left behind');
  assert.deepStrictEqual(fs.readdirSync(out).sort(), ['fbx', 'nrm']);
});

test('package graph: truncated archive is reported, not thrown', async () => {
  const cut = path.join(work, 'Cut.unitypackage');
  const full = zlib.gunzipSync(fs.readFileSync(pkg));
  fs.writeFileSync(cut, zlib.gzipSync(full.subarray(0, 3000)));
  const g = await buildPackageGraph(cut);
  assert.strictEqual(g.complete, false);
  assert.ok(g.truncated);
});

test('folder graph: loose Unity folder with .meta files', () => {
  const dir = path.join(work, 'Loose');
  fs.mkdirSync(path.join(dir, 'Models'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Materials'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Models', 'Blade.001.fbx'), FBX_BODY);
  fs.writeFileSync(path.join(dir, 'Models', 'Blade.001.fbx.meta'), FBX_META);
  fs.writeFileSync(path.join(dir, 'Materials', 'BladeMat.mat'), URP_MAT);
  fs.writeFileSync(path.join(dir, 'Materials', 'BladeMat.mat.meta'), `fileFormatVersion: 2\nguid: ${G.mat}\nNativeFormatImporter:\n`);
  fs.writeFileSync(path.join(dir, 'Materials.meta'), `fileFormatVersion: 2\nguid: eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\nfolderAsset: yes\n`);
  const g = buildFolderGraph(dir);
  assert.strictEqual(g.paths[G.fbx], 'Models/Blade.001.fbx');
  assert.strictEqual(g.mats[G.mat].n, 'BladeMat');
  assert.strictEqual(g.metas[G.fbx].ext[0].name, 'BladeMat');
  assert.ok(!('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' in g.paths));
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  PASS ${t.name}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL ${t.name}\n       ${String(err && err.stack || err).split('\n').slice(0, 4).join('\n       ')}`);
    }
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\nunity-graph: passed ${passed}, failed ${failed}`);
  process.exit(failed ? 1 : 0);
})();
