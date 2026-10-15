const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const q = require('./windows-release-qualification.cjs');
const { selectBaseline } = require('./self-update-baselines.cjs');
const record = bytes => ({ sha256: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length });
const embedded = (member, value, pretty = false, newline = false) => {
  const bytes = Buffer.from(JSON.stringify(value, null, pretty ? 2 : undefined) + (newline ? '\n' : ''));
  return { member, ...record(bytes), base64: bytes.toString('base64') };
};

function fixture() {
  const files = {
    'creator-hub.exe': 'cb09ca8249869315fc250bce2bb00933b93f7516054dbef3f85da94b37096e3f',
    'installer.exe': q.B05.installer,
    'installer-checksum.json': '9ee05a11973b86facc2e789f60d24325d6525a77bc8504778329bd35abbf6906',
    'builtin-manifest.json': '6be984c3358ce956154ecf6aa38532320e0be2765d54285a12183319121bb4cb',
    'modules/mcp/creator-works-mcp-launcher.exe': '1fdacc54d3e5a4d034f48ef85feecfde9059c25358e1beb706a17635a15ac08f',
    'modules/mcp/server/creator-works-mcp.mjs': '62d410eba4d81646a35ee274b5904a17287026bdc4d765426d6cf3b07d04141a',
    'modules/mcp/server/runtime/node.exe': 'c6335d08331c23d68b9f2b18adb102002d76ef150b47248e954c507e0d033664',
    'modules/mcp/server/runtime/LICENSE': '8efdacdc1cfa3460aeb7fe98e3c54337b971d5da70e6eee292b73b981acb220c',
    'modules/mcp/server/runtime/VERSION': '98182b41c9ce3357797985cf12dc3b0124490ef88bc918a905373e7688e6aec9',
    'modules/mcp/server/unity-extension/Editor/BanterMCPBridge.cs': '0fbae419bb9e1a88d6d86404708d0e84414796bbb4fdbb95874ca88a4f93d1c2',
    'modules/mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png': 'f3f68baa0d887de92e6cf7aba8beae7ff8ea5c44b13444f018413041ade19ea7',
    'modules/mcp/server/LICENSE': '7e1bc8fb937a3324de67fb2439b8e943dda3efc6b62684da2697e1bfcfe7414e',
    'modules/mcp/server/THIRD_PARTY_NOTICES.md': '4a4fb0b35a2ace85eb634cddc5acab3152d570481e0efabc5369550370eb25b7',
    'modules/setup/creator-project-setup.exe': 'bbbc1b4cf94d476df771c21500e1b0f8cebfefbe10e58d6b35d93c2d919b0ab1',
    'modules/routing/creator-hub-mcp-router.exe': 'e03924ba3db7d2331c7d0f5e33f270e220dc720d4d67340e6edd1be573b6cde4',
    'modules/routing/router.json': '4138e47641b11c3a154577bbc13ec58afcb3a9f97430679a9c51fbcde81f3a00',
    'modules/routing/router.minisig': 'ffa50842ae1555e2cbdd22b467578c68efa0fe465186226f780c6e57160b790f',
    'modules/routing/runtime.json': '1b78bb735b41df55ea90ff59e72b41c410ff04115edcd88fcdc9d63878503e04',
    'modules/routing/runtime.minisig': 'beb68529ee13e8ef9f14df27f93d1ded4d4fe8b178fac750395960e8140d9b4e',
  };
  const moduleFiles = prefix => Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith(`modules/${prefix}/`)).map(([name, sha]) => [name.slice(8), sha]));
  const manifest = { schemaVersion: 1, platform: 'windows', arch: 'x86_64', modules: {
    mcp: { executable: 'mcp/creator-works-mcp-launcher.exe', version: '2.7.7', files: moduleFiles('mcp') },
    setup: { executable: 'setup/creator-project-setup.exe', version: '0.3.7', files: moduleFiles('setup') },
  }, managedRouting: { protocol: 1, files: moduleFiles('routing') } };
  const candidate = { sourceCommit: q.B05.sourceCommit, sourceTree: q.B05.sourceTree, archive: { ...q.B05.archive },
    sourceProof: embedded('candidate-source.json', { schemaVersion: 1, sourceRevision: q.B05.sourceCommit, version: '0.1.14', files,
      acceptanceOnly: true, releaseReady: false, privateKeyIncluded: false }, true, true),
    manifest: embedded('builtin-manifest.json', manifest, true),
    installerChecksum: embedded('installer-checksum.json', { version: '0.1.14', sha256: q.B05.installer,
      installedExecutableSha256: q.B05.executable, signed: false, acceptanceOnly: true }) };
  const installer = 'Creator-Hub-0.1.14-windows-x64-setup.exe';
  const signature = Buffer.from('untrusted comment: NONCRYPTOGRAPHIC TEST SIGNATURE\nfixture\n').toString('base64');
  const bodies = {
    [`${installer}.sig`]: Buffer.from(signature + '\n'),
    'creator-hub-windows-x86_64.json': Buffer.from(JSON.stringify({ schemaVersion: 1, appId: 'creator-hub', version: '0.1.14',
      platform: 'windows', architecture: 'x86_64', packageType: 'nsis', assetName: installer, byteLength: q.B05.installerBytes,
      sha256: q.B05.installer, executableSha256: q.B05.executable, identityProtocol: 0, lifecycleProtocol: 0,
      installerProtocol: 1, minHubVersion: '0.1.0-alpha.1' })),
    'creator-hub-windows-x86_64.json.minisig': Buffer.from('untrusted comment: NONCRYPTOGRAPHIC TEST CATALOG\nfixture\n'),
    'latest.json': Buffer.from(JSON.stringify({ version: '0.1.14', platforms: { 'windows-x86_64': { signature,
      url: `https://github.com/${q.REPO}/releases/download/v0.1.14/${installer}` } } })),
  };
  const assets = { [installer]: { id: 501, sha256: q.B05.installer, byteLength: q.B05.installerBytes } };
  for (const [name, bytes] of Object.entries(bodies)) assets[name] = { id: 501 + Object.keys(assets).length, ...record(bytes) };
  bodies['SHA256SUMS.txt'] = Buffer.from(Object.keys(assets).sort().map(name => `${assets[name].sha256}  ${name}\n`).join(''));
  assets['SHA256SUMS.txt'] = { id: 506, ...record(bodies['SHA256SUMS.txt']) };
  const value = { schemaVersion: 1, kind: 'windows-014-qualified-draft', repository: q.REPO, repositoryId: q.REPO_ID,
    version: '0.1.14', platform: 'windows-x86_64', authorization: 'publish-qualified-draft-only', releaseReady: false,
    publicAcceptance: false, productionKeySha256: q.B05.productionKeySha256, candidate,
    draft: { id: 401, installerAssetName: installer, assets }, proofs: {} };
  const reports = {
    fresh: { scope: 'component-built-in-smoke-not-guide-acceptance', candidateSourceRevision: q.B05.sourceCommit, hubSha256: q.B05.executable },
    guide: { scope: 'actual-first-launch-convergence-not-signed-update', candidateSourceRevision: q.B05.sourceCommit, installedHubSha256: q.B05.executable },
    guardedInstall: { scope: 'actual-public12-to-B05-guarded-nsis-hub-only-contract', candidateSourceRevision: q.B05.sourceCommit,
      installerSha256: q.B05.installer, installedHubSha256: q.B05.executable },
    incoming: { selfUpdateTested: true, managedRouteReconnectTested: true, policyRestored: true, labDiscovery: true, publicDiscovery: false,
      sourceKind: 'unmodified-public-stable', from: selectBaseline('0.1.14'), to: { version: '0.1.14', installer: q.B05.installer, exe: q.B05.executable },
      feed: { pins: { descriptor: assets['creator-hub-windows-x86_64.json'].sha256,
        descriptorSignature: assets['creator-hub-windows-x86_64.json.minisig'].sha256,
        installer: q.B05.installer, manifest: assets['latest.json'].sha256, executable: q.B05.executable } } },
    outgoing: { kind: 'unified-outgoing-14-15', baselineVersion: '0.1.14', targetVersion: '0.1.15',
      outgoingHostedUpdateTested: true, policyRestored: true, publicDiscovery: false,
      before: { executableSha256: q.B05.executable }, cancelled: { executableSha256: q.B05.executable },
      evidence: { manualTargetLaunches: 0, existingSdkRoundTrip: true, newRouterRoundTrips: 2, actualNativePermissions: true } },
  };
  for (const [index, [role, report]] of Object.entries(reports).entries()) {
    const sourceCommit = String(index + 1).repeat(40);
    value.proofs[role] = { runId: 100 + index, runAttempt: 1, sourceCommit, sourceTree: 'c'.repeat(40), jobId: 200 + index,
      artifact: { id: 300 + index, name: `native-${role}`, sha256: 'd'.repeat(64), byteLength: 123 },
      report: embedded(`native-suite-${index}/report.json`, { ...report,
        ...(['fresh', 'guardedInstall'].includes(role) ? { sourceRevision: sourceCommit }
          : role === 'guide' ? { harnessSourceRevision: sourceCommit } : {}),
        passed: true, releaseReady: false, checks: ['Native fixture passed'] }) };
  }
  return { value, files, bodies };
}

