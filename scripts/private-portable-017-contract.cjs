'use strict';
// Private outgoing017 fixture only. No production016 eligibility or native acceptance.
const assert = require('node:assert/strict');
const path = require('node:path');
const base = require('./linux-016-portable-package.cjs');
const lane = require('./private-linux-portable-fixture-017.cjs');
const metadata = require('./private-linux-update-fixture-017-metadata.cjs');
const old = require('./private-portable-016-contract.cjs');
const finite = require('./flatpak-package.cjs');

const PROFILE = 'private-portable-017-outgoing-qualification';
const VERSION = '0.1.17', MINIMUM = '0.1.16';
const MANIFEST = 'creator-hub-linux-x86_64-0.1.17.portable-manifest.json';
const DESCRIPTOR = 'creator-hub-linux-x86_64-portable.json';
const UNSIGNED = 'portable-manifest.unsigned.json', ARCHIVE = lane.ARCHIVE, IMAGE = lane.IMAGE;
const FILES = Object.freeze(['package-receipt.json', IMAGE, UNSIGNED, ARCHIVE, 'appdir-original-inventory.json',
  'appdir-flattened-inventory.json', 'download-proof.json', 'data-preflight.json', 'tool-build.json']);
const PROOFS = Object.freeze(['profile.json', 'assembly017.zip', 'portable016.zip',
  ...lane.LEGACY_NAMES.map(name => `signed016/${name}`), ...metadata.INPUTS.map(name => `signed017/${name}`)]);
const TOOL_SOURCES = Object.freeze(['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs',
  'src-tauri/examples/verify-package-input.rs', 'src-tauri/src', 'native/mcp-router', 'native/module-archive']);
const META = 2 * 1024 * 1024, SIGNED_META = 128 * 1024;
const FLAGS = Object.freeze({ ...lane.flags(), bootstrapAccepted: false, typedResumeAccepted: false,
  publisherSignatureAccepted: false, publicUploadPerformed: false, final016Qualified: false });
const { keys, pin, record, hash, json, parse } = old;
const bare = value => ({ size: value.size, sha256: value.sha256 });
function limit(name) { return name.endsWith('.minisig') ? 4096 : name.endsWith('.zip') ? base.LIMITS.zip
  : name === UNSIGNED || name === 'plan.json' ? SIGNED_META : name.endsWith('.json') ? META : base.LIMITS.file; }
