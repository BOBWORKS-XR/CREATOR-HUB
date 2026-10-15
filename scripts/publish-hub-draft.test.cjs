const test = require('node:test');
const assert = require('node:assert/strict');
const { publishDraft } = require('./publish-hub-draft.cjs');
const { RELEASE_NOT_VISIBLE } = require('./check-release-feed.cjs');
test('source-only consolidation blocks the publisher before inspecting or writing GitHub', async () => {
  const calls = [];
  await assert.rejects(publishDraft('0.1.13', {
    verifyQualification: async () => { calls.push('qualification'); },
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
    verifyQualification: async () => {},
    checkDraft: async () => { throw Error('oversized proposed feed'); },
    publish: async () => { writes++; },
  }), /oversized/);
  assert.equal(writes, 0);
});
test('published draft must pass the live feed and is not automatically called ready', async () => {
  const calls = [];
  const result = await publishDraft('0.1.4', {
    checkReadiness: () => { calls.push('readiness'); },
    verifyQualification: async () => { calls.push('qualification'); },
    checkDraft: async version => { calls.push(`draft:${version}`); return { headroom: 12000, previousStable: '0.1.12' }; },
    publish: async tag => { calls.push(`publish:${tag}`); },
    checkLive: async version => { calls.push(`live:${version}`); return { bytes: 240000 }; },
  });
  assert.deepEqual(calls, ['readiness', 'qualification', 'draft:0.1.4', 'publish:v0.1.4', 'live:0.1.4']);
  assert.equal(result.ready, false);
  assert.match(result.next, /self-update acceptance/);
});
test('a failed public-path check cannot be reported as a successful release', async () => {
  await assert.rejects(publishDraft('0.1.4', {
    checkReadiness: () => {},
    verifyQualification: async () => {},
    checkDraft: async () => ({ previousStable: '0.1.12' }), publish: async () => {},
    checkLive: async () => { throw Error('public response differs'); },
  }), /public response differs/);
});

test('post-write visibility delay retries only reads with injected two-second waits', async () => {
  const calls = []; let reads = 0;
  const result = await publishDraft('0.1.14', {
    checkReadiness: () => { calls.push('local'); return {}; },
    verifyQualification: async () => { calls.push('qualification'); },
    checkDraft: async () => { calls.push('draft'); return { previousStable: '0.1.12' }; },
    publish: async () => { calls.push('write'); },
    checkLive: async () => { calls.push('read'); if (++reads < 3) throw Object.assign(Error('not visible'), { code: RELEASE_NOT_VISIBLE }); return { bytes: 159261 }; },
    wait: async ms => { calls.push(`wait:${ms}`); },
  });
  assert.deepEqual(calls, ['local', 'qualification', 'draft', 'write', 'read', 'wait:2000', 'read', 'wait:2000', 'read']);
  assert.equal(result.ready, false); assert.equal(result.live.bytes, 159261);
});

test('visibility rechecks allow the thirtieth read, but stop after thirty failures without another write', async () => {
  for (const succeeds of [true, false]) {
    let reads = 0, writes = 0; const waits = [];
    const missing = Object.assign(Error('not visible'), { code: RELEASE_NOT_VISIBLE });
    const attempt = publishDraft('0.1.14', {
      checkReadiness: () => ({}), verifyQualification: async () => {},
      checkDraft: async () => ({ previousStable: '0.1.12' }), publish: async () => { writes++; },
      checkLive: async () => { if (++reads === 30 && succeeds) return {}; throw missing; },
      wait: async ms => { waits.push(ms); },
    });
    if (succeeds) assert.equal((await attempt).ready, false);
    else await assert.rejects(attempt, error => error === missing);
    assert.equal(reads, 30); assert.equal(writes, 1); assert.deepEqual(waits, Array(29).fill(2000));
  }
});

test('all other post-write errors fail immediately, including a matching message without the code', async () => {
  for (const error of [Error('Expected public release is missing from the current feed.'), Error('oversized feed'),
    Error('missing signature'), new SyntaxError('malformed JSON'), Error('HTTP 503'),
    Object.assign(Error('timeout'), { code: 'ETIMEDOUT' })]) {
    let reads = 0, writes = 0, waits = 0;
    await assert.rejects(publishDraft('0.1.14', {
      checkReadiness: () => ({}), verifyQualification: async () => {},
      checkDraft: async () => ({ previousStable: '0.1.12' }), publish: async () => { writes++; },
      checkLive: async () => { reads++; throw error; }, wait: async () => { waits++; },
    }), actual => actual === error);
    assert.equal(reads, 1); assert.equal(writes, 1); assert.equal(waits, 0);
  }
});

