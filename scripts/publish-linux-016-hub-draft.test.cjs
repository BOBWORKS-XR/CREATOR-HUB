'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const q = require('./linux-016-release-qualification.cjs');
const publisher = require('./publish-linux-016-hub-draft.cjs');
const { fixture } = require('./linux-016-release-qualification.test.cjs');
const { fixture: feedFixture } = require('./check-linux-016-release-feed.test.cjs');

test('standalone Linux publisher refuses before reading any qualification or remote state', () => {
  const result = spawnSync(process.execPath, [require.resolve('./publish-linux-016-hub-draft.cjs'), '0.1.16'],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Use scripts\/publish-hub-draft.cjs/);
});
test('direct Linux worker cannot bypass canonical readiness', async t => {
  const canonical = require('./publish-hub-draft.cjs'); let calls = 0;
  t.mock.method(canonical, 'checkReadiness', () => { calls++; throw Error('canonical readiness held'); });
  await assert.rejects(publisher.publish({ receipt: path.resolve('TEST-NO-READ.json'), sha256: 'a'.repeat(64),
    intent: path.join(os.tmpdir(), 'TEST-NO-WRITE-linux016-intent.json') }), /canonical readiness held/);
  assert.equal(calls, 1);
});
function harness(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linux016-publisher-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const value = fixture(), f = feedFixture(), receipt = path.join(directory, 'synthetic-only.json');
  const bytes = Buffer.from(JSON.stringify(value) + '\n'); fs.writeFileSync(receipt, bytes, { flag: 'wx' });
  const options = { receipt, sha256: q.hash(bytes), intent: path.join(directory, 'attempt.json') };
  const draft = { ...f.draft, assets: Object.entries(value.draft.assets).map(([name, p]) => ({ name, id: p.id, size: p.size,
    digest: 'sha256:' + p.sha256, state: 'uploaded', browser_download_url: `https://github.com/${q.REPO}/releases/download/v0.1.16/${name}` })) };
  const state = { writes: 0, calls: [], published: false };
  // Only the transaction algorithm is under test here, not native acceptance.
  t.mock.method(require('./publish-hub-draft.cjs'), 'checkReadiness', (version, options) => {
    assert.equal(version, '0.1.16'); assert.equal(options.platform, 'linux-x86_64');
    state.calls.push('canonical-readiness'); return value;
  });
  t.mock.method(q, 'loadQualification', (file, expected) => {
    const current = fs.readFileSync(file); assert.equal(q.hash(current), expected);
    return JSON.parse(current);
  });
  const services = {
    request: async route => { state.calls.push(route); return structuredClone(route === 'releases/latest' ? f.latest : draft); },
    readFeed: async () => Buffer.from(JSON.stringify(state.published ? [{ ...draft, draft: false }, f.latest] : [f.latest])),
    publish: async id => {
      state.writes++; assert.equal(id, value.draft.id); assert.ok(fs.existsSync(options.intent), 'Durable exclusive intent must precede PATCH');
      const i = JSON.parse(fs.readFileSync(options.intent)); assert.equal(i.makeLatest, false); assert.equal(i.releaseReady, false);
      state.published = true; return { ...draft, draft: false };
    },
  };
  t.mock.method(q, 'verifyRemote', async v => { assert.equal(v.version, '0.1.16'); state.calls.push('full-qualification'); return { ready: false }; });
  return { value, f, options, draft, state, services };
}
test('one mocked publish follows qualification/feed/final reread/exclusive intent; never promotes latest/readiness', async t => {
  const h = harness(t), result = await publisher.publish(h.options, h.services);
  assert.equal(h.state.writes, 1); assert.equal(result.acknowledged, true); assert.equal(result.releaseReady, false);
  assert.equal(result.publicAcceptance, false); assert.equal(result.makeLatest, false); assert.equal(result.ready, false);
  assert.deepEqual(h.state.calls.slice(0, 4), ['canonical-readiness', 'full-qualification', 'releases/latest', `releases/${h.value.draft.id}`]);
  const outcome = fs.readFileSync(h.options.intent + '.outcome.json');
  await assert.rejects(publisher.publish(h.options, h.services), /Prior attempt/); assert.equal(h.state.writes, 1);
  assert.ok(fs.readFileSync(h.options.intent + '.outcome.json').equals(outcome));
});
test('missing/failed native qualification is write-free and leaves no intent', async t => {
  const h = harness(t); q.verifyRemote.mock.mockImplementation(async () => { throw Error('missing actual portable approval'); });
  await assert.rejects(publisher.publish(h.options, h.services), /missing actual/);
  assert.equal(h.state.writes, 0); assert.equal(fs.existsSync(h.options.intent), false); assert.deepEqual(h.state.calls, ['canonical-readiness']);
});
test('Windows latest change, asset drift and full-feed overflow block before intent/PATCH', async t => {
  const h = harness(t), original = h.services.request;
  h.services.request = async route => { const r = await original(route); if (route === 'releases/latest') r.id++; return r; };
  await assert.rejects(publisher.publish(h.options, h.services)); assert.equal(fs.existsSync(h.options.intent), false);
  h.services.request = async route => { const r = await original(route); if (route !== 'releases/latest') r.assets[0].size++; return r; };
  await assert.rejects(publisher.publish(h.options, h.services)); assert.equal(h.state.writes, 0);
  h.services.request = original; h.services.readFeed = async () => Buffer.alloc(256 * 1024 + 1);
  await assert.rejects(publisher.publish(h.options, h.services), /256 KiB/); assert.equal(fs.existsSync(h.options.intent), false);
});
test('unknown PATCH outcome never retries, overwrites intent or claims acknowledgment', async t => {
  const h = harness(t); h.services.publish = async () => { h.state.writes++; throw Error('timeout'); };
  await assert.rejects(publisher.publish(h.options, h.services), /timeout/);
  const original = fs.readFileSync(h.options.intent), outcome = JSON.parse(fs.readFileSync(h.options.intent + '.outcome.json'));
  assert.equal(outcome.acknowledged, false); assert.equal(outcome.publicFeedVerified, false); assert.match(outcome.outcome, /no-retry/);
  await assert.rejects(publisher.publish(h.options, h.services), /Prior attempt/); assert.equal(h.state.writes, 1);
  assert.ok(fs.readFileSync(h.options.intent).equals(original));
});
test('post-PATCH read failure retains acknowledgment but not public/native acceptance', async t => {
  const h = harness(t), original = h.services.readFeed;
  h.services.readFeed = async () => { if (h.state.published) throw Error('visibility unknown'); return original(); };
  await assert.rejects(publisher.publish(h.options, h.services), /visibility unknown/);
  const result = JSON.parse(fs.readFileSync(h.options.intent + '.outcome.json'));
  assert.equal(result.acknowledged, true); assert.equal(result.publicFeedVerified, false); assert.equal(result.publicAcceptance, false); assert.equal(h.state.writes, 1);
});
test('receipt replacement after source review refuses without PATCH', async t => {
  const h = harness(t);
  q.verifyRemote.mock.mockImplementation(async () => { fs.appendFileSync(h.options.receipt, ' '); });
  await assert.rejects(publisher.publish(h.options, h.services)); assert.equal(h.state.writes, 0); assert.equal(fs.existsSync(h.options.intent), false);
});
test('sole default remote write is host-qualified exact-ID draft=false/make_latest=false; no tag or asset operations', () => {
  const source = fs.readFileSync(require.resolve('./publish-linux-016-hub-draft.cjs'), 'utf8');
  assert.equal((source.match(/'PATCH'/g) || []).length, 1);
  assert.match(source, /'--hostname', 'github\.com', '--method', 'PATCH'/);
  assert.match(source, /'-F', 'draft=false', '-f', 'make_latest=false'/);
  assert.doesNotMatch(source, /tag_name=|make_latest=true|release', 'create|release', 'upload|signDetached|git',/);
  assert.ok(source.indexOf('writeExclusive(options.intent, intent)') < source.indexOf("'PATCH'"));
});
test('CLI without exact explicit qualification fails before any API or mutation', () => {
  const result = spawnSync(process.execPath, [require.resolve('./publish-linux-016-hub-draft.cjs'), '0.1.17'], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Use scripts\/publish-hub-draft.cjs/);
});
