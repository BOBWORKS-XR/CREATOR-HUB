const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Windows release build uses the reviewed companion acceptance receipt', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /Build-Installer\.ps1[^\r\n]*-HostedPins scripts\/prerelease-apps\.json/);
});

test('Windows candidate checks current signed companion releases before compiling the installer', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'windows-candidate.yml'), 'utf8');
  const preflight = workflow.indexOf('node scripts/check-companion-release-metadata.cjs');
  const build = workflow.indexOf('Build-WindowsCandidate.ps1 -HostedPins scripts/prerelease-apps.json');
  assert.ok(preflight >= 0 && build > preflight);
  assert.match(workflow, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
});
