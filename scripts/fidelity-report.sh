#!/usr/bin/env bash
# Runs the library-wide 3D fidelity report next to the live container.
#
#   ./scripts/fidelity-report.sh [--max-models N] [--max-prefabs N]
#
# Uses the deployed image, the live data volume (link maps in, reports/ out)
# and the library volumes read-only. Takes a while on a large NAS library: it
# reads every package that contains models once. Results appear in Settings
# ("3D fidelity") and in <data>/reports/fidelity-latest.md.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-poly-vault:0.4.2-web}"
PROJECT="${COMPOSE_PROJECT_NAME:-poly-vault-web}"
# Same library name as docker-compose.yml (from .env; may contain spaces).
envval() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n1 | sed 's/^"\(.*\)"$/\1/'; }
LIB2="/libraries/${PV_LIBRARY_2_NAME:-$(envval PV_LIBRARY_2_NAME)}"
[ "$LIB2" = "/libraries/" ] && LIB2="/libraries/Second Library"

exec docker run --rm \
  --name pv-fidelity-report \
  --user 10001:10001 \
  --read-only --tmpfs /tmp:size=2g \
  -v "${PROJECT}_poly_vault_data:/data" \
  -v "${PROJECT}_nas_unity_assets:/assets:ro" \
  -v "${PROJECT}_nas_library_2:${LIB2}:ro" \
  -v "${PROJECT}_nas_rigged:/libraries/Rigged:ro" \
  -e "PV_LIBRARIES=/assets:${LIB2}:/libraries/Rigged" \
  --entrypoint node \
  "$IMAGE" server/fidelityReport.js --data /data "$@"
