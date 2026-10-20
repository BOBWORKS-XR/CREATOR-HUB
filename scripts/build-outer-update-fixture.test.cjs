const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { test } = require('node:test');
const { BASELINE, VERSIONS, BUILD_LOG_TAIL, bumpRootVersion, sourceEntries, compileEnvironment,
  fixtureCache, compileOuterHub, buildFixture } = require('./build-outer-update-fixture.cjs');

function temporaryRoot(t) {
  const parent = fs.realpathSync(os.tmpdir()), prefix = 'outer-fixture-test-';
  const root = fs.mkdtempSync(path.join(parent, prefix));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith(prefix));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('fixture admits only the native Windows x64 explicit acceptance context before filesystem access', () => {
  const rejectInspection = new Proxy({}, { get() { throw Error('Must not inspect baseline'); } });
  const base = { platform: 'win32', arch: 'x64', env: { CREATOR_OUTER_UPDATE_FIXTURE: '1' }, baseline: rejectInspection };
  for (const override of [{ platform: 'linux' }, { platform: 'darwin' }, { arch: 'arm64' }, { env: {} }]) {
    assert.throws(() => buildFixture('case', { ...base, ...override }), error => !error.message.includes('Must not inspect'));
  }
  assert.throws(() => buildFixture('../foreign', base), error => !error.message.includes('Must not inspect'));
});

test('JSON version-only fixture preserves all other values and refuses missing/duplicate fields', () => {
  const source = Buffer.from('{"version":"0.1.14","future":{"version":"keep"},"number":14}');
  assert.deepEqual(JSON.parse(bumpRootVersion('package.json', source)), { version: '0.1.15', future: { version: 'keep' }, number: 14 });
  for (const body of ['{}', '{"version":"0.1.13"}', '{"version":"0.1.14","version":"0.1.14"}']) {
    assert.throws(() => bumpRootVersion('package.json', Buffer.from(body)));
  }
});

test('Rust version fixture changes exactly the root package, with LF or CRLF and no module/dependency bumps', () => {
  for (const newline of ['\n', '\r\n']) {
    const root = `[package]${newline}name = "creator-hub"${newline}version = "0.1.14"${newline}`;
    const dependency = `[[package]]${newline}name = "other"${newline}version = "0.1.14"${newline}`;
    assert.equal(bumpRootVersion('src-tauri/Cargo.toml', Buffer.from(root)).toString(), root.replace('0.1.14', '0.1.15'));
    const lock = root.replace('[package]', '[[package]]') + dependency;
    assert.equal(bumpRootVersion('src-tauri/Cargo.lock', Buffer.from(lock)).toString(), lock.replace('0.1.14', '0.1.15'));
  }
  assert.throws(() => bumpRootVersion('native/other/Cargo.toml', Buffer.from('version = "0.1.14"')));
});

test('source export rejects links, submodules, duplicate paths and traversal before extraction', () => {
  const sha = 'a'.repeat(40);
  const valid = VERSIONS.map(name => `100644 blob ${sha}\t${name}\0`).join('');
  assert.equal(Object.keys(sourceEntries(valid)).length, 4);
  assert.equal(Object.keys(sourceEntries(valid + `100644 blob ${sha}\tsrc-tauri/icons/128x128@2x.png\0`)).length, 5);
  for (const bad of [`120000 blob ${sha}\tlink\0`, `160000 commit ${sha}\tmodule\0`,
    `100644 blob ${sha}\t../outside\0`, `100644 blob ${sha}\t/absolute\0`, `100644 blob ${sha}\tpackage.json\0`]) {
    assert.throws(() => sourceEntries(valid + bad));
  }
});

