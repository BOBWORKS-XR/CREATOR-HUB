'use strict';
const assert = require('node:assert/strict');
function rows(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function verifySdkRegistryDenial(lifecycle, report) {
  for (const key of ['rejectionOverflow', 'connectDiagnosticOverflow', 'connectTraceOverflow'])
    assert.equal(lifecycle[key] ?? 0, 0, key);
  if (lifecycle.rejectedRequestCount === 0) {
    for (const key of ['rejectionSummary', 'connectDiagnostics', 'connectTrace']) assert.deepEqual(rows(lifecycle[key]), [], key);
    return { expectedSdkRegistryDenials: 0, unexpectedDenials: 0, sdkRegistryConnectionAdmitted: false };
  }
  assert.equal(lifecycle.rejectedRequestCount, 1, 'Only one observed SDK-registry refusal is qualified');
  for (const key of ['rejectionOverflow', 'connectDiagnosticOverflow', 'connectTraceOverflow']) assert.equal(lifecycle[key], 0, key);
  assert.deepEqual(rows(lifecycle.rejectionSummary), [{ kind: 'connect-policy', code: null, count: 1 }]);
  assert.deepEqual(rows(lifecycle.connectDiagnostics), [{ authority: '[redacted]', headPresent: false,
    singleHost: true, duplicateHost: false, hostHeaderMatchesAuthority: false, sensitiveHeadersPresent: false, count: 1 }]);
  const traces = rows(lifecycle.connectTrace); assert.equal(traces.length, 1);
  const trace = traces[0];
  assert.deepEqual(trace.target, { kind: 'dns', host: 'greenfield-registry.sdq.st', port: 443 });
  assert.equal(trace.hostHeaderMatchesAuthority, true);
  for (const port of [trace.clientPort, trace.proxyPort]) assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535);
  assert.notEqual(trace.clientPort, trace.proxyPort);
  assert.equal(trace.owner.status, 'observed'); assert.ok(Array.isArray(trace.owner.processes));
  assert.equal(trace.owner.processes.length, 1);
  const process = trace.owner.processes[0], before = report.beforeRoot, driver = lifecycle.driver;
  assert.equal(before.kernelIdentityVerified, true);
  assert.match(before.startTicks, /^[1-9][0-9]*$/);
  assert.ok(Number.isInteger(before.pid) && before.pid > 0);
  assert.ok(Number.isInteger(driver.pid) && driver.pid > 0);
  assert.equal(before.parentPid, driver.pid);
  assert.deepEqual(process, { pid: before.pid, parentPid: driver.pid, image: before.image });
  assert.match(process.image, /\\Creator Hub\\creator-hub\.exe$/i);
  return { expectedSdkRegistryDenials: 1, unexpectedDenials: 0, sdkRegistryConnectionAdmitted: false };
}
module.exports = { verifySdkRegistryDenial };
