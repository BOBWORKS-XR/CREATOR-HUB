'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const outgoing = require('./windows-outgoing-017.cjs');
const bytes = value => Buffer.from(JSON.stringify(value));
const { hash } = outgoing;
const workflow = fs.readFileSync(path.join(__dirname, '..', outgoing.WORKFLOW), 'utf8');
function fixture() {
  // Synthetic buffers only; no installer, signing, trust or live runner execution.
  const files = Object.fromEntries(Object.keys(outgoing.LIMITS).filter(name => name !== outgoing.TEMPLATE)
    .map(name => [name, Buffer.from(`test bytes for ${name}`)]));
  const config = { schemaVersion: 1, kind: outgoing.KIND, sourceCommit: 'a'.repeat(40),
    baseline: { version: '0.1.16', installer: hash(files[outgoing.BASELINE]), exe: 'b'.repeat(64) },
    targetVersion: '0.1.17', directory: outgoing.DIRECTORY,
    pins: { descriptor: hash(files[outgoing.DESCRIPTOR]), descriptorSignature: hash(files[`${outgoing.DESCRIPTOR}.minisig`]),
      installer: hash(files[outgoing.TARGET]), executable: 'c'.repeat(64), manifest: hash(files['latest.json']) },
    runtime: { baselineDescriptor: 'd'.repeat(64), targetDescriptor: 'e'.repeat(64) } };
  const template = { schemaVersion: 1, receiptSha256: 'f'.repeat(64), config };
  files[outgoing.TEMPLATE] = bytes(template);
  const review = { schemaVersion: 1, kind: outgoing.KIND, receiptSha256: template.receiptSha256,
    configCanonicalSha256: hash(bytes(config)), stagerWorkflow: '.github/workflows/windows-outgoing-017-input.yml',
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { bytes: content.length, sha256: hash(content) }])) };
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: `refs/heads/${outgoing.BRANCH}`, GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${outgoing.WORKFLOW}@refs/heads/${outgoing.BRANCH}`,
    GITHUB_SHA: '1'.repeat(40), GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '1',
    CREATOR_OUTGOING_CASE: 'mcp-restore', CREATOR_OUTGOING_LAST_TOOL: 'mcp', CREATOR_OUTGOING_RESTORE: 'true',
    CREATOR_OUTGOING_REVIEW_SHA256: hash(bytes(review)), INPUT_RUN: '100', INPUT_ARTIFACT: '200', INPUT_SHA256: '2'.repeat(64) };
  const run = { id: 100, repository: { id: 1364807512 }, head_repository: { id: 1364807512 }, event: 'workflow_dispatch',
    head_branch: outgoing.BRANCH, path: review.stagerWorkflow, head_sha: '3'.repeat(40), status: 'completed', conclusion: 'success' };
  const artifact = { id: 200, name: outgoing.ARTIFACT, expired: false, workflow_run: { id: run.id, head_sha: run.head_sha },
    digest: `sha256:${env.INPUT_SHA256}`, size_in_bytes: 1000 };
  return { files, template, review, env, run, artifact };
}
function refreshTemplate(f) {
  f.files[outgoing.TEMPLATE] = bytes(f.template);
  f.review.files[outgoing.TEMPLATE] = { bytes: f.files[outgoing.TEMPLATE].length, sha256: hash(f.files[outgoing.TEMPLATE]) };
  f.review.configCanonicalSha256 = hash(bytes(f.template.config));
}
const runnerDirectory = path.resolve('artifacts/outgoing-017-data');
test('unpopulated committed review fails closed; populated reviews need an independent exact-byte digest', () => {
  assert.throws(() => outgoing.reviewBytes(Buffer.from('null\n'), 'a'.repeat(64)), /not populated/);
  const f = fixture();
  assert.deepEqual(outgoing.reviewBytes(bytes(f.review), f.env.CREATOR_OUTGOING_REVIEW_SHA256), f.review);
  for (const bad of ['', '0'.repeat(64), 'a'.repeat(64)]) assert.throws(() => outgoing.reviewBytes(bytes(f.review), bad));
  const committed = fs.readFileSync(path.join(__dirname, 'windows-outgoing-017-review.json'));
  if (JSON.parse(committed) === null) assert.throws(() => outgoing.reviewBytes(committed, hash(committed)), /not populated/);
  else outgoing.reviewBytes(committed, hash(committed));
});
test('the byte-pinned outgoing review stays LF on Windows checkout', () => {
  const attributes = fs.readFileSync(path.join(__dirname, '.gitattributes'), 'utf8');
  assert.equal(attributes.trim(), 'windows-outgoing-017-review.json text eol=lf');
  assert.equal(fs.readFileSync(path.join(__dirname, 'windows-outgoing-017-review.json')).includes(13), false);
});
test('review cannot omit any of the five payload pins or the template/receipt/config bindings', () => {
  for (const name of Object.keys(outgoing.LIMITS)) {
    const f = fixture(); delete f.review.files[name];
    assert.throws(() => outgoing.reviewBytes(bytes(f.review), hash(bytes(f.review))));
  }
  for (const mutate of [f => delete f.review.receiptSha256, f => delete f.review.configCanonicalSha256,
    f => f.review.kind = 'public14-incoming-direct16', f => f.review.stagerWorkflow = '../other.yml',
    f => f.review.files[outgoing.TARGET].bytes = 0, f => f.review.files[outgoing.TARGET].bytes = 65 * 1024 * 1024,
    f => f.review.files[outgoing.DESCRIPTOR].sha256 = 'pending', f => f.review.files['extra.exe'] = {}]) {
    const f = fixture(); mutate(f); assert.throws(() => outgoing.reviewBytes(bytes(f.review), hash(bytes(f.review))));
  }
});
test('manual Windows host and exact three cases are mandatory before any input reads', () => {
  const f = fixture(); outgoing.assertHost(f.env, 'win32');
  for (const key of Object.keys(f.env).filter(name => name.startsWith('GITHUB_') || name.startsWith('RUNNER_') || name.startsWith('CREATOR_OUTGOING_') && !name.endsWith('SHA256'))) {
    assert.throws(() => outgoing.assertHost({ ...f.env, [key]: '' }, 'win32'), key);
  }
  assert.throws(() => outgoing.assertHost(f.env, 'linux'));
  for (const [caseName, [lastTool, restore]] of Object.entries(outgoing.CASES)) {
    outgoing.assertHost({ ...f.env, CREATOR_OUTGOING_CASE: caseName, CREATOR_OUTGOING_LAST_TOOL: lastTool, CREATOR_OUTGOING_RESTORE: restore }, 'win32');
  }
  assert.throws(() => outgoing.assertHost({ ...f.env, CREATOR_OUTGOING_CASE: 'mcp-no-restore', CREATOR_OUTGOING_RESTORE: 'false' }, 'win32'));
  const result = spawnSync(process.execPath, [path.join(__dirname, 'windows-outgoing-017.cjs'), 'prepare', 'missing-data'],
    { env: { ...process.env, GITHUB_ACTIONS: '' }, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.notEqual(result.status, 0); assert.doesNotMatch(result.stderr, /ENOENT|not populated/);
});
test('artifact binding accepts only an immutable successful same-repository manual stager', () => {
  const f = fixture(); const binding = outgoing.bindArtifact(f.run, f.artifact, f.env, f.review);
  assert.equal(binding.receiptSha256, f.review.receiptSha256); assert.equal(binding.case, 'mcp-restore');
  for (const mutate of [f => f.run.id++, f => f.run.repository.id++, f => f.run.head_repository.id++,
    f => f.run.event = 'push', f => f.run.head_branch = 'main', f => f.run.path = outgoing.WORKFLOW,
    f => f.run.status = 'in_progress', f => f.run.conclusion = 'failure', f => f.artifact.id++,
    f => f.artifact.name = 'windows-016-acceptance-input', f => f.artifact.expired = true,
    f => f.artifact.workflow_run.id++, f => f.artifact.workflow_run.head_sha = 'a'.repeat(40),
    f => f.artifact.digest = `sha256:${'a'.repeat(64)}`, f => f.artifact.size_in_bytes = 0,
    f => f.artifact.size_in_bytes = 129 * 1024 * 1024, f => f.env.INPUT_RUN = '100;unsafe',
    f => f.env.INPUT_ARTIFACT = '../200', f => f.env.INPUT_SHA256 = 'pending']) {
    const bad = fixture(); mutate(bad); assert.throws(() => outgoing.bindArtifact(bad.run, bad.artifact, bad.env, bad.review));
  }
});
test('all five payloads and exact template are checked before only the directory is materialized', () => {
  const f = fixture(); const admitted = outgoing.admit(f.review, f.files, runnerDirectory);
  assert.deepEqual(admitted.config, { ...f.template.config, directory: runnerDirectory });
  assert.equal(admitted.configSha256, hash(bytes(admitted.config)));
  assert.notEqual(admitted.configSha256, f.review.configCanonicalSha256);
  const target = require('../artifacts/menu-merge-20261027/outgoing/target.cjs');
  target.reviewConfig(admitted.config, admitted.configSha256);
  assert.throws(() => target.reviewConfig(admitted.config, f.review.configCanonicalSha256));
  for (const name of Object.keys(outgoing.LIMITS)) {
    const bad = fixture(); bad.files[name] = Buffer.from(bad.files[name]); bad.files[name][0] ^= 1;
    assert.throws(() => outgoing.admit(bad.review, bad.files, runnerDirectory));
    delete bad.files[name]; assert.throws(() => outgoing.admit(bad.review, bad.files, runnerDirectory));
  }
  assert.throws(() => outgoing.admit(f.review, { ...f.files, 'unreviewed.exe': Buffer.from('x') }, runnerDirectory));
  assert.throws(() => outgoing.admit(f.review, f.files, 'relative-directory'));
});
test('reviewed template still refuses private paths, wrong receipt, payload substitutions and config drift', () => {
  for (const mutate of [f => f.template.receiptSha256 = 'a'.repeat(64),
    f => f.template.config.directory = 'C:/Users/private/signed', f => f.template.config.directory = '.',
    f => f.template.config.baseline.installer = 'a'.repeat(64), f => f.template.config.pins.installer = 'a'.repeat(64),
    f => f.template.config.pins.descriptor = 'a'.repeat(64), f => f.template.config.pins.descriptorSignature = 'a'.repeat(64),
    f => f.template.config.pins.manifest = 'a'.repeat(64), f => f.template.config.baseline.version = '0.1.14',
    f => f.template.config.targetVersion = '0.1.16', f => f.template.config.runtime.targetDescriptor = 'pending',
    f => f.template.config.runtime.privatePath = 'C:/Users/private']) {
    const f = fixture(); mutate(f); refreshTemplate(f);
    assert.throws(() => outgoing.admit(f.review, f.files, runnerDirectory));
  }
  const f = fixture(); f.review.configCanonicalSha256 = 'a'.repeat(64);
  assert.throws(() => outgoing.admit(f.review, f.files, runnerDirectory));
});
function receipts(caseName) {
  const f = fixture(), config = f.template.config, [lastTool, restore] = outgoing.CASES[caseName];
  const report = { kind: outgoing.KIND, sourceCommit: config.sourceCommit, baseline: config.baseline, pins: config.pins,
    lastTool, restore: restore === 'true', restoredLastTool: restore === 'true' ? lastTool : null,
    beforePeVersion: [0, 1, 16, 0], afterPeVersion: [0, 1, 17, 0],
    passed: true, nativeUpdateAccepted: true, automaticRestart: true, cancelPreserved: true, settingsPreserved: true,
    existingConnectionSurvived: true, newConnectionVerified: true, restorationVerified: true, policyRestored: true,
    labDiscovery: true, acceptanceOnly: true, publicDiscovery: false, liveAiAcceptance: false, releaseReady: false };
  const lifecycle = [{ kind: 'lab-lifecycle-result', scenario: outgoing.KIND,
    actualScope: 'exact-direct16-to-root-only17-acceptance-fixture-lab-only',
    lifecycleSucceeded: true, cleanupVerified: true, systemTlsVerified: true, labDiscovery: true,
    publicDiscovery: false, liveAiAcceptance: false, productAcceptance: false, releaseReady: false,
    driverExitCode: 0, servedRouteCount: 5, rejectedRequestCount: 0 }];
  return { config, report, lifecycle };
}
test('each restore case independently needs native signed restart and complete TLS/cleanup evidence', () => {
  for (const caseName of Object.keys(outgoing.CASES)) {
    const f = receipts(caseName); outgoing.checkReceipt(f.report, f.lifecycle, f.config, caseName);
    for (const key of Object.keys(f.report).filter(key => typeof f.report[key] === 'boolean')) {
      assert.throws(() => outgoing.checkReceipt({ ...f.report, [key]: !f.report[key] }, f.lifecycle, f.config, caseName), key);
    }
    for (const key of Object.keys(f.lifecycle[0]).filter(key => typeof f.lifecycle[0][key] === 'boolean')) {
      assert.throws(() => outgoing.checkReceipt(f.report, [{ ...f.lifecycle[0], [key]: !f.lifecycle[0][key] }], f.config, caseName), key);
    }
    for (const change of [{ servedRouteCount: 4 }, { rejectedRequestCount: 1 }, { driverExitCode: 1 },
      { scenario: 'public-stable' }, { actualScope: 'exact-public14-to-direct16-lab-only' }]) {
      assert.throws(() => outgoing.checkReceipt(f.report, [{ ...f.lifecycle[0], ...change }], f.config, caseName));
    }
    assert.throws(() => outgoing.checkReceipt(f.report, [], f.config, caseName));
    assert.throws(() => outgoing.checkReceipt(f.report, [...f.lifecycle, ...f.lifecycle], f.config, caseName));
    assert.throws(() => outgoing.checkReceipt({ ...f.report, restoredLastTool: 'other' }, f.lifecycle, f.config, caseName));
    assert.throws(() => outgoing.checkReceipt({ ...f.report, afterPeVersion: [0, 1, 16, 0] }, f.lifecycle, f.config, caseName));
  }
});
test('workflow execution is manual branch-only, read-only and creates three independent Windows matrix jobs', () => {
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /\b(?:pull_request|schedule|workflow_run|workflow_call):/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/validation\/windows-menu-merge-20261027'/);
  assert.match(workflow, /permissions:\s+contents: read\s+actions: read/);
  assert.doesNotMatch(workflow, /contents: write|actions: write|secrets\.|cargo |gh release|workflow run|trustlocal|SkipCertificateCheck|NODE_TLS_REJECT_UNAUTHORIZED/);
  assert.equal((workflow.match(/runs-on: windows-latest/g) || []).length, 1);
  assert.match(workflow, /fail-fast: false/);
  assert.deepEqual([...workflow.matchAll(/- case: ([^\r\n]+)\r?\n\s+last_tool: ([^\r\n]+)\r?\n\s+restore: '([^']+)'/g)]
    .map(match => [match[1], [match[2], match[3]]]), Object.entries(outgoing.CASES));
  assert.equal((workflow.match(/native-self-update-lab\.ps1 -Outgoing017/g) || []).length, 1);
  assert.doesNotMatch(workflow, /-Incoming016|native-unified-outgoing-smoke|\.exe\s+\/S|\.exe\s+-/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /windows-outgoing-017-\$\{\{ matrix\.case \}\}-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
});
test('registration push is validation-branch-only and every job skips unless explicitly dispatched on that branch', () => {
  assert.match(workflow, /on:\r?\n  push:\r?\n    branches: \[validation\/windows-menu-merge-20261027\]\r?\n  workflow_dispatch:/);
  const events = workflow.match(/^on:\r?\n([\s\S]*?)^permissions:/m)[1];
  assert.deepEqual([...events.matchAll(/^  ([a-z_]+):/gm)].map(match => match[1]), ['push', 'workflow_dispatch']);
  const jobs = workflow.match(/^jobs:\r?\n([\s\S]*)/m)[1];
  const gate = "github.repository == 'BOBWORKS-XR/CREATOR-HUB' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/validation/windows-menu-merge-20261027'";
  assert.deepEqual([...jobs.matchAll(/^  ([a-zA-Z0-9_-]+):/gm)].map(match => match[1]), ['acceptance']);
  assert.deepEqual([...jobs.matchAll(/^  ([a-zA-Z0-9_-]+):\r?\n    if: ([^\r\n]+)/gm)]
    .map(match => [match[1], match[2]]), [['acceptance', gate]]);
  const f = fixture();
  assert.throws(() => outgoing.assertHost({ ...f.env, GITHUB_EVENT_NAME: 'push' }, 'win32'));
  assert.throws(() => outgoing.assertHost({ ...f.env, GITHUB_REF: 'refs/heads/main' }, 'win32'));
});
test('artifact binding and every payload/config pin precede the unchanged contract and native trust lifecycle', () => {
  const ordered = ['.cjs review', 'gh api --method GET', '.cjs bind', 'actions/download-artifact@v4',
    '.cjs prepare', '- run: npm ci', 'node --test', '.cjs contract', 'native-self-update-lab.ps1 -Outgoing017', '.cjs receipt', 'actions/upload-artifact@v4'];
  let previous = -1;
  for (const part of ordered) { const index = workflow.indexOf(part); assert.ok(index > previous, part); previous = index; }
  assert.match(workflow, /CREATOR_OUTGOING_CONFIG_SHA256=\$\(\$admission\.configSha256\)/);
  assert.match(workflow, /artifact-ids: \$\{\{ inputs\.artifact_id \}\}/);
  assert.match(workflow, /run-id: \$\{\{ inputs\.artifact_run \}\}/);
  const source = fs.readFileSync(path.join(__dirname, 'windows-outgoing-017.cjs'), 'utf8');
  assert.match(source, /target\.loadContract\(admitted\.config, env\)/);
  assert.match(source, /assert\.equal\(env\.CREATOR_OUTGOING_CONFIG_SHA256, admitted\.configSha256\)/);
  assert.doesNotMatch(source, /execFileSync|spawnSync|startLabProxy|New-SelfSignedCertificate|Copy-Item/);
});
test('checkout must include the existing outgoing factory, lifecycle mode and exact guarded driver path', () => {
  const feed = require('./self-update-lab-feed.cjs');
  assert.equal(typeof feed.createDirectOutgoing017Contract, 'function');
  const lifecycle = fs.readFileSync(path.join(__dirname, 'native-self-update-lab.ps1'), 'utf8');
  assert.match(lifecycle, /\[switch\]\$Outgoing017/);
  for (const name of ['target.cjs', 'driver.cjs']) {
    assert.ok(lifecycle.includes(`../artifacts/menu-merge-20261027/outgoing/${name}`));
    assert.ok(fs.statSync(path.join(__dirname, '../artifacts/menu-merge-20261027/outgoing', name)).isFile());
  }
  const driver = require('../artifacts/menu-merge-20261027/outgoing/driver.cjs');
  assert.equal(typeof driver.assertTicket, 'function'); assert.equal(typeof driver.main, 'function');
});
test('outgoing caller and receipt/upload paths use the unchanged native-suite policy contract', () => {
  const source = fs.readFileSync(path.join(__dirname, '../artifacts/menu-merge-20261027/outgoing/driver.cjs'), 'utf8');
  const policy = fs.readFileSync(path.join(__dirname, 'native-webview-policy.ps1'), 'utf8');
  assert.ok(source.includes("const out = path.join(ROOT, 'artifacts', `native-suite-${Date.now()}`); fs.mkdirSync(out);"));
  assert.ok(policy.includes("-notmatch '^native-suite-[0-9]+$'"));
  assert.match(source, /path\.join\(out, 'webview-policy\.json'\)/);
  assert.match(source, /path\.join\(out, 'outgoing-report\.json'\)/);
  assert.ok(workflow.includes("Get-ChildItem -LiteralPath artifacts -Directory -Filter 'native-suite-*'"));
  assert.match(workflow, /\$reports\.Count -ne 1/);
  assert.match(workflow, /artifacts\/native-suite-\*\/\*\.json/);
  assert.match(workflow, /artifacts\/native-suite-\*\/\*\.png/);
  assert.doesNotMatch(workflow, /outgoing\/native-\*/);
});

test('initial16 explicitly accepts terms and visibly defers the guide; restart17 never dismisses either', async () => {
  const driver = require('../artifacts/menu-merge-20261027/outgoing/driver.cjs');
  function mockPage(visible = {}, missingGuide = false) {
    const events = [];
    return { events, locator: selector => ({
      waitFor: async ({ state }) => {
        events.push(`${selector}:${state}`);
        if (missingGuide && selector === '#convergence-dialog' && state === 'visible') throw Error('Guide never appeared');
      },
      check: async () => { events.push(`${selector}:check`); },
      click: async () => { events.push(`${selector}:click`); },
      isVisible: async () => { events.push(`${selector}:isVisible`); return visible[selector] === true; },
    }), waitForFunction: async () => { events.push('startup-ready'); } };
  }
  const page = mockPage(), report = {};
  await driver.completeStartup(page, '0.1.16', report);
  assert.deepEqual(page.events, ['#usage-terms-dialog:visible', '#usage-terms-checkbox:check',
    '#usage-terms-continue:click', '#usage-terms-dialog:hidden', '#convergence-dialog:visible',
    '#convergence-later:click', '#convergence-dialog:hidden', 'startup-ready', '#convergence-dialog:isVisible']);
  assert.equal(report.migrationDeferred, true);
  const restart = mockPage(); await driver.completeStartup(restart, '0.1.17', report);
  assert.deepEqual(restart.events, ['#usage-terms-dialog:isVisible', 'startup-ready', '#convergence-dialog:isVisible']);
  assert.equal(report.migrationDeferralPreserved, true);
  for (const selector of ['#usage-terms-dialog', '#convergence-dialog']) {
    const unexpected = mockPage({ [selector]: true });
    const failed = { migrationDeferred: true };
    await assert.rejects(driver.completeStartup(unexpected, '0.1.17', failed));
    assert.equal(unexpected.events.some(event => /:click|:check/.test(event)), false);
    assert.equal(failed.migrationDeferralPreserved, undefined);
  }
  const missing = {}, absentGuide = mockPage({}, true);
  await assert.rejects(driver.completeStartup(absentGuide, '0.1.16', missing), /Guide never appeared/);
  assert.equal(missing.migrationDeferred, undefined);
  await assert.rejects(driver.completeStartup(mockPage(), '0.1.17', {}), /visibly deferred/);
  const source = fs.readFileSync(path.join(__dirname, '../artifacts/menu-merge-20261027/outgoing/driver.cjs'), 'utf8');
  assert.match(source, /await completeStartup\(page, version, report\)/);
  assert.doesNotMatch(driver.completeStartup.toString(), /setItem|\.evaluate\(|force:|\.close\(/);
});

test('preferences use Home and the actual update-settings summary, with visible UI changes for both restore values', async t => {
  const driver = require('../artifacts/menu-merge-20261027/outgoing/driver.cjs');
  const direct = require('./native-self-update-direct.cjs');
  let events, open;
  t.mock.method(direct, 'showHome', async () => { events.push('home'); });
  for (const restore of [true, false]) {
    events = []; open = false;
    const page = { locator: selector => ({
      click: async () => {
        assert.equal(selector, '#update-settings > summary'); assert.equal(events[0], 'home');
        open = !open; events.push(open ? 'details-open' : 'details-closed');
      },
      setChecked: async value => { assert.equal(open, true); events.push([selector, value]); },
    }) };
    await driver.setUpdatePreferences(page, restore);
    assert.deepEqual(events, ['home', 'details-open', ['#auto-download', false], ['#preview-channel', false],
      ['#restore-hosted-views', restore], 'details-closed']);
  }
  const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
  assert.ok(app.includes("byId('update-settings').append(document.querySelector('#view-hub > .update-preferences'))"));
  assert.match(html, /<details id="update-settings"><summary>Update settings<\/summary>/);
  const source = fs.readFileSync(path.join(__dirname, '../artifacts/menu-merge-20261027/outgoing/driver.cjs'), 'utf8');
  assert.match(source, /await setUpdatePreferences\(page, restore\)/);
  assert.match(source, /saved\.restoreHostedViews, restore/);
  assert.doesNotMatch(driver.setUpdatePreferences.toString(), /suite-trigger|suite-menu|\.evaluate\(|force:/);
});

test('all inline PowerShell blocks parse without executing their contents', () => {
  const blocks = [...workflow.matchAll(/        run: \|\r?\n((?:          [^\r\n]*\r?\n)+)/g)]
    .map(match => match[1].split(/\r?\n/).map(line => line.slice(10)).join('\n'));
  assert.equal(blocks.length, 5);
  const command = '$texts=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OUTGOING_PARSE_INPUT))|ConvertFrom-Json;foreach($text in $texts){$t=$null;$e=$null;[void][Management.Automation.Language.Parser]::ParseInput($text,[ref]$t,[ref]$e);if($e.Count){$e|ForEach-Object{$_.Message};exit 1}}';
  const result = spawnSync(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', command],
    { env: { ...process.env, OUTGOING_PARSE_INPUT: bytes(blocks).toString('base64') }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
