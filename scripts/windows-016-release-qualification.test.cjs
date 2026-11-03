'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('./fixtures/windows-release-target.cjs').install();
const q = require('./windows-016-release-qualification.cjs');
const { publishDraft } = require('./publish-hub-draft.cjs');
const base = process.env.CREATOR_HUB_R2_EVIDENCE_ROOT || '';
const files = { fresh: 'fresh-r2-41446266226/native-suite-1793623147381/fresh-016-report.json',
  guarded: 'guarded-r2-41446279999/native-016-guarded-1793623148124/guarded-016-report.json',
  migration: 'migration-r2-41446636278/native-suite-1793623320498/migration-016-report.json',
  incoming014: 'incoming-r2-41448362951/native-suite-1793624081427/self-update-report.json',
  incoming012: 'signed012-passed-41452543111/native-suite-1793625878994/self-update-report.json' };
test('five retained R2 reports match exact bytes and scoped outcome', { skip: !fs.existsSync(base) }, () => {
  for (const [role, name] of Object.entries(files)) {
    const bytes = fs.readFileSync(path.join(base, name)); q.checkKnownReport(role, bytes);
    const changed = Buffer.from(bytes); changed[0] ^= 1;
    assert.throws(() => q.checkKnownReport(role, changed), /bytes differ/);
    for (const other of Object.keys(files).filter(name => name !== role)) assert.throws(() => q.checkKnownReport(other, bytes));
  }
});
test('existing test-only signed bytes verify only as test evidence', { skip: !fs.existsSync(base) }, () => {
  const dir = path.resolve(base, '../windows-r2-compat012-signer-draft-20261102/TEST-ONLY-compat012-attempt/TEST-ONLY-output');
  const input = { descriptor: fs.readFileSync(path.join(dir, 'creator-hub-windows-x86_64.json')),
    descriptorSignature: fs.readFileSync(path.join(dir, 'creator-hub-windows-x86_64.json.minisig')),
    installer: fs.readFileSync(path.join(dir, 'Creator.Hub_0.1.16_x64-setup.exe')),
    installerSignature: fs.readFileSync(path.join(dir, 'Creator.Hub_0.1.16_x64-setup.exe.sig')),
    latest: fs.readFileSync(path.join(dir, 'latest.json')) };
  assert.equal(q.checkTestOnlyPayload(input).testOnlyDescriptorVerified, true);
  assert.throws(() => q.checkTestOnlyPayload({ ...input, descriptorSignature: Buffer.from('wrong') }));
  assert.throws(() => q.checkTestOnlyPayload({ ...input, installerSignature: Buffer.from('wrong') }));
  assert.throws(() => q.checkTestOnlyPayload({ ...input, latest: Buffer.from('{}') }));
});
test('candidate draft identity and every exact metadata pin reject drift and validation drafts', () => {
  const assets = Object.fromEntries(q.ASSETS.map((name, index) => [name, { id: 100 + index, size: 100, sha256: 'a'.repeat(64) }]));
  assets[q.ASSETS[0]] = { ...assets[q.ASSETS[0]], size: 38213208, sha256: q.R2.installer };
  assets['creator-hub-windows-x86_64.json'].sha256 = '818bcb983490e20ade5816b4dbb2f5ea98bcaa33484faefa7b9747d12d64b788';
  const pin = { id: 111111, assets }, draft = { id: pin.id, tag_name: 'v0.1.16', draft: true, prerelease: false,
    assets: Object.entries(assets).map(([name, p]) => ({ name, id: p.id, size: p.size, digest: `sha256:${p.sha256}`, state: 'uploaded' })) };
  assert.equal(q.checkDraftMetadata(draft, pin).releaseReady, false);
  assert.throws(() => q.checkDraftMetadata({ ...draft, draft: false }, pin));
  assert.throws(() => q.checkDraftMetadata({ ...draft, assets: draft.assets.slice(1) }, pin));
  assert.throws(() => q.checkDraftMetadata({ ...draft, assets: draft.assets.map((a, i) => i ? a : { ...a, size: 1 }) }, pin));
  assert.throws(() => q.checkDraftMetadata({ ...draft, id: 424919952 }, { ...pin, id: 424919952 }));
});
test('release asset downloads request bytes, while API metadata remains JSON', () => {
  assert.deepEqual(q.ghApiArgs('releases/assets/705082981', true), ['api', '-H', 'Accept:application/octet-stream', 'repos/BOBWORKS-XR/CREATOR-HUB/releases/assets/705082981']);
  assert.deepEqual(q.ghApiArgs('releases/432509311', false), ['api', 'repos/BOBWORKS-XR/CREATOR-HUB/releases/432509311']);
  assert.deepEqual(q.ghApiArgs('actions/artifacts/1/zip', true), ['api', 'repos/BOBWORKS-XR/CREATOR-HUB/actions/artifacts/1/zip']);
  assert.throws(() => q.ghApiArgs('user', false));
});
test('observed draft refuses altered identity or target before downloading', async () => {
  const p = q.OBSERVED_DRAFT;
  const draft = { id: p.id, tag_name: 'v0.1.16', draft: true, prerelease: false, target_commitish: p.source,
    assets: Object.entries(p.assets).map(([name, value]) => ({ name, id: value.id, size: value.size, digest: `sha256:${value.sha256}`, state: 'uploaded' })) };
  for (const changed of [{ ...draft, draft: false }, { ...draft, target_commitish: '0'.repeat(40) },
    { ...draft, assets: draft.assets.slice(1) }, { ...draft, assets: draft.assets.map((a, i) => i ? a : { ...a, id: 1 }) }]) {
    let downloads = 0;
    await assert.rejects(q.verifyObservedDraft({ request: async () => changed, download: async () => { downloads++; return Buffer.alloc(0); } }));
    assert.equal(downloads, 0);
  }
  assert.throws(() => q.loadQualification('DO-NOT-READ', '0'.repeat(64)), /qualification blocked/);
  await assert.rejects(q.verifyRemote(), /qualification blocked/);
});
test('observed draft checks all local fixture bytes without asserting approval', { skip: !fs.existsSync(path.join(__dirname, '../local-r2-reuse-stage-20261103/assets')) }, async () => {
  const p = q.OBSERVED_DRAFT, dir = path.join(__dirname, '../local-r2-reuse-stage-20261103/assets');
  const draft = { id: p.id, tag_name: 'v0.1.16', draft: true, prerelease: false, target_commitish: p.source,
    assets: Object.entries(p.assets).map(([name, value]) => ({ name, id: value.id, size: value.size, digest: `sha256:${value.sha256}`, state: 'uploaded' })) };
  const io = { request: async route => route.startsWith('releases/') ? draft : { sha: p.source, tree: { sha: p.tree } },
    download: async route => { const name = q.ASSETS.find(n => route.endsWith(`/${p.assets[n].id}`)); return fs.readFileSync(path.join(dir, name)); } };
  const result = await q.verifyObservedDraft(io);
  assert.equal(result.assetBytesVerified, true); assert.equal(result.signaturesVerified, true);
  for (const key of ['snapshotBuilt', 'reuseApprovalVerified', 'productionApproval', 'releaseReady']) assert.equal(result[key], false);
  const bad = { ...io, download: async route => { const bytes = await io.download(route); bytes[0] ^= 1; return bytes; } };
  await assert.rejects(q.verifyObservedDraft(bad));
  await assert.rejects(q.verifyObservedDraft({ ...io, request: async route => route.startsWith('releases/') ? draft : { sha: p.source, tree: { sha: '0'.repeat(40) } } }));
});
test('production pin review binds all assets and rejects unreviewed or test-only pins', () => {
  const assets = Object.fromEntries(q.ASSETS.map((name, i) => [name, { id: 200 + i, size: 100, sha256: 'a'.repeat(64) }]));
  assets[q.ASSETS[0]] = { ...assets[q.ASSETS[0]], size: 38213208, sha256: q.R2.installer };
  assets['creator-hub-windows-x86_64.json'].sha256 = '818bcb983490e20ade5816b4dbb2f5ea98bcaa33484faefa7b9747d12d64b788';
  const pin = { kind: 'windows-016-production-draft-pins', id: 111111, assets };
  const hash = p => crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex');
  assert.equal(q.checkProductionPins(pin, hash(pin)).productionPinsMatched, true);
  assert.throws(() => q.checkProductionPins(pin, 'a'.repeat(64)), /reviewed production pins differ/);
  for (const [name, value] of [['creator-hub-windows-x86_64.json.minisig', 'c8cc58a35b6b8f8461e078110cbd72462566b19974ac13c547ca80edf5f860da'],
    ['latest.json', '986745ff133fbd8a4d4c5dc3de17cecafbc500e4af06badb323bf3a632476eea']]) {
    const altered = structuredClone(pin); altered.assets[name].sha256 = value;
    assert.throws(() => q.checkProductionPins(altered, hash(altered)), /Test-only/);
  }
});
test('separately pinned production readback verifies all bytes with mocked cryptography', { skip: !fs.existsSync(base) }, async () => {
  const vm = require('node:vm'), { createRequire } = require('node:module');
  const filename = path.join(__dirname, 'windows-016-release-qualification.cjs'), localRequire = createRequire(filename);
  const realVerifier = localRequire('./linux-016-release-qualification.cjs').verifySignature;
  const signerCalls = [];
  const fakeRequire = name => name === './linux-016-release-qualification.cjs' ? { verifySignature: (body, signature) => {
    signerCalls.push(signature.toString('utf8').startsWith('untrusted comment: independent fixture'));
    if (!signerCalls.at(-1)) realVerifier(body, signature);
  } } : localRequire(name);
  const module = { exports: {} };
  const fn = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
  fn(fakeRequire, module, module.exports, filename, __dirname);
  const draftCheck = module.exports;
  const dir = path.resolve(base, '../windows-r2-compat012-signer-draft-20261102/TEST-ONLY-compat012-attempt/TEST-ONLY-output');
  const bodies = Object.fromEntries(q.ASSETS.filter(name => name !== 'SHA256SUMS.txt').map(name => [name, fs.readFileSync(path.join(dir, name))]));
  bodies['creator-hub-windows-x86_64.json.minisig'] = Buffer.from('untrusted comment: independent fixture\nmock\ntrusted comment: mock\nmock\n');
  bodies['latest.json'] = Buffer.from(JSON.stringify({ ...JSON.parse(bodies['latest.json']), notes: 'Independently reviewed production fixture' }));
  const hash = b => crypto.createHash('sha256').update(b).digest('hex');
  bodies['SHA256SUMS.txt'] = Buffer.from(Object.keys(bodies).sort().map(name => `${hash(bodies[name])}  ${name}\n`).join(''));
  const assets = Object.fromEntries(q.ASSETS.map((name, i) => [name, { id: 200 + i, size: bodies[name].length, sha256: hash(bodies[name]) }]));
  const pin = { kind: 'windows-016-production-draft-pins', id: 111111, assets };
  const review = hash(Buffer.from(JSON.stringify(pin)));
  const draft = { id: pin.id, tag_name: 'v0.1.16', draft: true, prerelease: false,
    assets: Object.entries(assets).map(([name, p]) => ({ name, id: p.id, size: p.size, digest: `sha256:${p.sha256}`, state: 'uploaded' })) };
  let reads = 0; const io = { request: async () => { reads++; return draft; }, download: async route => {
    const id = Number(route.split('/').at(-1)), name = q.ASSETS.find(n => assets[n].id === id); return bodies[name]; } };
  const result = await draftCheck.checkDraftReadback(pin, review, io);
  assert.equal(result.signaturesVerified, true); assert.equal(result.productionApproval, false); assert.equal(reads, 2);
  assert.deepEqual(signerCalls, [true, false]);
  const testManifest = Buffer.from(JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'))), null, 4));
  const changedPin = structuredClone(pin); changedPin.assets['latest.json'] = { ...changedPin.assets['latest.json'], size: testManifest.length, sha256: hash(testManifest) };
  const input = { descriptor: bodies['creator-hub-windows-x86_64.json'], descriptorSignature: bodies['creator-hub-windows-x86_64.json.minisig'],
    installer: bodies[q.ASSETS[0]], installerSignature: bodies[q.ASSETS[1]], latest: testManifest };
  assert.throws(() => draftCheck.checkProductionPayload(input, changedPin, hash(Buffer.from(JSON.stringify(changedPin)))), /Test-only manifest/);
  const badSig = Buffer.concat([Buffer.from(' '), bodies[q.ASSETS[1]]]), badPin = structuredClone(pin);
  badPin.assets[q.ASSETS[1]] = { ...badPin.assets[q.ASSETS[1]], size: badSig.length, sha256: hash(badSig) };
  assert.throws(() => draftCheck.checkProductionPayload({ ...input, latest: bodies['latest.json'], installerSignature: badSig }, badPin,
    hash(Buffer.from(JSON.stringify(badPin)))), /Standalone signature differs/);
  await assert.rejects(draftCheck.checkDraftReadback(pin, 'f'.repeat(64), io), /reviewed production pins differ/);
  const bad = { ...bodies, 'SHA256SUMS.txt': Buffer.from('not checksums') };
  assert.throws(() => draftCheck.checkDraftBytes(pin, review, bad));
  const drift = { ...io, request: async () => ({ ...draft, draft: false }) };
  await assert.rejects(draftCheck.checkDraftReadback(pin, review, drift));
});
test('test-only signed bytes cannot be relabeled as production draft metadata', { skip: !fs.existsSync(base) }, async () => {
  const dir = path.resolve(base, '../windows-r2-compat012-signer-draft-20261102/TEST-ONLY-compat012-attempt/TEST-ONLY-output');
  const bodies = Object.fromEntries(q.ASSETS.filter(name => name !== 'SHA256SUMS.txt').map(name => [name, fs.readFileSync(path.join(dir, name))]));
  const hash = b => crypto.createHash('sha256').update(b).digest('hex');
  bodies['SHA256SUMS.txt'] = Buffer.from(Object.keys(bodies).sort().map(name => `${hash(bodies[name])}  ${name}\n`).join(''));
  const assets = Object.fromEntries(q.ASSETS.map((name, i) => [name, { id: 200 + i, size: bodies[name].length, sha256: hash(bodies[name]) }]));
  const pin = { kind: 'windows-016-production-draft-pins', id: 111111, assets };
  const reviewHash = value => hash(Buffer.from(JSON.stringify(value)));
  let touched = false;
  await assert.rejects(q.checkDraftReadback(pin, reviewHash(pin), { request: async () => { touched = true; }, download: async () => { touched = true; } }), /Test-only/);
  assert.equal(touched, false);
  const altered = { ...bodies, 'creator-hub-windows-x86_64.json.minisig': Buffer.from(bodies['creator-hub-windows-x86_64.json.minisig'].toString().replace(/^untrusted comment: .*/, 'untrusted comment: changed')),
    'latest.json': Buffer.from(JSON.stringify({ ...JSON.parse(bodies['latest.json']), notes: 'Different production manifest' })) };
  const changedPin = structuredClone(pin);
  for (const name of ['creator-hub-windows-x86_64.json.minisig', 'latest.json']) {
    changedPin.assets[name].sha256 = hash(altered[name]); changedPin.assets[name].size = altered[name].length;
  }
  const input = { descriptor: altered['creator-hub-windows-x86_64.json'], descriptorSignature: altered['creator-hub-windows-x86_64.json.minisig'],
    installer: altered[q.ASSETS[0]], installerSignature: altered[q.ASSETS[1]], latest: altered['latest.json'] };
  assert.throws(() => q.checkProductionPayload(input, changedPin, reviewHash(changedPin)), /Test-only signature/);
  const sameManifest = { ...changedPin, assets: { ...changedPin.assets, 'latest.json': { ...changedPin.assets['latest.json'], sha256: hash(bodies['latest.json']), size: bodies['latest.json'].length } } };
  assert.throws(() => q.checkProductionPins(sameManifest, reviewHash(sameManifest)), /Test-only manifest/);
  touched = false;
  await assert.rejects(q.checkDraftReadback({ id: '../../unsafe' }, 'a'.repeat(64), { request: async () => { touched = true; }, download: async () => { touched = true; } }));
  assert.equal(touched, false);
});
test('explicit independently pinned reuse approval binds exact tested bytes and one production draft', { skip: !fs.existsSync(base) }, async () => {
  const dir = path.resolve(base, '../windows-r2-compat012-signer-draft-20261102/TEST-ONLY-compat012-attempt/TEST-ONLY-output');
  const hash = b => crypto.createHash('sha256').update(b).digest('hex');
  const bodies = Object.fromEntries(q.ASSETS.filter(name => name !== 'SHA256SUMS.txt').map(name => [name, fs.readFileSync(path.join(dir, name))]));
  bodies['SHA256SUMS.txt'] = Buffer.from(Object.keys(bodies).sort().map(name => `${hash(bodies[name])}  ${name}\n`).join(''));
  const assets = Object.fromEntries(q.ASSETS.map((name, i) => [name, { id: 500 + i, size: bodies[name].length, sha256: hash(bodies[name]) }]));
  const pin = { kind: 'windows-016-production-draft-pins', id: 222222, assets }, pinSha = hash(Buffer.from(JSON.stringify(pin)));
  const approval = { kind: 'windows-016-tested-metadata-reuse-approval', scope: 'production-draft-preflight-only',
    testRun: q.REUSE.testRun, testInputArtifact: q.REUSE.testInputArtifact, draftId: pin.id, productionPinsSha256: pinSha, assets: q.REUSE.assets };
  const wrap = value => { const bytes = Buffer.from(JSON.stringify(value)); return { bytes, sha256: hash(bytes) }; };
  const reuse = wrap(approval);
  assert.throws(() => q.checkProductionPins(pin, pinSha), /Test-only/);
  assert.equal(q.checkReuseApproval(reuse, pin, pinSha).productionApproval, false);
  const checked = q.checkDraftBytes(pin, pinSha, bodies, reuse);
  assert.equal(checked.signaturesVerified, true); assert.equal(checked.provenance, 'controlled-012-test-signed-bytes');
  assert.equal(checked.reuseApprovalSha256, reuse.sha256); assert.equal(checked.releaseReady, false);
  const draft = { id: pin.id, tag_name: 'v0.1.16', draft: true, prerelease: false,
    assets: Object.entries(assets).map(([name, p]) => ({ name, id: p.id, size: p.size, digest: `sha256:${p.sha256}`, state: 'uploaded' })) };
  let reads = 0; const io = { request: async () => { reads++; return draft; }, download: async route => bodies[q.ASSETS.find(name => assets[name].id === Number(route.split('/').at(-1)))] };
  assert.equal((await q.checkDraftReadback(pin, pinSha, io, reuse)).signaturesVerified, true); assert.equal(reads, 2);
  const receipt = { kind: 'windows-016-production-preflight', version: '0.1.16', platform: 'windows-x86_64',
    acceptance: 'not-established', diagnosticRun: q.DIAGNOSTIC.run, draft: pin, productionPinsSha256: pinSha };
  const receiptBytes = Buffer.from(JSON.stringify(receipt)), receiptSha = hash(receiptBytes);
  assert.throws(() => q.loadCandidateReceipt(receiptBytes, receiptSha), /Test-only/);
  assert.deepEqual(q.loadCandidateReceipt(receiptBytes, receiptSha, reuse), receipt);
  await assert.rejects(q.verifyCandidateRemote(receiptBytes, receiptSha, { request: async () => { throw Error('unexpected network'); },
    download: async () => { throw Error('unexpected network'); } }, { ...reuse, sha256: '0'.repeat(64) }));
  for (const change of [{ draftId: pin.id + 1 }, { productionPinsSha256: '0'.repeat(64) }, { testRun: 1 },
    { testInputArtifact: 1 }, { scope: 'production-approved' }, { assets: { ...approval.assets, 'latest.json': { ...approval.assets['latest.json'], sha256: '0'.repeat(64) } } }])
    assert.throws(() => q.checkReuseApproval(wrap({ ...approval, ...change }), pin, pinSha));
  assert.throws(() => q.checkReuseApproval({ ...reuse, sha256: '0'.repeat(64) }, pin, pinSha));
  for (const name of Object.keys(q.REUSE.assets)) {
    const altered = structuredClone(pin); altered.assets[name].sha256 = 'b'.repeat(64);
    const alteredSha = hash(Buffer.from(JSON.stringify(altered)));
    assert.throws(() => q.checkProductionPins(altered, alteredSha, wrap({ ...approval, productionPinsSha256: alteredSha })));
    const changed = { ...bodies, [name]: Buffer.from(bodies[name]) }; changed[name][0] ^= 1;
    assert.throws(() => q.checkDraftBytes(pin, pinSha, changed, reuse));
  }
  assert.throws(() => q.checkDraftBytes(pin, pinSha, { ...bodies, 'SHA256SUMS.txt': Buffer.from('wrong') }, reuse));
  const changedPin = structuredClone(pin); changedPin.assets['latest.json'].id++;
  const changedPinSha = hash(Buffer.from(JSON.stringify(changedPin)));
  assert.throws(() => q.checkProductionPins(changedPin, changedPinSha, reuse));
  assert.throws(() => q.loadQualification('DO-NOT-READ', reuse.sha256), /qualification blocked/);
  await assert.rejects(q.verifyRemote({ reuse }), /qualification blocked/);
});
test('unknown production assets and combined evidence refuse before receipt reads or remote calls', async () => {
  assert.throws(() => q.loadQualification('DO-NOT-READ', 'a'.repeat(64)), /production descriptor.*combined/);
  await assert.rejects(q.verifyRemote({}), /production descriptor.*combined/);
  let called = false;
  await assert.rejects(publishDraft('0.1.16', { publish: () => { called = true; }, checkDraft: () => { called = true; } },
    { platform: 'windows-x86_64', receipt: 'DO-NOT-READ', sha256: 'a'.repeat(64) }), /qualification blocked/);
  assert.equal(called, false);
});
test('candidate receipt requires independently reviewed exact pins and never authorizes publication', async () => {
  const hash = b => crypto.createHash('sha256').update(b).digest('hex');
  const assets = Object.fromEntries(q.ASSETS.map((name, i) => [name, { id: 300 + i, size: 100, sha256: 'a'.repeat(64) }]));
  assets[q.ASSETS[0]] = { ...assets[q.ASSETS[0]], size: 38213208, sha256: q.R2.installer };
  assets['creator-hub-windows-x86_64.json'].sha256 = '818bcb983490e20ade5816b4dbb2f5ea98bcaa33484faefa7b9747d12d64b788';
  const draft = { kind: 'windows-016-production-draft-pins', id: 111111, assets };
  const receipt = { kind: 'windows-016-production-preflight', version: '0.1.16', platform: 'windows-x86_64',
    acceptance: 'not-established', diagnosticRun: q.DIAGNOSTIC.run, draft, productionPinsSha256: hash(Buffer.from(JSON.stringify(draft))) };
  const bytes = Buffer.from(JSON.stringify(receipt)), digest = hash(bytes);
  assert.deepEqual(q.loadCandidateReceipt(bytes, digest), receipt);
  assert.throws(() => q.loadCandidateReceipt(bytes, '0'.repeat(64)), /receipt bytes differ/);
  for (const altered of [{ ...receipt, acceptance: 'accepted' }, { ...receipt, diagnosticRun: 1 },
    { ...receipt, productionPinsSha256: '0'.repeat(64) }, { ...receipt, releaseReady: true }]) {
    const value = Buffer.from(JSON.stringify(altered)); assert.throws(() => q.loadCandidateReceipt(value, hash(value)));
  }
  let called = false;
  await assert.rejects(q.verifyCandidateRemote(bytes, '0'.repeat(64), { request: async () => { called = true; }, download: async () => { called = true; } }));
  assert.equal(called, false);
  const paths = [];
  await assert.rejects(q.verifyCandidateRemote(bytes, digest, { request: async route => { paths.push(route); return {}; },
    download: async route => { paths.push(route); return Buffer.alloc(1); } }));
  assert.ok(paths.every(route => !route.startsWith('releases/')), 'Missing native proof must precede draft readback');
  assert.throws(() => q.loadQualification('DO-NOT-READ', digest), /qualification blocked/);
  await assert.rejects(q.verifyRemote(receipt), /qualification blocked/);
});
test('mixed diagnostic is bound as nonacceptance and refuses changed scope, route or cleanup', () => {
  const before = { schemaVersion: 1, descriptorSha256: '2bd6e4f9c80a051b9b4dd4c57a253a30d325136c6cd2605e81c603dad65fcb3d', generation: 'a'.repeat(64) };
  const after = { schemaVersion: 1, descriptorSha256: '1e53158ae6bffe842c7256c1b40a44d59c2d0a6d3f03b5506b1e5f17584d6fda', generation: 'a'.repeat(64) };
  const kind = 'mixed-public-migration-controlled-outgoing-diagnostic';
  const report = { kind, passed: true, sourceCommit: q.OUTGOING.targetSource, baseline: { version: '0.1.16', installer: q.R2.installer, exe: q.R2.executable }, pins: q.OUTGOING.successor,
    migratedContinuation: true, cancelPreserved: true, automaticRestart: true, outgoingConnectionSurvived: true, newConnectionVerified: true,
    migratedFixtureFilesUnchangedAfterDriverCleanup: true, activeRouteUnchangedAfterCancel: true, policyRestored: true,
    automaticRouteTransitionProven: false, changedMcpGenerationProven: false, migrationNetworkObserved: false, combinedAcceptance: false,
    nativeUpdateAccepted: false, liveAiAcceptance: false, releaseReady: false, migratedFixtureFilesChecked: 23,
    migrationRunId: String(q.DIAGNOSTIC.run), migrationRunAttempt: '1', migrationHarnessSource: q.DIAGNOSTIC.source,
    migrationReportSha256: q.DIAGNOSTIC.migration, beforeRoute: before, preReviewRoute: before, afterRoute: after,
    successorRouteAfterExplicitReview: after, successorRouteObservation: 'after-explicit-client-review' };
  const migration = { passed: true, releaseReady: false, scope: 'exact-direct16-three-client-clean-legacy-guide-probe' };
  const binding = { kind, diagnosticPassed: true, runId: String(q.DIAGNOSTIC.run), source: q.DIAGNOSTIC.source,
    reportSha256: q.DIAGNOSTIC.report, migrationReportSha256: q.DIAGNOSTIC.migration, lifecycleSha256: q.DIAGNOSTIC.lifecycle,
    preReviewRoute: before, successorRouteAfterExplicitReview: after, successorRouteObservation: 'after-explicit-client-review',
    migrationNetworkObserved: false, isolationProven: false, combinedAcceptance: false, automaticRouteTransitionProven: false,
    releaseReady: false, migrationNetworkObservation: 'unobserved', publicDiscovery: null };
  const life = { kind: 'lab-lifecycle-result', scenario: kind, actualScope: kind, lifecycleSucceeded: true, cleanupVerified: true,
    successorCleanupVerified: true, systemTlsVerified: true, outgoingControlledFeed: true, migrationNetworkObserved: false,
    isolationProven: false, combinedAcceptance: false, hubCleanupUnknown: false, releaseReady: false, hubCleanupState: 'verified',
    driverExitCode: 0, rejectedRequestCount: 0, servedRouteCount: 5 };
  const encode = row => Buffer.from(JSON.stringify(row));
  assert.deepEqual(q.checkDiagnosticContents(report, migration, binding, encode(life)),
    { diagnosticVerified: true, migrationNetworkObserved: false, combinedAcceptance: false, releaseReady: false });
  for (const change of [{ combinedAcceptance: true }, { automaticRouteTransitionProven: true }, { migrationNetworkObserved: true },
    { preReviewRoute: after }, { successorRouteObservation: 'automatic' }, { migrationRunId: '1' }])
    assert.throws(() => q.checkDiagnosticContents({ ...report, ...change }, migration, binding, encode(life)));
  for (const change of [{ cleanupVerified: false }, { hubCleanupUnknown: true }, { rejectedRequestCount: 1 }])
    assert.throws(() => q.checkDiagnosticContents(report, migration, binding, encode({ ...life, ...change })));
  assert.throws(() => q.checkDiagnosticContents(report, migration, { ...binding, combinedAcceptance: true }, encode(life)));
  assert.throws(() => q.checkDiagnosticRemote({ id: 1 }, {}, {}, {}, Buffer.alloc(0)));
});
test('all three retained outgoing cases bind exact reports, cleanup and acceptance-only scope', { skip: !fs.existsSync(base) }, () => {
  for (const name of Object.keys(q.OUTGOING.cases)) {
    const dir = path.join(base, `outgoing-r2-${name}-41458205828`), suite = fs.readdirSync(dir).find(s => /^native-suite-\d+$/.test(s));
    assert.ok(suite);
    const report = fs.readFileSync(path.join(dir, suite, 'outgoing-report.json'));
    const lifecycle = fs.readFileSync(path.join(dir, 'outgoing-017-control/lifecycle.jsonl'));
    const binding = fs.readFileSync(path.join(dir, 'outgoing-017-control/acceptance-binding.json'));
    const result = q.checkOutgoingCase(name, report, lifecycle, binding);
    assert.equal(result.combinedMigrationProven, false); assert.equal(result.changedGenerationProven, false);
    const changed = Buffer.from(report); changed[0] ^= 1;
    assert.throws(() => q.checkOutgoingCase(name, changed, lifecycle, binding));
    for (const other of Object.keys(q.OUTGOING.cases).filter(item => item !== name)) assert.throws(() => q.checkOutgoingCase(other, report, lifecycle, binding));
  }
});
test('known proof rejects wrong original run or archive before decoding', () => {
  const p = q.KNOWN.fresh, repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' };
  const run = { id: p.run, run_attempt: 1, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', head_sha: p.source,
    path: '.github/workflows/windows-incoming-016.yml', head_branch: 'validation/windows-menu-merge-20261027', repository: repo, head_repository: repo };
  const artifact = { id: p.artifact, expired: false, size_in_bytes: p.size, digest: `sha256:${p.archive}`, workflow_run: { id: p.run, head_sha: p.source } };
  let inspected = false; const inspect = () => { inspected = true; return {}; };
  assert.throws(() => q.checkKnownProof('fresh', { ...run, head_sha: '0'.repeat(40) }, artifact, Buffer.alloc(1), 'report.json', Buffer.alloc(1), inspect));
  assert.throws(() => q.checkKnownProof('fresh', run, artifact, Buffer.alloc(1), 'report.json', Buffer.alloc(1), inspect));
  assert.equal(inspected, false);
});
test('only independently pinned evidence commit trees are accepted', () => {
  for (const [source, tree] of Object.entries(q.SOURCE_TREES)) {
    q.checkCommitTree(source, { sha: source, tree: { sha: tree } });
    assert.throws(() => q.checkCommitTree(source, { sha: source, tree: { sha: '0'.repeat(40) } }), /source tree differs/);
  }
  assert.throws(() => q.checkCommitTree('0'.repeat(40), { sha: '0'.repeat(40), tree: {} }));
});
function incomingDiagnosticFixture() {
  const p = q.INCOMING_DIAGNOSTIC;
  const binding = { artifactSource: '96ed287c4c7aa56dc6594838d37a63cd0d7d5adf', harnessSource: p.source,
    archiveSha256: '618ca22a26b52b5cf7a95b75b60e15ceec39a2f436c58cc7ba2ccc8c6744ee6a', runId: 41450817062, artifactId: 13144622811 };
  const migration = { testSource: p.source, passed: true, installerSha256: q.R2.installer, executableSha256: q.R2.executable,
    productSource: `source-receipt-sha256:${q.R2.sourceReceipt}`, sourceSnapshotBuilt: false, buildInputDigest: q.R2.inventory,
    nativeGuideAccepted: true, cancelAccepted: true, repeatStartupAccepted: true, settingsPreserved: true, policyRestored: true, installedResourcesVerified: true,
    migrationAccepted: false, signedUpdateAccepted: false, liveAiAppAccepted: false, crashRecoveryAccepted: false,
    backupBeforeEveryWriteAccepted: false, releaseReady: false, userMachineUsed: false, inputBinding: binding,
    baselines: [{ product: 'Creator Hub', version: '0.1.12', executableSha256: '34c6f05548f469ac23b4faee7aa8355d5cca083c444c4f7b0942426a9c76a7ac' },
      { product: 'Creator Works MCP', version: '2.7.7', executableSha256: '765ad40681c9ad69f2748ce5e9873b59971488acdd3f826e90946af835e36af9' },
      { product: 'Creator Project Setup', version: '0.3.7', executableSha256: '74653db61681e29a18a308c393e1b8790a86a7ed674ca6abe73f35da0a0f4ed6' }],
    incomingDiagnostic: { signedUpdateObserved: true, normalCloseObserved: true, labCleanupObserved: true, processTransfer: false,
      migrationNetworkObserved: false, migrationIsolationProven: false, publicDiscovery: false, migrationProven: false, releaseReady: false } };
  const update = { harnessSource: p.source, passed: true, selfUpdateTested: true,
    from: { version: '0.1.12', installer: '0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18', exe: '34c6f05548f469ac23b4faee7aa8355d5cca083c444c4f7b0942426a9c76a7ac' },
    to: { version: '0.1.16', installer: q.R2.installer, exe: q.R2.executable }, testOnlyDescriptor: true, labDiscovery: true,
    migrationDeferred: true, policyRestored: true, publicDiscovery: false, nativeAcceptance: false, releaseReady: false, userMachineUsed: false,
    managedRouteReconnectTested: false, feed: { pins: { descriptor: '818bcb983490e20ade5816b4dbb2f5ea98bcaa33484faefa7b9747d12d64b788',
      descriptorSignature: 'c8cc58a35b6b8f8461e078110cbd72462566b19974ac13c547ca80edf5f860da',
      manifest: '986745ff133fbd8a4d4c5dc3de17cecafbc500e4af06badb323bf3a632476eea', installer: q.R2.installer, executable: q.R2.executable } },
    directServices: { mcp: { state: 'saved-settings-conflict-locked', serviceCallTested: false, reviewApproved: false } }, originalExitCode: 0,
    restartedPid: 42, restartedClose: { kind: 'incoming-migration-owned-close-only', state: 'verified', pid: 42, exitCode: 0, startTicks: '123',
      releaseReady: false, migrationContinuationAvailable: false },
    observedRestart: { restartedPid: 42, restartedStartTicks: '123', ancestryProven: false, securityAttestation: false } };
  const lifecycle = { kind: 'lab-lifecycle-result', lifecycleSucceeded: true, cleanupVerified: true, systemTlsVerified: true,
    driverRegistered: true, driverGateOpened: true, hubCleanupUnknown: false, publicDiscovery: false, productAcceptance: false,
    liveAiAcceptance: false, nativeAcceptanceTested: false, releaseReady: false, hubCleanupState: 'verified', driverExitCode: 0, servedRouteCount: 7,
    scenario: 'public-stable', actualScope: 'unmodified-public-0.1.12-lab-only', failureDetails: null, processIdentityFailure: null,
    rejectedRequestCount: 0, syntheticDiscovery: { mcp: 1, setup: 1 } };
  const fixture = { source: p.source, runId: String(p.run), runAttempt: '1', fixtureRoot: 'D:\\artifacts\\native-suite-1793698471073',
    files: Array.from({ length: 17 }, (_, i) => ({ path: `fixture-${i}`, size: 1, sha256: 'a'.repeat(64) })) };
  return { migration, update, lifecycle, fixture, binding };
}
test('incoming diagnostic rejects altered claims, cleanup, route pins and fixture metadata', () => {
  const verify = x => q.checkIncomingDiagnosticContents(x.migration, x.update, Buffer.from(JSON.stringify(x.lifecycle)), x.fixture, x.binding);
  const good = incomingDiagnosticFixture();
  assert.deepEqual(verify(good), { incomingDiagnosticVerified: true, controlledFeed: true, syntheticDiscovery: true,
    migrationNetworkObserved: false, migrationIsolationProven: false, processAncestryProven: false,
    combinedAcceptance: false, productionApproval: false, releaseReady: false });
  for (const change of [x => { x.migration.testSource = '0'.repeat(40); }, x => { x.migration.incomingDiagnostic.migrationNetworkObserved = true; },
    x => { x.migration.migrationAccepted = true; }, x => { x.migration.sourceSnapshotBuilt = true; },
    x => { x.migration.baselines[1].executableSha256 = '0'.repeat(64); },
    x => { x.update.feed.pins.descriptor = '0'.repeat(64); }, x => { x.update.to.installer = '0'.repeat(64); },
    x => { x.update.directServices.mcp.reviewApproved = true; }, x => { x.update.restartedClose.pid++; },
    x => { x.lifecycle.cleanupVerified = false; }, x => { x.lifecycle.hubCleanupUnknown = true; },
    x => { x.lifecycle.rejectedRequestCount = 1; }, x => { x.lifecycle.syntheticDiscovery.mcp = 0; }, x => { x.lifecycle.actualScope = 'public'; },
    x => { x.fixture.files.pop(); }, x => { x.fixture.files[1].path = x.fixture.files[0].path; },
    x => { x.binding.harnessSource = '0'.repeat(40); }]) {
    const altered = structuredClone(good); change(altered); assert.throws(() => verify(altered));
  }
});
test('incoming diagnostic rejects run, job, tree and archive substitutions before decoding', () => {
  const p = q.INCOMING_DIAGNOSTIC, repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' };
  const run = { id: p.run, run_attempt: 1, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', head_sha: p.source,
    head_branch: 'validation/windows-menu-merge-20261027', path: '.github/workflows/windows-incoming-016.yml', repository: repo, head_repository: repo };
  const job = { id: p.job, run_id: p.run, run_attempt: 1, head_sha: p.source, name: 'incoming-migration-diagnostic', status: 'completed',
    conclusion: 'success', labels: ['windows-latest'], started_at: '2026-11-03T09:33:27Z', completed_at: '2026-11-03T09:36:39Z' };
  const artifact = { id: p.artifact, name: `windows-signed012-migration-diagnostic-${p.run}-1`, expired: false, size_in_bytes: p.size,
    digest: `sha256:${p.archive}`, created_at: '2026-11-03T09:36:35Z', workflow_run: { id: p.run, head_sha: p.source, repository_id: repo.id, head_repository_id: repo.id } };
  const commit = { sha: p.source, tree: { sha: p.tree } }, archive = Buffer.alloc(p.size);
  for (const args of [[{ ...run, id: 1 }, job, artifact, commit], [run, { ...job, id: 1 }, artifact, commit],
    [run, job, { ...artifact, digest: `sha256:${'0'.repeat(64)}` }, commit], [run, job, artifact, { ...commit, tree: { sha: '0'.repeat(40) } }]]) {
    assert.throws(() => q.checkIncomingDiagnosticRemote(...args, archive));
  }
  assert.throws(() => q.checkIncomingDiagnosticRemote(run, job, artifact, commit, archive));
});
test('outgoing provenance refuses substitutions before archive decoding', () => {
  let decoded = false;
  assert.throws(() => q.checkOutgoingProvenance('mcp-restore', { id: 1 }, {}, {}, Buffer.alloc(1), () => { decoded = true; }));
  assert.equal(decoded, false);
});
function storedZip(rows) {
  const local = [], central = []; let offset = 0;
  for (const [name, value] of rows) {
    const n = Buffer.from(name), body = Buffer.from(value), h = Buffer.alloc(30), c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(body.length, 22); h.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(body.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    local.push(h, n, body); central.push(c, n); offset += h.length + n.length + body.length;
  }
  const directory = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50); e.writeUInt16LE(rows.length, 8); e.writeUInt16LE(rows.length, 10);
  e.writeUInt32LE(directory.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, e]);
}
test('archive reader rejects aliases, traversal, missing members and oversized content', () => {
  const zip = storedZip([['suite/report.json', '{}']]); assert.equal(q.readZipMember(zip, 'report.json').toString(), '{}');
  assert.throws(() => q.readZipMember(zip, 'other.json'), /Missing archive member/);
  assert.throws(() => q.readZipMember(storedZip([['../report.json', '{}']]), 'report.json'));
  assert.throws(() => q.readZipMember(storedZip([['suite/report.json', '{}'], ['SUITE/REPORT.JSON', '{}']]), 'report.json'), /Duplicate archive member/);
  assert.throws(() => q.readZipMember(storedZip([['a/report.json', '{}'], ['b/report.json', '{}']]), 'report.json'), /Ambiguous/);
  assert.throws(() => q.readZipMember(zip, 'report.json', 1));
});
test('ZIP evidence supports exact retained member paths without weakening basename ambiguity', () => {
  const archive = storedZip([['first/report.json', Buffer.from('one')], ['second/report.json', Buffer.from('two')]]);
  assert.equal(q.readZipMember(archive, 'first/report.json').toString(), 'one');
  assert.equal(q.readZipMember(archive, 'second/report.json').toString(), 'two');
  assert.throws(() => q.readZipMember(archive, 'report.json'), /Ambiguous/);
  for (const name of ['../report.json', 'first/../report.json', '/first/report.json', 'first\\report.json'])
    assert.throws(() => q.readZipMember(archive, name));
});
test('evidence verifier fails closed on mismatched run metadata', async () => {
  let downloads = 0;
  await assert.rejects(q.verifyExistingEvidence({ request: async () => ({}), download: async () => { downloads++; return Buffer.alloc(0); } }));
  // Acquisition happens before validation, but no supplied bytes can bypass metadata checks.
  assert.equal(downloads, 1);
});
test('mocked 017 publication requires 014 previous stable while legacy 014 requires 012', async () => {
  for (const [version, expected, wrong] of [['0.1.18', '0.1.14', '0.1.12'], ['0.1.14', '0.1.12', '0.1.14']]) {
    let writes = 0;
    const options = { platform: 'windows-x86_64', sha256: 'a'.repeat(64), association: 'b'.repeat(40) };
    const actions = { checkReadiness: async () => ({ draft: { id: 123 } }), verifyQualification: async () => ({
      version, platform: options.platform, qualificationSha256: options.sha256, draftId: 123,
      releaseAssociationVerified: true, releaseAssociationCommit: options.association, associationBuilt: false,
      productionApproval: true, sourceCiVerified: true, nativeEvidenceVerified: true, signaturesVerified: true, publicAcceptance: false, releaseReady: false }),
      checkDraft: async () => ({ previousStable: wrong }), publish: async () => { writes++; }, checkLive: async () => ({}) };
    await assert.rejects(publishDraft(version, actions, options), /previous stable/);
    assert.equal(writes, 0); actions.checkDraft = async () => ({ previousStable: expected });
    const result = await publishDraft(version, actions, options);
    assert.equal(writes, 1); assert.equal(result.ready, false);
  }
});

