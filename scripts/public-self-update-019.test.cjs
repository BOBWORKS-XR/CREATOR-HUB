'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const pub = require('./public-self-update-019.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const env = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
  RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'self-update', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: '150c7c1349d55eab031bb08d6b80abb421b1b68a', CREATOR_PUBLIC_SELF_UPDATE_019: '1',
  CREATOR_SELF_UPDATE_TARGET_VERSION: '0.1.19',
  GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/self-update-acceptance.yml@refs/heads/validation/windows-public-019' });
const release = () => ({ id: pub.binding.releaseId, tag_name: 'v0.1.19', draft: false, prerelease: false,
  assets: Object.entries(pub.binding.assets).map(([name, value]) => ({ name, id: value.id, size: value.size,
    browser_download_url: 'https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.19/' + name,
    digest: 'sha256:' + value.sha256 })) });
const feed = (item = release(), others = []) => Buffer.from(JSON.stringify([item, ...others,
  { tag_name: 'v0.1.18', draft: false, prerelease: false }]));

test('public19 admission requires the exact disposable job and rejects lab, fixture, proxy and TLS overrides', () => {
  pub.admit(env());
  for (const name of ['HTTPS_PROXY', 'http_proxy', 'ALL_PROXY', 'NO_PROXY', 'NODE_OPTIONS', 'NODE_USE_ENV_PROXY',
    'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE',
    'REQUESTS_CA_BUNDLE', 'CREATOR_HOSTED_UPDATE_FIXTURE', 'CREATOR_SELF_UPDATE_LAB_CONFIG',
    'CREATOR_PUBLIC12_R2_LAB', 'CREATOR_INCOMING_MIGRATION_DIAGNOSTIC']) {
    assert.throws(() => pub.admit({ ...env(), [name]: 'injected' }), name);
    pub.admit({ ...env(), [name]: '' });
  }
  for (const [name, value] of [['GITHUB_ACTIONS', 'false'], ['RUNNER_OS', 'Linux'], ['RUNNER_ARCH', 'ARM64'],
    ['RUNNER_ENVIRONMENT', 'self-hosted'], ['GITHUB_REPOSITORY', 'other/CREATOR-HUB'], ['GITHUB_REPOSITORY_ID', '1'],
    ['GITHUB_EVENT_NAME', 'push'], ['GITHUB_RUN_ATTEMPT', '2'], ['CREATOR_PUBLIC_SELF_UPDATE_019', '0'],
    ['CREATOR_SELF_UPDATE_TARGET_VERSION', '0.1.18'], ['GITHUB_JOB', 'other'], ['GITHUB_SHA', 'invalid'],
    ['GITHUB_WORKFLOW_REF', 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/other.yml@refs/heads/main']]) {
    assert.throws(() => pub.admit({ ...env(), [name]: value }), name);
  }
});

test('public feed pins stable18, canonical19 and every public asset ID, size, digest and URL', () => {
  assert.equal(pub.checkRelease(feed()).previousStable, '0.1.18');
  for (const mutate of [r => r.draft = true, r => r.prerelease = true, r => r.id++, r => r.tag_name = 'v0.1.18',
    r => r.assets[0].id++, r => r.assets[0].size++, r => r.assets[0].digest = 'sha256:' + '0'.repeat(64),
    r => delete r.assets[0].digest, r => r.assets[0].browser_download_url = 'https://localhost/test',
    r => r.assets.push(r.assets[0]), r => r.assets.pop(),
    r => r.assets.push({ ...r.assets[0], name: 'extra.txt' }), r => r.assets[0].name = r.assets[1].name]) {
    const item = release(); mutate(item); assert.throws(() => pub.checkRelease(feed(item)));
  }
  assert.throws(() => pub.checkRelease(feed(release(), [release()])));
  assert.throws(() => pub.checkRelease(Buffer.from(JSON.stringify([release(),
    { tag_name: 'v0.1.14', draft: false, prerelease: false }]))));
});

test('input binding matches the 019 reviewer schema and immutable source, baseline and resource pins', () => {
  const bytes = feed(), input = pub.inputFor(bytes, env());
  assert.equal(input.schemaVersion, 1); assert.equal(input.kind, 'public-018-to-019');
  assert.equal(input.harnessSource, env().GITHUB_SHA);
  assert.equal(input.authenticatedDownload, false); assert.equal(input.lab, false); assert.equal(input.fixture, false);
  assert.deepEqual(input.baseline, require('./self-update-baselines.cjs').selectBaseline('0.1.19'));
  assert.equal(input.baseline.version, '0.1.18'); assert.deepEqual(input.resources, pub.binding.resources);
  assert.deepEqual(input.assets, pub.binding.assets); assert.deepEqual(input.executable, pub.binding.executable);
  assert.deepEqual(input.source, pub.binding.source); assert.equal(input.source.commit, 'ed3e7dabc2e83fea8b7cadce63bbeb502fed2306');
  assert.equal(input.releaseId, pub.binding.releaseId); assert.deepEqual(input.sdkInputs, pub.binding.sdkInputs);
  assert.deepEqual(Object.keys(input.sdkInputs).sort(), ['packageJsonSha256', 'packageLockSha256']);
  assert.equal(input.publicFeedSha256, hash(bytes)); assert.deepEqual(input.feed, pub.checkRelease(bytes));
  assert.equal(input.publicFeedUrl, 'https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases?per_page=10');
  assert.equal(input.bindingSha256, hash(fs.readFileSync(path.join(__dirname, 'fixtures/windows-public-019-binding.json'))));
});

test('public download is canonical, unauthenticated and bounded, and rejects errors or empty bytes', async () => {
  const expected = 'https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.19/latest.json';
  const got = await pub.publicBytes(expected, 4, async (url, options) => {
    assert.equal(url, expected); assert.deepEqual(Object.keys(options.headers), ['User-Agent']);
    assert.equal(options.headers['User-Agent'], 'Creator-Hub-public-acceptance/0.1.19');
    assert.equal(options.credentials, undefined);
    return { ok: true, body: [Buffer.from('da'), Buffer.from('ta')] };
  });
  assert.equal(got.toString(), 'data');
  for (const response of [{ ok: false, status: 404 }, { ok: true, body: [] }, { ok: true, body: [Buffer.alloc(5)] }]) {
    await assert.rejects(pub.publicBytes(expected, 4, async () => response));
  }
  for (const url of ['https://localhost/latest.json', expected.replace('v0.1.19', 'v0.1.18'),
    'https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases/assets/1']) {
    await assert.rejects(pub.publicBytes(url, 4, async () => assert.fail('Non-public URL reached fetch')));
  }
});

test('prepare refuses non-admitted environments before any public request', async () => {
  await assert.rejects(pub.prepare({}, async () => assert.fail('Unadmitted fetch')));
});

test('exact root and all original15 resource reads retain every immutable pin', () => {
  const reads = [];
  const result = pub.verifyResources(path.resolve('synthetic'), (file, sha256, name) => {
    reads.push({ file, sha256, name }); return { name, size: 1, sha256 };
  });
  assert.equal(reads.length, 16); assert.equal(result.length, 15);
  assert.equal(reads[0].sha256, pub.binding.executable.sha256);
  assert.equal(reads[0].file, path.resolve('synthetic/creator-hub.exe'));
  assert.deepEqual(Object.fromEntries(result.map(row => [row.name.slice(8), row.sha256])), pub.binding.resources);
  for (const row of reads.slice(1)) assert.equal(row.file, path.resolve('synthetic', row.name));
  require('./windows-019-public-acceptance.cjs').resources(result, pub.binding.resources);
  assert.throws(() => pub.verifyResources('relative'));
});

test('bounded resource verifier refuses missing, empty, corrupt, directory and linked files with named diagnostics', t => {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'public19-test-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'data'); fs.writeFileSync(file, 'good');
  assert.equal(pub.readHash(file, hash(Buffer.from('good')), 'modules/test').size, 4);
  for (const bytes of ['', 'corrupt']) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => pub.readHash(file, hash(Buffer.from('good')), 'modules/test'), error => {
      assert.equal(error.resourceDiagnostic.name, 'modules/test'); assert.equal(error.resourceDiagnostic.size, Buffer.byteLength(bytes));
      assert.equal(error.resourceDiagnostic.expected, hash(Buffer.from('good'))); return true;
    });
  }
  assert.throws(() => pub.readHash(path.join(root, 'missing'), '0'.repeat(64), 'modules/missing'), error => {
    assert.deepEqual(error.resourceDiagnostic, { name: 'modules/missing', size: null, sha256: null, expected: '0'.repeat(64) }); return true;
  });
  assert.throws(() => pub.readHash(root, '0'.repeat(64), 'modules/directory'));
  const link = path.join(root, 'link'); fs.symlinkSync(root, link, 'junction');
  fs.writeFileSync(file, 'good');
  assert.throws(() => pub.readHash(path.join(link, 'data'), hash(Buffer.from('good')), 'modules/link'));
});

