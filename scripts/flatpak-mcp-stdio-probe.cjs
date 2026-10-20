// Parent-coordinated, disposable-runner probe. No build, deployment or route activation here.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const pkg = require('./flatpak-package.cjs');
const sandbox = require('./flatpak-disposable.cjs');
const OUTPUT = pkg.ROUTER_OUTPUT;
const COMMAND = '/usr/bin/flatpak';
const ARGS = Object.freeze(['run', '--command=/app/libexec/creator-hub-mcp-router', pkg.ID]);
const RPC = Object.freeze({ timeout: 10000, maxTotalTimeout: 10000 });

function retainedRouteReader(base, baseline, replacement) {
  assert.deepEqual(baseline.modules.mcp, replacement.modules.mcp, 'This probe requires the same signed MCP runtime');
  const pins = baseline.managedRouting.files;
  assert.equal(pins['routing/runtime.json'], replacement.managedRouting.files['routing/runtime.json'],
    'This probe requires the same signed runtime descriptor');
  return () => {
    const routeRoot = path.join(base, 'mcp-route-v1/linux-x86_64');
    const active = pkg.read(path.join(routeRoot, 'active.json'), 65536), route = JSON.parse(active);
    assert.deepEqual(Object.keys(route).sort(), ['descriptorSha256', 'generation', 'schemaVersion']);
    assert.equal(route.schemaVersion, 1); assert.match(route.generation, /^[a-f0-9]{64}$/);
    assert.equal(route.descriptorSha256, pins['routing/runtime.json']);
    // Retention binds to the baseline signature, not a newly timestamped package signature.
    for (const name of ['runtime.json', 'runtime.minisig']) {
      assert.equal(pkg.sha256(pkg.read(path.join(routeRoot, 'descriptors', route.descriptorSha256, name), 65536)),
        pins[`routing/${name}`], 'Retained baseline signed descriptor differs');
    }
    for (const [name, hash] of Object.entries(baseline.modules.mcp.files)) {
      assert.equal(pkg.sha256(pkg.read(path.join(base, 'runtime-generations/linux-x86_64', route.generation, name))), hash,
        'Retained runtime bytes differ');
    }
    return { active: pkg.record(active), ...route };
  };
}

async function sdkSession(env, sdk = createRequire(path.join(pkg.ROOT, 'modules/mcp/package.json'))) {
  const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'flatpak-mcp-stdio-package-probe', version: '1' });
  // The SDK merges a short inherited allowlist. Override those remaining names too.
  const transport = new StdioClientTransport({ command: COMMAND, args: [...ARGS], cwd: env.HOME,
    env: { LOGNAME: '', SHELL: '/bin/sh', TERM: 'dumb', USER: '', ...env }, stderr: 'pipe' });
  let stderrBytes = 0, overflow = false;
  const timer = setTimeout(() => { overflow = true; void client.close().catch(() => {}); }, 120000);
  timer.unref();
  transport.stderr.on('data', bytes => {
    stderrBytes += bytes.length;
    if (stderrBytes > 65536 && !overflow) { overflow = true; void client.close().catch(() => {}); }
  });
  const close = async () => { clearTimeout(timer); await client.close(); };
  try {
    await client.connect(transport, RPC);
    assert.equal(overflow, false, 'Bounded SDK session exceeded');
    assert.equal(client.getServerVersion()?.name, 'creator-works-mcp');
    return {
      async tools() {
        assert.equal(overflow, false, 'Bounded SDK session exceeded');
        const result = await client.listTools({}, RPC);
        assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 256 * 1024, 'Tool response exceeds probe bound');
        assert.equal(result.nextCursor, undefined, 'Paginated tool list not covered by this bounded probe');
        assert.ok(result.tools.length > 0 && result.tools.length <= 1024);
        assert.ok(result.tools.some(tool => tool.name === 'get_mcp_reference'));
        assert.equal(overflow, false, 'Bounded SDK session exceeded');
        return result.tools.map(tool => tool.name).sort();
      }, close,
    };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'SDK connection and cleanup failed'); }
    throw error;
  }
}

