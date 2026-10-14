const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const rootDiagnostics = require('./native-macos-root-diagnostics.cjs');

const bundle = 'com.creatorworks.hub';
const acceptance = Object.freeze({ nativeGuiAccepted: false, mcpAccepted: false, migrationAccepted: false,
  updateAccepted: false, releaseReady: false });
function requireThat(value, message) { if (!value) throw Error(message); }
function admission(env, platform, arch) {
  requireThat(platform === 'darwin' && ['arm64', 'x64'].includes(arch), 'native-matching-mac-required');
  requireThat(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
    && env.RUNNER_OS === 'macOS' && env.GITHUB_REPOSITORY === 'BOBWORKS-XR/CREATOR-HUB'
    && env.CREATOR_MACOS_OWNED_GUI_TEST === '1' && env.CREATOR_MACOS_APP_PROBE === '1', 'hosted-ci-explicit-opt-in-required');
  requireThat(env.RUNNER_ARCH === (arch === 'arm64' ? 'ARM64' : 'X64'), 'runner-architecture-mismatch');
}
function options(args) {
  let launchContext;
  if (args.at(-2) === '--launch-context') {
    launchContext = args.at(-1); args = args.slice(0, -2);
    requireThat(rootDiagnostics.scopes.includes(launchContext), 'unknown-launch-control-context');
    requireThat(args.length === 12, 'launch-control-requires-independent-fresh14-package-identity');
  }
  requireThat([6, 12].includes(args.length) && args[0] === '--app' && args[2] === '--hub-sha256' && args[4] === '--output',
    'expected --app APP_PATH --hub-sha256 INDEPENDENT_SHA256 --output NEW_DIRECTORY [--expected-version VERSION --assembly-receipt FILE --assembly-receipt-sha256 INDEPENDENT_SHA256]');
  requireThat(/^[a-f0-9]{64}$/.test(args[3]), 'independent-hub-sha256-required');
  const result = { app: args[1], hubSha256: args[3], output: args[5] };
  if (args.length === 12) {
    requireThat(args[6] === '--expected-version' && args[8] === '--assembly-receipt' && args[10] === '--assembly-receipt-sha256'
      && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(args[7]) && /^[a-f0-9]{64}$/.test(args[11]), 'independent-package-identity-required');
    Object.assign(result, { expectedVersion: args[7], assemblyReceipt: args[9], assemblyReceiptSha256: args[11] });
  }
  if (launchContext) result.launchContext = launchContext;
  return result;
}
function inside(root, value) { return value.startsWith(root + path.sep); }
function canonical(value) {
  requireThat(path.isAbsolute(value) && path.normalize(value) === value && !/[\x00-\x1f]/.test(value), 'absolute-canonical-path-required');
  requireThat(fs.realpathSync(value) === value, 'linked-or-redirected-path-refused');
  return value;
}
function reserveOutput(temporary, app, output) {
  requireThat(path.isAbsolute(output) && path.normalize(output) === output && !/[\x00-\x1f]/.test(output), 'new-absolute-output-required');
  canonical(path.dirname(output)); requireThat(inside(temporary, output), 'output-outside-runner-temp');
  requireThat(output !== app && !inside(app, output) && !inside(output, app), 'output-must-not-modify-the-pinned-app');
  fs.mkdirSync(output, { mode: 0o700 });
  return canonical(output);
}
function pin(file, max = 128 * 1024 * 1024, contents = false) {
  canonical(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    requireThat(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(max)
      && (typeof process.getuid !== 'function' || before.uid === BigInt(process.getuid())), 'file-ownership-type-or-size-refused');
    const hash = crypto.createHash('sha256'), chunks = [], buffer = Buffer.alloc(65536);
    let length = 0, head;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      length += count; requireThat(length <= max, 'file-grew');
      const bytes = buffer.subarray(0, count); hash.update(bytes);
      if (!head) head = Buffer.from(bytes.subarray(0, 64));
      if (contents) chunks.push(Buffer.from(bytes));
    }
    const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
    for (const key of ['dev', 'ino', 'size', 'uid', 'nlink', 'mode', 'mtimeNs']) {
      requireThat(before[key] === after[key] && after[key] === named[key], 'file-identity-drift');
    }
    requireThat(length === Number(after.size), 'file-length-drift');
    return { image: { sha256: hash.digest('hex'), device: String(after.dev), inode: String(after.ino), size: length,
      modifiedSeconds: Number(after.mtimeNs / 1000000000n), modifiedNanoseconds: Number(after.mtimeNs % 1000000000n), uid: Number(after.uid) },
    head, ...(contents ? { bytes: Buffer.concat(chunks) } : {}) };
  } finally { fs.closeSync(fd); }
}
function sameImage(actual, expected) {
  return actual && Object.keys(expected).every(key => actual[key] === expected[key]);
}
function validateOwner(owner, expected) {
  const p = owner?.process, w = owner?.window, b = w?.bounds;
  requireThat(p?.pid === expected.pid && p.executablePath === expected.executable && p.bundlePath === expected.app
    && p.bundleIdentifier === bundle && Number.isSafeInteger(p.startSeconds) && p.startSeconds > 0
    && Number.isSafeInteger(p.startMicroseconds) && p.startMicroseconds >= 0 && p.startMicroseconds < 1000000
    && sameImage(p.image, expected.image) && sameImage(p.infoPlist, expected.infoPlist), 'owned-root-process-or-file-drift');
  requireThat(Number.isSafeInteger(w?.id) && w.id > 0 && w.pid === p.pid && b
    && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(b[key]))
    && Math.abs(b.x) <= 32768 && Math.abs(b.y) <= 32768 && b.width > 0 && b.height > 0
    && b.width <= 16384 && b.height <= 16384, 'owned-root-window-bounds-unverified');
}
function assemblyIdentity(bytes, platformArch, expectedVersion) {
  requireThat(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 16384, 'assembly-receipt-size-refused');
  const value = JSON.parse(bytes.toString('utf8'));
  const fields = ['schemaVersion', 'product', 'platform', 'arch', 'hubVersion', 'assemblyCommit', 'privateSource', 'handoffSha256',
    'mcpMode', 'privateModulesRecompiled', 'privateModulesResigned', 'nativeGuiAccepted', 'releaseReady'];
  const s = value?.privateSource;
  const sourceFields = ['repository', 'repositoryId', 'workflow', 'event', 'sourceCommit', 'buildCommit', 'sourceTree', 'runId', 'runAttempt'];
  const sha = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
  requireThat(bytes.toString('utf8').trim() === JSON.stringify(value, null, 2)
    && value && Object.keys(value).length === fields.length && Object.keys(value).every(k => fields.includes(k))
    && value.schemaVersion === 1 && value.product === 'com.creatorworks.hub.unix-signed-assembly'
    && value.platform === 'macos' && value.arch === platformArch && value.hubVersion === expectedVersion
    && sha(value.assemblyCommit) && /^[a-f0-9]{64}$/.test(value.handoffSha256)
    && value.mcpMode === 'writable' && value.privateModulesRecompiled === false && value.privateModulesResigned === false
    && value.nativeGuiAccepted === false && value.releaseReady === false
    && s && Object.keys(s).length === sourceFields.length && Object.keys(s).every(k => sourceFields.includes(k))
    && s.repository === 'BOBWORKS-XR/CREATOR-HUB' && s.repositoryId === 1364807512
    && s.workflow === '.github/workflows/unix-managed-payload.yml' && s.event === 'push'
    && [s.sourceCommit, s.buildCommit, s.sourceTree].every(sha) && s.sourceCommit === s.buildCommit
    && [s.runId, s.runAttempt].every(v => Number.isSafeInteger(v) && v > 0), 'assembly-receipt-identity-invalid');
  return { assemblyCommit: value.assemblyCommit, privateSource: s, handoffSha256: value.handoffSha256,
    hubVersion: value.hubVersion, platform: value.platform, arch: value.arch };
}
function validatePackageIdentity(receipt, owner, expectedVersion) {
  const { package: p, ...inspection } = receipt || {};
  validateRootInspection({ ...inspection, command: 'inspect-root' }, owner);
  const fields = ['bundleIdentifier', 'bundleExecutable', 'bundleShortVersion', 'bundleVersion', 'infoPlist'];
  const version = v => typeof v === 'string' && /^\d{1,6}(?:\.\d{1,6}){0,3}$/.test(v);
  requireThat(receipt.command === 'package-identity' && p && Object.keys(p).length === fields.length
    && Object.keys(p).every(k => fields.includes(k)) && p.bundleIdentifier === bundle && p.bundleExecutable === 'creator-hub'
    && version(p.bundleShortVersion) && version(p.bundleVersion) && isDeepStrictEqual(p.infoPlist, owner.process.infoPlist)
    && (expectedVersion === undefined || p.bundleShortVersion === expectedVersion), 'native-package-identity-unverified');
}
function privateProfile(output) {
  const home = path.join(output, 'private-home');
  for (const name of ['', 'Library', 'Library/Application Support', 'Library/Caches', 'Library/Preferences', '.config', '.local', '.local/share', '.cache', 'tmp']) {
    fs.mkdirSync(path.join(home, name), { mode: 0o700 });
  }
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CFFIXED_USER_HOME: home, TMPDIR: path.join(home, 'tmp') + '/',
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache') };
}
function verifiedRootCloseDialog(value) {
  const fields = ['scope', 'state', 'windowCount', 'childCount'];
  return !!value && Object.keys(value).length === fields.length && Object.keys(value).every(key => fields.includes(key))
    && value.scope === 'root-standard-window-first-order-native-dialogs' && value.state === 'absent'
    && value.windowCount === 1 && Number.isSafeInteger(value.childCount) && value.childCount >= 0 && value.childCount < 512;
}
function acceptedExit(close, exit, owner) {
  const before = close?.before, after = close?.after;
  const beforeBound = !!owner?.process && isDeepStrictEqual(before?.process, owner.process) && isDeepStrictEqual(before?.window, owner.window)
    && before.accessibilityTrusted === true && before.active === true && before.truncated === false
    && (owner.process.bundleIdentifier !== 'com.creatorworks.hub'
      || before.hasDialog === false && verifiedRootCloseDialog(before.closeDialog));
  const common = close?.action === 'close-window' && close.axAction === 'AXPress' && close.actionAttempted === true
    && close.forceKillPerformed === false && close.permissionRequestsPerformed === false
    && !close.error && !close.postProcessStatus && beforeBound && exit?.pid === owner.process.pid
    && exit.code === 0 && exit.signal === null && !exit.error;
  if (!common) return false;
  if (close.closeOutcome === 'native-termination') {
    const t = close.termination;
    const fields = ['expectedProcess', 'expectedWindow', 'kernelMissingVerified', 'windowMissingVerified',
      'imageBindingsVerified', 'firstKernelBytes', 'firstKernelErrno', 'lastKernelBytes', 'lastKernelErrno'];
    const controls = Array.isArray(before.controls) ? before.controls.filter(control => control?.path === 'close-button') : null;
    const control = controls?.length === 1 && controls[0];
    return close.postIdentityVerified === false && close.postTerminationVerified === true && close.axResult === 0
      && close.after === undefined && before.hasDialog === false && control?.role === 'AXButton'
      && control.pid === owner.process.pid && control.windowID === owner.window.id && control.enabled === true
      && control.hidden === false && control.showing === true && control.pressSupported === true
      && !!t && Object.keys(t).length === fields.length && Object.keys(t).every(key => fields.includes(key))
      && isDeepStrictEqual(t.expectedProcess, owner.process) && isDeepStrictEqual(t.expectedWindow, owner.window)
      && t.kernelMissingVerified === true && t.windowMissingVerified === true && t.imageBindingsVerified === true
      && t.firstKernelBytes === 0 && t.lastKernelBytes === 0 && t.firstKernelErrno === 3 && t.lastKernelErrno === 3
      && [close.actionStartedUptime, close.actionReturnedUptime, close.postInspectionCompletedUptime].every(Number.isFinite)
      && close.actionStartedUptime > 0 && close.actionReturnedUptime >= close.actionStartedUptime
      && close.postInspectionCompletedUptime >= close.actionReturnedUptime;
  }
  return close.closeOutcome === undefined && close.postTerminationVerified !== true && close.termination === undefined
    && close.postIdentityVerified === true && isDeepStrictEqual(after?.process, owner.process)
    && after.accessibilityTrusted === true && after.truncated === false
    && (isDeepStrictEqual(after.window, owner.window) || after.window === null && after.windowMissingVerified === true);
}
function closeAssessment(close, exit, owner) {
  const p = owner?.process, status = close?.postProcessStatus;
  const callerOwnedExit0 = !!p && exit?.pid === p.pid && exit.code === 0 && exit.signal === null && !exit.error;
  const bound = !!p && status?.pid === p.pid && status.expectedStartSeconds === p.startSeconds
    && status.expectedStartMicroseconds === p.startMicroseconds;
  return { callerOwnedExit0, helperPostIdentityVerified: close?.postIdentityVerified === true,
    helperPostTerminationVerified: close?.postTerminationVerified === true,
    postProcessState: bound && ['absent', 'same-kernel-process', 'different-process', 'unavailable'].includes(status.state) ? status.state : 'unknown',
    closeAccepted: callerOwnedExit0 && acceptedExit(close, exit, owner), diagnosticOnly: true };
}
function bitmapArguments(id, file) {
  requireThat(Number.isSafeInteger(id) && id > 0 && id <= 0xffffffff, 'bitmap-exact-window-id-required');
  requireThat(path.isAbsolute(file) && path.normalize(file) === file && file.endsWith('.png') && !/[\x00-\x1f]/.test(file), 'bitmap-owned-png-path-required');
  return ['-l', String(id), '-x', file];
}
async function windowBitmapDiagnostic(owner, io) {
  const result = { diagnosticOnly: true, attempted: false, completed: false, ...acceptance };
  const verify = receipt => requireThat(receipt?.command === 'bitmap-fence' && receipt.screenCaptureAccess === true
    && receipt.cgWindowFenceVerified === true && receipt.permissionRequestsPerformed === false && receipt.actionAttempted === false
    && isDeepStrictEqual(receipt.process, owner.process) && isDeepStrictEqual(receipt.window, owner.window), 'bitmap-owned-root-fence-unverified');
  try {
    result.before = await io.fence('before');
    if (result.before?.screenCaptureAccess === false) { result.reason = 'screen-capture-permission-unavailable'; return result; }
    verify(result.before);
    result.attempted = true;
    let captureError;
    try { result.capture = await io.capture(owner.window.id); } catch (error) { captureError = error; }
    result.after = await io.fence('after'); verify(result.after);
    if (captureError) throw captureError;
    requireThat(result.capture?.exitCode === 0 && result.capture.signal === null && !result.capture.timedOut && !result.capture.error, 'bitmap-tool-capture-unverified');
    result.image = io.image(); result.completed = true;
  } catch (error) { result.reason = error.message; }
  return result;
}
function bitmapImage(file) {
  const image = pin(file, 32 * 1024 * 1024), head = image.head;
  requireThat(head.length >= 24 && head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && head.readUInt32BE(8) === 13 && head.subarray(12, 16).toString('ascii') === 'IHDR', 'bitmap-png-header-unverified');
  const width = head.readUInt32BE(16), height = head.readUInt32BE(20);
  requireThat(width > 0 && height > 0 && width <= 32768 && height <= 32768, 'bitmap-dimensions-unverified');
  return { ...image.image, width, height };
}