test('SDK loader verifies both pinned source files before resolving exactly SDK1.32.0', () => {
  const helper = path.join(__dirname, 'public-self-update-019.cjs');
  const localRequire = createRequire(helper), root = path.resolve('.public-sdk/modules/mcp');
  const packageFile = path.join(root, 'node_modules/@modelcontextprotocol/sdk/package.json');
  const sourceFiles = new Map([
    [path.join(root, 'package.json'), Buffer.from('source package')],
    [path.join(root, 'package-lock.json'), Buffer.from('source lock')],
    [packageFile, Buffer.from(JSON.stringify({ version: '1.32.0' }))],
  ]);
  const sdkBinding = { ...pub.binding, sdkInputs: {
    packageJsonSha256: hash(sourceFiles.get(path.join(root, 'package.json'))),
    packageLockSha256: hash(sourceFiles.get(path.join(root, 'package-lock.json'))),
  } };
  const reads = [], fakeSdk = () => {};
  fakeSdk.resolve = name => {
    assert.equal(name, '@modelcontextprotocol/sdk/client/index.js');
    return path.join(root, 'node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js');
  };
  const loaded = { exports: {} };
  const mockRequire = name => {
    if (name === 'node:fs') return { ...fs, readFileSync: file => {
      assert.equal(file, path.join(__dirname, 'fixtures/windows-public-019-binding.json'));
      return Buffer.from(JSON.stringify(sdkBinding));
    } };
    if (name === 'node:module') return { createRequire: file => { assert.equal(file, path.join(root, 'package.json')); return fakeSdk; } };
    if (name === './read-bounded-input.cjs') return { readBounded: (file, max) => {
      reads.push(file); const bytes = sourceFiles.get(file); assert.ok(bytes && bytes.length <= max, file); return bytes;
    } };
    return localRequire(name);
  };
  vm.runInNewContext(fs.readFileSync(helper, 'utf8'), { require: mockRequire, module: loaded, __dirname,
    Buffer, process, fetch, AbortSignal }, { filename: helper });
  assert.equal(loaded.exports.verifySdk(), fakeSdk);
  assert.deepEqual(reads, [...sourceFiles.keys()]);
  for (const name of ['package.json', 'package-lock.json']) {
    const file = path.join(root, name), original = sourceFiles.get(file);
    sourceFiles.set(file, Buffer.from('changed')); reads.length = 0;
    assert.throws(() => loaded.exports.verifySdk(), new RegExp(name.replace('.', '\\.')));
    assert.equal(reads.includes(packageFile), false); sourceFiles.set(file, original);
  }
  sourceFiles.set(packageFile, Buffer.from(JSON.stringify({ version: '1.31.0' })));
  assert.throws(() => loaded.exports.verifySdk(), /1\.32\.0/);
});

