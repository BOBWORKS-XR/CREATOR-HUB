const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const mac = require('./native-mac-maintenance-smoke.cjs');

const clone = value => JSON.parse(JSON.stringify(value));
function environment(architecture = 'X64') {
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', RUNNER_ARCH: architecture,
    CREATOR_MAC_CANDIDATE_RUN_ID: mac.CANDIDATE.runId, CREATOR_MAC_HEAD_SHA: mac.CANDIDATE.headSha,
    CREATOR_MAC_SOURCE_SHA: mac.CANDIDATE.sourceSha,
    CREATOR_MAC_DMG_SHA256: mac.CANDIDATE.artifacts[architecture].dmgSha256,
    CREATOR_MAC_LANE: 'manual-upgrade' };
}

function bindingFixture(architecture = 'X64') {
  const input = mac.options(environment(architecture));
  const pin = mac.CANDIDATE.artifacts[architecture];
  const run = { id: Number(input.runId), head_sha: input.headSha, repository: { full_name: 'BOBWORKS-XR/CREATOR-HUB', id: 1364807512 },
    head_repository: { full_name: 'BOBWORKS-XR/CREATOR-HUB' }, path: '.github/workflows/ci.yml',
    status: 'completed', conclusion: 'success', event: 'pull_request', run_attempt: 1,
    html_url: `https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/${input.runId}`,
    pull_requests: [{ number: 22, head: { sha: input.headSha, repo: { id: 1364807512 } }, base: { sha: mac.BASELINE_SOURCE, repo: { id: 1364807512 } } }] };
  const artifact = { id: pin.id, name: `hub-development-macOS-${architecture}-${input.sourceSha}`,
    expired: false, digest: `sha256:${pin.sha256}`, size_in_bytes: pin.size,
    workflow_run: { id: run.id, head_sha: input.headSha, repository_id: run.repository.id, head_repository_id: run.repository.id } };
  const head = { sha: input.headSha, tree: { sha: '8b1deb17843f753f7b6fe5cf3560412ed8b541d9' } };
  const source = { sha: input.sourceSha, tree: head.tree,
    parents: [{ sha: mac.BASELINE_SOURCE }, { sha: input.headSha }] };
  return { input, run, artifact, head, source };
}

const validateFixture = f => mac.validateBinding(f.run, f.artifact, f.input, f.head, f.source);

test('frozen public DMG and candidate pins cannot be overridden by returned fixtures', () => {
  assert.ok(Object.isFrozen(mac.BASELINES) && Object.isFrozen(mac.BASELINES.X64));
  assert.ok(Object.isFrozen(mac.CANDIDATE.artifacts.ARM64));
  const env = environment();
  assert.equal(mac.options(env).executableSha256, null);
  assert.throws(() => mac.options({ ...env, CREATOR_MAC_DMG_SHA256: 'a'.repeat(64) }));
  assert.throws(() => mac.options({ ...env, CREATOR_MAC_SOURCE_SHA: mac.CANDIDATE.headSha }));
  assert.throws(() => mac.options({ ...env, CREATOR_MAC_EXECUTABLE_SHA256: 'invalid' }));
  assert.throws(() => mac.options({ ...env, CREATOR_MAC_LANE: 'version-fixture' }));
});

test('native actions refuse user machines, self-hosted, other repos, architectures and runtimes', () => {
  for (const architecture of ['X64', 'ARM64']) {
    const env = environment(architecture), arch = architecture === 'X64' ? 'x64' : 'arm64';
    assert.doesNotThrow(() => mac.guard(env, 'darwin', arch, '24.1.0'));
    for (const bad of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' },
      { RUNNER_OS: 'Windows' }, { GITHUB_REPOSITORY: 'someone/else' }, { RUNNER_ARCH: 'X86' }]) {
      assert.throws(() => mac.guard({ ...env, ...bad }, 'darwin', arch, '24.1.0'));
    }
    assert.throws(() => mac.guard(env, 'win32', arch, '24.1.0'));
    assert.throws(() => mac.guard(env, 'darwin', arch, '22.22.2'));
    assert.throws(() => mac.guard(env, 'darwin', 'ia32', '24.1.0'));
  }
});

test('actual CLI refuses native work on non-Mac before accessing app or output paths', { skip: process.platform === 'darwin' }, () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'native-mac-maintenance-smoke.cjs'), '--run'],
    { encoding: 'utf8', env: { ...process.env, ...environment() } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Native actions require macOS/);
});

for (const architecture of ['X64', 'ARM64']) {
  test(`${architecture}: exact run/head/repository, merge parents/tree and independently labelled artifact bind`, () => {
    const f = bindingFixture(architecture), result = validateFixture(f);
    assert.equal(result.headSha, mac.CANDIDATE.headSha);
    assert.equal(result.sourceSha, mac.CANDIDATE.sourceSha);
    assert.notEqual(result.headSha, result.sourceSha);
    assert.equal(result.sha256, mac.CANDIDATE.artifacts[architecture].sha256);
  });
}

const invalidBindings = {
  'running CI': f => { f.run.status = 'in_progress'; },
  'failed CI': f => { f.run.conclusion = 'failure'; },
  'other run': f => { f.run.id++; },
  'wrong head': f => { f.run.head_sha = 'a'.repeat(40); },
  'other repository': f => { f.run.repository.full_name = 'someone/else'; },
  'fork head': f => { f.run.head_repository.full_name = 'someone/CREATOR-HUB'; },
  'wrong workflow': f => { f.run.path = '.github/workflows/release.yml'; },
  'expired artifact': f => { f.artifact.expired = true; },
  'head-labelled artifact instead of actual checkout': f => { f.artifact.name = f.artifact.name.replace(f.input.sourceSha, f.input.headSha); },
  'missing archive digest': f => { delete f.artifact.digest; },
  'different archive digest': f => { f.artifact.digest = `sha256:${'a'.repeat(64)}`; },
  'different artifact ID': f => { f.artifact.id++; },
  'different archive length': f => { f.artifact.size_in_bytes++; },
  'wrong artifact run': f => { f.artifact.workflow_run.id++; },
  'artifact foreign repository ID': f => { f.artifact.workflow_run.repository_id++; },
  'artifact head uses merge SHA': f => { f.artifact.workflow_run.head_sha = f.input.sourceSha; },
  'wrong merge parents': f => { f.source.parents.reverse(); },
  'different merge tree': f => { f.source.tree = { sha: 'a'.repeat(40) }; },
  'missing PR context': f => { f.run.pull_requests = []; },
  'other PR': f => { f.run.pull_requests[0].number = 21; },
};
for (const [name, change] of Object.entries(invalidBindings)) {
  test(`binding refuses ${name}`, () => {
    const f = clone(bindingFixture()); change(f); assert.throws(() => validateFixture(f));
  });
}

test('historical run binding survives a later PR head without weakening artifact or merge identity', () => {
  const f = bindingFixture();
  f.run.pull_requests[0].head.sha = '7ee1cab7278ed4dbb48542ce26305f74b989b9d3';
  assert.equal(validateFixture(f).headSha, mac.CANDIDATE.headSha);
  f.run.head_sha = f.run.pull_requests[0].head.sha;
  assert.throws(() => validateFixture(f));
});

test('product tree comparison excludes only finite reviewed testing paths and includes modes, submodules and all other bytes', () => {
  const remote = [{ path: 'src', type: 'tree', sha: 'a'.repeat(40), mode: '040000' },
    { path: 'src/app.js', type: 'blob', sha: 'b'.repeat(40), mode: '100644' },
    { path: 'unity/test-submodule', type: 'commit', sha: 'c'.repeat(40), mode: '160000' }];
  const local = remote.filter(e => e.type !== 'tree');
  const withProbe = [...local, ...mac.PROBE_FILES.map(name => ({ path: name, type: 'blob', mode: '100644', sha: 'd'.repeat(40) }))];
  assert.equal(mac.verifyProductTree(remote, withProbe).unchanged, true);
  for (const field of ['sha', 'mode', 'path']) {
    const changed = clone(local); changed[0][field] = field === 'sha' ? 'e'.repeat(40) : field === 'mode' ? '100755' : 'src/other.js';
    assert.throws(() => mac.verifyProductTree(remote, changed));
  }
  assert.throws(() => mac.verifyProductTree(remote, [...local, { path: 'scripts/unreviewed.cjs', type: 'blob', mode: '100644', sha: 'e'.repeat(40) }]));
  const parsed = mac.parseLocalTree(`100644 blob ${'b'.repeat(40)}\tsrc/app.js\0`);
  assert.deepEqual(parsed, [local[0]]);
  assert.throws(() => mac.parseLocalTree('invalid\0'));
});

