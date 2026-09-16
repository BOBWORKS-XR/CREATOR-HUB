const test = require('node:test');
const assert = require('node:assert/strict');
const { publishDraft } = require('./publish-hub-draft.cjs');
test('failed legacy-client budget check blocks publication before any remote write', async () => {
  let writes = 0;
  await assert.rejects(publishDraft('0.1.4', {
    checkDraft: async () => { throw Error('oversized proposed feed'); },
    publish: async () => { writes++; },
  }), /oversized/);
  assert.equal(writes, 0);
});
test('published draft must pass the live feed and is not automatically called ready', async () => {
  const calls = [];
  const result = await publishDraft('0.1.4', {
    checkDraft: async version => { calls.push(`draft:${version}`); return { headroom: 12000 }; },
    publish: async tag => { calls.push(`publish:${tag}`); },
    checkLive: async version => { calls.push(`live:${version}`); return { bytes: 240000 }; },
  });
  assert.deepEqual(calls, ['draft:0.1.4', 'publish:v0.1.4', 'live:0.1.4']);
  assert.equal(result.ready, false);
  assert.match(result.next, /self-update acceptance/);
});
test('a failed public-path check cannot be reported as a successful release', async () => {
  await assert.rejects(publishDraft('0.1.4', {
    checkDraft: async () => ({}), publish: async () => {},
    checkLive: async () => { throw Error('public response differs'); },
  }), /public response differs/);
});
