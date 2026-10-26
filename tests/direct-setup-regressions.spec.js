const { test, expect } = require('@playwright/test');

// Exercise the real direct page and its retained lifecycle, without the shared
// shell or any native project, installation, preferences or package operations.
async function openSetup(page, options = {}) {
  await page.route('**/app.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.addInitScript(options => {
    localStorage.setItem('creator-usage-terms.hub', JSON.stringify({ policyVersion: '2026-09-28-v1', acceptedAt: '2026-09-28T00:00:00Z' }));
    window.__CREATOR_HUB_FEATURE_PROTOCOL__ = 1;
    const fixture = window.setupFixture = {
      calls: [], pending: {}, hold: null, failNext: options.failNext,
      outcome: options.outcome || 'success', canonicalPath: options.canonicalPath,
      environment: {
        platform: 'windows', ready: true, hubInstalled: true,
        recipe: { editorVersion: '6000.3.21f1', creatorSdkVersion: '4.0.14', urpVersion: '17.3.0', inputSystemVersion: '1.20.0' },
        editors: [{ exactRecipe: true, androidPlayer: true, androidSdk: true, androidNdk: true, openJdk: true, windowsStandalone: true, urpTemplate: 'urp.tgz' }],
        blockers: [], suggestedProjectParent: '/projects',
      },
      inspection: options.inspection || {
        canRepair: true, canValidate: true,
        findings: [{ title: 'Visual Scripting setup', status: 'repair', detail: 'Node database is missing.' }],
        proposedChanges: ['Initialize Creator Visual Scripting and rebuild its node database; retain existing type selections.'],
      },
    };
    window.__TAURI__ = {
      event: { listen: async () => () => {} },
      core: { invoke: async (command, args = {}) => {
        fixture.calls.push({ command, args: structuredClone(args) });
        if (command === 'feature_status') return { integrated: true, features: ['setup'] };
        if (command !== 'feature_call' || args.feature !== 'setup') throw new Error('Unexpected command: ' + command);
        const name = args.command;
        const fields = args.args;
        const inspection = structuredClone(fixture.inspection);
        if (fixture.hold === name) await new Promise((resolve, reject) => { fixture.pending[name] = { resolve, reject }; });
        if (fixture.failNext === name) { fixture.failNext = null; throw new Error('Fixture refusal: ' + name); }
        switch (name) {
          case 'probe_environment': return structuredClone(fixture.environment);
          case 'inspect_project': return { projectPath: fixture.canonicalPath || fields.path, fingerprint: 'reviewed-fingerprint', ...inspection };
          case 'run_existing_project':
            if (fixture.outcome === 'throw') throw new Error('Another project setup operation is running. Wait for it to finish.');
            return { success: fixture.outcome === 'success', projectPath: fields.request.projectPath,
              message: fixture.outcome === 'success' ? 'Validation passed' : 'Validation needs attention. Review the report.',
              backupPath: '/retained/backup', reportPath: '/retained/report.json' };
          default: throw new Error('Unexpected Setup command: ' + name);
        }
      } },
    };
  }, options);
  await page.goto('http://127.0.0.1:4188/');
  await page.evaluate(async () => {
    await CreatorUsageTerms.requireAcceptance();
    for (const id of ['view-hub', 'view-projects', 'view-detail', 'view-builtin', 'hub-pages']) document.getElementById(id).classList.add('hidden');
  });
  await show(page);
}

const field = (page, name) => page.locator(`#feature-setup [data-field="${name}"]`);
const show = page => page.evaluate(() => CreatorFeaturePages.show('setup', { load: true }));
const calls = (page, command) => page.evaluate(command => setupFixture.calls.filter(call => call.command === 'feature_call' && call.args.command === command), command);
const hold = (page, command) => page.evaluate(command => { setupFixture.hold = command; }, command);
const waitPending = (page, command) => page.waitForFunction(command => Boolean(setupFixture.pending[command]), command);
async function settle(page, command, reject = false) {
  await page.evaluate(({ command, reject }) => {
    const pending = setupFixture.pending[command];
    delete setupFixture.pending[command]; setupFixture.hold = null;
    if (reject) pending.reject(new Error('Fixture refusal: ' + command));
    else pending.resolve();
  }, { command, reject });
  await expect(page.locator('#feature-setup')).toHaveAttribute('aria-busy', 'false');
}
async function existing(page, path = '/projects/Reviewed') {
  await field(page, 'existing-tab').click();
  await field(page, 'existing-path').fill(path);
  await field(page, 'inspect').click();
  await expect(field(page, 'inspection-summary')).toContainText('Inspection complete');
}
async function navigateBack(page) {
  await page.evaluate(() => CreatorFeaturePages.hide());
  await show(page);
}

