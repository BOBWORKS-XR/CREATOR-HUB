const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const semver = require('semver');

const repositoryRoot = path.resolve(__dirname, '..');
const PORTABLE_HOST_FEATURE = 'experimental-linux-portable-host';
const PORTABLE_ROOT_WITNESSES = ['CREATOR_HUB_PORTABLE_HOST', 'Running Hub is not the selected signed executable'];
const PORTABLE_HOST_FEATURES = ['integrated-features', 'experimental-flatpak-host', 'experimental-linux-migration', PORTABLE_HOST_FEATURE];
const retirementPackage = require('./linux-retirement-package.cjs');
const PRODUCTION_FEATURES = ['integrated-features', 'experimental-flatpak-host', retirementPackage.PRODUCTION_ROOT_FEATURE];
const PRODUCTION_PORTABLE_FEATURE = 'experimental-linux-portable-update';
const PRODUCTION_PORTABLE_FEATURES = [...PRODUCTION_FEATURES, PRODUCTION_PORTABLE_FEATURE];
const PRODUCTION_SOURCE_PATHS = ['package.json', 'package-lock.json', 'src', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock',
  'src-tauri/build.rs', 'src-tauri/tauri.conf.json', 'src-tauri/src', 'native/linux-deb-retirement', 'native/linux-portable-deployment',
  'packaging/linux', 'scripts/build-unified.cjs', 'scripts/linux-retirement-package.cjs', 'scripts/linux-retirement-package-verify.py'];
