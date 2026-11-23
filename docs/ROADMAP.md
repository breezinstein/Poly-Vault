# Roadmap — next work on Poly Vault

Planning document. Nothing here is implemented yet. It records the ideas that came
out of auditing **Asset Inventory 4.9.0** (a paid Unity editor tool found in
a local checkout), the decisions already taken, and an execution
checklist precise enough that starting later is mechanical.

> **Licensing note:** Asset Inventory ships without a licence file and is a
> commercial asset. Everything below is a *reimplementation of ideas*; no code,
> strings or assets may be copied from it.

---

## 1. Decisions taken

| Question | Decision |
| --- | --- |
| OpenAI key | Provided when needed, in `.env` only, server-side; never exposed to the browser. |
| Budget | No hard cap — limits are configured on the OpenAI account. Enrich **all** libraries (no `PV_AI_ROOTS` scoping needed, but keep the switch). |
| Privacy | Acceptable: sending preview images, audio and file paths through the OpenAI API is fine. |
| Priority | Phase A → B → C → D → E as below. |
| Start | On request; this file is the contract for that work. |

---

## 2. Current state (so the plan is self-contained)

**Server** (`server/`, Node 24, no framework): front door + loopback bridge.

- Endpoints: `/api/library`, `/api/tags`, `/api/meta`, `/api/preview`, `/api/thumb`,
  `/api/file` (`&entry=` extracts from a package; legacy `path=…%23entry` accepted),
  `/api/download`, `/api/package`, `/api/package/tree`, `/api/package/preview`,
  `/api/import-job(s)`, `/api/unity/*`, `/api/update`, `/api/enrichment`,
  `/api/web/{session,state,libraries}`, `/plugin/unity-package.{tgz,zip}`,
  `/healthz`, `/metrics`, `/login`.
- Scans run on a worker thread (`scanWorker.js`); `.unitypackage` parsing runs on a
  second worker (`pkgWorker.js`) driven by `packageIndex.js`.
- Package index record (`/data/packages/meta/<sha1>.json`):
  `path, mtimeMs, size, mode, previewPath, previewBytes, contentsCap, previewTried,
  counts, totalAssets, totalBytes, folders, contents[{path,size}], partial,
  truncated, scannedBytes, indexedAt`.
- Enrichment (`src/main/unityAssetStore.js` + `src/main/enrichment.js`): scrapes
  `assetstore.unity.com/sitemap?q=<name>` and the product page, stores
  `{description, name, url, found}` in the meta store.

**UI** (`ui/`): vanilla renderer, patched. Three-pane layout, package tree with
lazily loaded entries, entry cards, previews (image / audio / video / optional
WebGL model viewer), tags, descriptions, import buttons.

**Unity add-on**: plugin `0.6.0`, per-artist job routing, per-file import.

**Tests**: `scripts/verify-phase2.sh` (26), `verify-phase3.sh` (25),
`verify-ui.sh` (12), `make-fixture-library.sh`, plus the upstream smoke suite.

---

## 3. The list (ranked)

| # | Item | Effort | Impact | Phase |
| --- | --- | --- | --- | --- |
| 1 | Store metadata already present in the payload we fetch (publisher, rating, price, cover/icon image) | ~1 h | High — covers for the 54 preview-less packages, quality signals | A |
| 2 | File-level metadata (image dimensions, audio duration) + filters | ~1 day | High — "textures ≥ 2K", "audio > 30 s" | A |
| 3 | Search modifiers `+`/`-`/`~`, `tag:`/`type:` tokens, saved searches | ~½ day | High | B |
| 4 | Storage panel (packages · index · thumbnails · extracted cache) with purge | ~2 h | Medium | B |
| 5 | Dependency graph (intra-package, then cross-package) | 3–4 days | High — makes single-file import safe | C |
| 6 | Duplicate audit (manifest → perceptual hash → content) | 2–3 days | Medium-High | D |
| 7 | AI captions + embeddings via OpenAI, semantic search | 4–6 days | High, riskiest | E |
| 8 | Conditional refresh + "store version differs" badge | ~½ day | Medium (depends on A1b) | A (optional) |

---

