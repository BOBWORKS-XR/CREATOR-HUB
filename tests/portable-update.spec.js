// Executes the shipped UI/controller with a held native-command boundary.
// Backend preparation/approval/restart ordering is tested by portable_update's
// run_install tests; this browser fixture does not claim native installation.
const { test, expect } = require('@playwright/test');

async function load(page, { recovery = false } = {}) {
  const state = { calls: [], errors: [], update: { currentVersion: '0.1.16', availableVersion: '0.1.17',
    downloaded: false, installBlocked: null, warning: null }, recovery: { retained: false, message: null } };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.exposeFunction('portableUpdateNativeFixture', async (command, args) => {
    state.calls.push({ command, args });
    switch (command) {
      case 'get_launch_request': return { view: 'hub', revision: 0 };
      case 'feature_status': return { integrated: true, features: ['setup', 'mcp'] };
      case 'feature_select': return null;
      case 'convergence_status':
        if (state.recovery.retained) throw Error('Another Hub operation is already running.');
        return { enabled: false, required: false, stage: 'review', settings: [], backups: [], legacyApps: [], message: '' };
      case 'hub_preferences_status': return { preview: false, autoDownload: false, restoreHostedViews: true };
      case 'app_inventory':
        if (state.recovery.retained) throw Error('Another Hub operation is already running.');
        return { supported: true, apps: [] };
      case 'project_inventory': return { projects: [], warnings: [] };
      case 'hub_update_status':
        if (state.recovery.retained) throw Error('Another Hub operation is already running.');
        return state.update;
      case 'hub_update_recovery_status': return state.recovery;
      case 'review_retained_hub_update': return new Promise((resolve, reject) => {
        state.finishReview = resolve;
        state.refuseReview = message => reject(Error(message));
      });
      case 'pending_hosted_restore': return [];
      case 'cancel_download': return null;
      case 'install_hub_update': return new Promise((resolve, reject) => {
        state.finish = resolve;
        state.refuse = message => reject(Error(message));
      });
      default: throw Error(`Unexpected fixture command: ${command}`);
    }
  });
  await page.addInitScript(({ recovery }) => {
    localStorage.setItem('creator-usage-terms.hub', JSON.stringify({ policyVersion: '2026-09-28-v1', acceptedAt: '2026-09-28T00:00:00.000Z' }));
    window.__CREATOR_HUB_FEATURE_PROTOCOL__ = 1;
    window.__CREATOR_HUB_PREFERENCES_PROTOCOL__ = 1;
    if (recovery) {
      window.__CREATOR_HUB_UPDATE_RECOVERY_PROTOCOL__ = 1;
      window.__CREATOR_HUB_CONVERGENCE_PROTOCOL__ = 1;
    }
    window.events = {};
    window.__TAURI__ = {
      core: { invoke: (command, args) => window.portableUpdateNativeFixture(command, args) },
      event: { listen: async (name, handler) => { window.events[name] = handler; return () => {}; } },
    };
  }, { recovery });
  await page.goto('http://127.0.0.1:4188');
  await expect(page.locator('#hub-update-button')).toBeEnabled();
  await expect(page.locator('#check-updates')).toBeEnabled();
  await expect(page.locator('#hub-update-status')).toHaveText('Version 0.1.17 is available.');
  await expect(page.locator('#auto-download')).not.toBeChecked();
  expect(state.calls.some(c => c.command === 'download_hub_update')).toBe(false);
  expect(state.errors).toEqual([]);
  await expect(page.locator('#hub-update-review')).toBeHidden();
  return state;
}

async function progress(page, message, cancellable) {
  await page.evaluate(({ message, cancellable }) => window.events['app-progress']({ payload: {
    message, received: cancellable ? 5 : 0, total: cancellable ? 10 : 0, cancellable,
  } }), { message, cancellable });
}

