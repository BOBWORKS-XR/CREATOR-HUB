const { test, expect } = require('@playwright/test');

async function boot(page, { failInventory = null, version = '0.1.1', view = 'hub' } = {}) {
  await page.addInitScript(({ failInventory, version, view }) => {
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
          return { supported: true, apps: ['mcp', 'setup'].map(app => ({ app, installed: true, trusted: true,
            installedVersion: '1.0.0', availableVersion: '1.0.1', updateAvailable: true, issue: null, updateBlockers: [] })) };
        }
        if (command === 'hub_update_status') {
          if (window.scanBusy) { window.failures.push(command); throw 'Another Hub operation is already running.'; }
          return { currentVersion: version, availableVersion: '0.1.2', downloaded: true };
        }
        return null;
      } },
    };
  }, { failInventory, version, view });
  await page.goto('http://127.0.0.1:4188');
}

test('slow Projects startup does not lose app inventory or Hub update checks', async ({ page }) => {
  await boot(page);
  await expect.poll(() => page.evaluate(() => typeof window.finishProjectScan)).toBe('function');
  await expect(page.locator('#view-projects')).toBeVisible();
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
