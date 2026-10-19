// Public build metadata only. Downloaded archive verification/signing is separate.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { TARGETS, REPOSITORY, validatePrepared, validateBinding } = require('./unix-payload-binding.cjs');
const { snapshot } = require('./unix-managed-payload.cjs');

function json(file) {
  assert.ok(path.isAbsolute(file), 'Use absolute metadata paths');
  file = path.resolve(file);
  const metadata = fs.lstatSync(file);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= 128 * 1024);
  const captured = snapshot(file, path.dirname(file), 0o644, false);
  const bytes = fs.readFileSync(file);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), captured.sha256, 'Metadata changed after capture');
  const value = JSON.parse(bytes);
  assert.equal(bytes.toString('utf8').trim(), JSON.stringify(value, null, 2), 'Metadata must use canonical emitted JSON without duplicate keys');
  return value;
}
function api(route) {
  return JSON.parse(execFileSync('gh', ['api', `repos/${REPOSITORY}/${route}`], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  }));
}
function collect(expected, preparedFile, request = api) {
  assert.ok(Object.hasOwn(TARGETS, expected.target), 'Unknown target');
  assert.ok(expected.version === '0.1.14' || expected.version === '0.1.16' && expected.target === 'linux', 'Only finite native payload targets are admitted');
  assert.match(expected.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(expected.zipSha256, /^[a-f0-9]{64}$/);
  for (const value of [expected.runId, expected.runAttempt, expected.artifactId]) assert.ok(Number.isSafeInteger(value) && value > 0);
  assert.equal(path.basename(preparedFile), 'prepared-unix.json');
  const prepared = json(preparedFile);
  validatePrepared(prepared, TARGETS[expected.target], expected.version);
  const binding = { expected, prepared,
    run: request(`actions/runs/${expected.runId}`),
    artifact: request(`actions/artifacts/${expected.artifactId}`),
    commit: request(`git/commits/${expected.sourceCommit}`) };
  const response = request(`actions/runs/${expected.runId}/attempts/${expected.runAttempt}/jobs?per_page=100`);
  assert.ok(Array.isArray(response.jobs) && response.jobs.length <= 20 && response.total_count === response.jobs.length,
    'Incomplete or oversized native-job listing');
  binding.jobs = response.jobs;
  return { binding, verified: validateBinding(binding), downloadedZipVerified: false, releaseReady: false };
}

module.exports = { collect, json };
if (require.main === module) {
  try {
    assert.equal(process.argv.length, 5, 'Use INDEPENDENT-PINS-JSON PREPARED-UNIX-JSON NEW-BINDING-JSON');
    const paths = process.argv.slice(2);
    assert.ok(paths.every(file => path.isAbsolute(file)), 'Use absolute metadata paths');
    const [pins, prepared, output] = paths.map(file => path.resolve(file));
    assert.ok(path.isAbsolute(output) && fs.realpathSync(path.dirname(output)) === path.dirname(output));
    assert.equal(fs.existsSync(output), false, 'Binding evidence is immutable');
    const result = collect(json(pins), prepared);
    fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ target: result.verified.target, runId: result.verified.runId,
      artifactId: result.verified.artifactId, sourceCommit: result.verified.sourceCommit,
      downloadedZipVerified: false, releaseReady: false }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
