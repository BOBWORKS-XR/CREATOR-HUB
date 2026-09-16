const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

async function load(page, launchView = 'hub', options = {}) {
  await page.addInitScript(({ launchView, options }) => {
    for (const [key, value] of Object.entries(options.preferences || {})) localStorage.setItem(key, value);
    if (options.storageUnavailable) Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage disabled', 'SecurityError'); } });
    window.calls = [];
    window.events = {};
    window.hubUpdate = { currentVersion: '0.1.0-alpha.3', availableVersion: null, downloaded: false };
    window.inventory = { supported: true, apps: ['mcp', 'setup'].map(app => ({ app, installed: false, trusted: false, availableVersion: app === 'mcp' ? '2.6.0' : '0.2.2', downloaded: false, issue: null, installerInteractive: true })) };
    if (options.updateAvailable) Object.assign(window.inventory.apps[0], { installed: true, trusted: true, installedVersion: '2.5.0', updateAvailable: true });
    if (options.blockers) window.inventory.apps[0].updateBlockers = options.blockers;
    window.__TAURI__ = { event: { listen: async (name, handler) => { window.events[name] = handler; return () => {}; } }, core: { invoke: async (command, args) => {
      window.calls.push({ command, args });
      if (command === 'get_launch_request') return { view: launchView, revision: 0 };
      if (command === 'project_inventory') return { projects: [], warnings: [] };
      if (command === 'community_catalogue') return { entries: [], warnings: [], stale: false };
      if (command === 'app_inventory') {
        if (window.failInventory) throw window.failInventory;
        if (window.holdInventory) return new Promise(resolve => { window.finishInventory = () => resolve(window.inventory); });
        return window.inventory;
      }
      if (command === 'hub_update_status') return window.hubUpdate;
      if (command === 'download_hub_update') { window.hubUpdate.downloaded = true; return 'Hub update downloaded.'; }
      if (window.failOpen) throw 'Browser is unavailable.';
      if (window.failAction) throw window.failAction;
      if (command === 'disconnect_mcp') {
        if (window.holdDisconnect) await new Promise(resolve => { window.finishDisconnect = resolve; });
        if (window.afterDisconnect) Object.assign(window.inventory.apps[0], window.afterDisconnect);
        if (window.failAfterDisconnect) window.failInventory = 'Process inventory unavailable.';
      }
      if (window.holdAction && ['download_app', 'install_app'].includes(command)) return new Promise(resolve => { window.finishAction = resolve; });
      return 'Operation complete.';
    } } };
  }, { launchView, options });
  await page.goto('http://127.0.0.1:4188');
  await expect.poll(() => page.evaluate(() => window.calls.some(c => c.command === 'app_inventory' && c.args.check))).toBe(true);
  await expect(page.locator('#catalog-status')).toHaveText(/^(Update check complete\. Installation always needs your approval\.|Installed apps checked\.)$/);
  if (launchView === 'hub') await page.locator('#hub-pages [data-view="hub"]').click();
}

for (const app of ['mcp', 'setup']) for (const width of [940, 390, 320]) test(`Apps row updates ${app} without opening its view at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 780 });
  await load(page, 'hub', { preferences: { 'creator-hub.auto-download': 'false' } });
  await page.evaluate(app => {
    Object.assign(window.inventory.apps.find(item => item.app === app), { installed: true, trusted: true, installedVersion: '0.0.1', updateAvailable: true });
    document.querySelector('#close-running').checked = true;
    document.querySelector('#reopen-app').checked = true;
  }, app);
  await page.locator('#check-updates').click();
  const update = page.locator(`#update-${app}`);
  await expect(update).toBeVisible(); await expect(update).toBeEnabled();
  const entry = page.locator(`#entry-${app}`);
  expect(await entry.locator('button button').count()).toBe(0);
  const buttonBox = await update.boundingBox(), openBox = await entry.locator('.app-row').boundingBox();
  expect(buttonBox.x >= openBox.x + openBox.width || buttonBox.y >= openBox.y + openBox.height).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('apps-update.png'), fullPage: true });
  await page.evaluate(() => { window.calls = []; window.holdAction = true; });
  await update.click();
  await expect(update).toBeDisabled();
  await expect(page.locator('#view-hub')).toBeVisible(); await expect(page.locator('#view-detail')).toBeHidden();
  expect(await page.evaluate(() => window.calls)).toEqual([{ command: 'install_app', args: { app, version: app === 'mcp' ? '2.6.0' : '0.2.2', reopen: false, closeRunning: false } }]);
  await page.evaluate(() => window.finishAction('Installation cancelled. Nothing was installed.'));
  await expect(update).toBeEnabled();
});

test('Apps row exposes blockers and routes minimum-version updates to Hub without installing', async ({ page }) => {
  await load(page, 'hub', { updateAvailable: true, preferences: { 'creator-hub.auto-download': 'false' }, blockers: [{ name: 'node.exe', kind: 'connection', pid: 45 }] });
  await expect(page.locator('#update-mcp')).toBeEnabled();
  await expect(page.locator('#update-reason-mcp')).toContainText('Disconnect and update');
  await page.evaluate(() => Object.assign(window.inventory.apps[0], { updateBlockers: [], requiredHubVersion: '9.0.0', installBlocked: 'Update Creator Hub to 9.0.0 first.' }));
  await page.locator('#check-updates').click();
  await expect(page.locator('#update-mcp')).toBeEnabled();
  await expect(page.locator('#update-mcp')).toContainText('Update Hub first');
  await page.evaluate(() => window.calls = []);
  await page.locator('#update-mcp').click();
  await expect(page.locator('#hub-update-title')).toBeFocused();
  await expect(page.locator('#view-hub')).toBeVisible();
  expect(await page.evaluate(() => window.calls.some(c => ['install_app', 'start_hosted_app', 'stop_hosted_app', 'open_resource'].includes(c.command)))).toBe(false);
});

