const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const prior = overrides => ({ schemaVersion: 1, outcome: 'legacy-review-required', route: 'verified-prior', targetVersion: '0.1.17',
  intentSha256: null, targetExecutableSha256: null, handoffPath: null, expectedGeneration: 'b'.repeat(64), activeGeneration: 'a'.repeat(64),
  reason: 'The previous updater supplied no approved handoff. Existing connections were kept.', recovery: 'explicit-client-apply', ...overrides });
const unknown = overrides => prior({ outcome: 'review-required', route: 'unknown', activeGeneration: null, recovery: 'read-only-recheck', ...overrides });
const target = () => prior({ outcome: 'known-committed', route: 'verified-target', recovery: 'none', activeGeneration: 'b'.repeat(64), reason: null });
const rootNotice = page => page.locator('#hub-mcp-route-update');
const mcpNotice = page => page.locator('#feature-mcp [data-field="route-update"]');
async function load(page, options = {}) {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  if (process.env.CREATOR_OWNED_UI_SRC) await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4188') return route.abort();
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const directory = path.resolve(process.env.CREATOR_OWNED_UI_SRC), file = path.resolve(directory, '.' + relative);
    if (!file.startsWith(directory + path.sep)) return route.abort();
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
    try { return await route.fulfill({ body: fs.readFileSync(file), contentType: mime[path.extname(file)] || 'application/octet-stream' }); }
    catch { return route.fulfill({ status: 404, body: 'Not found' }); }
  });
  await page.addInitScript(options => {
    localStorage.setItem('creator-usage-terms.hub', JSON.stringify({ policyVersion: '2026-09-28-v1', acceptedAt: '2026-10-27T00:00:00Z' }));
    localStorage.setItem('creator-hub.preview', 'false'); localStorage.setItem('creator-hub.auto-download', 'false');
    window.__CREATOR_HUB_FEATURE_PROTOCOL__ = 1;
    window.calls = []; window.events = {}; window.routeStatus = options.route;
    const channel = { id: 'one', name: 'Saved project', unity_project_path: '/projects/Saved', enabled: true };
    window.savedConfig = { channels: [channel], active_channel_id: 'one', mcp_server_path: '/private/server.mjs', tool_groups: 'core',
      auto_start: true, enable_custom_scripts: false, allow_all_tests: true, connection_guide_version: 1 };
    const profile = { profile: 'creator', label: 'Creator SDK', packages: [] };
    window.__TAURI__ = { event: { listen: async (name, callback) => { window.events[name] = callback; return () => {}; } }, core: { invoke: async (command, args = {}) => {
      window.calls.push({ command, args: structuredClone(args) });
      if (command === 'app_inventory') return { supported: true, apps: ['mcp', 'setup'].map(app => ({ app, builtIn: true, installed: true, trusted: true, hostedCompatible: true, hostedPreview: 'writable', installedVersion: app === 'mcp' ? '2.7.7' : '0.3.7' })) };
      if (command === 'hub_update_status') {
        if (window.failRouteRead) throw Error('Route status could not be read.');
        if (window.holdRouteRead) await new Promise(resolve => { window.finishRouteRead = resolve; });
        return { currentVersion: '0.1.17', availableVersion: null, downloaded: false,
          ...(window.omitRoute ? {} : { mcpRouteUpdate: structuredClone(window.routeStatus) }) };
      }
      if (command === 'get_launch_request') return { view: 'hub', revision: 0 };
      if (command === 'feature_select' || command === 'complete_hosted_restore') return null;
      if (command === 'pending_hosted_restore') return [];
      if (command === 'project_inventory') return { projects: [], warnings: [] };
      if (command === 'community_catalogue') return { entries: [], warnings: [], stale: false };
      if (command === 'feature_status') return { integrated: true, features: ['mcp', 'setup'] };
      if (command !== 'feature_call') throw Error('Unexpected Root call: ' + command);
      switch (args.command) {
        case 'begin_ui_operation': return 7;
        case 'finish_ui_operation': return null;
        case 'product_settings_status': return { status: options.productStatus || 'current', backups: [], recovery: [], currentPath: '/settings/current', legacyPath: '/settings/legacy' };
        case 'load_config': return structuredClone(window.savedConfig);
        case 'discover_unity_projects': return [{ name: 'Saved project', path: '/projects/Saved' }];
        case 'get_onboarding_status': return { managedRouting: true, runtime: { ready: true, bundled: true },
          project: { valid: true, bridgeInstalled: true, bridgeCurrent: true, stateStatus: 'fresh', sdkProfile: profile },
          clients: ['codex', 'claude', 'claudeDesktop', 'antigravity', 'opencode'].map(id => ({ id, configured: true, supported: true, detected: true })),
          unityCli: { canEnable: false, enabled: false, message: 'Unity CLI is off.' } };
        case 'get_project_feedback_settings': return { enabled: false, usageCheckIns: false, file: '/projects/Saved/.bantworks-mcp/feedback/MCP_FEEDBACK.md' };
        case 'get_unity_extension_status': return { installed: true, current: true };
        case 'get_project_sdk_profile': return profile;
        case 'update_codex_mcp_config':
          if (!options.currentAfterExplicitApply) throw Error('Explicit Apply is not enabled in this fixture.');
          window.routeStatus = structuredClone(options.currentAfterExplicitApply); return null;
        default: throw Error('Unexpected feature action: ' + args.command);
      }
    } } };
  }, options);
  await page.goto('http://127.0.0.1:4188/');
  await expect.poll(() => page.evaluate(() => calls.filter(call => call.command === 'hub_update_status').length)).toBe(2);
  return errors;
}
async function noMutations(page) {
  expect(await page.evaluate(() => calls.filter(call => ['install_hub_update', 'review_retained_hub_update', 'prepare_convergence', 'migrate_convergence_connections'].includes(call.command)
    || (call.command === 'feature_call' && !['begin_ui_operation', 'finish_ui_operation', 'product_settings_status', 'load_config', 'discover_unity_projects',
      'get_onboarding_status', 'get_project_feedback_settings', 'get_unity_extension_status', 'get_project_sdk_profile'].includes(call.args.command))))).toEqual([]);
}

