'use strict';
// Pure/refusal checks and optional data-only measurement of the retained actual bundle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const c = require('./native-linux-production-016-flatpak.cjs');
const p = require('./flatpak-native-production-016.cjs');
const ROOT = path.resolve(__dirname, '..');
const ENV = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: p.REPO, GITHUB_REPOSITORY_ID: String(p.REPO_ID), GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: c.BRANCH, GITHUB_WORKFLOW_REF: `${p.REPO}/${c.WORKFLOW}@${c.BRANCH}`,
  GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' };

function profile() {
  // Structural fixture only: these made-up pins cannot authorize execution.
  const pin = { size: 100, sha256: 'a'.repeat(64) };
  const files = Object.fromEntries(['package-receipt.json', 'Creator Hub_0.1.16_amd64.AppImage',
    'Creator.Hub.Native.Support_0.1.16_amd64.AppImage', 'portable-manifest.unsigned.json',
    'creator-hub-linux-x86_64-0.1.16.appdir.tar.gz', 'appdir-original-inventory.json',
    'appdir-flattened-inventory.json'].map(name => [name, { ...pin }]));
  return { schemaVersion: 1, profile: c.PROFILE, mode: 'bootstrap-activation', portable: {
    sourceCommit: 'b'.repeat(40), sourceTree: 'c'.repeat(40), packagingCommit: 'd'.repeat(40), packagingTree: 'e'.repeat(40),
    runId: 10, runAttempt: 1, jobId: 11, artifactId: 12, zip: { ...pin }, files } };
}
function proof(expected) {
  const repo = { id: p.REPO_ID, full_name: p.REPO };
  return { run: { id: expected.runId, run_attempt: expected.runAttempt, head_sha: expected.harnessSource,
    head_branch: expected.branch, path: expected.workflow, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    repository: repo, head_repository: repo },
  job: { id: expected.jobId || 20, run_id: expected.runId, run_attempt: expected.runAttempt,
    head_sha: expected.harnessSource, name: 'package', status: 'completed', conclusion: 'success', labels: ['ubuntu-22.04'],
    started_at: '2026-10-20T00:00:00Z', completed_at: '2026-10-20T00:05:00Z' },
  artifact: { id: expected.artifactId, name: expected.artifactName, expired: false, size_in_bytes: expected.zip.size,
    digest: `sha256:${expected.zip.sha256}`, created_at: '2026-10-20T00:04:00Z', workflow_run: {
      id: expected.runId, head_sha: expected.harnessSource, head_branch: expected.branch,
      repository_id: p.REPO_ID, head_repository_id: p.REPO_ID } },
  commit: { sha: expected.harnessSource, tree: { sha: expected.harnessTree } } };
}
function flatpakProof() {
  return proof({ ...c.FIXED, branch: p.BRANCH.slice('refs/heads/'.length), workflow: p.WORKFLOW,
    artifactName: `linux-016-production-flatpak-${c.FIXED.runId}-${c.FIXED.runAttempt}` });
}

