// Preparation is unsigned build evidence, never runtime or publication authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const semver = require('semver');

const REPOSITORY = 'BOBWORKS-XR/CREATOR-HUB';
const REPOSITORY_ID = 1364807512;
const WORKFLOW = '.github/workflows/unix-managed-payload.yml';
const MAX_FILE = 256 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;

function checkSplitOptions(options) {
  if (options.signedUnixInput !== null && options.signedUnixInput !== undefined) {
    if (!path.isAbsolute(options.signedUnixInput)) throw Error('Signed Unix staging must be absolute.');
    if (!['linux', 'macos'].includes(options.platform) || options.managed !== true
      || options.experimentalUnix !== true || options.experimentalWritable !== true || options.prepareManagedUnix) {
      throw Error('Signed Unix assembly requires native Unix, --managed, --experimental-unix and --experimental-unix-writable, without preparation.');
    }
    return;
  }
  if (!options.prepareManagedUnix) return;
  if (!['linux', 'macos'].includes(options.platform) || options.installer
    || options.managed !== true || options.experimentalUnix !== true || options.experimentalWritable !== true) {
    throw Error('--prepare-managed-unix requires native Unix, --managed, --experimental-unix and --experimental-unix-writable, without --installer.');
  }
}

function positiveId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw Error('Invalid GitHub run identity.');
  }
  return Number(value);
}

function git(root, args, execute) {
  return String(execute('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe', timeout: 30000, maxBuffer: 1024 * 1024 })).trim();
}

