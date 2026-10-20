'use strict';
// Private target producer only. It consumes signatures; it never selects a key or installs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fixture = require('./private-linux-update-fixture-017.cjs');
const metadata = require('./private-linux-update-fixture-017-metadata.cjs');
const original = require('./assemble-unix-payload.cjs');
const builder = require('./build-unified.cjs');
const retirement = require('./linux-retirement-package.cjs');
const unix = require('./unix-package-payload.cjs');
const archive = require('./module-archive.cjs');
const finite = require('./flatpak-package.cjs');
const { capture } = require('./sign-unix-payload.cjs');

const VERIFIER = 'scripts/private-linux-update-fixture-017-package-verify.py';
const SOURCE_PATHS = [...new Set([...builder.PRODUCTION_SOURCE_PATHS, ...builder.PORTABLE_SOURCE_PATHS,
  'scripts/assemble-unix-payload.cjs', 'scripts/unix-payload-binding.cjs', 'scripts/module-archive.cjs',
  'scripts/mcp-runtime-descriptor.cjs', 'scripts/unix-package-payload.cjs', 'scripts/native-linux-016-input.cjs',
  'scripts/sign-unix-payload.cjs', 'scripts/collect-unix-payload-binding.cjs', 'scripts/managed-router-package.cjs',
  'scripts/flatpak-package.cjs', 'scripts/flatpak-native-activation.cjs',
  'native/flatpak-native-activation/com.creatorworks.hub.Host.service', 'native/module-archive', 'native/unix-transfer',
  'scripts/private-linux-update-fixture-017.cjs', 'scripts/private-linux-update-fixture-017-metadata.cjs',
  'scripts/private-linux-update-fixture-017-assemble.cjs', VERIFIER])];
