'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
function rows(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function verifyRoot(root, driver) {
  assert.equal(root?.kernelIdentityVerified, true);
  assert.match(root.startTicks, /^[1-9][0-9]*$/);
  assert.ok(Number.isInteger(root.pid) && root.pid > 0);
  assert.ok(Number.isInteger(driver?.pid) && driver.pid > 0);
  assert.equal(root.parentPid, driver.pid);
  assert.match(root.image, /\\Creator Hub\\creator-hub\.exe$/i);
}
function normalRestartRoots(report, driver) {
  const binding = require('./fixtures/windows-outgoing-019-binding.json');
  assert.equal(binding.enabled, true);
  assert.equal(binding.baseline.version, '0.1.22');
  assert.equal(binding.target.version, '0.1.23');
  assert.deepEqual(report.baseline, { version: binding.baseline.version,
    installer: binding.baseline.installer.sha256, exe: binding.baseline.executable.sha256 });
  assert.deepEqual(report.pins, { descriptor: binding.target.descriptor.sha256,
    descriptorSignature: binding.target.descriptorSignature.sha256,
    installer: binding.target.installer.sha256, executable: binding.target.executable.sha256,
    manifest: binding.target.latest.sha256 });
  assert.equal(report.sourceCommit, binding.target.source.commit);
  assert.deepEqual(report.beforePeVersion, [0, 1, 22, 0]);
  assert.deepEqual(report.afterPeVersion, [0, 1, 23, 0]);
  for (const key of ['passed', 'nativeUpdateAccepted', 'automaticRestart',
    'normalRestartPreserved', 'installedResourcesVerifiedBeforeAndAfter']) assert.equal(report[key], true, key);
  const local = report.profile?.local;
  assert.ok(typeof local === 'string' && path.win32.isAbsolute(local));
  assert.ok(!local.split(/[\\/]/).includes('..'));
  const expectedImage = path.win32.join(local, 'Creator Hub', 'creator-hub.exe');
  const roots = [report.beforeRoot, report.afterRoot, report.normalRestartRoot];
  for (const root of roots) {
    assert.equal(root?.kernelIdentityVerified, true);
    assert.match(root.startTicks, /^[1-9][0-9]*$/);
    assert.ok(Number.isInteger(root.pid) && root.pid > 0);
    assert.ok(typeof root.image === 'string' && path.win32.isAbsolute(root.image));
    assert.ok(!root.image.split(/[\\/]/).includes('..'));
    assert.equal(path.win32.normalize(root.image).toLowerCase(), expectedImage.toLowerCase());
  }
  assert.equal(new Set(roots.map(root => root.pid)).size, 3, 'Distinct baseline, automatic and normal roots required');
  assert.ok(BigInt(roots[0].startTicks) < BigInt(roots[1].startTicks));
  assert.ok(BigInt(roots[1].startTicks) < BigInt(roots[2].startTicks));
  assert.deepEqual(report.beforeNormalRestart, report.afterRoot);
  verifyRoot(report.normalRestartRoot, driver);
  return [report.beforeRoot, report.normalRestartRoot];
}
function verifySdkRegistryDenial(lifecycle, report) {
  for (const key of ['rejectionOverflow', 'connectDiagnosticOverflow', 'connectTraceOverflow'])
    assert.equal(lifecycle[key] ?? 0, 0, key);
  if (lifecycle.rejectedRequestCount === 0) {
    for (const key of ['rejectionSummary', 'connectDiagnostics', 'connectTrace']) assert.deepEqual(rows(lifecycle[key]), [], key);
    return { expectedSdkRegistryDenials: 0, unexpectedDenials: 0, sdkRegistryConnectionAdmitted: false };
  }
  const count = lifecycle.rejectedRequestCount;
  assert.ok(count === 1 || count === 2, 'Only baseline and approved normal-restart SDK-registry refusals are qualified');
  for (const key of ['rejectionOverflow', 'connectDiagnosticOverflow', 'connectTraceOverflow']) assert.equal(lifecycle[key], 0, key);
  assert.deepEqual(rows(lifecycle.rejectionSummary), [{ kind: 'connect-policy', code: null, count }]);
  assert.deepEqual(rows(lifecycle.connectDiagnostics), [{ authority: '[redacted]', headPresent: false,
    singleHost: true, duplicateHost: false, hostHeaderMatchesAuthority: false, sensitiveHeadersPresent: false, count }]);
  const traces = rows(lifecycle.connectTrace); assert.equal(traces.length, count);
  const driver = lifecycle.driver;
  verifyRoot(report.beforeRoot, driver);
  const roots = count === 2 ? normalRestartRoots(report, driver) : [report.beforeRoot];
  const seen = new Set();
  for (const trace of traces) {
    assert.deepEqual(trace.target, { kind: 'dns', host: 'greenfield-registry.sdq.st', port: 443 });
    assert.equal(trace.hostHeaderMatchesAuthority, true);
    for (const port of [trace.clientPort, trace.proxyPort]) assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535);
    assert.notEqual(trace.clientPort, trace.proxyPort);
    assert.equal(trace.owner.status, 'observed'); assert.ok(Array.isArray(trace.owner.processes));
    assert.equal(trace.owner.processes.length, 1);
    const process = trace.owner.processes[0], root = roots.find(root => root.pid === process.pid);
    assert.ok(root, 'SDK-registry refusal owner is not an approved root');
    assert.ok(!seen.has(root.pid), 'At most one SDK-registry refusal per approved root');
    assert.deepEqual(process, { pid: root.pid, parentPid: driver.pid, image: root.image });
    seen.add(root.pid);
  }
  assert.equal(seen.size, roots.length);
  return { expectedSdkRegistryDenials: count, unexpectedDenials: 0, sdkRegistryConnectionAdmitted: false };
}
module.exports = { verifySdkRegistryDenial };
