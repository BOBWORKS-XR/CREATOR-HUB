// Finite B05/0.1.14 publication qualification, not a cross-platform release framework.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { selectBaseline } = require('./self-update-baselines.cjs');
const { updaterManifest } = require('./release-descriptor.cjs');
const REPO = 'BOBWORKS-XR/CREATOR-HUB', REPO_ID = 1364807512;
const B05 = Object.freeze({
  sourceCommit: 'db862739d01088ba9be335d0522f8f129222a48b', sourceTree: '2c2e16053bdd2c9b6fa9301992324c44465757f8',
  installer: '284820f92de487e8a0f1bb5b3b99cafe5e073f0402a9350a2ea6e76fa9543157', installerBytes: 36511040,
  executable: 'cd5e3fd2829727d06444c0f3266b178798d1b55c63df651be12eb38ac4523a86',
  productionKeySha256: '3c41b4294f116113dda208beea540a349dbcd8d7297933fefdc147b08cf56488',
  archive: Object.freeze({ releaseId: 411494394, tag: 'v0.1.13-validation', id: 642095693,
    name: 'unified-windows-b05-db86273-20261015.zip', byteLength: 86746913,
    sha256: 'd18872d804196c4606f9908597c8fd0587ab769d9cbcd701edd490b757bbe3a2' }),
});
const ROLES = Object.freeze({
  fresh: { workflow: '.github/workflows/native-convergence-014.yml', job: 'native-guide (fresh-components)' },
  guide: { workflow: '.github/workflows/native-convergence-014.yml', job: 'native-guide (upgrade-guide)' },
  guardedInstall: { workflow: '.github/workflows/native-convergence-014.yml', job: 'native-guide (hub-only-upgrade)' },
  incoming: { workflow: '.github/workflows/signed-update-lab.yml', job: 'update' },
  outgoing: { workflow: '.github/workflows/native-unified-outgoing-lab.yml', job: 'outgoing-lab' },
});
const META = {
  sourceProof: ['candidate-source.json', '25dcfb4a8fa718190fb4d9a3d345f4ad8f970e1f5f21c5c80a829da8370b1f6a', 2301],
  manifest: ['builtin-manifest.json', '6be984c3358ce956154ecf6aa38532320e0be2765d54285a12183319121bb4cb', 2053],
  installerChecksum: ['installer-checksum.json', '9ee05a11973b86facc2e789f60d24325d6525a77bc8504778329bd35abbf6906', 228],
};
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const positive = value => assert.ok(Number.isSafeInteger(value) && value > 0, 'Positive immutable ID/size required');
const sha = (value, length = 64) => assert.ok(typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value), 'Invalid source/digest pin');
function keys(value, expected) { assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'Exact qualification field/asset set required'); }
function pin(value) { positive(value.byteLength); assert.ok(value.byteLength <= 256 * 1024 * 1024); sha(value.sha256); }
function capture(bytes, expected) {
  assert.ok(Buffer.isBuffer(bytes)); pin(expected);
  const actual = { sha256: hash(bytes), byteLength: bytes.length };
  assert.deepEqual(actual, { sha256: expected.sha256, byteLength: expected.byteLength }, 'Actual downloaded bytes differ from qualification');
  return actual;
}
function member(name) {
  assert.ok(typeof name === 'string' && name.length <= 256 && !/[\x00-\x1f\x7f\\:]/.test(name)
    && name.split('/').every(part => part && part !== '.' && part !== '..'), 'Unsafe archive member');
}
function embedded(value) {
  keys(value, ['member', 'sha256', 'byteLength', 'base64']);
  pin(value); member(value.member); assert.ok(value.byteLength <= 256 * 1024);
  assert.ok(typeof value.base64 === 'string' && value.base64.length <= 350000);
  const bytes = Buffer.from(value.base64, 'base64');
  assert.equal(bytes.toString('base64'), value.base64, 'Noncanonical evidence encoding'); capture(bytes, value);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function assetNames(installer) {
  assert.ok(typeof installer === 'string' && /^[A-Za-z0-9._-]+\.exe$/.test(installer)
    && installer.trim() === installer && !installer.includes('..'), 'Exact safe Windows installer name required');
  return [installer, `${installer}.sig`, 'creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig', 'latest.json', 'SHA256SUMS.txt'];
}
function validateReport(role, proof, value) {
  const r = embedded(proof.report);
  assert.equal(r.passed, true); assert.equal(r.releaseReady, false); assert.ok(Array.isArray(r.checks) && r.checks.length > 0);
  for (const [name, content] of Object.entries(r)) if (name === 'error' || /(?:Cleanup|cleanup)Error$/.test(name)) assert.ok(!content, 'Native proof contains an error');
  for (const field of ['sourceRevision', 'harnessSourceRevision']) if (r[field] !== undefined) assert.equal(r[field], proof.sourceCommit);
  if (['fresh', 'guide', 'guardedInstall'].includes(role)) {
    assert.equal(r.candidateSourceRevision, B05.sourceCommit);
    assert.equal(role === 'fresh' ? r.hubSha256 : r.installedHubSha256, B05.executable);
    assert.equal(r.scope, { fresh: 'component-built-in-smoke-not-guide-acceptance', guide: 'actual-first-launch-convergence-not-signed-update',
      guardedInstall: 'actual-public12-to-B05-guarded-nsis-hub-only-contract' }[role]);
    if (role === 'guardedInstall') assert.equal(r.installerSha256, B05.installer);
  } else if (role === 'incoming') {
    for (const field of ['selfUpdateTested', 'managedRouteReconnectTested', 'policyRestored', 'labDiscovery']) assert.equal(r[field], true);
    assert.equal(r.publicDiscovery, false); assert.equal(r.sourceKind, 'unmodified-public-stable');
    assert.deepEqual(r.from, selectBaseline('0.1.14'));
    assert.deepEqual(r.to, { version: '0.1.14', installer: B05.installer, exe: B05.executable });
    assert.deepEqual(r.feed.pins, { descriptor: value.draft.assets['creator-hub-windows-x86_64.json'].sha256,
      descriptorSignature: value.draft.assets['creator-hub-windows-x86_64.json.minisig'].sha256,
      installer: B05.installer, manifest: value.draft.assets['latest.json'].sha256, executable: B05.executable });
  } else {
    assert.equal(r.kind, 'unified-outgoing-14-15'); assert.equal(r.baselineVersion, '0.1.14'); assert.equal(r.targetVersion, '0.1.15');
    assert.equal(r.outgoingHostedUpdateTested, true); assert.equal(r.policyRestored, true); assert.equal(r.publicDiscovery, false);
    assert.equal(r.before.executableSha256, B05.executable); assert.equal(r.cancelled.executableSha256, B05.executable);
    assert.equal(r.evidence.manualTargetLaunches, 0); assert.equal(r.evidence.existingSdkRoundTrip, true);
    assert.equal(r.evidence.newRouterRoundTrips, 2); assert.equal(r.evidence.actualNativePermissions, true);
  }
}
function validateQualification(value, intent) {
  assert.equal(intent.version, '0.1.14'); assert.equal(intent.platform, 'windows-x86_64');
  keys(value, ['schemaVersion', 'kind', 'repository', 'repositoryId', 'version', 'platform', 'authorization',
    'releaseReady', 'publicAcceptance', 'productionKeySha256', 'candidate', 'draft', 'proofs']);
  assert.equal(value.schemaVersion, 1); assert.equal(value.kind, 'windows-014-qualified-draft');
  assert.equal(value.repository, REPO); assert.equal(value.repositoryId, REPO_ID);
  assert.equal(value.version, intent.version); assert.equal(value.platform, intent.platform);
  assert.equal(value.authorization, 'publish-qualified-draft-only'); assert.equal(value.releaseReady, false); assert.equal(value.publicAcceptance, false);
  assert.equal(value.productionKeySha256, B05.productionKeySha256);
  const c = value.candidate;
  keys(c, ['sourceCommit', 'sourceTree', 'archive', 'sourceProof', 'manifest', 'installerChecksum']);
  assert.equal(c.sourceCommit, B05.sourceCommit); assert.equal(c.sourceTree, B05.sourceTree); assert.deepEqual(c.archive, B05.archive);
  const docs = {};
  for (const [field, [name, digest, size]] of Object.entries(META)) {
    assert.equal(c[field].member, name); assert.equal(c[field].sha256, digest); assert.equal(c[field].byteLength, size); docs[field] = embedded(c[field]);
  }
  assert.equal(docs.sourceProof.sourceRevision, B05.sourceCommit); assert.equal(docs.sourceProof.privateKeyIncluded, false);
  assert.equal(docs.sourceProof.acceptanceOnly, true); assert.equal(docs.sourceProof.releaseReady, false);
  assert.equal(docs.sourceProof.files['installer.exe'], B05.installer);
  assert.equal(docs.installerChecksum.installedExecutableSha256, B05.executable);
  const mapped = Object.fromEntries([...Object.values(docs.manifest.modules).flatMap(module => Object.entries(module.files)),
    ...Object.entries(docs.manifest.managedRouting.files)].map(([name, digest]) => [`modules/${name}`, digest]));
  assert.deepEqual(mapped, Object.fromEntries(Object.entries(docs.sourceProof.files).filter(([name]) => name.startsWith('modules/'))));
  keys(value.draft, ['id', 'installerAssetName', 'assets']); positive(value.draft.id); keys(value.draft.assets, assetNames(value.draft.installerAssetName));
  const ids = new Set();
  for (const asset of Object.values(value.draft.assets)) { keys(asset, ['id', 'sha256', 'byteLength']); pin(asset); positive(asset.id); assert.ok(!ids.has(asset.id), 'Duplicate release asset ID'); ids.add(asset.id); }
  const installer = value.draft.assets[value.draft.installerAssetName];
  assert.equal(installer.sha256, B05.installer); assert.equal(installer.byteLength, B05.installerBytes);
  keys(value.proofs, Object.keys(ROLES));
  for (const [role, proof] of Object.entries(value.proofs)) {
    keys(proof, ['runId', 'runAttempt', 'sourceCommit', 'sourceTree', 'jobId', 'artifact', 'report']);
    for (const field of ['runId', 'runAttempt', 'jobId']) positive(proof[field]);
    sha(proof.sourceCommit, 40); sha(proof.sourceTree, 40); keys(proof.artifact, ['id', 'name', 'sha256', 'byteLength']); positive(proof.artifact.id); pin(proof.artifact);
    assert.ok(typeof proof.artifact.name === 'string' && proof.artifact.name.length > 0 && proof.artifact.name.length <= 256);
    validateReport(role, proof, value);
  }
  return value;
}
function loadQualification(file, intent) {
  const stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2 * 1024 * 1024, 'Bounded regular reviewed receipt required');
  const text = fs.readFileSync(file, 'utf8'), value = JSON.parse(text);
  assert.ok(text.trim() === JSON.stringify(value, null, 2) || text.trim() === JSON.stringify(value), 'Canonical receipt required; duplicate fields refused');
  return validateQualification(value, intent);
}

