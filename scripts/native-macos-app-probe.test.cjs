const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const probe = require('./native-macos-app-probe.cjs');
const sourcePath = path.join(__dirname, 'native-macos-app-probe.cjs');
const source = fs.readFileSync(sourcePath, 'utf8');
const assemblyWorkflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/unix-managed-assembly.yml'), 'utf8').replace(/\r\n/g, '\n');
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS', RUNNER_ARCH: 'ARM64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', CREATOR_MACOS_OWNED_GUI_TEST: '1', CREATOR_MACOS_APP_PROBE: '1' };
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'creator-macos-app-probe-tests-')));
let uncertainCompiler = false;
after(() => {
  if (uncertainCompiler) return;
  const resolved = fs.realpathSync(scratch);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('creator-macos-app-probe-tests-'));
  fs.rmSync(resolved, { recursive: true });
});

test('admission requires real Mac shape, exact hosted repository, both opt-ins and native architecture', () => {
  assert.doesNotThrow(() => probe.admission(env, 'darwin', 'arm64'));
  assert.doesNotThrow(() => probe.admission({ ...env, RUNNER_ARCH: 'X64' }, 'darwin', 'x64'));
  for (const [changed, platform, arch] of [
    [env, 'win32', 'arm64'], [env, 'linux', 'arm64'], [env, 'darwin', 'ia32'],
    [{ ...env, GITHUB_ACTIONS: 'false' }, 'darwin', 'arm64'], [{ ...env, RUNNER_ENVIRONMENT: 'self-hosted' }, 'darwin', 'arm64'],
    [{ ...env, RUNNER_OS: 'Linux' }, 'darwin', 'arm64'], [{ ...env, GITHUB_REPOSITORY: 'other/repo' }, 'darwin', 'arm64'],
    [{ ...env, CREATOR_MACOS_APP_PROBE: '' }, 'darwin', 'arm64'], [{ ...env, CREATOR_MACOS_OWNED_GUI_TEST: '' }, 'darwin', 'arm64'],
    [{ ...env, RUNNER_ARCH: 'X64' }, 'darwin', 'arm64'],
  ]) assert.throws(() => probe.admission(changed, platform, arch));
});

test('CLI refuses before reading supplied app or creating output on local, self-hosted or non-Mac invocation', () => {
  for (const changed of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }]) {
    const output = path.join(scratch, `must-not-exist-${Object.keys(changed)[0]}`);
    const result = spawnSync(process.execPath, [sourcePath, '--app', '/unread.app', '--hub-sha256', 'a'.repeat(64), '--output', output],
      { env: { ...process.env, ...env, ...changed }, encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.passed, false);
    for (const key of Object.keys(probe.acceptance)) assert.equal(receipt[key], false);
    assert.equal(fs.existsSync(output), false);
  }
});

test('CLI requires a caller-supplied independent hash and has no PID, trust, action or discovery options', () => {
  assert.equal(probe.options(['--app', '/owned.app', '--hub-sha256', 'a'.repeat(64), '--output', '/new']).hubSha256, 'a'.repeat(64));
  for (const args of [[], ['--app', '/owned.app', '--hub-sha256', 'not-a-hash', '--output', '/new'],
    ['--app', '/owned.app', '--hub-sha256', 'a'.repeat(64), '--output', '/new', '--skip-trust'], ['--pid', '42']]) {
    assert.throws(() => probe.options(args));
  }
});

