import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
const lock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url)));

test('the reviewed runtime dependency pins are present throughout the installed lock graph', () => {
  const pins = { '@modelcontextprotocol/sdk': '1.32.0', '@hono/node-server': '2.1.3',
    'body-parser': '2.4.0', 'fast-uri': '3.1.9', hono: '4.13.11', 'ip-address': '10.7.4',
    'proxy-addr': '2.0.8', qs: '6.16.1', zod: '4.6.6' };
  assert.equal(packageJson.dependencies['@modelcontextprotocol/sdk'], pins['@modelcontextprotocol/sdk']);
  for (const [name, version] of Object.entries(pins)) {
    const packages = Object.entries(lock.packages).filter(([location]) =>
      location === `node_modules/${name}` || location.endsWith(`/node_modules/${name}`));
    assert.ok(packages.length, `${name} must be represented in the reviewed lockfile`);
    for (const [location, metadata] of packages) {
      assert.equal(metadata.version, version, `${location} must not retain an older vulnerable copy`);
      assert.match(metadata.integrity, /^sha512-/);
    }
  }
});
