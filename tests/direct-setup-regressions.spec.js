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
      resultSkippedChecks: options.resultSkippedChecks,
      latest: options.latest || { version: '4.0.25', unityVersion: '6000.3.27f1', dependencies: { 'com.unity.visualscripting': '1.9.13' } },
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
          case 'latest_sdk_requirements': return structuredClone(fixture.latest);
          case 'open_official_url': return true;
          case 'open_project': return 'Open requested for ' + fields.path;
          case 'inspect_project': return { projectPath: fixture.canonicalPath || fields.path, fingerprint: 'reviewed-fingerprint', ...inspection };
          case 'run_existing_project':
            if (fixture.outcome === 'throw') throw new Error('Another project setup operation is running. Wait for it to finish.');
            return { success: fixture.outcome === 'success', projectPath: fields.request.projectPath,
              partialRepair: inspection.partialRepair === true, validated: inspection.partialRepair !== true,
              skippedChecks: fixture.resultSkippedChecks || inspection.skippedChecks,
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
    for (const chrome of document.querySelectorAll('.app-header, #suite-shell, #suite-dismiss')) chrome.style.display = 'none';
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

test('blocked Setup exposes copyable recovery locations without enabling repairs', async ({ page }) => {
  await openSetup(page, { inspection: {
    canRepair: false, canValidate: false, proposedChanges: [],
    findings: [{ status: 'blocked', title: 'Existing operation', detail: 'An earlier operation needs review. Do not delete its files.',
      diagnosticPaths: ['C:\\Projects\\Space & name\\.creator-project-setup\\operation.lock', 'C:\\Projects\\Space & name\\.creator-project-setup'] }],
  } });
  await page.evaluate(() => {
    window.copiedDetails = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => window.copiedDetails.push(value) } });
  });
  await field(page, 'existing-tab').click();
  await field(page, 'existing-path').fill('C:\\Projects\\Space & name');
  await field(page, 'inspect').click();
  await expect(field(page, 'diagnostics')).toBeVisible();
  await expect(field(page, 'diagnostic-details')).toHaveValue(/operation\.lock/);
  await field(page, 'copy-diagnostics').click();
  expect(await page.evaluate(() => window.copiedDetails)).toEqual([await field(page, 'diagnostic-details').inputValue()]);
  await expect(field(page, 'repair')).toBeDisabled();
  await expect(field(page, 'validate')).toBeDisabled();
  expect(await calls(page, 'run_existing_project')).toEqual([]);
  await field(page, 'existing-path').fill('C:\\Projects\\Other');
  await expect(field(page, 'diagnostics')).toBeHidden();
});

test('existing project requirements use its own Editor and never require a creation template', async ({ page }, testInfo) => {
  await openSetup(page, { inspection: {
    editorVersion: '6000.3.27f1', partialRepair: true, canRepair: false, canValidate: false, proposedChanges: [],
    findings: [{ status: 'check', title: 'Unity version', qualificationRequired: true, detail: 'Newer Editor kept; version-specific validation is skipped.' }],
  } });
  await page.evaluate(() => {
    setupFixture.environment.editors = [
      { version: '6000.3.21f1', exactRecipe: true, androidPlayer: false, urpTemplate: null },
      { version: '6000.3.27f1', exactRecipe: false, androidPlayer: true, androidSdk: true, androidNdk: true, openJdk: true, windowsStandalone: true, urpTemplate: null },
    ];
    setupFixture.environment.blockers = ['The Editor\'s official 3D URP template is missing.'];
  });
  await field(page, 'refresh').click();
  await field(page, 'existing-tab').click();
  await field(page, 'existing-path').fill('/projects/Newer editor');
  await field(page, 'inspect').click();
  await expect(field(page, 'requirements-title')).toHaveText('Existing-project requirements');
  await expect(field(page, 'requirements')).toContainText('Unity 6000.3.27f1');
  await expect(field(page, 'requirements')).not.toContainText('6000.3.21f1');
  await expect(field(page, 'requirements')).not.toContainText('URP template');
  await expect(field(page, 'blockers')).toBeEmpty();
  await expect(field(page, 'findings')).toContainText('Newer version kept');
  await expect(field(page, 'inspection-summary')).toContainText('not a full project validation');
  await page.screenshot({ path: testInfo.outputPath('existing-requirements.png'), fullPage: true });
  await field(page, 'new-tab').click();
  await expect(field(page, 'requirements-title')).toHaveText('New-project requirements');
  await expect(field(page, 'requirements')).toContainText('Unity 6000.3.21f1');
  await expect(field(page, 'requirements')).toContainText('Official 3D URP template');
  expect(await calls(page, 'run_existing_project')).toEqual([]);
});

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
      await expect(field(page, 'status')).toHaveText('Needs attention'); await expect(field(page, 'open-existing')).toBeVisible();
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

