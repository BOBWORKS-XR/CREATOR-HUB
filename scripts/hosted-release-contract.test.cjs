const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

test('Windows draft qualification reuses immutable accepted bytes without rebuilding or publishing', () => {
  const workflow = fs.readFileSync('.github/workflows/release.yml', 'utf8');
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  assert.match(workflow, /^name: Validate Qualified Windows Draft \(No Rebuild\)/);
  assert.ok(workflow.includes(`$receipt = 'packaging/windows/${version}-qualification.json'`));
  const qualification = 'node scripts/check-unified-sources.cjs --release --version "$version" --platform windows-x86_64 --receipt "$receipt" --verify-draft';
  const feed = 'node scripts/check-release-feed.cjs "$version" --draft';
  assert.ok(workflow.includes(qualification));
  assert.ok(workflow.indexOf(feed) > workflow.indexOf(qualification));
  assert.match(workflow, /if \(\$LASTEXITCODE -ne 0\) \{ throw 'Exact Windows qualification or current remote evidence refused\.'/);
  assert.match(workflow, /if \(\$LASTEXITCODE -ne 0\) \{ throw 'Legacy public-client feed budget refused\.'/);
  assert.doesNotMatch(workflow, /Build-(?:Installer|WindowsCandidate)\.ps1|build:unified|cargo (?:build|test|clippy)\b|tauri-apps\/tauri-action|--clobber/);
  assert.doesNotMatch(workflow, /gh release (?:create|edit|upload)|node scripts\/publish-hub-draft\.cjs|--draft=false|--latest(?:=true)?(?:\s|$)/);
});

test('Windows candidates retain the guarded installer and separate native hosted-app acceptance', () => {
  const candidate = fs.readFileSync('.github/workflows/windows-candidate.yml', 'utf8');
  const candidateBuild = fs.readFileSync('scripts/Build-WindowsCandidate.ps1', 'utf8');
  const build = fs.readFileSync('scripts/Build-Installer.ps1', 'utf8');
  assert.match(candidate, /Build-WindowsCandidate\.ps1 -HostedPins scripts\/prerelease-apps\.json/);
  assert.match(candidateBuild, /Build-Installer\.ps1'\) -OutputName \$OutputName -HostedPins \$HostedPins/);
  assert.match(build, /Ignore ambient developer pins/);
  assert.match(candidateBuild, /Test-InstallerGuard\.ps1/);
  assert.match(candidateBuild, /Test-InstalledCandidate\.ps1/);
  assert.match(candidateBuild, /selfUpdateTested = \$false/);
  assert.match(candidateBuild, /publicationReady = \$false/);
  assert.match(candidate, /Test native installs and both hosted applications/);
});
