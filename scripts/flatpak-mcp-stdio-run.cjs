// Scoped, disposable seeded protocol/retention experiment. Never host/UI/migration acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const pkg = require('./flatpak-package.cjs');
const sandbox = require('./flatpak-disposable.cjs');
const proof = require('./flatpak-replacement-source.cjs');
const archive = require('./module-archive.cjs');
const stdio = require('./flatpak-mcp-stdio-probe.cjs');
const KEY = path.join(pkg.ROOT, 'src-tauri/src/catalog-key.pub');
const KEY_SHA256 = '23b3eee2d1c8cb7d705120953cda67ff94a722a207d5be1679c250be8ca90308';
const RUNTIME_SHA256 = 'fe4d3fc0bca53e54188d41c6a2d37494c151fdff4b9a7ba1c424ce3e97ffa872';
const REMOTE = 'creator-flatpak-stdio-fixture';
const filePin = (size, sha256) => ({ size, sha256 });

function plan() {
  const router = filePin(786256, '3b0c316d0b62d970c951ff653913139c20505e1d808dab47343c3cb467e81c93');
  const common = { schemaVersion: 1, version: '0.1.14', platform: 'linux', arch: 'x86_64', mcpMode: 'writable', runAttempt: 1 };
  return [
    { label: 'baseline', artifactId: 11931797416, artifactSize: 386830987,
      artifactName: 'signed-unix-hub-linux-38643118508-1', assemblyJobId: 116123369094,
      assemblyReceipt: filePin(888, 'd229f5c380785b981b9143faf7a04224b6c75d3a394b673c34f5461f1f622368'),
      runtimeSignature: '9139ebb3e4c0eaf0b276e14c6321cf290db9ff132a3ae0f6731cbb9dda4d390b',
      pins: { ...common, runId: 38643118508, sourceCommit: '9894b1cd5387bcd6fec2d652f99a7913224e2cc7',
        sourceTree: '5014d6a721f847b8680da412419c85075d0367a6',
        inputArtifactSha256: 'b28ad458fb2560cea7b436ef31ed6913104c88214c29888395a2fc62235a2d19', files: {
          'creator-hub': filePin(21411480, '5a64f1cf6a9268cdeef1bc9fe7e85408b8ff65093f7f27ab171bda6135460917'),
          'builtin-manifest.json': filePin(3663, '44de6e0e25890ac2cb20f7f2b16eb3ac151e6b4edb1104c974a9544f291f6fd7'),
          'modules.tar.gz': filePin(56842646, 'c2cffb6f886225d8c841e78497e92c6ede96896e0c5a28c89346254e5fc4a77a'),
          [pkg.ROUTER_INPUT]: { ...router },
        } } },
    { label: 'replacement', artifactId: 11934297227, artifactSize: 380463271,
      artifactName: 'signed-unix-hub-linux-38648562557-1', assemblyJobId: 116141491681,
      assemblyReceipt: filePin(875, 'b930d76288f00fbd9694f0437852857e9dd77cca5c4371a987463992a47a421b'),
      runtimeSignature: '1f71b6aae35009e07fffb614f485f429782dd84b58045e0540b153a2f05b8930',
      pins: { ...common, runId: 38648562557, sourceCommit: '4f3744d5707ed5cd26c2e5a1b10a7d45a5e8d10b',
        sourceTree: 'cfda3105bfa144c05e7b68ccb92a7aa738ee6e52',
        inputArtifactSha256: 'ce7d02ecd5e72cbce9a0343003726601ab82a103e8e25348cac771d78f0ac881', files: {
          'creator-hub': filePin(21411480, 'b40b823f7e41e8d62b50246053d4887409e18c5daf5db370731c219bcd04f76d'),
          'builtin-manifest.json': filePin(3663, '802b5604e9a8446c96adb73a4408b5bd2c90c0e2303f67c191e0e28332793ff2'),
          'modules.tar.gz': filePin(55567186, '7892f8256102bbfb995852a154fe0350a71642965a2f7f6642f8031cc92ac983'),
          [pkg.ROUTER_INPUT]: { ...router },
        } } },
  ];
}