for (const reject of [false, true]) test(`direct Setup probe excludes Inspect and Repair, retains review, no replay (${reject ? 'failure' : 'success'})`, async ({ page }) => {
  await openSetup(page); await existing(page);
  await field(page, 'approval').check();
  await hold(page, 'probe_environment'); await field(page, 'refresh').click(); await waitPending(page, 'probe_environment');
  for (const name of ['inspect', 'repair', 'refresh']) {
    await expect(field(page, name)).toBeDisabled();
    await field(page, name).dispatchEvent('click');
  }
  await navigateBack(page);
  expect(await page.evaluate(() => CreatorFeaturePages.busy())).toBe(true);
  expect(await page.evaluate(() => CreatorFeaturePages.dispose())).toBe(false);
  expect((await calls(page, 'probe_environment')).length).toBe(2);
  expect((await calls(page, 'inspect_project')).length).toBe(1);
  expect(await calls(page, 'run_existing_project')).toEqual([]);
  await settle(page, 'probe_environment', reject);
  await expect(field(page, 'existing-path')).toHaveValue('/projects/Reviewed');
  await expect(field(page, 'approval')).toBeChecked();
  await expect(field(page, 'repair')).toBeEnabled();
  if (reject) await expect(field(page, 'error')).toContainText('Fixture refusal: probe_environment');
  else await expect(field(page, 'error')).toBeHidden();
  await navigateBack(page);
  expect((await calls(page, 'probe_environment')).length).toBe(2);
  expect((await calls(page, 'inspect_project')).length).toBe(1);
  expect(await calls(page, 'run_existing_project')).toEqual([]);
});

test('direct Setup Inspect excludes probe and duplicate inspection, completing once after navigation', async ({ page }) => {
  await openSetup(page);
  await field(page, 'name').fill('Retained draft'); await field(page, 'parent').fill('/keep/parent');
  await field(page, 'existing-tab').click(); await field(page, 'existing-path').fill('/projects/Reviewed');
  await hold(page, 'inspect_project'); await field(page, 'inspect').click(); await waitPending(page, 'inspect_project');
  for (const name of ['inspect', 'refresh']) {
    await expect(field(page, name)).toBeDisabled(); await field(page, name).dispatchEvent('click');
  }
  await page.evaluate(() => CreatorFeaturePages.hide());
  await settle(page, 'inspect_project'); await show(page);
  await expect(field(page, 'inspection-summary')).toContainText('Inspection complete');
  await expect(field(page, 'existing-tab')).toHaveAttribute('aria-selected', 'true');
  await expect(field(page, 'name')).toHaveValue('Retained draft'); await expect(field(page, 'parent')).toHaveValue('/keep/parent');
  expect((await calls(page, 'inspect_project')).length).toBe(1);
  expect((await calls(page, 'probe_environment')).length).toBe(1);
  expect(await calls(page, 'run_existing_project')).toEqual([]);
});

test('direct Setup failed initialization retries only explicitly and keeps the draft', async ({ page }) => {
  await openSetup(page, { failNext: 'probe_environment' });
  await expect(field(page, 'retry')).toBeVisible();
  await expect(field(page, 'error')).toContainText('probe_environment');
  await field(page, 'name').fill('Keep after connection failure'); await field(page, 'parent').fill('/keep/parent');
  await navigateBack(page);
  expect((await calls(page, 'probe_environment')).length).toBe(1);
  await field(page, 'retry').click();
  await expect(field(page, 'retry')).toBeHidden(); await expect(field(page, 'error')).toBeHidden();
  await expect(field(page, 'name')).toHaveValue('Keep after connection failure'); await expect(field(page, 'parent')).toHaveValue('/keep/parent');
  await navigateBack(page);
  expect((await calls(page, 'probe_environment')).length).toBe(2);
  expect(await calls(page, 'run_existing_project')).toEqual([]);
});

