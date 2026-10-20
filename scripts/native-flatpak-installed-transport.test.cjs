'use strict';
// Local tests never install, compile, launch Flatpak, or inspect user settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const harness = require('./native-flatpak-installed-transport.cjs');
const root = path.resolve(__dirname, '..');
const file = path.join(__dirname, 'native-flatpak-installed-transport.cjs');
const source = fs.readFileSync(file, 'utf8');
const workflowFile = path.join(root, '.github/workflows/flatpak-installed-host-launch-014.yml');
const workflowText = fs.readFileSync(workflowFile, 'utf8');
const { yaml } = require('playwright-core/lib/utilsBundle');
const workflow = yaml.parse(workflowText, { uniqueKeys: true });
const pin = n => n.repeat(64);
const validEnv = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
  RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: harness.BRANCH, GITHUB_SHA: 'a'.repeat(40),
  GITHUB_RUN_ID: '39042096460', GITHUB_RUN_ATTEMPT: '1', CREATOR_FLATPAK_INSTALLED_TRANSPORT: '1',
  RUNNER_TEMP: path.resolve('runner-owned-temp') });
const context = '[Context]\nshared=ipc;\nsockets=wayland;fallback-x11;\ndevices=dri;\n';
const goodMetadata = () => harness.fixtureMetadata() + '\n' + context;
const goodReport = () => ({ schemaVersion: 1, scope: 'synthetic-owned-flatpak-launch-only',
  syntheticLaunchProofPassed: true, ownedChildReaped: true, reason: 'synthetic-echo-and-owned-exit',
  ...Object.fromEntries(harness.FALSE_FIELDS.map(key => [key, false])) });

test('admission requires exact disposable native repository, branch, event and opt-in', () => {
  for (const event of ['push', 'workflow_dispatch']) {
    const env = { ...validEnv(), GITHUB_EVENT_NAME: event };
    assert.equal(harness.admission(env, 'linux', 'x64', 1001, 1001).uid, 1001);
    for (const ref of ['refs/heads/main', 'refs/heads/validation/flatpak-host-launch-014',
      harness.BRANCH + '-foreign', 'refs/tags/v0.1.14']) {
      assert.throws(() => harness.admission({ ...env, GITHUB_REF: ref }, 'linux', 'x64', 1001, 1001));
    }
  }
  for (const key of Object.keys(validEnv())) {
    const env = validEnv(); delete env[key];
    assert.throws(() => harness.admission(env, 'linux', 'x64', 1001, 1001), key);
  }
  for (const [platform, arch, uid, gid] of [['win32', 'x64', 1001, 1001], ['linux', 'arm64', 1001, 1001],
    ['linux', 'x64', 0, 1001], ['linux', 'x64', 1001, 0]]) {
    assert.throws(() => harness.admission(validEnv(), platform, arch, uid, gid));
  }
  for (const [key, value] of [['GITHUB_EVENT_NAME', 'pull_request'], ['GITHUB_EVENT_NAME', 'workflow_run'],
    ['GITHUB_EVENT_NAME', 'schedule'], ['GITHUB_REF', 'refs/heads/main'],
    ['RUNNER_ENVIRONMENT', 'self-hosted'], ['GITHUB_REPOSITORY_ID', '1'], ['FLATPAK_ID', harness.APP]]) {
    assert.throws(() => harness.admission({ ...validEnv(), [key]: value }, 'linux', 'x64', 1001, 1001));
  }
});

test('runtime injection and uncanonical work roots refuse before filesystem work', () => {
  for (const key of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'RUSTC_WRAPPER',
    'RUSTC_WORKSPACE_WRAPPER', 'NODE_OPTIONS', 'BASH_ENV', 'ENV']) {
    assert.throws(() => harness.admission({ ...validEnv(), [key]: '' }, 'linux', 'x64', 1001, 1001));
  }
  assert.throws(() => harness.admission({ ...validEnv(), RUNNER_TEMP: 'relative' }, 'linux', 'x64', 1001, 1001));
  assert.throws(() => harness.admission({ ...validEnv(), RUNNER_TEMP: path.resolve('tmp') + path.sep + '..' }, 'linux', 'x64', 1001, 1001));
});

