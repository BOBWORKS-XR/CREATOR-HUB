const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const semver = require('semver');

const root = path.resolve(__dirname, '..');
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
function build(label, { installer = false, managed = false, experimentalUnix = false } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(label || '')) throw Error('Provide a unique, simple build name.');
  const platform = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  const unix = require('./unix-package-payload.cjs');
  const plan = unix.nativePlan(platform, arch, { installer, experimentalUnix });
  const nativeTargetArgs = plan.rustTarget ? ['--target', plan.rustTarget] : [];
  const releaseDirectory = target => path.join(target, ...(plan.rustTarget ? [plan.rustTarget] : []), 'release');
  const buildEnv = plan.experimentalUnix ? unix.packageEnvironment(process.env, platform) : process.env;
  const routing = require('./managed-router-package.cjs');
  const key = managed ? routing.signingKey(root) : null;
  const output = path.join(root, 'artifacts', 'unified', label);
  if (fs.existsSync(output)) throw Error('Build output exists. Use a new name; artifacts are immutable.');
  const npm = process.env.npm_execpath;
  if (!npm || !fs.existsSync(npm)) throw Error('Run this builder through npm run build:unified.');
  fs.mkdirSync(output, { recursive: true });
  const run = (args, cwd, env = buildEnv) => execFileSync(process.execPath, args, { cwd, env, stdio: 'inherit', windowsHide: true });
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
    const target = path.resolve(process.env[`CREATOR_${id.toUpperCase()}_TARGET_DIR`] || path.join(cwd, 'src-tauri/target'));
    const env = { ...buildEnv, CARGO_TARGET_DIR: target, CREATOR_HUB_INTERNAL_MODULE: '1' };
    run([cli, 'build', '--no-bundle', ...nativeTargetArgs, '--', '--locked'], cwd, env);
    const files = {};
    const copy = (sourceFile, name) => {
      const dest = path.join(output, 'modules', name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(sourceFile, dest, fs.constants.COPYFILE_EXCL);
      stageFileMode(dest, platform, name.endsWith(binary) || name.endsWith('/runtime/node'));
      // Node is already signed in the pinned archive and its bytes were hashed
      // by MCP's build.rs. Re-sign only Rust backends before manifest binding.
      if (platform === 'macos' && name === `${id}/${binary}`) {
        execFileSync('codesign', ['--force', '--sign', '-', dest], { stdio: 'inherit' });
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
    const routerTarget = path.resolve(process.env.CREATOR_ROUTER_TARGET_DIR || path.join(root, 'native/mcp-router/target'));
    execFileSync('cargo', ['build', '--release', '--locked', ...nativeTargetArgs, '--manifest-path', path.join(root, 'native/mcp-router/Cargo.toml')], {
      env: { ...buildEnv, CARGO_TARGET_DIR: routerTarget }, stdio: 'inherit', windowsHide: true,
    });
    let routerSource = path.join(releaseDirectory(routerTarget), `creator-hub-mcp-router${extension}`);
    if (platform === 'macos') {
      // Ad-hoc sign the disposable copy before the existing managed signer
      // binds its digest. Never alter a signature or signed receipt afterwards.
      const signed = path.join(output, 'router-for-package');
      fs.copyFileSync(routerSource, signed, fs.constants.COPYFILE_EXCL);
      execFileSync('codesign', ['--force', '--sign', '-', signed], { stdio: 'inherit' });
      routerSource = signed;
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
    execFileSync('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(root, 'native/module-archive/Cargo.toml')], {
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
    CREATOR_MCP_HOST_WRITABLE: platform === 'windows' ? '1' : '0', CREATOR_MCP_HOST_READONLY_EVENTS: '1',
    CARGO_TARGET_DIR: path.resolve(process.env.CARGO_TARGET_DIR || (plan.experimentalUnix ? path.join(output, 'hub-target') : path.join(root, 'src-tauri/target'))) };
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
      rawHub: path.join(output, 'creator-hub'), archiveDecoder });
    fs.writeFileSync(path.join(output, 'experimental-unix.json'), JSON.stringify({ schemaVersion: 1,
      platform, arch, mcpMode: 'read-only', writableGuiAccepted: false, releaseReady: false,
      packages: plan.bundles, managedRoutingIncluded: managed }, null, 2), { flag: 'wx' });
  }
  console.log(`Local unified candidate: ${output}. Not a release or migration acceptance.`);
  return output;
}
module.exports = { relativeFile, moduleFiles, verifyStage, stageFileMode, build };
if (require.main === module) {
  try {
    const flags = process.argv.slice(3);
    if (!process.argv[2] || flags.some(flag => !['--installer', '--managed', '--experimental-unix'].includes(flag)) || new Set(flags).size !== flags.length) throw Error('Provide one build name and optional --installer, --managed and --experimental-unix.');
    build(process.argv[2], { installer: flags.includes('--installer'), managed: flags.includes('--managed'), experimentalUnix: flags.includes('--experimental-unix') });
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
