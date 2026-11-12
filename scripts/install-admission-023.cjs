'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const BRANCH = 'validation/windows-sdk-capability-fresh-023-20261112';
function admit(mode, env = process.env, platform = process.platform, target = require('./windows-outgoing-019-target.cjs')) {
  assert.equal(platform, 'win32'); assert.ok(['fresh', 'migration'].includes(mode));
  const branch = BRANCH;
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: mode,
    GITHUB_REF: `refs/heads/${branch}`, GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-install-023.yml@refs/heads/${branch}` }))
    assert.equal(env[key], value, key);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  assert.equal(env.EXPECTED_HARNESS_COMMIT, env.GITHUB_SHA);
  target.validateBinding();
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/windows-outgoing-019-binding.json'));
  assert.equal(env.EXPECTED_BINDING_SHA256, crypto.createHash('sha256').update(bytes).digest('hex'));
  for (const key of Object.keys(env)) {
    assert.ok(!/^(?:NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|ALL_PROXY|HTTP_PROXY|HTTPS_PROXY)$/i.test(key), key);
    assert.ok(!/^WEBVIEW2_/i.test(key), key);
  }
}
module.exports = { BRANCH, admit };
