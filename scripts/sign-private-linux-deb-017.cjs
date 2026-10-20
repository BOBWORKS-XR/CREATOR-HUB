'use strict';
// Private 16 -> 17 inputs only. Signing is not update or publication acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const routing = require('./managed-router-package.cjs');
const { capture } = require('./sign-unix-payload.cjs');
const original = require('./assemble-unix-payload.cjs');
const assembly = require('./private-linux-update-fixture-017-assemble.cjs');
const metadata = require('./private-linux-update-fixture-017-metadata.cjs');
const provenance = require('./private-linux-update-fixture-017-provenance.cjs');
const portable = require('./private-linux-portable-fixture-017.cjs');
const base = require('./linux-016-portable-package.cjs');

const ROOT = path.resolve(__dirname, '..');
const PROFILE = 'private-linux-deb-update-017';
const FROM = '0.1.16', VERSION = '0.1.17';
const SOURCE = Object.freeze({ sourceCommit: '75a99ff4a267064aaa3ac9e30039bc91dc791d89', sourceTree: '5f62bf4bc1ba85eb293ca9a5a30330b06b6b4351' });
const ASSET = 'Creator_Hub_0.1.17_amd64-acceptance-only.deb';
const DESCRIPTOR = 'creator-hub-linux-x86_64-deb.json';
const URL = `https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v${VERSION}/${ASSET}`;
const PLATFORM = 'linux-x86_64-deb', RECEIPT = 'private-deb-qualification-receipt.json';
const META = 128 * 1024, MAX_FILE = 256 * 1024 * 1024;
const VERIFIER = 'src-tauri/target/release/examples/verify-package-input.exe';
const FIXTURE = 'src-tauri/target/release/examples/verify-private-linux-deb-017.exe';
const TOOL_SOURCES = ['src-tauri/examples/verify-private-linux-deb-017.rs', 'src-tauri/src/catalog-key.pub',
  'src-tauri/src/catalog.rs', 'src-tauri/src/update_target.rs', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock',
  'src-tauri/build.rs', 'src-tauri/tauri.conf.json'];
const SOURCE_LIMIT = 2 * 1024 * 1024;
const FLAGS = Object.freeze({ acceptanceOnly: true, nativeGuiAccepted: false, migrationAccepted: false,
  authenticationAccepted: false, signedUpdateAccepted: false, restartAccepted: false, releaseReady: false,
  privateModulesRecompiled: false, privateModulesResigned: false, rootRecompiled: false, applicationLaunched: false,
  approvedForStable: false, approvedForPrerelease: false });
