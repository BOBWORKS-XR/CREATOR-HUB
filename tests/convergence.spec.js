const { test, expect } = require('@playwright/test');

async function load(page, { required = true, failPrepare = false, holdPrepare = false, retirementReady = false, pauseRetirement = false, reviewKey = 'a'.repeat(64) } = {}) {
  await page.addInitScript(({ required, failPrepare, holdPrepare, retirementReady, pauseRetirement, reviewKey }) => {
    localStorage.setItem('creator-usage-terms.hub', JSON.stringify({ policyVersion: '2026-09-28-v1', acceptedAt: '2026-09-28T00:00:00.000Z' }));
    localStorage.setItem('creator-hub.auto-download', 'false');
    window.__CREATOR_HUB_CONVERGENCE_PROTOCOL__ = 1;
    window.calls = [];
    window.report = {
      enabled: true, required, stage: 'review', settings: ['MCP project selection and options'],
      legacyApps: required ? [{ name: 'Creator Works MCP', path: 'C:/fixture-only/Creator Works MCP/launcher.exe' }] : [],
      backups: [], retirementAvailable: false, message: 'Your saved projects and settings stay where they are.',
      reviewKey,
    };
    window.__TAURI__ = {
      event: { listen: async () => () => {} },
      core: { invoke: async (command, args) => {
        window.calls.push({ command, args });
        if (command === 'convergence_status') return window.report;
        if (command === 'prepare_convergence') {
          if (holdPrepare) await new Promise(resolve => { window.releasePrepare = resolve; });
          if (failPrepare) throw Error('Settings changed; original retained.');
          window.report = { ...window.report, stage: 'backed-up', backups: ['C:/fixture-only/exact-before-image.bak'], message: 'Backups verified. Review existing AI connections.' };
          return window.report;
        }
        if (command === 'migrate_convergence_connections') {
          window.report = { ...window.report, stage: 'connections-reviewed', retirementAvailable: retirementReady, message: 'Reviewed, not uninstalled.' };
          return window.report;
        }
        if (command === 'retire_convergence_apps') {
          window.report = pauseRetirement
            ? { ...window.report, message: 'Cleanup paused; some app entries may already be retired. Settings and runtime files were kept.' }
            : { ...window.report, stage: 'complete', required: false, retirementAvailable: false, legacyApps: [], message: 'Migration complete. Settings and backups kept; old MCP runtime paths remain available.' };
          return window.report;
        }
        if (command === 'refresh_convergence') {
          window.report = { ...window.report, stage: 'review', retirementAvailable: false, backups: [], message: 'Fresh native review required before resuming interrupted cleanup.' };
          return window.report;
        }
        if (command === 'get_launch_request') return { view: 'hub', revision: 0 };
        if (command === 'pending_hosted_restore') return [];
        if (command === 'app_inventory') return { supported: true, apps: ['mcp', 'setup'].map(app => ({ app, installed: false, trusted: false, availableVersion: '1.0.0', updateAvailable: false, issue: null })) };
        if (command === 'hub_update_status') return { currentVersion: '0.1.14', availableVersion: null, downloaded: false };
        return null;
      } },
    };
  }, { required, failPrepare, holdPrepare, retirementReady, pauseRetirement, reviewKey });
  await page.goto('http://127.0.0.1:4188');
}

for (const width of [1100, 390]) test(`deferred migration survives reload and can be reopened at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  await load(page);
  await page.locator('#convergence-later').click();
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.calls.some(call => call.command === 'app_inventory'))).toBe(true);
  await expect(page.locator('#convergence-dialog')).not.toBeVisible();
  await expect(page.locator('#convergence-reopen')).toBeVisible();
  await page.locator('#convergence-reopen').click();
  await expect(page.locator('#convergence-dialog')).toBeVisible();
  expect(await page.evaluate(() => window.calls.some(call => /prepare_convergence|migrate_convergence|retire_convergence/.test(call.command)))).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('deferred-migration-review.png') });
  await page.locator('#convergence-later').click();
  await page.screenshot({ path: testInfo.outputPath('migration-resume-footer.png'), fullPage: true });
});

test('changed migration identity reopens the prompt instead of treating deferral as approval', async ({ page }) => {
  await load(page);
  await page.locator('#convergence-later').click();
  await page.evaluate(() => localStorage.setItem('creator-hub.convergence-reminder-v1', JSON.stringify({ schemaVersion: 1, reviewKey: 'b'.repeat(64) })));
  await page.reload();
  await expect(page.locator('#convergence-dialog')).toBeVisible();
  expect(await page.evaluate(() => window.calls.map(call => call.command))).toEqual(['convergence_status']);
});

for (const width of [1100, 390]) test(`explicit cleanup and completion stay readable at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  await load(page, { retirementReady: true });
  await page.locator('#convergence-prepare').click();
  await page.locator('#convergence-connections').click();
  await expect(page.locator('#convergence-retire')).toBeVisible();
  expect(await page.evaluate(() => window.calls.some(call => call.command === 'retire_convergence_apps'))).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('convergence-retirement-ready.png') });
  await page.locator('#convergence-retire').click();
  await expect(page.locator('#convergence-title')).toHaveText('Migration complete');
  await expect(page.locator('#convergence-summary')).toContainText('Settings and backups kept');
  await expect(page.locator('#convergence-retire')).not.toBeVisible();
  await expect(page.locator('#convergence-refresh')).not.toBeVisible();
  const overflow = await page.locator('#convergence-dialog').evaluate(node => node.scrollWidth > node.clientWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('convergence-complete.png') });
  await page.locator('#convergence-later').click();
  await expect(page.locator('#convergence-dialog')).not.toBeVisible();
});

