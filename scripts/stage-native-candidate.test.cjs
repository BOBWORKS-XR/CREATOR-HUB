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
  assert.match(workflow, /validation\/unified-managed-014/);
  assert.match(workflow, /releases\/assets\/638170425/);
  assert.doesNotMatch(workflow, /gh release download/);
  assert.match(workflow, /4ef0d46d69e7ecf1d9ffea7d1920a596b439104f1ff5b8e1e26ebc48ce3424ad/);
  assert.match(workflow, /sourceRevision -ne 'c44f9b30cf7ca41c27d66fcd3fb41a562e1dca1f'/);
  assert.match(workflow, /version -ne '0\.1\.14'/);
  assert.match(workflow, /privateKeyIncluded -ne \$false/);
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
