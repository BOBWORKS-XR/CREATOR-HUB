'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const p = require('./private-linux-update-fixture-017.cjs');
const builder = require('./build-unified.cjs');
const assembly = require('./assemble-unix-payload.cjs');

function environment() {
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: p.BRANCH, GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${p.WORKFLOW}@${p.BRANCH}`,
    GITHUB_SHA: 'a'.repeat(40), CREATOR_UNIX_HANDOFF_SHA256: 'b'.repeat(64), [p.FLAG]: '1' };
}
function options() {
  return { linuxPrivateUpdateFixture: true, installer: true, managed: true, experimentalUnix: true,
    experimentalWritable: true, integratedFeatures: true, signedUnixInput: path.resolve('/never-read-handoff') };
}
function withSource(run) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'private017-source-')));
  try {
    fs.mkdirSync(path.join(root, 'src-tauri'));
    for (const name of ['package.json', 'src-tauri/tauri.conf.json']) {
      fs.writeFileSync(path.join(root, name), JSON.stringify({ version: p.VERSION }));
    }
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version: p.VERSION, packages: { '': { version: p.VERSION } } }));
    run(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function metadata(file) {
  const portable = file.includes('linux-portable-deployment');
  return { packages: [{ manifest_path: file, name: portable ? 'creator-hub-linux-portable-deployment' : 'creator-hub',
    version: portable ? '0.1.0' : p.VERSION, features: { default: [], ...(portable ? { 'experimental-restart': [] } : {
      'integrated-features': [], 'experimental-flatpak-host': [], 'linux-production-migration': ['experimental-linux-migration'],
      'experimental-linux-portable-host': ['dep:creator-hub-linux-portable-deployment', 'integrated-features', 'experimental-flatpak-host'],
      'experimental-linux-portable-update': ['experimental-linux-portable-host', 'creator-hub-linux-portable-deployment/experimental-restart'],
    }) } }] };
}
function executor(root, calls = [], change = () => {}) {
  return (command, args) => {
    calls.push([command, args]);
    if (command === 'cargo') {
      if (args[0] === 'tree') {
        const file = path.join(root, 'src-tauri/Cargo.toml');
        assert.deepEqual(args, ['tree', '--locked', '--offline', '--depth', '0', '--prefix', 'none', '--color', 'never',
          '--package', 'creator-hub', '--manifest-path', file]);
        return `creator-hub v${p.VERSION} (${path.dirname(file)})`;
      }
      assert.deepEqual(args.slice(0, 7), ['metadata', '--locked', '--offline', '--no-deps', '--format-version', '1', '--manifest-path']);
      const value = metadata(args[7]); change(value); return JSON.stringify(value);
    }
    assert.equal(command, 'git');
    if (args[0] === 'status') { assert.deepEqual(args, ['status', '--porcelain=v1', '--untracked-files=normal']); return ''; }
    assert.equal(args[0], 'rev-parse');
    if (args[1] === '--show-toplevel') return root;
    assert.equal(args[1], 'HEAD'); return environment().GITHUB_SHA;
  };
}

test('private017 requires its exact manual native branch/workflow and opt-in, without reading files', () => {
  p.context('linux', 'x86_64', environment());
  for (const [name, value] of Object.entries({ GITHUB_ACTIONS: 'false', RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_OS: 'macOS',
    RUNNER_ARCH: 'ARM64', GITHUB_REPOSITORY_ID: '2', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${assembly.WORKFLOW}@${p.BRANCH}`, [p.FLAG]: '0', GITHUB_SHA: 'bad' })) {
    assert.throws(() => p.checkOptions(options(), 'linux', 'x86_64', '/never-read-source', { ...environment(), [name]: value }));
  }
  for (const [platform, arch] of [['windows', 'x86_64'], ['macos', 'x86_64'], ['linux', 'aarch64']]) {
    assert.throws(() => p.context(platform, arch, environment()), /native Linux/);
  }
});

