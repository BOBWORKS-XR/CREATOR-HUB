'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const target = require('./windows-outgoing-019-target.cjs');
const direct = require('./native-outgoing-direct-019.cjs');
const driver = require('./windows-outgoing-019-driver.cjs');
const profile = { local: 'C:/fixture/AppData/Local', home: 'C:/fixture' };
const locations = version => target.managedLocations(profile.local, version, profile.home);
function processes(version, pid) {
  const route = locations(version);
  return [{ pid, startTicks: String(pid), kernelIdentityVerified: true, image: route.command },
    { pid: pid + 1, parentPid: pid, startTicks: String(pid + 1), kernelIdentityVerified: true,
      image: path.join(route.payload, 'mcp/server/runtime/node.exe') }];
}
test('R11 is source-bound and pending bytes cannot pass native admission', () => {
  assert.deepEqual(target.EXPECTED_TARGET_SOURCE, { commit: 'f8b3ded9683a9cdc84e139cfddbe4020330aca93',
    tree: '649451b196b7d4597f6375d4b1af253f9355295e' });
  const pending = structuredClone(require('./fixtures/windows-outgoing-019-test-fixture.cjs').binding);
  pending.enabled = false;
  assert.throws(() => target.validateBinding(pending), /Pending exact22\/private23 pins/);
});
test('old and new roots are explicit, versioned and never fall back', () => {
  assert.equal(locations('0.1.22').base, path.join(profile.local, 'creator-hub'));
  assert.equal(locations('0.1.23').base, path.join(profile.home, '.creator-hub'));
  assert.equal(locations('0.1.22').router, 'router-v1');
  assert.equal(locations('0.1.23').router, 'router-v2');
  assert.throws(() => target.managedLocations(profile.local, '0.1.23'));
  assert.throws(() => target.managedLocations(profile.local, '0.1.24', profile.home));
});
test('fresh connection permits only the exact old-to-new migration', () => {
  const held = processes('0.1.22', 20), fresh = processes('0.1.23', 30);
  target.assertFreshConnection(held, fresh, profile);
  for (const mutate of [rows => rows[0].image = held[0].image,
    rows => rows[1].image = held[1].image, rows => rows[0].image = 'D:/other/router-v2/creator-hub-mcp-router.exe',
    rows => rows[1].parentPid++, rows => rows[0].pid = held[0].pid,
    rows => rows[0].kernelIdentityVerified = false, rows => rows[1].startTicks = '0']) {
    const changed = structuredClone(fresh); mutate(changed);
    assert.throws(() => target.assertFreshConnection(held, changed, profile));
  }
  assert.throws(() => target.assertFreshConnection(held, fresh));
});
function migration() {
  const before = { mcpServers: { 'creator-works': { command: locations('0.1.22').command, args: [],
    env: { CREATOR_WORKS_CONFIG_OWNER: 'creator-hub-v1', CUSTOM: 'keep' }, enabled: false },
    other: { command: 'keep' } }, preferences: { keep: true } };
  const settingsPath = 'C:/fixture/.creator-hub/settings-views/reviewed/launcher-config.json';
  const after = structuredClone(before);
  after.mcpServers['creator-works'].command = locations('0.1.23').command;
  after.mcpServers['creator-works'].env.CREATOR_WORKS_LAUNCHER_CONFIG = settingsPath;
  return { before, after, settingsPath, approved: true, oldCommand: locations('0.1.22').command,
    newCommand: locations('0.1.23').command, oldClientBefore: Buffer.from('old-client exact bytes\r\n'),
    oldClientAfter: Buffer.from('old-client exact bytes\r\n') };
}
test('reviewed JSON client changes only command and missing pin, preserving old client', () => {
  direct.assertReviewedClientMigration(migration());
  for (const mutate of [value => value.approved = false,
    value => value.oldClientAfter = Buffer.from('changed'),
    value => value.after.mcpServers.other.command = 'changed',
    value => value.after.mcpServers['creator-works'].args.push('--custom'),
    value => value.after.mcpServers['creator-works'].env.CUSTOM = 'changed',
    value => value.after.mcpServers['creator-works'].env.CREATOR_WORKS_LAUNCHER_CONFIG = 'C:/wrong.json']) {
    const value = migration(); mutate(value);
    assert.throws(() => direct.assertReviewedClientMigration(value));
  }
});

