const { chromium } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(path.resolve(__dirname, '../src/index.html')).href);
    await page.locator('.suite-trigger img').evaluate(img => img.decode());
    await page.evaluate(() => {
      // Render the same UI component used by the suite, retaining the original artwork.
      const mark = document.querySelector('.hub-mark').cloneNode(true);
      const style = document.createElement('style');
      style.textContent = ':root,html,body{background:transparent;color-scheme:normal;min-width:0;width:256px;height:256px;min-height:0;overflow:hidden}body{display:grid;place-items:center}.hub-mark{transform:scale(6)}';
      document.head.append(style);
      document.body.replaceChildren(mark);
    });
    await page.screenshot({ path: path.resolve(__dirname, '../src-tauri/icons/hub-source.png'), omitBackground: true });
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