test('concurrent Linux/Flatpak probes and three reviewed Windows baseline-testing changes are accepted', () => {
  assert.equal(mac.REVIEWED_TEST_ONLY_FILES.length, 18);
  assert.equal(mac.TREE_EXCLUSIONS.length, 23);
  assert.ok(Object.isFrozen(mac.TREE_EXCLUSIONS));
  const source = { path: 'src-tauri/src/main.rs', mode: '100644', type: 'blob', sha: 'a'.repeat(40) };
  const windows = mac.REVIEWED_TEST_ONLY_FILES.slice(-3).map(name => ({ path: name, mode: '100644', type: 'blob', sha: 'b'.repeat(40) }));
  const concurrent = mac.REVIEWED_TEST_ONLY_FILES.map(name => ({ path: name, mode: '100644', type: 'blob', sha: 'c'.repeat(40) }));
  const result = mac.verifyProductTree([source, ...windows], [source, ...concurrent]);
  assert.equal(result.unchanged, true);
  assert.equal(result.comparedFiles, 1);
  assert.deepEqual(result.excludedPaths, mac.TREE_EXCLUSIONS);
});

test('concurrent probe admission still refuses product source, resources, settings, versions and unreviewed paths', () => {
  for (const name of ['src/app.js', 'src/icons/creator-plugins.png', 'src-tauri/src/main.rs', 'src-tauri/build.rs',
    'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'package.json', 'package-lock.json',
    'rust-toolchain.toml', 'scripts/unity/CreatorPluginsImportSmoke.cs',
    'unity/com.creatorworks.plugins/Editor/CreatorPluginsWindow.cs', 'scripts/prerelease-apps.json',
    'resources/catalog.json', 'settings/launcher-config.json', '.github/workflows/ci.yml',
    'scripts/native-linux-maintenance-smoke.cjs.extra']) {
    const before = { path: name, mode: '100644', type: 'blob', sha: 'a'.repeat(40) };
    for (const change of [{ sha: 'b'.repeat(40) }, { mode: '100755' }, { type: 'commit' }]) {
      assert.throws(() => mac.verifyProductTree([before], [{ ...before, ...change }]), /differs/);
    }
    assert.throws(() => mac.verifyProductTree([], [before]), /differs/);
    assert.throws(() => mac.verifyProductTree([before], []), /differs/);
  }
});

test('ZIP selection rejects traversal, nested paths, extra files and opposite architecture', () => {
  assert.equal(mac.zipEntry('Creator Hub_0.1.13_x64.dmg\n', 'X64'), 'Creator Hub_0.1.13_x64.dmg');
  for (const bad of ['../Creator Hub_0.1.13_x64.dmg', '/Creator Hub_0.1.13_x64.dmg',
    'dir/Creator Hub_0.1.13_x64.dmg', 'Creator Hub_0.1.13_aarch64.dmg',
    'Creator Hub_0.1.13_x64.dmg\nextra-file', 'Creator Hub_0.1.14_x64.dmg']) assert.throws(() => mac.zipEntry(bad, 'X64'));
});

test('source contract keeps separate 0.1.13, ad-hoc identity and pinned Rust without signing keys', () => {
  const config = { version: '0.1.13', productName: 'Creator Hub', identifier: 'com.creatorworks.hub', bundle: { macOS: { signingIdentity: '-' } } };
  assert.equal(mac.validateSource(config, { version: '0.1.13' }, 'channel = "1.99.0"').rust, '1.99.0');
  for (const bad of [{ ...config, version: '0.1.14' }, { ...config, identifier: 'com.other' },
    { ...config, bundle: { macOS: { signingIdentity: 'Developer ID' } } }]) {
    assert.throws(() => mac.validateSource(bad, { version: '0.1.13' }, 'channel = "1.99.0"'));
  }
});

function bundleFixture() {
  return { identifier: 'com.creatorworks.hub', shortVersion: '0.1.13', bundleVersion: '0.1.13', executable: 'creator-hub',
    architectures: 'x86_64\n', minimumOS: '10.13', hostOS: '15.7.1', loadCommands: 'cmd LC_BUILD_VERSION\n minos 10.13\n sdk 15.0',
    signature: 'Executable=creator-hub\nSignature=adhoc\n', executableSha256: 'a'.repeat(64) };
}
test('bundle verifies identity, both versions, exact architecture, seal class, executable and host minOS', () => {
  const expected = { version: '0.1.13', architecture: 'X64', executableSha256: 'a'.repeat(64) };
  const result = mac.validateBundle(bundleFixture(), expected);
  assert.equal(result.publisherSignatureVerified, false);
  assert.equal(result.notarizationVerified, false);
  const badValues = { identifier: 'com.other', shortVersion: '0.1.12', bundleVersion: '13', executable: 'other',
    architectures: 'x86_64 arm64', minimumOS: '16.0', loadCommands: 'no minimum', signature: 'not signed', executableSha256: 'b'.repeat(64) };
  for (const [field, value] of Object.entries(badValues)) assert.throws(() => mac.validateBundle({ ...bundleFixture(), [field]: value }, expected));
  assert.throws(() => mac.validateBundle({ ...bundleFixture(), loadCommands: 'minos 16.0' }, expected));
  assert.equal(mac.atLeast('15.7', '15.7.0'), true);
  assert.equal(mac.atLeast('15.6.9', '15.7'), false);
  assert.throws(() => mac.atLeast('unknown', '10.13'));
  assert.equal(mac.validateBundle({ ...bundleFixture(), architectures: 'arm64', minimumOS: '10.13', loadCommands: 'cmd LC_BUILD_VERSION\nminos 11.0' },
    { ...expected, architecture: 'ARM64' }).bundleMinimumCoversExecutable, false);
  assert.deepEqual(mac.validateBundle({ ...bundleFixture(), loadCommands: 'cmd LC_VERSION_MIN_MACOSX\nversion 10.13\ncmd LC_LOAD_DYLIB\ncurrent version 99.0.0' },
    expected).executableMinimumOS, ['10.13']);
});

test('opaque sentinels preserve bytes/mode and detect changes without creating legal/auth/config records', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mac-maintenance-test-')));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const before = mac.seedSentinels(root);
  assert.equal(before.length, 12);
  assert.ok(before.every(s => s.file.endsWith('.bin') && !/auth\.json|launcher-config\.json|projects\.json/.test(s.file)));
  assert.equal(mac.verifySentinels(before).length, 12);
  assert.throws(() => mac.seedSentinels(root), /EEXIST/);
  fs.appendFileSync(before[0].file, 'changed');
  assert.throws(() => mac.verifySentinels(before), /Protected sentinel changed/);
  assert.throws(() => mac.contained(root, root));
  assert.throws(() => mac.contained(root, path.join(root, '..', 'outside')));
});

test('path checks refuse symbolic links or Windows junctions', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mac-link-test-')));
  t.after(() => fs.rmSync(root, { recursive: true }));
  fs.mkdirSync(path.join(root, 'real'));
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => mac.noLinks(path.join(root, 'linked', 'file')));
});

const capability = { accessibilityTrusted: true, screenCaptureAllowed: true, hasDisplay: true };
const visible = { finishedLaunching: true, windows: [{ id: 123 }], axReadable: true,
  axNodes: [{ AXRole: 'AXWebArea', AXDescription: 'Creator Hub' },
    { AXRole: 'AXStaticText', AXValue: 'Creator Works MCP' },
    { AXRole: 'AXCheckBox', AXTitle: mac.AUTO_DOWNLOAD, AXValue: '1', AXEnabled: 'true' }], axTruncated: false };
function freezeFixture(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeFixture);
    Object.freeze(value);
  }
  return value;
}
// Relevant nodes copied verbatim; the complete raw snapshot remains in the original artifact.
const intelRelaunchFixture = freezeFixture({
  evidence: 'mac-maintenance-X64-fresh-38427551219/native-report.json launches[1].snapshot',
  fullSnapshotSha256: 'bbf2668c8ab0bcb27d47490f969c5d8c6fcbca6d2d81a2c66bd033fbd176fc37',
  snapshot: {
    axNodes: [
      { AXDescription: 'Creator Hub', AXEnabled: 'true', AXRole: 'AXWebArea', AXTitle: '', AXValue: '' },
      { AXDescription: 'View Creator Works MCP', AXEnabled: 'true', AXRole: 'AXButton', AXTitle: 'View Creator Works MCP', AXValue: '' },
      { AXDescription: '', AXEnabled: 'true', AXRole: 'AXCheckBox', AXTitle: 'Download verified updates automatically', AXValue: '0' },
      { AXDescription: 'Terms of use and risk acknowledgement', AXEnabled: 'true', AXRole: 'AXGroup',
        AXTitle: 'Terms of use and risk acknowledgement', AXValue: '' },
    ],
    axReadable: true, axTruncated: false, finishedLaunching: true, pid: 2135,
    bundleIdentifier: 'com.creatorworks.hub', bundlePath: '/Users/runner/Applications/Creator Hub.app',
    executablePath: '/Users/runner/Applications/Creator Hub.app/Contents/MacOS/creator-hub',
    windows: [{ bounds: { Height: 580, Width: 940, X: 490, Y: 220 }, id: 41, title: 'Creator Hub - Development Preview' }],
  },
});
function termsSnapshot(checked = false) {
  return { ...clone(visible), axNodes: [{ AXRole: 'AXWebArea', AXDescription: 'Creator Hub' },
    { AXRole: 'AXHeading', AXTitle: mac.TERMS.title },
    { AXRole: 'AXCheckBox', AXTitle: mac.TERMS.checkbox, AXValue: checked ? '1' : '0', AXEnabled: 'true' },
    { AXRole: 'AXButton', AXTitle: mac.TERMS.continue, AXEnabled: checked ? 'true' : 'false' }] };
}
const renderedPixels = { width: 940, height: 580, bodyCrop: { x: 56, y: 116, width: 827, height: 348 },
  sampledPixels: 71949, distinctColors: 128, nonBackgroundSamples: 8500, chromeExcluded: true };
