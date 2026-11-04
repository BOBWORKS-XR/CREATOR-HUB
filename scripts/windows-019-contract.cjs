'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const pinned = require('./fixtures/windows-019-binding.json');
const VERSION = '0.1.19';
const ASSET = 'Creator.Hub_0.1.19_x64-setup.exe';
const RAW_REF = 'refs/heads/validation/windows-019-raw-installer';
const PRODUCTION_REF = 'refs/heads/validation/windows-019-production';
const MODULE_FILES = Object.freeze(['mcp/creator-works-mcp-launcher.exe', 'mcp/server/creator-works-mcp.mjs',
  'mcp/server/runtime/node.exe', 'mcp/server/runtime/LICENSE', 'mcp/server/runtime/VERSION',
  'mcp/server/unity-extension/Editor/BanterMCPBridge.cs', 'mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png',
  'mcp/server/LICENSE', 'mcp/server/THIRD_PARTY_NOTICES.md', 'setup/creator-project-setup.exe',
  'routing/creator-hub-mcp-router.exe', 'routing/router.json', 'routing/router.minisig',
  'routing/runtime.json', 'routing/runtime.minisig']);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const keys = (value, expected) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'Unexpected binding fields');
};
const digest = (value, length = 64) => {
  assert.ok(typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
    && value !== '0'.repeat(length), 'Reviewed immutable hash is pending or invalid');
};
const positive = value => assert.ok(Number.isSafeInteger(value) && value > 0, 'Reviewed positive identity is pending');
const name = value => assert.ok(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value) && !value.includes('..'));
function filePin(value, maximum) {
  keys(value, ['bytes', 'sha256']); positive(value.bytes); assert.ok(value.bytes <= maximum); digest(value.sha256);
}
function validateBuildProvenance(value = pinned) {
  keys(value.source, ['commit', 'tree']); digest(value.source.commit, 40); digest(value.source.tree, 40);
  const provenance = value.build?.provenance;
  assert.ok(provenance && typeof provenance === 'object' && !Array.isArray(provenance), 'Reviewed build provenance is pending');
  assert.equal(provenance.schemaVersion, 1);
  assert.equal(provenance.kind, 'windows-019-clean-build', 'Expected the pinned raw R2 build receipt');
  assert.equal(provenance.version, VERSION);
  assert.equal(provenance.sourceCommit, value.source.commit, 'Build receipt source commit differs');
  assert.equal(provenance.sourceTree, value.source.tree, 'Build receipt source tree differs');
  assert.equal(provenance.status, 0, 'Build receipt must record a successful build');
  assert.equal(provenance.sourceUnchanged, true, 'Build receipt must prove unchanged source');
  assert.deepEqual(provenance.changed, [], 'Build receipt records changed source files');
  return provenance;
}
function validateRaw(value = pinned) {
  keys(value, ['schemaVersion', 'enabled', 'version', 'source', 'build', 'installer', 'executable', 'manifest', 'rawRelease', 'production']);
  assert.equal(value.schemaVersion, 1); assert.equal(value.version, VERSION);
  assert.equal(value.enabled, true, 'R2 candidate pins are pending; no network or native actions admitted');
  keys(value.source, ['commit', 'tree']); digest(value.source.commit, 40); digest(value.source.tree, 40);
  keys(value.build, ['resultSha256', 'inputsSha256', 'provenance']);
  digest(value.build.resultSha256); digest(value.build.inputsSha256);
  validateBuildProvenance(value);
  keys(value.installer, ['name', 'bytes', 'sha256']); assert.equal(value.installer.name, ASSET);
  filePin({ bytes: value.installer.bytes, sha256: value.installer.sha256 }, 512 * 1024 * 1024);
  filePin(value.executable, 512 * 1024 * 1024);
  keys(value.manifest, ['bytes', 'sha256', 'sha256Canonical', 'document']);
  positive(value.manifest.bytes); assert.ok(value.manifest.bytes <= 2 * 1024 * 1024); digest(value.manifest.sha256); digest(value.manifest.sha256Canonical);
  assert.equal(hash(Buffer.from(JSON.stringify(value.manifest.document))), value.manifest.sha256Canonical);
  const manifest = value.manifest.document;
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.platform, 'windows'); assert.equal(manifest.arch, 'x86_64');
  keys(manifest.modules, ['mcp', 'setup']);
  for (const [section, prefix] of [[manifest.modules.mcp, 'mcp/'], [manifest.modules.setup, 'setup/'], [manifest.managedRouting, 'routing/']]) {
    keys(section.files, MODULE_FILES.filter(file => file.startsWith(prefix)));
  }
  const files = { ...manifest.modules?.mcp?.files, ...manifest.modules?.setup?.files, ...manifest.managedRouting?.files };
  assert.deepEqual(Object.keys(files).sort(), [...MODULE_FILES].sort());
  for (const sha of Object.values(files)) digest(sha);
  assert.equal(manifest.modules.mcp.executable, 'mcp/creator-works-mcp-launcher.exe');
  assert.equal(manifest.modules.setup.executable, 'setup/creator-project-setup.exe');
  assert.equal(manifest.managedRouting.protocol, 1);
  for (const module of Object.values(manifest.modules)) assert.ok(require('semver').valid(module.version));
  keys(value.rawRelease, ['id', 'tag', 'assetId']); positive(value.rawRelease.id); positive(value.rawRelease.assetId); name(value.rawRelease.tag);
  return value;
}
function validateProduction(value = pinned) {
  validateRaw(value);
  const p = value.production;
  keys(p, ['releaseId', 'releaseTag', 'targetCommit', 'minHubVersion', 'identityProtocol', 'lifecycleProtocol', 'installerProtocol', 'assets']);
  positive(p.releaseId); name(p.releaseTag); assert.equal(p.releaseTag, `v${VERSION}`); digest(p.targetCommit, 40);
  assert.ok(require('semver').valid(p.minHubVersion), 'Reviewed minimum Hub version is pending');
  assert.ok([0, 1].includes(p.identityProtocol)); assert.ok([0, 1].includes(p.lifecycleProtocol)); assert.equal(p.installerProtocol, 1);
  keys(p.assets, [ASSET, 'creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig', 'latest.json']);
  const ids = new Set();
  for (const [file, pin] of Object.entries(p.assets)) {
    keys(pin, ['id', 'size', 'sha256']); positive(pin.id); assert.ok(!ids.has(pin.id)); ids.add(pin.id);
    filePin({ bytes: pin.size, sha256: pin.sha256 }, file === ASSET ? 512 * 1024 * 1024 : file.endsWith('.minisig') ? 4096 : 32768);
  }
  assert.equal(p.assets[ASSET].size, value.installer.bytes); assert.equal(p.assets[ASSET].sha256, value.installer.sha256);
  return value;
}
function baselineFor(version, select = require('./self-update-baselines.cjs').selectBaseline) {
  assert.ok(['0.1.12', '0.1.14', '0.1.18'].includes(version), 'Unknown baseline');
  const baseline = select({ '0.1.12': '0.1.13', '0.1.14': '0.1.16', '0.1.18': VERSION }[version]);
  assert.equal(baseline.version, version, 'Exact public baseline registry entry is pending');
  digest(baseline.installer); digest(baseline.exe); name(baseline.asset);
  return Object.freeze(baseline);
}
module.exports = { pinned, VERSION, ASSET, RAW_REF, PRODUCTION_REF, MODULE_FILES, hash, keys, digest, positive, validateBuildProvenance, validateRaw, validateProduction, baselineFor };
