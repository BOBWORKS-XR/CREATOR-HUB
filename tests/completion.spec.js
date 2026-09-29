const { test, expect } = require('@playwright/test');

for (const width of [980, 390]) test(`standalone Plugins grid keeps Setup state and remembers its view at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 760 });
  const fixture = require('./fixtures/community/start-location.json');
  await setup(page, { community: [fixture] });
  await page.locator('#project-name').fill('Keep this project draft');
  await page.locator('#suite-trigger').click(); await page.locator('#suite-plugins').click();
  await expect(page.locator('.community-list')).toHaveAttribute('data-layout', 'grid');
  await expect(page.getByRole('button', { name: 'Grid view', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('heading', { name: 'Start Location' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#suite-trigger').click(); await page.locator('#suite-current').click();
  await expect(page.locator('#project-name')).toHaveValue('Keep this project draft');
  await page.reload();
  await page.locator('#suite-trigger').click(); await page.locator('#suite-plugins').click();
  await expect(page.locator('.community-list')).toHaveAttribute('data-layout', 'grid');
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await page.reload();
  await page.locator('#suite-trigger').click(); await page.locator('#suite-plugins').click();
  await expect(page.locator('.community-list')).toHaveAttribute('data-layout', 'list');
  expect(await page.evaluate(() => window.calls.some(c => /install_community|queue_community|download_community/.test(c.command)))).toBe(false);
});

test('fresh Windows PC offers one setup action without a wall of dependent errors', async ({ page }, testInfo) => {
  await setup(page, { missingUnity: true, legacyHub: true });
  await expect(page.locator('#create-button')).toHaveText('Set up and create project');
  await expect(page.locator('#requirements-consent')).toBeVisible();
  await expect(page.locator('#requirements .requirement.bad')).toHaveCount(1);
  await expect(page.locator('#requirements')).toContainText('Will install: Android tools, Windows support and the URP template.');
  await page.screenshot({ path: testInfo.outputPath('fresh-pc.png'), fullPage: true });
  expect(await page.evaluate(() => window.calls.some(call => call.command === 'create_project'))).toBe(false);
  await page.locator('#create-button').click();
  await expect(page.locator('#open-project-button')).toBeEnabled();
  expect(await page.evaluate(() => window.calls.filter(call => call.command === 'create_project').length)).toBe(1);
});

test('requirements progress switches to project progress and does not fake installer percent', async ({ page }, testInfo) => {
  await setup(page, { missingUnity: true, missingHub: true, pending: true });
  await page.locator('#create-button').click();
  await expect(page.locator('#project-details')).toBeHidden();
  await expect(page.locator('#unity-download-button')).toBeDisabled();
  await page.evaluate(() => window.eventCallbacks['requirements-progress']({ payload: { stage: 'Downloading requirements', detail: 'Android Build Support', percent: 28 } }));
  await expect(page.locator('#download-progress')).toHaveAttribute('value', '28');
  await page.evaluate(() => window.eventCallbacks['requirements-progress']({ payload: { stage: 'Installing requirements', detail: 'Android Build Support', percent: null } }));
  await expect(page.locator('#download-progress')).not.toHaveAttribute('value');
  await expect(page.locator('#stage-progress')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('installing-requirements.png'), fullPage: true });
  await page.evaluate(() => window.progressCallback({ payload: { step: 3, detail: 'Unity is compiling.' } }));
  await expect(page.locator('#download-progress')).toBeHidden();
  await expect(page.locator('#stage-progress')).toBeVisible();
  await expect(page.locator('#activity-message')).toHaveText('Unity is compiling.');
  await page.evaluate(() => { window.options.missingUnity = false; window.finishCreate(); });
  await expect(page.locator('#open-project-button')).toBeEnabled();
});

test('native requirements snapshot replaces stale missing state before import finishes', async ({ page }, testInfo) => {
  await setup(page, { missingUnity: true, legacyHub: true, pending: true });
  const unity = page.locator('.requirement').filter({ hasText: 'Unity 6000.3.21f1' });
  await page.locator('#create-button').click();
  await page.evaluate(() => window.eventCallbacks['requirements-progress']({ payload: {
    stage: 'Installing requirements', detail: 'Installing Unity...', percent: 100,
  } }));
  await expect(unity).toContainText('Missing');
  // Model a fresh native probe, then deliver it in the first project event.
  await page.evaluate(async () => {
    window.options.missingUnity = false;
    window.checkedEnvironment = await window.__TAURI__.core.invoke('probe_environment');
  });
  const probes = await page.evaluate(() => window.calls.filter(call => call.command === 'probe_environment').length);
  await page.evaluate(() => {
    window.progressCallback({ payload: { step: 1, detail: 'Checked installed Unity and required modules.', environment: window.checkedEnvironment } });
    window.progressCallback({ payload: { step: 3, detail: 'Importing Packages/com.unity.render-pipelines.core/Runtime/Example.fbx' } });
  });
  await expect(unity).toContainText('Installed');
  await expect(page.locator('#requirements .requirement.bad')).toHaveCount(0);
  await expect(page.locator('#requirements')).toContainText('Official 3D URP template');
  await expect(page.locator('#requirements')).not.toContainText('Will install:');
  await expect(page.locator('#blockers')).toBeHidden();
  await expect(page.locator('#hub-button')).toBeHidden();
  await expect(page.locator('#activity-title')).toHaveText('Import and compile');
  await expect(page.locator('#overall-status')).toHaveText('Creating project');
  await expect(page.locator('#refresh-button')).toBeDisabled();
  await expect(page.locator('#open-project-button')).toBeHidden();
  expect(await page.evaluate(() => window.calls.filter(call => call.command === 'probe_environment').length)).toBe(probes);
  await page.screenshot({ path: testInfo.outputPath('installed-requirements-during-import.png'), fullPage: true });
  await page.evaluate(() => window.finishCreate());
  await expect(page.locator('#open-project-button')).toBeEnabled();
});

test('project progress alone cannot invent installed requirements or erase real blockers', async ({ page }) => {
  await setup(page, { missingUnity: true, pending: true });
  await page.locator('#create-button').click();
  await page.evaluate(() => window.progressCallback({ payload: { step: 2, detail: 'Preparing project' } }));
  await expect(page.locator('#blockers')).toContainText('not installed');
  await page.evaluate(async () => {
    const report = await window.__TAURI__.core.invoke('probe_environment');
    window.progressCallback({ payload: { step: 3, detail: 'Checking', environment: report } });
  });
  await expect(page.locator('.requirement').filter({ hasText: 'Unity 6000.3.21f1' })).toContainText('Missing');
  await expect(page.locator('#blockers')).toBeVisible();
  await page.evaluate(() => { window.options.createError = 'Requirements not ready'; window.finishCreate(); });
  await expect(page.locator('#result')).toContainText('Requirements not ready');
});

for (const scenario of [
  { name: 'already detected Hub', missingHub: false, legacyHub: false },
  { name: 'Hub installed during setup', missingHub: true, legacyHub: false },
  { name: 'older installed Hub', missingHub: false, legacyHub: true },
]) {
  test(`completion refresh retains a detected Unity Hub: ${scenario.name}`, async ({ page }, testInfo) => {
    await setup(page, { ...scenario, pending: true });
    const hub = page.locator('#requirements .requirement').filter({ hasText: 'Unity Hub or Unity CLI' });
    const probes = await page.evaluate(() => window.calls.filter(call => call.command === 'probe_environment').length);
    await page.locator('#create-button').click();
    await page.evaluate(() => {
      window.options.missingHub = false;
      window.progressCallback({ payload: { step: 7, detail: 'Project ready.' } });
      window.finishCreate();
    });
    await expect(page.locator('#open-project-button')).toBeEnabled();
    await expect(page.locator('#activity')).toBeHidden();
    await expect(page.locator('#result.success')).toBeVisible();
    await expect(hub).toContainText(scenario.legacyHub ? 'Hub 3.14.4' : 'Hub 3.21.1');
    await expect(hub).not.toHaveClass(/bad/);
    await expect(hub).not.toContainText('Missing');
    expect(await page.evaluate(() => window.calls.filter(call => call.command === 'probe_environment').length)).toBe(probes + 1);
    await page.screenshot({ path: testInfo.outputPath('post-creation-hub-detected.png'), fullPage: true });
  });
}

test('failed final probe retains the last checked Hub status after successful creation', async ({ page }) => {
  await setup(page, { pending: true });
  await page.locator('#create-button').click();
  await page.evaluate(() => { window.options.probeError = 'Environment check temporarily unavailable.'; window.finishCreate(); });
  await expect(page.locator('#open-project-button')).toBeEnabled();
  await expect(page.locator('#result.success')).toBeVisible();
  await expect(page.locator('#requirements .requirement').filter({ hasText: 'Unity Hub or Unity CLI' })).toContainText('Hub 3.21.1');
});

for (const width of [390, 560]) {
  test(`fresh-PC installation controls fit at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 760 });
    await setup(page, { missingUnity: true, missingHub: true });
    await expect(page.locator('#create-button')).toBeEnabled();
    await expect(page.locator('#requirements-consent')).toBeVisible();
    const layout = await page.evaluate(() => {
      const form = document.querySelector('#project-details').getBoundingClientRect();
      const consent = document.querySelector('#requirements-consent').getBoundingClientRect();
      const button = document.querySelector('#create-button').getBoundingClientRect();
      return { scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth, fits: consent.left >= form.left && consent.right <= form.right && consent.top >= button.bottom };
    });
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewport);
    expect(layout.fits).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('fresh-pc-small.png'), fullPage: true });
  });
}