function operations(events, renderedSnapshot = visible) {
  let current = null, pid = 100, accepted = false, checked = false, autoDownload = true, launched;
  const snapshot = () => {
    const result = accepted ? clone(renderedSnapshot) : termsSnapshot(checked);
    if (accepted) result.axNodes.find(n => n.AXTitle === mac.AUTO_DOWNLOAD).AXValue = autoDownload ? '1' : '0';
    return { ...result, ...launched };
  };
  return {
    probe: () => clone(capability), preflight: () => events.push('preflight'),
    install: version => { current = version; events.push(`install:${version}`); return { version, appPath: '/owned/Creator Hub.app',
      executablePath: '/owned/Creator Hub.app/Contents/MacOS/creator-hub',
      bundle: { gatekeeper: { status: 0 }, bundleMinimumCoversExecutable: true } }; },
    seed: () => { events.push('seed'); return []; },
    launch: () => { events.push(`launch:${current}`); launched = { pid: ++pid, bundleIdentifier: 'com.creatorworks.hub',
      bundlePath: '/owned/Creator Hub.app', executablePath: '/owned/Creator Hub.app/Contents/MacOS/creator-hub' }; return { ...launched }; },
    snapshot, waitSnapshot: snapshot,
    pressTerms: (launched, action) => {
      events.push(`press:${action}`);
      if (action === 'test-terms-checkbox') checked = true;
      else accepted = true;
      return { ...launched, action, axAction: 'AXPress', syntheticTestOnly: true, customerConsent: false, userMachineUsed: false };
    },
    pressAutoDownloadOff: launched => {
      assert.equal(current, '0.1.13');
      events.push(`preference:off:${current}:${launched.pid}`);
      autoDownload = false;
      return { ...launched, action: 'test-auto-download-off', axAction: 'AXPress', controlRole: 'AXCheckBox',
        controlTitle: mac.AUTO_DOWNLOAD, beforeValue: '1', requestedValue: '0', targetVersion: current,
        syntheticTestOnly: true, customerConsent: false, userMachineUsed: false };
    },
    capture: (launched, label, kind) => {
      events.push(`capture:${label}`);
      mac.validateBody(snapshot(), kind);
      return { pid: launched.pid, bodyKind: kind, screenshot: `owned-gui-${label}-${launched.pid}.png`,
        sha256: 'a'.repeat(64), pixels: clone(renderedPixels) };
    },
    quit: launched => { events.push(`quit:${launched.pid}`); return { normalQuitRequested: true, exited: true, forceKillPerformed: false }; },
    captureStorage: launched => { events.push(`storage:${launched.pid}`); return { status: 'unknown', error: 'synthetic-no-native-store' }; },
    preserve: () => { events.push('preserve'); return []; }, detach: () => events.push('detach'),
  };
}

test('synthetic manual lane proves terms/body/relaunch, then preserves terms through replacement without updater claims', async () => {
  const events = [], report = mac.newReport(mac.options(environment()));
  await mac.runLane(report, operations(events));
  assert.equal(report.passed, true);
  assert.equal(report.releaseReady, false);
  assert.equal(report.updater.tested, false);
  assert.equal(report.updater.automaticRestart, false);
  assert.equal(report.effectivePreferencesTested, true);
  assert.equal(report.autoDownloadPreferencePersistenceTested, true);
  assert.equal(report.effectivePreferencesScope, '0.1.13-auto-download-normal-quit-relaunch-only');
  assert.equal(report.otherBrowserPreferencesTested, false);
  assert.deepEqual(events.filter(e => e.startsWith('preference:')), ['preference:off:0.1.13:103']);
  assert.equal(report.aiWorkflowTested, false);
  assert.equal(report.unityWorkflowTested, false);
  assert.equal(report.termsPersistenceTested, true);
  assert.equal(report.manualUpgradeTermsPreserved, true);
  assert.equal(report.syntheticTerms.testOnly, true);
  assert.equal(report.syntheticTerms.customerConsent, false);
  assert.equal(report.syntheticTerms.actions.length, 2);
  assert.deepEqual(report.syntheticTerms.actions.map(a => a.version), ['0.1.12', '0.1.12']);
  assert.ok(report.historicalFailures[0].retained);
  assert.equal(report.historicalNativeReports[0].status, 'blocked');
  assert.equal(report.historicalNativeReports[0].failureCount, 0);
  assert.equal(report.historicalNativeReports[0].replacedByThisReport, false);
  assert.notEqual(report.historicalNativeReports[0].scope, report.scope);
  assert.equal(report.historicalNativeReports[0].blockers.length, 2);
  assert.equal(mac.newReport(mac.options(environment('ARM64'))).historicalNativeReports[0].blockers.length, 3);
  assert.ok(events.indexOf('quit:102') < events.indexOf('install:0.1.13'));
  assert.deepEqual(report.launches.map(p => p.pid), [101, 102, 103, 104]);
  assert.deepEqual(report.launches.map(p => p.captures.map(c => c.kind)), [['terms', 'body'], ['body'], ['body'], ['body']]);
  assert.ok(report.launches.every(p => p.renderedBodyVerified));
  assert.ok(report.launches.slice(1).every(p => p.persistedSyntheticTerms));
});

test('fresh lane never installs or launches the old app', async () => {
  const events = [], input = mac.options({ ...environment(), CREATOR_MAC_LANE: 'fresh' });
  const report = await mac.runLane(mac.newReport(input), operations(events));
  assert.equal(report.passed, true);
  assert.equal(events.filter(e => e.startsWith('install:')).length, 1);
  assert.equal(report.launches.length, 2);
  assert.equal(report.syntheticTerms.actions.length, 2);
  assert.equal(report.termsPersistenceTested, true);
  assert.equal(report.manualUpgradeTermsPreserved, undefined);
  assert.equal(report.sourceKind, 'exact-ci-0.1.13-fresh-dmg-install');
  assert.equal(report.effectivePreferencesTested, true);
  assert.equal(report.autoDownloadPreferencePersistenceTested, true);
  assert.deepEqual(events.filter(e => e.startsWith('preference:')), ['preference:off:0.1.13:101']);
  assert.ok(events.indexOf('preference:off:0.1.13:101') < events.indexOf('quit:101'));
  assert.ok(events.indexOf('quit:101') < events.lastIndexOf('launch:0.1.13'));
  assert.equal(report.syntheticPreference.actions.length, 1);
  assert.equal(report.syntheticPreference.actions[0].customerConsent, false);
  assert.ok(report.launches.every(row => row.autoDownloadOffVerified));
  mac.autoDownloadControl(report.launches[0].beforeAutoDownloadSnapshot, '1');
  mac.autoDownloadControl(report.launches[0].afterAutoDownloadSnapshot, '0');
  mac.autoDownloadControl(report.launches[1].relaunchedAutoDownloadSnapshot, '0');
});

test('new report never claims effective preference persistence before observed target relaunch', () => {
  const report = mac.newReport(mac.options(environment()));
  assert.equal(report.effectivePreferencesTested, false);
  assert.equal(report.autoDownloadPreferencePersistenceTested, false);
  assert.equal(report.releaseReady, false);
  assert.equal(report.otherBrowserPreferencesTested, false);
  assert.deepEqual(report.syntheticPreference.actions, []);
});

