const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { signPayload } = require('./sign-unix-payload.cjs');
const { fixture: bindingFixture } = require('./fixtures/unix-payload-binding.cjs');
const { moduleFiles } = require('./build-unified.cjs');
const { runtimeDescriptor } = require('./mcp-runtime-descriptor.cjs');
const { validateBinding } = require('./unix-payload-binding.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const root = path.resolve(__dirname, '..');

function fixture(t, target = 'linux', fault = '') {
  const parent = path.join(root, 'artifacts'); fs.mkdirSync(parent, { recursive: true });
  const owned = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'sign-unix-test-')));
  t.after(() => {
    assert.equal(fs.realpathSync(owned), owned); assert.equal(path.dirname(owned), fs.realpathSync(parent));
    assert.ok(path.basename(owned).startsWith('sign-unix-test-')); fs.rmSync(owned, { recursive: true, force: true });
  });
  const put = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
  const proof = bindingFixture(target), rawFiles = {}, manifest = { schemaVersion: 1, platform: proof.prepared.platform, arch: proof.prepared.arch, modules: {} };
  for (const id of ['mcp', 'setup']) {
    const names = moduleFiles(id, manifest.platform), files = {};
    for (const name of names) { const bytes = Buffer.from(`Synthetic never-executed ${name}`); rawFiles[`modules/${name}`] = bytes; files[name] = hash(bytes); }
    manifest.modules[id] = { executable: names[0], version: id === 'mcp' ? '2.7.7' : '0.3.7', files };
  }
  const runtime = runtimeDescriptor(manifest, '0.1.14');
  if (fault === 'manifest') manifest.arch = manifest.arch === 'x86_64' ? 'aarch64' : 'x86_64';
  if (fault === 'runtime') runtime.hubVersion = '0.1.15';
  rawFiles['builtin-manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2));
  rawFiles['mcp-runtime.json'] = Buffer.from(JSON.stringify(runtime));
  rawFiles['router-for-package'] = Buffer.from('Synthetic finalized native router. Never executed.');
  for (const [name, bytes] of Object.entries(rawFiles)) proof.prepared.files[name] = { sha256: hash(bytes), size: bytes.length, mode: proof.prepared.files[name].mode };
  const preparedBytes = Buffer.from(JSON.stringify(proof.prepared, null, 2));
  const tar = Buffer.from('Synthetic original TAR. Native processes are mocked, not packing/signing proof.');
  const transferBinding = Buffer.from(JSON.stringify({ schemaVersion: 1, file: 'modules.tar.gz', sha256: hash(tar), size: tar.length,
    unpackedSize: Object.values(proof.prepared.files).reduce((sum, record) => sum + record.size, 0),
    files: Object.fromEntries(Object.entries(proof.prepared.files).map(([name, record]) => [name, { size: record.size, mode: record.mode }])) }, null, 2));
  const artifacts = path.join(owned, 'artifacts'); fs.mkdirSync(artifacts);
  const zipBytes = Buffer.from('Synthetic pinned outer ZIP. Acquisition is mocked.');
  proof.expected.zipSha256 = hash(zipBytes); proof.artifact.digest = `sha256:${proof.expected.zipSha256}`; proof.artifact.size_in_bytes = zipBytes.length;
  const inputs = { pins: put(path.join(owned, 'independent-pins.json'), JSON.stringify(proof.expected, null, 2)),
    zip: put(path.join(artifacts, 'input.zip'), zipBytes), prepared: put(path.join(artifacts, 'staged/prepared-unix.json'), preparedBytes),
    output: path.join(artifacts, 'signed'),
    transferExe: put(path.join(owned, 'native/unix-transfer/target/release/creator-hub-unix-transfer.exe'), 'Synthetic trusted tool; never executed'),
    verifierExe: put(path.join(owned, 'src-tauri/target/release/examples/verify-package-input.exe'), 'Synthetic trusted verifier; never executed') };
  put(path.join(owned, 'scripts/extract-unix-transfer.ps1'), 'Synthetic fixed extractor; never executed');
  const calls = [], requests = []; let keys = 0, signatures = 0;
  const key = path.join(owned, 'never-created-private-placeholder.key');
  const request = route => {
    requests.push(route);
    if (route === `actions/runs/${proof.expected.runId}`) return proof.run;
    if (route === `actions/artifacts/${proof.expected.artifactId}`) return proof.artifact;
    if (route === `git/commits/${proof.expected.sourceCommit}`) return proof.commit;
    if (route.includes('/jobs?')) return { total_count: proof.jobs.length, jobs: proof.jobs };
    assert.fail('Unexpected public API request');
  };
  const signer = {
    signingKey(selected) { assert.equal(selected, owned); assert.equal(fs.existsSync(key), false); keys++; return key; },
    signDetached(file, selected) {
      assert.equal(selected, key); assert.equal(fs.existsSync(key), false); signatures++;
      assert.ok(file.includes('unix-sign-work-'), 'Signing inputs must stay outside final output');
      const body = fs.readFileSync(file), signature = Buffer.from(`untrusted comment: Synthetic ${fault === 'signature' ? 'invalid' : hash(body)}`);
      // Model the approved signer's encoded .sig side effect without any key read.
      put(`${file}.sig`, signature.toString('base64'));
      if (fault === 'input-drift' && signatures === 1) fs.appendFileSync(inputs.zip, 'tampered');
      if (fault === 'body-drift') fs.appendFileSync(file, 'tampered');
      return signature;
    },
  };
  const execute = (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === 'powershell.exe') {
      assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-File']);
      assert.equal(args[3], path.join(owned, 'scripts/extract-unix-transfer.ps1'));
      const destination = args[args.indexOf('-OutputDirectory') + 1]; fs.mkdirSync(destination);
      put(path.join(destination, 'modules.tar.gz'), tar);
      put(path.join(destination, 'prepared-unix.json'), fault === 'receipt' ? Buffer.from('{}') : preparedBytes);
      put(path.join(destination, 'transfer-binding.json'), transferBinding);
      if (fault === 'tool-drift') fs.appendFileSync(inputs.verifierExe, 'tampered');
      return JSON.stringify({ downloadedZipVerified: true, transferContentsVerified: false, releaseReady: false });
    }
    if (command === inputs.transferExe) {
      assert.ok(['verify', 'extract'].includes(args[0]), 'No repacking or native payload execution');
      assert.deepEqual(fs.readFileSync(args[1]), tar);
      if (fault === 'tar') throw Error('Mock shared decoder refused malformed TAR');
      if (args[0] === 'extract') {
        fs.mkdirSync(args[4]);
        for (const [name, bytes] of Object.entries(rawFiles)) put(path.join(args[4], name), fault === 'raw' && name.endsWith('/runtime/node') ? 'tampered' : bytes);
        put(path.join(args[4], 'prepared-unix.json'), preparedBytes);
      }
      return 'Unsigned transfer checked. No payload execution, signing, activation or release acceptance.';
    }
    assert.equal(command, inputs.verifierExe, 'Only trusted native verification tools may run');
    assert.equal(args.length, 2);
    const body = fs.readFileSync(args[0]), signature = fs.readFileSync(args[1]);
    assert.equal(signature.toString(), `untrusted comment: Synthetic ${hash(body)}`, 'Mock production-key verification failed');
    if (fault === 'post-handoff-tamper' && args[0] === path.join(inputs.output, 'handoff.json')) fs.appendFileSync(path.join(inputs.output, 'routing/runtime.json'), 'tampered');
    return `Verified trusted package signature: ${hash(body)}. No activation or client changes.`;
  };
  return { inputs, services: { root: owned, platform: 'win32', execute, request, signer }, proof, calls, requests, tar, preparedBytes, transferBinding,
    count: () => ({ keys, signatures }), key };
}

