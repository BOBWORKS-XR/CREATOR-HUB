const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyStage } = require('./build-unified.cjs');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function stage(source, output, sourceRevision) {
  assert.ok(path.isAbsolute(source) && path.isAbsolute(output), 'Use absolute candidate and new staging paths');
  assert.match(sourceRevision, /^[a-f0-9]{40}$/);
  assert.equal(fs.existsSync(output), false, 'Refuse replacing previous candidate evidence');
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'builtin-manifest.json')));
  assert.equal(manifest.platform, 'windows'); assert.equal(manifest.arch, 'x86_64');
  assert.equal(manifest.managedRouting?.protocol, 1, 'Signed managed routing must be included');
  verifyStage(path.join(source, 'modules'), manifest);
  const checksum = JSON.parse(fs.readFileSync(path.join(source, 'installer-checksum.json')));
  assert.equal(checksum.acceptanceOnly, true); assert.equal(checksum.signed, false);
  assert.equal(hash(path.join(source, 'installer.exe')), checksum.sha256);
  const installed = path.join(source, 'installer-extracted', 'creator-hub.exe');
  assert.equal(hash(installed), checksum.installedExecutableSha256);
  const files = ['creator-hub.exe', 'installer.exe', 'installer-checksum.json', 'builtin-manifest.json',
    ...Object.values(manifest.modules).flatMap(module => Object.keys(module.files).map(name => `modules/${name}`)),
    ...Object.keys(manifest.managedRouting.files).map(name => `modules/${name}`)];
  assert.equal(new Set(files).size, files.length);
  fs.mkdirSync(output, { recursive: true });
  const pins = {};
  for (const name of files) {
    const original = path.join(source, name), copy = path.join(output, name);
    assert.ok(fs.lstatSync(original).isFile() && !fs.lstatSync(original).isSymbolicLink());
    const expected = hash(original);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(original, copy, fs.constants.COPYFILE_EXCL);
    assert.equal(hash(copy), expected); pins[name] = expected;
  }
  const provenance = { schemaVersion: 1, sourceRevision, version: checksum.version, files: pins,
    acceptanceOnly: true, releaseReady: false, privateKeyIncluded: false };
  fs.writeFileSync(path.join(output, 'candidate-source.json'), `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx' });
  return provenance;
}

module.exports = { stage };
if (require.main === module) {
  try {
    assert.equal(process.argv.length, 5, 'Usage: stage-native-candidate.cjs SOURCE NEW-OUTPUT SOURCE-REVISION');
    const result = stage(...process.argv.slice(2));
    console.log(JSON.stringify({ sourceRevision: result.sourceRevision, version: result.version, files: Object.keys(result.files).length }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
