'use strict';
// Turns the texture files Unity packages contain into what a browser can use.
//
//   png/jpg/webp/gif/tif -> sharp directly
//   tga                  -> decoder below (uncompressed + RLE; 8/16/24/32-bit,
//                           grey, colour-mapped; either origin)
//   bmp                  -> decoder below (24/32-bit BI_RGB/BITFIELDS, 8-bit palette)
//   psd                  -> ag-psd composite (needs "Maximize compatibility")
//   exr/hdr/dds          -> not supported (reported as such)
//
// Roles:
//   albedo / emission  sRGB, alpha kept, lossy WebP
//   normal             linear, lossless WebP (lossy artefacts show in lighting)
//   orm                built from Unity's packed maps into three.js' layout:
//                      R = occlusion, G = roughness, B = metalness

const path = require('path');

let sharp = null;
try { sharp = require('sharp'); } catch (_) { sharp = null; }
let agPsd = null;
try {
  agPsd = require('ag-psd');
  // Node has no canvas. With useImageData the composite only needs ImageData
  // objects; a real canvas is never requested for the paths we use.
  agPsd.initializeCanvas(
    () => { throw new Error('canvas not available'); },
    (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
  );
} catch (_) { agPsd = null; }

const MAX_PIXELS = 8192 * 8192;

class TextureError extends Error {}

// --- TGA -----------------------------------------------------------------------

function decodeTga(buf) {
  if (buf.length < 18) throw new TextureError('TGA: truncated header');
  const idLength = buf[0];
  const cmapType = buf[1];
  const type = buf[2];
  const cmapFirst = buf.readUInt16LE(3);
  const cmapLength = buf.readUInt16LE(5);
  const cmapDepth = buf[7];
  const width = buf.readUInt16LE(12);
  const height = buf.readUInt16LE(14);
  const depth = buf[16];
  const desc = buf[17];
  if (!width || !height || width * height > MAX_PIXELS) throw new TextureError('TGA: bad size');
  const rle = type >= 9;
  const base = rle ? type - 8 : type;
  if (![1, 2, 3].includes(base)) throw new TextureError(`TGA: unsupported type ${type}`);
  let off = 18 + idLength;
  let palette = null;
  if (cmapType === 1) {
    const bpe = Math.ceil(cmapDepth / 8);
    palette = buf.subarray(off, off + cmapLength * bpe);
    off += cmapLength * bpe;
  }
  const bpp = Math.ceil(depth / 8);
  const n = width * height;
  const out = Buffer.alloc(n * 4);
  const readPixel = (src, i, dst) => {
    if (base === 1) {
      const idx = (bpp === 2 ? src.readUInt16LE(i) : src[i]) - cmapFirst;
      const pb = Math.ceil(cmapDepth / 8);
      return toRgba(palette, idx * pb, pb, dst);
    }
    if (base === 3) {
      out[dst] = out[dst + 1] = out[dst + 2] = src[i];
      out[dst + 3] = bpp === 2 ? src[i + 1] : 255;
      return undefined;
    }
    return toRgba(src, i, bpp, dst);
  };
  function toRgba(src, i, size, dst) {
    if (size === 4) { out[dst] = src[i + 2]; out[dst + 1] = src[i + 1]; out[dst + 2] = src[i]; out[dst + 3] = src[i + 3]; }
    else if (size === 3) { out[dst] = src[i + 2]; out[dst + 1] = src[i + 1]; out[dst + 2] = src[i]; out[dst + 3] = 255; }
    else if (size === 2) {
      const v = src.readUInt16LE(i);
      out[dst] = ((v >> 10) & 31) * 255 / 31; out[dst + 1] = ((v >> 5) & 31) * 255 / 31; out[dst + 2] = (v & 31) * 255 / 31;
      out[dst + 3] = 255;
    } else { out[dst] = out[dst + 1] = out[dst + 2] = src[i]; out[dst + 3] = 255; }
    return undefined;
  }
  if (!rle) {
    if (off + n * bpp > buf.length) throw new TextureError('TGA: truncated data');
    for (let p = 0; p < n; p += 1) readPixel(buf, off + p * bpp, p * 4);
  } else {
    let p = 0;
    while (p < n) {
      if (off >= buf.length) throw new TextureError('TGA: truncated RLE data');
      const h = buf[off]; off += 1;
      const count = (h & 0x7f) + 1;
      if (h & 0x80) {
        const tmp = p * 4;
        readPixel(buf, off, tmp);
        off += bpp;
        for (let k = 1; k < count && p + k < n; k += 1) out.copy(out, (p + k) * 4, tmp, tmp + 4);
        p += count;
      } else {
        for (let k = 0; k < count && p < n; k += 1, p += 1) { readPixel(buf, off, p * 4); off += bpp; }
      }
    }
  }
  // Default origin is bottom-left: flip unless the top-left bit is set.
  if (!(desc & 0x20)) flipRows(out, width, height);
  if (desc & 0x10) flipCols(out, width, height);
  // 32-bit TGAs with an all-zero alpha channel are common (alpha unused).
  if (bpp === 4) fixEmptyAlpha(out);
  return { data: out, width, height };
}

function flipRows(px, w, h) {
  const row = w * 4;
  const tmp = Buffer.alloc(row);
  for (let y = 0; y < h >> 1; y += 1) {
    const a = y * row;
    const b = (h - 1 - y) * row;
    px.copy(tmp, 0, a, a + row);
    px.copy(px, a, b, b + row);
    tmp.copy(px, b);
  }
}
function flipCols(px, w, h) {
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w >> 1; x += 1) {
      const a = (y * w + x) * 4;
      const b = (y * w + (w - 1 - x)) * 4;
      for (let c = 0; c < 4; c += 1) { const t = px[a + c]; px[a + c] = px[b + c]; px[b + c] = t; }
    }
  }
}
function fixEmptyAlpha(px) {
  for (let i = 3; i < px.length; i += 4) if (px[i] !== 0) return;
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
}

