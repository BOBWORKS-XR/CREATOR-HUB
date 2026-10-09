const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('browser failures retain screenshots and traces without enabling automatic retries', () => {
  const config = require('../playwright.config.js');
  assert.equal(config.use.trace, 'retain-on-failure');
  assert.equal(config.use.screenshot, 'only-on-failure');
  assert.equal(config.retries || 0, 0);
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  const capture = workflow.indexOf('      - name: Retain browser failure diagnostics');
  assert.ok(capture > workflow.indexOf('      - run: npm run test:ui'));
  assert.match(workflow.slice(capture, workflow.indexOf('  hub-windows:', capture)), /if: failure\(\)/);
  assert.match(workflow.slice(capture, workflow.indexOf('  hub-windows:', capture)), /path: test-results\//);
});

test('native CI lints the actual Hub and both module sources before acceptance', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.equal((workflow.match(/cargo clippy --release --locked --manifest-path src-tauri\/Cargo.toml --all-targets -- -D warnings/g) || []).length, 3);
  for (const module of ['mcp/launcher', 'project-setup']) {
    const pattern = new RegExp(`cargo clippy --release --locked --manifest-path modules/${module}/src-tauri/Cargo\\.toml`, 'g');
    assert.equal((workflow.match(pattern) || []).length, 3);
  }
});

test('Windows release build uses the reviewed companion acceptance receipt', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /Build-Installer\.ps1[^\r\n]*-HostedPins scripts\/prerelease-apps\.json/);
  const preflight = workflow.indexOf('node scripts/check-companion-release-metadata.cjs');
  const build = workflow.indexOf('Build-Installer.ps1 -OutputName');
  const upload = workflow.indexOf('Upload the verified Windows installer to the draft release');
  assert.ok(preflight >= 0 && build > preflight && upload > preflight);
  assert.match(workflow.slice(preflight - 100, preflight + 220), /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
});

test('Windows candidate checks current signed companion releases before compiling the installer', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'windows-candidate.yml'), 'utf8');
  const preflight = workflow.indexOf('node scripts/check-companion-release-metadata.cjs');
  const build = workflow.indexOf('Build-WindowsCandidate.ps1 -HostedPins scripts/prerelease-apps.json');
  assert.ok(preflight >= 0 && build > preflight);
  assert.match(workflow, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
});

test('Windows native acceptance can target the checksum-verified installer from the tagged release', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'windows-candidate.yml'), 'utf8');
  const smoke = fs.readFileSync(path.join(__dirname, 'Test-InstalledCandidate.ps1'), 'utf8');
  assert.match(workflow, /release_version/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.match(workflow, /ExternalInstallerPath \$releaseInstaller/);
  assert.match(smoke, /Release installer preflight payload differs from its installed executable/);
});

test('newest companion installers are tested on disposable Windows before catalog signing', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'companion-install-smoke.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /RUNNER_ENVIRONMENT -ne 'github-hosted'/);
  assert.match(workflow, /RUNNER_OS -ne 'Windows'/);
  assert.match(workflow, /asset\.digest/);
  assert.equal((workflow.match(/probe-companion-identity\.mjs/g) ?? []).length, 2);
  assert.match(workflow, /Start-Process -FilePath \$installer -ArgumentList '\/S' -PassThru -Wait/);
  assert.match(workflow, /InstallLocation\)\.Trim\(\)\.Trim\('\"'\)/);
  assert.match(workflow, /installedHash -cne \$payloadHash/);
  assert.match(workflow, /payload\/\*\.exe/);
  const probe = fs.readFileSync(path.join(__dirname, 'probe-companion-identity.mjs'), 'utf8');
  assert.match(probe, /spawnSync\(binary, \['--creator-hub-info'\]/);
  assert.match(probe, /isolatedProbe: true/);
});

test('release workflow gates readiness on signed update discovery after assets and checksums exist', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
  const checksums = workflow.indexOf('  checksums:');
  const feedGate = workflow.indexOf('  release-feed-preflight:');
  assert.ok(checksums >= 0 && feedGate > checksums);
  const gate = workflow.slice(feedGate);
  assert.match(gate, /needs: \[checksums\]/);
  assert.match(gate, /node scripts\/check-release-feed\.cjs "\$version" --draft/);
  assert.match(gate, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
});
