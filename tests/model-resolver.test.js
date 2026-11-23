'use strict';
// Unit tests for "show the model the way Unity does": material resolution in
// Unity's order, shader translation, FBX structure reading (binary + ASCII,
// 6.x + 7.x), FBX 6 -> GLB conversion, and texture decoding/ORM baking.
//
//   node tests/model-resolver.test.js      (sharp/ag-psd tests skip if absent)

const assert = require('assert');
const zlib = require('zlib');

const { resolveModel, translateMaterial } = require('../server/modelResolver');
const { scanFbx } = require('../server/fbxScan');
const { convertFbx6, fbxVersion } = require('../server/fbx6');
const { unityFileId } = require('../server/xxhash64');
const tex = require('../server/textureConvert');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const URP = '933532a4fcc9baf4fa0491de14d08ed7';
const BUILTIN = '0000000000000000f000000000000000';
const g = (n) => n.toString(16).padStart(32, '0');

function graph(overrides) {
  return { paths: {}, metas: {}, mats: {}, prefabs: {}, scenes: {}, ...overrides };
}
const structure = (meshes, materials = [], textures = []) => ({
  ok: true, meshes, materials, textures, models: meshes.map((m) => m.name), hasGeometry: true,
});

test('remap: externalObjects decide, URP translates exactly', () => {
  const gr = graph({
    paths: { [g(1)]: 'Assets/K/Sword.fbx', [g(2)]: 'Assets/K/Mat/Steel.mat', [g(3)]: 'Assets/K/Tex/steel.png' },
    metas: { [g(1)]: { imp: 'ModelImporter', ext: [{ type: 'UnityEngine:Material', name: 'Steel', g: g(2), f: '2100000' }], mat: { mode: 2, name: 0, search: 1, location: 1 } } },
    mats: { [g(2)]: { n: 'Steel', sh: { f: '4800000', g: URP }, kw: [], tex: { _BaseMap: { g: g(3), s: [2, 2], o: [0, 0] } }, f: { _Smoothness: 0.8, _Metallic: 1 }, c: { _BaseColor: [1, 1, 1, 1] } } },
  });
  const m = resolveModel(gr, 'Assets/K/Sword.fbx', structure([{ name: 'Sword', materials: ['Steel'] }], [{ name: 'Steel' }]));
  assert.strictEqual(m.fidelity, 'exact');
  assert.strictEqual(m.byName.Steel, g(2));
  const spec = m.materials[g(2)];
  assert.strictEqual(spec.family, 'urp-lit');
  assert.deepStrictEqual(spec.maps.map, { tex: `albedo:${g(3)}`, s: [2, 2], o: [0, 0] });
  assert.ok(Math.abs(spec.roughness - 0.2) < 1e-9);
  assert.strictEqual(spec.metalness, 1);
});

test('prefab: hashed mesh fileID binds materials per sub-mesh', () => {
  const fbx = g(1);
  const gr = graph({
    paths: { [fbx]: 'Assets/K/Crate.fbx', [g(2)]: 'Assets/K/A.mat', [g(3)]: 'Assets/K/B.mat', [g(4)]: 'Assets/K/Crate.prefab' },
    metas: { [fbx]: { imp: 'ModelImporter', mat: { mode: 0, name: 0, search: 1, location: 1 } } },
    mats: {
      [g(2)]: { n: 'A', sh: { f: '46', g: BUILTIN }, kw: [], tex: {}, f: {}, c: { _Color: [1, 0, 0, 1] } },
      [g(3)]: { n: 'B', sh: { f: '46', g: BUILTIN }, kw: [], tex: {}, f: {}, c: { _Color: [0, 0, 1, 1] } },
    },
    prefabs: {
      [g(4)]: { o: {
        1: { c: 1, n: 'Crate', comps: ['33', '23'] },
        33: { c: 33, go: '1', mesh: { f: unityFileId('Mesh', 'Crate.Body', 0), g: fbx } },
        23: { c: 23, go: '1', en: 1, mats: [{ f: '2100000', g: g(2) }, { f: '2100000', g: g(3) }] },
      } },
    },
  });
  const m = resolveModel(gr, 'Assets/K/Crate.fbx', structure([{ name: 'Crate.Body', materials: ['m0', 'm1'] }, { name: 'Lid', materials: [] }]));
  assert.deepStrictEqual(m.bindings, [{ mesh: 'Crate.Body', key: 'CrateBody', materials: [g(2), g(3)] }]);
  assert.deepStrictEqual(m.rendered.map((r) => [r.mesh, r.source, r.fidelity]), [
    ['Crate.Body', 'prefab', 'exact'], ['Crate.Body', 'prefab', 'exact'], ['Lid', 'default', 'exact']]);
  assert.strictEqual(m.fidelity, 'exact');
});

