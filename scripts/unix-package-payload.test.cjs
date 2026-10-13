const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { moduleFiles } = require('./build-unified.cjs');
const { routeFiles } = require('./managed-router-package.cjs');
const { nativePlan, packageEnvironment, verifyHostedBinding, verifyResources, verifyLayout,
  verifyLinuxHub, extract, validatePackages } = require('./unix-package-payload.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('Mac Hub and bundled MCP declare the minimum supported by their pinned Node runtime', () => {
  const root = path.join(__dirname, '..');
  const runtime = fs.readFileSync(path.join(root, 'modules/mcp/scripts/stage-node-runtime.mjs'), 'utf8');
  assert.match(runtime, /const DEFAULT_VERSION = "24\.17\.0"/);
  for (const file of ['src-tauri/tauri.conf.json', 'modules/mcp/launcher/src-tauri/tauri.conf.json']) {
    const config = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    assert.equal(config.bundle.macOS.minimumSystemVersion, '13.5');
  }
});

function fixture(platform = 'linux', managed = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'creator-unix-package-')));
  const output = path.join(root, 'candidate');
  fs.mkdirSync(output);
  const manifest = { schemaVersion: 1, platform, arch: 'x86_64', modules: {} };
  const payload = {};
  for (const id of ['mcp', 'setup']) {
    const files = {};
    for (const name of moduleFiles(id, platform)) { payload[name] = Buffer.from(`fixture:${name}`); files[name] = hash(payload[name]); }
    manifest.modules[id] = { executable: moduleFiles(id, platform)[0], version: '1.0.0', files };
  }
  if (managed) {
    const files = {};
    for (const name of routeFiles(platform)) { payload[name] = Buffer.from(`routing-fixture:${name}`); files[name] = hash(payload[name]); }
    manifest.managedRouting = { protocol: 1, files };
  }
  const descriptor = JSON.stringify(manifest, null, 2);
  const raw = Buffer.from(`ELF-fixture\0__TAURI_BUNDLE_TYPE_VAR_UNK\0${descriptor}`);
  const rawHub = path.join(output, 'creator-hub');
  fs.writeFileSync(rawHub, raw);
  fs.writeFileSync(path.join(output, 'builtin-manifest.json'), descriptor);
  function layout(dir, format) {
    const tree = format === 'appimage' ? path.join(dir, 'squashfs-root') : format === 'dmg' ? path.join(dir, 'Creator Hub.app') : dir;
    const resource = path.join(tree, platform === 'macos' ? 'Contents/Resources/modules' : 'usr/lib/Creator Hub/modules');
    for (const [name, bytes] of Object.entries(payload)) {
      const file = path.join(resource, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { mode: 0o755 });
    }
    const hub = path.join(tree, platform === 'macos' ? 'Contents/MacOS/creator-hub' : 'usr/bin/creator-hub');
    fs.mkdirSync(path.dirname(hub), { recursive: true });
    const bytes = Buffer.from(raw);
    if (platform === 'linux') bytes.write({ deb: 'DEB', rpm: 'RPM', appimage: 'APP' }[format], raw.indexOf(Buffer.from('_UNK')) + 1);
    fs.writeFileSync(hub, bytes, { mode: 0o755 });
    return { resource, hub };
  }
  return { root, output, manifest, payload, raw, rawHub, layout, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('Unix packaging is explicit, native-targeted, read-only and not Windows opt-in', () => {
  for (const platform of ['linux', 'macos']) for (const arch of ['x86_64', 'aarch64']) {
    assert.throws(() => nativePlan(platform, arch), /refuses by default/);
    const plan = nativePlan(platform, arch, { experimentalUnix: true, installer: true });
    assert.equal(plan.mcpMode, 'read-only'); assert.equal(plan.experimentalUnix, true);
    assert.equal(plan.rustTarget, `${arch}-${platform === 'macos' ? 'apple-darwin' : 'unknown-linux-gnu'}`);
    assert.deepEqual(plan.bundles, platform === 'macos' ? ['app', 'dmg'] : ['appimage', 'deb', 'rpm']);
  }
  assert.deepEqual(nativePlan('windows', 'x86_64', { installer: true }).bundles, ['nsis']);
  assert.equal(nativePlan('windows', 'x86_64').mcpMode, 'writable');
  assert.throws(() => nativePlan('windows', 'x86_64', { experimentalUnix: true }), /Unix-only/);
  for (const [platform, arch] of [['freebsd', 'x86_64'], ['linux', 'arm'], ['windows', 'aarch64']]) assert.throws(() => nativePlan(platform, arch, { experimentalUnix: true }), /Unsupported/);
});

test('automatic credential use is refused; explicit managed signer variables are not changed', () => {
  const env = { CREATOR_MCP_HOST_WRITABLE: '1', NO_STRIP: '0', CREATOR_HUB_SIGNING_KEY_PATH: '/not-opened-by-this-test', CREATOR_HUB_SIGNING_PASSWORD: 'test-placeholder' };
  const result = packageEnvironment(env, 'linux');
  assert.equal(result.CREATOR_MCP_HOST_WRITABLE, '0'); assert.equal(result.CREATOR_MCP_HOST_READONLY_EVENTS, '1'); assert.equal(result.NO_STRIP, '1');
  assert.equal(result.CREATOR_HUB_SIGNING_KEY_PATH, env.CREATOR_HUB_SIGNING_KEY_PATH);
  assert.equal(result.CREATOR_HUB_SIGNING_PASSWORD, env.CREATOR_HUB_SIGNING_PASSWORD);
  assert.equal(env.CREATOR_MCP_HOST_WRITABLE, '1');
  for (const name of ['APPLE_ID', 'APPLE_CERTIFICATE', 'APPLE_SIGNING_IDENTITY', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_RPM_KEY']) assert.throws(() => packageEnvironment({ [name]: 'not-read' }, 'macos'), /without.*credentials/);
});

test('writable Unix experiments require both explicit opt-in and the signed managed route', () => {
  for (const platform of ['linux', 'macos']) {
    for (const options of [
      { experimentalWritable: true },
      { experimentalUnix: true, experimentalWritable: true },
      { experimentalUnix: true, experimentalWritable: true, managed: false },
      { experimentalUnix: true, experimentalWritable: 'true', managed: true },
    ]) assert.throws(() => nativePlan(platform, 'x86_64', options));
    const plan = nativePlan(platform, 'x86_64', { experimentalUnix: true, experimentalWritable: true, managed: true });
    assert.equal(plan.mcpMode, 'writable');
    assert.equal(plan.experimentalUnix, true);
    assert.equal(packageEnvironment({}, platform, plan.mcpMode).CREATOR_MCP_HOST_WRITABLE, '1');
    assert.equal(packageEnvironment({ CREATOR_MCP_HOST_WRITABLE: '1' }, platform).CREATOR_MCP_HOST_WRITABLE, '0');
  }
  assert.throws(() => nativePlan('windows', 'x86_64', { experimentalWritable: true, managed: true }), /Experimental writable Unix/);
  assert.throws(() => packageEnvironment({}, 'linux', 'production'), /Unknown experimental/);
});

test('post-compile Node re-signing cannot be hidden by re-hashing a manifest', () => {
  const f = fixture('macos');
  try {
    const names = ['mcp/server/creator-works-mcp.mjs', 'mcp/server/runtime/node', 'mcp/server/unity-extension/Editor/BanterMCPBridge.cs', 'mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png'];
    const compiled = Object.fromEntries(names.map(name => [name, f.manifest.modules.mcp.files[name]]));
    verifyHostedBinding(f.manifest, compiled, compiled);
    assert.throws(() => verifyHostedBinding(f.manifest, { a: undefined, b: undefined, c: undefined, d: undefined }, {}), /invalid.*snapshot/);
    const node = 'mcp/server/runtime/node';
    f.manifest.modules.mcp.files[node] = hash(Buffer.from('different CodeDirectory/signature bytes'));
    assert.throws(() => verifyHostedBinding(f.manifest, compiled, compiled), /after backend compilation/);
    const changed = { ...compiled, [node]: f.manifest.modules.mcp.files[node] };
    assert.throws(() => verifyHostedBinding(f.manifest, compiled, changed), /Do not re-hash/);
  } finally { f.cleanup(); }
});

test('Mac backend enforcement is signed before manifest binding without changing pinned Node', () => {
  const source = fs.readFileSync(path.join(__dirname, 'build-unified.cjs'), 'utf8');
  assert.match(source, /platform === 'macos' && name === `\$\{id\}\/\$\{binary\}`/);
  assert.match(source, /\['--force', '--sign', '-', '--options', 'hard,kill', dest\]/);
  assert.ok(source.indexOf("'hard,kill', dest") < source.indexOf('files[name] = sha256(dest)'));
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/unified-unix-candidate.yml'), 'utf8');
  for (const changed of ['src-tauri/src/hosted.rs', 'modules/mcp/launcher/src-tauri/**', 'native/mcp-router/**']) {
    assert.ok(workflow.includes(`'${changed}'`));
  }
});

test('exact-byte tamper, atomic replacement, missing and extra resources fail', () => {
  const f = fixture('linux', true);
  try {
    const dir = path.join(f.root, 'extracted');
    const { resource } = f.layout(dir, 'deb');
    verifyResources(resource, f.manifest);
    const node = path.join(resource, 'mcp/server/runtime/node');
    const bytes = fs.readFileSync(node); const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
    fs.writeFileSync(node, changed); assert.throws(() => verifyResources(resource, f.manifest), /changed/);
    fs.writeFileSync(node, bytes);
    const replacement = path.join(f.root, 'replacement'); fs.writeFileSync(replacement, changed); fs.renameSync(replacement, node);
    assert.throws(() => verifyResources(resource, f.manifest), /changed/);
    fs.writeFileSync(node, bytes); fs.chmodSync(node, 0o755);
    const extra = path.join(resource, 'mcp/unlisted.mjs'); fs.writeFileSync(extra, 'extra');
    assert.throws(() => verifyResources(resource, f.manifest), /Unlisted/); fs.unlinkSync(extra);
    fs.unlinkSync(path.join(resource, 'routing/runtime.minisig')); assert.throws(() => verifyResources(resource, f.manifest), /incomplete/);
  } finally { f.cleanup(); }
});

test('Unix execute modes and redirected resource/Hub ancestors are refused', { skip: process.platform === 'win32' }, () => {
  const f = fixture();
  try {
    const dir = path.join(f.root, 'extracted'); const { resource } = f.layout(dir, 'deb');
    const node = path.join(resource, 'mcp/server/runtime/node'); fs.chmodSync(node, 0o644);
    assert.throws(() => verifyResources(resource, f.manifest), /execute mode/); fs.chmodSync(node, 0o755);
    const old = path.join(resource, 'mcp/server-original'); fs.renameSync(path.join(resource, 'mcp/server'), old);
    fs.symlinkSync(old, path.join(resource, 'mcp/server')); assert.throws(() => verifyResources(resource, f.manifest), /redirected/);
    fs.unlinkSync(path.join(resource, 'mcp/server')); fs.renameSync(old, path.join(resource, 'mcp/server'));
    const bin = path.join(dir, 'usr/bin'); const alias = path.join(dir, 'usr/bin-original'); fs.renameSync(bin, alias); fs.symlinkSync(alias, bin);
    assert.throws(() => verifyLayout(dir, 'deb', f.manifest, 'Creator Hub', f.rawHub), /ancestor is redirected/);
  } finally { f.cleanup(); }
});

test('only documented exact Linux marker changes are allowed in packaged Hub', () => {
  const raw = Buffer.from('code\0__TAURI_BUNDLE_TYPE_VAR_UNK\0data');
  for (const [format, marker] of Object.entries({ deb: 'DEB', rpm: 'RPM', appimage: 'APP' })) {
    const packed = Buffer.from(raw); packed.write(marker, raw.indexOf('_UNK') + 1);
    verifyLinuxHub(raw, packed, format);
    const bad = Buffer.from(packed); bad[0] ^= 1; assert.throws(() => verifyLinuxHub(raw, bad, format), /beyond the exact/);
    assert.throws(() => verifyLinuxHub(raw, raw, format), /beyond the exact/);
  }
  assert.throws(() => verifyLinuxHub(Buffer.concat([raw, raw]), raw, 'deb'), /one Tauri/);
});

test('Linux extraction uses no installers/scripts and retains hashes without readiness claims', () => {
  const f = fixture('linux', true);
  try {
    const bundle = path.join(f.root, 'bundle');
    for (const [format, ext] of [['deb', '.deb'], ['rpm', '.rpm'], ['appimage', '.AppImage']]) {
      fs.mkdirSync(path.join(bundle, format), { recursive: true }); fs.writeFileSync(path.join(bundle, format, `candidate${ext}`), 'container fixture');
    }
    const calls = [];
    const execute = (file, args, options) => {
      calls.push([file, args]);
      if (file === 'dpkg-deb') { assert.equal(args[0], '--extract'); f.layout(options.cwd, 'deb'); }
      else if (file === 'bsdtar') { assert.equal(args[0], '-xf'); assert.ok(args[1].endsWith('.rpm')); assert.equal(options.input, undefined); f.layout(options.cwd, 'rpm'); }
      else { assert.equal(args[0], '--appimage-extract'); f.layout(options.cwd, 'appimage'); }
      return Buffer.from('');
    };
    const result = validatePackages({ output: f.output, bundleDirectory: bundle, manifest: f.manifest, productName: 'Creator Hub', rawHub: f.rawHub, execute });
    assert.equal(result.integrityPassed, true); assert.equal(result.writableGuiAccepted, false); assert.equal(result.releaseReady, false); assert.equal(result.mcpMode, 'read-only');
    assert.deepEqual(result.packages.map(entry => entry.format), ['deb', 'rpm', 'appimage']);
    assert.equal(calls.length, 3);
    assert.equal(calls.some(([command]) => command === 'rpm2cpio'), false);
    for (const entry of result.packages) assert.equal(entry.sha256, hash(fs.readFileSync(path.join(f.output, entry.path))));
    assert.throws(() => validatePackages({ output: f.output, bundleDirectory: bundle, manifest: f.manifest, productName: 'Creator Hub', rawHub: f.rawHub, execute }), /EEXIST/);
  } finally { f.cleanup(); }
});

test('failed package integrity retains failure evidence, never rewrites descriptor hashes', () => {
  const f = fixture();
  try {
    const bundle = path.join(f.root, 'bundle/deb'); fs.mkdirSync(bundle, { recursive: true }); fs.writeFileSync(path.join(bundle, 'candidate.deb'), 'fixture');
    const before = JSON.stringify(f.manifest);
    const execute = (_, __, options) => { const { resource } = f.layout(options.cwd, 'deb'); fs.appendFileSync(path.join(resource, 'mcp/server/runtime/node'), 'changed'); };
    assert.throws(() => validatePackages({ output: f.output, bundleDirectory: path.dirname(bundle), manifest: f.manifest, productName: 'Creator Hub', rawHub: f.rawHub, execute }), /changed/);
    assert.equal(JSON.stringify(f.manifest), before);
    const report = JSON.parse(fs.readFileSync(path.join(f.output, 'unix-package-integrity.json')));
    assert.equal(report.integrityPassed, false); assert.equal(report.releaseReady, false);
  } finally { f.cleanup(); }
});

test('DMG attaches read-only/no-open and detaches its own mount on partial failure', () => {
  const f = fixture('macos');
  try {
    const dmg = path.join(f.root, 'fixture.dmg'); fs.writeFileSync(dmg, 'fixture'); const calls = [];
    for (const name of ['../elsewhere', 'C:/elsewhere', '..', ' Creator Hub']) assert.throws(() => extract(dmg, 'dmg', path.join(f.root, 'never-created'), name, () => assert.fail('Must not invoke a tool')), /Invalid.*name/);
    assert.equal(fs.existsSync(path.join(f.root, 'never-created')), false);
    assert.throws(() => extract(dmg, 'dmg', path.join(f.root, 'extract'), 'Creator Hub', (file, args) => {
      calls.push([file, args]); if (args[0] === 'attach') { assert.ok(args.includes('-readonly') && args.includes('-noautoopen')); throw Error('partial attach failure'); }
    }), /partial attach failure/);
    assert.equal(calls[1][1][0], 'detach');
    assert.equal(calls[1][1][1], calls[0][1][calls[0][1].indexOf('-mountpoint') + 1]);
  } finally { f.cleanup(); }
});

test('Mac app and DMG resource bytes are checked after signing, not silently re-hashed', () => {
  const f = fixture('macos');
  try {
    const bundle = path.join(f.root, 'bundle'); const app = path.join(bundle, 'macos/Creator Hub.app'); f.layout(app, 'app');
    fs.mkdirSync(path.join(bundle, 'dmg')); fs.writeFileSync(path.join(bundle, 'dmg/candidate.dmg'), 'fixture');
    const calls = [];
    const execute = (file, args) => {
      calls.push([file, args]);
      if (file === 'hdiutil' && args[0] === 'attach') { const mount = args[args.indexOf('-mountpoint') + 1]; f.layout(mount, 'dmg'); }
      return Buffer.from('');
    };
    const result = validatePackages({ output: f.output, bundleDirectory: bundle, manifest: f.manifest, productName: 'Creator Hub', rawHub: f.rawHub, execute });
    assert.deepEqual(result.packages.map(entry => entry.format), ['app', 'dmg']); assert.equal(result.integrityPassed, true);
    assert.equal(result.packages[0].hubSha256, result.packages[1].hubSha256);
    assert.equal(calls.filter(([file]) => file === 'codesign').length, 2);
    assert.equal(hash(fs.readFileSync(path.join(f.output, 'native-packages/Creator Hub.app/Contents/Resources/modules/mcp/server/runtime/node'))), f.manifest.modules.mcp.files['mcp/server/runtime/node']);
  } finally { f.cleanup(); }
});

test('CLI rejects duplicate/unrecognized switches before any native build or key access', () => {
  for (const flags of [['--experimental-unix', '--experimental-unix'], ['--experimentalUnix'], ['--experimental-unix', '--features']]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'build-unified.cjs'), 'must-not-build', ...flags], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /optional.*experimental-unix/);
  }
  const source = fs.readFileSync(path.join(__dirname, 'build-unified.cjs'), 'utf8');
  assert.match(source, /managed \? routing.signingKey\(root\) : null/);
  assert.match(source, /file => routing.signDetached\(file, key\)/);
  assert.doesNotMatch(source, /--no-sign/);
  assert.match(source, /id === 'mcp' && experimentalWritable \? \['--features', 'experimental-unix-hosting'\] : \[\]/);
  assert.match(source, /mcpMode: plan.mcpMode, writableGuiAccepted: false, releaseReady: false/);
});

test('Mac DMG failures expose subprocess diagnostics and retain actual signed inputs', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/unified-unix-candidate.yml'), 'utf8');
  assert.match(workflow, /TAURI_CLI_VERBOSITY: '1'/);
  const step = workflow.slice(workflow.indexOf('      - name: Retain the actual failed Mac DMG inputs'), workflow.indexOf('      - name: Retain package/integrity evidence'));
  assert.match(step, /if: failure\(\) && runner.os == 'macOS'/);
  assert.match(step, /tar -czf.*signed-app-before-dmg\.tar\.gz/);
  assert.match(step, /cp.*bundle_dmg\.sh/);
  assert.doesNotMatch(step, /codesign|spctl|xattr|sudo|--dereference|rm /);
  assert.match(workflow, /ci-native-package\/dmg-failure-inputs\//);
});
