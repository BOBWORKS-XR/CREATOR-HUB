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

function data(target = 'linux', version = '0.1.14') {
  const binding = fixture(target), prepared = binding.prepared;
  if (version === '0.1.16') {
    binding.expected.version = prepared.hubVersion = version;
    binding.run.head_branch = 'validation/unix-payload-016';
  }
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

test('the separate 016 handoff requires its independently admitted version and cannot replace the frozen 014 scope', () => {
  const f = data('linux', '0.1.16');
  assert.deepEqual(validateHandoff(f.h, f.prepared, f.records, 'linux', 'x86_64', '0.1.16'), f.h.builtinManifest);
  assert.throws(() => validateHandoff(f.h, f.prepared, f.records, 'linux', 'x86_64'));
  assert.throws(() => validateHandoff(f.h, f.prepared, f.records, 'linux', 'x86_64', '0.1.17'));
  for (const target of ['macos-arm64', 'macos-intel']) {
    const other = data(target, '0.1.16');
    assert.throws(() => validateHandoff(other.h, other.prepared, other.records, 'macos', other.prepared.arch, '0.1.16'));
  }
  const old = data();
  assert.throws(() => validateHandoff(old.h, old.prepared, old.records, 'linux', 'x86_64', '0.1.16'));
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

test('016 assembly admission requires exact source, Linux x64 and the integrated candidate before any payload is read', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'unix-assembly-test-')));
  try {
    fs.mkdirSync(path.join(root, 'src-tauri'));
    for (const file of ['package.json', 'src-tauri/tauri.conf.json']) fs.writeFileSync(path.join(root, file), JSON.stringify({ version: '0.1.16' }));
    const ref = 'refs/heads/validation/linux-integrated-candidate-016';
    const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
      GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: ref, GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${WORKFLOW}@${ref}`, GITHUB_SHA: 'a'.repeat(40),
      CREATOR_UNIX_HANDOFF_SHA256: 'b'.repeat(64), CREATOR_LINUX_INTEGRATED_CANDIDATE: '1' };
    const execute = (_, args) => args.includes('--show-toplevel') ? root : args.includes('HEAD') ? env.GITHUB_SHA : '';
    assert.equal(admission(root, 'linux', 'x86_64', env, execute).version, '0.1.16');
    const production = { ...env, CREATOR_LINUX_INTEGRATED_CANDIDATE: '0',
      CREATOR_LINUX_PRODUCTION_MIGRATION_016: '1', CREATOR_LINUX_RETIREMENT_TEST_CANDIDATE: '0' };
    assert.equal(admission(root, 'linux', 'x86_64', production, execute).version, '0.1.16');
    for (const change of [{ CREATOR_LINUX_INTEGRATED_CANDIDATE: '1' },
      { CREATOR_LINUX_INTEGRATED_CANDIDATE: 'yes' }, { CREATOR_LINUX_PRODUCTION_MIGRATION_016: '0' },
      { CREATOR_LINUX_PRODUCTION_MIGRATION_016: 'yes' }, { CREATOR_LINUX_RETIREMENT_TEST_CANDIDATE: '1' },
      { CREATOR_LINUX_RETIREMENT_TEST_CANDIDATE: 'yes' }, { GITHUB_EVENT_NAME: 'push' }]) {
      assert.throws(() => admission(root, 'linux', 'x86_64', { ...production, ...change }, execute));
    }
    for (const change of [{ GITHUB_EVENT_NAME: 'push' }, { CREATOR_LINUX_INTEGRATED_CANDIDATE: '0' }]) {
      assert.throws(() => admission(root, 'linux', 'x86_64', { ...env, ...change }, execute));
    }
    assert.throws(() => admission(root, 'macos', 'x86_64', { ...env, RUNNER_OS: 'macOS' }, execute));
    assert.throws(() => admission(root, 'linux', 'aarch64', { ...env, RUNNER_ARCH: 'ARM64' }, execute));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.14' }));
    assert.throws(() => admission(root, 'linux', 'x86_64', env, execute), /source identity/);
  } finally {
    assert.equal(fs.realpathSync(root), root);
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test('016 workflow refuses wrong profiles before downloads and selects the asset version from its exact ref', () => {
  const { yaml } = require('../node_modules/playwright-core/lib/utilsBundle.js');
  const document = yaml.parseDocument(fs.readFileSync(path.join(__dirname, '../.github/workflows/unix-managed-assembly.yml'), 'utf8'), { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const workflow = document.toJS();
  const options = workflow.jobs['candidate-options'];
  assert.match(options.steps[0].run, /refs\/heads\/validation\/linux-integrated-candidate-016/);
  assert.match(options.steps[0].run, /GITHUB_EVENT_NAME.*workflow_dispatch/);
  assert.match(options.steps[0].run, /CREATOR_LINUX_INTEGRATED_CANDIDATE.*== '1'/);
  assert.match(options.steps[0].run, /CREATOR_LINUX_RETIREMENT_TEST_CANDIDATE.*== '0'/);
  assert.match(options.steps[0].run, /len\(inputs\) == 1.*'linux'.*'ubuntu-22\.04'/);
  const staged = workflow.jobs['stage-input'];
  assert.equal(staged.needs, 'candidate-options');
  assert.match(staged.steps[0].env.HUB_VERSION, /linux-integrated-candidate-016.*'0\.1\.16'.*'0\.1\.14'/);
  assert.match(staged.steps[0].with.script, /signed-unix-handoff-\$\{process\.env\.HUB_VERSION\}/);
  assert.equal(staged.runs_on, undefined);
  assert.equal(staged['runs-on'], 'ubuntu-22.04');
  assert.equal(workflow.jobs.assembly['runs-on'], 'ubuntu-22.04');
});

test('small Linux receipts are retained before the large immutable package artifact', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/unix-managed-assembly.yml'), 'utf8');
  const start = workflow.indexOf('name: Retain compact Linux receipts for independent review, without executable payloads');
  const full = workflow.indexOf('name: Retain signed build evidence, not publication or migration acceptance');
  assert.ok(start > 0 && start < full);
  const step = workflow.slice(start, full);
  assert.match(step, /if: success\(\) && runner\.os == 'Linux'/);
  const names = [...step.matchAll(/^\s+artifacts\/unified\/ci-signed-unix-hub\/(\S+)\r?$/gm)].map(value => value[1]);
  assert.deepEqual(names, ['linux-byte-receipts.json', 'builtin-manifest.json', 'signed-unix-assembly.json', 'unix-package-integrity.json',
    'direct-features-candidate.json', 'linux-retirement-candidate.json', 'linux-retirement-package-integrity.json']);
  assert.doesNotMatch(step, /\*|native-packages|modules\/|\.exe|\.AppImage/);
  const helpers = workflow.slice(workflow.indexOf('name: Retain separate acceptance-only helper and authorization package receipts'),
    workflow.indexOf('name: Retain only owned fresh14 package metadata'));
  assert.ok(helpers.includes('(inputs.linux_retirement_test_candidate || inputs.linux_integrated_candidate)'));
  for (const name of ['linux-retirement-candidate.json', 'linux-retirement-package-integrity.json',
    'tauri-linux-integrated-candidate.json', 'direct-features-candidate.json', 'native-activation.service']) assert.ok(helpers.includes(`/${name}`));
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
