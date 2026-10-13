const { test, expect } = require('@playwright/test');
const { helpOcclusion } = require('./help-layout.cjs');

test('layout checks refuse missing targets or a missing Help control', async ({ page }) => {
  await page.setContent('<button id="context-help-open" style="position:fixed;right:0;bottom:0">Help</button><footer><a href="#">Source</a></footer>');
  expect(await helpOcclusion(page, '.missing-footer')).toEqual({ kind: 'missing-targets', selector: '.missing-footer' });
  await page.locator('#context-help-open').evaluate(element => element.hidden = true);
  expect(await helpOcclusion(page, 'footer a')).toEqual({ kind: 'missing-help' });
  await page.locator('#context-help-open').evaluate(element => element.remove());
  expect(await helpOcclusion(page, 'footer a')).toEqual({ kind: 'missing-help' });
});
