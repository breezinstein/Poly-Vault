'use strict';
// FBX 6.x (2006–2010, common in Unity 4-era packages) -> GLB.
//
// three.js' FBXLoader only reads FBX 7+. Rather than patch it, old files are
// converted once on the server into a static GLB the viewer already handles:
// meshes (triangulated, with normals and UVs), per-polygon material groups
// named after the FBX materials (the manifest assigns the real look), and the
// node hierarchy with local transforms. Skinning and takes are not converted.

const zlib = require('zlib');

const MAX_DEPTH = 64;   // real files nest ~6 deep

// --- generic FBX node tree ---------------------------------------------------------
// node: { name, props: [...], children: [node] }

function readBinaryTree(buf) {
  const version = buf.readUInt32LE(23);
  const wide = version >= 7500;
  const nullSize = wide ? 25 : 13;

  function readArray(off, type) {
    const len = buf.readUInt32LE(off);
    const enc = buf.readUInt32LE(off + 4);
    const clen = buf.readUInt32LE(off + 8);
    const size0 = { f: 4, d: 8, l: 8, i: 4, b: 1 }[type];
    if (off + 12 + clen > buf.length) throw new Error(`FBX: array at ${off} runs past the end of the file`);
    let data = buf.subarray(off + 12, off + 12 + clen);
    // Inflate no more than the declared length: a crafted header cannot ask for gigabytes.
    if (enc === 1) data = zlib.inflateSync(data, { maxOutputLength: Math.max(1, len * size0) });
    const out = [];
    const size = { f: 4, d: 8, l: 8, i: 4, b: 1 }[type];
    for (let k = 0; k < len && k * size < data.length; k += 1) {
      const p = k * size;
      if (type === 'f') out.push(data.readFloatLE(p));
      else if (type === 'd') out.push(data.readDoubleLE(p));
      else if (type === 'l') out.push(Number(data.readBigInt64LE(p)));
      else if (type === 'i') out.push(data.readInt32LE(p));
      else out.push(data[p] !== 0);
    }
    return [out, off + 12 + clen];
  }

  function readProps(off, count) {
    const props = [];
    for (let k = 0; k < count; k += 1) {
      const t = String.fromCharCode(buf[off]);
      off += 1;
      if (t === 'Y') { props.push(buf.readInt16LE(off)); off += 2; }
      else if (t === 'C') { props.push(buf[off] !== 0); off += 1; }
      else if (t === 'I') { props.push(buf.readInt32LE(off)); off += 4; }
      else if (t === 'F') { props.push(buf.readFloatLE(off)); off += 4; }
      else if (t === 'D') { props.push(buf.readDoubleLE(off)); off += 8; }
      else if (t === 'L') { props.push(Number(buf.readBigInt64LE(off))); off += 8; }
      else if (t === 'S' || t === 'R') {
        const len = buf.readUInt32LE(off);
        props.push(t === 'S' ? buf.toString('utf8', off + 4, off + 4 + len) : null);
        off += 4 + len;
      } else if ('fdlib'.includes(t)) {
        let arr;
        [arr, off] = readArray(off, t);
        props.push(arr);
      } else throw new Error(`FBX: unknown property type ${t}`);
    }
    return props;
  }

  // Every record must end after it starts and inside its parent, so a corrupt
  // or crafted file fails here instead of looping or allocating forever.
  function readNode(off, limit = buf.length, depth = 0) {
    if (off + nullSize > limit) throw new Error(`FBX: node record at ${off} runs past its parent`);
    const end = wide ? Number(buf.readBigUInt64LE(off)) : buf.readUInt32LE(off);
    if (end === 0) return [null, off + nullSize];
    if (end <= off || end > limit) throw new Error(`FBX: node record at ${off} has a bad end offset (${end})`);
    if (depth > MAX_DEPTH) throw new Error(`FBX: nodes nested deeper than ${MAX_DEPTH}`);
    const numProps = wide ? Number(buf.readBigUInt64LE(off + 8)) : buf.readUInt32LE(off + 4);
    const propLen = wide ? Number(buf.readBigUInt64LE(off + 16)) : buf.readUInt32LE(off + 8);
    const nameLen = buf[off + (wide ? 24 : 12)];
    const nameStart = off + (wide ? 25 : 13);
    const node = { name: buf.toString('ascii', nameStart, nameStart + nameLen), props: [], children: [] };
    const propStart = nameStart + nameLen;
    node.props = readProps(propStart, numProps);
    let c = propStart + propLen;
    while (c < end) {
      const [child, next] = readNode(c, end, depth + 1);
      if (!child) { c = next; break; }
      node.children.push(child);
      c = next;   // > c: readNode only returns ends past the start
    }
    return [node, end];
  }

  const root = { name: '', props: [], children: [] };
  let off = 27;
  while (off < buf.length - nullSize) {
    const end = wide ? Number(buf.readBigUInt64LE(off)) : buf.readUInt32LE(off);
    if (end === 0 || end > buf.length) break;   // end of file, or truncated: keep what was read
    if (end <= off) throw new Error(`FBX: node record at ${off} has a bad end offset (${end})`);
    const [node] = readNode(off);
    root.children.push(node);
    off = end;
  }
  return { version, root };
}

