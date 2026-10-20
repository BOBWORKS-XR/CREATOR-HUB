const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const probe = require('./flatpak-mcp-stdio-probe.cjs');
const pkg = require('./flatpak-package.cjs');
const sandbox = require('./flatpak-disposable.cjs');

function retainedFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-flatpak-retained-fixture-'));
  t.after(() => {
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('creator-flatpak-retained-fixture-') && !fs.lstatSync(base).isSymbolicLink());
    fs.rmSync(base, { recursive: true, force: true });
  });
  const module = { executable: 'mcp/creator-works-mcp-launcher', version: '2.7.7',
    files: { 'mcp/server/creator-works-mcp.mjs': pkg.sha256('synthetic runtime') } };
  const descriptor = Buffer.from(JSON.stringify({ schemaVersion: 1, product: 'com.creatorworks.hub.mcp-runtime',
    hubVersion: '0.1.14', platform: 'linux', arch: 'x86_64', module }));
  // Synthetic signature bytes test retained identity only, not cryptographic validity.
  const baselineSignature = Buffer.from('synthetic minisig\ntrusted comment: timestamp:1\n');
  const replacementSignature = Buffer.from('synthetic minisig\ntrusted comment: timestamp:2\n');
  const route = { schemaVersion: 1, descriptorSha256: pkg.sha256(descriptor), generation: 'd'.repeat(64) };
  const root = path.join(base, 'mcp-route-v1/linux-x86_64'), stored = path.join(root, 'descriptors', route.descriptorSha256);
  const runtime = path.join(base, 'runtime-generations/linux-x86_64', route.generation, 'mcp/server');
  fs.mkdirSync(stored, { recursive: true }); fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(root, 'active.json'), JSON.stringify(route));
  fs.writeFileSync(path.join(stored, 'runtime.json'), descriptor);
  fs.writeFileSync(path.join(stored, 'runtime.minisig'), baselineSignature);
  fs.writeFileSync(path.join(runtime, 'creator-works-mcp.mjs'), 'synthetic runtime');
  const baseline = { modules: { mcp: module }, managedRouting: { files: {
    'routing/runtime.json': pkg.sha256(descriptor), 'routing/runtime.minisig': pkg.sha256(baselineSignature),
  } } };
  const replacement = structuredClone(baseline);
  replacement.managedRouting.files['routing/runtime.minisig'] = pkg.sha256(replacementSignature);
  return { base, stored, baseline, replacement, replacementSignature };
}

function sdkFixture(overrides = {}) {
  const state = { closes: 0, stderr: new PassThrough() };
  class Client {
    async connect(transport, options) { state.connectOptions = options; await overrides.connect?.(); }
    getServerVersion() { return { name: 'creator-works-mcp' }; }
    async listTools(args, options) {
      state.toolsOptions = options;
      return overrides.tools ? overrides.tools() : { tools: [{ name: 'get_mcp_reference' }] };
    }
    async close() { state.closes++; await overrides.close?.(); }
  }
  class StdioClientTransport { constructor() { this.stderr = state.stderr; } }
  return { state, sdk: name => name.endsWith('stdio.js') ? { StdioClientTransport } : { Client } };
}

test('same descriptor and different package signatures preserve the baseline route before and after replacement', async t => {
  const f = retainedFixture(t), read = probe.retainedRouteReader(f.base, f.baseline, f.replacement);
  assert.notEqual(f.baseline.managedRouting.files['routing/runtime.minisig'], f.replacement.managedRouting.files['routing/runtime.minisig']);
  const before = read(), sequence = fixture();
  sequence.snapshot = index => ({ ...(index ? sequence.after : sequence.before), route: read() });
  const result = await probe.replacementSequence(sequence);
  assert.deepEqual(result.before.route, before); assert.deepEqual(result.after.route, before);
  assert.deepEqual(fs.readFileSync(path.join(f.stored, 'runtime.minisig')), Buffer.from('synthetic minisig\ntrusted comment: timestamp:1\n'));
  for (const name of Object.keys(pkg.acceptance())) assert.equal(result[name], false);
});

test('different runtime descriptor body refuses even when MCP module metadata is identical', t => {
  const f = retainedFixture(t);
  f.replacement.managedRouting.files['routing/runtime.json'] = 'e'.repeat(64);
  assert.throws(() => probe.retainedRouteReader(f.base, f.baseline, f.replacement), /same signed runtime descriptor/);
});