function assemblyReceipt() {
  return { schemaVersion: 1, product: 'com.creatorworks.hub.unix-signed-assembly', platform: 'macos', arch: 'x86_64',
    hubVersion: '0.1.14', assemblyCommit: 'a'.repeat(40), privateSource: { repository: 'BOBWORKS-XR/CREATOR-HUB', repositoryId: 1364807512,
      workflow: '.github/workflows/unix-managed-payload.yml', event: 'push', sourceCommit: 'b'.repeat(40), buildCommit: 'b'.repeat(40),
      sourceTree: 'c'.repeat(40), runId: 38599976833, runAttempt: 1 }, handoffSha256: 'd'.repeat(64), mcpMode: 'writable',
    privateModulesRecompiled: false, privateModulesResigned: false, nativeGuiAccepted: false, releaseReady: false };
}
const receiptBytes = value => Buffer.from(JSON.stringify(value, null, 2));
test('fresh version/source options are all-or-none independent pins, not action or provenance bypasses', () => {
  const args = ['--app', '/owned.app', '--hub-sha256', 'a'.repeat(64), '--output', '/new',
    '--expected-version', '0.1.14', '--assembly-receipt', '/signed-unix-assembly.json', '--assembly-receipt-sha256', 'b'.repeat(64)];
  assert.equal(probe.options(args).expectedVersion, '0.1.14');
  for (const bad of [args.slice(0, 8), [...args, '--skip-identity'], args.map(v => v === '0.1.14' ? 'latest' : v),
    args.map(v => v === 'b'.repeat(64) ? 'not-pinned' : v)]) assert.throws(() => probe.options(bad));
});
test('fresh Mac workflow preserves exact private input pins, split permissions and Linux no-bundle admission', () => {
  const expected = [
    { target: 'linux', os: 'ubuntu-22.04', assetId: 641099820, zipBytes: 55172816, zipSha256: '5036cab13213f56e1e08ab74037a4a719a9591573deb80fda013b25e0ba844f7', handoffSha256: '96f63bb4a5def192b086367fa4a6d00efd297a8cdb106cd4ace4bb35c8e4a3c9' },
    { target: 'macos-arm64', os: 'macos-latest', assetId: 641099814, zipBytes: 47761280, zipSha256: '75d61ea27e4fa62d28688c8794b25bc917104e23a45c80427debcfaaf9c19871', handoffSha256: 'c051a7e230abb5832a96c738919d0c9cc6ebd740b73533edb0af0b4ebde49670' },
    { target: 'macos-intel', os: 'macos-15-intel', assetId: 641099811, zipBytes: 49622185, zipSha256: '04191eb7007c274eb290e6de08fd4e6643b1483f8ef9a4ac3007a8f2ddc66884', handoffSha256: '332eab5174d3290c4e973086f3d36ee60390d123f45317923c301fe08ee92fb6' },
  ];
  const matrices = [...assemblyWorkflow.matchAll(/fromJSON\(inputs.signed_inputs \|\| '([^']+)'\)/g)];
  assert.equal(matrices.length, 2); for (const [, value] of matrices) assert.deepEqual(JSON.parse(value), expected);
  assert.match(assemblyWorkflow, /branches: \[validation\/unix-assembly-014\]\n    paths: \['\.github\/workflows\/unix-managed-assembly.yml'\]/);
  assert.match(assemblyWorkflow, /permissions:\n  contents: read\njobs:/);
  assert.equal((assemblyWorkflow.match(/contents: write/g) || []).length, 1);
  const stage = assemblyWorkflow.split('  stage-input:')[1].split('  assembly:')[0];
  assert.doesNotMatch(stage, /actions\/checkout|npm ci|build:unified|native-macos-app-probe/);
  assert.match(stage, /release_id:411494394/); assert.match(stage, /release.tag_name,'v0.1.13-validation'/);
  assert.match(assemblyWorkflow, /installer=\(\)\n          if \[\[ "\$RUNNER_OS" == 'macOS' \]\]; then installer=\(--installer\); fi/);
  assert.match(assemblyWorkflow, /ci-signed-unix-hub "\$\{installer\[@\]\}" --managed --experimental-unix --experimental-unix-writable/);
  assert.doesNotMatch(assemblyWorkflow, /GITHUB_WORKFLOW_REF\s*=|exportVariable\('GITHUB_|contents: write[\s\S]*?\n  assembly:[\s\S]*?contents: write|workflow_dispatch.*create/);
});
test('fresh workflow validates primary native package/version pins before probe and retains only owned failure evidence', () => {
  assert.match(assemblyWorkflow, /assert.equal\(integrity.integrityPassed,true\)/);
  assert.match(assemblyWorkflow, /assert.deepEqual\(integrity.packages.map\(p=>p.format\),\['app','dmg'\]\)/);
  assert.match(assemblyWorkflow, /assert.equal\(dmgPin.image.sha256,dmgRecord.sha256\)/);
  assert.match(assemblyWorkflow, /assert.equal\(info.CFBundleShortVersionString,'0.1.14'\)/);
  assert.ok(assemblyWorkflow.indexOf("path.join(proof,'package-info.json')")
    < assemblyWorkflow.indexOf("assert.equal(info.CFBundleShortVersionString,'0.1.14')"));
  assert.match(assemblyWorkflow, /input:infoPin.bytes,encoding:'utf8',timeout:15000,maxBuffer:65536/);
  assert.match(assemblyWorkflow, /assemblyPin=probe.pin\(path.join\(output,'signed-unix-assembly.json'\),16384,true\)/);
  assert.match(assemblyWorkflow, /exportVariable\('ASSEMBLY_RECEIPT_SHA256',assemblyPin.image.sha256\)/);
  assert.ok(assemblyWorkflow.indexOf('assert.equal(probe.pin(receipt,16384).image.sha256,assemblyPin.image.sha256)')
    < assemblyWorkflow.indexOf("core.exportVariable('APP_PATH'"));
  assert.match(assemblyWorkflow, /--expected-version 0.1.14 --assembly-receipt "\$ASSEMBLY_RECEIPT" --assembly-receipt-sha256 "\$ASSEMBLY_RECEIPT_SHA256"/);
  assert.match(assemblyWorkflow, /unix.verifyResources\(path.join\(app,'Contents\/Resources\/modules'\),manifest\)/);
  assert.match(assemblyWorkflow, /codesign',\['--verify','--deep','--strict',app\]/);
  assert.match(assemblyWorkflow, /nativeGuiAccepted:false,mcpAccepted:false,migrationAccepted:false,updateAccepted:false,releaseReady:false/);
  assert.match(assemblyWorkflow, /native-packages\/\*\.dmg/);
  assert.match(assemblyWorkflow, /if: always\(\) && runner.os == 'macOS'/);
  assert.match(assemblyWorkflow, /assert.equal\(reportedPath,file\)/);
  assert.match(assemblyWorkflow, /assert.deepEqual\(Object.keys\(expectedImage\).sort\(\),Object.keys\(image\).sort\(\)\)/);
  assert.match(assemblyWorkflow, /assert.ok\(probe.sameImage\(image,expectedImage\)\)/);
  assert.doesNotMatch(assemblyWorkflow, /AXUIElementPerformAction|accept_usage_terms|mock.*IPC|CGRequestScreenCaptureAccess|screencapture.*-D|release.*publish/);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const scripts = [...assemblyWorkflow.matchAll(/^          script: \|\n((?:            .*\n)+)/gm)];
  assert.equal(scripts.length, 2);
  for (const [, block] of scripts) assert.doesNotThrow(() => new AsyncFunction(block.split('\n').map(line => line.slice(12)).join('\n')));
});

test('actual bitmap workflow gate separates the recorded owned path from exact pin fields', () => {
  const block = assemblyWorkflow.split('      - name: Admit only a completed exact-owned-window bitmap diagnostic')[1];
  const script = block.match(/node - <<'NODE'\n([\s\S]*?)\n          NODE/)[1].split('\n').map(line => line.slice(10)).join('\n');
  const temp = path.join(scratch, 'virtual-runner'), root = path.join(temp, 'root-app-probe');
  const file = path.join(root, 'window-bitmap', 'root-window.png');
  // Exact pin-field shape of ARM38613119845; synthetic execution proves only the
  // workflow admission contract, never native ownership or rendered pixels.
  const image = { sha256: 'a37b8869130b771971cc4e9efb40408da64344afb5f24bf82162148417e8224b',
    device: '16777230', inode: '3027251', size: 234135, modifiedSeconds: 1792002063,
    modifiedNanoseconds: 877590458, uid: 501, width: 1052, height: 692 };
  const good = { windowBitmap: { completed: true, diagnosticOnly: true, ...probe.acceptance, image: { path: file, ...image } } };
  assert.equal(probe.sameImage(image, good.windowBitmap.image), false);
  const execute = report => {
    const output = [];
    const fakeFS = { realpathSync: value => { assert.equal(value, temp); return temp; },
      readFileSync: value => { assert.equal(value, path.join(root, 'report.json')); return JSON.stringify(report); },
      appendFileSync: (value, data) => { assert.equal(value, 'test-output'); output.push(data); } };
    vm.runInNewContext(script, { process: { env: { RUNNER_TEMP: temp, GITHUB_OUTPUT: 'test-output' } },
      require: name => {
        if (name === 'node:assert/strict') return assert;
        if (name === 'node:fs') return fakeFS;
        if (name === 'node:path') return path;
        assert.equal(name, './scripts/native-macos-app-probe.cjs');
        return { ...probe, bitmapImage: value => { assert.equal(value, file); return { ...image }; } };
      } });
    return output;
  };
  assert.deepEqual(execute(good), ['completed=true\n']);
  for (const mutate of [r => r.windowBitmap.image.path = path.join(root, 'other.png'), r => delete r.windowBitmap.image.path,
    r => delete r.windowBitmap.image.inode, r => r.windowBitmap.image.unreviewed = true, r => r.windowBitmap.nativeGuiAccepted = true,
    ...Object.keys(image).map(key => r => { r.windowBitmap.image[key] = typeof image[key] === 'number' ? image[key] + 1 : 'changed'; })]) {
    const changed = structuredClone(good); mutate(changed); assert.throws(() => execute(changed));
  }
});
test('source receipt preserves distinct established assembly/private source stamps without inventing verification', () => {
  const good = assemblyReceipt(), identity = probe.assemblyIdentity(receiptBytes(good), 'x86_64', '0.1.14');
  assert.equal(identity.assemblyCommit, good.assemblyCommit); assert.deepEqual(identity.privateSource, good.privateSource);
  for (const mutate of [v => v.hubVersion = '0.1.13', v => v.arch = 'aarch64', v => v.platform = 'linux',
    v => v.assemblyCommit = 'main', v => v.privateSource.sourceTree = 'unknown', v => v.privateSource.buildCommit = 'e'.repeat(40),
    v => v.privateSource.repository = 'foreign', v => v.privateSource.workflow = 'other', v => v.privateSource.event = 'workflow_dispatch',
    v => v.privateSource.runId = 0, v => v.privateSource.runAttempt = '1', v => v.privateSource.token = 'not-allowed',
    v => v.nativeGuiAccepted = true, v => v.releaseReady = true, v => v.privateModulesRecompiled = true,
    v => v.handoffSha256 = 'bad', v => v.actionAllowed = true]) {
    const changed = structuredClone(good); mutate(changed);
    assert.throws(() => probe.assemblyIdentity(receiptBytes(changed), 'x86_64', '0.1.14'));
  }
  const bytes = receiptBytes(good);
  for (const bad of [Buffer.alloc(16385), Buffer.from('{bad'), Buffer.from(bytes.toString().replace('"schemaVersion": 1', '"schemaVersion": 0, "schemaVersion": 1'))]) {
    assert.throws(() => probe.assemblyIdentity(bad, 'x86_64', '0.1.14'));
  }
  assert.match(source, /artifactToImageBindingVerified: false/);
  assert.match(source, /provenance: 'not-independently-verified-by-probe'/);
  assert.match(source, /independent-assembly-receipt-hash-mismatch/);
});

test('native package versions must be bounded actual strings tied to exact owner/plist, never source-version inference', () => {
  const { owner } = ownership();
  const good = { ...rootInspection(owner), command: 'package-identity', package: { bundleIdentifier: 'com.creatorworks.hub',
    bundleExecutable: 'creator-hub', bundleShortVersion: '0.1.14', bundleVersion: '14', infoPlist: structuredClone(owner.process.infoPlist) } };
  assert.doesNotThrow(() => probe.validatePackageIdentity(good, owner, '0.1.14'));
  for (const mutate of [r => r.command = 'inspect-root', r => r.package.bundleShortVersion = '0.1.13', r => r.package.bundleVersion = 14,
    r => r.package.bundleShortVersion = true, r => r.package.bundleVersion = 'a'.repeat(1000), r => r.package.bundleExecutable = 'foreign',
    r => r.package.bundleIdentifier = 'foreign', r => r.package.infoPlist.sha256 = 'b'.repeat(64),
    r => r.process.startSeconds++, r => r.window.id++, r => r.rootNativeCFReferencePreserved = false,
    r => r.nativeGuiAccepted = true, r => r.package.sourceCommit = 'a'.repeat(40), r => delete r.package.bundleVersion]) {
    const changed = structuredClone(good); mutate(changed);
    assert.throws(() => probe.validatePackageIdentity(changed, owner, '0.1.14'));
  }
  assert.throws(() => probe.validateRootInspection(good, owner));
  const native = probe.surfaceSource.split('if package {')[1].split('emit(["command": "inspect-root"')[0];
  assert.match(native, /imageMatches\(app \+ "\/Contents\/Info.plist", plist, 65536, contents: true\)/);
  assert.match(native, /let fields = try packageFields\(bytes, plist\)/);
  assert.match(probe.surfaceSource, /PropertyListSerialization.propertyList\(from: bytes/);
  assert.match(native, /try checkHeldRoot\(\)[\s\S]*?"command": "package-identity"/);
  assert.doesNotMatch(native, /Bundle\(|appVersion.*GITHUB|AXUIElementPerformAction|write\(/);
});

test('new output reservation cannot replace original reports or write inside the pinned app', () => {
  const app = path.join(scratch, 'synthetic.app'), output = path.join(scratch, 'new-report');
  fs.mkdirSync(app);
  assert.equal(probe.reserveOutput(scratch, app, output), output);
  const old = path.join(output, 'report.json'); fs.writeFileSync(old, 'original report');
  assert.throws(() => probe.reserveOutput(scratch, app, output));
  assert.equal(fs.readFileSync(old, 'utf8'), 'original report');
  assert.throws(() => probe.reserveOutput(scratch, app, path.join(app, 'must-not-exist')));
  assert.equal(fs.existsSync(path.join(app, 'must-not-exist')), false);
  assert.throws(() => probe.reserveOutput(scratch, app, path.join(path.dirname(scratch), 'outside-output')));
});

test('file pin retains exact bytes and detects changed content without using that hash as provenance', () => {
  const file = path.join(scratch, 'synthetic-image');
  fs.writeFileSync(file, 'synthetic image, not an app', { flag: 'wx' });
  const first = probe.pin(file, 1024, true);
  assert.equal(first.image.sha256, crypto.createHash('sha256').update(first.bytes).digest('hex'));
  assert.equal(typeof first.image.device, 'string'); assert.equal(typeof first.image.inode, 'string');
  fs.writeFileSync(file, 'different synthetic image');
  assert.equal(probe.sameImage(probe.pin(file).image, first.image), false);
  assert.throws(() => probe.pin(file, 1));
  assert.throws(() => probe.pin(scratch));
  assert.doesNotMatch(source, /sourceProvenanceVerified|packageVerified|signatureVerified/);
});

test('linked and multiply-linked image inputs refuse', { skip: process.platform === 'win32' }, () => {
  const file = path.join(scratch, 'link-source'), link = path.join(scratch, 'symlink'), hard = path.join(scratch, 'hardlink');
  fs.writeFileSync(file, 'synthetic'); fs.symlinkSync(file, link);
  assert.throws(() => probe.pin(link));
  fs.linkSync(file, hard); assert.throws(() => probe.pin(hard));
});

function ownership() {
  const image = { sha256: 'a'.repeat(64), device: '1', inode: '2', size: 10, modifiedSeconds: 123, modifiedNanoseconds: 4, uid: 501 };
  const expected = { pid: 42, app: '/owned/Creator Hub.app', executable: '/owned/Creator Hub.app/Contents/MacOS/creator-hub', image, infoPlist: { ...image, inode: '3' } };
  const owner = { process: { pid: 42, executablePath: expected.executable, bundlePath: expected.app, bundleIdentifier: 'com.creatorworks.hub',
    startSeconds: 100, startMicroseconds: 200, image: { ...image }, infoPlist: { ...expected.infoPlist } },
  window: { id: 71, pid: 42, bounds: { x: 1, y: 2, width: 400, height: 300 } } };
  return { owner, expected };
}

function closeDialog() {
  return { scope: 'root-standard-window-first-order-native-dialogs', state: 'absent', windowCount: 1, childCount: 6 };
}
test('owner binding refuses foreign PID/path/hash/plist/start stamp/window and invalid bounds', () => {
  const good = ownership(); assert.doesNotThrow(() => probe.validateOwner(good.owner, good.expected));
  for (const mutate of [o => o.process.pid++, o => o.process.executablePath = '/foreign', o => o.process.bundlePath = '/foreign.app',
    o => o.process.bundleIdentifier = 'com.apple.finder', o => o.process.image.sha256 = 'b'.repeat(64),
    o => o.process.infoPlist.inode = '99', o => o.process.startSeconds = 0, o => o.process.startMicroseconds = 1000000,
    o => o.window.pid++, o => o.window.id = 0, o => o.window.bounds.x = Infinity, o => o.window.bounds.width = 0,
    o => o.window.bounds.height = 20000]) {
    const value = ownership(); mutate(value.owner); assert.throws(() => probe.validateOwner(value.owner, value.expected));
  }
});

test('fresh profile cannot inherit accounts, client settings, app injection variables or a caller HOME', () => {
  const output = path.join(scratch, 'profile'); fs.mkdirSync(output);
  const profile = probe.privateProfile(output);
  assert.equal(profile.HOME, path.join(output, 'private-home'));
  assert.equal(profile.CFFIXED_USER_HOME, profile.HOME);
  assert.equal(profile.XDG_CONFIG_HOME, path.join(profile.HOME, '.config'));
  assert.equal(profile.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
  assert.deepEqual(Object.keys(profile).sort(), ['PATH', 'HOME', 'CFFIXED_USER_HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'].sort());
  assert.throws(() => probe.privateProfile(output));
});

test('capture and accepted exit require more than a successful close call or exit zero', () => {
  const { owner } = ownership();
  const observation = { process: owner.process, window: owner.window, accessibilityTrusted: true, active: true, truncated: false,
    hasDialog: false, closeDialog: closeDialog() };
  const close = { action: 'close-window', axAction: 'AXPress', actionAttempted: true, postIdentityVerified: true,
    forceKillPerformed: false, permissionRequestsPerformed: false, before: observation, after: observation };
  const exit = { pid: owner.process.pid, code: 0, signal: null };
  assert.equal(probe.acceptedExit(close, exit, owner), true);
  assert.equal(probe.acceptedExit({ ...close, after: { ...observation, window: null, windowMissingVerified: true } }, exit, owner), true);
  for (const pair of [[null, exit], [close, null], [close, { ...exit, code: 1 }],
    [close, { ...exit, signal: 'SIGTERM' }], [{ ...close, postIdentityVerified: false }, exit],
    [{ ...close, actionAttempted: false }, exit]]) assert.equal(probe.acceptedExit(...pair, owner), false);
  assert.match(source, /passed: report.captureCompleted === true && accepted && !report.error && !cleanupUncertain/);
  for (const value of Object.values(probe.acceptance)) assert.equal(value, false);
});

test('ARM refusal contract keeps close acceptance false while reporting only the exact caller-owned exit0 fact', () => {
  // Minimal portable shape of the retained ARM receipt; not native runtime proof.
  const { owner } = ownership();
  const receipt = { error: 'process-start-drift', actionAttempted: true, postIdentityVerified: false,
    forceKillPerformed: false, permissionRequestsPerformed: false, before: { process: owner.process, window: owner.window } };
  const exit = { pid: owner.process.pid, code: 0, signal: null };
  assert.equal(probe.acceptedExit(receipt, exit), false);
  const result = probe.closeAssessment(receipt, exit, owner);
  assert.equal(result.callerOwnedExit0, true);
  assert.equal(result.helperPostIdentityVerified, false);
  assert.equal(result.postProcessState, 'unknown');
  assert.equal(result.closeAccepted, false);
  assert.equal(probe.closeAssessment(receipt, { ...exit, pid: exit.pid + 1 }, owner).callerOwnedExit0, false);
  assert.equal(probe.closeAssessment(receipt, { ...exit, signal: 'SIGTERM' }, owner).callerOwnedExit0, false);
  for (const state of ['absent', 'different-process', 'unavailable']) {
    const changed = { ...receipt, postProcessStatus: { state, pid: owner.process.pid,
      expectedStartSeconds: owner.process.startSeconds, expectedStartMicroseconds: owner.process.startMicroseconds } };
    assert.equal(probe.closeAssessment(changed, exit, owner).closeAccepted, false);
  }
});

test('read-only log lifetime cannot forge close proof or suite cleanup but does not erase an independently verified Root exit', () => {
  const { owner } = ownership(), exit = { pid: owner.process.pid, code: 0, signal: null };
  const before = { process: owner.process, window: owner.window, accessibilityTrusted: true, active: true,
    truncated: false, hasDialog: false, closeDialog: closeDialog() };
  const close = { action: 'close-window', axAction: 'AXPress', actionAttempted: true, postIdentityVerified: true,
    forceKillPerformed: false, permissionRequestsPerformed: false, before, after: before };
  const report = { captureCompleted: true };
  const complete = (changed = {}, receipt = close, childExit = exit, gui = false, log = false) =>
    probe.probeCompletion({ ...report, ...changed }, receipt, childExit, owner, owner.process.pid, gui, log);
  assert.equal(complete().passed, true);
  const diagnosticUncertain = complete({}, close, exit, false, true);
  assert.equal(diagnosticUncertain.acceptedExit, true); assert.equal(diagnosticUncertain.passed, false);
  assert.equal(diagnosticUncertain.guiToolLifetimeUncertain, false);
  assert.equal(diagnosticUncertain.readOnlyDiagnosticToolLifetimeUncertain, true);
  assert.equal(diagnosticUncertain.cleanupUncertain, true);
  for (const uncertain of [true, undefined, null, 'false']) {
    assert.equal(probe.probeCompletion(report, close, exit, owner, owner.process.pid, uncertain, false).passed, false);
    assert.equal(probe.probeCompletion(report, close, exit, owner, owner.process.pid, false, uncertain).passed, false);
  }
  for (const changed of [{ error: 'native-package-identity-refused' }, { closeError: 'normal-close-refused' },
    { captureCompleted: false }, { captureCompleted: 'true' }]) assert.equal(complete(changed).passed, false);
  for (const receipt of [null, { ...close, postIdentityVerified: false }, { ...close, error: 'foreign-ax-element' },
    { ...close, before: { ...before, process: { ...owner.process, startSeconds: owner.process.startSeconds + 1 } } }]) {
    assert.equal(complete({}, receipt, exit, false, true).acceptedExit, false);
  }
  for (const childExit of [null, { ...exit, pid: exit.pid + 1 }, { ...exit, signal: 'SIGTERM' }, { ...exit, code: 1 }]) {
    assert.equal(complete({}, close, childExit, false, true).acceptedExit, false);
  }
});

test('native termination is distinct from live process identity and requires exact owned exit and all postconditions', () => {
  const { owner } = ownership();
  const before = { process: owner.process, window: owner.window, accessibilityTrusted: true, active: true,
    truncated: false, hasDialog: false, closeDialog: closeDialog(), controls: [{ path: 'close-button', role: 'AXButton', pid: owner.process.pid,
      windowID: owner.window.id, enabled: true, hidden: false, showing: true, pressSupported: true }] };
  const close = { action: 'close-window', axAction: 'AXPress', actionAttempted: true, axResult: 0,
    closeOutcome: 'native-termination', postIdentityVerified: false, postTerminationVerified: true,
    forceKillPerformed: false, permissionRequestsPerformed: false, before,
    actionStartedUptime: 100, actionReturnedUptime: 101, postInspectionCompletedUptime: 102,
    termination: { expectedProcess: owner.process, expectedWindow: owner.window, kernelMissingVerified: true,
      windowMissingVerified: true, imageBindingsVerified: true, firstKernelBytes: 0, firstKernelErrno: 3,
      lastKernelBytes: 0, lastKernelErrno: 3 } };
  const exit = { pid: owner.process.pid, code: 0, signal: null };
  assert.equal(probe.acceptedExit(close, exit, owner), true);
  const changes = [
    c => c.postIdentityVerified = true, c => c.postTerminationVerified = false, c => c.closeOutcome = 'unknown',
    c => delete c.termination, c => c.before.controls = {},
    c => c.after = before, c => c.axResult = -25204, c => c.actionAttempted = false,
    c => c.forceKillPerformed = true, c => c.permissionRequestsPerformed = true,
    c => c.error = 'native-bundle-id-unverified', c => c.postProcessStatus = { state: 'absent' },
    c => c.before.hasDialog = true, c => c.before.controls[0].pid++, c => c.before.controls[0].enabled = false,
    c => delete c.before.closeDialog, c => c.before.closeDialog.state = 'unknown',
    c => c.before.closeDialog.state = 'present', c => c.before.closeDialog.scope = 'all-client-absence',
    c => c.before.controls.push(structuredClone(c.before.controls[0])),
    c => c.termination.expectedProcess.startSeconds++, c => c.termination.expectedWindow.id++,
    c => c.termination.kernelMissingVerified = false, c => c.termination.windowMissingVerified = false,
    c => c.termination.imageBindingsVerified = false, c => c.termination.firstKernelBytes = 136,
    c => c.termination.firstKernelErrno = 0, c => c.termination.lastKernelBytes = 136,
    c => c.termination.lastKernelErrno = 1, c => c.termination.extra = true,
    c => c.postInspectionCompletedUptime = 99,
  ];
  for (const change of changes) {
    const changed = structuredClone(close); change(changed);
    assert.equal(probe.acceptedExit(changed, exit, owner), false);
  }
  for (const changed of [{ ...exit, pid: exit.pid + 1 }, { ...exit, code: 1 }, { ...exit, signal: 'SIGTERM' }, null]) {
    assert.equal(probe.acceptedExit(close, changed, owner), false);
  }
  assert.equal(probe.closeAssessment(close, exit, owner).helperPostIdentityVerified, false);
  assert.equal(probe.closeAssessment(close, exit, owner).helperPostTerminationVerified, true);
});

test('successful-shaped close output cannot accept a reused PID, unknown post-identity or a different Root', () => {
  const { owner } = ownership(), exit = { pid: owner.process.pid, code: 0, signal: null };
  const close = { action: 'close-window', axAction: 'AXPress', actionAttempted: true, postIdentityVerified: true,
    forceKillPerformed: false, permissionRequestsPerformed: false };
  assert.equal(probe.acceptedExit(close, exit, owner), false);
  const observation = { process: owner.process, window: owner.window, accessibilityTrusted: true, active: true, truncated: false,
    hasDialog: false, closeDialog: closeDialog() };
  const valid = { ...close, before: observation, after: observation };
  assert.equal(probe.acceptedExit(valid, { ...exit, pid: exit.pid + 1 }, owner), false);
  assert.equal(probe.acceptedExit({ ...valid, after: { ...observation, process: { ...owner.process, startSeconds: owner.process.startSeconds + 1 } } }, exit, owner), false);
  assert.equal(probe.acceptedExit({ ...valid, postProcessStatus: { state: 'different-process' } }, exit, owner), false);
});

test('Root readiness polling preserves the native CF window and stores changes only, never sleeping to guess readiness', () => {
  assert.match(probe.surfaceSource, /AXObserverAddNotification/);
  assert.match(probe.surfaceSource, /CFRunLoopRunInMode/);
  assert.match(probe.surfaceSource, /snapshot != previousSnapshot/);
  assert.match(probe.surfaceSource, /CFEqual\(current\[0\], window\)/);
  assert.match(probe.surfaceSource, /rootWebAreaObserved/);
  assert.doesNotMatch(probe.surfaceSource, /Thread.sleep|usleep\(|sleep\(/);
});

test('caller refuses missing/present/unknown or malformed finite close scope despite exit0 and other pins', () => {
  const { owner } = ownership(), exit = { pid: owner.process.pid, code: 0, signal: null };
  const observation = { process: owner.process, window: owner.window, accessibilityTrusted: true, active: true,
    truncated: false, hasDialog: false, closeDialog: closeDialog() };
  const receipt = { action: 'close-window', axAction: 'AXPress', actionAttempted: true, postIdentityVerified: true,
    forceKillPerformed: false, permissionRequestsPerformed: false, before: observation, after: observation };
  assert.equal(probe.acceptedExit(receipt, exit, owner), true);
  for (const value of [undefined, null, {}, { ...closeDialog(), state: 'unknown' }, { ...closeDialog(), state: 'present' },
    { ...closeDialog(), scope: 'all-client-absence' }, { ...closeDialog(), windowCount: 2 },
    { ...closeDialog(), childCount: -1 }, { ...closeDialog(), childCount: 512 }, { ...closeDialog(), childCount: '6' },
    { ...closeDialog(), actionAllowed: true }]) {
    assert.equal(probe.verifiedRootCloseDialog(value), false);
    assert.equal(probe.acceptedExit({ ...receipt, before: { ...observation, closeDialog: value } }, exit, owner), false);
  }
  assert.equal(probe.acceptedExit(receipt, exit, {}), false);
});

test('window bitmap refuses false/unknown permission and never calls capture without exact owned fences', async () => {
  const { owner } = ownership();
  let captures = 0;
  const denied = await probe.windowBitmapDiagnostic(owner, {
    fence: async () => ({ screenCaptureAccess: false }), capture: async () => { captures++; }, image: () => { throw Error('unexpected image read'); },
  });
  assert.equal(captures, 0); assert.equal(denied.completed, false); assert.equal(denied.reason, 'screen-capture-permission-unavailable');
  const unknown = await probe.windowBitmapDiagnostic(owner, {
    fence: async () => ({}), capture: async () => { captures++; }, image: () => { throw Error('unexpected image read'); },
  });
  assert.equal(captures, 0); assert.equal(unknown.completed, false);
});

test('window bitmap captures once between exact process/start/hash/bounds fences without changing acceptance', async () => {
  const { owner } = ownership(), order = [];
  const fence = { screenCaptureAccess: true, cgWindowFenceVerified: true, process: owner.process, window: owner.window,
    command: 'bitmap-fence', permissionRequestsPerformed: false, actionAttempted: false };
  const result = await probe.windowBitmapDiagnostic(owner, {
    fence: async stage => { order.push(stage); return fence; },
    capture: async id => { order.push(`capture:${id}`); return { exitCode: 0, signal: null }; },
    image: () => { order.push('image'); return { sha256: 'b'.repeat(64), width: 940, height: 580 }; },
  });
  assert.deepEqual(order, ['before', `capture:${owner.window.id}`, 'after', 'image']);
  assert.equal(result.completed, true);
  for (const key of Object.keys(probe.acceptance)) assert.equal(result[key], false);
  for (const mutate of [p => p.process.pid++, p => p.process.startSeconds++, p => p.process.image.sha256 = 'c'.repeat(64),
    p => p.window.id++, p => p.window.bounds.width++]) {
    let stage = 0;
    const drift = await probe.windowBitmapDiagnostic(owner, {
      fence: async () => { const value = structuredClone(fence); if (stage++) mutate(value); return value; },
      capture: async () => ({ exitCode: 0, signal: null }), image: () => { throw Error('drifted image must not be verified'); },
    });
    assert.equal(drift.completed, false);
  }
  const failed = await probe.windowBitmapDiagnostic(owner, {
    fence: async () => fence, capture: async () => ({ exitCode: 1, signal: null }),
    image: () => { throw Error('failed capture must not verify an image'); },
  });
  assert.equal(failed.completed, false); assert.ok(failed.after);
});

test('bitmap source preflights without prompting and has only exact-window noninteractive capture arguments', () => {
  assert.ok(probe.surfaceSource.includes('CGPreflightScreenCaptureAccess()'));
  assert.ok(!probe.surfaceSource.includes('CGRequestScreenCaptureAccess'));
  const { owner } = ownership(), file = path.join(scratch, 'root-window.png');
  assert.deepEqual(probe.bitmapArguments(owner.window.id, file), ['-l', String(owner.window.id), '-x', file]);
  for (const id of [0, -1, 0x100000000, NaN]) assert.throws(() => probe.bitmapArguments(id, file));
  assert.ok(source.includes("command('/usr/sbin/screencapture'"));
  const bitmapBranch = probe.surfaceSource.split('if bitmap {')[1].split('} else {')[0];
  assert.ok(bitmapBranch.includes('exit(0)'));
  assert.ok(!bitmapBranch.includes('AXUIElement') && !bitmapBranch.includes('CGRequest'));
});

test('bitmap output is bounded PNG metadata, not a visual or product acceptance claim', () => {
  const file = path.join(scratch, 'synthetic.png'), bytes = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'ascii'); bytes.writeUInt32BE(940, 16); bytes.writeUInt32BE(580, 20);
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  assert.equal(probe.bitmapImage(file).width, 940);
  bytes.writeUInt32BE(0, 16); fs.writeFileSync(file, bytes); assert.throws(() => probe.bitmapImage(file));
  fs.writeFileSync(file, 'not a bitmap'); assert.throws(() => probe.bitmapImage(file));
});

test('orchestrator uses one unchanged pinned helper, one Root spawn and one normal close without fallback', () => {
  assert.match(source, /admission\(env, process.platform, process.arch\)[\s\S]*?const request = options/);
  assert.match(source, /write\('native-macos-window.swift', source.bytes\)/);
  assert.match(source, /spawn\(executable, \[\], \{ cwd: rootEnv.HOME, env: rootEnv/);
  assert.equal(source.match(/spawn\(executable,/g).length, 1);
  assert.equal(source.match(/\['close', path.join\(output, 'owner.json'\)\]/g).length, 1);
  assert.doesNotMatch(source, /\.kill\(|process.kill|\.activate\(|osascript|NSWorkspace|AXIsProcessTrustedWithOptions|CGEventPost|AXUIElementPerformAction|\.rmSync\(|['"]press['"]|killSignal/);
  assert.match(source, /owner-file-drift-no-close-attempted/);
  assert.match(source, /output-must-not-modify-the-pinned-app/);
  assert.match(source, /exact-native-thin-mach-o-required/);
  assert.match(source, /flag: 'wx'/);
});

test('surface sampler is read-only and binds kernel parent/start/path/images plus the one owned CG/AX root', () => {
  assert.match(probe.surfaceSource, /info.pbi_ppid == parent/);
  assert.match(probe.surfaceSource, /info.pbi_start_tvsec/);
  assert.match(probe.surfaceSource, /proc_pidpath/);
  assert.match(probe.surfaceSource, /imageMatches\(app \+ "\/Contents\/Info.plist"/);
  assert.match(probe.surfaceSource, /\.optionIncludingWindow/);
  assert.match(probe.surfaceSource, /matches.count == 1/);
  assert.match(probe.surfaceSource, /try pidMatches\(item, pid\)/);
  assert.match(probe.surfaceSource, /depth <= 16 && seen.count < 512/);
  assert.match(probe.surfaceSource, /systemUptime \+ 4/);
  assert.match(probe.surfaceSource, /contained && labelRoles.contains\(role\)/);
  assert.doesNotMatch(probe.surfaceSource, /AXUIElementPerformAction|AXUIElementSetAttributeValue|AXValueAttribute|CreateSystemWide|\.activate\(|AXIsProcessTrustedWithOptions|CGRequestScreenCaptureAccess|terminate|kill/);
  assert.match(probe.surfaceSource, /try fence\(p, parent\); try checkCG\(\)/);
});

// Synthetic facts model results of native checks, not proof from a saved receipt.
function remoteFacts() {
  return { nodeIdentityVerified: true, parentMatchesTraversalParent: true, windowMatchesHeldRoot: true,
    rootUnchanged: true, withinLimits: true, metadataOnly: true };
}

function linkFailure(phase = 'before-metadata') {
  const read = attribute => ({ attribute, axError: 0, axErrorName: 'success', timeoutSetAXError: 0, messageTimeoutSeconds: 0.2,
    elapsedMilliseconds: 1, returnedCFTypeID: 5, expectedElementCFTypeID: 5, valuePresent: true, cfEqual: true });
  return { kind: 'remote-links', phase, node: { path: 'root-window/0/0', depth: 2, role: null, pid: 52, rootPID: 42, windowID: 71,
    referenceKind: 'traversal-node', referenceScope: 'native-invocation', cfTypeID: 5, pidSource: 'native-read' },
    parent: { ...read('AXParent'), cfEqual: false }, window: read('AXWindow') };
}
test('remote failure metadata distinguishes native read error, missing value, wrong type and unequal CF without accepting any', async () => {
  const { owner } = ownership();
  for (const phase of ['before-metadata', 'after-metadata']) for (const parent of [
    { cfEqual: false }, { axError: -25204, axErrorName: 'cannot-complete', valuePresent: false, returnedCFTypeID: null, cfEqual: null },
    { valuePresent: false, returnedCFTypeID: null, cfEqual: null }, { returnedCFTypeID: 7, cfEqual: null },
  ]) {
    const d = linkFailure(phase); Object.assign(d.parent, parent);
    assert.doesNotThrow(() => probe.validateLinkFailure(d, 'remote-ax-parent-unverified'));
    let samples = 0;
    const result = await probe.rootSurfaceDiagnostic(owner, { inspectRoot: async () => rootInspection(owner), sample: async () => {
      samples++; return { exitCode: 2, signal: null, timedOut: false, receipt: { complete: false, error: 'remote-ax-parent-unverified', errorDetail: d } };
    } });
    assert.equal(samples, 1); assert.equal(result.completed, false); assert.equal(result.reason, 'root-surface-capture-unverified');
    assert.deepEqual(result.surface.errorDetail, d);
  }
  const window = linkFailure(); window.parent.cfEqual = true; window.window.cfEqual = false;
  assert.doesNotThrow(() => probe.validateLinkFailure(window, 'remote-ax-window-unverified'));
});
test('remote diagnostic parser refuses malformed phase/status/type/node/value/equality and metadata cannot grant actions', () => {
  for (const mutate of [d => d.phase = 'later', d => d.node.depth++, d => d.node.path += '/999', d => d.node.pid = d.node.rootPID,
    d => d.node.title = 'unexpected', d => d.parent.axError = '0', d => d.parent.axError = 2 ** 40,
    d => d.parent.returnedCFTypeID = -1, d => d.parent.valuePresent = false, d => d.parent.cfEqual = 'false',
    d => d.parent.axError = -25204, d => d.parent.messageTimeoutSeconds = 20, d => d.parent.elapsedMilliseconds = Infinity,
    d => d.parent.cfEqual = true, d => d.parent.actionAllowed = true, d => d.window.attribute = 'AXValue']) {
    const d = linkFailure(); mutate(d); assert.throws(() => probe.validateLinkFailure(d, 'remote-ax-parent-unverified'));
  }
  const links = probe.surfaceSource.split('func remoteLinks')[1].split('func visit')[0];
  assert.equal(links.match(/AXUIElementCopyAttributeValue\(/g).length, 1);
  assert.match(links, /let parentRead = link\(kAXParentAttribute, traversalParent\), windowRead = link\(kAXWindowAttribute, window\)/);
  assert.match(links, /status == \.success \? value : nil/);
  assert.match(links, /catch let failure as Denied[\s\S]*throw Denied\(failure.reason/);
  assert.doesNotMatch(links, /kAXRoleAttribute|kAXValueAttribute|AXUIElementPerformAction|Thread.sleep|while |for /);
});
test('bounded zero/no-value/unsupported child observations retain numeric facts, not claims of document absence', () => {
  const node = { ...linkFailure().node, role: 'AXGroup', pid: 42 };
  const d = { operation: 'AXUIElementGetAttributeValueCount', attribute: 'AXChildren', phase: 'traversal', revision: 0,
    axError: 0, axErrorName: 'success', timeoutSetAXError: 0, returnedCFTypeID: null, elapsedMilliseconds: 1,
    count: 0, countExact: '0', countVerified: true, node };
  for (const [axError, axErrorName] of [[0, 'success'], [-25205, 'attribute-unsupported'], [-25212, 'no-value']]) {
    assert.doesNotThrow(() => probe.validateChildObservations({ childObservations: [{ ...d, axError, axErrorName, countVerified: axError === 0 }], childObservationsTruncated: false }));
  }
  for (const mutate of [v => v.childObservations = Array(33).fill(d), v => v.childObservationsTruncated = 'false',
    v => v.childObservations[0].count = 1, v => v.childObservations[0].countExact = 'bad', v => v.childObservations[0].axError = -25204,
    v => v.childObservations[0].axErrorName = 'no-value', v => v.childObservations[0].node.role = null,
    v => v.childObservations[0].returnedCFTypeID = 5, v => v.childObservations[0].elapsedMilliseconds = -1]) {
    const v = { childObservations: [structuredClone(d)], childObservationsTruncated: false }; mutate(v);
    assert.throws(() => probe.validateChildObservations(v));
  }
  assert.match(probe.surfaceSource, /childObservations.count < 32/);
  assert.match(probe.surfaceSource, /else \{ childObservationsTruncated = true \}/);
  assert.match(probe.surfaceSource, /childObservations = \[\]; childObservationsTruncated = false/);
});

test('remote read policy requires every native association, identity, fence, bound and metadata-only fact', () => {
  assert.equal(probe.remoteReadPolicy(remoteFacts()).readOnly, true);
  for (const key of Object.keys(remoteFacts())) {
    for (const invalid of [false, undefined, null, 'true', 1, {}, []]) {
      const facts = remoteFacts(); facts[key] = invalid;
      assert.throws(() => probe.remoteReadPolicy(facts), undefined, `${key}:${String(invalid)}`);
    }
    const missing = remoteFacts(); delete missing[key];
    assert.throws(() => probe.remoteReadPolicy(missing));
  }
  for (const unknown of [undefined, null, {}, 'linked', true]) assert.throws(() => probe.remoteReadPolicy(unknown));
});

test('different parent/window, missing links or unchanged-looking PID/name/uid cannot admit remote metadata', () => {
  let metadataReads = 0;
  const capture = facts => { const policy = probe.remoteReadPolicy(facts); metadataReads++; return policy; };
  for (const changed of [
    { parentMatchesTraversalParent: false }, { windowMatchesHeldRoot: false },
    { parentMatchesTraversalParent: undefined }, { windowMatchesHeldRoot: undefined },
    { rootUnchanged: false }, { nodeIdentityVerified: false }, { withinLimits: false },
  ]) assert.throws(() => capture({ ...remoteFacts(), ...changed }));
  // These facts match the retained Intel diagnostic but do not authorize a read.
  assert.throws(() => capture({ pid: 7638, rootPID: 7628, kernelParentPID: 1, uid: 501, sameUID: true,
    processName: 'WebKit', rootStillOwned: true, rootNativeCFReferenceUnchanged: true }));
  assert.equal(metadataReads, 0);
});

test('linked remote policy returns only a frozen read-only diagnostic result, never action or product acceptance', () => {
  const facts = remoteFacts(), before = structuredClone(facts), policy = probe.remoteReadPolicy(facts);
  assert.deepEqual(facts, before); assert.equal(Object.isFrozen(policy), true);
  assert.equal(policy.diagnosticOnly, true); assert.equal(policy.actionAllowed, false);
  for (const key of Object.keys(probe.acceptance)) assert.equal(policy[key], false);
  assert.throws(() => probe.remoteReadPolicy({ ...facts, metadataOnly: false, action: 'AXPress' }));
});

test('generated Swift enforces the same fail-closed policy; facts are native, not receipt or PID ancestry assertions', () => {
  const policy = probe.surfaceSource.split('func requireRemoteRead')[1].split('func imageMatches')[0];
  for (const key of Object.keys(remoteFacts())) assert.ok(policy.includes(`facts["${key}"] == true`));
  const links = probe.surfaceSource.split('func remoteLinks')[1].split('func visit')[0];
  assert.match(links, /var parentMatches = false, windowMatches = false/);
  assert.match(links, /let traversalParent = traversalParent, let linked = parentRead\.0, CFGetTypeID\(linked\) == AXUIElementGetTypeID\(\)/);
  assert.match(links, /parentMatches = CFEqual\(linked as! AXUIElement, traversalParent\)/);
  assert.match(links, /let linked = windowRead\.0, CFGetTypeID\(linked\) == AXUIElementGetTypeID\(\)/);
  assert.match(links, /windowMatches = CFEqual\(linked as! AXUIElement, window\)/);
  assert.doesNotMatch(links, /JSONSerialization|pbi_ppid|pbi_uid|proc_pidpath|kAXRoleAttribute|kAXTitleAttribute|kAXDescriptionAttribute|kAXChildrenAttribute/);
});

test('remote metadata is bracketed by native Root/CF/process/link fences before row publication and recursion', () => {
  const held = probe.surfaceSource.split('func checkHeldRoot')[1].split('func remoteLinks')[0];
  assert.match(held, /try fence\(p, parent\); try checkCG\(\)/);
  assert.match(held, /AXIsProcessTrusted\(\).*systemUptime < deadline/);
  assert.match(held, /try pidMatches\(item, pid\)/);
  assert.match(held, /current.count == 1 && CFEqual\(current\[0\], window\)/);
  const visit = probe.surfaceSource.split('func visit')[1].split('var previousSnapshot')[0];
  const before = visit.indexOf('if remote {'), metadata = visit.indexOf('kAXRoleAttribute');
  assert.ok(before >= 0 && visit.indexOf('try checkHeldRoot()', before) < metadata);
  assert.ok(visit.indexOf('remoteBefore = try remoteProcess(readPID)', before) < metadata);
  assert.ok(visit.indexOf('try remoteLinks(item, traversalParent, depth, path, readPID, "before-metadata")', before) < metadata);
  const descendants = visit.indexOf('let descendants = try children(item, kAXChildrenAttribute, "traversal", childNode)');
  const after = visit.indexOf('if remote {', descendants), published = visit.indexOf('rows.append(row)');
  assert.ok(descendants > metadata && after > descendants && published > after);
  assert.match(visit.slice(after, published), /try elementPID\(item\) == readPID/);
  assert.match(visit.slice(after, published), /try remoteProcess\(readPID\) == remoteBefore/);
  assert.match(visit.slice(after, published), /try remoteLinks\(item, traversalParent, depth, path, readPID, "after-metadata"\)[\s\S]*?try checkHeldRoot\(\)/);
  assert.match(visit.slice(published), /try visit\(child, depth \+ 1, path \+ "\/" \+ String\(index\), item\)/);
  // Association checks precede the seen check, so a repeated CF object cannot
  // silently bypass refusal when reached through an inconsistent parent.
  assert.ok(visit.indexOf('try remoteLinks(item, traversalParent, depth, path, readPID, "before-metadata")') < visit.indexOf('if seen.contains'));
});

test('remote metadata keeps actual PID, finite traversal/time/message limits and no action/value/permission API', () => {
  assert.match(probe.surfaceSource, /"pid": readPID, "rootPID": pid/);
  assert.match(probe.surfaceSource, /"association": remote \? "native-parent-and-root-window" : "root-pid"/);
  assert.match(probe.surfaceSource, /AXUIElementSetMessagingTimeout\(item, 0\.2\) == \.success/);
  assert.match(probe.surfaceSource, /depth <= 16 && seen.count < 512 && ProcessInfo.processInfo.systemUptime < deadline/);
  assert.match(probe.surfaceSource, /readinessDeadline = ProcessInfo.processInfo.systemUptime \+ 20/);
  assert.match(probe.surfaceSource, /systemUptime \+ 4/);
  assert.match(probe.surfaceSource, /observationCount < 32/);
  assert.match(probe.surfaceSource, /role.utf8.count <= 128/);
  assert.match(probe.surfaceSource, /text.utf8.count <= 2048/);
  const remoteProcess = probe.surfaceSource.split('func remoteProcess')[1].split('func requireRemoteRead')[0];
  assert.match(remoteProcess, /info.pbi_pid == UInt32\(pid\).*info.pbi_start_tvsec > 0.*info.pbi_start_tvusec < 1000000/);
  assert.doesNotMatch(remoteProcess, /pbi_ppid|pbi_uid|processName|proc_name/);
  assert.doesNotMatch(probe.surfaceSource, /AXUIElementPerformAction|AXUIElementSetAttributeValue|AXUIElementCopyActionNames|kAXPressAction|kAXCloseButtonAttribute|kAXValueAttribute|CreateSystemWide|AXIsProcessTrustedWithOptions|CGRequestScreenCaptureAccess|NSRunningApplication/);
});

test('reviewed Root close helper retains native target and consent authority before its sole action', () => {
  const helper = fs.readFileSync(path.join(__dirname, 'native-macos-window.swift'));
  // Reviewed finite Root close scope; consent traversal and native target authority are unchanged.
  const reviewedSource = helper.toString('utf8').replace(/\r\n/g, '\n');
  const sourceHash = value => crypto.createHash('sha256').update(value.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
  assert.equal(sourceHash(reviewedSource), '212a8c94149d159da69c4161220333969fbc71bd555ee951c26d9ff04bae2a68');
  assert.equal(sourceHash(reviewedSource.replace(/\n/g, '\r\n')), sourceHash(reviewedSource));
  const swift = helper.toString('utf8');
  assert.match(swift, /AXUIElementGetPid\(item, &pid\) == \.success, pid == expected else \{ throw Refusal\("foreign-ax-element"\)/);
  assert.match(swift, /do \{ try axPID\(item, identity.pid\) \}[\s\S]*?catch \{ throw Refusal\("foreign-ax-element"/);
  assert.equal(swift.match(/AXUIElementPerformAction\(/g).length, 1);
  const action = swift.slice(swift.indexOf('try axPID(target, owner.process.pid)'));
  assert.match(action, /CFEqual\(targetWindow, fenceWindow\)[\s\S]*?try admission\(\); try trustedAX\(\)[\s\S]*?AXUIElementPerformAction/);
  assert.doesNotMatch(swift, /remoteReadPolicy|requireRemoteRead|native-parent-and-root-window/);
});

test('sampler diagnostics retain source hashes and all false acceptance flags without relaxing normal-close errors', () => {
  assert.match(source, /report.helper = \{ path: helper, image: helperImage, sourceSha256: source.image.sha256 \}/);
  assert.match(source, /report.sampler = \{ path: sampler, image: samplerImage, sourceSha256: crypto.createHash\('sha256'\).update\(surfaceSource, 'utf8'\).digest\('hex'\) \}/);
  assert.match(probe.surfaceSource, /value\["diagnosticOnly"\] = true/);
  assert.match(probe.surfaceSource, /for key in \["nativeGuiAccepted", "mcpAccepted", "migrationAccepted", "updateAccepted", "releaseReady"\] \{ value\[key\] = false \}/);
  assert.match(source, /requireThat\(close.exitCode === 0, 'normal-close-refused-or-post-identity-unverified'\)/);
});

function rootInspection(owner) {
  return { command: 'inspect-root', complete: true, readOnly: true, diagnosticOnly: true, rootWindowOnly: true,
    accessibilityTrusted: true, rootNativeCFReferencePreserved: true, rootReferenceScope: 'native-invocation',
    actionAttempted: false, permissionRequestsPerformed: false, process: structuredClone(owner.process),
    window: structuredClone(owner.window), ...probe.acceptance };
}
function rootSample(owner) {
  return { exitCode: 0, signal: null, timedOut: false, receipt: {
    complete: true, readOnly: true, diagnosticOnly: true, actionAttempted: false, permissionRequestsPerformed: false,
    process: structuredClone(owner.process), window: structuredClone(owner.window),
    readiness: { rootWebAreaObserved: true, rootNativeCFReferencePreserved: true },
    nodes: [{ role: 'AXWebArea', pid: 51 }], ...probe.acceptance,
  } };
}

test('root-only receipts refuse false/unknown fences, action/control metadata and changed Root identity', () => {
  const { owner } = ownership();
  assert.doesNotThrow(() => probe.validateRootInspection(rootInspection(owner), owner));
  for (const key of ['complete', 'readOnly', 'diagnosticOnly', 'rootWindowOnly', 'accessibilityTrusted', 'rootNativeCFReferencePreserved']) {
    for (const value of [false, undefined, 'true', 1]) {
      assert.throws(() => probe.validateRootInspection({ ...rootInspection(owner), [key]: value }, owner));
    }
  }
  for (const changed of [{ command: 'inspect' }, { rootReferenceScope: 'serialized-cf-reference' },
    { actionAttempted: true }, { permissionRequestsPerformed: true }, { nativeGuiAccepted: true },
    { controls: [] }, { nodes: [] }, { observation: {} }, { action: 'close-window' }, { error: 'foreign-ax-element' }]) {
    assert.throws(() => probe.validateRootInspection({ ...rootInspection(owner), ...changed }, owner));
  }
  for (const mutate of [r => r.process.pid++, r => r.process.startSeconds++, r => r.process.image.sha256 = 'b'.repeat(64),
    r => r.window.pid++, r => r.window.id++, r => r.window.bounds.width++]) {
    const receipt = rootInspection(owner); mutate(receipt);
    assert.throws(() => probe.validateRootInspection(receipt, owner));
  }
});

test('root-only diagnostic samples independently of full-tree action ownership and cannot accept normal-close', async () => {
  const { owner } = ownership(), calls = [];
  const result = await probe.rootSurfaceDiagnostic(owner, {
    inspectRoot: async stage => { calls.push(stage); return rootInspection(owner); },
    sample: async () => { calls.push('sample'); return rootSample(owner); },
    inspectControls: () => { throw Error('action helper must not gate diagnostic reads'); },
  });
  assert.deepEqual(calls, ['before', 'sample', 'after']);
  assert.equal(result.completed, true); assert.equal(result.diagnosticOnly, true);
  for (const key of Object.keys(probe.acceptance)) assert.equal(result[key], false);
  assert.equal(probe.acceptedExit(result, { pid: owner.process.pid, code: 0, signal: null }, owner), false);
  assert.equal(probe.acceptedExit(result.before, { pid: owner.process.pid, code: 0, signal: null }, owner), false);
});

test('unknown/foreign root-only pre-inspection prevents sampling without a full-tree fallback', async () => {
  const { owner } = ownership(); let sampled = 0;
  for (const receipt of [undefined, {}, { ...rootInspection(owner), accessibilityTrusted: false },
    { ...rootInspection(owner), command: 'inspect', observation: { process: owner.process, window: owner.window } }]) {
    const result = await probe.rootSurfaceDiagnostic(owner, {
      inspectRoot: async () => receipt,
      sample: async () => { sampled++; return rootSample(owner); },
    });
    assert.equal(result.completed, false); assert.equal(result.reason, 'read-only-root-inspection-unverified');
  }
  assert.equal(sampled, 0);
});

test('changed post-inspection Root rejects sampled metadata; new read-only authority never replaces an action fence', async () => {
  const { owner } = ownership();
  for (const mutate of [r => r.process.startMicroseconds++, r => r.window.id++, r => r.window.bounds.x++,
    r => r.rootNativeCFReferencePreserved = false, r => r.permissionRequestsPerformed = true]) {
    const result = await probe.rootSurfaceDiagnostic(owner, {
      inspectRoot: async stage => { const receipt = rootInspection(owner); if (stage === 'after') mutate(receipt); return receipt; },
      sample: async () => rootSample(owner),
    });
    assert.equal(result.completed, false); assert.equal(result.reason, 'read-only-root-inspection-unverified');
    assert.equal(result.nativeGuiAccepted, false);
  }
});

test('missing WebArea, failed native sample and throwing sampler retain post-root diagnostics without claiming capture', async () => {
  const { owner } = ownership();
  for (const mode of ['no-web-area', 'missing-web-area-node', 'exit-failed', 'process-drift', 'throw']) {
    const calls = [];
    const result = await probe.rootSurfaceDiagnostic(owner, {
      inspectRoot: async stage => { calls.push(stage); return rootInspection(owner); },
      sample: async () => {
        calls.push('sample');
        if (mode === 'throw') throw Error('native-sample-refused');
        const sample = rootSample(owner);
        if (mode === 'no-web-area') { sample.receipt.complete = false; sample.receipt.readiness.rootWebAreaObserved = false; }
        if (mode === 'missing-web-area-node') sample.receipt.nodes = [{ role: 'AXGroup' }];
        if (mode === 'exit-failed') sample.exitCode = 2;
        if (mode === 'process-drift') sample.receipt.process.pid++;
        return sample;
      },
    });
    assert.deepEqual(calls, ['before', 'sample', 'after']); assert.equal(result.completed, false);
    assert.equal(result.after.rootNativeCFReferencePreserved, true);
    for (const key of Object.keys(probe.acceptance)) assert.equal(result[key], false);
  }
});

test('root-only native branch exits before observer/control traversal and preserves Root CF/process/image fences', () => {
  const branch = probe.surfaceSource.split('if rootOnly {')[1].split('var seen =')[0];
  assert.match(branch, /try checkHeldRoot\(\)/);
  assert.match(branch, /"command": "inspect-root", "complete": true, "readOnly": true, "rootWindowOnly": true/);
  assert.match(branch, /"rootReferenceScope": "native-invocation"/);
  assert.match(branch, /"actionAttempted": false, "permissionRequestsPerformed": false\]\); exit\(0\)/);
  assert.doesNotMatch(branch, /AXObserver|kAXChildrenAttribute|visit\(|kAXTitleAttribute|kAXDescriptionAttribute|AXUIElementPerformAction/);
  const fence = probe.surfaceSource.split('func checkHeldRoot')[1].split('if rootOnly {')[0];
  assert.match(fence, /try fence\(p, parent\); try checkCG\(\)/);
  assert.match(fence, /children\(root, kAXWindowsAttribute, "root-window-recheck", applicationNode\)/);
  assert.match(fence, /try pidMatches\(item, pid\)/);
  assert.match(fence, /current.count == 1 && CFEqual\(current\[0\], window\)/);
  assert.doesNotMatch(fence, /kAXChildrenAttribute|visit\(/);
  assert.match(probe.surfaceSource, /args.count == \(rootOnly \? 3 : 2\) && AXIsProcessTrusted\(\)/);
});

test('orchestrator brackets sampler with root-only inspections, retains owner/image guards and leaves normal-close unchanged', () => {
  const capture = source.split('report.rootSurface = await rootSurfaceDiagnostic')[1].split('report.captureCompleted = true')[0];
  assert.match(capture, /command\(sampler, \['inspect-root', ownerPath, String\(process.pid\)\]/);
  assert.match(capture, /command\(sampler, \[ownerPath, String\(process.pid\)\]/);
  assert.match(capture, /captureOwnerFence\(\)/);
  assert.doesNotMatch(source, /command\(helper, \['inspect',/);
  assert.match(source, /!toolUncertain && !ownedExit && sameImage\(pin\(ownerPath, 8192\).image, ownerImage\)/);
  assert.match(source, /owner-file-drift-no-close-attempted/);
  assert.match(source, /command\(helper.path, \['close', path.join\(output, 'owner.json'\)\]/);
  assert.match(source, /requireThat\(close.exitCode === 0, 'normal-close-refused-or-post-identity-unverified'\)/);
  assert.match(source, /Object.assign\(report, probeCompletion\(report, closeReceipt, ownedExit, owner, rootPid, toolUncertain, diagnosticToolUncertain\)\)/);
  assert.match(source, /const accepted = acceptedExit\(close, exit, owner\) && !report.closeError/);
});

function childrenFailure(changed = {}) {
  return { operation: 'AXUIElementGetAttributeValueCount', attribute: 'AXWindows', phase: 'root-window-discovery',
    classification: 'native-error', axError: -25204, axErrorName: 'cannot-complete', timeoutSetAXError: 0,
    messageTimeoutSeconds: 0.2, elapsedMilliseconds: 201.5, count: 0, countExact: '0', countVerified: false,
    returnedCFTypeID: null, returnedCount: null, unexpectedChildIndex: null, unexpectedChildCFTypeID: null,
    expectedArrayCFTypeID: 19, expectedElementCFTypeID: 23,
    node: { path: 'root-application', depth: -1, role: null, pid: 42, rootPID: 42, windowID: 71,
      referenceKind: 'root-application', referenceScope: 'native-invocation', cfTypeID: 23, pidSource: 'application-reference' },
    ...changed };
}

test('AX child failures retain numeric errors, exact counts and unknown types without claiming timeout or ownership', () => {
  const fixtures = [childrenFailure(), childrenFailure({ phase: 'root-window-recheck', axError: -25201, axErrorName: 'illegal-argument' }),
    childrenFailure({ axError: -25212, axErrorName: 'no-value' }),
    childrenFailure({ axError: -25205, axErrorName: 'attribute-unsupported' }),
    childrenFailure({ axError: -12345, axErrorName: 'other', timeoutSetAXError: -25202 }),
    childrenFailure({ classification: 'count-out-of-range', axError: 0, axErrorName: 'success', count: -1, countExact: '-1', countVerified: true }),
    childrenFailure({ classification: 'count-out-of-range', axError: 0, axErrorName: 'success', count: 513, countExact: '513', countVerified: true }),
    childrenFailure({ classification: 'count-out-of-range', axError: 0, axErrorName: 'success', count: Number('9223372036854775807'),
      countExact: '9223372036854775807', countVerified: true })];
  for (const detail of fixtures) {
    const saved = structuredClone(detail);
    assert.doesNotThrow(() => probe.validateChildrenFailure(detail));
    assert.deepEqual(detail, saved);
    assert.ok(JSON.stringify(detail).length < 1400);
    assert.equal('timedOut' in detail, false); assert.equal('ownershipVerified' in detail.node, false);
    assert.equal('actionAllowed' in detail, false);
  }
});

test('bounded copy/type/count diagnostics identify a cached held-window or traversal node without reading child values', () => {
  const base = childrenFailure({ operation: 'validate-values', attribute: 'AXChildren', phase: 'traversal',
    classification: 'missing-array', axError: 0, axErrorName: 'success', count: 2, countExact: '2', countVerified: true,
    node: { path: 'root-window', depth: 0, role: 'AXWindow', pid: 42, rootPID: 42, windowID: 71,
      referenceKind: 'held-root-window', referenceScope: 'native-invocation', cfTypeID: 23, pidSource: 'native-read' } });
  for (const changed of [{}, { classification: 'wrong-array-type', returnedCFTypeID: 7 },
    { classification: 'array-count-mismatch', returnedCFTypeID: 19, returnedCount: 1 },
    { classification: 'missing-child-value', returnedCFTypeID: 19, returnedCount: 2, unexpectedChildIndex: 0 },
    { classification: 'wrong-child-type', returnedCFTypeID: 19, returnedCount: 2, unexpectedChildIndex: 1, unexpectedChildCFTypeID: 7 },
    { classification: 'bridge-failed', returnedCFTypeID: 19, returnedCount: 2 },
    { operation: 'AXUIElementCopyAttributeValues', classification: 'native-error', axError: -25204, axErrorName: 'cannot-complete' }]) {
    assert.doesNotThrow(() => probe.validateChildrenFailure({ ...base, ...changed }));
  }
  const remote = { ...base, node: { ...base.node, path: 'root-window/0/511', depth: 2, role: 'AXGroup', pid: 52, referenceKind: 'traversal-node' } };
  assert.doesNotThrow(() => probe.validateChildrenFailure(remote));
  assert.equal(remote.node.referenceScope, 'native-invocation');
});

test('malformed or expanded child diagnostics reject rather than turning arbitrary values into trusted metadata', () => {
  for (const invalid of [undefined, null, {}, [], 'failed']) assert.throws(() => probe.validateChildrenFailure(invalid));
  for (const mutate of [d => delete d.countVerified, d => d.operation = 'AXUIElementCopyAttributeValue', d => d.attribute = 'AXValue',
    d => d.phase = 'action', d => d.classification = 'timeout-proven', d => d.axError = 'cannotComplete', d => d.axError = -Infinity,
    d => d.timeoutSetAXError = null, d => d.messageTimeoutSeconds = 1, d => d.elapsedMilliseconds = NaN,
    d => d.elapsedMilliseconds = Infinity, d => d.elapsedMilliseconds = -1, d => d.countExact = '9'.repeat(20),
    d => d.countExact = 'not-a-number', d => d.countExact = '1', d => d.countVerified = 'false',
    d => d.returnedCFTypeID = {}, d => d.unexpectedChildIndex = 512, d => d.unexpectedChildCFTypeID = [],
    d => d.expectedElementCFTypeID = -1, d => d.node = [], d => d.node.path = 'root-window/0'.repeat(17),
    d => d.node.path = 'root-window/999', d => d.node.depth = 17, d => d.node.role = '\u00e9'.repeat(65),
    d => d.node.pid = 0, d => d.node.rootPID = 2147483648, d => d.node.windowID = 0,
    d => d.node.referenceScope = 'serialized-cf-authority', d => d.node.pidSource = 'name-or-uid',
    d => d.node.title = 'private label', d => d.children = Array(513).fill('value'), d => d.actionAllowed = true,
    d => d.classification = 'count-out-of-range', d => d.countVerified = true]) {
    const detail = childrenFailure(); mutate(detail); assert.throws(() => probe.validateChildrenFailure(detail));
  }
});

test('child refusal detail survives unchanged between valid root-only fences and never accepts capture or retries', async () => {
  const { owner } = ownership();
  for (const detail of [childrenFailure(), { ...childrenFailure(), title: 'unexpected metadata' }]) {
    const calls = [], sample = rootSample(owner);
    sample.exitCode = 2; sample.receipt.complete = false; sample.receipt.nodes = [];
    sample.receipt.error = 'ax-children-unbounded-or-unreadable'; sample.receipt.errorDetail = detail;
    const result = await probe.rootSurfaceDiagnostic(owner, {
      inspectRoot: async stage => { calls.push(stage); return rootInspection(owner); },
      sample: async () => { calls.push('sample'); return sample; },
    });
    assert.deepEqual(calls, ['before', 'sample', 'after']); assert.equal(result.completed, false);
    assert.equal(result.surface.error, 'ax-children-unbounded-or-unreadable'); assert.deepEqual(result.surface.errorDetail, detail);
    assert.equal(result.reason, 'title' in detail ? 'ax-children-diagnostic-invalid' : 'root-surface-capture-unverified');
    for (const key of Object.keys(probe.acceptance)) assert.equal(result[key], false);
  }
  const acceptedShape = rootSample(owner); acceptedShape.receipt.errorDetail = childrenFailure();
  const rejected = await probe.rootSurfaceDiagnostic(owner, { inspectRoot: async () => rootInspection(owner), sample: async () => acceptedShape });
  assert.equal(rejected.completed, false); assert.equal(rejected.reason, 'ax-children-diagnostic-invalid');
});

test('native child diagnostics preserve refusal strings and bounds, with no post-failure AX reads or fallback', () => {
  const children = probe.surfaceSource.split('func children(')[1].split('func pidMatches')[0];
  assert.equal(children.match(/AXUIElementGetAttributeValueCount\(/g).length, 1);
  assert.equal(children.match(/AXUIElementCopyAttributeValues\(/g).length, 1);
  assert.match(children, /if status == \.noValue \|\| status == \.attributeUnsupported \{ return \[\] \}/);
  assert.match(children, /if status != \.success \|\| count < 0 \|\| count > 512/);
  assert.match(children, /let timeoutStatus = AXUIElementSetMessagingTimeout\(item, 0\.2\)/);
  assert.match(children, /"axError": result.rawValue, "axErrorName": axErrorName\(result\)/);
  assert.match(children, /"count": count, "countExact": String\(count\), "countVerified": status == \.success/);
  assert.match(children, /"unexpectedChildCFTypeID": badType.map/);
  assert.ok(children.indexOf('if arrayType != CFArrayGetTypeID()') < children.indexOf('CFArrayGetCount(array)'));
  assert.ok(children.indexOf('if actualCount != count') < children.indexOf('for index in 0..<actualCount'));
  assert.match(children, /guard let raw = CFArrayGetValueAtIndex/);
  assert.match(children, /childType != AXUIElementGetTypeID\(\)/);
  assert.doesNotMatch(children, /attr\(|AXUIElementCopyAttributeValue\(|kAXRoleAttribute|kAXTitleAttribute|Thread.sleep|while |AXUIElementPerformAction/);
  const cached = probe.surfaceSource.split('func childrenNode')[1].split('func children(')[0];
  assert.doesNotMatch(cached, /attr\(|AXUIElementGetPid|AXUIElementCopyAttribute/);
  assert.match(probe.surfaceSource, /childrenNode\(root, "root-application", -1, nil, pid, pid, id, "root-application"\)/);
  assert.match(probe.surfaceSource, /children\(root, kAXWindowsAttribute, "root-window-discovery", applicationNode\)/);
  assert.match(probe.surfaceSource, /if let detail = \(error as\? Denied\)\?\.detail \{ failure\["errorDetail"\] = detail \}/);
  assert.match(probe.surfaceSource, /emit\(failure\); exit\(2\)/);
});

async function compileSwift(file, binary) {
  const child = spawn('/usr/bin/swiftc', [file, '-o', binary], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; child.stderr.on('data', data => { if (errors.length < 1048576) errors += data; });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      uncertainCompiler = true; child.stderr.unref?.(); child.unref();
      reject(Error(`compiler timeout; no termination attempted; evidence retained at ${scratch}`));
    }, 120000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.equal(result.code, 0, errors); assert.equal(result.signal, null);
}

test('kernel refusal metadata uses one captured read and keeps parent/uid/start fences and original refusal', () => {
  const fence = probe.surfaceSource.split('func fence(')[1].split('func packageFields(')[0];
  assert.equal(fence.match(/proc_pidinfo\(/g).length, 1);
  assert.match(fence, /errno = 0/);
  assert.match(fence, /kernelErrno = errno/);
  assert.match(fence, /try requireKernelFence\(p, parent, pid, info, bytes, kernelErrno, getuid\(\)\)/);
  const check = probe.surfaceSource.split('func requireKernelFence(')[1].split('func fence(')[0];
  for (const field of ['pid', 'ppid', 'uid', 'ruid', 'start_tvsec', 'start_tvusec']) assert.match(check, new RegExp(`info\\.pbi_${field}`));
  assert.match(check, /throw Denied\("owned-process-start-drift", detail:/);
  assert.match(check, /"observed": complete \? observed as Any : NSNull\(\)/);
  assert.match(check, /"matches": complete \? matches as Any : NSNull\(\)/);
  assert.doesNotMatch(check, /proc_pidinfo\(|proc_pidpath\(|AXUIElement|imageMatches|parent == 1|kill|sleep/);
});

test('SDK kernel fixture distinguishes each drift and unavailable read without permitting LaunchServices or missing process', { skip: process.platform !== 'darwin' }, async () => {
  const declarations = probe.surfaceSource.split('\ndo {\n')[0];
  const fixture = declarations + String.raw`
do {
    let p: [String: Any] = ["startSeconds": NSNumber(value: 1700000000), "startMicroseconds": NSNumber(value: 123456)]
    let bytes = Int32(MemoryLayout<proc_bsdinfo>.size)
    var good = proc_bsdinfo()
    good.pbi_pid = 42; good.pbi_ppid = 900; good.pbi_uid = 501; good.pbi_ruid = 501
    good.pbi_start_tvsec = 1700000000; good.pbi_start_tvusec = 123456
    try requireKernelFence(p, 900, 42, good, bytes, 0, 501)
    var failures = [[String: Any]]()
    for field in ["pid", "parentPID", "uid", "ruid", "startSeconds", "startMicroseconds"] {
        var bad = good
        switch field {
        case "pid": bad.pbi_pid += 1
        case "parentPID": bad.pbi_ppid = 1
        case "uid": bad.pbi_uid += 1
        case "ruid": bad.pbi_ruid += 1
        case "startSeconds": bad.pbi_start_tvsec += 1
        default: bad.pbi_start_tvusec += 1
        }
        var refused = false
        do { try requireKernelFence(p, 900, 42, bad, bytes, 0, 501) }
        catch let d as Denied {
            guard let detail = d.detail, let matches = detail["matches"] as? [String: Bool] else { throw Denied("fixture-detail-missing") }
            try check(d.reason == "owned-process-start-drift" && matches[field] == false && matches.values.filter { !$0 }.count == 1, "fixture-drift-accepted")
            failures.append(["error": d.reason, "errorDetail": detail]); refused = true
        }
        try check(refused, "fixture-mismatch-accepted")
    }
    for (returned, code) in [(Int32(0), Int32(ESRCH)), (Int32(0), Int32(EPERM)), (bytes - 1, Int32(0)), (Int32(-1), Int32(EINVAL))] {
        var refused = false
        do { try requireKernelFence(p, 900, 42, good, returned, code, 501) }
        catch let d as Denied {
            guard let detail = d.detail else { throw Denied("fixture-detail-missing") }
            try check(d.reason == "owned-process-start-drift" && detail["fieldsVerified"] as? Bool == false
                && detail["observed"] is NSNull && detail["matches"] is NSNull, "fixture-partial-identity-promoted")
            failures.append(["error": d.reason, "errorDetail": detail]); refused = true
        }
        try check(refused, "fixture-unavailable-accepted")
    }
    for malformed in [[String: Any](), ["startSeconds": NSNumber(value: 1700000000)]] {
        var refused = false
        do { try requireKernelFence(malformed, 900, 42, good, bytes, 0, 501) } catch { refused = true }
        try check(refused, "fixture-missing-start-accepted")
    }
    emit(["failures": failures, "actionAttempted": false])
} catch { emit(["error": String(describing: error)]); exit(2) }
`;
  const file = path.join(scratch, 'kernel-fence-fixture.swift'), binary = path.join(scratch, 'kernel-fence-fixture');
  fs.writeFileSync(file, fixture, { flag: 'wx' }); await compileSwift(file, binary);
  const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
  assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(result.signal, null);
  const receipt = JSON.parse(result.stdout); assert.equal(receipt.failures.length, 10); assert.equal(receipt.actionAttempted, false);
  for (const { error, errorDetail: d } of receipt.failures) {
    assert.equal(error, 'owned-process-start-drift'); assert.equal(d.operation, 'proc_pidinfo');
    assert.equal(d.phase, 'process-kernel-fence'); assert.equal(typeof d.bytes, 'number'); assert.equal(typeof d.kernelErrno, 'number');
    assert.equal(d.expected.pid, 42); assert.equal(d.expected.parentPID, 900);
    assert.equal(d.expected.startSeconds, '1700000000');
    assert.equal(d.fieldsVerified, d.bytes === d.expectedBytes);
    if (!d.fieldsVerified) { assert.equal(d.observed, null); assert.equal(d.matches, null); }
    assert.equal(d.actionAllowed, undefined);
  }
  for (const key of Object.keys(probe.acceptance)) assert.equal(receipt[key], false);
});

test('actual SDK compiles LaunchServices control and poisoned local admission refuses before app launch', { skip: process.platform !== 'darwin' }, async () => {
  const source = path.join(__dirname, 'native-macos-launchservices.swift'), binary = path.join(scratch, 'launchservices-guard');
  await compileSwift(source, binary);
  const result = spawnSync(binary, ['/must-not-launch.app', '/must-not-read.json'], {
    env: { ...process.env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 2); assert.equal(JSON.parse(result.stdout).error, 'disposable-explicit-launch-control-required');
});

test('SDK link diagnostics and XML/binary package versions execute actual pure branches without live AX reads', { skip: process.platform !== 'darwin' }, async () => {
  const declarations = probe.surfaceSource.split('\ndo {\n')[0];
  const links = ('func remoteLinks(' + probe.surfaceSource.split('    func remoteLinks(')[1].split('    func visit(')[0])
    .replace('AXUIElementSetMessagingTimeout(item, 0.2)', 'fixtureLinkTimeout(item, 0.2)')
    .replace('AXUIElementCopyAttributeValue(item, name as CFString, &value)', 'fixtureLinkRead(item, name as CFString, &value)');
  const fixture = declarations + String.raw`
let pid: Int32 = 42, id: UInt32 = 71
let window = AXUIElementCreateApplication(42), remote = AXUIElementCreateApplication(52)
let different = AXUIElementCreateApplication(99)
let deadline = ProcessInfo.processInfo.systemUptime + 4
var seen = [AXUIElement](), linkCalls = [String]()
var parentStatus = AXError.success, windowStatus = AXError.success
var parentValue: CFTypeRef?, windowValue: CFTypeRef?
func fixtureLinkTimeout(_ item: AXUIElement, _ seconds: Float) -> AXError { return .success }
func fixtureLinkRead(_ item: AXUIElement, _ name: CFString, _ value: inout CFTypeRef?) -> AXError {
    linkCalls.append(name as String)
    if name as String == kAXParentAttribute { value = parentValue; return parentStatus }
    value = windowValue; return windowStatus
}
` + links + String.raw`
do {
    var failures = [[String: Any]]()
    var nativePlists = [String]()
    for phase in ["before-metadata", "after-metadata"] {
        for (status, value, reason) in [(AXError.noValue, nil as CFTypeRef?, "remote-ax-parent-unverified"),
            (.cannotComplete, nil, "remote-ax-parent-unverified"), (.success, nil, "remote-ax-parent-unverified"),
            (.success, "wrong" as CFString, "remote-ax-parent-unverified"), (.success, different, "remote-ax-parent-unverified"),
            (.success, window, "remote-ax-window-unverified")] {
            parentStatus = status; parentValue = value; windowStatus = .success
            windowValue = reason == "remote-ax-window-unverified" ? different : window; linkCalls = []
            var refused = false
            do { try remoteLinks(remote, window, 2, "root-window/0/0", 52, phase) }
            catch let failure as Denied {
                refused = true; try check(failure.reason == reason, "fixture-original-refusal-drift")
                guard let detail = failure.detail else { throw Denied("fixture-detail-missing") }
                failures.append(["error": reason, "errorDetail": detail])
            }
            try check(refused && linkCalls == [kAXParentAttribute, kAXWindowAttribute], "fixture-extra-read-or-accepted")
        }
    }
    parentStatus = .success; parentValue = window; windowValue = window; linkCalls = []
    try remoteLinks(remote, window, 2, "root-window/0/0", 52, "before-metadata")
    try check(linkCalls == [kAXParentAttribute, kAXWindowAttribute], "fixture-valid-read-count")
    let good: [String: Any] = ["CFBundleIdentifier": "com.creatorworks.hub", "CFBundleExecutable": "creator-hub",
        "CFBundleShortVersionString": "0.1.14", "CFBundleVersion": "14"]
    for format in [PropertyListSerialization.PropertyListFormat.xml, .binary] {
        let data = try PropertyListSerialization.data(fromPropertyList: good, format: format, options: 0)
        nativePlists.append(data.base64EncodedString())
        let fields = try packageFields(data, ["sha256": "fixture-only"])
        try check(fields["bundleShortVersion"] as? String == "0.1.14" && fields["bundleVersion"] as? String == "14", "fixture-version-drift")
        for (key, value) in [("CFBundleIdentifier", "foreign" as Any), ("CFBundleExecutable", "foreign"),
            ("CFBundleShortVersionString", NSNumber(value: 14)), ("CFBundleVersion", NSNumber(value: true)),
            ("CFBundleVersion", ""), ("CFBundleShortVersionString", "1.2.3.4.5"), ("CFBundleVersion", String(repeating: "9", count: 1000))] {
            var bad = good; bad[key] = value
            let bytes = try PropertyListSerialization.data(fromPropertyList: bad, format: format, options: 0)
            var refused = false; do { _ = try packageFields(bytes, [:]) } catch { refused = true }
            try check(refused, "fixture-coerced-or-malformed-version")
        }
        var missing = good; missing.removeValue(forKey: "CFBundleVersion")
        let bytes = try PropertyListSerialization.data(fromPropertyList: missing, format: format, options: 0)
        var refused = false; do { _ = try packageFields(bytes, [:]) } catch { refused = true }
        try check(refused, "fixture-missing-version-accepted")
    }
    for data in [Data(), Data(repeating: 0, count: 65537), Data("malformed".utf8)] {
        var refused = false; do { _ = try packageFields(data, [:]) } catch { refused = true }
        try check(refused, "fixture-bad-plist-accepted")
    }
    emit(["failures": failures, "nativePlists": nativePlists, "packageFixturesVerified": true, "actionAttempted": false])
} catch { emit(["error": String(describing: error)]); exit(2) }
`;
  const file = path.join(scratch, 'link-package-fixture.swift'), binary = path.join(scratch, 'link-package-fixture');
  fs.writeFileSync(file, fixture, { flag: 'wx' }); await compileSwift(file, binary);
  const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(result.signal, null);
  const receipt = JSON.parse(result.stdout); assert.equal(receipt.failures.length, 12);
  for (const d of receipt.failures) probe.validateLinkFailure(d.errorDetail, d.error);
  assert.equal(receipt.packageFixturesVerified, true); assert.equal(receipt.actionAttempted, false);
  assert.equal(receipt.nativePlists.length, 2);
  for (const encoded of receipt.nativePlists) {
    const parsed = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'],
      { input: Buffer.from(encoded, 'base64'), encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout); assert.equal(parsed.signal, null);
    const plist = JSON.parse(parsed.stdout); assert.equal(plist.CFBundleShortVersionString, '0.1.14');
    assert.equal(plist.CFBundleVersion, '14');
  }
  for (const key of Object.keys(probe.acceptance)) assert.equal(receipt[key], false);
});

test('actual Mac SDK compiles the read-only sampler; local execution refuses before AX inspection', { skip: process.platform !== 'darwin' }, async t => {
  const file = path.join(scratch, 'surface.swift'), binary = path.join(scratch, 'surface');
  fs.writeFileSync(file, probe.surfaceSource, { flag: 'wx' });
  await compileSwift(file, binary);
  for (const args of [['availability'], ['inspect-root', '/unread-owner.json', '1'], ['inspect-root'],
    ['inspect-root', '/unread-owner.json', '1', '--controls']]) {
    const refusal = spawnSync(binary, args, { env: {}, encoding: 'utf8' });
    assert.equal(refusal.status, 2, refusal.stderr || refusal.stdout);
    const receipt = JSON.parse(refusal.stdout);
    assert.equal(receipt.error, 'hosted-ci-explicit-opt-in-required');
    assert.equal(receipt.errorDetail, undefined);
    assert.equal(receipt.actionAttempted, false); assert.equal(receipt.permissionRequestsPerformed, false);
    for (const key of Object.keys(probe.acceptance)) assert.equal(receipt[key], false);
  }
  t.diagnostic(JSON.stringify({ samplerCompiled: true, rootAppLaunched: false, ...probe.acceptance }));
});

test('SDK child-read fixtures exercise emitted Swift failure branches without app launch or live AX reads', { skip: process.platform !== 'darwin' }, async t => {
  // Test-only substitution of the three native calls; no fixture entry point is
  // emitted into the production sampler or its admission/ownership path.
  const declarations = probe.surfaceSource.split('\ndo {\n')[0]
    .replaceAll('AXUIElementSetMessagingTimeout(item, 0.2)', 'fixtureTimeout(item, 0.2)')
    .replace('AXUIElementGetAttributeValueCount(item, name as CFString, &count)', 'fixtureCount(item, name as CFString, &count)')
    .replace('AXUIElementCopyAttributeValues(item, name as CFString, 0, count, &array)', 'fixtureCopy(item, name as CFString, 0, count, &array)');
  assert.ok(!declarations.includes('\ndo {\n'));
  const fixture = declarations + String.raw`
var fixtureCalls = [String](), fixtureCountValue = 0
var fixtureCountStatus = AXError.success, fixtureCopyStatus = AXError.success
var fixtureArray: CFArray?
func fixtureTimeout(_ item: AXUIElement, _ seconds: Float) -> AXError {
    fixtureCalls.append("timeout"); return .success
}
func fixtureCount(_ item: AXUIElement, _ name: CFString, _ count: inout Int) -> AXError {
    fixtureCalls.append("count"); count = fixtureCountValue; return fixtureCountStatus
}
func fixtureCopy(_ item: AXUIElement, _ name: CFString, _ index: Int, _ count: Int, _ array: inout CFArray?) -> AXError {
    fixtureCalls.append("copy"); array = fixtureArray; return fixtureCopyStatus
}
do {
    let root = AXUIElementCreateApplication(424242)
    let node = childrenNode(root, "root-application", -1, nil, 424242, 424242, 71, "root-application")
    var failures = [[String: Any]]()
    let textArray = ["wrong-child" as NSString] as CFArray
    let wrongArray = unsafeBitCast("not-an-array" as NSString, to: CFArray.self)
    for (countStatus, count, copyStatus, array, reason, classification) in [
        (AXError.cannotComplete, 0, AXError.success, nil, "ax-children-unbounded-or-unreadable", "native-error"),
        (.illegalArgument, 0, .success, nil, "ax-children-unbounded-or-unreadable", "native-error"),
        (.invalidUIElement, 0, .success, nil, "ax-children-unbounded-or-unreadable", "native-error"),
        (.success, -1, .success, nil, "ax-children-unbounded-or-unreadable", "count-out-of-range"),
        (.success, 513, .success, nil, "ax-children-unbounded-or-unreadable", "count-out-of-range"),
        (.success, Int.max, .success, nil, "ax-children-unbounded-or-unreadable", "count-out-of-range"),
        (.success, 1, .cannotComplete, nil, "ax-children-unreadable", "native-error"),
        (.success, 1, .noValue, nil, "ax-children-unreadable", "native-error"),
        (.success, 1, .success, nil, "ax-children-unreadable", "missing-array"),
        (.success, 1, .success, wrongArray, "ax-children-unreadable", "wrong-array-type"),
        (.success, 2, .success, textArray, "ax-children-unreadable", "array-count-mismatch"),
        (.success, 1, .success, textArray, "ax-children-unreadable", "wrong-child-type")
    ] as [(AXError, Int, AXError, CFArray?, String, String)] {
        fixtureCalls = []; fixtureCountStatus = countStatus; fixtureCountValue = count
        fixtureCopyStatus = copyStatus; fixtureArray = array
        do {
            _ = try children(root, kAXWindowsAttribute, "root-window-discovery", node)
            throw Denied("fixture-did-not-refuse")
        } catch let refused as Denied {
            try check(refused.reason == reason, "fixture-original-reason-drift")
            guard let detail = refused.detail else { throw Denied("fixture-detail-missing") }
            try check(detail["classification"] as? String == classification, "fixture-classification-drift")
            try check(fixtureCalls == (countStatus == .success && count > 0 && count <= 512
                ? ["timeout", "count", "copy"] : ["timeout", "count"]), "fixture-retried-or-unbounded")
            failures.append(["error": refused.reason, "errorDetail": detail])
        }
    }
    for status in [AXError.noValue, .attributeUnsupported, .success] {
        fixtureCalls = []; fixtureCountStatus = status; fixtureCountValue = 0
        let result = try children(root, kAXWindowsAttribute, "root-window-discovery", node)
        try check(result.isEmpty && fixtureCalls == ["timeout", "count"], "fixture-empty-semantics-drift")
    }
    fixtureCalls = []; fixtureCountStatus = .success; fixtureCountValue = 1
    fixtureCopyStatus = .success; fixtureArray = [root] as CFArray
    let result = try children(root, kAXWindowsAttribute, "root-window-discovery", node)
    try check(result.count == 1 && CFEqual(result[0], root) && fixtureCalls == ["timeout", "count", "copy"], "fixture-valid-elements-refused")
    emit(["failures": failures, "rootAppLaunched": false, "liveAXReads": false, "readOnly": true,
          "actionAttempted": false, "permissionRequestsPerformed": false])
} catch { emit(["error": (error as? Denied)?.reason ?? "fixture-failed"]); exit(2) }
`;
  const file = path.join(scratch, 'children-fixture.swift'), binary = path.join(scratch, 'children-fixture');
  fs.writeFileSync(file, fixture, { flag: 'wx' }); await compileSwift(file, binary);
  const result = spawnSync(binary, [], { env: {}, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.stdout); assert.equal(result.signal, null);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.failures.length, 12); assert.equal(receipt.liveAXReads, false); assert.equal(receipt.rootAppLaunched, false);
  assert.equal(receipt.actionAttempted, false); assert.equal(receipt.permissionRequestsPerformed, false);
  for (const failed of receipt.failures) probe.validateChildrenFailure(failed.errorDetail);
  for (const key of Object.keys(probe.acceptance)) assert.equal(receipt[key], false);
  t.diagnostic(JSON.stringify({ childFailureFixtures: receipt.failures.length, rootAppLaunched: false, ...probe.acceptance }));
});
