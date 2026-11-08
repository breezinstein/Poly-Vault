#!/usr/bin/env bash
# Phase-3 verification: downloads over HTTP + per-artist job targeting.
# Runs against a live container. Usage:
#   ./scripts/verify-phase3.sh [base-url] [token-alice] [token-bob] [host-assets-path]
#
#   host-assets-path is optional: pass the host directory mounted at /assets and
#   the script additionally compares downloaded byte sizes with the source.
set -uo pipefail

BASE="${1:-http://127.0.0.1:8080}"
ALICE="${2:-tok-alice}"
BOB="${3:-tok-bob}"
HOST_ASSETS="${4:-}"

PASS=0
FAIL=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

check() { # label expected actual
  if [ "$2" = "$3" ]; then
    printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS + 1))
  else
    printf '  \033[31mFAIL\033[0m %s (expected %s, got %s)\n' "$1" "$2" "$3"; FAIL=$((FAIL + 1))
  fi
}

json() { # expression over `d`, stdin = JSON document
  python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1" 2>/dev/null
}

urlenc() { python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))' "$1"; }

auth() { printf 'Authorization: Bearer %s' "$1"; }

echo "== identity =="
check "alice session" "alice" "$(curl -s -H "$(auth "$ALICE")" "$BASE/api/web/session" | json "d['user']")"
check "bob session" "bob" "$(curl -s -H "$(auth "$BOB")" "$BASE/api/web/session" | json "d['user']")"
check "bad token rejected" "401" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer nope' "$BASE/api/library")"

echo "== pick an importable asset =="
LIB_JSON="$(curl -s -H "$(auth "$ALICE")" "$BASE/api/library")"
FOLDER="$(printf '%s' "$LIB_JSON" | json "next((a['folder'] for l in d['libraries'] for a in l['assets'] if a['importable'] and a['kind']=='mesh'), '')")"
check "library has a mesh asset" "yes" "$([ -n "$FOLDER" ] && echo yes || echo no)"
[ -z "$FOLDER" ] && { echo "mount a library with meshes first"; exit 1; }

IMPORTS="$(printf '%s' "$LIB_JSON" | python3 -c '
import json, sys
d = json.load(sys.stdin)
folder = sys.argv[1]
for lib in d["libraries"]:
    for a in lib["assets"]:
        if a["folder"] == folder:
            print(json.dumps([{k: i[k] for k in ("name", "path", "rel", "kind")} for i in a["importables"]]))
            raise SystemExit
' "$FOLDER")"
FILE_PATH="$(printf '%s' "$IMPORTS" | json "d[0]['path']")"
FILE_NAME="$(printf '%s' "$IMPORTS" | json "d[0]['name']")"
FILE_Q="$(urlenc "$FILE_PATH")"
FOLDER_Q="$(urlenc "$FOLDER")"

echo "== file download =="
check "alice can download" "200" "$(curl -s -o "$WORK/dl.bin" -w '%{http_code}' -H "$(auth "$ALICE")" "$BASE/api/file?path=$FILE_Q")"
check "body is non-empty" "yes" "$([ -s "$WORK/dl.bin" ] && echo yes || echo no)"
check "attachment header" "1" "$(curl -s -D - -o /dev/null -H "$(auth "$ALICE")" "$BASE/api/file?path=$FILE_Q" | grep -ci 'content-disposition: attachment')"
if [ -n "$HOST_ASSETS" ]; then
  host_file="$HOST_ASSETS${FOLDER#/assets}/$FILE_NAME"
  check "byte size matches source" "$(stat -c%s "$host_file" 2>/dev/null)" "$(stat -c%s "$WORK/dl.bin")"
fi
check "no auth -> 401" "401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/file?path=$FILE_Q")"
check "outside library -> 403" "403" "$(curl -s -o /dev/null -w '%{http_code}' -H "$(auth "$ALICE")" "$BASE/api/file?path=/etc/hostname")"
check "folder is not a file -> 400" "400" "$(curl -s -o /dev/null -w '%{http_code}' -H "$(auth "$ALICE")" "$BASE/api/file?path=$FOLDER_Q")"
# /api/download also streams a single file: that is how file-backed assets
# (one .unitypackage from Unity's Asset Store cache) are downloaded.
check "download serves a file-backed asset" "200 $(stat -c%s "$WORK/dl.bin")" "$(curl -s -o /dev/null -w '%{http_code} %{size_download}' -H "$(auth "$ALICE")" "$BASE/api/download?path=$FILE_Q")"

