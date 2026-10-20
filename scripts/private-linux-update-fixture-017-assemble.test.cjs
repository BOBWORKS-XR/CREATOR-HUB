'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const a = require('./private-linux-update-fixture-017-assemble.cjs');
const p = require('./private-linux-update-fixture-017.cjs');
const m = require('./private-linux-update-fixture-017-metadata.cjs');
const retirement = require('./linux-retirement-package.cjs');
const { data } = require('./fixtures/private-linux-update-fixture-017.cjs');
function owned(run) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'private017-assembly-unit-')));
  try { run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function input(root, f) {
  const dir = path.join(root, 'input'); fs.mkdirSync(dir);
  for (const [name, bytes] of Object.entries(f.files)) {
    const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  }
  return dir;
}
test('private017 inputs are complete, independently plan-pinned and rechecked without executing any payload', () => {
  owned(root => {
    const f = data(), dir = input(root, f), checked = a.inputs(dir, m.hash(f.files['plan.json'])); checked.recheck();
    assert.equal(checked.plan.hubVersion, '0.1.17'); assert.equal(checked.handoff.hubVersion, '0.1.16');
    fs.writeFileSync(path.join(dir, 'runtime017.json'), 'tampered');
    assert.throws(() => checked.recheck(), /Immutable derivation input/);
    assert.throws(() => a.inputs(dir, 'f'.repeat(64)), /Independent plan pin/);
  });
});
test('unknown input, old runtime relabel and changed carrier all refuse before tools', () => {
  for (const mutate of [(f, dir) => fs.writeFileSync(path.join(dir, 'unknown'), 'not input'),
    (f, dir) => fs.writeFileSync(path.join(dir, 'modules.tar.gz'), 'changed carrier'),
    (f, dir) => fs.writeFileSync(path.join(dir, 'runtime017.json'), f.files['routing/runtime.json'])]) {
    owned(root => { const f = data(), dir = input(root, f); mutate(f, dir); assert.throws(() => a.inputs(dir, m.hash(f.files['plan.json']))); });
  }
});
test('private017 overlay binds exact four features and only reviewed helper/policy/session service paths', () => {
  owned(root => {
    const staged = { [retirement.HELPER]: '/owned/helper', [retirement.POLICY]: '/owned/policy' };
    const file = a.overlay(root, { '/owned/archive': 'modules.tar.gz' }, staged), config = JSON.parse(fs.readFileSync(file));
    assert.deepEqual(config.build.features, [...p.FEATURES]); assert.deepEqual(config.bundle.targets, ['deb']);
    assert.deepEqual(Object.keys(config.bundle.linux.deb.files).sort(), [retirement.HELPER, retirement.POLICY, retirement.SERVICE].sort());
    assert.equal(config.bundle.linux.deb.files[retirement.HELPER], '/owned/helper');
    assert.deepEqual(fs.readFileSync(config.bundle.linux.deb.files[retirement.SERVICE]), retirement.SERVICE_BYTES);
    assert.throws(() => a.overlay(root, {}, { ...staged, '/extra/helper': 'unreviewed' }), /fields differ/);
  });
});
test('private017 compiler command builds the actual Root with the exact production tuple and locked Linux target', () => {
  const root = path.resolve('/owned/source'), overlay = path.resolve('/owned/output/tauri-private017.json');
  assert.deepEqual(a.compileCommand(root, overlay), [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build',
    '--features', 'integrated-features,experimental-flatpak-host,linux-production-migration,experimental-linux-portable-update',
    '--target', 'x86_64-unknown-linux-gnu', '--bundles', 'deb', '--config', overlay, '--', '--locked']);
});
test('assembly source contract keeps trusted input/baseline checks before Root compilation and final checks before proof publication', () => {
  // This checks call ordering only. The actual native build and qualification remain separate gates.
  const source = a.build.toString();
  const phases = ['fixture.context(', 'original.admission(', 'inputs(input, planSha256)', 'sourceCheck(root, plan, env, execute)',
    'original.verifyPrivateSource(', 'metadata.verifySignatures(', "['verify', ...transfer]", "['extract', ...transfer, old]",
    "'--stage-baseline'", 'metadata.validateBaseline(', "'--inspect-baseline'", "['--extract', baselineDeb, baselineRoot]",
    'builder.verifyStage(', 'archive.verify(', 'compileCommand(root, overlayFile)', 'unix.validatePackages(',
    'const packageReport = JSON.parse(', 'accepted.recheck(); sourceCheck(root, plan, env, execute); fixture.source(root, execute)',
    'original.verifyPrivateSource(accepted.handoff.source.sourceCommit, run);\n  builder.verifyStage(', "write(path.join(output, 'private017-assembly.json')"];
  let previous = -1;
  for (const phase of phases) {
    const index = source.indexOf(phase, previous + 1);
    assert.ok(index > previous, `Missing or reordered private017 boundary: ${phase}`); previous = index;
  }
});
test('source proof uses bounded source paths, rejects tracked/untracked drift and different actual017 Git tree', () => {
  const f = data(), calls = [];
  const run = (command, args) => {
    assert.equal(command, 'git'); calls.push(args);
    if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? f.plan.rootSource.sourceCommit : f.plan.rootSource.sourceTree;
    assert.ok(['diff', 'status'].includes(args[0])); assert.equal(args.includes('--'), true);
    assert.deepEqual(args.slice(args.indexOf('--') + 1), a.SOURCE_PATHS); return '';
  };
  const env = { GITHUB_SHA: f.plan.rootSource.sourceCommit };
  a.sourceCheck('/owned', f.plan, env, run);
  assert.equal(calls.length, 4);
  for (const untracked of [false, true]) assert.throws(() => a.sourceCheck('/owned', f.plan, env, (command, args) => {
    if (untracked && args[0] === 'status') return '?? src-tauri/src/new.rs';
    if (!untracked && args[0] === 'diff') throw Error('tracked change');
    return run(command, args);
  }));
  assert.throws(() => a.sourceCheck('/owned', f.plan, env, (command, args) => args[1] === 'HEAD^{tree}' ? 'a'.repeat(40) : run(command, args)));
  for (const file of ['scripts/private-linux-update-fixture-017-metadata.cjs', a.VERIFIER, 'src-tauri/src']) assert.ok(a.SOURCE_PATHS.includes(file));
});
test('build refuses non-CI callers before source, key access, compiler or payload execution', () => {
  assert.throws(() => a.build({ root: '/never/read', input: '/never/read', output: '/never/write', planSha256: 'f'.repeat(64) },
    { env: {}, execute() { assert.fail('No execution before native private017 admission'); } }), /private017 context/);
});
