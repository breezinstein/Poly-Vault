# Poly Vault — team web build
#
# Self-contained build: this repository already contains the patched upstream
# sources, so nothing is fetched at build time (reproducible, works offline, and
# `docker build` works from a plain tarball of the repo).
#
# Stages:
#   source       sanity-checks the JavaScript and holds the tree for later stages
#   unity-plugin builds the Unity add-on (.tgz for UPM, .zip for "add from disk")
#   deps         the only runtime dependency: sharp (image resizing)
#   runtime      node + src/ui + server/ — no npm, no Electron

ARG NODE_IMAGE=node:24-alpine
ARG APP_VERSION=0.4.2-web.1

# ---------------------------------------------------------------------------
# Stage 1 — source sanity check
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS source
ARG APP_VERSION
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY ui ./ui
COPY unity-plugin ./unity-plugin
COPY tests ./tests
RUN node -e "require('/app/src/main/library.js'); require('/app/src/main/bridgeServer.js'); console.log('patched source loads')"

# ---------------------------------------------------------------------------
# Stage 2 — Unity package
# ---------------------------------------------------------------------------
FROM source AS unity-plugin
# UPM installs tarballs with npm, and npm tarballs wrap the package in a
# top-level "package/" folder (what "npm pack" produces). The .zip keeps the
# package at the archive root for Package Manager's "Add package from disk".
RUN set -eux; \
    apk add --no-cache zip >/dev/null; \
    VERSION="$(node -p "require('/app/unity-plugin/PolyVault/package.json').version")"; \
    mkdir -p /out /stage/package; \
    cp -a /app/unity-plugin/PolyVault/. /stage/package/; \
    tar czf "/out/PolyVault-Unity-${VERSION}.tgz" -C /stage package; \
    (cd /app/unity-plugin/PolyVault && zip -qr "/out/PolyVault-Unity-${VERSION}.zip" .); \
    echo "--- tarball layout (npm style) ---"; tar tzf "/out/PolyVault-Unity-${VERSION}.tgz" | head -3; \
    ls -l /out

# ---------------------------------------------------------------------------
# Stage 3 — optional WebGL preview engine (three.js loaders, vendored)
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS webgl
WORKDIR /app
RUN apk add --no-cache python3
COPY scripts/fetch-webgl.sh scripts/flatten_webgl_vendor.py ./scripts/
COPY ui/webgl/viewer.js ./ui/webgl/viewer.js
RUN sh scripts/fetch-webgl.sh

# ---------------------------------------------------------------------------
# Stage 4 — runtime dependencies (only what the web shell needs)
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# sharp ships prebuilt libvips binaries (musl included); no toolchain needed.
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && npm install --omit=dev --no-audit --no-fund sharp@0.33.5 \
 && apk del .build-deps \
 && npm cache clean --force

# ---------------------------------------------------------------------------
# Stage 5 — minimal runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG APP_VERSION
LABEL org.opencontainers.image.title="Poly Vault (web)" \
      org.opencontainers.image.description="Self-hosted web build of Poly Vault, a 3D/2D asset library for teams" \
      org.opencontainers.image.source="https://github.com/xeeshanqaswar/Poly-Vault" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PV_HOST=0.0.0.0 \
    PV_PORT=8080 \
    PV_BRIDGE_PORT=7100 \
    PV_DATA_DIR=/data \
    PV_LIBRARY_ROOTS=/assets \
    TZ=UTC

# The runtime never installs packages: drop npm/corepack to shrink the image.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

RUN addgroup -S -g 10001 polyvault \
 && adduser -S -D -H -u 10001 -G polyvault polyvault \
 && mkdir -p /data /assets \
 && chown -R 10001:10001 /data

WORKDIR /app

COPY --from=source --chown=root:root /app/package.json ./package.json
COPY --from=source --chown=root:root /app/src ./src
COPY --from=source --chown=root:root /app/ui ./ui
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
# 3D preview engine (Settings -> Preview toggle). Absent = the UI falls back to
# Unity's stored thumbnails, so the image still works without it.
COPY --from=webgl --chown=root:root /app/ui/webgl/vendor ./ui/webgl/vendor
# The Unity add-on is served from the UI (Settings -> Unity) so artists always
# get the build that matches this server.
COPY --from=unity-plugin --chown=root:root /out ./plugin
COPY --chown=root:root server ./server

USER 10001:10001

VOLUME ["/data"]
EXPOSE 8080
STOPSIGNAL SIGTERM

# node 24 ships global fetch; no curl in the runtime image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PV_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/server.js"]
