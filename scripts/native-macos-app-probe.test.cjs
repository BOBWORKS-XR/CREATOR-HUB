const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const probe = require('./native-macos-app-probe.cjs');
const sourcePath = path.join(__dirname, 'native-macos-app-probe.cjs');
const source = fs.readFileSync(sourcePath, 'utf8');
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
  const close = { action: 'close-window', axAction: 'AXPress', actionAttempted: true, postIdentityVerified: true,
    forceKillPerformed: false, permissionRequestsPerformed: false };
  assert.equal(probe.acceptedExit(close, { code: 0, signal: null }), true);
  for (const pair of [[null, { code: 0, signal: null }], [close, null], [close, { code: 1, signal: null }],
    [close, { code: 0, signal: 'SIGTERM' }], [{ ...close, postIdentityVerified: false }, { code: 0, signal: null }],
    [{ ...close, actionAttempted: false }, { code: 0, signal: null }]]) assert.equal(probe.acceptedExit(...pair), false);
  assert.match(source, /report.passed = report.captureCompleted && report.acceptedExit && !report.error && !report.cleanupUncertain/);
  for (const value of Object.values(probe.acceptance)) assert.equal(value, false);
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

test('actual Mac SDK compiles the read-only sampler; local execution refuses before AX inspection', { skip: process.platform !== 'darwin' }, async t => {
  const file = path.join(scratch, 'surface.swift'), binary = path.join(scratch, 'surface');
  fs.writeFileSync(file, probe.surfaceSource, { flag: 'wx' });
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
  const refusal = spawnSync(binary, ['availability'], { env: {}, encoding: 'utf8' });
  assert.equal(refusal.status, 2, refusal.stderr || refusal.stdout);
  const receipt = JSON.parse(refusal.stdout);
  assert.equal(receipt.error, 'hosted-ci-explicit-opt-in-required');
  for (const key of Object.keys(probe.acceptance)) assert.equal(receipt[key], false);
  t.diagnostic(JSON.stringify({ samplerCompiled: true, rootAppLaunched: false, ...probe.acceptance }));
});
