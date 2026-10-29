'use strict';
// Pure transport contracts; optional retained signed bytes are read, never run.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const lab = require('./linux-update-lab-feed.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const current = () => ({
  GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512',
  GITHUB_REF: 'refs/heads/validation/native-linux-journal-production-016', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/native-linux-production-016-migration.yml@refs/heads/validation/native-linux-journal-production-016',
  GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', RUNNER_TEMP: path.resolve(os.tmpdir()),
  CREATOR_NATIVE_LINUX_PRODUCTION_016: '1', CREATOR_MIGRATION_016_EXECUTE: 'true',
  CREATOR_MIGRATION_016_SCENARIO: 'migration-approve', CREATOR_MIGRATED_UPDATE_EXECUTE: 'true',
  UPDATE_EXECUTE: 'true', UPDATE_SCENARIO: 'deb-approve',
  UPDATE_PROFILE_SHA256: 'ef2b5a589d934bf48306ddfd53d133513f3ab4d22b9622672f76887cb7acb095',
  CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256: 'b'.repeat(64),
});

test('changed MCP has one exact profile and four actual delivery body pins, without mutating the historical target', () => {
  assert.equal(lab.CHANGED_MCP_PROFILE_SHA256, current().UPDATE_PROFILE_SHA256);
  assert.equal(lab.CHANGED_MCP_IMAGE_SHA256, '822e46106d5caaf36890965d3020fb49b2235e91517eb33bd5d2f4210d5b5690');
  assert.deepEqual(lab.CHANGED_MCP_FILES, {
    'deb17/creator-hub-linux-x86_64-deb.json': { size: 514, sha256: 'c2862a4b6c0c9d7d3dccc232079bf4436c0d8695e8a88ed8a3bccf6dad04a16c' },
    'deb17/creator-hub-linux-x86_64-deb.json.minisig': { size: 311, sha256: '24f9e75cbea3b8afcfa59df70ee0ff595ef21b93a9efb2313de223788f91b885' },
    'deb17/Creator_Hub_0.1.17_amd64-acceptance-only.deb': { size: 64519358, sha256: '61a32fe588280366c3d6f8b76323764867bca8c3537d30a45c33ed2302be4a43' },
    'deb17/latest.json': { size: 751, sha256: '3e9362038eeb37cdac6f0caae08a0b7d8b4124e8dbb210de5f62a81f988742ef' },
  });
  assert.ok(Object.isFrozen(lab.CHANGED_MCP_FILES));
  assert.ok(Object.values(lab.CHANGED_MCP_FILES).every(Object.isFrozen));
  assert.equal(lab.UPDATE_DEB.sha256, 'f58801c95e6932266a897a7b139c6ad3cf4fdfb22ea518398f3a91ed3829ed54');
  assert.equal(lab.UPDATE_SOURCE17.commit, '75a99ff4a267064aaa3ac9e30039bc91dc791d89');
});

test('changed MCP fixed runner admits only the separately bound migrated approval and exact fixture UID', () => {
  const env = current(), before = structuredClone(env);
  lab.assertChangedMcpRunner(env, 'linux', 'x64', 21314, 21314);
  assert.deepEqual(env, before);
  assert.throws(() => lab.assertUpdateRunner('deb', env, 'linux', 'x64', 21314, 21314));
  assert.throws(() => lab.assertUpdateRunner('deb', env, 'linux', 'x64', 21314, 21314, true));
  lab.assertUpdateRunner('deb', { ...env,
    GITHUB_REF: 'refs/heads/validation/native-linux-production-016',
    GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/native-linux-production-016-migration.yml@refs/heads/validation/native-linux-production-016',
    UPDATE_PROFILE_SHA256: '808f83a6cdc14a2d49000a2c9cd340397a748e166dfdb29720fe4af07ff91e66',
  }, 'linux', 'x64', 21314, 21314, true);
  for (const sha of ['808f83a6cdc14a2d49000a2c9cd340397a748e166dfdb29720fe4af07ff91e66',
    '02aeb5653fcd0dde0576907b7f480b895ea8c3e509cf2954ad2944ee8ef78fcb', '0'.repeat(64), 'UNBOUND']) {
    assert.throws(() => lab.assertChangedMcpRunner({ ...env, UPDATE_PROFILE_SHA256: sha }, 'linux', 'x64', 21314, 21314));
  }
});

