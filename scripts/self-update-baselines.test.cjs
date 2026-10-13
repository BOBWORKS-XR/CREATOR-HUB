const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { baselines, selectBaseline, assertPreviousStable } = require('./self-update-baselines.cjs');

test('registry retains exact public 0.1.11 and 0.1.12 Windows artifact pins', () => {
  assert.deepEqual(baselines, [
    {
      version: '0.1.11', asset: 'Creator.Hub_0.1.11_x64-setup.exe',
      installer: '90018f10096a52ad9abb5e2f8634acd6f8dfcea39cffd7ca2e25b92a54a7f07e',
      exe: 'b1ed8b37debb0e9e650ccdd62b954bd68e054590d1821092b25e68f545600c21',
    },
    {
      version: '0.1.12', asset: 'Creator.Hub_0.1.12_x64-setup.exe',
      installer: '0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18',
      exe: '34c6f05548f469ac23b4faee7aa8355d5cca083c444c4f7b0942426a9c76a7ac',
    },
  ]);
  assert.ok(Object.isFrozen(baselines));
  assert.ok(baselines.every(Object.isFrozen));
});

test('installed candidate latest-Hub lane uses the shared pinned public baseline', () => {
  const fs = require('node:fs');
  const script = fs.readFileSync(require('node:path').join(__dirname, 'Test-InstalledCandidate.ps1'), 'utf8');
  const workflow = fs.readFileSync(require('node:path').join(__dirname, '../.github/workflows/windows-candidate.yml'), 'utf8');
  assert.match(script, /ValidateSet\([^\n]*'current-public'/);
  assert.match(script, /\$HubBaseline -eq 'current-public'/);
  assert.match(script, /self-update-baselines\.cjs'\) \$version/);
  assert.match(script, /\$LASTEXITCODE -ne 0\) \{ throw 'Pinned public baseline selection failed\.'/);
  assert.match(workflow, /-eq 'latest-hub'\) \{ 'current-public' \}/);
  assert.doesNotMatch(workflow, /-eq 'latest-hub'\) \{ 'stable-0\.1\.11' \}/);
  assert.equal(selectBaseline(require('../package.json').version).version, '0.1.12');
});

test('stable targets select the highest pinned version strictly below the target', () => {
  for (const [target, expected] of [['0.1.12', '0.1.11'], ['0.1.13', '0.1.12'], ['0.1.20', '0.1.12'], ['1.0.0', '0.1.12']]) {
    assert.equal(selectBaseline(target).version, expected, target);
  }
});

test('prereleases use SemVer ordering and only public stable baselines', () => {
  for (const [target, expected] of [['0.1.12-alpha.1', '0.1.11'], ['0.1.12-rc.10', '0.1.11'], ['0.1.13-alpha.1', '0.1.12']]) {
    assert.equal(selectBaseline(target).version, expected, target);
  }
});

test('same-version and older targets cannot select an ineligible baseline', () => {
  for (const target of ['0.1.11', '0.1.11-rc.1', '0.0.9']) {
    assert.throws(() => selectBaseline(target), /No pinned public stable baseline is older/);
  }
  assert.notEqual(selectBaseline('0.1.12').version, '0.1.12');
});

test('invalid, noncanonical and build-metadata targets fail closed', () => {
  for (const target of ['', undefined, null, 13, 'v0.1.13', '0.1', '0.1.013', '0.1.13 ', '0.1.13+build', '0.1.13-']) {
    assert.throws(() => selectBaseline(target), /canonical SemVer without build metadata/);
  }
});

test('fixture hash overrides cannot mutate public pins or later selections', () => {
  const baseline = selectBaseline('0.1.13');
  const original = { ...baseline };
  baseline.installer = 'a'.repeat(64); baseline.exe = 'b'.repeat(64);
  assert.deepEqual(selectBaseline('0.1.13'), original);
});

