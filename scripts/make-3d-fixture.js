'use strict';
// Builds a small .unitypackage for the 3D acceptance test (verify-3d.sh):
//
//   Assets/Crate/Models/Crate.fbx        FBX 7.3 ASCII cube, material "CrateMat"
//                                        (.meta remaps it to Materials/Crate.mat)
//   Assets/Crate/Materials/Crate.mat     Standard shader, _MainTex = crate.png
//   Assets/Crate/Textures/crate.png      orange/blue checker
//   Assets/Crate/Prefabs/CrateStack.prefab  two crates, one lifted and turned
//   Assets/Crate/Models/OldBox.fbx       FBX 6.1 ASCII box, diffuse old.tga
//   Assets/Crate/Textures/old.tga        green/yellow checker (TGA)
//   Assets/Crate/Meshes/Slab.asset       Unity mesh asset: cube, two submeshes
//   Assets/Crate/Materials/Purple.mat    URP Lit, flat purple
//   Assets/Crate/Models/Barrel.dae       Collada cube, embedded material with
//                                        a sampler -> surface -> barrel.png chain
//   Assets/Crate/Textures/barrel.png     red/white checker
//   Assets/Crate/Prefabs/Mixed.prefab    Slab (Crate.mat + Purple.mat) and a
//                                        Barrel beside it (its own embedded
//                                        material, by hashed fileID)
//
//   node scripts/make-3d-fixture.js <out-dir>
//
// Needs sharp (run it in the image's deps stage).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const sharp = require('sharp');
const { unityFileId } = require('../server/xxhash64');

const out = process.argv[2] || './fixture-3d';
const G = (n) => `f1a7${String(n).padStart(28, '0')}`;   // hex, like real Unity GUIDs
const GUID = { fbx: G(1), mat: G(2), png: G(3), prefab: G(4), old: G(5), tga: G(6), slab: G(7), purple: G(8), dae: G(9), barrelPng: G(10), mixed: G(11) };

// --- cube geometry -----------------------------------------------------------------
const V = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
const FACES = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]];
const NORMALS = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0]];
const polys = FACES.flatMap((f) => [f[0], f[1], f[2], -f[3] - 1]);
const normals = FACES.flatMap((_, i) => [...NORMALS[i], ...NORMALS[i], ...NORMALS[i], ...NORMALS[i]]);
const uvs = [0, 0, 1, 0, 1, 1, 0, 1];
const uvIndex = FACES.flatMap(() => [0, 1, 2, 3]);
const arr = (a) => `*${a.length} {\n\t\t\ta: ${a.join(',')}\n\t\t}`;

// three.js' ASCII FBX parser tracks nesting by indentation: arrays must be
// laid out exactly as exporters write them ("a:" one level deeper, "} " back).
const exporterIndent = (text) => text.replace(/(\n(\t+)(\w+): \*\d+ \{\n)\t+(a: [^\n]*)\n\t+\}/g,
  (m, head, ind, key, a) => `${head}${ind}\t${a}\n${ind}} `);

