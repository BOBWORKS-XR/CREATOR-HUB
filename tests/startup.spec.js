const { test, expect } = require('@playwright/test');

async function boot(page, { failInventory = null, emptyInventory = false, unsupportedInventory = false, notInstalled = false, upToDate = false, platform = null, version = '0.1.1', view = 'hub' } = {}) {
  await page.addInitScript(({ failInventory, emptyInventory, unsupportedInventory, notInstalled, upToDate, platform, version, view }) => {
    if (platform) {
      Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
      Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: undefined });
    }
    window.__CREATOR_HUB_VERSION__ = version;
    localStorage.setItem('creator-hub.auto-download', 'false');
    window.calls = [];
    window.failInventory = failInventory;
    window.scanBusy = false;
    window.failures = [];
    window.events = {};
    window.__TAURI__ = {
      event: { listen: async (name, handler) => { window.events[name] = handler; return () => {}; } },
      core: { invoke: async (command, args) => {
        window.calls.push({ command, args });
        if (command === 'get_launch_request') return { view, revision: 0 };
        if (command === 'project_inventory') {
          window.scanBusy = true;
          await new Promise(resolve => { window.finishProjectScan = resolve; });
          window.scanBusy = false;
          return { projects: [], warnings: [] };
        }
        if (command === 'app_inventory') {
          if (window.scanBusy) { window.failures.push(command); throw 'Another Hub operation is already running.'; }
          if (window.failInventory) throw window.failInventory;
          if (window.invalidInventory) return {};
          if (unsupportedInventory) return { supported: false, apps: [] };
          return { supported: true, apps: emptyInventory ? [] : ['mcp', 'setup'].map(app => ({ app, installed: !notInstalled, trusted: !notInstalled,
            installedVersion: '1.0.0', availableVersion: '1.0.1', updateAvailable: !notInstalled && !upToDate, issue: null, updateBlockers: [] })) };
        }
        if (command === 'hub_update_status') {
          if (window.scanBusy) { window.failures.push(command); throw 'Another Hub operation is already running.'; }
          return { currentVersion: version, availableVersion: '0.1.2', downloaded: true };
        }
        return null;
      } },
    };
  }, { failInventory, emptyInventory, unsupportedInventory, notInstalled, upToDate, platform, version, view });
  await page.goto('http://127.0.0.1:4188');
}

test('slow Projects scan does not lose app inventory or Hub update checks', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#catalog-status')).toContainText('Update check complete');
  await page.locator('#hub-pages [data-view="projects"]').click();
  await expect.poll(() => page.evaluate(() => typeof window.finishProjectScan)).toBe('function');
  await expect(page.locator('#view-projects')).toBeVisible();
  await page.locator('#hub-pages [data-view="hub"]').click();
  await page.locator('#check-updates').click();
  await expect(page.locator('#check-updates')).toBeDisabled();
  expect(await page.evaluate(() => window.failures)).toEqual([]);
  await page.evaluate(() => window.finishProjectScan());
  await expect(page.locator('#catalog-status')).toHaveText('Update check complete. Installation always needs your approval.');
  await page.locator('#hub-pages [data-view="hub"]').click();
  await expect(page.locator('#update-mcp')).toBeEnabled();
  await expect(page.locator('#update-setup')).toBeEnabled();
  await expect(page.locator('#hub-update-button')).toBeEnabled();
  expect(await page.evaluate(() => window.failures)).toEqual([]);
});

test('footer uses the executable version even when app discovery fails', async ({ page }) => {
  await boot(page, { version: '9.8.7-test.2', view: 'mcp', failInventory: 'Cannot inspect cached release catalog.' });
  await expect(page.locator('.footer-version')).toHaveText('9.8.7-test.2');
});

test('incomplete supported inventory reports missing app states instead of leaving rows on Checking', async ({ page }) => {
  await boot(page, { emptyInventory: true });
  await expect(page.locator('#inventory-error')).toContainText('inventory is incomplete');
  await expect(page.locator('#status-mcp')).toHaveText('Status unavailable');
  await expect(page.locator('#status-setup')).toHaveText('Status unavailable');
  await expect(page.locator('#status-mcp')).not.toHaveText('Checking');
  await expect(page.locator('#status-setup')).not.toHaveText('Checking');
});

