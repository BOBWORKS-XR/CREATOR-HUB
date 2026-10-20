const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { fixture } = require('./fixtures/unix-payload-binding.cjs');
const { download } = require('./download-unix-payload-zip.cjs');

function input(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'creator-pinned-download-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('Synthetic archive bytes, never extracted or executed.');
  const binding = fixture();
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  binding.expected.zipSha256 = sha; binding.artifact.digest = `sha256:${sha}`;
  binding.artifact.size_in_bytes = bytes.length;
  return { output: path.join(root, 'input.zip'), bytes,
    proof: { binding, downloadedZipVerified: false, releaseReady: false } };
}

test('download matches exact API-bound binary bytes without claiming transfer or release acceptance', t => {
  const f = input(t);
  const result = download(f.proof, f.output, (command, args, options) => {
    assert.equal(command, 'gh');
    assert.deepEqual(args, ['api', 'repos/BOBWORKS-XR/CREATOR-HUB/actions/artifacts/202/zip']);
    assert.equal(options.encoding, null); assert.equal(options.maxBuffer, f.bytes.length + 1);
    return f.bytes;
  });
  assert.deepEqual(fs.readFileSync(f.output), f.bytes);
  assert.equal(result.downloadedZipVerified, true);
  assert.equal(result.transferContentsVerified, false); assert.equal(result.releaseReady, false);
  assert.throws(() => download(f.proof, f.output, () => assert.fail('No request')), /Never replace/);
});

test('wrong length or same-length wrong hash cannot create accepted output', t => {
  const f = input(t);
  for (const bytes of [Buffer.concat([f.bytes, Buffer.from('extra')]), Buffer.alloc(f.bytes.length, 0)]) {
    assert.throws(() => download(f.proof, f.output, () => bytes), /differs/);
    assert.equal(fs.existsSync(f.output), false);
  }
});

test('stale or foreign provenance refuses before network use', t => {
  const f = input(t); f.proof.binding.run.conclusion = 'failure';
  assert.throws(() => download(f.proof, f.output, () => assert.fail('No request')));
  assert.equal(fs.existsSync(f.output), false);
});
