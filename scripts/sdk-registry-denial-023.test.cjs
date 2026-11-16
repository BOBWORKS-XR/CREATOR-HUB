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

function restartedFixture() {
  const { report, lifecycle } = fixture();
  const binding = require('./fixtures/windows-outgoing-019-binding.json');
  const image = 'C:\\fixture\\AppData\\Local\\Creator Hub\\creator-hub.exe';
  Object.assign(report, {
    baseline: { version: binding.baseline.version, installer: binding.baseline.installer.sha256,
      exe: binding.baseline.executable.sha256 },
    pins: { descriptor: binding.target.descriptor.sha256, descriptorSignature: binding.target.descriptorSignature.sha256,
      installer: binding.target.installer.sha256, executable: binding.target.executable.sha256,
      manifest: binding.target.latest.sha256 },
    sourceCommit: binding.target.source.commit,
    profile: { local: 'C:\\fixture\\AppData\\Local' },
    beforePeVersion: [0, 1, 22, 0], afterPeVersion: [0, 1, 23, 0],
    passed: true, nativeUpdateAccepted: true, automaticRestart: true,
    normalRestartPreserved: true, installedResourcesVerifiedBeforeAndAfter: true,
    beforeRoot: { pid: 11, parentPid: 10, image, kernelIdentityVerified: true, startTicks: '123' },
    afterRoot: { pid: 21, parentPid: 20, image, kernelIdentityVerified: true, startTicks: '223' },
    normalRestartRoot: { pid: 31, parentPid: 10, image, kernelIdentityVerified: true, startTicks: '323' },
  });
  report.beforeNormalRestart = structuredClone(report.afterRoot);
  lifecycle.rejectedRequestCount = 2;
  lifecycle.rejectionSummary.count = 2;
  lifecycle.connectDiagnostics.count = 2;
  lifecycle.connectTrace = [report.beforeRoot, report.normalRestartRoot].map((root, index) => ({
    ...structuredClone(lifecycle.connectTrace), clientPort: 100 + index * 2,
    owner: { status: 'observed', processes: [{ pid: root.pid, parentPid: 10, image }] },
  }));
  return { report, lifecycle };
}

test('two refusals require one exact baseline and one hash-bound normal restart owner', () => {
  const { report, lifecycle } = restartedFixture();
  assert.deepEqual(verify(lifecycle, report), {
    expectedSdkRegistryDenials: 2, unexpectedDenials: 0, sdkRegistryConnectionAdmitted: false,
  });
  lifecycle.connectTrace.reverse();
  assert.equal(verify(lifecycle, report).expectedSdkRegistryDenials, 2);
});

test('two-refusal gate rejects foreign, repeated, automatic-successor and excess owners', () => {
  const mutations = [
    x => x.lifecycle.connectTrace[1].owner.processes[0].pid++,
    x => x.lifecycle.connectTrace[1].owner.processes[0].parentPid++,
    x => x.lifecycle.connectTrace[1].owner.processes[0].image = 'C:\\foreign\\Creator Hub\\creator-hub.exe',
    x => x.lifecycle.connectTrace[1].owner = structuredClone(x.lifecycle.connectTrace[0].owner),
    x => x.lifecycle.connectTrace[0].owner = structuredClone(x.lifecycle.connectTrace[1].owner),
    x => x.lifecycle.connectTrace[1].owner.processes[0] = {
      pid: x.report.afterRoot.pid, parentPid: x.report.afterRoot.parentPid, image: x.report.afterRoot.image },
    x => { x.lifecycle.rejectedRequestCount = 3; x.lifecycle.rejectionSummary.count = 3;
      x.lifecycle.connectDiagnostics.count = 3; x.lifecycle.connectTrace.push(structuredClone(x.lifecycle.connectTrace[0])); },
    x => x.lifecycle.connectTrace.pop(),
    x => x.lifecycle.connectTrace.push(structuredClone(x.lifecycle.connectTrace[0])),
  ];
  for (const mutate of mutations) {
    const value = restartedFixture(); mutate(value);
    assert.throws(() => verify(value.lifecycle, value.report));
  }
});

