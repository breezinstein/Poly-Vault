'use strict';

// Thumbnail cache for the web UI.
//
// A library preview is whatever the artist dropped in the folder — often a 4K
// PNG for a 200 px card. Serving the original means tens of MB per grid page
// and, on a shared deployment, that cost is paid by every user on every visit.
//
// Thumbnails are generated once per (file, mtime, width) and cached as WebP
// under `${PV_DATA_DIR}/thumbs`. The cache is disposable: deleting the folder
// only costs regeneration. If sharp is unavailable or the image cannot be
// decoded, callers fall back to the original preview endpoint.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WIDTHS = [160, 320, 480, 960, 1440];
const QUALITY = 78;

let sharp = null;
let sharpError = null;
try {
  // Optional: the image in server-image builds includes it.
  // eslint-disable-next-line global-require
  sharp = require('sharp');
} catch (err) {
  sharpError = err;
}

function isAvailable() {
  return Boolean(sharp);
}

function unavailableReason() {
  return sharpError ? sharpError.message : '';
}

function clampWidth(w) {
  const wanted = Number(w) || 320;
  return WIDTHS.reduce((best, candidate) => (
    Math.abs(candidate - wanted) < Math.abs(best - wanted) ? candidate : best
  ), WIDTHS[0]);
}

function createThumbCache({ dir, maxFiles = 20000, log = console }) {
  const cacheDir = path.join(dir, 'thumbs');
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch (err) {
    log.warn(`[poly-vault] thumbnail cache directory unavailable: ${err.message}`);
  }

  const inFlight = new Map();
  const stats = { generated: 0, hits: 0, failed: 0, bytes: 0 };

  function keyFor(realPath, mtimeMs, width) {
    const hash = crypto.createHash('sha1').update(`${realPath}\u0000${mtimeMs}\u0000${width}`).digest('hex');
    return { hash, file: path.join(cacheDir, `${hash}-${width}.webp`) };
  }

  function pruneIfNeeded() {
    try {
      const names = fs.readdirSync(cacheDir);
      if (names.length <= maxFiles) return;
      const entries = names.map((name) => {
        const full = path.join(cacheDir, name);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch (_) { /* ignore */ }
        return { full, mtime };
      }).sort((a, b) => a.mtime - b.mtime);
      const excess = entries.length - maxFiles;
      for (let i = 0; i < excess; i += 1) {
        try { fs.unlinkSync(entries[i].full); } catch (_) { /* ignore */ }
      }
      log.log(`[poly-vault] thumb cache pruned ${excess} file(s)`);
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * @returns {Promise<{file: string, cacheHit: boolean}>}
   */
  async function get(realPath, mtimeMs, width) {
    if (!sharp) {
      const err = new Error(`image resizing unavailable: ${unavailableReason()}`);
      err.code = 'ENOSHARP';
      throw err;
    }
    const w = clampWidth(width);
    const { file } = keyFor(realPath, mtimeMs, w);

    if (fs.existsSync(file)) {
      stats.hits += 1;
      return { file, cacheHit: true };
    }

    const flightKey = file;
    if (inFlight.has(flightKey)) return inFlight.get(flightKey);

    const job = (async () => {
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      try {
        await sharp(realPath, { failOn: 'none', limitInputPixels: 268402689 })
          .rotate()
          .resize({ width: w, withoutEnlargement: true })
          .webp({ quality: QUALITY, effort: 4 })
          .toFile(tmp);
        fs.renameSync(tmp, file);
        const size = fs.statSync(file).size;
        stats.generated += 1;
        stats.bytes += size;
        if (stats.generated % 500 === 0) pruneIfNeeded();
        return { file, cacheHit: false };
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
        stats.failed += 1;
        throw err;
      } finally {
        inFlight.delete(flightKey);
      }
    })();

    inFlight.set(flightKey, job);
    return job;
  }

  function clearJob(realPath, mtimeMs, width) {
    const w = clampWidth(width);
    const { file } = keyFor(realPath, mtimeMs, w);
    try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
  }

  return { get, clearJob, stats, cacheDir, pruneIfNeeded, isAvailable, WIDTHS };
}

module.exports = { createThumbCache, isAvailable, unavailableReason, clampWidth, WIDTHS };
