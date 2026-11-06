import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const command = process.env.MCP_PROTOCOL_NODE || process.execPath;
const entry = path.resolve(process.env.MCP_PROTOCOL_ENTRY || 'dist/index.js');
const timeout = { timeout: 10_000 };
const fixtureClients = new WeakMap();

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'creator protocol spaces ')));
  const clients = [];
  fixtureClients.set(t, clients);
  t.after(async () => {
    // A failed assertion must close every child before deleting its Windows cwd.
    for (const client of clients.reverse()) await client.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
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
  const clients = fixtureClients.get(t);
  if (!clients) throw new Error('Protocol clients require an owned temporary fixture');
  clients.push(client);
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
    ['get_bridge_status', 'get_unity_command_status', 'list_unity_projects', 'register_unity_project', 'select_unity_project', 'unregister_unity_project']);
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
  const invalid = await client.callTool({ name: 'select_unity_project', arguments: { projectId: '../outside' } }, undefined, timeout);
  assert.equal(invalid.isError, true);
  assert.equal(JSON.parse(invalid.content[0].text).success, false);
  await client.close();
  const reopened = await connect(t, root);
  assert.equal((await call(reopened, 'get_bridge_status')).project.path, first);
  await reopened.close();
  assert.deepEqual(await snapshot(root), before);
});

test('SDK stdio: explicit registration never persists, selects or prevents recovery from a replaced directory', async t => {
  const root = await fixture(t);
  const first = await project(root, 'Saved');
  const second = await project(root, 'Isolated');
  await writeFile(path.join(second, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.21f1\n');
  await writeFile(path.join(root, 'launcher-config.json'), JSON.stringify({ channels: [{ id: 'saved', unity_project_path: first }], untouched: 42 }));
  const before = await snapshot(root);
  const client = await connect(t, root);
  const registered = await call(client, 'register_unity_project', { projectPath: second });
  assert.equal(registered.settingsChanged, false);
  assert.equal((await call(client, 'get_bridge_status')).project.path, first);
  await call(client, 'select_unity_project', { projectId: registered.projectId });
  assert.equal((await call(client, 'get_bridge_status')).project.path, second);
  await rename(second, second + '-moved');
  const refused = await client.callTool({ name: 'get_bridge_status', arguments: {} }, undefined, timeout);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /select another project|register.*again/i);
  const listing = await call(client, 'list_unity_projects', { fields: ['projectId', 'projectPath'] });
  const saved = listing.projects.find(p => p.projectPath === first);
  await call(client, 'select_unity_project', { projectId: saved.projectId });
  assert.equal((await call(client, 'get_bridge_status')).project.path, first);
  await call(client, 'unregister_unity_project', { projectId: registered.projectId });
  await client.close();
  await rename(second + '-moved', second);
  const restarted = await connect(t, root);
  assert.equal((await call(restarted, 'list_unity_projects')).total, 1);
  await restarted.close();
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

test('SDK stdio: scene data survives reconnect and status polling never repeats the command', async t => {
  const root = await fixture(t);
  const selected = await project(root, 'Scene Project');
  const commands = path.join(selected, '.bantworks-mcp', 'commands');
  const state = path.join(selected, '.bantworks-mcp', 'state');
  for (const directory of [commands, ...['command-results', 'command-status', 'scene-results'].map(name => path.join(state, name))]) {
    await mkdir(directory, { recursive: true });
  }
  const settings = JSON.stringify({ active_channel_id: 'scene', channels: [{ id: 'scene', unity_project_path: selected }] });
  await writeFile(path.join(root, 'launcher-config.json'), settings);
  const client = await connect(t, root, { CREATOR_WORKS_TOOL_GROUPS: 'read' });
  const bridge = (async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const files = (await readdir(commands)).filter(name => name.endsWith('.json'));
      if (files.length) {
        assert.equal(files.length, 1);
        const command = JSON.parse(await readFile(path.join(commands, files[0]), 'utf8'));
        assert.equal(command.type, 'get_scenes');
        const receipt = { commandId: command.id, success: true, activeSceneName: 'Fixture',
          openScenes: [{ name: 'Fixture', isDirty: false }], buildScenes: [] };
        const acknowledgement = JSON.stringify({ commandId: command.id, success: true, status: 'completed',
          projectPath: selected, editorInstanceId: 'fixture-editor' });
        await writeFile(path.join(state, 'scene-results', `${command.id}.json`), JSON.stringify(receipt));
        await writeFile(path.join(state, 'command-status', `${command.id}.json`), acknowledgement);
        await writeFile(path.join(state, 'command-results', `${command.id}.json`), acknowledgement);
        await rm(path.join(commands, files[0]));
        return receipt;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('No scene command arrived in the disposable bridge fixture.');
  })();
  const [result, receipt] = await Promise.all([call(client, 'get_unity_scenes'), bridge]);
  assert.equal(result.success, true);
  assert.equal(result.pending, false);
  assert.deepEqual(result.openScenes, receipt.openScenes);
  await client.close();
  const before = await snapshot(root);
  const reopened = await connect(t, root);
  for (let i = 0; i < 2; i++) {
    const status = await call(reopened, 'get_unity_command_status', { commandId: result.commandId, projectId: result.projectId });
    assert.equal(status.success, true);
    assert.equal(status.pending, false);
    assert.deepEqual(status.sceneResult, receipt);
  }
  await reopened.close();
  assert.deepEqual(await snapshot(root), before);
  assert.equal(await readFile(path.join(root, 'launcher-config.json'), 'utf8'), settings);
  assert.deepEqual(await readdir(commands), []);
});
