'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
const { parseArgs, hostedRoot, requestIdentity, validateBinding, initialReport, finalizeReport,
  inventorySnapshot, parsePs, ocrLines, fixtureMetadata, permissionMetadata, EXTRACT_DEB,
  Experiment, PHASES, PROBE_FILES, REVIEWED_TEST_ONLY_FILES, TREE_EXCLUSIONS,
  REPO, APP, PLATFORM, FIXTURE_RUNTIME } = require('./flatpak-native-smoke.cjs');

const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const SOURCE = '6d47bd0790cfc5c3560495bbd92c37b3cd06df14';
const MERGE = 'cb7499b592b4260f6733b7ff5ef7c670f74233a0';
const TREE = '8b1deb17843f753f7b6fe5cf3560412ed8b541d9';
const ARCHIVE_SHA = '681ef6fcb50f77f588f6f9e88a13fbbf9545b56ba6473f4fe749c3a6a22f44d1';
const DEB_SHA = '57ff363701a49c8d603efb677a3720ddc5c2b2443a9b019f0afd5be922ac5374';
function options() {
  return { 'source-run': '38393759689', 'source-commit': SOURCE, 'artifact-id': '11810908524',
    'artifact-sha256': ARCHIVE_SHA, 'artifact-bytes': '96940196', 'deb-sha256': DEB_SHA, 'deb-bytes': '5975036' };
}
function binding() {
  return {
    run: { id: 38393759689, repository: { id: 1364807512, full_name: REPO },
      head_repository: { full_name: REPO }, event: 'pull_request', path: '.github/workflows/ci.yml',
      status: 'completed', conclusion: 'success', head_sha: SOURCE, head_branch: 'fix/hub-013-platform-flatpak',
      run_attempt: 1, pull_requests: [{ number: 22, base: { repo: { id: 1364807512 } }, head: { repo: { id: 1364807512 } } }] },
    artifact: { id: 11810908524, name: `hub-development-Linux-X64-${MERGE}`, digest: `sha256:${ARCHIVE_SHA}`,
      size_in_bytes: 96940196, expired: false, workflow_run: { id: 38393759689, head_sha: SOURCE,
        repository_id: 1364807512, head_repository_id: 1364807512 } },
    commit: { sha: MERGE, parents: [{ sha: '35a16a45814d821d65b5d203628478449174cd55' }, { sha: SOURCE }],
      commit: { message: `Merge ${SOURCE} into 35a16a45814d821d65b5d203628478449174cd55`, tree: { sha: TREE } } },
    source: { sha: SOURCE, commit: { tree: { sha: TREE } } },
    linuxJob: { name: 'Hub (Linux)', conclusion: 'success', run_id: 38393759689, run_attempt: 1 },
  };
}
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flatpak-probe-unit-'));
  t.after(() => {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('CLI is strict and all artifact/native pins are independently mandatory', () => {
  assert.deepEqual(parseArgs(['run', '--root', '/tmp/example']), { mode: 'run', root: '/tmp/example' });
  for (const args of [[], ['install'], ['run', '--root'], ['run', '--force', 'yes'],
    ['run', '--root', 'a', '--root', 'b'], ['run', '--root', '--force']]) assert.throws(() => parseArgs(args));
  const requested = requestIdentity(options());
  assert.equal(requested.debBytes, 5975036);
  for (const key of Object.keys(options())) {
    for (const value of [undefined, '', 'invalid', '-1', `${options()[key]}\n`]) {
      assert.throws(() => requestIdentity({ ...options(), [key]: value }), key);
    }
  }
});

test('no Windows/WSL/self-hosted/other-repository or arbitrary installation roots', t => {
  const temp = temporary(t);
  const root = path.join(temp, 'creator-flatpak-validation');
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux',
    RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: REPO, RUNNER_TEMP: temp };
  assert.equal(hostedRoot({ root }, env, 'linux', 'x64'), root);
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'arm64'], ['darwin', 'x64']]) {
    assert.throws(() => hostedRoot({ root }, env, platform, arch));
  }
  for (const key of Object.keys(env)) assert.throws(() => hostedRoot({ root }, { ...env, [key]: 'other' }, 'linux', 'x64'));
  assert.throws(() => hostedRoot({ root: temp }, env, 'linux', 'x64'));
  const linked = path.join(temp, 'linked');
  fs.symlinkSync(temp, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => hostedRoot({ root: path.join(linked, 'creator-flatpak-validation') },
    { ...env, RUNNER_TEMP: linked }, 'linux', 'x64'), /Link/);
});

