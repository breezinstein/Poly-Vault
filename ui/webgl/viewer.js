// Optional WebGL model preview (three.js), loaded on demand by the renderer.
//
// Vendored by scripts/fetch-webgl.sh — nothing is fetched from a CDN, so this
// works offline and inside the app's strict CSP. The caller decides whether to
// use it (Settings → "3D model preview"); when disabled we never download these
// modules at all.
//
// Two entry points:
//   mount(container, url, name)          a bare model, neutral material
//   mountUnity(container, {path, entry}) the model as Unity shows it: the
//       server's manifest says which material every sub-mesh uses (remaps,
//       prefabs, Unity's search rules, embedded FBX materials) and serves the
//       textures converted for the browser. A fidelity badge says how close
//       that is to Unity, and why.

import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { OBJLoader } from './vendor/OBJLoader.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { STLLoader } from './vendor/STLLoader.js';
import { PLYLoader } from './vendor/PLYLoader.js';
import { FBXLoader } from './vendor/FBXLoader.js';
import { GLTFExporter } from './vendor/GLTFExporter.js';
import { ColladaLoader } from './vendor/ColladaLoader.js';
import { mergeGeometries } from './vendor/BufferGeometryUtils.js';

const EXT = (path) => (/\.([A-Za-z0-9]+)$/.exec(path || '') || [])[1]?.toLowerCase() || '';
const sanitize = (name) => THREE.PropertyBinding.sanitizeNodeName(String(name || ''));
// 1x1 transparent PNG: what unmatched texture references inside a model load,
// so a missing file never turns into a 404 storm.
const BLANK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function fitCamera(camera, controls, object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;

  object.position.sub(center); // centre at the origin

  const fov = (camera.fov * Math.PI) / 180;
  const distance = (radius / Math.sin(fov / 2)) * 1.35;
  camera.position.set(distance * 0.85, distance * 0.6, distance);
  camera.near = Math.max(distance / 1000, 0.001);
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();
}

// Collada: ColladaLoader leaves a mesh unnamed when its node also has child
// nodes; Unity (and the manifest) name it after the node.
function parseCollada(text, manager) {
  const collada = new ColladaLoader(manager).parse(text, '');
  const object = collada.scene;
  object.traverse((n) => { if (n.isMesh && !n.name && n.parent) n.name = n.parent.name; });
  return { object, animations: object.animations || [] };
}

async function loadModel(url, ext, manager) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  if (ext === 'dae') return parseCollada(await res.text(), manager);

  if (ext === 'obj') {
    const text = await res.text();
    return { object: new OBJLoader(manager).parse(text), animations: [] };
  }
  if (ext === 'glb' || ext === 'gltf') {
    const buf = await res.arrayBuffer();
    const gltf = await new GLTFLoader(manager).parseAsync(buf, '');
    return { object: gltf.scene || gltf.scenes?.[0] || new THREE.Group(), animations: gltf.animations || [] };
  }
  if (ext === 'stl') {
    const mesh = new THREE.Mesh(new STLLoader(manager).parse(await res.arrayBuffer()), new THREE.MeshStandardMaterial({ color: 0xbfc4cc, metalness: 0.1, roughness: 0.7 }));
    return { object: mesh, animations: [] };
  }
  if (ext === 'ply') {
    const geometry = new PLYLoader(manager).parse(await res.arrayBuffer());
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xbfc4cc, vertexColors: geometry.hasAttribute('color'), metalness: 0.1, roughness: 0.7 }));
    return { object: mesh, animations: [] };
  }
  if (ext === 'fbx') {
    const object = new FBXLoader(manager).parse(await res.arrayBuffer(), '');
    return { object, animations: object.animations || [] };
  }
  throw new Error(`no viewer for .${ext}`);
}

function countTriangles(object) {
  let n = 0;
  object.traverse((node) => {
    if (node.isMesh && node.geometry) {
      const g = node.geometry;
      n += (g.index ? g.index.count : (g.attributes.position?.count || 0)) / 3;
    }
  });
  return Math.round(n);
}

// --- the 3D stage (shared by both entry points) --------------------------------