test('Root identity requires kernel proof, singleton and exact hash; restart must follow approval', () => {
  const hub = 'C:\\test\\creator-hub.exe';
  const before = { pid: 1, parentPid: 9, image: hub, startTicks: '100', kernelIdentityVerified: true };
  const after = { ...before, pid: 2, startTicks: '300' };
  const args = { rows: [after], pid: 2, hub, expectedHash: 'expected', imageHash: () => 'expected' };
  assert.deepEqual(pub.observeRoot(args), after); pub.checkRestart(before, after, '200');
  for (const bad of [{ ...args, imageHash: () => 'wrong' }, { ...args, rows: [] }, { ...args, rows: [after, before] },
    { ...args, rows: [{ ...after, image: 'C:\\other\\creator-hub.exe' }] },
    { ...args, rows: [{ ...after, kernelIdentityVerified: false }] }, { ...args, pid: 5 },
    { ...args, rows: [{ ...after, startTicks: '0' }] }, { ...args, rows: [{ ...after, startTicks: 'invalid' }] },
    { ...args, rows: [{ ...after, pid: -1 }], pid: -1 }]) assert.throws(() => pub.observeRoot(bad));
  for (const bad of [before, { ...after, startTicks: '150' }, { ...after, startTicks: '200' },
    { ...after, image: 'C:\\other\\creator-hub.exe' }]) assert.throws(() => pub.checkRestart(before, bad, '200'));
  assert.throws(() => pub.checkRestart({ ...before, startTicks: '200' }, after, '200'));
  assert.match(pub.ticks(), /^[1-9][0-9]{0,18}$/);
});

test('parent smoke probes original15 only after automatic new Root, with no replacement launch and mandatory cleanup', () => {
  const text = fs.readFileSync(path.join(__dirname, 'native-public-update-019.cjs'), 'utf8');
  const restart = text.indexOf('public19.checkRestart('), resources = text.indexOf('report.installedResources = public19.verifyResources(');
  assert.ok(restart >= 0 && resources > restart);
  assert.equal((text.match(/report.installedResources = public19.verifyResources/g) || []).length, 1);
  assert.equal((text.match(/spawn\(hub,/g) || []).length, 1);
  for (const expected of ['version: to.version', 'direct.checkProtocol(page, to.version)',
    'report.sdkConnections !== 2', 'report.rootCleanupVerified !== true', 'report.runtimeCleanupVerified !== true',
    'report.resourceProbe.passed = true']) assert.ok(text.includes(expected), expected);
  assert.ok(text.indexOf('public19.admit()') < text.indexOf('const installer = fixture'));
});
