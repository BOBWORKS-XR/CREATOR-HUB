const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sourcePath = path.join(__dirname, 'native-macos-window.swift');
const source = fs.readFileSync(sourcePath, 'utf8');
const nativeMac = process.platform === 'darwin';
const runnerArch = process.arch === 'arm64' ? 'ARM64' : process.arch === 'x64' ? 'X64' : null;
const probeAdmitted = nativeMac && runnerArch !== null && process.env.RUNNER_ARCH === runnerArch
  && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted'
  && process.env.RUNNER_OS === 'macOS' && process.env.GITHUB_REPOSITORY === 'BOBWORKS-XR/CREATOR-HUB'
  && process.env.CREATOR_MACOS_OWNED_GUI_TEST === '1';
let scratch, fixtureBinary, nativeBinary;

test('native admission precedes all inspection and has no fixture dispatch', () => {
  assert.match(source, /func nativeMain\(\)[\s\S]*?try admission\(\)[\s\S]*?Array\(CommandLine.arguments/);
  for (const value of ['GITHUB_ACTIONS', 'github-hosted', 'RUNNER_OS', 'macOS', 'BOBWORKS-XR/CREATOR-HUB', 'CREATOR_MACOS_OWNED_GUI_TEST']) {
    assert.ok(source.includes(`"${value}"`));
  }
  assert.match(source, /#if NATIVE_MACOS_WINDOW_FIXTURES/);
  const fixtureSection = source.split('#if NATIVE_MACOS_WINDOW_FIXTURES')[1].split('#elseif os(macOS)')[0];
  assert.doesNotMatch(fixtureSection, /import (AppKit|ApplicationServices)|AXUIElementPerformAction|CGWindowList/);
  const entry = source.slice(source.indexOf('func nativeMain()'));
  assert.doesNotMatch(entry, /fixture|standardInput/);
});

test('native actions have no permission grant, focus forcing, arbitrary click, or kill fallback', () => {
  assert.equal(source.match(/AXUIElementPerformAction\(/g)?.length, 1);
  assert.doesNotMatch(source, /AXIsProcessTrustedWithOptions|CGRequestScreenCaptureAccess|AXUIElementSetAttributeValue|CGEventPost|CGPostMouseEvent|osascript|\.terminate\(|\.activate\(|\bkill\(|NSWorkspace\.shared\.open|_AXUIElementGetWindow/);
  assert.match(source, /proc_pidinfo\(pid, PROC_PIDTBSDINFO/);
  assert.match(source, /proc_pidpath/);
  assert.match(source, /SHA256\(\)/);
  assert.match(source, /let after = try observe\(owner, controls: false, allowGone: true\)/);
  assert.match(source, /try validateIdentity\(owner, after.value, allowGone: true\)/);
});

test('availability is a target-free trust query after the unchanged hosted and architecture guards', () => {
  const entry = source.slice(source.indexOf('func nativeMain()'));
  const probe = entry.split('if args[0] == "availability" {')[1].split('if args[0] == "identify"')[0];
  assert.match(entry, /try admission\(\)[\s\S]*?if args\[0\] == "availability"/);
  assert.match(probe, /guard args.count == 1 else/);
  assert.equal(probe.match(/AXIsProcessTrusted\(\)/g)?.length, 1);
  assert.match(probe, /"targetInspectionPerformed": false/);
  assert.match(probe, /"actionAttempted": false, "permissionRequestsPerformed": false/);
  assert.match(probe, /return/);
  assert.doesNotMatch(probe, /trustedAX|process\(|image\(|ownerFile|observe\(|cgWindows|AXUIElement|NSRunningApplication|CGWindow/);
  assert.match(source, /#if arch\(arm64\)\s*guard ProcessInfo.processInfo.environment\["RUNNER_ARCH"\] == "ARM64"/);
  assert.match(source, /#elseif arch\(x86_64\)\s*guard ProcessInfo.processInfo.environment\["RUNNER_ARCH"\] == "X64"/);
  for (const [key, value] of [['GITHUB_ACTIONS', 'true'], ['RUNNER_ENVIRONMENT', 'github-hosted'],
    ['RUNNER_OS', 'macOS'], ['GITHUB_REPOSITORY', 'BOBWORKS-XR/CREATOR-HUB'], ['CREATOR_MACOS_OWNED_GUI_TEST', '1']]) {
    assert.ok(source.includes(`env["${key}"] == "${value}"`));
  }
});

test('availability cannot authorize inspection or actions or expose a skip-trust option', () => {
  assert.match(source, /func trustedAX\(\) throws \{\s*guard AXIsProcessTrusted\(\) else/);
  assert.match(source, /if args\[0\] == "identify"[^\n]*\{\s*try trustedAX\(\)/);
  assert.match(source, /args.count == \(args\[0\] == "press" \? 3 : 2\)[\s\S]*?try trustedAX\(\)\s*let owner = try ownerFile/);
  assert.match(source, /try admission\(\); try trustedAX\(\)[\s\S]*?AXUIElementPerformAction/);
  assert.doesNotMatch(source, /skip[-_]?trust|bypass[-_]?trust|allowUntrusted|AXMakeProcessTrusted|tccutil|spctl/i);
});

test('all helper receipts keep release and native GUI acceptance false, including non-Mac refusal', () => {
  assert.match(source, /receipt\["releaseReady"\] = false/);
  assert.match(source, /receipt\["nativeGuiAccepted"\] = false/);
  assert.match(source, /#else\s*emit\(\["error": "native-macos-required", "actionAttempted": false\]\); exit\(2\)\s*#endif\s*$/);
});

test('window binding and traversal stay explicit and bounded', () => {
  assert.match(source, /optionIncludingWindow/);
  assert.match(source, /matches.count == 1/);
  assert.match(source, /CFEqual\(parentWindow, axWindow\)/);
  assert.match(source, /depth <= 16, seen.count < 512/);
  assert.match(source, /systemUptime \+ 4/);
  assert.doesNotMatch(source, /kCGWindowName|kAXValueAttribute/);
  const hitTest = source.split('func hitMatches')[1].split('struct NativeObservation')[0];
  assert.doesNotMatch(hitTest, /kAXChildrenAttribute|emit\(/);
});

test('SDK compatibility uses the exact kernel path bound and public AX sheet hierarchy', () => {
  assert.match(source, /let processPathBufferBytes = 4096\b/);
  assert.match(source, /\[CChar\]\(repeating: 0, count: processPathBufferBytes\)/);
  assert.match(source, /length > 0, Int\(length\) < path.count, path\[Int\(length\)\] == 0/);
  assert.doesNotMatch(source, /\bPROC_PIDPATHINFO_MAXSIZE\b|\bkAXSheetsAttribute\b|"AXSheets"/);
  assert.match(source, /let descendants = try children\(item, kAXChildrenAttribute\)\s*for \(index, child\) in descendants.enumerated\(\)/);
  assert.match(source, /let nativeDialog = !inWeb && \(role == kAXSheetRole \|\| attribute\(item, kAXSubroleAttribute\) as\? String == "AXDialog"\)/);
  assert.match(source, /hasDialog = hasDialog \|\| nativeDialog/);
  assert.match(source, /buttons.count == 1, !observed.hasDialog/);
});

before(() => {
  if (!nativeMac) return;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-macos-window-tests-'));
  fixtureBinary = path.join(scratch, 'fixtures');
  nativeBinary = path.join(scratch, 'native');
  for (const [binary, flags] of [[fixtureBinary, ['-D', 'NATIVE_MACOS_WINDOW_FIXTURES']], [nativeBinary, []]]) {
    const compiled = spawnSync('/usr/bin/swiftc', [...flags, sourcePath, '-o', binary], { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
    assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message);
  }
});
after(() => {
  if (!scratch) return;
  const resolved = fs.realpathSync(scratch);
  assert.ok(path.basename(resolved).startsWith('creator-macos-window-tests-'));
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  fs.rmSync(resolved, { recursive: true });
});

test('actual macOS SDK compiles separate native and fixture binaries without launching an app', { skip: !nativeMac }, t => {
  assert.ok(fs.statSync(nativeBinary).size > 0);
  assert.ok(fs.statSync(fixtureBinary).size > 0);
  assert.notEqual(nativeBinary, fixtureBinary);
  t.diagnostic(JSON.stringify({ nativeCompilationPassed: true, nativeBinary, fixtureBinary,
    nativeGuiAccepted: false, releaseReady: false }));
});

test('actual admitted Mac CI availability reports existing trust without a target or action', { skip: !probeAdmitted }, t => {
  // Never synthesize hosted-runner admission for a successful native trust query.
  const result = spawnSync(nativeBinary, ['availability'], { env: process.env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.command, 'availability');
  assert.equal(receipt.runnerArchitecture, runnerArch);
  assert.equal(typeof receipt.accessibilityTrusted, 'boolean');
  assert.equal(receipt.probeOnly, true);
  for (const key of ['targetInspectionPerformed', 'actionAttempted', 'permissionRequestsPerformed', 'nativeGuiAccepted', 'releaseReady']) {
    assert.equal(receipt[key], false, key);
  }
  assert.deepEqual(Object.keys(receipt).sort(), ['schemaVersion', 'command', 'runnerArchitecture', 'accessibilityTrusted', 'probeOnly',
    'targetInspectionPerformed', 'actionAttempted', 'permissionRequestsPerformed', 'nativeGuiAccepted', 'releaseReady'].sort());
  t.diagnostic(JSON.stringify({ nativeBinary, availability: receipt }));
  if (!receipt.accessibilityTrusted) {
    for (const args of [['identify', '42', '/unused.app', '/unused', 'a'.repeat(64), 'com.creatorworks.hub'],
      ['inspect', '/unused-owner.json'], ['press', '/unused-owner.json', 'mcp-allow'], ['close', '/unused-owner.json']]) {
      const refused = spawnSync(nativeBinary, args, { env: process.env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
      assert.equal(refused.status, 2, refused.stderr || refused.stdout);
      const evidence = JSON.parse(refused.stdout);
      assert.equal(evidence.error, 'accessibility-denied');
      assert.equal(evidence.actionAttempted, false);
      assert.equal(evidence.nativeGuiAccepted, false);
      assert.equal(evidence.releaseReady, false);
    }
  }
});

function fixture(action = 'mcp-allow') {
  const image = { sha256: 'a'.repeat(64), device: '1', inode: '2', size: 4096, modifiedSeconds: 10, modifiedNanoseconds: 20, uid: 501 };
  const process = { pid: 42, startSeconds: 123, startMicroseconds: 456, executablePath: '/owned/Creator Hub.app/Contents/MacOS/creator-hub', image,
    bundlePath: '/owned/Creator Hub.app', bundleIdentifier: 'com.creatorworks.hub', infoPlist: { ...image, inode: '3' } };
  const window = { id: 71, pid: 42, bounds: { x: 20, y: 30, width: 400, height: 300 } };
  const common = { role: 'AXButton', pid: 42, windowID: 71, enabled: true, hidden: false, showing: true, pressSupported: true };
  const controls = [{ ...common, path: 'window/0', dialog: 'window', title: 'Enable MCP controls' },
    { ...common, path: 'window/1', dialog: 'window', title: 'Not now' }];
  const observation = { process, window, accessibilityTrusted: true, active: true, truncated: false, hasDialog: true, windowMissingVerified: false, controls };
  return { owner: structuredClone({ process, window }), before: structuredClone(observation),
    immediate: structuredClone(observation), after: structuredClone(observation), action };
}

test('fault fixtures cannot mutate their expected owner or another observation', () => {
  const value = fixture();
  value.immediate.process.pid++;
  value.immediate.window.id++;
  value.immediate.controls[0].title = 'changed';
  assert.equal(value.owner.process.pid, 42);
  assert.equal(value.before.process.pid, 42);
  assert.equal(value.after.process.pid, 42);
  assert.equal(value.owner.window.id, 71);
  assert.equal(value.before.controls[0].title, 'Enable MCP controls');
});

const cases = [
  ['exact native consent', () => {}, null],
  ['exact decline', f => { f.action = 'mcp-decline'; }, null],
  ['exact preview consent', f => {
    f.action = 'mcp-preview-allow';
    for (const observation of [f.before, f.immediate]) observation.controls[0].title = 'Open read-only preview';
  }, null],
  ['exact Setup consent', f => {
    f.action = 'setup-allow';
    for (const observation of [f.before, f.immediate]) observation.controls[0].title = 'Open in Hub';
  }, null],
  ['foreign PID', f => { f.immediate.process.pid = 99; }, 'process-identity-drift'],
  ['foreign executable', f => { f.immediate.process.executablePath = '/foreign'; }, 'process-identity-drift'],
  ['executable hash drift', f => { f.immediate.process.image.sha256 = 'b'.repeat(64); }, 'process-identity-drift'],
  ['PID start seconds drift', f => { f.immediate.process.startSeconds++; }, 'process-identity-drift'],
  ['PID start microseconds drift', f => { f.immediate.process.startMicroseconds++; }, 'process-identity-drift'],
  ['image inode replacement', f => { f.immediate.process.image.inode = '4'; }, 'process-identity-drift'],
  ['native bundle drift', f => { f.immediate.process.bundleIdentifier = 'com.apple.finder'; }, 'process-identity-drift'],
  ['duplicate approved button', f => { f.immediate.controls.push({ ...f.immediate.controls[0], path: 'duplicate' }); }, 'consent-controls-ambiguous'],
  ['duplicate decline button', f => { f.immediate.controls.push({ ...f.immediate.controls[1], path: 'duplicate' }); }, 'consent-controls-ambiguous'],
  ['missing counterpart', f => { f.immediate.controls.pop(); }, 'consent-controls-ambiguous'],
  ['disabled button', f => { f.immediate.controls[0].enabled = false; }, 'control-unready-or-foreign'],
  ['unknown enabled state', f => { f.immediate.controls[0].enabled = null; }, 'control-unready-or-foreign'],
  ['hidden button', f => { f.immediate.controls[0].hidden = true; }, 'control-unready-or-foreign'],
  ['nonshowing button', f => { f.immediate.controls[0].showing = false; }, 'control-unready-or-foreign'],
  ['foreign AX PID', f => { f.immediate.controls[0].pid++; }, 'control-unready-or-foreign'],
  ['control window mismatch', f => { f.immediate.controls[0].windowID++; }, 'control-unready-or-foreign'],
  ['CG window mismatch', f => { f.immediate.window.id++; }, 'window-identity-drift'],
  ['window bounds drift', f => { f.immediate.window.bounds.x++; }, 'window-identity-drift'],
  ['web control without native dialog', f => { f.immediate.controls[0].dialog = null; }, 'consent-controls-ambiguous'],
  ['different native dialogs', f => { f.immediate.controls[1].dialog = 'other'; }, 'consent-controls-ambiguous'],
  ['AX permission denied', f => { f.immediate.accessibilityTrusted = false; }, 'accessibility-denied'],
  ['AX traversal incomplete', f => { f.immediate.truncated = true; }, 'ax-incomplete'],
  ['inactive owned app', f => { f.immediate.active = false; }, 'owned-app-not-active'],
  ['control reference path drift', f => { f.immediate.controls[0].path = 'other'; }, 'control-drift'],
  ['post-action executable hash drift', f => { f.after.process.image.sha256 = 'b'.repeat(64); }, 'process-identity-drift'],
  ['post-action PID reuse', f => { f.after.process.startMicroseconds++; }, 'process-identity-drift'],
  ['post-action AX permission lost', f => { f.after.accessibilityTrusted = false; }, 'accessibility-denied'],
  ['post-action window owner changed', f => { f.after.window.pid++; }, 'window-identity-drift'],
  ['unverified post-action window absence', f => { f.after.window = null; }, 'window-unverified'],
  ['verified post-action window absence', f => { f.after.window = null; f.after.windowMissingVerified = true; }, null],
  ['normal owned window close', f => {
    f.action = 'close-window';
    for (const observation of [f.before, f.immediate]) {
      observation.hasDialog = false;
      observation.controls = [{ ...observation.controls[0], path: 'close-button', dialog: null, title: '' }];
    }
  }, null],
  ['window close with unrelated native dialog', f => {
    f.action = 'close-window';
    for (const observation of [f.before, f.immediate]) {
      observation.hasDialog = false;
      observation.controls = [{ ...observation.controls[0], path: 'close-button', dialog: null, title: '' }];
    }
    f.immediate.hasDialog = true;
  }, 'normal-close-unverified-or-dialog-present'],
];

for (const [name, mutate, error] of cases) {
  test(`Swift guard fixture: ${name}`, { skip: !nativeMac }, () => {
    const value = fixture(); mutate(value);
    const result = spawnSync(fixtureBinary, [], { input: JSON.stringify(value), encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    assert.equal(result.status, error ? 1 : 0, result.stderr || result.stdout);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.nativeActionsAvailable, false);
    assert.equal(receipt.nativeGuiAccepted, false);
    assert.equal(receipt.releaseReady, false);
    if (error) assert.equal(receipt.error, error); else assert.equal(receipt.fixtureAccepted, true);
  });
}

test('native CLI refuses local, self-hosted, missing opt-in, and fixture injection before inspection', { skip: !nativeMac }, () => {
  const admitted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS',
    RUNNER_ARCH: process.arch === 'arm64' ? 'ARM64' : 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', CREATOR_MACOS_OWNED_GUI_TEST: '1' };
  for (const env of [{}, { ...admitted, RUNNER_ENVIRONMENT: 'self-hosted' }, { ...admitted, CREATOR_MACOS_OWNED_GUI_TEST: '' }]) {
    const result = spawnSync(nativeBinary, ['--fixtures'], { env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).error, 'hosted-ci-opt-in-required');
  }
  const injected = spawnSync(nativeBinary, ['--fixtures'], { env: admitted, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  assert.equal(injected.status, 2);
  assert.equal(JSON.parse(injected.stdout).error, 'unknown-native-command');
});

test('native availability refuses local, self-hosted, foreign scope, architecture drift and extra parameters', { skip: !nativeMac }, () => {
  const admitted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS',
    RUNNER_ARCH: runnerArch, GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', CREATOR_MACOS_OWNED_GUI_TEST: '1' };
  for (const [env, args, error] of [
    [{}, ['availability'], 'hosted-ci-opt-in-required'],
    [{ ...admitted, GITHUB_ACTIONS: 'false' }, ['availability'], 'hosted-ci-opt-in-required'],
    [{ ...admitted, RUNNER_ENVIRONMENT: 'self-hosted' }, ['availability'], 'hosted-ci-opt-in-required'],
    [{ ...admitted, CREATOR_MACOS_OWNED_GUI_TEST: '' }, ['availability'], 'hosted-ci-opt-in-required'],
    [{ ...admitted, RUNNER_OS: 'Linux' }, ['availability'], 'hosted-ci-opt-in-required'],
    [{ ...admitted, GITHUB_REPOSITORY: 'foreign/repo' }, ['availability'], 'hosted-ci-opt-in-required'],
    [{ ...admitted, RUNNER_ARCH: runnerArch === 'ARM64' ? 'X64' : 'ARM64' }, ['availability'], 'runner-architecture-mismatch'],
    [admitted, ['availability', '42'], 'availability-takes-no-target-or-options'],
    [admitted, ['availability', '--skip-trust'], 'availability-takes-no-target-or-options'],
  ]) {
    const result = spawnSync(nativeBinary, args, { env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    assert.equal(result.status, 2, result.stderr || result.stdout);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.error, error);
    assert.equal(receipt.actionAttempted, false);
    assert.equal(receipt.nativeGuiAccepted, false);
    assert.equal(receipt.releaseReady, false);
    assert.equal(Object.hasOwn(receipt, 'accessibilityTrusted'), false);
  }
});