function createStage(container, height) {
  const width = () => Math.max(container.clientWidth, 320);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width(), height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  scene.background = null;
  const camera = new THREE.PerspectiveCamera(45, width() / height, 0.01, 10000);

  // A neutral studio: sky/ground fill, a key and a cool rim — close to Unity's
  // default scene lighting, so colours read the same.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3c44, 1.6));
  const key = new THREE.DirectionalLight(0xfff4e8, 2.4);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8899ff, 0.9);
  rim.position.set(-4, 2, -3);
  scene.add(rim);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  container.innerHTML = '';
  container.appendChild(renderer.domElement);
  const note = document.createElement('div');
  note.className = 'entry-webgl-note';
  note.textContent = 'loading model…';
  container.appendChild(note);

  const clock = new THREE.Clock();
  let mixer = null;
  let disposed = false;
  let frame = 0;
  const tick = () => {
    if (disposed) return;
    const dt = clock.getDelta();
    if (mixer) mixer.update(dt);
    controls.update();
    renderer.render(scene, camera);
    frame = requestAnimationFrame(tick);
  };
  const onResize = () => {
    renderer.setSize(width(), height, false);
    camera.aspect = width() / height;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', onResize);

  return {
    renderer, scene, camera, controls, note,
    get disposed() { return disposed; },
    setMixer(m) { mixer = m; },
    start() { tick(); },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      controls.dispose();
      const textures = new Set();
      scene.traverse((node) => {
        if (!node.isMesh) return;
        node.geometry?.dispose?.();
        for (const m of Array.isArray(node.material) ? node.material : [node.material]) {
          if (!m) continue;
          for (const v of Object.values(m)) if (v && v.isTexture) textures.add(v);
          m.dispose?.();
        }
      });
      for (const t of textures) t.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    },
  };
}

/**
 * Mounts a 3D preview of a bare model (neutral material).
 * @returns {Promise<{dispose:()=>void, triangles:number}>}
 */
export async function mount(container, url, name) {
  const stage = createStage(container, 320);
  const { object } = await loadModel(url, EXT(name));
  if (stage.disposed) return { dispose() {}, triangles: 0 };
  const material = new THREE.MeshStandardMaterial({ color: 0xcfd4dc, metalness: 0.05, roughness: 0.75 });
  object.traverse((node) => { if (node.isMesh && !Array.isArray(node.material)) node.material = material; });
  stage.scene.add(object);
  fitCamera(stage.camera, stage.controls, object);
  stage.start();
  stage.note.remove();
  return { triangles: countTriangles(object), dispose: () => stage.dispose() };
}

// --- Unity materials -----------------------------------------------------------

