'use strict';
// Admission only. New trusted017 handoff/packaging bindings must precede execution.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = '0.1.17';
const PROFILE = 'private-update-fixture-017';
const BRANCH = 'refs/heads/validation/linux-private-update-fixture-017';
const WORKFLOW = '.github/workflows/private-linux-update-fixture-017.yml';
const FLAG = 'CREATOR_LINUX_PRIVATE_UPDATE_FIXTURE_017';
const FEATURES = Object.freeze(['integrated-features', 'experimental-flatpak-host',
  'linux-production-migration', 'experimental-linux-portable-update']);
const FLAGS = Object.freeze({ acceptanceOnly: true, nativeGuiAccepted: false, migrationAccepted: false,
  authenticationAccepted: false, signedUpdateAccepted: false, restartAccepted: false, releaseReady: false });

function context(platform, arch, env) {
  assert.equal(platform, 'linux', 'Private017 requires native Linux x86_64');
  assert.equal(arch, 'x86_64', 'Private017 requires native Linux x86_64');
  for (const [name, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: BRANCH,
    GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${WORKFLOW}@${BRANCH}`, [FLAG]: '1' })) {
    assert.equal(env[name], value, `Exact manual private017 context required: ${name}`);
  }
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  for (const name of ['CREATOR_LINUX_INTEGRATED_CANDIDATE', 'CREATOR_LINUX_PRODUCTION_MIGRATION_016',
    'CREATOR_LINUX_RETIREMENT_TEST_CANDIDATE', 'CREATOR_LINUX_PORTABLE_HOST_CANDIDATE']) {
    assert.equal(env[name] ?? '0', '0', 'Private017 refuses other Linux profiles');
  }
  assert.ok(!Object.keys(env).some(name => /^(APPLE_|TAURI_SIGNING_|CREATOR_HUB_SIGNING_|LD_|DYLD_|NODE_OPTIONS$|RUSTFLAGS$|CARGO_ENCODED_RUSTFLAGS$|CARGO_BUILD_RUSTFLAGS$|CARGO_TARGET_.*_RUSTFLAGS$)/.test(name)),
    'Private017 refuses signing credentials and runtime/compiler overrides');
}
function versions(root) {
  for (const name of ['package.json', 'src-tauri/tauri.conf.json', 'package-lock.json']) {
    const value = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
    assert.equal(value.version, VERSION, 'Private017 requires actual Root17 version sources, not relabelled Root16');
    if (name === 'package-lock.json') assert.equal(value.packages?.['']?.version, VERSION, 'Private017 npm root lock version differs');
  }
}
function checkOptions(options, platform, arch, root, env) {
  context(platform, arch, env);
  assert.equal(options.linuxPrivateUpdateFixture, true, 'Private017 requires an explicit boolean selector');
  for (const name of ['installer', 'managed', 'experimentalUnix', 'experimentalWritable', 'integratedFeatures']) {
    assert.equal(options[name], true, 'Private017 requires signed writable integrated installer assembly');
  }
  for (const name of ['prepareManagedUnix', 'linuxRetirementCandidate', 'linuxIntegratedCandidate',
    'linuxProductionMigration', 'linuxPortableHostCandidate']) {
    assert.ok(options[name] === undefined || options[name] === false, 'Private017 refuses other build profiles');
  }
  assert.ok(typeof options.signedUnixInput === 'string' && path.isAbsolute(options.signedUnixInput), 'Private017 requires a separate trusted handoff input');
  versions(root);
}
function compileArguments() {
  return ['--features', FEATURES.join(',')];
}
function validateCompileArguments(args) {
  assert.deepEqual(args, compileArguments(), 'Private017 requires the exact production portable Cargo tuple');
}
function source(root, execute) {
  versions(root);
  for (const [manifest, name, feature, dependencies] of [
    ['src-tauri/Cargo.toml', 'creator-hub', 'linux-production-migration', ['experimental-linux-migration']],
    ['native/linux-portable-deployment/Cargo.toml', 'creator-hub-linux-portable-deployment', 'experimental-restart', []],
  ]) {
    const file = path.join(root, manifest);
    const metadata = JSON.parse(String(execute('cargo', ['metadata', '--locked', '--offline', '--no-deps', '--format-version', '1', '--manifest-path', file],
      { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })));
    const packages = metadata.packages.filter(item => path.resolve(item.manifest_path) === file);
    assert.equal(packages.length, 1, 'Exact private017 Cargo package required');
    const p = packages[0]; assert.equal(p.name, name);
    assert.deepEqual(p.features[feature]?.slice().sort(), dependencies.slice().sort());
    assert.ok(!(p.features.default || []).some(value => FEATURES.includes(value) || value === feature), 'Private017 capabilities must remain default-off');
    if (name === 'creator-hub') {
      assert.equal(p.version, VERSION, 'Private017 Cargo Root version differs');
      assert.ok(FEATURES.every(value => Array.isArray(p.features[value])), 'Private017 requires all four actual Cargo features');
      assert.deepEqual(p.features['experimental-linux-portable-host']?.slice().sort(),
        ['dep:creator-hub-linux-portable-deployment', 'integrated-features', 'experimental-flatpak-host'].sort());
      assert.deepEqual(p.features['experimental-linux-portable-update']?.slice().sort(),
        ['experimental-linux-portable-host', 'creator-hub-linux-portable-deployment/experimental-restart'].sort());
      // --no-deps metadata alone accepts a stale Root version in Cargo.lock.
      const locked = String(execute('cargo', ['tree', '--locked', '--offline', '--depth', '0', '--prefix', 'none', '--color', 'never',
        '--package', 'creator-hub', '--manifest-path', file], { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 16384 })).trim();
      assert.equal(locked, `creator-hub v${VERSION} (${path.dirname(file)})`, 'Private017 locked Cargo Root identity differs');
    } else assert.deepEqual(p.features.default || [], []);
  }
  return { profile: PROFILE, version: VERSION, requestedFeatures: [...FEATURES], ...FLAGS };
}
function requireTrustedHandoff() {
  throw Error('Private017 execution is not enabled: a distinct trusted017 handoff derivation and exact017 packaging verifier are required. Original016 producer evidence must not be relabelled.');
}

module.exports = { VERSION, PROFILE, BRANCH, WORKFLOW, FLAG, FEATURES, FLAGS,
  context, versions, checkOptions, compileArguments, validateCompileArguments, source, requireTrustedHandoff };