test('Apps row hides updates for current or missing apps and refuses unknown installations', async ({ page }) => {
  await load(page, 'hub', { preferences: { 'creator-hub.auto-download': 'false' } });
  await expect(page.locator('#update-mcp')).toBeHidden();
  await expect(page.locator('#update-setup')).toBeHidden();
  await page.evaluate(() => Object.assign(window.inventory.apps[0], { installed: true, trusted: false, updateAvailable: true, issue: 'Unrecognized app copy. No files will be replaced.' }));
  await page.locator('#check-updates').click();
  await expect(page.locator('#update-mcp')).toBeDisabled();
  await expect(page.locator('#update-reason-mcp')).toContainText('Unrecognized app copy');
  expect(await page.evaluate(() => window.calls.some(c => c.command === 'install_app'))).toBe(false);
});

for (const view of ['hub', 'mcp']) test(`MCP disconnect on ${view} confirms separately and never starts an update`, async ({ page }) => {
  await load(page, view, { updateAvailable: true, preferences: { 'creator-hub.auto-download': 'false' },
    blockers: [{ name: 'node.exe', kind: 'connection', pid: 45 }] });
  const button = page.locator(view === 'hub' ? '#disconnect-mcp-row' : '#disconnect-mcp-detail');
  await expect(button).toBeVisible();
  await page.evaluate(() => { window.calls = []; window.failAction = 'MCP disconnect cancelled. No connections were closed.'; });
  await button.click();
  await expect(button).toBeEnabled();
  await expect(page.locator(view === 'hub' ? '#update-mcp' : '#release-button')).toBeEnabled();
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'disconnect_mcp').length)).toBe(1);
  expect(await page.evaluate(() => window.calls.some(c => c.command === 'install_app'))).toBe(false);
  await page.evaluate(() => { window.calls = []; window.failAction = null; window.inventory.apps[0].updateBlockers = []; });
  await button.click();
  await expect(button).toBeHidden();
  await expect(page.locator(view === 'hub' ? '#update-mcp' : '#release-button')).toBeEnabled();
  expect(await page.evaluate(() => window.calls.map(c => c.command))).toEqual(['disconnect_mcp', 'app_inventory', 'hub_update_status']);
});

test('MCP cleanup is not offered for unverified or merely possible connections', async ({ page }) => {
  await load(page, 'mcp', { updateAvailable: true, blockers: [{ name: 'node.exe', kind: 'possibleConnection', pid: 45 }] });
  await expect(page.locator('#disconnect-mcp-detail')).toBeHidden();
  await page.evaluate(() => { window.inventory.apps[0].trusted = false; window.inventory.apps[0].updateBlockers = [{ kind: 'connection', pid: 45 }]; });
  await page.locator('#recheck-app').click();
  await expect(page.locator('#disconnect-mcp-detail')).toBeHidden();
  expect(await page.evaluate(() => window.calls.some(c => c.command === 'disconnect_mcp'))).toBe(false);
});

for (const view of ['hub', 'mcp']) test(`${view} update confirms MCP disconnect, rechecks, then installs exactly once`, async ({ page }) => {
  await load(page, view, { updateAvailable: true, preferences: { 'creator-hub.auto-download': 'false' },
    blockers: [{ name: 'node.exe', kind: 'connection', pid: 45 }, { name: 'node.exe', kind: 'connection', pid: 46 }] });
  const update = page.locator(view === 'hub' ? '#update-mcp' : '#release-button');
  await expect(update).toBeEnabled();
  await expect(update).toContainText('Disconnect and update');
  await page.evaluate(() => { window.calls = []; window.holdDisconnect = true; window.afterDisconnect = { updateBlockers: [] }; });
  await update.click();
  await expect(update).toBeDisabled();
  await expect(page.locator('#progress-message')).toContainText('Waiting for permission');
  await update.dispatchEvent('click');
  expect(await page.evaluate(() => window.calls.map(call => call.command))).toEqual(['disconnect_mcp']);
  await page.evaluate(() => window.finishDisconnect());
  await expect(page.locator('#check-updates')).toBeEnabled();
  expect(await page.evaluate(() => window.calls.map(call => call.command))).toEqual([
    'disconnect_mcp', 'app_inventory', 'install_app', 'app_inventory', 'hub_update_status',
  ]);
  expect(await page.evaluate(() => window.calls.find(call => call.command === 'install_app').args)).toEqual({
    app: 'mcp', version: '2.6.0', reopen: view === 'mcp', closeRunning: false,
  });
});

