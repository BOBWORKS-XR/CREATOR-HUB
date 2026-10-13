const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const source = path.resolve(__dirname, '../modules/mcp/launcher/src');
const files = Object.fromEntries(fs.readdirSync(source, { recursive: true })
  .filter(name => fs.statSync(path.join(source, name)).isFile())
  .map(name => [name.replaceAll('\\', '/'), fs.readFileSync(path.join(source, name)).toString('base64')]));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

async function openMcp(page, mode) {
  await page.route('http://127.0.0.1:4188/mcp/**', route => {
    const name = new URL(route.request().url()).pathname.slice('/mcp/'.length) || 'index.html';
    return Object.hasOwn(files, name)
      ? route.fulfill({ contentType: mime[path.extname(name)], body: Buffer.from(files[name], 'base64') })
      : route.fulfill({ status: 404 });
  });
  await page.addInitScript(({ files, mode }) => {
    if (window !== window.parent) return;
    const acceptance = JSON.stringify({ policyVersion: '2026-09-28-v1', acceptedAt: '2026-09-28T00:00:00.000Z' });
    localStorage.setItem('creator-usage-terms.hub', acceptance);
    localStorage.setItem('creator-usage-terms.mcp', acceptance);
    const channels = [{ id: 'demo', name: 'Creator project', unity_project_path: 'E:\\Fixtures\\Creator project', enabled: true }];
    const config = { channels, active_channel_id: 'demo', mcp_server_path: 'E:\\Fixture\\server.mjs',
      tool_groups: 'core', auto_start: true, enable_custom_scripts: false, allow_all_tests: true, automatic_update_checks: false, connection_guide_version: 1 };
    const profile = { profile: 'creator', label: 'Creator SDK 4.0.14', packages: [] };
    const mcpCall = async command => {
      switch (command) {
        case 'begin_ui_operation': return 7;
        case 'finish_ui_operation': return null;
        case 'load_config': return structuredClone(config);
        case 'discover_unity_projects': return channels.map(channel => ({ name: channel.name, path: channel.unity_project_path }));
        case 'get_project_sdk_profile': return profile;
        case 'get_unity_extension_status': return { current: true, installed: true };
        case 'get_project_feedback_settings': return { enabled: false, usageCheckIns: false };
        case 'get_onboarding_status': return { runtime: { ready: true, bundled: true },
          project: { valid: true, bridgeInstalled: true, bridgeCurrent: true, stateStatus: 'fresh', sdkProfile: profile },
          clients: ['codex', 'claude', 'antigravity', 'opencode'].map(id => ({ id, detected: true, configured: true })) };
        default: throw new Error(`Unexpected MCP fixture command: ${command}`);
      }
    };
    window.__TAURI__ = {
      event: { listen: async () => () => {} },
      core: { invoke: async (command, args) => {
        if (mode === 'standalone') return mcpCall(command);
        switch (command) {
          case 'get_launch_request': return { view: 'hub', revision: 0 };
          case 'pending_hosted_restore': return [];
          case 'hub_update_status': return { currentVersion: '0.1.12' };
          case 'project_inventory': return { projects: [], warnings: [] };
          case 'app_inventory': return { supported: true, apps: ['mcp', 'setup'].map(app => ({ app, builtIn: true,
            installed: true, trusted: true, hostedCompatible: true, hostedPreview: 'writable', installedVersion: '2.7.7' })) };
          case 'start_hosted_app': return { session: 'b'.repeat(64), appId: 'creator-works-mcp', version: '2.7.7',
            files, builtIn: true, hostingRevision: 2, effectiveMode: 'writable' };
          case 'hosted_app_call': return mcpCall(args.command);
          default: throw new Error(`Unexpected Hub fixture command: ${command}`);
        }
      } },
    };
  }, { files, mode });
  if (mode === 'standalone') {
    await page.goto('http://127.0.0.1:4188/mcp/');
    return page.mainFrame();
  }
  await page.goto('http://127.0.0.1:4188/');
  await expect(page.locator('#catalog-status')).toContainText('Update check complete');
  await page.locator('#suite-trigger').click();
  await page.locator('#suite-menu [data-view="mcp"]').click();
  await expect(page.locator('#mcp-host-frame')).toBeVisible();
  const frame = await page.locator('#mcp-host-frame').elementHandle();
  await expect(page.frameLocator('#mcp-host-frame').locator('#workspaceControls')).toHaveJSProperty('disabled', false);
  return frame.contentFrame();
}

async function checkHelp(frame) {
  await expect(frame.locator('#context-help-open')).toBeVisible();
  expect(await frame.locator('#context-help-open').evaluate(button => {
    const rect = button.getBoundingClientRect();
    return { position: getComputedStyle(button).position, right: innerWidth - rect.right,
      bottom: innerHeight - rect.bottom, height: rect.height,
      hit: button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) };
  })).toEqual({ position: 'fixed', right: 18, bottom: 18, height: 44, hit: true });
}