test('legacy failure navigates only, remains visible outside saved-settings gate', async ({ page }) => {
  const errors = await load(page, { route: prior(), productStatus: 'legacy-only' });
  await expect(rootNotice(page)).toBeVisible(); await expect(page.locator('#hub-update-status')).toContainText('Hub 0.1.17');
  await expect(page.locator('#hub-update-warning')).toBeHidden();
  await rootNotice(page).getByRole('button', { name: 'Open MCP', exact: true }).click();
  await expect(mcpNotice(page)).toBeVisible(); await expect(page.locator('#feature-mcp [data-field="product-panel"]')).toBeVisible();
  await expect(mcpNotice(page)).toContainText('Apply to one existing AI client');
  expect(await page.evaluate(() => calls.some(call => call.args?.command === 'get_onboarding_status'))).toBe(false);
  await noMutations(page); expect(errors).toEqual([]);
});

test('Ready and unrelated successful reads do not clear a retained notice', async ({ page }) => {
  const errors = await load(page, { route: prior() });
  await rootNotice(page).getByRole('button', { name: 'Open MCP', exact: true }).click();
  await expect(page.locator('#feature-mcp [data-field="status"]')).toHaveText('Ready'); await expect(mcpNotice(page)).toBeVisible();
  await page.locator('#feature-mcp [data-field="check"]').click();
  await expect(page.locator('#feature-mcp [data-field="status"]')).toHaveText('Ready'); await expect(mcpNotice(page)).toBeVisible();
  await noMutations(page); expect(errors).toEqual([]);
});

test('unknown recheck is one offline Root status read, not setup or activation', async ({ page }) => {
  const errors = await load(page, { route: unknown() });
  await expect(rootNotice(page).getByRole('button', { name: 'Open MCP', exact: true })).toBeHidden();
  const count = await page.evaluate(() => calls.length);
  await rootNotice(page).getByRole('button', { name: 'Recheck MCP route' }).click();
  expect(await page.evaluate(start => calls.slice(start), count)).toEqual([{ command: 'hub_update_status', args: { online: false, preview: false } }]);
  await expect(rootNotice(page)).toBeVisible(); await noMutations(page); expect(errors).toEqual([]);
});

