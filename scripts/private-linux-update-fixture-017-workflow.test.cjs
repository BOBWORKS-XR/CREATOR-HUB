'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { yaml } = require('../node_modules/playwright-core/lib/utilsBundle.js');
const fixture = require('./private-linux-update-fixture-017.cjs');
const metadata = require('./private-linux-update-fixture-017-metadata.cjs');
const { data } = require('./fixtures/private-linux-update-fixture-017.cjs');
const source = fs.readFileSync(path.join(__dirname, '../.github/workflows/private-linux-update-fixture-017.yml'), 'utf8');
const parsed = yaml.parseDocument(source, { uniqueKeys: true });
assert.deepEqual(parsed.errors, []);
const workflow = parsed.toJSON();
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test('registration push has exact017 branch only, and neither execution job can run on pushes/forks/another branch', () => {
  assert.deepEqual(workflow.on.push.branches, ['validation/linux-private-update-fixture-017']);
  assert.deepEqual(Object.keys(workflow.on['workflow_dispatch'].inputs), ['signed_input', 'plan']);
  assert.deepEqual(Object.keys(workflow.jobs), ['stage-input', 'assemble']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const good = { repository: 'BOBWORKS-XR/CREATOR-HUB', repository_id: '1364807512', ref: fixture.BRANCH, event_name: 'workflow_dispatch' };
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job['runs-on'], 'ubuntu-22.04');
    const guard = new Function('github', `return (${job.if});`);
    assert.equal(guard(good), true);
    for (const [key, value] of Object.entries({ repository: 'someone/fork', repository_id: '2', ref: 'refs/heads/main', event_name: 'push' })) {
      assert.equal(guard({ ...good, [key]: value }), false);
    }
  }
  assert.equal(workflow.jobs.assemble.needs, 'stage-input');
});
test('draft-access job is data-only, with no checkout/dependency/native execution or secret logging', () => {
  const job = workflow.jobs['stage-input'];
  assert.deepEqual(job.permissions, { contents: 'write' });
  assert.equal(job.steps.length, 2); assert.equal(job.steps[0].uses, 'actions/github-script@v8');
  assert.equal(job.steps[1].uses, 'actions/upload-artifact@v4');
  assert.ok(job.steps.every(step => !step.run));
  const body = job.steps[0].with.script;
  assert.doesNotMatch(body, /child_process|execFile|spawn|require\(['"]\.\/|console\.|secrets\.|TOKEN|auth\.json|signDetached|signingKey/);
  assert.ok(body.indexOf('assert.equal(hash(Buffer.from(planText)),p.planSha256)') < body.indexOf('getRelease('));
  assert.ok(body.indexOf('assert.equal(asset.digest,') < body.indexOf('getReleaseAsset('));
  assert.ok(body.indexOf('assert.equal(hash(bytes),p.zipSha256)') < body.indexOf('fs.writeFileSync('));
});
async function gate(t, fault = '') {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'private017-workflow-unit-')));
  t.after(() => { assert.equal(fs.realpathSync(temp), temp); fs.rmSync(temp, { recursive: true, force: true }); });
  const f = data(), bytes = Buffer.from('Synthetic signed ZIP. Never decoded by the privileged data-only job.');
  const profile = { assetId: 1234, zipBytes: bytes.length, zipSha256: metadata.hash(bytes), planSha256: metadata.hash(Buffer.from(JSON.stringify(f.plan, null, 2))) };
  const context = { repo: { owner: 'BOBWORKS-XR', repo: 'CREATOR-HUB' }, eventName: 'workflow_dispatch', ref: fixture.BRANCH, sha: f.plan.rootSource.sourceCommit };
  const release = { id: 411494394, draft: true, tag_name: 'v0.1.13-validation' };
  const asset = { id: profile.assetId, name: `signed-private-linux-update-fixture-017-${context.sha}.zip`, state: 'uploaded', size: bytes.length, digest: `sha256:${profile.zipSha256}` };
  if (fault === 'plan-version') f.plan.hubVersion = '0.1.16';
  if (fault === 'acceptance') f.plan.releaseReady = true;
  if (fault === 'root-source') context.sha = 'a'.repeat(40);
  if (fault === 'push') context.eventName = 'push';
  if (fault === 'size') profile.zipBytes = 1024 * 1024 * 1024 + 1;
  if (fault === 'extra') profile.other = 1;
  if (fault === 'name') asset.name = 'relabelled-original016.zip';
  if (fault === 'asset-hash') asset.digest = `sha256:${'a'.repeat(64)}`;
  if (fault === 'draft') release.draft = false;
  if (fault === 'tag') release.tag_name = 'v0.1.17';
  const env = { SIGNED_INPUT: JSON.stringify(profile), APPROVED_PLAN: JSON.stringify(f.plan, null, 2),
    GITHUB_REPOSITORY_ID: '1364807512', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', RUNNER_TEMP: temp };
  // Refresh the independent hash for semantic failures; otherwise the hash gate alone would cover them.
  if (['plan-version', 'acceptance'].includes(fault)) { profile.planSha256 = metadata.hash(Buffer.from(env.APPROVED_PLAN)); env.SIGNED_INPUT = JSON.stringify(profile); }
  if (fault === 'duplicate') env.SIGNED_INPUT = env.SIGNED_INPUT.replace('{', '{"assetId":1234,');
  const calls = [];
  const github = { rest: { repos: {
    getRelease: async args => { calls.push('release'); assert.equal(args.release_id, 411494394); return { data: release }; },
    listReleaseAssets: async args => { calls.push('list'); assert.equal(args.page, 1); assert.equal(args.per_page, 100); return { data: [asset] }; },
    getReleaseAsset: async args => { calls.push('download'); assert.equal(args.asset_id, profile.assetId); return { data: fault === 'bytes' ? Buffer.from('changed') : bytes }; },
  } } };
  const evaluate = new AsyncFunction('require', 'process', 'github', 'context', workflow.jobs['stage-input'].steps[0].with.script);
  return { temp, calls, execute: () => evaluate(require, { env }, github, context), fault };
}
test('mock data-only gate binds exact approved plan/source/asset bytes and writes only three fresh data files', async t => {
  const f = await gate(t); await f.execute();
  assert.deepEqual(f.calls, ['release', 'list', 'download']);
  assert.deepEqual(fs.readdirSync(f.temp).sort(), ['approved-plan.json', 'private017-signed.zip', 'signed-input.json']);
  await assert.rejects(f.execute(), /EEXIST/);
});
test('bad input/source/acceptance/push refuses before API; wrong asset metadata refuses before byte download', async t => {
  for (const fault of ['duplicate', 'extra', 'size', 'plan-version', 'acceptance', 'root-source', 'push', 'name', 'asset-hash', 'draft', 'tag', 'bytes']) {
    const f = await gate(t, fault); await assert.rejects(f.execute());
    assert.deepEqual(fs.readdirSync(f.temp), []);
    if (['duplicate', 'extra', 'size', 'plan-version', 'acceptance', 'root-source', 'push'].includes(fault)) assert.equal(f.calls.length, 0);
    else if (fault !== 'bytes') assert.equal(f.calls.includes('download'), false);
  }
});
test('unprivileged job stages and refreshes provenance before dependencies, then calls only the new assembler', () => {
  const job = workflow.jobs.assemble;
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read' });
  assert.deepEqual(job.env, { CREATOR_LINUX_PRIVATE_UPDATE_FIXTURE_017: '1' });
  const checkout = job.steps.find(step => step.uses === 'actions/checkout@v6');
  assert.deepEqual(checkout.with, { 'fetch-depth': 0, 'persist-credentials': false });
  const at = text => job.steps.findIndex(step => step.run?.includes(text) || step.with?.script?.includes(text));
  assert.ok(at('stage-private-linux-update-fixture-017.py') < at('apt-get install'));
  assert.ok(at('assembly.inputs(') < at('apt-get install'));
  assert.ok(at('provenance.fresh(') < at('apt-get install'));
  assert.ok(at('cargo fetch --locked') < at('node scripts/private-linux-update-fixture-017-assemble.cjs'));
  assert.ok(at('npm ci') < at('node scripts/private-linux-update-fixture-017-assemble.cjs'));
  assert.doesNotMatch(source, /continue-on-error|secrets\.|signDetached|signingKey|gh release|publish-hub|apt-get.*creator-hub|--linux-production-migration-016|--linux-integrated-candidate/);
  const retain = job.steps.find(step => step.uses === 'actions/upload-artifact@v4');
  assert.equal(retain.if, 'always()'); assert.doesNotMatch(retain.with.path, /signing-input|\.sig$|auth\.json|\.key/);
});
test('clean runner installs pinned Node and hook-free locked JS dependencies before pure imports, while native/hooked setup stays after provenance', () => {
  const steps = workflow.jobs.assemble.steps;
  const node = steps.findIndex(step => step.uses === 'actions/setup-node@v6');
  const pure = steps.findIndex(step => step.run?.includes('node --test scripts/private-linux-update-fixture-017.test.cjs'));
  const safe = steps.findIndex(step => step.run?.trim() === 'npm ci --ignore-scripts');
  const data = steps.findIndex(step => step.run?.includes('assembly.inputs('));
  const provenance = steps.findIndex(step => step.with?.script?.includes('provenance.fresh('));
  const native = steps.findIndex(step => step.run?.includes('apt-get install'));
  const hooked = steps.findIndex(step => step.run?.split('\n').some(line => line.trim() === 'npm ci'));
  assert.ok(node >= 0 && safe > node && pure > safe, 'Clean runner must provision JS imports without hooks before pure tests');
  assert.equal(steps[node].with['node-version'], '24.17.0');
  assert.equal(steps.filter(step => step.uses === 'actions/setup-node@v6').length, 1);
  assert.ok(data > pure && provenance > data && native > provenance && hooked >= native);
  for (const step of steps.slice(0, provenance + 1)) {
    assert.doesNotMatch(step.run || '', /apt-get|cargo (?:build|fetch|test)|npm (?:install|run)/);
    const installs = (step.run || '').split('\n').filter(line => /^npm ci(?:\s|$)/.test(line.trim()));
    assert.ok(installs.every(line => line.trim() === 'npm ci --ignore-scripts'), 'No hook-enabled npm setup before provenance');
  }
});
test('all embedded JavaScript and bash blocks parse without running build/install/signing commands', () => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  assert.ok(fs.existsSync(bash), 'Owned syntax validation requires the installed shell');
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    if (step.with?.script) new AsyncFunction('require', 'process', 'github', 'context', step.with.script);
    if (step.run) {
      const checked = spawnSync(bash, ['-n'], { input: step.run, encoding: 'utf8', windowsHide: true, timeout: 10000 });
      assert.equal(checked.status, 0, checked.stderr);
      for (const match of step.run.matchAll(/node - <<'NODE'\n([\s\S]*?)\nNODE/g)) new Function(match[1]);
    }
  }
  const stager = fs.readFileSync(path.join(__dirname, 'stage-private-linux-update-fixture-017.py'), 'utf8');
  for (const name of metadata.INPUTS) assert.ok(stager.includes(`'${name}'`), `Missing finite017 staged input ${name}`);
});
