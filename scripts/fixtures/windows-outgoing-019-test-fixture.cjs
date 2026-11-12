'use strict';
// SYNTHETIC UNIT DATA ONLY. No real installers, source receipts, signatures or release IDs.
const crypto = require('node:crypto');
const pending = require('./windows-outgoing-019-binding.json');
const digest = text => crypto.createHash('sha256').update('SYNTHETIC UNIT DATA ONLY: ' + text).digest('hex');
const pin = text => ({ bytes: 123, sha256: digest(text) });
const binding = structuredClone(pending);
binding.enabled = true;
const paths = ["mcp/creator-works-mcp-launcher.exe","mcp/server/LICENSE","mcp/server/THIRD_PARTY_NOTICES.md","mcp/server/creator-works-mcp.mjs","mcp/server/runtime/LICENSE","mcp/server/runtime/VERSION","mcp/server/runtime/node.exe","mcp/server/unity-extension/Editor/BanterMCPBridge.cs","mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png","routing/creator-hub-mcp-router.exe","routing/router.json","routing/router.minisig","routing/runtime.json","routing/runtime.minisig","setup/creator-project-setup.exe"];
for (const [name, item] of [['baseline', binding.baseline], ['target', binding.target]]) {
  item.source = { commit: digest(name + ' commit').slice(0, 40), tree: digest(name + ' tree').slice(0, 40) };
  item.installer = pin(name + ' installer'); item.executable = pin(name + ' executable');
  item.sourceUnchanged = true; item.buildExitCode = 0; item.verificationReceiptSha256 = digest(name + ' receipt');
  const files = Object.fromEntries(paths.map(file => [file, digest(name + file)]));
  item.manifest = { schemaVersion: 1, platform: 'windows', arch: 'x86_64', modules: {
    mcp: { executable: 'mcp/creator-works-mcp-launcher.exe', version: name === 'baseline' ? '2.7.9' : '2.7.9',
      files: Object.fromEntries(Object.entries(files).filter(([file]) => file.startsWith('mcp/'))) },
    setup: { executable: 'setup/creator-project-setup.exe', version: '0.3.7',
      files: { 'setup/creator-project-setup.exe': files['setup/creator-project-setup.exe'] } } },
    managedRouting: { protocol: 1, files: Object.fromEntries(Object.entries(files).filter(([file]) => file.startsWith('routing/'))) } };
  const mcp = item.manifest.modules.mcp;
  item.generation = crypto.createHash('sha256').update(JSON.stringify({ executable: mcp.executable, version: mcp.version,
    files: Object.fromEntries(Object.entries(mcp.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) })).digest('hex');
}
binding.target.manifest.modules.mcp = structuredClone(binding.baseline.manifest.modules.mcp);
binding.target.manifest.modules.mcp.files['mcp/creator-works-mcp-launcher.exe'] = digest('target rebuilt launcher');
binding.target.manifest.modules.mcp.version = '2.7.10';
const mcp = binding.target.manifest.modules.mcp;
binding.target.generation = crypto.createHash('sha256').update(JSON.stringify({ executable: mcp.executable, version: mcp.version,
  files: Object.fromEntries(Object.entries(mcp.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) })).digest('hex');
binding.baseline.releaseId = 1; binding.baseline.assetId = 2;
for (const key of ['descriptor', 'descriptorSignature', 'latest']) binding.target[key] = pin('target ' + key);
binding.target.privateRelease = { id: 3, tag: 'lab-windows-capability-023-unit-fixture', source: binding.target.source.commit,
  assets: Object.fromEntries([[binding.target.asset, binding.target.installer], ['creator-hub-windows-x86_64.json', binding.target.descriptor],
    ['creator-hub-windows-x86_64.json.minisig', binding.target.descriptorSignature], ['latest.json', binding.target.latest]]
    .map(([name, value], index) => [name, { id: index + 4, ...value }])) };
Object.assign(binding.fixtureQualification, { sha256: binding.target.verificationReceiptSha256, source: binding.target.source,
  sourceUnchanged: true, buildExitCode: 0, inputCount: 1, fixtureUsableForOutgoingTest: true });
module.exports = { purpose: 'SYNTHETIC UNIT DATA ONLY', binding };
