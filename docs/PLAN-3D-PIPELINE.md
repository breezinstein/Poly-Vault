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

---

## Status — delivered 2026-11-23 (branch `feat/3d-pipeline`)

| Phase | Commit | State |
|---|---|---|
| 0 Merge | `feat(rig): serve Mesh2Motion at /rig/ …` | done |
| 1 Link map | `feat(index): link map for every package …` | done — 636/636 packages, 0 failures |
| 2 Materials | `feat(3d): show models with their Unity materials …` | done |
| 3 Mesh2Motion loop | `feat(rig): Mesh2Motion loop …` | done — standalone stack retired |
| 4 Prefabs | `feat(3d): show prefabs assembled …` | done |
| 5 Proof + docs | `feat(3d): fidelity report, browser acceptance …` | done |

### What changed from the plan, and why

- **No patches to Mesh2Motion's source.** A bridge script injected at build
  time (`rig-bridge/pv-bridge.js`) loads models through Mesh2Motion's own file
  input and catches its export for "Save to vault". Survives upstream updates;
  `patches/m2m/` stays empty. Mesh2Motion's root-relative asset requests
  (`/assets/<rig>/…`, `/images/…`) are answered by a fallback in
  `server/rigStatic.js` instead of rewriting its code.
- **Entry order inside packages** is asset → meta → preview → *pathname last*,
  so materials/prefabs are recognised by their `%YAML` header and kept until
  their path arrives.
- **Unity's hashed sub-asset IDs**: mesh fileIDs are
  `xxHash64("Type:Mesh->" + name + index)` (verified 86/86 on real prefabs);
  the same rule does **not** hold for renderer components (≈2% matched), so
  material overrides on nested model instances use legacy name tables or a
  single-renderer rule, else fall back to the model's own materials (noted).
- **FBX 6** (15% of sampled FBX files, 21% of packages with FBX) is not read
  by three.js; added a server-side FBX 6 → GLB converter (static).
- **Scenes** (`.unity`) are part of the link map (schema 2): Unity 4-era packs
  assign materials on scene objects.
- **"Generated" materials**: when Unity's legacy search finds nothing, Unity
  generates the material from the FBX on import — treated as exact, not
  missing.
- **Fuzzy texture matching** (token overlap, never normal/mask maps) as a last
  resort for renamed files and Unity 4 binary materials; always "approximate".

### Verification

- Unit: `tests/unity-graph.test.js` (14), `tests/model-resolver.test.js` (24).
- Browser: `scripts/verify-3d.sh` (10 checks on a generated fixture: textured
  FBX 7, prefab of two crates, FBX 6 with TGA, Mesh2Motion hand-off).
- Endpoints/security: `scripts/ci-local.sh` (link map, models, Save to vault,
  `/rig/`), plus the existing phase 2/3/UI suites.
- Real packages in headless Chromium: textured models and prefabs from
  URP/Standard/Unity 4 packs; package model → Mesh2Motion Create → Human
  skeleton → Finish → Save to vault (FBX) → card → Animate in Mesh2Motion →
  Retarget loads the rig.
- Known pre-existing failure, unchanged: `verify-ui.sh`'s two 304-polling
  checks fail on `main` too.

### Library-wide fidelity report (2026-11-23, 2 h 2 min)

636 packages, 492 with models or prefabs (up to 60 models / 30 prefabs each):

| | exact | approximate | missing | no geometry | errors |
|---|---|---|---|---|---|
| models (8070) | 4147 (59.2%) | 2858 (40.8%) | 0 | 1065 | 0 |
| prefabs (7286) | 2033 (64.1% of 3171 with geometry) | 830 | 308 | 4115 | 0 |

- Most common reasons for "approximate": the model imports no materials
  (Unity uses prefab/default materials) 2941, custom shaders 2616, Unity 4
  binary materials 1005 + 683.
- The 308 missing prefabs are almost all meshes Poly Vault cannot read yet:
  Unity mesh assets (`.asset`, e.g. some environment packs) and Collada
  (`.dae`, e.g. some vegetation packs).
- FBX 6: 843 sampled files, 821 converted, 22 failed.
- 43 binary FBX files report an implausible version number (e.g. 188055550);
  not yet investigated.
