const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { build, parseBuildOptions, moduleFiles } = require('./build-unified.cjs');
const { routeFiles } = require('./managed-router-package.cjs');
const { validatePackages, nativePlan } = require('./unix-package-payload.cjs');
const packaging = require('./linux-retirement-package.cjs');
const repo = path.resolve(__dirname, '..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const accepted = { enabled: true, platform: 'linux', arch: 'x86_64', installer: true, managed: true,
  experimentalUnix: true, experimentalWritable: true, prepareManagedUnix: false, signedUnixInput: path.resolve('/signed-input') };

test('acceptance-only option is finite, opt-in and unavailable to default, Windows, Mac or unsigned preparation', () => {
  packaging.checkOptions(accepted);
  packaging.checkOptions({ enabled: false });
  for (const change of [{ enabled: 'true' }, { enabled: null }, { platform: 'windows' }, { platform: 'macos' },
    { arch: 'aarch64' }, { installer: false }, { managed: false }, { experimentalUnix: false },
    { experimentalWritable: false }, { prepareManagedUnix: true }, { signedUnixInput: null }, { signedUnixInput: 'relative' }]) {
    assert.throws(() => packaging.checkOptions({ ...accepted, ...change }), undefined, JSON.stringify(change));
  }
  assert.deepEqual(parseBuildOptions(['--linux-retirement-test-candidate']), { linuxRetirementCandidate: true });
  assert.throws(() => parseBuildOptions(['--linux-retirement-test-candidate', '--linux-retirement-test-candidate']), /Duplicate/);
  const calls = [];
  assert.throws(() => build('never-create', { linuxRetirementCandidate: true }, { platform: 'windows', arch: 'x86_64', execute: (...args) => calls.push(args) }), /signed native Linux/);
  assert.deepEqual(calls, []);
  assert.throws(() => nativePlan('linux', 'x86_64'), /refuses by default/);
  assert.deepEqual(nativePlan('windows', 'x86_64', { installer: true }).bundles, ['nsis']);
});

test('recipe adds only two fixed DEB files, explicit native dependency and test-only labeling', () => {
  const recipe = JSON.parse(fs.readFileSync(path.join(repo, 'packaging/linux/tauri-retirement-acceptance.json')));
  assert.deepEqual(Object.keys(recipe), ['build', 'bundle']);
  assert.deepEqual(recipe.build, { features: ['experimental-linux-migration'] });
  assert.deepEqual(Object.keys(recipe.bundle).sort(), ['linux', 'longDescription', 'shortDescription', 'targets']);
  assert.deepEqual(recipe.bundle.targets, ['deb']);
  assert.deepEqual(Object.keys(recipe.bundle.linux), ['deb']);
  assert.deepEqual(Object.keys(recipe.bundle.linux.deb).sort(), ['depends', 'files']);
  assert.deepEqual(recipe.bundle.linux.deb.depends, ['policykit-1']);
  assert.deepEqual(recipe.bundle.linux.deb.files, {
    [packaging.HELPER]: 'creator-hub-deb-retirement-helper', [packaging.POLICY]: 'com.creatorworks.hub.deb-retirement.policy',
  });
  assert.match(recipe.bundle.shortDescription, /^TEST ONLY/);
  const schema = JSON.parse(fs.readFileSync(path.join(repo, 'node_modules/@tauri-apps/cli/config.schema.json')));
  assert.ok(Object.hasOwn(schema.definitions.BuildConfig.properties, 'features'));
  for (const key of Object.keys(recipe.bundle.linux.deb)) assert.ok(Object.hasOwn(schema.definitions.DebConfig.properties, key));
  assert.ok(Object.values(packaging.FLAGS).every(value => value === false));
});