const preferenceFaults = {
  missing: s => { s.axNodes = s.axNodes.filter(n => n.AXTitle !== mac.AUTO_DOWNLOAD); },
  ambiguous: s => { s.axNodes.push(clone(s.axNodes.find(n => n.AXTitle === mac.AUTO_DOWNLOAD))); },
  disabled: s => { s.axNodes.find(n => n.AXTitle === mac.AUTO_DOWNLOAD).AXEnabled = 'false'; },
  'missing enabled state': s => { delete s.axNodes.find(n => n.AXTitle === mac.AUTO_DOWNLOAD).AXEnabled; },
  'missing value': s => { delete s.axNodes.find(n => n.AXTitle === mac.AUTO_DOWNLOAD).AXValue; },
  'wrong role': s => { s.axNodes.find(n => n.AXTitle === mac.AUTO_DOWNLOAD).AXRole = 'AXButton'; },
  'near-match title': s => { s.axNodes.find(n => n.AXTitle === mac.AUTO_DOWNLOAD).AXTitle += ' '; },
  'already off': s => { s.axNodes.find(n => n.AXTitle === mac.AUTO_DOWNLOAD).AXValue = '0'; },
  'privacy prompt': s => { s.axNodes.push({ AXTitle: 'Allow access to private data' }); },
};
for (const [name, change] of Object.entries(preferenceFaults)) {
  test(`preference refuses ${name} target checkbox before any preference press`, async () => {
    const events = [], ops = operations(events), original = ops.waitSnapshot;
    ops.waitSnapshot = (launched, wanted) => {
      const snapshot = original(launched, wanted);
      if (wanted === 'body') change(snapshot);
      return snapshot;
    };
    const input = mac.options({ ...environment(), CREATOR_MAC_LANE: 'fresh' });
    const report = await mac.runLane(mac.newReport(input), ops);
    assert.equal(report.status, 'failed');
    assert.equal(report.effectivePreferencesTested, false);
    assert.equal(report.autoDownloadPreferencePersistenceTested, false);
    assert.ok(!events.some(e => e.startsWith('preference:')));
    assert.ok(events.includes('quit:101'));
    assert.equal(report.releaseReady, false);
  });
}

for (const change of [{ pid: 999 }, { bundleIdentifier: 'other' }, { bundlePath: '/other' },
  { executablePath: '/other' }, { action: 'other' }, { axAction: 'AXSetValue' },
  { controlRole: 'AXButton' }, { controlTitle: 'other' }, { beforeValue: '0' }, { requestedValue: '1' },
  { targetVersion: '0.1.12' }, { syntheticTestOnly: false }, { customerConsent: true }, { userMachineUsed: true }]) {
  test(`preference receipt refuses mismatched ${Object.keys(change)[0]}`, async () => {
    const events = [], ops = operations(events), original = ops.pressAutoDownloadOff;
    ops.pressAutoDownloadOff = launched => ({ ...original(launched), ...change });
    const input = mac.options({ ...environment(), CREATOR_MAC_LANE: 'fresh' });
    const report = await mac.runLane(mac.newReport(input), ops);
    assert.equal(report.status, 'failed');
    assert.equal(report.effectivePreferencesTested, false);
    assert.equal(report.syntheticPreference.actions.length, 0);
    assert.equal(events.filter(e => e.startsWith('preference:')).length, 1);
    assert.ok(events.includes('quit:101'));
    assert.equal(report.releaseReady, false);
  });
}

test('AXPress receipt alone cannot prove off when the actual post-press snapshot still returns on', async () => {
  const events = [], ops = operations(events), original = ops.waitSnapshot;
  ops.waitSnapshot = (launched, wanted) => {
    const snapshot = original(launched, wanted);
    if (wanted === 'auto-download-off') snapshot.axNodes.find(n => n.AXTitle === mac.AUTO_DOWNLOAD).AXValue = '1';
    return snapshot;
  };
  const report = await mac.runLane(mac.newReport(mac.options({ ...environment(), CREATOR_MAC_LANE: 'fresh' })), ops);
  assert.equal(report.status, 'failed');
  assert.match(report.failures[0].error, /Unexpected auto-download checkbox state/);
  assert.equal(report.syntheticPreference.actions.length, 1);
  assert.equal(report.effectivePreferencesTested, false);
  assert.equal(report.launches[0].autoDownloadOffVerified, undefined);
  assert.equal(report.launches.length, 1);
  assert.equal(events.filter(e => e.startsWith('preference:')).length, 1);
});

test('target normal relaunch returning on preserves the observed failure, never toggles again or claims persistence', async () => {
  const events = [], ops = operations(events), original = ops.snapshot;
  ops.snapshot = () => {
    const snapshot = original();
    if (snapshot.pid === 102) snapshot.axNodes.find(n => n.AXTitle === mac.AUTO_DOWNLOAD).AXValue = '1';
    return snapshot;
  };
  const report = await mac.runLane(mac.newReport(mac.options({ ...environment(), CREATOR_MAC_LANE: 'fresh' })), ops);
  assert.equal(report.status, 'failed');
  assert.equal(report.failures[0].phase, 'auto-download-0.1.13-relaunch');
  assert.match(report.failures[0].error, /Unexpected auto-download checkbox state/);
  assert.equal(report.launches[0].autoDownloadOffVerified, true);
  mac.autoDownloadControl(report.launches[1].relaunchedAutoDownloadSnapshot, '1');
  assert.equal(report.effectivePreferencesTested, false);
  assert.equal(report.autoDownloadPreferencePersistenceTested, false);
  assert.equal(events.filter(e => e.startsWith('preference:')).length, 1);
  assert.ok(events.includes('quit:101') && events.includes('quit:102'));
  assert.deepEqual(report.webkitPreferenceDiagnostics.captures.map(c => [c.purpose, c.pid]), [['initial', 101], ['relaunch', 102]]);
  assert.ok(events.indexOf('quit:101') < events.indexOf('storage:101'));
  assert.ok(events.indexOf('quit:102') < events.indexOf('storage:102'));
  assert.ok(events.includes('preserve'));
  assert.equal(report.releaseReady, false);
});

function storageFixture(t, modern = false, schema = mac.ITEM_SCHEMA) {
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'creator-mac-storage-test-'));
  t.after(() => { mac.noLinks(temp); fs.rmSync(mac.contained(path.dirname(temp), temp), { recursive: true }); });
  const home = path.join(temp, 'home'), scratch = path.join(temp, 'scratch');
  const root = path.join(home, ...mac.WEBKIT_ROOT.split('/'));
  fs.mkdirSync(scratch);
  fs.mkdirSync(root, { recursive: true });
  let relative = 'LocalStorage/tauri_localhost_0.localstorage';
  if (modern) {
    const salt = Buffer.from('0001020304050607', 'hex');
    fs.mkdirSync(path.join(root, 'Default'));
    fs.writeFileSync(path.join(root, 'Default', 'salt'), salt);
    const hash = require('node:crypto').createHash('sha256').update('tauri://localhost').update(salt).digest('base64url');
    relative = `Default/${hash}/${hash}/LocalStorage/localstorage.sqlite3`;
  }
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(schema);
  return { temp, home, root, scratch, file, db, capture: hooks => mac.captureWebKitPreference(home, scratch, hooks) };
}

for (const modern of [false, true]) {
  for (const value of ['true', 'false']) {
    test(`exact ${modern ? 'salted' : 'legacy'} store captures UTF-16 ${value} only, without altering or retaining raw files`, t => {
      const fixture = storageFixture(t, modern);
      fixture.db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(mac.AUTO_DOWNLOAD_KEY, Buffer.from(value, 'utf16le'));
      fixture.db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('unrelated-private-key', Buffer.from('do-not-report-this', 'utf16le'));
      fixture.db.close();
      const before = mac.digest(fs.readFileSync(fixture.file));
      const result = fixture.capture();
      assert.equal(result.status, 'candidate-key-captured-active-store-unbound');
      assert.equal(result.activeStoreBound, false);
      assert.equal(result.rootCause, 'unknown');
      assert.equal(result.sourceUnchanged, true);
      assert.equal(result.keyObservation.raw, value);
      assert.equal(result.keyObservation.rawHex, Buffer.from(value, 'utf16le').toString('hex'));
      assert.equal(result.keyObservation.type, 'blob');
      assert.equal(mac.digest(fs.readFileSync(fixture.file)), before);
      assert.deepEqual(fs.readdirSync(fixture.scratch), []);
      assert.doesNotMatch(JSON.stringify(result), /unrelated-private-key|do-not-report-this|0001020304050607/);
    });
  }
}

test('copied read-only SQLite includes committed WAL, never writes source SHM or ignores WAL via immutable mode', t => {
  const fixture = storageFixture(t);
  fixture.db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  fixture.db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(mac.AUTO_DOWNLOAD_KEY, Buffer.from('false', 'utf16le'));
  const before = ['','-wal','-shm'].map(suffix => mac.digest(fs.readFileSync(fixture.file + suffix)));
  const result = fixture.capture();
  const after = ['','-wal','-shm'].map(suffix => mac.digest(fs.readFileSync(fixture.file + suffix)));
  fixture.db.close();
  assert.equal(result.keyObservation.raw, 'false');
  assert.equal(result.sourceUnchanged, true);
  assert.deepEqual(after, before);
  assert.deepEqual(fs.readdirSync(fixture.scratch), []);
});

