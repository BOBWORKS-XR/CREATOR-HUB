const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests',
  use: { browserName: 'chromium', viewport: { width: 940, height: 580 } },
  webServer: { command: 'node tests/server.cjs', url: 'http://127.0.0.1:4188', reuseExistingServer: false },
});
