const { test, expect } = require('@playwright/test');
const { setupOperationFinished } = require('../scripts/native-smoke-state.cjs');

test('native smoke does not treat a hidden hosted view as finished', async ({ page }) => {
  await page.setContent('<iframe style="display:none" srcdoc="<div id=activity>Importing</div><div id=result class=hidden></div>"></iframe>');
  const frame = page.frames().find(item => item.parentFrame());
  await expect(frame.locator('#activity')).toBeHidden();
  expect(await frame.evaluate(setupOperationFinished)).toBe(false);
  // A hidden WebView can suspend animation frames; completion uses timed polling.
  const completion = frame.waitForFunction(setupOperationFinished, null, { timeout:2000, polling:50 });
  await frame.evaluate(() => {
    document.querySelector('#activity').classList.add('hidden');
    document.querySelector('#result').classList.remove('hidden');
    document.querySelector('#result').textContent = 'Ready';
  });
  await completion;
  expect(await frame.evaluate(setupOperationFinished)).toBe(true);
});

test('native smoke distinguishes a finished failure from empty or missing output', async ({ page }) => {
  await page.setContent('<div id=activity class=hidden></div><div id=result></div>');
  expect(await page.evaluate(setupOperationFinished)).toBe(false);
  await page.locator('#result').evaluate(element => { element.textContent = 'Setup stopped'; });
  expect(await page.evaluate(setupOperationFinished)).toBe(true);
  await page.locator('#result').evaluate(element => element.remove());
  expect(await page.evaluate(setupOperationFinished)).toBe(false);
});
