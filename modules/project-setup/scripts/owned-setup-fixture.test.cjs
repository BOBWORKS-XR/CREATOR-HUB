const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('owned fixture survives closed stdin and exits only after its stop file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-owned-test-'));
  const stopFile = path.join(directory, 'stop');
  const child = spawn(process.execPath, [path.join(__dirname, 'owned-setup-fixture.cjs'), stopFile], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const [ready] = await once(child.stdout, 'data');
    assert.equal(ready.toString().trim(), 'fixture-ready');
    await new Promise(resolve => setTimeout(resolve, 750));
    assert.equal(child.exitCode, null);
    fs.writeFileSync(stopFile, 'exit');
    const [code, signal] = await closed;
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.equal(stderr, '');
  } finally {
    if (child.exitCode === null) { fs.writeFileSync(stopFile, 'exit'); await closed; }
    fs.rmSync(directory, { recursive: true });
  }
});

for (const environment of [
  {},
  { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_OS: 'Windows' },
  { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux' },
]) {
  test(`real installation refuses an unapproved environment: ${JSON.stringify(environment)}`, () => {
    const env = { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '', RUNNER_OS: '', ...environment };
    const result = spawnSync('pwsh', ['-NoProfile', '-File', path.join(__dirname, 'Test-InstalledCandidate.ps1'),
      '-CandidateDirectory', path.join(os.tmpdir(), 'must-not-be-resolved')], { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restricted to a disposable GitHub-hosted Windows runner/);
  });
}

test('candidate and public baseline pins have complete SHA-256 digests', () => {
  const pin = require('./installed-acceptance-pin.json');
  for (const key of ['installerSha256', 'executableSha256']) {
    assert.match(pin[key], /^[a-f0-9]{64}$/);
  }
  assert.match(pin.sourceRevision, /^[a-f0-9]{40}$/);
  assert.deepEqual(Object.keys(pin.baselines).sort(), ['0.2.2', '0.3.0', '0.3.0-alpha.1', '0.3.0-alpha.2', '0.3.0-alpha.6']);
  for (const [version, baseline] of Object.entries(pin.baselines)) {
    assert.equal(baseline.url, `https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/releases/download/v${version}/Creator-Project-Setup-${version}-Windows-setup.exe`);
    assert.match(baseline.installerSha256, /^[a-f0-9]{64}$/);
    assert.match(baseline.executableSha256, /^[a-f0-9]{64}$/);
  }
});