function materialFactory(manifest) {
  const loader = new THREE.TextureLoader();
  const images = new Map();      // texKey -> base texture (one download)
  const built = new Map();       // matKey + variant -> material

  function texture(slot) {
    if (!slot || !slot.tex || !manifest.textures[slot.tex]) return null;
    const info = manifest.textures[slot.tex];
    let base = images.get(slot.tex);
    if (!base) {
      base = loader.load(info.url);
      base.colorSpace = info.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      base.wrapS = THREE.RepeatWrapping;
      base.wrapT = THREE.RepeatWrapping;
      base.anisotropy = 4;
      images.set(slot.tex, base);
    }
    const s = slot.s || [1, 1];
    const o = slot.o || [0, 0];
    if (s[0] === 1 && s[1] === 1 && o[0] === 0 && o[1] === 0) return base;
    const t = base.clone();            // shares the image, own tiling
    t.repeat.set(s[0], s[1]);
    t.offset.set(o[0], o[1]);
    t.needsUpdate = true;
    return t;
  }

  function create(spec, vertexColors) {
    const common = {
      name: spec.name || '',
      side: spec.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
      vertexColors: Boolean(vertexColors),
    };
    const color = new THREE.Color().setRGB(spec.color[0], spec.color[1], spec.color[2], THREE.SRGBColorSpace);
    const map = texture(spec.maps.map);
    let m;
    if (spec.unlit) {
      m = new THREE.MeshBasicMaterial({ ...common, color, map });
    } else {
      m = new THREE.MeshStandardMaterial({
        ...common,
        color,
        map,
        metalness: spec.metalness,
        roughness: spec.roughness,
      });
      const normal = texture(spec.maps.normalMap);
      if (normal) {
        m.normalMap = normal;
        const k = spec.maps.normalMap.scale ?? 1;
        m.normalScale.set(k, k);
      }
      const orm = texture(spec.maps.ormMap);
      if (orm) {
        m.roughnessMap = orm;
        m.metalnessMap = orm;
        if (spec.aoMap) { m.aoMap = orm; m.aoMapIntensity = 1; }
      }
      if (spec.emissive) {
        m.emissive = new THREE.Color().setRGB(spec.emissive[0], spec.emissive[1], spec.emissive[2], THREE.SRGBColorSpace);
        m.emissiveIntensity = spec.emissiveIntensity || 1;
        m.emissiveMap = texture(spec.maps.emissiveMap);
      }
    }
    if (spec.alpha === 'mask') {
      m.alphaTest = spec.cutoff ?? 0.5;
    } else if (spec.alpha === 'blend') {
      m.transparent = true;
      m.opacity = spec.color[3] ?? 1;
      m.depthWrite = false;
    }
    return m;
  }

  // Unity's Default-Material (what "Material Creation Mode: None" shows).
  const unityDefault = () => new THREE.MeshStandardMaterial({ name: 'Default-Material', color: 0xcbcbcb, roughness: 0.5, metalness: 0 });

  function get(key, mesh) {
    if (!key || key === 'default') {
      if (!built.has('default')) built.set('default', unityDefault());
      return built.get('default');
    }
    const spec = manifest.materials[key];
    if (!spec) return null;
    const vc = Boolean(spec.vertexColors && mesh && mesh.geometry && mesh.geometry.hasAttribute('color'));
    const id = `${key}${vc ? ':vc' : ''}`;
    if (!built.has(id)) built.set(id, create(spec, vc));
    return built.get(id);
  }
  get.fromSpec = (spec) => create(spec, false);
  return get;
}

// Embedded/generated materials come from the FBX loader (Phong). Make them
// physically based so they light like the rest, keeping their textures.
function adaptEmbedded(m) {
  if (!m || m.isMeshStandardMaterial) return m;
  const out = new THREE.MeshStandardMaterial({
    name: m.name,
    color: m.color ? m.color.clone() : new THREE.Color(0xcccccc),
    map: m.map || null,
    normalMap: m.normalMap || null,
    emissive: m.emissive ? m.emissive.clone() : new THREE.Color(0),
    emissiveMap: m.emissiveMap || null,
    alphaMap: m.alphaMap || null,
    transparent: Boolean(m.transparent),
    opacity: m.opacity ?? 1,
    side: m.side,
    vertexColors: m.vertexColors,
    roughness: m.shininess !== undefined ? Math.max(0.25, Math.min(1, 1 - Math.sqrt(m.shininess / 100))) : 0.7,
    metalness: 0,
  });
  if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
  return out;
}

function applyManifest(object, manifest) {
  const get = materialFactory(manifest);
  const bindings = new Map((manifest.bindings || []).map((b) => [b.key || sanitize(b.mesh), b.materials]));
  const byName = manifest.byName || {};
  const embeddedSpecs = manifest.embedded || {};
  const embeddedBuilt = new Map();
  // An embedded/generated material: the model's own description (colour from
  // the loader), with its diffuse/normal files found in the package.
  const embedded = (m) => {
    const key = sanitize(m && m.name);
    const spec = embeddedSpecs[key];
    if (!spec) return adaptEmbedded(m);
    if (!embeddedBuilt.has(key)) {
      const base = adaptEmbedded(m) || new THREE.MeshStandardMaterial({ name: spec.name });
      const synth = get.fromSpec({
        name: spec.name, color: [1, 1, 1, 1], metalness: 0, roughness: base.roughness ?? 0.7, alpha: 'opaque',
        maps: { ...(spec.map ? { map: { tex: spec.map } } : {}), ...(spec.normalMap ? { normalMap: { tex: spec.normalMap, scale: 1 } } : {}) },
      });
      if (!spec.map && base.color) synth.color.copy(base.color);
      embeddedBuilt.set(key, synth);
    }
    return embeddedBuilt.get(key);
  };
  object.traverse((node) => {
    if (!node.isMesh) return;
    const list = Array.isArray(node.material) ? node.material : [node.material];
    const bound = bindings.get(sanitize(node.name));
    const next = list.map((m, i) => {
      if (bound && bound.length) {
        const k = bound[Math.min(i, bound.length - 1)];
        if (k) return get(k, node) || m;
      }
      const k = byName[sanitize(m && m.name)] ?? manifest.fallback;
      if (k === 'embedded') return embedded(m);
      return get(k, node) || embedded(m);
    });
    node.material = Array.isArray(node.material) ? next : next[0];
  });
}

