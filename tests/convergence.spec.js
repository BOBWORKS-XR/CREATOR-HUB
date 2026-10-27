const { test, expect } = require('@playwright/test');

async function load(page, { required = true, failPrepare = false, holdPrepare = false, retirementReady = false, pauseRetirement = false, reviewKey = 'a'.repeat(64), streamlined = false, failPhase = '', nativeCancel = false, holdMove = false, uncertain = false, invalidComplete = false, initialRecovery = null, settingsImportAvailable = false } = {}) {
  await page.addInitScript(({ required, failPrepare, holdPrepare, retirementReady, pauseRetirement, reviewKey, streamlined, failPhase, nativeCancel, holdMove, uncertain, invalidComplete, initialRecovery, settingsImportAvailable }) => {
    localStorage.setItem('creator-usage-terms.hub', JSON.stringify({ policyVersion: '2026-09-28-v1', acceptedAt: '2026-09-28T00:00:00.000Z' }));
    localStorage.setItem('creator-hub.auto-download', 'false');
    window.__CREATOR_HUB_CONVERGENCE_PROTOCOL__ = 1;
    window.__CREATOR_HUB_FEATURE_PROTOCOL__ = streamlined ? 1 : 0;
    window.calls = [];
    window.report = {
      enabled: true, required, stage: 'review', settings: ['MCP project selection and options'],
      legacyApps: required ? [{ name: 'Creator Works MCP', path: 'C:/fixture-only/Creator Works MCP/launcher.exe' }] : [],
      backups: [], retirementAvailable: false, message: 'Your saved projects and settings stay where they are.',
      reviewKey,
      streamlined, moveAvailable: !initialRecovery, recoveryHelp: initialRecovery, settingsImportAvailable,
    };
    window.__TAURI__ = {
      event: { listen: async (name, callback) => {
        if (name === 'convergence-progress') window.progress = callback;
        return () => {};
      } },
      core: { invoke: async (command, args) => {
        window.calls.push({ command, args });
        if (command === 'convergence_status') return window.report;
        if (command === 'move_to_hub') {
          window.phases = [];
          if (holdMove) await new Promise(resolve => { window.releaseMove = resolve; });
          if (nativeCancel) return { outcome: 'cancelled', phase: 'review', report: window.report, message: 'Native review cancelled. Settings, clients and installations were not changed.' };
          for (const phase of ['backup', 'connections', 'cleanup']) {
            window.phases.push(phase); window.progress?.({ payload: phase });
            if (phase === failPhase) {
              window.report = { ...window.report, stage: phase === 'backup' ? 'review' : phase === 'connections' ? 'backed-up' : 'connections-reviewed',
                backups: phase === 'backup' ? [] : ['C:/fixture-only/original.bak'], moveAvailable: false,
                recoveryHelp: uncertain ? `Last migration phase: ${phase}\nRetained phase record: C:/fixture-only/convergence/move-v1.json\nChoose Not now to keep using Hub. Migration remains incomplete.\nHave support review the retained phase record before removing an app.` : null };
              return { outcome: 'stopped', phase, report: window.report,
                message: `Migration stopped during ${phase}. Settings and backups retained.${phase === 'cleanup' && uncertain ? ' Cleanup may be partial.' : ' Standalone cleanup was not started.'} No automatic retry.` };
            }
          }
          window.report = { ...window.report, stage: 'complete', required: false, legacyApps: invalidComplete ? window.report.legacyApps : [], retirementAvailable: false,
            backups: Array.from({ length: 30 }, (_, index) => `C:/fixture-only/backups/exact-before-image-${index}.bak`) };
          return { outcome: 'complete', phase: 'cleanup', report: window.report, message: 'Move complete. Settings and backups kept; standalone cleanup verified.' };
        }
        if (command === 'inspect_convergence_outcome') {
          if (window.inspectionOverride) return window.inspectionOverride;
          window.report = { ...window.report, stage: 'review', moveAvailable: !uncertain,
            message: uncertain ? 'Retained state inspected. Partial or uncertain native outcome needs recovery review; no transaction retried.' : 'Retained state inspected. No cleanup was started; fresh native review is available.' };
          return window.report;
        }
        if (command === 'prepare_convergence') {
          if (holdPrepare) await new Promise(resolve => { window.releasePrepare = resolve; });
          if (failPrepare) throw Error('Settings changed; original retained.');
          window.report = { ...window.report, stage: 'backed-up', settingsImportAvailable: false, backups: ['C:/fixture-only/exact-before-image.bak'], message: 'Backups verified. Review existing AI connections.' };
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
        if (command === 'feature_status') return { integrated: streamlined, features: streamlined ? ['setup', 'mcp'] : [] };
        if (command === 'project_inventory') return { projects: [], editors: [], errors: [], unityCliAvailable: false };
        if (command === 'pending_hosted_restore') return [];
        if (command === 'app_inventory') return { supported: true, apps: ['mcp', 'setup'].map(app => ({ app, installed: false, trusted: false, availableVersion: '1.0.0', updateAvailable: false, issue: null })) };
        if (command === 'hub_update_status') return { currentVersion: '0.1.14', availableVersion: null, downloaded: false };
        return null;
      } },
    };
  }, { required, failPrepare, holdPrepare, retirementReady, pauseRetirement, reviewKey, streamlined, failPhase, nativeCancel, holdMove, uncertain, invalidComplete, initialRecovery, settingsImportAvailable });
  await page.goto('http://127.0.0.1:4188');
}

for (const width of [940, 390]) test(`settings-only upgrades have a visible import path without old installed apps at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 640 });
  await load(page, { required: false, streamlined: true, settingsImportAvailable: true });
  const dialog = page.locator('#convergence-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#convergence-title')).toHaveText('Import saved MCP projects');
  await expect(page.locator('#convergence-import-explanation')).toBeVisible();
  await expect(page.locator('#convergence-explanation, #convergence-move, #convergence-connections, #convergence-retire')).toHaveCount(4);
  for (const id of ['explanation', 'move', 'connections', 'retire']) await expect(page.locator(`#convergence-${id}`)).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('settings-only-import.png') });
  await page.getByRole('button', { name: 'Back up and import projects', exact: true }).click();
  await expect(page.locator('#convergence-title')).toHaveText('Saved MCP projects imported');
  await page.getByRole('button', { name: 'Continue in Hub', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => window.calls.filter(call => /^(prepare_convergence|move_to_hub|migrate_convergence_connections|retire_convergence_apps)$/.test(call.command)).map(call => call.command))).toEqual(['prepare_convergence']);
  // Simulate a restart's now-identical native settings result, not a renderer completion marker.
  await page.evaluate(() => { window.report = { ...window.report, stage: 'review', settingsImportAvailable: false }; });
  await page.evaluate(() => window.CreatorConvergence.run());
  await expect(dialog).toBeHidden();
  await expect(page.locator('#convergence-reopen')).toBeHidden();
});