for (const width of [390, 980]) {
  test(`download bytes and measured speed fit at ${width}px and clear on transitions`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 760 });
    await setup(page, { missingUnity: true, legacyHub: true, pending: true });
    await page.locator('#create-button').click();
    await page.evaluate(() => window.eventCallbacks['requirements-progress']({ payload: {
      stage: 'Downloading requirements', detail: 'Downloading 6000.3.21f1-x86_64...', percent: 30,
      transfer: { totalBytes: 4092408560, downloadedBytes: 1227722568, bytesPerSecond: 12400000, plannedBytes: 6954591148, estimated: true },
    } }));
    await expect(page.locator('#download-size')).toHaveText('1.23 GB / 4.09 GB');
    await expect(page.locator('#download-speed')).toHaveText('~12.40 MB/s');
    await expect(page.locator('#download-plan')).toHaveText('Editor + tools: 6.95 GB');
    await expect(page.locator('#download-progress')).toHaveAttribute('aria-label', 'Current file download');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const layout = await page.locator('#download-metrics').evaluate(node => {
      const outer = node.getBoundingClientRect();
      return [...node.children].every(child => { const rect = child.getBoundingClientRect(); return rect.left >= outer.left && rect.right <= outer.right; });
    });
    expect(layout).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('download-metrics.png'), fullPage: true });
    await page.evaluate(() => window.eventCallbacks['requirements-progress']({ payload: {
      stage: 'Downloading requirements', detail: 'Downloading OpenJDK...', percent: null,
      transfer: { totalBytes: 118110508, downloadedBytes: null, bytesPerSecond: null, estimated: true },
    } }));
    await expect(page.locator('#download-size')).toHaveText('File size: 118.11 MB');
    await expect(page.locator('#download-speed')).toHaveText('Speed unavailable');
    await expect(page.locator('#download-plan')).toBeEmpty();
    await page.evaluate(() => window.eventCallbacks['requirements-progress']({ payload: { stage: 'Installing requirements', detail: 'Installing OpenJDK...', percent: null } }));
    await expect(page.locator('#download-metrics')).toBeHidden();
    await expect(page.locator('#download-speed')).toBeEmpty();
    await page.evaluate(() => window.progressCallback({ payload: { step: 3, detail: 'Unity is compiling.' } }));
    await expect(page.locator('#download-metrics')).toBeHidden();
    await page.evaluate(() => window.finishCreate());
    await expect(page.locator('#open-project-button')).toBeEnabled();
  });
}

