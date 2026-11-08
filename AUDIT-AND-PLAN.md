# Poly Vault — audit & containerisation plan

Audit performed against upstream `xeeshanqaswar/Poly-Vault` at tag **v0.4.2**
(`d3b4f84`, 2026-11-06), MIT licensed, cloned and read in full (6.9k LOC across
`src/`, `ui/`, `unity-plugin/`, `tests/`, `docs/`).

Every finding below was **reproduced**, not inferred. The reference container in
this folder is the working proof for the "can this be done" question; the plan
answers "should we, and in what order".

**Decisions taken (owner):**

| Question | Decision |
| --- | --- |
| Unity import over HTTP | **Funded — implemented** (phase 3 shipped, see §9) |
| Authentication | Shared token; per-artist tokens (`PV_USERS`) optional but recommended for targeting |
| Asset storage | Network share **or** local `/srv/assets` (both are just a read-only mount) |
| Asset Store enrichment | Acceptable — left enabled by default |

---

## 1. What the project actually is

| | |
| --- | --- |
| Shape | Electron desktop app (Windows/Linux/macOS installers) + Unity 6 Editor package |
| Runtime dependencies | **Zero.** `dependencies` is empty; Electron/electron-builder are dev-only. All logic uses Node built-ins. |
| Core | `src/main/library.js` (scanner), `store.js` (JSON KV), `bridgeServer.js` (HTTP API + import-job queue), `enrichment.js` + `autoTags.js` + `unityAssetStore.js` (Asset Store scraping → descriptions/tags) |
| UI | `ui/index.html` + `renderer.js` (1.6k LOC) + `style.css`, three themes, no framework, no build step |
| Storage | Four JSON files in the userData dir: settings, tags, meta, jobs |
| Coupling to Electron | 5 IPC calls in `src/preload.js` and the main-process window/dialog code in `src/main/index.js` |

**The important structural fact:** the renderer already talks to a local HTTP
API (`/api/library`, `/api/tags`, `/api/meta`, `/api/preview`, `/api/import-job`,
`/api/update`, `/api/enrichment`) and only four things go through Electron IPC:
`getServerInfo`, `getState`, `addLibrary`/`removeLibrary`, `openInExplorer`.

That is why containerising it is a **thin-shell job, not a rewrite**: replace the
Electron shell (≈150 lines), keep 100% of the domain logic.

---

## 2. Containerisation blockers (ranked)

### B1 — "Import to Unity" cannot work with a remote library ✅ *resolved in phase 3*

The Unity add-on imports by reading **absolute filesystem paths on the artist's
machine**:

- `unity-plugin/PolyVault/Editor/AssetVaultImporter.cs:219` — `if (File.Exists(item.path))`
- `…:257` — `File.Copy(item.path, dest, overwrite: false)`

The job payload contains **server-side** paths (`/assets/…`). On an artist's
Windows box those do not exist, so every import fails with "Missing file".

Options:

| Option | Effort | Notes |
| --- | --- | --- |
| **A. Web is browse/search/tag only; Unity import stays in the desktop app** | 0 | Two apps, one data dir each. Clean split, no shared state. Recommended for phase 1. |
| **B. Add `GET /api/file?path=…` and patch the plugin to fetch** | delivered | Plugin downloads to `Library/PolyVaultCache/`, copies into `Assets/PolyVaultImports/`, deletes the cache. Works over VPN, no CIFS. **Implemented — see §9.** |
| **C. Mount the same SMB/NFS share at the identical absolute path** | 0 dev, high ops | Fragile: Windows path vs container path, permissions, offline artists. Avoid. |

The browser now keeps the **Import to Unity** button and the Unity status dot:
they are meaningful again because the editor can reach the server.
Jobs are targeted per artist (see §9) so a click lands in the right editor.

### B2 — No authentication, and the API is writable by anyone who can reach it ⛔

Upstream binds `127.0.0.1` and documents "loopback only" as its security model
(`docs/TECHNICAL.md` §Security model). That model disappears the moment the
service is on a LAN: there is no auth, no CSRF protection, and CORS is `*`.

Reproduced against an unmodified instance:

