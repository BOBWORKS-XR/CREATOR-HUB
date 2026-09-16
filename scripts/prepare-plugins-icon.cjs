const { chromium } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const source = process.argv[2];
  if (!source) throw new Error('Supply the approved transparent PNG source.');
  const png = await fs.readFile(path.resolve(source));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
    await page.setContent('<style>html,body{margin:0;background:transparent}img{display:block;width:256px;height:256px}</style><img alt="">');
    await page.locator('img').evaluate(async (img, data) => {
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const context = canvas.getContext('2d');
      context.drawImage(img, 0, 0, 256, 256);
      const pixels = context.getImageData(0, 0, 256, 256).data;
      let transparent = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] === 0) transparent++;
      if (transparent < 6554) throw new Error('Source must have real transparency, not a painted checkerboard. Existing icon was not changed.');
    }, png.toString('base64'));
    await page.screenshot({ path: path.resolve(__dirname, '../src/icons/creator-plugins.png'), omitBackground: true });
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