test('download metrics reject invalid numbers and preserve a genuine zero speed', async ({ page }) => {
  await setup(page, { missingUnity: true, pending: true });
  await page.locator('#create-button').click();
  for (const transfer of [
    { totalBytes: -1, downloadedBytes: -1, bytesPerSecond: -1 },
    { totalBytes: 100, downloadedBytes: 101, bytesPerSecond: Infinity },
    { totalBytes: '100', downloadedBytes: '50', bytesPerSecond: '25' },
    { totalBytes: NaN, downloadedBytes: NaN, bytesPerSecond: NaN },
  ]) {
    await page.evaluate(transfer => window.eventCallbacks['requirements-progress']({ payload: { stage: 'Downloading requirements', detail: 'Downloading...', transfer } }), transfer);
    await expect(page.locator('#download-speed')).toHaveText('Speed unavailable');
    await expect(page.locator('#download-size')).not.toContainText('NaN');
  }
  await page.evaluate(() => window.eventCallbacks['requirements-progress']({ payload: {
    stage: 'Downloading requirements', detail: 'Downloading...', transfer: { totalBytes: 10000, downloadedBytes: 4000, bytesPerSecond: 0 },
  } }));
  await expect(page.locator('#download-speed')).toHaveText('0 B/s');
  await page.evaluate(() => { window.options.createError = 'Download failed'; window.finishCreate(); });
  await expect(page.locator('#download-metrics')).toBeHidden();
  await expect(page.locator('#result')).toContainText('Download failed');
  await page.locator('#create-button').click();
  await expect(page.locator('#download-metrics')).toBeHidden();
  await expect(page.locator('#download-progress')).toBeHidden();
  await expect(page.locator('#stage-progress')).toBeVisible();
  await page.evaluate(() => window.finishCreate());
});

test('a quiet download does not leave a stale speed on screen', async ({ page }) => {
  await setup(page, { missingUnity: true, pending: true });
  await page.clock.install();
  await page.locator('#create-button').click();
  const report = () => window.eventCallbacks['requirements-progress']({ payload: {
    stage: 'Downloading Unity Hub', detail: 'Unity Hub 3.21.1', percent: 50,
    transfer: { totalBytes: 182869104, downloadedBytes: 91434552, bytesPerSecond: 1000000 },
  } });
  await page.evaluate(report);
  await expect(page.locator('#download-speed')).toHaveText('1.00 MB/s');
  await page.clock.fastForward(5000);
  await expect(page.locator('#download-speed')).toHaveText('Waiting for download data');
  await expect(page.locator('#download-size')).toHaveText('91.43 MB / 182.87 MB');
  await page.evaluate(report);
  await expect(page.locator('#download-speed')).toHaveText('1.00 MB/s');
  await page.evaluate(() => window.finishCreate());
});

for (const message of ['Setup cancelled before installation.', 'Not enough free space. Nothing was installed.', 'Unity requirement installation failed. Recheck before retrying.']) {
  test(`prerequisite failure preserves inputs and permits a fresh check: ${message}`, async ({ page }) => {
    await setup(page, { missingUnity: true, createError: message });
    await page.locator('#project-name').fill('Keep this name');
    await page.locator('#create-button').click();
    await expect(page.locator('#result')).toContainText(message);
    await expect(page.locator('#project-name')).toHaveValue('Keep this name');
    await expect(page.locator('#create-button')).toBeEnabled();
    await expect(page.locator('#open-project-button')).toBeHidden();
    expect(await page.evaluate(() => Object.keys(window.eventCallbacks))).not.toContain('requirements-progress');
  });
}

test('licence links are explicit and unsupported platforms do not offer automatic installs', async ({ page }) => {
  await setup(page, { missingUnity: true });
  await page.locator('[data-terms="android"]').click();
  expect(await page.evaluate(() => window.calls.at(-1))).toEqual({ command: 'open_official_url', args: { url: 'https://developer.android.com/studio/terms' } });
  await page.evaluate(() => { window.options.platform = 'unknown'; });
  await page.locator('#refresh-button').click();
  await expect(page.locator('#create-button')).toBeDisabled();
  await expect(page.locator('#requirements-consent')).toBeHidden();
});

test('CLI-only ready installations keep Unity terms accessible for an activation handoff', async ({ page }) => {
  await setup(page, { missingHub: true });
  await expect(page.locator('#create-button')).toHaveText('Create and validate project');
  await expect(page.locator('[data-terms="unity"]')).toBeVisible();
  await page.locator('[data-terms="unity"]').click();
  expect(await page.evaluate(() => window.calls.at(-1))).toEqual({ command: 'open_official_url', args: { url: 'https://unity.com/legal/editor-terms-of-service/software' } });
});

