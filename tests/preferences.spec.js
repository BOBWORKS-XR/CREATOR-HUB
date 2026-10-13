const { test, expect } = require('@playwright/test');

const fields = { preview: 'preview', 'auto-download': 'autoDownload', 'restore-hosted-views': 'restoreHostedViews' };
const off = { preview: false, autoDownload: false, restoreHostedViews: false };

async function loadNative(page, options = {}) {
  const state = { saved: options.saved === undefined ? { ...off } : options.saved,
    failRead: options.failRead, failKeys: new Set(), calls: [], holdWrites: false, pending: [] };
  await page.exposeFunction('preferencesNativeMock', async (command, args) => {
    state.calls.push({ command, args });
    if (command === 'usage_terms_status') return true;
    if (command === 'hub_preferences_status') {
      if (state.failRead) throw Error('Unsupported saved preference record');
      return state.saved;
    }
    if (command === 'set_hub_preference') {
      expect(Object.hasOwn(fields, args.key)).toBe(true);
      expect(typeof args.value).toBe('boolean');
      if (state.holdWrites) await new Promise(resolve => state.pending.push(resolve));
      if (state.failKeys.has(args.key)) throw Error('Preference write refused');
      state.saved ||= {};
      state.saved[fields[args.key]] = args.value;
      return null;
    }
    if (command === 'get_launch_request') return { view: 'hub', revision: 0 };
    if (command === 'pending_hosted_restore') return [];
    if (command === 'project_inventory') return { projects: [], warnings: [] };
    if (command === 'app_inventory') return { supported: true, apps: [] };
    if (command === 'hub_update_status') return { currentVersion: '0.1.13', availableVersion: '0.1.14', downloaded: false };
    return null;
  });
  await page.addInitScript(({ legacy, loseStorage }) => {
    window.__CREATOR_HUB_TERMS_PROTOCOL__ = 1;
    window.__CREATOR_HUB_PREFERENCES_PROTOCOL__ = 1;
    window.__TAURI__ = { core: { invoke: (command, args) => window.preferencesNativeMock(command, args) },
      event: { listen: async () => () => {} } };
    if (loseStorage) localStorage.clear();
    for (const [key, value] of Object.entries(legacy || {})) localStorage.setItem(`creator-hub.${key}`, value);
  }, { legacy: options.legacy, loseStorage: options.loseStorage });
  await page.goto('http://127.0.0.1:4188');
  await expect.poll(() => state.calls.some(call => call.command === 'app_inventory' && call.args.check)).toBe(true);
  return state;
}

test('native preferences win over stale browser values and survive lost browser storage', async ({ page }) => {
  const state = await loadNative(page, { legacy: { preview: 'true', 'auto-download': 'true', 'restore-hosted-views': 'true' }, loseStorage: true });
  for (const id of ['preview-channel', 'auto-download', 'restore-hosted-views']) await expect(page.locator(`#${id}`)).not.toBeChecked();
  expect(state.calls.some(call => call.command === 'set_hub_preference')).toBe(false);
  await page.locator('#auto-download').check();
  await expect.poll(() => state.saved.autoDownload).toBe(true);
  await expect(page.locator('#auto-download')).toBeEnabled();
  await page.locator('#auto-download').uncheck();
  await expect.poll(() => state.saved.autoDownload).toBe(false);
  await page.reload();
  await expect.poll(() => state.calls.filter(call => call.command === 'hub_preferences_status').length).toBe(2);
  await expect(page.locator('#auto-download')).not.toBeChecked();
  expect(state.calls.filter(call => call.command === 'set_hub_preference')).toHaveLength(2);
});

test('missing native preferences migrate each legacy choice before discovery', async ({ page }) => {
  const state = await loadNative(page, { saved: null,
    legacy: { preview: 'false', 'auto-download': 'false', 'restore-hosted-views': 'true' } });
  expect(state.saved).toEqual({ preview: false, autoDownload: false, restoreHostedViews: true });
  const writes = state.calls.filter(call => call.command === 'set_hub_preference');
  expect(writes.map(call => call.args)).toEqual([
    { key: 'preview', value: false }, { key: 'auto-download', value: false }, { key: 'restore-hosted-views', value: true },
  ]);
  expect(state.calls.findIndex(call => call.command === 'app_inventory')).toBeGreaterThan(state.calls.findLastIndex(call => call.command === 'set_hub_preference'));
  expect(state.calls.some(call => call.command === 'download_hub_update')).toBe(false);
});

