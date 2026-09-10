const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const setupSource = process.env.CREATOR_SETUP_SOURCE || path.resolve('../CREATOR-PROJECT-SETUP/src');
const files = Object.fromEntries(fs.readdirSync(setupSource, { recursive: true }).filter(name => fs.statSync(path.join(setupSource, name)).isFile()).map(name => [name.replaceAll('\\', '/'), fs.readFileSync(path.join(setupSource, name)).toString('base64')]));
const mcpSource = process.env.CREATOR_MCP_SOURCE || path.resolve('../creator-works-hub-compatibility/launcher/src');
const mcpFiles = Object.fromEntries(fs.readdirSync(mcpSource, { recursive: true }).filter(name => fs.statSync(path.join(mcpSource, name)).isFile()).map(name => [name.replaceAll('\\', '/'), fs.readFileSync(path.join(mcpSource, name)).toString('base64')]));

async function open(page, options = {}) {
  await page.addInitScript(({ files, mcpFiles, options }) => {
    if (window !== window.parent) return;
    window.hostCalls = [];
    window.events = {};
    const channels = Array.from({ length: 62 }, (_, index) => ({ id: String(index),
      name: index ? `Project ${index}` : 'Creator project with a deliberately long name for hosted layout verification',
      unity_project_path: `E:\\Fixtures\\Project ${index}`, enabled: true }));
    let mcpConfig = { channels, active_channel_id: '0', mcp_server_path: 'E:\\Fixture\\server.mjs',
      tool_groups: 'core', auto_start: true, enable_custom_scripts: false, allow_all_tests: true, automatic_update_checks: false };
    window.__TAURI__ = {
      event: { listen: async (name, callback) => { window.events[name] = callback; return () => {}; } },
      core: { invoke: async (command, args) => {
        window.hostCalls.push({ command, args });
        if (command === 'get_launch_request') return { view: 'hub', revision: 0 };
        if (command === 'app_inventory') return { supported: true, apps: ['mcp', 'setup'].map(app => ({ app, installed: true, trusted: true, availableVersion: '0.3.0-alpha.1', installedVersion: '0.3.0-alpha.1', hostedPreview: app === 'mcp' && !options.writableMcp ? 'read-only' : 'writable' })) };
        if (command === 'start_hosted_app') {
          if (options.decline) throw 'Opening Setup in Hub was declined. Standalone Setup is unchanged.';
          if (args.app === 'mcp') return { session: 'b'.repeat(64), appId: 'creator-works-mcp', version: '2.7.0-alpha.1', files: mcpFiles,
            ...(options.writableMcp ? { hostingRevision: 2, effectiveMode: 'writable' } : {}) };
          return { session: 'a'.repeat(64), appId: 'creator-project-setup', version: '0.3.0-alpha.1', files };
        }
        if (command === 'stop_hosted_app') return !options.keepOpen;
        if (command !== 'hosted_app_call') return;
        if (args.session === 'b'.repeat(64) && options.writableMcp) {
          const profile = { profile: 'creator', label: 'Creator SDK 4.0.14', packages: [] };
          switch (args.command) {
            case 'begin_ui_operation': return 7;
            case 'finish_ui_operation': return null;
            case 'load_config': return structuredClone(mcpConfig);
            case 'save_config': mcpConfig = structuredClone(args.args.config); return null;
            case 'discover_unity_projects': return channels.map(channel => ({name:channel.name,path:channel.unity_project_path}));
            case 'get_project_sdk_profile': return profile;
            case 'get_unity_extension_status': return {current:true,installed:true};
            case 'get_project_feedback_settings': return {enabled:false,usageCheckIns:false};
            case 'get_onboarding_status': return {runtime:{ready:true,bundled:true}, project:{valid:true,
              bridgeInstalled:true,bridgeCurrent:true,stateStatus:'fresh',sdkProfile:profile},
              clients:['codex','claude','antigravity','opencode'].map(id => ({id,detected:true,configured:true}))};
            case 'update_configured_unity_extensions':
              if (options.pendingMcp) await new Promise(resolve => { window.finishBridges = resolve; });
              return {updated:62,failed:[]};
            case 'get_stable_release': return {tag_name:'v2.8.0',html_url:'https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases/tag/v2.8.0',draft:false,prerelease:false,published_at:'fixture'};
          }
        }
        if (args.command === 'get_hosted_snapshot') return { config: { channels: [{ id: 'demo', name: 'Read-only demo', unity_project_path: 'E:\\Demo' }], active_channel_id: 'demo', mcp_server_path: '', tool_groups: 'core' }, readOnly: true, source: 'current', resourceDir: 'E:\\Preview\\apps\\mcp' };
        if (args.command === 'pick_project_folder') return 'E:\\Not Saved';
        if (args.command === 'probe_environment') return {
          platform: 'windows', ready: true, hubInstalled: true, hubVersion: '3.21.1', hubAutoRegistration: true,
          suggestedProjectParent: 'E:\\UnityTest', blockers: [],
          recipe: { editorVersion: '6000.3.21f1', creatorSdkVersion: '4.0.14', urpVersion: '17.3.0', inputSystemVersion: '1.20.0' },
          editors: [{ exactRecipe: true, androidPlayer: true, androidSdk: true, androidNdk: true, openJdk: true, windowsStandalone: true, urpTemplate: 'template.tgz' }],
        };
        if (args.command === 'pick_parent_folder') return 'E:\\Hosted Test';
        if (args.command === 'inspect_project') return { projectPath: args.args.path, fingerprint: 'reviewed', canRepair: true, canValidate: true, findings: [{ status: 'repair', title: 'Visual Scripting', detail: 'Missing initialization' }], proposedChanges: ['Initialize node database'] };
        if (args.command === 'run_existing_project') return { success: true, projectPath: args.args.request.projectPath, backupPath: 'backup', reportPath: 'report', message: 'Validated' };
        if (args.command === 'create_project') {
          if (options.pending) await new Promise(resolve => { window.finishCreate = resolve; });
          return { success: true, projectPath: 'E:\\Hosted Test\\My Space', message: 'Validated', hub: { registered: true, refreshPending: true, message: 'Registered' } };
        }
      } },
    };
  }, { files, mcpFiles, options });
  await page.goto('http://127.0.0.1:4188/');
  await expect(page.locator('#catalog-status')).toContainText('Update check complete');
  await page.getByRole('button', { name: 'View Creator Project Setup', exact: true }).click();
  await page.locator('#host-setup-button').click();
  if (!options.decline) await expect(page.frameLocator('#setup-host-frame').locator('#create-button')).toBeEnabled();
  return page.frameLocator('#setup-host-frame');
}