for (const returnToOriginal of [false, true]) test(`direct Setup rejects late inspection after selection changes (return to original: ${returnToOriginal})`, async ({ page }) => {
  await openSetup(page); await existing(page, '/projects/First'); await field(page, 'approval').check();
  await hold(page, 'inspect_project'); await field(page, 'inspect').click(); await waitPending(page, 'inspect_project');
  await expect(field(page, 'findings')).toBeEmpty(); await expect(field(page, 'approval')).not.toBeChecked();
  // The real fieldset is disabled. Synthetic input covers late controller/external
  // selection changes; it does not claim ordinary typing bypasses that fieldset.
  await field(page, 'existing-path').evaluate((input, returnToOriginal) => {
    input.value = '/projects/Second'; input.dispatchEvent(new Event('input'));
    if (returnToOriginal) { input.value = '/projects/First'; input.dispatchEvent(new Event('input')); }
  }, returnToOriginal);
  await settle(page, 'inspect_project');
  const selected = returnToOriginal ? '/projects/First' : '/projects/Second';
  await expect(field(page, 'existing-path')).toHaveValue(selected);
  await expect(field(page, 'findings')).toBeEmpty(); await expect(field(page, 'inspection-summary')).toBeEmpty();
  await expect(field(page, 'error')).toContainText('Project selection changed during inspection');
  await expect(field(page, 'repair')).toBeDisabled(); await expect(field(page, 'validate')).toBeDisabled();
  await navigateBack(page);
  expect((await calls(page, 'inspect_project')).length).toBe(2);
  expect(await calls(page, 'run_existing_project')).toEqual([]);
  await field(page, 'inspect').click();
  await expect(field(page, 'inspection-summary')).toContainText('Inspection complete'); await expect(field(page, 'error')).toBeHidden();
  await expect(field(page, 'approval')).not.toBeChecked();
  expect((await calls(page, 'inspect_project')).at(-1).args.args).toEqual({ path: selected });
});

test('direct Setup accepts the canonical inspection path when the selection has not changed', async ({ page }) => {
  await openSetup(page, { canonicalPath: '/projects/Canonical' });
  await existing(page, '/projects/Canonical/.');
  await expect(field(page, 'existing-path')).toHaveValue('/projects/Canonical');
  await field(page, 'approval').check(); await field(page, 'repair').click();
  await expect(field(page, 'existing-result')).toContainText('Validation passed');
  expect((await calls(page, 'run_existing_project'))[0].args.args.request).toEqual({ projectPath: '/projects/Canonical', fingerprint: 'reviewed-fingerprint', repair: true, approved: true });
});