const PORTABLE_SOURCE_PATHS = ['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock',
  'src-tauri/build.rs', 'src-tauri/tauri.conf.json', 'src-tauri/src', 'src/features', 'native/linux-portable-deployment',
  'modules/mcp/launcher/src-tauri/src', 'modules/project-setup/src-tauri/src'];
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function stageFileMode(file, platform, executable, chmod = fs.chmodSync) {
  // The shebang server runs through private Node; archive data is not executable.
  if (platform === 'linux') chmod(file, executable ? 0o755 : 0o644);
  else if (platform === 'macos' && executable) chmod(file, 0o755);
}
function integrationArguments(platform, arch, enabled, retirement = false, portableHost = false, productionMigration = false) {
  if (productionMigration && !(enabled && retirement && platform === 'linux' && arch === 'x86_64')) throw Error('Production migration requires explicit integrated Linux x86_64 DEB assembly.');
  if (portableHost && !(enabled && retirement && platform === 'linux' && arch === 'x86_64')) throw Error('Portable host candidates require the explicit integrated Linux x86_64 profile.');
  if (!enabled) return [];
  if (platform === 'windows' && arch === 'x86_64' && !retirement) return ['--features', 'integrated-features'];
  if (platform !== 'linux' || arch !== 'x86_64') throw Error('Direct feature candidates require Windows or Linux x86_64. Linux retirement flags cannot be used on Windows.');
  return ['--features', ['integrated-features', 'experimental-flatpak-host',
    ...(retirement ? [productionMigration ? retirementPackage.PRODUCTION_ROOT_FEATURE : 'experimental-linux-migration'] : []),
    ...(portableHost ? [productionMigration ? PRODUCTION_PORTABLE_FEATURE : PORTABLE_HOST_FEATURE] : [])].join(',')];
}
function checkProductionOptions(options, platform, arch, root, env = process.env) {
  if (!options.linuxProductionMigration) return;
  candidateProfile(options);
  if (!(platform === 'linux' && arch === 'x86_64' && options.installer && options.managed && options.experimentalUnix
    && options.experimentalWritable && !options.prepareManagedUnix && typeof options.signedUnixInput === 'string'
    && path.isAbsolute(options.signedUnixInput))) throw Error('--linux-production-migration-016 requires signed native Linux x86_64 installer assembly.');
  for (const name of ['package.json', 'src-tauri/tauri.conf.json']) {
    if (JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')).version !== '0.1.16') throw Error('Production migration requires actual 016 Root source; old Root cannot be relabelled.');
  }
  if (Object.keys(env).some(key => /^(RUSTFLAGS$|CARGO_ENCODED_RUSTFLAGS$|CARGO_BUILD_RUSTFLAGS$|CARGO_TARGET_.*_RUSTFLAGS$)/.test(key))) {
    throw Error('Production migration refuses inherited compiler overrides.');
  }
}
function admitProductionSource(root, execute = execFileSync, portable = false) {
  for (const [manifest, name, feature, expected] of [
    ['src-tauri/Cargo.toml', 'creator-hub', retirementPackage.PRODUCTION_ROOT_FEATURE, ['experimental-linux-migration']],
    ['native/linux-deb-retirement/Cargo.toml', 'creator-hub-linux-deb-retirement', retirementPackage.PRODUCTION_HELPER_FEATURE, ['dep:signal-hook']],
    ...(portable ? [['native/linux-portable-deployment/Cargo.toml', 'creator-hub-linux-portable-deployment', 'experimental-restart', []]] : []),
  ]) {
    const file = path.join(root, manifest);
    const metadata = JSON.parse(String(execute('cargo', ['metadata', '--locked', '--offline', '--no-deps', '--format-version', '1', '--manifest-path', file],
      { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })));
    const packages = metadata.packages.filter(item => path.resolve(item.manifest_path) === file);
    if (packages.length !== 1 || packages[0].name !== name || (name === 'creator-hub' && packages[0].version !== '0.1.16')
      || JSON.stringify(packages[0].features[feature]?.slice().sort()) !== JSON.stringify(expected.slice().sort())
      || (name !== 'creator-hub' && (packages[0].features.default || []).length !== 0)
      || (packages[0].features.default || []).includes(feature)) throw Error('Exact default-off production Cargo source contract required.');
    if (portable && name === 'creator-hub'
      && JSON.stringify(packages[0].features[PRODUCTION_PORTABLE_FEATURE]?.slice().sort())
        !== JSON.stringify(['experimental-linux-portable-host', 'creator-hub-linux-portable-deployment/experimental-restart'].sort())) {
      throw Error('Production portable source must include the native host and restart implementation.');
    }
  }
}
function validateProductionBuildProof(proof, commit, features) {
  const assert = require('node:assert/strict');
  assert.deepEqual(Object.keys(proof || {}).sort(), ['schemaVersion', 'profile', 'sourceCommit', 'sourceTree', 'compiledFeatures', 'rawHub', 'staging'].sort(),
    'Actual production Root build proof required; old receipts cannot be relabelled');
  assert.equal(proof.schemaVersion, 1); assert.equal(proof.profile, retirementPackage.PRODUCTION_PROFILE);
  assert.match(commit, /^[a-f0-9]{40}$/); assert.equal(proof.sourceCommit, commit); assert.match(proof.sourceTree, /^[a-f0-9]{40}$/);
  const expected = features.some(feature => [PORTABLE_HOST_FEATURE, PRODUCTION_PORTABLE_FEATURE].includes(feature)) ? PRODUCTION_PORTABLE_FEATURES : PRODUCTION_FEATURES;
  assert.deepEqual(features, expected); assert.deepEqual(proof.compiledFeatures, expected);
  retirementPackage.validateProductionReceipt(proof.staging, commit);
  assert.deepEqual(Object.keys(proof.rawHub || {}).sort(), ['sha256', 'size']);
  assert.ok(Number.isSafeInteger(proof.rawHub.size) && proof.rawHub.size >= 64 && proof.rawHub.size <= 256 * 1024 * 1024);
  assert.match(proof.rawHub.sha256, /^[a-f0-9]{64}$/);
  return proof;
}
function productionBuildProof(root, file, featureArgs, env, staged, execute = execFileSync) {
  const assert = require('node:assert/strict');
  const features = featureArgs?.[0] === '--features' && featureArgs.length === 2 ? featureArgs[1].split(',') : [];
  if (JSON.stringify(features) !== JSON.stringify(features.includes(PRODUCTION_PORTABLE_FEATURE) ? PRODUCTION_PORTABLE_FEATURES : PRODUCTION_FEATURES)) {
    throw Error('Production proof requires the exact actual Cargo feature arguments.');
  }
  retirementPackage.validateProductionReceipt(staged.productionReceipt, env.GITHUB_SHA);
  assert.equal(staged.profile, retirementPackage.PRODUCTION_PROFILE);
  assert.deepEqual(staged.files, staged.productionReceipt.files);
  for (const [name, installed] of Object.entries(staged.files)) {
    const source = path.join(path.dirname(staged.overlay), 'linux-retirement', path.posix.basename(name));
    assert.deepEqual(retirementPackage.record(source, installed.mode), installed, 'Production helper/policy changed after staging.');
  }
  const bytes = require('./flatpak-package.cjs').read(file, 256 * 1024 * 1024);
  require('./flatpak-package.cjs').validateElf(bytes);
  admitProductionSource(root, execute, features.includes(PRODUCTION_PORTABLE_FEATURE));
  const git = args => String(execute('git', args, { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })).trim();
  if (git(['rev-parse', 'HEAD']) !== env.GITHUB_SHA) throw Error('Production source changed after admission.');
  git(['diff', '--exit-code', 'HEAD', '--', ...PRODUCTION_SOURCE_PATHS]);
  assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...PRODUCTION_SOURCE_PATHS]), '',
    'Untracked or changed production source after assembly admission.');
  return validateProductionBuildProof({ schemaVersion: 1, profile: retirementPackage.PRODUCTION_PROFILE,
    sourceCommit: env.GITHUB_SHA, sourceTree: git(['rev-parse', 'HEAD^{tree}']), compiledFeatures: features,
    rawHub: { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, staging: staged.productionReceipt }, env.GITHUB_SHA, features);
}
function checkPortableHostOptions(options, platform, arch, root) {
  if (!options.linuxPortableHostCandidate) return;
  if (!(platform === 'linux' && arch === 'x86_64' && (options.linuxIntegratedCandidate || options.linuxProductionMigration) && options.integratedFeatures
    && !options.linuxRetirementCandidate && options.installer && options.managed && options.experimentalUnix
    && options.experimentalWritable && !options.prepareManagedUnix && typeof options.signedUnixInput === 'string'
    && path.isAbsolute(options.signedUnixInput))) {
    throw Error('--linux-portable-host-candidate requires explicit signed integrated Linux x86_64 installer assembly.');
  }
  for (const name of ['package.json', 'src-tauri/tauri.conf.json']) {
    if (JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')).version !== '0.1.16') throw Error('Portable host candidates require new Root source version 0.1.16; old Root cannot be relabelled.');
  }
}
function validatePortableBuildProof(proof, commit, features, rawHub = null, sourceTree = null) {
  const assert = require('node:assert/strict');
  assert.ok(proof && typeof proof === 'object' && !Array.isArray(proof), 'Portable host requires actual Root build proof');
  assert.deepEqual(Object.keys(proof).sort(), ['schemaVersion', 'version', 'target', 'sourceCommit', 'sourceTree', 'compiledFeatures', 'startupImageBinding', 'rawHub'].sort());
  assert.equal(proof.schemaVersion, 1); assert.equal(proof.version, '0.1.16'); assert.equal(proof.target, 'x86_64-unknown-linux-gnu');
  assert.equal(proof.sourceCommit, commit); assert.match(proof.sourceCommit, /^[a-f0-9]{40}$/); assert.match(proof.sourceTree, /^[a-f0-9]{40}$/);
  const expected = features.includes(retirementPackage.PRODUCTION_ROOT_FEATURE) ? PRODUCTION_PORTABLE_FEATURES : PORTABLE_HOST_FEATURES;
  assert.deepEqual(proof.compiledFeatures, expected); assert.deepEqual(features, expected);
  assert.equal(proof.startupImageBinding, 1);
  assert.deepEqual(Object.keys(proof.rawHub || {}).sort(), ['sha256', 'size']);
  assert.ok(Number.isSafeInteger(proof.rawHub.size) && proof.rawHub.size >= 64 && proof.rawHub.size <= 256 * 1024 * 1024);
  assert.match(proof.rawHub.sha256, /^[a-f0-9]{64}$/);
  if (rawHub) assert.deepEqual(proof.rawHub, rawHub, 'Portable build proof does not bind the actual Root bytes');
  if (sourceTree) assert.equal(proof.sourceTree, sourceTree, 'Portable build proof source tree differs');
  return proof;
}
function admitPortableSource(root, execute = execFileSync) {
  const assert = require('node:assert/strict');
  const manifest = path.join(root, 'src-tauri/Cargo.toml');
  const metadata = JSON.parse(String(execute('cargo', ['metadata', '--locked', '--offline', '--no-deps', '--format-version', '1', '--manifest-path', manifest],
    { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })));
  const packages = metadata.packages.filter(item => path.resolve(item.manifest_path) === manifest);
  assert.equal(packages.length, 1, 'Exact Root Cargo package metadata required');
  assert.equal(packages[0].name, 'creator-hub'); assert.equal(packages[0].version, '0.1.16', 'Portable host cannot use old compiled Root version');
  assert.deepEqual(packages[0].features[PORTABLE_HOST_FEATURE]?.slice().sort(),
    ['dep:creator-hub-linux-portable-deployment', 'integrated-features', 'experimental-flatpak-host'].sort(),
    'Root source does not declare the exact native startup-binding feature');
}
function portableBuildProof(root, file, featureArgs, env, execute = execFileSync) {
  const finite = require('./flatpak-package.cjs');
  const expected = featureArgs?.[1]?.split(',').includes(retirementPackage.PRODUCTION_ROOT_FEATURE) ? PRODUCTION_PORTABLE_FEATURES : PORTABLE_HOST_FEATURES;
  if (JSON.stringify(featureArgs) !== JSON.stringify(['--features', expected.join(',')])) throw Error('Portable build proof requires the actual complete Cargo feature arguments.');
  const bytes = finite.read(file, 256 * 1024 * 1024); finite.validateElf(bytes);
  for (const witness of PORTABLE_ROOT_WITNESSES) if (!bytes.includes(Buffer.from(witness))) throw Error('Root is missing its compiled portable startup binding; no profile can be generated.');
  admitPortableSource(root, execute);
  const git = args => String(execute('git', args, { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })).trim();
  if (git(['rev-parse', 'HEAD']) !== env.GITHUB_SHA) throw Error('Portable build source changed after assembly admission.');
  git(['diff', '--exit-code', 'HEAD', '--', ...PORTABLE_SOURCE_PATHS]);
  if (expected.includes(retirementPackage.PRODUCTION_ROOT_FEATURE)) {
    require('node:assert/strict').equal(git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...PORTABLE_SOURCE_PATHS]), '',
      'Untracked or changed production portable source after assembly admission.');
  }
  const proof = { schemaVersion: 1, version: '0.1.16', target: 'x86_64-unknown-linux-gnu', sourceCommit: env.GITHUB_SHA,
    sourceTree: git(['rev-parse', 'HEAD^{tree}']), compiledFeatures: featureArgs[1].split(','), startupImageBinding: 1,
    rawHub: { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } };
  return validatePortableBuildProof(proof, env.GITHUB_SHA, featureArgs[1].split(','));
}
function stageWindowsIntegration(output) {
  fs.writeFileSync(path.join(output, 'direct-features-candidate.json'), JSON.stringify({
    schemaVersion: 1, scope: 'windows-direct-features-candidate',
    internalServices: ['mcp', 'setup'], legacyLaunchersRetainedAsResources: true,
    nativeGuiAccepted: false, migrationAccepted: false, signedUpdateAccepted: false, releaseReady: false,
  }, null, 2), { flag: 'wx' });
}
function candidateProfile({ linuxRetirementCandidate, linuxIntegratedCandidate, integratedFeatures, linuxProductionMigration = false,
  linuxPrivateUpdateFixture = false, linuxPortableHostCandidate = false }) {
  if (typeof linuxPrivateUpdateFixture !== 'boolean') throw Error('Private017 profile selection must be an explicit boolean.');
  if (linuxPrivateUpdateFixture) {
    if (linuxRetirementCandidate || linuxIntegratedCandidate || linuxProductionMigration || linuxPortableHostCandidate || !integratedFeatures) {
      throw Error('Private017 requires --integrated-features and refuses all other Linux profiles.');
    }
    return require('./private-linux-update-fixture-017.cjs').PROFILE;
  }
  if (typeof linuxProductionMigration !== 'boolean') throw Error('Production profile selection must be an explicit boolean.');
  if (linuxProductionMigration) {
    if (linuxRetirementCandidate || linuxIntegratedCandidate || !integratedFeatures) throw Error('Production migration requires --integrated-features and refuses both development profiles.');
    return retirementPackage.PRODUCTION_PROFILE;
  }
  if (linuxIntegratedCandidate && (linuxRetirementCandidate || !integratedFeatures)) {
    throw Error('--linux-integrated-candidate requires --integrated-features and cannot use the old retirement test profile.');
  }
  return linuxIntegratedCandidate ? 'integrated-candidate' : 'retirement-acceptance';
}
function integrationEnvironment(environment, output, enabled, hostPlatform = process.platform) {
  if (!enabled) return environment;
  const variable = 'CREATOR_HUB_INTEGRATED_MCP_PAYLOAD';
  if (Object.hasOwn(environment, variable)) throw Error('Integrated payload inputs must come from the verified assembly, not inherited environment.');
  const payload = path.join(output, 'modules', 'mcp', 'server');
  for (const directory of [output, path.join(output, 'modules'), path.join(output, 'modules', 'mcp'), payload]) {
    if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory
      || !fs.lstatSync(directory).isDirectory()) throw Error('Verified integrated MCP payload directory is redirected or missing.');
  }
  // Dependency build scripts inherit the same Tauri resource map and target
  // directory. Concurrent copies can lock those shared files on Windows.
  return { ...environment, [variable]: payload,
    ...(hostPlatform === 'win32' ? { CARGO_BUILD_JOBS: '1' } : {}) };
}
function stageIntegratedMcpResources(root, output, manifest) {
  if (manifest.platform !== 'linux' || manifest.arch !== 'x86_64') throw Error('Integrated resource staging requires the verified Linux x86_64 payload.');
  const release = path.join(root, 'modules', 'mcp', 'release');
  for (const directory of [release, path.join(release, 'runtime')]) {
    let stat;
    try { stat = fs.lstatSync(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(directory) !== directory)) throw Error('Redirected generated MCP resources refused.');
  }
  fs.mkdirSync(path.join(release, 'runtime'), { recursive: true });
  const files = ['creator-works-mcp.mjs', 'runtime/node', 'runtime/LICENSE', 'runtime/VERSION'];
  for (const name of files) {
    const source = path.join(output, 'modules', 'mcp', 'server', name);
    const expected = manifest.modules.mcp.files[`mcp/server/${name}`];
    if (!/^[a-f0-9]{64}$/.test(expected) || !fs.lstatSync(source).isFile()
      || fs.lstatSync(source).isSymbolicLink() || sha256(source) !== expected) throw Error('Verified MCP resource input changed.');
    // The existing standalone Tauri config references both names. Its native
    // staging script also creates this alias; neither enters Hub's archive map.
    for (const target of [name, ...(name === 'runtime/node' ? ['runtime/node.exe'] : [])]) {
      const destination = path.join(release, target);
      if (!fs.existsSync(destination)) fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      const stat = fs.lstatSync(destination);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || sha256(destination) !== expected) throw Error('Existing generated MCP resource differs; nothing was overwritten.');
      stageFileMode(destination, 'linux', name === 'runtime/node');
    }
    if (sha256(source) !== expected) throw Error('Verified MCP resource changed during staging.');
  }
}
function stageIntegrationService(output, overlay) {
  const activation = require('./flatpak-native-activation.cjs');
  const config = JSON.parse(fs.readFileSync(overlay, 'utf8'));
  const target = `/${activation.SERVICE}`;
  const files = config.bundle?.linux?.deb?.files || {};
  if (Object.hasOwn(files, target)) throw Error('Native activation service already mapped; existing bytes were not overwritten.');
  const service = path.join(output, 'native-activation.service');
  fs.writeFileSync(service, activation.service(), { flag: 'wx', mode: 0o644 });
  config.bundle ??= {}; config.bundle.linux ??= {}; config.bundle.linux.deb ??= {};
  config.bundle.linux.deb.files = { ...files, [target]: service };
  fs.writeFileSync(overlay, JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(output, 'direct-features-candidate.json'), JSON.stringify({
    schemaVersion: 1, scope: 'linux-direct-features-candidate', activationRunsOutsideSandbox: true,
    nativeService: { path: target, sha256: sha256(service) },
    nativeGuiAccepted: false, migrationAccepted: false, signedUpdateAccepted: false,
    flatpakActivationAccepted: false, releaseReady: false,
  }, null, 2), { flag: 'wx', mode: 0o644 });
}
function relativeFile(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_./-]+$/.test(name)
    && !name.startsWith('/') && !name.split('/').some(part => ['', '.', '..'].includes(part));
}
function moduleFiles(id, platform) {
  const extension = platform === 'windows' ? '.exe' : '';
  return id === 'setup' ? [`setup/creator-project-setup${extension}`] : [
    `mcp/creator-works-mcp-launcher${extension}`, 'mcp/server/creator-works-mcp.mjs',
    `mcp/server/runtime/node${extension}`, 'mcp/server/runtime/LICENSE', 'mcp/server/runtime/VERSION',
    'mcp/server/unity-extension/Editor/BanterMCPBridge.cs',
    'mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png',
    'mcp/server/LICENSE', 'mcp/server/THIRD_PARTY_NOTICES.md',
  ];
}
function verifyStage(directory, manifest) {
  if (manifest.schemaVersion !== 1 || !['windows', 'linux', 'macos'].includes(manifest.platform)
    || !['x86_64', 'aarch64'].includes(manifest.arch)
    || Object.keys(manifest.modules || {}).sort().join(',') !== 'mcp,setup') throw Error('Invalid built-in manifest.');
  for (const [id, entry] of Object.entries(manifest.modules)) {
    const expected = moduleFiles(id, manifest.platform);
    if (!entry || entry.executable !== expected[0] || typeof entry.version !== 'string'
      || semver.valid(entry.version) !== entry.version
      || !entry.files || Object.keys(entry.files).sort().join(',') !== expected.sort().join(',')) {
      throw Error(`Invalid or incomplete ${id} module payload.`);
    }
    for (const [name, hash] of Object.entries(entry.files)) {
      if (!relativeFile(name) || !name.startsWith(`${id}/`) || !/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid module file.');
      const file = path.join(directory, name);
      if (fs.lstatSync(file).isSymbolicLink() || sha256(file) !== hash) throw Error(`Bundled module changed: ${name}`);
    }
  }
  if (manifest.managedRouting) {
    const routing = manifest.managedRouting;
    const names = require('./managed-router-package.cjs').routeFiles(manifest.platform);
    if (routing.protocol !== 1 || !routing.files || Object.keys(routing.files).sort().join(',') !== names.sort().join(',')) throw Error('Invalid managed router payload.');
    for (const [name, expected] of Object.entries(routing.files)) {
      const file = path.join(directory, name);
      if (!/^[a-f0-9]{64}$/.test(expected) || fs.lstatSync(file).isSymbolicLink() || sha256(file) !== expected) throw Error(`Managed router package changed: ${name}`);
    }
  }
}
function build(label, { installer = false, managed = false, experimentalUnix = false, experimentalWritable = false,
  prepareManagedUnix = false, signedUnixInput = null, linuxRetirementCandidate = false,
  linuxIntegratedCandidate = false, integratedFeatures = false, linuxPortableHostCandidate = false, linuxProductionMigration = false,
  linuxPrivateUpdateFixture = false } = {}, context = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(label || '')) throw Error('Provide a unique, simple build name.');
  const root = context.root || repositoryRoot;
  const execute = context.execute || execFileSync;
  const environment = context.env || process.env;
  const platform = context.platform || { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
  const arch = context.arch || { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  if (linuxPrivateUpdateFixture !== false) {
    const private017 = require('./private-linux-update-fixture-017.cjs');
    candidateProfile({ linuxRetirementCandidate, linuxIntegratedCandidate, integratedFeatures, linuxProductionMigration,
      linuxPrivateUpdateFixture, linuxPortableHostCandidate });
    private017.checkOptions({ installer, managed, experimentalUnix, experimentalWritable, prepareManagedUnix, signedUnixInput,
      linuxRetirementCandidate, linuxIntegratedCandidate, integratedFeatures, linuxProductionMigration,
      linuxPrivateUpdateFixture, linuxPortableHostCandidate }, platform, arch, root, environment);
    return require('./assemble-unix-payload.cjs').assemble(signedUnixInput, path.join(root, 'artifacts', 'unified', label), platform, arch,
      { ...context, root, env: environment, execute });
  }
  checkProductionOptions({ installer, managed, experimentalUnix, experimentalWritable, prepareManagedUnix, signedUnixInput,
    linuxRetirementCandidate, linuxIntegratedCandidate, integratedFeatures, linuxProductionMigration }, platform, arch, root, environment);
  checkPortableHostOptions({ installer, managed, experimentalUnix, experimentalWritable, prepareManagedUnix, signedUnixInput,
    linuxRetirementCandidate, linuxIntegratedCandidate, integratedFeatures, linuxPortableHostCandidate, linuxProductionMigration }, platform, arch, root);
  candidateProfile({ linuxRetirementCandidate, linuxIntegratedCandidate, integratedFeatures, linuxProductionMigration });
  const retirementCandidate = linuxRetirementCandidate || linuxIntegratedCandidate || linuxProductionMigration;
  const featureArgs = integrationArguments(platform, arch, integratedFeatures, retirementCandidate, linuxPortableHostCandidate, linuxProductionMigration);
  if (integratedFeatures && platform === 'windows' && (!managed || experimentalUnix || experimentalWritable || prepareManagedUnix || signedUnixInput)) {
    throw Error('Direct Windows features require a managed Hub candidate without Unix-only options.');
  }
  if (integratedFeatures && platform !== 'windows' && (!managed || !experimentalUnix || !experimentalWritable || prepareManagedUnix)) {
    throw Error('Direct features require a managed writable Unix Hub candidate, not read-only or payload-only preparation.');
  }
  require('./linux-retirement-package.cjs').checkOptions({ enabled: retirementCandidate, platform, arch,
    installer, managed, experimentalUnix, experimentalWritable, prepareManagedUnix, signedUnixInput });
  const payload = require('./unix-managed-payload.cjs');
  payload.checkSplitOptions({ platform, installer, managed, experimentalUnix, experimentalWritable, prepareManagedUnix, signedUnixInput });
  if (signedUnixInput) return buildSignedUnix(label, { installer, signedUnixInput, linuxRetirementCandidate,
    linuxIntegratedCandidate, integratedFeatures, linuxPortableHostCandidate, linuxProductionMigration }, context);
  const unix = require('./unix-package-payload.cjs');
  const plan = unix.nativePlan(platform, arch, { installer, experimentalUnix, experimentalWritable, managed });
  const nativeTargetArgs = plan.rustTarget ? ['--target', plan.rustTarget] : [];
  const releaseDirectory = target => path.join(target, ...(plan.rustTarget ? [plan.rustTarget] : []), 'release');
  const buildEnv = plan.experimentalUnix ? unix.packageEnvironment(environment, platform, plan.mcpMode) : environment;
  const preparedSource = prepareManagedUnix ? payload.prepareAdmission(root, platform, arch, buildEnv, execute) : null;
  const routing = require('./managed-router-package.cjs');
  const key = prepareManagedUnix ? null : (managed ? routing.signingKey(root) : null);
  const output = path.join(root, 'artifacts', 'unified', label);
  if (prepareManagedUnix) payload.outputAdmission(output, root);
  if (fs.existsSync(output)) throw Error('Build output exists. Use a new name; artifacts are immutable.');
  const npm = environment.npm_execpath;
  if (!npm || !fs.existsSync(npm)) throw Error('Run this builder through npm run build:unified.');
  fs.mkdirSync(output, { recursive: true });
  const run = (args, cwd, env = buildEnv) => execute(process.execPath, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  run([npm, 'run', 'release:launcher'], path.join(root, 'modules/mcp'));
  const mcpSources = plan.experimentalUnix ? unix.hostedSourceHashes(path.join(root, 'modules/mcp')) : null;
  const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
  const extension = platform === 'windows' ? '.exe' : '';
  const manifest = { schemaVersion: 1, platform, arch, modules: {} };
  const resources = {};
  for (const [id, source, binary] of [
    ['mcp', 'modules/mcp/launcher', 'creator-works-mcp-launcher'],
    ['setup', 'modules/project-setup', 'creator-project-setup'],
  ]) {
    const cwd = path.join(root, source);
    const target = path.resolve(environment[`CREATOR_${id.toUpperCase()}_TARGET_DIR`] || path.join(cwd, 'src-tauri/target'));
    const env = { ...buildEnv, CARGO_TARGET_DIR: target, CREATOR_HUB_INTERNAL_MODULE: '1' };
    const moduleFeatures = id === 'mcp' && experimentalWritable ? ['--features', 'experimental-unix-hosting'] : [];
    run([cli, 'build', '--no-bundle', ...moduleFeatures, ...nativeTargetArgs, '--', '--locked'], cwd, env);
    const files = {};
    const copy = (sourceFile, name) => {
      const dest = path.join(output, 'modules', name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(sourceFile, dest, fs.constants.COPYFILE_EXCL);
      stageFileMode(dest, platform, name.endsWith(binary) || name.endsWith('/runtime/node'));
      if (prepareManagedUnix) fs.chmodSync(dest, payload.fileMode(manifest, name, executable));
      // Node is already signed in the pinned archive and its bytes were hashed
      // by MCP's build.rs. Re-sign only Rust backends before manifest binding.
      if (platform === 'macos' && name === `${id}/${binary}`) {
        execute('codesign', ['--force', '--sign', '-', '--options', 'hard,kill', dest], { stdio: 'inherit' });
      }
      files[name] = sha256(dest);
      resources[dest] = `modules/${name}`;
    };
    const executable = `${id}/${binary}${extension}`;
    copy(path.join(releaseDirectory(target), binary + extension), executable);
    if (id === 'mcp') {
      const mcp = path.join(root, 'modules/mcp');
      for (const [sourceFile, name] of [
        ['release/creator-works-mcp.mjs', 'creator-works-mcp.mjs'],
        [`release/runtime/node${extension}`, `runtime/node${extension}`],
        ['release/runtime/LICENSE', 'runtime/LICENSE'], ['release/runtime/VERSION', 'runtime/VERSION'],
        ['unity-extension/Editor/BanterMCPBridge.cs', 'unity-extension/Editor/BanterMCPBridge.cs'],
        ['unity-extension/Editor/CreatorWorksMCPLogo.png', 'unity-extension/Editor/CreatorWorksMCPLogo.png'],
        ['LICENSE', 'LICENSE'], ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
      ]) copy(path.join(mcp, sourceFile), `mcp/server/${name}`);
    }
    const version = JSON.parse(fs.readFileSync(path.join(cwd, 'src-tauri/tauri.conf.json'))).version;
    manifest.modules[id] = { executable, version, files };
  }
  verifyStage(path.join(output, 'modules'), manifest);
  if (plan.experimentalUnix) unix.verifyHostedBinding(manifest, mcpSources, unix.hostedSourceHashes(path.join(root, 'modules/mcp')));
  const { writeRuntimeDescriptor } = require('./mcp-runtime-descriptor.cjs');
  const hubVersion = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'))).version;
  writeRuntimeDescriptor(output, manifest, hubVersion);
  if (managed) {
    const routerTarget = path.resolve(environment.CREATOR_ROUTER_TARGET_DIR || path.join(root, 'native/mcp-router/target'));
    execute('cargo', ['build', '--release', '--locked', ...nativeTargetArgs, '--manifest-path', path.join(root, 'native/mcp-router/Cargo.toml')], {
      env: { ...buildEnv, CARGO_TARGET_DIR: routerTarget }, stdio: 'inherit', windowsHide: true,
    });
    let routerSource = path.join(releaseDirectory(routerTarget), `creator-hub-mcp-router${extension}`);
    if (platform === 'macos') {
      // Ad-hoc sign the disposable copy before the existing managed signer
      // binds its digest. Never alter a signature or signed receipt afterwards.
      const signed = path.join(output, 'router-for-package');
      fs.copyFileSync(routerSource, signed, fs.constants.COPYFILE_EXCL);
      execute('codesign', ['--force', '--sign', '-', signed], { stdio: 'inherit' });
      routerSource = signed;
    }
    if (prepareManagedUnix) {
      payload.finishPreparation(output, manifest, routerSource, hubVersion, preparedSource, root, execute);
      console.log(`Unsigned native managed payload: ${output}. No Hub, installer, signed routing authority or acceptance.`);
      return output;
    }
    manifest.managedRouting = routing.prepare(output, manifest,
      routerSource, path.join(output, 'mcp-runtime.json'),
      file => routing.signDetached(file, key));
    for (const name of routing.routeFiles(platform)) resources[path.join(output, 'modules', name)] = `modules/${name}`;
    verifyStage(path.join(output, 'modules'), manifest);
  }
  let archiveDecoder;
  if (platform === 'linux') {
    const archive = require('./module-archive.cjs');
    const file = path.join(output, archive.FILE);
    const decoderTarget = path.join(output, 'archive-decoder-target');
    execute('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(root, 'native/module-archive/Cargo.toml')], {
      env: { ...buildEnv, CARGO_TARGET_DIR: decoderTarget }, stdio: 'inherit', windowsHide: true,
    });
    archiveDecoder = path.join(decoderTarget, 'release/creator-hub-module-archive');
    manifest.payloadArchive = archive.create(path.join(output, 'modules'), manifest, file);
    archive.verify(file, manifest, archiveDecoder);
    for (const resource of Object.keys(resources)) delete resources[resource];
    resources[file] = archive.FILE;
  }
  const descriptor = path.join(output, 'builtin-manifest.json');
  fs.writeFileSync(descriptor, JSON.stringify(manifest, null, 2));
  const overlay = path.join(output, 'tauri-unified.json');
  fs.writeFileSync(overlay, JSON.stringify({ bundle: { resources } }, null, 2));
  if (integratedFeatures) {
    if (platform === 'windows') stageWindowsIntegration(output);
    else stageIntegrationService(output, overlay);
  }
  const env = { ...integrationEnvironment(buildEnv, output, integratedFeatures), CREATOR_BUILTIN_MANIFEST: descriptor,
    CREATOR_MCP_HOST_WRITABLE: plan.mcpMode === 'writable' ? '1' : '0', CREATOR_MCP_HOST_READONLY_EVENTS: '1',
    CARGO_TARGET_DIR: path.resolve(environment.CARGO_TARGET_DIR || (plan.experimentalUnix ? path.join(output, 'hub-target') : path.join(root, 'src-tauri/target'))) };
  const bundleDirectory = path.join(releaseDirectory(env.CARGO_TARGET_DIR), 'bundle');
  if (plan.experimentalUnix && installer && fs.existsSync(bundleDirectory)) throw Error('Unix packaging requires a fresh bundle directory; select a new CARGO_TARGET_DIR. Existing outputs are not removed.');
  run([cli, 'build', ...featureArgs, ...nativeTargetArgs, ...(installer ? ['--bundles', plan.bundles.join(',')] : ['--no-bundle']), '--config', overlay, '--', '--locked'], root, env);
  fs.copyFileSync(path.join(releaseDirectory(env.CARGO_TARGET_DIR), `creator-hub${extension}`), path.join(output, `creator-hub${extension}`));
  if (installer && platform === 'windows') {
    const bundles = path.join(env.CARGO_TARGET_DIR, 'release/bundle/nsis');
    const matches = fs.readdirSync(bundles).filter(name => name.endsWith(`_${hubVersion}_x64-setup.exe`));
    if (matches.length !== 1) throw Error('Expected exactly one matching unified NSIS candidate.');
    const target = path.join(output, 'installer.exe');
    fs.copyFileSync(path.join(bundles, matches[0]), target, fs.constants.COPYFILE_EXCL);
    const installed = require('./installer-payload.cjs').extract(target, path.join(output, 'installer-extracted'), path.join(output, 'creator-hub.exe'), manifest);
    fs.writeFileSync(path.join(output, 'installer-checksum.json'), JSON.stringify({ version: hubVersion, sha256: sha256(target), installedExecutableSha256: sha256(installed), signed: false, acceptanceOnly: true }));
  }
  if (plan.experimentalUnix) {
    verifyStage(path.join(output, 'modules'), manifest);
    if (installer) unix.validatePackages({ output, bundleDirectory, manifest,
      productName: JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'))).productName,
      rawHub: path.join(output, 'creator-hub'), archiveDecoder, mcpMode: plan.mcpMode });
    fs.writeFileSync(path.join(output, 'experimental-unix.json'), JSON.stringify({ schemaVersion: 1,
      platform, arch, mcpMode: plan.mcpMode, writableGuiAccepted: false, releaseReady: false,
      packages: plan.bundles, managedRoutingIncluded: managed }, null, 2), { flag: 'wx' });
  }
  console.log(`Local unified candidate: ${output}. Not a release or migration acceptance.`);
  return output;
}
function signedAssemblyReceipt(result, platform, arch, commit, featureArgs, portableProof = null, productionProof = null) {
  if (result.version !== '0.1.14' && !(result.version === '0.1.16' && platform === 'linux' && arch === 'x86_64')) {
    throw Error('Signed assembly receipt requires its independently admitted version and platform.');
  }
  let compiledFeatures;
  const portable = featureArgs?.[1]?.split(',').some(feature => [PORTABLE_HOST_FEATURE, PRODUCTION_PORTABLE_FEATURE].includes(feature));
  const production = featureArgs?.[1]?.split(',').includes(retirementPackage.PRODUCTION_ROOT_FEATURE);
  if (production && result.version !== '0.1.16') throw Error('Production migration cannot relabel old Root.');
  if (portable && result.version !== '0.1.16') throw Error('Portable host profile cannot be attached to old Root.');
  if (result.version === '0.1.16') {
    const expected = production ? PRODUCTION_FEATURES : PORTABLE_HOST_FEATURES.slice(0, -1);
    const actual = ['--features', [...expected, ...(portable ? [production ? PRODUCTION_PORTABLE_FEATURE : PORTABLE_HOST_FEATURE] : [])].join(',')];
    if (JSON.stringify(featureArgs) !== JSON.stringify(actual)) throw Error('Linux 0.1.16 receipt requires the actual integrated Cargo feature arguments.');
    compiledFeatures = featureArgs[1].split(',');
  }
  if (portable) validatePortableBuildProof(portableProof, commit, compiledFeatures);
  else if (portableProof) throw Error('Portable build proof requires the actual portable Cargo feature.');
  if (production) validateProductionBuildProof(productionProof, commit, compiledFeatures);
  else if (productionProof) throw Error('Production build proof requires the actual production Cargo feature.');
  if (production && portable && (productionProof.sourceTree !== portableProof.sourceTree
    || productionProof.rawHub.sha256 !== portableProof.rawHub.sha256 || productionProof.rawHub.size !== portableProof.rawHub.size)) {
    throw Error('Production and portable proofs must bind the same actual Root and source tree.');
  }
  return { schemaVersion: 1, product: 'com.creatorworks.hub.unix-signed-assembly', platform, arch,
    hubVersion: result.version, assemblyCommit: commit, privateSource: result.source, handoffSha256: result.handoffSha256,
    ...(compiledFeatures ? { compiledFeatures } : {}),
    ...(portable ? { portableHostBuild: portableProof } : {}),
    ...(production ? { productionMigration: productionProof } : {}),
    mcpMode: 'writable', privateModulesRecompiled: false, privateModulesResigned: false,
    nativeGuiAccepted: false, releaseReady: false };
}
function buildSignedUnix(label, { installer, signedUnixInput, linuxRetirementCandidate = false,
  linuxIntegratedCandidate = false, integratedFeatures = false, linuxPortableHostCandidate = false, linuxProductionMigration = false }, context = {}) {
  const root = context.root || repositoryRoot;
  const execute = context.execute || execFileSync;
  const environment = context.env || process.env;
  const platform = context.platform || { darwin: 'macos', linux: 'linux' }[process.platform];
  const arch = context.arch || { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  const profile = candidateProfile({ linuxRetirementCandidate, linuxIntegratedCandidate, integratedFeatures, linuxProductionMigration });
  const retirementCandidate = linuxRetirementCandidate || linuxIntegratedCandidate || linuxProductionMigration;
  const featureArgs = integrationArguments(platform, arch, integratedFeatures, retirementCandidate, linuxPortableHostCandidate, linuxProductionMigration);
  const output = path.join(root, 'artifacts', 'unified', label);
  if (linuxProductionMigration) admitProductionSource(root, execute, linuxPortableHostCandidate);
  if (linuxPortableHostCandidate) admitPortableSource(root, execute);
  const result = require('./assemble-unix-payload.cjs').assemble(signedUnixInput, output, platform, arch,
    { root, env: environment, execute });
  const manifest = result.manifest;
  const preWrapper = structuredClone(manifest);
  if (integratedFeatures) stageIntegratedMcpResources(root, output, manifest);
  const unix = require('./unix-package-payload.cjs');
  const plan = unix.nativePlan(platform, arch, { installer, managed: true, experimentalUnix: true, experimentalWritable: true });
  const env = { ...integrationEnvironment(unix.packageEnvironment(environment, platform, 'writable'), output, integratedFeatures),
    CREATOR_BUILTIN_MANIFEST: path.join(output, 'builtin-manifest.json'),
    CARGO_TARGET_DIR: path.join(output, 'hub-target') };
  const npm = environment.npm_execpath;
  if (!npm || !fs.existsSync(npm)) throw Error('Run this builder through npm run build:unified. Verified inputs are retained.');
  const resources = Object.fromEntries(Object.keys(result.manifest.modules.mcp.files)
    .concat(Object.keys(result.manifest.modules.setup.files), Object.keys(result.manifest.managedRouting.files))
    .map(name => [path.join(output, 'modules', name), `modules/${name}`]));
  let archiveDecoder;
  if (platform === 'linux') {
    const archive = require('./module-archive.cjs');
    const decoderTarget = path.join(output, 'archive-decoder-target');
    execute('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(root, 'native/module-archive/Cargo.toml')], {
      env: { ...env, CARGO_TARGET_DIR: decoderTarget }, stdio: 'inherit', windowsHide: true,
    });
    archiveDecoder = path.join(decoderTarget, 'release/creator-hub-module-archive');
    const file = path.join(output, archive.FILE);
    manifest.payloadArchive = archive.create(path.join(output, 'modules'), manifest, file);
    archive.verify(file, manifest, archiveDecoder);
    for (const name of Object.keys(resources)) delete resources[name];
    resources[file] = archive.FILE;
  }
  writeAssemblyManifests(output, preWrapper, manifest);
  const retirement = retirementCandidate
    ? require('./linux-retirement-package.cjs').stage(root, output, resources, env, execute, { profile }) : null;
  const overlay = retirement ? retirement.overlay : path.join(output, 'tauri-unified.json');
  if (!retirement) fs.writeFileSync(overlay, JSON.stringify({ bundle: { resources } }, null, 2), { flag: 'wx' });
  if (integratedFeatures) stageIntegrationService(output, overlay);
  const bundles = retirement ? ['deb'] : plan.bundles;
  const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
  execute(process.execPath, [cli, 'build', ...featureArgs, '--target', plan.rustTarget,
    ...(installer ? ['--bundles', bundles.join(',')] : ['--no-bundle']), '--config', overlay, '--', '--locked'],
    { cwd: root, env, stdio: 'inherit', windowsHide: true });
  const release = path.join(env.CARGO_TARGET_DIR, plan.rustTarget, 'release');
  fs.copyFileSync(path.join(release, 'creator-hub'), path.join(output, 'creator-hub'), fs.constants.COPYFILE_EXCL);
  verifyStage(path.join(output, 'modules'), manifest);
  if (installer) {
    const integrity = unix.validatePackages({ output, bundleDirectory: path.join(release, 'bundle'), manifest,
      productName: JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'))).productName,
      rawHub: path.join(output, 'creator-hub'), archiveDecoder, mcpMode: 'writable', linuxRetirementCandidate: retirementCandidate });
    if (retirement) require('./linux-retirement-package.cjs').verifyDeb(root, output, integrity, retirement, execute);
  }
  const portableProof = linuxPortableHostCandidate ? portableBuildProof(root, path.join(output, 'creator-hub'), featureArgs, environment, execute) : null;
  const productionProof = linuxProductionMigration ? productionBuildProof(root, path.join(output, 'creator-hub'), featureArgs, environment, retirement, execute) : null;
  fs.writeFileSync(path.join(output, 'signed-unix-assembly.json'), JSON.stringify(
    signedAssemblyReceipt(result, platform, arch, environment.GITHUB_SHA, featureArgs, portableProof, productionProof), null, 2), { flag: 'wx' });
  console.log(`Signed native Unix candidate: ${output}. Not migration or release acceptance.`);
  return output;
}
function writeAssemblyManifests(output, signedManifest, finalManifest) {
  const original = path.join(output, 'builtin-manifest.json');
  fs.copyFileSync(original, path.join(output, 'builtin-manifest.preparation.json'), fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(path.join(output, 'builtin-manifest.pre-wrapper.json'), JSON.stringify(signedManifest, null, 2), { flag: 'wx' });
  fs.writeFileSync(original, JSON.stringify(finalManifest, null, 2));
}
function parseBuildOptions(args) {
  const options = {};
  const usage = 'Provide one build name and optional --installer, --managed, --experimental-unix and --experimental-unix-writable; preparation also requires --prepare-managed-unix. --integrated-features is Windows/Linux candidate-only; --linux-integrated-candidate, --linux-production-migration-016, --linux-portable-host-candidate and --linux-private-update-fixture-017 are Linux-only.';
  const flags = { '--installer': 'installer', '--managed': 'managed', '--experimental-unix': 'experimentalUnix',
    '--experimental-unix-writable': 'experimentalWritable', '--prepare-managed-unix': 'prepareManagedUnix',
    '--linux-retirement-test-candidate': 'linuxRetirementCandidate', '--integrated-features': 'integratedFeatures',
    '--linux-integrated-candidate': 'linuxIntegratedCandidate', '--linux-portable-host-candidate': 'linuxPortableHostCandidate',
    '--linux-production-migration-016': 'linuxProductionMigration', '--linux-private-update-fixture-017': 'linuxPrivateUpdateFixture' };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw Error(`Duplicate build option. ${usage}`);
    seen.add(flag);
    if (flag === '--signed-unix-input') {
      const value = args[++index];
      if (!value || !path.isAbsolute(value)) throw Error('--signed-unix-input requires an absolute staging path.');
      options.signedUnixInput = value;
    } else if (flags[flag]) options[flags[flag]] = true;
    else throw Error(`Unknown build option. ${usage}`);
  }
  return options;
}
module.exports = { relativeFile, moduleFiles, verifyStage, stageFileMode, integrationArguments, integrationEnvironment, stageIntegratedMcpResources, candidateProfile, stageIntegrationService, stageWindowsIntegration, build, parseBuildOptions, writeAssemblyManifests, signedAssemblyReceipt, checkPortableHostOptions, validatePortableBuildProof, portableBuildProof, admitPortableSource, PORTABLE_HOST_FEATURES, PORTABLE_ROOT_WITNESSES, PORTABLE_SOURCE_PATHS,
  checkProductionOptions, admitProductionSource, validateProductionBuildProof, productionBuildProof,
  PRODUCTION_FEATURES, PRODUCTION_PORTABLE_FEATURE, PRODUCTION_PORTABLE_FEATURES, PRODUCTION_SOURCE_PATHS };
if (require.main === module) {
  try {
    if (!process.argv[2]) throw Error('Provide one build name.');
    build(process.argv[2], parseBuildOptions(process.argv.slice(3)));
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
