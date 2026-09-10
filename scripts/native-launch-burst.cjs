// Windows-only cold-start acceptance. No installers, Unity operations or app mutations.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const executable = path.resolve(process.env.CREATOR_HUB_EXE || 'dist/Creator-Hub-Launch-Test/creator-hub.exe');
const output = path.resolve('artifacts', `launch-burst-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { executable, sha256: crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'), rounds: [] };
const owned = [];
function close(process) {
  if (process.exitCode !== null) return;
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/native-window.ps1'), '-TargetPid', String(process.pid), '-ExpectedExecutable', executable, '-Action', 'close'], { windowsHide: true, timeout: 15000, stdio: 'pipe' });
}
async function settle(processes) {
  for (let end = Date.now() + 45000; Date.now() < end;) {
    for (const process of processes) { try { close(process); } catch { /* Only the owned exact PID can be closed. */ } }
    await delay(1000);
    if (processes.every(process => process.exitCode !== null)) return;
  }
  throw Error('An owned test Hub did not close normally. Nothing was force-closed.');
}
(async () => {
  for (let round = 0; round < 3; round++) {
    const processes = [];
    for (let index = 0; index < 4; index++) {
      const args = index % 2 ? ['--open-app', 'mcp'] : ['--open-app', 'setup'];
      const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(output, `webview-${round}`) } });
      processes.push(child); owned.push(child);
    }
    await delay(6000);
    const running = processes.filter(process => process.exitCode === null);
    report.rounds.push({ round, pids: processes.map(process => process.pid), exitCodes: processes.map(process => process.exitCode), running: running.length });
    assert.equal(running.length, 1, 'Cold launch created more than one Hub, or routed to an unrelated running Hub.');
    assert.ok(processes.filter(process => process !== running[0]).every(process => process.exitCode === 0));
    await settle(processes);
  }
  report.passed = true;
})().catch(error => { report.passed = false; report.error = String(error.stack || error); process.exitCode = 1; }).finally(async () => {
  try { await settle(owned); } catch (error) { report.cleanup = String(error); process.exitCode = 1; }
  for (const child of owned) if (child.exitCode === null) child.unref();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }, null, 2));
});
