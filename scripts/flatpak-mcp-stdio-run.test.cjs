const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const run = require('./flatpak-mcp-stdio-run.cjs');
const pkg = require('./flatpak-package.cjs');
const sandbox = require('./flatpak-disposable.cjs');
const proof = require('./flatpak-replacement-source.cjs');
const stdio = require('./flatpak-mcp-stdio-probe.cjs');
const workflow = path.join(pkg.ROOT, '.github/workflows/flatpak-mcp-stdio-014.yml');
const env = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/validation/flatpak-mcp-stdio-014', GITHUB_SHA: 'a'.repeat(40),
  CREATOR_FLATPAK_PACKAGE_TEST: '1', CREATOR_FLATPAK_MCP_STDIO_PROBE: '1', CREATOR_FLATPAK_MCP_STDIO_SEEDED_ROUTE: '1',
  RUNNER_TEMP: path.resolve(os.tmpdir()) });

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-flatpak-run-fixture-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('creator-flatpak-run-fixture-') && !fs.lstatSync(root).isSymbolicLink());
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function payloadFixture(t) {
  const root = temporary(t), environment = { ...env(), RUNNER_TEMP: root };
  const tools = path.join(root, 'flatpak-stdio-tools'); fs.mkdirSync(tools);
  const decoder = path.join(tools, 'decoder'), driver = path.join(tools, 'fixture-driver');
  for (const file of [decoder, driver]) fs.writeFileSync(file, 'synthetic helper, never executed');
  const helperHash = pkg.sha256(pkg.read(decoder)), source = path.join(root, 'stage');
  fs.mkdirSync(path.join(source, 'flatpak-input', 'lib/Creator Hub'), { recursive: true });
  const payload = Buffer.from('opaque synthetic archive');
  fs.writeFileSync(path.join(source, 'flatpak-input', pkg.OUTPUTS[1]), payload);
  const bytes = Object.fromEntries([...pkg.MEMBERS, ...pkg.ROUTING].map(name => [name, Buffer.from(`synthetic ${name}`)]));
  const hashes = Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, pkg.sha256(value)]));
  const manifest = { schemaVersion: 1, platform: 'linux', arch: 'x86_64', modules: {
    mcp: { executable: pkg.MEMBERS[0], version: '2.7.7', files: Object.fromEntries(pkg.MEMBERS.slice(0, 9).map(name => [name, hashes[name]])) },
    setup: { executable: pkg.MEMBERS[9], version: '0.3.7', files: { [pkg.MEMBERS[9]]: hashes[pkg.MEMBERS[9]] } },
  }, managedRouting: { protocol: 1, files: Object.fromEntries(pkg.ROUTING.map(name => [name, hashes[name]])) } };
  manifest.payloadArchive = { schemaVersion: 1, file: 'modules.tar.gz', ...pkg.record(payload),
    unpackedSize: Object.values(bytes).reduce((sum, value) => sum + value.length, 0),
    files: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, { size: value.length,
      mode: require('./module-archive.cjs').modeFor(manifest, name) }])) };
  const extracted = path.join(root, 'extracted');
  function materialize() {
    fs.mkdirSync(extracted);
    for (const [name, value] of Object.entries(bytes)) {
      const file = path.join(extracted, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value);
    }
  }
  return { root, environment, decoder, driver, helperHash, source, bytes, hashes, manifest, extracted, materialize };
}

test('canonical pair matches independently recorded assembly evidence and requires the fourth raw input', () => {
  for (const expected of run.plan()) {
    pkg.validatePins(expected.pins);
    const evidence = JSON.parse(pkg.read(path.join(pkg.ROOT, `docs/evidence/linux-assembly-${expected.pins.runId}.json`), 65536));
    assert.equal(expected.pins.sourceCommit, evidence.sourceCommit); assert.equal(expected.assemblyJobId, evidence.jobId);
    assert.equal(expected.artifactId, evidence.artifact.id); assert.equal(expected.artifactSize, evidence.artifact.bytes);
    assert.equal(expected.pins.inputArtifactSha256, evidence.artifact.sha256);
    assert.equal(Object.keys(expected.pins.files).length, 4);
    assert.deepEqual(expected.pins.files[pkg.ROUTER_INPUT], { size: 786256,
      sha256: '3b0c316d0b62d970c951ff653913139c20505e1d808dab47343c3cb467e81c93' });
    if (evidence.sourceTree) assert.equal(expected.pins.sourceTree, evidence.sourceTree);
  }
  const [before, after] = run.plan(); assert.notEqual(before.runtimeSignature, after.runtimeSignature);
  assert.notEqual(before.pins.files['creator-hub'].sha256, after.pins.files['creator-hub'].sha256);
  // Linux checkout/source blobs use LF; Windows core.autocrlf must not define the production pin.
  const linuxKeyFixture = Buffer.from(pkg.read(run.KEY, 4096).toString('utf8').replace(/\r\n/g, '\n'));
  assert.equal(pkg.sha256(linuxKeyFixture), run.KEY_SHA256);
});

