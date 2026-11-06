'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const q21 = require('./windows-021-release-qualification.cjs');
const root = path.resolve(__dirname, '..');
const template = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/windows-021-qualification.json')));
const evidence = JSON.parse(fs.readFileSync(path.join(__dirname, 'windows-021-evidence.json')));
const remote = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/windows-021-remote.json')));
const clone = x => JSON.parse(JSON.stringify(x));
const association = 'a'.repeat(40), treeId = 'b'.repeat(40);
const gitHash = b => crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
function loaded() { const file = path.join(root, 'packaging/windows/0.1.21-qualification.json');
  return q21.loadQualification(file, q21.hash(fs.readFileSync(file)), association, { pubRoot: root }); }
function editDoc(e, name, edit, raw = false) {
  const p = e.documents[name], value = Buffer.from(p.base64, 'base64');
  const b = raw ? Buffer.from(edit(value.toString('utf8'))) : Buffer.from(JSON.stringify(edit(JSON.parse(value))));
  p.base64 = b.toString('base64'); p.size = b.length; p.sha256 = q21.hash(b);
}
function setup() {
  const requests = clone(remote.requests), downloads = Object.fromEntries(Object.entries(remote.downloads).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
  const files = requests[`git/trees/${q21.PRODUCT.sourceTree}?recursive=1`].tree.filter(x => x.type === 'blob').map(clone);
  function add(name, bytes) {
    const sha = gitHash(bytes), row = { path: name, type: 'blob', mode: '100644', sha, size: bytes.length };
    const index = files.findIndex(x => x.path === name); if (index < 0) files.push(row); else files[index] = row;
    requests['git/blobs/' + sha] = { sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') };
  }
  for (const name of ['scripts/windows-021-release-qualification.cjs', 'scripts/windows-021-evidence.json',
    'packaging/windows/0.1.21-qualification.json', 'packaging/windows/0.1.21-qualification.json.sha256']) add(name, fs.readFileSync(path.join(root, name)));
  requests['git/commits/' + association] = { sha: association, tree: { sha: treeId }, parents: [{ sha: q21.PRODUCT.sourceCommit }] };
  requests[`git/trees/${treeId}?recursive=1`] = { sha: treeId, truncated: false, tree: files };
  requests['releases/latest'] = { id: q21.PREVIOUS.id, tag_name: q21.PREVIOUS.tag, target_commitish: q21.PREVIOUS.association, draft: false, prerelease: false };
  requests['releases/' + template.draft.id] = { id: template.draft.id, tag_name: 'v0.1.21', target_commitish: association, draft: true, prerelease: false,
    assets: Object.entries(template.draft.assets).map(([name, p]) => ({ name, id: p.id, size: p.size, digest: 'sha256:' + p.sha256, state: 'uploaded' })) };
  requests['git/ref/tags/v0.1.21'] = { ref: 'refs/tags/v0.1.21', object: { type: 'commit', sha: association } };
  if (process.env.QUALIFICATION_021_ASSETS) for (const name of q21.ASSETS) downloads['releases/assets/' + template.draft.assets[name].id] = fs.readFileSync(path.join(process.env.QUALIFICATION_021_ASSETS, name));
  return { requests, downloads, files, add, io: {
    request: async name => { assert.ok(requests[name], 'Missing request fixture ' + name); return clone(requests[name]); },
    download: async (name, max) => { assert.ok(downloads[name], 'Missing download fixture ' + name); assert.ok(downloads[name].length <= max); return downloads[name]; },
  } };
}
test('exact real 021 qualification validates locally without claiming publication or new live AI', () => {
  const r = q21.verifyLocal(loaded()); assert.equal(r.version, '0.1.21'); assert.equal(r.localEvidenceVerified, true);
  assert.equal(r.publicAcceptance, false); assert.equal(r.releaseReady, false); assert.match(r.nativeScope, /inherited from 020/);
});
for (const [name, edit] of [
  ['old version', q => q.version = '0.1.20'], ['other platform', q => q.platform = 'linux-x86_64'],
  ['wrong source', q => q.candidate.sourceCommit = '1'.repeat(40)], ['wrong installer', q => q.candidate.installerSha256 = '1'.repeat(64)],
  ['wrong draft', q => q.draft.id++], ['wrong asset id', q => q.draft.assets['latest.json'].id++],
  ['wrong asset hash', q => q.draft.assets['latest.json'].sha256 = '1'.repeat(64)], ['missing asset', q => delete q.draft.assets['latest.json']],
  ['public claim', q => q.publicAcceptance = true], ['readiness claim', q => q.releaseReady = true],
  ['other notes', q => q.publicNotes += '!'], ['extra field', q => q.unreviewed = true],
]) test('qualification refuses ' + name, () => { const q = clone(template); edit(q); assert.throws(() => q21.validateQualification(q)); });
test('digest mismatch and duplicate JSON fields are refused', () => {
  const dir = fs.mkdtempSync(path.join(__dirname, 'fixtures/windows-021-test-'));
  try { const file = path.join(dir, 'receipt.json'), bytes = JSON.stringify(template).replace('{', '{"version":"0.1.20",'); fs.writeFileSync(file, bytes);
    assert.throws(() => q21.loadQualification(file, '0'.repeat(64), association, { pubRoot: root }), /Receipt differs/);
    assert.throws(() => q21.loadQualification(file, q21.hash(Buffer.from(bytes)), association, { pubRoot: root }), /Canonical/);
  } finally { assert.ok(path.resolve(dir).startsWith(path.join(__dirname, 'fixtures/windows-021-test-'))); fs.rmSync(dir, { recursive: true }); }
});
for (const [label, name, edit, raw] of [
  ['undeclared projection', 'source', x => { x.base = q21.PREVIOUS.source; return x; }],
  ['failed build', 'build', x => { x.status = 1; return x; }],
  ['extra build changes', 'build', x => { x.changed = ['src-tauri/src/main.rs']; return x; }],
  ['different bundled server', 'signing', x => { x.manifest.modules.mcp.files['mcp/server/creator-works-mcp.mjs'] = '0'.repeat(64); return x; }],
  ['missing sole skip', 'sourceLog', x => x.replace('skipped 1', 'skipped 0'), true],
  ['changed skip reason', 'sourceLog', x => x.replaceAll('CREATOR_UNITY_REFERENCE_EDITOR', 'UNREVIEWED_SKIP'), true],
  ['failed native cancellation', 'mcp-restore/report', x => { x.cancelPreserved = false; return x; }],
  ['native public claim', 'native', x => { x.publicDiscovery = true; return x; }],
  ['new live AI claim', 'nativeUi', x => { x.liveAiAccountAcceptance = true; return x; }],
  ['no reader revocation', 'nativeUi', x => { x.revokedRead.rejected = false; return x; }],
]) test('evidence refuses ' + label, () => { const e = clone(evidence); editDoc(e, name, edit, raw); assert.throws(() => q21.validateEvidence(e)); });
test('projection retains original hash and discloses omitted personal-path fields', () => {
  assert.deepEqual(evidence.documents.build.projection.omittedFields, ['output']);
  assert.equal(evidence.documents.source.projection.originalSha256, q21.document(evidence, 'inputVerification').freezeReceiptSha256);
  for (const p of Object.values(evidence.documents)) assert.doesNotMatch(Buffer.from(p.base64, 'base64').toString('utf8'), /C:[\\/]+Users[\\/]+bobman/i);
});
test('actual remote fixture proves R2 parent c287 and exact source CI delta', async () => { const s = setup(); await q21.verifySource(s.io, evidence); });
test('actual remote archives prove all source/native jobs and member bytes', async () => { await q21.verifyProofs(setup().io, evidence); });
for (const [label, mutate] of [
  ['wrong source parent', s => s.requests['git/commits/' + q21.PRODUCT.sourceCommit].parents[0].sha = q21.PREVIOUS.source],
  ['truncated product tree', s => s.requests[`git/trees/${q21.PRODUCT.sourceTree}?recursive=1`].truncated = true],
  ['wrong tree SHA', s => s.requests[`git/trees/${q21.PRODUCT.sourceTree}?recursive=1`].sha = '1'.repeat(40)],
  ['added gitlink', s => s.requests[`git/trees/${q21.PRODUCT.sourceTree}?recursive=1`].tree.push({ path: 'hidden-module', type: 'commit', mode: '160000', sha: '1'.repeat(40) })],
  ['unsafe tree path', s => s.requests[`git/trees/${q21.PRODUCT.sourceTree}?recursive=1`].tree.push({ path: '../escape', type: 'blob', mode: '100644', sha: '1'.repeat(40) })],
  ['duplicate tree entry', s => { const t = s.requests[`git/trees/${q21.PRODUCT.sourceTree}?recursive=1`].tree; t.push(clone(t.find(x => x.type === 'blob'))); }],
  ['unsafe file mode', s => s.requests[`git/trees/${q21.PRODUCT.sourceTree}?recursive=1`].tree.find(x => x.type === 'blob').mode = '120000'],
]) test('source refuses ' + label, async () => { const s = setup(); mutate(s); await assert.rejects(q21.verifySource(s.io, evidence)); });
for (const [label, mutate] of [
  ['failed run', s => s.requests['actions/runs/42293366877'].conclusion = 'failure'],
  ['different run source', s => s.requests['actions/runs/42293366877'].head_sha = q21.PRODUCT.sourceCommit],
  ['foreign repository', s => s.requests['actions/runs/42295894387'].repository.id++],
  ['failed job', s => s.requests['actions/jobs/' + evidence.proofs['mcp-restore'].jobId].conclusion = 'failure'],
  ['expired artifact', s => s.requests['actions/artifacts/' + evidence.proofs.sourceCi.artifact.id].expired = true],
  ['artifact digest', s => s.requests['actions/artifacts/' + evidence.proofs.sourceCi.artifact.id].digest = 'sha256:' + '0'.repeat(64)],
  ['artifact provenance', s => s.requests['actions/artifacts/' + evidence.proofs.sourceCi.artifact.id].workflow_run.head_sha = '0'.repeat(40)],
  ['artifact timing', s => s.requests['actions/artifacts/' + evidence.proofs.sourceCi.artifact.id].created_at = '2000-01-01T00:00:00Z'],
  ['corrupt archive', s => { s.downloads['actions/artifacts/' + evidence.proofs.sourceCi.artifact.id + '/zip'][10] ^= 1; }],
]) test('remote proof refuses ' + label, async () => { const s = setup(); mutate(s); await assert.rejects(q21.verifyProofs(s.io, evidence)); });
test('metadata-only association is accepted, product edits and wrong parent are refused', async () => {
  const q = loaded(), s = setup(), review = { associationCommit: association, digest: q21.hash(fs.readFileSync(path.join(root, 'packaging/windows/0.1.21-qualification.json'))) };
  const prod = await q21.verifySource(s.io, evidence); await q21.verifyAssociation(q, s.io, evidence, review, prod);
  s.add('src-tauri/src/main.rs', Buffer.from('unreviewed product edit'));
  await assert.rejects(q21.verifyAssociation(q, s.io, evidence, review, prod), /Forbidden association/);
  s.files.splice(s.files.findIndex(x => x.path === 'src-tauri/src/main.rs'), 1);
  s.requests['git/commits/' + association].parents = [{ sha: q21.PREVIOUS.association }];
  await assert.rejects(q21.verifyAssociation(q, s.io, evidence, review, prod));
});
test('association refuses a gitlink instead of silently omitting it', async () => {
  const q = loaded(), s = setup();
  const prod = await q21.verifySource(s.io, evidence);
  s.files.push({ path: 'hidden-module', type: 'commit', mode: '160000', sha: '1'.repeat(40) });
  await assert.rejects(q21.verifyAssociation(q, s.io, evidence,
    { associationCommit: association, digest: q21.hash(fs.readFileSync(path.join(root, 'packaging/windows/0.1.21-qualification.json'))) }, prod));
});
test('duplicate release assets are refused even when their names collapse to the expected set', async () => {
  const q = loaded(), s = setup(); s.requests['releases/' + q.draft.id].assets.push(clone(s.requests['releases/' + q.draft.id].assets[0]));
  await assert.rejects(q21.verifyRemote(q, s.io));
});
test('GET-only route builder rejects writes and arbitrary endpoints', () => {
  assert.deepEqual(q21.ghApiArgs('git/ref/tags/v0.1.21').slice(0, 3), ['api', '--method', 'GET']);
  for (const route of ['releases', 'repos/other/repo', 'git/ref/tags/v0.1.20', 'actions/runs/1/rerun', '../tokens']) assert.throws(() => q21.ghApiArgs(route));
});
test('exact six signed public assets pass draft and published verification without latest promotion', async t => {
  if (!process.env.QUALIFICATION_021_ASSETS) return t.skip('Set QUALIFICATION_021_ASSETS to the six actual staged 021 assets');
  const s = setup(), q = loaded(); const first = await q21.verifyRemote(q, s.io);
  assert.equal(first.productionApproval, true); assert.equal(first.publicAcceptance, false); assert.equal(first.releaseReady, false);
  s.requests['releases/' + q.draft.id].draft = false;
  assert.equal((await q21.verifyPublishedRemote(q, s.io)).releaseIsPublic, true);
  s.requests['git/ref/tags/v0.1.21'].object.sha = q21.PRODUCT.sourceCommit;
  await assert.rejects(q21.verifyPublishedRemote(q, s.io));
});
test('actual signatures and notes-only payload reject byte or metadata substitution', t => {
  if (!process.env.QUALIFICATION_021_ASSETS) return t.skip('Set QUALIFICATION_021_ASSETS to the six actual staged 021 assets');
  const bodies = Object.fromEntries(q21.ASSETS.map(n => [n, fs.readFileSync(path.join(process.env.QUALIFICATION_021_ASSETS, n))]));
  assert.equal(q21.checkPayload(template, bodies, root), true);
  for (const name of q21.ASSETS) { const bad = { ...bodies, [name]: Buffer.from(bodies[name]) }; bad[name][0] ^= 1; assert.throws(() => q21.checkPayload(template, bad, root)); }
});