function admission(env = process.env, platform = process.platform, arch = process.arch) {
  sandbox.admission(env, platform, arch);
  assert.equal(env.CREATOR_FLATPAK_MCP_STDIO_PROBE, '1');
  assert.equal(env.CREATOR_FLATPAK_MCP_STDIO_SEEDED_ROUTE, '1', 'Explicit disposable seeded-route opt-in required');
  assert.equal(env.GITHUB_EVENT_NAME, 'push', 'Reviewed validation branch push only');
  assert.equal(env.GITHUB_REF, 'refs/heads/validation/flatpak-mcp-stdio-014', 'Exact validation ref required');
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
}

function privateWork(root) {
  pkg.ordinary(path.dirname(root)); fs.mkdirSync(root, { mode: 0o700 });
  const env = sandbox.childEnvironment(root);
  for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    'TMPDIR', 'GNUPGHOME', 'FLATPAK_USER_DIR']) fs.mkdirSync(env[name], { mode: 0o700 });
  return env;
}

const inputRoot = env => path.join(env.RUNNER_TEMP, 'creator-flatpak-stdio-inputs');
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
function checkZip(file, expected) {
  assert.deepEqual(pkg.record(pkg.read(file, pkg.LIMIT * 2)),
    filePin(expected.artifactSize, expected.pins.inputArtifactSha256), 'Original ZIP bytes differ');
}

async function downloadInputs(github, context, env = process.env) {
  admission(env); assert.equal(`${context.repo.owner}/${context.repo.repo}`, 'BOBWORKS-XR/CREATOR-HUB');
  const root = inputRoot(env); privateWork(root);
  for (const expected of plan()) {
    const { bytes, binding } = await proof.verifyRemoteInput(github, context.repo, expected);
    const { data: key } = await github.rest.repos.getContent({ ...context.repo,
      path: 'src-tauri/src/catalog-key.pub', ref: expected.pins.sourceCommit });
    assert.equal(key.encoding, 'base64'); assert.ok(key.content.length <= 8192);
    assert.equal(pkg.sha256(Buffer.from(key.content, 'base64')), KEY_SHA256, 'Original production public key differs');
    fs.writeFileSync(path.join(root, `${expected.label}.zip`), bytes, { flag: 'wx', mode: 0o600 });
    writeJson(path.join(root, `${expected.label}-binding.json`), { ...binding, publicKeySha256: KEY_SHA256 });
  }
}

// Standard-library ZIP handling only; never extractall or a second TAR implementation.
const EXTRACT_ZIP = String.raw`
import hashlib,json,pathlib,stat,sys,zipfile
archive,out=pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2])
pins=json.load(sys.stdin)
with zipfile.ZipFile(archive) as z:
    entries=z.infolist()
    assert len(entries)<=128 and len({e.filename for e in entries})==len(entries)
    assert all(len(e.filename)<=256 for e in entries)
    selected=[]
    for name,pin in pins.items():
        assert not pathlib.PurePosixPath(name).is_absolute() and all(p not in ('','..','.') for p in name.split('/'))
        e=z.getinfo(name)
        assert not e.is_dir() and stat.S_IFMT(e.external_attr>>16) in (0,stat.S_IFREG) and not e.flag_bits&1
        assert 0<e.file_size==pin['size']<=(65536 if name.endswith('.json') else 268435456)
        selected.append((name,pin,e))
    out.mkdir(mode=0o700)
    for name,pin,e in selected:
        with z.open(e) as stream: body=stream.read(pin['size']+1)
        assert len(body)==pin['size'] and hashlib.sha256(body).hexdigest()==pin['sha256']
        target=out/name;target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        with target.open('xb') as stream: stream.write(body)
        target.chmod(0o755 if name in ('creator-hub','modules/routing/creator-hub-mcp-router') else 0o600)
`;

