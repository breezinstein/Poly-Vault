'use strict';
// Unit tests for mesh sources beyond FBX/OBJ: Unity mesh assets (.asset ->
// GLB), Collada (.dae) structure, prefabs that use them, materials embedded
// in other model files, and UV orientation of converted GLBs.
//
//   node tests/mesh-formats.test.js

const assert = require('assert');

const { convertMeshAsset, meshAssetStructure, half } = require('../server/unityMesh');
const { scanCollada } = require('../server/colladaScan');
const { modelStructure } = require('../server/modelResolver');
const { resolvePrefab } = require('../server/prefabResolver');
const { convertFbx6 } = require('../server/fbx6');
const { unityFileId } = require('../server/xxhash64');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const g = (n) => n.toString(16).padStart(32, '0');
const URP = '933532a4fcc9baf4fa0491de14d08ed7';

// --- helpers -----------------------------------------------------------------------

const f32 = (...v) => { const b = Buffer.alloc(v.length * 4); v.forEach((x, i) => b.writeFloatLE(x, i * 4)); return b; };
const u16 = (...v) => { const b = Buffer.alloc(v.length * 2); v.forEach((x, i) => b.writeUInt16LE(x, i * 2)); return b; };
const u32 = (...v) => { const b = Buffer.alloc(v.length * 4); v.forEach((x, i) => b.writeUInt32LE(x, i * 4)); return b; };
const f16 = (x) => { // exact for the halves used here (0, 0.5, 1)
  if (x === 0) return 0;
  const e = Math.floor(Math.log2(Math.abs(x)));
  return (x < 0 ? 0x8000 : 0) | ((e + 15) << 10) | Math.round((Math.abs(x) / 2 ** e - 1) * 1024);
};

function channelsYaml(list) {
  return list.map(([stream, offset, format, dimension]) => `    - stream: ${stream}\n      offset: ${offset}\n      format: ${format}\n      dimension: ${dimension}`).join('\n');
}

function meshYaml({ name = 'Quad', fileID = '4300000', submeshes, indexFormat = 0, indexHex, vertexCount, channels, dataHex, compression = 0 }) {
  const subs = submeshes.map((s) => `  - serializedVersion: 2\n    firstByte: ${s.firstByte}\n    indexCount: ${s.indexCount}\n    topology: ${s.topology || 0}\n    baseVertex: ${s.baseVertex || 0}\n    firstVertex: 0\n    vertexCount: ${vertexCount}`).join('\n');
  return `--- !u!43 &${fileID}
Mesh:
  m_ObjectHideFlags: 0
  m_Name: ${name}
  serializedVersion: 9
  m_SubMeshes:
${subs}
  m_MeshCompression: ${compression}
  m_IndexFormat: ${indexFormat}
  m_IndexBuffer: ${indexHex}
  m_VertexData:
    serializedVersion: 2
    m_VertexCount: ${vertexCount}
    m_Channels:
${channelsYaml(channels)}
    m_DataSize: ${dataHex.length / 2}
    _typelessdata: ${dataHex}
`;
}
const asset = (...docs) => Buffer.from(`%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n${docs.join('')}`);

function readGlb(glb) {
  assert.strictEqual(glb.readUInt32LE(0), 0x46546c67, 'glTF magic');
  assert.strictEqual(glb.readUInt32LE(8), glb.length, 'declared length');
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString());
  const bin = glb.subarray(20 + jsonLen + 8);
  const read = (accIdx) => {
    const acc = json.accessors[accIdx];
    const view = json.bufferViews[acc.bufferView];
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3 }[acc.type];
    const n = acc.count * comps;
    const out = [];
    for (let i = 0; i < n; i += 1) out.push(acc.componentType === 5125 ? bin.readUInt32LE(view.byteOffset + i * 4) : bin.readFloatLE(view.byteOffset + i * 4));
    return out;
  };
  return { json, read };
}

// A unit quad in the XY plane, facing -Z in Unity (towards a default camera).
const QUAD_POS = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
const QUAD_UV = [[0, 0], [1, 0], [1, 1], [0, 1]];

