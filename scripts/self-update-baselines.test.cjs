const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { baselines, selectBaseline, assertPreviousStable } = require('./self-update-baselines.cjs');

test('registry retains exact public 0.1.11, 0.1.12 and 0.1.14 artifact pins', () => {
  assert.deepEqual(baselines, [
    {
      version: '0.1.11', asset: 'Creator.Hub_0.1.11_x64-setup.exe',
      installer: '90018f10096a52ad9abb5e2f8634acd6f8dfcea39cffd7ca2e25b92a54a7f07e',
      exe: 'b1ed8b37debb0e9e650ccdd62b954bd68e054590d1821092b25e68f545600c21',
    },
    {
      version: '0.1.12', asset: 'Creator.Hub_0.1.12_x64-setup.exe',
      installer: '0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18',
      exe: '34c6f05548f469ac23b4faee7aa8355d5cca083c444c4f7b0942426a9c76a7ac',
    },
    {
      version: '0.1.14', asset: 'Creator.Hub_0.1.14_x64-setup.exe',
      installer: '284820f92de487e8a0f1bb5b3b99cafe5e073f0402a9350a2ea6e76fa9543157',
      exe: 'cd5e3fd2829727d06444c0f3266b178798d1b55c63df651be12eb38ac4523a86',
    },
  ]);
  assert.ok(Object.isFrozen(baselines));
  assert.ok(baselines.every(Object.isFrozen));
});

test('stable targets select the highest pinned version strictly below the target', () => {
  for (const [target, expected] of [['0.1.12', '0.1.11'], ['0.1.13', '0.1.12'], ['0.1.14', '0.1.12'], ['0.1.15', '0.1.14'], ['0.1.16', '0.1.14'], ['0.1.20', '0.1.14'], ['1.0.0', '0.1.14']]) {
    assert.equal(selectBaseline(target).version, expected, target);
  }
});

test('prereleases use SemVer ordering and only public stable baselines', () => {
  for (const [target, expected] of [['0.1.12-alpha.1', '0.1.11'], ['0.1.12-rc.10', '0.1.11'], ['0.1.13-alpha.1', '0.1.12'], ['0.1.14-rc.1', '0.1.12'], ['0.1.16-rc.1', '0.1.14']]) {
    assert.equal(selectBaseline(target).version, expected, target);
  }
});

test('same-version and older targets cannot select an ineligible baseline', () => {
  for (const target of ['0.1.11', '0.1.11-rc.1', '0.0.9']) {
    assert.throws(() => selectBaseline(target), /No pinned public stable baseline is older/);
  }
  assert.notEqual(selectBaseline('0.1.12').version, '0.1.12');
});

test('invalid, noncanonical and build-metadata targets fail closed', () => {
  for (const target of ['', undefined, null, 13, 'v0.1.13', '0.1', '0.1.013', '0.1.13 ', '0.1.13+build', '0.1.13-']) {
    assert.throws(() => selectBaseline(target), /canonical SemVer without build metadata/);
  }
});

test('fixture hash overrides cannot mutate public pins or later selections', () => {
  const baseline = selectBaseline('0.1.13');
  const original = { ...baseline };
  baseline.installer = 'a'.repeat(64);
  baseline.exe = 'b'.repeat(64);
  assert.deepEqual(selectBaseline('0.1.13'), original);
});

test('actual public previous stable must exactly match the selected pins', () => {
  assertPreviousStable('0.1.11', selectBaseline('0.1.12'));
  assertPreviousStable('0.1.12', selectBaseline('0.1.13'));
  assertPreviousStable('0.1.14', selectBaseline('0.1.16'));
  assert.throws(() => assertPreviousStable('0.1.12', selectBaseline('0.1.16')), /previous public stable Hub/);
  for (const previous of ['0.1.11', '0.1.13', '0.1.12-rc.1', null, undefined]) {
    assert.throws(() => assertPreviousStable(previous, selectBaseline('0.1.14')), /previous public stable Hub/);
  }
});

test('CLI selects from the checked-out target by default and permits explicit test targets', () => {
  const run = args => spawnSync(process.execPath, [require.resolve('./self-update-baselines.cjs'), ...args], { encoding: 'utf8' });
  const current = run([]);
  assert.equal(current.status, 0, current.stderr);
  assert.deepEqual(JSON.parse(current.stdout), selectBaseline(require('../package.json').version));
  for (const [target, expected] of [['0.1.12', '0.1.11'], ['0.1.13', '0.1.12'], ['0.1.13-alpha.1', '0.1.12'], ['0.1.16', '0.1.14']]) {
    const result = run([target]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).version, expected);
  }
  for (const args of [['0.1.11'], ['0.1.13+build'], [''], ['0.1.13', 'extra']]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
});
