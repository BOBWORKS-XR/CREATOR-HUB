const { test, expect } = require('@playwright/test');

// Mock the native boundary only. Never start MCP/Unity or read installed settings.
async function open(page, options = {}) {
  await page.route('**/app.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.addInitScript(options => {
    localStorage.setItem('creator-usage-terms.hub', JSON.stringify({ policyVersion: '2026-09-28-v1', acceptedAt: '2026-09-28T00:00:00Z' }));
    window.__CREATOR_HUB_FEATURE_PROTOCOL__ = 1;
    window.calls = []; window.pending = {}; window.failNext = options.fail || null; window.failures = {};
    const channels = ['Creator', 'Other'].map((name, index) => ({ id: String(index), name, unity_project_path: `/projects/${name}`, enabled: true }));
    window.savedConfig = { channels, active_channel_id: '0', mcp_server_path: '/private/server.mjs', tool_groups: 'core',
      auto_start: true, enable_custom_scripts: false, allow_all_tests: true, connection_guide_version: 1,
      unrelated: { retain: ['exact', 'values'] }, ...options.config };
    window.bridgeStatuses = { '/projects/Creator': { installed: true, current: true }, '/projects/Other': { installed: true, current: false } };
    window.recoveryRecords = options.recovery || [];
    window.unityOptions = Object.fromEntries(channels.map(channel => [channel.unity_project_path, {
      enable_custom_scripts: window.savedConfig.enable_custom_scripts, allow_all_tests: window.savedConfig.allow_all_tests,
    }]));
    const profile = { profile: 'creator', label: 'Creator SDK', packages: [], recommendedToolGroups: 'core,creator' };
    window.profiles = {
      '/projects/Creator': profile,
      '/projects/Other': { profile: 'banter', label: 'Banter SDK', packages: [], recommendedToolGroups: 'core,banter' },
      ...options.profiles,
    };
    window.productReport = { status: options.productStatus || 'current', backups: [], recovery: options.productRecovery || [], ...options.productReport };
    window.__TAURI__ = {
      event: { listen: async () => () => {} },
      core: { invoke: async (command, args = {}) => {
        window.calls.push({ command, args: structuredClone(args) });
        if (command === 'feature_status') return { integrated: true, features: ['mcp', 'setup'] };
        if (command === 'feature_call' && args.feature === 'setup' && args.command === 'latest_sdk_requirements') {
          if (options.latestSdkFails) throw new Error('Registry unavailable');
          return { version: options.latestSdkVersion || '4.0.27' };
        }
        if (command !== 'feature_call' || args.feature !== 'mcp') throw new Error(`Unexpected outer command: ${command}`);
        const { command: name, args: fields } = args;
        if (window.hold === name) await new Promise(resolve => { window.pending[name] = resolve; });
        if (window.failNext === name || window.failures[name] > 0) {
          if (window.failNext === name) window.failNext = null;
          else window.failures[name]--;
          throw new Error(`Fixture failure: ${name}`);
        }
        switch (name) {
          case 'begin_ui_operation': return 17;
          case 'finish_ui_operation': return null;
          case 'product_settings_status': return window.productReport;
          case 'review_product_settings':
            if (options.partialProductReview) window.savedConfig.unrelated.recovered = true;
            return options.productReviewResult || { ...window.productReport, approved: true };
          case 'load_config': return structuredClone(window.savedConfig);
          case 'save_config':
            window.savedConfig = structuredClone(fields.config);
            if (window.failNextReadback) { window.failNextReadback = false; window.failNext = 'load_config'; }
            if (window.failAfterSave) { window.failAfterSave = false; throw new Error('Save outcome unknown after publication'); }
            return null;
          case 'discover_unity_projects': return channels.map(channel => ({ name: channel.name, path: channel.unity_project_path }));
          case 'get_onboarding_status': return window.invalidStatus ? { runtime: { ready: true }, clients: [] } : {
            managedRouting: options.managedRouting !== false, runtime: { ready: true, ...options.runtime },
            project: fields.unityProjectPath ? { valid: true, bridgeInstalled: true, bridgeCurrent: true, stateStatus: 'fresh', sdkProfile: window.profiles[fields.unityProjectPath] } : null,
            clients: ['codex', 'claude', 'claudeDesktop', 'antigravity', 'opencode'].map(id => ({
              id, detected: true, configured: id !== 'claude' || options.claudeUserConfigured !== false, supported: true,
            })),
            unityCli: { canEnable: true, enabled: false, message: 'Optional Unity CLI' },
          };
          case 'get_unity_extension_status': return window.bridgeStatuses[fields.unityProjectPath];
          case 'get_project_sdk_profile': return window.profiles[fields.unityProjectPath];
          case 'get_project_feedback_settings': return { enabled: false, usageCheckIns: false, file: `${fields.unityProjectPath}/feedback.md` };
          case 'pending_client_recovery': return structuredClone(window.recoveryRecords);
          case 'recover_client_connection': {
            window.recoveryRecords = window.recoveryRecords.filter(record => record.operation !== fields.operation);
            if (window.recoveryReadFails) window.failNext = 'pending_client_recovery';
            if (window.recoveryFails) throw new Error('Recovery outcome unknown; retain evidence');
            return { completed: true };
          }
          case 'review_existing_client_connections': return { status: 'unchanged' };
          case 'one_click_setup': {
            const channel = window.savedConfig.channels.find(channel => channel.unity_project_path === fields.unityProjectPath);
            window.savedConfig.active_channel_id = channel.id;
            if (options.partialSetup) throw new Error('Setup stopped after saving; earlier steps remain');
            return { channel };
          }
          case 'update_codex_mcp_config': case 'update_claude_mcp_config': case 'update_claude_desktop_mcp_config':
          case 'update_antigravity_mcp_config': case 'update_opencode_mcp_config': return null;
          case 'set_unity_custom_scripts': case 'set_unity_allow_all_tests': {
            const key = name === 'set_unity_custom_scripts' ? 'enable_custom_scripts' : 'allow_all_tests';
            window.unityOptions[fields.unityProjectPath][key] = fields.enabled;
            if (window.unityFailAfter === name) {
              window.unityFailAfter = null;
              throw new Error(`Unity write outcome unknown: ${name}`);
            }
            return null;
          }
          default: throw new Error(`Unexpected feature command: ${name}`);
        }
      } },
    };
  }, options);
  await page.goto('http://127.0.0.1:4188/');
  await page.evaluate(async () => {
    await CreatorUsageTerms.requireAcceptance();
    for (const id of ['view-hub', 'view-projects', 'view-detail', 'view-builtin', 'hub-pages']) document.getElementById(id).classList.add('hidden');
    await CreatorFeaturePages.show('mcp');
  });
}
const field = (page, name) => page.locator(`#feature-mcp [data-field="${name}"]`);
const commands = (page, name) => page.evaluate(name => calls.filter(call => call.command === 'feature_call' && call.args.command === name), name);
const mutationCalls = page => page.evaluate(() => calls.filter(call => call.command === 'feature_call'
  && /^(?:save_|one_click_setup$|add_project$|install_|update_|set_|remove_|review_|recover_)/.test(call.args.command)));