test('actual CLI refuses local execution before reserving outputs or invoking install tools', t => {
  const root = path.join(temporary(t), 'never-created');
  const result = spawnSync(process.execPath, [require.resolve('./flatpak-native-smoke.cjs'), 'run', '--root', root], {
    env: { ...process.env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Only disposable GitHub-hosted Linux x86_64/);
  assert.equal(fs.existsSync(root), false);
});

test('exact reviewed run accepts its different PR merge SHA only with matching source tree', () => {
  const receipt = validateBinding(binding(), requestIdentity(options()));
  assert.notEqual(receipt.sourceCommit, receipt.buildCommit);
  assert.equal(receipt.sourceTree, TREE);
  assert.equal(receipt.artifactDigest, `sha256:${ARCHIVE_SHA}`);
});

for (const [label, mutate] of [
  ['wrong run', b => { b.run.id++; }], ['wrong repository', b => { b.run.repository.full_name = 'other/repo'; }],
  ['fork', b => { b.run.head_repository.full_name = 'fork/repo'; }],
  ['wrong source', b => { b.run.head_sha = MERGE; }], ['unfinished', b => { b.run.status = 'in_progress'; }],
  ['failed run', b => { b.run.conclusion = 'failure'; }], ['other workflow', b => { b.run.path = '.github/workflows/release.yml'; }],
  ['wrong PR', b => { b.run.pull_requests[0].number = 21; }],
  ['foreign PR base', b => { b.run.pull_requests[0].base.repo.id++; }],
  ['foreign PR head', b => { b.run.pull_requests[0].head.repo.id++; }], ['expired', b => { b.artifact.expired = true; }],
  ['wrong artifact', b => { b.artifact.id++; }], ['wrong digest', b => { b.artifact.digest = `sha256:${DEB_SHA}`; }],
  ['wrong size', b => { b.artifact.size_in_bytes--; }], ['artifact from other run', b => { b.artifact.workflow_run.id++; }],
  ['artifact from other source', b => { b.artifact.workflow_run.head_sha = MERGE; }],
  ['artifact from fork', b => { b.artifact.workflow_run.head_repository_id++; }],
  ['wrong arch', b => { b.artifact.name = b.artifact.name.replace('X64', 'ARM64'); }],
  ['merge parents', b => { b.commit.parents[1].sha = 'a'.repeat(40); }],
  ['merge message', b => { b.commit.commit.message = 'unrelated'; }],
  ['product tree drift', b => { b.commit.commit.tree.sha = 'a'.repeat(40); }],
  ['Linux failed', b => { b.linuxJob.conclusion = 'failure'; }], ['wrong attempt', b => { b.linuxJob.run_attempt++; }],
]) {
  test(`binding fails closed: ${label}`, () => {
    const b = binding(); mutate(b);
    assert.throws(() => validateBinding(b, requestIdentity(options())));
  });
}

test('failed/pending workflow reports retain original errors and can never authorize release', () => {
  const report = initialReport(requestIdentity(options()));
  report.failures.push({ phase: 'build-export', message: 'original diagnostic' });
  report.releaseReady = true;
  finalizeReport(report, 'cancelled');
  assert.equal(report.releaseReady, false);
  assert.equal(report.status, 'failed');
  assert.equal(report.failures[0].message, 'original diagnostic');
  assert.equal(report.checks.filter(c => c.status === 'blocked').length, PHASES.length);
  const complete = initialReport();
  complete.checks.forEach(c => { c.status = 'passed'; });
  assert.equal(finalizeReport(complete, 'success').status, 'experimental-blocked');
  assert.equal(complete.releaseReady, false);
  assert.equal(complete.fixture.artifactVersion, '0.1.13');
  assert.equal(complete.fixture.currentSourceVersion, '0.1.13');
  assert.match(complete.fixture.scope, /^same-version OSTree generation update/);
  assert.ok(complete.blockers.length > 0);
});

test('command failures/timeouts and phase exceptions are written before propagation', async t => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, 'evidence'));
  const report = initialReport();
  const runner = new Experiment(root, report, () => ({ status: null, stdout: '', stderr: 'retained stderr', error: { code: 'ETIMEDOUT', message: 'timeout' } }));
  await assert.rejects(runner.phase('build-export', () => runner.command('flatpak-builder', ['fixture'])), /failed/);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'evidence/report.json')));
  assert.equal(saved.releaseReady, false);
  assert.equal(saved.checks.find(c => c.name === 'build-export').status, 'failed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'evidence/commands.json')))[0].stderr, 'retained stderr');
  const long = new Experiment(root, report, () => ({ status: 0, stdout: 'x'.repeat(100000), stderr: '' }));
  assert.equal(long.command('fixture', []).stdout.length, 100000, 'Evidence consumers get complete output, not a log tail');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'evidence/commands.json')))[0].stdout.length, 65536);
});

