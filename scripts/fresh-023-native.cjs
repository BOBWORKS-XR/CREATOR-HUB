'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const contract = require('./fresh-023-contract.cjs');
const target = require('./windows-outgoing-019-target.cjs');
const { fixture } = require('./sdk-project-fixtures.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function retry(read, seconds = 30) {
  let last;
  for (const end = Date.now() + seconds * 1000; Date.now() < end; await delay(250)) {
    try { return await read(); } catch (error) { last = error; }
  }
  throw last || Error('Fresh acceptance deadline exceeded');
}
function inventory() {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'native-outgoing-process-019.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024 }));
}
function assertFreshNamespace(env = process.env, execute = execFileSync) {
  for (const [root, names] of [[env.LOCALAPPDATA, ['Creator Hub', 'Creator Works MCP', 'Creator Project Setup', 'CreatorHub', 'creator-hub', 'CreatorProjectSetup']],
    [env.APPDATA, ['creator-works-mcp', 'banter-mcp', 'Claude/claude_desktop_config.json']],
    [env.USERPROFILE, ['.codex/config.toml', '.claude.json']]]) {
    assert.ok(path.isAbsolute(root));
    for (const name of names) assert.equal(fs.existsSync(path.join(root, name)), false, 'Fresh disposable namespace required');
  }
  const script = "$ErrorActionPreference='Stop';$items=@();foreach($hive in @('HKCU:','HKLM:')){foreach($name in @('Creator Hub','Creator Works MCP','Creator Project Setup')){if(Test-Path -LiteralPath ($hive+'\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$name)){$items+=$name}}};ConvertTo-Json -Compress -InputObject @($items)";
  assert.deepEqual(JSON.parse(execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 })), []);
  const apps = inventory().filter(row => /(?:creator-hub|creator-project-setup|creator-works-mcp-launcher|creator-hub-mcp-router)\.exe$/i.test(row.image));
  assert.deepEqual(apps, [], 'Existing product processes refused');
}
const EXPECTED = { creator: 'core,creator', banter: 'core,banter', hybrid: 'core,banter,creator', none: 'core' };
function validateAuto(rows) {
  assert.equal(rows.defaultSelection, 'auto');
  assert.deepEqual(Object.keys(rows.profiles).sort(), ['banter', 'creator', 'hybrid', 'malformed', 'missing', 'none']);
  for (const [name, groups] of Object.entries(EXPECTED)) assert.deepEqual(rows.profiles[name], { profile: name, groups, error: false });
  for (const name of ['missing', 'malformed']) assert.deepEqual(rows.profiles[name], { profile: 'unknown', groups: null, error: true });
  assert.equal(rows.manifestsUnchanged, true); assert.equal(rows.clientFilesAbsent, true);
}
async function checkAuto(page, out, reopen = false) {
  assert.match(path.basename(out), /^native-suite-[0-9]+$/);
  assert.equal(path.dirname(out), path.resolve('artifacts'));
  const root = path.join(out, 'sdk-fixtures'), rows = { profiles: {} }, before = [];
  for (const name of [...Object.keys(EXPECTED), 'missing', 'malformed']) {
    const folder = path.join(root, name), manifest = path.join(folder, 'Packages/manifest.json');
    const contents = name === 'missing' ? null : name === 'malformed' ? '{"dependencies":' : fixture(name).manifest;
    if (!reopen) {
      assert.equal(fs.existsSync(folder), false);
      for (const sub of ['Assets', 'ProjectSettings', 'Packages']) fs.mkdirSync(path.join(folder, sub), { recursive: true });
      fs.writeFileSync(path.join(folder, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.3.21f1\n', { flag: 'wx' });
      if (contents !== null) fs.writeFileSync(manifest, contents, { flag: 'wx' });
    }
    assert.equal(fs.existsSync(path.join(folder, 'Packages/packages-lock.json')), false);
    if (contents === null) assert.equal(fs.existsSync(manifest), false);
    else { assert.equal(fs.readFileSync(manifest, 'utf8'), contents); before.push([manifest, contents]); }
    const profile = await page.evaluate(folder => window.CreatorHubNative.invoke('feature_call', {
      feature: 'mcp', command: 'get_project_sdk_profile', args: { unityProjectPath: folder },
    }), folder);
    rows.profiles[name] = { profile: profile.profile, groups: profile.recommendedToolGroups, error: Boolean(profile.error) };
  }
  const config = await page.evaluate(() => window.CreatorHubNative.invoke('feature_call', { feature: 'mcp', command: 'load_config', args: {} }));
  rows.defaultSelection = config.tool_groups;
  for (const [file, contents] of before) assert.equal(fs.readFileSync(file, 'utf8'), contents);
  rows.manifestsUnchanged = true;
  for (const file of [path.join(process.env.USERPROFILE, '.codex/config.toml'), path.join(process.env.USERPROFILE, '.claude.json'),
    path.join(process.env.APPDATA, 'Claude/claude_desktop_config.json')]) assert.equal(fs.existsSync(file), false);
  rows.clientFilesAbsent = true; validateAuto(rows); return rows;
}
function validatePair(rows) {
  assert.equal(rows.length, 2);
  const router = path.win32.join(process.env.LOCALAPPDATA || 'C:/unit/Local', 'creator-hub/mcp-route-v1/windows-x86_64/router-v1/creator-hub-mcp-router.exe');
  const runtime = path.win32.join(process.env.LOCALAPPDATA || 'C:/unit/Local', 'creator-hub/runtime-generations/windows-x86_64', target.binding.target.generation, 'mcp/server/runtime/node.exe');
  const normalize = v => path.win32.normalize(v).toLowerCase();
  for (const row of rows) { assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0); assert.match(row.startTicks, /^[0-9]+$/); assert.ok(BigInt(row.startTicks) > 0n); assert.equal(row.kernelIdentityVerified, true); }
  assert.equal(rows[1].parentPid, rows[0].pid);
  assert.equal(normalize(rows[0].image), normalize(router)); assert.equal(normalize(rows[1].image), normalize(runtime));
}
function validateConnections(before, after, fresh) {
  validatePair(before); validatePair(after); validatePair(fresh); assert.deepEqual(after, before);
  assert.equal(new Set([...before, ...fresh].map(row => row.pid)).size, 4, 'Fresh router/runtime processes required');
}
async function hold(page, out, approve) {
  const local = process.env.LOCALAPPDATA, route = require('./native-managed-target.cjs').managedLocations(local);
  const clientConfig = path.join(process.env.USERPROFILE, '.codex/config.toml');
  await require('./native-outgoing-direct-019.cjs').prepareManagedRoute(page, { clientConfig, active: route.active, approve });
  contract.assertRoute(local);
  const sdk = createRequire(path.resolve('product/modules/mcp/package.json'));
  const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js');
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SIGNING|CREDENTIAL|AUTHORIZATION|PROXY|^(?:NODE_|WEBVIEW2_|CREATOR_|TAURI_)/i.test(key)));
  Object.assign(environment, { UNITY_PROJECT_PATH: path.join(out, 'sdk-fixtures/creator'), CREATOR_WORKS_TOOL_GROUPS: 'core,creator' });
  let existing, current, freshRecords;
  const owned = [];
  async function roundTrip(client) {
    assert.equal(client.getServerVersion().version, '2.7.10');
    assert.ok((await client.listTools()).tools.some(t => t.name === 'get_mcp_reference'));
    const response = await client.callTool({ name: 'get_mcp_reference', arguments: { source: 'creator-docs', query: 'PersistFileBridge', limit: 1 } });
    assert.notEqual(response.isError, true); assert.equal(JSON.parse(response.content[0].text).success, true);
  }
  async function connect() {
    const client = new Client({ name: 'private-fresh-023-connection', version: '1' });
    const transport = new StdioClientTransport({ command: route.command, args: [], env: environment, stderr: 'ignore' });
    owned.push(client);
    await client.connect(transport); await roundTrip(client);
    const records = await retry(() => {
      const rows = inventory(), router = rows.find(row => row.pid === transport.pid); assert.ok(router);
      const nodes = rows.filter(row => row.parentPid === router.pid && /node\.exe$/i.test(row.image)); assert.equal(nodes.length, 1);
      const pair = [router, nodes[0]]; validatePair(pair); target.assertGenerationProcess(pair[1].image, local, '0.1.23'); return pair;
    });
    return { client, records };
  }
  try { existing = await connect(); }
  catch (error) { for (const client of owned) await client.close().catch(() => {}); throw error; }
  return {
    before: existing.records,
    async verify(report) {
      contract.assertRoute(local); await roundTrip(existing.client);
      current = existing.records.map(row => { const found = inventory().find(v => v.pid === row.pid); assert.deepEqual(found, row); return found; });
      const fresh = await connect(); freshRecords = fresh.records;
      validateConnections(existing.records, current, fresh.records);
      Object.assign(report, { heldProcessesBefore: existing.records, heldProcessesAfter: current, reconnectedProcesses: fresh.records,
        existingConnectionSurvived: true, newConnectionVerified: true });
    },
    async close() {
      for (const client of owned) await client.close();
      await retry(() => {
        const rows = inventory();
        for (const item of [...existing.records, ...(freshRecords || [])]) assert.equal(rows.some(row => row.pid === item.pid && row.startTicks === item.startTicks), false);
      });
    },
  };
}
module.exports = { assertFreshNamespace, validateAuto, checkAuto, validateConnections, hold };