test('fresh profile and feed pins agree while historical and mixed routes refuse', () => {
  const lane = require('./native-linux-changed-mcp-input.cjs');
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures/native-linux-changed-mcp-profile.json'));
  const profile = lane.profile(raw), delivery = profile.deliveries.signedDeb17.files;
  assert.equal(lane.PROFILE_SHA, lab.CHANGED_MCP_PROFILE_SHA256);
  for (const name of ['creator-hub-linux-x86_64-deb.json', 'creator-hub-linux-x86_64-deb.json.minisig',
    'Creator_Hub_0.1.17_amd64-acceptance-only.deb', 'latest.json']) {
    assert.deepEqual(lab.CHANGED_MCP_FILES['deb17/' + name], delivery[name]);
  }
  const oldRef = 'refs/heads/validation/native-linux-production-016';
  const oldWorkflow = 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/native-linux-production-016-migration.yml@' + oldRef;
  const oldHash = '1fd56c76f100422e2c380e19cfc5dfb9da4ecf05a6348efdba99bbaebb5cd792';
  for (const change of [{GITHUB_REF: oldRef, GITHUB_WORKFLOW_REF: oldWorkflow}, {UPDATE_PROFILE_SHA256: oldHash},
    {GITHUB_REF: oldRef, GITHUB_WORKFLOW_REF: oldWorkflow, UPDATE_PROFILE_SHA256: oldHash}]) {
    assert.throws(() => lab.assertChangedMcpRunner({...current(), ...change}, 'linux', 'x64', 21314, 21314));
  }
});

test('changed MCP retains manual source, workflow, opt-in, identity and inherited-injection refusals', () => {
  for (const [name, value] of [
    ['GITHUB_REF', lab.UPDATE_BRANCH], ['GITHUB_WORKFLOW_REF', 'foreign'], ['GITHUB_EVENT_NAME', 'push'],
    ['GITHUB_REPOSITORY_ID', '1'], ['GITHUB_SHA', 'short'], ['GITHUB_RUN_ID', '0'], ['GITHUB_RUN_ATTEMPT', '0'],
    ['UPDATE_SCENARIO', 'deb-auth-cancel'], ['UPDATE_EXECUTE', 'false'], ['CREATOR_MIGRATED_UPDATE_EXECUTE', 'false'],
    ['CREATOR_NATIVE_LINUX_PRODUCTION_016', '0'], ['CREATOR_MIGRATION_016_EXECUTE', 'false'],
    ['CREATOR_MIGRATION_016_SCENARIO', 'migration-guide-cancel'], ['CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256', 'UNBOUND'],
    ['FLATPAK_ID', 'app'], ['NODE_OPTIONS', '--inspect'], ['HTTP_PROXY', 'http://host'],
    ['SSL_CERT_FILE', '/other'], ['CREATOR_HUB_SIGNING_KEY', '/never-read'],
  ]) assert.throws(() => lab.assertChangedMcpRunner({ ...current(), [name]: value }, 'linux', 'x64', 21314, 21314), undefined, name);
  for (const args of [['win32', 'x64', 21314, 21314], ['linux', 'arm64', 21314, 21314],
    ['linux', 'x64', 0, 0], ['linux', 'x64', 1001, 1001], ['linux', 'x64', 21314, 0]]) {
    assert.throws(() => lab.assertChangedMcpRunner(current(), ...args));
  }
});

test('changed MCP refusal precedes TLS option access and relative loader input access', async () => {
  let read = false;
  const options = new Proxy({}, { get() { read = true; throw Error('TLS read must not occur'); } });
  await assert.rejects(lab.startChangedMcpProxy({}, options, { ...current(), UPDATE_EXECUTE: 'false' }),
    error => !error.message.includes('TLS read must not occur'));
  assert.equal(read, false);
  assert.throws(() => lab.loadChangedMcp016017('relative'));
});

test('changed MCP cannot adopt forged, historical-shaped or portable contracts', () => {
  assert.throws(() => lab.reviewedChangedMcpTarget({ mode: 'deb', profile: '016-deb-to-private017',
    pins: lab.CHANGED_MCP_FILES, executableSha256: lab.CHANGED_MCP_IMAGE_SHA256 }));
  assert.throws(() => lab.reviewedChangedMcpTarget({ mode: 'portable', profile: '016-portable-to-private017' }));
});