```
curl -X PUT /api/tags -d '{"path":"…","tags":["pwned"]}'   → 200 {"ok":true,…}
curl -X OPTIONS /api/tags -H 'Origin: https://evil.example' → 204
     access-control-allow-origin: *
```

Any web page an artist visits can rewrite your tags/descriptions, and any host on
the network can read the whole library index. **Must be fixed before exposure** —
the reference build does it in the front door (token/proxy identity, same-origin
check, CORS stripped, `__diag` removed).

### B3 — Arbitrary file copy into a Unity project (amplified by B2)

`POST /api/import-job` validates `assetFolder` but **not** `importables[].path`:

```
POST /api/import-job {"assetFolder":"<valid>","importables":[{"path":"/etc/passwd"}]}
→ 201 created
```

The Unity plugin then trusts that path and copies the file into
`Assets/PolyVaultImports/`. With B2 in place this is a remote "grab a file from
the artist's machine into their project" primitive. Fixed in
`patches/0001-web-enablers.patch` (each importable must resolve inside the asset
folder **and** inside a registered library).

### B4 — Symlink escape in the preview endpoint

`withinLibrary()` compares the *requested* path, never the real path, while
`fs.statSync`/`createReadStream` follow symlinks:

```
ln -s /etc/hostname "<library>/escape.png"
GET /api/preview?path=<library>/escape.png   → 200, body = /etc/hostname
```

Only image extensions are served, so it is not a general file-read, but any
secret that can be symlinked/named `*.png` is readable, and asset packs shipped
with symlinks (common on macOS/NAS) can wander outside the library. Fixed in the
patch (`realpathSync` + containment check).

### B5 — Electron-only functionality with no browser equivalent

| Upstream | Container |
| --- | --- |
| "Add Library" native folder dialog | Admin endpoint `POST /api/web/libraries` restricted to `PV_LIBRARY_ROOTS`, plus mount-based provisioning |
| "Open folder" in Explorer | Hidden in the browser; replaced by a download endpoint in phase 2 |
| Single-instance lock, menu bar, `setWindowOpenHandler` | Not applicable |
| `userData` migration `Asset Vault → Poly Vault` | Not applicable (fresh volume) |
| `/__diag` (drives the renderer via `executeJavaScript`) | Removed with the Electron shell; 404 by default |

---

## 3. Scalability findings (the reason a naive `docker run` disappoints)

Measured on a synthetic library of **1,000 assets / 3,000 files / 27 MB** in the
container (same host, loopback):

| Symptom | Measurement |
| --- | --- |
| `GET /api/library` rescans **every** library synchronously, per request | 100–150 ms CPU per call, 1.75 MB JSON response |
| Renderer polls `/api/library` every 20 s (`ui/renderer.js:234`) | 10 users ⇒ 30 full scans/min and **~50 MB/min** of JSON |
| Scan is blocking (`statSync` per file) | 10 simultaneous requests pushed `/healthz` latency to **830 ms** — the whole event loop stalls |
| No server-side thumbnails | Cards request the original `preview.png`/`.webp`; a 4 MB 4K preview is 4 MB per card |
| `/api/tags` + `/api/meta` return the entire map every 20 s | grows with library size, no delta |
| JSON stores, whole-file rewrite | single process only; no horizontal scaling; no per-user attribution |

**Fixed in the reference build:** one shared scan per `PV_SCAN_TTL_MS` window
(default 10 s), plus health/scan stats. Result for 10 staggered clients:
**2 scans + 9 cache hits, 26–165 ms/request**, `/healthz` stays responsive.

**Planned:** ETag/`304` on `/api/library`, gzip (1.75 MB → ~200 KB), thumbnail
cache, incremental scans via `fs.watch` + SQLite index (phase 2–3).

---

## 4. Other observations

