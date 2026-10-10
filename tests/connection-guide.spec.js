const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const source = path.resolve(__dirname, '../modules/mcp/launcher/src');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

async function open(page, options = {}) {
  await page.route('http://127.0.0.1:4188/mcp-guide/**', route => {
    const name = new URL(route.request().url()).pathname.slice('/mcp-guide/'.length) || 'index.html';
    const file = path.resolve(source, name);
    return file.startsWith(source + path.sep) && fs.existsSync(file)
      ? route.fulfill({ contentType: mime[path.extname(file)], body: fs.readFileSync(file) }) : route.fulfill({ status: 404 });
  });
  await page.addInitScript(options => {
    localStorage.setItem('creator-usage-terms.mcp', JSON.stringify({ policyVersion: '2026-09-28-v1', acceptedAt: 'fixture' }));
    window.calls = [];
    const channel = { id: 'demo', name: 'Test project', unity_project_path: 'E:\\Test Project', enabled: true };
    const profile = { profile: 'creator', label: 'Creator SDK', packages: [] };
    let config = { channels: options.existing ? [channel] : [], active_channel_id: options.existing ? 'demo' : null,
      mcp_server_path: 'E:\\Private\\server.mjs', tool_groups: 'core', auto_start: true, enable_custom_scripts: false,
      allow_all_tests: true, connection_guide_version: options.seen ? 1 : 0,
      ...(options.cliPreviouslyEnabled ? { unity_cli_enabled: true, unity_cli_consent_version: 'unity-cli-experimental-v1' } : {}) };
    const clients = ['codex', 'claude', 'claudeDesktop', 'antigravity', 'opencode'].map(id => ({ id,
      name: ({ codex: 'Codex', claude: 'Claude Code', claudeDesktop: 'Claude Desktop' })[id] || id,
      detected: id === 'claudeDesktop' || id === 'codex', configured: Boolean(options.existing),
      supported: id !== 'claudeDesktop' || !options.linux, issue: id === 'claudeDesktop' ? options.desktopIssue : null }));
    window.__TAURI__ = { event: { listen: async () => () => {} }, shell: { open: async url => window.calls.push({ command: 'external', url }) },
      dialog: { open: async () => channel.unity_project_path }, core: { invoke: async (command, args) => {
        window.calls.push({ command, args });
        switch (command) {
          case 'begin_ui_operation': return 7;
          case 'finish_ui_operation': return null;
          case 'load_config': return structuredClone(config);
          case 'save_config':
            if (options.failSave) throw new Error('Fixture disk full');
            config = structuredClone(args.config); return null;
          case 'discover_unity_projects': return [{ name: channel.name, path: channel.unity_project_path }];
          case 'get_project_feedback_settings': return { enabled: false, usageCheckIns: false };
          case 'get_project_sdk_profile': return profile;
          case 'get_unity_extension_status': return { installed: true, current: true };
          case 'get_onboarding_status': return { runtime: { ready: true, bundled: true },
            project: { valid: true, bridgeInstalled: true, bridgeCurrent: true, stateStatus: options.stale ? 'stale' : 'fresh', sdkProfile: profile },
            clients, unityCli: { available: !options.noCli, canEnable: !options.noCli, enabled: config.unity_cli_enabled === true && !options.noCli, message: options.noCli ? 'No supported, hash-verified Unity CLI found.' : 'Unity CLI and Pipeline detected. Optional; experimental in both Creator Hub and Unity.' } };
          case 'one_click_setup':
            if (options.pending) await new Promise(resolve => { window.finishSetup = resolve; });
            if (options.failSetup) throw new Error('Fixture client settings changed');
            config.channels = [channel]; config.active_channel_id = channel.id;
            config.unity_cli_enabled = args.configureUnityCli === true;
            config.unity_cli_consent_version = args.unityCliConsent;
            clients.forEach(c => { c.configured = true; }); return {};
          case 'update_claude_desktop_mcp_config': clients.find(c => c.id === 'claudeDesktop').configured = true; return null;
          case 'remove_claude_desktop_mcp_config': clients.find(c => c.id === 'claudeDesktop').configured = false; return null;
          default: throw new Error('Unexpected fixture command: ' + command);
        }
      } } };
  }, options);
  await page.goto('http://127.0.0.1:4188/mcp-guide/');
  await expect(page.locator('#workspaceControls')).toHaveJSProperty('disabled', false);
}
async function writes(page) { return page.evaluate(() => calls.filter(c => ['save_config', 'one_click_setup'].includes(c.command))); }

