const { test, expect } = require('@playwright/test');

const preferenceFields = { preview: 'preview', 'auto-download': 'autoDownload', 'restore-hosted-views': 'restoreHostedViews' };
const preferenceIds = { preview: 'preview-channel', 'auto-download': 'auto-download', 'restore-hosted-views': 'restore-hosted-views' };
const projectNames = page => page.locator('#project-list .project-info > strong');

async function load(page, options = {}) {
  const state = {
    calls: [], unexpected: [], errors: [], cancelAdd: false, failPreference: null,
    preferences: { preview: false, autoDownload: false, restoreHostedViews: true, ...options.preferences },
    hubUpdate: { currentVersion: '0.1.14', availableVersion: null, downloaded: false },
    projects: { projects: [
      { id: 'creator', name: 'Creator Forest', path: 'E:\\UnityTest\\Creator Forest', sdk: 'creator', sdkLabel: 'Creator SDK / Altspace', unityVersion: '6000.3.21f1', source: 'Unity Hub', added: false, modifiedAtMs: Date.UTC(2026, 8, 11) },
      { id: 'banter', name: 'Banter Playground', path: 'E:\\UnityTest\\Banter Playground', sdk: 'banter', sdkLabel: 'Banter SDK', unityVersion: '2022.3.39f1', source: 'Creator Works MCP', added: true, modifiedAtMs: Date.UTC(2026, 8, 10) },
    ], warnings: [] },
  };
  page.on('pageerror', error => state.errors.push(error.message));
  await page.exposeFunction('projectsHomeNativeMock', async (command, args) => {
    state.calls.push({ command, args });
    switch (command) {
      case 'get_launch_request': return options.noLaunchRequest ? null : { view: 'hub', revision: 0 };
      case 'pending_hosted_restore': return [];
      case 'feature_select': return null;
      case 'feature_status': return { integrated: true, features: ['setup', 'mcp'] };
      case 'feature_call':
        if (args.feature === 'setup' && args.command === 'probe_environment') return {
          platform: 'windows', ready: true, hubInstalled: true, hubVersion: '3.21.1', hubAutoRegistration: true,
          recipe: { editorVersion: '6000.3.21f1', creatorSdkVersion: '4.0.14', urpVersion: '17.3.0', inputSystemVersion: '1.20.0' },
          editors: [{ exactRecipe: true, androidPlayer: true, androidSdk: true, androidNdk: true, openJdk: true, windowsStandalone: true, urpTemplate: 'urp.tgz' }],
          blockers: [], suggestedProjectParent: '/projects',
        };
        break;
      case 'hub_preferences_status':
        if (options.failPreferencesRead) throw Error('Fixture preference read refused');
        return state.preferences;
      case 'set_hub_preference':
        if (!Object.hasOwn(preferenceFields, args.key) || typeof args.value !== 'boolean') break;
        if (state.failPreference === args.key) throw Error('Fixture preference write refused');
        state.preferences[preferenceFields[args.key]] = args.value;
        return null;
      case 'project_inventory': return state.projects;
      case 'add_project_folder':
        if (state.cancelAdd) return null;
        state.projects.projects.push({ ...state.projects.projects[0], id: 'added', name: 'Added Creator', path: 'E:\\UnityTest\\Added Creator', added: true });
        return state.projects;
      case 'app_inventory': return { supported: true, apps: ['mcp', 'setup'].map(app => ({
        app, builtIn: options.direct !== false, installed: true, trusted: true,
        installedVersion: '1.0.0', availableVersion: '1.0.1', updateAvailable: true,
      })) };
      case 'hub_update_status': return state.hubUpdate;
    }
    state.unexpected.push({ command, args });
    throw Error(`Unexpected fixture command: ${command}`);
  });
  await page.addInitScript(({ direct, nativePreferences, preferences }) => {
    localStorage.setItem('creator-usage-terms.hub', JSON.stringify({ policyVersion: '2026-09-28-v1', acceptedAt: '2026-09-28T00:00:00.000Z' }));
    if (direct) window.__CREATOR_HUB_FEATURE_PROTOCOL__ = 1;
    if (nativePreferences) window.__CREATOR_HUB_PREFERENCES_PROTOCOL__ = 1;
    for (const [key, field] of Object.entries({ preview: 'preview', 'auto-download': 'autoDownload', 'restore-hosted-views': 'restoreHostedViews' })) {
      if (localStorage.getItem(`creator-hub.${key}`) === null) {
        localStorage.setItem(`creator-hub.${key}`, String(nativePreferences ? !preferences[field] : preferences[field]));
      }
    }
    window.events = {};
    window.__TAURI__ = {
      core: { invoke: (command, args) => window.projectsHomeNativeMock(command, args) },
      event: { listen: async (name, handler) => { window.events[name] = handler; return () => { delete window.events[name]; }; } },
    };
  }, { direct: options.direct !== false, nativePreferences: options.nativePreferences === true, preferences: state.preferences });
  await page.goto('http://127.0.0.1:4188');
  await expect.poll(() => state.calls.filter(call => call.command === 'hub_update_status').length).toBe(2);
  await expect(page.locator('#check-updates')).toBeEnabled();
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
  return state;
}

