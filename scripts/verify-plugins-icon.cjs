const assert = require('node:assert/strict');

async function verifyPluginsIcon(page, selector, expectedSha256) {
  const result = await page.locator(selector).evaluate(async image => {
    await image.decode();
    const response = await fetch(image.src);
    if (!response.ok) throw new Error('Packaged Plugins image could not be read');
    const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer());
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 256, 256);
    const pixels = context.getImageData(0, 0, 256, 256).data;
    let transparent = 0, visible = 0, opaqueBorder = 0;
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const alpha = pixels[(y * 256 + x) * 4 + 3];
      if (!alpha) transparent++;
      if (alpha > 200) visible++;
      if ((x === 0 || y === 0 || x === 255 || y === 255) && alpha) opaqueBorder++;
    }
    return { sha256, transparent, visible, opaqueBorder, width: image.naturalWidth, height: image.naturalHeight };
  });
  assert.equal(result.sha256, expectedSha256, 'The installed view must use the accepted Plugins artwork');
  assert.equal(result.width, 256);
  assert.equal(result.height, 256);
  assert.ok(result.transparent > 6553, 'At least 10% real transparent background');
  assert.ok(result.visible > 20000, 'The logo itself must remain visible');
  assert.equal(result.opaqueBorder, 0, 'No opaque background or clipped artwork at the image border');
  return result;
}

module.exports = { verifyPluginsIcon };