test('automatic downloads off: Update Hub makes one direct install call and stays busy during preparation', async ({ page }) => {
  const state = await load(page);
  await page.locator('#hub-update-button').click();
  await expect.poll(() => typeof state.finish).toBe('function');
  await expect(page.locator('#hub-update-button')).toBeDisabled();
  await page.locator('#hub-update-button').dispatchEvent('click');
  await progress(page, 'Downloading portable Creator Hub 0.1.17', true);
  await expect(page.locator('#progress-message')).toHaveText('Downloading portable Creator Hub 0.1.17');
  await expect(page.locator('#cancel-download')).toBeVisible();
  expect(state.calls.filter(c => c.command === 'install_hub_update')).toEqual([
    { command: 'install_hub_update', args: { version: '0.1.17', restoreViews: true } },
  ]);
  expect(state.calls.some(c => c.command === 'download_hub_update')).toBe(false);
  state.update.downloaded = true;
  await progress(page, 'Portable download verified. Waiting for update approval...', false);
  await expect(page.locator('#cancel-download')).toBeHidden();
  await expect(page.locator('#hub-update-button')).toBeDisabled();
  state.finish('Portable update cancelled. Selection and settings were kept; nothing was installed.');
  await expect(page.locator('#hub-update-button')).toBeEnabled();
  await expect(page.locator('#progress-message')).toContainText('cancelled');
  await expect(page.locator('#hub-update-status')).toHaveText('Version 0.1.17 is ready to install.');
  expect(state.update.currentVersion).toBe('0.1.16');
  expect(state.errors).toEqual([]);
});

for (const resolution of ['authenticated abort', 'safe peer EOF']) {
  test(`retained Unknown can be reviewed after Manager calls fail, then ${resolution} releases without update replay`, async ({ page }) => {
    const state = await load(page, { recovery: true });
    await page.locator('#hub-update-button').click();
    await expect.poll(() => typeof state.refuse).toBe('function');
    state.recovery = { retained: true, message: 'Exit authorization is unresolved. Keep Hub open and review the retained update.' };
    state.refuse(state.recovery.message);
    await expect(page.locator('#hub-update-review')).toBeVisible();
    await expect(page.locator('#hub-update-button')).toBeDisabled();
    await expect(page.locator('#hub-update-warning')).toContainText('unresolved');
    const beforeReview = state.calls.length;
    await page.locator('#hub-update-review').click();
    await expect.poll(() => typeof state.refuseReview).toBe('function');
    await expect(page.locator('#hub-update-review')).toBeDisabled();
    await page.locator('#hub-update-review').dispatchEvent('click');
    expect(state.calls.filter(c => c.command === 'review_retained_hub_update')).toHaveLength(1);
    state.refuseReview('Abort remains unresolved. The retained close lease was kept.');
    await expect(page.locator('#hub-update-review')).toBeEnabled();
    await expect(page.locator('#action-error')).toContainText('Abort remains unresolved');
    state.finishReview = null; state.refuseReview = null;
    await page.locator('#hub-update-review').click();
    await expect.poll(() => typeof state.finishReview).toBe('function');
    const safe = { retained: false, message: `Review observed ${resolution}. You can close Hub normally. Reopen through its helper before updating.` };
    state.recovery = safe;
    state.finishReview(safe);
    await expect(page.locator('#hub-update-review')).toBeHidden();
    await expect(page.locator('#hub-update-button')).toBeDisabled();
    await expect(page.locator('#hub-update-warning')).toContainText('Reopen through its helper');
    await expect(page.locator('#progress-message')).toContainText('close Hub normally');
    await page.locator('#hub-update-review').dispatchEvent('click');
    expect(state.calls.slice(beforeReview).map(c => c.command)).toEqual([
      'review_retained_hub_update', 'review_retained_hub_update',
    ]);
    expect(state.calls.filter(c => c.command === 'install_hub_update')).toHaveLength(1);
    expect(state.calls.some(c => c.command === 'download_hub_update')).toBe(false);
    expect(state.update.currentVersion).toBe('0.1.16');
    expect(state.errors).toEqual([]);
  });
}

test('native recovery capability absent: control stays hidden and recovery commands are never invoked', async ({ page }) => {
  const state = await load(page);
  state.recovery = { retained: true, message: 'This unsupported fixture must not enable recovery.' };
  await page.locator('#hub-update-review').dispatchEvent('click');
  expect(state.calls.some(c => c.command.includes('recovery') || c.command === 'review_retained_hub_update')).toBe(false);
  await expect(page.locator('#hub-update-review')).toBeHidden();
  expect(state.errors).toEqual([]);
});