// --- BMP -----------------------------------------------------------------------

function decodeBmp(buf) {
  if (buf.length < 54 || buf.toString('ascii', 0, 2) !== 'BM') throw new TextureError('BMP: bad header');
  const dataOff = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  let height = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const comp = buf.readUInt32LE(30);
  const topDown = height < 0;
  height = Math.abs(height);
  if (!width || !height || width * height > MAX_PIXELS) throw new TextureError('BMP: bad size');
  if (![0, 3].includes(comp) || ![8, 24, 32].includes(bpp)) throw new TextureError(`BMP: unsupported ${bpp}-bit/compression ${comp}`);
  const rowSize = Math.ceil((bpp * width) / 32) * 4;
  const out = Buffer.alloc(width * height * 4);
  const palOff = 14 + buf.readUInt32LE(14);
  for (let y = 0; y < height; y += 1) {
    const srcRow = dataOff + (topDown ? y : height - 1 - y) * rowSize;
    for (let x = 0; x < width; x += 1) {
      const d = (y * width + x) * 4;
      if (bpp === 8) {
        const p = palOff + buf[srcRow + x] * 4;
        out[d] = buf[p + 2]; out[d + 1] = buf[p + 1]; out[d + 2] = buf[p]; out[d + 3] = 255;
      } else {
        const s = srcRow + x * (bpp / 8);
        out[d] = buf[s + 2]; out[d + 1] = buf[s + 1]; out[d + 2] = buf[s];
        out[d + 3] = bpp === 32 ? buf[s + 3] : 255;
      }
    }
  }
  if (bpp === 32) fixEmptyAlpha(out);
  return { data: out, width, height };
}

// --- PSD -----------------------------------------------------------------------

function decodePsd(buf) {
  if (!agPsd) throw new TextureError('PSD support not installed');
  let psd;
  try {
    psd = agPsd.readPsd(buf, { skipLayerImageData: true, skipThumbnail: true, useImageData: true });
  } catch (err) {
    throw new TextureError(`PSD: ${err.message}`);
  }
  const img = psd.imageData;
  if (!img || !img.data || !img.width) throw new TextureError('PSD has no composite image (saved without "Maximize compatibility")');
  return { data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), width: img.width, height: img.height };
}

// --- common --------------------------------------------------------------------

