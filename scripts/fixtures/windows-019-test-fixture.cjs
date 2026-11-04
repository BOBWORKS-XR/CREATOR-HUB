'use strict';
// Synthetic unit-test bytes only. Never used by acquisition or native workflows.
const path = require('node:path');
const c = require('../windows-019-contract.cjs');
function fixture() {
  const files = Object.fromEntries(c.MODULE_FILES.map(name => [name, c.hash(Buffer.from(`test-only:${name}`))]));
  const manifest = { schemaVersion: 1, platform: 'windows', arch: 'x86_64', modules: {
    mcp: { version: '2.7.7', executable: c.MODULE_FILES[0], files: Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith('mcp/'))) },
    setup: { version: '0.3.7', executable: 'setup/creator-project-setup.exe', files: { 'setup/creator-project-setup.exe': files['setup/creator-project-setup.exe'] } } },
  managedRouting: { protocol: 1, files: Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith('routing/'))) } };
  const installer = Buffer.from('synthetic 019 installer, not executable'), executable = Buffer.from('synthetic 019 image, not executable');
  const descriptor = Buffer.from(JSON.stringify({ schemaVersion: 1, appId: 'creator-hub', version: c.VERSION,
    platform: 'windows', architecture: 'x86_64', packageType: 'nsis', assetName: c.ASSET,
    byteLength: installer.length, sha256: c.hash(installer), executableSha256: c.hash(executable),
    identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1, minHubVersion: '0.1.12' }));
  const signature = Buffer.from('untrusted comment: synthetic test envelope\nnot-a-production-signature\n');
  const latest = Buffer.from(JSON.stringify({ version: c.VERSION, platforms: { 'windows-x86_64': {
    url: `https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v${c.VERSION}/${c.ASSET}`, signature: signature.toString('base64') } } }));
  const assetBytes = { [c.ASSET]: installer, 'creator-hub-windows-x86_64.json': descriptor,
    'creator-hub-windows-x86_64.json.minisig': signature, 'latest.json': latest };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const binding = { schemaVersion: 1, enabled: true, version: c.VERSION,
    source: { commit: '1'.repeat(40), tree: '2'.repeat(40) },
    build: { resultSha256: '3'.repeat(64), inputsSha256: '4'.repeat(64), provenance: {
      schemaVersion: 1, kind: 'windows-019-clean-build', sourceCommit: '1'.repeat(40), sourceTree: '2'.repeat(40),
      version: c.VERSION, status: 0, sourceUnchanged: true, changed: [], syntheticUnitTestOnly: true } },
    installer: { name: c.ASSET, bytes: installer.length, sha256: c.hash(installer) },
    executable: { bytes: executable.length, sha256: c.hash(executable) },
    manifest: { bytes: manifestBytes.length, sha256: c.hash(manifestBytes), sha256Canonical: c.hash(manifestBytes), document: manifest },
    rawRelease: { id: 1001, tag: 'synthetic-019-raw', assetId: 1002 },
    production: { releaseId: 2001, releaseTag: 'v0.1.19', targetCommit: '5'.repeat(40), minHubVersion: '0.1.12',
      identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1,
      assets: Object.fromEntries(Object.entries(assetBytes).map(([name, bytes], index) => [name, { id: 2002 + index, size: bytes.length, sha256: c.hash(bytes) }])) } };
  return { binding, installer, executable, assetBytes, descriptor, signature, latest };
}
function install() {
  const value = fixture();
  // Node test files run in separate processes; only this test process gets synthetic pins.
  const file = path.resolve(__dirname, 'windows-019-binding.json');
  require.cache[require.resolve(file)].exports = value.binding;
  delete require.cache[require.resolve('../windows-019-contract.cjs')];
  return value;
}
module.exports = { fixture, install };