async function switchTo(page, name) {
  await page.locator('#suite-trigger').click();
  await page.locator(`#suite-menu [data-view="${name}"]`).click();
}

for (const width of [940, 720, 560, 390]) test(`real Setup interface hosted at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 720 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const setup = await open(page);
  await expect(setup.locator('#suite-shell')).toBeHidden();
  await expect(setup.locator('.title-block')).toBeHidden();
  await expect(page.locator('#page-title')).toContainText('PROJECT');
  expect(await setup.locator('html').evaluate(element => element.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(setup.locator('#requirements')).toContainText('Android');
  await page.screenshot({ path: testInfo.outputPath('hosted-setup.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('switching keeps the same frame, form and backend', async ({ page }) => {
  const setup = await open(page);
  await setup.locator('#project-name').fill('Do not reset this');
  await setup.locator('#browse-button').click();
  await expect(setup.locator('#parent-folder')).toHaveValue('E:\\Hosted Test');
  await switchTo(page, 'mcp');
  await expect(page.locator('#view-hosted')).toBeHidden();
  await switchTo(page, 'setup');
  await expect(setup.locator('#project-name')).toHaveValue('Do not reset this');
  await expect(setup.locator('#parent-folder')).toHaveValue('E:\\Hosted Test');
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.command === 'start_hosted_app').length)).toBe(1);
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.args?.command === 'probe_environment').length)).toBe(1);
});

test('progress and completion continue while the hosted view is hidden', async ({ page }) => {
  const setup = await open(page, { pending: true });
  await setup.locator('#create-button').click();
  await expect(page.locator('#hosted-stop')).toBeDisabled();
  await switchTo(page, 'hub');
  await page.evaluate(() => window.events['hosted-app-event']({ payload: { session: 'a'.repeat(64), name: 'setup-progress', payload: { step: 3, detail: 'Real command progress channel' } } }));
  await switchTo(page, 'setup');
  await expect(setup.locator('#activity-message')).toHaveText('Real command progress channel');
  await page.evaluate(() => window.finishCreate());
  await expect(setup.locator('#result')).toContainText('Ready');
  await expect(setup.locator('#open-project-button')).toBeVisible();
  await expect(page.locator('#hosted-stop')).toBeEnabled();
  expect(await page.evaluate(() => window.hostCalls.filter(call => call.args?.command === 'create_project').length)).toBe(1);
});

test('existing inspection and approved repair use the same reviewed request', async ({ page }) => {
  const setup = await open(page);
  await setup.locator('#existing-mode').click();
  await setup.locator('#existing-path').fill('E:\\Existing');
  await setup.locator('#inspect-button').click();
  await expect(setup.locator('#inspection-findings')).toContainText('Visual Scripting');
  await setup.locator('#existing-approval').check();
  await setup.locator('#repair-button').click();
  await expect(setup.locator('#existing-result')).toContainText('Validation passed');
  const request = await page.evaluate(() => window.hostCalls.find(call => call.args?.command === 'run_existing_project').args.args.request);
  expect(request).toEqual({ projectPath: 'E:\\Existing', fingerprint: 'reviewed', repair: true, approved: true });
});

test('child cannot access parent, installer authority or a stale event session', async ({ page }) => {
  const setup = await open(page);
  const child = await setup.locator('body').evaluate(() => {
    let denied = false;
    try { void parent.document.body; } catch { denied = true; }
    return { denied, tauri: typeof window.__TAURI__, secret: typeof window.__CREATOR_SHELL_KEY__ };
  });
  expect(child).toEqual({ denied: true, tauri: 'undefined', secret: 'undefined' });
  const error = await setup.locator('body').evaluate(() => window.CreatorRuntime.invoke('install_app', { app: 'mcp' }).catch(String));
  expect(error).toContain('Unsupported hosted');
  expect(await page.evaluate(() => window.hostCalls.some(call => call.command === 'install_app'))).toBe(false);
  await page.evaluate(() => window.events['hosted-app-disconnected']({ payload: { session: 'wrong', error: 'stale failure' } }));
  await expect(setup.locator('#create-button')).toBeEnabled();
  await page.evaluate(() => window.events['hosted-app-disconnected']({ payload: { session: 'a'.repeat(64), error: 'Backend exited' } }));
  await expect(page.locator('#hosted-status')).toContainText('Backend exited');
  expect(await setup.locator('main').evaluate(element => element.inert)).toBe(true);
});

test('declined startup and declined close leave apps unchanged', async ({ page }) => {
  await open(page, { decline: true });
  await expect(page.locator('#action-error')).toContainText('declined');
  await expect(page.locator('#setup-host-frame')).toHaveCount(0);
  expect(await page.evaluate(() => window.hostCalls.some(call => ['install_app', 'open_app', 'use_existing_app'].includes(call.command)))).toBe(false);
});

test('cancel closing preserves form entries', async ({ page }) => {
  const setup = await open(page, { keepOpen: true });
  await setup.locator('#project-name').fill('Keep this');
  await page.locator('#hosted-stop').click();
  await expect(setup.locator('#project-name')).toHaveValue('Keep this');
});

async function openMcp(page, writable = false) {
  await switchTo(page, 'mcp');
  await page.locator('#host-mcp-button').click();
  const mcp = page.frameLocator('#mcp-host-frame');
  if (writable) await expect(mcp.locator('#workspaceControls')).toHaveJSProperty('disabled', false);
  else await expect(mcp.locator('#hostedPreviewStatus')).toContainText('Saved configuration loaded');
  return mcp;
}

for (const width of [940, 560, 390, 320]) test(`writable MCP retains its full controls at ${width}px with 62 projects`, async ({ page }, testInfo) => {
  await page.setViewportSize({width, height:800});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const setup = await open(page, {writableMcp:true});
  await setup.locator('#project-name').fill('Retain Setup draft');
  const mcp = await openMcp(page, true);
  await expect(mcp.locator('.bridge-badge.success')).toHaveCount(62);
  await expect(mcp.locator('.sdk-creator')).toHaveCount(62);
  await expect(mcp.locator('#setupBtn')).toBeEnabled();
  await expect(mcp.locator('#updateBridgesBtn')).toBeEnabled();
  await expect(mcp.locator('#hostedPreview')).toBeHidden();
  await expect(page.locator('#mode-description')).not.toContainText('Read-only');
  expect(await mcp.locator('html').evaluate(element => element.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('writable-mcp.png')});
  await switchTo(page, 'setup');
  await expect(setup.locator('#project-name')).toHaveValue('Retain Setup draft');
  await switchTo(page, 'mcp');
  expect(await page.evaluate(() => hostCalls.filter(call => call.args?.command === 'finish_ui_operation').length)).toBe(1);
  await mcp.locator('#checkUpdatesBtn').click();
  await expect(mcp.locator('#updateStatus')).toContainText('2.8.0');
  await mcp.locator('#openReleaseBtn').click();
  await page.waitForFunction(() => hostCalls.some(call => call.args?.command === 'open_official_url'));
  expect(await page.evaluate(() => hostCalls.filter(call => call.args?.command === 'open_official_url').at(-1).args.args.url)).toContain('/releases/tag/v2.8.0');
  expect(errors).toEqual([]);
});

test('writable workflow prevents close, finishes while hidden, and disconnect never retries', async ({ page }) => {
  await open(page, {writableMcp:true, pendingMcp:true});
  const mcp = await openMcp(page, true);
  await mcp.locator('#updateBridgesBtn').click();
  await page.waitForFunction(() => typeof finishBridges === 'function');
  await expect(mcp.locator('#setupBtn')).toBeDisabled();
  await expect(page.locator('#hosted-stop')).toBeDisabled();
  await switchTo(page, 'hub');
  await page.evaluate(() => finishBridges());
  await switchTo(page, 'mcp');
  await expect(mcp.locator('#setupBtn')).toBeEnabled();
  await expect(page.locator('#hosted-stop')).toBeEnabled();
  await mcp.locator('#updateBridgesBtn').click();
  await expect(mcp.locator('#setupBtn')).toBeDisabled();
  await page.waitForFunction(() => hostCalls.filter(call => call.args?.command === 'update_configured_unity_extensions').length === 2);
  await page.evaluate(() => events['hosted-app-disconnected']({payload:{session:'b'.repeat(64),error:'Fixture pipe loss'}}));
  await expect(mcp.locator('#hostedPreviewStatus')).toContainText('disconnected');
  await expect(mcp.locator('#workspaceControls')).toHaveJSProperty('disabled', true);
  await page.evaluate(() => finishBridges());
  await expect(mcp.locator('#workspaceControls')).toHaveJSProperty('disabled', true);
  expect(await page.evaluate(() => hostCalls.filter(call => call.args?.command === 'update_configured_unity_extensions').length)).toBe(2);
});

for (const width of [940, 560, 390, 320]) test(`both actual app interfaces persist at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 800 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const setup = await open(page);
  await setup.locator('#project-name').fill('Keep my Setup draft');
  const mcp = await openMcp(page);
  await expect(page.locator('#page-title')).toContainText('WORKS');
  await expect(mcp.locator('#workspaceControls')).toHaveJSProperty('disabled', true);
  await expect(mcp.locator('#setupBtn')).toBeDisabled();
  await expect(mcp.locator('#updateBridgesBtn')).toBeDisabled();
  await expect(mcp.locator('#projectPath')).toHaveValue('E:\\Demo');
  await mcp.locator('#hostedBrowse').click();
  await expect(mcp.locator('#hostedPickedFolder')).toHaveText('E:\\Not Saved');
  await page.screenshot({ path: testInfo.outputPath('hosted-mcp.png'), fullPage: true });
  expect(await mcp.locator('html').evaluate(element => element.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await switchTo(page, 'setup');
  await expect(setup.locator('#project-name')).toHaveValue('Keep my Setup draft');
  await expect(page.locator('#mcp-host-frame')).toBeHidden();
  await switchTo(page, 'mcp');
  await expect(mcp.locator('#hostedPickedFolder')).toHaveText('E:\\Not Saved');
  const counts = await page.evaluate(() => window.hostCalls.filter(c => c.command === 'start_hosted_app').map(c => c.args.app));
  expect(counts).toEqual(['setup', 'mcp']);
  expect(errors).toEqual([]);
});

test('closing MCP preserves Setup and each backend has its own authority', async ({ page }) => {
  const setup = await open(page);
  await setup.locator('#project-name').fill('Retained');
  const mcp = await openMcp(page);
  const error = await mcp.locator('body').evaluate(() => window.CreatorRuntime.invoke('create_project', { request: {} }).catch(String));
  expect(error).toContain('read-only');
  const setupError = await setup.locator('body').evaluate(() => window.CreatorRuntime.invoke('get_hosted_snapshot', {}).catch(String));
  expect(setupError).toContain('Unsupported hosted');
  expect(await page.evaluate(() => window.hostCalls.filter(c => c.args?.command === 'create_project'))).toEqual([]);
  await page.locator('#hosted-stop').click();
  await expect(page.locator('#mcp-host-frame')).toHaveCount(0);
  await expect(page.locator('#setup-host-frame')).toHaveCount(1);
  await switchTo(page, 'setup');
  await expect(setup.locator('#project-name')).toHaveValue('Retained');
});

test('MCP remains visible and unchanged while hidden Setup receives scoped progress', async ({ page }) => {
  const setup = await open(page, { pending: true });
  const mcp = await openMcp(page);
  await switchTo(page, 'setup');
  await setup.locator('#create-button').click();
  await switchTo(page, 'mcp');
  await page.evaluate(() => window.events['hosted-app-event']({ payload: { session: 'a'.repeat(64), name: 'setup-progress', payload: { step: 3, detail: 'Hidden Setup progress' } } }));
  await expect(mcp.locator('#hostedPreviewStatus')).toContainText('Saved configuration');
  await expect(page.locator('#hosted-stop')).toBeEnabled();
  await page.evaluate(() => window.finishCreate());
  await switchTo(page, 'setup');
  await expect(setup.locator('#result')).toContainText('Ready');
});

test('shortcut view requests preserve a running hosted Setup operation', async ({ page }) => {
  const setup = await open(page, { pending: true });
  await setup.locator('#project-name').fill('Retain this draft');
  await setup.locator('#create-button').click();
  await page.evaluate(() => window.events['hub-launch-view']({ payload: { view: 'mcp', revision: 1 } }));
  await expect(page.locator('#view-hosted')).toBeHidden();
  await page.evaluate(() => window.events['hub-launch-view']({ payload: { view: 'setup', revision: 2 } }));
  await expect(setup.locator('#project-name')).toHaveValue('Retain this draft');
  await expect(page.locator('#hosted-stop')).toBeDisabled();
  await page.evaluate(() => window.finishCreate());
  await expect(setup.locator('#result')).toContainText('Ready');
  expect(await page.evaluate(() => window.hostCalls.filter(c => c.args?.command === 'create_project').length)).toBe(1);
});
