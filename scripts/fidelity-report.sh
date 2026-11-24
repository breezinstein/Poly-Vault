#!/usr/bin/env bash
# Runs the library-wide 3D fidelity report next to the live container.
#
#   ./scripts/fidelity-report.sh [--max-models N] [--max-prefabs N] [--only <path>]
#
# A one-off container of the compose service: same image, data volume, library
# mounts and PV_LIBRARIES as the deployment (plain or NAS variant, whichever
# COMPOSE_FILE selects). Takes a while on a large library: it reads every
# package that contains models once. Results appear in Settings ("3D
# fidelity") and in <data>/reports/fidelity-latest.md.
set -euo pipefail
cd "$(dirname "$0")/.."

exec docker compose run --rm --no-deps -T --entrypoint node poly-vault \
  server/fidelityReport.js --data /data "$@"
