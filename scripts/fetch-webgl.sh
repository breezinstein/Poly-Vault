#!/usr/bin/env bash
# Vendors the WebGL preview engine (three.js loaders) into ui/webgl/vendor/.
#
#   ./scripts/fetch-webgl.sh
#
# The viewer is optional: the Dockerfile runs this in a build stage and copies
# the result into the image. Nothing is fetched from a CDN at runtime, so the
# deployment works offline and the app's strict CSP ("default-src 'self'") holds.
set -euo pipefail
cd "$(dirname "$0")/.."

THREE_VERSION="${THREE_VERSION:-0.170.0}"
FFLATE_VERSION="${FFLATE_VERSION:-0.8.2}"
OUT="ui/webgl/vendor"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> three@${THREE_VERSION} + fflate@${FFLATE_VERSION}"
(cd "$TMP" && npm init -y >/dev/null 2>&1 \
  && npm install --no-audit --no-fund --silent "three@${THREE_VERSION}" "fflate@${FFLATE_VERSION}")

rm -rf "$OUT"
mkdir -p "$OUT"

cp "$TMP/node_modules/three/build/three.module.min.js" "$OUT/three.module.min.js"
cp "$TMP/node_modules/fflate/esm/browser.js" "$OUT/fflate.module.js"

for f in controls/OrbitControls.js \
         loaders/OBJLoader.js loaders/GLTFLoader.js loaders/STLLoader.js \
         loaders/PLYLoader.js loaders/FBXLoader.js \
         utils/BufferGeometryUtils.js; do
  cp "$TMP/node_modules/three/examples/jsm/$f" "$OUT/$(basename "$f")"
done

# Copy + rewrite everything those modules pull in (../utils, ../curves, ../libs).
python3 scripts/flatten_webgl_vendor.py "$OUT" "$TMP/node_modules/three/examples/jsm"

du -sh "$OUT" && ls -1 "$OUT"
echo
echo "Vendored. The Settings toggle '3D model preview (WebGL)' now works."