- Top custom shaders (candidates for exact translations): Shader Graph
  shaders shared across one publisher's packs, an armour PBR shader, and a
  few toon and vertex-colour shaders.

Full detail: `<data>/reports/fidelity-2026-11-23.json`; summary in Settings.

### Follow-up 2026-11-24: mesh assets, Collada, embedded materials

The report's 308 missing prefabs came from three gaps, now closed:

- **Unity mesh assets** (`server/unityMesh.js`): `.asset` files holding
  `!u!43` Mesh objects (text serialisation) are decoded — vertex channels for
  Unity 4, 5–2018 and 2019+ layouts, 16/32-bit indices, triangle and quad
  topology — mirrored into the viewer's model space and written as GLB
  (`server/glbWriter.js`), one primitive per submesh. Compressed meshes and
  binary assets are reported, not shown.
- **Collada** (`server/colladaScan.js` + three.js `ColladaLoader`): node
  meshes, materials in primitive order and their textures (sampler → surface
  → image) feed the same resolver as FBX.
- **Materials embedded in another model file** (character packs and similar):
  a renderer slot pointing at an FBX's sub-asset is named by the FBX's name
  table or Unity's hashed fileID (`xxHash64("Type:Material->" + name + i)`)
  and resolved the way that model resolves its own materials.

Found and fixed on the way:

- **FBX 6 textures were upside down**: the converter wrote glTF-style V
  (`1 - v`) but the viewer's textures use OpenGL V (flipY), like FBXLoader.
  Converted files are versioned, so old cached GLBs are not reused.
- **glTF meshes with several material slots** were split by GLTFLoader into
  one mesh per slot, and prefabs only got the first; the viewer merges them
  back (with groups) for prefab parts.
- **Vendoring** (`scripts/flatten_webgl_vendor.py`) stopped rewriting imports
  after ten files because `any()` short-circuits; it now rewrites all files
  each round and fails the build if a bare `three` import is left.
- The fidelity report now follows nested prefabs, as the viewer does
  (earlier numbers under-counted nested parts), and prefabs that use
  materials from outside the package say so.

Verification: `tests/mesh-formats.test.js` (12), `verify-3d.sh` now 14 checks
(mesh-asset prefab with two slots, prefab using a Collada file's embedded
material, textured Collada model). Real packages in headless Chromium, all
"Matches Unity": mesh-asset prefabs from two environment packs, a
vegetation prefab and its `.dae`, a character prefab using another FBX's
material, an FBX 6 sports car (tyres now show the tyre texture, not the paint).

Re-run of the report (2026-11-24 06:03 UTC, 7268 s, same 636 packages;
`<data>/reports/fidelity-latest.md`):

| | exact | approximate | missing | with geometry |
|---|---|---|---|---|
| models, 2026-11-23 | 4147 (59.2%) | 2858 | 0 | 7005 |
| models, 2026-11-24 | 4209 (59.6%) | 2859 | 0 | 7068 (now incl. `.dae`) |
| prefabs, 2026-11-23 | 2033 (64.1%) | 830 | 308 | 3171 |
| prefabs, 2026-11-24 | 2184 (68.9%) | 944 | 43 | 3171 |

Missing prefabs fell from 308 to 43; the rest became exact (+151) or
approximate (+114). Unity mesh assets used by prefabs: 227 files, 225
converted. Of the 43 still missing, 31 are in two packages (materials
in a nested package, meshes from another package); the rest are single
prefabs spread over ten packages. The top reasons for "approximate" are
unchanged: models that import no materials (3003 parts), custom shaders
(2619) and Unity 4 binary assets (2256).

### Known limits

- Unity mesh assets stored in binary form or with mesh compression are not
  rendered (reported per file).
- Custom shaders are approximate (texture slots by name).
- Unity 4 binary prefabs/materials/scenes cannot be read (reported).
- Overrides inside nested prefabs beyond the root transform are not applied.
- Prefabs with a SkinnedMeshRenderer (not a nested model) show in bind pose.
- 3ds Max biped rigs need manual bone mapping in Mesh2Motion's Retarget.
- FBX 6 models are static after conversion (no skin/animation).