async function setup(page, options = {}) {
  await page.addInitScript(options => {
    if (!options.freshTerms) localStorage.setItem('creator-usage-terms.setup', JSON.stringify({ policyVersion: '2026-09-28-v1', acceptedAt: '2026-09-28T00:00:00.000Z' }));
    window.calls = [];
    window.options = options;
    window.eventCallbacks = {};
    window.__TAURI__ = { event: { listen: async (name, callback) => {
      window.eventCallbacks[name] = callback;
      if (name === 'setup-progress') window.progressCallback = callback;
      return () => { delete window.eventCallbacks[name]; if (name === 'setup-progress') window.progressCallback = null; };
    } }, core: { invoke: async (command, args) => {
      window.calls.push({ command, args });
      if (command === 'community_catalogue') return { entries: window.options.community || [], warnings: [], stale: false };
      if (command === 'probe_environment' && window.options.probeError) throw window.options.probeError;
      if (command === 'probe_environment') return {
        platform: window.options.platform || 'windows', ready: !window.options.missingUnity, hubInstalled: !window.options.missingHub, unityCliInstalled: false,
        hubVersion: window.options.legacyHub ? '3.14.4' : '3.21.1', hubAutoRegistration: !window.options.legacyHub,
        suggestedProjectParent: 'F:\\UnityTest', blockers: window.options.missingUnity ? ['Unity Editor 6000.3.21f1 is not installed.'] : [],
        recipe: { editorVersion: '6000.3.21f1', creatorSdkVersion: '4.0.14', urpVersion: '17.3.0', inputSystemVersion: '1.20.0' },
        editors: window.options.missingUnity ? [] : [{ exactRecipe: true, androidPlayer: true, androidSdk: true, androidNdk: true, openJdk: true, windowsStandalone: true, urpTemplate: 'template.tgz' }],
      };
      if (command === 'create_project') {
        if (window.options.pending) await new Promise(resolve => window.finishCreate = resolve);
        if (window.options.createError) throw window.options.createError;
        if (window.options.failCreate) throw 'Project already exists. No files were changed.';
        return { success: true, projectPath: `${args.request.parentDirectory}\\${args.request.projectName}`, message: 'Project validated.', hub: window.options.legacyHub ? { registered: false, requiresHubUpdate: true, message: 'Unity Hub 3.14.4 uses the old registry. Update to 3.21.1 or use Add > Add project from disk.' } : { registered: !window.options.failHub, refreshPending: !window.options.failHub, message: window.options.failHub ? 'Download failed. Your project is ready to open.' : 'Project registered. A running Unity Hub may need a full restart to show it in Projects.' } };
      }
      if (command === 'register_project') return { registered: true, refreshPending: true, message: 'Project registered. A running Unity Hub may need a full restart to show it in Projects.' };
      if (command === 'restart_hub') {
        if (window.options.pendingRestart) await new Promise(resolve => window.finishRestart = resolve);
        if (window.options.failRestart) throw 'Unity Hub did not fully exit. Nothing was force-closed.';
        return !window.options.cancelRestart;
      }
      if (command === 'inspect_project') return {
        projectPath: args.path, fingerprint: 'reviewed-files-sha256', canRepair: !window.options.blocked, canValidate: !window.options.blocked,
        findings: [{ status: window.options.blocked ? 'blocked' : 'repair', title: 'Visual Scripting setup', detail: window.options.blocked ? 'Project is open. Close Unity.' : 'Node database is missing.' }, { status: 'pass', title: 'Unity version', detail: '6000.3.21f1' }],
        proposedChanges: window.options.blocked ? [] : ['Rebuild Creator Visual Scripting nodes; retain existing type selections.'],
      };
      if (command === 'run_existing_project') {
        if (window.options.pendingRepair) await new Promise(resolve => window.finishRepair = resolve);
        return { success: !window.options.failRepair, projectPath: args.request.projectPath, backupPath: `${args.request.projectPath}\\.creator-project-setup\\backups\\test`, reportPath: 'result.json', message: window.options.failRepair ? 'Compilation failed. Backup retained. No automatic rollback was attempted.' : 'Unity validation passed.' };
      }
      if (command === 'open_project' && window.options.failOpen) throw 'Unity could not be opened.';
    } } };
  }, options);
  await page.goto('http://127.0.0.1:4187');
  if (options.freshTerms) return;
  if (options.missingUnity && options.platform && options.platform !== 'windows') await expect(page.locator('#create-button')).toBeDisabled();
  else await expect(page.locator('#create-button')).toBeEnabled();
}

test('first launch requires saved terms acceptance before environment checks', async ({ page }) => {
  await setup(page, { freshTerms: true });
  const dialog = page.locator('#usage-terms-dialog');
  await expect(dialog).toBeVisible();
  const layout = await dialog.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, background: getComputedStyle(node).backgroundColor, viewport: { x: innerWidth / 2, y: innerHeight / 2 } };
  });
  expect(Math.abs(layout.x - layout.viewport.x)).toBeLessThan(2);
  expect(Math.abs(layout.y - layout.viewport.y)).toBeLessThan(2);
  expect(layout.background).toBe('rgb(17, 21, 24)');
  await expect(page.locator('#create-button')).toBeDisabled();
  expect(await page.locator('#create-button').evaluate(node => node.closest('main').inert)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.calls.some(call => call.command === 'probe_environment'))).toBe(false);
  await expect(page.locator('#usage-terms-continue')).toBeDisabled();
  await page.locator('#usage-terms-checkbox').check();
  await page.locator('#usage-terms-continue').click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.calls.some(call => call.command === 'probe_environment'))).toBe(true);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('creator-usage-terms.setup')).policyVersion)).toBe('2026-09-28-v1');
  await page.reload();
  await expect(dialog).toBeHidden();
});

test('fixed Setup help identifies this app and explains common setup issues', async ({ page }) => {
  await setup(page);
  const help = page.locator('#context-help-dialog');
  await page.locator('#context-help-open').click();
  await expect(help).toBeVisible();
  const rect = await help.evaluate(node => {
    const bounds = node.getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, background: getComputedStyle(node).backgroundColor, viewport: { x: innerWidth / 2, y: innerHeight / 2 } };
  });
  expect(Math.abs(rect.x - rect.viewport.x)).toBeLessThan(2);
  expect(Math.abs(rect.y - rect.viewport.y)).toBeLessThan(2);
  expect(rect.background).toBe('rgb(17, 21, 24)');
  await expect(help).toContainText('This app creates and validates Unity projects');
  await expect(help).toContainText('Creator Works MCP');
  await expect(help).toContainText('The app preserves the project');
  await page.locator('#context-help-close').click();
  await expect(help).toBeHidden();
});

test('Hub failure preserves completed project and retry does not recreate it', async ({ page }) => {
  await setup(page, { failHub: true });
  await page.locator('#create-button').click();
  await expect(page.locator('#hub-result')).toContainText('Download failed');
  await expect(page.locator('#open-project-button')).toBeEnabled();
  await page.locator('#retry-hub-button').click();
  await expect(page.locator('#hub-result')).toContainText('Project registered.');
  await expect(page.locator('#retry-hub-button')).toBeHidden();
  const calls = await page.evaluate(() => window.calls);
  expect(calls.filter(call => call.command === 'create_project')).toHaveLength(1);
  expect(calls.filter(call => call.command === 'register_project')).toHaveLength(1);
});

test('legacy Hub does not receive a green registration claim and update retry preserves project', async ({ page }, testInfo) => {
  await setup(page, { legacyHub: true });
  await expect(page.locator('#requirements')).toContainText('Hub 3.14.4');
  await expect(page.locator('#requirements')).toContainText('Automatic Hub registration is optional');
  await page.locator('#create-button').click();
  await expect(page.locator('#hub-result')).toHaveClass('hub-result pending');
  await expect(page.locator('#hub-result')).toContainText('3.14.4');
  await expect(page.locator('#open-project-button')).toBeEnabled();
  await expect(page.locator('#retry-hub-button')).toHaveText('Recheck Hub and add project');
  await page.screenshot({ path: testInfo.outputPath('legacy-hub.png'), fullPage: true });
  await page.locator('#open-result-hub-button').click();
  expect(await page.evaluate(() => window.calls.filter(call => call.command === 'launch_hub').length)).toBe(1);
  await page.evaluate(() => window.options.legacyHub = false);
  await page.locator('#retry-hub-button').click();
  await expect(page.locator('#hub-result')).toHaveClass('hub-result pending');
  await expect(page.locator('#requirements')).toContainText('Hub 3.21.1');
  expect(await page.evaluate(() => window.calls.filter(call => call.command === 'create_project').length)).toBe(1);
});