test('review preserves explicit current and legacy settings pins', () => {
  for (const key of ['CREATOR_WORKS_LAUNCHER_CONFIG', 'BANTWORKS_LAUNCHER_CONFIG']) {
    const value = migration(), pinned = 'C:/fixture/retained-settings.json';
    value.before.mcpServers['creator-works'].env[key] = pinned;
    value.after = structuredClone(value.before);
    value.after.mcpServers['creator-works'].command = value.newCommand;
    value.after.mcpServers['creator-works'].env.CREATOR_WORKS_LAUNCHER_CONFIG = pinned;
    direct.assertReviewedClientMigration(value);
    value.after.mcpServers['creator-works'].env.CREATOR_WORKS_LAUNCHER_CONFIG = value.settingsPath;
    assert.throws(() => direct.assertReviewedClientMigration(value));
  }
});

function nativeReviewFixture(results) {
  const calls = [], waiting = [];
  let wake;
  const page = { evaluate(fn) {
    return vm.runInNewContext(`(${fn.toString()})()`, { window: { CreatorHubNative: {
      async invoke(name, { feature, command, args }) {
        assert.equal(name, 'feature_call'); assert.equal(feature, 'mcp');
        calls.push({ command, args: JSON.parse(JSON.stringify(args)) });
        if (command === 'begin_ui_operation') return 7;
        if (command === 'finish_ui_operation') { assert.equal(args.id, 7); return; }
        assert.equal(command, 'review_existing_client_connections');
        assert.deepEqual(Array.from(args.clients), ['claude']);
        return new Promise((resolve, reject) => { waiting.push({ resolve, reject }); if (wake) wake(); });
      },
    } } });
  } };
  const labels = [];
  const choose = async label => {
    if (!waiting.length) await new Promise(resolve => { wake = resolve; });
    labels.push(label);
    const request = waiting.shift(), result = results.shift();
    if (result instanceof Error) request.reject(result); else request.resolve(result);
  };
  return { page, choose, calls, labels };
}

test('owned native review cancels before approving exactly Claude and always finishes its operation', async () => {
  const journal = 'C:/fixture/AppData/Local/creator-hub/client-migrations-v1/' + 'a'.repeat(64);
  const fixture = nativeReviewFixture([{ status: 'cancelled', count: 0 }, { status: 'migrated', count: 1, journal }]);
  let checks = 0, cancellations = 0;
  const result = await direct.migrateExistingClaude(fixture.page, { choose: fixture.choose,
    verifyBeforeApproval: () => { checks++; }, captureCancelled: async () => { cancellations++; } });
  assert.deepEqual(fixture.labels, ['Keep existing', 'Move selected connections']);
  assert.equal(checks, 3); assert.equal(cancellations, 1);
  assert.equal(result.approved.journal, journal);
  assert.deepEqual(fixture.calls.map(call => call.command), [
    'begin_ui_operation', 'review_existing_client_connections', 'finish_ui_operation',
    'begin_ui_operation', 'review_existing_client_connections', 'finish_ui_operation',
  ]);
});

test('native review refuses noop or error in place of an approved migration', async () => {
  for (const result of [{ status: 'unchanged', count: 0 }, new Error('Native refusal')]) {
    const fixture = nativeReviewFixture([{ status: 'cancelled', count: 0 }, result]);
    await assert.rejects(direct.migrateExistingClaude(fixture.page, { choose: fixture.choose,
      verifyBeforeApproval() {}, async captureCancelled() {} }));
    assert.equal(fixture.calls.filter(call => call.command === 'finish_ui_operation').length, 2);
  }
  const fixture = nativeReviewFixture([{ status: 'unchanged', count: 0 }]);
  await assert.rejects(direct.migrateExistingClaude(fixture.page, { choose: fixture.choose,
    verifyBeforeApproval() {}, async captureCancelled() { throw Error('Must not reach capture'); } }));
  assert.deepEqual(fixture.labels, ['Keep existing']);
});

test('fresh old-client proof requires six distinct exact-generation processes', () => {
  const held = processes('0.1.22', 10), old = processes('0.1.22', 20), fresh = processes('0.1.23', 30);
  driver.assertFreshOldConnection(held, old, fresh, profile);
  for (const mutate of [rows => rows[0].pid = held[0].pid, rows => rows[1].image = fresh[1].image,
    rows => rows[0].image = fresh[0].image, rows => rows[1].parentPid++,
    rows => rows[0].startTicks = '0', rows => rows[1].kernelIdentityVerified = false]) {
    const changed = structuredClone(old); mutate(changed);
    assert.throws(() => driver.assertFreshOldConnection(held, changed, fresh, profile));
  }
});