test('visibility-coded errors before or during the write are never retried', async () => {
  for (const stage of ['checkReadiness', 'verifyQualification', 'checkDraft', 'publish']) {
    let reads = 0, writes = 0, waits = 0;
    const error = Object.assign(Error('not visible'), { code: RELEASE_NOT_VISIBLE });
    const actions = { checkReadiness: () => ({}), verifyQualification: async () => {},
      checkDraft: async () => ({ previousStable: '0.1.12' }), publish: async () => { writes++; },
      checkLive: async () => { reads++; }, wait: async () => { waits++; } };
    actions[stage] = async () => { if (stage === 'publish') writes++; throw error; };
    await assert.rejects(publishDraft('0.1.14', actions), actual => actual === error);
    assert.equal(writes, stage === 'publish' ? 1 : 0); assert.equal(reads, 0); assert.equal(waits, 0);
  }
});

test('exact publication intent reaches local readiness before current remote qualification and feed checks', async () => {
  const calls = [], qualification = { kind: 'TEST ONLY' }, options = { receipt: 'reviewed.json', platform: 'windows-x86_64' };
  await publishDraft('0.1.14', {
    checkReadiness: (version, intent) => { calls.push('local'); assert.equal(version, '0.1.14'); assert.equal(intent, options); return qualification; },
    verifyQualification: async value => { calls.push('remote'); assert.equal(value, qualification); },
    checkDraft: async () => { calls.push('feed'); return { previousStable: '0.1.12' }; },
    publish: async () => { calls.push('publish'); }, checkLive: async () => { calls.push('live'); return {}; },
  }, options);
  assert.deepEqual(calls, ['local', 'remote', 'feed', 'publish', 'live']);
});

test('changed current run or draft bytes refuse before feed inspection or publication', async () => {
  const calls = [];
  await assert.rejects(publishDraft('0.1.14', {
    checkReadiness: () => { calls.push('local'); return {}; },
    verifyQualification: async () => { calls.push('remote'); throw Error('qualified draft changed'); },
    checkDraft: async () => { calls.push('feed'); }, publish: async () => { calls.push('publish'); },
  }), /qualified draft changed/);
  assert.deepEqual(calls, ['local', 'remote']);
});

test('a newer public stable than the qualified incoming baseline refuses before publication', async () => {
  let writes = 0;
  await assert.rejects(publishDraft('0.1.14', {
    checkReadiness: () => ({}), verifyQualification: async () => {},
    checkDraft: async () => ({ previousStable: '0.1.13' }), publish: async () => { writes++; },
  }), /previous stable differs/);
  assert.equal(writes, 0);
});

test('the sole default write preserves the exact draft tag and ID, never assets or latest', async () => {
  const commands = [];
  await publishDraft('0.1.14', {
    checkReadiness: () => ({ draft: { id: 401 } }), verifyQualification: async () => {},
    checkDraft: async () => ({ previousStable: '0.1.12' }), checkLive: async () => ({}),
    execute: (command, args) => { commands.push({ command, args }); return '{}'; },
  });
  assert.deepEqual(commands, [{ command: 'gh', args: ['api', '--method', 'PATCH',
    'repos/BOBWORKS-XR/CREATOR-HUB/releases/401', '-f', 'tag_name=v0.1.14', '-F', 'draft=false', '-f', 'make_latest=false'] }]);
});

test('invalid local qualification never reaches any GitHub verification or write', async t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-invalid-qualification-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const receipt = path.join(directory, 'TEST-ONLY.json'); fs.writeFileSync(receipt, JSON.stringify({ approvedForStable: true }));
  const calls = [];
  await assert.rejects(publishDraft('0.1.14', {
    verifyQualification: async () => { calls.push('remote'); },
    checkDraft: async () => { calls.push('feed'); }, execute: () => { calls.push('write'); },
  }, { receipt, platform: 'windows-x86_64' }));
  assert.deepEqual(calls, []);
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