test('coexisting reviewed platform probes and Windows baselines preserve the exact 6d47 product binding', t => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, 'evidence'));
  const old = process.env.VALIDATION_HARNESS_COMMIT;
  process.env.VALIDATION_HARNESS_COMMIT = MERGE;
  t.after(() => { if (old === undefined) delete process.env.VALIDATION_HARNESS_COMMIT; else process.env.VALIDATION_HARNESS_COMMIT = old; });
  const coexistenceFixture = [...PROBE_FILES,
    'scripts/native-linux-maintenance-smoke.cjs', 'scripts/native-linux-maintenance-smoke.test.cjs',
    'scripts/native-linux-window.py', '.github/workflows/linux-maintenance-validation.yml',
    'scripts/native-mac-maintenance-smoke.cjs', 'scripts/native-mac-maintenance-smoke.test.cjs',
    'scripts/native-mac-window.swift', '.github/workflows/mac-maintenance-validation.yml',
    'docs/MAC-MAINTENANCE-VALIDATION.md', '.github/workflows/windows-candidate.yml',
    'scripts/Test-InstalledCandidate.ps1', 'scripts/self-update-baselines.test.cjs',
  ];
  assert.equal(PROBE_FILES.length, 4, 'Do not widen the workflow trigger scope');
  assert.deepEqual(TREE_EXCLUSIONS, coexistenceFixture);
  assert.equal(new Set(TREE_EXCLUSIONS).size, 16);
  for (const files of [PROBE_FILES, REVIEWED_TEST_ONLY_FILES, TREE_EXCLUSIONS]) assert.ok(Object.isFrozen(files));
  let changed = coexistenceFixture.join('\n');
  let dirty = '';
  const run = (_tool, args) => {
    const command = args[2];
    let stdout = '';
    if (command === 'rev-parse') stdout = args[3] === 'HEAD^{commit}' ? MERGE : args[3].endsWith('^{tree}') ? TREE : SOURCE;
    if (command === 'diff') stdout = changed;
    if (command === 'status') stdout = dirty;
    return { status: 0, stdout, stderr: '' };
  };
  const e = new Experiment(root, initialReport(requestIdentity(options())), run);
  const accepted = e.tree();
  assert.equal(accepted.productTreeMatches, true);
  assert.equal(accepted.candidateCommit, SOURCE);
  assert.equal(accepted.sourceTree, TREE);
  assert.deepEqual(accepted.harnessOnlyChanges, coexistenceFixture);
  assert.deepEqual(accepted.excludedPaths, coexistenceFixture);
  for (const file of [
    'src/app.js', 'src-tauri/src/self_update.rs', 'src/icons/creator-plugins.png',
    'src-tauri/tauri.conf.json', 'src-tauri/Cargo.lock', 'package.json', 'package-lock.json',
    'scripts/flatpak-package.cjs', 'packaging/flatpak/payload.py', 'packaging/flatpak/runtime-50-evidence.json',
    '.github/workflows/ci.yml', 'scripts/native-linux-unreviewed-helper.py',
    '.github/workflows/mac-maintenance-validation.yml/unreviewed',
  ]) {
    changed = [...coexistenceFixture, file].join('\n');
    assert.throws(() => e.tree(), /outside the finite test-only exclusions/, file);
  }
  changed = '';
  dirty = ' M scripts/flatpak-package.cjs';
  assert.throws(() => e.tree(), /dirty/);
  dirty = '';
  process.env.VALIDATION_HARNESS_COMMIT = SOURCE;
  assert.throws(() => e.tree(), /head ref/);
});

