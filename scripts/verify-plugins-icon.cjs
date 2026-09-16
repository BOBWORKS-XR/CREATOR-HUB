const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function verifyPluginsIcon(page, selector, expectedSha256) {
  const expected = fs.readFileSync(path.resolve(__dirname, '../src/icons/creator-plugins.png'));
  assert.equal(crypto.createHash('sha256').update(expected).digest('hex'), expectedSha256);
  const result = await page.locator(selector).evaluate(async (image, expectedPng) => {
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, 256, 256);
    const pixels = context.getImageData(0, 0, 256, 256).data;
    // Production permits image decoding, not arbitrary same-origin fetches.
    const reference = new Image();
    reference.src = `data:image/png;base64,${expectedPng}`;
    await reference.decode();
    context.clearRect(0, 0, 256, 256);
    context.drawImage(reference, 0, 0, 256, 256);
    const referencePixels = context.getImageData(0, 0, 256, 256).data;
    const decodedPixelsMatch = pixels.every((byte, index) => byte === referencePixels[index]);
    let transparent = 0, visible = 0, opaqueBorder = 0;
    for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
      const alpha = pixels[(y * 256 + x) * 4 + 3];
      if (!alpha) transparent++;
      if (alpha > 200) visible++;
      if ((x === 0 || y === 0 || x === 255 || y === 255) && alpha) opaqueBorder++;
    }
    return { decodedPixelsMatch, transparent, visible, opaqueBorder, width: image.naturalWidth, height: image.naturalHeight };
  }, expected.toString('base64'));
  assert.equal(result.decodedPixelsMatch, true, 'The installed view must render the accepted Plugins artwork');
  assert.equal(result.width, 256);
  assert.equal(result.height, 256);
  assert.ok(result.transparent > 6553, 'At least 10% real transparent background');
  assert.ok(result.visible > 20000, 'The logo itself must remain visible');
  assert.equal(result.opaqueBorder, 0, 'No opaque background or clipped artwork at the image border');
  return { ...result, expectedSourceSha256: expectedSha256 };
}

module.exports = { verifyPluginsIcon };
