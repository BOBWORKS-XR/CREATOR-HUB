// Real stdio/activation test in newly created, isolated storage. No live profile edits.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { testSigner } = require('./generate-router-test-fixtures.cjs');
const { verifyStage } = require('./build-unified.cjs');
const { runtimeDescriptor } = require('./mcp-runtime-descriptor.cjs');

if (process.platform !== 'win32') throw Error('Writable routing acceptance is currently Windows only.');
if (process.argv.length !== 3) throw Error('Provide one immutable unified candidate directory.');
const root = path.resolve(__dirname, '..');
const candidate = path.resolve(process.argv[2]);
const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'builtin-manifest.json'), 'utf8'));
verifyStage(path.join(candidate, 'modules'), manifest);
const out = fs.mkdtempSync(path.join(root, 'artifacts', 'router-native-'));
const base = path.join(out, 'isolated hub data');
const profile = path.join(out, 'isolated user profile');
fs.mkdirSync(base); fs.mkdirSync(profile);
const inherited = Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP']
  .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
const env = { ...inherited, HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, 'roaming'),
  LOCALAPPDATA: path.join(profile, 'local'), XDG_CONFIG_HOME: profile, UNITY_PROJECT_PATH: '', BANTER_PROJECT_PATH: '',
  CREATOR_WORKS_LAUNCHER_CONFIG: path.join(profile, 'launcher-config.json'), CREATOR_WORKS_TOOL_GROUPS: 'none' };
const target = path.resolve(process.env.CARGO_TARGET_DIR || path.join(root, 'native/mcp-router/target'));
const driver = path.join(target, 'release/examples/fixture-driver.exe');
const production = path.join(target, 'release/creator-hub-mcp-router.exe');
const key = path.join(out, 'TEST-PUBLIC-KEY.txt');
const report = { sourceRevision: process.env.GITHUB_SHA || null, checks: [], passed: false };
const clients = new Set();
let sentinel;
const timeout = { timeout: 10000 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function exited(pid) {
  for (const deadline = Date.now() + 10000; Date.now() < deadline;) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(50);
  }
  throw Error(`Owned fixture process ${pid} did not exit.`);
}

