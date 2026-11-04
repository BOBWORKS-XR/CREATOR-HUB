'use strict';
// Fresh/guarded NSIS protocol only. No GUI, signing, migration or update/restart claim.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const contract = require('./windows-019-raw.cjs');


function registrations(execute) {
  return JSON.parse(execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$items=@();foreach($name in @('Creator Hub','Creator Works MCP','Creator Project Setup')) {$key='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$name;if(Test-Path -LiteralPath $key){$items+=@{name=$name;version=(Get-ItemProperty -LiteralPath $key -Name DisplayVersion).DisplayVersion}}};ConvertTo-Json -InputObject @($items) -Compress"],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 }));
}
function run(mode, directory, binding, output, env = process.env, execute = execFileSync, candidateContract = contract) {
  const contract = candidateContract;
  const BASELINE = mode === 'guarded' ? contract.baseline() : null;
  contract.assertRunner(env); assert.equal(env.CREATOR_WINDOWS_ARTIFACT_INSTALL, '1');
  assert.ok(['fresh', 'guarded'].includes(mode));
  contract.boundIdentity(binding);
  for (const folder of [directory, output, env.LOCALAPPDATA, env.APPDATA]) assert.ok(path.isAbsolute(folder), 'Absolute paths required');
  const receipt = contract.verifyCandidate(directory, binding.receiptSha256,
    { commit: env.SOURCE_COMMIT, manifestSha256: env.SOURCE_MANIFEST_SHA256 }, binding);
  const hubDir = path.join(env.LOCALAPPDATA, 'Creator Hub'), hub = path.join(hubDir, 'creator-hub.exe');
  for (const name of ['Creator Hub', 'Creator Works MCP', 'Creator Project Setup', 'CreatorHub', 'creator-hub', 'CreatorProjectSetup']) {
    assert.equal(fs.existsSync(path.join(env.LOCALAPPDATA, name)), false, 'Fresh disposable namespace required');
  }
  for (const name of ['creator-works-mcp', 'banter-mcp']) assert.equal(fs.existsSync(path.join(env.APPDATA, name)), false);
  assert.deepEqual(registrations(execute), [], 'Existing product registrations refused');
  assert.equal(fs.existsSync(output), false); fs.mkdirSync(output);
  const report = { passed: false, mode, scope: 'ci-exact-candidate-nsis-only', source: receipt.source, producer: receipt.producer,
    candidateReceiptSha256: binding.receiptSha256, installerSha256: receipt.files[contract.ASSET].sha256,
    executableSha256: receipt.files['creator-hub.exe'].sha256, from: mode === 'guarded' ? BASELINE : null,
    installerScope: mode === 'guarded' ? 'guarded-nsis-update-default-location-no-msi' : 'fresh-nsis-default-location',
    guardedInstallerAccepted: false, freshInstallAccepted: false, settingsPreserved: false,
    nativeGuiAccepted: false, signedUpdateAccepted: false, automaticRestartAccepted: false, migrationAccepted: false, releaseReady: false };
  const options = { env: contract.cleanEnvironment(env), windowsHide: true, timeout: 180000, stdio: 'pipe' };
  const installer = path.join(directory, contract.ASSET);
  try {
    const manifest = contract.manifest || contract.json(path.join(directory, 'builtin-manifest.json'));
    const extracted = contract.extractExpected ? contract.extractExpected(installer, path.join(output, 'expected'))
      : require('./installer-payload.cjs').extract(installer, path.join(output, 'expected'), path.join(directory, 'raw-creator-hub.exe'), manifest);
    assert.equal(contract.hash(contract.read(extracted, 512 * 1024 * 1024)), report.executableSha256);
    if (mode === 'guarded') {
      const baseline = path.join(output, 'public18.exe');
      execute('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--max-time', '180', '--output', baseline,
        `https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v${BASELINE.version}/${BASELINE.asset}`], options);
      assert.equal(contract.hash(contract.read(baseline, 512 * 1024 * 1024)), BASELINE.installer);
      execute(baseline, ['/S', '/NS'], options);
      assert.equal(contract.hash(contract.read(hub, 512 * 1024 * 1024)), BASELINE.exe);
      assert.deepEqual(registrations(execute), [{ name: 'Creator Hub', version: BASELINE.version }]);
    }
    const seeds = [
      [path.join(env.LOCALAPPDATA, 'CreatorHub/preferences/hub-preferences.json'), '{"schemaVersion":1,"preview":false,"autoDownload":false,"restoreHostedViews":true,"keep":"opaque"}\n'],
      [path.join(env.APPDATA, 'creator-works-mcp/launcher-config.json'), '{"channels":[],"auto_start":false,"future":{"keep":true}}\n'],
      [path.join(env.APPDATA, 'banter-mcp/launcher-config.json'), '{"channels":[],"auto_start":false,"legacy":"keep"}\r\n'],
      [path.join(env.LOCALAPPDATA, 'CreatorProjectSetup/editor-roots.json'), '[]\n'],
      ...(mode === 'guarded' ? [[path.join(hubDir, 'unmanaged-retention-sentinel.txt'), 'Keep installed unmanaged content\r\n']] : []),
    ];
    for (const [file, bytes] of seeds) {
      assert.equal(fs.existsSync(file), false, 'Never overwrite fixture data');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: 'wx' });
    }
    contract.verifyCandidate(directory, binding.receiptSha256, receipt.source, binding);
    execute(installer, mode === 'guarded' ? ['/UPDATE', '/S', '/NS'] : ['/S', '/NS'], options);
    assert.equal(contract.hash(contract.read(hub, 512 * 1024 * 1024)), report.executableSha256);
    require('./build-unified.cjs').verifyStage(path.join(hubDir, 'modules'), manifest);
    assert.deepEqual(registrations(execute), [{ name: 'Creator Hub', version: contract.VERSION }]);
    for (const [file, bytes] of seeds) assert.deepEqual(fs.readFileSync(file), Buffer.from(bytes));
    Object.assign(report, { passed: true, freshInstallAccepted: mode === 'fresh', guardedInstallerAccepted: mode === 'guarded', settingsPreserved: true });
  } catch (error) { report.error = String(error.message); process.exitCode = 1; }
  contract.write(path.join(output, 'installer-report.json'), report);
  console.log(JSON.stringify(report)); return report;
}
module.exports = { registrations, run };
if (require.main === module) {
  try {
    contract.assertRunner(); assert.equal(process.env.CREATOR_WINDOWS_ARTIFACT_INSTALL, '1');
    const [mode, directory, binding, output] = process.argv.slice(2); assert.equal(process.argv.length, 6);
    run(mode, path.resolve(directory), contract.json(binding), path.resolve(output));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
