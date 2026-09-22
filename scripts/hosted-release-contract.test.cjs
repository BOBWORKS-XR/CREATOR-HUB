const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('Windows releases use the guarded installer while native acceptance covers hosted apps', () => {
  const workflow = fs.readFileSync('.github/workflows/release.yml', 'utf8');
  const candidate = fs.readFileSync('.github/workflows/windows-candidate.yml', 'utf8');
  const build = fs.readFileSync('scripts/Build-Installer.ps1', 'utf8');
  assert.match(workflow, /Build-Installer\.ps1/);
  assert.match(workflow, /if: matrix\.hosted/);
  assert.match(build, /Ignore ambient developer pins/);
  assert.match(candidate, /Test native installs and both hosted applications/);
});