const row = (page, name) => field(page, 'projects').locator(`[data-project-path="/projects/${name}"]`);
const idle = page => expect(page.locator('#feature-mcp')).toHaveAttribute('aria-busy', 'false');

test('Claude Code reports user-level configuration without judging or changing project setup', async ({ page }) => {
  await open(page, { claudeUserConfigured: false });
  const client = page.locator('.feature-client').filter({ has: page.locator('[data-client="claude"]') });
  await expect(client).toContainText('Detected · No user-level setup found');
  await expect(page.locator('.feature-client').filter({ has: page.locator('[data-client="codex"]') }))
    .toContainText('Detected · Configured');
  expect(await mutationCalls(page)).toEqual([]);
});

test('latest SDK lookup is independent of the installed future SDK and never changes settings', async ({ page }) => {
  await open(page, { latestSdkVersion: '100.42.8', profiles: {
    '/projects/Creator': { profile: 'creator', label: 'Creator SDK 100.42.7', creatorSdkTested: false,
      recommendedToolGroups: 'core,creator' },
  } });
  await expect(row(page, 'Creator')).toContainText('Creator SDK 100.42.7');
  await expect(row(page, 'Creator')).toContainText('Not yet tested with Hub');
  await expect(field(page, 'sdk-latest')).toHaveText('Latest Creator SDK: 100.42.8');
  await field(page, 'sdk-check').click();
  await expect(field(page, 'sdk-latest')).toHaveText('Latest Creator SDK: 100.42.8');
  expect(await mutationCalls(page)).toEqual([]);
});

test('offline SDK lookup keeps installed versions and MCP controls usable', async ({ page }) => {
  await open(page, { latestSdkFails: true });
  await expect(field(page, 'sdk-latest')).toContainText('Installed versions are still shown');
  await expect(row(page, 'Creator')).toContainText('Creator SDK');
  await expect(field(page, 'setup')).toBeEnabled();
  await expect(field(page, 'sdk-check')).toBeEnabled();
  expect(await mutationCalls(page)).toEqual([]);
});

for (const width of [1100, 320]) test(`SDK identity remains visible when package versions need review at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  await open(page, { config: { tool_groups: 'core,creator' }, profiles: {
    '/projects/Creator': { profile: 'creator', label: 'Creator SDK 4.0.25', creatorSdk: true,
      error: 'Some installed package versions differ from their dependencies.', recommendedToolGroups: null },
  } });
  await expect(row(page, 'Creator')).toContainText('Creator SDK 4.0.25');
  await expect(row(page, 'Creator')).not.toContainText('SDK unknown');
  await expect(row(page, 'Creator')).toContainText('Package versions need review');
  await page.getByText('Advanced settings', { exact: true }).click();
  await expect(field(page, 'groups')).toHaveValue('core,creator');
  await expect(field(page, 'setup')).toBeEnabled();
  expect(await mutationCalls(page)).toEqual([]);
  expect(await page.evaluate(() => savedConfig.tool_groups)).toBe('core,creator');
  expect(await row(page, 'Creator').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await row(page, 'Creator').screenshot({ path: testInfo.outputPath(`sdk-identity-${width}.png`) });
});

test('known SDK with unresolved package versions does not enable Auto', async ({ page }) => {
  await open(page, { config: { tool_groups: 'auto' }, profiles: {
    '/projects/Creator': { profile: 'creator', label: 'Creator SDK 4.0.22', creatorSdk: true,
      error: 'Some installed package versions differ from their dependencies.', recommendedToolGroups: null },
  } });
  await expect(row(page, 'Creator')).toContainText('Creator SDK 4.0.22');
  await page.getByText('Advanced settings', { exact: true }).click();
  await expect(field(page, 'capability-status')).toContainText('Creator SDK 4.0.22 detected');
  await expect(field(page, 'capability-status')).toContainText('Setup / Repair');
  await expect(field(page, 'setup')).toBeDisabled();
  expect(await mutationCalls(page)).toEqual([]);
});

test('Auto labels follow the checked SDK without changing stored preferences', async ({ page }) => {
  await open(page, { config: { tool_groups: 'auto' } });
  await page.getByText('Advanced settings', { exact: true }).click();
  await expect(field(page, 'groups')).toHaveValue('auto');
  await expect(field(page, 'capability-status')).toHaveText('Detected: Altspace / Creator SDK');
  await expect(field(page, 'groups').locator('option[value="all"]')).toHaveText('All tools (high context)');
  await field(page, 'discovered').selectOption('/projects/Other'); await idle(page);
  await expect(field(page, 'capability-status')).toHaveText('Detected: Banter');
  await expect(field(page, 'groups').locator('option[value="auto"]')).toHaveText('Auto: Banter');
  expect(await mutationCalls(page)).toEqual([]);
  expect(await page.evaluate(() => savedConfig.tool_groups)).toBe('auto');
});

for (const [profile, groups, label] of [
  ['hybrid', 'core,banter,creator', 'Altspace + Banter'],
  ['none', 'core', 'Unity core'],
]) test(`Auto describes ${profile} accurately`, async ({ page }) => {
  await open(page, { config: { tool_groups: 'auto' }, profiles: {
    '/projects/Creator': { profile, recommendedToolGroups: groups, label },
  } });
  await expect(field(page, 'capability-status')).toHaveText(`Detected: ${label}`);
  await expect(field(page, 'setup')).toBeEnabled();
  expect(await mutationCalls(page)).toEqual([]);
});

test('unverified Auto blocks client changes and explicit manual Save confirms Unity options', async ({ page }) => {
  await open(page, { config: { tool_groups: 'auto', auto_start: false }, profiles: {
    '/projects/Creator': { profile: 'unknown', error: 'Invalid metadata', recommendedToolGroups: null },
  } });
  await page.getByText('Advanced settings', { exact: true }).click();
  await expect(field(page, 'capability-status')).toContainText('Check the connection again or choose a manual');
  await expect(field(page, 'setup')).toBeDisabled();
  await page.getByRole('button', { name: 'Apply to Codex', exact: true }).dispatchEvent('click'); await idle(page);
  expect(await commands(page, 'update_codex_mcp_config')).toEqual([]);
  await field(page, 'groups').selectOption('core,creator');
  await expect(field(page, 'setup')).toBeDisabled();
  await field(page, 'save').click(); await idle(page);
  await expect(field(page, 'setup')).toBeEnabled();
  expect(await page.evaluate(() => savedConfig.tool_groups)).toBe('core,creator');
  expect((await commands(page, 'set_unity_custom_scripts')).map(call => call.args.args)).toEqual([
    { unityProjectPath: '/projects/Creator', enabled: false },
  ]);
  expect((await commands(page, 'set_unity_allow_all_tests')).map(call => call.args.args)).toEqual([
    { unityProjectPath: '/projects/Creator', enabled: true },
  ]);
  const saved = await page.evaluate(() => savedConfig);
  expect(saved.unrelated).toEqual({ retain: ['exact', 'values'] });
  expect(saved.channels).toHaveLength(2);
});

test('manual profiles stay manual across SDK changes and project selection', async ({ page }) => {
  await open(page, { config: { tool_groups: 'read' } });
  await page.getByText('Advanced settings', { exact: true }).click();
  await page.getByRole('button', { name: 'Select Other for MCP', exact: true }).click(); await idle(page);
  await expect(field(page, 'groups')).toHaveValue('read');
  await expect(field(page, 'capability-status')).toHaveText('Manual: Inspection');
  const updates = await commands(page, 'update_codex_mcp_config');
  expect(updates.at(-1).args.args.toolGroups).toBe('read');
  expect(await page.evaluate(() => savedConfig.tool_groups)).toBe('read');
});

test('Auto follows explicit project selection only when enabled', async ({ page }) => {
  await open(page, { config: { tool_groups: 'auto', auto_start: false } });
  await page.getByRole('button', { name: 'Select Other for MCP', exact: true }).click(); await idle(page);
  expect(await commands(page, 'update_codex_mcp_config')).toEqual([]);
  await page.getByText('Advanced settings', { exact: true }).click();
  await field(page, 'follow').check(); await field(page, 'save').click(); await idle(page);
  const updates = await commands(page, 'update_codex_mcp_config');
  expect(updates.at(-1).args.args.toolGroups).toBe('auto');
  expect(updates.at(-1).args.args.channel.unity_project_path).toBe('/projects/Other');
  expect(await page.evaluate(() => savedConfig.tool_groups)).toBe('auto');
});

test('a late response cannot restore Auto readiness after the project changed', async ({ page }) => {
  await open(page, { config: { tool_groups: 'auto' } });
  await page.evaluate(() => { window.hold = 'get_onboarding_status'; });
  await field(page, 'check').click(); await page.waitForFunction(() => pending.get_onboarding_status);
  await field(page, 'project').evaluate(input => {
    input.value = '/projects/Other'; input.dispatchEvent(new Event('input'));
  });
  await page.evaluate(() => { window.hold = null; pending.get_onboarding_status(); }); await idle(page);
  await expect(field(page, 'setup')).toBeDisabled();
  await expect(field(page, 'capability-status')).toContainText('SDK not verified');
  await field(page, 'check').click(); await idle(page);
  await expect(field(page, 'capability-status')).toHaveText('Detected: Banter');
  expect(await mutationCalls(page)).toEqual([]);
});

test('saving Auto follows the active project, not an unknown SDK draft', async ({ page }) => {
  await open(page, { profiles: { '/projects/Other': { profile: 'unknown', error: 'Invalid metadata', recommendedToolGroups: null } } });
  await field(page, 'discovered').selectOption('/projects/Other'); await idle(page);
  await page.getByText('Advanced settings', { exact: true }).click();
  await field(page, 'groups').selectOption('auto');
  await field(page, 'save').click(); await idle(page);
  const updates = await commands(page, 'update_codex_mcp_config');
  expect(updates).toHaveLength(1);
  expect(updates[0].args.args.channel.unity_project_path).toBe('/projects/Creator');
  expect(updates[0].args.args.toolGroups).toBe('auto');
  expect(await page.evaluate(() => savedConfig.active_channel_id)).toBe('0');
  await expect(field(page, 'project')).toHaveValue('/projects/Other');
});

test('failed capability save readback keeps the stored manual profile', async ({ page }) => {
  await open(page);
  await page.getByText('Advanced settings', { exact: true }).click();
  await field(page, 'groups').selectOption('auto');
  await page.evaluate(() => { window.failNext = 'save_config'; });
  await field(page, 'save').click(); await idle(page);
  expect(await page.evaluate(() => savedConfig.tool_groups)).toBe('core');
  expect(await commands(page, 'update_codex_mcp_config')).toEqual([]);
  await expect(field(page, 'error')).toContainText('save_config');
});

for (const width of [1100, 320]) test(`Auto and manual capability labels fit at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  await open(page, { config: { tool_groups: 'auto' } });
  await page.getByText('Advanced settings', { exact: true }).click();
  await field(page, 'groups').scrollIntoViewIfNeeded();
  await expect(field(page, 'groups')).toBeVisible();
  const bounds = await field(page, 'groups').boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.screenshot({ path: testInfo.outputPath(`capabilities-${width}.png`) });
});