function harnessFixture(actual = false) {
  const bytes = Object.fromEntries(c.HARNESS_FILES.map(name => [name,
    actual ? fs.readFileSync(path.join(ROOT, name)) : Buffer.from(`synthetic diagnostic source ${name}\n`)]));
  const contents = Object.fromEntries(c.HARNESS_FILES.map(name => {
    const raw = bytes[name];
    return [name, { type: 'file', encoding: 'base64', path: name, name: path.posix.basename(name), size: raw.length,
      sha: crypto.createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex'), content: raw.toString('base64') + '\n' }];
  }));
  return { contents, bytes };
}

test('diagnostic imports require the closed four-file inventory and independently matching remote bytes', () => {
  assert.deepEqual(c.HARNESS_FILES, ['scripts/native-linux-production-016-flatpak.py', 'scripts/native-linux-production-016-flatpak.test.py',
    'scripts/native-linux-flatpak-activation-observer.py', 'scripts/native-linux-flatpak-activation-observer.test.py']);
  const { contents, bytes } = harnessFixture(), pins = c.harnessPins(contents, bytes);
  assert.deepEqual(pins, Object.fromEntries(c.HARNESS_FILES.map(name => [name, c.pin(bytes[name])])));
  assert.deepEqual(c.verifyHarness(pins, bytes), pins);
  const first = c.HARNESS_FILES[0];
  for (const mutate of [value => { delete value[first]; }, value => { value['scripts/foreign.py'] = value[first]; }]) {
    const values = structuredClone(contents); mutate(values); assert.throws(() => c.harnessPins(values, bytes));
    const values2 = structuredClone(pins); mutate(values2); assert.throws(() => c.verifyHarness(values2, bytes));
  }
  assert.throws(() => c.verifyHarness(pins, { ...bytes, [first]: Buffer.from('changed local source') }));
  assert.throws(() => c.verifyHarness({ ...pins, [first]: { ...pins[first], size: 1024 * 1024 + 1 } }, bytes));
});

test('contents admission rejects aliases, metadata drift, corrupt base64, large files and wrong blob identities', () => {
  const { contents, bytes } = harnessFixture(), first = c.HARNESS_FILES[0];
  for (const mutate of [v => { v.type = 'symlink'; }, v => { v.encoding = 'none'; }, v => { v.path = 'other.py'; },
    v => { v.name = 'other.py'; }, v => { v.size++; }, v => { v.size = 1024 * 1024 + 1; }, v => { v.sha = 'f'.repeat(40); },
    v => { v.target = 'foreign.py'; }, v => { v.submodule_git_url = 'https://example.invalid/repo'; },
    v => { v.content += '!'; }, v => { v.content = 'YQ'; }, v => { v.content = 'A'.repeat(1500001); }]) {
    const changed = structuredClone(contents); mutate(changed[first]); assert.throws(() => c.harnessPins(changed, bytes));
  }
});

test('harness collection requests only exact immutable commit refs and never download URLs', async () => {
  const { contents } = harnessFixture(true), calls = [], commit = 'a'.repeat(40);
  const get = async (api, args) => { calls.push({ api, args }); return contents[args.path]; };
  const pins = await c.collectHarness(get, commit);
  assert.deepEqual(Object.keys(pins), c.HARNESS_FILES);
  assert.deepEqual(calls, c.HARNESS_FILES.map(name => ({ api: ['repos', 'getContent'], args: { path: name, ref: commit } })));
  let requests = 0;
  await assert.rejects(c.collectHarness(async () => { requests++; return {}; }, 'HEAD'));
  assert.equal(requests, 0);
  await assert.rejects(c.collectHarness(async () => { requests++; throw Error('API unavailable'); }, commit));
  assert.equal(requests, 1);
});

test('native observer checks are mandatory before immutable data collection or native execution', () => {
  const workflow = fs.readFileSync(path.join(ROOT, c.WORKFLOW), 'utf8');
  const command = 'python3 -B scripts/native-linux-flatpak-activation-observer.test.py';
  assert.equal(workflow.split(command).length, 2);
  assert.ok(workflow.indexOf(command) < workflow.indexOf('await lane.collect('));
  assert.ok(workflow.indexOf(command) < workflow.indexOf('flatpak.py session'));
});
test('controller admits only one manual unprivileged native branch and refuses environment injection', () => {
  c.admission(ENV, 'linux', 'x64', 1001);
  for (const key of Object.keys(ENV)) assert.throws(() => c.admission({ ...ENV, [key]: 'wrong' }, 'linux', 'x64', 1001));
  for (const [system, arch, uid] of [['win32', 'x64', 1001], ['linux', 'arm64', 1001], ['linux', 'x64', 0]]) {
    assert.throws(() => c.admission(ENV, system, arch, uid));
  }
  for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'FLATPAK_ID', 'APPIMAGE', 'APPDIR', 'LD_PRELOAD', 'NODE_OPTIONS',
    'PYTHONPATH', 'SSL_CERT_FILE', 'https_proxy', 'CREATOR_HUB_SIGNING_KEY', 'TAURI_WEBVIEW_AUTOMATION']) {
    assert.throws(() => c.admission({ ...ENV, [key]: 'refuse' }, 'linux', 'x64', 1001), key);
  }
});
test('only the separate production portable profile is structurally admitted, without an execution path', () => {
  c.validateProfile(profile());
  for (const mutate of [v => { v.mode = 'update'; }, v => { v.profile = 'integrated-candidate'; },
    v => { v.update17 = {}; }, v => { delete v.portable.sourceTree; }, v => { v.portable.zip.size = 1024 ** 3; },
    v => { v.portable.files.extra = v.portable.zip; }, v => { v.portable.runId = -1; },
    v => { v.portable.files['Creator.Hub.Native.Support_0.1.16_amd64.AppImage'].sha256 = 'b'.repeat(64); }]) {
    const v = profile(); mutate(v); assert.throws(() => c.validateProfile(v));
  }
  assert.throws(c.runtimeUnavailable, /not enabled/);
  assert.ok(Object.values(c.FALSE_GATES).every(value => value === false));
});
test('actual Flatpak producer API identity is immutable and rejects stale, failed, foreign or mismatched jobs', () => {
  const actual = flatpakProof();
  assert.equal(c.flatpakAPI(actual).artifactId, 12231574692);
  for (const mutate of [v => { v.run.conclusion = 'failure'; }, v => { v.run.path = '.github/workflows/flatpak-native-activation.yml'; },
    v => { v.run.head_sha = 'f'.repeat(40); }, v => { v.commit.tree.sha = 'f'.repeat(40); },
    v => { v.job.run_id++; }, v => { v.job.head_sha = 'f'.repeat(40); }, v => { v.job.run_attempt++; },
    v => { v.job.name = 'other'; }, v => { v.artifact.id++; }, v => { v.artifact.digest = 'sha256:' + 'f'.repeat(64); },
    v => { v.artifact.workflow_run.head_repository_id++; }, v => { v.artifact.created_at = '2026-10-20T01:00:00Z'; },
    v => { v.artifact.expired = true; }]) {
    const v = structuredClone(actual); mutate(v); assert.throws(() => c.flatpakAPI(v));
  }
});
test('future portable output must come from its actual production workflow and all independently supplied API pins', () => {
  const input = profile(), value = input.portable;
  const expected = { ...value, harnessSource: value.packagingCommit, harnessTree: value.packagingTree,
    branch: 'validation/linux-016-portable-production', workflow: '.github/workflows/linux-016-portable-production.yml',
    artifactName: `linux-016-production-portable-unsigned-${value.runId}-${value.runAttempt}` };
  const actual = proof(expected); c.portableAPI(actual, input);
  for (const mutate of [v => { v.run.path = '.github/workflows/linux-016-portable-package.yml'; },
    v => { v.run.head_branch = 'validation/linux-016-portable-package'; }, v => { v.job.id++; },
    v => { v.commit.tree.sha = value.sourceTree; }, v => { v.artifact.name = 'old-prototype'; }]) {
    const v = structuredClone(actual); mutate(v); assert.throws(() => c.portableAPI(v, input));
  }
  const workflow = fs.readFileSync(path.join(ROOT, expected.workflow), 'utf8');
  assert.ok(workflow.includes('name: linux-016-production-portable-unsigned-${{ github.run_id }}-${{ github.run_attempt }}'));
});
test('final016 host source remains independent of the immutable actual c13 launcher', () => {
  // API-shape fixture only, not a replacement for the actual output byte gate.
  const input = profile();
  Object.assign(input.portable, { sourceCommit: 'ff3053539e96d3b6af5612a8308d4bda7af773e5',
    sourceTree: 'a9c5c920e929bd125e359e50da4e742e9704a75c',
    packagingCommit: '1a426f01a24afd6dcf569db0e5bf30b50c423222',
    packagingTree: 'e0bc409cace402f0a2deec338d62677e190a48bc', runId: 39365532397,
    runAttempt: 1, jobId: 118441408232, artifactId: 12239775115 });
  const p = input.portable;
  c.portableAPI(proof({ ...p, harnessSource: p.packagingCommit, harnessTree: p.packagingTree,
    branch: 'validation/linux-016-portable-production', workflow: '.github/workflows/linux-016-portable-production.yml',
    artifactName: `linux-016-production-portable-unsigned-${p.runId}-${p.runAttempt}` }), input);
  c.flatpakAPI(flatpakProof());
  assert.equal(c.FIXED.runId, 39348943839);
  assert.equal(c.FIXED.sourceCommit, 'c13cb9ef3b9116ea5ffb1f6cf8250becf5fd49e7');
  assert.notEqual(p.sourceCommit, c.FIXED.sourceCommit);
});
test('data admission cannot install, compile, launch or sign, including its CLI', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-linux-production-016-flatpak.cjs'), 'utf8');
  for (const forbidden of ['child_process', 'execFile', 'spawn(', 'eval(', 'flatpak-spawn', 'startLabProxy', 'minisign -S']) {
    assert.ok(!source.includes(forbidden), forbidden);
  }
  const result = cp.spawnSync(process.execPath, [path.join(__dirname, 'native-linux-production-016-flatpak.cjs')],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 1); assert.match(result.stderr, /No candidate has been executed/);
});
test('signed-input delivery is bounded data only and its successful carrier is not signature authority', () => {
  const input = { schemaVersion: 1, runId: 10, artifactId: 12, sourceCommit: 'a'.repeat(40), zip: { size: 100, sha256: 'b'.repeat(64) },
    files: Object.fromEntries(c.SIGNED_FILES.map(name => [name, { size: 100, sha256: 'c'.repeat(64) }])) };
  c.signedInput(input);
  const record = proof({ runId: 10, runAttempt: 1, jobId: 11, artifactId: 12, harnessSource: input.sourceCommit,
    harnessTree: 'd'.repeat(40), branch: 'any-data-only-carrier', workflow: '.github/workflows/data-only.yml',
    artifactName: 'not-authority', zip: input.zip });
  c.carrier(record, input);
  for (const mutate of [v => { v.run.head_sha = 'f'.repeat(40); }, v => { v.run.conclusion = 'failure'; },
    v => { v.artifact.workflow_run.head_repository_id++; }, v => { v.artifact.digest = 'sha256:' + 'f'.repeat(64); }]) {
    const value = structuredClone(record); mutate(value); assert.throws(() => c.carrier(value, input));
  }
  for (const mutate of [v => { v.signaturesVerified = true; }, v => { v.files.extra = v.zip; },
    v => { v.zip.size = 9 * 1024 * 1024; }, v => { v.files[c.SIGNED_FILES[1]].size = 4097; }]) {
    const value = structuredClone(input); mutate(value); assert.throws(() => c.signedInput(value));
  }
});
const directory = path.join(ROOT, 'artifacts/release-016-updater-20261019/flatpak-production-016-39348943839');
test('retained actual three-file output matches independent pins, complete inventory and original source blobs', {
  skip: fs.existsSync(directory) ? false : 'Retained actual output absent; pure tests do not replace a native input gate',
}, () => {
  // Parent may retain independent evidence beside the three selected original members.
  if (fs.existsSync(path.join(directory, 'original.zip'))) c.bound(fs.readFileSync(path.join(directory, 'original.zip')), c.FIXED.zip);
  const bytes = Object.fromEntries(Object.keys(c.FIXED.files).map(name => [name, fs.readFileSync(path.join(directory, name))]));
  const sources = Object.fromEntries(p.SOURCES.map(name => [name,
    cp.execFileSync('git', ['show', `${c.FIXED.sourceCommit}:${name}`], { cwd: ROOT, timeout: 10000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })]));
  const admitted = c.flatpakFiles(bytes, sources);
  assert.equal(admitted.commit, 'fd8aa52965d4ce2e4a4a0c8d58d901bf20b2d3b059916799502ea24891c2bb90');
  assert.ok(Object.keys(c.FALSE_GATES).every(name => admitted[name] === false));
  const changed = { ...bytes, [p.COMMAND]: Buffer.from(bytes[p.COMMAND]) }; changed[p.COMMAND][20] ^= 1;
  assert.throws(() => c.flatpakFiles(changed, sources), /byte pin differs/);
  assert.throws(() => c.flatpakFiles({ ...bytes, unlisted: Buffer.from('refuse') }, sources));
  const drift = { ...sources, [p.KEY]: Buffer.from('untrusted replacement key') };
  assert.throws(() => c.flatpakFiles(bytes, drift), /byte pin differs/);
});
