'use strict';
// Synthetic bytes, mocked native tools and source parsing only. Never builds or runs an app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const p = require('./flatpak-native-production-016.cjs');
const prototype = require('./flatpak-native-activation.cjs');
function environment() {
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: p.REPO, GITHUB_REPOSITORY_ID: String(p.REPO_ID), GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: p.BRANCH, GITHUB_WORKFLOW_REF: `${p.REPO}/${p.WORKFLOW}@${p.BRANCH}`,
    GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' };
}
function input() {
  return { schemaVersion: 1, profile: p.PROFILE, sourceCommit: 'b'.repeat(40), sourceTree: 'c'.repeat(40),
    files: Object.fromEntries(p.SOURCES.map(name => [name, { size: 1, sha256: 'd'.repeat(64) }])) };
}
function elf() { const b = Buffer.alloc(80); b.set([127, 69, 76, 70, 2, 1, 1]); b.writeUInt16LE(3, 16); b.writeUInt16LE(62, 18); return b; }
function temp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flatpak-prod016-test-')));
  t.after(() => { assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(root).startsWith('flatpak-prod016-test-')); fs.rmSync(root, { recursive: true }); });
  return root;
}
function write(root, name, body, mode = 0o644) {
  const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, body, { flag: 'wx', mode }); fs.chmodSync(file, mode); return file;
}
function fixture(t) {
  const root = temp(t), c = p.commands(root); fs.mkdirSync(path.dirname(c.bundle));
  write(path.dirname(c.bundle), path.basename(c.bundle), Buffer.from('synthetic bundle; never executed'));
  const files = p.payload(elf(), { LICENSE: Buffer.from('synthetic licence'), 'src-tauri/icons/128x128.png': Buffer.from('synthetic PNG') });
  return { root, c, files, expected: p.expectedInventory(files) };
}
test('production has a fixed stable ref, distinct receipt and unchanged prototype', () => {
  assert.equal(p.VERSION, '0.1.16'); assert.equal(p.REF, 'app/com.creatorworks.hub/x86_64/stable');
  assert.equal(p.PROFILE, 'production-native-activation-016');
  assert.deepEqual(p.PERMISSIONS, prototype.PERMISSIONS);
  assert.equal(prototype.recipe().branch, 'native-activation-test');
  const source = fs.readFileSync(path.join(__dirname, 'flatpak-native-activation.cjs'), 'utf8');
  assert.ok(source.includes("scope:'isolated-native-activation-packaging-only'"));
  assert.ok(source.includes("unsupportedHostInstallations:['rpm','appimage','steamos','linux-x86-32']"));
  assert.ok(Object.values(p.FLAGS).every(value => value === false));
});
test('finite source pins refuse missing, old, oversized and arbitrary execution fields', () => {
  p.validate(input());
  for (const mutate of [x => x.profile = 'isolated-native-activation-packaging-only', x => x.schemaVersion = true,
    x => x.sourceCommit = 'foreign', x => delete x.sourceTree, x => delete x.files[p.KEY],
    x => x.files[p.KEY].size = true, x => x.files[p.KEY].size = 2 * 1024 * 1024 + 1,
    x => x.files[p.KEY].path = '/unreviewed/key', x => x.command = 'run', x => x.version = '0.1.17',
    x => x.files['native/foreign/build.rs'] = { size: 1, sha256: 'd'.repeat(64) }]) {
    const x = input(); mutate(x); assert.throws(() => p.validate(x));
  }
});
test('preflight is native/manual/repository/ref bound and rejects trust or compiler injection', () => {
  const env = { ...environment(), SOURCE_PINS: JSON.stringify(input()) };
  assert.equal(p.preflight(env, 'linux', 'x64', 1001).profile, p.PROFILE);
  for (const [key, value] of [['GITHUB_REF', 'refs/heads/validation/linux-flatpak-activation-next'], ['GITHUB_EVENT_NAME', 'push'],
    ['GITHUB_WORKFLOW_REF', 'foreign'], ['RUNNER_ENVIRONMENT', 'self-hosted'], ['GITHUB_REPOSITORY_ID', '1'],
    ['LD_PRELOAD', 'foreign'], ['CARGO_BUILD_RUSTC', 'foreign'], ['RUSTFLAGS', 'foreign'], ['NODE_OPTIONS', 'foreign'],
    ['HTTPS_PROXY', 'foreign'], ['CREATOR_HUB_SIGNING_KEY_PATH', 'foreign'], ['FLATPAK_VALIDATE_ICON', 'foreign']]) {
    assert.throws(() => p.preflight({ ...env, [key]: value }, 'linux', 'x64', 1001), key);
  }
  for (const [platform, arch, uid] of [['win32', 'x64', 1001], ['linux', 'arm64', 1001], ['linux', 'x64', 0]]) assert.throws(() => p.preflight(env, platform, arch, uid));
  assert.throws(() => p.preflight({ ...env, SOURCE_PINS: ' '.repeat(16385) }, 'linux', 'x64', 1001));
});
test('standard-only preflight performs no reads or subprocesses and unsupported CLI modes refuse', () => {
  const original = fs.readFileSync;
  try {
    fs.readFileSync = () => assert.fail('Preflight must not read files');
    p.preflight({ ...environment(), SOURCE_PINS: JSON.stringify(input()) }, 'linux', 'x64', 1001);
  } finally { fs.readFileSync = original; }
  for (const args of [['run'], ['package', '/foreign/path'], ['preflight', 'production-bypass']]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'flatpak-native-production-016.cjs'), ...args],
      { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.status, 1); assert.ok(!result.error); assert.equal(result.stdout, '');
  }
});
test('API source/tree binding refuses stale or foreign repository evidence', async () => {
  const x = input(), repo = { id: p.REPO_ID, full_name: p.REPO };
  const commit = { sha: x.sourceCommit, tree: { sha: x.sourceTree } };
  assert.deepEqual(p.sourceAPI(x, repo, commit), { repositoryId: p.REPO_ID, sourceCommit: x.sourceCommit, sourceTree: x.sourceTree });
  for (const [repository, actual] of [[{ ...repo, id: 1 }, commit], [{ ...repo, full_name: 'foreign/repo' }, commit],
    [repo, { ...commit, sha: '0'.repeat(40) }], [repo, { ...commit, tree: { sha: '0'.repeat(40) } }]]) assert.throws(() => p.sourceAPI(x, repository, actual));
  let calls = 0;
  const github = { rest: { repos: { get: async () => { calls++; return { data: { id: p.REPO_ID, full_name: p.REPO } }; } },
    git: { getCommit: async () => { calls++; return { data: { sha: x.sourceCommit, tree: { sha: '0'.repeat(40) } } }; } } } };
  // Invalid dispatch refuses without an API request or a native stage.
  await assert.rejects(p.collect(github, { sha: 'a'.repeat(40) }, { ...environment(), SOURCE_PINS: JSON.stringify(x), GITHUB_EVENT_NAME: 'push' }));
  assert.equal(calls, 0);
});
test('source extraction uses only fixed ordinary blobs and preserves binary bytes before compilation', t => {
  const root = path.resolve(__dirname, '..'), source = temp(t), x = input();
  const bodies = Object.fromEntries(p.SOURCES.map(name => [name, fs.readFileSync(path.join(root, name))]));
  x.files = Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, p.pin(body)]));
  const calls = [];
  const git = (args, options) => {
    calls.push({ args, options });
    if (args[0] === 'rev-parse') return x.sourceTree + '\n';
    if (args[0] === 'ls-tree') return `100644 blob ${'e'.repeat(40)}\t${args[3]}\n`;
    assert.equal(options.encoding, null); return bodies[args[1].slice(41)];
  };
  p.checkoutSources(x, source, git);
  assert.deepEqual(fs.readFileSync(path.join(source, 'src-tauri/icons/128x128.png')), bodies['src-tauri/icons/128x128.png']);
  assert.equal(calls.filter(c => c.args[0] === 'show').length, p.SOURCES.length);
  for (const kind of ['tree', 'link', 'path', 'bytes']) {
    const destination = temp(t);
    assert.throws(() => p.checkoutSources(x, destination, (args, options) => {
      const result = git(args, options);
      if (kind === 'tree' && args[0] === 'rev-parse') return 'f'.repeat(40);
      if (kind === 'link' && args[0] === 'ls-tree') return result.replace('100644', '120000');
      if (kind === 'path' && args[0] === 'ls-tree') return result.replace(args[3], 'foreign');
      if (kind === 'bytes' && args[0] === 'show') return Buffer.from('changed');
      return result;
    }), kind);
  }
});
test('source validation binds existing Cargo version and compiled-key include; only the launcher target is built', () => {
  const root = path.resolve(__dirname, '..');
  const sources = Object.fromEntries(p.SOURCES.map(name => [name, fs.readFileSync(path.join(root, name))]));
  p.validateSource(sources);
  assert.ok(p.SOURCES.includes(`${p.CRATE}/Cargo.lock`) && p.SOURCES.includes(p.KEY));
  const args = p.compileArguments('/reviewed/source', '/owned/target');
  assert.equal(args[args.indexOf('--bin') + 1], p.COMMAND);
  assert.equal(args[args.indexOf('--manifest-path') + 1], path.join('/reviewed/source', p.CRATE, 'Cargo.toml'));
  assert.ok(args.includes('--locked') && args.includes('--no-default-features'));
  assert.ok(!args.includes('--bins') && !args.includes('--workspace') && !args.includes('run'));
  const changed = { ...sources, [`${p.CRATE}/Cargo.toml`]: Buffer.from(sources[`${p.CRATE}/Cargo.toml`].toString().replace('0.1.16', '0.1.14')) };
  assert.throws(() => p.validateSource(changed));
  assert.throws(() => p.validateSource({ ...sources, [p.KEY]: Buffer.from('unverified key') }));
});
test('metadata and complete payload disclose the manual outside-sandbox host contract without new permissions', () => {
  const files = p.payload(elf(), { LICENSE: Buffer.from('licence'), 'src-tauri/icons/128x128.png': Buffer.from('PNG') });
  assert.equal(Object.keys(files).length, 9);
  assert.equal(Object.keys(files).filter(name => name.startsWith('files/')).length, 5);
  assert.equal(Object.keys(files).filter(name => name.startsWith('export/')).length, 3);
  assert.ok(!Object.keys(files).some(name => /mcp|router|setup|dbus-1/.test(name)));
  assert.equal(p.metadata(), `[Application]\nname=${p.ID}\nruntime=${p.RUNTIME}\nsdk=${p.SDK}\ncommand=${p.COMMAND}\n\n[Context]\nsockets=wayland;fallback-x11;\n\n[Session Bus Policy]\n${p.NAME}=talk\n`);
  for (const text of ['manually installed Flatpak bundle', 'outside the Flatpak sandbox', 'separate signed package and your approval',
    'Native.Support_0.1.16_amd64.AppImage', 'separate signed updater', 'do not require a matching launcher update', 'runtime is not included']) assert.ok(p.metainfo().includes(text), text);
  assert.doesNotMatch(p.metadata(), /filesystem|shared|devices|Environment|system-bus|network|flatpak-spawn/);
  assert.throws(() => p.payload(Buffer.from('not ELF'), {}));
  const wrong = elf(); wrong.writeUInt16LE(183, 18); assert.throws(() => p.payload(wrong, {}));
});
test('bundle is imported into a fresh data repo and complete checkout is verified without execution', t => {
  const f = fixture(t), calls = [];
  const execute = (command, args) => {
    calls.push({ command, args });
    if (args.includes('refs')) return p.REF + '\n';
    if (args.includes('rev-parse')) return 'e'.repeat(64) + '\n';
    if (args.includes('checkout')) { fs.mkdirSync(f.c.checkout); for (const [name, row] of Object.entries(f.files)) write(f.c.checkout, name, row.body, row.mode); }
    return '';
  };
  const result = p.inspectBundle(f.root, f.expected, execute);
  assert.equal(result.commit, 'e'.repeat(64)); assert.deepEqual(result.inventory, f.expected);
  assert.equal(result.runtime, p.RUNTIME); assert.deepEqual(result.declaredPermissions, p.PERMISSIONS);
  assert.deepEqual(calls[1], { command: '/usr/bin/flatpak', args: f.c.importArgs });
  assert.ok(calls.some(row => row.args.includes('--verify-bindings')));
  assert.ok(calls.some(row => row.args.includes('--force-copy')));
  assert.ok(!calls.some(row => row.args.some(s => /^(run|install|remote-add|update|--gpg-sign|--ref=)/.test(s))));
});
test('wrong ref, changed commit, altered permissions, extra files and bundle drift never produce acceptance', t => {
  for (const kind of ['ref', 'commit', 'metadata', 'extra', 'bundle']) {
    const f = fixture(t); let revisions = 0;
    const execute = (_command, args) => {
      if (args.includes('refs')) return kind === 'ref' ? p.REF.replace('stable', 'native-activation-test') : p.REF;
      if (args.includes('rev-parse')) return (++revisions === 2 && kind === 'commit' ? 'f' : 'e').repeat(64);
      if (args.includes('checkout')) {
        fs.mkdirSync(f.c.checkout); for (const [name, row] of Object.entries(f.files)) write(f.c.checkout, name, row.body, row.mode);
        if (kind === 'metadata') fs.appendFileSync(path.join(f.c.checkout, 'metadata'), '\n[Environment]\nINJECTED=true\n');
        if (kind === 'extra') write(f.c.checkout, 'files/bin/unreviewed', Buffer.from('foreign executable'), 0o755);
        if (kind === 'bundle') fs.appendFileSync(f.c.bundle, 'changed');
      }
      return '';
    };
    assert.throws(() => p.inspectBundle(f.root, f.expected, execute), kind);
    assert.equal(fs.existsSync(path.join(f.c.checkout, 'production-flatpak-receipt.json')), false);
  }
});
test('inventory refuses symlinks, hardlinks and privileged modes', { skip: process.platform !== 'linux' && 'Unix filesystem policy is exercised on native Linux' }, t => {
  for (const kind of ['symlink', 'hardlink', 'mode']) {
    const root = temp(t), file = write(root, 'ordinary', Buffer.from('bounded'));
    if (kind === 'symlink') fs.symlinkSync(file, path.join(root, 'linked'));
    if (kind === 'hardlink') fs.linkSync(file, path.join(root, 'linked'));
    if (kind === 'mode') fs.chmodSync(file, 0o4755);
    assert.throws(() => p.inventory(root), kind);
  }
});
test('clean packaging environment contains no inherited identity, proxy, signing or product settings', () => {
  const env = p.cleanEnvironment('/owned');
  assert.deepEqual(Object.keys(env).sort(), ['PATH', 'LANG', 'LC_ALL', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'FLATPAK_USER_DIR'].sort());
  for (const value of Object.values(env)) assert.ok(!value.includes('bobman'));
  const c = p.commands('/owned');
  assert.deepEqual(c.export, ['build-export', '--arch=x86_64', '--no-update-summary', path.join('/owned', 'repo'), path.join('/owned', 'stage'), 'stable']);
  assert.deepEqual(c.bundleArgs.slice(-2), [p.ID, 'stable']);
  const source = fs.readFileSync(path.join(__dirname, 'flatpak-native-production-016.cjs'), 'utf8');
  assert.doesNotMatch(source, /flatpak-spawn|--gpg-sign|remote-add|flathub|--runtime-repo|--repo-url|dispatchWorkflow|createRelease|updateRelease/);
  assert.match(source, /encoding: null/); // Binary Git blobs must not pass through a UTF-8 string.
});
