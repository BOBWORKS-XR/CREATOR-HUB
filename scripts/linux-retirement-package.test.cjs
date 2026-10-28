const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { build, parseBuildOptions, moduleFiles } = require('./build-unified.cjs');
const { routeFiles } = require('./managed-router-package.cjs');
const { validatePackages, nativePlan } = require('./unix-package-payload.cjs');
const packaging = require('./linux-retirement-package.cjs');
const repo = path.resolve(__dirname, '..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const accepted = { enabled: true, platform: 'linux', arch: 'x86_64', installer: true, managed: true,
  experimentalUnix: true, experimentalWritable: true, prepareManagedUnix: false, signedUnixInput: path.resolve('/signed-input') };

test('acceptance-only option is finite, opt-in and unavailable to default, Windows, Mac or unsigned preparation', () => {
  packaging.checkOptions(accepted);
  packaging.checkOptions({ enabled: false });
  for (const change of [{ enabled: 'true' }, { enabled: null }, { platform: 'windows' }, { platform: 'macos' },
    { arch: 'aarch64' }, { installer: false }, { managed: false }, { experimentalUnix: false },
    { experimentalWritable: false }, { prepareManagedUnix: true }, { signedUnixInput: null }, { signedUnixInput: 'relative' }]) {
    assert.throws(() => packaging.checkOptions({ ...accepted, ...change }), undefined, JSON.stringify(change));
  }
  assert.deepEqual(parseBuildOptions(['--linux-retirement-test-candidate']), { linuxRetirementCandidate: true });
  assert.throws(() => parseBuildOptions(['--linux-retirement-test-candidate', '--linux-retirement-test-candidate']), /Duplicate/);
  const calls = [];
  assert.throws(() => build('never-create', { linuxRetirementCandidate: true }, { platform: 'windows', arch: 'x86_64', execute: (...args) => calls.push(args) }), /signed native Linux/);
  assert.deepEqual(calls, []);
  assert.throws(() => nativePlan('linux', 'x86_64'), /refuses by default/);
  assert.deepEqual(nativePlan('windows', 'x86_64', { installer: true }).bundles, ['nsis']);
});

test('recipe adds only two fixed DEB files, explicit native dependency and test-only labeling', () => {
  const recipe = JSON.parse(fs.readFileSync(path.join(repo, 'packaging/linux/tauri-retirement-acceptance.json')));
  assert.deepEqual(Object.keys(recipe), ['build', 'bundle']);
  assert.deepEqual(recipe.build, { features: ['experimental-linux-migration'] });
  assert.deepEqual(Object.keys(recipe.bundle).sort(), ['linux', 'longDescription', 'shortDescription', 'targets']);
  assert.deepEqual(recipe.bundle.targets, ['deb']);
  assert.deepEqual(Object.keys(recipe.bundle.linux), ['deb']);
  assert.deepEqual(Object.keys(recipe.bundle.linux.deb).sort(), ['depends', 'files']);
  assert.deepEqual(recipe.bundle.linux.deb.depends, ['policykit-1']);
  assert.deepEqual(recipe.bundle.linux.deb.files, {
    [packaging.HELPER]: 'creator-hub-deb-retirement-helper', [packaging.POLICY]: 'com.creatorworks.hub.deb-retirement.policy',
  });
  assert.match(recipe.bundle.shortDescription, /^TEST ONLY/);
  const schema = JSON.parse(fs.readFileSync(path.join(repo, 'node_modules/@tauri-apps/cli/config.schema.json')));
  assert.ok(Object.hasOwn(schema.definitions.BuildConfig.properties, 'features'));
  for (const key of Object.keys(recipe.bundle.linux.deb)) assert.ok(Object.hasOwn(schema.definitions.DebConfig.properties, key));
  assert.ok(Object.values(packaging.FLAGS).every(value => value === false));
});

test('fixed policy has no permissive rule, cached authority, GUI forwarding or arbitrary program', () => {
  const policy = fs.readFileSync(path.join(repo, 'packaging/linux', path.posix.basename(packaging.POLICY)), 'utf8');
  assert.equal((policy.match(/>auth_admin</g) || []).length, 3);
  assert.doesNotMatch(policy, /auth_admin_keep|auth_self|>yes<|allow_gui|\.rules|\.pkla|exec\.argv1/);
  assert.equal((policy.match(/<action id=/g) || []).length, 1, 'polkit 0.105 matches by path, not argv1');
  assert.equal((policy.match(/org\.freedesktop\.policykit\.exec\.path/g) || []).length, 1);
  const helper = fs.readFileSync(path.join(repo, 'native/linux-deb-retirement/src/lib.rs'), 'utf8');
  for (const argument of ['retire-mcp-2.7.7', 'retire-setup-0.3.7']) assert.ok(helper.includes(`["${argument}"]`));
});