for (const target of ['linux', 'macos-intel', 'macos-arm64']) test(`mocked local ${target} handoff preserves original carrier and binds Setup plus exact 15 files`, t => {
  const f = fixture(t, target);
  const result = signPayload(f.inputs, f.services);
  assert.deepEqual(f.count(), { keys: 1, signatures: 3 }); assert.equal(fs.existsSync(f.key), false);
  assert.equal(f.requests.length, 4, 'Fresh API proof must be collected');
  assert.equal(result.releaseReady, false); assert.equal(result.nativeGuiAccepted, false); assert.equal(result.privateKeyIncluded, false);
  const out = f.inputs.output, handoff = JSON.parse(fs.readFileSync(path.join(out, 'handoff.json')));
  assert.deepEqual(fs.readFileSync(path.join(out, 'modules.tar.gz')), f.tar);
  assert.deepEqual(fs.readFileSync(path.join(out, 'prepared-unix.json')), f.preparedBytes);
  assert.deepEqual(fs.readFileSync(path.join(out, 'transfer-binding.json')), f.transferBinding);
  assert.deepEqual(handoff.source, f.proof.prepared.source);
  assert.deepEqual(validateBinding({ ...handoff.apiProof, prepared: JSON.parse(f.preparedBytes) }), validateBinding(f.proof));
  assert.equal(handoff.platform, f.proof.prepared.platform); assert.equal(handoff.arch, f.proof.prepared.arch);
  assert.equal(handoff.rustTarget, f.proof.prepared.rustTarget); assert.equal(handoff.hubVersion, '0.1.14');
  assert.equal(handoff.mcpMode, 'writable'); assert.deepEqual(handoff.compiledFlags, f.proof.prepared.compiledFlags);
  for (const [name, record] of Object.entries(f.proof.prepared.files)) {
    if (name.startsWith('modules/')) assert.deepEqual(handoff.payloadFiles[name.slice('modules/'.length)], record);
  }
  assert.deepEqual(handoff.payloadFiles['routing/creator-hub-mcp-router'], f.proof.prepared.files['router-for-package']);
  assert.equal(handoff.payloadFiles['setup/creator-project-setup'].sha256, f.proof.prepared.files['modules/setup/creator-project-setup'].sha256);
  assert.equal(handoff.payloadFiles['routing/creator-hub-mcp-router'].sha256, f.proof.prepared.files['router-for-package'].sha256);
  assert.equal(Object.keys(handoff.payloadFiles).length, 15);
  assert.equal(Object.keys(handoff.routingMetadata).length, 4);
  for (const [name, record] of Object.entries(handoff.routingMetadata)) {
    const bytes = fs.readFileSync(path.join(out, name));
    assert.deepEqual(record, { sha256: hash(bytes), size: bytes.length, mode: 0o644 });
    assert.deepEqual(handoff.payloadFiles[name], record);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(handoff.payloadFiles).map(([name, record]) => [name, record.sha256])),
    { ...handoff.builtinManifest.modules.mcp.files, ...handoff.builtinManifest.modules.setup.files, ...handoff.builtinManifest.managedRouting.files });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'routing/router.json'))), { schemaVersion: 1,
    product: 'com.creatorworks.hub.mcp-router', platform: handoff.platform, arch: handoff.arch, protocol: 1,
    sha256: f.proof.prepared.files['router-for-package'].sha256 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'routing/runtime.json'))), runtimeDescriptor(handoff.builtinManifest, handoff.hubVersion));
  assert.equal(handoff.builtinManifest.payloadArchive, undefined);
  assert.equal(fs.existsSync(path.join(out, 'routing/creator-hub-mcp-router')), false, 'Router remains in original carrier');
  assert.equal(fs.existsSync(path.join(out, 'handoff.json.sig')), false, 'Encoded signer side effects remain in scratch only');
  assert.equal(f.calls.filter(c => c.command === f.inputs.verifierExe).length, 6);
  assert.deepEqual(Object.keys(handoff.transferFiles).sort(), ['modules.tar.gz', 'prepared-unix.json', 'transfer-binding.json']);
  assert.equal(handoff.transferFiles['modules.tar.gz'].sha256, hash(f.tar));
  assert.equal(result.handoffSha256, hash(fs.readFileSync(path.join(out, 'handoff.json'))));
  assert.equal(result.handoffSignatureSha256, hash(fs.readFileSync(path.join(out, 'handoff.minisig'))));
  assert.throws(() => signPayload(f.inputs, f.services), /immutable/);
  assert.deepEqual(f.count(), { keys: 1, signatures: 3 });
});