test('changed MCP retained actual four bodies pass only the new fixed target and retain the same five routes', t => {
  const folder = process.env.CREATOR_CHANGED_MCP_TRANSPORT_TEST_INPUTS;
  if (!folder) { t.skip('Retained actual signed input directory not supplied; no download or native claim'); return; }
  const input = Object.fromEntries(Object.keys(lab.CHANGED_MCP_FILES).map(name => [name,
    fs.readFileSync(path.join(folder, path.basename(name)))]));
  const config = { schemaVersion: 1, mode: 'deb', fromVersion: '0.1.16', targetVersion: '0.1.17',
    files: structuredClone(lab.CHANGED_MCP_FILES) };
  const contract = lab.createUpdate016017(config, input);
  lab.reviewedChangedMcpTarget(contract);
  assert.throws(() => lab.reviewedUpdateTarget(contract));
  assert.equal(contract.routes.length, 5);
  assert.deepEqual(contract.routes.map(r => [r.host, r.path]), [
    ['api.github.com', '/repos/BOBWORKS-XR/CREATOR-HUB/releases?per_page=10'],
    ...Object.keys(lab.CHANGED_MCP_FILES).map(name => ['github.com',
      '/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.17/' + path.basename(name)]),
  ]);
  const report = lab.changedMcpReport(contract, lab.labReport(contract, {
    connections: 0, requests: 0, receivedBytes: 0, servedBytes: 0, rejected: 0, closeReason: null, served: new Map(),
  }));
  assert.equal(report.publicDiscovery, false); assert.equal(report.releaseReady, false);
  assert.equal(report.signaturesVerifiedByHarness, false);
  const changed = structuredClone(config), modified = { ...input };
  const latest = JSON.parse(input['deb17/latest.json']); latest.notes += ' changed';
  modified['deb17/latest.json'] = canonical(latest);
  changed.files['deb17/latest.json'] = { size: modified['deb17/latest.json'].length, sha256: hash(modified['deb17/latest.json']) };
  assert.throws(() => lab.reviewedChangedMcpTarget(lab.createUpdate016017(changed, modified)));
});

test('changed MCP CLI on a local process refuses before filesystem or control input', () => {
  for (const op of ['update-changed-mcp-016-017', 'update-changed-mcp-016-017-inspect']) {
    const result = spawnSync(process.execPath, [require.resolve('./linux-update-lab-feed.cjs'), op, 'deb', '/not-an-owned-transport'],
      { env: { ...current(), UPDATE_EXECUTE: 'false' }, encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /Linux lab transport refused or failed/);
  }
});

test('changed MCP additive layer inverses to every exact frozen1ab helper byte and keeps deadlines unchanged', () => {
  let restored = fs.readFileSync(require.resolve('./linux-update-lab-feed.cjs'), 'utf8');
  for (const [begin, end] of [
    ['// BEGIN fixed changed-MCP transport data; historical tuples remain unchanged.\n', '// END fixed changed-MCP transport data.\n'],
    ['// BEGIN fixed changed-MCP transport entrypoints; no historical function is replaced.\n', '// END fixed changed-MCP transport entrypoints.\n'],
    ['// BEGIN fixed changed-MCP exports.\n', '// END fixed changed-MCP exports.\n'],
  ]) {
    const at = restored.indexOf(begin), to = restored.indexOf(end, at);
    assert.ok(at >= 0 && to > at); assert.equal(restored.indexOf(begin, at + 1), -1);
    restored = restored.slice(0, at) + restored.slice(to + end.length);
  }
  const newDispatch = "if (require.main === module) (['update-changed-mcp-016-017', 'update-changed-mcp-016-017-inspect'].includes(process.argv[2]) ? changedMcpMain()\n  : ['update-016-017', 'update-016-017-inspect', 'update-migrated-016-017', 'update-migrated-016-017-inspect'].includes(process.argv[2]) ? updateMain()";
  const oldDispatch = "if (require.main === module) (['update-016-017', 'update-016-017-inspect', 'update-migrated-016-017', 'update-migrated-016-017-inspect'].includes(process.argv[2]) ? updateMain()";
  assert.equal(restored.split(newDispatch).length, 2);
  restored = restored.replace(newDispatch, oldDispatch);
  assert.equal(hash(Buffer.from(restored)), 'b5bc720f7fe3c0775adfcfa9f41713c71d10898aeee0bee9ae77dcb4798208e7');
  assert.equal(lab.LIMITS.handshakeMs, 10000); assert.equal(lab.LIMITS.durationMs, 600000);
  assert.equal(lab.LIMITS.connectionMs, 60000); assert.equal(lab.LIMITS.idleMs, 15000);
});
