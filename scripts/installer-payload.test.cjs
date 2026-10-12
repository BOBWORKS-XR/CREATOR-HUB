const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verifyBundleMarker } = require('./installer-payload.cjs');

test('only the exact Tauri UNK-to-NSS marker change is authorized, never arbitrary binary differences', () => {
  const raw = Buffer.from('prefix\0__TAURI_BUNDLE_TYPE_VAR_UNK\0code and assets');
  const installed = Buffer.from('prefix\0__TAURI_BUNDLE_TYPE_VAR_NSS\0code and assets');
  verifyBundleMarker(raw, installed);
  const changed = Buffer.from(installed); changed[0] ^= 1;
  assert.throws(() => verifyBundleMarker(raw, changed), /differs beyond/);
  assert.throws(() => verifyBundleMarker(raw, raw), /differs beyond/);
  assert.throws(() => verifyBundleMarker(Buffer.from('no marker'), installed), /one Tauri/);
  assert.throws(() => verifyBundleMarker(Buffer.concat([raw, raw]), installed), /one Tauri/);
});

test('native installer matching derives the exact expected image from packaged bytes', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-installed-baseline.cjs'), 'utf8');
  assert.match(source, /expectedExecutable = require\('\.\/installer-payload.cjs'\)\.extract/);
  assert.match(source, /sha256\(expectedExecutable\)/);
});