test('a missing exact key is recorded only within a supported candidate schema, not inferred from missing files', t => {
  const fixture = storageFixture(t);
  fixture.db.close();
  const result = fixture.capture();
  assert.deepEqual(result.keyObservation, { type: 'missing', size: 0, raw: null });
  assert.equal(result.status, 'candidate-key-captured-active-store-unbound');
  fs.unlinkSync(fixture.file);
  assert.equal(fixture.capture().error, 'missing-candidate');
});

const storageFaults = {
  'malformed database': f => fs.writeFileSync(f.file, 'not sqlite'),
  'unsupported schema': f => {
    const db = new DatabaseSync(f.file); db.exec('DROP TABLE ItemTable; CREATE TABLE ItemTable (key TEXT, value TEXT)'); db.close();
  },
  'oversized database': f => fs.truncateSync(f.file, 2 * 1024 * 1024 + 1),
  'oversized key': f => {
    const db = new DatabaseSync(f.file); db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(mac.AUTO_DOWNLOAD_KEY, Buffer.alloc(66)); db.close();
  },
  'wrong value type': f => {
    const db = new DatabaseSync(f.file); db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(mac.AUTO_DOWNLOAD_KEY, 'false'); db.close();
  },
  'unsupported value': f => {
    const db = new DatabaseSync(f.file); db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(mac.AUTO_DOWNLOAD_KEY, Buffer.from('future', 'utf16le')); db.close();
  },
  'invalid salt': f => { fs.mkdirSync(path.join(f.root, 'Default')); fs.writeFileSync(path.join(f.root, 'Default', 'salt'), Buffer.alloc(7)); },
  'rollback journal': f => fs.writeFileSync(f.file + '-journal', 'unknown-journal'),
  'orphan WAL': f => { fs.unlinkSync(f.file); fs.writeFileSync(f.file + '-wal', 'orphan'); },
};
for (const [name, change] of Object.entries(storageFaults)) {
  test(`store diagnostic reports unknown for ${name}, without a key receipt or retained copy`, t => {
    const fixture = storageFixture(t);
    fixture.db.close(); change(fixture);
    const result = fixture.capture();
    assert.equal(result.status, 'unknown');
    assert.ok(result.error);
    assert.equal(result.keyObservation, undefined);
    assert.equal(result.activeStoreBound, false);
    assert.deepEqual(fs.readdirSync(fixture.scratch), []);
  });
}

test('two source-derived candidate databases are ambiguous; no arbitrary store is selected', t => {
  const fixture = storageFixture(t, true);
  fixture.db.close();
  const legacy = path.join(fixture.root, 'LocalStorage', 'tauri_localhost_0.localstorage');
  fs.mkdirSync(path.dirname(legacy)); fs.copyFileSync(fixture.file, legacy);
  const result = fixture.capture();
  assert.equal(result.error, 'ambiguous-candidates');
  assert.equal(result.candidates.length, 2);
  assert.equal(result.keyObservation, undefined);
  assert.deepEqual(fs.readdirSync(fixture.scratch), []);
});

test('store symlinks are refused without reading the linked database', t => {
  const fixture = storageFixture(t); fixture.db.close();
  const target = path.join(fixture.temp, 'outside.sqlite3'); fs.renameSync(fixture.file, target);
  try { fs.symlinkSync(target, fixture.file); }
  catch (error) { if (error.code === 'EPERM') { t.skip('File symlinks require Windows privilege; directory link test still runs'); return; } throw error; }
  const before = mac.digest(fs.readFileSync(target));
  assert.equal(fixture.capture().status, 'unknown');
  assert.equal(mac.digest(fs.readFileSync(target)), before);
});

test('linked store directories are refused, including Windows junctions', t => {
  const fixture = storageFixture(t); fixture.db.close();
  const original = path.dirname(fixture.file), target = path.join(fixture.temp, 'outside-store');
  fs.renameSync(original, target); fs.symlinkSync(target, original, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fixture.capture().status, 'unknown');
  fs.unlinkSync(original); // Do not recursively follow a junction in fixture cleanup.
});

for (const hook of ['afterCopy', 'beforeRecheck']) {
  test(`source tamper at ${hook} invalidates the copied key receipt`, t => {
    const fixture = storageFixture(t);
    fixture.db.prepare('INSERT INTO ItemTable VALUES (?, ?)').run(mac.AUTO_DOWNLOAD_KEY, Buffer.from('false', 'utf16le'));
    fixture.db.close();
    const result = fixture.capture({ [hook]: () => fs.appendFileSync(fixture.file, 'tamper') });
    assert.equal(result.status, 'unknown');
    assert.equal(result.error, 'source-drift');
    assert.equal(result.keyObservation, undefined);
    assert.equal(result.sourceUnchanged, false);
    assert.deepEqual(fs.readdirSync(fixture.scratch), []);
  });
}

test('every verified normal exit captures diagnostics, while capture errors never replace an original GUI failure', async () => {
  const events = [], ops = operations(events);
  ops.captureStorage = () => { throw Error('synthetic diagnostic failure'); };
  const snapshot = ops.snapshot;
  ops.snapshot = () => {
    const result = snapshot();
    if (result.pid === 104) result.axNodes.find(n => n.AXTitle === mac.AUTO_DOWNLOAD).AXValue = '1';
    return result;
  };
  const report = await mac.runLane(mac.newReport(mac.options(environment())), ops);
  assert.equal(report.webkitPreferenceDiagnostics.captures.length, 4);
  assert.ok(report.webkitPreferenceDiagnostics.captures.every(c => c.status === 'unknown' && c.normalExitVerified));
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].phase, 'auto-download-0.1.13-relaunch');
  assert.equal(report.status, 'failed');
  assert.equal(report.effectivePreferencesTested, false);
  assert.equal(report.releaseReady, false);
});

test('failed, already-exited or forced quit receipts never authorize storage reads', async () => {
  for (const fault of [{ exited: false }, { alreadyExited: true }, { normalQuitRequested: false }, { forceKillPerformed: true }]) {
    const events = [], ops = operations(events), quit = ops.quit;
    ops.quit = launched => ({ ...quit(launched), ...fault });
    const report = await mac.runLane(mac.newReport(mac.options({ ...environment(), CREATOR_MAC_LANE: 'fresh' })), ops);
    assert.equal(report.status, 'failed');
    assert.deepEqual(report.webkitPreferenceDiagnostics.captures, []);
    assert.ok(!events.some(e => e.startsWith('storage:')));
  }
});

test('post-toggle snapshot from another process cannot prove preference state', async () => {
  const events = [], ops = operations(events), original = ops.waitSnapshot;
  ops.waitSnapshot = (launched, wanted) => ({ ...original(launched, wanted), ...(wanted === 'auto-download-off' ? { pid: 999 } : {}) });
  const report = await mac.runLane(mac.newReport(mac.options({ ...environment(), CREATOR_MAC_LANE: 'fresh' })), ops);
  assert.equal(report.status, 'failed');
  assert.match(report.failures[0].error, /Preference snapshot ownership mismatch: pid/);
  assert.equal(report.effectivePreferencesTested, false);
  assert.equal(events.filter(e => e.startsWith('preference:')).length, 1);
});

test('uncertain preference AXPress is not retried and remains untested', async () => {
  const events = [], ops = operations(events);
  ops.pressAutoDownloadOff = () => { events.push('uncertain-preference'); throw Error('Preference AXPress outcome uncertain'); };
  const report = await mac.runLane(mac.newReport(mac.options({ ...environment(), CREATOR_MAC_LANE: 'fresh' })), ops);
  assert.equal(report.status, 'failed');
  assert.match(report.failures[0].error, /Preference AXPress outcome uncertain/);
  assert.equal(events.filter(e => e === 'uncertain-preference').length, 1);
  assert.equal(report.effectivePreferencesTested, false);
  assert.equal(report.syntheticPreference.actions.length, 0);
  assert.ok(events.includes('quit:101'));
});

test('each absent existing capability prevents preference presses and persistence claims', async () => {
  for (const name of ['accessibilityTrusted', 'screenCaptureAllowed', 'hasDisplay']) {
    const events = [], ops = operations(events);
    ops.probe = () => ({ ...capability, [name]: false });
    const report = await mac.runLane(mac.newReport(mac.options({ ...environment(), CREATOR_MAC_LANE: 'fresh' })), ops);
    assert.equal(report.status, 'blocked');
    assert.equal(report.effectivePreferencesTested, false);
    assert.equal(report.autoDownloadPreferencePersistenceTested, false);
    assert.ok(!events.some(e => e.startsWith('preference:')));
  }
});

