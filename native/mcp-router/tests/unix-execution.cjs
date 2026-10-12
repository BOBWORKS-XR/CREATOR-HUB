// Disposable native transport/use-binding tests. No production key or live profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { testSigner } = require('../../../scripts/generate-router-test-fixtures.cjs');

if (!['linux', 'darwin'].includes(process.platform)) throw Error('Run on a native Linux or macOS runner.');
if (process.argv.length > 3) throw Error('Optional argument: exact native Node binary.');
const root = path.resolve(__dirname, '../../..');
const node = fs.realpathSync(process.argv[2] || process.execPath);
const target = path.resolve(process.env.CARGO_TARGET_DIR || path.join(root, 'native/mcp-router/target'));
const driver = path.join(target, 'release/examples/fixture-driver');
const binding = path.join(target, 'release/examples/unix-binding-fixture');
const out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'creator-unix-routing-')));
const platform = process.platform === 'darwin' ? 'macos' : 'linux';
const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
assert.ok(arch, 'Only native x64/arm64 fixtures are supported.');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const signer = testSigner();
const key = path.join(out, 'TEST-PUBLIC-KEY.txt');
fs.writeFileSync(key, signer.publicKey, { flag: 'wx' });
const profile = path.join(out, 'empty-profile');
fs.mkdirSync(profile);
const env = { PATH: process.env.PATH, HOME: profile, XDG_CONFIG_HOME: profile,
  XDG_DATA_HOME: profile, TMPDIR: out, CREATOR_WORKS_LAUNCHER_CONFIG: path.join(profile, 'never-created.json') };
const owned = new Set();
const clients = new Set();
const report = { platform, arch, nodeSha256: hash(fs.readFileSync(node)), checks: [], passed: false };
let sentinel;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const script = id => Buffer.from(`
import {spawn} from 'node:child_process';
const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore', detached:process.platform === 'linux'});
helper.on('error', error => { process.stderr.write(String(error)); process.exit(99); });
process.stdout.write(JSON.stringify({id:${JSON.stringify(id)}, pid:process.pid, helper:helper.pid, url:import.meta.url, argv:process.argv}) + '\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', text => {
  if (text.trim() === 'quit') process.exit(23);
  process.stdout.write(text);
});
process.stdin.on('end', () => process.exit(0));
`);

function stage(name, serverSource = script('approved')) {
  const base = path.join(out, name);
  fs.mkdirSync(base);
  const names = [
    'mcp/creator-works-mcp-launcher', 'mcp/server/creator-works-mcp.mjs', 'mcp/server/runtime/node',
    'mcp/server/runtime/LICENSE', 'mcp/server/runtime/VERSION',
    'mcp/server/unity-extension/Editor/BanterMCPBridge.cs',
    'mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png', 'mcp/server/LICENSE', 'mcp/server/THIRD_PARTY_NOTICES.md',
  ].sort();
  const payload = Object.fromEntries(names.map(name => [name, name.endsWith('/node') ? fs.readFileSync(node)
    : name.endsWith('.mjs') ? serverSource : Buffer.from(`fixture:${name}`)]));
  const module = { executable: 'mcp/creator-works-mcp-launcher', version: '2.7.7',
    files: Object.fromEntries(names.map(name => [name, hash(payload[name])])) };
  const generation = path.join(base, 'runtime-generations', `${platform}-${arch}`, hash(Buffer.from(JSON.stringify(module))));
  for (const [name, bytes] of Object.entries(payload)) {
    const destination = path.join(generation, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: 'wx', mode: name.endsWith('/node') ? 0o500 : 0o600 });
  }
  const descriptor = Buffer.from(JSON.stringify({ schemaVersion: 1, product: 'com.creatorworks.hub.mcp-runtime',
    hubVersion: '0.1.13', platform, arch, module }));
  const document = path.join(base, 'runtime.json');
  fs.writeFileSync(document, descriptor, { flag: 'wx' });
  fs.writeFileSync(`${document}.minisig`, signer.sign(descriptor), { flag: 'wx' });
  const activation = spawnSync(driver, ['activate', base, key, document, `${document}.minisig`], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(activation.status, 0, activation.stderr);
  return { base, generation, server: path.join(generation, 'mcp/server/creator-works-mcp.mjs'), node: path.join(generation, 'mcp/server/runtime/node') };
}