test('available app rows state explicitly that each app is not installed', async ({ page }) => {
  await boot(page, { notInstalled: true });
  await expect(page.locator('#status-mcp')).toHaveText('Not installed · 1.0.1 available');
  await expect(page.locator('#status-setup')).toHaveText('Not installed · 1.0.1 available');
});

test('Apps and Projects actions share the tab toolbar without duplicate page headings', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await boot(page, { upToDate: true });
  await expect(page.locator('#check-updates')).toBeVisible();
  await expect(page.locator('#apps-title')).toHaveCount(0);
  await expect(page.locator('#hub-pages .project-actions')).toBeHidden();
  await expect(page.locator('#status-mcp .status-indicator')).toHaveAttribute('class', /icon-check/);
  await page.screenshot({ path: testInfo.outputPath('hub-apps-toolbar.png'), fullPage: true });
  await page.locator('#hub-tab-projects').click();
  await expect(page.locator('#check-updates')).toBeHidden();
  await expect(page.locator('#hub-pages .project-actions')).toBeVisible();
  await expect(page.locator('#projects-title')).toHaveCount(0);
  await expect(page.locator('#hub-tab-projects')).toBeFocused();
  await expect(page.locator('#hub-pages')).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('hub-projects-toolbar.png'), fullPage: true });
});

test('platform label reports Linux instead of a hard-coded Windows label', async ({ page }) => {
  await boot(page, { unsupportedInventory: true, platform: 'Linux x86_64' });
  await expect(page.locator('#platform-status')).toHaveText('Linux');
  await expect(page.locator('#catalog-status')).toContainText('not supported on Linux');
});

test('unsupported app management does not claim apps are installed or absent', async ({ page }) => {
  await boot(page, { unsupportedInventory: true, platform: 'MacIntel' });
  await expect(page.locator('#status-mcp')).toHaveText('Not supported');
  await expect(page.locator('#status-setup')).toHaveText('Not supported');
  await expect(page.locator('#catalog-status')).toContainText('App management is not supported on macOS');
  await expect(page.locator('#platform-status')).toHaveText('macOS');
});

test('inventory failure remains actionable on the app page and does not suppress Hub updates', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 560, height: 780 });
  await boot(page, { view: 'mcp', failInventory: 'Cannot inspect cached release catalog. <img src=x>' });
  await expect(page.locator('#inventory-error')).toContainText('Cannot inspect cached release catalog. <img src=x>');
  await expect(page.locator('#inventory-error img')).toHaveCount(0);
  await expect(page.locator('#retry-inventory')).toBeEnabled();
  await expect(page.locator('#compatibility-detail')).not.toContainText('future update');
  await expect(page.locator('#release-button')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.calls.filter(c => c.command === 'hub_update_status').length)).toBe(2);
  await page.screenshot({ path: testInfo.outputPath('inventory-recovery.png'), fullPage: true });
  await page.evaluate(() => { window.failInventory = null; window.calls = []; });
  await page.locator('#retry-inventory').click();
  await expect(page.locator('#inventory-error')).toBeHidden();
  await expect(page.locator('#release-button')).toBeEnabled();
  await expect(page.locator('#view-detail')).toBeVisible();
  expect(await page.evaluate(() => window.calls.some(c => /^(install_|download_|open_app|start_hosted_app)/.test(c.command)))).toBe(false);
});

test('invalid discovery response retains last-known versions but disables stale update actions', async ({ page }) => {
  await boot(page, { view: 'mcp' });
  await expect(page.locator('#release-button')).toBeEnabled();
  await page.evaluate(() => { window.invalidInventory = true; window.calls = []; });
  await page.locator('#view-detail [data-view="hub"]').click();
  await page.locator('#auto-download').check();
  await page.locator('#check-updates').click();
  await expect(page.locator('#inventory-error')).toContainText('response is unavailable');
  await expect(page.locator('#update-mcp')).toBeDisabled();
  await page.getByRole('button', { name: 'View Creator Works MCP', exact: true }).click();
  await expect(page.locator('#tool-state')).toContainText('Your version: 1.0.0');
  await expect(page.locator('#release-button')).toBeDisabled();
  expect(await page.evaluate(() => window.calls.some(c => /^(install_|download_)/.test(c.command)))).toBe(false);
});
