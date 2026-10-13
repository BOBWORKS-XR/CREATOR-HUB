const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

async function load(page, time = '2026-10-19T23:59:00.000Z') {
  await page.clock.install({ time: new Date(time) });
  await page.addInitScript(() => {
    localStorage.setItem('creator-usage-terms.hub', JSON.stringify({ policyVersion: '2026-09-28-v1', acceptedAt: '2026-09-28T00:00:00.000Z' }));
    window.calls = [];
    window.__TAURI__ = { event: { listen: async () => () => {} }, core: { invoke: async (command, args) => {
      window.calls.push({ command, args });
      if (command === 'app_inventory') return { supported: true, apps: ['mcp', 'setup'].map(app => ({ app, installed: false, trusted: false, availableVersion: app === 'mcp' ? '2.7.7' : '0.3.7', downloaded: false, issue: null, installerInteractive: true })) };
      if (command === 'hub_update_status') return { currentVersion: '0.1.12' };
      if (command === 'get_launch_request') return { view: 'hub', revision: 0 };
      if (command === 'project_inventory') return { projects: [], warnings: [] };
      if (command === 'pending_hosted_restore') return null;
      if (command === 'open_plugins_website') { if (window.failWebsite) throw 'Browser unavailable'; return; }
      throw Error(`Unexpected command: ${command}`);
    } } };
  });
  await page.goto('http://127.0.0.1:4188');
  await page.getByRole('button', { name: 'View Creator Plugins', exact: true }).click();
}

for (const width of [940, 390, 320]) test(`retirement notice fits ${width}px and only opens the fixed native website action`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 760 });
  await load(page);
  await expect(page.locator('.community-retirement')).toContainText('20 October 2026');
  await expect(page.locator('#view-plugins input, #view-plugins select, #view-plugins dialog, #view-plugins a')).toHaveCount(0);
  await page.getByRole('button', { name: 'Visit creatorplugins.store', exact: true }).click();
  expect(await page.evaluate(() => window.calls.filter(c => c.command.includes('community')))).toEqual([]);
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'open_plugins_website'))).toEqual([{ command: 'open_plugins_website', args: {} }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`plugins-retirement-${width}.png`) });
});

for (const time of ['2026-10-20T00:00:00.000Z', '2027-01-01T00:00:00.000Z']) test(`retired page has no website or import actions at ${time}`, async ({ page }) => {
  await load(page, time);
  await expect(page.locator('.community-retirement')).toHaveText('Creator Plugins has been retired from the Creator apps.');
  await expect(page.locator('#view-plugins button, #view-plugins a')).toHaveCount(0);
  await expect(page.locator('#view-plugins')).not.toContainText('creatorplugins.store');
  await expect(page.locator('[data-plugins-status]')).toHaveText('Retired');
  expect(await page.evaluate(() => window.calls.some(c => /community|plugins_website/.test(c.command)))).toBe(false);
});

test('an open app removes the website when its clock crosses the cutoff', async ({ page }) => {
  await load(page);
  await page.clock.runFor(60_000);
  await expect(page.locator('#view-plugins button')).toHaveCount(0);
  await expect(page.locator('.community-retirement')).toContainText('has been retired');
});

test('a stale website click after sleep rechecks the deadline before native invocation', async ({ page }) => {
  await load(page);
  await page.clock.setFixedTime(new Date('2026-10-20T00:00:00Z'));
  await page.getByRole('button', { name: 'Visit creatorplugins.store', exact: true }).dispatchEvent('click');
  await expect(page.locator('#view-plugins button')).toHaveCount(0);
  expect(await page.evaluate(() => window.calls.some(c => c.command === 'open_plugins_website'))).toBe(false);
});

test('website launch failure stays visible without reviving the catalogue', async ({ page }) => {
  await load(page);
  await page.evaluate(() => { window.failWebsite = true; });
  await page.getByRole('button', { name: 'Visit creatorplugins.store', exact: true }).click();
  await expect(page.locator('.community-message')).toHaveText('Browser unavailable');
  await expect(page.getByRole('button', { name: 'Visit creatorplugins.store', exact: true })).toBeEnabled();
});

for (const file of ['modules/mcp/launcher/src/community.js', 'modules/project-setup/src/community.js']) test(`standalone retirement copy switches offline: ${file}`, async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-19T23:59:00Z') });
  await page.setContent('<section id="view-plugins"></section>');
  await page.evaluate(() => { window.calls = []; window.CreatorCommunityInvoke = async c => window.calls.push(c); });
  await page.addScriptTag({ content: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8') });
  await page.getByRole('button', { name: 'Visit creatorplugins.store', exact: true }).click();
  expect(await page.evaluate(() => window.calls)).toEqual(['open_plugins_website']);
  await page.clock.runFor(60_000);
  await expect(page.locator('button, a')).toHaveCount(0);
  await expect(page.locator('#view-plugins')).not.toContainText('creatorplugins.store');
});