async function inspectExisting(page, options = {}) {
  await setup(page, options);
  await page.locator('#existing-mode').click();
  await page.locator('#existing-path').fill('F:\\UnityTest\\Existing project');
  await page.locator('#inspect-button').click();
  await expect(page.locator('#inspection-findings')).toContainText('Visual Scripting');
}

test('registered projects offer a confirmed Hub restart without claiming UI visibility', async ({ page }, testInfo) => {
  await setup(page);
  await page.locator('#create-button').click();
  await expect(page.locator('#hub-result')).toHaveClass('hub-result pending');
  await expect(page.locator('#restart-hub-button')).toBeVisible();
  expect(await page.evaluate(() => window.calls.some(call => call.command === 'restart_hub'))).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('hub-restart-pending.png'), fullPage: true });
  await page.locator('#restart-hub-button').click();
  await expect(page.locator('#hub-result')).toHaveClass('hub-result');
  await expect(page.locator('#hub-result')).toContainText('Unity Hub restarted. Check its Projects list.');
  await expect(page.locator('#restart-hub-button')).toBeHidden();
  await expect(page.locator('#open-project-button')).toBeEnabled();
  const calls = await page.evaluate(() => window.calls);
  expect(calls.filter(call => call.command === 'create_project')).toHaveLength(1);
  expect(calls.filter(call => call.command === 'restart_hub')).toHaveLength(1);
  expect(calls.filter(call => call.command === 'open_project')).toHaveLength(0);
  await page.locator('#create-another-button').click();
  await expect(page.locator('#restart-hub-button')).toBeHidden();
});

test('cancelling the native restart prompt preserves the pending state', async ({ page }) => {
  await setup(page, { cancelRestart: true });
  await page.locator('#create-button').click();
  const before = await page.locator('#hub-result').textContent();
  await page.locator('#restart-hub-button').click();
  await expect(page.locator('#hub-result')).toHaveText(before);
  await expect(page.locator('#restart-hub-button')).toBeEnabled();
  await expect(page.locator('#open-project-button')).toBeEnabled();
});

test('restart failures retain the project and allow retry', async ({ page }) => {
  await setup(page, { failRestart: true });
  await page.locator('#create-button').click();
  await page.locator('#restart-hub-button').click();
  await expect(page.locator('#action-error')).toContainText('Nothing was force-closed');
  await expect(page.locator('#hub-result')).toHaveClass('hub-result pending');
  await expect(page.locator('#restart-hub-button')).toBeEnabled();
  await expect(page.locator('#open-result-hub-button')).toBeEnabled();
  await page.evaluate(() => window.options.failRestart = false);
  await page.locator('#restart-hub-button').click();
  await expect(page.locator('#action-error')).toBeHidden();
  await expect(page.locator('#hub-result')).toContainText('Unity Hub restarted');
  expect(await page.evaluate(() => window.calls.filter(call => call.command === 'create_project').length)).toBe(1);
});

test('a pending restart locks conflicting actions and cannot be submitted twice', async ({ page }) => {
  await setup(page, { pendingRestart: true });
  await page.locator('#create-button').click();
  await page.locator('#restart-hub-button').click();
  await expect(page.locator('#restart-hub-button')).toBeDisabled();
  await expect(page.locator('#existing-mode')).toBeDisabled();
  await expect(page.locator('#open-project-button')).toBeDisabled();
  await expect(page.locator('#create-another-button')).toBeDisabled();
  await expect(page.locator('#refresh-button')).toBeDisabled();
  await page.locator('#restart-hub-button').dispatchEvent('click');
  expect(await page.evaluate(() => window.calls.filter(call => call.command === 'restart_hub').length)).toBe(1);
  await page.evaluate(() => window.finishRestart());
  await expect(page.locator('#open-project-button')).toBeEnabled();
});

test('unsupported platforms retain manual Hub refresh instructions', async ({ page }) => {
  await setup(page, { platform: 'macos' });
  await page.locator('#create-button').click();
  await expect(page.locator('#restart-hub-button')).toBeHidden();
  await expect(page.locator('#hub-result')).toContainText('Fully quit Hub, then choose Open Unity Hub.');
});

test('existing inspection is separate from approval and invalidates on path changes', async ({ page }) => {
  await inspectExisting(page);
  await expect(page.locator('#repair-button')).toBeDisabled();
  await page.locator('#repair-button').dispatchEvent('click');
  expect(await page.evaluate(() => window.calls.some(call => call.command === 'run_existing_project'))).toBe(false);
  await page.locator('#existing-approval').check();
  await expect(page.locator('#repair-button')).toBeEnabled();
  await page.locator('#existing-path').fill('F:\\UnityTest\\Different project');
  await expect(page.locator('#inspection-results')).toBeHidden();
  await expect(page.locator('#existing-approval')).not.toBeChecked();
  await page.locator('#repair-button').dispatchEvent('click');
  expect(await page.evaluate(() => window.calls.some(call => call.command === 'run_existing_project'))).toBe(false);
});

