const { test, expect } = require('@playwright/test');

test('Plugins mark renders the approved three-piece cube at menu size', async ({ page }, testInfo) => {
  await page.goto('http://127.0.0.1:4188');
  await page.locator('#hub-pages [data-view="hub"]').click();
  const mark = page.locator('.app-row .plugins-mark');
  await expect(mark.locator('img')).toHaveAttribute('src', 'icons/creator-plugins.png');
  await mark.locator('img').evaluate(image => image.decode());
  const colors = await mark.locator('img').evaluate(image => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 64, 64);
    const pixels = context.getImageData(0, 0, 64, 64).data;
    const counts = { cyan: 0, red: 0, gray: 0, transparent: 0 };
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b, a] = pixels.slice(i, i + 4);
      if (!a) counts.transparent++;
      if (a > 200 && r < 50 && g > 170 && b > 190) counts.cyan++;
      if (a > 200 && r > 200 && g < 120 && b < 120) counts.red++;
      if (a > 200 && r > 50 && r < 140 && g > r && b > g) counts.gray++;
    }
    return counts;
  });
  for (const color of ['cyan', 'red', 'gray', 'transparent']) expect(colors[color]).toBeGreaterThan(50);
  expect(await mark.boundingBox()).toMatchObject({ width: 34, height: 34 });
  await mark.screenshot({ path: testInfo.outputPath('plugins-icon-menu.png'), scale: 'css' });
  await page.evaluate(() => {
    const mark = document.querySelector('.plugins-mark').cloneNode(true);
    mark.style.cssText = 'width:192px;height:192px;display:grid;place-items:center';
    mark.querySelector('img').style.cssText = 'width:192px;height:192px';
    document.body.replaceChildren(mark);
    document.body.style.cssText = 'min-width:0;min-height:0;display:grid;place-items:center;width:240px;height:240px;padding:0;margin:0;background:#090c0e';
  });
  await page.setViewportSize({ width: 240, height: 240 });
  await page.screenshot({ path: testInfo.outputPath('plugins-icon.png') });
});