// Pure regression contract, also emitted into Swift. Facts in the native sampler
// come only from live AX/Root checks, never from a receipt or caller-supplied JSON.
const remoteReadChecks = Object.freeze([
  ['nodeIdentityVerified', 'remote-ax-process-unverified'],
  ['parentMatchesTraversalParent', 'remote-ax-parent-unverified'],
  ['windowMatchesHeldRoot', 'remote-ax-window-unverified'],
  ['rootUnchanged', 'remote-ax-root-unverified'],
  ['withinLimits', 'ax-surface-incomplete'],
  ['metadataOnly', 'remote-ax-read-only-required'],
].map(check => Object.freeze(check)));
function remoteReadPolicy(facts) {
  for (const [key, reason] of remoteReadChecks) requireThat(facts?.[key] === true, reason);
  return Object.freeze({ diagnosticOnly: true, readOnly: true, actionAllowed: false, ...acceptance });
}

function validateRootInspection(receipt, owner) {
  const fields = ['command', 'complete', 'readOnly', 'diagnosticOnly', 'rootWindowOnly', 'accessibilityTrusted',
    'rootNativeCFReferencePreserved', 'rootReferenceScope', 'actionAttempted', 'permissionRequestsPerformed',
    'process', 'window', ...Object.keys(acceptance)];
  requireThat(receipt?.command === 'inspect-root' && receipt.complete === true && receipt.readOnly === true
    && receipt.diagnosticOnly === true && receipt.rootWindowOnly === true && receipt.accessibilityTrusted === true
    && receipt.rootNativeCFReferencePreserved === true && receipt.rootReferenceScope === 'native-invocation'
    && receipt.actionAttempted === false && receipt.permissionRequestsPerformed === false
    && Object.keys(receipt).every(key => fields.includes(key)) && owner?.process && owner.window
    && Object.keys(acceptance).every(key => receipt[key] === false)
    && isDeepStrictEqual(receipt.process, owner.process) && isDeepStrictEqual(receipt.window, owner.window),
  'read-only-root-inspection-unverified');
}