test('newer-version advice preserves independent safety blockers and explicit inspection retry', async ({ page }) => {
  await openSetup(page, { inspection: {
    canRepair: false, canValidate: false, proposedChanges: [], findings: [
      { title: 'Creator SDK', status: 'check', qualificationRequired: true, detail: 'Installed reference 4.0.23 is kept. No automatic version replacement.' },
      { title: 'Visual Scripting package', status: 'check', qualificationRequired: true, detail: 'Installed reference 1.9.13 is kept. Version-specific validation skipped.' },
      { title: 'Project lock', status: 'blocked', detail: 'The project is in use.' },
    ],
  } });
  await field(page, 'existing-tab').click(); await field(page, 'existing-path').fill('/projects/Newer packages'); await field(page, 'inspect').click();
  await expect(field(page, 'status')).toHaveText('Review findings');
  await expect(field(page, 'inspection-summary')).toContainText('1 item needs review');
  await expect(field(page, 'findings')).toContainText('Newer version kept');
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
  await expect(field(page, 'status')).toHaveText('Review findings'); await expect(field(page, 'inspection-summary')).toContainText('1 item needs review');
  expect(await calls(page, 'run_existing_project')).toEqual([]);
});

test('latest SDK is fetched on Existing entry and explicit refresh without changing the creation recipe', async ({ page }) => {
  await openSetup(page);
  expect(await calls(page, 'latest_sdk_requirements')).toHaveLength(0);
  await field(page, 'existing-tab').click();
  await expect(field(page, 'latest-status')).toContainText('4.0.25');
  await expect(field(page, 'latest-status')).toContainText('6000.3.27f1');
  await expect(field(page, 'latest-dependencies')).toContainText('Visual Scripting: 1.9.13');
  await page.evaluate(() => { setupFixture.latest = { version: '4.0.26', unityVersion: '6000.3.28f1', dependencies: {} }; });
  await field(page, 'latest-refresh').click();
  await expect(field(page, 'latest-status')).toContainText('4.0.26');
  expect(await calls(page, 'latest_sdk_requirements')).toHaveLength(2);
  await field(page, 'new-tab').click();
  await expect(field(page, 'recipe')).toContainText('Creator SDK 4.0.14');
  await expect(field(page, 'recipe')).toContainText('Unity 6000.3.21f1');
  await field(page, 'existing-tab').click();
  await expect(field(page, 'latest-status')).toContainText('4.0.26');
  expect(await calls(page, 'latest_sdk_requirements')).toHaveLength(3);
  await page.evaluate(() => { setupFixture.latest.version = '4.0.27'; });
  await navigateBack(page);
  await expect(field(page, 'latest-status')).toContainText('4.0.27');
  expect(await calls(page, 'latest_sdk_requirements')).toHaveLength(4);
  expect(await calls(page, 'run_existing_project')).toEqual([]);
  expect(await calls(page, 'create_project')).toEqual([]);
  expect(await calls(page, 'open_project')).toEqual([]);
  expect(await calls(page, 'open_official_url')).toEqual([]);
});