test('admission requires exact repository, id, ref, event, opt-ins and disposable Linux, before any work', () => {
  run.admission(env(), 'linux', 'x64');
  for (const [name, value] of [['GITHUB_REPOSITORY', 'foreign/repo'], ['GITHUB_REPOSITORY_ID', '1'],
    ['GITHUB_REF', 'refs/heads/main'], ['GITHUB_EVENT_NAME', 'workflow_dispatch'], ['CREATOR_FLATPAK_MCP_STDIO_PROBE', '0'],
    ['CREATOR_FLATPAK_MCP_STDIO_SEEDED_ROUTE', '0'],
    ['CREATOR_FLATPAK_PACKAGE_TEST', '0'], ['GITHUB_SHA', 'main'], ['FLATPAK_ID', pkg.ID], ['NODE_OPTIONS', '--inspect']]) {
    assert.throws(() => run.admission({ ...env(), [name]: value }, 'linux', 'x64'));
  }
  assert.throws(() => run.admission(env(), 'win32', 'x64'));
});

test('fresh private context never inherits auth, project paths or desktop/bus environment', t => {
  const root = temporary(t), work = path.join(root, 'work'), child = run.privateWork(work);
  assert.deepEqual(child, sandbox.childEnvironment(work));
  for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    'TMPDIR', 'GNUPGHOME', 'FLATPAK_USER_DIR']) sandbox.inside(child[name], work);
  for (const name of ['GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS',
    'DISPLAY', 'UNITY_PROJECT_PATH', 'CREATOR_WORKS_LAUNCHER_CONFIG', 'NODE_OPTIONS']) assert.equal(child[name], undefined);
  assert.throws(() => run.privateWork(work), /EEXIST/);
});

test('source/run/artifact validation is reused for this exact new pair and rejects a substituted tree or expired artifact', () => {
  for (const expected of run.plan()) {
    const source = { sha: expected.pins.sourceCommit, tree: { sha: expected.pins.sourceTree } };
    const encoded = value => ({ encoding: 'base64', content: Buffer.from(JSON.stringify(value)).toString('base64') });
    proof.validateSource(source, encoded({ name: 'creator-hub', version: '0.1.14' }),
      encoded({ identifier: pkg.ID, version: '0.1.14' }), expected);
    assert.throws(() => proof.validateSource({ ...source, tree: { sha: 'd'.repeat(40) } }, encoded({}), encoded({}), expected));
    assert.throws(() => proof.validateArtifact({ id: expected.artifactId, name: expected.artifactName, expired: true }, expected));
  }
});

test('original ZIP digest and size refuse independently before any extraction', t => {
  const root = temporary(t), file = path.join(root, 'original.zip'); fs.writeFileSync(file, 'synthetic ZIP bytes');
  const expected = { artifactSize: fs.statSync(file).size, pins: { inputArtifactSha256: pkg.sha256(pkg.read(file)) } };
  run.checkZip(file, expected); fs.appendFileSync(file, 'changed'); assert.throws(() => run.checkZip(file, expected));
});

test('bounded command diagnostics preserve original failure status and finite child environment', t => {
  const root = temporary(t), child = sandbox.childEnvironment(root), report = { commands: [] };
  const command = run.commandRunner(root, child, report, (program, args, options) => {
    assert.equal(options.env, child); assert.equal(options.timeout, 180000); assert.equal(options.maxBuffer, 65536);
    assert.equal(options.shell, undefined); return { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stdout: '', stderr: 'original timeout' };
  });
  assert.throws(() => command('fixture', '/fixed/tool', []), /Bounded command failed/);
  assert.equal(report.commands[0].code, 'ETIMEDOUT'); assert.equal(report.commands[0].signal, 'SIGTERM');
  assert.equal(report.commands[0].stderrTail, 'original timeout');
  for (const options of [{ env: { GITHUB_TOKEN: 'must-not-leak' } }, { shell: true }, { cwd: '/' }]) {
    assert.throws(() => command('forbidden', '/fixed/tool', [], options), /overrides refused/);
  }
});