// --- prefabs -------------------------------------------------------------------
// Unity is left-handed and imports FBX by mirroring X; the scene here is built
// in the model files' own (three.js) space, so every Unity transform is
// conjugated by that mirror: position (-x, y, z), rotation (x, -y, -z, w).

function unityToThree(node, obj) {
  obj.position.set(-node.t[0], node.t[1], node.t[2]);
  obj.quaternion.set(node.r[0], -node.r[1], -node.r[2], node.r[3]);
  obj.scale.set(node.s[0], node.s[1], node.s[2]);
}

async function buildPrefab(manifest, manager) {
  const get = materialFactory(manifest);
  const buffers = new Map();
  const fetchBuf = (url) => {
    if (!buffers.has(url)) buffers.set(url, fetch(url, { credentials: 'same-origin' }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }));
    return buffers.get(url);
  };
  const parse = async (info) => {
    const buf = await fetchBuf(info.url);
    if (info.format === 'obj') return { object: new OBJLoader(manager).parse(new TextDecoder().decode(buf)), animations: [] };
    if (info.format === 'dae') return parseCollada(new TextDecoder().decode(buf), manager);
    if (info.format === 'glb' || info.format === 'gltf') {
      const gltf = await new GLTFLoader(manager).parseAsync(buf.slice(0), '');
      return { object: gltf.scene, animations: gltf.animations || [] };
    }
    const object = new FBXLoader(manager).parse(buf.slice(0), '');
    return { object, animations: object.animations || [] };
  };
  const meshIndexes = new Map();
  const meshIndex = async (guid) => {
    if (!meshIndexes.has(guid)) {
      const info = manifest.models[guid];
      meshIndexes.set(guid, parse(info).then(({ object }) => {
        const idx = new Map();
        object.traverse((n) => { if (n.isMesh && !idx.has(sanitize(n.name))) idx.set(sanitize(n.name), n); });
        // glTF splits a mesh with several material slots into one child mesh
        // per slot; a Unity renderer addresses the whole mesh, slot by slot.
        if (info.format === 'glb' || info.format === 'gltf') {
          object.traverse((n) => {
            if (n.isMesh || n.children.length < 2) return;
            if (!n.children.every((c) => c.isMesh && !c.isSkinnedMesh && c.position.lengthSq() === 0)) return;
            const geometry = mergeGeometries(n.children.map((c) => c.geometry), true);
            if (!geometry) return;
            const merged = new THREE.Mesh(geometry, n.children.map((c) => c.material));
            merged.name = n.name;
            idx.set(sanitize(n.name), merged);
          });
        }
        return idx;
      }));
    }
    return meshIndexes.get(guid);
  };

  const root = new THREE.Group();
  root.name = manifest.model.path.split('/').pop();
  const byId = new Map();
  for (const n of manifest.nodes) {
    const g = new THREE.Group();
    g.name = n.name;
    g.visible = n.active !== false;
    unityToThree(n, g);
    byId.set(n.id, g);
  }
  for (const n of manifest.nodes) (byId.get(n.parent) || root).add(byId.get(n.id));

  // Unity's built-in meshes at Unity's sizes (Plane is 10x10, Cylinder/Capsule 2 tall).
  const builtinGeometry = (shape) => {
    switch (shape) {
      case 'cube': return new THREE.BoxGeometry(1, 1, 1);
      case 'sphere': return new THREE.SphereGeometry(0.5, 32, 16);
      case 'cylinder': return new THREE.CylinderGeometry(0.5, 0.5, 2, 32);
      case 'capsule': return new THREE.CapsuleGeometry(0.5, 1, 8, 16);
      case 'plane': return new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2);
      case 'quad': return new THREE.PlaneGeometry(1, 1);
      default: return null;
    }
  };

  let animations = [];
  for (const n of manifest.nodes) {
    const holder = byId.get(n.id);
    if (n.builtin) {
      const geometry = builtinGeometry(n.builtin.shape);
      if (geometry) {
        const mat = (n.builtin.materials[0] && get(n.builtin.materials[0])) || get('default');
        const mesh = new THREE.Mesh(geometry, mat);
        mesh.name = n.name;
        holder.add(mesh);
      }
    } else if (n.mesh) {
      const info = manifest.models[n.mesh.model];
      if (!info || info.missing) continue;
      let src = null;
      try { src = (await meshIndex(n.mesh.model)).get(n.mesh.key); } catch (_) { src = null; }
      if (!src) continue;
      const mats = n.mesh.materials.map((k) => (k ? get(k, src) : null) || get('default'));
      const mesh = new THREE.Mesh(src.geometry, mats.length > 1 ? mats : (mats[0] || get('default')));
      mesh.name = n.name;
      mesh.scale.setScalar(info.fileScale || 1);
      holder.add(mesh);
    } else if (n.instance) {
      const info = manifest.models[n.instance.model];
      if (!info || info.missing) continue;
      let parsed;
      try { parsed = await parse(info); } catch (_) { continue; }
      const inst = n.instance;
      applyManifest(parsed.object, { ...manifest, byName: inst.byName, bindings: inst.bindings, embedded: inst.embedded, fallback: inst.fallback, fileTextures: inst.fileTextures });
      parsed.object.traverse((m) => {
        if (!m.isMesh) return;
        const ov = inst.overrides[sanitize(m.name)];
        if (!ov) return;
        const list = Array.isArray(m.material) ? [...m.material] : [m.material];
        ov.forEach((k, i) => { if (k && i < list.length) list[i] = get(k, m) || list[i]; });
        m.material = Array.isArray(m.material) ? list : list[0];
      });
      const wrap = new THREE.Group();
      wrap.scale.setScalar(info.fileScale || 1);
      wrap.add(parsed.object);
      holder.add(wrap);
      if (!animations.length && parsed.animations.length) animations = parsed.animations;
    }
  }
  return { object: root, animations };
}

