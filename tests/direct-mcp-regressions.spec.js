const { test, expect } = require('@playwright/test');

// Mock the native boundary only. Never start MCP/Unity or read installed settings.
async function open(page, options = {}) {
  await page.route('**/app.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.addInitScript(options => {
    localStorage.setItem('creator-usage-terms.hub', JSON.stringify({ policyVersion: '2026-09-28-v1', acceptedAt: '2026-09-28T00:00:00Z' }));
    window.__CREATOR_HUB_FEATURE_PROTOCOL__ = 1;
    window.calls = []; window.pending = {}; window.failNext = options.fail || null;
    const channels = ['Creator', 'Other'].map((name, index) => ({ id: String(index), name, unity_project_path: `/projects/${name}`, enabled: true }));
    window.savedConfig = { channels, active_channel_id: '0', mcp_server_path: '/private/server.mjs', tool_groups: 'core',
      auto_start: true, enable_custom_scripts: false, allow_all_tests: true, connection_guide_version: 1,
      unrelated: { retain: ['exact', 'values'] } };
    window.bridgeStatuses = { '/projects/Creator': { installed: true, current: true }, '/projects/Other': { installed: true, current: false } };
    window.recoveryRecords = options.recovery || [];
    const profile = { profile: 'creator', label: 'Creator SDK', packages: [] };
    const report = { status: 'current', backups: [], recovery: [] };
    window.__TAURI__ = {
      event: { listen: async () => () => {} },
      core: { invoke: async (command, args = {}) => {
        window.calls.push({ command, args: structuredClone(args) });
        if (command === 'feature_status') return { integrated: true, features: ['mcp', 'setup'] };
        if (command !== 'feature_call' || args.feature !== 'mcp') throw new Error(`Unexpected outer command: ${command}`);
        const { command: name, args: fields } = args;
        if (window.hold === name) await new Promise(resolve => { window.pending[name] = resolve; });
        if (window.failNext === name) { window.failNext = null; throw new Error(`Fixture failure: ${name}`); }
        switch (name) {
          case 'begin_ui_operation': return 17;
          case 'finish_ui_operation': return null;
          case 'product_settings_status': return report;
          case 'review_product_settings': return { ...report, approved: true };
          case 'load_config': return structuredClone(window.savedConfig);
          case 'save_config':
            window.savedConfig = structuredClone(fields.config);
            if (window.failAfterSave) { window.failAfterSave = false; throw new Error('Save outcome unknown after publication'); }
            return null;
          case 'discover_unity_projects': return channels.map(channel => ({ name: channel.name, path: channel.unity_project_path }));
          case 'get_onboarding_status': return window.invalidStatus ? { runtime: { ready: true }, clients: [] } : {
            managedRouting: true, runtime: { ready: true },
            project: fields.unityProjectPath ? { valid: true, bridgeInstalled: true, bridgeCurrent: true, stateStatus: 'fresh', sdkProfile: profile } : null,
            clients: ['codex', 'claude', 'claudeDesktop', 'antigravity', 'opencode'].map(id => ({ id, detected: true, configured: true, supported: true })),
            unityCli: { canEnable: true, enabled: false, message: 'Optional Unity CLI' },
          };
          case 'get_unity_extension_status': return window.bridgeStatuses[fields.unityProjectPath];
          case 'get_project_sdk_profile': return profile;
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
          case 'update_antigravity_mcp_config': case 'update_opencode_mcp_config':
          case 'set_unity_custom_scripts': case 'set_unity_allow_all_tests': return null;
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
async function controlsLocked(page, locked) {
  // Fieldsets own the lock; inherited disabled semantics apply to their controls.
  await expect(field(page, 'controls')).toHaveJSProperty('disabled', locked);
  for (const name of ['project', 'check']) {
    if (locked) await expect(field(page, name)).toBeDisabled();
    else await expect(field(page, name)).toBeEnabled();
  }
}
async function navigateBack(page) { await page.evaluate(async () => { CreatorFeaturePages.hide(); await CreatorFeaturePages.show('mcp'); }); }
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
  await expect(field(page, 'error')).toContainText('load_config');
  await controlsLocked(page, true); await expect(field(page, 'retry')).toBeVisible();
  expect(await mutationCalls(page)).toEqual(beforeRetry);
  await field(page, 'retry').click(); await controlsLocked(page, false);
  expect(await mutationCalls(page)).toEqual(beforeRetry);
  expect((await commands(page, 'load_config')).length).toBe(3);
  await expect(row(page, 'Other')).toHaveAttribute('data-selected', 'true');
  expect((await commands(page, 'save_config')).length).toBe(1);
  expect(await commands(page, 'update_codex_mcp_config')).toEqual([]);
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