function services(f) {
  const run = proof => ({ id: proof.runId, run_attempt: proof.runAttempt, head_sha: proof.sourceCommit, status: 'completed', conclusion: 'success',
    path: q.ROLES[Object.keys(f.value.proofs).find(role => f.value.proofs[role] === proof)].workflow,
    repository: { id: q.REPO_ID, full_name: q.REPO }, head_repository: { id: q.REPO_ID, full_name: q.REPO } });
  const releaseAsset = (name, pin) => ({ id: pin.id, name, size: pin.byteLength, digest: `sha256:${pin.sha256}`, state: 'uploaded' });
  const api = new Map();
  api.set(`git/commits/${q.B05.sourceCommit}`, { sha: q.B05.sourceCommit, tree: { sha: q.B05.sourceTree } });
  api.set(`releases/${q.B05.archive.releaseId}`, { id: q.B05.archive.releaseId, tag_name: q.B05.archive.tag, draft: true,
    assets: [releaseAsset(q.B05.archive.name, q.B05.archive)] });
  api.set(`releases/${f.value.draft.id}`, { id: f.value.draft.id, tag_name: 'v0.1.14', draft: true, prerelease: false,
    assets: Object.entries(f.value.draft.assets).map(([name, pin]) => releaseAsset(name, pin)) });
  const rows = { ...f.files, 'candidate-source.json': f.value.candidate.sourceProof.sha256 };
  for (const [role, proof] of Object.entries(f.value.proofs)) {
    api.set(`actions/runs/${proof.runId}`, run(proof));
    api.set(`git/commits/${proof.sourceCommit}`, { sha: proof.sourceCommit, tree: { sha: proof.sourceTree } });
    api.set(`actions/runs/${proof.runId}/attempts/1/jobs?per_page=100`, { total_count: 1, jobs: [{ id: proof.jobId,
      name: q.ROLES[role].job, run_id: proof.runId, run_attempt: 1, status: 'completed', conclusion: 'success' }] });
    api.set(`actions/artifacts/${proof.artifact.id}`, { id: proof.artifact.id, name: proof.artifact.name, expired: false,
      size_in_bytes: proof.artifact.byteLength, digest: `sha256:${proof.artifact.sha256}`,
      workflow_run: { id: proof.runId, head_sha: proof.sourceCommit, repository_id: q.REPO_ID, head_repository_id: q.REPO_ID } });
  }
  return { api,
    request: async endpoint => structuredClone(api.get(endpoint)),
    readArchive: async (endpoint, pin) => endpoint.startsWith('releases/') ? rows
      : { [Object.values(f.value.proofs).find(proof => proof.artifact.id === pin.id).report.member]:
        Object.values(f.value.proofs).find(proof => proof.artifact.id === pin.id).report.sha256 },
    readAsset: async (name, pin) => ({ ...record(f.bodies[name] || Buffer.alloc(0)), ...pin, bytes: f.bodies[name] }),
  };
}

