'use strict';
// Serves the Mesh2Motion static build (Dockerfile stage "rig") at /rig/.
//
// Mesh2Motion is a client-side app: pages, a hashed JS/CSS bundle under
// bundle/, and a library of GLB animations/models. It runs behind Poly Vault's
// sign-in (the caller checks identity first) with its own CSP: the app needs
// blob:/data: for loaders and exports, inline styles for its UI library, and
// nothing off-site.

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');

const RIG_DIR = path.resolve(process.env.PV_RIG_DIR || path.join(__dirname, '..', 'rig'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.fbx': 'application/octet-stream',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

const available = fs.existsSync(path.join(RIG_DIR, 'index.html'));

/** Resolve a /rig/... route to a file inside RIG_DIR, or null. */
function resolveFile(route) {
  let rel = decodeURIComponent(route.slice('/rig/'.length));
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const candidate = path.resolve(RIG_DIR, rel);
  if (candidate !== RIG_DIR && !candidate.startsWith(RIG_DIR + path.sep)) return null;
  const tries = [candidate, `${candidate}.html`, path.join(candidate, 'index.html')];
  for (const file of tries) {
    try {
      const real = fs.realpathSync(file);
      if (!real.startsWith(RIG_DIR + path.sep)) continue;
      if (fs.statSync(real).isFile()) return real;
    } catch (_) { /* try next */ }
  }
  return null;
}

/**
 * Handle /rig and /rig/*. Returns true when the request was answered.
 * The caller has already authenticated the request.
 */
function handleRig(req, res, route) {
  if (route !== '/rig' && !route.startsWith('/rig/')) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return true;
  }
  if (!available) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Mesh2Motion is not part of this build');
    return true;
  }
  if (route === '/rig') {
    res.writeHead(301, { Location: '/rig/' });
    res.end();
    return true;
  }
  let file;
  try { file = resolveFile(route); } catch (_) { file = null; }
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return true;
  }
  // Directory URL without trailing slash: redirect so relative URLs resolve.
  if (file.endsWith(`${path.sep}index.html`) && !route.endsWith('/') && !route.endsWith('.html')) {
    res.writeHead(301, { Location: `${route}/` });
    res.end();
    return true;
  }
  const ext = path.extname(file).toLowerCase();
  const rel = path.relative(RIG_DIR, file);
  let cache = 'private, max-age=604800';
  if (ext === '.html') cache = 'no-cache';
  else if (rel.startsWith(`bundle${path.sep}`)) cache = 'private, max-age=31536000, immutable';
  const st = fs.statSync(file);
  const etag = `W/"r-${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cache,
    ETag: etag,
    'Content-Security-Policy': CSP,
  };
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').some((t) => t.trim() === etag)) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return true; }
  pipeline(fs.createReadStream(file), res, () => {});
  return true;
}

// Mesh2Motion assumes it owns the site root: some code loads `/${file}`
// (e.g. /assets/human/skeleton.glb) and shared code uses `../images/...`,
// which escapes /rig/ from the top-level pages. Rather than patching every call
// site (fragile across upstream updates), root-level requests for Mesh2Motion's
// *static* top-level folders are served from its build — the same thing a
// reverse proxy would do. Poly Vault's own files always win (the caller tries
// the UI first), HTML is never served this way, and the caller has already
// authenticated the request.
const FALLBACK_DIRS = (() => {
  if (!available) return new Set();
  try {
    return new Set(fs.readdirSync(RIG_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !['composer', 'retarget'].includes(d.name))
      .map((d) => d.name));
  } catch (_) {
    return new Set();
  }
})();

/** Handle a root-level request for a Mesh2Motion static asset. */
function handleRigFallback(req, res, route) {
  if (!available || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
  const first = route.split('/')[1] || '';
  if (!FALLBACK_DIRS.has(first)) return false;
  if (path.extname(route).toLowerCase() === '.html') return false;
  let file;
  try { file = resolveFile(`/rig${route}`); } catch (_) { file = null; }
  if (!file || file.endsWith('.html')) return false;
  return handleRig(req, res, `/rig${route}`);
}

module.exports = { handleRig, handleRigFallback, RIG_DIR, available, CSP, FALLBACK_DIRS };
