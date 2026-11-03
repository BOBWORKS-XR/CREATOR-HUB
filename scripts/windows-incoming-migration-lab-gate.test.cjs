'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, 'native-self-update-lab.ps1'), 'utf8');
test('diagnostic start gate waits for identity and watchdog, preserving ordinary launch', async t => {
  const match = source.match(/\$driverBootstrap = @'\r?\n([\s\S]*?)\r?\n'@/); assert.ok(match);
  const sequence = ["Set-LabPhase 'driver-start'", '$driver.Start()', '$driverRecord = Get-LabProcessRecord $driver',
    "Set-LabPhase 'driver-register'", "if ($registered.kind -cne 'lab-process-registered')", '$driverRegistered = $true',
    "$driver.StandardInput.WriteLine('START')", '$driver.StandardInput.Close()'];
  let previous = -1;
  for (const item of sequence) { const next = source.indexOf(item, previous + 1); assert.ok(next > previous, item); previous = next; }
  assert.match(source, /if \(\$incomingMigration\) \{ \$driver\.StartInfo = New-LabStartInfo \$nodePath @\('-e', \$driverBootstrap, \$driverPath\)/);
  assert.match(source, /else \{ \$driver\.StartInfo = New-LabStartInfo \$nodePath @\(\$driverPath\)/);
  assert.match(source, /if \(\$incomingMigration -and \$driverStarted -and -not \$driverGateOpened\)[\s\S]*?\$driver\.StandardInput\.Close\(\)/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incoming-lab-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const driver = path.join(dir, 'driver.cjs'), marker = path.join(dir, 'loaded');
  fs.writeFileSync(driver, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');`);
  for (const input of ['', 'START', 'WRONG\n', 'START\nEXTRA']) {
    const result = spawnSync(process.execPath, ['-e', match[1], driver], { input, timeout: 5000, windowsHide: true });
    assert.notEqual(result.status, 0); assert.equal(fs.existsSync(marker), false, input);
  }
  for (const failure of ['identity-capture', 'watcher-registration']) {
    const proc = spawn(process.execPath, ['-e', match[1], driver], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(marker), false, failure);
    const exited = new Promise(resolve => proc.once('exit', resolve)); proc.stdin.end();
    assert.notEqual(await exited, 0); assert.equal(fs.existsSync(marker), false);
  }
  const timeoutBootstrap = match[1].replace('30000', '100');
  assert.notEqual(timeoutBootstrap, match[1]);
  const timed = spawn(process.execPath, ['-e', timeoutBootstrap, driver], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  const timedExit = await new Promise(resolve => timed.once('exit', resolve));
  assert.notEqual(timedExit, 0); assert.equal(fs.existsSync(marker), false);
  const approved = spawnSync(process.execPath, ['-e', match[1], driver], { input: 'START\r\n', timeout: 5000, windowsHide: true });
  assert.equal(approved.status, 0, approved.stderr.toString()); assert.equal(fs.readFileSync(marker, 'utf8'), 'loaded');
});

test('diagnostic cleanup refuses unknown Hub state and only accepts checked successful close', () => {
  assert.match(source, /if \(\$driverExitCode -ne 0\) \{ throw 'Driver did not succeed\.' \}[\s\S]*?\$driverReport = Get-Content/);
  assert.match(source, /\$closed\.state -cne 'verified'/);
  assert.match(source, /Hub process remains after close/);
  assert.match(source, /\$successorCleanupVerified = \$true/);
  assert.match(source, /\$hubCleanupState = if \(-not \$driverStarted\) \{ 'not-started' \} elseif \(\$successorCleanupVerified\) \{ 'verified' \} else \{ 'unknown' \}/);
  assert.match(source, /if \(\$hubCleanupUnknown\) \{ \$cleanupVerified = \$false \}/);
  assert.match(source, /if \(\$incomingMigration\) \{\s*\$result\['hubCleanupState'\]/);
});
