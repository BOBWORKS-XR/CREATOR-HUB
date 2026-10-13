const { test, expect } = require('@playwright/test');

const POLICY = '2026-09-28-v1';
const KEY = 'creator-usage-terms.hub';

async function loadNative(page, { accepted = false, legacy = false, loseBrowserStorage = false, failRead = false, failSave = false } = {}) {
  const state = { accepted, failRead, failSave, calls: [] };
  await page.exposeFunction('termsNativeMock', async (command, args) => {
    state.calls.push({ command, args });
    if (command === 'usage_terms_status') {
      if (state.failRead) throw Error('Invalid native acknowledgement');
      return state.accepted;
    }
    if (command === 'accept_usage_terms') {
      if (state.failSave) throw Error('Native storage is unavailable');
      expect(args).toEqual({ policyVersion: POLICY, accepted: true });
      state.accepted = true;
      return null;
    }
    if (command === 'get_launch_request') return { view: 'hub', revision: 0 };
    if (command === 'pending_hosted_restore') return [];
    if (command === 'project_inventory') return { projects: [], warnings: [] };
    if (command === 'app_inventory') return { supported: true, apps: [] };
    if (command === 'hub_update_status') return { currentVersion: '0.1.13', availableVersion: null, downloaded: false };
    return null;
  });
  await page.addInitScript(({ legacy, loseBrowserStorage, key, policy }) => {
    window.__CREATOR_HUB_TERMS_PROTOCOL__ = 1;
    window.__TAURI__ = {
      core: { invoke: (command, args) => window.termsNativeMock(command, args) },
      event: { listen: async () => () => {} },
    };
    if (loseBrowserStorage) localStorage.removeItem(key);
    if (legacy) localStorage.setItem(key, JSON.stringify({ policyVersion: policy, acceptedAt: '2026-09-28T00:00:00.000Z' }));
  }, { legacy, loseBrowserStorage, key: KEY, policy: POLICY });
  await page.goto('http://127.0.0.1:4188');
  return state;
}

test('native acknowledgement survives a relaunch with lost browser storage', async ({ page }) => {
  const state = await loadNative(page, { loseBrowserStorage: true });
  const dialog = page.locator('#usage-terms-dialog');
  await expect(dialog).toBeVisible();
  expect(state.calls.some(call => call.command === 'app_inventory')).toBe(false);
  await page.locator('#usage-terms-checkbox').check();
  await page.locator('#usage-terms-continue').click();
  await expect(dialog).toBeHidden();
  expect(state.accepted).toBe(true);
  await page.reload();
  await expect.poll(() => state.calls.filter(call => call.command === 'usage_terms_status').length).toBe(2);
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe(null);
  expect(state.calls.filter(call => call.command === 'accept_usage_terms')).toHaveLength(1);
});

test('an existing accepted policy is durably migrated without a new prompt', async ({ page }) => {
  const state = await loadNative(page, { legacy: true });
  await expect.poll(() => state.accepted).toBe(true);
  await expect(page.locator('#usage-terms-dialog')).toBeHidden();
  expect(state.calls.slice(0, 2).map(call => call.command)).toEqual(['usage_terms_status', 'accept_usage_terms']);
});

test('a successful native save unlocks even when the browser store cannot write', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw Error('Browser storage is unavailable'); };
  });
  const state = await loadNative(page);
  await expect(page.locator('#usage-terms-dialog')).toBeVisible();
  await page.locator('#usage-terms-checkbox').check();
  await page.locator('#usage-terms-continue').click();
  await expect(page.locator('#usage-terms-dialog')).toBeHidden();
  expect(state.accepted).toBe(true);
  await page.reload();
  await expect.poll(() => state.calls.filter(call => call.command === 'usage_terms_status').length).toBe(2);
  await expect(page.locator('#usage-terms-dialog')).toBeHidden();
});

test('native write failure keeps controls locked and permits a clear retry', async ({ page }) => {
  const state = await loadNative(page, { failSave: true });
  await expect(page.locator('#usage-terms-dialog')).toBeVisible();
  await page.locator('#usage-terms-checkbox').check();
  await page.locator('#usage-terms-continue').click();
  await expect(page.locator('#usage-terms-error')).toContainText('Native storage is unavailable');
  await expect(page.locator('#usage-terms-dialog')).toBeVisible();
  expect(state.accepted).toBe(false);
  expect(state.calls.some(call => call.command === 'app_inventory')).toBe(false);
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe(null);
  state.failSave = false;
  await page.locator('#usage-terms-continue').click();
  await expect(page.locator('#usage-terms-dialog')).toBeHidden();
  await expect.poll(() => state.calls.some(call => call.command === 'app_inventory')).toBe(true);
});

test('invalid native record requires explicit acknowledgement instead of silently trusting browser storage', async ({ page }) => {
  const state = await loadNative(page, { legacy: true, failRead: true });
  await expect(page.locator('#usage-terms-dialog')).toBeVisible();
  await expect(page.locator('#usage-terms-error')).toContainText('Invalid native acknowledgement');
  expect(state.calls.some(call => call.command === 'accept_usage_terms')).toBe(false);
  await page.locator('#usage-terms-checkbox').check();
  await page.locator('#usage-terms-continue').click();
  await expect(page.locator('#usage-terms-dialog')).toBeHidden();
  expect(state.accepted).toBe(true);
});

test('a refused native policy downgrade does not overwrite a legacy browser acknowledgement', async ({ page }) => {
  const state = await loadNative(page, { legacy: true, failRead: true, failSave: true });
  const before = await page.evaluate(key => localStorage.getItem(key), KEY);
  await expect(page.locator('#usage-terms-dialog')).toBeVisible();
  expect(state.calls.some(call => call.command === 'accept_usage_terms')).toBe(false);
  await page.locator('#usage-terms-checkbox').check();
  await page.locator('#usage-terms-continue').click();
  await expect(page.locator('#usage-terms-error')).toContainText('Native storage is unavailable');
  await expect(page.locator('#usage-terms-dialog')).toBeVisible();
  expect(state.calls.some(call => call.command === 'app_inventory')).toBe(false);
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe(before);
});