test('target returning terms blocks the preference relaunch proof without repeating terms or preference actions', async () => {
  const events = [], ops = operations(events), original = ops.snapshot;
  ops.snapshot = () => original().pid === 102 ? termsSnapshot() : original();
  const report = await mac.runLane(mac.newReport(mac.options({ ...environment(), CREATOR_MAC_LANE: 'fresh' })), ops);
  assert.equal(report.status, 'blocked');
  assert.equal(report.effectivePreferencesTested, false);
  assert.equal(report.autoDownloadPreferencePersistenceTested, false);
  assert.equal(report.syntheticTerms.actions.length, 2);
  assert.equal(events.filter(e => e.startsWith('preference:')).length, 1);
  assert.equal(report.releaseReady, false);
});

test('refused or non-normal target quit cannot establish preference persistence even after observed off snapshots', async () => {
  for (const at of [1, 2]) {
    const events = [], ops = operations(events), original = ops.quit;
    let calls = 0;
    ops.quit = launched => ({ ...original(launched), ...(++calls === at ? { exited: false } : {}) });
    const report = await mac.runLane(mac.newReport(mac.options({ ...environment(), CREATOR_MAC_LANE: 'fresh' })), ops);
    assert.equal(report.status, 'failed');
    assert.match(report.failures[0].error, /did not quit normally/);
    assert.equal(report.effectivePreferencesTested, false);
    assert.equal(report.autoDownloadPreferencePersistenceTested, false);
    assert.equal(report.launches.length, at);
    assert.equal(events.filter(e => e.startsWith('quit:')).length, at);
    assert.equal(events.filter(e => e.startsWith('preference:')).length, 1);
    assert.equal(report.releaseReady, false);
  }
});

test('missing existing permissions remains blocked while preserving bounded manual-install evidence', async () => {
  const events = [], ops = operations(events);
  ops.probe = () => ({ accessibilityTrusted: false, screenCaptureAllowed: false, hasDisplay: false });
  ops.snapshot = () => ({ ...clone(visible), axReadable: false, axNodes: [] });
  const report = await mac.runLane(mac.newReport(mac.options(environment())), ops);
  assert.equal(report.status, 'blocked');
  assert.equal(report.passed, false);
  assert.equal(report.packageAndManualChecksPassed, true);
  assert.equal(report.releaseReady, false);
  assert.equal(report.blockers.length, 3);
  assert.ok(!events.some(e => e.startsWith('press:') || e.startsWith('capture:')));
});

test('terms, possible privacy prompts and incomplete AX reads are blockers, not implicit consent', () => {
  for (const text of ['Terms of use and risk acknowledgement', 'Accept and continue', 'Allow access to private data']) {
    assert.ok(mac.guiBlockers(capability, { ...visible, axNodes: [{ AXTitle: text }] }).length);
  }
  assert.ok(mac.guiBlockers(capability, { ...visible, axTruncated: true }).length);
  assert.ok(mac.guiBlockers(capability, { ...visible, axReadable: false }).length);
  assert.deepEqual(mac.guiBlockers(capability, termsSnapshot(), true), []);
  assert.ok(mac.guiBlockers(capability, { ...termsSnapshot(), axNodes: [...termsSnapshot().axNodes,
    { AXTitle: 'Allow access to private data' }] }, true).includes('possible-security-privacy-prompt-no-interaction-performed'));
});

test('exact synthetic controls require unique roles/titles, enabled state and the expected normal toggle sequence', () => {
  assert.doesNotThrow(() => mac.termsControl(termsSnapshot(), 'test-terms-checkbox'));
  assert.doesNotThrow(() => mac.termsControl(termsSnapshot(true), 'test-terms-accept'));
  assert.throws(() => mac.termsControl(termsSnapshot(), 'test-terms-accept'));
  assert.throws(() => mac.termsControl(termsSnapshot(true), 'test-terms-checkbox'));
  assert.throws(() => mac.termsControl(termsSnapshot(), 'accept-security-prompt'));
  for (const change of [
    s => { s.axNodes[2].AXTitle += ' '; },
    s => { s.axNodes[2].AXRole = 'AXButton'; },
    s => { delete s.axNodes[2].AXValue; },
    s => { s.axNodes[2].AXEnabled = 'false'; },
    s => { s.axNodes[3].AXTitle = 'Allow'; },
    s => { s.axNodes.push(clone(s.axNodes[2])); },
    s => { s.axNodes.push(clone(s.axNodes[3])); },
    s => { s.axNodes.push({ AXTitle: 'Security permission required' }); },
    s => { s.axTruncated = true; },
    s => { s.windows.push({ id: 124 }); },
  ]) {
    const s = termsSnapshot(); change(s);
    assert.throws(() => mac.termsControl(s, 'test-terms-checkbox'));
  }
  const disabled = termsSnapshot(true); disabled.axNodes[3].AXEnabled = 'false';
  assert.throws(() => mac.termsControl(disabled, 'test-terms-accept'));
});

test('body inspection distinguishes actual observed terms, rendered MCP content and chrome-only windows', () => {
  assert.equal(mac.bodyKind(termsSnapshot()), 'terms');
  assert.equal(mac.bodyKind(visible), 'body');
  assert.doesNotThrow(() => mac.validateBody(visible, 'body'));
  const chrome = { ...clone(visible), axNodes: [{ AXRole: 'AXWindow', AXTitle: 'Creator Hub' }] };
  assert.equal(mac.bodyKind(chrome), 'chrome-or-unready');
  for (const s of [chrome, termsSnapshot(), { ...clone(visible), axTruncated: true },
    { ...clone(visible), axReadable: false }, { ...clone(visible), finishedLaunching: false }]) {
    assert.throws(() => mac.validateBody(s, 'body'));
  }
});

test('frozen actual Intel relaunch with only a stale Terms group and preference off is a body, without altering its raw nodes', () => {
  const snapshot = intelRelaunchFixture.snapshot, before = JSON.stringify(snapshot);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.axNodes[3]));
  assert.equal(mac.termsState(snapshot), 'none');
  assert.equal(mac.bodyKind(snapshot), 'body');
  assert.deepEqual(mac.guiBlockers(capability, snapshot), []);
  assert.doesNotThrow(() => mac.preferenceSnapshot(snapshot, snapshot, '0'));
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(snapshot.axNodes[3].AXTitle, mac.TERMS.title);
});

test('Intel label-only relaunch reaches the unchanged body PNG gate and retains raw AX snapshots', async () => {
  const events = [], ops = operations(events, intelRelaunchFixture.snapshot);
  const report = await mac.runLane(mac.newReport(mac.options({ ...environment(), CREATOR_MAC_LANE: 'fresh' })), ops);
  assert.equal(report.passed, true);
  assert.equal(report.releaseReady, false);
  assert.equal(report.effectivePreferencesTested, true);
  assert.equal(report.termsPersistenceTested, true);
  assert.deepEqual(report.launches[1].snapshot.axNodes, intelRelaunchFixture.snapshot.axNodes);
  assert.ok(events.includes('capture:0.1.13-relaunch-body'));
  assert.equal(report.launches[1].captures[0].screenshot, 'owned-gui-0.1.13-relaunch-body-102.png');
  mac.validatePixels(report.launches[1].captures[0].pixels);
  assert.equal(report.syntheticTerms.actions.length, 2);
  assert.equal(report.syntheticPreference.actions.length, 1);
});

