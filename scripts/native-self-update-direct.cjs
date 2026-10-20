const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = '0.1.16';
const removedResource = /Creator-Community|community[._-](?:catalogue|catalog|projects)|community\.(?:js|css)(?:[?#]|$)|creator-plugins\.png(?:[?#]|$)/i;

function directTarget(target, source) {
  assert.equal(target, source, 'Update UI must be bound to the checked-out product version');
  return target === VERSION;
}

function assertProtocol(state) {
  assert.equal(state.version, VERSION, 'Direct smoke requires the exact native 0.1.16 build');
  assert.equal(state.protocol, 1, 'Native direct-feature protocol is required');
  assert.equal(state.integrated, true, 'A hosted 0.1.16 build cannot satisfy direct acceptance');
  assert.deepEqual(state.services, { integrated: true, features: ['setup', 'mcp'] });
}

async function checkProtocol(page) {
  assertProtocol(await page.evaluate(async () => ({
    version: window.CreatorHubNative.version,
    protocol: window.__CREATOR_HUB_FEATURE_PROTOCOL__,
    integrated: window.CreatorHubNative.integratedFeatures,
    services: await window.CreatorHubNative.invoke('feature_status'),
  })));
}

function watchRequests(page) {
  const requests = [];
  page.on('request', request => { if (removedResource.test(request.url()) && requests.length < 32) requests.push(request.url()); });
  return requests;
}

async function checkCleanDocument(page, requests) {
  const state = await page.evaluate(() => ({
    embedded: document.querySelectorAll('iframe,object,embed').length,
    plugins: document.querySelectorAll('[data-view="plugins"],#view-plugins,.plugins-mark,[data-community-host]').length,
    text: ['#suite-menu', '#context-help-dialog'].map(selector => document.querySelector(selector)?.textContent || '').join('\n'),
    resources: performance.getEntriesByType('resource').map(resource => resource.name),
  }));
  assert.equal(state.embedded, 0, 'Direct features must remain in the main document');
  assert.equal(page.frames().length, 1, 'A second feature frame is not direct integration');
  assert.equal(page.context().pages().length, 1, 'Direct features must not create a second webview');
  assert.equal(state.plugins, 0, 'Removed Plugins navigation/content returned');
  assert.doesNotMatch(state.text, /Creator Plugins/);
  assert.deepEqual([...requests, ...state.resources.filter(url => removedResource.test(url))], [],
    'Removed community catalogue/assets must not be requested, including before CDP attachment');
}

async function checkHome(page) {
  assert.equal(await page.locator('#view-projects').isVisible(), true, 'Direct Hub opens Projects');
  assert.equal(await page.locator('#unified-home-updater .hub-update').isVisible(), true);
  assert.equal(await page.locator('#view-hub').isVisible(), false, 'Legacy Apps is not the direct home');
  assert.equal(await page.locator('#hub-tab-apps').isVisible(), false);
  assert.equal(await page.locator('#hub-tab-projects').isVisible(), false);
}

async function showHome(page) {
  await page.locator('#suite-trigger').click();
  await page.locator('#suite-menu [data-view="hub"]').click();
  await checkHome(page);
}

function assertService(feature, value) {
  if (feature === 'mcp') {
    assert.equal(value.runtime?.ready, true, 'Native MCP must verify the retained runtime');
    assert.equal(value.runtime?.bundled, true, 'System Node is not the signed retained runtime');
    assert.equal(typeof value.managedRouting, 'boolean');
    assert.ok(Array.isArray(value.clients) && value.clients.some(client => client.id === 'codex'));
    assert.equal(value.project, null, 'Read-only service proof must not select or create a project');
  } else {
    assert.equal(feature, 'setup');
    assert.equal(value.platform, 'windows');
    assert.ok(Array.isArray(value.editors) && Array.isArray(value.blockers));
    for (const field of ['editorVersion', 'creatorSdkVersion', 'urpVersion']) {
      assert.ok(typeof value.recipe?.[field] === 'string' && value.recipe[field].length > 0);
    }
  }
}

async function checkPages({ page, showApp, processes, requests, screenshot }) {
  await checkProtocol(page);
  const services = {};
  for (const feature of ['setup', 'mcp']) {
    await showApp(feature);
    const prefix = `#feature-${feature}`;
    await page.waitForFunction(selector => {
      const root = document.querySelector(selector);
      return root && !root.hidden && root.getAttribute('aria-busy') === 'false'
        && root.querySelector('[data-field="status"]')?.textContent === 'Ready';
    }, prefix, { timeout: 90000 });
    assert.equal(await page.locator(prefix).isVisible(), true);
    assert.equal(await page.locator(`${prefix} [data-field="controls"]`).isEnabled(), true);
    assert.equal(await page.locator(`${prefix} [data-field="error"]`).isVisible(), false);
    if (feature === 'mcp' && await page.locator(`${prefix} [data-field="guide-dialog"]`).isVisible()) {
      await page.locator(`${prefix} [data-field="guide-start"]`).click(); // No guide preference write.
    }
    const command = feature === 'mcp' ? 'get_onboarding_status' : 'probe_environment';
    services[feature] = await page.evaluate(({ feature, command }) => window.CreatorHubNative.invoke('feature_call', {
      feature, command, args: feature === 'mcp' ? { unityProjectPath: null } : {},
    }), { feature, command });
    assertService(feature, services[feature]);
    assert.deepEqual(processes(), [], 'Direct navigation must not launch either private module GUI');
    await checkCleanDocument(page, requests);
    await screenshot(feature);
  }
  const draft = 'Direct Hub navigation retains this unsaved draft';
  await showApp('setup');
  await page.locator('#feature-setup [data-field="name"]').fill(draft);
  await showApp('mcp');
  await showApp('setup');
  assert.equal(await page.locator('#feature-setup [data-field="name"]').inputValue(), draft);
  await showHome(page);
  return services;
}

async function checkRestored(page) {
  await page.waitForFunction(() => document.querySelector('#hosted-restore-message')?.textContent === 'Your Hub page has been restored.');
  assert.deepEqual(await page.evaluate(() => window.CreatorHubNative.invoke('pending_hosted_restore')), []);
  assert.equal(await page.locator('#view-native-features').isVisible(), true, 'Old restoration tickets must select a direct tool');
}

async function prepareManagedRoute(page, { clientConfig, active, approve }) {
  assert.equal(fs.existsSync(clientConfig), false, 'Route smoke requires absent Codex settings; migration needs its own reviewed fixture');
  const needsConsent = !fs.existsSync(active);
  // Use the real guarded batch-review service, not a GUI entrypoint or a route bypass.
  const pending = page.evaluate(async () => {
    const call = (command, args = {}) => window.CreatorHubNative.invoke('feature_call', { feature: 'mcp', command, args });
    const id = await call('begin_ui_operation');
    try { return await call('review_existing_client_connections', { clients: ['codex'] }); }
    finally { await call('finish_ui_operation', { id }); }
  }).then(value => ({ value }), error => ({ error }));
  if (needsConsent) await approve();
  const result = await pending;
  if (result.error) throw result.error;
  assert.deepEqual(result.value, { status: 'unchanged', count: 0 }, 'No client migration is authorized by this smoke');
  assert.equal(fs.existsSync(clientConfig), false, 'Empty client review must not create client settings');
  assert.equal(fs.existsSync(active), true, 'Native signed route activation must finish before SDK reconnect');
  const status = await page.evaluate(() => window.CreatorHubNative.invoke('feature_call', {
    feature: 'mcp', command: 'get_onboarding_status', args: { unityProjectPath: null },
  }));
  assertService('mcp', status);
  assert.equal(status.managedRouting, true, 'Native internal service must bind the approved managed route');
  return status;
}

function settingsSnapshot(roaming, local) {
  assert.ok(path.isAbsolute(roaming) && path.isAbsolute(local));
  return ['creator-works-mcp/launcher-config.json', 'banter-mcp/launcher-config.json', 'CreatorProjectSetup/editor-roots.json'].map((name, index) => {
    const file = path.join(index === 2 ? local : roaming, name);
    if (!fs.existsSync(file)) return { name, sha256: null };
    assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink());
    return { name, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  });
}

module.exports = { VERSION, directTarget, assertProtocol, checkProtocol, watchRequests, checkCleanDocument,
  checkHome, showHome, assertService, checkPages, checkRestored, prepareManagedRoute, settingsSnapshot };