for (const view of ['hub', 'mcp']) test(`${view} update cancellation never starts installation and permits retry`, async ({ page }) => {
  await load(page, view, { updateAvailable: true, preferences: { 'creator-hub.auto-download': 'false' },
    blockers: [{ name: 'node.exe', kind: 'connection', pid: 45 }] });
  const update = page.locator(view === 'hub' ? '#update-mcp' : '#release-button');
  await page.evaluate(() => { window.calls = []; window.failAction = 'MCP disconnect cancelled. No connections were closed.'; });
  await update.click();
  await expect(page.locator('#action-error')).toContainText('No connections were closed');
  await expect(page.locator('#operation-progress')).toBeHidden();
  await expect(update).toBeEnabled();
  expect(await page.evaluate(() => window.calls.filter(call => call.command === 'install_app'))).toEqual([]);
  await page.evaluate(() => { window.calls = []; window.failAction = null; window.afterDisconnect = { updateBlockers: [] }; });
  await update.click();
  await expect.poll(() => page.evaluate(() => window.calls.filter(call => call.command === 'install_app').length)).toBe(1);
});

for (const [name, change] of Object.entries({
  'reconnecting client': { updateBlockers: [{ kind: 'connection', name: 'node.exe', pid: 99 }] },
  'unknown process': { updateBlockers: [{ kind: 'possibleConnection', name: 'node.exe', pid: 99 }] },
  'unverified copy': { trusted: false, updateBlockers: [] },
  'changed version': { availableVersion: '9.0.0', updateBlockers: [] },
  'blocked release': { installBlocked: 'Blocked', updateBlockers: [] },
  'no longer installed': { installed: false, updateBlockers: [] },
  'already updated': { updateAvailable: false, updateBlockers: [] },
})) test(`post-disconnect ${name} prevents installation without repeated cleanup`, async ({ page }) => {
  await load(page, 'hub', { updateAvailable: true, preferences: { 'creator-hub.auto-download': 'false' },
    blockers: [{ name: 'node.exe', kind: 'connection', pid: 45 }] });
  await page.evaluate(change => { window.calls = []; window.afterDisconnect = change; }, change);
  await page.locator('#update-mcp').click();
  await expect(page.locator('#action-error')).toContainText('Update not started');
  await expect(page.locator('#operation-progress')).toBeHidden();
  expect(await page.evaluate(() => window.calls.filter(call => call.command === 'disconnect_mcp').length)).toBe(1);
  expect(await page.evaluate(() => window.calls.some(call => call.command === 'install_app'))).toBe(false);
});

test('failed post-disconnect inventory prevents installation and keeps the error visible', async ({ page }) => {
  await load(page, 'hub', { updateAvailable: true, preferences: { 'creator-hub.auto-download': 'false' },
    blockers: [{ name: 'node.exe', kind: 'connection', pid: 45 }] });
  await page.evaluate(() => { window.calls = []; window.failAfterDisconnect = true; });
  await page.locator('#update-mcp').click();
  await expect(page.locator('#action-error')).toContainText('Process inventory unavailable');
  await expect(page.locator('#update-mcp')).toBeDisabled();
  expect(await page.evaluate(() => window.calls.some(call => call.command === 'install_app'))).toBe(false);
});

for (const width of [940, 560, 320]) test(`MCP update and disconnect are visible buttons at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 800 });
  await load(page, 'hub', { updateAvailable: true, preferences: { 'creator-hub.auto-download': 'false' },
    blockers: [{ name: 'node.exe', kind: 'connection', pid: 45 }] });
  await expect(page.locator('#update-mcp')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Disconnect and update: Creator Works MCP', exact: true })).toBeVisible();
  const disconnect = page.locator('#disconnect-mcp-row');
  await expect(disconnect).toHaveCSS('border-top-width', '1px');
  expect((await disconnect.boundingBox()).height).toBeGreaterThanOrEqual(40);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mcp-disconnect-update.png'), fullPage: true });
});

for (const width of [940, 560, 320]) test(`upgrade blockers are actionable, client-agnostic and safe to recheck at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 700 });
  await load(page, 'mcp', { updateAvailable: true, preferences: { 'creator-hub.auto-download': 'false' }, blockers: [
    { pid: 40, name: 'node.exe', executable: 'C:\\Apps\\Creator Works MCP\\server\\runtime\\node.exe', kind: 'connection', parent: { pid: 41, name: 'claude.exe', executable: 'C:\\Apps\\' + 'LongName'.repeat(20) + '\\claude.exe' } },
    { pid: 50, name: 'node.exe', executable: 'C:\\Apps\\node.exe', kind: 'possibleConnection', parent: null },
  ] });
  await expect(page.locator('#release-button')).toBeDisabled();
  await expect(page.locator('#open-button')).toBeEnabled();
  await expect(page.locator('#update-blockers-help')).toContainText('will not force-close');
  await expect(page.locator('#update-blockers-help')).toContainText('Disconnect MCP only');
  await expect(page.locator('#update-blockers-help')).toContainText('Do not end unfamiliar tasks');
  await page.locator('#update-blockers-details summary').click();
  await expect(page.locator('#update-blockers-list')).toContainText('claude.exe (PID 41)');
  await expect(page.locator('#update-blockers-list')).toContainText('Starting app could not be identified');
  await expect(page.locator('#update-blockers-list')).toContainText('Possible MCP connection');
  await page.locator('#recheck-app').click();
  await expect(page.locator('#update-blockers')).toBeVisible();
  await expect(page.locator('#release-button')).toBeDisabled();
  await expect(page.locator('#update-blockers-help')).toContainText('pause or disable this MCP');
  expect(await page.locator('#update-blockers-list').innerText()).not.toContain('Codex');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('upgrade-blockers.png'), fullPage: true });
  await page.evaluate(() => { window.calls = []; window.holdInventory = true; });
  await page.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(page.locator('#recheck-app')).toBeDisabled();
  await expect(page.locator('#release-button')).toBeDisabled();
  await page.evaluate(() => { window.inventory.apps[0].updateBlockers = []; window.finishInventory(); });
  await expect(page.locator('#update-blockers')).toBeHidden();
  await expect(page.locator('#release-button')).toBeEnabled();
  await expect(page.locator('#release-button')).toBeFocused();
  expect(await page.evaluate(() => window.calls.map(c => c.command))).toEqual(['app_inventory', 'hub_update_status']);
  expect(await page.evaluate(() => window.calls[0].args.check)).toBe(false);
  await page.evaluate(() => window.holdInventory = false);
  await page.locator('#release-button').click();
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'install_app').length)).toBe(1);
});