function stageInputs(env = process.env) {
  admission(env); const root = inputRoot(env); sandbox.inside(root, env.RUNNER_TEMP);
  const child = sandbox.childEnvironment(root);
  for (const expected of plan()) {
    const zip = path.join(root, `${expected.label}.zip`), source = path.join(root, `${expected.label}-source`);
    const binding = JSON.parse(pkg.read(path.join(root, `${expected.label}-binding.json`), 65536));
    proof.validateArtifact(binding.artifact, expected); assert.equal(binding.assemblyJobId, expected.assemblyJobId);
    assert.equal(binding.publicKeySha256, KEY_SHA256); checkZip(zip, expected);
    const result = spawnSync('/usr/bin/python3', ['-I', '-c', EXTRACT_ZIP, zip, source], { env: child, cwd: root,
      input: JSON.stringify({ ...expected.pins.files, 'signed-unix-assembly.json': expected.assemblyReceipt }),
      encoding: 'utf8', timeout: 180000, maxBuffer: 65536, stdio: 'pipe' });
    assert.ok(!result.error && result.status === 0, 'Bounded original ZIP extraction failed'); checkZip(zip, expected);
    const receipt = pkg.read(path.join(source, 'signed-unix-assembly.json'), 65536);
    proof.validateReceipt(receipt, binding, expected);
    const stage = path.join(root, `${expected.label}-stage`);
    pkg.prepare(source, expected.pins, stage);
    fs.writeFileSync(path.join(stage, 'signed-unix-assembly.json'), receipt, { flag: 'wx', mode: 0o600 });
  }
}

function commandRunner(work, env, report, execute = spawnSync) {
  return (label, program, args, options = {}) => {
    assert.ok(Object.keys(options).every(name => ['input', 'timeout', 'maxBuffer'].includes(name)), 'Child environment/command overrides refused');
    const start = Date.now(), result = execute(program, args, { timeout: 180000, maxBuffer: 65536, ...options,
      cwd: work, env, stdio: 'pipe', encoding: 'utf8' });
    const stdout = result.stdout || '', stderr = result.stderr || '';
    const failed = Boolean(result.error) || result.status !== 0;
    report.commands.push({ label, status: result.status ?? null, signal: result.signal ?? null, code: result.error?.code ?? null,
      elapsedMs: Date.now() - start, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
      stdoutSha256: pkg.sha256(stdout), stderrSha256: pkg.sha256(stderr),
      ...(failed ? { stdoutTail: stdout.slice(-8192), stderrTail: stderr.slice(-8192) } : {}) });
    assert.ok(!failed, `Bounded command failed: ${label}; see retained command diagnostics`);
    return stdout.trim();
  };
}

function verifySeven(root, receipt) {
  sandbox.verifyFiles(root, receipt.files);
  const file = path.join(root, pkg.ROUTER_OUTPUT), mode = pkg.ordinary(file).mode & 0o7777;
  assert.deepEqual(pkg.record(pkg.read(file, pkg.LIMIT, true)), receipt.files[pkg.ROUTER_OUTPUT], 'Deployed router differs');
  assert.ok([0o755, 0o555].includes(mode), 'Deployed router mode differs');
}

function installedSnapshot(child, receipt, command) {
  const info = option => command(`reference-${option}`, sandbox.FLATPAK, ['info', option, pkg.ID], { timeout: 30000 });
  assert.equal(info('--show-ref'), pkg.REF);
  const location = info('--show-location'); sandbox.inside(location, child.FLATPAK_USER_DIR);
  const metadata = info('--show-metadata'), permissions = info('--show-permissions');
  sandbox.parseMetadata(metadata); sandbox.parsePermissions(permissions); verifySeven(path.join(location, 'files'), receipt);
  const commit = info('--show-commit'); assert.match(commit, /^[a-f0-9]{64}$/);
  const platformCommit = command('reference-platform', sandbox.FLATPAK, ['info', '--system', '--show-commit', sandbox.RUNTIME], { timeout: 30000 });
  assert.match(platformCommit, /^[a-f0-9]{64}$/);
  return { location, commit, platformCommit, metadataSha256: pkg.sha256(metadata), permissionsSha256: pkg.sha256(permissions) };
}

