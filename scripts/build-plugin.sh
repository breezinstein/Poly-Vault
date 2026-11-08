#!/usr/bin/env bash
# Builds the Unity package (.tgz + .zip) from this repository's source.
#
#   ./scripts/build-plugin.sh
#
# Output: dist/PolyVault-Unity-<version>.tgz and .zip
#
# The same artifacts are baked into the Docker image and served from the web UI
# (Settings -> Connect Unity), so this script is only needed for local work.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(python3 -c 'import json;print(json.load(open("unity-plugin/PolyVault/package.json"))["version"])' 2>/dev/null \
  || node -p 'require("./unity-plugin/PolyVault/package.json").version')"
PKG_DIR="unity-plugin/PolyVault"
mkdir -p dist
rm -f "dist/PolyVault-Unity-${VERSION}.tgz" "dist/PolyVault-Unity-${VERSION}.zip"

echo "==> packaging com.polyvault.bridge ${VERSION}"

if command -v zip >/dev/null 2>&1; then
  # .zip: package.json at the root (Package Manager -> Add package from disk)
  (cd "$PKG_DIR" && zip -qr "../../dist/PolyVault-Unity-${VERSION}.zip" .)
else
  docker run --rm -v "$PWD":/w -w /w alpine:3.20 sh -c \
    "cd '$PKG_DIR' && zip -qr '../../dist/PolyVault-Unity-${VERSION}.zip' ."
fi

# .tgz: npm/UPM layout (package/package.json)
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/package"
cp -a "$PKG_DIR"/. "$STAGE/package/"
tar czf "dist/PolyVault-Unity-${VERSION}.tgz" -C "$STAGE" package

ls -l dist/PolyVault-Unity-*
echo
echo "Unity: Package Manager -> + -> Add package from disk... -> extract the .zip and pick package.json"
echo "Unity 6 refuses unsigned tarballs unless package signature verification is relaxed;"
echo "the .zip (or an embedded package in Packages/com.polyvault.bridge) is the reliable route."
