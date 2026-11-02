'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const contract = require('./windows-012-r2-guarded-contract.cjs');
const candidate = require('./windows-incoming-016.cjs');
const { baselines } = require('./native-installed-baseline.cjs');
const root = path.resolve(__dirname, '..');

function receipt() {
  return { passed: true, scope: 'public012-to-r2-guarded-nsis-only',
    installerScope: 'guarded-nsis-update-default-location-no-msi', from: contract.BASELINE,
    ...candidate.productProvenance(), testSource: 'a'.repeat(40),
    guardedInstallerAccepted: true, settingsPreserved: true, signedUpdateAccepted: false,
    nativeGuiAccepted: false, migrationAccepted: false, minimumVersionQualified: false, releaseReady: false, userMachineUsed: false,
    installerSha256: contract.TARGET.installer, executableSha256: contract.TARGET.exe,
    retainedFiles: contract.FIXTURES.map(({ id, bytes }) => ({ id, sha256: candidate.hash(Buffer.from(bytes)) })) };
}
test('exact official public012 and R2 candidate pins match the existing independent contracts', () => {
  const old = baselines.find(row => row.product === 'Creator Hub');
  assert.equal(old.version, contract.BASELINE.version); assert.equal(old.asset, contract.BASELINE.asset);
  assert.equal(old.sha256, contract.BASELINE.installer); assert.equal(old.binary, 'creator-hub.exe');
  assert.equal(contract.BASELINE.exe, '34c6f05548f469ac23b4faee7aa8355d5cca083c444c4f7b0942426a9c76a7ac');
  contract.checkBinding(); assert.equal(contract.TARGET.installer, candidate.TARGET.installer);
  assert.equal(contract.TARGET.exe, candidate.TARGET.exe); assert.equal(contract.TARGET.bytes, 38213208);
});
test('guarded receipt refuses wrong source, old pins, missing preservation and broader claims', () => {
  const valid = receipt(); contract.checkReceipt(valid);
  for (const change of [{ passed: false }, { installerSha256: '0'.repeat(64) }, { executableSha256: '0'.repeat(64) },
    { sourceUnchanged: false }, { buildInputDigest: '0'.repeat(64) }, { testSource: 'dirty' },
    { installerScope: 'any-installer' }, { from: { ...contract.BASELINE, version: '0.1.14' } },
    { settingsPreserved: false }, { guardedInstallerAccepted: false }, { signedUpdateAccepted: true },
    { nativeGuiAccepted: true }, { migrationAccepted: true }, { minimumVersionQualified: true }, { releaseReady: true }, { userMachineUsed: true },
    { retainedFiles: [] }, { retainedFiles: valid.retainedFiles.map((item, i) => i ? item : { ...item, sha256: '0'.repeat(64) }) }]) {
    assert.throws(() => contract.checkReceipt({ ...valid, ...change }));
  }
});
test('local and untrusted runners refuse before installer reads or profile operations', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-windows-012-r2-guarded.cjs'), 'utf8');
  assert.ok(source.indexOf('explicit disposable GitHub-hosted Windows lane') < source.indexOf("require('node:fs')"));
  for (const required of ["['/S', '/NS']", "['/UPDATE', '/S', '/NS']", 'contract.BASELINE.exe',
    'contract.TARGET.exe', 'assert.deepEqual(registrations()', "flag: 'wx'", 'Never overwrite pre-existing fixture data']) assert.ok(source.includes(required));
  assert.doesNotMatch(source, /taskkill|Stop-Process|\.kill\(|rejectUnauthorized|auth\.json/);
  const result = spawnSync(process.execPath, [path.join(__dirname, 'native-windows-012-r2-guarded.cjs'), 'MUST-NOT-READ'],
    { env: { ...process.env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /explicit disposable GitHub-hosted Windows lane/);
  assert.doesNotMatch(result.stderr, /ENOENT|MUST-NOT-READ/);
});
test('workflow binds reviewed stager and baseline before native work without signing or release writes', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/windows-012-r2-guarded.yml'), 'utf8');
  for (const value of ['13143820688', '41448285787', '2a430ded3715f28d6b0203afd41dd1986d603c7dd4998a388f74b6a8219b6f84',
    '1f5abcfd34c05acf3e60f8c776f49df1b08d5fc2', contract.BASELINE.installer, "if: always()",
    'guarded-012-r2-report.json', 'CREATOR_WINDOWS_012_R2_GUARDED']) assert.ok(workflow.includes(value), value);
  assert.ok(workflow.indexOf('node --test') < workflow.indexOf('actions/download-artifact@v4'));
  assert.ok(workflow.indexOf('inspect-installer $directory') < workflow.indexOf('native-windows-012-r2-guarded.cjs "'));
  assert.match(workflow, /github\.ref == 'refs\/heads\/validation\/windows-menu-merge-20261027'/);
  assert.doesNotMatch(workflow, /contents: write|pull_request:|signer sign|gh release|build:unified|SkipCertificateCheck/);
});
test('actual candidate installer admission when explicitly supplied', { skip: !process.env.CREATOR_TEST_CANDIDATE_PATH }, () => {
  candidate.installer(process.env.CREATOR_TEST_CANDIDATE_PATH);
});