const fbx7 = exporterIndent(`; FBX 7.3.0 project file
FBXHeaderExtension:  {
	FBXHeaderVersion: 1003
	FBXVersion: 7300
}
GlobalSettings:  {
	Version: 1000
	Properties70:  {
		P: "UpAxis", "int", "Integer", "",1
		P: "UpAxisSign", "int", "Integer", "",1
		P: "FrontAxis", "int", "Integer", "",2
		P: "FrontAxisSign", "int", "Integer", "",1
		P: "CoordAxis", "int", "Integer", "",0
		P: "CoordAxisSign", "int", "Integer", "",1
		P: "UnitScaleFactor", "double", "Number", "",100
	}
}
Objects:  {
	Geometry: 100, "Geometry::Crate", "Mesh" {
		Vertices: ${arr(V)}
		PolygonVertexIndex: ${arr(polys)}
		GeometryVersion: 124
		LayerElementNormal: 0 {
			Version: 101
			Name: ""
			MappingInformationType: "ByPolygonVertex"
			ReferenceInformationType: "Direct"
			Normals: ${arr(normals)}
		}
		LayerElementUV: 0 {
			Version: 101
			Name: "UVMap"
			MappingInformationType: "ByPolygonVertex"
			ReferenceInformationType: "Direct"
			UV: ${arr(uvIndex.flatMap((k) => [uvs[k * 2], uvs[k * 2 + 1]]))}
		}
		LayerElementMaterial: 0 {
			Version: 101
			Name: ""
			MappingInformationType: "AllSame"
			ReferenceInformationType: "IndexToDirect"
			Materials: *1 {
				a: 0
			}
		}
		Layer: 0 {
			Version: 100
			LayerElement:  {
				Type: "LayerElementNormal"
				TypedIndex: 0
			}
			LayerElement:  {
				Type: "LayerElementUV"
				TypedIndex: 0
			}
			LayerElement:  {
				Type: "LayerElementMaterial"
				TypedIndex: 0
			}
		}
	}
	Model: 200, "Model::Crate", "Mesh" {
		Version: 232
		Properties70:  {
			P: "Lcl Translation", "Lcl Translation", "", "A",0,0,0
		}
	}
	Material: 300, "Material::CrateMat", "" {
		Version: 102
		ShadingModel: "phong"
		Properties70:  {
			P: "DiffuseColor", "Color", "", "A",0.8,0.8,0.8
		}
	}
}
Connections:  {
	C: "OO",200,0
	C: "OO",100,200
	C: "OO",300,200
}
`);

const fbxMeta = `fileFormatVersion: 2
guid: ${GUID.fbx}
ModelImporter:
  serializedVersion: 22200
  internalIDToNameTable: []
  externalObjects:
  - first:
      type: UnityEngine:Material
      assembly: UnityEngine.CoreModule
      name: CrateMat
    second: {fileID: 2100000, guid: ${GUID.mat}, type: 2}
  materials:
    materialImportMode: 2
    materialName: 0
    materialSearch: 1
    materialLocation: 1
  meshes:
    globalScale: 1
    useFileScale: 1
  animationType: 0
`;

const mat = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!21 &2100000
Material:
  serializedVersion: 8
  m_Name: Crate
  m_Shader: {fileID: 46, guid: 0000000000000000f000000000000000, type: 0}
  m_ValidKeywords: []
  m_SavedProperties:
    serializedVersion: 3
    m_TexEnvs:
    - _MainTex:
        m_Texture: {fileID: 2800000, guid: ${GUID.png}, type: 3}
        m_Scale: {x: 1, y: 1}
        m_Offset: {x: 0, y: 0}
    m_Floats:
    - _Glossiness: 0.3
    - _Metallic: 0
    m_Colors:
    - _Color: {r: 1, g: 1, b: 1, a: 1}