test('failed blocker recheck retains protection and does not report success', async ({ page }) => {
  await load(page, 'mcp', { updateAvailable: true, preferences: { 'creator-hub.auto-download': 'false' }, blockers: [
    { pid: 40, name: '<img src=x onerror="window.injected=true">', kind: 'connection', parent: null },
  ] });
  await page.locator('#update-blockers-details summary').click();
  await expect(page.locator('#update-blockers-list img')).toHaveCount(0);
  await page.evaluate(() => { window.failInventory = 'Process inventory unavailable.'; window.calls = []; });
  await page.locator('#recheck-app').click();
  await expect(page.locator('#update-blockers-status')).toHaveText('Could not check running apps. Try again.');
  await expect(page.locator('#release-button')).toBeDisabled();
  await expect(page.locator('#recheck-app')).toBeEnabled();
  expect(await page.evaluate(() => window.calls.map(c => c.command))).toEqual(['app_inventory', 'hub_update_status']);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
});

test('uninspectable processes can be rechecked and a current app remains openable', async ({ page }) => {
  await load(page);
  await page.evaluate(() => Object.assign(window.inventory.apps[0], { issue: 'Cannot check node (PID 99). Choose Check again.' }));
  await page.locator('#check-updates').click();
  await page.getByRole('button', { name: 'View Creator Works MCP', exact: true }).click();
  await expect(page.locator('#update-blockers')).toBeVisible();
  await expect(page.locator('#update-blockers-details')).toBeHidden();
  await expect(page.locator('#release-button')).toBeDisabled();
  await page.evaluate(() => Object.assign(window.inventory.apps[0], { issue: null, installed: true, trusted: true, installedVersion: '2.6.0', updateAvailable: false,
    updateBlockers: [{ pid: 40, name: 'node.exe', kind: 'connection', parent: null }] }));
  await page.locator('#recheck-app').click();
  await expect(page.locator('#primary-label')).toHaveText('Open app');
  await expect(page.locator('#release-button')).toBeEnabled();
});

test('new profiles enable prereleases and verified downloads without authorizing installation', async ({ page }) => {
  await load(page, 'hub', { updateAvailable: true });
  await expect(page.locator('#preview-channel')).toBeChecked();
  await expect(page.locator('#auto-download')).toBeChecked();
  await expect.poll(() => page.evaluate(() => window.calls.some(c => c.command === 'download_app'))).toBe(true);
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'app_inventory').every(c => c.args.preview === true))).toBe(true);
  expect(await page.evaluate(() => window.calls.some(c => c.command === 'install_app'))).toBe(false);
});

test('Hub test updates download in-app but only install after the Update Hub click', async ({ page }) => {
  await load(page);
  await page.evaluate(() => Object.assign(window.hubUpdate, { availableVersion: '0.1.0-alpha.4' }));
  await page.locator('#check-updates').click();
  await expect(page.locator('#hub-update-status')).toContainText('ready to install');
  expect(await page.evaluate(() => window.calls.some(c => c.command === 'install_hub_update'))).toBe(false);
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'hub_update_status').every(c => c.args.preview))).toBe(true);
  await page.locator('#hub-update-button').click();
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'install_hub_update'))).toEqual([{ command: 'install_hub_update', args: { version: '0.1.0-alpha.4' } }]);
  expect(await page.evaluate(() => window.calls.some(c => c.command === 'open_resource'))).toBe(false);
});

test('an app requiring newer Hub points to Hub updates and keeps existing apps openable', async ({ page }) => {
  await load(page);
  await page.evaluate(() => {
    Object.assign(window.inventory.apps[0], { installed: true, trusted: true, installedVersion: '2.6.0', availableVersion: '2.7.0-alpha.1', updateAvailable: true,
      requiredHubVersion: '0.1.0-alpha.4', installBlocked: 'Update Creator Hub first.' });
    Object.assign(window.hubUpdate, { availableVersion: '0.1.0-alpha.4' });
  });
  await page.locator('#check-updates').click();
  await page.getByRole('button', { name: 'View Creator Works MCP', exact: true }).click();
  await expect(page.locator('#primary-label')).toHaveText('Update Hub first');
  await expect(page.locator('#open-button')).toBeEnabled();
  await page.locator('#release-button').click();
  await expect(page.locator('#hub-update-title')).toBeFocused();
  await expect(page.locator('#hub-update-button')).toBeEnabled();
  expect(await page.evaluate(() => window.calls.some(c => ['open_resource', 'install_app', 'install_hub_update'].includes(c.command)))).toBe(false);
});

