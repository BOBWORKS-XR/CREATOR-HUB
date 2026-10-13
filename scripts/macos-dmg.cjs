// Headless repack of an already signed app. Never a signer or release gate.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const unix = require('./unix-package-payload.cjs');

const MAX_FILE = 512 * 1024 * 1024;
const MAX_TOTAL = 4 * 1024 * 1024 * 1024;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const requireValue = (value, message) => { if (!value) throw Error(message); };
const within = (root, file) => file.startsWith(`${root}${path.sep}`);
const exists = file => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const pinnedHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function assertNativeRunner(experimental, context = {}) {
  const env = context.env || process.env;
  const platform = context.platform || process.platform;
  const arch = context.arch || process.arch;
  requireValue(experimental === true && platform === 'darwin' && ['x64', 'arm64'].includes(arch),
    'Explicit experimental native Mac packaging required.');
  requireValue(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
    && env.RUNNER_OS === 'macOS' && env.RUNNER_ARCH === (arch === 'x64' ? 'X64' : 'ARM64')
    && env.CREATOR_MACOS_DMG_EXPERIMENT === '1', 'Explicit disposable GitHub-hosted Mac runner required.');
  unix.packageEnvironment(env, 'macos'); // Reject ambient automatic signing credentials, without reading them.
  requireValue(!Object.keys(env).some(name => /^(?:DYLD_|DITTO)/.test(name)), 'Copy/loader environment overrides are refused.');
  return { env, arch, uid: context.uid ?? process.getuid() };
}

function canonical(file, directory, uid) {
  requireValue(typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file
    && fs.realpathSync(file) === file, 'Existing absolute unredirected input required.');
  const stat = fs.lstatSync(file);
  requireValue(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile())
    && stat.uid === uid, 'Input must be an owned regular file/directory.');
  return stat;
}

function identity(stat) {
  return ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(name => String(stat[name]));
}

function fileProof(file, uid, keepBytes = false) {
  canonical(file, false, uid);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    requireValue(before.isFile() && before.nlink === 1n && before.uid === BigInt(uid)
      && before.size > 0n && before.size <= BigInt(MAX_FILE), 'Bounded single-link owned file required.');
    const digest = crypto.createHash('sha256');
    const block = Buffer.alloc(1024 * 1024);
    const chunks = [];
    let total = 0;
    for (;;) {
      const count = fs.readSync(fd, block, 0, block.length, null);
      if (!count) break;
      total += count;
      requireValue(total <= MAX_FILE, 'Input file exceeds bound.');
      digest.update(block.subarray(0, count));
      if (keepBytes) chunks.push(Buffer.from(block.subarray(0, count)));
    }
    requireValue(BigInt(total) === before.size && JSON.stringify(identity(before)) === JSON.stringify(identity(fs.fstatSync(fd, { bigint: true }))),
      'Input file changed while hashing.');
    return { sha256: digest.digest('hex'), size: total, identity: identity(before), ...(keepBytes ? { bytes: Buffer.concat(chunks) } : {}) };
  } finally { fs.closeSync(fd); }
}

