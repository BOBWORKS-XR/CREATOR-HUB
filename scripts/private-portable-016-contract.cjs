'use strict';
// Private native-qualification input policy, not public stable eligibility.
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const base = require('./linux-016-portable-package.cjs');
const production = base.production016();
const retirement = require('./linux-retirement-package.cjs');
const finite = require('./flatpak-package.cjs');
const descriptor = require('./portable-release-descriptor.cjs');

const PROFILE = 'private-production-portable-016-native-qualification';
const VERSION = '0.1.16';
const MANIFEST = descriptor.names(VERSION).manifest;
const ARCHIVE = descriptor.names(VERSION).archive;
const DESCRIPTOR = descriptor.NAME;
const IMAGE = 'Creator Hub_0.1.16_amd64.AppImage';
const ALIAS = 'Creator.Hub.Native.Support_0.1.16_amd64.AppImage';
const UNSIGNED = 'portable-manifest.unsigned.json';
const FILES = Object.freeze(['package-receipt.json', IMAGE, ALIAS, UNSIGNED, ARCHIVE,
  'appdir-original-inventory.json', 'appdir-flattened-inventory.json']);
const META = 2 * 1024 * 1024, SIGNED_META = 128 * 1024;
const FLAGS = Object.freeze({ ...base.flags(), bootstrapAccepted: false, typedResumeAccepted: false,
  publisherSignatureAccepted: false, publicUploadPerformed: false });
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const record = b => ({ size: b.length, sha256: hash(b) });
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function keys(value, names) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), 'Contract fields differ');
}
function sha(value, size = 64) { assert.ok(typeof value === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(value)); }
function id(value) { assert.ok(Number.isSafeInteger(value) && value > 0); }
function pin(value, maximum) {
  keys(value, ['size', 'sha256']); sha(value.sha256); id(value.size); assert.ok(value.size <= maximum, 'Input exceeds fixed bound');
}
function parse(bytes, maximum = META) { return descriptor.canonical(bytes, maximum); }
function limit(name) { return name === UNSIGNED ? SIGNED_META : name.endsWith('.json') ? META : base.LIMITS.file; }
function validatePlan(p) {
  keys(p, ['schemaVersion', 'profile', 'producer', 'rootSource', 'selectorSources', 'files', 'verifier']);
  assert.equal(p.schemaVersion, 1); assert.equal(p.profile, PROFILE);
  keys(p.producer, ['sourceCommit', 'sourceTree', 'runId', 'runAttempt', 'jobId', 'workflowId', 'artifactId', 'zip']);
  for (const name of ['sourceCommit', 'sourceTree']) sha(p.producer[name], 40);
  for (const name of ['runId', 'runAttempt', 'jobId', 'workflowId', 'artifactId']) id(p.producer[name]);
  pin(p.producer.zip, base.LIMITS.zip);
  keys(p.rootSource, ['sourceCommit', 'sourceTree', 'rawHub']);
  for (const name of ['sourceCommit', 'sourceTree']) sha(p.rootSource[name], 40);
  pin(p.rootSource.rawHub, base.LIMITS.file); assert.ok(p.rootSource.rawHub.size >= 64);
  assert.ok(p.selectorSources && typeof p.selectorSources === 'object' && !Array.isArray(p.selectorSources));
  const sources = Object.keys(p.selectorSources); assert.ok(sources.length >= 4 && sources.length <= 256);
  for (const name of sources) {
    assert.ok(base.relative(name) && !name.split('/').includes('.cargo') &&
      (name.startsWith('native/linux-portable-deployment/') || name === 'src-tauri/src/catalog-key.pub'));
    pin(p.selectorSources[name], 2 * 1024 * 1024);
  }
  assert.ok(sources.reduce((sum, name) => sum + p.selectorSources[name].size, 0) <= 16 * 1024 * 1024);
  keys(p.files, FILES);
  for (const name of FILES) {
    if (name === UNSIGNED) assert.ok(p.files[name]?.size <= SIGNED_META,
      'Portable manifest exceeds the unchanged 128 KiB production verifier; stop before signing');
    pin(p.files[name], limit(name));
  }
  assert.ok(FILES.reduce((sum, name) => sum + p.files[name].size, 0) <= base.LIMITS.zip);
  assert.deepEqual(p.files[IMAGE], p.files[ALIAS], 'Ordinary image and setup alias must be identical');
  pin(p.verifier, base.LIMITS.file); return p;
}
function validateAPI(p, proof) {
  validatePlan(p); keys(proof, ['run', 'job', 'workflow', 'artifact', 'commit']);
  const e = p.producer, { run, job, workflow, artifact, commit } = proof;
  assert.equal(run.id, e.runId); assert.equal(run.run_attempt, e.runAttempt);
  assert.equal(run.head_sha, e.sourceCommit); assert.equal(run.head_branch, production.BRANCH.slice('refs/heads/'.length));
  assert.equal(run.path, production.WORKFLOW); assert.equal(run.workflow_id, e.workflowId);
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success'); assert.equal(run.event, 'workflow_dispatch');
  for (const repo of [run.repository, run.head_repository]) {
    assert.equal(repo.id, 1364807512); assert.equal(repo.full_name, 'BOBWORKS-XR/CREATOR-HUB');
  }
  assert.equal(workflow.id, e.workflowId); assert.equal(workflow.path, production.WORKFLOW);
  assert.equal(commit.sha, e.sourceCommit); assert.equal(commit.tree.sha, e.sourceTree);
  for (const [name, value] of Object.entries({ id: e.jobId, run_id: e.runId, run_attempt: e.runAttempt,
    head_sha: e.sourceCommit, name: 'package', status: 'completed', conclusion: 'success' })) assert.equal(job[name], value);
  assert.ok(job.labels.includes('ubuntu-22.04'));
  assert.equal(artifact.id, e.artifactId); assert.equal(artifact.expired, false);
  assert.equal(artifact.name, `linux-016-production-portable-unsigned-${e.runId}-${e.runAttempt}`);
  assert.equal(artifact.size_in_bytes, e.zip.size); assert.equal(artifact.digest, `sha256:${e.zip.sha256}`);
  for (const [name, value] of Object.entries({ id: e.runId, head_sha: e.sourceCommit,
    head_branch: run.head_branch, repository_id: 1364807512, head_repository_id: 1364807512 })) assert.equal(artifact.workflow_run[name], value);
  const start = Date.parse(job.started_at), end = Date.parse(job.completed_at), made = Date.parse(artifact.created_at);
  assert.ok(Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(made) && start <= made && made <= end,
    'Artifact is not bound to the successful job interval');
}
function archiveContents(bytes, manifest) {
  assert.deepEqual(record(bytes), { size: manifest.archive.size, sha256: manifest.archive.sha256 });
  assert.ok(bytes.length >= 18 && bytes.subarray(0, 4).equals(Buffer.from([31, 139, 8, 0])), 'Fixed single gzip stream required');
  const maximum = manifest.archive.unpackedSize + Object.keys(manifest.entries).length * 1024 + 10240;
  const inflated = zlib.inflateRawSync(bytes.subarray(10), { info: true, maxOutputLength: maximum });
  const raw = inflated.buffer, trailer = 10 + inflated.engine.bytesWritten;
  assert.equal(trailer + 8, bytes.length, 'Trailing or concatenated gzip data refused');
  assert.equal(bytes.readUInt32LE(trailer), zlib.crc32(raw)); assert.equal(bytes.readUInt32LE(trailer + 4), raw.length);
  let offset = 0; const retained = {};
  for (const [name, entry] of Object.entries(manifest.entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    assert.ok(raw.subarray(offset, offset + 512).equals(base.tarHeader(name, entry)), 'Exact producer USTAR header required'); offset += 512;
    if (entry.kind === 'file') {
      const data = raw.subarray(offset, offset + entry.size); assert.equal(data.length, entry.size);
      assert.equal(hash(data), entry.sha256, 'Archive member differs from signed inventory'); offset += entry.size;
      const padding = (512 - entry.size % 512) % 512;
      assert.ok(raw.subarray(offset, offset + padding).equals(Buffer.alloc(padding))); offset += padding;
      if (['usr/bin/creator-hub', base.HOST_PROFILE, production.SELECTOR_ENTRYPOINT].includes(name)) retained[name] = data;
    }
  }
  assert.equal(offset + 1024, raw.length); assert.ok(raw.subarray(offset).equals(Buffer.alloc(1024)));
  return retained;
}
function selectorProof(proof, p, entry) {
  keys(proof, ['schemaVersion', 'sourceCommit', 'sourceTree', 'sources', 'publicKeySource', 'target', 'features',
    'toolchain', 'compiler', 'cargo', 'toolFiles', 'arguments', 'executable', 'rootRecompiled', 'privateModulesRecompiled', 'nativeExecution', 'releaseReady']);
  assert.equal(proof.schemaVersion, 1); assert.equal(proof.sourceCommit, p.rootSource.sourceCommit); assert.equal(proof.sourceTree, p.rootSource.sourceTree);
  assert.equal(proof.target, production.TARGET); assert.equal(proof.toolchain, production.SELECTOR_TOOLCHAIN);
  assert.deepEqual(proof.features, ['experimental-restart']); assert.match(proof.compiler, /^rustc 1\.99\.0 /);
  assert.match(proof.compiler, /^host: x86_64-unknown-linux-gnu$/m); assert.match(proof.cargo, /^cargo 1\.99\.0 /);
  for (const name of ['rootRecompiled', 'privateModulesRecompiled', 'nativeExecution', 'releaseReady']) assert.equal(proof[name], false);
  const sources = Object.keys(proof.sources); assert.ok(sources.length >= 4 && sources.length <= 256);
  assert.deepEqual(proof.sources, p.selectorSources, 'Selector sources differ from the independent source proof');
  for (const name of sources) {
    assert.ok(base.relative(name) && !name.split('/').includes('.cargo') &&
      (name.startsWith('native/linux-portable-deployment/') || name === 'src-tauri/src/catalog-key.pub'));
    pin(proof.sources[name], 2 * 1024 * 1024);
  }
  assert.ok(sources.reduce((sum, name) => sum + proof.sources[name].size, 0) <= 16 * 1024 * 1024);
  for (const name of ['native/linux-portable-deployment/Cargo.toml', 'native/linux-portable-deployment/Cargo.lock',
    'native/linux-portable-deployment/src/bin/creator-hub-portable-selector.rs', 'src-tauri/src/catalog-key.pub']) assert.ok(proof.sources[name]);
  assert.deepEqual(proof.publicKeySource, proof.sources['src-tauri/src/catalog-key.pub']);
  keys(proof.toolFiles, ['rustc', 'cargo']);
  for (const tool of Object.values(proof.toolFiles)) {
    keys(tool, ['path', 'size', 'sha256']); assert.ok(path.posix.isAbsolute(tool.path)); pin({ size: tool.size, sha256: tool.sha256 }, base.LIMITS.file);
  }
  const args = proof.arguments, suffix = '/selector-source/native/linux-portable-deployment/Cargo.toml';
  assert.ok(Array.isArray(args) && args.length === 14 && typeof args[5] === 'string' && args[5].endsWith(suffix));
  const directory = args[5].slice(0, -suffix.length);
  assert.ok(directory.startsWith('/') && path.posix.normalize(directory) === directory && !/[\x00-\x1f\\]/.test(directory));
  assert.deepEqual(args, ['build', '--release', '--locked', '--no-default-features', '--manifest-path', args[5],
    '--bin', 'creator-hub-portable-selector', '--features', 'experimental-restart', '--target', production.TARGET, '--target-dir', `${directory}/selector-target`]);
  pin(proof.executable, 32 * 1024 * 1024); assert.deepEqual(proof.executable, { size: entry.size, sha256: entry.sha256 });
}
function validateOutput(p, bodies) {
  validatePlan(p); keys(bodies, FILES);
  for (const name of FILES) assert.deepEqual(record(bodies[name]), p.files[name], `Pinned producer file differs: ${name}`);
  assert.ok(bodies[IMAGE].equals(bodies[ALIAS]), 'Setup alias bytes differ'); finite.validateElf(bodies[IMAGE]);
  const m = parse(bodies[UNSIGNED], SIGNED_META), receipt = parse(bodies['package-receipt.json']);
  keys(m, ['schemaVersion', 'appId', 'platform', 'architecture', 'version', 'sourceCommit', 'sourceTree', 'format', 'entrypoint', 'archive', 'entries']);
  for (const [name, value] of Object.entries({ schemaVersion: 1, appId: 'creator-hub', platform: 'linux', architecture: 'x86_64',
    version: VERSION, sourceCommit: p.rootSource.sourceCommit, sourceTree: p.rootSource.sourceTree, format: 'appdir-tar-gzip-v1', entrypoint: 'usr/bin/creator-hub' })) assert.equal(m[name], value);
  keys(m.archive, ['size', 'sha256', 'unpackedSize']);
  const flat = parse(bodies['appdir-flattened-inventory.json']), original = parse(bodies['appdir-original-inventory.json']);
  base.validateInventory(flat); assert.deepEqual(flat.entries, m.entries); assert.equal(flat.unpackedSize, m.archive.unpackedSize);
  keys(original, ['entries', 'links', 'unpackedSize']);
  const normalized = Object.fromEntries(Object.entries(original.entries).map(([name, entry]) => [name, { ...entry, mode: base.transportMode(name, entry) }]));
  base.validateInventory({ entries: normalized, links: {}, unpackedSize: original.unpackedSize });
  for (const [name, link] of Object.entries(original.links)) {
    keys(link, ['link', 'resolved', 'kind', 'size', 'sha256', 'mode']); assert.ok(Object.hasOwn(original.entries, name));
    let current = name; const seen = new Set();
    while (original.links[current]) {
      assert.ok(seen.size < 32 && !seen.has(current)); seen.add(current);
      const value = original.links[current].link; assert.ok(value && !path.posix.isAbsolute(value) && !/[\\:\x00-\x1f\x7f-\uffff]/.test(value));
      current = path.posix.normalize(path.posix.join(path.posix.dirname(current), value)); assert.ok(base.relative(current));
    }
    assert.equal(current, link.resolved); assert.deepEqual(original.entries[current], original.entries[name]);
    assert.deepEqual((( { link: _, resolved: __, ...entry }) => entry)(link), original.entries[name]);
  }
  for (const name of [base.HOST_PROFILE, production.SELECTOR_ENTRYPOINT]) assert.equal(Object.hasOwn(normalized, name), false);
  const expected = { ...normalized, 'usr/libexec': { kind: 'directory', mode: 0o755 },
    [base.HOST_PROFILE]: m.entries[base.HOST_PROFILE], [production.SELECTOR_ENTRYPOINT]: m.entries[production.SELECTOR_ENTRYPOINT] };
  assert.deepEqual(flat.entries, expected); assert.deepEqual(receipt.flattenedLinks, original.links);
  assert.equal(receipt.schemaVersion, 2); assert.equal(receipt.scope, 'unsigned-linux-016-production-portable-packaging-only');
  assert.equal(receipt.packagingCompleted, true); assert.equal(receipt.packagingSource, p.producer.sourceCommit);
  for (const name of Object.keys(base.flags())) assert.equal(receipt[name], false);
  for (const name of ['rootRecompiled', 'privatePayloadChanged', 'payloadResigned', 'applicationLaunched', 'updateAcceptanceTested']) assert.equal(receipt[name], false);
  assert.deepEqual(receipt.archive, m.archive); assert.deepEqual(receipt.manifest, p.files[UNSIGNED]);
  assert.deepEqual(receipt.appImage, p.files[IMAGE]);
  const alias = receipt.nativeSupportAlias;
  keys(alias, ['ordinaryName', 'nativeSupportName', 'size', 'sha256', 'identicalBytes', 'sourceIdentityRechecked', 'role', 'nativeExecution', 'releaseReady']);
  assert.deepEqual(alias, { ordinaryName: IMAGE, nativeSupportName: ALIAS, ...p.files[IMAGE], identicalBytes: true,
    sourceIdentityRechecked: true, role: 'restricted-setup-screen-intent-only', nativeExecution: false, releaseReady: false });
  const binding = receipt.producer; keys(binding, ['pins', 'proof', 'privateProof']);
  production.verifyProducer(binding.pins, binding.proof); base.verifyPrivateProof(binding.privateProof);
  assert.equal(binding.pins.sourceCommit, p.rootSource.sourceCommit); assert.equal(binding.pins.sourceTree, p.rootSource.sourceTree);
  assert.deepEqual(binding.pins.files['creator-hub'], p.rootSource.rawHub);
  assert.deepEqual(m.entries['usr/lib/Creator Hub/modules.tar.gz'], { kind: 'file', ...binding.pins.files['modules.tar.gz'], mode: 0o644 },
    'Portable transport must preserve the original private modules archive');
  const deb = receipt.productionDeb;
  assert.equal(deb.profile, retirement.PRODUCTION_PROFILE); assert.equal(deb.nativeExecution, false); assert.equal(deb.releaseReady, false);
  assert.deepEqual(deb.package, binding.pins.files[production.DEB_MEMBER]);
  keys(deb.files, [retirement.HELPER, retirement.POLICY, retirement.SERVICE]);
  for (const [name, value] of Object.entries(deb.files)) {
    keys(value, ['size', 'sha256', 'mode', 'uid', 'gid']); pin({ size: value.size, sha256: value.sha256 }, base.LIMITS.file);
    assert.equal(value.mode, name === retirement.HELPER ? 0o755 : 0o644); assert.equal(value.uid, 0); assert.equal(value.gid, 0);
  }
  assert.deepEqual(deb.files[retirement.SERVICE], { ...record(retirement.SERVICE_BYTES), mode: 0o644, uid: 0, gid: 0 });
  const root = m.entries[m.entrypoint], runner = m.entries.AppRun, host = m.entries[base.HOST_PROFILE], selector = m.entries[production.SELECTOR_ENTRYPOINT];
  for (const entry of [root, runner, selector]) assert.ok(entry?.kind === 'file' && entry.mode === 0o755 && entry.size > 0);
  assert.ok(host?.kind === 'file' && host.mode === 0o644 && host.size > 0 && host.size <= 4096);
  selectorProof(receipt.selectorBuild, p, selector);
  const contents = archiveContents(bodies[ARCHIVE], m), appRoot = contents[m.entrypoint];
  finite.validateElf(appRoot); finite.validateElf(contents[production.SELECTOR_ENTRYPOINT]);
  const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_APP'), at = appRoot.indexOf(marker);
  assert.ok(at >= 0 && appRoot.indexOf(marker, at + 1) === -1, 'Exactly one packaged APP marker required');
  const rawRoot = Buffer.from(appRoot); rawRoot.write('UNK', at + marker.length - 3, 'ascii');
  assert.deepEqual(record(rawRoot), p.rootSource.rawHub, 'Packaged Root differs from the independently pinned raw Root');
  const debRoot = Buffer.from(rawRoot); debRoot.write('DEB', at + marker.length - 3, 'ascii');
  assert.deepEqual(deb.packageFiles, { 'usr/bin/creator-hub': { ...record(debRoot), mode: 0o755 },
    'usr/lib/Creator Hub/modules.tar.gz': { ...binding.pins.files['modules.tar.gz'], mode: 0o644 },
    ...Object.fromEntries(Object.entries(deb.files).map(([name, file]) => [name.slice(1), { size: file.size, sha256: file.sha256, mode: file.mode }])) },
  'Production DEB and portable transport must bind the same Root and private archive');
  for (const witness of require('./build-unified.cjs').PORTABLE_ROOT_WITNESSES) assert.ok(rawRoot.includes(Buffer.from(witness)));
  assert.deepEqual(parse(contents[base.HOST_PROFILE], 4096), { schemaVersion: 1, version: VERSION,
    activationInterface: 'com.creatorworks.hub.Host1', integratedFeatures: true, startupImageBinding: 1, executableSha256: root.sha256 });
  assert.deepEqual(receipt.portableHostProfile, { path: base.HOST_PROFILE, ...record(contents[base.HOST_PROFILE]),
    executable: { size: root.size, sha256: root.sha256 }, rawExecutable: p.rootSource.rawHub, compiledFeatures: [...production.FEATURES],
    scope: 'canonical-appdir-transport-only', appImageContainsProfile: false });
  return { manifest: m, receipt, descriptor: { schemaVersion: 1, appId: 'creator-hub', version: VERSION, platform: 'linux', architecture: 'x86_64',
    packageType: 'portable-appdir', manifest: { assetName: MANIFEST, byteLength: bodies[UNSIGNED].length, sha256: hash(bodies[UNSIGNED]) },
    archive: { assetName: ARCHIVE, byteLength: bodies[ARCHIVE].length, sha256: hash(bodies[ARCHIVE]) },
    executableSha256: root.sha256, restartProtocol: 1, minHubVersion: VERSION } };
}
module.exports = { PROFILE, VERSION, MANIFEST, ARCHIVE, DESCRIPTOR, IMAGE, ALIAS, UNSIGNED, FILES, META, SIGNED_META, FLAGS,
  hash, record, json, keys, pin, parse, limit, validatePlan, validateAPI, archiveContents, selectorProof, validateOutput };
