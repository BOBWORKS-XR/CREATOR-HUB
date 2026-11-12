'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const trace = require('./connect-trace-023.cjs');
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REF: 'refs/heads/validation/windows-sdk-capability-023-20261112-r5', GITHUB_JOB: 'acceptance' };
test('captures validated DNS and loopback targets, not URLs, credentials or private IPs', () => {
  for (const host of ['api.github.com', 'example.invalid', 'example.co.uk'])
    assert.deepEqual(trace.target(host + ':443'), { kind: 'dns', host, port: 443 });
  for (const host of ['localhost', '127.0.0.1', '[::1]'])
    assert.deepEqual(trace.target(host + ':9238'), { kind: 'loopback', host, port: 9238 });
  assert.deepEqual(trace.target('192.168.1.5:443'), { kind: 'ip-redacted', port: 443 });
  for (const text of ['https://example.com:443', 'user:SECRET@example.com:443', 'example.com:443/?SECRET',
    'example.com:443#SECRET', 'example.com:0', 'example.com:65536', 'example.com:0443', 'a..com:443', 'a'.repeat(280)])
    assert.deepEqual(trace.target(text), { kind: 'redacted' });
});
test('local and foreign jobs cannot start a process lookup', async () => {
  let calls = 0;
  const execute = () => { calls++; };
  assert.deepEqual(await trace.owner(100, 101, {}, 'win32', execute), { status: 'not-enabled' });
  assert.deepEqual(await trace.owner(100, 101, env, 'linux', execute), { status: 'not-enabled' });
  assert.deepEqual(await trace.owner(0, 101, env, 'win32', execute), { status: 'invalid-port' });
  assert.equal(calls, 0);
});
test('process query uses only bounded numeric arguments and ignores stderr', async () => {
  const result = await trace.owner(123, 456, env, 'win32', (_exe, args, options, done) => {
    assert.deepEqual(args.slice(-4), ['-ClientPort', '123', '-ProxyPort', '456']);
    assert.equal(options.timeout, 4000);
    done(null, '[{"pid":10,"parentPid":9,"image":"C:/owned/node.exe"}]', 'SECRET');
  });
  assert.equal(result.status, 'observed'); assert.equal(result.processes[0].pid, 10);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});
test('trace is bounded and does not retain request headers or mutate its input', async () => {
  const state = {}, request = { url: 'localhost:9238', headers: { host: 'localhost:9238', authorization: 'SECRET' } };
  for (let i = 0; i < 12; i++) await trace.traceDeniedConnect(state, request, { remotePort: 100, localPort: 101 }, env, 'win32', async () => ({ status: 'fixture' }));
  const report = trace.traceReport(state);
  assert.equal(report.connectTrace.length, 8); assert.equal(report.connectTraceOverflow, 4);
  assert.equal(report.connectTrace[0].hostHeaderMatchesAuthority, true);
  assert.doesNotMatch(JSON.stringify(report), /SECRET|authorization/);
  report.connectTrace[0].target.port = 0; assert.equal(state.connectTrace[0].target.port, 9238);
});
test('invalid or failed owner query results are safely refused', async () => {
  for (const output of ['not json', '{}', '[{"pid":0}]']) {
    const result = await trace.owner(123, 456, env, 'win32', (_e, _a, _o, done) => done(null, output));
    assert.equal(result.status, 'invalid-result');
  }
  const result = await trace.owner(123, 456, env, 'win32', (_e, _a, _o, done) => done(Error('SECRET')));
  assert.deepEqual(result, { status: 'unavailable' });
});

test('shutdown drains an in-flight lookup and records the rejection before final reporting', { skip: process.platform !== 'win32' }, async () => {
  const state = {}, socket = { remotePort: 123, localPort: 456, destroyed: false };
  let finish, rejected = 0, closed = false;
  trace.trackedDenial(state, { url: 'localhost:9238', headers: {} }, socket, env,
    () => { assert.equal(socket.destroyed, false); rejected++; },
    () => new Promise(resolve => { finish = resolve; }));
  const close = (async () => { await trace.drainDenials(state); socket.destroyed = true; closed = true; })();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false); assert.equal(rejected, 0);
  finish({ status: 'observed', processes: [{ pid: 10, parentPid: 9, image: 'fixture/node.exe' }] });
  await close;
  assert.equal(closed, true); assert.equal(rejected, 1); assert.equal(state.pendingDenials.size, 0);
  assert.equal(trace.traceReport(state).connectTrace[0].owner.status, 'observed');
  await trace.drainDenials(state); assert.equal(rejected, 1);
});

test('shutdown also drains a denied CONNECT arriving during the first lookup', { skip: process.platform !== 'win32' }, async () => {
  const state = {}, socket = { remotePort: 123, localPort: 456 };
  const finish = []; let rejected = 0, closed = false;
  const add = () => trace.trackedDenial(state, { url: 'localhost:9238', headers: {} }, socket, env,
    () => rejected++, () => new Promise(resolve => { finish.push(resolve); }));
  add();
  const close = (async () => { await trace.drainDenials(state); closed = true; })();
  add(); finish[0]({ status: 'observed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false); assert.equal(rejected, 1);
  finish[1]({ status: 'observed' }); await close;
  assert.equal(rejected, 2); assert.equal(state.pendingDenials.size, 0);
  assert.ok(trace.traceReport(state).connectTrace.every(row => row.owner.status === 'observed'));
});
