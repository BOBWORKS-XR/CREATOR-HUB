const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/native.js'), 'utf8');

function bridge(invoke, key = 'test-shell-key') {
  const window = { __TAURI__: { core: { invoke } }, __CREATOR_SHELL_KEY__: key, __CREATOR_HUB_VERSION__: '0.1.1' };
  vm.runInNewContext(source, { window });
  return window;
}

test('native discovery calls run serially across Projects, Apps, Hub and plugin targets', async () => {
  const calls = [];
  const finishes = [];
  const window = bridge((command, args, options) => {
    calls.push(command);
    assert.equal(options.headers['x-creator-shell-key'], 'test-shell-key');
    return new Promise(resolve => finishes.push(() => resolve(command)));
  });
  const commands = ['project_inventory', 'app_inventory', 'hub_update_status', 'community_projects'];
  const pending = commands.map(command => window.CreatorHubNative.invoke(command));
  for (let index = 0; index < commands.length; index++) {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls, commands.slice(0, index + 1));
    finishes[index]();
    assert.equal(await pending[index], commands[index]);
  }
  assert.equal(window.__CREATOR_SHELL_KEY__, undefined);
  assert.equal(window.CreatorHubNative.version, '0.1.1');
  assert.equal(Object.isFrozen(window.CreatorHubNative), true);
});

test('failed and synchronously throwing scans do not poison subsequent discovery', async () => {
  const window = bridge(command => {
    if (command === 'project_inventory') throw Error('Project scan failed');
    if (command === 'app_inventory') return Promise.reject(Error('App scan failed'));
    return Promise.resolve('Hub status');
  });
  const projects = assert.rejects(window.CreatorHubNative.invoke('project_inventory'), /Project scan failed/);
  const apps = assert.rejects(window.CreatorHubNative.invoke('app_inventory'), /App scan failed/);
  const hub = window.CreatorHubNative.invoke('hub_update_status');
  await projects;
  await apps;
  assert.equal(await hub, 'Hub status');
});

test('user actions and cancellation are not deferred behind pending discovery', async () => {
  const calls = [];
  let finish;
  const window = bridge(command => {
    calls.push(command);
    if (command === 'project_inventory') return new Promise(resolve => { finish = resolve; });
    return Promise.resolve('Native guard handles the action');
  }, undefined);
  const scan = window.CreatorHubNative.invoke('project_inventory');
  await new Promise(resolve => setImmediate(resolve));
  for (const command of ['cancel_download', 'install_app', 'open_app', 'stop_hosted_app']) {
    assert.equal(await window.CreatorHubNative.invoke(command), 'Native guard handles the action');
  }
  assert.deepEqual(calls, ['project_inventory', 'cancel_download', 'install_app', 'open_app', 'stop_hosted_app']);
  finish();
  await scan;
});