test('scene bindings are used when no prefab exists (Unity 4 packs)', () => {
  const fbx = g(1);
  const gr = graph({
    paths: { [fbx]: 'Assets/City/blocks.FBX', [g(2)]: 'Assets/City/Materials/block.mat', [g(5)]: 'Assets/City/Demo.unity' },
    metas: { [fbx]: { imp: 'ModelImporter', ids: { 4300000: { c: 43, n: 'block_01' } }, mat: { mode: 0, name: 0, search: 1, location: 0 } } },
    mats: { [g(2)]: { n: 'block', sh: { f: '7', g: BUILTIN }, kw: [], tex: {}, f: {}, c: {} } },
    scenes: { [g(5)]: { o: {
      9: { c: 33, go: '8', mesh: { f: '4300000', g: fbx } },
      10: { c: 23, go: '8', en: 1, mats: [{ f: '2100000', g: g(2) }] },
    } } },
  });
  const m = resolveModel(gr, 'Assets/City/blocks.FBX', structure([{ name: 'block_01', materials: ['01 - Default'] }]));
  assert.strictEqual(m.rendered[0].source, 'scene');
  assert.strictEqual(m.rendered[0].material, g(2));
});

test("legacy search: 'By Base Texture Name' in Materials folders walking up", () => {
  const gr = graph({
    paths: { [g(1)]: 'Assets/Pack/Models/Car.fbx', [g(2)]: 'Assets/Pack/Materials/car_diffuse.mat', [g(3)]: 'Assets/Other/Materials/car_diffuse.mat' },
    metas: { [g(1)]: { imp: 'ModelImporter', mat: { mode: 1, name: 0, search: 1, location: 0 } } },
    mats: {
      [g(2)]: { n: 'car_diffuse', sh: { f: '46', g: BUILTIN }, kw: [], tex: {}, f: {}, c: {} },
      [g(3)]: { n: 'car_diffuse', sh: { f: '46', g: BUILTIN }, kw: [], tex: {}, f: {}, c: {} },
    },
  });
  const m = resolveModel(gr, 'Assets/Pack/Models/Car.fbx', structure([{ name: 'Car', materials: ['Paint'] }], [{ name: 'Paint', diffuse: 'C:\\art\\car_diffuse.tga', normal: null }]));
  assert.strictEqual(m.rendered[0].source, 'search');
  assert.strictEqual(m.rendered[0].material, g(2), 'Pack/Materials beats an unrelated folder');
});

test('not found: Unity generates the material from the FBX (embedded diffuse)', () => {
  const gr = graph({
    paths: { [g(1)]: 'Assets/P/Rock.fbx', [g(2)]: 'Assets/P/Textures/rock.tga' },
    metas: { [g(1)]: { imp: 'ModelImporter', mat: { mode: 1, name: 1, search: 1, location: 0 } } },
  });
  const m = resolveModel(gr, 'Assets/P/Rock.fbx', structure([{ name: 'Rock', materials: ['RockMat'] }], [{ name: 'RockMat', diffuse: 'rock.tga', normal: null }], ['rock.tga']));
  assert.strictEqual(m.rendered[0].source, 'generated');
  assert.strictEqual(m.rendered[0].fidelity, 'exact');
  assert.deepStrictEqual(m.embedded.RockMat, { name: 'RockMat', map: `albedo:${g(2)}`, normalMap: null });
});