echo "== folder zip =="
check "zip download" "200" "$(curl -s -o "$WORK/asset.zip" -w '%{http_code}' -H "$(auth "$ALICE")" "$BASE/api/download?path=$FOLDER_Q")"
check "zip is valid and non-empty" "ok" "$(python3 -c '
import zipfile, sys
try:
    z = zipfile.ZipFile(sys.argv[1])
    print("ok" if z.testzip() is None and len(z.namelist()) else "bad")
except Exception as e:
    print("bad: %s" % e)
' "$WORK/asset.zip")"

echo "== job targeting =="
JOB="$(curl -s -H "$(auth "$ALICE")" -H 'Content-Type: application/json' -X POST "$BASE/api/import-job" \
  -d "{\"assetFolder\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$FOLDER"),\"assetName\":\"verify\",\"category\":\"\",\"libraryName\":\"verify\",\"tags\":[\"phase3\"],\"importables\":$IMPORTS}")"
JOB_ID="$(printf '%s' "$JOB" | json "d['job']['id']")"
check "job queued and attributed" "alice" "$(printf '%s' "$JOB" | json "d['job']['targetUser']")"
check "alice's Unity sees it" "1" "$(curl -s -H "$(auth "$ALICE")" "$BASE/api/unity/import-jobs" | json "sum(1 for j in d['jobs'] if j['id']=='$JOB_ID')")"
check "bob's Unity does not" "0" "$(curl -s -H "$(auth "$BOB")" "$BASE/api/unity/import-jobs" | json "sum(1 for j in d['jobs'] if j['id']=='$JOB_ID')")"
check "artist echoed to plugin" "alice" "$(curl -s -H "$(auth "$ALICE")" "$BASE/api/unity/import-jobs" | json "d['artist']")"
check "web job list: bob" "0" "$(curl -s -H "$(auth "$BOB")" "$BASE/api/import-jobs" | json "sum(1 for j in d['jobs'] if j['id']=='$JOB_ID')")"
check "web job list: alice" "1" "$(curl -s -H "$(auth "$ALICE")" "$BASE/api/import-jobs" | json "sum(1 for j in d['jobs'] if j['id']=='$JOB_ID')")"

echo "== cookie session (browser path) keeps identity =="
curl -s -c "$WORK/cookies" -X POST "$BASE/login" -d "token=$ALICE" -o /dev/null
COOKIE_JOB="$(curl -s -b "$WORK/cookies" -H 'Content-Type: application/json' -X POST "$BASE/api/import-job" \
  -d "{\"assetFolder\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$FOLDER"),\"assetName\":\"cookie-verify\",\"category\":\"\",\"libraryName\":\"verify\",\"tags\":[],\"importables\":$IMPORTS}")"
check "cookie login attributes the job" "alice" "$(printf '%s' "$COOKIE_JOB" | json "d['job']['requestedBy']")"

echo "== claim + complete =="
check "alice claims" "processing" "$(curl -s -H "$(auth "$ALICE")" -H 'Content-Type: application/json' -X POST "$BASE/api/unity/import-jobs/$JOB_ID/processing" -d '{"note":"downloading"}' | json "d['job']['status']")"
check "claimed by alice" "alice" "$(curl -s -H "$(auth "$ALICE")" "$BASE/api/unity/import-jobs" | json "next((j['claimedBy'] for j in d['jobs'] if j['id']=='$JOB_ID'), 'missing')")"
check "bob still cannot see it" "0" "$(curl -s -H "$(auth "$BOB")" "$BASE/api/unity/import-jobs" | json "sum(1 for j in d['jobs'] if j['id']=='$JOB_ID')")"
check "complete" "done" "$(curl -s -H "$(auth "$ALICE")" -H 'Content-Type: application/json' -X POST "$BASE/api/unity/import-jobs/$JOB_ID/complete" -d '{"note":"Imported 2 file(s)."}' | json "d['job']['status']")"

echo
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
