// Unsigned publication preparation only. No key selection, signing, execution or upload.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const semver = require('semver');
const { LIMITS, validateInventory } = require('./linux-016-portable-package.cjs');

const NAME = 'creator-hub-linux-x86_64-portable.json';
const PACKAGE = 'portable-appdir';
const SCOPE = 'linux-portable-update-normal-exit-v1';
const CHECKS = Object.freeze(['installCancelReadOnly', 'signedPackageVerified', 'invalidSignatureRefused',
  'staleSelectionRefused', 'stageKeptOldSelection', 'normalOldExitBeforeSelection',
  'abnormalExitKeptOldSelection', 'authenticatedReady', 'automaticRestart',
  'selectedImageVerified', 'settingsPreserved', 'mcpPreserved', 'normalNewExit']);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function keys(value, fields) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Object required');
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort(), 'Contract fields differ');
}
function version(value) {
  const parsed = typeof value === 'string' && semver.parse(value);
  assert.ok(typeof value === 'string' && value.length <= 64 && parsed && parsed.version === value && !parsed.prerelease.length && !parsed.build.length,
    'Canonical stable portable version required');
}
function sha(value, length = 64) { assert.match(value, new RegExp(`^[a-f0-9]{${length}}$`)); }
function pin(value, maximum) {
  keys(value, ['byteLength', 'sha256']); sha(value.sha256);
  assert.ok(Number.isSafeInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= maximum,
    'Byte binding exceeds bound');
}
function names(value) {
  version(value);
  return { manifest: `creator-hub-linux-x86_64-${value}.portable-manifest.json`,
    archive: `creator-hub-linux-x86_64-${value}.appdir.tar.gz` };
}
function canonical(bytes, maximum) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum, 'Bounded JSON required');
  const value = JSON.parse(bytes.toString('utf8'));
  assert.ok(bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`)),
    'Exact canonical JSON required; duplicate keys, invalid UTF-8 and alternate bodies refused');
  return value;
}
function descriptor(manifestBytes, archive, receipt) {
  const m = canonical(manifestBytes, LIMITS.manifest);
  keys(m, ['schemaVersion', 'appId', 'platform', 'architecture', 'version', 'sourceCommit', 'sourceTree',
    'format', 'entrypoint', 'archive', 'entries']);
  assert.equal(m.schemaVersion, 1); assert.equal(m.appId, 'creator-hub');
  assert.equal(m.platform, 'linux'); assert.equal(m.architecture, 'x86_64'); version(m.version);
  sha(m.sourceCommit, 40); sha(m.sourceTree, 40);
  assert.equal(m.format, 'appdir-tar-gzip-v1'); assert.equal(m.entrypoint, 'usr/bin/creator-hub');
  keys(m.archive, ['size', 'sha256', 'unpackedSize']);
  pin(archive, LIMITS.archive);
  assert.deepEqual(archive, { byteLength: m.archive.size, sha256: m.archive.sha256 }, 'Archive differs from manifest');
  validateInventory({ entries: m.entries, links: {}, unpackedSize: m.archive.unpackedSize });
  const root = m.entries[m.entrypoint], runner = m.entries.AppRun, profile = m.entries['creator-hub-portable-host.json'];
  assert.ok(root?.kind === 'file' && root.mode === 0o755 && root.size >= 20, 'Signed Root entry required');
  assert.ok(runner?.kind === 'file' && runner.mode === 0o755 && runner.size > 0, 'Signed AppRun required');
  assert.ok(profile?.kind === 'file' && profile.mode === 0o644 && profile.size > 0 && profile.size <= 4096,
    'Signed portable host profile required');
  const manifest = { byteLength: manifestBytes.length, sha256: hash(manifestBytes) };
  keys(receipt, ['schemaVersion', 'scope', 'appId', 'version', 'platform', 'architecture', 'packageType',
    'manifest', 'archive', 'executableSha256', 'sourceCommit', 'sourceTree', 'approvedForStable',
    'minHubVersion', 'checks', 'evidence']);
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.scope, SCOPE);
  assert.equal(receipt.approvedForStable, true, 'Reviewed stable acceptance required');
  for (const n of ['appId', 'version', 'platform', 'architecture', 'sourceCommit', 'sourceTree']) {
    assert.equal(receipt[n], m[n], `Receipt differs from exact package: ${n}`);
  }
  assert.equal(receipt.packageType, PACKAGE); assert.equal(receipt.executableSha256, root.sha256);
  assert.deepEqual(receipt.manifest, manifest, 'Receipt differs from exact signed manifest body');
  assert.deepEqual(receipt.archive, archive, 'Receipt differs from exact archive');
  version(receipt.minHubVersion);
  assert.ok(semver.lte(receipt.minHubVersion, m.version), 'Minimum Hub exceeds target');
  keys(receipt.checks, CHECKS);
  for (const n of CHECKS) assert.equal(receipt.checks[n], true, `Native acceptance missing: ${n}`);
  assert.ok(Array.isArray(receipt.evidence) && receipt.evidence.length > 0 && receipt.evidence.length <= 16
    && new Set(receipt.evidence).size === receipt.evidence.length && receipt.evidence.every(url =>
      typeof url === 'string' && /^https:\/\/github\.com\/BOBWORKS-XR\/CREATOR-HUB\/actions\/runs\/[1-9][0-9]*$/.test(url)),
  'Reviewed native acceptance runs required');
  const assets = names(m.version);
  return { schemaVersion: 1, appId: m.appId, version: m.version, platform: m.platform,
    architecture: m.architecture, packageType: PACKAGE,
    manifest: { assetName: assets.manifest, ...manifest }, archive: { assetName: assets.archive, ...archive },
    executableSha256: root.sha256, restartProtocol: 1, minHubVersion: receipt.minHubVersion };
}

function absolute(file) {
  assert.ok(typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file,
    'Canonical absolute path required');
  for (let item = file;; item = path.dirname(item)) {
    try { assert.equal(fs.lstatSync(item).isSymbolicLink(), false, 'Redirected path refused'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(item) === item) break;
  }
}
function identity(value) {
  return [value.dev, value.ino, value.mode, value.nlink, value.size, value.mtimeNs, value.ctimeNs, value.birthtimeNs];
}
function capture(file, maximum, includeBytes = false) {
  absolute(file);
  const before = fs.lstatSync(file, { bigint: true });
  assert.ok(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(maximum), 'Bounded regular file required');
  const fd = fs.openSync(file, 'r');
  try {
    const held = fs.fstatSync(fd, { bigint: true });
    // Windows lstat/fstat ctime views can differ; stable file ID/birthtime still bind the handle.
    const binding = value => [value.dev, value.ino, value.mode, value.nlink, value.size, value.mtimeNs, value.birthtimeNs];
    assert.deepEqual(binding(held), binding(before), 'Input changed during open');
    const digest = crypto.createHash('sha256'), chunks = [], block = Buffer.alloc(1024 * 1024);
    let size = 0, count;
    while ((count = fs.readSync(fd, block)) !== 0) {
      size += count; assert.ok(size <= maximum && BigInt(size) <= held.size, 'Input grew during read');
      digest.update(block.subarray(0, count));
      if (includeBytes) chunks.push(Buffer.from(block.subarray(0, count)));
    }
    assert.equal(BigInt(size), held.size, 'Input truncated during read');
    assert.deepEqual(identity(fs.fstatSync(fd, { bigint: true })), identity(held), 'Held input changed');
    absolute(file);
    assert.deepEqual(identity(fs.lstatSync(file, { bigint: true })), identity(before), 'Named input changed');
    return { record: { byteLength: size, sha256: digest.digest('hex') },
      ...(includeBytes ? { bytes: Buffer.concat(chunks) } : {}) };
  } finally { fs.closeSync(fd); }
}

function prepare({ manifest, archive, receipt, output }) {
  for (const file of [manifest, archive, receipt, output]) absolute(file);
  const m = capture(manifest, LIMITS.manifest, true), a = capture(archive, LIMITS.archive), r = capture(receipt, 32768, true);
  const value = descriptor(m.bytes, a.record, canonical(r.bytes, 32768));
  assert.equal(path.basename(archive), value.archive.assetName, 'Use exact public archive filename');
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  assert.ok(bytes.length <= 32768);
  // This is intentionally not a signer. Production signing/verification remains a separate gate.
  assert.equal(fs.existsSync(output), false, 'Output already exists; nothing was overwritten');
  for (const [file, expected, maximum] of [[manifest, m.record, LIMITS.manifest], [archive, a.record, LIMITS.archive], [receipt, r.record, 32768]]) {
    assert.deepEqual(capture(file, maximum).record, expected, 'Publication input changed');
  }
  fs.mkdirSync(output, { mode: 0o700 });
  fs.writeFileSync(path.join(output, `${NAME}.unsigned`), bytes, { flag: 'wx', mode: 0o600 });
  return { descriptorName: NAME, descriptor: { byteLength: bytes.length, sha256: hash(bytes) },
    manifestSignatureRequired: true, descriptorSignatureRequired: true,
    archiveSignatureRequired: false, nativeVerificationRequired: true, releaseReady: false };
}

module.exports = { NAME, PACKAGE, SCOPE, CHECKS, names, canonical, descriptor, capture, prepare };
if (require.main === module) {
  try {
    const [manifest, archive, receipt, output, ...extra] = process.argv.slice(2);
    assert.ok(output && !extra.length,
      'Usage: node scripts/portable-release-descriptor.cjs MANIFEST ARCHIVE REVIEWED-RECEIPT NEW-OUTPUT-DIRECTORY');
    console.log(JSON.stringify(prepare({ manifest, archive, receipt, output })));
  } catch (error) { console.error(String(error.message).slice(0, 2000)); process.exitCode = 1; }
}