| # | Finding | Impact | Action |
| --- | --- | --- | --- |
| O1 | Asset Store enrichment **scrapes HTML** (`assetstore.unity.com/sitemap`, `/packages/…`) with a desktop UA | Brittle by nature; ToS-sensitive; sends asset *names* off-network (folder names of a studio library) | Keep `ASSETVAULT_NO_ENRICH=1` unless wanted; needs egress; phase 2 = cache + opt-in per library |
| O2 | Enrichment runs on the main process, 3 workers, 150 ms gap | Fine | — |
| O3 | Jobs have no `requestedBy`; any user sees/cancels all jobs | Team confusion | Phase 2 |
| O4 | `JsonStore.save()` writes `tmp` + `rename` (atomic on POSIX) but no locking/merging | Multi-replica impossible; single-replica concurrent writes are serialised by the event loop, so acceptable | Document "1 replica"; long term SQLite WAL |
| O5 | `withinLibrary` uses `path.resolve` prefix matching | Correct after `realpath` fix (B4); Windows path cases not relevant in Linux container | Done |
| O6 | No rate limiting; `readBody` caps at 2 MB | LAN DoS is trivial (loop scans) | Cache (done) + proxy rate limit (phase 1) |
| O7 | No TLS, no audit log | Team compliance | TLS at proxy (phase 1), audit log (phase 2) |
| O8 | Electron 44 / unsigned builds / SmartScreen | Desktop-only concern | Irrelevant server-side |
| O9 | Upstream is a young solo project (created 2026-09, 2 stars, 4 tags, single active author) | Patch drift, no security process | **Fork + pin tag + own the patches**; track upstream quarterly |
| O10 | MIT license, `private: true` | Redistribution/modification allowed; keep copyright + LICENSE | Keep `LICENSE` in the derived repo |
| O11 | Upstream smoke suite (`tests/smoke.js`) is headless and passes on the patched tree | Cheap CI signal | Run in CI; add a browser test (phase 1) |
| O12 | Data dir is portable JSON — a desktop app and the container could share it | Tempting but unsafe (two writers) | One writer only |
| O13 | **Unity's Asset Store cache layout does not match Poly Vault's convention.** The real export (`nas.example.internal:…/Asset Store-5.x`) is `<Publisher>/<Category>/<Package>.unitypackage` — 632 packages, zero preview images. Upstream would collapse each category folder into one card (≈559 misnamed cards) | The library is unusable as intended | **Fixed**: patch `0004` emits one asset per package (real names, own tags/descriptions, one importable). Verified against the live export. |
| O14 | First scan over NFS took **11 s** (cold attribute cache, 637 files, ~1,600 stats) and blocked the event loop | Every request/click froze during a scan | **Fixed**: scans run on a worker thread (patch `0005` + `server/scanWorker.js`); `/healthz` stays at 1–10 ms during a forced rescan |

---

## 5. Recommended architecture

```
        artists (browser)                     artists (Unity)
              │                                     │
        TLS + SSO (Caddy / nginx / oauth2-proxy)     │  phase 3: HTTPS download
              │                                     ▼
   ┌──────────▼─────────────────────────────────────────────┐
   │ poly-vault container (node, uid 10001, read-only rootfs)│
   │  front door: auth · same-origin policy · static UI      │
   │  scan cache (1 scan / TTL / all clients)                │
   │  ── loopback ──► upstream bridge API (unchanged)        │
   │  upstream scanner + JSON stores (/data volume)          │
   └───────────┬────────────────────────────────────────────┘
               │ read-only
        /assets (SMB/NFS/bind mount, one folder per library)
```

Rejected alternatives:

- **Electron in a container + noVNC/KasmVNC** — one X session per user, no real
  auth story, 1+ GB images, can't scale past a handful of people. Only worth it
  if Unity import must stay byte-identical, and even then option B is cheaper.
- **Full rewrite (Fastify/React/Postgres)** — 2–4 weeks, throws away a working
  renderer and the matching Unity plugin. Only justified if this becomes a
  product rather than an internal tool.
- **Desktop app on a shared VM** — same problems as noVNC without the HTML5 part.

---

## 6. Phased plan

Estimates assume one developer familiar with Node; "day" = focused day.

### Phase 0 — Spike (done, ~0.5 day) ✅
Reference container in this folder: pinned build, 4 patches, auth, scan cache,
hardened compose, browser E2E proof, upstream smoke tests green.