test('protected snapshot catches content/mode drift without reading unrelated files', t => {
  const root = temporary(t);
  const file = path.join(root, 'protected.json');
  fs.writeFileSync(file, '{"preserve":true}');
  const before = inventorySnapshot([file]);
  fs.writeFileSync(file, '{"preserve":false}');
  assert.notDeepEqual(inventorySnapshot([file]), before);
  const directory = path.join(root, 'directory'); fs.mkdirSync(directory);
  assert.throws(() => inventorySnapshot([directory]));
});

test('runtime generation claims require actual empty OSTree filesystem differences', t => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, 'evidence'));
  let difference = '';
  const runner = new Experiment(root, initialReport(), (_tool, args) => {
    assert.deepEqual(args.slice(1), ['diff', '--fs-diff', 'a'.repeat(64), 'b'.repeat(64)]);
    return { status: 0, stdout: difference, stderr: '' };
  });
  assert.equal(runner.identicalRuntime('a'.repeat(64), 'b'.repeat(64)).filesystemDiffEmpty, true);
  difference = 'M /files/lib/changed.so';
  assert.throws(() => runner.identicalRuntime('a'.repeat(64), 'b'.repeat(64)), /filesystem changed/);
});

test('fixture changes only runtime selection, keeps metadata/XML version13 and has no native14 bytes', () => {
  const xml = fs.readFileSync(path.join(__dirname, '../packaging/flatpak/com.creatorworks.hub.metainfo.xml'), 'utf8');
  const metadata = '[Application]\nname=com.creatorworks.hub\nruntime=org.gnome.Platform/x86_64/50\nsdk=org.gnome.Sdk/x86_64/50\n';
  const changed = fixtureMetadata(metadata, xml);
  assert.match(changed.metadata, /runtime=org.gnome.Platform\/x86_64\/50-validation-fixture/);
  assert.equal(changed.xml, xml);
  assert.throws(() => fixtureMetadata(metadata.replace('/50\n', '/49\n'), xml));
});

test('installed minimal permissions are parsed structurally, not accepted by substring absence', () => {
  const metadata = '[Application]\nname=com.creatorworks.hub\n[Context]\nshared=ipc;network;\nsockets=wayland;fallback-x11;\ndevices=dri;\n';
  assert.equal(permissionMetadata(metadata).devices, 'dri;');
  for (const addition of ['filesystems=home;\n', 'features=devel;\n',
    '[Session Bus Policy]\norg.freedesktop.Flatpak=talk\n', '[Environment]\nWEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1\n']) {
    assert.throws(() => permissionMetadata(metadata + addition));
  }
  assert.throws(() => permissionMetadata(metadata.replace('wayland;fallback-x11;', 'session-bus;')));
});

function zipFixture(filename, entries) {
  execFileSync(PYTHON, ['-B', '-c', `
import json, stat, sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    for item in json.loads(sys.argv[2]):
        info = zipfile.ZipInfo(item['name'])
        info.filename = item['name']
        info.external_attr = item.get('mode', stat.S_IFREG | 0o644) << 16
        z.writestr(info, item.get('data','fixture'))
`, filename, JSON.stringify(entries)], { windowsHide: true });
}
test('bounded artifact extraction only writes the DEB; unsafe ZIP contracts fail closed', t => {
  const root = temporary(t);
  const archive = path.join(root, 'fixture.zip');
  zipFixture(archive, [{ name: 'deb/Creator Hub_0.1.13_amd64.deb' }, { name: 'rpm/fixture.rpm' }]);
  const destination = path.join(root, 'safe');
  const result = spawnSync(PYTHON, ['-B', '-c', EXTRACT_DEB, archive, destination], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(destination), ['native.deb']);
  for (const [index, entries] of [
    [{ name: '../escape.deb' }], [{ name: '/absolute.deb' }], [{ name: 'bad\\path.deb' }],
    [{ name: 'a.deb', mode: 0o120777 }], [{ name: 'a.deb', mode: 0o104755 }],
    [{ name: 'a.deb' }, { name: 'b.deb' }], [{ name: 'a.deb' }, { name: 'unexpected.txt' }],
    [{ name: 'a.deb' }, { name: 'a.deb' }], [{ name: 'a.deb', mode: 0o010644 }],
  ].entries()) {
    zipFixture(archive, entries);
    const output = path.join(root, `bad-${index}`);
    const refusal = spawnSync(PYTHON, ['-B', '-c', EXTRACT_DEB, archive, output], { windowsHide: true });
    assert.notEqual(refusal.status, 0, JSON.stringify(entries));
    assert.equal(fs.existsSync(output), false);
  }
});