// --- UI bits -------------------------------------------------------------------

const FIDELITY_TEXT = {
  exact: ['exact', 'Matches Unity'],
  approximate: ['approx', 'Close to Unity'],
  missing: ['missing', 'Materials not found'],
  none: ['none', 'No meshes'],
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function fidelityPanel(manifest) {
  const wrap = el('details', 'pv3d-fidelity');
  const [cls, label] = FIDELITY_TEXT[manifest.fidelity] || FIDELITY_TEXT.approximate;
  const summary = el('summary');
  summary.appendChild(el('span', `pv3d-badge pv3d-${cls}`, label));
  const c = manifest.counts || {};
  const total = (c.exact || 0) + (c.approximate || 0) + (c.missing || 0);
  if (total) summary.appendChild(el('span', 'pv3d-count', ` ${c.exact || 0}/${total} parts exact`));
  wrap.appendChild(summary);

  const why = {
    remap: 'material remap', prefab: 'from a prefab', scene: 'from a scene', search: "Unity's material search",
    embedded: 'embedded in the model', generated: 'generated from the model', name: 'matched by name', 'model-texture': "the model's own texture",
    default: "Unity's default material", missing: 'not found',
  };
  const table = el('table', 'pv3d-slots');
  for (const r of (manifest.rendered || []).slice(0, 60)) {
    const tr = el('tr');
    tr.appendChild(el('td', '', r.mesh));
    const spec = r.material && manifest.materials[r.material];
    const matName = spec ? spec.name : (r.material === 'embedded' ? (r.slot || 'model material') : r.material === 'default' ? 'Default-Material' : '—');
    tr.appendChild(el('td', '', matName));
    tr.appendChild(el('td', 'pv3d-why', `${why[r.source] || r.source}${spec && spec.shader ? ` · ${spec.shader}` : ''}`));
    const f = FIDELITY_TEXT[r.fidelity] || FIDELITY_TEXT.approximate;
    tr.appendChild(el('td', `pv3d-badge pv3d-${f[0]}`, f[0]));
    table.appendChild(tr);
  }
  wrap.appendChild(table);
  for (const n of manifest.notes || []) wrap.appendChild(el('div', 'pv3d-note', n));
  return wrap;
}

function animationBar(stage, object, clips) {
  if (!clips.length) return null;
  const mixer = new THREE.AnimationMixer(object);
  stage.setMixer(mixer);
  const bar = el('div', 'pv3d-anim');
  const select = el('select');
  clips.forEach((clip, i) => {
    const opt = el('option', '', `${clip.name || `clip ${i + 1}`} (${clip.duration.toFixed(1)}s)`);
    opt.value = String(i);
    select.appendChild(opt);
  });
  const toggle = el('button', '', 'Pause');
  let action = mixer.clipAction(clips[0]);
  action.play();
  select.addEventListener('change', () => {
    action.stop();
    action = mixer.clipAction(clips[Number(select.value)]);
    action.play();
    action.paused = false;
    toggle.textContent = 'Pause';
  });
  toggle.addEventListener('click', () => {
    action.paused = !action.paused;
    toggle.textContent = action.paused ? 'Play' : 'Pause';
  });
  bar.appendChild(el('span', 'pv3d-anim-label', 'Animation'));
  bar.appendChild(select);
  bar.appendChild(toggle);
  return bar;
}

// --- hand-off to Mesh2Motion -----------------------------------------------------

let sessionPromise = null;
const session = () => {
  if (!sessionPromise) sessionPromise = fetch('/api/web/session', { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({}));
  return sessionPromise;
};

// Every texture image decoded, so the exporter does not embed blanks.
function texturesReady(object, timeoutMs = 20000) {
  const pending = [];
  object.traverse((node) => {
    if (!node.isMesh) return;
    for (const m of Array.isArray(node.material) ? node.material : [node.material]) {
      if (!m) continue;
      for (const v of Object.values(m)) {
        const img = v && v.isTexture ? v.image : null;
        if (img && typeof img.complete === 'boolean' && !img.complete) {
          pending.push(new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); }));
        }
      }
    }
  });
  return Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, timeoutMs))]);
}