`;

const crateMesh = unityFileId('Mesh', 'Crate', 0);
const prefab = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &1
GameObject:
  m_Component:
  - component: {fileID: 4}
  m_Name: CrateStack
  m_IsActive: 1
--- !u!4 &4
Transform:
  m_GameObject: {fileID: 1}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: {x: 0, y: 0, z: 0}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Children:
  - {fileID: 40}
  - {fileID: 41}
  m_Father: {fileID: 0}
--- !u!1 &10
GameObject:
  m_Component:
  - component: {fileID: 40}
  - component: {fileID: 33}
  - component: {fileID: 23}
  m_Name: Bottom
  m_IsActive: 1
--- !u!4 &40
Transform:
  m_GameObject: {fileID: 10}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: {x: 0, y: 0, z: 0}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Children: []
  m_Father: {fileID: 4}
--- !u!33 &33
MeshFilter:
  m_GameObject: {fileID: 10}
  m_Mesh: {fileID: ${crateMesh}, guid: ${GUID.fbx}, type: 3}
--- !u!23 &23
MeshRenderer:
  m_GameObject: {fileID: 10}
  m_Enabled: 1
  m_Materials:
  - {fileID: 2100000, guid: ${GUID.mat}, type: 2}
--- !u!1 &11
GameObject:
  m_Component:
  - component: {fileID: 41}
  - component: {fileID: 34}
  - component: {fileID: 24}
  m_Name: Top
  m_IsActive: 1
--- !u!4 &41
Transform:
  m_GameObject: {fileID: 11}
  m_LocalRotation: {x: 0, y: 0.38268343, z: 0, w: 0.9238795}
  m_LocalPosition: {x: 0, y: 2.05, z: 0}
  m_LocalScale: {x: 0.8, y: 0.8, z: 0.8}
  m_Children: []
  m_Father: {fileID: 4}
--- !u!33 &34
MeshFilter:
  m_GameObject: {fileID: 11}
  m_Mesh: {fileID: ${crateMesh}, guid: ${GUID.fbx}, type: 3}
--- !u!23 &24
MeshRenderer:
  m_GameObject: {fileID: 11}
  m_Enabled: 1
  m_Materials:
  - {fileID: 2100000, guid: ${GUID.mat}, type: 2}
`;

const fbx6 = `; FBX 6.1.0 project file
FBXHeaderExtension:  {
	FBXHeaderVersion: 1003
	FBXVersion: 6100
}
Objects:  {
	Model: "Model::OldBox", "Mesh" {
		Properties60:  {
			Property: "Lcl Translation", "Lcl Translation", "A+",0,0,0
		}
		Vertices: ${V.join(',')}
		PolygonVertexIndex: ${polys.join(',')}
		LayerElementNormal: 0 {
			MappingInformationType: "ByPolygonVertex"
			ReferenceInformationType: "Direct"
			Normals: ${normals.join(',')}
		}
		LayerElementUV: 0 {
			MappingInformationType: "ByPolygonVertex"
			ReferenceInformationType: "IndexToDirect"
			UV: ${uvs.join(',')}
			UVIndex: ${uvIndex.join(',')}
		}
		LayerElementMaterial: 0 {
			MappingInformationType: "AllSame"
			ReferenceInformationType: "IndexToDirect"
			Materials: 0
		}
	}
	Material: "Material::OldMat", "" {
	}
	Texture: "Texture::old", "TextureVideoClip" {
		FileName: "C:\\\\art\\\\old.tga"
		RelativeFilename: "old.tga"
	}
}
Connections:  {
	Connect: "OO", "Model::OldBox", "Model::Scene"
	Connect: "OO", "Material::OldMat", "Model::OldBox"
	Connect: "OP", "Texture::old", "Material::OldMat", "DiffuseColor"
}
`;
const oldMeta = `fileFormatVersion: 2
guid: ${GUID.old}
ModelImporter:
  materials:
    materialImportMode: 1
    materialName: 0
    materialSearch: 1
    materialLocation: 0
`;

