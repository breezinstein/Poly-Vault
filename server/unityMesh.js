'use strict';
// Unity mesh assets (`.asset` files holding `--- !u!43` Mesh objects, text
// serialisation) -> GLB the browser can load.
//
// Some Asset Store packs ship their geometry this way instead of as FBX.
// The vertex buffer is stored as hex (`_typelessdata`) with a channel table
// describing the layout; the index buffer is hex too. Unity 2019+ has 14
// channels (position, normal, tangent, color, uv0-7, weights, indices);
// Unity 5-2018 has 8 (position, normal, color, uv0-3, tangent); Unity 4 has 6
// plus an explicit stream table. Compressed meshes (m_MeshCompression > 0)
// keep their data in m_CompressedMesh and are not read.
//
// Output is in the same space as the FBX models the viewer loads: Unity's
// left-handed coordinates mirrored on X (so prefab transforms apply the same
// way), with OpenGL-style UVs (the viewer's textures use flipY).

const { parseDocuments } = require('./unityYaml');
const { buildGlb } = require('./glbWriter');

// Channel slots by layout.
const LAYOUT_2019 = { position: 0, normal: 1, uv: 4 };
const LAYOUT_5 = { position: 0, normal: 1, uv: 3 };

// Bytes per component and reader, by format code and layout era.
function formatInfo(code, modern) {
  if (modern) {
    switch (code) {
      case 0: return { size: 4, read: (b, o) => b.readFloatLE(o) };
      case 1: return { size: 2, read: (b, o) => half(b.readUInt16LE(o)) };
      case 2: return { size: 1, read: (b, o) => b[o] / 255 };
      case 3: return { size: 1, read: (b, o) => Math.max(b.readInt8(o) / 127, -1) };
      case 4: return { size: 2, read: (b, o) => b.readUInt16LE(o) / 65535 };
      case 5: return { size: 2, read: (b, o) => Math.max(b.readInt16LE(o) / 32767, -1) };
      case 6: return { size: 1, read: (b, o) => b[o] };
      case 7: return { size: 1, read: (b, o) => b.readInt8(o) };
      case 8: return { size: 2, read: (b, o) => b.readUInt16LE(o) };
      case 9: return { size: 2, read: (b, o) => b.readInt16LE(o) };
      case 10: return { size: 4, read: (b, o) => b.readUInt32LE(o) };
      case 11: return { size: 4, read: (b, o) => b.readInt32LE(o) };
      default: return null;
    }
  }
  switch (code) {
    case 0: return { size: 4, read: (b, o) => b.readFloatLE(o) };
    case 1: return { size: 2, read: (b, o) => half(b.readUInt16LE(o)) };
    case 2: return { size: 1, read: (b, o) => b[o] / 255 };
    case 3: return { size: 1, read: (b, o) => b[o] };
    case 4: return { size: 4, read: (b, o) => b.readUInt32LE(o) };
    default: return null;
  }
}

