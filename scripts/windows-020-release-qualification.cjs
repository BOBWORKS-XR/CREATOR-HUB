'use strict';
// One frozen Windows release. No target mutation, signing, installation or publication.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const REPO = 'BOBWORKS-XR/CREATOR-HUB', REPO_ID = 1364807512;
const VERSION = '0.1.20', PLATFORM = 'windows-x86_64';
const PRODUCTION_KEY_SHA256 = '3c41b4294f116113dda208beea540a349dbcd8d7297933fefdc147b08cf56488';
const EVIDENCE_SHA256 = '945ae76fcf8efa68bb0bcca37d77a366d0121346bc7e65615838393f64212f02';
const PRODUCT = Object.freeze({ sourceCommit: '9b65dd7aedc2eb224755db3d733a7fb19e8e8f62',
  sourceTree: '3048c4b2c8e5004024191dbb29f5651e5d6bb7e8',
  installerSha256: '2915ffac9b1c39f5facbd4030eb6addf837e0d414b96835e0f0be1564577666b',
  executableSha256: '06908120c81f471e9774edbe5a2d09fa3c985357eea373e29e75404d1f133cf5' });
const PREVIOUS = Object.freeze({ id: 433720791, tag: 'v0.1.19',
  association: 'a23ab742d649e1c8572f3072c767b92479073b49',
  source: 'ed3e7dabc2e83fea8b7cadce63bbeb502fed2306', tree: 'bd6328c41871465fe64e65e3f9d53c6f2ba0ed8d',
  installer: '1a0d85127827b854dcdd3ae89f4c5e2aca3824b81623f1b9b05e022871ee6419',
  executable: '5bd277950ac6409b6820005e28767bbd3dd1281ea84e5f87f9b1990ffcda5d12' });
const ASSETS = Object.freeze(['Creator.Hub_0.1.20_x64-setup.exe', 'Creator.Hub_0.1.20_x64-setup.exe.sig',
  'creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig', 'latest.json', 'SHA256SUMS.txt']);
const PUBLIC_NOTES = 'MCP safety fixes, refreshed Creator SDK node catalogue and docs, and advisory graph-performance checks.';
const ASSOCIATION_FILES = Object.freeze(['.github/workflows/release.yml', 'README.md',
  'scripts/check-unified-sources.cjs', 'scripts/check-unified-sources.test.cjs',
  'scripts/publish-hub-draft.cjs', 'scripts/publish-hub-draft.test.cjs', 'scripts/release-workflow.test.cjs',
  'scripts/self-update-baselines.cjs', 'scripts/self-update-baselines.test.cjs', 'scripts/windows-020-publisher.test.cjs',
  'scripts/windows-020-release-qualification.cjs', 'scripts/windows-020-release-qualification.test.cjs',
  'scripts/windows-020-evidence.json', 'scripts/windows-020-public-acceptance.cjs', 'scripts/windows-020-public-acceptance.test.cjs',
  'scripts/windows-020-public-contract.cjs', 'scripts/public-update-evidence-io.cjs',
  'scripts/fixtures/windows-020-remote.json', 'scripts/fixtures/windows-020-qualification.json',
  'docs/RELEASE-0.1.20.md', 'docs/WINDOWS-020-QUALIFICATION.md',
  'packaging/windows/0.1.20-qualification.json', 'packaging/windows/0.1.20-qualification.json.sha256',
  'packaging/windows/0.1.20-qualification-DRAFT.md', 'packaging/windows/0.1.20-release-notes-DRAFT.md']);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const gitHash = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
function exact(value, names) { assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), 'Unexpected qualification fields'); }
function digest(value, length = 64) { assert.match(value || '', new RegExp(`^[a-f0-9]{${length}}$`)); }
function positive(value, max = 256 * 1024 * 1024) { assert.ok(Number.isSafeInteger(value) && value > 0 && value <= max); }
function freeze(value) { if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); } return value; }
function parse(bytes) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
function bounded(file, max) { const st = fs.lstatSync(file); assert.ok(st.isFile() && !st.isSymbolicLink());
  positive(st.size, max); const b = fs.readFileSync(file); assert.equal(b.length, st.size); return b; }
function capture(bytes, pin) { assert.ok(Buffer.isBuffer(bytes)); assert.equal(bytes.length, pin.size, 'Evidence size differs');
  assert.equal(hash(bytes), pin.sha256, 'Evidence digest differs'); return bytes; }