function checkedTool(file, sha256, env) {
  assert.match(sha256, /^[a-f0-9]{64}$/); sandbox.inside(file, path.join(env.RUNNER_TEMP, 'flatpak-stdio-tools'));
  assert.equal(pkg.sha256(pkg.read(file, pkg.LIMIT, true)), sha256, 'Trusted helper changed');
}

function extractPayload(source, manifest, destination, decoder, decoderSha256, env, command) {
  checkedTool(decoder, decoderSha256, env);
  const file = path.join(source, 'flatpak-input', pkg.OUTPUTS[1]);
  archive.verify(file, manifest, decoder, (program, args, options) => command('archive-verify', program, args, { input: options.input }));
  checkedTool(decoder, decoderSha256, env);
  const result = JSON.parse(command('archive-extract', decoder, ['extract', file, destination], { input: JSON.stringify(manifest) }));
  assert.deepEqual(result, { files: archive.rawFiles(manifest) }, 'Shared decoder extraction map differs');
  checkedTool(decoder, decoderSha256, env);
  for (const [name, hash] of Object.entries(result.files)) {
    const member = path.join(destination, name), pin = manifest.payloadArchive.files[name];
    assert.deepEqual(pkg.record(pkg.read(member)), filePin(pin.size, hash), 'Extracted member differs');
    assert.equal(pkg.ordinary(member).mode & 0o7777, pin.mode, 'Extracted member mode differs');
  }
}

function seedRoute(base, payload, manifest, driver, driverSha256, env, command) {
  assert.equal(pkg.sha256(pkg.read(KEY, 4096)), KEY_SHA256, 'Production public key changed');
  const document = path.join(payload, 'routing/runtime.json'), signature = path.join(payload, 'routing/runtime.minisig');
  for (const name of ['runtime.json', 'runtime.minisig']) assert.equal(pkg.sha256(pkg.read(path.join(payload, 'routing', name), 65536)),
    manifest.managedRouting.files[`routing/${name}`], 'Signed seed input differs');
  const invoke = (action, args) => {
    checkedTool(driver, driverSha256, env);
    const result = command(`fixture-${action}`, driver, [action, base, KEY, ...args], { timeout: 30000 });
    checkedTool(driver, driverSha256, env); return result;
  };
  const generation = invoke('generation', [document]); assert.match(generation, /^[a-f0-9]{64}$/);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const parent = path.join(base, 'runtime-generations/linux-x86_64'); fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const target = path.join(parent, generation); fs.mkdirSync(target, { mode: 0o700 });
  for (const [name, hash] of Object.entries(manifest.modules.mcp.files)) {
    const source = path.join(payload, name), file = path.join(target, name), pin = manifest.payloadArchive.files[name];
    assert.deepEqual(pkg.record(pkg.read(source)), filePin(pin.size, hash));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, file, fs.constants.COPYFILE_EXCL); fs.chmodSync(file, pin.mode);
  }
  assert.equal(invoke('activate', [document, signature]), '');
  return generation;
}

function referenceResult(result) {
  assert.notEqual(result.isError, true); assert.equal(result.content.length, 1); assert.equal(result.content[0].type, 'text');
  const text = result.content[0].text; assert.ok(Buffer.byteLength(text) <= 16384);
  const value = JSON.parse(text);
  assert.equal(value.success, true); assert.equal(value.source, 'workflows'); assert.equal(value.returned, 1);
  assert.equal(value.entries.length, 1); assert.equal(value.entries[0].entryId, 'networking');
  return { name: 'get_mcp_reference', source: 'workflows', entryId: 'networking', sha256: pkg.sha256(text) };
}