test('failed or absent status retains notice; only verified target hides it', async ({ page }) => {
  const errors = await load(page, { route: prior() });
  await page.evaluate(() => { window.failRouteRead = true; });
  await rootNotice(page).getByRole('button', { name: 'Recheck MCP route' }).click();
  await expect(rootNotice(page)).toContainText('last reported'); await expect(rootNotice(page).getByRole('button', { name: 'Open MCP', exact: true })).toBeHidden();
  await page.evaluate(() => { window.failRouteRead = false; window.omitRoute = true; });
  await rootNotice(page).getByRole('button', { name: 'Recheck MCP route' }).click(); await expect(rootNotice(page)).toContainText('No route outcome was returned');
  await page.evaluate(value => { window.omitRoute = false; window.routeStatus = value; }, target());
  await rootNotice(page).getByRole('button', { name: 'Recheck MCP route' }).click(); await expect(rootNotice(page)).toBeHidden();
  await noMutations(page); expect(errors).toEqual([]);
});

test('completion hints coalesce and only request readback after the worker boundary', async ({ page }) => {
  const errors = await load(page, { route: unknown() });
  const count = await page.evaluate(() => calls.length);
  await page.evaluate(() => { window.holdRouteRead = true; window.events['mcp-route-update-complete']({ payload: { outcome: 'activated' } }); window.events['mcp-route-update-complete']({ payload: {} }); });
  await expect.poll(() => page.evaluate(start => calls.length - start, count)).toBe(1);
  await expect(rootNotice(page)).toBeVisible();
  await page.evaluate(value => { window.routeStatus = value; window.holdRouteRead = false; window.finishRouteRead(); }, target());
  await expect(rootNotice(page)).toBeHidden(); await noMutations(page); expect(errors).toEqual([]);
});

