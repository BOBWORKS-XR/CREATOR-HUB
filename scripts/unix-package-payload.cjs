// Experimental, locally built packages only. Extraction never installs a package.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const hostedSources = {
  'mcp/server/creator-works-mcp.mjs': 'release/creator-works-mcp.mjs',
  'mcp/server/runtime/node': 'release/runtime/node',
  'mcp/server/unity-extension/Editor/BanterMCPBridge.cs': 'unity-extension/Editor/BanterMCPBridge.cs',
  'mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png': 'unity-extension/Editor/CreatorWorksMCPLogo.png',
};

function nativePlan(platform, arch, { experimentalUnix = false, installer = false } = {}) {
  if (!['windows', 'linux', 'macos'].includes(platform) || !['x86_64', 'aarch64'].includes(arch)
    || (platform === 'windows' && arch !== 'x86_64')) throw Error('Unsupported native build host.');
  if (platform !== 'windows' && experimentalUnix !== true) {
    throw Error('Unix unified packaging refuses by default. Use --experimental-unix for a read-only, unaccepted CI candidate.');
  }
  if (platform === 'windows' && experimentalUnix) throw Error('--experimental-unix is Unix-only.');
  return { experimentalUnix: platform !== 'windows', mcpMode: platform === 'windows' ? 'writable' : 'read-only',
    rustTarget: platform === 'windows' ? null : `${arch}-${platform === 'macos' ? 'apple-darwin' : 'unknown-linux-gnu'}`,
    bundles: installer ? { windows: ['nsis'], linux: ['appimage', 'deb', 'rpm'], macos: ['app', 'dmg'] }[platform] : [] };
}

function packageEnvironment(env, platform) {
  // Tauri auto-imports Apple credentials / auto-signs RPMs when these exist.
  // CI packaging must not accidentally consult accounts or private keys.
  if (Object.keys(env).some(name => name.startsWith('APPLE_') || name.startsWith('TAURI_SIGNING_'))) {
    throw Error('Experimental Unix packaging requires an environment without Apple/Tauri automatic signing credentials. --managed uses its existing explicit signer separately.');
  }
  return { ...env, CREATOR_MCP_HOST_WRITABLE: '0', CREATOR_MCP_HOST_READONLY_EVENTS: '1',
    ...(platform === 'linux' ? { NO_STRIP: '1' } : {}) };
}

function hostedSourceHashes(root) {
  return Object.fromEntries(Object.entries(hostedSources).map(([name, source]) => [name, hash(path.join(root, source))]));
}

function verifyHostedBinding(manifest, compiledSources, currentSources) {
  if (!compiledSources || Object.keys(compiledSources).sort().join(',') !== Object.keys(hostedSources).sort().join(',')
    || Object.values(compiledSources).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) throw Error('Missing or invalid MCP build-bound source snapshot.');
  for (const [name, expected] of Object.entries(compiledSources)) {
    if (manifest.modules.mcp.files[name] !== expected || currentSources[name] !== expected) {
      throw Error(`MCP build-bound bytes changed after backend compilation: ${name}. Do not re-hash or re-sign the manifest to hide the mismatch.`);
    }
  }
}

function regular(file, executable = false) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error(`Package file is not a regular file: ${file}`);
  if (executable && process.platform !== 'win32' && !(stat.mode & 0o111)) throw Error(`Package executable lost its execute mode: ${file}`);
  return stat;
}

function verifyAncestors(file, root) {
  for (let part = file; part !== root; part = path.dirname(part)) {
    if (!part.startsWith(`${root}${path.sep}`)) throw Error('Package layout escaped the extraction directory.');
    if (fs.lstatSync(part).isSymbolicLink()) throw Error('Package ancestor is redirected.');
  }
}

function verifyLinuxHub(raw, installed, format) {
  const token = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
  const offset = raw.indexOf(token);
  if (offset < 0 || raw.indexOf(token, offset + 1) !== -1) throw Error('Expected one Tauri Linux bundle marker.');
  const type = { deb: 'DEB', rpm: 'RPM', appimage: 'APP' }[format];
  if (!type) throw Error('Unsupported Linux bundle marker.');
  const expected = Buffer.from(raw);
  expected.write(type, offset + token.length - 3, 'ascii');
  if (!expected.equals(installed)) throw Error('Linux packaged Hub differs beyond the exact Tauri bundle marker.');
}

