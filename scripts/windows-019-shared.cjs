'use strict';
// Read-only UI and ownership helpers retained from e4459b0.
const assert = require('node:assert/strict');
const feed = () => require('./self-update-lab-feed-019.cjs');
function freshSettingsBytes() {
  const settings = { channels: [], active_channel_id: null, auto_start: false, mcp_server_path: '', tool_groups: 'read',
    enable_custom_scripts: false, allow_all_tests: false, automatic_update_checks: false, connection_guide_version: 1,
    incoming16_unknown: { keep: 'exact bytes; no merge or reset' } };
  return { current: Buffer.from(JSON.stringify(settings)),
    legacy: Buffer.from(JSON.stringify(settings, null, 2).replace(/\n/g, '\r\n') + '\r\n') };
}

function assertProxy(env) {
  feed().assertRunner(env);
  assert.equal(env.CREATOR_HOSTED_UPDATE_FIXTURE, undefined, 'No baseline fixture or version masquerade');
  for (const name of ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'ALL_PROXY', 'NODE_OPTIONS',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE']) assert.equal(env[name], undefined);
  const proxy = new URL(env.HTTPS_PROXY || '');
  assert.ok(proxy.protocol === 'http:' && proxy.hostname === '127.0.0.1' && /^[1-9][0-9]{0,4}$/.test(proxy.port)
    && Number(proxy.port) <= 65535 && !proxy.username && !proxy.password && proxy.pathname === '/' && !proxy.search && !proxy.hash);
  assert.equal(env.HTTP_PROXY, env.HTTPS_PROXY); assert.equal(env.NO_PROXY, '127.0.0.1,localhost,::1');
}

async function showPage(page, feature) {
  const names = { hub: /^Home\b/, mcp: /^MCP\b/, setup: /^Setup \/ Repair\b/ };
  assert.ok(Object.hasOwn(names, feature));
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await page.getByRole('navigation', { name: 'Creator tools', exact: true }).getByRole('button', { name: names[feature] }).click();
}

function assertOwnedDebugging(state, pid, executable) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const root = state.processes.filter(process => process.ProcessId === pid);
  assert.equal(root.length, 1);
  assert.equal(root[0].ExecutablePath?.toLowerCase(), executable.toLowerCase(), 'Owned Hub executable changed');
  const owned = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const process of state.processes) if (owned.has(process.ParentProcessId) && !owned.has(process.ProcessId)) {
      owned.add(process.ProcessId); changed = true;
    }
  }
  assert.ok(state.listeners.length);
  assert.ok(state.listeners.every(listener => ['127.0.0.1', '::1'].includes(listener.LocalAddress)));
  const active = state.listeners.filter(listener => listener.OwningProcess > 0);
  assert.ok(active.length && active.every(listener => owned.has(listener.OwningProcess)), 'Debugging endpoint must belong to the owned Hub tree');
}

module.exports = { freshSettingsBytes, assertProxy, showPage, assertOwnedDebugging };