/** A sharp instance for any supported texture file. */
function open(buffer, fileName) {
  if (!sharp) throw new TextureError('image support (sharp) not installed');
  const ext = path.extname(fileName || '').toLowerCase();
  const raw = (img) => sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 }, limitInputPixels: MAX_PIXELS });
  if (ext === '.tga') return raw(decodeTga(buffer));
  if (ext === '.bmp') return raw(decodeBmp(buffer));
  if (ext === '.psd') return raw(decodePsd(buffer));
  if (['.exr', '.hdr', '.dds'].includes(ext)) throw new TextureError(`${ext} textures cannot be shown in a browser`);
  return sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: 'none' });
}

async function rgba(buffer, fileName, width, height) {
  const img = open(buffer, fileName).ensureAlpha();
  const resized = width ? img.resize(width, height, { fit: 'fill' }) : img;
  const { data, info } = await resized.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * albedo / emission / normal -> WebP no larger than `maxSize` on its long side.
 * @returns {Promise<Buffer>}
 */
async function convertTexture(buffer, fileName, role, maxSize) {
  const img = open(buffer, fileName);
  const meta = await img.metadata();
  const resized = (meta.width > maxSize || meta.height > maxSize)
    ? img.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: true })
    : img;
  if (role === 'normal') return resized.webp({ lossless: true, effort: 3 }).toBuffer();
  return resized.webp({ quality: 88, alphaQuality: 95, effort: 3 }).toBuffer();
}

/**
 * Build a three.js ORM map (R occlusion, G roughness, B metalness) from Unity's
 * packed maps. Scalars are baked in so the material can use 1.0 multipliers.
 *
 * @param {{kind:'metallic'|'mask'|'specular'|'none', mg?:Buffer, mgName?:string,
 *          ao?:Buffer, aoName?:string, albedo?:Buffer, albedoName?:string,
 *          aoStrength:number, smoothScale:number, metallic:number}} recipe
 */
async function buildOrm(recipe, maxSize) {
  const sources = [
    recipe.mg && [recipe.mg, recipe.mgName],
    recipe.ao && [recipe.ao, recipe.aoName],
    recipe.albedo && [recipe.albedo, recipe.albedoName],
  ].filter(Boolean);
  if (!sources.length) throw new TextureError('ORM: no source maps');
  const probe = await open(sources[0][0], sources[0][1]).metadata();
  let w = probe.width;
  let h = probe.height;
  if (w > maxSize || h > maxSize) {
    const k = maxSize / Math.max(w, h);
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
  }
  const mg = recipe.mg ? await rgba(recipe.mg, recipe.mgName, w, h) : null;
  const ao = recipe.ao ? await rgba(recipe.ao, recipe.aoName, w, h) : null;
  const al = recipe.albedo ? await rgba(recipe.albedo, recipe.albedoName, w, h) : null;
  const out = Buffer.alloc(w * h * 3);
  const s = recipe.smoothScale;
  const strength = recipe.aoStrength;
  for (let p = 0, q = 0; p < w * h * 4; p += 4, q += 3) {
    let occlusion = 255;
    let smooth = s;
    let metal = recipe.metallic;
    if (mg) {
      if (recipe.kind === 'metallic') { metal = mg.data[p] / 255; smooth = (mg.data[p + 3] / 255) * s; }
      else if (recipe.kind === 'mask') { metal = mg.data[p] / 255; occlusion = mg.data[p + 1]; smooth = (mg.data[p + 3] / 255) * s; }
      else if (recipe.kind === 'specular') { metal = 0; smooth = (mg.data[p + 3] / 255) * s; }
    }
    if (al) smooth = (al.data[p + 3] / 255) * s;
    if (ao) occlusion = ao.data[p + 1];
    // Unity: occlusion = lerp(1, map, strength)
    const occ = 255 - (255 - occlusion) * strength;
    out[q] = Math.round(occ);
    out[q + 1] = Math.round(Math.max(0, Math.min(1, 1 - smooth)) * 255);
    out[q + 2] = Math.round(Math.max(0, Math.min(1, metal)) * 255);
  }
  return sharp(out, { raw: { width: w, height: h, channels: 3 } }).webp({ lossless: true, effort: 3 }).toBuffer();
}

module.exports = { convertTexture, buildOrm, decodeTga, decodeBmp, decodePsd, TextureError, available: () => Boolean(sharp), psdAvailable: () => Boolean(agPsd) };
