'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const q20 = require('./windows-020-release-qualification.cjs');
const evidence = JSON.parse(fs.readFileSync(path.join(__dirname, 'windows-020-evidence.json')));
const fixture = JSON.parse(zlib.gunzipSync(Buffer.from(JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/windows-020-remote.json'))).data, 'base64')));
const templateFile = path.join(__dirname, 'fixtures/windows-020-qualification.json');
const template = JSON.parse(fs.readFileSync(templateFile));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const blobSha = b => crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
const bytes = key => Buffer.from(evidence.documents[key].base64, 'base64');
const clone = value => structuredClone(value);
const root = fs.mkdtempSync(path.join(__dirname, '.qualification-tests-'));
fs.mkdirSync(path.join(root, 'src-tauri'));
fs.writeFileSync(path.join(root, 'src-tauri/tauri.conf.json'), fixture.keyConfig);
test.after(() => { assert.equal(path.dirname(root), path.resolve(__dirname)); fs.rmSync(root, { recursive: true, force: true }); });
const association = 'a'.repeat(40), associationTree = 'b'.repeat(40);
let serial = 0;
function load(value = template, options = {}) {
  const b = Buffer.from(JSON.stringify(value, null, 2) + '\n'), file = path.join(root, `receipt-${serial++}.json`);
  fs.writeFileSync(file, b);
  return q20.loadQualification(file, options.hash || sha(b), options.association || association, { pubRoot: options.pubRoot || root });
}
function rewrite(e, key, transform) {
  const obj = JSON.parse(Buffer.from(e.documents[key].base64, 'base64')); transform(obj);
  const b = Buffer.from(JSON.stringify(obj)); Object.assign(e.documents[key], { size: b.length, sha256: sha(b), base64: b.toString('base64') });
}
function setupRemote(published = false) {
  const q = load(), responses = clone(fixture.requests), downloads = clone(fixture.downloads);
  const rows = JSON.parse(bytes('inventory')).map(r => ({ path: r.path, mode: r.mode, type: 'blob', sha: r.blob }));
  function put(name, b) {
    const id = blobSha(b); responses[`git/blobs/${id}`] = { sha: id, size: b.length, encoding: 'base64', content: b.toString('base64') };
    const i = rows.findIndex(r => r.path === name), row = { path: name, mode: '100644', type: 'blob', sha: id };
    if (i < 0) rows.push(row); else rows[i] = row;
  }
  for (const [name, id] of Object.entries(evidence.inherited.files)) {
    const i = rows.findIndex(r => r.path === name), row = { path: name, mode: '100644', type: 'blob', sha: id };
    if (i < 0) rows.push(row); else rows[i] = row;
  }
  const receipt = Buffer.from(JSON.stringify(template, null, 2) + '\n');
  put('packaging/windows/0.1.20-qualification.json', receipt);
  put('packaging/windows/0.1.20-qualification.json.sha256', Buffer.from(sha(receipt) + '\n'));
  put('scripts/windows-020-release-qualification.cjs', fs.readFileSync(path.join(__dirname, 'windows-020-release-qualification.cjs')));
  put('scripts/windows-020-evidence.json', fs.readFileSync(path.join(__dirname, 'windows-020-evidence.json')));
  responses[`git/commits/${association}`] = { sha: association, tree: { sha: associationTree }, parents: [{ sha: q20.PRODUCT.sourceCommit }] };
  responses[`git/trees/${associationTree}?recursive=1`] = { sha: associationTree, tree: rows, truncated: false };
  responses[`releases/${q.draft.id}`].target_commitish = association;
  responses[`releases/${q.draft.id}`].draft = !published;
  responses['git/ref/tags/v0.1.20'] = { ref: 'refs/tags/v0.1.20', object: { type: 'commit', sha: association } };
  const calls = [], assets = Object.fromEntries(Object.entries(fixture.smallAssets).map(([n, b]) => [n, Buffer.from(b, 'base64')]));
  const assetDirectory = process.env.QUALIFICATION_020_ASSETS || path.join(__dirname, '..', 'public-stage-020', 'assets');
  const io = {
    request: async route => { calls.push(route); assert.ok(Object.hasOwn(responses, route), `Uncaptured GET: ${route}`); return clone(responses[route]); },
    download: async (route, max) => {
      calls.push(route); let b;
      if (route.startsWith('releases/assets/')) {
        const n = q20.ASSETS.find(n => q.draft.assets[n].id === Number(route.split('/').at(-1)));
        b = assets[n] || fs.readFileSync(path.join(assetDirectory, n));
      } else { assert.ok(downloads[route], `Uncaptured bytes: ${route}`); b = Buffer.from(downloads[route], 'base64'); }
      assert.ok(b.length <= max); return b;
    }
  };
  return { q, io, responses, downloads, rows, put, calls, assets, assetDirectory };
}
test('local exact source/build/native/client proof has explicit limits', () => {
  const result = q20.verifyLocal(load()); assert.equal(result.publicAcceptance, false); assert.equal(result.releaseReady, false);
  assert.match(result.actualClientScope, /deferred, not passed/); assert.match(result.nativeScope, /inherited from 019/);
});
for (const [name, mutate] of [
  ['wrong source commit', q => { q.candidate.sourceCommit = 'c'.repeat(40); }],
  ['wrong source tree', q => { q.candidate.sourceTree = 'c'.repeat(40); }],
  ['wrong installer', q => { q.candidate.installerSha256 = 'c'.repeat(64); }],
  ['wrong executable', q => { q.candidate.executableSha256 = 'c'.repeat(64); }],
  ['wrong evidence', q => { q.evidenceSha256 = 'c'.repeat(64); }],
  ['wrong descriptor', q => { q.draft.assets[q20.ASSETS[2]].sha256 = 'c'.repeat(64); }],
  ['extra asset', q => { q.draft.assets.extra = clone(q.draft.assets[q20.ASSETS[0]]); }],
  ['missing asset', q => { delete q.draft.assets[q20.ASSETS[3]]; }],
  ['false public pass', q => { q.publicAcceptance = true; }],
  ['wrong notes', q => { q.publicNotes = 'Arbitrary release'; }],
  ['duplicate asset ID', q => { q.draft.assets[q20.ASSETS[1]].id = q.draft.assets[q20.ASSETS[0]].id; }],
  ['old version reuse', q => { q.version = '0.1.19'; }]
]) test(`receipt refuses ${name}`, () => { const value = clone(template); mutate(value); assert.throws(() => load(value)); });
test('loader refuses wrong external hash, missing association, duplicate fields and unreviewed objects', () => {
  assert.throws(() => load(template, { hash: 'f'.repeat(64) }));
  assert.throws(() => q20.loadQualification(templateFile, sha(fs.readFileSync(templateFile))));
  const file = path.join(root, 'duplicate.json'), b = Buffer.from(JSON.stringify(template).replace('{', '{"schemaVersion":1,'));
  fs.writeFileSync(file, b); assert.throws(() => q20.loadQualification(file, sha(b), association, { pubRoot: root }));
  assert.throws(() => q20.verifyLocal(template), /Load/);
});
for (const key of ['build', 'sourceCi', 'native', 'codex', 'desktop', 'restoration', 'authorization', 'mcp-restore/lifecycle'])
  test(`missing ${key} proof is refused`, () => { const e = clone(evidence); delete e.documents[key]; assert.throws(() => q20.validateEvidence(e)); });
for (const [key, mutate] of [
  ['source', r => { r.commit = 'c'.repeat(40); }], ['build', r => { r.status = 1; }],
  ['signing', r => { r.verification.wrongPublicKeyRejected = false; r.verification.negativeProofs.wrongPublicKeyRejected = false; }],
  ['sourceCi', r => { r.passed = 437; r.failed = 1; }], ['native', r => { r.nativeUpdateAccepted = false; }],
  ['mcp-restore/report', r => { r.settingsPreserved = false; }], ['setup-restore/report', r => { r.automaticRestart = false; }],
  ['setup-no-restore/report', r => { r.existingConnectionSurvived = false; }], ['mcp-restore/binding', r => { r.harnessSource = 'c'.repeat(40); }],
  ['codex', r => { r.passed = false; }], ['desktop', r => { r.settingsRestored = false; }],
  ['claude', r => { r.passed = true; }], ['clients', r => { r.claudeCode.releaseDisposition = 'passed'; }],
  ['restoration', r => { r.restoredSha256 = 'c'.repeat(64); }]
]) test(`failed ${key} proof is refused even if its local hash is updated`, () => {
  const e = clone(evidence); rewrite(e, key, mutate); assert.throws(() => q20.validateEvidence(e));
});
test('wrong production key and tampered descriptor signatures are refused cryptographically', () => {
  const key = q20.publicKey(root), body = Buffer.from(fixture.smallAssets[q20.ASSETS[2]], 'base64'), signature = Buffer.from(fixture.smallAssets[q20.ASSETS[3]], 'base64');
  q20.verifySignature(body, signature, key);
  const badBody = Buffer.from(body); badBody[30] ^= 1; assert.throws(() => q20.verifySignature(badBody, signature, key));
  const wrongKey = Buffer.from(key); wrongKey[12] ^= 1; assert.throws(() => q20.verifySignature(body, signature, wrongKey));
  const wrongId = Buffer.from(key); wrongId[2] ^= 1; assert.throws(() => q20.verifySignature(body, signature, wrongId));
  const altered = signature.toString('utf8').replace(/(^|\n)trusted comment: /, '$1trusted comment: changed ');
  assert.throws(() => q20.verifySignature(body, Buffer.from(altered), key));
  const wrongRoot = path.join(root, 'wrong-key'); fs.mkdirSync(path.join(wrongRoot, 'src-tauri'), { recursive: true });
  const config = JSON.parse(fixture.keyConfig); config.plugins.updater.pubkey = Buffer.from('wrong').toString('base64');
  fs.writeFileSync(path.join(wrongRoot, 'src-tauri/tauri.conf.json'), JSON.stringify(config));
  assert.throws(() => load(template, { pubRoot: wrongRoot }), /production public key/);
});
for (const [name, mutate] of [
  ['wrong current stable', s => { s.responses['releases/latest'].id = 1; }],
  ['premature latest 020', s => { s.responses['releases/latest'].id = s.q.draft.id; s.responses['releases/latest'].tag_name = 'v0.1.20'; }],
  ['wrong stable association', s => { s.responses['releases/latest'].target_commitish = 'c'.repeat(40); }],
  ['wrong remote source', s => { s.responses[`git/commits/${q20.PRODUCT.sourceCommit}`].tree.sha = 'c'.repeat(40); }],
  ['nonmatching association', s => { s.responses[`git/commits/${association}`].sha = 'c'.repeat(40); }],
  ['association merge parent', s => { s.responses[`git/commits/${association}`].parents.push({ sha: 'c'.repeat(40) }); }],
  ['forbidden product change', s => { s.put('src/app.js', Buffer.from('changed')); }],
  ['forbidden old reader change', s => { s.put('scripts/windows-release-target.cjs', Buffer.from('changed')); }],
  ['missing inherited metadata', s => { s.rows.splice(s.rows.findIndex(r => r.path === 'scripts/windows-017-signing.cjs'), 1); }],
  ['truncated tree', s => { s.responses[`git/trees/${associationTree}?recursive=1`].truncated = true; }],
  ['wrong associated receipt', s => { s.put('packaging/windows/0.1.20-qualification.json', Buffer.from('{}')); }],
  ['failed CI job', s => { s.responses[`actions/jobs/${evidence.proofs.sourceCi.jobId}`].conclusion = 'failure'; }],
  ['wrong CI harness source', s => { s.responses[`actions/runs/${evidence.proofs.sourceCi.runId}`].head_sha = 'c'.repeat(40); }],
  ['wrong native harness workflow bytes', s => { const b = s.responses[`git/blobs/${evidence.workflowDocuments.native.blob}`]; b.content = Buffer.from('changed').toString('base64'); }],
  ['expired proof', s => { s.responses[`actions/artifacts/${evidence.proofs['mcp-restore'].artifact.id}`].expired = true; }],
  ['wrong original archive', s => { const route = `actions/artifacts/${evidence.proofs.sourceCi.artifact.id}/zip`; const b = Buffer.from(s.downloads[route], 'base64'); b[0] ^= 1; s.downloads[route] = b.toString('base64'); }],
  ['wrong release target', s => { s.responses[`releases/${s.q.draft.id}`].target_commitish = q20.PRODUCT.sourceCommit; }],
  ['unpublished state mismatch', s => { s.responses[`releases/${s.q.draft.id}`].draft = false; }],
  ['extra release asset', s => { s.responses[`releases/${s.q.draft.id}`].assets.push(clone(s.responses[`releases/${s.q.draft.id}`].assets[0])); }]
]) test(`remote refuses ${name}`, async () => { const s = setupRemote(); mutate(s); await assert.rejects(q20.verifyRemote(s.q, s.io)); });
test('all production transport routes are explicit GET-only and bounded', async () => {
  const commands = [], io = q20.createGhReader((command, args, opts) => { commands.push({ command, args, opts }); return Buffer.from(args.includes('releases/assets/1') ? 'x' : '{}'); });
  await io.request('releases/latest');
  for (const bad of ['releases', 'dispatches', 'actions/runs/1/cancel', 'releases/1?x=1', '../releases/1']) assert.throws(() => q20.ghApiArgs(bad));
  assert.deepEqual(commands[0].args.slice(0, 3), ['api', '--method', 'GET']); assert.equal(commands[0].opts.stdio, 'pipe');
});
test('full draft fixture verifies exact archives, six real assets, signatures, and compatibility result', async t => {
  const s = setupRemote(); if (!fs.existsSync(path.join(s.assetDirectory, q20.ASSETS[0]))) return t.skip('Set QUALIFICATION_020_ASSETS to the six staged assets');
  const result = await q20.verifyRemote(s.q, s.io);
  assert.deepEqual(result, { version: '0.1.20', platform: 'windows-x86_64', qualificationSha256: sha(Buffer.from(JSON.stringify(template, null, 2) + '\n')),
    draftId: template.draft.id, productionApproval: true, sourceCiVerified: true, nativeEvidenceVerified: true, signaturesVerified: true,
    publicAcceptance: false, releaseReady: false, releaseAssociationVerified: true, associationBuilt: false, releaseAssociationCommit: association });
  assert.equal(s.calls.filter(r => r === 'releases/latest').length, 2);
});
test('explicit parent metadata overrides remain eligible without changing old target readers', async t => {
  const s = setupRemote(); if (!fs.existsSync(path.join(s.assetDirectory, q20.ASSETS[0]))) return t.skip('Set QUALIFICATION_020_ASSETS to the six staged assets');
  for (const name of ['README.md', '.github/workflows/release.yml', 'scripts/check-unified-sources.cjs',
    'scripts/publish-hub-draft.cjs', 'scripts/self-update-baselines.cjs', 'scripts/self-update-baselines.test.cjs',
    'scripts/windows-020-publisher.test.cjs']) s.put(name, Buffer.from('explicitly reviewed metadata only\n'));
  assert.equal((await q20.verifyRemote(s.q, s.io)).releaseAssociationVerified, true);
});
test('published fixture still withholds public acceptance and latest promotion', async t => {
  const s = setupRemote(true); if (!fs.existsSync(path.join(s.assetDirectory, q20.ASSETS[0]))) return t.skip('Set QUALIFICATION_020_ASSETS to the six staged assets');
  const result = await q20.verifyPublishedRemote(s.q, s.io); assert.equal(result.releaseIsPublic, true); assert.equal(result.publicAcceptance, false);
  s.responses['releases/latest'].id = s.q.draft.id; await assert.rejects(q20.verifyPublishedRemote(s.q, s.io), /Latest changed/);
});
test('published tag must resolve to the reviewed association, not only target_commitish', async t => {
  const s = setupRemote(true); if (!fs.existsSync(path.join(s.assetDirectory, q20.ASSETS[0]))) return t.skip('Set QUALIFICATION_020_ASSETS to the six staged assets');
  s.responses['git/ref/tags/v0.1.20'].object.sha = q20.PRODUCT.sourceCommit;
  await assert.rejects(q20.verifyPublishedRemote(s.q, s.io), /Published tag/);
});
test('downloaded bytes must match every pinned asset digest', t => {
  const s = setupRemote(); if (!fs.existsSync(path.join(s.assetDirectory, q20.ASSETS[0]))) return t.skip('Set QUALIFICATION_020_ASSETS to the six staged assets');
  const all = { ...s.assets, [q20.ASSETS[0]]: fs.readFileSync(path.join(s.assetDirectory, q20.ASSETS[0])) };
  for (const name of q20.ASSETS) { const bad = Buffer.from(all[name]); bad[0] ^= 1;
    assert.throws(() => q20.checkPayload(s.q, { ...all, [name]: bad }, root), /digest/); }
});
test('approved notes-only projection passes; changed URL, version or signature is refused', t => {
  const s = setupRemote(); if (!fs.existsSync(path.join(s.assetDirectory, q20.ASSETS[0]))) return t.skip('Set QUALIFICATION_020_ASSETS to the six staged assets');
  const all = { ...s.assets, [q20.ASSETS[0]]: fs.readFileSync(path.join(s.assetDirectory, q20.ASSETS[0])) };
  assert.equal(q20.checkPayload(s.q, all, root), true);
  for (const field of ['url', 'signature', 'version']) {
    const q = clone(template), b = { ...all }, latest = JSON.parse(b['latest.json']);
    if (field === 'version') latest.version = '0.1.21'; else latest.platforms['windows-x86_64'][field] += 'changed';
    b['latest.json'] = Buffer.from(JSON.stringify(latest)); q.draft.assets['latest.json'].sha256 = sha(b['latest.json']); q.draft.assets['latest.json'].size = b['latest.json'].length;
    assert.throws(() => q20.checkPayload(q, b, root), /notes-only/);
  }
});
