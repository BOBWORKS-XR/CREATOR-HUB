const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { stage } = require('./stage-native-candidate.cjs');
const { moduleFiles } = require('./build-unified.cjs');
const { routeFiles } = require('./managed-router-package.cjs');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');

test('native staging selects only verified public payloads, preserves originals and refuses overwrites', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-input-stage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'original'), output = path.join(root, 'staged');
  const write = (name, text) => {
    const file = path.join(source, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return hash(text);
  };
  const manifest = { schemaVersion: 1, platform: 'windows', arch: 'x86_64', modules: {}, managedRouting: { protocol: 1, files: {} } };
  for (const id of ['mcp', 'setup']) {
    const names = moduleFiles(id, 'windows');
    manifest.modules[id] = { executable: names[0], version: '1.0.0', files: Object.fromEntries(names.map(name => [name, write(`modules/${name}`, name)])) };
  }
  for (const name of routeFiles('windows')) manifest.managedRouting.files[name] = write(`modules/${name}`, name);
  write('builtin-manifest.json', JSON.stringify(manifest));
  write('creator-hub.exe', 'unit fixture never executed');
  write('installer.exe', 'installer unit fixture never executed');
  write('installer-extracted/creator-hub.exe', 'installed unit fixture never executed');
  write('installer-checksum.json', JSON.stringify({ version: '0.1.13', acceptanceOnly: true, signed: false,
    sha256: hash('installer unit fixture never executed'), installedExecutableSha256: hash('installed unit fixture never executed') }));
  write('unrelated-private-file', 'not included');
  const result = stage(source, output, 'a'.repeat(40));
  assert.equal(result.releaseReady, false); assert.equal(result.privateKeyIncluded, false);
  assert.equal(Object.keys(result.files).length, 19);
  assert.equal(fs.existsSync(path.join(output, 'unrelated-private-file')), false);
  assert.equal(fs.existsSync(path.join(source, 'unrelated-private-file')), true);
  assert.throws(() => stage(source, output, 'a'.repeat(40)), /previous candidate evidence/);
  write('modules/mcp/server/creator-works-mcp.mjs', 'tampered');
  const refused = path.join(root, 'refused');
  assert.throws(() => stage(source, refused, 'a'.repeat(40)), /module changed/);
  assert.equal(fs.existsSync(refused), false);
});

test('managed native workflow retains exact candidate pins and cannot publish', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/managed-candidate-acceptance.yml'), 'utf8');
  assert.match(workflow, /validation\/unified-managed-input/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /releases\/assets\/636510488/);
  assert.doesNotMatch(workflow, /gh release download/);
  assert.match(workflow, /eee2b101c888db32be8e1fb3751717ce57e4ff7fd7a74aa6d5a179467129e5a0/);
  assert.match(workflow, /sourceRevision -ne 'd59c030eb7567bbd5a93c005830d407acfc81b1d'/);
  assert.match(workflow, /matrix:\s*\n\s*mode: \[fresh, upgrade\]/);
  assert.doesNotMatch(workflow, /signing_key|signer sign|gh release (create|edit|upload)/);
  const staging = workflow.slice(workflow.indexOf('  stage-input:'), workflow.indexOf('  installed:'));
  const native = workflow.slice(workflow.indexOf('  installed:'));
  assert.match(staging, /contents: write/);
  assert.match(staging, /Invoke-WebRequest -Method Get/);
  assert.doesNotMatch(staging, /npm ci|actions\/checkout|native-builtin-smoke/);
  assert.match(native, /needs: stage-input/);
  assert.doesNotMatch(native, /contents: write|GH_TOKEN/);
});
