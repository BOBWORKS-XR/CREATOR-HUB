'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const c = require('./windows-017-production.cjs');
const b = require('./fixtures/windows-017-production-binding.json');
const acquire = require('./windows-017-acquire.cjs');
function runner() { return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/validation/windows-menu-merge-20261027',
  GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-017-production.yml@refs/heads/validation/windows-menu-merge-20261027',
  CREATOR_WINDOWS_017_PRODUCTION: '1', CREATOR_PRODUCTION_017_BASELINE: '0.1.12', GITHUB_JOB: 'incoming',
  GITHUB_SHA: 'a'.repeat(40), EXPECTED_HARNESS_COMMIT: 'a'.repeat(40) }; }
test('exact R8 17 bytes and one production metadata set are frozen', () => {
  c.validateBinding(); assert.equal(c.SOURCE.commit, '930a2886b6872a08a4a25be4738a5a01a4e911d2');
  assert.equal(c.TARGET.version, '0.1.18'); assert.equal(b.minHubVersion, '0.1.12');
  assert.equal(c.TARGET.installer, 'c09e3f73ca3e7fab74db2c204a17f6277d5b7817c650f090bd77af00a6f0f3f9');
  assert.equal(c.PINS.descriptor, '34ce337b78887dba0d60e9d93e4d3f24569f8c6009637bca352d4074f38062df');
  for (const key of Object.keys(c.PINS)) assert.throws(() => c.validatePins({ ...c.PINS, [key]: 'b'.repeat(64) }));
});
test('runner gate refuses every wrong identity before candidate operations', () => {
  c.assertHost(runner(), 'win32');
  for (const key of Object.keys(runner())) assert.throws(() => c.assertHost({ ...runner(), [key]: 'wrong' }, 'win32'), key);
  assert.throws(() => c.assertHost(runner(), 'linux'));
  assert.throws(() => c.assertHost({ ...runner(), CREATOR_HOSTED_UPDATE_FIXTURE: 'x' }, 'win32'));
});
test('private release and every immutable file identity are checked', () => {
  const release = { id: b.privateRelease.id, tag_name: 'v0.1.18', draft: true, prerelease: false, target_commitish: c.SOURCE.commit,
    assets: Object.entries(b.assets).map(([name, p]) => ({ id: p.id, name, state: 'uploaded', size: p.size, digest: `sha256:${p.sha256}` })) };
  acquire.verifyRelease(release);
  for (const mutate of [r => r.draft = false, r => r.target_commitish = 'b'.repeat(40), r => r.assets[0].id++,
    r => r.assets[1].digest = 'sha256:' + 'b'.repeat(64), r => r.assets[2].size++, r => r.assets.pop()]) {
    const r = structuredClone(release); mutate(r); assert.throws(() => acquire.verifyRelease(r));
  }
});
test('acquisition provenance cannot carry an old artifact or altered private binding', () => {
  const record = { harnessSource: runner().GITHUB_SHA, privateDraft: true, readbackVerified: true,
    releaseId: b.privateRelease.id, releaseTag: b.privateRelease.tag, source: c.SOURCE, files: b.assets };
  c.validateAcquisition(record, runner().GITHUB_SHA);
  for (const mutate of [r => r.releaseId++, r => r.source.commit = 'b'.repeat(40), r => r.files['latest.json'].id++,
    r => r.privateDraft = false, r => r.readbackVerified = false]) {
    const r = structuredClone(record); mutate(r); assert.throws(() => c.validateAcquisition(r, runner().GITHUB_SHA));
  }
});
test('migration retains exit guards and its snapshot writer remains disabled', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-windows-017-migration.cjs'), 'utf8');
  for (const token of ["run(file, ['/S', '/NS']", 'report.baselineInstallerFailure', 'assert.equal(child.exitCode, 0)',
    'assert.deepEqual(projectImage([f.projectA, f.projectB]), projectBefore', 'verifyBackups([...f.stores, ...f.clients])']) assert.ok(source.includes(token), token);
  assert.doesNotMatch(source, /exitCode\s*[=!]==?\s*10|taskkill|Stop-Process/);
  const owned = fs.readFileSync(path.join(__dirname, 'windows-017-owned-snapshot.cjs'), 'utf8');
  assert.ok(owned.includes('const INCOMING_FIXTURE_ENABLED = false;'));
  assert.ok(owned.includes('assert.equal(update.testOnlyDescriptor, false); assert.equal(update.productionMetadata, true);'));
  assert.ok(owned.includes('assert.equal(lifecycle.cleanupVerified, true)'));
});
test('17 direct protocol rejects 16 and has no local native entrypoint', () => {
  const direct = require('./native-self-update-direct-017.cjs');
  const state = { version: '0.1.18', protocol: 1, integrated: true, services: { integrated: true, features: ['setup', 'mcp'] } };
  direct.assertProtocol(state); assert.throws(() => direct.assertProtocol({ ...state, version: '0.1.16' }));
  const migration = require('./native-windows-017-migration.cjs');
  assert.throws(() => migration.admission({}, 'win32'));
  assert.equal(migration.TARGET.installer, c.TARGET.installer);
});
test('workflow uses named PowerShell parameter splatting, not positional strings', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-017-production.yml'), 'utf8');
  assert.ok(workflow.includes('$parameters=@{ContractPath='));
  assert.ok(workflow.includes('TimeoutSeconds=480}'));
  assert.ok(workflow.includes('native-self-update-lab-017.ps1 @parameters'));
  assert.ok(!workflow.includes('native-self-update-lab-017.ps1 @args'));
});
test('production transport requires exact pins and runner scope before TLS creation', () => {
  const source = fs.readFileSync(path.join(__dirname, 'self-update-lab-feed-017.cjs'), 'utf8');
  const start = source.indexOf('async function startLabProxy');
  const guard = source.indexOf('production.assertHost(env); production.validatePins(contract.pins);', start);
  const tls = source.indexOf('transport.tls.createSecureContext', start);
  assert.ok(guard > start && tls > guard);
  assert.ok(source.slice(start, tls).includes("contract.actualScope?.kind === 'production017-input'"));
  assert.ok(source.slice(start, tls).includes('contract = bindSigned012EmptyDiscovery(contract, env)'));
});
test('incoming-only and custom-server roles remain independent of fixture19', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-017-production.yml'), 'utf8');
  assert.ok(workflow.includes('options: [all, custom-server, standard, incoming-only]'));
  const incoming = workflow.split('  incoming:')[1].split('  incoming-migration:')[0];
  const migration = workflow.split('  incoming-migration:')[1];
  assert.ok(incoming.includes("inputs.migration_scope != 'custom-server'"));
  assert.ok(migration.includes("inputs.migration_scope != 'incoming-only'"));
  assert.ok(incoming.includes('needs: preflight') && migration.includes('needs: preflight'));
  assert.ok(incoming.includes('incoming12') && incoming.includes('incoming14') && incoming.includes('fresh'));
  assert.doesNotMatch(workflow, /needs:.*(?:fixture|outgoing)|fixture19|0\.1\.19/);
});
