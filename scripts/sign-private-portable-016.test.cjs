'use strict';
// Synthetic ZIPs, ELF headers, API replies and signatures only. No key exists.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const c = require('./private-portable-016-contract.cjs');
const w = require('./sign-private-portable-016.cjs');
const base = require('./linux-016-portable-package.cjs');
const production = base.production016();
const retirement = require('./linux-retirement-package.cjs');
const { fixture } = require('./fixtures/unix-payload-binding.cjs');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const signature = bytes => Buffer.from(`untrusted comment: Synthetic private portable016 ${c.hash(bytes)}`);
function elf() { const b = Buffer.alloc(64); b.set([127, 69, 76, 70, 2, 1, 1]); b.writeUInt16LE(3, 16); b.writeUInt16LE(62, 18); return b; }
function tar(contents) {
  const entries = { usr: { kind: 'directory', mode: 0o755 }, 'usr/bin': { kind: 'directory', mode: 0o755 } };
  if (contents[production.SELECTOR_ENTRYPOINT]) entries['usr/libexec'] = { kind: 'directory', mode: 0o755 };
  for (const [name, bytes] of Object.entries(contents)) {
    for (let dir = path.posix.dirname(name); dir !== '.'; dir = path.posix.dirname(dir)) entries[dir] = { kind: 'directory', mode: 0o755 };
    entries[name] = { kind: 'file', ...c.record(bytes), mode: [base.HOST_PROFILE, 'usr/lib/Creator Hub/modules.tar.gz'].includes(name) ? 0o644 : 0o755 };
  }
  const blocks = []; let unpackedSize = 0;
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  for (const [name, entry] of Object.entries(sorted)) {
    blocks.push(base.tarHeader(name, entry));
    if (entry.kind === 'file') { blocks.push(contents[name], Buffer.alloc((512 - entry.size % 512) % 512)); unpackedSize += entry.size; }
  }
  blocks.push(Buffer.alloc(1024)); const raw = Buffer.concat(blocks), archive = zlib.gzipSync(raw, { level: 9 });
  return { raw, archive, inventory: { entries: sorted, links: {}, unpackedSize } };
}
function create(t, fault = '') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portable016-sign-unit-')));
  t.after(() => { assert.equal(fs.realpathSync(root), root); assert.ok(path.basename(root).startsWith('portable016-sign-unit-')); fs.rmSync(root, { recursive: true, force: true }); });
  const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  const rawRoot = Buffer.concat([elf(), Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK\n' + require('./build-unified.cjs').PORTABLE_ROOT_WITNESSES.join('\n'))]);
  const appRoot = Buffer.from(rawRoot); appRoot.write('APP', appRoot.indexOf('__TAURI_BUNDLE_TYPE_VAR_UNK') + '__TAURI_BUNDLE_TYPE_VAR_UNK'.length - 3, 'ascii');
  const host = c.json({ schemaVersion: 1, version: c.VERSION, activationInterface: 'com.creatorworks.hub.Host1',
    integratedFeatures: true, startupImageBinding: 1, executableSha256: c.hash(appRoot) });
  const modules = Buffer.from('synthetic original modules.tar.gz');
  const original = tar({ AppRun: Buffer.from('#!/bin/sh\nexec "$APPDIR/usr/bin/creator-hub" "$@"\n'), 'usr/bin/creator-hub': appRoot, 'usr/lib/Creator Hub/modules.tar.gz': modules });
  const transport = tar({ AppRun: Buffer.from('#!/bin/sh\nexec "$APPDIR/usr/bin/creator-hub" "$@"\n'), 'usr/bin/creator-hub': appRoot,
    'usr/lib/Creator Hub/modules.tar.gz': modules, [base.HOST_PROFILE]: host, [production.SELECTOR_ENTRYPOINT]: elf() });
  const manifest = { schemaVersion: 1, appId: 'creator-hub', platform: 'linux', architecture: 'x86_64', version: c.VERSION,
    sourceCommit: 'd'.repeat(40), sourceTree: 'e'.repeat(40), format: 'appdir-tar-gzip-v1', entrypoint: 'usr/bin/creator-hub',
    archive: { ...c.record(transport.archive), unpackedSize: transport.inventory.unpackedSize }, entries: transport.inventory.entries };
  const privateProof = fixture(); privateProof.expected.version = privateProof.prepared.hubVersion = c.VERSION;
  privateProof.artifactSize = privateProof.artifact.size_in_bytes; privateProof.jobId = 303; privateProof.jobs[0].id = 303;
  privateProof.jobs[0].head_sha = privateProof.expected.sourceCommit; privateProof.job = structuredClone(privateProof.jobs[0]);
  privateProof.run.head_branch = 'validation/unix-payload-016';
  const pins = { schemaVersion: 2, profile: production.PROFILE, sourceCommit: manifest.sourceCommit, sourceTree: manifest.sourceTree,
    runId: 9001, runAttempt: 2, jobId: 9002, workflowId: 9003, artifactId: 9004, receiptsArtifactId: 9005,
    artifact: { size: 1234, sha256: 'f'.repeat(64) }, receiptsArtifact: { size: 4321, sha256: 'a'.repeat(64) }, handoffSha256: 'b'.repeat(64), files: {} };
  for (const name of [...production.INPUTS, ...production.RECEIPTS]) pins.files[name] = c.record(Buffer.from(`synthetic original ${name}`));
  pins.files['creator-hub'] = c.record(rawRoot);
  const repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' };
  const proof = { run: { id: 9001, run_attempt: 2, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: pins.sourceCommit,
    head_branch: 'validation/linux-integrated-candidate-016', path: '.github/workflows/unix-managed-assembly.yml', workflow_id: 9003, repository: repo, head_repository: repo },
    job: { id: 9002, run_id: 9001, run_attempt: 2, head_sha: pins.sourceCommit, status: 'completed', conclusion: 'success',
      name: 'assembly (linux, ubuntu-22.04, synthetic)', labels: ['ubuntu-22.04'], started_at: '2026-10-20T10:00:00Z', completed_at: '2026-10-20T10:10:00Z' },
    workflow: { id: 9003, path: '.github/workflows/unix-managed-assembly.yml' }, commit: { sha: pins.sourceCommit, tree: { sha: pins.sourceTree } } };
  for (const [field, id, name, pin] of [['artifact', 9004, 'signed-unix-hub-linux-9001-2', pins.artifact], ['receiptsArtifact', 9005, 'signed-linux-receipts-9001-2', pins.receiptsArtifact]]) {
    proof[field] = { id, name, expired: false, size_in_bytes: pin.size, digest: `sha256:${pin.sha256}`, created_at: '2026-10-20T10:09:00Z',
      workflow_run: { id: 9001, head_sha: pins.sourceCommit, head_branch: proof.run.head_branch, repository_id: repo.id, head_repository_id: repo.id } };
  }
  const sources = Object.fromEntries(['native/linux-portable-deployment/Cargo.toml', 'native/linux-portable-deployment/Cargo.lock',
    'native/linux-portable-deployment/src/bin/creator-hub-portable-selector.rs', 'src-tauri/src/catalog-key.pub'].map(name => [name, c.record(Buffer.from(`synthetic source ${name}`))]));
  const receipt = { schemaVersion: 2, scope: 'unsigned-linux-016-production-portable-packaging-only', packagingCompleted: true,
    packagingSource: 'f'.repeat(40), producer: { pins, proof, privateProof }, rootRecompiled: false, privatePayloadChanged: false,
    payloadResigned: false, applicationLaunched: false, updateAcceptanceTested: false, ...base.flags(), archive: manifest.archive,
    manifest: c.record(c.json(manifest)), flattenedLinks: {}, appImage: c.record(elf()),
    nativeSupportAlias: { ordinaryName: c.IMAGE, nativeSupportName: c.ALIAS, ...c.record(elf()), identicalBytes: true, sourceIdentityRechecked: true,
      role: 'restricted-setup-screen-intent-only', nativeExecution: false, releaseReady: false },
    portableHostProfile: { path: base.HOST_PROFILE, ...c.record(host), executable: c.record(appRoot), rawExecutable: c.record(rawRoot),
      compiledFeatures: [...production.FEATURES], scope: 'canonical-appdir-transport-only', appImageContainsProfile: false },
    productionDeb: { profile: retirement.PRODUCTION_PROFILE, nativeExecution: false, releaseReady: false, package: pins.files[production.DEB_MEMBER], files: {
      [retirement.HELPER]: { ...c.record(elf()), mode: 0o755, uid: 0, gid: 0 }, [retirement.POLICY]: { ...c.record(Buffer.from('synthetic policy')), mode: 0o644, uid: 0, gid: 0 },
      [retirement.SERVICE]: { ...c.record(retirement.SERVICE_BYTES), mode: 0o644, uid: 0, gid: 0 } } },
    selectorBuild: { schemaVersion: 1, sourceCommit: pins.sourceCommit, sourceTree: pins.sourceTree, sources, publicKeySource: sources['src-tauri/src/catalog-key.pub'],
      target: production.TARGET, features: ['experimental-restart'], toolchain: production.SELECTOR_TOOLCHAIN,
      compiler: 'rustc 1.99.0 (synthetic)\nhost: x86_64-unknown-linux-gnu\n', cargo: 'cargo 1.99.0 (synthetic)',
      toolFiles: Object.fromEntries(['rustc', 'cargo'].map(name => [name, { path: `/opt/tools/${name}`, ...c.record(Buffer.from(name)) }])),
      arguments: ['build', '--release', '--locked', '--no-default-features', '--manifest-path', '/tmp/packaging/selector-source/native/linux-portable-deployment/Cargo.toml',
        '--bin', 'creator-hub-portable-selector', '--features', 'experimental-restart', '--target', production.TARGET, '--target-dir', '/tmp/packaging/selector-target'],
      executable: c.record(elf()), rootRecompiled: false, privateModulesRecompiled: false, nativeExecution: false, releaseReady: false } };
  const debRoot = Buffer.from(rawRoot); debRoot.write('DEB', debRoot.indexOf('__TAURI_BUNDLE_TYPE_VAR_UNK') + '__TAURI_BUNDLE_TYPE_VAR_UNK'.length - 3, 'ascii');
  receipt.productionDeb.packageFiles = { 'usr/bin/creator-hub': { ...c.record(debRoot), mode: 0o755 },
    'usr/lib/Creator Hub/modules.tar.gz': { ...c.record(modules), mode: 0o644 },
    ...Object.fromEntries(Object.entries(receipt.productionDeb.files).map(([name, file]) => [name.slice(1), { size: file.size, sha256: file.sha256, mode: file.mode }])) };
  const bodies = { 'package-receipt.json': c.json(receipt), [c.IMAGE]: elf(), [c.ALIAS]: elf(), [c.UNSIGNED]: c.json(manifest), [c.ARCHIVE]: transport.archive,
    'appdir-original-inventory.json': c.json(original.inventory), 'appdir-flattened-inventory.json': c.json(transport.inventory) };
  const verifier = put(path.join(root, w.VERIFIER), 'Synthetic fixed verifier, never executed.');
  const plan = { schemaVersion: 1, profile: c.PROFILE, producer: { sourceCommit: receipt.packagingSource, sourceTree: 'c'.repeat(40), runId: 9101,
    runAttempt: 1, jobId: 9102, workflowId: 9103, artifactId: 9104, zip: {} }, rootSource: { sourceCommit: pins.sourceCommit, sourceTree: pins.sourceTree, rawHub: c.record(rawRoot) },
    selectorSources: structuredClone(sources), files: {}, verifier: c.record(fs.readFileSync(verifier)) };
  const input = path.join(root, 'artifacts/input/producer.zip'), planFile = path.join(root, 'independent-plan.json');
  const inputs = { input, plan: planFile, planSha256: '', output: path.join(root, 'artifacts/private-signed') };
  function save(extra = {}) {
    bodies['package-receipt.json'] = c.json(receipt);
    plan.files = Object.fromEntries(c.FILES.map(name => [name, c.record(bodies[name])]));
    const archive = execFileSync(PYTHON, ['-B', '-c', 'import base64,io,json,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,"w",compression=zipfile.ZIP_DEFLATED); [z.writestr(n,base64.b64decode(v)) for n,v in json.load(sys.stdin).items()]; z.close(); sys.stdout.buffer.write(b.getvalue())'],
      { input: JSON.stringify(Object.fromEntries(Object.entries({ ...bodies, ...extra }).map(([name, bytes]) => [name, bytes.toString('base64')]))) });
    put(input, archive); plan.producer.zip = c.record(archive); put(planFile, c.json(plan)); inputs.planSha256 = c.hash(c.json(plan));
  }
  save();
  const requests = [], calls = [], counts = { keys: 0, signatures: 0 }, key = path.join(root, 'NO-KEY-EXISTS');
  async function request(route) {
    requests.push(route); const p = plan.producer;
    const packaging = { run: { id: p.runId, run_attempt: p.runAttempt, head_sha: p.sourceCommit, head_branch: production.BRANCH.slice(11), path: production.WORKFLOW,
      workflow_id: p.workflowId, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', repository: repo, head_repository: repo },
      job: { id: p.jobId, run_id: p.runId, run_attempt: p.runAttempt, head_sha: p.sourceCommit, name: 'package', labels: ['ubuntu-22.04'],
        status: 'completed', conclusion: 'success', started_at: '2026-10-20T11:00:00Z', completed_at: '2026-10-20T11:10:00Z' },
      workflow: { id: p.workflowId, path: production.WORKFLOW }, commit: { sha: p.sourceCommit, tree: { sha: p.sourceTree } },
      artifact: { id: p.artifactId, name: `linux-016-production-portable-unsigned-${p.runId}-${p.runAttempt}`, expired: false, size_in_bytes: p.zip.size,
        digest: `sha256:${p.zip.sha256}`, created_at: '2026-10-20T11:09:00Z', workflow_run: { id: p.runId, head_sha: p.sourceCommit,
          head_branch: production.BRANCH.slice(11), repository_id: repo.id, head_repository_id: repo.id } } };
    const map = new Map([[`actions/runs/${p.runId}`, packaging.run], [`actions/jobs/${p.jobId}`, packaging.job], [`actions/workflows/${p.workflowId}`, packaging.workflow],
      [`actions/artifacts/${p.artifactId}`, packaging.artifact], [`git/commits/${p.sourceCommit}`, packaging.commit],
      [`actions/runs/${pins.runId}`, proof.run], [`actions/jobs/${pins.jobId}`, proof.job], [`actions/workflows/${pins.workflowId}`, proof.workflow],
      [`actions/artifacts/${pins.artifactId}`, proof.artifact], [`actions/artifacts/${pins.receiptsArtifactId}`, proof.receiptsArtifact], [`git/commits/${pins.sourceCommit}`, proof.commit],
      [`actions/runs/${privateProof.expected.runId}`, privateProof.run], [`actions/jobs/${privateProof.jobId}`, privateProof.job], [`actions/artifacts/${privateProof.expected.artifactId}`, privateProof.artifact],
      [`git/commits/${privateProof.expected.sourceCommit}`, privateProof.commit], [`actions/runs/${privateProof.expected.runId}/attempts/${privateProof.expected.runAttempt}/jobs?per_page=100`,
        { total_count: privateProof.jobs.length, jobs: privateProof.jobs }]]);
    assert.ok(map.has(route), `Unexpected API route ${route}`); const value = structuredClone(map.get(route));
    if (fault === 'running' && route === `actions/runs/${p.runId}`) value.status = 'in_progress';
    if (fault === 'wrong-job' && route === `actions/jobs/${p.jobId}`) value.run_attempt++;
    if (fault === 'wrong-artifact' && route === `actions/artifacts/${p.artifactId}`) value.digest = `sha256:${'0'.repeat(64)}`;
    if (fault === 'wrong-source' && route === `git/commits/${p.sourceCommit}`) value.tree.sha = '0'.repeat(40);
    if (fault === 'original-api' && route === `actions/runs/${pins.runId}`) value.conclusion = 'failure';
    if (fault === 'private-api' && route === `actions/jobs/${privateProof.jobId}`) value.head_sha = '0'.repeat(40);
    if (fault === 'api-drift') fs.appendFileSync(input, 'changed during API');
    if (fault === 'api-replacement') { const bytes = fs.readFileSync(input); fs.renameSync(input, `${input}.kept`); fs.writeFileSync(input, bytes); }
    return value;
  }
  function execute(program, args, options) {
    calls.push({ program, args });
    if (program === verifier) {
      const bytes = fs.readFileSync(args[0]); assert.ok(fs.readFileSync(args[1]).equals(signature(bytes)), 'Mock production key refused');
      if (fault === 'postverify') fs.appendFileSync(path.join(inputs.output, c.ARCHIVE), 'changed after verification');
      return `Verified trusted package signature: ${c.hash(bytes)}. No activation or client changes.`;
    }
    assert.equal(program, 'python'); assert.deepEqual(args.slice(0, 3), ['-B', '-c', base.ZIP_STAGE]);
    return execFileSync(PYTHON, args, { ...options, stdio: 'pipe' });
  }
  const signer = { signingKey(selected) {
    assert.equal(selected, root); counts.keys++; assert.equal(fs.existsSync(key), false);
    if (fault === 'key') throw Error('PRIVATE SENTINEL'); return key;
  }, signDetached(file, selected) {
    assert.equal(selected, key); assert.equal(fs.existsSync(key), false); counts.signatures++;
    assert.ok(file.includes('private-portable016-sign-work-')); assert.ok(!file.startsWith(inputs.output + path.sep));
    const bytes = fs.readFileSync(file), result = signature(bytes);
    if (fault === 'sign' || fault === 'second-sign' && counts.signatures === 2) throw Error('PRIVATE SENTINEL');
    if (fault === 'temporary-drift') fs.appendFileSync(file, 'changed');
    if (fault === 'input-drift') fs.appendFileSync(input, 'changed');
    if (fault === 'plan-drift') fs.appendFileSync(planFile, 'changed');
    if (fault === 'tool-drift') fs.appendFileSync(verifier, 'changed');
    if (fault === 'output-drift') fs.appendFileSync(path.join(inputs.output, c.MANIFEST), 'changed');
    if (fault === 'snapshot-drift') fs.appendFileSync(path.join(path.dirname(file), 'producer', c.ALIAS), 'changed');
    put(`${file}.sig`, result.toString('base64'));
    return fault === 'signature' ? Buffer.from('invalid') : fault === 'signature-size' ? Buffer.alloc(4097) : result;
  } };
  return { root, inputs, plan, receipt, bodies, manifest, transport, verifier, put, save, requests, calls, counts,
    services: { root, platform: 'win32', execute, request, signer } };
}

test('private portable016 signs exact manifest then Root-shaped descriptor using only the mocked existing signer', async t => {
  const f = create(t), result = await w.sign(f.inputs, f.services);
  assert.deepEqual(f.counts, { keys: 1, signatures: 2 }); assert.equal(result.acceptanceOnly, true);
  for (const name of Object.keys(c.FLAGS)) assert.equal(result[name], false);
  for (const name of c.FILES) assert.ok(fs.readFileSync(path.join(f.inputs.output, name === c.UNSIGNED ? c.MANIFEST : name)).equals(f.bodies[name]));
  const d = JSON.parse(fs.readFileSync(path.join(f.inputs.output, c.DESCRIPTOR)));
  assert.deepEqual(Object.keys(d), ['schemaVersion', 'appId', 'version', 'platform', 'architecture', 'packageType', 'manifest', 'archive', 'executableSha256', 'restartProtocol', 'minHubVersion']);
  assert.equal(d.version, '0.1.16'); assert.equal(d.minHubVersion, '0.1.16'); assert.equal(d.packageType, 'portable-appdir');
  assert.equal(d.executableSha256, f.manifest.entries['usr/bin/creator-hub'].sha256);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.inputs.output, w.RECEIPT)));
  assert.equal(receipt.acceptanceOnly, true); assert.equal(receipt.authorizedBodiesSigned, 2); assert.equal(receipt.privateKeyIncluded, false);
  assert.equal(Object.hasOwn(receipt, 'approvedForStable'), false);
  for (const name of Object.keys(c.FLAGS)) assert.equal(receipt[name], false);
  assert.equal(f.calls.filter(call => call.program === f.verifier).length, 4);
  const work = fs.readdirSync(path.join(f.root, 'artifacts')).find(name => name.startsWith('private-portable016-sign-work-'));
  assert.ok(fs.readFileSync(path.join(f.root, 'artifacts', work, 'signing-input-0.json')).equals(f.bodies[c.UNSIGNED]));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'artifacts', work, 'signing-input-1.json'))), d);
  assert.equal(fs.existsSync(path.join(f.inputs.output, `${c.MANIFEST}.sig`)), false);
  await assert.rejects(w.sign(f.inputs, f.services), error => error.message === w.FAILURE); assert.deepEqual(f.counts, { keys: 1, signatures: 2 });
});
test('only the fixed Cargo-built verifier may remain hardlinked while candidate snapshots stay single-link', async t => {
  const f = create(t); fs.linkSync(f.verifier, path.join(f.root, 'verifier-cargo-deps'));
  const before = fs.lstatSync(f.verifier, { bigint: true }); await w.sign(f.inputs, f.services);
  const after = fs.lstatSync(f.verifier, { bigint: true });
  for (const field of ['dev', 'ino', 'mode', 'size', 'nlink', 'mtimeNs', 'ctimeNs']) assert.equal(after[field], before[field]);
  assert.equal(after.nlink, 2n); assert.deepEqual(f.counts, { keys: 1, signatures: 2 });
});
for (const fault of ['running', 'wrong-job', 'wrong-artifact', 'wrong-source', 'original-api', 'private-api', 'api-drift', 'api-replacement']) {
  test(`${fault} refuses before key selection or signed output`, async t => {
    const f = create(t, fault); await assert.rejects(w.sign(f.inputs, f.services), error => error.message === w.FAILURE);
    assert.deepEqual(f.counts, { keys: 0, signatures: 0 }); assert.equal(fs.existsSync(f.inputs.output), false);
  });
}
for (const change of ['receipt-accepted', 'prototype', 'selector-source', 'selector-key', 'selector-flags', 'root-profile', 'raw-root', 'modules-binding', 'deb-root-binding', 'alias', 'zip-extra']) {
  test(`${change} rejects a freshly repinned but invalid producer contract before key selection`, async t => {
    const f = create(t);
    if (change === 'receipt-accepted') f.receipt.releaseReady = true;
    if (change === 'prototype') f.receipt.scope = 'unsigned-linux-016-portable-packaging-only';
    if (change === 'selector-source') f.receipt.selectorBuild.sourceTree = '0'.repeat(40);
    if (change === 'selector-key') f.receipt.selectorBuild.publicKeySource.sha256 = '0'.repeat(64);
    if (change === 'selector-flags') f.receipt.selectorBuild.arguments[9] = 'default';
    if (change === 'root-profile') f.receipt.portableHostProfile.appImageContainsProfile = true;
    if (change === 'raw-root') f.plan.rootSource.rawHub.sha256 = '0'.repeat(64);
    if (change === 'modules-binding') f.receipt.producer.pins.files['modules.tar.gz'].sha256 = '0'.repeat(64);
    if (change === 'deb-root-binding') f.receipt.productionDeb.packageFiles['usr/bin/creator-hub'].sha256 = '0'.repeat(64);
    if (change === 'alias') f.bodies[c.ALIAS] = Buffer.concat([elf(), Buffer.from('different')]);
    f.save(change === 'zip-extra' ? { extra: Buffer.from('refused') } : {});
    await assert.rejects(w.sign(f.inputs, f.services)); assert.deepEqual(f.counts, { keys: 0, signatures: 0 });
  });
}
test('fixed verifier bound, independent plan hash, original ZIP and hardlinked input fail before signing', async t => {
  for (const change of ['oversize', 'plan-hash', 'zip', 'hardlink', 'verifier']) {
    const f = create(t);
    if (change === 'oversize') { f.plan.files[c.UNSIGNED].size = c.SIGNED_META + 1; f.put(f.inputs.plan, c.json(f.plan)); f.inputs.planSha256 = c.hash(c.json(f.plan)); }
    if (change === 'plan-hash') f.inputs.planSha256 = '0'.repeat(64);
    if (change === 'zip') fs.appendFileSync(f.inputs.input, 'changed');
    if (change === 'hardlink') fs.linkSync(f.inputs.input, path.join(f.root, 'linked-zip'));
    if (change === 'verifier') fs.appendFileSync(f.verifier, 'changed');
    await assert.rejects(w.sign(f.inputs, f.services), error => error.message === (change === 'oversize' ? w.OVERSIZE : w.FAILURE));
    assert.deepEqual(f.counts, { keys: 0, signatures: 0 }); assert.equal(f.requests.length, 0);
  }
});
for (const fault of ['key', 'sign', 'second-sign', 'signature', 'signature-size', 'temporary-drift', 'input-drift', 'plan-drift', 'tool-drift', 'output-drift', 'snapshot-drift', 'postverify']) {
  test(`${fault} retains partial evidence and withholds all signing diagnostics`, async t => {
    const f = create(t, fault); await assert.rejects(w.sign(f.inputs, f.services), error => error.message === w.FAILURE && !error.message.includes('PRIVATE SENTINEL'));
    assert.equal(f.counts.keys, 1); assert.ok(f.counts.signatures <= 2); assert.equal(fs.existsSync(f.inputs.output), true);
    assert.equal(fs.existsSync(path.join(f.inputs.output, w.RECEIPT)), false);
    const original = fs.readFileSync(path.join(f.inputs.output, c.MANIFEST));
    await assert.rejects(w.sign(f.inputs, f.services)); assert.ok(fs.readFileSync(path.join(f.inputs.output, c.MANIFEST)).equals(original));
  });
}
test('actual bounded gzip/USTAR validation refuses concatenation, trailing bytes, changed headers/members and missing padding', t => {
  const f = create(t); c.archiveContents(f.transport.archive, f.manifest);
  const variants = [Buffer.concat([f.transport.archive, zlib.gzipSync(Buffer.alloc(0))]), Buffer.concat([f.transport.archive, Buffer.from('trailing')])];
  for (const kind of ['header', 'data', 'truncated', 'padding']) {
    const raw = Buffer.from(f.transport.raw);
    if (kind === 'header') raw[156] = 50;
    if (kind === 'data') raw[512] ^= 1;
    if (kind === 'padding') raw[raw.length - 1] = 1;
    variants.push(zlib.gzipSync(kind === 'truncated' ? raw.subarray(0, raw.length - 1) : raw));
  }
  for (const bytes of variants) assert.throws(() => c.archiveContents(bytes, { ...f.manifest, archive: { ...c.record(bytes), unpackedSize: f.manifest.archive.unpackedSize } }));
});
test('CLI has only four fixed selectors, no key/tool/policy overrides, and public eligibility is untouched', () => {
  assert.deepEqual(w.cli(['--input', 'zip', '--plan', 'plan', '--plan-sha256', 'hash', '--output', 'new']), { input: 'zip', plan: 'plan', planSha256: 'hash', output: 'new' });
  for (const args of [[], ['--input', 'zip', '--plan', 'plan', '--verifier', 'tool', '--output', 'new']]) assert.throws(() => w.cli(args));
  assert.equal(w.sign.toString().includes('process.env'), false);
  const publicHelper = require('./portable-release-descriptor.cjs'); assert.equal(publicHelper.CHECKS.length, 13);
  assert.ok(publicHelper.descriptor.toString().includes('receipt.approvedForStable, true'));
});