## 4. Phase A — cheap wins (≈1.5 days)

### A1. Store metadata from the payload we already download

`GET assetstore.unity.com/sitemap?q=<name>` embeds `searchPackageFromSolr`; today
we read only `name/id/category/description`. The same array carries, per product:

```
id, name, rating, average, count, publisherName, publisherId, category,
mainImage, iconImage, price, originPrice, onSale, plusProSale, labels, url
```

- [ ] `findAndFetchDescription()` (rename to `lookupProduct()`) returns
      `{found, name, url, description, publisher, publisherId, rating, ratingCount,
        price, onSale, iconImage, mainImage}`.
- [ ] `mergeMetaEntry` keeps the new fields; meta store stays JSON (no schema change).
- [ ] Download `iconImage` (fallback `mainImage`) once per package into
      `/data/previews/store/<sha1(path)>-<mtime>.jpg` (skip if the package already has
      a preview extracted from the archive — archive previews win).
- [ ] Serve it through the existing `/api/thumb` path allow-list (add the store
      preview directory), and let `decoratePackages` set `asset.preview` when the
      archive has none. **This is what gives the 54 preview-less cards a cover.**
- [ ] Card: publisher line, star rating (`average`/`count`). Detail panel: publisher,
      rating, price, "View on store".
- [ ] Refresh policy: keep `fetchedAt`; re-lookup only when older than
      `PV_ENRICH_MAX_AGE_DAYS` (default 30) **and** the user hits *Update*, so the store
      isn't polled on every scan.
- [ ] Failure handling: image download failures must not block enrichment; record
      `icon: 'failed'` and fall back to the initial-letter avatar (current behaviour).

**A1b (optional, on demand).** `supportedUnityVersions`, `compatibilityInfo` and the
product's own `version` object are only on the product page, not in the search array.
Add a *detail-panel* action "Check compatibility" that fetches
`/packages/<category>/<slug>-<id>`, caches the result in meta (7-day TTL) and shows
"Unity 2019.4.25+", "URP/HDRP: yes". Do **not** bulk-fetch this on scan.

*Acceptance:* a package without an archive preview shows the store cover; cards show
publisher + rating; `/api/enrichment` and `/healthz` unchanged; enrichment of an
already-indexed library performs no additional archive reads.

### A2. File-level metadata: dimensions and duration

Parsed while indexing, in `unityPackage.js` (same streaming pass — no extra reads):

- [ ] Images: PNG (`IHDR`), JPEG (SOF markers), TGA (header), BMP, GIF → `w`, `h`.
- [ ] Audio: WAV (`fmt ` + `data` chunks), OGG (page granule fallback), MP3 (frame header estimate) → `durationSec`.
- [ ] Enforce a small cap (e.g. parse headers only, ≤ 64 KB per file); unknown → `null`.
- [ ] Extend the index record `contents[]` entries with `{path, size, w, h, dur}` and
      bump the index schema version so old entries re-index lazily (same mechanism as
      `contentsCap` today).
- [ ] `/api/package/tree` passes the new fields through (bounded, as now).
- [ ] UI: entry card subtitle (`2048×2048`, `0:07`), detail panel rows, and filters:
      *textures ≥ N px*, *audio ≥ N s*, *kind* (already have), *has preview*.
- [ ] Server-side filter params (`?minWidth=&minDuration=&kind=`) on
      `/api/package/tree` so the client doesn't have to fetch everything first.

*Acceptance:* on the 194-entry package, "≥ 1024 px" returns only large textures and
reading the archive is not repeated after the first pass.

### A3 (optional). "Store version differs" badge

Needs A1b's product `version`. Compare with the version recorded in the package
filename when present (`…_2022.3.0f1.unitypackage`) or with the first-seen version.
Small badge + tooltip. Skip if A1b is not built.

---

## 5. Phase B — search + insight (≈1 day)

### B1. Search syntax

Grammar (client-side, in `ui/renderer.js`; no server change):

```
tokens        := term*
term          := [+|-]?token | "~" phrase | key ":" value
key           := tag | type | kind | dir | size | pkg
modifiers     :  bare = AND,  +term required,  -term excluded,  ~"..." exact phrase
examples      : wood -fbx +interior      tag:winter type:tif      ~"snow 02"
```

