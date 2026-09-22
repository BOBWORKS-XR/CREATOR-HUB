const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('Windows releases require approved companion pins and binary verification', () => {
  const workflow = fs.readFileSync('.github/workflows/release.yml', 'utf8');
  const build = fs.readFileSync('scripts/Build-Installer.ps1', 'utf8');
  assert.match(workflow, /Build-Installer\.ps1[\s\S]*-HostedPins scripts\\prerelease-apps\.json/);
  assert.match(workflow, /if: matrix\.hosted/);
  assert.match(build, /Packaged Hub is missing the approved \$app hosting pin/);
  assert.match(build, /CREATOR_SETUP_HOST_SHA256/);
  assert.match(build, /CREATOR_MCP_HOST_SHA256/);
});
