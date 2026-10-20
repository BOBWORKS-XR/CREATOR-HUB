'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const q = require('./linux-016-release-qualification.cjs');
const feed = require('./check-linux-016-release-feed.cjs');

function writeExclusive(file, value) {
  assert.ok(typeof file === 'string' && path.isAbsolute(file), 'Explicit absolute intent/output path required');
  assert.equal(fs.realpathSync(path.dirname(file)), path.dirname(file), 'Canonical existing intent parent required');
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const fd = fs.openSync(file, 'wx', 0o600);
  try { let done = 0; while (done < bytes.length) { const n = fs.writeSync(fd, bytes, done, bytes.length - done); assert.ok(n > 0); done += n; } fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  assert.ok(fs.readFileSync(file).equals(bytes), 'Durable intent readback differs');
}
async function publish(options, overrides = {}) {
  assert.ok(options && typeof options === 'object');
  assert.match(options.sha256 || '', /^[a-f0-9]{64}$/);
  assert.ok(typeof options.receipt === 'string' && path.isAbsolute(options.receipt));
  assert.ok(typeof options.intent === 'string' && path.isAbsolute(options.intent));
  assert.ok(!fs.existsSync(options.intent) && !fs.existsSync(options.intent + '.outcome.json'), 'Prior attempt is held; inspect it, never retry/overwrite');
  const value = require('./publish-hub-draft.cjs').checkReadiness('0.1.16', {
    platform: 'linux-x86_64', receipt: options.receipt, sha256: options.sha256,
  });
  const io = q.services(overrides);
  // Retain a private immutable copy even if a supplied service mutates its input.
  const frozen = JSON.stringify(value);
  await q.verifyRemote(value, io);
  const current = async () => {
    const bytes = await io.readFeed();
    const latest = await io.request('releases/latest');
    return { bytes, latest };
  };
  let state = await current();
  // Final exact draft reread closes the preflight/write gap without rerunning a write.
  const draft = await io.request(`releases/${value.draft.id}`);
  const preflight = feed.inspectDraft(state.bytes, draft, state.latest, value);
  assert.equal(JSON.stringify(value), frozen, 'Qualification changed during preflight');
  assert.deepEqual(q.loadQualification(options.receipt, options.sha256), value, 'Reviewed receipt changed');
  const intent = { schemaVersion: 1, scope: 'publish-reviewed-linux016-draft-once', qualificationSha256: options.sha256,
    repository: q.REPO, draftId: value.draft.id, tag: 'v0.1.16', windowsLatestId: value.windows.id,
    makeLatest: false, publicAcceptance: false, releaseReady: false };
  writeExclusive(options.intent, intent);
  let acknowledged = false;
  try {
    const result = await (io.publish || (async id => JSON.parse(execFileSync('gh', ['api', '--hostname', 'github.com', '--method', 'PATCH',
      `repos/${q.REPO}/releases/${id}`, '-F', 'draft=false', '-f', 'make_latest=false'],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true }))))(value.draft.id);
    assert.equal(result.id, value.draft.id); assert.equal(result.tag_name, 'v0.1.16'); assert.equal(result.draft, false);
    acknowledged = true;
    state = await current();
    const live = feed.inspectLive(state.bytes, state.latest, value);
    const outcome = { ...intent, acknowledged, publicFeedVerified: true, ready: false };
    writeExclusive(options.intent + '.outcome.json', outcome);
    return { preflight, live, ...outcome, next: 'Exact public Linux route still requires post-publication native acceptance. Do not promote global latest.' };
  } catch (error) {
    // A timeout or a failed read after PATCH is unknown, not permission to repeat PATCH.
    try { writeExclusive(options.intent + '.outcome.json', { ...intent, acknowledged, publicFeedVerified: false,
      outcome: 'unknown-inspect-remote-state-no-retry' }); } catch { /* The original durable intent still blocks a retry. */ }
    throw error;
  }
}
module.exports = { writeExclusive, publish };
if (require.main === module) {
  console.error('Use scripts/publish-hub-draft.cjs 0.1.16 --platform linux-x86_64 with an exact reviewed receipt, sha256 and intent.');
  process.exitCode = 1;
}
