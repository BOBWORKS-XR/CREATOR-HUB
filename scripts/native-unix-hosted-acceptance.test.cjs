const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const h = require('./native-unix-hosted-acceptance.cjs');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function binding(target = 'linux') {
  const source = 'a'.repeat(40), merge = 'b'.repeat(40), base = 'c'.repeat(40), tree = 'd'.repeat(40);
  const repo = { id: h.REPOSITORY_ID, full_name: h.REPOSITORY }, t = h.TARGETS[target];
  return {
    expected: { target, runId: 123, artifactId: 456, sourceCommit: source, buildCommit: merge, baseCommit: base, zipSha256: sha('zip') },
    run: { id: 123, head_sha: source, status: 'completed', conclusion: 'success', event: 'pull_request', run_attempt: 2,
      repository: repo, head_repository: repo, path: '.github/workflows/unified-unix-candidate.yml' },
    artifact: { id: 456, name: `unified-unix-candidate-${t.os}-${t.runnerArch}-${merge}`, expired: false,
      digest: `sha256:${sha('zip')}`, size_in_bytes: 3,
      workflow_run: { id: 123, head_sha: source, repository_id: h.REPOSITORY_ID, head_repository_id: h.REPOSITORY_ID } },
    source: { sha: source, tree: { sha: tree } }, build: { sha: merge, tree: { sha: tree }, parents: [{ sha: base }, { sha: source }] },
    jobs: [{ name: t.job, run_id: 123, run_attempt: 2, status: 'completed', conclusion: 'success' }],
  };
}
for (const target of Object.keys(h.TARGETS)) test(`exact ${target} source/merge/attempt/API artifact binding`, () => {
  assert.equal(h.validateBinding(binding(target)).runAttempt, 2);
});
for (const [name, mutate] of Object.entries({
  head: b => { b.run.head_sha = 'f'.repeat(40); }, repo: b => { b.run.repository = { id: 1, full_name: h.REPOSITORY }; },
  foreignHead: b => { b.run.head_repository = { id: 2, full_name: h.REPOSITORY }; },
  run: b => { b.artifact.workflow_run.id++; }, digest: b => { b.artifact.digest = `sha256:${'e'.repeat(64)}`; },
  label: b => { b.artifact.name = b.artifact.name.replace('b'.repeat(40), 'a'.repeat(40)); },
  tree: b => { b.build.tree.sha = 'e'.repeat(40); }, parents: b => { b.build.parents.reverse(); },
  attempt: b => { b.jobs[0].run_attempt = 1; }, canceled: b => { b.jobs[0].conclusion = 'cancelled'; },
  duplicate: b => { b.jobs.push(b.jobs[0]); }, expired: b => { b.artifact.expired = true; },
  size: b => { b.artifact.size_in_bytes = 1024 ** 3; }, workflow: b => { b.run.path = '.github/workflows/ci.yml'; },
})) test(`binding refuses ${name}`, () => { const b = binding(); mutate(b); assert.throws(() => h.validateBinding(b)); });
test('dispatch binds one exact commit, without an invented merge', () => {
  const b = binding(); b.run.event = 'workflow_dispatch'; b.expected.baseCommit = '';
  b.expected.buildCommit = b.expected.sourceCommit; b.build = structuredClone(b.source);
  b.artifact.name = b.artifact.name.replace('b'.repeat(40), b.expected.sourceCommit);
  h.validateBinding(b);
});
test('runner refuses PC, Windows, missing opt-in, wrong architecture and Flatpak before any input read', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', CREATOR_UNIX_HOSTED_EXPERIMENT: '1' };
  h.runner(env, 'linux', 'x64');
  for (const change of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { CREATOR_UNIX_HOSTED_EXPERIMENT: '' },
    { RUNNER_ARCH: 'ARM64' }, { FLATPAK_ID: 'test' }]) assert.throws(() => h.runner({ ...env, ...change }, 'linux', 'x64'));
  assert.throws(() => h.runner(env, 'win32', 'x64'));
});
function fixture() {
  const before = { 'client-config': sha('old entries plus unrelated options'), 'launcher-settings': sha('old settings'), 'project-sentinel': sha('synthetic fixture') };
  const node = { pid: 987, startTime: '1234', exeSha256: sha('unrelated node') };
  const common = { privatePipes: true, exactDirectParent: true, payloadBound: true, identityBefore: sha('owned parent and backend'), identityAfter: sha('owned parent and backend') };
  return { synthetic: true, experimentalFeature: 'experimental-unix-hosting', storageInjected: false, actualAiUsed: false,
    beforeImages: before, afterImages: { ...before }, unrelatedNodeBefore: node, unrelatedNodeAfter: { ...node },
    events: ['mcp', 'setup'].flatMap(app => [
      { ...common, app, phase: 'decline', nativeConsent: 'declined', backendExited: true, writes: 0, retryEnabled: true },
      { ...common, app, phase: 'retry-open', nativeConsent: 'approved', effectiveMode: app === 'mcp' ? 'writable' : 'setup' },
      { ...common, app, phase: 'harmless-probe', command: app === 'mcp' ? 'get_hosted_snapshot' : 'get_recipe', ok: true, writes: 0 },
      { ...common, app, phase: 'normal-close', requested: true, exitCode: 0, backendExited: true, survivors: 0 },
    ]) };
}
test('complete synthetic decline/retry/status/recipe/owned-exit contract is never native acceptance', () => {
  assert.deepEqual(h.validateFixture(fixture()), { contractFixturePassed: true, nativeGuiTested: false, passed: false, releaseReady: false });
});
for (const [name, mutate] of Object.entries({
  settingsLoss: t => { t.afterImages['launcher-settings'] = sha('lost'); },
  clientLoss: t => { delete t.afterImages['client-config']; },
  unrelatedNode: t => { t.unrelatedNodeAfter.startTime = '4321'; },
  noBeforeImage: t => { delete t.beforeImages['project-sentinel']; },
  noDecline: t => { t.events.shift(); }, duplicateRetry: t => { t.events.push(t.events[1]); },
  foreignEvent: t => { t.events.push({app:'foreign',phase:'write'}); },
  noConsent: t => { t.events[1].nativeConsent = 'implicit'; }, readonly: t => { t.events[1].effectiveMode = 'read-only'; },
  parentOverride: t => { t.events[1].exactDirectParent = false; }, publicPipe: t => { t.events[1].privatePipes = false; },
  changedPayload: t => { t.events[1].payloadBound = false; }, identityDrift: t => { t.events[2].identityAfter = sha('foreign'); },
  declinedWrites: t => { t.events[0].writes = 1; }, operationWrites: t => { t.events[2].writes = 1; },
  wrongOperation: t => { t.events[2].command = 'one_click_setup'; },
  nonzeroClose: t => { t.events[3].exitCode = 1; }, hangingClose: t => { t.events[3].exitCode = null; },
  backendSurvives: t => { t.events[3].survivors = 1; }, noNormalClose: t => { t.events[3].requested = false; },
  injectedStorage: t => { t.storageInjected = true; }, ai: t => { t.actualAiUsed = true; },
})) test(`fixture fails closed on ${name}`, () => { const t = fixture(); mutate(t); assert.throws(() => h.validateFixture(t)); });
test('blocked report keeps explicit Unix review gates and all acceptance flags false', () => {
  const r = h.blockedReport();
  assert.equal(r.passed, false); assert.equal(r.releaseReady, false);
  for (const key of ['nativeGuiTested', 'nativeConsentTested', 'hostedOperationsTested', 'clientMigrationTested', 'processCleanupTested', 'actualAiTested', 'unitySdkTested']) assert.equal(r[key], false);
  assert.ok(r.blockers.some(b => b.id === 'client-review-admission'));
  assert.ok(r.blockers.some(b => b.id === 'product-review-admission'));
});
test('real filesystem failure receipt preserves the original hash failure and cannot overwrite old evidence', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unix-hosted-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'source.zip'); fs.writeFileSync(archive, 'bad');
  const output = path.join(root, 'output'); fs.mkdirSync(output);
  const r = h.inspectCandidate(root, output, binding(), archive, '-', () => { throw Error('Must not run a tool after ZIP refusal'); });
  assert.equal(r.status, 'failed'); assert.match(r.error, /Downloaded ZIP differs/);
  assert.equal(r.passed, false); assert.equal(r.releaseReady, false);
  const first = fs.readFileSync(path.join(output, 'report.json'));
  assert.throws(() => h.inspectCandidate(root, output, binding(), archive, '-'));
  assert.deepEqual(fs.readFileSync(path.join(output, 'report.json')), first);
});
function packageFixture(root) {
  const candidate = path.join(root, 'candidate'); fs.mkdirSync(candidate);
  const output = path.join(root, 'evidence'); fs.mkdirSync(output);
  const archive = path.join(root, 'source.zip'); fs.writeFileSync(archive, 'zip');
  const files = { 'mcp/backend': sha('mcp'), 'setup/backend': sha('setup'), 'mcp/server/runtime/node': sha('node') };
  const payload = Buffer.from('mock archive; native decoder invocation is mocked, not a TAR acceptance claim');
  const descriptor = { schemaVersion: 1, platform: 'linux', arch: 'x86_64', modules: {
    mcp: { executable: 'mcp/backend', version: '1.0.0', files: {'mcp/backend':files['mcp/backend'],'mcp/server/runtime/node':files['mcp/server/runtime/node']} },
    setup: { executable: 'setup/backend', version: '1.0.0', files: {'setup/backend':files['setup/backend']} },
  }, payloadArchive: { schemaVersion: 1, file: 'modules.tar.gz', sha256: sha(payload), size: payload.length, unpackedSize: 3,
    files: Object.fromEntries(Object.keys(files).map(name => [name,{size:1,mode:0o755}])) } };
  const descriptorBytes = Buffer.from(JSON.stringify(descriptor));
  const hub = Buffer.concat([Buffer.from('mocked Hub'), descriptorBytes]);
  fs.mkdirSync(path.join(candidate, 'native-packages'));
  const container = path.join(candidate, 'native-packages/fixture.deb'); fs.writeFileSync(container, 'mock DEB');
  const integrity = { schemaVersion: 1, platform: 'linux', arch: 'x86_64', mcpMode: 'read-only',
    writableGuiAccepted: false, releaseReady: false, integrityPassed: true,
    packages: [{format:'deb',path:'native-packages/fixture.deb',sha256:sha('mock DEB'),hubSha256:sha(hub),files}] };
  fs.writeFileSync(path.join(candidate, 'builtin-manifest.json'), descriptorBytes);
  fs.writeFileSync(path.join(candidate, 'unix-package-integrity.json'), JSON.stringify(integrity));
  fs.writeFileSync(path.join(candidate, 'experimental-unix.json'), JSON.stringify({...integrity,packages:['deb']}));
  const decoder = path.join(root, 'mock-decoder');
  const execute = (command, args) => {
    if (command === 'dpkg-deb') {
      assert.equal(args[0], '--extract');
      const extraction = args[2];
      fs.mkdirSync(path.join(extraction, 'usr/bin'),{recursive:true});
      fs.mkdirSync(path.join(extraction, 'usr/lib/Creator Hub'),{recursive:true});
      fs.writeFileSync(path.join(extraction, 'usr/bin/creator-hub'), hub);
      fs.writeFileSync(path.join(extraction, 'usr/lib/Creator Hub/modules.tar.gz'), payload);
      return '';
    }
    assert.equal(command, decoder); assert.equal(args[0], 'verify');
    return JSON.stringify({files});
  };
  return { candidate, output, archive, decoder, execute, container, integrity };
}
test('mocked package/container/embedded descriptor/raw-map checks still produce a nonzero-intent blocked receipt', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'unix-hosted-package-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const f=packageFixture(root);
  const r=h.inspectCandidate(f.candidate,f.output,binding(),f.archive,f.decoder,f.execute);
  assert.equal(r.status,'blocked'); assert.equal(r.packageIntegrityTested,true);
  assert.equal(r.passed,false); assert.equal(r.releaseReady,false); assert.equal(r.nativeConsentTested,false);
});
for (const [name, mutate] of Object.entries({
  container: f=>fs.appendFileSync(f.container,'tamper'),
  producerFailure: f=>{f.integrity.integrityPassed=false;},
  falseReadiness: f=>{f.integrity.releaseReady=true;},
  pathEscape: f=>{f.integrity.packages[0].path='../outside.deb';},
  hub: f=>{f.integrity.packages[0].hubSha256=sha('foreign hub');},
})) test(`package prerequisite fails closed on ${name}`, t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'unix-hosted-tamper-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const f=packageFixture(root); mutate(f);
  fs.writeFileSync(path.join(f.candidate,'unix-package-integrity.json'),JSON.stringify(f.integrity));
  const r=h.inspectCandidate(f.candidate,f.output,binding(),f.archive,f.decoder,f.execute);
  assert.equal(r.status,'failed'); assert.equal(r.passed,false); assert.equal(r.releaseReady,false);
});
test('extraction/owned-cleanup AggregateError preserves both original failures', t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'unix-hosted-cleanup-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const f=packageFixture(root);
  const r=h.inspectCandidate(f.candidate,f.output,binding(),f.archive,f.decoder,()=>{
    throw new AggregateError([Error('original attach/copy refusal'),Error('owned detach nonzero')],'owned cleanup failed');
  });
  assert.equal(r.status,'failed'); assert.equal(r.releaseReady,false);
  assert.deepEqual(r.originalFailures,['original attach/copy refusal','owned detach nonzero']);
});
test('CLI non-disposable refusal cannot create an evidence directory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unix-hosted-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, 'absent');
  const result = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, 'native-unix-hosted-acceptance.cjs'), root, out, 'absent', 'absent', '-'],
    { env: { ...process.env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /Disposable GitHub runner required/);
  assert.equal(fs.existsSync(out), false);
});
test('workflow is read-only, finite PR scope, always uploads only the failed/blocked receipt', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/unix-hosted-acceptance.yml'), 'utf8');
  assert.match(workflow, /actions: read/); assert.match(workflow, /contents: read/);
  assert.match(workflow, /if: always\(\)/); assert.doesNotMatch(workflow, /continue-on-error|secrets\.|--experimental-unix-hosting|--sign|--no-sandbox|flatpak-spawn/);
  assert.match(workflow, /node --test scripts\/native-unix-hosted-acceptance.test.cjs/);
  assert.match(workflow, /report.json/);
});
