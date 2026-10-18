const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fixture = require('./linux-outer-update-fixture.cjs');
const { moduleFiles } = require('./build-unified.cjs');
const { bumpRootVersion, VERSIONS } = require('./build-outer-update-fixture.cjs');
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/validation/linux-outer-update-fixture-014', CREATOR_LINUX_OUTER_UPDATE_FIXTURE: '1' };
test('only the finite disposable Linux x64 lane is admitted', () => {
  fixture.nativeAdmission(env, 'linux', 'x64');
  for (const key of Object.keys(env)) assert.throws(() => fixture.nativeAdmission({ ...env, [key]: 'other' }, 'linux', 'x64'));
  assert.throws(() => fixture.nativeAdmission(env, 'win32', 'x64'));
  assert.throws(() => fixture.nativeAdmission(env, 'linux', 'arm64'));
  for (const key of ['TAURI_SIGNING_PRIVATE_KEY', 'CREATOR_HUB_SIGNING_KEY_PATH', 'LD_PRELOAD', 'NODE_OPTIONS']) {
    assert.throws(() => fixture.nativeAdmission({ ...env, [key]: '' }, 'linux', 'x64'));
  }
});
test('Linux15 runtime body binds unchanged complete MCP files, never Windows or a caller version', () => {
  const files = Object.fromEntries(moduleFiles('mcp', 'linux').map(name => [name, 'a'.repeat(64)]));
  const manifest = { schemaVersion: 1, platform: 'linux', arch: 'x86_64', modules: {
    mcp: { executable: 'mcp/creator-works-mcp-launcher', version: '2.7.7', files } } };
  const parsed = JSON.parse(fixture.runtimeBody(manifest));
  assert.equal(parsed.hubVersion, '0.1.15'); assert.equal(parsed.platform, 'linux');
  assert.deepEqual(parsed.module.files, files); assert.equal(parsed.module.version, '2.7.7');
  assert.throws(() => fixture.runtimeBody({ ...manifest, platform: 'windows' }));
  delete files['mcp/server/runtime/node']; assert.throws(() => fixture.runtimeBody(manifest));
});
test('unreviewed manifest refuses before signer or native execution', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-linux-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, fixture.BASELINE.directory), { recursive: true });
  fs.writeFileSync(path.join(root, fixture.BASELINE.directory, 'builtin-manifest.json'), '{}');
  let called = false;
  assert.throws(() => fixture.prepareRuntime('linux-runtime15-refusal', { root, platform: 'win32',
    signer: { signingKey() { called = true; } }, execute() { called = true; } }), /reviewed Linux14 manifest/);
  assert.equal(called, false); assert.equal(fs.existsSync(path.join(root, 'artifacts/linux-runtime15-refusal')), false);
});
test('source checker accepts only exact pinned bytes and explicit Root version change', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-linux-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = Buffer.from('{"name":"creator-hub","version":"0.1.14"}\n');
  fs.writeFileSync(path.join(root, 'package.json'), original);
  const entry = crypto.createHash('sha1').update(`blob ${original.length}\0`).update(original).digest('hex');
  fixture.checkSource(root, { 'package.json': entry });
  const changed = bumpRootVersion('package.json', original);
  fs.writeFileSync(path.join(root, 'package.json'), changed);
  assert.throws(() => fixture.checkSource(root, { 'package.json': entry }));
  const record = { sha256: crypto.createHash('sha256').update(changed).digest('hex') };
  fixture.checkSource(root, { 'package.json': entry }, { 'package.json': record });
  assert.throws(() => fixture.checkSource(root, { 'package.json': entry }, { 'package.json': record, 'other.rs': record }));
  fs.writeFileSync(path.join(root, 'package.json'), 'unrelated edit');
  assert.throws(() => fixture.checkSource(root, { 'package.json': entry }, { 'package.json': record }));
});
test('finite baseline and version-only field allowlist remain independent of Windows fixture', () => {
  assert.equal(fixture.FROM, '0.1.14'); assert.equal(fixture.TO, '0.1.15');
  assert.equal(fixture.BASELINE.source, '534465a86554e95b909bf9c7decbbb29cbca5267');
  assert.deepEqual(VERSIONS, ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']);
  assert.match(fixture.BASELINE.deb, /^[a-f0-9]{64}$/);
});
test('native workflow uses exact14 inputs and private15 metadata with no publication or Windows jobs', () => {
  const { yaml } = require('playwright-core/lib/utilsBundle');
  const body = fs.readFileSync(path.join(__dirname, '../.github/workflows/linux-outer-update-fixture-014.yml'), 'utf8');
  const workflow = yaml.parse(body, { uniqueKeys: true });
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' });
  assert.deepEqual(workflow.on.push.branches, ['validation/linux-outer-update-fixture-014']);
  assert.equal(workflow.jobs.target['runs-on'], 'ubuntu-22.04');
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/usr/bin/bash';
  const { spawnSync } = require('node:child_process');
  let bodies = 0;
  for (const step of workflow.jobs.target.steps) {
    if (step.run) {
      const result = spawnSync(bash, ['-n'], { input: step.run, encoding: 'utf8', timeout: 10000, shell: false });
      assert.equal(result.status, 0, `${step.name}: ${result.stderr}`); bodies++;
    }
    if (step.with?.script) new (Object.getPrototypeOf(async function(){}).constructor)('github', 'context', step.with.script);
  }
  assert.equal(bodies, 4);
  assert.doesNotMatch(body, /contents: write|gh release|windows-latest|macos-|publish-hub|secrets\./);
  assert.match(body, /assert.equal\(release.draft,true\)/);
  assert.match(body, /assert.equal\(run.conclusion,'success'\)/);
  assert.match(body, /assert.equal\(artifact.digest,'sha256:904b51a/);
  assert.match(body, /assert.equal\(sha\(bytes\),digest\)/);
});
