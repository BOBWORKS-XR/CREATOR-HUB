const { test, expect } = require('@playwright/test');

async function load(page, phase = 'available') {
  const state = { calls: [], errors: [], status: { mode: 'bootstrap', phase,
    message: phase === 'recovery' ? 'An interrupted native setup needs review.' : 'Native support is not installed.' } };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.exposeFunction('nativeSupportFixture', (command, args) => {
    state.calls.push({ command, args });
    if (command === 'native_support_status') return state.status;
    if (command === 'cancel_download') return null;
    if (['install_native_support', 'review_native_support_recovery'].includes(command)) {
      return new Promise((resolve, reject) => {
        state.finish = resolve;
        state.refuse = message => reject(Error(message));
      });
    }
    throw Error(`Unexpected setup command: ${command}`);
  });
  await page.addInitScript(() => {
    localStorage.setItem('creator-usage-terms.hub', JSON.stringify({ policyVersion: '2026-09-28-v1', acceptedAt: '2026-09-28T00:00:00.000Z' }));
    window.__CREATOR_HUB_FEATURE_PROTOCOL__ = 1;
    window.__CREATOR_HUB_VERSION__ = '0.1.16';
    window.__CREATOR_HUB_NATIVE_SUPPORT_PROTOCOL__ = 1;
    window.supportEvents = {};
    window.__TAURI__ = {
      core: { invoke: (command, args) => window.nativeSupportFixture(command, args) },
      event: { listen: async (name, handler) => { window.supportEvents[name] = handler; return () => {}; } },
    };
  });
  await page.goto('http://127.0.0.1:4188');
  await expect(page.locator('#native-support-status')).toHaveText(state.status.message);
  await expect(page.locator('#native-support-check')).toBeEnabled();
  await expect(page.locator('#platform-status')).toHaveText('Linux');
  await expect(page.locator('.footer-version')).toHaveText('0.1.16');
  expect(state.calls.map(call => call.command)).toEqual(['native_support_status']);
  expect(state.errors).toEqual([]);
  return state;
}

test('bootstrap shows only native support and never runs normal migration or feature discovery', async ({ page }) => {
  const state = await load(page);
  await expect(page.locator('#native-support-install')).toBeEnabled();
  await expect(page.locator('#native-support-recover')).toBeHidden();
  await expect(page.locator('#hub-pages')).toBeHidden();
  await expect(page.locator('#suite-shell')).toBeHidden();
  await expect(page.locator('#convergence-reopen')).toBeHidden();
  await expect(page.locator('#hub-update-button')).toBeHidden();
  await expect(page.locator('#convergence-dialog')).not.toBeVisible();
  await page.waitForTimeout(100);
  expect(state.calls).toHaveLength(1);
});

test('install is one explicit command, stays busy and cancellation never claims completion', async ({ page }) => {
  const state = await load(page);
  await page.locator('#native-support-install').click();
  await expect.poll(() => typeof state.finish).toBe('function');
  await expect(page.locator('#native-support-install')).toBeDisabled();
  await expect(page.locator('#native-support-check')).toBeDisabled();
  await page.locator('#native-support-install').dispatchEvent('click');
  expect(state.calls.map(call => call.command)).toEqual(['native_support_status', 'install_native_support']);
  state.finish({ mode: 'bootstrap', phase: 'available', message: 'Setup cancelled. No native support was installed.' });
  await expect(page.locator('#native-support-install')).toBeEnabled();
  await expect(page.locator('#native-support-status')).toContainText('cancelled');
  expect(state.calls).toHaveLength(2);
  expect(state.errors).toEqual([]);
});

test('interrupted setup requires its distinct explicit review action, not install replay', async ({ page }) => {
  const state = await load(page, 'recovery');
  await expect(page.locator('#native-support-install')).toBeHidden();
  await page.locator('#native-support-recover').click();
  await expect.poll(() => typeof state.finish).toBe('function');
  await expect(page.locator('#native-support-recover')).toBeDisabled();
  state.finish({ mode: 'bootstrap', phase: 'complete', message: 'Native support is ready. Close this window and reopen Hub from Flatpak.' });
  await expect(page.locator('#native-support-status')).toContainText('Close this window');
  await expect(page.locator('#native-support-recover')).toBeHidden();
  await expect(page.locator('#native-support-install')).toBeHidden();
  expect(state.calls.map(call => call.command)).toEqual(['native_support_status', 'review_native_support_recovery']);
});

test('unknown outcome blocks install until an explicit read-only recheck, with no automatic retry', async ({ page }) => {
  const state = await load(page);
  await page.locator('#native-support-install').click();
  await expect.poll(() => typeof state.refuse).toBe('function');
  state.refuse('Setup completion could not be confirmed. Keep the recovery evidence.');
  await expect(page.locator('#native-support-error')).toContainText('could not be confirmed');
  await expect(page.locator('#native-support-install')).toBeHidden();
  state.status = { mode: 'bootstrap', phase: 'recovery', message: 'Review the interrupted setup before continuing.' };
  await page.locator('#native-support-check').click();
  await expect(page.locator('#native-support-recover')).toBeEnabled();
  expect(state.calls.map(call => call.command)).toEqual(['native_support_status', 'install_native_support', 'native_support_status']);
});

test('download cancellation sends only cancellation and never another installation request', async ({ page }) => {
  const state = await load(page);
  await page.locator('#native-support-install').click();
  await expect.poll(() => typeof state.finish).toBe('function');
  await page.evaluate(() => window.supportEvents['app-progress']({ payload: { message: 'Downloading verified native support...', cancellable: true } }));
  await expect(page.locator('#native-support-cancel')).toBeVisible();
  await page.locator('#native-support-cancel').click();
  await expect(page.locator('#native-support-cancel')).toBeDisabled();
  await page.locator('#native-support-cancel').dispatchEvent('click');
  state.finish({ mode: 'bootstrap', phase: 'available', message: 'Download cancelled. Existing settings were kept.' });
  await expect(page.locator('#native-support-cancel')).toBeHidden();
  expect(state.calls.map(call => call.command)).toEqual(['native_support_status', 'install_native_support', 'cancel_download']);
});

for (const width of [360, 940]) {
  test(`native setup fits a ${width}px window without clipped text`, async ({ page }) => {
    await page.setViewportSize({ width, height: 580 });
    await load(page);
    await expect(page.locator('#native-support-title')).toBeInViewport();
    await expect(page.locator('#native-support-install')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const button = page.locator('#native-support-install');
    expect(await button.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: `test-results/native-support-${width}.png`, fullPage: true });
  });
}