**Exit criteria met:** UI fully usable in a browser against a 1,000-asset library;
tag write persisted; no Electron in the image; ~2 min cold build (image is now
272 MB with the `sharp` thumbnail stage).

### Phase 1 — Production-safe internal rollout (~2–3 days)
1. Fork upstream into your org, tag `v0.4.2+web.1`, keep `patches/` as the only diff.
2. Wire auth for real: pick **proxy SSO** (`PV_TRUST_PROXY_AUTH=1` + `deploy/Caddyfile.example`)
   or a shared `PV_TOKEN`; document rotation.
3. TLS proxy in front, `PV_PUBLIC_ORIGIN` set, port 8080 bound to loopback only.
4. CI: build image, run `tests/smoke.js`, run a Playwright smoke (login → grid →
   tag write), publish to your registry with a pinned tag + digest.
5. Ops: named volume (or `chown 10001`), healthcheck, log rotation, backup script +
   restore drill, upgrade/rollback runbook (`docker compose` two-step).
6. Add rate limiting at the proxy for `/api/*` (e.g. 30 r/s/IP) — cheap insurance.
7. Communicate the split: web = find/tag/describe; Unity import = desktop app (B1 option A).

**Exit criteria:** 3–5 pilot artists use it daily for a week; p95 page load < 2 s
on a 10k-asset library; zero 5xx in logs; restore-from-backup rehearsed.

### Phase 2 — Team ergonomics ✅ *delivered (see §8)*
1. ~~`GET /api/library` ETag/`304` + gzip~~ **done**: 1.51 MB → 54.6 KB, then 304s.
2. ~~Thumbnail cache~~ **done**: `sharp` WebP cache keyed by file+mtime+width (999 KB → 934 B).
3. ~~`GET /api/download?path=…` → stream a zip of an asset folder~~ **done in
   phase 3** (also the building block for the Unity HTTP import).
4. ~~`requestedBy` on jobs, per-user attribution, audit log~~ **done** (`/data/audit.jsonl`, rotated at 5 MB).
5. Library management UI for admins — admin API exists (`POST/DELETE /api/web/libraries`); a dedicated panel is still a nice-to-have.
7. ~~Rate limiting~~ **done in-process** (`PV_RATE_LIMIT_PER_MIN`, per identity) in addition to the proxy option.
6. ~~Enrichment policy~~ **done**: `PV_ENRICH_ROOTS` scopes lookups per path; `ASSETVAULT_NO_ENRICH=1` still kills them.

**Exit criteria:** 10k-asset library, 10 concurrent users, < 1 s median interaction;
download works for every asset type.

**Measured after delivery** (1,009 assets, 10 concurrent conditional polls):
1.51 MB → 54.6 KB gzipped, then 304 with a 0-byte body (0.8–8 ms); one scan total
instead of 30/min; thumbnails 999 KB → 934 B.

### Phase 3 — Unity import over HTTP ✅ *delivered (see §7)*
Delivered as: per-file download (`/api/file`) into `Library/PolyVaultCache/`,
copy into `Assets/PolyVaultImports/` (never modifying the library), artist-bound
job targeting + `claimedBy`, import button re-enabled, plugin 0.5.0 packaged by
`scripts/build-plugin.sh`. Remaining work is rollout only (compile/test in Unity,
distribute the tarball).

### Phase 4 — Partly delivered

Shipped now:

- **Incremental scans** — per-library cache invalidated by `fs.watch` (debounced)
  and by a content signature; an untouched library answers from memory and the
  API keeps returning `304`. `PV_SCAN_MAX_AGE_MS` is the fallback for NFS/SMB,
  where inotify is silent.
- **Off-thread scanning** — the blocking upstream scanner runs in a worker thread
  (`server/scanWorker.js`, single-flighted per library, falls back in-process if
  the worker dies). Verified against the NFS export: a forced full rescan took
  0.7–0.8 s while `/healthz` answered in 1–10 ms.
- **Metrics** — `/metrics` exposes requests, 304s, gzip, scans/hits/watch events,
  worker vs inline scans, thumbnails, zip downloads, rate limiting, enrichment backlog.