test('recent saved state does not claim a live Unity connection', async ({ page }) => {
  await open(page);
  await expect(field(page, 'checks')).toContainText('Recent Unity state found');
  await expect(field(page, 'checks')).not.toContainText('Connected');
  await expect(field(page, 'guide-steps')).toContainText('A live connection has not been verified.');
  await expect(field(page, 'guide-steps')).toContainText('get_bridge_status');
  await expect(field(page, 'guide-steps')).not.toContainText('Unity bridge is responding.');
  expect(await mutationCalls(page)).toEqual([]);
});
async function controlsLocked(page, locked) {
  // Fieldsets own the lock; inherited disabled semantics apply to their controls.
  await expect(field(page, 'controls')).toHaveJSProperty('disabled', locked);
  for (const name of ['project', 'check']) {
    if (locked) await expect(field(page, name)).toBeDisabled();
    else await expect(field(page, name)).toBeEnabled();
  }
}
async function navigateBack(page) { await page.evaluate(async () => { CreatorFeaturePages.hide(); await CreatorFeaturePages.show('mcp'); }); }

const backedUpConflict = () => ({
  status: 'conflict', currentPath: '/current/launcher-config.json', legacyPath: '/legacy/launcher-config.json',
  backups: [`/current/.creator-hub-settings-backups/launcher-config.json.${'a'.repeat(64)}.bak`,
    `/legacy/.creator-hub-settings-backups/launcher-config.json.${'b'.repeat(64)}.bak`], recovery: [],
});

test('approved backed-up settings remain usable after a full page restart without automatic writes', async ({ page }) => {
  await open(page, { productReport: backedUpConflict() });
  await controlsLocked(page, true);
  await field(page, 'product-review').click(); await idle(page);
  await controlsLocked(page, false);
  await expect(field(page, 'project')).toHaveValue('/projects/Creator');
  expect(await page.evaluate(() => localStorage.getItem('creator-hub.mcp-product-review.v1'))).not.toBeNull();
  await page.reload();
  await page.evaluate(async () => { await CreatorUsageTerms.requireAcceptance(); await CreatorFeaturePages.show('mcp'); });
  await idle(page); await controlsLocked(page, false);
  await expect(field(page, 'project')).toHaveValue('/projects/Creator');
  expect(await mutationCalls(page)).toEqual([]);
  expect(await page.evaluate(() => savedConfig.unrelated)).toEqual({ retain: ['exact', 'values'] });
});

test('a changed saved file or unfinished recovery invalidates the remembered settings review', async ({ page }) => {
  await open(page, { productReport: backedUpConflict() });
  await field(page, 'product-review').click(); await idle(page);
  await page.evaluate(() => { productReport.backups[0] = productReport.backups[0].replace('a'.repeat(64), 'c'.repeat(64)); });
  await field(page, 'product-check').dispatchEvent('click'); await idle(page); await controlsLocked(page, true);
  await field(page, 'product-review').click(); await idle(page); await controlsLocked(page, false);
  await page.evaluate(() => { productReport.recovery = [{ historical_completed: false, files: [] }]; });
  await field(page, 'product-check').dispatchEvent('click'); await idle(page); await controlsLocked(page, true);
  expect(await commands(page, 'save_config')).toEqual([]);
});