async function sweepForOcclusion(frame) {
  return frame.evaluate(async () => {
    const help = document.querySelector('#context-help-open');
    const header = document.documentElement.classList.contains('creator-hosted') ? null : document.querySelector('.header');
    const switcher = document.querySelector('#appSwitcherShell');
    const targets = [...document.querySelectorAll('#setupChecks strong, #setupChecks span, [role="status"], '
      + '.workspace-controls button, .workspace-controls input:not([type="checkbox"]), .workspace-controls select, '
      + '.workspace-controls .toggle, .advanced-section summary, .footer a, .client-copy, .client-state')];
    const max = document.scrollingElement.scrollHeight - innerHeight;
    const positions = [...new Set([0, ...Array.from({ length: Math.ceil(max / 24) }, (_, i) => Math.min(max, (i + 1) * 24)), max])];
    for (const y of positions) {
      scrollTo(0, y);
      await new Promise(requestAnimationFrame);
      const h = help.getBoundingClientRect();
      for (const element of targets) {
        const r = element.getBoundingClientRect();
        if (r.width && r.height && r.left < h.right && r.right > h.left && r.top < h.bottom && r.bottom > h.top) {
          return { kind: 'help', scrollY, target: element.id || element.outerHTML.slice(0, 200),
            help: h.toJSON(), content: r.toJSON() };
        }
        if (!header || !r.width || !r.height) continue;
        // Content behind the opaque header band is intentionally clipped.
        const top = Math.max(0, header.getBoundingClientRect().bottom, r.top);
        const bottom = Math.min(innerHeight, r.bottom);
        const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right);
        if (top >= bottom || left >= right) continue;
        for (const x of [left + 0.5, (left + right) / 2, right - 0.5]) {
          for (const y of [top + 0.5, (top + bottom) / 2, bottom - 0.5]) {
            const hit = document.elementFromPoint(x, y);
            if (switcher.contains(hit)) return { kind: 'closed-switcher', scrollY,
              target: element.id || element.outerHTML.slice(0, 200), point: { x, y },
              header: header.getBoundingClientRect().toJSON(), content: r.toJSON() };
          }
        }
      }
    }
    return null;
  });
}

async function checkScrollTarget(frame, selector) {
  expect(await frame.locator(selector).evaluate(element => {
    const r = element.getBoundingClientRect();
    const header = document.querySelector('.header').getBoundingClientRect();
    return r.top >= header.bottom && r.bottom <= innerHeight
      && element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }), `${selector} must be visible and hit-testable below the sticky header`).toBe(true);
}

