'use strict';
// Reads the *structure* of an FBX file — not its geometry — to answer what
// Unity's importer would ask: which mesh nodes exist, which materials each mesh
// uses (in sub-mesh order), and which texture file feeds each material's
// diffuse / normal slot.
//
// Supports binary FBX (6.x/7.x, 32- and 64-bit record headers) and ASCII FBX
// (7.x ids and 6.x name-based connections). Geometry arrays are skipped by
// offset, never decoded.

const NAME_SEP = '\u0000\u0001';
const MAX_DEPTH = 64;   // real files nest ~6 deep

function cleanName(raw) {
  // binary: "name\0\1Class"; ascii / 6.x: "Class::name"
  if (raw.includes(NAME_SEP)) return raw.split(NAME_SEP)[0];
  const i = raw.indexOf('::');
  return i >= 0 ? raw.slice(i + 2) : raw;
}

const baseName = (file) => String(file || '').split(/[\\/]/).pop();

// --- binary ----------------------------------------------------------------------

function readBinary(buf) {
  const version = buf.readUInt32LE(23);
  const wide = version >= 7500;
  const headerSize = wide ? 25 : 13;
  const objects = [];
  const connections = [];
  let unitScale = 0;

  function readProps(off, count) {
    const props = [];
    for (let k = 0; k < count; k += 1) {
      const t = String.fromCharCode(buf[off]);
      off += 1;
      switch (t) {
        case 'Y': props.push(buf.readInt16LE(off)); off += 2; break;
        case 'C': props.push(buf[off] !== 0); off += 1; break;
        case 'I': props.push(buf.readInt32LE(off)); off += 4; break;
        case 'F': props.push(buf.readFloatLE(off)); off += 4; break;
        case 'D': props.push(buf.readDoubleLE(off)); off += 8; break;
        case 'L': props.push(buf.readBigInt64LE(off).toString()); off += 8; break;
        case 'S':
        case 'R': {
          const len = buf.readUInt32LE(off);
          off += 4;
          props.push(t === 'S' ? buf.toString('utf8', off, off + len) : null);
          off += len;
          break;
        }
        case 'f': case 'd': case 'l': case 'i': case 'b': {
          const compressedLength = buf.readUInt32LE(off + 8);
          off += 12 + compressedLength;   // arrays are geometry: skipped
          props.push(null);
          break;
        }
        default:
          throw new Error(`unknown FBX property type ${t}`);
      }
    }
    return props;
  }

  // Returns [node|null, nextOffset]; children only parsed when `deep`.
  // Every record must end after it starts and inside its parent: a corrupt or
  // crafted file must fail here, never loop (offsets that point backwards or
  // at themselves would otherwise spin or allocate forever).
  function readNode(off, deep, limit = buf.length, depth = 0) {
    if (off + headerSize > limit) throw new Error(`FBX: node record at ${off} runs past its parent`);
    const end = wide ? Number(buf.readBigUInt64LE(off)) : buf.readUInt32LE(off);
    if (end === 0) return [null, off + headerSize];
    if (end <= off || end > limit) throw new Error(`FBX: node record at ${off} has a bad end offset (${end})`);
    if (depth > MAX_DEPTH) throw new Error(`FBX: nodes nested deeper than ${MAX_DEPTH}`);
    const numProps = wide ? Number(buf.readBigUInt64LE(off + 8)) : buf.readUInt32LE(off + 4);
    const propLen = wide ? Number(buf.readBigUInt64LE(off + 16)) : buf.readUInt32LE(off + 8);
    const nameLen = buf[off + (wide ? 24 : 12)];
    const nameStart = off + (wide ? 25 : 13);
    const name = buf.toString('ascii', nameStart, nameStart + nameLen);
    const propStart = nameStart + nameLen;
    const node = { name, props: null, children: [] };
    if (deep) {
      node.props = readProps(propStart, numProps);
      let c = propStart + propLen;
      while (c < end) {
        const [child, next] = readNode(c, deep, end, depth + 1);
        if (!child) break;
        node.children.push(child);
        c = next;   // > c: readNode only returns ends past the start
      }
    }
    return [node, end];
  }

  let off = 27;
  while (off < buf.length - headerSize) {
    let end;
    try { end = wide ? Number(buf.readBigUInt64LE(off)) : buf.readUInt32LE(off); } catch (_) { break; }
    if (end === 0 || end > buf.length) break;   // end of file, or truncated: keep what was read
    if (end <= off) throw new Error(`FBX: node record at ${off} has a bad end offset (${end})`);
    const nameLen = buf[off + (wide ? 24 : 12)];
    const nameStart = off + (wide ? 25 : 13);
    const name = buf.toString('ascii', nameStart, nameStart + nameLen);
    if (name === 'GlobalSettings') {
      const [node] = readNode(off, true);
      const props = (node.children.find((c) => c.name === 'Properties70' || c.name === 'Properties60') || { children: [] }).children;
      for (const p of props) {
        const pp = p.props || [];
        if (pp[0] === 'UnitScaleFactor') unitScale = Number(pp.slice(1).find((v) => typeof v === 'number'));
      }
    }
    if (name === 'Objects' || name === 'Connections') {
      const [node] = readNode(off, true);
      if (name === 'Objects') {
        for (const child of node.children) {
          if (!['Model', 'Material', 'Texture', 'Video', 'Geometry'].includes(child.name)) continue;
          const props = child.props || [];
          // 7.x: (id, name, subtype); 6.x: (name, subtype)
          const hasId = typeof props[0] === 'string' && /^-?\d+$/.test(props[0]) && props.length >= 2;
          const id = hasId ? props[0] : props[0];
          const rawName = hasId ? props[1] : props[0];
          const subtype = hasId ? props[2] : props[1];
          const obj = { cls: child.name, id: String(id), name: cleanName(String(rawName || '')), subtype: String(subtype || '') };
          if (child.name === 'Texture' || child.name === 'Video') {
            for (const p of child.children) {
              if ((p.name === 'RelativeFilename' || p.name === 'FileName' || p.name === 'Filename') && p.props && p.props[0]) {
                obj.file = obj.file || String(p.props[0]);
                if (p.name === 'RelativeFilename') obj.file = String(p.props[0]);
              }
            }
          }
          if (child.name === 'Model' && !hasId) obj.id = String(rawName);   // 6.x uses names as ids
          if (child.name === 'Material' && !hasId) obj.id = String(rawName);
          if (child.name === 'Texture' && !hasId) obj.id = String(rawName);
          objects.push(obj);
        }
      } else {
        for (const c of node.children) {
          const p = c.props || [];
          if (c.name === 'C') connections.push({ type: p[0], child: String(p[1]), parent: String(p[2]), prop: p[3] ? String(p[3]) : '' });
          if (c.name === 'Connect') connections.push({ type: p[0], child: String(p[1]), parent: String(p[2]), prop: p[3] ? String(p[3]) : '' });
        }
      }
    }
    off = end;
  }
  return { version, objects, connections, unitScale };
}