test('settings-only import can be postponed and reopened without triggering connection migration', async ({ page }) => {
  await load(page, { required: false, streamlined: true, settingsImportAvailable: true, failPrepare: true });
  await page.getByRole('button', { name: 'Not now', exact: true }).click();
  await expect(page.locator('#convergence-dialog')).toBeHidden();
  await page.getByRole('button', { name: 'Review saved MCP settings', exact: true }).click();
  await page.getByRole('button', { name: 'Back up and import projects', exact: true }).click();
  await expect(page.locator('#convergence-error')).toContainText('Settings changed; original retained.');
  await expect(page.getByRole('button', { name: 'Not now', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Not now', exact: true }).click();
  expect(await page.evaluate(() => window.calls.filter(call => ['move_to_hub', 'migrate_convergence_connections', 'retire_convergence_apps'].includes(call.command)))).toEqual([]);
});

for (const required of [false, true]) test(`settings import recovery survives dismissal and reload with required=${required}`, async ({ page }) => {
  const recovery = 'Settings import needs review. Retained transaction: C:/fixture-only/creator-works-mcp/.creator-hub-product-settings';
  await load(page, { required, streamlined: true, uncertain: true, initialRecovery: recovery });
  await expect(page.locator('#convergence-title')).toHaveText('Migration needs review');
  await expect(page.locator('#convergence-recovery-text')).toHaveValue(recovery);
  await expect(page.locator('#convergence-move')).toBeHidden();
  await page.locator('#convergence-later').click();
  await page.reload();
  await expect(page.locator('#convergence-reopen')).toBeVisible();
  await expect(page.locator('#convergence-dialog')).toBeHidden();
  await page.locator('#convergence-reopen').click();
  await expect(page.locator('#convergence-recovery-text')).toHaveValue(recovery);
  await page.locator('#convergence-refresh').click();
  await expect(page.locator('#convergence-recovery-text')).toHaveValue(recovery);
  for (const id of ['move', 'prepare', 'connections', 'retire']) await expect(page.locator(`#convergence-${id}`)).toBeHidden();
  expect(await page.evaluate(() => window.calls.filter(call => /^(prepare_convergence|move_to_hub|migrate_convergence_connections|retire_convergence_apps)$/.test(call.command)))).toEqual([]);
  await page.locator('#convergence-later').click();
  await expect(page.locator('#convergence-dialog')).toBeHidden();
});

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

for (const viewport of [{ width: 1100, height: 785 }, { width: 390, height: 844 }]) {
  test(`one integrated guide stays centered and completes from one action at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await load(page, { streamlined: true });
    await expect(page.locator('#convergence-explanation > li')).toHaveCount(3);
    await expect(page.locator('#convergence-move')).toHaveText('Move to Hub');
    await expect(page.locator('#convergence-later')).toHaveText('Not now');
    for (const id of ['prepare', 'connections', 'retire', 'refresh']) await expect(page.locator(`#convergence-${id}`)).not.toBeVisible();
    const box = await page.locator('#convergence-dialog').boundingBox();
    expect(Math.abs(box.x - (viewport.width - box.x - box.width))).toBeLessThan(2);
    expect(Math.abs(box.y - (viewport.height - box.y - box.height))).toBeLessThan(2);
    expect(box.x).toBeGreaterThanOrEqual(10);
    expect(box.y).toBeGreaterThanOrEqual(10);
    await page.screenshot({ path: testInfo.outputPath('single-move-guide.png') });
    await page.locator('#convergence-move').click();
    await expect(page.locator('#convergence-title')).toHaveText('Move complete');
    await expect(page.locator('#convergence-progress')).toContainText('standalone cleanup verified');
    await expect(page.locator('#convergence-backups')).not.toHaveAttribute('open', '');
    await expect(page.locator('#convergence-details')).not.toBeVisible();
    await expect(page.locator('#convergence-details > li')).toHaveCount(31);
    expect(await page.evaluate(() => window.phases)).toEqual(['backup', 'connections', 'cleanup']);
    expect(await page.evaluate(() => window.calls.filter(call => /convergence|move_to_hub/.test(call.command)).map(call => call.command))).toEqual(['convergence_status', 'move_to_hub']);
    expect(await page.evaluate(() => window.calls.find(call => call.command === 'move_to_hub').args)).toEqual({});
    expect(await page.evaluate(() => window.calls.some(call => ['start_hosted_app', 'hosted_app_call'].includes(call.command)))).toBe(false);
    expect(await page.locator('#convergence-dialog').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath('single-move-complete.png') });
    await page.locator('#convergence-later').click();
    await expect(page.locator('#convergence-dialog')).not.toBeVisible();
    await expect(page.locator('#convergence-reopen')).not.toBeVisible();
  });
}

for (const phase of ['backup', 'connections', 'cleanup']) test(`integrated ${phase} error stops the sequence without claiming completion`, async ({ page }) => {
  await load(page, { streamlined: true, failPhase: phase });
  await page.locator('#convergence-move').click();
  await expect(page.locator('#convergence-error')).toContainText(`stopped during ${phase}`);
  await expect(page.locator('#convergence-error')).not.toContainText('Cleanup may be partial');
  await expect(page.locator('#convergence-title')).toHaveText('Move to Hub');
  await expect(page.locator('#convergence-move')).not.toBeVisible();
  expect(await page.evaluate(() => window.phases)).toEqual(['backup', 'connections', 'cleanup'].slice(0, ['backup', 'connections', 'cleanup'].indexOf(phase) + 1));
  expect(await page.evaluate(() => window.calls.filter(call => call.command === 'move_to_hub').length)).toBe(1);
});

test('known unchanged cleanup refusal permits a fresh review through read-only inspection', async ({ page }) => {
  await load(page, { streamlined: true, failPhase: 'cleanup' });
  await page.locator('#convergence-move').click();
  await expect(page.locator('#convergence-error')).toContainText('cleanup was not started');
  await page.locator('#convergence-refresh').click();
  await expect(page.locator('#convergence-move')).toBeVisible();
  expect(await page.evaluate(() => window.calls.filter(call => /move_to_hub|inspect_convergence_outcome/.test(call.command)).map(call => call.command))).toEqual(['move_to_hub', 'inspect_convergence_outcome']);
});

test('partial retirement can be inspected but is never automatically retried or re-enabled', async ({ page }) => {
  await load(page, { streamlined: true, failPhase: 'cleanup', uncertain: true });
  await page.locator('#convergence-move').click();
  await expect(page.locator('#convergence-error')).toContainText('Cleanup may be partial');
  await page.locator('#convergence-refresh').click();
  await expect(page.locator('#convergence-progress')).toContainText('needs recovery review');
  await expect(page.locator('#convergence-move')).not.toBeVisible();
  await page.locator('#convergence-later').click();
  await page.locator('#convergence-reopen').click();
  await expect(page.locator('#convergence-move')).not.toBeVisible();
  expect(await page.evaluate(() => window.calls.filter(call => call.command === 'move_to_hub').length)).toBe(1);
});

for (const stage of ['review', 'complete']) test(`rejected ${stage} inspection preserves recovery without enabling migration`, async ({ page }) => {
  const recovery = 'Retained phase record: C:/fixture-only/move-v1.json\nMigration remains incomplete.';
  await load(page, { streamlined: true, initialRecovery: recovery });
  await expect(page.locator('#convergence-title')).toHaveText('Migration needs review');
  await page.evaluate(stage => {
    window.inspectionOverride = { ...window.report, streamlined: false, stage, required: stage !== 'complete',
      moveAvailable: true, legacyApps: [], recoveryHelp: null, backups: [], message: 'Rejected response' };
  }, stage);
  await page.locator('#convergence-refresh').click();
  await expect(page.locator('#convergence-error')).toContainText('Native migration support changed');
  await expect(page.locator('#convergence-title')).toHaveText('Migration needs review');
  await expect(page.locator('#convergence-move')).not.toBeVisible();
  await expect(page.locator('#convergence-recovery-text')).toHaveValue(recovery);
  await expect(page.locator('#convergence-later')).toHaveText('Not now');
  await page.locator('#convergence-later').click();
  await expect(page.locator('#convergence-dialog')).not.toBeVisible();
  await page.locator('#convergence-reopen').click();
  await expect(page.locator('#convergence-recovery-text')).toHaveValue(recovery);
  await expect(page.locator('#convergence-move')).not.toBeVisible();
  expect(await page.evaluate(() => window.calls.filter(call => /move_to_hub|retire_convergence|prepare_convergence|migrate_convergence/.test(call.command)))).toEqual([]);
  expect(await page.evaluate(() => window.calls.filter(call => call.command === 'inspect_convergence_outcome').length)).toBe(1);
});

for (const clipboardAvailable of [true, false]) test(`uncertain migration has a non-writing recovery handoff with clipboard ${clipboardAvailable}`, async ({ page }) => {
  await load(page, { streamlined: true, failPhase: 'cleanup', uncertain: true });
  await page.evaluate(available => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async value => { if (!available) throw Error('Clipboard unavailable'); window.copiedRecovery = value; },
  } }), clipboardAvailable);
  await page.locator('#convergence-move').click();
  await expect(page.locator('#convergence-recovery')).toBeVisible();
  await expect(page.locator('#convergence-title')).toHaveText('Migration needs review');
  await expect(page.locator('#convergence-summary')).toContainText('Migration has not completed');
  await expect(page.locator('#convergence-recovery-text')).toHaveValue(/Retained phase record: C:\/fixture-only\/convergence\/move-v1.json/);
  await expect(page.locator('#convergence-recovery-text')).toHaveAttribute('readonly', '');
  const before = await page.evaluate(() => window.calls.length);
  await page.locator('#convergence-copy-recovery').click();
  await expect(page.locator('#convergence-copy-status')).toContainText(clipboardAvailable ? 'Copied' : 'selected');
  if (clipboardAvailable) expect(await page.evaluate(() => window.copiedRecovery)).toContain('Migration remains incomplete');
  else expect(await page.locator('#convergence-recovery-text').evaluate(node => node.selectionEnd - node.selectionStart)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.calls.length)).toBe(before);
  await expect(page.locator('#convergence-move')).not.toBeVisible();
  await page.locator('#convergence-later').click();
  await expect(page.locator('#convergence-dialog')).not.toBeVisible();
  await page.locator('#convergence-reopen').click();
  await expect(page.locator('#convergence-recovery-text')).toHaveValue(/Migration remains incomplete/);
  expect(await page.evaluate(() => window.calls.filter(call => call.command === 'move_to_hub').length)).toBe(1);
});

