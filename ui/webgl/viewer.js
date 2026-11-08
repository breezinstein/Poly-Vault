// Optional WebGL model preview (three.js), loaded on demand by the renderer.
//
// Vendored by scripts/fetch-webgl.sh — nothing is fetched from a CDN, so this
// works offline and inside the app's strict CSP. The caller decides whether to
// use it (Settings → "3D model preview"); when disabled we never download these
// modules at all.

import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { OBJLoader } from './vendor/OBJLoader.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { STLLoader } from './vendor/STLLoader.js';
import { PLYLoader } from './vendor/PLYLoader.js';
import { FBXLoader } from './vendor/FBXLoader.js';

const EXT = (path) => (/\.([A-Za-z0-9]+)$/.exec(path || '') || [])[1]?.toLowerCase() || '';

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

async function loadModel(url, ext) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  if (ext === 'obj') {
    const text = await res.text();
    return new OBJLoader().parse(text);
  }
  if (ext === 'glb' || ext === 'gltf') {
    const buf = await res.arrayBuffer();
    const gltf = await new GLTFLoader().parseAsync(buf, '');
    return gltf.scene || gltf.scenes?.[0] || new THREE.Group();
  }
  if (ext === 'stl') {
    return new THREE.Mesh(new STLLoader().parse(await res.arrayBuffer()), new THREE.MeshStandardMaterial({ color: 0xbfc4cc, metalness: 0.1, roughness: 0.7 }));
  }
  if (ext === 'ply') {
    const geometry = new PLYLoader().parse(await res.arrayBuffer());
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xbfc4cc, vertexColors: geometry.hasAttribute('color'), metalness: 0.1, roughness: 0.7 }));
  }
  if (ext === 'fbx') {
    return new FBXLoader().parse(await res.arrayBuffer(), '');
  }
  throw new Error(`no viewer for .${ext}`);
}

/**
 * Mounts a 3D preview.
 * @param {HTMLElement} container
 * @param {string} url      same-origin URL of the model bytes
 * @param {string} name     file name, used to pick the loader
 * @returns {Promise<{dispose:()=>void, triangles:number}>}
 */
export async function mount(container, url, name) {
  const ext = EXT(name);
  const width = () => Math.max(container.clientWidth, 320);
  const height = 320;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width(), height, false);

  const scene = new THREE.Scene();
  scene.background = null;
  const camera = new THREE.PerspectiveCamera(45, width() / height, 0.01, 10000);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2c33, 2.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8899ff, 1.1);
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

  let disposed = false;
  let frame = 0;
  const tick = () => {
    if (disposed) return;
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

  const object = await loadModel(url, ext);
  if (disposed) return { dispose() {}, triangles: 0 };

  const material = new THREE.MeshStandardMaterial({ color: 0xcfd4dc, metalness: 0.05, roughness: 0.75, flatShading: false });
  object.traverse((node) => {
    if (node.isMesh) {
      if (!node.material || Array.isArray(node.material) === false) node.material = material;
      node.castShadow = false;
      node.receiveShadow = false;
    }
  });

  scene.add(object);
  fitCamera(camera, controls, object);
  tick();

  note.textContent = '';
  note.remove();

  const triangles = (() => {
    let n = 0;
    object.traverse((node) => {
      if (node.isMesh && node.geometry) {
        const g = node.geometry;
        n += (g.index ? g.index.count : (g.attributes.position?.count || 0)) / 3;
      }
    });
    return Math.round(n);
  })();

  return {
    triangles,
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      controls.dispose();
      scene.traverse((node) => {
        if (node.isMesh) {
          node.geometry?.dispose?.();
          if (Array.isArray(node.material)) node.material.forEach((m) => m.dispose?.());
          else node.material?.dispose?.();
        }
      });
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    },
  };
}
