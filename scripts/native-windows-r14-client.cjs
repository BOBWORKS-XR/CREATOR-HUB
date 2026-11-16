'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
async function within(work, ms) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('Owned MCP client deadline exceeded')), ms);
  })]); } finally { clearTimeout(timer); }
}
async function probe({ profile, env, inventory, settingsPath }) {
  const target = require('./windows-outgoing-019-target.cjs');
  target.validateBinding();
  const route = target.managedLocations(profile.local, '0.1.23', profile.home);
  const active = JSON.parse(target.readBounded(route.active, 4096));
  target.assertActiveResources(profile.local, '0.1.23', active, true, profile.home);
  const sdk = createRequire(path.join(__dirname, '../product/modules/mcp/package.json'));
  const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'r14-runtime-repair-readonly', version: '1' });
  const transport = new StdioClientTransport({ command: route.command, args: [], stderr: 'ignore',
    env: { ...env, CREATOR_WORKS_CONFIG_OWNER: 'creator-hub-v1', CREATOR_WORKS_LAUNCHER_CONFIG: settingsPath,
      CREATOR_WORKS_TOOL_GROUPS: 'read' } });
  const before = target.hash(fs.readFileSync(settingsPath));
  let processes;
  try {
    await within((async () => {
      await client.connect(transport);
      assert.equal(client.getServerVersion()?.version, target.binding.target.manifest.modules.mcp.version);
      assert.ok((await client.listTools()).tools.some(tool => tool.name === 'get_mcp_reference'));
      const result = await client.callTool({ name: 'get_mcp_reference',
        arguments: { source: 'creator-docs', query: 'PersistFileBridge', limit: 1 } });
      assert.notEqual(result.isError, true); assert.equal(JSON.parse(result.content[0].text).success, true);
      const rows = inventory();
      const router = rows.filter(row => row.pid === transport.pid); assert.equal(router.length, 1);
      assert.equal(path.win32.normalize(router[0].image).toLowerCase(), path.win32.normalize(route.command).toLowerCase());
      assert.equal(router[0].kernelIdentityVerified, true);
      const runtime = rows.filter(row => row.parentPid === router[0].pid && /node\.exe$/i.test(row.image));
      assert.equal(runtime.length, 1); assert.equal(runtime[0].kernelIdentityVerified, true);
      target.assertGenerationProcess(runtime[0].image, profile.local, '0.1.23', profile.home);
      processes = [router[0], runtime[0]];
    })(), 60000);
  } finally { await within(client.close(), 15000); }
  assert.equal(target.hash(fs.readFileSync(settingsPath)), before);
  assert.ok(inventory().every(row => !processes.some(saved => saved.pid === row.pid)), 'Owned MCP processes must exit');
  return { serverVersion: '2.7.10', readOnlyCallPassed: true, settingsUnchanged: true,
    processesExited: true, routerPid: processes[0].pid, runtimePid: processes[1].pid };
}
module.exports = { probe };