function validateChildrenFailure(detail) {
  const fields = ['operation', 'attribute', 'phase', 'classification', 'axError', 'axErrorName', 'timeoutSetAXError',
    'messageTimeoutSeconds', 'elapsedMilliseconds', 'count', 'countExact', 'countVerified', 'returnedCFTypeID',
    'returnedCount', 'unexpectedChildIndex', 'unexpectedChildCFTypeID', 'expectedArrayCFTypeID', 'expectedElementCFTypeID', 'node'];
  const nodeFields = ['path', 'depth', 'role', 'pid', 'rootPID', 'windowID', 'referenceKind', 'referenceScope', 'cfTypeID', 'pidSource'];
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const nullableInteger = value => value === null || integer(value);
  const node = detail?.node;
  requireThat(detail && Object.keys(detail).length === fields.length && Object.keys(detail).every(key => fields.includes(key))
    && ['AXUIElementGetAttributeValueCount', 'AXUIElementCopyAttributeValues', 'validate-values'].includes(detail.operation)
    && ['AXWindows', 'AXChildren'].includes(detail.attribute)
    && ['root-window-discovery', 'root-window-recheck', 'traversal'].includes(detail.phase)
    && ['native-error', 'count-out-of-range', 'missing-array', 'wrong-array-type', 'array-count-mismatch', 'missing-child-value', 'wrong-child-type', 'bridge-failed'].includes(detail.classification)
    && [detail.axError, detail.timeoutSetAXError].every(value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647)
    && ['success', 'failure', 'illegal-argument', 'invalid-ui-element', 'cannot-complete', 'attribute-unsupported', 'not-implemented', 'api-disabled', 'no-value', 'other'].includes(detail.axErrorName)
    && detail.messageTimeoutSeconds === 0.2 && Number.isFinite(detail.elapsedMilliseconds) && detail.elapsedMilliseconds >= 0
    && Number.isInteger(detail.count) && typeof detail.countExact === 'string' && /^-?\d{1,19}$/.test(detail.countExact)
    && Number(detail.countExact) === detail.count && typeof detail.countVerified === 'boolean'
    && [detail.returnedCFTypeID, detail.returnedCount, detail.unexpectedChildIndex, detail.unexpectedChildCFTypeID].every(nullableInteger)
    && (detail.unexpectedChildIndex === null || detail.unexpectedChildIndex < 512)
    && integer(detail.expectedArrayCFTypeID) && integer(detail.expectedElementCFTypeID)
    && node && Object.keys(node).length === nodeFields.length && Object.keys(node).every(key => nodeFields.includes(key))
    && typeof node.path === 'string' && /^(root-application|root-window(?:\/[0-9]{1,3}){0,16})$/.test(node.path)
    && Number.isInteger(node.depth) && node.depth >= -1 && node.depth <= 16
    && (node.role === null || (typeof node.role === 'string' && Buffer.byteLength(node.role, 'utf8') <= 128))
    && [node.pid, node.rootPID].every(value => integer(value) && value > 0 && value <= 2147483647)
    && integer(node.windowID) && node.windowID > 0 && node.windowID <= 0xffffffff && integer(node.cfTypeID)
    && ['root-application', 'held-root-window', 'traversal-node'].includes(node.referenceKind)
    && node.referenceScope === 'native-invocation' && ['application-reference', 'native-read'].includes(node.pidSource),
  'ax-children-diagnostic-invalid');
  const application = node.referenceKind === 'root-application';
  requireThat((application
    ? detail.attribute === 'AXWindows' && detail.phase !== 'traversal' && node.path === 'root-application'
      && node.depth === -1 && node.role === null && node.pidSource === 'application-reference' && node.pid === node.rootPID
    : detail.attribute === 'AXChildren' && detail.phase === 'traversal' && node.path !== 'root-application'
      && node.depth === node.path.split('/').length - 1 && node.role !== null && node.pidSource === 'native-read'
      && node.path.split('/').slice(1).every(index => Number(index) < 512)
      && (node.referenceKind !== 'held-root-window' || node.depth === 0))
    && (detail.operation !== 'AXUIElementGetAttributeValueCount'
      || (detail.countVerified === (detail.axError === 0) && detail.returnedCFTypeID === null && detail.returnedCount === null))
    && (detail.operation === 'AXUIElementGetAttributeValueCount' || (detail.countVerified && detail.count > 0 && detail.count <= 512))
    && (detail.classification === 'native-error' ? detail.axError !== 0 : detail.axError === 0)
    && (detail.classification !== 'count-out-of-range' || detail.count < 0 || detail.count > 512)
    && (detail.operation !== 'validate-values' || detail.classification !== 'native-error')
    && (detail.unexpectedChildIndex === null || detail.operation === 'validate-values'), 'ax-children-diagnostic-invalid');
}

function validateAXNode(node, unknownRole = false) {
  const fields = ['path', 'depth', 'role', 'pid', 'rootPID', 'windowID', 'referenceKind', 'referenceScope', 'cfTypeID', 'pidSource'];
  requireThat(node && Object.keys(node).length === fields.length && Object.keys(node).every(k => fields.includes(k))
    && typeof node.path === 'string' && /^root-window(?:\/[0-9]{1,3}){0,16}$/.test(node.path)
    && node.depth === node.path.split('/').length - 1 && node.depth <= 16
    && node.path.split('/').slice(1).every(v => Number(v) < 512)
    && (unknownRole && node.role === null || typeof node.role === 'string' && Buffer.byteLength(node.role) <= 128)
    && [node.pid, node.rootPID].every(v => Number.isSafeInteger(v) && v > 0 && v <= 2147483647)
    && Number.isSafeInteger(node.windowID) && node.windowID > 0 && node.windowID <= 0xffffffff
    && Number.isSafeInteger(node.cfTypeID) && node.cfTypeID > 0
    && ['held-root-window', 'traversal-node'].includes(node.referenceKind) && node.referenceScope === 'native-invocation'
    && node.pidSource === 'native-read', 'ax-metadata-diagnostic-invalid');
}
function validateLinkFailure(detail, error) {
  const fields = ['kind', 'phase', 'node', 'parent', 'window'];
  requireThat(detail && Object.keys(detail).length === fields.length && Object.keys(detail).every(k => fields.includes(k))
    && detail.kind === 'remote-links' && ['before-metadata', 'after-metadata'].includes(detail.phase), 'ax-link-diagnostic-invalid');
  validateAXNode(detail.node, true);
  requireThat(detail.node.pid !== detail.node.rootPID && detail.node.depth > 0, 'ax-link-diagnostic-invalid');
  const linkFields = ['attribute', 'axError', 'axErrorName', 'timeoutSetAXError', 'messageTimeoutSeconds', 'elapsedMilliseconds',
    'returnedCFTypeID', 'expectedElementCFTypeID', 'valuePresent', 'cfEqual'];
  for (const [key, attribute] of [['parent', 'AXParent'], ['window', 'AXWindow']]) {
    const v = detail[key];
    requireThat(v && Object.keys(v).length === linkFields.length && Object.keys(v).every(k => linkFields.includes(k))
      && v.attribute === attribute && [v.axError, v.timeoutSetAXError].every(n => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647)
      && ['success', 'failure', 'illegal-argument', 'invalid-ui-element', 'cannot-complete', 'attribute-unsupported', 'not-implemented', 'api-disabled', 'no-value', 'other'].includes(v.axErrorName)
      && v.messageTimeoutSeconds === 0.2
      && Number.isFinite(v.elapsedMilliseconds) && v.elapsedMilliseconds >= 0 && typeof v.valuePresent === 'boolean'
      && (v.returnedCFTypeID === null || Number.isSafeInteger(v.returnedCFTypeID) && v.returnedCFTypeID > 0)
      && Number.isSafeInteger(v.expectedElementCFTypeID) && v.expectedElementCFTypeID > 0
      && v.valuePresent === (v.returnedCFTypeID !== null)
      && (v.cfEqual === null || typeof v.cfEqual === 'boolean')
      && (v.cfEqual === null || v.axError === 0 && v.valuePresent && v.returnedCFTypeID === v.expectedElementCFTypeID),
    'ax-link-diagnostic-invalid');
  }
  requireThat(['remote-ax-parent-unverified', 'remote-ax-window-unverified'].includes(error)
    && (error === 'remote-ax-parent-unverified' ? detail.parent.cfEqual !== true
      : detail.parent.cfEqual === true && detail.window.cfEqual !== true), 'ax-link-diagnostic-invalid');
}
function validateChildObservations(value) {
  requireThat(value && Object.keys(value).length === 2 && Array.isArray(value.childObservations)
    && value.childObservations.length <= 32 && typeof value.childObservationsTruncated === 'boolean', 'ax-child-observation-invalid');
  const fields = ['operation', 'attribute', 'phase', 'revision', 'axError', 'axErrorName', 'timeoutSetAXError', 'elapsedMilliseconds',
    'returnedCFTypeID', 'count', 'countExact', 'countVerified', 'node'];
  for (const d of value.childObservations) {
    requireThat(d && Object.keys(d).length === fields.length && Object.keys(d).every(k => fields.includes(k))
      && d.operation === 'AXUIElementGetAttributeValueCount' && d.attribute === 'AXChildren' && d.phase === 'traversal'
      && d.returnedCFTypeID === null && Number.isFinite(d.elapsedMilliseconds) && d.elapsedMilliseconds >= 0
      && Number.isSafeInteger(d.revision) && d.revision >= 0 && Number.isInteger(d.count)
      && /^-?\d{1,19}$/.test(d.countExact) && Number(d.countExact) === d.count
      && [0, -25205, -25212].includes(d.axError) && d.countVerified === (d.axError === 0)
      && (d.axError !== 0 || d.count === 0) && d.axErrorName === ({ 0: 'success', '-25205': 'attribute-unsupported', '-25212': 'no-value' })[d.axError]
      && Number.isInteger(d.timeoutSetAXError) && d.timeoutSetAXError >= -2147483648 && d.timeoutSetAXError <= 2147483647,
    'ax-child-observation-invalid');
    validateAXNode(d.node);
  }
}

async function rootSurfaceDiagnostic(owner, io) {
  const result = { diagnosticOnly: true, completed: false, ...acceptance };
  try {
    result.before = await io.inspectRoot('before'); validateRootInspection(result.before, owner);
    let sampleError, sampled;
    try { sampled = await io.sample(); result.surface = sampled?.receipt; } catch (error) { sampleError = error; }
    result.after = await io.inspectRoot('after'); validateRootInspection(result.after, owner);
    if (sampleError) throw sampleError;
    const surface = result.surface;
    if (surface?.errorDetail !== undefined) {
      if (surface.errorDetail?.kind === 'remote-links') {
        requireThat(surface.complete === false, 'ax-link-diagnostic-invalid');
        validateLinkFailure(surface.errorDetail, surface.error);
      }
      else {
        requireThat(surface.complete === false && ['ax-children-unbounded-or-unreadable', 'ax-children-unreadable'].includes(surface.error), 'ax-children-diagnostic-invalid');
        validateChildrenFailure(surface.errorDetail);
      }
    }
    if (surface?.axDiagnostics !== undefined) validateChildObservations(surface.axDiagnostics);
    requireThat(sampled?.exitCode === 0 && sampled.signal === null && !sampled.timedOut && !sampled.error
      && surface?.complete === true && surface.readOnly === true && surface.diagnosticOnly === true
      && surface.actionAttempted === false && surface.permissionRequestsPerformed === false && !surface.error
      && Object.keys(acceptance).every(key => surface[key] === false)
      && surface.readiness?.rootWebAreaObserved === true && surface.readiness.rootNativeCFReferencePreserved === true,
    'root-surface-capture-unverified');
    requireThat(isDeepStrictEqual(surface.process, owner.process) && isDeepStrictEqual(surface.window, owner.window),
      'post-capture-root-identity-drift');
    requireThat(Array.isArray(surface.nodes) && surface.nodes.length > 0 && surface.nodes.length <= 512
      && surface.nodes.every(node => typeof node?.role === 'string' && Buffer.byteLength(node.role, 'utf8') <= 128)
      && surface.nodes.some(node => node.role === 'AXWebArea'), 'root-surface-node-count-or-readiness-unverified');
    result.completed = true;
  } catch (error) { result.reason = error.message; }
  return result;
}

