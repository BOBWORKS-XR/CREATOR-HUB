'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('real SDK probe uses only verified router and read-only MCP reference tool', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-windows-r14-client.cjs'), 'utf8');
  for (const token of ['target.validateBinding()', 'target.assertActiveResources(', "'../product/modules/mcp/package.json'",
    "CREATOR_WORKS_TOOL_GROUPS: 'read'", "name: 'get_mcp_reference'", 'await within(client.close(), 15000)',
    'target.assertGenerationProcess(', 'processesExited: true']) assert.ok(source.includes(token), token);
  assert.doesNotMatch(source, /writeFile|save_config|execute_code|run_tests|install_bridge|Kill|taskkill|Stop-Process/);
  assert.equal((source.match(/client.callTool\(/g) || []).length, 1);
  assert.ok(source.indexOf('assertActiveResources') < source.indexOf('client.connect'));
});