for (const fault of ['load_config', 'finish_ui_operation']) test(`failed ${fault} cannot persist setup approval`, async ({ page }) => {
  await open(page, { productReport: backedUpConflict() });
  await page.evaluate(fault => { failNext = fault; }, fault);
  await field(page, 'product-review').click(); await idle(page);
  await controlsLocked(page, true);
  expect(await page.evaluate(() => localStorage.getItem('creator-hub.mcp-product-review.v1'))).toBeNull();
});

test('settings review storage failure keeps the form locked with a retryable explanation', async ({ page }) => {
  await open(page, { productReport: backedUpConflict() });
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('Storage unavailable'); }; });
  await field(page, 'product-review').click(); await idle(page);
  await controlsLocked(page, true);
  await expect(field(page, 'product-status')).toContainText('Your existing files are kept');
  await expect(field(page, 'product-review')).toBeEnabled();
});

test('explicit review repairs a malformed remembered receipt after rechecking backups', async ({ page }) => {
  await open(page, { productReport: backedUpConflict() });
  await page.evaluate(() => localStorage.setItem('creator-hub.mcp-product-review.v1', '{broken'));
  await field(page, 'product-check').dispatchEvent('click'); await idle(page);
  await controlsLocked(page, true);
  await field(page, 'product-review').click(); await idle(page);
  await controlsLocked(page, false);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('creator-hub.mcp-product-review.v1')).version)).toBe(1);
  expect(await commands(page, 'save_config')).toEqual([]);
});

test('runtime repair before route binding preserves every other setting without Unity or client writes', async ({ page }) => {
  await open(page, { managedRouting: false, runtime: { bundled: true, command: 'C:/Hub/mcp/server/runtime/node.exe' } });
  const before = await page.evaluate(() => structuredClone(savedConfig));
  await field(page, 'repair-runtime').click();
  await page.getByRole('button', { name: 'Use Hub runtime', exact: true }).click(); await idle(page);
  const after = await page.evaluate(() => structuredClone(savedConfig));
  expect(after).toEqual({ ...before, mcp_server_path: 'C:/Hub/mcp/server/creator-works-mcp.mjs' });
  expect((await mutationCalls(page)).map(call => call.args.command)).toEqual(['save_config']);
  await expect(field(page, 'runtime-repair')).toBeHidden();
});

test('runtime repair cancellation keeps all settings unchanged', async ({ page }) => {
  await open(page, { runtime: { bundled: true, command: 'C:/Hub/mcp/server/runtime/node.exe' } });
  const before = await page.evaluate(() => structuredClone(savedConfig));
  await field(page, 'repair-runtime').click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await idle(page);
  expect(await page.evaluate(() => savedConfig)).toEqual(before);
  expect(await mutationCalls(page)).toEqual([]);
});

test('runtime repair refuses settings changed while its confirmation is open', async ({ page }) => {
  await open(page, { runtime: { bundled: true, command: 'C:/Hub/mcp/server/runtime/node.exe' } });
  await field(page, 'repair-runtime').click();
  await page.evaluate(() => { savedConfig.unrelated.externalChange = true; });
  await page.getByRole('button', { name: 'Use Hub runtime', exact: true }).click(); await idle(page);
  expect(await commands(page, 'save_config')).toEqual([]);
  expect(await page.evaluate(() => savedConfig.unrelated.externalChange)).toBe(true);
  await expect(field(page, 'error')).toContainText('Your settings changed');
  await controlsLocked(page, true);
  await field(page, 'save').dispatchEvent('click'); await idle(page);
  expect(await commands(page, 'save_config')).toEqual([]);
});

test('runtime repair readback failure locks stale controls without replaying the save', async ({ page }) => {
  await open(page, { runtime: { bundled: true, command: 'C:/Hub/mcp/server/runtime/node.exe' } });
  await page.evaluate(() => { window.failNextReadback = true; });
  await field(page, 'repair-runtime').click();
  await page.getByRole('button', { name: 'Use Hub runtime', exact: true }).click(); await idle(page);
  await controlsLocked(page, true);
  expect((await commands(page, 'save_config')).length).toBe(1);
  expect(await commands(page, 'review_product_settings')).toEqual([]);
  await field(page, 'save').dispatchEvent('click'); await idle(page);
  expect((await commands(page, 'save_config')).length).toBe(1);
  expect(await page.evaluate(() => savedConfig.mcp_server_path)).toBe('C:/Hub/mcp/server/creator-works-mcp.mjs');
});

test('completed history from another settings location is disclosed but never offered for resume', async ({ page }) => {
  await open(page, { productRecovery: [{ journal: '/retained/preview-history', files: [],
    completed: false, historical_completed: true, history_only: true }] });
  await controlsLocked(page, false);
  await expect(field(page, 'product-evidence')).toContainText('completed history from another settings location; read-only');
  await expect(field(page, 'product-status')).toHaveText('Your current MCP settings are ready.');
  await field(page, 'recover').dispatchEvent('click');
  expect(await commands(page, 'recover_client_connection')).toEqual([]);
  expect(await commands(page, 'review_product_settings')).toEqual([]);
  expect(await commands(page, 'save_config')).toEqual([]);
});

test('an unfinished settings journal still locks the form without implicit review or writes', async ({ page }) => {
  await open(page, { productRecovery: [{ journal: '/retained/unfinished', files: [],
    completed: false, historical_completed: false, history_only: false }] });
  await controlsLocked(page, true);
  await expect(field(page, 'product-status')).toContainText('An earlier settings change did not finish');
  expect(await mutationCalls(page)).toEqual([]);
});
async function recoveryPanel(page) { await page.getByText('Existing client connections and recovery', { exact: true }).click(); }
const record = (id = 'a') => ({ clients: ['codex'], clientName: 'Codex', central: false, operation: id.repeat(64), canResume: true, message: 'Review required' });

