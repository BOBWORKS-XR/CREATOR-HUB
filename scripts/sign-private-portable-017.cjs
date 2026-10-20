'use strict';
// Existing protected signer, exactly two017 metadata bodies; never candidate execution.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const c = require('./private-portable-017-contract.cjs');
const lane = require('./private-linux-portable-fixture-017.cjs');
const base = require('./linux-016-portable-package.cjs');
const old = require('./private-portable-016-contract.cjs');
const oldWriter = require('./sign-private-portable-016.cjs');
const assembly = require('./private-linux-update-fixture-017-assemble.cjs');
const metadata = require('./private-linux-update-fixture-017-metadata.cjs');
const provenance = require('./private-linux-update-fixture-017-provenance.cjs');
const routing = require('./managed-router-package.cjs');
const { capture } = require('./sign-unix-payload.cjs');
const moduleArchive = require('./module-archive.cjs');

const ROOT = path.resolve(__dirname, '..');
const VERIFIER = 'src-tauri/target/release/examples/verify-package-input.exe';
const DECODER = 'native/module-archive/target/release/creator-hub-module-archive.exe';
const DECODER_CRATE_SOURCES = ['native/module-archive/Cargo.toml', 'native/module-archive/Cargo.lock', 'native/module-archive/src/main.rs'];
const DECODER_SOURCES = [...DECODER_CRATE_SOURCES, 'src-tauri/src/module_archive.rs'];
const PUBLIC_KEY = 'src-tauri/src/catalog-key.pub';
const RECEIPT = 'private017-qualification-receipt.json';
const FAILURE = 'Private portable017 preflight, signing or postverification failed. Partial owned evidence is retained; no final016/native qualification or publication is accepted.';
const { absolute, inside } = oldWriter;
function inventory(root, names) {
  absolute(root); const found = [], directories = new Set();
  for (const name of names) for (let dir = path.posix.dirname(name); dir !== '.'; dir = path.posix.dirname(dir)) directories.add(dir);
  function walk(dir, prefix = '') {
    assert.ok(fs.lstatSync(dir).isDirectory());
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + item.name, file = path.join(dir, item.name); absolute(file);
      if (item.isDirectory()) { assert.ok(directories.has(name), 'Unknown evidence directory'); walk(file, `${name}/`); }
      else { const s = fs.lstatSync(file); assert.ok(s.isFile() && s.nlink === 1); found.push(name); }
    }
  }
  walk(root); assert.deepEqual(found.sort(), [...names].sort(), 'Exact read-only evidence inventory required');
}
async function bind(expected, request) {
  return { run: await request(`actions/runs/${expected.runId}`), job: await request(`actions/jobs/${expected.jobId}`),
    workflow: await request(`actions/workflows/${expected.workflowId}`), artifact: await request(`actions/artifacts/${expected.artifactId}`),
    commit: await request(`git/commits/${expected.sourceCommit}`) };
}
async function fresh(p, signed, previous, request) {
  const packaging = await bind(p.producer, request); c.validateAPI(p, packaging);
  const actualAssembly = await lane.collect(p.inputProfile, request);
  const a = p.carriers.signed016, signed016 = await bind(a, request);
  c.apiProof(a, signed016, { branch: 'validation/private-portable-016-carrier', workflow: '.github/workflows/private-portable-016-carrier.yml',
    job: 'stage', artifact: `private-portable-016-carrier-${a.runId}-${a.runAttempt}` });
  const b = { ...p.inputProfile.assembly017, ...lane.SOURCE, ...p.carriers.signed017 }, signed017 = await bind(b, request);
  c.apiProof(b, signed017, { branch: 'validation/linux-private-update-fixture-017', workflow: '.github/workflows/private-linux-update-fixture-017.yml',
    job: 'stage-input', artifact: `private017-signed-input-${b.runId}-${b.runAttempt}` });
  const original016 = await oldWriter.fresh(previous.plan, previous.checked.receipt.producer, request);
  const derivation017 = await provenance.fresh({ plan: signed.plan, handoff: signed.handoff, preparedFile: signed.files['prepared-unix.json'] }, request);
  return { packaging, assembly: actualAssembly, signed016, signed017, original016, derivation017, ...c.FLAGS };
}
function verifyPublicKeySource(bytes, expected) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 4096);
  assert.ok([...bytes].every(n => n === 10 || n === 13 || n >= 32 && n <= 126), 'Exact ASCII public-key source required');
  // Only checkout CRLF is translated. Do not trim, decode/re-encode the key,
  // alter comments/whitespace, or normalize any other source file.
  const canonical = Buffer.from(bytes.toString('ascii').replace(/\r\n/g, '\n'), 'ascii');
  assert.equal(canonical.includes(13), false, 'Bare CR in public-key source');
  assert.deepEqual(c.record(canonical), c.bare(expected), 'Public-key source differs from the exact canonical Git bytes');
  if (expected.gitBlob) assert.equal(crypto.createHash('sha1').update(`blob ${canonical.length}\0`).update(canonical).digest('hex'), expected.gitBlob);
}
function sourceProof(root, p, tool, selectorProof, run) {
  function sources(commit) {
    const rows = String(run('git', ['ls-tree', '-rz', '--full-tree', commit, '--', ...c.TOOL_SOURCES], { maxBuffer: 512 * 1024 })).split('\0').filter(Boolean);
    assert.ok(rows.length > 5 && rows.length <= 1024); const found = {};
    for (const row of rows) {
      const match = /^100(?:644|755) blob ([a-f0-9]{40})\t(.+)$/.exec(row); assert.ok(match);
      const name = match[2]; assert.ok(base.relative(name) && !Object.hasOwn(found, name) && c.TOOL_SOURCES.some(scope => name === scope || name.startsWith(`${scope}/`)));
      const bytes = Buffer.from(run('git', ['cat-file', 'blob', match[1]], { encoding: null, maxBuffer: c.META }));
      assert.equal(crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), match[1]);
      found[name] = { gitBlob: match[1], ...c.record(bytes) };
    }
    assert.ok(Object.values(found).reduce((n, v) => n + v.size, 0) <= 32 * 1024 * 1024); return found;
  }
  assert.deepEqual(sources(p.producer.sourceCommit), tool.sources, 'Controlled tool source inventory differs from the successful producer Git tree');
  assert.deepEqual(sources(lane.SOURCE.sourceCommit), tool.sources, 'Controlled tools are not from the fixed actual017 source');
  function selectorSources(commit) {
    const rows = String(run('git', ['ls-tree', '-rz', '--full-tree', commit, '--', 'native/linux-portable-deployment', PUBLIC_KEY], { maxBuffer: 65536 })).split('\0').filter(Boolean);
    assert.ok(rows.length >= 4 && rows.length <= 256); const found = {};
    for (const row of rows) {
      const match = /^100(?:644|755) blob ([a-f0-9]{40})\t(.+)$/.exec(row); assert.ok(match);
      const name = match[2]; assert.ok(base.relative(name) && !name.split('/').includes('.cargo') && !Object.hasOwn(found, name)
        && (name.startsWith('native/linux-portable-deployment/') || name === PUBLIC_KEY));
      const bytes = Buffer.from(run('git', ['cat-file', 'blob', match[1]], { encoding: null, maxBuffer: c.META }));
      assert.equal(crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), match[1]); found[name] = c.record(bytes);
      // Reuse is proved from immutable build/target Git blobs, not today's
      // mutable crate (which is not compiled here). Only the current trust key
      // must additionally bind to that exact canonical source.
      if (name === PUBLIC_KEY) verifyPublicKeySource(require('./flatpak-package.cjs').read(path.join(root, name), c.META), { gitBlob: match[1], ...found[name] });
    }
    assert.ok(Object.values(found).reduce((sum, pin) => sum + pin.size, 0) <= 16 * 1024 * 1024); return found;
  }
  const original = selectorSources(selectorProof.sourceCommit), target = selectorSources(lane.SOURCE.sourceCommit);
  assert.deepEqual(original, selectorProof.sources); assert.deepEqual(target, original);
  assert.deepEqual(selectorProof.publicKeySource, original[PUBLIC_KEY]);
  return { originalSourceCommit: selectorProof.sourceCommit, originalSourceTree: selectorProof.sourceTree, targetSource: lane.SOURCE,
    sources: original, executable: selectorProof.executable, reusedWithoutCompilation: true, signaturesRequired: true };
}
function validateCaptured(p, bodies, expectedRequest, tool, selector, signed, previous, proof) {
  const downloaded = c.parse(bodies['download-proof.json']);
  c.keys(downloaded, ['assembly', 'signed016', 'signed017', 'releaseReady']); assert.equal(downloaded.releaseReady, false);
  // Full API JSON contains mutable metadata and timestamp presentation. Both
  // retained and fresh responses must independently pass the same fixed pins.
  for (const data of [downloaded, proof]) {
    lane.assemblyAPI(p.inputProfile, data.assembly);
    const a = p.carriers.signed016;
    c.apiProof(a, data.signed016, { branch: 'validation/private-portable-016-carrier', workflow: '.github/workflows/private-portable-016-carrier.yml',
      job: 'stage', artifact: `private-portable-016-carrier-${a.runId}-${a.runAttempt}` });
    const b = { ...p.inputProfile.assembly017, ...lane.SOURCE, ...p.carriers.signed017 };
    c.apiProof(b, data.signed017, { branch: 'validation/linux-private-update-fixture-017', workflow: '.github/workflows/private-linux-update-fixture-017.yml',
      job: 'stage-input', artifact: `private017-signed-input-${b.runId}-${b.runAttempt}` });
  }
  const data = c.parse(bodies['data-preflight.json']);
  c.keys(data, ['profileSha256', 'request', 'proof16', 'proof17', 'selector', 'signatureVerificationPending', 'releaseReady']);
  assert.equal(data.profileSha256, tool.independentProfileSha256); assert.deepEqual(data.request, expectedRequest);
  assert.deepEqual(data.selector, selector); assert.equal(data.signatureVerificationPending, true); assert.equal(data.releaseReady, false);
  const binding = previous.checked.receipt.producer;
  for (const value of [data.proof16, proof.original016]) {
    c.keys(value, ['packaging', 'original']); old.validateAPI(previous.plan, value.packaging);
    c.keys(value.original, ['pins', 'proof', 'privateProof']); assert.deepEqual(value.original.pins, binding.pins);
    base.production016().verifyProducer(binding.pins, value.original.proof);
    for (const name of ['expected', 'prepared', 'artifactSize', 'jobId']) assert.deepEqual(value.original.privateProof[name], binding.privateProof[name]);
    base.verifyPrivateProof(value.original.privateProof);
  }
  const flags = require('./private-linux-update-fixture-017.cjs').FLAGS;
  for (const value of [data.proof17, proof.derivation017]) {
    c.keys(value, ['original', 'baseline', 'root', 'privateSourcePaths', 'versionSources', ...Object.keys(flags)]);
    metadata.validateApi(signed.plan, value.baseline, value.root);
    assert.deepEqual(value.original, signed.handoff.apiProof, 'Compact immutable original producer proof differs from the signed handoff');
    for (const [name, flag] of Object.entries(flags)) assert.equal(value[name], flag);
  }
  assert.deepEqual(data.proof17.privateSourcePaths, proof.derivation017.privateSourcePaths, 'Immutable private Git source inventory changed');
  assert.deepEqual(data.proof17.versionSources, proof.derivation017.versionSources, 'Immutable actual017 version blobs changed');
}
async function sign({ input, proofs, plan: planFile, planSha256, output }, services = {}) {
  const root = services.root || ROOT, execute = services.execute || execFileSync, approved = services.signer || routing;
  try {
    assert.equal(services.platform || process.platform, 'win32', 'Use the fixed Windows production-key verifier');
    for (const file of [root, input, proofs, planFile, output]) absolute(file);
    for (const file of [input, proofs, output]) inside(file, path.join(root, 'artifacts'));
    inside(planFile, path.dirname(root)); assert.equal(path.extname(input), '.zip'); assert.equal(fs.existsSync(output), false, 'Fresh immutable output required');
    for (const [a, b] of [[planFile, proofs], [planFile, output], [input, proofs], [output, proofs], [proofs, output]]) assert.ok(a !== b && !a.startsWith(b + path.sep), 'Independent nonoverlapping proof/plan/input/output paths required');
    assert.ok(!planFile.startsWith(path.dirname(input) + path.sep), 'Approved plan must be independent of candidate input');
    assert.match(planSha256, /^[a-f0-9]{64}$/);
    const held = new Map();
    const identity = file => { const s = fs.lstatSync(file, { bigint: true }); return [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs, s.birthtimeNs]; };
    function remember(file, maximum, tool = false) {
      absolute(file); const initial = identity(file), pin = capture(file, maximum, tool);
      assert.deepEqual(identity(file), initial); held.set(file, { pin, identity: initial, tool }); return pin;
    }
    function unchanged(file) {
      const value = held.get(file); assert.ok(value); absolute(file); assert.deepEqual(identity(file), value.identity, 'Held identity changed');
      assert.deepEqual(capture(file, value.pin.size, value.tool), value.pin, 'Held bytes changed'); assert.deepEqual(identity(file), value.identity);
    }
    function bytes(file) { unchanged(file); const value = fs.readFileSync(file); assert.deepEqual(c.record(value), held.get(file).pin); unchanged(file); return value; }
    function write(file, value) { fs.writeFileSync(file, value, { flag: 'wx', mode: 0o600 }); remember(file, value.length); }
    function copy(source, target) {
      unchanged(source); absolute(target); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); assert.deepEqual(remember(target, held.get(source).pin.size), held.get(source).pin); unchanged(source);
    }
    assert.equal(remember(planFile, c.SIGNED_META).sha256, planSha256, 'Independent approved plan hash differs');
    const p = c.validatePlan(c.parse(bytes(planFile), c.SIGNED_META));
    assert.deepEqual(remember(input, base.LIMITS.zip), p.producer.zip);
    inventory(proofs, c.PROOFS);
    for (const name of c.PROOFS) assert.deepEqual(remember(path.join(proofs, name), c.limit(name)), p.proofs[name], `Read-only proof differs: ${name}`);
    const verifierSource = path.join(root, VERIFIER); assert.deepEqual(remember(verifierSource, base.LIMITS.file, true), p.verifier);
    const decoderSource = path.join(root, DECODER); assert.deepEqual(remember(decoderSource, base.LIMITS.file, true), p.decoder);
    const publicKey = path.join(root, PUBLIC_KEY); remember(publicKey, c.META);
    const work = fs.mkdtempSync(path.join(root, 'artifacts/private-portable017-sign-work-')); fs.chmodSync(work, 0o700);
    const zip = path.join(work, 'producer.zip'), savedPlan = path.join(work, 'plan.json'), snapshotProofs = path.join(work, 'proofs');
    copy(input, zip); copy(planFile, savedPlan); for (const name of c.PROOFS) copy(path.join(proofs, name), path.join(snapshotProofs, name));
    const verifier = path.join(work, 'verify-package-input.exe'); copy(verifierSource, verifier);
    const decoder = path.join(work, 'creator-hub-module-archive.exe'); copy(decoderSource, decoder);
    const stagedSets = [];
    let decoderSourcesHeld = false;
    function decoderInventory() {
      assert.deepEqual(fs.readdirSync(path.join(root, 'native/module-archive')).filter(name => name !== 'target').sort(), ['Cargo.lock', 'Cargo.toml', 'src']);
      inventory(path.join(root, 'native/module-archive/src'), ['main.rs']);
    }
    function recheck(full = false) {
      inventory(proofs, c.PROOFS); inventory(snapshotProofs, c.PROOFS);
      if (decoderSourcesHeld) decoderInventory();
      // Hold complete identities around every external call; rehash all bytes at
      // the key-selection and final boundaries rather than rereading GBs per API/blob.
      for (const [file, value] of held) { absolute(file); assert.deepEqual(identity(file), value.identity, 'Held identity changed'); if (full) unchanged(file); }
      for (const [dir, names] of stagedSets) inventory(dir, names);
    }
    function run(program, args, options = {}) {
      recheck(); try { return execute(program, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: c.META, ...options }); }
      finally { recheck(); }
    }
    function stage(zipFile, dir, roles, allowed) {
      const pins = Object.fromEntries(Object.values(roles).map(({ member, size, sha256 }) => [member, { size, sha256 }]));
      run('python', ['-B', '-c', base.ZIP_STAGE, zipFile, dir], { input: JSON.stringify({ pins, allowed: allowed || Object.keys(pins), outputs: Object.fromEntries(Object.entries(roles).map(([name, v]) => [v.member, name])) }) });
      const names = Object.keys(roles); inventory(dir, names); stagedSets.push([dir, names]);
      return Object.fromEntries(names.map(name => { const file = path.join(dir, name); assert.deepEqual(remember(file, c.limit(name)), c.bare(roles[name])); return [name, bytes(file)]; }));
    }
    const bodies = stage(zip, path.join(work, 'producer'), p.files);
    const actualAssembly = stage(path.join(snapshotProofs, 'assembly017.zip'), path.join(work, 'assembly'),
      Object.fromEntries(Object.entries(lane.ROLES).map(([role, name]) => [name, p.inputProfile.assembly017.files[role]])));
    const assemblyBodies = Object.fromEntries(Object.entries(lane.ROLES).map(([role, name]) => [role, actualAssembly[name]]));
    const signed = assembly.inputs(path.join(snapshotProofs, 'signed017'), p.inputProfile.signed017.planSha256);
    assert.deepEqual(signed.plan.rootSource, lane.SOURCE);
    const legacy = Object.fromEntries(lane.LEGACY_NAMES.map(name => [name, bytes(path.join(snapshotProofs, 'signed016', name))]));
    const previousPlan = old.validatePlan(old.parse(legacy['plan.json']));
    assert.deepEqual(previousPlan.producer.zip, p.proofs['portable016.zip']);
    const originalBodies = stage(path.join(snapshotProofs, 'portable016.zip'), path.join(work, 'original016'),
      Object.fromEntries(old.FILES.map(name => [name, { member: name, ...previousPlan.files[name] }])));
    for (const name of old.FILES) assert.ok(originalBodies[name].equals(legacy[name === old.UNSIGNED ? old.MANIFEST : name]));
    // This validator sees only the genuine old016 carrier, never017 metadata.
    const previous = { plan: previousPlan, checked: old.validateOutput(previousPlan, originalBodies) };
    assert.deepEqual(previousPlan.rootSource, { sourceCommit: signed.plan.baseline016.assembly.sourceCommit,
      sourceTree: signed.plan.baseline016.assembly.sourceTree, rawHub: signed.plan.baseline016.pins.rawHub });
    // The transfer and rebuilt resource archives differ; signed derivation and
    // validateAssembly bind unchanged private files plus the two017 runtime files.
    assert.deepEqual(old.parse(legacy[old.DESCRIPTOR], old.SIGNED_META), previous.checked.descriptor);
    const oldReceipt = old.parse(legacy['private-qualification-receipt.json']);
    assert.equal(oldReceipt.profile, old.PROFILE); assert.equal(oldReceipt.planSha256, p.inputProfile.signed016.planSha256);
    assert.equal(oldReceipt.authorizedBodiesSigned, 2); assert.equal(oldReceipt.privateKeyIncluded, false);
    assert.deepEqual(oldReceipt.producer, previousPlan.producer); assert.deepEqual(oldReceipt.rootSource, previousPlan.rootSource);
    for (const [name, value] of Object.entries(old.FLAGS)) assert.equal(oldReceipt[name], value);
    const baselineDirectory = path.join(work, 'baseline016');
    const baselineBodies = stage(signed.files['baseline016.zip'], baselineDirectory, {
      ...Object.fromEntries(Object.entries(metadata.BASELINE_MEMBERS).map(([name, member]) => [name, { member, ...signed.plan.baseline016.pins[name] }])),
      'modules.tar.gz': { member: 'modules.tar.gz', ...previous.checked.receipt.producer.pins.files['modules.tar.gz'] }
    }, base.MAIN_ALLOWED);
    const baseline = metadata.validateBaseline(signed.plan, Object.fromEntries(Object.keys(metadata.BASELINE_MEMBERS).map(name => [name, baselineBodies[name]])), signed.handoff);
    function verify(body, sig) { assert.equal(String(run(verifier, [body, sig])).trim(), `Verified trusted package signature: ${held.get(body).pin.sha256}. No activation or client changes.`); }
    for (const name of [old.MANIFEST, old.DESCRIPTOR]) {
      assert.deepEqual(oldReceipt.signatures[`${name}.minisig`], p.proofs[`signed016/${name}.minisig`]);
      verify(path.join(snapshotProofs, 'signed016', name), path.join(snapshotProofs, 'signed016', `${name}.minisig`));
    }
    metadata.verifySignatures(signed.files, signed.records, verifier, run);
    const tool = c.parse(bodies['tool-build.json']), expectedRequest = c.validateToolBuild(p, tool);
    verifyPublicKeySource(bytes(publicKey), tool.publicKey);
    const selector = sourceProof(root, p, tool, previous.checked.receipt.selectorBuild, run);
    const checked = c.validateOutput(p, bodies, assemblyBodies, signed, selector);
    c.keys(Object.fromEntries(Object.entries(tool.sources).filter(([name]) => name.startsWith('native/module-archive/'))), DECODER_CRATE_SOURCES);
    decoderInventory();
    for (const name of DECODER_SOURCES) assert.deepEqual(remember(path.join(root, name), c.META), c.bare(tool.sources[name]), 'Current decoder compiler input differs from fixed017 Git source');
    decoderSourcesHeld = true;
    moduleArchive.verify(path.join(baselineDirectory, 'modules.tar.gz'), baseline.manifest, decoder, run);
    moduleArchive.verify(path.join(work, 'assembly', 'modules.tar.gz'), checked.built.manifest, decoder, run);
    const request = async route => { recheck(); try { return await (services.request || provenance.api)(route); } finally { recheck(); } };
    const proof = await fresh(p, signed, previous, request);
    validateCaptured(p, bodies, expectedRequest, tool, selector, signed, previous, proof);
    const proofBytes = c.json(proof); assert.ok(proofBytes.length <= c.META); recheck();
    function refuseMutation(body, signature, name) {
      const altered = Buffer.from(bytes(body)); altered[0] ^= 1;
      const file = path.join(work, name); write(file, altered); let refused = false;
      try { run(verifier, [file, signature]); } catch { refused = true; }
      recheck(); assert.equal(refused, true, 'Production verifier accepted changed signed bytes');
    }
    refuseMutation(signed.files['runtime017.json'], signed.files['runtime017.minisig'], 'original-runtime-mutation.json');
    fs.mkdirSync(output, { mode: 0o700 });
    const outputNames = c.FILES.map(name => name === c.UNSIGNED ? c.MANIFEST : name);
    for (const name of c.FILES) copy(path.join(work, 'producer', name), path.join(output, name === c.UNSIGNED ? c.MANIFEST : name));
    copy(savedPlan, path.join(output, 'plan.json')); write(path.join(output, 'fresh-api.json'), proofBytes);
    const descriptor = path.join(output, c.DESCRIPTOR); write(descriptor, c.json(checked.descriptor));
    const expectedOutput = [...outputNames, 'plan.json', 'fresh-api.json', c.DESCRIPTOR], authorized = [path.join(output, c.MANIFEST), descriptor], signatures = {};
    function checkOutput() { recheck(); inventory(output, expectedOutput); }
    checkOutput(); recheck(true);
    // Only the existing protected helper may select/access the existing key.
    const key = approved.signingKey(root); let sequence = 0;
    for (const body of authorized) {
      assert.equal(authorized[sequence], body); assert.ok(sequence < 2); checkOutput();
      const temporary = path.join(work, `signing-input-${sequence++}.json`); copy(body, temporary);
      const signature = approved.signDetached(temporary, key); checkOutput();
      assert.ok(Buffer.isBuffer(signature) && signature.length > 0 && signature.length <= 4096 && signature.toString('utf8').startsWith('untrusted comment:'), 'Bounded plain Minisign signature required');
      const signatureFile = `${body}.minisig`; write(signatureFile, signature); expectedOutput.push(path.basename(signatureFile));
      verify(body, signatureFile); refuseMutation(body, signatureFile, `new-metadata-mutation-${sequence}.json`);
      signatures[path.basename(signatureFile)] = held.get(signatureFile).pin; checkOutput();
    }
    assert.equal(sequence, 2);
    c.validateOutput(p, Object.fromEntries(c.FILES.map(name => [name, bytes(path.join(output, name === c.UNSIGNED ? c.MANIFEST : name))])), assemblyBodies, signed, selector);
    for (const body of authorized) verify(body, `${body}.minisig`);
    for (const name of [old.MANIFEST, old.DESCRIPTOR]) verify(path.join(snapshotProofs, 'signed016', name), path.join(snapshotProofs, 'signed016', `${name}.minisig`));
    metadata.verifySignatures(signed.files, signed.records, verifier, run); signed.recheck(); checkOutput();
    const receipt = { schemaVersion: 1, profile: c.PROFILE, version: c.VERSION, minHubVersion: c.MINIMUM, restartProtocol: 1,
      planSha256, producer: p.producer, rootSource: lane.SOURCE, inputZip: p.producer.zip, readOnlyProofs: p.proofs,
      original016Use: 'signed inputs and unchanged selector provenance only; not qualification of the final016 candidate',
      files: Object.fromEntries(outputNames.map(name => [name, held.get(path.join(output, name)).pin])), descriptor: held.get(descriptor).pin,
      signatures, authorizedBodiesSigned: 2, privateKeyIncluded: false, ...c.FLAGS };
    receipt.resourceArchiveDecoder = { executable: p.decoder, source: lane.SOURCE,
      sources: Object.fromEntries(DECODER_SOURCES.map(name => [name, tool.sources[name]])), verifiedVersions: ['0.1.16', '0.1.17'] };
    write(path.join(output, RECEIPT), c.json(receipt)); expectedOutput.push(RECEIPT); checkOutput(); recheck(true);
    return { output, profile: c.PROFILE, version: c.VERSION, planSha256, authorizedBodiesSigned: 2, privateKeyIncluded: false, ...c.FLAGS };
  } catch { throw Error(FAILURE); }
}
function cli(args) {
  assert.equal(args.length, 10); assert.deepEqual(args.filter((_, i) => i % 2 === 0), ['--input', '--proofs', '--plan', '--plan-sha256', '--output']);
  return { input: args[1], proofs: args[3], plan: args[5], planSha256: args[7], output: args[9] };
}
module.exports = { VERIFIER, DECODER, DECODER_CRATE_SOURCES, DECODER_SOURCES, PUBLIC_KEY, RECEIPT, FAILURE, inventory, bind, fresh, verifyPublicKeySource, sourceProof, validateCaptured, sign, cli };
if (require.main === module) Promise.resolve().then(() => sign(cli(process.argv.slice(2))))
  .then(result => console.log(JSON.stringify(result)))
  .catch(() => { console.error(FAILURE); process.exitCode = 1; });
