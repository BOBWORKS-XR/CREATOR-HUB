'use strict';
// Historical candidates remain diagnostic-only. The active target requires its own exact receipt.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const zlib = require('node:zlib');
const R2 = Object.freeze({ installer: '7326d054ac23b7ac560e2c3488933203a33f0033586b1c33988ce7f316e4c51a',
  executable: 'fac846563720eb4dae665a814ea28d0556800ebaf75aba7e8ee0be7f1979a5cd',
  inventory: 'bd07866cc0c80eb433ce963862b4c44e4d6712616e80b5ce06131e2306711288',
  sourceReceipt: 'a6eeac26841ad4dc7aa20e6480cc1ff185e0aa0458fa6611b70d681e812844e9' });
const KNOWN = Object.freeze({
  fresh: { run: 41446266226, artifact: 13142841380, size: 174176, archive: '5ad9b33ab24ac96fcf50036e5d4f1c3a89b9a392e723cbbab7bfb0508044bd34', source: 'bd980ed2b02ba5d00bce25d156d67f6a2f45253d', report: 'd4ac8fdb5bc1e5663340bb1739177016d55e7b195092f0b8a6adce521bc0f890' },
  guarded: { run: 41446279999, artifact: 13141378666, size: 1663, archive: 'fdb495ef67f1f20af952eaa8231d71127ee7faecebd70d24bd0ae76442d05993', source: 'bd980ed2b02ba5d00bce25d156d67f6a2f45253d', report: '940225a571fd132598a05e139d94570e0ba0cfe438fa07d3c3fa56133a7333a1' },
  migration: { run: 41446636278, artifact: 13143071592, size: 44237, archive: 'feace54e02aec1ffc08fff0dff06a641efd173fc477363a16184796beea4a6ba', source: 'd0833ce8ba92f6ce741ceb55bdc1f97ae3e6b039', report: '9600195c6f4fe62a1e54d8b567fa376f605907f766828c836ac0dba533891bd2' },
  incoming014: { run: 41448362951, artifact: 13144130617, size: 181708, archive: '9e9481568b22087bb2f40540bc516457bff0a1a58f7d0a522b2f64b906f1b272', source: '1f5abcfd34c05acf3e60f8c776f49df1b08d5fc2', report: '5bab02bcc61a228f0282c5a21e70e868230f7684634ff3147fe310c7ce9a032a' },
  incoming012: { run: 41452543111, artifact: 13146260575, size: 185022, archive: '2256222b461203544180ed7c5129ff399ddece28c526c5af7b9dae36b65d5304', source: 'dd7e3520a2c351820ae433b9c1c53d574a3ff4d7', report: 'a7762c5177ab63b4b52aefc38ec6110390b388853f4e24f2b310d99549dd2e39' },
});
const MISSING = Object.freeze(['reviewed production descriptor/signature and draft asset pins', 'same-profile combined evidence pins']);
const INCOMING_DIAGNOSTIC = Object.freeze({ run: 41611970939, job: 125835854922, artifact: 13219741534, size: 229748,
  source: '66ed5be85be22497fe5c3df713bdb6a1fc9f39a9', tree: '1399d49450ae05670e1d2fc3e45cd27eb7d65f4d',
  archive: 'cc72108b4db580a33540d0436db2d9b2c2bf231e8193f04d9c481cf241b9f8c6',
  migration: '2c23eb7c2185073c0d2d27a58a6a2d7f2ced79e890fedd3df008583e70da52d9',
  update: '119ccda8692132a89a3e398180138567d78ac0e016ffea03fcef3d06a9454baa',
  lifecycle: 'c07a9540a23feb9b1f148baa4afa64e7e41d557cbcfb1e69b4f0917893c0d46c',
  fixture: '6e9a60aec498d4538c0a1a7e677d1b06718f8375ea95db29ef6e38fb5c6c1747',
  binding: '54342c1da1a37b73c84c588218c36d9b7622417a87c4d4fd0c7e68f45c9ea5e2' });
const DIAGNOSTIC = Object.freeze({ run: 41542685800, job: 125610516503, artifact: 13187342946, size: 198177,
  source: 'a4dbbc0b4064f52b4b66d4bb5e672a9447ba507b', tree: '411e398ffcd371d3b35aee2c684e61b41dac087d',
  archive: 'fd7d48ac98bf92abcc9d85114b71c462c4c348989a3caff428e20389e2dee1fb',
  report: 'd0f16c0342cbad7383049265e70db5fe6f1bd8ea39f11fd7cde150213e1654f4',
  migration: 'fc97a802f954a9a393a6844b4b88b66b1e451565bdc9bb6716244154233a3bf1',
  binding: 'a9dc720ced5397ed7e3873074b97e2602724164e500df91648f2d335aecac78b',
  lifecycle: '67c51e23cb773e17c1790d9e1be95df874e0b036c157a4904f201eda0ee3f612' });
const SOURCE_TREES = Object.freeze({
  bd980ed2b02ba5d00bce25d156d67f6a2f45253d: 'c01423cf8f96172ebf642971b00231358661be2d',
  d0833ce8ba92f6ce741ceb55bdc1f97ae3e6b039: '9f0dfe5d0f19616f57ea97d8e057380e165c32ad',
  '1f5abcfd34c05acf3e60f8c776f49df1b08d5fc2': 'a32f9e4ad55fd5332e60c33f6b43159292e56bcb',
  dd7e3520a2c351820ae433b9c1c53d574a3ff4d7: 'a3a41d1582a90cf67ab88b2d6a7ea7153bba61b8',
  '4a95cc2193ad158fd47e86e0370898d674c2d23d': 'f6d7b63ee6e1d6221aa254af903153d5d544775e',
  '96ed287c4c7aa56dc6594838d37a63cd0d7d5adf': 'bbadfb67ec9aa26e7a094e34e3854556362bc6c8'
});
const DETAILS = Object.freeze({
  fresh: { job: 125280004963, jobName: 'acceptance', name: 'windows-016-fresh-evidence-41446266226', report: 'fresh-016-report.json', binding: '75d18383a74f8ea23008688ecbd4680fc2336f29cf0dee4e31ca778d3e7d318a' },
  guarded: { job: 125280049019, jobName: 'acceptance', name: 'windows-016-guarded-evidence-41446279999', report: 'guarded-016-report.json', binding: '4354770e6a70e3954920e50d2f8738b4d547c8020394fcc934389c0d2af46914' },
  migration: { job: 125281263566, jobName: 'acceptance', name: 'windows-016-migration-evidence-41446636278', report: 'migration-016-report.json', binding: '8c3f44aa0a6a6a54d67c560cc0a26bea7c83fc89d69a8c7d1b7d4ef6076c9233' },
  incoming014: { job: 125287067025, jobName: 'acceptance', name: 'windows-016-incoming-evidence-41448362951', report: 'self-update-report.json', binding: 'dc5495f980e59525ef0f55e308689bc9caed0b1520c2aa2b5444a9117e64a1c7', lifecycle: 'b94aeb9ce67889e4742a3da53d8d61f17edbe484facc9be98cc8e61556214c53' },
  incoming012: { job: 125301047043, jobName: 'signed012', name: 'windows-016-signed012-evidence-41452543111-1', report: 'self-update-report.json', binding: 'c76d50a113f8b51901c062235b91441c34de22d5b8f197eca30bcd00fb6d3e3b', lifecycle: '17bcac88635ee2613d35af9e0417e7a963b10266fa4f41a1ae7fe79bb268c438', config: 'b0698f1b97f2fcd7d52f09b8e164faf06596ec542e03b096eba9d75719b697a7' }
});
const OUTGOING = Object.freeze({
  run: 41458205828, source: '4a95cc2193ad158fd47e86e0370898d674c2d23d',
  targetSource: 'e39d853f4207bbc8f250566064027c19d8eeb6e0',
  successor: Object.freeze({ descriptor: '50bbcc0dfe5a4d22900a65b046145a9f05b185a4f86333c37f6b4277aebe1b6f',
    descriptorSignature: '57df8ee478f8e159a983d2e598b4bbedef15f7eb375a68b4221c12854fcbb733',
    installer: '0a737147db5766e108ece53a6f6ffd5fad2d5d311058effacd4e07ae2d9bf219',
    executable: 'b98e7484bb7d3f2a9d3abb450446285eb24b42deeb31adf02a5694e1b16795a5',
    manifest: 'b80fba85744c023ed6d61a6442bd64d3031074d2d9d7ad9130d3c68e50ef3bf1' }),
  cases: Object.freeze({
    'mcp-restore': { tool: 'mcp', restore: true, job: 125320229663, artifact: 13148445806, size: 146697,
      archive: '22db602b31e03d3f73084b830ddafd878464aadb8297f544e46ee8852416414d', report: '147111538869728969e5c8f843daf213c22cce12541a45ae359966e8afe40455', lifecycle: '5a856f8fa4c74d7559e93ecbecab52250523ed7427db32c278405f59e6074322', binding: '024bb0c99edf70326737468df298be9d346af2f61c4b896ef47720613fa2d643' },
    'setup-restore': { tool: 'setup', restore: true, job: 125320229666, artifact: 13148631070, size: 137907,
      archive: '5f781cbaebbcda97d91be8e98fe80227c82cc02d3be37abed9653c2ffe9bd1ef', report: '2cfae8f967ff65e462c7ce6c2a9fb700f4fcea5b59c4ac513f7dbaac2896bafe', lifecycle: '13f1d9c6df027fe16951945b397c71cfb6dd6babcd08a395f25c6f816714b111', binding: 'ad1da887a4342358d640f88dc90c4a0d08afdcf412ec126e86c8729b6f728420' },
    'setup-no-restore': { tool: 'setup', restore: false, job: 125320229533, artifact: 13146944084, size: 130463,
      archive: '6926a7c26516134e8ca00fe3fb9c4f75bcdf730930f67c56eb3d8d195ebbf0d3', report: 'd5293b947f188ad9ec014dfc1a4dbaac1b51c04c98b6ac258baf9262fea6ba32', lifecycle: 'db40918c53e1394a125e362c4f866b507a5b6055467e9f27eadcf3965ce13eb7', binding: 'b8865ec50ff40efe871b1737af29badcf46d5a64687a4e714c5cfdd8af39447b' }
  }) });
const ASSETS = Object.freeze(['Creator.Hub_0.1.16_x64-setup.exe', 'Creator.Hub_0.1.16_x64-setup.exe.sig',
  'creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig', 'latest.json', 'SHA256SUMS.txt']);