test('binary material falls back to the FBX slot diffuse', () => {
  const gr = graph({
    paths: { [g(1)]: 'Assets/Cars/bus.fbx', [g(2)]: 'Assets/Cars/Materials/bus_mat.mat', [g(3)]: 'Assets/Cars/Textures/bus.tga' },
    mats: { [g(2)]: { n: 'bus_mat', bin: 1 } },
  });
  const m = resolveModel(gr, 'Assets/Cars/bus.fbx', structure([{ name: 'Bus', materials: ['bus_mat'] }], [{ name: 'bus_mat', diffuse: 'bus.tga', normal: null }], ['bus.tga']));
  assert.strictEqual(m.rendered[0].material, g(2));
  assert.strictEqual(m.materials[g(2)].maps.map.tex, `albedo:${g(3)}`);
  assert.strictEqual(m.rendered[0].fidelity, 'approximate');
});

test('standard: metallic/gloss + occlusion become one ORM recipe', () => {
  const ctx = { graph: graph({ paths: { [g(7)]: 'a.png', [g(8)]: 'mg.png', [g(9)]: 'ao.png' } }), textures: {} };
  ctx.graph.mats[g(1)] = { n: 'M', sh: { f: '46', g: BUILTIN }, kw: [], tex: { _MainTex: { g: g(7), s: [1, 1], o: [0, 0] }, _MetallicGlossMap: { g: g(8), s: [1, 1], o: [0, 0] }, _OcclusionMap: { g: g(9), s: [1, 1], o: [0, 0] } }, f: { _GlossMapScale: 0.5, _OcclusionStrength: 0.8 }, c: {} };
  const spec = translateMaterial(ctx, g(1));
  assert.strictEqual(spec.metalness, 1);
  assert.strictEqual(spec.roughness, 1);
  assert.strictEqual(spec.aoMap, true);
  const orm = ctx.textures[spec.maps.ormMap.tex];
  assert.strictEqual(orm.role, 'orm');
  assert.ok(orm.recipe.includes(`mg=${g(8)}`) && orm.recipe.includes(`ao=${g(9)}`) && orm.recipe.includes('ss=0.500') && orm.recipe.includes('ao_s=0.800'));
});

test('alpha, culling, emission, legacy black tint', () => {
  const ctx = { graph: graph({ paths: { [g(7)]: 'leaf.png' } }), textures: {} };
  ctx.graph.mats[g(1)] = { n: 'Leaf', sh: { f: '4800000', g: URP }, kw: [], tex: { _BaseMap: { g: g(7), s: [1, 1], o: [0, 0] } }, f: { _AlphaClip: 1, _Cutoff: 0.3, _Cull: 0 }, c: { _EmissionColor: [2, 1, 0, 1] } };
  const s1 = translateMaterial(ctx, g(1));
  assert.strictEqual(s1.alpha, 'mask');
  assert.strictEqual(s1.cutoff, 0.3);
  assert.strictEqual(s1.doubleSided, true);
  assert.strictEqual(s1.emissive, undefined, 'URP needs the _EMISSION keyword');
  ctx.graph.mats[g(2)] = { n: 'Old', sh: { f: '10703', g: BUILTIN }, kw: [], tex: { _MainTex: { g: g(7), s: [1, 1], o: [0, 0] } }, f: {}, c: { _Color: [0, 0, 0, 1] } };
  assert.deepStrictEqual(translateMaterial(ctx, g(2)).color, [1, 1, 1, 1]);
  ctx.graph.mats[g(3)] = { n: 'Glow', sh: { f: '46', g: BUILTIN }, kw: ['_EMISSION'], tex: {}, f: { _Mode: 3 }, c: { _EmissionColor: [4, 2, 0, 1] } };
  const s3 = translateMaterial(ctx, g(3));
  assert.strictEqual(s3.alpha, 'blend');
  assert.deepStrictEqual(s3.emissive, [1, 0.5, 0]);
  assert.strictEqual(s3.emissiveIntensity, 4);
});

