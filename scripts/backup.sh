#!/usr/bin/env bash
# Backs up the Poly Vault metadata (tags, descriptions, library list, import
# jobs, thumbnail cache) from the data volume.
#
#   ./scripts/backup.sh [out-dir] [volume-name]
#
# The asset libraries themselves are NOT backed up here: the container only
# ever reads them, so they belong to whatever already backs up your share.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR="$(realpath "${1:-./backups}")"
VOLUME="${2:-poly-vault-data}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$OUT_DIR/poly-vault-data-$STAMP.tgz"

mkdir -p "$OUT_DIR"

echo "==> archiving volume '$VOLUME' -> $ARCHIVE"
docker run --rm \
  -v "$VOLUME":/data:ro \
  -v "$OUT_DIR":/backup \
  alpine:3.20 \
  sh -c "tar czf /backup/$(basename "$ARCHIVE") -C /data ."

echo "==> verifying archive"
docker run --rm -v "$OUT_DIR":/backup alpine:3.20 sh -c "tar tzf /backup/$(basename "$ARCHIVE")" | head -20

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
echo
echo "OK  $ARCHIVE ($SIZE)"
echo "Restore with: ./scripts/restore.sh $ARCHIVE"
echo "Keep the last few archives; tags/descriptions are hand-made data."