function verifyProductName(name) {
  if (typeof name !== 'string' || !name || name.trim() !== name || /[\\/:\x00-\x1f]/.test(name) || ['.', '..'].includes(name)) throw Error('Invalid native product name.');
}

function verifyResources(directory, manifest) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Package module root must be a real directory.');
  const files = { ...manifest.modules?.mcp?.files, ...manifest.modules?.setup?.files, ...manifest.managedRouting?.files };
  const seen = [];
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error(`Package payload uses a redirected path: ${name}`);
      if (entry.isDirectory()) walk(file, `${name}/`);
      else {
        regular(file);
        if (!Object.hasOwn(files, name)) throw Error(`Unlisted package module file: ${name}`);
        seen.push(name);
      }
    }
  }
  walk(directory);
  if (seen.sort().join('\n') !== Object.keys(files).sort().join('\n')) throw Error('Package module payload is incomplete.');
  require('./build-unified.cjs').verifyStage(directory, manifest);
  for (const name of [manifest.modules.mcp.executable, manifest.modules.setup.executable,
    'mcp/server/runtime/node', ...(manifest.managedRouting ? ['routing/creator-hub-mcp-router'] : [])]) {
    regular(path.join(directory, name), true);
  }
  return Object.fromEntries(seen.map(name => [name, hash(path.join(directory, name))]));
}

function verifyLayout(directory, format, manifest, productName, rawHub, appHub) {
  let resources;
  let executable;
  if (format === 'app' || format === 'dmg') {
    const app = format === 'app' ? directory : path.join(directory, `${productName}.app`);
    if (fs.lstatSync(app).isSymbolicLink()) throw Error('Package application is redirected.');
    resources = path.join(app, 'Contents/Resources/modules');
    executable = path.join(app, 'Contents/MacOS/creator-hub');
  } else {
    const tree = format === 'appimage' ? path.join(directory, 'squashfs-root') : directory;
    resources = path.join(tree, 'usr/lib', productName, 'modules');
    executable = path.join(tree, 'usr/bin/creator-hub');
  }
  // Ancestor redirection must not turn the expected module root into an alias.
  verifyAncestors(resources, directory);
  verifyAncestors(executable, directory);
  const files = verifyResources(resources, manifest);
  regular(executable, true);
  const bytes = fs.readFileSync(executable);
  if (format === 'dmg') {
    if (!bytes.equals(fs.readFileSync(appHub))) throw Error('DMG Hub image differs from the verified app bundle.');
  } else if (manifest.platform === 'linux') {
    // Pinned Tauri bundle.rs documents this single marker patch and restores
    // the raw image between formats. No other binary difference is allowed.
    verifyLinuxHub(fs.readFileSync(rawHub), bytes, format);
  }
  // Rust includes the exact descriptor bytes in Hub at build time. Signing the
  // outer Mac app may alter its main image but cannot authorize another manifest.
  const descriptor = fs.readFileSync(path.join(path.dirname(rawHub), 'builtin-manifest.json'));
  if (!bytes.includes(descriptor)) throw Error('Packaged Hub does not contain this exact build-bound manifest.');
  return { files, hubSha256: hash(executable), executable };
}

