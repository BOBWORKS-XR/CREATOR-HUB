const test = require('node:test');
const assert = require('node:assert/strict');
const { publishDraft } = require('./publish-hub-draft.cjs');
test('source-only consolidation blocks the publisher before inspecting or writing GitHub', async () => {
  const calls = [];
  await assert.rejects(publishDraft('0.1.13', {
    checkDraft: async () => { calls.push('draft'); return {}; },
    publish: async () => { calls.push('publish'); },
    checkLive: async () => { calls.push('live'); return {}; },
  }), /Source consolidation is not a unified release/);
  assert.deepEqual(calls, []);
});

test('failed legacy-client budget check blocks publication before any remote write', async () => {
  let writes = 0;
  await assert.rejects(publishDraft('0.1.4', {
    checkReadiness: () => {},
    checkDraft: async () => { throw Error('oversized proposed feed'); },
    publish: async () => { writes++; },
  }), /oversized/);
  assert.equal(writes, 0);
});
test('published draft must pass the live feed and is not automatically called ready', async () => {
  const calls = [];
  const result = await publishDraft('0.1.4', {
    checkReadiness: () => { calls.push('readiness'); },
    checkDraft: async version => { calls.push(`draft:${version}`); return { headroom: 12000 }; },
    publish: async tag => { calls.push(`publish:${tag}`); },
    checkLive: async version => { calls.push(`live:${version}`); return { bytes: 240000 }; },
  });
  assert.deepEqual(calls, ['readiness', 'draft:0.1.4', 'publish:v0.1.4', 'live:0.1.4']);
  assert.equal(result.ready, false);
  assert.match(result.next, /self-update acceptance/);
});
test('a failed public-path check cannot be reported as a successful release', async () => {
  await assert.rejects(publishDraft('0.1.4', {
    checkReadiness: () => {},
    checkDraft: async () => ({}), publish: async () => {},
    checkLive: async () => { throw Error('public response differs'); },
  }), /public response differs/);
});

test('CLI refuses the current source phase independently of the working directory', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [require.resolve('./publish-hub-draft.cjs'), '0.1.13'],
    { cwd: require('node:os').tmpdir(), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 1, result.error?.message);
  assert.match(result.stderr, /Source consolidation is not a unified release/);
  assert.match(result.stderr, /Release readiness is blocked/);
  assert.equal(result.stdout, '');
});