test('custom shader: slots by name, approximate, vertex colours allowed', () => {
  const ctx = { graph: graph({ paths: { [g(7)]: 'atlas.png', [g(8)]: 'n.png', [g(9)]: 'Shaders/Toon.shader' } }), textures: {} };
  ctx.graph.mats[g(1)] = { n: 'Toon', sh: { f: '4800000', g: g(9) }, kw: [], tex: { _Albedo: { g: g(7), s: [1, 1], o: [0, 0] }, _Normal_Map: { g: g(8), s: [1, 1], o: [0, 0] }, _Ramp: { g: g(7), s: [1, 1], o: [0, 0] } }, f: {}, c: { _Tint: [0.5, 0.5, 0.5, 1] } };
  const s = translateMaterial(ctx, g(1));
  assert.strictEqual(s.exact, false);
  assert.strictEqual(s.shader, 'Toon.shader');
  assert.strictEqual(s.maps.map.tex, `albedo:${g(7)}`);
  assert.strictEqual(s.maps.normalMap.tex, `normal:${g(8)}`);
  assert.deepStrictEqual(s.color, [0.5, 0.5, 0.5, 1]);
});

test('no geometry (animation-only FBX) is "none", not missing', () => {
  const m = resolveModel(graph({ paths: { [g(1)]: 'Assets/Anim@Run.fbx' } }), 'Assets/Anim@Run.fbx', { ok: true, meshes: [], materials: [], textures: [], models: ['Hips'], hasGeometry: false });
  assert.strictEqual(m.fidelity, 'none');
});

// --- FBX structure + conversion --------------------------------------------------------

const ASCII7 = `; FBX 7.3.0 project file
FBXHeaderExtension:  {
\tFBXVersion: 7300
}
Objects:  {
\tGeometry: 10, "Geometry::Body", "Mesh" {
\t}
\tModel: 20, "Model::Body", "Mesh" {
\t}
\tMaterial: 30, "Material::Skin", "" {
\t}
\tMaterial: 31, "Material::Eyes", "" {
\t}
\tTexture: 40, "Texture::skin", "" {
\t\tFileName: "C:/work/skin_d.png"
\t\tRelativeFilename: "..\\\\tex\\\\skin_d.png"
\t}
\tTexture: 41, "Texture::cc", "" {
\t}
}
Connections:  {
\tC: "OO",10,20
\tC: "OO",30,20
\tC: "OO",31,20
\tC: "OP",40,30, "DiffuseColor"
\tC: "OP",41,31, "DiffuseColor"
}
`;

test('FBX ASCII 7: meshes, material order, diffuse links, procedural maps ignored', () => {
  const s = scanFbx(Buffer.from(ASCII7));
  assert.strictEqual(s.ok, true);
  assert.deepStrictEqual(s.meshes, [{ name: 'Body', materials: ['Skin', 'Eyes'] }]);
  assert.deepStrictEqual(s.materials, [{ name: 'Skin', diffuse: 'skin_d.png', normal: null }, { name: 'Eyes', diffuse: null, normal: null }]);
  assert.deepStrictEqual(s.textures, ['skin_d.png']);
});

const ASCII6 = `; FBX 6.1.0 project file
FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 6100
}
Objects:  {
\tModel: "Model::Quad", "Mesh" {
\t\tProperties60:  {
\t\t\tProperty: "Lcl Translation", "Lcl Translation", "A+",1,2,3
\t\t\tProperty: "Lcl Rotation", "Lcl Rotation", "A+",0,90,0
\t\t\tProperty: "Lcl Scaling", "Lcl Scaling", "A+",1,1,1
\t\t}
\t\tVertices: 0,0,0,1,0,0,1,1,0
\t\t,0,1,0
\t\tPolygonVertexIndex: 0,1,2,-4
\t\tLayerElementNormal: 0 {
\t\t\tMappingInformationType: "ByVertice"
\t\t\tReferenceInformationType: "Direct"
\t\t\tNormals: 0,0,1,0,0,1,0,0,1,0,0,1
\t\t}
\t\tLayerElementUV: 0 {
\t\t\tMappingInformationType: "ByPolygonVertex"
\t\t\tReferenceInformationType: "IndexToDirect"
\t\t\tUV: 0,0,1,0,1,1,0,1
\t\t\tUVIndex: 0,1,2,3
\t\t}
\t\tLayerElementMaterial: 0 {
\t\t\tMappingInformationType: "AllSame"
\t\t\tReferenceInformationType: "IndexToDirect"
\t\t\tMaterials: 0
\t\t}
\t}
\tMaterial: "Material::Grass", "" {
\t}
\tTexture: "Texture::grass", "TextureVideoClip" {
\t\tFileName: "D:\\\\maps\\\\grass.tga"
\t\tRelativeFilename: "grass.tga"
\t}
}
Connections:  {
\tConnect: "OO", "Model::Quad", "Model::Scene"
\tConnect: "OO", "Material::Grass", "Model::Quad"
\tConnect: "OP", "Texture::grass", "Material::Grass", "DiffuseColor"
}
`;

