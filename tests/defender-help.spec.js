const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const guidance = [
  ['Microsoft: investigate detections', 'defender-detections', 'https://learn.microsoft.com/en-us/defender-endpoint/defender-endpoint-false-positives-negatives'],
  ['Microsoft: Windows Security guidance', 'windows-security', 'https://support.microsoft.com/en-us/windows/security/threat-malware-protection/virus-and-threat-protection-in-the-windows-security-app'],
];

async function open(page) {
  // Keep startup pending while exercising the real shell resource-click handler.
  await page.route('**/usage-terms.js', route => route.fulfill({ contentType: 'text/javascript', body: 'window.CreatorUsageTerms = { requireAcceptance: () => new Promise(() => {}) };' }));
  await page.addInitScript(() => {
    window.calls = [];
    window.__CREATOR_HUB_FEATURE_PROTOCOL__ = 1;
    window.__TAURI__ = {
      core: { invoke: async (command, args) => {
        window.calls.push({ command, args });
        if (command !== 'open_resource' || Object.keys(args).length !== 1 || !['defender-detections', 'windows-security'].includes(args.resource)) throw new Error('Unexpected Help command');
        if (window.failOpen) throw new Error('Browser is unavailable.');
        return null;
      } },
      event: { listen: async () => () => {} },
    };
  });
  await page.goto('http://127.0.0.1:4188/');
}

test('Defender troubleshooting is conditional, explicit Help only, with no security actions', async ({ page }) => {
  await open(page);
  const dialog = page.locator('#context-help-dialog');
  const help = page.locator('#defender-help');
  await expect(dialog).toBeHidden();
  await page.locator('#context-help-open').click();
  await expect(help).not.toHaveAttribute('open');
  await help.locator('summary').click();
  for (const text of [
    'If Microsoft Defender blocks or quarantines', 'stop the affected operation', 'leave the file quarantined',
    'Do not assume a false positive or restore or allow an unknown file', 'Protection history',
    'exact detection name, affected file path, time, app/component version and build, and download source',
    'Update Defender security intelligence (definitions)', 'Protection updates > Check for updates',
    'report the details to the developer', 'Remove credentials and unrelated private information',
    'unsigned-app or SmartScreen "unrecognized app" reputation warning is different from a malware or Trojan detection',
    'does not prove a file is safe', 'Do not disable Defender',
    'ignore/exclusion rules for Node.js, PowerShell, Unity, projects or app folders',
    'reviewing and classifying detections before considering exclusions; exclusions reduce protection',
  ]) await expect(help).toContainText(text);
  await expect(help.locator('button:not([data-resource]), input, textarea, form, code, pre, a')).toHaveCount(0);
  await expect(help).not.toContainText(/Add-MpPreference|Set-MpPreference|Restore-MpThreat|Run anyway/);
  expect(await page.evaluate(() => window.calls)).toEqual([]);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(dialog).toBeHidden();
  await expect(help).not.toHaveAttribute('open');
});

test('official guidance opens only on explicit clicks through named native resources', async ({ page }) => {
  await open(page);
  await page.locator('#context-help-open').click();
  await page.locator('#defender-help summary').click();
  await expect(page.locator('#defender-help [data-resource]')).toHaveCount(guidance.length);
  const expected = [];
  for (const [name, resource] of guidance) {
    const link = page.getByRole('button', { name, exact: true });
    await expect(link).toHaveAttribute('data-resource', resource);
    await expect(link).toHaveAttribute('type', 'button');
    await link.focus();
    await expect(link).toBeFocused();
    expect(await page.evaluate(() => window.calls)).toEqual(expected);
    await link.click();
    expected.push({ command: 'open_resource', args: { resource } });
    expect(await page.evaluate(() => window.calls)).toEqual(expected);
    await expect(page.locator('#context-help-dialog')).toBeVisible();
    await expect(page).toHaveURL('http://127.0.0.1:4188/');
  }
  expect(page.context().pages()).toHaveLength(1);
});

test('native guidance resource IDs map to exact official URLs with unknown IDs refused', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src-tauri/src/main.rs'), 'utf8').replace(/\r\n/g, '\n');
  const resource = source.slice(source.indexOf('fn resource_url('), source.indexOf('#[tauri::command]\nfn open_resource('));
  for (const [, id, url] of guidance) expect(resource).toContain(`"${id}" => Some("${url}")`);
  expect(resource).toContain('_ => None,');
  expect(source).toContain('resource_url(&resource).ok_or("Unknown Creator resource.")?');
});

test('failed native browser opening reports the error without retry or browser fallback', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { window.failOpen = true; });
  await page.locator('#context-help-open').click();
  await page.locator('#defender-help summary').click();
  await page.getByRole('button', { name: guidance[0][0], exact: true }).click();
  await page.locator('#context-help-close').click();
  await expect(page.locator('#action-error')).toContainText('Browser is unavailable.');
  expect(await page.evaluate(() => window.calls)).toEqual([{ command: 'open_resource', args: { resource: guidance[0][1] } }]);
  expect(page.context().pages()).toHaveLength(1);
  await expect(page).toHaveURL('http://127.0.0.1:4188/');
});

test('integrated root Help describes included tools without separate-app installation instructions', async ({ page }) => {
  await open(page);
  await expect(page.locator('body')).toHaveClass(/integrated-home/);
  await page.locator('#context-help-open').click();
  const help = page.locator('#hub-help-content');
  await expect(help).toContainText('MCP and Project Setup are included');
  await expect(help).toContainText('Open them from the Creator tools menu; no separate app installation is needed');
  await expect(help).not.toContainText(/download\/install action in Apps|An app says Not installed|Which app do I need/);
  expect(await page.evaluate(() => window.calls)).toEqual([]);
});

test('one security Help entry survives Hub, MCP and Setup context changes without native calls', async ({ page }) => {
  await open(page);
  for (const feature of [null, 'mcp', 'setup', null]) {
    await page.evaluate(feature => window.CreatorFeaturePages.show(feature, { load: false }), feature);
    await expect(page.locator('#context-help-dialog')).toBeHidden();
    await page.locator('#context-help-open').click();
    await expect(page.locator('#context-help-title')).toHaveText(feature === 'mcp' ? 'Creator Works MCP help' : feature === 'setup' ? 'Project Setup help' : 'Creator Hub help');
    await expect(page.locator('#defender-help')).toHaveCount(1);
    await expect(page.locator('#defender-help summary')).toBeVisible();
    await page.locator('#context-help-close').click();
  }
  expect(await page.evaluate(() => window.calls)).toEqual([]);
});

for (const width of [940, 360]) test(`Defender Help remains readable at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 580 });
  await open(page);
  await page.locator('#context-help-open').click();
  await page.locator('#defender-help summary').click();
  const dialog = page.locator('#context-help-dialog');
  expect(await dialog.evaluate(node => {
    const box = node.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
      && node.scrollWidth <= node.clientWidth;
  })).toBe(true);
  expect(await page.locator('#defender-help').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  const lastLink = page.getByRole('button', { name: guidance[1][0], exact: true });
  await lastLink.scrollIntoViewIfNeeded();
  await expect(lastLink).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath(`defender-help-${width}.png`) });
  await page.locator('#context-help-close').click();
  await expect(dialog).toBeHidden();
});