for (const width of [1100, 390]) test(`recovery details remain readable at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  await load(page, { streamlined: true, failPhase: 'cleanup', uncertain: true });
  await page.locator('#convergence-move').click();
  await page.evaluate(() => { window.report.recoveryHelp += '\nRetained backup: C:/' + 'long-folder-name/'.repeat(20) + 'original.bak'; });
  await page.locator('#convergence-refresh').click();
  await expect(page.locator('#convergence-recovery-text')).toHaveValue(/long-folder-name/);
  expect(await page.locator('#convergence-dialog').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(false);
  const box = await page.locator('#convergence-recovery-text').boundingBox();
  const dialog = await page.locator('#convergence-dialog').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(dialog.x);
  expect(box.x + box.width).toBeLessThanOrEqual(dialog.x + dialog.width);
  await page.locator('#convergence-later').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('migration-recovery.png') });
});

test('already blocked migration exposes retained details without attempting a move, including absent clipboard', async ({ page }) => {
  await load(page, { streamlined: true, initialRecovery: 'Retained phase record: C:/fixture-only/move-v1.json\nMigration remains incomplete.' });
  await page.reload();
  await expect(page.locator('#convergence-title')).toHaveText('Migration needs review');
  await expect(page.locator('#convergence-move')).not.toBeVisible();
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
  await page.locator('#convergence-copy-recovery').click();
  await expect(page.locator('#convergence-copy-status')).toContainText('selected');
  expect(await page.evaluate(() => window.calls.filter(call => /move_to_hub|retire_convergence|prepare_convergence/.test(call.command)))).toEqual([]);
  await page.locator('#convergence-later').click();
  await expect(page.locator('#convergence-dialog')).not.toBeVisible();
});

for (const initialRecovery of [{ unexpected: true }, 'x'.repeat(16385)]) test(`invalid recovery details refuse without mutation (${typeof initialRecovery})`, async ({ page }) => {
  await load(page, { streamlined: true, initialRecovery });
  await expect(page.locator('#convergence-error')).toContainText('report could not be verified');
  await expect(page.locator('#convergence-recovery')).not.toBeVisible();
  await expect(page.locator('#convergence-move')).not.toBeVisible();
  expect(await page.evaluate(() => window.calls.filter(call => /move_to_hub|retire_convergence|prepare_convergence/.test(call.command)))).toEqual([]);
  await page.locator('#convergence-later').click();
  await expect(page.locator('#convergence-dialog')).not.toBeVisible();
});

test('native cancellation and Not now do not start migration phases', async ({ page }) => {
  await load(page, { streamlined: true, nativeCancel: true });
  await page.locator('#convergence-move').click();
  await expect(page.locator('#convergence-progress')).toContainText('were not changed');
  await expect(page.locator('#convergence-move')).toBeEnabled();
  expect(await page.evaluate(() => window.phases)).toEqual([]);
  await page.locator('#convergence-later').click();
  await expect(page.locator('#convergence-dialog')).not.toBeVisible();
  expect(await page.evaluate(() => window.calls.filter(call => call.command === 'move_to_hub').length)).toBe(1);
});

test('integrated busy state prevents repeat execution, inspection and dismissal', async ({ page }) => {
  await load(page, { streamlined: true, holdMove: true });
  await page.locator('#convergence-move').click();
  await expect.poll(() => page.evaluate(() => typeof window.releaseMove)).toBe('function');
  await expect(page.locator('#convergence-move')).toBeDisabled();
  await expect(page.locator('#convergence-later')).toBeDisabled();
  await page.evaluate(() => document.querySelector('#convergence-move').dispatchEvent(new MouseEvent('click')));
  await page.keyboard.press('Escape');
  await expect(page.locator('#convergence-dialog')).toBeVisible();
  expect(await page.evaluate(() => window.calls.filter(call => call.command === 'move_to_hub').length)).toBe(1);
  await page.evaluate(() => window.releaseMove());
  await expect(page.locator('#convergence-title')).toHaveText('Move complete');
});

test('inconsistent native completion cannot imply verified retirement', async ({ page }) => {
  await load(page, { streamlined: true, invalidComplete: true });
  await page.locator('#convergence-move').click();
  await expect(page.locator('#convergence-error')).toContainText('outcome needs review', { ignoreCase: true });
  await expect(page.locator('#convergence-title')).toHaveText('Move to Hub');
  await expect(page.locator('#convergence-move')).not.toBeVisible();
});

test('integrated fresh install and skipping the guide perform no migration writes', async ({ page }) => {
  await load(page, { streamlined: true, required: false });
  await expect.poll(() => page.evaluate(() => window.calls.some(call => call.command === 'app_inventory'))).toBe(true);
  await expect(page.locator('#convergence-dialog')).not.toBeVisible();
  expect(await page.evaluate(() => window.calls.some(call => call.command === 'move_to_hub'))).toBe(false);
});

for (const dismiss of ['Not now', 'Escape']) test(`integrated ${dismiss} before moving performs no migration writes`, async ({ page }) => {
  await load(page, { streamlined: true });
  await expect(page.locator('#convergence-dialog')).toBeVisible();
  if (dismiss === 'Escape') await page.keyboard.press('Escape');
  else await page.locator('#convergence-later').click();
  await expect(page.locator('#convergence-dialog')).not.toBeVisible();
  expect(await page.evaluate(() => window.calls.some(call => /move_to_hub|prepare_convergence|migrate_convergence_connections|retire_convergence_apps/.test(call.command)))).toBe(false);
});
