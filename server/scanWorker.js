'use strict';

// Runs the (synchronous, blocking) library scanner on a worker thread.
//
// Scanning Unity's Asset Store cache over NFS means ~1,600 stat() round trips:
// measured at 8–11 s cold. Doing that on the main thread freezes every request
// (and the UI) for the duration. The scan itself has no I/O overlap to exploit,
// so a worker thread is the cheapest way to keep the HTTP server responsive.
//
// Protocol:
//   in : { id, lib, tags: {absPath: string[]}, meta: {absPath: {description}} }
//   out: { id, ok: true, data } | { id, ok: false, error }

const { parentPort } = require('worker_threads');
const path = require('path');
const { scanLibrary } = require('../src/main/library');

parentPort.on('message', (msg) => {
  const { id, lib, tags, meta } = msg;
  try {
    const data = scanLibrary(lib, {
      getTags: (p) => {
        const v = tags[path.resolve(p)];
        return Array.isArray(v) ? v : [];
      },
      getMeta: (p) => {
        const e = meta[path.resolve(p)];
        return e && e.description ? e.description : '';
      },
    });
    parentPort.postMessage({ id, ok: true, data });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String((err && err.stack) || err) });
  }
});