test('child environment has only fresh fixture paths, not a session bus or live settings', () => {
  const work = path.resolve('private-fixture'); const env = harness.childEnvironment(work);
  assert.deepEqual(Object.keys(env).sort(), ['FLATPAK_FANCY_OUTPUT', 'FLATPAK_TTY_PROGRESS', 'FLATPAK_USER_DIR',
    'HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR'].sort());
  for (const name of harness.CHILDREN) assert.ok(Object.values(env).includes(path.join(work, name)), name);
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.doesNotMatch(JSON.stringify(env), /DBUS|DISPLAY|WAYLAND_DISPLAY|SSH|flatpak-spawn/);
});

test('independent pins are exact, lowercase, nonzero and immutable', () => {
  const pins = harness.pinsFrom(pin('a'), pin('b') + '\n', pin('c'), pin('d'));
  assert.ok(Object.isFrozen(pins)); assert.equal(Object.keys(pins).length, 4);
  assert.equal(pins.CREATOR_FLATPAK_LAUNCH_APP_COMMIT, pin('a'));
  assert.equal(pins.CREATOR_FLATPAK_LAUNCH_RUNTIME_COMMIT, pin('b'));
  for (const bad of ['A'.repeat(64), '0'.repeat(64), pin('a') + ' ', 'a'.repeat(63), pin('a') + '\n\n', '../bad']) {
    assert.throws(() => harness.commit(bad));
    assert.throws(() => harness.pinsFrom(pin('a'), bad, pin('c'), pin('d')));
  }
});

test('metadata fixes one synthetic command, app, architecture, branch and runtime', () => {
  assert.equal(harness.REF, 'app/com.creatorworks.hub/x86_64/flatpak-test');
  assert.equal(harness.RUNTIME, 'runtime/org.gnome.Platform/x86_64/50');
  assert.ok(harness.metadata(goodMetadata()));
  assert.ok(harness.metadata(context, true));
  for (const [from, to] of [['com.creatorworks.hub', 'com.foreign.App'], ['/app/libexec/', '/usr/bin/'],
    ['x86_64/50', 'x86_64/49'], ['command=', 'extra='], ['[Application]', '[Runtime]']]) {
    assert.throws(() => harness.metadata(goodMetadata().replace(from, to)));
  }
});

test('exact sandbox grants refuse network, home, host spawn, buses and ambiguous duplicates', () => {
  for (const text of [goodMetadata().replace('ipc;', 'ipc;network;'),
    goodMetadata().replace('fallback-x11;', 'fallback-x11;x11;'),
    goodMetadata().replace('dri;', 'all;'), goodMetadata() + 'filesystems=home;\n',
    goodMetadata() + 'features=devel;\n', goodMetadata() + 'sockets=wayland;\n',
    goodMetadata() + '[Session Bus Policy]\norg.freedesktop.Flatpak=talk\n',
    goodMetadata() + '[Environment]\nLD_PRELOAD=anything\n',
    goodMetadata() + '[Context]\nshared=ipc;\n']) {
    assert.throws(() => harness.metadata(text));
  }
  assert.ok(harness.metadata(goodMetadata() + 'features=!devel;\n'));
});

test('metadata refuses unsupported escape, line, section, encoding and size formats', () => {
  for (const bad of ['[Context]\nshared=ipc\\s;\n', '[Context]\nshared=ipc;\0', '[Context]\r\n',
    '[Context]\nmissing-equals\n', 'a=b\n', goodMetadata() + 'a=' + 'x'.repeat(8193), 'x'.repeat(65537)]) {
    assert.throws(() => harness.metadata(bad));
  }
});

test('success is only synthetic installed launch and owned reap, never broader acceptance', () => {
  assert.ok(harness.nativeReport(JSON.stringify(goodReport()), 0).ownedChildReaped);
  for (const field of harness.FALSE_FIELDS) {
    assert.throws(() => harness.nativeReport(JSON.stringify({ ...goodReport(), [field]: true }), 0), field);
  }
  for (const change of [{ syntheticLaunchProofPassed: false }, { ownedChildReaped: false }, { reason: 'forced-cleanup' },
    { scope: 'integration' }, { schemaVersion: 2 }, { extra: false }]) {
    assert.throws(() => harness.nativeReport(JSON.stringify({ ...goodReport(), ...change }), 0));
  }
  for (const status of [77, 1, null]) assert.throws(() => harness.nativeReport(JSON.stringify(goodReport()), status));
  assert.throws(() => harness.nativeReport(JSON.stringify(goodReport()) + 'garbage', 0));
  assert.throws(() => harness.nativeReport('x'.repeat(8193), 0));
});

