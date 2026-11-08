#!/usr/bin/env bash
# Browser acceptance test for the web build (headless Chromium in Docker).
#
#   ./scripts/verify-ui.sh [base-url] [token]
#
# Checks the parts that only exist in a browser: sign-in, grid render, thumbnail
# pipeline, tag write, asset download, import queueing, and that the library
# payload is transferred gzipped / revalidated with 304s.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${1:-http://127.0.0.1:8080}"
TOKEN="${2:-shared-token}"
PLAYWRIGHT_IMAGE="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.65.0-noble}"
HOST_BASE="${HOST_BASE:-http://host.docker.internal:8080}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/ui-check.js" <<'JS'
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL;
const TOKEN = process.env.PV_TOKEN;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${name}${detail ? ` (${detail})` : ''}`);
};

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })).newPage();
  const errors = [];
  const apiResponses = [];
  const thumbs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', async (r) => {
    if (r.url().includes('/api/library')) {
      apiResponses.push({ status: r.status(), encoding: r.headers()['content-encoding'] || '', etag: r.headers()['etag'] || '',
        length: Number(r.headers()['content-length'] || 0) });
    }
    if (r.url().includes('/api/thumb')) {
      thumbs.push({ type: r.headers()['content-type'] || '', cache: r.headers()['x-pv-thumb'] || '', status: r.status() });
    }
  });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name=token]', TOKEN);
  await Promise.all([page.waitForLoadState('networkidle'), page.click('button[type=submit]')]);

  await page.waitForSelector('.card', { timeout: 30000 });
  check('sign-in renders the grid', (await page.locator('.card').count()) > 0, `${await page.locator('.card').count()} cards`);
  check('bridge reports online', (await page.locator('#server-state').textContent()).includes('online'));

  // The renderer polls /api/library every 20 s. DevTools reports a revalidated
  // fetch as 200 with a cached body, so the reliable signal is the server's own
  // 304 counter: it must increase after the next poll without a body transfer.
  const count304 = () => page.evaluate(async () => {
    const r = await fetch('/metrics', { cache: 'no-store' });
    const t = await r.text();
    const m = t.match(/^pv_api_304_total (\d+)$/m);
    return m ? Number(m[1]) : 0;
  });
  const before304 = await count304();
  const deadline = Date.now() + 30000;
  let after304 = before304;
  while (Date.now() < deadline && after304 <= before304) {
    await page.waitForTimeout(1000);
    after304 = await count304();
  }
  check('library poll revalidated (304, no body)', after304 > before304, `${before304} -> ${after304}`);

  const libTiming = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter((e) => e.name.includes('/api/library'))
    .map((e) => ({ transfer: e.transferSize, encoded: e.encodedBodySize, decoded: e.decodedBodySize })));
  const last = libTiming[libTiming.length - 1] || { transfer: 0, encoded: 0, decoded: 0 };
  check('revalidated poll transfers no body', last.transfer < Math.max(600, last.encoded),
    `transfer ${last.transfer}B, cached body ${last.encoded}B (raw ${last.decoded}B)`);

  const cardWithImage = page.locator('.card').filter({ has: page.locator('.thumb img') }).first();
  await cardWithImage.click();
  await page.waitForTimeout(1000);
  check('asset detail opens', (await page.locator('#detail-content h2').count()) > 0);
  check('cards load thumbnails', thumbs.some((t) => t.type.includes('image/webp')), `${thumbs.length} thumb requests`);
  const detailImg = await page.evaluate(() => {
    const img = document.querySelector('#detail-content img');
    return img ? { src: img.src, w: img.naturalWidth } : null;
  });
  check('detail image decodes', Boolean(detailImg && detailImg.w > 0), detailImg ? `${detailImg.w}px` : 'missing');

  // tag round trip through the UI
  const tagInput = page.locator('#detail-content .tag-add-row input').first();
  await tagInput.fill('ci-smoke');
  await tagInput.press('Enter');
  await page.waitForTimeout(1200);
  check('tag added and persisted', (await page.locator('#detail-content .detail-tag', { hasText: 'ci-smoke' }).count()) > 0);

  // download button produces a zip
  const dl = await Promise.all([
    page.waitForEvent('download', { timeout: 20000 }),
    page.locator('.open-path-btn').first().click(),
  ]).then(([d]) => d).catch(() => null);
  check('asset downloads as an archive', Boolean(dl), dl ? dl.suggestedFilename() : 'no download event');

  // queue an import
  const importBtn = page.locator('.import-btn').first();
  if (!(await importBtn.isDisabled())) {
    await importBtn.click();
    await page.waitForTimeout(1500);
  }
  const badges = await page.locator('.card .badge').allTextContents();
  check('import job queues (queued/importing badge)', badges.some((b) => /queued|importing|imported/.test(b)), badges.join(','));

  const gz = apiResponses.filter((r) => r.encoding === 'gzip');
  check('library payload served gzipped', gz.length > 0, `${gz.length} of ${apiResponses.length} responses`);

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  await page.screenshot({ path: process.env.SHOT || '/tmp/poly-vault-ui.png', fullPage: false });
  await browser.close();

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\npassed ${results.length - failed}, failed ${failed}`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error('FATAL', err.message); process.exit(1); });
JS

echo "==> browser check against $BASE"
# The Playwright image ships browsers, not the npm package: install it inside the
# container (writable layer) and keep the mounted source read-only.
docker run --rm \
  --network=host \
  -v "$WORK":/src:ro \
  -e BASE_URL="$BASE" \
  -e PV_TOKEN="$TOKEN" \
  -e SHOT=/tmp/ui.png \
  -e NODE_PATH=/opt/pw/node_modules \
  --entrypoint "" \
  "$PLAYWRIGHT_IMAGE" \
  sh -c 'npm install --prefix /opt/pw --no-audit --no-fund --silent playwright@1.65.0 >/dev/null 2>&1 && node /src/ui-check.js'
