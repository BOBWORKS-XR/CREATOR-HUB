'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const legacy = require('./windows-incoming-016.cjs');
const target = require('./windows-outgoing-019-target.cjs');
const binding = target.binding;
const TARGET = Object.freeze({ version: '0.1.23', asset: 'Creator.Hub_0.1.23_x64-setup.exe',
  bytes: binding.target.installer?.bytes, installer: binding.target.installer?.sha256,
  exe: binding.target.executable?.sha256, productSource: binding.target.source?.commit });
const SOURCE = { commit: '7684ed5d5af5c64a9ec6bef6bdb6708756748187', tree: '67b91f1d50cf9a22a03942aae89e387be473ec31' };
const FILES = [TARGET.asset, 'creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig', 'latest.json'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function signedReceipt() {
  target.validateBinding(); assert.deepEqual(binding.target.source, SOURCE);
  assert.equal(binding.target.version, TARGET.version); assert.equal(binding.target.manifest.modules.mcp.version, '2.7.10');
  const bytes = target.readBounded(path.join(__dirname, 'fixtures/windows-fresh-023-qualification.json'), 256 * 1024);
  assert.equal(hash(bytes), binding.target.verificationReceiptSha256);
  const q = JSON.parse(bytes);
  assert.equal(q.kind, 'outgoing23-candidate-only-verified'); assert.deepEqual(q.source, SOURCE);
  assert.equal(q.minimumHubVersion, '0.1.19');
  assert.equal(q.privateTransportTag, 'lab-windows-capability-023-20261112-r1');
  assert.equal(binding.target.privateRelease.tag, q.privateTransportTag);
  assert.equal(q.updaterUrl, `https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.23/${TARGET.asset}`);
  assert.equal(q.transportMode, 'private-draft-plus-lab-feed');
  for (const k of ['sourceUnchanged', 'outerSigned', 'fixtureUsableForOutgoingTest']) assert.equal(q[k], true);
  for (const k of ['published', 'releaseReady', 'productionApproval', 'outgoingNativeAccepted', 'productionSourceGuardException', 'publicDiscovery', 'publicReleaseRequired']) assert.equal(q[k], false);
  for (const k of ['internalSignaturesVerified', 'descriptorSignatureVerified', 'installerSignatureVerified', 'extractedPayloadsMatch']) assert.equal(q.verification[k], true);
  for (const k of ['descriptorTamperRejected', 'installerTamperRejected', 'signatureTamperRejected', 'trustedCommentTamperRejected',
    'wrongPublicKeyRejected', 'rawExeDescriptorRejected', 'encodedMetadataSignatureRejected', 'updateUrlTamperRejected']) assert.equal(q.verification.negativeProofs[k], true);
  assert.equal(q.payloadFiles, 15); assert.equal(q.buildExitCode, 0);
  assert.deepEqual(q.installer, binding.target.installer); assert.deepEqual(q.executable, binding.target.executable);
  assert.deepEqual(q.manifest, binding.target.manifest); assert.equal(q.generation, binding.target.generation);
  assert.deepEqual(Object.keys(q.assets).sort(), [...FILES].sort());
  for (const [name, pin] of Object.entries(binding.target.privateRelease.assets))
    assert.deepEqual(q.assets[name], { bytes: pin.bytes, sha256: pin.sha256 });
  return q;
}
function installer(file) {
  signedReceipt(); assert.equal(path.basename(file), TARGET.asset);
  const bytes = target.readBounded(file, TARGET.bytes);
  assert.equal(bytes.length, TARGET.bytes); assert.equal(hash(bytes), TARGET.installer); return file;
}
function productProvenance() {
  return { productSource: SOURCE.commit, sourceTree: SOURCE.tree, qualificationSha256: binding.target.verificationReceiptSha256, acceptanceOnly: true };
}
function assertInstalled(directory) { signedReceipt(); target.assertInstalledResources(directory, TARGET.version); }
function assertRoute(local) {
  signedReceipt(); const item = binding.target, manifest = item.manifest;
  const root = path.join(local, 'creator-hub/mcp-route-v1/windows-x86_64');
  const active = JSON.parse(target.readBounded(path.join(root, 'active.json'), 4096));
  assert.deepEqual(active, { schemaVersion: 1, descriptorSha256: manifest.managedRouting.files['routing/runtime.json'], generation: item.generation });
  for (const name of ['runtime.json', 'runtime.minisig'])
    target.readHash(path.join(root, 'descriptors', active.descriptorSha256, name), manifest.managedRouting.files[`routing/${name}`]);
  for (const name of ['router.json', 'router.minisig', 'creator-hub-mcp-router.exe'])
    target.readHash(path.join(root, 'router-v1', name), manifest.managedRouting.files[`routing/${name}`]);
  for (const [name, pin] of Object.entries(manifest.modules.mcp.files))
    target.readHash(path.join(local, 'creator-hub/runtime-generations/windows-x86_64', item.generation, name), pin);
  return active;
}
module.exports = { TARGET, SOURCE, FILES, hash, signedReceipt, installer, productProvenance, assertInstalled, assertRoute,
  assertOwnedDebugging: legacy.assertOwnedDebugging, showPage: legacy.showPage };