async function exportGlb(object, animations) {
  await texturesReady(object);
  const exporter = new GLTFExporter();
  return exporter.parseAsync(object, { binary: true, onlyVisible: true, animations: animations || [], maxTextureSize: 2048 });
}

/**
 * Open Mesh2Motion in a new tab and hand it the model. The tab is opened
 * synchronously (inside the click) so pop-up blockers allow it; the GLB is
 * posted once both the export and the page are ready. Same origin only.
 */
function handOff(page, makeGlb, meta) {
  const id = Math.random().toString(36).slice(2);
  const url = page === 'retarget' ? `/rig/retarget/?pv=handoff&id=${id}` : `/rig/create.html?pv=handoff&id=${id}`;
  const win = window.open(url, '_blank');
  if (!win) return Promise.reject(new Error('the browser blocked the new tab — allow pop-ups for this site'));
  let ready = false;
  let glb = null;
  let done = false;
  return new Promise((resolve, reject) => {
    const send = () => {
      if (!ready || !glb || done) return;
      done = true;
      window.removeEventListener('message', onMessage);
      win.postMessage({ type: 'pv-handoff', name: meta.name, buffer: glb, source: meta.source, preview: meta.preview }, location.origin, [glb]);
      resolve();
    };
    const onMessage = (event) => {
      if (event.origin !== location.origin || event.source !== win) return;
      if (event.data && event.data.type === 'pv-handoff-ready' && event.data.id === id) { ready = true; send(); }
    };
    window.addEventListener('message', onMessage);
    setTimeout(() => { if (!done) { window.removeEventListener('message', onMessage); reject(new Error('Mesh2Motion did not answer')); } }, 120000);
    makeGlb().then((buf) => { glb = buf; send(); }, (err) => { done = true; window.removeEventListener('message', onMessage); win.close(); reject(err); });
  });
}