function prepareAdmission(root, platform, arch, env, execute = execFileSync) {
  const os = { linux: 'Linux', macos: 'macOS' }[platform];
  const cpu = { x86_64: 'X64', aarch64: 'ARM64' }[arch];
  const validationPush = env.GITHUB_EVENT_NAME === 'push'
    && env.GITHUB_REF === 'refs/heads/validation/unix-payload-014'
    && env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/${WORKFLOW}@${env.GITHUB_REF}`;
  if (!os || !cpu || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted'
    || env.RUNNER_OS !== os || env.RUNNER_ARCH !== cpu || env.GITHUB_REPOSITORY !== REPOSITORY
    || env.GITHUB_REPOSITORY_ID !== String(REPOSITORY_ID) || !(env.GITHUB_EVENT_NAME === 'workflow_dispatch' || validationPush)
    || typeof env.GITHUB_WORKFLOW_REF !== 'string'
    || !env.GITHUB_WORKFLOW_REF.startsWith(`${REPOSITORY}/${WORKFLOW}@refs/heads/`)) {
    throw Error('Managed Unix preparation requires its explicit native GitHub-hosted workflow dispatch.');
  }
  if (Object.keys(env).some(name => name.startsWith('CREATOR_HUB_SIGNING_')
    || name.startsWith('APPLE_') || name.startsWith('TAURI_SIGNING_'))) {
    throw Error('Unsigned native preparation refuses signing credentials.');
  }
  const runId = positiveId(env.GITHUB_RUN_ID);
  const runAttempt = positiveId(env.GITHUB_RUN_ATTEMPT);
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')) throw Error('Invalid GitHub source commit.');
  const realRoot = fs.realpathSync(root);
  if (path.resolve(root) !== realRoot || path.relative(realRoot, git(root, ['rev-parse', '--show-toplevel'], execute)) !== '') {
    throw Error('Preparation must use the canonical repository root.');
  }
  if (git(root, ['status', '--porcelain=v1', '--untracked-files=normal'], execute)) {
    throw Error('Preparation requires a clean initial source checkout. No existing files were changed.');
  }
  const buildCommit = git(root, ['rev-parse', 'HEAD'], execute);
  const sourceTree = git(root, ['rev-parse', 'HEAD^{tree}'], execute);
  if (buildCommit !== env.GITHUB_SHA || !/^[a-f0-9]{40}$/.test(sourceTree)) {
    throw Error('Checkout does not match the dispatched source commit/tree.');
  }
  return { repository: REPOSITORY, repositoryId: REPOSITORY_ID, workflow: WORKFLOW,
    event: env.GITHUB_EVENT_NAME, sourceCommit: buildCommit, buildCommit, sourceTree, runId, runAttempt };
}

function fileMode(manifest, name, executable) {
  return name === executable || name === manifest.modules?.mcp?.executable || name === manifest.modules?.setup?.executable
    || name === 'mcp/server/runtime/node' || name === 'router-for-package' ? 0o755 : 0o644;
}

function outputAdmission(output, root) {
  const relative = path.relative(root, output);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw Error('Prepared output escaped its repository.');
  for (let part = path.dirname(output);; part = path.dirname(part)) {
    try {
      const stat = fs.lstatSync(part);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Prepared output ancestor is redirected or not a directory.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (part === root) break;
  }
}

function realAncestors(file, root) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw Error('Prepared file escaped its owned output.');
  for (let part = path.dirname(file);; part = path.dirname(part)) {
    const stat = fs.lstatSync(part);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Prepared ancestor is redirected or not a directory.');
    if (part === root) break;
  }
  if (fs.realpathSync(root) !== root) throw Error('Prepared root is redirected.');
}

function snapshot(file, root, expectedMode, modeRequired = process.platform !== 'win32') {
  realAncestors(file, root);
  const named = fs.lstatSync(file, { bigint: true });
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || named.size <= 0n || named.size > BigInt(MAX_FILE)) {
    throw Error('Prepared input must be a bounded regular unlinked file.');
  }
  if (modeRequired && Number(named.mode & 0o7777n) !== expectedMode) throw Error('Prepared file mode differs from the native payload contract.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  const fields = ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeNs', 'ctimeNs'];
  const same = (a, b) => fields.every(field => a[field] === b[field]);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!same(named, before)) throw Error('Prepared file changed before capture.');
    const digest = crypto.createHash('sha256'), buffer = Buffer.alloc(65536);
    let total = 0;
    for (let size; (size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
      total += size;
      if (total > MAX_FILE) throw Error('Prepared file grew beyond its bound.');
      digest.update(buffer.subarray(0, size));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const finalName = fs.lstatSync(file, { bigint: true });
    realAncestors(file, root);
    if (!same(before, after) || !same(after, finalName) || !finalName.isFile() || Number(after.size) !== total) {
      throw Error('Prepared file changed during capture.');
    }
    return { sha256: digest.digest('hex'), size: total, mode: expectedMode };
  } finally { fs.closeSync(fd); }
}

function finishPreparation(output, manifest, router, hubVersion, source, root, execute = execFileSync) {
  const { verifyStage, relativeFile } = require('./build-unified.cjs');
  const { runtimeDescriptor } = require('./mcp-runtime-descriptor.cjs');
  if (!['linux', 'macos'].includes(manifest.platform) || manifest.managedRouting || manifest.payloadArchive
    || semver.valid(hubVersion) !== hubVersion || semver.parse(hubVersion).build.length) throw Error('Invalid unsigned preparation scope.');
  verifyStage(path.join(output, 'modules'), manifest);
  const target = path.join(output, 'router-for-package');
  if (router !== target) fs.copyFileSync(router, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, 0o755);
  const descriptor = path.join(output, 'builtin-manifest.json');
  fs.writeFileSync(descriptor, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o644 });
  fs.chmodSync(descriptor, 0o644);
  const runtime = path.join(output, 'mcp-runtime.json');
  fs.chmodSync(runtime, 0o644);
  if (fs.statSync(runtime).size > 32768 || fs.readFileSync(runtime, 'utf8') !== JSON.stringify(runtimeDescriptor(manifest, hubVersion))) {
    throw Error('Prepared runtime metadata differs from the module/Hub identity.');
  }
  const hashes = Object.fromEntries(Object.values(manifest.modules).flatMap(module => Object.entries(module.files)));
  const files = {};
  for (const name of Object.keys(hashes).sort()) {
    if (!relativeFile(name)) throw Error('Invalid prepared module path.');
    const record = snapshot(path.join(output, 'modules', name), output, fileMode(manifest, name));
    if (record.sha256 !== hashes[name]) throw Error('Prepared module differs from its build-bound hash.');
    files[`modules/${name}`] = record;
  }
  for (const name of ['builtin-manifest.json', 'mcp-runtime.json', 'router-for-package']) {
    files[name] = snapshot(path.join(output, name), output, fileMode(manifest, name));
  }
  if (Object.values(files).reduce((total, record) => total + record.size, 0) > MAX_TOTAL) throw Error('Prepared payload exceeds its total bound.');
  if (git(root, ['rev-parse', 'HEAD'], execute) !== source.buildCommit
    || git(root, ['rev-parse', 'HEAD^{tree}'], execute) !== source.sourceTree) throw Error('Source identity changed during preparation.');
  const receipt = { schemaVersion: 1, product: 'com.creatorworks.hub.unix-managed-preparation',
    hubVersion, platform: manifest.platform, arch: manifest.arch,
    rustTarget: `${manifest.arch}-${manifest.platform === 'macos' ? 'apple-darwin' : 'unknown-linux-gnu'}`,
    mcpMode: 'writable', compiledFlags: { internalModule: true, experimentalUnixHosting: true, hostWritable: true, readOnlyEvents: true },
    source, files, unsigned: true, privateKeyIncluded: false, nativeGuiTested: false, nativeConsentTested: false, releaseReady: false };
  const bytes = JSON.stringify(receipt, null, 2);
  if (Buffer.byteLength(bytes) > 128 * 1024) throw Error('Preparation receipt exceeds the offline metadata limit.');
  fs.writeFileSync(path.join(output, 'prepared-unix.json'), bytes, { flag: 'wx', mode: 0o644 });
  fs.chmodSync(path.join(output, 'prepared-unix.json'), 0o644);
  return receipt;
}

module.exports = { checkSplitOptions, prepareAdmission, outputAdmission, fileMode, snapshot, finishPreparation };
