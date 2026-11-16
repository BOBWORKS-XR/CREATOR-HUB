const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION = '0.1.23';
const removedResource = /Creator-Community|community[._-](?:catalogue|catalog|projects)|community\.(?:js|css)(?:[?#]|$)|creator-plugins\.png(?:[?#]|$)/i;

function directTarget(target, source) {
  assert.equal(target, source, 'Update UI must be bound to the checked-out product version');
  return target === VERSION;
}

function assertProtocol(state, expectedVersion = VERSION) {
  assert.ok([VERSION, '0.1.24'].includes(expectedVersion), 'Only reviewed direct baselines are supported');
  assert.equal(state.version, expectedVersion, 'Direct smoke requires the exact native baseline build');
  assert.equal(state.protocol, 1, 'Native direct-feature protocol is required');
  assert.equal(state.integrated, true, 'A hosted build cannot satisfy direct acceptance');
  assert.deepEqual(state.services, { integrated: true, features: ['setup', 'mcp'] });
}

async function checkProtocol(page, expectedVersion = VERSION) {
  assertProtocol(await page.evaluate(async () => ({
    version: window.CreatorHubNative.version,
    protocol: window.__CREATOR_HUB_FEATURE_PROTOCOL__,
    integrated: window.CreatorHubNative.integratedFeatures,
    services: await window.CreatorHubNative.invoke('feature_status'),
  })), expectedVersion);
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

async function checkMcpLockedConflict(page, prefix) {
  assert.equal(await page.locator(prefix).isVisible(), true);
  assert.equal(await page.locator(`${prefix} [data-field="controls"]`).evaluate(element =>
    element.tagName === 'FIELDSET' && element.disabled === true), true);
  for (const field of ['project', 'guide']) {
    assert.equal(await page.locator(`${prefix} [data-field="${field}"]`).isEnabled(), false);
  }
  assert.equal(await page.locator(`${prefix} [data-field="error"]`).isVisible(), false);
  assert.equal(await page.locator(`${prefix} [data-field="product-panel"]`).isVisible(), true);
  assert.equal(await page.locator(`${prefix} [data-field="product-status"]`).textContent(),
    'Current and older MCP settings differ. Both originals are kept. Review before loading this form.');
  assert.equal(await page.locator(`${prefix} [data-field="product-review"]`).isEnabled(), true);
}

async function checkPages({ page, showApp, processes, requests, screenshot, expectedMcpConflict = false, verifyFixture, expectedVersion = VERSION }) {
  assert.equal(typeof expectedMcpConflict, 'boolean');
  if (expectedMcpConflict) assert.equal(typeof verifyFixture, 'function');
  await checkProtocol(page, expectedVersion);
  const services = {};
  for (const feature of ['setup', 'mcp']) {
    await showApp(feature);
    const prefix = `#feature-${feature}`;
    if (feature === 'mcp' && expectedMcpConflict) {
      await page.waitForFunction(selector => {
        const root = document.querySelector(selector);
        return root && !root.hidden && root.getAttribute('aria-busy') === 'false'
          && root.querySelector('[data-field="status"]')?.textContent === 'Review saved settings';
      }, prefix, { timeout: 90000 });
      await checkMcpLockedConflict(page, prefix);
      assert.deepEqual(processes(), [], 'Direct navigation must not launch either private module GUI');
      await checkCleanDocument(page, requests);
      verifyFixture();
      services.mcp = { state: 'saved-settings-conflict-locked', serviceCallTested: false, reviewApproved: false };
      await screenshot(feature);
      continue;
    }
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

async function deferFixtureMigration({ page, readStatus, verifyFixture }) {
  await page.locator('#convergence-dialog').waitFor({ state: 'visible', timeout: 180000 });
  const state = await readStatus();
  assert.equal(state.stage, 'review'); assert.equal(state.required, true); assert.deepEqual(state.backups, []);
  verifyFixture();
  await page.locator('#convergence-later').click();
  await page.locator('#convergence-dialog').waitFor({ state: 'hidden' });
  await page.locator('#convergence-reopen').waitFor({ state: 'visible' });
  verifyFixture();
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

function readEvidence(file) {
  assert.ok(path.isAbsolute(file), 'Evidence requires an absolute path');
  assert.ok(!file.split(/[\\/]/).includes('..'), 'Ambiguous evidence path refused');
  for (let current = file; ; current = path.dirname(current)) {
    assert.equal(fs.lstatSync(current).isSymbolicLink(), false, 'Linked evidence path refused');
    if (path.dirname(current) === current) break;
  }
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 2 * 1024 * 1024, 'Bounded regular evidence required');
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.length, stat.size, 'Evidence changed while reading');
  return bytes;
}

function physicalSettingsPath(file) {
  readEvidence(file);
  return stripVerbatim(fs.realpathSync.native(file));
}

function stripVerbatim(file) {
  return file.startsWith('\\\\?\\UNC\\') ? '\\\\' + file.slice(8)
    : file.startsWith('\\\\?\\') ? file.slice(4) : file;
}

const evidenceHash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sameWindowsPath = (left, right) => assert.equal(
  path.win32.normalize(stripVerbatim(left)).toLowerCase(), path.win32.normalize(stripVerbatim(right)).toLowerCase());

function reviewedSettings(source, base) {
  assert.ok(path.isAbsolute(base));
  const physical = physicalSettingsPath(source);
  return { source: physical, path: path.join(base, 'settings-views', evidenceHash(physical), 'launcher-config.json'),
    bytes: readEvidence(source) };
}

// serde_json's default map order is lexical; this is settings provenance, not runtime generation identity.
function settingsCanonical(value) {
  if (Array.isArray(value)) return value.map(settingsCanonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, settingsCanonical(value[key])]));
  return value;
}

function assertSettingsView(review) {
  assert.ok(readEvidence(review.source).equals(review.bytes), 'Reviewed source settings changed');
  const viewBytes = readEvidence(review.path), view = JSON.parse(viewBytes);
  const record = view._creator_hub_view;
  delete view._creator_hub_view;
  assert.deepEqual(view, JSON.parse(review.bytes), 'Settings view differs from reviewed source');
  assert.deepEqual(record, { source: review.source, sha256: evidenceHash(JSON.stringify(settingsCanonical(view))) });
  return { file: review.path, bytes: viewBytes.length, sha256: evidenceHash(viewBytes), source: review.source };
}

function assertClientBytes({ selectedPath, oldClientPath, selectedBefore, oldClientBefore }) {
  assert.ok(readEvidence(selectedPath).equals(selectedBefore), 'Selected client changed without approval');
  assert.ok(readEvidence(oldClientPath).equals(oldClientBefore), 'Unselected old client changed');
}

async function reviewExistingClaude(page, { choose, verifyBeforeApproval }) {
  verifyBeforeApproval();
  const pending = page.evaluate(async () => {
    const call = (command, args = {}) => window.CreatorHubNative.invoke('feature_call', { feature: 'mcp', command, args });
    const id = await call('begin_ui_operation');
    try { return await call('review_existing_client_connections', { clients: ['claude'] }); }
    finally { await call('finish_ui_operation', { id }); }
  }).then(value => ({ value }), error => ({ error }));
  await choose();
  const result = await pending;
  if (result.error) throw result.error;
  return result.value;
}

async function migrateExistingClaude(page, { choose, verifyBeforeApproval, captureCancelled }) {
  const cancelled = await reviewExistingClaude(page, {
    verifyBeforeApproval, choose: () => choose('Keep existing'),
  });
  assert.deepEqual(cancelled, { status: 'cancelled', count: 0 });
  verifyBeforeApproval();
  await captureCancelled();
  const approved = await reviewExistingClaude(page, {
    verifyBeforeApproval, choose: () => choose('Move selected connections'),
  });
  assert.equal(approved.status, 'migrated'); assert.equal(approved.count, 1);
  assert.ok(path.win32.isAbsolute(approved.journal || ''));
  return { cancelled, approved };
}

function assertMigrationEvidence({ result, local, selectedPath, before, after }) {
  assert.deepEqual(Object.keys(result).sort(), ['count', 'journal', 'status']);
  assert.equal(result.status, 'migrated'); assert.equal(result.count, 1);
  assert.ok(path.win32.isAbsolute(result.journal));
  const journal = stripVerbatim(result.journal), id = path.basename(journal);
  assert.match(id, /^[a-f0-9]{64}$/);
  sameWindowsPath(path.dirname(journal), path.join(local, 'creator-hub/client-migrations-v1'));
  const files = [];
  const read = name => {
    const file = path.join(journal, name), bytes = readEvidence(file);
    files.push({ file, bytes: bytes.length, sha256: evidenceHash(bytes) });
    return bytes;
  };
  const pendingBytes = read('pending.json'), pending = JSON.parse(pendingBytes);
  assert.equal(evidenceHash(pendingBytes), id, 'Journal identity differs from its reviewed transaction');
  assert.ok(read('completed.json').equals(pendingBytes), 'Completed transaction must match pending evidence');
  assert.equal(pending.files?.length, 1);
  assert.deepEqual(pending, { schema: 1, files: [{ client: 'Claude Code', path: pending.files[0].path,
    before_sha256: evidenceHash(before), after_sha256: evidenceHash(after) }] });
  sameWindowsPath(pending.files[0].path, physicalSettingsPath(selectedPath));
  assert.ok(read('0.before.bin').equals(before), 'Native before-image differs');
  assert.ok(read('0.after.bin').equals(after), 'Native after-image differs');
  assert.deepEqual(JSON.parse(read('0.intent.json')), { schema: 1,
    before_sha256: evidenceHash(before), after_sha256: evidenceHash(after) });
  assert.deepEqual(JSON.parse(read('0.native.json')), { schema: 1, success: true, error: null });
  assert.deepEqual(JSON.parse(read('0.outcome.json')), { schema: 1, status: 'Applied', native_error: null });
  const backup = path.join(path.dirname(selectedPath), '.creator-hub-settings-backups',
    `${path.basename(selectedPath)}.${evidenceHash(before)}.bak`);
  const capture = path.join(path.dirname(selectedPath), `.creator-hub-migration-${id}-0`);
  for (const file of [backup, path.join(capture, 'retained.bin')]) {
    const bytes = readEvidence(file);
    assert.ok(bytes.equals(before), 'Native backup/displaced image differs from exact before bytes');
    files.push({ file, bytes: bytes.length, sha256: evidenceHash(bytes) });
  }
  for (const name of ['stage.bin', 'displaced.bin']) assert.equal(fs.existsSync(path.join(capture, name)), false);
  assert.ok(readEvidence(selectedPath).equals(after));
  return { journal, backup, files };
}

// For a parsed JSON client fixture; not a TOML parser or permission to edit clients.
function assertReviewedClientMigration({ before, after, oldClientBefore, oldClientAfter,
  oldCommand, newCommand, settingsPath, approved }) {
  assert.equal(approved, true, 'A native review approval must precede the command change');
  assert.notEqual(oldCommand, newCommand);
  assert.ok(path.win32.isAbsolute(oldCommand) && path.win32.isAbsolute(newCommand));
  assert.ok(path.win32.isAbsolute(settingsPath));
  assert.ok(Buffer.isBuffer(oldClientBefore) && Buffer.isBuffer(oldClientAfter));
  assert.ok(oldClientBefore.equals(oldClientAfter), 'Unselected old client must remain byte-identical');
  assert.deepEqual(Object.keys(before.mcpServers).filter(id => ['creator-works', 'banter'].includes(id)), ['creator-works']);
  const entry = before.mcpServers['creator-works'];
  assert.equal(entry.command, oldCommand);
  assert.deepEqual(entry.args, []);
  assert.equal(entry.env?.CREATOR_WORKS_CONFIG_OWNER, 'creator-hub-v1');
  const expected = structuredClone(before);
  expected.mcpServers['creator-works'].command = newCommand;
  if (!Object.hasOwn(entry.env, 'CREATOR_WORKS_LAUNCHER_CONFIG')) {
    expected.mcpServers['creator-works'].env.CREATOR_WORKS_LAUNCHER_CONFIG =
      entry.env.BANTWORKS_LAUNCHER_CONFIG ?? settingsPath;
  }
  assert.deepEqual(after, expected, 'Only reviewed command and missing settings pin may change');
}

module.exports = { VERSION, directTarget, assertProtocol, checkProtocol, watchRequests, checkCleanDocument,
  checkHome, showHome, assertService, checkMcpLockedConflict, checkPages, checkRestored, deferFixtureMigration, prepareManagedRoute, settingsSnapshot,
  readEvidence, physicalSettingsPath, reviewedSettings, assertSettingsView, assertClientBytes,
  reviewExistingClaude, migrateExistingClaude, assertMigrationEvidence, assertReviewedClientMigration };
