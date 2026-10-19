const { test, expect } = require('@playwright/test');

async function load(page, integrated, savedView = 'hub') {
  await page.addInitScript(({ integrated, savedView }) => {
    localStorage.setItem('creator-usage-terms.hub', JSON.stringify({ policyVersion: '2026-09-28-v1', acceptedAt: '2026-09-28T00:00:00Z' }));
    window.calls = [];
    if (integrated) window.__CREATOR_HUB_FEATURE_PROTOCOL__ = 1;
    window.__TAURI__ = { event: { listen: async () => () => {} }, core: { invoke: async (command, args) => {
      window.calls.push({ command, args });
      if (command === 'feature_status') return { integrated, features: ['setup', 'mcp'] };
      if (command === 'app_inventory') return { supported: true, apps: ['mcp', 'setup'].map(app => ({ app, installed: false, trusted: false, availableVersion: '1.0.0', downloaded: false, issue: null })) };
      if (command === 'hub_update_status') return { currentVersion: '0.1.14' };
      if (command === 'get_launch_request') return { view: savedView, revision: 0 };
      if (command === 'project_inventory') return { projects: [], warnings: [] };
      if (command === 'pending_hosted_restore') return null;
      return null;
    } } };
  }, { integrated, savedView });
  await page.goto('http://127.0.0.1:4188');
  await expect.poll(() => page.evaluate(() => window.calls.some(call => call.command === 'get_launch_request'))).toBe(true);
}

for (const integrated of [false, true]) for (const width of [320, 390, 940]) {
  test(`Plugins is removed from ${integrated ? 'integrated' : 'legacy'} Hub at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 760 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await load(page, integrated);
    await page.locator('#suite-trigger').click();
    await expect(page.locator('[data-view="plugins"], #view-plugins, .plugins-mark')).toHaveCount(0);
    await expect(page.locator('#suite-menu')).not.toContainText('Creator Plugins');
    await expect(page.locator('#suite-menu [data-view="mcp"]')).toBeVisible();
    await expect(page.locator('#suite-menu [data-view="setup"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.locator('#context-help-open').click();
    await expect(page.locator('#context-help-dialog')).not.toContainText('Creator Plugins');
    expect(await page.evaluate(() => window.calls.filter(call => /community|plugins_website/.test(call.command)))).toEqual([]);
    expect(await page.evaluate(() => performance.getEntriesByType('resource').some(resource => /community\.(js|css)|creator-plugins\.png/.test(resource.name)))).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`plugins-removed-${integrated}-${width}.png`) });
  });
}

test('an old Plugins launch request cannot revive its page or load catalogue code', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await load(page, true, 'plugins');
  await expect(page.locator('[data-view="plugins"], #view-plugins')).toHaveCount(0);
  await expect(page.locator('#page-title')).toHaveText('CREATOR HUB');
  expect(await page.evaluate(() => window.calls.some(call => /community|plugins_website/.test(call.command)))).toBe(false);
  expect(errors).toEqual([]);
});