test('blocked or offline Hub updates remain in-app and never run an installer', async ({ page }) => {
  await load(page);
  await page.evaluate(() => Object.assign(window.hubUpdate, { availableVersion: '0.1.0-alpha.4', installBlocked: 'This test copy cannot upgrade.', warning: 'Connection unavailable.' }));
  await page.locator('#check-updates').click();
  await expect(page.locator('#hub-update-warning')).toHaveText('This test copy cannot upgrade.');
  await expect(page.locator('#hub-update-button')).toBeDisabled();
  expect(await page.evaluate(() => window.calls.some(c => ['download_hub_update', 'install_hub_update', 'open_resource'].includes(c.command)))).toBe(false);
});

for (const width of [940, 390]) for (const updateAvailable of [false, true]) test(`mismatched hosted Setup gives update guidance and preserves standalone opening (update ${updateAvailable}, ${width}px)`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 720 });
  await load(page);
  await page.evaluate(updateAvailable => Object.assign(window.inventory.apps[1], {
    installed: true, trusted: true, installedVersion: '0.3.0-alpha.1',
    availableVersion: updateAvailable ? '0.3.0-alpha.2' : '0.3.0-alpha.1', updateAvailable,
    hostedPreview: 'writable', hostedCompatible: false,
  }), updateAvailable);
  await page.locator('#check-updates').click();
  await page.getByRole('button', { name: 'View Creator Project Setup', exact: true }).click();
  await expect(page.locator('#host-setup-button')).toBeDisabled();
  await expect(page.locator('#compatibility-status')).toHaveText('Update needed for Hub');
  await expect(page.locator('#compatibility-detail')).toContainText(updateAvailable ? 'Update this app' : 'Check for updates');
  await expect(page.locator('#compatibility-detail')).toContainText('separate window');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('setup-update-guidance.png'), fullPage: true });
  await page.locator(updateAvailable ? '#open-button' : '#release-button').click();
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'open_app'))).toEqual([{ command: 'open_app', args: { app: 'setup' } }]);
  expect(await page.evaluate(() => window.calls.some(c => ['install_app', 'install_hub_update', 'start_hosted_app', 'open_resource'].includes(c.command)))).toBe(false);
});

test('matching hosted Setup remains available after inventory refresh', async ({ page }) => {
  await load(page);
  await page.evaluate(() => Object.assign(window.inventory.apps[1], {
    installed: true, trusted: true, installedVersion: '0.3.0-alpha.2', availableVersion: '0.3.0-alpha.2',
    hostedPreview: 'writable', hostedCompatible: true,
  }));
  await page.locator('#check-updates').click();
  await page.getByRole('button', { name: 'View Creator Project Setup', exact: true }).click();
  await expect(page.locator('#host-setup-button')).toBeEnabled();
  await expect(page.locator('#host-setup-button')).toHaveText('Open in Hub');
  await expect(page.locator('#release-button')).toBeHidden();
  await expect(page.locator('#open-button')).toHaveText('Open separately');
  await expect(page.locator('#compatibility-status')).toHaveText('Ready to open in Hub');
  expect(await page.evaluate(() => window.calls.some(c => ['start_hosted_app', 'install_app', 'use_existing_app'].includes(c.command)))).toBe(false);
});

test('Setup requiring newer Hub explains the order and refresh clears a resolved mismatch', async ({ page }) => {
  await load(page);
  await page.evaluate(() => Object.assign(window.inventory.apps[1], {
    installed: true, trusted: true, installedVersion: '0.3.0-alpha.1', availableVersion: '0.3.0-alpha.2',
    updateAvailable: true, hostedPreview: 'writable', hostedCompatible: false,
    requiredHubVersion: '0.1.0-alpha.5', installBlocked: 'Update Creator Hub first.',
  }));
  await page.locator('#check-updates').click();
  await page.getByRole('button', { name: 'View Creator Project Setup', exact: true }).click();
  await expect(page.locator('#host-setup-button')).toBeDisabled();
  await expect(page.locator('#compatibility-detail')).toContainText('Update Hub first');
  await expect(page.locator('#open-button')).toBeEnabled();
  await page.locator('#release-button').click();
  await expect(page.locator('#hub-update-title')).toBeFocused();
  await page.evaluate(() => Object.assign(window.inventory.apps[1], {
    installedVersion: '0.3.0-alpha.2', updateAvailable: false, hostedCompatible: true,
    requiredHubVersion: null, installBlocked: null,
  }));
  await page.locator('#check-updates').click();
  await page.getByRole('button', { name: 'View Creator Project Setup', exact: true }).click();
  await expect(page.locator('#host-setup-button')).toBeEnabled();
  await expect(page.locator('#compatibility-status')).toHaveText('Ready to open in Hub');
  expect(await page.evaluate(() => window.calls.some(c => ['install_app', 'install_hub_update', 'start_hosted_app', 'open_resource'].includes(c.command)))).toBe(false);
});