// --- ASCII -----------------------------------------------------------------------

function readAscii(text) {
  const objects = [];
  const connections = [];
  const objRe = /^\s*(Model|Material|Texture|Video|Geometry):\s*(?:(-?\d+),\s*)?"([^"]*)"\s*(?:,\s*"([^"]*)")?\s*\{/gm;
  let m;
  while ((m = objRe.exec(text))) {
    const obj = { cls: m[1], id: m[2] || m[3], name: cleanName(m[3]), subtype: m[4] || '' };
    if (m[1] === 'Texture' || m[1] === 'Video') {
      const body = text.slice(objRe.lastIndex, objRe.lastIndex + 4000);
      const rel = /RelativeFilename:\s*"([^"]*)"/.exec(body);
      const abs = /FileName:\s*"([^"]*)"/i.exec(body);
      obj.file = (rel && rel[1]) || (abs && abs[1]) || '';
    }
    objects.push(obj);
  }
  const conRe = /^\s*(?:C|Connect):\s*"(O[OP])",\s*(-?\d+|"[^"]*"),\s*(-?\d+|"[^"]*")(?:,\s*"([^"]*)")?/gm;
  while ((m = conRe.exec(text))) {
    const unq = (v) => v.replace(/^"|"$/g, '');
    connections.push({ type: m[1], child: unq(m[2]), parent: unq(m[3]), prop: m[4] || '' });
  }
  const unit = /UnitScaleFactor"\s*,\s*"double"\s*,\s*"Number"\s*,\s*""\s*,\s*([\d.eE+-]+)/.exec(text)
    || /Property:\s*"UnitScaleFactor"\s*,\s*"double"\s*,\s*""\s*,\s*([\d.eE+-]+)/.exec(text);
  return { version: 0, objects, connections, unitScale: unit ? Number(unit[1]) : 0 };
}

// --- summary -------------------------------------------------------------------

/**
 * @returns {{ok:boolean, error?:string, meshes:{name:string, materials:string[]}[],
 *   materials:{name:string, diffuse:string|null, normal:string|null}[],
 *   textures:string[], models:string[], hasGeometry:boolean}}
 */