async function selectSuiteView(page, view) {
  await page.locator('#suite-trigger').click();
  await page.locator(`#suite-menu [data-view="${view}"]`).click();
}

async function expectProjectsHome(page) {
  await expect(page.locator('#view-projects')).toBeVisible();
  await expect(page.locator('#projects-home-title')).toBeVisible();
  await expect(page.locator('#projects-home-title')).toHaveText('Projects');
  await expect(page.locator('#view-projects')).toHaveAttribute('aria-labelledby', 'projects-home-title');
  await expect(page.locator('#view-hub')).toBeHidden();
  await expect(page.locator('#unified-home-updater')).toBeVisible();
  await expect(page.locator('.app-row:visible, #hub-tab-apps:visible, #hub-tab-projects:visible')).toHaveCount(0);
  await expect(page.locator('#update-mcp:visible, #update-setup:visible, .suite-download:visible')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apps', exact: true })).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
}

test('direct mode defaults to Projects even without a launch request', async ({ page }) => {
  const state = await load(page, { noLaunchRequest: true });
  await expectProjectsHome(page);
  await expect(projectNames(page)).toHaveText(['Creator Forest', 'Banter Playground']);
  expect(state.calls.filter(call => call.command === 'project_inventory')).toEqual([{ command: 'project_inventory', args: {} }]);
  expect(state.calls.some(call => /^(install_|download_|open_unity_project|start_hosted_app|hosted_app_call)/.test(call.command))).toBe(false);
});

test('hub launch requests resolve to Projects on startup and after selecting Setup', async ({ page }) => {
  const state = await load(page);
  await expectProjectsHome(page);
  await selectSuiteView(page, 'setup');
  await expect(page.locator('#feature-setup [data-field="create"]')).toBeEnabled();
  await expect(page.locator('#unified-home-updater')).toBeHidden();
  await page.evaluate(() => window.events['hub-launch-view']({ payload: { view: 'hub', revision: 1 } }));
  await expectProjectsHome(page);
  await expect(page.locator('#feature-setup')).toBeHidden();
  await expect(page.locator('#page-title')).toBeFocused();
  expect(state.calls.filter(call => call.command === 'project_inventory')).toHaveLength(1);
  expect(state.calls.filter(call => call.command === 'feature_select').at(-1).args).toEqual({ feature: null });
  expect(state.unexpected).toEqual([]);
});

test('suite Home returns to Projects and preserves project filters and Setup draft', async ({ page }) => {
  const state = await load(page);
  await page.locator('#project-search').fill('Forest');
  await page.locator('#project-sdk').selectOption('creator');
  await page.locator('#project-sort').selectOption('name');
  await selectSuiteView(page, 'setup');
  const name = page.locator('#feature-setup [data-field="name"]');
  await expect(name).toBeEnabled();
  await name.fill('Retained draft');
  await selectSuiteView(page, 'hub');
  await expectProjectsHome(page);
  await expect(page.locator('#project-search')).toHaveValue('Forest');
  await expect(page.locator('#project-sdk')).toHaveValue('creator');
  await expect(page.locator('#project-sort')).toHaveValue('name');
  await expect(projectNames(page)).toHaveText(['Creator Forest']);
  await expect(page.locator('#suite-menu')).toBeHidden();
  await expect(page.locator('#page-title')).toBeFocused();
  await page.locator('#suite-trigger').click();
  await expect(page.locator('#suite-menu [data-view="hub"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#suite-menu [data-view="hub"]')).toBeFocused();
  await page.locator('#suite-menu [data-view="setup"]').click();
  await expect(name).toHaveValue('Retained draft');
  expect(state.calls.filter(call => call.command === 'project_inventory')).toHaveLength(1);
  expect(state.calls.filter(call => call.command === 'feature_call').map(call => call.args.command)).toEqual(['probe_environment']);
});

for (const width of [1280, 940, 390, 320]) test(`direct home has one updater above project controls and list at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: width === 940 ? 580 : 780 });
  await load(page);
  await expectProjectsHome(page);
  await expect(page.locator('.hub-update')).toHaveCount(1);
  await expect(page.locator('#unified-home-updater .hub-update')).toHaveCount(1);
  for (const id of ['check-updates', 'hub-update-button']) {
    await expect(page.locator(`#${id}`)).toHaveCount(1);
    await expect(page.locator(`#unified-home-updater #${id}`)).toBeVisible();
  }
  await expect(page.locator('#hub-update-status')).toContainText('Hub 0.1.14');
  await expect(page.locator('#update-settings')).not.toHaveAttribute('open', '');
  const updater = await page.locator('#unified-home-updater').boundingBox();
  for (const selector of ['#hub-pages', '.project-filters', '#project-list']) {
    const box = await page.locator(selector).boundingBox();
    expect(updater.y + updater.height).toBeLessThanOrEqual(box.y);
    expect(await page.locator('#unified-home-updater').evaluate((element, selector) =>
      Boolean(element.compareDocumentPosition(document.querySelector(selector)) & Node.DOCUMENT_POSITION_FOLLOWING), selector)).toBe(true);
  }
  const checkLayout = async () => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const boxes = await page.locator('#unified-home-updater :is(button, summary, label):visible, #hub-pages :is(h2, button):visible, .project-filters > *').evaluateAll(elements =>
      elements.map(element => ({ label: element.id || element.textContent.trim(), ...element.getBoundingClientRect().toJSON() })));
    for (const box of boxes) {
      expect(box.left, box.label).toBeGreaterThanOrEqual(0);
      expect(box.right, box.label).toBeLessThanOrEqual(width);
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, `${a.label} overlaps ${b.label}`).toBe(true);
    }
  };
  await checkLayout();
  await page.screenshot({ path: testInfo.outputPath('projects-home.png'), fullPage: true });
  await page.locator('#update-settings > summary').click();
  for (const id of Object.values(preferenceIds)) await expect(page.locator(`#update-settings #${id}`)).toBeVisible();
  await checkLayout();
  await page.screenshot({ path: testInfo.outputPath('projects-home-settings.png'), fullPage: true });
  await page.locator('#suite-trigger').click();
  await expect(page.locator('.suite-download:visible')).toHaveCount(0);
  await expect(page.locator('#suite-menu [data-view="setup"]')).toBeVisible();
  await expect(page.locator('#suite-menu [data-view="mcp"]')).toBeVisible();
});

