#!/usr/bin/env bash
# Runs the CI acceptance suites locally against a throwaway container, never
# against the live deployment: own name, own port, own data volume, fixture
# library. .github/workflows/ci.yml runs exactly this script.
#
#   ./scripts/ci-local.sh [image]          (default: poly-vault:0.4.2-web.1)
#
# Env: PORT (default 18080), KEEP=1 leaves the container running afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${1:-poly-vault:0.4.2-web.1}"
PORT="${PORT:-18080}"
NAME="pv-ci-local"
VOLUME="pv-ci-local-data"
BASE="http://127.0.0.1:${PORT}"
WORK="$(mktemp -d)"
ASSETS="$WORK/assets"
RIGGED="$WORK/rigged"

cleanup() {
  if [ "${KEEP:-0}" != "1" ]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker volume rm "$VOLUME" >/dev/null 2>&1 || true

echo "==> upstream smoke tests"
docker build -q --target source -t poly-vault:ci-source . >/dev/null
docker run --rm --entrypoint node poly-vault:ci-source /app/tests/smoke.js

echo "==> unit tests (link map, material resolution, FBX, textures)"
# The deps stage has sharp + ag-psd, so texture tests run for real.
docker build -q --target deps -t poly-vault:ci-deps . >/dev/null
for t in tests/*.test.js; do
  docker run --rm -e NODE_PATH=/app/node_modules -v "$PWD":/w:ro -w /w poly-vault:ci-deps node "$t" | tail -1 || status_unit=1
done

echo "==> fixture library"
./scripts/make-fixture-library.sh "$ASSETS" >/dev/null
mkdir -p "$RIGGED" && chmod 777 "$RIGGED"
chmod -R a+rX "$WORK"

echo "==> start $NAME on :$PORT"
docker run -d --name "$NAME" --init --read-only --tmpfs /tmp \
  -p "127.0.0.1:${PORT}:8080" \
  -e PV_TOKEN=ci-test-token \
  -e PV_USERS="alice:tok-alice,bob:tok-bob" \
  -e PV_ADMIN_TOKEN=ci-admin \
  -e ASSETVAULT_NO_ENRICH=1 \
  -e PV_LIBRARIES="/assets:/libraries/Rigged" \
  -e PV_LIBRARY_ROOTS="/assets:/libraries" \
  -e PV_RIGGED_DIR=/libraries/Rigged \
  -v "$VOLUME":/data \
  -v "$ASSETS":/assets:ro \
  -v "$RIGGED":/libraries/Rigged \
  "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
  curl -fsS "$BASE/healthz" 2>/dev/null | grep -q '"ok":true' && break
  sleep 1
done

status=0
run() { echo "==> $1"; shift; "$@" || status=1; }

run "phase 2" ./scripts/verify-phase2.sh "$BASE" tok-alice "$ASSETS" "$NAME"
run "phase 3" ./scripts/verify-phase3.sh "$BASE" tok-alice tok-bob "$ASSETS"
run "browser" env HOST_BASE="$BASE" ./scripts/verify-ui.sh "$BASE" tok-alice

echo "==> security smoke"
expect() { if [ "$2" = "$3" ]; then echo "  PASS $1"; else echo "  FAIL $1 expected=$2 got=$3"; status=1; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
expect "api needs auth" 401 "$(code "$BASE/api/library")"
expect "metrics needs auth" 401 "$(code "$BASE/metrics")"
expect "diag disabled" 404 "$(code -H 'Authorization: Bearer tok-alice' "$BASE/__diag?action=update")"
expect "traversal rejected" 400 "$(code -H 'Authorization: Bearer tok-alice' "$BASE/api/preview?path=/assets/../../../etc/hostname")"
expect "cross-origin write rejected" 403 "$(code -X PUT -H 'Authorization: Bearer tok-alice' -H 'Origin: https://evil.example' -H 'Content-Type: application/json' -d '{"path":"/assets","tags":[]}' "$BASE/api/tags")"
expect "no wildcard CORS" "" "$(curl -s -D - -o /dev/null -X OPTIONS -H 'Origin: https://evil.example' "$BASE/api/tags" | grep -i 'access-control-allow-origin' || true)"

echo "==> rig (Mesh2Motion at /rig/)"
ctype() { curl -s -o /dev/null -w '%{content_type}' "$@"; }
expect "rig page signed out = sign-in form" "text/html; charset=utf-8" "$(ctype "$BASE/rig/create.html")"
expect "rig page signed out has no app" "0" "$(curl -s "$BASE/rig/create.html" | grep -c 'Mesh2Motion' || true)"
expect "rig page signed in" 200 "$(code -H 'Authorization: Bearer tok-alice' "$BASE/rig/create.html")"
expect "rig redirect /rig -> /rig/" 301 "$(code -H 'Authorization: Bearer tok-alice' "$BASE/rig")"
expect "rig CSP header" 1 "$(curl -s -D - -o /dev/null -H 'Authorization: Bearer tok-alice' "$BASE/rig/" | grep -ci "content-security-policy: default-src 'self'")"
expect "rig root asset fallback signed in" "model/gltf-binary" "$(ctype -H 'Authorization: Bearer tok-alice' "$BASE/assets/human/skeleton.glb")"
expect "rig root asset fallback signed out" "text/html; charset=utf-8" "$(ctype "$BASE/assets/human/skeleton.glb")"
expect "rig fallback never serves html" 404 "$(code -H 'Authorization: Bearer tok-alice' "$BASE/create.html")"
expect "own UI asset wins over rig" "image/png" "$(ctype -H 'Authorization: Bearer tok-alice' "$BASE/assets/logo.png")"
expect "rig traversal rejected" 404 "$(code -H 'Authorization: Bearer tok-alice' "$BASE/rig/..%2f..%2fserver/server.js")"

echo "==> link map (/api/package/graph)"
PKG="$(cd "$ASSETS" && find . -name '*.unitypackage' | head -1 | sed 's#^\./#/assets/#')"
QPKG="$(printf '%s' "$PKG" | sed 's/ /%20/g')"
graph_code=0
for _ in $(seq 1 30); do
  graph_code="$(code -H 'Authorization: Bearer tok-alice' "$BASE/api/package/graph?path=$QPKG")"
  [ "$graph_code" = 200 ] && break
  sleep 1
done
expect "fixture package gets a link map" 200 "$graph_code"
expect "link map summary is complete" true "$(curl -s -H 'Authorization: Bearer tok-alice' "$BASE/api/package/graph?path=$QPKG" | grep -o '"complete":[a-z]*' | cut -d: -f2)"
expect "link map outside libraries refused" 404 "$(code -H 'Authorization: Bearer tok-alice' "$BASE/api/package/graph?path=/etc/passwd")"
expect "link map needs auth" 401 "$(code "$BASE/api/package/graph?path=$QPKG")"
expect "healthz reports link maps" 1 "$(curl -s -H 'Authorization: Bearer tok-alice' "$BASE/healthz" | grep -c '"graph":{"enabled":true')"

echo "==> models (/api/model/*)"
MODEL="$(curl -s -H 'Authorization: Bearer tok-alice' "$BASE/api/package/tree?path=$QPKG" | grep -o '"path":"[^"]*\.\(fbx\|obj\|FBX\)"' | head -1 | cut -d'"' -f4)"
if [ -n "$MODEL" ]; then
  QMODEL="$(printf '%s' "$MODEL" | sed 's/ /%20/g')"
  expect "model manifest" 200 "$(code -H 'Authorization: Bearer tok-alice' "$BASE/api/model/manifest?path=$QPKG&entry=$QMODEL")"
else
  echo "  (fixture has no model file: manifest check skipped)"
fi
expect "manifest needs auth" 401 "$(code "$BASE/api/model/manifest?path=$QPKG&entry=x.fbx")"
expect "manifest outside libraries refused" 404 "$(code -H 'Authorization: Bearer tok-alice' "$BASE/api/model/manifest?path=/etc/passwd&entry=x.fbx")"
expect "texture key validated" 400 "$(code -H 'Authorization: Bearer tok-alice' "$BASE/api/model/texture?path=$QPKG&key=../../etc")"
expect "texture outside package refused" 404 "$(code -H 'Authorization: Bearer tok-alice' "$BASE/api/model/texture?path=$QPKG&key=albedo:0123456789abcdef0123456789abcdef")"

echo "==> Save to vault (/api/web/rigged)"
GLB="$WORK/t.glb"
printf 'glTF\002\000\000\000\024\000\000\000\000\000\000\000JSON' > "$GLB"
post() { curl -s -o /dev/null -w '%{http_code}' -X POST -H "Origin: $BASE" "$@"; }
expect "bridge injected into Mesh2Motion" 1 "$(curl -s -H 'Authorization: Bearer tok-alice' "$BASE/rig/create.html" | grep -c 'pv-bridge.js')"
expect "session says the vault can save" 1 "$(curl -s -H 'Authorization: Bearer tok-alice' "$BASE/api/web/session" | grep -c '"canSave":true')"
expect "save rigged GLB" 200 "$(post -H 'Authorization: Bearer tok-alice' --data-binary @"$GLB" "$BASE/api/web/rigged?name=Crate.glb&kind=create&from=Crate.fbx")"
expect "name/content mismatch refused" 415 "$(post -H 'Authorization: Bearer tok-alice' --data-binary @"$GLB" "$BASE/api/web/rigged?name=Crate.fbx")"
expect "non-model refused" 415 "$(post -H 'Authorization: Bearer tok-alice' --data-binary 'hello' "$BASE/api/web/rigged?name=x.glb")"
expect "cross-origin save refused" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Authorization: Bearer tok-alice' -H 'Origin: https://evil.example' --data-binary @"$GLB" "$BASE/api/web/rigged?name=a.glb")"
expect "save needs auth" 401 "$(post --data-binary @"$GLB" "$BASE/api/web/rigged?name=a.glb")"
expect "preview folder traversal refused" 400 "$(post -H 'Authorization: Bearer tok-alice' --data-binary 'x' "$BASE/api/web/rigged/preview?folder=..")"
expect "saved file on disk" 1 "$(ls "$RIGGED/Crate" 2>/dev/null | grep -c 'Crate__rigged.glb')"
sleep 1
expect "rigged card tagged in the library" 1 "$(curl -s -H 'Authorization: Bearer tok-alice' "$BASE/api/library" | grep -o '"tags":\["rigged","rig:create","mesh2motion"\]' | head -1 | wc -l)"

echo "==> 3D in a browser (scripts/verify-3d.sh)"
./scripts/verify-3d.sh "$IMAGE" || status=1

[ "${status_unit:-0}" -ne 0 ] && status=1
if [ "$status" -ne 0 ]; then
  echo "==> FAILED — container logs:"
  docker logs --tail 80 "$NAME" || true
  exit 1
fi
echo "==> all suites passed"
