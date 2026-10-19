// Native build input only. A signed handoff is not migration or release acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { validateBinding } = require('./unix-payload-binding.cjs');
const { routeFiles } = require('./managed-router-package.cjs');
const { runtimeDescriptor } = require('./mcp-runtime-descriptor.cjs');

const WORKFLOW = '.github/workflows/unix-managed-assembly.yml';
const REPOSITORY = 'BOBWORKS-XR/CREATOR-HUB';
const TRANSFER = ['modules.tar.gz', 'prepared-unix.json', 'transfer-binding.json'];
const ROUTING = ['routing/router.json', 'routing/router.minisig', 'routing/runtime.json', 'routing/runtime.minisig'];
const INPUTS = [...TRANSFER, ...ROUTING, 'handoff.json', 'handoff.minisig'];
const META = 128 * 1024;
const PRIVATE_SOURCE_PATHS = ['modules/mcp', 'modules/project-setup', 'native/mcp-router',
  'native/host_parent_macos.rs', 'native/plugins_retirement.rs', 'native/convergence-server-unix.rs',
  'src-tauri/src/module_archive.rs', 'src-tauri/src/catalog-key.pub'];

function keys(value, expected) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'An object is required');
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'Unexpected handoff fields');
}
function absolute(file) {
  assert.ok(typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file, 'Canonical absolute paths required');
  for (let part = file;; part = path.dirname(part)) {
    try { assert.equal(fs.lstatSync(part).isSymbolicLink(), false, 'Redirected ancestor refused'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(part) === part) break;
  }
}
function inside(file, root) {
  absolute(file); absolute(root);
  const relative = path.relative(root, file);
  assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`), 'Owned staging path required');
}
function admission(root, platform, arch, env, execute = execFileSync) {
  const os = { linux: 'Linux', macos: 'macOS' }[platform];
  const cpu = { x86_64: 'X64', aarch64: 'ARM64' }[arch];
  const validationPush = env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/validation/unix-assembly-014';
  assert.ok(os && cpu && env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
    && env.RUNNER_OS === os && env.RUNNER_ARCH === cpu && env.GITHUB_REPOSITORY === REPOSITORY
    && env.GITHUB_REPOSITORY_ID === '1364807512'
    && (env.GITHUB_EVENT_NAME === 'workflow_dispatch' || validationPush)
    && env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/${WORKFLOW}@${env.GITHUB_REF}`, 'Explicit native assembly workflow required');
  assert.ok(!Object.keys(env).some(n => /^(APPLE_|TAURI_SIGNING_|CREATOR_HUB_SIGNING_|DYLD_|LD_PRELOAD$|NODE_OPTIONS$)/.test(n)), 'Assembly refuses signing credentials and runtime injection');
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  assert.match(env.CREATOR_UNIX_HANDOFF_SHA256 || '', /^[a-f0-9]{64}$/);
  absolute(root);
  const git = args => String(execute('git', args, { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })).trim();
  assert.equal(git(['rev-parse', '--show-toplevel']), root);
  assert.equal(git(['rev-parse', 'HEAD']), env.GITHUB_SHA);
  assert.equal(git(['status', '--porcelain=v1', '--untracked-files=normal']), '', 'Clean initial assembly source required');
  const version = env.GITHUB_REF === 'refs/heads/validation/linux-integrated-candidate-016' ? '0.1.16' : '0.1.14';
  if (version === '0.1.16') {
    const flags = ['CREATOR_LINUX_INTEGRATED_CANDIDATE', 'CREATOR_LINUX_PRODUCTION_MIGRATION_016',
      'CREATOR_LINUX_RETIREMENT_TEST_CANDIDATE'].map(name => env[name] ?? '0');
    assert.ok(flags.every(value => value === '0' || value === '1'), 'Explicit finite Linux profile flags required');
    assert.ok(platform === 'linux' && arch === 'x86_64' && flags[0] !== flags[1] && flags[2] === '0',
      '0.1.16 assembly requires exactly one direct Linux x86_64 profile, not a retirement test');
    for (const name of ['package.json', 'src-tauri/tauri.conf.json']) {
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')).version, version, '0.1.16 assembly source identity differs');
    }
  }
  return { commit: env.GITHUB_SHA, handoffSha256: env.CREATOR_UNIX_HANDOFF_SHA256, version };
}
function inventory(root, names) {
  const found = [];
  const allowedDirs = new Set(names.flatMap(name => {
    const result = [];
    for (let dir = path.posix.dirname(name); dir !== '.'; dir = path.posix.dirname(dir)) result.push(dir);
    return result;
  }));
  function walk(directory, prefix = '') {
    absolute(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      assert.equal(entry.isSymbolicLink(), false, 'Redirected handoff refused');
      if (entry.isDirectory()) { assert.ok(allowedDirs.has(name), 'Unlisted handoff directory'); walk(path.join(directory, entry.name), `${name}/`); }
      else { assert.ok(entry.isFile() && names.includes(name), 'Unlisted handoff input'); found.push(name); }
    }
  }
  walk(root); assert.deepEqual(found.sort(), [...names].sort(), 'Incomplete handoff');
}
function validateHandoff(h, prepared, records, platform, arch, expectedVersion = '0.1.14') {
  keys(h, 'schemaVersion product hubVersion platform arch rustTarget mcpMode compiledFlags source apiProof transferFiles routingMetadata builtinManifest payloadFiles privateKeyIncluded nativeGuiAccepted releaseReady'.split(' '));
  assert.equal(h.schemaVersion, 1); assert.equal(h.product, 'com.creatorworks.hub.unix-signed-handoff');
  assert.ok(expectedVersion === '0.1.14' || expectedVersion === '0.1.16' && platform === 'linux' && arch === 'x86_64', 'Finite native assembly version required');
  assert.equal(h.hubVersion, expectedVersion); assert.equal(h.platform, platform); assert.equal(h.arch, arch);
  assert.equal(h.privateKeyIncluded, false); assert.equal(h.nativeGuiAccepted, false); assert.equal(h.releaseReady, false);
  const binding = validateBinding({ ...h.apiProof, prepared });
  assert.equal(binding.platform, platform); assert.equal(binding.arch, arch);
  for (const name of ['hubVersion', 'platform', 'arch', 'rustTarget', 'mcpMode', 'compiledFlags', 'source']) assert.deepEqual(h[name], prepared[name]);
  keys(h.transferFiles, TRANSFER); keys(h.routingMetadata, ROUTING);
  for (const name of TRANSFER) assert.deepEqual(h.transferFiles[name], records[name], 'Original carrier differs from signed handoff');
  for (const name of ROUTING) {
    keys(h.routingMetadata[name], ['sha256', 'size', 'mode']);
    assert.equal(h.routingMetadata[name].mode, 0o644);
    assert.deepEqual({ sha256: h.routingMetadata[name].sha256, size: h.routingMetadata[name].size }, records[name], 'Signed routing input differs');
  }
  const manifest = h.builtinManifest;
  keys(manifest, ['schemaVersion', 'platform', 'arch', 'modules', 'managedRouting']);
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.platform, platform); assert.equal(manifest.arch, arch);
  keys(manifest.modules, ['mcp', 'setup']);
  const files = {};
  for (const entry of Object.values(manifest.modules)) {
    keys(entry, ['executable', 'version', 'files']);
    for (const name of Object.keys(entry.files)) {
      files[name] = prepared.files[`modules/${name}`];
      assert.ok(files[name] && files[name].sha256 === entry.files[name], 'Module differs from native preparation');
    }
  }
  keys(manifest.managedRouting, ['protocol', 'files']); assert.equal(manifest.managedRouting.protocol, 1);
  keys(manifest.managedRouting.files, routeFiles(platform));
  files[routeFiles(platform)[0]] = prepared.files['router-for-package'];
  Object.assign(files, h.routingMetadata);
  for (const [name, record] of Object.entries(files)) assert.equal(record.sha256, manifest.modules.mcp.files[name]
    || manifest.modules.setup.files[name] || manifest.managedRouting.files[name]);
  assert.equal(Object.keys(files).length, 15); assert.deepEqual(h.payloadFiles, files, 'Exact native modes and payload records required');
  return manifest;
}
function verificationTools(root) {
  const verifierTarget = path.join(root, 'artifacts', 'unix-verifier-target');
  const transferTarget = path.join(root, 'native/unix-transfer/target');
  return {
    verifierArgs: ['build', '--release', '--locked', '--manifest-path', path.join(root, 'src-tauri/Cargo.toml'), '--example', 'verify-package-input', '--target-dir', verifierTarget],
    transferArgs: ['build', '--release', '--locked', '--manifest-path', path.join(root, 'native/unix-transfer/Cargo.toml'), '--target-dir', transferTarget],
    verifier: path.join(verifierTarget, 'release/examples/verify-package-input'),
    transfer: path.join(transferTarget, 'release/creator-hub-unix-transfer'),
  };
}
function verifyPrivateSource(sourceCommit, run) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  run('git', ['diff', '--exit-code', sourceCommit, 'HEAD', '--', ...PRIVATE_SOURCE_PATHS]);
}
function assemble(input, output, platform, arch, context = {}) {
  const root = context.root || path.resolve(__dirname, '..');
  const env = context.env || process.env;
  const execute = context.execute || execFileSync;
  const accepted = admission(root, platform, arch, env, execute);
  assert.equal(platform, { linux: 'linux', darwin: 'macos' }[process.platform], 'Matching native Unix process required');
  assert.equal(arch, { x64: 'x86_64', arm64: 'aarch64' }[process.arch], 'Matching native architecture required');
  absolute(input); absolute(output);
  inside(input, fs.realpathSync(env.RUNNER_TEMP)); inside(output, path.join(root, 'artifacts', 'unified'));
  assert.equal(fs.existsSync(output), false, 'Assembly output is immutable');
  inventory(input, INPUTS);
  const { capture } = require('./sign-unix-payload.cjs');
  const record = name => capture(path.join(input, name), name === 'modules.tar.gz' ? 256 * 1024 * 1024 : name.endsWith('.minisig') ? 4096 : META);
  const records = Object.fromEntries(INPUTS.map(name => [name, record(name)]));
  assert.equal(records['handoff.json'].sha256, accepted.handoffSha256, 'Independent handoff pin differs');
  const recheck = () => { for (const name of INPUTS) assert.deepEqual(record(name), records[name], 'Handoff changed during assembly'); };
  function run(command, args) {
    recheck();
    const result = execute(command, args, { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 600000, maxBuffer: 1024 * 1024 });
    recheck(); return String(result).trim();
  }
  // Compile only source-controlled verification tools, never private modules or router.
  const { verifierArgs, transferArgs, verifier, transfer } = verificationTools(root);
  run('cargo', verifierArgs);
  run('cargo', transferArgs);
  function signature(body, sig) {
    assert.equal(run(verifier, [path.join(input, body), path.join(input, sig)]),
      `Verified trusted package signature: ${records[body].sha256}. No activation or client changes.`, 'Trusted signature verification failed');
  }
  signature('handoff.json', 'handoff.minisig');
  function read(name, canonical) {
    const bytes = fs.readFileSync(path.join(input, name));
    const value = JSON.parse(bytes);
    if (canonical) assert.equal(bytes.toString('utf8').trim(), JSON.stringify(value, null, 2), 'Noncanonical or duplicate metadata');
    recheck(); return value;
  }
  const handoff = read('handoff.json', true), prepared = read('prepared-unix.json', true);
  const manifest = validateHandoff(handoff, prepared, records, platform, arch, accepted.version);
  // Different assembly commits are permitted only when all private source is unchanged.
  verifyPrivateSource(handoff.source.sourceCommit, run);
  for (const name of ['mcp', 'setup']) {
    const config = name === 'mcp' ? 'modules/mcp/launcher/src-tauri/tauri.conf.json' : 'modules/project-setup/src-tauri/tauri.conf.json';
    assert.equal(manifest.modules[name].version, JSON.parse(fs.readFileSync(path.join(root, config))).version);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'))).version, handoff.hubVersion);
  signature('routing/router.json', 'routing/router.minisig'); signature('routing/runtime.json', 'routing/runtime.minisig');
  const router = read('routing/router.json', false), runtime = read('routing/runtime.json', false);
  assert.deepEqual(router, { schemaVersion: 1, product: 'com.creatorworks.hub.mcp-router', platform, arch, protocol: 1, sha256: prepared.files['router-for-package'].sha256 });
  assert.deepEqual(runtime, runtimeDescriptor(manifest, handoff.hubVersion));
  const args = TRANSFER.map(name => path.join(input, name));
  const message = 'Unsigned transfer checked. No payload execution, signing, activation or release acceptance.';
  assert.equal(run(transfer, ['verify', ...args]), message);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  assert.equal(run(transfer, ['extract', ...args, output]), message);
  for (const [name, expected] of Object.entries(prepared.files)) {
    assert.deepEqual(capture(path.join(output, name), expected.size), { sha256: expected.sha256, size: expected.size });
    assert.equal(fs.statSync(path.join(output, name)).mode & 0o7777, expected.mode, 'Native mode differs after extraction');
  }
  const rawManifest = JSON.parse(fs.readFileSync(path.join(output, 'builtin-manifest.json')));
  assert.deepEqual(rawManifest, { schemaVersion: 1, platform, arch, modules: manifest.modules });
  fs.mkdirSync(path.join(output, 'modules/routing'));
  for (const name of ROUTING) fs.copyFileSync(path.join(input, name), path.join(output, 'modules', name), fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(path.join(output, 'router-for-package'), path.join(output, 'modules', routeFiles(platform)[0]), fs.constants.COPYFILE_EXCL);
  fs.chmodSync(path.join(output, 'modules', routeFiles(platform)[0]), 0o755);
  for (const [name, expected] of Object.entries(handoff.payloadFiles)) {
    const file = path.join(output, 'modules', name);
    assert.deepEqual(capture(file, expected.size), { sha256: expected.sha256, size: expected.size });
    assert.equal(fs.statSync(file).mode & 0o7777, expected.mode);
  }
  require('./build-unified.cjs').verifyStage(path.join(output, 'modules'), manifest);
  if (platform === 'macos') for (const name of [manifest.modules.mcp.executable, manifest.modules.setup.executable, 'mcp/server/runtime/node', routeFiles(platform)[0]]) {
    run('/usr/bin/codesign', ['--verify', '--strict', path.join(output, 'modules', name)]);
  }
  recheck();
  return { manifest, version: accepted.version, source: handoff.source, handoffSha256: accepted.handoffSha256, nativeGuiAccepted: false, releaseReady: false };
}

module.exports = { admission, inventory, validateHandoff, verificationTools, verifyPrivateSource, assemble, INPUTS, TRANSFER, ROUTING, WORKFLOW };