for (const nativePreferences of [false, true]) test(`moved update settings preserve ${nativePreferences ? 'native' : 'browser'} preferences across reloads`, async ({ page }) => {
  const state = await load(page, { nativePreferences });
  for (const [key, field] of Object.entries(preferenceFields)) {
    const control = page.locator(`#update-settings #${preferenceIds[key]}`);
    await expect(control).toHaveCount(1);
    await expect(control).toBeChecked({ checked: state.preferences[field] });
    await expect(control).toBeHidden();
  }
  expect(state.calls.filter(call => call.command === 'set_hub_preference')).toEqual([]);
  await page.locator('#update-settings > summary').click();
  await page.locator('#preview-channel').check();
  await expect(page.locator('#check-updates')).toBeEnabled();
  await page.locator('#auto-download').check();
  await expect(page.locator('#auto-download')).toBeEnabled();
  await page.locator('#restore-hosted-views').uncheck();
  await expect(page.locator('#restore-hosted-views')).toBeEnabled();
  if (nativePreferences) {
    expect(state.preferences).toEqual({ preview: true, autoDownload: true, restoreHostedViews: false });
    expect(state.calls.filter(call => call.command === 'set_hub_preference').map(call => call.args)).toEqual([
      { key: 'preview', value: true }, { key: 'auto-download', value: true }, { key: 'restore-hosted-views', value: false },
    ]);
  } else {
    expect(await page.evaluate(() => ['preview', 'auto-download', 'restore-hosted-views'].map(key => localStorage.getItem(`creator-hub.${key}`)))).toEqual(['true', 'true', 'false']);
  }
  await page.reload();
  await expect(page.locator('#check-updates')).toBeEnabled();
  await expectProjectsHome(page);
  await expect(page.locator('#preview-channel')).toBeChecked();
  await expect(page.locator('#auto-download')).toBeChecked();
  await expect(page.locator('#restore-hosted-views')).not.toBeChecked();
  await expect(page.locator('#update-settings')).not.toHaveAttribute('open', '');
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('preference failures stay visible outside collapsed update settings and preserve saved data', async ({ page }) => {
  const state = await load(page, { nativePreferences: true });
  await page.locator('#update-settings > summary').click();
  state.failPreference = 'auto-download';
  await page.locator('#auto-download').click();
  await expect(page.locator('#preferences-status')).toContainText('could not be saved');
  await expect(page.locator('#auto-download')).not.toBeChecked();
  await page.locator('#update-settings > summary').click();
  await expect(page.locator('#preferences-status')).toBeVisible();
  await expect(page.locator('#unified-home-updater > #preferences-status')).toHaveCount(1);
  await expect(page.locator('#update-settings #preferences-status')).toHaveCount(0);
  expect(state.preferences).toEqual({ preview: false, autoDownload: false, restoreHostedViews: true });
  expect(state.unexpected).toEqual([]);
});

test('failed native preference reads remain actionable without expanding settings', async ({ page }) => {
  const state = await load(page, { nativePreferences: true, failPreferencesRead: true });
  await expectProjectsHome(page);
  await expect(page.locator('#preferences-status')).toBeVisible();
  await expect(page.locator('#preferences-status')).toContainText('Automatic downloads are off');
  await expect(page.locator('#update-settings')).not.toHaveAttribute('open', '');
  expect(state.calls.some(call => call.command === 'set_hub_preference')).toBe(false);
});

for (const autoDownload of [false, true]) test(`direct update checks never query or download module releases with automatic downloads ${autoDownload ? 'on' : 'off'}`, async ({ page }) => {
  const state = await load(page, { preferences: { autoDownload } });
  const before = state.calls.length;
  await page.locator('#check-updates').click();
  await expect(page.locator('#check-updates')).toBeEnabled();
  expect(state.calls.slice(before)).toEqual([
    { command: 'app_inventory', args: { check: false, preview: false } },
    { command: 'hub_update_status', args: { online: true, preview: false } },
  ]);
  expect(state.calls.filter(call => call.command === 'app_inventory').every(call => call.args.check === false)).toBe(true);
  expect(state.calls.some(call => /^(install_|download_)/.test(call.command))).toBe(false);
  await expectProjectsHome(page);
  expect(state.unexpected).toEqual([]);
});

test('Hub update availability is shown by the single home updater without installing', async ({ page }) => {
  const state = await load(page);
  state.hubUpdate.availableVersion = '0.1.15';
  await page.locator('#check-updates').click();
  await expect(page.locator('#hub-update-status')).toHaveText('Version 0.1.15 is available.');
  await expect(page.locator('#unified-home-updater #hub-update-button')).toBeEnabled();
  await expectProjectsHome(page);
  expect(state.calls.some(call => /^(install_|download_)/.test(call.command))).toBe(false);
});

test('project refresh, add, cancel and New project still work from direct home', async ({ page }) => {
  const state = await load(page);
  state.projects.projects[0].name = 'Refreshed Creator';
  await page.locator('#refresh-projects').click();
  await expect(projectNames(page)).toHaveText(['Refreshed Creator', 'Banter Playground']);
  expect(state.calls.filter(call => call.command === 'project_inventory')).toHaveLength(2);
  await page.locator('#add-project').click();
  await expect(page.locator('#project-status')).toContainText('3 known projects');
  await expect(projectNames(page)).toHaveText(['Added Creator', 'Refreshed Creator', 'Banter Playground']);
  state.cancelAdd = true;
  await page.locator('#add-project').click();
  await expect(page.locator('#project-status')).toHaveText('No project added.');
  await expect(projectNames(page)).toHaveCount(3);
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(page.locator('#feature-setup [data-field="create"]')).toBeEnabled();
  await expect(page.locator('#view-projects')).toBeHidden();
  await expect(page.locator('#unified-home-updater')).toBeHidden();
  await selectSuiteView(page, 'hub');
  await expectProjectsHome(page);
  await expect(projectNames(page)).toHaveCount(3);
  expect(state.calls.filter(call => call.command === 'add_project_folder')).toEqual([
    { command: 'add_project_folder', args: {} }, { command: 'add_project_folder', args: {} },
  ]);
  expect(state.calls.filter(call => call.command === 'project_inventory')).toHaveLength(2);
  expect(state.calls.filter(call => call.command === 'feature_call').map(call => call.args.command)).toEqual(['probe_environment']);
  expect(state.unexpected).toEqual([]);
  expect(state.errors).toEqual([]);
});

test('legacy mode retains Apps-first home, both tabs and project navigation', async ({ page }) => {
  const state = await load(page, { direct: false });
  await expect(page.locator('#view-hub')).toBeVisible();
  await expect(page.locator('#view-projects')).toBeHidden();
  await expect(page.locator('#projects-home-title')).toBeHidden();
  await expect(page.locator('#unified-home-updater')).toBeHidden();
  await expect(page.locator('#hub-tab-apps')).toBeVisible();
  await expect(page.locator('#hub-tab-projects')).toBeVisible();
  await expect(page.locator('.app-row:visible')).toHaveCount(4);
  await expect(page.locator('#view-hub .hub-update')).toHaveCount(1);
  await expect(page.locator('#view-hub .update-preferences')).toBeVisible();
  await expect(page.locator('#hub-pages #check-updates')).toBeVisible();
  expect(state.calls.filter(call => call.command === 'project_inventory')).toHaveLength(0);
  await page.locator('#hub-tab-projects').click();
  await expect(page.locator('#view-projects')).toBeVisible();
  await expect(projectNames(page)).toHaveCount(2);
  await selectSuiteView(page, 'hub');
  await expect(page.locator('#view-hub')).toBeVisible();
  await expect(page.locator('#view-projects')).toBeHidden();
  await expect(page.locator('#hub-tab-apps')).toHaveAttribute('aria-current', 'page');
  expect(state.calls.filter(call => call.command === 'app_inventory').map(call => call.args.check)).toEqual([false, true]);
  expect(state.unexpected).toEqual([]);
});
