const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const api = require('./portable-release-descriptor.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const json = v => Buffer.from(`${JSON.stringify(v, null, 2)}\n`);
const pin = b => ({ byteLength: b.length, sha256: hash(b) });

function fixture() {
  const archive = Buffer.from('test-only archive; no payload is executed');
  const root = { kind: 'file', mode: 0o755, size: 20, sha256: 'a'.repeat(64) };
  const m = { schemaVersion: 1, appId: 'creator-hub', platform: 'linux', architecture: 'x86_64',
    version: '0.1.17', sourceCommit: 'b'.repeat(40), sourceTree: 'c'.repeat(40),
    format: 'appdir-tar-gzip-v1', entrypoint: 'usr/bin/creator-hub',
    archive: { size: archive.length, sha256: hash(archive), unpackedSize: 22 },
    entries: { AppRun: { ...root, size: 1 }, 'creator-hub-portable-host.json': { ...root, size: 1, mode: 0o644 },
      usr: { kind: 'directory', mode: 0o755 }, 'usr/bin': { kind: 'directory', mode: 0o755 },
      'usr/bin/creator-hub': root } };
  const manifest = json(m);
  const receipt = { schemaVersion: 1, scope: api.SCOPE, appId: m.appId, version: m.version,
    platform: m.platform, architecture: m.architecture, packageType: api.PACKAGE, manifest: pin(manifest),
    archive: pin(archive), executableSha256: root.sha256, sourceCommit: m.sourceCommit, sourceTree: m.sourceTree,
    approvedForStable: true, minHubVersion: '0.1.16', checks: Object.fromEntries(api.CHECKS.map(n => [n, true])),
    evidence: ['https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/123'] };
  return { archive, m, manifest, receipt };
}

test('portable envelope binds exact manifest and archive without another archive signature', () => {
  const f = fixture(), d = api.descriptor(f.manifest, pin(f.archive), f.receipt);
  assert.deepEqual(d, { schemaVersion: 1, appId: 'creator-hub', version: '0.1.17', platform: 'linux',
    architecture: 'x86_64', packageType: 'portable-appdir',
    manifest: { assetName: api.names('0.1.17').manifest, ...pin(f.manifest) },
    archive: { assetName: api.names('0.1.17').archive, ...pin(f.archive) },
    executableSha256: 'a'.repeat(64), restartProtocol: 1, minHubVersion: '0.1.16' });
  assert.equal(Object.hasOwn(d, 'archiveSignature'), false);
  assert.equal(Object.hasOwn(d, 'platforms'), false, 'Portable publication is not a Tauri latest.json fallback');
});

test('packaging-only and partial native receipts cannot promote restart acceptance', () => {
  for (const check of api.CHECKS) {
    const f = fixture(); f.receipt.checks[check] = false;
    assert.throws(() => api.descriptor(f.manifest, pin(f.archive), f.receipt), /Native acceptance missing/);
    f.receipt.checks[check] = 'true';
    assert.throws(() => api.descriptor(f.manifest, pin(f.archive), f.receipt), /Native acceptance missing/);
  }
  for (const patch of [{ approvedForStable: false }, { scope: 'unsigned-linux-016-portable-packaging-only' },
    { evidence: [] }, { evidence: ['https://github.com/other/repo/actions/runs/1'] },
    { checks: {} }, { extra: true }, { minHubVersion: '0.1.18' }, { minHubVersion: '0.1.16-beta.1' }]) {
    const f = fixture();
    assert.throws(() => api.descriptor(f.manifest, pin(f.archive), { ...f.receipt, ...patch }));
  }
});

test('every artifact and source binding in the reviewed receipt remains exact', () => {
  for (const field of ['appId', 'version', 'platform', 'architecture', 'sourceCommit', 'sourceTree',
    'packageType', 'executableSha256', 'manifest', 'archive']) {
    const f = fixture(); f.receipt[field] = typeof f.receipt[field] === 'object' ? { byteLength: 1, sha256: 'd'.repeat(64) } : 'different';
    assert.throws(() => api.descriptor(f.manifest, pin(f.archive), f.receipt));
  }
  const f = fixture();
  assert.throws(() => api.descriptor(f.manifest, { ...pin(f.archive), sha256: 'd'.repeat(64) }, f.receipt), /differs from manifest/);
});

test('rejects noncanonical, duplicate, oversized or incompatible manifests', () => {
  const f = fixture();
  for (const bytes of [Buffer.from('{}'), Buffer.from('{"schemaVersion":0,"schemaVersion":1}\n'),
    Buffer.concat([f.manifest, Buffer.from(' ')]), Buffer.alloc(2 * 1024 * 1024 + 1),
    Buffer.from([0xff])]) assert.throws(() => api.descriptor(bytes, pin(f.archive), f.receipt));
  for (const patch of [{ architecture: 'i686' }, { platform: 'windows' }, { format: 'deb' },
    { version: '0.1.17-beta.1' }, { version: '0.1.17+build.1' }, { version: '../0.1.17' },
    { sourceTree: 'not-a-tree' }, { entrypoint: 'sh' }, { extra: true }]) {
    assert.throws(() => api.descriptor(json({ ...f.m, ...patch }), pin(f.archive), f.receipt));
  }
});

test('host profile, AppRun, exact parents and ordinary inventory modes are mandatory', () => {
  for (const name of ['AppRun', 'creator-hub-portable-host.json', 'usr/bin', 'usr/bin/creator-hub']) {
    const f = fixture(); delete f.m.entries[name];
    assert.throws(() => api.descriptor(json(f.m), pin(f.archive), f.receipt));
  }
  for (const name of ['AppRun', 'usr/bin/creator-hub']) {
    const f = fixture(); f.m.entries[name].mode = 0o644;
    assert.throws(() => api.descriptor(json(f.m), pin(f.archive), f.receipt));
  }
});

test('preparation is exclusive, key-free, unsigned and never release-ready', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-descriptor-'));
  try {
    const f = fixture(), manifest = path.join(temp, 'manifest.json'), archive = path.join(temp, api.names('0.1.17').archive),
      receipt = path.join(temp, 'receipt.json'), output = path.join(temp, 'prepared');
    fs.writeFileSync(manifest, f.manifest); fs.writeFileSync(archive, f.archive); fs.writeFileSync(receipt, json(f.receipt));
    const before = [manifest, archive, receipt].map(file => fs.readFileSync(file));
    const result = api.prepare({ manifest, archive, receipt, output });
    assert.deepEqual(result, { descriptorName: api.NAME, descriptor: pin(fs.readFileSync(path.join(output, `${api.NAME}.unsigned`))),
      manifestSignatureRequired: true, descriptorSignatureRequired: true, archiveSignatureRequired: false,
      nativeVerificationRequired: true, releaseReady: false });
    assert.deepEqual(fs.readdirSync(output), [`${api.NAME}.unsigned`]);
    assert.deepEqual([manifest, archive, receipt].map(file => fs.readFileSync(file)), before);
    assert.throws(() => api.prepare({ manifest, archive, receipt, output }), /already exists/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('refusal before output creation preserves all inputs', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-descriptor-'));
  try {
    const f = fixture(), manifest = path.join(temp, 'manifest.json'), archive = path.join(temp, api.names('0.1.17').archive),
      receipt = path.join(temp, 'receipt.json'), output = path.join(temp, 'prepared');
    fs.writeFileSync(manifest, f.manifest); fs.writeFileSync(archive, Buffer.concat([f.archive, Buffer.from('changed')]));
    fs.writeFileSync(receipt, json(f.receipt));
    assert.throws(() => api.prepare({ manifest, archive, receipt, output }), /differs from manifest/);
    assert.equal(fs.existsSync(output), false);
    assert.throws(() => api.capture(temp, 4096), /regular file/);
    assert.throws(() => api.capture(manifest, 1), /regular file/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('new helper has no signer, key, dispatch or archive-signature execution path', () => {
  const source = fs.readFileSync(require.resolve('./portable-release-descriptor.cjs'), 'utf8');
  assert.doesNotMatch(source, /require\(['"]node:child_process|CREATOR_HUB_SIGNING|signDetached|spawnSync|execFileSync/);
  assert.match(source, /archiveSignatureRequired: false/);
});

test('real redirected ancestors and hard-linked inputs are refused', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-descriptor-'));
  try {
    const owned = path.join(temp, 'owned'), link = path.join(temp, 'redirect'); fs.mkdirSync(owned);
    const input = path.join(owned, 'input.json'); fs.writeFileSync(input, '{}');
    fs.symlinkSync(owned, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => api.capture(path.join(link, 'input.json'), 4096), /Redirected path/);
    fs.linkSync(input, path.join(owned, 'hard'));
    assert.throws(() => api.capture(input, 4096), /regular file/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('Root portable schema matches the independently prepared envelope', () => {
  const rust = fs.readFileSync(path.join(__dirname, '../src-tauri/src/portable_package.rs'), 'utf8');
  const catalog = fs.readFileSync(path.join(__dirname, '../src-tauri/src/catalog.rs'), 'utf8');
  const fields = name => {
    const body = rust.match(new RegExp(`struct ${name} \\{([\\s\\S]*?)\\n\\}`))[1];
    return [...body.matchAll(/^\s+([a-z_0-9]+):/gm)].map(m => m[1].replace(/_([a-z])/g, (_, c) => c.toUpperCase())).sort();
  };
  const f = fixture(), d = api.descriptor(f.manifest, pin(f.archive), f.receipt);
  assert.deepEqual(fields('Descriptor'), Object.keys(d).sort());
  assert.deepEqual(fields('Asset'), Object.keys(d.manifest).sort());
  assert.match(rust, /use crate::catalog::PORTABLE_DESCRIPTOR_NAME as DESCRIPTOR_NAME/);
  assert.match(catalog, new RegExp(`PORTABLE_DESCRIPTOR_NAME: &str = "${api.NAME.replaceAll('.', '\\.')}"`));
  assert.match(rust, /const PACKAGE: &str = "portable-appdir"/);
  assert.match(rust, /deny_unknown_fields/);
  assert.match(rust, /deployment::verify\(/, 'Archive authority is the existing native signed manifest verifier');
  assert.doesNotMatch(rust, /updater_builder|latest\.json"|request_restart|\.activate\(/);
});

test('shared package authority is opaque and exact-current bootstrap does not inherit updater admission', () => {
  const shared = fs.readFileSync(path.join(__dirname, '../src-tauri/src/portable_package.rs'), 'utf8');
  const root = fs.readFileSync(path.join(__dirname, '../src-tauri/src/main.rs'), 'utf8');
  const updater = fs.readFileSync(path.join(__dirname, '../src-tauri/src/portable_update.rs'), 'utf8');
  assert.match(root, /#\[cfg\(all\(target_os = "linux", feature = "experimental-linux-portable-update"\)\)\]\s+mod portable_package;/);
  assert.match(shared, /pub\(crate\) struct SignedDescriptor\(Descriptor\);/);
  assert.match(shared, /pub\(crate\) struct VerifiedDownload \{\s+release: SignedDescriptor,\s+package: VerifiedPackage,\s+\}/);
  assert.doesNotMatch(shared, /impl(?:<'[^>]+>)? Deserialize[^\n]* (?:SignedDescriptor|VerifiedDownload)/);
  assert.match(shared, /include_str!\("catalog-key\.pub"\)/);
  const current = shared.slice(shared.indexOf('pub(crate) fn fetch_current_descriptor('), shared.indexOf('pub(crate) fn cache_root('));
  assert.match(current, /stable\(env!\("CARGO_PKG_VERSION"\)\)/);
  assert.match(current, /catalog::release_url\(REPO, &current\.to_string\(\), DESCRIPTOR_NAME\)/);
  assert.match(current, /signed_descriptor\(&bytes, &signature\)\?/);
  assert.match(current, /descriptor\.validate\(\)\? != stable\(env!\("CARGO_PKG_VERSION"\)\)\?/);
  assert.match(current, /operation: &manager::Operation/);
  assert.match(current, /prepare_download\(handle, &descriptor, operation\)/);
  assert.doesNotMatch(shared, /\.begin\(|\bStore::|\bRootRestart\b|selected\(|installable\(|discover_portable\(|\.exit\(|request_restart/);
  assert.match(updater, /release\.installable\(\)\?;\s+package::verify_download\(release, directory\)/);
  assert.match(updater, /release\.installable\(\)\?;\s+package::prepare_download\(handle, release, operation\)/);
  const selected = updater.slice(updater.indexOf('fn selected('), updater.indexOf('pub(crate) fn download('));
  assert.match(selected, /runtime\.unsupported/);
  assert.match(selected, /runtime\.restart\.is_none\(\)/);
  assert.match(selected, /release\.installable\(\)\?/);
  assert.match(updater, /self\.validate\(\)\? <= stable\(env!\("CARGO_PKG_VERSION"\)\)\?/);
  assert.match(updater, /stable\(self\.min_hub_version\(\)\)\? > stable\(env!\("CARGO_PKG_VERSION"\)\)\?/);
});

test('portable routing is default-off, precedes native selection and requires the concrete coordinator feature', () => {
  const cargo = fs.readFileSync(path.join(__dirname, '../src-tauri/Cargo.toml'), 'utf8');
  assert.match(cargo, /^experimental-linux-portable-update = \["experimental-linux-portable-host", "creator-hub-linux-portable-deployment\/experimental-restart"\]$/m);
  assert.doesNotMatch(cargo.match(/^default =.*$/m)[0], /portable/);
  const root = fs.readFileSync(path.join(__dirname, '../src-tauri/src/main.rs'), 'utf8');
  assert.match(root, /#\[cfg\(all\(target_os = "linux", feature = "experimental-linux-portable-update"\)\)\]\s+mod portable_update;/);
  const updater = fs.readFileSync(path.join(__dirname, '../src-tauri/src/self_update.rs'), 'utf8');
  const check = updater.slice(updater.indexOf('fn check('), updater.indexOf('\nfn download('));
  assert.ok(check.indexOf('crate::portable_update::check(') < check.indexOf('Target::native()?'));
  for (const fn of ['download', 'install']) {
    assert.match(updater, new RegExp(`#\\[cfg\\(all\\(target_os = "linux", feature = "experimental-linux-portable-update"\\)\\)\\]\\s+if crate::portable_update::handles\\(&handle\\) \\{\\s+return crate::portable_update::${fn}\\(`));
  }
  const portable = fs.readFileSync(path.join(__dirname, '../src-tauri/src/portable_update.rs'), 'utf8');
  const install = portable.slice(portable.indexOf('pub(crate) fn install('), portable.indexOf('#[cfg(test)]'));
  assert.doesNotMatch(install, /\.activate\(|request_restart/);
  for (const name of ['RestartChoice', 'RestartStageOutcome', 'RootRestart']) assert.ok(portable.includes(name));
  assert.match(install, /\.prepare\(staged\)/);
  assert.match(install, /\.authorize_exit\(ready\)/);
  assert.match(install, /\.abort_pending\(\)/);
  assert.match(install, /flow\.disposition\(\) != RestartDisposition::ExitAuthorized/);
  // Runtime ordering/failure cases execute run_install in the Rust suite.
  // This assertion only binds that tested orchestration to the native command.
  assert.match(install, /run_install\(&mut flow\)/);
  assert.match(install, /impl InstallFlow for NativeInstall/);
  assert.match(install, /prepare_download\(\s*self.handle,\s*&self.release,\s*self.operation.as_ref\(\).ok_or\(UNCERTAIN\)\?,?\s*\)/);
  assert.match(install, /\.review_restart\(/);
  assert.match(install, /\.blocking_show\(\)/);
  assert.match(install, /\.stage_restart\(/);
  assert.match(install, /\.close_for_portable_restart\(/);
  assert.match(install, /self.handle.exit\(0\)/);
  assert.match(install, /RestartStageOutcome::Declined\s*=>/);
  assert.match(install, /retain_uncertain\(self.handle, operation,/);
  assert.doesNotMatch(install, /installed successfully|update complete/i);
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/unix-managed-assembly.yml'), 'utf8');
  assert.doesNotMatch(workflow, /experimental-linux-portable-update/);
});

test('native bootstrap is a guarded process role without service startup or a sandbox command route', () => {
  const root = fs.readFileSync(path.join(__dirname, '../src-tauri/src/main.rs'), 'utf8');
  const backend = fs.readFileSync(path.join(__dirname, '../src-tauri/src/native_support.rs'), 'utf8');
  const launch = fs.readFileSync(path.join(__dirname, '../src-tauri/src/launch.rs'), 'utf8');
  const rpc = fs.readFileSync(path.join(__dirname, '../src-tauri/src/flatpak_rpc.rs'), 'utf8');
  const commands = ['native_support_status', 'install_native_support', 'review_native_support_recovery'];
  for (const name of commands) {
    assert.ok(root.includes(`native_support::${name},`));
    assert.ok(rpc.slice(rpc.indexOf('const NATIVE_WINDOW_ONLY:'), rpc.indexOf('pub(super) const EVENTS:')).includes(`"${name}"`));
    assert.doesNotMatch(rpc.slice(rpc.indexOf('pub(super) enum Invocation'), rpc.indexOf('pub(super) fn decode(')), new RegExp(name.split('_').map(s => s[0].toUpperCase() + s.slice(1)).join('')));
  }
  assert.match(launch, /matches!\(arguments.as_slice\(\), \[flag\] if flag == "--install-native-support"\)/);
  const startup = root.slice(root.indexOf('fn main()'), root.indexOf('let mut random'));
  assert.ok(startup.indexOf('linux_portable_host::admit_startup()') < startup.indexOf('launch::native_support_requested('));
  assert.doesNotMatch(startup.slice(0, startup.indexOf('linux_portable_host::admit_startup()')), /if !bootstrap/);
  const setup = root.slice(root.indexOf('.setup(move |app|'), root.indexOf('.plugin(tauri_plugin_updater'));
  assert.ok(setup.indexOf('if !bootstrap {') < setup.indexOf('flatpak_bootstrap::serve('));
  assert.ok(setup.indexOf('if !bootstrap {') < setup.indexOf('self_update::initialize('));
  const handler = root.slice(root.indexOf('.invoke_handler(move |invoke|'), root.indexOf('.build(tauri::generate_context!())'));
  assert.ok(handler.indexOf('x-creator-shell-key') < handler.indexOf('native_support::command_allowed('));
  assert.ok(handler.indexOf('native_support::command_allowed(') < handler.indexOf('commands(invoke)'));
  const status = backend.slice(backend.indexOf('pub(super) fn status('), backend.indexOf('pub(super) fn install('));
  assert.doesNotMatch(status, /\.begin\(|fetch_current\(|catalog::|Store::open|child_dir\(|create_dir|record\(/);
  assert.match(backend, /portable_package::fetch_current\(self.handle, self.operation\)/);
  assert.match(backend, /ReviewedBootstrapChoice::Cancel/);
  assert.match(backend, /BootstrapRecoveryChoice::Keep/);
  assert.match(backend, /InstallChoice::InstallReviewed/);
  assert.match(backend, /RegistrationChoice::ApplyReviewed/);
  assert.match(backend, /lease\.selection\(\)\.generation != package\.package\(\)\.generation\(\)/);
  assert.doesNotMatch(backend, /request_restart|authorize_exit|\.spawn\(|\.exit\(|\.activate\(|acknowledge_recovery\(|recover_registration\(/);
});

test('unknown exit intent retains abort authority and normal-exit transfer blocks new work atomically', () => {
  const portable = fs.readFileSync(path.join(__dirname, '../src-tauri/src/portable_update.rs'), 'utf8');
  const retain = portable.slice(portable.indexOf('fn retain_uncertain('), portable.indexOf('pub(crate) fn install('));
  assert.match(retain, /runtime\.uncertain = Some\(operation\)/);
  assert.doesNotMatch(retain, /runtime\.restart.take\(\)/);
  assert.match(retain, /runtime\.unsupported = Some/);
  const manager = fs.readFileSync(path.join(__dirname, '../src-tauri/src/manager.rs'), 'utf8');
  const handoff = manager.slice(manager.indexOf('pub(crate) fn close_for_portable_restart('), manager.indexOf('pub fn begin('));
  assert.match(handoff, /Arc::ptr_eq\(&operation.busy, &self.busy\)/);
  assert.ok(handoff.indexOf('*closing = true') < handoff.indexOf('self.busy.store(false'));
  assert.match(handoff, /self.cancel.load\(Ordering::SeqCst\)/);
  const run = portable.slice(portable.indexOf('fn run_install('), portable.indexOf('fn restart_failure('));
  assert.ok(run.indexOf('flow.authorize_exit(ready)') < run.indexOf('flow.close_for_restart()'));
  assert.ok(run.indexOf('flow.disposition()') < run.indexOf('flow.close_for_restart()'));
  assert.ok(run.indexOf('flow.close_for_restart()') < run.indexOf('flow.request_normal_exit()'));
  const abort = portable.slice(portable.indexOf('    fn abort_pending(&mut self) -> RestartDisposition {',
    portable.indexOf('impl InstallFlow for NativeInstall')), portable.indexOf('    fn retain_uncertain(&mut self, error: &str) -> String {',
    portable.indexOf('impl InstallFlow for NativeInstall')));
  assert.match(abort, /let _ = restart\.abort_pending\(\);\s+restart\.disposition\(\)/);
  assert.match(abort, /RestartDisposition::Unknown \| RestartDisposition::ExitAuthorized/);
});

test('retained review is a trusted-shell, Linux experimental-only bounded abort path without Manager admission', () => {
  const portable = fs.readFileSync(path.join(__dirname, '../src-tauri/src/portable_update.rs'), 'utf8');
  const recovery = portable.slice(portable.indexOf('pub(crate) fn recovery_status('), portable.indexOf('pub(crate) fn initialize('));
  assert.match(recovery, /\.try_lock\(\)/);
  assert.match(recovery, /client\.abort_pending\(\)/);
  assert.match(recovery, /Ok\(client\.disposition\(\)\)/);
  assert.match(recovery, /RestartDisposition::Aborted\s*\| RestartDisposition::SafeNotArmed\s*\| RestartDisposition::PeerClosedSafe/);
  assert.doesNotMatch(recovery, /\.begin\(|\.stage_restart\(|\.review_restart\(|\.activate\(|\.exit\(|request_restart|download\(/);
  const resolverStart = recovery.indexOf('fn resolve_retained<');
  assert.ok(resolverStart >= 0);
  const resolver = recovery.slice(resolverStart, recovery.indexOf('pub(crate) fn review_retained('));
  assert.ok(resolver.indexOf('if lease.is_none()') < resolver.indexOf('abort(client)?'));
  assert.ok(resolver.indexOf('return Err(UNCERTAIN.into())') < resolver.indexOf('lease.take()'));
  const updater = fs.readFileSync(path.join(__dirname, '../src-tauri/src/self_update.rs'), 'utf8');
  const commands = updater.slice(updater.indexOf('pub async fn hub_update_recovery_status('), updater.indexOf('pub async fn hub_update_status('));
  assert.doesNotMatch(commands, /\.begin\(/);
  for (const name of ['hub_update_recovery_status', 'review_retained_hub_update']) {
    assert.ok(commands.includes(name));
  }
  assert.equal((commands.match(/#\[cfg\(all\(target_os = "linux", feature = "experimental-linux-portable-update"\)\)\]/g) || []).length, 2);
  const main = fs.readFileSync(path.join(__dirname, '../src-tauri/src/main.rs'), 'utf8');
  assert.match(main, /cfg!\(all\(\s*target_os = "linux",\s*feature = "experimental-linux-portable-update"\s*\)\)/);
  assert.match(main, /self_update::hub_update_recovery_status/);
  assert.match(main, /self_update::review_retained_hub_update/);
  assert.ok(main.indexOf('invoke.resolver.reject("Hub commands are available only to its trusted shell.")') < main.indexOf('commands(invoke)'));
  const native = fs.readFileSync(path.join(__dirname, '../src/native.js'), 'utf8');
  assert.match(native, /updateRecovery: window\.__CREATOR_HUB_UPDATE_RECOVERY_PROTOCOL__ === 1/);
  const queued = native.match(/const discovery = new Set\(\[([^\]]+)\]\)/)[1];
  assert.doesNotMatch(queued, /hub_update_recovery_status|review_retained_hub_update/);
});
