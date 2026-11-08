#!/usr/bin/env bash
# Phase-2 verification: payload size, revalidation, thumbnails, audit, metrics.
# Usage: ./scripts/verify-phase2.sh [base-url] [token] [host-assets-path]
set -uo pipefail

BASE="${1:-http://127.0.0.1:8080}"
TOKEN="${2:-tok-alice}"
HOST_ASSETS="${3:-}"
CONTAINER="${4:-}"   # optional: container name, enables audit-log assertions
PASS=0
FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

check() {
  if [ "$2" = "$3" ]; then printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS + 1));
  else printf '  \033[31mFAIL\033[0m %s (expected %s, got %s)\n' "$1" "$2" "$3"; FAIL=$((FAIL + 1)); fi
}
json() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1" 2>/dev/null; }
urlenc() { python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$1"; }
auth() { printf 'Authorization: Bearer %s' "$1"; }

echo "== compression =="
curl -s -H "$(auth "$TOKEN")" -o "$WORK/plain.json" "$BASE/api/library"
curl -s -H "$(auth "$TOKEN")" -H 'Accept-Encoding: gzip' -D "$WORK/gz.hdr" -o "$WORK/gz.json" "$BASE/api/library"
PLAIN=$(stat -c%s "$WORK/plain.json")
GZ=$(stat -c%s "$WORK/gz.json")
check "library payload gzipped" "1" "$(grep -ci 'content-encoding: gzip' "$WORK/gz.hdr")"
check "gzip body decompresses" "ok" "$(python3 -c "
import gzip, json, sys
try:
    d = json.load(gzip.open(sys.argv[1]))
    print('ok' if d.get('ok') else 'bad')
except Exception as e:
    print('bad: %s' % e)
" "$WORK/gz.json")"
check "gzip is smaller than plain" "yes" "$([ "$GZ" -lt "$PLAIN" ] && echo yes || echo no)"
printf '       plain %s B -> gzip %s B (%.1f%%)\n' "$PLAIN" "$GZ" "$(python3 -c "print(100*$GZ/$PLAIN)")"

echo "== revalidation =="
ETAG=$(grep -i '^etag' "$WORK/gz.hdr" | tr -d '\r' | cut -d' ' -f2-)
check "ETag present" "yes" "$([ -n "$ETAG" ] && echo yes || echo no)"
check "If-None-Match -> 304 with empty body" "304 0" "$(curl -s -o /dev/null -w '%{http_code} %{size_download}' -H "$(auth "$TOKEN")" -H "If-None-Match: $ETAG" "$BASE/api/library")"
check "cache-control allows storing" "1" "$(curl -s -D - -o /dev/null -H "$(auth "$TOKEN")" "$BASE/api/library" | grep -ci 'cache-control: private, no-cache')"

echo "== thumbnails =="
LIB_JSON="$(curl -s -H "$(auth "$TOKEN")" "$BASE/api/library")"
PREVIEW="$(printf '%s' "$LIB_JSON" | json "next((a['preview']['path'] for l in d['libraries'] for a in l['assets'] if a.get('preview')), '')")"
if [ -z "$PREVIEW" ]; then
  echo "  (no previews in this library, skipping)"
else
  check "thumb returns webp" "1" "$(curl -s -D - -o "$WORK/t.webp" -H "$(auth "$TOKEN")" "$BASE/api/thumb?path=$(urlenc "$PREVIEW")&w=320" | grep -ci 'content-type: image/webp')"
  check "thumb is a real webp" "ok" "$(python3 -c "
import sys
b = open(sys.argv[1],'rb').read()
print('ok' if b[:4] == b'RIFF' and b[8:12] == b'WEBP' else 'bad')
" "$WORK/t.webp")"
  check "second request is a cache hit" "hit" "$(curl -s -D - -o /dev/null -H "$(auth "$TOKEN")" "$BASE/api/thumb?path=$(urlenc "$PREVIEW")&w=320" | grep -i '^x-pv-thumb' | tr -d '\r' | cut -d' ' -f2)"
  if [ -n "$HOST_ASSETS" ]; then
    host_preview="$HOST_ASSETS${PREVIEW#/assets}"
    if [ -f "$host_preview" ]; then
      thumb_size=$(stat -c%s "$WORK/t.webp"); src_size=$(stat -c%s "$host_preview")
      if [ "$src_size" -gt 20000 ]; then
        check "thumb smaller than original" "yes" "$([ "$thumb_size" -lt "$src_size" ] && echo yes || echo no)"
        printf '       %s B -> %s B\n' "$src_size" "$thumb_size"
      fi
    fi
  fi
  check "thumb of a folder -> 400" "400" "$(curl -s -o /dev/null -w '%{http_code}' -H "$(auth "$TOKEN")" "$BASE/api/thumb?path=$(urlenc "${PREVIEW%/*}")&w=320")"
  check "thumb outside library -> 403" "403" "$(curl -s -o /dev/null -w '%{http_code}' -H "$(auth "$TOKEN")" "$BASE/api/thumb?path=/etc/hostname&w=320")"
fi

echo "== package index (.unitypackage contents) =="
# The fixture ships one Unity-cache-style package (Publisher/Category/*.unitypackage)
# with three assets inside; the index should give it a preview and contents.
PKG_LINE=""
for _ in $(seq 1 30); do
  PKG_LINE=$(curl -s -H "$(auth "$TOKEN")" "$BASE/api/library" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for lib in d['libraries']:
    for a in lib['assets']:
        if a.get('packageFile') and a.get('preview') and a.get('contentsTotal'):
            print('%s|%s|%s' % (a['name'], a['contentsTotal'], a['preview']['path']))
            raise SystemExit
print('')
" 2>/dev/null)
  [ -n "$PKG_LINE" ] && break
  sleep 1
done
check "package card gets a thumbnail + counts" "yes" "$([ -n "$PKG_LINE" ] && echo yes || echo no)"

if [ -n "$PKG_LINE" ]; then
  PKG_NAME=$(printf '%s' "$PKG_LINE" | cut -d'|' -f1)
  PKG_FILES=$(printf '%s' "$PKG_LINE" | cut -d'|' -f2)
  PKG_PREVIEW=$(printf '%s' "$PKG_LINE" | cut -d'|' -f3)
  check "package contents are counted" "3" "$PKG_FILES"
  check "package thumbnail is served as webp" "1" "$(curl -s -D - -o /dev/null -H "$(auth "$TOKEN")" "$BASE/api/thumb?path=$(urlenc "$PKG_PREVIEW")&w=320" | grep -ci 'content-type: image/webp')"
  check "package preview also on /api/preview" "200" "$(curl -s -o /dev/null -w '%{http_code}' -H "$(auth "$TOKEN")" "$BASE/api/preview?path=$(urlenc "$PKG_PREVIEW")")"

  PKG_PATH=$(curl -s -H "$(auth "$TOKEN")" "$BASE/api/library" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for lib in d['libraries']:
    for a in lib['assets']:
        if a.get('packageFile'):
            print(a['folder'])
            raise SystemExit
")
  DETAIL=$(curl -s -H "$(auth "$TOKEN")" "$BASE/api/package?path=$(urlenc "$PKG_PATH")")
  check "on-demand contents list" "3" "$(printf '%s' "$DETAIL" | json "len(d.get('contents', []))")"
  check "contents include real asset paths" "1" "$(printf '%s' "$DETAIL" | json "1 if any(c['path'].startswith('Assets/') for c in d['contents']) else 0")"
  printf '       card: %s (%s files inside)\n' "$PKG_NAME" "$PKG_FILES"
fi
if [ -n "$CONTAINER" ]; then
  check "index cache is on disk" "yes" "$(docker exec "$CONTAINER" sh -c '[ -d /data/packages/meta ] && [ -n "$(ls -A /data/packages/previews 2>/dev/null)" ] && echo yes || echo no')"
fi

echo "== audit log =="
TARGET="$(printf '%s' "$LIB_JSON" | json "next((a['folder'] for l in d['libraries'] for a in l['assets']), '')")"
curl -s -o /dev/null -H "$(auth "$TOKEN")" -H 'Content-Type: application/json' -X PUT "$BASE/api/tags" \
  -d "{\"path\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$TARGET"),\"tags\":[\"verify-phase2\"]}"
curl -s -o /dev/null -H "$(auth "$TOKEN")" -H 'Content-Type: application/json' -X PUT "$BASE/api/meta" \
  -d "{\"path\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$TARGET"),\"description\":\"phase2 check\"}"

if [ -n "$CONTAINER" ]; then
  check "audit records the tag write" "yes" "$(docker exec "$CONTAINER" sh -c 'grep -c "\"event\":\"api_mutation\"" /data/audit.jsonl' 2>/dev/null | awk '{print ($1>0)?"yes":"no"}')"
fi

echo "== metrics =="
check "metrics endpoint" "200" "$(curl -s -o "$WORK/metrics" -w '%{http_code}' -H "$(auth "$TOKEN")" "$BASE/metrics")"
check "counters exposed" "1" "$(grep -c '^pv_http_requests_total ' "$WORK/metrics")"
check "307/304 counted" "1" "$(grep -c '^pv_api_304_total ' "$WORK/metrics")"
check "metrics requires auth" "401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/metrics")"