// Unity 2019+: 14 channels, everything in stream 0: pos(3f) nrm(3f) uv0(2f) = 32 bytes.
function modernQuad(extra = {}) {
  const data = Buffer.concat(QUAD_POS.map((p, i) => Buffer.concat([f32(...p), f32(0, 0, -1), f32(...QUAD_UV[i])])));
  const ch = Array.from({ length: 14 }, () => [0, 0, 0, 0]);
  ch[0] = [0, 0, 0, 3]; ch[1] = [0, 12, 0, 3]; ch[4] = [0, 24, 0, 2];
  return meshYaml({
    vertexCount: 4,
    channels: ch,
    dataHex: data.toString('hex'),
    indexHex: u16(0, 1, 2, 0, 2, 3).toString('hex'),
    submeshes: [{ firstByte: 0, indexCount: 3 }, { firstByte: 6, indexCount: 3 }],
    ...extra,
  });
}

// --- Unity mesh assets ---------------------------------------------------------------

test('mesh asset (Unity 2019+): two submeshes -> two primitives, X mirrored, winding kept outward', () => {
  const buf = asset(modernQuad());
  const s = meshAssetStructure(buf);
  assert.strictEqual(s.ok, true);
  assert.deepStrictEqual(s.fileIds, { 4300000: 'Quad' });
  assert.deepStrictEqual(s.meshes[0].materials.length, 2);
  assert.deepStrictEqual(modelStructure(buf, 'asset').fileIds, { 4300000: 'Quad' }, 'modelStructure routes .asset');

  const { glb, triangles, meshes } = convertMeshAsset(buf);
  assert.strictEqual(meshes, 1);
  assert.strictEqual(triangles, 2);
  const { json, read } = readGlb(glb);
  assert.strictEqual(json.meshes[0].name, 'Quad');
  assert.strictEqual(json.nodes[0].name, 'Quad');
  const [p0, p1] = json.meshes[0].primitives;
  assert.strictEqual(p0.attributes.POSITION, p1.attributes.POSITION, 'submeshes share the vertex buffer');
  const pos = read(p0.attributes.POSITION);
  assert.deepStrictEqual(pos.slice(0, 6), [-0, 0, 0, -1, 0, 0], 'X mirrored');
  assert.deepStrictEqual(json.accessors[p0.attributes.POSITION].min, [-1, 0, 0]);
  assert.deepStrictEqual(read(p0.attributes.NORMAL).slice(0, 3), [-0, 0, -1]);
  assert.deepStrictEqual(read(p0.attributes.TEXCOORD_0).slice(0, 8), [0, 0, 1, 0, 1, 1, 0, 1], 'UVs unchanged (OpenGL V)');
  assert.deepStrictEqual(read(p0.indices), [0, 2, 1], 'winding swapped with the mirror');
  assert.deepStrictEqual(read(p1.indices), [0, 3, 2]);
});

test('mesh asset (Unity 5-2018): 8 channels, second stream aligned to 16, half UVs, 32-bit quads', () => {
  // stream 0: pos(3f) = 12 bytes x 4 = 48 (already 16-aligned); stream 1: uv0 as 2 halves = 4 bytes.
  const s0 = Buffer.concat(QUAD_POS.map((p) => f32(...p)));
  const s1 = Buffer.concat(QUAD_UV.map(([u, v]) => u16(f16(u), f16(v))));
  const ch = Array.from({ length: 8 }, () => [0, 0, 0, 0]);
  ch[0] = [0, 0, 0, 3]; ch[3] = [1, 0, 1, 2];
  const yaml = meshYaml({
    name: 'OldQuad', vertexCount: 4, channels: ch, dataHex: Buffer.concat([s0, s1]).toString('hex'),
    indexFormat: 1, indexHex: u32(0, 1, 2, 3).toString('hex'), submeshes: [{ firstByte: 0, indexCount: 4, topology: 2 }],
  });
  const { glb, triangles } = convertMeshAsset(asset(yaml));
  assert.strictEqual(triangles, 2, 'quad topology triangulated');
  const { json, read } = readGlb(glb);
  const prim = json.meshes[0].primitives[0];
  assert.strictEqual(prim.attributes.NORMAL, undefined, 'no normal channel -> none written');
  assert.deepStrictEqual(read(prim.attributes.TEXCOORD_0), [0, 0, 1, 0, 1, 1, 0, 1]);
  assert.deepStrictEqual(read(prim.indices), [0, 2, 1, 0, 3, 2]);
  assert.strictEqual(half(0x3c00), 1);
  assert.strictEqual(half(0x3800), 0.5);
});