test('recent project is a draft, not a saved selection; navigation preserves drafts and checks without writes', async ({ page }) => {
  await open(page);
  await field(page, 'discovered').selectOption('/projects/Other'); await idle(page);
  await expect(field(page, 'selection')).toContainText('Selected for MCP: Creator');
  await expect(field(page, 'selection')).toContainText('Setup draft: /projects/Other (not selected for MCP)');
  await expect(field(page, 'checked-project')).toHaveText('Checked project: /projects/Other');
  await expect(row(page, 'Creator')).toHaveAttribute('data-selected', 'true');
  await expect(page.getByRole('button', { name: 'Apply to Codex', exact: true })).toBeDisabled();
  await page.locator('[data-client="claude"]').uncheck();
  await page.getByText('Advanced settings', { exact: true }).click();
  await field(page, 'server').fill('/draft/server.mjs'); await field(page, 'groups').selectOption('read');
  await field(page, 'follow').uncheck(); await field(page, 'scripts').check(); await field(page, 'tests').uncheck();
  const calls = await page.evaluate(() => window.calls.length);
  await navigateBack(page);
  expect(await page.evaluate(() => window.calls.length)).toBe(calls);
  await expect(field(page, 'project')).toHaveValue('/projects/Other');
  await expect(field(page, 'discovered')).toHaveValue('/projects/Other');
  await expect(page.locator('[data-client="claude"]')).not.toBeChecked();
  await expect(field(page, 'server')).toHaveValue('/draft/server.mjs');
  await expect(field(page, 'groups')).toHaveValue('read');
  await expect(field(page, 'follow')).not.toBeChecked(); await expect(field(page, 'scripts')).toBeChecked(); await expect(field(page, 'tests')).not.toBeChecked();
  expect(await commands(page, 'save_config')).toEqual([]);
});

for (const fail of ['discover_unity_projects', 'get_onboarding_status']) test(`initial ${fail} failure has an explicit read-only retry`, async ({ page }) => {
  await open(page, { fail });
  await expect(field(page, 'retry')).toBeVisible(); await controlsLocked(page, true);
  expect(await mutationCalls(page)).toEqual([]);
  await field(page, 'retry').click(); await controlsLocked(page, false);
  await expect(field(page, 'retry')).toBeHidden();
  expect((await commands(page, fail)).length).toBe(2);
  expect(await mutationCalls(page)).toEqual([]);
});

test('failed or malformed checks discard prior readiness and can be retried without mutation', async ({ page }) => {
  await open(page);
  for (const malformed of [false, true]) {
    await page.evaluate(malformed => { window.invalidStatus = malformed; window.failNext = malformed ? null : 'get_onboarding_status'; }, malformed);
    await field(page, 'check').click(); await idle(page);
    await expect(field(page, 'error')).toContainText(malformed ? 'Connection status is incomplete' : 'get_onboarding_status');
    await expect(field(page, 'checks')).not.toContainText('Connected');
    await expect(field(page, 'checked-project')).toHaveText('Not checked: /projects/Creator');
    await expect(field(page, 'setup')).toBeDisabled(); await expect(field(page, 'bridge')).toBeDisabled();
    await expect(field(page, 'feedback-save')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Apply to Codex', exact: true })).toBeDisabled();
    await page.evaluate(() => { window.invalidStatus = false; });
    await field(page, 'check').click(); await expect(field(page, 'setup')).toBeEnabled();
  }
  expect(await commands(page, 'save_config')).toEqual([]);
});

test('a late A-to-B-to-A status response cannot restore invalidated readiness', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.hold = 'get_onboarding_status'; });
  await field(page, 'check').click(); await page.waitForFunction(() => pending.get_onboarding_status);
  await field(page, 'project').evaluate(input => {
    for (const path of ['/projects/Other', '/projects/Creator']) { input.value = path; input.dispatchEvent(new Event('input')); }
  });
  await page.evaluate(() => { window.hold = null; pending.get_onboarding_status(); }); await idle(page);
  await expect(field(page, 'setup')).toBeDisabled();
  await expect(field(page, 'checked-project')).toHaveText('Not checked: /projects/Creator');
  expect((await commands(page, 'get_project_feedback_settings')).length).toBe(1);
  await field(page, 'check').click(); await expect(field(page, 'setup')).toBeEnabled();
});

test('the native no-project null response remains a usable read-only state', async ({ page }) => {
  await open(page);
  await field(page, 'project').fill(''); await field(page, 'check').click(); await idle(page);
  await controlsLocked(page, false); await expect(field(page, 'error')).toBeHidden();
  await expect(field(page, 'checked-project')).toHaveText('Checked project: None');
  await expect(field(page, 'checks')).not.toContainText('Not installed');
  await expect(field(page, 'setup')).toBeDisabled(); await expect(field(page, 'feedback-save')).toBeDisabled();
  expect((await commands(page, 'get_project_feedback_settings')).length).toBe(1);
  expect(await mutationCalls(page)).toEqual([]);
});

for (const fail of ['get_onboarding_status', 'update_codex_mcp_config']) test(`saved selection remains visible when subsequent ${fail} fails`, async ({ page }) => {
  await open(page);
  await page.evaluate(fail => { window.failNext = fail; }, fail);
  await page.getByRole('button', { name: 'Select Other for MCP', exact: true }).click(); await idle(page);
  await expect(field(page, 'error')).toContainText(fail);
  await expect(row(page, 'Other')).toHaveAttribute('data-selected', 'true');
  await expect(row(page, 'Creator')).toHaveAttribute('data-selected', 'false');
  await expect(field(page, 'selection')).toContainText('Selected for MCP: Other');
  await expect(field(page, 'discovered')).toHaveValue('/projects/Other');
  const saved = await page.evaluate(() => window.savedConfig);
  expect(saved.active_channel_id).toBe('1'); expect(saved.channels).toHaveLength(2);
  expect(saved.unrelated).toEqual({ retain: ['exact', 'values'] });
  const calls = await page.evaluate(() => window.calls.length);
  await navigateBack(page); expect(await page.evaluate(() => window.calls.length)).toBe(calls);
  await expect(field(page, 'error')).toContainText(fail);
});

test('bridge read failure retries through one read-only refresh and never installs a bridge', async ({ page }) => {
  await open(page, { fail: 'get_unity_extension_status' });
  await expect(row(page, 'Creator')).toContainText('Bridge not checked');
  await expect(row(page, 'Other')).toContainText('Bridge update available');
  await page.evaluate(() => { window.hold = 'get_onboarding_status'; });
  await field(page, 'check').click(); await page.waitForFunction(() => pending.get_onboarding_status);
  await field(page, 'check').dispatchEvent('click');
  await page.evaluate(() => { window.hold = null; pending.get_onboarding_status(); }); await idle(page);
  await expect(row(page, 'Creator')).toContainText('Bridge current');
  await expect(row(page, 'Other')).toContainText('Bridge update available');
  expect((await commands(page, 'get_unity_extension_status')).length).toBe(4);
  expect((await commands(page, 'get_onboarding_status')).length).toBe(2);
  expect(await commands(page, 'install_unity_extension')).toEqual([]);
  expect(await commands(page, 'update_configured_unity_extensions')).toEqual([]);
});

test('post-operation reload failure exposes retry and preserves unsaved options across retry', async ({ page }) => {
  await open(page);
  await page.getByText('Advanced settings', { exact: true }).click();
  await field(page, 'server').fill('/draft/server.mjs'); await field(page, 'groups').selectOption('read');
  await field(page, 'scripts').check(); await field(page, 'follow').uncheck(); await field(page, 'tests').uncheck();
  await recoveryPanel(page);
  await page.evaluate(() => { window.failNext = 'discover_unity_projects'; });
  await field(page, 'review').click(); await idle(page);
  await controlsLocked(page, true); await expect(field(page, 'retry')).toBeVisible();
  const beforeRetry = await mutationCalls(page);
  await field(page, 'retry').click(); await controlsLocked(page, false);
  expect(await mutationCalls(page)).toEqual(beforeRetry);
  await expect(field(page, 'server')).toHaveValue('/draft/server.mjs'); await expect(field(page, 'groups')).toHaveValue('read');
  await expect(field(page, 'scripts')).toBeChecked(); await expect(field(page, 'follow')).not.toBeChecked(); await expect(field(page, 'tests')).not.toBeChecked();
  expect((await commands(page, 'review_existing_client_connections')).length).toBe(1);
  expect(await commands(page, 'save_config')).toEqual([]);
  expect(await page.evaluate(() => savedConfig.mcp_server_path)).toBe('/private/server.mjs');
});

