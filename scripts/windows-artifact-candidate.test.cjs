'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const c = require('./windows-artifact-candidate.cjs');
const { BASELINE } = require('./windows-incoming-016.cjs');
const sha = letter => letter.repeat(64), rev = 'a'.repeat(40);
const input = () => ({ runId: '123', artifactId: '456', archiveSha256: sha('b'), receiptSha256: sha('c'),
  producerCommit: rev, producerWorkflow: c.WORKFLOW });
const bound = () => ({ ...input(), runAttempt: 1 });
const runner = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
  GITHUB_REPOSITORY: c.REPO, GITHUB_REF: c.REF, GITHUB_EVENT_NAME: 'workflow_dispatch' });
const sourceRows = paths => ({ schemaVersion: 1, files: paths.sort().map(name => ({ path: name, sha256: sha('d') })) });
function temporary(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-artifact-test-'));
  t.after(() => {
    const resolved = path.resolve(folder), parent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved), parent); assert.ok(path.basename(resolved).startsWith('hub-artifact-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return folder;
}
function put(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
function apiPair() {
  return { artifact: { id: 456, workflow_run: { id: 123, head_sha: rev }, expired: false,
    size_in_bytes: 10, digest: `sha256:${sha('b')}`, name: 'creator-hub-windows-ci-candidate' },
  run: { id: 123, status: 'completed', conclusion: 'success', repository: { full_name: c.REPO },
    head_repository: { full_name: c.REPO }, head_sha: rev, path: c.WORKFLOW, run_attempt: 1 } };
}
function candidate(t) {
  const root = temporary(t), directory = path.join(root, 'candidate'); fs.mkdirSync(directory);
  const source = sourceRows(['package.json', 'src/app.js']);
  const manifest = c.jsonBytes({ schemaVersion: 1, testFixture: true });
  const raw = Buffer.concat([Buffer.from('MZ__TAURI_BUNDLE_TYPE_VAR_UNK'), manifest]);
  const installed = Buffer.from(raw); installed.write('NSS', raw.indexOf('UNK'));
  for (const [name, bytes] of Object.entries({ [c.ASSET]: 'fake installer, never executable',
    'raw-creator-hub.exe': raw, 'creator-hub.exe': installed, 'builtin-manifest.json': manifest,
    'source-manifest.json': c.jsonBytes(source) })) put(path.join(directory, name), bytes);
  const receipt = { schemaVersion: 1, kind: 'ci-windows-direct16-candidate', version: c.VERSION,
    source: { commit: rev, manifestSha256: c.hash(c.jsonBytes(source)) },
    producer: { commit: rev, runId: '123', runAttempt: 1 }, payload: bound(),
    files: Object.fromEntries(c.CANDIDATE_FILES.map(name => [name, c.record(path.join(directory, name))])),
    managedSignaturesVerified: true, localCandidateEquivalent: false, installed: false, signedUpdateAccepted: false, releaseReady: false };
  const save = () => {
    put(path.join(directory, 'candidate.json'), c.jsonBytes(receipt));
    return { ...bound(), receiptSha256: c.hash(c.jsonBytes(receipt)) };
  };
  return { root, directory, receipt, installed, save, binding: save() };
}

test('native guard requires all exact disposable-host, repository, branch and event fields', () => {
  c.assertRunner(runner(), 'win32');
  assert.throws(() => c.assertRunner(runner(), 'linux'));
  for (const name of Object.keys(runner())) assert.throws(() => c.assertRunner({ ...runner(), [name]: 'wrong' }, 'win32'), name);
});
test('real command entry points refuse before touching input, without impersonating a runner', () => {
  for (const file of ['windows-artifact-candidate.cjs', 'windows-artifact-install.cjs']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, file), 'produce', 'MUST-NOT-READ'],
      { env: { ...process.env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 1); assert.match(result.stderr, /disposable Windows|Windows only/);
    assert.doesNotMatch(result.stderr, /ENOENT|MUST-NOT-READ/);
  }
});
test('child environment strips secrets and build injection while preserving OS paths', () => {
  assert.deepEqual(c.cleanEnvironment({ PATH: 'keep', LOCALAPPDATA: 'keep', GH_TOKEN: 'drop',
    CREATOR_BUILTIN_MANIFEST: 'drop', TAURI_SIGNING_PRIVATE_KEY: 'drop', RUSTFLAGS: 'drop',
    RUSTC_WRAPPER: 'drop', CARGO_ENCODED_RUSTFLAGS: 'drop', NODE_OPTIONS: 'drop', HTTPS_PROXY: 'drop' }),
  { PATH: 'keep', LOCALAPPDATA: 'keep' });
});
test('snapshot binds dirty and untracked bytes, excludes generated paths and dedicated harness', t => {
  const root = temporary(t), names = ['src/app.js', 'src/new.js', 'src/deleted.js', 'package.json',
    'scripts/windows-artifact-candidate.cjs', 'src-tauri/gen/schemas/windows-schema.json', 'modules/mcp/target/junk'];
  for (const name of names.filter(name => !name.includes('deleted'))) put(path.join(root, name), name);
  const execute = (command, args) => { assert.equal(command, 'git'); assert.ok(args.includes('--others')); return names.join('\0'); };
  const before = c.snapshot(root, execute);
  assert.deepEqual(before.files.map(row => row.path), ['package.json', 'src/app.js', 'src/new.js']);
  put(path.join(root, 'src/app.js'), 'changed bytes');
  assert.notEqual(c.hash(c.jsonBytes(c.snapshot(root, execute))), c.hash(c.jsonBytes(before)));
});
test('source contract refuses unsafe, duplicate and unsorted paths', () => {
  for (const name of ['src/../secret', 'src/a:stream', '/src/a', 'src\\a', 'src//a']) assert.throws(() => c.sourcePath(name));
  const source = sourceRows(['src/a', 'src/b']);
  assert.throws(() => c.validateSnapshot({ ...source, files: [...source.files].reverse() }));
  assert.throws(() => c.validateSnapshot({ ...source, files: [source.files[0], source.files[0]] }));
});
test('payload reuse ignores test-only and unrelated harness changes', () => {
  const source = sourceRows(['modules/mcp/src/index.ts', 'scripts/build-unified.cjs',
    'scripts/old-harness.test.cjs', 'scripts/native-windows-016-fresh.cjs', 'modules/mcp/test/tool.test.mjs',
    'modules/project-setup/src-tauri/src/logic_tests.rs', 'modules/mcp/scripts/smoke-release-bundle.mjs']);
  const before = c.payloadSourceHash(source);
  for (const file of source.files.filter(file => !c.payloadSourcePath(file.path))) file.sha256 = sha('e');
  assert.equal(c.payloadSourceHash(source), before);
  source.files.push({ path: 'scripts/zzz-new-harness.test.cjs', sha256: sha('f') });
  source.files.sort((a, b) => a.path < b.path ? -1 : 1);
  assert.equal(c.payloadSourceHash(source), before);
});
test('payload reuse invalidates actual module, runtime, builder, toolchain and lock inputs', () => {
  const names = ['modules/mcp/src/index.ts', 'modules/project-setup/src-tauri/src/lib.rs',
    'modules/mcp/scripts/stage-node-runtime.mjs', 'modules/mcp/unity-extension/Editor/BanterMCPBridge.cs',
    'modules/mcp/package-lock.json', 'native/mcp-router/src/main.rs', 'scripts/build-unified.cjs',
    'scripts/managed-router-package.cjs', 'scripts/mcp-runtime-descriptor.cjs', 'src-tauri/tauri.conf.json',
    'package-lock.json', 'rust-toolchain.toml', '.cargo/config.toml'];
  for (const name of names) {
    assert.equal(c.payloadSourcePath(name), true, name);
    const source = sourceRows(names.slice()), before = c.payloadSourceHash(source);
    source.files.find(file => file.path === name).sha256 = sha('e');
    assert.notEqual(c.payloadSourceHash(source), before, name);
  }
});
test('Cargo cache is reusable across immutable candidate output directories', () => {
  const root = path.resolve('product'), first = c.buildPaths(root, path.resolve('candidate-one')),
    second = c.buildPaths(root, path.resolve('candidate-two'));
  assert.equal(first.target, path.join(root, 'src-tauri/target'));
  assert.equal(first.target, second.target); assert.notEqual(first.artifact, second.artifact);
  assert.equal(c.sourcePath('src-tauri/target/release/creator-hub.exe'), false);
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-artifact-candidate.yml'), 'utf8');
  assert.match(workflow, /Swatinem\/rust-cache@v2/); assert.match(workflow, /workspaces: product\/src-tauri/);
  assert.match(workflow, /shared-key: windows-artifact-root-016/); assert.match(workflow, /cache-on-failure: true/);
  assert.doesNotMatch(workflow, /shared-key:[^\n]*(source_manifest|run_id)/);
});
test('artifact admission pins exact successful same-repository producer', () => {
  const { artifact, run } = apiPair(); assert.deepEqual(c.bindArtifact(input(), artifact, run, 'candidate'), bound());
});
for (const [name, change] of Object.entries({ expired: (a) => { a.expired = true; },
  digest: a => { a.digest = `sha256:${sha('d')}`; }, name: a => { a.name = 'local-candidate'; },
  run: a => { a.workflow_run.id++; }, head: a => { a.workflow_run.head_sha = 'b'.repeat(40); },
  size: a => { a.size_in_bytes = 1024 ** 3; }, failure: (a, r) => { r.conclusion = 'failure'; },
  running: (a, r) => { r.status = 'in_progress'; }, foreign: (a, r) => { r.head_repository.full_name = 'other/repo'; },
  workflow: (a, r) => { r.path = '.github/workflows/other.yml'; }, attempt: (a, r) => { r.run_attempt = 0; } })) {
  test(`artifact admission refuses ${name}`, () => {
    const { artifact, run } = apiPair(); change(artifact, run);
    assert.throws(() => c.bindArtifact(input(), artifact, run, 'candidate'));
  });
}
test('candidate binds installer, extracted image, raw image, embedded manifest and source receipt', t => {
  const f = candidate(t);
  assert.deepEqual(c.verifyCandidate(f.directory, f.binding.receiptSha256, f.receipt.source, f.binding), f.receipt);
});
for (const field of ['localCandidateEquivalent', 'installed', 'signedUpdateAccepted', 'releaseReady']) {
  test(`candidate cannot claim ${field}`, t => {
    const f = candidate(t); f.receipt[field] = true; const binding = f.save();
    assert.throws(() => c.verifyCandidate(f.directory, binding.receiptSha256, f.receipt.source, binding));
  });
}
test('candidate refuses byte tampering and unlisted files before installer execution', t => {
  const f = candidate(t); put(path.join(f.directory, c.ASSET), 'tampered');
  assert.throws(() => c.verifyCandidate(f.directory, f.binding.receiptSha256, f.receipt.source, f.binding));
  f.receipt.files[c.ASSET] = c.record(path.join(f.directory, c.ASSET)); const binding = f.save();
  put(path.join(f.directory, 'unexpected.txt'), 'extra');
  assert.throws(() => c.verifyCandidate(f.directory, binding.receiptSha256, f.receipt.source, binding));
});
test('candidate refuses matching file hashes when installed image differs beyond NSIS marker', t => {
  const f = candidate(t); put(path.join(f.directory, 'creator-hub.exe'), 'wrong image');
  f.receipt.files['creator-hub.exe'] = c.record(path.join(f.directory, 'creator-hub.exe')); const binding = f.save();
  assert.throws(() => c.verifyCandidate(f.directory, binding.receiptSha256, f.receipt.source, binding), /bundle marker/);
});
test('candidate refuses source, producer, unsigned-payload and embedded-manifest substitution', t => {
  const f = candidate(t);
  assert.throws(() => c.verifyCandidate(f.directory, f.binding.receiptSha256, { ...f.receipt.source, commit: 'b'.repeat(40) }, f.binding));
  assert.throws(() => c.verifyCandidate(f.directory, f.binding.receiptSha256, f.receipt.source, { ...f.binding, runAttempt: 2 }));
  f.receipt.managedSignaturesVerified = false; let binding = f.save();
  assert.throws(() => c.verifyCandidate(f.directory, binding.receiptSha256, f.receipt.source, binding));
  f.receipt.managedSignaturesVerified = true; put(path.join(f.directory, 'builtin-manifest.json'), '{}');
  f.receipt.files['builtin-manifest.json'] = c.record(path.join(f.directory, 'builtin-manifest.json')); binding = f.save();
  assert.throws(() => c.verifyCandidate(f.directory, binding.receiptSha256, f.receipt.source, binding), /embed/);
});

// Execute only mocked OS protocols against temporary files. Never set real host guards or launch an installer.
function protocol(t, mode, failure) {
  const logging = t.mock.method(console, 'log', () => {});
  const f = candidate(t), env = { SOURCE_COMMIT: rev, SOURCE_MANIFEST_SHA256: f.receipt.source.manifestSha256,
    CREATOR_WINDOWS_ARTIFACT_INSTALL: '1', LOCALAPPDATA: path.join(f.root, 'local'), APPDATA: path.join(f.root, 'roaming') };
  const hub = path.join(env.LOCALAPPDATA, 'Creator Hub/creator-hub.exe'), calls = [];
  let version = null, resources = 0, guards = 0;
  const execute = (command, args) => {
    calls.push({ command, args });
    if (command === 'powershell.exe') return JSON.stringify(version ? [{ name: 'Creator Hub', version }] : []);
    if (command === 'curl.exe') { put(args[args.indexOf('--output') + 1], failure === 'download' ? 'bad' : 'baseline installer'); return; }
    if (command.endsWith('public14.exe')) { assert.deepEqual(args, ['/S', '/NS']); put(hub, 'baseline image'); version = BASELINE.version; return; }
    assert.equal(command, path.join(f.directory, c.ASSET));
    assert.deepEqual(args, mode === 'guarded' ? ['/UPDATE', '/S', '/NS'] : ['/S', '/NS']);
    put(hub, f.installed); version = c.VERSION;
    if (failure === 'settings') put(path.join(env.APPDATA, 'banter-mcp/launcher-config.json'), '{}');
  };
  const fakeContract = { ...c, assertRunner: () => { guards++; },
    hash: bytes => String(bytes) === 'baseline installer' ? BASELINE.installer : String(bytes) === 'baseline image' ? BASELINE.exe : c.hash(bytes) };
  const file = path.join(__dirname, 'windows-artifact-install.cjs'), module = new Module(file);
  module.require = name => {
    if (name === './windows-artifact-candidate.cjs') return fakeContract;
    if (name === './windows-incoming-016.cjs') return { BASELINE };
    if (name === './installer-payload.cjs') return { extract: (installer, output) => {
      const image = path.join(output, 'creator-hub.exe'); put(image, f.installed); return image;
    } };
    if (name === './build-unified.cjs') return { verifyStage: directory => {
      assert.equal(directory, path.join(env.LOCALAPPDATA, 'Creator Hub/modules')); resources++;
      if (failure === 'resources') throw Error('Wrong installed resource');
    } };
    if (name === 'node:child_process') return { execFileSync: () => { throw Error('Real OS execution forbidden'); } };
    assert.ok(['node:assert/strict', 'node:fs', 'node:path'].includes(name)); return require(name);
  };
  module._compile(fs.readFileSync(file, 'utf8'), file);
  const exitCode = process.exitCode; let report;
  try { report = module.exports.run(mode, f.directory, f.binding, path.join(f.root, 'evidence'), env, execute); }
  finally { process.exitCode = exitCode; logging.mock.restore(); }
  assert.equal(guards, 1);
  assert.equal(report.passed, !failure); assert.equal(report.signedUpdateAccepted, false);
  assert.equal(report.nativeGuiAccepted, false); assert.equal(report.automaticRestartAccepted, false); assert.equal(report.releaseReady, false);
  assert.equal(resources, failure === 'download' ? 0 : 1);
  if (failure === 'download') assert.equal(calls.filter(call => call.command.endsWith('.exe') && !['powershell.exe', 'curl.exe'].includes(call.command)).length, 0);
  return { report, calls };
}
for (const mode of ['fresh', 'guarded']) test(`mocked ${mode} protocol preserves settings and records only installer acceptance`, t => {
  const { report, calls } = protocol(t, mode);
  assert.equal(report.settingsPreserved, true); assert.equal(report.freshInstallAccepted, mode === 'fresh');
  assert.equal(report.guardedInstallerAccepted, mode === 'guarded');
  assert.equal(calls.some(call => call.command === 'curl.exe'), mode === 'guarded');
});
for (const failure of ['download', 'settings', 'resources']) test(`mocked guarded protocol refuses ${failure} corruption`, t => protocol(t, 'guarded', failure));
test('native inline PowerShell parses without executing registry or image inspection', { skip: process.platform !== 'win32' }, () => {
  let registry;
  require('./windows-artifact-install.cjs').registrations((command, args) => { registry = args.at(-1); return '[]'; });
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors);if($errors.Count){$errors|Out-String|Write-Error;exit 1}'],
  { input: registry + '\n[Diagnostics.FileVersionInfo]::GetVersionInfo($env.CREATOR_CANDIDATE_IMAGE).ProductVersion',
    encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});
test('workflow is Windows-only, read-only, dispatch-only for native operations, and produces no release', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-artifact-candidate.yml'), 'utf8');
  assert.match(workflow, /contents: read\s+actions: read/);
  assert.equal((workflow.match(/github.event_name == 'workflow_dispatch'/g) || []).length, 2);
  assert.equal((workflow.match(/runs-on: windows-latest/g) || []).length, 3);
  assert.match(workflow, /mode: \[fresh, guarded\]/); assert.match(workflow, /artifact-ids:/);
  assert.doesNotMatch(workflow, /contents: write|secrets\.|gh release|git push|workflow run|macos-latest|ubuntu-latest/);
});
test('producer retains source checks around cache reuse and mandatory existing cryptographic verifiers', () => {
  const source = fs.readFileSync(path.join(__dirname, 'windows-artifact-candidate.cjs'), 'utf8');
  const production = source.slice(source.indexOf('function produce('), source.indexOf('function main('));
  assert.equal((production.match(/assertSource\(root,/g) || []).length, 3);
  assert.match(production, /verify-package-input\.exe/); assert.match(production, /verify-managed-runtime\.exe/);
  assert.ok(production.indexOf('verify-managed-runtime.exe') < production.indexOf('tauri.js'));
  assert.match(production, /verifyPayload\(root, payload, binding, source\)/);
  assert.match(production, /CARGO_TARGET_DIR: target/); assert.match(production, /Immutable output already exists/);
  assert.doesNotMatch(production, /signingKey|signDetached|git.*(?:commit|push)/);
});
