'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const prior = require('./windows-020-release-qualification.cjs');
const REPO = 'BOBWORKS-XR/CREATOR-HUB', REPO_ID = 1364807512;
const VERSION = '0.1.21', PLATFORM = 'windows-x86_64';
const PRODUCTION_KEY_SHA256 = prior.PRODUCTION_KEY_SHA256;
const EVIDENCE_SHA256 = '16e8440c5dc069be6d00784170fe8b809381580fbc16cd25f9eb25cdb32fd630';
const PRODUCT = Object.freeze({ sourceCommit: '35411a704707cba5915f77d51bf156e4ec8ce251',
  sourceTree: '4f80b815406aedf577a3f9cb78c1f7fd6caf968b',
  installerSha256: '09dd6563e5e93a533f7ddedc600c785f56d123f55d1e29a8eada6ab3941cf2b3',
  executableSha256: 'b29fe05699196383bbd376f23af934fe9f603761c3de285f16e6c4a3095222f5' });
const PREVIOUS = Object.freeze({ id: 435215396, tag: 'v0.1.20', association: 'c287b4168bdbf34d1dfae5f424fab033213a237f',
  associationTree: 'c98b92feef48294b13fef7daa7c53b57ca7c4052', source: prior.PRODUCT.sourceCommit, tree: prior.PRODUCT.sourceTree,
  installer: prior.PRODUCT.installerSha256, executable: prior.PRODUCT.executableSha256 });
const ASSETS = Object.freeze(['Creator.Hub_0.1.21_x64-setup.exe', 'Creator.Hub_0.1.21_x64-setup.exe.sig',
  'creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig', 'latest.json', 'SHA256SUMS.txt']);
const PUBLIC_NOTES = 'Safer session-only project registration, bounded project listings, and opt-in native inventory reading. Existing settings are retained.';
const ASSOCIATION_FILES = Object.freeze(['.gitattributes', '.github/workflows/release.yml', 'README.md',
  'scripts/check-unified-sources.cjs', 'scripts/publish-hub-draft.cjs', 'scripts/self-update-baselines.cjs',
  'scripts/self-update-baselines.test.cjs', 'docs/RELEASE-0.1.21.md', 'docs/WINDOWS-021-QUALIFICATION.md',
  'modules/mcp/docs/session-projects-native-inventory.md', 'scripts/windows-021-release-qualification.cjs',
  'scripts/windows-021-release-qualification.test.cjs', 'scripts/windows-021-evidence.json',
  'scripts/windows-021-public-acceptance.cjs', 'scripts/windows-021-public-acceptance.test.cjs',
  'scripts/windows-021-publisher.test.cjs',
  'scripts/windows-021-public-contract.cjs', 'scripts/fixtures/windows-021-qualification.json',
  'scripts/fixtures/windows-021-remote.json', 'scripts/fixtures/public-update-021-binding.json',
  'packaging/windows/0.1.21-qualification.json', 'packaging/windows/0.1.21-qualification.json.sha256']);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const parse = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
function exact(o, keys) { assert.ok(o && typeof o === 'object' && !Array.isArray(o)); assert.deepEqual(Object.keys(o).sort(), [...keys].sort()); }
function digest(v, n = 64) { assert.match(v || '', new RegExp(`^[a-f0-9]{${n}}$`)); }
function positive(v, max = 256 * 1024 * 1024) { assert.ok(Number.isSafeInteger(v) && v > 0 && v <= max); }
function bounded(file, max) { const s = fs.lstatSync(file); assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1); positive(s.size, max);
  const b = fs.readFileSync(file); assert.equal(b.length, s.size); return b; }
function capture(bytes, pin) { assert.ok(Buffer.isBuffer(bytes)); assert.equal(bytes.length, pin.size); assert.equal(hash(bytes), pin.sha256, 'Evidence digest differs'); return bytes; }
function document(e, name, asJson = true) { const p = e.documents[name]; assert.ok(p, 'Missing evidence: ' + name);
  positive(p.size, 1024 * 1024); digest(p.sha256); const b = Buffer.from(p.base64, 'base64'); assert.equal(b.toString('base64'), p.base64);
  capture(b, p); return asJson ? parse(b) : b; }