const finalHash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function finalDocument(member, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return { member, size: bytes.length, sha256: finalHash(bytes), base64: bytes.toString('base64') };
}
function finalFixture() {
  const sourceCommit = q.FINAL_SOURCE.commit, sourceTree = q.FINAL_SOURCE.tree, harness = '5'.repeat(40), harnessTree = '6'.repeat(40);
  const installer = Buffer.from('TEST ONLY: not an executable Final 0.1.18 installer');
  const candidate = { sourceCommit, sourceTree, parentCommit: q.FINAL_PARENT, installerSha256: finalHash(installer),
    executableSha256: '1'.repeat(64), buildInputDigest: 'd'.repeat(64), sourceReceiptSha256: 'e'.repeat(64) };
  candidate.buildInputs = finalDocument('build-r6-inputs.json', [{ path: 'package.json', sha256: '2'.repeat(64) }]);
  candidate.buildInputDigest = finalHash(Buffer.from(JSON.stringify(JSON.parse(Buffer.from(candidate.buildInputs.base64, 'base64')))));
  candidate.sourceReceipt = finalDocument('source-receipt-r6.json', { commit: sourceCommit, tree: sourceTree, built: false });
  candidate.sourceReceiptSha256 = candidate.sourceReceipt.sha256;
  candidate.buildResult = finalDocument('build-r4-result.json', { status: 0, sourceUnchanged: true, changed: [],
    sourceCommit, sourceTree, installerSha256: candidate.installerSha256, executableSha256: candidate.executableSha256,
    buildInputDigest: candidate.buildInputDigest, sourceReceiptSha256: candidate.sourceReceiptSha256 });
  const signatureText = 'untrusted comment: TEST ONLY mock signature\nnot-a-production-signature\n';
  const encoded = Buffer.from(signatureText).toString('base64');
  const descriptor = { schemaVersion: 1, appId: 'creator-hub', version: '0.1.18', platform: 'windows', architecture: 'x86_64',
    packageType: 'nsis', assetName: q.FINAL_ASSETS[0], byteLength: installer.length, sha256: candidate.installerSha256,
    executableSha256: candidate.executableSha256, identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1, minHubVersion: '0.1.12' };
  const bodies = { [q.FINAL_ASSETS[0]]: installer, [q.FINAL_ASSETS[1]]: Buffer.from(encoded),
    'creator-hub-windows-x86_64.json': Buffer.from(JSON.stringify(descriptor)),
    'creator-hub-windows-x86_64.json.minisig': Buffer.from(signatureText),
    'latest.json': Buffer.from(JSON.stringify(require('./release-descriptor.cjs').updaterManifest({ repo: 'CREATOR-HUB' }, '0.1.18', q.FINAL_ASSETS[0], encoded))) };
  bodies['SHA256SUMS.txt'] = Buffer.from(Object.keys(bodies).sort().map(name => `${finalHash(bodies[name])}  ${name}\n`).join(''));
  const assets = Object.fromEntries(q.FINAL_ASSETS.map((name, i) => [name, { id: 100 + i, size: bodies[name].length, sha256: finalHash(bodies[name]) }]));
  const successor = { version: '0.1.19', sourceCommit: '3'.repeat(40), sourceTree: '4'.repeat(40),
    pins: Object.fromEntries(['descriptor', 'descriptorSignature', 'installer', 'executable', 'manifest'].map((name, i) => [name, String(i + 4).repeat(64)])) };
  const value = { schemaVersion: 1, kind: 'windows-018-qualified-draft', repository: 'BOBWORKS-XR/CREATOR-HUB', repositoryId: 1364807512,
    version: '0.1.18', platform: 'windows-x86_64', authorization: 'publish-qualified-draft-only', productionApproval: false,
    releaseReady: false, publicAcceptance: false, productionKeySha256: q.PRODUCTION_KEY_SHA256,
    candidate, releaseAssociation: { kind: 'metadata-only-child', compiledSourceCommit: sourceCommit, compiledSourceTree: sourceTree, built: false },
    sourceCi: { runId: 5000, runAttempt: 1, workflow: '.github/workflows/ci.yml', sourceCommit, sourceTree, scope: 'final-source',
      jobs: [{ id: 5001, name: 'Built-in modules (clean Windows)' }] }, successor, draft: { id: 123456, assets }, proofs: {} };
  const to = { version: '0.1.18', installer: candidate.installerSha256, exe: candidate.executableSha256 };
  const feed = { pins: { descriptor: assets['creator-hub-windows-x86_64.json'].sha256,
    descriptorSignature: assets['creator-hub-windows-x86_64.json.minisig'].sha256, installer: candidate.installerSha256,
    executable: candidate.executableSha256, manifest: assets['latest.json'].sha256 } };
  const baseline = version => require('./self-update-baselines.cjs').baselines.find(b => b.version === version);
  const update = version => ({ passed: true, from: baseline(version), to, feed: { ...feed,
    kind: `targeted-public-${version}-production-metadata`, previousStable: version, baselineRole: 'explicit-pinned-public-version',
    productSource: sourceCommit, productTree: sourceTree, sourceUnchanged: true, buildInputsSha256: candidate.buildInputs.sha256,
    buildResultSha256: candidate.buildResult.sha256, productionMetadata: true, testOnlyDescriptor: false,
    labDiscovery: true, publicDiscovery: false, releaseReady: false }, selfUpdateTested: true, policyRestored: true,
    managedRouteReconnectTested: true, directHubUpdateTested: true, nativeAcceptance: false, originalPid: 50, restartedPid: 51, originalExitCode: 0,
    sourceKind: `targeted-public-${version}-production-metadata`, discoveryKind: 'controlled-lab-not-public-discovery',
    productionMetadata: true, labDiscovery: true, publicDiscovery: false, userMachineUsed: false, releaseReady: false,
    testOnlyDescriptor: false, harnessSource: harness });
  const inputBinding = { harnessSource: harness, privateDraft: true, readbackVerified: true, releaseId: value.draft.id, releaseTag: 'v0.1.18',
    source: { commit: sourceCommit, tree: sourceTree }, files: Object.fromEntries([q.FINAL_ASSETS[0], 'creator-hub-windows-x86_64.json',
      'creator-hub-windows-x86_64.json.minisig', 'latest.json'].map(name => [name, assets[name]])) };
  for (const [i, role] of q.FINAL_ROLES.entries()) {
    let binding = role.includes('-restore') ? { harnessSource: harness } : inputBinding;
    let report = { passed: true, releaseReady: false, installerSha256: candidate.installerSha256, executableSha256: candidate.executableSha256,
      buildInputDigest: candidate.buildInputDigest, productSource: `source-receipt-sha256:${candidate.sourceReceiptSha256}`,
      sourceUnchanged: true, sourceSnapshotBuilt: true, settingsPreserved: true };
    if (role === 'fresh') {
      Object.assign(report, { freshInstallAccepted: true, manualNormalRestartAccepted: true, productSource: sourceCommit,
        productTree: sourceTree, buildInputsSha256: candidate.buildInputs.sha256, buildResultSha256: candidate.buildResult.sha256,
        policyRestored: true, harnessSource: harness, normalCloses: [{ pid: 42, exitCode: 0 }, { pid: 43, exitCode: 0 }],
        userMachineUsed: false, publicDiscovery: false, migrationAccepted: false, signedUpdateAccepted: false, signedAutomaticRestartAccepted: false });
      binding = { harnessSource: harness, privateDraft: true, readbackVerified: true, releaseId: value.draft.id, releaseTag: 'v0.1.18',
        source: { commit: sourceCommit, tree: sourceTree }, files: Object.fromEntries([q.FINAL_ASSETS[0], 'creator-hub-windows-x86_64.json',
          'creator-hub-windows-x86_64.json.minisig', 'latest.json'].map(name => [name, assets[name]])) };
    }
    if (role === 'guarded') {
      binding = { schemaVersion: 1, releaseId: 333, releaseTag: 'lab-test-only', assetId: 334,
        assetName: 'Creator.Hub_0.1.18_x64-test.exe', bytes: installer.length, sha256: candidate.installerSha256,
        receiptSha256: candidate.buildResult.sha256 };
      report = { passed: true, releaseReady: false, mode: 'guarded', scope: 'ci-exact-candidate-nsis-only',
        source: { commit: sourceCommit, manifestSha256: candidate.buildInputs.sha256 }, candidateReceiptSha256: candidate.buildResult.sha256,
        producer: { kind: q.RELEASE_TARGET.rawProducer, sourceTree, buildResultSha256: candidate.buildResult.sha256, privateAsset: binding },
        installerSha256: candidate.installerSha256, executableSha256: candidate.executableSha256, settingsPreserved: true,
        from: baseline('0.1.14'), installerScope: 'guarded-nsis-update-default-location-no-msi', guardedInstallerAccepted: true,
        freshInstallAccepted: false, nativeGuiAccepted: false, signedUpdateAccepted: false, automaticRestartAccepted: false, migrationAccepted: false };
    }
    if (role === 'migration' || role === 'combined') Object.assign(report, { scope: 'exact-direct16-three-client-clean-legacy-guide-probe',
      productSource: sourceCommit, productTree: sourceTree, buildInputsSha256: candidate.buildInputs.sha256,
      buildResultSha256: candidate.buildResult.sha256, testSource: harness, inputBinding: binding,
      nativeGuideAccepted: true, cancelAccepted: true, repeatStartupAccepted: true, policyRestored: true, installedResourcesVerified: true,
      migrationAccepted: false, signedUpdateAccepted: false, liveAiAppAccepted: false, crashRecoveryAccepted: false,
      backupBeforeEveryWriteAccepted: false, userMachineUsed: false,
      nativeDecisions: ['Not now', 'Move to Hub'].map(name => ({ name, pid: 42, executableSha256: candidate.executableSha256 })),
      connectionExceptionDecisions: [{ name: 'Move reviewed connections', executableSha256: candidate.executableSha256 }],
      backupsPresentAtFirstObservedChange: Array.from({ length: 5 }, (_, n) => ({ file: `TEST-ONLY-${n}`, backup: `TEST-ONLY-${n}.bak` })),
      resourcePins: Object.fromEntries(['setup/creator-project-setup.exe', 'routing/creator-hub-mcp-router.exe', 'routing/router.json',
        'routing/router.minisig', 'routing/runtime.json', 'routing/runtime.minisig'].map(name => [name, '2'.repeat(64)])) });
    if (role.startsWith('incoming')) report = update(role === 'incoming014' ? '0.1.14' : '0.1.12');
    if (role.includes('-restore')) {
      const tool = role === 'mcp-restore' ? 'mcp' : 'setup', restore = role !== 'setup-no-restore';
      report = { passed: true, releaseReady: false, kind: 'direct-outgoing-018-019', sourceCommit: successor.sourceCommit,
        baseline: to, pins: successor.pins, lastTool: tool, restore, restoredLastTool: restore ? tool : null,
        migrationDeferred: true, beforePeVersion: [0, 1, 18, 0], afterPeVersion: [0, 1, 19, 0],
        nativeUpdateAccepted: true, automaticRestart: true, cancelPreserved: true, settingsPreserved: true,
        changedMcpGenerationProven: true,
        resourceProbe: { phase: 'after-automatic-root', attempts: 1, passed: true },
        installedResourcesVerifiedBeforeAndAfter: true, heldGenerationRetained: true,
        beforeRoute: { generation: q.RELEASE_TARGET.runtime.baselineGeneration }, afterRoute: { generation: q.RELEASE_TARGET.runtime.targetGeneration },
        beforeRoot: { pid: 44 }, afterRoot: { pid: 45 }, heldProcessesBefore: [{ pid: 46 }, { pid: 47 }],
        heldProcessesAfter: [{ pid: 46 }, { pid: 47 }], heldServerVersion: { version: '2.7.7' },
        reconnectedServerVersion: { version: '2.7.8-fixture.19' },
        existingConnectionSurvived: true, newConnectionVerified: true, restorationVerified: true, policyRestored: true,
        labDiscovery: true, acceptanceOnly: true, publicDiscovery: false, liveAiAcceptance: false };
    }
    if (role === 'combined') Object.assign(report, { testSource: harness,
      incomingProduction: { signedUpdateObserved: true, normalCloseObserved: true, labCleanupObserved: true, processTransfer: false,
        migrationNetworkObserved: false, migrationIsolationProven: false, publicDiscovery: false, migrationProven: false, releaseReady: false } });
    const docs = { report: finalDocument(`${role}-report.json`, report), binding: finalDocument(`${role}-binding.json`, binding) };
    if (role.startsWith('incoming') || role.includes('-restore') || role === 'combined') {
      docs.lifecycle = finalDocument(`${role}-lifecycle.jsonl`, { kind: 'lab-lifecycle-result', lifecycleSucceeded: true,
        cleanupVerified: true, systemTlsVerified: true, driverExitCode: 0, rejectedRequestCount: 0, publicDiscovery: false, releaseReady: false });
    }
    if (role === 'combined') docs.update = finalDocument('combined-update.json', { ...update('0.1.12'),
      observedRestart: { kind: 'observed-signed-update-restart', baselinePid: 50, restartedPid: 51,
        baselineImageSha256: baseline('0.1.12').exe, restartedImageSha256: candidate.executableSha256,
        baselineStartTicks: '1', approvalLowerBoundTicks: '2', restartedStartTicks: '3', singletonAtCheckpoints: true,
        harnessAdditionalLaunch: false, ancestryProven: false, securityAttestation: false },
      restartedClose: { state: 'verified', pid: 51, exitCode: 0 } });
    if (role.includes('-restore')) docs.binding = finalDocument(`${role}-binding.json`, { harnessSource: harness,
      passed: true, case: role, reportSha256: docs.report.sha256, lifecycleSha256: docs.lifecycle.sha256,
      baselineSource: { commit: sourceCommit, tree: sourceTree }, targetSource: { commit: successor.sourceCommit, tree: successor.sourceTree },
      recoveryReceiptSha256: q.RELEASE_TARGET.runtime.recoveryReceiptSha256, acceptanceOnly: true, publicDiscovery: false, releaseReady: false });
    const archive = storedZip(Object.values(docs).map(d => [d.member, Buffer.from(d.base64, 'base64')]));
    value.proofs[role] = { runId: 2000 + i, runAttempt: 1, jobId: 3000 + i, jobName: role, sourceCommit: harness, sourceTree: harnessTree,
      artifact: { id: 4000 + i, name: `TEST-ONLY-${role}`, size: archive.length, sha256: finalHash(archive) }, documents: docs };
  }
  const calls = [], responses = new Map(), downloads = new Map(), associationCommit = 'a'.repeat(40), associationTree = 'b'.repeat(40);
  const repo = { id: value.repositoryId, full_name: value.repository };
  responses.set(`git/commits/${sourceCommit}`, { sha: sourceCommit, tree: { sha: sourceTree }, parents: [{ sha: q.FINAL_PARENT }] });
  responses.set(`git/commits/${associationCommit}`, { sha: associationCommit, tree: { sha: associationTree }, parents: [{ sha: sourceCommit }] });
  responses.set('actions/runs/5000', { id: 5000, run_attempt: 1, event: 'push', status: 'completed', conclusion: 'success',
    head_sha: sourceCommit, path: value.sourceCi.workflow, repository: repo, head_repository: repo });
  responses.set('actions/jobs/5001', { id: 5001, name: value.sourceCi.jobs[0].name, run_id: 5000, run_attempt: 1,
    head_sha: sourceCommit, status: 'completed', conclusion: 'success', labels: ['windows-latest'] });
  responses.set(`git/commits/${successor.sourceCommit}`, { sha: successor.sourceCommit, tree: { sha: successor.sourceTree } });
  responses.set(`git/commits/${harness}`, { sha: harness, tree: { sha: harnessTree } });
  for (const [role, p] of Object.entries(value.proofs)) {
    responses.set(`actions/runs/${p.runId}`, { id: p.runId, run_attempt: p.runAttempt, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
      head_sha: harness, path: q.finalProofWorkflow(role), repository: repo, head_repository: repo });
    responses.set(`actions/jobs/${p.jobId}`, { id: p.jobId, run_id: p.runId, run_attempt: p.runAttempt, head_sha: harness, name: p.jobName,
      status: 'completed', conclusion: 'success', labels: ['windows-latest'], started_at: '2026-11-03T10:00:00Z', completed_at: '2026-11-03T10:02:00Z' });
    responses.set(`actions/artifacts/${p.artifact.id}`, { id: p.artifact.id, name: p.artifact.name, expired: false, size_in_bytes: p.artifact.size,
      digest: `sha256:${p.artifact.sha256}`, created_at: '2026-11-03T10:01:00Z', workflow_run: { id: p.runId, head_sha: harness, repository_id: repo.id, head_repository_id: repo.id } });
    downloads.set(`actions/artifacts/${p.artifact.id}/zip`, storedZip(Object.values(p.documents).map(d => [d.member, Buffer.from(d.base64, 'base64')])));
  }
  responses.set(`releases/${value.draft.id}`, { id: value.draft.id, tag_name: 'v0.1.18', draft: true, prerelease: false, target_commitish: associationCommit,
    assets: Object.entries(assets).map(([name, p]) => ({ name, ...p, digest: `sha256:${p.sha256}`, state: 'uploaded' })) });
  for (const name of q.FINAL_ASSETS) downloads.set(`releases/assets/${assets[name].id}`, bodies[name]);
  const io = { request: async route => { calls.push(route); assert.ok(responses.has(route), route); return structuredClone(responses.get(route)); },
    download: async (route, max) => { calls.push(route); assert.ok(downloads.has(route), route); const b = downloads.get(route); assert.ok(b.length < max); return Buffer.from(b); } };
  const bindReceipt = bytes => {
    const beforeAttributes = Buffer.from('tests/fixtures/** -text\n');
    const baseAttributeSha = 'f'.repeat(40);
    responses.set(`git/trees/${sourceTree}`, { sha: sourceTree, tree: [{ path: '.gitattributes', type: 'blob', sha: baseAttributeSha }] });
    responses.set(`git/blobs/${baseAttributeSha}`, { encoding: 'base64', size: beforeAttributes.length, content: beforeAttributes.toString('base64') });
    const names = ['.gitattributes', '.github/workflows/release.yml', 'scripts/windows-016-release-qualification.cjs', 'scripts/check-unified-sources.cjs',
      'scripts/windows-release-target.cjs', 'scripts/windows-release-target.test.cjs', 'scripts/fixtures/windows-release-target.cjs',
      'scripts/windows-017-draft-stage.cjs', 'scripts/windows-017-draft-stage.test.cjs', 'scripts/windows-017-signing.cjs',
      'scripts/windows-018-public-acceptance.cjs', 'scripts/windows-018-public-acceptance.test.cjs',
      'scripts/publish-hub-draft.cjs', 'packaging/windows/0.1.18-qualification.json', 'packaging/windows/0.1.18-qualification.json.sha256'];
    const files = names.map(filename => {
      const content = filename === '.gitattributes' ? Buffer.concat([beforeAttributes, Buffer.from('packaging/windows/*-qualification.json -text\n')])
        : filename.endsWith('.json') ? bytes : filename.endsWith('.sha256') ? Buffer.from(finalHash(bytes) + '\n') : Buffer.from('TEST ONLY metadata');
      const sha = crypto.createHash('sha1').update(filename).digest('hex');
      responses.set(`git/blobs/${sha}`, { sha, encoding: 'base64', size: content.length, content: content.toString('base64') });
      return { filename, status: 'added', sha };
    });
    responses.set(`compare/${sourceCommit}...${associationCommit}`, { status: 'ahead', total_commits: 1,
      base_commit: { sha: sourceCommit }, merge_base_commit: { sha: sourceCommit }, commits: [{ sha: associationCommit }], files });
  };
  return { value, io, calls, responses, downloads, bodies, associationCommit, associationTree, bindReceipt };
}
function loadFinal(t, fixture, parser = q.loadQualification) {
  const os = require('node:os'), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-r4-qualification-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'TEST-ONLY.json'), bytes = Buffer.from(JSON.stringify(fixture.value, null, 2) + '\n');
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  fixture.bindReceipt(bytes);
  return { file, sha256: finalHash(bytes), association: fixture.associationCommit, loaded: parser(file, finalHash(bytes), fixture.associationCommit) };
}
function mockFinalSignatures(t) {
  const calls = [];
  t.mock.method(require('./linux-016-release-qualification.cjs'), 'verifySignature', (body, signature) => {
    calls.push(body); assert.equal(signature.toString(), 'untrusted comment: TEST ONLY mock signature\nnot-a-production-signature\n');
  });
  return calls;
}
function splitCombinedFixture(role) {
  const f = finalFixture(), proof = structuredClone(f.value.proofs.combined);
  const report = JSON.parse(Buffer.from(proof.documents.report.base64, 'base64'));
  report.backupsPresentAtFirstObservedChange = report.backupsPresentAtFirstObservedChange.slice(0, 4);
  report.normalSetupOwnedCodex = { fixtureOnly: true, copiedUserData: false,
    command: 'C:/fixture/creator-hub/mcp-route-v1/windows-x86_64/router-v1/creator-hub-mcp-router.exe', args: [],
    beforeNativeMoveSha256: 'c'.repeat(64), afterRestartSha256: 'c'.repeat(64),
    guiNativeMoveRequired: true, migrationAccepted: true };
  if (role === 'combined-custom') {
    report.activeRoute = { payload: 'C:\\fixture\\runtime-generation' };
    const server = report.activeRoute.payload + '\\mcp/server/creator-works-mcp.mjs';
    report.unverifiedSavedServerTransition = { before: 'C:\\fixture\\Unverified Server\\never-run-custom.mjs', after: server, nativeApproved: true };
    report.serverRuntimeDecision = [{ title: 'Keep MCP settings working in Hub', name: 'Use Hub runtime', id: 1000,
      handle: 44, pid: 42, executableSha256: f.value.candidate.executableSha256, expectedServer: server,
      content: 'The saved MCP server could not be verified as a supported previous build. Use the verified MCP runtime included with Hub instead?\n\nThis does not trust or run the old server. Existing AI-client entries are reviewed separately.'
        + `\n\nNew server: ${server}\n\nOnly this path changes. Project selection, options and unknown settings are preserved. Exact local backups and recovery records are kept. Old apps and AI clients are not stopped or removed by this step.` }];
  }
  proof.documents.report = finalDocument(`${role}-report.json`, report);
  return { ...f, proof, report };
}
test('owned-router and separate custom-server combined reports retain full update and lifecycle checks', () => {
  for (const role of ['combined-owned', 'combined-custom']) {
    const f = splitCombinedFixture(role); q.checkFinalReport(role, f.proof, f.value);
    delete f.proof.documents.update; assert.throws(() => q.checkFinalReport(role, f.proof, f.value));
  }
});
test('custom consent cannot replace standard combined or omit the separate native decision', () => {
  const f = splitCombinedFixture('combined-custom');
  assert.throws(() => q.checkFinalReport('combined', f.proof, f.value));
  assert.throws(() => q.checkFinalReport('combined-owned', f.proof, f.value));
  delete f.report.serverRuntimeDecision;
  f.proof.documents.report = finalDocument('custom-report.json', f.report);
  assert.throws(() => q.checkFinalReport('combined-custom', f.proof, f.value));
});
test('split combined cases reject changed owned config and mismatched server paths', () => {
  for (const mutate of [r => { r.normalSetupOwnedCodex.afterRestartSha256 = 'd'.repeat(64); },
    r => { r.serverRuntimeDecision[0].expectedServer += '-other'; },
    r => { r.unverifiedSavedServerTransition.nativeApproved = false; },
    r => { r.serverRuntimeDecision[0].content = 'generic approval'; },
    r => { r.backupsPresentAtFirstObservedChange.pop(); }]) {
    const f = splitCombinedFixture('combined-custom'); mutate(f.report);
    f.proof.documents.report = finalDocument('custom-report.json', f.report);
    assert.throws(() => q.checkFinalReport('combined-custom', f.proof, f.value));
  }
});
test('split lane support does not make standard combined or outgoing proofs optional', () => {
  for (const role of ['combined', 'mcp-restore', 'setup-restore', 'setup-no-restore']) {
    const f = finalFixture(); delete f.value.proofs[role]; assert.throws(() => q.validateFinalQualification(f.value));
  }
});
function outgoing18RecoveryFixture() {
  return { schemaVersion: 1, kind: 'outgoing18-normalization-recovery', scope: 'test-fixture-only',
    source: { ...q.OUTGOING18_RECOVERY.source }, baselineSource: { ...q.R6_SOURCE }, originalBuildExitCode: 1,
    rawSourceUnchanged: false, sourceUnchanged: false, postcheckStatus: 0, normalizationVerified: true,
    fixtureExceptionReviewRequired: true, rootPe: { FileVersion: '0.1.18', ProductVersion: '0.1.18' },
    moduleVersion: '2.7.8-fixture.18', moduleFilesChecked: 15, payloadGenerationChanged: true,
    serverBundleChanged: true, independentlyExtracted: true, managedRuntimeVerified: true,
    baselineGeneration: 'a'.repeat(64), targetGeneration: 'b'.repeat(64), outerDescriptorSigned: false,
    outgoingNativeAccepted: false, published: false, releaseReady: false, contractTests: { passed: 6 },
    artifacts: { installer: { sha256: q.OUTGOING18_RECOVERY.installer }, executable: { sha256: q.OUTGOING18_RECOVERY.executable } },
    publicKey: { sha256: q.PRODUCTION_KEY_SHA256 }, verifier: { sha256: q.OUTGOING18_RECOVERY.verifier },
    verificationScripts: { 'normalization-contract.cjs': { sha256: q.OUTGOING18_RECOVERY.contract } } };
}
test('outgoing18 recovery is a finite fixture-only route, never production qualification', () => {
  const r = outgoing18RecoveryFixture(); assert.equal(q.validateOutgoing18Recovery(r), r);
  assert.throws(() => q.validateFinalQualification(r));
  assert.throws(() => q.verifyOutgoing18Recovery('does-not-exist.json', '0'.repeat(64)), /reviewed test18 receipt/);
  for (const change of [r => { r.scope = 'production17'; }, r => { r.source.commit = q.FINAL_SOURCE.commit; },
    r => { r.rawSourceUnchanged = true; }, r => { r.sourceUnchanged = true; }, r => { r.originalBuildExitCode = 0; },
    r => { r.rootPe.ProductVersion = '0.1.17'; }, r => { r.moduleVersion = '2.7.7'; }, r => { r.moduleFilesChecked = 14; },
    r => { r.targetGeneration = r.baselineGeneration; }, r => { r.serverBundleChanged = false; },
    r => { r.artifacts.installer.sha256 = '1'.repeat(64); }, r => { r.verifier.sha256 = '2'.repeat(64); },
    r => { r.outgoingNativeAccepted = true; }, r => { r.outerDescriptorSigned = true; }, r => { r.releaseReady = true; }]) {
    const bad = structuredClone(r); change(bad); assert.throws(() => q.validateOutgoing18Recovery(bad));
  }
});
test('Final 0.1.18 requires fresh immutable source/build, all native cases and exact receipt digest', t => {
  const fixture = finalFixture(); const { file, sha256, loaded } = loadFinal(t, fixture);
  assert.equal(loaded.productionApproval, false); assert.equal(loaded.publicAcceptance, false);
  assert.throws(() => q.loadQualification(file, '0'.repeat(64)), /qualification blocked/);
  assert.throws(() => q.loadQualification(file, 'a'.repeat(64), fixture.associationCommit), /digest differs/);
  assert.deepEqual(q.loadQualification(file, sha256, fixture.associationCommit), loaded);
  for (const change of [v => { v.productionApproval = true; }, v => { v.releaseReady = true; }, v => { v.publicAcceptance = true; },
    v => { v.kind = 'windows-016-production-preflight'; }, v => { delete v.proofs.combined; }, v => { delete v.proofs.incoming014; },
    v => { v.candidate.parentCommit = '7'.repeat(40); }, v => { v.candidate.sourceCommit = 'f'.repeat(40); },
    v => { v.candidate.sourceTree = '7'.repeat(40); }, v => { v.candidate.installerSha256 = q.R2.installer; },
    v => { delete v.sourceCi; }, v => { v.sourceCi.sourceCommit = q.FINAL_PARENT; }, v => { v.sourceCi.jobs = []; },
    v => { v.candidate.executableSha256 = q.R2.executable; }, v => { v.draft.sourceCommit = q.FINAL_PARENT; },
    v => { v.draft.assets['latest.json'].sha256 = q.REUSE.assets['latest.json'].sha256; },
    v => { v.candidate.buildResult = finalDocument('build.json', { status: 0, sourceUnchanged: false, changed: [] }); }]) {
    const bad = structuredClone(fixture.value); change(bad); assert.throws(() => q.validateFinalQualification(bad));
  }
});
test('Final 0.1.18 rejects native failure or incomplete evidence even after document hashes are updated', () => {
  const fixture = finalFixture();
  for (const [role, field, bad] of [['fresh', 'settingsPreserved', false], ['guarded', 'guardedInstallerAccepted', false],
    ['migration', 'repeatStartupAccepted', false], ['migration', 'migrationAccepted', true], ['combined', 'cancelAccepted', false],
    ['incoming014', 'selfUpdateTested', false], ['incoming012', 'testOnlyDescriptor', true], ['incoming012', 'nativeAcceptance', true],
    ['mcp-restore', 'automaticRestart', false], ['mcp-restore', 'changedMcpGenerationProven', false],
    ['setup-restore', 'existingConnectionSurvived', false], ['setup-no-restore', 'restoredLastTool', 'setup']]) {
    const value = structuredClone(fixture.value), old = value.proofs[role].documents.report;
    const report = JSON.parse(Buffer.from(old.base64, 'base64')); report[field] = bad;
    value.proofs[role].documents.report = finalDocument(old.member, report);
    assert.throws(() => q.validateFinalQualification(value), undefined, `${role}.${field}`);
  }
  const value = structuredClone(fixture.value), doc = value.proofs.combined.documents.report;
  const report = JSON.parse(Buffer.from(doc.base64, 'base64')); report.incomingProduction.normalCloseObserved = false;
  value.proofs.combined.documents.report = finalDocument(doc.member, report); assert.throws(() => q.validateFinalQualification(value));
});
test('Final 0.1.18 verifies actual mocked transport bytes and never claims public acceptance', async t => {
  const fixture = finalFixture(), { loaded, sha256 } = loadFinal(t, fixture), signatureCalls = mockFinalSignatures(t);
  const result = await q.verifyRemote(loaded, fixture.io);
  assert.deepEqual(result, { version: '0.1.18', platform: 'windows-x86_64', draftId: loaded.draft.id, qualificationSha256: sha256,
    releaseAssociationCommit: fixture.associationCommit, releaseAssociationVerified: true, associationBuilt: false, compiledSourceCommit: q.FINAL_SOURCE.commit,
    productionApproval: true, sourceCiVerified: true, sourceCiScope: 'final-source', nativeEvidenceVerified: true, signaturesVerified: true, publicAcceptance: false, releaseReady: false });
  assert.equal(signatureCalls.length, 2);
  assert.equal(fixture.calls.filter(route => route === `releases/${loaded.draft.id}`).length, 2);
  assert.equal(fixture.calls.filter(route => route.startsWith('releases/assets/')).length, 6);
});
test('an independent successful fresh job survives failed siblings but cannot replace their proofs', async t => {
  mockFinalSignatures(t);
  const fixture = finalFixture();
  fixture.responses.get(`actions/runs/${fixture.value.proofs.fresh.runId}`).conclusion = 'failure';
  const { loaded } = loadFinal(t, fixture);
  assert.equal((await q.verifyRemote(loaded, fixture.io)).nativeEvidenceVerified, true);
  fixture.responses.get(`actions/jobs/${fixture.value.proofs.fresh.jobId}`).conclusion = 'failure';
  await assert.rejects(q.verifyRemote(loaded, fixture.io));
  fixture.responses.get(`actions/jobs/${fixture.value.proofs.fresh.jobId}`).conclusion = 'success';
  fixture.responses.get(`actions/runs/${fixture.value.proofs.incoming012.runId}`).conclusion = 'failure';
  await assert.rejects(q.verifyRemote(loaded, fixture.io));
});
test('fresh and corrected incoming proofs retain different immutable harness commits', async t => {
  mockFinalSignatures(t);
  const fixture = finalFixture(), p = fixture.value.proofs.incoming012, head = 'c'.repeat(40), tree = 'd'.repeat(40);
  p.sourceCommit = head; p.sourceTree = tree;
  for (const name of ['report', 'binding']) {
    const old = p.documents[name], value = JSON.parse(Buffer.from(old.base64, 'base64'));
    value.harnessSource = head; p.documents[name] = finalDocument(old.member, value);
  }
  const archive = storedZip(Object.values(p.documents).map(d => [d.member, Buffer.from(d.base64, 'base64')]));
  p.artifact.size = archive.length; p.artifact.sha256 = finalHash(archive);
  fixture.responses.set(`git/commits/${head}`, { sha: head, tree: { sha: tree } });
  fixture.responses.get(`actions/runs/${p.runId}`).head_sha = head;
  fixture.responses.get(`actions/jobs/${p.jobId}`).head_sha = head;
  Object.assign(fixture.responses.get(`actions/artifacts/${p.artifact.id}`), { size_in_bytes: archive.length, digest: `sha256:${p.artifact.sha256}` });
  fixture.responses.get(`actions/artifacts/${p.artifact.id}`).workflow_run.head_sha = head;
  fixture.downloads.set(`actions/artifacts/${p.artifact.id}/zip`, archive);
  const { loaded } = loadFinal(t, fixture);
  assert.notEqual(loaded.proofs.fresh.sourceCommit, loaded.proofs.incoming012.sourceCommit);
  assert.equal((await q.verifyRemote(loaded, fixture.io)).nativeEvidenceVerified, true);
});
test('fresh and raw-guarded proofs retain actual source fields and narrow nonacceptance flags', () => {
  const fixture = finalFixture();
  for (const [role, field, bad] of [['fresh', 'productSource', q.FINAL_PARENT], ['fresh', 'buildInputsSha256', '9'.repeat(64)],
    ['fresh', 'signedAutomaticRestartAccepted', true], ['guarded', 'nativeGuiAccepted', true], ['guarded', 'migrationAccepted', true]]) {
    const value = structuredClone(fixture.value), document = value.proofs[role].documents.report;
    const report = JSON.parse(Buffer.from(document.base64, 'base64')); report[field] = bad;
    value.proofs[role].documents.report = finalDocument(document.member, report);
    assert.throws(() => q.validateFinalQualification(value), undefined, `${role}.${field}`);
  }
  const value = structuredClone(fixture.value), document = value.proofs.fresh.documents.binding;
  const binding = JSON.parse(Buffer.from(document.base64, 'base64')); binding.files['latest.json'].id++;
  value.proofs.fresh.documents.binding = finalDocument(document.member, binding);
  assert.throws(() => q.validateFinalQualification(value));
});
test('outgoing18 cannot replace held-process, changed-generation or report binding evidence with booleans', () => {
  for (const mutate of [r => { r.heldProcessesAfter[0].pid++; }, r => { r.reconnectedServerVersion.version = '2.7.7'; },
    r => { r.afterRoute.generation = r.beforeRoute.generation; }, r => { r.heldGenerationRetained = false; },
    r => { r.installedResourcesVerifiedBeforeAndAfter = false; },
    r => { delete r.resourceProbe; }, r => { r.resourceProbe.attempts = 2; },
    r => { r.resourceProbe.phase = 'before-automatic-root'; }, r => { r.resourceProbe.passed = false; }]) {
    const value = finalFixture().value, p = value.proofs['mcp-restore'], r = JSON.parse(Buffer.from(p.documents.report.base64, 'base64'));
    mutate(r); p.documents.report = finalDocument(p.documents.report.member, r);
    assert.throws(() => q.validateFinalQualification(value));
  }
  const value = finalFixture().value, p = value.proofs['mcp-restore'];
  const binding = JSON.parse(Buffer.from(p.documents.binding.base64, 'base64')); binding.lifecycleSha256 = '9'.repeat(64);
  p.documents.binding = finalDocument(p.documents.binding.member, binding);
  assert.throws(() => q.validateFinalQualification(value));
});
test('Final 0.1.18 cloned or modified receipts cannot bypass the independently loaded digest', async t => {
  const fixture = finalFixture(), { loaded } = loadFinal(t, fixture);
  await assert.rejects(q.verifyRemote(structuredClone(loaded), fixture.io), /load the digest-pinned/);
  loaded.proofs.fresh.jobId++;
  await assert.rejects(q.verifyRemote(loaded, fixture.io), /qualification changed/);
  assert.deepEqual(fixture.calls, []);
});
test('Final 0.1.18 rejects source, run, job, artifact, original ZIP and draft drift', async t => {
  mockFinalSignatures(t);
  const changes = [f => { f.responses.get(`git/commits/${f.value.candidate.sourceCommit}`).parents = []; },
    f => { f.responses.get('actions/runs/5000').conclusion = 'failure'; },
    f => { f.responses.get('actions/runs/5000').head_sha = q.FINAL_PARENT; },
    f => { f.responses.get('actions/jobs/5001').conclusion = 'failure'; },
    f => { f.responses.get('actions/jobs/5001').labels = ['ubuntu-latest']; },
    f => { f.responses.get(`actions/runs/${f.value.proofs.fresh.runId}`).conclusion = 'cancelled'; },
    f => { f.responses.get(`actions/jobs/${f.value.proofs.fresh.jobId}`).conclusion = 'failure'; },
    f => { f.responses.get(`actions/jobs/${f.value.proofs.fresh.jobId}`).run_attempt++; },
    f => { f.responses.get(`actions/artifacts/${f.value.proofs.fresh.artifact.id}`).expired = true; },
    f => { f.responses.get(`actions/artifacts/${f.value.proofs.fresh.artifact.id}`).workflow_run.head_sha = '9'.repeat(40); },
    f => { f.downloads.get(`actions/artifacts/${f.value.proofs.fresh.artifact.id}/zip`)[0] ^= 1; },
    f => { f.responses.get(`releases/${f.value.draft.id}`).target_commitish = q.FINAL_PARENT; },
    f => { f.responses.get(`releases/${f.value.draft.id}`).assets.pop(); },
    f => { f.downloads.get(`releases/assets/${f.value.draft.assets['latest.json'].id}`)[0] ^= 1; }];
  for (const change of changes) {
    const fixture = finalFixture(), { loaded } = loadFinal(t, fixture); change(fixture);
    await assert.rejects(q.verifyRemote(loaded, fixture.io));
  }
});
test('Final 0.1.18 refuses unsigned mock assets through the real production-key verifier', async t => {
  const fixture = finalFixture(), { loaded } = loadFinal(t, fixture);
  await assert.rejects(q.verifyRemote(loaded, fixture.io));
});
test('Final 0.1.18 publisher uses the real qualification route before feed and only writes the verified draft', async t => {
  mockFinalSignatures(t);
  const fixture = finalFixture(), { file, sha256 } = loadFinal(t, fixture), calls = [];
  const result = await publishDraft('0.1.18', {
    checkReadiness: () => q.loadQualification(file, sha256, fixture.associationCommit),
    verifyQualification: value => q.verifyRemote(value, fixture.io),
    checkDraft: async () => { calls.push('feed'); return { previousStable: '0.1.14' }; },
    execute: (command, args) => { calls.push({ command, args }); }, checkLive: async () => ({ bytes: 1000 }),
  }, { platform: 'windows-x86_64', receipt: file, sha256, association: fixture.associationCommit });
  assert.deepEqual(calls, ['feed', { command: 'gh', args: ['api', '--method', 'PATCH',
    `repos/BOBWORKS-XR/CREATOR-HUB/releases/${fixture.value.draft.id}`, '-f', 'tag_name=v0.1.18', '-F', 'draft=false', '-f', 'make_latest=false'] }]);
  assert.equal(result.ready, false);
  assert.equal(fixture.value.productionApproval, false);
});
test('Final 0.1.18 signature, descriptor, updater URL and checksum validation is not just asset hashing', t => {
  mockFinalSignatures(t);
  for (const edit of [f => { f.bodies['creator-hub-windows-x86_64.json.minisig'] = Buffer.from('invalid'); },
    f => { const d = JSON.parse(f.bodies['creator-hub-windows-x86_64.json']); d.executableSha256 = '9'.repeat(64); f.bodies['creator-hub-windows-x86_64.json'] = Buffer.from(JSON.stringify(d)); },
    f => { const d = JSON.parse(f.bodies['latest.json']); d.platforms['windows-x86_64'].url = 'https://example.invalid/wrong.exe'; f.bodies['latest.json'] = Buffer.from(JSON.stringify(d)); },
    f => { f.bodies[q.FINAL_ASSETS[1]] = Buffer.from('wrong-standalone-signature'); },
    f => { f.bodies['SHA256SUMS.txt'] = Buffer.from('wrong checksums'); }]) {
    const fixture = finalFixture(); edit(fixture);
    for (const name of q.FINAL_ASSETS) Object.assign(fixture.value.draft.assets[name], { size: fixture.bodies[name].length, sha256: finalHash(fixture.bodies[name]) });
    assert.throws(() => q.checkFinalPayload(fixture.value, fixture.bodies));
  }
});
test('Final 0.1.18 rejects drift during asynchronous verification and second draft readback', async t => {
  mockFinalSignatures(t);
  for (const stage of ['receipt', 'draft']) {
    const fixture = finalFixture(), { loaded } = loadFinal(t, fixture), original = fixture.io.request; let drafts = 0;
    fixture.io.request = async route => {
      const result = await original(route);
      if (stage === 'receipt' && route.startsWith('actions/runs/')) loaded.candidate.sourceTree = '9'.repeat(40);
      if (stage === 'draft' && route.startsWith('releases/') && ++drafts === 2) result.assets[0].id++;
      return result;
    };
    await assert.rejects(q.verifyRemote(loaded, fixture.io));
  }
});
test('Final 0.1.18 source gate retains current version and production public-key checks', t => {
  const { file, sha256, association } = loadFinal(t, finalFixture()), directory = path.dirname(file), root = path.join(directory, 'source');
  fs.mkdirSync(path.join(root, 'src-tauri/src'), { recursive: true });
  const keyFile = path.join(root, 'src-tauri/src/catalog-key.pub');
  fs.copyFileSync(path.join(__dirname, '../src-tauri/src/catalog-key.pub'), keyFile);
  for (const name of ['package.json', 'src-tauri/tauri.conf.json']) fs.writeFileSync(path.join(root, name), JSON.stringify({ version: '0.1.18' }));
  const intent = { version: '0.1.18', platform: 'windows-x86_64', receiptPath: file, sha256, association, root };
  const { assertReleaseReady } = require('./check-unified-sources.cjs'), manifest = require('../modules/suite.json');
  assert.equal(assertReleaseReady(manifest, intent).productionApproval, false);
  fs.writeFileSync(keyFile, 'not the production public key');
  assert.throws(() => assertReleaseReady(manifest, intent), /Production descriptor key differs/);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.19' }));
  assert.throws(() => assertReleaseReady(manifest, intent), /Publication version differs/);
});
test('R3 receipts cannot qualify; current scoped evidence must retain broader nonacceptance flags', t => {
  const fixture = finalFixture(), prior = structuredClone(fixture.value);
  prior.kind = 'windows-016-r3-qualified-draft';
  assert.throws(() => q.validateFinalQualification(prior));
  for (const [document, field, invalid] of [['report', 'migrationAccepted', true], ['report', 'cancelAccepted', false],
    ['update', 'nativeAcceptance', true], ['binding', 'readbackVerified', false]]) {
    const changed = structuredClone(fixture.value), before = changed.proofs.combined.documents[document];
    const data = JSON.parse(Buffer.from(before.base64, 'base64')); data[field] = invalid;
    changed.proofs.combined.documents[document] = finalDocument(before.member, data);
    assert.throws(() => q.validateFinalQualification(changed));
  }
  assert.equal(loadFinal(t, fixture).loaded.productionApproval, false);
});
function checkoutCiFixture() {
  const p = q.FINAL_SOURCE_CI;
  return { runId: p.runId, runAttempt: p.runAttempt, workflow: p.workflow, sourceCommit: q.FINAL_SOURCE.commit,
    sourceTree: q.FINAL_SOURCE.tree, scope: 'final-source-checkout', suite: 'mcp-npm',
    harnessCommit: p.harnessCommit, harnessTree: p.harnessTree, workflowBlobSha: p.workflowBlobSha,
    jobs: [{ id: p.jobId, name: 'mcp-npm-tests' }],
    artifact: { id: p.artifactId, name: 'windows-r6-mcp-npm-41705099186-2', size: p.artifactSize, sha256: p.artifactSha256 },
    report: finalDocument('mcp-npm-tests.log', Buffer.from('# tests 316\n# pass 316\n# fail 0\n# skipped 0\n# cancelled 0\n')),
    jobLog: finalDocument('github-job.log', Buffer.from(`productCommit=${q.FINAL_SOURCE.commit} productTree=${q.FINAL_SOURCE.tree} workflowCommit=${p.harnessCommit}\n`)) };
}
test('finite R6 CI separates workflow head from the exact checked-out product and rejects proof substitution', () => {
  const ci = checkoutCiFixture();
  const candidate = { sourceCommit: q.FINAL_SOURCE.commit, sourceTree: q.FINAL_SOURCE.tree };
  assert.notEqual(ci.harnessCommit, ci.sourceCommit); q.validateSourceCi(ci, candidate);
  for (const change of [v => { v.sourceCommit = q.FINAL_PARENT; }, v => { v.sourceTree = 'a'.repeat(40); },
    v => { v.harnessCommit = v.sourceCommit; }, v => { v.harnessTree = v.sourceTree; },
    v => { v.workflowBlobSha = 'b'.repeat(40); }, v => { v.workflow = '.github/workflows/ci.yml'; },
    v => { v.artifact.sha256 = 'c'.repeat(64); }, v => { v.runAttempt = 1; },
    v => { v.report = finalDocument('mcp-npm-tests.log', Buffer.from('# tests 316\n# pass 315\n# fail 1\n')); },
    v => { v.jobLog = finalDocument('github-job.log', Buffer.from('productCommit=wrong')); }]) {
    const bad = structuredClone(ci); change(bad); assert.throws(() => q.validateSourceCi(bad, candidate));
  }
});
test('finite checkout CI rejects tampered workflow bytes before trusting the npm artifact', async () => {
  const ci = checkoutCiFixture(), p = q.FINAL_SOURCE_CI, repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' };
  const records = {
    [`git/commits/${ci.sourceCommit}`]: { sha: ci.sourceCommit, tree: { sha: ci.sourceTree } },
    [`git/commits/${ci.harnessCommit}`]: { sha: ci.harnessCommit, tree: { sha: ci.harnessTree } },
    [`actions/runs/${ci.runId}`]: { id: ci.runId, run_attempt: 2, status: 'completed', conclusion: 'success',
      head_sha: ci.harnessCommit, path: ci.workflow, event: 'push', repository: repo, head_repository: repo },
    [`actions/jobs/${p.jobId}`]: { id: p.jobId, name: 'mcp-npm-tests', run_id: ci.runId, run_attempt: 2,
      head_sha: ci.harnessCommit, status: 'completed', conclusion: 'success', labels: ['windows-latest'] },
    [`git/trees/${ci.harnessTree}?recursive=1`]: { sha: ci.harnessTree, truncated: false,
      tree: [{ path: ci.workflow, type: 'blob', sha: ci.workflowBlobSha }] },
    [`git/blobs/${ci.workflowBlobSha}`]: { sha: ci.workflowBlobSha, encoding: 'base64', size: 7, content: Buffer.from('changed').toString('base64') },
  };
  const value = { candidate: { sourceCommit: q.FINAL_SOURCE.commit, sourceTree: q.FINAL_SOURCE.tree }, repository: repo.full_name, repositoryId: repo.id };
  const io = { request: async route => { assert.ok(records[route], route); return records[route]; },
    download: async () => { throw Error('Artifact must not be trusted after workflow drift'); } };
  await assert.rejects(q.verifySourceCi(ci, value, io), /workflow changed/);
  records[`actions/runs/${ci.runId}`].head_sha = ci.sourceCommit;
  await assert.rejects(q.verifySourceCi(ci, value, io), /Source CI head_sha/);
});
test('R6 requires exact source CI and refuses withdrawn R5/R4 source or binary evidence', t => {
  const fixture = finalFixture();
  assert.equal(loadFinal(t, fixture).loaded.sourceCi.sourceCommit, q.FINAL_SOURCE.commit);
  for (const change of [v => { v.version = '0.1.16'; }, v => { v.successor.version = '0.1.18'; },
    v => { v.sourceCi.scope = 'reviewed-version-only-predecessor'; },
    v => { v.sourceCi.sourceCommit = q.FINAL_PARENT; },
    v => { v.candidate.sourceCommit = q.FINAL_PARENT; },
    v => { v.candidate.sourceCommit = 'f262a5a06d19a1af327eb081f7c740971187b315'; },
    v => { v.proofs.incoming012.documents.report = finalDocument('old.json', { passed: true, to: { version: '0.1.16' } }); }]) {
    const bad = structuredClone(fixture.value); change(bad); assert.throws(() => q.validateFinalQualification(bad));
  }
});
test('release association is separately bound without self-reference or compiled-child claims', async t => {
  mockFinalSignatures(t);
  const fixture = finalFixture(), { loaded, file, sha256 } = loadFinal(t, fixture);
  assert.equal(JSON.stringify(loaded).includes(fixture.associationCommit), false);
  assert.throws(() => q.loadQualification(file, sha256), /qualification blocked/);
  assert.throws(() => q.loadQualification(file, sha256, q.FINAL_SOURCE.commit), /Association is not the compiled commit/);
  const comparison = fixture.responses.get(`compare/${q.FINAL_SOURCE.commit}...${fixture.associationCommit}`);
  for (const filename of ['README.md', 'docs/EXPERIMENTAL-UNIX-PACKAGING.md', 'docs/SETUP-SDK-4022-VS-1912-QUALIFICATION.md'])
    comparison.files.push({ filename, status: 'modified', sha: 'd'.repeat(40) });
  const result = await q.verifyRemote(loaded, fixture.io);
  assert.equal(result.releaseAssociationCommit, fixture.associationCommit);
  assert.equal(result.compiledSourceCommit, q.FINAL_SOURCE.commit); assert.equal(result.associationBuilt, false);
});
test('association rejects product edits, wrong parent, altered receipt and compiled-target substitution', async t => {
  mockFinalSignatures(t);
  for (const change of [f => { f.responses.get(`git/commits/${f.associationCommit}`).parents = [{ sha: q.FINAL_PARENT }]; },
    f => { f.responses.get(`compare/${q.FINAL_SOURCE.commit}...${f.associationCommit}`).files.push({ filename: 'src/app.js', status: 'modified', sha: 'd'.repeat(40) }); },
    f => { const c = f.responses.get(`compare/${q.FINAL_SOURCE.commit}...${f.associationCommit}`); c.total_commits = 2; },
    f => { const c = f.responses.get(`compare/${q.FINAL_SOURCE.commit}...${f.associationCommit}`), p = c.files.find(x => x.filename.endsWith('qualification.json')); f.responses.get(`git/blobs/${p.sha}`).content = Buffer.from('{}').toString('base64'); },
    f => { f.responses.get(`releases/${f.value.draft.id}`).target_commitish = q.FINAL_SOURCE.commit; }]) {
    const fixture = finalFixture(), { loaded } = loadFinal(t, fixture); change(fixture);
    await assert.rejects(q.verifyRemote(loaded, fixture.io));
  }
  const fixture = finalFixture(), changed = structuredClone(fixture.value); changed.releaseAssociation.built = true;
  assert.throws(() => q.validateFinalQualification(changed));
});
test('association attributes permit only exact qualification-byte preservation', () => {
  const before = Buffer.from('tests/fixtures/** -text\nsrc/example.rs text eol=lf\n');
  const good = Buffer.concat([before, Buffer.from('packaging/windows/*-qualification.json -text\n')]);
  q.checkAssociationAttributes(before, good);
  for (const bad of [before, Buffer.from(good.toString().replace('-qualification.json -text', '* -text')),
    Buffer.from(good.toString().replace('src/example.rs text eol=lf\n', '')),
    Buffer.concat([good, Buffer.from('*.rs text eol=crlf\n')])]) assert.throws(() => q.checkAssociationAttributes(before, bad));
});
test('published verification cannot authorize draft publication and still checks exact evidence', async t => {
  mockFinalSignatures(t);
  const fixture = finalFixture(), { loaded } = loadFinal(t, fixture);
  fixture.responses.get(`releases/${fixture.value.draft.id}`).draft = false;
  await assert.rejects(q.verifyRemote(loaded, fixture.io));
  const result = await q.verifyPublishedRemote(loaded, fixture.io);
  assert.equal(result.releaseIsPublic, true); assert.equal(result.productionApproval, false);
  assert.equal(result.publicAcceptance, false); assert.equal(result.releaseReady, false);
  fixture.responses.get(`actions/jobs/${fixture.value.proofs.incoming014.jobId}`).conclusion = 'failure';
  await assert.rejects(q.verifyPublishedRemote(loaded, fixture.io));
});
