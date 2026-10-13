const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const smoke = require('./desktop-client-smoke.cjs');
const windows = { skip: process.platform !== 'win32' };

function fixture(t, original = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-smoke-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, 'managed-route-20261013-04');
  const node = path.join(stage, 'modules/mcp/server/runtime/node.exe');
  const server = path.join(stage, 'modules/mcp/server/creator-works-mcp.mjs');
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.writeFileSync(node, 'fixture private Node; never executed', { flag: 'wx' });
  fs.writeFileSync(server, 'fixture server; never executed', { flag: 'wx' });
  fs.writeFileSync(path.join(stage, 'builtin-manifest.json'), JSON.stringify({ schemaVersion: 1, platform: 'windows', modules: { mcp: { files: {
    'mcp/server/runtime/node.exe': smoke.sha256(fs.readFileSync(node)),
    'mcp/server/creator-works-mcp.mjs': smoke.sha256(fs.readFileSync(server)),
  } } } }), { flag: 'wx' });
  const paths = { configPath: path.join(root, 'Claude/claude_desktop_config.json'), evidenceRoot: path.join(root, 'artifacts') };
  const options = { testOnly: { ...paths, reviewedHashes: {
    privateNode: smoke.sha256(fs.readFileSync(node)), server: smoke.sha256(fs.readFileSync(server)),
  } } };
  if (original !== null) {
    fs.mkdirSync(path.dirname(paths.configPath));
    fs.writeFileSync(paths.configPath, original, { flag: 'wx' });
  }
  const evidence = path.join(paths.evidenceRoot, 'fixture-01');
  return { root, stage, node, server, options, ...paths, evidence,
    prepare: () => smoke.prepare(stage, 'fixture-01', options), restore: () => smoke.restore(evidence, options) };
}

