const assert = require('node:assert/strict');
const path = require('node:path');
const { BASELINE, TARGET } = require('./native-unified-outgoing-target.cjs');
function processRecord(record) {
  assert.ok(record && Number.isSafeInteger(record.pid) && record.pid > 0 && record.pid <= 0xffffffff &&
    Number.isSafeInteger(record.parentPid) && record.parentPid >= 0 && record.parentPid <= 0xffffffff, 'Invalid process IDs');
  assert.match(record.startTicks, /^[1-9][0-9]{10,19}$/, 'Kernel start identity unavailable');
  assert.ok(typeof record.image === 'string' && path.win32.isAbsolute(record.image), 'Absolute kernel image required');
  assert.equal(record.kernelIdentityVerified, true, 'Kernel identity unverified');
  return record;
}
function sameProcess(expected, actual) {
  processRecord(expected); processRecord(actual);
  assert.deepEqual(actual, expected, 'PID reuse/start/image/parent drift refused');
}
function activeRoute(value, version) {
  assert.ok([BASELINE.version, TARGET.version].includes(version));
  assert.deepEqual(Object.keys(value).sort(), ['descriptorSha256', 'generation', 'hubVersion', 'schemaVersion']);
  assert.equal(value.schemaVersion, 1); assert.equal(value.hubVersion, version);
  assert.equal(value.descriptorSha256, version === BASELINE.version ? BASELINE.runtimeDescriptor : TARGET.runtimeDescriptor);
  assert.match(value.generation, /^[a-f0-9]{64}$/);
}
function bothBackends(backends, root) {
  processRecord(root);
  assert.equal(path.win32.basename(root.image).toLowerCase(), 'creator-hub.exe');
  assert.deepEqual(Object.keys(backends).sort(), ['mcp', 'setup'], 'Both real built-in backends required');
  for (const [app, backend] of Object.entries(backends)) {
    processRecord(backend);
    assert.equal(backend.parentPid, root.pid, 'Backend is not owned by Root');
    assert.equal(path.win32.basename(backend.image).toLowerCase(), app === 'mcp' ? 'creator-works-mcp-launcher.exe' : 'creator-project-setup.exe');
  }
  assert.equal(new Set([root.pid, ...Object.values(backends).map(record => record.pid)]).size, 3, 'Ambiguous backend identity');
}
function snapshotShape(snapshot) {
  bothBackends(snapshot.backends, snapshot.root);
  assert.deepEqual(Object.keys(snapshot.stores).sort(), ['installedContent', 'mcp', 'preferences', 'setup']);
  for (const [name, store] of Object.entries(snapshot.stores)) {
    assert.equal(typeof store.present, 'boolean');
    if (store.present) {
      assert.deepEqual(Object.keys(store).sort(), ['present', 'sha256', 'size']);
      assert.ok(Number.isSafeInteger(store.size) && store.size > 0 && store.size <= 1024 * 1024);
      assert.match(store.sha256, /^[a-f0-9]{64}$/);
    } else assert.deepEqual(store, { present: false });
    if (name !== 'setup') assert.equal(store.present, true, `Missing real saved ${name}`);
  }
  assert.deepEqual(Object.keys(snapshot.preferences).sort(), ['auto-download', 'preview-channel', 'restore-hosted-views']);
  assert.deepEqual(snapshot.preferences, { 'auto-download': true, 'preview-channel': false, 'restore-hosted-views': true });
  processRecord(snapshot.sdkRouter); processRecord(snapshot.sdkNode); processRecord(snapshot.unrelated);
  assert.equal(snapshot.sdkNode.parentPid, snapshot.sdkRouter.pid, 'SDK Node is not attached to the observed router');
  assert.equal(path.win32.basename(snapshot.sdkRouter.image).toLowerCase(), 'creator-hub-mcp-router.exe');
  assert.equal(path.win32.basename(snapshot.sdkNode.image).toLowerCase(), 'node.exe');
  assert.notEqual(snapshot.sdkRouter.parentPid, snapshot.root.pid, 'External SDK connection must not be a Root-owned backend');
  assert.notEqual(snapshot.unrelated.parentPid, snapshot.root.pid);
  assert.equal(new Set([snapshot.root, ...Object.values(snapshot.backends), snapshot.sdkRouter, snapshot.sdkNode, snapshot.unrelated]
    .map(record => record.pid)).size, 6, 'Process evidence aliases another owned component');
}
function cancelPreserved(before, after) {
  snapshotShape(before); snapshotShape(after);
  assert.equal(before.executableSha256, BASELINE.exe);
  assert.deepEqual(Object.keys(before.forms).sort(), ['mcp', 'setup']);
  for (const form of Object.values(before.forms)) assert.ok(typeof form === 'string' && form.length > 0 && form.length <= 256);
  sameProcess(before.root, after.root);
  for (const app of ['mcp', 'setup']) sameProcess(before.backends[app], after.backends[app]);
  sameProcess(before.sdkRouter, after.sdkRouter); sameProcess(before.sdkNode, after.sdkNode);
  sameProcess(before.unrelated, after.unrelated);
  assert.equal(after.executableSha256, BASELINE.exe);
  assert.deepEqual(after.stores, before.stores, 'Cancel changed exact config/preferences/content bytes or absence');
  assert.deepEqual(after.preferences, before.preferences, 'Cancel changed actual UI preferences');
  assert.deepEqual(after.forms, before.forms, 'Cancel discarded unsaved forms');
  activeRoute(before.activeRoute, BASELINE.version); activeRoute(after.activeRoute, BASELINE.version);
  assert.deepEqual(after.activeRoute, before.activeRoute, 'Cancel changed managed activation');
  assert.equal(before.ticketExists, false); assert.equal(after.ticketExists, false, 'Cancel wrote a restore ticket');
  assert.deepEqual(after.rootExit, { code: null, signal: null }, 'Cancel terminated Root');
}
function restoreImagePath(value) {
  assert.ok(typeof value === 'string' && value.length <= 4096, 'Bounded native image path required');
  const image = (value.startsWith('\\\\?\\') ? value.slice(4) : value).replaceAll('/', '\\');
  assert.match(image, /^[A-Za-z]:\\/, 'Only absolute Windows drive image paths are comparable');
  const parts = image.slice(3).split('\\');
  assert.ok(parts.every(part => part.length > 0 && part !== '.' && part !== '..'
    && !/[\x00-\x1f<>:"|?*/]/.test(part) && !/[. ]$/.test(part)
    && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)),
  'Noncanonical, device or stream image path refused');
  return image.toLowerCase();
}
function restoreTicket(ticket, before) {
  assert.deepEqual(Object.keys(ticket).sort(), ['created', 'fromVersion', 'schemaVersion', 'toVersion', 'views']);
  assert.equal(ticket.schemaVersion, 1); assert.equal(ticket.fromVersion, BASELINE.version);
  assert.equal(ticket.toVersion, TARGET.version);
  assert.ok(Number.isSafeInteger(ticket.created) && ticket.created > 0);
  assert.ok(Array.isArray(ticket.views) && ticket.views.length === 2);
  assert.deepEqual(ticket.views.map(view => view.app).sort(), ['mcp', 'setup']);
  for (const view of ticket.views) {
    assert.deepEqual(Object.keys(view).sort(), ['app', 'bundled', 'path']);
    assert.equal(view.bundled, true, 'Legacy hosted views are not outgoing built-in acceptance');
    assert.equal(restoreImagePath(view.path), restoreImagePath(before.backends[view.app].image), 'Restore source path differs');
  }
}
function approvedUpdate(before, after, evidence) {
  snapshotShape(before); snapshotShape(after);
  assert.equal(before.executableSha256, BASELINE.exe, 'Outgoing Root must be genuine installed B03');
  assert.equal(before.ticketExists, false);
  assert.deepEqual(before.rootExit, { code: null, signal: null });
  assert.deepEqual(evidence.originalExit, { code: 0, signal: null }, 'Original Root did not exit normally');
  assert.equal(after.root.image.toLowerCase(), before.root.image.toLowerCase());
  assert.notEqual(after.root.pid, before.root.pid, 'No distinct automatic restart');
  assert.notEqual(after.root.startTicks, before.root.startTicks);
  assert.ok(BigInt(after.root.startTicks) > BigInt(before.root.startTicks), 'Restart identity predates the original Root');
  assert.equal(evidence.manualTargetLaunches, 0, 'Manual target launch cannot prove automatic restart');
  assert.equal(after.executableSha256, TARGET.pins.executable);
  activeRoute(before.activeRoute, BASELINE.version); activeRoute(after.activeRoute, TARGET.version);
  assert.equal(evidence.footerVersion, TARGET.version); assert.equal(evidence.registryVersion, TARGET.version);
  assert.equal(evidence.originalBackendsAbsent, true, 'Original owned backends still live or absence unknown');
  for (const app of ['mcp', 'setup']) assert.notEqual(after.backends[app].pid, before.backends[app].pid, 'Backend PID reuse refused');
  sameProcess(before.sdkRouter, after.sdkRouter); sameProcess(before.sdkNode, after.sdkNode);
  sameProcess(before.unrelated, after.unrelated);
  assert.deepEqual(after.stores, before.stores, 'Update changed exact config/preferences/content bytes or absence');
  assert.deepEqual(after.preferences, before.preferences);
  restoreTicket(evidence.observedTicket, before);
  assert.equal(after.ticketExists, false, 'Restore ticket not consumed');
  assert.deepEqual(evidence.pendingRestore, []);
  assert.equal(evidence.restoreMessage, 'Your app views have reopened. Select an app from the menu.');
  assert.deepEqual(evidence.restoredFrames, ['setup', 'mcp']);
  assert.equal(evidence.existingSdkRoundTrip, true); assert.equal(evidence.newRouterRoundTrips, 2);
  assert.equal(evidence.actualNativePermissions, true);
}
function newReport() {
  return { schemaVersion: 1, kind: 'unified-outgoing-14-15', acceptanceOnly: true,
    baselineVersion: BASELINE.version, targetVersion: TARGET.version, labDiscovery: true,
    publicDiscovery: false, frameworkSdkOnly: true, liveAiAcceptance: false, editorAcceptance: false,
    productAcceptance: false, releaseReady: false, outgoingHostedUpdateTested: false, passed: false, checks: [] };
}
module.exports = { processRecord, sameProcess, activeRoute, bothBackends, snapshotShape, cancelPreserved, restoreTicket, approvedUpdate, newReport };
