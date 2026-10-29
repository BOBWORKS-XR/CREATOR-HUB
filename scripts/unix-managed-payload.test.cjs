const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { build, parseBuildOptions } = require('./build-unified.cjs');
const { checkSplitOptions, prepareAdmission, snapshot } = require('./unix-managed-payload.cjs');
const routing = require('./managed-router-package.cjs');

const options = { prepareManagedUnix: true, managed: true, experimentalUnix: true, experimentalWritable: true };
const commit = 'a'.repeat(40), tree = 'b'.repeat(40);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fixture(platform = 'linux', arch = 'x86_64') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'creator-unix-preparation-')));
  const write = (name, value = 'synthetic never-executed payload') => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
    return file;
  };
  write('src-tauri/tauri.conf.json', JSON.stringify({ version: '0.1.14', productName: 'Creator Hub' }));
  write('modules/mcp/launcher/src-tauri/tauri.conf.json', JSON.stringify({ version: '2.7.7' }));
  write('modules/project-setup/src-tauri/tauri.conf.json', JSON.stringify({ version: '0.3.7' }));
  for (const name of ['release/creator-works-mcp.mjs', 'release/runtime/node', 'release/runtime/LICENSE', 'release/runtime/VERSION',
    'unity-extension/Editor/BanterMCPBridge.cs', 'unity-extension/Editor/CreatorWorksMCPLogo.png', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    write(`modules/mcp/${name}`);
  }
  const cli = write('node_modules/@tauri-apps/cli/tauri.js');
  const npm = write('fixture-npm.cjs');
  const env = { npm_execpath: npm, GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: platform === 'macos' ? 'macOS' : 'Linux', RUNNER_ARCH: arch === 'aarch64' ? 'ARM64' : 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/unix-managed-payload.yml@refs/heads/validation/test',
    GITHUB_SHA: commit, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' };
  const calls = [];
  let dirty = '', head = commit, afterRouter = () => {};
  const execute = (command, args, settings) => {
    calls.push({ command, args: [...args], cwd: settings?.cwd, env: settings?.env });
    if (command === 'git') {
      if (args.includes('--show-toplevel')) return root;
      if (args[0] === 'status') return dirty;
      if (args[1] === 'HEAD') return head;
      if (args[1] === 'HEAD^{tree}') return tree;
      assert.fail('Unexpected Git command');
    }
    if (command === 'codesign') {
      assert.equal(platform, 'macos');
      assert.equal(args[args.length - 1].includes('runtime/node'), false, 'Private Node must not be re-signed');
      fs.appendFileSync(args[args.length - 1], '\nsynthetic ad-hoc signature');
      return '';
    }
    if (args[0] === npm) {
      assert.deepEqual(args.slice(1), ['run', 'release:launcher']);
      return '';
    }
    const target = args.includes('--target') ? args[args.indexOf('--target') + 1] : null;
    const release = path.join(settings.env.CARGO_TARGET_DIR, ...(target ? [target] : []), 'release');
    let binary;
    if (command === 'cargo') {
      assert.equal(args[args.indexOf('--manifest-path') + 1], path.join(root, 'native/mcp-router/Cargo.toml'));
      binary = 'creator-hub-mcp-router';
    } else {
      assert.equal(args[0], cli);
      assert.ok(args.includes('--no-bundle'));
      assert.notEqual(settings.cwd, root, 'Preparation must not build Hub');
      binary = settings.cwd.endsWith(path.join('modules', 'project-setup')) ? 'creator-project-setup' : 'creator-works-mcp-launcher';
      if (binary.includes('mcp-launcher')) assert.ok(args.includes('experimental-unix-hosting'));
      assert.equal(settings.env.CREATOR_HUB_INTERNAL_MODULE, '1');
      assert.equal(settings.env.CREATOR_MCP_HOST_WRITABLE, '1');
    }
    assert.ok(args.includes('--locked'));
    fs.mkdirSync(release, { recursive: true });
    fs.writeFileSync(path.join(release, binary), 'synthetic private native image');
    if (binary === 'creator-hub-mcp-router') afterRouter();
    return '';
  };
  return { root, env, calls, execute, context: { root, platform, arch, env, execute },
    dirty(value) { dirty = value; }, head(value) { head = value; }, afterRouter(callback) { afterRouter = callback; } };
}

function cleanup(f) {
  const resolved = fs.realpathSync(f.root);
  assert.equal(resolved, f.root);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('creator-unix-preparation-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}

test('explicit preparation CLI and legacy flags are parsed without a runtime fixture bypass', () => {
  assert.deepEqual(parseBuildOptions(['--prepare-managed-unix', '--managed', '--experimental-unix', '--experimental-unix-writable']), options);
  assert.deepEqual(parseBuildOptions([]), {});
  assert.deepEqual(parseBuildOptions(['--installer', '--managed']), { installer: true, managed: true });
  assert.throws(() => parseBuildOptions(['--prepare-managed-unix', '--prepare-managed-unix']), /Duplicate/);
  assert.throws(() => parseBuildOptions(['--fixture']), /Unknown/);
  assert.throws(() => parseBuildOptions(['--signed-unix-input', 'relative']), /absolute/);
});

for (const [platform, arch] of [['linux', 'x86_64'], ['linux', 'aarch64'], ['macos', 'x86_64'], ['macos', 'aarch64']]) {
  test(`synthetic ${platform}/${arch} preparation cannot select a key, sign metadata, wrap or build Hub`, () => {
    const f = fixture(platform, arch);
    const original = { signingKey: routing.signingKey, signDetached: routing.signDetached, prepare: routing.prepare };
    for (const name of Object.keys(original)) routing[name] = () => assert.fail(`Forbidden ${name} call`);
    try {
      const output = build('prepared', options, f.context);
      const receipt = JSON.parse(fs.readFileSync(path.join(output, 'prepared-unix.json'), 'utf8'));
      assert.equal(receipt.unsigned, true);
      assert.equal(receipt.privateKeyIncluded, false);
      assert.equal(receipt.releaseReady, false);
      assert.equal(receipt.nativeGuiTested, false);
      assert.equal(receipt.nativeConsentTested, false);
      assert.equal(receipt.mcpMode, 'writable');
      assert.deepEqual(receipt.source, { repository: 'BOBWORKS-XR/CREATOR-HUB', repositoryId: 1364807512,
        workflow: '.github/workflows/unix-managed-payload.yml', event: 'workflow_dispatch', sourceCommit: commit, buildCommit: commit, sourceTree: tree, runId: 123, runAttempt: 2 });
      assert.ok(receipt.files['modules/setup/creator-project-setup']);
      assert.ok(receipt.files['router-for-package']);
      for (const [name, record] of Object.entries(receipt.files)) {
        assert.equal(record.sha256, hash(path.join(output, name)));
        assert.equal(record.size, fs.statSync(path.join(output, name)).size);
        assert.ok([0o644, 0o755].includes(record.mode));
      }
      assert.equal(receipt.files['modules/mcp/server/runtime/node'].sha256, hash(path.join(f.root, 'modules/mcp/release/runtime/node')));
      const manifest = JSON.parse(fs.readFileSync(path.join(output, 'builtin-manifest.json'), 'utf8'));
      assert.equal(manifest.managedRouting, undefined);
      assert.equal(manifest.payloadArchive, undefined);
      assert.equal(fs.existsSync(path.join(output, 'creator-hub')), false);
      assert.equal(fs.existsSync(path.join(output, 'tauri-unified.json')), false);
      assert.equal(fs.existsSync(path.join(output, 'modules.tar.gz')), false);
      assert.equal(f.calls.filter(c => c.command === 'cargo').length, 1);
      assert.equal(f.calls.filter(c => c.command === 'codesign').length, platform === 'macos' ? 3 : 0);
    } finally {
      Object.assign(routing, original);
      cleanup(f);
    }
  });
}

test('preparation refuses missing flags, installers, and non-Unix before any subprocess', () => {
  const f = fixture();
  try {
    for (const change of [{ managed: false }, { experimentalUnix: false }, { experimentalWritable: false }, { installer: true }]) {
      assert.throws(() => build('refused', { ...options, ...change }, f.context), /requires native Unix/);
    }
    assert.throws(() => build('refused', options, { ...f.context, platform: 'windows' }), /requires native Unix/);
    assert.deepEqual(f.calls, []);
    assert.equal(fs.existsSync(path.join(f.root, 'artifacts')), false);
    assert.doesNotThrow(() => checkSplitOptions({ platform: 'windows', installer: true, managed: true }));
    assert.doesNotThrow(() => checkSplitOptions({ platform: 'linux', experimentalUnix: true }));
  } finally { cleanup(f); }
});

test('native admission rejects local/self-hosted/foreign/PR/architecture and credential environments before inspection', () => {
  const f = fixture();
  try {
    for (const change of [{ GITHUB_ACTIONS: '' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_REPOSITORY: 'foreign/repo' },
      { GITHUB_REPOSITORY_ID: '1' }, { GITHUB_EVENT_NAME: 'pull_request' }, { RUNNER_ARCH: 'ARM64' }, { RUNNER_OS: 'macOS' },
      { GITHUB_WORKFLOW_REF: 'foreign/workflow' }, { CREATOR_HUB_SIGNING_KEY_PATH: 'never-opened' }, { TAURI_SIGNING_PRIVATE_KEY: 'never-read' }]) {
      assert.throws(() => prepareAdmission(f.root, 'linux', 'x86_64', { ...f.env, ...change }, f.execute), /requires|refuses/);
    }
    assert.deepEqual(f.calls, []);
  } finally { cleanup(f); }
});

test('only the explicit validation push can substitute for a workflow dispatch', () => {
  const f = fixture();
  try {
    const ref = 'refs/heads/validation/unix-payload-014';
    const env = { ...f.env, GITHUB_EVENT_NAME: 'push', GITHUB_REF: ref,
      GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/.github/workflows/unix-managed-payload.yml@${ref}` };
    assert.equal(prepareAdmission(f.root, 'linux', 'x86_64', env, f.execute).event, 'push');
    for (const change of [{ GITHUB_REF: 'refs/heads/feature/unified-creator-hub' },
      { GITHUB_WORKFLOW_REF: f.env.GITHUB_WORKFLOW_REF }, { GITHUB_EVENT_NAME: 'pull_request' }]) {
      assert.throws(() => prepareAdmission(f.root, 'linux', 'x86_64', { ...env, ...change }, f.execute), /requires/);
    }
  } finally { cleanup(f); }
});

test('the new producer route binds Linux x86_64 and both exact 0.1.16 source identities without relabelling legacy receipts', () => {
  const f = fixture();
  try {
    const ref = 'refs/heads/validation/unix-payload-016';
    const env = { ...f.env, GITHUB_EVENT_NAME: 'push', GITHUB_REF: ref,
      GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/.github/workflows/unix-managed-payload.yml@${ref}` };
    for (const file of ['package.json', 'src-tauri/tauri.conf.json']) {
      fs.writeFileSync(path.join(f.root, file), JSON.stringify({ version: '0.1.16' }));
    }
    for (const event of ['push', 'workflow_dispatch']) {
      assert.equal(prepareAdmission(f.root, 'linux', 'x86_64', { ...env, GITHUB_EVENT_NAME: event }, f.execute).event, event);
    }
    assert.throws(() => prepareAdmission(f.root, 'macos', 'x86_64', { ...env, RUNNER_OS: 'macOS' }, f.execute), /exact Linux/);
    assert.throws(() => prepareAdmission(f.root, 'linux', 'aarch64', { ...env, RUNNER_ARCH: 'ARM64' }, f.execute), /exact Linux/);
    for (const file of ['package.json', 'src-tauri/tauri.conf.json']) {
      fs.writeFileSync(path.join(f.root, file), JSON.stringify({ version: '0.1.15' }));
      assert.throws(() => prepareAdmission(f.root, 'linux', 'x86_64', env, f.execute), /source version/);
      fs.writeFileSync(path.join(f.root, file), JSON.stringify({ version: '0.1.16' }));
    }
  } finally { cleanup(f); }
});

test('journal A producer is exact-ref manual-only and keeps the native 016 and source guards', () => {
  const f = fixture();
  try {
    const ref = 'refs/heads/validation/journal-a-payload-016';
    const env = { ...f.env, GITHUB_REF: ref,
      GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/.github/workflows/unix-managed-payload.yml@${ref}` };
    for (const file of ['package.json', 'src-tauri/tauri.conf.json']) {
      fs.writeFileSync(path.join(f.root, file), JSON.stringify({ version: '0.1.16' }));
    }
    assert.equal(prepareAdmission(f.root, 'linux', 'x86_64', env, f.execute).event, 'workflow_dispatch');
    for (const change of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_EVENT_NAME: 'pull_request' },
      { GITHUB_WORKFLOW_REF: f.env.GITHUB_WORKFLOW_REF }, { GITHUB_REPOSITORY: 'foreign/repo' },
      { GITHUB_REPOSITORY_ID: '1' }, { RUNNER_ENVIRONMENT: 'self-hosted' },
      { CREATOR_HUB_SIGNING_KEY_PATH: 'never-opened' }]) {
      assert.throws(() => prepareAdmission(f.root, 'linux', 'x86_64', { ...env, ...change }, f.execute));
    }
    assert.throws(() => prepareAdmission(f.root, 'macos', 'x86_64', { ...env, RUNNER_OS: 'macOS' }, f.execute), /exact Linux/);
    assert.throws(() => prepareAdmission(f.root, 'linux', 'aarch64', { ...env, RUNNER_ARCH: 'ARM64' }, f.execute), /exact Linux/);
    for (const file of ['package.json', 'src-tauri/tauri.conf.json']) {
      fs.writeFileSync(path.join(f.root, file), JSON.stringify({ version: '0.1.15' }));
      assert.throws(() => prepareAdmission(f.root, 'linux', 'x86_64', env, f.execute), /source version/);
      fs.writeFileSync(path.join(f.root, file), JSON.stringify({ version: '0.1.16' }));
    }
    f.dirty(' M protected-source.rs');
    assert.throws(() => prepareAdmission(f.root, 'linux', 'x86_64', env, f.execute), /clean initial source/);
    f.dirty(''); f.head('c'.repeat(40));
    assert.throws(() => prepareAdmission(f.root, 'linux', 'x86_64', env, f.execute), /dispatched source/);
    assert.equal(f.calls.every(c => c.command === 'git'), true);
  } finally { cleanup(f); }
});

test('the generic unsigned producer remains Linux-only with the finite 016 preflight before tools and unchanged transfer workflow identity', () => {
  const { yaml } = require('../node_modules/playwright-core/lib/utilsBundle.js');
  const document = yaml.parseDocument(fs.readFileSync(path.join(__dirname, '../.github/workflows/unix-managed-payload.yml'), 'utf8'), { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const workflow = document.toJS();
  assert.deepEqual(workflow.on.push.branches, ['validation/unix-payload-014', 'validation/unix-payload-016']);
  assert.deepEqual(workflow.jobs.payload.strategy.matrix.os, ['ubuntu-22.04']);
  const steps = workflow.jobs.payload.steps;
  assert.equal(steps[1].if, "github.ref == 'refs/heads/validation/unix-payload-016' || github.ref == 'refs/heads/validation/journal-a-payload-016'");
  assert.match(steps[1].run, /'version'\] == '0\.1\.16'/);
  assert.match(steps[1].run, /RUNNER_OS.*Linux.*RUNNER_ARCH.*X64/);
  assert.match(steps[1].run, /GITHUB_EVENT_NAME'\] == 'workflow_dispatch'/);
  assert.match(steps[1].run, /GITHUB_WORKFLOW_REF'\].*unix-managed-payload\.yml@refs\/heads\/validation\/journal-a-payload-016/);
  assert.ok(steps[2].uses.startsWith('actions/setup-node@'));
  assert.match(steps.find(step => step.name?.startsWith('Prepare only')).run, /--prepare-managed-unix$/);
  assert.doesNotMatch(JSON.stringify(workflow), /secrets\.|APPLE_|TAURI_SIGNING_|CREATOR_HUB_SIGNING_/);
});

test('dirty initial source or source/run mismatch refuses before generation or output writes', () => {
  const f = fixture();
  try {
    f.dirty(' M protected-source.rs');
    assert.throws(() => build('refused', options, f.context), /clean initial source/);
    f.dirty('?? unexpected-source.js');
    assert.throws(() => build('refused', options, f.context), /clean initial source/);
    f.dirty(''); f.head('c'.repeat(40));
    assert.throws(() => build('refused', options, f.context), /dispatched source/);
    assert.throws(() => prepareAdmission(f.root, 'linux', 'x86_64', { ...f.env, GITHUB_RUN_ID: '9007199254740993' }, f.execute), /run identity/);
    assert.equal(f.calls.every(c => c.command === 'git'), true);
    assert.equal(fs.existsSync(path.join(f.root, 'artifacts')), false);
  } finally { cleanup(f); }
});

test('signed input requires its separate native workflow before inspection or any recompilation/signing fallback', () => {
  const f = fixture();
  try {
    const input = path.join(f.root, 'absent-signed-input');
    const parsed = parseBuildOptions(['--signed-unix-input', input, '--managed', '--experimental-unix', '--experimental-unix-writable']);
    assert.throws(() => build('refused', parsed, f.context), /Explicit native assembly workflow/);
    assert.throws(() => build('refused', { ...options, signedUnixInput: input }, f.context), /Signed Unix assembly requires/);
    assert.deepEqual(f.calls, []);
    assert.equal(fs.existsSync(path.join(f.root, 'artifacts')), false);
  } finally { cleanup(f); }
});

test('redirected output refuses before creating or compiling any payload', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, 'foreign'));
    fs.symlinkSync(path.join(f.root, 'foreign'), path.join(f.root, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => build('refused', options, f.context), /output ancestor is redirected/);
    assert.equal(f.calls.every(c => c.command === 'git'), true);
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'foreign')), []);
  } finally { cleanup(f); }
});

test('source drift after router compilation retains partial evidence but no success receipt', () => {
  const f = fixture();
  try {
    f.afterRouter(() => f.head('c'.repeat(40)));
    assert.throws(() => build('drift', options, f.context), /Source identity changed/);
    const output = path.join(f.root, 'artifacts/unified/drift');
    assert.ok(fs.existsSync(path.join(output, 'router-for-package')));
    assert.equal(fs.existsSync(path.join(output, 'prepared-unix.json')), false);
    assert.equal(fs.existsSync(path.join(output, 'creator-hub')), false);
  } finally { cleanup(f); }
});

test('capture refuses nonregular/oversized files and redirected ancestors', () => {
  const f = fixture();
  try {
    assert.throws(() => snapshot(path.join(f.root, 'modules'), f.root, 0o644), /regular/);
    const huge = path.join(f.root, 'huge'); fs.writeFileSync(huge, 'x'); fs.truncateSync(huge, 256 * 1024 * 1024 + 1);
    assert.throws(() => snapshot(huge, f.root, 0o644), /bounded/);
    const original = path.join(f.root, 'hard-link-source'); fs.writeFileSync(original, 'x');
    const hard = path.join(f.root, 'hard-link'); fs.linkSync(original, hard);
    assert.throws(() => snapshot(hard, f.root, 0o644), /unlinked/);
    const linked = path.join(f.root, 'redirected');
    fs.symlinkSync(path.join(f.root, 'modules'), linked, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => snapshot(path.join(linked, 'mcp/LICENSE'), f.root, 0o644), /redirected/);
  } finally { cleanup(f); }
});

test('capture refuses content drift instead of emitting an updated acceptance hash', () => {
  const f = fixture();
  const file = path.join(f.root, 'drift'); fs.writeFileSync(file, 'original'); fs.chmodSync(file, 0o644);
  const original = fs.readSync;
  let changed = false;
  try {
    fs.readSync = (...args) => {
      const count = original(...args);
      if (!changed) { changed = true; fs.appendFileSync(file, 'changed'); }
      return count;
    };
    assert.throws(() => snapshot(file, f.root, 0o644), /changed during capture/);
  } finally { fs.readSync = original; cleanup(f); }
});