function encoded(value) { const b = Buffer.from(value, 'base64'); assert.equal(b.toString('base64'), value, 'Noncanonical base64'); return b; }
function evidence() {
  const bytes = bounded(path.join(__dirname, 'windows-020-evidence.json'), 2 * 1024 * 1024);
  assert.equal(hash(bytes), EVIDENCE_SHA256, 'Pinned 020 evidence bundle changed');
  return parse(bytes);
}
function document(e, name, json = true) {
  const p = e.documents[name]; assert.ok(p, `Missing proof: ${name}`);
  exact(p, ['path', 'size', 'sha256', 'base64']); positive(p.size, 1024 * 1024); digest(p.sha256);
  const b = capture(encoded(p.base64), p); return json ? parse(b) : b;
}
function requireTrue(value, fields) { for (const key of fields) assert.equal(value[key], true, `Required proof failed: ${key}`); }
function requireFalse(value, fields) { for (const key of fields) assert.equal(value[key], false, `Forbidden acceptance claim: ${key}`); }
function validateEvidence(e) {
  assert.equal(e.schemaVersion, 1);
  for (const name of Object.keys(e.documents)) document(e, name, false);
  const source = document(e, 'source'), build = document(e, 'build'), signed = document(e, 'signing');
  assert.equal(source.commit, PRODUCT.sourceCommit); assert.equal(source.tree, PRODUCT.sourceTree);
  assert.equal(source.base, PREVIOUS.source); requireTrue(source, ['publishedRootAndSetupPreserved']);
  assert.equal(source.sourceInventorySha256, e.documents.inventory.sha256); assert.equal(source.sourceFileCount, 1505);
  const inventory = document(e, 'inventory'); assert.equal(inventory.length, 1505);
  assert.equal(new Set(inventory.map(row => row.path)).size, inventory.length);
  assert.equal(build.sourceCommit, PRODUCT.sourceCommit); assert.equal(build.sourceTree, PRODUCT.sourceTree);
  assert.equal(build.status, 0); assert.equal(build.error, null); assert.deepEqual(build.changed, []);
  requireTrue(build, ['sourceUnchanged']); assert.equal(build.installerSha256, PRODUCT.installerSha256);
  assert.equal(build.executableSha256, PRODUCT.executableSha256);
  assert.deepEqual(signed.source, { commit: PRODUCT.sourceCommit, tree: PRODUCT.sourceTree });
  assert.equal(signed.buildExitCode, 0); assert.equal(signed.buildResultSha256, e.documents.build.sha256);
  assert.equal(signed.inputSha256, e.documents.inventory.sha256); assert.equal(signed.inputCount, 1505);
  assert.equal(signed.installer.sha256, PRODUCT.installerSha256); assert.equal(signed.installer.bytes, 38461485);
  assert.equal(signed.executable.sha256, PRODUCT.executableSha256);
  requireTrue(signed, ['sourceUnchanged', 'outerSigned']);
  requireFalse(signed, ['productionApproval', 'published', 'releaseReady', 'publicDiscovery']);
  requireTrue(signed.verification, ['internalSignaturesVerified', 'descriptorSignatureVerified', 'installerSignatureVerified', 'extractedPayloadsMatch']);
  for (const value of Object.values(signed.verification.negativeProofs)) assert.equal(value, true);
  const ci = document(e, 'sourceCi'); assert.equal(ci.runId, 42024389253);
  assert.equal(ci.source, PRODUCT.sourceCommit); assert.equal(ci.harness, e.proofs.sourceCi.sourceCommit);
  for (const [k, v] of Object.entries({ tests: 438, passed: 438, failed: 0, skipped: 0, bundlePassed: 9 })) assert.equal(ci[k], v);
  assert.equal(ci.sourceLogSha256, e.documents.sourceLog.sha256); assert.equal(ci.bundleLogSha256, e.documents.bundleLog.sha256);
  for (const [name, count] of [['sourceLog', 438], ['bundleLog', 9]]) {
    const text = document(e, name, false).toString('utf8');
    for (const [label, n] of [['tests', count], ['pass', count], ['fail', 0], ['cancelled', 0], ['skipped', 0], ['todo', 0]])
      assert.match(text, new RegExp(`(?:^|\\n)[^\\n]*?\\b${label} ${n}\\r?(?:\\n|$)`));
  }
  const native = document(e, 'native'); assert.equal(native.runId, 42025914021);
  assert.equal(native.source, PRODUCT.sourceCommit); requireTrue(native, ['nativeUpdateAccepted']);
  requireFalse(native, ['publicDiscovery', 'published', 'releaseReady', 'localAppChanged', 'liveAiAccountAcceptance']);
  assert.deepEqual(native.cases.map(c => c.case).sort(), ['mcp-restore', 'setup-no-restore', 'setup-restore']);
  for (const c of native.cases) {
    const p = e.proofs[c.case], r = document(e, `${c.case}/report`), binding = document(e, `${c.case}/binding`);
    assert.equal(c.reportSha256, e.documents[`${c.case}/report`].sha256);
    assert.equal(c.lifecycleSha256, e.documents[`${c.case}/lifecycle`].sha256);
    requireTrue(c, ['passed', 'settingsPreserved', 'automaticRestart', 'existingConnectionSurvived', 'newConnectionVerified', 'cleanupVerified']);
    requireTrue(r, ['passed', 'nativeUpdateAccepted', 'cancelPreserved', 'automaticRestart', 'existingConnectionSurvived',
      'newConnectionVerified', 'restorationVerified', 'settingsPreserved', 'policyRestored', 'changedMcpGenerationProven',
      'installedResourcesVerifiedBeforeAndAfter', 'heldGenerationRetained', 'migrationDeferralPreserved']);
    requireFalse(r, ['publicDiscovery', 'liveAiAcceptance', 'releaseReady']);
    assert.equal(r.sourceCommit, PRODUCT.sourceCommit); assert.equal(r.kind, 'direct-outgoing-019-020');
    assert.deepEqual(r.baseline, { version: '0.1.19', installer: PREVIOUS.installer, exe: PREVIOUS.executable });
    assert.equal(r.pins.installer, PRODUCT.installerSha256); assert.equal(r.pins.executable, PRODUCT.executableSha256);
    assert.equal(r.pins.manifest, e.documents.privateManifest.sha256);
    assert.equal(r.pins.descriptor, signed.assets[ASSETS[2]].sha256); assert.equal(r.pins.descriptorSignature, signed.assets[ASSETS[3]].sha256);
    assert.equal(r.heldServerVersion.version, '2.7.7'); assert.equal(r.reconnectedServerVersion.version, '2.7.8');
    assert.equal(r.lastTool, c.case.startsWith('mcp') ? 'mcp' : 'setup'); assert.equal(r.restore, c.case !== 'setup-no-restore');
    assert.deepEqual(r.beforePeVersion, [0, 1, 19, 0]); assert.deepEqual(r.afterPeVersion, [0, 1, 20, 0]);
    assert.equal(binding.passed, true); assert.equal(binding.case, c.case); assert.equal(binding.harnessSource, p.sourceCommit);
    assert.equal(binding.verificationReceiptSha256, e.documents.signing.sha256);
    assert.equal(binding.reportSha256, c.reportSha256); assert.equal(binding.lifecycleSha256, c.lifecycleSha256);
    assert.deepEqual(binding.targetSource, signed.source); assert.deepEqual(binding.baselineSource, { commit: PREVIOUS.source, tree: PREVIOUS.tree });
    const rows = document(e, `${c.case}/lifecycle`, false).toString('utf8').trim().split(/\r?\n/).map(JSON.parse);
    const results = rows.filter(row => row.kind === 'lab-lifecycle-result'); assert.equal(results.length, 1);
    requireTrue(results[0], ['lifecycleSucceeded', 'cleanupVerified', 'systemTlsVerified', 'labDiscovery']);
    assert.equal(results[0].driverExitCode, 0); assert.equal(results[0].failureDetails, null);
    assert.equal(results[0].processIdentityFailure, null); requireFalse(results[0], ['publicDiscovery', 'releaseReady']);
  }
  const clients = document(e, 'clients'), codex = document(e, 'codex'), desktop = document(e, 'desktop'), claude = document(e, 'claude');
  const server = signed.manifest.modules.mcp.files['mcp/server/creator-works-mcp.mjs'];
  for (const r of [clients, codex, desktop, claude]) assert.equal(r.source, PRODUCT.sourceCommit);
  for (const r of [codex, desktop, claude]) assert.equal(r.serverSha256, server);
  requireTrue(codex, ['passed', 'settingsUnchanged', 'successfulReference']); assert.equal(codex.exitCode, 0); assert.equal(codex.unexpectedToolEvents, 0);
  requireTrue(desktop, ['passed', 'settingsRestored', 'normalExit', 'candidateProcessExited', 'disposableAssetsStillEmpty']);
  for (const r of [codex, desktop]) { assert.deepEqual(r.checks.map(c => c.name).sort(), ['get_bridge_status', 'get_mcp_reference']);
    for (const c of r.checks) assert.equal(c.successful, r === codex ? 1 : true); }
  requireTrue(clients, ['desktopConfigRestoredByteForByte', 'disposableAssetsStillEmpty', 'releaseAuthorized']);
  requireFalse(clients, ['forestTouched', 'candidateRebuilt', 'published']);
  assert.equal(clients.codex.readToolCallsPassed, true); assert.equal(clients.claudeDesktop.readToolCallsPassed, true);
  assert.equal(clients.claudeCode.readToolCallsPassed, false); assert.equal(clients.claudeCode.releaseDisposition, 'explicitly deferred by user; not passed');
  requireTrue(claude, ['connected', 'settingsUnchanged']); requireFalse(claude, ['passed', 'successfulReference']);
  assert.equal(claude.exitCode, 1); assert.match(claude.externalFailure, /weekly limit/);
  for (const c of claude.checks) { assert.equal(c.calls, 0); assert.equal(c.successful, 0); }
  const restoration = document(e, 'restoration'); assert.equal(restoration.restored, true);
  assert.equal(restoration.beforeSha256, restoration.restoredSha256); assert.equal(desktop.restoredConfigSha256, restoration.restoredSha256);
  const authorization = document(e, 'authorization', false).toString('utf8');
  assert.ok(authorization.includes('defer the Claude Code test')); assert.ok(authorization.includes('only make it latest once it passes'));
  assert.equal(e.inherited.association, PREVIOUS.association); assert.equal(e.inherited.source, PREVIOUS.source);
  return { source, inventory, signed };
}
function validateQualification(q) {
  exact(q, ['schemaVersion', 'kind', 'version', 'platform', 'candidate', 'evidenceSha256', 'authorization', 'publicAcceptance', 'releaseReady', 'publicNotes', 'draft']);
  assert.equal(q.schemaVersion, 1); assert.equal(q.kind, 'windows-020-staged-qualification');
  assert.equal(q.version, VERSION); assert.equal(q.platform, PLATFORM); assert.deepEqual(q.candidate, PRODUCT);
  assert.equal(q.evidenceSha256, EVIDENCE_SHA256); assert.equal(q.authorization, 'staged-public-019-to-020-before-latest;claude-code-deferred');
  requireFalse(q, ['publicAcceptance', 'releaseReady']); assert.equal(q.publicNotes, PUBLIC_NOTES);
  exact(q.draft, ['id', 'assets']); positive(q.draft.id, Number.MAX_SAFE_INTEGER); assert.notEqual(q.draft.id, PREVIOUS.id);
  exact(q.draft.assets, ASSETS); const ids = new Set();
  for (const [name, pin] of Object.entries(q.draft.assets)) { exact(pin, ['id', 'size', 'sha256']);
    positive(pin.id, Number.MAX_SAFE_INTEGER); positive(pin.size, name.endsWith('.exe') ? 256 * 1024 * 1024 : 32768); digest(pin.sha256);
    assert.ok(!ids.has(pin.id), 'Duplicate asset ID'); ids.add(pin.id); }
  assert.equal(q.draft.assets[ASSETS[0]].sha256, PRODUCT.installerSha256); assert.equal(q.draft.assets[ASSETS[0]].size, 38461485);
  const signed = document(evidence(), 'signing');
  for (const name of [ASSETS[2], ASSETS[3]]) { assert.equal(q.draft.assets[name].sha256, signed.assets[name].sha256);
    assert.equal(q.draft.assets[name].size, signed.assets[name].bytes); }
  return q;
}
const reviewed = new WeakMap();
function loadQualification(file, expectedSha256, associationCommit, options = {}) {
  digest(expectedSha256); digest(associationCommit, 40); assert.notEqual(associationCommit, PRODUCT.sourceCommit);
  const bytes = bounded(file, 32768); assert.equal(hash(bytes), expectedSha256, 'Receipt differs from independent review');
  const q = parse(bytes), text = bytes.toString('utf8').trim();
  assert.ok(text === JSON.stringify(q) || text === JSON.stringify(q, null, 2), 'Canonical receipt required; duplicate fields refused');
  validateQualification(q); freeze(q);
  reviewed.set(q, { digest: expectedSha256, associationCommit, pubRoot: path.resolve(options.pubRoot || path.join(__dirname, '..')) });
  verifyLocal(q); return q;
}
function publicKey(pubRoot) {
  const config = parse(bounded(path.join(pubRoot, 'src-tauri/tauri.conf.json'), 32768));
  const key = encoded(config.plugins.updater.pubkey);
  assert.equal(hash(Buffer.from(key.toString('utf8').replace(/\r?\n/g, '\r\n'))), PRODUCTION_KEY_SHA256, 'Wrong production public key');
  const lines = key.toString('utf8').trimEnd().split(/\r?\n/); assert.equal(lines.length, 2);
  const packet = encoded(lines[1]); assert.equal(packet.length, 42); assert.equal(packet.subarray(0, 2).toString(), 'Ed');
  return packet;
}
function verifySignature(body, signature, key) {
  assert.ok(Buffer.isBuffer(body) && body.length > 0 && body.length <= 256 * 1024 * 1024);
  assert.ok(Buffer.isBuffer(signature) && signature.length <= 4096);
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(signature).trimEnd().split(/\r?\n/);
  assert.equal(lines.length, 4); assert.ok(lines[0].startsWith('untrusted comment: ')); assert.ok(lines[2].startsWith('trusted comment: '));
  const packet = encoded(lines[1]), global = encoded(lines[3]); assert.equal(packet.length, 74); assert.equal(global.length, 64);
  assert.equal(packet.subarray(0, 2).toString(), 'ED', 'Unexpected Minisign algorithm');
  assert.ok(packet.subarray(2, 10).equals(key.subarray(2, 10)), 'Wrong signature key ID');
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  assert.ok(crypto.verify(null, crypto.createHash('blake2b512').update(body).digest(), pub, packet.subarray(10)), 'Production signature failed');
  assert.ok(crypto.verify(null, Buffer.concat([packet.subarray(10), Buffer.from(lines[2].slice(17))]), pub, global), 'Trusted comment signature failed');
}
function verifyLocal(q) {
  const review = reviewed.get(q); assert.ok(review, 'Load the independently digest-pinned 020 receipt first'); validateQualification(q);
  const e = evidence(); validateEvidence(e); publicKey(review.pubRoot);
  return { version: VERSION, platform: PLATFORM, qualificationSha256: review.digest, draftId: q.draft.id,
    localEvidenceVerified: true, publicAcceptance: false, releaseReady: false,
    sourceCiScope: '438 source tests plus 9 bundled-runtime tests; no native/public acceptance',
    nativeScope: 'three exact private 019-to-020 cases; historical migration coverage inherited from 019',
    actualClientScope: 'Codex and Desktop read-only calls; Claude Code explicitly deferred, not passed' };
}
function checkPayload(q, bodies, pubRoot) {
  exact(bodies, ASSETS); for (const name of ASSETS) capture(bodies[name], q.draft.assets[name]);
  const key = publicKey(pubRoot), descriptor = parse(bodies[ASSETS[2]]);
  assert.deepEqual(descriptor, { schemaVersion: 1, appId: 'creator-hub', version: VERSION, platform: 'windows', architecture: 'x86_64',
    packageType: 'nsis', assetName: ASSETS[0], byteLength: 38461485, sha256: PRODUCT.installerSha256,
    executableSha256: PRODUCT.executableSha256, identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1, minHubVersion: '0.1.19' });
  verifySignature(bodies[ASSETS[2]], bodies[ASSETS[3]], key);
  const original = document(evidence(), 'privateManifest'), latest = parse(bodies['latest.json']);
  assert.equal(original.notes, 'Private candidate acceptance only; not published.');
  assert.deepEqual(latest, { ...original, notes: q.publicNotes }, 'Only the approved notes-only manifest projection is permitted');
  const signature = encoded(latest.platforms[PLATFORM].signature);
  const standalone = bodies[ASSETS[1]], base64 = latest.platforms[PLATFORM].signature;
  assert.ok(standalone.equals(signature) || [base64, `${base64}\n`, `${base64}\r\n`].includes(standalone.toString('utf8')),
    'Standalone signature must encode exactly the accepted signature');
  verifySignature(bodies[ASSETS[0]], signature, key);
  assert.equal(bodies['SHA256SUMS.txt'].toString('utf8'), ASSETS.filter(n => n !== 'SHA256SUMS.txt').sort()
    .map(n => `${q.draft.assets[n].sha256}  ${n}\n`).join(''), 'Checksums must cover exactly five final assets');
  return true;
}
// Bounded ZIP parsing, no extraction, no code execution. SHA-256 authenticates the archive and each used member.
function readZipMember(zip, wanted, limit = 1024 * 1024) {
  assert.ok(Buffer.isBuffer(zip) && zip.length <= 64 * 1024 * 1024); assert.match(wanted, /^[A-Za-z0-9_.\/-]+$/);
  assert.ok(wanted.split('/').every(p => p && p !== '.' && p !== '..'));
  const end = zip.lastIndexOf(Buffer.from('504b0506', 'hex')); assert.ok(end >= 0 && end + 22 <= zip.length);
  assert.equal(end + 22 + zip.readUInt16LE(end + 20), zip.length); assert.equal(zip.readUInt32LE(end + 4), 0);
  const count = zip.readUInt16LE(end + 10), start = zip.readUInt32LE(end + 16);
  positive(count, 1000); assert.equal(count, zip.readUInt16LE(end + 8)); assert.equal(start + zip.readUInt32LE(end + 12), end);
  let offset = start, found; const names = new Set();
  for (let i = 0; i < count; i++) {
    assert.ok(offset + 46 <= end && zip.readUInt32LE(offset) === 0x02014b50);
    const flags = zip.readUInt16LE(offset + 8), method = zip.readUInt16LE(offset + 10), compressed = zip.readUInt32LE(offset + 20), size = zip.readUInt32LE(offset + 24);
    const n = zip.readUInt16LE(offset + 28), extra = zip.readUInt16LE(offset + 30), comment = zip.readUInt16LE(offset + 32), local = zip.readUInt32LE(offset + 42);
    const next = offset + 46 + n + extra + comment; assert.ok(next <= end);
    const name = zip.subarray(offset + 46, offset + 46 + n).toString('utf8');
    assert.ok(name && !name.startsWith('/') && !/[\\:\x00-\x1f\x7f]/.test(name));
    assert.ok(name.replace(/\/$/, '').split('/').every(p => p && p !== '.' && p !== '..'));
    assert.ok(!names.has(name.toLowerCase()), 'Duplicate ZIP member'); names.add(name.toLowerCase());
    if (name === wanted) {
      assert.ok(!found && !(flags & 1) && (method === 0 || method === 8)); positive(size, limit); positive(compressed, limit);
      assert.ok(local + 30 <= start && zip.readUInt32LE(local) === 0x04034b50);
      assert.equal(zip.readUInt16LE(local + 6), flags); assert.equal(zip.readUInt16LE(local + 8), method);
      const nl = zip.readUInt16LE(local + 26), el = zip.readUInt16LE(local + 28), data = local + 30 + nl + el;
      assert.equal(zip.subarray(local + 30, local + 30 + nl).toString('utf8'), name); assert.ok(data + compressed <= start);
      found = method === 0 ? Buffer.from(zip.subarray(data, data + compressed)) : zlib.inflateRawSync(zip.subarray(data, data + compressed), { maxOutputLength: limit });
      assert.equal(found.length, size);
    }
    offset = next;
  }
  assert.equal(offset, end); assert.ok(found, `Missing ZIP proof: ${wanted}`); return found;
}
function ghApiArgs(route, binary = false) {
  assert.match(route, /^(?:git\/commits\/[a-f0-9]{40}|git\/trees\/[a-f0-9]{40}\?recursive=1|git\/(?:blobs|tags)\/[a-f0-9]{40}|git\/ref\/tags\/v0\.1\.20|actions\/(?:runs|jobs|artifacts)\/[1-9][0-9]*(?:\/zip)?|releases\/(?:latest|[1-9][0-9]*|assets\/[1-9][0-9]*))$/);
  if (binary) assert.match(route, /^(?:actions\/artifacts\/[1-9][0-9]*\/zip|releases\/assets\/[1-9][0-9]*)$/);
  return ['api', '--method', 'GET', ...(binary && route.startsWith('releases/assets/') ? ['-H', 'Accept:application/octet-stream'] : []), `repos/${REPO}/${route}`];
}
function createGhReader(execute = execFileSync) {
  return { request: async route => parse(execute('gh', ghApiArgs(route), { windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024, stdio: 'pipe' })),
    download: async (route, max) => { positive(max); const bytes = execute('gh', ghApiArgs(route, true), { windowsHide: true, timeout: 180000, maxBuffer: max, stdio: 'pipe' });
      assert.ok(Buffer.isBuffer(bytes) && bytes.length <= max); return bytes; } };
}
async function commit(io, sha, tree) { const c = await io.request(`git/commits/${sha}`); assert.equal(c.sha, sha); assert.equal(c.tree.sha, tree); return c; }
async function tree(io, sha) {
  const t = await io.request(`git/trees/${sha}?recursive=1`); assert.equal(t.sha, sha); assert.equal(t.truncated, false);
  assert.ok(t.tree.length > 0 && t.tree.length < 10000); const map = {};
  for (const row of t.tree) { assert.ok(row.path && !Object.hasOwn(map, row.path)); digest(row.sha, 40);
    assert.ok(!row.path.startsWith('/') && !/[\\:\x00-\x1f]/.test(row.path) && row.path.split('/').every(p => p && p !== '.' && p !== '..'));
    if (row.type === 'tree') continue;
    assert.equal(row.type, 'blob'); assert.ok(['100644', '100755'].includes(row.mode)); map[row.path] = { sha: row.sha, mode: row.mode }; }
  return map;
}
async function blob(io, sha, max = 2 * 1024 * 1024) {
  const b = await io.request(`git/blobs/${sha}`); assert.equal(b.sha, sha); assert.equal(b.encoding, 'base64'); positive(b.size, max);
  const bytes = Buffer.from(b.content.replace(/\s/g, ''), 'base64'); assert.equal(bytes.length, b.size); assert.equal(gitHash(bytes), sha); return bytes;
}
function changes(a, b) { return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(n => a[n]?.sha !== b[n]?.sha || a[n]?.mode !== b[n]?.mode); }
async function verifyAssociation(q, io, e, review, productTree) {
  const c = await io.request(`git/commits/${review.associationCommit}`); assert.equal(c.sha, review.associationCommit); digest(c.tree?.sha, 40);
  assert.deepEqual(c.parents.map(p => p.sha), [PRODUCT.sourceCommit], 'Association must be a direct single-parent child of the frozen product');
  const associated = await tree(io, c.tree.sha), modified = changes(productTree, associated);
  assert.ok(modified.length > 0 && modified.length <= 64);
  for (const n of modified) {
    assert.ok(associated[n] && associated[n].mode === '100644', 'Association deletion or executable metadata forbidden');
    assert.ok(ASSOCIATION_FILES.includes(n) || Object.hasOwn(e.inherited.files, n), `Forbidden product/guard change: ${n}`);
    if (!ASSOCIATION_FILES.includes(n)) assert.equal(associated[n].sha, e.inherited.files[n], `Inherited 019 file changed: ${n}`);
  }
  for (const [n, sha] of Object.entries(e.inherited.files)) { assert.ok(associated[n], `Missing inherited metadata: ${n}`);
    if (!ASSOCIATION_FILES.includes(n)) assert.equal(associated[n].sha, sha, `Inherited metadata must match published 019: ${n}`); }
  const receipt = 'packaging/windows/0.1.20-qualification.json';
  for (const n of [receipt, `${receipt}.sha256`, 'scripts/windows-020-release-qualification.cjs', 'scripts/windows-020-evidence.json']) assert.ok(associated[n], `Missing association file: ${n}`);
  assert.equal(hash(await blob(io, associated[receipt].sha, 32768)), review.digest, 'Associated receipt differs from independent review');
  assert.equal((await blob(io, associated[`${receipt}.sha256`].sha, 128)).toString('utf8').trim(), review.digest);
  assert.equal(hash(await blob(io, associated['scripts/windows-020-evidence.json'].sha)), EVIDENCE_SHA256);
  assert.ok((await blob(io, associated['scripts/windows-020-release-qualification.cjs'].sha)).equals(fs.readFileSync(__filename)), 'Associated qualifier differs from the executing reader');
  return associated;
}
async function verifySource(io, e) {
  await commit(io, PRODUCT.sourceCommit, PRODUCT.sourceTree); await commit(io, PREVIOUS.source, PREVIOUS.tree);
  const product = await tree(io, PRODUCT.sourceTree), previous = await tree(io, PREVIOUS.tree);
  const inventory = document(e, 'inventory'); assert.equal(Object.keys(product).length, inventory.length);
  for (const row of inventory) assert.deepEqual(product[row.path], { sha: row.blob, mode: row.mode }, `Frozen source inventory differs: ${row.path}`);
  const rootVersions = ['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json'];
  for (const n of changes(previous, product)) {
    if (n.startsWith('modules/mcp/')) continue;
    assert.ok(rootVersions.includes(n), `Root/Setup inheritance broken: ${n}`);
    const before = await blob(io, previous[n].sha), after = await blob(io, product[n].sha);
    let expected = before.toString('utf8').replaceAll('"0.1.19"', '"0.1.20"');
    if (n === 'src-tauri/Cargo.lock') expected = expected.replace(
      '\nname = "creator-works-mcp-launcher"\nversion = "2.7.7"\n', '\nname = "creator-works-mcp-launcher"\nversion = "2.7.8"\n');
    assert.ok(after.equals(Buffer.from(expected)), `Not a version-only root change: ${n}`);
  }
  const ci = e.proofs.sourceCi; await commit(io, ci.sourceCommit, ci.sourceTree);
  const ciTree = await tree(io, ci.sourceTree);
  assert.deepEqual(changes(product, ciTree), ['.github/workflows/windows-mcp-feedback.yml'], 'Source CI is not the frozen product plus its one workflow');
  const old = await io.request(`git/commits/${PREVIOUS.association}`); assert.equal(old.sha, PREVIOUS.association);
  const oldTree = await tree(io, old.tree.sha);
  for (const [n, sha] of Object.entries(e.inherited.files)) assert.equal(oldTree[n]?.sha, sha);
  const priorReceipt = await blob(io, oldTree['packaging/windows/0.1.19-qualification.json'].sha, 4 * 1024 * 1024);
  assert.equal(hash(priorReceipt), e.inherited.receiptSha256); assert.equal(priorReceipt.length, e.inherited.receiptSize);
  assert.equal(parse(priorReceipt).candidate.sourceCommit, PREVIOUS.source);
  return product;
}
async function verifyProofs(io, e) {
  for (const p of Object.values(e.proofs)) {
    await commit(io, p.sourceCommit, p.sourceTree);
    const workflow = e.workflowDocuments[p.runId === 42024389253 ? 'sourceCi' : 'native'];
    assert.equal(workflow.path, p.workflow);
    const harness = await tree(io, p.sourceTree); assert.equal(harness[p.workflow]?.sha, workflow.blob);
    const workflowBytes = await blob(io, workflow.blob);
    capture(workflowBytes, workflow); assert.ok(workflowBytes.equals(encoded(workflow.base64)), 'CI workflow bytes differ from reviewed harness');
    const run = await io.request(`actions/runs/${p.runId}`), job = await io.request(`actions/jobs/${p.jobId}`), a = await io.request(`actions/artifacts/${p.artifact.id}`);
    for (const [k, v] of Object.entries({ id: p.runId, run_attempt: p.runAttempt, status: 'completed', conclusion: 'success', head_sha: p.sourceCommit, path: p.workflow })) assert.equal(run[k], v, `Run ${k}`);
    for (const r of [run.repository, run.head_repository]) { assert.equal(r.id, REPO_ID); assert.equal(r.full_name, REPO); }
    for (const [k, v] of Object.entries({ id: p.jobId, name: p.jobName, run_id: p.runId, run_attempt: p.runAttempt, head_sha: p.sourceCommit, status: 'completed', conclusion: 'success' })) assert.equal(job[k], v, `Job ${k}`);
    assert.ok(job.labels.includes('windows-latest'));
    for (const [k, v] of Object.entries({ id: p.artifact.id, name: p.artifact.name, size_in_bytes: p.artifact.size, digest: `sha256:${p.artifact.sha256}`, expired: false })) assert.equal(a[k], v, `Artifact ${k}`);
    for (const [k, v] of Object.entries({ id: p.runId, head_sha: p.sourceCommit, repository_id: REPO_ID, head_repository_id: REPO_ID })) assert.equal(a.workflow_run[k], v);
    const times = [job.started_at, a.created_at, job.completed_at].map(Date.parse); assert.ok(times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2]);
    const zip = capture(await io.download(`actions/artifacts/${p.artifact.id}/zip`, p.artifact.size + 1), p.artifact);
    for (const [key, member] of Object.entries(p.members)) capture(readZipMember(zip, member), e.documents[key]);
  }
}
function releaseMetadata(r, q, association, isDraft) {
  assert.equal(r.id, q.draft.id); assert.equal(r.tag_name, 'v0.1.20'); assert.equal(r.target_commitish, association);
  assert.equal(r.draft, isDraft); assert.equal(r.prerelease, false);
  assert.equal(r.assets.length, 6); exact(Object.fromEntries(r.assets.map(a => [a.name, a])), ASSETS);
  for (const a of r.assets) { const p = q.draft.assets[a.name]; assert.equal(a.id, p.id); assert.equal(a.size, p.size);
    assert.equal(a.digest, `sha256:${p.sha256}`); assert.equal(a.state, 'uploaded'); }
}
async function stable(io) {
  const latest = await io.request('releases/latest'); assert.equal(latest.id, PREVIOUS.id, 'Latest changed before verified public acceptance');
  assert.equal(latest.tag_name, PREVIOUS.tag); assert.equal(latest.draft, false); assert.equal(latest.prerelease, false);
  assert.equal(latest.target_commitish, PREVIOUS.association, 'Wrong current stable association');
}
async function verifyReleaseState(q, io, isDraft) {
  verifyLocal(q); const review = reviewed.get(q), e = evidence(); io ||= createGhReader();
  assert.ok(typeof io.request === 'function' && typeof io.download === 'function');
  await stable(io); const sourceTree = await verifySource(io, e); await verifyAssociation(q, io, e, review, sourceTree); await verifyProofs(io, e);
  releaseMetadata(await io.request(`releases/${q.draft.id}`), q, review.associationCommit, isDraft);
  const bodies = {}; for (const name of ASSETS) { const p = q.draft.assets[name]; bodies[name] = await io.download(`releases/assets/${p.id}`, p.size + 1); }
  checkPayload(q, bodies, review.pubRoot);
  if (!isDraft) {
    const ref = await io.request('git/ref/tags/v0.1.20'); assert.equal(ref.ref, 'refs/tags/v0.1.20');
    let target = ref.object; digest(target?.sha, 40);
    if (target.type === 'tag') { const tag = await io.request(`git/tags/${target.sha}`); assert.equal(tag.sha, target.sha); target = tag.object; }
    assert.equal(target?.type, 'commit'); assert.equal(target.sha, review.associationCommit, 'Published tag does not resolve to the reviewed association');
  }
  releaseMetadata(await io.request(`releases/${q.draft.id}`), q, review.associationCommit, isDraft); await stable(io); publicKey(review.pubRoot);
  return { version: VERSION, platform: PLATFORM, qualificationSha256: review.digest, draftId: q.draft.id,
    productionApproval: true, sourceCiVerified: true, nativeEvidenceVerified: true, signaturesVerified: true,
    publicAcceptance: false, releaseReady: false, releaseAssociationVerified: true, associationBuilt: false,
    releaseAssociationCommit: review.associationCommit, ...(isDraft ? {} : { releaseIsPublic: true }) };
}
async function verifyRemote(q, io) { return verifyReleaseState(q, io, true); }
async function verifyPublishedRemote(q, io) { return verifyReleaseState(q, io, false); }
module.exports = { REPO, REPO_ID, VERSION, PLATFORM, PRODUCT, PREVIOUS, ASSETS, PUBLIC_NOTES, EVIDENCE_SHA256, PRODUCTION_KEY_SHA256,
  ASSOCIATION_FILES, loadQualification, validateQualification, verifyLocal, verifyRemote, verifyPublishedRemote,
  validateEvidence, checkPayload, verifySignature, publicKey, readZipMember, ghApiArgs, createGhReader };
if (require.main === module) {
  (async () => { const [mode, file, sha, association, pubRoot, ...rest] = process.argv.slice(2);
    assert.ok(['--local', '--draft', '--published'].includes(mode) && file && sha && association && pubRoot && rest.length === 0,
      'Usage: reader --local|--draft|--published receipt.json sha256 associationCommit pubRoot');
    const q = loadQualification(file, sha, association, { pubRoot });
    console.log(JSON.stringify(mode === '--local' ? verifyLocal(q) : await (mode === '--draft' ? verifyRemote : verifyPublishedRemote)(q)));
  })().catch(error => { console.error(`020 qualification refused: ${error.message}`); process.exitCode = 1; });
}