function temp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-retirement-package-'))); }
function nativeFixture() {
  const root = temp();
  const output = path.join(root, 'artifacts/unified/candidate');
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(path.join(root, 'packaging/linux'), { recursive: true });
  for (const name of ['tauri-retirement-acceptance.json', 'tauri-integrated-candidate.json', 'tauri-production-migration-016.json',
    packaging.PRODUCTION_POLICY_SOURCE, path.posix.basename(packaging.POLICY)]) {
    fs.copyFileSync(path.join(repo, 'packaging/linux', name), path.join(root, 'packaging/linux', name));
  }
  return { root, output, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function productionVersion(root, version = '0.1.16') {
  fs.mkdirSync(path.join(root, 'src-tauri'), { recursive: true });
  for (const name of ['package.json', 'src-tauri/tauri.conf.json']) fs.writeFileSync(path.join(root, name), JSON.stringify({ version }));
}
function productionStaging(files, commit = 'a'.repeat(40)) {
  return { schemaVersion: 2, acceptanceOnly: true, sourceCommit: commit, platform: 'linux', arch: 'x86_64',
    rootFeature: packaging.PRODUCTION_ROOT_FEATURE, helperFeature: packaging.PRODUCTION_HELPER_FEATURE,
    files, profile: packaging.PRODUCTION_PROFILE, productionContract: packaging.PRODUCTION_CONTRACT, ...packaging.FLAGS };
}

test('production overlay and helper arguments are distinct finite016 contracts, not renamed development', () => {
  const f = nativeFixture();
  try {
    productionVersion(f.root);
    const overlay = packaging.writeOverlay(f.root, f.output, {}, { profile: packaging.PRODUCTION_PROFILE });
    const recipe = JSON.parse(fs.readFileSync(overlay));
    assert.equal(path.basename(overlay), 'tauri-linux-production-migration-016.json');
    assert.deepEqual(recipe.build.features, ['linux-production-migration', 'integrated-features', 'experimental-flatpak-host']);
    assert.deepEqual(recipe.bundle.targets, ['deb']);
    assert.equal(recipe.bundle.shortDescription, packaging.INTEGRATED_SHORT);
    assert.deepEqual(Object.keys(recipe.bundle.linux.deb.files), [packaging.HELPER, packaging.POLICY]);
    const production = packaging.helperBuildArguments(f.root, 'owned-target', packaging.PRODUCTION_PROFILE);
    assert.equal(production[production.indexOf('--features') + 1], 'production-transaction');
    assert.ok(production.includes('--no-default-features')); assert.ok(!production.includes('experimental-transaction'));
    for (const profile of [packaging.DEFAULT_PROFILE, packaging.INTEGRATED_PROFILE]) {
      const args = packaging.helperBuildArguments(f.root, 'owned-target', profile);
      assert.equal(args[args.indexOf('--features') + 1], 'experimental-transaction');
      assert.ok(!args.includes('--no-default-features'));
    }
    assert.throws(() => packaging.helperBuildArguments(f.root, 'owned-target', 'foreign'), /Unknown/);
    productionVersion(f.root, '0.1.14');
    assert.throws(() => packaging.writeOverlay(f.root, f.output, {}, { profile: packaging.PRODUCTION_PROFILE }), /actual 016/);
  } finally { f.cleanup(); }
});

test('production template refuses development flags, arbitrary authority and changed descriptions', () => {
  for (const change of [recipe => { recipe.build.features[0] = packaging.FEATURE; },
    recipe => { recipe.bundle.shortDescription = 'TEST ONLY - old'; },
    recipe => { recipe.bundle.longDescription = 'foreign'; },
    recipe => { recipe.bundle.linux.deb.postInstallScript = 'never-run'; },
    recipe => { recipe.bundle.linux.deb.files['/usr/libexec/another'] = 'another'; }]) {
    const f = nativeFixture();
    try {
      productionVersion(f.root);
      const file = path.join(f.root, 'packaging/linux/tauri-production-migration-016.json');
      const recipe = JSON.parse(fs.readFileSync(file)); change(recipe); fs.writeFileSync(file, JSON.stringify(recipe));
      assert.throws(() => packaging.writeOverlay(f.root, f.output, {}, { profile: packaging.PRODUCTION_PROFILE }));
      assert.equal(fs.existsSync(path.join(f.output, 'tauri-linux-production-migration-016.json')), false);
    } finally { f.cleanup(); }
  }
});

test('production staging builds only the production helper and preserves false qualification gates', { skip: process.platform !== 'linux' }, () => {
  const f = nativeFixture();
  try {
    productionVersion(f.root);
    const execute = (command, args) => {
      assert.equal(command, 'cargo');
      assert.equal(args[args.indexOf('--features') + 1], packaging.PRODUCTION_HELPER_FEATURE);
      assert.ok(args.includes('--no-default-features')); assert.ok(!args.includes('experimental-transaction'));
      const file = path.join(args[args.indexOf('--target-dir') + 1], 'x86_64-unknown-linux-gnu/release/creator-hub-linux-deb-retirement');
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.alloc(128, 1), { mode: 0o755 });
    };
    const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
      GITHUB_REPOSITORY_ID: '1364807512', GITHUB_SHA: 'a'.repeat(40) };
    const staged = packaging.stage(f.root, f.output, {}, env, execute, { profile: packaging.PRODUCTION_PROFILE });
    assert.equal(staged.profile, packaging.PRODUCTION_PROFILE);
    packaging.validateProductionReceipt(staged.productionReceipt, env.GITHUB_SHA);
    assert.deepEqual(staged.files, staged.productionReceipt.files);
    assert.equal(staged.productionReceipt.productionContract.nativeAcceptance, false);
    assert.equal(staged.productionReceipt.productionContract.externalQualificationRequired, true);
    const expected = fs.readFileSync(path.join(f.root, 'packaging/linux', packaging.PRODUCTION_POLICY_SOURCE));
    assert.deepEqual(fs.readFileSync(path.join(f.output, 'linux-retirement', path.posix.basename(packaging.POLICY))), expected);
    assert.throws(() => packaging.stage(f.root, f.output, {}, env, execute, { profile: packaging.PRODUCTION_PROFILE }), /EEXIST/);
  } finally { f.cleanup(); }
});