function evidence() { const b = bounded(path.join(__dirname, 'windows-021-evidence.json'), 3 * 1024 * 1024);
  assert.equal(hash(b), EVIDENCE_SHA256, 'Pinned 021 evidence changed'); return parse(b); }
function flags(o, yes, no = []) { for (const k of yes) assert.equal(o[k], true, k); for (const k of no) assert.equal(o[k], false, k); }
function generation(m) { return hash(JSON.stringify({ executable: m.executable, version: m.version,
  files: Object.fromEntries(Object.entries(m.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) })); }
function validateEvidence(e) {
  assert.equal(e.schemaVersion, 1); for (const k of Object.keys(e.documents)) document(e, k, false);
  const s = document(e, 'source'), b = document(e, 'build'), signed = document(e, 'signing'), inputs = document(e, 'inputVerification');
  assert.equal(s.commit, PRODUCT.sourceCommit); assert.equal(s.tree, PRODUCT.sourceTree);
  assert.equal(s.base, PREVIOUS.association); assert.equal(s.baseTree, PREVIOUS.associationTree);
  assert.equal(s.productAncestor, PREVIOUS.source); assert.equal(s.sourceFileCount, 1550);
  assert.deepEqual(s.versions, { hubFrom: '0.1.20', hubTo: VERSION, mcpFrom: '2.7.8', mcpTo: '2.7.9' });
  flags(s, ['publishedRootAndSetupPreserved', 'refsAndRealIndexUnchanged'], ['built', 'installed', 'signed', 'published', 'releaseReady']);
  assert.equal(e.documents.inventory.sha256, s.sourceInventorySha256); const inv = document(e, 'inventory');
  assert.equal(inv.length, 1550); assert.equal(new Set(inv.map(x => x.path)).size, 1550);
  for (const x of inv) { digest(x.blob, 40); digest(x.sha256); assert.ok(['100644', '100755'].includes(x.mode)); }
  for (const [name, original, omissions] of [['source', inputs.freezeReceiptSha256,
    ['explicitSourceFiles', 'freezeScriptSha256', 'frozenAt', 'inputInventorySha256', 'inputs', 'output', 'planSha256', 'repository', 'source', 'sourceAudit', 'versionFiles', 'workspace']],
  ['build', signed.buildResultSha256, ['output']]]) {
    const p = e.documents[name].projection; assert.equal(p.kind, 'explicit-field-projection'); assert.equal(p.originalSha256, original);
    positive(p.originalSize, 1024 * 1024); assert.deepEqual(p.omittedFields, omissions);
    assert.deepEqual(p.includedFields.sort(), Object.keys(document(e, name)).sort());
  }
  assert.equal(b.kind, 'windows-021-private-build'); assert.equal(b.sourceCommit, PRODUCT.sourceCommit); assert.equal(b.sourceTree, PRODUCT.sourceTree);
  assert.equal(b.hubVersion, VERSION); assert.equal(b.mcpVersion, '2.7.9'); assert.equal(b.phase, 'signed-windows-build');
  assert.equal(b.status, 0); assert.equal(b.error, null); assert.deepEqual(b.changed, []); flags(b, ['sourceUnchanged'], ['installed', 'published', 'releaseReady']);
  assert.equal(b.installerSha256, PRODUCT.installerSha256); assert.equal(b.executableSha256, PRODUCT.executableSha256);
  assert.deepEqual(signed.source, { commit: PRODUCT.sourceCommit, tree: PRODUCT.sourceTree }); assert.equal(signed.inputCount, 1550);
  assert.equal(signed.inputSha256, s.sourceInventorySha256); assert.equal(signed.buildExitCode, 0);
  assert.equal(signed.installer.sha256, PRODUCT.installerSha256); assert.equal(signed.installer.bytes, 38469639);
  assert.equal(signed.executable.sha256, PRODUCT.executableSha256); assert.equal(signed.payloadFiles, 15);
  flags(signed, ['sourceUnchanged', 'outerSigned'], ['sourceRawUnchanged', 'productionApproval', 'published', 'releaseReady', 'publicDiscovery']);
  assert.deepEqual(signed.rawChanged, ['modules/mcp/launcher/src-tauri/gen/schemas/acl-manifests.json',
    'modules/mcp/launcher/src-tauri/gen/schemas/desktop-schema.json', 'modules/mcp/launcher/src-tauri/gen/schemas/windows-schema.json']);
  flags(signed.verification, ['internalSignaturesVerified', 'descriptorSignatureVerified', 'installerSignatureVerified', 'extractedPayloadsMatch']);
  for (const v of Object.values(signed.verification.negativeProofs)) assert.equal(v, true);
  assert.equal(inputs.buildResultSha256, signed.buildResultSha256); assert.equal(inputs.inputSha256, signed.inputSha256);
  assert.equal(signed.manifest.modules.mcp.version, '2.7.9'); assert.equal(signed.manifest.modules.setup.version, '0.3.7');
  assert.equal(signed.manifest.modules.mcp.files['mcp/server/creator-works-mcp.mjs'], '115adb67aedce3f88ae798872f1c269d992cf410b50755138033eda6484b8d29');
  assert.equal(generation(signed.manifest.modules.mcp), signed.generation); assert.equal(inputs.generation, signed.generation);
  const oldE = parse(fs.readFileSync(path.join(__dirname, 'windows-020-evidence.json'))), oldSigned = document(oldE, 'signing');
  assert.equal(signed.manifest.modules.setup.executable, oldSigned.manifest.modules.setup.executable);
  assert.deepEqual(signed.manifest.modules.setup.files, { 'setup/creator-project-setup.exe': '1f307fa96ccd1ac83673a89743a7bd4de4d58dbaa8e778b5c65f8fd4e56ca216' });
  assert.equal(signed.manifest.managedRouting.protocol, oldSigned.manifest.managedRouting.protocol);
  assert.deepEqual(Object.keys(signed.manifest.managedRouting.files).sort(), Object.keys(oldSigned.manifest.managedRouting.files).sort());
  for (const v of Object.values(signed.manifest.managedRouting.files)) digest(v);
  for (const [name, total, pass, skipped] of [['sourceLog', 467, 466, 1], ['bundleLog', 10, 10, 0]]) {
    const text = document(e, name, false).toString('utf8');
    for (const [label, count] of [['tests', total], ['pass', pass], ['fail', 0], ['cancelled', 0], ['skipped', skipped], ['todo', 0]])
      assert.match(text, new RegExp(`(?:^|\\n)[^\\n]*?\\b${label} ${count}\\r?(?:\\n|$)`));
    if (name === 'sourceLog') assert.match(text, /opt-in helper compiles against installed Unity 6 reference assemblies[^\n]+Set CREATOR_UNITY_REFERENCE_EDITOR/);
  }
  assert.equal(e.proofs.sourceCi.runId, 42293366877); assert.equal(e.proofs.sourceCi.sourceCommit, '72fb0e44eb28b5f1007c76e6ef94d57b38f5e1a4');
  const native = document(e, 'native'); assert.equal(native.runId, 42295894387); assert.equal(native.source, PRODUCT.sourceCommit);
  assert.equal(native.harness, 'e69c9a65203b9b91ff85c6395b0f056e011084e6');
  flags(native, ['nativeUpdateAccepted'], ['publicDiscovery', 'liveAiAccountAcceptance', 'localAppChanged', 'published', 'releaseReady']);
  assert.deepEqual(native.cases.map(x => x.case).sort(), ['mcp-restore', 'setup-no-restore', 'setup-restore']);
  for (const c of native.cases) {
    const r = document(e, c.case + '/report'), binding = document(e, c.case + '/binding');
    assert.equal(c.reportSha256, e.documents[c.case + '/report'].sha256); assert.equal(c.lifecycleSha256, e.documents[c.case + '/lifecycle'].sha256);
    flags(r, ['passed', 'nativeUpdateAccepted', 'cancelPreserved', 'automaticRestart', 'existingConnectionSurvived', 'newConnectionVerified',
      'restorationVerified', 'settingsPreserved', 'policyRestored', 'changedMcpGenerationProven', 'installedResourcesVerifiedBeforeAndAfter', 'heldGenerationRetained', 'migrationDeferralPreserved'],
    ['publicDiscovery', 'liveAiAcceptance', 'releaseReady']);
    assert.equal(r.kind, 'direct-outgoing-020-021'); assert.equal(r.sourceCommit, PRODUCT.sourceCommit);
    assert.deepEqual(r.baseline, { version: '0.1.20', installer: PREVIOUS.installer, exe: PREVIOUS.executable });
    assert.equal(r.pins.installer, PRODUCT.installerSha256); assert.equal(r.pins.executable, PRODUCT.executableSha256);
    assert.equal(r.pins.manifest, e.documents.privateManifest.sha256); assert.equal(r.heldServerVersion.version, '2.7.8'); assert.equal(r.reconnectedServerVersion.version, '2.7.9');
    assert.deepEqual(r.beforePeVersion, [0, 1, 20, 0]); assert.deepEqual(r.afterPeVersion, [0, 1, 21, 0]);
    assert.equal(r.afterRoute.generation, signed.generation); assert.notEqual(r.beforeRoute.generation, r.afterRoute.generation);
    assert.deepEqual(r.heldProcessesAfter, r.heldProcessesBefore); assert.equal(binding.passed, true);
    assert.equal(binding.reportSha256, c.reportSha256); assert.equal(binding.lifecycleSha256, c.lifecycleSha256);
    assert.deepEqual(binding.targetSource, signed.source); assert.deepEqual(binding.baselineSource, { commit: PREVIOUS.source, tree: PREVIOUS.tree });
    const rows = document(e, c.case + '/lifecycle', false).toString('utf8').trim().split(/\r?\n/).map(JSON.parse).filter(x => x.kind === 'lab-lifecycle-result');
    assert.equal(rows.length, 1); flags(rows[0], ['lifecycleSucceeded', 'cleanupVerified', 'systemTlsVerified', 'labDiscovery'], ['publicDiscovery', 'releaseReady']);
    assert.equal(rows[0].driverExitCode, 0); assert.equal(rows[0].failureDetails, null); assert.equal(rows[0].processIdentityFailure, null);
  }
  const local = document(e, 'nativeUi'); flags(local, ['success', 'readerExited'], ['liveAiAccountAcceptance']);
  assert.equal(local.buildExitCode, 0); assert.equal(local.playerExitCode, 0); assert.equal(local.backend, 'IL2CPP');
  assert.equal(local.bundleSha256, signed.manifest.modules.mcp.files['mcp/server/creator-works-mcp.mjs']);
  assert.equal(local.cases.length, 6); for (const c of local.cases) assert.equal(c.passed, true);
  assert.equal(local.approvedRead.returned, 4); digest(local.approvedRead.contentHash); assert.equal(local.revokedRead.rejected, true);
  assert.equal(e.inherited.association, PREVIOUS.association); assert.equal(e.inherited.source, PREVIOUS.source); assert.equal(e.inherited.liveAi21Accepted, false);
  return { source: s, inventory: inv, signed };
}
function validateQualification(q) {
  exact(q, ['schemaVersion', 'kind', 'version', 'platform', 'candidate', 'evidenceSha256', 'authorization', 'publicAcceptance', 'releaseReady', 'publicNotes', 'draft']);
  assert.equal(q.schemaVersion, 1); assert.equal(q.kind, 'windows-021-staged-qualification'); assert.equal(q.version, VERSION); assert.equal(q.platform, PLATFORM);
  assert.deepEqual(q.candidate, PRODUCT); assert.equal(q.evidenceSha256, EVIDENCE_SHA256); assert.equal(q.publicNotes, PUBLIC_NOTES);
  assert.equal(q.authorization, 'staged-public-020-to-021-before-latest;client-protocol-inherited-020;no-new-live-ai'); flags(q, [], ['publicAcceptance', 'releaseReady']);
  exact(q.draft, ['id', 'assets']); const stage = evidence().stage; assert.equal(q.draft.id, stage.releaseId); assert.equal(q.draft.id, 437086314);
  exact(q.draft.assets, ASSETS); for (const n of ASSETS) { const p = q.draft.assets[n]; exact(p, ['id', 'size', 'sha256']);
    assert.deepEqual(p, { id: stage.assets[n].id, size: stage.assets[n].bytes, sha256: stage.assets[n].sha256 }); }
  return q;
}
const reviewed = new WeakMap();
function loadQualification(file, expectedSha256, associationCommit, options = {}) {
  digest(expectedSha256); digest(associationCommit, 40); assert.notEqual(associationCommit, PRODUCT.sourceCommit);
  const bytes = bounded(file, 32768); assert.equal(hash(bytes), expectedSha256, 'Receipt differs from independent review');
  const q = parse(bytes), text = bytes.toString('utf8').trim(); assert.ok(text === JSON.stringify(q) || text === JSON.stringify(q, null, 2), 'Canonical receipt required');
  validateQualification(q); const freeze = o => { if (o && typeof o === 'object') { Object.values(o).forEach(freeze); Object.freeze(o); } }; freeze(q);
  reviewed.set(q, { digest: expectedSha256, associationCommit, pubRoot: path.resolve(options.pubRoot || path.join(__dirname, '..')) }); verifyLocal(q); return q;
}
function verifyLocal(q) {
  const r = reviewed.get(q); assert.ok(r, 'Load the digest-pinned 021 qualification first'); validateQualification(q); const e = evidence(); validateEvidence(e);
  const oldFile = path.join(__dirname, '../packaging/windows/0.1.20-qualification.json');
  assert.equal(hash(bounded(oldFile, 32768)), e.inherited.receiptSha256);
  prior.loadQualification(oldFile, e.inherited.receiptSha256, PREVIOUS.association, { pubRoot: r.pubRoot }); prior.publicKey(r.pubRoot);
  return { version: VERSION, platform: PLATFORM, qualificationSha256: r.digest, draftId: q.draft.id, localEvidenceVerified: true,
    sourceCiScope: '466/467 source checks with one explicit Unity-reference skip; 10 bundled checks',
    nativeScope: 'three private 020-to-021 cases plus IL2CPP native UI/SDK stdio; client protocol inherited from 020, not new live AI acceptance', publicAcceptance: false, releaseReady: false };
}
function checkPayload(q, bodies, pubRoot) {
  exact(bodies, ASSETS); for (const n of ASSETS) capture(bodies[n], q.draft.assets[n]); const key = prior.publicKey(pubRoot);
  assert.deepEqual(parse(bodies[ASSETS[2]]), { schemaVersion: 1, appId: 'creator-hub', version: VERSION, platform: 'windows', architecture: 'x86_64',
    packageType: 'nsis', assetName: ASSETS[0], byteLength: 38469639, sha256: PRODUCT.installerSha256,
    executableSha256: PRODUCT.executableSha256, identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1, minHubVersion: '0.1.19' });
  prior.verifySignature(bodies[ASSETS[2]], bodies[ASSETS[3]], key);
  const original = document(evidence(), 'privateManifest'), latest = parse(bodies['latest.json']);
  assert.deepEqual(latest, { ...original, notes: q.publicNotes }, 'Only reviewed notes may change');
  const base64 = latest.platforms[PLATFORM].signature, signature = Buffer.from(base64, 'base64'); assert.equal(signature.toString('base64'), base64);
  assert.ok(bodies[ASSETS[1]].equals(signature) || [base64, base64 + '\n', base64 + '\r\n'].includes(bodies[ASSETS[1]].toString('utf8')));
  prior.verifySignature(bodies[ASSETS[0]], signature, key);
  assert.equal(bodies['SHA256SUMS.txt'].toString('utf8'), ASSETS.filter(n => n !== 'SHA256SUMS.txt').sort().map(n => `${q.draft.assets[n].sha256}  ${n}\n`).join(''));
  return true;
}
function ghApiArgs(route, binary = false) {
  assert.match(route, /^(?:git\/commits\/[a-f0-9]{40}|git\/trees\/[a-f0-9]{40}\?recursive=1|git\/(?:blobs|tags)\/[a-f0-9]{40}|git\/ref\/tags\/v0\.1\.21|actions\/(?:runs|jobs|artifacts)\/[1-9][0-9]*(?:\/zip)?|releases\/(?:latest|[1-9][0-9]*|assets\/[1-9][0-9]*))$/);
  if (binary) assert.match(route, /^(?:actions\/artifacts\/[1-9][0-9]*\/zip|releases\/assets\/[1-9][0-9]*)$/);
  return ['api', '--method', 'GET', ...(binary && route.startsWith('releases/assets/') ? ['-H', 'Accept:application/octet-stream'] : []), `repos/${REPO}/${route}`];
}
function createGhReader(execute = execFileSync) { return { request: async r => parse(execute('gh', ghApiArgs(r), { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024, stdio: 'pipe' })),
  download: async (r, max) => { positive(max); const b = execute('gh', ghApiArgs(r, true), { windowsHide: true, timeout: 180000, maxBuffer: max, stdio: 'pipe' }); assert.ok(Buffer.isBuffer(b) && b.length <= max); return b; } }; }
async function commit(io, sha, expectedTree) { const c = await io.request('git/commits/' + sha); assert.equal(c.sha, sha); if (expectedTree) assert.equal(c.tree.sha, expectedTree); return c; }
async function tree(io, sha) {
  const t = await io.request(`git/trees/${sha}?recursive=1`); assert.equal(t.sha, sha); assert.equal(t.truncated, false);
  assert.ok(t.tree.length > 0 && t.tree.length < 10000); const map = {};
  for (const row of t.tree) { assert.ok(row.path && !Object.hasOwn(map, row.path)); digest(row.sha, 40);
    assert.ok(!row.path.startsWith('/') && !/[\\:\x00-\x1f]/.test(row.path) && row.path.split('/').every(p => p && p !== '.' && p !== '..'));
    if (row.type === 'tree') continue;
    assert.equal(row.type, 'blob'); assert.ok(['100644', '100755'].includes(row.mode)); map[row.path] = { sha: row.sha, mode: row.mode }; }
  return map;
}
async function blob(io, sha, max = 3 * 1024 * 1024) { const b = await io.request('git/blobs/' + sha); assert.equal(b.sha, sha); assert.equal(b.encoding, 'base64');
  positive(b.size, max); const bytes = Buffer.from(b.content, 'base64'); assert.equal(bytes.length, b.size);
  assert.equal(crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), sha); return bytes; }
