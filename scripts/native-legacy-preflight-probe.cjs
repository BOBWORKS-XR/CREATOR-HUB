const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PUBLIC_INSTALLER = Object.freeze({
  asset: 'Creator.Works.MCP_2.7.7_x64-setup.exe', bytes: 27059109,
  sha256: 'fa0b0ebc39043bf276de73763d380c001c84d1efd24dca9f9c2427b120a5afe0',
  release: 'https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases/tag/v2.7.7',
});
const RECEIPT_LIMIT = 256 * 1024;
const MODES = Object.freeze(['first-dialog-cancel', 'silent-observe']);

function admission(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32', 'Disposable native Windows runner required');
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    CREATOR_LEGACY_PREFLIGHT_PROBE: '1' })) {
    assert.equal(env[key], value, 'Explicit disposable legacy-probe admission required');
  }
}

function ordinary(file, limit) {
  for (let part = path.resolve(file);; part = path.dirname(part)) {
    assert.equal(fs.lstatSync(part).isSymbolicLink(), false, 'Redirected diagnostic path refused');
    if (path.dirname(part) === part) break;
  }
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= limit, 'Ordinary bounded diagnostic file required');
  return stat;
}

function keys(value, expected) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), expected.split(' ').sort(), 'Unexpected diagnostic fields');
}
function string(value, limit = 4096) {
  assert.ok(typeof value === 'string' && value.length <= limit && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value));
}
function pid(value) { assert.ok(Number.isInteger(value) && value > 0 && value <= 0xffffffff); }

function dialog(value, installerPid) {
  keys(value, 'title handle class processId controls');
  string(value.title); assert.equal(value.class, '#32770'); assert.equal(value.processId, installerPid);
  assert.ok(Number.isSafeInteger(value.handle) && value.handle > 0);
  assert.ok(Array.isArray(value.controls) && value.controls.length <= 128);
  let total = value.title.length;
  for (const control of value.controls) {
    keys(control, 'name id type processId');
    string(control.name, 8192); string(control.id, 128); string(control.type, 128);
    assert.equal(control.processId, installerPid); total += control.name.length;
  }
  assert.ok(total <= 32768, 'Dialog exceeds its capture bound');
}

function validateReceipt(bytes, mode = 'first-dialog-cancel') {
  assert.ok(MODES.includes(mode), 'Fixed diagnostic mode required');
  assert.ok(Buffer.isBuffer(bytes) && bytes.length <= RECEIPT_LIMIT);
  const report = JSON.parse(bytes.toString('utf8'));
  keys(report, 'scope mode nativeInstallDirectory freshNamespaceVerified installerSha256 installerBytes installerPid installerStart installerIs64Bit firstDialog laterDialogs classification powerShellChildren observerError cancelPosted confirmationPosted installerExited installerExitCode defaultDirectoryAbsent uninstallRegistrationAbsent productRegistrationAbsent installerBytesUnchanged error originalNsExecReturnCaptured originalPowerShellModulesCaptured installerRerun processesKilled installAccepted releaseReady');
  assert.equal(report.mode, mode);
  assert.equal(report.scope, mode === 'silent-observe'
    ? 'unchanged-public-277-silent-observation-only' : 'unchanged-public-277-first-dialog-cancel-only');
  string(report.nativeInstallDirectory); assert.equal(report.freshNamespaceVerified, true);
  assert.ok(report.installerIs64Bit === null || typeof report.installerIs64Bit === 'boolean');
  assert.equal(report.installerSha256, PUBLIC_INSTALLER.sha256); assert.equal(report.installerBytes, PUBLIC_INSTALLER.bytes);
  if (report.installerPid !== null) pid(report.installerPid);
  if (report.installerStart !== null) string(report.installerStart, 64);
  if (report.firstDialog !== null) dialog(report.firstDialog, report.installerPid);
  assert.ok(Array.isArray(report.laterDialogs) && report.laterDialogs.length <= 4);
  for (const value of report.laterDialogs) dialog(value, report.installerPid);
  assert.ok(['preflight-busy', 'preflight-unavailable', 'installer-page', 'unrecognized-dialog', 'not-observed',
    'silent-exited', 'silent-not-exited'].includes(report.classification));
  assert.ok(Array.isArray(report.powerShellChildren) && report.powerShellChildren.length <= 8);
  for (const child of report.powerShellChildren) {
    keys(child, 'pid parentPid observedAt image imageSha256 is64Bit observationError stoppedAt exitStatus');
    pid(child.pid); assert.equal(child.parentPid, report.installerPid); string(child.observedAt, 64);
    if (child.image !== null) string(child.image);
    if (child.imageSha256 !== null) assert.match(child.imageSha256, /^[a-f0-9]{64}$/);
    assert.ok(child.is64Bit === null || typeof child.is64Bit === 'boolean');
    if (child.observationError !== null) string(child.observationError, 128);
    if (child.stoppedAt !== null) string(child.stoppedAt, 64);
    assert.ok(child.exitStatus === null || (Number.isInteger(child.exitStatus)
      && child.exitStatus >= 0 && child.exitStatus <= 0xffffffff));
    assert.equal(child.stoppedAt === null, child.exitStatus === null);
  }
  for (const field of ['observerError', 'error']) {
    if (report[field] !== null) {
      keys(report[field], 'type hresult'); string(report[field].type, 256);
      assert.ok(Number.isInteger(report[field].hresult));
    }
  }
  for (const field of ['cancelPosted', 'confirmationPosted', 'installerExited', 'defaultDirectoryAbsent',
    'uninstallRegistrationAbsent', 'productRegistrationAbsent', 'installerBytesUnchanged']) assert.equal(typeof report[field], 'boolean');
  assert.ok(report.installerExitCode === null || Number.isInteger(report.installerExitCode));
  for (const field of ['originalNsExecReturnCaptured', 'originalPowerShellModulesCaptured', 'installerRerun',
    'processesKilled', 'installAccepted', 'releaseReady']) assert.equal(report[field], false);
  // A diagnostic success is only captured evidence plus verified cancellation, never installation acceptance.
  const cancelObserved = report.firstDialog?.controls.filter(control => control.type === 'ControlType.Button'
    && control.id === '2' && control.name.replaceAll('&', '').trim() === 'Cancel').length === 1;
  assert.equal(report.installerExited, report.installerExitCode !== null);
  const intact = report.installerBytesUnchanged && report.error === null && report.observerError === null;
  const capturedAndCancelled = mode === 'first-dialog-cancel' && cancelObserved && report.cancelPosted && report.installerExited
    && report.defaultDirectoryAbsent && report.uninstallRegistrationAbsent && report.productRegistrationAbsent && intact;
  if (mode === 'silent-observe') {
    assert.equal(report.cancelPosted, false); assert.equal(report.confirmationPosted, false);
  }
  // Exit 10 is useful diagnostic evidence, not a passing install or an inferred nsExec result.
  const silentExitObserved = mode === 'silent-observe' && report.installerExited && intact;
  return { report, capturedAndCancelled, silentExitObserved, observationComplete: capturedAndCancelled || silentExitObserved };
}

