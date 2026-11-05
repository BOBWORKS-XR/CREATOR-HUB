'use strict';
// Prepare an audited canonical CLI invocation only after actual raw NSIS acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const q = require('./windows-016-release-qualification.cjs');
const target = q.RELEASE_TARGET, VERSION = q.FINAL_VERSION, ASSET = q.FINAL_ASSETS[0];
const stage = require('./windows-017-draft-stage.cjs');
const SUPPORT_HASH = '6b9bd9e7513a8ea47eb5f70e9f559ab675970d6274e4b0c613aa68569d840a21';
const SIGNER_HASH = 'c0cbba3f35f55f8c7521ecaedd3f79049f794939849d1c52bfc8ce5e37cf6e9b';
const VERIFIER_HASH = '035f6a5702b1dd160558baa9763c3f5b561d16529d310efd3e57b2373e44a052';
const SDK_FILES_019 = Object.freeze([
  'modules/project-setup/src-tauri/Cargo.toml', 'modules/project-setup/src-tauri/Cargo.lock',
  'modules/project-setup/src-tauri/src/lib.rs', 'modules/project-setup/src-tauri/src/logic.rs',
  'modules/project-setup/src-tauri/src/repair.rs', 'modules/project-setup/src-tauri/src/sdk_requirements.rs',
  'modules/project-setup/src-tauri/src/sdk_compatibility_audit.rs', 'modules/project-setup/src-tauri/src/sdk_production_audit.rs',
  'modules/project-setup/src-tauri/src/ProjectSetupValidator.cs',
  'modules/project-setup/tests/UnitySdkProductionAudit.cs', 'modules/project-setup/tests/UnitySdkCompatibilitySeed.cs',
]);
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function read(file, limit = 4 * 1024 * 1024) {
  const s = fs.lstatSync(file); assert.ok(s.isFile() && !s.isSymbolicLink() && s.size > 0 && s.size <= limit);
  const bytes = fs.readFileSync(file); assert.equal(bytes.length, s.size); return bytes;
}
function json(file) { return JSON.parse(read(file)); }
function doc(member, bytes) { return { member, size: bytes.length, sha256: hash(bytes), base64: bytes.toString('base64') }; }
function safePath(file) { assert.ok(path.isAbsolute(file) && !/["%!\r\n]/.test(file), 'Absolute cmd-safe path required'); return file; }
function plainParents(directory) {
  let current = path.parse(directory).root;
  for (const part of path.relative(current, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const s = fs.lstatSync(current); assert.ok(s.isDirectory() && !s.isSymbolicLink());
  }
}
// The wrapper proves restored normal repair; the original qualification remains non-release evidence.
function validateSdkEvidence(evidence, inputs, profile = target) {
  assert.equal(profile.version, '0.1.19');
  assert.ok(evidence && profile.sdkRepair, 'Original R2 SDK evidence is required');
  assert.deepEqual(Object.keys(evidence).sort(), ['operations', 'qualification', 'reopened', 'result']);
  const records = {};
  for (const [name, bytes] of Object.entries(evidence)) {
    assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 4 * 1024 * 1024);
    assert.match(profile.sdkRepair[name] || '', /^[a-f0-9]{64}$/);
    assert.equal(hash(bytes), profile.sdkRepair[name], `Original SDK ${name} bytes differ`);
    records[name] = JSON.parse(bytes);
  }
  const { result, qualification, operations, reopened } = records, source = result.sourceBinding;
  assert.equal(result.kind, 'sdk4022-vs1912-frozen-r2-production-repair');
  for (const key of ['childStarted', 'childExitObserved', 'oneTestPassed', 'passed']) assert.equal(result[key], true, key);
  assert.equal(result.childExitCode, 0); assert.deepEqual(result.errors, []);
  assert.equal(result.restoration.restoredExactly, true); assert.equal(result.releaseAcceptance, false);
  assert.equal(result.beforeBackup.sha256, result.afterBackup.sha256);
  assert.equal(source.mode, 'frozen-git-export');
  assert.equal(source.sourceCommit, profile.source.commit); assert.equal(source.sourceTree, profile.source.tree);
  assert.equal(source.sourceReceiptSha256, profile.cleanBuild.sourceReceiptSha256);
  for (const [name, pin] of [['qualification', result.qualification], ['operations', result.qualification.production.operations],
    ['reopened', result.qualification.production.reopened]]) {
    assert.equal(pin.sha256, profile.sdkRepair[name]); assert.equal(pin.size, evidence[name].length);
  }
  assert.equal(result.qualification.packageChecksPassed, true);
  assert.equal(result.qualification.qualificationPassed, false);
  assert.equal(qualification.qualificationPassed, false); assert.equal(qualification.releaseAcceptance, false);
  for (const key of ['packageChecksPassed', 'protectedFilesPreserved', 'sourcePreserved']) assert.equal(qualification[key], true, key);
  for (const key of ['error', 'protectedFilesCheckError', 'sourceCheckError']) assert.equal(qualification[key], null, key);
  for (const key of ['earlierBackupPreserved', 'manifestPreserved']) assert.equal(operations[key], true, key);
  assert.equal(operations.releaseAcceptance, false);
  for (const name of ['firstRepair', 'repeatRepair', 'reopenedValidation']) {
    const check = operations[name]; assert.equal(check.success, true); assert.equal(check.validated, true);
    assert.equal(check.validation.success, true); assert.equal(check.validation.sdkReadyDone, true);
    assert.equal(check.validation.nodesBuiltForThisVersion, true);
    assert.equal(check.validation.creatorSdkVersion, '4.0.22'); assert.equal(check.validation.visualScriptingVersion, '1.9.12');
  }
  for (const key of ['success', 'validated']) assert.equal(operations.readinessValidation[key], false);
  assert.equal(operations.readinessValidation.validation.nodesBuiltForThisVersion, false);
  assert.equal(operations.readinessValidation.validation.sdkReadyDone, false);
  assert.equal(reopened.sdkReadyDone, true); assert.equal(reopened.customSelectionsPreserved, true);
  assert.equal(reopened.releaseAcceptance, false);
  assert.deepEqual(Object.keys(source.files).sort(), [...SDK_FILES_019].sort(), 'Exact tested R2 SDK closure required');
  const files = new Map(inputs.map(row => [row.path, row.sha256]));
  return SDK_FILES_019.map(path => {
    const sha256 = source.files[path].sha256;
    assert.match(sha256, /^[a-f0-9]{64}$/); assert.notEqual(sha256, '0'.repeat(64));
    assert.equal(sha256, files.get(path), `Tested R2 SDK source differs: ${path}`);
    return { path, candidateSha256: sha256, testedSha256: sha256, match: 'exact' };
  });
}
function sourceBindings(bindings, inputs, sdkEvidence) {
  assert.match(bindings.sourceCommit || '', /^[a-f0-9]{40}$/);
  assert.ok(bindings.sourceCommit === q.FINAL_SOURCE.commit
    || (target.rootBuild && bindings.sourceCommit === target.rootBuild.reusedSourceCommit), 'Runtime source binding must match the actual or explicitly reused source');
  assert.equal(bindings.sdkNormalRepairPassed, true);
  assert.equal(bindings.bridgeRuntimePassed, true); assert.equal(bindings.bridgeOnlyLfNormalized, true); assert.equal(bindings.releaseAcceptance, false);
  const modern = target.version === '0.1.19';
  assert.ok(Array.isArray(bindings.sdkBindingRows)); assert.equal(bindings.sdkBindingRows.length, modern ? SDK_FILES_019.length : 9);
  const files = new Map(inputs.map(row => [row.path, row.sha256]));
  assert.equal(new Set(bindings.sdkBindingRows.map(row => row.path)).size, modern ? SDK_FILES_019.length : 9);
  if (modern) {
    const tested = validateSdkEvidence(sdkEvidence, inputs);
    assert.deepEqual(bindings.sdkBindingRows.map(row => row.path).sort(), [...SDK_FILES_019].sort());
    const byPath = new Map(tested.map(row => [row.path, row]));
    for (const row of bindings.sdkBindingRows) assert.deepEqual(row, byPath.get(row.path));
    assert.match(bindings.bridgeFrozenSha256 || '', /^[a-f0-9]{64}$/);
    assert.notEqual(bindings.bridgeFrozenSha256, '0'.repeat(64));
    assert.ok(files.has('modules/mcp/unity-extension/Editor/BanterMCPBridge.cs'));
  }
  for (const row of bindings.sdkBindingRows) {
    assert.equal(row.candidateSha256, files.get(row.path)); assert.match(row.testedSha256, /^[a-f0-9]{64}$/);
    if (row.match === 'exact') assert.equal(row.testedSha256, row.candidateSha256);
    else { assert.equal(row.match, 'LF normalization only'); assert.equal(row.path, 'modules/project-setup/src-tauri/src/ProjectSetupValidator.cs'); }
  }
  assert.equal(bindings.bridgeFrozenSha256, files.get('modules/mcp/unity-extension/Editor/BanterMCPBridge.cs'));
}
function validateSignalEvidence(build, profile = target) {
  if (profile.cleanBuild) {
    assert.equal(build.kind, profile.cleanBuild.kind);
    assert.deepEqual(build.rawSignal, { present: true, value: null });
    assert.equal(Object.hasOwn(build, 'signal'), false, 'Typed clean receipt must not invent a raw signal value');
  } else if (!profile.rootBuild) {
    assert.equal(build.error, null); assert.equal(build.signal, null);
  }
}
async function collect(plan, io) {
  require('./windows-release-target.cjs').requireSource();
  const buildBytes = read(plan.buildResult), build = JSON.parse(buildBytes), sourceBytes = read(plan.sourceReceipt),
    source = JSON.parse(sourceBytes), inputBytes = read(plan.buildInputs);
  assert.equal(build.sourceCommit, q.FINAL_SOURCE.commit); assert.equal(build.sourceTree, q.FINAL_SOURCE.tree);
  assert.equal(source.commit, q.FINAL_SOURCE.commit); assert.equal(source.tree, q.FINAL_SOURCE.tree);
  const originalBytes = target.rootBuild ? read(plan.originalBuildResult) : undefined;
  require('./windows-release-target.cjs').validateBuildRecord(buildBytes, {
    sourceCommit: q.FINAL_SOURCE.commit, sourceTree: q.FINAL_SOURCE.tree,
    installerSha256: plan.expectedInstallerSha256, executableSha256: plan.expectedExecutableSha256,
  }, originalBytes);
  // validateBuildRecord above must verify the original bytes before interpreting their signal schema.
  validateSignalEvidence(build);
  if (VERSION === '0.1.19') require('./windows-release-target.cjs').validateCleanBuildInputs(buildBytes, {
    sourceCommit: q.FINAL_SOURCE.commit, sourceTree: q.FINAL_SOURCE.tree,
    installerSha256: plan.expectedInstallerSha256, executableSha256: plan.expectedExecutableSha256,
  }, inputBytes, sourceBytes);
  assert.equal(build.installerSha256, plan.expectedInstallerSha256, 'Build differs from the independently supplied installer pin');
  assert.equal(build.executableSha256, plan.expectedExecutableSha256, 'Build differs from the independently supplied EXE pin');
  const sourceRoot = fs.realpathSync(source.source), output = fs.realpathSync(build.output);
  if (target.rootBuild) {
    assert.equal(path.dirname(output), fs.realpathSync(path.dirname(plan.buildResult)), 'Verified post-build output must be beside its pinned receipt');
    assert.equal(hash(inputBytes), target.rootBuild.inputSha256);
    assert.equal(hash(read(plan.sourceReceipt)), target.rootBuild.sourceReceiptSha256);
  } else assert.ok(output.startsWith(sourceRoot + path.sep), 'Build output must be inside the frozen source export');
  const installer = path.join(output, 'installer.exe'), executable = path.join(output, 'installer-extracted/creator-hub.exe');
  const installerBytes = read(installer, 256 * 1024 * 1024), exeBytes = read(executable, 256 * 1024 * 1024);
  assert.equal(hash(installerBytes), build.installerSha256); assert.equal(hash(exeBytes), build.executableSha256);
  const checksum = json(path.join(output, 'installer-checksum.json'));
  assert.equal(checksum.version, VERSION); assert.equal(checksum.sha256, build.installerSha256);
  assert.equal(checksum.installedExecutableSha256, build.executableSha256);
  const inputs = JSON.parse(inputBytes), bindingBytes = read(plan.runtimeBindings);
  let sdkEvidence;
  if (VERSION === '0.1.19') {
    assert.ok(plan.sdkEvidence, 'Original R2 SDK evidence paths are required');
    assert.deepEqual(Object.keys(plan.sdkEvidence).sort(), ['operations', 'qualification', 'reopened', 'result']);
    sdkEvidence = Object.fromEntries(Object.entries(plan.sdkEvidence).map(([name, file]) => [name, read(file)]));
  }
  assert.ok(Array.isArray(inputs)); sourceBindings(JSON.parse(bindingBytes), inputs, sdkEvidence);
  const candidate = { sourceCommit: q.FINAL_SOURCE.commit, sourceTree: q.FINAL_SOURCE.tree,
    installer: { size: installerBytes.length, sha256: build.installerSha256 }, executableSha256: build.executableSha256,
    buildResultSha256: hash(buildBytes), buildInputsSha256: hash(inputBytes), buildResult: doc(path.basename(plan.buildResult), buildBytes),
    ...(VERSION === '0.1.19' ? { buildInputs: doc(path.basename(plan.buildInputs), inputBytes),
      sourceReceipt: doc(path.basename(plan.sourceReceipt), sourceBytes) } : {}),
    ...(target.rootBuild ? { originalBuildResult: doc(path.basename(plan.originalBuildResult), originalBytes) } : {}) };
  const receipt = { schemaVersion: 1, kind: target.rawKind, version: VERSION,
    productionApproval: false, releaseReady: false, candidate, proofs: {} };
  assert.deepEqual(Object.keys(plan.cases).sort(), ['fresh', 'guarded']);
  for (const [mode, pins] of Object.entries(plan.cases)) {
    for (const id of [pins.runId, pins.jobId, pins.artifactId]) assert.ok(Number.isSafeInteger(id) && id > 0);
    const run = await io.request(`actions/runs/${pins.runId}`), artifact = await io.request(`actions/artifacts/${pins.artifactId}`);
    assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 2 * 1024 * 1024);
    const archive = await io.download(`actions/artifacts/${pins.artifactId}/zip`, artifact.size_in_bytes + 1);
    assert.equal(hash(archive), artifact.digest?.replace(/^sha256:/, '')); assert.equal(archive.length, artifact.size_in_bytes);
    if (target.rootBuild) {
      assert.match(pins.artifactSha256 || '', /^[a-f0-9]{64}$/);
      assert.equal(hash(archive), pins.artifactSha256, 'Independently supplied raw artifact pin differs');
    }
    const commit = await io.request(`git/commits/${run.head_sha}`);
    receipt.proofs[mode] = { runId: pins.runId, runAttempt: run.run_attempt, jobId: pins.jobId, sourceCommit: run.head_sha, sourceTree: commit.tree.sha,
      artifact: { id: pins.artifactId, name: artifact.name, size: artifact.size_in_bytes, sha256: hash(archive) },
      report: doc(VERSION === '0.1.19' ? 'installer-evidence/installer-report.json' : 'installer-report.json',
        q.readZipMember(archive, VERSION === '0.1.19' ? 'installer-evidence/installer-report.json' : 'installer-report.json')),
      binding: doc(VERSION === '0.1.19' ? 'private-input-binding-019.json' : 'private-input-binding.json',
        q.readZipMember(archive, VERSION === '0.1.19' ? 'private-input-binding-019.json' : 'private-input-binding.json')) };
  }
  await stage.verifyRaw(receipt, io);
  return { receipt, installerBytes, exeBytes, bindingsSha256: hash(bindingBytes), bindingSourceCommit: JSON.parse(bindingBytes).sourceCommit,
    ...(sdkEvidence ? { sdkEvidenceSha256: Object.fromEntries(Object.entries(sdkEvidence).map(([name, bytes]) => [name, hash(bytes)])) } : {}) };
}
function protocolReceipt(raw) {
  stage.validate(raw);
  const c = raw.candidate;
  return { schemaVersion: 1, appId: 'creator-hub', version: VERSION, byteLength: c.installer.size, sha256: c.installer.sha256,
    executableSha256: c.executableSha256, identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1, minHubVersion: target.minimumHub,
    installerScope: 'guarded-nsis-update-default-location-no-msi', approvedForStable: true,
    approvalScope: 'Verified raw NSIS installer protocol only; private draft staging, not release approval.',
    evidence: [...new Set(Object.values(raw.proofs).map(p => `https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/${p.runId}`))],
    productionApproval: false, releaseReady: false };
}
function copySupport(output, platformRoot) {
  platformRoot = fs.realpathSync(safePath(platformRoot));
  const helperFile = path.join(platformRoot, 'artifacts/windows-r2-signer-draft-20261102/signer.cjs');
  assert.equal(hash(read(helperFile)), SUPPORT_HASH, 'Audited signer support changed');
  const helper = require(helperFile), rows = helper.hardenedClosure(helper.snapshotClosure(path.join(platformRoot, 'node_modules')));
  const script = read(path.join(__dirname, 'release-descriptor.cjs')); assert.equal(hash(script), SIGNER_HASH);
  const verifier = read(path.join(platformRoot, 'artifacts/menu-merge-20261027/sign-verifier-v4/verify-release.exe'), 128 * 1024 * 1024);
  assert.equal(hash(verifier), VERIFIER_HASH);
  const trusted = path.join(output, 'trusted'), files = {};
  const write = (name, bytes) => { const file = path.join(trusted, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { flag: 'wx' }); files[path.relative(output, file)] = hash(bytes); };
  write('scripts/release-descriptor.cjs', script); write('verify-release.exe', verifier);
  for (const row of rows) write(`node_modules/${row.path}`, row.bytes);
  helper.snapshotClosure(path.join(trusted, 'node_modules'), helper.pins.stagedSignerClosure);
  return files;
}
function launchText(output, signingKeyPath) {
  safePath(output); safePath(signingKeyPath); const p = name => path.join(output, name);
  const clean = ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_COMPILE_CACHE', 'NODE_V8_COVERAGE',
    'NAPI_RS_NATIVE_LIBRARY_PATH', 'NAPI_RS_FORCE_WASI', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PATH'];
  return ['@echo off', 'setlocal DisableDelayedExpansion', ...clean.map(name => `set "${name}="`),
    'set "PATH=C:\\Windows\\System32"', `set "CREATOR_HUB_SIGNING_KEY_PATH=${signingKeyPath}"`,
    `if exist "${p('signed')}" exit /b 1`,
    `"C:\\Program Files\\nodejs\\node.exe" "${p('trusted/scripts/release-descriptor.cjs')}" hub ${VERSION} "${p('unsigned/' + ASSET)}" "${p('creator-hub.exe')}" "${p('signed')}" "${p('installer-protocol.json')}"`,
    'if errorlevel 1 exit /b 1',
    `"C:\\Program Files\\nodejs\\node.exe" "${path.join(__dirname, 'windows-017-signing.cjs')}" --finalize "${output}"`,
    'exit /b %errorlevel%', ''].join('\r\n');
}
async function prepare(plan, io = stage.services(), support = copySupport) {
  const platformRoot = safePath(plan.platformRoot), signingKeyPath = safePath(plan.signingKeyPath);
  const checked = await collect(plan, io), output = safePath(path.resolve(plan.output));
  plainParents(path.dirname(output)); assert.equal(fs.existsSync(output), false, 'Signing preparation already exists; retain it');
  fs.mkdirSync(output); fs.mkdirSync(path.join(output, 'unsigned'));
  const files = support(output, platformRoot);
  function write(name, bytes) { fs.writeFileSync(path.join(output, name), bytes, { flag: 'wx' }); files[name] = hash(bytes); }
  write('raw-installer-qualification.json', Buffer.from(JSON.stringify(checked.receipt, null, 2) + '\n'));
  write('installer-protocol.json', Buffer.from(JSON.stringify(protocolReceipt(checked.receipt), null, 2) + '\n'));
  write('unsigned/' + ASSET, checked.installerBytes); write('creator-hub.exe', checked.exeBytes);
  write('launch-sign.cmd', Buffer.from(launchText(output, signingKeyPath)));
  const result = { kind: target.signingKind, sourceCommit: q.FINAL_SOURCE.commit, files,
    runtimeSourceBindingsSha256: checked.bindingsSha256, runtimeSourceBindingsSourceCommit: checked.bindingSourceCommit,
    ...(checked.sdkEvidenceSha256 ? { sdkEvidenceSha256: checked.sdkEvidenceSha256 } : {}),
    signingInvoked: false, productionApproval: false, releaseReady: false };
  fs.writeFileSync(path.join(output, 'preparation.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); return result;
}
function finalize(output) {
  require('./windows-release-target.cjs').requireSource();
  output = safePath(path.resolve(output)); const prep = json(path.join(output, 'preparation.json'));
  assert.equal(prep.kind, target.signingKind); assert.equal(prep.sourceCommit, q.FINAL_SOURCE.commit);
  for (const [name, digest] of Object.entries(prep.files)) {
    const relative = name.replace(/\\/g, '/');
    assert.ok(!path.isAbsolute(name) && !/[\x00-\x1f:]/.test(relative) && !relative.split('/').some(p => !p || p === '.' || p === '..'));
    assert.ok(['raw-installer-qualification.json', 'installer-protocol.json', 'unsigned/' + ASSET,
      'creator-hub.exe', 'launch-sign.cmd', 'trusted/scripts/release-descriptor.cjs', 'trusted/verify-release.exe'].includes(relative)
      || /^trusted\/node_modules\/(?:@tauri-apps\/cli(?:-win32-x64-msvc)?|semver)\//.test(relative), 'Unapproved preparation file');
    const file = path.join(output, name); plainParents(path.dirname(file));
    assert.ok(fs.realpathSync(file).startsWith(fs.realpathSync(output) + path.sep));
    assert.equal(hash(read(file, 256 * 1024 * 1024)), digest);
  }
  const raw = stage.validate(json(path.join(output, 'raw-installer-qualification.json'))), signed = path.join(output, 'signed');
  const names = q.FINAL_ASSETS.filter(n => n !== 'SHA256SUMS.txt'), bodies = Object.fromEntries(names.map(n => [n, read(path.join(signed, n), n.endsWith('.exe') ? 256 * 1024 * 1024 : 32768)]));
  bodies['SHA256SUMS.txt'] = Buffer.from(names.sort().map(n => `${hash(bodies[n])}  ${n}\n`).join(''));
  const assets = Object.fromEntries(Object.entries(bodies).map(([name, b]) => [name, { size: b.length, sha256: hash(b) }]));
  q.checkFinalPayload({ candidate: { installerSha256: raw.candidate.installer.sha256, executableSha256: raw.candidate.executableSha256 }, draft: { assets } }, bodies);
  const verifier = path.join(output, 'trusted/verify-release.exe'); assert.equal(hash(read(verifier, 128 * 1024 * 1024)), VERIFIER_HASH);
  const verified = execFileSync(verifier, ['creator-hub', signed, path.join(signed, q.FINAL_ASSETS[0]), path.join(output, 'creator-hub.exe')],
    { windowsHide: true, encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
  assert.equal(verified.trim(), `Verified creator-hub ${VERSION}: descriptor, installer, installed executable and tamper rejection.`);
  fs.writeFileSync(path.join(signed, 'SHA256SUMS.txt'), bodies['SHA256SUMS.txt'], { flag: 'wx' });
  const result = { kind: target.signedKind, assets, rawInstallerQualification: path.join(output, 'raw-installer-qualification.json'),
    rawInstallerQualificationSha256: prep.files['raw-installer-qualification.json'], productionApproval: false, releaseReady: false };
  fs.writeFileSync(path.join(output, 'signed-ready.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' }); return result;
}
module.exports = { collect, protocolReceipt, prepare, finalize, launchText, sourceBindings, validateSignalEvidence, copySupport,
  SDK_FILES_019, validateSdkEvidence };
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args[0] === '--finalize') { assert.equal(args.length, 2); return finalize(args[1]); }
    const { values } = parseArgs({ options: { plan: { type: 'string' }, sha256: { type: 'string' } } });
    assert.match(values.sha256 || '', /^[a-f0-9]{64}$/); const bytes = read(values.plan); assert.equal(hash(bytes), values.sha256);
    return prepare(JSON.parse(bytes));
  })().then(result => console.log(JSON.stringify(result)), error => { console.error(`Signing preparation refused: ${error.message}`); process.exitCode = 1; });
}
