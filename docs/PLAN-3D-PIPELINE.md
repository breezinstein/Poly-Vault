# Plan — 3D pipeline: Mesh2Motion inside Poly Vault, models with materials

Contract for the `feat/3d-pipeline` branch. Each phase ends in a commit with its
acceptance checks passing. Supersedes the first half of ROADMAP item C1 (guid map
and references); C1's "Import with dependencies" builds on the graph made here.

## Goal

One tool, one URL, one sign-in:

1. A model opened in Poly Vault looks like it does in Unity — materials, textures,
   prefab assembly — or says honestly that it doesn't (Exact / Approximate / Missing).
2. Any model can be sent to Mesh2Motion: static meshes to **Create** (rig it),
   skinned meshes to **Retarget** (animate it). Already-rigged characters in the
   Asset Store packs open in Retarget directly.
3. Mesh2Motion saves back into the vault (**Rigged** library, NAS), linked to the
   source asset, importable into Unity with the existing add-on.

## Decisions

| # | Decision |
|---|---|
| 1 | Rigged output: writable NFS export, mounted `hard` (not `soft`: a timeout mid-write must not silently corrupt a file) at `/libraries/Rigged`. Verified writable by uid 10001. |
| 2 | Work on `feat/3d-pipeline`; pending deploy changes were committed to `main` first. |
| 3 | NAS reads are not budgeted: the link-map pass covers the whole library eagerly; the fidelity report covers every package that contains models. |
| 4 | Mesh2Motion (MIT) is built into the Poly Vault image at `/rig/`, pinned to a commit, with our changes kept as patches in `patches/m2m/`. The standalone stack (port 3002) is retired after Phase 3. |
| 5 | New dependencies: `ag-psd` (MIT, PSD composite), three.js `GLTFExporter` (MIT, vendored). TGA decoder written in-house. |
| 6 | Rigged saves default to FBX (Unity imports it natively; GLB needs glTFast). |

## Architecture

```
index pass (already streams every archive)
  └─ also keeps small text entries: .meta (≤64 KB), .mat (≤256 KB), .prefab (≤1 MB)
       └─ /data/packages/graph/<sha1>.json  guid → path, models, materials, prefabs, textures

GET /api/model/manifest?path=&entry=
  └─ resolver (pure, unit-tested): per renderer/submesh → material → textures
  └─ extractEntries(): one archive pass for the mesh + all its textures, cached
GET /api/package/texture?path=&entry=&role=&w=
  └─ WebP via sharp; TGA (own decoder), PSD (ag-psd composite);
     Unity MetallicGloss (R metal, A smooth) / HDRP MaskMap → three.js ORM

viewer: load mesh(es), apply materials, fidelity badge, play embedded clips
  ├─ [Rig in Mesh2Motion]      static mesh  → /rig/create.html
  └─ [Open in Mesh2Motion]     skinned mesh → /rig/retarget/
       GLB (textures embedded) handed over in the browser (postMessage, same origin)

Mesh2Motion [Save to vault] → POST /api/web/rigged → /libraries/Rigged/<name>__rigged.fbx
  └─ meta: tags rigged + rig:<type>, source = original package/entry
```

### Material resolution order (per model submesh)

1. FBX `.meta` `externalObjects` (explicit remap) — authoritative.
2. Prefabs in the same package whose renderers use this FBX mesh (fileID → name via
   `internalIDToNameTable` / `fileIDToRecycleName`).
3. Unity's legacy search: `materialName` rule in `Materials/` folders walking up,
   then package-wide by name.
4. Textures referenced inside the FBX, matched by basename.
5. Missing → neutral grey, slot listed in the badge.

### Shader translation

Exact: Standard, Standard (Specular setup), URP Lit / Simple Lit / Baked Lit /
Unlit, HDRP Lit, Legacy Diffuse / Bumped / Transparent / Cutout, Mobile/*.
Approximate: anything else — texture slots by property-name heuristics
(albedo|base|main|diffuse → map, normal|bump → normalMap, emiss → emissive,
metal|mask → ORM, occlusion|ao → aoMap); vertex colours when the mesh has them
and the material has no albedo.

## Phases

### Phase 0 — Merge (½ day)
- Plan doc (this file); ROADMAP note on C1.
- Dockerfile stage builds Mesh2Motion (pinned) with `/rig/` links; `server.js`
  serves `/rig/` behind the existing auth with its own CSP.
- `nas_rigged` volume + `Rigged` library.
- **Accept:** `/rig/`, `/rig/create.html`, `/rig/retarget/` load signed-in and
  redirect to sign-in otherwise; existing verify suites pass; container can write
  to `/libraries/Rigged`.

### Phase 1 — Link map (1.5–2 days)
- Index pass captures `.meta`/`.mat`/`.prefab` text; graph file per package;
  schema bump → lazy upgrade; eager background pass over the whole library
  (resumable, one package at a time, UI unaffected).
- `extractEntries(file, paths[])`: many entries, one pass, cached.
- Loose Unity folders with `.meta` files get the same graph.
- **Accept:** every package has a graph or a recorded reason; `/healthz` shows
  progress; restart resumes; 7 entries extracted with one read.

### Phase 2 — Models with materials (2 days)
- Resolver + `/api/model/manifest`; shader translation; texture endpoint.
- Viewer applies materials, badge + unresolved slots, embedded animation playback.
- **Accept:** fixture models render textured (pixel check in headless Chromium);
  resolver unit tests pass.

### Phase 3 — Mesh2Motion loop (1 day)
- Viewer → GLB → hand-off to Create/Retarget. M2M patch: `?model=` / hand-off
  input, **Save to vault** on both export steps.
- `POST /api/web/rigged`: auth, `.fbx`/`.glb` only, size cap, safe names, audit.
  Rigged cards link to source and open in Retarget.
- Retire the standalone mesh2motion stack.
- **Accept:** packaged FBX → rig → save → card in Rigged → opens in Retarget →
  imports to Unity; a pre-rigged pack character opens in Retarget directly.

### Phase 4 — Prefabs (1.5–2 days)
- `.prefab` assembly: hierarchy, transforms, MeshRenderer + SkinnedMeshRenderer,
  nested PrefabInstance to depth 4 (transform overrides only).
- **Accept:** fixture prefabs incl. nested render correctly.

### Phase 5 — Proof + docs (1 day)
- Fidelity report over the whole library → `/data/reports/`, shown in Settings.
- Fixture package (FBX + .meta remap, URP .mat, TGA, PSD, nested prefab);
  `scripts/verify-3d.sh`; README / RUNBOOK / `.env.example`.
- **Accept:** all suites pass; report reviewed.

## Known limits

Custom shaders are approximate (badged). Not rendered: terrain, particles, LOD > 0.
`.blend/.max/.ma` cannot be previewed (Unity needs the DCC app). PSDs without a
composite fall back to grey.
