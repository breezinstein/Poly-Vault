'use strict';
// Library-wide 3D fidelity report: how many models and prefabs Poly Vault
// shows exactly as Unity does, approximately, or not at all — and why.
//
//   node server/fidelityReport.js [--data /data] [--max-models 60] [--max-prefabs 30]
//
// Reads the link maps in <data>/packages/graph, extracts each package's model
// files once (no textures needed to resolve materials), resolves every model
// and prefab, and writes:
//   <data>/reports/fidelity-<date>.json   full per-package detail
//   <data>/reports/fidelity-latest.json   summary (shown in Settings)
//   <data>/reports/fidelity-latest.md     the same, readable
// Safe to run beside the live server: it only reads the libraries and the
// link maps, and writes into reports/ and a private temp folder.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractMany, GRAPH_SCHEMA } = require('./unityGraph');
const { resolveModel, modelStructure } = require('./modelResolver');
const { resolvePrefab } = require('./prefabResolver');
const { fbxVersion, convertFbx6 } = require('./fbx6');

const MODEL_RE = /\.(fbx|obj)$/i;

function normalizeNote(n) {
  return n
    .replace(/^[^:]{1,120}: (?=(custom shader|material is stored|stored in binary|FBX))/, '')
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\d+ /g, 'N ')
    .replace(/FBX \d\.\d/g, 'FBX 6.x');
}

