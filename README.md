# Poly Vault — self-hosted web build

A fork of [Poly Vault](https://github.com/xeeshanqaswar/Poly-Vault) (MIT) that runs
as a shared web service for a team instead of a per-workstation Electron app:
same domain logic, browser UI, Docker deployment, HTTP import into Unity, and a
`.unitypackage` indexer that extracts previews and contents from the archives.

**Read [`AUDIT-AND-PLAN.md`](./AUDIT-AND-PLAN.md) first** — it contains the audit
of upstream, the measured evidence behind every change, the phased plan and the
decisions taken along the way.

---

## What is in this folder

| Path | Purpose |
| --- | --- |
| `AUDIT-AND-PLAN.md` | Audit of the upstream project + phased containerisation plan |
| `Dockerfile` | Multi-stage, self-contained build (no network fetch) → ~272 MB runtime |
| `docker-compose.yml` | Hardened service definition (read-only rootfs, non-root, loopback port, limits) |
| `patches/` | The complete diff against upstream `v0.4.2` — already applied (see "Upstream patches") |
| `server/server.js` | The web front door: auth, static UI, scan cache, downloads, proxy to the untouched bridge API |
| `server/zipStream.js` | Zero-dependency streaming ZIP writer for "Download" (no temp files, works on a read-only rootfs) |
| `server/web-shim.js` | Replaces Electron's `preload.js` (`window.assetVault`) in the browser |
| `server/thumbs.js` | WebP thumbnail cache (sharp), keyed by file+mtime+width |
| `server/unityPackage.js`, `server/packageIndex.js`, `server/pkgWorker.js` | Reads `.unitypackage` archives: embedded previews, real content lists, type counts |
| `server/metrics.js`, `server/audit.js` | Prometheus counters + JSONL audit trail |
| `scripts/verify-phase2.sh` | 18 checks: gzip, ETag/304, thumbnails, audit, metrics, incremental scan |
| `scripts/verify-phase3.sh` | 25 checks: downloads + per-artist import routing |
| `scripts/verify-ui.sh` | 12 browser checks in headless Chromium (sign-in → tag → download → 304 polling) |
| `scripts/build-plugin.sh` | Builds `dist/PolyVault-Unity-<ver>.tgz/.zip` from the patched source |
| `scripts/make-fixture-library.sh` | Generates a throwaway library with real PNG previews |
| `scripts/backup.sh`, `scripts/restore.sh` | Metadata volume backup + rehearsable restore |
| `RUNBOOK.md` | Day-2 operations: upgrade, rollback, rotation, troubleshooting |
| `deploy/Caddyfile.example` | TLS + SSO/basic-auth reverse proxy in front of the container |

Upstream `src/main/index.js` (Electron main) and `src/preload.js` are **not used**.
Everything else — scanner, stores, bridge API, enrichment, UI — is upstream code.

## Quick start

```bash
cp .env.example .env          # set PV_TOKEN (and PV_ADMIN_TOKEN)
$EDITOR docker-compose.yml    # point the /assets volume at your asset share
docker compose up -d --build
open http://127.0.0.1:8080    # sign in with PV_TOKEN
```

### Asset storage: NFS (Unity Asset Store cache) or a local path

The shipped `docker-compose.yml` points at the NAS export that holds the Unity
Asset Store cache:

```yaml
volumes:
  - ./data:/data
  - nas_unity_assets:/assets:ro

volumes:
  nas_unity_assets:
    driver_opts:
      type: nfs
      o: "addr=${PV_NFS_ADDR:?set PV_NFS_ADDR},nolock,soft,ro,actimeo=60"
      device: ":/export/unity-assets"
```

Why those mount options: `nolock` (no lockd needed, read-only), `soft` (a dead
NAS returns `EIO` instead of hanging the container), `ro` (defence in depth — the
container never writes), `actimeo=60` (the scanner stats every file; without
attribute caching each stat is a network round trip).

For a local library, comment the NFS line and use:

```yaml
volumes:
  - ./data:/data
  - /srv/assets:/assets:ro      # /srv/assets/<folder> becomes a library
```

### Package intelligence: thumbnails and contents from the archives

A `.unitypackage` is a gzipped tar that already contains Unity's own preview
images and the real project paths of everything inside it (the same structure
the browser tool [peraperavrc/package-extractor](https://github.com/peraperavrc/package-extractor)
exploits). Poly Vault reads that archive directly, so package cards get:

- **a real thumbnail** — extracted from the archive, no Asset Store request;
- **honest type counts** — e.g. "240 meshes, 239 prefabs, 10 animations";
- **a "What's inside" list** — the largest files with their project paths.

Everything is streamed, cached per `(path, mtime, size)` under `/data/packages`,
and parsed on a worker thread so a 12 GB package never stalls the API.

Cost: gzip is not seekable, so a full pass reads the archives once — for the
631-package / 109 GB export the preview pass reads ~10–60 MB per package
(≈5–10 GB, minutes) and the optional full pass up to 256 MB per package. Both
are budgeted, sequential and resumable.

Multiple libraries: mount each root read-only and list it in `PV_LIBRARIES`
(colon-separated). The folder name becomes the library name, so
`/libraries/Other Unity Assets` shows up as **Other Unity Assets**. Every root
must also sit under `PV_LIBRARY_ROOTS` if you want the in-app "Add Library"
button to reach it. Keep existing libraries at their existing paths — tags and
descriptions are keyed by absolute path.

**Unity's cache layout is understood natively.** The export is
`<Publisher>/<Category>/<Package Name>.unitypackage` with no per-package folder
and no previews. Poly Vault turns **each package into its own card** (real name,
own tags/description, one importable) instead of collapsing a category folder
into a single card, and the Asset Store lookup fills in the description and tags.
Folders that *do* have a preview keep the normal one-folder-per-asset behaviour.

Measured on the real export (nas.example.internal, 632 packages, 108.9 GB): first scan
~0.9–11 s depending on NFS attribute-cache warmth, 1.67 MB library JSON →
135 KB gzipped, and the HTTP server stays responsive (1–10 ms `/healthz`) because
the scan runs on a worker thread.

### Data directory ownership

The container runs as **uid/gid 10001**. A bind-mounted `./data` must be writable
by that user, otherwise the first write fails with `EACCES`:

```bash
sudo install -d -o 10001 -g 10001 -m 0755 ./data
# or avoid host UID juggling entirely:
docker volume create poly-vault-data   # then use  poly-vault-data:/data
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PV_TOKEN` | *(empty)* | Shared team access token. Empty + no proxy auth = wide open; the server warns when it is exposed. |
| `PV_USERS` | *(empty)* | Per-artist tokens, `alice:tok-a,bob:tok-b`. Each person then has an identity, so **Import to Unity is delivered only to their editor**. Without it, everyone is `shared` and every Unity editor sees every queued import. |
| `PV_ADMIN_TOKEN` | `$PV_TOKEN` | Required for `POST/DELETE /api/web/libraries` (add/remove libraries from the UI). |
| `PV_DOWNLOAD_MAX_BYTES` | `2147483648` | Per-archive cap for `/api/download` (and therefore the Unity import). |
| `PV_ZIP_CONCURRENCY` | `2` | Simultaneous zip streams. |
| `PV_TRUST_PROXY_AUTH` | `0` | `1` = trust `X-Auth-Request-User` / `X-Forwarded-User` from a reverse proxy (SSO). Group `polyvault-admin` grants admin. |
| `PV_PUBLIC_ORIGIN` | *(empty)* | Public URL of the deployment, e.g. `https://vault.example.com`. Needed for the same-origin check behind a proxy. |
| `PV_LIBRARIES` | `$PV_LIBRARY_ROOTS` | Colon-separated libraries registered on every boot. |
| `PV_LIBRARY_ROOTS` | `/assets` | Colon-separated allow-list for the add-library endpoint. |
| `PV_DATA_DIR` | `/data` | Metadata directory (tags, descriptions, library list, import jobs). |
| `PV_PORT` | `8080` | Listen port. |
| `PV_HOST` | `0.0.0.0` | Listen address. |
| `PV_BRIDGE_PORT` | `7100` | Internal loopback port of the upstream bridge (not exposed). |
| `PV_SCAN_MAX_AGE_MS` | `120000` | Max age of a cached scan. Changes are picked up immediately by `fs.watch`; this only covers shares without inotify (NFS/SMB). |
| `PV_RATE_LIMIT_PER_MIN` | `240` | Mutating requests per identity per minute (`0` disables). |
| `PV_THUMB_CACHE_MAX_FILES` | `20000` | Cap for the disposable WebP thumbnail cache in `/data/thumbs`. |
| `PV_PACKAGE_INDEX` | `1` | `0` disables the `.unitypackage` index (previews + contents). |
| `PV_PACKAGE_INDEX_MAX_MB` | `4096` (compose: `150`) | Upper size for the accurate-contents pass. Bigger packages still get a preview plus partial counts. |
| `PV_SHOW_TOKEN` | `1` | `0` hides the access token in the Settings panel (use with per-person tokens or SSO). |
| `PV_PUBLIC_ORIGIN` | *(empty)* | Public URL, e.g. `https://vault.example.com`. Needed behind a TLS proxy so the Settings panel hands artists the right URL (otherwise `X-Forwarded-Proto`/`-Host` are used). |
| `PV_PLUGIN_DIR` | `/app/plugin` | Where the bundled Unity `.tgz` is read from (empty = no download offered). |
| `PV_ENRICH_ROOTS` | *(empty)* | Only run Asset Store lookups for assets under these paths. |
| `PV_PACKAGE_INDEX` | `1` | Read `.unitypackage` archives for previews/contents. `0` disables (cards keep letter avatars, instant). |
| `PV_PACKAGE_INDEX_MAX_MB` | `4096` | Packages larger than this only get the fast preview pass (no full content listing). |
| `ASSETVAULT_NO_ENRICH` | `0` | `1` disables outbound Unity Asset Store lookups. |

## Endpoints

| Route | Auth | Notes |
| --- | --- | --- |
| `GET /healthz` | optional | Minimal `{ok,version,uptime}` unauthenticated (healthcheck); full diagnostics (libraries, scan, thumbs, enrichment) with a token. |
| `GET /metrics` | yes | Prometheus counters/gauges: requests, 304s, gzip, scans, thumbnails, zips, rate limiting. |
| `POST /login`, `GET /logout` | — | Cookie session (`HttpOnly`, `SameSite=Lax`). |
| `GET /api/web/session` | yes | `{ origin, user, admin, version }`. |
| `GET /api/web/state` | yes | Electron-IPC replacement: libraries + jobs. |
| `POST /api/web/libraries` | admin | `{ "path": "/assets/foo" }`, must be inside `PV_LIBRARY_ROOTS`. |
| `DELETE /api/web/libraries` | admin | `{ "id": "lib_…" }`. |
| `GET /api/file?path=…` | yes | Streams one importable file from a library (realpath-checked, extension allow-list). Used by the Unity add-on. |
| `GET /api/download?path=…` | yes | Streams a ZIP of an asset folder. Powers the "Download" button and needs no temp space. |
| `GET /api/thumb?path=…&w=320` | yes | Resized WebP from the thumbnail cache; falls back to the original preview if sharp cannot decode it. Also serves previews extracted from packages (`/data/packages/previews`). |
| `GET|PUT /api/library`, `/api/tags`, `/api/meta`, `/api/preview`, `/api/import-*`, `/api/unity/*`, `/api/update`, `/api/enrichment` | yes | Upstream bridge API, proxied same-origin. Identity headers (`X-PV-User`, `X-PV-Artist`) are injected by the front door and never trusted from the client. |
| `/__diag` | — | Disabled (404). It drives the Electron renderer and has no place in a shared service. |

## Performance

Measured in the container against a **1,009-asset / 3,000-file** library on a bind mount:

| | Upstream | This build |
| --- | --- | --- |
| `GET /api/library` body | 1.51 MB JSON, rescanned per request (~122 ms CPU) | 54.6 KB gzipped (632 real packages with store descriptions: ~4 MB → ~720 KB), scanned once, then `304` with a 0-byte body |
| 10 users polling every 20 s | ~30 full scans + ~52 MB/min | 1 scan total, ~9 KB/min of 304s |
| 10 concurrent requests | event loop blocked up to ~830 ms | 0.8–8 ms each, all 304 |
| Grid thumbnails | original previews (e.g. 999 KB PNG per card) | 934 B WebP at 320 px, 71 ms cold / 2 ms cached |
| Library change detection | full walk every poll | `fs.watch` debounce → one rescan; `PV_SCAN_MAX_AGE_MS` covers shares without inotify |
| Scan blocking | synchronous walk inside the request handler | runs on a worker thread: a 1 s NFS walk leaves `/healthz` at 1–10 ms |

## Packages as folders (import one file, or the whole package)

A `.unitypackage` is browsable in the sidebar exactly like a folder:

```
assets
└── 314 Arts
    └── Complete ProjectsSystems
        └── Modular Multiplayer FPS Engine   ← the package (import it whole)
            └── Assets
                └── Demos
                    ├── Textures/…  ← textures, importable individually
                    └── Models/…    ← meshes, audio, scripts, fonts
```

- The tree is fetched **on demand** when a package is expanded
  (`GET /api/package/tree`), so the 20-second library poll stays ~700 KB instead
  of carrying file lists for every package.
- Selecting a file inside a package opens its own panel with **Import this file
  to Unity**, and a secondary **Import the whole package instead**.
- Importing one file makes the server extract it from the archive
  (`GET /api/file?path=<package>&entry=Assets/…`), cache it under
  `/data/packages/extracted`, and hand it to the editor like any other asset.
  Models, textures, audio, fonts and scripts import cleanly on their own;
  prefabs/materials usually need the whole package for their dependencies.
- Packages indexed by older versions are re-read lazily: the first expand of such
  a package returns `202 indexing`, the UI waits and retries.

## What's inside a .unitypackage (previews + contents)

Unity's Asset Store cache contains no preview images, so 600+ packages would show
as letter avatars. A `.unitypackage` is a gzipped tar that already carries
Unity's own thumbnails and the real asset paths — the same structure the
[browser tool `package-extractor`](https://github.com/peraperavrc/package-extractor)
reads — so the server derives both, offline:

```
<guid>/pathname     -> Assets/… real project path      -> "What's inside" list + type counts
<guid>/asset        -> the asset bytes                 -> sizes, file count
<guid>/preview.png  -> Unity's thumbnail for the asset -> card/detail image (sharp -> WebP)
```

How it stays cheap on a 100 GB NFS library:

| Constraint | Handling |
| --- | --- |
| Packages from 10 KB to 12.6 GB | Pass 1 stops at the first usable preview (usually < 10 MB read); pass 2 (accurate contents) only for packages ≤ `PV_PACKAGE_INDEX_MAX_MB` |
| Must not block the UI | Parsing runs in a worker thread (`server/pkgWorker.js`), one package at a time |
| Must not re-read 100 GB on restart | Cached per `(path, mtime, size)` in `/data/packages` (17.8 MB for 632 packages), so a restart resumes |
| Must not blow up the poll payload | Cards carry the 12 largest entries; the full list stays on disk |
| Repeating failures | Three attempts, then back off that package |

Measured on the live export (632 packages, 108.9 GB): **578 cards got a real
thumbnail**, the remaining 54 archives simply contain none (editor-only tools);
the cache is **~20 MB** and the index then goes quiet — after a restart it does
**zero** work (`indexed 0, read 0.0 GB`). Contents are *not* in the library poll:
the detail panel fetches `/api/package?path=…` (2 KB, ~2 ms) when you open a card,
which keeps the poll payload at ~720 KB gzipped and idle polls at `304`.

Enablement: on by default. `PV_PACKAGE_INDEX=0` turns it off; `/healthz` shows
`packages: {indexed, previews, queued, failed, bytesRead, version}`, and new index
entries bump the API ETag (throttled to one bump per 20 s) so cards fill in while
you watch.

## In-app Settings panel

The toolbar's **Settings** button (web build) opens a panel with everything an
artist needs to connect Unity — no ticket to IT:

- **Connect Unity** — the plugin download (`.zip` for *Add package from disk*,
  which is the reliable route; `.tgz` in npm layout for *Add package from
  tarball*, which Unity 6 refuses unless package signature verification is
  relaxed), plus the steps and a note about Windows' "Unblock" for downloads.
- **Connection** — Server URL (the address this page was opened with), the access
  token behind a *Show* toggle with copy buttons.
- **This server** — libraries, thumbnail cache, package index totals.

The panel is part of `server/web-shim.js`, so the upstream renderer stays
untouched. `PV_SHOW_TOKEN=0` hides the token (the panel then points people at
their administrator) — useful once you have per-person tokens or SSO.

The plugin is served at `GET /plugin/unity-package.tgz` and `/plugin/unity-package.zip`
(authenticated, logged in `audit.jsonl` as `plugin_download`), built in the
Dockerfile from the same patched source as the server, so what an artist installs
always matches the API. The `.tgz` uses the npm layout UPM expects
(`package/package.json`); the `.zip` keeps the package at the archive root for
*Add package from disk*.

## Unity import over HTTP (Phase 3)

No shared filesystem needed: the Editor add-on now **downloads** the queued files.

1. Build the package once, from the same patched source the server runs:
   ```bash
   ./scripts/build-plugin.sh          # -> dist/PolyVault-Unity-0.5.0.tgz
   ```
2. In Unity: **Window → Package Manager → + → Add package from tarball**.
3. **Window → Poly Vault → Poly Vault**: set *Server URL* (e.g. `https://vault.example.com`)
   and your *Access token*. With `PV_USERS` configured the window shows
   "Signed in as alice" and only jobs addressed to you appear.
4. In the web UI click **Import to Unity** — the editor downloads to
   `Library/PolyVaultCache/<job>/`, copies into `Assets/PolyVaultImports/…`,
   writes `polyvault.tags.json`, then deletes the cache.

How it behaves:

| Situation | Result |
| --- | --- |
| `.unitypackage` | Downloaded, then opened in Unity's own import dialog (cache is kept until you finish). |
| Server file already on disk (desktop app / shared mount) | Used in place, no download. |
| Job queued by someone else | Never handed to your editor when `PV_USERS` is set; jobs get `claimedBy` when an editor takes them. |
| Network drop mid-download | Job reports `failed` with the reason; re-queue from the web UI (nothing half-written in `Assets/`). |

Acceptance test (needs the container running):

```bash
./scripts/verify-phase3.sh http://127.0.0.1:8080 tok-alice tok-bob /srv/assets
# -> passed 25, failed 0
```

## Operations

```bash
docker compose logs -f poly-vault            # structured-ish stdout logs
curl -s localhost:8080/healthz -H "Authorization: Bearer $PV_TOKEN" | jq
docker compose exec poly-vault ls -l /data   # tags/descriptions live here
tar czf poly-vault-data-$(date +%F).tgz -C ./data .   # backup (stop the container first)
```

- **Backups**: `/data` only. Asset folders are read-only and never modified by the app.
- **Upgrades**: bump `PV_VERSION` in `docker-compose.yml`, `docker compose up -d --build`. Patch failures mean upstream moved; refresh `patches/`.
- **Scaling**: one replica only. State is JSON files in `/data`; there is no shared DB or cache.
- **Firewall**: publish `127.0.0.1:8080` only and put a TLS proxy in front (see `deploy/Caddyfile.example`).

## Upstream patches

This repository is a fork of
[`xeeshanqaswar/Poly-Vault`](https://github.com/xeeshanqaswar/Poly-Vault) at tag
**v0.4.2** (MIT). The patches in `patches/` are already applied to the working
tree; they are kept separate so each change can be reviewed in isolation and
re-applied when upstream moves (`patches/README.md` has the rebase recipe).

| Patch | Change |
| --- | --- |
| `0001-web-enablers` | load the web shim before the renderer; use an explicit origin (HTTPS proxies); injectable scanner + optional (not wildcard) CORS; **symlink-safe preview containment** and **importable-path validation** (security fixes, see the audit) |
| `0002-team-import` | job attribution (`requestedBy`/`targetUser`/`claimedBy`), per-artist job visibility, HTTP download in the Unity add-on |
| `0003-thumbnails` | renderer asks the host for a resized thumbnail (`assetVault.thumbUrl`) instead of the original preview |
| `0004-package-assets` | Unity Asset Store cache support: one asset per `.unitypackage`; NFS birth-time of 0 is reported as unknown instead of 1970 |
| `0005-async-scan` | the bridge awaits the scanner, so the web build can run scans off the main thread |
| `0006-package-contents` | detail panel shows "What's inside" for packages (fetched from `/api/package`) |
| `0007-unity-window-init` | Unity window reads `EditorPrefs` in `OnEnable` instead of field initializers (Unity 6 throws otherwise) |
| `0007-unity-window-init` | Unity window reads `EditorPrefs` in `OnEnable` instead of field initializers (Unity 6 throws otherwise) |

The original project README is preserved at
[`docs/upstream-README.md`](docs/upstream-README.md), and
[`AUDIT-AND-PLAN.md`](AUDIT-AND-PLAN.md) records the audit that motivated all of
this.

## Verification performed

- Upstream `tests/smoke.js` passes against the patched tree (scanner, bridge, enrichment).
- End-to-end in a real browser (headless Chromium): sign-in, 600 cards, 1046 tree rows,
  thumbnails decoded, detail panel, tag write persisted to `/data`, theme switch,
  search filter, no page errors.
- Scan cache: 10 staggered clients over one TTL → 2 scans, 9 cache hits.
- Security checks: unauthenticated API → 401, cross-origin write → 403, no CORS
  preflight, symlink escape → 403, `../` traversal → 400, arbitrary importable path
  → 403, `/__diag` → 404.
- Phase 3: `scripts/verify-phase3.sh` → **25/25** (identity, single-file download with
  byte-size equality, zip validity, 400/401/403 guards, per-artist job visibility,
  claim/complete, cookie-session attribution).
- Phase 2: `scripts/verify-phase2.sh` → **18/18** (gzip ratio, ETag/304 with empty
  body, WebP thumbnails + cache hit header, audit entries, metrics counters,
  idle polls not rescanning, fs.watch invalidation).
- Browser: `scripts/verify-ui.sh` → **12/12** (sign-in, grid, thumbnails decoded,
  tag write, zip download, import queueing, gzip transfer, revalidated poll
  transfers 300 B while the cached body is 21 KB, no console errors).
