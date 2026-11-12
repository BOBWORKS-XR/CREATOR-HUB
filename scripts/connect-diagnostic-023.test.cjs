'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { captureConnect, reportConnect } = require('./connect-diagnostic-023.cjs');

function request(url, rawHeaders = ['Host', url], headers = {}) {
  return { url, rawHeaders, headers };
}

test('lazy initialization and reports are detached snapshots', () => {
  const state = { unrelated: true };
  assert.deepEqual(reportConnect(state), []);
  captureConnect(state, request('api.github.com:443'), Buffer.alloc(0));
  const rows = reportConnect(state);
  assert.deepEqual(rows, [{ authority: 'api.github.com:443', headPresent: false,
    singleHost: true, duplicateHost: false, hostHeaderMatchesAuthority: true,
    sensitiveHeadersPresent: false, count: 1 }]);
  rows[0].authority = 'changed'; rows.push({});
  assert.equal(reportConnect(state)[0].authority, 'api.github.com:443');
  assert.equal(reportConnect(state).length, 1);
  assert.equal(state.unrelated, true);
  const fresh = {};
  captureConnect(fresh, request('example.com:443'));
  assert.equal(reportConnect(fresh)[0].count, 1);
});

test('normal public DNS authorities remain readable without DNS or network access', () => {
  const state = {};
  for (const url of ['api.github.com:443', 'example.org:80', 'cdn.example.net:8443',
    'example.io:1', 'build.example.dev:65535', 'my-site.app:443', 'API.Example.COM:443']) {
    captureConnect(state, request(url));
    assert.equal(reportConnect(state).at(-1).authority, url.toLowerCase());
  }
});

test('userinfo, query, paths, IPs, non-ASCII and malformed authorities are fully redacted', () => {
  const invalid = ['user:USERINFO_SECRET@example.com:443', 'example.com:443?token=QUERY_SECRET',
    'example.com:443/path/PATH_SECRET', 'https://example.com:443', 'example.com:443#FRAGMENT_SECRET',
    '127.0.0.1:443', '[::1]:443', '2130706433:443', 'localhost:443', 'example.test:443',
    'com:443', 'example.com', 'example.com:0', 'example.com:65536', 'example.com:0443',
    'example.com:443\n', 'example.com:443\r\n', ' example.com:443', 'example.com.:443',
    '.example.com:443', 'a..example.com:443', '-a.com:443', 'a-.com:443', 'a_b.com:443',
    'ex\u00e4mple.com:443', 'xn--exmple-cua.com:443', 'example%2ecom:443',
    `${'a'.repeat(64)}.com:443`, `${'a.'.repeat(124)}com:443`, null, undefined, 42];
  const state = {};
  for (const url of invalid) captureConnect(state, request(url));
  assert.deepEqual(reportConnect(state), [{ authority: '[redacted]', headPresent: false,
    singleHost: true, duplicateHost: false, hostHeaderMatchesAuthority: false,
    sensitiveHeadersPresent: false, count: invalid.length }]);
  assert.doesNotMatch(JSON.stringify(state), /SECRET|127\.0\.0\.1|localhost|xn--/);
});

test('raw Host count, not normalized headers, determines missing/single/duplicate flags', () => {
  const state = {};
  captureConnect(state, request('example.com:443', [], { host: 'example.com:443' }));
  captureConnect(state, request('example.com:443', ['hOsT', 'OTHER_HOST_SECRET']));
  captureConnect(state, request('example.com:443', ['Host', 'example.com:443', 'HOST', 'DUPLICATE_SECRET']));
  captureConnect(state, request('example.com:443', ['HOST', 'example.com:443']), Buffer.from('HEAD_SECRET'));
  const flags = reportConnect(state).map(({ singleHost, duplicateHost, hostHeaderMatchesAuthority, headPresent }) =>
    [singleHost, duplicateHost, hostHeaderMatchesAuthority, headPresent]);
  assert.deepEqual(flags, [[false, false, false, false], [true, false, false, false],
    [false, true, false, false], [true, false, true, true]]);
  assert.doesNotMatch(JSON.stringify(state), /SECRET/);
});

test('sensitive header names set a boolean; no header values or head bytes are retained', () => {
  for (const name of ['Authorization', 'Proxy-Authorization', 'Cookie', 'Content-Length', 'Transfer-Encoding']) {
    for (const raw of [true, false]) {
      const state = {};
      const headers = Object.create(null);
      if (!raw) Object.defineProperty(headers, name, { enumerable: true,
        get() { throw Error('Sensitive header values must not be read'); } });
      captureConnect(state, request('example.com:443', ['Host', 'example.com:443',
        'X-Unknown', 'UNKNOWN_HEADER_SECRET', ...(raw ? [name.toUpperCase(), 'HEADER_SECRET'] : [])], headers),
      Buffer.from('HEAD_SECRET'));
      assert.equal(reportConnect(state)[0].sensitiveHeadersPresent, true);
      assert.equal(reportConnect(state)[0].headPresent, true);
      assert.doesNotMatch(JSON.stringify({ state, report: reportConnect(state) }), /SECRET|Authorization|Cookie/);
    }
  }
});

test('eight distinct safe signatures aggregate counts and overflow without retaining new authorities', () => {
  const state = {};
  for (let i = 0; i < 8; i++) {
    captureConnect(state, request(`host${i}.com:443`));
    captureConnect(state, request(`host${i}.com:443`));
  }
  for (let i = 0; i < 100; i++) captureConnect(state, request(`overflow${i}.com:443`));
  captureConnect(state, request('host0.com:443'));
  const rows = reportConnect(state);
  assert.equal(state.connectDiagnostics.length, 8);
  assert.equal(rows.length, 9);
  assert.equal(rows[0].count, 3);
  assert.equal(rows[7].count, 2);
  assert.deepEqual(rows[8], { overflow: true, count: 100 });
  assert.equal(rows.reduce((sum, row) => sum + row.count, 0), 117);
  assert.doesNotMatch(JSON.stringify(state), /overflow[0-9]/);
});

test('capture only observes requests and tolerates absent request metadata', () => {
  const state = {};
  const req = Object.freeze({ url: 'example.com:443',
    rawHeaders: Object.freeze(['Host', 'example.com:443']), headers: Object.freeze({}) });
  const head = Buffer.from('UNCHANGED_SECRET');
  assert.equal(captureConnect(state, req, head), undefined);
  assert.equal(head.toString(), 'UNCHANGED_SECRET');
  captureConnect(state, undefined);
  captureConnect(state, { rawHeaders: [null, 'SECRET'], headers: {} });
  const row = reportConnect(state).at(-1);
  assert.equal(row.authority, '[redacted]');
  assert.equal(row.singleHost, false);
  assert.equal(row.duplicateHost, false);
  assert.equal(row.count, 2);
  assert.doesNotMatch(JSON.stringify(state), /SECRET/);
});