test('R11 startup defers only the changed seeded-client review and keeps accepted terms', async () => {
  const events = [];
  let visible = true;
  const page = {
    locator(selector) { return {
      async isVisible() { return selector === '#convergence-dialog' && visible; },
      async waitFor({ state }) { assert.equal(visible, state === 'visible'); },
      async click() { assert.equal(selector, '#convergence-later'); visible = false; events.push('defer'); },
    }; },
    async waitForFunction() {},
    async evaluate() { return { required: true, reviewKey: 'a'.repeat(64) }; },
  };
  const report = { clients: {}, migrationDeferred: true };
  await driver.completeStartup(page, '0.1.23', report);
  assert.deepEqual(events, ['defer']);
  assert.deepEqual(report.startupClientReviews, [{ reviewKey: 'a'.repeat(64), deferred: true }]);
  assert.equal(report.migrationDeferralPreserved, true);
  await assert.rejects(driver.completeStartup(page, '0.1.23', { clients: {} }), /must have been visibly deferred/);
});

function temporary(t) {
  const root = path.resolve(__dirname, '../artifacts/incoming-r11-tests');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'case-'));
  t.after(() => {
    assert.equal(path.dirname(directory), root);
    assert.ok(path.basename(directory).startsWith('case-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { flag: 'wx' });
}

test('cancel preservation compares exact bytes for both clients', t => {
  const root = temporary(t), selectedPath = path.join(root, '.claude.json'), oldClientPath = path.join(root, 'old.json');
  const selectedBefore = Buffer.from('{"mcpServers":{}}\n'), oldClientBefore = Buffer.from('{"old":true}\r\n');
  write(selectedPath, selectedBefore); write(oldClientPath, oldClientBefore);
  const value = { selectedPath, oldClientPath, selectedBefore, oldClientBefore };
  direct.assertClientBytes(value);
  for (const file of [selectedPath, oldClientPath]) {
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, JSON.stringify(JSON.parse(original)));
    assert.throws(() => direct.assertClientBytes(value));
    fs.writeFileSync(file, original);
  }
});

test('automatic successor gate still rejects incorrect identity, image and version before resource reads', async () => {
  const hub = 'C:/fixture/Creator Hub/creator-hub.exe';
  const record = { pid: 20, parentPid: 1, startTicks: '20', image: hub, kernelIdentityVerified: true };
  for (const mode of ['good', 'same-pid', 'kernel', 'hash', 'version', 'resource']) {
    const events = [];
    const candidate = { ...record, ...(mode === 'same-pid' ? { pid: 10 } : {}),
      ...(mode === 'kernel' ? { kernelIdentityVerified: false } : {}) };
    const run = driver.observeAutomaticSuccessor({ hub, previousPid: 10, expectedSha256: 'a'.repeat(64),
      inventory: () => [candidate], hashFile: () => (mode === 'hash' ? 'b' : 'a').repeat(64),
      peVersion: () => [0, 1, mode === 'version' ? 22 : 23, 0],
      onObserved: () => events.push('observed'),
      verifyResources: () => { events.push('resources'); if (mode === 'resource') throw Error('Bad resource'); },
      wait: async (read, seconds) => { assert.equal(seconds, 90); return read(); } });
    if (mode === 'good') { await run; assert.deepEqual(events, ['observed', 'resources']); }
    else {
      await assert.rejects(run);
      assert.deepEqual(events, mode === 'resource' ? ['observed', 'resources'] : []);
    }
  }
});

test('settings view path and receipt bind actual physical source and semantic content', t => {
  const root = temporary(t), source = path.join(root, 'settings/launcher-config.json');
  const bytes = Buffer.from('{"z":true,"channels":[],"a":{"keep":"yes"}}\n');
  write(source, bytes);
  const review = direct.reviewedSettings(source, path.join(root, '.creator-hub'));
  assert.equal(review.source, direct.physicalSettingsPath(source));
  assert.equal(review.path, path.join(root, '.creator-hub/settings-views', target.hash(review.source), 'launcher-config.json'));
  assert.equal(fs.existsSync(review.path), false, 'Planning must not publish a view');
  const canonical = '{"a":{"keep":"yes"},"channels":[],"z":true}';
  const view = { ...JSON.parse(bytes), _creator_hub_view: { source: review.source, sha256: target.hash(canonical) } };
  write(review.path, JSON.stringify(view));
  direct.assertSettingsView(review);
  for (const mutate of [v => v.z = false, v => v._creator_hub_view.source = 'C:/other.json',
    v => v._creator_hub_view.sha256 = '0'.repeat(64)]) {
    const changed = structuredClone(view); mutate(changed); fs.writeFileSync(review.path, JSON.stringify(changed));
    assert.throws(() => direct.assertSettingsView(review));
  }
  fs.writeFileSync(review.path, JSON.stringify(view)); fs.writeFileSync(source, bytes.toString().trim());
  assert.throws(() => direct.assertSettingsView(review), /source settings changed/);
});

function journalFixture(t) {
  const root = temporary(t), local = path.join(root, 'Local'), selectedPath = path.join(root, '.claude.json');
  const before = Buffer.from('{"command":"old"}\r\n'), after = Buffer.from('{"command":"new"}\r\n');
  write(selectedPath, after);
  const pending = { schema: 1, files: [{ client: 'Claude Code', path: fs.realpathSync.native(selectedPath),
    before_sha256: target.hash(before), after_sha256: target.hash(after) }] };
  const pendingBytes = Buffer.from(JSON.stringify(pending)), id = target.hash(pendingBytes);
  const journal = path.join(local, 'creator-hub/client-migrations-v1', id);
  for (const [name, bytes] of [['pending.json', pendingBytes], ['completed.json', pendingBytes],
    ['0.before.bin', before], ['0.after.bin', after],
    ['0.intent.json', JSON.stringify({ schema: 1, before_sha256: target.hash(before), after_sha256: target.hash(after) })],
    ['0.native.json', '{"schema":1,"success":true,"error":null}'],
    ['0.outcome.json', '{"schema":1,"status":"Applied","native_error":null}']]) write(path.join(journal, name), bytes);
  const backup = path.join(root, '.creator-hub-settings-backups', `.claude.json.${target.hash(before)}.bak`);
  const retained = path.join(root, `.creator-hub-migration-${id}-0/retained.bin`);
  write(backup, before); write(retained, before);
  return { local, selectedPath, before, after, result: { status: 'migrated', count: 1, journal }, backup, retained };
}

test('native journal requires exact backups, before/after images and completed publication', { skip: process.platform !== 'win32' }, t => {
  const fixture = journalFixture(t), evidence = direct.assertMigrationEvidence(fixture);
  assert.equal(evidence.files.length, 9); assert.equal(evidence.backup, fixture.backup);
  for (const file of [fixture.backup, fixture.retained, path.join(fixture.result.journal, '0.before.bin'),
    path.join(fixture.result.journal, '0.after.bin'), path.join(fixture.result.journal, 'completed.json'),
    path.join(fixture.result.journal, '0.native.json'), path.join(fixture.result.journal, '0.outcome.json')]) {
    const original = fs.readFileSync(file); fs.writeFileSync(file, '{}');
    assert.throws(() => direct.assertMigrationEvidence(fixture)); fs.writeFileSync(file, original);
  }
  for (const result of [{ ...fixture.result, count: 0 }, { ...fixture.result, status: 'unchanged' },
    { ...fixture.result, journal: path.join(fixture.local, 'wrong-store', path.basename(fixture.result.journal)) }]) {
    assert.throws(() => direct.assertMigrationEvidence({ ...fixture, result }));
  }
});

test('driver keeps all old gates and orders automatic replacement before distinct normal restart', () => {
  const source = fs.readFileSync(path.join(__dirname, 'windows-outgoing-019-driver.cjs'), 'utf8');
  assert.doesNotMatch(source, /require\('\.\/native-managed-target\.cjs'\)/);
  for (const gate of ['target.assertAdmission();', "target.managedLocations(local, '0.1.22', home)",
    "target.managedLocations(local, '0.1.23', home)", 'profile, labDiscovery: true',
    'target.assertGenerationProcess(nodes[0].image, local, version, home)',
    'target.assertActiveResources(local, version, value, true, home)',
    "target.assertActiveResources(local, '0.1.22', report.beforeRoute, true, home)",
    'target.assertFreshConnection(sdkRecords, rows, profile)',
    'assertFreshOldConnection(sdkRecords, oldRows, rows, profile)',
    'sameProcess(sentinelRecord)', 'await roundTrip(sdkClient)',
    'await roundTrip(reconnect)', 'await roundTrip(oldReconnect)',
    'direct.prepareManagedRoute(page, { clientConfig, active: oldRoute.active',
    'direct.prepareManagedRoute(page, { clientConfig, active: newRoute.active',
    'direct.migrateExistingClaude(page', 'direct.assertMigrationEvidence', 'direct.assertSettingsView',
    'report.resourceFailure = error.resourceDiagnostic', "phase: 'after-automatic-root', attempts: 1",
    'report.manualCapabilityRetention', 'report.fixtureEvidencePreservedAfterCleanup = true',
    'report.policyRestored = true', "if (sentinel?.exitCode === null)",
    "assert.deepEqual(report.pageErrors || [], [])"]) assert.ok(source.includes(gate), gate);
  assert.equal((source.match(/spawn\(hub,/g) || []).length, 2, 'Only baseline and explicitly separated normal restart may spawn');
  assert.ok(source.indexOf('await observeAutomaticSuccessor(') < source.indexOf('report.beforeNormalRestart = rootRecord'));
  assert.ok(source.indexOf('report.normalRestartPreserved = true') < source.indexOf('passed: true, nativeUpdateAccepted: true'));
  assert.ok(source.includes("command: newRoute.command")); assert.ok(source.includes("command: oldRoute.command"));
});