for (const action of ['repair', 'validate']) for (const outcome of ['success', 'failure', 'throw']) {
  test(`direct Setup ${action} ${outcome} retires the read-only snapshot and requires fresh inspection`, async ({ page }) => {
    await openSetup(page, { outcome }); await existing(page); await field(page, 'approval').check();
    await hold(page, 'run_existing_project'); await field(page, action).click(); await waitPending(page, 'run_existing_project');
    await expect(field(page, 'inspection-summary')).not.toContainText('No project files were changed');
    await expect(field(page, 'inspection-summary')).toContainText('pre-operation inspection');
    await field(page, action).dispatchEvent('click');
    expect((await calls(page, 'run_existing_project')).length).toBe(1);
    await settle(page, 'run_existing_project');
    await expect(field(page, 'inspection-summary')).toContainText('Inspect again before another repair or validation');
    await expect(field(page, 'activity')).toBeHidden(); await expect(field(page, 'approval')).not.toBeChecked();
    await expect(field(page, 'repair')).toBeDisabled(); await expect(field(page, 'validate')).toBeDisabled();
    if (outcome === 'success') {
      await expect(field(page, 'status')).toHaveText('Ready'); await expect(field(page, 'open-existing')).toBeVisible();
    } else {
      await expect(field(page, 'status')).toHaveText('Needs attention'); await expect(field(page, 'open-existing')).toBeHidden();
      await expect(field(page, 'error')).toContainText(outcome === 'throw' ? 'Another project setup operation is running' : 'Validation needs attention');
    }
    if (outcome !== 'throw') await expect(field(page, 'existing-result')).toContainText('Report: /retained/report.json');
    await navigateBack(page);
    await expect(field(page, 'inspection-summary')).toContainText('pre-operation inspection');
    expect((await calls(page, 'probe_environment')).length).toBe(1);
    expect((await calls(page, 'inspect_project')).length).toBe(1);
    expect((await calls(page, 'run_existing_project')).length).toBe(1);
    expect((await calls(page, 'run_existing_project'))[0].args.args).toEqual({ request: { projectPath: '/projects/Reviewed', fingerprint: 'reviewed-fingerprint', repair: action === 'repair', approved: true } });
    await field(page, 'inspect').click();
    await expect(field(page, 'inspection-summary')).toContainText('No project files were changed');
    await expect(field(page, 'existing-result')).toBeEmpty(); await expect(field(page, 'error')).toBeHidden();
    await expect(field(page, 'repair')).toBeDisabled(); await expect(field(page, 'approval')).not.toBeChecked();
    await field(page, 'approval').check(); await expect(field(page, 'repair')).toBeEnabled();
    expect((await calls(page, 'run_existing_project')).length).toBe(1);
  });
}

test('direct Setup exposes approved missing-SDK repair for a URP project, without enabling validation first', async ({ page }) => {
  await openSetup(page, { inspection: {
    canRepair: true, canValidate: false,
    findings: [{ title: 'Unity version', status: 'pass', detail: '6000.3.21f1' },
      { title: 'URP package', status: 'pass', detail: 'Pinned version 17.3.0' },
      { title: 'Creator SDK', status: 'repair', detail: 'Missing package.' }],
    proposedChanges: ['Add com.sidequest.creator-sdk 4.0.14.', 'Add missing Creator SDK registry scopes; preserve unrelated registries.'],
  } });
  await existing(page, '/projects/URP without SDK');
  await expect(field(page, 'inspection-summary')).toContainText('repairs are required before validation is available');
  await expect(field(page, 'findings')).toContainText('Creator SDK: Repair available');
  await expect(field(page, 'changes')).toContainText('Add com.sidequest.creator-sdk 4.0.14.');
  await expect(field(page, 'repair')).toBeVisible(); await expect(field(page, 'repair')).toBeDisabled();
  await expect(field(page, 'validate')).toBeHidden(); await expect(field(page, 'validate')).toBeDisabled();
  await field(page, 'approval').check(); await navigateBack(page);
  await expect(field(page, 'approval')).toBeChecked(); await expect(field(page, 'repair')).toBeEnabled();
  await field(page, 'validate').dispatchEvent('click');
  expect(await calls(page, 'run_existing_project')).toEqual([]);
  await field(page, 'repair').click(); await expect(field(page, 'existing-result')).toContainText('Validation passed');
  expect((await calls(page, 'run_existing_project'))[0].args.args).toEqual({ request: { projectPath: '/projects/URP without SDK', fingerprint: 'reviewed-fingerprint', repair: true, approved: true } });
});

