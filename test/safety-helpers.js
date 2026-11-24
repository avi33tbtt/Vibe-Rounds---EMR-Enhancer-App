'use strict';
// Shared helpers for the safety-test pack (chunk 05).
const { createApp } = require('../app');

const ROLES = ['admin', 'doctor', 'nurse', 'viewer', 'informatician'];

// Every route the app really registers, as 'METHOD /path', read from Express itself,
// so a route added later cannot hide from the safety tests.
function listRoutes(pool) {
  const app = createApp(pool, { quiet: true });
  const out = [];
  for (const layer of app.router.stack) {
    if (layer.handle && layer.handle.stack) {
      throw new Error('A nested router was mounted. Extend listRoutes() in test/safety-helpers.js so its routes are checked too.');
    }
    if (!layer.route) continue;
    for (const p of [].concat(layer.route.path)) {
      for (const m of Object.keys(layer.route.methods)) out.push(`${m.toUpperCase()} ${p}`);
    }
  }
  return out.sort();
}

const isWrite = key => !['GET', 'HEAD', 'OPTIONS'].includes(key.split(' ')[0]);
const fill = (path, id = 1) => path.replace(/:id\b/g, String(id)).replace(/:version\b/g, '1').replace(/:file\b/g, '00-boot.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { ROLES, listRoutes, isWrite, fill, sleep };