// Observed portable libtest output; only the requested test name is substituted.
const testOutput = name => `\nrunning 1 test\ntest ${name} ... ok\n\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1 filtered out; finished in 0.00s\n\n`;
const testResult = name => ({ status: 0, signal: null, stdout: testOutput(name), stderr: '' });

test('four lifecycle names are immutable, exact and present as installed-profile Rust tests', () => {
  assert.ok(Object.isFrozen(harness.LIFECYCLE_TESTS));
  assert.deepEqual(harness.LIFECYCLE_TESTS, [
    'linux::launch::tests::installed_session_retains_live_echo_and_finishes_explicitly',
    'linux::launch::tests::duplicate_challenge_poison_closes_without_retry',
    'linux::launch::tests::drop_reaps_only_its_owned_child_and_other_session_remains_live',
    'linux::launch::tests::expired_live_session_refuses_and_cannot_restart_exchange',
  ]);
  const rust = fs.readFileSync(path.join(root, 'native/flatpak-host-launch/src/linux/launch.rs'), 'utf8');
  for (const name of harness.LIFECYCLE_TESTS) assert.ok(rust.includes(`fn ${name.split('::').at(-1)}()`), name);
});

test('Cargo JSON binds exactly one successful library test executable to the separate target', () => {
  const target = path.resolve('owned-lifecycle-target');
  const executable = path.join(target, 'release', 'deps', 'creator_hub_flatpak_host_launch-' + 'a'.repeat(16));
  const artifact = { reason: 'compiler-artifact', executable,
    target: { name: 'creator_hub_flatpak_host_launch', kind: ['lib'] }, profile: { test: true } };
  const finished = { reason: 'build-finished', success: true };
  const encode = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  assert.equal(harness.lifecycleExecutable(encode([artifact, finished]), target), executable);
  for (const rows of [[finished], [artifact], [artifact, artifact, finished], [artifact, finished, finished],
    [artifact, { ...finished, success: false }],
    [{ ...artifact, profile: { test: false } }, finished],
    [{ ...artifact, target: { ...artifact.target, name: 'foreign' } }, finished],
    [{ ...artifact, target: { ...artifact.target, kind: ['bin'] } }, finished],
    [{ ...artifact, executable: path.join(target, 'debug', 'deps', path.basename(executable)) }, finished],
    [{ ...artifact, executable: path.join(target, 'release', 'deps', 'foreign') }, finished],
    [{ ...artifact, executable: 'relative' }, finished]]) {
    assert.throws(() => harness.lifecycleExecutable(encode(rows), target));
  }
  assert.throws(() => harness.lifecycleExecutable('not-json', target));
  assert.throws(() => harness.lifecycleExecutable('x'.repeat(1024 * 1024 + 1), target));
});

test('libtest status zero cannot hide zero, ignored, wrong-name or failed tests', () => {
  const name = harness.LIFECYCLE_TESTS[0];
  assert.deepEqual(harness.lifecycleResult(name, testResult(name)), { name, passed: 1, failed: 0, ignored: 0 });
  for (const changed of [{ status: 1 }, { signal: 'SIGTERM' }, { error: { code: 'ETIMEDOUT' } },
    { stdout: testOutput(name).replace('running 1 test', 'running 0 tests') },
    { stdout: testOutput('foreign') }, { stdout: testOutput(name).replace('0 ignored', '1 ignored') },
    { stdout: testOutput(name).replace('1 passed; 0 failed', '0 passed; 1 failed') },
    { stdout: testOutput(name) + 'test result: ok. 0 passed\n' },
    { stdout: 'x'.repeat(16385) }, { stderr: 'x'.repeat(16385) }]) {
    assert.throws(() => harness.lifecycleResult(name, { ...testResult(name), ...changed }));
  }
  assert.throws(() => harness.lifecycleResult('foreign', testResult('foreign')));
  assert.throws(() => harness.nativeReport(JSON.stringify({ ...goodReport(), fixedEchoLifecycleTestsPassed: true }), 0),
    'The original CLI report schema must not acquire the harness flag');
});