test('offline latest lookup stays local and does not block inspection or supported controls', async ({ page }) => {
  await openSetup(page, { failNext: 'latest_sdk_requirements' });
  await field(page, 'existing-tab').click();
  await expect(field(page, 'latest-error')).toContainText('latest_sdk_requirements');
  await expect(field(page, 'error')).toBeHidden();
  await field(page, 'existing-path').fill('/projects/Offline');
  await field(page, 'inspect').click();
  await expect(field(page, 'inspection-summary')).toContainText('Inspection complete');
  await field(page, 'approval').check();
  await expect(field(page, 'repair')).toBeEnabled();
  await expect(field(page, 'open-existing')).toBeEnabled();
  expect(await calls(page, 'run_existing_project')).toEqual([]);
  await field(page, 'latest-refresh').click();
  await expect(field(page, 'latest-error')).toBeHidden();
  await expect(field(page, 'latest-status')).toContainText('4.0.25');
});

test('SDK metadata without a Unity minimum remains usable and matches the native dependency bound', async ({ page }) => {
  const dependencies = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`com.example.package${i}`, '1.0.0']));
  await openSetup(page, { latest: { version: '5.0.0', unityVersion: null, dependencies } });
  await field(page, 'existing-tab').click();
  await expect(field(page, 'latest-status')).toContainText('5.0.0');
  await expect(field(page, 'latest-status')).toContainText('No minimum Unity version declared');
  await expect(field(page, 'latest-error')).toBeHidden();
  await field(page, 'existing-path').fill('/projects/Still usable');
  await expect(field(page, 'inspect')).toBeEnabled();
});

test('latest lookup is time bounded and a late response does not silently replace its error', async ({ page }) => {
  await openSetup(page); await page.clock.install();
  await hold(page, 'latest_sdk_requirements');
  await field(page, 'existing-tab').click(); await waitPending(page, 'latest_sdk_requirements');
  await field(page, 'existing-path').fill('/projects/While lookup waits'); await field(page, 'inspect').click();
  await expect(field(page, 'inspection-summary')).toContainText('Inspection complete');
  await page.clock.fastForward(20001);
  await expect(field(page, 'latest-error')).toContainText('timed out');
  await expect(field(page, 'inspect')).toBeEnabled();
  await expect(field(page, 'error')).toBeHidden();
  await settle(page, 'latest_sdk_requirements');
  await expect(field(page, 'latest-error')).toContainText('timed out');
  await page.clock.fastForward(60000);
  expect(await calls(page, 'latest_sdk_requirements')).toHaveLength(1);
});

