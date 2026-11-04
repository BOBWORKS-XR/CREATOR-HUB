require('./fixtures/windows-019-test-fixture.cjs').install();
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { install } = require('./windows-019-baseline-diagnostics.cjs');
const baseline = { asset: 'Creator.Works.MCP_2.7.7_x64-setup.exe' };
const environment = { SystemRoot: 'C:\\Windows', Path: 'test-only' };
function fixture() {
  const calls = [];
  const legacy = { requireDisposable: () => calls.push('admit'), CIM_DIAGNOSTIC: 'read-only-cim',
    parseProbeOutput: () => ({ records: [] }), errorMetadata: error => ({ message: error.message }),
    failureDiagnostics: error => { calls.push('diagnose'); return { original: error.message }; } };
  const run = (program, args, options) => {
    calls.push('observe'); assert.ok(program.endsWith('powershell.exe')); assert.equal(args.at(-1), 'read-only-cim');
    assert.equal(options.timeout, 15000); assert.equal(options.env, environment); return 'captured';
  };
  return { calls, legacy, run };
}
test('snapshot precedes the one unchanged installer invocation', () => {
  const f = fixture(), report = {}, expected = {};
  const value = install('installer.exe', baseline, environment, report, 'out', (...args) => {
    f.calls.push('install'); assert.deepEqual(args, ['installer.exe', baseline, environment, report]); return expected;
  }, f);
  assert.equal(value, expected); assert.deepEqual(f.calls, ['admit', 'observe', 'install']);
  assert.equal(report.baselineFailureDiagnostics, undefined);
});
test('original refusal remains the thrown error after one bounded diagnostic, without retry', () => {
  const f = fixture(), error = Error('original-exit10'), report = {};
  assert.throws(() => install('installer.exe', baseline, environment, report, 'out', () => {
    f.calls.push('install'); throw error;
  }, f), actual => actual === error);
  assert.deepEqual(f.calls, ['admit', 'observe', 'install', 'diagnose']);
  assert.deepEqual(report.baselineFailureDiagnostics, { original: 'original-exit10' });
});
test('snapshot failure neither skips nor accepts the original installer', () => {
  const f = fixture(), report = {}, original = Error('refused');
  f.run = () => { throw Error('snapshot unavailable'); };
  assert.throws(() => install('installer.exe', baseline, environment, report, 'out', () => { throw original; }, f), actual => actual === original);
  assert.equal(report.baselineObservations[0].error.message, 'snapshot unavailable');
});
test('non-disposable admission stops before inventory or installer', () => {
  const f = fixture(); f.legacy.requireDisposable = () => { throw Error('not disposable'); };
  assert.throws(() => install('installer.exe', baseline, environment, {}, 'out', () => assert.fail(), f), /not disposable/);
  assert.deepEqual(f.calls, []);
});
