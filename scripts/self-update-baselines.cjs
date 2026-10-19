const assert = require('node:assert/strict');
const semver = require('semver');

const baselines = Object.freeze([
  Object.freeze({
    version: '0.1.11', asset: 'Creator.Hub_0.1.11_x64-setup.exe',
    installer: '90018f10096a52ad9abb5e2f8634acd6f8dfcea39cffd7ca2e25b92a54a7f07e',
    exe: 'b1ed8b37debb0e9e650ccdd62b954bd68e054590d1821092b25e68f545600c21',
  }),
  Object.freeze({
    version: '0.1.12', asset: 'Creator.Hub_0.1.12_x64-setup.exe',
    installer: '0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18',
    exe: '34c6f05548f469ac23b4faee7aa8355d5cca083c444c4f7b0942426a9c76a7ac',
  }),
  Object.freeze({
    version: '0.1.14', asset: 'Creator.Hub_0.1.14_x64-setup.exe',
    installer: '284820f92de487e8a0f1bb5b3b99cafe5e073f0402a9350a2ea6e76fa9543157',
    exe: 'cd5e3fd2829727d06444c0f3266b178798d1b55c63df651be12eb38ac4523a86',
  }),
]);

function selectBaseline(targetVersion) {
  const target = typeof targetVersion === 'string' && semver.parse(targetVersion);
  if (!target || target.version !== targetVersion || target.build.length) {
    throw Error('Target must be canonical SemVer without build metadata.');
  }
  const baseline = baselines.filter(item => semver.lt(item.version, targetVersion))
    .sort((a, b) => semver.rcompare(a.version, b.version))[0];
  if (!baseline) throw Error(`No pinned public stable baseline is older than ${targetVersion}.`);
  // Fixtures replace their local hashes, never the public registry's pins.
  return { ...baseline };
}

function assertPreviousStable(previousStable, baseline) {
  assert.equal(previousStable, baseline.version, 'Exercise the previous public stable Hub, not an arbitrary older baseline');
}

module.exports = { baselines, selectBaseline, assertPreviousStable };
if (require.main === module) {
  try {
    if (process.argv.length > 3) throw Error('Usage: node scripts/self-update-baselines.cjs [TARGET-VERSION]');
    console.log(JSON.stringify(selectBaseline(process.argv[2] ?? require('../package.json').version)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