// A separate read-only sampler is needed because the unchanged action helper emits only fixed consent controls.
const surfaceSource = String.raw`
import Foundation
import ApplicationServices
import CoreGraphics
import Darwin
import CryptoKit
struct Denied: Error {
    let reason: String, detail: [String: Any]?
    init(_ reason: String, detail: [String: Any]? = nil) { self.reason = reason; self.detail = detail }
}
var rows = [[String: Any]]()
var changedSnapshots = [[String: Any]](), readiness = [String: Any](), rootRevision = 0
var nativeRootSnapshot = [String: Any]()
var childObservations = [[String: Any]](), childObservationsTruncated = false
func check(_ condition: Bool, _ reason: String) throws { if !condition { throw Denied(reason) } }
func emit(_ input: [String: Any]) {
    var value = input
    value["diagnosticOnly"] = true
    for key in ["nativeGuiAccepted", "mcpAccepted", "migrationAccepted", "updateAccepted", "releaseReady"] { value[key] = false }
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) { print(String(decoding: data, as: UTF8.self)) }
}
func admitted() throws {
    let env = ProcessInfo.processInfo.environment
    try check(env["GITHUB_ACTIONS"] == "true" && env["RUNNER_ENVIRONMENT"] == "github-hosted" && env["RUNNER_OS"] == "macOS"
        && env["GITHUB_REPOSITORY"] == "BOBWORKS-XR/CREATOR-HUB" && env["CREATOR_MACOS_OWNED_GUI_TEST"] == "1"
        && env["CREATOR_MACOS_APP_PROBE"] == "1", "hosted-ci-explicit-opt-in-required")
    #if arch(arm64)
    try check(env["RUNNER_ARCH"] == "ARM64", "runner-architecture-mismatch")
    #elseif arch(x86_64)
    try check(env["RUNNER_ARCH"] == "X64", "runner-architecture-mismatch")
    #else
    throw Denied("unsupported-native-architecture")
    #endif
}
func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    AXUIElementSetMessagingTimeout(element, 0.2)
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func bounds(_ item: AXUIElement) throws -> [String: Double] {
    guard let position = attr(item, kAXPositionAttribute), let size = attr(item, kAXSizeAttribute),
        CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { throw Denied("ax-bounds-unavailable") }
    var point = CGPoint.zero, extent = CGSize.zero
    try check(AXValueGetValue(position as! AXValue, .cgPoint, &point) && AXValueGetValue(size as! AXValue, .cgSize, &extent), "ax-bounds-unavailable")
    return ["x": Double(point.x), "y": Double(point.y), "width": Double(extent.width), "height": Double(extent.height)]
}
func axErrorName(_ status: AXError) -> String {
    switch status {
    case .success: return "success"
    case .failure: return "failure"
    case .illegalArgument: return "illegal-argument"
    case .invalidUIElement: return "invalid-ui-element"
    case .cannotComplete: return "cannot-complete"
    case .attributeUnsupported: return "attribute-unsupported"
    case .notImplemented: return "not-implemented"
    case .apiDisabled: return "api-disabled"
    case .noValue: return "no-value"
    default: return "other"
    }
}
func childrenNode(_ item: AXUIElement, _ path: String, _ depth: Int, _ role: String?, _ readPID: Int32,
                  _ rootPID: Int32, _ windowID: UInt32, _ kind: String) -> [String: Any] {
    // Cached/pre-read facts only, not post-read ownership or action authority.
    return ["path": path, "depth": depth, "role": role.map { $0 as Any } ?? NSNull(), "pid": readPID,
            "rootPID": rootPID, "windowID": windowID, "referenceKind": kind, "referenceScope": "native-invocation",
            "cfTypeID": CFGetTypeID(item), "pidSource": kind == "root-application" ? "application-reference" : "native-read"]
}
func children(_ item: AXUIElement, _ name: String, _ phase: String, _ node: [String: Any]) throws -> [AXUIElement] {
    var count = 0
    let timeoutStatus = AXUIElementSetMessagingTimeout(item, 0.2), started = ProcessInfo.processInfo.systemUptime
    var operationStarted = started
    let status = AXUIElementGetAttributeValueCount(item, name as CFString, &count)
    func refusal(_ reason: String, _ operation: String, _ result: AXError, _ classification: String,
                 _ returnedType: CFTypeID? = nil, _ returnedCount: Int? = nil,
                 _ badIndex: Int? = nil, _ badType: CFTypeID? = nil) -> Denied {
        // One bounded scalar record; no fallback AX reads, values, pointers or retries.
        return Denied(reason, detail: ["operation": operation, "attribute": name, "phase": phase,
            "classification": classification, "axError": result.rawValue, "axErrorName": axErrorName(result),
            "timeoutSetAXError": timeoutStatus.rawValue, "messageTimeoutSeconds": 0.2,
            "elapsedMilliseconds": max(0, (ProcessInfo.processInfo.systemUptime - operationStarted) * 1000),
            "count": count, "countExact": String(count), "countVerified": status == .success,
            "returnedCFTypeID": returnedType.map { $0 as Any } ?? NSNull(),
            "returnedCount": returnedCount.map { $0 as Any } ?? NSNull(),
            "unexpectedChildIndex": badIndex.map { $0 as Any } ?? NSNull(),
            "unexpectedChildCFTypeID": badType.map { $0 as Any } ?? NSNull(),
            "expectedArrayCFTypeID": CFArrayGetTypeID(), "expectedElementCFTypeID": AXUIElementGetTypeID(), "node": node])
    }
    if name == kAXChildrenAttribute && phase == "traversal" && (status == .noValue || status == .attributeUnsupported || status == .success && count == 0) {
        if childObservations.count < 32 {
            childObservations.append(["operation": "AXUIElementGetAttributeValueCount", "attribute": name, "phase": phase, "revision": rootRevision,
                "axError": status.rawValue, "axErrorName": axErrorName(status), "timeoutSetAXError": timeoutStatus.rawValue,
                "elapsedMilliseconds": max(0, (ProcessInfo.processInfo.systemUptime - started) * 1000), "returnedCFTypeID": NSNull(),
                "count": count, "countExact": String(count), "countVerified": status == .success, "node": node])
        } else { childObservationsTruncated = true }
    }
    if status == .noValue || status == .attributeUnsupported { return [] }
    if status != .success || count < 0 || count > 512 {
        throw refusal("ax-children-unbounded-or-unreadable", "AXUIElementGetAttributeValueCount", status,
                      status == .success ? "count-out-of-range" : "native-error")
    }
    if count == 0 { return [] }
    var array: CFArray?
    operationStarted = ProcessInfo.processInfo.systemUptime
    let copyStatus = AXUIElementCopyAttributeValues(item, name as CFString, 0, count, &array)
    if copyStatus != .success { throw refusal("ax-children-unreadable", "AXUIElementCopyAttributeValues", copyStatus, "native-error") }
    guard let array = array else { throw refusal("ax-children-unreadable", "validate-values", copyStatus, "missing-array") }
    let arrayType = CFGetTypeID(array)
    if arrayType != CFArrayGetTypeID() { throw refusal("ax-children-unreadable", "validate-values", copyStatus, "wrong-array-type", arrayType) }
    let actualCount = CFArrayGetCount(array)
    if actualCount != count { throw refusal("ax-children-unreadable", "validate-values", copyStatus, "array-count-mismatch", arrayType, actualCount) }
    for index in 0..<actualCount {
        guard let raw = CFArrayGetValueAtIndex(array, index) else {
            throw refusal("ax-children-unreadable", "validate-values", copyStatus, "missing-child-value", arrayType, actualCount, index)
        }
        let child = Unmanaged<CFTypeRef>.fromOpaque(raw).takeUnretainedValue(), childType = CFGetTypeID(child)
        if childType != AXUIElementGetTypeID() {
            throw refusal("ax-children-unreadable", "validate-values", copyStatus, "wrong-child-type", arrayType, actualCount, index, childType)
        }
    }
    guard let result = array as? [AXUIElement], result.count == count else {
        throw refusal("ax-children-unreadable", "validate-values", copyStatus, "bridge-failed", arrayType, actualCount)
    }
    return result
}
func pidMatches(_ item: AXUIElement, _ expected: Int32) throws {
    var pid: pid_t = 0
    try check(AXUIElementGetPid(item, &pid) == .success && pid == expected, "foreign-ax-pid")
}
func elementPID(_ item: AXUIElement) throws -> Int32 {
    var pid: pid_t = 0
    try check(AXUIElementSetMessagingTimeout(item, 0.2) == .success
        && AXUIElementGetPid(item, &pid) == .success && pid > 0, "ax-element-pid-unverified")
    return pid
}
struct RemoteProcess: Equatable {
    let pid: Int32
    let startSeconds: UInt64
    let startMicroseconds: UInt64
}
func remoteProcess(_ pid: Int32) throws -> RemoteProcess {
    var info = proc_bsdinfo()
    try check(pid > 0 && proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == Int32(MemoryLayout<proc_bsdinfo>.size)
        && info.pbi_pid == UInt32(pid) && info.pbi_start_tvsec > 0 && info.pbi_start_tvusec < 1000000, "remote-ax-process-unverified")
    // A stable PID/start stamp is a freshness guard, not WK or Root ownership.
    return RemoteProcess(pid: pid, startSeconds: info.pbi_start_tvsec, startMicroseconds: info.pbi_start_tvusec)
}
func requireRemoteRead(_ facts: [String: Bool]) throws {
${remoteReadChecks.map(([key, reason]) => `    try check(facts["${key}"] == true, "${reason}")`).join('\n')}
}
@discardableResult
func imageMatches(_ name: String, _ expected: [String: Any], _ limit: Int, contents: Bool = false) throws -> Data {
    let fd = open(name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    try check(fd >= 0, "image-open-refused"); defer { Darwin.close(fd) }
    var before = stat(), after = stat(), named = stat()
    try check(fstat(fd, &before) == 0 && before.st_mode & S_IFMT == S_IFREG && before.st_uid == getuid()
        && before.st_nlink == 1 && before.st_size > 0 && before.st_size <= Int64(limit), "image-type-owner-or-size-refused")
    var hash = SHA256(), total = 0, buffer = [UInt8](repeating: 0, count: 65536), data = Data()
    while true {
        let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
        try check(count >= 0, "image-read-failed"); if count == 0 { break }
        total += count; try check(total <= limit, "image-grew"); hash.update(data: Data(buffer.prefix(count)))
        if contents { data.append(contentsOf: buffer.prefix(count)) }
    }
    try check(fstat(fd, &after) == 0 && lstat(name, &named) == 0 && before.st_dev == after.st_dev && before.st_ino == after.st_ino
        && before.st_size == after.st_size && after.st_size == Int64(total) && before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec
        && before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec && named.st_dev == after.st_dev && named.st_ino == after.st_ino
        && named.st_mode & S_IFMT == S_IFREG && after.st_uid == getuid() && after.st_nlink == 1, "image-drift")
    try check(expected["sha256"] as? String == hash.finalize().map { String(format: "%02x", $0) }.joined()
        && expected["device"] as? String == String(after.st_dev) && expected["inode"] as? String == String(after.st_ino)
        && (expected["size"] as? NSNumber)?.int64Value == after.st_size, "pinned-image-drift")
    return data
}
func fence(_ p: [String: Any], _ parent: UInt32) throws {
    guard let pid = (p["pid"] as? NSNumber)?.int32Value, let exe = p["executablePath"] as? String,
        let app = p["bundlePath"] as? String, let image = p["image"] as? [String: Any], let plist = p["infoPlist"] as? [String: Any] else { throw Denied("owner-process-invalid") }
    var info = proc_bsdinfo(), name = [CChar](repeating: 0, count: 4096)
    try check(pid > 0 && proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) == Int32(MemoryLayout<proc_bsdinfo>.size)
        && info.pbi_pid == UInt32(pid) && info.pbi_ppid == parent && info.pbi_uid == getuid() && info.pbi_ruid == getuid()
        && info.pbi_start_tvsec == (p["startSeconds"] as? NSNumber)?.uint64Value
        && info.pbi_start_tvusec == (p["startMicroseconds"] as? NSNumber)?.uint64Value, "owned-process-start-drift")
    let length = name.withUnsafeMutableBytes { proc_pidpath(pid, $0.baseAddress, UInt32($0.count)) }
    try check(length > 0 && Int(length) < name.count && name[Int(length)] == 0 && String(cString: name) == exe, "kernel-executable-drift")
    try imageMatches(exe, image, 128 * 1024 * 1024)
    try imageMatches(app + "/Contents/Info.plist", plist, 65536)
}
func packageFields(_ bytes: Data, _ plist: [String: Any]) throws -> [String: Any] {
    try check(bytes.count > 0 && bytes.count <= 65536, "package-plist-size-invalid")
    guard let fields = try PropertyListSerialization.propertyList(from: bytes, options: [], format: nil) as? [String: Any],
          let identifier = fields["CFBundleIdentifier"] as? String, let executable = fields["CFBundleExecutable"] as? String,
          let shortVersion = fields["CFBundleShortVersionString"] as? String, let version = fields["CFBundleVersion"] as? String,
          identifier == "com.creatorworks.hub", executable == "creator-hub",
          [shortVersion, version].allSatisfy({ $0.range(of: "^[0-9]{1,6}(\\.[0-9]{1,6}){0,3}$", options: .regularExpression) != nil }) else {
        throw Denied("package-plist-identity-invalid")
    }
    return ["bundleIdentifier": identifier, "bundleExecutable": executable, "bundleShortVersion": shortVersion,
            "bundleVersion": version, "infoPlist": plist]
}
do {
    try admitted()
    let args = Array(CommandLine.arguments.dropFirst())
    if args == ["availability"] { emit(["accessibilityTrusted": AXIsProcessTrusted(), "readOnly": true]); exit(0) }
    let package = args.first == "package-identity"
    let bitmap = args.first == "bitmap-fence", rootOnly = args.first == "inspect-root" || package
    if bitmap {
        try check(args.count == 3, "bitmap-fence-owner-parent-required")
        if !CGPreflightScreenCaptureAccess() {
            emit(["command": "bitmap-fence", "screenCaptureAccess": false, "cgWindowFenceVerified": false,
                  "diagnosticOnly": true, "actionAttempted": false, "permissionRequestsPerformed": false]); exit(0)
        }
    } else { try check(args.count == (rootOnly ? 3 : 2) && AXIsProcessTrusted(), "accessibility-or-owner-required") }
    guard let parent = UInt32(args[bitmap || rootOnly ? 2 : 1]), parent > 0 else { throw Denied("owned-parent-required") }
    let file = args[bitmap || rootOnly ? 1 : 0], env = ProcessInfo.processInfo.environment
    try check(file.hasPrefix((env["RUNNER_TEMP"] ?? "invalid") + "/") && URL(fileURLWithPath: file).resolvingSymlinksInPath().path == file, "owner-path-refused")
    let fd = open(file, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    try check(fd >= 0, "owner-open-refused"); let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    var meta = stat()
    try check(fstat(fd, &meta) == 0 && meta.st_mode & S_IFMT == S_IFREG && meta.st_uid == getuid() && meta.st_nlink == 1 && meta.st_size <= 8192, "owner-file-refused")
    let data = try handle.read(upToCount: 8193) ?? Data()
    guard data.count <= 8192, let owner = try JSONSerialization.jsonObject(with: data) as? [String: Any], Set(owner.keys) == Set(["process", "window"]),
        let p = owner["process"] as? [String: Any], let w = owner["window"] as? [String: Any], let expected = w["bounds"] as? [String: Double],
        let pid = (p["pid"] as? NSNumber)?.int32Value, let id = (w["id"] as? NSNumber)?.uint32Value else { throw Denied("owner-schema-refused") }
    try check((w["pid"] as? NSNumber)?.int32Value == pid && p["bundleIdentifier"] as? String == "com.creatorworks.hub"
        && ["x", "y", "width", "height"].allSatisfy { expected[$0]?.isFinite == true }
        && (expected["width"] ?? 0) > 0 && (expected["height"] ?? 0) > 0, "root-owner-refused")
    try fence(p, parent)
    func checkCG() throws {
        guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow, .excludeDesktopElements], id) as? [[String: Any]] else { throw Denied("cg-window-unavailable") }
        let found = list.filter { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id }
        guard found.count == 1, let row = found.first, (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
            (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0, (row[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true,
            ((row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0) > 0,
            let raw = row[kCGWindowBounds as String] as? [String: Any], let b = CGRect(dictionaryRepresentation: raw as CFDictionary) else { throw Denied("cg-window-owner-drift") }
        try check(["x": Double(b.minX), "y": Double(b.minY), "width": Double(b.width), "height": Double(b.height)] == expected, "root-bounds-drift")
    }
    try checkCG()
    if bitmap {
        try fence(p, parent); try checkCG()
        emit(["command": "bitmap-fence", "screenCaptureAccess": true, "cgWindowFenceVerified": true,
              "process": p, "window": w, "diagnosticOnly": true, "actionAttempted": false,
              "permissionRequestsPerformed": false]); exit(0)
    }
    let root = AXUIElementCreateApplication(pid)
    let applicationNode = childrenNode(root, "root-application", -1, nil, pid, pid, id, "root-application")
    let matches = try children(root, kAXWindowsAttribute, "root-window-discovery", applicationNode).filter { item in
        try pidMatches(item, pid)
        try check(attr(item, kAXRoleAttribute) as? String == kAXWindowRole, "ax-window-role-unverified")
        return try bounds(item) == expected
    }
    try check(matches.count == 1, "ax-root-window-ambiguous")
    let window = matches[0], readinessDeadline = ProcessInfo.processInfo.systemUptime + 20
    nativeRootSnapshot = ["process": p, "window": w, "rootNativeCFReferencePinned": true]
    var deadline = ProcessInfo.processInfo.systemUptime + 4
    func checkHeldRoot() throws {
        try fence(p, parent); try checkCG()
        try check(AXIsProcessTrusted() && ProcessInfo.processInfo.systemUptime < deadline, "root-fence-time-or-trust-unverified")
        let current = try children(root, kAXWindowsAttribute, "root-window-recheck", applicationNode).filter { item in
            try pidMatches(item, pid)
            try check(attr(item, kAXRoleAttribute) as? String == kAXWindowRole, "ax-window-role-unverified")
            return try bounds(item) == expected
        }
        let unchanged = current.count == 1 && CFEqual(current[0], window)
        readiness["rootNativeCFReferencePreserved"] = unchanged
        try check(unchanged && ProcessInfo.processInfo.systemUptime < deadline, "root-native-cf-reference-drift")
    }
    if rootOnly {
        // Native references are compared only inside this invocation. A JSON
        // receipt is never a CF reference or authority to inspect/action controls.
        try checkHeldRoot()
        if package {
            guard let app = p["bundlePath"] as? String, let plist = p["infoPlist"] as? [String: Any] else { throw Denied("package-owner-invalid") }
            let bytes = try imageMatches(app + "/Contents/Info.plist", plist, 65536, contents: true)
            let fields = try packageFields(bytes, plist)
            try checkHeldRoot()
            emit(["command": "package-identity", "complete": true, "readOnly": true, "rootWindowOnly": true,
                "accessibilityTrusted": true, "rootNativeCFReferencePreserved": true, "rootReferenceScope": "native-invocation",
                "process": p, "window": w, "actionAttempted": false, "permissionRequestsPerformed": false,
                "package": fields]); exit(0)
        }
        emit(["command": "inspect-root", "complete": true, "readOnly": true, "rootWindowOnly": true,
            "accessibilityTrusted": true, "rootNativeCFReferencePreserved": true, "rootReferenceScope": "native-invocation",
            "process": p, "window": w, "actionAttempted": false, "permissionRequestsPerformed": false]); exit(0)
    }
    var seen = [AXUIElement]()
    var observer: AXObserver?
    let observerStatus = AXObserverCreate(pid, { _, _, _, _ in rootRevision += 1 }, &observer)
    var supported = [String]()
    if observerStatus == .success, let observer = observer {
        for item in [root, window] {
            for notification in [kAXLayoutChangedNotification, kAXCreatedNotification] {
                if AXObserverAddNotification(observer, item, notification as CFString, nil) == .success { supported.append(notification) }
            }
        }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), CFRunLoopMode.defaultMode)
    }
    defer {
        if let observer = observer { CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), CFRunLoopMode.defaultMode) }
    }
    readiness = ["rootWebAreaObserved": false, "notificationsSupported": supported, "observerStatus": observerStatus.rawValue,
                 "changesOnly": true, "rootNativeCFReferencePreserved": true]
    let labelRoles = Set(["AXWindow", "AXWebArea", "AXGroup", "AXHeading", "AXStaticText", "AXButton", "AXCheckBox", "AXRadioButton", "AXLink", "AXTab", "AXTabGroup"])
    func remoteLinks(_ item: AXUIElement, _ traversalParent: AXUIElement?, _ depth: Int,
                     _ path: String, _ readPID: Int32, _ phase: String) throws {
        try check(depth <= 16 && seen.count < 512 && ProcessInfo.processInfo.systemUptime < deadline, "ax-surface-incomplete")
        var parentMatches = false, windowMatches = false
        // Apple kAXParentAttribute is the hierarchy parent; kAXWindowAttribute
        // is the containing window. Neither establishes process/WK ownership.
        // Required native associations: nil/error/wrong CF type never becomes
        // permission. No PID, process name, uid, or launchd ancestry substitutes.
        func link(_ name: String, _ expected: AXUIElement?) -> (CFTypeRef?, [String: Any]) {
            // The same single native read as before, with its scalar result retained.
            let timeout = AXUIElementSetMessagingTimeout(item, 0.2), started = ProcessInfo.processInfo.systemUptime
            var value: CFTypeRef?
            let status = AXUIElementCopyAttributeValue(item, name as CFString, &value)
            let type = value.map { CFGetTypeID($0) }
            var equal: Bool?
            if status == .success, let value = value, type == AXUIElementGetTypeID(), let expected = expected {
                equal = CFEqual(value as! AXUIElement, expected)
            }
            return (status == .success ? value : nil, ["attribute": name, "axError": status.rawValue,
                "axErrorName": axErrorName(status), "timeoutSetAXError": timeout.rawValue, "messageTimeoutSeconds": 0.2,
                "elapsedMilliseconds": max(0, (ProcessInfo.processInfo.systemUptime - started) * 1000),
                "returnedCFTypeID": type.map { $0 as Any } ?? NSNull(), "expectedElementCFTypeID": AXUIElementGetTypeID(),
                "valuePresent": value != nil, "cfEqual": equal.map { $0 as Any } ?? NSNull()])
        }
        let parentRead = link(kAXParentAttribute, traversalParent), windowRead = link(kAXWindowAttribute, window)
        if let traversalParent = traversalParent, let linked = parentRead.0, CFGetTypeID(linked) == AXUIElementGetTypeID() {
            parentMatches = CFEqual(linked as! AXUIElement, traversalParent)
        }
        if let linked = windowRead.0, CFGetTypeID(linked) == AXUIElementGetTypeID() {
            windowMatches = CFEqual(linked as! AXUIElement, window)
        }
        do {
            try requireRemoteRead(["nodeIdentityVerified": true, "parentMatchesTraversalParent": parentMatches,
                "windowMatchesHeldRoot": windowMatches, "rootUnchanged": true,
                "withinLimits": depth <= 16 && seen.count < 512 && ProcessInfo.processInfo.systemUptime < deadline,
                "metadataOnly": true])
        } catch let failure as Denied {
            if ["remote-ax-parent-unverified", "remote-ax-window-unverified"].contains(failure.reason) {
                throw Denied(failure.reason, detail: ["kind": "remote-links", "phase": phase,
                    "node": childrenNode(item, path, depth, nil, readPID, pid, id, "traversal-node"),
                    "parent": parentRead.1, "window": windowRead.1])
            }
            throw failure
        }
    }
    func visit(_ item: AXUIElement, _ depth: Int, _ path: String, _ traversalParent: AXUIElement?) throws {
        try check(depth <= 16 && seen.count < 512 && ProcessInfo.processInfo.systemUptime < deadline, "ax-surface-incomplete")
        let readPID = try elementPID(item), remote = readPID != pid
        var remoteBefore: RemoteProcess?
        if remote {
            try checkHeldRoot()
            remoteBefore = try remoteProcess(readPID)
            try remoteLinks(item, traversalParent, depth, path, readPID, "before-metadata")
        } else {
            try pidMatches(item, pid)
            if !CFEqual(item, window), let linked = attr(item, kAXWindowAttribute) {
                try check(CFGetTypeID(linked) == AXUIElementGetTypeID() && CFEqual(linked as! AXUIElement, window), "foreign-ax-window")
            }
        }
        if seen.contains(where: { CFEqual($0, item) }) { return }
        guard let role = attr(item, kAXRoleAttribute) as? String, role.utf8.count <= 128 else { throw Denied("ax-role-unreadable") }
        let b = try? bounds(item)
        let contained = b.map { $0["width"]! > 0 && $0["height"]! > 0 && $0["x"]! >= expected["x"]! && $0["y"]! >= expected["y"]!
            && $0["x"]! + $0["width"]! <= expected["x"]! + expected["width"]! && $0["y"]! + $0["height"]! <= expected["y"]! + expected["height"]! } ?? false
        var row: [String: Any] = ["path": path, "role": role, "pid": readPID, "rootPID": pid, "windowID": id, "withinRootBounds": contained,
            "association": remote ? "native-parent-and-root-window" : "root-pid", "diagnosticOnly": true]
        if let b = b { row["bounds"] = b }
        if contained && labelRoles.contains(role) {
            for (key, attribute) in [("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute)] {
                if let text = attr(item, attribute) as? String {
                    try check(text.utf8.count <= 2048, "ax-label-too-large"); row[key] = text
                }
            }
        }
        let childNode = childrenNode(item, path, depth, role, readPID, pid, id, CFEqual(item, window) ? "held-root-window" : "traversal-node")
        let descendants = try children(item, kAXChildrenAttribute, "traversal", childNode)
        if remote {
            try check(try elementPID(item) == readPID, "remote-ax-pid-drift")
            try check(try remoteProcess(readPID) == remoteBefore, "remote-ax-process-drift")
            try remoteLinks(item, traversalParent, depth, path, readPID, "after-metadata")
            try checkHeldRoot()
            row["nativeParentMatchesTraversalParent"] = true; row["nativeWindowMatchesHeldRoot"] = true
            row["rootNativeCFReferencePreserved"] = true; row["readOnly"] = true; row["actionAttempted"] = false
        }
        // Append only after all post-read association/process/Root fences pass.
        rows.append(row); seen.append(item)
        for (index, child) in descendants.enumerated() { try visit(child, depth + 1, path + "/" + String(index), item) }
    }
    var previousSnapshot: Data?, observedRevision = -1, observationCount = 0
    while ProcessInfo.processInfo.systemUptime < readinessDeadline {
        if observedRevision != rootRevision {
            try check(observationCount < 32, "root-readiness-change-limit")
            observationCount += 1
            deadline = min(readinessDeadline, ProcessInfo.processInfo.systemUptime + 4)
            try checkHeldRoot()
            rows = []; seen = []; childObservations = []; childObservationsTruncated = false
            try visit(window, 0, "root-window", nil)
            try checkHeldRoot()
            let snapshot = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
            if snapshot != previousSnapshot {
                changedSnapshots.append(["revision": rootRevision, "nodes": rows, "rootNativeCFReferencePreserved": true])
                previousSnapshot = snapshot
            }
            observedRevision = rootRevision
            if rows.contains(where: { $0["role"] as? String == "AXWebArea" }) { readiness["rootWebAreaObserved"] = true; break }
        }
        try check(!supported.isEmpty, "root-readiness-notifications-unavailable")
        let remaining = readinessDeadline - ProcessInfo.processInfo.systemUptime
        if remaining <= 0 { break }
        let outcome = CFRunLoopRunInMode(CFRunLoopMode.defaultMode, remaining, true)
        try check(outcome != .finished && outcome != .stopped, "root-readiness-runloop-unavailable")
    }
    readiness["changedSnapshotCount"] = changedSnapshots.count
    readiness["observationCount"] = observationCount
    readiness["deadlineExpired"] = readiness["rootWebAreaObserved"] as? Bool != true
    try check(readiness["rootWebAreaObserved"] as? Bool == true, "root-web-area-readiness-unverified")
    emit(["complete": true, "readOnly": true, "nodes": rows, "snapshots": changedSnapshots, "readiness": readiness, "nativeRootSnapshot": nativeRootSnapshot,
          "axDiagnostics": ["childObservations": childObservations, "childObservationsTruncated": childObservationsTruncated],
          "window": w, "process": p, "actionAttempted": false, "permissionRequestsPerformed": false])
} catch {
    var failure: [String: Any] = ["complete": false, "readOnly": true, "nodes": rows, "snapshots": changedSnapshots, "readiness": readiness, "nativeRootSnapshot": nativeRootSnapshot,
          "axDiagnostics": ["childObservations": childObservations, "childObservationsTruncated": childObservationsTruncated],
          "error": (error as? Denied)?.reason ?? "surface-unverified", "actionAttempted": false, "permissionRequestsPerformed": false]
    if let detail = (error as? Denied)?.detail { failure["errorDetail"] = detail }
    emit(failure); exit(2)
}
`;

