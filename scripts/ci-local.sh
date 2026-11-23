#!/usr/bin/env bash
# Runs the CI acceptance suites locally against a throwaway container, never
# against the live deployment: own name, own port, own data volume, fixture
# library. Mirrors .github/workflows/ci.yml.
#
#   ./scripts/ci-local.sh [image]          (default: poly-vault:0.4.2-web)
#
# Env: PORT (default 18080), KEEP=1 leaves the container running afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${1:-poly-vault:0.4.2-web}"
PORT="${PORT:-18080}"
NAME="pv-ci-local"
VOLUME="pv-ci-local-data"
BASE="http://127.0.0.1:${PORT}"
WORK="$(mktemp -d)"
ASSETS="$WORK/assets"

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

echo "==> fixture library"
./scripts/make-fixture-library.sh "$ASSETS" >/dev/null
chmod -R a+rX "$WORK"

echo "==> start $NAME on :$PORT"
docker run -d --name "$NAME" --init --read-only --tmpfs /tmp \
  -p "127.0.0.1:${PORT}:8080" \
  -e PV_TOKEN=ci-test-token \
  -e PV_USERS="alice:tok-alice,bob:tok-bob" \
  -e PV_ADMIN_TOKEN=ci-admin \
  -e ASSETVAULT_NO_ENRICH=1 \
  -v "$VOLUME":/data \
  -v "$ASSETS":/assets:ro \
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

if [ "$status" -ne 0 ]; then
  echo "==> FAILED — container logs:"
  docker logs --tail 80 "$NAME" || true
  exit 1
fi
echo "==> all suites passed"
