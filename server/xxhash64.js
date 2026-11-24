'use strict';
// xxHash64 (seed 0), BigInt implementation.
//
// Unity (2019.3+, ModelImporter `fileIdsGeneration: 2`) derives the fileID of
// every sub-asset of a model from its type and name instead of storing a table:
//
//   fileID = int64( xxHash64( "Type:<ClassName>-><objectName><index>" ) )
//
// e.g. the first mesh called "Blade.001" -> xxHash64("Type:Mesh->Blade.0010").
// Prefabs reference meshes by that fileID, so this is what links a prefab's
// MeshFilter to a named mesh inside an FBX. Verified against real Asset Store
// packages (every prefab reference checked). Index > 0 disambiguates
// duplicate names within one file.

const M = (1n << 64n) - 1n;
const P1 = 11400714785074694791n;
const P2 = 14029467366897019727n;
const P3 = 1609587929392839161n;
const P4 = 9650029242287828579n;
const P5 = 2870177450012600261n;

const rotl = (x, r) => ((x << BigInt(r)) | (x >> BigInt(64 - r))) & M;
const round = (acc, v) => (rotl((acc + v * P2) & M, 31) * P1) & M;
const merge = (acc, v) => (((acc ^ round(0n, v)) * P1) + P4) & M;

function xxh64(input, seed = 0n) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  const len = buf.length;
  let p = 0;
  let h;
  if (len >= 32) {
    let v1 = (seed + P1 + P2) & M;
    let v2 = (seed + P2) & M;
    let v3 = seed & M;
    let v4 = (seed - P1) & M;
    while (p <= len - 32) {
      v1 = round(v1, buf.readBigUInt64LE(p));
      v2 = round(v2, buf.readBigUInt64LE(p + 8));
      v3 = round(v3, buf.readBigUInt64LE(p + 16));
      v4 = round(v4, buf.readBigUInt64LE(p + 24));
      p += 32;
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & M;
    h = merge(h, v1); h = merge(h, v2); h = merge(h, v3); h = merge(h, v4);
  } else {
    h = (seed + P5) & M;
  }
  h = (h + BigInt(len)) & M;
  while (p + 8 <= len) {
    h ^= round(0n, buf.readBigUInt64LE(p));
    h = (rotl(h, 27) * P1 + P4) & M;
    p += 8;
  }
  if (p + 4 <= len) {
    h ^= (BigInt(buf.readUInt32LE(p)) * P1) & M;
    h = (rotl(h, 23) * P2 + P3) & M;
    p += 4;
  }
  while (p < len) {
    h ^= (BigInt(buf[p]) * P5) & M;
    h = (rotl(h, 11) * P1) & M;
    p += 1;
  }
  h ^= h >> 33n; h = (h * P2) & M;
  h ^= h >> 29n; h = (h * P3) & M;
  h ^= h >> 32n;
  return h;
}

/** Unity's fileID (signed int64, as a decimal string) for a named sub-asset. */
function unityFileId(className, name, index = 0) {
  const u = xxh64(`Type:${className}->${name}${index}`);
  return (u >= (1n << 63n) ? u - (1n << 64n) : u).toString();
}

module.exports = { xxh64, unityFileId };
