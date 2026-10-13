'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { parseArgs, hostedRoot, requestIdentity, validateBinding, initialReport, finalizeReport,
  inventorySnapshot, parsePs, processSnapshot, verifyProcessBinding, executableSnapshot, verifyInstanceIdentity,
  INSTANCE_IDENTITY, waitForLauncherExit, ocrLines, TERMS_CHECKBOX, termsChoice, KEYBOARD_CASES, termsSourceHashes, managerWindow,
  fixtureMetadata, permissionMetadata, EXTRACT_DEB,
  Experiment, PHASES, PROBE_FILES, REVIEWED_TEST_ONLY_FILES, TREE_EXCLUSIONS, REVIEWED_CANDIDATE,
  REPO, APP, PLATFORM, FIXTURE_RUNTIME } = require('./flatpak-native-smoke.cjs');

const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const SOURCE = '288d3d60a8108d6ff41729b63705af3598721f60';
const MERGE = 'da87dfb1f815653f23737a98766b5eaa8a525dc4';
const TREE = '52ebe386502913c583cb897f00e2d83c9703b404';
const HARNESS = 'f'.repeat(40); // Synthetic newer test-only ref, not an accepted real product commit.
const ARCHIVE_SHA = '5de4080ab8be4b46ef053af21e6d9985adbf77533b89f4d91d2e4d27bbc2e39e';
const DEB_SHA = 'b95d71ab62ae75b38d2e653eee3d21eacba4869027d2c1fa01495065c429b3e0';
function options() {
  return { 'source-run': '38423134520', 'source-commit': SOURCE, 'artifact-id': '11827776708',
    'artifact-sha256': ARCHIVE_SHA, 'artifact-bytes': '97015435', 'deb-sha256': DEB_SHA, 'deb-bytes': '6004284' };
}
function binding() {
  return {
    run: { id: 38423134520, repository: { id: 1364807512, full_name: REPO },
      head_repository: { full_name: REPO }, event: 'pull_request', path: '.github/workflows/ci.yml',
      status: 'completed', conclusion: 'success', head_sha: SOURCE, head_branch: 'fix/hub-013-platform-flatpak',
      run_attempt: 2, pull_requests: [{ number: 22, base: { repo: { id: 1364807512 } }, head: { repo: { id: 1364807512 } } }] },
    artifact: { id: 11827776708, name: `hub-development-Linux-X64-${MERGE}`, digest: `sha256:${ARCHIVE_SHA}`,
      size_in_bytes: 97015435, expired: false, workflow_run: { id: 38423134520, head_sha: SOURCE,
        repository_id: 1364807512, head_repository_id: 1364807512 } },
    commit: { sha: MERGE, parents: [{ sha: '35a16a45814d821d65b5d203628478449174cd55' }, { sha: SOURCE }],
      commit: { message: `Merge ${SOURCE} into 35a16a45814d821d65b5d203628478449174cd55`, tree: { sha: TREE } } },
    source: { sha: SOURCE, commit: { tree: { sha: TREE } } },
    linuxJob: { name: 'Hub (Linux)', conclusion: 'success', run_id: 38423134520, run_attempt: 2 },
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

test('disposable WebKit keyboard contract', {
  skip: process.env.FLATPAK_WEBKIT_CONTRACT !== '1', timeout: 120000,
}, async t => {
  // Guard precedes browser imports, output creation and server launch. Never provision or run locally.
  const root = hostedRoot({ root: process.env.VALIDATION_ROOT });
  const filename = path.join(root, 'evidence/terms-keyboard-contract.json');
  const source = JSON.parse(fs.readFileSync(path.join(root, 'evidence/source-binding.json'), 'utf8'));
  assert.equal(source.sourceCommit, process.env.SOURCE_COMMIT);
  assert.match(process.env.VALIDATION_HARNESS_COMMIT || '', /^[a-f0-9]{40}$/);
  const proof = { schemaVersion: 1, status: 'running', releaseReady: false,
    engine: 'Playwright WebKit', playwrightVersion: '1.63.0', nativeGnomeAcceptance: false,
    githubRunId: process.env.GITHUB_RUN_ID, harnessCommit: process.env.VALIDATION_HARNESS_COMMIT,
    sourceCommit: source.sourceCommit, sourceHashes: termsSourceHashes(), cases: [], cleanupPassed: false,
    scope: 'Exact source markup/module with a synthetic native bridge, not installed GNOME WebKitGTK or real user consent' };
  fs.writeFileSync(filename, `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const save = () => fs.writeFileSync(filename, `${JSON.stringify(proof, null, 2)}\n`);
  let browser, server, serverError, failure;
  try {
    assert.equal(require('@playwright/test/package.json').version, '1.63.0');
    const { webkit, expect } = require('@playwright/test');
    const home = path.join(root, 'webkit-home'); fs.mkdirSync(home, { mode: 0o700 });
    const env = { HOME: home, TMPDIR: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
      PLAYWRIGHT_BROWSERS_PATH: path.join(root, 'playwright-browsers') };
    server = spawn(process.execPath, [path.join(__dirname, '../tests/server.cjs')], {
      env, stdio: 'ignore', windowsHide: true,
    });
    server.on('error', error => { serverError = error; });
    let ready = false;
    for (const end = Date.now() + 5000; Date.now() < end && !ready;) {
      assert.ok(!serverError && server.exitCode === null, 'Owned static server failed to start');
      try {
        const response = await fetch('http://127.0.0.1:4188', { signal: AbortSignal.timeout(500) });
        ready = response.ok && await response.text() === fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
      } catch { /* Only server readiness is polled; no user input is retried. */ }
      if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(ready && server.exitCode === null, 'Exact source server did not become ready');
    browser = await webkit.launch({ headless: true, env, timeout: 30000 });
    proof.browserVersion = browser.version(); save();
    for (const name of KEYBOARD_CASES) {
      const evidence = { name, passed: false, pointerLabelClicks: 0, keys: [] };
      proof.cases.push(evidence); save();
      await t.test(name, async () => {
        const context = await browser.newContext({ viewport: { width: 1100, height: 890 } });
        let caseError;
        try {
          const page = await context.newPage();
          page.setDefaultTimeout(10000);
          const state = { accepted: false, calls: [] };
          await page.exposeFunction('termsNativeMock', async (command, args) => {
            state.calls.push({ command, args });
            if (command === 'usage_terms_status') return state.accepted;
            if (command === 'accept_usage_terms') {
              assert.deepEqual(args, { policyVersion: '2026-09-28-v1', accepted: true });
              if (name === 'native-write-failure') throw Error('Native storage is unavailable');
              state.accepted = true; return null;
            }
            if (command === 'get_launch_request') return { view: 'hub', revision: 0 };
            if (command === 'pending_hosted_restore') return [];
            if (command === 'project_inventory') return { projects: [], warnings: [] };
            if (command === 'app_inventory') return { supported: true, apps: [] };
            if (command === 'hub_update_status') return { currentVersion: '0.1.13', availableVersion: null, downloaded: false };
            return null;
          });
          // Only the native bridge is a fixture. Source DOM/module, focus, pointer and keyboard are unmodified.
          await page.addInitScript(() => {
            window.__CREATOR_HUB_TERMS_PROTOCOL__ = 1;
            window.__TAURI__ = { core: { invoke: (command, args) => window.termsNativeMock(command, args) },
              event: { listen: async () => () => {} } };
          });
          await page.goto('http://127.0.0.1:4188');
          const dialog = page.locator('#usage-terms-dialog');
          const checkbox = page.locator('#usage-terms-checkbox');
          const button = dialog.getByRole('button', { name: 'Accept and continue', exact: true });
          await expect(dialog).toBeVisible();
          await expect(dialog.locator('button')).toHaveCount(1);
          await expect(button).toBeDisabled(); await expect(checkbox).not.toBeChecked();
          assert.equal(state.calls.some(call => call.command === 'app_inventory'), false);
          if (name === 'disabled-no-submit') {
            await expect(dialog.locator('.usage-terms-copy')).toBeFocused();
          } else {
            const label = dialog.locator('.usage-terms-accept span');
            await expect(label).toHaveCount(1); await expect(label).toBeVisible();
            const box = await label.boundingBox();
            assert.ok(box && box.width > 0 && box.height > 0);
            evidence.pointerLabelClicks = 1;
            await page.mouse.click(box.x + Math.min(20, box.width / 2), box.y + Math.min(10, box.height / 2));
            await expect(checkbox).toBeChecked(); await expect(checkbox).toBeFocused();
            await expect(button).toBeEnabled();
            evidence.checkedCheckboxFocused = true; evidence.uniqueEnabledButton = true;
          }
          evidence.keys.push('Tab'); await page.keyboard.press('Tab');
          await expect(name === 'disabled-no-submit' ? checkbox : button).toBeFocused();
          evidence.tabFocus = name === 'disabled-no-submit' ? 'checkbox' : 'continue';
          evidence.keys.push('Return'); await page.keyboard.press('Enter');
          if (name === 'enabled-single-submit') {
            await expect(dialog).toBeHidden();
            await expect.poll(() => state.calls.some(call => call.command === 'app_inventory')).toBe(true);
            assert.equal(state.accepted, true);
          } else {
            if (name === 'native-write-failure') await expect(page.locator('#usage-terms-error')).toContainText('Native storage is unavailable');
            else { await expect(button).toBeDisabled(); await expect(checkbox).not.toBeChecked(); }
            await expect(dialog).toBeVisible(); assert.equal(state.accepted, false);
            assert.equal(state.calls.some(call => call.command === 'app_inventory'), false);
            const locked = await page.evaluate(() => [...document.body.children]
              .filter(element => !['SCRIPT', 'DIALOG'].includes(element.tagName)).every(element => element.inert));
            assert.equal(locked, true); evidence.appRemainsLocked = true;
          }
          evidence.nativeAcceptCalls = state.calls.filter(call => call.command === 'accept_usage_terms').length;
          assert.equal(evidence.nativeAcceptCalls, name === 'disabled-no-submit' ? 0 : 1);
        } catch (error) { caseError = error; evidence.failure = error.message.slice(0, 1500); }
        finally {
          try { await context.close(); }
          catch (error) { evidence.cleanupFailure = error.message.slice(0, 1500); caseError ||= error; }
          evidence.passed = !caseError; save();
        }
        if (caseError) throw caseError;
      });
    }
    assert.ok(proof.cases.every(item => item.passed), 'One or more WebKit keyboard contract cases failed');
    assert.deepEqual(termsSourceHashes(), proof.sourceHashes, 'Source changed during keyboard proof');
  } catch (error) { failure = error; proof.failure = error.message.slice(0, 1500); }
  finally {
    proof.cleanupErrors = [];
    try { if (browser) await browser.close(); }
    catch (error) { proof.cleanupErrors.push(error.message.slice(0, 1500)); failure ||= error; }
    try {
      if (server) {
        assert.ok(!serverError && server.exitCode === null && server.signalCode === null, 'Owned static server exited unexpectedly');
        assert.equal(server.kill('SIGTERM'), true);
        await waitForLauncherExit(server, 5000);
        assert.equal(server.signalCode, 'SIGTERM');
      }
    } catch (error) { proof.cleanupErrors.push(error.message.slice(0, 1500)); failure ||= error; }
    proof.cleanupPassed = proof.cleanupErrors.length === 0;
    proof.status = failure ? 'failed' : 'passed'; save();
  }
  if (failure) throw failure;
});

test('CLI is strict and all artifact/native pins are independently mandatory', () => {
  assert.deepEqual(parseArgs(['run', '--root', '/tmp/example']), { mode: 'run', root: '/tmp/example' });
  for (const args of [[], ['install'], ['run', '--root'], ['run', '--force', 'yes'],
    ['run', '--root', 'a', '--root', 'b'], ['run', '--root', '--force']]) assert.throws(() => parseArgs(args));
  const requested = requestIdentity(options());
  assert.equal(requested.debBytes, 6004284);
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
  assert.equal(receipt.runAttempt, 2);
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
  ['stale Linux attempt', b => { b.linuxJob.run_attempt = 1; }],
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

test('newer test-only harness preserves source288 product binding without admitting terms/runtime edits', t => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, 'evidence'));
  const old = process.env.VALIDATION_HARNESS_COMMIT;
  process.env.VALIDATION_HARNESS_COMMIT = HARNESS;
  t.after(() => { if (old === undefined) delete process.env.VALIDATION_HARNESS_COMMIT; else process.env.VALIDATION_HARNESS_COMMIT = old; });
  const coexistenceFixture = [...PROBE_FILES,
    'scripts/native-linux-maintenance-smoke.cjs', 'scripts/native-linux-maintenance-smoke.test.cjs',
    'scripts/native-linux-window.py', '.github/workflows/linux-maintenance-validation.yml',
    'scripts/native-mac-maintenance-smoke.cjs', 'scripts/native-mac-maintenance-smoke.test.cjs',
    'scripts/native-mac-window.swift', '.github/workflows/mac-maintenance-validation.yml',
    'docs/MAC-MAINTENANCE-VALIDATION.md', '.github/workflows/windows-candidate.yml',
    'scripts/Test-InstalledCandidate.ps1', 'scripts/self-update-baselines.test.cjs',
    'scripts/native-self-update-lab.ps1', 'scripts/native-self-update-lab.test.cjs',
    'scripts/native-self-update-smoke.cjs', 'scripts/maintenance-signed-update.test.cjs',
    '.github/workflows/maintenance-signed-update-lab.yml',
    'tests/fixtures/maintenance-signed-update/README.md',
    'tests/fixtures/maintenance-signed-update/creator-hub-windows-x86_64.json',
    'tests/fixtures/maintenance-signed-update/creator-hub-windows-x86_64.json.minisig',
    'tests/fixtures/maintenance-signed-update/latest.json',
  ];
  assert.equal(PROBE_FILES.length, 5, 'Only the exact runner-only XRes helper is added');
  assert.ok(PROBE_FILES.includes('scripts/flatpak-xres-window-pid.c'));
  assert.deepEqual(TREE_EXCLUSIONS, coexistenceFixture);
  assert.equal(new Set(TREE_EXCLUSIONS).size, 26);
  assert.ok(TREE_EXCLUSIONS.every(file => !/[?*]/.test(file)), 'No directory or wildcard exclusions');
  for (const files of [PROBE_FILES, REVIEWED_TEST_ONLY_FILES, TREE_EXCLUSIONS]) assert.ok(Object.isFrozen(files));
  let changed = coexistenceFixture.join('\n');
  let dirty = '';
  const run = (_tool, args) => {
    const command = args[2];
    let stdout = '';
    if (command === 'rev-parse') stdout = args[3] === 'HEAD^{commit}' ? HARNESS : args[3].endsWith('^{tree}') ? TREE : SOURCE;
    if (command === 'diff') stdout = changed;
    if (command === 'status') stdout = dirty;
    return { status: 0, stdout, stderr: '' };
  };
  const e = new Experiment(root, initialReport(requestIdentity(options())), run);
  const accepted = e.tree();
  assert.equal(accepted.productTreeMatches, true);
  assert.equal(accepted.harnessCommit, HARNESS);
  assert.notEqual(accepted.harnessCommit, SOURCE);
  assert.equal(accepted.candidateCommit, SOURCE);
  assert.equal(accepted.sourceTree, TREE);
  assert.deepEqual(accepted.harnessOnlyChanges, coexistenceFixture);
  assert.deepEqual(accepted.excludedPaths, coexistenceFixture);
  for (const file of [
    'src/app.js', 'src-tauri/src/self_update.rs', 'src/icons/creator-plugins.png',
    'src/usage-terms.js', 'src-tauri/src/main.rs', 'src-tauri/src/usage_terms.rs',
    'src-tauri/src/update_target.rs', 'src/runtime/unreviewed.js', 'tests/usage-terms.spec.js',
    'src-tauri/tauri.conf.json', 'src-tauri/Cargo.lock', 'package.json', 'package-lock.json',
    'scripts/flatpak-package.cjs', 'packaging/flatpak/payload.py', 'packaging/flatpak/runtime-50-evidence.json',
    '.github/workflows/ci.yml', 'scripts/native-linux-unreviewed-helper.py',
    '.github/workflows/mac-maintenance-validation.yml/unreviewed',
    '.github/workflows/maintenance-signed-update-lab.yml/unreviewed',
    'tests/fixtures/maintenance-signed-update/unreviewed.json',
    'tests/fixtures/maintenance-signed-update/latest.json/unreviewed',
    'tests/fixtures/maintenance-signed-update/nested/README.md',
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

test('post-update runtime diff uses retained export objects when the old installed commit was pruned', t => {
  const root = temporary(t); fs.mkdirSync(path.join(root, 'evidence'));
  const first = '245c6d9ef405eb146298b12accd480606c899f1f1995303ec7ec803f5ae17877';
  const second = 'b4a434bff83e0a2af74d6d9354eac7775cddd21bdf7da20e7f2e69c864e6a7b8';
  const retained = path.join(root, 'experimental-repo');
  const e = new Experiment(root, initialReport(), (tool, args) => {
    assert.equal(tool, 'ostree'); assert.deepEqual(args.slice(1), ['diff', '--fs-diff', first, second]);
    return args[0] === `--repo=${retained}` ? { status: 0, stdout: '', stderr: '' }
      : { status: 1, stdout: '', stderr: `error: No such metadata object ${first}.commit` };
  });
  assert.throws(() => e.identicalRuntime(first, second), /ostree failed/);
  assert.deepEqual(e.identicalRuntime(first, second, e.repo), { first, second, repository: retained, filesystemDiffEmpty: true });
  assert.throws(() => e.identicalRuntime(first, second, root), /owned repository/);
  const source = fs.readFileSync(require.resolve('./flatpak-native-smoke.cjs'), 'utf8');
  assert.match(source, /identicalRuntime\(this\.report\.fixtureRuntimeCommit, second, this\.repo\)/);
  assert.match(source, /this\.commit\(FIXTURE_RUNTIME\) === second && this\.commit\(APP\) === this\.report\.fixtureCommit/);
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

test('captured Flatpak 1.14.6 fallback-x11 serialization is accepted without admitting unconditional X11', () => {
  // Captured metadata from failed run 38417415256; embedding it avoids a CI artifact dependency.
  const metadata = '[Application]\nname=com.creatorworks.hub\nruntime=org.gnome.Platform/x86_64/50\n'
    + 'sdk=org.gnome.Sdk/x86_64/50\ncommand=creator-hub\n\n[Context]\n'
    + 'shared=network;ipc;\nsockets=x11;wayland;fallback-x11;\ndevices=dri;\n';
  assert.deepEqual(permissionMetadata(metadata), {
    shared: 'network;ipc;', sockets: 'x11;wayland;fallback-x11;', devices: 'dri;',
  }, 'Retain raw serialized evidence; do not rewrite installed permissions');
  for (const sockets of ['x11;', 'x11;wayland;', 'x11;fallback-x11;', 'fallback-x11;', 'wayland;', '',
    'x11;wayland;!fallback-x11;', 'x11;wayland;fallback-x11;session-bus;',
    'x11;wayland;fallback-x11;system-bus;', 'x11;wayland;fallback-x11;ssh-auth;',
    'x11;wayland;fallback-x11;gpg-agent;']) {
    assert.throws(() => permissionMetadata(metadata.replace('x11;wayland;fallback-x11;', sockets)), /minimal GUI\/network contract/, sockets);
  }
  for (const addition of ['filesystems=home;\n', 'features=devel;\n',
    '[Session Bus Policy]\norg.freedesktop.Flatpak=talk\n', '[System Bus Policy]\norg.example.Host=talk\n',
    '[Environment]\nWEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1\n']) {
    assert.throws(() => permissionMetadata(metadata + addition));
  }
  const { FINISH_ARGS } = require('./flatpak-package.cjs');
  assert.deepEqual(FINISH_ARGS, ['--socket=wayland', '--socket=fallback-x11', '--share=ipc', '--device=dri', '--share=network']);
  assert.ok(!FINISH_ARGS.includes('--socket=x11'), 'No manifest permission expansion');
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

test('captured Flatpak TSV preserves empty runtime application columns without shifting PIDs', () => {
  const rows = parsePs('3265388458\t\t4157\t4177\n1482866180\tcom.creatorworks.hub\t4226\t4230\n829695343\t\t4179\t4191\n\r\n');
  assert.deepEqual(rows[0], { instance: '3265388458', application: '', pid: 4157, childPid: 4177 });
  assert.equal(rows.filter(row => row.application === 'com.creatorworks.hub').length, 1);
  assert.equal(parsePs('123\tcom.creatorworks.hub\t456\t0\r\n')[0].childPid, 0, 'Documented startup state is not a shifted/missing column');
  for (const text of ['123 app 456 457', '123\t456\t457', '123\t\t456\t457\textra',
    '123\t\t\t457', '123\t\t456\t', '123\t\t9007199254740992\t457', '123\tapp name\t456\t457']) {
    assert.throws(() => parsePs(text), /Unexpected flatpak ps columns/, text);
  }
});

test('captured terms OCR permits only the proven I/pipe glyph under the exact title and revision', () => {
  const title = { text: 'Terms of use and risk acknowledgement' };
  const revision = { text: 'Creator Suite Terms v2026-09-28. This saved on this device.' };
  const button = { text: 'Accept and continue', x: 500, y: 715 };
  for (const glyph of ['I', '|']) {
    const checkbox = { text: `${glyph} have read and agree to these terms, including the risk assumption and liability limitations`, x: 293, y: 651 };
    const lines = [title, revision, checkbox, button];
    assert.equal(termsChoice(lines, TERMS_CHECKBOX), checkbox);
    assert.equal(termsChoice(lines, /^Accept and continue$/), button);
    for (const invalid of [[revision, checkbox, button], [title, checkbox, button],
      [title, { text: 'Creator Suite Terms v2099-01-01.' }, checkbox, button], [title, title, revision, checkbox, button]]) {
      assert.throws(() => termsChoice(invalid, TERMS_CHECKBOX), /exact dialog title\/revision/);
    }
    assert.throws(() => termsChoice([...lines, checkbox], TERMS_CHECKBOX), /ambiguous/);
    assert.throws(() => termsChoice([...lines, button], /^Accept and continue$/), /ambiguous/);
  }
  for (const text of ['l have read and agree to these terms,', 'Have read and agree',
    'I have read and agree to different terms,', 'Other I have read and agree to these terms,']) assert.equal(TERMS_CHECKBOX.test(text), false);
});

for (const fault of [null, 'survives', 'ps-fails', 'malformed']) {
  test(`preflight waits for natural instance-record disappearance without adoption or kill: ${fault}`, async t => {
    const root = temporary(t); fs.mkdirSync(path.join(root, 'evidence'));
    const captured = '1537671295\tcom.creatorworks.hub\t4375\t4379\n'
      + '4239702824\tcom.creatorworks.hub\t4363\t4367\n3425279159\t\t4316\t4328\n'
      + '3718219621\tcom.creatorworks.hub\t4381\t4385\n1223727281\t\t4294\t4314\n'
      + '3240843254\tcom.creatorworks.hub\t4357\t4361\n3838992486\tcom.creatorworks.hub\t4627\t4639\n'
      + '4196549178\tcom.creatorworks.hub\t4369\t4373\n';
    let snapshots = 0;
    const e = new Experiment(root, initialReport(), (tool, args) => {
      assert.equal(tool, 'flatpak'); assert.deepEqual(args, ['ps', '--columns=instance,application,pid,child-pid']);
      snapshots += 1;
      if (fault === 'ps-fails') return { status: 1, stderr: 'original preflight diagnostic' };
      return { status: 0, stdout: fault === 'malformed' ? 'bad row' : snapshots <= 2 || fault === 'survives'
        ? captured : '999\torg.example.Foreign\t700\t701\n' };
    }, () => assert.fail('No launcher before strict empty-instance preflight'));
    if (!fault) {
      const result = await e.awaitGuiIdle('candidate', 1000);
      assert.equal(result.passed, true); assert.equal(result.first.length, 6); assert.deepEqual(result.last, []);
      assert.equal(result.snapshots, 3);
    } else {
      e.awaitGuiIdle = label => Experiment.prototype.awaitGuiIdle.call(e, label, 0);
      await assert.rejects(e.phase('candidate-gui', () => e.gui('candidate')));
      assert.equal(e.report.guiPreflight.candidate.passed, false);
      assert.ok(e.report.guiPreflight.candidate.failure);
      assert.equal(e.report.checks.find(check => check.name === 'candidate-gui').status, 'failed');
      assert.equal(fs.existsSync(path.join(root, 'evidence/candidate-launch.log')), false);
    }
    assert.equal(e.report.releaseReady, false);
  });
}

function identityFixture(root) {
  const instance = { instance: '123', application: 'com.creatorworks.hub', pid: 456, childPid: 457 };
  const processes = {
    456: { parentPid: 100, startTime: '1000', pidNamespace: 'pid:[10]', mountNamespace: 'mnt:[20]' },
    457: { parentPid: 456, startTime: '1001', pidNamespace: 'pid:[30]', mountNamespace: 'mnt:[40]' },
    458: { parentPid: 457, startTime: '1002', pidNamespace: 'pid:[30]', mountNamespace: 'mnt:[40]' },
  };
  const location = path.join(root, 'installed-candidate');
  const appPath = path.join(location, 'files');
  const bytes = Buffer.from('synthetic exact native executable');
  const digest = require('./flatpak-package.cjs').sha256(bytes);
  const info = { name: instance.application, runtime: PLATFORM, 'instance-id': instance.instance,
    'app-path': appPath, 'app-commit': 'a'.repeat(64), 'runtime-commit': 'b'.repeat(64), arch: 'x86_64', branch: 'experimental' };
  const metadata = `[Application]\nname=${info.name}\nruntime=${info.runtime}\n[Instance]\n`
    + Object.entries(info).filter(([key]) => !['name', 'runtime'].includes(key)).map(([key, value]) => `${key}=${value}`).join('\n');
  const executable = { dev: 8n, ino: 9007199254740993n, size: BigInt(bytes.length), isFile: () => true };
  let offset = 0;
  const io = {
    readFileSync(file) {
      if (file === '/proc/458/root/.flatpak-info') return metadata;
      const pid = /^\/proc\/([0-9]+)\/stat$/.exec(file)?.[1];
      assert.ok(processes[pid], `Unexpected process read: ${file}`);
      const p = processes[pid]; const fields = Array(20).fill('0');
      fields[0] = p.state || 'S'; fields[1] = p.parentPid; fields[19] = p.startTime;
      return `${pid} (own app ) (fixture) ${fields.join(' ')}\n`;
    },
    readlinkSync(file) {
      const [, pid, type] = /^\/proc\/([0-9]+)\/ns\/(pid|mnt)$/.exec(file) || [];
      assert.ok(processes[pid]); return processes[pid][type === 'pid' ? 'pidNamespace' : 'mountNamespace'];
    },
    openSync(file, flags) { assert.equal(file, '/proc/458/exe'); assert.equal(flags, 'r'); offset = 0; return 42; },
    fstatSync(fd, options) { assert.equal(fd, 42); assert.deepEqual(options, { bigint: true }); return executable; },
    statSync(file, options) {
      assert.deepEqual(options, { bigint: true });
      assert.ok([path.join(appPath, 'bin/creator-hub'), '/proc/458/root/app/bin/creator-hub'].includes(file));
      return { ...executable };
    },
    readSync(fd, buffer) { assert.equal(fd, 42); const remaining = bytes.subarray(offset); remaining.copy(buffer); offset = bytes.length; return remaining.length; },
    closeSync(fd) { assert.equal(fd, 42); },
  };
  return { io, processes, instance, info, executable, expected: { appPath, executableSha256: digest,
    appCommit: info['app-commit'], runtimeCommit: info['runtime-commit'], runtimeRef: PLATFORM },
  resources: { location, executableSha256: digest, entriesVerified: 1 },
  query: { window: '987', pid: 458, client: '2097152', xresMajor: 1, xresMinor: 2, selfTest: false } };
}

test('host process binding accepts only the exact child or its immediate reaper child', () => {
  const f = identityFixture('/synthetic');
  const outer = processSnapshot(456, f.io), sandbox = processSnapshot(457, f.io), client = processSnapshot(458, f.io);
  verifyProcessBinding(client, sandbox, outer, f.instance, outer);
  verifyProcessBinding(sandbox, sandbox, outer, f.instance, outer);
  assert.equal(client.startTime, '1002', 'Spaces and parentheses in comm do not shift starttime');
  for (const change of [{ parentPid: 999 }, { pidNamespace: 'pid:[999]' }, { mountNamespace: 'mnt:[999]' }]) {
    assert.throws(() => verifyProcessBinding({ ...client, ...change }, sandbox, outer, f.instance, outer), /outside the exact/);
  }
  assert.throws(() => verifyProcessBinding(client, sandbox, outer, f.instance, { ...outer, startTime: '9' }), /owned launcher/);
  assert.throws(() => verifyProcessBinding(client, sandbox, outer, { ...f.instance, pid: 999 }, outer), /owned launcher/);
  for (const state of ['Z', 'X']) {
    f.processes[458].state = state; assert.throws(() => processSnapshot(458, f.io), /Dead or malformed/);
  }
  assert.throws(() => processSnapshot(-1, f.io), /Invalid host/);
});

test('running executable proof checks exact inode, container path and native inventory SHA', () => {
  const f = identityFixture('/synthetic');
  assert.equal(executableSnapshot(458, f.expected.appPath, f.expected.executableSha256, f.io).inode, '9007199254740993');
  assert.throws(() => executableSnapshot(458, f.expected.appPath, 'f'.repeat(64), f.io), /SHA256/);
  const stat = f.io.statSync;
  f.io.statSync = (...args) => ({ ...stat(...args), ino: 9007199254740992n });
  assert.throws(() => executableSnapshot(458, f.expected.appPath, f.expected.executableSha256, f.io), /not the exact installed/);
});

test('running metadata parser and verifier bind exact instance/app/runtime rather than names alone', () => {
  const f = identityFixture('/synthetic');
  const parsed = spawnSync(PYTHON, ['-c', INSTANCE_IDENTITY], { input: f.io.readFileSync('/proc/458/root/.flatpak-info'), encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.deepEqual(JSON.parse(parsed.stdout), f.info);
  verifyInstanceIdentity(f.info, f.instance, f.expected);
  for (const key of Object.keys(f.info)) assert.throws(() => verifyInstanceIdentity({ ...f.info, [key]: 'wrong' }, f.instance, f.expected), /deployment drift/);
});

for (const fault of [null, 'unavailable', 'timeout', 'foreign-client', 'starttime-reuse', 'exe-drift', 'namespace-drift',
  'instance-drift', 'invalid-receipt', 'wrong-window', 'unsafe-pid', 'old-protocol', 'runtime-drift', 'reuse-during-hash']) {
  test(`XRes identity receipt remains fail-closed across capture rechecks: ${fault}`, async t => {
    const root = temporary(t); fs.mkdirSync(path.join(root, 'evidence'));
    const f = identityFixture(root);
    const run = (tool, args) => {
      if (tool === 'flatpak') return { status: 0, stdout: `123\t${f.instance.application}\t456\t${fault === 'instance-drift' ? 999 : 457}\n` };
      if (tool.endsWith('flatpak-xres-window-pid')) {
        if (fault === 'unavailable') return { status: 5, stderr: 'No local XRes PID' };
        if (fault === 'timeout') return { status: null, error: { code: 'ETIMEDOUT', message: 'bounded helper timeout' } };
        const invalid = { 'invalid-receipt': { selfTest: true }, 'wrong-window': { window: '111' },
          'unsafe-pid': { pid: 9007199254740992 }, 'old-protocol': { xresMinor: 1 } };
        return { status: 0, stdout: JSON.stringify({ ...f.query, ...invalid[fault] }) };
      }
      assert.equal(tool, '/usr/bin/python3'); assert.equal(args[1], INSTANCE_IDENTITY);
      return { status: 0, stdout: JSON.stringify(f.info) };
    };
    const e = new Experiment(root, initialReport(), run, undefined, f.io);
    const launcher = processSnapshot(456, f.io);
    if (fault === 'foreign-client') f.processes[458].parentPid = 999;
    if (fault === 'exe-drift') f.expected.executableSha256 = 'f'.repeat(64);
    if (fault === 'runtime-drift') f.info['runtime-commit'] = 'c'.repeat(64);
    if (fault === 'reuse-during-hash') {
      const read = f.io.readSync;
      f.io.readSync = (...args) => { f.processes[458].startTime = '2000'; return read(...args); };
    }
    const prove = () => e.windowIdentity('candidate', '987', f.instance, launcher, f.expected);
    if (['starttime-reuse', 'namespace-drift'].includes(fault)) {
      prove();
      if (fault === 'starttime-reuse') f.processes[458].startTime = '9999';
      else f.processes[458].mountNamespace = 'mnt:[999]';
    }
    if (fault) await assert.rejects(e.phase('candidate-gui', prove));
    else { prove(); prove(); assert.equal(e.report.guiIdentity.candidate.rechecks, 2); }
    const report = JSON.parse(fs.readFileSync(path.join(root, 'evidence/report.json')));
    assert.equal(report.releaseReady, false);
    if (fault) {
      assert.equal(report.checks.find(check => check.name === 'candidate-gui').status, 'failed');
      assert.ok(report.guiIdentity.candidate.failure);
    }
  });
}

function fakeLauncher({ exited = false, hang = false } = {}) {
  const child = new EventEmitter();
  Object.assign(child, { pid: 456, exitCode: exited ? 137 : null, signalCode: null,
    kill(signal) {
      assert.equal(signal, 'SIGTERM'); this.fallbackSignals = (this.fallbackSignals || 0) + 1;
      if (!hang) { this.signalCode = signal; this.emit('exit', null, signal); }
      return true;
    } });
  return child;
}

test('window-manager readiness accepts only the named EWMH property', () => {
  assert.equal(managerWindow('_NET_SUPPORTING_WM_CHECK:  no such atom on any window.\n'), null);
  assert.equal(managerWindow('_NET_SUPPORTING_WM_CHECK:  not found.\n'), null);
  assert.equal(managerWindow('_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x800001\n'), '8388609');
  for (const value of ['', '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x0',
    '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x800001', '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x100000000']) {
    assert.throws(() => managerWindow(value));
  }
});

for (const fault of [null, 'preexisting', 'wrong-owner', 'handshake', 'identity-drift', 'nonzero-exit']) {
  test(`owned ordinary window-manager readiness and normal shutdown: ${fault}`, async t => {
    const root = temporary(t); fs.mkdirSync(path.join(root, 'evidence'));
    const child = fakeLauncher(); let launched = false; let start = '1000'; let rootQueries = 0; let signals = 0;
    const io = { readFileSync: () => {
      const fields = Array(20).fill('0'); fields[0] = 'S'; fields[1] = String(process.pid); fields[19] = start;
      return `456 (openbox) ${fields.join(' ')}`;
    }, readlinkSync: name => name.endsWith('/pid') ? 'pid:[10]' : 'mnt:[11]' };
    child.kill = signal => {
      signals += 1; assert.equal(signal, 'SIGTERM');
      child.exitCode = fault === 'nonzero-exit' ? 3 : 0;
      child.emit('exit', child.exitCode, null); return true;
    };
    const property = '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x800001\n';
    const e = new Experiment(root, initialReport(), (tool, args) => {
      if (tool === 'xprop') {
        if (args[0] === '-root' && rootQueries++ === 0 && fault !== 'preexisting') {
          return { status: 0, stdout: '_NET_SUPPORTING_WM_CHECK:  no such atom on any window.\n' };
        }
        return { status: 0, stdout: args[0] === '-id' && fault === 'handshake'
          ? property.replace('0x800001', '0x800002') : property };
      }
      assert.ok(tool.endsWith('flatpak-xres-window-pid'));
      return { status: 0, stdout: JSON.stringify({ window: '8388609', pid: fault === 'wrong-owner' ? 999 : 456,
        selfTest: false, xresMajor: 1, xresMinor: 2 }) };
    }, (tool, args) => { launched = true; assert.equal(tool, '/usr/bin/openbox'); assert.deepEqual(args, ['--sm-disable']); return child; }, io);
    if (fault === 'preexisting') {
      await assert.rejects(e.startWindowManager(), /Existing window manager/);
      assert.equal(launched, false); return;
    }
    if (['wrong-owner', 'handshake'].includes(fault)) await assert.rejects(e.startWindowManager());
    else { await e.startWindowManager(); assert.equal(e.report.windowManager.ready, true); }
    if (fault === 'identity-drift') start = '2000';
    if (['identity-drift', 'nonzero-exit'].includes(fault)) {
      await assert.rejects(e.stopWindowManager());
      assert.equal(e.report.windowManager.cleanupPassed, false);
      assert.equal(e.report.failures.at(-1).phase, 'window-manager-cleanup');
      assert.equal(signals, fault === 'identity-drift' ? 0 : 1);
    } else { await e.stopWindowManager(); assert.equal(e.report.windowManager.cleanupPassed, true); }
    assert.equal(e.report.releaseReady, false);
  });
}

test('GUI refuses an unsupported runner lifetime option before launching anything', async t => {
  const root = temporary(t); fs.mkdirSync(path.join(root, 'evidence'));
  const e = new Experiment(root, initialReport(), () => ({ status: 0, stdout: '', stderr: '' }),
    () => { throw Error('Must not launch'); });
  await assert.rejects(e.phase('candidate-gui', () => e.gui('candidate')), /lacks documented Flatpak lifetime protection/);
  assert.equal(fs.existsSync(path.join(root, 'evidence/candidate-launch.log')), false);
  assert.equal(e.report.checks.find(check => check.name === 'candidate-gui').status, 'failed');
});

test('launcher exit handshake handles signals/already-exited children and rejects a hang without leaking listeners', async () => {
  const child = fakeLauncher();
  const done = waitForLauncherExit(child, 1000);
  child.kill('SIGTERM'); await done;
  await waitForLauncherExit(fakeLauncher({ exited: true }), 10);
  const hung = fakeLauncher({ hang: true });
  await assert.rejects(waitForLauncherExit(hung, 10), /exit timed out/);
  assert.equal(hung.listenerCount('exit'), 0); assert.equal(hung.listenerCount('error'), 0);
});

for (const fault of [null, 'kill-nonzero', 'kill-hang', 'launcher-hang', 'instance-survives', 'unknown-instance-survives']) {
  test(`Flatpak cleanup requires kill/launcher/instance handshakes: ${fault || 'success'}`, async t => {
    const root = temporary(t); fs.mkdirSync(path.join(root, 'evidence'));
    const child = fakeLauncher({ hang: fault === 'launcher-hang', exited: fault === 'unknown-instance-survives' });
    const own = { instance: '123', application: 'com.creatorworks.hub', pid: 455, childPid: 456 };
    const e = new Experiment(root, initialReport(), (tool, args) => {
      assert.equal(tool, 'flatpak');
      if (args[0] === 'kill') {
        assert.deepEqual(args, ['kill', own.instance]);
        if (fault !== 'launcher-hang') { child.exitCode = 137; child.emit('exit', 137); }
        if (fault === 'kill-nonzero') return { status: 1, stdout: '', stderr: 'synthetic kill failure' };
        if (fault === 'kill-hang') return { status: null, stdout: '', stderr: 'synthetic timeout', error: { code: 'ETIMEDOUT', message: 'timeout' } };
      } else assert.deepEqual(args, ['ps', '--columns=instance,application,pid,child-pid']);
      // A foreign instance must survive, and must never become a kill target.
      const alive = fault === 'instance-survives' || fault === 'unknown-instance-survives';
      return { status: 0, stdout: args[0] === 'ps' ? `${alive ? '123\tcom.creatorworks.hub\t455\t456\n' : ''}999\torg.example.Foreign\t700\t701\n` : '', stderr: '' };
    });
    const cleanup = () => e.cleanupGui('candidate', child, fault === 'unknown-instance-survives' ? null : own, null, 10);
    if (!fault) {
      const result = await cleanup();
      assert.equal(result.passed, true); assert.equal(result.launcherExited, true); assert.equal(result.instanceGone, true);
    } else {
      await assert.rejects(e.phase('candidate-gui', cleanup), /GUI cleanup failed/);
      const saved = JSON.parse(fs.readFileSync(path.join(root, 'evidence/report.json')));
      assert.equal(saved.releaseReady, false); assert.equal(saved.guiCleanup.candidate.passed, false);
      assert.equal(saved.checks.find(check => check.name === 'candidate-gui').status, 'failed');
      assert.ok(saved.guiCleanup.candidate.errors.length);
      if (fault === 'launcher-hang') assert.equal(saved.guiCleanup.candidate.launcherExited, false);
      if (fault.endsWith('survives')) assert.equal(saved.guiCleanup.candidate.instanceGone, false);
    }
    assert.ok(e.commands.filter(c => c.args[0] === 'kill').every(c => c.args[1] === own.instance));
  });
}

for (const originalFailure of [false, true, 'xres-unavailable', 'no-net-wm-pid', 'identity-drift-after-import',
  'identity-drift-before-consent', 'captured-pipe-terms', 'no-initial-terms', 'persisted-terms-reappears', 'persisted-terms-absent']) {
  test(`GUI cleanup invalidates capture and retains the original error: ${originalFailure}`, async t => {
    // Entire GUI/launcher/command surface is synthetic; never launch Flatpak or capture a host window.
    const root = temporary(t); fs.mkdirSync(path.join(root, 'evidence'));
    const f = identityFixture(root);
    const child = fakeLauncher(); let psCalls = 0; let killed = false; let clicks = 0; const keys = [];
    const missingXres = originalFailure === 'xres-unavailable';
    const pipeTerms = originalFailure === 'captured-pipe-terms';
    const persisted = originalFailure === 'persisted-terms-absent';
    const passed = originalFailure === 'no-net-wm-pid' || pipeTerms || persisted;
    const identityDrift = originalFailure === 'identity-drift-after-import';
    const consentDrift = originalFailure === 'identity-drift-before-consent';
    const noInitialTerms = originalFailure === 'no-initial-terms';
    const lostPersistence = originalFailure === 'persisted-terms-reappears';
    const label = lostPersistence || persisted ? 'fixture' : 'candidate';
    const cleanupPasses = missingXres || passed || identityDrift || consentDrift || noInitialTerms || lostPersistence;
    const original = Error('original namespace diagnostic');
    const rendered = ['Creator Hub 0.1.13', 'Updates are managed by Flatpak', 'Native installers cannot', 'App management is not supported on Linux'];
    const terms = ['Terms of use and risk acknowledgement', 'Creator Suite Terms v2026-09-28.',
      `${pipeTerms ? '|' : 'I'} have read and agree to these terms, including the risk assumption and liability limitations`, 'Accept and continue'];
    const tsv = text => 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n'
      + text.map((line, i) => `5\t1\t1\t1\t${i + 1}\t1\t10\t20\t50\t10\t90\t${line}`).join('\n');
    const e = new Experiment(root, initialReport(), (tool, args) => {
      let stdout = '';
      if (tool === 'flatpak' && args[0] === 'kill') {
        killed = true; child.exitCode = 137; child.emit('exit', 137);
        return { status: cleanupPasses ? 0 : 1, stdout, stderr: cleanupPasses ? '' : 'synthetic cleanup failure' };
      }
      if (tool === 'flatpak' && args[0] === 'ps') stdout = ++psCalls >= 2 && !killed ? '123\tcom.creatorworks.hub\t456\t457\n' : '';
      if (tool === 'flatpak' && args[0] === 'run') stdout = '--die-with-parent';
      if (tool === 'flatpak' && args[0] === 'enter' && args[2] === 'cat') stdout = 'name=com.creatorworks.hub';
      if (tool === 'flatpak' && args[0] === 'info') stdout = args.includes('--show-runtime') ? PLATFORM.slice(8)
        : args.at(-1) === APP ? f.expected.appCommit : f.expected.runtimeCommit;
      if (tool === 'xdotool' && args[0] === 'search') stdout = '987\n';
      if (tool === 'xdotool' && args[0] === 'getwindowfocus') stdout = '987\n';
      if (tool === 'xdotool' && args.includes('click')) clicks += 1;
      if (tool === 'xdotool' && args[0] === 'key') keys.push(args.at(-1));
      assert.notEqual(tool, 'xprop', 'Neither absent nor spoofed window PID properties grant identity');
      if (tool.endsWith('flatpak-xres-window-pid')) {
        if (missingXres) return { status: 5, stdout: '', stderr: 'No unique live local XRes PID' };
        stdout = JSON.stringify(f.query);
      }
      if (tool === 'import' && identityDrift) f.processes[458].startTime = '2000';
      if (tool === 'tesseract') {
        stdout = tsv(!noInitialTerms && !persisted && !keys.includes('Return') ? terms : rendered);
        if (consentDrift) f.processes[458].startTime = '2000';
      }
      if (tool === '/usr/bin/python3') stdout = args[1] === INSTANCE_IDENTITY ? JSON.stringify(f.info)
        : JSON.stringify({ width: 1100, height: 1000, colors: 100, stddev: [20, 20, 20] });
      return { status: 0, stdout, stderr: '' };
    }, (tool, args) => {
      assert.equal(tool, 'flatpak'); assert.deepEqual(args, ['run', '--user', '--die-with-parent', APP]); return child;
    }, f.io);
    e.resources = () => f.resources;
    e.keyboardContract = () => ({ unitOnly: true }); // All GUI input in this test is a synthetic command fixture.
    if (lostPersistence || persisted) e.report.guiTerms = { candidate: { acknowledged: true } };
    if (originalFailure === true) {
      const flat = e.flat.bind(e);
      e.flat = (args, opts) => { if (args[0] === 'enter') throw original; return flat(args, opts); };
    }
    const execute = () => e.phase('candidate-gui', () => e.gui(label));
    if (passed) {
      await execute(); assert.ok(e.report.guiIdentity[label].rechecks >= 4);
      if (pipeTerms) {
        assert.equal(clicks, 1, 'Only the unique visible checkbox label is clicked');
        assert.deepEqual(keys, ['Tab', 'Return']);
        assert.equal(e.report.guiTerms.candidate.acknowledged, true);
      }
      assert.equal(e.report.checks.find(check => check.name === 'candidate-gui').evidence.syntheticTermsFixture, !persisted);
      if (persisted) {
        assert.equal(clicks, 0); assert.deepEqual(keys, []);
        assert.equal(e.report.guiTerms.fixture.persistedFromCandidate, true);
      }
    } else await assert.rejects(execute, error => originalFailure === true ? error === original : missingXres
      ? /flatpak-xres-window-pid.*failed/.test(error.message) : identityDrift || consentDrift
        ? /identity changed during GUI capture/.test(error.message) : noInitialTerms
          ? /Fresh isolated candidate has no initial terms/.test(error.message) : lostPersistence
            ? /acknowledgement was not retained/.test(error.message) : /GUI cleanup failed/.test(error.message));
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'evidence/report.json')));
    assert.equal(saved.checks.find(check => check.name === 'candidate-gui').status, passed ? 'passed' : 'failed');
    assert.equal(saved.guiCleanup[label].passed, cleanupPasses); assert.equal(saved.releaseReady, false);
    if (missingXres) assert.ok(!e.commands.some(command => command.tool === 'import' || command.tool === 'tesseract'), 'No unowned pixel/consent capture after identity failure');
    if (identityDrift) assert.ok(!e.commands.some(command => command.tool === 'tesseract' || command.args.includes('click')), 'Post-import drift prevents OCR/consent acceptance');
    if (consentDrift) assert.ok(!e.commands.some(command => command.args.includes('click')), 'Post-OCR identity drift prevents any synthetic consent click');
    if (noInitialTerms || lostPersistence) {
      assert.equal(clicks, 0); assert.deepEqual(keys, []);
      assert.equal(saved.guiTerms[label].acknowledged, false);
      assert.equal(saved.checks.find(check => check.name === 'candidate-gui').status, 'failed');
    }
    if (!cleanupPasses) assert.ok(saved.failures.some(failure => failure.phase === 'candidate-cleanup'));
    if (originalFailure === true) assert.ok(saved.failures.some(failure => failure.phase === 'candidate-gui' && failure.message === original.message));
  });
}

function keyboardProof() {
  return { schemaVersion: 1, status: 'passed', releaseReady: false, playwrightVersion: '1.63.0',
    engine: 'Playwright WebKit', nativeGnomeAcceptance: false, githubRunId: '12345', harnessCommit: HARNESS,
    sourceCommit: SOURCE, cleanupPassed: true, sourceHashes: termsSourceHashes(),
    cases: KEYBOARD_CASES.map(name => ({ name, passed: true, keys: ['Tab', 'Return'],
      pointerLabelClicks: name === 'disabled-no-submit' ? 0 : 1,
      nativeAcceptCalls: name === 'disabled-no-submit' ? 0 : 1,
      tabFocus: name === 'disabled-no-submit' ? 'checkbox' : 'continue',
      checkedCheckboxFocused: true, uniqueEnabledButton: true, appRemainsLocked: true })) };
}
for (const fault of [null, 'missing', 'failed', 'cleanup', 'source', 'run', 'harness', 'hash', 'version',
  'duplicate-case', 'extra-key', 'extra-accept', 'unchecked-focus', 'unlocked-failure']) {
  test(`native keyboard requires exact current-run WebKit receipt: ${fault}`, t => {
    const root = temporary(t); fs.mkdirSync(path.join(root, 'evidence'));
    const prior = { run: process.env.GITHUB_RUN_ID, harness: process.env.VALIDATION_HARNESS_COMMIT };
    process.env.GITHUB_RUN_ID = '12345'; process.env.VALIDATION_HARNESS_COMMIT = HARNESS;
    t.after(() => {
      for (const [key, value] of [['GITHUB_RUN_ID', prior.run], ['VALIDATION_HARNESS_COMMIT', prior.harness]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    const proof = keyboardProof();
    if (fault === 'failed') proof.status = 'failed';
    if (fault === 'cleanup') proof.cleanupPassed = false;
    if (fault === 'source') proof.sourceCommit = MERGE;
    if (fault === 'run') proof.githubRunId = '54321';
    if (fault === 'harness') proof.harnessCommit = SOURCE;
    if (fault === 'hash') proof.sourceHashes['usage-terms.js'] = '0'.repeat(64);
    if (fault === 'version') proof.playwrightVersion = '1.62.0';
    if (fault === 'duplicate-case') proof.cases[2] = proof.cases[0];
    if (fault === 'extra-key') proof.cases[0].keys.push('Tab');
    if (fault === 'extra-accept') proof.cases[0].nativeAcceptCalls = 2;
    if (fault === 'unchecked-focus') proof.cases[0].checkedCheckboxFocused = false;
    if (fault === 'unlocked-failure') proof.cases[2].appRemainsLocked = false;
    if (fault !== 'missing') fs.writeFileSync(path.join(root, 'evidence/terms-keyboard-contract.json'), JSON.stringify(proof));
    const e = new Experiment(root, initialReport(), () => { throw Error('No native command is allowed in receipt validation'); });
    e.report.request = requestIdentity(options());
    if (!fault) assert.deepEqual(e.keyboardContract(), proof);
    else assert.throws(() => e.keyboardContract());
    assert.equal(e.commands.length, 0); assert.equal(e.report.releaseReady, false);
  });
}

for (const fault of [null, 'foreign-before', 'foreign-after', 'nonzero', 'hang']) {
  test(`single native keyboard sequence fails closed on focus/command error: ${fault}`, async t => {
    const root = temporary(t); fs.mkdirSync(path.join(root, 'evidence'));
    let checks = 0, focusChecks = 0; const sent = [];
    const e = new Experiment(root, initialReport(), (tool, args) => {
      assert.equal(tool, 'xdotool');
      if (args[0] === 'getwindowfocus') {
        focusChecks++;
        return { status: 0, stdout: (fault === 'foreign-before' || (fault === 'foreign-after' && focusChecks === 2)) ? '999\n' : '987\n', stderr: '' };
      }
      assert.deepEqual(args.slice(0, 2), ['key', '--clearmodifiers']); sent.push(args[2]);
      if (fault === 'nonzero') return { status: 1, stdout: '', stderr: 'synthetic input failure' };
      if (fault === 'hang') return { status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT', message: 'synthetic input timeout' } };
      return { status: 0, stdout: '', stderr: '' };
    });
    e.report.guiTerms = { candidate: { keys: [] } };
    const sequence = () => {
      e.nativeKey('candidate', '987', 'Tab', () => checks++);
      e.nativeKey('candidate', '987', 'Return', () => checks++);
    };
    if (!fault) {
      await e.phase('candidate-gui', sequence);
      assert.deepEqual(sent, ['Tab', 'Return']); assert.equal(checks, 4);
      assert.throws(() => e.nativeKey('candidate', '987', 'Return', () => checks++), /no input retries/);
    } else {
      await assert.rejects(e.phase('candidate-gui', sequence), /foreground|xdotool.*failed/);
      assert.deepEqual(sent, fault === 'foreign-before' ? [] : ['Tab']);
      const saved = JSON.parse(fs.readFileSync(path.join(root, 'evidence/report.json')));
      assert.equal(saved.checks.find(check => check.name === 'candidate-gui').status, 'failed');
      assert.equal(saved.releaseReady, false);
    }
    assert.throws(() => e.nativeKey('candidate', '987', 'space', () => checks++), /single Tab\/Return/);
  });
}

test('WebKit opt-in alone cannot launch or install on the local machine', t => {
  const root = path.join(temporary(t), 'never-created');
  const env = { ...process.env, GITHUB_ACTIONS: 'false', FLATPAK_WEBKIT_CONTRACT: '1', VALIDATION_ROOT: root };
  delete env.NODE_TEST_CONTEXT; // The subprocess must be a standalone runner, not the parent's test worker.
  const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=^disposable WebKit keyboard contract$', __filename], {
    env,
    encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /Only disposable GitHub-hosted Linux x86_64/);
  assert.equal(fs.existsSync(root), false);
});

test('workflow installs pinned WebKit only after binding and gates native input on its opt-in contract', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/flatpak-maintenance-validation.yml'), 'utf8');
  assert.match(workflow, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(workflow, /equal\(require\('@playwright\/test\/package.json'\)\.version, '1\.63\.0'\)/);
  assert.match(workflow, /node node_modules\/playwright\/cli.js install --with-deps webkit/);
  assert.match(workflow, /FLATPAK_WEBKIT_CONTRACT: '1'/);
  assert.match(workflow, /node --test --test-name-pattern='disposable WebKit keyboard contract'/);
  assert.ok(workflow.indexOf('Recheck binding before provisioning tools') < workflow.indexOf('npm ci'));
  assert.ok(workflow.indexOf('--test-name-pattern=') < workflow.indexOf('Build, install, capture native pixels'));
  assert.match(workflow, /evidence\/terms-keyboard-contract.json/);
  const source = fs.readFileSync(__filename, 'utf8');
  const contract = source.slice(source.indexOf("test('disposable WebKit keyboard contract'"), source.indexOf("test('CLI is strict"));
  assert.ok(contract.indexOf('hostedRoot(') < contract.indexOf("require('@playwright/test')"));
  assert.doesNotMatch(contract, /\.focus\(|\.check\(|localStorage\.|sessionStorage\.|force:\s*true|dispatchEvent|setInputFiles|--no-sandbox|DISABLE_SANDBOX/);
  assert.equal((contract.match(/page\.keyboard\.press\('Tab'\)/g) || []).length, 1);
  assert.equal((contract.match(/page\.keyboard\.press\('Enter'\)/g) || []).length, 1);
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
  assert.ok(Object.isFrozen(REVIEWED_CANDIDATE));
  assert.deepEqual(REVIEWED_CANDIDATE, { ...requestIdentity(options()), buildCommit: MERGE, sourceTree: TREE });
  for (const [input, value] of Object.entries(options())) {
    const name = input.replaceAll('-', '_');
    assert.match(workflow, new RegExp(`${name}:\\s+[\\s\\S]*?default: '${value}'`));
    assert.ok(workflow.includes(`inputs.${name} || '${value}'`), `Fallback pin differs: ${name}`);
  }
  assert.doesNotMatch(workflow, /38393759689|6d47bd0790cfc5c3560495bbd92c37b3cd06df14|11810908524|681ef6fcb50f77f588f6f9e88a13fbbf9545b56ba6473f4fe749c3a6a22f44d1|57ff363701a49c8d603efb677a3720ddc5c2b2443a9b019f0afd5be922ac5374/);
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

test('runner-only XRes helper queries one live resource with no PID-hint or namespace fallback', () => {
  const helper = fs.readFileSync(path.join(__dirname, 'flatpak-xres-window-pid.c'), 'utf8');
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/flatpak-maintenance-validation.yml'), 'utf8');
  const source = fs.readFileSync(require.resolve('./flatpak-native-smoke.cjs'), 'utf8');
  assert.match(helper, /XResClientIdSpec spec = \{ window, XRES_CLIENT_ID_PID_MASK \}/);
  assert.match(helper, /XResQueryClientIds\(display, 1, &spec, &count, &values\)/);
  assert.match(helper, /status == Success && count == 1/);
  assert.match(helper, /XResGetClientPid\(&values\[0\]\)/);
  assert.match(helper, /XResClientIdsDestroy\(count, values\)/);
  assert.match(helper, /XGetWindowAttributes/);
  assert.match(helper, /address.sun_family != AF_UNIX/);
  assert.match(helper, /major != 1 \|\| minor < 2/);
  assert.doesNotMatch(helper, /XGetWindowProperty|setns|kill\(|exec|system\(|getenv\(/);
  assert.match(helper, /XChangeProperty[\s\S]*pid == getpid\(\)/);
  assert.match(helper, /XDestroyWindow[\s\S]*!query_pid/);
  assert.match(workflow, /gcc libc6-dev libx11-dev libxres-dev/);
  assert.match(workflow, /cc -std=c11 -O2 -Wall -Wextra -Werror[\s\S]*scripts\/flatpak-xres-window-pid.c[\s\S]*-lXRes -lX11/);
  assert.ok(workflow.indexOf('Recheck binding before provisioning tools') < workflow.indexOf('libxres-dev'));
  assert.match(source, /command\(this.xresHelper, \['--self-test'\]/);
  assert.match(source, /identityCheck\(\);\s+this.command\('import'[\s\S]*?identityCheck\(\);/);
  assert.match(source, /identityCheck\(\);\s+this.command\('xdotool', \['mousemove'/);
});

test('runner program cannot widen sandbox, access production signing material or silently install locally', () => {
  const source = fs.readFileSync(require.resolve('./flatpak-native-smoke.cjs'), 'utf8');
  assert.match(source, /hostedRoot\(\{ root: this.root \}\)/);
  assert.match(source, /https:\/\/dl.flathub.org\/repo\/flathub.flatpakrepo/);
  assert.equal(/--no-gpg-verify|--filesystem=|--socket=(session|system)-bus|flatpak-spawn|--no-sandbox|rejectUnauthorized|SIGNING_KEY_PATH|auth\.json|list-secret-keys|export-secret/.test(source), false);
  assert.doesNotMatch(source, /windowPid|_NET_WM_PID|\/proc\/.*environ|\/proc\/.*cmdline/);
  assert.match(source, /verifyProcessBinding\(client, sandbox, outer, instance, launcher\)/);
  assert.match(source, /\['run', '--user', '--die-with-parent', APP\]/);
  assert.match(source, /flat\(\['run', '--help'\]\)\.includes\('--die-with-parent'\)/);
  assert.match(source, /same-version OSTree generation update/);
  assert.match(source, /directUpdaterInvocationTested: false/);
  assert.match(source, /linuxManagementUnsupportedObserved: true/);
  assert.match(source, /flat\(\['update', '--user', '-y', '--noninteractive', '--no-related', '--no-deps', APP\]/);
  assert.match(source, /flat\(\['update', '--user', '-y', '--noninteractive', '--no-related', '--no-deps', FIXTURE_RUNTIME\]/);
  assert.equal(/0\.1\.14/.test(source), false);
  assert.notEqual(APP, PLATFORM);
  assert.notEqual(PLATFORM, FIXTURE_RUNTIME);
});
