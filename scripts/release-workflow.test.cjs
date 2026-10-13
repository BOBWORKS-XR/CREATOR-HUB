const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('repository and native build workflows use the same explicit Rust compiler', () => {
  const root = path.join(__dirname, '..');
  const toolchain = fs.readFileSync(path.join(root, 'rust-toolchain.toml'), 'utf8');
  const version = toolchain.match(/^channel = "([0-9]+\.[0-9]+\.[0-9]+)"$/m);
  assert.ok(version, 'Compiler must be a pinned release, not a moving stable alias');
  for (const name of ['ci', 'unified-installed-candidate', 'unified-unix-candidate', 'self-update-acceptance', 'windows-candidate', 'release']) {
    const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', `${name}.yml`), 'utf8');
    const revisions = [...workflow.matchAll(/uses: dtolnay\/rust-toolchain@([^\s]+)/g)];
    assert.ok(revisions.length, `${name} must install the repository compiler`);
    for (const revision of revisions) assert.equal(revision[1], version[1], name);
  }
});

test('superseded branch test builds cancel without adding cancellation to publishing', () => {
  const root = path.join(__dirname, '..', '.github', 'workflows');
  for (const name of ['ci', 'unified-installed-candidate', 'unified-unix-candidate', 'unix-package-probe']) {
    const workflow = fs.readFileSync(path.join(root, `${name}.yml`), 'utf8');
    assert.match(workflow, /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.head_ref \|\| github\.ref_name \}\}/);
    assert.match(workflow, /cancel-in-progress: true/);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'release.yml'), 'utf8'), /cancel-in-progress: true/);
});

test('native archive changes trigger packaging and required Linux tools are tested in that lane', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'unified-unix-candidate.yml'), 'utf8');
  for (const trigger of ['scripts/module-archive*', 'native/module-archive/**', 'src-tauri/src/builtin.rs', 'src-tauri/src/module_archive.rs']) {
    assert.ok(workflow.includes(`- '${trigger}'`), `${trigger} must trigger real native packages`);
  }
  assert.match(workflow, /options: \[all, linux, macos-arm64, macos-intel\]/);
  assert.match(workflow, /fromJSON\(inputs\.platform == 'linux'/);
  assert.match(workflow, /CREATOR_NATIVE_ARCHIVE_TESTS: '1'/);
  assert.match(workflow, /cargo build --release --locked --manifest-path native\/module-archive\/Cargo.toml/);
  assert.match(workflow, /node --test scripts\/module-archive-native\.test\.cjs scripts\/linux-hub-runpath\.test\.cjs/);
  assert.match(workflow, /patchelf build-essential file rpm libarchive-tools/);
  const packageStep = workflow.slice(workflow.indexOf('      - name: Build and inspect real included payloads'));
  assert.match(packageStep, /CARGO_TARGET_DIR: \$\{\{ github\.workspace \}\}\/src-tauri\/target/);
});

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
    // One native command per step prevents a later success masking a PowerShell failure.
    const pattern = new RegExp(`      run: cargo clippy --release --locked --manifest-path modules/${module}/src-tauri/Cargo\\.toml`, 'g');
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
