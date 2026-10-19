// Disposable sudo mechanism only. No pkexec, native approval, Root build or retries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { seedSettings } = require('./linux-deb-retention-sdk.cjs');

const SERVER = '/usr/lib/Creator Works MCP/server';
const ALIASES = ['node', 'node.exe'];
const EXPECTED = { CREATOR_LINUX_DEB_HELPER_TRANSACTION: '1', GITHUB_ACTIONS: 'true',
  RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512',
  GITHUB_REF: 'refs/heads/validation/linux-deb-helper-transaction-014', GITHUB_EVENT_NAME: 'push' };
const FALSE_GATES = Object.fromEntries(['productionIntegrated', 'privilegedHelperAccepted', 'nativeTransactionAccepted',
  'nativeApprovalAccepted', 'actualUserAuthenticationAccepted', 'nativeCancellationAccepted', 'guiIdleCloseAccepted',
  'runtimeRetentionAccepted', 'packageGuiRetirementAccepted', 'recoveryAccepted', 'migrationAccepted',
  'setupTransitionAccepted', 'flatpakAccepted', 'signedUpdateAccepted', 'restartAccepted', 'releaseReady',
  'nativeContentionAccepted'].map(key => [key, false]));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');

function admission(env, system, arch, uid) {
  assert.equal(system, 'linux'); assert.equal(arch, 'x64'); assert.ok(uid > 0);
  for (const [key, value] of Object.entries(EXPECTED)) assert.equal(env[key], value, key);
  for (const key of ['FLATPAK_ID', 'APPIMAGE', 'APPDIR', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONPATH']) assert.ok(!env[key], key);
  if (env.CREATOR_LINUX_DEB_HELPER_CONTAINER_IMAGE) {
    assert.equal(uid, 1001);
    assert.equal(env.RUNNER_TEMP, '/__w/_temp');
  }
}

async function connectAndIdentify(client, transport, identify) {
  try {
    await client.connect(transport, { timeout: 10000 });
    const pid = transport.pid;
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    const startTime = identify(pid);
    assert.match(startTime, /^\d+$/);
    return { pid, startTime };
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function exercise({ connect, snapshot, retire, repeat, setup, verifySettings }, report) {
  let live, failure;
  let failed = false;
  try {
    live = await connect('node', 'already-live');
    report.liveBefore = await live.check();
    report.before = await snapshot('before');
    report.setupBefore = await setup.snapshot('before');
    report.reconnectBefore = {};
    for (const alias of ALIASES) {
      const fresh = await connect(alias, `before-${alias}`);
      try { report.reconnectBefore[alias] = await fresh.check(); }
      finally { await fresh.close(); }
    }
    verifySettings();
    report.transaction = await retire();
    verifySettings();
    report.setupTransaction = await setup.retire();
    report.liveAfter = await live.check();
    for (const key of ['pid', 'startTime', 'referenceSha256']) assert.equal(report.liveAfter[key], report.liveBefore[key], key);
    report.reconnectAfter = {};
    for (const alias of ALIASES) {
      const fresh = await connect(alias, `after-${alias}`);
      try { report.reconnectAfter[alias] = await fresh.check(); }
      finally { await fresh.close(); }
    }
    report.after = await snapshot('after');
    report.setupAfter = await setup.snapshot('after');
    assert.equal(Object.keys(report.after.files).length, 9);
    for (const [name, row] of Object.entries(report.after.files)) {
      for (const key of ['bytes', 'sha256', 'md5', 'mode', 'uid', 'gid', 'owner']) assert.equal(row[key], report.before.files[name][key], name);
    }
    verifySettings();
    // Negative repeat only after verified success; never retry a failed/interrupted call.
    report.repeatRefusal = await repeat();
    report.setupRepeatRefusal = await setup.repeat();
  } catch (error) { failed = true; failure = error; }
  try { if (live) await live.close(); }
  catch (error) {
    report.closeError = String(error?.stack || error);
    if (!failed) { failed = true; failure = error; }
  }
  // Preserve the original refusal while independently recording settings after
  // every outcome, including an SDK/transaction/close failure. Never retry it.
  try {
    report.settingsAfter = verifySettings();
    report.settingsSentinelsPreserved = true;
  } catch (error) {
    report.settingsSentinelsPreserved = false;
    report.settingsError = String(error?.stack || error);
    if (!failed) { failed = true; failure = error; }
  }
  if (failed) throw failure;
  report.helperMechanismAccepted = true;
  report.setupHelperMechanismAccepted = true;
}

function native(root, phase, setup = false) {
  assert.ok(['prepare', 'install', 'before', 'retire', 'after', 'repeat'].includes(phase));
  return new Promise((resolve, reject) => {
    const prefix = setup ? 'setup-phase' : 'phase';
    const out = fs.openSync(path.join(root, `${prefix}-${phase}.stdout`), 'wx', 0o600);
    const err = fs.openSync(path.join(root, `${prefix}-${phase}.stderr`), 'wx', 0o600);
    const script = setup ? 'linux-setup-helper-transaction-probe.py' : 'linux-deb-helper-transaction-probe.py';
    const child = spawn('/usr/bin/python3', ['-B', path.join(__dirname, script), phase],
      { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', out, err] });
    fs.closeSync(out); fs.closeSync(err);
    // Deliberately no timeout, signal or automatic retry around a package transaction.
    child.once('error', reject);
    child.once('close', (code, signal) => {
      try {
        assert.equal(signal, null, `Native phase ${phase} interrupted; manual review, no retry`);
        assert.equal(code, 0, `Native phase ${phase} failed; original output retained, no retry`);
        const bytes = fs.readFileSync(path.join(root, `${prefix}-${phase}.stdout`));
        assert.ok(bytes.length <= 262144);
        resolve(JSON.parse(bytes));
      } catch (error) { reject(error); }
    });
  });
}

async function run() {
  admission(process.env, process.platform, process.arch, process.getuid());
  assert.equal(process.argv.length, 2);
  const parent = process.env.RUNNER_TEMP;
  assert.ok(path.isAbsolute(parent)); assert.equal(fs.realpathSync(parent), parent);
  const root = path.join(parent, 'linux-deb-helper-transaction');
  fs.mkdirSync(root, { mode: 0o700 });
  const report = { schemaVersion: 1, scope: 'two fixed disposable sudo experimental helper transactions, not authorization',
    runtimeContext: { runnerTemp: parent, evidenceDirectory: root, uid: process.getuid(), cwd: process.cwd() },
    sourceRevision: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    helperMechanismAccepted: false, setupHelperMechanismAccepted: false, productionGates: { ...FALSE_GATES },
    limitations: ['No native approval/pkexec or production integration', 'No contention/interruption/recovery acceptance',
      'Workflow cancellation may interrupt a transaction; never retry, repair or roll back automatically',
      'Global diversions/statoverrides remain untouched; the helper may intentionally refuse them'] };
  try {
    const sdk = createRequire(path.resolve(__dirname, '../modules/mcp/package.json'));
    const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js');
    const manifest = path.resolve(path.dirname(sdk.resolve('@modelcontextprotocol/sdk/client/index.js')), '../../../package.json');
    report.sdkVersion = JSON.parse(fs.readFileSync(manifest)).version;
    assert.equal(report.sdkVersion, '1.29.0');
    report.plan = await native(root, 'prepare');
    report.fixtureProvisioning = await native(root, 'install');
    report.setupPlan = await native(root, 'prepare', true);
    report.setupFixtureProvisioning = await native(root, 'install', true);
    const settings = seedSettings(root);
    report.settingsBefore = settings.baseline;
    async function connect(alias, label) {
      const command = `${SERVER}/runtime/${alias}`, args = [`${SERVER}/creator-works-mcp.mjs`];
      const client = new Client({ name: 'linux-deb-helper-transaction-validation', version: '1' });
      const transport = new StdioClientTransport({ command, args, env: { HOME: settings.home,
        XDG_CONFIG_HOME: settings.config, XDG_DATA_HOME: settings.data, MCP_TOOL_GROUPS: 'read',
        CREATOR_WORKS_LAUNCHER_CONFIG: path.join(settings.config, 'creator-works-mcp/launcher-config.json') }, stderr: 'pipe' });
      const stderr = fs.createWriteStream(path.join(root, `${label}.stderr`), { flags: 'wx', mode: 0o600 });
      transport.stderr.pipe(stderr);
      const identity = pid => fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
      let pid, startTime;
      try { ({ pid, startTime } = await connectAndIdentify(client, transport, identity)); }
      catch (error) { stderr.end(); throw error; }
      return {
        async check() {
          assert.equal(transport.pid, pid); assert.equal(identity(pid), startTime);
          const tools = (await client.listTools({}, { timeout: 10000 })).tools;
          assert.ok(tools.some(tool => tool.name === 'get_mcp_reference') && tools.length <= 1024);
          const result = await client.callTool({ name: 'get_mcp_reference', arguments: { source: 'workflows', entryId: 'networking', limit: 1 } },
            undefined, { timeout: 10000 });
          assert.notEqual(result.isError, true); assert.equal(result.content.length, 1); assert.equal(result.content[0].type, 'text');
          const text = result.content[0].text; assert.ok(Buffer.byteLength(text) <= 16384);
          const value = JSON.parse(text);
          assert.equal(value.success, true); assert.equal(value.source, 'workflows'); assert.equal(value.returned, 1);
          assert.equal(value.entries[0].entryId, 'networking');
          return { pid, startTime, command, args, tools: tools.length, referenceSha256: sha(text),
            processExecutable: fs.readlinkSync(`/proc/${pid}/exe`) };
        },
        async close() { await client.close(); stderr.end(); },
      };
    }
    await exercise({ connect, snapshot: phase => native(root, phase), retire: () => native(root, 'retire'),
      setup: { snapshot: phase => native(root, phase, true), retire: () => native(root, 'retire', true),
        repeat: () => native(root, 'repeat', true) },
      repeat: () => native(root, 'repeat'), verifySettings: settings.verify }, report);
  } catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
  finally {
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ helperMechanismAccepted: report.helperMechanismAccepted,
      setupHelperMechanismAccepted: report.setupHelperMechanismAccepted, error: report.error,
      productionGates: report.productionGates }));
  }
}

module.exports = { admission, connectAndIdentify, EXPECTED, exercise, FALSE_GATES };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