test('shared native decoder verifies before extraction and exact map, hashes, modes are rechecked', t => {
  const f = payloadFixture(t), events = [], ordinary = pkg.ordinary;
  t.mock.method(pkg, 'ordinary', file => {
    const result = ordinary(file), name = path.relative(f.extracted, file).split(path.sep).join('/');
    return f.manifest.payloadArchive.files[name] ? { ...result, mode: f.manifest.payloadArchive.files[name].mode } : result;
  });
  run.extractPayload(f.source, f.manifest, f.extracted, f.decoder, f.helperHash, f.environment,
    (label, program, args, options) => {
      events.push(args[0]); assert.equal(program, f.decoder); assert.deepEqual(JSON.parse(options.input), f.manifest);
      if (args[0] === 'extract') { assert.equal(args[2], f.extracted); f.materialize(); }
      return JSON.stringify({ files: f.hashes });
    });
  assert.deepEqual(events, ['verify', 'extract']);
});

test('changed decoder and partial extraction maps refuse without any payload execution', t => {
  const f = payloadFixture(t); let calls = 0;
  assert.throws(() => run.extractPayload(f.source, f.manifest, f.extracted, f.decoder, 'a'.repeat(64), f.environment,
    () => { calls++; }), /Trusted helper changed/); assert.equal(calls, 0);
  assert.throws(() => run.extractPayload(f.source, f.manifest, f.extracted, f.decoder, f.helperHash, f.environment,
    (label, program, args) => JSON.stringify({ files: args[0] === 'verify' ? f.hashes : {} })), /extraction map differs/);
});

test('explicit seed uses production public key and fixture Store activation only, copying exact real-file map', t => {
  const f = payloadFixture(t); f.materialize(); const events = [], generation = 'd'.repeat(64);
  const read = pkg.read, linuxKeyFixture = Buffer.from(read(run.KEY, 4096).toString('utf8').replace(/\r\n/g, '\n'));
  t.mock.method(pkg, 'read', (file, ...args) => file === run.KEY ? linuxKeyFixture : read(file, ...args));
  const base = path.join(f.root, 'private-seeded-store');
  assert.equal(run.seedRoute(base, f.extracted, f.manifest, f.driver, f.helperHash, f.environment,
    (label, program, args, options) => {
      assert.equal(program, f.driver); assert.equal(args[1], base); assert.equal(args[2], run.KEY);
      assert.equal(options.timeout, 30000); events.push(args[0]);
      return args[0] === 'generation' ? generation : '';
    }), generation);
  assert.deepEqual(events, ['generation', 'activate']);
  for (const [name, hash] of Object.entries(f.manifest.modules.mcp.files)) assert.equal(
    pkg.sha256(pkg.read(path.join(base, 'runtime-generations/linux-x86_64', generation, name))), hash);
  assert.equal(fs.existsSync(path.join(base, 'mcp-route-v1')), false, 'Mocked driver did not manufacture a route receipt');
});

test('seed refuses a substituted public key before invoking the fixture driver', t => {
  const f = payloadFixture(t), read = pkg.read; let invoked = false;
  t.mock.method(pkg, 'read', (file, ...args) => file === run.KEY ? Buffer.from('foreign public key') : read(file, ...args));
  assert.throws(() => run.seedRoute(path.join(f.root, 'refused-store'), f.extracted, f.manifest, f.driver,
    f.helperHash, f.environment, () => { invoked = true; }), /Production public key changed/);
  assert.equal(invoked, false);
});

test('seven-file verifier does not silently inherit the old six-file router omission', t => {
  const bytes = Buffer.from('router'), receipt = { files: { [pkg.ROUTER_OUTPUT]: pkg.record(bytes) } };
  let legacyChecked = false;
  t.mock.method(sandbox, 'verifyFiles', () => { legacyChecked = true; });
  t.mock.method(pkg, 'read', () => bytes); t.mock.method(pkg, 'ordinary', () => ({ mode: 0o555 }));
  run.verifySeven(path.resolve(os.tmpdir()), receipt); assert.equal(legacyChecked, true);
  receipt.files[pkg.ROUTER_OUTPUT].sha256 = 'a'.repeat(64);
  assert.throws(() => run.verifySeven(path.resolve(os.tmpdir()), receipt), /router differs/);
});