test('mesh asset: several meshes in one file, each addressed by fileID', () => {
  const buf = asset(modernQuad({ name: 'A', fileID: '4300000' }), modernQuad({ name: 'B', fileID: '-123456789' }));
  assert.deepStrictEqual(meshAssetStructure(buf).fileIds, { 4300000: 'A', '-123456789': 'B' });
  assert.strictEqual(convertMeshAsset(buf).meshes, 2);
});

test('mesh asset: compressed, binary and non-mesh assets give readable reasons', () => {
  const compressed = meshYaml({ vertexCount: 0, channels: [], dataHex: '', indexHex: '', submeshes: [], compression: 2 });
  assert.throws(() => convertMeshAsset(asset(compressed)), /mesh compression/);
  const bin = meshAssetStructure(Buffer.from([0, 0, 0, 0x10, 1, 2, 3]));
  assert.strictEqual(bin.ok, false);
  assert.match(bin.error, /binary/);
  const so = meshAssetStructure(asset('--- !u!114 &11400000\nMonoBehaviour:\n  m_Name: Settings\n'));
  assert.strictEqual(so.ok, false);
});

// --- prefabs -------------------------------------------------------------------------

function prefabUsing(meshRef, matRef, extraPaths = {}, extra = {}) {
  return {
    paths: { [g(1)]: 'Assets/P/Bench.prefab', ...extraPaths },
    metas: {},
    mats: {},
    scenes: {},
    prefabs: { [g(1)]: { o: {
      1: { c: 1, n: 'Bench', a: 1, comps: [] },
      4: { c: 4, go: '1', p: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1], fa: '0', ch: [] },
      33: { c: 33, go: '1', mesh: meshRef },
      23: { c: 23, go: '1', en: 1, mats: [matRef] },
    } } },
    ...extra,
  };
}

test('prefab: MeshFilter on a Unity mesh asset resolves by fileID, scale 1', () => {
  const gr = prefabUsing({ f: '4300000', g: g(2) }, { f: '2100000', g: g(3) }, { [g(2)]: 'Assets/P/Meshes/Bench.asset', [g(3)]: 'Assets/P/Concrete.mat' }, {
    mats: { [g(3)]: { n: 'Concrete', sh: { f: '4800000', g: URP }, kw: [], tex: {}, f: {}, c: { _BaseColor: [0.5, 0.5, 0.5, 1] } } },
  });
  const st = meshAssetStructure(asset(modernQuad({ name: 'Bench' })));
  const m = resolvePrefab(gr, 'Assets/P/Bench.prefab', (x) => (x === g(2) ? st : null));
  const node = m.nodes.find((n) => n.mesh);
  assert.deepStrictEqual(node.mesh, { model: g(2), name: 'Bench', key: 'Bench', materials: [g(3)], skinned: false });
  assert.strictEqual(m.models[g(2)].format, 'asset');
  assert.strictEqual(m.models[g(2)].fileScale, 1);
  assert.strictEqual(m.fidelity, 'exact');
});

test('prefab: unreadable mesh asset is named in the notes, not "not in this package"', () => {
  const gr = prefabUsing({ f: '4300000', g: g(2) }, null, { [g(2)]: 'Assets/P/Meshes/Bench.asset' });
  const m = resolvePrefab(gr, 'Assets/P/Bench.prefab', () => meshAssetStructure(Buffer.from([1, 2, 3])));
  assert.strictEqual(m.fidelity, 'missing');
  assert.ok(m.notes.some((n) => /^Bench\.asset: stored in binary form/.test(n)), m.notes.join(' | '));
  assert.ok(!m.notes.some((n) => /not in this package/.test(n)), m.notes.join(' | '));
});

