'use strict';
// Synthetic archives/API/Git/ELFs and mocked signatures only. No key exists.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const c = require('./private-portable-017-contract.cjs');
const w = require('./sign-private-portable-017.cjs');
const lane = require('./private-linux-portable-fixture-017.cjs');
const base = require('./linux-016-portable-package.cjs');
const old = require('./private-portable-016-contract.cjs');
const oldWriter = require('./sign-private-portable-016.cjs');
const meta = require('./private-linux-update-fixture-017-metadata.cjs');
const provenance = require('./private-linux-update-fixture-017-provenance.cjs');
const retirement = require('./linux-retirement-package.cjs');
const moduleArchive = require('./module-archive.cjs');
const { data, elf, json: fixtureJson } = require('./fixtures/private-linux-update-fixture-017.cjs');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const signature = b => Buffer.from(`untrusted comment: Synthetic private portable017 ${c.hash(b)}`);
function zip(bodies) {
  return execFileSync(PYTHON, ['-B', '-c', 'import base64,io,json,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w",compression=zipfile.ZIP_DEFLATED); [z.writestr(n,base64.b64decode(v)) for n,v in json.load(sys.stdin).items()]; z.close(); sys.stdout.buffer.write(b.getvalue())'],
    { input: JSON.stringify(Object.fromEntries(Object.entries(bodies).map(([name, bytes]) => [name, bytes.toString('base64')]))) });
}
function tar(contents, modes = {}) {
  const entries = {};
  for (const [name, bytes] of Object.entries(contents)) {
    for (let dir = path.posix.dirname(name); dir !== '.'; dir = path.posix.dirname(dir)) entries[dir] = { kind: 'directory', mode: 0o755 };
    entries[name] = { kind: 'file', ...c.record(bytes), mode: modes[name] || (name === lane.HOST || name.endsWith('modules.tar.gz') ? 0o644 : 0o755) };
  }
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a < b ? -1 : 1)), blocks = []; let unpackedSize = 0;
  for (const [name, entry] of Object.entries(sorted)) {
    blocks.push(base.tarHeader(name, entry));
    if (entry.kind === 'file') { blocks.push(contents[name], Buffer.alloc((512 - entry.size % 512) % 512)); unpackedSize += entry.size; }
  }
  blocks.push(Buffer.alloc(1024));
  return { bytes: zlib.gzipSync(Buffer.concat(blocks)), inventory: { entries: sorted, links: {}, unpackedSize } };
}
function resource(manifest, contents) {
  const hashes = moduleArchive.rawFiles(manifest), files = {}, blocks = [];
  for (const name of Object.keys(hashes).sort()) {
    const bytes = contents[name], entry = { kind: 'file', ...c.record(bytes), mode: moduleArchive.modeFor(manifest, name) };
    assert.equal(entry.sha256, hashes[name]); files[name] = { size: entry.size, mode: entry.mode };
    blocks.push(base.tarHeader(name, entry), bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  const bytes = zlib.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
  return { bytes, binding: { schemaVersion: 1, file: 'modules.tar.gz', ...c.record(bytes), unpackedSize: Object.values(files).reduce((n, f) => n + f.size, 0), files } };
}
function resourceFixture() {
  const f = data(), manifest = f.handoff.builtinManifest, contents = {}, transfer = {}, modes = {};
  for (const module of Object.values(manifest.modules)) for (const name of Object.keys(module.files)) {
    const bytes = Buffer.from(`Synthetic private file ${name}`); contents[name] = bytes; transfer[`modules/${name}`] = bytes;
    module.files[name] = c.hash(bytes); const record = { ...c.record(bytes), mode: f.prepared.files[`modules/${name}`].mode };
    f.prepared.files[`modules/${name}`] = record; modes[`modules/${name}`] = record.mode; f.handoff.payloadFiles[name] = record;
  }
  contents['routing/creator-hub-mcp-router'] = transfer['router-for-package'] = elf('unchanged synthetic router');
  f.prepared.files['router-for-package'] = { ...c.record(transfer['router-for-package']), mode: 0o755 }; modes['router-for-package'] = 0o755;
  f.handoff.payloadFiles['routing/creator-hub-mcp-router'] = f.prepared.files['router-for-package'];
  manifest.managedRouting.files['routing/creator-hub-mcp-router'] = c.hash(transfer['router-for-package']);
  f.files['routing/router.json'] = Buffer.from(JSON.stringify({ schemaVersion: 1, product: 'com.creatorworks.hub.mcp-router', platform: 'linux', arch: 'x86_64', protocol: 1, sha256: c.hash(transfer['router-for-package']) }));
  f.files['routing/runtime.json'] = Buffer.from(JSON.stringify(require('./mcp-runtime-descriptor.cjs').runtimeDescriptor(manifest, '0.1.16')));
  for (const name of Object.keys(f.handoff.routingMetadata)) {
    contents[name] = f.files[name]; manifest.managedRouting.files[name] = c.hash(contents[name]);
    f.handoff.routingMetadata[name] = f.handoff.payloadFiles[name] = { ...c.record(contents[name]), mode: 0o644 };
  }
  transfer['builtin-manifest.json'] = fixtureJson(manifest); transfer['mcp-runtime.json'] = f.files['routing/runtime.json'];
  for (const name of ['builtin-manifest.json', 'mcp-runtime.json']) { f.prepared.files[name] = { ...c.record(transfer[name]), mode: 0o644 }; modes[name] = 0o644; }
  f.files['modules.tar.gz'] = tar(transfer, modes).bytes; f.files['prepared-unix.json'] = fixtureJson(f.prepared);
  for (const name of Object.keys(f.handoff.transferFiles)) f.handoff.transferFiles[name] = c.record(f.files[name]);
  f.files['handoff.json'] = fixtureJson(f.handoff);
  f.originalRecords = Object.fromEntries(Object.keys(f.originalRecords).map(name => [name, c.record(f.files[name])]));
  f.plan.original016 = structuredClone(f.originalRecords); f.files['runtime017.json'] = meta.runtimeBytes(manifest);
  return { ...f, contents };
}
function api(expected, fixed) {
  const repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' };
  return { run: { id: expected.runId, run_attempt: expected.runAttempt, head_sha: expected.sourceCommit, head_branch: fixed.branch,
    path: fixed.workflow, workflow_id: expected.workflowId, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', repository: repo, head_repository: repo },
  job: { id: expected.jobId, run_id: expected.runId, run_attempt: expected.runAttempt, head_sha: expected.sourceCommit, name: fixed.job,
    status: 'completed', conclusion: 'success', labels: ['ubuntu-22.04'], started_at: '2026-10-20T10:00:00Z', completed_at: '2026-10-20T11:00:00Z' },
  workflow: { id: expected.workflowId, path: fixed.workflow },
  artifact: { id: expected.artifactId, name: fixed.artifact, expired: false, size_in_bytes: expected.zip.size, digest: `sha256:${expected.zip.sha256}`,
    created_at: '2026-10-20T10:59:00Z', workflow_run: { id: expected.runId, head_sha: expected.sourceCommit, head_branch: fixed.branch, repository_id: 1364807512, head_repository_id: 1364807512 } },
  commit: { sha: expected.sourceCommit, tree: { sha: expected.sourceTree } } };
}
function closure(entries) {
  const patterns = { webkit: /(?:^|\/)libwebkit2gtk-4\.1\.so(?:\.\d+)*$/, javascriptCore: /(?:^|\/)libjavascriptcoregtk-4\.1\.so(?:\.\d+)*$/,
    webProcess: /\/webkit2gtk-4\.1\/WebKitWebProcess$/, networkProcess: /\/webkit2gtk-4\.1\/WebKitNetworkProcess$/,
    injectedBundle: /\/webkit2gtk-4\.1\/injected-bundle\/libwebkit2gtkinjectedbundle\.so$/ };
  const primary = Object.fromEntries(Object.entries(patterns).map(([name, regex]) => [name, Object.keys(entries).filter(file => regex.test(file))]));
  Object.assign(primary, { hub: ['usr/bin/creator-hub'], selector: [lane.SELECTOR] });
  const files = [...new Set(Object.values(primary).flat())];
  return { dependencies: { primary, closure: Object.fromEntries(files.map(name => [name, { ...entries[name], dynamicSha256: c.hash(Buffer.from('synthetic dynamic')),
    needed: [], versionNeedCount: 0, versionInfoPresent: false, resolution: {} }])), hostBaseline: [], unresolved: [], hostBaselineSource: base.HOST_EXCLUSIONS,
    scope: 'static ELF dependency closure only; loader search, ABI versions, dlopen/plugins and native execution unaccepted' },
  closureAbi: { scope: 'whole inspected static dependency closure GNU symbol-version requirements by provider; host ABI availability, undefined symbols, loader search, dlopen/plugins and native execution unaccepted',
    targetAbiVerified: false, undefinedSymbolsVerified: false, nativeExecutionVerified: false, releaseReady: false, providers: {},
    files: Object.fromEntries(files.map(name => [name, { executableSha256: entries[name].sha256, versionInfoSha256: c.hash(Buffer.from('synthetic versions')),
      requirementsByProvider: {}, unversionedDependencies: [] }])) } };
}
async function create(t, fault = '') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portable017-writer-unit-')));
  t.after(() => { assert.equal(fs.realpathSync(root), root); assert.ok(path.basename(root).startsWith('portable017-writer-unit-')); fs.rmSync(root, { recursive: true, force: true }); });
  const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  const f = resourceFixture(), blobs = new Map(), selectorSources = {}, selectorGit = {}, toolSources = {};
  function blob(name) {
    const bytes = Buffer.from(`synthetic source ${name}\n`), gitBlob = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    blobs.set(gitBlob, bytes); put(path.join(root, name), bytes); return { gitBlob, ...c.record(bytes) };
  }
  for (const name of ['native/linux-portable-deployment/Cargo.toml', 'native/linux-portable-deployment/Cargo.lock',
    'native/linux-portable-deployment/src/bin/creator-hub-portable-selector.rs', 'src-tauri/src/catalog-key.pub']) { selectorGit[name] = blob(name); selectorSources[name] = c.bare(selectorGit[name]); }
  for (const name of new Set(['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/examples/verify-package-input.rs',
    'src-tauri/src/catalog-key.pub', 'src-tauri/src/catalog.rs', 'native/mcp-router/Cargo.toml', ...w.DECODER_SOURCES,
    'src-tauri/src/module_archive.rs'])) toolSources[name] = blob(name);
  const originalResource = resource(f.handoff.builtinManifest, f.contents), packed16 = originalResource.bytes;
  f.baseBytes.manifest = fixtureJson({ ...f.handoff.builtinManifest, payloadArchive: originalResource.binding });
  const raw16 = Buffer.concat([elf('baseline-Root16'), f.baseBytes.manifest, Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK\n' + require('./build-unified.cjs').PORTABLE_ROOT_WITNESSES.join('\n'))]);
  f.baseBytes.rawHub = raw16;
  const baselineReceipt = JSON.parse(f.baseBytes.assemblyReceipt); baselineReceipt.handoffSha256 = f.originalRecords['handoff.json'].sha256;
  baselineReceipt.productionMigration.rawHub = baselineReceipt.portableHostBuild.rawHub = c.record(raw16);
  f.baseBytes.assemblyReceipt = fixtureJson(baselineReceipt);
  for (const name of Object.keys(meta.BASELINE_MEMBERS)) f.plan.baseline016.pins[name] = c.record(f.baseBytes[name]);
  f.files['baseline016.zip'] = zip({ ...Object.fromEntries(Object.entries(meta.BASELINE_MEMBERS).map(([name, member]) => [member, f.baseBytes[name]])), 'modules.tar.gz': packed16 });
  Object.assign(f.plan.baseline016.assembly, { zipBytes: f.files['baseline016.zip'].length, zipSha256: c.hash(f.files['baseline016.zip']) });
  f.baselineApi.artifact.size_in_bytes = f.files['baseline016.zip'].length; f.baselineApi.artifact.digest = `sha256:${c.hash(f.files['baseline016.zip'])}`;
  f.files['baseline016-api.json'] = fixtureJson(f.baselineApi);
  f.plan.baseline016.pins.rawHub = c.record(raw16); f.plan.rootSource = structuredClone(lane.SOURCE);
  f.rootApi.commit = { sha: lane.SOURCE.sourceCommit, tree: { sha: lane.SOURCE.sourceTree } };
  f.files['plan.json'] = fixtureJson(f.plan); f.files['root017-api.json'] = fixtureJson(f.rootApi);
  f.files['derivation017.json'] = meta.derivationBytes(f.plan, f.handoff, f.prepared, f.originalRecords, f.files['runtime017.json'], f.files['runtime017.minisig']);
  const derived = meta.validateDerivation(f.files['derivation017.json'], f.plan, f.handoff, f.prepared, f.originalRecords, f.files['runtime017.json'], f.files['runtime017.minisig']);
  const originals = ['handoff', 'routing/router', 'routing/runtime', 'runtime017', 'derivation017'];
  const approvedSignatures = new Set(originals.map(name => `${c.hash(f.files[`${name}.json`])}:${f.files[`${name}.minisig`].toString('base64')}`));
  const privateProof = { ...structuredClone(f.handoff.apiProof), prepared: f.prepared };
  privateProof.artifactSize = privateProof.artifact.size_in_bytes; privateProof.jobId = 303;
  privateProof.jobs[0].id = 303; privateProof.jobs[0].head_sha = privateProof.expected.sourceCommit; privateProof.job = structuredClone(privateProof.jobs[0]);
  const unpack = (raw, kind) => { const b = Buffer.from(raw), token = '__TAURI_BUNDLE_TYPE_VAR_UNK'; b.write(kind, b.indexOf(token) + token.length - 3, 'ascii'); return b; };
  const app16 = unpack(raw16, 'APP'), host16 = old.json({ schemaVersion: 1, version: '0.1.16', activationInterface: 'com.creatorworks.hub.Host1', integratedFeatures: true, startupImageBinding: 1, executableSha256: c.hash(app16) });
  // Transfer input and rebuilt resource archives have different representations;
  // only the two signed runtime files change between the resource descriptors.
  const originalContents = { AppRun: Buffer.from('#!/bin/sh\n'), 'usr/bin/creator-hub': app16, 'usr/lib/Creator Hub/modules.tar.gz': packed16 };
  const original16 = tar(originalContents), selectorBytes = elf('synthetic original selector'), transport16 = tar({ ...originalContents, [lane.HOST]: host16, [lane.SELECTOR]: selectorBytes });
  const oldRoot = { sourceCommit: f.plan.baseline016.assembly.sourceCommit, sourceTree: f.plan.baseline016.assembly.sourceTree, rawHub: c.record(raw16) };
  const production = base.production016(), pins = { schemaVersion: 2, profile: production.PROFILE, ...oldRoot, runId: 9001, runAttempt: 2,
    jobId: 9002, workflowId: 9003, artifactId: 9004, receiptsArtifactId: 9005, artifact: c.record(Buffer.from('old assembly')),
    receiptsArtifact: c.record(Buffer.from('old receipts')), handoffSha256: c.record(f.files['handoff.json']).sha256, files: {} }; delete pins.rawHub;
  for (const name of [...production.INPUTS, ...production.RECEIPTS]) pins.files[name] = c.record(Buffer.from(`original ${name}`));
  pins.files['creator-hub'] = c.record(raw16); pins.files['modules.tar.gz'] = c.record(packed16);
  const oldApi = api({ ...pins, zip: pins.artifact }, { branch: 'validation/linux-integrated-candidate-016', workflow: '.github/workflows/unix-managed-assembly.yml', job: 'assembly (linux, ubuntu-22.04, fixture)', artifact: 'signed-unix-hub-linux-9001-2' });
  oldApi.receiptsArtifact = { ...structuredClone(oldApi.artifact), id: 9005, name: 'signed-linux-receipts-9001-2', size_in_bytes: pins.receiptsArtifact.size, digest: `sha256:${pins.receiptsArtifact.sha256}` };
  const oldManifest = { schemaVersion: 1, appId: 'creator-hub', platform: 'linux', architecture: 'x86_64', version: '0.1.16',
    sourceCommit: oldRoot.sourceCommit, sourceTree: oldRoot.sourceTree, format: 'appdir-tar-gzip-v1', entrypoint: 'usr/bin/creator-hub',
    archive: { ...c.record(transport16.bytes), unpackedSize: transport16.inventory.unpackedSize }, entries: transport16.inventory.entries };
  const helperFiles = { [retirement.HELPER]: { ...f.plan.baseline016.pins.helper, mode: 0o755, uid: 0, gid: 0 }, [retirement.POLICY]: { ...f.plan.baseline016.pins.policy, mode: 0o644, uid: 0, gid: 0 }, [retirement.SERVICE]: { ...f.plan.baseline016.pins.service, mode: 0o644, uid: 0, gid: 0 } };
  const selectorBuild = { schemaVersion: 1, sourceCommit: oldRoot.sourceCommit, sourceTree: oldRoot.sourceTree, sources: selectorSources,
    publicKeySource: selectorSources['src-tauri/src/catalog-key.pub'], target: lane.TARGET, features: ['experimental-restart'], toolchain: production.SELECTOR_TOOLCHAIN,
    compiler: 'rustc 1.99.0 (synthetic)\nhost: x86_64-unknown-linux-gnu\n', cargo: 'cargo 1.99.0 (synthetic)', toolFiles: Object.fromEntries(['rustc', 'cargo'].map(name => [name, { path: `/opt/${name}`, ...c.record(Buffer.from(name)) }])),
    arguments: ['build', '--release', '--locked', '--no-default-features', '--manifest-path', '/tmp/selector-source/native/linux-portable-deployment/Cargo.toml', '--bin', 'creator-hub-portable-selector', '--features', 'experimental-restart', '--target', lane.TARGET, '--target-dir', '/tmp/selector-target'],
    executable: c.record(selectorBytes), rootRecompiled: false, privateModulesRecompiled: false, nativeExecution: false, releaseReady: false };
  const oldReceipt = { schemaVersion: 2, scope: 'unsigned-linux-016-production-portable-packaging-only', packagingCompleted: true, packagingSource: '6'.repeat(40),
    producer: { pins, proof: oldApi, privateProof }, rootRecompiled: false, privatePayloadChanged: false, payloadResigned: false, applicationLaunched: false, updateAcceptanceTested: false, ...base.flags(),
    archive: oldManifest.archive, manifest: c.record(old.json(oldManifest)), flattenedLinks: {}, appImage: c.record(elf('ordinary16')),
    nativeSupportAlias: { ordinaryName: old.IMAGE, nativeSupportName: old.ALIAS, ...c.record(elf('ordinary16')), identicalBytes: true, sourceIdentityRechecked: true, role: 'restricted-setup-screen-intent-only', nativeExecution: false, releaseReady: false },
    portableHostProfile: { path: lane.HOST, ...c.record(host16), executable: c.record(app16), rawExecutable: c.record(raw16), compiledFeatures: [...lane.FEATURES], scope: 'canonical-appdir-transport-only', appImageContainsProfile: false }, selectorBuild,
    productionDeb: { profile: retirement.PRODUCTION_PROFILE, nativeExecution: false, releaseReady: false, package: pins.files[production.DEB_MEMBER], files: helperFiles,
      packageFiles: { 'usr/bin/creator-hub': { ...c.record(unpack(raw16, 'DEB')), mode: 0o755 }, 'usr/lib/Creator Hub/modules.tar.gz': { ...c.record(packed16), mode: 0o644 }, ...Object.fromEntries(Object.entries(helperFiles).map(([name, v]) => [name.slice(1), { ...c.bare(v), mode: v.mode }])) } } };
  const oldBodies = { 'package-receipt.json': old.json(oldReceipt), [old.IMAGE]: elf('ordinary16'), [old.ALIAS]: elf('ordinary16'), [old.UNSIGNED]: old.json(oldManifest), [old.ARCHIVE]: transport16.bytes,
    'appdir-original-inventory.json': old.json(original16.inventory), 'appdir-flattened-inventory.json': old.json(transport16.inventory) };
  const portable016Zip = zip(oldBodies), oldPlan = { schemaVersion: 1, profile: old.PROFILE, producer: { sourceCommit: oldReceipt.packagingSource, sourceTree: '7'.repeat(40), runId: 9101, runAttempt: 1, jobId: 9102, workflowId: 9103, artifactId: 9104, zip: c.record(portable016Zip) },
    rootSource: oldRoot, selectorSources, files: Object.fromEntries(Object.entries(oldBodies).map(([name, b]) => [name, c.record(b)])), verifier: c.record(Buffer.from('old tool')) };
  const oldChecked = old.validateOutput(oldPlan, oldBodies), legacy = Object.fromEntries(Object.entries(oldBodies).map(([name, b]) => [name === old.UNSIGNED ? old.MANIFEST : name, b]));
  Object.assign(legacy, { 'plan.json': old.json(oldPlan), 'fresh-api.json': old.json({ synthetic: true }), [old.DESCRIPTOR]: old.json(oldChecked.descriptor) });
  for (const name of [old.MANIFEST, old.DESCRIPTOR]) { legacy[`${name}.minisig`] = signature(legacy[name]); approvedSignatures.add(`${c.hash(legacy[name])}:${legacy[`${name}.minisig`].toString('base64')}`); }
  legacy['private-qualification-receipt.json'] = old.json({ profile: old.PROFILE, planSha256: c.hash(legacy['plan.json']), authorizedBodiesSigned: 2, privateKeyIncluded: false,
    producer: oldPlan.producer, rootSource: oldRoot, signatures: Object.fromEntries([old.MANIFEST, old.DESCRIPTOR].map(name => [`${name}.minisig`, c.record(legacy[`${name}.minisig`])])), ...old.FLAGS });
  const hashes = moduleArchive.rawFiles(derived), packedResource = resource(derived, { ...f.contents, 'routing/runtime.json': f.files['runtime017.json'], 'routing/runtime.minisig': f.files['runtime017.minisig'] }), packed = packedResource.bytes;
  const embedded = { ...structuredClone(derived), payloadArchive: packedResource.binding };
  const raw17 = Buffer.concat([elf('actual compiled synthetic017'), Buffer.from(JSON.stringify(embedded, null, 2)), Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK\n' + require('./build-unified.cjs').PORTABLE_ROOT_WITNESSES.join('\n'))]);
  const assembled = { root: raw17, archive: packed, manifest: Buffer.from(JSON.stringify(embedded, null, 2)), deb: Buffer.from('synthetic actual017 DEB'), api: c.json({ baseline: f.baselineApi, root: f.rootApi }) };
  const aReceipt = { schemaVersion: 1, profile: 'private-update-fixture-017', hubVersion: '0.1.17', rootSource: lane.SOURCE, compiledFeatures: [...lane.FEATURES], target: lane.TARGET,
    derivation: c.record(f.files['derivation017.json']), original016: { source: f.handoff.source, files: f.plan.original016 }, baseline016: f.plan.baseline016,
    rawHub: c.record(raw17), packagedHub: c.record(unpack(raw17, 'DEB')), archive: c.record(packed), manifest: c.record(assembled.manifest), deb: c.record(assembled.deb),
    packageReport: { scope: 'private017-deb-delta-only', helperPolicyServicePreserved: true, original016Preserved: true, nativeGuiAccepted: false, migrationAccepted: false, signedUpdateAccepted: false, restartAccepted: false, releaseReady: false },
    ...require('./private-linux-update-fixture-017.cjs').FLAGS };
  assembled.receipt = c.json(aReceipt);
  assembled.integrity = c.json({ schemaVersion: 1, platform: 'linux', arch: 'x86_64', integrityPassed: true, experimental: true, mcpMode: 'writable', writableGuiAccepted: false, releaseReady: false,
    packages: [{ format: 'deb', path: `native-packages/${lane.ROLES.deb}`, sha256: c.hash(assembled.deb), hubSha256: aReceipt.packagedHub.sha256, files: hashes }] });
  assembled.expected = c.json({ candidate: { deb: aReceipt.deb, hub: aReceipt.packagedHub, archive: aReceipt.archive }, baseline: Object.fromEntries(['deb', 'hub', 'helper', 'policy', 'service'].map(name => [name, f.plan.baseline016.pins[name]])) });
  const assemblyZip = zip(Object.fromEntries(Object.entries(assembled).map(([role, b]) => [`actual/${lane.ROLES[role]}`, b])));
  const inputProfile = { schemaVersion: 1, profile: lane.PROFILE, assembly017: { runId: 9201, runAttempt: 1, jobId: 9202, workflowId: 9203, artifactId: 9204, zip: c.record(assemblyZip),
    files: Object.fromEntries(Object.entries(assembled).map(([role, b]) => [role, { member: `actual/${lane.ROLES[role]}`, ...c.record(b) }])) },
    signed016: { planSha256: c.hash(legacy['plan.json']), files: Object.fromEntries(Object.entries(legacy).map(([name, b]) => [name, c.record(b)])) },
    signed017: { planSha256: c.hash(f.files['plan.json']) }, tools: { verifier: c.record(Buffer.from('controlled Linux verifier')), decoder: c.record(Buffer.from('controlled Linux decoder')) } };
  const carriers = { schemaVersion: 1, signed016: { sourceCommit: '4'.repeat(40), sourceTree: '5'.repeat(40), runId: 9301, runAttempt: 1, jobId: 9302, workflowId: 9303, artifactId: 9304, zip: c.record(Buffer.from('carrier16')),
    members: Object.fromEntries(lane.LEGACY_NAMES.map(name => [name, `carrier/${name}`])) }, signed017: { jobId: 9205, artifactId: 9206, zip: c.record(Buffer.from('carrier17')),
    files: Object.fromEntries(['private017-signed.zip', 'approved-plan.json', 'signed-input.json'].map(name => [name, { member: `carrier/${name}`, ...c.record(Buffer.from(name)) }])) } };
  const profileBytes = lane.json(inputProfile), proofBodies = { 'profile.json': profileBytes, 'assembly017.zip': assemblyZip, 'portable016.zip': portable016Zip,
    ...Object.fromEntries(Object.entries(legacy).map(([name, b]) => [`signed016/${name}`, b])), ...Object.fromEntries(Object.entries(f.files).map(([name, b]) => [`signed017/${name}`, b])) };
  const verifier = put(path.join(root, w.VERIFIER), Buffer.from('fixed synthetic Windows verifier, never executed'));
  const decoder = put(path.join(root, w.DECODER), Buffer.from('fixed synthetic Windows decoder, never executed'));
  const p = { schemaVersion: 1, profile: c.PROFILE, producer: { sourceCommit: '9'.repeat(40), sourceTree: '8'.repeat(40), runId: 9401, runAttempt: 1, jobId: 9402, workflowId: 9403, artifactId: 9404, zip: c.record(Buffer.from('pending synthetic ZIP')) },
    rootSource: structuredClone(lane.SOURCE), inputProfile, carriers, files: {}, proofs: Object.fromEntries(Object.entries(proofBodies).map(([name, b]) => [name, c.record(b)])), verifier: c.record(fs.readFileSync(verifier)), decoder: c.record(fs.readFileSync(decoder)) };
  const map = new Map();
  function addApi(e, proof) { for (const [role, route] of Object.entries({ run: `actions/runs/${e.runId}`, job: `actions/jobs/${e.jobId}`, workflow: `actions/workflows/${e.workflowId}`, artifact: `actions/artifacts/${e.artifactId}`, commit: `git/commits/${e.sourceCommit}` })) map.set(route, proof[role]); }
  addApi(pins, oldApi); map.set(`actions/artifacts/${pins.receiptsArtifactId}`, oldApi.receiptsArtifact);
  addApi(oldPlan.producer, api(oldPlan.producer, { branch: production.BRANCH.slice(11), workflow: production.WORKFLOW, job: 'package', artifact: 'linux-016-production-portable-unsigned-9101-1' }));
  for (const [route, value] of [[`actions/runs/${privateProof.expected.runId}`, privateProof.run], [`actions/jobs/${privateProof.jobId}`, privateProof.job], [`actions/artifacts/${privateProof.expected.artifactId}`, privateProof.artifact],
    [`git/commits/${privateProof.expected.sourceCommit}`, privateProof.commit], [`actions/runs/${privateProof.expected.runId}/attempts/${privateProof.expected.runAttempt}/jobs?per_page=100`, { total_count: privateProof.jobs.length, jobs: privateProof.jobs }]]) map.set(route, value);
  for (const [role, route] of Object.entries({ run: `actions/runs/${f.plan.baseline016.assembly.runId}`, job: `actions/jobs/${f.plan.baseline016.assembly.jobId}`, artifact: `actions/artifacts/${f.plan.baseline016.assembly.artifactId}`, commit: `git/commits/${oldRoot.sourceCommit}` })) map.set(route, f.baselineApi[role]);
  const assemblyExpected = { ...inputProfile.assembly017, ...lane.SOURCE };
  const assemblyApi = api(assemblyExpected, { branch: 'validation/linux-private-update-fixture-017', workflow: '.github/workflows/private-linux-update-fixture-017.yml', job: 'assemble', artifact: 'private-linux-update-fixture-017-9201-1' });
  addApi(assemblyExpected, assemblyApi);
  const signed16Api = api(carriers.signed016, { branch: 'validation/private-portable-016-carrier', workflow: '.github/workflows/private-portable-016-carrier.yml', job: 'stage', artifact: 'private-portable-016-carrier-9301-1' }); addApi(carriers.signed016, signed16Api);
  const signed17Api = api({ ...assemblyExpected, ...carriers.signed017 }, { branch: 'validation/linux-private-update-fixture-017', workflow: '.github/workflows/private-linux-update-fixture-017.yml', job: 'stage-input', artifact: 'private017-signed-input-9201-1' });
  map.set('actions/jobs/9205', signed17Api.job); map.set('actions/artifacts/9206', signed17Api.artifact);
  const trees = new Map();
  function tree(paths) {
    const node = {};
    for (const full of paths) { let n = node; const parts = full.split('/'); for (const part of parts.slice(0, -1)) n = n[part] ||= {}; n[parts.at(-1)] = ['modules/mcp', 'modules/project-setup', 'native/mcp-router'].includes(full) ? {} : 'blob'; }
    function encode(n, prefix = '') { const rows = Object.entries(n).map(([name, v]) => { const sha = crypto.createHash('sha1').update(prefix + name).digest('hex'); if (v !== 'blob') encode(v, `${prefix}${name}/`); return { path: name, sha, type: v === 'blob' ? 'blob' : 'tree' }; });
      const sha = prefix ? crypto.createHash('sha1').update(prefix.slice(0, -1)).digest('hex') : '0'.repeat(40); trees.set(sha, { truncated: false, tree: rows }); return sha; }
    return encode(node);
  }
  const rootTree = tree(require('./native-linux-016-input.cjs').PRIVATE_PATHS);
  for (const commit of [privateProof.expected.sourceCommit, oldRoot.sourceCommit, lane.SOURCE.sourceCommit]) {
    const proof = map.get(`git/commits/${commit}`); trees.set(proof.tree.sha, trees.get(rootTree));
  }
  const requests = [], calls = [], counts = { keys: 0, signatures: 0 }; let armed = false;
  const input = path.join(root, 'artifacts/input/producer.zip'), proofDir = path.join(root, 'artifacts/read-only-proofs'), planFile = path.join(root, 'approved-plan.json');
  const inputs = { input, proofs: proofDir, plan: planFile, planSha256: '', output: path.join(root, 'artifacts/signed017') };
  async function request(route) {
    requests.push(route); let result;
    if (route.startsWith('git/trees/')) result = trees.get(route.slice('git/trees/'.length));
    else if (route.startsWith('contents/')) {
      const name = route.slice('contents/'.length).split('?')[0], bytes = fixtureJson(name === 'package-lock.json' ? { version: '0.1.17', packages: { '': { version: '0.1.17' } } } : { version: '0.1.17' });
      result = { path: name, type: 'file', encoding: 'base64', size: bytes.length, sha: '2'.repeat(40), content: bytes.toString('base64') };
    } else result = map.get(route);
    assert.ok(result, `Unexpected synthetic API route ${route}`); result = structuredClone(result);
    if (armed && fault === 'api-failed' && route === `actions/runs/${p.producer.runId}`) result.conclusion = 'failure';
    if (armed && fault === 'api-artifact' && route === `actions/artifacts/${p.producer.artifactId}`) result.digest = 'sha256:' + '0'.repeat(64);
    if (armed && fault === 'old-api' && route === 'actions/runs/9101') result.status = 'in_progress';
    if (armed && fault === 'api-replace' && route === 'actions/runs/9401') { const b = fs.readFileSync(input); fs.renameSync(input, input + '.kept'); fs.writeFileSync(input, b); }
    if (armed && fault === 'nonidentity-api-metadata') {
      // The existing validators bind repository id/full_name and workflow
      // id/path, not descriptions or workflow timestamp presentation.
      if (/^actions\/runs\/[0-9]+$/.test(route)) result.repository.description = 'Synthetic nonidentity metadata change';
      if (route.startsWith('actions/workflows/')) { result.created_at = '2026-10-20T03:00:00.000+02:00'; result.updated_at = '2026-10-20T03:00:00.000+02:00'; }
    }
    return result;
  }
  const oldFresh = await oldWriter.fresh(oldPlan, oldReceipt.producer, request);
  const deriveFresh = await provenance.fresh({ plan: f.plan, handoff: f.handoff, preparedFile: put(path.join(root, 'fixture/prepared-unix.json'), f.files['prepared-unix.json']) }, request);
  const selector = { originalSourceCommit: oldRoot.sourceCommit, originalSourceTree: oldRoot.sourceTree, targetSource: lane.SOURCE, sources: selectorSources,
    executable: c.record(selectorBytes), reusedWithoutCompilation: true, signaturesRequired: true };
  const app17 = unpack(raw17, 'APP'), host17 = lane.hostProfile(raw17, app17);
  const original17 = tar({ AppRun: Buffer.from('#!/bin/sh\n'), 'usr/bin/creator-hub': app17, 'usr/lib/Creator Hub/modules.tar.gz': packed,
    'usr/lib/libwebkit2gtk-4.1.so.0': elf('webkit'), 'usr/lib/libjavascriptcoregtk-4.1.so.0': elf('JS'), 'usr/lib/webkit2gtk-4.1/WebKitWebProcess': elf('web process'),
    'usr/lib/webkit2gtk-4.1/WebKitNetworkProcess': elf('network process'), 'usr/lib/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so': elf('injected') });
  const transport17 = tar({ ...Object.fromEntries(Object.keys(original17.inventory.entries).filter(name => original17.inventory.entries[name].kind === 'file').map(name => [name,
    name === 'usr/bin/creator-hub' ? app17 : name === 'usr/lib/Creator Hub/modules.tar.gz' ? packed : name === 'AppRun' ? Buffer.from('#!/bin/sh\n') : elf(name.endsWith('libwebkit2gtk-4.1.so.0') ? 'webkit' : name.endsWith('libjavascriptcoregtk-4.1.so.0') ? 'JS' : name.endsWith('WebKitWebProcess') ? 'web process' : name.endsWith('WebKitNetworkProcess') ? 'network process' : 'injected')])), [lane.HOST]: host17, [lane.SELECTOR]: selectorBytes });
  const manifest = lane.manifest(transport17.inventory, { ...c.record(transport17.bytes), unpackedSize: transport17.inventory.unpackedSize });
  const independentProfileSha256 = c.hash(Buffer.from(JSON.stringify((({ tools: _, ...profile }) => profile)(inputProfile), null, 2)));
  const tool = { schemaVersion: 1, scope: 'controlled-validator-builds-only', packagingSource: p.producer.sourceCommit, packagingTree: p.producer.sourceTree,
    rootSource: lane.SOURCE, independentProfileSha256, internalProfile: c.record(profileBytes), sources: toolSources, publicKey: toolSources['src-tauri/src/catalog-key.pub'],
    compiler: 'rustc 1.99.0 (synthetic)\nhost: x86_64-unknown-linux-gnu\n', cargo: 'cargo 1.99.0 (synthetic)', arguments: { verifier: ['build', '--release', '--locked', '--manifest-path', '/fixture/src-tauri/Cargo.toml', '--example', 'verify-package-input', '--target-dir', '/tmp/private017-portable-stage/verifier-build'],
      decoder: ['build', '--release', '--locked', '--manifest-path', '/fixture/native/module-archive/Cargo.toml', '--bin', 'creator-hub-module-archive', '--target-dir', '/tmp/private017-portable-stage/decoder-build'] }, tools: inputProfile.tools,
    freshSingleLinkCopies: true, rootRecompiled: false, selectorRecompiled: false, privateModulesRecompiled: false, releaseReady: false };
  const receipt = { schemaVersion: 1, scope: 'unsigned-private-linux-017-portable-packaging-only', packagingSource: p.producer.sourceCommit,
    rootSource: lane.SOURCE, assembly: assemblyApi, selectorReuse: selector, originalSigned016Plan: inputProfile.signed016.planSha256,
    signed017Plan: inputProfile.signed017.planSha256, hermetic: false, upstreamToolsPinned: false, ...lane.flags(),
    appImage: c.record(elf('ordinary17')), archive: manifest.archive, manifest: c.record(c.json(manifest)), hostProfile: { ...c.record(host17), version: '0.1.17', executable: c.record(app17), scope: 'canonical-appdir-transport-only', appImageContainsProfile: false },
    ...closure(transport17.inventory.entries), packagingCompleted: true };
  const requestRecord = c.record(c.json({ profile: (({ tools: _, ...v }) => v)(inputProfile), carriers, profileSha256: independentProfileSha256 }));
  const bodies = { 'package-receipt.json': c.json(receipt), [c.IMAGE]: elf('ordinary17'), [c.UNSIGNED]: c.json(manifest), [c.ARCHIVE]: transport17.bytes,
    'appdir-original-inventory.json': c.json(original17.inventory), 'appdir-flattened-inventory.json': c.json(transport17.inventory),
    'download-proof.json': c.json({ assembly: assemblyApi, signed016: signed16Api, signed017: signed17Api, releaseReady: false }),
    'data-preflight.json': c.json({ profileSha256: independentProfileSha256, request: requestRecord, proof16: oldFresh, proof17: deriveFresh, selector, signatureVerificationPending: true, releaseReady: false }), 'tool-build.json': c.json(tool) };
  for (const [name, b] of Object.entries(proofBodies)) put(path.join(proofDir, name), b);
  function save(extra = {}) {
    p.files = Object.fromEntries(Object.entries(bodies).map(([name, b]) => [name, { member: `${name === 'download-proof.json' || name === 'data-preflight.json' || name === 'tool-build.json' ? 'stage' : 'output'}/${name}`, ...c.record(b) }]));
    const archive = zip({ ...Object.fromEntries(Object.entries(bodies).map(([name, b]) => [p.files[name].member, b])), ...extra });
    put(input, archive); p.producer.zip = c.record(archive); put(planFile, c.json(p)); inputs.planSha256 = c.hash(c.json(p));
    addApi(p.producer, api(p.producer, { branch: lane.BRANCH.slice(11), workflow: lane.WORKFLOW, job: 'package', artifact: 'private-linux-portable-fixture-017-unsigned-9401-1' }));
  }
  save(); requests.length = 0; armed = true;
  if (fault === 'key-crlf') put(path.join(root, w.PUBLIC_KEY), Buffer.from(fs.readFileSync(path.join(root, w.PUBLIC_KEY), 'ascii').replace(/\n/g, '\r\n'), 'ascii'));
  function execute(program, args, options) {
    calls.push({ program, args });
    if (program === 'python') return execFileSync(PYTHON, args, { ...options, stdio: 'pipe' });
    if (program === 'git') {
      if (args[0] === 'ls-tree') {
        const isSelector = args.includes('native/linux-portable-deployment');
        const records = isSelector ? selectorGit : toolSources;
        return Object.entries(records).map(([name, v]) => `100644 blob ${v.gitBlob}\t${name}`).join('\0') + '\0';
      }
      assert.equal(args[0], 'cat-file'); assert.ok(blobs.has(args[2])); return blobs.get(args[2]);
    }
    if (program.endsWith('creator-hub-module-archive.exe')) {
      assert.deepEqual(args.slice(0, 1), ['verify']); const manifest = JSON.parse(options.input), hashes = moduleArchive.validateBinding(manifest);
      if (fault === 'decoder-refuse') throw Error('Mock decoder refused');
      old.archiveContents(fs.readFileSync(args[1]), { archive: manifest.payloadArchive,
        entries: Object.fromEntries(Object.entries(manifest.payloadArchive.files).map(([name, entry]) => [name, { kind: 'file', ...entry, sha256: hashes[name] }])) });
      if (fault === 'decoder-drift') fs.appendFileSync(decoder, 'changed');
      return JSON.stringify({ files: fault === 'decoder-wrong-map' ? {} : hashes });
    }
    assert.ok(program.endsWith('verify-package-input.exe')); const body = fs.readFileSync(args[0]), sig = fs.readFileSync(args[1]);
    if (fault === 'accept-mutation') return `Verified trusted package signature: ${c.hash(body)}. No activation or client changes.`;
    if (fault === 'original-signature' && args[0].endsWith(old.MANIFEST)) throw Error('Mock old trusted signature refused');
    assert.ok(approvedSignatures.has(`${c.hash(body)}:${sig.toString('base64')}`) || sig.equals(signature(body)), 'Mock production verifier refused');
    return `Verified trusted package signature: ${c.hash(body)}. No activation or client changes.`;
  }
  const key = path.join(root, 'NO-KEY-EXISTS'), signer = { signingKey(selected) { counts.keys++; assert.equal(selected, root); assert.equal(fs.existsSync(key), false); return key; },
    signDetached(file, selected) {
      counts.signatures++; assert.equal(selected, key); assert.ok(file.includes('private-portable017-sign-work-')); assert.ok(!file.startsWith(inputs.output + path.sep));
      const body = fs.readFileSync(file); if (fault === 'sign' || fault === 'second-sign' && counts.signatures === 2) throw Error('PRIVATE SENTINEL');
      if (fault === 'proof-drift') fs.appendFileSync(path.join(proofDir, 'profile.json'), 'changed');
      if (fault === 'key-drift') fs.appendFileSync(path.join(root, w.PUBLIC_KEY), 'changed');
      if (fault === 'temporary-drift') fs.appendFileSync(file, 'changed');
      if (fault === 'output-drift') fs.appendFileSync(path.join(inputs.output, c.ARCHIVE), 'changed');
      return fault === 'signature' ? Buffer.from('invalid') : fault === 'signature-size' ? Buffer.alloc(4097) : signature(body);
    } };
  return { root, inputs, plan: p, bodies, assembled, f, previous: { plan: oldPlan, checked: oldChecked }, selector, selectorBuild, manifest, receipt, tool, proofBodies, verifier, decoder, put, save, requests, calls, counts,
    services: { root, platform: 'win32', execute, request, signer } };
}

test('private017 full synthetic signing flow authenticates old016 and new017 before selecting a mocked key', async t => {
  const f = await create(t), before = Object.fromEntries(c.PROOFS.map(name => [name, c.record(fs.readFileSync(path.join(f.inputs.proofs, name)))]));
  fs.linkSync(f.decoder, path.join(f.root, 'cargo-decoder-hardlink')); assert.equal(fs.statSync(f.decoder).nlink, 2);
  const result = await w.sign(f.inputs, f.services); assert.deepEqual(f.counts, { keys: 1, signatures: 2 });
  assert.equal(result.version, '0.1.17'); assert.equal(result.acceptanceOnly, true);
  for (const [name, value] of Object.entries(c.FLAGS)) assert.equal(result[name], value);
  const descriptor = c.parse(fs.readFileSync(path.join(f.inputs.output, c.DESCRIPTOR)));
  assert.equal(descriptor.minHubVersion, '0.1.16'); assert.equal(descriptor.restartProtocol, 1); assert.equal(descriptor.version, '0.1.17');
  assert.equal(descriptor.executableSha256, f.manifest.entries['usr/bin/creator-hub'].sha256);
  const receipt = c.parse(fs.readFileSync(path.join(f.inputs.output, w.RECEIPT)));
  assert.equal(receipt.final016Qualified, false); assert.equal(receipt.privateKeyIncluded, false); assert.equal(receipt.authorizedBodiesSigned, 2);
  assert.deepEqual(receipt.resourceArchiveDecoder.executable, f.plan.decoder);
  assert.deepEqual(receipt.resourceArchiveDecoder.source, lane.SOURCE);
  assert.deepEqual(receipt.resourceArchiveDecoder.verifiedVersions, ['0.1.16', '0.1.17']);
  const decoded = f.calls.filter(call => call.program.endsWith('creator-hub-module-archive.exe'));
  assert.equal(decoded.length, 2); assert.ok(decoded.every(call => fs.statSync(call.program).nlink === 1));
  assert.deepEqual(decoded.map(call => path.basename(path.dirname(call.args[1]))), ['baseline016', 'assembly']);
  for (const name of c.PROOFS) assert.deepEqual(c.record(fs.readFileSync(path.join(f.inputs.proofs, name))), before[name]);
  for (const name of c.FILES) assert.ok(fs.readFileSync(path.join(f.inputs.output, name === c.UNSIGNED ? c.MANIFEST : name)).equals(f.bodies[name]));
  assert.ok(f.requests.includes('actions/runs/9401') && f.requests.includes('actions/runs/9101') && f.requests.includes('contents/package.json?ref=' + lane.SOURCE.sourceCommit));
});

test('repacked resource archives admit exactly the signed two-runtime-file delta, not compressed-byte equality', async t => {
  const f = await create(t), original = f.f.handoff.builtinManifest;
  const derived = meta.validateDerivation(f.f.files['derivation017.json'], f.f.plan, f.f.handoff, f.f.prepared,
    f.f.originalRecords, f.f.files['runtime017.json'], f.f.files['runtime017.minisig']);
  const transferPin = c.record(f.f.files['modules.tar.gz']), baselinePin = f.previous.checked.receipt.producer.pins.files['modules.tar.gz'];
  assert.throws(() => assert.deepEqual(baselinePin, transferPin), 'The old writer guard incorrectly equated transfer and resource archives');
  assert.throws(() => assert.deepEqual(c.record(f.assembled.archive), transferPin), 'The old contract guard incorrectly equated017 resources with the016 transfer');
  assert.notDeepEqual(c.record(f.assembled.archive), baselinePin);
  assert.deepEqual(derived.modules, original.modules);
  assert.deepEqual(Object.keys(derived.managedRouting.files), Object.keys(original.managedRouting.files));
  const changed = Object.keys(original.managedRouting.files).filter(name => original.managedRouting.files[name] !== derived.managedRouting.files[name]);
  assert.deepEqual(changed.sort(), ['routing/runtime.json', 'routing/runtime.minisig']);
  assert.equal(derived.managedRouting.files['routing/runtime.json'], c.hash(f.f.files['runtime017.json']));
  assert.equal(derived.managedRouting.files['routing/runtime.minisig'], c.hash(f.f.files['runtime017.minisig']));
  await w.sign(f.inputs, f.services); assert.deepEqual(f.counts, { keys: 1, signatures: 2 });
});

test('repinned actual resource descriptors cannot alter private entries or the exact signed runtime overlay', async t => {
  const f = await create(t), signed = { ...f.f, records: Object.fromEntries(Object.entries(f.f.files).map(([name, b]) => [name, c.record(b)])),
    manifest: meta.validateDerivation(f.f.files['derivation017.json'], f.f.plan, f.f.handoff, f.f.prepared, f.f.originalRecords,
      f.f.files['runtime017.json'], f.f.files['runtime017.minisig']) };
  for (const mutate of [m => { m.modules.mcp.files[Object.keys(m.modules.mcp.files)[0]] = '0'.repeat(64); },
    m => { m.modules.setup.files[Object.keys(m.modules.setup.files)[0]] = '0'.repeat(64); },
    m => { m.managedRouting.files['routing/router.json'] = '0'.repeat(64); },
    m => { m.managedRouting.files['routing/runtime.json'] = '0'.repeat(64); },
    m => { m.managedRouting.files['routing/runtime.minisig'] = '0'.repeat(64); }]) {
    const assembled = { ...f.assembled }, manifest = JSON.parse(assembled.manifest), p = structuredClone(f.plan);
    mutate(manifest); assembled.manifest = c.json(manifest);
    const receipt = c.parse(assembled.receipt); receipt.manifest = c.record(assembled.manifest); assembled.receipt = c.json(receipt);
    for (const role of ['manifest', 'receipt']) Object.assign(p.inputProfile.assembly017.files[role], c.record(assembled[role]));
    p.proofs['profile.json'] = c.record(lane.json(p.inputProfile));
    assert.throws(() => c.validateOutput(p, f.bodies, assembled, signed, f.selector), /embedded descriptor differs from its signed derivation/);
  }
});

test('existing decoder contract rejects third-entry content or runtime substitutions despite repinned container bytes', async t => {
  const f = await create(t), manifest = JSON.parse(f.assembled.manifest);
  const contents = { ...f.f.contents, 'routing/runtime.json': f.f.files['runtime017.json'], 'routing/runtime.minisig': f.f.files['runtime017.minisig'] };
  const archiveFile = path.join(f.root, 'repacked-module-resource.tar.gz');
  f.put(archiveFile, f.assembled.archive); moduleArchive.verify(archiveFile, manifest, f.decoder, f.services.execute);
  const cases = [Object.keys(manifest.modules.mcp.files)[0], Object.keys(manifest.modules.setup.files)[0], 'routing/router.json', 'routing/runtime.json'];
  for (const name of cases) {
    const changed = Buffer.from(`Unauthorized third-entry bytes ${name}`), altered = structuredClone(manifest);
    const files = altered.modules.mcp.files[name] ? altered.modules.mcp.files : altered.modules.setup.files[name] ? altered.modules.setup.files : altered.managedRouting.files;
    files[name] = c.hash(changed); delete altered.payloadArchive;
    const packed = resource(altered, { ...contents, [name]: changed });
    f.put(archiveFile, packed.bytes);
    // The container pin is new, but each decoded file must still match the signed descriptor.
    assert.throws(() => moduleArchive.verify(archiveFile, { ...manifest, payloadArchive: packed.binding }, f.decoder, f.services.execute));
  }
});

test('decoder pin and fixed017 compiler sources are mandatory with no path override or working-source drift', async t => {
  const f = await create(t);
  assert.deepEqual(w.DECODER_CRATE_SOURCES, ['native/module-archive/Cargo.toml', 'native/module-archive/Cargo.lock', 'native/module-archive/src/main.rs']);
  assert.deepEqual(w.DECODER_SOURCES, [...w.DECODER_CRATE_SOURCES, 'src-tauri/src/module_archive.rs']);
  for (const mutate of [p => { delete p.decoder; }, p => { p.decoder.sha256 = 'invalid'; }, p => { p.decoder.path = 'other.exe'; }]) {
    const p = structuredClone(f.plan); mutate(p); assert.throws(() => c.validatePlan(p));
  }
  for (const fault of ['pin', 'source', 'extra-source', 'source-drift']) {
    const f = await create(t), source = path.join(f.root, w.DECODER_SOURCES[2]);
    if (fault === 'pin') { f.plan.decoder.sha256 = '0'.repeat(64); f.save(); }
    if (fault === 'source') fs.appendFileSync(source, 'changed compiler input');
    if (fault === 'extra-source') f.put(path.join(f.root, 'native/module-archive/src/untracked.rs'), Buffer.from('unknown compiler input'));
    const execute = f.services.execute;
    if (fault === 'source-drift') f.services.execute = (program, args, options) => {
      const result = execute(program, args, options);
      if (program.endsWith('creator-hub-module-archive.exe')) fs.appendFileSync(source, 'changed after decoding');
      return result;
    };
    await assert.rejects(w.sign(f.inputs, f.services), { message: w.FAILURE }); assert.deepEqual(f.counts, { keys: 0, signatures: 0 });
  }
});

for (const phase of ['before-decoding', 'after-first-decode']) test(`imported decoder Root module drift ${phase} refuses before any key selection`, async t => {
  const f = await create(t), imported = path.join(f.root, 'src-tauri/src/module_archive.rs'), execute = f.services.execute;
  let decoded = 0;
  if (phase === 'before-decoding') fs.appendFileSync(imported, 'changed imported compiler input');
  f.services.execute = (program, args, options) => {
    const result = execute(program, args, options);
    if (program.endsWith('creator-hub-module-archive.exe') && ++decoded === 1 && phase === 'after-first-decode') fs.appendFileSync(imported, 'changed after held input was read');
    return result;
  };
  await assert.rejects(w.sign(f.inputs, f.services), { message: w.FAILURE });
  assert.deepEqual(f.counts, { keys: 0, signatures: 0 });
  assert.equal(decoded, phase === 'before-decoding' ? 0 : 1);
});
test('nonidentity API metadata changes pass the mocked full flow while both raw response sets remain retained', async t => {
  const f = await create(t, 'nonidentity-api-metadata');
  const captured = Object.fromEntries(['download-proof.json', 'data-preflight.json'].map(name => [name, Buffer.from(f.bodies[name])]));
  const result = await w.sign(f.inputs, f.services); assert.equal(result.version, '0.1.17'); assert.deepEqual(f.counts, { keys: 1, signatures: 2 });
  const fresh = c.parse(fs.readFileSync(path.join(f.inputs.output, 'fresh-api.json'))), oldDownload = c.parse(captured['download-proof.json']), oldData = c.parse(captured['data-preflight.json']);
  // Exact reproduction of the previous comparisons: the valid nonidentity
  // change would have refused before reaching the mocked signer.
  assert.throws(() => assert.deepEqual(oldDownload, { assembly: fresh.assembly, signed016: fresh.signed016, signed017: fresh.signed017, releaseReady: false }));
  assert.throws(() => assert.deepEqual(oldData.proof16, fresh.original016));
  assert.throws(() => assert.deepEqual(oldData.proof17, fresh.derivation017));
  for (const [name, bytes] of Object.entries(captured)) assert.deepEqual(fs.readFileSync(path.join(f.inputs.output, name)), bytes, 'Captured full responses must remain byte-exact');
  assert.equal(fresh.assembly.run.repository.description, 'Synthetic nonidentity metadata change');
  assert.equal(fresh.original016.packaging.workflow.updated_at, '2026-10-20T03:00:00.000+02:00');
  assert.equal(fresh.derivation017.baseline.run.repository.description, 'Synthetic nonidentity metadata change');
  assert.equal(oldDownload.assembly.run.repository.description, undefined); assert.equal(oldData.proof16.packaging.workflow.updated_at, undefined);
});
test('retained and fresh full API responses independently require all fixed identities under the existing validators', async t => {
  const f = await create(t), originalDownload = c.parse(f.bodies['download-proof.json']), originalData = c.parse(f.bodies['data-preflight.json']);
  function state() {
    const download = structuredClone(originalDownload), data = structuredClone(originalData);
    return { download, data, fresh: { assembly: structuredClone(originalDownload.assembly), signed016: structuredClone(originalDownload.signed016),
      signed017: structuredClone(originalDownload.signed017), original016: structuredClone(originalData.proof16), derivation017: structuredClone(originalData.proof17) } };
  }
  function check(value) {
    w.validateCaptured(f.plan, { ...f.bodies, 'download-proof.json': c.json(value.download), 'data-preflight.json': c.json(value.data) },
      originalData.request, f.tool, f.selector, f.f, f.previous, value.fresh);
  }
  check(state());
  const valid = state();
  for (const side of ['captured', 'fresh']) {
    const dl = side === 'captured' ? valid.download : valid.fresh, data = side === 'captured' ? valid.data : { proof16: valid.fresh.original016, proof17: valid.fresh.derivation017 };
    for (const proof of [dl.assembly, dl.signed016, dl.signed017, data.proof16.packaging, data.proof16.original.proof]) {
      proof.run.repository.description = 'Nonidentity description'; proof.workflow.updated_at = '2026-10-20T03:00:00.000+02:00';
    }
    data.proof16.original.privateProof.run.repository.description = 'Nonidentity description'; data.proof17.baseline.run.repository.description = 'Nonidentity description';
  }
  check(valid);
  const groups = [
    ['assembly', (s, side) => (side === 'captured' ? s.download : s.fresh).assembly],
    ['signed016', (s, side) => (side === 'captured' ? s.download : s.fresh).signed016],
    ['signed017', (s, side) => (side === 'captured' ? s.download : s.fresh).signed017],
    ['old packaging', (s, side) => (side === 'captured' ? s.data.proof16 : s.fresh.original016).packaging],
    ['old assembly', (s, side) => (side === 'captured' ? s.data.proof16 : s.fresh.original016).original.proof],
    ['old private producer', (s, side) => (side === 'captured' ? s.data.proof16 : s.fresh.original016).original.privateProof],
    ['derivation baseline', (s, side) => (side === 'captured' ? s.data.proof17 : s.fresh.derivation017).baseline],
  ];
  const changes = [
    ['run id', p => { p.run.id++; }], ['job id', p => { p.job.id++; }], ['source', p => { p.run.head_sha = '0'.repeat(40); }],
    ['artifact id', p => { p.artifact.id++; }], ['digest', p => { p.artifact.digest = 'sha256:' + '0'.repeat(64); }],
    ['source tree', p => { p.commit.tree.sha = '0'.repeat(40); }],
  ];
  for (const side of ['captured', 'fresh']) for (const [name, select] of groups) for (const [kind, mutate] of changes) {
    const value = state(); mutate(select(value, side)); assert.throws(() => check(value), `${side} ${name} changed ${kind} must refuse`);
  }
  for (const side of ['captured', 'fresh']) for (const field of ['root', 'privateSourcePaths', 'versionSources']) {
    const value = state(), proof = side === 'captured' ? value.data.proof17 : value.fresh.derivation017;
    if (field === 'root') proof.root.commit.tree.sha = '0'.repeat(40);
    else { const name = Object.keys(proof[field])[0]; proof[field][name] = field === 'privateSourcePaths' ? '0'.repeat(40) : { ...proof[field][name], sha256: '0'.repeat(64) }; }
    assert.throws(() => check(value), `${side} changed ${field} must refuse`);
  }
  const producer = api(f.plan.producer, { branch: lane.BRANCH.slice(11), workflow: lane.WORKFLOW, job: 'package', artifact: 'private-linux-portable-fixture-017-unsigned-9401-1' });
  c.validateAPI(f.plan, producer);
  for (const [name, mutate] of changes) { const value = structuredClone(producer); mutate(value); assert.throws(() => c.validateAPI(f.plan, value), `fresh packaging changed ${name} must refuse`); }
});
test('CLI accepts only explicit read-only proofs and fixed plan/input/output options', () => {
  assert.deepEqual(w.cli(['--input', 'a', '--proofs', 'b', '--plan', 'c', '--plan-sha256', 'd', '--output', 'e']), { input: 'a', proofs: 'b', plan: 'c', planSha256: 'd', output: 'e' });
  for (const args of [[], ['--input', 'a', '--plan', 'b', '--plan-sha256', 'c', '--output', 'd'], ['--input', 'a', '--proofs', 'b', '--plan', 'c', '--plan-sha256', 'd', '--key', 'e']]) assert.throws(() => w.cli(args));
});
test('public-key source admits only LF/CRLF representations of the exact pinned canonical Git bytes', () => {
  const lf = Buffer.from('untrusted comment: public key\nSYNTHETIC-PUBLIC-KEY\n'), crlf = Buffer.from(lf.toString('ascii').replace(/\n/g, '\r\n'));
  const expected = { ...c.record(lf), gitBlob: crypto.createHash('sha1').update(`blob ${lf.length}\0`).update(lf).digest('hex') };
  w.verifyPublicKeySource(lf, expected); w.verifyPublicKeySource(crlf, expected);
  for (const bytes of [Buffer.from(lf.toString().replace('PUBLIC-KEY', 'CHANGED-KEY')), Buffer.from(lf.toString().replace('comment:', 'comment: ')),
    Buffer.from(lf.toString().trim()), Buffer.from(lf.toString().replace(/\n/g, '\r')), Buffer.concat([Buffer.from([239, 187, 191]), lf])]) assert.throws(() => w.verifyPublicKeySource(bytes, expected));
  assert.throws(() => w.verifyPublicKeySource(lf, { ...expected, gitBlob: '0'.repeat(40) }));
});
test('CRLF public-key checkout passes the full mocked signing flow and remains byte-exact', async t => {
  const f = await create(t, 'key-crlf'), file = path.join(f.root, w.PUBLIC_KEY), before = fs.readFileSync(file);
  const result = await w.sign(f.inputs, f.services); assert.equal(result.version, '0.1.17'); assert.deepEqual(f.counts, { keys: 1, signatures: 2 }); assert.deepEqual(fs.readFileSync(file), before);
});
test('changed public keys refuse, while an unrelated current Cargo example cannot invalidate immutable selector reuse', async t => {
  const f = await create(t), key = path.join(f.root, w.PUBLIC_KEY), before = fs.readFileSync(key);
  fs.writeFileSync(key, Buffer.from(before.toString().replace('synthetic', 'changed')));
  assert.throws(() => w.sourceProof(f.root, f.plan, f.tool, f.selectorBuild, f.services.execute)); fs.writeFileSync(key, before);
  const source = path.join(f.root, 'native/linux-portable-deployment/Cargo.toml');
  fs.appendFileSync(source, '\n[[example]]\nname = "verify-package-input"\npath = "../../src-tauri/examples/verify-package-input.rs"\n');
  const changedCheckout = fs.readFileSync(source);
  assert.deepEqual(w.sourceProof(f.root, f.plan, f.tool, f.selectorBuild, f.services.execute), f.selector);
  assert.deepEqual(fs.readFileSync(source), changedCheckout, 'Working source must not be rewritten or normalized');
});
test('retained39358518825 canonical key binds the unchanged current LF/CRLF checkout without selecting a key', t => {
  const file = path.join(__dirname, '../artifacts/release-016-updater-20261019/private017-portable-39358518825/members/tool-build.json');
  if (!fs.existsSync(file)) return t.skip('Retained actual producer evidence is not present on this runner');
  const bytes = fs.readFileSync(file); assert.deepEqual(c.record(bytes), { size: 30158, sha256: '01daf8117885e6b981600c333932b227d8a2377101d7777f440b41707a7860ed' });
  const expected = c.parse(bytes).publicKey, working = fs.readFileSync(path.join(__dirname, '..', w.PUBLIC_KEY));
  assert.equal(expected.size, 119); w.verifyPublicKeySource(working, expected);
  const changed = Buffer.from(working); changed[changed.length - 3] ^= 1; assert.throws(() => w.verifyPublicKeySource(changed, expected));
});
for (const fault of ['api-failed', 'api-artifact', 'old-api', 'api-replace', 'accept-mutation', 'original-signature', 'decoder-refuse', 'decoder-wrong-map', 'decoder-drift']) test(`pre-key ${fault} refusal never reaches the protected signer`, async t => {
  const f = await create(t, fault); await assert.rejects(w.sign(f.inputs, f.services), { message: w.FAILURE }); assert.deepEqual(f.counts, { keys: 0, signatures: 0 }); assert.equal(fs.existsSync(f.inputs.output), false);
});
for (const fault of ['sign', 'second-sign', 'signature', 'signature-size', 'proof-drift', 'key-drift', 'temporary-drift', 'output-drift']) test(`post-preflight ${fault} is refused and partial owned evidence is retained`, async t => {
  const f = await create(t, fault); await assert.rejects(w.sign(f.inputs, f.services), { message: w.FAILURE }); assert.equal(f.counts.keys, 1); assert.ok(f.counts.signatures <= 2);
  assert.equal(fs.existsSync(f.inputs.output), true); assert.equal(fs.existsSync(path.join(f.inputs.output, w.RECEIPT)), false);
  await assert.rejects(w.sign(f.inputs, f.services), { message: w.FAILURE }); assert.equal(f.counts.keys, 1);
});
test('017 contract rejects16 admission, unknown profiles/roles, oversized manifests and caller overrides', async t => {
  const f = await create(t); c.validatePlan(f.plan);
  for (const mutate of [p => { p.profile = old.PROFILE; }, p => { p.rootSource.sourceCommit = '0'.repeat(40); }, p => { p.flags = { releaseReady: true }; },
    p => { p.files[c.UNSIGNED].size = c.SIGNED_META + 1; }, p => { p.files[c.IMAGE].member = '../image'; }, p => { p.proofs['unknown.json'] = p.verifier; },
    p => { p.inputProfile.profile = 'production-portable-016'; }, p => { p.carriers.signed016.members['plan.json'] = 'elsewhere.json'; }]) {
    const p = structuredClone(f.plan); mutate(p); assert.throws(() => c.validatePlan(p));
  }
  assert.equal(base.production016().VERSION, '0.1.16'); assert.throws(() => base.production016({ version: '0.1.17' }));
});
test('TAR/inventory/Root/host/selector/closure changes fail even with independently repinned producer files', async t => {
  const f = await create(t);
  const signed = { ...f.f, records: Object.fromEntries(Object.entries(f.f.files).map(([name, b]) => [name, c.record(b)])), manifest: meta.validateDerivation(f.f.files['derivation017.json'], f.f.plan, f.f.handoff, f.f.prepared, f.f.originalRecords, f.f.files['runtime017.json'], f.f.files['runtime017.minisig']) };
  c.validateOutput(f.plan, f.bodies, f.assembled, signed, f.selector);
  const differentOriginal = { ...f.f.originalRecords, 'modules.tar.gz': c.record(Buffer.from('different original carrier archive')) };
  assert.throws(() => meta.validateOriginal(f.f.plan, f.f.handoff, f.f.prepared, differentOriginal), /Original016 bytes changed/);
  for (const mutate of [b => { b[c.ARCHIVE] = Buffer.concat([b[c.ARCHIVE], Buffer.from('trailing')]); }, b => { const m = c.parse(b[c.UNSIGNED]); m.version = '0.1.16'; b[c.UNSIGNED] = c.json(m); },
    b => { const r = c.parse(b['package-receipt.json']); r.hostProfile.version = '0.1.16'; b['package-receipt.json'] = c.json(r); },
    b => { const r = c.parse(b['package-receipt.json']); r.selectorReuse.executable.sha256 = '0'.repeat(64); b['package-receipt.json'] = c.json(r); },
    b => { const r = c.parse(b['package-receipt.json']); r.closureAbi.targetAbiVerified = true; b['package-receipt.json'] = c.json(r); },
    b => { const r = c.parse(b['package-receipt.json']); delete r.dependencies.closure['usr/bin/creator-hub']; b['package-receipt.json'] = c.json(r); }]) {
    const b = Object.fromEntries(Object.entries(f.bodies).map(([name, bytes]) => [name, Buffer.from(bytes)])); mutate(b);
    const p = structuredClone(f.plan); for (const name of c.FILES) Object.assign(p.files[name], c.record(b[name]));
    assert.throws(() => c.validateOutput(p, b, f.assembled, signed, f.selector));
  }
});
test('tool build proof requires source-derived pins, exact fixed build arguments and no compilation claims for Root/selector', async t => {
  const f = await create(t); c.validateToolBuild(f.plan, f.tool);
  for (const change of [x => { x.tools.decoder.sha256 = '0'.repeat(64); }, x => { x.arguments.verifier.push('--features', 'untrusted'); },
    x => { x.rootRecompiled = true; }, x => { x.sources['src-tauri/src/catalog-key.pub'].gitBlob = 'bad'; }, x => { x.packagingTree = '0'.repeat(40); }]) {
    const tool = structuredClone(f.tool); change(tool); assert.throws(() => c.validateToolBuild(f.plan, tool));
  }
});
test('repinned canonical TAR cannot hide changed actual Root, host profile or reused selector bytes', async t => {
  const f = await create(t), signed = { ...f.f, records: Object.fromEntries(Object.entries(f.f.files).map(([name, b]) => [name, c.record(b)])),
    manifest: meta.validateDerivation(f.f.files['derivation017.json'], f.f.plan, f.f.handoff, f.f.prepared, f.f.originalRecords, f.f.files['runtime017.json'], f.f.files['runtime017.minisig']) };
  const unpacked = zlib.gunzipSync(f.bodies[c.ARCHIVE]), originalContents = {}; let offset = 0;
  for (const [name, entry] of Object.entries(f.manifest.entries).sort(([a], [b]) => a < b ? -1 : 1)) {
    offset += 512; if (entry.kind !== 'file') continue;
    originalContents[name] = Buffer.from(unpacked.subarray(offset, offset + entry.size)); offset += entry.size + (512 - entry.size % 512) % 512;
  }
  for (const name of ['usr/bin/creator-hub', lane.HOST, lane.SELECTOR]) {
    const contents = Object.fromEntries(Object.entries(originalContents).map(([n, b]) => [n, Buffer.from(b)]));
    if (name === lane.HOST) { const host = c.parse(contents[name]); host.version = '0.1.16'; contents[name] = c.json(host); }
    else contents[name][40] ^= 1;
    const packed = tar(contents), manifest = lane.manifest(packed.inventory, { ...c.record(packed.bytes), unpackedSize: packed.inventory.unpackedSize });
    const bodies = { ...f.bodies, [c.ARCHIVE]: packed.bytes, [c.UNSIGNED]: c.json(manifest), 'appdir-flattened-inventory.json': c.json(packed.inventory) };
    if (name === 'usr/bin/creator-hub') { const original = c.parse(bodies['appdir-original-inventory.json']); original.entries[name] = packed.inventory.entries[name]; bodies['appdir-original-inventory.json'] = c.json(original); }
    const receipt = structuredClone(f.receipt); receipt.archive = manifest.archive; receipt.manifest = c.record(bodies[c.UNSIGNED]); bodies['package-receipt.json'] = c.json(receipt);
    const plan = structuredClone(f.plan); for (const role of c.FILES) Object.assign(plan.files[role], c.record(bodies[role]));
    if (name === 'usr/bin/creator-hub') assert.throws(() => c.validateOutput(plan, bodies, f.assembled, signed, f.selector), /differs beyond the exact Tauri bundle marker/);
    else assert.throws(() => c.validateOutput(plan, bodies, f.assembled, signed, f.selector));
  }
});
test('complete controlled-tool and selector Git blob inventories cannot be omitted, replaced or relabelled', async t => {
  const f = await create(t);
  assert.deepEqual(w.sourceProof(f.root, f.plan, f.tool, f.selectorBuild, f.services.execute), f.selector);
  for (const fault of ['omitted-source', 'wrong-blob', 'omitted-selector']) {
    const execute = (program, args, options) => {
      const result = f.services.execute(program, args, options);
      if (args[0] === 'cat-file' && fault === 'wrong-blob') return Buffer.concat([Buffer.from(result), Buffer.from('changed')]);
      if (args[0] === 'ls-tree' && (fault === 'omitted-source' && !args.includes('native/linux-portable-deployment') || fault === 'omitted-selector' && args.includes('native/linux-portable-deployment'))) return String(result).split('\0').slice(1).join('\0');
      return result;
    };
    assert.throws(() => w.sourceProof(f.root, f.plan, f.tool, f.selectorBuild, execute));
  }
  const changedBytes = Buffer.from('changed target source\n'), changedBlob = crypto.createHash('sha1').update(`blob ${changedBytes.length}\0`).update(changedBytes).digest('hex');
  for (const fault of ['changed-target-blob', 'new-target-source', 'missing-target-source']) {
    const execute = (program, args, options) => {
      if (args[0] === 'cat-file' && args[2] === changedBlob) return changedBytes;
      const result = f.services.execute(program, args, options);
      if (args[0] !== 'ls-tree' || args[3] !== lane.SOURCE.sourceCommit || !args.includes('native/linux-portable-deployment')) return result;
      const rows = String(result).split('\0').filter(Boolean);
      if (fault === 'changed-target-blob') { const at = rows.findIndex(row => row.endsWith('\tnative/linux-portable-deployment/Cargo.toml')); rows[at] = `100644 blob ${changedBlob}\tnative/linux-portable-deployment/Cargo.toml`; }
      if (fault === 'new-target-source') rows.push(`100644 blob ${changedBlob}\tnative/linux-portable-deployment/src/unreviewed.rs`);
      if (fault === 'missing-target-source') rows.splice(0, 1);
      return rows.join('\0') + '\0';
    };
    assert.throws(() => w.sourceProof(f.root, f.plan, f.tool, f.selectorBuild, execute));
  }
});
test('unknown ZIP/proof files, plan hash drift, input replacement and old signatures fail before key selection', async t => {
  for (const fault of ['zip-extra', 'proof-extra', 'plan', 'proof-bytes', 'old-signature']) {
    const f = await create(t);
    if (fault === 'zip-extra') f.save({ 'unknown.txt': Buffer.from('not a producer role') });
    if (fault === 'proof-extra') f.put(path.join(f.inputs.proofs, 'unknown.json'), Buffer.from('{}'));
    if (fault === 'plan') f.inputs.planSha256 = '0'.repeat(64);
    if (fault === 'proof-bytes') fs.appendFileSync(path.join(f.inputs.proofs, 'profile.json'), 'changed');
    if (fault === 'old-signature') { const name = `signed016/${old.MANIFEST}.minisig`, b = Buffer.from('untrusted comment: wrong'); f.put(path.join(f.inputs.proofs, name), b); f.plan.proofs[name] = c.record(b); f.plan.inputProfile.signed016.files[`${old.MANIFEST}.minisig`] = c.record(b); f.save(); }
    await assert.rejects(w.sign(f.inputs, f.services), { message: w.FAILURE }); assert.equal(f.counts.keys, 0);
  }
});
test('writer source has no key/environment reader, package execution, build, installation or publication route', () => {
  const source = fs.readFileSync(require.resolve('./sign-private-portable-017.cjs'), 'utf8');
  assert.doesNotMatch(source, /process\.env|gh release|publish-hub|cargo.*build|\.activate\(|--appimage-extract|TAURI_SIGNING|BEGIN.*PRIVATE KEY/);
  const before = source.indexOf('const key = approved.signingKey(root)');
  for (const gate of ['c.validateOutput(', 'await fresh(', 'sourceProof(root,', "metadata.verifySignatures(", "refuseMutation(signed.files[", 'moduleArchive.verify(', 'recheck(true)']) assert.ok(source.indexOf(gate) < before);
  assert.match(source, /authorized = \[path\.join\(output, c.MANIFEST\), descriptor\]/);
  const result = spawnSync(process.execPath, ['--check', require.resolve('./private-portable-017-contract.cjs')], { encoding: 'utf8', timeout: 10000, windowsHide: true }); assert.equal(result.status, 0, result.stderr);
});