test('private017 rejects mixed profiles, signing/runtime/compiler overrides and nonboolean options', () => {
  withSource(root => {
    p.checkOptions(options(), 'linux', 'x86_64', root, environment());
    for (const name of ['installer', 'managed', 'experimentalUnix', 'experimentalWritable', 'integratedFeatures', 'linuxPrivateUpdateFixture']) {
      for (const value of [false, 'true', 1]) assert.throws(() => p.checkOptions({ ...options(), [name]: value }, 'linux', 'x86_64', root, environment()));
    }
    for (const name of ['prepareManagedUnix', 'linuxRetirementCandidate', 'linuxIntegratedCandidate', 'linuxProductionMigration', 'linuxPortableHostCandidate']) {
      assert.throws(() => p.checkOptions({ ...options(), [name]: true }, 'linux', 'x86_64', root, environment()), /other build profiles/);
    }
    for (const name of ['CREATOR_LINUX_INTEGRATED_CANDIDATE', 'CREATOR_LINUX_PRODUCTION_MIGRATION_016',
      'CREATOR_LINUX_RETIREMENT_TEST_CANDIDATE', 'CREATOR_LINUX_PORTABLE_HOST_CANDIDATE']) {
      assert.throws(() => p.context('linux', 'x86_64', { ...environment(), [name]: '1' }), /other Linux profiles/);
    }
    for (const name of ['APPLE_TEST', 'TAURI_SIGNING_TEST', 'CREATOR_HUB_SIGNING_TEST', 'LD_PRELOAD', 'DYLD_TEST',
      'NODE_OPTIONS', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_RUSTFLAGS', 'CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS']) {
      assert.throws(() => p.context('linux', 'x86_64', { ...environment(), [name]: '' }), /runtime\/compiler overrides/);
    }
    for (const value of [null, 'relative-input']) assert.throws(() => p.checkOptions({ ...options(), signedUnixInput: value }, 'linux', 'x86_64', root, environment()), /separate trusted handoff/);
  });
});

test('private017 source requires actual17 JSON/lock and locked offline Cargo versions/default-off restart declarations', () => {
  withSource(root => {
    const calls = [], source = p.source(root, executor(root, calls));
    assert.deepEqual(source, { profile: p.PROFILE, version: p.VERSION, requestedFeatures: [...p.FEATURES], ...p.FLAGS });
    assert.equal(Object.hasOwn(source, 'compiledFeatures'), false);
    assert.equal(calls.length, 3); assert.ok(calls.every(([command]) => command === 'cargo'));
    const run = executor(root);
    assert.throws(() => p.source(root, (command, args) => {
      if (command === 'cargo' && args[0] === 'tree') throw Error('stale Cargo.lock rejected by --locked');
      return run(command, args);
    }), /stale Cargo.lock/);
    assert.throws(() => p.source(root, (command, args) => command === 'cargo' && args[0] === 'tree'
      ? `creator-hub v0.1.16 (${root})` : run(command, args)), /locked Cargo Root identity/);
    for (const change of [
      value => { if (value.packages[0].name === 'creator-hub') value.packages[0].version = '0.1.16'; },
      value => { value.packages[0].features.default = ['experimental-restart', 'linux-production-migration']; },
      value => { if (value.packages[0].name === 'creator-hub') delete value.packages[0].features['integrated-features']; },
      value => { if (value.packages[0].name === 'creator-hub') value.packages[0].features['experimental-linux-portable-update'] = ['experimental-linux-portable-host']; },
      value => { if (value.packages[0].name !== 'creator-hub') value.packages[0].features['experimental-restart'] = ['unreviewed']; },
      value => { value.packages.push(value.packages[0]); },
    ]) assert.throws(() => p.source(root, executor(root, [], change)));
    for (const name of ['package.json', 'src-tauri/tauri.conf.json', 'package-lock.json']) {
      const file = path.join(root, name), before = fs.readFileSync(file);
      fs.writeFileSync(file, JSON.stringify({ version: '0.1.16' }));
      assert.throws(() => p.source(root, () => assert.fail('Old source must refuse before Cargo')), /actual Root17/);
      fs.writeFileSync(file, before);
    }
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version: p.VERSION, packages: { '': { version: '0.1.16' } } }));
    assert.throws(() => p.versions(root), /npm root lock/);
  });
});

