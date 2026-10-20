'use strict';
// Distinct private017 sidecar. No Root/selector compilation, signing, installation or app execution.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const neutral = require('./linux-016-portable-package.cjs');

const VERSION = '0.1.17', TARGET = 'x86_64-unknown-linux-gnu';
const PROFILE = 'private-portable-update-fixture-017';
const BRANCH = 'refs/heads/validation/private-linux-portable-fixture-017';
const WORKFLOW = '.github/workflows/private-linux-portable-fixture-017.yml';
const SOURCE = Object.freeze({ sourceCommit: '75a99ff4a267064aaa3ac9e30039bc91dc791d89', sourceTree: '5f62bf4bc1ba85eb293ca9a5a30330b06b6b4351' });
const FEATURES = Object.freeze(['integrated-features', 'experimental-flatpak-host', 'linux-production-migration', 'experimental-linux-portable-update']);
const IMAGE = 'Creator Hub_0.1.17_amd64.AppImage', ALIAS = 'Creator.Hub.Native.Support_0.1.17_amd64.AppImage';
const ARCHIVE = 'creator-hub-linux-x86_64-0.1.17.appdir.tar.gz', HOST = 'creator-hub-portable-host.json';
const SELECTOR = 'usr/libexec/creator-hub-portable-selector';
const ROLES = Object.freeze({ root: 'creator-hub', archive: 'modules.tar.gz', manifest: 'builtin-manifest.json',
  receipt: 'private017-assembly.json', expected: 'private017-package-expected.json', integrity: 'unix-package-integrity.json',
  deb: 'Creator Hub_0.1.17_amd64.deb', api: 'private017-fresh-api.json' });
const LEGACY_NAMES = Object.freeze(['package-receipt.json', 'Creator Hub_0.1.16_amd64.AppImage',
  'Creator.Hub.Native.Support_0.1.16_amd64.AppImage', 'creator-hub-linux-x86_64-0.1.16.portable-manifest.json',
  'creator-hub-linux-x86_64-0.1.16.appdir.tar.gz', 'appdir-original-inventory.json', 'appdir-flattened-inventory.json',
  'plan.json', 'fresh-api.json', 'creator-hub-linux-x86_64-portable.json',
  'creator-hub-linux-x86_64-0.1.16.portable-manifest.json.minisig', 'creator-hub-linux-x86_64-portable.json.minisig',
  'private-qualification-receipt.json']);
const SCOPE_PATHS = Object.freeze(['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json', 'src-tauri/icons', 'src-tauri/examples/verify-package-input.rs', 'src-tauri/src/catalog-key.pub',
  'native/module-archive', WORKFLOW, 'scripts/assemble-unix-payload.cjs', 'scripts/build-unified.cjs',
  'scripts/collect-unix-payload-binding.cjs', 'scripts/download-unix-payload-zip.cjs',
  'scripts/flatpak-native-activation.cjs', 'scripts/flatpak-package.cjs', 'scripts/installer-payload.cjs',
  'scripts/linux-016-portable-package.cjs', 'scripts/linux-retirement-package.cjs', 'scripts/managed-router-package.cjs',
  'scripts/mcp-runtime-descriptor.cjs', 'scripts/module-archive.cjs', 'scripts/native-linux-016-input.cjs',
  'scripts/portable-release-descriptor.cjs', 'scripts/private-linux-portable-fixture-017.cjs',
  'scripts/private-linux-update-fixture-017-assemble.cjs', 'scripts/private-linux-update-fixture-017-metadata.cjs',
  'scripts/private-linux-update-fixture-017-provenance.cjs', 'scripts/private-linux-update-fixture-017.cjs',
  'scripts/private-portable-016-contract.cjs', 'scripts/sign-private-portable-016.cjs', 'scripts/sign-unix-payload.cjs',
  'scripts/unix-managed-payload.cjs', 'scripts/unix-package-payload.cjs', 'scripts/unix-payload-binding.cjs']);
