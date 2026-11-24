const { test, expect } = require('@playwright/test');

for (const [width, version, denied] of [[940, '0.1.27', false], [320, 'private/path', true]]) {
  test(`support check-in at ${width}px previews only voluntary answers and the Hub version`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 580 });
    await page.route('**/usage-terms.js', route => route.fulfill({ contentType: 'text/javascript',
      body: 'window.CreatorUsageTerms = { requireAcceptance: () => new Promise(() => {}) };' }));
    await page.addInitScript(({ version, denied }) => {
      window.__CREATOR_HUB_VERSION__ = version;
      window.__CREATOR_HUB_FEATURE_PROTOCOL__ = 1;
      window.nativeCalls = [];
      window.__TAURI__ = { core: { invoke: name => { window.nativeCalls.push(name); throw Error(name); } },
        event: { listen: async () => () => {} } };
      window.copies = [];
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => {
        if (denied) throw Error('Unavailable'); window.copies.push(text);
      } } });
    }, { version, denied });
    await page.goto('http://127.0.0.1:4188/');
    await page.locator('#context-help-open').click();
    const panel = page.locator('#support-check-in');
    await expect(panel).not.toHaveAttribute('open');
    const requests = [];
    page.on('request', req => requests.push(req.url()));
    await panel.locator('summary').click();
    const prefix = 'Creator Hub: ' + (denied ? 'Not available' : version);
    const preview = page.getByRole('textbox', { name: 'Text to share' });
    await expect(preview).toHaveValue(prefix + '\nI open MCP: Not sure\nStatus: Not sure');
    const entry = denied ? 'Separate MCP app' : 'Apps page in the old Hub';
    await page.getByLabel('Where do you usually open MCP?').selectOption({ label: entry });
    await page.getByLabel('How is it going?').selectOption({ label: 'Stuck moving to Hub' });
    const expected = prefix + '\nI open MCP: ' + entry + '\nStatus: Stuck moving to Hub';
    await expect(preview).toHaveValue(expected);
    expect(await page.evaluate(() => window.copies)).toEqual([]);
    await page.getByRole('button', { name: 'Copy for support' }).click();
    await expect(page.locator('#support-copy-status')).toContainText(denied ? 'Text selected' : 'Copied.');
    expect(await page.evaluate(() => window.copies)).toEqual(denied ? [] : [expected]);
    if (denied) {
      await expect(preview).toBeFocused();
      expect(await preview.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd))).toBe(expected);
    }
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => window.nativeCalls)).toEqual([]);
    expect(requests).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('builder-check-in.png') });
  });
}