test('partial setup failure requires readback instead of replaying setup or overwriting saved selection', async ({ page }) => {
  await open(page, { partialSetup: true });
  await field(page, 'discovered').selectOption('/projects/Other'); await idle(page);
  await field(page, 'setup').click(); await page.getByRole('button', { name: 'Apply setup', exact: true }).click(); await idle(page);
  await expect(field(page, 'error')).toContainText('earlier steps remain');
  await controlsLocked(page, true); await expect(field(page, 'retry')).toBeVisible();
  const beforeRetry = await mutationCalls(page);
  await navigateBack(page);
  await controlsLocked(page, true);
  expect(await mutationCalls(page)).toEqual(beforeRetry);
  expect((await commands(page, 'one_click_setup')).length).toBe(1);
  await field(page, 'retry').click(); await controlsLocked(page, false);
  expect(await mutationCalls(page)).toEqual(beforeRetry);
  await expect(row(page, 'Other')).toHaveAttribute('data-selected', 'true');
  expect((await commands(page, 'one_click_setup')).length).toBe(1); expect(await commands(page, 'save_config')).toEqual([]);
});

test('uncertain config publication cannot be overwritten before explicit readback', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.failAfterSave = true; });
  await page.getByRole('button', { name: 'Select Other for MCP', exact: true }).click(); await idle(page);
  await expect(field(page, 'error')).toContainText('Save outcome unknown');
  await controlsLocked(page, true);
  const beforeRetry = await mutationCalls(page);
  await page.evaluate(() => { window.hold = 'load_config'; });
  await field(page, 'retry').click(); await page.waitForFunction(() => pending.load_config);
  await controlsLocked(page, true);
  expect(await mutationCalls(page)).toEqual(beforeRetry);
  await page.evaluate(() => { window.failNext = 'load_config'; window.hold = null; pending.load_config(); }); await idle(page);
  await expect(field(page, 'product-diagnostic')).toContainText('load_config');
  await controlsLocked(page, true); await expect(field(page, 'retry')).toBeVisible();
  expect(await mutationCalls(page)).toEqual(beforeRetry);
  await field(page, 'retry').click(); await controlsLocked(page, false);
  expect(await mutationCalls(page)).toEqual(beforeRetry);
  expect((await commands(page, 'load_config')).length).toBe(3);
  await expect(row(page, 'Other')).toHaveAttribute('data-selected', 'true');
  expect((await commands(page, 'save_config')).length).toBe(1);
  expect(await commands(page, 'update_codex_mcp_config')).toEqual([]);
});

for (const [command, fieldName, key, enabled] of [
  ['set_unity_custom_scripts', 'scripts', 'enable_custom_scripts', true],
  ['set_unity_allow_all_tests', 'tests', 'allow_all_tests', false],
]) test(`Save options retries failed ${command} despite already persisted config`, async ({ page }) => {
  await open(page);
  await page.getByText('Advanced settings', { exact: true }).click();
  await field(page, fieldName).setChecked(enabled);
  await page.evaluate(command => { window.failNext = command; }, command);
  await field(page, 'save').click(); await idle(page);
  expect(await page.evaluate(key => savedConfig[key], key)).toBe(enabled);
  expect(await page.evaluate(key => unityOptions['/projects/Creator'][key], key)).not.toBe(enabled);
  await expect(field(page, 'setup-result')).toContainText('Unity options are not fully confirmed');
  await navigateBack(page);
  expect((await commands(page, command)).length).toBe(1);
  await field(page, 'save').click(); await idle(page);
  expect((await commands(page, command)).length).toBe(2);
  expect(await page.evaluate(key => unityOptions['/projects/Creator'][key], key)).toBe(enabled);
  await expect(field(page, 'setup-result')).toContainText('Options saved');
  expect((await commands(page, command === 'set_unity_custom_scripts' ? 'set_unity_allow_all_tests' : 'set_unity_custom_scripts')).length).toBe(1);
});

for (const failed of ['set_unity_custom_scripts', 'set_unity_allow_all_tests']) test(`remount with persisted config reasserts unknown Unity flags after ${failed} failure`, async ({ page }) => {
  await open(page, { config: { auto_start: false } });
  expect(await mutationCalls(page)).toEqual([]);
  await page.getByText('Advanced settings', { exact: true }).click();
  await field(page, 'scripts').check(); await field(page, 'tests').uncheck();
  await page.evaluate(failed => { window.failNext = failed; }, failed);
  await field(page, 'save').click(); await idle(page);
  expect(await page.evaluate(() => ({ scripts: savedConfig.enable_custom_scripts, tests: savedConfig.allow_all_tests })))
    .toEqual({ scripts: true, tests: false });
  const failedKey = failed === 'set_unity_custom_scripts' ? 'enable_custom_scripts' : 'allow_all_tests';
  expect(await page.evaluate(key => unityOptions['/projects/Creator'][key], failedKey))
    .toBe(failedKey === 'allow_all_tests');
  const beforeRemount = await mutationCalls(page);
  expect(await page.evaluate(() => CreatorFeaturePages.dispose())).toBe(true);
  await page.evaluate(() => CreatorFeaturePages.show('mcp')); await idle(page);
  await expect(field(page, 'scripts')).toBeChecked(); await expect(field(page, 'tests')).not.toBeChecked();
  expect(await mutationCalls(page)).toEqual(beforeRemount);
  await navigateBack(page);
  expect(await mutationCalls(page)).toEqual(beforeRemount);
  await page.getByText('Advanced settings', { exact: true }).click();
  const scriptsBefore = (await commands(page, 'set_unity_custom_scripts')).length;
  const testsBefore = (await commands(page, 'set_unity_allow_all_tests')).length;
  await field(page, 'save').click(); await idle(page);
  expect((await commands(page, 'set_unity_custom_scripts')).length).toBe(scriptsBefore + 1);
  expect((await commands(page, 'set_unity_allow_all_tests')).length).toBe(testsBefore + 1);
  expect(await page.evaluate(() => unityOptions['/projects/Creator']))
    .toEqual({ enable_custom_scripts: true, allow_all_tests: false });
  await expect(field(page, 'setup-result')).toContainText('Options saved');
  await field(page, 'save').click(); await idle(page);
  expect((await commands(page, 'set_unity_custom_scripts')).length).toBe(scriptsBefore + 1);
  expect((await commands(page, 'set_unity_allow_all_tests')).length).toBe(testsBefore + 1);
});

