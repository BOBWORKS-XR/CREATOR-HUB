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
  const descendants = visit.indexOf('let descendants = try children(item, kAXChildrenAttribute)');
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

test('unchanged action helper still refuses foreign nodes and enforces target Root PID before its sole action', () => {
  const helper = fs.readFileSync(path.join(__dirname, 'native-macos-window.swift'));
  // Source hash retained in the actual Intel evidence; no action-helper edits.
  assert.equal(crypto.createHash('sha256').update(helper).digest('hex'), 'f0adc5eaafee9577d6629391807ad875738fa15cceb869b10f575a16de3a1258');
  const swift = helper.toString('utf8');
  assert.match(swift, /AXUIElementGetPid\(item, &pid\) == \.success, pid == expected else \{ throw Refusal\("foreign-ax-element"\)/);
  assert.match(swift, /do \{ try axPID\(item, identity.pid\) \}[\s\S]*?catch \{ throw Refusal\("foreign-ax-element"/);
  assert.equal(swift.match(/AXUIElementPerformAction\(/g).length, 1);
  const action = swift.slice(swift.indexOf('try axPID(target, owner.process.pid)'));
  assert.match(action, /CFEqual\(targetWindow, fenceWindow\)[\s\S]*?try admission\(\); try trustedAX\(\)[\s\S]*?AXUIElementPerformAction/);
  assert.doesNotMatch(swift, /remoteReadPolicy|requireRemoteRead|native-parent-and-root-window/);
});

test('sampler diagnostics retain source hashes and all false acceptance flags without relaxing orchestrator/helper errors', () => {
  assert.match(source, /report.helper = \{ path: helper, image: helperImage, sourceSha256: source.image.sha256 \}/);
  assert.match(source, /report.sampler = \{ path: sampler, image: samplerImage, sourceSha256: crypto.createHash\('sha256'\).update\(surfaceSource, 'utf8'\).digest\('hex'\) \}/);
  assert.match(probe.surfaceSource, /value\["diagnosticOnly"\] = true/);
  assert.match(probe.surfaceSource, /for key in \["nativeGuiAccepted", "mcpAccepted", "migrationAccepted", "updateAccepted", "releaseReady"\] \{ value\[key\] = false \}/);
  assert.match(source, /requireThat\(inspected.exitCode === 0, 'owned-root-inspection-refused'\)/);
  assert.match(source, /requireThat\(after.exitCode === 0, 'post-capture-inspection-refused'\)/);
  assert.match(source, /requireThat\(close.exitCode === 0, 'normal-close-refused-or-post-identity-unverified'\)/);
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