test('FBX ASCII 6.1: name-based connections are read', () => {
  const s = scanFbx(Buffer.from(ASCII6));
  assert.deepStrictEqual(s.meshes, [{ name: 'Quad', materials: ['Grass'] }]);
  assert.deepStrictEqual(s.materials, [{ name: 'Grass', diffuse: 'grass.tga', normal: null }]);
});

test('FBX 6 -> GLB: valid container, triangulated quad, transform, material name', () => {
  assert.strictEqual(fbxVersion(Buffer.from(ASCII6)), 6100);
  const { glb, triangles, meshes } = convertFbx6(Buffer.from(ASCII6));
  assert.strictEqual(meshes, 1);
  assert.strictEqual(triangles, 2);
  assert.strictEqual(glb.readUInt32LE(0), 0x46546c67, 'glTF magic');
  assert.strictEqual(glb.readUInt32LE(8), glb.length, 'declared length');
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString());
  assert.deepStrictEqual(json.materials.map((m) => m.name), ['Grass']);
  const node = json.nodes.find((n) => n.name === 'Quad');
  assert.deepStrictEqual(node.translation, [1, 2, 3]);
  assert.ok(Math.abs(node.rotation[1] - Math.SQRT1_2) < 1e-6, '90° about Y');
  const prim = json.meshes[0].primitives[0];
  assert.strictEqual(json.accessors[prim.attributes.POSITION].count, 6);
  assert.ok(prim.attributes.NORMAL !== undefined && prim.attributes.TEXCOORD_0 !== undefined);
  assert.deepStrictEqual(json.accessors[prim.attributes.POSITION].max, [1, 1, 0]);
});

function binaryFbx6() {
  // Minimal binary FBX 6.1: Objects/Model with Vertices (zlib array) + polys.
  const prop = {
    S: (s) => { const b = Buffer.from(s, 'latin1'); const h = Buffer.alloc(5); h.write('S', 0); h.writeUInt32LE(b.length, 1); return Buffer.concat([h, b]); },
    d: (vals, compress) => {
      const raw = Buffer.alloc(vals.length * 8); vals.forEach((v, i) => raw.writeDoubleLE(v, i * 8));
      const data = compress ? zlib.deflateSync(raw) : raw;
      const h = Buffer.alloc(13); h.write('d', 0); h.writeUInt32LE(vals.length, 1); h.writeUInt32LE(compress ? 1 : 0, 5); h.writeUInt32LE(data.length, 9);
      return Buffer.concat([h, data]);
    },
    i: (vals) => {
      const raw = Buffer.alloc(vals.length * 4); vals.forEach((v, i) => raw.writeInt32LE(v, i * 4));
      const h = Buffer.alloc(13); h.write('i', 0); h.writeUInt32LE(vals.length, 1); h.writeUInt32LE(0, 5); h.writeUInt32LE(raw.length, 9);
      return Buffer.concat([h, raw]);
    },
  };
  const NULL = Buffer.alloc(13);
  function node(name, props, kids, at) {
    const p = Buffer.concat(props);
    const headLen = 13 + name.length;
    let body = Buffer.concat([p]);
    let off = at + headLen + p.length;
    const childBufs = [];
    for (const k of kids) { const b = k(off); childBufs.push(b); off += b.length; }
    if (kids.length) { childBufs.push(NULL); off += NULL.length; }
    body = Buffer.concat([p, ...childBufs]);
    const h = Buffer.alloc(headLen);
    h.writeUInt32LE(at + headLen + body.length, 0);
    h.writeUInt32LE(props.length, 4);
    h.writeUInt32LE(p.length, 8);
    h.writeUInt8(name.length, 12);
    h.write(name, 13, 'ascii');
    return Buffer.concat([h, body]);
  }
  const header = Buffer.alloc(27);
  header.write('Kaydara FBX Binary  \0\x1a\0', 0, 'latin1');
  header.writeUInt32LE(6100, 23);
  const objects = (at) => node('Objects', [], [
    (o) => node('Model', [prop.S('Model::Tri'), prop.S('Mesh')], [
      (o2) => node('Vertices', [prop.d([0, 0, 0, 1, 0, 0, 0, 1, 0], true)], [], o2),
      (o3) => node('PolygonVertexIndex', [prop.i([0, 1, -3])], [], o3),
    ], o),
  ], at);
  const objBuf = objects(27);
  const conns = (at) => node('Connections', [], [
    (o) => node('Connect', [prop.S('OO'), prop.S('Model::Tri'), prop.S('Model::Scene')], [], o),
  ], at);
  const conBuf = conns(27 + objBuf.length);
  return Buffer.concat([header, objBuf, conBuf, NULL]);
}