function appInventory(app, { uid = process.getuid?.() ?? fs.lstatSync(app).uid } = {}) {
  canonical(app, true, uid);
  const entries = [];
  const identities = [];
  let bytes = 0;
  function walk(file, name, depth) {
    requireValue(depth <= 64 && entries.length < 20000, 'App inventory exceeds bound.');
    const stat = fs.lstatSync(file, { bigint: true });
    const mode = Number(stat.mode & 0o7777n);
    requireValue(stat.uid === BigInt(uid) && !(mode & 0o7000), 'App entry owner/special mode refused.');
    const entry = { path: name, mode };
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(file);
      requireValue(target && !path.isAbsolute(target) && !/[\x00-\x1f]/.test(target), 'App symlink must be relative and safe.');
      const resolved = fs.realpathSync(file);
      requireValue(resolved === app || within(app, resolved), 'App symlink escaped the approved bundle.');
      Object.assign(entry, { type: 'symlink', target });
    } else {
      requireValue(fs.realpathSync(file) === file, 'App path ancestor is redirected.');
      if (stat.isDirectory()) entry.type = 'directory';
      else {
        requireValue(stat.isFile(), 'App special files are refused.');
        // Empty app data files are permitted; executable/descriptor proofs remain nonempty.
        requireValue(stat.nlink === 1n && stat.size <= BigInt(MAX_FILE), 'App hardlink/oversized file refused.');
        if (stat.size === 0n) Object.assign(entry, { type: 'file', size: 0, sha256: sha(Buffer.alloc(0)) });
        else {
          const proof = fileProof(file, uid);
          Object.assign(entry, { type: 'file', size: proof.size, sha256: proof.sha256 });
        }
        bytes += entry.size;
        requireValue(bytes <= MAX_TOTAL, 'App inventory byte bound exceeded.');
      }
    }
    entries.push(entry);
    identities.push({ path: name, identity: identity(stat) });
    requireValue(JSON.stringify(identity(stat)) === JSON.stringify(identity(fs.lstatSync(file, { bigint: true }))), 'App entry changed during inventory.');
    if (stat.isDirectory()) for (const child of fs.readdirSync(file).sort()) {
      requireValue(child && !/[\x00-\x1f]/.test(child), 'Unsafe app entry name.');
      walk(path.join(file, child), name ? `${name}/${child}` : child, depth + 1);
    }
  }
  walk(app, '', 0);
  return { sha256: sha(Buffer.from(JSON.stringify(entries))), bytes, entries, identities };
}

function sameTree(expected, actual) {
  requireValue(expected.sha256 === actual.sha256, 'Signed app bytes/modes/symlinks changed.');
}

function sameInput(expected, actual) {
  requireValue(expected.sha256 === actual.sha256 && JSON.stringify(expected.identity) === JSON.stringify(actual.identity),
    'Protected caller input changed.');
}

function nativeTool(file, args, options) {
  // File-backed logs avoid maxBuffer termination. A deadline never signals the tool.
  const child = spawn(file, args, { cwd: options.cwd, env: options.env,
    stdio: ['ignore', options.stdoutFd, options.stderrFd] });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => {
      const error = new Error('Owned packaging tool deadline; no signal sent; disposable job teardown required.');
      Object.assign(error, { pid: child.pid, toolMayStillRun: true });
      child.unref();
      finish(error);
    }, options.timeout);
    child.once('error', error => { error.pid = child.pid; finish(error); });
    child.once('exit', (status, signal) => {
      if (status === 0) finish(null, { pid: child.pid, status });
      else {
        const error = new Error(`Owned tool ${path.basename(file)} exited ${status} (${signal || 'no signal'}).`);
        Object.assign(error, { pid: child.pid, status, signal });
        finish(error);
      }
    });
  });
}