// Observed draft evidence only; these pins do not authorize reuse or publication.
const OBSERVED_DRAFT = Object.freeze({ id: 432509311, source: '784fe4aa0d2cd5a4fe2b76b753334c71dc1d4116',
  tree: '689d61873ee5b64dddd9b493f17dddaba0ce3e28', assets: Object.freeze({
    'Creator.Hub_0.1.16_x64-setup.exe': { id: 705082978, size: 38213208, sha256: '7326d054ac23b7ac560e2c3488933203a33f0033586b1c33988ce7f316e4c51a' },
    'Creator.Hub_0.1.16_x64-setup.exe.sig': { id: 705082975, size: 424, sha256: 'ac3e184a47301b1e32452dab2473c28685cd412655d38f8ef24815ab34b5a352' },
    'creator-hub-windows-x86_64.json': { id: 705082981, size: 505, sha256: '818bcb983490e20ade5816b4dbb2f5ea98bcaa33484faefa7b9747d12d64b788' },
    'creator-hub-windows-x86_64.json.minisig': { id: 705082983, size: 316, sha256: 'c8cc58a35b6b8f8461e078110cbd72462566b19974ac13c547ca80edf5f860da' },
    'latest.json': { id: 705082976, size: 676, sha256: '986745ff133fbd8a4d4c5dc3de17cecafbc500e4af06badb323bf3a632476eea' },
    'SHA256SUMS.txt': { id: 705083009, size: 484, sha256: '310f4e50496d466fff524695e202b82297cabe28856e705a6192671643e9cde1' }
  }) });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const REUSE = Object.freeze({ testRun: 41452543111, testInputArtifact: 13144622811, assets: Object.freeze({
  'Creator.Hub_0.1.16_x64-setup.exe': { size: 38213208, sha256: R2.installer },
  'Creator.Hub_0.1.16_x64-setup.exe.sig': { size: 424, sha256: 'ac3e184a47301b1e32452dab2473c28685cd412655d38f8ef24815ab34b5a352' },
  'creator-hub-windows-x86_64.json': { size: 505, sha256: '818bcb983490e20ade5816b4dbb2f5ea98bcaa33484faefa7b9747d12d64b788' },
  'creator-hub-windows-x86_64.json.minisig': { size: 316, sha256: 'c8cc58a35b6b8f8461e078110cbd72462566b19974ac13c547ca80edf5f860da' },
  'latest.json': { size: 676, sha256: '986745ff133fbd8a4d4c5dc3de17cecafbc500e4af06badb323bf3a632476eea' },
}) });
function checkReuseApproval(reuse, pin, reviewedSha256) {
  assert.ok(reuse && Buffer.isBuffer(reuse.bytes) && reuse.bytes.length > 0 && reuse.bytes.length <= 32768, 'Explicit reuse approval required');
  assert.match(reuse.sha256 || '', /^[a-f0-9]{64}$/); assert.notEqual(reuse.sha256, '0'.repeat(64));
  assert.equal(sha(reuse.bytes), reuse.sha256, 'Reviewed reuse approval bytes differ');
  const approval = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reuse.bytes));
  assert.deepEqual(Object.keys(approval).sort(), ['assets', 'draftId', 'kind', 'productionPinsSha256', 'scope', 'testInputArtifact', 'testRun']);
  assert.equal(approval.kind, 'windows-016-tested-metadata-reuse-approval');
  assert.equal(approval.scope, 'production-draft-preflight-only');
  assert.equal(approval.testRun, REUSE.testRun); assert.equal(approval.testInputArtifact, REUSE.testInputArtifact);
  assert.equal(approval.draftId, pin.id); assert.equal(approval.productionPinsSha256, reviewedSha256);
  assert.deepEqual(approval.assets, REUSE.assets);
  for (const [name, expected] of Object.entries(REUSE.assets)) {
    assert.equal(pin.assets[name].size, expected.size, `Reuse size differs: ${name}`);
    assert.equal(pin.assets[name].sha256, expected.sha256, `Reuse hash differs: ${name}`);
  }
  return { provenance: 'controlled-012-test-signed-bytes', reuseApprovalSha256: reuse.sha256, productionApproval: false, releaseReady: false };
}
function checkCommitTree(source, commit) {
  assert.ok(Object.hasOwn(SOURCE_TREES, source)); assert.equal(commit.sha, source);
  assert.equal(commit.tree?.sha, SOURCE_TREES[source], 'Evidence source tree differs');
}
function readZipMember(zip, wanted, limit = 256 * 1024) {
  assert.ok(Buffer.isBuffer(zip) && zip.length <= 64 * 1024 * 1024);
  assert.ok(Number.isSafeInteger(limit) && limit > 0 && limit <= 64 * 1024 * 1024);
  assert.match(wanted, /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/);
  assert.ok(wanted.split('/').every(part => part !== '.' && part !== '..'));
  const exactPath = wanted.includes('/'), eocd = zip.lastIndexOf(Buffer.from('504b0506', 'hex'));
  assert.ok(eocd >= 0 && eocd + 22 <= zip.length); assert.equal(eocd + 22 + zip.readUInt16LE(eocd + 20), zip.length);
  assert.equal(zip.readUInt16LE(eocd + 4), 0); assert.equal(zip.readUInt16LE(eocd + 6), 0);
  const count = zip.readUInt16LE(eocd + 10), start = zip.readUInt32LE(eocd + 16);
  assert.ok(count > 0 && count <= 1000); assert.equal(count, zip.readUInt16LE(eocd + 8)); assert.equal(start + zip.readUInt32LE(eocd + 12), eocd);
  let offset = start, found = null; const names = new Set();
  for (let i = 0; i < count; i++) {
    assert.ok(offset + 46 <= eocd && zip.readUInt32LE(offset) === 0x02014b50);
    const flags = zip.readUInt16LE(offset + 8), method = zip.readUInt16LE(offset + 10), compressed = zip.readUInt32LE(offset + 20), size = zip.readUInt32LE(offset + 24);
    const n = zip.readUInt16LE(offset + 28), extra = zip.readUInt16LE(offset + 30), comment = zip.readUInt16LE(offset + 32), local = zip.readUInt32LE(offset + 42);
    const end = offset + 46 + n + extra + comment; assert.ok(end <= eocd);
    const name = zip.subarray(offset + 46, offset + 46 + n).toString('utf8');
    assert.ok(name && !name.startsWith('/') && !/[\\:\x00-\x1f\x7f]/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..'));
    assert.ok(!names.has(name.toLowerCase()), 'Duplicate archive member'); names.add(name.toLowerCase());
    if (exactPath ? name === wanted : name.split('/').at(-1) === wanted) {
      assert.equal(found, null, 'Ambiguous archive member'); assert.ok(!(flags & 1) && (method === 0 || method === 8));
      assert.ok(size > 0 && size <= limit && compressed <= limit && local + 30 <= start && zip.readUInt32LE(local) === 0x04034b50);
      assert.equal(zip.readUInt16LE(local + 6), flags); assert.equal(zip.readUInt16LE(local + 8), method);
      const nameLen = zip.readUInt16LE(local + 26), extraLen = zip.readUInt16LE(local + 28);
      assert.equal(zip.subarray(local + 30, local + 30 + nameLen).toString('utf8'), name);
      const data = local + 30 + nameLen + extraLen; assert.ok(data + compressed <= start);
      found = method === 0 ? Buffer.from(zip.subarray(data, data + compressed)) : zlib.inflateRawSync(zip.subarray(data, data + compressed), { maxOutputLength: limit });
      assert.equal(found.length, size);
    }
    offset = end;
  }
  assert.equal(offset, eocd); assert.ok(found, `Missing archive member: ${wanted}`); return found;
}
function checkDraftMetadata(draft, pin) {
  assert.ok(pin && Number.isSafeInteger(pin.id) && pin.id > 0 && pin.id !== 424919952 && pin.id !== 411494394);
  assert.equal(draft.id, pin.id); assert.equal(draft.tag_name, 'v0.1.16'); assert.equal(draft.draft, true); assert.equal(draft.prerelease, false);
  assert.ok(pin.assets && typeof pin.assets === 'object' && !Array.isArray(pin.assets));
  assert.deepEqual(Object.keys(pin.assets).sort(), [...ASSETS].sort());
  assert.equal(draft.assets.length, ASSETS.length); const ids = new Set();
  for (const name of ASSETS) {
    const expected = pin.assets[name]; assert.deepEqual(Object.keys(expected).sort(), ['id', 'sha256', 'size']);
    assert.ok(Number.isSafeInteger(expected.id) && expected.id > 0 && !ids.has(expected.id)); ids.add(expected.id);
    assert.ok(Number.isSafeInteger(expected.size) && expected.size > 0 && expected.size <= 256 * 1024 * 1024);
    if (/\.(?:sig|minisig)$/.test(name)) assert.ok(expected.size <= 4096);
    if (name === 'latest.json' || name === 'creator-hub-windows-x86_64.json') assert.ok(expected.size <= 32768);
    if (name === 'SHA256SUMS.txt') assert.ok(expected.size <= 8192);
    assert.match(expected.sha256, /^[a-f0-9]{64}$/);
    const found = draft.assets.filter(a => a.name === name); assert.equal(found.length, 1);
    const a = found[0]; assert.equal(a.id, expected.id); assert.equal(a.size, expected.size); assert.equal(a.state, 'uploaded');
    assert.equal(a.digest, `sha256:${expected.sha256}`);
  }
  assert.equal(pin.assets[ASSETS[0]].sha256, R2.installer); assert.equal(pin.assets[ASSETS[0]].size, 38213208);
  assert.equal(pin.assets['creator-hub-windows-x86_64.json'].sha256, '818bcb983490e20ade5816b4dbb2f5ea98bcaa33484faefa7b9747d12d64b788');
  return { draftMetadataMatches: true, releaseReady: false };
}
function verifyR2Payload({ descriptor, descriptorSignature, installer, installerSignature, latest }) {
  const { verifySignature } = require('./linux-016-release-qualification.cjs');
  const { updaterManifest, applications } = require('./release-descriptor.cjs');
  for (const body of [descriptor, descriptorSignature, installer, installerSignature, latest]) assert.ok(Buffer.isBuffer(body));
  assert.ok(descriptor.length > 0 && descriptor.length <= 32768 && latest.length > 0 && latest.length <= 32768);
  assert.ok(descriptorSignature.length > 0 && descriptorSignature.length <= 4096 && installerSignature.length > 0 && installerSignature.length <= 4096);
  assert.equal(installer.length, 38213208); assert.equal(sha(installer), R2.installer);
  assert.equal(sha(descriptor), '818bcb983490e20ade5816b4dbb2f5ea98bcaa33484faefa7b9747d12d64b788');
  assert.deepEqual(JSON.parse(descriptor), { schemaVersion: 1, appId: 'creator-hub', version: '0.1.16', platform: 'windows',
    architecture: 'x86_64', packageType: 'nsis', assetName: 'Creator.Hub_0.1.16_x64-setup.exe', byteLength: 38213208,
    sha256: R2.installer, executableSha256: R2.executable, identityProtocol: 0, lifecycleProtocol: 0,
    installerProtocol: 1, minHubVersion: '0.1.12' });
  verifySignature(descriptor, descriptorSignature);
  const signatureText = new TextDecoder('utf-8', { fatal: true }).decode(installerSignature);
  const doc = JSON.parse(latest), encoded = doc.platforms?.['windows-x86_64']?.signature;
  assert.ok(typeof encoded === 'string' && encoded.length > 0);
  assert.ok(signatureText === encoded || signatureText === `${encoded}\n` || signatureText === `${encoded}\r\n`, 'Standalone signature differs from updater manifest');
  const decoded = Buffer.from(encoded, 'base64');
  assert.equal(decoded.toString('base64'), encoded); verifySignature(installer, decoded);
  assert.equal(doc.version, '0.1.16');
  assert.deepEqual(doc.platforms, updaterManifest(applications.hub, '0.1.16', 'Creator.Hub_0.1.16_x64-setup.exe', encoded).platforms);
  return { descriptorVerified: true, installerVerified: true, productionApproval: false, releaseReady: false };
}
function checkTestOnlyPayload(input) {
  assert.equal(sha(input.descriptorSignature), 'c8cc58a35b6b8f8461e078110cbd72462566b19974ac13c547ca80edf5f860da');
  assert.equal(sha(input.latest), '986745ff133fbd8a4d4c5dc3de17cecafbc500e4af06badb323bf3a632476eea');
  verifyR2Payload(input);
  return { testOnlyDescriptorVerified: true, productionApproval: false, releaseReady: false };
}
function checkProductionPins(pin, reviewedSha256, reuse) {
  assert.match(reviewedSha256 || '', /^[a-f0-9]{64}$/, 'Independent production pin digest required');
  assert.notEqual(reviewedSha256, '0'.repeat(64));
  assert.ok(pin && typeof pin === 'object' && !Array.isArray(pin));
  assert.deepEqual(Object.keys(pin).sort(), ['assets', 'id', 'kind']);
  assert.equal(pin.kind, 'windows-016-production-draft-pins');
  assert.equal(sha(Buffer.from(JSON.stringify(pin))), reviewedSha256, 'Independently reviewed production pins differ');
  assert.ok(pin.assets && typeof pin.assets === 'object' && !Array.isArray(pin.assets));
  assert.deepEqual(Object.keys(pin.assets).sort(), [...ASSETS].sort());
  const draft = { id: pin.id, tag_name: 'v0.1.16', draft: true, prerelease: false,
    assets: ASSETS.map(name => ({ name, id: pin.assets[name].id, size: pin.assets[name].size,
      digest: `sha256:${pin.assets[name].sha256}`, state: 'uploaded' })) };
  checkDraftMetadata(draft, pin);
  const testSignature = pin.assets['creator-hub-windows-x86_64.json.minisig'].sha256 === REUSE.assets['creator-hub-windows-x86_64.json.minisig'].sha256;
  const testManifest = pin.assets['latest.json'].sha256 === REUSE.assets['latest.json'].sha256;
  if (reuse) checkReuseApproval(reuse, pin, reviewedSha256);
  else { assert.equal(testSignature, false, 'Test-only signature cannot authorize production');
    assert.equal(testManifest, false, 'Test-only manifest cannot authorize production'); }
  return { productionPinsMatched: true, productionApproval: false, releaseReady: false };
}
function checkProductionPayload(input, pin, reviewedSha256, reuse) {
  checkProductionPins(pin, reviewedSha256, reuse);
  for (const [key, name] of Object.entries({ descriptor: 'creator-hub-windows-x86_64.json',
    descriptorSignature: 'creator-hub-windows-x86_64.json.minisig', installer: ASSETS[0], installerSignature: ASSETS[1], latest: 'latest.json' })) {
    assert.ok(Buffer.isBuffer(input[key])); assert.equal(input[key].length, pin.assets[name].size); assert.equal(sha(input[key]), pin.assets[name].sha256);
  }
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(input.descriptorSignature).trimEnd().split(/\r?\n/);
  if (!reuse) assert.notEqual(sha(Buffer.from(lines.slice(1).join('\n'))), '5f6fc2ae6261f985281130524ba50745e4a25f340f77699f5eabac9ca61d67c1',
    'Test-only signature cannot authorize production');
  const canonicalLatest = JSON.stringify(JSON.parse(input.latest));
  if (!reuse) assert.notEqual(sha(Buffer.from(canonicalLatest)), 'eccb1186fbc4c6c5bc302bafa4c837c206320fafb74ea309c3fe6b08f3acce07',
    'Test-only manifest cannot authorize production');
  return verifyR2Payload(input);
}
function checkDraftBytes(pin, reviewedSha256, bodies, reuse) {
  checkProductionPins(pin, reviewedSha256, reuse);
  assert.ok(bodies && typeof bodies === 'object' && !Array.isArray(bodies));
  assert.deepEqual(Object.keys(bodies).sort(), [...ASSETS].sort());
  for (const name of ASSETS) {
    const bytes = bodies[name], record = pin.assets[name];
    assert.ok(Buffer.isBuffer(bytes)); assert.equal(bytes.length, record.size); assert.equal(sha(bytes), record.sha256, `Draft asset differs: ${name}`);
  }
  checkProductionPayload({ descriptor: bodies['creator-hub-windows-x86_64.json'], descriptorSignature: bodies['creator-hub-windows-x86_64.json.minisig'],
    installer: bodies[ASSETS[0]], installerSignature: bodies[ASSETS[1]], latest: bodies['latest.json'] }, pin, reviewedSha256, reuse);
  const sums = ASSETS.filter(name => name !== 'SHA256SUMS.txt').sort().map(name => `${pin.assets[name].sha256}  ${name}\n`).join('');
  assert.equal(bodies['SHA256SUMS.txt'].toString('utf8'), sums, 'Checksum file must cover exactly the five product assets');
  return { exactAssetBytes: true, signaturesVerified: true, ...(reuse ? checkReuseApproval(reuse, pin, reviewedSha256) : {}), productionApproval: false, releaseReady: false };
}
async function checkDraftReadback(pin, reviewedSha256, io, reuse) {
  checkProductionPins(pin, reviewedSha256, reuse);
  assert.ok(io && typeof io.request === 'function' && typeof io.download === 'function');
  assert.ok(pin && Number.isSafeInteger(pin.id) && pin.id > 0 && pin.id !== 424919952 && pin.id !== 411494394, 'Approved non-validation draft ID required');
  const before = await io.request(`releases/${pin.id}`); checkDraftMetadata(before, pin);
  const bodies = {};
  for (const name of ASSETS) bodies[name] = await io.download(`releases/assets/${pin.assets[name].id}`, pin.assets[name].size + 1);
  const result = checkDraftBytes(pin, reviewedSha256, bodies, reuse);
  const after = await io.request(`releases/${pin.id}`); checkDraftMetadata(after, pin);
  return result;
}
function checkKnownReport(role, bytes) {
  assert.ok(Object.hasOwn(KNOWN, role)); assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 256 * 1024);
  assert.equal(sha(bytes), KNOWN[role].report, 'Retained report bytes differ');
  const r = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  assert.equal(r.passed, true); assert.equal(r.releaseReady, false);
  if (role === 'incoming014' || role === 'incoming012') {
    assert.deepEqual(r.to, { version: '0.1.16', installer: R2.installer, exe: R2.executable });
    assert.equal(r.from.version, role === 'incoming014' ? '0.1.14' : '0.1.12');
    assert.equal(r.selfUpdateTested, true); assert.equal(r.managedRouteReconnectTested, true); assert.equal(r.policyRestored, true);
    assert.equal(r.publicDiscovery, false); assert.equal(r.userMachineUsed, false);
    if (role === 'incoming012') {
      assert.equal(r.testOnlyDescriptor, true); assert.equal(r.discoveryKind, 'controlled-lab-not-public-discovery');
      assert.equal(r.feed.pins.descriptor, '818bcb983490e20ade5816b4dbb2f5ea98bcaa33484faefa7b9747d12d64b788');
    } else assert.equal(r.sourceKind, 'unmodified-public-stable');
  } else {
    assert.equal(r.installerSha256, R2.installer); assert.equal(r.executableSha256, R2.executable);
    assert.equal(r.buildInputDigest, R2.inventory); assert.equal(r.productSource, `source-receipt-sha256:${R2.sourceReceipt}`);
    assert.equal(r.sourceUnchanged, true); assert.equal(r.settingsPreserved, true);
    if (role === 'fresh') { assert.equal(r.freshInstallAccepted, true); assert.equal(r.manualNormalRestartAccepted, true); }
    if (role === 'guarded') { assert.equal(r.scope, 'exact-public14-to-direct16-guarded-nsis-only'); assert.equal(r.guardedInstallerAccepted, true); }
    if (role === 'migration') { assert.equal(r.scope, 'exact-direct16-three-client-clean-legacy-guide-probe'); assert.equal(r.nativeGuideAccepted, true); assert.equal(r.repeatStartupAccepted, true); }
  }
  return r;
}
function checkKnownProof(role, run, artifact, archive, reportMember, reportBytes, inspectArchive) {
  assert.ok(Object.hasOwn(KNOWN, role)); const pin = KNOWN[role];
  assert.equal(run.id, pin.run); assert.equal(run.run_attempt, 1); assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success'); assert.equal(run.head_sha, pin.source);
  assert.equal(run.path, '.github/workflows/windows-incoming-016.yml'); assert.equal(run.head_branch, 'validation/windows-menu-merge-20261027');
  for (const repo of [run.repository, run.head_repository]) { assert.equal(repo.id, 1364807512); assert.equal(repo.full_name, 'BOBWORKS-XR/CREATOR-HUB'); }
  assert.equal(artifact.id, pin.artifact); assert.equal(artifact.expired, false); assert.equal(artifact.size_in_bytes, pin.size);
  assert.equal(artifact.digest, `sha256:${pin.archive}`); assert.equal(artifact.workflow_run.id, pin.run); assert.equal(artifact.workflow_run.head_sha, pin.source);
  assert.ok(Buffer.isBuffer(archive)); assert.equal(archive.length, pin.size); assert.equal(sha(archive), pin.archive);
  assert.ok(typeof reportMember === 'string' && /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.json$/.test(reportMember) && !reportMember.split('/').includes('..'));
  assert.equal(inspectArchive(archive)[reportMember], pin.report); return checkKnownReport(role, reportBytes);
}
function checkExistingRemote(role, run, job, artifact, archive) {
  assert.ok(Object.hasOwn(KNOWN, role)); const pin = KNOWN[role], detail = DETAILS[role];
  assert.equal(run.id, pin.run); assert.equal(run.run_attempt, 1); assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
  assert.equal(run.event, 'workflow_dispatch'); assert.equal(run.head_sha, pin.source); assert.equal(run.head_branch, 'validation/windows-menu-merge-20261027');
  assert.equal(run.path, '.github/workflows/windows-incoming-016.yml');
  for (const repo of [run.repository, run.head_repository]) { assert.equal(repo.id, 1364807512); assert.equal(repo.full_name, 'BOBWORKS-XR/CREATOR-HUB'); }
  assert.equal(job.id, detail.job); assert.equal(job.name, detail.jobName); assert.equal(job.run_id, pin.run); assert.equal(job.run_attempt, 1);
  assert.equal(job.head_sha, pin.source); assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success'); assert.ok(job.labels.includes('windows-latest'));
  assert.equal(artifact.id, pin.artifact); assert.equal(artifact.name, detail.name); assert.equal(artifact.expired, false);
  assert.equal(artifact.size_in_bytes, pin.size); assert.equal(artifact.digest, `sha256:${pin.archive}`);
  for (const [key, value] of Object.entries({ id: pin.run, head_sha: pin.source, repository_id: 1364807512, head_repository_id: 1364807512 })) assert.equal(artifact.workflow_run[key], value);
  const times = [job.started_at, artifact.created_at, job.completed_at].map(Date.parse);
  assert.ok(times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2], 'Artifact must be created by the pinned job interval');
  assert.ok(Buffer.isBuffer(archive)); assert.equal(archive.length, pin.size); assert.equal(sha(archive), pin.archive);
  const report = checkKnownReport(role, readZipMember(archive, detail.report));
  const bindingBytes = readZipMember(archive, 'input-binding.json'); assert.equal(sha(bindingBytes), detail.binding);
  const binding = JSON.parse(bindingBytes); assert.equal(binding.harnessSource, pin.source);
  if (['fresh', 'guarded', 'migration'].includes(role)) {
    assert.equal(binding.artifactId, 13141988162); assert.equal(binding.runId, 41446190810);
    assert.equal(binding.artifactSource, KNOWN.fresh.source); assert.equal(binding.archiveSha256, 'fabe440d1108114a0ca810a1115a29e19c08e7a77f30aa370d46a3cb2481a53e');
  } else if (role === 'incoming014') {
    assert.equal(binding.runId, 41448285787); assert.equal(binding.artifactId, 13143820688); assert.equal(binding.artifactSource, pin.source);
    assert.equal(binding.archiveSha256, '2a430ded3715f28d6b0203afd41dd1986d603c7dd4998a388f74b6a8219b6f84');
  } else {
    assert.equal(binding.runId, 41450817062); assert.equal(binding.artifactId, 13144622811);
    assert.equal(binding.artifactSource, '96ed287c4c7aa56dc6594838d37a63cd0d7d5adf');
    assert.equal(binding.archiveSha256, '618ca22a26b52b5cf7a95b75b60e15ceec39a2f436c58cc7ba2ccc8c6744ee6a');
    assert.equal(binding.testOnlyDescriptor, true); assert.equal(binding.releaseReady, false);
    assert.equal(sha(readZipMember(archive, 'config.json')), detail.config);
  }
  if (detail.lifecycle) {
    const lifecycle = readZipMember(archive, 'lifecycle.jsonl'); assert.equal(sha(lifecycle), detail.lifecycle);
    const rows = lifecycle.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(row => row.kind === 'lab-lifecycle-result');
    assert.equal(rows.length, 1); const result = rows[0];
    for (const key of ['lifecycleSucceeded', 'cleanupVerified', 'systemTlsVerified', 'labDiscovery']) assert.equal(result[key], true);
    for (const key of ['publicDiscovery', 'productAcceptance', 'liveAiAcceptance', 'releaseReady']) assert.equal(result[key], false);
    assert.equal(result.driverExitCode, 0); assert.equal(result.rejectedRequestCount, 0);
    if (role === 'incoming012') {
      assert.equal(result.actualScope, 'unmodified-public-0.1.12-lab-only'); assert.equal(result.servedRouteCount, 7);
      assert.deepEqual(result.syntheticDiscovery, { mcp: 1, setup: 1 }); assert.equal(report.testOnlyDescriptor, true);
    } else { assert.equal(result.actualScope, 'exact-public14-to-direct16-lab-only'); assert.equal(result.servedRouteCount, 5); }
  }
  return { role, archiveVerified: true, testOnlyDescriptor: role === 'incoming012', releaseReady: false };
}
async function verifyExistingEvidence(io) {
  assert.ok(io && typeof io.request === 'function' && typeof io.download === 'function');
  const verified = [], checkedCommits = new Set();
  const commit = async source => { if (!checkedCommits.has(source)) { checkCommitTree(source, await io.request(`git/commits/${source}`)); checkedCommits.add(source); } };
  for (const [role, pin] of Object.entries(KNOWN)) {
    const run = await io.request(`actions/runs/${pin.run}`), job = await io.request(`actions/jobs/${DETAILS[role].job}`);
    const artifact = await io.request(`actions/artifacts/${pin.artifact}`), archive = await io.download(`actions/artifacts/${pin.artifact}/zip`, pin.size + 1);
    verified.push(checkExistingRemote(role, run, job, artifact, archive)); await commit(pin.source);
  }
  const outgoingRun = await io.request(`actions/runs/${OUTGOING.run}`);
  for (const [name, pin] of Object.entries(OUTGOING.cases)) {
    const job = await io.request(`actions/jobs/${pin.job}`), artifact = await io.request(`actions/artifacts/${pin.artifact}`);
    const archive = await io.download(`actions/artifacts/${pin.artifact}/zip`, pin.size + 1);
    verified.push(checkOutgoingProvenance(name, outgoingRun, job, artifact, archive, readZipMember));
  }
  await commit(OUTGOING.source);
  const source = '96ed287c4c7aa56dc6594838d37a63cd0d7d5adf';
  const stager = await io.request('actions/runs/41450817062'), inputArtifact = await io.request('actions/artifacts/13144622811');
  assert.equal(stager.id, 41450817062); assert.equal(stager.run_attempt, 1); assert.equal(stager.event, 'workflow_dispatch');
  assert.equal(stager.status, 'completed'); assert.equal(stager.conclusion, 'success'); assert.equal(stager.head_sha, source);
  assert.equal(stager.head_branch, 'validation/windows-menu-merge-20261027'); assert.equal(stager.path, '.github/workflows/windows-016-input.yml');
  await commit(source);
  for (const repo of [stager.repository, stager.head_repository]) { assert.equal(repo.id, 1364807512); assert.equal(repo.full_name, 'BOBWORKS-XR/CREATOR-HUB'); }
  assert.equal(inputArtifact.id, 13144622811); assert.equal(inputArtifact.name, 'windows-016-acceptance-input'); assert.equal(inputArtifact.expired, false);
  assert.equal(inputArtifact.size_in_bytes, 38215321); assert.equal(inputArtifact.digest, 'sha256:618ca22a26b52b5cf7a95b75b60e15ceec39a2f436c58cc7ba2ccc8c6744ee6a');
  for (const [key, value] of Object.entries({ id: 41450817062, head_sha: source, repository_id: 1364807512, head_repository_id: 1364807512 })) assert.equal(inputArtifact.workflow_run[key], value);
  const inputArchive = await io.download('actions/artifacts/13144622811/zip', 38215322);
  assert.ok(Buffer.isBuffer(inputArchive)); assert.equal(inputArchive.length, 38215321); assert.equal(sha(inputArchive), '618ca22a26b52b5cf7a95b75b60e15ceec39a2f436c58cc7ba2ccc8c6744ee6a');
  const descriptor = readZipMember(inputArchive, 'creator-hub-windows-x86_64.json');
  const descriptorSignature = readZipMember(inputArchive, 'creator-hub-windows-x86_64.json.minisig');
  assert.equal(sha(descriptorSignature), 'c8cc58a35b6b8f8461e078110cbd72462566b19974ac13c547ca80edf5f860da');
  const latest = readZipMember(inputArchive, 'latest.json'), installer = readZipMember(inputArchive, 'Creator.Hub_0.1.16_x64-setup.exe', 64 * 1024 * 1024);
  const installerSignature = Buffer.from(JSON.parse(latest).platforms['windows-x86_64'].signature);
  checkTestOnlyPayload({ descriptor, descriptorSignature, installer, installerSignature, latest });
  return { verified, testOnlyDescriptorVerified: true, combinedMigrationProven: false, publicDraftVerified: false, productionApproval: false, releaseReady: false };
}
function checkOutgoingCase(caseName, reportBytes, lifecycleBytes, bindingBytes) {
  assert.ok(Object.hasOwn(OUTGOING.cases, caseName)); const pin = OUTGOING.cases[caseName];
  for (const [bytes, expected] of [[reportBytes, pin.report], [lifecycleBytes, pin.lifecycle], [bindingBytes, pin.binding]]) {
    assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 256 * 1024); assert.equal(sha(bytes), expected);
  }
  const report = JSON.parse(reportBytes), binding = JSON.parse(bindingBytes);
  const lifecycle = lifecycleBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(report.kind, 'direct-outgoing-016-017'); assert.equal(report.sourceCommit, OUTGOING.targetSource);
  assert.deepEqual(report.baseline, { version: '0.1.16', installer: R2.installer, exe: R2.executable });
  assert.deepEqual(report.pins, OUTGOING.successor); assert.equal(report.lastTool, pin.tool); assert.equal(report.restore, pin.restore);
  assert.equal(report.restoredLastTool, pin.restore ? pin.tool : null); assert.equal(report.migrationDeferred, true);
  for (const key of ['passed', 'nativeUpdateAccepted', 'automaticRestart', 'cancelPreserved', 'settingsPreserved', 'existingConnectionSurvived', 'newConnectionVerified', 'restorationVerified', 'policyRestored', 'labDiscovery', 'acceptanceOnly']) assert.equal(report[key], true);
  for (const key of ['publicDiscovery', 'liveAiAcceptance', 'releaseReady']) assert.equal(report[key], false);
  assert.deepEqual(report.beforePeVersion, [0, 1, 16, 0]); assert.deepEqual(report.afterPeVersion, [0, 1, 17, 0]);
  const rows = lifecycle.filter(row => row.kind === 'lab-lifecycle-result'); assert.equal(rows.length, 1); const result = rows[0];
  for (const key of ['lifecycleSucceeded', 'cleanupVerified', 'systemTlsVerified', 'labDiscovery']) assert.equal(result[key], true);
  for (const key of ['publicDiscovery', 'productAcceptance', 'liveAiAcceptance', 'releaseReady']) assert.equal(result[key], false);
  assert.equal(result.scenario, 'direct-outgoing-016-017'); assert.equal(result.actualScope, 'exact-direct16-to-root-only17-acceptance-fixture-lab-only');
  assert.equal(result.driverExitCode, 0); assert.equal(result.servedRouteCount, 5); assert.equal(result.rejectedRequestCount, 0);
  assert.equal(binding.harnessRun, String(OUTGOING.run)); assert.equal(binding.harnessSource, OUTGOING.source);
  assert.equal(binding.attempt, '1'); assert.equal(binding.case, caseName); assert.equal(binding.reportSha256, pin.report); assert.equal(binding.lifecycleSha256, pin.lifecycle);
  assert.equal(binding.artifactId, 13147427412); assert.equal(binding.runId, 41458124135);
  assert.equal(binding.archiveSha256, '6861cb447f1416a9e2a6a7ab14796cb601896dce934a62fee3dec998006ab73c');
  for (const key of ['nativeAccepted', 'acceptanceOnly']) assert.equal(binding[key], true); assert.equal(binding.releaseReady, false);
  return { case: caseName, scope: 'acceptance-only-outgoing', combinedMigrationProven: false, changedGenerationProven: false, releaseReady: false };
}
function checkOutgoingProvenance(caseName, run, job, artifact, archive, readMember) {
  assert.ok(Object.hasOwn(OUTGOING.cases, caseName)); const pin = OUTGOING.cases[caseName];
  assert.equal(run.id, OUTGOING.run); assert.equal(run.run_attempt, 1); assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success'); assert.equal(run.head_sha, OUTGOING.source);
  assert.equal(run.path, '.github/workflows/windows-outgoing-017.yml'); assert.equal(run.head_branch, 'validation/windows-menu-merge-20261027');
  for (const repo of [run.repository, run.head_repository]) { assert.equal(repo.id, 1364807512); assert.equal(repo.full_name, 'BOBWORKS-XR/CREATOR-HUB'); }
  assert.equal(job.id, pin.job); assert.equal(job.run_id, OUTGOING.run); assert.equal(job.run_attempt, 1); assert.equal(job.head_sha, OUTGOING.source);
  assert.equal(job.name, `acceptance (${caseName}, ${pin.tool}, ${pin.restore})`); assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success');
  assert.ok(job.labels.includes('windows-latest'));
  assert.equal(artifact.id, pin.artifact); assert.equal(artifact.name, `windows-outgoing-017-${caseName}-evidence-${OUTGOING.run}-1`);
  assert.equal(artifact.expired, false); assert.equal(artifact.size_in_bytes, pin.size); assert.equal(artifact.digest, `sha256:${pin.archive}`);
  for (const [key, value] of Object.entries({ id: OUTGOING.run, head_sha: OUTGOING.source, repository_id: 1364807512, head_repository_id: 1364807512 })) assert.equal(artifact.workflow_run[key], value);
  const times = [job.started_at, artifact.created_at, job.completed_at].map(Date.parse);
  assert.ok(times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2]);
  assert.ok(Buffer.isBuffer(archive)); assert.equal(archive.length, pin.size); assert.equal(sha(archive), pin.archive);
  return checkOutgoingCase(caseName, readMember(archive, 'outgoing-report.json'), readMember(archive, 'lifecycle.jsonl'), readMember(archive, 'acceptance-binding.json'));
}
function checkDiagnosticContents(report, migration, binding, lifecycle) {
  assert.equal(report.kind, 'mixed-public-migration-controlled-outgoing-diagnostic');
  assert.equal(report.passed, true); assert.equal(report.sourceCommit, OUTGOING.targetSource);
  assert.deepEqual(report.baseline, { version: '0.1.16', installer: R2.installer, exe: R2.executable });
  assert.deepEqual(report.pins, OUTGOING.successor);
  for (const key of ['migratedContinuation', 'cancelPreserved', 'automaticRestart', 'outgoingConnectionSurvived', 'newConnectionVerified',
    'migratedFixtureFilesUnchangedAfterDriverCleanup', 'activeRouteUnchangedAfterCancel', 'policyRestored']) assert.equal(report[key], true, key);
  for (const key of ['automaticRouteTransitionProven', 'changedMcpGenerationProven', 'migrationNetworkObserved', 'combinedAcceptance',
    'nativeUpdateAccepted', 'liveAiAcceptance', 'releaseReady']) assert.equal(report[key], false, key);
  assert.equal(report.migratedFixtureFilesChecked, 23); assert.equal(report.migrationRunId, String(DIAGNOSTIC.run));
  assert.equal(report.migrationRunAttempt, '1'); assert.equal(report.migrationHarnessSource, DIAGNOSTIC.source);
  assert.equal(report.migrationReportSha256, DIAGNOSTIC.migration);
  assert.equal(report.successorRouteObservation, 'after-explicit-client-review');
  assert.equal(report.preReviewRoute.descriptorSha256, '2bd6e4f9c80a051b9b4dd4c57a253a30d325136c6cd2605e81c603dad65fcb3d');
  assert.deepEqual(report.preReviewRoute, report.beforeRoute);
  assert.equal(report.successorRouteAfterExplicitReview.descriptorSha256, '1e53158ae6bffe842c7256c1b40a44d59c2d0a6d3f03b5506b1e5f17584d6fda');
  assert.deepEqual(report.afterRoute, report.successorRouteAfterExplicitReview);
  assert.equal(migration.passed, true); assert.equal(migration.releaseReady, false);
  assert.equal(migration.scope, 'exact-direct16-three-client-clean-legacy-guide-probe');
  assert.equal(binding.kind, report.kind); assert.equal(binding.diagnosticPassed, true); assert.equal(binding.runId, String(DIAGNOSTIC.run));
  assert.equal(binding.source, DIAGNOSTIC.source); assert.equal(binding.reportSha256, DIAGNOSTIC.report);
  assert.equal(binding.migrationReportSha256, DIAGNOSTIC.migration); assert.equal(binding.lifecycleSha256, DIAGNOSTIC.lifecycle);
  assert.deepEqual(binding.preReviewRoute, report.preReviewRoute); assert.deepEqual(binding.successorRouteAfterExplicitReview, report.afterRoute);
  assert.equal(binding.successorRouteObservation, 'after-explicit-client-review');
  for (const key of ['migrationNetworkObserved', 'isolationProven', 'combinedAcceptance', 'automaticRouteTransitionProven', 'releaseReady']) assert.equal(binding[key], false, key);
  assert.equal(binding.migrationNetworkObservation, 'unobserved'); assert.equal(binding.publicDiscovery, null);
  const rows = lifecycle.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(row => row.kind === 'lab-lifecycle-result');
  assert.equal(rows.length, 1); const result = rows[0];
  assert.equal(result.scenario, report.kind); assert.equal(result.actualScope, report.kind);
  for (const key of ['lifecycleSucceeded', 'cleanupVerified', 'successorCleanupVerified', 'systemTlsVerified', 'outgoingControlledFeed']) assert.equal(result[key], true, key);
  for (const key of ['migrationNetworkObserved', 'isolationProven', 'combinedAcceptance', 'hubCleanupUnknown', 'releaseReady']) assert.equal(result[key], false, key);
  assert.equal(result.hubCleanupState, 'verified'); assert.equal(result.driverExitCode, 0);
  assert.equal(result.rejectedRequestCount, 0); assert.equal(result.servedRouteCount, 5);
  return { diagnosticVerified: true, migrationNetworkObserved: false, combinedAcceptance: false, releaseReady: false };
}
function checkDiagnosticRemote(run, job, artifact, commit, archive) {
  const p = DIAGNOSTIC;
  assert.equal(run.id, p.run); assert.equal(run.run_attempt, 1); assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success'); assert.equal(run.head_sha, p.source);
  assert.equal(run.head_branch, 'validation/windows-menu-merge-20261027'); assert.equal(run.path, '.github/workflows/windows-outgoing-017.yml');
  for (const repo of [run.repository, run.head_repository]) { assert.equal(repo.id, 1364807512); assert.equal(repo.full_name, 'BOBWORKS-XR/CREATOR-HUB'); }
  assert.equal(job.id, p.job); assert.equal(job.run_id, p.run); assert.equal(job.run_attempt, 1); assert.equal(job.head_sha, p.source);
  assert.equal(job.name, 'mixed-public-diagnostic'); assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success'); assert.ok(job.labels.includes('windows-latest'));
  assert.equal(artifact.id, p.artifact); assert.equal(artifact.name, `windows-mixed-public-diagnostic-${p.run}-1`);
  assert.equal(artifact.expired, false); assert.equal(artifact.size_in_bytes, p.size); assert.equal(artifact.digest, `sha256:${p.archive}`);
  for (const [key, value] of Object.entries({ id: p.run, head_sha: p.source, repository_id: 1364807512, head_repository_id: 1364807512 })) assert.equal(artifact.workflow_run[key], value);
  const times = [job.started_at, artifact.created_at, job.completed_at].map(Date.parse);
  assert.ok(times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2]);
  assert.equal(commit.sha, p.source); assert.equal(commit.tree?.sha, p.tree);
  assert.ok(Buffer.isBuffer(archive)); assert.equal(archive.length, p.size); assert.equal(sha(archive), p.archive);
  const names = { report: 'mixed-public-diagnostic-report.json', migration: 'migration-016-report.json', binding: 'diagnostic-binding.json', lifecycle: 'lifecycle.jsonl' };
  const bytes = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, readZipMember(archive, name, 1024 * 1024)]));
  for (const key of Object.keys(names)) assert.equal(sha(bytes[key]), p[key], `Diagnostic ${key} differs`);
  return checkDiagnosticContents(JSON.parse(bytes.report), JSON.parse(bytes.migration), JSON.parse(bytes.binding), bytes.lifecycle);
}
function checkIncomingDiagnosticContents(migration, update, lifecycle, fixture, binding) {
  const p = INCOMING_DIAGNOSTIC;
  assert.equal(migration.testSource, p.source); assert.equal(migration.passed, true);
  assert.equal(migration.installerSha256, R2.installer); assert.equal(migration.executableSha256, R2.executable);
  assert.equal(migration.productSource, `source-receipt-sha256:${R2.sourceReceipt}`);
  assert.equal(migration.sourceSnapshotBuilt, false); assert.equal(migration.buildInputDigest, R2.inventory);
  for (const key of ['nativeGuideAccepted', 'cancelAccepted', 'repeatStartupAccepted', 'settingsPreserved', 'policyRestored', 'installedResourcesVerified']) assert.equal(migration[key], true, key);
  for (const key of ['migrationAccepted', 'signedUpdateAccepted', 'liveAiAppAccepted', 'crashRecoveryAccepted', 'backupBeforeEveryWriteAccepted', 'releaseReady', 'userMachineUsed']) assert.equal(migration[key], false, key);
  assert.deepEqual(migration.baselines.map(row => [row.product, row.version, row.executableSha256]), [
    ['Creator Hub', '0.1.12', '34c6f05548f469ac23b4faee7aa8355d5cca083c444c4f7b0942426a9c76a7ac'],
    ['Creator Works MCP', '2.7.7', '765ad40681c9ad69f2748ce5e9873b59971488acdd3f826e90946af835e36af9'],
    ['Creator Project Setup', '0.3.7', '74653db61681e29a18a308c393e1b8790a86a7ed674ca6abe73f35da0a0f4ed6']]);
  const phase = migration.incomingDiagnostic;
  for (const key of ['signedUpdateObserved', 'normalCloseObserved', 'labCleanupObserved']) assert.equal(phase[key], true, key);
  for (const key of ['processTransfer', 'migrationNetworkObserved', 'migrationIsolationProven', 'publicDiscovery', 'migrationProven', 'releaseReady']) assert.equal(phase[key], false, key);
  assert.deepEqual(binding, { artifactSource: '96ed287c4c7aa56dc6594838d37a63cd0d7d5adf', harnessSource: p.source,
    archiveSha256: '618ca22a26b52b5cf7a95b75b60e15ceec39a2f436c58cc7ba2ccc8c6744ee6a', runId: 41450817062, artifactId: 13144622811 });
  assert.deepEqual(migration.inputBinding, binding);
  assert.equal(fixture.source, p.source); assert.equal(fixture.runId, String(p.run)); assert.equal(fixture.runAttempt, '1');
  assert.match(fixture.fixtureRoot, /[\\/]native-suite-1793698471073$/);
  assert.ok(Array.isArray(fixture.files) && fixture.files.length === 17);
  const paths = new Set();
  for (const file of fixture.files) {
    assert.equal(typeof file.path, 'string'); assert.ok(file.path.length > 0 && !paths.has(file.path.toLowerCase())); paths.add(file.path.toLowerCase());
    assert.ok(Number.isSafeInteger(file.size) && file.size > 0); assert.match(file.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(update.harnessSource, p.source); assert.equal(update.passed, true); assert.equal(update.selfUpdateTested, true);
  assert.equal(update.from.version, '0.1.12'); assert.equal(update.from.installer, '0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18');
  assert.equal(update.from.exe, '34c6f05548f469ac23b4faee7aa8355d5cca083c444c4f7b0942426a9c76a7ac');
  assert.deepEqual(update.to, { version: '0.1.16', installer: R2.installer, exe: R2.executable });
  for (const key of ['testOnlyDescriptor', 'labDiscovery', 'migrationDeferred', 'policyRestored']) assert.equal(update[key], true, key);
  for (const key of ['publicDiscovery', 'nativeAcceptance', 'releaseReady', 'userMachineUsed', 'managedRouteReconnectTested']) assert.equal(update[key], false, key);
  assert.equal(update.feed.pins.descriptor, '818bcb983490e20ade5816b4dbb2f5ea98bcaa33484faefa7b9747d12d64b788');
  assert.equal(update.feed.pins.descriptorSignature, 'c8cc58a35b6b8f8461e078110cbd72462566b19974ac13c547ca80edf5f860da');
  assert.equal(update.feed.pins.manifest, '986745ff133fbd8a4d4c5dc3de17cecafbc500e4af06badb323bf3a632476eea');
  assert.equal(update.feed.pins.installer, R2.installer); assert.equal(update.feed.pins.executable, R2.executable);
  assert.deepEqual(update.directServices.mcp, { state: 'saved-settings-conflict-locked', serviceCallTested: false, reviewApproved: false });
  assert.equal(update.originalExitCode, 0); assert.equal(update.restartedClose.kind, 'incoming-migration-owned-close-only');
  assert.equal(update.restartedClose.state, 'verified'); assert.equal(update.restartedClose.releaseReady, false);
  assert.equal(update.restartedClose.migrationContinuationAvailable, false);
  assert.equal(update.restartedClose.pid, update.restartedPid); assert.equal(update.restartedClose.exitCode, 0);
  assert.equal(update.observedRestart.restartedPid, update.restartedPid);
  assert.equal(update.observedRestart.restartedStartTicks, update.restartedClose.startTicks);
  assert.equal(update.observedRestart.ancestryProven, false); assert.equal(update.observedRestart.securityAttestation, false);
  const results = lifecycle.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(row => row.kind === 'lab-lifecycle-result');
  assert.equal(results.length, 1); const result = results[0];
  assert.equal(result.scenario, 'public-stable'); assert.equal(result.actualScope, 'unmodified-public-0.1.12-lab-only');
  for (const key of ['lifecycleSucceeded', 'cleanupVerified', 'systemTlsVerified', 'driverRegistered', 'driverGateOpened']) assert.equal(result[key], true, key);
  for (const key of ['hubCleanupUnknown', 'publicDiscovery', 'productAcceptance', 'liveAiAcceptance', 'nativeAcceptanceTested', 'releaseReady']) assert.equal(result[key], false, key);
  assert.equal(result.hubCleanupState, 'verified'); assert.equal(result.driverExitCode, 0);
  assert.equal(result.failureDetails, null); assert.equal(result.processIdentityFailure, null);
  assert.equal(result.servedRouteCount, 7); assert.equal(result.rejectedRequestCount, 0);
  assert.deepEqual(result.syntheticDiscovery, { mcp: 1, setup: 1 });
  return { incomingDiagnosticVerified: true, controlledFeed: true, syntheticDiscovery: true, migrationNetworkObserved: false,
    migrationIsolationProven: false, processAncestryProven: false, combinedAcceptance: false, productionApproval: false, releaseReady: false };
}
function checkIncomingDiagnosticRemote(run, job, artifact, commit, archive) {
  const p = INCOMING_DIAGNOSTIC;
  assert.equal(run.id, p.run); assert.equal(run.run_attempt, 1); assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success'); assert.equal(run.head_sha, p.source);
  assert.equal(run.head_branch, 'validation/windows-menu-merge-20261027'); assert.equal(run.path, '.github/workflows/windows-incoming-016.yml');
  for (const repo of [run.repository, run.head_repository]) { assert.equal(repo.id, 1364807512); assert.equal(repo.full_name, 'BOBWORKS-XR/CREATOR-HUB'); }
  assert.equal(job.id, p.job); assert.equal(job.run_id, p.run); assert.equal(job.run_attempt, 1); assert.equal(job.head_sha, p.source);
  assert.equal(job.name, 'incoming-migration-diagnostic'); assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success'); assert.ok(job.labels.includes('windows-latest'));
  assert.equal(artifact.id, p.artifact); assert.equal(artifact.name, `windows-signed012-migration-diagnostic-${p.run}-1`);
  assert.equal(artifact.expired, false); assert.equal(artifact.size_in_bytes, p.size); assert.equal(artifact.digest, `sha256:${p.archive}`);
  for (const [key, value] of Object.entries({ id: p.run, head_sha: p.source, repository_id: 1364807512, head_repository_id: 1364807512 })) assert.equal(artifact.workflow_run[key], value);
  const times = [job.started_at, artifact.created_at, job.completed_at].map(Date.parse);
  assert.ok(times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2]);
  assert.equal(commit.sha, p.source); assert.equal(commit.tree?.sha, p.tree);
  assert.ok(Buffer.isBuffer(archive)); assert.equal(archive.length, p.size); assert.equal(sha(archive), p.archive);
  const names = { migration: 'migration-016-report.json', update: 'self-update-report.json', lifecycle: 'signed-update-lifecycle.jsonl',
    fixture: 'incoming-preinstalled.json', binding: 'input-binding.json' };
  const bytes = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, readZipMember(archive, name, 1024 * 1024)]));
  for (const key of Object.keys(names)) assert.equal(sha(bytes[key]), p[key], `Incoming diagnostic ${key} differs`);
  return checkIncomingDiagnosticContents(JSON.parse(bytes.migration), JSON.parse(bytes.update), bytes.lifecycle, JSON.parse(bytes.fixture), JSON.parse(bytes.binding));
}
async function verifyIncomingDiagnostic(io) {
  assert.ok(io && typeof io.request === 'function' && typeof io.download === 'function');
  const p = INCOMING_DIAGNOSTIC;
  const run = await io.request(`actions/runs/${p.run}`), job = await io.request(`actions/jobs/${p.job}`);
  const artifact = await io.request(`actions/artifacts/${p.artifact}`), commit = await io.request(`git/commits/${p.source}`);
  const archive = await io.download(`actions/artifacts/${p.artifact}/zip`, p.size + 1);
  return checkIncomingDiagnosticRemote(run, job, artifact, commit, archive);
}
async function verifyObservedDraft(io) {
  const p = OBSERVED_DRAFT, before = await io.request(`releases/${p.id}`);
  checkDraftMetadata(before, p); assert.equal(before.target_commitish, p.source);
  const commit = await io.request(`git/commits/${p.source}`);
  assert.equal(commit.sha, p.source); assert.equal(commit.tree?.sha, p.tree);
  const bodies = {};
  for (const name of ASSETS) {
    const pin = p.assets[name], bytes = await io.download(`releases/assets/${pin.id}`, pin.size + 1);
    assert.ok(Buffer.isBuffer(bytes)); assert.equal(bytes.length, pin.size); assert.equal(sha(bytes), pin.sha256);
    bodies[name] = bytes;
  }
  verifyR2Payload({ descriptor: bodies['creator-hub-windows-x86_64.json'], descriptorSignature: bodies['creator-hub-windows-x86_64.json.minisig'],
    installer: bodies[ASSETS[0]], installerSignature: bodies[ASSETS[1]], latest: bodies['latest.json'] });
  const sums = ASSETS.filter(name => name !== 'SHA256SUMS.txt').sort().map(name => `${p.assets[name].sha256}  ${name}\n`).join('');
  assert.equal(bodies['SHA256SUMS.txt'].toString('utf8'), sums);
  const after = await io.request(`releases/${p.id}`); checkDraftMetadata(after, p); assert.equal(after.target_commitish, p.source);
  return { draftId: p.id, assetBytesVerified: true, signaturesVerified: true, sourceAssociation: p.source,
    sourceTree: p.tree, snapshotBuilt: false, reuseApprovalVerified: false, productionApproval: false, releaseReady: false };
}
async function verifyObservedPreflight(io) {
  const existing = await verifyExistingEvidence(io), incoming = await verifyIncomingDiagnostic(io), p = DIAGNOSTIC;
  const run = await io.request(`actions/runs/${p.run}`), job = await io.request(`actions/jobs/${p.job}`);
  const artifact = await io.request(`actions/artifacts/${p.artifact}`), commit = await io.request(`git/commits/${p.source}`);
  const archive = await io.download(`actions/artifacts/${p.artifact}/zip`, p.size + 1);
  const outgoing = checkDiagnosticRemote(run, job, artifact, commit, archive);
  const draft = await verifyObservedDraft(io);
  return { existingEvidenceVerified: existing.verified.length === 8, incoming, outgoing, draft,
    combinedAcceptance: false, productionApproval: false, releaseReady: false };
}
function loadCandidateReceipt(bytes, reviewedSha256, reuse) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 32768);
  assert.match(reviewedSha256 || '', /^[a-f0-9]{64}$/); assert.equal(sha(bytes), reviewedSha256, 'Reviewed receipt bytes differ');
  const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  assert.deepEqual(Object.keys(receipt).sort(), ['acceptance', 'diagnosticRun', 'draft', 'kind', 'platform', 'productionPinsSha256', 'version']);
  assert.equal(receipt.kind, 'windows-016-production-preflight'); assert.equal(receipt.version, '0.1.16'); assert.equal(receipt.platform, 'windows-x86_64');
  assert.equal(receipt.acceptance, 'not-established'); assert.equal(receipt.diagnosticRun, DIAGNOSTIC.run);
  checkProductionPins(receipt.draft, receipt.productionPinsSha256, reuse);
  return receipt;
}
async function verifyCandidateRemote(bytes, reviewedSha256, io, reuse) {
  const receipt = loadCandidateReceipt(bytes, reviewedSha256, reuse);
  assert.ok(io && typeof io.request === 'function' && typeof io.download === 'function');
  const existing = await verifyExistingEvidence(io), p = DIAGNOSTIC;
  const run = await io.request(`actions/runs/${p.run}`), job = await io.request(`actions/jobs/${p.job}`);
  const artifact = await io.request(`actions/artifacts/${p.artifact}`), commit = await io.request(`git/commits/${p.source}`);
  const archive = await io.download(`actions/artifacts/${p.artifact}/zip`, p.size + 1);
  const diagnostic = checkDiagnosticRemote(run, job, artifact, commit, archive);
  const incomingDiagnostic = await verifyIncomingDiagnostic(io);
  const production = await checkDraftReadback(receipt.draft, receipt.productionPinsSha256, io, reuse);
  return { kind: receipt.kind, existingEvidenceVerified: existing.verified.length === 8, diagnostic, incomingDiagnostic, production,
    combinedAcceptance: false, productionApproval: false, releaseReady: false };
}
const releaseProfile = require('./windows-release-target.cjs');
const RELEASE_TARGET = releaseProfile.getTarget();
const FINAL_VERSION = RELEASE_TARGET.version, NEXT_VERSION = RELEASE_TARGET.successor;
const FINAL_PARENT = RELEASE_TARGET.parent;
const FINAL_SOURCE = RELEASE_TARGET.source || Object.freeze({ commit: null, tree: null });
const FINAL_SOURCE_CI = RELEASE_TARGET.sourceCi || Object.freeze({});
const R6_SOURCE = Object.freeze({ commit: 'ec7f1d218c187caac30d0170aaaca2dfcdf83766', tree: '11efac78fc7509e8da08de3af7262bfc6369ce5c' });
const ASSOCIATION_FILES = Object.freeze([
  '.gitattributes',
  '.github/workflows/release.yml', 'README.md', 'docs/EXPERIMENTAL-UNIX-PACKAGING.md',
  'docs/BUILD-FROM-SOURCE.md',
  'docs/SETUP-SDK-4022-VS-1912-QUALIFICATION.md', 'scripts/windows-016-release-qualification.cjs',
  'scripts/windows-release-target.cjs', 'scripts/windows-release-target.test.cjs', 'scripts/fixtures/windows-release-target.cjs',
  'scripts/windows-016-release-qualification.test.cjs', 'scripts/publish-hub-draft.cjs', 'scripts/publish-hub-draft.test.cjs',
  'scripts/windows-018-public-acceptance.cjs', 'scripts/windows-018-public-acceptance.test.cjs',
  'scripts/check-unified-sources.cjs', 'scripts/release-workflow.test.cjs', 'scripts/release-ref.test.cjs',
  'scripts/windows-017-draft-stage.cjs', 'scripts/windows-017-draft-stage.test.cjs', 'scripts/windows-017-signing.cjs',
  `packaging/windows/${FINAL_VERSION}-qualification-DRAFT.md`, `packaging/windows/${FINAL_VERSION}-release-notes-DRAFT.md`,
  `packaging/windows/${FINAL_VERSION}-qualification.json`, `packaging/windows/${FINAL_VERSION}-qualification.json.sha256`,
]);
const FINAL_ASSETS = Object.freeze(ASSETS.map(name => name.replace('0.1.16', FINAL_VERSION)));
const PRODUCTION_KEY_SHA256 = '3c41b4294f116113dda208beea540a349dbcd8d7297933fefdc147b08cf56488';
const OUTGOING18_RECOVERY = Object.freeze({
  receipt: 'b03ae78dbae79e246b21fc2f16ba23c48050448d86d87b015aa26924264a19f0',
  source: Object.freeze({ commit: 'd58513d27d35b6c3bd200367e358e20162cc0efa', tree: 'e2f3f8750346dedc9c739912c9aa24eb7e8b7dcf' }),
  installer: '65518b1f4ce59b9468c3b4d77a04ff7d7145eefa99131abdbbf97748db568f00',
  executable: 'ce1ebfd38bae2e670fac7f9876b41914e1ee55e5605f703af4aa76aec5cccb10',
  contract: '130d0cf0b2f91c5702e8c9f1b32e284c79ad6c22e7cb8ef4d29b72d0d4038235',
  verifier: '7e53d402007ca407b5a1a8cdfa4f441e904b409c1dd0ba299686380642afa0f2',
  baselineBuild: '1c30835ef07347c37930c6911a77883f1ea86c25dd23d629c2f586e5edc25251',
  baselineGeneration: '7ab7242c624f56d69b914e87e30a1bf68be9b1d7a6e9318cd993993cd9303fab',
  targetGeneration: '31dfb7a9ec10dfafed9113a6c3051211465264cbf8e447ce65d0870f7a61895b',
});
function validateOutgoing18Recovery(r) {
  assert.equal(r.schemaVersion, 1); assert.equal(r.kind, 'outgoing18-normalization-recovery');
  assert.equal(r.scope, 'test-fixture-only'); assert.deepEqual(r.source, OUTGOING18_RECOVERY.source);
  assert.deepEqual(r.baselineSource, R6_SOURCE); assert.equal(r.originalBuildExitCode, 1);
  for (const name of ['rawSourceUnchanged', 'sourceUnchanged', 'outerDescriptorSigned', 'outgoingNativeAccepted', 'published', 'releaseReady']) assert.equal(r[name], false, name);
  assert.equal(r.postcheckStatus, 0); assert.equal(r.normalizationVerified, true); assert.equal(r.fixtureExceptionReviewRequired, true);
  assert.deepEqual(r.rootPe, { FileVersion: '0.1.18', ProductVersion: '0.1.18' });
  assert.equal(r.moduleVersion, '2.7.8-fixture.18'); assert.equal(r.moduleFilesChecked, 15);
  for (const name of ['payloadGenerationChanged', 'serverBundleChanged', 'independentlyExtracted', 'managedRuntimeVerified']) assert.equal(r[name], true, name);
  digest(r.baselineGeneration); digest(r.targetGeneration); assert.notEqual(r.baselineGeneration, r.targetGeneration);
  assert.equal(r.artifacts.installer.sha256, OUTGOING18_RECOVERY.installer);
  assert.equal(r.artifacts.executable.sha256, OUTGOING18_RECOVERY.executable);
  assert.equal(r.publicKey.sha256, PRODUCTION_KEY_SHA256); assert.equal(r.verifier.sha256, OUTGOING18_RECOVERY.verifier);
  assert.equal(r.verificationScripts['normalization-contract.cjs'].sha256, OUTGOING18_RECOVERY.contract);
  assert.equal(r.contractTests.passed, 6);
  return r;
}
function verifyOutgoing18Recovery(file, expectedHash) {
  const path = require('node:path'), { execFileSync } = require('node:child_process');
  assert.equal(expectedHash, OUTGOING18_RECOVERY.receipt, 'Only the independently reviewed test18 receipt is supported');
  assert.equal(FINAL_VERSION, '0.1.17', 'The outgoing18 fixture is superseded; final 0.1.18 requires a new 0.1.19 fixture');
  function read(file, pin, limit = 4 * 1024 * 1024) {
    const stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= limit);
    const bytes = fs.readFileSync(file); assert.equal(bytes.length, stat.size);
    if (pin) { assert.equal(bytes.length, pin.bytes); assert.equal(sha(bytes), pin.sha256); }
    return bytes;
  }
  file = path.resolve(file);
  const bytes = read(file); assert.equal(sha(bytes), expectedHash);
  const r = validateOutgoing18Recovery(JSON.parse(bytes)), recovery = path.dirname(file), root = path.dirname(recovery);
  assert.equal(path.basename(recovery), 'recovery-03');
  const source = path.join(root, 'source-final'), output = path.join(source, 'artifacts/unified/windows-outgoing-018-r6-fixture');
  assert.equal(path.resolve(r.output), output);
  const attestation = JSON.parse(read(path.join(recovery, 'normalization-attestation.json'), r.normalizationAttestation));
  read(path.join(recovery, 'original-build-failure.json'), r.originalFailure);
  read(path.join(root, 'build.log'), r.originalBuildLog); read(path.join(root, 'build-fixture.cjs'), r.originalBuildScript);
  read(path.join(recovery, 'normalization-tests.log'), r.contractTests.log);
  for (const [name, pin] of Object.entries(r.verificationScripts)) {
    assert.ok(['normalization-contract.cjs', 'normalization-contract.test.cjs', 'recover-postchecks.cjs'].includes(name));
    read(path.join(root, name), pin);
  }
  const contractFile = path.join(root, 'normalization-contract.cjs');
  assert.equal(sha(read(contractFile)), OUTGOING18_RECOVERY.contract);
  const contract = require(contractFile);
  assert.deepEqual(contract.verify(contract.captureCurrent()), attestation, 'Current exact three-path proof differs from the reviewed attestation');
  assert.equal(attestation.productionSourceGuardException, false); assert.equal(attestation.rawSourceUnchanged, false);
  const manifest = JSON.parse(read(path.join(output, 'builtin-manifest.json'), r.artifacts.manifest));
  assert.equal(manifest.modules.mcp.version, r.moduleVersion);
  const modulePins = { ...manifest.modules.mcp.files, ...manifest.modules.setup.files, ...manifest.managedRouting.files };
  assert.deepEqual(modulePins, r.artifacts.moduleFiles); assert.equal(Object.keys(modulePins).length, 15);
  const baselineBytes = read(path.resolve(root, '../../build-r6-result.json'));
  assert.equal(sha(baselineBytes), OUTGOING18_RECOVERY.baselineBuild);
  const baselineBuild = JSON.parse(baselineBytes);
  assert.equal(baselineBuild.status, 0); assert.equal(baselineBuild.sourceUnchanged, true);
  assert.equal(baselineBuild.sourceCommit, FINAL_SOURCE.commit); assert.equal(baselineBuild.sourceTree, FINAL_SOURCE.tree);
  const baseline = JSON.parse(read(path.join(baselineBuild.output, 'builtin-manifest.json')));
  const generation = m => sha(Buffer.from(JSON.stringify({ executable: m.executable, version: m.version,
    files: Object.fromEntries(Object.entries(m.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) })));
  assert.equal(generation(baseline.modules.mcp), r.baselineGeneration);
  assert.equal(generation(manifest.modules.mcp), r.targetGeneration);
  assert.notEqual(modulePins['mcp/server/creator-works-mcp.mjs'], baseline.modules.mcp.files['mcp/server/creator-works-mcp.mjs']);
  const list = (directory, prefix = '') => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name, stat = fs.lstatSync(path.join(directory, entry.name));
    assert.ok(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()));
    return stat.isDirectory() ? list(path.join(directory, entry.name), name + '/') : [name];
  }).sort();
  const extracted = path.join(recovery, 'installer-extracted');
  assert.deepEqual(list(path.join(extracted, 'modules')), Object.keys(modulePins).sort());
  assert.deepEqual(list(path.join(output, 'modules')), [...Object.keys(modulePins), 'routing/router.json.sig', 'routing/runtime.json.sig'].sort());
  for (const [name, hash] of Object.entries(modulePins)) for (const directory of [extracted, output])
    assert.equal(sha(read(path.join(directory, 'modules', name), null, 256 * 1024 * 1024)), hash, name);
  read(path.join(output, 'installer.exe'), r.artifacts.installer, 256 * 1024 * 1024);
  for (const image of [path.join(output, 'installer-extracted/creator-hub.exe'), path.join(extracted, 'creator-hub.exe'),
    path.join(extracted, '$PLUGINSDIR/creator-hub-preflight.exe')]) read(image, r.artifacts.executable, 128 * 1024 * 1024);
  read(path.join(output, 'modules/routing/runtime.json'), r.artifacts.runtime);
  read(path.join(output, 'modules/routing/runtime.minisig'), r.artifacts.runtimeSignature);
  for (const auxiliary of r.stagingAuxiliary) {
    assert.ok(['routing/router.json.sig', 'routing/runtime.json.sig'].includes(auxiliary.name)); assert.equal(auxiliary.packaged, false);
    read(path.join(output, 'modules', auxiliary.name), auxiliary);
  }
  const key = read(path.join(source, 'src-tauri/src/catalog-key.pub'), r.publicKey);
  assert.equal(sha(Buffer.from(key.toString('utf8').replace(/\r?\n/g, '\r\n'))), PRODUCTION_KEY_SHA256);
  read(path.join(source, 'src-tauri/examples/verify-managed-runtime.rs'), r.verifier.source);
  read(r.verifier.path, r.verifier, 16 * 1024 * 1024);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION|SIGNING|PRIVATE_KEY|^NODE_OPTIONS$|^NODE_PATH$/i.test(name)));
  const tested = execFileSync(process.execPath, ['--test', path.join(root, 'normalization-contract.test.cjs')], { env, windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 32768 });
  assert.match(tested, /^# pass 6\r?$/m); assert.match(tested, /^# fail 0\r?$/m);
  const verified = execFileSync(r.verifier.path, [output, '0.1.18'], { env, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 32768 });
  assert.equal(verified.trim(), 'Verified managed runtime 0.1.18: trusted signature, exact payload and tamper refusal. No activation or client changes.');
  assert.deepEqual(contract.verify(contract.captureCurrent()), attestation, 'Fixture verification changed source bytes');
  return { kind: 'outgoing18-fixture-only-qualified', recoveryReceiptSha256: expectedHash, source: r.source,
    installerSha256: r.artifacts.installer.sha256, executableSha256: r.artifacts.executable.sha256,
    rawSourceUnchanged: false, originalBuildExitCode: 1, fixtureUsableForOutgoingTest: true,
    productionSourceGuardException: false, productionApproval: false, outgoingNativeAccepted: false, published: false, releaseReady: false };
}
const FINAL_ROLES = Object.freeze(['fresh', 'guarded', 'migration', 'incoming014', 'incoming012',
  'mcp-restore', 'setup-restore', 'setup-no-restore', 'combined',
  ...(RELEASE_TARGET.splitNativeRoles ? ['combined-owned', 'combined-custom'] : [])]);