function scanFbx(buffer) {
  let raw;
  try {
    raw = buffer.subarray(0, 18).toString('latin1') === 'Kaydara FBX Binary'
      ? readBinary(buffer)
      : readAscii(buffer.toString('utf8'));
  } catch (err) {
    return { ok: false, error: err.message, meshes: [], materials: [], textures: [], models: [], hasGeometry: false };
  }
  const byId = new Map(raw.objects.map((o) => [o.id, o]));
  // 6.x names are "Class::name" ids: index those too.
  for (const o of raw.objects) byId.set(`${o.cls}::${o.name}`, o);
  const get = (id) => byId.get(id) || null;

  const matsOfModel = new Map();
  const texOfMat = new Map();      // material id -> { diffuse, normal, any }
  const fileOfTex = new Map();     // texture id -> file
  const geomOfModel = new Set();
  for (const o of raw.objects) if (o.cls === 'Texture' && o.file) fileOfTex.set(o.id, o.file);
  for (const c of raw.connections) {
    const child = get(c.child);
    const parent = get(c.parent);
    if (!child || !parent) continue;
    if (child.cls === 'Material' && parent.cls === 'Model') {
      (matsOfModel.get(parent.id) || matsOfModel.set(parent.id, []).get(parent.id)).push(child.name);
    } else if (child.cls === 'Geometry' && parent.cls === 'Model') {
      geomOfModel.add(parent.id);
    } else if (child.cls === 'Video' && parent.cls === 'Texture' && child.file && !fileOfTex.has(parent.id)) {
      fileOfTex.set(parent.id, child.file);
    }
  }
  // FBX 6 often connects textures to the mesh node, not the material.
  const texOfModel = new Map();
  for (const c of raw.connections) {
    const child = get(c.child);
    const parent = get(c.parent);
    if (!child || !parent || child.cls !== 'Texture' || parent.cls !== 'Model') continue;
    const file = baseName(fileOfTex.get(child.id) || child.name);
    if (!/\.(png|jpe?g|tga|psd|tiff?|bmp|gif|exr|hdr|dds)$/i.test(file)) continue;
    (texOfModel.get(parent.id) || texOfModel.set(parent.id, []).get(parent.id)).push(file);
  }
  for (const c of raw.connections) {
    const child = get(c.child);
    const parent = get(c.parent);
    if (!child || !parent || child.cls !== 'Texture' || parent.cls !== 'Material') continue;
    const slot = texOfMat.get(parent.id) || { diffuse: null, normal: null, any: null };
    const file = baseName(fileOfTex.get(child.id) || child.name);
    // Procedural maps (3ds Max "Color_Correction", Falloff, ...) have no file.
    if (!/\.(png|jpe?g|tga|psd|tiff?|bmp|gif|exr|hdr|dds)$/i.test(file)) continue;
    const prop = c.prop.toLowerCase();
    if (/normal|bump/.test(prop)) slot.normal = slot.normal || file;
    else if (/diffuse|base.?color|albedo/.test(prop) || !prop) slot.diffuse = slot.diffuse || file;
    slot.any = slot.any || file;
    texOfMat.set(parent.id, slot);
  }

  // Materials without their own diffuse inherit the texture(s) of the mesh
  // they are on: one texture -> every material; N textures for N materials ->
  // by order.
  const byName = new Map(raw.objects.filter((o) => o.cls === 'Material').map((o) => [o.name, o.id]));
  for (const [modelId, files] of texOfModel) {
    const mats = matsOfModel.get(modelId) || [];
    mats.forEach((matName, i) => {
      const id = byName.get(matName);
      if (!id) return;
      const slot = texOfMat.get(id) || { diffuse: null, normal: null, any: null };
      if (slot.diffuse) return;
      const file = files.length === 1 ? files[0] : (files.length === mats.length ? files[i] : null);
      if (!file) return;
      slot.diffuse = file;
      texOfMat.set(id, slot);
    });
  }

  const meshes = raw.objects
    .filter((o) => o.cls === 'Model' && (o.subtype === 'Mesh' || geomOfModel.has(o.id)))
    .map((o) => ({ name: o.name, materials: matsOfModel.get(o.id) || [] }));
  const materials = raw.objects.filter((o) => o.cls === 'Material').map((o) => {
    const t = texOfMat.get(o.id) || {};
    return { name: o.name, diffuse: t.diffuse || null, normal: t.normal || null };
  });
  const textures = [...new Set([...fileOfTex.values()].map(baseName).filter(Boolean))];
  return {
    ok: true,
    version: raw.version,
    meshes,
    materials,
    textures,
    models: raw.objects.filter((o) => o.cls === 'Model').map((o) => o.name),
    hasGeometry: meshes.length > 0 || raw.objects.some((o) => o.cls === 'Geometry'),
    unitScale: raw.unitScale > 0 ? raw.unitScale : 0,
  };
}

module.exports = { scanFbx };
