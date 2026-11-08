#!/usr/bin/env bash
# Restores a metadata archive created by scripts/backup.sh.
#
#   ./scripts/restore.sh <archive.tgz> [volume-name] [--yes]
#
# The container must be stopped: there is one writer. This script stops it for
# you (docker compose down), verifies the archive, restores it, and starts it
# again. Rehearse this quarterly — an untested backup is not a backup.
set -euo pipefail
cd "$(dirname "$0")/.."

ARCHIVE="$(realpath "${1:?usage: restore.sh <archive.tgz> [volume] [--yes]}")"
VOLUME="${2:-poly-vault-data}"
ASSUME_YES="${3:-}"
CONTAINER="${CONTAINER:-poly-vault}"

[ -f "$ARCHIVE" ] || { echo "no such archive: $ARCHIVE" >&2; exit 1; }

echo "==> verifying archive"
docker run --rm -v "$ARCHIVE":/backup.tgz:ro alpine:3.20 sh -c 'tar tzf /backup.tgz >/dev/null' \
  || { echo "archive is not a valid tarball" >&2; exit 1; }

if [ "$ASSUME_YES" != "--yes" ]; then
  echo
  echo "This will REPLACE the contents of volume '$VOLUME' with $ARCHIVE"
  read -r -p "Type the volume name to continue: " CONFIRM
  [ "$CONFIRM" = "$VOLUME" ] || { echo "aborted"; exit 1; }
fi

echo "==> stopping container"
docker stop "$CONTAINER" >/dev/null 2>&1 || docker compose stop poly-vault >/dev/null 2>&1 || true

echo "==> restoring"
docker run --rm -v "$VOLUME":/data -v "$ARCHIVE":/backup.tgz:ro alpine:3.20 \
  sh -c 'rm -rf /data/* && tar xzf /backup.tgz -C /data && ls -l /data'

echo "==> starting container"
docker start "$CONTAINER" >/dev/null 2>&1 || docker compose up -d poly-vault

echo
echo "Restored. Check with:"
echo "  curl -s localhost:8080/healthz | jq"
echo "  docker logs --tail 20 $CONTAINER"