async function referenceCall(env, sdk = createRequire(path.join(pkg.ROOT, 'modules/mcp/package.json'))) {
  const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'flatpak-seeded-reference-probe', version: '1' });
  const transport = new StdioClientTransport({ command: stdio.COMMAND, args: [...stdio.ARGS], cwd: env.HOME,
    env: { LOGNAME: '', SHELL: '/bin/sh', TERM: 'dumb', USER: '', ...env }, stderr: 'pipe' });
  let stderrBytes = 0, overflow = false, failure, result;
  transport.stderr.on('data', bytes => {
    stderrBytes += bytes.length;
    if (stderrBytes > 65536 && !overflow) { overflow = true; void client.close().catch(() => {}); }
  });
  try {
    await client.connect(transport, stdio.RPC); assert.equal(overflow, false, 'Reference stderr limit exceeded');
    assert.equal(client.getServerVersion()?.name, 'creator-works-mcp');
    result = referenceResult(await client.callTool({ name: 'get_mcp_reference', arguments: {
      source: 'workflows', entryId: 'networking', limit: 1 } }, undefined, stdio.RPC));
    assert.equal(overflow, false, 'Reference stderr limit exceeded');
  } catch (error) { failure = error; }
  try { await client.close(); } catch (error) {
    throw new AggregateError([...(failure ? [failure] : []), error], 'Reference probe cleanup failed');
  }
  if (failure) throw failure;
  return result;
}