- **Audit trail + rate limiting** — `audit.jsonl` and per-identity limits, so
  abuse and accidental loops are both visible and bounded.

Deliberately deferred:

- **SQLite/WAL instead of the JSON stores.** `node:sqlite` is available in the
  runtime image, but the deployment is single-writer by design (one replica, one
  process) and the JSON files are what makes the "rollback to the desktop app"
  story work. Revisit only if you need multiple replicas or >100k assets.
- Read replicas, request tracing, thumbnails for non-bitmap previews.

Revisit the patch rebase upstream quarterly.

---

## 7. Phase 3 — delivered (Unity import over HTTP)

Implemented, built into the image and covered by a 25-check acceptance script
(`scripts/verify-phase3.sh`).

**Server**

| Piece | Behaviour |
| --- | --- |
| `GET /api/file?path=…` | Streams one importable file. `realpath` containment + extension allow-list (`IMPORTABLE_EXTENSIONS`), `Content-Disposition: attachment`. |
| `GET /api/download?path=…` | Streams a ZIP of an asset folder. Zero-dependency ZIP writer (`server/zipStream.js`): no temp files, no RAM buffering, works on a read-only rootfs; 4 GiB/60k-entry/`PV_DOWNLOAD_MAX_BYTES` guards, 429 when `PV_ZIP_CONCURRENCY` is exceeded. |
| Identity | `PV_USERS="alice:tok-a,bob:tok-b"` gives each token a person. Order: artist token → shared token (`shared`) → admin token. `targeted` flag exposed on `/api/web/session`. |
| Job targeting | `createJob` records `requestedBy`/`targetUser`; `/api/unity/import-jobs` only returns jobs for `X-PV-Artist` (or untargeted ones); `processing` sets `claimedBy` so two editors can't race the same job. `/api/import-jobs` (web badges) is filtered to the caller. Identity headers are **injected by the front door** and stripped from client input. |

**Plugin (`unity-plugin`, now 0.5.0)**

| Change | Why |
| --- | --- |
| `Token` setting + `Authorization: Bearer` on every request | The server has auth; 401s now say "check the access token". |
| `AssetVaultWeb.DownloadFile` (`UnityWebRequest` + `DownloadHandlerFile`) | Streams to disk, no memory blow-up on large packs. |
| `AssetVaultImporter` two-phase import | Resolve local → download missing sequentially → copy/import on the main thread. Local files (desktop app, shared mount) are still used in place. |
| Cache lifecycle | `Library/PolyVaultCache/<job>/` deleted after a successful copy; kept while Unity's `.unitypackage` dialog is still open, then removed on its completion callback. |
| Window | Server URL + token fields, "Signed in as ⟨artist⟩", updated help text. |

**Verified** (`scripts/verify-phase3.sh`, all green): identity for two artists,
single-file download with byte-size equality against the source, attachment
header, 401/403/400 guards (unauthenticated, outside library, folder-as-file,
file-as-folder), ZIP validity via `zipfile.testzip()`, job attribution, per-artist
visibility in both the plugin endpoint and the web badge list, claim/complete
transition, and the shared-token fallback (one shared identity → every editor
sees every job, upstream behaviour preserved).

**Not verified here:** the C# changes cannot be compiled without a Unity install.
The code is deliberately conservative (same async pump, same DTO/JsonUtility
idioms) but it needs one compile + a playtest on Unity 6 before rollout; that is
the first task of phase-3 rollout below.

**Rollout checklist**

1. `./scripts/build-plugin.sh` → `dist/PolyVault-Unity-0.5.0.tgz`.
2. One artist: install package, set Server URL + token, click Import on a mesh,
   confirm files land in `Assets/PolyVaultImports/…` and the job turns `done`.
3. Repeat with a `.unitypackage` asset (dialog opens, cache cleaned on completion).
4. Two artists with `PV_USERS`: each sees only their own queued job.
5. Then distribute the tarball through the team's package channel.

---

## 8. Phase 2 — delivered

**Payload size and revalidation**