test('second refusal needs complete approved restart identity and exact report hashes and paths', () => {
  const mutations = [
    ...['normalRestartRoot', 'beforeNormalRestart', 'afterRoot', 'profile', 'baseline', 'pins'].map(key =>
      x => { delete x.report[key]; }),
    ...['passed', 'nativeUpdateAccepted', 'automaticRestart', 'normalRestartPreserved',
      'installedResourcesVerifiedBeforeAndAfter'].map(key => x => x.report[key] = false),
    ...['beforeRoot', 'afterRoot', 'normalRestartRoot'].flatMap(key => [
      x => x.report[key].kernelIdentityVerified = false,
      x => x.report[key].startTicks = '0',
      x => x.report[key].image = 'C:\\other\\Creator Hub\\creator-hub.exe',
    ]),
    x => x.report.normalRestartRoot.parentPid++,
    x => x.report.normalRestartRoot.pid = x.report.beforeRoot.pid,
    x => x.report.normalRestartRoot.pid = x.report.afterRoot.pid,
    x => x.report.normalRestartRoot.startTicks = x.report.afterRoot.startTicks,
    x => x.report.afterRoot.startTicks = x.report.beforeRoot.startTicks,
    x => x.report.beforeNormalRestart.pid++,
    x => x.report.profile.local = 'relative',
    x => x.report.profile.local = 'C:\\foreign\\AppData\\Local',
    x => x.report.profile.local = 'C:\\fixture\\..\\fixture\\AppData\\Local',
    x => { const image = 'C:\\fixture\\AppData\\Local\\other\\..\\Creator Hub\\creator-hub.exe';
      for (const root of [x.report.beforeRoot, x.report.afterRoot, x.report.normalRestartRoot, x.report.beforeNormalRestart]) root.image = image;
      for (const trace of x.lifecycle.connectTrace) trace.owner.processes[0].image = image; },
    ...['installer', 'exe'].map(key => x => x.report.baseline[key] = '0'.repeat(64)),
    ...['descriptor', 'descriptorSignature', 'installer', 'executable', 'manifest'].map(key => x => x.report.pins[key] = '0'.repeat(64)),
    x => x.report.sourceCommit = '0'.repeat(40),
    x => x.report.beforePeVersion[2]++,
    x => x.report.afterPeVersion[2]--,
  ];
  for (const mutate of mutations) {
    const value = restartedFixture(); mutate(value);
    assert.throws(() => verify(value.lifecycle, value.report));
  }
});

test('two refusals preserve every endpoint, diagnostic and overflow restriction', () => {
  const mutations = [
    ...['rejectionOverflow', 'connectDiagnosticOverflow', 'connectTraceOverflow'].flatMap(key => [
      x => x.lifecycle[key] = 1, x => { delete x.lifecycle[key]; }, x => x.lifecycle[key] = null,
    ]),
    x => x.lifecycle.rejectionSummary.count = 1,
    x => x.lifecycle.connectDiagnostics.count = 1,
    x => x.lifecycle.rejectionSummary.kind = 'inner-connect',
    x => x.lifecycle.connectDiagnostics.sensitiveHeadersPresent = true,
    x => x.lifecycle.connectDiagnostics.duplicateHost = true,
    x => x.lifecycle.connectDiagnostics.headPresent = true,
    x => x.lifecycle.connectDiagnostics.singleHost = false,
    ...[0, 1].flatMap(index => [
      x => x.lifecycle.connectTrace[index].target.host = 'other.example.com',
      x => x.lifecycle.connectTrace[index].target.port = 80,
      x => x.lifecycle.connectTrace[index].target.kind = 'loopback',
      x => x.lifecycle.connectTrace[index].hostHeaderMatchesAuthority = false,
      x => x.lifecycle.connectTrace[index].clientPort = 0,
      x => x.lifecycle.connectTrace[index].proxyPort = x.lifecycle.connectTrace[index].clientPort,
      x => x.lifecycle.connectTrace[index].owner.status = 'unknown',
      x => x.lifecycle.connectTrace[index].owner.processes.push(structuredClone(x.lifecycle.connectTrace[index].owner.processes[0])),
    ]),
  ];
  for (const mutate of mutations) {
    const value = restartedFixture(); mutate(value);
    assert.throws(() => verify(value.lifecycle, value.report));
  }
});

test('one refusal still accepts only the baseline owner, even with valid restart evidence', () => {
  const value = restartedFixture();
  value.lifecycle.rejectedRequestCount = value.lifecycle.rejectionSummary.count = value.lifecycle.connectDiagnostics.count = 1;
  value.lifecycle.connectTrace = [value.lifecycle.connectTrace[0]];
  assert.equal(verify(value.lifecycle, value.report).expectedSdkRegistryDenials, 1);
  value.lifecycle.connectTrace[0].owner.processes[0].pid = value.report.normalRestartRoot.pid;
  assert.throws(() => verify(value.lifecycle, value.report));
});