test('finite B05 qualification accepts only local reviewed pins, without claiming public readiness', () => {
  const f = fixture();
  assert.equal(q.validateQualification(f.value, { version: '0.1.14', platform: 'windows-x86_64' }), f.value);
});

test('local qualification refuses stale B04, future/Unix intent, absent proofs and modified embedded evidence', () => {
  const changes = [v => { v.version = '0.1.15'; }, v => { v.platform = 'linux'; }, v => { v.authorization = 'ready'; },
    v => { v.releaseReady = true; }, v => { v.publicAcceptance = true; }, v => { v.candidate.sourceCommit = 'a'.repeat(40); },
    v => { v.candidate.sourceTree = 'a'.repeat(40); }, v => { v.candidate.archive.sha256 = 'a'.repeat(64); },
    v => { v.productionKeySha256 = 'a'.repeat(64); }, v => { delete v.proofs.incoming; },
    v => { v.linuxReady = true; }, v => { v.proofs.fresh.skip = true; },
    v => { v.candidate.manifest.base64 += 'AA=='; }, v => { v.proofs.guide.report.sha256 = 'a'.repeat(64); },
    v => { v.draft.assets['linux.deb'] = { ...Object.values(v.draft.assets)[0] }; },
    v => { delete v.draft.assets['latest.json']; }];
  for (const change of changes) { const f = fixture(); change(f.value); assert.throws(() => q.validateQualification(f.value, { version: '0.1.14', platform: 'windows-x86_64' })); }
  assert.throws(() => q.validateQualification(fixture().value, { version: '0.1.15', platform: 'windows-x86_64' }));
  assert.throws(() => q.validateQualification(fixture().value, { version: '0.1.14', platform: 'linux' }));
});

