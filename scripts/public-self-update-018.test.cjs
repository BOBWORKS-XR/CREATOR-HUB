'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const pub = require('./public-self-update-018.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const env = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
  RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'self-update', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: '150c7c1349d55eab031bb08d6b80abb421b1b68a', CREATOR_PUBLIC_SELF_UPDATE_018: '1',
  CREATOR_SELF_UPDATE_TARGET_VERSION: '0.1.18',
  GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/self-update-acceptance.yml@refs/heads/validation/windows-menu-merge-20261027' });
const release = () => ({ id: pub.binding.releaseId, tag_name: 'v0.1.18', draft: false, prerelease: false,
  assets: Object.entries(pub.binding.assets).map(([name, value]) => ({ name, id: value.id, size: value.size,
    browser_download_url: 'https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.18/' + name,
    digest: 'sha256:' + value.sha256 })) });
const feed = (item = release(), others = []) => Buffer.from(JSON.stringify([item, ...others, { tag_name: 'v0.1.14', draft: false, prerelease: false }]));

test('public18 admission requires exact disposable job and rejects lab, fixture, proxy and TLS overrides', () => {
  pub.admit(env());
  for (const name of ['HTTPS_PROXY', 'http_proxy', 'ALL_PROXY', 'NO_PROXY', 'NODE_OPTIONS', 'NODE_USE_ENV_PROXY',
    'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE',
    'REQUESTS_CA_BUNDLE', 'CREATOR_HOSTED_UPDATE_FIXTURE', 'CREATOR_SELF_UPDATE_LAB_CONFIG',
    'CREATOR_PUBLIC12_R2_LAB', 'CREATOR_INCOMING_MIGRATION_DIAGNOSTIC']) {
    assert.throws(() => pub.admit({ ...env(), [name]: 'injected' }), name);
  }
  for (const [name, value] of [['RUNNER_OS', 'Linux'], ['RUNNER_ENVIRONMENT', 'self-hosted'],
    ['GITHUB_RUN_ATTEMPT', '2'], ['CREATOR_SELF_UPDATE_TARGET_VERSION', '0.1.19'], ['GITHUB_JOB', 'other']]) {
    assert.throws(() => pub.admit({ ...env(), [name]: value }), name);
  }
});

test('public feed pins stable14 baseline and canonical18 ID, every public asset ID/size/hash/URL', () => {
  assert.equal(pub.checkRelease(feed()).previousStable, '0.1.14');
  for (const mutate of [r => r.draft = true, r => r.prerelease = true, r => r.id++,
    r => r.assets[0].id++, r => r.assets[0].size++, r => r.assets[0].digest = 'sha256:' + '0'.repeat(64),
    r => r.assets[0].browser_download_url = 'https://localhost/test',
    r => r.assets.push(r.assets[0])]) {
    const item = release(); mutate(item); assert.throws(() => pub.checkRelease(feed(item)));
  }
  assert.throws(() => pub.checkRelease(feed(release(), [{ tag_name: 'v0.1.17', draft: false, prerelease: false }])));
  const input = pub.inputFor(feed(), env());
  assert.equal(input.authenticatedDownload, false); assert.equal(input.lab, false); assert.equal(input.fixture, false);
  assert.equal(input.baseline.version, '0.1.14'); assert.deepEqual(input.resources, pub.binding.resources);
  assert.equal(input.source.commit, '930a2886b6872a08a4a25be4738a5a01a4e911d2');
});

test('public download is unauthenticated, bounded and rejects errors or empty bytes', async () => {
  const expected = 'https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.18/latest.json';
  const got = await pub.publicBytes(expected, 4, async (url, options) => {
    assert.equal(url, expected); assert.deepEqual(Object.keys(options.headers), ['User-Agent']);
    return { ok: true, body: [Buffer.from('data')] };
  });
  assert.equal(got.toString(), 'data');
  for (const response of [{ ok: false, status: 404 }, { ok: true, body: [] }, { ok: true, body: [Buffer.alloc(5)] }]) {
    await assert.rejects(pub.publicBytes(expected, 4, async () => response));
  }
});

test('exact root and all15 resource reads retain every immutable pin', () => {
  const reads = [];
  const result = pub.verifyResources(path.resolve('synthetic'), (file, sha256, name) => {
    reads.push({ file, sha256, name }); return { name, size: 1, sha256 };
  });
  assert.equal(reads.length, 16); assert.equal(result.length, 15);
  assert.equal(reads[0].sha256, pub.binding.executable.sha256);
  assert.deepEqual(Object.fromEntries(result.map(row => [row.name.slice(8), row.sha256])), pub.binding.resources);
});

test('bounded resource verifier refuses empty, corrupt, directory and linked files with named diagnostics', t => {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'public18-test-'));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(root)), parent); fs.rmSync(root, { recursive: true, force: true }); });
  const file = path.join(root, 'data'); fs.writeFileSync(file, 'good');
  assert.equal(pub.readHash(file, hash(Buffer.from('good')), 'modules/test').size, 4);
  for (const bytes of ['', 'corrupt']) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => pub.readHash(file, hash(Buffer.from('good')), 'modules/test'), error => {
      assert.equal(error.resourceDiagnostic.name, 'modules/test'); assert.equal(error.resourceDiagnostic.size, Buffer.byteLength(bytes)); return true;
    });
  }
  assert.throws(() => pub.readHash(root, '0'.repeat(64), 'modules/directory'));
  const link = path.join(root, 'link'); fs.symlinkSync(root, link, 'junction');
  assert.throws(() => pub.readHash(path.join(link, 'data'), '0'.repeat(64), 'modules/link'));
});

test('Root identity requires kernel proof, singleton and exact hash; restart must follow approval', () => {
  const hub = 'C:\\test\\creator-hub.exe';
  const before = { pid: 1, parentPid: 9, image: hub, startTicks: '100', kernelIdentityVerified: true };
  const after = { ...before, pid: 2, startTicks: '300' };
  const args = { rows: [after], pid: 2, hub, expectedHash: 'expected', imageHash: () => 'expected' };
  assert.deepEqual(pub.observeRoot(args), after); pub.checkRestart(before, after, '200');
  for (const bad of [{ ...args, imageHash: () => 'wrong' }, { ...args, rows: [after, before] },
    { ...args, rows: [{ ...after, kernelIdentityVerified: false }] }, { ...args, pid: 5 }]) assert.throws(() => pub.observeRoot(bad));
  for (const bad of [before, { ...after, startTicks: '150' }, { ...after, image: 'C:\\other\\creator-hub.exe' }]) assert.throws(() => pub.checkRestart(before, bad, '200'));
});

test('smoke probes resources only after automatic new Root; no manual replacement launch; cleanup is mandatory', () => {
  const text = fs.readFileSync(path.join(__dirname, 'native-self-update-smoke.cjs'), 'utf8');
  assert.ok(text.indexOf('public18.checkRestart(') < text.indexOf('report.installedResources = public18.verifyResources('));
  assert.equal((text.match(/report.installedResources = public18.verifyResources/g) || []).length, 1);
  assert.equal((text.match(/spawn\(hub,/g) || []).length, 1);
  for (const expected of ['version: to.version', 'direct.checkProtocol(page, to.version)',
    'report.sdkConnections !== 2', 'report.rootCleanupVerified !== true', 'report.runtimeCleanupVerified !== true',
    'report.resourceProbe.passed = true']) assert.ok(text.includes(expected), expected);
  assert.ok(text.indexOf('public18.admit()') < text.indexOf('const installer = fixture'));
});
