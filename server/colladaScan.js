'use strict';
// Collada (.dae) structure for the material resolver: which nodes carry
// geometry, which materials each uses (in primitive order, as three.js's
// ColladaLoader builds its material array), and which image files the
// materials' diffuse / bump slots point at. Geometry itself is loaded in the
// browser by ColladaLoader.
//
// Naming follows the loader: a node's mesh takes the node's `name`, a material
// its `name` (falling back to the id, as Unity does).

/** Tiny XML reader: elements with attributes, children and text. */
function parseXml(text) {
  const root = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) { top.text += m[1]; continue; }
    if (m[2]) {
      const tag = local(m[2]);
      for (let i = stack.length - 1; i > 0; i -= 1) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    if (m[3]) {
      const el = { tag: local(m[3]), attrs: {}, children: [], text: '' };
      const ar = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(m[4] || ''))) el.attrs[local(a[1])] = decode(a[2] !== undefined ? a[2] : a[3]);
      top.children.push(el);
      if (!m[5]) stack.push(el);
      continue;
    }
    if (m[6] && top.children.length === 0) top.text += m[6];
  }
  return root;
}
const local = (n) => n.replace(/^.*:/, '');
const decode = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function* walk(el) {
  yield el;
  for (const c of el.children) yield* walk(c);
}
const find = (el, tag) => { for (const e of walk(el)) if (e !== el && e.tag === tag) return e; return null; };
const findAll = (el, tag) => [...walk(el)].filter((e) => e !== el && e.tag === tag);
const kids = (el, tag) => el.children.filter((c) => c.tag === tag);
const idRef = (s) => String(s || '').replace(/^#/, '');
const baseName = (p) => {
  const clean = decodeURIComponent(String(p || '').trim().replace(/^file:\/+/, ''));
  return clean.split(/[\\/]/).pop() || null;
};

/**
 * @returns {{ok:boolean, meshes:{name:string, materials:string[]}[], materials:{name:string, diffuse:string|null, normal:string|null}[],
 *            textures:string[], models:string[], hasGeometry:boolean, unitScale:number, upAxis:string, error?:string}}
 */
function scanCollada(buffer) {
  try {
    const xml = parseXml(buffer.toString('utf8'));
    const doc = find(xml, 'COLLADA');
    if (!doc) throw new Error('not a Collada file');

    const unit = find(find(doc, 'asset') || doc, 'unit');
    const meter = unit ? Number(unit.attrs.meter) : 1;
    const up = find(find(doc, 'asset') || doc, 'up_axis');

    // images: id -> file name
    const images = new Map();
    for (const img of findAll(doc, 'image')) {
      const init = find(img, 'init_from');
      const ref = init ? (find(init, 'ref') || init).text : '';
      if (img.attrs.id && ref.trim()) images.set(img.attrs.id, baseName(ref));
    }

    // effects: id -> { diffuse, normal } (via sampler -> surface -> image)
    const effects = new Map();
    for (const fx of findAll(doc, 'effect')) {
      const params = new Map();
      for (const np of findAll(fx, 'newparam')) {
        const sampler = find(np, 'sampler2D');
        const surface = find(np, 'surface');
        if (sampler) { const src = find(sampler, 'source'); const inst = find(sampler, 'instance_image'); params.set(np.attrs.sid, { source: src ? src.text.trim() : null, image: inst ? idRef(inst.attrs.url) : null }); }
        if (surface) { const init = find(surface, 'init_from'); params.set(np.attrs.sid, { image: init ? init.text.trim() : null }); }
      }
      const imageOf = (texAttr) => {
        let key = texAttr;
        for (let hop = 0; hop < 4 && key; hop += 1) {
          if (images.has(key)) return images.get(key);
          const p = params.get(key);
          if (!p) break;
          key = p.image || p.source;
        }
        return images.get(texAttr) || null;
      };
      const slot = (name) => {
        const s = find(fx, name);
        const t = s && find(s, 'texture');
        return t ? imageOf(t.attrs.texture) : null;
      };
      const bump = findAll(fx, 'bump').map((b) => find(b, 'texture')).find(Boolean);
      effects.set(fx.attrs.id, { diffuse: slot('diffuse'), normal: (bump && imageOf(bump.attrs.texture)) || slot('normal') });
    }

    // materials: id -> { name, diffuse, normal }
    const matById = new Map();
    for (const mat of findAll(find(doc, 'library_materials') || { children: [] }, 'material')) {
      const ie = find(mat, 'instance_effect');
      const fx = (ie && effects.get(idRef(ie.attrs.url))) || {};
      matById.set(mat.attrs.id, { name: mat.attrs.name || mat.attrs.id || '', diffuse: fx.diffuse || null, normal: fx.normal || null });
    }

    // geometries: id -> material symbols in primitive order
    const geoSymbols = new Map();
    for (const geo of findAll(doc, 'geometry')) {
      const mesh = find(geo, 'mesh');
      if (!mesh) continue;
      const symbols = [];
      for (const prim of mesh.children) {
        if (!/^(triangles|polylist|polygons|trifans|tristrips)$/.test(prim.tag)) continue;
        const s = prim.attrs.material || '';
        if (!symbols.includes(s)) symbols.push(s);
      }
      geoSymbols.set(geo.attrs.id, symbols);
    }
    const controllerGeo = new Map();
    for (const c of findAll(doc, 'controller')) {
      const skin = find(c, 'skin') || find(c, 'morph');
      if (skin) controllerGeo.set(c.attrs.id, idRef(skin.attrs.source));
    }

    const meshes = [];
    const models = [];
    const scene = find(doc, 'library_visual_scenes') || doc;
    for (const node of findAll(scene, 'node')) {
      const name = node.attrs.name || node.attrs.id || '';
      models.push(name);
      const instances = [...kids(node, 'instance_geometry'), ...kids(node, 'instance_controller')];
      if (!instances.length) continue;
      const materials = [];
      for (const inst of instances) {
        const geoId = inst.tag === 'instance_controller' ? controllerGeo.get(idRef(inst.attrs.url)) : idRef(inst.attrs.url);
        const bind = new Map(findAll(inst, 'instance_material').map((im) => [im.attrs.symbol, idRef(im.attrs.target)]));
        for (const sym of geoSymbols.get(geoId) || []) {
          const mat = matById.get(bind.get(sym) || sym);
          const n = mat ? mat.name : sym;
          if (!materials.includes(n)) materials.push(n);
        }
      }
      meshes.push({ name, materials });
    }
    const materials = [...matById.values()];
    const textures = [...new Set([...images.values()].filter(Boolean))];
    return {
      ok: true,
      meshes,
      materials,
      textures,
      models,
      hasGeometry: geoSymbols.size > 0,
      unitScale: Number.isFinite(meter) && meter > 0 ? meter * 100 : 100,
      upAxis: up ? up.text.trim() : 'Y_UP',
    };
  } catch (err) {
    return { ok: false, error: err.message, meshes: [], materials: [], textures: [], models: [], hasGeometry: true };
  }
}

module.exports = { scanCollada, parseXml };