- JSON responses are gzipped (1.51 MB → 54.6 KB on the 1,009-asset fixture).
- `GET /api/library|tags|meta` carry `ETag: W/"pv-<dataVersion>-<scanGeneration>"`
  and `Cache-Control: private, no-cache`, so browsers revalidate instead of
  refetching. The ETag is computed **after** the scan, from change counters —
  no body hashing — and only advances when the scan's content signature changes.
- The 304 is answered at the front door without touching the bridge.

**Thumbnails**

- `GET /api/thumb?path=…&w=320` → WebP from a disk cache keyed by
  `sha1(realpath + mtime + width)`; widths are clamped to 160/320/480/960/1440.
- Cold 999 KB PNG → 934 B in 71 ms; warm hit 2 ms; unreadable images fall back to
  `/api/preview` (302) so a bad preview never breaks the grid.
- `sharp` is installed in its own Docker stage (+26 MB, image 272 MB); if it is
  missing or cannot decode an image, the UI silently falls back to original previews.

**Scanning**

- Per-library cache, invalidated by: tag/description writes (`dataVersion`),
  `fs.watch` events under the library root (debounced 750 ms, per-library
  attribution), or `PV_SCAN_MAX_AGE_MS` (120 s) as the NFS/SMB fallback.
- A content signature (`sha1` of the scan result without `scannedAt`) decides
  whether the API ETag changes at all, so an idle library answers 304 forever.
- Manual **Update** forces a real walk (`invalidateAll()`), as users expect.

**Operations**

- `GET /metrics` (auth required): HTTP/304/gzip counters, scan + watch stats,
  thumbnail stats, zip downloads, rate limiting, enrichment backlog.
- `/data/audit.jsonl`: logins, library changes, every mutating API call, asset
  downloads, rate limiting; rotated at 5 MB.
- Per-identity rate limiting (`PV_RATE_LIMIT_PER_MIN`, default 240/min), on top of
  the proxy-level option.
- `/healthz` split: minimal public JSON for the container healthcheck, full
  diagnostics behind the token. `/metrics` and API routes answer `401` (not the
  login page) to unauthenticated machine clients.

**Verified**

| Suite | Result |
| --- | --- |
| `scripts/verify-phase2.sh` | 18/18 — gzip ratio, 304 with empty body, WebP + cache-hit header, audit, metrics auth, idle polls not rescanning, fs.watch invalidation |
| `scripts/verify-phase3.sh` | 25/25 — unchanged from §7 |
| `scripts/verify-ui.sh` | 12/12 — real browser: revalidated poll transfers 300 B while the cached body is 21 KB |
| Upstream `tests/smoke.js` | passes against the patched tree |
| Backup/restore drill | archive → scratch volume → tags/jobs/thumbs intact |
| CI | `.github/workflows/ci.yml` runs all of the above plus a security smoke and publishes the Unity package |

---

## 9. NAS / NFS integration — delivered

`docker-compose.yml` now ships the NFS volume (Synology export
`:/export/unity-assets` on `nas.example.internal`) mounted read-only at `/assets`
with `nolock,soft,ro,actimeo=60`.

Facts gathered from the live export rather than assumed:

| Observation | Value | Consequence |
| --- | --- | --- |
| Layout | `<Publisher>/<Category>/<Package>.unitypackage` | needed patch `0004` (see O13) |
| Packages / publishers / categories | 632 / 437 / 559 | one card per package instead of 559 category cards |
| Total size | 108.9 GB | `sizeBytes` comes from stat'ing every file — part of the scan cost |
| Preview images | 0 | cards show initials until someone drops a `preview.png`; store lookups still supply descriptions/tags |
| File modes | 0777 dirs/files | uid 10001 can read the export as-is |
| Cold scan | 11 s | worker thread + `PV_SCAN_MAX_AGE_MS` (5 min) + `actimeo=60` |
| Warm scan | 0.7–0.9 s | `Update` is cheap; periodic rescans are invisible |
| Library payload | 1.67 MB → 135 KB gzip | revalidated with 304s between changes |
| Enrichment | scoped with `PV_ENRICH_ROOTS` while validating; sample package got a real store description + 9 tags | enable globally once the team is happy with the lookups |

