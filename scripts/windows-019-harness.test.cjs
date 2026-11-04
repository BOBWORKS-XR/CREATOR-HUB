'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const c = require('./windows-019-contract.cjs');
const raw = require('./windows-019-raw.cjs');
const acquisition = require('./windows-019-acquire.cjs');
const sample = require('./fixtures/windows-019-test-fixture.cjs').fixture();
const clone = value => structuredClone(value);
const source = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
const sha = '6'.repeat(40);
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_JOB: 'install', GITHUB_REF: c.RAW_REF,
  GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-019-raw-installer.yml@${c.RAW_REF}`,
  GITHUB_SHA: sha, EXPECTED_HARNESS_COMMIT: sha, CREATOR_WINDOWS_019_RAW_INSTALL: '1', CREATOR_WINDOWS_ARTIFACT_INSTALL: '1' };

test('disabled or unbound R2 fixture refuses admission before it can authorize work', () => {
  const pending = clone(sample.binding); pending.enabled = false; pending.source.commit = null;
  assert.throws(() => c.validateRaw(pending), /pending/);
  assert.throws(() => c.validateProduction(pending), /pending/);
  assert.throws(() => raw.createAdapter(pending), /pending/);
  pending.enabled = true; assert.throws(() => c.validateRaw(pending));
  if (!c.pinned.enabled) {
    assert.throws(() => c.validateRaw(), /pending/);
    assert.throws(() => raw.createAdapter(), /pending/);
  } else c.validateRaw();
});
test('strict synthetic raw and production contracts admit only complete exact pins', () => {
  assert.equal(c.validateRaw(sample.binding), sample.binding);
  assert.equal(c.validateProduction(sample.binding), sample.binding);
  for (const mutate of [b => { b.enabled = false; }, b => { b.extra = true; }, b => { b.source.commit = null; },
    b => { b.source.tree = '0'.repeat(40); }, b => { b.build.inputsSha256 = null; }, b => { b.build.provenance = null; },
    b => { b.version = '0.1.18'; }, b => { b.installer.name = '../setup.exe'; }, b => { b.executable.sha256 = null; },
    b => { b.manifest.sha256Canonical = 'f'.repeat(64); }, b => { b.rawRelease.assetId = null; },
    b => { b.production.assets['latest.json'].id = b.production.assets[c.ASSET].id; },
    b => { b.production.assets[c.ASSET].sha256 = 'f'.repeat(64); }, b => { b.production.identityProtocol = 2; },
    b => { b.production.targetCommit = null; }, b => { b.production.releaseTag = 'v0.1.18'; }]) {
    const b = clone(sample.binding); mutate(b); assert.throws(() => c.validateProduction(b));
  }
});
test('raw R2 build provenance must prove successful unchanged exact source', () => {
  assert.equal(c.validateBuildProvenance(sample.binding), sample.binding.build.provenance);
  assert.throws(() => c.validateBuildProvenance());
  const changes = [p => { delete p.sourceUnchanged; }, p => { p.sourceUnchanged = false; },
    p => { p.sourceUnchanged = 'true'; }, p => { delete p.status; }, p => { p.status = 1; }, p => { p.status = '0'; },
    p => { delete p.sourceCommit; }, p => { p.sourceCommit = 'a'.repeat(40); },
    p => { delete p.sourceTree; }, p => { p.sourceTree = 'b'.repeat(40); },
    p => { p.kind = 'unreviewed-postbuild'; }, p => { p.schemaVersion = 2; }, p => { p.version = '0.1.18'; },
    p => { delete p.changed; }, p => { p.changed = ['src/changed.rs']; }];
  for (const change of changes) {
    const value = clone(sample.binding); change(value.build.provenance);
    assert.throws(() => c.validateBuildProvenance(value));
    assert.throws(() => c.validateRaw(value));
    assert.throws(() => c.validateProduction(value));
  }
});
test('raw host guard binds exact job, workflow, branch and harness commit', () => {
  raw.assertRunner(env, 'win32');
  for (const change of [{ GITHUB_SHA: '7'.repeat(40) }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_JOB: 'incoming' },
    { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REPOSITORY_ID: '1' }, { CREATOR_WINDOWS_019_RAW_INSTALL: undefined }]) {
    assert.throws(() => raw.assertRunner({ ...env, ...change }, 'win32'));
  }
  assert.throws(() => raw.assertRunner(env, 'linux'));
});
test('pending or mismatched raw acquisition performs no GET', async () => {
  let gets = 0;
  await assert.rejects(acquisition.acquire('raw', { ...env, GH_TOKEN: 'synthetic-test-only' }, async () => { gets++; throw Error('must not fetch'); }));
  assert.equal(gets, 0);
});
test('raw input receipt requires exact candidate and provenance identity', () => {
  const adapter = raw.createAdapter(sample.binding);
  const receipt = { schemaVersion: 1, releaseId: 1001, releaseTag: 'synthetic-019-raw', assetId: 1002,
    assetName: c.ASSET, bytes: sample.installer.length, sha256: c.hash(sample.installer), receiptSha256: '3'.repeat(64) };
  adapter.boundIdentity(receipt);
  for (const change of [{ releaseId: 1002 }, { assetId: 1003 }, { bytes: 1 }, { receiptSha256: 'a'.repeat(64) }, { extra: 1 }]) {
    assert.throws(() => adapter.boundIdentity({ ...receipt, ...change }));
  }
});
test('baseline18 never silently falls back to14 and all three public lanes are exact', () => {
  for (const version of ['0.1.12', '0.1.14', '0.1.18']) assert.equal(c.baselineFor(version).version, version);
  assert.throws(() => c.baselineFor('0.1.18', () => c.baselineFor('0.1.14')));
  assert.throws(() => c.baselineFor('0.1.19'));
});
function release(mode) {
  const b = sample.binding, rawMode = mode === 'raw';
  return { id: rawMode ? b.rawRelease.id : b.production.releaseId, tag_name: rawMode ? b.rawRelease.tag : b.production.releaseTag,
    target_commitish: b.production.targetCommit, draft: true, prerelease: rawMode,
    assets: Object.entries(rawMode ? { [c.ASSET]: { id: b.rawRelease.assetId, size: b.installer.bytes, sha256: b.installer.sha256 } } : b.production.assets)
      .map(([name, pin]) => ({ name, id: pin.id, state: 'uploaded', size: pin.size, digest: `sha256:${pin.sha256}` })) };
}
test('GET acquisition rejects draft, source, duplicate, identity and digest drift', () => {
  for (const mode of ['raw', 'production']) {
    const r = release(mode); acquisition.verifyRelease(r, mode, sample.binding);
    for (const mutate of [r => { r.draft = false; }, r => { r.prerelease = !r.prerelease; }, r => { r.id++; },
      r => { r.assets.push(r.assets[0]); }, r => { r.assets[0].digest = 'sha256:' + '0'.repeat(64); },
      r => { r.assets[0].name = 'other.exe'; }, r => { r.assets[0].size++; }]) {
      const bad = clone(r); mutate(bad); assert.throws(() => acquisition.verifyRelease(bad, mode, sample.binding));
    }
  }
  assert.throws(() => acquisition.verifyRelease({ ...release('production'), target_commitish: 'main' }, 'production', sample.binding));
});
test('download reader preserves bytes and rejects oversized bodies and HTTP failures', async () => {
  const bytes = Buffer.from([0, 27, 255, 13, 10]);
  assert.deepEqual(await acquisition.responseBytes(new Response(bytes), bytes.length), bytes);
  await assert.rejects(acquisition.responseBytes(new Response(bytes), 4));
  await assert.rejects(acquisition.responseBytes(new Response(bytes, { headers: { 'content-length': '99' } }), 5));
  await assert.rejects(acquisition.responseBytes(new Response('', { status: 403 }), 5));
});

require('./fixtures/windows-019-test-fixture.cjs').install();
const production = require('./windows-019-production.cjs');
const feed = require('./self-update-lab-feed-019.cjs');
test('production host permits only exact incoming roles and reviewed source', () => {
  const valid = { ...env, GITHUB_JOB: 'incoming', GITHUB_REF: c.PRODUCTION_REF,
    GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-019-production.yml@${c.PRODUCTION_REF}`,
    CREATOR_WINDOWS_019_PRODUCTION: '1', CREATOR_PRODUCTION_019_BASELINE: '0.1.18' };
  production.assertHost(valid, 'win32');
  for (const change of [{ GITHUB_JOB: 'outgoing' }, { GITHUB_EVENT_NAME: 'push' }, { EXPECTED_HARNESS_COMMIT: 'f'.repeat(40) },
    { CREATOR_PRODUCTION_019_BASELINE: '0.1.16' }, { CREATOR_HOSTED_UPDATE_FIXTURE: 'override' },
    { GITHUB_JOB: 'incoming-migration', CREATOR_PRODUCTION_019_BASELINE: '0.1.18' }]) {
    assert.throws(() => production.assertHost({ ...valid, ...change }, 'win32'));
  }
});
test('production feed retains seven bounded routes for12, exactly five for14 and18', () => {
  const input = { targetVersion: c.VERSION, pins: production.PINS, installer: sample.installer,
    descriptor: sample.descriptor, descriptorSignature: sample.signature, manifest: sample.latest };
  for (const version of ['0.1.12', '0.1.14', '0.1.18']) {
    const contract = feed.createProduction019Contract(input, version);
    assert.equal(contract.baseline.version, version); assert.equal(contract.targetVersion, '0.1.19');
    assert.equal(contract.routes.length, version === '0.1.12' ? 7 : 5);
    assert.equal(Boolean(contract.syntheticDiscovery), version === '0.1.12');
    assert.equal(contract.actualScope.publicDiscovery, false); assert.equal(contract.actualScope.releaseReady, false);
  }
  assert.throws(() => feed.createProduction019Contract({ ...input, installer: Buffer.from('changed') }, '0.1.18'));
  assert.throws(() => feed.createProduction019Contract(input, '0.1.19'));
});
test('feed projects unchanged source only from validated provenance and retains the full receipt', () => {
  const receipt = production.binding.build.provenance;
  const projected = production.productProvenance();
  assert.equal(projected.buildProvenance, receipt);
  assert.deepEqual(projected.buildProvenance, sample.binding.build.provenance);
  assert.equal(projected.sourceUnchanged, receipt.sourceUnchanged);
  const input = { targetVersion: c.VERSION, pins: production.PINS, installer: sample.installer,
    descriptor: sample.descriptor, descriptorSignature: sample.signature, manifest: sample.latest };
  const contract = feed.createProduction019Contract(input, production.BASELINE.version);
  const scope = production.discoveryScope(contract);
  assert.equal(scope.sourceUnchanged, true); assert.equal(scope.buildProvenance, receipt);
  for (const change of [{ sourceUnchanged: undefined }, { sourceUnchanged: false }, { status: 1 },
    { sourceCommit: 'a'.repeat(40) }, { sourceTree: 'b'.repeat(40) }]) {
    try {
      production.binding.build.provenance = { ...receipt, ...change };
      assert.throws(() => production.productProvenance());
      assert.throws(() => production.discoveryScope(contract));
    } finally { production.binding.build.provenance = receipt; }
  }
});
test('new direct helper requires19 without relaxing native protocol or integrated services', () => {
  const direct = require('./native-self-update-direct-019.cjs');
  const state = { version: '0.1.19', protocol: 1, integrated: true, services: { integrated: true, features: ['setup', 'mcp'] } };
  direct.assertProtocol(state);
  for (const change of [{ version: '0.1.18' }, { protocol: 0 }, { integrated: false }, { services: {} }]) assert.throws(() => direct.assertProtocol({ ...state, ...change }));
});
test('public18 uses direct Home while12 and14 retain the legacy Apps navigation', async () => {
  const vm = require('node:vm');
  const text = source('native-self-update-smoke-019.cjs');
  const begin = text.indexOf('async function showApps() {');
  const end = text.indexOf('\nasync function showApp(', begin);
  assert.ok(begin > 0 && end > begin);
  for (const version of ['0.1.12', '0.1.14', '0.1.18']) {
    const clicks = [];
    const context = { from: { version }, page: { locator: selector => ({ click: async () => clicks.push(selector) }) },
      direct: { checkHome: async () => clicks.push('direct-home-assertion') } };
    vm.runInNewContext(text.slice(begin, end) + ';this.navigate = showApps;', context);
    await context.navigate();
    assert.deepEqual(clicks, ['#suite-trigger', '#suite-menu [data-view="hub"]',
      version === '0.1.18' ? 'direct-home-assertion' : '#hub-pages [data-view="hub"]']);
  }
});
test('workflow YAML parses and retains complete bounded native roles and exact source checkout', () => {
  const { yaml } = require(path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib/utilsBundle.js'));
  for (const kind of ['raw-installer', 'production']) {
    const text = fs.readFileSync(path.join(__dirname, `../.github/workflows/windows-019-${kind}.yml`), 'utf8');
    const workflow = yaml.parse(text);
    assert.deepEqual(workflow.on.push.branches, [`validation/windows-019-${kind === 'production' ? 'production' : 'raw-installer'}`]);
    assert.equal(workflow.on.workflow_dispatch.inputs.expected_harness_commit.required, true);
    assert.doesNotMatch(text, /cargo |tauri build|build:unified|gh workflow|gh release|signing|outgoing-019/);
    for (const [name, job] of Object.entries(workflow.jobs)) {
      assert.equal(job['runs-on'], 'windows-latest');
      if (name !== 'preflight') {
        assert.match(job.if, /workflow_dispatch/);
        assert.ok(JSON.stringify(job.steps).includes('EXPECTED_HARNESS_COMMIT'));
      }
    }
    if (kind === 'raw-installer') assert.deepEqual(workflow.jobs.install.strategy.matrix.mode, ['fresh', 'guarded']);
    else {
      const matrix = workflow.jobs.incoming.strategy.matrix;
      const variants = [...matrix.matchAll(/'({"include":.*?})'/g)].map(match => JSON.parse(match[1]).include);
      assert.deepEqual(variants.map(rows => rows.map(row => row.case)), [['incoming12', 'incoming14', 'incoming18'], ['fresh', 'incoming12', 'incoming14', 'incoming18']]);
      assert.match(workflow.jobs['incoming-migration'].strategy.matrix.migration_case, /\["legacy","setup-owned-codex","setup-owned-codex-unverified-server"\]/);
      for (const job of [workflow.jobs.incoming, workflow.jobs['incoming-migration']]) {
        const pins = job.steps.findIndex(step => step.id === 'pins');
        const checkout = job.steps.findIndex(step => step.with?.path === 'product');
        assert.ok(pins >= 0 && checkout > pins); assert.equal(job.steps[checkout].with.ref, '${{ steps.pins.outputs.source }}');
      }
      assert.match(text, /TimeoutSeconds=480/); assert.match(text, /!artifacts\/native-suite-\*\/startup.json/);
    }
  }
});
test('all new native entry points retain guarded recovery, screenshot and settings evidence', () => {
  const migration = source('native-windows-019-migration.cjs'), lifecycle = source('native-self-update-lab-019.ps1');
  for (const check of ['await nativeDecision(false)', 'await nativeDecision(true)', 'verifyBackups', 'projectBefore', 'screenshot']) assert.ok(migration.includes(check));
  assert.match(migration, /installLegacyBaselines\([\s\S]*seedMigrationFixture\(/);
  assert.match(lifecycle, /\$TimeoutSeconds -gt 480/);
  assert.match(lifecycle, /Historical\/outgoing mode is not admitted/);
  assert.match(source('windows-019-raw-install.cjs'), /mode === 'guarded' \? \['\/UPDATE', '\/S', '\/NS'\]/);
  assert.match(source('native-windows-019-fresh.cjs'), /formattingEquivalentSettingsAccepted = true/);
});
test('new native JavaScript parses without invoking any installer or product', () => {
  for (const file of ['windows-019-raw-install.cjs', 'native-windows-019-fresh.cjs', 'native-windows-019-migration.cjs',
    'native-self-update-smoke-019.cjs', 'native-self-update-direct-019.cjs', 'windows-019-acquire.cjs']) {
    execFileSync(process.execPath, ['--check', path.join(__dirname, file)], { timeout: 10000, windowsHide: true });
  }
});