test('production DEB verification requires new staging provenance, exact profile and unchanged root metadata', () => {
  const f = nativeFixture();
  try {
    productionVersion(f.root);
    fs.mkdirSync(path.join(f.output, 'native-packages'));
    const file = path.join(f.output, 'native-packages/production.deb'); fs.writeFileSync(file, 'synthetic-package-not-executed');
    const files = { [packaging.HELPER]: { sha256: 'a'.repeat(64), size: 128, mode: 0o755, uid: 0, gid: 0 },
      [packaging.POLICY]: { sha256: 'b'.repeat(64), size: 1000, mode: 0o644, uid: 0, gid: 0 } };
    const staged = { profile: packaging.PRODUCTION_PROFILE, files, productionReceipt: productionStaging(files) };
    const integrity = { integrityPassed: true, packages: [{ format: 'deb', path: 'native-packages/production.deb', sha256: digest('synthetic-package-not-executed') }] };
    const verified = { profile: packaging.PRODUCTION_PROFILE, files: { ...files, [packaging.SERVICE]: {
      sha256: digest(packaging.SERVICE_BYTES), size: packaging.SERVICE_BYTES.length, mode: 0o644, uid: 0, gid: 0 } } };
    const execute = (command, args) => {
      assert.equal(command, 'python3'); assert.deepEqual(args.slice(2), [file, files[packaging.HELPER].sha256, files[packaging.POLICY].sha256,
        '0.1.16', '--profile', packaging.PRODUCTION_PROFILE]); return JSON.stringify(verified);
    };
    assert.throws(() => packaging.verifyDeb(f.root, f.output, integrity, { ...staged, productionReceipt: { ...staged.productionReceipt, schemaVersion: 1 } },
      () => assert.fail('No verifier invocation for development receipts')));
    assert.throws(() => packaging.verifyDeb(f.root, f.output, integrity, staged, () => JSON.stringify({ ...verified, profile: 'integrated-candidate' })));
    const receipt = packaging.verifyDeb(f.root, f.output, integrity, staged, execute);
    assert.equal(receipt.schemaVersion, 2); assert.equal(receipt.profile, packaging.PRODUCTION_PROFILE);
    assert.deepEqual(receipt.productionContract, packaging.PRODUCTION_CONTRACT);
    assert.equal(receipt.systemInstallationTested, false);
    for (const key of Object.keys(packaging.FLAGS)) assert.equal(receipt[key], false);
  } finally { f.cleanup(); }
});

test('actual staged overlay parses to the fixed helper/policy destinations and explicit Root feature on every host', () => {
  const f = nativeFixture();
  try {
    const resources = { '/staged/modules.tar.gz': 'modules.tar.gz' };
    const overlay = packaging.writeOverlay(f.root, f.output, resources);
    const parsed = JSON.parse(fs.readFileSync(overlay, 'utf8'));
    assert.deepEqual(parsed.build.features, [packaging.FEATURE]);
    assert.deepEqual(parsed.bundle.targets, ['deb']);
    assert.deepEqual(parsed.bundle.resources, resources);
    assert.deepEqual(parsed.bundle.linux.deb.files, {
      [packaging.HELPER]: path.join(f.output, 'linux-retirement', path.posix.basename(packaging.HELPER)),
      [packaging.POLICY]: path.join(f.output, 'linux-retirement', path.posix.basename(packaging.POLICY)),
    });
    assert.throws(() => packaging.writeOverlay(f.root, f.output, resources), /EEXIST/);
  } finally { f.cleanup(); }
});

test('integrated candidate has exact normal product text and features without widening the helper/policy map', () => {
  const f = nativeFixture();
  try {
    const resources = { '/staged/modules.tar.gz': 'modules.tar.gz' };
    const file = packaging.writeOverlay(f.root, f.output, resources, { profile: 'integrated-candidate' });
    const overlay = JSON.parse(fs.readFileSync(file));
    assert.equal(path.basename(file), 'tauri-linux-integrated-candidate.json');
    assert.deepEqual(overlay.build.features, [packaging.FEATURE, 'integrated-features', 'experimental-flatpak-host']);
    assert.equal(overlay.bundle.shortDescription, 'Creator Hub');
    assert.equal(overlay.bundle.longDescription, packaging.INTEGRATED_LONG);
    assert.deepEqual(overlay.bundle.targets, ['deb']);
    assert.deepEqual(overlay.bundle.resources, resources);
    assert.deepEqual(overlay.bundle.linux.deb.depends, ['policykit-1']);
    assert.deepEqual(Object.keys(overlay.bundle.linux.deb).sort(), ['depends', 'files']);
    assert.deepEqual(Object.keys(overlay.bundle.linux.deb.files), [packaging.HELPER, packaging.POLICY]);
    assert.equal(packaging.SERVICE_BYTES.toString(), fs.readFileSync(path.join(repo,
      'native/flatpak-native-activation/com.creatorworks.hub.Host.service'), 'utf8'));
    assert.ok(Object.values(packaging.FLAGS).every(value => value === false));
    assert.throws(() => packaging.writeOverlay(f.root, f.output, resources, { profile: 'foreign' }), /Unknown/);
  } finally { f.cleanup(); }
});

test('integrated template refuses foreign or TEST ONLY text, other features, control scripts and grants', () => {
  for (const modify of [
    recipe => { recipe.bundle.shortDescription = 'TEST ONLY - fixture'; },
    recipe => { recipe.bundle.longDescription = 'Foreign description'; },
    recipe => { recipe.build.features.push('foreign-feature'); },
    recipe => { recipe.bundle.linux.deb.preInstallScript = '/tmp/preinst'; },
    recipe => { recipe.bundle.linux.deb.files['/usr/share/polkit-1/actions/foreign.policy'] = 'foreign'; },
  ]) {
    const f = nativeFixture();
    try {
      const file = path.join(f.root, 'packaging/linux/tauri-integrated-candidate.json');
      const recipe = JSON.parse(fs.readFileSync(file)); modify(recipe);
      fs.writeFileSync(file, JSON.stringify(recipe));
      assert.throws(() => packaging.writeOverlay(f.root, f.output, {}, { profile: 'integrated-candidate' }));
      assert.equal(fs.existsSync(path.join(f.output, 'tauri-linux-integrated-candidate.json')), false);
    } finally { f.cleanup(); }
  }
});