test('saved off preferences survive startup and suppress automatic downloads', async ({ page }) => {
  await load(page, 'hub', { preferences: { 'creator-hub.preview': 'false', 'creator-hub.auto-download': 'false' }, updateAvailable: true });
  await expect(page.locator('#preview-channel')).not.toBeChecked();
  await expect(page.locator('#auto-download')).not.toBeChecked();
  await page.locator('#check-updates').click();
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'app_inventory').every(c => c.args.preview === false))).toBe(true);
  expect(await page.evaluate(() => window.calls.some(c => ['download_app', 'install_app'].includes(c.command)))).toBe(false);
});

test('saved preferences are independent and changing them persists across reload', async ({ page }) => {
  await load(page, 'hub', { preferences: { 'creator-hub.preview': 'false' } });
  await expect(page.locator('#preview-channel')).not.toBeChecked();
  await expect(page.locator('#auto-download')).toBeChecked();
  await page.locator('#auto-download').uncheck();
  await page.reload();
  await expect(page.locator('#catalog-status')).toContainText('Update check complete');
  await expect(page.locator('#preview-channel')).not.toBeChecked();
  await expect(page.locator('#auto-download')).not.toBeChecked();
});

test('unavailable preference storage keeps defaults and does not break startup', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await load(page, 'hub', { storageUnavailable: true });
  await expect(page.locator('#preview-channel')).toBeChecked();
  await expect(page.locator('#auto-download')).toBeChecked();
  await page.locator('#auto-download').uncheck();
  await expect(page.locator('#auto-download')).not.toBeChecked();
  expect(errors).toEqual([]);
});

test('native Hub icon retains transparency and the gray cube backplate', async ({ page }) => {
  const png = fs.readFileSync(path.resolve('src-tauri/icons/hub-source.png')).toString('base64');
  const pixels = await page.evaluate(async source => {
    const img = new Image();
    img.src = `data:image/png;base64,${source}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    const context = canvas.getContext('2d');
    context.drawImage(img, 0, 0);
    return { size: [img.width, img.height], corner: [...context.getImageData(0, 0, 1, 1).data], topFace: [...context.getImageData(128, 60, 1, 1).data] };
  }, png);
  expect(pixels.size).toEqual([256, 256]);
  expect(pixels.corner[3]).toBe(0);
  expect(pixels.topFace).toEqual([105, 117, 127, 255]);
});

test('native launch requests only navigate, and stale requests cannot roll the view back', async ({ page }) => {
  await load(page, 'setup');
  await expect(page.locator('#tool-title')).toHaveText('Creator Project Setup');
  await page.evaluate(() => window.events['hub-launch-view']({ payload: { view: 'mcp', revision: 2 } }));
  await expect(page.locator('#tool-title')).toHaveText('Creator Works MCP');
  await page.evaluate(() => {
    window.events['hub-launch-view']({ payload: { view: 'setup', revision: 1 } });
    window.events['hub-launch-view']({ payload: { view: 'install', revision: 3 } });
  });
  await expect(page.locator('#tool-title')).toHaveText('Creator Works MCP');
  expect(await page.evaluate(() => window.calls.filter(c => !['app_inventory', 'get_launch_request', 'hub_update_status'].includes(c.command)))).toEqual([]);
});

test('catalog navigation changes no external or project state', async ({ page }) => {
  await load(page);
  await page.getByRole('button', { name: 'View Creator Works MCP', exact: true }).click();
  await expect(page.locator('#tool-title')).toHaveText('Creator Works MCP');
  await expect(page.locator('#tool-title')).toBeFocused();
  await expect(page.locator('#view-hub')).toBeHidden();
  await page.getByRole('button', { name: 'All apps' }).click();
  await expect(page.locator('#view-hub')).toBeVisible();
  await page.locator('#suite-trigger').click();
  await page.locator('#suite-menu [data-view="setup"]').click();
  await expect(page.locator('#tool-title')).toHaveText('Creator Project Setup');
  await expect(page.locator('#tool-facts')).toContainText('Android and Windows');
  await expect(page.locator('#suite-menu')).toBeHidden();
  expect(await page.evaluate(() => window.calls.filter(call => !['app_inventory', 'get_launch_request', 'hub_update_status', 'project_inventory'].includes(call.command)))).toEqual([]);
});

test('installation uses native app IDs and reports failure without a browser detour', async ({ page }) => {
  await load(page);
  await page.getByRole('button', { name: 'View Creator Works MCP', exact: true }).click();
  await page.locator('#release-button').click();
  expect(await page.evaluate(() => window.calls.filter(call => !['app_inventory', 'get_launch_request', 'hub_update_status', 'project_inventory'].includes(call.command)))).toEqual([{ command: 'install_app', args: { app: 'mcp', version: '2.6.0', reopen: true, closeRunning: false } }]);
  await page.evaluate(() => window.failOpen = true);
  await page.locator('#source-button').click();
  await expect(page.getByRole('alert')).toContainText('Browser is unavailable');
  await page.evaluate(() => window.failOpen = false);
  await page.locator('#source-button').click();
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(page.locator('#release-button')).toContainText('Install app');
});

test('switcher keyboard and outside dismissal preserve navigation', async ({ page }) => {
  await load(page);
  await page.locator('#suite-trigger').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#suite-menu [data-view="hub"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#suite-menu [data-view="mcp"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#suite-trigger')).toBeFocused();
  await expect(page.locator('#suite-menu')).toBeHidden();
  await page.locator('#suite-trigger').click();
  await page.locator('#suite-dismiss').click({ position: { x: 500, y: 25 } });
  await expect(page.locator('#suite-menu')).toBeHidden();
});

test('URL parameters cannot claim hosted or installed state', async ({ page }) => {
  await load(page);
  await page.goto('http://127.0.0.1:4188/?hosted=true&installed=true&path=C:/bad.exe');
  await expect(page.locator('#suite-trigger')).toBeVisible();
  await expect(page.locator('#status-mcp')).toContainText('Available');
  expect(await page.evaluate(() => window.calls.filter(call => !['app_inventory', 'get_launch_request', 'hub_update_status', 'project_inventory'].includes(call.command)))).toEqual([]);
});

for (const width of [940, 720, 560, 390]) {
  test(`layout, assets and views at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 580 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await load(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const img of await page.locator('.app-row img').all()) expect(await img.evaluate(item => item.naturalWidth)).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath('hub.png'), fullPage: true });
    await page.locator('#suite-trigger').click();
    await expect(page.locator('#suite-shell')).toHaveCSS('width', '224px');
    await expect(page.locator('#suite-shell')).toHaveCSS('height', '352px');
    await expect(page.locator('.app-header .title-block')).toHaveCSS('opacity', '0');
    await expect(page.locator('.suite-brand')).toHaveCSS('opacity', '1');
    await expect(page.locator('.suite-brand')).toHaveCSS('visibility', 'visible');
    expect(await page.locator('.suite-brand').evaluate(el => el.getBoundingClientRect().x)).toBe(15);
    expect(await page.locator('#suite-shell').evaluate(el => el.scrollLeft)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('menu.png'), fullPage: true });
    if (width === 940) {
      await page.waitForTimeout(500);
      await page.screenshot({ path: testInfo.outputPath('drawer-settled.png'), fullPage: true });
    }
    await page.locator('#suite-menu [data-view="setup"]').click();
    await expect(page.locator('#suite-shell')).toHaveCSS('width', '55px');
    await expect(page.locator('#suite-shell')).toHaveCSS('height', '48px');
    await expect(page.locator('.app-header .title-block')).toHaveCSS('opacity', '1');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('setup-detail.png'), fullPage: true });
    expect(errors).toEqual([]);
  });
}