test('partial Unity option success retries only unfinished work after readback', async ({ page }) => {
  await open(page);
  await page.getByText('Advanced settings', { exact: true }).click();
  await field(page, 'scripts').check(); await field(page, 'tests').uncheck();
  await page.evaluate(() => { window.failNext = 'set_unity_allow_all_tests'; });
  await field(page, 'save').click(); await idle(page);
  expect(await page.evaluate(() => unityOptions['/projects/Creator'])).toEqual({ enable_custom_scripts: true, allow_all_tests: true });
  expect((await commands(page, 'set_unity_custom_scripts')).length).toBe(1);
  expect((await commands(page, 'set_unity_allow_all_tests')).length).toBe(1);
  await recoveryPanel(page); await field(page, 'review').click(); await idle(page);
  expect((await commands(page, 'set_unity_allow_all_tests')).length).toBe(1);
  await field(page, 'save').click(); await idle(page);
  expect((await commands(page, 'set_unity_custom_scripts')).length).toBe(1);
  expect((await commands(page, 'set_unity_allow_all_tests')).length).toBe(2);
  expect(await page.evaluate(() => unityOptions['/projects/Creator'])).toEqual({ enable_custom_scripts: true, allow_all_tests: false });
  await field(page, 'save').click(); await idle(page);
  expect((await commands(page, 'set_unity_custom_scripts')).length).toBe(1);
  expect((await commands(page, 'set_unity_allow_all_tests')).length).toBe(2);
});

test('an uncertain Unity setter outcome stays pending until explicitly reasserted', async ({ page }) => {
  await open(page);
  await page.getByText('Advanced settings', { exact: true }).click();
  await field(page, 'scripts').check();
  await page.evaluate(() => { window.unityFailAfter = 'set_unity_custom_scripts'; });
  await field(page, 'save').click(); await idle(page);
  expect(await page.evaluate(() => unityOptions['/projects/Creator'].enable_custom_scripts)).toBe(true);
  await expect(field(page, 'error')).toContainText('Unity write outcome unknown');
  await expect(field(page, 'setup-result')).not.toContainText('Options saved');
  await field(page, 'save').click(); await idle(page);
  expect((await commands(page, 'set_unity_custom_scripts')).length).toBe(2);
  await expect(field(page, 'setup-result')).toContainText('Options saved');
});

test('failed flag changes invalidate prior success even when the retry returns to its old value', async ({ page }) => {
  await open(page);
  await page.getByText('Advanced settings', { exact: true }).click();
  await field(page, 'save').click(); await idle(page);
  await field(page, 'scripts').check();
  await page.evaluate(() => { window.unityFailAfter = 'set_unity_custom_scripts'; });
  await field(page, 'save').click(); await idle(page);
  expect(await page.evaluate(() => unityOptions['/projects/Creator'].enable_custom_scripts)).toBe(true);
  await field(page, 'scripts').uncheck(); await field(page, 'save').click(); await idle(page);
  expect((await commands(page, 'set_unity_custom_scripts')).map(call => call.args.args.enabled))
    .toEqual([false, true, false]);
  expect((await commands(page, 'set_unity_allow_all_tests')).length).toBe(1);
  expect(await page.evaluate(() => unityOptions['/projects/Creator'].enable_custom_scripts)).toBe(false);
});

test('pending Unity option work stays with its project and honors a changed retry value', async ({ page }) => {
  await open(page);
  await page.getByText('Advanced settings', { exact: true }).click();
  await field(page, 'scripts').check();
  await page.evaluate(() => { window.failNext = 'set_unity_custom_scripts'; });
  await field(page, 'save').click(); await idle(page);
  await page.getByRole('button', { name: 'Select Other for MCP', exact: true }).click(); await idle(page);
  expect((await commands(page, 'set_unity_custom_scripts')).length).toBe(1);
  expect(await commands(page, 'set_unity_allow_all_tests')).toEqual([]);
  await field(page, 'save').click(); await idle(page);
  expect((await commands(page, 'set_unity_custom_scripts')).length).toBe(2);
  await page.getByRole('button', { name: 'Select Creator for MCP', exact: true }).click(); await idle(page);
  await field(page, 'scripts').uncheck(); await field(page, 'save').click(); await idle(page);
  const writes = await commands(page, 'set_unity_custom_scripts');
  expect(writes.map(call => call.args.args)).toEqual([
    { unityProjectPath: '/projects/Creator', enabled: true },
    { unityProjectPath: '/projects/Other', enabled: true },
    { unityProjectPath: '/projects/Creator', enabled: false },
  ]);
  expect(await page.evaluate(() => unityOptions['/projects/Creator'].enable_custom_scripts)).toBe(false);
});

test('pending Unity writes cannot replay after workflow release poisons the page', async ({ page }) => {
  await open(page);
  await page.getByText('Advanced settings', { exact: true }).click();
  await field(page, 'scripts').check(); await field(page, 'tests').uncheck();
  await page.evaluate(() => { window.failures = { set_unity_allow_all_tests: 1, finish_ui_operation: 1 }; });
  await field(page, 'save').click(); await idle(page);
  await controlsLocked(page, true);
  await expect(field(page, 'error')).toContainText('Operation state is unknown');
  const before = await mutationCalls(page);
  await navigateBack(page);
  await field(page, 'save').dispatchEvent('click'); await idle(page);
  expect(await mutationCalls(page)).toEqual(before);
  expect((await commands(page, 'set_unity_custom_scripts')).length).toBe(1);
  expect((await commands(page, 'set_unity_allow_all_tests')).length).toBe(1);
  expect(await page.evaluate(() => unityOptions['/projects/Creator'].allow_all_tests)).toBe(true);
});

test('declined partial settings recovery retains truthful wording, lock and safe exit', async ({ page }) => {
  await open(page, { productStatus: 'conflict', partialProductReview: true, productReviewResult: {
    status: 'conflict', approved: false, backups: ['/retained/exact-backup'], recovery: [
      { journal: '/retained/completed', historical_completed: true, files: [] },
      { journal: '/retained/declined', historical_completed: false, files: [] },
    ],
  } });
  await field(page, 'product-review').click(); await idle(page);
  expect(await page.evaluate(() => savedConfig.unrelated.recovered)).toBe(true);
  await expect(field(page, 'product-status')).toContainText('Earlier completed changes may remain');
  await expect(field(page, 'product-status')).not.toContainText('Nothing changed');
  await controlsLocked(page, true); await expect(field(page, 'product-review')).toBeEnabled();
  expect(await commands(page, 'load_config')).toEqual([]);
  expect(await commands(page, 'save_config')).toEqual([]);
  await page.evaluate(() => { window.addEventListener('creator-feature-home', () => { window.homeRequested = true; }); });
  await field(page, 'product-later').click();
  expect(await page.evaluate(() => homeRequested)).toBe(true);
  expect((await commands(page, 'review_product_settings')).length).toBe(1);
});