- [ ] Parser + filter pipeline in `assetsFiltered()`; show parsed chips under the
      search box so the behaviour is discoverable.
- [ ] Saved searches: `POST/PUT/DELETE /api/web/searches` storing
      `{id, name, query, createdBy, shared}` in `/data/searches.json`; a dropdown in
      the toolbar.
- [ ] Tests: extend `scripts/verify-ui.sh` with 4 query assertions (AND, minus,
      exact, tag token).

*Acceptance:* the four example queries above return the expected cards; a saved
search survives a restart; typing `tag:` opens tag suggestions.

### B2. Storage panel

- [ ] `/healthz` (or a new `/api/storage`) reports: library bytes (already known),
      `pkg-meta`, `previews`, `thumbs`, `extracted` cache, `data` total.
- [ ] Settings → "This server": table with sizes and **Purge** buttons for the
      disposable caches (`/data/thumbs`, `/data/packages/extracted`), each behind a
      confirmation; never offer to purge meta/tags/jobs.
- [ ] Audit event on purge (`cache_purged` with bytes freed).

*Acceptance:* the numbers add up to `du -sh /data`; purging thumbnails only costs
regeneration time and the grid still renders.

---

## 6. Phase C — dependency graph (3–4 days)

**Goal:** never break a single-file import again. When importing one entry, warn
about (and optionally include) the entries it references.

### C0. Shared job runner (prerequisite for C, D, E)

- [ ] `server/jobs.js`: one background queue with `enqueue(type, payload)`,
      persisted progress in `/data/jobs-progress.json`, concurrency 1 per type,
      cancel/pause, and `/api/web/jobs` for the UI. The package indexer becomes the
      first consumer (`type: 'index'`); duplicate scan, dependency scan and AI
      captioning reuse it.

### C1. Intra-package graph

> **Being delivered by [`PLAN-3D-PIPELINE.md`](PLAN-3D-PIPELINE.md) Phase 1:** the
> `.meta`/`.mat`/`.prefab` capture, guid map and reference graph land there (for
> material linking). What remains here is the deps endpoint and "Import with
> dependencies".

- [ ] `unityPackage.js`: capture `<guid>/asset.meta` (small YAML, need `guid:`), and
      text assets under a size cap (≤ 256 KB) for `.prefab/.unity/.mat/.asset/
      .controller/.anim/.asset` plus `.cs`/`.shader` if cheap.
- [ ] Build `guid → entryPath` and `entryPath → [referencedEntryPaths]` by regexing
      `guid:\s*([a-f0-9]{32})` (also `"guid": "…"` for JSON-ish files).
- [ ] Store in the package record: `entryGuids: {guid: path}` (only for entries that
      matter) and `deps: [{from, to}]`, both bounded (e.g. ≤ 2 000 edges) with
      `depsPartial: true` when the read budget cut the pass.
- [ ] Endpoint `GET /api/package/deps?path=…&entry=…` → `{dependsOn:[…], requiredBy:[…]}`.
- [ ] Entry panel: "⚠ depends on 3 files" list; **Import with dependencies** button →
      the import job carries all required entries (server expands the closure,
      dedupes, caps at e.g. 50 files, and reports what was added).

### C2. Cross-package graph

- [ ] Global inversion in `/data/graph.json`: `guid → {package, entry}` for every
      indexed package; an edge `A → B` exists when an asset in A references a GUID
      whose only provider is B (skip GUIDs provided by several packages — pick the
      package in the same library, else mark ambiguous).
- [ ] Package panel: "Requires: …" / "Used by: …" lists; clicking navigates.
- [ ] Metrics: `pv_dep_edges`, `pv_dep_packages_without_graph`.

### C3 (optional, later). Graph view

A force-directed canvas in a new detail tab. Only if the lists prove insufficient.

*Acceptance:* importing one prefab from a 194-entry package reports its
material/texture dependencies and the import lands complete; its demo scene
shows cross-package requirements if any exist; graphs are partial-flagged for
packages that hit the read budget.

---