function half(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const hex = (v) => (typeof v === 'string' && /^[0-9a-fA-F]*$/.test(v.trim()) ? Buffer.from(v.trim(), 'hex') : Buffer.alloc(0));
const list = (v) => (Array.isArray(v) ? v : []);

/** Decode one Mesh document body into arrays. Throws with a readable reason. */
function decodeMesh(body) {
  const vd = body.m_VertexData || {};
  const count = num(vd.m_VertexCount);
  const data = hex(vd._typelessdata);
  if (!count || !data.length) {
    if (num(body.m_MeshCompression) > 0) throw new Error('mesh uses Unity mesh compression (not supported)');
    throw new Error('mesh has no vertex data');
  }
  const channels = list(vd.m_Channels).map((c) => ({
    stream: num(c.stream), offset: num(c.offset), format: num(c.format), dim: num(c.dimension) & 0xf,
  }));
  const modern = channels.length >= 14;
  const layout = modern ? LAYOUT_2019 : LAYOUT_5;

  // Where each stream starts and its stride.
  const streams = [];
  const explicit = list(vd.m_Streams);
  if (explicit.length) {
    explicit.forEach((s, i) => { streams[i] = { offset: num(s.offset), stride: num(s.stride) }; });
  } else {
    const nStreams = channels.reduce((m, c) => (c.dim ? Math.max(m, c.stream + 1) : m), 0);
    let offset = 0;
    for (let s = 0; s < nStreams; s += 1) {
      let stride = 0;
      for (const c of channels) {
        if (c.stream !== s || !c.dim) continue;
        const f = formatInfo(c.format, modern);
        if (f) stride = Math.max(stride, c.offset + f.size * c.dim);
      }
      streams[s] = { offset, stride };
      offset += stride * count;
      offset = (offset + 15) & ~15;
    }
  }

  // m_VertexCount comes from the file: never trust it beyond what the vertex
  // data can hold (a crafted count would otherwise allocate gigabytes below).
  for (const st of streams) {
    if (st && st.stride && st.offset + st.stride * count > data.length) {
      throw new Error(`vertex count ${count} does not fit the ${data.length}-byte vertex data`);
    }
  }
  if (!streams.some((st) => st && st.stride)) throw new Error('mesh has no vertex streams');

  const readChannel = (slot, want) => {
    const c = channels[slot];
    if (!c || !c.dim) return null;
    const f = formatInfo(c.format, modern);
    const st = streams[c.stream];
    if (!f || !st || !st.stride) return null;
    const out = new Float32Array(count * want);
    for (let v = 0; v < count; v += 1) {
      const base = st.offset + v * st.stride + c.offset;
      for (let k = 0; k < want; k += 1) {
        const o = base + k * f.size;
        out[v * want + k] = k < c.dim && o + f.size <= data.length ? f.read(data, o) : 0;
      }
    }
    return out;
  };

  const positions = readChannel(layout.position, 3);
  if (!positions) throw new Error('mesh has no positions');
  const normals = readChannel(layout.normal, 3);
  const uvs = readChannel(layout.uv, 2);
  // Unity (left-handed) -> the viewer's model space: mirror X.
  for (let i = 0; i < positions.length; i += 3) positions[i] = -positions[i];
  if (normals) for (let i = 0; i < normals.length; i += 3) normals[i] = -normals[i];

  const ib = hex(body.m_IndexBuffer);
  const wide = num(body.m_IndexFormat) === 1;
  const isz = wide ? 4 : 2;
  const index = (i) => (wide ? ib.readUInt32LE(i * isz) : ib.readUInt16LE(i * isz));
  const nIdx = Math.floor(ib.length / isz);

  const submeshes = list(body.m_SubMeshes).map((sm) => {
    const first = sm.firstByte !== undefined ? Math.floor(num(sm.firstByte) / isz) : num(sm.firstIndex);
    const n = num(sm.indexCount);
    const baseVertex = num(sm.baseVertex);
    const topology = num(sm.topology);
    const tri = [];
    const at = (i) => index(first + i) + baseVertex;
    if (first + n > nIdx) return new Uint32Array(0);
    if (topology === 0) {
      // Mirroring X flips handedness: swap the winding to keep faces outward.
      for (let i = 0; i + 2 < n; i += 3) tri.push(at(i), at(i + 2), at(i + 1));
    } else if (topology === 2) {
      for (let i = 0; i + 3 < n; i += 4) tri.push(at(i), at(i + 2), at(i + 1), at(i), at(i + 3), at(i + 2));
    }
    return tri.every((x) => x < count) ? Uint32Array.from(tri) : new Uint32Array(0);
  });
  return { count, positions, normals, uvs, submeshes };
}

/** Is this buffer a text-serialised Unity asset containing meshes? */
function isMeshAsset(buffer) {
  const head = buffer.subarray(0, 64).toString('latin1');
  if (!head.startsWith('%YAML')) return { ok: false, error: buffer.length ? 'stored in binary form (Unity 4) — not shown' : 'empty file' };
  return { ok: /^--- !u!43 &/m.test(buffer.toString('latin1')), error: 'not a mesh asset' };
}

/** Mesh documents in an asset: [{fileID, name, body}] */
function meshDocuments(buffer) {
  const check = isMeshAsset(buffer);
  if (!check.ok) throw new Error(check.error);
  return parseDocuments(buffer.toString('utf8'))
    .filter((d) => d.classId === 43 && !d.stripped)
    .map((d) => ({ fileID: d.fileID, name: String(d.body.m_Name || `Mesh ${d.fileID}`), body: d.body }));
}

/**
 * Structure for the material resolver: one mesh per Mesh object, one material
 * slot per submesh. `fileIds` maps a Mesh's fileID to its name (prefabs refer
 * to meshes by fileID).
 */
function meshAssetStructure(buffer) {
  try {
    const docs = meshDocuments(buffer);
    if (!docs.length) return { ok: false, error: 'no meshes in this asset', meshes: [], materials: [], textures: [], models: [], hasGeometry: false };
    const meshes = docs.map((d) => ({ name: d.name, materials: list(d.body.m_SubMeshes).map((_, i) => `${d.name} (submesh ${i})`), fileID: d.fileID }));
    return {
      ok: true,
      meshAsset: true,
      meshes,
      materials: [],
      textures: [],
      models: meshes.map((m) => m.name),
      fileIds: Object.fromEntries(docs.map((d) => [d.fileID, d.name])),
      hasGeometry: true,
      unitScale: 100,
    };
  } catch (err) {
    return { ok: false, error: err.message, meshes: [], materials: [], textures: [], models: [], hasGeometry: true };
  }
}

/** Convert every Mesh in the asset to one GLB (a root node per mesh). */
function convertMeshAsset(buffer) {
  const docs = meshDocuments(buffer);
  const meshes = [];
  const errors = [];
  for (const d of docs) {
    try {
      const m = decodeMesh(d.body);
      const primitives = m.submeshes
        .map((indices, i) => ({ positions: m.positions, normals: m.normals, uvs: m.uvs, indices, material: `${d.name} (submesh ${i})` }))
        .filter((p) => p.indices.length);
      if (primitives.length) meshes.push({ name: d.name, primitives });
    } catch (err) {
      errors.push(`${d.name}: ${err.message}`);
    }
  }
  if (!meshes.length) throw new Error(errors[0] || 'no meshes in this asset');
  return { ...buildGlb(meshes, 'Poly Vault Unity mesh'), errors };
}

module.exports = { convertMeshAsset, meshAssetStructure, decodeMesh, isMeshAsset, half };
