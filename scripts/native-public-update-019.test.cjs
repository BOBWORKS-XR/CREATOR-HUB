'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const direct = require('./native-public-update-direct-019.cjs');
test('public update runs only exact direct019 and rejects hosted or older product state', () => {
  assert.equal(direct.directTarget('0.1.19', '0.1.19'), true);
  assert.equal(direct.directTarget('0.1.18', '0.1.18'), false);
  assert.throws(() => direct.directTarget('0.1.19', '0.1.18'));
  const state = { version: '0.1.19', protocol: 1, integrated: true, services: { integrated: true, features: ['setup', 'mcp'] } };
  direct.assertProtocol(state);
  for (const patch of [{ version: '0.1.18' }, { protocol: 0 }, { integrated: false }, { services: { integrated: false, features: [] } }]) {
    assert.throws(() => direct.assertProtocol({ ...state, ...patch }));
  }
});
test('public runner retains native cancellation, kernel restart identity, settings and cleanup checks', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-public-update-019.cjs'), 'utf8');
  for (const text of ["process.env.CREATOR_PUBLIC_SELF_UPDATE_019 !== '1'", "kind: 'public-018-to-019'",
    'public19.observeRoot', 'public19.checkRestart', 'public19.verifyResources', 'public19.verifySdk',
    'report.settingsBefore = directSettings', 'report.settingsAfter = direct.settingsSnapshot',
    'report.cancelPreserved = true', 'report.rootCleanupVerified = true', 'report.runtimeCleanupVerified = true',
    'report.sdkConnections !== 2', 'await direct.checkHome(page);']) assert.ok(source.includes(text), text);
  assert.doesNotMatch(source.match(/async function showApps\(\)[\s\S]*?\n}/)[0], /hub-pages/);
});
test('workflow uses immutable SDK inputs and no build, proxy, authenticated asset download or publication', () => {
  const source = fs.readFileSync(path.join(__dirname, '../.github/workflows/self-update-acceptance.yml'), 'utf8');
  assert.match(source, /ref: ed3e7dabc2e83fea8b7cadce63bbeb502fed2306/);
  assert.match(source, /npm ci --prefix \.public-sdk\/modules\/mcp --ignore-scripts/);
  assert.match(source, /node scripts\/public-self-update-019.cjs prepare/);
  assert.match(source, /node scripts\/native-public-update-019.cjs/);
  assert.doesNotMatch(source, /cargo |tauri-action|gh release|GH_TOKEN|https?_proxy|NODE_TLS|promote-latest|hosted_fixture/);
});