## 7. Phase D — duplicate audit (2–3 days)

### D1. Manifest similarity (P1, no extra I/O)

- [ ] For each pair of packages, Jaccard over the set of `(relativePath, size)` from
      the index; block candidates via an inverted index on `(basename, size)` so it
      is not O(n²) in practice.
- [ ] Report pairs with `score ≥ 0.8` (tunable) into `/data/duplicates.json` with
      name, publisher, size, score, differing entries count.

### D2. Perceptual hash of covers (P2, no extra I/O)

- [ ] `sharp` → 9×8 grayscale → dHash (64-bit) for every cached preview (archive or
      store); Hamming distance ≤ 6 → "same art". Catches re-releases and re-packs.

### D3. Content hash (P3, on demand)

- [ ] For a selected pair only, hash entries ≤ 8 MB (SHA-1) and report identical
      files; explicit button, shows the read volume before starting.

### D4. Maintenance UI

- [ ] Settings → **Maintenance**: run/stop scans, table of pairs, actions:
      *Hide one from search* (a `hidden` flag honoured by `/api/library`),
      *Merge tags* into the survivor, *Dismiss* (persisted so it is not re-reported).

*Acceptance:* the two copies of a re-downloaded pack appear as one row; nothing is
read from the NAS for P1/P2; dismissing a pair survives a restart.

---

## 8. Phase E — AI captions + embeddings via OpenAI (4–6 days)

### E0. Configuration (server-side only)

| Env | Default | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | required; never exposed by `/api/web/session` |
| `PV_AI_ENABLED` | `0` | master switch |
| `PV_AI_CAPTION_MODEL` | `gpt-4o-mini` | vision/text captions |
| `PV_AI_TRANSCRIBE_MODEL` | `whisper-1` | audio → text before captioning |
| `PV_AI_EMBED_MODEL` | `text-embedding-3-small` | 1536-dim vectors |
| `PV_AI_MAX_FILE_MB` | `25` | skip larger uploads |
| `PV_AI_DRY_RUN` | `1` | plan + cost estimate only |

### E1. Pipeline (runs on the shared job runner)

1. **Plan stage** (dry run): count candidates per library — entries with previews
   (images/models/prefabs), audio files, text files; estimate tokens and cost from
   historical averages; write `/data/ai/plan.json` and show it in Settings. No API
   calls.
2. **Caption stage**: per entry (bounded concurrency 3–4, exponential backoff on
   429/5xx):
   - images/models/prefabs → preview PNG + prompt → 1–2 sentence caption + tags;
   - audio → `whisper-1` transcript → short caption ("glass shatter, short tail");
   - text/scripts → first 8 KB → caption.
   Cache key `sha1(packagePath+mtime+entry+promptVersion)`; never re-caption
   unchanged files. Store in `/data/ai/captions.json`.
3. **Embedding stage**: batch up to 2 048 inputs per request over
   `caption + "\n" + entryPath + " " + packageName`; store
   `{key, model, dim, vector}` in `/data/ai/vectors.db` via `node:sqlite` (already
   in the image), table `vectors(key TEXT PRIMARY KEY, model TEXT, dim INT, vec BLOB)`.
4. **Search**: `/api/ai/search?q=…` embeds the query and does brute-force cosine
   (fine to ~50k vectors), returning top-K keys; the renderer's **Semantic** toggle
   merges them with keyword results via reciprocal-rank fusion. Off → current
   behaviour exactly.

### E2. Cost and failure handling

- No hard cap (per decision), but log per-batch token usage from the API response and
  expose `pv_ai_tokens_total` / `pv_ai_cost_estimate_usd` in `/metrics` so spend is
  visible.
- Resume-safe: progress in `/data/ai/progress.json`; a restart continues.
- Per-file failures recorded and skipped (never retried more than 3 times).
- Captions are additive: the UI shows them as a separate section ("AI description")
  so a human description always wins; `/api/meta` remains the source of truth for
  user edits.

### E3. Privacy / audit

- Batch start/end events in `audit.jsonl` (`ai_batch`, counts, model, tokens) and a
  visible "AI: on" indicator in Settings. Per decision, all libraries are enriched.