const FAILURE = 'Private DEB017 preflight, signing or postverification failed. Owned partial evidence is retained; no native or release acceptance is granted.';
const record = bytes => ({ size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function keys(value, names) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); assert.deepEqual(Object.keys(value).sort(), [...names].sort()); }
function sha(value, length = 64) { assert.match(value, new RegExp(`^[a-f0-9]{${length}}$`)); }
function id(value) { assert.ok(Number.isSafeInteger(value) && value > 0); }
function pin(value, maximum = MAX_FILE) { keys(value, ['size', 'sha256']); id(value.size); sha(value.sha256); assert.ok(value.size <= maximum); }
function parse(bytes, limit = META) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= limit);
  const value = JSON.parse(bytes.toString('utf8')); assert.ok(bytes.equals(json(value)), 'Canonical private JSON required'); return value;
}
function validatePlan(p) {
  keys(p, ['schemaVersion', 'profile', 'producer', 'rootSource', 'files', 'signed017', 'tools']);
  assert.equal(p.schemaVersion, 1); assert.equal(p.profile, PROFILE); assert.deepEqual(p.rootSource, SOURCE);
  keys(p.producer, ['runId', 'runAttempt', 'jobId', 'workflowId', 'artifactId', 'zip']);
  for (const name of ['runId', 'runAttempt', 'jobId', 'workflowId', 'artifactId']) id(p.producer[name]); pin(p.producer.zip, base.LIMITS.zip);
  keys(p.files, Object.keys(portable.ROLES)); const seen = new Set();
  for (const [role, value] of Object.entries(p.files)) {
    keys(value, ['member', 'size', 'sha256']);
    pin({ size: value.size, sha256: value.sha256 }, role === 'manifest' ? 65536 : ['receipt', 'api', 'integrity', 'expected'].includes(role) ? 2 * 1024 * 1024 : MAX_FILE);
    assert.ok(base.relative(value.member) && path.posix.basename(value.member) === portable.ROLES[role]);
    assert.ok(!seen.has(value.member.toLowerCase())); seen.add(value.member.toLowerCase());
  }
  keys(p.signed017, ['planSha256']); sha(p.signed017.planSha256);
  keys(p.tools, ['metadata', 'fixture', 'sources']); pin(p.tools.metadata); pin(p.tools.fixture);
  keys(p.tools.sources, TOOL_SOURCES); for (const value of Object.values(p.tools.sources)) pin(value, SOURCE_LIMIT);
  return p;
}
function validateAPI(p, proof) {
  validatePlan(p); keys(proof, ['run', 'job', 'workflow', 'artifact', 'commit']);
  const a = p.producer, { run, job, workflow, artifact, commit } = proof;
  for (const [name, value] of Object.entries({ id: a.runId, run_attempt: a.runAttempt, head_sha: SOURCE.sourceCommit,
    head_branch: 'validation/linux-private-update-fixture-017', path: '.github/workflows/private-linux-update-fixture-017.yml',
    workflow_id: a.workflowId, event: 'workflow_dispatch', status: 'completed', conclusion: 'success' })) assert.equal(run[name], value);
  for (const repo of [run.repository, run.head_repository]) { assert.equal(repo.id, 1364807512); assert.equal(repo.full_name, 'BOBWORKS-XR/CREATOR-HUB'); }
  assert.equal(workflow.id, a.workflowId); assert.equal(workflow.path, run.path);
  assert.equal(commit.sha, SOURCE.sourceCommit); assert.equal(commit.tree.sha, SOURCE.sourceTree);
  for (const [name, value] of Object.entries({ id: a.jobId, run_id: a.runId, run_attempt: a.runAttempt, head_sha: SOURCE.sourceCommit,
    name: 'assemble', status: 'completed', conclusion: 'success' })) assert.equal(job[name], value);
  assert.ok(job.labels.includes('ubuntu-22.04'));
  for (const [name, value] of Object.entries({ id: a.artifactId, expired: false, size_in_bytes: a.zip.size,
    digest: `sha256:${a.zip.sha256}`, name: `private-linux-update-fixture-017-${a.runId}-${a.runAttempt}` })) assert.equal(artifact[name], value);
  for (const [name, value] of Object.entries({ id: a.runId, head_sha: SOURCE.sourceCommit, head_branch: run.head_branch,
    repository_id: 1364807512, head_repository_id: 1364807512 })) assert.equal(artifact.workflow_run[name], value);
  const [start, created, end] = [job.started_at, artifact.created_at, job.completed_at].map(Date.parse);
  assert.ok([start, created, end].every(Number.isFinite) && start <= created && created <= end);
}
async function fresh(p, request) {
  const a = p.producer, proof = { run: await request(`actions/runs/${a.runId}`), job: await request(`actions/jobs/${a.jobId}`),
    workflow: await request(`actions/workflows/${a.workflowId}`), artifact: await request(`actions/artifacts/${a.artifactId}`),
    commit: await request(`git/commits/${SOURCE.sourceCommit}`) };
  validateAPI(p, proof); return proof;
}
function descriptor(deb, installed) {
  pin(deb); pin(installed);
  return { schemaVersion: 1, appId: 'creator-hub', version: VERSION, platform: 'linux', architecture: 'x86_64',
    packageType: 'deb', assetName: ASSET, byteLength: deb.size, sha256: deb.sha256, executableSha256: installed.sha256,
    identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1, minHubVersion: FROM };
}
function latest(signature) {
  plain(signature);
  return { version: VERSION, notes: 'Private native qualification input only. Not release acceptance.', platforms: {
    [PLATFORM]: { url: URL, signature: signature.toString('base64') } } };
}
function plain(signature) {
  assert.ok(Buffer.isBuffer(signature) && signature.length > 0 && signature.length <= 4096
    && signature.toString('utf8').startsWith('untrusted comment:'), 'Bounded plain Minisign required');
}
function inspection(result, mode, p, installed) {
  const value = JSON.parse(result);
  keys(value, ['scope', 'mode', 'sourceVersion', 'targetVersion', 'deb', 'rawHub', 'installedHub', 'fullResourcesVerified', 'signaturesVerified', ...Object.keys(FLAGS)]);
  assert.equal(value.scope, PROFILE); assert.equal(value.mode, mode); assert.equal(value.sourceVersion, FROM); assert.equal(value.targetVersion, VERSION);
  assert.deepEqual(value.deb, { size: p.files.deb.size, sha256: p.files.deb.sha256 });
  assert.deepEqual(value.rawHub, { size: p.files.root.size, sha256: p.files.root.sha256 }); assert.deepEqual(value.installedHub, installed);
  assert.equal(value.fullResourcesVerified, true); assert.equal(value.signaturesVerified, mode === 'verify');
  for (const [name, expected] of Object.entries(FLAGS)) assert.equal(value[name], expected);
  return value;
}
async function sign({ input, plan: planFile, planSha256, output }, services = {}) {
  const root = services.root || ROOT, execute = services.execute || execFileSync, signer = services.signer || routing;
  try {
    assert.equal(services.platform || process.platform, 'win32', 'Fixed Windows offline verification tools required');
    for (const file of [root, input, planFile, output]) assembly.canonical(file, fs.existsSync(file));
    for (const file of [input, output]) assembly.inside(file, path.join(root, 'artifacts'));
    assembly.inside(planFile, path.dirname(root)); assert.equal(fs.existsSync(output), false, 'Immutable private output required');
    assert.ok(!planFile.startsWith(input + path.sep) && !planFile.startsWith(output + path.sep), 'Independent plan required'); sha(planSha256);
    assert.ok(!output.startsWith(input + path.sep) && !input.startsWith(output + path.sep), 'Input and output cannot overlap');
    const held = new Map(), identity = file => { const s = fs.lstatSync(file, { bigint: true }); return [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs, s.birthtimeNs]; };
    function remember(file, maximum, tool = false) {
      assembly.canonical(file); const before = identity(file), value = capture(file, maximum, tool);
      assert.deepEqual(identity(file), before); held.set(file, { record: value, identity: before, tool }); return value;
    }
    function unchanged(file) {
      const value = held.get(file); assert.ok(value); assembly.canonical(file); assert.deepEqual(identity(file), value.identity);
      assert.deepEqual(capture(file, value.record.size, value.tool), value.record); assert.deepEqual(identity(file), value.identity);
    }
    function bytes(file) { unchanged(file); const b = fs.readFileSync(file); assert.deepEqual(record(b), held.get(file).record); unchanged(file); return b; }
    function copy(source, target) {
      unchanged(source); assembly.canonical(target, false); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); assert.deepEqual(remember(target, held.get(source).record.size), held.get(source).record); unchanged(source);
    }
    function write(file, value) { fs.writeFileSync(file, value, { flag: 'wx', mode: 0o600 }); remember(file, value.length); }
    assert.equal(remember(planFile, META).sha256, planSha256);
    const plan = validatePlan(parse(bytes(planFile))), inputNames = ['assembly017.zip', ...metadata.INPUTS.map(name => `signed017/${name}`)];
    original.inventory(input, inputNames);
    assert.deepEqual(remember(path.join(input, 'assembly017.zip'), base.LIMITS.zip), plan.producer.zip);
    const accepted = assembly.inputs(path.join(input, 'signed017'), plan.signed017.planSha256); assert.deepEqual(accepted.plan.rootSource, SOURCE);
    for (const name of metadata.INPUTS) remember(accepted.files[name], accepted.records[name].size);
    const tools = { metadata: path.join(root, VERIFIER), fixture: path.join(root, FIXTURE) };
    for (const [name, file] of Object.entries(tools)) assert.deepEqual(remember(file, MAX_FILE, true), plan.tools[name]);
    for (const name of TOOL_SOURCES) assert.deepEqual(remember(path.join(root, name), SOURCE_LIMIT), plan.tools.sources[name]);
    const work = fs.mkdtempSync(path.join(root, 'artifacts/private-deb017-sign-work-')); fs.chmodSync(work, 0o700);
    const snapshot = path.join(work, 'signed017'); fs.mkdirSync(snapshot, { mode: 0o700 });
    for (const name of metadata.INPUTS) copy(accepted.files[name], path.join(snapshot, name));
    const signed = assembly.inputs(snapshot, plan.signed017.planSha256);
    const zip = path.join(work, 'assembly017.zip'); copy(path.join(input, 'assembly017.zip'), zip); copy(planFile, path.join(work, 'plan.json'));
    const staged = path.join(work, 'assembly'), outputNames = [];
    function recheck() {
      original.inventory(input, inputNames); original.inventory(snapshot, metadata.INPUTS);
      for (const file of held.keys()) unchanged(file); accepted.recheck(); signed.recheck();
      if (fs.existsSync(staged)) original.inventory(staged, Object.values(portable.ROLES));
      if (fs.existsSync(output)) original.inventory(output, outputNames);
    }
    function run(program, args, options = {}) {
      recheck(); const result = execute(program, args, { encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 65536, ...options }); recheck(); return String(result ?? '').trim();
    }
    const pins = Object.fromEntries(Object.values(plan.files).map(({ member, size, sha256 }) => [member, { size, sha256 }]));
    run('python', ['-B', '-c', base.ZIP_STAGE, zip, staged], { input: JSON.stringify({ pins, allowed: Object.keys(pins),
      outputs: Object.fromEntries(Object.entries(plan.files).map(([role, value]) => [value.member, portable.ROLES[role]])) }) });
    const files = Object.fromEntries(Object.entries(portable.ROLES).map(([role, name]) => [role, path.join(staged, name)]));
    for (const [role, file] of Object.entries(files)) assert.deepEqual(remember(file, plan.files[role].size), { size: plan.files[role].size, sha256: plan.files[role].sha256 });
    const checked = portable.validateAssembly({ assembly017: { files: plan.files } }, Object.fromEntries(Object.entries(files).map(([role, file]) => [role, bytes(file)])), signed);
    metadata.verifySignatures(signed.files, signed.records, tools.metadata, run);
    const request = services.request || provenance.api;
    recheck(); const api = await fresh(plan, request), lineage = await provenance.fresh({ plan: signed.plan, handoff: signed.handoff, preparedFile: signed.files['prepared-unix.json'] }, request); recheck();
    const installed = checked.receipt.packagedHub;
    const nativeArgs = [files.deb, files.root, files.manifest, files.archive];
    inspection(run(tools.fixture, ['inspect', ...nativeArgs]), 'inspect', plan, installed);
    const desc = json(descriptor(held.get(files.deb).record, installed)); assert.ok(desc.length <= META); recheck();
    fs.mkdirSync(output, { mode: 0o700 });
    const descFile = path.join(output, DESCRIPTOR), packageFile = path.join(output, ASSET);
    copy(files.deb, packageFile); outputNames.push(ASSET); write(descFile, desc); outputNames.push(DESCRIPTOR);
    copy(planFile, path.join(output, 'plan.json')); outputNames.push('plan.json');
    const proof = json({ producer: api, lineage }); assert.ok(proof.length <= 2 * 1024 * 1024);
    write(path.join(output, 'fresh-api.json'), proof); outputNames.push('fresh-api.json'); recheck();
    // Only the existing protected helper may select/access the key, after every preflight gate.
    const key = signer.signingKey(root); recheck();
    const authorized = [descFile, packageFile], signatures = {};
    for (const [index, body] of authorized.entries()) {
      recheck(); const temporary = path.join(work, index === 0 ? 'authorized-descriptor.json' : ASSET); copy(body, temporary);
      const signature = signer.signDetached(temporary, key); plain(signature); recheck();
      const signatureFile = `${body}.minisig`; write(signatureFile, signature); outputNames.push(path.basename(signatureFile));
      signatures[path.basename(signatureFile)] = held.get(signatureFile).record;
      if (index === 0) assert.equal(run(tools.metadata, [body, signatureFile]), `Verified trusted package signature: ${record(desc).sha256}. No activation or client changes.`);
    }
    const packageSignature = bytes(`${packageFile}.minisig`), latestFile = path.join(output, 'latest.json');
    write(latestFile, json(latest(packageSignature))); outputNames.push('latest.json');
    const final = inspection(run(tools.fixture, ['verify', ...nativeArgs, output]), 'verify', plan, installed);
    assert.ok(bytes(packageFile).equals(bytes(files.deb))); assert.ok(bytes(descFile).equals(desc)); recheck();
    const receipt = { schemaVersion: 1, profile: PROFILE, sourceVersion: FROM, targetVersion: VERSION, planSha256,
      producer: plan.producer, rootSource: SOURCE, descriptor: held.get(descFile).record, installer: held.get(packageFile).record,
      installedHub: installed, latest: held.get(latestFile).record, signatures, authorizedBodiesSigned: 2, privateKeyIncluded: false,
      offlineInputsVerified: final.signaturesVerified, ...FLAGS };
    write(path.join(output, RECEIPT), json(receipt)); outputNames.push(RECEIPT); recheck();
    return { output, profile: PROFILE, planSha256, authorizedBodiesSigned: 2, privateKeyIncluded: false, ...FLAGS };
  } catch (_) { throw Error(FAILURE); }
}
function cli(args) {
  assert.equal(args.length, 8); assert.deepEqual(args.filter((_, index) => index % 2 === 0), ['--input', '--plan', '--plan-sha256', '--output']);
  return { input: args[1], plan: args[3], planSha256: args[5], output: args[7] };
}
module.exports = { PROFILE, FROM, VERSION, SOURCE, ASSET, DESCRIPTOR, URL, PLATFORM, RECEIPT, FLAGS, FAILURE, VERIFIER, FIXTURE, TOOL_SOURCES,
  record, json, parse, validatePlan, validateAPI, fresh, descriptor, latest, inspection, sign, cli };
if (require.main === module) Promise.resolve().then(() => sign(cli(process.argv.slice(2))))
  .then(result => console.log(JSON.stringify(result))).catch(() => { console.error(FAILURE); process.exitCode = 1; });