for (const fault of ['receipt', 'tar', 'raw', 'manifest', 'runtime', 'tool-drift']) test(`${fault} failure precedes any key selection or signing`, t => {
  const f = fixture(t, 'linux', fault);
  assert.throws(() => signPayload(f.inputs, f.services));
  assert.deepEqual(f.count(), { keys: 0, signatures: 0 }); assert.equal(fs.existsSync(f.key), false);
  assert.equal(fs.existsSync(f.inputs.output), false);
});

test('fresh failed API proof refuses before ZIP extraction or key selection', t => {
  const f = fixture(t); f.proof.run.conclusion = 'failure';
  assert.throws(() => signPayload(f.inputs, f.services));
  assert.deepEqual(f.count(), { keys: 0, signatures: 0 }); assert.deepEqual(f.calls, []);
});
for (const fault of ['source-tree', 'run-attempt', 'ambiguous-job']) test(`${fault} API proof refuses before any native process or key selection`, t => {
  const f = fixture(t);
  if (fault === 'source-tree') f.proof.commit.tree.sha = 'f'.repeat(40);
  if (fault === 'run-attempt') f.proof.run.run_attempt++;
  if (fault === 'ambiguous-job') f.proof.jobs.push({ ...f.proof.jobs[0] });
  assert.throws(() => signPayload(f.inputs, f.services));
  assert.deepEqual(f.count(), { keys: 0, signatures: 0 }); assert.deepEqual(f.calls, []);
});
test('redirected candidate ancestor refuses before any native process or key selection', t => {
  const f = fixture(t), artifacts = path.dirname(f.inputs.zip), redirect = path.join(artifacts, 'redirect');
  fs.symlinkSync(artifacts, redirect, 'junction');
  assert.throws(() => signPayload({ ...f.inputs, zip: path.join(redirect, 'input.zip') }, f.services), /Redirected/);
  assert.deepEqual(f.count(), { keys: 0, signatures: 0 }); assert.deepEqual(f.calls, []);
  fs.unlinkSync(redirect);
});
test('API ZIP size/hash binding refuses before extraction or key selection', t => {
  const f = fixture(t); fs.appendFileSync(f.inputs.zip, 'tampered');
  assert.throws(() => signPayload(f.inputs, f.services), /ZIP differs/);
  assert.deepEqual(f.count(), { keys: 0, signatures: 0 }); assert.deepEqual(f.calls, []);
});
test('fixed Cargo executable hardlinks are supported without allowing hardlinked candidate inputs', t => {
  const f = fixture(t);
  for (const [index, tool] of [f.inputs.transferExe, f.inputs.verifierExe].entries()) fs.linkSync(tool, path.join(path.dirname(tool), `cargo-deps-${index}.exe`));
  assert.equal(signPayload(f.inputs, f.services).releaseReady, false);
  const bad = fixture(t); fs.linkSync(bad.inputs.zip, path.join(path.dirname(bad.inputs.zip), 'zip-alias'));
  assert.throws(() => signPayload(bad.inputs, bad.services), /single-link/);
  assert.deepEqual(bad.count(), { keys: 0, signatures: 0 });
});
test('wrong prepared target, duplicate pins and arbitrary tool paths cannot select a key', t => {
  const f = fixture(t);
  const original = fs.readFileSync(f.inputs.prepared);
  const p = JSON.parse(original); p.arch = 'aarch64'; fs.writeFileSync(f.inputs.prepared, JSON.stringify(p, null, 2));
  assert.throws(() => signPayload(f.inputs, f.services)); fs.writeFileSync(f.inputs.prepared, original);
  assert.throws(() => signPayload({ ...f.inputs, verifierExe: f.inputs.transferExe }, f.services), /fixed reviewed/);
  fs.writeFileSync(f.inputs.pins, fs.readFileSync(f.inputs.pins, 'utf8').replace('{', '{ "target": "linux",'));
  assert.throws(() => signPayload(f.inputs, f.services), /Noncanonical/);
  assert.deepEqual(f.count(), { keys: 0, signatures: 0 });
});
for (const fault of ['signature', 'body-drift', 'input-drift', 'post-handoff-tamper']) test(`${fault} refuses success and retains immutable partial evidence`, t => {
  const f = fixture(t, 'macos-arm64', fault);
  assert.throws(() => signPayload(f.inputs, f.services), /Partial output/);
  assert.equal(f.count().keys, 1); assert.equal(fs.existsSync(f.key), false);
  assert.deepEqual(fs.readFileSync(path.join(f.inputs.output, 'modules.tar.gz')), f.tar);
  assert.throws(() => signPayload(f.inputs, f.services), /immutable/);
});
test('a generated router target altered before the signing callback cannot be signed', t => {
  const f = fixture(t);
  const routing = require('./managed-router-package.cjs'), original = routing.prepare;
  try {
    routing.prepare = (directory, manifest, router, runtime, sign) => original(directory, manifest, router, runtime, file => {
      if (file.endsWith('router.json')) {
        const changed = JSON.parse(fs.readFileSync(file)); changed.arch = 'aarch64'; fs.writeFileSync(file, JSON.stringify(changed));
      }
      return sign(file);
    });
    assert.throws(() => signPayload(f.inputs, f.services), /Partial output/);
    assert.deepEqual(f.count(), { keys: 1, signatures: 0 });
  } finally { routing.prepare = original; }
});
test('production CLI has no mock/key-override path and refuses missing explicit inputs', () => {
  const source = fs.readFileSync(path.join(__dirname, 'sign-unix-payload.cjs'), 'utf8');
  assert.doesNotMatch(source.slice(source.indexOf('if (require.main === module)')), /services|signer|key|fixture/);
  const result = spawnSync(process.execPath, [path.join(__dirname, 'sign-unix-payload.cjs')], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1); assert.match(result.stderr, /ABS_PINS_JSON/);
});
