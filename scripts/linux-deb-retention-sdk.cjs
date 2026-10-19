// SDK client remains alive across the real dpkg transaction. No application/UI integration.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

const SERVER = '/usr/lib/Creator Works MCP/server';
const ALIASES = ['node', 'node.exe'];
const FALSE_GATES = Object.fromEntries(['nativeCancellationAccepted', 'tamperAccepted', 'recoveryAccepted',
  'guiIdleCloseAccepted', 'setupTransitionAccepted', 'productionIntegrated', 'migrationAccepted',
  'flatpakAccepted', 'signedUpdateAccepted', 'releaseReady'].map(k => [k, false]));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');

function admission(env, platform, arch) {
  assert.equal(platform, 'linux'); assert.equal(arch, 'x64');
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REPOSITORY_ID: '1364807512', GITHUB_REF: 'refs/heads/validation/linux-deb-retention-014',
    GITHUB_EVENT_NAME: 'push', CREATOR_LINUX_DEB_RETENTION: '1' })) assert.equal(env[key], value, key);
  for (const key of ['FLATPAK_ID', 'APPIMAGE', 'APPDIR']) assert.ok(!env[key], key);
}

async function exercise({ connect, snapshot, upgrade, verifySettings }, report) {
  let live, failure;
  let failed = false;
  try {
    live = await connect('node', 'already-live');
    report.liveBefore = await live.check();
    report.before = await snapshot('before');
    report.reconnectBefore = {};
    for (const alias of ALIASES) {
      const fresh = await connect(alias, `before-${alias}`);
      try { report.reconnectBefore[alias] = await fresh.check(); }
      finally { await fresh.close(); }
    }
    verifySettings();
    report.transaction = await upgrade();
    report.liveAfter = await live.check();
    assert.equal(report.liveAfter.pid, report.liveBefore.pid, 'Already-live PID changed');
    assert.equal(report.liveAfter.startTime, report.liveBefore.startTime, 'Already-live process identity changed');
    assert.equal(report.liveAfter.referenceSha256, report.liveBefore.referenceSha256);
    report.reconnectAfter = {};
    for (const alias of ALIASES) {
      const fresh = await connect(alias, `after-${alias}`);
      try { report.reconnectAfter[alias] = await fresh.check(); }
      finally { await fresh.close(); }
    }
    report.after = await snapshot('after');
    verifySettings();
    for (const [name, file] of Object.entries(report.after.files)) {
      const before = report.before.files[name];
      for (const key of ['bytes', 'sha256', 'md5', 'mode', 'uid', 'gid', 'owner']) assert.equal(file[key], before[key], name);
    }
  } catch (error) { failed = true; failure = error; }
  try { if (live) await live.close(); }
  catch (error) {
    report.closeError = String(error?.stack || error);
    if (!failed) { failed = true; failure = error; }
  }
  try {
    report.settingsAfter = verifySettings();
    report.settingsSentinelsPreserved = true;
  } catch (error) {
    report.settingsSentinelsPreserved = false;
    report.settingsError = String(error?.stack || error);
    if (!failed) { failed = true; failure = error; }
  }
  if (failed) throw failure;
  report.runtimeRetentionAccepted = true;
  report.packageGuiRetirementAccepted = true;
}