const partialTermsFaults = {
  'checkbox without continue': nodes => { nodes.push(termsSnapshot().axNodes[2]); },
  'continue without checkbox': nodes => { nodes.push(termsSnapshot().axNodes[3]); },
  'ambiguous checkbox': nodes => { nodes.push(...termsSnapshot().axNodes.slice(2), termsSnapshot().axNodes[2]); },
  'ambiguous continue': nodes => { nodes.push(...termsSnapshot().axNodes.slice(2), termsSnapshot().axNodes[3]); },
  'wrong checkbox role': nodes => { const controls = termsSnapshot().axNodes.slice(2); controls[0].AXRole = 'AXButton'; nodes.push(...controls); },
  'wrong continue role': nodes => { const controls = termsSnapshot().axNodes.slice(2); controls[1].AXRole = 'AXGroup'; nodes.push(...controls); },
  'near-match checkbox title': nodes => { const controls = termsSnapshot().axNodes.slice(2); controls[0].AXTitle += ' '; nodes.push(...controls); },
  'near-match continue title': nodes => { const controls = termsSnapshot().axNodes.slice(2); controls[1].AXTitle += ' '; nodes.push(...controls); },
  'Terms heading without controls': nodes => { nodes.push(termsSnapshot().axNodes[1]); },
};
for (const [name, change] of Object.entries(partialTermsFaults)) {
  test(`partial Terms refusal: ${name}, even with MCP and enabled auto-download behind the group`, async () => {
    const snapshot = clone(intelRelaunchFixture.snapshot); change(snapshot.axNodes);
    assert.equal(mac.termsState(snapshot), 'incomplete');
    assert.equal(mac.bodyKind(snapshot), 'chrome-or-unready');
    assert.throws(() => mac.validateBody(snapshot, 'body'));
    assert.throws(() => mac.autoDownloadControl(snapshot, '0'));
    assert.throws(() => mac.termsControl(snapshot, 'test-terms-checkbox'));
    assert.ok(mac.guiBlockers(capability, snapshot, true).includes('terms-controls-or-body-unready-no-interaction-performed'));
    const events = [], ops = operations(events, intelRelaunchFixture.snapshot), original = ops.snapshot;
    ops.snapshot = () => {
      const observed = original();
      if (observed.pid === 102) change(observed.axNodes);
      return observed;
    };
    const report = await mac.runLane(mac.newReport(mac.options({ ...environment(), CREATOR_MAC_LANE: 'fresh' })), ops);
    assert.equal(report.status, 'blocked');
    assert.equal(report.effectivePreferencesTested, false);
    assert.equal(report.syntheticTerms.actions.length, 2);
    assert.equal(report.syntheticPreference.actions.length, 1);
    assert.equal(report.launches[1].captures.length, 0);
    assert.equal(report.releaseReady, false);
  });
}

test('the unique exact Terms controls still block body and preference actions despite an enabled background checkbox', () => {
  const snapshot = clone(intelRelaunchFixture.snapshot);
  snapshot.axNodes.push(...termsSnapshot().axNodes.slice(2));
  assert.equal(mac.termsState(snapshot), 'terms');
  assert.equal(mac.bodyKind(snapshot), 'terms');
  assert.ok(mac.guiBlockers(capability, snapshot).includes('legal-acknowledgement-requires-human-no-acceptance-performed'));
  assert.throws(() => mac.autoDownloadControl(snapshot, '0'));
});

test('a label-only group cannot establish a body without unique enabled preference state and MCP WebArea', () => {
  for (const change of [
    s => { s.axNodes = s.axNodes.filter(n => n.AXTitle !== mac.AUTO_DOWNLOAD); },
    s => { s.axNodes.push(clone(s.axNodes[2])); },
    s => { s.axNodes[2].AXEnabled = 'false'; },
    s => { delete s.axNodes[2].AXValue; },
    s => { s.axNodes[2].AXValue = '2'; },
    s => { s.axNodes = s.axNodes.filter(n => n.AXRole !== 'AXWebArea'); },
    s => { s.axNodes[1].AXTitle = 'Other app'; },
  ]) {
    const snapshot = clone(intelRelaunchFixture.snapshot); change(snapshot);
    assert.equal(mac.bodyKind(snapshot), 'chrome-or-unready');
    assert.throws(() => mac.validateBody(snapshot, 'body'));
    assert.ok(mac.guiBlockers(capability, snapshot).includes('terms-controls-or-body-unready-no-interaction-performed'));
  }
});

test('Intel label-only classification cannot promote a blank relaunch PNG to acceptance', async () => {
  const events = [], ops = operations(events, intelRelaunchFixture.snapshot), original = ops.capture;
  ops.capture = (launched, label, kind) => ({ ...original(launched, label, kind),
    ...(label === '0.1.13-relaunch-body' ? { pixels: { ...renderedPixels, distinctColors: 1, nonBackgroundSamples: 0 } } : {}) });
  const report = await mac.runLane(mac.newReport(mac.options({ ...environment(), CREATOR_MAC_LANE: 'fresh' })), ops);
  assert.equal(report.status, 'failed');
  assert.equal(report.failures[0].phase, 'rendered-body-0.1.13-relaunch');
  assert.equal(report.effectivePreferencesTested, false);
  assert.equal(report.termsPersistenceTested, false);
  assert.equal(report.releaseReady, false);
});

test('body-only pixel evidence rejects blank, insufficient, misframed or unbounded PNG samples', () => {
  assert.doesNotThrow(() => mac.validatePixels(renderedPixels));
  for (const change of [{ width: 0 }, { height: 4097 }, { chromeExcluded: false }, { distinctColors: 1 },
    { distinctColors: 72000 }, { nonBackgroundSamples: 0 }, { nonBackgroundSamples: 72000 },
    { sampledPixels: 1000 }, { sampledPixels: 300001 }, { sampledPixels: 1200.5 },
    { bodyCrop: { x: 0, y: 0, width: 940, height: 580 } }]) {
    assert.throws(() => mac.validatePixels({ ...renderedPixels, ...change }));
  }
});

for (const resetAt of [2, 3]) {
  test(`terms returning on ${resetAt === 2 ? 'normal relaunch' : 'manual replacement'} block without repeat acknowledgement`, async () => {
    const events = [], ops = operations(events), original = ops.snapshot;
    let launches = 0;
    ops.snapshot = () => ++launches === resetAt ? termsSnapshot() : original();
    const report = await mac.runLane(mac.newReport(mac.options(environment())), ops);
    assert.equal(report.status, 'blocked');
    assert.equal(report.passed, false);
    assert.equal(report.releaseReady, false);
    assert.equal(report.syntheticTerms.actions.length, 2);
    assert.equal(events.filter(e => e.startsWith('press:')).length, 2);
    assert.equal(report.launches[resetAt - 1].renderedBodyVerified, undefined);
    assert.equal(report.manualUpgradeTermsPreserved, false);
    assert.equal(report.effectivePreferencesTested, resetAt === 2);
    assert.equal(report.autoDownloadPreferencePersistenceTested, resetAt === 2);
    if (resetAt === 3) assert.ok(!events.some(e => e.startsWith('preference:')));
    assert.ok(report.blockers.includes('legal-acknowledgement-requires-human-no-acceptance-performed'));
  });
}

test('possible OS security/privacy prompt blocks before any synthetic press or screenshot', async () => {
  const events = [], ops = operations(events);
  ops.snapshot = () => ({ ...termsSnapshot(), axNodes: [...termsSnapshot().axNodes, { AXTitle: 'Unidentified developer cannot be opened' }] });
  const report = await mac.runLane(mac.newReport(mac.options(environment())), ops);
  assert.equal(report.status, 'blocked');
  assert.ok(!events.some(e => e.startsWith('press:') || e.startsWith('capture:')));
});

test('possible security prompt after the checkbox blocks continue, with normal owned cleanup', async () => {
  const events = [], ops = operations(events);
  ops.waitSnapshot = () => ({ ...termsSnapshot(true), axNodes: [...termsSnapshot(true).axNodes, { AXTitle: 'Privacy permission required' }] });
  const report = await mac.runLane(mac.newReport(mac.options(environment())), ops);
  assert.equal(report.status, 'failed');
  assert.match(report.failures[0].error, /security\/privacy/);
  assert.deepEqual(events.filter(e => e.startsWith('press:')), ['press:test-terms-checkbox']);
  assert.ok(events.includes('quit:101'));
});

test('uncertain AXPress is never retried or counted as customer consent', async () => {
  const events = [], ops = operations(events);
  ops.pressTerms = () => { events.push('uncertain-action'); throw Error('AXPress outcome uncertain'); };
  const report = await mac.runLane(mac.newReport(mac.options(environment())), ops);
  assert.equal(report.status, 'failed');
  assert.match(report.failures[0].error, /AXPress outcome uncertain/);
  assert.equal(events.filter(e => e === 'uncertain-action').length, 1);
  assert.equal(report.syntheticTerms.customerConsent, false);
  assert.equal(report.syntheticTerms.actions.length, 0);
  assert.ok(events.includes('quit:101'));
});

for (const change of [{ pid: 999 }, { action: 'other' }, { bundleIdentifier: 'other' }, { bundlePath: '/other' },
  { executablePath: '/other' }, { axAction: 'AXSetValue' }, { syntheticTestOnly: false },
  { customerConsent: true }, { userMachineUsed: true }]) {
  test(`synthetic action receipt refuses mismatched ${Object.keys(change)[0]}`, async () => {
    const events = [], ops = operations(events), original = ops.pressTerms;
    ops.pressTerms = (launched, action) => ({ ...original(launched, action), ...change });
    const report = await mac.runLane(mac.newReport(mac.options(environment())), ops);
    assert.equal(report.status, 'failed');
    assert.equal(report.syntheticTerms.actions.length, 0);
    assert.equal(events.filter(e => e.startsWith('press:')).length, 1);
    assert.equal(report.releaseReady, false);
  });
}