test('direct Setup shows supported SDK 4.0.22 / VS 1.9.12 findings and uses ordinary reviewed repair', async ({ page }) => {
  await openSetup(page, { inspection: {
    canRepair: true, canValidate: true,
    findings: [
      { title: 'Creator SDK', status: 'pass', detail: 'Tested version 4.0.22; existing package kept.' },
      { title: 'Visual Scripting package', status: 'pass', detail: 'Tested version 1.9.12; existing package kept.' },
      { title: 'Visual Scripting setup', status: 'repair', detail: 'The latest Unity validation found invalid Creator node configuration.' },
    ],
    proposedChanges: ['Initialize Creator Visual Scripting and rebuild its node database; retain existing type selections.'],
  } });
  await expect(field(page, 'recipe')).toContainText('Creator SDK 4.0.14');
  await existing(page, '/projects/Qualified pair');
  await expect(field(page, 'findings').locator('strong')).toHaveText([
    'Creator SDK: Ready', 'Visual Scripting package: Ready', 'Visual Scripting setup: Repair available',
  ]);
  await expect(field(page, 'findings')).toContainText('Tested version 4.0.22; existing package kept.');
  await expect(field(page, 'findings')).toContainText('Tested version 1.9.12; existing package kept.');
  await expect(field(page, 'changes').locator('li')).toHaveText([
    'Initialize Creator Visual Scripting and rebuild its node database; retain existing type selections.',
  ]);
  await expect(field(page, 'review-hub')).toBeHidden();
  await expect(field(page, 'approval')).not.toBeChecked();
  for (const name of ['repair', 'validate']) {
    await expect(field(page, name)).toBeVisible(); await expect(field(page, name)).toBeDisabled();
    await field(page, name).dispatchEvent('click');
  }
  expect(await calls(page, 'run_existing_project')).toEqual([]);
  await field(page, 'approval').check();
  await expect(field(page, 'repair')).toBeEnabled(); await expect(field(page, 'validate')).toBeEnabled();
  await field(page, 'repair').click();
  await expect(field(page, 'existing-result')).toContainText('Validation passed');
  await expect(field(page, 'existing-result')).toContainText('Backup: /retained/backup');
  await expect(field(page, 'existing-result')).toContainText('Report: /retained/report.json');
  await expect(field(page, 'error')).toBeHidden();
  await expect(field(page, 'inspection-summary')).toContainText('Inspect again before another repair or validation');
  await expect(field(page, 'approval')).not.toBeChecked();
  await expect(field(page, 'repair')).toBeDisabled(); await expect(field(page, 'validate')).toBeDisabled();
  await navigateBack(page);
  const operations = await calls(page, 'run_existing_project');
  expect(operations).toHaveLength(1);
  expect(operations[0].args.args).toEqual({ request: { projectPath: '/projects/Qualified pair', fingerprint: 'reviewed-fingerprint', repair: true, approved: true } });
  expect(await calls(page, 'inspect_project')).toHaveLength(1);
});

test('direct Setup preserves independent unqualified-version blockers and retries failed inspection without a repair', async ({ page }) => {
  await openSetup(page, { inspection: {
    canRepair: false, canValidate: false, proposedChanges: [], findings: [
      { title: 'Creator SDK', status: 'blocked', detail: 'Installed reference 4.0.23 differs from tested 4.0.14. No automatic version replacement.' },
      { title: 'Visual Scripting package', status: 'blocked', detail: 'Installed reference 1.9.13 differs from tested 1.9.1. No automatic version replacement.' },
    ],
  } });
  await field(page, 'existing-tab').click(); await field(page, 'existing-path').fill('/projects/Newer packages'); await field(page, 'inspect').click();
  await expect(field(page, 'status')).toHaveText('Review findings');
  await expect(field(page, 'inspection-summary')).toContainText('2 blockers');
  await expect(field(page, 'findings')).toContainText('4.0.23'); await expect(field(page, 'findings')).toContainText('1.9.13');
  await expect(field(page, 'approval').locator('..')).toBeHidden();
  await expect(field(page, 'repair')).toBeDisabled(); await expect(field(page, 'validate')).toBeDisabled();
  await page.evaluate(() => { setupFixture.failNext = 'inspect_project'; });
  await field(page, 'inspect').click();
  await expect(field(page, 'error')).toContainText('inspect_project'); await expect(field(page, 'findings')).toBeEmpty();
  await expect(field(page, 'inspection-summary')).toBeEmpty(); await expect(field(page, 'review-hub')).toBeHidden();
  await navigateBack(page);
  expect((await calls(page, 'inspect_project')).length).toBe(2);
  await field(page, 'inspect').click();
  await expect(field(page, 'status')).toHaveText('Review findings'); await expect(field(page, 'inspection-summary')).toContainText('2 blockers');
  expect(await calls(page, 'run_existing_project')).toEqual([]);
});
