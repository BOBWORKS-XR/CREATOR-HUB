'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const w = require('./sign-private-linux-deb-017.cjs');
const m = require('./private-linux-update-fixture-017-metadata.cjs');
const portable = require('./private-linux-portable-fixture-017.cjs');
const archive = require('./module-archive.cjs');
const { data, elf, json } = require('./fixtures/private-linux-update-fixture-017.cjs');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const dummy = () => ({ size: 1, sha256: 'a'.repeat(64) });
function owned(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'private-deb017-test-')));
  t.after(() => { assert.equal(fs.realpathSync(root), root); assert.ok(path.basename(root).startsWith('private-deb017-test-')); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
function sample() {
  return { schemaVersion: 1, profile: w.PROFILE, rootSource: structuredClone(w.SOURCE),
    producer: { runId: 101, runAttempt: 1, jobId: 102, workflowId: 103, artifactId: 104, zip: dummy() },
    files: Object.fromEntries(Object.entries(portable.ROLES).map(([role, name]) => [role, { member: `owned/${name}`, ...dummy() }])),
    signed017: { planSha256: 'b'.repeat(64) }, tools: { metadata: dummy(), fixture: dummy(), sources: Object.fromEntries(w.TOOL_SOURCES.map(name => [name, dummy()])) } };
}
function proof(p) {
  const a = p.producer, repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' };
  return { run: { id: a.runId, run_attempt: a.runAttempt, head_sha: w.SOURCE.sourceCommit,
    head_branch: 'validation/linux-private-update-fixture-017', path: '.github/workflows/private-linux-update-fixture-017.yml',
    workflow_id: a.workflowId, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', repository: repo, head_repository: repo },
  job: { id: a.jobId, run_id: a.runId, run_attempt: a.runAttempt, head_sha: w.SOURCE.sourceCommit, name: 'assemble', status: 'completed',
    conclusion: 'success', labels: ['ubuntu-22.04'], started_at: '2026-10-20T10:00:00Z', completed_at: '2026-10-20T11:00:00Z' },
  workflow: { id: a.workflowId, path: '.github/workflows/private-linux-update-fixture-017.yml' },
  artifact: { id: a.artifactId, expired: false, name: `private-linux-update-fixture-017-${a.runId}-${a.runAttempt}`, size_in_bytes: a.zip.size,
    digest: `sha256:${a.zip.sha256}`, created_at: '2026-10-20T10:59:00Z', workflow_run: { id: a.runId, head_sha: w.SOURCE.sourceCommit,
      head_branch: 'validation/linux-private-update-fixture-017', repository_id: 1364807512, head_repository_id: 1364807512 } },
  commit: { sha: w.SOURCE.sourceCommit, tree: { sha: w.SOURCE.sourceTree } } };
}
function assemblyFixture() {
  const f = data(); f.plan.rootSource = structuredClone(w.SOURCE); f.rootApi.commit = { sha: w.SOURCE.sourceCommit, tree: { sha: w.SOURCE.sourceTree } };
  f.files['plan.json'] = json(f.plan); f.files['root017-api.json'] = json(f.rootApi);
  f.files['derivation017.json'] = m.derivationBytes(f.plan, f.handoff, f.prepared, f.originalRecords, f.files['runtime017.json'], f.files['runtime017.minisig']);
  const derived = m.validateDerivation(f.files['derivation017.json'], f.plan, f.handoff, f.prepared, f.originalRecords, f.files['runtime017.json'], f.files['runtime017.minisig']);
  const hashes = archive.rawFiles(derived), packed = Buffer.from('Synthetic module archive; never a native input');
  const manifest = { ...structuredClone(derived), payloadArchive: { schemaVersion: 1, file: 'modules.tar.gz', ...w.record(packed), unpackedSize: Object.keys(hashes).length,
    files: Object.fromEntries(Object.keys(hashes).map(name => [name, { size: 1, mode: archive.modeFor(derived, name) }])) } };
  const embedded = Buffer.from(JSON.stringify(manifest, null, 2)), raw = Buffer.concat([elf('synthetic Root17'), embedded,
    Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK'), Buffer.from(require('./build-unified.cjs').PORTABLE_ROOT_WITNESSES.join('\n'))]);
  const installed = Buffer.from(raw), at = raw.indexOf('__TAURI_BUNDLE_TYPE_VAR_UNK'); installed.write('DEB', at + '__TAURI_BUNDLE_TYPE_VAR_UNK'.length - 3, 'ascii');
  const bodies = { root: raw, archive: packed, manifest: embedded, deb: Buffer.from('Synthetic DEB; never installed or signed with a real key'),
    api: json({ baseline: f.baselineApi, root: f.rootApi }) };
  const receipt = { schemaVersion: 1, profile: 'private-update-fixture-017', hubVersion: w.VERSION, rootSource: w.SOURCE,
    compiledFeatures: [...portable.FEATURES], target: portable.TARGET, derivation: w.record(f.files['derivation017.json']),
    original016: { source: f.handoff.source, files: f.plan.original016 }, baseline016: f.plan.baseline016,
    rawHub: w.record(raw), packagedHub: w.record(installed), archive: w.record(packed), manifest: w.record(embedded), deb: w.record(bodies.deb),
    packageReport: { scope: 'private017-deb-delta-only', helperPolicyServicePreserved: true, original016Preserved: true,
      nativeGuiAccepted: false, migrationAccepted: false, signedUpdateAccepted: false, restartAccepted: false, releaseReady: false },
    ...require('./private-linux-update-fixture-017.cjs').FLAGS };
  bodies.receipt = json(receipt);
  bodies.integrity = json({ schemaVersion: 1, platform: 'linux', arch: 'x86_64', integrityPassed: true, experimental: true, mcpMode: 'writable', writableGuiAccepted: false,
    releaseReady: false, packages: [{ format: 'deb', path: `native-packages/${portable.ROLES.deb}`, sha256: receipt.deb.sha256, hubSha256: receipt.packagedHub.sha256, files: hashes }] });
  bodies.expected = json({ candidate: { deb: receipt.deb, hub: receipt.packagedHub, archive: receipt.archive },
    baseline: Object.fromEntries(['deb', 'hub', 'helper', 'policy', 'service'].map(name => [name, f.plan.baseline016.pins[name]])) });
  return { f, bodies, installed: w.record(installed) };
}
function create(t, fault = '') {
  const root = owned(t), input = path.join(root, 'artifacts/input'), output = path.join(root, 'artifacts/output'), planFile = path.join(root, 'plan.json');
  fs.mkdirSync(input, { recursive: true });
  const fixture = assemblyFixture(), { f, bodies, installed } = fixture, plan = sample();
  function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
  for (const [name, bytes] of Object.entries(f.files)) write(path.join(input, 'signed017', name), bytes);
  plan.signed017.planSha256 = w.record(f.files['plan.json']).sha256;
  for (const [role, bytes] of Object.entries(bodies)) Object.assign(plan.files[role], w.record(bytes));
  const zipFile = path.join(input, 'assembly017.zip');
  execFileSync(PYTHON, ['-B', '-c', 'import base64,json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"x",compression=zipfile.ZIP_STORED) as z:\n for n,b in json.load(sys.stdin).items(): z.writestr(n,base64.b64decode(b))', zipFile],
    { input: JSON.stringify(Object.fromEntries(Object.entries(bodies).map(([role, bytes]) => [plan.files[role].member, bytes.toString('base64')]))), windowsHide: true });
  plan.producer.zip = w.record(fs.readFileSync(zipFile));
  for (const [name, relative] of Object.entries({ metadata: w.VERIFIER, fixture: w.FIXTURE })) {
    const bytes = Buffer.from(`Synthetic ${name} verifier; never executed`); write(path.join(root, relative), bytes); plan.tools[name] = w.record(bytes);
  }
  for (const name of w.TOOL_SOURCES) { const bytes = Buffer.from(`Synthetic source binding: ${name}`); write(path.join(root, name), bytes); plan.tools.sources[name] = w.record(bytes); }
  write(planFile, w.json(plan));
  const api = proof(plan), counts = { keys: 0, signatures: 0 }, events = [];
  const request = async route => {
    events.push('api');
    if (fault === 'api-mutation') fs.appendFileSync(zipFile, 'changed during API');
    if (fault === 'api-replacement') { const same = fs.readFileSync(zipFile); fs.renameSync(zipFile, `${zipFile}.previous`); fs.writeFileSync(zipFile, same); }
    const a = plan.producer, replies = { [`actions/runs/${a.runId}`]: api.run, [`actions/jobs/${a.jobId}`]: api.job,
      [`actions/workflows/${a.workflowId}`]: api.workflow, [`actions/artifacts/${a.artifactId}`]: api.artifact, [`git/commits/${w.SOURCE.sourceCommit}`]: api.commit };
    assert.ok(Object.hasOwn(replies, route)); return replies[route];
  };
  if (fault === 'failed-api') api.run.conclusion = 'failure';
  if (fault === 'wrong-api-tree') api.commit.tree.sha = '0'.repeat(40);
  const execute = (program, args, options) => {
    if (program === 'python') { assert.equal(args[0], '-B'); assert.equal(args[1], '-c'); return execFileSync(PYTHON, args, options); }
    if (program === path.join(root, w.VERIFIER)) {
      events.push('metadata'); if (fault === 'metadata') return 'refused';
      return `Verified trusted package signature: ${w.record(fs.readFileSync(args[0])).sha256}. No activation or client changes.`;
    }
    assert.equal(program, path.join(root, w.FIXTURE)); const mode = args[0]; events.push(mode);
    if (fault === mode) throw Error('PRIVATE SENTINEL refusal');
    if (mode === 'verify') {
      const desc = JSON.parse(fs.readFileSync(path.join(output, w.DESCRIPTOR))), latest = JSON.parse(fs.readFileSync(path.join(output, 'latest.json')));
      assert.deepEqual(desc, w.descriptor(w.record(bodies.deb), installed));
      assert.deepEqual(latest, w.latest(fs.readFileSync(path.join(output, `${w.ASSET}.minisig`))));
      assert.ok(fs.readFileSync(path.join(output, w.ASSET)).equals(bodies.deb));
    }
    const response = { scope: w.PROFILE, mode, sourceVersion: w.FROM, targetVersion: w.VERSION, deb: w.record(bodies.deb), rawHub: w.record(bodies.root),
      installedHub: installed, fullResourcesVerified: true, signaturesVerified: mode === 'verify', ...w.FLAGS };
    if (fault === 'wrong-inspected-elf') response.installedHub = w.record(bodies.root);
    if (fault === 'fake-acceptance') response.releaseReady = true;
    if (fault === 'wrong-inspected-package') response.deb = w.record(bodies.root);
    if (fault === 'extra-protocol') response.installerProtocol = 0;
    return JSON.stringify(response);
  };
  const signer = {
    signingKey() {
      counts.keys++; events.push('key'); if (fault === 'key') throw Error('PRIVATE SENTINEL');
      if (fault === 'key-mutation') fs.appendFileSync(zipFile, 'changed during key callback');
      return 'OPAQUE TEST HANDLE';
    },
    signDetached(file, key) {
      assert.equal(key, 'OPAQUE TEST HANDLE'); counts.signatures++; events.push('sign');
      const expected = counts.signatures === 1 ? w.json(w.descriptor(w.record(bodies.deb), installed)) : bodies.deb;
      assert.ok(fs.readFileSync(file).equals(expected)); assert.ok(counts.signatures <= 2);
      if (fault === 'signer') throw Error('PRIVATE SENTINEL');
      if (fault === 'signer-mutation') fs.appendFileSync(path.join(output, w.ASSET), 'tamper');
      if (fault === 'descriptor-mutation') fs.appendFileSync(path.join(output, w.DESCRIPTOR), 'tamper');
      if (fault === 'tool-mutation') fs.appendFileSync(path.join(root, w.FIXTURE), 'tamper');
      if (fault === 'bad-signature') return Buffer.from('invalid');
      return Buffer.from(`untrusted comment: SYNTHETIC ONLY\nbody-${counts.signatures}\n`);
    },
  };
  // Only fresh lineage networking is stubbed; assembly and signature gate sequencing stay real.
  const filename = require.resolve('./sign-private-linux-deb-017.cjs'), mod = new Module(filename, module);
  mod.filename = filename; mod.paths = module.paths; const realRequire = mod.require.bind(mod);
  mod.require = name => name === './private-linux-update-fixture-017-provenance.cjs' ? {
    fresh: async () => { events.push('lineage'); if (fault === 'lineage') throw Error('Lineage refused'); return { syntheticUnitProof: true }; },
  } : realRequire(name);
  mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  const inputs = { input, output, plan: planFile, planSha256: w.record(fs.readFileSync(planFile)).sha256 };
  return { root, plan, planFile, input, output, zipFile, bodies, installed, counts, events, writer: mod.exports, inputs,
    services: { root, platform: 'win32', execute, request, signer } };
}
test('fixed private plan cannot override key, paths, versions, profiles, flags or tool roles', () => {
  w.validatePlan(sample());
  for (const change of [p => { p.profile = 'approved-release'; }, p => { p.version = '0.1.18'; }, p => { p.key = '/key'; },
    p => { p.rootSource.sourceCommit = 'c'.repeat(40); }, p => { p.files.deb.member = '../foreign.deb'; }, p => { delete p.files.root; },
    p => { p.producer.runAttempt = true; }, p => { p.files.manifest.size = 65537; }, p => { p.tools.fixture.path = '/override'; },
    p => { p.approvedForStable = true; }]) { const p = sample(); change(p); assert.throws(() => w.validatePlan(p)); }
});
test('API admission requires actual017 source, successful exact job, repository, artifact digest and interval', async () => {
  const p = sample(), good = proof(p); w.validateAPI(p, good);
  for (const change of [v => { v.run.head_sha = 'c'.repeat(40); }, v => { v.run.conclusion = 'failure'; }, v => { v.job.name = 'stage-input'; },
    v => { v.job.run_attempt++; }, v => { v.run.repository = { id: 1 }; }, v => { v.commit.tree.sha = 'f'.repeat(40); },
    v => { v.artifact.digest = 'wrong'; }, v => { v.artifact.created_at = '2026-10-20T11:00:01Z'; }, v => { v.artifact.workflow_run.repository_id++; }]) {
    const value = structuredClone(good); change(value); assert.throws(() => w.validateAPI(p, value));
  }
});
test('descriptor and latest are exactly fixed private16 -> 17 and plain Minisign is base64 encoded once', () => {
  const d = w.descriptor(dummy(), dummy()); assert.equal(d.version, '0.1.17'); assert.equal(d.minHubVersion, '0.1.16');
  assert.deepEqual([d.identityProtocol, d.lifecycleProtocol, d.installerProtocol], [0, 0, 1]);
  const sig = Buffer.from('untrusted comment: synthetic\nsignature\n'), latest = w.latest(sig);
  assert.deepEqual(Object.keys(latest.platforms), [w.PLATFORM]); assert.equal(latest.platforms[w.PLATFORM].url, w.URL);
  assert.ok(Buffer.from(latest.platforms[w.PLATFORM].signature, 'base64').equals(sig));
  assert.throws(() => w.latest(Buffer.from(sig.toString('base64'))));
});
test('CLI has only the four fixed arguments, canonical plans reject duplicate JSON', () => {
  assert.deepEqual(w.cli(['--input', '/a', '--plan', '/b', '--plan-sha256', 'c', '--output', '/d']), { input: '/a', plan: '/b', planSha256: 'c', output: '/d' });
  for (const name of ['--key', '--version', '--profile', '--verifier']) assert.throws(() => w.cli([name, '/a', '--plan', '/b', '--plan-sha256', 'c', '--output', '/d']));
  assert.throws(() => w.parse(Buffer.from('{"schemaVersion":1,"schemaVersion":1}\n')));
});
test('pure writer uses preflight before key, exactly two authorized bodies, and postverification before receipt', async t => {
  const f = create(t), before = fs.readFileSync(f.zipFile), result = await f.writer.sign(f.inputs, f.services);
  assert.deepEqual(f.counts, { keys: 1, signatures: 2 }); assert.ok(f.events.indexOf('lineage') < f.events.indexOf('inspect'));
  assert.ok(f.events.indexOf('inspect') < f.events.indexOf('key')); assert.ok(f.events.lastIndexOf('sign') < f.events.indexOf('verify'));
  assert.ok(fs.readFileSync(f.zipFile).equals(before)); assert.ok(fs.readFileSync(path.join(f.output, w.ASSET)).equals(f.bodies.deb));
  const receipt = JSON.parse(fs.readFileSync(path.join(f.output, w.RECEIPT))); assert.equal(receipt.offlineInputsVerified, true);
  for (const [name, value] of Object.entries(w.FLAGS)) { assert.equal(result[name], value); assert.equal(receipt[name], value); }
  assert.equal(receipt.privateKeyIncluded, false); assert.equal(receipt.authorizedBodiesSigned, 2);
  assert.equal(fs.existsSync(path.join(f.output, 'latest.json.minisig')), false);
  await assert.rejects(f.writer.sign(f.inputs, f.services)); assert.deepEqual(f.counts, { keys: 1, signatures: 2 });
});
for (const fault of ['failed-api', 'wrong-api-tree', 'metadata', 'lineage', 'inspect', 'wrong-inspected-elf', 'wrong-inspected-package', 'extra-protocol', 'fake-acceptance', 'api-mutation', 'api-replacement']) {
  test(`pre-key refusal: ${fault}`, async t => {
    const f = create(t, fault); await assert.rejects(f.writer.sign(f.inputs, f.services), error => error.message === w.FAILURE);
    assert.deepEqual(f.counts, { keys: 0, signatures: 0 }); assert.equal(fs.existsSync(f.output), false);
  });
}
for (const fault of ['key', 'key-mutation', 'signer', 'bad-signature', 'signer-mutation', 'descriptor-mutation', 'tool-mutation', 'verify']) {
  test(`post-preflight refusal retains evidence and never reports qualification: ${fault}`, async t => {
    const f = create(t, fault); await assert.rejects(f.writer.sign(f.inputs, f.services), error => error.message === w.FAILURE && !error.message.includes('PRIVATE SENTINEL'));
    assert.equal(fs.existsSync(path.join(f.output, w.RECEIPT)), false); assert.ok(f.counts.signatures <= 2);
  });
}
test('bad independent pin, hardlinked input, foreign file and redirected source all refuse without key selection', async t => {
  for (const fault of ['plan-pin', 'hardlink', 'extra', 'source']) {
    const f = create(t);
    if (fault === 'plan-pin') f.inputs.planSha256 = 'a'.repeat(64);
    if (fault === 'hardlink') fs.linkSync(f.zipFile, path.join(f.root, 'assembly-hardlink'));
    if (fault === 'extra') fs.writeFileSync(path.join(f.input, 'foreign.json'), '{}');
    if (fault === 'source') fs.appendFileSync(path.join(f.root, w.TOOL_SOURCES[0]), 'changed');
    await assert.rejects(f.writer.sign(f.inputs, f.services)); assert.deepEqual(f.counts, { keys: 0, signatures: 0 });
  }
});
test('output cannot be created inside immutable candidate input', async t => {
  const f = create(t); f.inputs.output = path.join(f.input, 'output');
  await assert.rejects(f.writer.sign(f.inputs, f.services)); assert.deepEqual(f.counts, { keys: 0, signatures: 0 });
  assert.equal(fs.existsSync(f.inputs.output), false);
});
test('offline Rust example retains separate modes, actual package/ELF pins, production key and tamper controls', () => {
  const body = fs.readFileSync(path.join(__dirname, '..', w.TOOL_SOURCES[0]), 'utf8');
  assert.match(body, /args\.len\(\) == 5 && args\[0\] == "inspect"/); assert.match(body, /args\.len\(\) == 6 && args\[0\] == "verify"/);
  assert.ok(body.indexOf('inspect(&deb, &raw, &manifest, &modules)?') < body.indexOf('verify(Path::new(&args[5]), &deb)?'));
  for (const value of ['efc71fb740ab87e2d8a3d8519cbe8fff38edaa6ee95f358e50b2eccc0f5f80fe',
    '97f19971eb1ab2e98767aa02f8ea6a585ca617ebef4380ec9e93195a15c779f0', '147d7847a1437adbd33d161029307eb32bc1e406482d8f93247822eb805c47cd']) assert.ok(body.includes(value));
  assert.match(body, /include_str!\("\.\.\/src\/catalog-key\.pub"\)/); assert.match(body, /catalog::verify_signed_target/);
  assert.match(body, /deny_unknown_fields/); assert.match(body, /d\.installer_protocol == 1/); assert.match(body, /d\.min_hub_version == FROM/);
  assert.match(body, /key\.verify\(bytes, &signature, false\)/); assert.match(body, /key\.verify\(&changed, &signature, false\)\.is_err\(\)/);
  assert.doesNotMatch(body, /Command::|process::Command|signingKey|signDetached/);
  for (const name of ['only_exact_private_descriptor_and_protocols_are_admitted', 'wrong_package_elf_and_tamper_refuse_without_signatures',
    'transform_only_changes_one_unique_bundle_marker', 'neither_mode_claims_native_or_release_acceptance']) assert.ok(body.includes(`fn ${name}()`));
});