async function replacementSequence({ snapshot, replace, open }) {
  const sessions = [];
  let failure, result, finalContext;
  try {
    const before = snapshot(0), first = await open(); sessions.push(first);
    const tools = await first.tools();
    assert.deepEqual(snapshot(0), before, 'Baseline context changed during SDK connection');
    // The parent owns a bounded exact-ref deployment operation. Never a shell/CLI input.
    const replaced = replace();
    assert.ok(!replaced || typeof replaced.then !== 'function', 'Use the parent synchronous bounded deployment callback');
    const after = snapshot(1);
    assert.notEqual(after.appCommit, before.appCommit, 'No replacement deployment');
    assert.equal(after.platformCommit, before.platformCommit, 'Platform changed');
    assert.deepEqual(after.route, before.route, 'Signed runtime/active route changed');
    const second = await open(); sessions.push(second);
    assert.deepEqual(await second.tools(), tools, 'New connection tool list changed');
    assert.deepEqual(await first.tools(), tools, 'Existing connection did not survive replacement');
    assert.deepEqual(snapshot(1), after, 'Replacement context changed during SDK connections');
    finalContext = after;
    result = { scope: 'flatpak-stdio-same-runtime-package-probe-only', before, after, toolCount: tools.length,
      existingConnectionResponded: true, newConnectionResponded: true, ...pkg.acceptance(), updateReady: false };
  } catch (error) {
    failure = error; throw error;
  } finally {
    const results = await Promise.allSettled(sessions.map(session => session.close()));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], 'Owned SDK session cleanup failed');
  }
  assert.deepEqual(snapshot(1), finalContext, 'Replacement context changed during SDK session cleanup');
  return result;
}

function probe(work, stages, replace, env = process.env) {
  sandbox.admission(env);
  assert.equal(env.CREATOR_FLATPAK_MCP_STDIO_PROBE, '1', 'Explicit stdio probe opt-in required');
  assert.ok(path.isAbsolute(work) && path.basename(work).startsWith('creator-flatpak-'));
  sandbox.inside(work, env.RUNNER_TEMP);
  assert.equal(stages.length, 2); assert.equal(typeof replace, 'function');
  const child = sandbox.childEnvironment(work);
  for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
    'TMPDIR', 'GNUPGHOME', 'FLATPAK_USER_DIR']) sandbox.inside(child[name], work);
  const inputs = stages.map(stage => {
    const receipt = JSON.parse(pkg.read(path.join(stage, 'flatpak-stage.json'), 65536));
    const manifest = pkg.verifyStage(stage, receipt);
    assert.ok(manifest.managedRouting, 'Callable managed router required');
    return { stage, receipt, manifest };
  });
  assert.notEqual(inputs[0].receipt.provenance.files['creator-hub'].sha256, inputs[1].receipt.provenance.files['creator-hub'].sha256);
  const readRetainedRoute = retainedRouteReader(path.join(child.HOME, '.var/app', pkg.ID, 'data/creator-hub'),
    inputs[0].manifest, inputs[1].manifest);
  const info = args => {
    const result = spawnSync(COMMAND, ['info', ...args], { env: child, cwd: work, encoding: 'utf8',
      stdio: 'pipe', timeout: 30000, maxBuffer: 65536, windowsHide: true });
    assert.ok(!result.error && result.status === 0, 'Bounded Flatpak inspection failed');
    return result.stdout.trim();
  };
  function snapshot(index) {
    const { stage, receipt } = inputs[index]; pkg.verifyStage(stage, receipt);
    assert.equal(info(['--show-ref', pkg.ID]), pkg.REF);
    const location = info(['--show-location', pkg.ID]); sandbox.inside(location, child.FLATPAK_USER_DIR);
    sandbox.parseMetadata(info(['--show-metadata', pkg.ID]));
    sandbox.parsePermissions(info(['--show-permissions', pkg.ID]));
    for (const name of [...pkg.OUTPUTS, OUTPUT]) {
      const file = path.join(location, 'files', name);
      assert.deepEqual(pkg.record(pkg.read(file, pkg.LIMIT, true)), receipt.files[name], 'Deployed file differs');
      const wanted = name === pkg.OUTPUTS[0] || name === OUTPUT ? 0o755 : 0o644;
      const mode = pkg.ordinary(file).mode & 0o7777;
      assert.ok(mode === wanted || mode === (wanted & ~0o222), 'Deployed mode differs');
    }
    const route = readRetainedRoute();
    const appCommit = info(['--show-commit', pkg.ID]);
    const platformCommit = info(['--system', '--show-commit', sandbox.RUNTIME]);
    for (const commit of [appCommit, platformCommit]) assert.match(commit, /^[a-f0-9]{64}$/);
    return { appCommit, platformCommit, route };
  }
  return replacementSequence({ snapshot, replace, open: () => sdkSession(child) });
}

module.exports = { COMMAND, ARGS, RPC, retainedRouteReader, sdkSession, replacementSequence, probe };