test('a partial native record preserves saved false values during migration', async ({ page }) => {
  const state = await loadNative(page, { saved: { autoDownload: false }, legacy: { 'auto-download': 'true' } });
  expect(state.saved).toEqual({ preview: true, autoDownload: false, restoreHostedViews: true });
  expect(state.calls.filter(call => call.command === 'set_hub_preference').map(call => call.args.key)).toEqual(['preview', 'restore-hosted-views']);
  await expect(page.locator('#auto-download')).not.toBeChecked();
});

test('failed reads keep automation off and preserve records while manual checks remain usable', async ({ page }) => {
  const state = await loadNative(page, { saved: { preview: true, autoDownload: true, restoreHostedViews: true }, failRead: true });
  await expect(page.locator('#preferences-status')).toContainText('Automatic downloads are off');
  for (const id of ['preview-channel', 'auto-download', 'restore-hosted-views']) {
    await expect(page.locator(`#${id}`)).not.toBeChecked();
    await expect(page.locator(`#${id}`)).toBeDisabled();
  }
  await page.locator('#check-updates').click();
  expect(state.calls.some(call => call.command === 'download_hub_update')).toBe(false);
  expect(state.calls.some(call => call.command === 'set_hub_preference')).toBe(false);
  expect(state.saved).toEqual({ preview: true, autoDownload: true, restoreHostedViews: true });
});

for (const saved of [{ autoDownload: 'false' }, { preview: null, restoreHostedViews: 'invalid' }, { future: true }]) {
  test(`invalid native preference response is rejected before any migration: ${JSON.stringify(saved)}`, async ({ page }) => {
    const state = await loadNative(page, { saved });
    await expect(page.locator('#preferences-status')).toContainText('Invalid saved Hub preferences');
    expect(state.calls.some(call => call.command === 'set_hub_preference')).toBe(false);
    expect(state.calls.some(call => call.command === 'download_hub_update')).toBe(false);
  });
}

test('failed saves cannot enable automation or hide another unsaved choice', async ({ page }) => {
  const state = await loadNative(page);
  state.failKeys.add('auto-download');
  await page.locator('#auto-download').click();
  await expect(page.locator('#preferences-status')).toContainText('Download verified updates automatically could not be saved');
  await expect(page.locator('#auto-download')).not.toBeChecked();
  await page.locator('#restore-hosted-views').check();
  await expect.poll(() => state.saved.restoreHostedViews).toBe(true);
  await expect(page.locator('#preferences-status')).toContainText('Download verified updates automatically could not be saved');
  await page.locator('#check-updates').click();
  expect(state.calls.some(call => call.command === 'download_hub_update')).toBe(false);
  state.failKeys.clear();
  await page.locator('#auto-download').check();
  await expect(page.locator('#preferences-status')).toBeHidden();
});

test('a failed attempt to disable downloads keeps them off for this session', async ({ page }) => {
  const state = await loadNative(page, { saved: { ...off, autoDownload: true } });
  state.calls.length = 0;
  state.failKeys.add('auto-download');
  await page.locator('#auto-download').uncheck();
  await expect(page.locator('#preferences-status')).toContainText('It is off for this session');
  expect(state.saved.autoDownload).toBe(true);
  await page.locator('#check-updates').click();
  expect(state.calls.some(call => call.command === 'download_hub_update')).toBe(false);
});

test('pending preference writes prevent automatic downloads and updater installation', async ({ page }) => {
  const state = await loadNative(page);
  state.holdWrites = true;
  await page.locator('#auto-download').check();
  await expect.poll(() => state.pending.length).toBe(1);
  await expect(page.locator('#auto-download')).toBeDisabled();
  await expect(page.locator('#hub-update-button')).toBeDisabled();
  await page.locator('#check-updates').click();
  expect(state.calls.some(call => call.command === 'download_hub_update')).toBe(false);
  state.holdWrites = false;
  state.pending.shift()();
  await expect(page.locator('#auto-download')).toBeEnabled();
  await expect.poll(() => state.saved.autoDownload).toBe(true);
});