const changes = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(n => a[n]?.sha !== b[n]?.sha || a[n]?.mode !== b[n]?.mode).sort();
async function verifySource(io, e) {
  const c = await commit(io, PRODUCT.sourceCommit, PRODUCT.sourceTree); assert.deepEqual(c.parents.map(x => x.sha), [PREVIOUS.association]);
  await commit(io, PREVIOUS.association, PREVIOUS.associationTree); const product = await tree(io, PRODUCT.sourceTree), base = await tree(io, PREVIOUS.associationTree);
  const inheritedReceipt = await blob(io, base['packaging/windows/0.1.20-qualification.json'].sha, 32768);
  assert.equal(hash(inheritedReceipt), e.inherited.receiptSha256); assert.equal(inheritedReceipt.length, e.inherited.receiptSize);
  const s = document(e, 'source'), inv = document(e, 'inventory'); assert.equal(Object.keys(product).length, inv.length);
  for (const x of inv) assert.deepEqual(product[x.path], { sha: x.blob, mode: x.mode });
  assert.deepEqual(changes(base, product), s.changedPaths.slice().sort());
  for (const n of changes(base, product)) { assert.ok(product[n], 'Frozen product deletion'); if (n.startsWith('modules/mcp/')) continue;
    assert.ok(['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json'].includes(n));
    const before = (await blob(io, base[n].sha)).toString('utf8');
    const expected = n === 'src-tauri/Cargo.lock' ? before
      .replace('\nname = "creator-hub"\nversion = "0.1.20"\n', '\nname = "creator-hub"\nversion = "0.1.21"\n')
      .replace('\nname = "creator-works-mcp-launcher"\nversion = "2.7.8"\n', '\nname = "creator-works-mcp-launcher"\nversion = "2.7.9"\n')
      : before.replaceAll('"0.1.20"', '"0.1.21"');
    assert.ok((await blob(io, product[n].sha)).equals(Buffer.from(expected)), 'Non-version root change'); }
  const ci = e.proofs.sourceCi; await commit(io, ci.sourceCommit, ci.sourceTree);
  assert.deepEqual(changes(product, await tree(io, ci.sourceTree)), ['.github/workflows/windows-native-mcp-021.yml']);
  return product;
}
async function verifyAssociation(q, io, e, r, product) {
  const c = await commit(io, r.associationCommit); assert.deepEqual(c.parents.map(x => x.sha), [PRODUCT.sourceCommit]);
  const associated = await tree(io, c.tree.sha), delta = changes(product, associated); assert.ok(delta.length > 0 && delta.length <= 64);
  for (const n of delta) { assert.ok(ASSOCIATION_FILES.includes(n), 'Forbidden association change: ' + n); assert.equal(associated[n]?.mode, '100644'); }
  for (const [name, expected] of [['packaging/windows/0.1.21-qualification.json', r.digest], ['scripts/windows-021-evidence.json', EVIDENCE_SHA256]])
    assert.equal(hash(await blob(io, associated[name]?.sha)), expected);
  assert.equal((await blob(io, associated['packaging/windows/0.1.21-qualification.json.sha256']?.sha)).toString('utf8').trim(), r.digest);
  assert.ok((await blob(io, associated['scripts/windows-021-release-qualification.cjs']?.sha)).equals(fs.readFileSync(__filename)));
}
async function verifyProofs(io, e) {
  for (const [name, p] of Object.entries(e.proofs)) {
    await commit(io, p.sourceCommit, p.sourceTree); const workflow = e.workflowDocuments[name === 'sourceCi' ? 'sourceCi' : 'native'];
    const t = await tree(io, p.sourceTree); assert.equal(t[p.workflow]?.sha, workflow.blob); capture(await blob(io, workflow.blob), workflow);
    const run = await io.request('actions/runs/' + p.runId), job = await io.request('actions/jobs/' + p.jobId), a = await io.request('actions/artifacts/' + p.artifact.id);
    for (const [k, v] of Object.entries({ id: p.runId, run_attempt: p.runAttempt, event: p.event, head_branch: p.branch, head_sha: p.sourceCommit, path: p.workflow, status: 'completed', conclusion: 'success' })) assert.equal(run[k], v, 'Run ' + k);
    for (const repo of [run.repository, run.head_repository]) { assert.equal(repo.id, REPO_ID); assert.equal(repo.full_name, REPO); }
    for (const [k, v] of Object.entries({ id: p.jobId, run_id: p.runId, run_attempt: p.runAttempt, head_sha: p.sourceCommit, name: p.jobName, status: 'completed', conclusion: 'success' })) assert.equal(job[k], v, 'Job ' + k);
    assert.ok(job.labels.includes('windows-latest'));
    for (const [k, v] of Object.entries({ id: p.artifact.id, name: p.artifact.name, size_in_bytes: p.artifact.size, digest: 'sha256:' + p.artifact.sha256, expired: false })) assert.equal(a[k], v, 'Artifact ' + k);
    for (const [k, v] of Object.entries({ id: p.runId, head_sha: p.sourceCommit, repository_id: REPO_ID, head_repository_id: REPO_ID })) assert.equal(a.workflow_run[k], v);
    const times = [job.started_at, a.created_at, job.completed_at].map(Date.parse); assert.ok(times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2]);
    const zip = capture(await io.download('actions/artifacts/' + a.id + '/zip', a.size_in_bytes + 1), p.artifact);
    for (const [key, member] of Object.entries(p.members)) capture(prior.readZipMember(zip, member), e.documents[key]);
  }
}
async function stable(io) { const r = await io.request('releases/latest'); assert.equal(r.id, PREVIOUS.id); assert.equal(r.tag_name, PREVIOUS.tag);
  assert.equal(r.target_commitish, PREVIOUS.association); assert.equal(r.draft, false); assert.equal(r.prerelease, false); }
