'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const w = require('./sign-private-linux-update-fixture-017.cjs');
const m = require('./private-linux-update-fixture-017-metadata.cjs');
const a = require('./private-linux-update-fixture-017-assemble.cjs');
const { create } = require('./fixtures/private017-signing.cjs');

test('mocked017 writer preflights original signatures/carrier and fresh source/baseline before signing exactly two temporary bodies', async t => {
  const f = create(t), key = f.services.signer.signingKey;
  f.services.signer.signingKey = root => {
    assert.equal(f.calls.filter(call => call.program === f.tools.verifier).length, 3);
    assert.deepEqual(f.calls.filter(call => call.program === f.tools.transfer).map(call => call.args[0]), ['verify', 'extract']);
    assert.equal(f.calls.some(call => call.program === 'python'), true);
    assert.equal(f.requests.some(route => route.startsWith('contents/src-tauri/tauri.conf.json?ref=')), true);
    return key(root);
  };
  const result = await w.sign(f.inputs, f.services);
  assert.deepEqual(f.count(), { keys: 1, signatures: 2 });
  for (const name of w.INPUTS) assert.ok(fs.readFileSync(path.join(f.inputs.output, name)).equals(f.files[name]));
  const checked = a.inputs(f.inputs.output, f.inputs.planSha256); checked.recheck();
  assert.equal(checked.handoff.hubVersion, '0.1.16'); assert.equal(checked.plan.hubVersion, '0.1.17');
  assert.equal(result.authorizedBodiesSigned, 2); assert.equal(result.original016Preserved, true); assert.equal(result.privateKeyIncluded, false);
  for (const name of ['nativeGuiAccepted', 'migrationAccepted', 'authenticationAccepted', 'signedUpdateAccepted', 'restartAccepted', 'releaseReady']) assert.equal(result[name], false);
  assert.equal(f.requests.some(route => route.startsWith('contents/package-lock.json?ref=')), true);
  const signed = fs.readdirSync(path.join(f.root, 'artifacts')).filter(name => name.startsWith('private017-sign-work-'));
  assert.equal(signed.length, 1);
  const scratch = path.join(f.root, 'artifacts', signed[0]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(scratch, 'signing-input-0.json'))).hubVersion, '0.1.17');
  assert.equal(JSON.parse(fs.readFileSync(path.join(scratch, 'signing-input-1.json'))).product, m.PRODUCT);
  assert.equal(fs.existsSync(path.join(f.inputs.output, 'runtime017.json.sig')), false);
  assert.equal(fs.existsSync(path.join(f.inputs.output, 'derivation017.json.sig')), false);
  await assert.rejects(w.sign(f.inputs, f.services), /immutable/); assert.deepEqual(f.count(), { keys: 1, signatures: 2 });
});
for (const fault of ['original-api', 'baseline-api', 'root-api', 'source-version', 'private-source', 'tree-truncated', 'api-input-drift',
  'carrier', 'raw', 'baseline-zip', 'baseline-root']) test(`${fault} refuses before any key selection or output publication`, async t => {
  const f = create(t, fault);
  await assert.rejects(w.sign(f.inputs, f.services), error => error.message === w.FAILURE);
  assert.deepEqual(f.count(), { keys: 0, signatures: 0 }); assert.equal(fs.existsSync(f.inputs.output), false);
});
test('independently repinned invalid original signature still refuses before API/key selection', async t => {
  const f = create(t), file = path.join(f.inputs.input, 'handoff.minisig'), bad = Buffer.from('Invalid original signature');
  fs.writeFileSync(file, bad); f.plan.original016['handoff.minisig'] = m.record(bad);
  const plan = Buffer.from(JSON.stringify(f.plan, null, 2)); fs.writeFileSync(f.inputs.plan, plan); f.inputs.planSha256 = m.hash(plan);
  await assert.rejects(w.sign(f.inputs, f.services), error => error.message === w.FAILURE);
  assert.deepEqual(f.count(), { keys: 0, signatures: 0 }); assert.equal(f.requests.length, 0);
});
for (const fault of ['key-failure', 'sign-failure', 'second-sign-failure', 'signature', 'signature-size', 'body-drift',
  'input-drift', 'plan-drift', 'tool-drift', 'output-drift', 'raw-drift', 'post-output-drift']) test(`${fault} keeps partial evidence, refuses success and does not leak signer diagnostics or clobber output`, async t => {
  const f = create(t, fault);
  await assert.rejects(w.sign(f.inputs, f.services), error => error.message === w.FAILURE && !error.message.includes('PRIVATE DETAIL'));
  assert.equal(f.count().keys, 1); assert.ok(f.count().signatures <= 2); assert.equal(fs.existsSync(f.inputs.output), true);
  const previous = fs.readFileSync(path.join(f.inputs.output, 'handoff.json'));
  await assert.rejects(w.sign(f.inputs, f.services), /immutable/);
  assert.ok(fs.readFileSync(path.join(f.inputs.output, 'handoff.json')).equals(previous));
});
test('independent plan pin, unknown input and linked data refuse without tool execution or key access', async t => {
  for (const kind of ['hash', 'extra', 'link']) {
    const f = create(t);
    if (kind === 'hash') f.inputs.planSha256 = 'a'.repeat(64);
    if (kind === 'extra') f.put(path.join(f.inputs.input, 'extra'), 'unknown');
    if (kind === 'link') fs.linkSync(path.join(f.inputs.input, 'modules.tar.gz'), path.join(f.root, 'hardlinked-carrier'));
    await assert.rejects(w.sign(f.inputs, f.services));
    assert.deepEqual(f.count(), { keys: 0, signatures: 0 }); assert.equal(f.calls.length, 0); assert.equal(f.requests.length, 0);
  }
});
test('bounded CLI refuses missing/reordered/unknown selectors and provides no tool/key overrides', () => {
  assert.deepEqual(w.cli(['--input', 'input', '--plan', 'plan', '--plan-sha256', 'hash', '--output', 'output']),
    { input: 'input', plan: 'plan', planSha256: 'hash', output: 'output' });
  for (const args of [[], ['--input', 'in', '--plan', 'p', '--output', 'out', '--plan-sha256', 'h'],
    ['--input', 'in', '--plan', 'p', '--verifier', 'v', '--output', 'out']]) assert.throws(() => w.cli(args));
  assert.equal(w.sign.toString().includes('process.env'), false, 'Writer delegates protected key selection; it does not inspect environment/keys');
});