test('native stage builds a fresh fixed helper, copies independent bytes and preserves all refusal flags', { skip: process.platform !== 'linux' }, () => {
  const f = nativeFixture();
  const calls = [];
  const execute = (command, args) => {
    calls.push([command, args]);
    assert.equal(command, 'cargo');
    assert.ok(args.includes('--locked') && args.includes('experimental-transaction'));
    assert.equal(args[args.indexOf('--target') + 1], 'x86_64-unknown-linux-gnu');
    const file = path.join(args[args.indexOf('--target-dir') + 1], 'x86_64-unknown-linux-gnu/release/creator-hub-linux-deb-retirement');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(128, 1), { mode: 0o755 });
  };
  try {
    const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
      GITHUB_REPOSITORY_ID: '1364807512', GITHUB_SHA: 'a'.repeat(40) };
    const resources = { '/staged/modules.tar.gz': 'modules.tar.gz' };
    const result = packaging.stage(f.root, f.output, resources, env, execute);
    assert.equal(result.profile, 'retirement-acceptance');
    const overlay = JSON.parse(fs.readFileSync(result.overlay));
    assert.deepEqual(overlay.bundle.resources, resources);
    assert.deepEqual(overlay.build.features, [packaging.FEATURE]);
    assert.deepEqual(overlay.bundle.targets, ['deb']);
    assert.deepEqual(Object.keys(result.files), [packaging.HELPER, packaging.POLICY]);
    assert.equal(result.files[packaging.HELPER].mode, 0o755);
    assert.equal(result.files[packaging.POLICY].mode, 0o644);
    assert.equal(fs.statSync(overlay.bundle.linux.deb.files[packaging.HELPER]).nlink, 1);
    const receipt = JSON.parse(fs.readFileSync(path.join(f.output, 'linux-retirement-candidate.json')));
    assert.equal(Object.hasOwn(receipt, 'profile'), false, 'Old receipt shape remains unchanged');
    for (const [key, value] of Object.entries(packaging.FLAGS)) assert.equal(receipt[key], value);
    assert.equal(receipt.rootFeature, 'experimental-linux-migration');
    assert.equal(calls.length, 1);
    assert.throws(() => packaging.stage(f.root, f.output, resources, env, execute), /EEXIST/);
    assert.equal(calls.length, 1);
  } finally { f.cleanup(); }
});

test('explicit sixth stage argument selects integrated profile without accepting native operation gates', { skip: process.platform !== 'linux' }, () => {
  const f = nativeFixture();
  try {
    const execute = (command, args) => {
      assert.equal(command, 'cargo');
      const file = path.join(args[args.indexOf('--target-dir') + 1], 'x86_64-unknown-linux-gnu/release/creator-hub-linux-deb-retirement');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.alloc(128, 1), { mode: 0o755 });
    };
    const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
      GITHUB_REPOSITORY_ID: '1364807512', GITHUB_SHA: 'a'.repeat(40) };
    const staged = packaging.stage(f.root, f.output, {}, env, execute, { profile: 'integrated-candidate' });
    assert.equal(staged.profile, 'integrated-candidate');
    assert.deepEqual(Object.keys(staged.files), [packaging.HELPER, packaging.POLICY]);
    const receipt = JSON.parse(fs.readFileSync(path.join(f.output, 'linux-retirement-candidate.json')));
    assert.equal(receipt.profile, staged.profile);
    assert.equal(receipt.acceptanceOnly, true);
    for (const key of Object.keys(packaging.FLAGS)) assert.equal(receipt[key], false);
  } finally { f.cleanup(); }
});