test('FBX 6 binary (zlib arrays) -> GLB', () => {
  const buf = binaryFbx6();
  assert.strictEqual(fbxVersion(buf), 6100);
  const { triangles, meshes } = convertFbx6(buf);
  assert.strictEqual(meshes, 1);
  assert.strictEqual(triangles, 1);
});

test('FBX 6: texture on the mesh node becomes the material diffuse', () => {
  const text = ASCII6.replace('\tConnect: "OP", "Texture::grass", "Material::Grass", "DiffuseColor"', '\tConnect: "OO", "Texture::grass", "Model::Quad"');
  assert.ok(text.includes('"Texture::grass", "Model::Quad"'));
  const s = scanFbx(Buffer.from(text));
  assert.deepStrictEqual(s.materials, [{ name: 'Grass', diffuse: 'grass.tga', normal: null }]);
});

test('import mode None, no readable prefab: author material by name (approximate)', () => {
  const gr = graph({
    paths: { [g(1)]: 'Assets/City/Models/blocks.FBX', [g(2)]: 'Assets/City/Materials/blocks.mat', [g(3)]: 'Assets/City/Prefabs/h.prefab' },
    metas: { [g(1)]: { imp: 'ModelImporter', mat: { mode: 0, name: 0, search: 1, location: 0 } } },
    mats: { [g(2)]: { n: 'blocks', sh: { f: '7', g: BUILTIN }, kw: [], tex: {}, f: {}, c: {} } },
    prefabs: { [g(3)]: { o: {}, bin: 1 } },
  });
  const m = resolveModel(gr, 'Assets/City/Models/blocks.FBX', structure([{ name: 'block_1', materials: ['01 - Default'] }], [{ name: '01 - Default', diffuse: 'blocks.png', normal: null }]));
  assert.strictEqual(m.rendered[0].source, 'name');
  assert.strictEqual(m.rendered[0].material, g(2));
  assert.strictEqual(m.fidelity, 'approximate');
});

test('fuzzy: binary material and renamed files find their texture, never a normal map', () => {
  const gr = graph({
    paths: {
      [g(1)]: 'Assets/Cars/Meshes/Lorry.fbx', [g(2)]: 'Assets/Cars/Materials/semi_cab.mat',
      [g(3)]: 'Assets/Cars/Textures/Lorry_cab.tga', [g(4)]: 'Assets/Cars/Textures/Lorry_trailer.tga', [g(5)]: 'Assets/Cars/Textures/Lorry_cab_normal.tga',
      [g(6)]: 'Assets/City/Textures/Materials/blocks.mat', [g(7)]: 'Assets/City/Textures/blocks_texture.png', [g(8)]: 'Assets/City/Textures/blocks_texture_snow.png',
    },
    mats: { [g(2)]: { n: 'semi_cab', bin: 1 }, [g(6)]: { n: 'blocks', bin: 1 } },
  });
  const m = resolveModel(gr, 'Assets/Cars/Meshes/Lorry.fbx', structure([{ name: 'Cab', materials: ['semi_cab'] }], [{ name: 'semi_cab', diffuse: 'semi_cab.tga', normal: null }], ['semi_cab.tga']));
  assert.strictEqual(m.materials[g(2)].maps.map.tex, `albedo:${g(3)}`);
  const ctx = { graph: gr, textures: {}, idx: null, modelNames: ['blocks'] };
  assert.strictEqual(translateMaterial(ctx, g(6)).maps.map.tex, `albedo:${g(7)}`, 'blocks -> blocks_texture, not the snow variant');
});

