// Must run on an explicitly disposable native runner, never the user's profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const pkg = require('./flatpak-package.cjs');
const archive = require('./module-archive.cjs');
const FLATPAK = '/usr/bin/flatpak';
const BUILDER = '/usr/bin/flatpak-builder';
const REMOTE = 'creator-flatpak-fixture';
const RUNTIME = 'runtime/org.gnome.Platform/x86_64/50';
const SDK = 'runtime/org.gnome.Sdk/x86_64/50';
const ABI_SCRIPT = "test -r '/app/lib/Creator Hub/modules.tar.gz' && /usr/bin/ldd /app/bin/creator-hub 2>&1";
const RETENTION_SCRIPT = 'sha256sum "$XDG_CONFIG_HOME/retention-fixture.json"';

function admission(env = process.env, platform = process.platform, arch = process.arch) {
  assert.equal(platform, 'linux', 'Disposable native Linux runner required'); assert.equal(arch, 'x64');
  assert.equal(env.GITHUB_ACTIONS, 'true'); assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(env.RUNNER_OS, 'Linux'); assert.equal(env.RUNNER_ARCH, 'X64');
  assert.equal(env.GITHUB_REPOSITORY, 'BOBWORKS-XR/CREATOR-HUB'); assert.equal(env.GITHUB_REPOSITORY_ID, '1364807512');
  assert.equal(env.CREATOR_FLATPAK_PACKAGE_TEST, '1', 'Explicit packaging experiment opt-in required');
  assert.equal(env.FLATPAK_ID, undefined, 'Native host runner required');
  assert.ok(path.isAbsolute(env.RUNNER_TEMP || ''), 'Owned runner temp required');
  assert.ok(!Object.keys(env).some(name => /^(LD_PRELOAD|LD_LIBRARY_PATH|NODE_OPTIONS|BASH_ENV|ENV)$/.test(name)), 'Runtime injection refused');
}

function childEnvironment(work) {
  return { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: path.join(work, 'home'),
    XDG_CONFIG_HOME: path.join(work, 'config'), XDG_DATA_HOME: path.join(work, 'data'), XDG_CACHE_HOME: path.join(work, 'cache'),
    XDG_RUNTIME_DIR: path.join(work, 'runtime'), TMPDIR: path.join(work, 'tmp'), GNUPGHOME: path.join(work, 'empty-gnupg'),
    FLATPAK_USER_DIR: path.join(work, 'installation'), FLATPAK_FANCY_OUTPUT: '0', FLATPAK_TTY_PROGRESS: '0' };
}

function inside(file, root) {
  const relative = path.relative(root, file);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Escaped owned installation');
  pkg.ordinary(file);
}

function parseMetadata(text) {
  assert.ok(Buffer.byteLength(text) <= 65536);
  const sections = {}; let section;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    if (/^\[[^\[\]]+\]$/.test(line)) {
      section = line.slice(1, -1); assert.equal(sections[section], undefined, 'Duplicate metadata section');
      sections[section] = {}; continue;
    }
    const separator = line.indexOf('='); assert.ok(section && separator > 0, 'Malformed Flatpak metadata');
    const key = line.slice(0, separator); assert.equal(sections[section][key], undefined, 'Duplicate metadata key');
    sections[section][key] = line.slice(separator + 1);
  }
  assert.ok(Object.keys(sections).every(name => ['Application', 'Context'].includes(name)), 'Unexpected permission or environment section');
  const app = sections.Application; assert.ok(app);
  assert.equal(app.name, pkg.ID); assert.equal(app.command, 'creator-hub');
  assert.equal(app.runtime, RUNTIME.slice('runtime/'.length)); assert.equal(app.sdk, SDK.slice('runtime/'.length));
  const context = sections.Context || {};
  assert.ok(Object.keys(context).every(name => ['shared', 'sockets', 'devices'].includes(name)), 'Unexpected sandbox grant');
  for (const [key, values] of [['shared', ['ipc']], ['sockets', ['wayland', 'fallback-x11']], ['devices', ['dri']]]) {
    assert.deepEqual((context[key] || '').split(';').filter(Boolean).sort(), [...values].sort(), 'Sandbox permission differs');
  }
  return sections;
}

function linkageMatches(text) {
  return /ld-linux-x86-64\.so\.2/.test(text) && !/not found|not a dynamic executable|invalid|error/i.test(text);
}

function verifyFiles(root, expected) {
  for (const [index, name] of pkg.OUTPUTS.entries()) {
    const file = path.join(root, name);
    assert.deepEqual(pkg.record(pkg.read(file, pkg.LIMIT, true)), expected[name], 'Packaged or installed bytes differ');
    const mode = pkg.ordinary(file).mode & 0o7777, wanted = index === 0 ? 0o755 : 0o644;
    assert.ok(mode === wanted || mode === (wanted & ~0o222), 'Unexpected executable/write/special mode');
  }
}