test('retained signature tampering refuses, including substitution with the newly packaged signature', t => {
  const f = retainedFixture(t), read = probe.retainedRouteReader(f.base, f.baseline, f.replacement);
  read();
  for (const bytes of [Buffer.from('tampered signature'), f.replacementSignature]) {
    fs.writeFileSync(path.join(f.stored, 'runtime.minisig'), bytes);
    assert.throws(read, /Retained baseline signed descriptor differs/);
  }
});

test('SDK initialize timeout is propagated and closes the owned transport', async () => {
  const timeout = Error('SDK initialize request timed out');
  const f = sdkFixture({ connect: () => { throw timeout; } });
  await assert.rejects(probe.sdkSession({ HOME: '/owned/home' }, f.sdk), error => error === timeout);
  assert.deepEqual(f.state.connectOptions, probe.RPC); assert.equal(f.state.closes, 1);
});

test('SDK tools timeout reaches sequence cleanup without losing the original error', async () => {
  const timeout = Error('SDK tools request timed out');
  const f = sdkFixture({ tools: () => { throw timeout; } });
  const sequence = fixture(); sequence.open = () => probe.sdkSession({ HOME: '/owned/home' }, f.sdk);
  await assert.rejects(probe.replacementSequence(sequence), error => error === timeout);
  assert.deepEqual(f.state.toolsOptions, probe.RPC); assert.equal(f.state.closes, 1);
  assert.equal(sequence.events.includes('replace'), false);
});

test('SDK stderr overflow refuses more requests and still closes the owned transport', async () => {
  const f = sdkFixture(), session = await probe.sdkSession({ HOME: '/owned/home' }, f.sdk);
  try {
    f.state.stderr.write(Buffer.alloc(65537));
    await assert.rejects(session.tools(), /Bounded SDK session exceeded/);
    assert.equal(f.state.closes, 1);
  } finally { await session.close(); }
});

test('SDK initialize completing after the lifetime deadline refuses rather than returning a closed session', async t => {
  let expire, cleared = false;
  const timer = { unref() {} };
  t.mock.method(global, 'setTimeout', (callback, duration) => {
    assert.equal(duration, 120000); expire = callback; return timer;
  });
  t.mock.method(global, 'clearTimeout', value => { assert.equal(value, timer); cleared = true; });
  const f = sdkFixture({ connect: () => { expire(); } });
  await assert.rejects(probe.sdkSession({ HOME: '/owned/home' }, f.sdk), /Bounded SDK session exceeded/);
  assert.ok(cleared); assert.ok(f.state.closes >= 1);
});

function fixture() {
  const events = [], before = { appCommit: 'a'.repeat(64), platformCommit: 'c'.repeat(64), route: { generation: 'd'.repeat(64) } };
  const after = { ...structuredClone(before), appCommit: 'b'.repeat(64) };
  let count = 0;
  return { events, before, after,
    snapshot(index) { events.push(`snapshot-${index}`); return structuredClone(index ? after : before); },
    replace() { events.push('replace'); },
    async open() {
      const id = count++; events.push(`open-${id}`);
      return { async tools() { events.push(`tools-${id}`); return ['get_mcp_reference']; },
        async close() { events.push(`close-${id}`); } };
    },
  };
}

test('SDK factory uses only fixed Flatpak command/argv and finite RPC bounds', async () => {
  let params;
  class Client {
    async connect(transport, options) { assert.deepEqual(options, probe.RPC); }
    getServerVersion() { return { name: 'creator-works-mcp' }; }
    async listTools(args, options) { assert.deepEqual(options, probe.RPC); return { tools: [{ name: 'get_mcp_reference' }] }; }
    async close() {}
  }
  class StdioClientTransport { constructor(value) { params = value; this.stderr = new PassThrough(); } }
  const session = await probe.sdkSession({ HOME: '/owned/home', PATH: '/usr/bin:/bin' }, name =>
    name.endsWith('stdio.js') ? { StdioClientTransport } : { Client });
  try {
    assert.equal(params.command, '/usr/bin/flatpak');
    assert.deepEqual(params.args, ['run', '--command=/app/libexec/creator-hub-mcp-router', pkg.ID]);
    assert.equal(params.env.HOME, '/owned/home'); assert.equal(params.env.SHELL, '/bin/sh');
    assert.equal(params.env.USER, ''); assert.equal(params.stderr, 'pipe');
    assert.deepEqual(await session.tools(), ['get_mcp_reference']);
  } finally { await session.close(); }
});