test('observed libtest summary requires zero measured tests and rejects unknown counts', () => {
  const name = harness.LIFECYCLE_TESTS[0];
  const output = testOutput(name);
  assert.deepEqual(harness.lifecycleResult(name, { ...testResult(name), stdout: output.replace(/\n/g, '\r\n') }),
    { name, passed: 1, failed: 0, ignored: 0 });
  for (const [before, after] of [
    ['0 measured; ', ''], ['0 measured', '1 measured'], ['0 measured', 'unknown measured'],
    ['1 passed', 'unknown passed'], ['0 failed', 'unknown failed'], ['0 ignored', 'unknown ignored'],
    ['1 filtered out', 'unknown filtered out'], ['1 filtered out', '-1 filtered out'],
    ['0 measured;', '0 measured; 0 unknown;'],
  ]) {
    assert.throws(() => harness.lifecycleResult(name, { ...testResult(name), stdout: output.replace(before, after) }),
      `${before} -> ${after}`);
  }
});

test('lifecycle sequence is finite, exact and bracketed by independent checkpoints', () => {
  const steps = [];
  const results = harness.runLifecycleTests(args => {
    steps.push(['execute', args]); return testResult(args[0]);
  }, (phase, index, name) => steps.push([phase, index, name]));
  assert.equal(results.length, 4);
  assert.deepEqual(steps, harness.LIFECYCLE_TESTS.flatMap((name, index) => [
    ['before', index, name], ['execute', [name, '--exact', '--ignored', '--test-threads=1', '--color=never']],
    ['after', index, name],
  ]));
});

test('test failure, execution exception or checkpoint drift stops without retries', () => {
  for (const failure of ['test', 'execution', 'before', 'after']) {
    const executed = [], checkpoints = [];
    assert.throws(() => harness.runLifecycleTests(args => {
      executed.push(args[0]);
      if (failure === 'execution') throw Error('Synthetic execution failure');
      return { ...testResult(args[0]), status: failure === 'test' ? 1 : 0 };
    }, phase => {
      checkpoints.push(phase);
      if (failure === phase) throw Error('Synthetic checkpoint drift');
    }));
    assert.equal(executed.length, failure === 'before' ? 0 : 1);
    assert.deepEqual(checkpoints, failure === 'before' ? ['before'] : ['before', 'after']);
  }
});