test('prefab: material embedded in another FBX, found by its hashed fileID, keeps its texture', () => {
  const lod0 = g(5);
  const tga = g(6);
  const gr = prefabUsing(
    { f: unityFileId('Mesh', 'Mesh', 0), g: g(4) },
    { f: unityFileId('Material', 'M_Critter', 0), g: lod0 },
    { [g(4)]: 'Assets/Pets/Models/Critter_LOD3.fbx', [lod0]: 'Assets/Pets/Models/Critter_LOD0.fbx', [tga]: 'Assets/Pets/Textures/T_Critter.png' },
    { metas: { [lod0]: { imp: 'ModelImporter', mat: { mode: 1, name: 0, search: 1, location: 1 } }, [g(4)]: { imp: 'ModelImporter', mat: { mode: 1, name: 0, search: 1, location: 1 } } } },
  );
  const lod3 = { ok: true, meshes: [{ name: 'Mesh', materials: ['M_Critter'] }], materials: [{ name: 'M_Critter', diffuse: 'T_Critter.png', normal: null }], textures: ['T_Critter.png'], models: ['Mesh'], hasGeometry: true };
  const m = resolvePrefab(gr, 'Assets/P/Bench.prefab', (x) => (x === g(4) ? lod3 : null));
  const node = m.nodes.find((n) => n.mesh);
  const key = node.mesh.materials[0];
  assert.ok(key && key.startsWith(`model:${lod0}:`), String(key));
  const spec = m.materials[key];
  assert.strictEqual(spec.name, 'M_Critter');
  assert.ok(spec.maps.map && m.textures[spec.maps.map.tex], 'diffuse texture resolved');
  assert.strictEqual(m.textures[spec.maps.map.tex].guid, tga);
  assert.strictEqual(m.fidelity, 'exact');
});

test('prefab: materials that are not in the package are explained', () => {
  const gr = prefabUsing({ f: '4300000', g: g(2) }, { f: '2100000', g: g(9) }, { [g(2)]: 'Assets/P/Meshes/Bench.asset' });
  const st = meshAssetStructure(asset(modernQuad({ name: 'Bench' })));
  const m = resolvePrefab(gr, 'Assets/P/Bench.prefab', () => st);
  assert.ok(m.notes.includes('1 material(s) used here are not in this package'), m.notes.join(' | '));
});

// --- Collada ---------------------------------------------------------------------------

const DAE = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><unit name="centimeter" meter="0.01"/><up_axis>Z_UP</up_axis></asset>
  <library_images>
    <image id="bark_png" name="bark_png"><init_from>textures/Bark%20Diffuse.png</init_from></image>
    <image id="leaf_png"><init_from>file:///C:/art/leaf.tga</init_from></image>
    <image id="bump_png"><init_from>bark_n.png</init_from></image>
  </library_images>
  <library_effects>
    <effect id="Bark-effect"><profile_COMMON>
      <newparam sid="bark-surface"><surface type="2D"><init_from>bark_png</init_from></surface></newparam>
      <newparam sid="bark-sampler"><sampler2D><source>bark-surface</source></sampler2D></newparam>
      <technique sid="common"><lambert><diffuse><texture texture="bark-sampler" texcoord="UVMap"/></diffuse></lambert>
        <extra><technique profile="FCOLLADA"><bump><texture texture="bump_png" texcoord="UVMap"/></bump></technique></extra>
      </technique></profile_COMMON></effect>
    <effect id="Leaf-effect"><profile_COMMON><technique sid="common"><phong><diffuse><texture texture="leaf_png" texcoord="UV"/></diffuse></phong></technique></profile_COMMON></effect>
  </library_effects>
  <library_materials>
    <material id="Bark-material" name="Bark"><instance_effect url="#Bark-effect"/></material>
    <material id="Leaf-material"><instance_effect url="#Leaf-effect"/></material>
  </library_materials>
  <library_geometries>
    <geometry id="Tree-mesh" name="Tree"><mesh>
      <source id="p"/><vertices id="v"/>
      <triangles material="Bark-material" count="1"/>
      <polylist material="Leaf-material" count="1"/>
    </mesh></geometry>
    <geometry id="Bush-mesh"><mesh><triangles material="leafsym" count="1"/></mesh></geometry>
  </library_geometries>
  <library_controllers>
    <controller id="Bush-skin"><skin source="#Bush-mesh"/></controller>
  </library_controllers>
  <library_visual_scenes>
    <visual_scene id="Scene">
      <node id="Tree" name="Tree_01" type="NODE">
        <instance_geometry url="#Tree-mesh"><bind_material><technique_common>
          <instance_material symbol="Bark-material" target="#Bark-material"/>
          <instance_material symbol="Leaf-material" target="#Leaf-material"/>
        </technique_common></bind_material></instance_geometry>
        <node id="Bush" name="Bush">
          <instance_controller url="#Bush-skin"><bind_material><technique_common>
            <instance_material symbol="leafsym" target="#Leaf-material"/>
          </technique_common></bind_material></instance_controller>
        </node>
      </node>
    </visual_scene>
  </library_visual_scenes>
  <scene><instance_visual_scene url="#Scene"/></scene>
