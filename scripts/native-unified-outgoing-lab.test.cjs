const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('both new PowerShell entrypoints refuse locally before any parameter/input/process/policy operations', { skip: process.platform !== 'win32' }, () => {
  for (const name of ['native-unified-outgoing-process.ps1', 'native-unified-outgoing-lab.ps1']) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, name)], {
      env: { ...process.env, GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_OS: 'Windows' },
      encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    assert.equal(result.error, undefined); assert.equal(result.status, 1);
    assert.equal(result.stdout, ''); assert.match(result.stderr, /disposable GitHub-hosted Windows runner required/);
  }
});
test('PowerShell parser accepts wrapper/read-only process recorder without executing either', { skip: process.platform !== 'win32' }, () => {
  for (const name of ['native-unified-outgoing-process.ps1', 'native-unified-outgoing-lab.ps1']) {
    const file = path.join(__dirname, name).replaceAll("'", "''");
    const script = `$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$tokens,[ref]$errors);if($errors.Count){$errors|ForEach-Object{$_.Message};exit 1}`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});
test('wrapper preserves the original lifecycle and cannot add TLS trust, relay or weaken baseline defaults', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-unified-outgoing-lab.ps1'), 'utf8');
  assert.ok(source.indexOf('GITHUB_ACTIONS') < source.indexOf('Get-Command'));
  assert.match(source, /Parameters.ContainsKey\('Scenario'\)/);
  assert.match(source, /exit \$LASTEXITCODE/);
  assert.doesNotMatch(source, /New-SelfSignedCertificate|certutil|Set-Item|Set-Content|Start-Process|HTTP_PROXY|CertificateValidation|NODE_TLS/);
  const original = fs.readFileSync(path.join(__dirname, 'native-self-update-lab.ps1'), 'utf8');
  assert.match(original, /0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18/);
  assert.match(original, /Unmodified public 0\.1\.12 baseline installer required/);
  assert.match(original, /Assert-LabRootAbsent/);
  assert.match(original, /Test-LabSystemTls/);
});