test('morphing drawer reverses, restores focus and honors reduced motion', async ({ page }) => {
  await load(page);
  const before = await page.locator('.app-list').boundingBox();
  const closed = await page.locator('#suite-trigger').boundingBox();
  await page.locator('#suite-trigger').click();
  await expect(page.locator('#suite-shell')).toHaveCSS('width', '224px');
  await expect(page.locator('#suite-shell')).toHaveCSS('height', '352px');
  expect((await page.locator('#suite-trigger').boundingBox()).x - closed.x).toBe(169);
  expect(await page.locator('.app-list').boundingBox()).toEqual(before);
  await expect(page.locator('#suite-close')).toHaveCount(0);
  await page.locator('#suite-trigger').click();
  await expect(page.locator('#suite-menu')).toBeHidden();
  await expect(page.locator('#suite-menu')).toHaveJSProperty('inert', true);
  await expect(page.locator('#suite-trigger')).toBeFocused();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#suite-trigger').click();
  await expect(page.locator('#suite-shell')).toHaveCSS('transition-duration', '0s');
  await expect(page.locator('#suite-shell')).toHaveCSS('width', '224px');
  await page.keyboard.press('Escape');
  await expect(page.locator('.app-header .title-block')).toHaveCSS('opacity', '1');
});

test('Creator Plugins browses the catalogue without installation or account actions', async ({ page }) => {
  await load(page);
  await page.getByRole('button', { name: 'View Creator Plugins' }).click();
  await expect(page.locator('#plugins-title')).toBeFocused();
  await expect(page.locator('#view-plugins')).toContainText('No contributions are listed yet');
  await expect(page.locator('#view-plugins')).toContainText('Editor tools');
  await expect(page.locator('#release-button')).toBeHidden();
  expect(await page.evaluate(() => window.calls.filter(c => !['app_inventory', 'get_launch_request', 'hub_update_status', 'project_inventory', 'community_catalogue'].includes(c.command)))).toEqual([]);
});

test('download progress cancels, prevents duplicate actions and never auto-installs', async ({ page }) => {
  await load(page);
  await page.evaluate(() => window.holdAction = true);
  await page.getByRole('button', { name: 'View Creator Works MCP', exact: true }).click();
  await page.locator('#download-button').click();
  await expect(page.locator('#release-button')).toBeDisabled();
  await page.evaluate(() => window.events['app-progress']({ payload: { app: 'mcp', message: 'Downloading Creator Works MCP', received: 1048576, total: 2097152, cancellable: true } }));
  await expect(page.locator('#progress-bytes')).toHaveText('1.0 / 2.0 MB');
  await page.locator('#cancel-download').click();
  await page.evaluate(() => window.finishAction('Download cancelled.'));
  await expect(page.locator('#progress-message')).toHaveText('Download cancelled.');
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'install_app'))).toEqual([]);
});