test('fixed policy has no permissive rule, cached authority, GUI forwarding or arbitrary program', () => {
  const policy = fs.readFileSync(path.join(repo, 'packaging/linux', path.posix.basename(packaging.POLICY)), 'utf8');
  assert.equal((policy.match(/>auth_admin</g) || []).length, 3);
  assert.doesNotMatch(policy, /auth_admin_keep|auth_self|>yes<|allow_gui|\.rules|\.pkla|exec\.argv1/);
  assert.equal((policy.match(/<action id=/g) || []).length, 1, 'polkit 0.105 matches by path, not argv1');
  assert.equal((policy.match(/org\.freedesktop\.policykit\.exec\.path/g) || []).length, 1);
  const helper = fs.readFileSync(path.join(repo, 'native/linux-deb-retirement/src/lib.rs'), 'utf8');
  for (const argument of ['retire-mcp-2.7.7', 'retire-setup-0.3.7']) assert.ok(helper.includes(`["${argument}"]`));
});

function temp() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-retirement-package-'))); }
function nativeFixture() {
  const root = temp();
  const output = path.join(root, 'artifacts/unified/candidate');
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(path.join(root, 'packaging/linux'), { recursive: true });
  for (const name of ['tauri-retirement-acceptance.json', path.posix.basename(packaging.POLICY)]) {
    fs.copyFileSync(path.join(repo, 'packaging/linux', name), path.join(root, 'packaging/linux', name));
  }
  return { root, output, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('actual staged overlay parses to the fixed helper/policy destinations and explicit Root feature on every host', () => {
  const f = nativeFixture();
  try {
    const resources = { '/staged/modules.tar.gz': 'modules.tar.gz' };
    const overlay = packaging.writeOverlay(f.root, f.output, resources);
    const parsed = JSON.parse(fs.readFileSync(overlay, 'utf8'));
    assert.deepEqual(parsed.build.features, [packaging.FEATURE]);
    assert.deepEqual(parsed.bundle.targets, ['deb']);
    assert.deepEqual(parsed.bundle.resources, resources);
    assert.deepEqual(parsed.bundle.linux.deb.files, {
      [packaging.HELPER]: path.join(f.output, 'linux-retirement', path.posix.basename(packaging.HELPER)),
      [packaging.POLICY]: path.join(f.output, 'linux-retirement', path.posix.basename(packaging.POLICY)),
    });
    assert.throws(() => packaging.writeOverlay(f.root, f.output, resources), /EEXIST/);
  } finally { f.cleanup(); }
});

test('native stage builds a fresh fixed helper, copies independent bytes and preserves all refusal flags', { skip: process.platform !== 'linux' }, () => {
  const f = nativeFixture();
  const calls = [];
  const execute = (command, args) => {
    calls.push([command, args]);
    assert.equal(command, 'cargo');
    assert.ok(args.includes('--locked') && args.includes('experimental-transaction'));
    assert.equal(args[args.indexOf('--target') + 1], 'x86_64-unknown-linux-gnu');
    const file = path.join(args[args.indexOf('--target-dir') + 1], 'x86_64-unknown-linux-gnu/release/creator-hub-linux-deb-retirement');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(128, 1), { mode: 0o755 });
  };
  try {
    const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
      GITHUB_REPOSITORY_ID: '1364807512', GITHUB_SHA: 'a'.repeat(40) };
    const resources = { '/staged/modules.tar.gz': 'modules.tar.gz' };
    const result = packaging.stage(f.root, f.output, resources, env, execute);
    const overlay = JSON.parse(fs.readFileSync(result.overlay));
    assert.deepEqual(overlay.bundle.resources, resources);
    assert.deepEqual(overlay.build.features, [packaging.FEATURE]);
    assert.deepEqual(overlay.bundle.targets, ['deb']);
    assert.deepEqual(Object.keys(result.files), [packaging.HELPER, packaging.POLICY]);
    assert.equal(result.files[packaging.HELPER].mode, 0o755);
    assert.equal(result.files[packaging.POLICY].mode, 0o644);
    assert.equal(fs.statSync(overlay.bundle.linux.deb.files[packaging.HELPER]).nlink, 1);
    const receipt = JSON.parse(fs.readFileSync(path.join(f.output, 'linux-retirement-candidate.json')));
    for (const [key, value] of Object.entries(packaging.FLAGS)) assert.equal(receipt[key], value);
    assert.equal(receipt.rootFeature, 'experimental-linux-migration');
    assert.equal(calls.length, 1);
    assert.throws(() => packaging.stage(f.root, f.output, resources, env, execute), /EEXIST/);
    assert.equal(calls.length, 1);
  } finally { f.cleanup(); }
});