*Acceptance:* dry run predicts the candidate count and cost before any spend; a
semantic query such as "snowy ground texture" returns `Snow_02_Height.tif` for the
Winter Environment package; `PV_AI_ENABLED=0` leaves the app byte-identical in
behaviour; a restart during captioning resumes and never duplicates work.

---

## 9. Cross-cutting requirements

- **Back-compat:** every index-record change bumps a schema counter and re-indexes
  lazily (the mechanism added for `contentsCap`), never a forced 108 GB re-read.
- **Metrics:** add counters per phase; keep `/healthz` shape additive only.
- **Docs:** README + RUNBOOK updated in the same commit as each phase; new env vars
  in `.env.example`, never real keys.
- **Plugin:** unchanged for A/B/D/E. Phase C's "import with dependencies" is
  server-side only (the job simply carries more importables), so the add-on stays at
  0.6.0 unless we later add a dependency warning inside the editor.
- **Tests:** each phase extends `scripts/verify-phase2.sh` / `verify-ui.sh`; the
  fixture generator (`make-fixture-library.sh`) grows a package with known
  dimensions/durations/dependencies so assertions are deterministic.

---

## 10. Execution checklist (in order)

```
Phase A
  [ ] A1 lookupProduct(): return publisher/rating/price/iconImage/mainImage
  [ ] A1 download + cache store covers, wire into decoratePackages fallback
  [ ] A1 card + detail panel fields; store link
  [ ] A2 header parsers (png/jpg/tga/bmp/gif, wav/ogg/mp3) in unityPackage.js
  [ ] A2 index record + schema bump; tree passthrough; filters + params
  [ ] A3 (optional) A1b product-page compatibility check, on demand
Phase B
  [ ] B1 search parser + chips + saved searches API/UI
  [ ] B2 storage stats endpoint + panel + purge actions (+ audit)
Phase C
  [ ] C0 shared job runner; port the package indexer onto it
  [ ] C1 guid map + intra-package edges + /api/package/deps
  [ ] C1 entry panel warning + "Import with dependencies"
  [ ] C2 global inversion + Requires/Used by
  [ ] C3 (optional) graph view
Phase D
  [ ] D1 manifest similarity scan + report + UI table
  [ ] D2 dHash over cached covers
  [ ] D3 on-demand content hashing for a selected pair
  [ ] D4 maintenance actions (hide/merge/dismiss) + persistence
Phase E
  [ ] E0 env + settings UI + dry-run planner
  [ ] E1 caption pipeline (vision/audio/text) on the job runner
  [ ] E1 embeddings into node:sqlite + /api/ai/search
  [ ] E1 renderer "Semantic" toggle + RRF merge
  [ ] E2 metrics/audit/resume; E3 privacy indicator
```

---

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| Store scraping breaks (HTML/JSON changes) | keep the existing defensive parsing + tests; A1b is optional and isolated |
| Store cover images are hot-linked CDN files | download once, cache in `/data`, never hot-link from the browser |
| Index schema churn forces a big re-read | lazy per-package upgrade, triggered by opening a package (already proven) |
| Dependency pass reads a lot on NFS | text-entry size cap + read budget, `depsPartial` flag, runs on the worker |
| Duplicate audit O(n²) | inverted index on `(basename,size)`; P3 only on user request |
| AI cost surprise | dry-run plan first, per-batch token logging, `PV_AI_ENABLED` off by default |
| AI captions contradict human descriptions | separate "AI description" section; human edits always win |
| `node:sqlite` is experimental | isolate behind `server/ai/vectorStore.js` so it can be swapped for a file-backed store |

---

## 12. Remaining open questions

1. Ratings/prices change often — refresh window default of 30 days OK? (currently
   proposed `PV_ENRICH_MAX_AGE_DAYS=30`.)
2. Should "hidden duplicates" hide the package everywhere, or only from search
   results while remaining browsable in the tree?
3. For C1's "Import with dependencies": cap the auto-included closure at ~50 files?
   (bigger sets are probably a whole-package import in disguise.)
4. Semantic search default: off with an obvious toggle (current plan), or on once
   embeddings exist for the whole library?