test('absent config: create exclusively, exact private payload, unopened project, restore absence', windows, t => {
  const f = fixture(t), result = f.prepare();
  assert.equal(result.status, 'prepared, not tested');
  assert.equal(result.name, 'creator-hub-acceptance-fixture-01');
  const config = JSON.parse(fs.readFileSync(f.configPath));
  assert.deepEqual(config.mcpServers[result.name], { command: f.node, args: [f.server], env: {
    UNITY_PROJECT_PATH: path.join(f.evidence, 'fixture-project'), CREATOR_WORKS_TOOL_GROUPS: 'none',
  } });
  assert.deepEqual(fs.readdirSync(path.join(f.evidence, 'fixture-project')), ['Assets']);
  assert.equal(fs.existsSync(path.join(f.evidence, 'config.before.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.evidence, 'prepare.json'))).beforeSha256, null);
  assert.equal(f.restore().status, 'restored');
  assert.equal(fs.existsSync(f.configPath), false);
});

test('preserves unknown fields, exact existing creator-works bytes and original formatting', windows, t => {
  const original = Buffer.from('{\r\n "unknown": {"precise":9007199254740993,"unicode":"caf\\u00e9","array":[true,null]},\r\n "mcpServers": {"creator-works": {"command":"keep", "args":["keep.mjs"],"custom":{"enabled":true},"env":{"UNITY_PROJECT_PATH":"E:/keep","CREATOR_WORKS_TOOL_GROUPS":"read","CREATOR_WORKS_CONFIG_OWNER":"creator-hub-v1"}},"other":{"command":"other","future":17}}\r\n}\r\n');
  const f = fixture(t, original);
  f.prepare();
  const after = fs.readFileSync(f.configPath), beforeParsed = JSON.parse(original), afterParsed = JSON.parse(after);
  assert.deepEqual(afterParsed.unknown, beforeParsed.unknown);
  assert.deepEqual(afterParsed.mcpServers['creator-works'], beforeParsed.mcpServers['creator-works']);
  assert.deepEqual(afterParsed.mcpServers.other, beforeParsed.mcpServers.other);
  assert.ok(after.includes(Buffer.from('"precise":9007199254740993')));
  assert.ok(after.includes(Buffer.from('"unicode":"caf\\u00e9"')));
  const creatorWorksBytes = original.subarray(original.indexOf('"creator-works"'), original.indexOf(',"other"'));
  assert.ok(creatorWorksBytes.length > 0);
  assert.ok(after.includes(creatorWorksBytes), 'Existing creator-works entry must remain byte-for-byte unchanged');
  const receipt = JSON.parse(fs.readFileSync(path.join(f.evidence, 'prepare.json')));
  const prepared = JSON.parse(fs.readFileSync(path.join(f.evidence, 'prepared.json')));
  assert.equal(receipt.beforeSha256, smoke.sha256(original));
  assert.equal(receipt.expectedSha256, smoke.sha256(after));
  assert.deepEqual(receipt.packageHashesBefore, prepared.packageHashesAfter);
  assert.equal(receipt.packageHashesBefore.privateNode, smoke.sha256(fs.readFileSync(f.node)));
  assert.equal(receipt.packageHashesBefore.server, smoke.sha256(fs.readFileSync(f.server)));
  assert.deepEqual(fs.readFileSync(prepared.actualBefore), original);
  assert.deepEqual(fs.readFileSync(path.join(f.evidence, 'config.before.json')), original);
  f.restore();
  assert.deepEqual(fs.readFileSync(f.configPath), original);
  const restored = JSON.parse(fs.readFileSync(path.join(f.evidence, 'restored.json')));
  assert.equal(restored.afterSha256, smoke.sha256(original));
  assert.deepEqual(fs.readFileSync(restored.actualBefore), after);
});

test('existing config without mcpServers retains every original field', () => {
  const before = Buffer.from('{"preferences":{"keep":true},"large":9007199254740993}\n');
  const after = smoke.addEntry(before, 'creator-hub-acceptance-test', { command: 'fixture' });
  assert.ok(after.toString().startsWith(before.toString().slice(0, -2)));
  assert.deepEqual(JSON.parse(after).preferences, { keep: true });
});

for (const [name, original, message] of [
  ['corrupt JSON', '{"mcpServers": BROKEN}', /Invalid JSON/],
  ['duplicate acceptance entry', '{"mcpServers":{"creator-hub-acceptance-fixture-01":{"command":"keep"}}}', /entry already exists/],
  ['duplicate JSON entries', '{"mcpServers":{"other":{"command":"first"},"other":{"command":"second"}}}', /Duplicate JSON/],
  ['non-object servers', '{"mcpServers":[]}', /mcpServers must/],
  ['non-object config', '[]', /JSON object/],
  ['unknown env keys', '{"mcpServers":{"other":{"env":{"CUSTOM":"unreviewed-value"}}}}', /unreviewed key/],
  ['credential env', '{"mcpServers":{"other":{"env":{"API_KEY":"fixture-credential-value"}}}}', /credential/],
  ['credential field', '{"preferences":{"accessToken":"fixture-credential-value"}}', /credential/],
  ['credential arguments', '{"mcpServers":{"other":{"args":["--token","fixture-credential-value"]}}}', /credential/],
]) {
  test(`${name}: refuse without config changes, backup or evidence`, windows, t => {
    const f = fixture(t, original);
    assert.throws(f.prepare, message);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), original);
    assert.equal(fs.existsSync(f.evidenceRoot), false);
  });
}

test('settings over 2 MiB refuse before backup', windows, t => {
  const original = Buffer.alloc(smoke.MAX_BYTES + 1, 32), f = fixture(t, original);
  assert.throws(f.prepare, /2 MiB/);
  assert.deepEqual(fs.readFileSync(f.configPath), original);
  assert.equal(fs.existsSync(f.evidenceRoot), false);
});

test('changed restore refuses, keeps unknown changes and points to exact backup', windows, t => {
  const f = fixture(t, '{"keep":true}\n');
  f.prepare();
  const changed = Buffer.from('{"concurrent":"keep this","mcpServers":{"unknown":{"command":"new"}}}\n');
  fs.writeFileSync(f.configPath, changed);
  assert.throws(f.restore, error => /unknown changes kept/.test(error.message) && error.message.includes(f.evidence));
  assert.deepEqual(fs.readFileSync(f.configPath), changed);
  assert.equal(fs.readFileSync(path.join(f.evidence, 'config.before.json'), 'utf8'), '{"keep":true}\n');
  assert.equal(fs.existsSync(path.join(f.evidence, 'restored.json')), false);
});

test('missing config during restore refuses instead of recreating original', windows, t => {
  const f = fixture(t, '{"keep":true}');
  f.prepare(); fs.unlinkSync(f.configPath);
  assert.throws(f.restore, /Config changed/);
  assert.equal(fs.existsSync(f.configPath), false);
});

test('native stale-before refusal keeps the concurrent writer and retained reviewed backup', windows, t => {
  const f = fixture(t, '{"newWriter":true}');
  fs.mkdirSync(f.evidenceRoot);
  assert.throws(() => smoke.replaceReviewed(f.configPath, Buffer.from('{"old":true}'), Buffer.from('{"test":true}'), f.evidenceRoot, 'race'), /not overwritten/);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), '{"newWriter":true}');
  const operation = path.join(f.evidenceRoot, fs.readdirSync(f.evidenceRoot)[0]);
  assert.equal(fs.readFileSync(path.join(operation, 'reviewed-before.json'), 'utf8'), '{"old":true}');
  assert.equal(fs.existsSync(path.join(operation, 'actual-before.json')), false);
});