test('package verifier binds archive bytes and numeric root metadata without claiming installation', () => {
  const root = temp();
  try {
    fs.mkdirSync(path.join(root, 'src-tauri'));
    fs.writeFileSync(path.join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.1.14' }));
    fs.mkdirSync(path.join(root, 'native-packages'));
    const file = path.join(root, 'native-packages/fixture.deb');
    fs.writeFileSync(file, 'container bytes');
    const files = { [packaging.HELPER]: { sha256: 'a'.repeat(64), size: 128, mode: 0o755, uid: 0, gid: 0 },
      [packaging.POLICY]: { sha256: 'b'.repeat(64), size: 1024, mode: 0o644, uid: 0, gid: 0 } };
    const integrity = { integrityPassed: true, packages: [{ format: 'deb', path: 'native-packages/fixture.deb', sha256: digest('container bytes') }] };
    const execute = (command, args) => {
      assert.equal(command, 'python3');
      assert.deepEqual(args.slice(2), [file, files[packaging.HELPER].sha256, files[packaging.POLICY].sha256, '0.1.14']);
      return JSON.stringify({ files });
    };
    const receipt = packaging.verifyDeb(root, root, integrity, { files }, execute);
    assert.equal(receipt.archiveIntegrityPassed, true);
    assert.equal(receipt.systemInstallationTested, false);
    for (const key of Object.keys(packaging.FLAGS)) assert.equal(receipt[key], false);
    assert.throws(() => packaging.verifyDeb(root, root, integrity, { files }, () => JSON.stringify({ files: {
      ...files, [packaging.HELPER]: { ...files[packaging.HELPER], uid: 1001 },
    } })), /ownership, modes and bytes/);
    assert.throws(() => packaging.verifyDeb(root, root, { ...integrity, packages: [...integrity.packages, { format: 'rpm' }] }, { files }, execute));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('DEB-only validation is available only to an explicit managed writable Linux x86_64 candidate', () => {
  for (const change of [{ linuxRetirementCandidate: 'true' }, { mcpMode: 'read-only' }, { manifest: { platform: 'macos', arch: 'x86_64', managedRouting: {} } },
    { manifest: { platform: 'linux', arch: 'aarch64', managedRouting: {} } }]) {
    assert.throws(() => validatePackages({ manifest: { platform: 'linux', arch: 'x86_64', managedRouting: {} },
      mcpMode: 'writable', linuxRetirementCandidate: true, ...change }), /retirement acceptance package/);
  }
});

test('actual package validation still checks every selected module and managed route for the DEB-only candidate', () => {
  const root = temp();
  try {
    const output = path.join(root, 'output'), bundleDirectory = path.join(root, 'bundle');
    fs.mkdirSync(output); fs.mkdirSync(path.join(bundleDirectory, 'deb'), { recursive: true });
    fs.writeFileSync(path.join(bundleDirectory, 'deb/fixture.deb'), 'container fixture');
    const manifest = { schemaVersion: 1, platform: 'linux', arch: 'x86_64', modules: {}, managedRouting: { protocol: 1, files: {} } };
    for (const id of ['mcp', 'setup']) {
      const names = moduleFiles(id, 'linux');
      manifest.modules[id] = { executable: names[0], version: id === 'mcp' ? '2.7.7' : '0.3.7', files: Object.fromEntries(names.map(name => [name, digest(name)])) };
    }
    for (const name of routeFiles('linux')) manifest.managedRouting.files[name] = digest(name);
    fs.writeFileSync(path.join(output, 'builtin-manifest.json'), JSON.stringify(manifest));
    const raw = Buffer.from(`code\0__TAURI_BUNDLE_TYPE_VAR_UNK\0${JSON.stringify(manifest)}`);
    const rawHub = path.join(output, 'creator-hub'); fs.writeFileSync(rawHub, raw);
    let calls = 0;
    const execute = (command, args) => {
      calls++;
      assert.equal(command, 'dpkg-deb'); assert.equal(args[0], '--extract');
      const tree = args[2];
      for (const name of [...Object.values(manifest.modules).flatMap(module => Object.keys(module.files)), ...routeFiles('linux')]) {
        const file = path.join(tree, 'usr/lib/Creator Hub/modules', name);
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, name, { mode: 0o755 });
      }
      fs.mkdirSync(path.join(tree, 'usr/bin'), { recursive: true });
      const bundled = Buffer.from(raw); bundled.write('DEB', raw.indexOf('_UNK') + 1);
      fs.writeFileSync(path.join(tree, 'usr/bin/creator-hub'), bundled, { mode: 0o755 });
    };
    const report = validatePackages({ output, bundleDirectory, manifest, productName: 'Creator Hub', rawHub, execute,
      mcpMode: 'writable', linuxRetirementCandidate: true });
    assert.equal(calls, 1);
    assert.deepEqual(report.packages.map(entry => entry.format), ['deb']);
    assert.equal(report.integrityPassed, true); assert.equal(report.releaseReady, false);
    assert.equal(Object.keys(report.packages[0].files).length, 15);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('existing workflow compiles the opt-in feature and retains separate receipts without release or privileged policy bypass', () => {
  const workflow = fs.readFileSync(path.join(repo, '.github/workflows/unix-managed-assembly.yml'), 'utf8');
  assert.match(workflow, /linux_retirement_test_candidate:[\s\S]*?type: boolean\s+default: false/);
  assert.ok(workflow.includes('if: runner.os == \'Linux\' && inputs.linux_retirement_test_candidate'));
  assert.ok(workflow.includes('extra+=(--linux-retirement-test-candidate)'));
  assert.ok(workflow.indexOf('scripts/linux-retirement-package.test.cjs') < workflow.indexOf('id: package'));
  assert.ok(workflow.indexOf('scripts/linux-retirement-package-verify.test.py') < workflow.indexOf('id: package'));
  assert.ok(workflow.includes('linux-retirement-package-integrity.json'));
  assert.doesNotMatch(workflow, /gh release|dpkg --install|auth_admin_keep|\.pkla|addRule/);
  const buildSource = fs.readFileSync(path.join(repo, 'scripts/build-unified.cjs'), 'utf8');
  const signed = buildSource.slice(buildSource.indexOf('function buildSignedUnix('));
  assert.match(signed, /'--config', overlay/);
  assert.match(signed, /retirement \? \['deb'\] : plan\.bundles/);
});

test('modified assembly workflow parses with its default-false boolean and unchanged Linux runner', t => {
  const source = fs.readFileSync(path.join(repo, '.github/workflows/unix-managed-assembly.yml'), 'utf8');
  const parsed = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c',
    'import sys,yaml; p=yaml.load(sys.stdin.read(),Loader=yaml.BaseLoader); i=p["on"]["workflow_dispatch"]["inputs"]["linux_retirement_test_candidate"]; assert i["type"]=="boolean" and i["default"]=="false"; assert p["jobs"]["assembly"]["runs-on"]=="ubuntu-22.04"'],
  { input: source, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (parsed.stderr?.includes("No module named 'yaml'")) return t.skip('Optional local PyYAML is unavailable');
  assert.equal(parsed.status, 0, parsed.stderr || parsed.error?.message);
});
