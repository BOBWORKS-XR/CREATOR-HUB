const { test, expect } = require('@playwright/test');
const { helpOcclusion } = require('./help-layout.cjs');

// Controller cases isolate feature calls; shell cases also run actual app.js routing.
async function open(page, options = {}) {
  if (!options.shell) await page.route('**/app.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.addInitScript(options => {
    localStorage.setItem('creator-usage-terms.hub', JSON.stringify({ policyVersion: '2026-09-28-v1', acceptedAt: '2026-09-28T00:00:00Z' }));
    window.__CREATOR_HUB_FEATURE_PROTOCOL__ = 1;
    window.__actualShellTest = options.shell === true;
    window.calls = []; window.events = {}; window.pending = {};
    window.failNext = options.fail || null;
    const recipe = { editorVersion: '6000.3.21f1', creatorSdkVersion: '4.0.14', urpVersion: '17.3.0', inputSystemVersion: '1.20.0' };
    const channel = { id: 'one', name: 'Creator project', unity_project_path: '/projects/Creator', enabled: true };
    const profile = { profile: 'creator', label: 'Creator SDK 4.0.14', packages: [] };
    const config = { channels: options.channels || [channel], active_channel_id: options.activeChannel || 'one', mcp_server_path: '/private/server.mjs',
      tool_groups: 'core', auto_start: true, enable_custom_scripts: false, allow_all_tests: true,
      connection_guide_version: options.guide ? 0 : 1, unrelatedSetting: 'preserve' };
    window.savedConfig = config;
    window.pendingRestore = options.restore ? [options.restore] : [];
    window.productStatus = options.productStatus || 'current';
    window.productRecovery = options.productRecovery || options.productRecoveryCompleted ? [{ journal: '/retained/recovery', historical_completed: options.productRecoveryCompleted === true, completed: options.productRecoveryCompleted === true, files: [] }] : [];
    const productReport = () => ({ status: window.productStatus, currentPath: '/settings/current.json', legacyPath: '/settings/legacy.json',
      evidencePath: '/retained/evidence.json', backups: options.productStatus ? ['/retained/exact-backup'] : [], recovery: structuredClone(window.productRecovery) });
    window.feedbackDocuments = structuredClone(options.feedbackDocuments || {});
    const feedback = project => {
      const document = window.feedbackDocuments[project] || {};
      return { enabled: document.feedbackEnabled === true, usageCheckIns: document.feedbackEnabled === true && document.usageCheckInsEnabled === true,
        file: `${project}/.bantworks-mcp/feedback/MCP_FEEDBACK.md` };
    };
    const clients = ['codex', 'claude', 'claudeDesktop', 'antigravity', 'opencode'].map(id => ({ id,
      detected: ['codex', 'claudeDesktop'].includes(id), configured: true,
      supported: id !== 'claudeDesktop' || !options.linux }));
    window.emitFeature = (feature, name, payload) => window.events['feature-event']?.({ payload: { feature, name, payload } });
    window.__TAURI__ = {
      event: { listen: async (name, callback) => { window.events[name] = callback; return () => { delete window.events[name]; }; } },
      core: { invoke: async (command, args = {}) => {
        window.calls.push({ command, args: structuredClone(args) });
        if (command === 'open_resource') {
          if (Object.keys(args).length !== 1 || args.resource !== 'unity-cli-docs') throw new Error('Unexpected resource request');
          return null;
        }
        if (command === 'feature_select') return;
        if (command === 'app_inventory') return { supported: true, apps: ['mcp', 'setup'].map(app => ({ app, builtIn: true, installed: true, trusted: true, hostedCompatible: true, hostedPreview: 'writable', installedVersion: app === 'mcp' ? '2.7.7' : '0.3.7' })) };
        if (command === 'hub_update_status') return { currentVersion: '0.1.14', availableVersion: null, downloaded: false };
        if (command === 'get_launch_request') return { view: 'hub', revision: 0 };
        if (command === 'project_inventory') return { projects: [], warnings: [] };
        if (command === 'pending_hosted_restore') return [...window.pendingRestore];
        if (command === 'restore_hosted_app') return { direct: true, app: args.app };
        if (command === 'complete_hosted_restore') { window.pendingRestore = window.pendingRestore.filter(app => app !== args.app); return; }
        if (command === 'feature_status') return { integrated: options.integrated !== false, features: ['setup', 'mcp'], issue: options.integrated === false ? 'Native features not linked in this build.' : undefined };
        if (command !== 'feature_call') throw new Error('Unexpected outer command: ' + command);
        const { feature, command: name, args: fields } = args;
        if (!['setup', 'mcp'].includes(feature) || !fields || Array.isArray(fields)) throw new Error('Invalid feature request');
        if (window.failNext === name) { window.failNext = null; throw new Error('Fixture failure: ' + name); }
        if (window.hold === name) await new Promise(resolve => { window.pending[name] = resolve; });
        switch (name) {
          case 'probe_environment': return { platform: options.linux ? 'linux' : 'windows', ready: true, hubInstalled: true, hubVersion: '3.21.1', hubAutoRegistration: true,
            recipe, editors: [{ exactRecipe: true, androidPlayer: true, androidSdk: true, androidNdk: true, openJdk: true, windowsStandalone: true, urpTemplate: 'urp.tgz' }], blockers: [], suggestedProjectParent: '/projects' };
          case 'pick_parent_folder': return '/projects/chosen';
          case 'open_official_url':
            if (feature !== 'setup' || Object.keys(fields).join() !== 'url' || ![
              'https://unity.com/legal/editor-terms-of-service/software',
              'https://developer.android.com/studio/terms',
              'https://openjdk.org/legal/gplv2+ce.html',
            ].includes(fields.url)) throw new Error('Unexpected Setup licence URL request');
            return null;
          case 'create_project': return { success: true, projectPath: '/projects/Space', message: 'Validated project', hub: { registered: true, refreshPending: true, message: 'Registered in Unity Hub' } };
          case 'inspect_project': return { projectPath: fields.path, fingerprint: 'reviewed-fingerprint', canRepair: true, canValidate: true,
            findings: [{ title: 'Visual Scripting', detail: options.hostile ? '<img src=x onerror=alert(1)>' : 'Initialization needs repair', status: 'repair' }], proposedChanges: ['Initialize node database'] };
          case 'run_existing_project': return { success: true, projectPath: fields.request.projectPath, message: 'Validation passed', backupPath: '/backups/settings', reportPath: '/reports/validation.json' };
          case 'open_project': case 'launch_hub': case 'register_project': return { registered: true, message: 'Registered' };
          case 'restart_hub': return true;
          case 'begin_ui_operation': return 17;
          case 'finish_ui_operation': return null;
          case 'product_settings_status': return productReport();
          case 'review_product_settings': {
            const pendingRecovery = window.productRecovery.some(item => !item.historical_completed);
            if (window.approveProduct === true) window.productRecovery = window.productRecovery.map(item => ({ ...item, historical_completed: true, completed: true }));
            window.lastProductReview = { ...productReport(), approved: window.approveProduct === true && (window.productStatus !== 'none' || pendingRecovery) };
            return structuredClone(window.lastProductReview);
          }
          case 'load_config': return structuredClone(config);
          case 'save_config': Object.assign(config, structuredClone(fields.config)); return null;
          case 'discover_unity_projects': return [{ name: 'Creator project', path: '/projects/Creator' }];
          case 'get_unity_extension_status': return options.bridgeStatuses?.[fields.unityProjectPath] || { installed: true, current: true };
          case 'get_project_sdk_profile': return options.sdkProfiles?.[fields.unityProjectPath] || profile;
          case 'get_onboarding_status': return { managedRouting: true, runtime: { ready: true, bundled: true },
            project: { valid: Boolean(fields.unityProjectPath?.trim()) && !options.invalidProject, bridgeInstalled: true, bridgeCurrent: true, stateStatus: 'fresh', sdkProfile: profile }, clients,
            unityCli: { available: true, canEnable: true, enabled: config.unity_cli_enabled === true, message: 'Unity CLI detected; optional and experimental.' } };
          case 'pick_project_folder': return '/projects/picked';
          case 'add_project': return { ...channel, id: 'new', scene_path: null, unity_project_path: options.canonicalPath || fields.projectPath };
          case 'one_click_setup': {
            const canonical = options.canonicalPath || fields.unityProjectPath;
            const selected = config.channels.find(item => item.unity_project_path === canonical)
              || { ...channel, id: 'setup', scene_path: null, unity_project_path: canonical };
            if (!config.channels.includes(selected)) config.channels.push(selected);
            config.active_channel_id = selected.id; config.auto_start = true;
            config.tool_groups = fields.toolGroups; config.enable_custom_scripts = fields.enableCustomScripts;
            if (fields.configureUnityCli !== null) {
              config.unity_cli_enabled = fields.configureUnityCli;
              if (fields.configureUnityCli) config.unity_cli_consent_version = fields.unityCliConsent;
            }
            if (options.setupFailureAfterSave) throw new Error('Fixture setup stopped after saving; earlier steps remain.');
            return { channel: structuredClone(selected), bridgeInstalled: true, codexConfigured: fields.configureCodex,
              claudeConfigured: fields.configureClaude, claudeDesktopConfigured: fields.configureClaudeDesktop,
              antigravityConfigured: fields.configureAntigravity, opencodeConfigured: fields.configureOpencode, runtimeCommand: '/private/node' };
          }
          case 'update_configured_unity_extensions': return { checked: 1 + (options.bridgeFailures?.length || 0), updated: 1, current: 0, failed: options.bridgeFailures || [] };
          case 'pending_client_recovery': return [];
          case 'get_project_feedback_settings':
            if (Object.keys(fields).join() !== 'unityProjectPath' || typeof fields.unityProjectPath !== 'string') throw new Error('Invalid feedback read DTO');
            return options.invalidFeedback ? { enabled: 'unknown' } : feedback(fields.unityProjectPath);
          case 'set_project_feedback_settings':
            if (Object.keys(fields).sort().join() !== 'enabled,unityProjectPath,usageCheckIns' || typeof fields.unityProjectPath !== 'string'
              || typeof fields.enabled !== 'boolean' || typeof fields.usageCheckIns !== 'boolean') throw new Error('Invalid feedback write DTO');
            window.feedbackDocuments[fields.unityProjectPath] = { ...window.feedbackDocuments[fields.unityProjectPath],
              feedbackEnabled: fields.enabled, usageCheckInsEnabled: fields.enabled && fields.usageCheckIns };
            if (options.feedbackFailureAfterSave) throw new Error('<img src=x onerror=alert(1)> Feedback save outcome unknown');
            return feedback(fields.unityProjectPath);
          case 'review_existing_client_connections': return { status: 'migrated', count: fields.clients.length };
          case 'recover_client_connection': return { completed: true };
          case 'update_codex_mcp_config': case 'update_claude_mcp_config': case 'update_claude_desktop_mcp_config':
          case 'update_antigravity_mcp_config': case 'update_opencode_mcp_config':
          case 'remove_codex_mcp_config': case 'remove_claude_mcp_config': case 'remove_claude_desktop_mcp_config':
          case 'remove_antigravity_mcp_config': case 'remove_opencode_mcp_config':
          case 'set_unity_custom_scripts': case 'set_unity_allow_all_tests': case 'install_unity_extension': return null;
          default: throw new Error('Unexpected feature command: ' + name);
        }
      } },
    };
  }, options);
  await page.goto('http://127.0.0.1:4188/');
  await page.evaluate(async () => {
    await window.CreatorUsageTerms.requireAcceptance();
    if (!window.__actualShellTest) for (const id of ['view-hub', 'view-projects', 'view-detail', 'view-builtin', 'hub-pages']) document.getElementById(id).classList.add('hidden');
  });
}
const field = (page, feature, name) => page.locator(`#feature-${feature} [data-field="${name}"]`);
const commands = (page, name) => page.evaluate(name => calls.filter(call => call.command === 'feature_call' && call.args.command === name), name);
const show = (page, feature, load = true) => page.evaluate(({ feature, load }) => CreatorFeaturePages.show(feature, { load }), { feature, load });
async function selectSuiteView(page, view) {
  await page.locator('#suite-trigger').click();
  await page.locator(`#suite-menu [data-view="${view}"]`).click();
}

