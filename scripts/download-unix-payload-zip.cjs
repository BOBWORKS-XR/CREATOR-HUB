const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { collect, json } = require('./collect-unix-payload-binding.cjs');
const { REPOSITORY } = require('./unix-payload-binding.cjs');

function download(proof, output, execute = execFileSync) {
  assert.equal(proof.downloadedZipVerified, false);
  assert.equal(proof.releaseReady, false);
  const pin = require('./unix-payload-binding.cjs').validateBinding(proof.binding);
  assert.ok(path.isAbsolute(output) && output.endsWith('.zip'));
  output = path.resolve(output);
  assert.equal(fs.realpathSync(path.dirname(output)), path.dirname(output), 'Unredirected output required');
  assert.equal(fs.existsSync(output), false, 'Never replace downloaded evidence');
  const bytes = execute('gh', ['api', `repos/${REPOSITORY}/actions/artifacts/${pin.artifactId}/zip`], {
    encoding: null, timeout: 180000, maxBuffer: pin.zipBytes + 1, windowsHide: true,
  });
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(bytes.length, pin.zipBytes, 'Downloaded archive size differs');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), pin.zipSha256, 'Downloaded archive hash differs');
  fs.writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 });
  return { target: pin.target, artifactId: pin.artifactId, zipSha256: pin.zipSha256,
    downloadedZipVerified: true, transferContentsVerified: false, releaseReady: false };
}

module.exports = { download };
if (require.main === module) {
  try {
    assert.equal(process.argv.length, 5, 'Use INDEPENDENT-PINS-JSON PREPARED-UNIX-JSON NEW-ZIP');
    assert.ok(process.argv.slice(2).every(file => path.isAbsolute(file)));
    const [pins, prepared, output] = process.argv.slice(2).map(file => path.resolve(file));
    // Reacquire live provenance before downloading; a saved proof is not fresh API evidence.
    console.log(JSON.stringify(download(collect(json(pins), prepared), output)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
