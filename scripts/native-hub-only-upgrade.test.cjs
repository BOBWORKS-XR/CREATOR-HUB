const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./native-hub-only-upgrade.cjs');
test('hub-only contract refuses all missing/foreign context before inspection', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REF: 'refs/heads/validation/convergence-014', CREATOR_HUB_ONLY_UPGRADE_TEST: '1' };
  h.admission(env, 'win32');
  for (const key of Object.keys(env)) assert.throws(() => h.admission({ ...env, [key]: 'foreign' }, 'win32'));
  assert.throws(() => h.admission(env, 'linux'));
  const result = spawnSync(process.execPath, [path.join(__dirname, 'native-hub-only-upgrade.cjs'), 'do-not-inspect'],
    { env: { ...process.env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
});
test('only independently reviewed B05 artifacts pass and scope never supplies migration/update acceptance', () => {
  h.artifact('284820f92de487e8a0f1bb5b3b99cafe5e073f0402a9350a2ea6e76fa9543157',
    'cd5e3fd2829727d06444c0f3266b178798d1b55c63df651be12eb38ac4523a86');
  assert.equal(h.CANDIDATE_SOURCE, 'db862739d01088ba9be335d0522f8f129222a48b');
  assert.throws(() => h.artifact('a'.repeat(64), h.EXECUTABLE));
  assert.throws(() => h.artifact(h.INSTALLER, 'b'.repeat(64)));
  assert.throws(() => h.artifact(h.INSTALLER, 'cb09ca8249869315fc250bce2bb00933b93f7516054dbef3f85da94b37096e3f'),
    'The raw pre-NSIS EXE is not the installed image');
  const source = fs.readFileSync(path.join(__dirname, 'native-hub-only-upgrade.cjs'), 'utf8');
  for (const flag of ['migrationAccepted', 'signedInAppUpdateAccepted', 'nativeGuiAccepted', 'liveAiAppAccepted', 'releaseReady']) assert.ok(source.includes(`${flag}: false`));
  assert.ok(source.indexOf('admission(); requireDisposable();') < source.indexOf('candidate = path.resolve'));
  assert.ok(source.includes("['/UPDATE', '/S', '/NS']"));
  assert.ok(source.includes('candidateSourceRevision: CANDIDATE_SOURCE'));
  assert.doesNotMatch(source, /\.kill\(|taskkill|Stop-Process|auth\.json|signer.*sign/);
});

test('convergence B05 archive/source pins and original three lanes stay coupled to hub-only provenance', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/native-convergence-014.yml'), 'utf8');
  assert.ok(workflow.includes("'unified-windows-b05-db86273-20261015.zip'"));
  assert.match(workflow, /\$assets\[0\]\.id -ne 642095693/);
  assert.match(workflow, /\$assets\[0\]\.size -ne 86746913/);
  assert.match(workflow, /\$assets\[0\]\.state -ne 'uploaded'/);
  const archive = 'd18872d804196c4606f9908597c8fd0587ab769d9cbcd701edd490b757bbe3a2';
  assert.equal(workflow.split(archive).length - 1, 3, 'API digest, downloaded ZIP and lane ZIP must share one exact pin');
  assert.ok(workflow.includes(`$proof.sourceRevision -ne '${h.CANDIDATE_SOURCE}'`));
  assert.ok(workflow.includes("lane: [upgrade-guide, fresh-components, hub-only-upgrade]"));
  for (const literal of ["branches: [validation/convergence-014]", "releases/411494394", "'v0.1.13-validation'",
    "$proof.version -ne '0.1.14'", '$proof.acceptanceOnly -ne $true', '$proof.releaseReady -ne $false',
    '$proof.privateKeyIncluded -ne $false', 'CREATOR_CANDIDATE_SOURCE=$($proof.sourceRevision)',
    'native-convergence-smoke.cjs artifacts/convergence-input/candidate',
    'native-builtin-smoke.cjs artifacts/convergence-input/candidate fresh',
    'native-hub-only-upgrade.cjs artifacts/convergence-input/candidate']) assert.ok(workflow.includes(literal), literal);
  const source = fs.readFileSync(path.join(__dirname, 'native-hub-only-upgrade.cjs'), 'utf8');
  assert.ok(source.includes("baseline.version, '0.1.12'"));
  assert.ok(source.includes("'gh', ['release', 'download', 'v0.1.12'"));
  assert.equal(require('./self-update-baselines.cjs').selectBaseline('0.1.14').installer,
    '0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18');
});