test('saved-settings failures retain only raw diagnostics in closed technical details', async ({ page }) => {
  await open(page, { fail: 'load_config' });
  await expect(field(page, 'product-diagnostic')).toHaveText('Error: Fixture failure: load_config');
  await expect(field(page, 'product-diagnostic')).not.toBeVisible();
  await expect(field(page, 'product-details')).not.toHaveAttribute('open');
  await field(page, 'product-details').locator('summary').click();
  await page.evaluate(() => { window.failNext = 'review_product_settings'; });
  await field(page, 'product-review').click(); await idle(page);
  await expect(field(page, 'product-diagnostic')).toHaveText('Error: Fixture failure: review_product_settings');
  await expect(field(page, 'product-details')).not.toHaveAttribute('open');
  await expect(field(page, 'error')).toHaveText('Your saved setup could not be checked. Try Check connection again, or return Home for now.');
  await controlsLocked(page, true);
});

test('feedback failures keep a clear explanation and collapse raw read and write diagnostics', async ({ page }) => {
  await open(page, { fail: 'get_project_feedback_settings' });
  const error = field(page, 'feedback-error');
  await expect(error.locator(':scope > p')).toHaveText('Feedback preferences could not be checked. Try Check project feedback again.');
  await expect(error.locator('details')).not.toHaveAttribute('open');
  await expect(error.locator('details p')).toHaveText('Error: Fixture failure: get_project_feedback_settings');
  await expect(error.locator('details p')).not.toBeVisible();
  await field(page, 'feedback-check').click(); await idle(page);
  await expect(error).toBeHidden();
  await field(page, 'feedback-enabled').check();
  await page.evaluate(() => { window.failNext = 'set_project_feedback_settings'; });
  await field(page, 'feedback-save').click(); await idle(page);
  await expect(error.locator(':scope > p')).toContainText('Check them before saving again');
  await expect(error.locator('details')).not.toHaveAttribute('open');
  await expect(error.locator('details p')).toHaveText('Error: Fixture failure: set_project_feedback_settings');
  await expect(error.locator('details p')).not.toBeVisible();
  await expect(field(page, 'feedback-save')).toBeDisabled();
});

test('guide workflow failure shows restart guidance without concatenated diagnostic copy', async ({ page }) => {
  await open(page, { config: { connection_guide_version: 0 } });
  await expect(field(page, 'guide-dialog')).toBeVisible();
  await page.evaluate(() => { window.failNext = 'finish_ui_operation'; });
  await field(page, 'guide-skip').click(); await idle(page);
  const error = field(page, 'guide-error');
  await expect(error.locator(':scope > p')).toHaveText('Close and reopen Hub before continuing. Earlier completed changes are kept.');
  await expect(error.locator('details')).not.toHaveAttribute('open');
  await expect(error.locator('details p')).toHaveText('Operation state is unknown. Restart Hub before continuing. Error: Fixture failure: finish_ui_operation');
  await expect(error.locator('details p')).not.toBeVisible();
  await controlsLocked(page, true);
  await field(page, 'guide-skip').click(); await idle(page);
  expect((await commands(page, 'save_config')).length).toBe(1);
});

for (const invalid of [null, [null], [{ ...record(), clients: ['../../settings'] }]]) test(`invalid recovery DTO clears old eligibility: ${JSON.stringify(invalid)}`, async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  await open(page, { recovery: [record()] }); await recoveryPanel(page);
  await field(page, 'recovery-check').click(); await expect(field(page, 'recover')).toBeEnabled();
  await page.evaluate(invalid => { window.recoveryRecords = invalid; }, invalid);
  await field(page, 'recovery-check').click(); await idle(page);
  await expect(field(page, 'error')).toContainText('Recovery response is invalid');
  await expect(field(page, 'recover')).toBeDisabled();
  await field(page, 'recover').dispatchEvent('click'); await idle(page);
  expect(await commands(page, 'recover_client_connection')).toEqual([]); expect(errors).toEqual([]);
});

test('failed recovery read discards stale resume eligibility, preserves its error and retries only on request', async ({ page }) => {
  await open(page, { recovery: [record()] }); await recoveryPanel(page);
  await field(page, 'recovery-check').click(); await expect(field(page, 'recover')).toBeEnabled();
  await page.evaluate(() => { window.failNext = 'pending_client_recovery'; });
  await field(page, 'recovery-check').click(); await idle(page);
  await expect(field(page, 'recover')).toBeDisabled();
  await expect(field(page, 'recovery')).toContainText('Could not inspect interrupted changes');
  await navigateBack(page);
  expect((await commands(page, 'pending_client_recovery')).length).toBe(2);
  await expect(field(page, 'error')).toContainText('pending_client_recovery');
  await field(page, 'recovery-check').click(); await expect(field(page, 'recover')).toBeEnabled();
  expect(await commands(page, 'recover_client_connection')).toEqual([]);
});

test('failed recovery operation rechecks eligibility without replay or retaining a stale queue', async ({ page }) => {
  await open(page, { recovery: [record()] }); await recoveryPanel(page);
  await field(page, 'recovery-check').click(); await expect(field(page, 'recover')).toBeEnabled();
  await page.evaluate(() => { window.recoveryFails = true; });
  await field(page, 'recover').click(); await idle(page);
  await expect(field(page, 'error')).toContainText('Recovery outcome unknown');
  await expect(field(page, 'recover')).toBeDisabled();
  await expect(field(page, 'recovery')).toContainText('No interrupted client changes found');
  expect((await commands(page, 'pending_client_recovery')).length).toBe(2);
  expect((await commands(page, 'recover_client_connection')).length).toBe(1);
  await navigateBack(page);
  expect((await commands(page, 'recover_client_connection')).length).toBe(1);
});

test('recovery operation failure and failed readback both remain visible without stale eligibility', async ({ page }) => {
  await open(page, { recovery: [record()] }); await recoveryPanel(page);
  await field(page, 'recovery-check').click(); await expect(field(page, 'recover')).toBeEnabled();
  await page.evaluate(() => { window.recoveryFails = true; window.recoveryReadFails = true; });
  await field(page, 'recover').click(); await idle(page);
  await expect(field(page, 'error')).toContainText('Recovery outcome unknown');
  await expect(field(page, 'error')).toContainText('pending_client_recovery');
  await expect(field(page, 'recover')).toBeDisabled();
  expect((await commands(page, 'recover_client_connection')).length).toBe(1);
});

for (const width of [1100, 320]) test(`selection and project status text remain within the page at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 }); await open(page);
  await field(page, 'discovered').selectOption('/projects/Other'); await idle(page);
  await page.evaluate(() => document.fonts.ready);
  const fullPage = testInfo.outputPath(`direct-mcp-${width}-full-page.png`);
  const selection = testInfo.outputPath(`direct-mcp-${width}-selection.png`);
  await page.screenshot({ path: fullPage, fullPage: true });
  await testInfo.attach(`MCP ${width}px full page`, { path: fullPage, contentType: 'image/png' });
  await field(page, 'selection').screenshot({ path: selection });
  await testInfo.attach(`MCP ${width}px selection summary`, { path: selection, contentType: 'image/png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const name of ['selection', 'checked-project', 'projects']) {
    expect(await field(page, name).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  expect(await mutationCalls(page)).toEqual([]);
});