test('approved repair sends exact reviewed path and fingerprint, locks controls and retains report', async ({ page }) => {
  await inspectExisting(page, { pendingRepair: true });
  await page.locator('#existing-approval').check();
  await page.locator('#repair-button').click();
  await expect(page.locator('#new-mode')).toBeDisabled();
  await expect(page.locator('#existing-path')).toBeDisabled();
  await page.locator('#repair-button').dispatchEvent('click');
  await page.evaluate(() => window.eventCallbacks['existing-progress']({ payload: { step: 4, detail: 'Generating Creator node database.' } }));
  await expect(page.locator('#existing-detail')).toHaveText('Generating Creator node database.');
  await page.evaluate(() => window.finishRepair());
  await expect(page.locator('#existing-result')).toContainText('Validation passed');
  await expect(page.locator('#existing-result')).toContainText('Backup:');
  await page.locator('#open-existing-button').click();
  const calls = await page.evaluate(() => window.calls);
  expect(calls.filter(call => call.command === 'run_existing_project')).toEqual([{ command: 'run_existing_project', args: { request: { projectPath: 'F:\\UnityTest\\Existing project', fingerprint: 'reviewed-files-sha256', repair: true, approved: true } } }]);
  expect(calls.find(call => call.command === 'open_project').args.path).toBe('F:\\UnityTest\\Existing project');
  expect(await page.evaluate(() => Object.keys(window.eventCallbacks))).not.toContain('existing-progress');
  await expect(page.locator('#repair-button')).toBeDisabled();
});

test('validation failure retains backup information and does not offer a successful Open', async ({ page }) => {
  await inspectExisting(page, { failRepair: true });
  await page.locator('#existing-approval').check();
  await page.locator('#validate-button').click();
  await expect(page.locator('#existing-result')).toContainText('Compilation failed');
  await expect(page.locator('#existing-result')).toContainText('Backup:');
  await expect(page.locator('#open-existing-button')).toBeHidden();
  const call = await page.evaluate(() => window.calls.find(call => call.command === 'run_existing_project'));
  expect(call.args.request.repair).toBe(false);
});

test('blocked projects cannot start either operation', async ({ page }) => {
  await inspectExisting(page, { blocked: true });
  await expect(page.locator('#repair-button')).toBeHidden();
  await expect(page.locator('#validate-button')).toBeHidden();
  await expect(page.locator('#existing-approval-label')).toBeHidden();
  await expect(page.locator('#inspection-findings')).toContainText('Blocked');
});

for (const width of [980, 720]) {
  test(`existing repair review layout at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 760 });
    await inspectExisting(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('repair-review.png'), fullPage: true });
    expect(await page.locator('.suite-trigger img').evaluate(img => img.naturalWidth > 0)).toBe(true);
  });
}

test('completion cannot recreate the project, including after a refresh', async ({ page }) => {
  await setup(page);
  await page.locator('#create-button').click();
  await expect(page.locator('#open-project-button')).toBeVisible();
  await expect(page.locator('#create-button')).toBeHidden();
  await expect(page.locator('#project-name')).toBeDisabled();
  await page.locator('#refresh-button').click();
  await expect(page.locator('#overall-status')).toHaveText('Project ready');
  await page.locator('#create-button').dispatchEvent('click');
  await page.locator('#open-project-button').click();
  const calls = await page.evaluate(() => window.calls);
  expect(calls.filter(call => call.command === 'create_project')).toHaveLength(1);
  expect(calls.find(call => call.command === 'open_project').args.path).toBe('F:\\UnityTest\\My Creator Space');
});

test('pending creation rejects duplicate and refresh events', async ({ page }) => {
  await setup(page, { pending: true });
  await page.locator('#create-button').click();
  await expect(page.locator('#browse-button')).toBeDisabled();
  await expect(page.locator('#refresh-button')).toBeDisabled();
  await page.locator('#refresh-button').dispatchEvent('click');
  await page.locator('#create-button').dispatchEvent('click');
  expect(await page.evaluate(() => window.calls.filter(call => call.command === 'create_project').length)).toBe(1);
  expect(await page.evaluate(() => window.calls.filter(call => call.command === 'probe_environment').length)).toBe(1);
  await page.evaluate(() => window.finishCreate());
  await expect(page.locator('#open-project-button')).toBeVisible();
});

test('real progress stages render and unsubscribe on completion', async ({ page }, testInfo) => {
  await setup(page, { pending: true });
  await page.locator('#create-button').click();
  await page.evaluate(() => window.progressCallback({ payload: { step: 4, detail: 'Generating Creator SDK nodes.' } }));
  await expect(page.locator('#activity-title')).toHaveText('Configure Visual Scripting');
  await expect(page.locator('.progress-steps .done')).toHaveCount(3);
  await expect(page.locator('#activity-message')).toHaveText('Generating Creator SDK nodes.');
  await page.screenshot({ path: testInfo.outputPath('progress.png'), fullPage: true });
  await page.evaluate(() => window.finishCreate());
  await expect(page.locator('#open-project-button')).toBeVisible();
  expect(await page.evaluate(() => window.progressCallback)).toBe(null);
});

test('opening failure preserves success and supports retry', async ({ page }) => {
  await setup(page, { failOpen: true });
  await page.locator('#create-button').click();
  await page.locator('#open-project-button').click();
  await expect(page.getByRole('alert')).toContainText('could not be opened');
  await expect(page.locator('#result')).toHaveClass('result success');
  await expect(page.locator('#create-button')).toBeHidden();
  await page.evaluate(() => window.options.failOpen = false);
  await page.locator('#open-project-button').click();
  await expect(page.getByRole('alert')).toBeHidden();
});

test('creation failure allows retry without claiming a completed project', async ({ page }) => {
  await setup(page, { failCreate: true });
  await page.locator('#create-button').click();
  await expect(page.locator('#result')).toContainText('No files were changed');
  await expect(page.locator('#create-button')).toBeEnabled();
  await expect(page.locator('#open-project-button')).toBeHidden();
  await expect(page.locator('#project-name')).toBeEnabled();
  await expect(page.locator('#project-details')).toBeVisible();
  await expect(page.locator('#project-name')).toHaveValue('My Creator Space');
  await expect(page.locator('#project-summary')).toBeHidden();
});

for (const width of [980, 560]) {
  test(`package download failure stays actionable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 760 });
    const createError = 'Unity could not download a required package: com.unity.timeline from download.packages.unity.com (ECONNRESET: connection reset). Check your connection and any proxy/firewall rules for this host. Unity exit code: 1. Review E:\\UnityTest\\Example\\.creator-project-setup\\unity-setup.log. The project was preserved. Setup is incomplete. For a fresh attempt, keep this folder and choose a different project name. Create does not resume or overwrite existing folders.';
    await setup(page, { createError });
    await page.locator('#create-button').click();
    await expect(page.locator('#result')).toContainText(createError);
    await expect(page.locator('#result')).not.toHaveClass(/success/);
    await expect(page.locator('#open-project-button')).toBeHidden();
    await expect(page.locator('#project-name')).toBeEnabled();
    await expect(page.locator('#activity')).toBeHidden();
    expect(await page.evaluate(() => window.calls.filter(call => call.command === 'create_project').length)).toBe(1);
    expect(await page.evaluate(() => window.calls.some(call => ['register_project', 'open_project'].includes(call.command)))).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#result').scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('package-download-failure.png'), fullPage: true });
  });
}