async function run(opts = {}) {
  const dataDir = opts.data || '/data';
  const graphDir = path.join(dataDir, 'packages', 'graph');
  const reportDir = path.join(dataDir, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const maxModels = opts.maxModels || 60;
  const maxPrefabs = opts.maxPrefabs || 30;
  const started = Date.now();

  const files = fs.readdirSync(graphDir).filter((f) => f.endsWith(`-s${GRAPH_SCHEMA}.json`));
  const totals = {
    packages: 0, packagesWithModels: 0,
    models: { exact: 0, approximate: 0, missing: 0, none: 0, error: 0 },
    prefabs: { exact: 0, approximate: 0, missing: 0, none: 0, error: 0 },
    parts: { exact: 0, approximate: 0, missing: 0 },
    sources: {}, shaders: {}, customShaders: {}, notes: {}, fbxVersions: {},
    fbx6: { files: 0, converted: 0, failed: 0 },
  };
  const packages = [];
  const bump = (obj, k, n = 1) => { obj[k] = (obj[k] || 0) + n; };

  for (const f of files) {
    let graph;
    try { graph = JSON.parse(fs.readFileSync(path.join(graphDir, f), 'utf8')); } catch (_) { continue; }
    if (graph.kind !== 'package') continue;
    totals.packages += 1;
    const models = Object.entries(graph.paths).filter(([, p]) => MODEL_RE.test(p)).slice(0, maxModels).map(([g]) => g);
    const prefabs = Object.keys(graph.prefabs).slice(0, maxPrefabs);
    if (!models.length && !prefabs.length) continue;
    totals.packagesWithModels += 1;

    // Models used by the sampled prefabs too, so prefab meshes resolve.
    const needed = new Set(models);
    for (const pg of prefabs) for (const o of Object.values(graph.prefabs[pg].o || {})) {
      const ref = o.c === 33 || o.c === 137 ? o.mesh : o.c === 1001 ? o.src : null;
      if (ref && ref.g && graph.paths[ref.g] && MODEL_RE.test(graph.paths[ref.g])) needed.add(ref.g);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-report-'));
    const structures = new Map();
    try {
      await extractMany(graph.path, [...needed].map((g) => ({ guid: g, outPath: path.join(tmp, g), maxBytes: 256 * 1024 * 1024 })));
      for (const g of needed) {
        const p = path.join(tmp, g);
        if (!fs.existsSync(p)) continue;
        const bytes = fs.readFileSync(p);
        const fmt = path.extname(graph.paths[g]).slice(1).toLowerCase();
        structures.set(g, modelStructure(bytes, fmt));
        if (fmt === 'fbx' && models.includes(g)) {
          const v = fbxVersion(bytes);
          bump(totals.fbxVersions, v >= 7000 ? `${Math.floor(v / 100) / 10}` : v > 0 ? '6.x' : 'unknown');
          if (v > 0 && v < 7000) {
            totals.fbx6.files += 1;
            try { convertFbx6(bytes); totals.fbx6.converted += 1; } catch (_) { totals.fbx6.failed += 1; }
          }
        }
      }
    } catch (err) {
      // extraction failure: counted as errors below
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    const pkg = { name: path.basename(graph.path), path: graph.path, models: {}, prefabs: {}, notes: {} };
    const tally = (bucket, res) => {
      bump(totals[bucket], res.fidelity);
      bump(pkg[bucket], res.fidelity);
      for (const r of res.rendered || []) {
        bump(totals.parts, r.fidelity);
        bump(totals.sources, r.source);
      }
      for (const spec of Object.values(res.materials || {})) {
        bump(totals.shaders, spec.family || 'unknown');
        if (spec.family === 'custom') bump(totals.customShaders, spec.shader);
      }
      for (const n of res.notes || []) { const k = normalizeNote(n); bump(totals.notes, k); bump(pkg.notes, k); }
    };
    for (const g of models) {
      const s = structures.get(g);
      if (!s) { bump(totals.models, 'error'); bump(pkg.models, 'error'); continue; }
      try { tally('models', resolveModel(graph, graph.paths[g], s)); } catch (_) { bump(totals.models, 'error'); bump(pkg.models, 'error'); }
    }
    for (const g of prefabs) {
      try { tally('prefabs', resolvePrefab(graph, graph.paths[g], (m) => structures.get(m) || null)); } catch (_) { bump(totals.prefabs, 'error'); bump(pkg.prefabs, 'error'); }
    }
    packages.push(pkg);
    if (opts.progress) opts.progress(totals.packages, files.length, pkg.name);
  }

  const top = (obj, n = 12) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
  const pct = (part, all) => (all ? Math.round((part / all) * 1000) / 10 : 0);
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const summary = {
    generatedAt: new Date().toISOString(),
    seconds: Math.round((Date.now() - started) / 1000),
    sampling: { maxModelsPerPackage: maxModels, maxPrefabsPerPackage: maxPrefabs },
    packages: totals.packages,
    packagesWithModels: totals.packagesWithModels,
    models: { ...totals.models, total: sum(totals.models) },
    prefabs: { ...totals.prefabs, total: sum(totals.prefabs) },
    parts: totals.parts,
    percent: {
      modelsExact: pct(totals.models.exact, sum(totals.models) - totals.models.none),
      modelsApproximate: pct(totals.models.approximate, sum(totals.models) - totals.models.none),
      modelsMissing: pct(totals.models.missing, sum(totals.models) - totals.models.none),
      prefabsExact: pct(totals.prefabs.exact, sum(totals.prefabs) - totals.prefabs.none),
    },
    topReasons: top(totals.notes),
    topCustomShaders: top(totals.customShaders, 10),
    shaderFamilies: top(totals.shaders, 20),
    materialSources: top(totals.sources, 20),
    fbxVersions: top(totals.fbxVersions, 20),
    fbx6: totals.fbx6,
    worstPackages: packages
      .map((p) => ({ name: p.name, approximate: (p.models.approximate || 0) + (p.prefabs.approximate || 0), missing: (p.models.missing || 0) + (p.prefabs.missing || 0) }))
      .filter((p) => p.missing + p.approximate > 0)
      .sort((a, b) => b.missing - a.missing || b.approximate - a.approximate)
      .slice(0, 15),
  };

  const stamp = summary.generatedAt.slice(0, 10);
  fs.writeFileSync(path.join(reportDir, `fidelity-${stamp}.json`), JSON.stringify({ summary, packages }, null, 1));
  fs.writeFileSync(path.join(reportDir, 'fidelity-latest.json'), JSON.stringify(summary, null, 1));
  fs.writeFileSync(path.join(reportDir, 'fidelity-latest.md'), markdown(summary));
  return summary;
}

function markdown(s) {
  const rows = (pairs) => pairs.map(([k, v]) => `| ${k} | ${v} |`).join('\n');
  return `# 3D fidelity report — ${s.generatedAt.slice(0, 16).replace('T', ' ')} UTC

${s.packages} packages scanned, ${s.packagesWithModels} with models or prefabs (up to
${s.sampling.maxModelsPerPackage} models and ${s.sampling.maxPrefabsPerPackage} prefabs each), ${s.seconds}s.

| | exact | approximate | missing | no geometry | errors | total |
|---|---|---|---|---|---|---|
| models | ${s.models.exact} | ${s.models.approximate} | ${s.models.missing} | ${s.models.none} | ${s.models.error} | ${s.models.total} |
| prefabs | ${s.prefabs.exact} | ${s.prefabs.approximate} | ${s.prefabs.missing} | ${s.prefabs.none} | ${s.prefabs.error} | ${s.prefabs.total} |

Models with geometry: **${s.percent.modelsExact}% exact**, ${s.percent.modelsApproximate}% approximate,
${s.percent.modelsMissing}% missing. Prefabs: ${s.percent.prefabsExact}% exact.

## Why results are approximate or missing

| reason | count |
|---|---|
${rows(s.topReasons)}

## Custom shaders seen most (candidates for exact translations)

| shader | materials |
|---|---|
${rows(s.topCustomShaders)}

## Where materials came from (per rendered part)

| source | parts |
|---|---|
${rows(s.materialSources)}

## FBX versions (sampled model files)

| version | files |
|---|---|
${rows(s.fbxVersions)}

FBX 6.x: ${s.fbx6.files} files, ${s.fbx6.converted} converted, ${s.fbx6.failed} failed.

## Packages with the most approximate/missing results

| package | approximate | missing |
|---|---|---|
${s.worstPackages.map((p) => `| ${p.name} | ${p.approximate} | ${p.missing} |`).join('\n')}
`;
}

module.exports = { run, markdown };

if (require.main === module) {
  const args = process.argv.slice(2);
  const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
  run({
    data: arg('--data', '/data'),
    maxModels: Number(arg('--max-models', 60)),
    maxPrefabs: Number(arg('--max-prefabs', 30)),
    progress: (n, total, name) => { if (n % 25 === 0) console.log(`[report] ${n}/${total} ${name}`); },
  }).then((s) => {
    console.log(JSON.stringify({ models: s.models, prefabs: s.prefabs, percent: s.percent, fbx6: s.fbx6, seconds: s.seconds }));
  }).catch((err) => { console.error(err); process.exit(1); });
}