async function probe(installer, mode = 'first-dialog-cancel') {
  admission();
  assert.ok(MODES.includes(mode), 'Fixed diagnostic mode required');
  const artifacts = fs.realpathSync(path.resolve(__dirname, '../artifacts'));
  installer = path.resolve(installer);
  const relative = path.relative(artifacts, installer);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Installer must be in owned artifacts');
  assert.equal(path.basename(installer), PUBLIC_INSTALLER.asset);
  assert.equal(ordinary(installer, PUBLIC_INSTALLER.bytes).size, PUBLIC_INSTALLER.bytes);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex'), PUBLIC_INSTALLER.sha256);
  const out = fs.mkdtempSync(path.join(artifacts, 'legacy-preflight-'));
  const program = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'native-legacy-preflight-probe.ps1'), '-Installer', installer, '-OutputDirectory', out, '-Mode', mode];
  const worker = spawn(program, args, { windowsHide: true, stdio: 'ignore' });
  const result = await new Promise(resolve => {
    const timer = setTimeout(() => { worker.unref(); resolve({ workerExitCode: null, workerObservationExpired: true }); },
      mode === 'silent-observe' ? 195000 : 45000);
    worker.once('error', () => { clearTimeout(timer); resolve({ workerExitCode: null, workerObservationExpired: false }); });
    worker.once('close', code => { clearTimeout(timer); resolve({ workerExitCode: code, workerObservationExpired: false }); });
  });
  const receipt = path.join(out, 'report.json');
  if (!fs.existsSync(receipt)) return { out, ...result, capturedAndCancelled: false, silentExitObserved: false,
    observationComplete: false, report: null };
  ordinary(receipt, RECEIPT_LIMIT);
  const validated = validateReceipt(fs.readFileSync(receipt), mode);
  const workerCompleted = result.workerExitCode === 0 && !result.workerObservationExpired;
  return { out, ...result, report: validated.report,
    capturedAndCancelled: validated.capturedAndCancelled && workerCompleted,
    silentExitObserved: validated.silentExitObserved && workerCompleted,
    observationComplete: validated.observationComplete && workerCompleted };
}

module.exports = { PUBLIC_INSTALLER, MODES, admission, validateReceipt, probe };
if (require.main === module) {
  probe(process.argv[2], process.argv[3]).then(result => {
    console.log(JSON.stringify({ output: result.out, capturedAndCancelled: result.capturedAndCancelled,
      silentExitObserved: result.silentExitObserved, installerExitCode: result.report?.installerExitCode ?? null,
      classification: result.report?.classification ?? 'no-receipt', workerObservationExpired: result.workerObservationExpired,
      releaseReady: false }));
    if (!result.observationComplete) process.exitCode = 1;
  }).catch(() => { console.error('Legacy probe refused or failed; no acceptance is claimed.'); process.exitCode = 1; });
}
