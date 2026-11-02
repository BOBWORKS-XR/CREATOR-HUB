// Real installer protocol only. Signing, migration and GUI operation are separate gates.
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true'
  || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Windows'
  || process.env.GITHUB_REPOSITORY !== 'BOBWORKS-XR/CREATOR-HUB'
  || process.env.GITHUB_REF !== 'refs/heads/validation/windows-menu-merge-20261027'
  || process.env.CREATOR_WINDOWS_016_GUARDED !== '1') {
  throw Error('Guarded16 installation requires its explicit disposable GitHub-hosted Windows lane.');
}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const candidate = require('./windows-incoming-016.cjs');
assert.equal(process.argv.length, 4, 'Supply exact target and staged public14 installers');
const target = candidate.installer(path.resolve(process.argv[2]));
const baseline = path.resolve(process.argv[3]);
assert.equal(candidate.hash(fs.readFileSync(baseline)), candidate.BASELINE.installer);
const directory = path.join(process.env.LOCALAPPDATA, 'Creator Hub');
const executable = path.join(directory, 'creator-hub.exe');
const out = path.resolve('artifacts', `native-016-guarded-${Date.now()}`);
fs.mkdirSync(out, { recursive: false });
const report = { passed: false, scope: 'exact-public14-to-direct16-guarded-nsis-only',
  installerScope: 'guarded-nsis-update-default-location-no-msi', from: candidate.BASELINE,
  ...candidate.productProvenance(), testSource: process.env.GITHUB_SHA,
  guardedInstallerAccepted: false, migrationAccepted: false, signedUpdateAccepted: false,
  nativeGuiAccepted: false, releaseReady: false };
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
  assert.equal(candidate.hash(fs.readFileSync(executable)), candidate.BASELINE.exe);
  assert.deepEqual(registrations(), [{ name: 'Creator Hub', version: candidate.BASELINE.version }]);
  const files = [
    [path.join(directory, 'unmanaged-retention-sentinel.txt'), 'Keep unmanaged installed content\r\n'],
    [path.join(process.env.LOCALAPPDATA, 'CreatorHub/preferences/hub-preferences.json'), '{"previewChannel":false,"autoDownload":false,"restoreHostedViews":true,"unknown":"keep"}\n'],
    [path.join(process.env.APPDATA, 'creator-works-mcp/launcher-config.json'), '{"channels":[],"auto_start":false,"futureOption":{"keep":true}}\n'],
    [path.join(process.env.APPDATA, 'banter-mcp/launcher-config.json'), '{"channels":[],"auto_start":false,"futureLegacy":"keep"}\r\n'],
    [path.join(process.env.LOCALAPPDATA, 'CreatorProjectSetup/editor-roots.json'), '[]\n'],
  ];
  for (const [file, bytes] of files) {
    assert.equal(fs.existsSync(file), false, 'Never overwrite pre-existing fixture data');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: 'wx' });
  }
  execFileSync(target, ['/UPDATE', '/S', '/NS'], { env: environment, windowsHide: true, timeout: 180000, stdio: 'pipe' });
  assert.equal(candidate.hash(fs.readFileSync(executable)), candidate.TARGET.exe);
  assert.deepEqual(registrations(), [{ name: 'Creator Hub', version: candidate.TARGET.version }]);
  for (const [file, bytes] of files) assert.deepEqual(fs.readFileSync(file), Buffer.from(bytes));
  Object.assign(report, { passed: true, guardedInstallerAccepted: true, settingsPreserved: true,
    retainedFiles: files.map(([file, bytes]) => ({ name: path.basename(file), sha256: candidate.hash(Buffer.from(bytes)) })),
    installerSha256: candidate.TARGET.installer, executableSha256: candidate.TARGET.exe });
  candidate.checkReceipt(report, 'guarded');
} catch (error) { report.passed = false; report.error = String(error); process.exitCode = 1; }
fs.writeFileSync(path.join(out, 'guarded-016-report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ out, ...report }));
