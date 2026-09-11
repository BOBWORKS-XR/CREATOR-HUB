const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validVersion } = require('./release-descriptor.cjs');

function validateStagedSetup(pin, descriptor, installer, hubVersion) {
  assert.ok(validVersion(pin.version) && validVersion(hubVersion));
  assert.equal(descriptor.schemaVersion, 1);
  assert.equal(descriptor.appId, 'creator-project-setup');
  assert.equal(descriptor.version, pin.version);
  assert.equal(descriptor.assetName, pin.assetName);
  assert.match(pin.assetName, /^Creator-Project-Setup-[a-zA-Z0-9.-]+-Windows-setup\.exe$/);
  assert.equal(descriptor.sha256, pin.installerSha256);
  assert.equal(descriptor.executableSha256, pin.executableSha256);
  assert.equal(descriptor.byteLength, installer.length);
  assert.equal(crypto.createHash('sha256').update(installer).digest('hex'), pin.installerSha256);
  assert.equal(descriptor.minHubVersion, hubVersion);
  assert.equal(descriptor.installerProtocol, 1);
  return { mode: 'signed-staged-cache', version: pin.version, installerSha256: pin.installerSha256,
    executableSha256: pin.executableSha256, publicFeedTested: false };
}

function stage() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Windows') {
    throw Error('Staged cache acceptance is restricted to a disposable GitHub-hosted Windows runner.');
  }
  const repo = path.resolve(__dirname, '..');
  const pin = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/prerelease-apps.json'), 'utf8')).setup;
  const hubVersion = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
  function bounded(file, max) {
    assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink());
    assert.ok(fs.statSync(file).size > 0 && fs.statSync(file).size <= max);
    return fs.readFileSync(file);
  }
  const fixture = path.join(repo, 'tests/fixtures/staged-setup');
  const bytes = bounded(path.join(fixture, 'creator-hub-windows-x86_64.json'), 32768);
  const signature = bounded(path.join(fixture, 'creator-hub-windows-x86_64.json.minisig'), 4096);
  const installer = bounded(path.join(repo, 'artifacts/staged-setup', pin.assetName), 512 * 1024 * 1024);
  const receipt = validateStagedSetup(pin, JSON.parse(bytes), installer, hubVersion);
  const cache = path.join(process.env.LOCALAPPDATA, 'CreatorHub');
  const catalog = path.join(cache, 'catalog');
  const downloads = path.join(cache, 'downloads');
  fs.mkdirSync(catalog, { recursive: true });
  fs.mkdirSync(downloads, { recursive: true });
  // The unmodified Hub must still verify the real signature and all install guards.
  const name = `creator-project-setup-${pin.version}`;
  fs.writeFileSync(path.join(catalog, `${name}.json`), bytes, { flag: 'wx' });
  fs.writeFileSync(path.join(catalog, `${name}.minisig`), signature, { flag: 'wx' });
  fs.writeFileSync(path.join(downloads, `${pin.installerSha256}.exe`), installer, { flag: 'wx' });
  fs.writeFileSync(path.join(repo, 'artifacts/staged-setup/receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write('Staged exact Setup bytes; native signature, version and consent checks are still required.\n');
}
module.exports = { validateStagedSetup };
if (require.main === module) stage();
