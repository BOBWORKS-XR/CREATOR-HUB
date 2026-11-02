'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const migration = require('./native-windows-016-migration.cjs');
const handoff = require('./windows-migrated-outgoing-handoff.cjs');
const revision = 'a'.repeat(40);

function report() {
  return { ...migration.reportTemplate(revision), passed: true, nativeGuideAccepted: true, repeatStartupAccepted: true,
    settingsPreserved: true, cancelAccepted: true, installedResourcesVerified: true, policyRestored: true,
    nativeDecisions: [{}, {}], inputBinding: { ...handoff.input, harnessSource: revision }, baselines: [{
      product: 'Creator Hub', version: '0.1.12',
      installerSha256: '0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18',
      executableSha256: '34c6f05548f469ac23b4faee7aa8355d5cca083c444c4f7b0942426a9c76a7ac' }] };
}
test('migration report must bind R2, exact stager, source and successful cleanup', () => {
  const value = report(); handoff.checkReport(value, revision);
  for (const change of [{ passed: false }, { nativeGuideAccepted: false }, { cancelAccepted: false },
    { repeatStartupAccepted: false }, { policyRestored: false }, { sourceUnchanged: false },
    { signedUpdateAccepted: true }, { migrationAccepted: true }, { releaseReady: true },
    { installerSha256: '0'.repeat(64) }, { executableSha256: '0'.repeat(64) }, { nativeDecisions: [] },
    { inputBinding: { ...value.inputBinding, artifactId: 1 } }, { inputBinding: { ...value.inputBinding, harnessSource: 'b'.repeat(40) } },
    { baselines: [{ ...value.baselines[0], executableSha256: '0'.repeat(64) }] }]) {
    assert.throws(() => handoff.checkReport({ ...value, ...change }, revision));
  }
  assert.throws(() => handoff.checkReport(value, 'b'.repeat(40)));
});
test('outgoing baseline must be exact R2 and does not certify a successor', () => {
  const target = require('./windows-migration-r2-candidate.cjs').TARGET;
  const value = { baseline: { version: target.version, installer: target.installer, exe: target.exe },
    targetVersion: '0.1.17', runtime: { baselineDescriptor: migration.RESOURCE_PINS['routing/runtime.json'] } };
  handoff.checkOutgoingBaseline(value);
  for (const change of [{ baseline: { ...value.baseline, installer: '0'.repeat(64) } },
    { baseline: { ...value.baseline, exe: '0'.repeat(64) } }, { targetVersion: '0.1.16' },
    { runtime: { baselineDescriptor: '0'.repeat(64) } }]) assert.throws(() => handoff.checkOutgoingBaseline({ ...value, ...change }));
});
test('explicit migrated mode rejects partial, malformed or overlapping inputs', () => {
  assert.equal(handoff.migrationInputs({}), null);
  assert.throws(() => handoff.migrationInputs({ CREATOR_MIGRATED_UNKNOWN: '1' }));
  const good = { CREATOR_MIGRATED_CONTINUATION: '1', CREATOR_MIGRATED_CANDIDATE: path.resolve('candidate'),
    CREATOR_MIGRATED_BASELINES: path.resolve('baselines') };
  assert.deepEqual(handoff.migrationInputs(good), [good.CREATOR_MIGRATED_CANDIDATE, good.CREATOR_MIGRATED_BASELINES]);
  for (const bad of [{ CREATOR_MIGRATED_CONTINUATION: '1' }, { ...good, CREATOR_MIGRATED_CONTINUATION: '0' },
    { ...good, CREATOR_MIGRATED_CANDIDATE: 'relative' }, { ...good, CREATOR_MIGRATED_BASELINES: good.CREATOR_MIGRATED_CANDIDATE },
    { ...good, CREATOR_MIGRATED_BASELINES: path.resolve('x') + '\n' }]) assert.throws(() => handoff.migrationInputs(bad));
});
test('migration environment removes proxy and product overrides and restores them on success and refusal', async () => {
  for (const fail of [false, true]) {
    const env = { GITHUB_SHA: revision, HTTPS_PROXY: 'http://127.0.0.1:1234', NO_PROXY: 'localhost',
      CREATOR_SELF_UPDATE_LAB_CONFIG: 'saved', NODE_PATH: 'override', WEBVIEW2_DATA: 'override' };
    const before = { ...env };
    const operation = handoff.runWithMigrationEnvironment(['candidate', 'baselines'], env, async args => {
      assert.deepEqual(args, ['candidate', 'baselines']);
      assert.deepEqual(env, { GITHUB_SHA: revision, CREATOR_WINDOWS_016_MIGRATION: '1' });
      env.CREATOR_UNEXPECTED = 'temporary';
      if (fail) throw Error('migration refused');
      return 'done';
    }, () => {});
    if (fail) await assert.rejects(operation, /migration refused/); else assert.equal(await operation, 'done');
    assert.deepEqual(env, before);
  }
});
test('migration cannot start until runner-level network isolation is implemented', async () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:1234' }; let invoked = false;
  await assert.rejects(handoff.runWithMigrationEnvironment([], env, async () => { invoked = true; }), /network isolation is not established/);
  assert.equal(invoked, false); assert.deepEqual(env, { HTTPS_PROXY: 'http://127.0.0.1:1234' });
});
test('preservation guard checks exact bytes and latches refusal even after restoration', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-migrated-guard-'));
  try {
    const first = path.join(temporary, 'settings'), backup = path.join(temporary, 'backup');
    fs.writeFileSync(first, 'saved'); fs.writeFileSync(backup, 'original');
    const guard = handoff.preservationGuard([{ file: first }, { file: backup, expected: Buffer.from('original') }]);
    assert.equal(guard.fileCount, 2); guard.verify();
    fs.writeFileSync(first, 'changed'); assert.throws(() => guard.verify(), /Migrated profile changed/);
    fs.writeFileSync(first, 'saved'); assert.throws(() => guard.verify(), /Migrated profile changed/);
    assert.throws(() => handoff.preservationGuard([{ file: backup, expected: Buffer.from('wrong') }]));
    assert.throws(() => handoff.preservationGuard([{ file: first }, { file: first }]));
  } finally { fs.rmSync(temporary, { recursive: true }); }
});
test('fixture protection covers stores, clients, original backups, untouched files and both projects', () => {
  const env = { USERPROFILE: path.resolve('test-home'), APPDATA: path.resolve('test-home/roaming'), LOCALAPPDATA: path.resolve('test-home/local') };
  const files = handoff.fixtureFiles(env, path.resolve('artifacts/test-migration'));
  assert.equal(files.length, 23);
  assert.equal(files.filter(row => row.file.includes('.creator-hub-settings-backups')).length, 6);
  assert.equal(files.filter(row => row.file.endsWith('AuthoredContent.txt')).length, 2);
});
test('full synthetic migrated fixture admits only exact backups and detects project drift', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-migration-files-'));
  try {
    const env = { USERPROFILE: path.join(temporary, 'home'), APPDATA: path.join(temporary, 'home/roaming'), LOCALAPPDATA: path.join(temporary, 'home/local') };
    const files = handoff.fixtureFiles(env, path.join(temporary, 'out'));
    for (const entry of files) {
      fs.mkdirSync(path.dirname(entry.file), { recursive: true });
      fs.writeFileSync(entry.file, entry.expected || Buffer.from('migrated fixture'));
    }
    const guard = handoff.preservationGuard(files); guard.verify(); assert.equal(guard.fileCount, 23);
    const project = files.find(row => row.file.endsWith('AuthoredContent.txt')).file;
    fs.writeFileSync(project, 'changed'); assert.throws(() => guard.verify(), /Migrated profile changed/);
  } finally { fs.rmSync(temporary, { recursive: true }); }
});
test('real path invokes migration in-process only after runner admission and grants no update authority', () => {
  const source = fs.readFileSync(path.join(__dirname, 'windows-migrated-outgoing-handoff.cjs'), 'utf8');
  const body = source.slice(source.indexOf('async function runAndCapture'));
  assert.ok(body.indexOf('migration.admission()') < body.indexOf('fs.readdirSync'));
  assert.ok(body.indexOf('await migration.main(args)') < body.indexOf('checkReport(report'));
  assert.match(body, /Exactly one same-process migration output required/);
  assert.match(body, /updateAuthority: false/); assert.match(body, /changedMcpGenerationProven: false/);
  assert.doesNotMatch(body, /spawn\(|execFile|\/UPDATE|signer|release edit/);
});
test('outgoing adapter retains cancellation and ownership checks and never reinstalls or reseeds migrated profiles', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../artifacts/menu-merge-20261027/outgoing/driver.cjs'), 'utf8');
  for (const expected of ['target.assertAdmission()', 'target.loadContract(config)', 'handoff.checkOutgoingBaseline(config)',
    'await handoff.runWithMigrationEnvironment(inputs)', "if (!migrated) execFileSync(installer, ['/S', '/NS']",
    'if (!migrated) await setUpdatePreferences(page, restore)', "if (!migrated) await direct.prepareManagedRoute",
    "button('Not now')", "button('Update Hub')", 'sameProcess(rootRecord)', 'assertOwnedDebugging',
    'if (migrated) migrated.guard.verify()', 'report.preservationError', 'changedMcpGenerationProven: false']) assert.ok(source.includes(expected), expected);
  assert.ok(source.indexOf('target.loadContract(config)') < source.indexOf('await handoff.runWithMigrationEnvironment(inputs)'));
  assert.ok(source.indexOf('handoff.checkOutgoingBaseline(config)') < source.indexOf('await handoff.runWithMigrationEnvironment(inputs)'));
  assert.ok(source.lastIndexOf('migrated.guard.verify()') > source.indexOf('if (sentinel?.exitCode === null)'));
});
test('migrated startup refuses visible terms or migration guide without clicking them', async () => {
  const { completeStartup } = require('../artifacts/menu-merge-20261027/outgoing/driver.cjs');
  const page = (terms, guide) => ({ locator(selector) {
    assert.ok(['#usage-terms-dialog', '#convergence-dialog'].includes(selector), `Unexpected action: ${selector}`);
    return { async isVisible() { return selector === '#usage-terms-dialog' ? terms : guide; } };
  }, async waitForFunction() {} });
  for (const version of ['0.1.16', '0.1.17']) {
    await completeStartup(page(false, false), version, { migratedContinuation: true });
    await assert.rejects(completeStartup(page(true, false), version, { migratedContinuation: true }), /terms/);
    await assert.rejects(completeStartup(page(false, true), version, { migratedContinuation: true }), /migration/);
  }
});
test('retained R2 migration report satisfies the content contract when supplied', { skip: !process.env.CREATOR_HISTORICAL_MIGRATION_REPORT }, () => {
  const value = JSON.parse(fs.readFileSync(process.env.CREATOR_HISTORICAL_MIGRATION_REPORT));
  handoff.checkReport(value, value.testSource);
});