test('private017 compile contract is exactly the production four-tuple, never host-only or inherited dev flags', () => {
  const args = ['--features', 'integrated-features,experimental-flatpak-host,linux-production-migration,experimental-linux-portable-update'];
  assert.deepEqual(p.compileArguments(), args); p.validateCompileArguments(args);
  for (const wrong of [[], ['--features', builder.PORTABLE_HOST_FEATURES.join(',')], ['--features', builder.PRODUCTION_FEATURES.join(',')],
    ['--features', args[1] + ',experimental-linux-portable-host'], ['--features', [...p.FEATURES].reverse().join(',')]]) {
    assert.throws(() => p.validateCompileArguments(wrong), /exact production portable/);
  }
  for (const name of ['nativeGuiAccepted', 'migrationAccepted', 'authenticationAccepted', 'signedUpdateAccepted', 'restartAccepted', 'releaseReady']) {
    assert.equal(p.FLAGS[name], false);
  }
});

test('private017 assembly admission is distinct and refuses dirty or untracked initial source', () => {
  withSource(root => {
    const calls = [], env = environment(), run = executor(root, calls);
    const accepted = assembly.admission(root, 'linux', 'x86_64', env, run);
    assert.equal(accepted.version, '0.1.17'); assert.equal(accepted.profile, p.PROFILE);
    assert.equal(accepted.commit, env.GITHUB_SHA); assert.equal(accepted.handoffSha256, env.CREATOR_UNIX_HANDOFF_SHA256);
    for (const dirty of [' M src-tauri/src/main.rs', '?? src-tauri/src/new.rs']) {
      assert.throws(() => assembly.admission(root, 'linux', 'x86_64', env,
        (command, args) => command === 'git' && args[0] === 'status' ? dirty : run(command, args)), /Clean initial/);
    }
    assert.throws(() => assembly.admission(root, 'linux', 'x86_64', { ...env, [p.FLAG]: '0' }, run), /private017 context/);
  });
});

test('valid private017 selection remains blocked before handoff inspection, compiler execution or proof publication', () => {
  withSource(root => {
    const calls = [], context = { root, platform: 'linux', arch: 'x86_64', env: environment(), execute: executor(root, calls) };
    assert.throws(() => builder.build('private017-never-built', options(), context), /distinct trusted017 handoff derivation and exact017 packaging verifier/);
    assert.ok(calls.every(([command, args]) => command === 'git' || command === 'cargo' && ['metadata', 'tree'].includes(args[0])));
    assert.equal(fs.existsSync(path.join(root, 'artifacts')), false);
    assert.throws(() => p.requireTrustedHandoff(), /Original016 producer evidence must not be relabelled/);
  });
});

test('historical and production016 paths do not load the new private017 contract', () => {
  withSource(root => {
    const script = `
      const assert = require('node:assert/strict'), Module = require('node:module');
      const original = Module._load;
      Module._load = function(name, ...args) {
        if (name.endsWith('/private-linux-update-fixture-017.cjs')) throw Error('Old profiles must not load private017');
        return original.call(this, name, ...args);
      };
      const b = require(${JSON.stringify(require.resolve('./build-unified.cjs'))});
      const a = require(${JSON.stringify(require.resolve('./assemble-unix-payload.cjs'))});
      assert.equal(b.candidateProfile({ integratedFeatures: true, linuxProductionMigration: true }), 'production-migration-016');
      assert.deepEqual(b.integrationArguments('linux', 'x86_64', true, true, true, true), ['--features', b.PRODUCTION_PORTABLE_FEATURES.join(',')]);
      const env = ${JSON.stringify(environment())};
      env.GITHUB_REF = 'refs/heads/validation/unix-assembly-014';
      env.GITHUB_WORKFLOW_REF = 'BOBWORKS-XR/CREATOR-HUB/' + a.WORKFLOW + '@' + env.GITHUB_REF;
      env[${JSON.stringify(p.FLAG)}] = '0';
      const root = ${JSON.stringify(root)};
      const execute = (_, args) => args[1] === '--show-toplevel' ? root : args[1] === 'HEAD' ? env.GITHUB_SHA : '';
      assert.equal(a.admission(root, 'linux', 'x86_64', env, execute).version, '0.1.14');
    `;
    execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
  });
});
