const path = require('node:path');
const { expect } = require('@playwright/test');

// Controlled catalogue/media fixtures in the actual packaged WebView. No imports.
async function verifyCommunityMedia(page, out) {
  const fixture = require('../tests/fixtures/community/start-location.json');
  const pattern = 'https://cdn.sidequestvr.com/file/1/gallery-test-*';
  const route = request => {
    const extension = new URL(request.request().url()).pathname.split('.').pop();
    return request.fulfill({ path: path.resolve(__dirname, '../tests/fixtures/community', extension === 'png' ? 'preview.png' : `demo.${extension}`), contentType: extension === 'webm' ? 'video/webm' : `image/${extension}`, headers: { 'access-control-allow-origin': '*' } });
  };
  await page.route(pattern, route);
  const items = Array.from({ length: 6 }, (_, i) => ({ type: 'image', url: `https://cdn.sidequestvr.com/file/1/gallery-test-${i}.png` }));
  items.push(...['gif', 'webm'].map(type => ({ type, url: `https://cdn.sidequestvr.com/file/1/gallery-test-demo.${type}`, poster: items[0].url })));
  await expect(page.getByRole('button', { name: 'Refresh catalogue', exact: true })).toBeEnabled({ timeout: 90_000 });
  await page.evaluate(({ fixture, items }) => {
    window.__mediaTestPrevious = window.CreatorCommunityInvoke;
    window.CreatorCommunityInvoke = async command => {
      if (command !== 'community_catalogue') throw Error('Fixture permits catalogue only');
      return { entries: [{ ...fixture, previewImage: items[0].url }], media: [{ id: fixture.id, items }], warnings: [], stale: false };
    };
  }, { fixture, items });
  try {
    await page.getByRole('button', { name: 'Refresh catalogue', exact: true }).click();
    await page.getByRole('button', { name: 'Enlarge Start Location preview' }).click();
    for (let i = 0; i < 8; i++) {
      await expect(page.locator('.community-media-count')).toHaveText(`${i + 1} / 8`);
      await expect.poll(() => page.locator('.community-media-stage img').evaluateAll(images => images.length === 1 && images[0].naturalWidth > 0)).toBe(true);
      if (i >= 6) {
        await page.getByRole('button', { name: i === 6 ? 'Load animation' : 'Load video', exact: true }).click();
        await expect.poll(() => page.locator(`.community-media-stage ${i === 6 ? 'img' : 'video'}`).evaluateAll(elements => elements.length === 1 && (elements[0].naturalWidth || elements[0].videoWidth) === 64)).toBe(true);
      }
      if (i < 7) await page.getByRole('button', { name: 'Next preview' }).click();
    }
    await page.locator('.community-media-stage video').evaluate(video => video.play());
    await expect.poll(() => page.locator('.community-media-stage video').evaluate(video => video.currentTime)).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(out, 'packaged-gallery-video.png') });
    await page.getByRole('button', { name: 'Close preview', exact: true }).click();
    // Dialog close dispatches its cleanup event in a later browser task.
    await expect(page.locator('.community-media-stage video')).toHaveCount(0);
    return { passed: true, staticImages: 6, gif: true, webm: true, fixture: true, importsStarted: false };
  } finally {
    await page.evaluate(() => { window.CreatorCommunity.closePreview(); window.CreatorCommunityInvoke = window.__mediaTestPrevious; delete window.__mediaTestPrevious; });
    await page.unroute(pattern, route);
    await page.getByRole('button', { name: 'Refresh catalogue', exact: true }).click();
  }
}
module.exports = { verifyCommunityMedia };
