'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const p = require('./private-linux-portable-fixture-017.cjs');
const neutral = require('./linux-016-portable-package.cjs');
const m = require('./private-linux-update-fixture-017-metadata.cjs');
const { data, elf } = require('./fixtures/private-linux-update-fixture-017.cjs');

// These pins are synthetic schema inputs, not real producer identities or usable native evidence.
const dummy = () => ({ size: 1, sha256: 'a'.repeat(64) });
function sample() {
  return { schemaVersion: 1, profile: p.PROFILE, assembly017: { runId: 101, runAttempt: 1, jobId: 102, workflowId: 103,
    artifactId: 104, zip: dummy(), files: Object.fromEntries(Object.entries(p.ROLES).map(([role, name]) => [role, { member: `owned/${name}`, ...dummy() }])) },
  signed016: { planSha256: 'b'.repeat(64), files: Object.fromEntries(p.LEGACY_NAMES.map(name => [name, dummy()])) },
  signed017: { planSha256: 'c'.repeat(64) }, tools: { verifier: dummy(), decoder: dummy() } };
}
function environment() {
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: p.BRANCH, GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${p.WORKFLOW}@${p.BRANCH}`,
    GITHUB_SHA: 'd'.repeat(40), GITHUB_RUN_ID: '201', GITHUB_RUN_ATTEMPT: '1', CREATOR_PRIVATE_PORTABLE_017: '1' };
}
function apiProof(profile) {
  const a = profile.assembly017, repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' };
  return { run: { id: a.runId, run_attempt: a.runAttempt, head_sha: p.SOURCE.sourceCommit, head_branch: 'validation/linux-private-update-fixture-017',
    path: '.github/workflows/private-linux-update-fixture-017.yml', workflow_id: a.workflowId, event: 'workflow_dispatch',
    status: 'completed', conclusion: 'success', repository: repo, head_repository: repo },
  job: { id: a.jobId, run_id: a.runId, run_attempt: a.runAttempt, head_sha: p.SOURCE.sourceCommit, name: 'assemble',
    status: 'completed', conclusion: 'success', labels: ['ubuntu-22.04'], started_at: '2026-10-20T10:00:00Z', completed_at: '2026-10-20T11:00:00Z' },
  workflow: { id: a.workflowId, path: '.github/workflows/private-linux-update-fixture-017.yml' },
  artifact: { id: a.artifactId, name: `private-linux-update-fixture-017-${a.runId}-${a.runAttempt}`, expired: false,
    size_in_bytes: a.zip.size, digest: `sha256:${a.zip.sha256}`, created_at: '2026-10-20T10:59:00Z',
    workflow_run: { id: a.runId, head_sha: p.SOURCE.sourceCommit, head_branch: 'validation/linux-private-update-fixture-017', repository_id: 1364807512, head_repository_id: 1364807512 } },
  commit: { sha: p.SOURCE.sourceCommit, tree: { sha: p.SOURCE.sourceTree } } };
}
function owned(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'private017-portable-unit-')));
  t.after(() => { assert.equal(fs.realpathSync(root), root); assert.ok(path.basename(root).startsWith('private017-portable-unit-')); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
test('module import and fixed schema admission do not load npm signing/version dependencies or execute tools', () => {
  const program = `const Module=require('module'),original=Module._load;Module._load=function(name,...args){if(name==='semver')throw Error('No npm dependency before pure admission');return original.call(this,name,...args);};require(${JSON.stringify(require.resolve('./private-linux-portable-fixture-017.cjs'))});`;
  const result = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
  assert.equal(p.validateProfile(sample()).profile, p.PROFILE);
});
test('every local validator dependency is covered by the finite clean-source guard and neutral APIs are exported', () => {
  const dependencies = new Set();
  function visit(name) {
    if (dependencies.has(name)) return;
    dependencies.add(name);
    const source = fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
    for (const match of source.matchAll(/require\(['"](\.\/[^'"]+\.cjs)['"]\)/g)) {
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(name), match[1])));
    }
  }
  visit('scripts/private-linux-portable-fixture-017.cjs');
  for (const name of dependencies) assert.ok(p.SCOPE_PATHS.includes(name), `Unprotected local validator: ${name}`);
  const body = fs.readFileSync(require.resolve('./private-linux-portable-fixture-017.cjs'), 'utf8');
  for (const name of new Set([...body.matchAll(/neutral\.(\w+)/g)].map(match => match[1]))) {
    assert.ok(Object.hasOwn(neutral, name), `Missing shared neutral API: ${name}`);
  }
});
test('source guard checks tracked and untracked finite inputs before and after packaging without native execution', () => {
  const calls = [], run = (command, args) => {
    assert.equal(command, 'git'); calls.push(args);
    if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? environment().GITHUB_SHA : p.SOURCE.sourceTree;
    return '';
  };
  p.sourceCheck(environment(), run); p.sourceCheck(environment(), run);
  assert.equal(calls.filter(args => args[0] === 'status').length, 2);
  assert.ok(calls.some(args => args[0] === 'status' && args.includes('--untracked-files=all') && args.includes('scripts/flatpak-package.cjs')));
  for (const status of [' M scripts/flatpak-package.cjs', '?? scripts/private-linux-update-fixture-017-provenance.cjs']) {
    assert.throws(() => p.sourceCheck(environment(), (command, args) => args[0] === 'status' ? status : run(command, args)), /Portable producer source changed/);
  }
  assert.throws(() => p.sourceCheck(environment(), (command, args) => {
    if (args[0] === 'diff' && args.includes('scripts/flatpak-package.cjs')) throw Error('Tracked validator changed');
    return run(command, args);
  }), /Tracked validator changed/);
});
test('profile requires all actual signed016 roles, all actual017 assembly roles, independent pins and fixed role basenames', () => {
  for (const mutate of [x => { x.profile = 'production-portable-016'; }, x => { delete x.signed016; }, x => { delete x.assembly017.files.api; },
    x => { x.assembly017.zip.size = 0; }, x => { x.assembly017.runId = true; }, x => { x.signed017.planSha256 = 'bad'; },
    x => { x.tools.decoder = { path: '/untrusted/tool', ...dummy() }; }, x => { x.releaseReady = true; },
    x => { x.assembly017.files.root.member = 'owned/renamed-Root16'; }, x => { x.assembly017.files.root.member = '../creator-hub'; },
    x => { delete x.signed016.files['creator-hub-linux-x86_64-0.1.16.portable-manifest.json.minisig']; },
    x => { x.assembly017.files.manifest.size = 65537; }]) {
    const value = sample(); mutate(value); assert.throws(() => p.validateProfile(value));
  }
});
test('manual017 admission rejects pushes, other platforms/profiles, GUI hosts and trust/compiler/signing overrides', () => {
  p.admission(environment(), 'linux', 'x64');
  for (const [name, value] of Object.entries({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', RUNNER_ARCH: 'ARM64',
    CREATOR_PRIVATE_PORTABLE_017: '0', RUNNER_ENVIRONMENT: 'self-hosted', DISPLAY: ':0', FLATPAK_ID: 'app',
    GITHUB_WORKFLOW_REF: 'other-workflow', CREATOR_LINUX_PRIVATE_UPDATE_FIXTURE_017: '1',
    CREATOR_LINUX_PRODUCTION_MIGRATION_016: '1', NODE_OPTIONS: '', LD_PRELOAD: '', TAURI_SIGNING_PRIVATE_KEY: '',
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS: '', HTTPS_PROXY: '' })) {
    assert.throws(() => p.admission({ ...environment(), [name]: value }, 'linux', 'x64'));
  }
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'x64'], ['linux', 'arm64']]) assert.throws(() => p.admission(environment(), platform, arch));
});
test('017 API admission requires successful actual017 source/tree and exact manual workflow/job/artifact provenance', async () => {
  const profile = sample(), good = apiProof(profile); p.assemblyAPI(profile, good);
  for (const mutate of [x => { x.run.conclusion = 'failure'; }, x => { x.run.status = 'in_progress'; }, x => { x.run.head_sha = 'a'.repeat(40); },
    x => { x.commit.tree.sha = 'a'.repeat(40); }, x => { x.job.head_sha = 'a'.repeat(40); }, x => { x.job.run_attempt++; },
    x => { x.run.path = '.github/workflows/unix-managed-assembly.yml'; }, x => { x.artifact.workflow_run.repository_id++; },
    x => { x.artifact.digest = `sha256:${'b'.repeat(64)}`; }, x => { x.artifact.created_at = '2026-10-20T11:00:01Z'; },
    x => { x.artifact.expired = true; }, x => { x.job.name = 'package'; }]) {
    const changed = structuredClone(good); mutate(changed); assert.throws(() => p.assemblyAPI(profile, changed));
  }
  const routes = new Map([[`actions/runs/${profile.assembly017.runId}`, good.run], [`actions/jobs/${profile.assembly017.jobId}`, good.job],
    [`actions/workflows/${profile.assembly017.workflowId}`, good.workflow], [`actions/artifacts/${profile.assembly017.artifactId}`, good.artifact],
    [`git/commits/${p.SOURCE.sourceCommit}`, good.commit]]);
  assert.deepEqual(await p.collect(profile, async route => { assert.ok(routes.has(route)); return routes.get(route); }), good);
});
function selectorFixture(t) {
  const root = owned(t), files = { 'native/linux-portable-deployment/Cargo.toml': Buffer.from('synthetic manifest'),
    'native/linux-portable-deployment/Cargo.lock': Buffer.from('synthetic lock'),
    'native/linux-portable-deployment/src/bin/creator-hub-portable-selector.rs': Buffer.from('synthetic selector source'),
    'src-tauri/src/catalog-key.pub': Buffer.from('synthetic public key') };
  const blobs = new Map(), rows = [];
  for (const [name, bytes] of Object.entries(files)) {
    const hash = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    blobs.set(hash, bytes); rows.push(`100644 blob ${hash}\t${name}`);
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  const proof = { sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), sources: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, neutral.record(bytes)])),
    publicKeySource: neutral.record(files['src-tauri/src/catalog-key.pub']), executable: neutral.record(elf('existing-selector')) };
  const calls = [], run = (command, args) => {
    calls.push(args); assert.equal(command, 'git');
    if (args[0] === 'ls-tree') { assert.ok([proof.sourceCommit, p.SOURCE.sourceCommit].includes(args[3])); return rows.join('\0') + '\0'; }
    assert.deepEqual(args.slice(0, 2), ['cat-file', 'blob']); assert.ok(blobs.has(args[2])); return blobs.get(args[2]);
  };
  return { root, proof, rows, blobs, run, calls };
}
test('selector reuse proves complete original and017 Git blob sets and unchanged checkout/key without compiling or relabelling provenance', t => {
  const f = selectorFixture(t), result = p.selectorSources(f.root, f.proof, f.run);
  assert.equal(result.originalSourceCommit, f.proof.sourceCommit); assert.deepEqual(result.targetSource, p.SOURCE);
  assert.equal(result.reusedWithoutCompilation, true); assert.equal(result.signaturesRequired, true);
  assert.deepEqual(result.executable, f.proof.executable); assert.equal(f.calls.filter(args => args[0] === 'ls-tree').length, 2);
  assert.ok(f.calls.every(args => ['ls-tree', 'cat-file'].includes(args[0])));
});
test('selector reuse refuses omitted/changed source or key, nonregular tree entries and invalid blob evidence', t => {
  for (const fault of ['omitted', 'key', 'mode', 'blob', 'new-source']) {
    const f = selectorFixture(t);
    if (fault === 'omitted') delete f.proof.sources['native/linux-portable-deployment/Cargo.lock'];
    if (fault === 'key') fs.appendFileSync(path.join(f.root, 'src-tauri/src/catalog-key.pub'), 'changed');
    if (fault === 'mode') f.rows[0] = f.rows[0].replace('100644', '120000');
    if (fault === 'blob') f.blobs.set(f.rows[0].split(' ')[2].split('\t')[0], Buffer.from('changed'));
    if (fault === 'new-source') {
      const bytes = Buffer.from('new tracked source'), name = 'native/linux-portable-deployment/src/new.rs';
      const hash = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      f.blobs.set(hash, bytes); f.rows.push(`100644 blob ${hash}\t${name}`);
      fs.writeFileSync(path.join(f.root, name), bytes);
    }
    assert.throws(() => p.selectorSources(f.root, f.proof, f.run));
  }
});
function assemblyFixture() {
  const f = data(); f.plan.rootSource = structuredClone(p.SOURCE); f.rootApi.commit = { sha: p.SOURCE.sourceCommit, tree: { sha: p.SOURCE.sourceTree } };
  const runtime = f.files['runtime017.json'], sig = f.files['runtime017.minisig'];
  f.files['derivation017.json'] = m.derivationBytes(f.plan, f.handoff, f.prepared, f.originalRecords, runtime, sig);
  const derived = m.validateDerivation(f.files['derivation017.json'], f.plan, f.handoff, f.prepared, f.originalRecords, runtime, sig);
  const archive = require('./module-archive.cjs'), hashes = archive.rawFiles(derived), packed = Buffer.from('Synthetic module archive; never decoded by this schema-only fixture');
  const manifest = { ...structuredClone(derived), payloadArchive: { schemaVersion: 1, file: 'modules.tar.gz', ...neutral.record(packed),
    unpackedSize: Object.keys(hashes).length, files: Object.fromEntries(Object.keys(hashes).map(name => [name, { size: 1, mode: archive.modeFor(derived, name) }])) } };
  const descriptor = Buffer.from(JSON.stringify(manifest, null, 2));
  const root = Buffer.concat([elf('synthetic Root17'), descriptor, Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK'),
    Buffer.from(require('./build-unified.cjs').PORTABLE_ROOT_WITNESSES.join('\n'))]);
  const debRoot = Buffer.from(root), marker = root.indexOf('__TAURI_BUNDLE_TYPE_VAR_UNK'); debRoot.write('DEB', marker + '__TAURI_BUNDLE_TYPE_VAR_UNK'.length - 3, 'ascii');
  const signed = { plan: f.plan, handoff: f.handoff, manifest: derived, records: Object.fromEntries(Object.entries(f.files).map(([name, bytes]) => [name, neutral.record(bytes)])) };
  const bodies = { root, archive: packed, manifest: descriptor, deb: Buffer.from('Synthetic DEB, never installed or inspected here'),
    api: Buffer.from(JSON.stringify({ baseline: f.baselineApi, root: f.rootApi })) };
  const receipt = { schemaVersion: 1, profile: 'private-update-fixture-017', hubVersion: p.VERSION, rootSource: p.SOURCE,
    compiledFeatures: [...p.FEATURES], target: p.TARGET, derivation: structuredClone(signed.records['derivation017.json']),
    original016: { source: signed.handoff.source, files: signed.plan.original016 }, baseline016: signed.plan.baseline016,
    rawHub: neutral.record(root), packagedHub: neutral.record(debRoot), archive: neutral.record(packed), manifest: neutral.record(descriptor),
    deb: neutral.record(bodies.deb), packageReport: { scope: 'private017-deb-delta-only', helperPolicyServicePreserved: true, original016Preserved: true,
      ...Object.fromEntries(['nativeGuiAccepted', 'migrationAccepted', 'signedUpdateAccepted', 'restartAccepted', 'releaseReady'].map(name => [name, false])) },
    ...require('./private-linux-update-fixture-017.cjs').FLAGS };
  bodies.receipt = Buffer.from(JSON.stringify(receipt));
  bodies.integrity = Buffer.from(JSON.stringify({ schemaVersion: 1, platform: 'linux', arch: 'x86_64', integrityPassed: true, experimental: true,
    mcpMode: 'writable', writableGuiAccepted: false, releaseReady: false, packages: [{ format: 'deb', path: `native-packages/${p.ROLES.deb}`,
      sha256: receipt.deb.sha256, hubSha256: receipt.packagedHub.sha256, files: archive.rawFiles(manifest) }] }));
  bodies.expected = Buffer.from(JSON.stringify({ candidate: { deb: receipt.deb, hub: receipt.packagedHub, archive: receipt.archive },
    baseline: Object.fromEntries(['deb', 'hub', 'helper', 'policy', 'service'].map(name => [name, signed.plan.baseline016.pins[name]])) }));
  const profile = sample();
  const repin = () => { for (const [role, bytes] of Object.entries(bodies)) Object.assign(profile.assembly017.files[role], neutral.record(bytes)); };
  repin(); return { bodies, signed, profile, receipt, repin };
}
test('actual017 assembly schema binds exact source/tuple/derivation/archive/DEB transform without making native acceptance claims', () => {
  const f = assemblyFixture(), checked = p.validateAssembly(f.profile, f.bodies, f.signed);
  assert.equal(checked.receipt.hubVersion, '0.1.17'); assert.equal(checked.receipt.releaseReady, false);
  assert.deepEqual(checked.receipt.rootSource, p.SOURCE); assert.deepEqual(checked.receipt.compiledFeatures, [...p.FEATURES]);
  for (const mutate of [x => { x.receipt.hubVersion = '0.1.16'; }, x => { x.receipt.rootSource = { sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40) }; },
    x => { x.receipt.compiledFeatures = ['integrated-features']; }, x => { x.receipt.releaseReady = true; },
    x => { x.receipt.derivation.sha256 = 'a'.repeat(64); }, x => { x.receipt.packageReport.helperPolicyServicePreserved = false; }]) {
    const other = assemblyFixture(); mutate(other); other.bodies.receipt = Buffer.from(JSON.stringify(other.receipt)); other.repin();
    assert.throws(() => p.validateAssembly(other.profile, other.bodies, other.signed));
  }
  const changed = assemblyFixture(); changed.bodies.root[40] ^= 1;
  assert.throws(() => p.validateAssembly(changed.profile, changed.bodies, changed.signed));
});
test('bundle arguments are fixed bundle-only/no-sign; host profile permits only actual raw017 -> APP bytes', () => {
  assert.deepEqual(p.bundleArgs('/source', '/owned/config'), [path.join('/source', 'node_modules/@tauri-apps/cli/tauri.js'), 'bundle', '--ci', '--no-sign',
    '--bundles', 'appimage', '--target', p.TARGET, '--features', p.FEATURES.join(','), '--config', '/owned/config']);
  const raw = Buffer.concat([elf('Root17'), Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK')]), app = Buffer.from(raw); app.write('APP', app.length - 3, 'ascii');
  const value = JSON.parse(p.hostProfile(raw, app)); assert.equal(value.version, '0.1.17'); assert.equal(value.executableSha256, neutral.record(app).sha256);
  app[40] ^= 1; assert.throws(() => p.hostProfile(raw, app));
  assert.equal(p.overlay('/owned/modules.tar.gz').version, '0.1.17');
  assert.deepEqual(p.overlay('/owned/modules.tar.gz').bundle.resources, { '/owned/modules.tar.gz': 'modules.tar.gz' });
  assert.equal(p.overlay('/owned/modules.tar.gz').build.beforeBundleCommand, null);
});
test('explicit017 manifest and false gates do not mutate or select the production016 policy', () => {
  const bytes = elf('synthetic inventory entry'), entries = { AppRun: { kind: 'file', ...neutral.record(bytes), mode: 0o755 },
    usr: { kind: 'directory', mode: 0o755 }, 'usr/bin': { kind: 'directory', mode: 0o755 }, 'usr/libexec': { kind: 'directory', mode: 0o755 },
    'usr/bin/creator-hub': { kind: 'file', ...neutral.record(bytes), mode: 0o755 }, [p.SELECTOR]: { kind: 'file', ...neutral.record(bytes), mode: 0o755 },
    [p.HOST]: { kind: 'file', ...neutral.record(Buffer.from('synthetic host profile')), mode: 0o644 } };
  const inv = { entries, links: {}, unpackedSize: Object.values(entries).reduce((sum, value) => sum + (value.size || 0), 0) };
  const result = p.manifest(inv, { ...dummy(), unpackedSize: inv.unpackedSize });
  assert.equal(result.version, '0.1.17'); assert.equal(result.sourceCommit, p.SOURCE.sourceCommit); assert.equal(result.sourceTree, p.SOURCE.sourceTree);
  assert.equal(neutral.production016().VERSION, '0.1.16'); assert.equal(neutral.production016().PROFILE, 'production-portable-016');
  for (const [name, value] of Object.entries(p.flags())) assert.equal(value, name === 'acceptanceOnly');
  assert.throws(() => neutral.production016({ version: '0.1.17' }), /no caller policy/);
});
test('producer refuses non-CI callers before reading artifacts or invoking tools and has no compile/sign/install route', async () => {
  await assert.rejects(p.produce({ root: '/never/read', input: '/never/read', output: '/never/write', profileSha256: 'a'.repeat(64) },
    { env: {}, execute() { assert.fail('No native execution before private017 admission'); } }));
  const body = p.produce.toString();
  assert.doesNotMatch(body, /signingKey\(|signDetached\(|buildSelector\(|\['build'|\['install'|\.activate\(|--appimage-extract/);
  const phases = ['await collect(p, api)', 'c16.validateOutput(', 'm17.verifySignatures(', "require('./sign-private-portable-016.cjs').fresh(",
    'selectorSources(', 'validateAssembly(', 'archive.verify(', 'imageSnapshot(binary)', 'bundleArgs(root,',
    "verifyLinuxHub(bodies.root, packaged, 'appimage')", 'neutral.flatten(', 'neutral.dependencies(', 'neutral.closureAbiRequirements(', 'neutral.packTar('];
  let before = -1;
  for (const phase of phases) { const at = body.indexOf(phase, before + 1); assert.ok(at > before, `Missing or reordered portable017 gate: ${phase}`); before = at; }
});

function portableWorkflow() {
  const { yaml } = require('../node_modules/playwright-core/lib/utilsBundle.js');
  const source = fs.readFileSync(path.join(__dirname, '..', p.WORKFLOW), 'utf8');
  const parsed = yaml.parseDocument(source, { uniqueKeys: true }); assert.deepEqual(parsed.errors, []);
  return { source, workflow: parsed.toJSON() };
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
test('017 portable workflow registers only its branch, never runs native jobs on pushes, and has read-only permissions', () => {
  const { workflow, source } = portableWorkflow();
  assert.deepEqual(workflow.on.push.branches, [p.BRANCH.slice('refs/heads/'.length)]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ['producer_profile', 'producer_profile_sha256', 'signed_inputs']);
  for (const input of Object.values(workflow.on.workflow_dispatch.inputs)) {
    assert.equal(input.required, true); assert.equal(input.type, 'string'); assert.equal(Object.hasOwn(input, 'default'), false);
  }
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' }); assert.deepEqual(Object.keys(workflow.jobs), ['package']);
  const job = workflow.jobs.package, guard = new Function('github', `return (${job.if});`);
  const good = { repository: 'BOBWORKS-XR/CREATOR-HUB', repository_id: '1364807512', event_name: 'workflow_dispatch', ref: p.BRANCH };
  assert.equal(guard(good), true);
  for (const [key, value] of Object.entries({ repository: 'other/fork', repository_id: '1', event_name: 'push', ref: 'refs/heads/main' })) assert.equal(guard({ ...good, [key]: value }), false);
  assert.equal(job['runs-on'], 'ubuntu-22.04'); assert.deepEqual(job.env, { CREATOR_PRIVATE_PORTABLE_017: '1' });
  assert.doesNotMatch(source, /contents: write|actions: write|secrets\.|signingKey\(|signDetached\(|continue-on-error|gh release|publish-hub/);
});
test('017 workflow orders pinned Node, hook-free imports, source/API/data gates, then only the two controlled tool builds', () => {
  const { workflow, source } = portableWorkflow(), steps = workflow.jobs.package.steps;
  const at = text => steps.findIndex(step => step.run?.includes(text) || step.with?.script?.includes(text));
  const node = steps.findIndex(step => step.uses === 'actions/setup-node@v6');
  assert.equal(steps[node].with['node-version'], '24.17.0');
  assert.deepEqual(steps.find(step => step.uses === 'actions/checkout@v6').with, { 'fetch-depth': 0, 'persist-credentials': false });
  const setup = at('npm ci --ignore-scripts'), pure = at('node --test'), api = at('async function bind('), data = at('lane.validateAssembly('), apt = at('apt-get install'), tools = at('const verifierTarget='), bundle = at('lane.produce(');
  assert.ok(node >= 0 && setup > node && pure > setup && api > pure && data > api && apt > data && tools > apt && bundle > tools);
  assert.equal(steps.find(step => step.uses?.startsWith('dtolnay/rust-toolchain@')).uses, 'dtolnay/rust-toolchain@1.99.0');
  for (const step of steps.slice(0, apt)) assert.doesNotMatch(step.run || '', /apt-get|cargo (?:build|fetch|test|install)|npm run|npm ci\s*$/m);
  const build = steps[tools].run;
  assert.match(build, /'--example','verify-package-input'/); assert.match(build, /'--bin','creator-hub-module-archive'/);
  assert.doesNotMatch(build, /--features|buildSelector|creator-works-mcp-launcher|creator-project-setup|signingKey|signDetached/);
  assert.match(steps[api].with.script, /'merge-base','--is-ancestor',lane\.SOURCE\.sourceCommit,'HEAD'/);
  assert.match(steps[api].with.script, /Only reviewed sidecar files may differ from actual017 source/);
  assert.match(steps[data].with.script, /selectorSources\(/); assert.match(steps[data].with.script, /\.fresh\(/);
  assert.doesNotMatch(source, /npm ci\n|--appimage-extract|\$\{\{ inputs\.[^}]+\}\}.*(?:cargo|sudo|node scripts)/);
});
async function workflowDownload(t, fault = '') {
  const temp = owned(t), profile = sample(); delete profile.tools;
  const bytes = Buffer.from('Synthetic Actions ZIP; this download-only fixture never decodes or executes it.');
  profile.assembly017.zip = neutral.record(bytes);
  const carriers = { schemaVersion: 1, signed016: { runId: 301, runAttempt: 2, jobId: 302, workflowId: 303, artifactId: 304,
    sourceCommit: '1'.repeat(40), sourceTree: '2'.repeat(40), zip: neutral.record(bytes), members: Object.fromEntries(p.LEGACY_NAMES.map(name => [name, `signed/${name}`])) },
  signed017: { jobId: 401, artifactId: 402, zip: neutral.record(bytes), files: Object.fromEntries(['private017-signed.zip', 'approved-plan.json', 'signed-input.json'].map(name => [name, { member: `carrier/${name}`, ...dummy() }])) } };
  const good17 = apiProof(profile), a = profile.assembly017, c = carriers.signed016, d = carriers.signed017;
  const old = structuredClone(good17);
  Object.assign(old.run, { id: c.runId, run_attempt: c.runAttempt, head_sha: c.sourceCommit, head_branch: 'validation/unit-signed-carrier', workflow_id: c.workflowId, path: '.github/workflows/signed-update-lab.yml' });
  Object.assign(old.job, { id: c.jobId, run_id: c.runId, run_attempt: c.runAttempt, head_sha: c.sourceCommit, name: 'data-carrier' });
  Object.assign(old.workflow, { id: c.workflowId, path: old.run.path });
  Object.assign(old.artifact, { id: c.artifactId, name: 'unit-signed-carrier', workflow_run: { ...old.artifact.workflow_run, id: c.runId, head_sha: c.sourceCommit, head_branch: old.run.head_branch } });
  old.commit = { sha: c.sourceCommit, tree: { sha: c.sourceTree } };
  const stage = structuredClone(good17); stage.job.id = d.jobId; stage.job.name = 'stage-input'; stage.artifact.id = d.artifactId;
  stage.artifact.name = `private017-signed-input-${a.runId}-${a.runAttempt}`;
  const routes = new Map();
  for (const proof of [good17, old, stage]) for (const [route, value] of [[`actions/runs/${proof.run.id}`, proof.run], [`actions/jobs/${proof.job.id}`, proof.job],
    [`actions/workflows/${proof.workflow.id}`, proof.workflow], [`actions/artifacts/${proof.artifact.id}`, proof.artifact], [`git/commits/${proof.commit.sha}`, proof.commit]]) routes.set(route, value);
  if (fault === 'tools') profile.tools = { verifier: dummy(), decoder: dummy() };
  if (fault === 'extra') profile.allowUnverified = true;
  if (fault === 'missing-member') delete profile.assembly017.files.manifest;
  if (fault === 'carrier-path') carriers.signed016.members['plan.json'] = '../plan.json';
  if (fault === 'failed-run') routes.get(`actions/runs/${a.runId}`).conclusion = 'failure';
  if (fault === 'wrong-tree') routes.get(`git/commits/${p.SOURCE.sourceCommit}`).tree.sha = '3'.repeat(40);
  if (fault === 'wrong-stage-job') stage.job.name = 'assemble';
  if (fault === 'artifact-digest') old.artifact.digest = `sha256:${'f'.repeat(64)}`;
  if (fault === 'outside-job') old.artifact.created_at = '2026-10-20T11:00:01Z';
  const text = JSON.stringify(profile, null, 2), env = { ...environment(), RUNNER_TEMP: temp, GITHUB_WORKSPACE: temp,
    PRODUCER_PROFILE: text, PRODUCER_PROFILE_SHA256: neutral.record(Buffer.from(text)).sha256, SIGNED_INPUTS: JSON.stringify(carriers, null, 2) };
  if (fault === 'hash') env.PRODUCER_PROFILE_SHA256 = 'f'.repeat(64);
  if (fault === 'push') env.GITHUB_EVENT_NAME = 'push';
  if (fault === 'duplicate') env.SIGNED_INPUTS = env.SIGNED_INPUTS.replace('{', '{"schemaVersion":1,');
  const calls = [], downloads = [], gitCalls = [];
  const execute = (program, args) => {
    assert.equal(program, 'git'); gitCalls.push(args);
    if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? env.GITHUB_SHA : p.SOURCE.sourceTree;
    if (args[0] === 'status') return fault === 'dirty' ? '?? scripts/flatpak-package.cjs' : fault === 'stager-dirty' && args.includes('scripts/stage-private-linux-update-fixture-017.py') ? ' M scripts/stage-private-linux-update-fixture-017.py' : '';
    if (args[0] === 'merge-base' && fault === 'not017-base') throw Error('Not based on actual017 source');
    if (args[0] === 'diff' && args.includes('--name-only')) return fault === 'product-overlay' ? 'src-tauri/src/main.rs\0' : `${p.WORKFLOW}\0`;
    return '';
  };
  const github = { request: async route => { const name = route.replace('GET /repos/BOBWORKS-XR/CREATOR-HUB/', ''); calls.push(name); assert.ok(routes.has(name)); return { data: routes.get(name) }; },
    rest: { actions: { downloadArtifact: async args => { downloads.push(args.artifact_id); assert.ok([a.artifactId, c.artifactId, d.artifactId].includes(args.artifact_id)); return { data: fault === 'bytes' ? Buffer.from('changed') : bytes }; } } } };
  const local = name => name === 'node:child_process' ? { execFileSync: execute } : name === './scripts/private-linux-portable-fixture-017.cjs'
    ? { ...p, admission: value => p.admission(value, 'linux', 'x64') } : name.startsWith('./scripts/') ? require(path.join(__dirname, '..', name)) : require(name);
  const body = portableWorkflow().workflow.jobs.package.steps.find(step => step.id === 'download').with.script;
  return { temp, calls, downloads, gitCalls, env, profile, execute: () => new AsyncFunction('require', 'process', 'github', 'context', body)(local, { env }, github, { sha: env.GITHUB_SHA }) };
}
test('workflow download gate binds actual017 and both signed carriers using read-only APIs and only writes pinned data', async t => {
  const f = await workflowDownload(t); await f.execute();
  assert.deepEqual(f.downloads, [104, 304, 402]); assert.ok(f.gitCalls.some(args => args[0] === 'merge-base'));
  const stage = path.join(f.temp, 'private017-portable-stage');
  assert.deepEqual(fs.readdirSync(stage).sort(), ['download-proof.json', 'input', 'request.json', 'signed016-carrier.zip', 'signed017-carrier.zip']);
  assert.deepEqual(fs.readdirSync(path.join(stage, 'input')), ['assembly017.zip']);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(stage, 'request.json'))).profile, 'tools'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stage, 'download-proof.json'))).releaseReady, false);
  await assert.rejects(f.execute());
});
test('workflow rejects unknown tools/policy, bad pins/source/sidecar delta and failed API identities before downloads', async t => {
  for (const fault of ['tools', 'extra', 'missing-member', 'carrier-path', 'hash', 'push', 'duplicate', 'dirty', 'stager-dirty', 'not017-base', 'product-overlay',
    'failed-run', 'wrong-tree', 'wrong-stage-job', 'artifact-digest', 'outside-job']) {
    const f = await workflowDownload(t, fault); await assert.rejects(f.execute(), undefined, fault);
    assert.deepEqual(f.downloads, [], fault); assert.deepEqual(fs.readdirSync(f.temp), [], fault);
  }
  const bytes = await workflowDownload(t, 'bytes'); await assert.rejects(bytes.execute());
  assert.deepEqual(fs.readdirSync(path.join(bytes.temp, 'private017-portable-stage', 'input')), []);
});
test('controlled workflow tool builds derive pins from source-bound Cargo outputs, copying hardlinks before strict reads', async t => {
  const f = await workflowDownload(t); await f.execute(); const root = f.temp, stage = path.join(root, 'private017-portable-stage');
  const { capture } = require('./sign-unix-payload.cjs');
  fs.writeFileSync(path.join(stage, 'data-preflight.json'), JSON.stringify({ signatureVerificationPending: true, releaseReady: false, request: capture(path.join(stage, 'request.json'), 65536) }));
  const rows = [], sources = ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/build.rs', 'src-tauri/examples/verify-package-input.rs', 'src-tauri/src/catalog-key.pub', 'native/module-archive/Cargo.toml'];
  for (const name of sources) {
    const file = path.join(root, name), bytes = Buffer.from(`Synthetic source-bound validator fixture: ${name}`);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    const blob = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); rows.push(`100644 blob ${blob}\t${name}`);
  }
  const builds = [], outputs = [];
  const execute = (command, args) => {
    if (command === 'git') { if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? f.env.GITHUB_SHA : p.SOURCE.sourceTree;
      return args[0] === 'ls-tree' ? rows.join('\0') + '\0' : ''; }
    if (command === 'rustc') return 'rustc 1.99.0 (synthetic)\nhost: x86_64-unknown-linux-gnu\n';
    assert.equal(command, 'cargo'); if (args[0] === '--version') return 'cargo 1.99.0 (synthetic)';
    assert.equal(args[0], 'build'); assert.ok(args.includes('--locked')); assert.equal(args.includes('--features'), false);
    const target = args[args.indexOf('--target-dir') + 1], verifier = args.includes('--example');
    const file = path.join(target, verifier ? 'release/examples/verify-package-input' : 'release/creator-hub-module-archive');
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, elf('Synthetic tool; never executed'));
    fs.linkSync(file, `${file}.cargo-hardlink`); assert.equal(fs.lstatSync(file).nlink, 2); outputs.push(file); builds.push(args); return '';
  };
  const local = name => name === 'node:child_process' ? { execFileSync: execute } : name === './scripts/private-linux-portable-fixture-017.cjs'
    ? { ...p, admission: value => p.admission(value, 'linux', 'x64') } : name.startsWith('./scripts/') ? require(path.join(__dirname, '..', name)) : require(name);
  const step = portableWorkflow().workflow.jobs.package.steps.find(item => item.name?.startsWith('Compile only source-bound'));
  const code = /node - <<'NODE'\n([\s\S]*?)\nNODE/.exec(step.run)[1]; new Function('require', 'process', code)(local, { env: f.env });
  assert.equal(builds.length, 2); assert.deepEqual(builds.map(args => args.includes('--example')), [true, false]);
  const receipt = JSON.parse(fs.readFileSync(path.join(stage, 'tool-build.json'))), profile = JSON.parse(fs.readFileSync(path.join(stage, 'input/profile.json')));
  assert.equal(receipt.freshSingleLinkCopies, true); assert.equal(receipt.rootRecompiled, false); assert.equal(receipt.selectorRecompiled, false); assert.equal(receipt.privateModulesRecompiled, false); assert.equal(receipt.releaseReady, false);
  assert.deepEqual(profile.tools, receipt.tools); assert.deepEqual(receipt.rootSource, p.SOURCE); assert.ok(receipt.publicKey.gitBlob);
  for (const [name, file] of Object.entries(p.fixedTools(root))) { assert.equal(fs.lstatSync(file).nlink, 1); assert.deepEqual(capture(file, receipt.tools[name].size), receipt.tools[name]); }
  assert.ok(outputs.every(file => fs.lstatSync(file).nlink === 2));
  new Function('require', 'process', code);
});
test('portable017 data adapter stages exact signed input through the frozen library without spoofing its assembly CLI guard', t => {
  const temp = owned(t), root = path.resolve(__dirname, '..'), f = data();
  const step = portableWorkflow().workflow.jobs.package.steps.find(value => value.name?.startsWith('Inspect all data'));
  const code = /const carrier17=String.raw`([\s\S]*?)`;/m.exec(step.with.script)[1];
  assert.match(code, /m\.stage\(/); assert.doesNotMatch(code, /os\.environ\[|os\.environ\.update|subprocess|exec\(|eval\(/);
  assert.doesNotMatch(step.with.script, /\['-B','scripts\/stage-private-linux-update-fixture-017\.py'/);
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const plan = f.files['plan.json'], planSha256 = neutral.record(plan).sha256, inner = path.join(temp, 'signed017.zip');
  const makeZip = (file, entries) => {
    const checked = spawnSync(python, ['-B', '-c', 'import base64,json,sys,zipfile\nc=json.load(sys.stdin)\nwith zipfile.ZipFile(sys.argv[1],"x",compression=zipfile.ZIP_STORED) as z:\n for n,b in c.items(): z.writestr(n,base64.b64decode(b))', file],
      { input: JSON.stringify(Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, bytes.toString('base64')]))), encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(checked.status, 0, checked.stderr);
  };
  makeZip(inner, f.files);
  const bytes = fs.readFileSync(inner), transport = Buffer.from(JSON.stringify({ assetId: 123, zipBytes: bytes.length, zipSha256: neutral.record(bytes).sha256, planSha256 }));
  const bodies = { 'private017-signed.zip': bytes, 'approved-plan.json': plan, 'signed-input.json': transport };
  const original = path.join(temp, 'carrier.zip'); makeZip(original, Object.fromEntries(Object.entries(bodies).map(([name, bytes]) => [`carrier/${name}`, bytes])));
  const config = { carrier: { zip: neutral.record(fs.readFileSync(original)), files: Object.fromEntries(Object.entries(bodies).map(([name, bytes]) => [name, { member: `carrier/${name}`, ...neutral.record(bytes) }])) }, planSha256 };
  const run = (source, configuration, suffix) => spawnSync(python, ['-B', '-c', code, root, source, path.join(temp, `carrier-${suffix}`), path.join(temp, `input-${suffix}`), temp],
    { input: JSON.stringify(configuration), encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const accepted = run(original, config, 'good'); assert.equal(accepted.status, 0, accepted.stderr);
  const receipt = JSON.parse(accepted.stdout); assert.equal(receipt.signaturesVerified, false); assert.equal(receipt.releaseReady, false);
  for (const [name, expected] of Object.entries(f.files)) assert.ok(fs.readFileSync(path.join(temp, 'input-good', name)).equals(expected));
  const wrong = structuredClone(config); wrong.carrier.zip.sha256 = 'f'.repeat(64);
  assert.notEqual(run(original, wrong, 'bad-pin').status, 0); assert.equal(fs.existsSync(path.join(temp, 'input-bad-pin')), false);
  const extra = path.join(temp, 'extra.zip'); makeZip(extra, { ...Object.fromEntries(Object.entries(bodies).map(([name, bytes]) => [`carrier/${name}`, bytes])), '../escape': Buffer.from('refuse') });
  const evil = structuredClone(config); evil.carrier.zip = neutral.record(fs.readFileSync(extra));
  assert.notEqual(run(extra, evil, 'bad-member').status, 0); assert.equal(fs.existsSync(path.join(temp, 'input-bad-member')), false);
  assert.equal(fs.existsSync(path.join(temp, 'escape')), false);
});
test('workflow parses every embedded JavaScript and Bash block and retains only finite unsigned output paths', () => {
  const { workflow } = portableWorkflow();
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'; assert.ok(fs.existsSync(bash));
  for (const step of workflow.jobs.package.steps) {
    if (step.with?.script) new AsyncFunction('require', 'process', 'github', 'context', step.with.script);
    if (step.run) {
      const checked = spawnSync(bash, ['-n'], { input: step.run, encoding: 'utf8', windowsHide: true, timeout: 10000 }); assert.equal(checked.status, 0, checked.stderr);
      for (const match of step.run.matchAll(/node - <<'NODE'\n([\s\S]*?)\nNODE/g)) new Function(match[1]);
    }
  }
  for (const step of workflow.jobs.package.steps.filter(value => value.uses === 'actions/upload-artifact@v4')) {
    const lines = step.with.path.trim().split('\n'); assert.ok(lines.length <= 10);
    assert.ok(lines.every(line => line.startsWith('${{ runner.temp }}/private017-portable-')));
    assert.ok(lines.every(line => !/[?*]/.test(line)));
    assert.doesNotMatch(step.with.path, /Native\.Support|\.minisig|signed017|signed016|\/home|\.key|profile\.json|modules\.tar\.gz/);
    assert.equal(step.with['compression-level'], 0);
  }
});