test('actual public previous stable must exactly match the selected pins', () => {
  assertPreviousStable('0.1.11', selectBaseline('0.1.12'));
  assertPreviousStable('0.1.12', selectBaseline('0.1.13'));
  for (const previous of ['0.1.11', '0.1.13', '0.1.12-rc.1', null, undefined]) {
    assert.throws(() => assertPreviousStable(previous, selectBaseline('0.1.14')), /previous public stable Hub/);
  }
});

test('CLI retains checked-out default and selects 0.1.12 explicitly for maintenance 0.1.13', () => {
  const run = args => spawnSync(process.execPath, [require.resolve('./self-update-baselines.cjs'), ...args], { encoding: 'utf8' });
  const current = run([]);
  assert.equal(current.status, 0, current.stderr);
  assert.deepEqual(JSON.parse(current.stdout), selectBaseline(require('../package.json').version));
  for (const [target, expected] of [['0.1.12', '0.1.11'], ['0.1.13', '0.1.12'], ['0.1.13-alpha.1', '0.1.12']]) {
    const result = run([target]);
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).version, expected);
  }
  for (const args of [['0.1.11'], ['0.1.13+build'], [''], ['0.1.13', 'extra']]) {
    const result = run(args);
    assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
  }
});

const smokePath = path.join(__dirname, 'native-self-update-smoke.cjs');
function smokePreflight(env = {}, fixture = null) {
  const source = fs.readFileSync(smokePath, 'utf8');
  const boundary = source.indexOf('const hub = path.join');
  assert.ok(boundary > 0, 'Run only baseline/fixture preflight, never native installation');
  const forbidden = () => { throw Error('Native actions are forbidden in unit preflight'); };
  const dependencies = {
    'node:assert/strict': assert,
    'node:fs': { readFileSync(file) { assert.equal(file, 'fixture.json'); return JSON.stringify(fixture); } },
    'node:path': path,
    'node:crypto': require('node:crypto'),
    'node:child_process': { spawn: forbidden, execFileSync: forbidden },
    '@playwright/test': { chromium: {} },
    './check-release-feed.cjs': { checkLive: forbidden },
    './verify-plugins-icon.cjs': { verifyPluginsIcon: forbidden },
    './self-update-baselines.cjs': { selectBaseline, assertPreviousStable },
    '../package.json': require('../package.json'),
  };
  const result = vm.runInNewContext(`${source.slice(0, boundary)}\n({ from, to, fixture })`, {
    process: { env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
      CREATOR_SELF_UPDATE_INSTALLER_SHA256: 'c'.repeat(64), CREATOR_SELF_UPDATE_EXECUTABLE_SHA256: 'd'.repeat(64), ...env } },
    require(name) { assert.ok(Object.hasOwn(dependencies, name), `Unexpected preflight dependency: ${name}`); return dependencies[name]; },
  }, { timeout: 1000 });
  return JSON.parse(JSON.stringify(result));
}

test('real harness preflight selects exact public 0.1.12 pins for checked-out maintenance 0.1.13', () => {
  assert.equal(require('../package.json').version, '0.1.13');
  const result = smokePreflight();
  assert.equal(result.to.version, '0.1.13');
  assert.deepEqual(result.from, selectBaseline('0.1.13'));
  assert.equal(result.fixture, null);
  const source = fs.readFileSync(smokePath, 'utf8');
  assert.match(source, /assertPreviousStable\(report\.feed\.previousStable, from\)/);
  for (const statement of ['assert.equal(hash(installer), from.installer);', 'assert.equal(hash(hub), from.exe);',
    'assert.equal(hash(sentinel), sentinelHash);', 'assert.equal(hash(configPath), configHash);',
    'await retry(() => assert.equal(hash(hub), to.exe), 180);']) {
    assert.ok(source.includes(statement), `Retain safeguard: ${statement}`);
  }
  assert.match(source, /fixture \? 'version-only-runtime-fixture-not-public-stable' : 'unmodified-public-stable'/);
});