// --- textures --------------------------------------------------------------------

function tga({ rle = false, topLeft = false, bpp = 32 } = {}) {
  // 2x2: red, green / blue, white  (top row listed first when topLeft)
  const px = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];
  const rows = topLeft ? [px[0], px[1], px[2], px[3]] : [px[2], px[3], px[0], px[1]];
  const h = Buffer.alloc(18);
  h[2] = rle ? 10 : 2; h.writeUInt16LE(2, 12); h.writeUInt16LE(2, 14); h[16] = bpp; h[17] = (topLeft ? 0x20 : 0) | (bpp === 32 ? 8 : 0);
  const pix = (p) => (bpp === 32 ? [p[2], p[1], p[0], 0] : [p[2], p[1], p[0]]);
  let data;
  if (!rle) data = Buffer.from(rows.flatMap(pix));
  else data = Buffer.from([0x81, ...pix(rows[0]), 0x01, ...pix(rows[2]), ...pix(rows[3])].map((v, i) => v)); // 2x row0[0]?? replaced below
  if (rle) {
    // raw packet of 4 pixels: header 0x03 + 4 pixels
    data = Buffer.from([0x03, ...rows.flatMap(pix)]);
  }
  return Buffer.concat([h, data]);
}

test('TGA: origin, RLE, empty alpha made opaque', () => {
  for (const opts of [{}, { topLeft: true }, { rle: true }, { bpp: 24 }]) {
    const { data, width, height } = tex.decodeTga(tga(opts));
    assert.strictEqual(width, 2);
    assert.strictEqual(height, 2);
    assert.deepStrictEqual([...data.subarray(0, 4)], [255, 0, 0, 255], `top-left red ${JSON.stringify(opts)}`);
    assert.deepStrictEqual([...data.subarray(12, 16)], [255, 255, 255, 255], `bottom-right white ${JSON.stringify(opts)}`);
  }
});

test('TGA RLE run packet repeats a pixel', () => {
  const h = Buffer.alloc(18);
  h[2] = 10; h.writeUInt16LE(3, 12); h.writeUInt16LE(1, 14); h[16] = 24; h[17] = 0x20;
  const { data } = tex.decodeTga(Buffer.concat([h, Buffer.from([0x82, 10, 20, 30])]));
  assert.deepStrictEqual([...data], [30, 20, 10, 255, 30, 20, 10, 255, 30, 20, 10, 255]);
});

test('ORM: metallic R, smoothness A*scale -> roughness, occlusion strength', async () => {
  if (!tex.available()) return;
  const sharp = require('sharp');
  const mg = await sharp(Buffer.from([255, 0, 0, 128]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
  const ao = await sharp(Buffer.from([0, 64, 0, 255]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
  const out = await tex.buildOrm({ kind: 'metallic', mg, mgName: 'mg.png', ao, aoName: 'ao.png', aoStrength: 0.5, smoothScale: 1, metallic: 0 }, 64);
  const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  assert.ok(Math.abs(data[0] - 160) <= 1, `occlusion ${data[0]}`);           // 255 - (255-64)*0.5
  assert.ok(Math.abs(data[1] - 127) <= 1, `roughness ${data[1]}`);           // 1 - 128/255
  assert.strictEqual(data[2], 255);                                         // metal
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
  console.log(`\nmodel-resolver: passed ${passed}, failed ${failed}${tex.available() ? '' : ' (sharp not installed: texture pixel tests skipped)'}`);
  process.exit(failed ? 1 : 0);
})();
