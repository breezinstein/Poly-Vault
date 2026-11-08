#!/usr/bin/env bash
# Creates a throwaway library for smoke tests / local trials.
#
#   ./scripts/make-fixture-library.sh [target-dir]     (default: ./fixture-assets)
#
# Layout:
#   demo-assets/<category>/<asset>/preview.png + payload   -> normal folder assets
#   asset-store-cache/<Publisher>/<Category>/*.unitypackage -> Unity cache layout
#     (a raw .unitypackage: the package index reads its previews and contents)
#
# PNGs are generated with zlib only, so no PIL/ImageMagick is needed.
set -euo pipefail

TARGET="${1:-./fixture-assets}"
rm -rf "$TARGET"
mkdir -p "$TARGET"

python3 - "$TARGET" <<'PY'
import io
import os
import struct
import sys
import tarfile
import zlib

root = sys.argv[1]


def png_bytes(width, height, seed=0):
    """Valid RGB PNG (filter 0), deterministic from `seed`."""
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            rows += bytes(((x * 7 + seed) % 256, (y * 5 + seed) % 256, (seed * 3) % 256))

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    blob = b'\x89PNG\r\n\x1a\n'
    blob += chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
    blob += chunk(b'IDAT', zlib.compress(bytes(rows), 6))
    blob += chunk(b'IEND', b'')
    return blob


# --- normal asset folders -------------------------------------------------
assets = {
    'props/chair': ('chair.fbx', 900),
    'props/table': ('table.fbx', 800),
    'props/vase': ('vase.obj', 700),
    'vehicles/kart': ('kart.obj', 1200),
    'nature/tree': ('tree.fbx', 600),
    'textures/grass': ('grass.png', 320),
    'audio/click': ('click.wav', 100),
    'packs/curated-ui': ('ui-kit.unitypackage', 400),
}

for rel, (payload, width) in assets.items():
    folder = os.path.join(root, 'demo-assets', rel)
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, 'preview.png'), 'wb') as fh:
        fh.write(png_bytes(width, int(width * 0.66), width % 200))
    with open(os.path.join(folder, payload), 'wb') as fh:
        fh.write(b'demo payload\n' * 64)
    with open(os.path.join(folder, 'readme.txt'), 'w') as fh:
        fh.write('not importable\n')

# --- Unity Asset Store cache package --------------------------------------
# <Publisher>/<Category>/<Package>.unitypackage, three assets inside, each with
# Unity's own preview.png (this is what the package index reads).
cache_dir = os.path.join(root, 'asset-store-cache', 'Demo Publisher', '3D ModelsKits')
os.makedirs(cache_dir, exist_ok=True)

entries = {
    'a1': ('Assets/Kit/Textures/kit_albedo.png', b'\x89PNG fake' * 900, png_bytes(192, 128, 40)),
    'a2': ('Assets/Kit/Models/kit.fbx', b'fbx-binary' * 4000, png_bytes(256, 200, 120)),
    'a3': ('Assets/Kit/Scripts/KitTools.cs', b'// tool\n' * 300, png_bytes(96, 96, 10)),
}

pkg_path = os.path.join(cache_dir, 'Sample Kit.unitypackage')
with tarfile.open(pkg_path, 'w:gz') as tf:
    for guid, (asset_path, payload, preview) in entries.items():
        for name, data in (
            ('%s/pathname' % guid, (asset_path + '\n').encode()),
            ('%s/asset' % guid, payload),
            ('%s/asset.meta' % guid, b'fileFormatVersion: 2\n'),
            ('%s/preview.png' % guid, preview),
        ):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))

print('fixture library created at', root)
print('  folder assets:', len(assets))
print('  packages:', 1, '(%d assets inside)' % len(entries))
PY

chmod -R a+rX "$TARGET"
echo "previews: $(find "$TARGET" -name preview.png | wc -l)"