test('real harness keeps target equality and exact target hash checks before native actions', () => {
  assert.throws(() => smokePreflight({ CREATOR_SELF_UPDATE_TARGET_VERSION: '0.1.12' }), /intended release/);
  for (const field of ['CREATOR_SELF_UPDATE_INSTALLER_SHA256', 'CREATOR_SELF_UPDATE_EXECUTABLE_SHA256']) {
    for (const value of ['', 'invalid', 'A'.repeat(64)]) assert.throws(() => smokePreflight({ [field]: value }));
  }
});

test('real fixture preflight keeps scope checks and overrides only a fresh baseline copy', () => {
  const fixture = { testOnly: true, fromVersion: '0.1.12', toVersion: '0.1.13',
    installerSha256: 'a'.repeat(64), executableSha256: 'b'.repeat(64) };
  const result = smokePreflight({ CREATOR_HOSTED_UPDATE_FIXTURE: 'fixture.json' }, fixture);
  assert.equal(result.from.version, '0.1.12');
  assert.equal(result.from.installer, fixture.installerSha256);
  assert.equal(result.from.exe, fixture.executableSha256);
  assert.deepEqual(smokePreflight().from, selectBaseline('0.1.13'));
  for (const patch of [{ testOnly: false }, { fromVersion: '0.1.11' }, { fromVersion: '0.1.10' },
    { toVersion: '0.1.14' }, { installerSha256: 'bad' }, { executableSha256: 'bad' }]) {
    assert.throws(() => smokePreflight({ CREATOR_HOSTED_UPDATE_FIXTURE: 'fixture.json' }, { ...fixture, ...patch }));
  }
});

test('self-update harness refuses local, self-hosted and non-Windows environments before native actions', () => {
  for (const env of [{ GITHUB_ACTIONS: 'false' },
    { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_OS: 'Windows' },
    { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux' }]) {
    const result = spawnSync(process.execPath, [smokePath], {
      encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, ...env },
    });
    assert.ifError(result.error); assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restricted to a disposable GitHub-hosted Windows runner/);
    assert.doesNotMatch(result.stderr, /ENOENT|Cannot find module/);
  }
});

test('workflow selects one shared baseline before fixture build/reuse and retains acceptance guards', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/self-update-acceptance.yml'), 'utf8');
  const version = workflow.indexOf('- name: Read the packaged target version');
  const baseline = workflow.indexOf('- name: Select the pinned previous public stable baseline');
  const build = workflow.indexOf('- name: Build test-only version fixture');
  assert.ok(version > 0 && baseline > version && build > baseline);
  assert.equal((workflow.match(/node scripts\/self-update-baselines\.cjs/g) || []).length, 1);
  assert.equal((workflow.match(/SELECTED_FROM_VERSION: \$\{\{ steps\.baseline\.outputs\.version \}\}/g) || []).length, 2);
  assert.match(workflow, /if \(\$LASTEXITCODE -ne 0\) \{ throw 'Public self-update baseline selection failed\.'/);
  assert.match(workflow, /Build-HostedUpdateFixture\.ps1 -FromVersion \$env:SELECTED_FROM_VERSION/);
  assert.match(workflow, /\$fixture\.testOnly -ne \$true -or \$fixture\.fromVersion -ne \$env:SELECTED_FROM_VERSION -or \$fixture\.toVersion -ne \$env:REQUESTED_TARGET_VERSION/);
  assert.match(workflow, /\$fixture\.sourceRevision -notmatch '\^\[a-f0-9\]\{40\}\$'/);
  assert.match(workflow, /git diff --quiet \$fixture\.sourceRevision HEAD -- package\.json package-lock\.json src src-tauri/);
  assert.match(workflow, /REQUESTED_TARGET_VERSION -ne \$version/);
  assert.match(workflow, /Published installer differs from its checksum/);
  assert.match(workflow, /Published preflight and installed executables differ/);
  assert.match(workflow, /node scripts\/check-release-feed\.cjs \$\{\{ inputs\.target_version \}\}/);
  assert.match(workflow, /node scripts\/native-self-update-smoke\.cjs/);
  assert.doesNotMatch(workflow, /-FromVersion 0\.1\.|fromVersion -ne '0\.1\./);
});
