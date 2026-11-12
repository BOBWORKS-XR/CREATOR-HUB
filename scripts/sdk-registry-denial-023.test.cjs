'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { verifySdkRegistryDenial: verify } = require('./sdk-registry-denial-023.cjs');
function fixture() {
  const report = { beforeRoot: { pid: 11, parentPid: 10, image: 'C:\\owned\\Creator Hub\\creator-hub.exe', kernelIdentityVerified: true, startTicks: '123' } };
  const lifecycle = { rejectedRequestCount: 1, rejectionOverflow: 0, connectDiagnosticOverflow: 0, connectTraceOverflow: 0,
    rejectionSummary: { kind: 'connect-policy', code: null, count: 1 }, driver: { pid: 10 },
    connectDiagnostics: { authority: '[redacted]', headPresent: false, singleHost: true, duplicateHost: false,
      hostHeaderMatchesAuthority: false, sensitiveHeadersPresent: false, count: 1 },
    connectTrace: { target: { kind: 'dns', host: 'greenfield-registry.sdq.st', port: 443 }, clientPort: 100, proxyPort: 101,
      hostHeaderMatchesAuthority: true, owner: { status: 'observed', processes: [{ pid: 11, parentPid: 10, image: report.beforeRoot.image }] } } };
  return { report, lifecycle };
}
test('accepts only the source-traced registry denial from the kernel-verified baseline Hub', () => {
  const { report, lifecycle } = fixture();
  assert.deepEqual(verify(lifecycle, report), { expectedSdkRegistryDenials: 1, unexpectedDenials: 0, sdkRegistryConnectionAdmitted: false });
  for (const key of ['connectTrace', 'connectDiagnostics', 'rejectionSummary']) lifecycle[key] = [lifecycle[key]];
  assert.equal(verify(lifecycle, report).expectedSdkRegistryDenials, 1);
});
test('unrelated destinations, missing attribution and every weakened rejection shape remain refused', () => {
  const mutations = [
    x => x.lifecycle.rejectedRequestCount = 2,
    ...['rejectionOverflow', 'connectDiagnosticOverflow', 'connectTraceOverflow'].map(key => x => x.lifecycle[key] = 1),
    ...['rejectionOverflow', 'connectDiagnosticOverflow', 'connectTraceOverflow'].flatMap(key => [
      x => { delete x.lifecycle[key]; }, x => { x.lifecycle[key] = null; }]),
    x => x.lifecycle.connectTrace.target.host = 'other.example.com',
    x => x.lifecycle.connectTrace.target.port = 80,
    x => x.lifecycle.connectTrace.target.kind = 'loopback',
    x => x.lifecycle.connectTrace.hostHeaderMatchesAuthority = false,
    x => x.lifecycle.connectTrace.owner.status = 'unavailable',
    x => x.lifecycle.connectTrace.owner.processes[0].pid++,
    x => x.lifecycle.connectTrace.owner.processes[0].parentPid++,
    x => x.lifecycle.connectTrace.owner.processes[0].image = 'C:\\foreign.exe',
    x => x.lifecycle.connectTrace.owner.processes.push({ ...x.lifecycle.connectTrace.owner.processes[0] }),
    x => x.lifecycle.connectTrace.owner.processes = { 0: x.lifecycle.connectTrace.owner.processes[0], length: 1 },
    x => x.lifecycle.connectTrace = [],
    x => x.lifecycle.connectDiagnostics.headPresent = true,
    x => x.lifecycle.connectDiagnostics.singleHost = false,
    x => x.lifecycle.connectDiagnostics.duplicateHost = true,
    x => x.lifecycle.connectDiagnostics.sensitiveHeadersPresent = true,
    x => x.lifecycle.rejectionSummary.count = 2,
    x => x.lifecycle.rejectionSummary.kind = 'inner-connect',
    x => x.report.beforeRoot.kernelIdentityVerified = false,
    x => x.report.beforeRoot.parentPid++,
    x => x.report.beforeRoot.startTicks = 'unknown',
    x => x.report.beforeRoot.startTicks = '0',
    x => x.lifecycle.driver.pid++,
  ];
  for (const mutate of mutations) { const value = fixture(); mutate(value); assert.throws(() => verify(value.lifecycle, value.report)); }
});
test('zero refusals retain the original gate, but cannot hide diagnostic evidence or overflow', () => {
  const value = { rejectedRequestCount: 0 };
  assert.equal(verify(value, {}).expectedSdkRegistryDenials, 0);
  assert.throws(() => verify({ ...value, connectTrace: fixture().lifecycle.connectTrace }, {}));
  assert.throws(() => verify({ ...value, rejectionOverflow: 1 }, {}));
});