test('tampered expected bytes or original backup cannot authorize restore', windows, t => {
  const f = fixture(t, '{"keep":true}'); f.prepare();
  const current = fs.readFileSync(f.configPath);
  fs.writeFileSync(path.join(f.evidence, 'config.expected.json'), '{"tampered":true}');
  assert.throws(f.restore, /Reviewed test bytes differ/);
  assert.deepEqual(fs.readFileSync(f.configPath), current);
  fs.writeFileSync(path.join(f.evidence, 'config.expected.json'), current);
  fs.writeFileSync(path.join(f.evidence, 'config.before.json'), '{"tampered":true}');
  assert.throws(f.restore, /backup hash differs/);
  assert.deepEqual(fs.readFileSync(f.configPath), current);
});

test('evidence labels are exclusive and traversal is refused', windows, t => {
  const f = fixture(t);
  assert.throws(() => smoke.prepare(f.stage, '../escape', f.options), /label/);
  f.prepare();
  const current = fs.readFileSync(f.configPath);
  assert.throws(f.prepare, /already exists/);
  assert.deepEqual(fs.readFileSync(f.configPath), current);
  assert.throws(() => smoke.restore(f.root, f.options), /evidence folder/);
});

test('candidate hash mismatch refuses without config backup or changes', windows, t => {
  const f = fixture(t, '{}'); fs.writeFileSync(f.server, 'wrong server');
  assert.throws(f.prepare, /do not match/);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), '{}');
  assert.equal(fs.existsSync(f.evidenceRoot), false);
});

test('a matching unsigned manifest cannot authorize substituted payload bytes', windows, t => {
  const f = fixture(t, '{}');
  fs.writeFileSync(f.server, 'substituted server');
  const manifestPath = path.join(f.stage, 'builtin-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.modules.mcp.files['mcp/server/creator-works-mcp.mjs'] = smoke.sha256(fs.readFileSync(f.server));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(f.prepare, /reviewed candidate hashes/);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), '{}');
  assert.equal(fs.existsSync(f.evidenceRoot), false);
});

test('production hash pins cannot be overridden by flat module options', windows, t => {
  const f = fixture(t, '{}');
  const options = { testOnly: { configPath: f.configPath, evidenceRoot: f.evidenceRoot }, reviewedHashes: f.options.testOnly.reviewedHashes };
  assert.throws(() => smoke.prepare(f.stage, 'fixture-01', options), /reviewed candidate hashes/);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), '{}');
  assert.equal(fs.existsSync(f.evidenceRoot), false);
});

test('credential values never reach output, including parse failures and unreviewed env', t => {
  const f = fixture(t);
  const script = path.join(__dirname, 'desktop-client-smoke.cjs');
  for (const original of ['{"mcpServers":{"other":{"env":{"API_KEY":"fixture-credential-value"}}}}',
    '{"mcpServers":{"other":{"env":{"CUSTOM":"fixture-credential-value"}}}}', '{"accessToken":"fixture-credential-value" BROKEN']) {
    const result = spawnSync(process.execPath, ['-e', `const s=require(${JSON.stringify(script)}); try { s.addEntry(Buffer.from(${JSON.stringify(original)}), 'test', {}); } catch(e) { console.error(e.message); process.exitCode=1; }`],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.ifError(result.error); assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-credential-value/);
    assert.match(result.stderr, /without backup|no backup/);
  }
  assert.equal(fs.existsSync(f.evidenceRoot), false);
});

test('CLI refuses invalid invocation/candidate before accessing actual user config', () => {
  const script = path.join(__dirname, 'desktop-client-smoke.cjs');
  for (const args of [[], ['prepare', 'wrong-stage', 'unique-label'], ['restore'], ['prepare', 'stage', 'label', '--config=elsewhere']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.ifError(result.error); assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:|exact reviewed candidate/);
    assert.doesNotMatch(result.stderr, /ENOENT|credential-value/);
  }
});