test('partial repair keeps newer versions, lists skipped checks and never claims full validation', async ({ page }, testInfo) => {
  await openSetup(page, { resultSkippedChecks: ['Full Unity validation was skipped for the retained versions.'], inspection: {
    editorVersion: '6000.3.27f1', partialRepair: true, canRepair: true, canValidate: true,
    findings: [{ title: 'Creator SDK', status: 'check', qualificationRequired: true, detail: 'SDK 4.0.25 is kept.' }],
    proposedChanges: ['Add a missing supported registry scope.'],
    skippedChecks: ['Version-specific Visual Scripting regeneration.', 'Full Unity validation.'],
  } });
  await existing(page, '/projects/Newer version');
  await expect(field(page, 'findings')).toContainText('Newer version kept');
  await expect(field(page, 'findings')).not.toContainText('Not yet qualified');
  await expect(field(page, 'skipped-checks')).toContainText('Full Unity validation.');
  await expect(field(page, 'approval-label')).toHaveText('Back up and apply supported repairs');
  await expect(field(page, 'repair')).toHaveText('Back up and apply supported repairs');
  await expect(field(page, 'repair')).toBeDisabled();
  await expect(field(page, 'validate')).toBeHidden(); await expect(field(page, 'validate')).toBeDisabled();
  await field(page, 'validate').dispatchEvent('click');
  expect(await calls(page, 'run_existing_project')).toEqual([]);
  expect(await calls(page, 'open_project')).toEqual([]);
  await field(page, 'approval').check(); await field(page, 'repair').click();
  await expect(field(page, 'existing-result')).toContainText('Full project validation was not run.');
  await expect(field(page, 'existing-result')).not.toContainText('Validation passed');
  await expect(field(page, 'skipped-checks')).toHaveText('Full Unity validation was skipped for the retained versions.');
  await expect(field(page, 'inspection-summary')).toContainText('after Unity finishes importing and compiling');
  await expect(field(page, 'open-existing')).toBeVisible();
  const operations = await calls(page, 'run_existing_project');
  expect(operations).toHaveLength(1);
  expect(operations[0].args.args.request).toEqual({ projectPath: '/projects/Newer version', fingerprint: 'reviewed-fingerprint', repair: true, approved: true });
  await page.setViewportSize({ width: 560, height: 800 });
  await page.screenshot({ path: testInfo.outputPath('partial-repair-mobile.png'), fullPage: true });
  expect(await field(page, 'existing-result').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('SDK guide and open use explicit clicks and only the exact inspected canonical path', async ({ page }) => {
  await openSetup(page, { canonicalPath: 'C:\\Projects\\Canonical & newer', inspection: {
    partialRepair: true, canRepair: false, canValidate: false, proposedChanges: [],
    findings: [{ title: 'Unity version', status: 'check', qualificationRequired: true, detail: 'Newer Editor kept.' }],
  } });
  await existing(page, 'C:\\Projects\\Canonical & newer\\.');
  await expect(field(page, 'open-existing')).toBeVisible(); await expect(field(page, 'open-existing')).toBeEnabled();
  expect(await calls(page, 'open_project')).toEqual([]);
  expect(await calls(page, 'open_official_url')).toEqual([]);
  await field(page, 'sdk-guide').click();
  expect((await calls(page, 'open_official_url'))[0].args.args).toEqual({ url: 'https://altvr.app/docs/' });
  await field(page, 'open-existing').click();
  expect((await calls(page, 'open_project'))[0].args.args).toEqual({ path: 'C:\\Projects\\Canonical & newer' });
  expect(await calls(page, 'run_existing_project')).toEqual([]);
  await expect(field(page, 'import-guidance')).toContainText('finish importing and compiling, then Inspect again');
  await expect(field(page, 'import-guidance')).toContainText('update in Unity Package Manager');
  await field(page, 'existing-path').fill('C:\\Projects\\Not inspected');
  await expect(field(page, 'open-existing')).toBeHidden();
});

test('busy page blocks inspected Open and guide even for synthetic click dispatch', async ({ page }) => {
  await openSetup(page); await existing(page);
  await hold(page, 'probe_environment'); await field(page, 'refresh').click(); await waitPending(page, 'probe_environment');
  for (const name of ['open-existing', 'sdk-guide']) {
    await expect(field(page, name)).toBeDisabled(); await field(page, name).dispatchEvent('click');
  }
  expect(await calls(page, 'open_project')).toEqual([]);
  expect(await calls(page, 'open_official_url')).toEqual([]);
  await settle(page, 'probe_environment');
  await field(page, 'open-existing').click();
  expect((await calls(page, 'open_project'))[0].args.args).toEqual({ path: '/projects/Reviewed' });
});

test('discarding a page while latest metadata waits does not touch disposed UI', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await openSetup(page); await hold(page, 'latest_sdk_requirements');
  await field(page, 'existing-tab').click(); await waitPending(page, 'latest_sdk_requirements');
  expect(await page.evaluate(() => CreatorFeaturePages.dispose())).toBe(true);
  await page.evaluate(() => setupFixture.pending.latest_sdk_requirements.resolve());
  expect(errors).toEqual([]);
});