test('package verifier binds archive bytes and numeric root metadata without claiming installation', () => {
  const root = temp();
  try {
    fs.mkdirSync(path.join(root, 'src-tauri'));
    fs.writeFileSync(path.join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.1.14' }));
    fs.mkdirSync(path.join(root, 'native-packages'));
    const file = path.join(root, 'native-packages/fixture.deb');
    fs.writeFileSync(file, 'container bytes');
    const files = { [packaging.HELPER]: { sha256: 'a'.repeat(64), size: 128, mode: 0o755, uid: 0, gid: 0 },
      [packaging.POLICY]: { sha256: 'b'.repeat(64), size: 1024, mode: 0o644, uid: 0, gid: 0 } };
    const integrity = { integrityPassed: true, packages: [{ format: 'deb', path: 'native-packages/fixture.deb', sha256: digest('container bytes') }] };
    const execute = (command, args) => {
      assert.equal(command, 'python3');
      assert.deepEqual(args.slice(2), [file, files[packaging.HELPER].sha256, files[packaging.POLICY].sha256, '0.1.14']);
      return JSON.stringify({ files });
    };
    const receipt = packaging.verifyDeb(root, root, integrity, { files }, execute);
    assert.equal(receipt.archiveIntegrityPassed, true);
    assert.equal(receipt.systemInstallationTested, false);
    for (const key of Object.keys(packaging.FLAGS)) assert.equal(receipt[key], false);
    assert.throws(() => packaging.verifyDeb(root, root, integrity, { files }, () => JSON.stringify({ files: {
      ...files, [packaging.HELPER]: { ...files[packaging.HELPER], uid: 1001 },
    } })), /ownership, modes and bytes/);
    assert.throws(() => packaging.verifyDeb(root, root, { ...integrity, packages: [...integrity.packages, { format: 'rpm' }] }, { files }, execute));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('integrated verifier dispatch is explicit and requires the exact service as well as helper/policy bytes', () => {
  const root = temp();
  try {
    fs.mkdirSync(path.join(root, 'src-tauri'));
    fs.writeFileSync(path.join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.1.14' }));
    fs.mkdirSync(path.join(root, 'native-packages'));
    const file = path.join(root, 'native-packages/fixture.deb'); fs.writeFileSync(file, 'candidate bytes');
    const files = { [packaging.HELPER]: { sha256: 'a'.repeat(64), size: 128, mode: 0o755, uid: 0, gid: 0 },
      [packaging.POLICY]: { sha256: 'b'.repeat(64), size: 889, mode: 0o644, uid: 0, gid: 0 } };
    const service = { sha256: digest(packaging.SERVICE_BYTES), size: packaging.SERVICE_BYTES.length, mode: 0o644, uid: 0, gid: 0 };
    const integrity = { integrityPassed: true, packages: [{ format: 'deb', path: 'native-packages/fixture.deb', sha256: digest('candidate bytes') }] };
    const staged = { files, profile: 'integrated-candidate' };
    const verified = { profile: staged.profile, files: { ...files, [packaging.SERVICE]: service } };
    let calls = 0;
    const execute = response => (command, args) => {
      calls++; assert.equal(command, 'python3');
      assert.deepEqual(args.slice(2), [file, files[packaging.HELPER].sha256, files[packaging.POLICY].sha256,
        '0.1.14', '--profile', 'integrated-candidate']);
      return JSON.stringify(response);
    };
    assert.throws(() => packaging.verifyDeb(root, root, integrity, { ...staged, profile: 'foreign' }, execute(verified)), /Unknown/);
    assert.equal(calls, 0);
    for (const response of [{ files: verified.files }, { ...verified, files },
      { ...verified, files: { ...verified.files, [packaging.SERVICE]: { ...service, mode: 0o666 } } },
      { ...verified, files: { ...verified.files, [packaging.HELPER]: { ...files[packaging.HELPER], sha256: 'c'.repeat(64) } } }]) {
      assert.throws(() => packaging.verifyDeb(root, root, integrity, staged, execute(response)));
    }
    const receipt = packaging.verifyDeb(root, root, integrity, staged, execute(verified));
    assert.equal(receipt.profile, staged.profile);
    assert.equal(receipt.systemInstallationTested, false);
    assert.equal(receipt.acceptanceOnly, true);
    assert.deepEqual(receipt.files, verified.files);
    for (const key of Object.keys(packaging.FLAGS)) assert.equal(receipt[key], false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('DEB-only validation is available only to an explicit managed writable Linux x86_64 candidate', () => {
  for (const change of [{ linuxRetirementCandidate: 'true' }, { mcpMode: 'read-only' }, { manifest: { platform: 'macos', arch: 'x86_64', managedRouting: {} } },
    { manifest: { platform: 'linux', arch: 'aarch64', managedRouting: {} } }]) {
    assert.throws(() => validatePackages({ manifest: { platform: 'linux', arch: 'x86_64', managedRouting: {} },
      mcpMode: 'writable', linuxRetirementCandidate: true, ...change }), /retirement acceptance package/);
  }
});

test('actual package validation still checks every selected module and managed route for the DEB-only candidate', () => {
  const root = temp();
  try {
    const output = path.join(root, 'output'), bundleDirectory = path.join(root, 'bundle');
    fs.mkdirSync(output); fs.mkdirSync(path.join(bundleDirectory, 'deb'), { recursive: true });
    fs.writeFileSync(path.join(bundleDirectory, 'deb/fixture.deb'), 'container fixture');
    const manifest = { schemaVersion: 1, platform: 'linux', arch: 'x86_64', modules: {}, managedRouting: { protocol: 1, files: {} } };
    for (const id of ['mcp', 'setup']) {
      const names = moduleFiles(id, 'linux');
      manifest.modules[id] = { executable: names[0], version: id === 'mcp' ? '2.7.7' : '0.3.7', files: Object.fromEntries(names.map(name => [name, digest(name)])) };
    }
    for (const name of routeFiles('linux')) manifest.managedRouting.files[name] = digest(name);
    fs.writeFileSync(path.join(output, 'builtin-manifest.json'), JSON.stringify(manifest));
    const raw = Buffer.from(`code\0__TAURI_BUNDLE_TYPE_VAR_UNK\0${JSON.stringify(manifest)}`);
    const rawHub = path.join(output, 'creator-hub'); fs.writeFileSync(rawHub, raw);
    let calls = 0;
    const execute = (command, args) => {
      calls++;
      assert.equal(command, 'dpkg-deb'); assert.equal(args[0], '--extract');
      const tree = args[2];
      for (const name of [...Object.values(manifest.modules).flatMap(module => Object.keys(module.files)), ...routeFiles('linux')]) {
        const file = path.join(tree, 'usr/lib/Creator Hub/modules', name);
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, name, { mode: 0o755 });
      }
      fs.mkdirSync(path.join(tree, 'usr/bin'), { recursive: true });
      const bundled = Buffer.from(raw); bundled.write('DEB', raw.indexOf('_UNK') + 1);
      fs.writeFileSync(path.join(tree, 'usr/bin/creator-hub'), bundled, { mode: 0o755 });
    };
    const report = validatePackages({ output, bundleDirectory, manifest, productName: 'Creator Hub', rawHub, execute,
      mcpMode: 'writable', linuxRetirementCandidate: true });
    assert.equal(calls, 1);
    assert.deepEqual(report.packages.map(entry => entry.format), ['deb']);
    assert.equal(report.integrityPassed, true); assert.equal(report.releaseReady, false);
    assert.equal(Object.keys(report.packages[0].files).length, 15);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('existing workflow compiles the opt-in feature and retains separate receipts without release or privileged policy bypass', () => {
  const workflow = fs.readFileSync(path.join(repo, '.github/workflows/unix-managed-assembly.yml'), 'utf8');
  assert.match(workflow, /linux_retirement_test_candidate:[\s\S]*?type: boolean\s+default: false/);
  assert.ok(workflow.includes('if: runner.os == \'Linux\' && inputs.linux_retirement_test_candidate'));
  assert.ok(workflow.includes('extra+=(--linux-retirement-test-candidate)'));
  assert.ok(workflow.indexOf('scripts/linux-retirement-package.test.cjs') < workflow.indexOf('id: package'));
  assert.ok(workflow.indexOf('scripts/linux-retirement-package-verify.test.py') < workflow.indexOf('id: package'));
  assert.ok(workflow.includes('linux-retirement-package-integrity.json'));
  assert.doesNotMatch(workflow, /gh release|dpkg --install|auth_admin_keep|\.pkla|addRule/);
  const buildSource = fs.readFileSync(path.join(repo, 'scripts/build-unified.cjs'), 'utf8');
  const signed = buildSource.slice(buildSource.indexOf('function buildSignedUnix('));
  assert.match(signed, /'--config', overlay/);
  assert.match(signed, /retirement \? \['deb'\] : plan\.bundles/);
});

test('modified assembly workflow parses with its default-false boolean and unchanged Linux runner', t => {
  const source = fs.readFileSync(path.join(repo, '.github/workflows/unix-managed-assembly.yml'), 'utf8');
  const parsed = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c',
    'import sys,yaml; p=yaml.load(sys.stdin.read(),Loader=yaml.BaseLoader); i=p["on"]["workflow_dispatch"]["inputs"]["linux_retirement_test_candidate"]; assert i["type"]=="boolean" and i["default"]=="false"; assert p["jobs"]["assembly"]["runs-on"]=="ubuntu-22.04"'],
  { input: source, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (parsed.stderr?.includes("No module named 'yaml'")) return t.skip('Optional local PyYAML is unavailable');
  assert.equal(parsed.status, 0, parsed.stderr || parsed.error?.message);
});

function assemblyYaml(t) {
  const source = fs.readFileSync(path.join(repo, '.github/workflows/unix-managed-assembly.yml'), 'utf8');
  const parsed = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c',
    'import sys,yaml,json; print(json.dumps(yaml.load(sys.stdin.read(),Loader=yaml.BaseLoader)))'],
  { input: source, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (parsed.stderr?.includes("No module named 'yaml'")) { t.skip('Optional local PyYAML is unavailable'); return null; }
  assert.equal(parsed.status, 0, parsed.stderr || parsed.error?.message);
  return JSON.parse(parsed.stdout);
}

function workflowBash(t, script, retirement, integrated, overrides = {}) {
  const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git/bin/bash.exe') : '/bin/bash';
  if (!fs.existsSync(bash)) { t.skip('Native Bash is unavailable; do not substitute a WSL/native product run'); return null; }
  return spawnSync(bash, ['--noprofile', '--norc', '-c', script], {
    cwd: repo, windowsHide: true, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, BASH_ENV: '', RUNNER_OS: 'Linux', GITHUB_REF: 'refs/heads/validation/unix-assembly-014',
      GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512',
      GITHUB_EVENT_NAME: 'workflow_dispatch', SIGNED_INPUTS: '',
      CREATOR_LINUX_RETIREMENT_TEST_CANDIDATE: retirement,
      CREATOR_LINUX_PORTABLE_HOST_CANDIDATE: '0',
      CREATOR_LINUX_PRODUCTION_MIGRATION_016: '0',
      CREATOR_LINUX_INTEGRATED_CANDIDATE: integrated, ...overrides },
  });
}

function assemblyToolStubs(cacheOption = '--linux-root-cache', selectorStatus = 0) {
  assert.ok(cacheOption === '--linux-root-cache' || cacheOption === '');
  assert.ok(Number.isInteger(selectorStatus) && selectorStatus >= 0 && selectorStatus <= 255);
  return "python3() { printf '%s\\n' '/reviewed-runner'; }\n"
    + "node() { [[ $# == 2 && $1 == scripts/linux-root-cache-option.cjs && $2 == /reviewed-runner/signed-unix-input ]] || return 96; "
    + `printf '%s' '${cacheOption}'; return ${selectorStatus}; }\n`
    + "npm() { printf '%s\\n' \"$@\"; }\n";
}

test('assembly profiles default off and conflict refusal precedes every signed input download', t => {
  const workflow = assemblyYaml(t); if (!workflow) return;
  const inputs = workflow.on.workflow_dispatch.inputs;
  for (const name of ['linux_retirement_test_candidate', 'linux_integrated_candidate', 'linux_portable_host_candidate', 'linux_production_migration_016']) {
    assert.equal(inputs[name].type, 'boolean');
    assert.equal(inputs[name].default, 'false');
    assert.equal(inputs[name].required, 'false');
  }
  assert.equal(inputs.signed_inputs.type, 'string');
  assert.equal(inputs.signed_inputs.required, 'true');
  assert.equal(workflow.permissions.contents, 'read');
  const preflight = workflow.jobs['candidate-options'];
  assert.equal(preflight['runs-on'], 'ubuntu-22.04');
  assert.equal(preflight['timeout-minutes'], '5');
  assert.equal(preflight.permissions, undefined);
  assert.equal(preflight.steps.length, 1);
  assert.equal(preflight.steps[0].uses, undefined);
  assert.doesNotMatch(preflight.steps[0].run, /checkout|download|curl|wget|npm|cargo|github\.|gh release|dpkg/);
  const stage = workflow.jobs['stage-input'];
  assert.equal(stage.needs, 'candidate-options');
  assert.equal(stage.if, '${{ !(inputs.linux_retirement_test_candidate && inputs.linux_integrated_candidate) }}');
  assert.equal(stage.permissions.contents, 'write');
  assert.equal(workflow.jobs.assembly.needs, 'stage-input');
  for (const [retirement, integrated] of [['0', '0'], ['1', '0'], ['0', '1'], ['1', '1']]) {
    const result = workflowBash(t, preflight.steps[0].run, retirement, integrated); if (!result) return;
    assert.equal(result.status, retirement === '1' && integrated === '1' ? 64 : 0, result.stderr || result.error?.message);
    assert.equal(result.stdout, '');
  }
});

test('portable host workflow is default-off, exact016-only and forwards the new actual Cargo feature', t => {
  const workflow = assemblyYaml(t); if (!workflow) return;
  const input = workflow.on.workflow_dispatch.inputs.linux_portable_host_candidate;
  assert.equal(input.default, 'false'); assert.equal(input.type, 'boolean');
  const preflight = workflow.jobs['candidate-options'];
  const assembly = workflow.jobs.assembly;
  const mapped = "${{ inputs.linux_portable_host_candidate && '1' || '0' }}";
  assert.equal(preflight.env.CREATOR_LINUX_PORTABLE_HOST_CANDIDATE, mapped);
  assert.equal(assembly.env.CREATOR_LINUX_PORTABLE_HOST_CANDIDATE, mapped);
  const scope = { GITHUB_REF: 'refs/heads/validation/linux-integrated-candidate-016',
    CREATOR_LINUX_PORTABLE_HOST_CANDIDATE: '1',
    SIGNED_INPUTS: JSON.stringify([{ target: 'linux', os: 'ubuntu-22.04' }]) };
  const accepted = workflowBash(t, preflight.steps[0].run, '0', '1', scope); if (!accepted) return;
  assert.equal(accepted.status, 0, accepted.stderr);
  for (const change of [{ GITHUB_REF: 'refs/heads/validation/unix-assembly-014' },
    { CREATOR_LINUX_INTEGRATED_CANDIDATE: '0' }, { CREATOR_LINUX_RETIREMENT_TEST_CANDIDATE: '1' },
    { GITHUB_EVENT_NAME: 'push' }]) {
    const refused = workflowBash(t, preflight.steps[0].run, '0', '1', { ...scope, ...change });
    assert.equal(refused.status, 64, refused.stderr); assert.equal(refused.stdout, '');
  }
  const step = assembly.steps.find(item => item.id === 'package');
  const stubs = assemblyToolStubs();
  const result = workflowBash(t, stubs + step.run, '0', '1', scope); if (!result) return;
  assert.equal(result.status, 0, result.stderr);
  const options = parseBuildOptions(result.stdout.trimEnd().split(/\r?\n/).slice(4));
  assert.equal(options.linuxPortableHostCandidate, true);
  const builder = require('./build-unified.cjs');
  assert.deepEqual(builder.integrationArguments('linux', 'x86_64', options.integratedFeatures, true,
    options.linuxPortableHostCandidate), ['--features', builder.PORTABLE_HOST_FEATURES.join(',')]);
});

test('016 assembly preflight is separately exercised and cannot inherit a historical test profile', t => {
  const workflow = assemblyYaml(t); if (!workflow) return;
  const script = workflow.jobs['candidate-options'].steps[0].run;
  const scope = { GITHUB_REF: 'refs/heads/validation/linux-integrated-candidate-016',
    SIGNED_INPUTS: JSON.stringify([{ target: 'linux', os: 'ubuntu-22.04' }]) };
  const accepted = workflowBash(t, script, '0', '1', scope); if (!accepted) return;
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, '');
  for (const change of [
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_REPOSITORY_ID: '1' },
    { GITHUB_REPOSITORY: 'other/repository' }, { CREATOR_LINUX_INTEGRATED_CANDIDATE: '0' },
    { SIGNED_INPUTS: '[]' }, { SIGNED_INPUTS: '[{"target":"macos-arm64","os":"macos-15"}]' },
    { SIGNED_INPUTS: '[{"target":"linux","os":"ubuntu-22.04"},{"target":"linux","os":"ubuntu-22.04"}]' },
  ]) {
    const refused = workflowBash(t, script, '0', '1', { ...scope, ...change });
    assert.notEqual(refused.status, 0, JSON.stringify(change));
    assert.equal(refused.stdout, '');
  }
});

test('actual assembly Bash selects exactly one profile and the integrated builder supplies all Root features', t => {
  const workflow = assemblyYaml(t); if (!workflow) return;
  const assembly = workflow.jobs.assembly;
  assert.equal(assembly.env.CREATOR_LINUX_INTEGRATED_CANDIDATE, "${{ inputs.linux_integrated_candidate && '1' || '0' }}");
  const step = assembly.steps.find(item => item.id === 'package');
  assert.equal(step.shell, 'bash');
  // Exercise argument mapping without depending on the runner's real restored cache.
  const stubs = assemblyToolStubs();
  for (const [retirement, integrated, selected] of [['0', '0', {}], ['1', '0', { linuxRetirementCandidate: true }],
    ['0', '1', { linuxIntegratedCandidate: true, integratedFeatures: true }]]) {
    const result = workflowBash(t, stubs + step.run, retirement, integrated); if (!result) return;
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const args = result.stdout.trimEnd().split(/\r?\n/);
    assert.deepEqual(args.slice(0, 4), ['run', 'build:unified', '--', 'ci-signed-unix-hub']);
    const options = parseBuildOptions(args.slice(4));
    assert.deepEqual(options, { installer: true, managed: true, experimentalUnix: true, experimentalWritable: true, linuxRootCache: true,
      signedUnixInput: '/reviewed-runner/signed-unix-input', ...selected });
    if (integrated === '1') {
      assert.deepEqual(require('./build-unified.cjs').integrationArguments('linux', 'x86_64', options.integratedFeatures, true),
        ['--features', 'integrated-features,experimental-flatpak-host,experimental-linux-migration']);
    }
  }
  const refused = workflowBash(t, stubs + step.run, '1', '1'); if (!refused) return;
  assert.equal(refused.status, 64, refused.stderr || refused.error?.message);
  assert.equal(refused.stdout, '', 'No builder invocation when both profiles are selected');
});

test('assembly Bash opts only Linux into the dependency cache without running build tools', t => {
  const workflow = assemblyYaml(t); if (!workflow) return;
  const step = workflow.jobs.assembly.steps.find(item => item.id === 'package');
  for (const cacheOption of ['--linux-root-cache', '']) {
    for (const runner of ['Linux', 'macOS', 'Windows']) {
      const stubs = assemblyToolStubs(cacheOption);
      const result = workflowBash(t, stubs + step.run, '0', '0', { RUNNER_OS: runner }); if (!result) return;
      assert.equal(result.status, 0, result.stderr);
      const options = parseBuildOptions(result.stdout.trimEnd().split(/\r?\n/).slice(4));
      assert.equal(options.linuxRootCache, runner === 'Linux' && cacheOption ? true : undefined);
    }
  }
});

test('assembly Bash stops before the builder on selector failure even with valid-looking stdout', t => {
  const workflow = assemblyYaml(t); if (!workflow) return;
  const step = workflow.jobs.assembly.steps.find(item => item.id === 'package');
  for (const cacheOption of ['--linux-root-cache', '']) {
    const result = workflowBash(t, assemblyToolStubs(cacheOption, 47) + step.run, '0', '0'); if (!result) return;
    assert.equal(result.status, 47, result.stderr);
    assert.equal(result.stdout, '', 'Neither a warm nor cold build may follow a selector error');
  }
});

test('pre-package tests keep optional MCP libraries off until the builder verifies and extracts signed payloads', t => {
  const workflow = assemblyYaml(t); if (!workflow) return;
  const steps = workflow.jobs.assembly.steps;
  const packageIndex = steps.findIndex(step => step.id === 'package');
  assert.ok(packageIndex > 0);
  const earlier = steps.slice(0, packageIndex).map(step => step.run || '').join('\n');
  assert.doesNotMatch(earlier, /release:launcher|--features[^\n]*(?:integrated-features|integrated-service|experimental-flatpak-host)/);
  assert.match(earlier, /cargo test --release --locked --manifest-path src-tauri\/Cargo.toml\s+--target-dir artifacts\/unix-verifier-target/);
  assert.doesNotMatch(steps[packageIndex].run, /npm(?:\s+--prefix\s+\S+)?\s+run\s+release:launcher|cp\s.*modules\/mcp\/release/);
  const source = fs.readFileSync(path.join(repo, '.github/workflows/unix-managed-assembly.yml'), 'utf8');
  assert.doesNotMatch(source, /gh release|dpkg --install|--draft=false|--latest|publish-hub-draft\.cjs/);
});

test('production workflow refuses both development profiles before downloads and forwards only its explicit016 selector', t => {
  const workflow = assemblyYaml(t); if (!workflow) return;
  const input = workflow.on.workflow_dispatch.inputs.linux_production_migration_016;
  assert.equal(input.default, 'false'); assert.equal(input.type, 'boolean'); assert.equal(input.required, 'false');
  const mapped = "${{ inputs.linux_production_migration_016 && '1' || '0' }}";
  const preflight = workflow.jobs['candidate-options'];
  assert.equal(preflight.env.CREATOR_LINUX_PRODUCTION_MIGRATION_016, mapped);
  assert.equal(workflow.jobs.assembly.env.CREATOR_LINUX_PRODUCTION_MIGRATION_016, mapped);
  const scope = { GITHUB_REF: 'refs/heads/validation/linux-integrated-candidate-016',
    CREATOR_LINUX_PRODUCTION_MIGRATION_016: '1', SIGNED_INPUTS: JSON.stringify([{ target: 'linux', os: 'ubuntu-22.04' }]) };
  for (const portable of ['0', '1']) {
    const accepted = workflowBash(t, preflight.steps[0].run, '0', '0', { ...scope, CREATOR_LINUX_PORTABLE_HOST_CANDIDATE: portable });
    if (!accepted) return;
    assert.equal(accepted.status, 0, accepted.stderr); assert.equal(accepted.stdout, '');
  }
  const step = workflow.jobs.assembly.steps.find(item => item.id === 'package');
  const stubs = assemblyToolStubs();
  for (const change of [{ CREATOR_LINUX_RETIREMENT_TEST_CANDIDATE: '1' }, { CREATOR_LINUX_INTEGRATED_CANDIDATE: '1' },
    { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/validation/unix-assembly-014' }]) {
    for (const script of [preflight.steps[0].run, stubs + step.run]) {
      const refused = workflowBash(t, script, '0', '0', { ...scope, ...change }); if (!refused) return;
      assert.equal(refused.status, 64, refused.stderr); assert.equal(refused.stdout, '');
    }
  }
  for (const portable of ['0', '1']) {
    const forwarded = workflowBash(t, stubs + step.run, '0', '0', { ...scope, CREATOR_LINUX_PORTABLE_HOST_CANDIDATE: portable });
    assert.equal(forwarded.status, 0, forwarded.stderr);
    const options = parseBuildOptions(forwarded.stdout.trimEnd().split(/\r?\n/).slice(4));
    assert.equal(options.linuxProductionMigration, true); assert.equal(options.integratedFeatures, true);
    assert.equal(options.linuxIntegratedCandidate, undefined); assert.equal(options.linuxRetirementCandidate, undefined);
    const builder = require('./build-unified.cjs');
    assert.deepEqual(builder.integrationArguments('linux', 'x86_64', true, true, portable === '1', true),
      ['--features', (portable === '1' ? builder.PRODUCTION_PORTABLE_FEATURES : builder.PRODUCTION_FEATURES).join(',')]);
  }
  const tests = workflow.jobs.assembly.steps.find(item => item.name === 'Test the strict production protocol without accepting or installing a package');
  assert.equal(tests.if, "runner.os == 'Linux' && inputs.linux_production_migration_016");
  assert.match(tests.run, /--features production-transaction/);
  assert.match(tests.run, /--features linux-production-migration linux_retirement/);
  assert.match(tests.run, /--features linux-production-migration convergence/);
  assert.doesNotMatch(tests.run, /experimental-transaction|dpkg|sudo|--features integrated-features/);
});

test('assembly workflow Bash, embedded Python and JavaScript parse without running a build or API request', t => {
  const workflow = assemblyYaml(t); if (!workflow) return;
  const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git/bin/bash.exe') : '/bin/bash';
  if (!fs.existsSync(bash)) return t.skip('Bash parser unavailable');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let bashBodies = 0, pythonBodies = 0, jsBodies = 0;
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps || []) {
    if (step.uses?.startsWith('actions/github-script@')) { new AsyncFunction(step.with.script); jsBodies++; }
    if (!step.run) continue;
    const parsed = spawnSync(bash, ['--noprofile', '--norc', '-n'], { input: step.run, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(parsed.status, 0, parsed.stderr); bashBodies++;
    for (const match of step.run.matchAll(/python3(?: -B)? - <<'PY'\r?\n([\s\S]*?)^PY(?:\r?\n|$)/gm)) {
      const result = spawnSync(python, ['-B', '-c', 'import ast,sys;ast.parse(sys.stdin.read())'],
        { input: match[1], encoding: 'utf8', windowsHide: true, timeout: 15000 });
      assert.equal(result.status, 0, result.stderr); pythonBodies++;
    }
    for (const match of step.run.matchAll(/node - <<'NODE'\r?\n([\s\S]*?)^NODE(?:\r?\n|$)/gm)) {
      new Function(match[1]); jsBodies++;
    }
  }
  assert.ok(bashBodies >= 5 && pythonBodies >= 1 && jsBodies >= 2);
});
