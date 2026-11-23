#!/usr/bin/env bash
# Browser acceptance test for models with Unity materials, prefabs, FBX 6 and
# the Mesh2Motion hand-off (headless Chromium in Docker, throwaway container).
#
#   ./scripts/verify-3d.sh [image]       (default: poly-vault:0.4.2-web)
#
# Generates a fixture package (scripts/make-3d-fixture.js), starts the image on
# :18083 with it, and checks, in a real browser with WebGL:
#   - the FBX 7 crate renders textured and "Matches Unity" (remap -> Standard)
#   - the prefab assembles two crates, textured, exact
#   - the FBX 6 box is converted and shows its TGA texture
#   - "Rig in Mesh2Motion" opens Create with the model loaded
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${1:-poly-vault:0.4.2-web}"
PORT="${PORT:-18083}"
NAME="pv-verify-3d"
BASE="http://127.0.0.1:${PORT}"
PLAYWRIGHT_IMAGE="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.65.0-noble}"
WORK="$(mktemp -d)"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm "${NAME}-data" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

docker build -q --target deps -t poly-vault:ci-deps . >/dev/null
docker run --rm --user "$(id -u):$(id -g)" -e NODE_PATH=/app/node_modules -v "$PWD":/w:ro -v "$WORK":/out -w /w poly-vault:ci-deps \
  node scripts/make-3d-fixture.js /out/assets >/dev/null
chmod -R a+rX "$WORK"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --init --read-only --tmpfs /tmp -p "127.0.0.1:${PORT}:8080" \
  -e PV_TOKEN=verify-token -e ASSETVAULT_NO_ENRICH=1 \
  -v "${NAME}-data":/data -v "$WORK/assets":/assets:ro "$IMAGE" >/dev/null
for _ in $(seq 1 30); do curl -fsS "$BASE/healthz" 2>/dev/null | grep -q '"ok":true' && break; sleep 1; done

cat > "$WORK/check.js" <<'JS'
const { chromium } = require('playwright');
const BASE = process.env.BASE;
const PKG = '/assets/Fixture Publisher/3D ModelsProps/Crate Kit.unitypackage';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${detail ? ` (${detail})` : ''}`);
};
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await ctx.addCookies([{ name: 'pv_session', value: 'verify-token', url: BASE }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });

  const render = (entry) => page.evaluate(async ({ path, entry }) => {
    document.querySelector('#probe')?.remove();
    const box = document.createElement('div'); box.id = 'probe'; box.className = 'entry-webgl'; box.style.width = '600px';
    document.body.prepend(box);
    const mod = await import('/webgl/viewer.js');
    const v = await mod.mountUnity(box, { path, entry, name: entry.split('/').pop() });
    window.__v = v;
    await new Promise((r) => setTimeout(r, 2500));
    const c = v.canvas; const t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
    const g = t.getContext('2d'); g.drawImage(c, 0, 0);
    const d = g.getImageData(0, 0, t.width, t.height).data;
    let lit = 0, warm = 0, cool = 0, green = 0;
    for (let p = 0; p < d.length; p += 16) {
      if (d[p + 3] < 10) continue; lit += 1;
      if (d[p] > d[p + 2] + 40 && d[p] > 90) warm += 1;
      if (d[p + 2] > d[p] + 40) cool += 1;
      if (d[p + 1] > d[p] + 20 && d[p + 1] > d[p + 2] + 20) green += 1;
    }
    const meshes = []; v.object.traverse((n) => { if (n.isMesh) meshes.push(n.name); });
    return { fidelity: v.manifest.fidelity, kind: v.manifest.kind || 'model', meshes: meshes.length, lit, warm, cool, green, converted: v.manifest.model.converted || '' };
  }, { path: PKG, entry });

  // The link map builds in the background on first start.
  let crate;
  for (let i = 0; i < 20; i += 1) {
    try { crate = await render('Assets/Crate/Models/Crate.fbx'); break; } catch (e) { await page.waitForTimeout(1500); }
  }
  check('FBX 7 crate renders', crate && crate.lit > 200, crate && `${crate.lit} lit samples`);
  check('crate shows its checker texture (orange + blue)', crate && crate.warm > 20 && crate.cool > 20, crate && `warm ${crate.warm}, cool ${crate.cool}`);
  check('crate "Matches Unity" (remap -> Standard)', crate && crate.fidelity === 'exact', crate && crate.fidelity);

  const stack = await render('Assets/Crate/Prefabs/CrateStack.prefab');
  check('prefab assembles two crates', stack.kind === 'prefab' && stack.meshes === 2, `${stack.meshes} meshes`);
  check('prefab textured and exact', stack.warm > 20 && stack.fidelity === 'exact', `${stack.fidelity}, warm ${stack.warm}`);

  const old = await render('Assets/Crate/Models/OldBox.fbx');
  check('FBX 6 box converted', /FBX 6/.test(old.converted), old.converted);
  check('FBX 6 box shows its TGA texture', old.green > 20, `green ${old.green}`);

  await render('Assets/Crate/Models/Crate.fbx');
  const [m2m] = await Promise.all([ctx.waitForEvent('page', { timeout: 30000 }), page.click('#probe .pv3d-rig')]);
  await m2m.waitForSelector('.pv-banner', { timeout: 60000 }).catch(() => {});
  await m2m.waitForTimeout(6000);
  const st = await m2m.evaluate(() => ({ banner: document.querySelector('.pv-banner')?.textContent || '', save: !!document.querySelector('.pv-save-btn'), step: !!document.querySelector('#model-selection, select') }));
  check('Mesh2Motion Create opens with the model', /Crate/.test(st.banner) && st.step, st.banner);
  check('Mesh2Motion has "Save to vault"', st.save);
  check('no page errors in the vault', errors.length === 0, errors.slice(0, 2).join(' | '));

  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\npassed ${results.length - failed}, failed ${failed}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
JS

echo "==> 3D checks against $BASE"
docker run --rm --network=host \
  -e BASE_URL="$BASE" -e BASE="$BASE" \
  -v "$WORK":/src:ro -v pw-cache:/opt/pw \
  "$PLAYWRIGHT_IMAGE" \
  sh -c '[ -d /opt/pw/node_modules/playwright ] || npm install --prefix /opt/pw --no-audit --no-fund --silent playwright@1.65.0 >/dev/null 2>&1; NODE_PATH=/opt/pw/node_modules node /src/check.js'