test('a hash-valid native report still must pass and bind B05 instead of B04 or broader acceptance claims', () => {
  for (const [role, change] of [
    ['fresh', r => { r.passed = false; }], ['fresh', r => { r.sourceRevision = 'a'.repeat(40); }],
    ['guide', r => { r.installedHubSha256 = 'a'.repeat(64); }],
    ['guardedInstall', r => { r.installerSha256 = 'a'.repeat(64); }], ['incoming', r => { r.selfUpdateTested = false; }],
    ['incoming', r => { r.to.exe = 'a'.repeat(64); }], ['incoming', r => { r.feed.pins.descriptor = 'a'.repeat(64); }],
    ['outgoing', r => { r.before.executableSha256 = 'a'.repeat(64); }], ['outgoing', r => { r.outgoingHostedUpdateTested = false; }],
  ]) {
    const f = fixture(), pin = f.value.proofs[role].report, report = JSON.parse(Buffer.from(pin.base64, 'base64'));
    change(report); f.value.proofs[role].report = embedded(pin.member, report);
    assert.throws(() => q.validateQualification(f.value, { version: '0.1.14', platform: 'windows-x86_64' }));
  }
});

test('remote validation binds successful current runs, exact jobs/trees, original ZIP members and six draft assets', async () => {
  const f = fixture(), io = services(f);
  const result = await q.verifyRemote(f.value, io);
  assert.equal(result.ready, false); assert.equal(result.assets, 6);
});

test('remote failures refuse publication on run, source, artifact, report-member or draft drift', async () => {
  for (const change of [
    io => { io.api.get('actions/runs/100').conclusion = 'failure'; },
    io => { io.api.get('actions/runs/100').run_attempt = 2; },
    io => { io.api.get('actions/runs/100').head_repository.id = 1; },
    io => { io.api.get('actions/runs/100').head_sha = 'a'.repeat(40); },
    io => { io.api.get('git/commits/' + '1'.repeat(40)).tree.sha = 'a'.repeat(40); },
    io => { io.api.get('actions/runs/100/attempts/1/jobs?per_page=100').jobs[0].conclusion = 'skipped'; },
    io => { io.api.get('actions/artifacts/300').workflow_run.head_repository_id = 1; },
    io => { io.api.get('actions/artifacts/300').expired = true; },
    io => { io.api.get('actions/artifacts/300').digest = 'sha256:' + 'a'.repeat(64); },
    io => { io.api.get('actions/artifacts/300').workflow_run.id++; },
    io => { io.api.get('actions/artifacts/300').size_in_bytes++; },
    io => { io.readArchive = async () => ({}); },
    io => { const read = io.readArchive; io.readArchive = async (endpoint, pin) => {
      const rows = await read(endpoint, pin); return endpoint.startsWith('actions/')
        ? Object.fromEntries(Object.keys(rows).map(name => [name, 'a'.repeat(64)])) : rows;
    }; },
    io => { io.api.get('releases/401').assets.push({ ...io.api.get('releases/401').assets[0], id: 999, name: 'linux.deb' }); },
    io => { io.api.get('releases/401').draft = false; },
    io => { io.readAsset = async () => ({ sha256: 'a'.repeat(64), byteLength: 1 }); },
  ]) { const f = fixture(), io = services(f); change(io); await assert.rejects(q.verifyRemote(f.value, io)); }
});

test('current signed metadata must bind the B05 installer, Windows-only update URL and exact checksum body', async () => {
  for (const change of [
    f => { const r = JSON.parse(f.bodies['creator-hub-windows-x86_64.json']); r.executableSha256 = 'a'.repeat(64); f.bodies['creator-hub-windows-x86_64.json'] = Buffer.from(JSON.stringify(r)); },
    f => { const r = JSON.parse(f.bodies['creator-hub-windows-x86_64.json']); r.identityProtocol = 1; f.bodies['creator-hub-windows-x86_64.json'] = Buffer.from(JSON.stringify(r)); },
    f => { const r = JSON.parse(f.bodies['latest.json']); r.platforms.linux = r.platforms['windows-x86_64']; f.bodies['latest.json'] = Buffer.from(JSON.stringify(r)); },
    f => { const r = JSON.parse(f.bodies['latest.json']); r.platforms['windows-x86_64'].url += '?override=1'; f.bodies['latest.json'] = Buffer.from(JSON.stringify(r)); },
    f => { f.bodies['SHA256SUMS.txt'] = Buffer.from('not the qualified checksum map'); },
  ]) { const f = fixture(); change(f); await assert.rejects(q.verifyRemote(f.value, services(f))); }
});