async function run(decoder, decoderSha256, driver, driverSha256, env = process.env) {
  admission(env); checkedTool(decoder, decoderSha256, env); checkedTool(driver, driverSha256, env);
  const root = inputRoot(env); sandbox.inside(root, env.RUNNER_TEMP);
  const work = fs.mkdtempSync(path.join(env.RUNNER_TEMP, 'creator-flatpak-stdio-'));
  const child = sandbox.childEnvironment(work);
  for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    'TMPDIR', 'GNUPGHOME', 'FLATPAK_USER_DIR']) fs.mkdirSync(child[name], { mode: 0o700 });
  const report = { schemaVersion: 1, scope: 'disposable-seeded-flatpak-sdk-stdio-retention-only', work,
    testSource: env.GITHUB_SHA, ref: pkg.REF, commands: [], builds: [], products: plan(), seededRoute: false,
    runtimeSignaturesVerified: false, toolConsumerProtocolRetentionPassed: false, suitePassed: false,
    uiConsentAccepted: false, packagedRouterActivationFixIncluded: false, ...pkg.acceptance(), updateReady: false,
    helpers: { decoderSha256, driverSha256, productionPublicKeySha256: KEY_SHA256 } };
  const command = commandRunner(work, child, report);
  try {
    const repo = path.join(work, 'repo'), stages = [], manifests = [];
    report.platformCommit = command('platform', sandbox.FLATPAK, ['info', '--system', '--show-commit', sandbox.RUNTIME]);
    report.sdkCommit = command('sdk', sandbox.FLATPAK, ['info', '--system', '--show-commit', sandbox.SDK]);
    for (const hash of [report.platformCommit, report.sdkCommit]) assert.match(hash, /^[a-f0-9]{64}$/);
    for (const expected of plan()) {
      const phase = (label, ...args) => command(`${expected.label}-${label}`, ...args);
      const stage = path.join(root, `${expected.label}-stage`), receipt = JSON.parse(pkg.read(path.join(stage, 'flatpak-stage.json'), 65536));
      assert.deepEqual(receipt.provenance, expected.pins); const manifest = pkg.verifyStage(stage, receipt);
      proof.validateReceipt(pkg.read(path.join(stage, 'signed-unix-assembly.json'), 65536),
        JSON.parse(pkg.read(path.join(root, `${expected.label}-binding.json`), 65536)), expected);
      assert.equal(manifest.managedRouting.files['routing/runtime.json'], RUNTIME_SHA256);
      assert.equal(manifest.managedRouting.files['routing/runtime.minisig'], expected.runtimeSignature);
      const payload = path.join(work, `${expected.label}-payload`);
      extractPayload(stage, manifest, payload, decoder, decoderSha256, env, phase);
      // Separate verification store checks the replacement's signature without changing the retained baseline store.
      const base = expected.label === 'baseline' ? path.join(child.HOME, '.var/app', pkg.ID, 'data/creator-hub')
        : path.join(work, 'replacement-signature-verification-store');
      const generation = seedRoute(base, payload, manifest, driver, driverSha256, env, phase);
      if (expected.label === 'baseline') report.seededRoute = true;
      const build = path.join(work, `build-${expected.label}`);
      phase('build', sandbox.BUILDER, ['--arch=x86_64', '--sandbox', '--disable-download',
        `--state-dir=${path.join(work, `state-${expected.label}`)}`, `--repo=${repo}`, build, path.join(stage, `${pkg.ID}.json`)],
      { timeout: 600000, maxBuffer: 1024 * 1024 });
      sandbox.parseMetadata(pkg.read(path.join(build, 'metadata'), 65536, true).toString());
      verifySeven(path.join(build, 'files'), receipt); pkg.verifyStage(stage, receipt);
      const bundle = path.join(work, `${expected.label}.flatpak`);
      phase('bundle', sandbox.FLATPAK, ['build-bundle', '--arch=x86_64', repo, bundle, pkg.ID, 'flatpak-test']);
      report.builds.push({ label: expected.label, generation, bundle: pkg.record(pkg.read(bundle, pkg.LIMIT * 2)) });
      if (expected.label === 'baseline') {
        phase('local-remote', sandbox.FLATPAK, ['remote-add', '--user', '--no-gpg-verify', REMOTE, pathToFileURL(repo).href]);
        phase('install', sandbox.FLATPAK, ['install', '--user', '--noninteractive', '--assumeyes', '--no-deps', '--no-related', REMOTE, pkg.REF]);
      }
      stages.push(stage); manifests.push(manifest);
    }
    report.runtimeSignaturesVerified = true;
    report.retention = await stdio.probe(work, stages, () => {
      command('replacement-update', sandbox.FLATPAK, ['update', '--user', '--noninteractive', '--assumeyes', '--no-deps', '--no-related', pkg.REF],
        { timeout: 45000 });
    }, env);
    const checkRoute = stdio.retainedRouteReader(path.join(child.HOME, '.var/app', pkg.ID, 'data/creator-hub'), ...manifests);
    const receipt = JSON.parse(pkg.read(path.join(stages[1], 'flatpak-stage.json'), 65536)); pkg.verifyStage(stages[1], receipt);
    const before = { installed: installedSnapshot(child, receipt, command), route: checkRoute() };
    assert.equal(before.installed.commit, report.retention.after.appCommit);
    assert.equal(before.installed.platformCommit, report.platformCommit);
    report.reference = await referenceCall(child);
    pkg.verifyStage(stages[1], receipt);
    assert.deepEqual({ installed: installedSnapshot(child, receipt, command), route: checkRoute() }, before,
      'Reference call changed the installed context or retained route');
    report.toolConsumerProtocolRetentionPassed = true; report.suitePassed = true;
  } catch (error) {
    report.error = String(error.message).slice(0, 1500);
    if (error instanceof AggregateError) report.causes = error.errors.slice(0, 4).map(item => String(item.message).slice(0, 1000));
  }
  // Preserve all owned partial stores, original artifacts and diagnostics. No uninstall/global cleanup.
  writeJson(path.join(work, 'flatpak-mcp-stdio-report.json'), report);
  return report;
}

if (require.main === module) (async () => {
  admission();
  if (process.argv.length === 3 && process.argv[2] === 'stage') stageInputs();
  else {
    assert.equal(process.argv.length, 7, 'Use stage, or run DECODER SHA256 DRIVER SHA256'); assert.equal(process.argv[2], 'run');
    const report = await run(path.resolve(process.argv[3]), process.argv[4], path.resolve(process.argv[5]), process.argv[6]);
    console.log(JSON.stringify({ work: report.work, seededRoute: report.seededRoute, suitePassed: report.suitePassed,
      scope: report.scope, error: report.error, ...pkg.acceptance(), updateReady: false }));
    if (!report.suitePassed) process.exitCode = 1;
  }
})().catch(error => { console.error(String(error.message).slice(0, 1500)); process.exitCode = 1; });

module.exports = { KEY, KEY_SHA256, RUNTIME_SHA256, EXTRACT_ZIP, plan, admission, privateWork, checkZip,
  downloadInputs, stageInputs, commandRunner, verifySeven, installedSnapshot, checkedTool, extractPayload, seedRoute, referenceResult, referenceCall, run };
