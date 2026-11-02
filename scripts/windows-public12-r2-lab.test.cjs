'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const lab = require('./windows-public12-r2-lab.cjs');
const candidate = require('./windows-incoming-016.cjs');
const receipt = require('./windows-public12-r2-receipt.cjs');
const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, lab.WORKFLOW), 'utf8');
const driver = fs.readFileSync(path.join(__dirname, 'native-self-update-smoke.cjs'), 'utf8');
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: `refs/heads/${lab.BRANCH}`, GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${lab.WORKFLOW}@refs/heads/${lab.BRANCH}`,
  GITHUB_SHA: 'a'.repeat(40), CREATOR_PUBLIC12_R2_LAB: '1' };
const pins = () => ({ descriptor: 'a'.repeat(64), descriptorSignature: 'b'.repeat(64), installer: lab.TARGET.installer,
  manifest: 'c'.repeat(64), executable: lab.TARGET.exe });

test('only exact hosted manual public12 R2 lane can access contract or native work', () => {
  lab.assertHost(env, 'win32');
  assert.throws(() => lab.assertHost(env, 'linux'));
  for (const key of Object.keys(env)) assert.throws(() => lab.assertHost({ ...env, [key]: undefined }, 'win32'), key);
  assert.throws(() => lab.assertHost({ ...env, CREATOR_HOSTED_UPDATE_FIXTURE: 'fake' }, 'win32'));
  assert.equal(lab.BASELINE.version, '0.1.12');
  assert.equal(lab.BASELINE.installer, '0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18');
  assert.equal(lab.BASELINE.exe, '34c6f05548f469ac23b4faee7aa8355d5cca083c444c4f7b0942426a9c76a7ac');
  assert.strictEqual(lab.TARGET, candidate.TARGET);
  assert.equal(lab.TARGET.installer, '7326d054ac23b7ac560e2c3488933203a33f0033586b1c33988ce7f316e4c51a');
  assert.equal(lab.TARGET.exe, 'fac846563720eb4dae665a814ea28d0556800ebaf75aba7e8ee0be7f1979a5cd');
  for (const bad of [{ ...pins(), descriptor: '0'.repeat(64) }, { ...pins(), installer: 'd'.repeat(64) },
    { ...pins(), executable: 'd'.repeat(64) }, { ...pins(), extra: 'e'.repeat(64) }, {}]) assert.throws(() => lab.validatePins(bad));
});
test('workflow keeps data-only staging, exact R2, independent pins, ownership and pre-native ordering', () => {
  const signed = workflow.split('  signed012:')[1]; assert.ok(signed);
  const stager = fs.readFileSync(path.join(root, '.github/workflows/windows-016-input.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/); assert.doesNotMatch(workflow, /pull_request:|signer sign|SkipCertificateCheck|gh release/);
  assert.match(signed, /github\.ref == 'refs\/heads\/validation\/windows-menu-merge-20261027'.*inputs\.mode == 'signed012'/);
  assert.ok(stager.includes('424919952') && stager.includes('701701405') && stager.includes(lab.TARGET.installer));
  for (const marker of ['Reviewed artifact identity differs', 'Reviewed stager provenance differs', 'artifact.digest', 'artifact.workflow_run.id', 'reparsepoint',
    'windows-public12-r2-lab.cjs check', 'native-self-update-lab.ps1', 'baseline.exe',
    'windows-public12-r2-receipt.cjs']) assert.ok(signed.toLowerCase().includes(marker.toLowerCase()), marker);
  assert.ok(signed.indexOf('validate-pins $env:SIGNED_PINS') < signed.indexOf('actions/download-artifact'));
  assert.ok(signed.indexOf('windows-public12-r2-lab.cjs check') < signed.indexOf('Stage the exact original public 0.1.12 installer'));
  assert.ok(signed.indexOf('Stage the exact original public 0.1.12 installer') < signed.indexOf('Disposable controlled-feed update'));
  const connect = driver.slice(driver.indexOf('async function connect('), driver.indexOf('async function showApps('));
  assert.ok(connect.indexOf('assertOwnedDebugging(diagnostics(), ownedPid, hub)') < connect.indexOf('chromium.connectOverCDP'));
  assert.match(connect, /assertOwnedDebugging\(state, ownedPid, hub\)/);
  assert.match(driver, /const from = public12Lab \? \{ \.\.\.public12Lab\.BASELINE \} : selectBaseline\(to\.version\)/);
  assert.match(driver, /nativeAcceptance: false, publicDiscovery: false, releaseReady: false/);
});

const installerPath = process.env.CREATOR_TEST_CANDIDATE_PATH;
test('actual R2 bytes require a pinned test-only min12 descriptor and reject the min14 descriptor', { skip: !installerPath }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public12-r2-contract-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.match(path.basename(dir), /^public12-r2-contract-/);
    fs.rmSync(dir, { recursive: true });
  });
  fs.copyFileSync(installerPath, path.join(dir, lab.TARGET.asset), fs.constants.COPYFILE_EXCL);
  const signature = Buffer.from('untrusted comment: synthetic envelope only, not a valid signature\nfixture\n');
  const descriptor = { schemaVersion: 1, appId: 'creator-hub', version: '0.1.16', platform: 'windows', architecture: 'x86_64',
    packageType: 'nsis', assetName: lab.TARGET.asset, byteLength: lab.TARGET.bytes, sha256: lab.TARGET.installer,
    executableSha256: lab.TARGET.exe, identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1, minHubVersion: '0.1.12' };
  const manifest = Buffer.from(JSON.stringify({ version: '0.1.16', platforms: { 'windows-x86_64': {
    url: `https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.16/${lab.TARGET.asset}`,
    signature: signature.toString('base64') } } }));
  const descFile = path.join(dir, 'creator-hub-windows-x86_64.json');
  const descriptorBytes = Buffer.from(JSON.stringify(descriptor));
  fs.writeFileSync(descFile, descriptorBytes, { flag: 'wx' });
  fs.writeFileSync(`${descFile}.minisig`, signature, { flag: 'wx' });
  fs.writeFileSync(path.join(dir, 'latest.json'), manifest, { flag: 'wx' });
  const config = { schemaVersion: 1, targetVersion: '0.1.16', directory: dir,
    pins: { descriptor: candidate.hash(descriptorBytes), descriptorSignature: candidate.hash(signature), installer: lab.TARGET.installer,
      manifest: candidate.hash(manifest), executable: lab.TARGET.exe } };
  assert.deepEqual(lab.loadContract(config).baseline, lab.BASELINE);
  fs.writeFileSync(descFile, JSON.stringify({ ...descriptor, minHubVersion: '0.1.14' }));
  assert.throws(() => lab.loadContract({ ...config, pins: { ...config.pins, descriptor: candidate.hash(fs.readFileSync(descFile)) } }));
  fs.writeFileSync(descFile, descriptorBytes);
  const wrongProtocol = Buffer.from(JSON.stringify({ ...descriptor, identityProtocol: 1 }));
  fs.writeFileSync(descFile, wrongProtocol);
  assert.throws(() => lab.loadContract({ ...config, pins: { ...config.pins, descriptor: candidate.hash(wrongProtocol) } }));
  fs.writeFileSync(descFile, descriptorBytes);
  assert.throws(() => lab.loadContract({ ...config, pins: { ...config.pins, descriptorSignature: 'd'.repeat(64) } }));
  assert.throws(() => lab.loadContract({ ...config, pins: { ...config.pins, manifest: 'd'.repeat(64) } }));
});

test('receipt binds test-only lab, exact baseline and target, restart and cleanup without wider acceptance', () => {
  const config = { pins: pins() }, report = { from: lab.BASELINE, to: { version: lab.TARGET.version, installer: lab.TARGET.installer, exe: lab.TARGET.exe },
    feed: { kind: lab.KIND, pins: config.pins, ...candidate.productProvenance() }, harnessSource: env.GITHUB_SHA,
    sourceKind: 'targeted-public-0.1.12-not-previous-stable',
    passed: true, selfUpdateTested: true, directHubUpdateTested: true, managedRouteReconnectTested: true, pluginsRemoved: true,
    policyRestored: true, labDiscovery: true, testOnlyDescriptor: true, nativeAcceptance: false, publicDiscovery: false,
    releaseReady: false, userMachineUsed: false, originalExitCode: 0, originalPid: 10, restartedPid: 11 };
  const lifecycle = [{ kind: 'lab-lifecycle-result', scenario: 'public-stable', actualScope: 'unmodified-public-0.1.12-lab-only',
    lifecycleSucceeded: true, cleanupVerified: true, systemTlsVerified: true, labDiscovery: true, productAcceptance: false,
    publicDiscovery: false, liveAiAcceptance: false, releaseReady: false, driverExitCode: 0, servedRouteCount: 5, rejectedRequestCount: 0 }];
  receipt.checkReceipt(report, lifecycle, config, { pins: config.pins }, env.GITHUB_SHA);
  for (const change of [{ nativeAcceptance: true }, { releaseReady: true }, { testOnlyDescriptor: false }, { restartedPid: 10 },
    { from: { ...lab.BASELINE, exe: '0'.repeat(64) } }, { feed: { ...report.feed, pins: { ...pins(), descriptor: 'd'.repeat(64) } } }]) {
    assert.throws(() => receipt.checkReceipt({ ...report, ...change }, lifecycle, config, { pins: config.pins }, env.GITHUB_SHA));
  }
  for (const change of [{ cleanupVerified: false }, { systemTlsVerified: false }, { rejectedRequestCount: 1 }, { servedRouteCount: 4 }]) {
    assert.throws(() => receipt.checkReceipt(report, [{ ...lifecycle[0], ...change }], config, { pins: config.pins }, env.GITHUB_SHA));
  }
});

test('workflow shell blocks parse without executing', { skip: process.platform !== 'win32' }, () => {
  const blocks = [...workflow.matchAll(/^        run: \|\r?\n((?:          .*\r?\n|\r?\n)*)/gm)].map(m => m[1].split(/\r?\n/).map(s => s.replace(/^          /, '')).join('\n'));
  assert.ok(blocks.length >= 5);
  const payload = Buffer.from(JSON.stringify(blocks)).toString('base64');
  const command = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;foreach($s in $p){$t=$null;$e=$null;[void][Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e);if($e.Count){throw ($e|Out-String)}};'PARSED'`;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /PARSED/);
});