function releaseMetadata(r, q, association, isDraft) { assert.equal(r.id, q.draft.id); assert.equal(r.tag_name, 'v' + VERSION); assert.equal(r.target_commitish, association);
  assert.equal(r.draft, isDraft); assert.equal(r.prerelease, false); assert.equal(r.assets.length, ASSETS.length); exact(Object.fromEntries(r.assets.map(a => [a.name, a])), ASSETS);
  for (const a of r.assets) { const p = q.draft.assets[a.name]; assert.equal(a.id, p.id); assert.equal(a.size, p.size); assert.equal(a.digest, 'sha256:' + p.sha256); assert.equal(a.state, 'uploaded'); } }
async function verifyReleaseState(q, io, isDraft) {
  verifyLocal(q); io ||= createGhReader(); const r = reviewed.get(q), e = evidence(); await stable(io);
  const product = await verifySource(io, e); await verifyAssociation(q, io, e, r, product); await verifyProofs(io, e);
  releaseMetadata(await io.request('releases/' + q.draft.id), q, r.associationCommit, isDraft);
  const bodies = {}; for (const n of ASSETS) bodies[n] = await io.download('releases/assets/' + q.draft.assets[n].id, q.draft.assets[n].size + 1); checkPayload(q, bodies, r.pubRoot);
  if (!isDraft) { const ref = await io.request('git/ref/tags/v' + VERSION); assert.equal(ref.ref, 'refs/tags/v' + VERSION); let target = ref.object;
    if (target.type === 'tag') { const tag = await io.request('git/tags/' + target.sha); assert.equal(tag.sha, target.sha); target = tag.object; }
    assert.equal(target.type, 'commit'); assert.equal(target.sha, r.associationCommit); }
  releaseMetadata(await io.request('releases/' + q.draft.id), q, r.associationCommit, isDraft); await stable(io);
  return { version: VERSION, platform: PLATFORM, qualificationSha256: r.digest, draftId: q.draft.id, productionApproval: true,
    sourceCiVerified: true, nativeEvidenceVerified: true, signaturesVerified: true, publicAcceptance: false, releaseReady: false,
    releaseAssociationVerified: true, associationBuilt: false, releaseAssociationCommit: r.associationCommit, ...(isDraft ? {} : { releaseIsPublic: true }) };
}
const verifyRemote = (q, io) => verifyReleaseState(q, io, true);
const verifyPublishedRemote = (q, io) => verifyReleaseState(q, io, false);
module.exports = { REPO, REPO_ID, VERSION, PLATFORM, PRODUCT, PREVIOUS, ASSETS, PUBLIC_NOTES, EVIDENCE_SHA256, PRODUCTION_KEY_SHA256,
  ASSOCIATION_FILES, loadQualification, validateQualification, validateEvidence, verifyLocal, verifyRemote, verifyPublishedRemote,
  checkPayload, ghApiArgs, createGhReader, hash, document, generation, verifySource, verifyAssociation, verifyProofs };
if (require.main === module) (async () => { const [mode, file, sha, association, pubRoot, ...rest] = process.argv.slice(2);
  assert.ok(['--local', '--draft', '--published'].includes(mode) && !rest.length); const q = loadQualification(file, sha, association, { pubRoot });
  console.log(JSON.stringify(mode === '--local' ? verifyLocal(q) : await (mode === '--draft' ? verifyRemote : verifyPublishedRemote)(q)));
})().catch(error => { console.error('021 qualification refused: ' + error.message); process.exitCode = 1; });