test('installed apps open and unverified installations remain blocked', async ({ page }) => {
  await load(page);
  await page.evaluate(() => Object.assign(window.inventory.apps[0], { installed: true, trusted: true, installedVersion: '2.6.0' }));
  await page.locator('#check-updates').click();
  await page.getByRole('button', { name: 'View Creator Works MCP', exact: true }).click();
  await expect(page.locator('#release-button')).toContainText('Open app');
  await page.locator('#release-button').click();
  expect(await page.evaluate(() => window.calls.some(c => c.command === 'open_app'))).toBe(true);
  await page.evaluate(() => Object.assign(window.inventory.apps[0], { trusted: false, issue: 'Existing app is unverified.' }));
  await page.getByRole('button', { name: 'All apps' }).click();
  await page.locator('#check-updates').click();
  await page.getByRole('button', { name: 'View Creator Works MCP', exact: true }).click();
  await expect(page.locator('#release-button')).toBeDisabled();
  await expect(page.locator('#tool-state')).toContainText('unverified');
});

test('enabled update downloads do not authorize installation', async ({ page }) => {
  await load(page);
  await page.evaluate(() => Object.assign(window.inventory.apps[0], { installed: true, trusted: true, installedVersion: '2.5.0', updateAvailable: true }));
  await page.locator('#auto-download').check();
  await page.locator('#check-updates').click();
  await expect.poll(() => page.evaluate(() => window.calls.some(c => c.command === 'download_app'))).toBe(true);
  expect(await page.evaluate(() => window.calls.some(c => c.command === 'install_app'))).toBe(false);
});

test('standalone compatibility never invents a hosted update or hides the full app', async ({ page }) => {
  await load(page);
  await page.evaluate(() => Object.assign(window.inventory.apps[0], {
    installed: true, trusted: true, installedVersion: '2.6.0', installedPath: 'C:\\Apps\\MCP\\creator-works-mcp-launcher.exe', hostedPreview: null,
  }));
  await page.locator('#check-updates').click();
  await page.getByRole('button', { name: 'View Creator Works MCP', exact: true }).click();
  await expect(page.locator('#compatibility-status')).toHaveText('Your app is ready');
  await expect(page.locator('#compatibility-detail')).toContainText('This app version opens in its own window');
  await expect(page.locator('#host-mcp-button')).toBeHidden();
  await expect(page.locator('#tool-state')).toContainText('C:\\Apps\\MCP');
  await page.locator('#release-button').click();
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'open_app'))).toHaveLength(1);
  expect(await page.evaluate(() => window.calls.some(c => ['install_app', 'start_hosted_app'].includes(c.command)))).toBe(false);
});

test('blocked installer checks inside Hub without downloading or replacing apps', async ({ page }) => {
  await load(page);
  await page.evaluate(() => Object.assign(window.inventory.apps[0], { installBlocked: 'Known preflight defect. Use a corrected installer.', updateAvailable: true }));
  await page.locator('#auto-download').check();
  await page.locator('#check-updates').click();
  await page.getByRole('button', { name: 'View Creator Works MCP', exact: true }).click();
  await expect(page.locator('#primary-label')).toHaveText('Check for an update');
  await expect(page.locator('#install-options')).toBeHidden();
  await expect(page.locator('#download-button')).toBeHidden();
  await page.locator('#release-button').click();
  expect(await page.evaluate(() => window.calls.some(c => c.command === 'open_resource'))).toBe(false);
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'app_inventory' && c.args.check).length)).toBeGreaterThanOrEqual(3);
  expect(await page.evaluate(() => window.calls.some(c => ['install_app', 'download_app'].includes(c.command)))).toBe(false);
});

test('blocked installer does not prevent opening an already verified app', async ({ page }) => {
  await load(page);
  await page.evaluate(() => Object.assign(window.inventory.apps[0], { installed: true, trusted: true, installedVersion: '2.6.0', installBlocked: 'Known installer defect.' }));
  await page.locator('#check-updates').click();
  await page.getByRole('button', { name: 'View Creator Works MCP', exact: true }).click();
  await expect(page.locator('#release-button')).toBeEnabled();
  await expect(page.locator('#primary-label')).toHaveText('Open app');
  await page.locator('#release-button').click();
  expect(await page.evaluate(() => window.calls.some(c => c.command === 'open_app'))).toBe(true);
});

for (const width of [940, 560, 390]) {
  test(`multiple app copies remain explicit and selectable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 700 });
    await load(page);
    const selected = 'C:\\Apps\\A very long Creator Works MCP location for layout coverage\\creator-works-mcp-launcher.exe';
    await page.evaluate(selected => Object.assign(window.inventory.apps[0], {
      issue: 'Multiple or legacy installations were found.',
      detectedCopies: [{ path: selected, verified: true, version: '2.6.0' }, { path: 'C:\\Legacy\\bantworks-mcp-launcher.exe', verified: false }],
    }), selected);
    await page.locator('#check-updates').click();
    await page.getByRole('button', { name: 'View Creator Works MCP', exact: true }).click();
    await expect(page.locator('#tool-state')).not.toContainText('Not installed');
    await expect(page.locator('#tool-state')).toContainText('App needs attention');
    await expect(page.locator('#detected-copies button').last()).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('compatibility.png'), fullPage: true });
    await page.locator('#detected-copies button').first().click();
    expect(await page.evaluate(() => window.calls.find(c => c.command === 'use_existing_app').args)).toEqual({ app: 'mcp', path: selected });
    expect(await page.evaluate(() => window.calls.some(c => c.command === 'install_app'))).toBe(false);
  });
}