for (const change of [{ pid: 999 }, { bodyKind: 'chrome' }, { sha256: 'invalid' }, { screenshot: '../unrelated.png' },
  { pixels: { ...renderedPixels, nonBackgroundSamples: 0 } }]) {
  test(`render receipt refuses mismatched ${Object.keys(change)[0]} before accepting terms`, async () => {
    const events = [], ops = operations(events), original = ops.capture;
    ops.capture = (launched, label, kind) => ({ ...original(launched, label, kind), ...change });
    const report = await mac.runLane(mac.newReport(mac.options(environment())), ops);
    assert.equal(report.status, 'failed');
    assert.equal(report.syntheticTerms.actions.length, 0);
    assert.ok(events.includes('quit:101'));
    assert.equal(report.releaseReady, false);
  });
}

test('already exited/crashed, unrequested or forced quit is not normal quit, and the old app is not replaced', async () => {
  for (const receipt of [{ alreadyExited: true, exited: true, forceKillPerformed: false },
    { normalQuitRequested: true, alreadyExited: true, exited: true, forceKillPerformed: false },
    { normalQuitRequested: false, exited: true, forceKillPerformed: false },
    { normalQuitRequested: true, exited: true, forceKillPerformed: true }]) {
    const events = [], ops = operations(events);
    ops.quit = () => receipt;
    const report = await mac.runLane(mac.newReport(mac.options(environment())), ops);
    assert.equal(report.status, 'failed');
    assert.ok(!events.includes('install:0.1.13'));
  }
});

test('refused normal quit keeps original failure and never installs replacement or repeats consent', async () => {
  const events = [], ops = operations(events);
  ops.quit = p => { events.push(`quit:${p.pid}`); return { normalQuitRequested: true, exited: false, forceKillPerformed: false }; };
  const report = await mac.runLane(mac.newReport(mac.options(environment())), ops);
  assert.equal(report.status, 'failed');
  assert.ok(report.failures[0].error.includes('did not quit normally'));
  assert.equal(events.filter(e => e.startsWith('quit:')).length, 1);
  assert.ok(!events.includes('install:0.1.13'));
  assert.ok(events.includes('preserve'));
});

test('original snapshot failure is retained with owned-process normal cleanup and final preservation', async () => {
  const events = [], ops = operations(events);
  ops.snapshot = () => { throw Error('original AX capture failure'); };
  const report = await mac.runLane(mac.newReport(mac.options(environment())), ops);
  assert.match(report.failures[0].error, /original AX capture failure/);
  assert.ok(events.includes('quit:101'));
  assert.ok(events.includes('preserve'));
  assert.equal(report.releaseReady, false);
});

test('new PID identity mismatch is not treated as ownership or a successful launch', async () => {
  const events = [], ops = operations(events);
  ops.launch = () => ({ pid: 202, bundlePath: '/unrelated/app', executablePath: '/unrelated/app/bin' });
  const report = await mac.runLane(mac.newReport(mac.options(environment())), ops);
  assert.equal(report.status, 'failed');
  assert.ok(!events.some(e => e.startsWith('quit:')));
});

test('Gatekeeper rejection and bundle/executable minimum mismatch stay blocked', async () => {
  const events = [], ops = operations(events), original = ops.install;
  ops.install = version => ({ ...original(version), bundle: { gatekeeper: { status: 3 }, bundleMinimumCoversExecutable: false } });
  const report = await mac.runLane(mac.newReport(mac.options(environment())), ops);
  assert.equal(report.status, 'blocked');
  assert.equal(report.blockers.length, 2);
  assert.equal(report.termsPersistenceTested, true);
  assert.equal(report.releaseReady, false);
});

test('workflow retains pinned manual dispatch, two architectures/four lanes, no build or publication', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/mac-maintenance-validation.yml'), 'utf8');
  const triggers = workflow.match(/^on:\r?\n([\s\S]*?)\r?\n# Read\/download/m)?.[1];
  assert.ok(triggers);
  assert.deepEqual([...triggers.matchAll(/^  ([a-z_]+):/gm)].map(m => m[1]), ['workflow_dispatch']);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /arch: \[X64, ARM64\]/);
  assert.match(workflow, /lane: \[fresh, manual-upgrade\]/);
  assert.match(workflow, /macos-15-intel/);
  assert.match(workflow, /macos-latest/);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /contents: read\s+actions: read/);
  assert.match(workflow, /persist-credentials: false/);
  const jobEnvironment = workflow.match(/\n    env:([\s\S]*?)\n    steps:/)?.[1];
  assert.ok(jobEnvironment);
  assert.doesNotMatch(jobEnvironment, /runner\.|env\./);
  assert.match(workflow, /fs\.realpathSync\(process\.env\.RUNNER_TEMP\)/);
  assert.match(workflow, /fs\.appendFileSync\(process\.env\.GITHUB_ENV/);
  assert.ok(workflow.includes(mac.CANDIDATE.runId));
  for (const architecture of ['X64', 'ARM64']) assert.ok(workflow.includes(mac.CANDIDATE.artifacts[architecture].dmgSha256));
  assert.doesNotMatch(workflow, /pull_request_target|npm (?:ci|run build)|cargo build|gh (?:release|workflow)|contents: write|TAURI_SIGNING|APPLE_(?:ID|PASSWORD|CERTIFICATE)/);
});

test('Swift helper permits only guarded exact terms/target-13 preference AXPress, preflight and owned normal lifecycle', () => {
  const swift = fs.readFileSync(path.join(__dirname, 'native-mac-window.swift'), 'utf8');
  assert.match(swift, /AXIsProcessTrusted\(\)/);
  assert.match(swift, /CGPreflightScreenCaptureAccess\(\)/);
  assert.match(swift, /NSWorkspace.shared.openApplication/);
  assert.match(swift, /app\.terminate\(\)/);
  assert.match(swift, /canonical\(executable\).*args\[3\]/);
  assert.match(swift, /canonical\(bundle\) == canonical\(installedURL\(\)\)/);
  assert.match(swift, /env\["GITHUB_REPOSITORY"\] == "BOBWORKS-XR\/CREATOR-HUB"/);
  assert.match(swift, /env\["RUNNER_ENVIRONMENT"\] == "github-hosted"/);
  assert.match(swift, /env\["CREATOR_MAC_SYNTHETIC_TERMS_TEST"\] == "1"/);
  assert.match(swift, /guard ciScope\(true\), AXIsProcessTrusted\(\), CGPreflightScreenCaptureAccess\(\), app\.isActive/);
  assert.match(swift, /target\(\)\?\.processIdentifier == app\.processIdentifier/);
  assert.equal((swift.match(/AXUIElementPerformAction\(/g) || []).length, 2);
  assert.match(swift, /AXUIElementPerformAction\(selected, kAXPressAction as CFString\)/);
  assert.match(swift, /result\["customerConsent"\] = false/);
  for (const title of Object.values(mac.TERMS)) assert.ok(swift.includes(`"${title}"`));
  assert.ok(swift.includes(`"${mac.AUTO_DOWNLOAD}"`));
  assert.match(swift, /env.*CREATOR_MAC_SYNTHETIC_PREFERENCE_TEST|environment\["CREATOR_MAC_SYNTHETIC_PREFERENCE_TEST"\] == "1"/);
  assert.match(swift, /guard preferenceScope\(\), target13\(\), AXIsProcessTrusted\(\), CGPreflightScreenCaptureAccess\(\)/);
  assert.match(swift, /CFBundleShortVersionString"\) as\? String == "0\.1\.13"/);
  assert.match(swift, /CFBundleVersion"\) as\? String == "0\.1\.13"/);
  assert.match(swift, /attribute\(selected, kAXValueAttribute\) as\? NSNumber\)\?\.intValue == 1/);
  assert.match(swift, /result\["requestedValue"\] = "0"/);
  assert.match(swift, /case "test-auto-download-off":/);
  assert.match(swift, /image\.height \* 60 \/ 100/);
  assert.match(swift, /AXUIElementSetMessagingTimeout\(element, 0\.25\)/);
  assert.match(swift, /\$0\[kAXRoleAttribute\] == "AXWebArea"/);
  assert.match(swift, /func termsState\(_ nodes: \[\[String: String\]\]\) -> String/);
  assert.match(swift, /hints\.count == 2 && checks\.count == 1 && buttons\.count == 1/);
  assert.match(swift, /termsState\(tree\.nodes\) == "terms"/);
  assert.match(swift, /termsState\(tree\.nodes\) == "none"/);
  assert.doesNotMatch(swift, /!text\.contains\(termsTitle\)/);
  assert.doesNotMatch(swift, /forceTerminate|CGRequestScreenCaptureAccess|AXIsProcessTrustedWithOptions|AXUIElementSetAttributeValue|CGEvent|kill\(|evaluateJavaScript|osascript|tccutil|spctl/);
});
