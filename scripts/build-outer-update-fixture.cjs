// Disposable build input for outgoing-view acceptance, never a release builder.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { capture } = require('./sign-unix-payload.cjs');
const { moduleFiles, verifyStage } = require('./build-unified.cjs');
const routing = require('./managed-router-package.cjs');
const { runtimeDescriptor } = require('./mcp-runtime-descriptor.cjs');
const { verifyBundleMarker, extract } = require('./installer-payload.cjs');
const { applications, updaterManifest } = require('./release-descriptor.cjs');

const ROOT = path.resolve(__dirname, '..');
const FROM = '0.1.14', TO = '0.1.15', META = 128 * 1024, MAX = 512 * 1024 * 1024;
const VERSION_SOURCE_LIMIT = 1024 * 1024;
const VERSIONS = ['package.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'];
const BASELINE = Object.freeze({
  directory: 'artifacts/unified/unified-014-repeat-20261014-03',
  commit: 'a914bb96abaca8837f586c25c341d24fe58fe73d', tree: '041a2dc95abbd99dc4619df8c033132275789fd7',
  hashes: {
    'builtin-manifest.json': '2dff1bf72723703afb8e0fd66e17b4af3b6510675c042bc9a4fb08f75f6c9464',
    'creator-hub.exe': 'a7ca6d37711eeb937d8c018e7971ccf10708c64f5c69436b40ace4ad3c920dff',
    'installer.exe': 'edc47ecca5e80ce950d5b8ecf6bb32c46fa531e163b9d6ab7722b143a02a4e7a',
    'installer-extracted/creator-hub.exe': 'dd74917a67e360a479158d81149a385ad813da9213661959928543a8f366dfca',
    'installer-checksum.json': '6711ec4b70df554bb79f3f47de5f2290dfde5605b8aa7a33e16f01602a87ca94',
    'mcp-runtime.json': '68e32d4c1afe42e66756dbbecd9306c41442584780bf3e1f41355d8b6f1b0d19',
    'modules/routing/router.json.sig': 'fe26177fba3a4168972e6da65238b178a19935a2c6617a70d2fe033969d58b84',
    'modules/routing/runtime.json.sig': '846ca909afbdc85f30785c1ec5f1ccb8688504edfddcc2b2bf23dda1ec321e83',
  },
});
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const allFiles = manifest => ({ ...manifest.modules.mcp.files, ...manifest.modules.setup.files, ...manifest.managedRouting.files });
function absolute(file) {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file, 'Canonical absolute path required');
  for (let entry = file;; entry = path.dirname(entry)) {
    try { assert.equal(fs.lstatSync(entry).isSymbolicLink(), false, 'Redirected fixture refused'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(entry) === entry) break;
  }
}
function unchanged(file, record, tool = false) { assert.deepEqual(capture(file, record.size, tool), record, 'Frozen bytes changed'); }
function bytes(file, max = META) {
  const record = capture(file, max), body = fs.readFileSync(file);
  assert.equal(hash(body), record.sha256); return body;
}
function copy(file, dest, record, cargoOutput = false) {
  unchanged(file, record, cargoOutput); absolute(dest); fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL); unchanged(dest, record); unchanged(file, record, cargoOutput);
}
function inventory(root, expected) {
  const found = [];
  function walk(dir, prefix = '') {
    absolute(dir);
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + item.name, file = path.join(dir, item.name);
      absolute(file);
      if (item.isDirectory()) walk(file, `${name}/`);
      else { assert.ok(item.isFile() && expected.includes(name), 'Unlisted fixture file'); found.push(name); }
    }
  }
  walk(root); assert.deepEqual(found.sort(), [...expected].sort(), 'Incomplete fixture');
}
function bumpRootVersion(name, body) {
  const original = body.toString('utf8');
  let pattern;
  if (name.endsWith('.json')) {
    const value = JSON.parse(original); assert.equal(value.version, FROM);
    pattern = /("version"\s*:\s*")0\.1\.14(")/g;
  } else {
    assert.ok(VERSIONS.includes(name));
    pattern = name.endsWith('Cargo.lock')
      ? /(\[\[package\]\]\r?\nname = "creator-hub"\r?\nversion = ")0\.1\.14("\r?\n)/g
      : /(\[package\]\r?\nname = "creator-hub"\r?\nversion = ")0\.1\.14("\r?\n)/g;
  }
  assert.equal([...original.matchAll(pattern)].length, 1, 'Unknown or ambiguous root version layout');
  const changed = original.replace(pattern, `$1${TO}$2`);
  if (name.endsWith('.json')) assert.deepEqual(JSON.parse(changed), { ...JSON.parse(original), version: TO });
  return Buffer.from(changed);
}
function sourceEntries(tree) {
  const result = {};
  for (const line of tree.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
    assert.ok(match && /^[A-Za-z0-9_./ @-]+$/.test(match[3]) && !match[3].startsWith('/')
      && !match[3].split('/').some(p => ['', '.', '..'].includes(p)), 'Unsupported source tree member');
    assert.equal(Object.hasOwn(result, match[3]), false); result[match[3]] = match[2];
  }
  assert.ok(Object.keys(result).length > 0 && Object.keys(result).length <= 12000, 'Source tree bound exceeded');
  for (const name of VERSIONS) assert.ok(result[name], 'Root version source missing');
  return result;
}
function checkSource(root, entries, changed = {}) {
  let total = 0;
  for (const [name, expected] of Object.entries(entries)) {
    const body = bytes(path.join(root, name), 256 * 1024 * 1024); total += body.length;
    assert.ok(total <= MAX, 'Source clone bound exceeded');
    if (changed[name]) assert.equal(hash(body), changed[name].sha256, 'Fixture root version drift');
    else assert.equal(crypto.createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex'), expected, 'Export differs from pinned Git source');
  }
}
function compileEnvironment(env, descriptor, target) {
  const clean = Object.fromEntries(Object.entries(env).filter(([name]) => !/(SIGNING|PRIVATE_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/i.test(name)
    && !/^(NODE_OPTIONS|RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CREATOR_|TAURI_|CARGO_TARGET_DIR)/i.test(name)));
  return { ...clean, CREATOR_BUILTIN_MANIFEST: descriptor, CARGO_TARGET_DIR: target,
    CREATOR_MCP_HOST_WRITABLE: '1', CREATOR_MCP_HOST_READONLY_EVENTS: '1' };
}
function buildFixture(label, services = {}) {
  const root = services.root || ROOT, env = services.env || process.env;
  const execute = services.execute || execFileSync, approved = services.signer || routing;
  const baseline = services.baseline || BASELINE;
  assert.equal(services.platform || process.platform, 'win32', 'Native Windows builder required');
  assert.equal(services.arch || process.arch, 'x64', 'Native x64 builder required');
  assert.equal(env.CREATOR_OUTER_UPDATE_FIXTURE, '1', 'Explicit acceptance-only build opt-in required');
  assert.match(label || '', /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/);
  absolute(root);
  const input = path.join(root, baseline.directory), output = path.join(root, 'artifacts/outer-update-fixture', label);
  absolute(input); absolute(output); assert.equal(fs.existsSync(output), false, 'Fixture output is immutable');
  const canonicalVersions = Object.fromEntries(VERSIONS.map(name => [name, capture(path.join(root, name), VERSION_SOURCE_LIMIT)]));
  const original = Object.fromEntries(Object.entries(baseline.hashes).map(([name, sha256]) => {
    const record = capture(path.join(input, name), name.endsWith('.exe') ? MAX : META);
    assert.equal(record.sha256, sha256, 'Pinned reviewed 14 baseline differs'); return [name, record];
  }));
  const manifest = JSON.parse(bytes(path.join(input, 'builtin-manifest.json')));
  assert.deepEqual(Object.keys(manifest).sort(), ['arch', 'managedRouting', 'modules', 'platform', 'schemaVersion']);
  assert.equal(manifest.platform, 'windows'); assert.equal(manifest.arch, 'x86_64');
  assert.equal(manifest.modules.mcp.version, '2.7.7'); assert.equal(manifest.modules.setup.version, '0.3.7');
  verifyStage(path.join(input, 'modules'), manifest);
  const producerSidecars = ['routing/router.json.sig', 'routing/runtime.json.sig'];
  inventory(path.join(input, 'modules'), [...Object.keys(allFiles(manifest)), ...producerSidecars]);
  for (const name of ['router', 'runtime']) {
    const encoded = bytes(path.join(input, `modules/routing/${name}.json.sig`), 4096).toString('utf8').trim();
    const decoded = Buffer.from(encoded, 'base64');
    assert.equal(decoded.toString('base64'), encoded, 'Noncanonical producer signature');
    assert.deepEqual(decoded, bytes(path.join(input, `modules/routing/${name}.minisig`), 4096), 'Producer signature differs from verified package signature');
  }
  const privateNames = [...moduleFiles('mcp', 'windows'), ...moduleFiles('setup', 'windows'), routing.routeFiles('windows')[0]];
  const privateFiles = Object.fromEntries(privateNames.map(name => [name, capture(path.join(input, 'modules', name), MAX)]));
  const boundFiles = Object.fromEntries(Object.keys(allFiles(manifest)).map(name => [name, capture(path.join(input, 'modules', name), MAX)]));
  for (const [name, record] of Object.entries(boundFiles)) assert.equal(record.sha256, allFiles(manifest)[name]);
  verifyStage(path.join(input, 'installer-extracted/modules'), manifest);
  inventory(path.join(input, 'installer-extracted/modules'), Object.keys(boundFiles));
  verifyBundleMarker(bytes(path.join(input, 'creator-hub.exe'), MAX), bytes(path.join(input, 'installer-extracted/creator-hub.exe'), MAX));
  assert.deepEqual(bytes(path.join(input, 'installer-extracted/$PLUGINSDIR/creator-hub-preflight.exe'), MAX), bytes(path.join(input, 'installer-extracted/creator-hub.exe'), MAX));
  assert.deepEqual(JSON.parse(bytes(path.join(input, 'installer-checksum.json'))), { version: FROM,
    sha256: original['installer.exe'].sha256, installedExecutableSha256: original['installer-extracted/creator-hub.exe'].sha256, signed: false, acceptanceOnly: true });
  assert.deepEqual(JSON.parse(bytes(path.join(input, 'mcp-runtime.json'))), runtimeDescriptor(manifest, FROM));
  assert.deepEqual(bytes(path.join(input, 'mcp-runtime.json')), bytes(path.join(input, 'modules/routing/runtime.json')));
  const tools = Object.fromEntries(['verify-package-input', 'verify-managed-runtime', 'verify-release'].map(name => {
    const file = path.join(root, 'src-tauri/target/release/examples', `${name}.exe`);
    return [name, { file, record: capture(file, 256 * 1024 * 1024, true) }];
  }));
  function recheck() {
    for (const [name, record] of Object.entries(original)) unchanged(path.join(input, name), record);
    for (const [name, record] of Object.entries(boundFiles)) unchanged(path.join(input, 'modules', name), record);
    for (const [name, record] of Object.entries(canonicalVersions)) unchanged(path.join(root, name), record);
    for (const tool of Object.values(tools)) unchanged(tool.file, tool.record, true);
  }
  function run(command, args, options = {}) {
    recheck();
    const result = execute(command, args, { cwd: root, env: compileEnvironment(env, '', ''), encoding: 'utf8', windowsHide: true,
      timeout: 120000, maxBuffer: 2 * 1024 * 1024, ...options });
    recheck(); return String(result).trim();
  }
  function signature(file, sig) {
    const body = capture(file, META), signed = capture(sig, 4096);
    assert.equal(run(tools['verify-package-input'].file, [file, sig]), `Verified trusted package signature: ${body.sha256}. No activation or client changes.`);
    unchanged(file, body); unchanged(sig, signed);
  }
  for (const name of ['router', 'runtime']) signature(path.join(input, `modules/routing/${name}.json`), path.join(input, `modules/routing/${name}.minisig`));
  assert.equal(run(tools['verify-managed-runtime'].file, [input, FROM]), `Verified managed runtime ${FROM}: trusted signature, exact payload and tamper refusal. No activation or client changes.`);
  assert.equal(run('git', ['rev-parse', `${baseline.commit}^{commit}`]), baseline.commit);
  assert.equal(run('git', ['rev-parse', `${baseline.commit}^{tree}`]), baseline.tree);
  const entries = sourceEntries(run('git', ['ls-tree', '-rz', '--full-tree', baseline.commit]));
  let phase = 'source-export';
  fs.mkdirSync(output, { recursive: true });
  try {
    const source = path.join(output, 'source'), archive = path.join(output, 'source.tar');
    fs.mkdirSync(source);
    run('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', `--output=${archive}`, baseline.commit]); capture(archive, MAX);
    run('tar.exe', ['-xf', archive, '-C', source]);
    inventory(source, Object.keys(entries)); checkSource(source, entries);
    const changes = {};
    for (const name of VERSIONS) {
      const file = path.join(source, name); fs.writeFileSync(file, bumpRootVersion(name, bytes(file, VERSION_SOURCE_LIMIT)));
      changes[name] = capture(file, VERSION_SOURCE_LIMIT);
    }
    checkSource(source, entries, changes);
    const payload = path.join(output, 'payload'); fs.mkdirSync(payload);
    const finalManifest = { schemaVersion: 1, platform: 'windows', arch: 'x86_64', modules: structuredClone(manifest.modules) };
    for (const name of privateNames.filter(n => !n.startsWith('routing/'))) copy(path.join(input, 'modules', name), path.join(payload, 'modules', name), privateFiles[name]);
    const runtimeFile = path.join(payload, 'mcp-runtime.json');
    const runtimeBody = Buffer.from(JSON.stringify(runtimeDescriptor(finalManifest, TO)));
    fs.writeFileSync(runtimeFile, runtimeBody, { flag: 'wx' });
    const routerBody = Buffer.from(JSON.stringify({ schemaVersion: 1, product: 'com.creatorworks.hub.mcp-router',
      platform: 'windows', arch: 'x86_64', protocol: 1, sha256: privateFiles[privateNames.at(-1)].sha256 }));
    const authorized = new Map([[path.join(payload, 'modules/routing/router.json'), { sha256: hash(routerBody), size: routerBody.length }],
      [path.join(payload, 'modules/routing/runtime.json'), { sha256: hash(runtimeBody), size: runtimeBody.length }]]);
    const signedDir = path.join(output, 'signed'); fs.mkdirSync(signedDir);
    let sequence = 0;
    phase = 'routing-sign'; recheck(); checkSource(source, entries, changes);
    const key = approved.signingKey(root);
    function sign(file) {
      assert.ok(authorized.has(file), 'Only exact fixture bodies may be signed'); recheck();
      const record = authorized.get(file); unchanged(file, record);
      const scratch = path.join(output, `signing-input-${sequence++}${path.extname(file)}`); copy(file, scratch, record);
      const sig = approved.signDetached(scratch, key);
      assert.ok(Buffer.isBuffer(sig) && sig.length > 0 && sig.length <= 4096 && sig.toString('utf8').startsWith('untrusted comment:'), 'Bounded minisig required');
      unchanged(file, record); unchanged(scratch, record); recheck(); return sig;
    }
    finalManifest.managedRouting = routing.prepare(payload, finalManifest, path.join(input, 'modules', privateNames.at(-1)), runtimeFile, sign);
    verifyStage(path.join(payload, 'modules'), finalManifest);
    for (const [name, record] of Object.entries(privateFiles)) unchanged(path.join(payload, 'modules', name), record);
    for (const name of ['router', 'runtime']) signature(path.join(payload, `modules/routing/${name}.json`), path.join(payload, `modules/routing/${name}.minisig`));
    assert.equal(run(tools['verify-managed-runtime'].file, [payload, TO]), `Verified managed runtime ${TO}: trusted signature, exact payload and tamper refusal. No activation or client changes.`);
    const descriptor = path.join(payload, 'builtin-manifest.json'), manifestBody = Buffer.from(JSON.stringify(finalManifest, null, 2));
    fs.writeFileSync(descriptor, manifestBody, { flag: 'wx' });
    const descriptorRecord = capture(descriptor, META);
    const overlay = path.join(output, 'tauri-outer-fixture.json');
    fs.writeFileSync(overlay, JSON.stringify({ bundle: { resources: Object.fromEntries(Object.keys(allFiles(finalManifest))
      .map(n => [path.join(payload, 'modules', n), `modules/${n}`])) } }), { flag: 'wx' });
    const buildEnv = compileEnvironment(env, descriptor, path.join(output, 'hub-target'));
    phase = 'outer-hub-build';
    run(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--bundles', 'nsis', '--config', overlay, '--', '--locked'],
      { cwd: source, env: buildEnv, timeout: 1800000, maxBuffer: 4 * 1024 * 1024 });
    checkSource(source, entries, changes); unchanged(descriptor, descriptorRecord);
    verifyStage(path.join(payload, 'modules'), finalManifest); inventory(path.join(payload, 'modules'), Object.keys(allFiles(finalManifest)));
    for (const [name, record] of Object.entries(privateFiles)) unchanged(path.join(payload, 'modules', name), record);
    const release = path.join(buildEnv.CARGO_TARGET_DIR, 'release');
    const cargoHub = path.join(release, 'creator-hub.exe'), rawHub = path.join(output, 'raw-creator-hub.exe');
    copy(cargoHub, rawHub, capture(cargoHub, MAX, true), true);
    assert.ok(bytes(rawHub, MAX).includes(manifestBody), 'Hub does not embed the exact 15-file resource authority');
    const versionScript = `[Diagnostics.FileVersionInfo]::GetVersionInfo('${rawHub.replaceAll("'", "''")}').ProductVersion`;
    assert.equal(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', versionScript]), TO, 'Built Hub PE version differs');
    const bundle = path.join(release, 'bundle/nsis');
    const installers = fs.readdirSync(bundle).filter(n => n.endsWith(`_${TO}_x64-setup.exe`));
    assert.equal(installers.length, 1, 'One exact 0.1.15 NSIS required');
    const asset = 'Creator_Hub_0.1.15_x64-acceptance-only-setup.exe', installer = path.join(signedDir, asset);
    copy(path.join(bundle, installers[0]), installer, capture(path.join(bundle, installers[0]), MAX));
    phase = 'installer-extraction';
    const installed = (services.extract || extract)(installer, path.join(output, 'installer-extracted'), rawHub, finalManifest);
    verifyBundleMarker(bytes(rawHub, MAX), bytes(installed, MAX));
    inventory(path.join(output, 'installer-extracted/modules'), Object.keys(allFiles(finalManifest)));
    verifyStage(path.join(output, 'installer-extracted/modules'), finalManifest);
    assert.ok(bytes(installed, MAX).includes(manifestBody), 'Installed Hub lost compiled resource authority');
    assert.deepEqual(bytes(path.join(output, 'installer-extracted/$PLUGINSDIR/creator-hub-preflight.exe'), MAX), bytes(installed, MAX));
    const installerRecord = capture(installer, MAX), installedRecord = capture(installed, MAX);
    const releaseDescriptor = { schemaVersion: 1, appId: 'creator-hub', version: TO, platform: 'windows', architecture: 'x86_64',
      packageType: 'nsis', assetName: asset, byteLength: installerRecord.size, sha256: installerRecord.sha256,
      executableSha256: installedRecord.sha256, identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1, minHubVersion: FROM };
    const metadata = path.join(signedDir, 'creator-hub-windows-x86_64.json'), body = Buffer.from(JSON.stringify(releaseDescriptor, null, 2));
    fs.writeFileSync(metadata, body, { flag: 'wx' }); authorized.set(metadata, { sha256: hash(body), size: body.length });
    authorized.set(installer, installerRecord);
    phase = 'updater-sign';
    fs.writeFileSync(`${metadata}.minisig`, sign(metadata), { flag: 'wx' });
    signature(metadata, `${metadata}.minisig`);
    const installerSignature = sign(installer);
    fs.writeFileSync(path.join(signedDir, 'latest.json'), JSON.stringify(updaterManifest(applications.hub, TO, asset, installerSignature.toString('base64')), null, 2), { flag: 'wx' });
    phase = 'final-readback';
    assert.equal(run(tools['verify-release'].file, ['creator-hub', signedDir, installer, installed]), `Verified creator-hub ${TO}: descriptor, installer, installed executable and tamper rejection.`);
    checkSource(source, entries, changes); unchanged(descriptor, descriptorRecord);
    unchanged(installer, installerRecord); unchanged(installed, installedRecord);
    verifyStage(path.join(payload, 'modules'), finalManifest); verifyStage(path.join(output, 'installer-extracted/modules'), finalManifest);
    for (const [name, record] of Object.entries(privateFiles)) unchanged(path.join(payload, 'modules', name), record);
    inventory(signedDir, [asset, 'creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig', 'latest.json']); recheck();
    const receipt = { schemaVersion: 1, kind: 'outgoing-unified-14-outer-only-15-acceptance-fixture', acceptanceOnly: true,
      baseline: { version: FROM, sourceCommit: baseline.commit, sourceTree: baseline.tree, files: original }, targetVersion: TO,
      modifiedSourceFiles: VERSIONS, privateFiles, builtinManifest: finalManifest,
      pins: { descriptor: hash(body), descriptorSignature: capture(`${metadata}.minisig`, 4096).sha256,
        installer: installerRecord.sha256, executable: installedRecord.sha256, manifest: capture(path.join(signedDir, 'latest.json'), META).sha256 },
      privateModulesRecompiled: false, privateModulesResigned: false, privateKeyIncluded: false,
      outgoingNativeUpdateTested: false, viewsRestored: false, releaseReady: false };
    fs.writeFileSync(path.join(output, 'fixture-receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
    return { output, signedDirectory: signedDir, ...receipt };
  } catch { throw Error(`Acceptance fixture failed at ${phase}. Partial owned evidence retained; no update/restoration acceptance established.`); }
}
module.exports = { BASELINE, VERSIONS, FROM, TO, bumpRootVersion, sourceEntries, compileEnvironment, buildFixture };
if (require.main === module) {
  try {
    assert.equal(process.argv.length, 4, 'Use LABEL --acceptance-only with CREATOR_OUTER_UPDATE_FIXTURE=1');
    assert.equal(process.argv[3], '--acceptance-only', 'Acceptance-only flag required');
    const result = buildFixture(process.argv[2]);
    console.log(JSON.stringify({ output: result.output, signedDirectory: result.signedDirectory, pins: result.pins,
      outgoingNativeUpdateTested: false, viewsRestored: false, releaseReady: false }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