test('creating another project explicitly unlocks a new name', async ({ page }) => {
  await setup(page);
  await page.locator('#create-button').click();
  await page.locator('#create-another-button').click();
  await expect(page.locator('#project-name')).toBeEmpty();
  await expect(page.locator('#project-name')).toBeFocused();
  await expect(page.locator('#project-details')).toBeVisible();
  await expect(page.locator('#project-summary')).toBeHidden();
  await expect(page.locator('#result')).toBeHidden();
  await page.locator('#project-name').fill('Second project');
  await page.locator('#create-button').click();
  await page.locator('#open-project-button').click();
  expect(await page.evaluate(() => window.calls.find(call => call.command === 'open_project').args.path)).toBe('F:\\UnityTest\\Second project');
});

for (const width of [980, 720]) {
  test(`completed layout at ${width}px with long path`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 760 });
    await setup(page);
    await page.locator('#parent-folder').fill('F:\\' + 'LongFolderName'.repeat(18));
    await page.locator('#create-button').click();
    await expect(page.locator('#result')).toHaveClass('result success');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('completed.png'), fullPage: true });
  });
}

test('creation replaces fields with a summary, without changing the request', async ({ page }) => {
  await setup(page, { pending: true });
  await page.locator('#project-name').fill('Forest <test>');
  await page.locator('#create-button').click();
  await expect(page.locator('#project-details')).toBeHidden();
  await expect(page.locator('#summary-name')).toHaveText('Forest <test>');
  await expect(page.locator('#activity')).toBeVisible();
  await page.evaluate(() => window.progressCallback({ payload: { step: 4, detail: 'Compiling.' } }));
  await expect(page.locator('#stage-progress')).toHaveJSProperty('value', 3);
  await page.evaluate(() => window.progressCallback({ payload: { step: 2, detail: 'Old event.' } }));
  await expect(page.locator('#stage-progress')).toHaveJSProperty('value', 3);
  await page.evaluate(() => window.finishCreate());
  await expect(page.locator('#project-details')).toBeHidden();
  await expect(page.locator('#summary-path')).toHaveText('F:\\UnityTest\\Forest <test>');
  await expect(page.locator('#activity')).toBeHidden();
});