Operational notes: `soft` means a NAS outage surfaces as read errors instead of a
hung container; the container will fail to *start* while the export is
unreachable and `restart: unless-stopped` retries until it returns. inotify does
not report changes made by other machines over NFS, so freshness comes from
`PV_SCAN_MAX_AGE_MS` (or the **Update** button).

---

## 10. Package index — inspired by `package-extractor`

The upstream product indexes *folders*. Unity's Asset Store cache is
`<Publisher>/<Category>/<Package>.unitypackage` with no previews, so after the
NFS integration every card was a letter avatar. The browser tool
[`peraperavrc/package-extractor`](https://github.com/peraperavrc/package-extractor)
shows the way out: a `.unitypackage` is a gzipped tar with
`<guid>/pathname`, `<guid>/asset` and `<guid>/preview.png`, i.e. the previews and
the real asset paths are already inside the file.

Borrowed from it: the tar layout and the guid→pathname mapping. Changed for a
server context:

| Reference tool | This build |
| --- | --- |
| `gunzipSync` + in-memory tar parse (fine for a dropped file in a browser) | streaming gunzip + incremental tar state machine, bounded buffers |
| Parses the whole archive | two budgeted passes: stop at the first usable preview; full walk only for packages ≤ `PV_PACKAGE_INDEX_MAX_MB` |
| Runs on the UI thread | runs in a worker thread, one package at a time |
| Nothing cached | per-`(path, mtime, size)` cache under `/data/packages`, resumable |
| Shows a file tree for download | feeds card thumbnails, "Detected types" counts and a "What's inside" list |

Measured on the live export (632 packages, 108.9 GB): the index produced **578
previews** (54 archives genuinely contain none), a **~20 MB** cache, and
per-package contents, e.g. `01Monster Catfish: 28 files — animation, material,
mesh, scene`. `/healthz` stayed in single-digit milliseconds throughout, and the
index converges: after it finishes, a restart does **zero** work (`indexed 0`,
`read 0.0 GB`).

Two bugs the real data caught:

1. **±1 ms mtime mismatch** — the scanner reports `mtime` as an ISO string
   (rounded) while `stat.mtimeMs` is truncated, so the cache looked stale on
   every poll and re-read packages endlessly. Fixed with a small tolerance.
2. **Packages without a preview were re-queued forever.** Now a pass that finds
   nothing records `previewTried`, and a pass that runs out of budget keeps the
   preview it already had instead of deleting it.

Contents are delivered on demand (`GET /api/package`) rather than in the library
poll: shipping the file lists for 632 packages took the payload from 135 KB to
992 KB gzipped. With the endpoint the poll is ~720 KB gzipped (mostly Asset Store
descriptions) and the detail panel pulls 2 KB in ~2 ms when a card is opened.

Limits worth knowing: packages above the size cap report partial counts (flagged
in the UI with "first 12 of N+"), Unity writes no preview for some editor-only
tools, and a package whose preview sits late in a huge archive gets that preview
only after the byte budget allows it.

---

## 11. Open questions

Answered: Unity import (**phase 3 funded/delivered**), auth (**shared token**;
`PV_USERS` available when per-artist targeting is wanted), storage (**network
share or local `/srv/assets` — both are just a read-only mount**), enrichment
(**allowed**).

Still open:

1. **Scale** — how many concurrent users and how many assets (10k? 100k?)? Drives
   when phase 2 (ETag/gzip/thumbnails) and phase 4 (SQLite/incremental scan) start.
2. **NAS latency** — if libraries sit on a slow SMB share, the first scan of the
   day is the bottleneck; worth measuring the real share before tuning
   `PV_SCAN_TTL_MS`.
3. **Ownership** — who owns the fork, the CI pipeline, and the backup/restore drill?
4. **Per-artist tokens** — do you want them for import targeting, or is one shared
   token (every editor sees every job) enough for the team size?

---

## 12. Rollback

The container is additive: it never writes to the asset share, and `/data` is a
self-contained folder of JSON files that the desktop app can also read. Rollback =
stop the container, hand artists the existing desktop installer, keep `/data`
(points 2–3 in phase 1 confirm it stays compatible).