function readAsciiTree(text) {
  // Tokens: names ("Key:"), values (numbers, "strings", bare words), { } and ,
  const re = /"((?:[^"\\]|\\.)*)"|([A-Za-z_][\w|]*)\s*:|([{}])|(-?[\d.]+(?:[eE][-+]?\d+)?)|(\*\d+)|([A-Za-z_][\w|]*)|(,)|;[^\n]*/g;
  const root = { name: '', props: [], children: [] };
  const stack = [root];
  let current = null;
  let m;
  while ((m = re.exec(text))) {
    if (m[2] !== undefined) {
      current = { name: m[2], props: [], children: [] };
      stack[stack.length - 1].children.push(current);
    } else if (m[3] === '{') {
      if (current) stack.push(current);
      current = null;
    } else if (m[3] === '}') {
      if (stack.length > 1) stack.pop();
      current = null;
    } else if (m[1] !== undefined) {
      if (current) current.props.push(m[1]);
    } else if (m[4] !== undefined) {
      if (current) current.props.push(Number(m[4]));
    } else if (m[6] !== undefined) {
      if (current) current.props.push(m[6]);
    }
  }
  // 7.x ASCII arrays are "Key: *N { a: v,v,v }": hoist a: into the parent.
  const hoist = (node) => {
    for (const c of node.children) hoist(c);
    if (node.children.length === 1 && node.children[0].name === 'a') {
      node.props = [node.children[0].props];
      node.children = [];
    }
  };
  hoist(root);
  const ver = (/FBXVersion:\s*(\d+)/.exec(text) || [])[1];
  return { version: Number(ver || 0), root };
}

// Arrays come back as one array prop (binary) or as many scalar props (ascii).
const arr = (node) => {
  if (!node) return [];
  if (node.props.length === 1 && Array.isArray(node.props[0])) return node.props[0];
  return node.props.filter((v) => typeof v === 'number');
};
const child = (node, name) => (node ? node.children.find((c) => c.name === name) : null);
const children = (node, name) => (node ? node.children.filter((c) => c.name === name) : []);
const str = (node) => (node && typeof node.props[0] === 'string' ? node.props[0] : '');
const cleanName = (raw) => {
  const s = String(raw || '');
  if (s.includes('\u0000\u0001')) return s.split('\u0000\u0001')[0];
  const i = s.indexOf('::');
  return i >= 0 ? s.slice(i + 2) : s;
};

// Properties60: Property: "Name", "Type", "Flags", v1, v2, v3
function props60(model) {
  const out = {};
  const block = child(model, 'Properties60') || child(model, 'Properties70');
  for (const p of block ? block.children : []) {
    if (p.name !== 'Property' && p.name !== 'P') continue;
    const name = p.props[0];
    const values = p.props.slice(p.name === 'P' ? 4 : 3).filter((v) => typeof v === 'number');
    out[name] = values;
  }
  return out;
}

// --- mesh extraction ---------------------------------------------------------------

