const { test, expect } = require('@playwright/test');

async function load(page) {
  await page.addInitScript(() => {
    window.calls = [];
    window.__TAURI__ = { core: { invoke: async (command, args) => {
      window.calls.push({ command, args });
      if (window.failOpen) throw 'Browser is unavailable.';
    } } };
  });
  await page.goto('http://127.0.0.1:4188');
}

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
  expect(await page.evaluate(() => window.calls)).toEqual([]);
});

test('release actions use named resources and report failure', async ({ page }) => {
  await load(page);
  await page.getByRole('button', { name: 'View Creator Works MCP', exact: true }).click();
  await page.locator('#release-button').click();
  expect(await page.evaluate(() => window.calls)).toEqual([{ command: 'open_resource', args: { resource: 'mcp-releases' } }]);
  await page.evaluate(() => window.failOpen = true);
  await page.locator('#source-button').click();
  await expect(page.getByRole('alert')).toContainText('Browser is unavailable');
  await page.evaluate(() => window.failOpen = false);
  await page.locator('#source-button').click();
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(page.getByRole('button', { name: /^Install$|^Update$|^Open app$/ })).toHaveCount(0);
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
  await page.locator('#page-title').click();
  await expect(page.locator('#suite-menu')).toBeHidden();
});

test('URL parameters cannot claim hosted or installed state', async ({ page }) => {
  await load(page);
  await page.goto('http://127.0.0.1:4188/?hosted=true&installed=true&path=C:/bad.exe');
  await expect(page.locator('#suite-trigger')).toBeVisible();
  await expect(page.locator('.development-status')).toContainText('In development');
  expect(await page.evaluate(() => window.calls)).toEqual([]);
});

for (const width of [940, 720, 560, 390]) {
  test(`layout, assets and views at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 580 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await load(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const img of await page.locator('.app-row img').all()) expect(await img.evaluate(item => item.naturalWidth)).toBe(1024);
    await page.screenshot({ path: testInfo.outputPath('hub.png'), fullPage: true });
    await page.locator('#suite-trigger').click();
    await page.screenshot({ path: testInfo.outputPath('menu.png'), fullPage: true });
    await page.locator('#suite-menu [data-view="setup"]').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('setup-detail.png'), fullPage: true });
    expect(errors).toEqual([]);
  });
}