test('namespace/process and OCR contracts refuse ambiguity without guessed authority', () => {
  assert.deepEqual(parsePs('123\tcom.creatorworks.hub\t456\t457\n')[0], {
    instance: '123', application: 'com.creatorworks.hub', pid: 456, childPid: 457,
  });
  assert.throws(() => parsePs('instance application pid child-pid'));
  const tsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n'
    + '5\t1\t1\t1\t1\t1\t10\t20\t50\t10\t90\tAccept\n'
    + '5\t1\t1\t1\t1\t2\t65\t20\t20\t10\t90\tand\n'
    + '5\t1\t1\t1\t1\t3\t90\t20\t50\t10\t90\tcontinue\n';
  assert.deepEqual(ocrLines(tsv), [{ text: 'Accept and continue', x: 30, y: 25 }]);
});

test('workflow uses explicit dispatch instead of repeating expensive native runs on every PR push', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/flatpak-maintenance-validation.yml'), 'utf8');
  assert.doesNotMatch(workflow, /pull_request:\s+paths:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  const jobEnvironment = workflow.slice(workflow.indexOf('    env:'), workflow.indexOf('    steps:'));
  assert.doesNotMatch(jobEnvironment, /runner\./, 'Runner context is unavailable in job-level env');
  assert.match(workflow, /export VALIDATION_ROOT="\$RUNNER_TEMP\/creator-flatpak-validation"/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /ref: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/);
  assert.match(workflow, /git fetch --no-tags --depth=1/);
  for (const value of [SOURCE, ARCHIVE_SHA, DEB_SHA, '5975036', '96940196', '38393759689', '11810908524']) assert.ok(workflow.includes(value));
  assert.match(workflow, /const receipt = validateBinding\(binding, request\)/);
  assert.match(workflow, /createHash\('sha256'\)/);
  assert.match(workflow, /flatpak-native-smoke.cjs finalize[\s\S]*--job-status/);
  assert.equal((workflow.match(/if: always\(\)/g) || []).length, 2);
  assert.equal(/secrets\.|contents: write|actions: write|pull_request_target|self-hosted|gh workflow run|release upload/.test(workflow), false);
  const uploaded = workflow.slice(workflow.lastIndexOf('          path: |'));
  for (const line of uploaded.split('\n').slice(1).filter(l => l.trim())) {
    assert.match(line.trim(), /^\$\{\{ runner.temp \}\}\/creator-flatpak-validation\/evidence\/[a-z-]+\.(json|txt|png|log)$/);
  }
});

test('runner program cannot widen sandbox, access production signing material or silently install locally', () => {
  const source = fs.readFileSync(require.resolve('./flatpak-native-smoke.cjs'), 'utf8');
  assert.match(source, /hostedRoot\(\{ root: this.root \}\)/);
  assert.match(source, /https:\/\/dl.flathub.org\/repo\/flathub.flatpakrepo/);
  assert.equal(/--no-gpg-verify|--filesystem=|--socket=(session|system)-bus|flatpak-spawn|--no-sandbox|rejectUnauthorized|SIGNING_KEY_PATH|auth\.json|list-secret-keys|export-secret/.test(source), false);
  assert.match(source, /readlink \/proc\/\$\{windowPid\}\/exe/);
  assert.match(source, /same-version OSTree generation update/);
  assert.match(source, /directUpdaterInvocationTested: false/);
  assert.match(source, /linuxManagementUnsupportedObserved: true/);
  assert.match(source, /flat\(\['update', '--user', '-y', '--noninteractive', '--no-related', '--no-deps', APP\]/);
  assert.match(source, /flat\(\['update', '--user', '-y', '--noninteractive', '--no-related', '--no-deps', FIXTURE_RUNTIME\]/);
  assert.equal(/0\.1\.14/.test(source), false);
  assert.notEqual(APP, PLATFORM);
  assert.notEqual(PLATFORM, FIXTURE_RUNTIME);
});
