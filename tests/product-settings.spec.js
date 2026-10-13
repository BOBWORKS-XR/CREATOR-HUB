const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const script = fs.readFileSync(path.resolve(__dirname, '../modules/mcp/launcher/src/product-settings.js'), 'utf8');

async function open(page, options = {}) {
  await page.setContent('<fieldset id="workspaceControls"><div class="setup-form"></div></fieldset>');
  await page.evaluate(options => {
    window.calls = [];
    window.workflows = 0;
    window.CreatorMcpOperations = { run: async action => { window.workflows++; return action(); } };
    window.CreatorRuntime = {
      ready: Promise.resolve(), hosted: options.hosted !== false, readOnly: Boolean(options.readOnly), builtIn: options.builtIn !== false,
      invoke: async command => {
        window.calls.push(command);
        if (options.error) throw new Error('Product settings changed during review. Nothing was overwritten.');
        if (command === 'review_product_settings') return { status: options.status || 'conflict', backups: ['C:\\Retained\\current.bak', 'C:\\Retained\\legacy.bak'], recovery: [], evidencePath: 'C:\\Config\\creator-works-mcp\\.creator-hub-product-settings' };
        return { status: options.status || 'conflict', backups: [], recovery: options.recovery ? [{ historical_completed: false }] : [], evidencePath: 'C:\\Config\\creator-works-mcp\\.creator-hub-product-settings' };
      },
    };
  }, options);
  await page.addScriptTag({ content: script });
}

test('conflict is explicit and backups require a separate owned user action', async ({ page }) => {
  await open(page);
  const button = page.getByRole('button', { name: 'Review saved MCP settings' });
  await expect(button).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Both originals are kept.');
  expect(await page.evaluate(() => window.calls)).toEqual(['product_settings_status']);
  await button.click();
  await expect(page.getByRole('status')).toContainText('Exact backups are retained.');
  expect(await page.evaluate(() => window.calls)).toEqual(['product_settings_status', 'review_product_settings']);
  expect(await page.evaluate(() => window.workflows)).toBe(1);
});

for (const options of [{ hosted: false }, { readOnly: true }, { builtIn: false }]) {
  test(`no settings reads or actions outside a writable built-in ${JSON.stringify(options)}`, async ({ page }) => {
    await open(page, options);
    await expect(page.getByRole('button')).toHaveCount(0);
    expect(await page.evaluate(() => window.calls)).toEqual([]);
  });
}

test('legacy location is retained with no automatic copy or save command', async ({ page }) => {
  await open(page, { status: 'legacy-only' });
  await expect(page.getByRole('status')).toContainText('existing location');
  expect(await page.evaluate(() => window.calls)).toEqual(['product_settings_status']);
});

test('interrupted save remains reviewable without blind rollback', async ({ page }) => {
  await open(page, { status: 'current', recovery: true });
  await expect(page.getByRole('status')).toContainText('No automatic rollback');
  await expect(page.getByRole('button')).toBeVisible();
  expect(await page.evaluate(() => window.calls)).toEqual(['product_settings_status']);
  await page.getByRole('button').click();
  await expect(page.getByRole('status')).toContainText('Reopen MCP to reload saved settings.');
  await expect(page.getByRole('button')).toBeHidden();
});

test('unavailable status fails closed with no actionable control', async ({ page }) => {
  await open(page, { error: true });
  await expect(page.getByRole('status')).toContainText('Nothing was overwritten');
  await expect(page.getByRole('button')).toBeHidden();
});

for (const width of [390, 940]) {
  test(`settings paths wrap within ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 580 });
    await open(page);
    await expect(page.getByRole('button')).toBeVisible();
    // Exercise the host's real stylesheet instead of relying on the test browser defaults.
    await page.addStyleTag({ content: fs.readFileSync(path.resolve(__dirname, '../modules/mcp/launcher/src/styles.css'), 'utf8') });
    await expect(page.getByRole('status')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/product-settings-ui-${width}.png` });
  });
}