for (const width of [940, 720, 560, 390]) {
  test(`maximum-length project summary stays within its pane at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 760 });
    await setup(page, { pending: true });
    await page.locator('#project-name').fill('W'.repeat(64));
    await page.locator('#create-button').click();
    await expect(page.locator('#summary-name')).toHaveText('W'.repeat(64));
    const fits = await page.evaluate(() => {
      const pane = document.querySelector('.setup-pane').getBoundingClientRect();
      const heading = document.querySelector('#requirements-heading').getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('#summary-name'));
      return [...range.getClientRects()].every(rect => rect.left >= pane.left - 1 && rect.right <= pane.right + 1 &&
        !(rect.left < heading.right && rect.right > heading.left && rect.top < heading.bottom && rect.bottom > heading.top)) &&
        document.documentElement.scrollWidth <= innerWidth;
    });
    expect(fits).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('long-project-summary.png'), fullPage: true });
    await page.evaluate(() => window.finishCreate());
    await expect(page.locator('#open-project-button')).toBeEnabled();
  });
}

test('app switcher supports keyboard, outside dismissal and bounded links', async ({ page }) => {
  await setup(page);
  const trigger = page.locator('#suite-trigger');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-suite-link="hub"]')).toBeFocused();
  await expect(page.locator('[data-suite-link="hub"]')).toContainText('Releases');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.calls.at(-1))).toEqual({ command: 'open_official_url', args: { url: 'https://github.com/BOBWORKS-XR/CREATOR-HUB/releases' } });
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-suite-link="mcp"]')).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.calls.at(-1))).toEqual({ command: 'open_official_url', args: { url: 'https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases' } });
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(page.locator('#suite-menu')).toBeHidden();
  await trigger.click();
  await page.locator('#suite-dismiss').click({ position: { x: 600, y: 180 } });
  await expect(page.locator('#suite-menu')).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.keyboard.press('End');
  await expect(page.locator('#suite-plugins')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#suite-menu')).toBeHidden();
  expect(await page.evaluate(() => window.calls.every(call => ['probe_environment', 'open_official_url'].includes(call.command)))).toBe(true);
});

test('Plugins is in Setup and switching back preserves a running project workflow', async ({ page }) => {
  await setup(page, { pending: true, community: [require('./fixtures/community/start-location.json')] });
  await page.locator('#create-button').click();
  await page.locator('#suite-trigger').click(); await page.locator('#suite-plugins').click();
  await expect(page.locator('#plugins-title')).toBeFocused();
  await expect(page.locator('#view-plugins')).toContainText('Start Location');
  await expect(page.locator('#setup-workspace')).toBeHidden();
  await page.evaluate(() => window.progressCallback({ payload: { step: 3, detail: 'Compiling while browsing' } }));
  await page.locator('#suite-trigger').click(); await page.locator('#suite-current').click();
  await expect(page.locator('#activity-message')).toHaveText('Compiling while browsing');
  await expect(page.locator('#create-button')).toBeDisabled();
  await page.evaluate(() => window.finishCreate());
  await expect(page.locator('#open-project-button')).toBeEnabled();
  expect(await page.evaluate(() => window.calls.filter(c => c.command === 'create_project').length)).toBe(1);
});

test('external link failures are visible and do not claim installation', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => window.__TAURI__.core.invoke = async () => { throw 'Browser unavailable'; });
  await page.locator('#suite-trigger').click();
  await page.locator('[data-suite-link="hub"]').click();
  await expect(page.locator('#suite-error')).toContainText('Browser unavailable');
  await expect(page.locator('[data-suite-link="hub"]')).toContainText('Releases');
  await page.keyboard.press('Escape');
  await expect(page.locator('#suite-trigger')).toBeFocused();
});

test('standalone Setup exposes MCP tools and AI skills without Unity import for instructions', async ({ page }) => {
  const fixture = require('./fixtures/community/start-location.json');
  const community = ['mcp-tool', 'ai-skill'].map(category => ({ ...fixture, id: `test.${category}`, category, name: category, download: undefined, scope: 'instructions-only', reviewStatus: 'listed' }));
  await setup(page, { community });
  await page.locator('#suite-trigger').click(); await page.locator('#suite-plugins').click();
  await expect(page.locator('.community-count')).toHaveText('2 contributions');
  for (const [category, label] of [['mcp-tool', 'MCP tools'], ['ai-skill', 'AI skills']]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('.community-count')).toHaveText('1 contribution');
    await expect(page.locator('.community-item h3')).toHaveText(category);
    await expect(page.locator('.community-type')).toHaveText(label);
    await expect(page.getByRole('button', { name: 'Add to project' })).toHaveCount(0);
    await expect(page.locator('.community-review')).toHaveText('Instructions only');
  }
  expect(await page.evaluate(() => window.calls.some(c => /install_community|queue_community|download_community/.test(c.command)))).toBe(false);
});

for (const width of [980, 720, 560, 390]) {
  test(`compact shell at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 620 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await setup(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.suite-trigger img').evaluate(img => img.naturalWidth)).toBe(1024);
    if (width === 980) {
      expect((await page.locator('#create-button').boundingBox()).y).toBeLessThan(350);
      expect((await page.locator('footer').boundingBox()).y).toBeLessThan(620);
    }
    await page.screenshot({ path: testInfo.outputPath('setup.png'), fullPage: true });
    await page.locator('#suite-trigger').click();
    await expect(page.locator('#suite-menu')).toBeVisible();
    await expect(page.locator('#suite-shell')).toHaveCSS('width', '224px');
    await expect(page.locator('#suite-shell')).toHaveCSS('height', '352px');
    await expect(page.locator('.app-header .title-block')).toHaveCSS('opacity', '0');
    await expect(page.locator('.suite-brand')).toHaveCSS('opacity', '1');
    await expect(page.locator('.suite-brand')).toHaveCSS('visibility', 'visible');
    expect(await page.locator('.suite-brand').evaluate(el => el.getBoundingClientRect().x)).toBe(15);
    expect(await page.locator('#suite-shell').evaluate(el => el.scrollLeft)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('switcher.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('drawer morphs from the tab without moving page content', async ({ page }, testInfo) => {
  await setup(page);
  const bounds = await page.locator('#create-button').boundingBox();
  const closed = await page.locator('#suite-trigger').boundingBox();
  await page.locator('#suite-trigger').click();
  await expect(page.locator('#suite-shell')).toHaveCSS('width', '224px');
  await expect(page.locator('#suite-shell')).toHaveCSS('height', '352px');
  await expect(page.locator('.app-header .title-block')).toHaveCSS('opacity', '0');
  const expanded = await page.locator('#suite-trigger').boundingBox();
  expect(expanded.x - closed.x).toBe(169);
  expect(expanded.y).toBe(closed.y);
  expect(await page.locator('#create-button').boundingBox()).toEqual(bounds);
  expect(await page.locator('#suite-shell').evaluate(el => el.scrollTop)).toBe(0);
  await expect(page.locator('#suite-close')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('expanded-drawer.png'), fullPage: true });
  await page.locator('#suite-trigger').click();
  await expect(page.locator('#suite-menu')).toBeHidden();
  await expect(page.locator('#suite-menu')).toHaveJSProperty('inert', true);
  await expect(page.locator('#suite-shell')).toHaveCSS('width', '55px');
  await expect(page.locator('.app-header .title-block')).toHaveCSS('opacity', '1');
  await expect(page.locator('#suite-trigger')).toBeFocused();
});

test('drawer transitions reverse and reduced motion removes animation', async ({ page }) => {
  await setup(page);
  const properties = await page.evaluate(async () => {
    document.querySelector('#suite-trigger').click();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const shell = document.querySelector('#suite-shell');
    const transitions = shell.getAnimations().map(animation => animation.transitionProperty);
    document.querySelector('#suite-trigger').click();
    document.querySelector('#suite-trigger').click();
    document.querySelector('#suite-trigger').click();
    return transitions;
  });
  expect(properties).toContain('width');
  expect(properties).toContain('height');
  await expect(page.locator('#suite-shell')).toHaveCSS('width', '55px');
  await expect(page.locator('#suite-menu')).toHaveJSProperty('inert', true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#suite-trigger').click();
  await expect(page.locator('#suite-shell')).toHaveCSS('transition-duration', '0s');
  await expect(page.locator('#suite-shell')).toHaveCSS('width', '224px');
  await expect(page.locator('.app-header .title-block')).toHaveCSS('opacity', '0');
  await page.keyboard.press('Escape');
  await expect(page.locator('#suite-menu')).toBeHidden();
});

test('short drawer can scroll to its last entry without moving the logo', async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 240 });
  await setup(page);
  await page.locator('#suite-trigger').click();
  await expect(page.locator('#suite-shell')).toHaveCSS('height', '216px');
  await expect(page.locator('#suite-shell')).toHaveCSS('width', '224px');
  const before = await page.locator('#suite-trigger').boundingBox();
  await page.locator('#suite-menu').evaluate(el => el.scrollTop = el.scrollHeight);
  const last = await page.locator('.suite-item.unavailable').last().boundingBox();
  expect(last.y + last.height).toBeLessThanOrEqual(228);
  expect(await page.locator('#suite-trigger').boundingBox()).toEqual(before);
});

test('click-away cannot activate the create button behind the drawer', async ({ page }) => {
  await setup(page);
  const button = await page.locator('#create-button').boundingBox();
  await page.locator('#suite-trigger').click();
  await expect(page.locator('#suite-shell')).toHaveCSS('width', '224px');
  await page.mouse.click(button.x + button.width - 15, button.y + button.height / 2);
  await expect(page.locator('#suite-menu')).toBeHidden();
  expect(await page.evaluate(() => window.calls.some(call => call.command === 'create_project'))).toBe(false);
});