test('capture hashes actual bytes, rejects size/hash mismatch, and never returns a claimed digest', () => {
  const bytes = Buffer.from('synthetic archive');
  assert.deepEqual(q.capture(bytes, record(bytes)), record(bytes));
  assert.throws(() => q.capture(bytes, { ...record(bytes), sha256: 'a'.repeat(64) }));
  assert.throws(() => q.capture(bytes, { ...record(bytes), byteLength: bytes.length + 1 }));
});

test('existing source guard accepts only explicit qualification without changing the provenance phase', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-local-qualification-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'TEST-ONLY.json'), f = fixture();
  fs.writeFileSync(file, JSON.stringify(f.value), { flag: 'wx' });
  const { assertReleaseReady } = require('./check-unified-sources.cjs'), manifest = require('../modules/suite.json');
  assert.equal(assertReleaseReady(manifest, { receiptPath: file, version: '0.1.14', platform: 'windows-x86_64' }).version, '0.1.14');
  assert.equal(manifest.phase, 'source-consolidation');
  const root = path.join(directory, 'source'); fs.mkdirSync(path.join(root, 'src-tauri/src'), { recursive: true });
  for (const name of ['package.json', 'src-tauri/tauri.conf.json']) fs.writeFileSync(path.join(root, name), JSON.stringify({ version: '0.1.14' }));
  const key = fs.readFileSync(path.join(__dirname, '../src-tauri/src/catalog-key.pub'), 'utf8').replace(/\r\n/g, '\n');
  for (const text of [key, key.replace(/\n/g, '\r\n')]) {
    fs.writeFileSync(path.join(root, 'src-tauri/src/catalog-key.pub'), text);
    assert.equal(assertReleaseReady(manifest, { root, receiptPath: file, version: '0.1.14', platform: 'windows-x86_64' }).version, '0.1.14');
  }
  fs.writeFileSync(path.join(root, 'src-tauri/src/catalog-key.pub'), key.replace('RWT', 'RWA'));
  assert.throws(() => assertReleaseReady(manifest, { root, receiptPath: file, version: '0.1.14', platform: 'windows-x86_64' }), /descriptor key differs/);
  assert.throws(() => assertReleaseReady(manifest), /not a unified release/);
  assert.throws(() => assertReleaseReady(manifest, { receiptPath: file, version: '0.1.15', platform: 'windows-x86_64' }));
  assert.throws(() => assertReleaseReady(manifest, { receiptPath: file, version: '0.1.14', platform: 'linux' }));
  fs.writeFileSync(file, JSON.stringify({ approvedForStable: true, acceptanceOnly: true, releaseReady: false }));
  assert.throws(() => assertReleaseReady(manifest, { receiptPath: file, version: '0.1.14', platform: 'windows-x86_64' }));
  fs.writeFileSync(file, JSON.stringify(f.value).replace('"schemaVersion":1', '"schemaVersion":0,"schemaVersion":1'));
  assert.throws(() => q.loadQualification(file, { version: '0.1.14', platform: 'windows-x86_64' }), /duplicate fields/);
});

test('actual shared .NET ZIP decoding hashes members and refuses duplicate or escaping names without extraction', { skip: process.platform !== 'win32' }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-zip-decoder-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture.zip');
  function zip(names) {
    fs.rmSync(file, { force: true });
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
      $spec=[Console]::In.ReadToEnd() | ConvertFrom-Json
      $zip=[IO.Compression.ZipFile]::Open($spec.file, [IO.Compression.ZipArchiveMode]::Create)
      try { foreach($name in $spec.names) { $entry=$zip.CreateEntry($name); $writer=[IO.StreamWriter]::new($entry.Open())
        try { $writer.Write('synthetic report') } finally { $writer.Dispose() } } } finally { $zip.Dispose() }`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { input: JSON.stringify({ file, names }), encoding: 'utf8', windowsHide: true, timeout: 10000 });
    return fs.readFileSync(file);
  }
  assert.deepEqual(q.inspectArchive(zip(['native/report.json'])), { 'native/report.json': record(Buffer.from('synthetic report')).sha256 });
  assert.throws(() => q.inspectArchive(zip(['report.json', 'REPORT.JSON'])));
  assert.throws(() => q.inspectArchive(zip(['../report.json'])));
  assert.equal(fs.existsSync(path.join(directory, 'native')), false);
});
