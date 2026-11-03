'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const target = Object.freeze({
  version: '0.1.18', successor: '0.1.19', predecessor: '0.1.17', minimumHub: '0.1.12',
  source: Object.freeze({ commit: '930a2886b6872a08a4a25be4738a5a01a4e911d2', tree: 'a1af9bf6c56b221352f8b3feb1fd65259200e9dc' }),
  parent: '032bb101823fcfff1c5b85f863bb7381db8285e4',
  sourceCi: Object.freeze({ runId: 41718350946, runAttempt: 1, jobId: 126204194571,
    harnessCommit: 'e65a191a20265f0a5a7250d56543feb9fd1dbcbb', harnessTree: '27c81e4761c4080ca6b7ba541653f8d9b1a368cb',
    workflow: '.github/workflows/windows-final-mcp-tests.yml', workflowBlobSha: 'd91ee97c2a9ae2d0cd330a38d72100f62a05bd28',
    workflowSha256: '0b5361a4b0d549a3ca4cc2c6059e8a3158f3b5f86dc20b4bac3cedc1968f63fa', expectedTests: 316,
    artifactId: 13270513189, artifactName: 'windows-r8-mcp-npm-41718350946-1', artifactSize: 10422,
    artifactSha256: 'f4afd48cc818501b57695c64199ee1f2ea2bc878d05d6908868f3784633f66b5' }),
  rootBuild: Object.freeze({ kind: 'windows-018-root-only-postbuild-verification',
    receiptSha256: 'c83dec8051be90c7b1017b0cc2746e43f94a5ea5c8c9e326d99248fb5187dacb',
    originalSha256: 'f46805c6cdd4d34b0dd7ca84ae66b05839e38da59d2c94e01a7eced022f92fda',
    inputSha256: '913339fad522155b95449cd868a1fffc16a67e3a0a872ec57d1901906bd3aee9',
    afterSha256: 'c6e817565a5b463a6741eb59ef98564186a2052f0b7b44650fc70574d8b88ab6',
    sourceReceiptSha256: '417546ff9eb33c0dea923cb02b2b6657490316d0b403676d03f79a0f81424f1d',
    installerSha256: 'c09e3f73ca3e7fab74db2c204a17f6277d5b7817c650f090bd77af00a6f0f3f9',
    executableSha256: 'ae1d15ff3919ee9947e21d8542bcab50abf044e1bf047ce2c87abac4ccebfdc9',
    manifestSha256: 'f7666a38ccd3f4ad91e0de056dd32bdf52390229a6876b93ba0befaa4bf08327',
    runtimeSha256: 'c2c36c431df7b027a396035e981c29e762e26f7368edd40e36292c21a8d714a1',
    reusedSourceCommit: '032bb101823fcfff1c5b85f863bb7381db8285e4',
    reusedSourceTree: '6a1441ea078a1a35f1580ad91b83dd546dc2e536',
    generatedSchemas: Object.freeze(['modules/mcp/launcher/src-tauri/gen/schemas/acl-manifests.json',
      'modules/mcp/launcher/src-tauri/gen/schemas/desktop-schema.json', 'modules/mcp/launcher/src-tauri/gen/schemas/windows-schema.json']),
  }),
  runtime: Object.freeze({ baselineGeneration: '6e7bc066e10469680d0018d513c8acc20702822b93fec1232088080bd654faef',
    targetGeneration: 'c88438dd4e1fcc4400a8c4162915ddb40b6258224a3736d11fdb2a0b599e7b86',
    baselineModuleVersion: '2.7.7', targetModuleVersion: '2.7.8-fixture.19',
    verificationReceiptSha256: '4e2e33bb0eb31dc20182105e02a454cac50c93a5e847974889258357b990c00e' }),
  successorEvidence: Object.freeze({ sourceCommit: 'b6c806254746563e81a6715231d7ef6dfa081fc1', sourceTree: 'b5da014e744deab40788d745ca76c052dae28541',
    pins: Object.freeze({ descriptor: 'f52ae2750228e1572ec22530f2db599524753a6dd643075fe1cee4ad649539a0',
      descriptorSignature: '6254a3fd872aebdd14edb5ae4bf9f9749cecaec97fa1358d3d96aaf65ab1bcf0',
      installer: '32c73fdd3b8ee2858065b0c685101fc1475edbd9140f512d26ee4f9fc153a059',
      executable: 'a47ff32717e2d03bfe759f7f4eea358202c9ca8f9ca10947e7290b9f42021521',
      manifest: '5565dd74106b24ae75f0e605d93d6b4b21bc49d629189737d7548833dae26059' }) }),
  rootNative: Object.freeze({ receiptSha256: 'c016cb97bd9210319d6f011f68d9a428b129c78f648050469cd4fb3e22c31b42',
    logSha256: '284df0b6c6dc90c8308ce5b4ecc5a29a66286a17389735f4a092922f4a9ad196', passed: 523, ignored: 14 }),
  realCodex: Object.freeze({ receiptSha256: '58110ee00d048ef87a6225c18daa7f22a066b8d5e314e94de094cc012d7ed3c9',
    eventStreamSha256: '7b33d1871d2edaed33043fe07f2973b62b23a84f4e5dd314f55cdc622dcae8c8' }),
  localRestart: Object.freeze({ receiptSha256: '0c6008b25dca2a85a9792f5015d02217f9ae9299354d025cd2d93f8f41e83d9b',
    sdkReceiptSha256: '73546e71b452371b999cc434680950ace6889f26e9b937b88c7601f89b3c40f1' }),
  privateMigrationLimitation: Object.freeze({ scope: 'pre-existing-private-0.1.18-migration-record',
    status: 'unresolved', recordRetained: true, operationIdentity: 'unavailable',
    automaticRecovery: 'not verified', localMigrationAccepted: false }),
  splitNativeRoles: true,
  productionLanes: Object.freeze({
    incoming: Object.freeze({ runId: 41722515711, runAttempt: 1,
      sourceCommit: 'bd34535d3a28094635a4dce2632c9023194a5f23', sourceTree: '53ab93492c4962ef5e8b5a7bd40403388c8eebfc' }),
    custom: Object.freeze({ runId: 41725686118, runAttempt: 1,
      sourceCommit: 'e4459b067113beabfeff2c212caa40fc9d7015f0', sourceTree: 'e135b03b86dd0d2a317842e9e8b21847ae125836' }),
    standard: Object.freeze({ runId: 41725686118, runAttempt: 1,
      sourceCommit: 'e4459b067113beabfeff2c212caa40fc9d7015f0', sourceTree: 'e135b03b86dd0d2a317842e9e8b21847ae125836' }),
    outgoing: Object.freeze({ runId: 41729457407, runAttempt: 1,
      sourceCommit: '150c7c1349d55eab031bb08d6b80abb421b1b68a', sourceTree: '3a6f897301965bc09abb2eeedf03b8516fe815a0' }),
  }),
  qualificationKind: 'windows-018-qualified-draft', rawKind: 'windows-018-raw-installer-qualification',
  signingKind: 'windows-018-canonical-signing-preparation', signedKind: 'windows-018-signed-files-verified',
  draftKind: 'windows-018-private-signed-draft', outgoingKind: 'direct-outgoing-018-019',
  rawProducer: 'local-r8-root-only-assembly', rawArtifactPrefix: 'windows-r5-raw',
  rawWorkflow: '.github/workflows/windows-r5-raw-installer.yml',
  productionWorkflow: '.github/workflows/windows-017-production.yml',
  outgoingWorkflow: '.github/workflows/windows-outgoing-018.yml',
});
function getTarget() { return target; }
function requireSource() {
  const value = module.exports.getTarget();
  assert.equal(value.version, '0.1.18'); assert.equal(value.successor, '0.1.19');
  assert.ok(value.source && /^[a-f0-9]{40}$/.test(value.source.commit) && /^[a-f0-9]{40}$/.test(value.source.tree)
    && /^[a-f0-9]{40}$/.test(value.parent || ''), 'Final Windows source pins are pending; no signing, staging or qualification is authorized');
  return value;
}
function validateBuildRecord(bytes, candidate, originalBytes) {
  const profile = requireSource(), pin = profile.rootBuild;
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
module.exports = { getTarget, requireSource, validateBuildRecord, validatePrivateMigrationLimitation, validateRootOnlyProjection };