function layerValues(layer, dataName, indexName, polyIdx, vertexIdx, polygonIdx, size) {
  if (!layer) return null;
  const mapping = str(child(layer, 'MappingInformationType'));
  const reference = str(child(layer, 'ReferenceInformationType'));
  const data = arr(child(layer, dataName));
  const index = arr(child(layer, indexName));
  let k;
  if (mapping === 'ByPolygonVertex') k = polyIdx;
  else if (mapping === 'ByVertice' || mapping === 'ByVertex') k = vertexIdx;
  else if (mapping === 'ByPolygon') k = polygonIdx;
  else if (mapping === 'AllSame') k = 0;
  else k = polyIdx;
  if (reference === 'IndexToDirect' || reference === 'Index') k = index[k] ?? 0;
  const out = [];
  for (let c = 0; c < size; c += 1) out.push(data[k * size + c] ?? 0);
  return out;
}

function extractMesh(geomNode) {
  const vertices = arr(child(geomNode, 'Vertices'));
  const polys = arr(child(geomNode, 'PolygonVertexIndex'));
  if (!vertices.length || !polys.length) return null;
  const normalLayer = child(geomNode, 'LayerElementNormal');
  const uvLayer = child(geomNode, 'LayerElementUV');
  const matLayer = child(geomNode, 'LayerElementMaterial');
  const matMapping = matLayer ? str(child(matLayer, 'MappingInformationType')) : 'AllSame';
  const matIdx = matLayer ? arr(child(matLayer, 'Materials')) : [];

  const groups = new Map();   // material index -> { pos, nrm, uv }
  let polyStart = 0;
  let polygon = 0;
  for (let i = 0; i < polys.length; i += 1) {
    if (polys[i] >= 0) continue;
    const corners = [];
    for (let j = polyStart; j <= i; j += 1) {
      const vi = polys[j] < 0 ? -polys[j] - 1 : polys[j];
      corners.push({ vi, pi: j });
    }
    const mi = matMapping === 'AllSame' ? (matIdx[0] || 0) : (matIdx[polygon] || 0);
    if (!groups.has(mi)) groups.set(mi, { pos: [], nrm: [], uv: [] });
    const g = groups.get(mi);
    for (let t = 1; t + 1 < corners.length; t += 1) {
      for (const c of [corners[0], corners[t], corners[t + 1]]) {
        g.pos.push(vertices[c.vi * 3], vertices[c.vi * 3 + 1], vertices[c.vi * 3 + 2]);
        const n = layerValues(normalLayer, 'Normals', 'NormalsIndex', c.pi, c.vi, polygon, 3);
        if (n) g.nrm.push(...n);
        const uv = layerValues(uvLayer, 'UV', 'UVIndex', c.pi, c.vi, polygon, 2);
        // OpenGL-style V, as FBXLoader gives: the viewer's textures use flipY.
        if (uv) g.uv.push(uv[0], uv[1]);
      }
    }
    polyStart = i + 1;
    polygon += 1;
  }
  return groups;
}

// --- scene -------------------------------------------------------------------------

