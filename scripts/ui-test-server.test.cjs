'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');

test('a missing UI asset returns 404 without breaking subsequent static requests', async t => {
  let handler;
  const fixtureModule = { exports: {} };
  // Capture the real handler without claiming the browser fixture's fixed port.
  const fixtureRequire = name => name === 'node:http' ? {
    createServer(callback) { handler = callback; return { listen() {} }; },
  } : require(name);
  fixtureRequire.main = fixtureModule;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../tests/server.cjs'), 'utf8'), {
    require: fixtureRequire, module: fixtureModule, URL, __dirname: path.join(__dirname, '../tests'),
  }, { filename: 'tests/server.cjs', timeout: 1000 });
  assert.equal(typeof handler, 'function');
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const missing = await fetch(`${base}/__missing_fixture_asset__.ico`, { signal: AbortSignal.timeout(2000) });
  assert.equal(missing.status, 404);
  await missing.arrayBuffer();
  const index = await fetch(base, { signal: AbortSignal.timeout(2000) });
  assert.equal(index.status, 200);
  assert.equal(await index.text(), fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8'));
  const outside = await fetch(`${base}/%2e%2e%2fpackage.json`, { signal: AbortSignal.timeout(2000) });
  assert.equal(outside.status, 404);
  await outside.arrayBuffer();
});