// --- Unity mesh asset: the cube, faces 0-2 in submesh 0, 3-5 in submesh 1 ------
const f32 = (...v) => { const b = Buffer.alloc(v.length * 4); v.forEach((x, i) => b.writeFloatLE(x, i * 4)); return b; };
const slabVerts = [];
const slabIdx = [[], []];
FACES.forEach((f, fi) => {
  const base = slabVerts.length;
  f.forEach((vi, k) => slabVerts.push(Buffer.concat([f32(V[vi * 3], V[vi * 3 + 1], V[vi * 3 + 2]), f32(...NORMALS[fi]), f32(uvs[k * 2], uvs[k * 2 + 1])])));
  // FBX-style polygons are counter-clockwise (right-handed); Unity meshes are
  // clockwise, so the triangle order is reversed.
  slabIdx[fi < 3 ? 0 : 1].push(base, base + 2, base + 1, base, base + 3, base + 2);
});
const idxBuf = Buffer.alloc((slabIdx[0].length + slabIdx[1].length) * 2);
[...slabIdx[0], ...slabIdx[1]].forEach((x, i) => idxBuf.writeUInt16LE(x, i * 2));
const channels = Array.from({ length: 14 }, (_, i) => (i === 0 ? [0, 0, 3] : i === 1 ? [12, 0, 3] : i === 4 ? [24, 0, 2] : [0, 0, 0]));
const slab = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!43 &4300000
Mesh:
  m_ObjectHideFlags: 0
  m_Name: Slab
  serializedVersion: 10
  m_SubMeshes:
  - serializedVersion: 2
    firstByte: 0
    indexCount: ${slabIdx[0].length}
    topology: 0
    baseVertex: 0
    firstVertex: 0
    vertexCount: 24
  - serializedVersion: 2
    firstByte: ${slabIdx[0].length * 2}
    indexCount: ${slabIdx[1].length}
    topology: 0
    baseVertex: 0
    firstVertex: 0
    vertexCount: 24
  m_MeshCompression: 0
  m_IndexFormat: 0
  m_IndexBuffer: ${idxBuf.toString('hex')}
  m_VertexData:
    serializedVersion: 3
    m_VertexCount: 24
    m_Channels:
${channels.map(([o, f, d]) => `    - stream: 0\n      offset: ${o}\n      format: ${f}\n      dimension: ${d}`).join('\n')}
    m_DataSize: ${24 * 32}
    _typelessdata: ${Buffer.concat(slabVerts).toString('hex')}
`;

const purple = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!21 &2100000
Material:
  serializedVersion: 8
  m_Name: Purple
  m_Shader: {fileID: 4800000, guid: 933532a4fcc9baf4fa0491de14d08ed7, type: 3}
  m_ValidKeywords: []
  m_SavedProperties:
    serializedVersion: 3
    m_TexEnvs: []
    m_Floats:
    - _Smoothness: 0.2
    - _Metallic: 0
    m_Colors:
    - _BaseColor: {r: 0.6, g: 0.1, b: 0.85, a: 1}
`;

// --- Collada barrel (a cube), embedded material with a texture chain ----------
const daeTris = FACES.flatMap((f, fi) => [[f[0], 0], [f[1], 1], [f[2], 2], [f[0], 0], [f[2], 2], [f[3], 3]].map(([v, t]) => `${v} ${fi} ${t}`)).join(' ');
const barrelDae = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><unit name="meter" meter="1"/><up_axis>Y_UP</up_axis></asset>
  <library_images><image id="barrel_png" name="barrel_png"><init_from>barrel.png</init_from></image></library_images>
  <library_effects>
    <effect id="BarrelMat-effect"><profile_COMMON>
      <newparam sid="barrel_png-surface"><surface type="2D"><init_from>barrel_png</init_from></surface></newparam>
      <newparam sid="barrel_png-sampler"><sampler2D><source>barrel_png-surface</source></sampler2D></newparam>
      <technique sid="common"><lambert><diffuse><texture texture="barrel_png-sampler" texcoord="UVMap"/></diffuse></lambert></technique>
    </profile_COMMON></effect>
  </library_effects>
  <library_materials><material id="BarrelMat-material" name="BarrelMat"><instance_effect url="#BarrelMat-effect"/></material></library_materials>
  <library_geometries>
    <geometry id="Barrel-mesh" name="Barrel"><mesh>
      <source id="Barrel-pos"><float_array id="Barrel-pos-array" count="${V.length}">${V.join(' ')}</float_array>
        <technique_common><accessor source="#Barrel-pos-array" count="8" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
      <source id="Barrel-nrm"><float_array id="Barrel-nrm-array" count="18">${NORMALS.flat().join(' ')}</float_array>
        <technique_common><accessor source="#Barrel-nrm-array" count="6" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
      <source id="Barrel-uv"><float_array id="Barrel-uv-array" count="8">${uvs.join(' ')}</float_array>
        <technique_common><accessor source="#Barrel-uv-array" count="4" stride="2"><param name="S" type="float"/><param name="T" type="float"/></accessor></technique_common></source>
      <vertices id="Barrel-vtx"><input semantic="POSITION" source="#Barrel-pos"/></vertices>
      <triangles material="BarrelMat-material" count="12">
        <input semantic="VERTEX" source="#Barrel-vtx" offset="0"/>
        <input semantic="NORMAL" source="#Barrel-nrm" offset="1"/>
        <input semantic="TEXCOORD" source="#Barrel-uv" offset="2" set="0"/>
        <p>${daeTris}</p>
      </triangles>
    </mesh></geometry>
  </library_geometries>
  <library_visual_scenes><visual_scene id="Scene" name="Scene">
    <node id="Barrel" name="Barrel" type="NODE">
      <instance_geometry url="#Barrel-mesh" name="Barrel"><bind_material><technique_common>
        <instance_material symbol="BarrelMat-material" target="#BarrelMat-material"/>
      </technique_common></bind_material></instance_geometry>
    </node>
  </visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#Scene"/></scene>
