'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const L = require('./native-linux-016-input.cjs');
const clone = v => JSON.parse(JSON.stringify(v));
function profile() {
  return { schemaVersion: 1, mode: 'pages', assembly: { sourceCommit: 'a'.repeat(40), runId: 1, runAttempt: 1, jobId: 2,
    artifactId: 3, zipBytes: 40, zipSha256: 'b'.repeat(64) },
  pins: Object.fromEntries(L.PINS.map(k => [k, { size: 1, sha256: 'c'.repeat(64) }])) };
}
function fixture() {
  const p = profile().assembly, repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' };
  return { p, run: { id: 1, head_sha: p.sourceCommit, run_attempt: 1, status: 'completed', conclusion: 'success',
    event: 'workflow_dispatch', head_branch: 'validation/linux-integrated-candidate-016', path: '.github/workflows/unix-managed-assembly.yml', repository: repo, head_repository: repo },
  job: { id: 2, run_id: 1, run_attempt: 1, status: 'completed', conclusion: 'success', name: 'assembly (linux, ubuntu-22.04)', started_at: '2026-10-19T10:00:00Z', completed_at: '2026-10-19T11:00:00Z' },
  artifact: { id: 3, expired: false, name: 'signed-unix-hub-linux-1-1', size_in_bytes: 40, digest: 'sha256:' + p.zipSha256,
    created_at: '2026-10-19T10:30:00Z', workflow_run: { id: 1, head_sha: p.sourceCommit, repository_id: 1364807512, head_repository_id: 1364807512 } } };
}
test('finite 016 schema admits only exact pins, not paths, flags or migration approval', () => {
  assert.equal(L.validate(profile()).mode, 'pages'); const cancel = profile(); cancel.mode = 'migration-cancel'; L.validate(cancel);
  for (const mutation of [p => p.mode = 'migration-approve', p => p.version = '0.1.14', p => p.assembly.zipBytes = 0,
    p => p.assembly.runAttempt = true, p => p.assembly.sourceCommit = '../source', p => p.pins.hub.sha256 = 'bad',
    p => p.pins.hub.path = '/tmp/untrusted', p => delete p.pins.service, p => p.pins.helper.size = 300 * 1024 * 1024]) {
    const p = profile(); mutation(p); assert.throws(() => L.validate(p));
  }
});
test('API binding rejects stale source, attempt, job, foreign repository or incomplete producer', () => {
  const f = fixture(); L.artifactBinding(f.run, f.job, f.artifact, f.p);
  for (const [section, field, value] of [['run', 'head_sha', 'd'.repeat(40)], ['run', 'run_attempt', 2], ['run', 'conclusion', 'failure'],
    ['run', 'event', 'pull_request'], ['run', 'head_branch', 'validation/linux-integrated-candidate-014'], ['job', 'id', 99],
    ['job', 'run_attempt', 2], ['job', 'status', 'in_progress'], ['job', 'name', 'assembly (macos, x)'], ['artifact', 'expired', true],
    ['artifact', 'digest', 'sha256:' + 'd'.repeat(64)], ['artifact', 'created_at', '2026-10-19T12:00:00Z']]) {
    const x = clone(f); x[section][field] = value; assert.throws(() => L.artifactBinding(x.run, x.job, x.artifact, x.p));
  }
  const foreign = clone(f); foreign.run.head_repository.id = 22;
  assert.throws(() => L.artifactBinding(foreign.run, foreign.job, foreign.artifact, foreign.p));
});
test('fresh journal A guard is separate, exact, and refuses incomplete or mismatched evidence', () => {
  const f = fixture();
  Object.assign(f.p, L.JOURNAL_A_ASSEMBLY);
  Object.assign(f.run, { id: f.p.runId, head_sha: f.p.sourceCommit, head_branch: 'validation/journal-a-assembly-016' });
  Object.assign(f.job, { id: f.p.jobId, run_id: f.p.runId, head_sha: f.p.sourceCommit,
    head_branch: f.run.head_branch, name: 'assembly (linux, ubuntu-22.04, synthetic)' });
  Object.assign(f.artifact, { id: f.p.artifactId, name: `signed-unix-hub-linux-${f.p.runId}-${f.p.runAttempt}`,
    size_in_bytes: f.p.zipBytes, digest: `sha256:${f.p.zipSha256}` });
  f.artifact.workflow_run.id = f.p.runId;
  f.artifact.workflow_run.head_sha = f.p.sourceCommit;
  L.journalAFreshArtifactBinding(f.run, f.job, f.artifact, f.p);
  assert.throws(() => L.artifactBinding(f.run, f.job, f.artifact, f.p));
  for (const [section, field, value] of [
    ['p', 'runId', 40899552208], ['p', 'jobId', 123537944798], ['p', 'zipSha256', 'bad'],
    ['p', 'sourceCommit', 'f'.repeat(40)], ['p', 'sourceTree', 'f'.repeat(40)], ['p', 'runAttempt', 2],
    ['p', 'artifactId', 12909617949], ['p', 'zipBytes', 183999604], ['run', 'status', 'in_progress'],
    ['run', 'conclusion', null], ['run', 'event', 'push'], ['run', 'head_branch', 'validation/journal-a-assembly-016-extra'],
    ['run', 'head_sha', 'f'.repeat(40)], ['run', 'run_attempt', 2], ['job', 'id', 123537944798],
    ['job', 'head_sha', 'f'.repeat(40)], ['job', 'head_branch', 'foreign'], ['job', 'status', 'in_progress'],
    ['job', 'name', 'assembly (linux, ubuntu-24.04)'], ['artifact', 'expired', true],
    ['artifact', 'digest', 'sha256:' + 'f'.repeat(64)], ['artifact', 'created_at', '2026-10-19T12:00:00Z'],
  ]) {
    const x = clone(f); x[section][field] = value;
    assert.throws(() => L.journalAFreshArtifactBinding(x.run, x.job, x.artifact, x.p), `${section}.${field}`);
  }
  const old = fixture(); assert.throws(() => L.journalAFreshArtifactBinding(old.run, old.job, old.artifact, old.p));
});
test('PRIVATE_SOURCE_PATHS compare Git tree identities and reject absent or redirected types', async () => {
  const rows = { modules: '1'.repeat(40), native: '2'.repeat(40), 'src-tauri': '3'.repeat(40) };
  const fake = { rest: { git: { async getCommit() { return { data: { sha: 'a'.repeat(40), tree: { sha: '0'.repeat(40) } } }; },
    async getTree({ tree_sha: sha }) {
      const entries = sha === '0'.repeat(40) ? Object.entries(rows).map(([path, sha]) => ({ path, sha, type: 'tree' }))
        : sha === rows.modules ? ['mcp', 'project-setup'].map(path => ({ path, sha: '4'.repeat(40), type: 'tree' }))
        : sha === rows.native ? ['mcp-router', 'host_parent_macos.rs', 'plugins_retirement.rs', 'convergence-server-unix.rs'].map(path => ({ path, sha: '5'.repeat(40), type: path.endsWith('.rs') ? 'blob' : 'tree' }))
        : sha === rows['src-tauri'] ? [{ path: 'src', sha: '6'.repeat(40), type: 'tree' }]
        : ['module_archive.rs', 'catalog-key.pub'].map(path => ({ path, sha: '7'.repeat(40), type: 'blob' }));
      return { data: { truncated: false, tree: entries } };
    } } } };
  const found = await L.treePaths(fake, 'a'.repeat(40)); assert.deepEqual(Object.keys(found), L.PRIVATE_PATHS);
  fake.rest.git.getTree = async () => ({ data: { truncated: true, tree: [] } });
  await assert.rejects(L.treePaths(fake, 'a'.repeat(40)));
});
test('private payload and original legacy DEB identities remain finite and immutable', () => {
  assert.equal(L.PRIVATE.runId, 39326776585); assert.equal(L.PRIVATE.sourceCommit, '52e3a537c9d323c81ab259cb82b44bbe0828b414');
  assert.equal(L.LEGACY.length, 2); assert.equal(L.LEGACY[0].size, 96666824); assert.equal(L.LEGACY[1].size, 5966970);
});
test('manual schema file exactly documents all finite input fields and pins', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'native-linux-016-input.schema.json'), 'utf8'));
  assert.deepEqual(schema.required, ['schemaVersion', 'mode', 'assembly', 'pins']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.mode.enum, ['pages', 'migration-cancel']);
  assert.deepEqual(schema.properties.assembly.required.sort(), Object.keys(profile().assembly).sort());
  assert.deepEqual(schema.properties.pins.required, L.PINS);
  assert.deepEqual(Object.keys(schema.properties.pins.properties), L.PINS);
  assert.equal(schema.$defs.pin.additionalProperties, false);
  assert.equal(schema.$defs.pin.properties.size.maximum, 256 * 1024 * 1024);
  assert.equal(schema.properties.assembly.properties.zipBytes.maximum, 300 * 1024 * 1024);
});
test('pre-apt source contract uses current UI and canonical SDK lock, not Windows newline bytes', () => {
  const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
  const html = read('src/index.html'), guide = read('src/convergence.js');
  for (const id of ['view-projects', 'projects-home-title', 'unified-home-updater', 'suite-menu', 'suite-trigger', 'convergence-move'])
    assert.ok(html.includes(`id="${id}"`), id);
  assert.match(guide, /stage === 'complete' \? 'Move complete' : current\?\.recoveryHelp \? 'Migration needs review' : 'Move to Hub'/);
  assert.match(guide, /prepare\.hidden = connections\.hidden = retire\.hidden = true/);
  assert.match(read('src/projects.js'), /MCP bridge not installed/);
  assert.match(read('src/features/mcp.js'), /aria-pressed/);
  const lock = read('modules/mcp/package-lock.json').replaceAll('\r\n', '\n');
  assert.equal(crypto.createHash('sha256').update(lock).digest('hex'), 'ded7a99b78aca304253d5287cc1b884a845afde083eb32d1a2abecd14468ba60');
  assert.equal(JSON.parse(lock).packages['node_modules/@modelcontextprotocol/sdk'].version, '1.29.0');
  const source = read('scripts/assemble-unix-payload.cjs');
  const paths = source.match(/const PRIVATE_SOURCE_PATHS = (\[[\s\S]*?\]);/)[1];
  assert.deepEqual(JSON.parse(paths.replaceAll("'", '"')), L.PRIVATE_PATHS);
});
test('unknown approval mode and oversized profile stop before even a read-only API request', async () => {
  const context = { repo: { owner: 'BOBWORKS-XR', repo: 'CREATOR-HUB' }, eventName: 'workflow_dispatch', ref: L.REF };
  const env = { GITHUB_REPOSITORY_ID: '1364807512', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64' };
  let calls = 0;
  const github = { get rest() { calls++; throw Error('No API access permitted for invalid input'); } };
  const p = profile(); p.mode = 'migration-approve';
  await assert.rejects(L.run({ github, context, env, profile: JSON.stringify(p) }));
  await assert.rejects(L.run({ github, context, env, profile: ' '.repeat(16385) }));
  assert.equal(calls, 0);
  for (const context_ of [{ ...context, eventName: 'push' }, { ...context, ref: 'refs/heads/main' }])
    assert.throws(() => L.admission(context_, env));
});
test('original legacy download validates release metadata then actual bounded bytes', async () => {
  const bytes = Buffer.from('synthetic DEB fixture, never executed'), row = { product: 'mcp', repo: 'CREATOR-WORKS-UNITY-MCP',
    tag: 'v2.7.7', name: 'Creator.Works.MCP_2.7.7_amd64.deb', size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  const release = { id: 1, tag_name: row.tag, draft: false, prerelease: false, assets: [{ id: 2, state: 'uploaded', name: row.name,
    size: row.size, digest: 'sha256:' + row.sha256,
    browser_download_url: `https://github.com/BOBWORKS-XR/${row.repo}/releases/download/${row.tag}/${row.name}` }] };
  let calls = 0;
  const github = { rest: { repos: { async getReleaseByTag() { return { data: release }; } } } };
  const fetch_ = async () => { calls++; return { status: 200, body: [bytes] }; };
  assert.deepEqual((await L.publicDeb(github, row, fetch_)).bytes, bytes);
  release.draft = true;
  await assert.rejects(L.publicDeb(github, row, fetch_)); assert.equal(calls, 1);
  release.draft = false;
  await assert.rejects(L.publicDeb(github, row, async () => ({ status: 200, body: [bytes, Buffer.from('overflow')] })));
  await assert.rejects(L.publicDeb(github, row, async () => ({ status: 200, body: [Buffer.alloc(row.size)] })));
});
test('exact-branch registration push skips the sole native job; execution stays manual and finite', () => {
  const text = fs.readFileSync(path.join(__dirname, '../.github/workflows/native-linux-016-pages.yml'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(text, /^on:\n  push:\n    branches: \[validation\/native-linux-016\]\n  workflow_dispatch:/m);
  assert.doesNotMatch(text, /contents: write|secrets\.|macos-|windows-|cargo tauri|npm run build|git push/);
  const jobs = text.split('\njobs:\n')[1];
  assert.deepEqual([...jobs.matchAll(/^  ([a-zA-Z0-9_-]+):$/gm)].map(match => match[1]), ['native']);
  const guard = jobs.match(/^  native:\n    if: >-\n([\s\S]*?)\n    runs-on:/)[1].trim().replace(/\s+/g, ' ');
  assert.equal(guard, "github.repository == 'BOBWORKS-XR/CREATOR-HUB' && github.repository_id == '1364807512' && "
    + "github.ref == 'refs/heads/validation/native-linux-016' && github.event_name == 'workflow_dispatch'");
  const context = { repo: { owner: 'BOBWORKS-XR', repo: 'CREATOR-HUB' }, eventName: 'push', ref: L.REF };
  const env = { GITHUB_REPOSITORY_ID: '1364807512', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64' };
  assert.throws(() => L.admission(context, env));
  L.admission({ ...context, eventName: 'workflow_dispatch' }, env);
  assert.match(text, /refs\/heads\/validation\/native-linux-016/);
  assert.ok(text.indexOf('native-linux-016-input.test.cjs') < text.indexOf('lane.run'));
  assert.ok(text.indexOf('native-linux-016-stage.py') < text.indexOf("'--install'"));
  for (const session of ['first', 'reopened']) for (const stream of ['stdout', 'stderr'])
    assert.ok(text.includes(`native-linux-016-result/${session}/driver.${stream}`));
  assert.doesNotMatch(text, /native-linux-016-result\/\*\/driver\.\*|\/var\/log/);
  const ui = fs.readFileSync(path.join(__dirname, 'native-linux-016-pages.py'), 'utf8');
  assert.doesNotMatch(ui, /#entry-mcp|#convergence-prepare|#convergence-connections|#convergence-retire|execute\/sync|window\.__TAURI__|\.run\(binding/);
  assert.match(ui, /#convergence-move/); assert.match(ui, /#suite-menu/);
});
module.exports = { profile, fixture };
