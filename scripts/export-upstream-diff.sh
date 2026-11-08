#!/usr/bin/env bash
# Writes one patch containing everything this fork changes relative to upstream.
#
#   ./scripts/export-upstream-diff.sh [upstream-ref]   (default: v0.4.2)
#
# Useful for review, for upstream pull requests, and for rebasing.
set -euo pipefail
cd "$(dirname "$0")/.."

REF="${1:-v0.4.2}"
mkdir -p dist
OUT="dist/poly-vault-vs-upstream.patch"

git fetch -q --tags https://github.com/xeeshanqaswar/Poly-Vault.git "$REF" 2>/dev/null || true
git diff "FETCH_HEAD" -- . ':!patches' > "$OUT" 2>/dev/null || git diff "$REF" -- . ':!patches' > "$OUT"

echo "wrote $OUT ($(wc -l < "$OUT") lines)"
git diff --stat FETCH_HEAD -- . ':!patches' 2>/dev/null | tail -1 || true
