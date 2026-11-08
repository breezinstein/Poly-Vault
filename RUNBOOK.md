# Runbook — Poly Vault web build

Operational procedures for the team deployment. Everything here assumes the
`poly-vault` container from `docker-compose.yml` and a data volume named
`poly-vault-data`. Substitute your own names if they differ.

---

## 1. Daily checks

```bash
docker compose ps                        # Up (healthy)?
curl -s localhost:8080/healthz | jq     # public: ok/version/uptime
curl -s -H "Authorization: Bearer $PV_TOKEN" localhost:8080/healthz | jq
curl -s -H "Authorization: Bearer $PV_TOKEN" localhost:8080/metrics | grep -E 'pv_(scan|thumbs|zip|api_304|rate)'
docker compose logs --tail 50 poly-vault
```

What the numbers should look like:

| Metric | Healthy | What it means if not |
| --- | --- | --- |
| `pv_scan_total` | grows slowly (watch events / manual Update) | grows on every poll → watch is dead on the share (see §6) |
| `pv_scan_cache_hits_total` | grows with users | flat → clients are forcing rescans |
| `pv_api_304_total` | grows steadily | flat → clients are refetching the full library |
| `pv_thumbs_failed_total` | 0 | some previews are unreadable; they fall back to the original |
| `pv_rate_limited_total` | 0 | someone is hammering the API, or the limit is too low |
| `pv_watch_errors_total` | 0 | inotify unavailable (network share, `ENOSPC`) — TTL polling covers it |
| `pv_scan_worker_total` | grows with rescans | if `pv_scan_inline_total` grows instead, the worker died and scans block again |
| `pv_scan_last_ms` | 700–1100 ms on the NAS (warm) | 10 s+ means the NFS attribute cache is cold (`actimeo`) |

`/data/audit.jsonl` is the who-did-what trail (tags, descriptions, library
changes, downloads, logins, rate limiting). Rotated at 5 MB, one generation kept.

---

## 2. Back up / restore

```bash
./scripts/backup.sh ./backups                  # -> backups/poly-vault-data-<ts>.tgz
./scripts/restore.sh ./backups/poly-vault-data-<ts>.tgz
```

Rules:

- Back up `/data`; never back up the asset share from here (read-only, already yours).
- Rehearse a restore **quarterly** into a scratch volume before you need it.
- A restore is also the rollback path if a bad upgrade corrupts metadata.

---

## 3. Upgrade

```bash
# 1. back up first
./scripts/backup.sh ./backups

# 2. bump the pinned upstream version
$EDITOR docker-compose.yml        # args: PV_VERSION: "0.4.3"

# 3. rebuild (patches may need a refresh, see below)
docker compose up -d --build

# 4. verify
docker compose ps
./scripts/verify-phase2.sh http://127.0.0.1:8080 tok-alice /srv/assets poly-vault
./scripts/verify-phase3.sh http://127.0.0.1:8080 tok-alice tok-bob /srv/assets
```

If the build fails while applying `patches/`, upstream moved:

```bash
docker build --target source -t pv-src . 2>&1 | tail -30   # shows the rejected hunk
# re-create the patch against the new tag, then rebuild
```

Patches are the entire delta from upstream; keep them minimal and documented.

## 4. Rollback

```bash
# image rollback (previous tag still present)
docker compose down
docker run -d --name poly-vault --init --read-only --tmpfs /tmp \
  -p 127.0.0.1:8080:8080 --env-file .env \
  -v poly-vault-data:/data -v /srv/assets:/assets:ro \
  poly-vault:0.4.2-web

# metadata rollback (only if the new version wrote bad data)
./scripts/restore.sh ./backups/poly-vault-data-<ts>.tgz
```

Landing on the desktop app is also a valid rollback: `/data` is a folder of JSON
files that the Electron app reads directly (copy it to the artist's userData
folder). One writer only — stop the container first.

---

## 5. Token rotation

```bash
# with per-artist tokens
$EDITOR .env         # PV_USERS="alice:new-a,bob:new-b,carol:new-c"
docker compose up -d # recreated container, same volume

# with the shared token
$EDITOR .env         # PV_TOKEN=<new long random>
docker compose up -d
```

Everyone's browser session is invalidated (the cookie holds the token). Artists
must also update the token in Unity: **Window → Poly Vault → Access token**.

## 6. Adding a library

Preferred: mount it and list it. One mounted root = one library, and the
library's display name is the folder name:

```yaml
    volumes:
      - "${PV_ASSETS:-/srv/assets}:/assets:ro"
      - "${PV_ASSETS_2:-/srv/assets-2}:/libraries/Second Library:ro"
    environment:
      PV_LIBRARIES: "/assets:/libraries/Second Library"
      PV_LIBRARY_ROOTS: "/assets:/libraries"
```

