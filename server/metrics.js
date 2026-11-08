'use strict';

// Tiny Prometheus-style counter registry (no dependencies).
//
// Names carry their labels inline, e.g. "pv_api_errors_total{status=\"500\"}",
// which keeps this module tiny and avoids a client library.

const counters = new Map();

function counter(name, by = 1) {
  counters.set(name, (counters.get(name) || 0) + by);
}

function gauge(name, value) {
  counters.set(name, value);
}

function render(extraGauges = {}) {
  const lines = [];
  const names = [...new Set([...counters.keys(), ...Object.keys(extraGauges)])].sort();
  const emittedTypes = new Set();
  for (const name of names) {
    const base = name.split('{')[0];
    if (!emittedTypes.has(base)) {
      emittedTypes.add(base);
      const type = base.endsWith('_total') ? 'counter' : 'gauge';
      lines.push(`# TYPE ${base} ${type}`);
    }
    const value = extraGauges[name] !== undefined ? extraGauges[name] : counters.get(name);
    lines.push(`${name} ${Number(value) || 0}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { counter, gauge, render, counters };
