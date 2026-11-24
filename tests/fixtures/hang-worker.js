'use strict';
// Stand-in for server/modelWorker.js in tests/server-hardening.test.js: a file
// whose name contains "hang" spins forever (like a parser stuck in a loop);
// anything else is answered at once.
const { parentPort } = require('worker_threads');

parentPort.on('message', (msg) => {
  if (/hang/.test(msg.file)) for (;;) { /* stuck */ }
  parentPort.postMessage({ id: msg.id, ok: true, file: msg.file });
});