</COLLADA>
`;
const daeMeta = `fileFormatVersion: 2
guid: ${GUID.dae}
ModelImporter:
  serializedVersion: 22200
  internalIDToNameTable: []
  externalObjects: {}
  materials:
    materialImportMode: 1
    materialName: 0
    materialSearch: 1
    materialLocation: 1
  meshes:
    globalScale: 1
    useFileScale: 1
  animationType: 0
`;

const mixed = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &1
GameObject:
  m_Component:
  - component: {fileID: 4}
  m_Name: Mixed
  m_IsActive: 1
--- !u!4 &4
Transform:
  m_GameObject: {fileID: 1}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: {x: 0, y: 0, z: 0}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Children:
  - {fileID: 40}
  - {fileID: 41}
  m_Father: {fileID: 0}
--- !u!1 &10
GameObject:
  m_Component:
  - component: {fileID: 40}
  - component: {fileID: 33}
  - component: {fileID: 23}
  m_Name: Slab
  m_IsActive: 1
--- !u!4 &40
Transform:
  m_GameObject: {fileID: 10}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: {x: -1.3, y: 0, z: 0}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Children: []
  m_Father: {fileID: 4}
--- !u!33 &33
MeshFilter:
  m_GameObject: {fileID: 10}
  m_Mesh: {fileID: 4300000, guid: ${GUID.slab}, type: 2}
--- !u!23 &23
MeshRenderer:
  m_GameObject: {fileID: 10}
  m_Enabled: 1
  m_Materials:
  - {fileID: 2100000, guid: ${GUID.mat}, type: 2}
  - {fileID: 2100000, guid: ${GUID.purple}, type: 2}
--- !u!1 &11
GameObject:
  m_Component:
  - component: {fileID: 41}
  - component: {fileID: 34}
  - component: {fileID: 24}
  m_Name: Barrel
  m_IsActive: 1
--- !u!4 &41
Transform:
  m_GameObject: {fileID: 11}
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: {x: 1.3, y: 0, z: 0}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_Children: []
  m_Father: {fileID: 4}
--- !u!33 &34
MeshFilter:
  m_GameObject: {fileID: 11}
  m_Mesh: {fileID: 4300000, guid: ${GUID.dae}, type: 3}
--- !u!23 &24
MeshRenderer:
  m_GameObject: {fileID: 11}
  m_Enabled: 1
  m_Materials:
  - {fileID: ${unityFileId('Material', 'BarrelMat', 0)}, guid: ${GUID.dae}, type: 3}
`;

