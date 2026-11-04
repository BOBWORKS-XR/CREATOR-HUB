'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const target = Object.freeze({
  version: '0.1.19', successor: '0.1.20', predecessor: '0.1.18', minimumHub: '0.1.12',
  // Exact R2 artifacts only. Unfinished native/client lanes remain unbound below.
  source: Object.freeze({ commit: 'ed3e7dabc2e83fea8b7cadce63bbeb502fed2306', tree: 'bd6328c41871465fe64e65e3f9d53c6f2ba0ed8d' }),
  parent: '930a2886b6872a08a4a25be4738a5a01a4e911d2',
  sourceCi: Object.freeze({ runId: 41752237429, runAttempt: 1, jobId: 126319848504,
    harnessCommit: '0eee5592661f2b19e62b1b8696bc9fc13d365419', harnessTree: '234b1e22b546e5a72b20322199b68c4c3a91add0',
    workflow: '.github/workflows/windows-final-mcp-tests.yml', branch: 'validation/windows-019-source-tests',
    workflowBlobSha: '57e9967d553b396f72f18d6ace71d63c62fd35e2',
    workflowSha256: 'c6bc801c97b871b541a2d3fa8ef71c6d67c9e10494ee0980b2dbe987478cadae', expectedTests: 316,
    artifactId: 13285788993, artifactName: 'windows-019-r2-mcp-npm-41752237429-1', artifactSize: 10441,
    artifactSha256: 'eb7c140d18fca47013e4172bd01858d61043133b9f2b9efe0b1dc74a92e3b6fd' }),
  rootBuild: null,
  cleanBuild: Object.freeze({ kind: 'windows-019-clean-postbuild-verification',
    receiptSha256: 'b15c19cf8854b39bacb83afd731e0a4bd715427ae0989834cf96cfd321fb999f',
    rawReceiptSha256: 'c3324ab136bf92a4ad13981b8718e3295bfb058612ccf25c3db039a6eb1fde41',
    rawWrapperSha256: '86a83b85b411b48fe4c50d226793921edc68c3f78834d653f783d28ba22d5592',
    inputSha256: '907c0962199d21fc297b3ee41dec1dc8bf7dd72559a63c615aa2a775120ef014',
    sourceReceiptSha256: '73d79f594fb98b17c1bb6a8efac750d00942b58f0b9412651533e684e48d279a',
    installerSha256: '1a0d85127827b854dcdd3ae89f4c5e2aca3824b81623f1b9b05e022871ee6419',
    executableSha256: '5bd277950ac6409b6820005e28767bbd3dd1281ea84e5f87f9b1990ffcda5d12',
    setupExecutableSha256: 'f66a4527b9d0c01337a6f6e3efd02e98bff5efdddcd0cd4c5b3c9ca6a5704b33',
    manifestSha256: '9cd5b49b85a7f5319a60322aafd5f717037e28787598662478ab0bf0f0965b12',
    runtimeSha256: '85a9408940ae424960d63c7f3c7cb2364d34432d5866dc6a80fb80e1e762c433' }),
  localEvidenceRequired: true,
  rootNative: Object.freeze({ receiptSha256: '883fc6f845e07c66608634fbf52d1c6169256525c633265b0a1ba4200f3c0cc8',
    logSha256: 'c281152207169c33011af646bcecfb664044ac4cb2990e51338b153c07660c69', passed: 529, ignored: 14,
    regressions: Object.freeze(['mixed_separator_receipt_is_the_same_reviewed_windows_path',
      'mixed_separator_saved_fields_preserve_all_other_values_exactly', 'mixed_separator_receipt_and_saved_fields_are_read_only_validation',
      'wrong_receipt_path_never_renews_snapshots', 'wrong_saved_path_or_preference_never_renews_snapshots',
      'false_or_missing_changed_never_accepts_changed_stores', 'later_store_error_cannot_partially_renew_first_snapshot',
      'features::tests::only_fixed_sdk_metadata_lookup_skips_exclusive_mutation_admission',
      'projects::tests::opening_preserves_an_unused_unity_lock_marker_but_refuses_a_held_marker']) }),
  setupNative: Object.freeze({ receiptSha256: '00fcfed1a527f8d3be31871588a73c87afedeff0c8f69383b0cda880d86a027f',
    logSha256: '2cf7953c336bc511e9fba96a5d4405b892f036d6e23dffde6d2c79d5deafde9b', passed: 235, ignored: 20,
    regressions: Object.freeze(['sdk_requirements::tests::provided_manifest_keeps_selector_lock_sdk_and_size_checks',
      'repair::tests::partial_plan_uses_installed_dependency_versions_without_downgrades',
      'repair::tests::partial_without_metadata_repairs_only_known_scopes_and_preserves_validation']) }),
  sdkRepair: Object.freeze({ result: 'fda6a91a1b5ba38040a92657ef02a435cf37e41c77e87c74e6fd23f508782a2a',
    qualification: '561ea938db8ba0da49c3a99d79c6af343a7d9765169dd2c736b5be9845a661c6',
    operations: '325a2f6f521126c240aacfa43eaef44b55190ad703eaffa3423043276926567a',
    reopened: '7e044bebd3e8caa9779203d6cfe477e6a7136e3c892c44c95626d3a9c89d2040' }),
  realCodex: Object.freeze({ receiptSha256: '51e8037b221069cd4d5a13f2317aec5dc2617088155c02fa3feab84885754ade',
    eventStreamSha256: '24878f2feda13a45b7a3d820f30bb0d9b37022ee0f99640f4e14387013f47676' }),
  localRestart: Object.freeze({ receiptSha256: 'ecfa030d1041ad9cb1e1eb5d316aa31d7f50ef90ff877e4d5d88c32b5b97216f',
    sdkReceiptSha256: 'b4b964da4ffcde9a35e3dfdcddb80f9ea3650126e9c96d2896b2bb9c472101dd',
    projectCount: 30, settingsAndPhaseFiles: 6, configuredClients: 3,
    componentSourceCommit: 'ed3e7dabc2e83fea8b7cadce63bbeb502fed2306' }),
  privateMigrationLimitation: Object.freeze({ scope: 'pre-existing-private-0.1.18-migration-record',
    status: 'unresolved', recordRetained: true, operationIdentity: 'unavailable',
    automaticRecovery: 'not verified', localMigrationAccepted: false }),
  runtime: Object.freeze({ baselineGeneration: '6336e342a58cedbdc1aca8e44ac128803a696f3998f84a7263d79ab4b2d500ad',
    targetGeneration: '34cc742ff14dc1445e27dc4087707b129feb44fdcce7320c9315ec28be360617',
    baselineModuleVersion: '2.7.7', targetModuleVersion: '2.7.7-fixture.20',
    verificationReceiptSha256: '40c81e181ab5d37b28d8dbea2bb29519cccddf2043baf264c28d1950e27f85a5' }),
  successorEvidence: Object.freeze({ sourceCommit: '29e274db1009cf14622d0df4f0ecbaf13bc55e92',
    sourceTree: 'c96a29b7c29c872752f33eacd16c610e68cfcba5',
    pins: Object.freeze({ descriptor: '5004026b47465065d175cd07087191dcab5780fefe7c48184b9d74211e0d571c',
      descriptorSignature: 'd9bc3a70da5e70546827e84ec57688ae7a1e7cc3fbf6781bba727a45c814c696',
      installer: 'b47ad938e5a5b03487689358958aaa44d2852161a19a4e40f85c059793b07240',
      executable: 'd231f9a4182f28bdb2bfa72379e8647f85976eeba2b9b6ad2a00bc2a29fde73e',
      manifest: '91b31557b02efc318272e7c9e2f30e6686b1089cf3139e6932b1b77ef90e3691' }) }),
  splitNativeRoles: true,
  productionLanes: Object.freeze({
    incoming: Object.freeze({ runId: 41809827608, runAttempt: 1,
      sourceCommit: '2b9680a320ed85b177c12c6f48738b69f6eb582a', sourceTree: 'f6a2b521c1bc0bfc4ead9e90bd388295321a9901' }),
    custom: Object.freeze({ runId: 41809827608, runAttempt: 1,
      sourceCommit: '2b9680a320ed85b177c12c6f48738b69f6eb582a', sourceTree: 'f6a2b521c1bc0bfc4ead9e90bd388295321a9901' }),
    standard: Object.freeze({ runId: 41809827608, runAttempt: 1,
      sourceCommit: '2b9680a320ed85b177c12c6f48738b69f6eb582a', sourceTree: 'f6a2b521c1bc0bfc4ead9e90bd388295321a9901' }),
    outgoing: Object.freeze({ runId: 41809324034, runAttempt: 1,
      sourceCommit: 'cf40c4c13885be74dec4ebb03b6d639c443eb051', sourceTree: '6a14c07d4cca359d22a37719b375d060c7d9ec1f' }),
  }),
  qualificationKind: 'windows-019-qualified-draft', rawKind: 'windows-019-raw-installer-qualification',
  signingKind: 'windows-019-canonical-signing-preparation', signedKind: 'windows-019-signed-files-verified',
  draftKind: 'windows-019-private-signed-draft', outgoingKind: 'direct-outgoing-019-020',
  rawProducer: 'windows-019-clean-build', rawArtifactPrefix: 'windows-019-raw',
  rawWorkflow: '.github/workflows/windows-019-raw-installer.yml',
  productionWorkflow: '.github/workflows/windows-019-production.yml',
  outgoingWorkflow: '.github/workflows/windows-outgoing-019.yml',
});
function getTarget() { return target; }
function pendingPinFields(value = module.exports.getTarget()) {
  const missing = [];
  const visit = (item, name) => {
    if (item === null) { if (name !== 'rootBuild') missing.push(name); return; }
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) visit(child, name ? name + '.' + key : key);
  };
  visit(value, '');
  return missing;
}
function requireQualificationPins(value = requireSource()) {
  if (value.version === '0.1.19') {
    const missing = pendingPinFields(value);
    assert.deepEqual(missing, [], 'Final qualification pins are pending: ' + missing.join(', '));
  }
  return value;
}
function requireSource() {
  const value = module.exports.getTarget();
  assert.ok((value.version === '0.1.18' && value.successor === '0.1.19')
    || (value.version === '0.1.19' && value.successor === '0.1.20'), 'Unreviewed Windows version pair');
  assert.ok(value.source && /^[a-f0-9]{40}$/.test(value.source.commit) && /^[a-f0-9]{40}$/.test(value.source.tree)
    && /^[a-f0-9]{40}$/.test(value.parent || ''), 'Final Windows source pins are pending; no signing, staging or qualification is authorized');
  if (value.version === '0.1.19') {
    assert.ok(!['930a2886b6872a08a4a25be4738a5a01a4e911d2', '3bed5cc1881cb6c85ef67abd493c68c2ffdb71b3'].includes(value.source.commit),
      'Published18 and superseded3bed sources cannot qualify the new hotfix');
    assert.equal(value.rootBuild, null); assert.equal(value.cleanBuild?.kind, 'windows-019-clean-postbuild-verification');
    assert.equal(value.localEvidenceRequired, true); assert.equal(value.splitNativeRoles, true);
  }
  return value;
}
function validDigest(value, name) {
  assert.ok(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && value !== '0'.repeat(64), `${name} pin is pending`);
}
function validateCleanBuildRecord(bytes, candidate, profile = requireSource()) {
  assert.equal(profile.version, '0.1.19'); assert.equal(profile.rootBuild, null);
  const pin = profile.cleanBuild;
  assert.equal(pin?.kind, 'windows-019-clean-postbuild-verification');
  for (const name of ['receiptSha256', 'rawReceiptSha256', 'rawWrapperSha256', 'inputSha256', 'sourceReceiptSha256',
    'installerSha256', 'executableSha256', 'setupExecutableSha256', 'manifestSha256', 'runtimeSha256']) validDigest(pin[name], name);
  const hash = b => crypto.createHash('sha256').update(b).digest('hex');
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 4 * 1024 * 1024);
  assert.equal(hash(bytes), pin.receiptSha256, 'Exact reviewed clean postbuild bytes required');
  const result = JSON.parse(bytes);
  assert.deepEqual(Object.keys(result).sort(), ['schemaVersion', 'kind', 'version', 'status', 'error', 'sourceCommit', 'sourceTree',
    'sourceUnchanged', 'changed', 'output', 'rawBuildResult', 'rawSignal', 'rawWrapperSha256', 'buildInputsSha256',
    'sourceReceiptSha256', 'installerSha256', 'executableSha256', 'setupExecutableSha256', 'managedManifestSha256',
    'runtimeDescriptorSha256', 'moduleFilesChecked', 'rootPe', 'verification', 'outerSignaturesGenerated', 'nativeAccepted',
    'published', 'releaseReady'].sort());
  assert.equal(result.schemaVersion, 1); assert.equal(result.kind, pin.kind); assert.equal(result.version, profile.version);
  assert.equal(result.status, 0); assert.equal(result.error, null); assert.equal(result.sourceUnchanged, true); assert.deepEqual(result.changed, []);
  for (const key of ['sourceCommit', 'sourceTree', 'installerSha256', 'executableSha256']) assert.equal(result[key], candidate[key], key);
  assert.equal(result.sourceCommit, profile.source.commit); assert.equal(result.sourceTree, profile.source.tree);
  for (const [field, key] of Object.entries({ rawWrapperSha256: 'rawWrapperSha256', buildInputsSha256: 'inputSha256',
    sourceReceiptSha256: 'sourceReceiptSha256', installerSha256: 'installerSha256', executableSha256: 'executableSha256',
    setupExecutableSha256: 'setupExecutableSha256', managedManifestSha256: 'manifestSha256', runtimeDescriptorSha256: 'runtimeSha256' })) assert.equal(result[field], pin[key], field);
  assert.equal(result.moduleFilesChecked, 15);
  assert.deepEqual(result.rootPe, { FileVersion: '0.1.19', ProductVersion: '0.1.19' });
  assert.deepEqual(result.verification, { installedResourcesVerified: true, managedSignaturesVerified: true,
    tamperRejected: true, installerExtractionVerified: true });
  for (const key of ['outerSignaturesGenerated', 'nativeAccepted', 'published', 'releaseReady']) assert.equal(result[key], false, key);
  const original = result.rawBuildResult;
  assert.deepEqual(Object.keys(original).sort(), ['base64', 'sha256', 'size']);
  assert.ok(Number.isSafeInteger(original.size) && original.size > 0 && original.size <= 1024 * 1024);
  assert.equal(original.sha256, pin.rawReceiptSha256); assert.ok(typeof original.base64 === 'string' && original.base64.length <= 1400000);
  const rawBytes = Buffer.from(original.base64, 'base64');
  assert.equal(rawBytes.toString('base64'), original.base64); assert.equal(rawBytes.length, original.size); assert.equal(hash(rawBytes), original.sha256);
  const raw = JSON.parse(rawBytes);
  assert.equal(raw.schemaVersion, 1); assert.equal(raw.version, '0.1.19'); assert.equal(raw.status, 0);
  assert.equal(raw.kind, 'windows-019-clean-build', 'Exact native clean-build record kind required');
  assert.equal(raw.error, null); assert.equal(raw.phase, 'signed-build'); assert.equal(raw.sourceUnchanged, true); assert.deepEqual(raw.changed, []);
  assert.equal(Object.hasOwn(raw, 'signal'), true, 'Native clean-build record must retain its explicit signal field');
  assert.equal(raw.signal, null, 'Native clean-build signal must be exactly null');
  assert.deepEqual(result.rawSignal, { present: true, value: null });
  for (const key of ['sourceCommit', 'sourceTree', 'installerSha256', 'executableSha256', 'output']) assert.equal(raw[key], result[key], key);
  assert.ok(path.win32.isAbsolute(result.output));
  assert.equal(raw.published, false); assert.equal(raw.releaseReady, false);
  return result;
}
function validateBuildRecord(bytes, candidate, originalBytes) {
  const profile = requireSource(), pin = profile.rootBuild;
  if (profile.cleanBuild) return validateCleanBuildRecord(bytes, candidate, profile);
  const hash = b => crypto.createHash('sha256').update(b).digest('hex');
  const result = JSON.parse(bytes);
  assert.equal(result.status, 0);
  for (const key of ['sourceCommit', 'sourceTree', 'installerSha256', 'executableSha256'])
    assert.equal(result[key], candidate[key], `Build result ${key}`);
  if (!pin) {
    assert.equal(result.sourceUnchanged, true); assert.deepEqual(result.changed, []);
    return result;
  }
  assert.equal(hash(bytes), pin.receiptSha256, 'Exact verified R8 post-build receipt required');
  assert.equal(result.kind, pin.kind);
  assert.ok(Buffer.isBuffer(originalBytes), 'Original failed build receipt must remain attached');
  assert.equal(hash(originalBytes), pin.originalSha256);
  const original = JSON.parse(originalBytes);
  assert.equal(original.status, 1); assert.equal(original.phase, 'root-tauri-nsis');
  assert.equal(original.error, 'Nonregular or oversized input');
  assert.equal(result.originalBuildResult.status, 1); assert.equal(result.originalBuildResult.sha256, pin.originalSha256);
  for (const record of [result, original]) {
    assert.equal(record.sourceCommit, profile.source.commit); assert.equal(record.sourceTree, profile.source.tree);
    assert.equal(record.reusedSourceCommit, pin.reusedSourceCommit); assert.equal(record.reusedSourceTree, pin.reusedSourceTree);
    assert.equal(record.rawSourceUnchanged, false); assert.deepEqual(record.rawSourceChanges, pin.generatedSchemas);
    assert.deepEqual(record.generatedSchemaChanges, pin.generatedSchemas);
    for (const key of ['compilerInputsUnchanged', 'frozenSourceUnchanged', 'reusedR7InputsUnchanged']) assert.equal(record[key], true);
    for (const key of ['managedSignaturesRegenerated', 'outerSignaturesGenerated', 'nativeGuiAccepted', 'migrationAccepted',
      'signedUpdateAccepted', 'published', 'releaseReady']) assert.equal(record[key], false);
    assert.equal(record.inputInventorySha256, pin.inputSha256); assert.equal(record.afterInventorySha256, pin.afterSha256);
    assert.equal(record.sourceReceipt.sha256, pin.sourceReceiptSha256);
  }
  assert.equal(result.installerSha256, pin.installerSha256); assert.equal(result.executableSha256, pin.executableSha256);
  assert.equal(result.managedManifestSha256, pin.manifestSha256); assert.equal(result.runtimeDescriptorSha256, pin.runtimeSha256);
  assert.equal(result.moduleFilesChecked, 15);
  assert.deepEqual(result.rootPe, { FileVersion: profile.version, ProductVersion: profile.version });
  assert.ok([0, 10].includes(result.installerPreflight.exitCode));
  return result;
}
function validateCleanBuildInputs(bytes, candidate, inputBytes, sourceBytes) {
  const profile = requireSource(), result = validateCleanBuildRecord(bytes, candidate, profile);
  const hash = b => crypto.createHash('sha256').update(b).digest('hex');
  for (const [body, expected] of [[inputBytes, result.buildInputsSha256], [sourceBytes, result.sourceReceiptSha256]]) {
    assert.ok(Buffer.isBuffer(body) && body.length > 0 && body.length <= 4 * 1024 * 1024);
    assert.equal(hash(body), expected, 'Exact R2 input inventory/source receipt required');
  }
  const source = JSON.parse(sourceBytes);
  assert.equal(source.commit, result.sourceCommit); assert.equal(source.tree, result.sourceTree);
  assert.equal(source.base, profile.parent); assert.equal(source.version, profile.version);
  const inputs = JSON.parse(inputBytes);
  assert.ok(Array.isArray(inputs) && inputs.length > 0 && inputs.length <= 10000);
  assert.equal(new Set(inputs.map(row => row.path)).size, inputs.length);
  for (const row of inputs) {
    assert.deepEqual(Object.keys(row).sort(), ['path', 'sha256']); validDigest(row.sha256, row.path);
    assert.ok(typeof row.path === 'string' && !/[\x00-\x1f\x7f\\:]/.test(row.path)
      && !row.path.startsWith('/') && !row.path.split('/').some(part => !part || part === '.' || part === '..'));
  }
  for (const row of source.inputs) assert.equal(inputs.find(input => input.path === row.path)?.sha256, row.sha256);
  return result;
}
function validateCleanBuildProvenance(record, bytes, candidate) {
  const result = validateCleanBuildRecord(bytes, candidate);
  assert.deepEqual(record, JSON.parse(Buffer.from(result.rawBuildResult.base64, 'base64')),
    'Native evidence must retain the original raw build receipt, not relabel the postbuild verification');
  return result.rawBuildResult.sha256;
}
function validatePrivateMigrationLimitation(value) {
  assert.deepEqual(value, requireSource().privateMigrationLimitation,
    'The retained private blocked migration must remain explicitly unresolved, not accepted or cleared');
}
function validateRootOnlyProjection(value, bytes, originalBytes, candidate) {
  const result = validateBuildRecord(bytes, candidate, originalBytes);
  const names = ['kind', 'sourceCommit', 'sourceTree', 'reusedSourceCommit', 'reusedSourceTree', 'rawSourceUnchanged',
    'rawSourceChanges', 'generatedSchemaChanges', 'compilerInputsUnchanged', 'frozenSourceUnchanged', 'reusedR7InputsUnchanged',
    'sourceReceipt', 'inputInventorySha256', 'afterInventorySha256', 'exception', 'aliases', 'verifierSha256', 'finalizerSha256'];
  const expected = Object.fromEntries(names.map(name => [name, result[name]]));
  expected.originalBuildResult = { ...result.originalBuildResult, receipt: JSON.parse(originalBytes) };
  assert.deepEqual(value, expected, 'Native evidence must retain the exact typed assembly and original failure');
}
module.exports = { getTarget, pendingPinFields, requireSource, requireQualificationPins, validateBuildRecord, validateCleanBuildRecord,
  validateCleanBuildInputs, validateCleanBuildProvenance, validatePrivateMigrationLimitation, validateRootOnlyProjection };
