// Disposable native NSIS protocol only; not signed updater or release acceptance.
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true'
  || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Windows'
  || process.env.GITHUB_REPOSITORY !== 'BOBWORKS-XR/CREATOR-HUB'
  || process.env.GITHUB_REF !== 'refs/heads/validation/windows-menu-merge-20261027'
  || process.env.CREATOR_WINDOWS_012_R2_GUARDED !== '1') {
  throw Error('Guarded012 R2 installation requires its explicit disposable GitHub-hosted Windows lane.');
}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const candidate = require('./windows-incoming-016.cjs');
const contract = require('./windows-012-r2-guarded-contract.cjs');
const { readBounded } = require('./read-bounded-input.cjs');
assert.equal(process.argv.length, 4, 'Supply exact R2 and public012 installers');
assert.ok(path.isAbsolute(process.argv[2]) && path.isAbsolute(process.argv[3]));
assert.match(process.env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
contract.checkBinding();
const target = candidate.installer(process.argv[2]);
const baseline = process.argv[3];
assert.equal(candidate.hash(readBounded(baseline, 512 * 1024 * 1024)), contract.BASELINE.installer);
const directory = path.join(process.env.LOCALAPPDATA, 'Creator Hub');
const executable = path.join(directory, 'creator-hub.exe');
const out = path.resolve('artifacts', `native-012-r2-guarded-${Date.now()}`);
fs.mkdirSync(out, { recursive: false });
const report = { passed: false, scope: 'public012-to-r2-guarded-nsis-only',
  installerScope: 'guarded-nsis-update-default-location-no-msi', from: contract.BASELINE,
  ...candidate.productProvenance(), testSource: process.env.GITHUB_SHA,
  guardedInstallerAccepted: false, migrationAccepted: false, signedUpdateAccepted: false,
  nativeGuiAccepted: false, minimumVersionQualified: false, releaseReady: false, userMachineUsed: false };
function registrations() {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$items=@();foreach($name in @('Creator Hub','Creator Works MCP','Creator Project Setup')) {$key='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$name;if(Test-Path -LiteralPath $key){$items+=@{name=$name;version=(Get-ItemProperty -LiteralPath $key -Name DisplayVersion).DisplayVersion}}};ConvertTo-Json -InputObject @($items) -Compress"],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 }));
}
try {
  assert.equal(fs.existsSync(directory), false, 'Fresh disposable Hub namespace required');
  assert.deepEqual(registrations(), [], 'Existing product registrations refused');
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SIGNING|CREDENTIAL|AUTHORIZATION|PROXY|^NODE_OPTIONS$|^NODE_TLS_|^NODE_EXTRA_CA_CERTS$/i.test(name)));
  execFileSync(baseline, ['/S', '/NS'], { env: environment, windowsHide: true, timeout: 180000, stdio: 'pipe' });
  assert.equal(candidate.hash(fs.readFileSync(executable)), contract.BASELINE.exe);
  assert.deepEqual(registrations(), [{ name: 'Creator Hub', version: contract.BASELINE.version }]);
  const bases = { hub: directory, local: process.env.LOCALAPPDATA, roaming: process.env.APPDATA };
  const files = contract.FIXTURES.map(item => ({ ...item, file: path.join(bases[item.base], item.relative) }));
  for (const { file, bytes } of files) {
    assert.equal(fs.existsSync(file), false, 'Never overwrite pre-existing fixture data');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: 'wx' });
  }
  execFileSync(target, ['/UPDATE', '/S', '/NS'], { env: environment, windowsHide: true, timeout: 180000, stdio: 'pipe' });
  assert.equal(candidate.hash(fs.readFileSync(executable)), contract.TARGET.exe);
  assert.deepEqual(registrations(), [{ name: 'Creator Hub', version: contract.TARGET.version }]);
  for (const { file, bytes } of files) assert.deepEqual(fs.readFileSync(file), Buffer.from(bytes));
  Object.assign(report, { passed: true, guardedInstallerAccepted: true, settingsPreserved: true,
    retainedFiles: files.map(({ id, bytes }) => ({ id, sha256: candidate.hash(Buffer.from(bytes)) })),
    installerSha256: contract.TARGET.installer, executableSha256: contract.TARGET.exe });
  contract.checkReceipt(report);
} catch (error) { report.passed = false; report.error = String(error); process.exitCode = 1; }
fs.writeFileSync(path.join(out, 'guarded-012-r2-report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ out, ...report }));
