'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const r5 = require('./windows-r5-raw.cjs');
const legacy = require('./windows-artifact-candidate.cjs');
const sha = name => legacy.hash(Buffer.from(`SYNTHETIC TEST ONLY: ${name}`));
function fixture() {
  const files = Object.fromEntries(r5.MODULE_FILES.map(name => [name, sha(name)]));
  const manifest = { schemaVersion: 1, platform: 'windows', arch: 'x86_64', modules: {
    mcp: { version: '2.7.7', files: Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith('mcp/'))) },
    setup: { version: '0.3.7', files: Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith('setup/'))) } },
    managedRouting: { protocol: 1, files: Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith('routing/'))) } };
  const value = { schemaVersion: 1, enabled: true, version: '0.1.17', outgoingFixtureVersion: '0.1.18', source: { ...r5.SOURCE },
    installer: { bytes: 12, sha256: sha('installer') }, executable: { bytes: 13, sha256: sha('exe') },
    manifest: { bytes: 123, sha256: sha('raw manifest'), sha256Canonical: legacy.hash(Buffer.from(JSON.stringify(manifest))), document: manifest },
    buildResultSha256: sha('build result'), buildInputsSha256: sha('build inputs') };
  return value;
}
const runner = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'install',
  GITHUB_REF: 'refs/heads/validation/windows-menu-merge-20261027',
  GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${r5.WORKFLOW}@refs/heads/validation/windows-menu-merge-20261027`,
  CREATOR_WINDOWS_R5_RAW_INSTALL: '1', CREATOR_WINDOWS_ARTIFACT_INSTALL: '1', GITHUB_SHA: 'a'.repeat(40), EXPECTED_HARNESS_COMMIT: 'a'.repeat(40) });
test('unpopulated R5 pins refuse; no R4 binary fallback exists', () => {
  assert.throws(() => r5.validatePins({ ...r5.pinned, enabled: false }), /not populated/);
  assert.throws(() => r5.createAdapter({ ...r5.pinned, enabled: false }), /not populated/);
  assert.equal(r5.pinned.source.commit, '086892de8e65f1c36711da1661224a4d0ff18946');
  assert.equal(r5.pinned.version, '0.1.17'); assert.equal(r5.pinned.outgoingFixtureVersion, '0.1.18');
  if (!r5.pinned.enabled) assert.equal(r5.pinned.installer.sha256, null);
  else r5.validatePins(r5.pinned);
});
test('finite source/version contract refuses 16, wrong tree and missing module pins', () => {
  r5.validatePins(fixture());
  for (const mutate of [v => v.version = '0.1.16', v => v.outgoingFixtureVersion = '0.1.17',
    v => v.source.commit = 'f262a5a06d19a1af327eb081f7c740971187b315', v => v.source.tree = 'a'.repeat(40),
    v => v.installer.sha256 = null, v => v.buildResultSha256 = '0'.repeat(64), v => v.manifest.sha256Canonical = sha('bad')]) {
    const value = fixture(); mutate(value); assert.throws(() => r5.validatePins(value));
  }
});
test('all fifteen module names and versions stay exact', () => {
  for (const mutate of [m => delete m.modules.mcp.files['mcp/server/creator-works-mcp.mjs'],
    m => m.managedRouting.files['routing/extra.exe'] = sha('extra'), m => m.modules.mcp.version = '2.7.8']) {
    const value = fixture(); mutate(value.manifest.document); value.manifest.sha256Canonical = legacy.hash(Buffer.from(JSON.stringify(value.manifest.document)));
    assert.throws(() => r5.validatePins(value));
  }
});
test('native admission requires the exact reviewed manual Windows context', () => {
  r5.assertRunner(runner(), 'win32');
  for (const key of Object.keys(runner())) assert.throws(() => r5.assertRunner({ ...runner(), [key]: 'wrong' }, 'win32'), key);
  assert.throws(() => r5.assertRunner(runner(), 'linux'));
  const result = spawnSync(process.execPath, [__filename.replace('.test.cjs', '.cjs'), 'fresh', 'MUST-NOT-READ'],
    { env: { ...process.env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 1); assert.doesNotMatch(result.stderr, /ENOENT|MUST-NOT-READ/);
});
test('private identity stays bound to the exact R5 installer and build receipt', () => {
  const value = fixture(), adapter = r5.createAdapter(value);
  const input = { schemaVersion: 1, releaseId: 123, releaseTag: 'lab-r5', assetId: 456, assetName: 'Creator.Hub_0.1.17_x64-r5-setup.exe',
    bytes: value.installer.bytes, sha256: value.installer.sha256, receiptSha256: value.buildResultSha256 };
  adapter.boundIdentity(input); assert.equal(adapter.ASSET, 'Creator.Hub_0.1.17_x64-setup.exe');
  assert.equal(adapter.VERSION, '0.1.17');
  for (const mutate of [v => v.assetId = 0, v => v.assetName = '../escape', v => v.bytes++, v => v.sha256 = sha('stale'), v => v.receiptSha256 = sha('old receipt')]) {
    const copy = { ...input }; mutate(copy); assert.throws(() => adapter.boundIdentity(copy));
  }
});
test('old installer defaults and exit checks are retained with the explicit R5 adapter', () => {
  const source = fs.readFileSync(path.join(__dirname, 'windows-artifact-install.cjs'), 'utf8');
  for (const token of ['candidateContract = contract', 'contract.extractExpected ?', "['/UPDATE', '/S', '/NS']", "['/S', '/NS']",
    'BASELINE.installer', 'BASELINE.exe', "'Fresh disposable namespace required'", "'Never overwrite fixture data'"]) assert.ok(source.includes(token), token);
  assert.doesNotMatch(source, /taskkill|Stop-Process|exitCode\s*===?\s*10/);
});
test('extraction pins the actual Hub, embedded preflight and all module files', () => {
  const source = fs.readFileSync(__filename.replace('.test.cjs', '.cjs'), 'utf8');
  for (const token of ["'$PLUGINSDIR/creator-hub-preflight.exe'", 'value.executable', 'Object.keys(files).sort()', 'for (const [name, expected] of Object.entries(files))']) assert.ok(source.includes(token));
  assert.ok(source.indexOf('inspect.record(installer)') < source.indexOf("execute(sevenZip"));
});
test('native jobs are dispatch-only; path-limited push runs only preflight', () => {
  const source = fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-r5-raw-installer.yml'), 'utf8');
  for (const value of ['workflow_dispatch:', 'mode: [fresh, guarded]', 'runs-on: windows-latest', 'windows-r5-raw.cjs preflight',
    'draft -ne $true', 'prerelease -ne $true', "state -cne 'uploaded'", 'digest -cne', 'no clobber', 'persist-credentials: false']) assert.ok(source.includes(value));
  assert.ok(source.indexOf('windows-r5-raw.cjs preflight') < source.indexOf('Invoke-RestMethod'));
  assert.match(source, /install:\s+needs: preflight\s+if: [^\n]+github\.event_name == 'workflow_dispatch'/);
  assert.match(source, /push:\s+branches: \[validation\/windows-menu-merge-20261027\]\s+paths:/);
  assert.doesNotMatch(source, /ubuntu|macos|secrets\.|SkipCertificateCheck|cargo |release-descriptor|Invoke-Expression|-Method (?:Post|Patch|Put|Delete)/);
});
