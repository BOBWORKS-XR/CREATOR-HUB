'use strict';

// Disposable native diagnostics only. No retirement mutator or production authority.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const branch = 'refs/heads/validation/mac-legacy-retirement-014';
const scope = Object.freeze({ diagnosticOnly: true, nativeRetirementAccepted: false,
  nativeReviewAccepted: false, settingsMigrationAccepted: false, unifiedInstallerAccepted: false,
  signedUpdateAccepted: false, releaseReady: false });
const products = Object.freeze({
  setup: { name: 'Creator Project Setup', version: '0.3.7', exe: 'creator-project-setup', bundle: 'com.creatorworks.projectsetup' },
  mcp: { name: 'Creator Works MCP', version: '2.7.7', exe: 'creator-works-mcp-launcher', bundle: 'com.creatorworks.unitymcp.preview' },
});
const dmgPins = Object.freeze({
  arm64: { setup: [4424902, 'addb89d072b65ea8def467c9ee35382103b922b40490b8394a1fdb19c841c3d6'],
    mcp: [83146047, 'e4e8ac91938cc32f53c8390003ad6eed0d577d46931083c3182d87df66e5ba78'] },
  x64: { setup: [4691680, 'd7b131c74c2187ee0f4ccb24bf3a73df1f600e3c3785d0cc2f30044302a96a7a'],
    mcp: [85872792, 'ef6efca28df84da4f5ea01f4bcee24e8ae77964d84b65c3b9a808fbdb755a79e'] },
});
function check(value, message) { if (!value) throw Error(message); }
function admission(env, platform, arch) {
  check(platform === 'darwin' && ['arm64', 'x64'].includes(arch), 'native-matching-mac-required');
  check(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
    && env.RUNNER_OS === 'macOS' && env.GITHUB_REPOSITORY === 'BOBWORKS-XR/CREATOR-HUB'
    && env.GITHUB_REF === branch && env.CREATOR_MACOS_LEGACY_RETIREMENT_PROBE === '1', 'fixed-disposable-runner-opt-in-required');
  check(env.RUNNER_ARCH === (arch === 'arm64' ? 'ARM64' : 'X64'), 'runner-architecture-mismatch');
}
function packageFor(proof, product, arch) {
  check(Object.hasOwn(products, product) && Object.hasOwn(dmgPins, arch), 'unknown-product-or-architecture');
  const spec = products[product], suffix = arch === 'arm64' ? 'aarch64' : 'x64';
  const asset = `${spec.name.replaceAll(' ', '.')}_${spec.version}_${suffix}.dmg`;
  const rows = proof.packages.filter(row => row.asset === asset && row.product === product);
  check(rows.length === 1, 'exact-single-public-package-required');
  const pkg = rows[0], pins = dmgPins[arch][product];
  check(pkg.packageBytes === pins[0] && pkg.packageSha256 === pins[1], 'public-dmg-pin-drift');
  const repo = product === 'mcp' ? 'CREATOR-WORKS-UNITY-MCP' : 'CREATOR-PROJECT-SETUP';
  check(pkg.packageUrl === `https://github.com/BOBWORKS-XR/${repo}/releases/download/v${spec.version}/${asset}`,
    'public-package-url-drift');
  const prefix = `${spec.name}/${spec.name}.app/`;
  check(pkg.members.length === (product === 'mcp' ? 13 : 4), 'complete-pinned-bundle-required');
  const members = pkg.members.map(row => {
    check(row.member.startsWith(prefix) && !row.member.includes('\\')
      && row.member.split('/').every(part => part && part !== '..' && part !== '.'), 'unsafe-member');
    check(/^[a-f0-9]{64}$/.test(row.sha256) && Number.isSafeInteger(row.bytes) && row.bytes > 0, 'invalid-member-pin');
    return { relative: row.member.slice(prefix.length), bytes: row.bytes, sha256: row.sha256 };
  }).sort((a, b) => a.relative.localeCompare(b.relative));
  check(new Set(members.map(row => row.relative)).size === members.length, 'duplicate-member');
  return { ...pkg, members, ...spec, product };
}
function canonical(file) {
  check(path.isAbsolute(file) && path.normalize(file) === file && fs.realpathSync(file) === file, 'noncanonical-or-linked-path');
  return file;
}
function identity(stat) {
  return Object.fromEntries(['dev', 'ino', 'size', 'mode', 'uid', 'nlink', 'mtimeNs'].map(key => [key, String(stat[key])]));
}
function pin(file, max = 160 * 1024 * 1024) {
  canonical(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const first = fs.fstatSync(fd, { bigint: true });
    check(first.isFile() && first.nlink === 1n && first.size > 0n && first.size <= BigInt(max)
      && first.uid === BigInt(process.getuid()), 'unowned-linked-or-unbounded-file');
    const hash = crypto.createHash('sha256'), buf = Buffer.alloc(65536);
    let bytes = 0;
    for (;;) {
      const count = fs.readSync(fd, buf, 0, buf.length, null);
      if (!count) break;
      bytes += count; check(bytes <= max, 'file-grew'); hash.update(buf.subarray(0, count));
    }
    const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
    check(isDeepStrictEqual(identity(first), identity(after)) && isDeepStrictEqual(identity(after), identity(named))
      && bytes === Number(after.size), 'file-drift');
    return { bytes, sha256: hash.digest('hex'), identity: identity(after) };
  } finally { fs.closeSync(fd); }
}
function inventory(app, pkg) {
  canonical(app);
  const found = [];
  function visit(folder, relative = '') {
    check(found.length <= 32 && relative.split('/').length < 10, 'bundle-too-large');
    const dir = fs.lstatSync(folder);
    check(dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === process.getuid(), 'bundle-directory-unowned-or-linked');
    for (const name of fs.readdirSync(folder).sort()) {
      const rel = relative ? `${relative}/${name}` : name, file = path.join(folder, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file, rel);
      else { check(stat.isFile() && !stat.isSymbolicLink(), 'unexpected-bundle-member'); found.push({ relative: rel, ...pin(file) }); }
    }
  }
  visit(app);
  const expected = pkg.members.map(row => ({ relative: row.relative, bytes: row.bytes, sha256: row.sha256 }));
  const actual = found.map(({ relative, bytes, sha256 }) => ({ relative, bytes, sha256 })).sort((a, b) => a.relative.localeCompare(b.relative));
  check(isDeepStrictEqual(actual, expected), 'complete-public-bundle-member-mismatch');
  return found.sort((a, b) => a.relative.localeCompare(b.relative));
}
function missingContract(facts) {
  if (!facts.exactBundle) return 'exact-public-bundle-unverified-no-launch';
  if (!facts.bundleSignature) return 'public-bundle-strict-signature-refused-no-gui-launch';
  if (!facts.normalExit) return 'normal-native-close-or-owned-exit-unverified-no-retirement';
  // An exited child is not fresh consent, an exclusive install reservation, or registration removal authority.
  return 'native-reviewed-no-overwrite-archive-and-registration-contract-not-established';
}
function directoryInventory(app) {
  const rows = [];
  function visit(folder, relative) {
    canonical(folder);
    const stat = fs.lstatSync(folder, { bigint: true });
    check(stat.isDirectory() && stat.uid === BigInt(process.getuid()) && rows.length < 24, 'bundle-directory-unverified');
    rows.push({ relative, identity: identity(stat) });
    for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, name), child = fs.lstatSync(file);
      check(!child.isSymbolicLink(), 'linked-bundle-child-refused');
      if (child.isDirectory()) visit(file, relative === '.' ? name : `${relative}/${name}`);
    }
  }
  visit(app, '.'); return rows;
}
async function oldPathReconnect(node, server) {
  check(!fs.existsSync(node) && !fs.existsSync(server), 'old-runtime-path-still-present');
  const child = spawn(node, [server], { stdio: 'ignore' });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => { child.unref(); reject(Error('old-path-spawn-outcome-unknown')); }, 5000);
      child.once('error', error => {
        if (error.code === 'ENOENT' && child.pid === undefined) resolve({ spawned: false, errorCode: error.code, oldNodeAbsent: true, oldServerAbsent: true });
        else reject(Error(`old-path-unexpected-spawn-error-${error.code}`));
      });
      child.once('exit', (code, signal) => reject(Error(`unexpected-old-path-process-${code}-${signal}`)));
    });
  } finally { clearTimeout(timer); }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function execute(file, args, output, label, ms = 15000, allowFailure = false) {
  const stdout = path.join(output, `${label}.stdout`), stderr = path.join(output, `${label}.stderr`);
  const out = fs.openSync(stdout, 'wx', 0o600), err = fs.openSync(stderr, 'wx', 0o600);
  let child;
  try { child = spawn(file, args, { stdio: ['ignore', out, err] }); }
  finally { fs.closeSync(out); fs.closeSync(err); }
  const result = await new Promise(resolve => {
    let settled = false;
    const end = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.unref(); end({ deadlineExpired: true, exitCode: null, pid: child.pid }); }, ms);
    child.once('error', error => end({ error: error.message, exitCode: null }));
    child.once('exit', (exitCode, signal) => end({ exitCode, signal, pid: child.pid }));
  });
  check(!result.deadlineExpired && !result.error, `${label}-tool-lifetime-uncertain`);
  const bytes = fs.statSync(stdout).size + fs.statSync(stderr).size;
  check(bytes <= 1024 * 1024, `${label}-output-unbounded`);
  if (!allowFailure) check(result.exitCode === 0 && !result.signal, `${label}-failed`);
  return { ...result, stdout: fs.readFileSync(stdout, 'utf8'), stderr: fs.readFileSync(stderr, 'utf8') };
}
function createStdio(node, server, config, output, label) {
  const err = fs.openSync(path.join(output, `${label}.stderr`), 'wx', 0o600);
  const child = spawn(node, [server], { env: { ...process.env, CREATOR_WORKS_LAUNCHER_CONFIG: config,
    MCP_TOOL_GROUPS: 'read' }, stdio: ['pipe', 'pipe', err] });
  fs.closeSync(err);
  let tail = '', total = 0, next = 1, fault = null;
  const pending = new Map();
  const exited = new Promise(resolve => {
    child.once('error', error => { fault = error; resolve({ error: error.message }); });
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', bytes => {
    try {
      total += Buffer.byteLength(bytes); tail += bytes;
      check(total <= 8 * 1024 * 1024 && tail.length <= 1024 * 1024, 'stdio-unbounded');
      let index;
      while ((index = tail.indexOf('\n')) >= 0) {
        const line = tail.slice(0, index); tail = tail.slice(index + 1);
        const value = JSON.parse(line), resolve = pending.get(value.id);
        if (resolve) { pending.delete(value.id); resolve(value); }
      }
    } catch (error) { fault = error; }
  });
  child.stdin.on('error', error => { fault = error; });
  function send(value) { check(!fault, fault?.message); child.stdin.write(JSON.stringify(value) + '\n'); }
  async function request(method, params) {
    const id = next++;
    const response = new Promise(resolve => pending.set(id, resolve));
    send({ jsonrpc: '2.0', id, method, params });
    let timer;
    try {
      const result = await Promise.race([response, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`stdio-${method}-deadline`)), 10000);
      })]);
      check(!fault && result.jsonrpc === '2.0' && result.id === id && !result.error, 'stdio-result-refused');
      return result.result;
    } finally { clearTimeout(timer); pending.delete(id); }
  }
  return {
    pid: child.pid,
    async start() {
      const info = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'native-mac-legacy-diagnostic', version: '1' } });
      check(info.serverInfo?.name && info.protocolVersion, 'stdio-initialize-unverified');
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return this.list();
    },
    async list() {
      const result = await request('tools/list', {});
      check(Array.isArray(result.tools) && result.tools.length > 0 && result.tools.length <= 1024, 'stdio-tools-unverified');
      return { tools: result.tools.length, pid: child.pid };
    },
    async reference() {
      // Public 2.7.7 source implements this using bundled constants only: no Editor/network/file write.
      const result = await request('tools/call', { name: 'get_mcp_reference',
        arguments: { source: 'workflows', entryId: 'networking', limit: 1 } });
      check(result.isError !== true && Array.isArray(result.content) && result.content.length === 1
        && result.content[0].type === 'text' && Buffer.byteLength(result.content[0].text) <= 16384, 'readonly-reference-result-unverified');
      const value = JSON.parse(result.content[0].text);
      check(value.success === true && value.source === 'workflows' && value.returned === 1
        && value.entries?.[0]?.entryId === 'networking', 'readonly-reference-content-unverified');
      return { success: true, pid: child.pid, source: value.source, entryId: value.entries[0].entryId,
        responseSha256: crypto.createHash('sha256').update(result.content[0].text).digest('hex') };
    },
    async close() {
      child.stdin.end();
      let timer;
      const result = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve({ deadlineExpired: true }), 5000); })]);
      clearTimeout(timer);
      if (result.deadlineExpired) { child.unref(); child.stdin.unref(); child.stdout.unref(); }
      check(result.exitCode === 0 && !result.signal && !fault, 'stdio-eof-exit-unverified-no-force-stop');
      return result;
    },
  };
}
async function run(env = process.env) {
  admission(env, process.platform, process.arch); // Must precede filesystem or process inspection.
  check(process.argv.length === 2, 'no-arbitrary-inputs-supported');
  check(env.CREATOR_MACOS_LEGACY_STANDARD_TRASH_EXPERIMENT === '1', 'explicit-standard-trash-experiment-opt-in-required');
  const temporary = canonical(fs.realpathSync(env.RUNNER_TEMP)), home = canonical(os.homedir());
  const output = path.join(temporary, 'macos-legacy-retirement-probe'); fs.mkdirSync(output, { mode: 0o700 });
  const apps = path.join(home, 'Applications');
  if (!fs.existsSync(apps)) fs.mkdirSync(apps, { mode: 0o700 });
  canonical(apps);
  const proof = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/evidence/legacy-unix-public-package-pins-014.json'), 'utf8'));
  const report = { schemaVersion: 1, ...scope, architecture: process.arch, products: [], sourceCommit: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID, noForceStop: true, nativeReviewAttempted: false, retirementMutationAttempted: false };
  const helper = path.join(temporary, 'native-macos-legacy-retirement-probe');
  const helperPin = pin(helper);
  async function native(args, folder, label, allowFailure = false) {
    check(isDeepStrictEqual(pin(helper), helperPin), 'native-helper-drift');
    const result = await execute(helper, args, folder, label, 10000, allowFailure);
    let receipt;
    try { receipt = JSON.parse(result.stdout); } catch { throw Error(`${label}-native-receipt-invalid`); }
    check(receipt.diagnosticOnly === true && receipt.retirementMutationAttempted === false, 'native-scope-drift');
    return { ...result, receipt };
  }
  async function trashExperiment(app, pkg, row, stdio, folder) {
    check(row.facts.normalExit && stdio && row.exactOriginalMembersPreserved === undefined, 'closed-pinned-live-stdio-baseline-required');
    const experiment = path.join(folder, 'standard-trash-experiment'); fs.mkdirSync(experiment, { mode: 0o700 });
    let trashApp;
    const result = { diagnosticOnly: true, productionAuthority: false, nativeCancel: false, nativeApprove: false,
      standardTrash: false, restored: false, experimentPassed: false,
      originalRuntimePathsPreserved: false, clientsMigrated: false, oldApp: app,
      beforeDirectories: directoryInventory(app) };
    row.trashExperiment = result; report.nativeReviewAttempted = true;
    const out = fs.openSync(path.join(experiment, 'trash-host.stdout'), 'wx', 0o600), err = fs.openSync(path.join(experiment, 'trash-host.stderr'), 'wx', 0o600);
    let host;
    try { host = spawn(helper, ['trash-experiment', experiment, path.join(folder, 'owned-process.json')], { env, stdio: ['ignore', out, err] }); }
    finally { fs.closeSync(out); fs.closeSync(err); }
    let ended = false;
    const exit = new Promise(resolve => { host.once('error', error => { ended = true; resolve({ error: error.message }); });
      host.once('exit', (exitCode, signal) => { ended = true; resolve({ exitCode, signal }); }); });
    async function waitRecord(name, ms = 30000) {
      const file = path.join(experiment, name), deadline = Date.now() + ms;
      while (!fs.existsSync(file)) {
        check(!ended, `trash-host-exited-before-${name}`); check(Date.now() < deadline, `trash-host-${name}-deadline`); await pause(100);
      }
      pin(file, 8192); return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    function barrier(name) { fs.writeFileSync(path.join(experiment, name), JSON.stringify({ ownedExperiment: true }), { flag: 'wx', mode: 0o600 }); }
    try {
      await waitRecord('review-cancel-ready.json');
      await native(['press-review', String(host.pid), String(process.pid), helperPin.sha256, 'cancel'], experiment, 'press-native-cancel');
      result.cancel = await waitRecord('cancelled.json');
      check(result.cancel.nativeCancel === true && isDeepStrictEqual(inventory(app, pkg), row.before)
        && isDeepStrictEqual(directoryInventory(app), result.beforeDirectories), 'native-cancel-bundle-drift');
      result.stdioAfterCancel = await stdio.list(); result.nativeCancel = true;
      result.referenceBeforeTrash = await stdio.reference();
      barrier('cancel-verified.json');
      await waitRecord('review-approve-ready.json');
      await native(['press-review', String(host.pid), String(process.pid), helperPin.sha256, 'approve'], experiment, 'press-native-approve');
      result.trashed = await waitRecord('01-trashed.json'); result.nativeApprove = result.trashed.nativeApproval === true;
      check(result.trashed.standardTrash === true && result.trashed.nativeTrashRelationship === 'contains'
        && typeof result.trashed.trashPath === 'string', 'native-standard-trash-result-unverified');
      trashApp = canonical(result.trashed.trashPath); result.trashApp = trashApp;
      result.standardTrash = true; report.retirementMutationAttempted = true;
      result.oldAppUrlAbsent = !fs.existsSync(app); check(result.oldAppUrlAbsent, 'old-app-url-remains');
      result.trashedMembers = inventory(trashApp, pkg); result.trashedDirectories = directoryInventory(trashApp);
      check(isDeepStrictEqual(result.trashedMembers, row.before) && isDeepStrictEqual(result.trashedDirectories, result.beforeDirectories), 'trashed-bundle-member-or-directory-identity-drift');
      result.bundleSignatureWhileTrashed = await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', trashApp], experiment, 'trashed-bundle-signature', 30000, true);
      result.registrationWhileTrashed = (await native(['registration', 'mcp'], experiment, 'trashed-registration')).receipt;
      result.oldUrlLaunchWhileTrashed = (await native(['trash-launch', experiment, 'old'], experiment, 'old-url-native-launch')).receipt;
      result.trashUrlLaunch = (await native(['trash-launch', experiment, 'trash'], experiment, 'trash-url-native-launch')).receipt;
      result.stdioWhileTrashed = await stdio.list();
      result.referenceWhileTrashed = await stdio.reference();
      result.oldPathReconnects = {};
      const oldServer = path.join(app, 'Contents/Resources/server');
      for (const alias of ['node', 'node.exe']) {
        result.oldPathReconnects[alias] = await oldPathReconnect(path.join(oldServer, 'runtime', alias), path.join(oldServer, 'creator-works-mcp.mjs'));
      }
      result.nativeTrashPolicyAccepted = result.bundleSignatureWhileTrashed.exitCode === 0
        && result.trashUrlLaunch.launchReturnedApplication === false && result.trashUrlLaunch.trashPolicyError === true
        && result.oldUrlLaunchWhileTrashed.launchReturnedApplication === false
        && result.trashUrlLaunch.runningLegacyGuiPIDsAfter?.length === 0;
    } catch (error) {
      result.error = error.message;
      throw error;
    } finally {
      if (!ended) barrier('restore-now.json');
      result.hostExit = await Promise.race([exit, pause(30000).then(() => ({ deadlineExpired: true }))]);
      if (result.hostExit.deadlineExpired) host.unref();
      if (result.standardTrash || fs.existsSync(path.join(experiment, '02-restored.json'))) {
        result.restoration = await waitRecord('02-restored.json', 1000);
        result.restored = result.restoration.restored === true && isDeepStrictEqual(inventory(app, pkg), row.before)
          && isDeepStrictEqual(directoryInventory(app), result.beforeDirectories) && (!trashApp || !fs.existsSync(trashApp));
        check(result.restored && result.hostExit.exitCode === 0 && !result.hostExit.signal, 'standard-trash-restoration-unverified');
        result.bundleSignatureRestored = await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], experiment, 'restored-bundle-signature');
        result.registrationRestored = (await native(['registration', 'mcp'], experiment, 'restored-registration')).receipt;
      } else {
        result.noMutationOriginalIntact = isDeepStrictEqual(inventory(app, pkg), row.before);
        check(result.noMutationOriginalIntact, 'no-archive-original-gui-drift');
      }
    }
    result.experimentPassed = result.nativeCancel && result.nativeApprove && result.standardTrash && result.restored && result.nativeTrashPolicyAccepted;
  }
  try {
    for (const product of ['setup', 'mcp']) {
      const pkg = packageFor(proof, product, process.arch), folder = path.join(output, product);
      fs.mkdirSync(folder, { mode: 0o700 });
      const row = { product, ...scope, package: { url: pkg.packageUrl, bytes: pkg.packageBytes, sha256: pkg.packageSha256 },
        facts: { exactBundle: false, bundleSignature: false, normalExit: false }, blockers: [] };
      report.products.push(row);
      const app = path.join(apps, `${pkg.name}.app`), dmg = path.join(folder, pkg.asset), mount = path.join(folder, 'volume');
      let mounted = false, gui = null, exitPromise, stdio = null;
      try {
        check(!fs.existsSync(app) && !fs.existsSync(path.join('/Applications', `${pkg.name}.app`)), 'existing-installation-refused');
        await execute('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '120',
          '--max-filesize', String(pkg.packageBytes), '--output', dmg, pkg.packageUrl], folder, 'download', 130000);
        const download = pin(dmg); check(download.bytes === pkg.packageBytes && download.sha256 === pkg.packageSha256, 'download-pin-mismatch');
        fs.mkdirSync(mount, { mode: 0o700 });
        await execute('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg], folder, 'mount', 30000);
        mounted = true;
        await execute('/usr/bin/ditto', [path.join(mount, `${pkg.name}.app`), app], folder, 'per-user-copy', 30000);
        row.before = inventory(app, pkg); row.facts.exactBundle = true;
        await execute('/usr/bin/hdiutil', ['detach', mount], folder, 'detach-before-native-launch', 30000); mounted = false;
        const info = await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', path.join(app, 'Contents/Info.plist')], folder, 'plist');
        const plist = JSON.parse(info.stdout);
        check(plist.CFBundleIdentifier === pkg.bundle && plist.CFBundleExecutable === pkg.exe
          && plist.CFBundleShortVersionString === pkg.version, 'native-plist-mismatch');
        await execute('/usr/bin/codesign', ['-dv', '--verbose=4', app], folder, 'signature-details', 15000, true);
        row.signature = await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], folder, 'bundle-signature', 30000, true);
        row.facts.bundleSignature = row.signature.exitCode === 0;
        await execute('/usr/bin/xattr', ['-lr', app], folder, 'unchanged-xattrs', 15000, true);
        row.gatekeeper = await execute('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app], folder, 'gatekeeper-assessment', 30000, true);
        await native(['registration', product], folder, 'registration-before', true);
        if (product === 'mcp') {
          const server = path.join(app, 'Contents/Resources/server'), config = path.join(folder, 'launcher-config.json');
          fs.writeFileSync(config, JSON.stringify({ channels: [], active_channel_id: null, mcp_server_path: path.join(server, 'creator-works-mcp.mjs'),
            auto_start: false, enable_custom_scripts: false, allow_all_tests: false, tool_groups: 'read', automatic_update_checks: false }), { flag: 'wx', mode: 0o600 });
          row.configBefore = pin(config);
          row.runtime = {};
          for (const alias of ['node', 'node.exe']) {
            const node = path.join(server, 'runtime', alias);
            row.runtime[alias] = { signature: await execute('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', node], folder, `signature-${alias}`, 15000, true),
              layout: await execute('/usr/bin/otool', ['-L', node], folder, `dependencies-${alias}`) };
            check(row.runtime[alias].signature.exitCode === 0, 'retained-node-signature-refused');
            row.runtime[alias].version = (await execute(node, ['--version'], folder, `version-${alias}`)).stdout.trim();
          }
          stdio = createStdio(path.join(server, 'runtime/node'), path.join(server, 'creator-works-mcp.mjs'), config, folder, 'original-live');
          row.stdioBefore = await stdio.start();
        }
        if (row.facts.bundleSignature) {
          const executable = path.join(app, 'Contents/MacOS', pkg.exe), image = pin(executable);
          const out = fs.openSync(path.join(folder, 'gui.stdout'), 'wx', 0o600), err = fs.openSync(path.join(folder, 'gui.stderr'), 'wx', 0o600);
          try { gui = spawn(executable, [], { env, stdio: ['ignore', out, err] }); }
          finally { fs.closeSync(out); fs.closeSync(err); }
          exitPromise = new Promise(resolve => { gui.once('error', error => resolve({ error: error.message })); gui.once('exit', (exitCode, signal) => resolve({ exitCode, signal })); });
          const deadline = Date.now() + 20000; let count = 0, observed;
          do {
            observed = await native(['inspect', product, String(gui.pid), String(process.pid), image.sha256], folder, `inspect-${++count}`, true);
            if (observed.exitCode === 0 && observed.receipt.ready === true) break;
            if (gui.exitCode !== null || gui.signalCode !== null) break;
            await pause(500);
          } while (Date.now() < deadline && count < 32);
          row.nativeObservation = observed.receipt;
          if (observed.exitCode === 0 && observed.receipt.ready === true) {
            const receiptPath = path.join(folder, 'owned-process.json');
            fs.writeFileSync(receiptPath, JSON.stringify(observed.receipt), { flag: 'wx', mode: 0o600 });
            row.close = (await native(['close', receiptPath], folder, 'native-normal-close', true)).receipt;
            const exit = await Promise.race([exitPromise, pause(10000).then(() => ({ deadlineExpired: true }))]);
            row.guiExit = exit;
            row.facts.normalExit = row.close.requestAccepted === true && exit.exitCode === 0 && !exit.signal;
          }
        }
        if (stdio) {
          row.stdioAfterNormalClose = await stdio.list();
          if (row.facts.normalExit) await trashExperiment(app, pkg, row, stdio, folder);
          const server = path.join(app, 'Contents/Resources/server');
          row.reconnect = {};
          for (const alias of ['node', 'node.exe']) {
            const connection = createStdio(path.join(server, 'runtime', alias), path.join(server, 'creator-works-mcp.mjs'), path.join(folder, 'launcher-config.json'), folder, `reconnect-${alias}`);
            try { row.reconnect[alias] = await connection.start(); }
            finally { row.reconnect[alias] = { ...row.reconnect[alias], exit: await connection.close() }; }
          }
          check(isDeepStrictEqual(pin(path.join(folder, 'launcher-config.json')), row.configBefore), 'isolated-config-changed');
          row.isolatedServerConfigPreserved = true;
        }
        row.after = inventory(app, pkg);
        check(isDeepStrictEqual(row.after, row.before), 'original-bundle-or-runtime-file-drift');
        row.exactOriginalMembersPreserved = true;
        if (!row.trashExperiment?.experimentPassed) row.blockers.push(missingContract(row.facts));
      } catch (error) { row.blockers.push(error.message); }
      finally {
        if (stdio) { try { row.stdioEofExit = await stdio.close(); } catch (error) { row.blockers.push(error.message); } }
        if (gui && gui.exitCode === null && gui.signalCode === null) {
          gui.unref(); row.guiLifetimeUncertain = true; row.blockers.push('owned-old-gui-still-running-no-force-stop');
        }
        if (mounted) { try { await execute('/usr/bin/hdiutil', ['detach', mount], folder, 'detach-readonly-volume', 30000); } catch (error) { row.blockers.push(error.message); } }
        fs.writeFileSync(path.join(folder, 'report.json'), JSON.stringify(row, null, 2), { flag: 'wx', mode: 0o600 });
      }
    }
    report.captureComplete = report.products.length === 2;
  } catch (error) { report.error = error.message; }
  report.experimentPassed = report.products.find(row => row.product === 'mcp')?.trashExperiment?.experimentPassed === true;
  report.passed = report.experimentPassed && report.products.every(row => row.facts.normalExit && row.exactOriginalMembersPreserved);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ ...scope, captureComplete: report.captureComplete === true,
    products: report.products.map(({ product, facts, blockers }) => ({ product, facts, blockers })) }));
  process.exitCode = report.passed ? 0 : 1; // A measured/restored experiment is not production acceptance.
}
module.exports = { admission, packageFor, inventory, pin, missingContract, scope, products, branch };
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
