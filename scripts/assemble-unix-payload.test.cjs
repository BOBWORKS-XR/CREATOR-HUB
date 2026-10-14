const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { fixture } = require('./fixtures/unix-payload-binding.cjs');
const { moduleFiles, writeAssemblyManifests } = require('./build-unified.cjs');
const { routeFiles } = require('./managed-router-package.cjs');
const { admission, inventory, validateHandoff, verificationTools, verifyPrivateSource, assemble, INPUTS, TRANSFER, ROUTING, WORKFLOW } = require('./assemble-unix-payload.cjs');

function data(target = 'linux') {
  const binding = fixture(target), prepared = binding.prepared;
  const modules = Object.fromEntries(['mcp', 'setup'].map(id => {
    const names = moduleFiles(id, prepared.platform);
    return [id, { executable: names[0], version: id === 'mcp' ? '2.7.7' : '0.3.7',
      files: Object.fromEntries(names.map(n => [n, prepared.files[`modules/${n}`].sha256])) }];
  }));
  const records = Object.fromEntries([...TRANSFER, ...ROUTING].map(n => [n, { sha256: 'd'.repeat(64), size: 100 }]));
  const routingMetadata = Object.fromEntries(ROUTING.map(n => [n, { ...records[n], mode: 0o644 }]));
  const routerName = routeFiles(prepared.platform)[0];
  const payloadFiles = {};
  for (const m of Object.values(modules)) for (const n of Object.keys(m.files)) payloadFiles[n] = prepared.files[`modules/${n}`];
  payloadFiles[routerName] = prepared.files['router-for-package']; Object.assign(payloadFiles, routingMetadata);
  const builtinManifest = { schemaVersion: 1, platform: prepared.platform, arch: prepared.arch, modules,
    managedRouting: { protocol: 1, files: Object.fromEntries(routeFiles(prepared.platform).map(n => [n, payloadFiles[n].sha256])) } };
  const { prepared: _, ...apiProof } = binding;
  const h = { schemaVersion: 1, product: 'com.creatorworks.hub.unix-signed-handoff', hubVersion: prepared.hubVersion,
    platform: prepared.platform, arch: prepared.arch, rustTarget: prepared.rustTarget, mcpMode: prepared.mcpMode,
    compiledFlags: prepared.compiledFlags, source: prepared.source, apiProof,
    transferFiles: Object.fromEntries(TRANSFER.map(n => [n, records[n]])), routingMetadata, builtinManifest, payloadFiles,
    privateKeyIncluded: false, nativeGuiAccepted: false, releaseReady: false };
  return { h, prepared, records };
}
for (const target of ['linux', 'macos-arm64', 'macos-intel']) test(`${target} exact signed handoff includes both private modules and canonical modes`, () => {
  const f = data(target);
  assert.deepEqual(validateHandoff(f.h, f.prepared, f.records, f.prepared.platform, f.prepared.arch), f.h.builtinManifest);
  assert.equal(Object.keys(f.h.payloadFiles).length, 15);
});
const faults = {
  target: f => { f.h.arch = 'wrong'; },
  source: f => { f.h.source = { ...f.h.source, sourceCommit: 'f'.repeat(40) }; },
  carrier: f => { f.records['modules.tar.gz'] = { ...f.records['modules.tar.gz'], sha256: 'f'.repeat(64) }; },
  signatureRecord: f => { f.records['routing/router.minisig'] = { sha256: 'f'.repeat(64), size: 100 }; },
  router: f => { f.h.builtinManifest.managedRouting.files[routeFiles('linux')[0]] = 'f'.repeat(64); },
  setup: f => { f.h.builtinManifest.modules.setup.files['setup/creator-project-setup'] = 'f'.repeat(64); },
  executableMode: f => { f.h.payloadFiles['setup/creator-project-setup'] = { ...f.h.payloadFiles['setup/creator-project-setup'], mode: 0o644 }; },
  unsignedAuthority: f => { f.h.releaseReady = true; },
  extra: f => { f.h.unknown = true; },
  staleAttempt: f => { f.h.apiProof.run.run_attempt = 2; },
  failedNativeJob: f => { f.h.apiProof.jobs[0].conclusion = 'failure'; },
};
for (const [name, change] of Object.entries(faults)) test(`${name} cannot authorize assembly`, () => {
  const f = structuredClone(data()); change(f);
  assert.throws(() => validateHandoff(f.h, f.prepared, f.records, 'linux', 'x86_64'));
});
test('native admission precedes input inspection and subprocesses', () => {
  const calls = [];
  assert.throws(() => assemble('/never/read', '/never/write', 'linux', 'x86_64', { env: {}, execute: (...args) => calls.push(args) }), /workflow required/);
  assert.deepEqual(calls, []);
});
test('admission requires exact workflow, native target and clean source without credential access', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unix-assembly-test-')));
  try {
    const ref = 'refs/heads/validation/unix-assembly-014';
    const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
      GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: ref, GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${WORKFLOW}@${ref}`,
      GITHUB_SHA: 'a'.repeat(40), CREATOR_UNIX_HANDOFF_SHA256: 'b'.repeat(64) };
    const execute = (_, args) => args.includes('--show-toplevel') ? root : args.includes('HEAD') ? env.GITHUB_SHA : '';
    assert.equal(admission(root, 'linux', 'x86_64', env, execute).handoffSha256, env.CREATOR_UNIX_HANDOFF_SHA256);
    for (const change of [{ GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REF: 'refs/heads/foreign' }, { RUNNER_ARCH: 'ARM64' },
      { GITHUB_REPOSITORY_ID: '2' }, { APPLE_SECRET: 'never-read' }, { CREATOR_HUB_SIGNING_KEY_PATH: 'never-read' },
      { NODE_OPTIONS: '--require never-read' }, { CREATOR_UNIX_HANDOFF_SHA256: '' }]) assert.throws(() => admission(root, 'linux', 'x86_64', { ...env, ...change }, execute));
    assert.throws(() => admission(root, 'linux', 'x86_64', env, (_, args) => args[0] === 'status' ? ' M source' : execute(_, args)), /Clean/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('exact input inventory refuses incomplete or extra handoff files', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unix-handoff-test-')));
  try {
    for (const name of INPUTS) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'never executed'); }
    assert.doesNotThrow(() => inventory(root, INPUTS));
    fs.writeFileSync(path.join(root, 'orphan'), 'extra'); assert.throws(() => inventory(root, INPUTS), /Unlisted/);
    fs.unlinkSync(path.join(root, 'orphan')); fs.unlinkSync(path.join(root, 'handoff.minisig'));
    assert.throws(() => inventory(root, INPUTS), /Incomplete/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('both cargo tool builds explicitly bind the same target directories as their executable lookup', () => {
  const root = path.resolve('/owned-source'), tools = verificationTools(root);
  for (const [args, binary] of [[tools.verifierArgs, tools.verifier], [tools.transferArgs, tools.transfer]]) {
    const target = args[args.indexOf('--target-dir') + 1];
    assert.ok(target && binary.startsWith(target + path.sep));
    assert.notEqual(target, '/inherited-cargo-override');
  }
});

test('the Root verifier cache resolves relative to its Cargo workspace, not the repository', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/unix-managed-assembly.yml'), 'utf8');
  const mapping = workflow.match(/^\s+src-tauri -> (\S+)\r?$/m);
  assert.ok(mapping);
  const root = path.resolve('/owned-source');
  const args = verificationTools(root).verifierArgs;
  assert.equal(path.resolve(root, 'src-tauri', mapping[1]), args[args.indexOf('--target-dir') + 1]);
});

test('Linux assembly runs actual Root migration and process tests before compiling a package', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/unix-managed-assembly.yml'), 'utf8');
  const triggers = workflow.slice(0, workflow.indexOf('permissions:'));
  assert.match(triggers, /branches: \[validation\/unix-assembly-014\]/);
  assert.doesNotMatch(triggers, /paths:/, 'Explicit source validation pushes must not require a dummy workflow edit');
  const step = workflow.indexOf('name: Test Linux migration completion and real owned GUI process detection before packaging');
  const build = workflow.indexOf('name: Verify trusted handoff and compile only the outer native Hub');
  assert.ok(step > 0 && step < build);
  assert.match(workflow.slice(step, workflow.indexOf('      - ', step)),
    /cargo test --release --locked --manifest-path src-tauri\/Cargo\.toml\s+--target-dir artifacts\/unix-verifier-target/);
  assert.doesNotMatch(workflow.slice(step, workflow.indexOf('      - ', step)), /continue-on-error|--ignored|--skip/);
});

test('both Linux assembly jobs select the same bounded signed input', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/unix-managed-assembly.yml'), 'utf8');
  const values = [...workflow.matchAll(/include: \$\{\{ fromJSON\(inputs\.signed_inputs \|\| '([^']+)'\) \}\}/g)]
    .map(match => JSON.parse(match[1]));
  assert.equal(values.length, 2);
  assert.deepEqual(values[0], values[1]);
  assert.equal(values[0].length, 1);
  const pin = values[0][0];
  assert.deepEqual(Object.keys(pin).sort(), ['assetId', 'handoffSha256', 'os', 'target', 'zipBytes', 'zipSha256']);
  assert.equal(pin.target, 'linux');
  assert.equal(pin.os, 'ubuntu-22.04');
  assert.ok(Number.isSafeInteger(pin.assetId) && pin.assetId > 0);
  assert.ok(Number.isSafeInteger(pin.zipBytes) && pin.zipBytes > 0 && pin.zipBytes <= 300 * 1024 * 1024);
  for (const value of [pin.zipSha256, pin.handoffSha256]) assert.match(value, /^[a-f0-9]{64}$/);
});
test('retained pre-wrapper is the signed manifest and original preparation is separately immutable', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unix-manifest-test-')));
  try {
    const signed = data().h.builtinManifest, prepared = structuredClone(signed);
    delete prepared.managedRouting;
    const bytes = JSON.stringify(prepared, null, 2);
    fs.writeFileSync(path.join(root, 'builtin-manifest.json'), bytes);
    const final = { ...signed, payloadArchive: { sha256: 'e'.repeat(64) } };
    writeAssemblyManifests(root, signed, final);
    assert.equal(fs.readFileSync(path.join(root, 'builtin-manifest.preparation.json'), 'utf8'), bytes);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'builtin-manifest.pre-wrapper.json'))), signed);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'builtin-manifest.json'))), final);
    assert.throws(() => writeAssemblyManifests(root, signed, final), /EEXIST/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('changes to either shared backend source or the compiled router public key cannot evade source equality', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unix-source-test-')));
  const names = ['native/host_parent_macos.rs', 'native/plugins_retirement.rs', 'native/convergence-server-unix.rs', 'src-tauri/src/catalog-key.pub'];
  const execute = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  try {
    execute('git', ['init', '-q']);
    for (const name of names) { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'baseline\n'); }
    execute('git', ['add', '.']);
    execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'synthetic baseline']);
    const source = execute('git', ['rev-parse', 'HEAD']).trim();
    assert.doesNotThrow(() => verifyPrivateSource(source, execute));
    for (const name of names) {
      fs.writeFileSync(path.join(root, name), 'changed\n');
      execute('git', ['add', name]);
      execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', `synthetic change ${name}`]);
      assert.throws(() => verifyPrivateSource(source, execute));
      fs.writeFileSync(path.join(root, name), 'baseline\n');
      execute('git', ['add', name]);
      execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', `synthetic restore ${name}`]);
      assert.doesNotThrow(() => verifyPrivateSource(source, execute));
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