async function createDmg(options, context = {}) {
  // Native/runner/explicit opt-in checks precede filesystem inspection and tools.
  const runtime = assertNativeRunner(options?.experimental, context);
  const { sourceApp, destination, dataScope, metadataNeverIndex = false, mcpMode = 'read-only' } = options;
  const { uid, arch, env } = runtime;
  requireValue(mcpMode === 'read-only', 'This worker is limited to the experimental read-only packaging regression.');
  requireValue(typeof metadataNeverIndex === 'boolean' && dataScope && typeof dataScope === 'object', 'Explicit caller data scope required.');
  const { root, manifestFile, manifestSha256, hubSha256, appTreeSha256, preservedFiles = [] } = dataScope;
  canonical(root, true, uid);
  canonical(sourceApp, true, uid);
  canonical(manifestFile, false, uid);
  requireValue(within(root, sourceApp) && within(root, manifestFile) && sourceApp.endsWith('.app'), 'App/manifest must be inside the approved caller data scope.');
  requireValue([manifestSha256, hubSha256, appTreeSha256].every(pinnedHash), 'Independent caller app/Hub/manifest pins required.');
  requireValue(Array.isArray(preservedFiles) && preservedFiles.length <= 16, 'Protected caller input list exceeds bound.');
  for (const item of preservedFiles) {
    requireValue(item && typeof item.path === 'string' && within(root, item.path) && pinnedHash(item.sha256), 'Invalid protected caller input.');
    canonical(item.path, false, uid);
  }
  const temp = fs.realpathSync(env.RUNNER_TEMP);
  canonical(temp, true, uid);
  requireValue(typeof destination === 'string' && path.isAbsolute(destination) && path.resolve(destination) === destination
    && destination.endsWith('.dmg') && !within(root, destination) && destination !== root, 'New absolute .dmg destination outside immutable inputs required.');
  const parent = path.dirname(destination);
  canonical(parent, true, uid);
  requireValue((parent === temp || within(temp, parent)) && !within(root, parent) && parent !== root && !within(sourceApp, parent),
    'Destination parent must be owned runner-temp space outside caller inputs.');
  requireValue(!exists(destination), 'DMG destination already exists; overwrite refused.');
  const productName = path.basename(sourceApp, '.app');
  requireValue(productName && productName.trim() === productName && productName.length <= 128 && !/[\\/:\x00-\x1f]/.test(productName), 'Unsafe product name.');

  const work = fs.mkdtempSync(path.join(parent, '.creator-hub-dmg-'));
  canonical(work, true, uid);
  const stage = path.join(work, 'contents');
  fs.mkdirSync(stage, { mode: 0o700 });
  const stagedApp = path.join(stage, path.basename(sourceApp));
  const workingDmg = path.join(work, 'image.dmg');
  const reportFile = path.join(work, 'report.json');
  const report = { schemaVersion: 1, status: 'failed', experimental: true, platform: 'macos', arch, mcpMode,
    sourceApp, destination, dataScope: root, work, stage, reportFile, metadataNeverIndex,
    releaseReady: false, productAccepted: false, managedGuiAccepted: false, notarizationVerified: false,
    nativeToolsUsed: !context.execute && process.platform === 'darwin', tools: [] };
  const execute = context.execute || nativeTool;
  let before, descriptor, protectedInputs, manifest, failure, stageReady = false;
  async function tool(file, args, timeout = 30000) {
    const item = { file, args, timeout, stdout: `${String(report.tools.length + 1).padStart(2, '0')}.stdout.txt`,
      stderr: `${String(report.tools.length + 1).padStart(2, '0')}.stderr.txt` };
    report.tools.push(item);
    const out = fs.openSync(path.join(work, item.stdout), 'wx');
    const err = fs.openSync(path.join(work, item.stderr), 'wx');
    try {
      const result = await execute(file, args, { cwd: work, timeout, stdoutFd: out, stderrFd: err,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: work, TMPDIR: work, LANG: 'C', LC_ALL: 'C' } });
      if (Buffer.isBuffer(result) || typeof result === 'string') fs.writeSync(out, result);
      else if (result?.pid) item.pid = result.pid;
      item.exitCode = 0;
    } catch (error) {
      if (error.stdout) fs.writeSync(out, error.stdout);
      if (error.stderr) fs.writeSync(err, error.stderr);
      Object.assign(item, { exitCode: error.status ?? null, signal: error.signal ?? null, pid: error.pid ?? null,
        toolMayStillRun: error.toolMayStillRun === true, error: error.message.slice(0, 4000) });
      throw error;
    } finally {
      fs.closeSync(out);
      fs.closeSync(err);
    }
  }
  async function verifyApp(app) {
    const files = unix.verifyResources(path.join(app, 'Contents/Resources/modules'), manifest);
    const hub = fileProof(path.join(app, 'Contents/MacOS/creator-hub'), uid, true);
    requireValue(hub.sha256 === hubSha256 && hub.bytes.includes(descriptor.bytes), 'App Hub differs from caller pin or exact compiled descriptor.');
    await tool('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    return { files, hubSha256: hub.sha256 };
  }
  function verifyStage() {
    const expected = [path.basename(sourceApp), 'Applications', ...(metadataNeverIndex ? ['.metadata_never_index'] : [])].sort();
    requireValue(fs.readdirSync(stage).sort().join('\n') === expected.join('\n'), 'DMG staging gained/lost entries.');
    requireValue((canonical(stage, true, uid).mode & 0o777) === 0o700 || process.platform === 'win32', 'Private staging mode changed.');
    const link = path.join(stage, 'Applications');
    const linkStat = fs.lstatSync(link);
    requireValue(linkStat.isSymbolicLink() && linkStat.uid === uid && fs.readlinkSync(link) === '/Applications', 'Only the exact owned Applications drop link is allowed.');
    if (metadataNeverIndex) {
      const marker = path.join(stage, '.metadata_never_index');
      requireValue(canonical(marker, false, uid).size === 0, 'Unexpected indexing marker.');
    }
    sameTree(before, appInventory(stagedApp, { uid }));
  }
  try {
    before = appInventory(sourceApp, { uid });
    requireValue(before.sha256 === appTreeSha256, 'Signed app inventory differs from independent caller pin.');
    report.sourceInventorySha256 = before.sha256;
    fs.writeFileSync(path.join(work, 'source-before.json'), JSON.stringify(before, null, 2), { flag: 'wx' });
    descriptor = fileProof(manifestFile, uid, true);
    requireValue(descriptor.sha256 === manifestSha256, 'Original manifest differs from caller checksum.');
    manifest = JSON.parse(descriptor.bytes);
    requireValue(manifest.platform === 'macos' && manifest.arch === (arch === 'x64' ? 'x86_64' : 'aarch64'), 'Manifest does not match native Mac architecture.');
    protectedInputs = preservedFiles.map(item => {
      const proof = fileProof(item.path, uid);
      requireValue(proof.sha256 === item.sha256, 'Protected original caller checksum differs.');
      return { path: item.path, ...proof };
    });
    report.inputs = { manifest: { path: manifestFile, sha256: descriptor.sha256 }, preservedFiles: protectedInputs };
    report.sourceVerification = await verifyApp(sourceApp);
    await tool('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', sourceApp, stagedApp], 180000);
    fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
    if (metadataNeverIndex) fs.writeFileSync(path.join(stage, '.metadata_never_index'), '', { flag: 'wx', mode: 0o644 });
    stageReady = true;
    verifyStage();
    report.stagedVerification = await verifyApp(stagedApp);
    await tool('/usr/bin/hdiutil', ['create', '-srcfolder', stage, '-volname', productName, '-fs', 'HFS+', '-format', 'UDZO', '-o', workingDmg], 180000);
    fileProof(workingDmg, uid);
    await tool('/usr/bin/hdiutil', ['verify', workingDmg], 180000);
    verifyStage();
    report.postCreateVerification = await verifyApp(stagedApp);
    verifyStage();
    const image = fileProof(workingDmg, uid);
    const sourceAfter = appInventory(sourceApp, { uid });
    sameTree(before, sourceAfter);
    requireValue(JSON.stringify(before.identities) === JSON.stringify(sourceAfter.identities), 'Original signed app identity/metadata changed.');
    sameInput(descriptor, fileProof(manifestFile, uid));
    for (const input of protectedInputs) sameInput(input, fileProof(input.path, uid));
    // Atomic no-overwrite creation; retained working image is never removed.
    fs.copyFileSync(workingDmg, destination, fs.constants.COPYFILE_EXCL);
    const published = fileProof(destination, uid);
    requireValue(published.sha256 === image.sha256 && published.size === image.size, 'Retained DMG copy differs.');
    report.dmg = { path: destination, sha256: published.sha256, bytes: published.size };
    report.status = 'passed';
  } catch (error) {
    failure = error;
    report.error = error.message;
    error.reportFile = reportFile;
    throw error;
  } finally {
    const errors = [];
    if (before) try {
      const after = appInventory(sourceApp, { uid });
      sameTree(before, after);
      requireValue(JSON.stringify(before.identities) === JSON.stringify(after.identities), 'Original signed app identity/metadata changed.');
      report.sourceUnchanged = true;
    } catch (error) { errors.push(error.message); report.sourceUnchanged = false; }
    if (descriptor) try { sameInput(descriptor, fileProof(manifestFile, uid)); } catch (error) { errors.push(error.message); }
    if (protectedInputs) for (const input of protectedInputs) try { sameInput(input, fileProof(input.path, uid)); } catch (error) { errors.push(error.message); }
    if (stageReady) try { verifyStage(); report.stageUnchanged = true; } catch (error) { errors.push(error.message); report.stageUnchanged = false; }
    if (errors.length) {
      report.status = 'failed';
      report.preservationErrors = errors;
    }
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), { flag: 'wx' });
    if (errors.length) {
      const error = new AggregateError([...(failure ? [failure] : []), ...errors.map(message => new Error(message))],
        [report.error, ...errors].filter(Boolean).join('; '));
      error.reportFile = reportFile;
      throw error;
    }
  }
  return report;
}

module.exports = { assertNativeRunner, appInventory, createDmg };
