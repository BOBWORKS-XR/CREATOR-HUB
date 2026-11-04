'use strict';
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

function install(file, baseline, environment, report, out, original, options = {}) {
  const legacy = options.legacy || require('./native-installed-baseline.cjs');
  legacy.requireDisposable();
  assert.equal(typeof original, 'function');
  const run = options.run || execFileSync;
  const observation = { asset: baseline.asset, phase: 'before-original-installer',
    ownedHarness: { pid: process.pid, executablePath: process.execPath },
    pathKeys: Object.keys(environment).filter(name => /^path$/i.test(name)),
    psModulePath: { present: typeof environment.PSModulePath === 'string',
      sha256: typeof environment.PSModulePath === 'string' ? createHash('sha256').update(environment.PSModulePath).digest('hex') : null } };
  report.baselineObservations ||= []; report.baselineObservations.push(observation);
  try {
    const program = path.join(environment.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const output = run(program, ['-NoProfile', '-NonInteractive', '-Command', legacy.CIM_DIAGNOSTIC],
      { env: environment, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 65536 });
    const bytes = Buffer.from(output); assert.ok(bytes.length <= 65536);
    observation.probe = legacy.parseProbeOutput(bytes, 'cim');
    observation.originalNsExecTrace = false;
  } catch (error) { observation.error = legacy.errorMetadata(error); }
  try { return original(file, baseline, environment, report); }
  catch (error) {
    try { report.baselineFailureDiagnostics = legacy.failureDiagnostics(error, baseline, out); }
    catch (diagnosticError) { report.baselineFailureDiagnostics = { diagnosticError: legacy.errorMetadata(diagnosticError) }; }
    throw error;
  }
}
module.exports = { install };