function rigBar(source, viewer) {
  const bar = el('div', 'pv3d-actions');
  const skinned = viewer.skinned;
  const btn = el('button', 'pv3d-rig', skinned ? 'Animate in Mesh2Motion' : 'Rig in Mesh2Motion');
  btn.title = skinned
    ? 'Already rigged: open it in Mesh2Motion to preview and retarget animations'
    : 'Open this model in Mesh2Motion to fit a skeleton and add animations';
  const status = el('span', 'pv3d-rig-status');
  btn.addEventListener('click', () => {
    btn.disabled = true;
    status.textContent = 'preparing the model…';
    const name = `${(source.name || 'model').replace(/\.[^.]+$/, '')}.glb`;
    let preview = '';
    try { preview = viewer.canvas.toDataURL('image/png'); } catch (_) { preview = ''; }
    handOff(skinned ? 'retarget' : 'create', () => exportGlb(viewer.object, viewer.animations), {
      name,
      preview: preview.length < 3 * 1024 * 1024 ? preview : '',
      source: { name: source.name || name, path: source.path || '', entry: source.entry || '' },
    }).then(() => { status.textContent = 'opened in a new tab'; })
      .catch((err) => { status.textContent = err.message; })
      .finally(() => { btn.disabled = false; });
  });
  bar.appendChild(btn);
  bar.appendChild(status);
  return bar;
}

async function fetchManifest(source, onWait) {
  const q = `path=${encodeURIComponent(source.path)}${source.entry ? `&entry=${encodeURIComponent(source.entry)}` : ''}`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const res = await fetch(`/api/model/manifest?${q}`, { credentials: 'same-origin' });
    const json = await res.json().catch(() => ({}));
    if (res.status === 202 && json.pending) {
      onWait(json);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json.manifest;
  }
  throw new Error('the package is still being indexed — try again in a minute');
}

/**
 * Mounts a model the way Unity shows it.
 * @param {HTMLElement} container
 * @param {{path:string, entry?:string, name:string, fileUrl?:string, height?:number}} source
 * @returns {Promise<{dispose:()=>void, triangles:number, manifest:object, object:THREE.Object3D, skinned:boolean, clips:number}>}
 */
export async function mountUnity(container, source) {
  const stage = createStage(container, source.height || 360);
  const manifest = await fetchManifest(source, (state) => {
    stage.note.textContent = state.state === 'building'
      ? 'reading this package for the first time…'
      : `package queued for indexing${state.position ? ` (position ${state.position})` : ''}…`;
  });
  if (stage.disposed) return { dispose() {}, triangles: 0, manifest, object: null, skinned: false, clips: 0 };
  stage.note.textContent = 'loading model and textures…';

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url;
    const base = decodeURIComponent(url.split(/[\\/]/).pop() || '').toLowerCase();
    const key = manifest.fileTextures && manifest.fileTextures[base];
    return key && manifest.textures[key] ? manifest.textures[key].url : BLANK;
  });

  const { object, animations } = manifest.kind === 'prefab'
    ? await buildPrefab(manifest, manager)
    : await loadModel(manifest.model.url, manifest.model.format, manager);
  if (stage.disposed) return { dispose() {}, triangles: 0, manifest, object: null, skinned: false, clips: 0 };
  if (manifest.kind !== 'prefab') applyManifest(object, manifest);
  let skinned = false;
  object.traverse((n) => { if (n.isSkinnedMesh) skinned = true; });

  stage.scene.add(object);
  fitCamera(stage.camera, stage.controls, object);
  stage.start();
  stage.note.remove();

  const overlay = el('div', 'pv3d-overlay');
  overlay.appendChild(fidelityPanel(manifest));
  const anim = animationBar(stage, object, animations || []);
  if (anim) overlay.appendChild(anim);
  container.appendChild(overlay);

  const viewer = {
    triangles: countTriangles(object),
    manifest,
    object,
    skinned,
    clips: (animations || []).length,
    animations: animations || [],
    canvas: stage.renderer.domElement,
    exportGlb: () => exportGlb(object, animations),
    dispose: () => stage.dispose(),
  };
  const s = await session();
  if (s && s.rig && s.rig.available && manifest.fidelity !== 'none') overlay.appendChild(rigBar(source, viewer));
  return viewer;
}
