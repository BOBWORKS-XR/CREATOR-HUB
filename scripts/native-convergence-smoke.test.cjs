const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { admission, retainedOptions } = require('./native-convergence-smoke.cjs');

const context = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REF: 'refs/heads/validation/convergence-014', CREATOR_CONVERGENCE_NATIVE_TEST: '1' };
test('native convergence admits only the exact disposable context', () => {
  admission(context);
  for (const key of Object.keys(context)) assert.throws(() => admission({ ...context, [key]: 'foreign' }));
  assert.throws(() => admission({}));
});
test('migration comparison permits only the reviewed server field', () => {
  const before = JSON.stringify({ mcp_server_path: 'old', auto_start: false, futureOption: { keep: [1, 'two'] } });
  retainedOptions(before, before);
  retainedOptions(before, JSON.stringify({ mcp_server_path: 'new', auto_start: false, futureOption: { keep: [1, 'two'] } }));
  for (const after of [{ mcp_server_path: 'new', auto_start: true }, { mcp_server_path: 'new' },
    { mcp_server_path: 'new', auto_start: false, futureOption: { keep: [] } }]) assert.throws(() => retainedOptions(before, JSON.stringify(after)));
});
test('actual guide harness fences inspection and distinguishes flow acceptance from release', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-convergence-smoke.cjs'), 'utf8');
  assert.match(source, /async function main\(candidate\)[\s\S]*?admission\(\); requireDisposable\(\);[\s\S]*?JSON\.parse\(fs\.readFileSync/);
  for (const step of ['#convergence-prepare', '#convergence-connections', '#convergence-retire', 'Move selected connections', 'Move server path', 'Finish migration']) assert.ok(source.includes(step));
  assert.match(source, /oldClient\.listTools[\s\S]*?registrationNames\(\), \['Creator Hub'\][\s\S]*?oldClient\.listTools/);
  assert.match(source, /signedInAppUpdateAccepted: false/); assert.match(source, /liveAiAppAccepted: false/); assert.match(source, /releaseReady: false/);
  assert.doesNotMatch(source, /taskkill|\.kill\(|Stop-Process|auth\.json|process\.env\.(?:TAURI_SIGNING_PRIVATE_KEY|CREATOR_HUB_SIGNING_KEY_PATH)/);
});