test('reference call context binds selected private ref, seven files, effective grants and Platform', t => {
  const root = temporary(t), child = sandbox.childEnvironment(root), location = path.join(child.FLATPAK_USER_DIR, 'deployment');
  fs.mkdirSync(location, { recursive: true });
  const bytes = Buffer.from('router'), receipt = { files: { [pkg.ROUTER_OUTPUT]: pkg.record(bytes) } };
  const ordinary = pkg.ordinary;
  t.mock.method(sandbox, 'verifyFiles', () => {}); t.mock.method(pkg, 'read', () => bytes);
  t.mock.method(pkg, 'ordinary', file => file.endsWith('creator-hub-mcp-router') ? { mode: 0o555 } : ordinary(file));
  const permissions = '[Context]\nshared=ipc;\nsockets=wayland;fallback-x11;\ndevices=dri;\n';
  const values = { '--show-ref': pkg.REF, '--show-location': location, '--show-commit': 'a'.repeat(64),
    '--show-metadata': `[Application]\nname=${pkg.ID}\nruntime=org.gnome.Platform/x86_64/50\nsdk=org.gnome.Sdk/x86_64/50\ncommand=creator-hub\n${permissions}`,
    '--show-permissions': permissions };
  const command = (label, program, args, options) => {
    assert.equal(program, sandbox.FLATPAK); assert.equal(options.timeout, 30000);
    return args.includes('--system') ? 'b'.repeat(64) : values[args[1]];
  };
  const result = run.installedSnapshot(child, receipt, command);
  assert.equal(result.commit, 'a'.repeat(64)); assert.equal(result.platformCommit, 'b'.repeat(64));
  values['--show-permissions'] = permissions.replace('ipc;', 'ipc;network;');
  assert.throws(() => run.installedSnapshot(child, receipt, command), /Sandbox permission differs/);
  values['--show-permissions'] = permissions; values['--show-ref'] = 'app/foreign/x86_64/stable';
  assert.throws(() => run.installedSnapshot(child, receipt, command));
});

const goodReference = () => ({ content: [{ type: 'text', text: JSON.stringify({ success: true, source: 'workflows',
  returned: 1, entries: [{ entryId: 'networking' }] }) }] });

test('bundled reference call is fixed, read-only, project-free and bounded; closes its own SDK transport', async () => {
  let parameters, closed = false;
  class Client {
    async connect(transport, options) { assert.deepEqual(options, stdio.RPC); }
    getServerVersion() { return { name: 'creator-works-mcp' }; }
    async callTool(args, schema, options) {
      assert.deepEqual(args, { name: 'get_mcp_reference', arguments: { source: 'workflows', entryId: 'networking', limit: 1 } });
      assert.equal(schema, undefined); assert.deepEqual(options, stdio.RPC); return goodReference();
    }
    async close() { closed = true; }
  }
  class StdioClientTransport { constructor(value) { parameters = value; this.stderr = new PassThrough(); } }
  const result = await run.referenceCall({ HOME: '/owned/home', PATH: '/usr/bin:/bin' }, name =>
    name.endsWith('stdio.js') ? { StdioClientTransport } : { Client });
  assert.equal(closed, true); assert.equal(result.entryId, 'networking');
  assert.equal(parameters.command, stdio.COMMAND); assert.deepEqual(parameters.args, [...stdio.ARGS]);
  assert.equal(parameters.env.GITHUB_TOKEN, undefined); assert.equal(parameters.env.UNITY_PROJECT_PATH, undefined);
});

test('reference timeout plus cleanup failure preserve both original errors', async () => {
  class Client {
    async connect() { throw Error('initialize timeout'); }
    async close() { throw Error('transport close failure'); }
  }
  class StdioClientTransport { constructor() { this.stderr = new PassThrough(); } }
  await assert.rejects(run.referenceCall({ HOME: '/owned/home' }, name => name.endsWith('stdio.js') ? { StdioClientTransport } : { Client }), error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors.map(item => item.message), ['initialize timeout', 'transport close failure']); return true;
  });
});

test('error, wrong entry, foreign source and oversized reference results refuse', () => {
  for (const result of [{ ...goodReference(), isError: true }, { content: [] }, { content: [{ type: 'image' }] },
    { content: [{ type: 'text', text: 'x'.repeat(16385) }] },
    { content: [{ type: 'text', text: JSON.stringify({ success: true, source: 'projects', returned: 1, entries: [{ entryId: 'foreign' }] }) }] }]) {
    assert.throws(() => run.referenceResult(result));
  }
});

