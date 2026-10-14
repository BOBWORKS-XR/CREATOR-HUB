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
  const { owner } = ownership();
  const observation = { process: owner.process, window: owner.window, accessibilityTrusted: true, active: true, truncated: false };
  const close = { action: 'close-window', axAction: 'AXPress', actionAttempted: true, postIdentityVerified: true,
    forceKillPerformed: false, permissionRequestsPerformed: false, before: observation, after: observation };
  const exit = { pid: owner.process.pid, code: 0, signal: null };
  assert.equal(probe.acceptedExit(close, exit, owner), true);
  assert.equal(probe.acceptedExit({ ...close, after: { ...observation, window: null, windowMissingVerified: true } }, exit, owner), true);
  for (const pair of [[null, exit], [close, null], [close, { ...exit, code: 1 }],
    [close, { ...exit, signal: 'SIGTERM' }], [{ ...close, postIdentityVerified: false }, exit],
    [{ ...close, actionAttempted: false }, exit]]) assert.equal(probe.acceptedExit(...pair, owner), false);
  assert.match(source, /report.passed = report.captureCompleted && report.acceptedExit && !report.error && !report.cleanupUncertain/);
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

test('native termination is distinct from live process identity and requires exact owned exit and all postconditions', () => {
  const { owner } = ownership();
  const before = { process: owner.process, window: owner.window, accessibilityTrusted: true, active: true,
    truncated: false, hasDialog: false, controls: [{ path: 'close-button', role: 'AXButton', pid: owner.process.pid,
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
  const observation = { process: owner.process, window: owner.window, accessibilityTrusted: true, active: true, truncated: false };
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
  assert.match(links, /let traversalParent = traversalParent, let linked = attr\(item, kAXParentAttribute\), CFGetTypeID\(linked\) == AXUIElementGetTypeID\(\)/);
  assert.match(links, /parentMatches = CFEqual\(linked as! AXUIElement, traversalParent\)/);
  assert.match(links, /let linked = attr\(item, kAXWindowAttribute\), CFGetTypeID\(linked\) == AXUIElementGetTypeID\(\)/);
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
  assert.ok(visit.indexOf('try remoteLinks(item, traversalParent, depth)', before) < metadata);
  const descendants = visit.indexOf('let descendants = try children(item, kAXChildrenAttribute, "traversal", childNode)');
  const after = visit.indexOf('if remote {', descendants), published = visit.indexOf('rows.append(row)');
  assert.ok(descendants > metadata && after > descendants && published > after);
  assert.match(visit.slice(after, published), /try elementPID\(item\) == readPID/);
  assert.match(visit.slice(after, published), /try remoteProcess\(readPID\) == remoteBefore/);
  assert.match(visit.slice(after, published), /try remoteLinks\(item, traversalParent, depth\)[\s\S]*?try checkHeldRoot\(\)/);
  assert.match(visit.slice(published), /try visit\(child, depth \+ 1, path \+ "\/" \+ String\(index\), item\)/);
  // Association checks precede the seen check, so a repeated CF object cannot
  // silently bypass refusal when reached through an inconsistent parent.
  assert.ok(visit.indexOf('try remoteLinks(item, traversalParent, depth)') < visit.indexOf('if seen.contains'));
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

test('reviewed close-termination helper still refuses foreign nodes before its sole action', () => {
  const helper = fs.readFileSync(path.join(__dirname, 'native-macos-window.swift'));
  // Reviewed post-close-only change; native traversal/consent authority is unchanged.
  assert.equal(crypto.createHash('sha256').update(helper).digest('hex'), '3f60dc5295a02537b19d02589c0e173522ff534c66ae127a273b404411a66008');
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
  assert.match(source, /report.acceptedExit = acceptedExit\(closeReceipt, ownedExit, owner\) && !report.closeError/);
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
