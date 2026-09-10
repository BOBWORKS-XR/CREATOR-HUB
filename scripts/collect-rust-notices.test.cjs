const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { licenseFiles, overrideLicenseFiles, productionPackages, collect } = require('./collect-rust-notices.cjs');

test('walk includes regular/build dependencies but excludes dev-only dependencies', () => {
  const edge = (pkg, kind) => ({ pkg, dep_kinds: [{ kind }] });
  const metadata = { packages: ['root', 'runtime', 'build', 'dev'].map(id => ({ id, name: id, version: '1.0.0' })),
    resolve: { root: 'root', nodes: [{ id: 'root', deps: [edge('runtime', null), edge('build', 'build'), edge('dev', 'dev')] },
      ...['runtime', 'build', 'dev'].map(id => ({ id, deps: [] }))] } };
  assert.deepEqual(productionPackages(metadata).map(pkg => pkg.id), ['build', 'runtime']);
});
test('workspace license supplements are restricted to the recorded crate and upstream revision', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-license-source-'));
  try {
    const pkg = { name: 'alloc-stdlib', version: '0.2.4' };
    fs.writeFileSync(path.join(root, '.cargo_vcs_info.json'), JSON.stringify({ git: { sha1: 'ae42d22078b98549e987d2f03d12df7b984fde47' } }));
    assert.equal(overrideLicenseFiles(pkg, root).length, 1);
    assert.deepEqual(overrideLicenseFiles({ ...pkg, version: '0.2.5' }, root), []);
    fs.writeFileSync(path.join(root, '.cargo_vcs_info.json'), JSON.stringify({ git: { sha1: 'different' } }));
    assert.throws(() => overrideLicenseFiles(pkg, root), /revision differs/);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'creator-license-source-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('collects unchanged original notices, reports missing files and rejects escaping paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-notices-'));
  try {
    fs.writeFileSync(path.join(root, 'LICENSE-MIT'), 'Original copyright\r\nOriginal license');
    const files = licenseFiles(root);
    assert.equal(files.length, 1);
    assert.throws(() => licenseFiles(root, '../LICENSE'), /escapes/);
    const metadata = { packages: [{ id: 'dep', name: 'example', version: '1.0.0', license: 'MIT', source: 'registry+fixture', manifest_path: path.join(root, 'Cargo.toml') }],
      resolve: { root: 'root', nodes: [{ id: 'root', deps: [{ pkg: 'dep', dep_kinds: [{ kind: null }] }] }, { id: 'dep', deps: [] }] } };
    const result = collect(metadata, []);
    assert.match(result.text, /Original copyright\r\nOriginal license/);
    assert.equal(result.inventory[0].files[0].sha256.length, 64);
    fs.unlinkSync(path.join(root, 'LICENSE-MIT'));
    assert.throws(() => collect(metadata, []), /Missing original license/);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'creator-notices-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
