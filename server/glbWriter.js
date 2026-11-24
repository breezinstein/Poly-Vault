'use strict';
// Minimal glTF 2.0 binary writer for converted meshes: one root node per mesh,
// indexed triangle primitives (one per material slot) sharing the mesh's
// vertex arrays. Materials are placeholders named after the slot; the viewer
// replaces them with the resolved Unity materials.

/**
 * @param {{name:string, primitives:{positions:Float32Array, normals?:Float32Array|null,
 *          uvs?:Float32Array|null, indices:Uint32Array, material:string}[]}[]} meshes
 * @returns {{glb:Buffer, triangles:number, meshes:number}}
 */
function buildGlb(meshes, generator = 'Poly Vault') {
  const gltf = { asset: { version: '2.0', generator }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [] };
  const chunks = [];
  let byteLength = 0;
  const push = (buf, target) => {
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); byteLength += pad; }
    gltf.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: buf.length, target });
    chunks.push(buf);
    byteLength += buf.length;
    return gltf.bufferViews.length - 1;
  };
  const accessorOf = new Map();
  const floats = (arr, type, comps, minmax) => {
    if (accessorOf.has(arr)) return accessorOf.get(arr);
    const view = push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength), 34962);
    const acc = { bufferView: view, componentType: 5126, count: arr.length / comps, type };
    if (minmax) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < arr.length; i += 3) for (let c = 0; c < 3; c += 1) {
        if (arr[i + c] < min[c]) min[c] = arr[i + c];
        if (arr[i + c] > max[c]) max[c] = arr[i + c];
      }
      acc.min = min; acc.max = max;
    }
    gltf.accessors.push(acc);
    accessorOf.set(arr, gltf.accessors.length - 1);
    return gltf.accessors.length - 1;
  };
  const materialIndex = new Map();
  const material = (name) => {
    if (!materialIndex.has(name)) {
      gltf.materials.push({ name, pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 0.7 } });
      materialIndex.set(name, gltf.materials.length - 1);
    }
    return materialIndex.get(name);
  };

  let triangles = 0;
  for (const m of meshes) {
    const primitives = [];
    for (const p of m.primitives) {
      if (!p.indices.length || !p.positions.length) continue;
      const attributes = { POSITION: floats(p.positions, 'VEC3', 3, true) };
      if (p.normals && p.normals.length === p.positions.length) attributes.NORMAL = floats(p.normals, 'VEC3', 3, false);
      if (p.uvs && p.uvs.length === (p.positions.length / 3) * 2) attributes.TEXCOORD_0 = floats(p.uvs, 'VEC2', 2, false);
      const iv = push(Buffer.from(p.indices.buffer, p.indices.byteOffset, p.indices.byteLength), 34963);
      gltf.accessors.push({ bufferView: iv, componentType: 5125, count: p.indices.length, type: 'SCALAR' });
      primitives.push({ attributes, indices: gltf.accessors.length - 1, material: material(p.material), mode: 4 });
      triangles += p.indices.length / 3;
    }
    if (!primitives.length) continue;
    gltf.meshes.push({ name: m.name, primitives });
    gltf.nodes.push({ name: m.name, mesh: gltf.meshes.length - 1 });
    gltf.scenes[0].nodes.push(gltf.nodes.length - 1);
  }
  if (!gltf.meshes.length) throw new Error('no meshes to write');
  const bin = Buffer.concat(chunks);
  const binPadded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  gltf.buffers.push({ byteLength: binPadded.length });
  const json = Buffer.from(JSON.stringify(gltf));
  const jsonPadded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binPadded.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonPadded.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(binPadded.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return { glb: Buffer.concat([header, jh, jsonPadded, bh, binPadded]), triangles, meshes: gltf.meshes.length };
}

module.exports = { buildGlb };
