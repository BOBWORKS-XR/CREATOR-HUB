const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const semver = require('semver');

const repositoryRoot = path.resolve(__dirname, '..');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function stageFileMode(file, platform, executable, chmod = fs.chmodSync) {
  // The shebang server runs through private Node; archive data is not executable.
  if (platform === 'linux') chmod(file, executable ? 0o755 : 0o644);
  else if (platform === 'macos' && executable) chmod(file, 0o755);
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
  prepareManagedUnix = false, signedUnixInput = null } = {}, context = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(label || '')) throw Error('Provide a unique, simple build name.');
  const root = context.root || repositoryRoot;
  const execute = context.execute || execFileSync;
  const environment = context.env || process.env;
  const platform = context.platform || { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
  const arch = context.arch || { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  const payload = require('./unix-managed-payload.cjs');
  payload.checkSplitOptions({ platform, installer, managed, experimentalUnix, experimentalWritable, prepareManagedUnix, signedUnixInput });
  if (signedUnixInput) return buildSignedUnix(label, { installer, signedUnixInput }, context);
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
  const env = { ...buildEnv, CREATOR_BUILTIN_MANIFEST: descriptor,
    CREATOR_MCP_HOST_WRITABLE: plan.mcpMode === 'writable' ? '1' : '0', CREATOR_MCP_HOST_READONLY_EVENTS: '1',
    CARGO_TARGET_DIR: path.resolve(environment.CARGO_TARGET_DIR || (plan.experimentalUnix ? path.join(output, 'hub-target') : path.join(root, 'src-tauri/target'))) };
  const bundleDirectory = path.join(releaseDirectory(env.CARGO_TARGET_DIR), 'bundle');
  if (plan.experimentalUnix && installer && fs.existsSync(bundleDirectory)) throw Error('Unix packaging requires a fresh bundle directory; select a new CARGO_TARGET_DIR. Existing outputs are not removed.');
  run([cli, 'build', ...nativeTargetArgs, ...(installer ? ['--bundles', plan.bundles.join(',')] : ['--no-bundle']), '--config', overlay, '--', '--locked'], root, env);
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
function buildSignedUnix(label, { installer, signedUnixInput }, context = {}) {
  const root = context.root || repositoryRoot;
  const execute = context.execute || execFileSync;
  const environment = context.env || process.env;
  const platform = context.platform || { darwin: 'macos', linux: 'linux' }[process.platform];
  const arch = context.arch || { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  const output = path.join(root, 'artifacts', 'unified', label);
  const result = require('./assemble-unix-payload.cjs').assemble(signedUnixInput, output, platform, arch,
    { root, env: environment, execute });
  const manifest = result.manifest;
  const preWrapper = structuredClone(manifest);
  const unix = require('./unix-package-payload.cjs');
  const plan = unix.nativePlan(platform, arch, { installer, managed: true, experimentalUnix: true, experimentalWritable: true });
  const env = { ...unix.packageEnvironment(environment, platform, 'writable'),
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
  const overlay = path.join(output, 'tauri-unified.json');
  fs.writeFileSync(overlay, JSON.stringify({ bundle: { resources } }, null, 2), { flag: 'wx' });
  const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
  execute(process.execPath, [cli, 'build', '--target', plan.rustTarget,
    ...(installer ? ['--bundles', plan.bundles.join(',')] : ['--no-bundle']), '--config', overlay, '--', '--locked'],
    { cwd: root, env, stdio: 'inherit', windowsHide: true });
  const release = path.join(env.CARGO_TARGET_DIR, plan.rustTarget, 'release');
  fs.copyFileSync(path.join(release, 'creator-hub'), path.join(output, 'creator-hub'), fs.constants.COPYFILE_EXCL);
  verifyStage(path.join(output, 'modules'), manifest);
  if (installer) unix.validatePackages({ output, bundleDirectory: path.join(release, 'bundle'), manifest,
    productName: JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'))).productName,
    rawHub: path.join(output, 'creator-hub'), archiveDecoder, mcpMode: 'writable' });
  fs.writeFileSync(path.join(output, 'signed-unix-assembly.json'), JSON.stringify({ schemaVersion: 1,
    product: 'com.creatorworks.hub.unix-signed-assembly', platform, arch, hubVersion: '0.1.14',
    assemblyCommit: environment.GITHUB_SHA, privateSource: result.source, handoffSha256: result.handoffSha256,
    mcpMode: 'writable', privateModulesRecompiled: false, privateModulesResigned: false,
    nativeGuiAccepted: false, releaseReady: false }, null, 2), { flag: 'wx' });
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
  const usage = 'Provide one build name and optional --installer, --managed, --experimental-unix and --experimental-unix-writable; preparation also requires --prepare-managed-unix.';
  const flags = { '--installer': 'installer', '--managed': 'managed', '--experimental-unix': 'experimentalUnix',
    '--experimental-unix-writable': 'experimentalWritable', '--prepare-managed-unix': 'prepareManagedUnix' };
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
module.exports = { relativeFile, moduleFiles, verifyStage, stageFileMode, build, parseBuildOptions, writeAssemblyManifests };
if (require.main === module) {
  try {
    if (!process.argv[2]) throw Error('Provide one build name.');
    build(process.argv[2], parseBuildOptions(process.argv.slice(3)));
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