function canonical(file, exists = true) {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file, 'Canonical absolute path required');
  for (let current = file;; current = path.dirname(current)) {
    try { assert.equal(fs.lstatSync(current).isSymbolicLink(), false, 'Redirected path refused'); }
    catch (error) { if (error.code !== 'ENOENT' || exists && current === file) throw error; }
    if (path.dirname(current) === current) break;
  }
}
function inside(file, parent) {
  canonical(parent, false); canonical(file, false);
  const relative = path.relative(parent, file);
  assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`), 'Owned fresh staging path required');
}
function sourceCheck(root, plan, env, execute) {
  const git = args => String(execute('git', args, { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })).trim();
  assert.equal(git(['rev-parse', 'HEAD']), env.GITHUB_SHA);
  assert.equal(plan.rootSource.sourceCommit, env.GITHUB_SHA);
  assert.equal(git(['rev-parse', 'HEAD^{tree}']), plan.rootSource.sourceTree);
  git(['diff', '--exit-code', 'HEAD', '--', ...SOURCE_PATHS]);
  assert.equal(git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...SOURCE_PATHS]), '', 'Private017 build source changed or acquired untracked input');
}
function write(file, bytes) {
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
}
function overlay(output, resources, staged) {
  metadata.keys(staged, [retirement.HELPER, retirement.POLICY]);
  const config = { build: { features: [...fixture.FEATURES] }, bundle: { targets: ['deb'], shortDescription: 'Creator Hub',
    longDescription: 'Manage projects, connect AI tools to Unity and set up Creator SDK projects.', resources,
    linux: { deb: { depends: ['policykit-1'], files: staged } } } };
  const file = path.join(output, 'tauri-private017.json');
  write(file, JSON.stringify(config, null, 2));
  builder.stageIntegrationService(output, file);
  return file;
}
function compileCommand(root, overlayFile) {
  const args = fixture.compileArguments(); fixture.validateCompileArguments(args);
  return [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', ...args, '--target', 'x86_64-unknown-linux-gnu',
    '--bundles', 'deb', '--config', overlayFile, '--', '--locked'];
}
function inputs(input, planSha256) {
  canonical(input); assert.match(planSha256, /^[a-f0-9]{64}$/);
  original.inventory(input, metadata.INPUTS);
  const files = Object.fromEntries(metadata.INPUTS.map(name => [name, path.join(input, name)]));
  const limit = name => name === 'baseline016.zip' ? 768 * 1024 * 1024 : name === 'modules.tar.gz' ? 256 * 1024 * 1024
    : name.endsWith('.minisig') ? 4096 : 128 * 1024;
  const records = Object.fromEntries(metadata.INPUTS.map(name => [name, capture(files[name], limit(name))]));
  assert.equal(records['plan.json'].sha256, planSha256, 'Independent plan pin differs');
  const bytes = name => fs.readFileSync(files[name]);
  const plan = metadata.validatePlan(metadata.parse(bytes('plan.json')));
  const oldRecords = Object.fromEntries(original.INPUTS.map(name => [name, records[name]]));
  const handoff = metadata.parse(bytes('handoff.json')), prepared = metadata.parse(bytes('prepared-unix.json'));
  metadata.validateOriginal(plan, handoff, prepared, oldRecords);
  metadata.validateApi(plan, metadata.parse(bytes('baseline016-api.json')), metadata.parse(bytes('root017-api.json')));
  assert.deepEqual(records['baseline016.zip'], { size: plan.baseline016.assembly.zipBytes, sha256: plan.baseline016.assembly.zipSha256 });
  const runtime = bytes('runtime017.json'), signature = bytes('runtime017.minisig');
  const manifest = metadata.validateDerivation(bytes('derivation017.json'), plan, handoff, prepared, oldRecords, runtime, signature);
  assert.deepEqual(metadata.parse(bytes('routing/runtime.json'), false), require('./mcp-runtime-descriptor.cjs').runtimeDescriptor(manifest, '0.1.16'));
  assert.deepEqual(metadata.parse(bytes('routing/router.json'), false), { schemaVersion: 1, product: 'com.creatorworks.hub.mcp-router',
    platform: 'linux', arch: 'x86_64', protocol: 1, sha256: prepared.files['router-for-package'].sha256 });
  return { files, records, plan, handoff, prepared, manifest,
    recheck() { for (const name of metadata.INPUTS) assert.deepEqual(capture(files[name], limit(name)), records[name], 'Immutable derivation input changed'); } };
}
function build({ root, input, output, planSha256 }, services = {}) {
  const env = services.env || process.env, execute = services.execute || execFileSync;
  fixture.context('linux', 'x86_64', env);
  assert.equal(process.platform, 'linux', 'Actual native Linux process required');
  assert.equal(process.arch, 'x64', 'Actual native x86_64 process required');
  canonical(root); canonical(input); inside(input, fs.realpathSync(env.RUNNER_TEMP));
  inside(output, path.join(root, 'artifacts/unified'));
  assert.equal(fs.existsSync(output), false, 'Private017 output is immutable');
  const admitted = original.admission(root, 'linux', 'x86_64', env, execute);
  assert.equal(admitted.profile, fixture.PROFILE);
  const accepted = inputs(input, planSha256), { plan, manifest } = accepted;
  assert.equal(admitted.handoffSha256, plan.original016['handoff.json'].sha256);
  sourceCheck(root, plan, env, execute);
  const run = (command, args, options = {}) => {
    accepted.recheck();
    const value = execute(command, args, { cwd: root, env, encoding: 'utf8', timeout: 600000, maxBuffer: 1024 * 1024, windowsHide: true, ...options });
    accepted.recheck(); return String(value ?? '').trim();
  };
  original.verifyPrivateSource(accepted.handoff.source.sourceCommit, run);
  const tools = original.verificationTools(root);
  run('cargo', tools.verifierArgs); run('cargo', tools.transferArgs);
  metadata.verifySignatures(accepted.files, accepted.records, tools.verifier, run);
  const transfer = original.TRANSFER.map(name => accepted.files[name]);
  const message = 'Unsigned transfer checked. No payload execution, signing, activation or release acceptance.';
  assert.equal(run(tools.transfer, ['verify', ...transfer]), message);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output, { mode: 0o700 });
  const old = path.join(output, 'original016');
  assert.equal(run(tools.transfer, ['extract', ...transfer, old]), message);
  for (const [name, expected] of Object.entries(accepted.prepared.files)) {
    const file = path.join(old, name); canonical(file);
    assert.deepEqual(capture(file, expected.size), { size: expected.size, sha256: expected.sha256 });
    assert.equal(fs.statSync(file).mode & 0o7777, expected.mode);
  }
  const baselineExpected = { zip: accepted.records['baseline016.zip'], files: Object.fromEntries(Object.keys(metadata.BASELINE_MEMBERS)
    .map(name => [name, plan.baseline016.pins[name]])) };
  const baselineExpectedFile = path.join(output, 'baseline-zip-expected.json'); write(baselineExpectedFile, JSON.stringify(baselineExpected));
  const baselineDirectory = path.join(output, 'baseline016');
  const checker = path.join(root, VERIFIER);
  const staged = JSON.parse(run('/usr/bin/python3', [checker, '--stage-baseline', accepted.files['baseline016.zip'], baselineExpectedFile, baselineDirectory]));
  assert.equal(staged.releaseReady, false); assert.deepEqual(staged.files, baselineExpected.files);
  const baselineBytes = Object.fromEntries(Object.entries(metadata.BASELINE_MEMBERS).map(([name, member]) =>
    [name, fs.readFileSync(path.join(baselineDirectory, name === 'deb' ? 'baseline016.deb' : path.posix.basename(member)))]));
  const baseline = metadata.validateBaseline(plan, baselineBytes, accepted.handoff);
  const baselineDeb = path.join(baselineDirectory, 'baseline016.deb');
  const baselinePins = Object.fromEntries(['deb', 'hub', 'helper', 'policy', 'service'].map(name => [name, plan.baseline016.pins[name]]));
  const baselinePinsFile = path.join(output, 'baseline-package-expected.json'); write(baselinePinsFile, JSON.stringify(baselinePins));
  const inspected = JSON.parse(run('/usr/bin/python3', [checker, '--inspect-baseline', baselineDeb, baselinePinsFile]));
  assert.equal(inspected.releaseReady, false);
  assert.equal(inspected.files['usr/lib/Creator Hub/modules.tar.gz'].sha256, baseline.manifest.payloadArchive.sha256);
  const baselineRoot = path.join(output, 'baseline-package'); fs.mkdirSync(baselineRoot);
  run('/usr/bin/dpkg-deb', ['--extract', baselineDeb, baselineRoot]);
  unix.verifyLinuxHub(baselineBytes.rawHub, fs.readFileSync(path.join(baselineRoot, 'usr/bin/creator-hub')), 'deb');
  const privateFiles = { ...manifest.modules.mcp.files, ...manifest.modules.setup.files };
  function copy(source, name, expected, mode) {
    canonical(source); assert.equal(capture(source, 256 * 1024 * 1024).sha256, expected);
    const destination = path.join(output, 'modules', name); fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL); fs.chmodSync(destination, mode);
    assert.equal(capture(destination, 256 * 1024 * 1024).sha256, expected);
  }
  for (const [name, hash] of Object.entries(privateFiles)) copy(path.join(old, 'modules', name), name, hash, accepted.handoff.payloadFiles[name].mode);
  for (const name of Object.keys(manifest.managedRouting.files)) {
    const source = name.endsWith('/creator-hub-mcp-router') ? path.join(old, 'router-for-package')
      : accepted.files[name === 'routing/runtime.json' ? 'runtime017.json' : name === 'routing/runtime.minisig' ? 'runtime017.minisig' : name];
    copy(source, name, manifest.managedRouting.files[name], name.endsWith('/creator-hub-mcp-router') ? 0o755 : 0o644);
  }
  builder.verifyStage(path.join(output, 'modules'), manifest);
  builder.stageIntegratedMcpResources(root, output, manifest);
  const decoderTarget = path.join(output, 'decoder-target');
  run('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(root, 'native/module-archive/Cargo.toml'), '--target-dir', decoderTarget], { stdio: 'inherit' });
  const decoder = path.join(decoderTarget, 'release/creator-hub-module-archive'), archiveFile = path.join(output, archive.FILE);
  manifest.payloadArchive = archive.create(path.join(output, 'modules'), manifest, archiveFile);
  archive.verify(archiveFile, manifest, decoder);
  const descriptor = path.join(output, 'builtin-manifest.json'); write(descriptor, JSON.stringify(manifest, null, 2));
  const helperDirectory = path.join(output, 'linux-retirement'); fs.mkdirSync(helperDirectory);
  const helperFiles = {};
  for (const [name, key, mode] of [[retirement.HELPER, 'helper', 0o755], [retirement.POLICY, 'policy', 0o644]]) {
    const source = path.join(baselineRoot, name.slice(1)); canonical(source);
    assert.deepEqual(capture(source, 32 * 1024 * 1024), plan.baseline016.pins[key]);
    const file = path.join(helperDirectory, path.posix.basename(name)); fs.copyFileSync(source, file, fs.constants.COPYFILE_EXCL); fs.chmodSync(file, mode);
    helperFiles[name] = file;
  }
  const overlayFile = overlay(output, { [archiveFile]: archive.FILE }, helperFiles);
  const serviceFile = JSON.parse(fs.readFileSync(overlayFile)).bundle.linux.deb.files[retirement.SERVICE];
  assert.deepEqual(capture(serviceFile, 4096), plan.baseline016.pins.service);
  const target = path.join(output, 'hub-target');
  const childEnv = { ...builder.integrationEnvironment(unix.packageEnvironment(env, 'linux', 'writable'), output, true),
    CREATOR_BUILTIN_MANIFEST: descriptor, CARGO_TARGET_DIR: target };
  run(process.execPath, compileCommand(root, overlayFile), { env: childEnv, timeout: 1800000, stdio: 'inherit' });
  const release = path.join(target, 'x86_64-unknown-linux-gnu/release'), rawHub = path.join(output, 'creator-hub');
  fs.copyFileSync(path.join(release, 'creator-hub'), rawHub, fs.constants.COPYFILE_EXCL);
  finite.validateElf(finite.read(rawHub, 256 * 1024 * 1024));
  for (const witness of builder.PORTABLE_ROOT_WITNESSES) assert.ok(fs.readFileSync(rawHub).includes(Buffer.from(witness)), 'Compiled017 portable binding missing');
  const integrity = unix.validatePackages({ output, bundleDirectory: path.join(release, 'bundle'), manifest, productName: 'Creator Hub',
    rawHub, archiveDecoder: decoder, execute, mcpMode: 'writable', linuxRetirementCandidate: true });
  assert.equal(integrity.packages.length, 1);
  const deb = path.join(output, integrity.packages[0].path);
  const expected = { baseline: baselinePins,
    candidate: { deb: capture(deb, 256 * 1024 * 1024), hub: capture(path.join(output, 'package-extracted-deb/usr/bin/creator-hub'), 256 * 1024 * 1024),
      archive: capture(archiveFile, 256 * 1024 * 1024) } };
  const expectedFile = path.join(output, 'private017-package-expected.json'); write(expectedFile, JSON.stringify(expected));
  const packageReport = JSON.parse(run('/usr/bin/python3', [checker, baselineDeb, deb, expectedFile]));
  assert.equal(packageReport.helperPolicyServicePreserved, true); assert.equal(packageReport.releaseReady, false);
  accepted.recheck(); sourceCheck(root, plan, env, execute); fixture.source(root, execute);
  original.verifyPrivateSource(accepted.handoff.source.sourceCommit, run);
  builder.verifyStage(path.join(output, 'modules'), manifest);
  const receipt = { schemaVersion: 1, profile: fixture.PROFILE, hubVersion: fixture.VERSION, rootSource: plan.rootSource,
    original016: { source: accepted.handoff.source, files: plan.original016 }, baseline016: plan.baseline016,
    derivation: accepted.records['derivation017.json'], compiledFeatures: [...fixture.FEATURES], target: 'x86_64-unknown-linux-gnu',
    rawHub: capture(rawHub, 256 * 1024 * 1024), deb: expected.candidate.deb, packagedHub: expected.candidate.hub,
    archive: expected.candidate.archive, manifest: capture(descriptor, 65536), packageReport, ...fixture.FLAGS };
  write(path.join(output, 'private017-assembly.json'), JSON.stringify(receipt, null, 2));
  return receipt;
}

module.exports = { SOURCE_PATHS, VERIFIER, canonical, inside, sourceCheck, overlay, compileCommand, inputs, build };
if (require.main === module) {
  const args = process.argv.slice(2);
  assert.equal(args.length, 8, 'Use --root SOURCE --input SIGNED_INPUT --output NEW_DIRECTORY --plan-sha256 INDEPENDENT_SHA256');
  assert.deepEqual(args.filter((_, i) => i % 2 === 0), ['--root', '--input', '--output', '--plan-sha256']);
  console.log(JSON.stringify(build({ root: args[1], input: args[3], output: args[5], planSha256: args[7] })));
}