function eulerXYZToQuat(deg) {
  const [x, y, z] = deg.map((d) => (d * Math.PI) / 360);
  const cx = Math.cos(x); const sx = Math.sin(x);
  const cy = Math.cos(y); const sy = Math.sin(y);
  const cz = Math.cos(z); const sz = Math.sin(z);
  // FBX eEulerXYZ: R = Rz * Ry * Rx  ->  q = qz * qy * qx
  return [
    sx * cy * cz - cx * sy * sz,
    cx * sy * cz + sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
}

function buildScene(tree) {
  const objects = child(tree.root, 'Objects');
  const connections = child(tree.root, 'Connections');
  if (!objects) throw new Error('FBX: no Objects section');
  const models = new Map();       // key -> { name, node, geom }
  const geometries = new Map();
  const materials = new Map();
  for (const o of objects.children) {
    const hasId = typeof o.props[0] === 'number';
    const key = hasId ? String(o.props[0]) : String(o.props[0]);
    const name = cleanName(hasId ? o.props[1] : o.props[0]);
    if (o.name === 'Model') models.set(key, { name, node: o, geom: null, children: [], parent: null, materials: [] });
    else if (o.name === 'Geometry') geometries.set(key, o);
    else if (o.name === 'Material') materials.set(key, { name, node: o });
  }
  const links = [];
  for (const c of connections ? connections.children : []) {
    if (c.name !== 'C' && c.name !== 'Connect') continue;
    links.push({ child: String(c.props[1]), parent: String(c.props[2]) });
  }
  for (const { child: ch, parent } of links) {
    const m = models.get(ch);
    const p = models.get(parent);
    if (m && p) { m.parent = p; p.children.push(m); continue; }
    if (geometries.has(ch) && models.has(parent)) models.get(parent).geom = geometries.get(ch);
    if (materials.has(ch) && models.has(parent)) models.get(parent).materials.push(materials.get(ch).name);
  }
  // FBX 6 keeps the geometry inside the Model node itself.
  for (const m of models.values()) if (!m.geom && child(m.node, 'Vertices')) m.geom = m.node;
  return { models, materials };
}

// --- GLB writer --------------------------------------------------------------------

function writeGlb(scene) {
  const gltf = { asset: { version: '2.0', generator: 'Poly Vault FBX6' }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [] };
  const chunks = [];
  let byteLength = 0;
  const addAccessor = (values, type, comps, minmax) => {
    const data = Buffer.from(new Float32Array(values).buffer);
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); byteLength += pad; }
    gltf.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: data.length, target: 34962 });
    chunks.push(data);
    byteLength += data.length;
    const acc = { bufferView: gltf.bufferViews.length - 1, componentType: 5126, count: values.length / comps, type };
    if (minmax) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < values.length; i += 3) for (let c = 0; c < 3; c += 1) {
        min[c] = Math.min(min[c], values[i + c]); max[c] = Math.max(max[c], values[i + c]);
      }
      acc.min = min; acc.max = max;
    }
    gltf.accessors.push(acc);
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
  const addNode = (m) => {
    const p = props60(m.node);
    const node = { name: m.name };
    const t = p['Lcl Translation'];
    const r = p['Lcl Rotation'];
    const s = p['Lcl Scaling'];
    if (t && t.length === 3 && t.some((v) => v !== 0)) node.translation = t;
    if (r && r.length === 3 && r.some((v) => v !== 0)) node.rotation = eulerXYZToQuat(r);
    if (s && s.length === 3 && s.some((v) => v !== 1)) node.scale = s;
    if (m.geom) {
      const groups = extractMesh(m.geom);
      if (groups && groups.size) {
        const primitives = [];
        for (const [mi, g] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
          if (!g.pos.length) continue;
          const attributes = { POSITION: addAccessor(g.pos, 'VEC3', 3, true) };
          if (g.nrm.length === g.pos.length) attributes.NORMAL = addAccessor(g.nrm, 'VEC3', 3, false);
          if (g.uv.length === (g.pos.length / 3) * 2) attributes.TEXCOORD_0 = addAccessor(g.uv, 'VEC2', 2, false);
          primitives.push({ attributes, material: material(m.materials[mi] || m.materials[0] || 'No Name'), mode: 4 });
          triangles += g.pos.length / 9;
        }
        if (primitives.length) {
          gltf.meshes.push({ name: m.name, primitives });
          node.mesh = gltf.meshes.length - 1;
        }
      }
    }
    gltf.nodes.push(node);
    const idx = gltf.nodes.length - 1;
    const kids = m.children.map(addNode);
    if (kids.length) gltf.nodes[idx].children = kids;
    return idx;
  };
  for (const m of scene.models.values()) {
    if (m.parent) continue;
    if (m.name === 'Scene' && !m.geom) { for (const c of m.children) gltf.scenes[0].nodes.push(addNode(c)); continue; }
    gltf.scenes[0].nodes.push(addNode(m));
  }
  if (!gltf.meshes.length) throw new Error('FBX: no meshes found');
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

/** FBX version of a file (binary or ASCII), 0 when unknown. */
function fbxVersion(buf) {
  if (buf.subarray(0, 18).toString('latin1') === 'Kaydara FBX Binary') return buf.readUInt32LE(23);
  return Number((/FBXVersion:\s*(\d+)/.exec(buf.subarray(0, 4096).toString('latin1')) || [])[1] || 0);
}

/** Convert an FBX 6.x file to GLB. */
function convertFbx6(buf) {
  const tree = buf.subarray(0, 18).toString('latin1') === 'Kaydara FBX Binary' ? readBinaryTree(buf) : readAsciiTree(buf.toString('latin1'));
  return writeGlb(buildScene(tree));
}

module.exports = { convertFbx6, fbxVersion, readAsciiTree, readBinaryTree };
