// Poly Vault <-> Mesh2Motion bridge.
//
// Injected into every Mesh2Motion page served at /rig/ (scripts/m2m-rebase.sh).
// It adds the two things the vault needs without touching Mesh2Motion's source:
//
//   1. Load a model handed over by the vault, through the page's own file
//      input — exactly the path a manual upload takes:
//        ?pv=handoff&id=…   the opener (vault viewer) posts a GLB ArrayBuffer
//        ?pv=url&model=…    fetch a same-origin URL (a file in the vault)
//
//   2. "Save to vault": arms Mesh2Motion's own export, catches the file it
//      would download, and uploads it to POST /api/web/rigged instead.
//
// Same origin only: messages and URLs from anywhere else are ignored.
(() => {
  'use strict';

  const ORIGIN = location.origin;
  const params = new URLSearchParams(location.search);
  const page = /\/retarget\//.test(location.pathname) ? 'retarget' : /create(\.html)?$/.test(location.pathname) ? 'create' : 'other';
  const SOURCE_KEY = 'pv-rig-source';
  const PREVIEW_KEY = 'pv-rig-preview';

  // --- small UI helpers --------------------------------------------------------

  const css = document.createElement('style');
  css.textContent = `
    .pv-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 99999;
      background: #1e1f24; color: #fff7ef; border: 1px solid rgba(255,255,255,.18); border-radius: 10px;
      padding: 10px 14px; font: 14px/1.4 system-ui, sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.35); max-width: min(560px, 92vw); }
    .pv-toast a { color: #fcb72c; }
    .pv-toast.pv-bad { border-color: #ff453a; }
    .pv-banner { position: fixed; top: 52px; left: 12px; z-index: 9999; background: rgba(30,20,26,.9); color: #fff7ef;
      border: 1px solid rgba(255,255,255,.14); border-radius: 8px; padding: 6px 10px; font: 13px/1.3 system-ui, sans-serif; }
    .pv-banner a { color: #fcb72c; text-decoration: none; }
    .pv-save-btn { margin-top: 8px; width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid #f8762d;
      background: #f8762d; color: #fff; font: 600 14px system-ui, sans-serif; cursor: pointer; }
    .pv-save-btn[disabled] { opacity: .6; cursor: progress; }
  `;
  document.head.appendChild(css);

  let toastTimer = 0;
  function toast(html, bad = false, ms = 7000) {
    let el = document.querySelector('.pv-toast');
    if (!el) { el = document.createElement('div'); el.className = 'pv-toast'; document.body.appendChild(el); }
    el.classList.toggle('pv-bad', bad);
    el.innerHTML = html;
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => el.remove(), ms);
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function source() {
    try { return JSON.parse(sessionStorage.getItem(SOURCE_KEY) || 'null'); } catch (_) { return null; }
  }
  function remember(src, preview) {
    try {
      sessionStorage.setItem(SOURCE_KEY, JSON.stringify(src || {}));
      if (preview) sessionStorage.setItem(PREVIEW_KEY, preview);
    } catch (_) { /* storage full or blocked: provenance is optional */ }
  }

  function banner(src) {
    if (!src || !src.name) return;
    const b = document.createElement('div');
    b.className = 'pv-banner';
    b.innerHTML = `From Poly Vault: <strong>${esc(src.name)}</strong> · <a href="/">back to the vault</a>`;
    document.body.appendChild(b);
  }

  const waitFor = (selector, timeoutMs = 15000) => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      if (Date.now() - started > timeoutMs) return reject(new Error(`${selector} not found`));
      setTimeout(tick, 100);
    };
    tick();
  });

  // --- 1. inbound model ------------------------------------------------------------

  // This classic script runs before Mesh2Motion's deferred module scripts, so
  // the file input exists long before anything listens to it. Wait for the
  // page to finish loading and the app to create its WebGL canvas.
  const appReady = () => new Promise((resolve) => {
    const afterLoad = () => waitFor('canvas', 30000).catch(() => null).then(() => setTimeout(resolve, 400));
    if (document.readyState === 'complete') afterLoad(); else window.addEventListener('load', afterLoad, { once: true });
  });

  async function inject(buffer, name) {
    await appReady();
    const input = await waitFor(page === 'retarget' ? '#upload-file' : '#model-upload');
    const file = new File([buffer], name || 'model.glb', { type: 'application/octet-stream' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  if (page !== 'other') {
    const mode = params.get('pv');
    if (mode === 'handoff' && window.opener) {
      window.addEventListener('message', (event) => {
        if (event.origin !== ORIGIN || event.source !== window.opener) return;
        const data = event.data || {};
        if (data.type !== 'pv-handoff' || !(data.buffer instanceof ArrayBuffer)) return;
        remember(data.source, data.preview);
        banner(data.source);
        inject(data.buffer, data.name).catch((err) => toast(`Could not load the model: ${esc(err.message)}`, true));
      });
      window.opener.postMessage({ type: 'pv-handoff-ready', id: params.get('id') || '' }, ORIGIN);
    } else if (mode === 'url' && params.get('model')) {
      let url;
      try { url = new URL(params.get('model'), ORIGIN); } catch (_) { url = null; }
      if (url && url.origin === ORIGIN) {
        const src = { name: params.get('name') || url.pathname.split('/').pop(), path: params.get('src') || '', entry: params.get('entry') || '' };
        remember(src);
        banner(src);
        fetch(url, { credentials: 'same-origin' })
          .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
          .then((buf) => inject(buf, src.name))
          .catch((err) => toast(`Could not load the model: ${esc(err.message)}`, true));
      }
    } else {
      sessionStorage.removeItem(SOURCE_KEY);
      sessionStorage.removeItem(PREVIEW_KEY);
    }
  }

  // --- 2. save to vault ------------------------------------------------------------

  let armed = 0;          // timestamp while an export should go to the vault
  let saving = false;

  async function upload(href, filename) {
    saving = true;
    const btn = document.querySelector('.pv-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving to vault…'; }
    try {
      const blob = await fetch(href).then((r) => r.blob());
      const ext = (filename.split('.').pop() || '').toLowerCase();
      if (!['fbx', 'glb'].includes(ext)) throw new Error(`.${ext} exports cannot be stored in the vault (use FBX or GLB)`);
      const src = source() || {};
      const q = new URLSearchParams({ name: filename, kind: page, src: src.path || '', entry: src.entry || '', from: src.name || '' });
      const res = await fetch(`/api/web/rigged?${q}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const preview = sessionStorage.getItem(PREVIEW_KEY);
      if (preview && preview.startsWith('data:image/')) {
        const bytes = await fetch(preview).then((r) => r.blob());
        await fetch(`/api/web/rigged/preview?${new URLSearchParams({ folder: json.folder })}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': bytes.type }, body: bytes }).catch(() => {});
      }
      toast(`Saved to the vault: <strong>Rigged / ${esc(json.folder)}</strong> · <a href="/">open Poly Vault</a>`);
    } catch (err) {
      toast(`Not saved: ${esc(err.message)}`, true, 10000);
    } finally {
      saving = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Save to vault'; }
    }
  }

  // Mesh2Motion downloads by clicking a hidden <a download href="blob:…">.
  document.addEventListener('click', (event) => {
    if (!armed || Date.now() - armed > 180000) { armed = 0; return; }
    const a = event.target && event.target.closest ? event.target.closest('a[download]') : null;
    if (!a || !a.href.startsWith('blob:')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    armed = 0;
    upload(a.href, a.download || 'rigged.fbx');
  }, true);

  function addSaveButton(exportButton) {
    if (!exportButton || exportButton.parentElement.querySelector('.pv-save-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pv-save-btn';
    btn.textContent = 'Save to vault';
    btn.title = 'Export with the settings above and store the result in Poly Vault (Rigged library)';
    btn.addEventListener('click', () => {
      if (saving) return;
      armed = Date.now();
      exportButton.click();
      toast('Exporting…', false, 4000);
    });
    exportButton.insertAdjacentElement('afterend', btn);
  }

  // Unity imports FBX natively: when the page came from the vault, start there.
  function preferFbx() {
    const fbx = document.querySelector('#export-format-fbx');
    if (fbx && !fbx.checked && source()) { fbx.checked = true; fbx.dispatchEvent(new Event('change', { bubbles: true })); }
    const unity = document.querySelector('#fbx-preset-unity');
    if (unity && !unity.checked && source()) { unity.checked = true; unity.dispatchEvent(new Event('change', { bubbles: true })); }
  }

  const observer = new MutationObserver(() => {
    for (const id of ['#export-button', '#export-retargeting-button']) {
      const b = document.querySelector(id);
      if (b) { addSaveButton(b); preferFbx(); }
    }
  });
  const startObserving = () => observer.observe(document.body, { childList: true, subtree: true });
  if (document.body) startObserving(); else document.addEventListener('DOMContentLoaded', startObserving);
})();