test('workflow is scoped, has no dispatch or product rebuild, captures compact evidence before optional originals', () => {
  const source = fs.readFileSync(workflow, 'utf8');
  for (const text of ['branches: [validation/flatpak-mcp-stdio-014]', "github.repository_id == '1364807512'",
    "github.ref == 'refs/heads/validation/flatpak-mcp-stdio-014'", 'persist-credentials: false',
    '--manifest-path native/module-archive/Cargo.toml', '--example fixture-driver', '--no-related', 'org.gnome.Platform/x86_64/50']) assert.ok(source.includes(text));
  assert.doesNotMatch(source, /workflow_dispatch:|build:unified|tauri build|--bin creator-hub|--filesystem|--share=network|flatpak-spawn|secrets\.|write-all|contents: write/);
  const compact = source.indexOf('name: flatpak-seeded-stdio-compact-'), originals = source.indexOf('name: flatpak-seeded-stdio-originals-');
  assert.ok(compact >= 0 && originals > compact);
  assert.doesNotMatch(source.slice(compact, source.indexOf('- name: Optional original')), /\*\.zip|\*\.flatpak/);
  assert.ok(source.includes("vars.CREATOR_FLATPAK_STDIO_UPLOAD_LARGE == '1'"));
  assert.ok(source.includes("steps.compact.outcome == 'success'"));
  assert.ok(source.indexOf('Portable preflight') < source.indexOf('downloadInputs(github, context)'));
});

test('embedded ZIP script and YAML parse on an available Python preflight runtime', t => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const check = spawnSync(python, ['-I', '-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: run.EXTRACT_ZIP, encoding: 'utf8', timeout: 10000 });
  if (check.error?.code === 'ENOENT') return t.skip('Python parser unavailable; CI has native Python3');
  assert.equal(check.status, 0, check.stderr);
  const yaml = spawnSync(python, ['-B', '-c', 'import sys,yaml; p=yaml.load(sys.stdin.read(),Loader=yaml.BaseLoader); assert list(p["on"])==["push"]; assert len(p["jobs"])==1'],
    { input: fs.readFileSync(workflow), encoding: 'utf8', timeout: 10000 });
  if (yaml.stderr?.includes("No module named 'yaml'")) return t.diagnostic('Optional local YAML parser unavailable; workflow contract checked above');
  assert.equal(yaml.status, 0, yaml.stderr);
});

test('standard ZIP extractor handles reviewed nested raw input and refuses duplicate/link/digest/size/path changes', t => {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const available = spawnSync(python, ['-I', '-c', 'import zipfile'], { encoding: 'utf8', timeout: 10000 });
  if (available.error?.code === 'ENOENT') return t.skip('Python unavailable; native CI has Python3');
  assert.equal(available.status, 0, available.stderr);
  const root = temporary(t), names = [...pkg.INPUTS, pkg.ROUTER_INPUT, 'signed-unix-assembly.json'];
  const bytes = Object.fromEntries(names.map(name => [name, Buffer.from(`synthetic ${name}`)]));
  const create = String.raw`import base64,json,stat,sys,zipfile
entries=json.load(sys.stdin)
with zipfile.ZipFile(sys.argv[1],'w') as z:
    for name,data,link in entries:
        e=zipfile.ZipInfo(name);e.create_system=3;e.external_attr=((stat.S_IFLNK if link else stat.S_IFREG)|0o644)<<16
        z.writestr(e,base64.b64decode(data))
`;
  for (const kind of ['valid', 'duplicate', 'link', 'digest', 'size', 'path']) {
    const zip = path.join(root, `${kind}.zip`), output = path.join(root, `${kind}-out`);
    const pins = Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, pkg.record(value)]));
    const entries = Object.entries(bytes).map(([name, value]) => [name, value.toString('base64'), false]);
    if (kind === 'duplicate') entries.push(entries[0]);
    if (kind === 'link') entries[0][2] = true;
    if (kind === 'digest') pins[names[0]].sha256 = 'd'.repeat(64);
    if (kind === 'size') pins[names[0]].size++;
    if (kind === 'path') { pins['../escape'] = pins[names[0]]; entries.push(['../escape', entries[0][1], false]); }
    const made = spawnSync(python, ['-I', '-c', create, zip], { input: JSON.stringify(entries), encoding: 'utf8', timeout: 10000 });
    assert.equal(made.status, 0, made.stderr);
    const result = spawnSync(python, ['-I', '-c', run.EXTRACT_ZIP, zip, output], { input: JSON.stringify(pins), encoding: 'utf8', timeout: 10000 });
    if (kind === 'valid') {
      assert.equal(result.status, 0, result.stderr);
      for (const [name, value] of Object.entries(bytes)) assert.deepEqual(pkg.read(path.join(output, name)), value);
    } else assert.notEqual(result.status, 0, kind);
    assert.equal(fs.existsSync(path.join(root, 'escape')), false);
  }
});