async function probe(args, env) {
  admission(env, process.platform, process.arch);
  const request = options(args), temporary = canonical(env.RUNNER_TEMP || '');
  if (request.launchContext) rootDiagnostics.launchControl(request.launchContext, env, request.expectedVersion);
  canonical(request.app); requireThat(inside(temporary, request.app) && request.app.endsWith('.app'), 'root-app-outside-runner-temp');
  const executable = path.join(request.app, 'Contents/MacOS/creator-hub'), info = path.join(request.app, 'Contents/Info.plist');
  const executablePin = pin(executable), infoPin = pin(info, 65536);
  requireThat(executablePin.image.sha256 === request.hubSha256, 'independent-hub-hash-mismatch');
  let sourcePin, sourceIdentity = { status: 'unresolved', reason: 'independent-assembly-receipt-not-supplied' };
  if (request.assemblyReceipt) {
    canonical(request.assemblyReceipt);
    requireThat(inside(temporary, request.assemblyReceipt) && !inside(request.app, request.assemblyReceipt)
      && path.basename(request.assemblyReceipt) === 'signed-unix-assembly.json', 'independent-assembly-receipt-path-required');
    sourcePin = pin(request.assemblyReceipt, 16384, true);
    requireThat(sourcePin.image.sha256 === request.assemblyReceiptSha256, 'independent-assembly-receipt-hash-mismatch');
    sourceIdentity = { status: 'caller-hash-bound-receipt', receiptImage: sourcePin.image,
      ...assemblyIdentity(sourcePin.bytes, process.arch === 'arm64' ? 'aarch64' : 'x86_64', request.expectedVersion),
      callerSelectedHubSha256: request.hubSha256, artifactToImageBindingVerified: false,
      provenance: 'not-independently-verified-by-probe' };
  }
  const cpu = process.arch === 'arm64' ? 0x0100000c : 0x01000007;
  requireThat(executablePin.head.length >= 8 && executablePin.head.readUInt32LE(0) === 0xfeedfacf
    && executablePin.head.readUInt32LE(4) === cpu, 'exact-native-thin-mach-o-required');
  const output = reserveOutput(temporary, request.app, request.output), report = { schemaVersion: 1, diagnosticOnly: true, scope: 'Owned Root AX surface/window bitmap diagnostics only; not product acceptance.',
    ...acceptance, passed: false, captureCompleted: false, acceptedExit: false, cleanupUncertain: false,
    app: request.app, executable, suppliedHubSha256: request.hubSha256, runnerArchitecture: env.RUNNER_ARCH,
    packageSourceIdentity: sourceIdentity,
    probeSourceIdentity: { commit: /^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '') ? env.GITHUB_SHA : null,
      runId: /^\d{1,15}$/.test(env.GITHUB_RUN_ID || '') ? Number(env.GITHUB_RUN_ID) : null },
    childPid: null, ownedChildExit: null, tools: [],
    windowBitmap: { diagnosticOnly: true, attempted: false, completed: false, reason: 'owned-live-window-not-available', ...acceptance } };
  const write = (name, data) => fs.writeFileSync(path.join(output, name), typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  let child, rootPid, owner, ownerImage, closeReceipt, ownedExit = null, toolUncertain = false, sequence = 0;
  report.launchContext = request.launchContext || 'direct-private';
  function retainForeign(receipt, label) {
    if (receipt?.foreignElement && !report.foreignElementReceipt) {
      report.foreignElementReceipt = path.join(output, 'foreign-element.json');
      write('foreign-element.json', { sourceLabel: label, foreignElement: receipt.foreignElement, diagnosticOnly: true, ...acceptance });
    }
  }
  const toolEnv = { ...env, RUNNER_TEMP: temporary };
  async function command(file, argv, label, ms = 15000, expectedImage) {
    if (expectedImage) requireThat(sameImage(pin(file).image, expectedImage), 'compiled-tool-image-drift');
    const prefix = `${String(sequence++).padStart(2, '0')}-${label}`;
    const stdout = path.join(output, `${prefix}.stdout`), stderr = path.join(output, `${prefix}.stderr`);
    const outFD = fs.openSync(stdout, 'wx', 0o600), errFD = fs.openSync(stderr, 'wx', 0o600);
    let task;
    try { task = spawn(file, argv, { env: toolEnv, cwd: output, stdio: ['ignore', outFD, errFD] }); }
    finally { fs.closeSync(outFD); fs.closeSync(errFD); }
    const result = await new Promise(resolve => {
      const timer = setTimeout(() => { toolUncertain = true; task.unref(); resolve({ timedOut: true, exitCode: null, signal: null }); }, ms);
      task.once('error', error => { clearTimeout(timer); resolve({ exitCode: null, signal: null, error: error.code }); });
      task.once('exit', (code, signal) => { clearTimeout(timer); resolve({ exitCode: code, signal, timedOut: false }); });
    });
    const record = { label, file, argv, stdout, stderr, ...result }; report.tools.push(record); write(`${prefix}.json`, record);
    requireThat(!result.timedOut && !result.error && result.signal === null, 'tool-exit-unverified-no-termination-attempted');
    if (expectedImage) requireThat(sameImage(pin(file).image, expectedImage), 'compiled-tool-image-drift');
    const fd = fs.openSync(stdout, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let text;
    try {
      requireThat(fs.fstatSync(fd).isFile() && fs.fstatSync(fd).size <= 1024 * 1024, 'tool-output-too-large');
      const buffer = Buffer.alloc(1024 * 1024 + 1), count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      requireThat(count <= 1024 * 1024, 'tool-output-too-large'); text = buffer.subarray(0, count).toString('utf8');
    } finally { fs.closeSync(fd); }
    return { ...result, text };
  }
  const waitExit = async ms => {
    const deadline = Date.now() + ms;
    while (!ownedExit && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    return ownedExit;
  };
  try {
    write('plan.json', report);
    if (sourcePin) write('assembly-receipt.json', sourcePin.bytes);
    const source = pin(path.join(__dirname, 'native-macos-window.swift'), 1024 * 1024, true);
    write('native-macos-window.swift', source.bytes); write('root-surface.swift', surfaceSource);
    const helper = path.join(output, 'native-macos-window'), sampler = path.join(output, 'root-surface');
    for (const [sourceName, binary, label] of [['native-macos-window.swift', helper, 'compile-helper'], ['root-surface.swift', sampler, 'compile-surface']]) {
      const result = await command('/usr/bin/swiftc', [path.join(output, sourceName), '-o', binary], label, 120000);
      requireThat(result.exitCode === 0, 'native-probe-compilation-failed');
    }
    const helperImage = pin(helper).image, samplerImage = pin(sampler).image;
    report.helper = { path: helper, image: helperImage, sourceSha256: source.image.sha256 };
    report.sampler = { path: sampler, image: samplerImage, sourceSha256: crypto.createHash('sha256').update(surfaceSource, 'utf8').digest('hex') };
    for (const [file, image, label] of [[helper, helperImage, 'availability-helper'], [sampler, samplerImage, 'availability-surface']]) {
      const result = await command(file, ['availability'], label, 15000, image);
      requireThat(result.exitCode === 0 && JSON.parse(result.text).accessibilityTrusted === true, 'existing-ax-trust-required-no-prompt');
    }
    requireThat(sameImage(pin(executable).image, executablePin.image) && sameImage(pin(info, 65536).image, infoPin.image), 'root-files-changed-before-launch');
    if (sourcePin) requireThat(sameImage(pin(request.assemblyReceipt, 16384).image, sourcePin.image), 'assembly-receipt-drift');
    const rootEnv = report.launchContext === 'direct-private' ? privateProfile(output) : rootDiagnostics.ordinaryProfile(env);
    const suppliedTmpdir = rootEnv.TMPDIR;
    rootEnv.TMPDIR = fs.realpathSync(rootEnv.TMPDIR) + path.sep;
    canonical(rootEnv.HOME); canonical(rootEnv.TMPDIR.replace(/\/$/, ''));
    let launchStarted = Date.now();
    if (report.launchContext === 'launchservices-ordinary') {
      const launchSource = pin(path.join(__dirname, 'native-macos-launchservices.swift'), 65536, true);
      write('native-macos-launchservices.swift', launchSource.bytes); write('launch-environment.json', rootEnv);
      const launcher = path.join(output, 'native-macos-launchservices');
      const compiled = await command('/usr/bin/swiftc', [path.join(output, 'native-macos-launchservices.swift'), '-o', launcher], 'compile-launchservices', 120000);
      requireThat(compiled.exitCode === 0, 'launchservices-diagnostic-helper-compilation-failed');
      const launcherImage = pin(launcher).image;
      launchStarted = Date.now();
      const launched = await command(launcher, [request.app, path.join(output, 'launch-environment.json')], 'launchservices-open', 15000, launcherImage);
      const receipt = JSON.parse(launched.text);
      requireThat(launched.exitCode === 0 && receipt.diagnosticOnly === true && receipt.method === 'native-launchservices-open-application'
        && receipt.app === request.app && receipt.executable === executable && receipt.bundleIdentifier === bundle
        && receipt.rootExitStatusKnown === false && receipt.nativeGuiAccepted === false && receipt.releaseReady === false,
      'launchservices-result-not-kernel-ownership');
      rootPid = receipt.pid; report.launchServicesReceipt = receipt;
      report.launchServicesHelper = { sourceSha256: launchSource.image.sha256, image: launcherImage };
      // No invented Node ChildProcess or owned Root exit code for LaunchServices.
    } else {
      const logFD = fs.openSync(path.join(output, 'root.stdout'), 'wx', 0o600), errFD = fs.openSync(path.join(output, 'root.stderr'), 'wx', 0o600);
      try { child = spawn(executable, [], { cwd: rootEnv.HOME, env: rootEnv, stdio: ['ignore', logFD, errFD] }); }
      finally { fs.closeSync(logFD); fs.closeSync(errFD); }
      child.once('exit', (code, signal) => { ownedExit = { pid: child.pid, code, signal }; });
      child.once('error', error => { ownedExit = { pid: child.pid ?? null, code: null, signal: null, error: error.code }; });
      rootPid = child.pid; report.childPid = child.pid;
    }
    requireThat(Number.isSafeInteger(rootPid) && rootPid > 0, 'owned-root-launch-unverified');
    report.rootPid = rootPid;
    write('launch.json', { pid: rootPid, executable, profile: rootEnv, suppliedTmpdir, context: report.launchContext,
      environmentReceipt: report.launchContext === 'launchservices-ordinary'
        ? { kind: 'requested-LaunchServices-overrides', fullChildEnvironmentVerified: false }
        : { kind: 'supplied-Node-spawn-environment', fullChildEnvironmentVerified: false }, ...acceptance });
    const expected = { pid: rootPid, executable, app: request.app, image: executablePin.image, infoPlist: infoPin.image };
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      requireThat(!ownedExit, 'owned-root-exited-before-identification');
      const result = await command(helper, ['identify', String(rootPid), request.app, executable, request.hubSha256, bundle],
        'identify', Math.min(15000, Math.max(1, deadline - Date.now())), helperImage);
      const receipt = JSON.parse(result.text);
      if (result.exitCode === 0) {
        requireThat(Array.isArray(receipt.windows) && receipt.windows.length <= 1, 'root-window-ambiguous');
        if (receipt.windows.length === 1) {
          const candidate = { process: receipt.process, window: receipt.windows[0] };
          validateOwner(candidate, expected);
          requireThat(candidate.process.startSeconds * 1000 + candidate.process.startMicroseconds / 1000 >= launchStarted,
            'preexisting-root-instance-not-a-launch-control');
          owner = candidate; break;
        }
      } else requireThat(receipt.error === 'native-app-not-ready', 'root-native-identification-refused');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    requireThat(owner, 'owned-root-window-readiness-expired'); write('owner.json', owner);
    const ownerPath = path.join(output, 'owner.json');
    ownerImage = pin(ownerPath, 8192).image;
    const captureOwnerFence = () => requireThat(!toolUncertain && !ownedExit && sameImage(pin(ownerPath, 8192).image, ownerImage),
      'capture-owner-or-tool-state-unverified');
    captureOwnerFence();
    const identityResult = await command(sampler, ['package-identity', ownerPath, String(process.pid)], 'package-identity', 15000, samplerImage);
    requireThat(identityResult.exitCode === 0, 'native-package-identity-refused');
    const packageReceipt = JSON.parse(identityResult.text);
    report.packageIdentity = packageReceipt; report.packageIdentityValidated = false;
    write('package-identity.json', packageReceipt);
    validatePackageIdentity(packageReceipt, owner, request.expectedVersion);
    captureOwnerFence();
    if (sourcePin) requireThat(sameImage(pin(request.assemblyReceipt, 16384).image, sourcePin.image), 'assembly-receipt-drift');
    report.packageIdentityValidated = true;
    report.rootSurface = await rootSurfaceDiagnostic(owner, {
      inspectRoot: async stage => {
        captureOwnerFence();
        const result = await command(sampler, ['inspect-root', ownerPath, String(process.pid)], `inspect-root-${stage}`, 15000, samplerImage);
        requireThat(result.exitCode === 0, 'read-only-root-inspection-refused');
        captureOwnerFence();
        return JSON.parse(result.text);
      },
      sample: async () => {
        captureOwnerFence();
        const result = await command(sampler, [ownerPath, String(process.pid)], 'surface', 30000, samplerImage);
        const receipt = JSON.parse(result.text); write('surface.json', { ...receipt, ...acceptance });
        captureOwnerFence();
        return { ...result, receipt };
      },
    });
    write('root-surface-diagnostic.json', report.rootSurface);
    requireThat(report.rootSurface.completed === true, report.rootSurface.reason || 'root-surface-capture-unverified');
    const surface = report.rootSurface.surface;
    report.surfaceSummary = { nodeCount: surface.nodes.length, rootWebAreaObserved: surface.nodes.some(node => node.role === 'AXWebArea'),
      roleCounts: Object.fromEntries([...new Set(surface.nodes.map(node => node.role))].map(role => [role, surface.nodes.filter(node => node.role === role).length])) };
    report.captureCompleted = true;
  } catch (error) { report.error = error.message; }
  finally {
    if (rootPid && owner && !ownedExit && !toolUncertain) {
      try {
        if (request.launchContext) {
          const captureAt = owner.process.startSeconds * 1000 + owner.process.startMicroseconds / 1000 + 20000;
          const remaining = captureAt - Date.now();
          if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
          report.controlBitmapAgeMilliseconds = Date.now() - owner.process.startSeconds * 1000 - owner.process.startMicroseconds / 1000;
          requireThat(report.controlBitmapAgeMilliseconds >= 20000, 'control-bitmap-age-unverified');
        }
        const directory = path.join(output, 'window-bitmap');
        fs.mkdirSync(directory, { mode: 0o700 }); canonical(directory);
        const file = path.join(directory, 'root-window.png'), sampler = report.sampler;
        report.windowBitmap = await windowBitmapDiagnostic(owner, {
          fence: async stage => {
            requireThat(!toolUncertain && !ownedExit && ownerImage && sameImage(pin(path.join(output, 'owner.json'), 8192).image, ownerImage), 'bitmap-owner-or-tool-state-unverified');
            const result = await command(sampler.path, ['bitmap-fence', path.join(output, 'owner.json'), String(process.pid)], `bitmap-fence-${stage}`, 15000, sampler.image);
            requireThat(result.exitCode === 0, 'bitmap-native-fence-refused');
            return JSON.parse(result.text);
          },
          capture: async id => {
            requireThat(!ownedExit && !toolUncertain, 'bitmap-owned-child-not-live');
            try { fs.lstatSync(file); throw Error('bitmap-output-already-exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            return command('/usr/sbin/screencapture', bitmapArguments(id, file), 'window-bitmap', 15000);
          },
          image: () => { const image = bitmapImage(file); fs.chmodSync(file, 0o600); return { path: file, ...image }; },
        });
        write('window-bitmap/receipt.json', report.windowBitmap);
      } catch (error) { report.windowBitmap = { diagnosticOnly: true, completed: false, reason: error.message, ...acceptance }; }
    }
    if (rootPid && owner && !ownedExit && !toolUncertain) {
      report.rootFailureDiagnostics = await rootDiagnostics.diagnostic(owner, {
        now: () => Date.now(),
        fence: async stage => {
          requireThat(ownerImage && sameImage(pin(path.join(output, 'owner.json'), 8192).image, ownerImage), 'diagnostic-owner-file-drift');
          const sampler = report.sampler;
          const result = await command(sampler.path, ['bitmap-fence', path.join(output, 'owner.json'), String(process.pid)], `log-fence-${stage}`, 15000, sampler.image);
          requireThat(result.exitCode === 0, 'diagnostic-native-root-fence-refused'); return JSON.parse(result.text);
        },
        run: plan => rootDiagnostics.runLog(plan, toolEnv),
      });
      if (report.rootFailureDiagnostics.toolLifetimeUncertain === true) toolUncertain = true;
      write('root-failure-diagnostics.json', report.rootFailureDiagnostics);
      try {
        const signature = await command('/usr/bin/codesign', ['--display', '--verbose=4', '--entitlements', ':-', request.app], 'readonly-code-signature', 15000);
        report.codeSignatureInspection = { exitCode: signature.exitCode, actionAttempted: false, diagnosticOnly: true };
      } catch (error) { report.codeSignatureInspection = { error: error.message, actionAttempted: false, diagnosticOnly: true }; }
    }
    if (rootPid && owner && !ownedExit && !toolUncertain) {
      try {
        const helper = report.helper;
        requireThat(ownerImage && sameImage(pin(path.join(output, 'owner.json'), 8192).image, ownerImage), 'owner-file-drift-no-close-attempted');
        const close = await command(helper.path, ['close', path.join(output, 'owner.json')], 'normal-close', 15000, helper.image);
        closeReceipt = JSON.parse(close.text);
        retainForeign(closeReceipt, 'normal-close');
        requireThat(close.exitCode === 0, 'normal-close-refused-or-post-identity-unverified');
      } catch (error) { report.closeError = error.message; }
    }
    if (child) await waitExit(15000);
    report.ownedChildExit = ownedExit;
    report.closeAssessment = closeAssessment(closeReceipt, ownedExit, owner);
    report.acceptedExit = acceptedExit(closeReceipt, ownedExit, owner) && !report.closeError;
    report.cleanupUncertain = toolUncertain || !!rootPid && !ownedExit;
    report.passed = report.captureCompleted && report.acceptedExit && !report.error && !report.cleanupUncertain;
    write('report.json', report);
    if (child && !ownedExit) child.unref();
  }
  return { report: path.join(output, 'report.json'), surface: fs.existsSync(path.join(output, 'surface.json')) ? path.join(output, 'surface.json') : null,
    bitmap: report.windowBitmap?.completed ? report.windowBitmap.image.path : null,
    passed: report.passed, ...acceptance };
}

if (require.main === module) {
  probe(process.argv.slice(2), process.env).then(result => {
    console.log(JSON.stringify(result)); process.exitCode = result.passed ? 0 : 2;
  }).catch(error => { console.log(JSON.stringify({ error: error.message, passed: false, ...acceptance })); process.exitCode = 2; });
}
module.exports = { admission, options, reserveOutput, pin, sameImage, validateOwner, privateProfile, acceptedExit, closeAssessment,
  bitmapArguments, bitmapImage, windowBitmapDiagnostic, remoteReadPolicy, validateRootInspection, validateChildrenFailure, verifiedRootCloseDialog,
  assemblyIdentity, validatePackageIdentity, validateLinkFailure, validateChildObservations, rootSurfaceDiagnostic, acceptance, surfaceSource };
