'use strict';
// Fresh public API evidence only. No downloads, key selection or candidate execution.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const metadata = require('./private-linux-update-fixture-017-metadata.cjs');
const { collect } = require('./collect-unix-payload-binding.cjs');
const { compactProof } = require('./sign-unix-payload.cjs');
const native = require('./native-linux-016-input.cjs');
const fixture = require('./private-linux-update-fixture-017.cjs');

const REPOSITORY = 'BOBWORKS-XR/CREATOR-HUB';
const VERSION_PATHS = ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json'];
function api(route) {
  return JSON.parse(execFileSync('gh', ['api', `repos/${REPOSITORY}/${route}`], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  }));
}
async function fresh({ plan, handoff, preparedFile }, request = api) {
  metadata.validatePlan(plan);
  const expected = handoff.apiProof.expected;
  const routes = [`actions/runs/${expected.runId}`, `actions/artifacts/${expected.artifactId}`,
    `git/commits/${expected.sourceCommit}`, `actions/runs/${expected.runId}/attempts/${expected.runAttempt}/jobs?per_page=100`];
  const replies = new Map();
  for (const route of routes) replies.set(route, await request(route));
  const original = collect(expected, preparedFile, route => { assert.ok(replies.has(route)); return replies.get(route); });
  assert.deepEqual(compactProof(original), handoff.apiProof, 'Fresh original016 producer proof differs from signed handoff');
  const p = plan.baseline016.assembly;
  const baseline = { run: await request(`actions/runs/${p.runId}`), job: await request(`actions/jobs/${p.jobId}`),
    artifact: await request(`actions/artifacts/${p.artifactId}`), commit: await request(`git/commits/${p.sourceCommit}`) };
  const root = { commit: await request(`git/commits/${plan.rootSource.sourceCommit}`) };
  metadata.validateApi(plan, baseline, root);
  const github = { rest: { git: {
    getCommit: async ({ commit_sha }) => ({ data: await request(`git/commits/${commit_sha}`) }),
    getTree: async ({ tree_sha }) => ({ data: await request(`git/trees/${tree_sha}`) }),
  } } };
  const originalPaths = await native.treePaths(github, handoff.source.sourceCommit);
  for (const commit of [p.sourceCommit, plan.rootSource.sourceCommit]) {
    assert.deepEqual(await native.treePaths(github, commit), originalPaths, 'Private source differs from original016 producer');
  }
  const versions = {};
  for (const name of VERSION_PATHS) {
    const response = await request(`contents/${name}?ref=${plan.rootSource.sourceCommit}`);
    assert.equal(response.path, name); assert.equal(response.type, 'file'); assert.equal(response.encoding, 'base64');
    assert.ok(Number.isSafeInteger(response.size) && response.size > 0 && response.size <= 128 * 1024);
    assert.match(response.sha, /^[a-f0-9]{40}$/);
    assert.ok(typeof response.content === 'string' && response.content.length <= 180 * 1024);
    const encoded = response.content.replace(/\n/g, ''), bytes = Buffer.from(encoded, 'base64');
    assert.equal(bytes.toString('base64'), encoded); assert.equal(bytes.length, response.size);
    const value = metadata.parse(Buffer.from(bytes.toString('utf8').trim()));
    assert.equal(value.version, fixture.VERSION, 'Actual017 source version JSON differs');
    if (name === 'package-lock.json') assert.equal(value.packages?.['']?.version, fixture.VERSION, 'Actual017 npm lock root differs');
    versions[name] = { gitBlob: response.sha, ...metadata.record(bytes) };
  }
  return { original: compactProof(original), baseline, root, privateSourcePaths: originalPaths, versionSources: versions,
    ...fixture.FLAGS };
}
module.exports = { REPOSITORY, VERSION_PATHS, api, fresh };
