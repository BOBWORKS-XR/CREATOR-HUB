const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const semver = require('semver');

const root = path.resolve(__dirname, '..');
const modulePaths = { mcp: 'modules/mcp', setup: 'modules/project-setup' };

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest.product !== 'Creator Hub'
    || manifest.repository !== 'BOBWORKS-XR/CREATOR-HUB' || manifest.appId !== 'com.creatorworks.hub'
    || manifest.phase !== 'source-consolidation' || !semver.valid(manifest.baselineHub)
    || !manifest.modules || Object.keys(manifest.modules).sort().join(',') !== 'mcp,setup') {
    throw Error('Invalid unified source manifest.');
  }
  for (const [id, expectedPath] of Object.entries(modulePaths)) {
    const entry = manifest.modules[id];
    const frontend = id === 'mcp' ? `${expectedPath}/launcher/src` : `${expectedPath}/src`;
    const repository = id === 'mcp' ? 'CREATOR-WORKS-UNITY-MCP' : 'CREATOR-PROJECT-SETUP';
    if (entry?.path !== expectedPath || entry.frontend !== frontend
      || entry.legacyRepository !== `BOBWORKS-XR/${repository}`
      || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(entry.baselineTag)
      || !/^[0-9a-f]{40}$/.test(entry.baselineRevision)) {
      throw Error(`Invalid ${id} source provenance or path.`);
    }
  }
  return manifest;
}

function assertReleaseReady(manifest) {
  validateManifest(manifest);
  throw Error('Source consolidation is not a unified release. Built-in packaging and legacy migration acceptance are still required.');
}

function checkSources(directory, manifest) {
  validateManifest(manifest);
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'src-tauri/tauri.conf.json'), 'utf8'));
  if (config.productName !== manifest.product || config.identifier !== manifest.appId) {
    throw Error('Keep the established Hub product identity for existing updates.');
  }
  const helpers = ['unity/com.creatorworks.plugins/Editor/CreatorPluginsWindow.cs',
    `${manifest.modules.mcp.path}/launcher/unity/com.creatorworks.plugins/Editor/CreatorPluginsWindow.cs`,
    `${manifest.modules.setup.path}/unity/com.creatorworks.plugins/Editor/CreatorPluginsWindow.cs`];
  const hashes = helpers.map(file => crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex'));
  if (new Set(hashes).size !== 1) throw Error('Unity catalogue helpers differ between Hub modules.');
  const retirementViews = ['src/community.js', ...Object.values(manifest.modules).map(entry => `${entry.frontend}/community.js`)];
  const retirementHashes = retirementViews.map(file => crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex'));
  if (new Set(retirementHashes).size !== 1) throw Error('Plugins retirement views differ between Hub modules.');
  for (const entry of Object.values(manifest.modules)) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(directory, entry.path, 'package.json'), 'utf8'));
    if (!semver.valid(packageJson.version)) throw Error(`Invalid module version: ${entry.path}`);
    if (!fs.statSync(path.join(directory, entry.frontend, 'index.html')).isFile()) {
      throw Error(`Missing module interface: ${entry.frontend}`);
    }
  }
  return { phase: manifest.phase, product: manifest.product, helperSha256: hashes[0], modules: Object.keys(manifest.modules) };
}

function verifyImports(directory, manifest) {
  validateManifest(manifest);
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true }).trim();
  for (const entry of Object.values(manifest.modules)) {
    const expected = git(['rev-parse', `${entry.baselineRevision}^{tree}`]);
    const actual = git(['rev-parse', `HEAD:${entry.path}`]);
    if (actual !== expected) throw Error(`Initial import differs from accepted source: ${entry.path}`);
    git(['merge-base', '--is-ancestor', entry.baselineRevision, 'HEAD']);
  }
}

module.exports = { validateManifest, assertReleaseReady, checkSources, verifyImports };
if (require.main === module) {
  try {
    const flags = process.argv.slice(2);
    if (flags.some(flag => !['--verify-imports', '--release'].includes(flag))) throw Error('Unknown source check option.');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'modules/suite.json'), 'utf8'));
    const result = checkSources(root, manifest);
    if (flags.includes('--verify-imports')) verifyImports(root, manifest);
    if (flags.includes('--release')) assertReleaseReady(manifest);
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
