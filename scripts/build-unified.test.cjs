const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { relativeFile, moduleFiles, verifyStage, stageFileMode } = require('./build-unified.cjs');

test('signed assembly receipts use the admitted version and actual 016 Cargo features without changing frozen14 shape', () => {
  const { signedAssemblyReceipt, integrationArguments } = require('./build-unified.cjs');
  const result = { version: '0.1.16', source: { sourceCommit: 'a'.repeat(40) }, handoffSha256: 'b'.repeat(64) };
  const args = integrationArguments('linux', 'x86_64', true, true);
  const receipt = signedAssemblyReceipt(result, 'linux', 'x86_64', 'c'.repeat(40), args);
  assert.equal(receipt.hubVersion, '0.1.16');
  assert.deepEqual(receipt.compiledFeatures, args[1].split(','));
  assert.deepEqual(receipt.privateSource, result.source);
  for (const key of ['privateModulesRecompiled', 'privateModulesResigned', 'nativeGuiAccepted', 'releaseReady']) assert.equal(receipt[key], false);
  for (const features of [[], ['--features', 'integrated-features'], ['--features', args[1] + ',unreviewed']]) {
    assert.throws(() => signedAssemblyReceipt(result, 'linux', 'x86_64', 'c'.repeat(40), features), /actual integrated Cargo/);
  }
  for (const target of [['macos', 'aarch64'], ['linux', 'aarch64']]) assert.throws(() => signedAssemblyReceipt(result, ...target, 'c'.repeat(40), args), /admitted version and platform/);
  assert.throws(() => signedAssemblyReceipt({ ...result, version: '0.1.17' }, 'linux', 'x86_64', 'c'.repeat(40), args), /admitted version/);
  const frozen = signedAssemblyReceipt({ ...result, version: '0.1.14' }, 'linux', 'x86_64', 'c'.repeat(40), []);
  assert.equal(frozen.hubVersion, '0.1.14');
  assert.equal(Object.hasOwn(frozen, 'compiledFeatures'), false);
  const source = fs.readFileSync(path.join(__dirname, 'assemble-unix-payload.cjs'), 'utf8');
  assert.match(source, /return \{ manifest, version: accepted\.version, source: handoff\.source/);
  const builder = fs.readFileSync(path.join(__dirname, 'build-unified.cjs'), 'utf8');
  assert.match(builder, /signedAssemblyReceipt\(result, platform, arch, environment\.GITHUB_SHA, featureArgs, portableProof, productionProof\)/);
});

function productionStaging(commit, files) {
  const p = require('./linux-retirement-package.cjs');
  return { schemaVersion: 2, acceptanceOnly: true, sourceCommit: commit, platform: 'linux', arch: 'x86_64',
    rootFeature: p.PRODUCTION_ROOT_FEATURE, helperFeature: p.PRODUCTION_HELPER_FEATURE, files, profile: p.PRODUCTION_PROFILE,
    productionContract: p.PRODUCTION_CONTRACT, ...p.FLAGS };
}

test('private017 is a separate explicit selector and cannot mix with production016 or historical profiles', () => {
  const b = require('./build-unified.cjs'), p = require('./private-linux-update-fixture-017.cjs');
  assert.deepEqual(b.parseBuildOptions(['--linux-private-update-fixture-017']), { linuxPrivateUpdateFixture: true });
  assert.throws(() => b.parseBuildOptions(['--linux-private-update-fixture-017', '--linux-private-update-fixture-017']), /Duplicate/);
  const options = { linuxPrivateUpdateFixture: true, integratedFeatures: true };
  assert.equal(b.candidateProfile(options), p.PROFILE);
  for (const change of [{ linuxPrivateUpdateFixture: 'true' }, { integratedFeatures: false },
    { linuxProductionMigration: true }, { linuxIntegratedCandidate: true }, { linuxRetirementCandidate: true }, { linuxPortableHostCandidate: true }]) {
    assert.throws(() => b.candidateProfile({ ...options, ...change }));
  }
  assert.equal(b.candidateProfile({ integratedFeatures: true, linuxProductionMigration: true }), 'production-migration-016');
  assert.equal(b.candidateProfile({ integratedFeatures: true, linuxIntegratedCandidate: true }), 'integrated-candidate');
  assert.throws(() => b.build('never-build17', options, { env: {}, execute() { assert.fail('No tooling without exact private017 context'); } }), /native Linux|private017 context/);
});

test('production016 profile is explicit, exclusive and refuses unsigned or old source before any tooling', () => {
  const b = require('./build-unified.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'creator-production-options-')));
  const options = { linuxProductionMigration: true, integratedFeatures: true, installer: true, managed: true,
    experimentalUnix: true, experimentalWritable: true, signedUnixInput: path.resolve('/reviewed-input') };
  const versions = version => {
    for (const file of ['package.json', 'src-tauri/tauri.conf.json']) fs.writeFileSync(path.join(root, file), JSON.stringify({ version }));
  };
  try {
    fs.mkdirSync(path.join(root, 'src-tauri')); versions('0.1.16');
    assert.deepEqual(b.parseBuildOptions(['--linux-production-migration-016']), { linuxProductionMigration: true });
    assert.throws(() => b.parseBuildOptions(['--linux-production-migration-016', '--linux-production-migration-016']), /Duplicate/);
    assert.equal(b.candidateProfile(options), 'production-migration-016');
    b.checkProductionOptions(options, 'linux', 'x86_64', root, {});
    assert.deepEqual(b.integrationArguments('linux', 'x86_64', true, true, false, true), ['--features', b.PRODUCTION_FEATURES.join(',')]);
    assert.deepEqual(b.integrationArguments('linux', 'x86_64', true, true, true, true), ['--features', b.PRODUCTION_PORTABLE_FEATURES.join(',')]);
    assert.deepEqual(b.PRODUCTION_PORTABLE_FEATURES, ['integrated-features', 'experimental-flatpak-host', 'linux-production-migration', 'experimental-linux-portable-update']);
    for (const change of [{ linuxRetirementCandidate: true }, { linuxIntegratedCandidate: true }, { integratedFeatures: false },
      { installer: false }, { managed: false }, { experimentalUnix: false }, { experimentalWritable: false },
      { prepareManagedUnix: true }, { signedUnixInput: null }]) {
      assert.throws(() => b.build('never-build', { ...options, ...change }, { root, platform: 'linux', arch: 'x86_64',
        env: {}, execute() { assert.fail('No tooling for rejected production options'); } }));
    }
    for (const [platform, arch] of [['windows', 'x86_64'], ['macos', 'x86_64'], ['linux', 'aarch64']]) {
      assert.throws(() => b.checkProductionOptions(options, platform, arch, root, {}), /signed native Linux/);
      assert.throws(() => b.integrationArguments(platform, arch, true, true, false, true), /integrated Linux/);
    }
    for (const key of ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_BUILD_RUSTFLAGS', 'CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS']) {
      assert.throws(() => b.checkProductionOptions(options, 'linux', 'x86_64', root, { [key]: '' }), /compiler overrides/);
    }
    versions('0.1.14');
    assert.throws(() => b.build('never-build', options, { root, platform: 'linux', arch: 'x86_64', env: {},
      execute() { assert.fail('No tooling or receipt relabel for old Root'); } }), /old Root cannot be relabelled/);
    assert.throws(() => b.candidateProfile({ linuxProductionMigration: 'true' }), /explicit boolean/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('production build proof binds exact Cargo declarations, helper/policy and new actual Root, not old receipts', () => {
  const b = require('./build-unified.cjs'), p = require('./linux-retirement-package.cjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'creator-production-proof-')));
  const commit = 'a'.repeat(40), tree = 'b'.repeat(40), featureArgs = ['--features', b.PRODUCTION_FEATURES.join(',')];
  const helper = Buffer.alloc(128, 1), policy = Buffer.from('synthetic policy, never executed');
  const header = Buffer.alloc(64); Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(header); header.writeUInt16LE(3, 16); header.writeUInt16LE(62, 18);
  const metadata = file => {
    const helper = file.includes('linux-deb-retirement'), portable = file.includes('linux-portable-deployment');
    return { packages: [{ manifest_path: file, name: helper ? 'creator-hub-linux-deb-retirement' : portable ? 'creator-hub-linux-portable-deployment' : 'creator-hub',
      version: helper || portable ? '0.1.0' : '0.1.16', features: { default: [],
        ...(helper ? { [p.PRODUCTION_HELPER_FEATURE]: ['dep:signal-hook'] } : portable ? { 'experimental-restart': [] } : {
          [p.PRODUCTION_ROOT_FEATURE]: ['experimental-linux-migration'],
          'experimental-linux-portable-host': ['dep:creator-hub-linux-portable-deployment', 'integrated-features', 'experimental-flatpak-host'],
          [b.PRODUCTION_PORTABLE_FEATURE]: ['experimental-linux-portable-host', 'creator-hub-linux-portable-deployment/experimental-restart'],
        }) } }] };
  };
  const execute = (command, args) => {
    if (command === 'cargo') {
      assert.deepEqual(args.slice(0, 7), ['metadata', '--locked', '--offline', '--no-deps', '--format-version', '1', '--manifest-path']);
      return JSON.stringify(metadata(args[7]));
    }
    assert.equal(command, 'git');
    if (args[0] === 'diff') {
      assert.ok([b.PRODUCTION_SOURCE_PATHS, b.PORTABLE_SOURCE_PATHS].some(paths => JSON.stringify(args) === JSON.stringify(['diff', '--exit-code', 'HEAD', '--', ...paths])));
      return '';
    }
    if (args[0] === 'status') {
      assert.ok([b.PRODUCTION_SOURCE_PATHS, b.PORTABLE_SOURCE_PATHS].some(paths => JSON.stringify(args) === JSON.stringify(['status', '--porcelain=v1', '--untracked-files=all', '--', ...paths])));
      return '';
    }
    assert.equal(args[0], 'rev-parse');
    return args[1] === 'HEAD' ? commit : tree;
  };
  try {
    fs.mkdirSync(path.join(root, 'linux-retirement'));
    for (const [name, bytes, mode] of [[p.HELPER, helper, 0o755], [p.POLICY, policy, 0o644]]) {
      const file = path.join(root, 'linux-retirement', path.posix.basename(name)); fs.writeFileSync(file, bytes, { mode }); fs.chmodSync(file, mode);
    }
    const files = { [p.HELPER]: p.record(path.join(root, 'linux-retirement', path.posix.basename(p.HELPER)), 0o755),
      [p.POLICY]: p.record(path.join(root, 'linux-retirement', path.posix.basename(p.POLICY)), 0o644) };
    const staged = { overlay: path.join(root, 'overlay.json'), profile: p.PRODUCTION_PROFILE, files, productionReceipt: productionStaging(commit, files) };
    const file = path.join(root, 'creator-hub'); fs.writeFileSync(file, header);
    const proof = b.productionBuildProof(root, file, featureArgs, { GITHUB_SHA: commit }, staged, execute);
    assert.equal(proof.sourceTree, tree); assert.equal(proof.rawHub.sha256, crypto.createHash('sha256').update(header).digest('hex'));
    const result = { version: '0.1.16', source: { sourceCommit: 'c'.repeat(40) }, handoffSha256: 'd'.repeat(64) };
    const receipt = b.signedAssemblyReceipt(result, 'linux', 'x86_64', commit, featureArgs, null, proof);
    assert.deepEqual(receipt.productionMigration, proof); assert.deepEqual(receipt.compiledFeatures, b.PRODUCTION_FEATURES);
    assert.equal(receipt.releaseReady, false); assert.equal(receipt.nativeGuiAccepted, false);
    assert.throws(() => b.signedAssemblyReceipt(result, 'linux', 'x86_64', commit, featureArgs), /Actual production Root build proof/);
    assert.throws(() => b.signedAssemblyReceipt(result, 'linux', 'x86_64', commit, b.integrationArguments('linux', 'x86_64', true, true), null, proof), /actual production Cargo/);
    assert.throws(() => b.signedAssemblyReceipt({ ...result, version: '0.1.14' }, 'linux', 'x86_64', commit, featureArgs, null, proof), /old Root/);
    const portableArgs = ['--features', b.PRODUCTION_PORTABLE_FEATURES.join(',')];
    fs.writeFileSync(file, Buffer.concat([header, Buffer.from(b.PORTABLE_ROOT_WITNESSES.join('\n'))]));
    const portable = b.portableBuildProof(root, file, portableArgs, { GITHUB_SHA: commit }, execute);
    const production = b.productionBuildProof(root, file, portableArgs, { GITHUB_SHA: commit }, staged, execute);
    const combined = b.signedAssemblyReceipt(result, 'linux', 'x86_64', commit, portableArgs, portable, production);
    assert.deepEqual(combined.compiledFeatures, b.PRODUCTION_PORTABLE_FEATURES);
    assert.deepEqual(combined.portableHostBuild, portable);
    assert.deepEqual(combined.productionMigration, production);
    assert.equal(combined.releaseReady, false);
    for (const [label, paths, makeProof, untracked] of [
      ['production', b.PRODUCTION_SOURCE_PATHS,
        run => b.productionBuildProof(root, file, featureArgs, { GITHUB_SHA: commit }, staged, run),
        ['src-tauri/src/native_support.rs', 'src-tauri/src/portable_package.rs', 'scripts/linux-retirement-package-verify.py']],
      ['production portable', b.PORTABLE_SOURCE_PATHS,
        run => b.portableBuildProof(root, file, portableArgs, { GITHUB_SHA: commit }, run),
        ['src-tauri/src/native_support.rs', 'src-tauri/src/portable_package.rs', 'native/linux-portable-deployment/src/new.rs',
          'modules/mcp/launcher/src-tauri/src/new.rs']],
    ]) {
      const calls = [];
      const clean = (command, args) => {
        if (command === 'git') calls.push(args);
        return execute(command, args);
      };
      const before = makeProof(clean);
      const diff = calls.findIndex(args => args[0] === 'diff');
      const status = calls.findIndex(args => args[0] === 'status');
      const treeRead = calls.findIndex(args => args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}');
      assert.ok(diff >= 0 && diff < status && status < treeRead, `${label}: bounded cleanliness before proof publication`);
      assert.deepEqual(calls[status], ['status', '--porcelain=v1', '--untracked-files=all', '--', ...paths]);
      for (const changed of [null, ...untracked]) {
        const attempted = [];
        let published = false;
        assert.throws(() => {
          makeProof((command, args) => {
            if (command === 'git') {
              attempted.push(args);
              if (args[0] === 'diff' && changed === null) throw Error('post-build tracked source injection');
              if (args[0] === 'status' && changed !== null) return `?? ${changed}\n`;
            }
            return execute(command, args);
          });
          published = true;
        }, changed === null ? /post-build tracked source injection/ : /Untracked or changed production.*source/, label);
        assert.equal(published, false);
        assert.equal(attempted.some(args => args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}'), false);
      }
      assert.deepEqual(makeProof(clean), before, `${label}: unchanged source before and after refusals`);
    }
    for (const change of [{ rawHub: { ...portable.rawHub, sha256: 'f'.repeat(64) } }, { sourceTree: 'f'.repeat(40) }]) {
      assert.throws(() => b.signedAssemblyReceipt(result, 'linux', 'x86_64', commit, portableArgs, { ...portable, ...change }, production), /same actual Root/);
    }
    assert.throws(() => b.signedAssemblyReceipt(result, 'linux', 'x86_64', commit,
      ['--features', [...b.PRODUCTION_FEATURES, 'experimental-linux-portable-host'].join(',')], portable, production), /actual integrated Cargo/);
    assert.throws(() => b.signedAssemblyReceipt(result, 'linux', 'x86_64', commit,
      ['--features', b.PRODUCTION_FEATURES.join(',')], portable, production), /actual portable Cargo feature/);
    assert.throws(() => b.validatePortableBuildProof({ ...portable, compiledFeatures: [...b.PRODUCTION_FEATURES, 'experimental-linux-portable-host'] },
      commit, [...b.PRODUCTION_FEATURES, 'experimental-linux-portable-host']));
    assert.throws(() => b.admitProductionSource(root, (command, args) => {
      const value = metadata(args[7]);
      if (value.packages[0].name === 'creator-hub') value.packages[0].features[b.PRODUCTION_PORTABLE_FEATURE] = ['experimental-linux-portable-host'];
      return JSON.stringify(value);
    }, true), /native host and restart/);
    for (const change of [{ schemaVersion: 1 }, { helperFeature: 'experimental-transaction' }, { rootFeature: 'experimental-linux-migration' },
      { profile: 'integrated-candidate' }, { sourceCommit: 'f'.repeat(40) }, { productionContract: { ...p.PRODUCTION_CONTRACT, nativeAcceptance: true } },
      { releaseReady: true }]) {
      assert.throws(() => b.validateProductionBuildProof({ ...proof, staging: { ...proof.staging, ...change } }, commit, b.PRODUCTION_FEATURES));
    }
    assert.throws(() => b.productionBuildProof(root, file, ['--features', b.PORTABLE_HOST_FEATURES.slice(0, -1).join(',')], { GITHUB_SHA: commit }, staged, execute), /actual Cargo/);
    fs.writeFileSync(path.join(root, 'linux-retirement', path.posix.basename(p.HELPER)), 'changed');
    assert.throws(() => b.productionBuildProof(root, file, featureArgs, { GITHUB_SHA: commit }, staged, execute), /changed after staging/);
    assert.throws(() => b.admitProductionSource(root, (command, args) => {
      const value = metadata(args[7]); delete value.packages[0].features[p.PRODUCTION_ROOT_FEATURE]; return JSON.stringify(value);
    }), /source contract/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('portable startup binding is a new explicit Linux-only profile and cannot relabel old Root', () => {
  const builder = require('./build-unified.cjs');
  const options = { linuxPortableHostCandidate: true, linuxIntegratedCandidate: true, integratedFeatures: true,
    installer: true, managed: true, experimentalUnix: true, experimentalWritable: true, signedUnixInput: path.resolve('/reviewed/runtime-inputs') };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-portable-options-'));
  try {
    fs.mkdirSync(path.join(dir, 'src-tauri'));
    const versions = version => { for (const name of ['package.json', 'src-tauri/tauri.conf.json']) fs.writeFileSync(path.join(dir, name), JSON.stringify({ version })); };
    versions('0.1.16');
    builder.checkPortableHostOptions(options, 'linux', 'x86_64', dir);
    assert.deepEqual(builder.parseBuildOptions(['--linux-portable-host-candidate']), { linuxPortableHostCandidate: true });
    assert.throws(() => builder.parseBuildOptions(['--linux-portable-host-candidate', '--linux-portable-host-candidate']), /Duplicate/);
    assert.deepEqual(builder.integrationArguments('linux', 'x86_64', true, true, true), ['--features', builder.PORTABLE_HOST_FEATURES.join(',')]);
    assert.deepEqual(builder.integrationArguments('windows', 'x86_64', true), ['--features', 'integrated-features']);
    assert.deepEqual(builder.integrationArguments('linux', 'x86_64', true, true), ['--features', builder.PORTABLE_HOST_FEATURES.slice(0, -1).join(',')]);
    for (const [platform, arch] of [['windows', 'x86_64'], ['linux', 'aarch64'], ['macos', 'x86_64']]) {
      assert.throws(() => builder.checkPortableHostOptions(options, platform, arch, dir), /explicit signed integrated Linux/);
      assert.throws(() => builder.integrationArguments(platform, arch, true, true, true), /explicit integrated Linux/);
    }
    for (const change of [{ linuxIntegratedCandidate: false }, { integratedFeatures: false }, { linuxRetirementCandidate: true },
      { installer: false }, { managed: false }, { experimentalUnix: false }, { experimentalWritable: false },
      { prepareManagedUnix: true }, { signedUnixInput: null }]) {
      assert.throws(() => builder.checkPortableHostOptions({ ...options, ...change }, 'linux', 'x86_64', dir), /explicit signed integrated Linux/);
    }
    versions('0.1.14');
    assert.throws(() => builder.build('never-build', options, { root: dir, platform: 'linux', arch: 'x86_64',
      execute() { assert.fail('Old Root must refuse before tooling'); } }), /old Root cannot be relabelled/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('portable proof uses locked Cargo source metadata, actual Root bytes and compiled startup witnesses', () => {
  const builder = require('./build-unified.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-portable-proof-'));
  const commit = 'a'.repeat(40), tree = 'b'.repeat(40), featureArgs = ['--features', builder.PORTABLE_HOST_FEATURES.join(',')];
  const header = Buffer.alloc(64); Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(header); header.writeUInt16LE(3, 16); header.writeUInt16LE(62, 18);
  const bytes = Buffer.concat([header, Buffer.from(builder.PORTABLE_ROOT_WITNESSES.join('\n'))]);
  const file = path.join(dir, 'creator-hub');
  const metadata = { packages: [{ name: 'creator-hub', version: '0.1.16', manifest_path: path.join(dir, 'src-tauri/Cargo.toml'),
    features: { 'experimental-linux-portable-host': ['dep:creator-hub-linux-portable-deployment', 'integrated-features', 'experimental-flatpak-host'] } }] };
  const execute = (command, args) => {
    if (command === 'cargo') {
      assert.deepEqual(args.slice(0, 7), ['metadata', '--locked', '--offline', '--no-deps', '--format-version', '1', '--manifest-path']);
      return JSON.stringify(metadata);
    }
    assert.equal(command, 'git');
    if (args[0] === 'diff') {
      assert.deepEqual(args, ['diff', '--exit-code', 'HEAD', '--', ...builder.PORTABLE_SOURCE_PATHS]);
      return '';
    }
    assert.equal(args[0], 'rev-parse');
    return args[1] === 'HEAD' ? commit : tree;
  };
  try {
    fs.writeFileSync(file, header);
    assert.throws(() => builder.portableBuildProof(dir, file, featureArgs, { GITHUB_SHA: commit }, () => assert.fail('No source probe for an old binary')), /missing its compiled/);
    fs.writeFileSync(file, bytes);
    const proof = builder.portableBuildProof(dir, file, featureArgs, { GITHUB_SHA: commit }, execute);
    assert.throws(() => builder.portableBuildProof(dir, file, featureArgs, { GITHUB_SHA: 'f'.repeat(40) }, execute), /source changed/);
    assert.throws(() => builder.portableBuildProof(dir, file, featureArgs, { GITHUB_SHA: commit }, (command, args) => {
      if (command === 'git' && args[0] === 'diff') throw Error('changed Root source');
      return execute(command, args);
    }), /changed Root source/);
    assert.deepEqual(proof.rawHub, { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    const result = { version: '0.1.16', source: { sourceCommit: 'c'.repeat(40) }, handoffSha256: 'd'.repeat(64) };
    assert.deepEqual(builder.signedAssemblyReceipt(result, 'linux', 'x86_64', commit, featureArgs, proof).portableHostBuild, proof);
    assert.throws(() => builder.signedAssemblyReceipt(result, 'linux', 'x86_64', commit, featureArgs), /actual Root build proof/);
    assert.throws(() => builder.signedAssemblyReceipt({ ...result, version: '0.1.14' }, 'linux', 'x86_64', commit, featureArgs, proof), /old Root/);
    assert.throws(() => builder.signedAssemblyReceipt(result, 'linux', 'x86_64', commit, builder.integrationArguments('linux', 'x86_64', true, true), proof), /actual portable Cargo feature/);
    assert.throws(() => builder.validatePortableBuildProof(proof, commit, builder.PORTABLE_HOST_FEATURES, { ...proof.rawHub, sha256: 'f'.repeat(64) }, tree), /actual Root bytes/);
    metadata.packages[0].version = '0.1.14';
    assert.throws(() => builder.admitPortableSource(dir, execute), /old compiled Root version/);
    metadata.packages[0].version = '0.1.16'; delete metadata.packages[0].features['experimental-linux-portable-host'];
    assert.throws(() => builder.admitPortableSource(dir, execute), /exact native startup-binding feature/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('direct page packaging is explicit, platform-specific and cannot disguise writable features as a read-only candidate', () => {
  const { integrationArguments, parseBuildOptions, build } = require('./build-unified.cjs');
  assert.deepEqual(integrationArguments('windows', 'x86_64', false), []);
  assert.deepEqual(integrationArguments('windows', 'x86_64', true), ['--features', 'integrated-features']);
  assert.throws(() => integrationArguments('windows', 'x86_64', true, true), /Linux retirement flags/);
  for (const [platform, arch] of [['windows', 'aarch64'], ['macos', 'aarch64'], ['linux', 'aarch64']]) {
    assert.throws(() => integrationArguments(platform, arch, true), /Windows or Linux x86_64/);
  }
  assert.deepEqual(integrationArguments('linux', 'x86_64', true, true),
    ['--features', 'integrated-features,experimental-flatpak-host,experimental-linux-migration']);
  assert.deepEqual(parseBuildOptions(['--integrated-features']), { integratedFeatures: true });
  assert.throws(() => parseBuildOptions(['--integrated-features', '--integrated-features']), /Duplicate/);
  assert.throws(() => build('never-build', { integratedFeatures: true }, { platform: 'linux', arch: 'x86_64',
    execute() { throw Error('Must refuse before execution'); } }), /managed writable Unix Hub candidate/);
});

test('direct Windows options refuse Unix profiles and unmanaged payloads before any tooling runs', () => {
  const { build } = require('./build-unified.cjs');
  for (const options of [{}, { managed: true, experimentalUnix: true },
    { managed: true, experimentalWritable: true }, { managed: true, prepareManagedUnix: true },
    { managed: true, signedUnixInput: 'untrusted' }]) {
    assert.throws(() => build('never-build', { integratedFeatures: true, ...options }, {
      platform: 'windows', arch: 'x86_64', execute() { throw Error('Must refuse before execution'); },
    }), /Direct Windows features require/);
  }
});

test('direct Windows receipt claims only the implementation mode and never Linux helper or acceptance', () => {
  const { stageWindowsIntegration } = require('./build-unified.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-windows-direct-'));
  try {
    stageWindowsIntegration(dir);
    assert.deepEqual(fs.readdirSync(dir), ['direct-features-candidate.json']);
    const bytes = fs.readFileSync(path.join(dir, 'direct-features-candidate.json'));
    const receipt = JSON.parse(bytes);
    assert.equal(receipt.scope, 'windows-direct-features-candidate');
    assert.deepEqual(receipt.internalServices, ['mcp', 'setup']);
    assert.equal(receipt.legacyLaunchersRetainedAsResources, true);
    assert.equal(receipt.activationRunsOutsideSandbox, undefined);
    for (const key of ['nativeGuiAccepted', 'migrationAccepted', 'signedUpdateAccepted', 'releaseReady']) assert.equal(receipt[key], false);
    assert.throws(() => stageWindowsIntegration(dir), /EEXIST/);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'direct-features-candidate.json')), bytes);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('direct candidates retain exact service bytes and existing helper file maps without claiming acceptance', () => {
  const { stageIntegrationService } = require('./build-unified.cjs');
  const activation = require('./flatpak-native-activation.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-direct-overlay-'));
  try {
    const overlay = path.join(dir, 'tauri.json');
    const before = { bundle: { resources: { 'archive.dat': 'archive.dat' }, linux: { deb: {
      depends: ['policykit-1'], files: { '/usr/libexec/existing-helper': 'existing-helper' },
    } } }, build: { features: ['experimental-linux-migration'] } };
    fs.writeFileSync(overlay, JSON.stringify(before));
    stageIntegrationService(dir, overlay);
    const after = JSON.parse(fs.readFileSync(overlay));
    assert.deepEqual(after.bundle.resources, before.bundle.resources);
    assert.deepEqual(after.build, before.build);
    assert.deepEqual(after.bundle.linux.deb.depends, ['policykit-1']);
    assert.equal(after.bundle.linux.deb.files['/usr/libexec/existing-helper'], 'existing-helper');
    assert.deepEqual(fs.readFileSync(after.bundle.linux.deb.files[`/${activation.SERVICE}`]), activation.service());
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'direct-features-candidate.json')));
    assert.equal(receipt.activationRunsOutsideSandbox, true);
    for (const key of ['nativeGuiAccepted', 'migrationAccepted', 'signedUpdateAccepted', 'flatpakActivationAccepted', 'releaseReady']) assert.equal(receipt[key], false);
    const bytes = fs.readFileSync(overlay);
    assert.throws(() => stageIntegrationService(dir, overlay), /already mapped/);
    assert.deepEqual(fs.readFileSync(overlay), bytes);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('integrated Linux DEB profile is explicit and refuses incompatible flags before signing or building', () => {
  const { candidateProfile, parseBuildOptions, build } = require('./build-unified.cjs');
  assert.deepEqual(parseBuildOptions(['--linux-integrated-candidate', '--integrated-features']),
    { linuxIntegratedCandidate: true, integratedFeatures: true });
  assert.equal(candidateProfile({}), 'retirement-acceptance');
  assert.equal(candidateProfile({ linuxIntegratedCandidate: true, integratedFeatures: true }), 'integrated-candidate');
  for (const options of [{ linuxIntegratedCandidate: true },
    { linuxIntegratedCandidate: true, linuxRetirementCandidate: true, integratedFeatures: true }]) {
    assert.throws(() => build('never-build', options, { platform: 'linux', arch: 'x86_64',
      execute() { throw Error('Must refuse before execution'); } }), /requires --integrated-features/);
  }
  assert.throws(() => build('never-build', { linuxIntegratedCandidate: true, integratedFeatures: true,
    managed: true, experimentalUnix: true, experimentalWritable: true }, { platform: 'linux', arch: 'x86_64',
    execute() { throw Error('Must refuse before execution'); } }), /requires signed native Linux/);
});

test('internal MCP compile snapshots use the already verified staged payload, never inherited or standalone paths', () => {
  const { integrationEnvironment } = require('./build-unified.cjs');
  const environment = { KEEP: 'original' };
  assert.equal(integrationEnvironment(environment, 'unused', false), environment);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-integrated-input-'));
  try {
    const payload = path.join(dir, 'modules', 'mcp', 'server');
    fs.mkdirSync(payload, { recursive: true });
    assert.deepEqual(integrationEnvironment(environment, dir, true, 'linux'),
      { KEEP: 'original', CREATOR_HUB_INTEGRATED_MCP_PAYLOAD: payload });
    assert.deepEqual(integrationEnvironment({ ...environment, CARGO_BUILD_JOBS: '8' }, dir, true, 'win32'),
      { KEEP: 'original', CARGO_BUILD_JOBS: '1', CREATOR_HUB_INTEGRATED_MCP_PAYLOAD: payload });
    assert.deepEqual(integrationEnvironment({ ...environment, CARGO_BUILD_JOBS: '8' }, dir, true, 'linux'),
      { KEEP: 'original', CARGO_BUILD_JOBS: '8', CREATOR_HUB_INTEGRATED_MCP_PAYLOAD: payload });
    assert.deepEqual(environment, { KEEP: 'original' });
    assert.throws(() => integrationEnvironment({ CREATOR_HUB_INTEGRATED_MCP_PAYLOAD: payload }, dir, true), /inherited environment/);
    fs.rmdirSync(payload);
    assert.throws(() => integrationEnvironment(environment, dir, true));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Tauri dependency resources reuse exact signed bytes and the established native-node alias without overwriting', () => {
  const { stageIntegratedMcpResources } = require('./build-unified.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-integrated-tauri-'));
  try {
    const output = path.join(dir, 'staged');
    const names = ['creator-works-mcp.mjs', 'runtime/node', 'runtime/LICENSE', 'runtime/VERSION'];
    const manifest = { platform: 'linux', arch: 'x86_64', modules: { mcp: { files: {} } } };
    for (const name of names) {
      const source = path.join(output, 'modules', 'mcp', 'server', name);
      fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, name);
      manifest.modules.mcp.files[`mcp/server/${name}`] = crypto.createHash('sha256').update(name).digest('hex');
    }
    const before = JSON.stringify(manifest);
    stageIntegratedMcpResources(dir, output, manifest);
    stageIntegratedMcpResources(dir, output, manifest);
    assert.equal(JSON.stringify(manifest), before);
    for (const name of names) assert.equal(fs.readFileSync(path.join(dir, 'modules/mcp/release', name), 'utf8'), name);
    assert.equal(fs.readFileSync(path.join(dir, 'modules/mcp/release/runtime/node.exe'), 'utf8'), 'runtime/node');
    assert.equal(manifest.modules.mcp.files['mcp/server/runtime/node.exe'], undefined);
    const destination = path.join(dir, 'modules/mcp/release/runtime/VERSION');
    fs.writeFileSync(destination, 'unrelated');
    assert.throws(() => stageIntegratedMcpResources(dir, output, manifest), /nothing was overwritten/);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'unrelated');
    fs.writeFileSync(path.join(output, 'modules/mcp/server/runtime/node'), 'changed');
    assert.throws(() => stageIntegratedMcpResources(dir, output, manifest), /input changed/);
    assert.throws(() => stageIntegratedMcpResources(dir, output, { ...manifest, platform: 'windows' }), /Linux x86_64/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the real MCP Tauri resource map cannot acquire an unstaged generated input unnoticed', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../modules/mcp/launcher/src-tauri/tauri.conf.json')));
  const generated = Object.entries(config.bundle.resources).filter(([source]) => source.startsWith('../../release/'));
  assert.deepEqual(generated.sort(), [
    ['../../release/creator-works-mcp.mjs', 'server/creator-works-mcp.mjs'],
    ['../../release/runtime/LICENSE', 'server/runtime/LICENSE'],
    ['../../release/runtime/VERSION', 'server/runtime/VERSION'],
    ['../../release/runtime/node', 'server/runtime/node'],
    ['../../release/runtime/node.exe', 'server/runtime/node.exe'],
  ].sort());
  for (const source of Object.keys(config.bundle.resources).filter(source => !source.startsWith('../../release/'))) {
    assert.ok(fs.statSync(path.resolve(__dirname, '../modules/mcp/launcher/src-tauri', source)).isFile(), source);
  }
});

test('Linux staged data and executables get canonical archive modes without changing other platform policy', () => {
  const writes = [];
  const chmod = (file, mode) => writes.push({ file, mode });
  stageFileMode('server.mjs', 'linux', false, chmod);
  stageFileMode('node', 'linux', true, chmod);
  stageFileMode('server.mjs', 'macos', false, chmod);
  stageFileMode('node', 'macos', true, chmod);
  stageFileMode('node.exe', 'windows', true, chmod);
  assert.deepEqual(writes, [{ file: 'server.mjs', mode: 0o644 }, { file: 'node', mode: 0o755 }, { file: 'node', mode: 0o755 }]);
});

test('native built-in acceptance refuses the user PC before inspecting apps', () => {
  const result = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, 'native-builtin-smoke.cjs')], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '' }, windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restricted to a disposable/);
});

test('bundle file names cannot traverse or use alternate absolute paths', () => {
  assert.equal(relativeFile('mcp/server/runtime/node.exe'), true);
  for (const name of ['', '../mcp', '/mcp', 'C:/mcp', 'mcp\\file', 'mcp//file', 'mcp/./file']) assert.equal(relativeFile(name), false, name);
});
test('both internal backends must exist and match their build hashes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-builtins-'));
  try {
    const manifest = { schemaVersion: 1, platform: 'windows', arch: 'x86_64', modules: {} };
    for (const id of ['mcp', 'setup']) {
      const names = moduleFiles(id, manifest.platform);
      const files = {};
      for (const name of names) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), id);
        files[name] = crypto.createHash('sha256').update(id).digest('hex');
      }
      manifest.modules[id] = { executable: names[0], version: '1.0.0', files };
    }
    verifyStage(dir, manifest);
    const original = manifest.modules.mcp.files;
    manifest.modules.mcp.files = { [manifest.modules.mcp.executable]: original[manifest.modules.mcp.executable] };
    assert.throws(() => verifyStage(dir, manifest), /incomplete/);
    manifest.modules.mcp.files = original;
    for (const version of ['invalid', null, undefined, 277, '', 'v2.7.7', '02.7.7']) {
      manifest.modules.mcp.version = version;
      assert.throws(() => verifyStage(dir, manifest), /module payload/);
    }
    manifest.modules.mcp.version = '1.0.0';
    const runtime = moduleFiles('mcp', 'windows').find(name => name.endsWith('/runtime/node.exe'));
    fs.unlinkSync(path.join(dir, runtime));
    assert.throws(() => verifyStage(dir, manifest));
    fs.writeFileSync(path.join(dir, runtime), 'mcp');
    fs.writeFileSync(path.join(dir, manifest.modules.mcp.executable), 'changed');
    assert.throws(() => verifyStage(dir, manifest), /changed/);
    fs.unlinkSync(path.join(dir, manifest.modules.mcp.executable));
    assert.throws(() => verifyStage(dir, manifest));
    delete manifest.modules.mcp;
    assert.throws(() => verifyStage(dir, manifest), /manifest/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