test('malformed and hostile readbacks remain plain text with read-only recovery', async ({ page }) => {
  const errors = await load(page, { route: unknown({ reason: '<img src=x onerror="window.pwned=1"> Runtime readback unavailable.' }) });
  await expect(rootNotice(page)).toContainText('<img src=x'); expect(await rootNotice(page).locator('img, script').count()).toBe(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  await page.evaluate(() => { window.routeStatus = { schemaVersion: 99, outcome: 'activated' }; });
  await rootNotice(page).getByRole('button', { name: 'Recheck MCP route' }).click();
  await expect(rootNotice(page)).toBeVisible(); await expect(rootNotice(page).getByRole('button', { name: 'Open MCP', exact: true })).toBeHidden();
  await noMutations(page); expect(errors).toEqual([]);
});

test('verified-current clears both notices after explicit client Apply and positive Root recheck', async ({ page }) => {
  const current = prior({ outcome: 'verified-current', route: 'verified-target', recovery: 'none', activeGeneration: 'b'.repeat(64), reason: null });
  const errors = await load(page, { route: prior(), currentAfterExplicitApply: current });
  await rootNotice(page).getByRole('button', { name: 'Open MCP', exact: true }).click();
  await expect(mcpNotice(page)).toBeVisible(); await expect(page.locator('#feature-mcp [data-field="status"]')).toHaveText('Ready');
  await noMutations(page);
  const reads = await page.evaluate(() => calls.filter(call => call.command === 'hub_update_status').length);
  await page.getByRole('button', { name: 'Apply to Codex', exact: true }).click();
  await expect(page.locator('#feature-mcp [data-field="setup-result"]')).toContainText('Codex settings saved.');
  await expect(page.locator('#feature-mcp [data-field="status"]')).toHaveText('Ready');
  await expect(mcpNotice(page)).toBeVisible();
  expect(await page.evaluate(() => calls.filter(call => call.command === 'hub_update_status').length)).toBe(reads);
  expect(await page.evaluate(() => calls.filter(call => call.command === 'feature_call' && call.args.command.startsWith('update_')))).toEqual([
    { command: 'feature_call', args: { feature: 'mcp', command: 'update_codex_mcp_config', args: {
      channel: { id: 'one', name: 'Saved project', unity_project_path: '/projects/Saved', enabled: true },
      mcpServerPath: '/private/server.mjs', toolGroups: 'core' } } },
  ]);
  const count = await page.evaluate(() => calls.length);
  await mcpNotice(page).getByRole('button', { name: 'Recheck MCP route' }).click();
  await expect(mcpNotice(page)).toBeHidden(); await expect(rootNotice(page)).toBeHidden();
  expect(await page.evaluate(start => calls.slice(start), count)).toEqual([{ command: 'hub_update_status', args: { online: false, preview: false } }]);
  expect(await page.evaluate(() => calls.filter(call => ['install_hub_update', 'review_retained_hub_update', 'prepare_convergence', 'migrate_convergence_connections'].includes(call.command)
    || (call.command === 'feature_call' && !['begin_ui_operation', 'finish_ui_operation', 'product_settings_status', 'load_config', 'discover_unity_projects',
      'get_onboarding_status', 'get_project_feedback_settings', 'get_unity_extension_status', 'get_project_sdk_profile', 'update_codex_mcp_config'].includes(call.args.command))))).toEqual([]);
  expect(errors).toEqual([]);
});

test('MCP page keeps instructions and read-only recheck without redundant self-navigation', async ({ page }, testInfo) => {
  const reason = 'The route advance did not complete. The prior runtime remains verified.';
  const errors = await load(page, { route: prior({ reason }) });
  await expect(rootNotice(page).getByRole('button', { name: 'Open MCP', exact: true })).toBeVisible();
  await expect(rootNotice(page).locator('.mcp-route-title')).toHaveText('MCP update needs review');
  await expect(rootNotice(page)).toContainText('previous MCP tools');
  await expect(rootNotice(page).getByText(reason, { exact: true })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('root-1240-followup.png'), fullPage: true });
  await rootNotice(page).getByRole('button', { name: 'Open MCP', exact: true }).click();
  await expect(mcpNotice(page)).toBeVisible();
  await expect(page.locator('#feature-mcp [data-field="status"]')).toHaveText('Ready');
  await expect(mcpNotice(page).getByRole('button', { name: 'Open MCP', exact: true })).toHaveCount(0);
  await expect(mcpNotice(page)).toContainText('Check the saved project, then Apply to one existing AI client.');
  await expect(mcpNotice(page).getByRole('button', { name: 'Recheck MCP route' })).toBeVisible();
  await expect(mcpNotice(page).getByText(reason, { exact: true })).toBeHidden();
  await page.setViewportSize({ width: 320, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('mcp-320-followup.png'), fullPage: true });
  expect(await mcpNotice(page).evaluate(node => {
    const bounds = node.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth + 1;
  })).toBe(true);
  await mcpNotice(page).locator('summary').filter({ hasText: 'Update details' }).click();
  await expect(mcpNotice(page).getByText(reason, { exact: true })).toBeVisible();
  const count = await page.evaluate(() => calls.length);
  await mcpNotice(page).getByRole('button', { name: 'Recheck MCP route' }).click();
  expect(await page.evaluate(start => calls.slice(start), count)).toEqual([{ command: 'hub_update_status', args: { online: false, preview: false } }]);
  await expect(mcpNotice(page)).toBeVisible(); await noMutations(page); expect(errors).toEqual([]);
});

for (const width of [1240, 390, 320]) test(`small route notices fit Root and MCP at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  const errors = await load(page, { route: prior({ reason: 'The route advance did not complete. Retained connections were not stopped.' }) });
  await expect(rootNotice(page)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`root-${width}.png`), fullPage: true });
  await rootNotice(page).getByRole('button', { name: 'Open MCP', exact: true }).click(); await expect(mcpNotice(page)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`mcp-${width}.png`), fullPage: true });
  const layout = await mcpNotice(page).evaluate(node => {
    const rect = node.getBoundingClientRect(), copy = node.querySelector('.mcp-route-copy').getBoundingClientRect(), actions = node.querySelector('.mcp-route-actions').getBoundingClientRect();
    return { fits: rect.left >= 0 && rect.right <= innerWidth, noOverlap: copy.bottom <= actions.top || copy.right <= actions.left,
      pageFits: document.documentElement.scrollWidth <= innerWidth + 1,
      images: [...document.images].every(image => !image.complete || image.naturalWidth > 0) };
  });
  expect(layout).toEqual({ fits: true, noOverlap: true, pageFits: true, images: true });
  await noMutations(page); expect(errors).toEqual([]);
});
