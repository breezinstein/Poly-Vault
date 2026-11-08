'use strict';

// Replaces Electron's preload bridge (src/preload.js) in the web build.
// ui/renderer.js only touches five methods; every other call already goes
// through fetch() against the loopback API, which is proxied same-origin here.
//
// It also adds the one piece of UI that only makes sense for a shared server:
// a Settings panel with the Unity connection instructions and the add-on
// download. Keeping it here avoids patching the upstream renderer further.
(function () {
  const json = (res) => res.json().then((data) => {
    if (!res.ok && data && data.ok === undefined) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  });

  window.assetVault = {
    // Used by renderer init() to build state.serverUrl. Returning the page
    // origin keeps everything same-origin, so HTTPS proxies and subpaths work.
    getServerInfo: async () => ({ origin: window.location.origin }),

    getState: () => fetch('/api/web/state', { credentials: 'same-origin' }).then(json),

    // No native folder dialog in a browser: libraries are provisioned by the
    // operator (mounted volume) and added through the admin endpoint.
    addLibrary: () => fetch('/api/web/libraries', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: prompt('Absolute server path under the mounted library root:') || '' }),
    }).then(json),

    removeLibrary: (id) => fetch('/api/web/libraries', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).then(json),

    // "Open folder in Explorer" has no browser equivalent; the same button
    // downloads the asset folder as a zip instead (the renderer labels it from
    // folderActionLabel below).
    folderActionLabel: 'Download',

    // Resized WebP served by the server's thumbnail cache (sharp), keyed by
    // file mtime so a changed preview busts automatically.
    thumbUrl: (previewPath, width) =>
      `/api/thumb?path=${encodeURIComponent(previewPath)}&w=${Number(width) || 320}`,

    openInExplorer: async (targetPath) => {
      if (!targetPath) return { ok: false, error: 'no path' };
      const url = `/api/download?path=${encodeURIComponent(targetPath)}`;
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return { ok: true };
    },

    fetchUnityDescription: () => Promise.resolve(null),
  };

  // -------------------------------------------------------------------------
  // Settings panel (server URL, token, Unity setup, add-on download)
  // -------------------------------------------------------------------------

  const CSS = `
  .pv-settings-btn { position: relative; }
  .pv-modal {
    position: fixed; inset: 0; z-index: 9000; display: flex;
    align-items: center; justify-content: center;
    background: rgba(0,0,0,.55); backdrop-filter: blur(2px);
  }
  .pv-modal[hidden] { display: none; }
  .pv-sheet {
    width: min(720px, calc(100vw - 48px)); max-height: calc(100vh - 80px);
    overflow: auto; background: var(--panel, #23242a); color: var(--text, #e8e6e1);
    border: 1px solid var(--border, #3a3c44); border-radius: 14px;
    box-shadow: 0 24px 60px rgba(0,0,0,.5); padding: 22px 24px 18px;
    font: 13px/1.55 system-ui, sans-serif;
  }
  .pv-sheet h2 { margin: 0 0 4px; font-size: 17px; }
  .pv-sheet h3 {
    margin: 20px 0 8px; font-size: 12px; letter-spacing: .07em;
    text-transform: uppercase; opacity: .6;
  }
  .pv-sheet p { margin: 6px 0; }
  .pv-sheet code, .pv-sheet .pv-mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  }
  .pv-close {
    float: right; border: 0; background: transparent; color: inherit;
    font-size: 20px; line-height: 1; cursor: pointer; opacity: .6; padding: 2px 4px;
  }
  .pv-close:hover { opacity: 1; }
  .pv-field {
    display: flex; gap: 8px; align-items: center; margin: 6px 0;
    background: var(--bg, #1e1f24); border: 1px solid var(--border, #3a3c44);
    border-radius: 8px; padding: 6px 8px;
  }
  .pv-field label { flex: 0 0 108px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; opacity: .6; }
  .pv-field input, .pv-field .pv-value {
    flex: 1 1 auto; background: transparent; border: 0; color: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
    min-width: 0; outline: none;
  }
  .pv-btn {
    border: 1px solid var(--border, #3a3c44); background: transparent; color: inherit;
    border-radius: 7px; padding: 4px 10px; font-size: 12px; cursor: pointer; white-space: nowrap;
  }
  .pv-btn:hover { border-color: var(--accent, #c8734a); }
  .pv-btn.pv-primary { background: var(--accent, #c8734a); border-color: transparent; color: #1b1c21; font-weight: 600; }
  .pv-steps { margin: 8px 0 0; padding-left: 20px; }
  .pv-steps li { margin: 6px 0; }
  .pv-hint { opacity: .65; font-size: 12px; }
  .pv-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 12px; }
  .pv-kbd { border: 1px solid var(--border, #3a3c44); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; font-size: 11px; }
  .pv-sheet a { color: var(--accent, #c8734a); }
  `;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function copyButton(text, label) {
    const btn = el('button', 'pv-btn', label || 'Copy');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch (_) {
        const ta = el('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (__) { /* ignore */ }
        ta.remove();
      }
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = label || 'Copy'; }, 1400);
    });
    return btn;
  }

  async function openSettings() {
    if (document.querySelector('.pv-modal')) return;

    let session = {};
    let health = {};
    try {
      session = await fetch('/api/web/session', { credentials: 'same-origin' }).then(json);
    } catch (_) { session = {}; }
    try {
      health = await fetch('/healthz', { credentials: 'same-origin' }).then(json);
    } catch (_) { health = {}; }

    const serverUrl = session.serverUrl || window.location.origin;
    const token = session.token || '';

    const overlay = el('div', 'pv-modal');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Poly Vault settings');

    const sheet = el('div', 'pv-sheet');
    const close = el('button', 'pv-close', '\u00D7');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close settings');
    close.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onEsc); }
    });
    sheet.appendChild(close);

    sheet.appendChild(el('h2', '', 'Poly Vault settings'));
    sheet.appendChild(el('p', 'pv-hint',
      `Signed in as ${session.user || 'unknown'} \u00B7 server ${session.version || ''} \u00B7 ${(health.libraries || []).length} librar${(health.libraries || []).length === 1 ? 'y' : 'ies'}`));

    // ---- Unity ------------------------------------------------------------
    sheet.appendChild(el('h3', '', 'Connect Unity'));
    const plugin = session.plugin;
    if (plugin && (plugin.zip || plugin.tgz)) {
      const row = el('div', 'pv-row');
      if (plugin.zip) {
        const dl = el('a', 'pv-btn pv-primary', `Download Poly Vault for Unity ${plugin.version} (.zip)`);
        dl.href = plugin.zip.url;
        dl.setAttribute('download', plugin.zip.name || '');
        row.appendChild(dl);
      }
      if (plugin.tgz) {
        const tgz = el('a', 'pv-btn', 'unsigned .tgz (may be refused)');
        tgz.href = plugin.tgz.url;
        tgz.setAttribute('download', plugin.tgz.name || '');
        tgz.title = 'Unity 6 refuses unsigned tarballs unless package signature '
          + 'verification is relaxed. Prefer the .zip.';
        row.appendChild(tgz);
      }
      row.appendChild(el('span', 'pv-hint',
        `${Math.round(((plugin.zip || plugin.tgz).bytes || 0) / 1024)} KB \u00B7 built from this server's source`));
      sheet.appendChild(row);
      sheet.appendChild(el('p', 'pv-hint',
        'Windows may warn that the download came from the internet: right-click it \u2192 Properties \u2192 '
        + 'tick "Unblock". The .zip route is the reliable one \u2014 extract it and pick package.json with '
        + '"Add package from disk\u2026".'));
      sheet.appendChild(el('p', 'pv-hint',
        'Unity 6 refuses unsigned tarballs ("This package is missing a signature") unless you relax '
        + 'package signature verification, so prefer the .zip or drop the extracted folder into '
        + 'Packages/com.polyvault.bridge in your project.'));
    } else {
      sheet.appendChild(el('p', 'pv-hint', 'No Unity package is bundled with this server image.'));
    }

    const steps = el('ol', 'pv-steps');
    const li = (parts) => {
      const node = el('li');
      for (const part of parts) node.appendChild(part);
      steps.appendChild(node);
      return node;
    };
    li([
      document.createTextNode('In Unity 6: Window \u2192 Package Manager \u2192 + \u2192 '),
      el('strong', '', 'Add package from disk\u2026'),
      document.createTextNode(' \u2192 extract the downloaded .zip and pick package.json (recommended).'),
    ]);
    li([
      document.createTextNode('Alternative: copy the extracted folder to '),
      el('code', '', 'Packages/com.polyvault.bridge'),
      document.createTextNode(' (embedded package \u2014 no tarball, no signature check).'),
    ]);
    li([document.createTextNode('Open Window \u2192 Poly Vault \u2192 Poly Vault.')]);
    li([
      document.createTextNode('Set '),
      el('strong', '', 'Server URL'),
      document.createTextNode(' and '),
      el('strong', '', 'Access token'),
      document.createTextNode(' from the fields below.'),
    ]);
    li([document.createTextNode('Click "Import to Unity" on any asset here \u2014 it appears in the editor within a few seconds.')]);
    sheet.appendChild(steps);

    // ---- Connection -------------------------------------------------------
    sheet.appendChild(el('h3', '', 'Connection'));

    const urlField = el('div', 'pv-field');
    urlField.appendChild(el('label', '', 'Server URL'));
    const urlInput = el('input');
    urlInput.value = serverUrl;
    urlInput.readOnly = true;
    urlInput.spellcheck = false;
    urlField.appendChild(urlInput);
    urlField.appendChild(copyButton(serverUrl));
    sheet.appendChild(urlField);

    const tokenField = el('div', 'pv-field');
    tokenField.appendChild(el('label', '', 'Access token'));
    const tokenInput = el('input');
    tokenInput.type = 'password';
    tokenInput.value = token || 'hidden';
    tokenInput.readOnly = true;
    tokenInput.spellcheck = false;
    tokenField.appendChild(tokenInput);
    if (token) {
      const reveal = el('button', 'pv-btn', 'Show');
      reveal.type = 'button';
      reveal.addEventListener('click', () => {
        const hidden = tokenInput.type === 'password';
        tokenInput.type = hidden ? 'text' : 'password';
        reveal.textContent = hidden ? 'Hide' : 'Show';
      });
      tokenField.appendChild(reveal);
      tokenField.appendChild(copyButton(token));
    }
    sheet.appendChild(tokenField);
    if (!token) {
      sheet.appendChild(el('p', 'pv-hint', session.tokenHidden
        ? 'The token is hidden by this server (PV_SHOW_TOKEN=0). Ask an administrator for it.'
        : 'This deployment uses proxy authentication \u2014 use your normal team sign-in in Unity.'));
    }

    // ---- About ------------------------------------------------------------
    sheet.appendChild(el('h3', '', 'This server'));
    const libs = (health.libraries || []).map((l) => l.name + (l.missing ? ' (missing)' : ''));
    sheet.appendChild(el('p', '', `Libraries: ${libs.length ? libs.join(', ') : 'none'}`));
    if (health.thumbs) sheet.appendChild(el('p', '', `Thumbnails: ${health.thumbs.generated} generated, ${health.thumbs.hits} cache hits`));
    if (health.packages && health.packages.enabled !== false) {
      sheet.appendChild(el('p', '',
        `Package index: ${health.packages.cachedPackages || 0} packages, `
        + `${health.packages.cachedPreviews || 0} with a preview extracted from the archive`));
    }
    sheet.appendChild(el('p', 'pv-hint',
      'Tags, descriptions and import jobs live on the server; your asset files are never modified.'));

    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
    close.focus();
  }

  function addSettingsButton() {
    const actions = document.querySelector('.toolbar-actions');
    if (!actions || document.querySelector('.pv-settings-btn')) return;
    const btn = el('button', 'toolbar-btn pv-settings-btn', 'Settings');
    btn.type = 'button';
    btn.title = 'Connection details, Unity setup and add-on download';
    btn.addEventListener('click', openSettings);
    const anchor = actions.querySelector('.theme-select');
    if (anchor) actions.insertBefore(btn, anchor);
    else actions.appendChild(btn);

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  document.addEventListener('DOMContentLoaded', addSettingsButton);
}());