for (const width of [1100, 390, 320]) test(`MCP saved projects show selected state and each bridge at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  const channels = ['Current', 'Old bridge', 'Missing bridge'].map((name, index) => ({
    id: index === 0 ? 'one' : String(index), name, unity_project_path: `/projects/${name}`, enabled: true,
  }));
  await open(page, { channels, bridgeStatuses: {
    '/projects/Current': { installed: true, current: true },
    '/projects/Old bridge': { installed: true, current: false },
    '/projects/Missing bridge': { installed: false, current: false },
  } });
  await show(page, 'mcp');
  await expect(field(page, 'mcp', 'controls')).toBeEnabled();
  const rows = field(page, 'mcp', 'projects').locator('.feature-project');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByRole('button', { name: 'Select Current for MCP', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(rows.nth(0)).toHaveAttribute('data-selected', 'true');
  await expect(field(page, 'mcp', 'discovered')).toHaveValue('/projects/Current');
  await expect(rows.nth(0)).toContainText('Selected for MCP');
  for (const [index, label] of ['Bridge current', 'Bridge update available', 'Bridge not installed'].entries()) {
    await expect(rows.nth(index)).toContainText(label);
    await expect(rows.nth(index)).toContainText('Creator SDK 4.0.14');
  }
  await rows.nth(1).getByRole('button', { name: 'Select Old bridge for MCP', exact: true }).click();
  await expect(rows.nth(1)).toHaveAttribute('data-selected', 'true');
  await expect(rows.nth(0)).toHaveAttribute('data-selected', 'false');
  await expect(field(page, 'mcp', 'project')).toHaveValue('/projects/Old bridge');
  await expect(field(page, 'mcp', 'discovered')).toHaveValue('/projects/Old bridge');
  const saved = await page.evaluate(() => window.savedConfig);
  expect(saved.channels).toEqual(channels);
  expect(saved.active_channel_id).toBe('1');
  expect(saved.unrelatedSetting).toBe('preserve');
  expect(saved.tool_groups).toBe('core');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const row of await rows.all()) {
    expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await field(page, 'mcp', 'projects').screenshot({ path: testInfo.outputPath('mcp-project-selection.png') });
});

test('a failed bridge check is not shown as a missing or current bridge and is not retried automatically', async ({ page }) => {
  await open(page, { fail: 'get_unity_extension_status' });
  await show(page, 'mcp');
  await expect(field(page, 'mcp', 'controls')).toBeEnabled();
  const row = field(page, 'mcp', 'projects').locator('.feature-project');
  await expect(row).toContainText('Bridge not checked');
  await expect(row).toContainText('Creator SDK 4.0.14');
  await expect(row).not.toContainText('Bridge current');
  await expect(row).not.toContainText('Bridge not installed');
  expect((await commands(page, 'get_unity_extension_status')).length).toBe(1);
});

test('actual Root navigation opens Setup and MCP as pages without hosted startup or frame authority', async ({ page }) => {
  await open(page, { shell: true });
  await expect(page.locator('#catalog-status')).toContainText('Update check complete');
  await selectSuiteView(page, 'setup');
  await expect(field(page, 'setup', 'create')).toBeEnabled();
  await selectSuiteView(page, 'mcp');
  await expect(field(page, 'mcp', 'setup')).toBeEnabled();
  expect(await page.locator('iframe').count()).toBe(0);
  expect(await page.evaluate(() => calls.filter(call => ['start_hosted_app', 'hosted_app_call', 'stop_hosted_app'].includes(call.command)))).toEqual([]);
  expect(await page.evaluate(() => calls.filter(call => call.command === 'feature_select').map(call => call.args.feature))).toEqual(expect.arrayContaining(['setup', 'mcp']));
});

test('actual Root maps old pending app restoration directly without permission/backend startup', async ({ page }) => {
  await open(page, { shell: true, restore: 'mcp' });
  await expect(field(page, 'mcp', 'setup')).toBeEnabled();
  expect(await page.evaluate(() => pendingRestore)).toEqual([]);
  expect(await page.evaluate(() => calls.filter(call => call.command === 'restore_hosted_app').map(call => call.args.app))).toEqual(['mcp']);
  expect(await page.evaluate(() => calls.filter(call => call.command === 'complete_hosted_restore').map(call => call.args.app))).toEqual(['mcp']);
  expect(await page.locator('iframe').count()).toBe(0);
  expect(await page.locator('#convergence-dialog')).not.toBeVisible();
  expect(await page.evaluate(() => calls.filter(call => ['start_hosted_app', 'hosted_app_call', 'stop_hosted_app'].includes(call.command)))).toEqual([]);
});

test('real direct pages mount with scoped IDs, original font and icons, no module globals or iframes', async ({ page }) => {
  await open(page); await show(page, 'setup'); await show(page, 'mcp');
  await expect(field(page, 'mcp', 'setup')).toBeEnabled();
  expect(await page.locator('iframe').count()).toBe(0);
  expect(await page.evaluate(() => window.CreatorRuntime)).toBeUndefined();
  expect(await page.evaluate(() => CreatorHubNative.integratedFeatures)).toBe(true);
  expect(await page.evaluate(() => { const ids = [...document.querySelectorAll('[id]')].map(el => el.id); return ids.filter((id, index) => ids.indexOf(id) !== index); })).toEqual([]);
  expect(await page.locator('#context-help-open').count()).toBe(1);
  expect(await page.locator('#usage-terms-dialog').count()).toBe(1);
  expect(await field(page, 'mcp', 'project').evaluate(el => getComputedStyle(el).fontFamily)).toBe(await page.locator('body').evaluate(el => getComputedStyle(el).fontFamily));
  expect(await field(page, 'mcp', 'check').locator('.icon').evaluate(el => getComputedStyle(el).getPropertyValue('--icon'))).toContain('refresh');
  expect(await page.evaluate(() => calls.some(call => ['start_hosted_app', 'hosted_app_call', 'install_app'].includes(call.command)))).toBe(false);
  await show(page, 'setup');
  for (const name of ['open', 'another', 'register', 'restart', 'open-existing']) await expect(field(page, 'setup', name)).toBeHidden();
});

test('load false does no API work; repeated true boot initializes once, failed boot retries only explicitly', async ({ page }) => {
  await open(page, { fail: 'probe_environment' });
  await show(page, 'setup', false);
  await expect(field(page, 'setup', 'create')).toBeDisabled();
  expect(await page.evaluate(() => calls.length)).toBe(0);
  await page.evaluate(() => Promise.all(Array.from({ length: 5 }, () => CreatorFeaturePages.show('setup', { load: true }))));
  await expect(field(page, 'setup', 'error')).toContainText('probe_environment');
  expect((await commands(page, 'probe_environment')).length).toBe(1);
  await field(page, 'setup', 'retry').click();
  await expect(field(page, 'setup', 'create')).toBeEnabled();
  expect((await commands(page, 'probe_environment')).length).toBe(2);
  await expect(field(page, 'setup', 'retry')).toBeHidden();
});

test('Root load permission survives default show, navigation and Retry until explicit load true', async ({ page }) => {
  await open(page); await show(page, 'setup', false);
  for (const feature of ['setup', 'mcp']) {
    await page.evaluate(feature => CreatorFeaturePages.show(feature), feature);
    await expect(field(page, feature, 'retry')).toBeHidden();
    await field(page, feature, 'retry').dispatchEvent('click');
    await page.evaluate(feature => CreatorFeaturePages.show(feature), feature);
    await expect(field(page, feature, 'controls')).toHaveAttribute('disabled', '');
    await expect(field(page, feature, feature === 'setup' ? 'create' : 'setup')).toBeDisabled();
    await expect(field(page, feature, 'status')).toHaveText('Waiting for Hub startup');
    expect(await page.evaluate(() => calls)).toEqual([]);
  }
  await page.evaluate(() => CreatorFeaturePages.show(null));
  await page.evaluate(() => CreatorFeaturePages.show('setup'));
  expect(await page.evaluate(() => calls)).toEqual([]);
  await show(page, 'setup', true);
  await expect(field(page, 'setup', 'create')).toBeEnabled();
  await page.evaluate(() => CreatorFeaturePages.show('mcp'));
  await expect(field(page, 'mcp', 'setup')).toBeEnabled();
  expect((await commands(page, 'probe_environment')).length).toBe(1);
  expect((await commands(page, 'load_config')).length).toBe(1);
});

test('failed startup Retry cannot bypass a later Root hold and remains explicit after unlock', async ({ page }) => {
  await open(page, { fail: 'probe_environment' });
  await page.evaluate(() => CreatorFeaturePages.show('setup'));
  await expect(field(page, 'setup', 'retry')).toBeVisible();
  await show(page, 'setup', false);
  await field(page, 'setup', 'retry').dispatchEvent('click');
  await page.evaluate(() => CreatorFeaturePages.show('setup'));
  expect((await commands(page, 'probe_environment')).length).toBe(1);
  await show(page, 'setup', true);
  await expect(field(page, 'setup', 'retry')).toBeVisible();
  expect((await commands(page, 'probe_environment')).length).toBe(1);
  await field(page, 'setup', 'retry').click();
  await expect(field(page, 'setup', 'create')).toBeEnabled();
  await expect(field(page, 'setup', 'retry')).toBeHidden();
  expect((await commands(page, 'probe_environment')).length).toBe(2);
});

test('unlinked native mode stays disabled, shows reason and never falls back to a hosted app', async ({ page }) => {
  await open(page, { integrated: false }); expect(await show(page, 'setup')).toBe(false);
  await expect(field(page, 'setup', 'error')).toContainText('not linked');
  await expect(field(page, 'setup', 'create')).toBeDisabled();
  await expect(field(page, 'setup', 'retry')).toBeVisible();
  expect((await commands(page, 'probe_environment')).length).toBe(0);
  expect(await page.locator('iframe').count()).toBe(0);
});

test('dispose cancels queued mount without late controller or native work', async ({ page }) => {
  await open(page);
  expect(await page.evaluate(async () => {
    const pending = CreatorFeaturePages.show('setup', { load: false });
    const disposed = CreatorFeaturePages.dispose(); await pending; return disposed;
  })).toBe(true);
  expect(await page.locator('#feature-setup').count()).toBe(0);
  expect(await page.evaluate(() => calls.length)).toBe(0);
  await show(page, 'setup'); await expect(field(page, 'setup', 'create')).toBeEnabled();
});

test('navigation retains both forms and does not reinitialize, help uses one shell dialog', async ({ page }) => {
  await open(page); await show(page, 'setup');
  await field(page, 'setup', 'name').fill('Keep this name'); await field(page, 'setup', 'parent').fill('/keep/me');
  await show(page, 'mcp'); await field(page, 'mcp', 'project').fill('/another/project');
  await page.locator('#context-help-open').click(); await expect(page.locator('#context-help-title')).toHaveText('Creator Works MCP help');
  await page.locator('#context-help-close').click();
  await show(page, 'setup'); await expect(field(page, 'setup', 'name')).toHaveValue('Keep this name');
  await expect(field(page, 'setup', 'parent')).toHaveValue('/keep/me');
  await show(page, 'mcp'); await expect(field(page, 'mcp', 'project')).toHaveValue('/another/project');
  expect((await commands(page, 'load_config')).length).toBe(1);
  expect((await commands(page, 'probe_environment')).length).toBe(1);
  await page.evaluate(() => CreatorFeaturePages.show(null)); await expect(page.locator('#view-native-features')).toBeHidden();
});

test('one Refresh call, no duplicate operation or automatic retry, error remains feature-scoped', async ({ page }) => {
  await open(page); await show(page, 'setup');
  await page.evaluate(() => { window.hold = 'probe_environment'; });
  await field(page, 'setup', 'refresh').click();
  await page.waitForFunction(() => pending.probe_environment);
  await field(page, 'setup', 'refresh').dispatchEvent('click');
  expect((await commands(page, 'probe_environment')).length).toBe(2);
  await expect(field(page, 'setup', 'create')).toBeDisabled();
  expect(await page.evaluate(() => CreatorFeaturePages.dispose())).toBe(false);
  await page.evaluate(() => { window.hold = null; pending.probe_environment(); });
  await expect(field(page, 'setup', 'create')).toBeEnabled();
  await page.evaluate(() => { window.failNext = 'probe_environment'; }); await field(page, 'setup', 'refresh').click();
  await expect(field(page, 'setup', 'error')).toContainText('Fixture failure');
  await expect(field(page, 'setup', 'retry')).toBeHidden();
  await expect(field(page, 'setup', 'refresh')).toBeEnabled();
  await show(page, 'mcp'); await expect(field(page, 'mcp', 'error')).toBeHidden();
  expect((await commands(page, 'probe_environment')).length).toBe(3);
});

test('Setup creates once with exact DTO, consumes only scoped progress and completes while hidden', async ({ page }) => {
  await open(page); await show(page, 'mcp'); await show(page, 'setup');
  await field(page, 'setup', 'name').fill('Space');
  await page.evaluate(() => { window.hold = 'create_project'; }); await field(page, 'setup', 'create').click();
  await page.waitForFunction(() => pending.create_project);
  await field(page, 'setup', 'create').dispatchEvent('click');
  expect((await commands(page, 'create_project')).length).toBe(1);
  expect((await commands(page, 'create_project'))[0].args.args).toEqual({ request: { projectName: 'Space', parentDirectory: '/projects' } });
  await page.evaluate(() => {
    emitFeature('mcp', 'setup-progress', { step: 2, detail: 'Foreign progress' });
    emitFeature('setup', 'setup-progress', { step: 3, detail: '<img src=x onerror=alert(1)>' });
  });
  await expect(field(page, 'setup', 'detail')).toHaveText('<img src=x onerror=alert(1)>');
  expect(await field(page, 'setup', 'detail').locator('img').count()).toBe(0);
  await show(page, 'mcp'); await page.evaluate(() => emitFeature('setup', 'requirements-progress', { stage: 'Download', detail: 'Download in progress', percent: 35, transfer: { downloadedBytes: 350, totalBytes: 1000, bytesPerSecond: 25 } }));
  await expect(field(page, 'mcp', 'status')).toHaveText('Ready');
  await page.evaluate(() => { window.hold = null; pending.create_project(); }); await show(page, 'setup');
  await expect(field(page, 'setup', 'created')).toContainText('Validated project');
  await expect(field(page, 'setup', 'open')).toBeVisible();
  await expect(field(page, 'setup', 'restart')).toBeVisible();
});

test('Setup licence buttons use only exact pinned service URLs and preserve form/settings state', async ({ page }) => {
  await open(page); await show(page, 'setup');
  await field(page, 'setup', 'name').fill('Retain project name'); await field(page, 'setup', 'parent').fill('/keep/folder');
  const licences = [
    ['unity', 'https://unity.com/legal/editor-terms-of-service/software'],
    ['android', 'https://developer.android.com/studio/terms'],
    ['openjdk', 'https://openjdk.org/legal/gplv2+ce.html'],
  ];
  for (const [key] of licences) {
    await field(page, 'setup', `licence-${key}`).evaluate(button => { button.dataset.url = 'https://untrusted.invalid/'; });
    await field(page, 'setup', `licence-${key}`).click();
    await expect(page.locator('#feature-setup')).toHaveAttribute('aria-busy', 'false');
  }
  expect((await commands(page, 'open_official_url')).map(call => call.args)).toEqual(licences.map(([, url]) => ({ feature: 'setup', command: 'open_official_url', args: { url } })));
  expect(await page.evaluate(() => calls.filter(call => ['open_resource', 'plugin:shell|open', 'hosted_app_call', 'start_hosted_app'].includes(call.command)))).toEqual([]);
  expect(await commands(page, 'create_project')).toEqual([]);
  expect(await commands(page, 'save_config')).toEqual([]);
  await expect(field(page, 'setup', 'name')).toHaveValue('Retain project name');
  await expect(field(page, 'setup', 'parent')).toHaveValue('/keep/folder');
  await expect(field(page, 'setup', 'error')).toBeHidden();
});

test('Setup licence opener failure is visible and retries only when clicked again', async ({ page }) => {
  await open(page, { fail: 'open_official_url' }); await show(page, 'setup');
  await field(page, 'setup', 'licence-android').click();
  await expect(field(page, 'setup', 'error')).toContainText('open_official_url');
  await expect(field(page, 'setup', 'create')).toBeEnabled();
  expect((await commands(page, 'open_official_url')).length).toBe(1);
  await show(page, 'mcp'); await show(page, 'setup');
  expect((await commands(page, 'open_official_url')).length).toBe(1);
  await field(page, 'setup', 'licence-android').click();
  await expect(field(page, 'setup', 'error')).toBeHidden();
  expect((await commands(page, 'open_official_url')).map(call => call.args.args)).toEqual(Array(2).fill({ url: 'https://developer.android.com/studio/terms' }));
  expect(await commands(page, 'create_project')).toEqual([]);
});

test('Setup licence opening never bypasses startup gating or replays a second busy click', async ({ page }) => {
  await open(page); await show(page, 'setup', false);
  await expect(field(page, 'setup', 'licence-unity')).toBeDisabled();
  await field(page, 'setup', 'licence-unity').dispatchEvent('click');
  expect(await commands(page, 'open_official_url')).toEqual([]);
  await show(page, 'setup');
  await page.evaluate(() => { window.hold = 'open_official_url'; });
  await field(page, 'setup', 'licence-unity').click(); await page.waitForFunction(() => pending.open_official_url);
  await expect(field(page, 'setup', 'licence-openjdk')).toBeDisabled();
  await field(page, 'setup', 'licence-unity').dispatchEvent('click');
  await field(page, 'setup', 'licence-openjdk').dispatchEvent('click');
  expect((await commands(page, 'open_official_url')).length).toBe(1);
  await page.evaluate(() => { window.hold = null; pending.open_official_url(); });
  await expect(field(page, 'setup', 'licence-openjdk')).toBeEnabled();
  expect((await commands(page, 'open_official_url')).length).toBe(1);
});

test('inspection is read-only; repairs require approval and reuse exact reviewed fingerprint; changed path invalidates', async ({ page }) => {
  await open(page, { hostile: true }); await show(page, 'setup'); await field(page, 'setup', 'existing-tab').click();
  await field(page, 'setup', 'existing-path').fill('/projects/review'); await field(page, 'setup', 'inspect').click();
  await expect(field(page, 'setup', 'findings')).toContainText('<img src=x onerror=alert(1)>');
  expect(await field(page, 'setup', 'findings').locator('img').count()).toBe(0);
  await expect(field(page, 'setup', 'repair')).toBeDisabled();
  expect((await commands(page, 'run_existing_project')).length).toBe(0);
  await field(page, 'setup', 'approval').check(); await field(page, 'setup', 'repair').click();
  await expect(field(page, 'setup', 'existing-result')).toContainText('Backup: /backups/settings');
  expect((await commands(page, 'run_existing_project'))[0].args.args).toEqual({ request: { projectPath: '/projects/review', fingerprint: 'reviewed-fingerprint', repair: true, approved: true } });
  await field(page, 'setup', 'inspect').click(); await field(page, 'setup', 'approval').check();
  await field(page, 'setup', 'existing-path').fill('/different'); await expect(field(page, 'setup', 'repair')).toBeDisabled();
});

test('first-run guide has no connection writes; saving skip failure remains recoverable', async ({ page }) => {
  await open(page, { guide: true }); await show(page, 'mcp');
  await expect(field(page, 'mcp', 'guide-dialog')).toBeVisible();
  expect((await commands(page, 'one_click_setup')).length).toBe(0);
  expect((await commands(page, 'save_config')).length).toBe(0);
  await page.evaluate(() => { window.failNext = 'save_config'; }); await field(page, 'mcp', 'guide-skip').click();
  await expect(field(page, 'mcp', 'guide-dialog')).toBeVisible();
  await field(page, 'mcp', 'guide-skip').click(); await expect(field(page, 'mcp', 'guide-dialog')).toBeHidden();
  expect((await commands(page, 'save_config')).at(-1).args.args.config.connection_guide_version).toBe(1);
});

test('Unity CLI documentation uses only the fixed Hub resource key, not an MCP or shell opener', async ({ page }) => {
  await open(page, { shell: true });
  await expect(page.locator('#catalog-status')).toContainText('Update check complete');
  await selectSuiteView(page, 'mcp');
  await expect(field(page, 'mcp', 'setup')).toBeEnabled();
  await page.getByText('Optional Unity CLI', { exact: true }).click();
  await field(page, 'mcp', 'cli-docs').click();
  await expect(field(page, 'mcp', 'status')).toHaveText('Ready');
  expect(await page.evaluate(() => calls.filter(call => call.command === 'open_resource'))).toEqual([
    { command: 'open_resource', args: { resource: 'unity-cli-docs' } },
  ]);
  expect((await commands(page, 'open_official_url')).length).toBe(0);
  expect(await page.evaluate(() => calls.filter(call => /shell|opener/.test(call.command)))).toEqual([]);
  await expect(field(page, 'mcp', 'error')).toBeHidden();
});

test('optional CLI needs explicit agreement; reviewed setup uses exact client and consent DTO, balanced lease', async ({ page }) => {
  await open(page); await show(page, 'mcp');
  await field(page, 'mcp', 'cli').locator('xpath=ancestor::details').locator('summary').click();
  await expect(field(page, 'mcp', 'cli')).not.toBeChecked(); await field(page, 'mcp', 'cli').click();
  let modal = page.getByRole('dialog', { name: 'Experimental Unity CLI', exact: true });
  await expect(modal.getByRole('button', { name: 'Agree and enable' })).toBeDisabled();
  await modal.getByRole('button', { name: 'Cancel' }).click(); await expect(field(page, 'mcp', 'cli')).not.toBeChecked();
  await field(page, 'mcp', 'cli').click(); modal = page.getByRole('dialog', { name: 'Experimental Unity CLI', exact: true });
  await modal.getByRole('checkbox').check(); await modal.getByRole('button', { name: 'Agree and enable' }).click();
  await expect(field(page, 'mcp', 'cli')).toBeChecked();
  await field(page, 'mcp', 'setup').click();
  await page.getByRole('dialog', { name: 'Review connection setup' }).getByRole('button', { name: 'Cancel' }).click();
  expect((await commands(page, 'one_click_setup')).length).toBe(0);
  await field(page, 'mcp', 'setup').click(); await page.getByRole('dialog', { name: 'Review connection setup' }).getByRole('button', { name: 'Apply setup' }).click();
  await expect(field(page, 'mcp', 'setup-result')).toContainText('Settings saved');
  const request = (await commands(page, 'one_click_setup'))[0].args.args;
  expect(request).toEqual({ unityProjectPath: '/projects/Creator', configureCodex: true, configureClaude: true, configureClaudeDesktop: true, configureAntigravity: true, configureOpencode: true,
    toolGroups: 'core', enableCustomScripts: false, configureUnityCli: true, unityCliConsent: 'unity-cli-experimental-v1' });
  expect((await commands(page, 'begin_ui_operation')).length).toBe((await commands(page, 'finish_ui_operation')).length);
  expect(await page.evaluate(() => savedConfig.unrelatedSetting)).toBe('preserve');
});

test('explicit setup adopts the returned canonical channel path, enabling Apply after noncanonical input', async ({ page }) => {
  await open(page, { canonicalPath: '/projects/Canonical' }); await show(page, 'mcp');
  await field(page, 'mcp', 'project').fill('/projects/Canonical/.'); await field(page, 'mcp', 'check').click();
  await field(page, 'mcp', 'setup').click();
  await page.getByRole('dialog', { name: 'Review connection setup' }).getByRole('button', { name: 'Apply setup' }).click();
  await expect(field(page, 'mcp', 'setup-result')).toContainText('Settings saved');
  expect((await commands(page, 'one_click_setup'))[0].args.args.unityProjectPath).toBe('/projects/Canonical/.');
  await expect(field(page, 'mcp', 'project')).toHaveValue('/projects/Canonical');
  await page.getByRole('button', { name: 'Apply to Codex', exact: true }).click();
  expect((await commands(page, 'update_codex_mcp_config'))[0].args.args.channel.unity_project_path).toBe('/projects/Canonical');
  expect(await page.evaluate(() => savedConfig.unrelatedSetting)).toBe('preserve');
});

test('explicit Add project adopts the returned canonical path only after saving the selected channel', async ({ page }) => {
  await open(page, { canonicalPath: '/projects/Canonical' }); await show(page, 'mcp');
  await field(page, 'mcp', 'project').fill('/projects/Canonical/.'); await field(page, 'mcp', 'add').click();
  await expect(field(page, 'mcp', 'project')).toHaveValue('/projects/Canonical');
  await expect(page.getByRole('button', { name: 'Apply to Codex', exact: true })).toBeEnabled();
  expect((await commands(page, 'add_project'))[0].args.args).toEqual({ projectPath: '/projects/Canonical/.' });
  const saved = (await commands(page, 'save_config'))[0].args.args.config;
  expect(saved.channels.find(channel => channel.id === saved.active_channel_id).unity_project_path).toBe('/projects/Canonical');
  expect(saved.unrelatedSetting).toBe('preserve');
});

for (const partial of [false, true]) test(`failed explicit setup keeps the unconfirmed draft path, partial native save: ${partial}`, async ({ page }) => {
  await open(page, { canonicalPath: '/projects/Canonical', fail: partial ? undefined : 'one_click_setup', setupFailureAfterSave: partial });
  await show(page, 'mcp');
  await field(page, 'mcp', 'project').fill('/projects/Canonical/.'); await field(page, 'mcp', 'check').click();
  await field(page, 'mcp', 'setup').click();
  await page.getByRole('dialog', { name: 'Review connection setup' }).getByRole('button', { name: 'Apply setup' }).click();
  await expect(field(page, 'mcp', 'error')).toContainText(partial ? 'earlier steps remain' : 'one_click_setup');
  await expect(field(page, 'mcp', 'project')).toHaveValue('/projects/Canonical/.');
  expect((await commands(page, 'load_config')).length).toBe(1);
  expect((await commands(page, 'save_config')).length).toBe(0);
  expect((await commands(page, 'one_click_setup')).length).toBe(1);
  expect(await page.evaluate(() => savedConfig.channels.find(channel => channel.id === savedConfig.active_channel_id).unity_project_path))
    .toBe(partial ? '/projects/Canonical' : '/projects/Creator');
});

for (const failure of ['add_project', 'save_config']) test(`failed Add project keeps the draft when ${failure} refuses`, async ({ page }) => {
  await open(page, { canonicalPath: '/projects/Canonical', fail: failure }); await show(page, 'mcp');
  await field(page, 'mcp', 'project').fill('/projects/Canonical/.'); await field(page, 'mcp', 'add').click();
  await expect(field(page, 'mcp', 'error')).toContainText(failure);
  await expect(field(page, 'mcp', 'project')).toHaveValue('/projects/Canonical/.');
  expect(await page.evaluate(() => savedConfig.active_channel_id)).toBe('one');
  expect((await commands(page, 'load_config')).length).toBe(1);
  expect((await commands(page, 'add_project')).length).toBe(1);
});

test('a config reload unrelated to explicit project selection preserves the project draft', async ({ page }) => {
  await open(page); await show(page, 'mcp');
  await field(page, 'mcp', 'project').fill('/projects/Unsubmitted/.');
  await field(page, 'mcp', 'check').click();
  await page.getByText('Existing client connections and recovery', { exact: true }).click();
  await field(page, 'mcp', 'review').click();
  await expect(field(page, 'mcp', 'status')).toHaveText('Ready');
  await expect(field(page, 'mcp', 'project')).toHaveValue('/projects/Unsubmitted/.');
  expect((await commands(page, 'load_config')).length).toBe(2);
  expect((await commands(page, 'one_click_setup')).length).toBe(0);
  expect((await commands(page, 'add_project')).length).toBe(0);
  expect(await page.evaluate(() => savedConfig.active_channel_id)).toBe('one');
});

test('bridge update preserves counts and every failure reason as text, never HTML', async ({ page }) => {
  const failures = ['First project: <img src=x onerror="window.bridgeInjected=true">', 'Second project: </p><script>window.bridgeInjected=true</script>'];
  await open(page, { bridgeFailures: failures }); await show(page, 'mcp');
  await field(page, 'mcp', 'bridges').click();
  const result = field(page, 'mcp', 'setup-result');
  await expect(result).toContainText('Bridges updated: 1. Failed: 2.');
  for (const failure of failures) await expect(result).toContainText(failure);
  expect(await result.locator('p').allTextContents()).toEqual(['Bridges updated: 1. Failed: 2.', ...failures]);
  expect(await result.locator('img, script').count()).toBe(0);
  expect(await page.evaluate(() => window.bridgeInjected)).toBeUndefined();
  expect((await commands(page, 'update_configured_unity_extensions')).length).toBe(1);
  await expect(field(page, 'mcp', 'error')).toBeHidden();
});

test('Desktop is separate from Code and unsupported Linux Desktop cannot be selected or configured', async ({ page }) => {
  await open(page, { linux: true }); await show(page, 'mcp');
  await expect(page.locator('#feature-mcp [data-client="claudeDesktop"]')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Apply to Claude Desktop', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Apply to Claude Code', exact: true }).click();
  expect((await commands(page, 'update_claude_mcp_config')).length).toBe(1);
  expect((await commands(page, 'update_claude_desktop_mcp_config')).length).toBe(0);
});

test('MCP errors do not mutate Setup and an unreleased native workflow stays locked', async ({ page }) => {
  await open(page); await show(page, 'setup'); await show(page, 'mcp');
  await page.evaluate(() => { window.failNext = 'update_codex_mcp_config'; }); await page.getByRole('button', { name: 'Apply to Codex', exact: true }).click();
  await expect(field(page, 'mcp', 'error')).toContainText('update_codex_mcp_config');
  expect((await commands(page, 'update_codex_mcp_config')).length).toBe(1);
  await show(page, 'setup'); await expect(field(page, 'setup', 'error')).toBeHidden();
  await show(page, 'mcp'); await page.evaluate(() => { window.failNext = 'finish_ui_operation'; });
  await field(page, 'mcp', 'check').click(); await expect(field(page, 'mcp', 'error')).toContainText('Operation state is unknown');
  await expect(field(page, 'mcp', 'setup')).toBeDisabled();
});

test('first initialization waits for other feature completion, then Root-style rendering initializes once', async ({ page }) => {
  await open(page); await show(page, 'setup');
  await page.evaluate(() => { window.hold = 'create_project'; }); await field(page, 'setup', 'create').click();
  await page.waitForFunction(() => pending.create_project);
  await show(page, 'mcp');
  await expect(field(page, 'mcp', 'status')).toContainText('Waiting for the other feature');
  expect((await commands(page, 'load_config')).length).toBe(0);
  await page.evaluate(() => {
    window.addEventListener('creator-feature-state', () => { void CreatorFeaturePages.show('mcp'); });
    window.hold = null; pending.create_project();
  });
  await expect(field(page, 'mcp', 'setup')).toBeEnabled();
  expect((await commands(page, 'load_config')).length).toBe(1);
  expect((await commands(page, 'create_project')).length).toBe(1);
});

test('guide never acknowledges completion if releasing its workflow fails', async ({ page }) => {
  await open(page, { guide: true }); await show(page, 'mcp');
  await page.evaluate(() => { window.failNext = 'finish_ui_operation'; }); await field(page, 'mcp', 'guide-skip').click();
  await expect(field(page, 'mcp', 'guide-dialog')).toBeVisible();
  await expect(field(page, 'mcp', 'guide-error')).toContainText('Operation state is unknown');
  expect((await commands(page, 'save_config')).length).toBe(1);
  await field(page, 'mcp', 'guide-skip').click();
  expect((await commands(page, 'save_config')).length).toBe(1);
});

for (const settings of [{ productStatus: 'current' }, { productStatus: 'none' }, { productStatus: 'identical' }, { productRecoveryCompleted: true }]) test(`healthy saved settings stay out of the connection page: ${JSON.stringify(settings)}`, async ({ page }) => {
  await open(page, settings); await show(page, 'mcp');
  await expect(field(page, 'mcp', 'setup')).toBeEnabled();
  await expect(field(page, 'mcp', 'product-panel')).toBeHidden();
  await expect(field(page, 'mcp', 'retry')).toBeHidden();
  await page.getByText('Advanced settings', { exact: true }).click();
  await expect(field(page, 'mcp', 'product-review-advanced')).toBeEnabled();
  await field(page, 'mcp', 'product-review-advanced').click();
  await expect(field(page, 'mcp', 'setup')).toBeEnabled();
  await expect(field(page, 'mcp', 'product-panel')).toBeHidden();
  expect(await page.evaluate(() => lastProductReview.approved)).toBe(false);
  expect((await commands(page, 'load_config')).length).toBe(1);
  await show(page, 'setup'); await show(page, 'mcp');
  await expect(field(page, 'mcp', 'setup')).toBeEnabled();
  await page.evaluate(() => { window.approveProduct = true; }); await field(page, 'mcp', 'product-review-advanced').click();
  await expect(field(page, 'mcp', 'setup')).toBeEnabled();
  await expect(field(page, 'mcp', 'product-panel')).toBeHidden();
  expect(await page.evaluate(() => lastProductReview.approved)).toBe(settings.productStatus !== 'none');
  expect((await commands(page, 'load_config')).length).toBe(settings.productStatus === 'none' ? 1 : 2);
  expect((await commands(page, 'save_config')).length).toBe(0);
});

for (const issue of ['conflict', 'legacy-only', 'recovery']) test(`a cancelled review cannot preserve Ready after new native ${issue}`, async ({ page }) => {
  await open(page); await show(page, 'mcp');
  await page.getByText('Advanced settings', { exact: true }).click();
  await page.evaluate(issue => {
    if (issue === 'recovery') window.productRecovery = [{ journal: '/new/recovery', historical_completed: false, files: [] }];
    else window.productStatus = issue;
  }, issue);
  await field(page, 'mcp', 'product-review-advanced').click();
  await expect(field(page, 'mcp', 'setup')).toBeDisabled();
  await expect(field(page, 'mcp', 'product-panel')).toBeVisible();
  await expect(field(page, 'mcp', 'product-status')).toContainText('without explicit approval');
  expect((await commands(page, 'load_config')).length).toBe(1);
  expect((await commands(page, 'save_config')).length).toBe(0);
});

test('a healthy cancelled review never unlocks an uncertain workflow release', async ({ page }) => {
  await open(page, { productStatus: 'none' }); await show(page, 'mcp');
  await page.getByText('Advanced settings', { exact: true }).click();
  await page.evaluate(() => { window.failNext = 'finish_ui_operation'; });
  await field(page, 'mcp', 'product-review-advanced').click();
  await expect(field(page, 'mcp', 'error')).toContainText('Operation state is unknown');
  await expect(field(page, 'mcp', 'setup')).toBeDisabled();
  await expect(field(page, 'mcp', 'product-panel')).toBeVisible();
  expect((await commands(page, 'load_config')).length).toBe(1);
});

test('empty settings review cannot unlock an initially failed load', async ({ page }) => {
  await open(page, { productStatus: 'none', fail: 'load_config' }); await show(page, 'mcp');
  await expect(field(page, 'mcp', 'setup')).toBeDisabled();
  await page.evaluate(() => { window.approveProduct = true; });
  await field(page, 'mcp', 'product-review').click();
  expect(await page.evaluate(() => lastProductReview.approved)).toBe(false);
  await expect(field(page, 'mcp', 'setup')).toBeDisabled();
  expect((await commands(page, 'load_config')).length).toBe(1);
});

test('ordinary MCP errors keep the existing Check control without startup Retry or settings panel', async ({ page }) => {
  await open(page); await show(page, 'mcp');
  await page.evaluate(() => { window.failNext = 'get_onboarding_status'; }); await field(page, 'mcp', 'check').click();
  await expect(field(page, 'mcp', 'error')).toContainText('get_onboarding_status');
  await expect(field(page, 'mcp', 'check')).toBeEnabled();
  await expect(field(page, 'mcp', 'retry')).toBeHidden();
  await expect(field(page, 'mcp', 'product-panel')).toBeHidden();
  await field(page, 'mcp', 'check').click();
  await expect(field(page, 'mcp', 'error')).toBeHidden();
  expect((await commands(page, 'load_config')).length).toBe(1);
});

test('saved-settings status failures expose recovery actions outside the disabled main form', async ({ page }) => {
  await open(page, { fail: 'product_settings_status' }); await show(page, 'mcp');
  await expect(field(page, 'mcp', 'product-panel')).toBeVisible();
  await expect(field(page, 'mcp', 'setup')).toBeDisabled();
  await expect(field(page, 'mcp', 'product-review')).toBeEnabled();
  await expect(field(page, 'mcp', 'product-status')).toContainText('product_settings_status');
  await expect(field(page, 'mcp', 'retry')).toBeVisible();
  expect((await commands(page, 'load_config')).length).toBe(0);
});

for (const settings of [{ productStatus: 'conflict' }, { productStatus: 'legacy-only' }, { productRecovery: true }]) test(`retained settings review stays outside locked form: ${JSON.stringify(settings)}`, async ({ page }) => {
  await open(page, settings); await show(page, 'mcp');
  await expect(field(page, 'mcp', 'setup')).toBeDisabled();
  await expect(field(page, 'mcp', 'product-review')).toBeEnabled();
  await expect(field(page, 'mcp', 'product-panel')).toBeVisible();
  await expect(field(page, 'mcp', 'retry')).toBeHidden();
  await expect(field(page, 'mcp', 'product-evidence')).toContainText('/retained/evidence.json');
  expect((await commands(page, 'load_config')).length).toBe(0);
  await field(page, 'mcp', 'product-review').click();
  await expect(field(page, 'mcp', 'product-status')).toContainText('without explicit approval');
  await expect(field(page, 'mcp', 'setup')).toBeDisabled();
  expect(await page.evaluate(() => lastProductReview)).toMatchObject({ approved: false, status: settings.productStatus || 'current' });
  expect((await commands(page, 'load_config')).length).toBe(0);
  expect((await commands(page, 'save_config')).length).toBe(0);
  await page.evaluate(() => { window.approveProduct = true; }); await field(page, 'mcp', 'product-review').click();
  await expect(field(page, 'mcp', 'setup')).toBeEnabled();
  expect(await page.evaluate(() => lastProductReview)).toMatchObject({ approved: true, status: settings.productStatus || 'current' });
  await expect(field(page, 'mcp', 'product-status')).toContainText('existing store');
  expect((await commands(page, 'load_config')).length).toBe(1);
  expect(await page.evaluate(() => savedConfig.unrelatedSetting)).toBe('preserve');
  expect((await commands(page, 'save_config')).length).toBe(0);
  if (settings.productStatus) {
    await field(page, 'mcp', 'product-check').click();
    await expect(field(page, 'mcp', 'setup')).toBeEnabled();
    await expect(field(page, 'mcp', 'product-status')).toContainText('Reviewed settings remain in use');
    expect((await commands(page, 'review_product_settings')).length).toBe(2);
    expect((await commands(page, 'load_config')).length).toBe(1);
    expect((await commands(page, 'save_config')).length).toBe(0);
  }
});

test('a new pending recovery after approved conflict still locks the form for explicit review', async ({ page }) => {
  await open(page, { productStatus: 'conflict' }); await show(page, 'mcp');
  await page.evaluate(() => { window.approveProduct = true; }); await field(page, 'mcp', 'product-review').click();
  await expect(field(page, 'mcp', 'setup')).toBeEnabled();
  await page.evaluate(() => { window.productRecovery = [{ journal: '/retained/new-recovery', historical_completed: false, completed: false, files: [] }]; });
  await field(page, 'mcp', 'product-check').click();
  await expect(field(page, 'mcp', 'setup')).toBeDisabled();
  await expect(field(page, 'mcp', 'product-status')).toContainText('recovery review');
  await expect(field(page, 'mcp', 'product-review')).toBeEnabled();
  expect((await commands(page, 'review_product_settings')).length).toBe(1);
  expect((await commands(page, 'load_config')).length).toBe(1);
  expect((await commands(page, 'save_config')).length).toBe(0);
});

test('protected load refusal leaves settings review reachable and does not replace retained configuration', async ({ page }) => {
  await open(page, { fail: 'load_config' }); await show(page, 'mcp');
  await expect(field(page, 'mcp', 'setup')).toBeDisabled();
  await expect(field(page, 'mcp', 'error')).toContainText('load_config');
  await expect(field(page, 'mcp', 'product-panel')).toBeVisible();
  await expect(field(page, 'mcp', 'product-review')).toBeEnabled();
  await field(page, 'mcp', 'product-review').click();
  expect((await commands(page, 'load_config')).length).toBe(1);
  await page.evaluate(() => { window.approveProduct = true; }); await field(page, 'mcp', 'product-review').click();
  await expect(field(page, 'mcp', 'setup')).toBeEnabled();
  expect((await commands(page, 'load_config')).length).toBe(2);
  await expect(field(page, 'mcp', 'retry')).toBeHidden();
  expect((await commands(page, 'save_config')).length).toBe(0);
});

test('project feedback initializes read-only and saves exact scoped DTOs without launcher changes', async ({ page }) => {
  await open(page, { feedbackDocuments: { '/projects/Creator': { feedbackEnabled: false, usageCheckInsEnabled: false, unrelated: 'keep' },
    '/projects/Other': { feedbackEnabled: true, usageCheckInsEnabled: true, unrelated: 'other' } } });
  await show(page, 'mcp');
  await expect(field(page, 'mcp', 'feedback-enabled')).toBeEnabled();
  await expect(field(page, 'mcp', 'feedback-enabled')).not.toBeChecked();
  await expect(field(page, 'mcp', 'feedback-usage')).toBeDisabled();
  expect((await commands(page, 'get_project_feedback_settings')).map(call => call.args.args)).toEqual([{ unityProjectPath: '/projects/Creator' }]);
  expect(await commands(page, 'set_project_feedback_settings')).toEqual([]);
  await field(page, 'mcp', 'feedback-enabled').check(); await field(page, 'mcp', 'feedback-usage').check();
  expect(await commands(page, 'set_project_feedback_settings')).toEqual([]);
  await field(page, 'mcp', 'feedback-save').click();
  await expect(field(page, 'mcp', 'feedback-status')).toContainText('Preferences saved and checked');
  expect((await commands(page, 'set_project_feedback_settings'))[0].args.args).toEqual({ unityProjectPath: '/projects/Creator', enabled: true, usageCheckIns: true });
  expect((await commands(page, 'get_project_feedback_settings')).length).toBe(2);
  await field(page, 'mcp', 'feedback-enabled').uncheck();
  await expect(field(page, 'mcp', 'feedback-usage')).not.toBeChecked();
  await expect(field(page, 'mcp', 'feedback-usage')).toBeDisabled();
  await field(page, 'mcp', 'feedback-save').click();
  await expect(field(page, 'mcp', 'feedback-status')).toContainText('Preferences saved and checked');
  expect((await commands(page, 'set_project_feedback_settings'))[1].args.args).toEqual({ unityProjectPath: '/projects/Creator', enabled: false, usageCheckIns: false });
  expect(await page.evaluate(() => feedbackDocuments)).toEqual({ '/projects/Creator': { feedbackEnabled: false, usageCheckInsEnabled: false, unrelated: 'keep' },
    '/projects/Other': { feedbackEnabled: true, usageCheckInsEnabled: true, unrelated: 'other' } });
  expect(await commands(page, 'save_config')).toEqual([]);
  expect(await page.evaluate(() => savedConfig.unrelatedSetting)).toBe('preserve');
});

test('feedback follows the checked draft project, retains navigation state and refuses unchecked or invalid paths', async ({ page }) => {
  await open(page, { feedbackDocuments: { '/projects/Other': { feedbackEnabled: true, usageCheckInsEnabled: true } } }); await show(page, 'mcp');
  await field(page, 'mcp', 'project').fill('/projects/Other');
  await expect(field(page, 'mcp', 'feedback-save')).toBeDisabled();
  await field(page, 'mcp', 'feedback-save').dispatchEvent('click');
  expect(await commands(page, 'set_project_feedback_settings')).toEqual([]);
  await field(page, 'mcp', 'check').click();
  await expect(field(page, 'mcp', 'feedback-enabled')).toBeChecked();
  await expect(field(page, 'mcp', 'feedback-usage')).toBeChecked();
  await expect(field(page, 'mcp', 'feedback-status')).toContainText('/projects/Other/.bantworks-mcp/feedback/MCP_FEEDBACK.md');
  await show(page, 'setup'); await show(page, 'mcp');
  await expect(field(page, 'mcp', 'feedback-usage')).toBeChecked();
  expect((await commands(page, 'get_project_feedback_settings')).length).toBe(2);
  await field(page, 'mcp', 'feedback-usage').uncheck(); await field(page, 'mcp', 'feedback-save').click();
  await expect(field(page, 'mcp', 'feedback-status')).toContainText('Preferences saved and checked');
  expect((await commands(page, 'set_project_feedback_settings'))[0].args.args).toEqual({ unityProjectPath: '/projects/Other', enabled: true, usageCheckIns: false });
  await field(page, 'mcp', 'project').fill(''); await field(page, 'mcp', 'check').click();
  await expect(field(page, 'mcp', 'feedback-enabled')).toBeDisabled();
  await expect(field(page, 'mcp', 'feedback-status')).toContainText('valid Unity project');
  expect((await commands(page, 'get_project_feedback_settings')).length).toBe(3);
});

for (const fixture of [{ invalidProject: true }, { invalidFeedback: true }]) test(`feedback rejects invalid project/response: ${JSON.stringify(fixture)}`, async ({ page }) => {
  await open(page, fixture); await show(page, 'mcp');
  await expect(field(page, 'mcp', 'feedback-enabled')).toBeDisabled();
  await expect(field(page, 'mcp', 'feedback-save')).toBeDisabled();
  if (fixture.invalidProject) expect(await commands(page, 'get_project_feedback_settings')).toEqual([]);
  else await expect(field(page, 'mcp', 'feedback-error')).toContainText('response is incomplete');
  await field(page, 'mcp', 'feedback-save').dispatchEvent('click');
  expect(await commands(page, 'set_project_feedback_settings')).toEqual([]);
});

test('feedback read failure stays local and explicitly retries without rewriting any settings', async ({ page }) => {
  await open(page, { fail: 'get_project_feedback_settings' }); await show(page, 'mcp');
  await expect(field(page, 'mcp', 'setup')).toBeEnabled();
  await expect(field(page, 'mcp', 'feedback-error')).toContainText('get_project_feedback_settings');
  await expect(field(page, 'mcp', 'feedback-save')).toBeDisabled();
  await field(page, 'mcp', 'feedback-check').click();
  await expect(field(page, 'mcp', 'feedback-enabled')).toBeEnabled();
  await expect(field(page, 'mcp', 'feedback-error')).toBeHidden();
  expect((await commands(page, 'get_project_feedback_settings')).length).toBe(2);
  expect(await commands(page, 'set_project_feedback_settings')).toEqual([]);
  expect(await commands(page, 'save_config')).toEqual([]);
});

test('late feedback reads cannot populate a different project or authorize its save', async ({ page }) => {
  await open(page, { feedbackDocuments: { '/projects/Creator': { feedbackEnabled: true, usageCheckInsEnabled: true } } }); await show(page, 'mcp');
  await page.evaluate(() => { window.hold = 'get_project_feedback_settings'; });
  await field(page, 'mcp', 'feedback-check').click();
  await page.waitForFunction(() => pending.get_project_feedback_settings);
  await field(page, 'mcp', 'project').evaluate(input => { input.value = '/projects/Other'; input.dispatchEvent(new Event('input')); });
  await page.evaluate(() => { window.hold = null; pending.get_project_feedback_settings(); });
  await expect(page.locator('#feature-mcp')).toHaveAttribute('aria-busy', 'false');
  await expect(field(page, 'mcp', 'feedback-enabled')).not.toBeChecked();
  await expect(field(page, 'mcp', 'feedback-save')).toBeDisabled();
  await field(page, 'mcp', 'feedback-save').dispatchEvent('click');
  expect(await commands(page, 'set_project_feedback_settings')).toEqual([]);
  await field(page, 'mcp', 'check').click();
  await expect(field(page, 'mcp', 'feedback-enabled')).toBeEnabled();
  await expect(field(page, 'mcp', 'feedback-enabled')).not.toBeChecked();
  expect((await commands(page, 'get_project_feedback_settings')).at(-1).args.args).toEqual({ unityProjectPath: '/projects/Other' });
});

test('feedback save rechecks its project after acquiring the native workflow', async ({ page }) => {
  await open(page); await show(page, 'mcp');
  await field(page, 'mcp', 'feedback-enabled').check();
  await page.evaluate(() => { window.hold = 'begin_ui_operation'; });
  await field(page, 'mcp', 'feedback-save').click(); await page.waitForFunction(() => pending.begin_ui_operation);
  await field(page, 'mcp', 'project').evaluate(input => { input.value = '/projects/Other'; input.dispatchEvent(new Event('input')); });
  await page.evaluate(() => { window.hold = null; pending.begin_ui_operation(); });
  await expect(field(page, 'mcp', 'error')).toContainText('Project changed before feedback could be saved');
  expect(await commands(page, 'set_project_feedback_settings')).toEqual([]);
  await expect(field(page, 'mcp', 'feedback-save')).toBeDisabled();
});

test('feedback duplicate saves are blocked and an unknown partial write requires a read-only check', async ({ page }) => {
  await open(page, { feedbackFailureAfterSave: true }); await show(page, 'mcp');
  await field(page, 'mcp', 'feedback-enabled').check(); await field(page, 'mcp', 'feedback-usage').check();
  await page.evaluate(() => { window.hold = 'set_project_feedback_settings'; });
  await field(page, 'mcp', 'feedback-save').click(); await page.waitForFunction(() => pending.set_project_feedback_settings);
  await field(page, 'mcp', 'feedback-save').dispatchEvent('click');
  expect((await commands(page, 'set_project_feedback_settings')).length).toBe(1);
  await page.evaluate(() => { window.hold = null; pending.set_project_feedback_settings(); });
  await expect(field(page, 'mcp', 'feedback-error')).toContainText('<img src=x onerror=alert(1)>');
  expect(await field(page, 'mcp', 'feedback-error').locator('img').count()).toBe(0);
  await expect(field(page, 'mcp', 'feedback-status')).toContainText('outcome is unknown');
  await expect(field(page, 'mcp', 'feedback-save')).toBeDisabled();
  expect((await commands(page, 'get_project_feedback_settings')).length).toBe(1);
  await field(page, 'mcp', 'feedback-check').click();
  await expect(field(page, 'mcp', 'feedback-enabled')).toBeChecked();
  await expect(field(page, 'mcp', 'feedback-usage')).toBeChecked();
  await expect(field(page, 'mcp', 'feedback-error')).toBeHidden();
  expect((await commands(page, 'set_project_feedback_settings')).length).toBe(1);
  expect(await commands(page, 'save_config')).toEqual([]);
});

test('feedback save reports uncertain readback and never acknowledges a failed workflow release', async ({ page }) => {
  await open(page); await show(page, 'mcp');
  await field(page, 'mcp', 'feedback-enabled').check();
  await page.evaluate(() => { window.failNext = 'get_project_feedback_settings'; });
  await field(page, 'mcp', 'feedback-save').click();
  await expect(field(page, 'mcp', 'error')).toContainText('could not be verified after saving');
  await expect(field(page, 'mcp', 'feedback-save')).toBeDisabled();
  await field(page, 'mcp', 'feedback-check').click();
  await expect(field(page, 'mcp', 'feedback-enabled')).toBeChecked();
  await page.evaluate(() => { window.failNext = 'finish_ui_operation'; });
  await field(page, 'mcp', 'feedback-save').click();
  await expect(field(page, 'mcp', 'error')).toContainText('Operation state is unknown');
  await expect(field(page, 'mcp', 'feedback-status')).not.toContainText('Preferences saved and checked');
  await expect(field(page, 'mcp', 'feedback-save')).toBeDisabled();
  expect((await commands(page, 'set_project_feedback_settings')).length).toBe(2);
});

test('feedback readback drift displays actual preferences without claiming the requested save', async ({ page }) => {
  await open(page); await show(page, 'mcp');
  await field(page, 'mcp', 'feedback-enabled').check();
  await page.evaluate(() => { window.hold = 'get_project_feedback_settings'; });
  await field(page, 'mcp', 'feedback-save').click(); await page.waitForFunction(() => pending.get_project_feedback_settings);
  await page.evaluate(() => {
    window.feedbackDocuments['/projects/Creator'].feedbackEnabled = false;
    window.hold = null; pending.get_project_feedback_settings();
  });
  await expect(field(page, 'mcp', 'error')).toContainText('Read-back feedback preferences differ');
  await expect(field(page, 'mcp', 'feedback-enabled')).not.toBeChecked();
  await expect(field(page, 'mcp', 'feedback-status')).not.toContainText('Preferences saved and checked');
  expect((await commands(page, 'set_project_feedback_settings')).length).toBe(1);
});

test('MCP manual Desktop apply/disconnect and advanced options preserve unknown config fields', async ({ page }) => {
  await open(page); await show(page, 'mcp');
  await page.getByRole('button', { name: 'Apply to Claude Desktop', exact: true }).click();
  const applied = (await commands(page, 'update_claude_desktop_mcp_config'))[0];
  expect(applied.args.args).toMatchObject({ channel: { id: 'one', unity_project_path: '/projects/Creator' }, mcpServerPath: '/private/server.mjs', toolGroups: 'core' });
  await page.getByRole('button', { name: 'Disconnect Claude Desktop', exact: true }).click();
  await page.getByRole('dialog', { name: 'Disconnect Claude Desktop?' }).getByRole('button', { name: 'Disconnect', exact: true }).click();
  expect((await commands(page, 'remove_claude_desktop_mcp_config')).length).toBe(1);
  expect((await commands(page, 'remove_claude_mcp_config')).length).toBe(0);
  await page.getByText('Advanced settings', { exact: true }).click();
  await field(page, 'mcp', 'server').fill('/private/new-server.mjs'); await field(page, 'mcp', 'groups').selectOption('read');
  await field(page, 'mcp', 'scripts').check(); await field(page, 'mcp', 'save').click();
  await expect(field(page, 'mcp', 'setup-result')).toContainText('Options saved');
  const saved = (await commands(page, 'save_config')).at(-1).args.args.config;
  expect(saved).toMatchObject({ unrelatedSetting: 'preserve', mcp_server_path: '/private/new-server.mjs', tool_groups: 'read', enable_custom_scripts: true });
  expect((await commands(page, 'set_unity_custom_scripts')).at(-1).args.args).toEqual({ unityProjectPath: '/projects/Creator', enabled: true });
  expect((await commands(page, 'update_codex_mcp_config')).at(-1).args.args.toolGroups).toBe('read');
});

test('hide during reviewed setup cancels its dialog, releases workflow and never writes setup', async ({ page }) => {
  await open(page); await show(page, 'mcp'); await field(page, 'mcp', 'setup').click();
  await expect(page.getByRole('dialog', { name: 'Review connection setup' })).toBeVisible();
  await page.evaluate(() => CreatorFeaturePages.hide());
  await expect.poll(async () => (await commands(page, 'begin_ui_operation')).length - (await commands(page, 'finish_ui_operation')).length).toBe(0);
  expect((await commands(page, 'one_click_setup')).length).toBe(0);
  expect(await page.evaluate(() => CreatorFeaturePages.dispose())).toBe(true);
  expect(await page.evaluate(() => Boolean(events['feature-event']))).toBe(false);
});

test('persistent notice requires consent and storage verification before hiding', async ({ page }) => {
  await open(page); await show(page, 'mcp');
  await field(page, 'mcp', 'notice-remember').check(); await field(page, 'mcp', 'notice-close').click();
  const modal = page.getByRole('dialog', { name: 'Confirm hiding this notice' });
  await expect(modal.getByRole('button', { name: 'Confirm and hide' })).toBeDisabled();
  await modal.getByRole('checkbox').check();
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('Fixture storage denied'); }; });
  await modal.getByRole('button', { name: 'Confirm and hide' }).click();
  await expect(field(page, 'mcp', 'notice')).toBeVisible();
  await expect(field(page, 'mcp', 'error')).toContainText('warning remains visible');
});

async function layoutProblems(page, selector) {
  return page.locator(selector).evaluate(root => {
    const items = [];
    const controls = 'button, input, select, textarea, progress';
    const add = (element, rect, kind) => {
      if (rect.width > 0 && rect.height > 0) items.push({ element, rect, kind,
        label: `${element.tagName.toLowerCase()}[${element.dataset.field || element.id || element.textContent.trim().slice(0, 45)}]` });
    };
    for (const element of root.querySelectorAll('*')) {
      if (!element.checkVisibility({ checkVisibilityCSS: true })) continue;
      if (element.matches(controls)) {
        add(element, element.getBoundingClientRect(), 'control');
      } else if (!element.closest(controls) && getComputedStyle(element).visibility === 'visible') {
        for (const child of element.childNodes) {
          if (child.nodeType !== Node.TEXT_NODE || !child.textContent.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(child);
          for (const rect of range.getClientRects()) add(element, rect, 'text');
        }
      }
    }
    const problems = items.filter(({ rect }) => rect.left < -0.5 || rect.right > innerWidth + 0.5)
      .map(({ label, rect }) => ({ kind: 'horizontal-overflow', label, rect: rect.toJSON() }));
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.element === b.element) continue;
      if (Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left) > 1
        && Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top) > 1) {
        problems.push({ kind: 'overlap', a: a.label, b: b.label, aRect: a.rect.toJSON(), bRect: b.rect.toJSON() });
      }
    }
    return problems.slice(0, 12);
  });
}

for (const width of [1280, 390, 320]) test(`actual Root feature layouts have no overlap and centered dialogs at ${width}px`, async ({ page }, testInfo) => {
  const height = 780;
  await page.setViewportSize({ width, height }); await open(page, { shell: true });
  await expect(page.locator('#catalog-status')).toContainText('Update check complete');
  await selectSuiteView(page, 'setup');
  await expect(field(page, 'setup', 'create')).toBeEnabled();
  const capture = async (name, fullPage = true) => {
    const screenshot = testInfo.outputPath(`${width}-${name}.png`);
    await page.screenshot({ path: screenshot, fullPage });
    await testInfo.attach(name, { path: screenshot, contentType: 'image/png' });
  };
  const checkPage = async feature => {
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))); });
    expect(await page.locator('iframe').count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await layoutProblems(page, `#feature-${feature}`)).toEqual([]);
    expect(await helpOcclusion(page, `#feature-${feature} :is(button, input, select):not(details:not([open]) *)`)).toBeNull();
    await page.evaluate(() => scrollTo(0, 0));
  };
  const checkDialog = async (dialog, name, selector = '[open].feature-dialog') => {
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThan(2);
    expect(Math.abs(box.y + box.height / 2 - height / 2)).toBeLessThan(2);
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    expect(await layoutProblems(page, selector)).toEqual([]);
    await capture(name, false);
  };
  const checkHelp = async feature => {
    await page.locator('#context-help-open').click();
    await expect(page.locator('#context-help-title')).toHaveText(feature === 'setup' ? 'Project Setup help' : 'Creator Works MCP help');
    await expect(page.locator('#hub-help-content')).toBeHidden();
    await page.locator('#feature-help-content details').first().locator('summary').click();
    await checkDialog(page.locator('#context-help-dialog'), `${feature}-help`, '#context-help-dialog');
    await page.locator('#context-help-close').click();
  };
  await checkPage('setup'); await capture('setup');
  await checkHelp('setup');
  await field(page, 'setup', 'existing-tab').click();
  await checkPage('setup'); await capture('setup-existing');
  await selectSuiteView(page, 'mcp');
  await expect(field(page, 'mcp', 'setup')).toBeEnabled();
  await checkPage('mcp'); await capture('mcp');
  await checkHelp('mcp');
  await field(page, 'mcp', 'guide').click();
  await checkDialog(field(page, 'mcp', 'guide-dialog'), 'mcp-guide');
  await page.keyboard.press('Escape');
  await field(page, 'mcp', 'notice-remember').check(); await field(page, 'mcp', 'notice-close').click();
  await checkDialog(page.getByRole('dialog', { name: 'Confirm hiding this notice' }), 'mcp-consent');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await field(page, 'mcp', 'setup').click();
  await checkDialog(page.getByRole('dialog', { name: 'Review connection setup' }), 'mcp-setup-review');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => calls.filter(call => ['start_hosted_app', 'hosted_app_call', 'stop_hosted_app'].includes(call.command)))).toEqual([]);
});
