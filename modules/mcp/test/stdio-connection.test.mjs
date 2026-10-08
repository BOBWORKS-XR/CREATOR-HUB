import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const command = process.env.MCP_PROTOCOL_NODE || process.execPath;
const entry = path.resolve(process.env.MCP_PROTOCOL_ENTRY || 'dist/index.js');
const timeout = { timeout: 10_000 };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'creator protocol spaces '));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  return root;
}

async function snapshot(root) {
  const files = {};
  async function visit(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      const name = path.relative(root, file);
      if (item.isDirectory()) { files[`${name}/`] = 'directory'; await visit(file); }
      else files[name] = (await readFile(file)).toString('base64');
    }
  }
  await visit(root);
  return files;
}

async function connect(t, root, overrides = {}) {
  const client = new Client({ name: 'creator-protocol-acceptance', version: '1' });
  const transport = new StdioClientTransport({ command, args: [entry], cwd: root, stderr: 'pipe',
    env: { HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, XDG_CONFIG_HOME: root,
      UNITY_PROJECT_PATH: '', BANTER_PROJECT_PATH: '', CREATOR_WORKS_TOOL_GROUPS: 'none',
      CREATOR_WORKS_LAUNCHER_CONFIG: path.join(root, 'launcher-config.json'), ...overrides } });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
  t.after(() => client.close());
  try { await client.connect(transport, timeout); }
  catch (error) { throw new Error(`Stdio connection failed: ${stderr}`, { cause: error }); }
  assert.equal(client.getServerVersion().name, 'creator-works-mcp');
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, timeout);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content.find(item => item.type === 'text').text);
}

async function project(root, name) {
  const directory = path.join(root, name);
  await mkdir(path.join(directory, 'Assets'), { recursive: true });
  await mkdir(path.join(directory, 'ProjectSettings'));
  return directory;
}

test('SDK stdio: a fresh user can connect and receives actionable missing-project diagnostics', async t => {
  const root = await fixture(t);
  const before = await snapshot(root);
  const client = await connect(t, root);
  assert.deepEqual((await client.listTools({}, timeout)).tools.map(tool => tool.name).sort(),
    ['get_bridge_status', 'get_unity_command_status', 'list_unity_projects', 'select_unity_project']);
  const status = await call(client, 'get_bridge_status');
  assert.equal(status.success, false);
  assert.match(status.error, /UNITY_PROJECT_PATH/);
  assert.ok(status.nextSteps.length > 0);
  assert.deepEqual((await call(client, 'list_unity_projects')).projects, []);
  await client.ping(timeout);
  await client.close();
  assert.deepEqual(await snapshot(root), before, 'Read-only connection must not create settings or project files');
});

test('SDK stdio: project selection is session-local and reconnect uses saved settings', async t => {
  const root = await fixture(t);
  const first = await project(root, 'Project A');
  const second = await project(root, 'Project B');
  await writeFile(path.join(root, 'launcher-config.json'), JSON.stringify({ active_channel_id: 'a',
    channels: [{ id: 'a', unity_project_path: first }, { id: 'b', unity_project_path: second }] }));
  const before = await snapshot(root);
  const client = await connect(t, root);
  assert.equal((await call(client, 'get_bridge_status')).project.path, first);
  const listing = await call(client, 'list_unity_projects');
  const route = listing.projects.find(p => p.projectPath === second);
  assert.equal((await call(client, 'select_unity_project', { projectId: route.projectId })).success, true);
  const status = await call(client, 'get_bridge_status');
  assert.equal(status.project.path, second);
  assert.equal(status.ready, false, 'A protocol connection is not a live Unity bridge');
  assert.equal((await call(client, 'select_unity_project', { projectId: '../outside' })).success, false);
  await client.close();
  const reopened = await connect(t, root);
  assert.equal((await call(reopened, 'get_bridge_status')).project.path, first);
  await reopened.close();
  assert.deepEqual(await snapshot(root), before);
});

test('SDK stdio: default settings discovery uses the native launcher directory', async t => {
  const root = await fixture(t);
  const saved = await project(root, 'Saved Project');
  const configRoot = process.platform === 'darwin' ? path.join(root, 'Library', 'Application Support') : root;
  const directory = path.join(configRoot, 'creator-works-mcp');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'launcher-config.json'), JSON.stringify({ active_channel_id: 'saved',
    channels: [{ id: 'saved', unity_project_path: saved }] }));
  const before = await snapshot(root);
  const client = await connect(t, root, { CREATOR_WORKS_LAUNCHER_CONFIG: '', BANTWORKS_LAUNCHER_CONFIG: '' });
  assert.equal((await call(client, 'get_bridge_status')).project.path, saved);
  assert.equal((await call(client, 'list_unity_projects')).projects.length, 1);
  await client.close();
  assert.deepEqual(await snapshot(root), before);
});

test('SDK stdio: malformed channel entries cannot prevent connection or hide valid projects', async t => {
  const root = await fixture(t);
  const valid = await project(root, 'Valid Project');
  await writeFile(path.join(root, 'launcher-config.json'), JSON.stringify({ channels:
    [null, 42, 'bad', [], { id: 'bad', unity_project_path: 27 }, { id: 'valid', unity_project_path: valid }] }));
  const before = await snapshot(root);
  const client = await connect(t, root);
  const listing = await call(client, 'list_unity_projects');
  assert.equal(listing.projects.length, 1);
  assert.equal(listing.projects[0].projectPath, valid);
  assert.ok(listing.warnings.length > 0, 'Rejected saved entries must be explained');
  assert.equal((await call(client, 'get_bridge_status')).project.path, valid);
  await client.close();
  assert.deepEqual(await snapshot(root), before, 'Invalid saved settings must not be rewritten');
});

test('SDK stdio: malformed JSON is recoverable without modifying it or crashing the session', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'launcher-config.json'), '{not valid json');
  const before = await snapshot(root);
  const client = await connect(t, root);
  const listing = await call(client, 'list_unity_projects');
  assert.deepEqual(listing.projects, []);
  assert.ok(listing.warnings.length > 0);
  await assert.rejects(client.callTool({ name: 'unknown_tool', arguments: {} }, undefined, timeout), /disabled by CREATOR_WORKS_TOOL_GROUPS/);
  await client.ping(timeout);
  await client.close();
  assert.deepEqual(await snapshot(root), before);
});
