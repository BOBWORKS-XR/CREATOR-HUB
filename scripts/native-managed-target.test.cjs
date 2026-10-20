const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { managedLocations, verifyMigratedTarget } = require('./native-managed-target.cjs');

test('managed migration assertions require the exact stable router and no legacy arguments', t => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-native-target-'));
  t.after(() => fs.rmSync(local, { recursive: true, force: true }));
  const route = managedLocations(local);
  fs.mkdirSync(path.dirname(route.command), { recursive: true });
  fs.writeFileSync(route.command, 'native-fixture-never-executed');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(route.command)).digest('hex');
  const manifest = { managedRouting: { protocol: 1, files: { 'routing/creator-hub-mcp-router.exe': digest } } };
  verifyMigratedTarget({ command: route.command, args: [] }, manifest, 'unused', local);
  assert.throws(() => verifyMigratedTarget({ command: route.command, args: ['legacy.mjs'] }, manifest, 'unused', local), /must not retain/);
  const foreign = path.join(local, 'foreign.exe');
  fs.copyFileSync(route.command, foreign);
  assert.throws(() => verifyMigratedTarget({ command: foreign, args: [] }, manifest, 'unused', local));
  fs.writeFileSync(route.command, 'different');
  assert.throws(() => verifyMigratedTarget({ command: route.command, args: [] }, manifest, 'unused', local), /exact packaged signed router/);
});

test('legacy fixture target assertions remain unchanged', t => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-native-target-'));
  t.after(() => fs.rmSync(local, { recursive: true, force: true }));
  const server = path.join(local, 'mcp/server/creator-works-mcp.mjs');
  const node = path.join(local, 'mcp/server/runtime/node.exe');
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.writeFileSync(node, 'never-executed'); fs.writeFileSync(server, 'never-executed');
  verifyMigratedTarget({ command: node, args: [server] }, {}, local, local);
  assert.throws(() => managedLocations('relative'), /absolute/);
});