</COLLADA>`;

test('Collada: meshes per node, materials in primitive order, sampler -> surface -> image chain', () => {
  const s = scanCollada(Buffer.from(DAE));
  assert.strictEqual(s.ok, true, s.error);
  assert.deepStrictEqual(s.meshes, [{ name: 'Tree_01', materials: ['Bark', 'Leaf-material'] }, { name: 'Bush', materials: ['Leaf-material'] }]);
  assert.deepStrictEqual(s.materials, [
    { name: 'Bark', diffuse: 'Bark Diffuse.png', normal: 'bark_n.png' },
    { name: 'Leaf-material', diffuse: 'leaf.tga', normal: null },
  ]);
  assert.deepStrictEqual(s.textures.sort(), ['Bark Diffuse.png', 'bark_n.png', 'leaf.tga']);
  assert.strictEqual(s.unitScale, 1, 'centimetres -> Unity file scale 0.01');
  assert.strictEqual(s.upAxis, 'Z_UP');
  assert.strictEqual(modelStructure(Buffer.from(DAE), 'dae').meshes.length, 2, 'modelStructure routes .dae');
});

test('Collada: prefab mesh by legacy fileID binds to the first node mesh', () => {
  const gr = prefabUsing({ f: '4300000', g: g(2) }, null, { [g(2)]: 'Assets/T/Tree.dae' });
  const m = resolvePrefab(gr, 'Assets/P/Bench.prefab', () => scanCollada(Buffer.from(DAE)));
  assert.strictEqual(m.nodes.find((n) => n.mesh).mesh.name, 'Tree_01');
  assert.strictEqual(m.models[g(2)].fileScale, 0.01);
});

test('Collada: broken XML gives a reason, not an exception', () => {
  const s = scanCollada(Buffer.from('<html><body>nope</body></html>'));
  assert.strictEqual(s.ok, false);
  assert.match(s.error, /not a Collada/);
});

// --- UV orientation ------------------------------------------------------------------

test('FBX 6 -> GLB keeps OpenGL V (viewer textures use flipY)', () => {
  const fbx = `; FBX 6.1.0 project file
FBXHeaderExtension:  {
\tFBXVersion: 6100
}
Objects:  {
\tModel: "Model::Tri", "Mesh" {
\t\tVertices: 0,0,0,1,0,0,1,1,0
\t\tPolygonVertexIndex: 0,1,-3
\t\tLayerElementUV: 0 {
\t\t\tMappingInformationType: "ByPolygonVertex"
\t\t\tReferenceInformationType: "IndexToDirect"
\t\t\tUV: 0,0.25,1,0.25,1,1
\t\t\tUVIndex: 0,1,2
\t\t}
\t}
}
Connections:  {
\tConnect: "OO", "Model::Tri", "Model::Scene"
}
`;
  const { json, read } = readGlb(convertFbx6(Buffer.from(fbx)).glb);
  const uv = read(json.meshes[0].primitives[0].attributes.TEXCOORD_0);
  assert.deepStrictEqual(uv.filter((_, i) => i % 2 === 1).sort(), [0.25, 0.25, 1]);
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  PASS ${t.name}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL ${t.name}\n       ${String(err && err.stack || err).split('\n').slice(0, 5).join('\n       ')}`);
    }
  }
  console.log(`\nmesh-formats: passed ${passed}, failed ${failed}`);
  process.exit(failed ? 1 : 0);
})();