function run(stages, decoder, decoderSha256, env = process.env) {
  admission(env);
  assert.ok([1, 2].includes(stages.length), 'One build or two distinct replacement inputs required');
  assert.match(decoderSha256, /^[a-f0-9]{64}$/);
  // Cargo/OSTree tool outputs may be hard-linked; payload inputs remain single-link only.
  assert.equal(pkg.sha256(pkg.read(decoder, pkg.LIMIT, true)), decoderSha256, 'Reviewed native archive decoder differs');
  for (const tool of [FLATPAK, BUILDER]) assert.ok(pkg.ordinary(tool).isFile(), 'System Flatpak tools required');
  assert.ok(pkg.ordinary(env.RUNNER_TEMP).isDirectory());
  const work = fs.mkdtempSync(path.join(env.RUNNER_TEMP, 'creator-flatpak-'));
  const childEnv = childEnvironment(work);
  for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'GNUPGHOME', 'FLATPAK_USER_DIR']) {
    fs.mkdirSync(childEnv[name], { mode: 0o700 });
  }
  const report = { schemaVersion: 1, scope: 'offline-flatpak-package-lifecycle-only', work, ref: pkg.REF,
    commands: [], builds: [], installationCommandSucceeded: false, packageInstalled: false, packageDeploymentChanged: false,
    packageReplacementVerified: false, appPrivateFixtureRetained: false,
    runtimeLinkProbePassed: false, signedRoutingVerifiedByThisLane: false, suitePassed: false, ...pkg.acceptance() };
  const command = (label, program, args, options = {}) => {
    const start = Date.now();
    const result = spawnSync(program, args, { cwd: work, env: childEnv, encoding: 'utf8', stdio: 'pipe',
      timeout: 600000, maxBuffer: 1024 * 1024, ...options });
    const stdout = result.stdout || '', stderr = result.stderr || '';
    const failed = Boolean(result.error) || result.status !== 0;
    report.commands.push({ label, status: result.status ?? null, signal: result.signal ?? null, code: result.error?.code ?? null,
      elapsedMs: Date.now() - start, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
      stdoutSha256: pkg.sha256(stdout), stderrSha256: pkg.sha256(stderr),
      ...(failed ? { stdoutTail: stdout.slice(-8192), stderrTail: stderr.slice(-8192) } : {}) });
    if (failed) throw Error(`Bounded command failed: ${label}; see command byte/status diagnostics`);
    return stdout.trim();
  };
  try {
    report.flatpakVersion = command('flatpak-version', FLATPAK, ['--version']);
    report.builderVersion = command('builder-version', BUILDER, ['--version']);
    report.runtimeCommit = command('platform-commit', FLATPAK, ['info', '--system', '--show-commit', RUNTIME]);
    report.sdkCommit = command('sdk-commit', FLATPAK, ['info', '--system', '--show-commit', SDK]);
    for (const commit of [report.runtimeCommit, report.sdkCommit]) assert.match(commit, /^[a-f0-9]{64}$/);
    const repo = path.join(work, 'repo'); let previous;
    const fixture = path.join(childEnv.HOME, '.var', 'app', pkg.ID, 'config', 'retention-fixture.json');
    const fixtureBytes = Buffer.from('{"foreign":"preserve","unknown":{"value":17}}\n');
    for (const [index, source] of stages.entries()) {
      const receipt = JSON.parse(pkg.read(path.join(source, 'flatpak-stage.json'), 65536));
      const manifest = pkg.verifyStage(source, receipt);
      if (previous) assert.notEqual(receipt.provenance.files['creator-hub'].sha256, previous.provenance.files['creator-hub'].sha256,
        'Identical Hub bytes cannot prove package replacement');
      assert.equal(pkg.sha256(pkg.read(decoder, pkg.LIMIT, true)), decoderSha256, 'Archive decoder changed before use');
      archive.verify(path.join(source, 'flatpak-input', pkg.OUTPUTS[1]), manifest, decoder,
        (program, args, options) => command(`archive-${index}`, program, args, { input: options.input, timeout: options.timeout, maxBuffer: options.maxBuffer }));
      assert.equal(pkg.sha256(pkg.read(decoder, pkg.LIMIT, true)), decoderSha256, 'Archive decoder changed during use');
      pkg.verifyStage(source, receipt);
      const build = path.join(work, `build-${index}`);
      command(`build-${index}`, BUILDER, ['--arch=x86_64', '--sandbox', '--disable-download',
        `--state-dir=${path.join(work, `state-${index}`)}`, `--repo=${repo}`, build, path.join(source, `${pkg.ID}.json`)]);
      parseMetadata(pkg.read(path.join(build, 'metadata'), 65536, true).toString('utf8'));
      verifyFiles(path.join(build, 'files'), receipt.files);
      pkg.verifyStage(source, receipt);
      const bundle = path.join(work, `creator-hub-${index}.flatpak`);
      command(`bundle-${index}`, FLATPAK, ['build-bundle', '--arch=x86_64', repo, bundle, pkg.ID, 'flatpak-test']);
      if (index === 0) {
        command('local-remote', FLATPAK, ['remote-add', '--user', '--no-gpg-verify', REMOTE, pathToFileURL(repo).href]);
        command('isolated-install', FLATPAK, ['install', '--user', '--noninteractive', '--assumeyes', '--no-deps', '--no-related', REMOTE, pkg.REF]);
        report.installationCommandSucceeded = true;
      } else {
        command('isolated-update', FLATPAK, ['update', '--user', '--noninteractive', '--assumeyes', '--no-deps', '--no-related', pkg.REF]);
      }
      const location = command(`deployment-${index}`, FLATPAK, ['info', '--user', '--show-location', pkg.REF]);
      assert.ok(path.isAbsolute(location)); inside(location, childEnv.FLATPAK_USER_DIR);
      parseMetadata(command(`permissions-${index}`, FLATPAK, ['info', '--user', '--show-metadata', pkg.REF]));
      const commit = command(`app-commit-${index}`, FLATPAK, ['info', '--user', '--show-commit', pkg.REF]);
      assert.match(commit, /^[a-f0-9]{64}$/);
      if (index) assert.notEqual(commit, report.builds[index - 1].commit, 'No replacement deployment');
      verifyFiles(path.join(location, 'files'), receipt.files);
      report.builds.push({ commit, provenance: receipt.provenance, bundle: pkg.record(pkg.read(bundle, pkg.LIMIT * 2)), archiveMembersVerified: true });
      report.packageInstalled = true;
      if (index) report.packageDeploymentChanged = true;
      const linkage = command(`platform-linkage-${index}`, FLATPAK, ['run', '--user', '--sandbox', '--command=sh', pkg.REF, '-c', ABI_SCRIPT], { timeout: 30000, maxBuffer: 65536 });
      report.builds[index].linkage = linkage;
      report.builds[index].runtimeLinkProbePassed = linkageMatches(linkage);
      assert.ok(report.builds[index].runtimeLinkProbePassed, 'Runtime linker prerequisites failed');
      if (index === 0) {
        fs.mkdirSync(path.dirname(fixture), { recursive: true, mode: 0o700 });
        fs.writeFileSync(fixture, fixtureBytes, { flag: 'wx', mode: 0o600 });
      } else {
        assert.deepEqual(pkg.read(fixture, 8192), fixtureBytes, 'App-private fixture changed');
      }
      const sandboxFixture = command(`private-fixture-${index}`, FLATPAK,
        ['run', '--user', '--sandbox', '--command=sh', pkg.REF, '-c', RETENTION_SCRIPT], { timeout: 30000, maxBuffer: 8192 });
      assert.equal(sandboxFixture.split(/\s+/)[0], pkg.sha256(fixtureBytes), 'Sandbox config location or fixture differs');
      if (index) { report.appPrivateFixtureRetained = true; report.packageReplacementVerified = true; }
      previous = receipt;
    }
    report.suitePassed = true;
  } catch (error) { report.error = String(error.message).slice(0, 1500); }
  report.runtimeLinkProbePassed = report.builds.length > 0 && report.builds.every(build => build.runtimeLinkProbePassed === true);
  // Retain the isolated store and all partial artifacts for capture. No uninstall/global cleanup.
  fs.writeFileSync(path.join(work, 'flatpak-report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return report;
}

if (require.main === module) {
  try {
    admission();
    assert.ok([5, 6].includes(process.argv.length), 'Use flatpak-disposable.cjs STAGE DECODER DECODER_SHA256 [SECOND_STAGE]');
    const report = run([path.resolve(process.argv[2]), ...(process.argv[5] ? [path.resolve(process.argv[5])] : [])],
      path.resolve(process.argv[3]), process.argv[4]);
    console.log(JSON.stringify({ work: report.work, suitePassed: report.suitePassed, packageInstalled: report.packageInstalled,
      packageReplacementVerified: report.packageReplacementVerified, error: report.error, ...pkg.acceptance() }));
    if (!report.suitePassed) process.exitCode = 1;
  } catch (error) { console.error(String(error.message).slice(0, 1000)); process.exitCode = 1; }
}
module.exports = { FLATPAK, BUILDER, RUNTIME, SDK, ABI_SCRIPT, RETENTION_SCRIPT, admission, childEnvironment, inside, parseMetadata, linkageMatches, verifyFiles, run };
