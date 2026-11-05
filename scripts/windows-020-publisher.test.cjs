'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { publishDraft, finishPublicRelease } = require('./publish-hub-draft.cjs');
function fixture() {
  const options = { platform: 'windows-x86_64', association: 'a'.repeat(40), sha256: 'b'.repeat(64), promoteLatest: true };
  const qualification = { draft: { id: 435215396 } }, writes = [];
  const verified = { productionApproval: true, sourceCiVerified: true, nativeEvidenceVerified: true, signaturesVerified: true,
    publicAcceptance: false, releaseReady: false, releaseAssociationVerified: true, associationBuilt: false,
    releaseAssociationCommit: options.association, version: '0.1.20', platform: options.platform,
    qualificationSha256: options.sha256, draftId: qualification.draft.id, releaseIsPublic: true };
  const accepted = { publicAcceptance: true, version: '0.1.20', releaseId: qualification.draft.id,
    association: options.association, qualificationSha256: options.sha256 };
  let latest = { id: 433720791, tag_name: 'v0.1.19', draft: false, prerelease: false };
  const actions = { checkReadiness: () => qualification, verifyQualification: async () => verified,
    verifyPublishedQualification: async () => verified, verifyPublicAcceptance: async () => accepted,
    checkDraft: async () => ({ previousStable: '0.1.19' }), checkLive: async () => ({ previousStable: '0.1.19' }),
    getLatest: async () => ({ ...latest }), publish: async () => { writes.push('publish'); },
    promote: async () => { writes.push('promote'); latest = { id: qualification.draft.id, tag_name: 'v0.1.20', draft: false, prerelease: false }; } };
  return { options, qualification, verified, accepted, actions, writes };
}
test('020 publication keeps the current stable and never promotes during stage', async () => {
  const f = fixture(), result = await publishDraft('0.1.20', f.actions, f.options);
  assert.equal(result.ready, false); assert.deepEqual(f.writes, ['publish']);
});
test('020 publication rejects incomplete signature/source/native qualification before write', async () => {
  for (const field of ['productionApproval', 'sourceCiVerified', 'nativeEvidenceVerified', 'signaturesVerified', 'releaseAssociationVerified']) {
    const f = fixture(); f.verified[field] = false;
    await assert.rejects(publishDraft('0.1.20', f.actions, f.options)); assert.deepEqual(f.writes, []);
  }
});
test('020 publication requires the actual 019 public predecessor', async () => {
  const f = fixture(); f.actions.checkDraft = async () => ({ previousStable: '0.1.18' });
  await assert.rejects(publishDraft('0.1.20', f.actions, f.options), /previous stable/); assert.deepEqual(f.writes, []);
});
test('020 latest requires the exact successful public update evidence', async () => {
  const f = fixture(); assert.equal((await finishPublicRelease('0.1.20', f.actions, f.options)).ready, true);
  assert.deepEqual(f.writes, ['promote']);
  for (const field of ['publicAcceptance', 'association', 'qualificationSha256', 'releaseId']) {
    const bad = fixture(); bad.accepted[field] = false;
    await assert.rejects(finishPublicRelease('0.1.20', bad.actions, bad.options)); assert.deepEqual(bad.writes, []);
  }
});
test('020 public verification is read-only without explicit promotion', async () => {
  const f = fixture(); f.options.promoteLatest = false;
  assert.equal((await finishPublicRelease('0.1.20', f.actions, f.options)).ready, false); assert.deepEqual(f.writes, []);
});