const flags = () => ({ ...neutral.flags(), acceptanceOnly: true, selectorRecompiled: false, rootRecompiled: false,
  privatePayloadChanged: false, payloadResigned: false, applicationLaunched: false, updateAcceptanceTested: false });
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const record = neutral.record;
const read = (file, limit = neutral.LIMITS.file) => require('./flatpak-package.cjs').read(file, limit);
// Only the version-neutral snapshot primitive is reused, never016 producer admission.
const imageSnapshot = neutral.production016().imageSnapshot;
function verifyBundlerWorkcopyRestored(before, after) {
  assert.deepEqual(after.pin, before.pin, 'Bundling changed the supplied actual017 Root bytes');
  const stableIdentity = snapshot => {
    assert.equal(snapshot.identity.length, 8, 'Exact strict image snapshot required');
    const [dev, ino, mode, nlink, size, , birthtimeNs] = snapshot.identity;
    return { dev, ino, mode, nlink, size, birthtimeNs };
  };
  // Tauri 2.11.4 bundle.rs patches then restores this owned copy in place.
  // Only its mtime/ctime may change across that one bundle call.
  assert.deepEqual(stableIdentity(after), stableIdentity(before), 'Bundling replaced or changed the actual017 Root workcopy identity');
}
function keys(value, names) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); assert.deepEqual(Object.keys(value).sort(), [...names].sort()); }
function sha(value, length = 64) { assert.ok(typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value)); }
function id(value) { assert.ok(Number.isSafeInteger(value) && value > 0); }
function pin(value, maximum = neutral.LIMITS.file) { keys(value, ['size', 'sha256']); id(value.size); sha(value.sha256); assert.ok(value.size <= maximum); }
function validateProfile(p) {
  keys(p, ['schemaVersion', 'profile', 'assembly017', 'signed016', 'signed017', 'tools']);
  assert.equal(p.schemaVersion, 1); assert.equal(p.profile, PROFILE, 'Only the distinct fixed017 portable profile is admitted');
  const a = p.assembly017; keys(a, ['runId', 'runAttempt', 'jobId', 'workflowId', 'artifactId', 'zip', 'files']);
  for (const name of ['runId', 'runAttempt', 'jobId', 'workflowId', 'artifactId']) id(a[name]); pin(a.zip, neutral.LIMITS.zip);
  keys(a.files, Object.keys(ROLES)); const members = new Set();
  for (const [name, value] of Object.entries(a.files)) {
    keys(value, ['member', 'size', 'sha256']); pin({ size: value.size, sha256: value.sha256 }, name === 'manifest' ? 65536 : name.endsWith('api') || ['receipt', 'expected', 'integrity'].includes(name) ? 2 * 1024 * 1024 : neutral.LIMITS.file);
    assert.ok(neutral.relative(value.member) && path.posix.basename(value.member) === ROLES[name], 'Fixed artifact role basename required');
    assert.ok(!members.has(value.member.toLowerCase()), 'Ambiguous assembly artifact role'); members.add(value.member.toLowerCase());
  }
  keys(p.signed016, ['planSha256', 'files']); sha(p.signed016.planSha256); keys(p.signed016.files, LEGACY_NAMES);
  for (const [name, value] of Object.entries(p.signed016.files)) pin(value, name.endsWith('.minisig') ? 4096 : name.endsWith('.json') ? 2 * 1024 * 1024 : neutral.LIMITS.file);
  keys(p.signed017, ['planSha256']); sha(p.signed017.planSha256);
  keys(p.tools, ['verifier', 'decoder']); for (const value of Object.values(p.tools)) pin(value);
  return p;
}
function admission(env, platform = process.platform, arch = process.arch) {
  assert.equal(platform, 'linux'); assert.equal(arch, 'x64');
  for (const [name, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: BRANCH, GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${WORKFLOW}@${BRANCH}`, CREATOR_PRIVATE_PORTABLE_017: '1' })) assert.equal(env[name], value, name);
  sha(env.GITHUB_SHA, 40);
  for (const name of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[name] || '', /^[1-9][0-9]*$/);
  assert.ok(!env.FLATPAK_ID && !env.DISPLAY && !env.WAYLAND_DISPLAY, 'Headless disposable native host required');
  assert.ok(!Object.keys(env).some(name => /^(LD_|DYLD_|TAURI_|APPLE_|CREATOR_HUB_SIGNING_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSL_CERT_|CURL_CA_BUNDLE$|WEBKIT_|APPIMAGE$|APPDIR$|RUSTFLAGS$|CARGO_ENCODED_RUSTFLAGS$|CARGO_BUILD_RUSTFLAGS$|CARGO_TARGET_.*_RUSTFLAGS$|PYTHON)/.test(name)
    || name.toLowerCase().endsWith('proxy')), 'Runtime/trust/compiler/signing overrides refused');
  for (const name of ['CREATOR_LINUX_PRODUCTION_MIGRATION_016', 'CREATOR_LINUX_INTEGRATED_CANDIDATE', 'CREATOR_LINUX_RETIREMENT_TEST_CANDIDATE', 'CREATOR_LINUX_PORTABLE_HOST_CANDIDATE', 'CREATOR_LINUX_PRIVATE_UPDATE_FIXTURE_017']) assert.equal(env[name] ?? '0', '0', 'No other producer profile may be inherited');
}
function assemblyAPI(p, proof) {
  validateProfile(p); keys(proof, ['run', 'job', 'workflow', 'artifact', 'commit']);
  const a = p.assembly017, { run, job, workflow, artifact, commit } = proof;
  for (const [name, value] of Object.entries({ id: a.runId, run_attempt: a.runAttempt, head_sha: SOURCE.sourceCommit,
    head_branch: 'validation/linux-private-update-fixture-017', path: '.github/workflows/private-linux-update-fixture-017.yml',
    workflow_id: a.workflowId, event: 'workflow_dispatch', status: 'completed', conclusion: 'success' })) assert.equal(run[name], value);
  for (const repo of [run.repository, run.head_repository]) { assert.equal(repo.id, 1364807512); assert.equal(repo.full_name, 'BOBWORKS-XR/CREATOR-HUB'); }
  assert.equal(workflow.id, a.workflowId); assert.equal(workflow.path, run.path);
  assert.equal(commit.sha, SOURCE.sourceCommit); assert.equal(commit.tree.sha, SOURCE.sourceTree);
  for (const [name, value] of Object.entries({ id: a.jobId, run_id: a.runId, run_attempt: a.runAttempt, head_sha: SOURCE.sourceCommit,
    name: 'assemble', status: 'completed', conclusion: 'success' })) assert.equal(job[name], value);
  assert.ok(job.labels.includes('ubuntu-22.04'));
  for (const [name, value] of Object.entries({ id: a.artifactId, name: `private-linux-update-fixture-017-${a.runId}-${a.runAttempt}`,
    expired: false, size_in_bytes: a.zip.size, digest: `sha256:${a.zip.sha256}` })) assert.equal(artifact[name], value);
  for (const [name, value] of Object.entries({ id: a.runId, head_sha: SOURCE.sourceCommit,
    head_branch: run.head_branch, repository_id: 1364807512, head_repository_id: 1364807512 })) assert.equal(artifact.workflow_run[name], value);
  const [start, created, end] = [job.started_at, artifact.created_at, job.completed_at].map(Date.parse);
  assert.ok([start, created, end].every(Number.isFinite) && start <= created && created <= end, 'Assembly artifact is not bound to the successful job interval');
}
async function collect(p, request) {
  const a = p.assembly017, proof = { run: await request(`actions/runs/${a.runId}`), job: await request(`actions/jobs/${a.jobId}`),
    workflow: await request(`actions/workflows/${a.workflowId}`), artifact: await request(`actions/artifacts/${a.artifactId}`),
    commit: await request(`git/commits/${SOURCE.sourceCommit}`) };
  assemblyAPI(p, proof); return proof;
}
function fixedTools(root) {
  return { verifier: path.join(root, 'artifacts/unix-verifier-target/release/examples/verify-package-input'),
    decoder: path.join(root, 'artifacts/unified/private-linux-update-fixture-017/decoder-target/release/creator-hub-module-archive') };
}
function sourceCheck(env, call) {
  const git = args => String(call('git', args)).trim();
  assert.equal(git(['rev-parse', 'HEAD']), env.GITHUB_SHA); assert.equal(git(['rev-parse', `${SOURCE.sourceCommit}^{tree}`]), SOURCE.sourceTree);
  git(['diff', '--exit-code', SOURCE.sourceCommit, 'HEAD', '--', 'package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json', 'src-tauri/icons']);
  git(['diff', '--exit-code', 'HEAD', '--', ...SCOPE_PATHS]);
  assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...SCOPE_PATHS]), '', 'Portable producer source changed');
}
function selectorSources(root, proof, run) {
  // A reused selector retains its original build provenance. Source17 is never claimed as its compilation source.
  const list = commit => {
    const rows = String(run('git', ['ls-tree', '-rz', '--full-tree', commit, '--', 'native/linux-portable-deployment', 'src-tauri/src/catalog-key.pub'], { maxBuffer: 65536 })).split('\0').filter(Boolean);
    assert.ok(rows.length >= 4 && rows.length <= 256); const found = {};
    for (const row of rows) {
      const match = /^100(?:644|755) blob ([a-f0-9]{40})\t(.+)$/.exec(row); assert.ok(match, 'Only regular selector source blobs may be reused');
      const name = match[2]; assert.ok(neutral.relative(name) && !name.split('/').includes('.cargo')
        && (name.startsWith('native/linux-portable-deployment/') || name === 'src-tauri/src/catalog-key.pub') && !Object.hasOwn(found, name));
      const bytes = Buffer.from(run('git', ['cat-file', 'blob', match[1]], { encoding: null, maxBuffer: 2 * 1024 * 1024 }));
      const crypto = require('node:crypto');
      assert.equal(crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), match[1]);
      found[name] = record(bytes);
      assert.deepEqual(record(read(path.join(root, name), 2 * 1024 * 1024)), found[name], 'Checkout selector/key differs from the reused bytes');
    }
    assert.ok(Object.values(found).reduce((sum, value) => sum + value.size, 0) <= 16 * 1024 * 1024);
    return found;
  };
  const original = list(proof.sourceCommit), target = list(SOURCE.sourceCommit);
  assert.deepEqual(original, proof.sources, 'Selector proof omits or changes a real original source/key blob');
  assert.deepEqual(target, original, 'Selector sources or public key changed; reuse is refused');
  assert.deepEqual(proof.publicKeySource, original['src-tauri/src/catalog-key.pub']);
  return { originalSourceCommit: proof.sourceCommit, originalSourceTree: proof.sourceTree, targetSource: SOURCE,
    sources: original, executable: proof.executable, reusedWithoutCompilation: true, signaturesRequired: true };
}
function validateAssembly(p, bodies, signed) {
  const metadata = require('./private-linux-update-fixture-017-metadata.cjs'), archive = require('./module-archive.cjs');
  keys(bodies, Object.keys(ROLES));
  for (const [role, bytes] of Object.entries(bodies)) assert.deepEqual(record(bytes), { size: p.assembly017.files[role].size, sha256: p.assembly017.files[role].sha256 });
  const receipt = JSON.parse(bodies.receipt), manifest = JSON.parse(bodies.manifest), integrity = JSON.parse(bodies.integrity);
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.profile, 'private-update-fixture-017'); assert.equal(receipt.hubVersion, VERSION);
  assert.deepEqual(receipt.rootSource, SOURCE); assert.deepEqual(signed.plan.rootSource, SOURCE);
  assert.deepEqual(receipt.compiledFeatures, [...FEATURES]); assert.equal(receipt.target, TARGET);
  for (const [name, value] of Object.entries(require('./private-linux-update-fixture-017.cjs').FLAGS)) assert.equal(receipt[name], value);
  assert.deepEqual(receipt.derivation, signed.records['derivation017.json']);
  assert.deepEqual(receipt.original016, { source: signed.handoff.source, files: signed.plan.original016 });
  assert.deepEqual(receipt.baseline016, signed.plan.baseline016);
  for (const [name, role] of [['rawHub', 'root'], ['archive', 'archive'], ['manifest', 'manifest'], ['deb', 'deb']]) assert.deepEqual(receipt[name], record(bodies[role]));
  assert.equal(receipt.packageReport.scope, 'private017-deb-delta-only'); assert.equal(receipt.packageReport.helperPolicyServicePreserved, true);
  assert.equal(receipt.packageReport.original016Preserved, true);
  for (const name of ['nativeGuiAccepted', 'migrationAccepted', 'signedUpdateAccepted', 'restartAccepted', 'releaseReady']) assert.equal(receipt.packageReport[name], false);
  const original = structuredClone(manifest); delete original.payloadArchive;
  assert.deepEqual(original, signed.manifest, 'Actual017 embedded descriptor differs from its signed derivation');
  require('./flatpak-package.cjs').validateDescriptor(manifest); archive.validateBinding(manifest);
  assert.deepEqual({ size: manifest.payloadArchive.size, sha256: manifest.payloadArchive.sha256 }, record(bodies.archive));
  require('./flatpak-package.cjs').validateElf(bodies.root); assert.ok(bodies.root.includes(bodies.manifest));
  for (const witness of require('./build-unified.cjs').PORTABLE_ROOT_WITNESSES) assert.ok(bodies.root.includes(Buffer.from(witness)));
  const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK'), at = bodies.root.indexOf(marker);
  assert.ok(at >= 0 && bodies.root.indexOf(marker, at + 1) === -1, 'Exactly one actual017 raw bundle marker required');
  const debRoot = Buffer.from(bodies.root); debRoot.write('DEB', at + marker.length - 3, 'ascii');
  assert.deepEqual(record(debRoot), receipt.packagedHub);
  assert.equal(integrity.schemaVersion, 1); assert.equal(integrity.platform, 'linux'); assert.equal(integrity.arch, 'x86_64');
  assert.equal(integrity.integrityPassed, true); assert.equal(integrity.experimental, true); assert.equal(integrity.mcpMode, 'writable');
  assert.equal(integrity.writableGuiAccepted, false); assert.equal(integrity.releaseReady, false);
  assert.deepEqual(integrity.packages, [{ format: 'deb', path: `native-packages/${ROLES.deb}`, sha256: receipt.deb.sha256,
    hubSha256: receipt.packagedHub.sha256, files: archive.rawFiles(manifest) }]);
  const expected = JSON.parse(bodies.expected);
  assert.deepEqual(expected.candidate, { deb: receipt.deb, hub: receipt.packagedHub, archive: receipt.archive });
  assert.deepEqual(expected.baseline, Object.fromEntries(['deb', 'hub', 'helper', 'policy', 'service'].map(name => [name, signed.plan.baseline016.pins[name]])));
  const fresh = JSON.parse(bodies.api); metadata.validateApi(signed.plan, fresh.baseline, fresh.root);
  return { manifest, receipt, debRoot };
}
function overlay(payload) {
  return { version: VERSION, build: { beforeBundleCommand: null }, bundle: { active: true, targets: ['appimage'],
    createUpdaterArtifacts: false, externalBin: [], resources: { [payload]: 'modules.tar.gz' }, linux: { appimage: { files: {}, bundleMediaFramework: false } } } };
}
function bundleArgs(root, config) { return [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'bundle', '--ci', '--no-sign', '--bundles', 'appimage', '--target', TARGET, '--features', FEATURES.join(','), '--config', config]; }
function hostProfile(raw, packaged) {
  require('./unix-package-payload.cjs').verifyLinuxHub(raw, packaged, 'appimage');
  return json({ schemaVersion: 1, version: VERSION, activationInterface: 'com.creatorworks.hub.Host1', integratedFeatures: true,
    startupImageBinding: 1, executableSha256: record(packaged).sha256 });
}
function manifest(inventory, binding) {
  neutral.validateInventory(inventory); keys(binding, ['size', 'sha256', 'unpackedSize']); pin({ size: binding.size, sha256: binding.sha256 }, neutral.LIMITS.archive);
  assert.equal(binding.unpackedSize, inventory.unpackedSize);
  for (const name of ['AppRun', 'usr/bin/creator-hub', SELECTOR]) assert.ok(inventory.entries[name]?.kind === 'file' && inventory.entries[name].mode === 0o755);
  assert.ok(inventory.entries[HOST]?.kind === 'file' && inventory.entries[HOST].mode === 0o644);
  const value = { schemaVersion: 1, appId: 'creator-hub', platform: 'linux', architecture: 'x86_64', version: VERSION,
    ...SOURCE, format: 'appdir-tar-gzip-v1', entrypoint: 'usr/bin/creator-hub', archive: binding, entries: inventory.entries };
  assert.ok(json(value).length <= neutral.LIMITS.manifest); return value;
}
async function produce({ root, input, output, profileSha256 }, services = {}) {
  const env = services.env || process.env; admission(env);
  const a17 = require('./private-linux-update-fixture-017-assemble.cjs'), m17 = require('./private-linux-update-fixture-017-metadata.cjs');
  const c16 = require('./private-portable-016-contract.cjs'), original = require('./assemble-unix-payload.cjs');
  const provenance = require('./private-linux-update-fixture-017-provenance.cjs'), api = services.request || provenance.api;
  const { capture } = require('./sign-unix-payload.cjs'), archive = require('./module-archive.cjs');
  for (const file of [root, input]) a17.canonical(file); a17.inside(input, fs.realpathSync(env.RUNNER_TEMP)); a17.inside(output, fs.realpathSync(env.RUNNER_TEMP));
  assert.equal(fs.existsSync(output), false, 'Private017 portable output is immutable'); sha(profileSha256);
  const profileFile = path.join(input, 'profile.json'), profileBytes = read(profileFile, 32768);
  assert.equal(record(profileBytes).sha256, profileSha256); const p = validateProfile(JSON.parse(profileBytes));
  assert.ok(profileBytes.equals(json(p)), 'Canonical independent portable profile required');
  original.inventory(input, ['profile.json', 'assembly017.zip', 'portable016.zip', ...LEGACY_NAMES.map(name => `signed016/${name}`), ...m17.INPUTS.map(name => `signed017/${name}`)]);
  const held = new Map();
  function remember(file, expected, cargo = false) {
    assert.deepEqual(capture(file, expected.size, cargo), expected);
    const bytes = read(file, expected.size); assert.deepEqual(record(bytes), expected, 'Pinned bytes changed after capture');
    assert.deepEqual(capture(file, expected.size, cargo), expected); held.set(file, { expected, cargo }); return bytes;
  }
  remember(profileFile, record(profileBytes)); remember(path.join(input, 'assembly017.zip'), p.assembly017.zip);
  const signed = a17.inputs(path.join(input, 'signed017'), p.signed017.planSha256); assert.deepEqual(signed.plan.rootSource, SOURCE);
  const legacy = Object.fromEntries(LEGACY_NAMES.map(name => [name, remember(path.join(input, 'signed016', name), p.signed016.files[name])]));
  const plan16 = c16.parse(legacy['plan.json']); c16.validatePlan(plan16); assert.equal(record(legacy['plan.json']).sha256, p.signed016.planSha256);
  remember(path.join(input, 'portable016.zip'), plan16.producer.zip);
  const tools = fixedTools(root);
  for (const [name, file] of Object.entries(tools)) { a17.canonical(file); assert.deepEqual(capture(file, p.tools[name].size, true), p.tools[name]); held.set(file, { expected: p.tools[name], cargo: true }); }
  function recheck() { for (const [file, { expected, cargo }] of held) assert.deepEqual(capture(file, expected.size, cargo), expected, 'Private017 portable input/tool changed'); signed.recheck(); }
  const execute = services.execute || execFileSync;
  const call = (program, args, options = {}) => { recheck(); const value = execute(program, args, { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024, windowsHide: true, ...options }); recheck(); return value; };
  sourceCheck(env, call);
  const proof17 = await collect(p, api);
  const signedBodies = Object.fromEntries(c16.FILES.map(name => [name, legacy[name === c16.UNSIGNED ? c16.MANIFEST : name]]));
  const old = c16.validateOutput(plan16, signedBodies);
  assert.deepEqual(c16.parse(legacy[c16.DESCRIPTOR], c16.SIGNED_META), old.descriptor);
  const signingReceipt = c16.parse(legacy['private-qualification-receipt.json']);
  assert.equal(signingReceipt.profile, c16.PROFILE); assert.equal(signingReceipt.planSha256, p.signed016.planSha256);
  assert.equal(signingReceipt.authorizedBodiesSigned, 2); assert.equal(signingReceipt.privateKeyIncluded, false);
  assert.deepEqual(signingReceipt.producer, plan16.producer); assert.deepEqual(signingReceipt.rootSource, plan16.rootSource);
  for (const [name, value] of Object.entries(c16.FLAGS)) assert.equal(signingReceipt[name], value);
  const verify = (body, signature, expected) => assert.equal(String(call(tools.verifier, [body, signature])).trim(), `Verified trusted package signature: ${expected.sha256}. No activation or client changes.`);
  for (const name of [c16.MANIFEST, c16.DESCRIPTOR]) {
    assert.deepEqual(signingReceipt.signatures[`${name}.minisig`], p.signed016.files[`${name}.minisig`]);
    verify(path.join(input, 'signed016', name), path.join(input, 'signed016', `${name}.minisig`), p.signed016.files[name]);
  }
  m17.verifySignatures(signed.files, signed.records, tools.verifier, call);
  const proof16 = await require('./sign-private-portable-016.cjs').fresh(plan16, old.receipt.producer, api);
  const fresh17 = await provenance.fresh({ plan: signed.plan, handoff: signed.handoff, preparedFile: signed.files['prepared-unix.json'] }, api);
  const reused = selectorSources(root, old.receipt.selectorBuild, call); recheck(); sourceCheck(env, call);
  fs.mkdirSync(output, { mode: 0o700 });
  const receipt = { schemaVersion: 1, scope: 'unsigned-private-linux-017-portable-packaging-only', packagingSource: env.GITHUB_SHA,
    rootSource: SOURCE, assembly: proof17, selectorReuse: reused, originalSigned016Plan: p.signed016.planSha256,
    signed017Plan: p.signed017.planSha256, hermetic: false, upstreamToolsPinned: false, ...flags() };
  const write = (name, bytes) => fs.writeFileSync(path.join(output, name), bytes, { flag: 'wx', mode: 0o644 });
  try {
    write('fresh-api.json', json({ assembly017: proof17, portable016: proof16, derivation017: fresh17 }));
    const staged = path.join(output, 'assembly017');
    call('python3', ['-B', '-c', neutral.ZIP_STAGE, path.join(input, 'assembly017.zip'), staged], { input: JSON.stringify({
      pins: Object.fromEntries(Object.values(p.assembly017.files).map(({ member, size, sha256 }) => [member, { size, sha256 }])),
      allowed: Object.values(p.assembly017.files).map(value => value.member), outputs: Object.fromEntries(Object.entries(p.assembly017.files).map(([role, value]) => [value.member, ROLES[role]])) }) });
    const bodies = Object.fromEntries(Object.entries(ROLES).map(([role, name]) => [role, remember(path.join(staged, name), { size: p.assembly017.files[role].size, sha256: p.assembly017.files[role].sha256 })]));
    const built = validateAssembly(p, bodies, signed), payload = path.join(staged, ROLES.archive);
    archive.verify(payload, built.manifest, tools.decoder, call);
    const oldZip = path.join(output, 'original016');
    call('python3', ['-B', '-c', neutral.ZIP_STAGE, path.join(input, 'portable016.zip'), oldZip], { input: JSON.stringify({ pins: plan16.files, allowed: c16.FILES }) });
    for (const name of c16.FILES) assert.ok(read(path.join(oldZip, name), plan16.files[name].size).equals(signedBodies[name]), 'Signed016 differs from its successful producer artifact');
    const contents = c16.archiveContents(signedBodies[c16.ARCHIVE], old.manifest);
    const selectorFile = path.join(output, 'reused-selector'); fs.writeFileSync(selectorFile, contents[SELECTOR], { flag: 'wx', mode: 0o755 }); fs.chmodSync(selectorFile, 0o755);
    remember(selectorFile, reused.executable);
    const config = JSON.parse(read(path.join(root, 'src-tauri/tauri.conf.json'), 65536)), npm = JSON.parse(read(path.join(root, 'package.json'), 65536));
    assert.equal(config.version, VERSION); assert.equal(npm.version, VERSION); assert.equal(config.productName, 'Creator Hub'); assert.equal(config.identifier, 'com.creatorworks.hub');
    assert.equal(npm.devDependencies['@tauri-apps/cli'], '2.11.4'); assert.ok(!config.build.beforeBundleCommand && !config.bundle.resources && !config.bundle.externalBin);
    for (const name of ['tauri.linux.conf.json', 'tauri.linux.conf.json5', 'Tauri.linux.toml']) assert.equal(fs.existsSync(path.join(root, 'src-tauri', name)), false);
    assert.equal(JSON.parse(read(path.join(root, 'node_modules/@tauri-apps/cli/package.json'), 65536)).version, '2.11.4');
    const child = { PATH: env.PATH, HOME: path.join(output, 'home'), XDG_CACHE_HOME: path.join(output, 'cache'), XDG_CONFIG_HOME: path.join(output, 'config'),
      XDG_DATA_HOME: path.join(output, 'data'), CARGO_HOME: path.join(output, 'cargo'), RUSTUP_HOME: env.RUSTUP_HOME || path.join(env.HOME, '.rustup'),
      CARGO_TARGET_DIR: path.join(output, 'target'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', CI: 'true', NO_STRIP: '1' };
    for (const name of ['HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CARGO_HOME']) fs.mkdirSync(child[name], { mode: 0o700 });
    const run = (program, args, options = {}) => call(program, args, { env: child, ...options });
    const release = path.join(child.CARGO_TARGET_DIR, TARGET, 'release'); fs.mkdirSync(release, { recursive: true });
    const binary = path.join(release, 'creator-hub'); fs.writeFileSync(binary, bodies.root, { flag: 'wx', mode: 0o755 }); fs.chmodSync(binary, 0o755);
    const rawIdentity = imageSnapshot(binary); write('portable-overlay.json', json(overlay(payload)));
    assert.equal(String(run(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), '--version'])).trim(), 'tauri-cli 2.11.4');
    receipt.cliInputs = Object.fromEntries(['package-lock.json', 'node_modules/@tauri-apps/cli/tauri.js', 'node_modules/@tauri-apps/cli-linux-x64-gnu/cli.linux-x64-gnu.node'].map(name => [name, record(read(path.join(root, name)))]));
    receipt.metadataNormalization = { hostBeforeBundle: neutral.metadataEvidence(path.parse(root).root) };
    assert.deepEqual(imageSnapshot(binary), rawIdentity, 'Actual017 Root workcopy changed before bundling');
    run(process.execPath, bundleArgs(root, path.join(output, 'portable-overlay.json')), { stdio: 'inherit', timeout: 900000 });
    const restoredRawIdentity = imageSnapshot(binary);
    const bundles = path.join(release, 'bundle/appimage'); assert.deepEqual(fs.readdirSync(bundles).filter(name => name.endsWith('.AppImage')), [IMAGE]);
    receipt.appImage = neutral.retainAppImage(path.join(bundles, IMAGE), path.join(output, IMAGE));
    fs.copyFileSync(path.join(output, IMAGE), path.join(output, ALIAS), fs.constants.COPYFILE_EXCL);
    assert.deepEqual(imageSnapshot(path.join(output, ALIAS)).pin, receipt.appImage);
    verifyBundlerWorkcopyRestored(rawIdentity, restoredRawIdentity);
    assert.deepEqual(imageSnapshot(binary), restoredRawIdentity, 'Actual017 Root workcopy changed after bundling');
    receipt.packagingTools = neutral.toolInventory(path.join(child.XDG_CACHE_HOME, 'tauri'));
    receipt.hostBaseline = neutral.hostBaselineEvidence(receipt.packagingTools); receipt.appRunWrapper = neutral.appRunToolBinding(receipt.packagingTools);
    const appdir = path.join(bundles, 'Creator Hub.AppDir'), retained = path.join(output, 'Creator Hub.original.AppDir');
    const inv = neutral.inventory(appdir, true); neutral.validateAppRunWrapped(neutral.APPRUN_WRAPPED, inv.entries[neutral.APPRUN_WRAPPED], undefined, true);
    neutral.retainOriginalAppDir(appdir, retained, inv);
    const packaged = read(path.join(appdir, 'usr/bin/creator-hub'));
    require('./unix-package-payload.cjs').verifyLinuxHub(bodies.root, packaged, 'appimage'); assert.ok(packaged.includes(bodies.manifest));
    assert.deepEqual(record(read(path.join(appdir, 'usr/lib/Creator Hub/modules.tar.gz'))), record(bodies.archive));
    archive.verify(path.join(appdir, 'usr/lib/Creator Hub/modules.tar.gz'), built.manifest, tools.decoder, call);
    receipt.metadataNormalization = { ...receipt.metadataNormalization, hostAfterBundle: neutral.metadataEvidence(path.parse(root).root),
      original: neutral.metadataEvidence(appdir), retainedOriginal: neutral.metadataEvidence(retained) };
    neutral.validateCompiledSchema(neutral.metadataRead(path.join(appdir, neutral.COMPILED_SCHEMA)), run);
    const transport = path.join(output, 'Creator Hub.AppDir'), transformed = neutral.flatten(appdir, transport);
    const host = hostProfile(bodies.root, packaged); assert.equal(Object.hasOwn(transformed.flattened.entries, HOST), false);
    fs.writeFileSync(path.join(transport, HOST), host, { flag: 'wx', mode: 0o644 }); fs.chmodSync(path.join(transport, HOST), 0o644);
    const withHost = neutral.inventory(transport);
    assert.deepEqual(withHost.entries, { ...transformed.flattened.entries, [HOST]: { kind: 'file', ...record(host), mode: 0o644 } });
    const finalInventory = neutral.production016().attachSelector(transport, withHost, { file: selectorFile, proof: { executable: reused.executable } });
    receipt.dependencies = neutral.dependencies(transport, finalInventory.entries, run, { includeHub: true, includeSelector: true });
    receipt.closureAbi = neutral.closureAbiRequirements(transport, receipt.dependencies, run);
    receipt.hostProfile = { ...record(host), version: VERSION, executable: record(packaged), scope: 'canonical-appdir-transport-only', appImageContainsProfile: false };
    write('appdir-original-inventory.json', json(transformed.original)); write('appdir-flattened-inventory.json', json(finalInventory));
    const binding = await neutral.packTar(transport, path.join(output, ARCHIVE), finalInventory), portable = manifest(finalInventory, binding);
    write('portable-manifest.unsigned.json', json(portable)); receipt.archive = binding; receipt.manifest = record(json(portable));
    assert.deepEqual(neutral.inventory(appdir, true), inv); assert.deepEqual(neutral.inventory(retained, true), inv);
    assert.deepEqual(imageSnapshot(binary), restoredRawIdentity); assert.deepEqual(imageSnapshot(path.join(output, IMAGE)).pin, receipt.appImage);
    assert.deepEqual(imageSnapshot(path.join(output, ALIAS)).pin, receipt.appImage);
    for (const [name, expected] of Object.entries(receipt.cliInputs)) assert.deepEqual(record(read(path.join(root, name))), expected);
    recheck(); sourceCheck(env, call); receipt.packagingCompleted = true; write('package-receipt.json', json(receipt)); return receipt;
  } catch (error) {
    receipt.packagingCompleted = false; receipt.error = String(error.message).slice(0, 2000);
    if (error.inventoryEvidence) receipt.inventoryEvidence = error.inventoryEvidence;
    if (error.dependencyEvidence) receipt.dependencies = error.dependencyEvidence;
    write('package-refusal.json', json(receipt)); throw error;
  }
}
module.exports = { VERSION, TARGET, PROFILE, BRANCH, WORKFLOW, SOURCE, FEATURES, IMAGE, ALIAS, ARCHIVE, HOST, SELECTOR, ROLES, LEGACY_NAMES, SCOPE_PATHS,
  flags, json, verifyBundlerWorkcopyRestored, validateProfile, admission, assemblyAPI, collect, fixedTools, sourceCheck, selectorSources, validateAssembly, overlay, bundleArgs, hostProfile, manifest, produce };
if (require.main === module) Promise.resolve().then(() => {
  const args = process.argv.slice(2); assert.equal(args.length, 8); assert.deepEqual(args.filter((_, i) => i % 2 === 0), ['--root', '--input', '--profile-sha256', '--output']);
  return produce({ root: args[1], input: args[3], profileSha256: args[5], output: args[7] });
}).then(receipt => console.log(JSON.stringify({ profile: PROFILE, packagingCompleted: receipt.packagingCompleted, ...flags() })))
  .catch(error => { console.error(String(error.message).slice(0, 2000)); process.exitCode = 1; });