test('SDK factory preserves connect failure when transport cleanup also fails', async () => {
  class Client {
    async connect() { throw Error('connect refused'); }
    async close() { throw Error('close refused'); }
  }
  class StdioClientTransport { constructor() { this.stderr = new PassThrough(); } }
  await assert.rejects(probe.sdkSession({ HOME: '/owned/home' }, name =>
    name.endsWith('stdio.js') ? { StdioClientTransport } : { Client }), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(item => item.message), ['connect refused', 'close refused']);
    return true;
  });
});

test('replacement retains A, connects B and compares the same runtime/context without broadening', async () => {
  const f = fixture(), result = await probe.replacementSequence(f);
  assert.deepEqual(f.events, ['snapshot-0', 'open-0', 'tools-0', 'snapshot-0', 'replace', 'snapshot-1',
    'open-1', 'tools-1', 'tools-0', 'snapshot-1', 'close-0', 'close-1', 'snapshot-1']);
  assert.equal(result.existingConnectionResponded, true); assert.equal(result.newConnectionResponded, true);
  for (const name of Object.keys(pkg.acceptance())) assert.equal(result[name], false);
});

test('failed baseline context never authorizes replacement or a connection', async () => {
  const f = fixture(); f.snapshot = () => { throw Error('foreign permissions'); };
  await assert.rejects(probe.replacementSequence(f), /foreign permissions/);
  assert.deepEqual(f.events, []);
});

test('no replacement, changed Platform and changed active runtime refuse before new connection', async () => {
  for (const mutate of [f => { f.after.appCommit = f.before.appCommit; }, f => { f.after.platformCommit = 'e'.repeat(64); },
    f => { f.after.route.generation = 'f'.repeat(64); }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(probe.replacementSequence(f));
    assert.equal(f.events.includes('open-1'), false); assert.ok(f.events.includes('close-0'));
  }
});

test('failed new session or lost retained connection closes only the owned sessions', async () => {
  for (const failed of ['new', 'retained']) {
    const f = fixture(), open = f.open;
    let opens = 0;
    f.open = async () => {
      const session = await open(), id = opens++; let calls = 0;
      const tools = session.tools;
      session.tools = async () => {
        if ((failed === 'new' && id === 1) || (failed === 'retained' && id === 0 && calls++)) throw Error('SDK failure');
        return tools();
      };
      return session;
    };
    await assert.rejects(probe.replacementSequence(f), /SDK failure/);
    assert.ok(f.events.includes('close-0') && f.events.includes('close-1'));
  }
});

test('empty environment refuses without effects on native, Linux and Windows admission paths', t => {
  const effects = [], admission = sandbox.admission;
  const unexpected = name => () => { effects.push(name); throw Error(`Unexpected ${name}`); };
  for (const name of ['inside', 'childEnvironment']) t.mock.method(sandbox, name, unexpected(name));
  for (const name of ['read', 'verifyStage']) t.mock.method(pkg, name, unexpected(name));
  const stages = new Proxy([], { get: unexpected('stage access') });
  const replace = unexpected('replacement');
  assert.throws(() => probe.probe('/not/owned', stages, replace, {}), { code: 'ERR_ASSERTION', name: 'AssertionError' });
  for (const platform of ['linux', 'win32']) {
    let admitted = false;
    const mock = t.mock.method(sandbox, 'admission', env => { admission(env, platform, 'x64'); admitted = true; });
    assert.throws(() => probe.probe('/not/owned', stages, replace, {}), { code: 'ERR_ASSERTION', name: 'AssertionError' });
    assert.equal(mock.mock.callCount(), 1);
    assert.deepEqual(mock.mock.calls[0].arguments, [{}]);
    assert.equal(admitted, false);
    mock.mock.restore();
  }
  assert.deepEqual(effects, []);
});

test('cleanup errors preserve the original SDK failure', async () => {
  const f = fixture();
  f.open = async () => ({ async tools() { throw Error('original SDK failure'); }, async close() { throw Error('cleanup failure'); } });
  await assert.rejects(probe.replacementSequence(f), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(item => item.message), ['original SDK failure', 'cleanup failure']);
    return true;
  });
});

test('last recheck detects changes caused during session close', async () => {
  const f = fixture(), open = f.open;
  f.open = async () => {
    const session = await open(), close = session.close;
    session.close = async () => { await close(); f.after.route.generation = 'e'.repeat(64); };
    return session;
  };
  await assert.rejects(probe.replacementSequence(f), /during SDK session cleanup/);
});