echo "== incremental scan =="
# warm up first: the tag/meta writes above invalidate the scan once
curl -s -o /dev/null -H "$(auth "$TOKEN")" "$BASE/api/library"
BEFORE=$(curl -s -H "$(auth "$TOKEN")" "$BASE/healthz" | json "d['scan']['scans']")
for _ in 1 2 3; do curl -s -o /dev/null -H "$(auth "$TOKEN")" "$BASE/api/library"; done
AFTER=$(curl -s -H "$(auth "$TOKEN")" "$BASE/healthz" | json "d['scan']['scans']")
check "idle polls do not rescan" "$BEFORE" "$AFTER"

if [ -n "$HOST_ASSETS" ] && [ -w "$HOST_ASSETS" ]; then
  echo "== fs.watch invalidation =="
  mkdir -p "$HOST_ASSETS/_verify_tmp_asset"
  printf 'x' > "$HOST_ASSETS/_verify_tmp_asset/model.fbx"
  cp "$(ls "$HOST_ASSETS"/*/*/*/*/preview.png 2>/dev/null | head -1)" "$HOST_ASSETS/_verify_tmp_asset/preview.png" 2>/dev/null || printf 'x' > "$HOST_ASSETS/_verify_tmp_asset/preview.png"
  sleep 2.5
  curl -s -o /dev/null -H "$(auth "$TOKEN")" "$BASE/api/library"
  B2=$(curl -s -H "$(auth "$TOKEN")" "$BASE/healthz" | json "d['scan']['scans']")
  check "new folder triggers a rescan" "yes" "$([ "$B2" -gt "$AFTER" ] && echo yes || echo no)"
  rm -rf "$HOST_ASSETS/_verify_tmp_asset"
fi

echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