test('first run and old installations get a no-write guide; saved skip keeps the old controls', async ({ page }) => {
  await open(page, { existing: true });
  await expect(page.locator('#connection-guide-dialog')).toBeVisible();
  expect(await writes(page)).toEqual([]);
  await page.locator('#connection-guide-skip').click();
  await expect(page.locator('#connection-guide-dialog')).not.toBeVisible();
  await expect(page.locator('#workspaceControls .setup-section')).toBeVisible();
  expect((await writes(page)).map(c => c.command)).toEqual(['save_config']);
  expect((await writes(page))[0].args.config.connection_guide_version).toBe(1);
  expect((await writes(page))[0].args.config.channels).toHaveLength(1);
});

test('existing users can bypass the popup and reopen checks without changing settings', async ({ page }) => {
  await open(page, { seen: true, existing: true, stale: true });
  await expect(page.locator('#connection-guide-dialog')).not.toBeVisible();
  await page.locator('#connectionGuideBtn').click();
  await page.locator('#connection-guide-repair').click();
  await expect(page.locator('#guideWorkspace #projectPath')).toHaveValue('E:\\Test Project');
  await expect(page.locator('#connection-guide-next')).toContainText('let it compile');
  await page.locator('#connection-guide-check').click();
  await expect(page.locator('#guideWorkspace')).toHaveJSProperty('disabled', false);
  expect(await writes(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.locator('#workspaceControls .setup-section')).toBeVisible();
});

test('CLI detection never enables it; decline and Escape keep it off', async ({ page }) => {
  await open(page);
  await page.locator('#connection-guide-start').click();
  await page.locator('.cli-option').evaluate(element => { element.open = true; });
  await expect(page.locator('#useUnityCli')).not.toBeChecked();
  await page.locator('#useUnityCli').check();
  await expect(page.locator('#unity-cli-consent-dialog')).toContainText('both Creator Hub and Unity itself');
  await expect(page.locator('#unity-cli-accept')).toBeDisabled();
  await page.locator('#unity-cli-decline').click();
  await expect(page.locator('#useUnityCli')).not.toBeChecked();
  await page.locator('#useUnityCli').check();
  await page.keyboard.press('Escape');
  await expect(page.locator('#useUnityCli')).not.toBeChecked();
  expect(await writes(page)).toEqual([]);
});

test('explicit agreement plus setup review is required before configuring Desktop and optional CLI', async ({ page }) => {
  await open(page);
  await page.locator('#connection-guide-start').click();
  await page.locator('.cli-option').evaluate(element => { element.open = true; });
  await page.locator('#useUnityCli').check();
  await page.locator('#unity-cli-consent-checkbox').check();
  await page.locator('#unity-cli-accept').click();
  await expect(page.locator('#guideWorkspace')).toHaveJSProperty('disabled', false);
  await page.locator('#setupBtn').click();
  await expect(page.locator('#connection-review-summary')).toContainText('Claude Desktop');
  await expect(page.locator('#connection-review-summary')).toContainText('Custom scripts: off');
  expect(await writes(page)).toEqual([]);
  await page.locator('#connection-review-apply').click();
  await expect(page.locator('#setupMessage')).toContainText('ask your AI to call get_bridge_status');
  const setup = (await writes(page)).find(c => c.command === 'one_click_setup');
  expect(setup.args.configureClaudeDesktop).toBe(true);
  expect(setup.args.configureUnityCli).toBe(true);
  expect(setup.args.unityCliConsent).toBe('unity-cli-experimental-v1');
  await expect(page.locator('#connection-guide-next')).toContainText('does not yet prove');
});

test('cancelling setup does not write or leave a workflow running', async ({ page }) => {
  await open(page);
  await page.locator('#connection-guide-start').click();
  await page.locator('#setupBtn').click();
  await page.locator('#connection-review-cancel').click();
  await expect(page.locator('#guideWorkspace')).toHaveJSProperty('disabled', false);
  expect(await writes(page)).toEqual([]);
  const calls = await page.evaluate(() => window.calls);
  expect(calls.filter(c => c.command === 'begin_ui_operation').length).toBe(calls.filter(c => c.command === 'finish_ui_operation').length);
});

test('Linux does not offer Claude Desktop; missing CLI cannot be enabled', async ({ page }) => {
  await open(page, { linux: true, noCli: true });
  await page.locator('#connection-guide-start').click();
  await expect(page.locator('#connectClaudeDesktop')).toBeDisabled();
  await expect(page.locator('#connectClaudeDesktop')).not.toBeChecked();
  await expect(page.locator('#claudeDesktopState')).toHaveText('Unsupported');
  await expect(page.locator('#useUnityCli')).toBeDisabled();
  expect(await writes(page)).toEqual([]);
});

test('client errors are actionable and do not trigger an automatic repair', async ({ page }) => {
  await open(page, { desktopIssue: 'Client settings contain invalid JSON.' });
  await page.locator('#connection-guide-repair').click();
  await expect(page.locator('#connection-guide-next')).toContainText('invalid JSON');
  expect(await writes(page)).toEqual([]);
});

test('a failed preference save keeps the guide recoverable', async ({ page }) => {
  await open(page, { failSave: true });
  await page.locator('#connection-guide-skip').click();
  await expect(page.locator('#connection-guide-error')).toContainText('Could not save');
  await page.locator('#connection-guide-close').click();
  await expect(page.locator('#setupBtn')).toBeVisible();
});

test('an unavailable previously enabled CLI does not prevent normal setup', async ({ page }) => {
  await open(page, { noCli: true, cliPreviouslyEnabled: true });
  await page.locator('#connection-guide-start').click();
  await expect(page.locator('#useUnityCli')).not.toBeChecked();
  await page.locator('#setupBtn').click();
  await expect(page.locator('#connection-review-summary')).toContainText('off for selected clients');
  await page.locator('#connection-review-apply').click();
  await expect(page.locator('#setupMessage')).toContainText('ask your AI');
  expect((await writes(page)).find(c => c.command === 'one_click_setup').args.configureUnityCli).toBe(false);
});

test('failed setup is explicit, does not retry, and leaves the guide usable', async ({ page }) => {
  await open(page, { failSetup: true });
  await page.locator('#connection-guide-start').click();
  await page.locator('#setupBtn').click();
  await page.locator('#connection-review-apply').click();
  await expect(page.locator('#setupMessage')).toContainText('Earlier completed steps may remain');
  await expect(page.locator('#setupBtn')).toBeEnabled();
  expect((await writes(page)).filter(c => c.command === 'one_click_setup')).toHaveLength(1);
  await page.locator('#connection-guide-close').click();
  await expect(page.locator('#workspaceControls .setup-section')).toBeVisible();
});

test('old controls can configure and disconnect Desktop without changing other clients', async ({ page }) => {
  await open(page, { seen: true, existing: true });
  await page.locator('.advanced-section').evaluate(element => { element.open = true; });
  await page.locator('#applyClaudeDesktopBtn').click();
  await expect(page.locator('#workspaceControls')).toHaveJSProperty('disabled', false);
  await page.locator('#disconnectClaudeDesktopBtn').click();
  await expect(page.locator('#claudeDesktopState')).toHaveText('Not configured');
  await expect(page.locator('[data-check="claudeDesktop"] strong')).toHaveText('Detected');
  await expect(page.locator('#codexState')).toHaveText('Configured');
  expect(await page.evaluate(() => calls.filter(c => /claude_desktop_mcp_config$/.test(c.command)).map(c => c.command)))
    .toEqual(['update_claude_desktop_mcp_config', 'remove_claude_desktop_mcp_config']);
});

for (const viewport of [{ width: 1080, height: 800 }, { width: 320, height: 480 }]) {
  test('guided setup remains centered and contained at ' + viewport.width, async ({ page }, info) => {
    await page.setViewportSize(viewport); await open(page);
    await page.locator('#connection-guide-start').click();
    expect(await page.locator('#connection-guide-dialog').evaluate(dialog => {
      const r = dialog.getBoundingClientRect();
      return { inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        centered: Math.abs(r.left - (innerWidth - r.width) / 2) < 2, overflow: dialog.scrollWidth > dialog.clientWidth };
    })).toEqual({ inside: true, centered: true, overflow: false });
    await page.locator('#guideWorkspace').evaluate(element => { element.scrollTop = 0; });
    await page.locator('#connection-guide-title').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('connection-guide-top.png') });
    await page.locator('#connection-guide-skip').scrollIntoViewIfNeeded();
    await expect(page.locator('#connection-guide-skip')).toBeVisible();
    await page.screenshot({ path: info.outputPath('connection-guide.png') });
  });
}