test('compile child strips signing material and injection flags without changing caller environment', () => {
  const env = { PATH: 'keep', CREATOR_HUB_SIGNING_KEY_PATH: 'private', GH_TOKEN: 'private', NODE_OPTIONS: 'inject',
    RUSTFLAGS: 'inject', CARGO_ENCODED_RUSTFLAGS: 'inject', TAURI_SIGNING_PRIVATE_KEY: 'private', CARGO_TARGET_DIR: 'foreign' };
  const before = structuredClone(env);
  assert.deepEqual(compileEnvironment(env, 'reviewed-manifest', 'owned-target'), { PATH: 'keep',
    CREATOR_BUILTIN_MANIFEST: 'reviewed-manifest', CARGO_TARGET_DIR: 'owned-target',
    CREATOR_MCP_HOST_WRITABLE: '1', CREATOR_MCP_HOST_READONLY_EVENTS: '1' });
  assert.deepEqual(env, before);
});

test('fixed canonical cache preserves older bundles and refuses absent or redirected directories', t => {
  const root = temporaryRoot(t), target = path.join(root, 'src-tauri/target');
  assert.throws(() => fixtureCache(root));
  const bundle = path.join(target, 'release/bundle/nsis'); fs.mkdirSync(bundle, { recursive: true });
  const older = path.join(bundle, 'Creator Hub_0.1.14_x64-setup.exe'); fs.writeFileSync(older, 'preserved-14');
  assert.equal(fixtureCache(root), target);
  assert.equal(fs.readFileSync(older, 'utf8'), 'preserved-14');
  const linkedRoot = temporaryRoot(t), other = path.join(linkedRoot, 'actual-cache');
  fs.mkdirSync(path.join(linkedRoot, 'src-tauri')); fs.mkdirSync(other);
  fs.symlinkSync(other, path.join(linkedRoot, 'src-tauri/target'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => fixtureCache(linkedRoot), /Redirected fixture/);
  const linkedBundleRoot = temporaryRoot(t), linkedBundle = path.join(linkedBundleRoot, 'src-tauri/target/release/bundle');
  fs.mkdirSync(linkedBundle, { recursive: true });
  const otherBundle = path.join(linkedBundleRoot, 'actual-nsis'); fs.mkdirSync(otherBundle);
  fs.symlinkSync(otherBundle, path.join(linkedBundle, 'nsis'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => fixtureCache(linkedBundleRoot), /Redirected fixture/);
});

test('stale 15 refuses before baseline reads, subprocesses, output creation or signer access', t => {
  for (const name of ['Creator Hub_0.1.15_x64-setup.exe', 'Creator Hub_0.1.15_X64-SETUP.EXE']) {
    const root = temporaryRoot(t), bundle = path.join(root, 'src-tauri/target/release/bundle/nsis');
    fs.mkdirSync(bundle, { recursive: true }); fs.writeFileSync(path.join(bundle, name), 'preserved-15');
    const forbidden = () => assert.fail('Stale output must refuse before this operation');
    const baseline = { directory: 'baseline', get hashes() { forbidden(); } };
    assert.throws(() => buildFixture('case', { root, platform: 'win32', arch: 'x64',
      env: { CREATOR_OUTER_UPDATE_FIXTURE: '1' }, baseline, execute: forbidden,
      signer: { signingKey: forbidden, signDetached: forbidden } }), /Existing outer-only 15 NSIS output refused/);
    assert.equal(fs.existsSync(path.join(root, 'artifacts')), false);
    assert.equal(fs.readFileSync(path.join(bundle, name), 'utf8'), 'preserved-15');
  }
});

test('build call keeps exported source, exact manifest and fixed cache; success writes no diagnostics', t => {
  const root = temporaryRoot(t), target = path.join(root, 'src-tauri/target'); fs.mkdirSync(target, { recursive: true });
  const source = path.join(root, 'exported-15'), descriptor = path.join(root, 'payload/builtin-manifest.json');
  const overlay = path.join(root, 'tauri-outer-fixture.json'), env = compileEnvironment({
    CARGO_TARGET_DIR: 'foreign', CREATOR_HUB_SIGNING_KEY_PATH: 'SIGNER_SENTINEL', NODE_OPTIONS: 'inject' }, descriptor, fixtureCache(root));
  compileOuterHub(root, source, overlay, env, root, (command, args, options) => {
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--bundles', 'nsis', '--config', overlay, '--', '--locked']);
    assert.equal(options.cwd, source); assert.equal(options.env.CREATOR_BUILTIN_MANIFEST, descriptor);
    assert.equal(options.env.CARGO_TARGET_DIR, target);
    assert.equal(options.env.CREATOR_HUB_SIGNING_KEY_PATH, undefined); assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.maxBuffer, 4 * 1024 * 1024); assert.equal(options.timeout, 1800000);
    return 'build-success';
  });
  assert.equal(fs.existsSync(path.join(root, 'outer-hub-build-failure.json')), false);
});

test('build-only failure tails are bounded with truncation; no message, stack, environment or signer metadata', t => {
  const root = temporaryRoot(t), sentinel = 'SIGNER_KEY_ENV_SENTINEL';
  const failure = Object.assign(Error(sentinel), { stack: sentinel, env: { KEY: sentinel }, signerOutput: sentinel,
    status: 101, signal: 'SIGTERM', code: 'ENOBUFS', stdout: Buffer.alloc(BUILD_LOG_TAIL + 17, 'o'),
    stderr: 'discarded-prefix' + '\u0000'.repeat(BUILD_LOG_TAIL) });
  const invoke = () => compileOuterHub(root, 'exported-15', 'overlay', { PRIVATE_KEY: sentinel }, root, () => { throw failure; });
  assert.throws(invoke, /bounded build-only diagnostics retained/);
  const file = path.join(root, 'outer-hub-build-failure.json'), body = fs.readFileSync(file, 'utf8'), report = JSON.parse(body);
  assert.equal(report.status, 101); assert.equal(report.signal, 'SIGTERM'); assert.equal(report.captureLimitExceeded, true);
  assert.deepEqual(report.stdout, { capturedBytes: BUILD_LOG_TAIL + 17, tailTruncated: true, tail: 'o'.repeat(BUILD_LOG_TAIL) });
  assert.deepEqual(report.stderr, { capturedBytes: BUILD_LOG_TAIL + 16, tailTruncated: true, tail: '\u0000'.repeat(BUILD_LOG_TAIL) });
  assert.ok(Buffer.byteLength(body) < 1024 * 1024); assert.ok(!body.includes(sentinel));
  assert.deepEqual(Object.keys(report).sort(), ['schemaVersion', 'phase', 'status', 'signal', 'captureLimitExceeded', 'stdout', 'stderr'].sort());
  assert.throws(invoke, error => error.code === 'EEXIST'); assert.equal(fs.readFileSync(file, 'utf8'), body);
});

test('missing or malformed build error fields do not serialize arbitrary objects or control data', t => {
  for (const failure of [null, { status: 'PRIVATE_SENTINEL', signal: 'PRIVATE_SENTINEL', stdout: {}, stderr: [], code: 'PRIVATE_SENTINEL' },
    { status: 1, signal: null, stdout: 'short stdout', stderr: Buffer.from('short stderr') }]) {
    const root = temporaryRoot(t);
    assert.throws(() => compileOuterHub(root, 'source', 'overlay', {}, root, () => { throw failure; }), /build-only diagnostics/);
    const body = fs.readFileSync(path.join(root, 'outer-hub-build-failure.json'), 'utf8'), report = JSON.parse(body);
    assert.ok(!body.includes('PRIVATE_SENTINEL')); assert.equal(report.signal, null); assert.equal(report.captureLimitExceeded, false);
    assert.equal(report.stdout.tailTruncated, false); assert.equal(report.stderr.tailTruncated, false);
    assert.equal(report.stdout.tail, failure?.status === 1 ? 'short stdout' : '');
    assert.equal(report.stderr.tail, failure?.status === 1 ? 'short stderr' : '');
  }
});

test('later signer-error streams never enter the build-only diagnostic boundary', t => {
  const root = temporaryRoot(t), sentinel = 'SIGNER_ERROR_OUTPUT_SENTINEL';
  const signerFailure = Object.assign(Error(sentinel), { stdout: Buffer.from(sentinel), stderr: sentinel });
  let buildCalls = 0;
  assert.throws(() => {
    compileOuterHub(root, 'source', 'overlay', {}, root, () => { buildCalls++; return ''; });
    const sign = () => { throw signerFailure; }; sign();
  }, error => error === signerFailure);
  assert.equal(buildCalls, 1);
  assert.equal(fs.existsSync(path.join(root, 'outer-hub-build-failure.json')), false);
});

test('fixture pins exact reviewed B05 input, checks signed payloads and retains explicit unaccepted scope', () => {
  assert.equal(BASELINE.directory, 'artifacts/unified/windows-014-release-b05-20261015');
  assert.equal(BASELINE.commit, 'db862739d01088ba9be335d0522f8f129222a48b');
  assert.equal(BASELINE.tree, '2c2e16053bdd2c9b6fa9301992324c44465757f8');
  assert.deepEqual(BASELINE.hashes, {
    'builtin-manifest.json': '6be984c3358ce956154ecf6aa38532320e0be2765d54285a12183319121bb4cb',
    'creator-hub.exe': 'cb09ca8249869315fc250bce2bb00933b93f7516054dbef3f85da94b37096e3f',
    'installer.exe': '284820f92de487e8a0f1bb5b3b99cafe5e073f0402a9350a2ea6e76fa9543157',
    'installer-extracted/creator-hub.exe': 'cd5e3fd2829727d06444c0f3266b178798d1b55c63df651be12eb38ac4523a86',
    'installer-checksum.json': '9ee05a11973b86facc2e789f60d24325d6525a77bc8504778329bd35abbf6906',
    'mcp-runtime.json': '1b78bb735b41df55ea90ff59e72b41c410ff04115edcd88fcdc9d63878503e04',
    'modules/routing/router.json.sig': 'bfeb49d84c8e200ca5625726d6c0649754cde414278fd44d2fb4b931a40f5fd5',
    'modules/routing/runtime.json.sig': 'cf0229af40d8bedbb4d0ce6736b4cd8b0e2403525379ee166c178e5723a5628f',
  });
  const source = fs.readFileSync(path.join(__dirname, 'build-outer-update-fixture.cjs'), 'utf8');
  assert.ok(source.includes("['verify-package-input', 'verify-managed-runtime', 'verify-release']"));
  assert.ok(source.includes('privateModulesRecompiled: false, privateModulesResigned: false, privateKeyIncluded: false'));
  assert.ok(source.includes('outgoingNativeUpdateTested: false, viewsRestored: false, releaseReady: false'));
  assert.ok(source.includes('capture(path.join(root, name), VERSION_SOURCE_LIMIT)'));
  assert.ok(source.includes('bumpRootVersion(name, bytes(file, VERSION_SOURCE_LIMIT))'));
  assert.ok(source.includes("const producerSidecars = ['routing/router.json.sig', 'routing/runtime.json.sig']"));
  assert.ok(source.includes("'Producer signature differs from verified package signature'"));
  assert.ok(source.includes("['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive'"));
  assert.ok(source.includes('copy(cargoHub, rawHub, capture(cargoHub, MAX, true), true)'));
  assert.ok(source.includes('compileEnvironment(env, descriptor, cache)'));
  assert.match(source, /assert.equal\(fixtureCache\(root\), cache\);\r?\n    const key = approved.signingKey\(root\);/);
  assert.ok(source.includes('compileOuterHub(root, source, overlay, buildEnv, output, execute)'));
  assert.ok(source.includes("assert.equal(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', versionScript]), TO"));
  assert.ok(source.includes('checkSource(source, entries, changes); unchanged(descriptor, descriptorRecord)'));
  assert.ok(source.includes('for (const [name, record] of Object.entries(privateFiles)) unchanged(path.join(payload, \'modules\', name), record)'));
  const signer = source.slice(source.indexOf('function sign(file)'), source.indexOf('finalManifest.managedRouting ='));
  const outerCatch = source.slice(source.lastIndexOf('  } catch {'), source.indexOf('module.exports'));
  assert.doesNotMatch(signer + outerCatch, /stdout|stderr|writeFileSync|JSON\.stringify|outer-hub-build-failure/);
  assert.doesNotMatch(source, /readFileSync\(key|readFileSync\([^)]*auth\.json|release (?:create|edit|upload)/);
});