test('lifecycle build and execution reuse the reviewed pins, native cwd and finite proof environment', () => {
  const cli = source.indexOf('const proof = nativeReport(');
  const compile = source.indexOf("const compiled = invoke(cargo, ['test'");
  const execute = source.indexOf('const results = runLifecycleTests(');
  const scopedPass = source.indexOf('report.fixedEchoLifecycleTestsPassed = true');
  assert.ok(cli > 0 && cli < compile && compile < execute && execute < scopedPass);
  assert.match(source, /invoke\(cargo, cargoArgs\(HOST\), pinnedBuildEnv/);
  assert.match(source, /'--message-format=json', '--manifest-path', manifest, '--target-dir', lifecycleTarget\], pinnedBuildEnv/);
  assert.match(source, /invoke\(report\.hostImage\.path, \['prove-installed'\], proofEnv, 42000, false\)/);
  assert.match(source, /invoke\(executable, args, proofEnv, 75000, false\)/);
  assert.match(source, /spawnSync\(file, args, \{ cwd: source, env: childEnv/);
  assert.match(source, /const lifecycleTarget = path\.join\(work, 'lifecycle-target'\)/);
  assert.match(source, /fixedEchoLifecycleTestsPassed: false/);
  for (const check of ['Deployment changed during lifecycle tests', 'Pinned host changed during lifecycle tests',
    'Lifecycle executable changed', 'Runtime/extension inventory changed', 'Frozen echo changed',
    'Echo recompiled during host-only build', 'Isolated settings changed']) assert.ok(source.includes(check), check);
  assert.match(source, /\+\+count <= 300/);
});

test('system and user directories are separately checked without adopting writable or symlinked ancestors', t => {
  const target = path.resolve('owned-temp', 'fixture');
  const stat = (uid, mode) => ({ uid, mode, isDirectory: () => true });
  t.mock.method(fs, 'lstatSync', p => stat(p === target ? 1001 : 0, p === target ? 0o700 : 0o755));
  assert.equal(harness.safeDirectory(target, 1001, 0o700).uid, 1001);
  assert.equal(harness.safeDirectory(path.dirname(target), 1001).uid, 0);
  fs.lstatSync.mock.mockImplementation(() => stat(0, 0o777));
  assert.throws(() => harness.safeDirectory(target, 1001));
  fs.lstatSync.mock.mockImplementation(() => ({ uid: 1001, mode: 0o700, isDirectory: () => false }));
  assert.throws(() => harness.safeDirectory(target, 1001));
  fs.lstatSync.mock.mockImplementation(() => stat(1002, 0o700));
  assert.throws(() => harness.safeDirectory(target, 1001));
});

test('image pins bind ordinary owner-protected x86_64 ELF bytes and filesystem identity', t => {
  const bytes = Buffer.alloc(128); Buffer.from([127, 69, 76, 70, 2, 1]).copy(bytes); bytes.writeUInt16LE(62, 18);
  let uid = 0; let mode = 0o755; let size = bytes.length; let isFile = true;
  t.mock.method(fs, 'lstatSync', () => ({ uid, gid: uid, mode, size, dev: 3, ino: 7, nlink: 1, isFile: () => isFile }));
  t.mock.method(fs, 'readFileSync', () => bytes);
  const pinned = harness.image('/usr/bin/flatpak', 1001, true);
  assert.equal(pinned.dev, 3); assert.equal(pinned.ino, 7); assert.match(pinned.sha256, /^[a-f0-9]{64}$/);
  uid = 1001; assert.throws(() => harness.image('/usr/bin/flatpak', 1001, true)); uid = 0;
  mode = 0o777; assert.throws(() => harness.image('/usr/bin/flatpak', 1001, true)); mode = 0o755;
  mode = 0o4755; assert.throws(() => harness.image('/usr/bin/flatpak', 1001, true)); mode = 0o755;
  mode = 0o644; assert.throws(() => harness.image('/usr/bin/flatpak', 1001, true)); mode = 0o755;
  size = 33 * 1024 * 1024; assert.throws(() => harness.image('/usr/bin/flatpak', 1001, true)); size = 128;
  isFile = false; assert.throws(() => harness.image('/usr/bin/flatpak', 1001, true)); isFile = true;
  bytes.writeUInt16LE(183, 18); assert.throws(() => harness.image('/usr/bin/flatpak', 1001, true));
});

test('source order freezes and installs echo before compiling ONLY host with independent pins', () => {
  const echo = source.indexOf('invoke(cargo, cargoArgs(ECHO),');
  const frozen = source.indexOf('fs.copyFileSync(originalEcho.path, frozen,');
  const installed = source.indexOf("fp(['install', '--user'");
  const inspected = source.indexOf('const installedBefore = inspect();');
  const receipt = source.indexOf("save('independent-pins.json'");
  const host = source.indexOf('invoke(cargo, cargoArgs(HOST),');
  const execution = source.indexOf("['prove-installed']");
  assert.ok(echo > 0 && echo < frozen && frozen < installed && installed < inspected && inspected < receipt
    && receipt < host && host < execution);
  assert.equal([...source.matchAll(/invoke\(cargo, cargoArgs\(ECHO\)/g)].length, 1);
  assert.equal([...source.matchAll(/invoke\(cargo, cargoArgs\(HOST\)/g)].length, 1);
  assert.match(source, /\{ \.\.\.buildEnv, \.\.\.pins \}/);
  assert.match(source, /Echo recompiled during host-only build/);
  assert.match(source, /Host image changed during native exchange/);
  assert.match(source, /Deployment changed during native exchange/);
  assert.match(source, /copyFileSync\(originalEcho\.path, frozen, fs\.constants\.COPYFILE_EXCL\)/);
});

test('39105426143 inventory uses flatpak-list active, not remote-list commit', () => {
  // Flatpak 1.18.4: list --columns=ref,commit,origin exits 1, Unknown column: commit.
  // https://docs.flatpak.org/en/latest/flatpak-command-reference.html#flatpak-list
  assert.match(source, /\['list', '--system', '--runtime', '--columns=ref,active,origin'\]/);
  assert.doesNotMatch(source, /--columns=ref,commit,origin/);
  assert.match(source, /commit\(info\(true, '--show-commit', RUNTIME\)\)/);
});

test('no product build, host reader, settings operations, deletion, override or publishing path exists', () => {
  assert.doesNotMatch(source, /flatpak-spawn|flatpak-host-reader|--filesystem|--talk-name|--socket=x11|--share=network|--device=all/);
  assert.doesNotMatch(source, /rmSync|unlinkSync|rmdirSync|killall|pkill|\.kill\(|shell: true|--all-targets|--bins|npm run|tauri build|publish-hub/);
  assert.match(source, /mkdirSync\(work, \{ mode: 0o700 \}\)/);
  assert.doesNotMatch(source, /recursive: true/);
  assert.match(source, /save\('settings-before.json'/);
  assert.match(source, /save\('settings-after.json'/);
  assert.match(source, /unsignedFixture: true/);
  assert.match(source, /signedUpdateAccepted: false/);
  assert.match(source, /process\.argv\.slice\(2\), \['run'\]/);
  assert.match(source, /native\.error \|\| native\.signal \? null : native\.status/);
});

test('dispatch bootstrap and native-dependency changes trigger only the exact validation branch; manual remains', () => {
  // Parent observed dispatch HTTP404 at 984640a before default-branch registration.
  // A change to this workflow itself must be an eligible bootstrap push.
  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
  assert.equal(workflow.on.workflow_dispatch, null);
  assert.deepEqual(workflow.on.push, {
    branches: [harness.BRANCH.slice('refs/heads/'.length)],
    paths: ['.github/workflows/flatpak-installed-host-launch-014.yml',
      'scripts/native-flatpak-installed-transport.cjs', 'scripts/native-flatpak-installed-transport.test.cjs',
      'scripts/flatpak-host-launch.test.cjs', 'native/flatpak-host-launch/**'],
  });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['installed-transport']);
  const job = workflow.jobs['installed-transport'];
  assert.equal(job['runs-on'], 'ubuntu-22.04'); assert.equal(job['timeout-minutes'], 25);
  assert.equal(job.if.trim(), "github.repository == 'BOBWORKS-XR/CREATOR-HUB' && "
    + "github.repository_id == '1364807512' && "
    + `github.ref == '${harness.BRANCH}' && `
    + "(github.event_name == 'push' || github.event_name == 'workflow_dispatch')");
  assert.equal(job.steps[0].with['persist-credentials'], false);
  assert.doesNotMatch(workflowText, /secrets\.|contents: write|gh release|workflow_call|windows-|macos-|publish-hub|sysctl|apparmor|--no-sandbox|sudo node/);
});

test('workflow provisions independently verified 1.18.4 plus fixed source subprojects, not a mutable PPA', () => {
  assert.match(workflowText, /flatpak\/flatpak\/releases\/download\/1\.18\.4\/flatpak-1\.18\.4\.tar\.xz/);
  assert.match(workflowText, /1363232/);
  assert.match(workflowText, /b899a7a00c48d2c626cb8ec33fe556720b376c25805d7222430c0fdca4c6ac8d/);
  assert.match(workflowText, /sha256sum --check --strict/);
  for (const id of ['2a76602a8c71f36c1527cf9fc3417d9149822e0c', '72b40c8f6d9d585cfbdb249690724f740d207087']) assert.ok(workflowText.includes(id));
  assert.match(workflowText, /--prefix=\/usr --sysconfdir=\/etc/);
  assert.match(workflowText, /--localstatedir=\/var/);
  assert.match(workflowText, /sudo \/usr\/bin\/flatpak install --system --noninteractive --assumeyes --no-related flathub org\.gnome\.Platform\/x86_64\/50/);
  assert.doesNotMatch(workflowText, /ppa:|--no-gpg-verify|--disable-seccomp|seccomp=disabled/);
  assert.ok(workflowText.indexOf('node --test') < workflowText.indexOf('sudo apt-get'));
  assert.ok(workflowText.indexOf('cargo fetch --locked') < workflowText.indexOf('native-flatpak-installed-transport.cjs run'));
  assert.match(workflowText, /timeout --signal=TERM --kill-after=5s 10m node/);
});

test('workflow YAML and every run body pass local Bash syntax without executing commands', () => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/usr/bin/bash';
  assert.ok(fs.existsSync(bash), 'Bash parser required for preflight');
  let count = 0;
  for (const step of workflow.jobs['installed-transport'].steps) {
    if (!step.run) continue;
    const result = spawnSync(bash, ['-n'], { input: step.run, encoding: 'utf8', timeout: 10000,
      maxBuffer: 8192, shell: false, env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT } });
    assert.equal(result.error, undefined, step.name); assert.equal(result.status, 0, `${step.name}: ${result.stderr}`); count++;
  }
  assert.equal(count, 5);
});

test('only the three new fixture files are ASCII with no trailing whitespace', () => {
  for (const target of [file, __filename, workflowFile]) {
    const text = fs.readFileSync(target, 'utf8');
    assert.doesNotMatch(text, /[^\x00-\x7f]/, target);
    assert.doesNotMatch(text, /[ \t]+\r?$/m, target);
    assert.ok(text.endsWith('\n'), target);
  }
});
