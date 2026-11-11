const { test, expect } = require('@playwright/test');

const latestSdk = { version: '4.0.25', unityVersion: '6000.3.21f1', dependencies: {
  'com.unity.visualscripting': '1.9.1', 'com.unity.render-pipelines.universal': '17.4.0', 'com.unity.inputsystem': '1.4.4',
} };

// Exercise the real direct page and its retained lifecycle, without the shared
// shell or any native project, installation, preferences or package operations.
async function openSetup(page, options = {}) {
  await page.route('**/app.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.addInitScript(options => {
    localStorage.setItem('creator-usage-terms.hub', JSON.stringify({ policyVersion: '2026-09-28-v1', acceptedAt: '2026-09-28T00:00:00Z' }));
    window.__CREATOR_HUB_FEATURE_PROTOCOL__ = 1;
    const fixture = window.setupFixture = {
      calls: [], pending: {}, hold: options.hold || null, failNext: options.failNext,
      outcome: options.outcome || 'success', canonicalPath: options.canonicalPath,
      creationOutcome: options.creationOutcome || 'success',
      resultSkippedChecks: options.resultSkippedChecks,
      latest: options.latest,
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
        const latest = structuredClone(fixture.latest);
        if (fixture.hold === name) await new Promise((resolve, reject) => { fixture.pending[name] = { resolve, reject }; });
        if (fixture.failNext === name) { fixture.failNext = null; throw new Error('Fixture refusal: ' + name); }
        switch (name) {
          case 'probe_environment': return structuredClone(fixture.environment);
          case 'latest_sdk_requirements': return latest;
          case 'create_project':
            if (fixture.creationOutcome === 'throw') throw new Error('Selected SDK metadata could not be fetched. No project files were created.');
            return { success: fixture.creationOutcome === 'success', projectPath: fields.request.parentDirectory + '/' + fields.request.projectName,
              message: fixture.creationOutcome === 'success' ? 'Validated project' : 'Selected SDK requirements could not be resolved. No project files were created.',
              hub: { registered: true, refreshPending: false, message: 'Registered in Unity Hub' } };
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
  }, { ...options, latest: Object.hasOwn(options, 'latest') ? options.latest : latestSdk });
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

test('new project waits for latest stable metadata, sends the exact selection and excludes duplicate creation', async ({ page }) => {
  await openSetup(page, { hold: 'latest_sdk_requirements', latest: { ...latestSdk, version: '4.0.25+build.7', unityVersion: null } });
  await waitPending(page, 'latest_sdk_requirements');
  await field(page, 'name').fill('Selected SDK'); await field(page, 'parent').fill('/keep/parent');
  await expect(field(page, 'sdk-selection')).toContainText('Checking latest stable');
  await expect(field(page, 'create')).toBeDisabled(); await expect(field(page, 'sdk-tested')).toBeHidden();
  await field(page, 'create').dispatchEvent('click'); await field(page, 'sdk-tested').dispatchEvent('click');
  expect(await calls(page, 'create_project')).toEqual([]);
  await settle(page, 'latest_sdk_requirements');
  await expect(field(page, 'sdk-selection')).toHaveText('Selected: Creator SDK 4.0.25+build.7 (latest stable).');
  await expect(field(page, 'create')).toBeEnabled();
  await hold(page, 'create_project'); await field(page, 'create').click(); await waitPending(page, 'create_project');
  for (const name of ['create', 'sdk-retry', 'sdk-tested']) await field(page, name).dispatchEvent('click');
  await navigateBack(page);
  expect(await calls(page, 'create_project')).toHaveLength(1);
  expect((await calls(page, 'create_project'))[0].args.args).toEqual({ request: {
    projectName: 'Selected SDK', parentDirectory: '/keep/parent', sdkVersion: '4.0.25+build.7',
  } });
  expect(await calls(page, 'latest_sdk_requirements')).toHaveLength(1);
  await settle(page, 'create_project');
  await expect(field(page, 'created')).toContainText('Validated project');
  await expect(field(page, 'create')).toBeDisabled(); await expect(field(page, 'sdk-retry')).toBeDisabled();
  await field(page, 'create').dispatchEvent('click');
  expect(await calls(page, 'create_project')).toHaveLength(1);
  expect((await calls(page, 'probe_environment')).length).toBe(2);
  await page.evaluate(() => { setupFixture.latest.version = '4.0.26'; });
  await hold(page, 'latest_sdk_requirements'); await field(page, 'another').click(); await waitPending(page, 'latest_sdk_requirements');
  await expect(field(page, 'create')).toBeDisabled(); await expect(field(page, 'sdk-selection')).toContainText('No SDK selected');
  await settle(page, 'latest_sdk_requirements');
  await expect(field(page, 'sdk-selection')).toContainText('4.0.26 (latest stable)');
  expect(await calls(page, 'create_project')).toHaveLength(1);
});

test('failed latest lookup requires explicit tested SDK choice and sends only useTestedSdk', async ({ page }) => {
  await openSetup(page, { failNext: 'latest_sdk_requirements' });
  await field(page, 'name').fill('Fallback project'); await field(page, 'parent').fill('/keep/fallback');
  await expect(field(page, 'sdk-error')).toContainText('Latest SDK unavailable');
  await expect(field(page, 'sdk-tested')).toHaveText('Use tested SDK 4.0.14');
  await expect(field(page, 'sdk-selection')).toHaveText('No SDK selected.');
  await expect(field(page, 'create')).toBeDisabled();
  await field(page, 'create').dispatchEvent('click');
  expect(await calls(page, 'create_project')).toEqual([]);
  await field(page, 'sdk-tested').click();
  await expect(field(page, 'sdk-selection')).toHaveText('Selected: Creator SDK 4.0.14 (tested fallback, not latest).');
  await expect(field(page, 'create')).toBeEnabled();
  await navigateBack(page);
  await expect(field(page, 'sdk-selection')).toContainText('4.0.14 (tested fallback');
  await field(page, 'create').click();
  await expect(field(page, 'created')).toContainText('Validated project');
  expect((await calls(page, 'create_project')).map(call => call.args.args)).toEqual([{ request: {
    projectName: 'Fallback project', parentDirectory: '/keep/fallback', useTestedSdk: true,
  } }]);
  expect(await calls(page, 'latest_sdk_requirements')).toHaveLength(1);
});

for (const failure of ['refused', 'malformed']) test(`retry invalidates a previous latest SDK selection when ${failure}`, async ({ page }) => {
  await openSetup(page);
  await expect(field(page, 'sdk-selection')).toContainText('4.0.25 (latest stable)');
  await field(page, 'name').fill('Retained draft'); await field(page, 'parent').fill('/keep/draft');
  await hold(page, 'latest_sdk_requirements');
  if (failure === 'malformed') await page.evaluate(() => { setupFixture.latest = { version: '4.0.26' }; });
  await field(page, 'sdk-retry').click(); await waitPending(page, 'latest_sdk_requirements');
  await expect(field(page, 'sdk-selection')).toContainText('No SDK selected');
  await expect(field(page, 'create')).toBeDisabled(); await expect(field(page, 'sdk-retry')).toBeDisabled();
  await field(page, 'create').dispatchEvent('click'); await field(page, 'sdk-retry').dispatchEvent('click');
  await settle(page, 'latest_sdk_requirements', failure === 'refused');
  await expect(field(page, 'sdk-error')).toContainText(failure === 'refused' ? 'Fixture refusal' : 'incomplete');
  await expect(field(page, 'sdk-selection')).toHaveText('No SDK selected.');
  await expect(field(page, 'create')).toBeDisabled(); await expect(field(page, 'sdk-tested')).toBeVisible();
  await expect(field(page, 'name')).toHaveValue('Retained draft'); await expect(field(page, 'parent')).toHaveValue('/keep/draft');
  await field(page, 'create').dispatchEvent('click');
  expect(await calls(page, 'create_project')).toEqual([]);
  expect(await calls(page, 'latest_sdk_requirements')).toHaveLength(2);
});

test('timed-out metadata cannot restore a choice during retry, and fresh latest selection clears fallback', async ({ page }) => {
  await page.clock.install();
  await openSetup(page, { hold: 'latest_sdk_requirements' }); await waitPending(page, 'latest_sdk_requirements');
  await field(page, 'name').fill('Keep through retry'); await field(page, 'parent').fill('/keep/retry');
  await page.clock.fastForward(20001);
  await expect(field(page, 'sdk-error')).toContainText('timed out'); await expect(field(page, 'create')).toBeDisabled();
  await field(page, 'sdk-tested').click(); await expect(field(page, 'create')).toBeEnabled();
  await page.evaluate(() => {
    setupFixture.oldLatest = setupFixture.pending.latest_sdk_requirements;
    delete setupFixture.pending.latest_sdk_requirements;
    setupFixture.latest.version = '4.0.26';
  });
  await field(page, 'sdk-retry').click(); await waitPending(page, 'latest_sdk_requirements');
  await expect(field(page, 'sdk-selection')).toContainText('No SDK selected');
  await expect(field(page, 'sdk-tested')).toBeHidden(); await expect(field(page, 'create')).toBeDisabled();
  await page.evaluate(() => { setupFixture.oldLatest.resolve(); });
  await field(page, 'sdk-tested').dispatchEvent('click'); await field(page, 'create').dispatchEvent('click');
  await expect(field(page, 'sdk-selection')).toContainText('Checking latest stable');
  expect(await calls(page, 'create_project')).toEqual([]);
  await settle(page, 'latest_sdk_requirements');
  await expect(field(page, 'sdk-selection')).toHaveText('Selected: Creator SDK 4.0.26 (latest stable).');
  await expect(field(page, 'sdk-error')).toBeHidden(); await expect(field(page, 'sdk-tested')).toBeHidden();
  await expect(field(page, 'name')).toHaveValue('Keep through retry'); await expect(field(page, 'parent')).toHaveValue('/keep/retry');
  await field(page, 'create').click(); await expect(field(page, 'created')).toContainText('Validated project');
  expect((await calls(page, 'create_project'))[0].args.args.request).toEqual({
    projectName: 'Keep through retry', parentDirectory: '/keep/retry', sdkVersion: '4.0.26',
  });
  expect(await calls(page, 'create_project')).toHaveLength(1);
});

test('retrying a tested choice must be explicitly chosen again if the next lookup fails', async ({ page }) => {
  await openSetup(page, { failNext: 'latest_sdk_requirements' });
  await field(page, 'sdk-tested').click(); await expect(field(page, 'create')).toBeEnabled();
  await page.evaluate(() => { setupFixture.failNext = 'latest_sdk_requirements'; });
  await field(page, 'sdk-retry').click();
  await expect(field(page, 'sdk-error')).toBeVisible(); await expect(field(page, 'sdk-selection')).toHaveText('No SDK selected.');
  await expect(field(page, 'create')).toBeDisabled();
  await field(page, 'create').dispatchEvent('click'); expect(await calls(page, 'create_project')).toEqual([]);
  await field(page, 'sdk-tested').click(); await expect(field(page, 'create')).toBeEnabled();
});

test('licence opener failure preserves the selected SDK and retries only on an explicit click', async ({ page }) => {
  await openSetup(page, { failNext: 'open_official_url' });
  await field(page, 'name').fill('Keep licence draft'); await field(page, 'parent').fill('/keep/licence');
  await field(page, 'licence-android').click();
  await expect(field(page, 'error')).toContainText('open_official_url');
  await expect(field(page, 'sdk-selection')).toContainText('4.0.25 (latest stable)');
  await expect(field(page, 'create')).toBeEnabled();
  await navigateBack(page);
  expect(await calls(page, 'open_official_url')).toHaveLength(1);
  await field(page, 'licence-android').click(); await expect(field(page, 'error')).toBeHidden();
  expect((await calls(page, 'open_official_url')).map(call => call.args.args)).toEqual(Array(2).fill({ url: 'https://developer.android.com/studio/terms' }));
  await expect(field(page, 'name')).toHaveValue('Keep licence draft'); await expect(field(page, 'parent')).toHaveValue('/keep/licence');
  expect(await calls(page, 'create_project')).toEqual([]);
  expect(await calls(page, 'latest_sdk_requirements')).toHaveLength(1);
});

for (const [label, latest] of [
  ['null response', null],
  ['missing version', { dependencies: latestSdk.dependencies }],
  ['blank version', { ...latestSdk, version: '   ' }],
  ['range version', { ...latestSdk, version: '^4.0.25' }],
  ['padded version', { ...latestSdk, version: ' 4.0.25' }],
  ['prerelease', { ...latestSdk, version: '4.0.26-beta.1' }],
  ['prerelease with build metadata', { ...latestSdk, version: '4.0.26-rc.1+build.7' }],
  ['oversized version', { ...latestSdk, version: '4.0.' + '1'.repeat(129) }],
  ['missing dependencies', { version: '4.0.25' }],
  ['empty dependencies', { ...latestSdk, dependencies: {} }],
  ['dependency array', { version: '4.0.25', dependencies: [] }],
  ['invalid dependency', { ...latestSdk, dependencies: { ...latestSdk.dependencies, 'com.example.package': null } }],
  ['blank dependency', { ...latestSdk, dependencies: { ...latestSdk.dependencies, 'com.example.package': ' ' } }],
  ['excess dependencies', { ...latestSdk, dependencies: { ...latestSdk.dependencies, ...Object.fromEntries(Array.from({ length: 126 }, (_, i) => [`com.example.p${i}`, '1.0.0'])) } }],
  ['invalid Unity minimum', { ...latestSdk, unityVersion: {} }],
]) test(`malformed latest metadata (${label}) never authorizes creation`, async ({ page }) => {
  await openSetup(page, { latest });
  await expect(field(page, 'sdk-error')).toContainText('incomplete');
  await expect(field(page, 'sdk-selection')).toHaveText('No SDK selected.'); await expect(field(page, 'create')).toBeDisabled();
  await expect(field(page, 'sdk-tested')).toHaveText('Use tested SDK 4.0.14'); await expect(field(page, 'sdk-retry')).toBeEnabled();
  await field(page, 'create').dispatchEvent('click'); expect(await calls(page, 'create_project')).toEqual([]);
});

for (const name of Object.keys(latestSdk.dependencies)) for (const [issue, version] of [
  ['missing', undefined], ['ranged', '^1.0.0'], ['prerelease', '1.0.0-beta.1'],
]) test(`latest ${name} ${issue} invalidates selection and immediately offers explicit fallback`, async ({ page }) => {
  await openSetup(page);
  await expect(field(page, 'sdk-selection')).toContainText('4.0.25 (latest stable)');
  await page.evaluate(({ name, version }) => {
    if (version === undefined) delete setupFixture.latest.dependencies[name];
    else setupFixture.latest.dependencies[name] = version;
  }, { name, version });
  await field(page, 'sdk-retry').click();
  await expect(field(page, 'sdk-error')).toContainText('incomplete');
  await expect(field(page, 'sdk-selection')).toHaveText('No SDK selected.');
  await expect(field(page, 'sdk-package-plan')).toBeHidden();
  await expect(field(page, 'create')).toBeDisabled(); await expect(field(page, 'sdk-tested')).toBeVisible();
  await expect(field(page, 'error')).toBeHidden();
  expect(await calls(page, 'create_project')).toEqual([]);
  await field(page, 'sdk-tested').click(); await field(page, 'create').click();
  await expect(field(page, 'created')).toContainText('Validated project');
  expect((await calls(page, 'create_project')).map(call => call.args.args.request)).toEqual([{
    projectName: 'My Creator Space', parentDirectory: '/projects', useTestedSdk: true,
  }]);
});

for (const creationOutcome of ['throw', 'failure']) test(`backend metadata ${creationOutcome} keeps fields and explicit SDK retry available`, async ({ page }) => {
  await openSetup(page, { creationOutcome });
  await field(page, 'name').fill('Keep on backend refusal'); await field(page, 'parent').fill('/keep/refusal');
  await field(page, 'create').click();
  await expect(field(page, 'error')).toContainText('No project files were created');
  await expect(field(page, 'activity')).toBeHidden(); await expect(field(page, 'sdk-retry')).toBeEnabled();
  await expect(field(page, 'sdk-selection')).toHaveText('Selected: Creator SDK 4.0.25 (latest stable).');
  await expect(field(page, 'sdk-tested')).toBeHidden();
  await expect(field(page, 'name')).toBeEnabled(); await expect(field(page, 'parent')).toBeEnabled();
  await expect(field(page, 'name')).toHaveValue('Keep on backend refusal'); await expect(field(page, 'parent')).toHaveValue('/keep/refusal');
  await expect(field(page, 'open')).toBeHidden(); expect(await calls(page, 'create_project')).toHaveLength(1);
  await page.evaluate(() => { setupFixture.latest.version = '4.0.26'; setupFixture.creationOutcome = 'success'; });
  await field(page, 'sdk-retry').click(); await expect(field(page, 'sdk-selection')).toContainText('4.0.26 (latest stable)');
  expect(await calls(page, 'create_project')).toHaveLength(1);
  await field(page, 'create').click(); await expect(field(page, 'created')).toContainText('Validated project');
  expect((await calls(page, 'create_project'))[1].args.args.request).toEqual({
    projectName: 'Keep on backend refusal', parentDirectory: '/keep/refusal', sdkVersion: '4.0.26',
  });
});

for (const width of [940, 390]) test(`new project SDK selection and fallback fit at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 800 }); await openSetup(page);
  await expect(field(page, 'sdk-selection')).toContainText('latest stable');
  await page.screenshot({ path: testInfo.outputPath('new-project-sdk.png'), fullPage: true });
  await page.evaluate(() => { setupFixture.failNext = 'latest_sdk_requirements'; });
  await field(page, 'sdk-retry').click(); await field(page, 'sdk-tested').click();
  await expect(field(page, 'sdk-selection')).toContainText('tested fallback, not latest');
  await page.screenshot({ path: testInfo.outputPath('new-project-fallback.png'), fullPage: true });
  for (const name of ['sdk-selection', 'sdk-retry', 'sdk-tested', 'create']) {
    expect(await field(page, name).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

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
  await expect(field(page, 'recipe')).toContainText('Unity and build tools');
  await expect(field(page, 'recipe')).not.toContainText('Creator SDK');
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

test('latest SDK is fetched for creation and remains read-only on Existing entry and refresh', async ({ page }) => {
  await openSetup(page);
  await expect(field(page, 'sdk-selection')).toContainText('4.0.25 (latest stable)');
  expect(await calls(page, 'latest_sdk_requirements')).toHaveLength(1);
  await field(page, 'existing-tab').click();
  await expect(field(page, 'latest-status')).toContainText('4.0.25');
  await expect(field(page, 'latest-status')).toContainText('6000.3.21f1');
  await expect(field(page, 'latest-dependencies')).toContainText('Visual Scripting: 1.9.1');
  await page.evaluate(() => { setupFixture.latest = { ...setupFixture.latest, version: '4.0.26', unityVersion: '6000.3.28f1' }; });
  await field(page, 'latest-refresh').click();
  await expect(field(page, 'latest-status')).toContainText('4.0.26');
  expect(await calls(page, 'latest_sdk_requirements')).toHaveLength(3);
  await field(page, 'new-tab').click();
  await expect(field(page, 'recipe')).toContainText('Unity and build tools');
  await expect(field(page, 'recipe')).not.toContainText('Creator SDK');
  await expect(field(page, 'recipe')).toContainText('Unity 6000.3.21f1');
  await expect(field(page, 'sdk-selection')).toContainText('4.0.26 (latest stable)');
  await field(page, 'existing-tab').click();
  await expect(field(page, 'latest-status')).toContainText('4.0.26');
  expect(await calls(page, 'latest_sdk_requirements')).toHaveLength(4);
  await page.evaluate(() => { setupFixture.latest.version = '4.0.27'; });
  await navigateBack(page);
  await expect(field(page, 'latest-status')).toContainText('4.0.27');
  expect(await calls(page, 'latest_sdk_requirements')).toHaveLength(5);
  expect(await calls(page, 'run_existing_project')).toEqual([]);
  expect(await calls(page, 'create_project')).toEqual([]);
  expect(await calls(page, 'open_project')).toEqual([]);
  expect(await calls(page, 'open_official_url')).toEqual([]);
});

test('latest tag selection does not replace existing-project newer or prerelease advisories', async ({ page }) => {
  await openSetup(page, { inspection: {
    partialRepair: true, canRepair: true, canValidate: false,
    findings: [
      { title: 'Creator SDK', status: 'check', qualificationRequired: true, detail: 'Installed reference 4.0.99-beta.1 is kept. No automatic version replacement.' },
      { title: 'Visual Scripting package', status: 'check', qualificationRequired: true, detail: 'Installed reference 1.9.13 is kept. Version-specific validation skipped.' },
    ],
    proposedChanges: ['Add a missing supported registry scope.'],
  } });
  await existing(page, '/projects/Newer installed SDK');
  await expect(field(page, 'latest-status')).toContainText('4.0.25');
  await expect(field(page, 'latest-dependencies')).toHaveText('URP: 17.4.0 · Input System: 1.4.4 · Visual Scripting: 1.9.1');
  await expect(field(page, 'findings')).toContainText('4.0.99-beta.1 is kept');
  await expect(field(page, 'findings')).toContainText('1.9.13 is kept');
  await expect(field(page, 'findings')).toContainText('Newer version kept');
  await expect(field(page, 'validate')).toBeHidden(); await expect(field(page, 'repair')).toBeDisabled();
  expect(await calls(page, 'run_existing_project')).toEqual([]);
  await field(page, 'new-tab').click();
  await expect(field(page, 'sdk-selection')).toHaveText('Selected: Creator SDK 4.0.25 (latest stable).');
  await field(page, 'create').click(); await expect(field(page, 'created')).toContainText('Validated project');
  expect((await calls(page, 'create_project'))[0].args.args.request).toEqual({
    projectName: 'My Creator Space', parentDirectory: '/projects', sdkVersion: '4.0.25',
  });
});

test('offline latest lookup stays local and does not block inspection or supported controls', async ({ page }) => {
  await openSetup(page);
  await page.evaluate(() => { setupFixture.failNext = 'latest_sdk_requirements'; });
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
  const dependencies = { ...latestSdk.dependencies, ...Object.fromEntries(Array.from({ length: 125 }, (_, i) => [`com.example.package${i}`, '1.0.0'])) };
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
  expect(await calls(page, 'latest_sdk_requirements')).toHaveLength(2);
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