// Use the existing .NET ZIP decoder; never extract paths or execute artifact contents.
function inspectArchive(bytes) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-qualification-'));
  try {
    const file = path.join(directory, 'original.zip'); fs.writeFileSync(file, bytes, { flag: 'wx' });
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem
      $zip=[IO.Compression.ZipFile]::OpenRead([Console]::In.ReadToEnd()); $rows=@{}; $total=0L
      try { foreach($entry in $zip.Entries) {
        if($entry.FullName.EndsWith('/')) { continue }
        if($rows.ContainsKey($entry.FullName) -or $entry.Length -gt 536870912 -or $rows.Count -ge 1024) { throw 'Unsafe ZIP inventory' }
        $total += $entry.Length; if($total -gt 1073741824) { throw 'ZIP expansion bound' }
        $stream=$entry.Open(); $sha=[Security.Cryptography.SHA256]::Create()
        try { $rows[$entry.FullName]=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
        finally { $sha.Dispose(); $stream.Dispose() }
      }; [Console]::Write(($rows | ConvertTo-Json -Compress)) } finally { $zip.Dispose() }`;
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    const rows = JSON.parse(execFileSync(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', script],
      { input: file, encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024, env }));
    for (const [name, digest] of Object.entries(rows)) { member(name); sha(digest); }
    return rows;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
function downloadArchive(endpoint, execute = execFileSync) {
  assert.match(endpoint, /^(?:releases\/assets\/[1-9][0-9]*|actions\/artifacts\/[1-9][0-9]*\/zip)$/);
  // Actions requires JSON negotiation before redirecting to its ZIP bytes.
  const accept = endpoint.startsWith('actions/') ? 'application/json' : 'application/octet-stream';
  return execute('gh', ['api', `repos/${REPO}/${endpoint}`, '-H', `Accept: ${accept}`],
    { windowsHide: true, timeout: 180000, maxBuffer: 256 * 1024 * 1024 });
}
async function verifyRemote(value, services = {}) {
  validateQualification(value, { version: '0.1.14', platform: 'windows-x86_64' });
  const api = endpoint => execFileSync('gh', ['api', `repos/${REPO}/${endpoint}`], { windowsHide: true, timeout: 180000, maxBuffer: 256 * 1024 * 1024 });
  const request = services.request || (async endpoint => JSON.parse(api(endpoint)));
  const download = endpoint => downloadArchive(endpoint);
  const readArchive = services.readArchive || (async (endpoint, pin) => { const bytes = download(endpoint); capture(bytes, pin); return inspectArchive(bytes); });
  const readAsset = services.readAsset || (async (name, pin) => { const bytes = download(`releases/assets/${pin.id}`); return { ...capture(bytes, pin), bytes: bytes.length <= 256 * 1024 ? bytes : undefined }; });
  const commit = async (source, tree) => { const c = await request(`git/commits/${source}`); assert.equal(c.sha, source); assert.equal(c.tree.sha, tree); };
  const asset = (actual, name, pin) => {
    assert.equal(actual.id, pin.id); assert.equal(actual.name, name); assert.equal(actual.size, pin.byteLength);
    assert.equal(actual.digest, `sha256:${pin.sha256}`); assert.equal(actual.state, 'uploaded');
  };
  await commit(B05.sourceCommit, B05.sourceTree);
  const original = await request(`releases/${B05.archive.releaseId}`);
  assert.equal(original.id, B05.archive.releaseId); assert.equal(original.tag_name, B05.archive.tag); assert.equal(original.draft, true);
  const matches = original.assets.filter(item => item.id === B05.archive.id); assert.equal(matches.length, 1); asset(matches[0], B05.archive.name, B05.archive);
  const rows = await readArchive(`releases/assets/${B05.archive.id}`, B05.archive);
  assert.deepEqual(rows, { ...embedded(value.candidate.sourceProof).files, 'candidate-source.json': value.candidate.sourceProof.sha256 }, 'Original B05 ZIP payload map differs');
  for (const [role, proof] of Object.entries(value.proofs)) {
    const run = await request(`actions/runs/${proof.runId}`);
    assert.equal(run.id, proof.runId); assert.equal(run.run_attempt, proof.runAttempt); assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
    assert.equal(run.head_sha, proof.sourceCommit); assert.equal(run.path, ROLES[role].workflow);
    for (const field of ['repository', 'head_repository']) { assert.equal(run[field].id, REPO_ID); assert.equal(run[field].full_name, REPO); }
    await commit(proof.sourceCommit, proof.sourceTree);
    const jobs = await request(`actions/runs/${proof.runId}/attempts/${proof.runAttempt}/jobs?per_page=100`);
    assert.ok(jobs.jobs.length <= 100 && jobs.total_count === jobs.jobs.length, 'Complete bounded native job list required');
    const selected = jobs.jobs.filter(job => job.id === proof.jobId); assert.equal(selected.length, 1);
    for (const [key, expected] of Object.entries({ name: ROLES[role].job, run_id: proof.runId, run_attempt: proof.runAttempt, status: 'completed', conclusion: 'success' })) assert.equal(selected[0][key], expected);
    const a = await request(`actions/artifacts/${proof.artifact.id}`);
    assert.equal(a.id, proof.artifact.id); assert.equal(a.name, proof.artifact.name); assert.equal(a.expired, false);
    assert.equal(a.size_in_bytes, proof.artifact.byteLength); assert.equal(a.digest, `sha256:${proof.artifact.sha256}`);
    assert.deepEqual(a.workflow_run, { ...a.workflow_run, id: proof.runId, head_sha: proof.sourceCommit, repository_id: REPO_ID, head_repository_id: REPO_ID });
    const reportRows = await readArchive(`actions/artifacts/${a.id}/zip`, proof.artifact);
    assert.equal(reportRows[proof.report.member], proof.report.sha256, 'Original native report is not in its pinned artifact');
  }
  const draft = await request(`releases/${value.draft.id}`);
  assert.equal(draft.id, value.draft.id); assert.equal(draft.tag_name, 'v0.1.14'); assert.equal(draft.draft, true); assert.equal(draft.prerelease, false);
  assert.equal(draft.assets.length, 6); keys(Object.fromEntries(draft.assets.map(a => [a.name, a])), Object.keys(value.draft.assets));
  const bodies = {};
  for (const a of draft.assets) {
    const pin = value.draft.assets[a.name]; asset(a, a.name, pin);
    const bytes = await readAsset(a.name, pin);
    assert.deepEqual({ sha256: bytes.sha256, byteLength: bytes.byteLength }, { sha256: pin.sha256, byteLength: pin.byteLength });
    bodies[a.name] = bytes.bytes;
  }
  const installer = value.draft.installerAssetName, descriptor = JSON.parse(bodies['creator-hub-windows-x86_64.json']);
  for (const [key, expected] of Object.entries({ schemaVersion: 1, appId: 'creator-hub', version: '0.1.14', platform: 'windows', architecture: 'x86_64',
    packageType: 'nsis', assetName: installer, byteLength: B05.installerBytes, sha256: B05.installer, executableSha256: B05.executable,
    identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1 })) assert.equal(descriptor[key], expected);
  const latest = JSON.parse(bodies['latest.json']); assert.equal(latest.version, '0.1.14');
  assert.deepEqual(latest.platforms, updaterManifest({ repo: 'CREATOR-HUB' }, '0.1.14', installer, bodies[`${installer}.sig`].toString('utf8').trim()).platforms);
  const sums = Object.keys(value.draft.assets).filter(name => name !== 'SHA256SUMS.txt').sort().map(name => `${value.draft.assets[name].sha256}  ${name}\n`).join('');
  assert.equal(bodies['SHA256SUMS.txt'].toString('utf8'), sums, 'Checksums must cover exactly five qualified product assets');
  return { version: '0.1.14', platform: 'windows-x86_64', draftId: draft.id, assets: 6, ready: false };
}
module.exports = { REPO, REPO_ID, B05, ROLES, capture, inspectArchive, downloadArchive, validateQualification, loadQualification, verifyRemote };
