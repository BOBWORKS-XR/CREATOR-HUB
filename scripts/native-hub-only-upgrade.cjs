// Real guarded NSIS contract only; no legacy-module migration or signed-update claim.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { requireDisposable, baselines } = require('./native-installed-baseline.cjs');
const { selectBaseline } = require('./self-update-baselines.cjs');
const INSTALLER = '7007a87c2818fa809382742fb41fc80ddacf6391d678759112196dd962d0955e';
const EXECUTABLE = '2782921b6bebcf6e811d1240a27d3d47f9c139269aaf6544ff0c6dff85a454ad';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hash = file => digest(fs.readFileSync(file));
function admission(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32');
  for (const [name, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REF: 'refs/heads/validation/convergence-014', CREATOR_HUB_ONLY_UPGRADE_TEST: '1' })) assert.equal(env[name], value);
}
function artifact(installer, executable) {
  assert.equal(installer, INSTALLER, 'Exact B04 installer required');
  assert.equal(executable, EXECUTABLE, 'Exact installed B04 image required');
}
function registry() {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "$items=@();foreach($name in @('Creator Hub','Creator Works MCP','Creator Project Setup')) {$key='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$name;if(Test-Path -LiteralPath $key){$items+=@{name=$name;version=(Get-ItemProperty -LiteralPath $key -Name DisplayVersion).DisplayVersion}}};ConvertTo-Json -InputObject @($items) -Compress"],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 }));
}
function main(candidate) {
  admission(); requireDisposable();
  candidate = path.resolve(candidate);
  const out = path.resolve('artifacts', `native-suite-${Date.now()}`);
  fs.mkdirSync(out, { recursive: true });
  const report = { scope: 'actual-public12-to-B04-guarded-nsis-hub-only-contract', checks: [], passed: false,
    sourceRevision: process.env.GITHUB_SHA, candidateSourceRevision: '7ab0a529b105cf9174f6b89b2f7073fae751633c',
    installerScope: 'guarded-nsis-update-default-location-no-msi',
    legacyInstallationsTested: false, migrationAccepted: false, signedInAppUpdateAccepted: false,
    nativeGuiAccepted: false, liveAiAppAccepted: false, releaseReady: false };
  try {
    const directory = path.join(process.env.LOCALAPPDATA, 'Creator Hub'), executable = path.join(directory, 'creator-hub.exe');
    assert.equal(fs.existsSync(directory), false, 'Fresh disposable Hub namespace required');
    assert.deepEqual(registry(), [], 'Existing product registration refused');
    const installer = path.join(candidate, 'installer.exe');
    assert.equal(hash(installer), INSTALLER);
    const baseline = baselines.find(item => item.repo === 'CREATOR-HUB');
    assert.equal(baseline.version, '0.1.12');
    const baselineDirectory = path.join(out, 'public12'); fs.mkdirSync(baselineDirectory);
    execFileSync('gh', ['release', 'download', 'v0.1.12', '--repo', 'BOBWORKS-XR/CREATOR-HUB',
      '--pattern', baseline.asset, '--dir', baselineDirectory], { windowsHide: true, timeout: 180000, stdio: 'pipe' });
    const original = path.join(baselineDirectory, baseline.asset);
    assert.equal(hash(original), baseline.sha256);
    execFileSync(original, ['/S'], { windowsHide: true, timeout: 180000, stdio: 'pipe' });
    assert.equal(hash(executable), selectBaseline('0.1.14').exe);
    assert.deepEqual(registry(), [{ name: 'Creator Hub', version: '0.1.12' }]);
    report.checks.push('Exact public0.1.12 installer installed its original image and registration');
    const files = [
      [path.join(directory, 'unmanaged-retention-sentinel.txt'), 'Keep unmanaged installed content'],
      [path.join(process.env.LOCALAPPDATA, 'CreatorHub/preferences/hub-preferences.json'), '{"previewChannel":false,"autoDownload":false,"restoreHostedViews":true,"unknown":"keep"}'],
      [path.join(process.env.APPDATA, 'creator-works-mcp/launcher-config.json'), '{"channels":[],"auto_start":false,"futureOption":{"keep":true}}'],
      [path.join(process.env.APPDATA, 'banter-mcp/launcher-config.json'), '{"channels":[],"auto_start":false,"futureLegacy":"keep"}'],
      [path.join(process.env.LOCALAPPDATA, 'CreatorProjectSetup/editor-roots.json'), JSON.stringify([path.join(out, 'saved-editor')])],
    ];
    for (const [file, value] of files) {
      assert.equal(fs.existsSync(file), false, 'Unknown existing data refused');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value, { flag: 'wx' });
    }
    execFileSync(installer, ['/UPDATE', '/S', '/NS'], { windowsHide: true, timeout: 180000, stdio: 'pipe' });
    artifact(hash(installer), hash(executable));
    assert.deepEqual(registry(), [{ name: 'Creator Hub', version: '0.1.14' }]);
    for (const [file, value] of files) assert.deepEqual(fs.readFileSync(file), Buffer.from(value));
    report.installerSha256 = hash(installer); report.installedHubSha256 = hash(executable);
    report.retainedImages = files.map(([file, value]) => ({ name: path.basename(file), sha256: digest(Buffer.from(value)) }));
    report.checks.push('Actual /UPDATE /S /NS upgrades Hub only and preserves exact MCP/legacy/Setup/preferences and unmanaged bytes');
    report.passed = true;
  } catch (error) { report.error = String(error); process.exitCode = 1; }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ scope: report.scope, passed: report.passed, checks: report.checks.length,
    error: report.error, report: path.join(out, 'report.json'), migrationAccepted: false, signedInAppUpdateAccepted: false, releaseReady: false }));
}
module.exports = { admission, artifact, INSTALLER, EXECUTABLE };
if (require.main === module) { try { main(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 1; } }
