const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const baselines = [
  { product: 'Creator Hub', repo: 'CREATOR-HUB', version: '0.1.12', asset: 'Creator.Hub_0.1.12_x64-setup.exe', sha256: '0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18', binary: 'creator-hub.exe' },
  { product: 'Creator Works MCP', repo: 'CREATOR-WORKS-UNITY-MCP', version: '2.7.7', asset: 'Creator.Works.MCP_2.7.7_x64-setup.exe', sha256: 'fa0b0ebc39043bf276de73763d380c001c84d1efd24dca9f9c2427b120a5afe0', binary: 'creator-works-mcp-launcher.exe' },
  { product: 'Creator Project Setup', repo: 'CREATOR-PROJECT-SETUP', version: '0.3.7', asset: 'Creator.Project.Setup_0.3.7_x64-setup.exe', sha256: '223bbc00bf7f861efe1760310a4be4cbedfc9829c4d3841fae0a84038bc7e47b', binary: 'creator-project-setup.exe' },
];
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function requireDisposable() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Windows') {
    throw Error('Installed unified acceptance is restricted to a disposable GitHub-hosted Windows runner.');
  }
}
function install(mode, candidate, out, seedBeforeInstall = () => {}) {
  requireDisposable();
  assert.ok(['fresh', 'upgrade'].includes(mode), 'Unknown installed acceptance mode');
  const installs = baselines.map(b => ({ ...b, directory: path.join(process.env.LOCALAPPDATA, b.product) }));
  for (const b of installs) assert.equal(fs.existsSync(b.directory), false, 'Runner must start without Creator installs');
  const report = { mode, scope: 'Direct unsigned candidate installation/reinstallation, not signed in-app updater acceptance', baselines: [] };
  if (mode === 'upgrade') {
    for (const b of installs) {
      const downloads = path.join(out, b.repo); fs.mkdirSync(downloads);
      execFileSync('gh', ['release', 'download', `v${b.version}`, '--repo', `BOBWORKS-XR/${b.repo}`, '--pattern', b.asset, '--dir', downloads], { windowsHide: true, timeout: 120000, stdio: 'pipe' });
      const installer = path.join(downloads, b.asset);
      assert.equal(sha256(installer), b.sha256, 'Published baseline installer changed');
      execFileSync(installer, ['/S'], { windowsHide: true, timeout: 180000, stdio: 'pipe' });
      b.before = sha256(path.join(b.directory, b.binary));
      report.baselines.push({ product: b.product, version: b.version, installerSha256: b.sha256, executableSha256: b.before });
    }
  }
  fs.writeFileSync(path.join(out, 'installed-baseline.json'), JSON.stringify(report, null, 2));
  seedBeforeInstall();
  const metadata = JSON.parse(fs.readFileSync(path.join(candidate, 'installer-checksum.json')));
  assert.equal(metadata.acceptanceOnly, true); assert.equal(metadata.signed, false);
  const installer = path.join(candidate, 'installer.exe');
  assert.equal(sha256(installer), metadata.sha256);
  execFileSync(installer, ['/S'], { windowsHide: true, timeout: 180000, stdio: 'pipe' });
  const directory = installs[0].directory;
  assert.equal(sha256(path.join(directory, 'creator-hub.exe')), sha256(path.join(candidate, 'creator-hub.exe')), 'Installed Hub must match the exact candidate');
  if (mode === 'upgrade') {
    assert.notEqual(sha256(path.join(directory, 'creator-hub.exe')), installs[0].before, 'The published Hub must actually have been replaced');
    for (const b of installs.slice(1)) assert.equal(sha256(path.join(b.directory, b.binary)), b.before, 'Legacy app must not be silently replaced or uninstalled');
  }
  report.candidateInstallerSha256 = metadata.sha256;
  report.installedHubSha256 = sha256(path.join(directory, 'creator-hub.exe'));
  report.passed = true;
  fs.writeFileSync(path.join(out, 'installed-baseline.json'), JSON.stringify(report, null, 2));
  return { directory, expectedRegistrations: mode === 'upgrade' ? installs.map(b => b.product) : ['Creator Hub'], oldMcp: installs[1].directory };
}
module.exports = { install, requireDisposable, baselines };
