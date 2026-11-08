'use strict';

// Append-only audit trail for a shared deployment: who tagged / described /
// queued / downloaded what. One JSON object per line in
// `${PV_DATA_DIR}/audit.jsonl`, rotated at ~5 MB (one generation kept).
//
// Deliberately does not log tokens, cookies or request bodies wholesale.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 5 * 1024 * 1024;

function createAudit(dir, log = console) {
  const file = path.join(dir, 'audit.jsonl');
  let size = 0;
  try { size = fs.statSync(file).size; } catch (_) { size = 0; }

  function rotateIfNeeded() {
    if (size < MAX_BYTES) return;
    try {
      fs.renameSync(file, `${file}.1`);
    } catch (_) { /* ignore */ }
    size = 0;
  }

  return function audit(event, fields = {}) {
    const entry = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
    try {
      rotateIfNeeded();
      fs.appendFileSync(file, `${entry}\n`, 'utf8');
      size += Buffer.byteLength(entry) + 1;
    } catch (err) {
      log.warn(`[poly-vault] audit write failed: ${err.message}`);
    }
  };
}

module.exports = { createAudit };