Then `docker compose up -d`. Both roots are registered on boot; folders inside a
root are categories, not separate libraries.

Notes:

- Paths may contain spaces (`:/libraries/Other Unity Assets`) — quote the mount
  in compose and keep the env value quoted too.
- Existing tags/descriptions are keyed by absolute path: **changing a library's
  mount point strands its annotations** and re-reads its package index. Add new
  libraries at new paths instead of moving old ones.
- `PV_ENRICH_ROOTS` defaults to `/assets` in compose. Point it at a hand-curated
  library too only if its folder names are real product names — otherwise the
  Asset Store lookup attaches unrelated descriptions ("Meshes" matched a
  landscape pack).

Alternative: `POST /api/web/libraries` with the admin token and a path that lives
under `PV_LIBRARY_ROOTS` (also reachable from the UI's **Add Library** button when
signed in as admin).

Nested libraries are fine but avoid mounting a library *inside* another one; the
scanner would see the same assets twice.

---

## 7. Connecting a new artist's Unity

1. Open the Poly Vault URL in a browser and sign in.
2. Click **Settings** in the toolbar.
3. **Download Poly Vault for Unity** (`.tgz`, built from this server's source).
4. In Unity 6: **Window → Package Manager → + → Add package from tarball…** and
   pick the downloaded file.
5. **Window → Poly Vault → Poly Vault**: copy *Server URL* and *Access token* from
   the Settings panel into the two fields.
6. Click **Import to Unity** on any asset in the browser; it lands in
   `Assets/PolyVaultImports/…` within a few seconds.

### If Package Manager refuses the tarball

The `.tgz` has `package.json` at the archive **root** (required by UPM). Two
failure modes seen in the field:

| Symptom | Cause | Fix |
| --- | --- | --- |
| `The file …\Temp\…\package.json cannot be found` | tarball layout: UPM/npm expects a top-level `package/` folder (`package/package.json`); an older image tarred the folder as `PolyVault/` or at the root | use the current image: `tar tzf PolyVault-Unity-*.tgz \| head` must show `package/package.json` |
| `Your Internet security settings blocked one or more files` | Windows Mark-of-the-Web on HTTP downloads | right-click the file → **Properties** → tick **Unblock** → OK |
| `Unity can't complete the operation … This package is missing a signature` | Unity 6 package signing: tarballs are unsigned by design and verification is on | use the **.zip** / embedded route, or relax verification (below) |

**The reliable route is the `.zip`** (offered first in the Settings panel):
extract it anywhere, then **Package Manager → + → Add package from disk…** and
select `package.json` at the root of the extracted folder. It bypasses both the
tarball parser and blocked-file handling.

Artifacts: `.tgz` = npm/UPM layout (`package/package.json`, verified with
`npm install`), `.zip` = package contents at the root (for *Add package from
disk*).

### Unity 6 package signing

Unity 6 verifies package signatures. Only packages from the Unity registry carry
one, so **any** self-hosted or local package is refused when verification is
required — this is not specific to Poly Vault. Three ways forward, best first:

1. **Add package from disk** (the `.zip`): extract it and pick `package.json`.
   This is a local package and is not signature-checked. *This is what the team
   should use.*
2. **Embedded package**: copy the extracted folder to
   `<project>/Packages/com.polyvault.bridge/` (folder name must equal the package
   name). Unity loads it as an embedded package; no tarball, no signature, and it
   travels with the repo.
3. **Relax verification**: Unity 6 has a signature-verification setting under
   **Project Settings → Package Manager** (label varies by patch release). Turning
   it off is a project-wide security decision — check with whoever owns the
   project settings before doing it.

### Known editor errors and what they mean

| Console message | Cause | Action |
| --- | --- | --- |
| `GetString is not allowed to be called from a ScriptableObject constructor … AssetVaultWindow` | plugin ≤ 0.5.1 read `EditorPrefs` in `EditorWindow` field initializers | upgrade to **0.5.2+** (settings are now loaded in `OnEnable`) |
| `NullReferenceException … EditorWindow.OnDisableINTERNAL` when closing the window | side effect of the failed window construction above | same fix |
| `Invalid antiAliasing value (must be at least 1)` repeated | Unity project quality settings (`QualitySettings.antiAliasing = 0`), unrelated to Poly Vault | Project Settings → Quality → Anti Aliasing, or the pipeline asset's MSAA setting |

Notes: the token can be hidden with `PV_SHOW_TOKEN=0` (then hand it over out of
band); every plugin download is recorded in `audit.jsonl` as `plugin_download`;
with `PV_USERS` each artist's token makes imports land only in their editor.

## 8. The NAS (NFS) library

The Unity Asset Store cache lives on `nas.example.internal:/export/unity-assets`
and is mounted read-only. Specifics worth knowing:

- **New packages appear after `PV_SCAN_MAX_AGE_MS` (5 min) or immediately via the
  Update button.** inotify cannot see writes made by another machine over NFS.
- **A scan is ~0.7–0.9 s warm, up to ~11 s cold** (attribute cache empty, e.g.
  right after boot). It runs on a worker thread, so the UI stays responsive.
- **The container will not start while the export is unreachable** — that is a
  Docker mount failure, not a Poly Vault error. `restart: unless-stopped` retries;
  check `docker inspect -f '{{.State.Error}}' poly-vault`.
- **`soft` + `nolock`** are deliberate: no lockd dependency, and a NAS stall
  returns an I/O error instead of pinning the container forever.
- **Permissions**: the export is world-readable (0777) so uid 10001 can read it.
  If you tighten it, grant read (and execute on directories) to uid 10001.
- **Do not mount two libraries where one contains the other**; the same package
  would be indexed twice.

## 9. Package index (thumbnails from inside the archives)

`/data/packages` holds, per `.unitypackage`: a JSON record (contents, type counts)
and the preview image Unity embedded. Deleting either is safe — it is rebuilt on
the next pass.

```bash
curl -s -H "Authorization: Bearer $PV_TOKEN" localhost:8080/healthz | jq .packages
docker compose exec poly-vault du -sh /data/packages
```

| Field | Meaning |
| --- | --- |
| `indexed` / `queued` | packages done / waiting |
| `previews` | packages that had a usable preview inside |
| `fullPasses` | packages that also got a complete content listing |
| `bytesRead` | total decompressed bytes read from the NAS (watch this) |
| `lastMs`, `lastFile` | progress and slowest recent package |

- Runs **one package at a time on a worker thread** — it never competes with the
  UI, but it does generate NAS read traffic. On this library a preview pass moves
  ~10–60 MB per package; the full pass up to 256 MB.
- Set `PV_PACKAGE_INDEX=0` to stop it entirely (cards fall back to letter
  avatars), or lower `PV_PACKAGE_INDEX_MAX_MB` (default 4096) to skip full
  listings for big packages.
- To force a rebuild after moving packages: stop the container, `rm -rf
  /data/packages`, start it again.
- This is also the fastest way to answer "what is in this 500 MB package?" —
  the detail panel lists the largest files inside.

## 10. Troubleshooting

| Symptom | Diagnose | Fix |
| --- | --- | --- |
| "Cannot reach server" in Unity | `curl -H "Authorization: Bearer <token>" https://vault/healthz` | wrong URL, TLS trust, or token; the window says "401 Unauthorized" for a bad token |
| Import stays "queued" | `/api/unity/import-jobs` with the artist's token | `PV_USERS` mismatched with the token the editor uses (`targetUser` must match) |
| Import fails "Missing file" | job payload has `importables[].path` on the server | editor is in desktop mode (empty token) against a remote server — set URL + token |
| Grid empty after mounting | `/healthz` → `libraries[].missing` | container cannot read the mount (uid 10001 needs read access) |
| Tags/descriptions not saving | `docker compose logs` → `EACCES` | `/data` volume owned by a different uid: `docker volume` or `chown 10001:10001` |
| First page slow after boot | `pv_scan_last_ms` in `/healthz` | slow share; raise `PV_SCAN_MAX_AGE_MS`, or accept the one-off walk |
| `pv_watch_errors_total` climbing | inotify on NFS/SMB | expected; the TTL rescan keeps data fresh, lower `PV_SCAN_MAX_AGE_MS` to taste |
| 429 responses | `pv_rate_limited_total` | raise `PV_RATE_LIMIT_PER_MIN` or investigate the client |
| Thumbnails missing | `pv_thumb_fallback_total`, `thumbs.available` in `/healthz` | the image build lost `sharp`; the UI still works with original previews |

## 11. Incident checklist

1. `docker compose ps` — is it up and healthy?
2. `docker compose logs --tail 200 poly-vault` — any stack traces?
3. `curl localhost:8080/healthz` — public probe.
4. `/data/audit.jsonl` — what happened just before?
5. Disk: `docker system df`, and the volume's host filesystem (metadata is small;
   the thumbnail cache lives in `/data/thumbs` and is safe to delete).
6. If the container is wedged: `docker compose restart poly-vault`. The scan cache
   is rebuilt on boot; nothing is lost (writes are atomic tmp+rename).
7. Security event: rotate tokens (§5), read the audit log, then re-check the
   security smoke tests in `.github/workflows/ci.yml`.
