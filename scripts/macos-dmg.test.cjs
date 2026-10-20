const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { moduleFiles } = require('./build-unified.cjs');
const { assertNativeRunner, appInventory, createDmg } = require('./macos-dmg.cjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const tempParent = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tempParent, 'creator-dmg-unit-')));
  t.after(() => { assert.equal(path.dirname(root), tempParent); assert.equal(fs.realpathSync(root), root);
    fs.rmSync(root, { recursive: true, force: true }); });
  const input = path.join(root, 'inputs');
  const app = path.join(input, 'Creator Hub.app');
  const manifest = { schemaVersion: 1, platform: 'macos', arch: 'x86_64', modules: {} };
  for (const id of ['mcp', 'setup']) {
    const files = {};
    for (const name of moduleFiles(id, 'macos')) {
      const bytes = Buffer.from(`unit-only-signed-fixture:${name}`);
      const file = path.join(app, 'Contents/Resources/modules', name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes, { mode: 0o755 });
      files[name] = sha(bytes);
    }
    manifest.modules[id] = { executable: moduleFiles(id, 'macos')[0], version: '1.0.0', files };
  }
  const descriptor = JSON.stringify(manifest, null, 2);
  const manifestFile = path.join(input, 'builtin-manifest.json');
  fs.writeFileSync(manifestFile, descriptor);
  const hub = path.join(app, 'Contents/MacOS/creator-hub');
  fs.mkdirSync(path.dirname(hub));
  const hubBytes = Buffer.from(`unit-only-code-seal\0${descriptor}`);
  fs.writeFileSync(hub, hubBytes, { mode: 0o755 });
  const rawHub = path.join(input, 'raw-hub');
  fs.writeFileSync(rawHub, 'original caller RootH bytes', { mode: 0o755 });
  const uid = fs.lstatSync(root).uid;
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS', RUNNER_ARCH: 'X64',
    CREATOR_MACOS_DMG_EXPERIMENT: '1', RUNNER_TEMP: root };
  const options = { experimental: true, sourceApp: app, destination: path.join(root, 'candidate.dmg'),
    dataScope: { root: input, manifestFile, manifestSha256: sha(Buffer.from(descriptor)), hubSha256: sha(hubBytes),
      appTreeSha256: appInventory(app, { uid }).sha256, preservedFiles: [{ path: rawHub, sha256: sha(fs.readFileSync(rawHub)) }] } };
  // Windows junction semantics are adapted only inside this pure tool fixture.
  // Production has no filesystem adapter or Windows/native acceptance bypass.
  if (process.platform === 'win32') {
    const linkTarget = path.join(root, 'unit-applications');
    fs.mkdirSync(linkTarget);
    const symlink = fs.symlinkSync.bind(fs), readlink = fs.readlinkSync.bind(fs);
    t.mock.method(fs, 'symlinkSync', (target, file, type) => symlink(target === '/Applications' ? linkTarget : target,
      file, target === '/Applications' ? 'junction' : type));
    t.mock.method(fs, 'readlinkSync', file => {
      const target = readlink(file);
      return target === linkTarget ? '/Applications' : target;
    });
  }
  const calls = [];
  let mutate = () => {};
  const execute = (file, args, toolOptions) => {
    calls.push([file, [...args]]);
    assert.equal(toolOptions.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
    assert.equal(toolOptions.env.APPLE_PASSWORD, undefined);
    if (file === '/usr/bin/ditto') {
      fs.cpSync(args.at(-2), args.at(-1), { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    } else if (file === '/usr/bin/hdiutil' && args[0] === 'create') {
      fs.writeFileSync(args.at(-1), 'not-a-native-DMG; unit fixture only', { flag: 'wx' });
    }
    mutate(file, args);
    return Buffer.from('unit-injected-tool-success');
  };
  const context = { platform: 'darwin', arch: 'x64', env, uid, execute };
  const report = () => {
    const work = fs.readdirSync(root).find(name => name.startsWith('.creator-hub-dmg-'));
    assert.ok(work);
    return JSON.parse(fs.readFileSync(path.join(root, work, 'report.json')));
  };
  return { root, input, app, hub, rawHub, manifestFile, manifest, uid, options, context, calls, report,
    mutate: fn => { mutate = fn; }, node: path.join(app, 'Contents/Resources/modules/mcp/server/runtime/node') };
}

test('native Mac and explicit disposable opt-in precede all input inspection', async () => {
  const base = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS', RUNNER_ARCH: 'X64', CREATOR_MACOS_DMG_EXPERIMENT: '1' };
  assertNativeRunner(true, { platform: 'darwin', arch: 'x64', env: base, uid: 0 });
  for (const [name, value] of [['GITHUB_ACTIONS', 'false'], ['RUNNER_ENVIRONMENT', 'self-hosted'], ['RUNNER_OS', 'Linux'],
    ['RUNNER_ARCH', 'ARM64'], ['CREATOR_MACOS_DMG_EXPERIMENT', ''], ['APPLE_PASSWORD', 'not-read'], ['TAURI_SIGNING_PRIVATE_KEY', 'not-read'],
    ['DITTONORSRC', '1'], ['DYLD_LIBRARY_PATH', 'not-read']]) {
    assert.throws(() => assertNativeRunner(true, { platform: 'darwin', arch: 'x64', env: { ...base, [name]: value }, uid: 0 }));
  }
  for (const platform of ['win32', 'linux']) await assert.rejects(createDmg({ sourceApp: 'must-not-read' },
    { platform, env: base, execute: () => assert.fail('No native tool') }), /native Mac/);
  await assert.rejects(createDmg({ experimental: false, sourceApp: 'must-not-read' }, { platform: 'darwin', env: base }), /native Mac/);
});

test('headless create uses exact signed staging and no layout, signing, mounting or process signals', async t => {
  const f = fixture(t);
  const before = appInventory(f.app, { uid: f.uid });
  const report = await createDmg(f.options, f.context);
  assert.equal(report.status, 'passed');
  assert.equal(report.sourceUnchanged, true);
  assert.equal(report.releaseReady, false);
  assert.equal(report.productAccepted, false);
  assert.equal(report.notarizationVerified, false);
  assert.equal(report.nativeToolsUsed, false);
  assert.equal(report.dmg.sha256, sha(fs.readFileSync(f.options.destination)));
  assert.deepEqual(appInventory(f.app, { uid: f.uid }), before);
  const create = f.calls.find(([file, args]) => file === '/usr/bin/hdiutil' && args[0] === 'create');
  assert.deepEqual(create[1], ['create', '-srcfolder', report.stage, '-volname', 'Creator Hub', '-fs', 'HFS+', '-format', 'UDZO', '-o', path.join(report.work, 'image.dmg')]);
  for (const [file, args] of f.calls) {
    assert.ok(['/usr/bin/codesign', '/usr/bin/ditto', '/usr/bin/hdiutil'].includes(file));
    if (file.endsWith('codesign')) assert.deepEqual(args.slice(0, 3), ['--verify', '--deep', '--strict']);
    assert.ok(!args.some(arg => ['--force', '-force', '-ov', '--sign', 'attach', 'detach', 'kill', 'osascript'].includes(arg)));
  }
  assert.deepEqual(fs.readdirSync(report.stage).sort(), ['Applications', 'Creator Hub.app']);
  const source = fs.readFileSync(path.join(__dirname, 'macos-dmg.cjs'), 'utf8');
  assert.doesNotMatch(source, /\.kill\(|process\.kill|execFileSync|fs\.rm|unlinkSync|SIGKILL|SIGTERM/);
  assert.match(source, /child\.unref\(\)/);
});

test('optional indexing marker is a sibling, never inside signed app', async t => {
  const f = fixture(t);
  const report = await createDmg({ ...f.options, metadataNeverIndex: true }, f.context);
  assert.equal(fs.statSync(path.join(report.stage, '.metadata_never_index')).size, 0);
  assert.equal(fs.existsSync(path.join(report.stage, 'Creator Hub.app/.metadata_never_index')), false);
});

test('existing destination and publication races never overwrite bytes', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.options.destination, 'preexisting');
  await assert.rejects(createDmg(f.options, f.context), /overwrite refused/);
  assert.equal(fs.readFileSync(f.options.destination, 'utf8'), 'preexisting');
  assert.equal(f.calls.length, 0);
  f.options.destination = path.join(f.root, 'raced.dmg');
  f.mutate((file, args) => { if (file.endsWith('hdiutil') && args[0] === 'verify') fs.writeFileSync(f.options.destination, 'raced owner bytes'); });
  await assert.rejects(createDmg(f.options, f.context), /EEXIST/);
  assert.equal(fs.readFileSync(f.options.destination, 'utf8'), 'raced owner bytes');
  assert.equal(f.report().status, 'failed');
});

test('destination/source namespace escape and wrong ownership refuse before tools', async t => {
  const f = fixture(t);
  for (const destination of [path.join(f.input, 'inside.dmg'), path.join(f.root, '../escape.dmg'), 'relative.dmg']) {
    await assert.rejects(createDmg({ ...f.options, destination }, f.context));
  }
  await assert.rejects(createDmg(f.options, { ...f.context, uid: f.uid + 1 }), /owned/);
  const other = path.join(f.root, 'outside.app');
  fs.mkdirSync(other);
  await assert.rejects(createDmg({ ...f.options, sourceApp: other }, f.context), /approved caller data scope/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(createDmg({ ...f.options, mcpMode: 'writable' }, f.context), /read-only/);
});

test('independent app, manifest and Hub pins cannot be rehashed around differences', async t => {
  const f = fixture(t);
  for (const name of ['appTreeSha256', 'manifestSha256', 'hubSha256']) {
    const destination = path.join(f.root, `${name}.dmg`);
    await assert.rejects(createDmg({ ...f.options, destination, dataScope: { ...f.options.dataScope, [name]: 'b'.repeat(64) } }, f.context), /pin|checksum/);
  }
  assert.equal(f.calls.length, 0);
});

test('signed Node/source byte mutation fails and original input is not repaired', async t => {
  const f = fixture(t);
  const original = fs.readFileSync(f.node);
  f.mutate((file, args) => { if (file.endsWith('hdiutil') && args[0] === 'create') fs.writeFileSync(f.node, 'mutated signed Node'); });
  await assert.rejects(createDmg(f.options, f.context), /Signed app bytes/);
  const report = f.report();
  assert.equal(report.status, 'failed');
  assert.equal(report.sourceUnchanged, false);
  assert.match(report.error, /Signed app bytes/);
  assert.ok(report.preservationErrors.length);
  assert.equal(fs.readFileSync(f.node, 'utf8'), 'mutated signed Node');
  assert.equal(fs.existsSync(f.options.destination), false);
  assert.notDeepEqual(fs.readFileSync(f.node), original);
});

test('caller RootH/S before-images remain independently enforced', async t => {
  const f = fixture(t);
  f.mutate((file, args) => { if (file.endsWith('hdiutil') && args[0] === 'create') fs.writeFileSync(f.rawHub, 'changed original RootH'); });
  await assert.rejects(createDmg(f.options, f.context), /Protected caller input changed/);
  assert.equal(f.report().status, 'failed');
  assert.equal(f.report().sourceUnchanged, true);
  assert.equal(fs.readFileSync(f.rawHub, 'utf8'), 'changed original RootH');
  assert.equal(fs.existsSync(f.options.destination), false);
});

test('copy contamination cannot produce a passed receipt', async t => {
  const f = fixture(t);
  f.mutate((file, args) => { if (file.endsWith('ditto')) fs.writeFileSync(path.join(args.at(-1), '.DS_Store'), 'unexpected layout'); });
  await assert.rejects(createDmg(f.options, f.context), /Signed app bytes/);
  assert.equal(f.report().status, 'failed');
  assert.ok(!f.calls.some(([file]) => file.endsWith('hdiutil')));
});

test('nonzero busy tool preserves partial image, original stderr and failure receipt without recovery', async t => {
  const f = fixture(t);
  const original = Object.assign(new Error('confirmed tool failure fixture'), { status: 16, stderr: Buffer.from('hdiutil: Resource busy') });
  f.mutate((file, args) => { if (file.endsWith('hdiutil') && args[0] === 'create') throw original; });
  await assert.rejects(createDmg(f.options, f.context), error => error === original);
  const report = f.report();
  assert.equal(report.status, 'failed');
  assert.equal(report.error, original.message);
  const failed = report.tools.at(-1);
  assert.equal(failed.exitCode, 16);
  assert.equal(fs.readFileSync(path.join(report.work, failed.stderr), 'utf8'), 'hdiutil: Resource busy');
  assert.ok(fs.existsSync(path.join(report.work, 'image.dmg')));
  assert.ok(fs.existsSync(report.stage));
  assert.equal(f.calls.filter(([file, args]) => file.endsWith('hdiutil') && args[0] === 'create').length, 1);
  assert.equal(fs.existsSync(f.options.destination), false);
});

test('deadline records possibly surviving owned tool and never promotes incomplete image', async t => {
  const f = fixture(t);
  f.mutate((file, args) => { if (file.endsWith('hdiutil') && args[0] === 'create') {
    throw Object.assign(new Error('owned deadline fixture'), { pid: 4321, toolMayStillRun: true });
  } });
  await assert.rejects(createDmg(f.options, f.context), /owned deadline/);
  const report = f.report();
  assert.equal(report.status, 'failed');
  assert.equal(report.tools.at(-1).toolMayStillRun, true);
  assert.equal(report.tools.at(-1).pid, 4321);
  assert.equal(report.releaseReady, false);
  assert.equal(fs.existsSync(f.options.destination), false);
});

test('source symlink escape refuses before tool invocation', async t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside-source');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.app, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createDmg(f.options, f.context), /symlink/);
  assert.equal(f.calls.length, 0);
});

test('source hardlink aliases are refused before tool invocation', async t => {
  const f = fixture(t);
  fs.linkSync(f.node, path.join(f.root, 'node-hardlink'));
  await assert.rejects(createDmg(f.options, f.context), /hardlink/);
  assert.equal(f.calls.length, 0);
});

test('source permission changes are evidence failures, never chmod repairs', async t => {
  const f = fixture(t);
  f.mutate((file, args) => { if (file.endsWith('hdiutil') && args[0] === 'create') fs.chmodSync(f.node, 0o444); });
  await assert.rejects(createDmg(f.options, f.context), /Signed app bytes/);
  assert.equal(f.report().sourceUnchanged, false);
  assert.equal(fs.lstatSync(f.node).mode & 0o222, 0);
});

test('late staged mutation after verification still overrides any apparent pass', async t => {
  const f = fixture(t);
  let signatures = 0;
  f.mutate((file, args) => { if (file.endsWith('codesign') && ++signatures === 3) {
    fs.writeFileSync(path.join(args.at(-1), 'Contents/Resources/modules/mcp/server/runtime/node'), 'late stage corruption');
  } });
  await assert.rejects(createDmg(f.options, f.context), /Signed app bytes/);
  const report = f.report();
  assert.equal(report.status, 'failed');
  assert.equal(report.stageUnchanged, false);
  assert.equal(report.sourceUnchanged, true);
  assert.equal(fs.existsSync(f.options.destination), false);
});

test('original tool error survives additional preservation failures', async t => {
  const f = fixture(t);
  const original = Object.assign(new Error('original busy failure'), { status: 16, stderr: Buffer.from('original native stderr') });
  f.mutate((file, args) => { if (file.endsWith('hdiutil') && args[0] === 'create') {
    fs.writeFileSync(f.rawHub, 'mutated original root image');
    throw original;
  } });
  await assert.rejects(createDmg(f.options, f.context), error => error instanceof AggregateError && error.errors[0] === original);
  assert.equal(f.report().error, original.message);
  assert.ok(f.report().preservationErrors.length);
});

test('original descriptor mutation cannot be concealed by its preloaded parsed object', async t => {
  const f = fixture(t);
  f.mutate((file, args) => { if (file.endsWith('hdiutil') && args[0] === 'create') fs.writeFileSync(f.manifestFile, '{"mutated":true}'); });
  await assert.rejects(createDmg(f.options, f.context), /Protected caller input changed/);
  assert.equal(f.report().status, 'failed');
  assert.equal(fs.readFileSync(f.manifestFile, 'utf8'), '{"mutated":true}');
  assert.equal(fs.existsSync(f.options.destination), false);
});

test('redirected staged app cannot alias the immutable source namespace', async t => {
  const f = fixture(t);
  f.mutate((file, args) => { if (file.endsWith('ditto')) {
    const staged = args.at(-1);
    assert.ok(staged.startsWith(`${f.root}${path.sep}.creator-hub-dmg-`));
    assert.equal(fs.realpathSync(staged), staged);
    fs.rmSync(staged, { recursive: true }); // Only the newly created injected unit copy.
    fs.symlinkSync(f.app, staged, process.platform === 'win32' ? 'junction' : 'dir');
  } });
  await assert.rejects(createDmg(f.options, f.context), /unredirected/);
  assert.equal(f.report().sourceUnchanged, true);
  assert.ok(!f.calls.some(([file]) => file.endsWith('hdiutil')));
});