function tga(w, h, a, b) {
  const head = Buffer.alloc(18);
  head[2] = 2; head.writeUInt16LE(w, 12); head.writeUInt16LE(h, 14); head[16] = 24; head[17] = 0x20;
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const c = ((x >> 4) + (y >> 4)) % 2 ? a : b;
    const i = (y * w + x) * 3;
    px[i] = c[2]; px[i + 1] = c[1]; px[i + 2] = c[0];
  }
  return Buffer.concat([head, px]);
}

function tarEntry(name, body) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 'utf8');
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136);
  h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

(async () => {
  const checker = Buffer.alloc(64 * 64 * 3);
  for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) {
    const i = (y * 64 + x) * 3;
    const on = ((x >> 3) + (y >> 3)) % 2;
    checker[i] = on ? 240 : 40; checker[i + 1] = on ? 130 : 90; checker[i + 2] = on ? 30 : 200;
  }
  const png = await sharp(checker, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
  const red = Buffer.alloc(64 * 64 * 3);
  for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) {
    const i = (y * 64 + x) * 3;
    const on = ((x >> 3) + (y >> 3)) % 2;
    red[i] = 220; red[i + 1] = on ? 30 : 200; red[i + 2] = on ? 30 : 200;
  }
  const barrelPng = await sharp(red, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
  const native = (guid, id) => `fileFormatVersion: 2\nguid: ${guid}\nNativeFormatImporter:\n  mainObjectFileID: ${id}\n`;
  const entries = [
    [GUID.fbx, 'Assets/Crate/Models/Crate.fbx', fbx7, fbxMeta],
    [GUID.mat, 'Assets/Crate/Materials/Crate.mat', mat, `fileFormatVersion: 2\nguid: ${GUID.mat}\nNativeFormatImporter:\n  mainObjectFileID: 2100000\n`],
    [GUID.png, 'Assets/Crate/Textures/crate.png', png, `fileFormatVersion: 2\nguid: ${GUID.png}\nTextureImporter:\n  textureType: 0\n  mipmaps:\n    sRGBTexture: 1\n`],
    [GUID.prefab, 'Assets/Crate/Prefabs/CrateStack.prefab', prefab, `fileFormatVersion: 2\nguid: ${GUID.prefab}\nPrefabImporter:\n  externalObjects: {}\n`],
    [GUID.old, 'Assets/Crate/Models/OldBox.fbx', fbx6, oldMeta],
    [GUID.tga, 'Assets/Crate/Textures/old.tga', tga(64, 64, [60, 200, 60], [230, 220, 40]), `fileFormatVersion: 2\nguid: ${GUID.tga}\nTextureImporter:\n  textureType: 0\n`],
    [GUID.slab, 'Assets/Crate/Meshes/Slab.asset', slab, native(GUID.slab, 4300000)],
    [GUID.purple, 'Assets/Crate/Materials/Purple.mat', purple, native(GUID.purple, 2100000)],
    [GUID.dae, 'Assets/Crate/Models/Barrel.dae', barrelDae, daeMeta],
    [GUID.barrelPng, 'Assets/Crate/Textures/barrel.png', barrelPng, `fileFormatVersion: 2\nguid: ${GUID.barrelPng}\nTextureImporter:\n  textureType: 0\n  mipmaps:\n    sRGBTexture: 1\n`],
    [GUID.mixed, 'Assets/Crate/Prefabs/Mixed.prefab', mixed, `fileFormatVersion: 2\nguid: ${GUID.mixed}\nPrefabImporter:\n  externalObjects: {}\n`],
  ];
  const parts = [];
  for (const [guid, p, body, meta] of entries) {
    parts.push(tarEntry(`${guid}/asset`, body), tarEntry(`${guid}/asset.meta`, meta), tarEntry(`${guid}/pathname`, `${p}\n00`));
  }
  parts.push(Buffer.alloc(1024));
  const dir = path.join(out, 'Fixture Publisher', '3D ModelsProps');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Crate Kit.unitypackage'), zlib.gzipSync(Buffer.concat(parts)));
  console.log(path.join(dir, 'Crate Kit.unitypackage'));
})();
