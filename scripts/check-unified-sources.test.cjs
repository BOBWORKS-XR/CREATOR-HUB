const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateManifest, checkSources, checkRemovedPlugins, assertReleaseReady } = require('./check-unified-sources.cjs');
const manifest = require('../modules/suite.json');
const root = path.resolve(__dirname, '..');

test('unified source retains Hub identity and both explicit legacy source records', () => {
  assert.equal(validateManifest(manifest), manifest);
  assert.deepEqual(checkSources(root, manifest).modules, ['mcp', 'setup']);
});

test('source paths cannot escape the canonical module locations', () => {
  for (const field of ['path', 'frontend']) {
    const invalid = structuredClone(manifest);
    invalid.modules.mcp[field] = '../outside';
    assert.throws(() => validateManifest(invalid), /source provenance or path/);
  }
});

test('source gate refuses reintroduced Plugins navigation, assets and retirement UI', () => {
  assert.doesNotThrow(() => checkRemovedPlugins('<main>Projects</main>', 'fixture'));
  for (const html of ['<button data-view="plugins">', '<button data-local-view="plugins">', "<section id='view-plugins'>", '<script src="community.js">', '<script src="community-adapter.js">',
    '<link href="community.css">', '<img src="icons/creator-plugins.png">', '<p>Creator Plugins has retired</p>']) {
    assert.throws(() => checkRemovedPlugins(html, 'fixture'), /Removed Plugins interface is still included: fixture/);
  }
});

test('legacy app versions are not mistaken for Hub product versions', () => {
  assert.equal(manifest.baselineHub, '0.1.12');
  assert.equal(manifest.modules.mcp.baselineTag, 'v2.7.7');
  assert.equal(manifest.modules.setup.baselineTag, 'v0.3.7');
  const invalid = structuredClone(manifest);
  invalid.appId = 'creator-works-mcp';
  assert.throws(() => validateManifest(invalid), /Invalid unified/);
});

test('consolidated sources do not claim tested packaging or migration readiness', () => {
  assert.throws(() => assertReleaseReady(manifest), /not a unified release/);
  assert.throws(() => assertReleaseReady({ ...manifest, phase: 'ready' }), /Invalid unified/);
});

test('source CI uses module interfaces without fetching separate repositories', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /modules\/project-setup\/src/);
  assert.match(ci, /modules\/mcp\/launcher\/src/);
  assert.doesNotMatch(ci, /repository: BOBWORKS-XR\/CREATOR-(?:PROJECT-SETUP|WORKS-UNITY-MCP)/);
});

test('headless Unix writer fixtures compile the actual integration context', () => {
  const fixture = fs.readFileSync(path.join(root, 'native/mcp-router/tests/hosted-boundary/src/lib.rs'), 'utf8');
  const config = fs.readFileSync(path.join(root, 'native/mcp-router/tests/hosted-boundary/Cargo.toml'), 'utf8');
  assert.match(fixture, /#\[path = "[^"\n]*modules\/mcp\/launcher\/src-tauri\/src\/integration_context.rs"\]\s*mod integration_context;/);
  assert.match(config, /\[features\]\s*integrated-service = \[\]/);
  assert.doesNotMatch(fixture, /fn protected_writers\(/);
});