function members(values, names, bounded) {
  keys(values, names); const seen = new Set();
  for (const [name, value] of Object.entries(values)) {
    keys(value, ['member', 'size', 'sha256']); pin(bare(value), bounded(name));
    assert.ok(base.relative(value.member) && path.posix.basename(value.member) === name && !seen.has(value.member.toLowerCase()), 'Exact unique artifact role required');
    seen.add(value.member.toLowerCase());
  }
}
function validatePlan(p) {
  keys(p, ['schemaVersion', 'profile', 'producer', 'rootSource', 'inputProfile', 'carriers', 'files', 'proofs', 'verifier', 'decoder']);
  assert.equal(p.schemaVersion, 1); assert.equal(p.profile, PROFILE); assert.deepEqual(p.rootSource, lane.SOURCE);
  keys(p.producer, ['sourceCommit', 'sourceTree', 'runId', 'runAttempt', 'jobId', 'workflowId', 'artifactId', 'zip']);
  for (const name of ['sourceCommit', 'sourceTree']) assert.match(p.producer[name], /^[a-f0-9]{40}$/);
  for (const name of ['runId', 'runAttempt', 'jobId', 'workflowId', 'artifactId']) assert.ok(Number.isSafeInteger(p.producer[name]) && p.producer[name] > 0);
  pin(p.producer.zip, base.LIMITS.zip); lane.validateProfile(p.inputProfile);
  members(p.files, FILES, limit); keys(p.proofs, PROOFS);
  for (const name of PROOFS) pin(p.proofs[name], limit(name));
  assert.deepEqual(p.proofs['profile.json'], record(lane.json(p.inputProfile)));
  assert.deepEqual(p.proofs['assembly017.zip'], p.inputProfile.assembly017.zip);
  for (const name of lane.LEGACY_NAMES) assert.deepEqual(p.proofs[`signed016/${name}`], p.inputProfile.signed016.files[name]);
  assert.equal(p.proofs['signed017/plan.json'].sha256, p.inputProfile.signed017.planSha256);
  assert.equal(p.proofs['signed016/plan.json'].sha256, p.inputProfile.signed016.planSha256);
  assert.ok(FILES.reduce((n, name) => n + p.files[name].size, 0) <= base.LIMITS.zip);
  keys(p.carriers, ['schemaVersion', 'signed016', 'signed017']); assert.equal(p.carriers.schemaVersion, 1);
  const a = p.carriers.signed016;
  keys(a, ['runId', 'runAttempt', 'jobId', 'workflowId', 'sourceCommit', 'sourceTree', 'artifactId', 'zip', 'members']);
  for (const name of ['runId', 'runAttempt', 'jobId', 'workflowId', 'artifactId']) assert.ok(Number.isSafeInteger(a[name]) && a[name] > 0);
  for (const name of ['sourceCommit', 'sourceTree']) assert.match(a[name], /^[a-f0-9]{40}$/);
  pin(a.zip, base.LIMITS.zip); keys(a.members, lane.LEGACY_NAMES); const seen = new Set();
  for (const name of lane.LEGACY_NAMES) { const member = a.members[name]; assert.ok(base.relative(member) && path.posix.basename(member) === name && !seen.has(member.toLowerCase())); seen.add(member.toLowerCase()); }
  const b = p.carriers.signed017; keys(b, ['jobId', 'artifactId', 'zip', 'files']);
  for (const name of ['jobId', 'artifactId']) assert.ok(Number.isSafeInteger(b[name]) && b[name] > 0);
  pin(b.zip, 1024 * 1024 * 1024);
  members(b.files, ['private017-signed.zip', 'approved-plan.json', 'signed-input.json'], name => name.endsWith('.zip') ? 1024 * 1024 * 1024 : SIGNED_META);
  assert.notEqual(b.artifactId, p.inputProfile.assembly017.artifactId);
  pin(p.verifier, base.LIMITS.file); pin(p.decoder, base.LIMITS.file); return p;
}
function apiProof(expected, proof, fixed) {
  keys(proof, ['run', 'job', 'workflow', 'artifact', 'commit']);
  const { run, job, workflow, artifact, commit } = proof;
  for (const [name, value] of Object.entries({ id: expected.runId, run_attempt: expected.runAttempt, head_sha: expected.sourceCommit,
    head_branch: fixed.branch, path: fixed.workflow, workflow_id: expected.workflowId, event: 'workflow_dispatch', status: 'completed', conclusion: 'success' })) assert.equal(run[name], value);
  for (const repo of [run.repository, run.head_repository]) { assert.equal(repo.id, 1364807512); assert.equal(repo.full_name, 'BOBWORKS-XR/CREATOR-HUB'); }
  assert.equal(workflow.id, expected.workflowId); assert.equal(workflow.path, fixed.workflow);
  assert.equal(commit.sha, expected.sourceCommit); assert.equal(commit.tree.sha, expected.sourceTree);
  for (const [name, value] of Object.entries({ id: expected.jobId, run_id: expected.runId, run_attempt: expected.runAttempt,
    head_sha: expected.sourceCommit, name: fixed.job, status: 'completed', conclusion: 'success' })) assert.equal(job[name], value);
  assert.ok(job.labels.includes('ubuntu-22.04'));
  for (const [name, value] of Object.entries({ id: expected.artifactId, name: fixed.artifact, expired: false,
    size_in_bytes: expected.zip.size, digest: `sha256:${expected.zip.sha256}` })) assert.equal(artifact[name], value);
  for (const [name, value] of Object.entries({ id: expected.runId, head_sha: expected.sourceCommit, head_branch: fixed.branch,
    repository_id: 1364807512, head_repository_id: 1364807512 })) assert.equal(artifact.workflow_run[name], value);
  const times = [job.started_at, artifact.created_at, job.completed_at].map(Date.parse);
  assert.ok(times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2], 'Artifact must belong to the successful job interval');
}
function validateAPI(p, proof) {
  validatePlan(p); const a = p.producer;
  apiProof(a, proof, { branch: lane.BRANCH.slice(11), workflow: lane.WORKFLOW, job: 'package',
    artifact: `private-linux-portable-fixture-017-unsigned-${a.runId}-${a.runAttempt}` });
}
function validateToolBuild(p, tool) {
  keys(tool, ['schemaVersion', 'scope', 'packagingSource', 'packagingTree', 'rootSource', 'independentProfileSha256',
    'internalProfile', 'sources', 'publicKey', 'compiler', 'cargo', 'arguments', 'tools', 'freshSingleLinkCopies',
    'rootRecompiled', 'selectorRecompiled', 'privateModulesRecompiled', 'releaseReady']);
  assert.equal(tool.schemaVersion, 1); assert.equal(tool.scope, 'controlled-validator-builds-only');
  assert.equal(tool.packagingSource, p.producer.sourceCommit); assert.equal(tool.packagingTree, p.producer.sourceTree);
  assert.deepEqual(tool.rootSource, lane.SOURCE); assert.deepEqual(tool.internalProfile, p.proofs['profile.json']);
  assert.deepEqual(tool.tools, p.inputProfile.tools); assert.deepEqual(tool.publicKey, tool.sources['src-tauri/src/catalog-key.pub']);
  assert.match(tool.compiler, /^rustc 1\.99\.0 /); assert.match(tool.compiler, /^host: x86_64-unknown-linux-gnu$/m); assert.match(tool.cargo, /^cargo 1\.99\.0 /);
  assert.equal(tool.freshSingleLinkCopies, true);
  for (const name of ['rootRecompiled', 'selectorRecompiled', 'privateModulesRecompiled', 'releaseReady']) assert.equal(tool[name], false);
  keys(tool.arguments, ['verifier', 'decoder']);
  const v = tool.arguments.verifier, d = tool.arguments.decoder;
  assert.ok(Array.isArray(v) && v.length === 9 && typeof v[4] === 'string' && v[4].endsWith('/src-tauri/Cargo.toml'));
  const root = v[4].slice(0, -'/src-tauri/Cargo.toml'.length), stage = v[8].slice(0, -'/verifier-build'.length);
  for (const dir of [root, stage]) assert.ok(path.posix.isAbsolute(dir) && path.posix.normalize(dir) === dir && !/[\\\x00-\x1f]/.test(dir));
  assert.ok(stage.endsWith('/private017-portable-stage'));
  assert.deepEqual(v, ['build', '--release', '--locked', '--manifest-path', `${root}/src-tauri/Cargo.toml`, '--example', 'verify-package-input', '--target-dir', `${stage}/verifier-build`]);
  assert.deepEqual(d, ['build', '--release', '--locked', '--manifest-path', `${root}/native/module-archive/Cargo.toml`, '--bin', 'creator-hub-module-archive', '--target-dir', `${stage}/decoder-build`]);
  const names = Object.keys(tool.sources); assert.ok(names.length > 5 && names.length <= 1024);
  for (const name of names) {
    assert.ok(base.relative(name) && TOOL_SOURCES.some(scope => name === scope || name.startsWith(`${scope}/`)));
    keys(tool.sources[name], ['gitBlob', 'size', 'sha256']); assert.match(tool.sources[name].gitBlob, /^[a-f0-9]{40}$/); pin(bare(tool.sources[name]), META);
  }
  assert.ok(names.reduce((sum, name) => sum + tool.sources[name].size, 0) <= 32 * 1024 * 1024);
  const profile = { ...p.inputProfile }; delete profile.tools;
  assert.equal(tool.independentProfileSha256, hash(Buffer.from(JSON.stringify(profile, null, 2))));
  return record(json({ profile, carriers: p.carriers, profileSha256: tool.independentProfileSha256 }));
}
function validateClosure(receipt, entries) {
  const d = receipt.dependencies, abi = receipt.closureAbi;
  keys(d, ['primary', 'closure', 'hostBaseline', 'unresolved', 'hostBaselineSource', 'scope']);
  assert.deepEqual(d.unresolved, []); assert.deepEqual(d.hostBaselineSource, base.HOST_EXCLUSIONS);
  assert.equal(d.scope, 'static ELF dependency closure only; loader search, ABI versions, dlopen/plugins and native execution unaccepted');
  assert.equal(abi.scope, 'whole inspected static dependency closure GNU symbol-version requirements by provider; host ABI availability, undefined symbols, loader search, dlopen/plugins and native execution unaccepted');
  keys(abi, ['scope', 'targetAbiVerified', 'undefinedSymbolsVerified', 'nativeExecutionVerified', 'releaseReady', 'files', 'providers']);
  for (const name of ['targetAbiVerified', 'undefinedSymbolsVerified', 'nativeExecutionVerified', 'releaseReady']) assert.equal(abi[name], false);
  const patterns = { webkit: /(?:^|\/)libwebkit2gtk-4\.1\.so(?:\.\d+)*$/, javascriptCore: /(?:^|\/)libjavascriptcoregtk-4\.1\.so(?:\.\d+)*$/,
    webProcess: /\/webkit2gtk-4\.1\/WebKitWebProcess$/, networkProcess: /\/webkit2gtk-4\.1\/WebKitNetworkProcess$/,
    injectedBundle: /\/webkit2gtk-4\.1\/injected-bundle\/libwebkit2gtkinjectedbundle\.so$/ };
  const primary = Object.fromEntries(Object.entries(patterns).map(([name, regex]) => [name, Object.keys(entries).filter(file => regex.test(file))]));
  Object.assign(primary, { hub: ['usr/bin/creator-hub'], selector: [lane.SELECTOR] });
  const tls = 'usr/lib/x86_64-linux-gnu/gio/modules/libgiognutls.so'; if (entries[tls]) primary.gioTls = [tls];
  assert.deepEqual(d.primary, primary); for (const names of Object.values(primary)) assert.ok(names.length > 0 && names.length <= 8);
  const names = Object.keys(d.closure); assert.ok(names.length > 0 && names.length <= base.LIMITS.entries); keys(abi.files, names);
  const reached = new Set(), hosts = new Set(), providers = {};
  function visit(name) {
    if (reached.has(name)) return; reached.add(name);
    const item = d.closure[name], entry = entries[name]; assert.ok(item && entry?.kind === 'file');
    keys(item, ['kind', 'size', 'sha256', 'mode', 'dynamicSha256', 'needed', 'versionNeedCount', 'versionInfoPresent', 'resolution']);
    assert.deepEqual({ kind: item.kind, ...bare(item), mode: item.mode }, entry); assert.match(item.dynamicSha256, /^[a-f0-9]{64}$/);
    assert.ok(Array.isArray(item.needed) && item.needed.length <= 128 && new Set(item.needed).size === item.needed.length);
    assert.ok(Number.isSafeInteger(item.versionNeedCount) && item.versionNeedCount >= 0 && item.versionNeedCount <= 128);
    assert.equal(typeof item.versionInfoPresent, 'boolean'); keys(item.resolution, item.needed);
    const f = abi.files[name]; keys(f, ['executableSha256', 'versionInfoSha256', 'requirementsByProvider', 'unversionedDependencies']);
    assert.equal(f.executableSha256, entry.sha256); assert.match(f.versionInfoSha256, /^[a-f0-9]{64}$/);
    assert.ok(Object.keys(f.requirementsByProvider).length === item.versionNeedCount);
    assert.deepEqual(f.unversionedDependencies, item.needed.filter(n => !Object.hasOwn(f.requirementsByProvider, n)));
    for (const library of item.needed) {
      assert.ok(base.relative(library) && !library.includes('/'));
      const matches = Object.keys(entries).filter(n => entries[n].kind === 'file' && /\.so(?:\.\d+)*$/.test(n) && path.posix.basename(n) === library);
      const resolution = matches.length ? { kind: 'bundled-static-provider', paths: matches } : { kind: 'required-host-ABI-not-bundled' };
      assert.deepEqual(item.resolution[library], resolution);
      if (matches.length) { assert.ok(matches.length <= 16 && new Set(matches.map(n => entries[n].sha256)).size === 1); for (const next of matches) visit(next); }
      else { assert.ok(base.HOST_BASELINE.includes(library)); hosts.add(library); }
      if (!providers[library]) providers[library] = { ...resolution, required: new Set(), weak: new Set(), consumers: new Set() };
      const provider = providers[library]; provider.consumers.add(name);
      if (f.requirementsByProvider[library]) {
        const r = f.requirementsByProvider[library]; keys(r, ['required', 'weak']);
        for (const kind of ['required', 'weak']) {
          assert.ok(Array.isArray(r[kind]) && r[kind].length <= 256); assert.deepEqual(r[kind], [...new Set(r[kind])].sort());
          for (const tag of r[kind]) { assert.match(tag, /^[A-Za-z0-9_.]+$/); provider[kind].add(tag); }
        }
      }
    }
    for (const library of Object.keys(f.requirementsByProvider)) assert.ok(item.needed.includes(library));
  }
  for (const list of Object.values(primary)) for (const name of list) visit(name);
  assert.deepEqual([...reached].sort(), names.sort()); assert.deepEqual(d.hostBaseline, [...hosts].sort());
  const expected = Object.fromEntries(Object.entries(providers).map(([name, p]) => [name, { kind: p.kind, ...(p.paths ? { paths: p.paths } : {}),
    requiredSymbolVersions: [...p.required].sort(), weakSymbolVersions: [...p.weak].sort(), consumers: [...p.consumers].sort() }]));
  assert.deepEqual(abi.providers, expected);
}
function validateOutput(p, bodies, assembly, signed, selector) {
  validatePlan(p); keys(bodies, FILES); for (const name of FILES) assert.deepEqual(record(bodies[name]), bare(p.files[name]));
  const built = lane.validateAssembly(p.inputProfile, assembly, signed);
  // validateAssembly binds the rebuilt archive to the embedded descriptor and
  // the signed derivation; its017 runtime overlay changes compressed bytes.
  const m = parse(bodies[UNSIGNED], SIGNED_META), receipt = parse(bodies['package-receipt.json']);
  keys(m, ['schemaVersion', 'appId', 'platform', 'architecture', 'version', 'sourceCommit', 'sourceTree', 'format', 'entrypoint', 'archive', 'entries']);
  assert.deepEqual(m, lane.manifest(parse(bodies['appdir-flattened-inventory.json']), m.archive));
  keys(m.archive, ['size', 'sha256', 'unpackedSize']); pin(bare(m.archive), base.LIMITS.archive);
  const flat = parse(bodies['appdir-flattened-inventory.json']), original = parse(bodies['appdir-original-inventory.json']);
  base.validateInventory(flat); assert.deepEqual(flat.entries, m.entries); assert.equal(flat.unpackedSize, m.archive.unpackedSize);
  keys(original, ['entries', 'links', 'unpackedSize']);
  const normalized = Object.fromEntries(Object.entries(original.entries).map(([name, entry]) => [name, { ...entry, mode: base.transportMode(name, entry) }]));
  base.validateInventory({ entries: normalized, links: {}, unpackedSize: original.unpackedSize });
  for (const [name, link] of Object.entries(original.links)) {
    keys(link, ['link', 'resolved', 'kind', 'size', 'sha256', 'mode']); let current = name; const seen = new Set();
    while (original.links[current]) {
      assert.ok(seen.size < 32 && !seen.has(current)); seen.add(current);
      const value = original.links[current].link; assert.ok(value && !path.posix.isAbsolute(value) && !/[\\:\x00-\x1f\x7f-\uffff]/.test(value));
      current = path.posix.normalize(path.posix.join(path.posix.dirname(current), value)); assert.ok(base.relative(current));
    }
    assert.equal(current, link.resolved); assert.deepEqual(original.entries[current], original.entries[name]);
    assert.deepEqual((({ link: _, resolved: __, ...entry }) => entry)(link), original.entries[name]);
  }
  for (const name of [lane.HOST, lane.SELECTOR]) assert.equal(Object.hasOwn(normalized, name), false);
  assert.deepEqual(flat.entries, { ...normalized, 'usr/libexec': { kind: 'directory', mode: 0o755 }, [lane.HOST]: m.entries[lane.HOST], [lane.SELECTOR]: m.entries[lane.SELECTOR] });
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.scope, 'unsigned-private-linux-017-portable-packaging-only');
  assert.equal(receipt.packagingCompleted, true); assert.equal(receipt.packagingSource, p.producer.sourceCommit); assert.deepEqual(receipt.rootSource, lane.SOURCE);
  for (const [name, value] of Object.entries(lane.flags())) assert.equal(receipt[name], value);
  assert.equal(receipt.hermetic, false); assert.equal(receipt.upstreamToolsPinned, false);
  assert.deepEqual(receipt.archive, m.archive); assert.deepEqual(receipt.manifest, bare(p.files[UNSIGNED])); assert.deepEqual(receipt.appImage, bare(p.files[IMAGE]));
  finite.validateElf(bodies[IMAGE]); assert.deepEqual(receipt.selectorReuse, selector);
  assert.equal(receipt.originalSigned016Plan, p.inputProfile.signed016.planSha256); assert.equal(receipt.signed017Plan, p.inputProfile.signed017.planSha256);
  assert.equal(receipt.assembly.run.id, p.inputProfile.assembly017.runId); lane.assemblyAPI(p.inputProfile, receipt.assembly);
  const contents = old.archiveContents(bodies[ARCHIVE], m), root = contents[m.entrypoint];
  finite.validateElf(root); finite.validateElf(contents[lane.SELECTOR]);
  require('./unix-package-payload.cjs').verifyLinuxHub(assembly.root, root, 'appimage'); assert.ok(root.includes(assembly.manifest));
  assert.deepEqual(record(contents[lane.SELECTOR]), selector.executable);
  assert.deepEqual(m.entries['usr/lib/Creator Hub/modules.tar.gz'], { kind: 'file', ...record(assembly.archive), mode: 0o644 });
  assert.deepEqual(contents[lane.HOST], lane.hostProfile(assembly.root, root));
  assert.deepEqual(receipt.hostProfile, { ...record(contents[lane.HOST]), version: VERSION, executable: record(root), scope: 'canonical-appdir-transport-only', appImageContainsProfile: false });
  validateClosure(receipt, m.entries);
  return { manifest: m, receipt, built, descriptor: { schemaVersion: 1, appId: 'creator-hub', version: VERSION, platform: 'linux', architecture: 'x86_64',
    packageType: 'portable-appdir', manifest: { assetName: MANIFEST, byteLength: bodies[UNSIGNED].length, sha256: hash(bodies[UNSIGNED]) },
    archive: { assetName: ARCHIVE, byteLength: bodies[ARCHIVE].length, sha256: hash(bodies[ARCHIVE]) }, executableSha256: record(root).sha256, restartProtocol: 1, minHubVersion: MINIMUM } };
}
module.exports = { PROFILE, VERSION, MINIMUM, MANIFEST, DESCRIPTOR, UNSIGNED, ARCHIVE, IMAGE, FILES, PROOFS, TOOL_SOURCES,
  META, SIGNED_META, FLAGS, keys, pin, record, hash, json, parse, bare, limit, validatePlan, apiProof, validateAPI, validateToolBuild, validateClosure, validateOutput };
