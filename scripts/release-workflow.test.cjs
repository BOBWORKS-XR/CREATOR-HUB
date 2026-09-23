const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Windows release build uses the reviewed companion acceptance receipt', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /Build-Installer\.ps1[^\r\n]*-HostedPins scripts\/prerelease-apps\.json/);
});