function extract(file, format, output, productName, execute = execFileSync) {
  if (!['deb', 'rpm', 'appimage', 'dmg'].includes(format)) throw Error('Unsupported native package extraction.');
  verifyProductName(productName);
  regular(file);
  if (fs.existsSync(output)) throw Error('Package extraction requires a new directory.');
  fs.mkdirSync(output, { recursive: true });
  const options = { cwd: output, timeout: 180000, stdio: 'pipe', maxBuffer: 512 * 1024 * 1024 };
  if (format === 'deb') execute('dpkg-deb', ['--extract', file, output], options);
  else if (format === 'rpm') {
    const archive = execute('rpm2cpio', [file], options);
    execute('bsdtar', ['-xf', '-', '-C', output], { ...options, input: archive });
  } else if (format === 'appimage') {
    // Executes only the extraction mode of this just-built, retained runtime;
    // never launches the application or requires FUSE/mount installation.
    execute(file, ['--appimage-extract'], options);
  } else if (format === 'dmg') {
    const mount = path.join(output, 'mounted');
    fs.mkdirSync(mount);
    let failure;
    try {
      execute('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, file], options);
      const app = path.join(mount, `${productName}.app`);
      if (!fs.lstatSync(app).isDirectory() || fs.lstatSync(app).isSymbolicLink()) throw Error('DMG application is missing or redirected.');
      fs.cpSync(app, path.join(output, `${productName}.app`), { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // The unique mount point belongs to this attempt. An attach failure may
      // still have mounted it, so attempt cleanup even on partial failure.
      try { execute('hdiutil', ['detach', mount], options); }
      catch (error) { throw new AggregateError([...(failure ? [failure] : []), error], 'DMG copy/attach or owned mount cleanup failed.'); }
    }
  } else throw Error('Unsupported native package extraction.');
}

function one(directory, extension) {
  const files = fs.readdirSync(directory).filter(name => name.endsWith(extension));
  if (files.length !== 1) throw Error(`Expected exactly one fresh ${extension} candidate in ${directory}.`);
  const file = path.join(directory, files[0]);
  regular(file);
  return file;
}

function validatePackages({ output, bundleDirectory, manifest, productName, rawHub, execute = execFileSync }) {
  if (!['linux', 'macos'].includes(manifest.platform)) throw Error('Unix package validation requires a Unix manifest.');
  verifyProductName(productName);
  const destination = path.join(output, 'native-packages');
  fs.mkdirSync(destination); // A repeated validation cannot replace retained bytes.
  const report = { schemaVersion: 1, platform: manifest.platform, arch: manifest.arch,
    experimental: true, mcpMode: 'read-only', writableGuiAccepted: false, releaseReady: false, packages: [] };
  const reportFile = path.join(output, 'unix-package-integrity.json');
  let appHub;
  try {
    const formats = manifest.platform === 'macos' ? ['app', 'dmg'] : ['deb', 'rpm', 'appimage'];
    for (const format of formats) {
      let retained;
      let extracted;
      if (format === 'app') {
        const source = path.join(bundleDirectory, 'macos', `${productName}.app`);
        if (!fs.lstatSync(source).isDirectory() || fs.lstatSync(source).isSymbolicLink()) throw Error('Missing native app bundle.');
        retained = path.join(destination, `${productName}.app`);
        fs.cpSync(source, retained, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
        extracted = retained;
      } else {
        const source = one(path.join(bundleDirectory, format === 'appimage' ? 'appimage' : format),
          { deb: '.deb', rpm: '.rpm', appimage: '.AppImage', dmg: '.dmg' }[format]);
        retained = path.join(destination, path.basename(source));
        fs.copyFileSync(source, retained, fs.constants.COPYFILE_EXCL);
        if (format === 'appimage') fs.chmodSync(retained, 0o755);
        if (hash(retained) !== hash(source)) throw Error('Package bytes changed during retention.');
        extracted = path.join(output, `package-extracted-${format}`);
        extract(retained, format, extracted, productName, execute);
      }
      const result = verifyLayout(extracted, format, manifest, productName, rawHub, appHub);
      if (manifest.platform === 'macos') {
        const app = format === 'app' ? retained : path.join(extracted, `${productName}.app`);
        execute('codesign', ['--verify', '--deep', '--strict', app], { timeout: 30000, stdio: 'pipe' });
      }
      if (format === 'app') appHub = result.executable;
      report.packages.push({ format, path: path.relative(output, retained).split(path.sep).join('/'),
        ...(format === 'app' ? {} : { sha256: hash(retained) }), hubSha256: result.hubSha256, files: result.files });
    }
    report.integrityPassed = true;
    return report;
  } catch (error) {
    report.integrityPassed = false;
    report.error = error.message;
    throw error;
  } finally {
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), { flag: 'wx' });
  }
}

module.exports = { nativePlan, packageEnvironment, hostedSourceHashes, verifyHostedBinding, verifyLinuxHub,
  verifyResources, verifyLayout, extract, validatePackages };
