const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { helpOcclusion } = require('./help-layout.cjs');
const source = path.resolve(__dirname, '../modules/project-setup/src');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

for (const width of [940, 390, 360]) test(`Standalone Setup controls stay clear of Help and navigation at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 580 });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('http://127.0.0.1:4188/setup-standalone/**', route => {
    const name = new URL(route.request().url()).pathname.slice('/setup-standalone/'.length) || 'index.html';
    return route.fulfill({ contentType: mime[path.extname(name)], body: fs.readFileSync(path.join(source, name)) });
  });
  await page.addInitScript(() => {
    localStorage.setItem('creator-usage-terms.setup', JSON.stringify({ policyVersion: '2026-09-28-v1', acceptedAt: '2026-09-28T00:00:00.000Z' }));
    window.__TAURI__ = { event: { listen: async () => () => {} }, core: { invoke: async command => {
      if (command !== 'probe_environment') throw Error(`Unexpected fixture command: ${command}`);
      return { platform: 'windows', ready: true, hubInstalled: true, hubVersion: '3.21.1', hubAutoRegistration: true,
        suggestedProjectParent: 'E:\\Fixtures', blockers: [],
        recipe: { editorVersion: '6000.3.21f1', creatorSdkVersion: '4.0.14', urpVersion: '17.3.0', inputSystemVersion: '1.20.0' },
        editors: [{ exactRecipe: true, androidPlayer: true, androidSdk: true, androidNdk: true, openJdk: true, windowsStandalone: true, urpTemplate: 'fixture.tgz' }] };
    } } };
  });
  await page.goto('http://127.0.0.1:4188/setup-standalone/');
  await expect(page.locator('#create-button')).toBeEnabled();
  await expect(page.locator('#view-plugins, #suite-plugins')).toHaveCount(0);
  await expect(page.locator('script[src*="community"], link[href*="community"]')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/Creator Plugins|creatorplugins\.store|retirement notice/i);
  expect(await page.evaluate(() => [typeof window.CreatorCommunity, typeof window.CreatorCommunityInvoke])).toEqual(['undefined', 'undefined']);
  await expect(page.locator('body')).toHaveCSS('font-family', '"Segoe UI", Arial, sans-serif');
  await expect(page.locator('body')).toHaveCSS('font-size', '13px');
  await expect(page.locator('#create-button')).toHaveCSS('font-family', '"Segoe UI", Arial, sans-serif');
  await expect(page.locator('#github-button .icon')).toHaveCSS('width', '16px');
  await expect(page.locator('#github-button .icon')).toHaveCSS('height', '16px');
  await expect.poll(() => page.locator('#suite-trigger img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  await page.locator('#suite-trigger').click();
  await expect(page.locator('#suite-shell')).toHaveCSS('height', '294px');
  await expect(page.locator('#suite-menu .suite-item strong')).toHaveText([
    'Creator Hub', 'Creator Works MCP', 'Project Setup', 'Creator Converter',
  ]);
  await page.keyboard.press('End');
  await expect(page.locator('#suite-current')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#suite-trigger')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#suite-current')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#new-mode')).toBeFocused();
  await expect(page.locator('#setup-workspace')).toBeVisible();
  await page.locator('#context-help-open').click();
  await expect(page.locator('#context-help-dialog')).toBeVisible();
  await page.locator('#context-help-close').click();
  expect(await page.locator('.app-header').evaluate(node => ({ position: getComputedStyle(node).position, background: getComputedStyle(node).backgroundColor }))).toEqual({ position: 'sticky', background: 'rgb(9, 11, 13)' });
  expect(await helpOcclusion(page, 'main button, main input, main select, main summary, .requirement, footer .text-button')).toBeNull();
  await page.screenshot({ path: testInfo.outputPath('standalone-setup-clearance.png') });
  await page.locator('#parent-folder').evaluate(node => node.scrollIntoView({ block: 'start' }));
  const header = await page.locator('.app-header').boundingBox(), field = await page.locator('#parent-folder').boundingBox();
  expect(field.y).toBeGreaterThanOrEqual(header.y + header.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