function line(child, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => finish(Error('Native fixture did not produce a frame.')), timeout);
    const onData = bytes => { data += bytes; const end = data.indexOf('\n'); if (end >= 0) finish(null, data.slice(0, end)); };
    const onExit = (code, signal) => finish(Error(`Native fixture exited ${code}/${signal}: ${child.diagnostics}`));
    function finish(error, result) {
      clearTimeout(timer); child.stdout.off('data', onData); child.off('exit', onExit);
      if (error) reject(error); else resolve(result);
    }
    child.stdout.on('data', onData); child.once('exit', onExit);
  });
}

async function connect(fixture, action) {
  const args = action ? [action, fixture.base, key, fixture.replacement] : ['connect', fixture.base, key];
  const child = spawn(action ? binding : driver, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  owned.add(child);
  child.diagnostics = '';
  child.stderr.on('data', bytes => { child.diagnostics = (child.diagnostics + bytes).slice(-8192); });
  const frame = JSON.parse(await line(child));
  assert.equal(frame.id, 'approved');
  assert.equal(frame.argv[1], fixture.server);
  assert.equal(frame.url, require('node:url').pathToFileURL(fixture.server).href);
  child.frame = frame;
  return child;
}

async function exited(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  for (let deadline = Date.now() + 15000; Date.now() < deadline;) {
    const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    if (result.status === 1 || /^\s*Z/.test(result.stdout)) return;
    assert.equal(result.status, 0, result.stderr);
    await pause(50);
  }
  throw Error(`Owned process ${pid} is still running.`);
}

async function close(child, code) {
  const end = new Promise(resolve => child.once('exit', resolve));
  if (code === 23) child.stdin.write('quit\n'); else child.stdin.end();
  const actual = await Promise.race([end, pause(15000).then(() => { throw Error('Router did not finish cleanup.'); })]);
  assert.equal(actual, code, child.diagnostics);
  await exited(child.frame.pid); await exited(child.frame.helper); owned.delete(child);
}

(async () => {
  execFileSync('cargo', ['build', '--release', '--locked', '--manifest-path', 'native/mcp-router/Cargo.toml', '--examples'], { cwd: root, stdio: 'inherit' });
  if (process.platform === 'darwin') {
    // Ad-hoc signing uses no account/private key. Only disposable test binaries.
    for (const image of [driver, binding]) execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', image]);
  }
  sentinel = spawn(node, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const normal = stage('stdio-eof');
  const client = await connect(normal);
  const echo = line(client); client.stdin.write('unchanged transport\n'); assert.equal(await echo, 'unchanged transport');
  await close(client, 0);
  report.checks.push('Exact stdio, original module URL/argv, EOF and owned helper cleanup');
  const code = await connect(stage('exit-status')); await close(code, 23);
  report.checks.push('Actual Node exit status forwarded after owned cleanup');
  for (const action of ['server-write', 'server-replace']) {
    const fixture = stage(action);
    fixture.replacement = path.join(out, `${action}.mjs`);
    fs.writeFileSync(fixture.replacement, script('UNVERIFIED'), { flag: 'wx' });
    const child = await connect(fixture, action); await close(child, 0);
  }
  report.checks.push('Server in-place tamper and atomic pathname replacement after resolve cannot change consumed bytes');
  for (const action of ['node-write', 'node-replace']) {
    const fixture = stage(action);
    fs.chmodSync(fixture.node, 0o700); // Let a non-cooperating fixture writer really modify it.
    fixture.replacement = path.join(out, `${action}-foreign-executable`);
    fs.copyFileSync('/bin/sh', fixture.replacement); fs.chmodSync(fixture.replacement, 0o700);
    if (process.platform === 'linux') {
      const child = await connect(fixture, action); await close(child, 0);
    } else {
      const refused = spawnSync(binding, [action, fixture.base, key, fixture.replacement], { env, encoding: 'utf8', timeout: 15000 });
      assert.equal(refused.status, 1, refused.stderr); assert.equal(refused.stdout, ''); assert.match(refused.stderr, /refused|identity/);
    }
  }
  report.checks.push('Node mutation/replacement after resolve: sealed original runs on Linux; foreign suspended image refuses on macOS');
  const tampered = stage('one-byte-tamper-before-resolve');
  const bytes = fs.readFileSync(tampered.server); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(tampered.server, bytes);
  const refused = spawnSync(driver, ['connect', tampered.base, key], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(refused.status, 1); assert.equal(refused.stdout, ''); assert.match(refused.stderr, /runtime bytes changed/);
  report.checks.push('Exact one-byte pre-resolve tamper refuses before any child output');
  const killed = await connect(stage('router-sigkill'));
  killed.kill('SIGKILL'); await exited(killed.pid); await exited(killed.frame.pid); await exited(killed.frame.helper); owned.delete(killed);
  process.kill(sentinel.pid, 0);
  report.checks.push('Router SIGKILL triggers private-supervisor cleanup; unrelated Node stays alive');
  const realServer = path.join(root, 'modules/mcp/release/creator-works-mcp.mjs');
  if (fs.existsSync(realServer)) {
    const { pathToFileURL } = require('node:url');
    const resolveSdk = file => import(pathToFileURL(require.resolve(file, { paths: [path.join(root, 'modules/mcp')] })).href);
    const { Client } = await resolveSdk('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await resolveSdk('@modelcontextprotocol/sdk/client/stdio.js');
    const actual = stage('real-sdk-server', fs.readFileSync(realServer));
    const injection = path.join(profile, 'must-not-load.cjs');
    fs.writeFileSync(injection, 'throw Error("Unverified NODE_OPTIONS executed");', { flag: 'wx' });
    const client = new Client({ name: 'unix-kernel-binding-test', version: '1' });
    clients.add(client);
    const transport = new StdioClientTransport({ command: driver, args: ['connect', actual.base, key],
      cwd: profile, stderr: 'pipe', env: { ...env, CREATOR_WORKS_TOOL_GROUPS: 'none', UNITY_PROJECT_PATH: '',
        BANTER_PROJECT_PATH: '', NODE_OPTIONS: `--require "${injection}"`, NODE_PATH: profile } });
    let diagnostics = '';
    report.sdkSteps = [];
    transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
    try {
      await client.connect(transport, { timeout: 10000 });
      const routerPid = transport.pid;
      report.sdkSteps.push('initialize');
      assert.equal(client.getServerVersion().name, 'creator-works-mcp');
      assert.equal((await client.listTools({}, { timeout: 10000 })).tools.length, 4);
      report.sdkSteps.push('listTools');
      await client.ping({ timeout: 10000 });
      report.sdkSteps.push('ping');
      // The SDK deliberately clears transport.pid during close(). Retain the
      // owned identity before closing rather than checking null afterwards.
      await client.close(); clients.delete(client); await exited(routerPid);
      report.sdkSteps.push('EOF/owned-router-exit');
    } catch (error) { throw Error(`Real SDK runtime failed: ${String(error.stack || error)}\n${diagnostics}`, { cause: error }); }
    report.realServerSha256 = hash(fs.readFileSync(realServer));
    report.checks.push('Official SDK initialize/listTools/ping/EOF against exact real server bytes; Node injection overrides refused');
  } else {
    report.realSdk = 'Not run: build modules/mcp/release/creator-works-mcp.mjs and install its SDK dependency first.';
  }
  assert.equal(fs.existsSync(path.join(profile, 'never-created.json')), false);
  report.passed = true;
})().catch(error => { report.error = String(error.stack || error); process.exitCode = 1; }).finally(async () => {
  for (const client of clients) { try { await client.close(); } catch {} }
  for (const child of owned) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (child.frame) for (const pid of [child.frame.pid, child.frame.helper]) {
      try { await exited(pid); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  }
  sentinel?.kill('SIGKILL');
  fs.writeFileSync(path.join(out, 'native-result.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  const retained = path.join(root, 'artifacts/unix-native-results');
  fs.mkdirSync(retained, { recursive: true });
  const evidence = path.join(retained, `${platform}-${arch}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(evidence, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ evidence, temporaryPayloads: out, ...report }, null, 2));
});
