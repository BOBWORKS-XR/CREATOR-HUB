'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const probe = require('./native-macos-legacy-retirement-probe.cjs');
const proof = require('../docs/evidence/legacy-unix-public-package-pins-014.json');
const environment = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REF: probe.branch,
  CREATOR_MACOS_LEGACY_RETIREMENT_PROBE: '1', RUNNER_ARCH: 'ARM64' };

test('only the fixed disposable native branch is admitted', () => {
  probe.admission(environment, 'darwin', 'arm64');
  probe.admission({ ...environment, RUNNER_ARCH: 'X64' }, 'darwin', 'x64');
});
for (const key of Object.keys(environment)) test(`missing or altered ${key} refuses before work`, () => {
  assert.throws(() => probe.admission({ ...environment, [key]: undefined }, 'darwin', 'arm64'));
  assert.throws(() => probe.admission({ ...environment, [key]: 'other' }, 'darwin', 'arm64'));
});
for (const [platform, arch] of [['win32', 'x64'], ['linux', 'x64'], ['darwin', 'ia32']]) {
  test(`non-matching ${platform}/${arch} refuses`, () => assert.throws(() => probe.admission(environment, platform, arch)));
}
for (const arch of ['arm64', 'x64']) for (const product of ['setup', 'mcp']) {
  test(`exact public ${product}/${arch} DMG and complete bundle surface`, () => {
    const pkg = probe.packageFor(proof, product, arch);
    assert.equal(pkg.members.length, product === 'mcp' ? 13 : 4);
    assert(pkg.members.every(row => row.relative.startsWith('Contents/')));
    assert.equal(pkg.members.filter(row => row.relative.includes('/server/')).length, product === 'mcp' ? 9 : 0);
    assert(pkg.members.some(row => row.relative === `Contents/MacOS/${pkg.exe}`));
  });
  test(`altered ${product}/${arch} package bytes, digest or URL refuses`, () => {
    for (const field of ['packageBytes', 'packageSha256', 'packageUrl']) {
      const copy = structuredClone(proof), pkg = probe.packageFor(copy, product, arch);
      copy.packages.find(row => row.asset === pkg.asset)[field] = field === 'packageBytes' ? 1 : 'other';
      assert.throws(() => probe.packageFor(copy, product, arch));
    }
  });
}
test('unknown product/architecture, duplicate and unsafe member refuse', () => {
  assert.throws(() => probe.packageFor(proof, 'other', 'x64'));
  assert.throws(() => probe.packageFor(proof, 'mcp', 'other'));
  const duplicate = structuredClone(proof), pkg = probe.packageFor(duplicate, 'mcp', 'arm64');
  duplicate.packages.push(duplicate.packages.find(row => row.asset === pkg.asset));
  assert.throws(() => probe.packageFor(duplicate, 'mcp', 'arm64'));
  for (const member of ['../outside', 'Creator Works MCP/Creator Works MCP.app/../outside', 'C:\\outside']) {
    const changed = structuredClone(proof);
    changed.packages.find(row => row.asset === pkg.asset).members[0].member = member;
    assert.throws(() => probe.packageFor(changed, 'mcp', 'arm64'));
  }
});
test('a baseline, strict signature or normal close alone never authorizes retirement', () => {
  assert.equal(probe.missingContract({}), 'exact-public-bundle-unverified-no-launch');
  assert.equal(probe.missingContract({ exactBundle: true }), 'public-bundle-strict-signature-refused-no-gui-launch');
  assert.equal(probe.missingContract({ exactBundle: true, bundleSignature: true }), 'normal-native-close-or-owned-exit-unverified-no-retirement');
  assert.equal(probe.missingContract({ exactBundle: true, bundleSignature: true, normalExit: true }),
    'native-reviewed-no-overwrite-archive-and-registration-contract-not-established');
  for (const key of ['nativeRetirementAccepted', 'nativeReviewAccepted', 'settingsMigrationAccepted',
    'unifiedInstallerAccepted', 'signedUpdateAccepted', 'releaseReady']) assert.equal(probe.scope[key], false);
});
test('bounded probe retains both runtime names, uses EOF, and never kills/removes/resigns', () => {
  const script = fs.readFileSync(path.join(__dirname, 'native-macos-legacy-retirement-probe.cjs'), 'utf8');
  const native = fs.readFileSync(path.join(__dirname, 'native-macos-legacy-retirement-probe.swift'), 'utf8');
  assert(script.indexOf('admission(env, process.platform') < script.indexOf('const temporary = canonical'));
  assert.match(script, /\['setup', 'mcp'\]/);
  assert.match(script, /\['node', 'node.exe'\]/);
  assert.match(script, /row\.stdioBefore = await stdio\.start/);
  assert.match(script, /row\.stdioAfterNormalClose = await stdio\.list/);
  assert.match(script, /child\.stdin\.end\(\)/);
  assert.match(script, /process\.exitCode = report\.passed \? 0 : 1/);
  assert.doesNotMatch(script + native, /(?:SIGKILL|SIGTERM|forceTerminate|\.kill\(|unlinkSync\(|renameSync\(|rmSync\(|--force|--remove-signature|--sign\b|spctl[^\n]*--master-disable)/);
  assert.match(native, /native\.terminate\(\)/);
  assert.match(native, /info\.pbi_ppid == parent/);
  assert.match(native, /owned-process-or-image-drift-no-close/);
  assert.match(native, /registrationRemovalAuthority": false/);
});
test('one temporary MCP GUI-only experiment has native decline/approve and exclusive restore, never generic replay', () => {
  const script = fs.readFileSync(path.join(__dirname, 'native-macos-legacy-retirement-probe.cjs'), 'utf8');
  const native = fs.readFileSync(path.join(__dirname, 'native-macos-legacy-retirement-probe.swift'), 'utf8');
  assert.match(native, /CREATOR_MACOS_LEGACY_ARCHIVE_EXPERIMENT/);
  assert.match(native, /first-native-review-must-cancel/);
  assert.match(native, /native-archive-approval-declined/);
  assert.match(native, /AXUIElementPerformAction\(button, kAXPressAction/);
  assert.match(native, /native-review-modal-unverified/);
  assert.match(native, /O_CREAT \| O_EXCL \| O_NOFOLLOW/);
  assert.match(native, /renameatx_np\(sourceFD, sourceName, targetFD, archivedName, UInt32\(RENAME_EXCL\)\)/);
  assert.match(native, /renameatx_np\(targetFD, archivedName, sourceFD, sourceName, UInt32\(RENAME_EXCL\)\)/);
  assert.match(native, /collision == -1 && code == EEXIST/);
  assert.match(native, /old-mcp-kernel-or-native-app-not-absent/);
  assert.match(script, /result\.stdioWhileArchived = await stdio\.list/);
  assert.match(script, /bundleSignatureWhileArchived/);
  assert.match(script, /registrationWhileArchived/);
  assert.match(script, /launchWhileArchived/);
  assert.match(script, /bundleSignatureRestored/);
  assert.match(script, /result\.error = error\.message/);
  assert.doesNotMatch(native, /replay|unregister|LSRegisterURL|removeItem|removefile\(/);
});
test('dedicated workflow cannot select arbitrary input, self-hosted machines or other branches', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/native-macos-legacy-retirement-probe.yml'), 'utf8');
  assert.match(workflow, /branches: \[validation\/mac-legacy-retirement-014\]/);
  assert.match(workflow, /macos-latest/); assert.match(workflow, /macos-15-intel/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /self-hosted|inputs:|secrets:|contents: write|continue-on-error|sudo |xattr -d/);
  assert.match(workflow, /if: always\(\)/);
});
test('recorded native measurement does not turn preserved stdio into clean retirement acceptance', () => {
  const evidence = require('../docs/evidence/macos-legacy-gui-archive-experiment-014.json');
  assert.equal(evidence.sourceCommit, '2bbf8a67c512a1defa70e928aed48bcded9fffdf');
  assert.equal(evidence.runId, 38633431819);
  assert.equal(evidence.nativeRetirementAccepted, false); assert.equal(evidence.releaseReady, false);
  assert.deepEqual(evidence.targets.map(row => row.architecture), ['arm64', 'x64']);
  for (const row of evidence.targets) {
    assert.equal(row.reportMatchesOriginalZip, true); assert.match(row.zipSha256, /^[a-f0-9]{64}$/);
    assert.equal(row.nativeCancel, true); assert.equal(row.nativeApprove, true);
    assert.equal(row.existingDestinationCollisionRefused, true); assert.equal(row.originalRuntimeResourcesRetained, 9);
    assert.equal(row.liveStdioWhileArchived.tools, 53);
    assert.equal(row.bundleSignatureWhileArchived.exit, 1);
    assert.equal(row.nativeLaunchWhileArchived.errorDomain, 'NSCocoaErrorDomain');
    assert.equal(row.nativeLaunchWhileArchived.errorCode, 259);
    assert.equal(row.stillRegisteredAt, '/Users/runner/Applications/Creator Works MCP.app');
    assert.equal(row.exactGuiInodeRestored, true); assert.equal(row.restoredBundleSignatureExit, 0);
  }
});