function seedSettings(root) {
  const home = path.join(root, 'home'), config = path.join(home, '.config'), data = path.join(home, '.local/share');
  const channel = { id: 'retention-project', name: 'Retention fixture', unity_project_path: path.join(home, 'project'), scene_path: null, enabled: true };
  const launcher = { channels: [channel], active_channel_id: channel.id, mcp_server_path: `${SERVER}/creator-works-mcp.mjs`,
    auto_start: false, enable_custom_scripts: false, allow_all_tests: false, tool_groups: 'read', automatic_update_checks: false };
  const files = {
    '.config/creator-works-mcp/launcher-config.json': JSON.stringify({ ...launcher, sentinel: 'mcp-current-retain-exact' }),
    '.config/banter-mcp/launcher-config.json': JSON.stringify({ ...launcher, auto_start: true, sentinel: 'legacy-retain-exact' }) + '\n',
    '.config/creator-works-mcp/hosted-operation-outcomes.json': '{"revision":1,"records":[]}\n',
    '.config/creator-works-mcp/launcher-settings.json': '{"sentinel":"options-retain-exact"}\n',
    '.local/share/CreatorProjectSetup/editor-roots.json': '["/opt/retention-fixture/Unity/Editor"]\n',
    '.local/share/CreatorProjectSetup/preferences.json': '{"sentinel":"setup-retain-exact"}\n',
    // Correct current-schema fields plus an intentionally unsupported future
    // field: retirement-only byte preservation, not valid GUI preference acceptance.
    '.local/share/CreatorHub/preferences/hub-preferences.json': JSON.stringify({ schemaVersion: 1,
      preview: true, autoDownload: false, restoreHostedViews: true,
      unknownRetentionField: { keep: 'hub-real-store-retain-exact' } }) + '\n',
    '.config/creator-hub/preferences.json': '{"sentinel":"hub-retain-exact"}\n',
    '.codex/config.toml': `# untouched representative client\n[mcp_servers.retained]\ncommand = "${SERVER}/runtime/node"\nargs = ["${SERVER}/creator-works-mcp.mjs"]\n`,
    'project/retention-sentinel.txt': 'project-retain-exact\n',
    '.local/share/creator-works-mcp/server/cache-sentinel.txt': 'cache-retain-exact\n',
  };
  const baseline = {};
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(home, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
    baseline[relative] = fingerprint(target);
  }
  function fingerprint(target) {
    assert.equal(fs.realpathSync(target), target);
    const before = fs.lstatSync(target, { bigint: true });
    assert.ok(before.isFile() && before.nlink === 1n);
    const bytes = fs.readFileSync(target);
    const after = fs.lstatSync(target, { bigint: true });
    for (const key of ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeNs', 'ctimeNs']) assert.equal(after[key], before[key], key);
    return { bytes: bytes.length, sha256: sha(bytes), device: String(before.dev), inode: String(before.ino),
      mode: Number(before.mode & 0o7777n), uid: Number(before.uid), gid: Number(before.gid) };
  }
  function verify() {
    const observed = {};
    for (const [relative, before] of Object.entries(baseline)) {
      observed[relative] = fingerprint(path.join(home, relative));
      assert.deepEqual(observed[relative], before, relative);
    }
    return observed;
  }
  return { home, config, data, baseline, verify };
}

async function run() {
  admission(process.env, process.platform, process.arch);
  const root = path.join(fs.realpathSync(process.env.RUNNER_TEMP), 'linux-deb-retention');
  fs.mkdirSync(root, { mode: 0o700 });
  const report = { scope: 'single-public-mcp-deb-to-runtime-only-package-upgrade', sourceRevision: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID, ...FALSE_GATES, runtimeRetentionAccepted: false,
    packageGuiRetirementAccepted: false, passed: false };
  const native = phase => JSON.parse(execFileSync('/usr/bin/python3', ['-B', path.join(__dirname, 'linux-deb-retention-probe.py'), phase],
    { encoding: 'utf8', timeout: 600000, maxBuffer: 262144 }));
  try {
    const sdk = createRequire(path.resolve('modules/mcp/package.json'));
    const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js');
    const sdkPackage = path.resolve(path.dirname(sdk.resolve('@modelcontextprotocol/sdk/client/index.js')), '../../../package.json');
    report.sdkVersion = JSON.parse(fs.readFileSync(sdkPackage)).version;
    assert.equal(report.sdkVersion, '1.29.0');
    report.plan = native('prepare');
    native('install');
    const settings = seedSettings(root);
    report.settingsBefore = settings.baseline;
    async function connect(alias, label) {
      const command = `${SERVER}/runtime/${alias}`, args = [`${SERVER}/creator-works-mcp.mjs`];
      const client = new Client({ name: 'linux-deb-retention-validation', version: '1' });
      const transport = new StdioClientTransport({ command, args, env: { HOME: settings.home,
        XDG_CONFIG_HOME: settings.config, XDG_DATA_HOME: settings.data, MCP_TOOL_GROUPS: 'read',
        CREATOR_WORKS_LAUNCHER_CONFIG: path.join(settings.config, 'creator-works-mcp/launcher-config.json') }, stderr: 'pipe' });
      const stderr = fs.createWriteStream(path.join(root, `${label}.stderr`), { flags: 'wx' });
      transport.stderr.pipe(stderr);
      try { await client.connect(transport, { timeout: 10000 }); }
      catch (error) { await client.close(); stderr.end(); throw error; }
      const pid = transport.pid;
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      const startTime = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
      return {
        async check() {
          assert.equal(transport.pid, pid);
          const now = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19];
          assert.equal(now, startTime);
          const tools = (await client.listTools({}, { timeout: 10000 })).tools;
          assert.ok(tools.some(tool => tool.name === 'get_mcp_reference') && tools.length <= 1024);
          const result = await client.callTool({ name: 'get_mcp_reference', arguments: { source: 'workflows', entryId: 'networking', limit: 1 } },
            undefined, { timeout: 10000 });
          assert.notEqual(result.isError, true); assert.equal(result.content.length, 1);
          assert.equal(result.content[0].type, 'text');
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
    await exercise({ connect, snapshot: native, upgrade: () => native('upgrade'), verifySettings: settings.verify }, report);
    report.passed = true;
  } catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
  finally {
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ passed: report.passed, error: report.error, runtimeRetentionAccepted: report.runtimeRetentionAccepted,
      packageGuiRetirementAccepted: report.packageGuiRetirementAccepted, ...FALSE_GATES }));
  }
}

module.exports = { admission, exercise, seedSettings, FALSE_GATES };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
