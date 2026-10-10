const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  webServer: { command: 'node tests/server.cjs', url: 'http://127.0.0.1:4187', reuseExistingServer: false },
  use: { browserName: 'chromium', viewport: { width: 980, height: 760 } },
});