test('partial cleanup is visible and Check again starts a fresh review', async ({ page }) => {
  await load(page, { retirementReady: true, pauseRetirement: true });
  await page.locator('#convergence-prepare').click();
  await page.locator('#convergence-connections').click();
  await page.locator('#convergence-retire').click();
  await expect(page.locator('#convergence-details')).toContainText('some app entries may already be retired');
  await expect(page.locator('#convergence-retire')).toBeEnabled();
  await page.locator('#convergence-refresh').click();
  await expect(page.locator('#convergence-title')).toHaveText('Move to unified Creator Hub');
  await expect(page.locator('#convergence-prepare')).toBeEnabled();
  await expect(page.locator('#convergence-retire')).not.toBeVisible();
  expect(await page.evaluate(() => window.calls.filter(call => call.command === 'retire_convergence_apps').length)).toBe(1);
});

test('first-launch convergence precedes app checks, automatic view restoration and navigation', async ({ page }) => {
  await load(page);
  await expect(page.locator('#convergence-dialog')).toBeVisible();
  expect(await page.evaluate(() => window.calls.map(call => call.command))).toEqual(['convergence_status']);
  await expect(page.locator('main')).toHaveAttribute('inert', '');
  await page.locator('#convergence-later').click();
  await expect(page.locator('#convergence-dialog')).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => window.calls.some(call => call.command === 'app_inventory'))).toBe(true);
  expect(await page.evaluate(() => window.calls.some(call => /prepare_convergence|migrate_convergence/.test(call.command)))).toBe(false);
});

test('fresh installation skips the migration prompt and performs no migration writes', async ({ page }) => {
  await load(page, { required: false });
  await expect.poll(() => page.evaluate(() => window.calls.some(call => call.command === 'app_inventory'))).toBe(true);
  await expect(page.locator('#convergence-dialog')).not.toBeVisible();
  expect(await page.evaluate(() => window.calls.filter(call => /convergence/.test(call.command)).map(call => call.command))).toEqual(['convergence_status']);
});

test('failed native backup stays retryable and never advances to connection changes', async ({ page }) => {
  await load(page, { failPrepare: true });
  await page.locator('#convergence-prepare').click();
  await expect(page.locator('#convergence-error')).toContainText('Settings changed');
  await expect(page.locator('#convergence-dialog')).toBeVisible();
  await expect(page.locator('#convergence-prepare')).toBeEnabled();
  await expect(page.locator('#convergence-connections')).not.toBeVisible();
  expect(await page.evaluate(() => window.calls.map(call => call.command))).toEqual(['convergence_status', 'prepare_convergence']);
});

test('in-flight native work cannot be dismissed or repeated', async ({ page }) => {
  await load(page, { holdPrepare: true });
  await page.locator('#convergence-prepare').click();
  await expect.poll(() => page.evaluate(() => typeof window.releasePrepare)).toBe('function');
  await expect(page.locator('#convergence-prepare')).toBeDisabled();
  await expect(page.locator('#convergence-later')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.locator('#convergence-dialog')).toBeVisible();
  await page.evaluate(() => window.releasePrepare());
  await expect(page.locator('#convergence-connections')).toBeVisible();
  expect(await page.evaluate(() => window.calls.filter(call => call.command === 'prepare_convergence').length)).toBe(1);
});

for (const viewport of [{ width: 1100, height: 785 }, { width: 390, height: 844 }]) {
  test(`centered convergence remains readable at ${viewport.width}px, without claiming cleanup`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await load(page);
    await page.locator('#convergence-prepare').click();
    await page.locator('#convergence-connections').click();
    await expect(page.locator('#convergence-summary')).toContainText('Cleanup verification is still pending');
    const geometry = await page.locator('#convergence-dialog').evaluate(node => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight, scroll: node.scrollWidth, client: node.clientWidth };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(10);
    expect(geometry.right).toBeLessThanOrEqual(geometry.width - 10);
    expect(geometry.top).toBeGreaterThanOrEqual(10);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.height - 10);
    expect(Math.abs(geometry.left - (geometry.width - geometry.right))).toBeLessThan(2);
    expect(geometry.scroll).toBeLessThanOrEqual(geometry.client);
    await page.screenshot({ path: testInfo.outputPath('convergence-reviewed-not-removed.png') });
    expect(await page.evaluate(() => window.calls.some(call => /uninstall|remove.*app/i.test(call.command)))).toBe(false);
  });
}