const reviewedFinal = new WeakMap();
function checkAssociationAttributes(before, after) {
  assert.ok(Buffer.isBuffer(before) && Buffer.isBuffer(after));
  const rule = 'packaging/windows/*-qualification.json -text\n';
  assert.ok(before.length > 0 && before.at(-1) === 10);
  assert.equal(before.includes(Buffer.from(rule)), false, 'Frozen attributes already contain the rule');
  assert.ok(after.equals(Buffer.concat([before, Buffer.from(rule)])), 'Only the exact qualification-byte rule may change attributes');
}
function exactKeys(value, names) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), 'Exact qualification fields required');
}
function digest(value, length = 64) {
  assert.ok(typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value) && value !== '0'.repeat(length), 'Invalid immutable hash');
}
function positive(value) { assert.ok(Number.isSafeInteger(value) && value > 0, 'Positive immutable ID/size required'); }
function documentBytes(value) {
  exactKeys(value, ['member', 'size', 'sha256', 'base64']); positive(value.size); digest(value.sha256);
  assert.ok(value.size <= 256 * 1024 && typeof value.member === 'string' && value.member.length <= 256
    && /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(value.member)
    && !value.member.split('/').some(part => part === '.' || part === '..'), 'Unsafe evidence member');
  assert.ok(typeof value.base64 === 'string' && value.base64.length <= 350000);
  const bytes = Buffer.from(value.base64, 'base64');
  assert.equal(bytes.toString('base64'), value.base64); assert.equal(bytes.length, value.size); assert.equal(sha(bytes), value.sha256);
  return bytes;
}
function documentJson(value) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(documentBytes(value))); }
function captureLocalEvidence(evidence, candidate) {
  const profile = releaseProfile.requireSource();
  exactKeys(evidence, ['rootNative', 'realCodex']); exactKeys(evidence.rootNative, ['receipt', 'log']);
  assert.ok(profile.rootNative && profile.realCodex, 'Exact Root-native and real-client evidence pins are pending');
  assert.equal(evidence.rootNative.receipt.sha256, profile.rootNative.receiptSha256);
  assert.equal(evidence.rootNative.log.sha256, profile.rootNative.logSha256);
  const root = documentJson(evidence.rootNative.receipt), log = documentBytes(evidence.rootNative.log).toString('utf8');
  assert.equal(root.sourceCommit, candidate.sourceCommit); assert.equal(root.sourceTree, candidate.sourceTree);
  assert.equal(root.installedArtifactSha256, candidate.executableSha256);
  assert.equal(root.runtimeDescriptorSha256, profile.rootBuild.runtimeSha256);
  assert.equal(root.passed, true); assert.equal(root.exitCode, 0); assert.equal(root.published, false);
  assert.equal(root.compilerInputsUnchanged, true); assert.equal(root.rawSourceUnchanged, true);
  assert.deepEqual(root.generatedSchemaChanges, []);
  assert.deepEqual(root.summaries, [{ outcome: 'ok', passed: profile.rootNative.passed, failed: 0, ignored: profile.rootNative.ignored }]);
  const tests = ['mixed_separator_receipt_is_the_same_reviewed_windows_path',
    'mixed_separator_saved_fields_preserve_all_other_values_exactly',
    'mixed_separator_receipt_and_saved_fields_are_read_only_validation', 'wrong_receipt_path_never_renews_snapshots',
    'wrong_saved_path_or_preference_never_renews_snapshots', 'false_or_missing_changed_never_accepts_changed_stores',
    'later_store_error_cannot_partially_renew_first_snapshot'];
  assert.deepEqual(root.targetedRegressions, tests.map(name => ({ name, passed: true })));
  assert.equal(root.logSha256, evidence.rootNative.log.sha256);
  assert.ok(log.includes(`test result: ok. ${profile.rootNative.passed} passed; 0 failed; ${profile.rootNative.ignored} ignored;`));
  for (const name of tests) assert.ok(log.includes(`${name} ... ok`));
  assert.equal(evidence.realCodex.sha256, profile.realCodex.receiptSha256);
  const client = documentJson(evidence.realCodex);
  assert.equal(client.sourceCommit, candidate.sourceCommit); assert.equal(client.installedExeSha256, candidate.executableSha256);
  assert.equal(client.runtimeDescriptorSha256, profile.rootBuild.runtimeSha256);
  assert.equal(client.eventStreamSha256, profile.realCodex.eventStreamSha256);
  assert.equal(client.passed, true); assert.equal(client.exitCode, 0); assert.equal(client.unexpectedToolEvents, 0);
  assert.equal(client.settingsUnchanged, true); assert.equal(client.positiveReference, true); assert.equal(client.published, false);
  assert.deepEqual(client.checks, [{ tool: 'get_bridge_status', count: 1 }, { tool: 'get_mcp_reference', count: 1 }]);
  assert.ok(client.scope.includes('separate from normal Hub restart'), 'Do not promote after-install scope to a restart claim');
  const summary = { rootNative: { receiptSha256: profile.rootNative.receiptSha256, logSha256: profile.rootNative.logSha256,
    passed: profile.rootNative.passed, failed: 0, ignored: profile.rootNative.ignored, regressionsPassed: tests.length },
  realCodex: { receiptSha256: profile.realCodex.receiptSha256, eventStreamSha256: profile.realCodex.eventStreamSha256,
    bridgeStatusCalls: 1, referenceCalls: 1, unexpectedToolEvents: 0, exitCode: 0 } };
  validateLocalEvidence(summary, candidate);
  return summary;
}
function validateLocalEvidence(evidence, candidate) {
  const profile = releaseProfile.requireSource();
  assert.ok(profile.rootNative && profile.realCodex, 'Local evidence pins are pending');
  assert.equal(candidate.sourceCommit, profile.source.commit); assert.equal(candidate.sourceTree, profile.source.tree);
  assert.equal(candidate.executableSha256, profile.rootBuild.executableSha256);
  assert.deepEqual(evidence, { rootNative: { receiptSha256: profile.rootNative.receiptSha256,
    logSha256: profile.rootNative.logSha256, passed: profile.rootNative.passed, failed: 0,
    ignored: profile.rootNative.ignored, regressionsPassed: 7 },
  realCodex: { receiptSha256: profile.realCodex.receiptSha256, eventStreamSha256: profile.realCodex.eventStreamSha256,
    bridgeStatusCalls: 1, referenceCalls: 1, unexpectedToolEvents: 0, exitCode: 0 } },
  'Git-facing local evidence contains only the reviewed hashes and counts');
}
function validateLocalRestartEvidence(evidence, candidate) {
  const profile = releaseProfile.requireSource();
  assert.ok(profile.localRestart && profile.rootBuild, 'Exact local restart evidence is pending');
  assert.equal(candidate.sourceCommit, profile.source.commit); assert.equal(candidate.sourceTree, profile.source.tree);
  assert.equal(candidate.executableSha256, profile.rootBuild.executableSha256);
  assert.deepEqual(evidence, { normalRestart: { receiptSha256: profile.localRestart.receiptSha256,
    passed: true, projectCount: 30, settingsAndPhaseFiles: 4, configuredClients: 3,
    rootSourceCommit: profile.source.commit, installedRootSha256: profile.rootBuild.executableSha256, retainedMigrationCompleted: false },
  sdkAfterRestart: { receiptSha256: profile.localRestart.sdkReceiptSha256, componentSourceCommit: profile.rootBuild.reusedSourceCommit,
    referenceSuccess: true, settingsUnchanged: true }, productionApproval: false, releaseReady: false },
  'Local restart evidence must retain its exact hashes, counts and unresolved private-migration scope');
}
function validateSourceCi(ci, candidate) {
  releaseProfile.requireSource();
  const checkout = ci.scope === 'final-source-checkout';
  exactKeys(ci, ['runId', 'runAttempt', 'workflow', 'sourceCommit', 'sourceTree', 'scope', 'jobs',
    ...(checkout ? ['suite', 'harnessCommit', 'harnessTree', 'workflowBlobSha', 'artifact', 'report', 'jobLog'] : [])]);
  assert.ok(checkout || ci.scope === 'final-source');
  assert.equal(ci.sourceCommit, candidate.sourceCommit); assert.equal(ci.sourceTree, candidate.sourceTree);
  positive(ci.runId); positive(ci.runAttempt);
  assert.ok(typeof ci.workflow === 'string' && /^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(ci.workflow));
  assert.ok(Array.isArray(ci.jobs) && ci.jobs.length > 0 && ci.jobs.length <= 32);
  const ids = new Set();
  for (const job of ci.jobs) {
    exactKeys(job, ['id', 'name']); positive(job.id); assert.ok(!ids.has(job.id)); ids.add(job.id);
    assert.ok(typeof job.name === 'string' && job.name.length > 0 && job.name.length <= 256);
  }
  if (!checkout) return;
  assert.equal(ci.suite, 'mcp-npm');
  assert.ok(RELEASE_TARGET.sourceCi, 'Exact R7 source-CI pins are pending');
  assert.equal(ci.sourceCommit, FINAL_SOURCE.commit); assert.equal(ci.sourceTree, FINAL_SOURCE.tree);
  for (const key of ['runId', 'runAttempt', 'workflow', 'harnessCommit', 'harnessTree', 'workflowBlobSha']) assert.equal(ci[key], FINAL_SOURCE_CI[key]);
  assert.deepEqual(ci.jobs, [{ id: FINAL_SOURCE_CI.jobId, name: 'mcp-npm-tests' }]);
  assert.deepEqual(ci.artifact, { id: FINAL_SOURCE_CI.artifactId, name: FINAL_SOURCE_CI.artifactName,
    size: FINAL_SOURCE_CI.artifactSize, sha256: FINAL_SOURCE_CI.artifactSha256 });
  assert.equal(ci.report.member, 'mcp-npm-tests.log');
  const report = documentBytes(ci.report).toString('utf8'), log = documentBytes(ci.jobLog).toString('utf8');
  assert.ok(log.includes(`productCommit=${candidate.sourceCommit} productTree=${candidate.sourceTree} workflowCommit=${ci.harnessCommit}`));
  for (const [key, expected] of Object.entries({ tests: FINAL_SOURCE_CI.expectedTests, pass: FINAL_SOURCE_CI.expectedTests, fail: 0, skipped: 0, cancelled: 0 })) {
    const matches = [...report.matchAll(new RegExp(`(?:#|\\u2139) ${key} (\\d+)`, 'g'))];
    assert.ok(matches.length > 0, `Source CI total ${key} absent`); assert.equal(Number(matches.at(-1)[1]), expected);
  }
}
async function verifySourceCi(ci, value, io) {
  validateSourceCi(ci, value.candidate);
  const checkout = ci.scope === 'final-source-checkout', head = checkout ? ci.harnessCommit : ci.sourceCommit;
  const testedSource = await io.request(`git/commits/${ci.sourceCommit}`);
  assert.equal(testedSource.sha, ci.sourceCommit); assert.equal(testedSource.tree.sha, ci.sourceTree);
  const commit = await io.request(`git/commits/${head}`);
  assert.equal(commit.sha, head); assert.equal(commit.tree.sha, checkout ? ci.harnessTree : ci.sourceTree);
  const run = await io.request(`actions/runs/${ci.runId}`);
  for (const [key, expected] of Object.entries({ id: ci.runId, run_attempt: ci.runAttempt, status: 'completed', conclusion: 'success',
    head_sha: head, path: ci.workflow })) assert.equal(run[key], expected, `Source CI ${key}`);
  assert.ok(['push', 'workflow_dispatch'].includes(run.event));
  for (const repo of [run.repository, run.head_repository]) { assert.equal(repo.id, value.repositoryId); assert.equal(repo.full_name, value.repository); }
  let windowsObserved = false, selectedJob;
  for (const pin of ci.jobs) {
    const job = await io.request(`actions/jobs/${pin.id}`);
    for (const [key, expected] of Object.entries({ id: pin.id, name: pin.name, run_id: ci.runId, run_attempt: ci.runAttempt,
      head_sha: head, status: 'completed', conclusion: 'success' })) assert.equal(job[key], expected, `Source CI job ${key}`);
    assert.ok(Array.isArray(job.labels)); windowsObserved ||= job.labels.some(label => /^windows-/i.test(label)); selectedJob = job;
  }
  assert.ok(windowsObserved, 'Exact final-source clean-Windows CI required');
  if (!checkout) return;
  const tree = await io.request(`git/trees/${ci.harnessTree}?recursive=1`);
  assert.equal(tree.truncated, false); assert.equal(tree.sha, ci.harnessTree);
  const file = tree.tree.filter(f => f.path === ci.workflow);
  assert.equal(file.length, 1); assert.equal(file[0].type, 'blob'); assert.equal(file[0].sha, ci.workflowBlobSha);
  const blob = await io.request(`git/blobs/${ci.workflowBlobSha}`);
  assert.equal(blob.sha, ci.workflowBlobSha); assert.equal(blob.encoding, 'base64');
  const workflow = Buffer.from(blob.content, 'base64'); assert.equal(workflow.length, blob.size);
  assert.equal(sha(workflow), FINAL_SOURCE_CI.workflowSha256, 'Reviewed checkout/verification/test workflow changed');
  const text = workflow.toString('utf8');
  for (const line of [`ref: ${ci.sourceCommit}`, `$commit -cne '${ci.sourceCommit}'`, `$tree -cne '${ci.sourceTree}'`,
    'npm --prefix modules/mcp test 2>&1 | Tee-Object -FilePath mcp-npm-tests.log']) assert.ok(text.includes(line));
  const pin = ci.artifact, artifact = await io.request(`actions/artifacts/${pin.id}`);
  for (const [key, expected] of Object.entries({ id: pin.id, name: pin.name, size_in_bytes: pin.size,
    digest: `sha256:${pin.sha256}`, expired: false })) assert.equal(artifact[key], expected);
  for (const [key, expected] of Object.entries({ id: ci.runId, head_sha: head, repository_id: value.repositoryId, head_repository_id: value.repositoryId })) assert.equal(artifact.workflow_run[key], expected);
  const times = [selectedJob.started_at, artifact.created_at, selectedJob.completed_at].map(Date.parse);
  assert.ok(times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2]);
  const archive = await io.download(`actions/artifacts/${pin.id}/zip`, pin.size + 1);
  assert.equal(archive.length, pin.size); assert.equal(sha(archive), pin.sha256);
  assert.ok(readZipMember(archive, ci.report.member).equals(documentBytes(ci.report)));
  const log = await io.download(`actions/jobs/${FINAL_SOURCE_CI.jobId}/logs`, ci.jobLog.size + 1);
  assert.ok(log.equals(documentBytes(ci.jobLog)), 'Original source checkout/job log changed');
}
async function captureSourceCi(io) {
  releaseProfile.requireSource();
  assert.ok(RELEASE_TARGET.sourceCi, 'Exact R7 source-CI pins are pending');
  const p = FINAL_SOURCE_CI;
  const archive = await io.download(`actions/artifacts/${p.artifactId}/zip`, p.artifactSize + 1);
  const log = await io.download(`actions/jobs/${p.jobId}/logs`, 256 * 1024);
  const document = (member, bytes) => ({ member, size: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') });
  const sourceCi = { runId: p.runId, runAttempt: p.runAttempt, workflow: p.workflow,
    sourceCommit: FINAL_SOURCE.commit, sourceTree: FINAL_SOURCE.tree, scope: 'final-source-checkout', suite: 'mcp-npm',
    harnessCommit: p.harnessCommit, harnessTree: p.harnessTree, workflowBlobSha: p.workflowBlobSha,
    jobs: [{ id: p.jobId, name: 'mcp-npm-tests' }],
    artifact: { id: p.artifactId, name: p.artifactName, size: p.artifactSize, sha256: p.artifactSha256 },
    report: document('mcp-npm-tests.log', readZipMember(archive, 'mcp-npm-tests.log')),
    jobLog: document(`github-job-${p.jobId}.log`, log) };
  await verifySourceCi(sourceCi, { candidate: { sourceCommit: FINAL_SOURCE.commit, sourceTree: FINAL_SOURCE.tree },
    repository: 'BOBWORKS-XR/CREATOR-HUB', repositoryId: 1364807512 }, io);
  return { kind: 'final-source-ci-capture', sourceCi, productionApproval: false, releaseReady: false };
}
function finalFeedPins(value) {
  const a = value.draft.assets;
  return { descriptor: a['creator-hub-windows-x86_64.json'].sha256, descriptorSignature: a['creator-hub-windows-x86_64.json.minisig'].sha256,
    installer: value.candidate.installerSha256, manifest: a['latest.json'].sha256, executable: value.candidate.executableSha256 };
}
function checkFinalDraftMetadata(draft, pin, associationCommit, expectedDraft = true) {
  positive(pin.id); assert.ok(![424919952, 411494394].includes(pin.id), 'Validation drafts cannot be published');
  assert.equal(draft.id, pin.id); assert.equal(draft.tag_name, `v${FINAL_VERSION}`); assert.equal(draft.draft, expectedDraft);
  assert.equal(draft.prerelease, false); assert.equal(draft.target_commitish, associationCommit);
  exactKeys(pin.assets, FINAL_ASSETS); assert.ok(Array.isArray(draft.assets)); assert.equal(draft.assets.length, FINAL_ASSETS.length);
  const ids = new Set();
  for (const name of FINAL_ASSETS) {
    const p = pin.assets[name]; exactKeys(p, ['id', 'size', 'sha256']); positive(p.id); positive(p.size); digest(p.sha256);
    assert.ok(!ids.has(p.id)); ids.add(p.id);
    const limit = name === FINAL_ASSETS[0] ? 256 * 1024 * 1024 : /\.(?:sig|minisig)$/.test(name) ? 4096 : name === 'SHA256SUMS.txt' ? 8192 : 32768;
    assert.ok(p.size <= limit);
    const matches = draft.assets.filter(a => a.name === name); assert.equal(matches.length, 1);
    const a = matches[0]; assert.equal(a.id, p.id); assert.equal(a.size, p.size); assert.equal(a.digest, `sha256:${p.sha256}`); assert.equal(a.state, 'uploaded');
  }
}
function finalProofWorkflow(role) {
  if (role === 'guarded') return RELEASE_TARGET.rawWorkflow;
  return role.includes('-restore') ? RELEASE_TARGET.outgoingWorkflow : RELEASE_TARGET.productionWorkflow;
}
function isCombinedRole(role) { return ['combined', 'combined-owned', 'combined-custom'].includes(role); }
const FINAL_JOB_NAMES = Object.freeze({
  fresh: 'incoming (fresh, 0.1.12)', guarded: 'install (guarded)',
  incoming012: 'incoming (incoming12, 0.1.12)', incoming014: 'incoming (incoming14, 0.1.14)',
  migration: 'incoming-migration (legacy)', combined: 'incoming-migration (legacy)',
  'combined-owned': 'incoming-migration (setup-owned-codex)',
  'combined-custom': 'incoming-migration (setup-owned-codex-unverified-server)',
  'mcp-restore': 'acceptance (mcp-restore, mcp, true)',
  'setup-restore': 'acceptance (setup-restore, setup, true)',
  'setup-no-restore': 'acceptance (setup-no-restore, setup, false)',
});
function checkNativeLane(role, proof, lanes = RELEASE_TARGET.productionLanes) {
  if (!lanes) return;
  assert.ok(Object.hasOwn(FINAL_JOB_NAMES, role), 'Unknown production native role');
  assert.equal(proof.jobName, FINAL_JOB_NAMES[role], 'Wrong native matrix case');
  if (role === 'guarded') return;
  if (role.includes('-restore')) {
    assert.ok(lanes.outgoing, 'Actual outgoing lane pins are still pending');
    for (const field of ['runId', 'runAttempt', 'sourceCommit', 'sourceTree']) assert.equal(proof[field], lanes.outgoing[field], `Outgoing lane ${field}`);
    return;
  }
  const lane = role === 'fresh' || role.startsWith('incoming') ? lanes.incoming
    : role === 'combined-custom' ? lanes.custom : lanes.standard;
  assert.ok(lane, 'Actual standard combined lane pins are still pending');
  for (const field of ['runId', 'runAttempt', 'sourceCommit', 'sourceTree']) assert.equal(proof[field], lane[field], `Native lane ${field}`);
}
function checkMigrationCase(role, report, candidate) {
  const owned = ['combined-owned', 'combined-custom'].includes(role), custom = role === 'combined-custom';
  if (!owned) {
    assert.equal(report.normalSetupOwnedCodex, undefined, 'Owned-router case cannot replace legacy combined');
  } else {
    const o = report.normalSetupOwnedCodex;
    assert.ok(o); assert.equal(o.fixtureOnly, true); assert.equal(o.copiedUserData, false);
    assert.equal(o.guiNativeMoveRequired, true); assert.equal(o.migrationAccepted, true);
    assert.deepEqual(o.args, []); digest(o.beforeNativeMoveSha256); assert.equal(o.afterRestartSha256, o.beforeNativeMoveSha256);
    assert.ok(typeof o.command === 'string' && !o.command.includes('\\')
      && o.command.endsWith('/creator-hub/mcp-route-v1/windows-x86_64/router-v1/creator-hub-mcp-router.exe'));
  }
  if (!custom) {
    assert.equal(report.serverRuntimeDecision, undefined, 'Custom consent cannot replace the standard case');
    assert.equal(report.unverifiedSavedServerTransition, undefined);
    return;
  }
  assert.ok(Array.isArray(report.serverRuntimeDecision)); assert.equal(report.serverRuntimeDecision.length, 1);
  const decision = report.serverRuntimeDecision[0], transition = report.unverifiedSavedServerTransition;
  assert.ok(transition); assert.equal(transition.nativeApproved, true);
  assert.ok(typeof transition.before === 'string' && transition.before.endsWith('\\Unverified Server\\never-run-custom.mjs'));
  assert.notEqual(transition.before, transition.after);
  assert.ok(typeof report.activeRoute?.payload === 'string' && report.activeRoute.payload.includes('\\'));
  const expectedServer = `${report.activeRoute.payload}\\mcp/server/creator-works-mcp.mjs`;
  assert.equal(transition.after, expectedServer); assert.equal(decision.expectedServer, expectedServer);
  assert.equal(decision.title, 'Keep MCP settings working in Hub'); assert.equal(decision.name, 'Use Hub runtime');
  assert.equal(decision.id, 1000); positive(decision.pid); positive(decision.handle);
  assert.equal(decision.executableSha256, candidate.executableSha256);
  const message = 'The saved MCP server could not be verified as a supported previous build. Use the verified MCP runtime included with Hub instead?\n\nThis does not trust or run the old server. Existing AI-client entries are reviewed separately.'
    + `\n\nNew server: ${expectedServer}\n\nOnly this path changes. Project selection, options and unknown settings are preserved. Exact local backups and recovery records are kept. Old apps and AI clients are not stopped or removed by this step.`;
  assert.equal(decision.content, message, 'Exact separate server-consent text required');
}
function checkFinalInputBinding(binding, proof, value) {
  assert.equal(binding.harnessSource, proof.sourceCommit);
  assert.equal(binding.privateDraft, true); assert.equal(binding.readbackVerified, true);
  assert.equal(binding.releaseId, value.draft.id); assert.equal(binding.releaseTag, `v${FINAL_VERSION}`);
  assert.deepEqual(binding.source, { commit: value.candidate.sourceCommit, tree: value.candidate.sourceTree });
  const names = [FINAL_ASSETS[0], 'creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig', 'latest.json'];
  exactKeys(binding.files, names);
  for (const name of names) assert.deepEqual(binding.files[name], value.draft.assets[name]);
}
function checkReportSource(record, candidate) {
  if (!RELEASE_TARGET.rootBuild) { assert.equal(record.sourceUnchanged, true); return; }
  assert.equal(record.sourceUnchanged, undefined, 'Do not invent a blanket raw-source-unchanged claim');
  assert.equal(record.compilerInputsUnchanged, true); assert.equal(record.rawSourceUnchanged, false);
  releaseProfile.validateRootOnlyProjection(record.rootOnlyAssembly, documentBytes(candidate.buildResult),
    documentBytes(candidate.originalBuildResult), candidate);
}
function checkFinalReport(role, proof, value) {
  releaseProfile.requireSource();
  const docs = Object.fromEntries(Object.entries(proof.documents).filter(([name]) => name !== 'lifecycle')
    .map(([name, doc]) => [name, documentJson(doc)]));
  const r = docs.report, c = value.candidate, outgoing = role.includes('-restore'), incoming = role.startsWith('incoming'), combined = isCombinedRole(role);
  assert.equal(r.passed, true); assert.equal(r.releaseReady, false);
  for (const doc of Object.values(docs)) for (const [name, error] of Object.entries(doc)) {
    if (name === 'error' || /[Cc]leanupError$/.test(name)) assert.ok(!error, 'Native evidence reports an error');
  }
  if (role === 'fresh') {
    for (const [key, expected] of Object.entries({ installerSha256: c.installerSha256, executableSha256: c.executableSha256,
      productSource: c.sourceCommit, productTree: c.sourceTree,
      buildInputsSha256: c.buildInputs.sha256, buildResultSha256: c.buildResult.sha256,
      settingsPreserved: true, freshInstallAccepted: true, manualNormalRestartAccepted: true, policyRestored: true,
      userMachineUsed: false, publicDiscovery: false, migrationAccepted: false, signedUpdateAccepted: false,
      signedAutomaticRestartAccepted: false })) assert.equal(r[key], expected, key);
    assert.equal(r.harnessSource, proof.sourceCommit);
    checkReportSource(r, c);
    assert.ok(Array.isArray(r.normalCloses) && r.normalCloses.length === 2);
    for (const close of r.normalCloses) { positive(close.pid); assert.equal(close.exitCode, 0); }
    checkFinalInputBinding(docs.binding, proof, value);
  } else if (role === 'guarded') {
    require('./windows-017-draft-stage.cjs').rawReport('guarded', { report: proof.documents.report, binding: proof.documents.binding }, {
      candidate: { sourceCommit: c.sourceCommit, sourceTree: c.sourceTree, installer: { size: value.draft.assets[FINAL_ASSETS[0]].size,
        sha256: c.installerSha256 }, executableSha256: c.executableSha256, buildInputsSha256: c.buildInputs.sha256,
      buildResultSha256: c.buildResult.sha256, buildResult: c.buildResult,
      ...(RELEASE_TARGET.rootBuild ? { originalBuildResult: c.originalBuildResult } : {}) },
    });
  } else if (!incoming && !outgoing) {
    for (const [key, expected] of Object.entries({ installerSha256: c.installerSha256, executableSha256: c.executableSha256,
      productSource: c.sourceCommit, productTree: c.sourceTree, buildInputsSha256: c.buildInputs.sha256,
      buildResultSha256: c.buildResult.sha256, settingsPreserved: true })) assert.equal(r[key], expected, key);
    checkReportSource(r, c);
    if (role === 'migration' || combined) {
      // The harness retains its historical scope label and explicitly disclaims broader migration coverage.
      assert.equal(r.scope, 'exact-direct16-three-client-clean-legacy-guide-probe');
      for (const key of ['nativeGuideAccepted', 'cancelAccepted', 'repeatStartupAccepted', 'policyRestored', 'installedResourcesVerified']) assert.equal(r[key], true, key);
      for (const key of ['migrationAccepted', 'signedUpdateAccepted', 'liveAiAppAccepted', 'crashRecoveryAccepted', 'backupBeforeEveryWriteAccepted', 'userMachineUsed']) assert.equal(r[key], false, key);
      assert.equal(r.testSource, proof.sourceCommit); checkFinalInputBinding(docs.binding, proof, value);
      assert.deepEqual(r.inputBinding, docs.binding);
      assert.ok(Array.isArray(r.nativeDecisions)); assert.deepEqual(r.nativeDecisions.map(d => d.name), ['Not now', 'Move to Hub']);
      for (const decision of r.nativeDecisions) { positive(decision.pid); assert.equal(decision.executableSha256, c.executableSha256); }
      assert.ok(Array.isArray(r.connectionExceptionDecisions) && r.connectionExceptionDecisions.length === 1);
      assert.equal(r.connectionExceptionDecisions[0].name, 'Move reviewed connections');
      assert.equal(r.connectionExceptionDecisions[0].executableSha256, c.executableSha256);
      const changedFiles = ['combined-owned', 'combined-custom'].includes(role) ? 4 : 5;
      assert.ok(Array.isArray(r.backupsPresentAtFirstObservedChange) && r.backupsPresentAtFirstObservedChange.length === changedFiles);
      assert.equal(new Set(r.backupsPresentAtFirstObservedChange.map(b => b.file)).size, changedFiles);
      for (const backup of r.backupsPresentAtFirstObservedChange) assert.ok(typeof backup.backup === 'string' && backup.backup.endsWith('.bak'));
      exactKeys(r.resourcePins, ['setup/creator-project-setup.exe', 'routing/creator-hub-mcp-router.exe', 'routing/router.json', 'routing/router.minisig', 'routing/runtime.json', 'routing/runtime.minisig']);
      for (const pin of Object.values(r.resourcePins)) digest(pin);
      checkMigrationCase(role, r, c);
    }
  }
  if (incoming || combined) {
    const update = incoming ? r : docs.update;
    const version = role === 'incoming014' ? '0.1.14' : '0.1.12';
    const baseline = require('./self-update-baselines.cjs').baselines.find(b => b.version === version);
    for (const key of ['version', 'installer', 'exe']) assert.equal(update.from[key], baseline[key]);
    assert.deepEqual(update.to, { version: FINAL_VERSION, installer: c.installerSha256, exe: c.executableSha256 });
    for (const key of ['passed', 'selfUpdateTested', 'policyRestored']) assert.equal(update[key], true, key);
    assert.equal(update.nativeAcceptance, false, 'Controlled lab reports must not claim broader native/public acceptance');
    if (incoming) assert.equal(update.managedRouteReconnectTested, true);
    assert.equal(update.publicDiscovery, false); assert.equal(update.releaseReady, false); assert.equal(update.userMachineUsed, false);
    assert.equal(update.testOnlyDescriptor, false, 'Use exact production metadata, not a test-only descriptor');
    assert.equal(update.productionMetadata, true); assert.equal(update.labDiscovery, true); assert.equal(update.directHubUpdateTested, true);
    assert.equal(update.harnessSource, proof.sourceCommit);
    assert.equal(update.sourceKind, `targeted-public-${version}-production-metadata`);
    assert.equal(update.discoveryKind, 'controlled-lab-not-public-discovery');
    positive(update.originalPid); positive(update.restartedPid); assert.notEqual(update.originalPid, update.restartedPid);
    assert.equal(update.originalExitCode, 0);
    assert.equal(update.feed.kind, update.sourceKind); assert.equal(update.feed.previousStable, version);
    assert.equal(update.feed.baselineRole, 'explicit-pinned-public-version');
    for (const [key, expected] of Object.entries({ productSource: c.sourceCommit, productTree: c.sourceTree,
      buildInputsSha256: c.buildInputs.sha256, buildResultSha256: c.buildResult.sha256, productionMetadata: true,
      testOnlyDescriptor: false, labDiscovery: true, publicDiscovery: false, releaseReady: false })) assert.equal(update.feed[key], expected, key);
    checkReportSource(update.feed, c);
    assert.deepEqual(update.feed.pins, finalFeedPins(value));
    checkFinalInputBinding(docs.binding, proof, value);
    if (combined) {
      for (const key of ['signedUpdateObserved', 'normalCloseObserved', 'labCleanupObserved']) assert.equal(r.incomingProduction[key], true, key);
      for (const key of ['processTransfer', 'migrationNetworkObserved', 'migrationIsolationProven', 'publicDiscovery', 'migrationProven', 'releaseReady']) assert.equal(r.incomingProduction[key], false, key);
      const restart = update.observedRestart;
      assert.equal(restart.kind, 'observed-signed-update-restart'); assert.equal(restart.baselinePid, update.originalPid);
      assert.equal(restart.restartedPid, update.restartedPid); assert.equal(restart.baselineImageSha256, baseline.exe);
      assert.equal(restart.restartedImageSha256, c.executableSha256); assert.equal(restart.singletonAtCheckpoints, true);
      for (const key of ['harnessAdditionalLaunch', 'ancestryProven', 'securityAttestation']) assert.equal(restart[key], false);
      for (const key of ['baselineStartTicks', 'approvalLowerBoundTicks', 'restartedStartTicks']) assert.match(restart[key], /^[0-9]+$/);
      assert.ok(BigInt(restart.baselineStartTicks) < BigInt(restart.approvalLowerBoundTicks));
      assert.ok(BigInt(restart.approvalLowerBoundTicks) <= BigInt(restart.restartedStartTicks));
      assert.equal(update.restartedClose.state, 'verified'); assert.equal(update.restartedClose.pid, update.restartedPid);
      assert.equal(update.restartedClose.exitCode, 0);
      assert.equal(r.testSource, proof.sourceCommit); assert.equal(update.harnessSource, proof.sourceCommit);
    }
  }
  if (outgoing) {
    const s = value.successor, tool = role === 'mcp-restore' ? 'mcp' : 'setup', restore = role !== 'setup-no-restore';
    assert.equal(r.kind, RELEASE_TARGET.outgoingKind); assert.equal(r.sourceCommit, s.sourceCommit);
    assert.deepEqual(r.baseline, { version: FINAL_VERSION, installer: c.installerSha256, exe: c.executableSha256 });
    assert.deepEqual(r.pins, s.pins); assert.equal(r.lastTool, tool); assert.equal(r.restore, restore);
    assert.equal(r.restoredLastTool, restore ? tool : null);
    assert.equal(r.migrationDeferred, true);
    assert.deepEqual(r.beforePeVersion, [...FINAL_VERSION.split('.').map(Number), 0]);
    assert.deepEqual(r.afterPeVersion, [...NEXT_VERSION.split('.').map(Number), 0]);
    for (const key of ['nativeUpdateAccepted', 'automaticRestart', 'cancelPreserved', 'settingsPreserved', 'existingConnectionSurvived',
      'newConnectionVerified', 'restorationVerified', 'policyRestored', 'labDiscovery', 'acceptanceOnly']) assert.equal(r[key], true, key);
    assert.equal(r.changedMcpGenerationProven, true, 'Outgoing 0.1.18 must prove an actual managed-runtime generation change');
    assert.deepEqual(r.resourceProbe, { phase: 'after-automatic-root', attempts: 1, passed: true },
      'Outgoing resources require one strict probe after automatic Root observation');
    assert.equal(r.installedResourcesVerifiedBeforeAndAfter, true); assert.equal(r.heldGenerationRetained, true);
    assert.ok(RELEASE_TARGET.runtime, 'Exact final and successor runtime pins are pending');
    assert.equal(r.beforeRoute.generation, RELEASE_TARGET.runtime.baselineGeneration);
    assert.equal(r.afterRoute.generation, RELEASE_TARGET.runtime.targetGeneration);
    positive(r.beforeRoot.pid); positive(r.afterRoot.pid); assert.notEqual(r.beforeRoot.pid, r.afterRoot.pid);
    assert.ok(Array.isArray(r.heldProcessesBefore) && r.heldProcessesBefore.length === 2);
    assert.deepEqual(r.heldProcessesAfter, r.heldProcessesBefore);
    assert.equal(r.heldServerVersion.version, RELEASE_TARGET.runtime.baselineModuleVersion);
    assert.equal(r.reconnectedServerVersion.version, RELEASE_TARGET.runtime.targetModuleVersion);
    assert.equal(r.publicDiscovery, false); assert.equal(r.liveAiAcceptance, false);
  }
  const binding = docs.binding;
  if (role !== 'guarded') assert.equal(binding.harnessSource, proof.sourceCommit);
  if (outgoing) {
    assert.equal(binding.passed, true); assert.equal(binding.case, role);
    assert.equal(binding.reportSha256, proof.documents.report.sha256); assert.equal(binding.lifecycleSha256, proof.documents.lifecycle.sha256);
    assert.deepEqual(binding.baselineSource, FINAL_SOURCE);
    assert.deepEqual(binding.targetSource, { commit: value.successor.sourceCommit, tree: value.successor.sourceTree });
    if (RELEASE_TARGET.runtime.verificationReceiptSha256) {
      assert.equal(binding.verificationReceiptSha256, RELEASE_TARGET.runtime.verificationReceiptSha256);
      assert.equal(binding.recoveryReceiptSha256, undefined, 'Verified fixture19 uses no source-recovery exception');
    } else assert.equal(binding.recoveryReceiptSha256, RELEASE_TARGET.runtime.recoveryReceiptSha256);
    assert.equal(binding.acceptanceOnly, true); assert.equal(binding.publicDiscovery, false); assert.equal(binding.releaseReady, false);
  }
  if (incoming || outgoing || combined) {
    const rows = documentBytes(proof.documents.lifecycle).toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
      .filter(row => row.kind === 'lab-lifecycle-result');
    assert.equal(rows.length, 1); const life = rows[0];
    for (const key of ['lifecycleSucceeded', 'cleanupVerified', 'systemTlsVerified']) assert.equal(life[key], true, key);
    assert.equal(life.driverExitCode, 0); assert.equal(life.rejectedRequestCount, 0);
    assert.equal(life.publicDiscovery, false); assert.equal(life.releaseReady, false);
    assert.notEqual(life.hubCleanupUnknown, true);
    for (const name of ['failureDetails', 'processIdentityFailure']) if (Object.hasOwn(life, name)) assert.equal(life[name], null);
  }
}
function validateFinalQualification(value) {
  releaseProfile.requireSource();
  exactKeys(value, ['schemaVersion', 'kind', 'repository', 'repositoryId', 'version', 'platform', 'authorization',
    'productionApproval', 'releaseReady', 'publicAcceptance', 'productionKeySha256', 'candidate', 'releaseAssociation', 'sourceCi', 'successor', 'draft', 'proofs',
    ...(RELEASE_TARGET.rootBuild ? ['privateMigrationLimitation', 'localEvidence'] : []),
    ...(RELEASE_TARGET.localRestart ? ['localRestartEvidence'] : [])]);
  assert.equal(value.schemaVersion, 1); assert.equal(value.kind, RELEASE_TARGET.qualificationKind);
  assert.equal(value.repository, 'BOBWORKS-XR/CREATOR-HUB'); assert.equal(value.repositoryId, 1364807512);
  assert.equal(value.version, FINAL_VERSION); assert.equal(value.platform, 'windows-x86_64');
  assert.equal(value.authorization, 'publish-qualified-draft-only');
  for (const key of ['productionApproval', 'releaseReady', 'publicAcceptance']) assert.equal(value[key], false);
  if (RELEASE_TARGET.rootBuild) releaseProfile.validatePrivateMigrationLimitation(value.privateMigrationLimitation);
  assert.equal(value.productionKeySha256, PRODUCTION_KEY_SHA256);
  const c = value.candidate;
  if (RELEASE_TARGET.rootBuild) validateLocalEvidence(value.localEvidence, c);
  if (RELEASE_TARGET.localRestart) validateLocalRestartEvidence(value.localRestartEvidence, c);
  exactKeys(c, ['sourceCommit', 'sourceTree', 'parentCommit', 'installerSha256', 'executableSha256', 'buildInputDigest', 'sourceReceiptSha256', 'buildResult', 'buildInputs', 'sourceReceipt',
    ...(RELEASE_TARGET.rootBuild ? ['originalBuildResult'] : [])]);
  digest(c.sourceCommit, 40); digest(c.sourceTree, 40); assert.equal(c.parentCommit, FINAL_PARENT); assert.notEqual(c.sourceCommit, FINAL_PARENT);
  assert.equal(c.sourceCommit, FINAL_SOURCE.commit, 'Final 0.1.17 source differs from the user-supplied freeze');
  assert.equal(c.sourceTree, FINAL_SOURCE.tree, 'Final 0.1.17 tree differs from the user-supplied freeze');
  for (const key of ['installerSha256', 'executableSha256', 'buildInputDigest', 'sourceReceiptSha256']) digest(c[key]);
  assert.notEqual(c.installerSha256, R2.installer, 'R2 bytes cannot qualify as Final 0.1.17'); assert.notEqual(c.executableSha256, R2.executable);
  const build = releaseProfile.validateBuildRecord(documentBytes(c.buildResult), c,
    RELEASE_TARGET.rootBuild ? documentBytes(c.originalBuildResult) : undefined);
  const inputs = documentJson(c.buildInputs), source = documentJson(c.sourceReceipt);
  assert.ok(Array.isArray(inputs) && inputs.length > 0 && inputs.length <= 10000);
  assert.equal(new Set(inputs.map(row => row.path)).size, inputs.length);
  for (const row of inputs) {
    exactKeys(row, ['path', 'sha256']); digest(row.sha256);
    assert.ok(typeof row.path === 'string' && !/[\x00-\x1f\x7f\\:]/.test(row.path) && !row.path.split('/').some(part => !part || part === '.' || part === '..'));
  }
  assert.equal(sha(Buffer.from(JSON.stringify(inputs))), c.buildInputDigest);
  assert.equal(c.sourceReceipt.sha256, c.sourceReceiptSha256);
  assert.equal(source.commit, c.sourceCommit); assert.equal(source.tree, c.sourceTree);
  exactKeys(value.releaseAssociation, ['kind', 'compiledSourceCommit', 'compiledSourceTree', 'built']);
  assert.deepEqual(value.releaseAssociation, { kind: 'metadata-only-child', compiledSourceCommit: FINAL_SOURCE.commit,
    compiledSourceTree: FINAL_SOURCE.tree, built: false });
  validateSourceCi(value.sourceCi, c);
  exactKeys(value.successor, ['version', 'sourceCommit', 'sourceTree', 'pins']);
  assert.equal(value.successor.version, NEXT_VERSION); digest(value.successor.sourceCommit, 40); digest(value.successor.sourceTree, 40);
  exactKeys(value.successor.pins, ['descriptor', 'descriptorSignature', 'installer', 'executable', 'manifest']);
  for (const pin of Object.values(value.successor.pins)) digest(pin);
  if (RELEASE_TARGET.successorEvidence) assert.deepEqual(value.successor, { version: NEXT_VERSION, ...RELEASE_TARGET.successorEvidence },
    'Only the exact independently verified and privately signed fixture19 is admitted');
  assert.notEqual(value.successor.pins.installer, c.installerSha256);
  exactKeys(value.draft, ['id', 'assets']);
  checkFinalDraftMetadata({ id: value.draft.id, target_commitish: c.sourceCommit, tag_name: `v${FINAL_VERSION}`, draft: true, prerelease: false,
    assets: Object.entries(value.draft.assets).map(([name, p]) => ({ name, id: p.id, size: p.size, digest: `sha256:${p.sha256}`, state: 'uploaded' })) }, value.draft, c.sourceCommit);
  assert.equal(value.draft.assets[FINAL_ASSETS[0]].sha256, c.installerSha256);
  for (const name of ['creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig', 'latest.json'])
    assert.notEqual(value.draft.assets[name].sha256, REUSE.assets[name].sha256, 'R2 metadata cannot qualify as Final 0.1.17');
  exactKeys(value.proofs, FINAL_ROLES);
  for (const [role, p] of Object.entries(value.proofs)) {
    exactKeys(p, ['runId', 'runAttempt', 'jobId', 'jobName', 'sourceCommit', 'sourceTree', 'artifact', 'documents']);
    for (const key of ['runId', 'runAttempt', 'jobId']) positive(p[key]); digest(p.sourceCommit, 40); digest(p.sourceTree, 40);
    assert.ok(typeof p.jobName === 'string' && p.jobName.length > 0 && p.jobName.length <= 256);
    checkNativeLane(role, p);
    exactKeys(p.artifact, ['id', 'name', 'size', 'sha256']); positive(p.artifact.id); positive(p.artifact.size); digest(p.artifact.sha256);
    assert.ok(p.artifact.size <= 256 * 1024 * 1024 && typeof p.artifact.name === 'string' && p.artifact.name.length > 0 && p.artifact.name.length <= 256);
    const names = isCombinedRole(role) ? ['report', 'update', 'binding', 'lifecycle']
      : role.startsWith('incoming') || role.includes('-restore') ? ['report', 'binding', 'lifecycle'] : ['report', 'binding'];
    exactKeys(p.documents, names); const members = Object.values(p.documents).map(doc => { documentBytes(doc); return doc.member.toLowerCase(); });
    assert.equal(new Set(members).size, members.length);
    checkFinalReport(role, p, value);
  }
  return value;
}
function loadQualification(file, expectedHash, associationCommit) {
  try {
    releaseProfile.requireSource();
    digest(expectedHash); digest(associationCommit, 40); assert.notEqual(associationCommit, FINAL_SOURCE.commit, 'Association is not the compiled commit');
    const stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 4 * 1024 * 1024, 'Bounded regular receipt required');
    const bytes = fs.readFileSync(file); assert.equal(sha(bytes), expectedHash, 'Independent receipt digest differs');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), value = JSON.parse(text);
    assert.ok(text.trim() === JSON.stringify(value) || text.trim() === JSON.stringify(value, null, 2), 'Canonical receipt required; duplicate keys refused');
    validateFinalQualification(value);
    reviewedFinal.set(value, { digest: expectedHash, canonical: sha(Buffer.from(JSON.stringify(value))), associationCommit }); return value;
  } catch (error) { throw Error(`Windows ${FINAL_VERSION} qualification blocked: reviewed production descriptor and combined evidence required. ${error.message}`); }
}
function checkFinalPayload(value, bodies) {
  releaseProfile.requireSource();
  exactKeys(bodies, FINAL_ASSETS);
  for (const name of FINAL_ASSETS) {
    const bytes = bodies[name], p = value.draft.assets[name];
    assert.ok(Buffer.isBuffer(bytes)); assert.equal(bytes.length, p.size); assert.equal(sha(bytes), p.sha256, `Draft bytes differ: ${name}`);
  }
  const descriptor = bodies['creator-hub-windows-x86_64.json'], signature = bodies['creator-hub-windows-x86_64.json.minisig'];
  assert.deepEqual(JSON.parse(descriptor), { schemaVersion: 1, appId: 'creator-hub', version: FINAL_VERSION, platform: 'windows', architecture: 'x86_64',
    packageType: 'nsis', assetName: FINAL_ASSETS[0], byteLength: bodies[FINAL_ASSETS[0]].length, sha256: value.candidate.installerSha256,
    executableSha256: value.candidate.executableSha256, identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1, minHubVersion: RELEASE_TARGET.minimumHub });
  const verify = require('./linux-016-release-qualification.cjs').verifySignature;
  verify(descriptor, signature);
  const manifest = JSON.parse(bodies['latest.json']), encoded = manifest.platforms?.['windows-x86_64']?.signature;
  const expected = require('./release-descriptor.cjs').updaterManifest({ repo: 'CREATOR-HUB' }, FINAL_VERSION, FINAL_ASSETS[0], encoded);
  assert.equal(manifest.version, expected.version); assert.deepEqual(manifest.platforms, expected.platforms);
  const standalone = bodies[FINAL_ASSETS[1]].toString('utf8');
  assert.ok([encoded, `${encoded}\n`, `${encoded}\r\n`].includes(standalone), 'Standalone installer signature differs');
  verify(bodies[FINAL_ASSETS[0]], Buffer.from(encoded, 'base64'));
  assert.equal(bodies['SHA256SUMS.txt'].toString('utf8'), FINAL_ASSETS.filter(n => n !== 'SHA256SUMS.txt').sort()
    .map(n => `${value.draft.assets[n].sha256}  ${n}\n`).join(''));
}
function finalIo() {
  const get = createGhReader();
  return { request: async route => JSON.parse(get(route, route.startsWith('git/blobs/') ? 8 * 1024 * 1024 : 2 * 1024 * 1024, false)), download: async (route, max) => get(route, max, true) };
}
async function verifyReleaseAssociation(value, reviewed, io) {
  const source = value.candidate.sourceCommit, association = reviewed.associationCommit;
  const record = await io.request(`git/commits/${association}`);
  assert.equal(record.sha, association); digest(record.tree?.sha, 40);
  assert.deepEqual(record.parents.map(p => p.sha), [source], 'Release association must be a metadata-only child of the actual build');
  const comparison = await io.request(`compare/${source}...${association}`);
  assert.equal(comparison.status, 'ahead'); assert.equal(comparison.total_commits, 1);
  assert.equal(comparison.base_commit.sha, source); assert.equal(comparison.merge_base_commit.sha, source);
  assert.deepEqual(comparison.commits.map(c => c.sha), [association]);
  assert.ok(Array.isArray(comparison.files) && comparison.files.length > 0 && comparison.files.length <= ASSOCIATION_FILES.length);
  const names = new Set();
  for (const file of comparison.files) {
    assert.ok(ASSOCIATION_FILES.includes(file.filename) && !names.has(file.filename), 'Association changes unapproved or product code');
    assert.ok(['added', 'modified'].includes(file.status)); assert.ok(!file.previous_filename || file.previous_filename === file.filename);
    digest(file.sha, 40); names.add(file.filename);
  }
  for (const name of ['.gitattributes', '.github/workflows/release.yml', 'scripts/windows-016-release-qualification.cjs',
    'scripts/windows-release-target.cjs', 'scripts/windows-release-target.test.cjs', 'scripts/fixtures/windows-release-target.cjs',
    'scripts/windows-017-draft-stage.cjs', 'scripts/windows-017-draft-stage.test.cjs', 'scripts/windows-017-signing.cjs',
    'scripts/windows-018-public-acceptance.cjs', 'scripts/windows-018-public-acceptance.test.cjs',
    'scripts/check-unified-sources.cjs', 'scripts/publish-hub-draft.cjs', `packaging/windows/${FINAL_VERSION}-qualification.json`,
    `packaging/windows/${FINAL_VERSION}-qualification.json.sha256`]) assert.ok(names.has(name), `Required release association file absent: ${name}`);
  const baseTree = await io.request(`git/trees/${value.candidate.sourceTree}`);
  assert.equal(baseTree.sha, value.candidate.sourceTree);
  const baseAttributes = baseTree.tree.filter(f => f.path === '.gitattributes' && f.type === 'blob');
  assert.equal(baseAttributes.length, 1);
  const attributes = comparison.files.find(f => f.filename === '.gitattributes');
  const decode = blob => { assert.equal(blob.encoding, 'base64'); const bytes = Buffer.from(blob.content, 'base64'); assert.equal(bytes.length, blob.size); return bytes; };
  checkAssociationAttributes(decode(await io.request(`git/blobs/${baseAttributes[0].sha}`)), decode(await io.request(`git/blobs/${attributes.sha}`)));
  for (const [name, checksum] of [[`packaging/windows/${FINAL_VERSION}-qualification.json`, false], [`packaging/windows/${FINAL_VERSION}-qualification.json.sha256`, true]]) {
    const file = comparison.files.find(f => f.filename === name), blob = await io.request(`git/blobs/${file.sha}`);
    assert.equal(blob.sha, file.sha); assert.equal(blob.encoding, 'base64');
    assert.ok(Number.isSafeInteger(blob.size) && blob.size > 0 && blob.size <= (checksum ? 128 : 4 * 1024 * 1024));
    const bytes = Buffer.from(blob.content, 'base64'); assert.equal(bytes.length, blob.size);
    if (checksum) assert.equal(bytes.toString('utf8').trim(), reviewed.digest);
    else assert.equal(sha(bytes), reviewed.digest, 'Association receipt differs from the independently reviewed local receipt');
  }
  return { commit: association, tree: record.tree.sha, compiledSourceCommit: source, built: false };
}
async function verifyReleaseState(value, io, expectedDraft) {
  releaseProfile.requireSource();
  const reviewed = value && reviewedFinal.get(value);
  assert.ok(reviewed, 'Windows 0.1.17 qualification blocked: load the digest-pinned Final 0.1.17 production descriptor and combined evidence receipt first');
  assert.equal(sha(Buffer.from(JSON.stringify(value))), reviewed.canonical, 'Reviewed qualification changed');
  validateFinalQualification(value);
  // Revalidate the same object after asynchronous reads; callers cannot swap pins mid-check.
  const snapshot = reviewed.canonical;
  io ||= finalIo(); assert.ok(typeof io.request === 'function' && typeof io.download === 'function');
  const checkCommit = async (source, tree, parent) => {
    const record = await io.request(`git/commits/${source}`); assert.equal(record.sha, source); assert.equal(record.tree?.sha, tree);
    if (parent) assert.deepEqual(record.parents.map(p => p.sha), [parent], 'Final 0.1.17 must directly descend from the approved source association');
  };
  await checkCommit(value.candidate.sourceCommit, value.candidate.sourceTree, FINAL_PARENT);
  const association = await verifyReleaseAssociation(value, reviewed, io);
  const ci = value.sourceCi;
  await verifySourceCi(ci, value, io);
  await checkCommit(value.successor.sourceCommit, value.successor.sourceTree);
  for (const [role, p] of Object.entries(value.proofs)) {
    await checkCommit(p.sourceCommit, p.sourceTree);
    const run = await io.request(`actions/runs/${p.runId}`), job = await io.request(`actions/jobs/${p.jobId}`);
    const artifact = await io.request(`actions/artifacts/${p.artifact.id}`);
    const workflow = finalProofWorkflow(role);
    for (const [key, expected] of Object.entries({ id: p.runId, run_attempt: p.runAttempt, event: 'workflow_dispatch', status: 'completed', head_sha: p.sourceCommit, path: workflow })) assert.equal(run[key], expected, key);
    // The first production run's independent fresh job passed; signed siblings failed and need separate successful proofs.
    assert.ok((role === 'fresh' ? ['success', 'failure'] : ['success']).includes(run.conclusion), 'Native run did not complete acceptably');
    for (const repo of [run.repository, run.head_repository]) { assert.equal(repo.id, value.repositoryId); assert.equal(repo.full_name, value.repository); }
    for (const [key, expected] of Object.entries({ id: p.jobId, name: p.jobName, run_id: p.runId, run_attempt: p.runAttempt, head_sha: p.sourceCommit, status: 'completed', conclusion: 'success' })) assert.equal(job[key], expected, key);
    assert.ok(job.labels.includes('windows-latest'));
    for (const [key, expected] of Object.entries({ id: p.artifact.id, name: p.artifact.name, size_in_bytes: p.artifact.size, digest: `sha256:${p.artifact.sha256}`, expired: false })) assert.equal(artifact[key], expected, key);
    for (const [key, expected] of Object.entries({ id: p.runId, head_sha: p.sourceCommit, repository_id: value.repositoryId, head_repository_id: value.repositoryId })) assert.equal(artifact.workflow_run[key], expected, key);
    const times = [job.started_at, artifact.created_at, job.completed_at].map(Date.parse);
    assert.ok(times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2]);
    const archive = await io.download(`actions/artifacts/${p.artifact.id}/zip`, p.artifact.size + 1);
    assert.ok(Buffer.isBuffer(archive)); assert.equal(archive.length, p.artifact.size); assert.equal(sha(archive), p.artifact.sha256);
    for (const doc of Object.values(p.documents)) assert.ok(readZipMember(archive, doc.member).equals(documentBytes(doc)), 'Original artifact evidence differs');
  }
  const before = await io.request(`releases/${value.draft.id}`); checkFinalDraftMetadata(before, value.draft, association.commit, expectedDraft);
  const bodies = {};
  for (const name of FINAL_ASSETS) { const p = value.draft.assets[name]; bodies[name] = await io.download(`releases/assets/${p.id}`, p.size + 1); }
  checkFinalPayload(value, bodies);
  checkFinalDraftMetadata(await io.request(`releases/${value.draft.id}`), value.draft, association.commit, expectedDraft);
  assert.equal(sha(Buffer.from(JSON.stringify(value))), snapshot, 'Qualification changed during verification');
  return { version: value.version, platform: value.platform, draftId: value.draft.id, qualificationSha256: reviewed.digest,
    releaseAssociationCommit: association.commit, releaseAssociationVerified: true, associationBuilt: false,
    compiledSourceCommit: value.candidate.sourceCommit,
    productionApproval: expectedDraft, sourceCiVerified: true, sourceCiScope: ci.scope, nativeEvidenceVerified: true, signaturesVerified: true,
    ...(expectedDraft ? {} : { releaseIsPublic: true }), publicAcceptance: false, releaseReady: false };
}
async function verifyRemote(value, io) { return verifyReleaseState(value, io, true); }
async function verifyPublishedRemote(value, io) { return verifyReleaseState(value, io, false); }
function ghApiArgs(route, binary) {
  assert.match(route, /^(?:actions\/(?:runs|jobs|artifacts)\/|git\/(?:commits|blobs|trees)\/|compare\/[a-f0-9]{40}\.\.\.[a-f0-9]{40}$|releases\/)/);
  return ['api', ...(binary && route.startsWith('releases/assets/') ? ['-H', 'Accept:application/octet-stream'] : []), `repos/BOBWORKS-XR/CREATOR-HUB/${route}`];
}
const ghRawCapabilities = new WeakMap();
function createGhReader(execute = require('node:child_process').execFileSync) {
  return (route, maxBuffer, binary = false) => {
    const args = ghApiArgs(route, binary);
    assert.ok(Number.isSafeInteger(maxBuffer) && maxBuffer > 0, 'Bounded capture required');
    if (binary) {
      assert.match(route, /^(?:actions\/(?:jobs\/[0-9]+\/logs|artifacts\/[0-9]+\/zip)|releases\/assets\/[0-9]+)$/,
        'Unknown raw capture route');
      if (!ghRawCapabilities.has(execute)) {
        const help = execute('gh', ['api', '--help'], { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 128 * 1024, stdio: 'pipe' });
        ghRawCapabilities.set(execute, /^\s*--allow-escape-sequences(?:\s|$)/m.test(String(help)));
      }
      if (ghRawCapabilities.get(execute)) args.splice(1, 0, '--allow-escape-sequences');
    }
    // Raw data never inherits a terminal. Preserve bytes for the existing hash checks.
    const bytes = execute('gh', args, { windowsHide: true, timeout: 60000, maxBuffer, stdio: 'pipe' });
    assert.ok(Buffer.isBuffer(bytes), 'Raw API capture must return bytes');
    return bytes;
  };
}
module.exports = { R2, KNOWN, DETAILS, MISSING, SOURCE_TREES, ASSETS, OUTGOING, DIAGNOSTIC, INCOMING_DIAGNOSTIC, OBSERVED_DRAFT, REUSE, checkReuseApproval, checkCommitTree, readZipMember, checkDraftMetadata, checkTestOnlyPayload, checkProductionPins, checkProductionPayload, checkDraftBytes, checkDraftReadback, checkKnownReport, checkKnownProof, checkExistingRemote, checkOutgoingCase, checkOutgoingProvenance, verifyExistingEvidence, checkDiagnosticContents, checkDiagnosticRemote, checkIncomingDiagnosticContents, checkIncomingDiagnosticRemote, verifyIncomingDiagnostic, verifyObservedDraft, verifyObservedPreflight, ghApiArgs, loadCandidateReceipt, verifyCandidateRemote, FINAL_PARENT, FINAL_SOURCE, FINAL_SOURCE_CI, validateSourceCi, verifySourceCi, FINAL_ASSETS, FINAL_ROLES, PRODUCTION_KEY_SHA256, OUTGOING18_RECOVERY, validateOutgoing18Recovery, verifyOutgoing18Recovery, validateFinalQualification, checkFinalPayload, checkFinalReport, finalProofWorkflow, loadQualification, verifyRemote };
Object.assign(module.exports, { RELEASE_TARGET, FINAL_VERSION, NEXT_VERSION, R6_SOURCE, captureSourceCi });
Object.assign(module.exports, { validateLocalEvidence, captureLocalEvidence });
Object.assign(module.exports, { validateLocalRestartEvidence });
Object.assign(module.exports, { isCombinedRole, checkNativeLane, checkMigrationCase });
Object.assign(module.exports, { FINAL_JOB_NAMES, checkFinalDraftMetadata });
Object.assign(module.exports, { createGhReader });
Object.assign(module.exports, { checkReportSource });
Object.assign(module.exports, { ASSOCIATION_FILES });
Object.assign(module.exports, { checkAssociationAttributes });
Object.assign(module.exports, { verifyPublishedRemote });
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    assert.ok((args.length === 1 && ['--check-evidence', '--check-incoming-diagnostic', '--check-observed-preflight', '--capture-source-ci'].includes(args[0])) ||
      (args[0] === '--check-final' && args.length === 4) ||
      (args[0] === '--check-outgoing18-fixture' && args.length === 3) ||
      (args[0] === '--check-preflight' && (args.length === 3 || (args.length === 6 && args[3] === '--reuse-approval'))),
    'Read-only evidence or preflight verification only');
    const { execFileSync } = require('node:child_process');
    const get = createGhReader(execFileSync);
    const io = { request: async route => JSON.parse(get(route, route.startsWith('git/blobs/') ? 8 * 1024 * 1024 : 2 * 1024 * 1024)), download: async (route, max) => get(route, max, true) };
    let result;
    if (args[0] === '--check-evidence') result = await verifyExistingEvidence(io);
    else if (args[0] === '--capture-source-ci') result = await captureSourceCi(io);
    else if (args[0] === '--check-incoming-diagnostic') result = await verifyIncomingDiagnostic(io);
    else if (args[0] === '--check-observed-preflight') result = await verifyObservedPreflight(io);
    else if (args[0] === '--check-final') result = await verifyRemote(loadQualification(args[1], args[2], args[3]), io);
    else if (args[0] === '--check-outgoing18-fixture') result = verifyOutgoing18Recovery(args[1], args[2]);
    else {
      assert.match(args[2], /^[a-f0-9]{64}$/); const stat = fs.statSync(args[1]);
      assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 32768);
      let reuse;
      if (args.length === 6) {
        assert.match(args[5], /^[a-f0-9]{64}$/); const approval = fs.statSync(args[4]);
        assert.ok(approval.isFile() && approval.size > 0 && approval.size <= 32768);
        reuse = { bytes: fs.readFileSync(args[4]), sha256: args[5] };
      }
      result = await verifyCandidateRemote(fs.readFileSync(args[1]), args[2], io, reuse);
    }
    console.log(JSON.stringify(result));
  })().catch(error => { console.error(`Evidence verification refused: ${error.message}`); process.exitCode = 1; });
}