test('renderer reload exposes retained recovery before blocked migration and does not resume startup after release', async ({ page }) => {
  const state = await load(page, { recovery: true });
  state.recovery = { retained: true, message: 'Exit authorization is unresolved. Review the retained update.' };
  const beforeReload = state.calls.length;
  await page.reload();
  await expect(page.locator('#hub-update-review')).toBeVisible();
  await expect(page.locator('#hub-update-button')).toBeDisabled();
  await expect(page.locator('#convergence-dialog')).not.toBeVisible();
  expect(state.calls.slice(beforeReload).some(c => ['hub_preferences_status', 'convergence_status',
    'app_inventory', 'hub_update_status', 'pending_hosted_restore', 'install_hub_update', 'download_hub_update'].includes(c.command))).toBe(false);
  await page.locator('#hub-update-review').click();
  await expect.poll(() => typeof state.finishReview).toBe('function');
  const safe = { retained: false, message: 'Safe peer closure was observed. Close normally and reopen through the helper before updating.' };
  state.recovery = safe;
  state.finishReview(safe);
  await expect(page.locator('#hub-update-review')).toBeHidden();
  await expect(page.locator('#hub-update-button')).toBeDisabled();
  expect(state.calls.slice(beforeReload).filter(c => c.command === 'review_retained_hub_update')).toHaveLength(1);
  expect(state.calls.slice(beforeReload).some(c => ['convergence_status', 'app_inventory', 'hub_update_status',
    'install_hub_update', 'download_hub_update'].includes(c.command))).toBe(false);
  expect(state.errors).toEqual([]);
});

test('download cancellation from the real UI never reports an installed update or retries install', async ({ page }) => {
  const state = await load(page);
  await page.locator('#hub-update-button').click();
  await expect.poll(() => typeof state.refuse).toBe('function');
  await progress(page, 'Downloading portable Creator Hub 0.1.17', true);
  await page.locator('#cancel-download').click();
  await expect.poll(() => state.calls.filter(c => c.command === 'cancel_download').length).toBe(1);
  state.refuse('Portable download cancelled. Nothing was staged or installed.');
  await expect(page.locator('#hub-update-button')).toBeEnabled();
  await expect(page.locator('#action-error')).toContainText('Portable download cancelled');
  await expect(page.locator('#hub-update-status')).toHaveText('Version 0.1.17 is available.');
  expect(state.calls.filter(c => c.command === 'install_hub_update')).toHaveLength(1);
  expect(state.update).toMatchObject({ currentVersion: '0.1.16', downloaded: false });
});

test('verification refusal stays an error; staged handoff never changes the displayed installed version', async ({ page }) => {
  const state = await load(page);
  await page.locator('#hub-update-button').click();
  await expect.poll(() => typeof state.refuse).toBe('function');
  state.refuse('Portable signature verification failed. Nothing was staged or installed.');
  await expect(page.locator('#action-error')).toContainText('signature verification failed');
  await expect(page.locator('#hub-update-button')).toBeEnabled();
  state.finish = null; state.refuse = null;
  await page.locator('#hub-update-button').click();
  await expect.poll(() => typeof state.finish).toBe('function');
  state.update.downloaded = true;
  await progress(page, 'Portable update staged. Preparing normal Hub exit...', false);
  await expect(page.locator('#progress-message')).toContainText('staged');
  await expect(page.locator('#hub-update-status')).not.toContainText('using Hub 0.1.17');
  state.finish('Portable update staged. Hub is closing normally; its helper will select the new generation only after this Hub exits.');
  await expect(page.locator('#hub-update-button')).toBeEnabled();
  await expect(page.locator('#progress-message')).toContainText('only after this Hub exits');
  expect(state.update.currentVersion).toBe('0.1.16');
  expect(state.calls.filter(c => c.command === 'install_hub_update')).toHaveLength(2);
  expect(state.errors).toEqual([]);
});
