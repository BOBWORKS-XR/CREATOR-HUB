'use strict';
const assert = require('node:assert/strict');
const candidate = require('./windows-incoming-016.cjs');
const BASELINE = Object.freeze({ version: '0.1.12', asset: 'Creator.Hub_0.1.12_x64-setup.exe',
  installer: '0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18',
  exe: '34c6f05548f469ac23b4faee7aa8355d5cca083c444c4f7b0942426a9c76a7ac' });
const TARGET = Object.freeze({ version: '0.1.16', asset: 'Creator.Hub_0.1.16_x64-setup.exe', bytes: 38213208,
  installer: '7326d054ac23b7ac560e2c3488933203a33f0033586b1c33988ce7f316e4c51a',
  exe: 'fac846563720eb4dae665a814ea28d0556800ebaf75aba7e8ee0be7f1979a5cd',
  productSource: 'source-receipt-sha256:a6eeac26841ad4dc7aa20e6480cc1ff185e0aa0458fa6611b70d681e812844e9' });
const FIXTURES = Object.freeze([
  Object.freeze({ id: 'unmanaged', base: 'hub', relative: 'unmanaged-retention-sentinel.txt', bytes: 'Keep unmanaged installed content\r\n' }),
  Object.freeze({ id: 'preferences', base: 'local', relative: 'CreatorHub/preferences/hub-preferences.json', bytes: '{"previewChannel":false,"autoDownload":false,"restoreHostedViews":true,"unknown":"keep"}\n' }),
  Object.freeze({ id: 'mcp', base: 'roaming', relative: 'creator-works-mcp/launcher-config.json', bytes: '{"channels":[],"auto_start":false,"futureOption":{"keep":true}}\n' }),
  Object.freeze({ id: 'legacy-mcp', base: 'roaming', relative: 'banter-mcp/launcher-config.json', bytes: '{"channels":[],"auto_start":false,"futureLegacy":"keep"}\r\n' }),
  Object.freeze({ id: 'setup', base: 'local', relative: 'CreatorProjectSetup/editor-roots.json', bytes: '[]\n' }),
]);
function checkBinding() {
  assert.deepEqual(candidate.TARGET, TARGET, 'Exact R2 candidate binding required');
  const p = candidate.productProvenance();
  assert.equal(p.sourceUnchanged, true);
  assert.equal(p.buildInputDigest, 'bd07866cc0c80eb433ce963862b4c44e4d6712616e80b5ce06131e2306711288');
  assert.equal(p.buildResultSha256, '78cf43f002c9a10c86987925b137932383481415d0d90c96ab1f2292ab9bbe2e');
  assert.equal(p.sourceSnapshotBuilt, false);
  return p;
}
function checkReceipt(report) {
  assert.equal(report.passed, true); assert.equal(report.scope, 'public012-to-r2-guarded-nsis-only');
  assert.equal(report.installerScope, 'guarded-nsis-update-default-location-no-msi');
  assert.deepEqual(report.from, BASELINE);
  assert.equal(report.installerSha256, TARGET.installer); assert.equal(report.executableSha256, TARGET.exe);
  for (const [key, value] of Object.entries(checkBinding())) assert.deepEqual(report[key], value);
  for (const key of ['guardedInstallerAccepted', 'settingsPreserved']) assert.equal(report[key], true);
  for (const key of ['signedUpdateAccepted', 'nativeGuiAccepted', 'migrationAccepted', 'minimumVersionQualified', 'releaseReady', 'userMachineUsed']) assert.equal(report[key], false);
  assert.match(report.testSource, /^[a-f0-9]{40}$/);
  assert.deepEqual(report.retainedFiles, FIXTURES.map(({ id, bytes }) => ({ id, sha256: candidate.hash(Buffer.from(bytes)) })));
}
module.exports = { BASELINE, TARGET, FIXTURES, checkBinding, checkReceipt };