function driverRun(action, ...args) {
  return spawnSync(driver, [action, base, key, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
}

function stage(signer, name, hubVersion) {
  const payload = path.join(out, `payload-${name}`);
  fs.mkdirSync(payload);
  for (const file of Object.keys(manifest.modules.mcp.files)) {
    const target = path.join(payload, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let bytes = fs.readFileSync(path.join(candidate, 'modules', file));
    if (file.endsWith('.mjs')) {
      const offset = bytes.subarray(0, 2).toString() === '#!' ? bytes.indexOf(10) + 1 : 0;
      assert.ok(offset >= 0);
      bytes = Buffer.concat([bytes.subarray(0, offset),
        Buffer.from(`process.stderr.write('[router-fixture:${name}:' + process.pid + ']\\n');\n`
          + `const routerFixtureChild = (await import('node:child_process')).spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });\n`
          + `process.stderr.write('[router-fixture-child:' + routerFixtureChild.pid + ']\\n');\n`), bytes.subarray(offset)]);
    }
    fs.writeFileSync(target, bytes, { flag: 'wx' });
  }
  const files = Object.fromEntries(Object.keys(manifest.modules.mcp.files).sort().map(file =>
    [file, hash(fs.readFileSync(path.join(payload, file)))]));
  const module = { executable: manifest.modules.mcp.executable, version: manifest.modules.mcp.version, files };
  const descriptor = Buffer.from(JSON.stringify(runtimeDescriptor({ ...manifest,
    modules: { ...manifest.modules, mcp: module } }, hubVersion)));
  const document = path.join(out, `${name}.json`);
  const signature = `${document}.minisig`;
  fs.writeFileSync(document, descriptor, { flag: 'wx' });
  fs.writeFileSync(signature, signer.sign(descriptor), { flag: 'wx' });
  const id = hash(Buffer.from(JSON.stringify(module)));
  const generation = path.join(base, 'runtime-generations', `windows-${manifest.arch}`, id);
  fs.mkdirSync(path.dirname(generation), { recursive: true });
  fs.renameSync(payload, generation);
  return { document, signature, generation, id };
}

(async () => {
  execFileSync('cargo', ['build', '--locked', '--release', '--manifest-path', 'native/mcp-router/Cargo.toml',
    '--bin', 'creator-hub-mcp-router', '--example', 'fixture-driver'], { cwd: root, stdio: 'inherit', windowsHide: true });
  report.routerSha256 = hash(fs.readFileSync(production));
  const signer = testSigner();
  fs.writeFileSync(key, signer.publicKey, { flag: 'wx' });
  const missing = driverRun('connect');
  assert.equal(missing.status, 1); assert.equal(missing.stdout, ''); assert.match(missing.stderr, /No managed MCP runtime/);
  assert.equal(fs.existsSync(path.join(base, 'mcp-route-v1')), false);
  report.checks.push('Missing route fails clearly without creating settings or route storage');
  const first = stage(signer, 'A', '0.1.12');
  const second = stage(signer, 'B', '0.1.13');
  const activated = driverRun('activate', first.document, first.signature);
  assert.equal(activated.status, 0, activated.stderr);
  const resolveSdk = file => import(pathToFileURL(require.resolve(file, { paths: [path.join(root, 'modules/mcp')] })).href);
  const { Client } = await resolveSdk('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await resolveSdk('@modelcontextprotocol/sdk/client/stdio.js');
  const injection = path.join(profile, 'must never execute.cjs');
  fs.writeFileSync(injection, 'throw new Error("NODE_OPTIONS was not removed");', { flag: 'wx' });
  async function connect(name) {
    const client = new Client({ name: 'creator-router-acceptance', version: '1' });
    clients.add(client);
    const transport = new StdioClientTransport({ command: driver, args: ['connect', base, key],
      cwd: profile, stderr: 'pipe', env: { ...env, NODE_OPTIONS: `--require "${injection}"` } });
    let stderr = '';
    transport.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    try { await client.connect(transport, timeout); }
    catch (error) { throw Error(`Router SDK connect failed: ${stderr}`, { cause: error }); }
    assert.equal(client.getServerVersion().name, 'creator-works-mcp');
    assert.ok(stderr.includes(`[router-fixture:${name}:`), stderr);
    const nodePid = Number(stderr.match(/\[router-fixture:[AB]:(\d+)\]/)[1]);
    const descendantPid = Number(stderr.match(/\[router-fixture-child:(\d+)\]/)[1]);
    return { client, transport, nodePid, descendantPid, routerPid: transport.pid };
  }
  const a = await connect('A');
  assert.equal((await a.client.listTools({}, timeout)).tools.length, 4);
  sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const swapped = driverRun('activate', second.document, second.signature);
  assert.equal(swapped.status, 0, swapped.stderr);
  const b = await connect('B');
  await a.client.ping(timeout); await b.client.ping(timeout);
  assert.equal((await a.client.listTools({}, timeout)).tools.length, 4);
  report.checks.push('Real SDK connects to A; after activation new connections use B while active A still responds');
  await b.client.close(); clients.delete(b.client);
  await exited(b.nodePid); await exited(b.descendantPid); await exited(b.routerPid);
  report.checks.push('EOF/normal client close exits the owned router, Node runtime and its descendant');
  const resumed = await connect('B');
  const routerPid = resumed.transport.pid;
  assert.ok(Number.isSafeInteger(routerPid) && routerPid > 0);
  const actual = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${routerPid}").ExecutablePath`], { encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  assert.equal(path.resolve(actual).toLowerCase(), driver.toLowerCase());
  process.kill(routerPid, 'SIGTERM');
  await exited(resumed.nodePid); await exited(resumed.descendantPid); await exited(routerPid);
  await resumed.client.close(); clients.delete(resumed.client);
  process.kill(sentinel.pid, 0);
  await a.client.ping(timeout);
  report.checks.push('Forced exit of this exact fixture router cleans its Node tree; unrelated Node remains alive');
  const active = path.join(base, 'mcp-route-v1', `windows-${manifest.arch}`, 'active.json');
  const before = fs.readFileSync(active);
  const wrongScope = JSON.parse(fs.readFileSync(second.document, 'utf8'));
  wrongScope.product = 'a-different-product';
  const wrongDocument = path.join(out, 'signed-wrong-product.json');
  const wrongBytes = Buffer.from(JSON.stringify(wrongScope));
  fs.writeFileSync(wrongDocument, wrongBytes, { flag: 'wx' });
  fs.writeFileSync(`${wrongDocument}.minisig`, signer.sign(wrongBytes), { flag: 'wx' });
  const wrong = driverRun('activate', wrongDocument, `${wrongDocument}.minisig`);
  assert.equal(wrong.status, 1); assert.match(wrong.stderr, /identity does not match/);
  assert.deepEqual(fs.readFileSync(active), before);
  report.checks.push('Even correctly signed metadata for another product cannot activate MCP');
  const downgrading = driverRun('activate', first.document, first.signature);
  assert.equal(downgrading.status, 1); assert.match(downgrading.stderr, /downgrade/);
  assert.deepEqual(fs.readFileSync(active), before);
  fs.appendFileSync(path.join(second.generation, 'mcp/server/creator-works-mcp.mjs'), '\n// tampered fixture\n');
  const changed = driverRun('connect');
  assert.equal(changed.status, 1); assert.equal(changed.stdout, ''); assert.match(changed.stderr, /runtime bytes changed/);
  await a.client.ping(timeout);
  report.checks.push('Signed downgrade and modified payload refuse without replacing the active receipt or starting Node');
  report.checks.push('Active old session still responds after the new generation is corrupted and refused');
  await a.client.close(); clients.delete(a.client);
  await exited(a.nodePid); await exited(a.descendantPid); await exited(a.routerPid);
  const forbidden = spawnSync(production, ['connect', base, key], { env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(forbidden.status, 64); assert.equal(forbidden.stdout, '');
  report.checks.push('Production executable rejects test keys, paths and configuration override arguments');
  report.passed = true;
})().catch(error => {
  report.error = String(error.stack || error); process.exitCode = 1;
}).finally(async () => {
  for (const client of clients) {
    try { await client.close(); } catch (error) { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; }
  }
  if (sentinel) { sentinel.kill(); await exited(sentinel.pid).catch(error => { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; }); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(`Router acceptance: ${report.passed ? 'PASS' : 'FAIL'}; ${report.checks.length} checks. Evidence: ${out}`);
  if (report.error) console.error(report.error);
});