async function checkStandaloneHeader(page, frame, testInfo) {
  await expect(frame.locator('.header')).toHaveCSS('position', 'sticky');
  await expect(frame.locator('.header')).toHaveCSS('top', '0px');
  await expect(frame.locator('.header')).toHaveCSS('background-color', 'rgb(9, 11, 13)');
  expect(await frame.locator('.header').evaluate(header => {
    const r = header.getBoundingClientRect();
    return { top: r.top, scrollClearance: parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) >= r.height,
      coversBand: header.contains(document.elementFromPoint(16, r.bottom - 1)),
      contentWidth: document.querySelector('.main').getBoundingClientRect().width,
      expectedWidth: innerWidth - 76, leftPadding: getComputedStyle(document.querySelector('.main')).paddingLeft };
  })).toEqual({ top: 0, scrollClearance: true, coversBand: true,
    contentWidth: page.viewportSize().width - 76, expectedWidth: page.viewportSize().width - 76,
    leftPadding: page.viewportSize().width <= 720 ? '16px' : '24px' });

  await frame.locator('#applyCodexBtn').focus();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Shift+Tab');
    if (await frame.locator('#checkUpdatesBtn').evaluate(button => button === document.activeElement)) break;
  }
  await expect(frame.locator('#checkUpdatesBtn')).toBeFocused();
  await checkScrollTarget(frame, '#checkUpdatesBtn');
  await page.screenshot({ path: testInfo.outputPath('keyboard-target.png') });

  await frame.evaluate(() => { location.hash = 'mcpServerPath'; });
  await expect.poll(() => frame.locator('#mcpServerPath').evaluate(input => input.getBoundingClientRect().top
    >= document.querySelector('.header').getBoundingClientRect().bottom)).toBe(true);
  await checkScrollTarget(frame, '#mcpServerPath');
  await page.screenshot({ path: testInfo.outputPath('anchor-target.png') });

  await frame.locator('#appSwitcherToggle').click();
  await expect(frame.locator('#appSwitcherToggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(frame.locator('#appSwitcherShell')).toHaveCSS('position', 'fixed');
  await expect(frame.locator('#appSwitcherShell')).toHaveCSS('width', '224px');
  await expect(frame.locator('#appSwitcherShell')).toHaveCSS('height', '294px');
  await expect(frame.locator('#appSwitcherMenu')).toHaveJSProperty('inert', false);
  await expect(frame.locator('#appSwitcherMenu')).toHaveAttribute('aria-hidden', 'false');
  await expect(frame.locator('#appSwitcherScrim')).toHaveCSS('position', 'fixed');
  await expect(frame.locator('#appSwitcherScrim')).toHaveCSS('visibility', 'visible');
  expect(await frame.locator('#appSwitcherScrim').evaluate(scrim => document.elementFromPoint(innerWidth - 8, innerHeight - 8) === scrim)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('drawer-open.png') });
  await page.keyboard.press('Escape');
  await expect(frame.locator('#appSwitcherToggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(frame.locator('#appSwitcherToggle')).toBeFocused();
  await expect(frame.locator('#appSwitcherShell')).toHaveCSS('width', '55px');
  await expect(frame.locator('#appSwitcherMenu')).toHaveJSProperty('inert', true);
  await expect(frame.locator('#appSwitcherMenu')).toHaveAttribute('aria-hidden', 'true');
  await expect(frame.locator('#appSwitcherScrim')).toHaveCSS('visibility', 'hidden');
  await page.screenshot({ path: testInfo.outputPath('drawer-closed.png') });
}

for (const mode of ['standalone', 'hosted']) {
  for (const viewport of [{ width: 940, height: 580 }, { width: 390, height: 580 }, { width: 320, height: 480 }]) {
    test(`MCP Help stays clear of status and controls while scrolling: ${mode} ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const frame = await openMcp(page, mode);
      await expect(frame.locator('#workspaceControls')).toHaveJSProperty('disabled', false);
      await expect(frame.locator('#setupChecks [data-check="opencode"] strong')).toHaveText('Configured');
      await expect(frame.locator('#ai-usage-notice')).toBeVisible();
      await expect(frame.locator('body')).toHaveCSS('font-family', '"Segoe UI", Arial, sans-serif');
      await expect(frame.locator('body')).toHaveCSS('font-size', '13px');
      await expect(frame.locator('#setupBtn')).toHaveCSS('font-family', '"Segoe UI", Arial, sans-serif');
      await expect(frame.locator('#setupBtn svg')).toHaveCSS('width', '18px');
      await expect(frame.locator('#setupBtn svg')).toHaveCSS('height', '18px');
      await expect(frame.locator('#addProjectBtn svg')).toHaveCSS('width', '16px');
      await expect(frame.locator('#addProjectBtn svg')).toHaveCSS('height', '16px');
      await expect.poll(() => frame.locator('#appSwitcherToggle img').evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
      if (mode === 'hosted') {
        await expect(page.locator('#context-help-open')).toBeHidden();
        await expect(frame.locator('.header')).toBeHidden();
      }
      await expect(frame.locator('#appSwitcherToggle')).toHaveAttribute('aria-expanded', 'false');
      await checkHelp(frame);
      await page.screenshot({ path: testInfo.outputPath('initial.png') });

      // Align the final setup status with Help's vertical band, not only the page end.
      await frame.locator('#setupChecks [data-check="opencode"] strong').evaluate(element => {
        scrollBy(0, element.getBoundingClientRect().bottom - (innerHeight - 30));
      });
      await page.screenshot({ path: testInfo.outputPath('status-band.png') });
      expect(await frame.locator('#setupChecks [data-check="opencode"] strong').evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const rect = range.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight
          && element.contains(document.elementFromPoint(rect.right - 1, rect.y + rect.height / 2));
      }), 'The configured-client status text must remain readable beside Help').toBe(true);
      await frame.locator('#setupBtn').scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath('setup-controls.png') });
      await frame.locator('.advanced-section summary').click();
      const overlap = await sweepForOcclusion(frame);
      await page.screenshot({ path: testInfo.outputPath(overlap ? 'occlusion.png' : 'scrolled-bottom.png') });
      expect(overlap, 'Help and the closed switcher must not obscure visible MCP status or controls while scrolling').toBeNull();
      expect(await frame.evaluate(() => scrollY), 'The regression must exercise actual document scrolling').toBeGreaterThan(0);
      await checkHelp(frame);
      expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (mode === 'standalone') await checkStandaloneHeader(page, frame, testInfo);

      await frame.locator('#context-help-open').click();
      await expect(frame.locator('#context-help-dialog')).toBeVisible();
      await expect(frame.locator('#context-help-title')).toContainText('Creator Works MCP');
      await page.screenshot({ path: testInfo.outputPath('help-dialog.png') });
      await frame.locator('#context-help-close').click();
      await frame.evaluate(() => scrollTo(0, 0));
      await checkHelp(frame);
      expect(errors).toEqual([]);
    });
  }
}
