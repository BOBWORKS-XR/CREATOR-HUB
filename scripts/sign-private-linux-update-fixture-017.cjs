'use strict';
// Protected local writer. Only two new bodies may reach the existing signer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const metadata = require('./private-linux-update-fixture-017-metadata.cjs');
const fixture = require('./private-linux-update-fixture-017.cjs');
const assembly = require('./private-linux-update-fixture-017-assemble.cjs');
const original = require('./assemble-unix-payload.cjs');
const provenance = require('./private-linux-update-fixture-017-provenance.cjs');
const routing = require('./managed-router-package.cjs');
const builder = require('./build-unified.cjs');
const finite = require('./flatpak-package.cjs');
const { runtimeDescriptor } = require('./mcp-runtime-descriptor.cjs');
const { capture } = require('./sign-unix-payload.cjs');

const ROOT = path.resolve(__dirname, '..');
const INPUTS = [...original.INPUTS, 'baseline016.zip'];
const FAILURE = 'Private017 signing/preflight or postverification failed. Partial output and owned scratch evidence are retained; assembly remains blocked.';
const limit = name => name === 'baseline016.zip' ? 768 * 1024 * 1024 : name === 'modules.tar.gz' ? 256 * 1024 * 1024
  : name.endsWith('.minisig') ? 4096 : 128 * 1024;
function tools(root) {
  return { transfer: path.join(root, 'native/unix-transfer/target/release/creator-hub-unix-transfer.exe'),
    verifier: path.join(root, 'src-tauri/target/release/examples/verify-package-input.exe'),
    baseline: path.join(root, 'scripts/stage-private-linux-update-fixture-017.py') };
}
function unchanged(file, expected) { assert.deepEqual(capture(file, expected.size), expected, 'Pinned input changed'); }
function bytes(file, expected) {
  unchanged(file, expected);
  const value = fs.readFileSync(file);
  assert.deepEqual(metadata.record(value), expected, 'Input changed after snapshot');
  unchanged(file, expected);
  return value;
}
function write(file, value) { fs.writeFileSync(file, value, { flag: 'wx', mode: 0o600 }); }
function copy(source, output, expected) {
  unchanged(source, expected); assembly.canonical(output, false);
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.copyFileSync(source, output, fs.constants.COPYFILE_EXCL);
  unchanged(output, expected); unchanged(source, expected);
}
async function sign({ input, plan: planFile, planSha256, output }, services = {}) {
  const root = services.root || ROOT, execute = services.execute || execFileSync, approved = services.signer || routing;
  assert.equal(services.platform || process.platform, 'win32', 'Protected017 acquisition uses the fixed Windows verification tools');
  for (const file of [root, input, planFile]) assembly.canonical(file);
  assembly.canonical(output, false);
  for (const file of [input, output]) assembly.inside(file, path.join(root, 'artifacts'));
  assembly.inside(planFile, path.dirname(root));
  assert.ok(!planFile.startsWith(input + path.sep) && !planFile.startsWith(output + path.sep), 'Independent plan cannot be staged candidate input');
  assert.equal(fs.existsSync(output), false, 'Signed017 output is immutable');
  assert.match(planSha256, /^[a-f0-9]{64}$/);
  const planRecord = capture(planFile, 128 * 1024);
  assert.equal(planRecord.sha256, planSha256, 'Independent plan SHA256 differs');
  const plan = metadata.validatePlan(metadata.parse(bytes(planFile, planRecord)));
  original.inventory(input, INPUTS);
  const inputFiles = Object.fromEntries(INPUTS.map(name => [name, path.join(input, name)]));
  const inputRecords = Object.fromEntries(INPUTS.map(name => [name, capture(inputFiles[name], limit(name))]));
  const oldRecords = Object.fromEntries(original.INPUTS.map(name => [name, inputRecords[name]]));
  const handoff = metadata.parse(bytes(inputFiles['handoff.json'], inputRecords['handoff.json']));
  const prepared = metadata.parse(bytes(inputFiles['prepared-unix.json'], inputRecords['prepared-unix.json']));
  const manifest = metadata.validateOriginal(plan, handoff, prepared, oldRecords);
  assert.deepEqual(inputRecords['baseline016.zip'], { size: plan.baseline016.assembly.zipBytes, sha256: plan.baseline016.assembly.zipSha256 });
  const selected = tools(root), toolRecords = Object.fromEntries(Object.entries(selected)
    .map(([name, file]) => [name, capture(file, name === 'baseline' ? 128 * 1024 : 256 * 1024 * 1024, name !== 'baseline')]));
  const work = fs.mkdtempSync(path.join(root, 'artifacts/private017-sign-work-'));
  fs.chmodSync(work, 0o700);
  const snapshot = path.join(work, 'input'); fs.mkdirSync(snapshot, { mode: 0o700 });
  const files = Object.fromEntries(INPUTS.map(name => [name, path.join(snapshot, name)]));
  for (const name of INPUTS) copy(inputFiles[name], files[name], inputRecords[name]);
  const pinnedPlan = path.join(work, 'plan.json'); copy(planFile, pinnedPlan, planRecord);
  function recheck() {
    original.inventory(input, INPUTS); original.inventory(snapshot, INPUTS);
    unchanged(planFile, planRecord); unchanged(pinnedPlan, planRecord);
    for (const name of INPUTS) { unchanged(inputFiles[name], inputRecords[name]); unchanged(files[name], inputRecords[name]); }
    for (const [name, file] of Object.entries(selected)) assert.deepEqual(capture(file, toolRecords[name].size, name !== 'baseline'), toolRecords[name], 'Fixed verifier tool changed');
  }
  function run(program, args) {
    recheck();
    const result = execute(program, args, { encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
    recheck(); return String(result ?? '').trim();
  }
  function verify(body, signature) {
    const before = capture(body, 128 * 1024), sig = capture(signature, 4096);
    assert.equal(run(selected.verifier, [body, signature]),
      `Verified trusted package signature: ${before.sha256}. No activation or client changes.`, 'Production verifier refused017 metadata');
    unchanged(body, before); unchanged(signature, sig);
  }
  try {
    for (const [body, signature] of [['handoff.json', 'handoff.minisig'], ['routing/router.json', 'routing/router.minisig'],
      ['routing/runtime.json', 'routing/runtime.minisig']]) verify(files[body], files[signature]);
    assert.deepEqual(metadata.parse(bytes(files['routing/runtime.json'], inputRecords['routing/runtime.json']), false), runtimeDescriptor(manifest, '0.1.16'));
    assert.deepEqual(metadata.parse(bytes(files['routing/router.json'], inputRecords['routing/router.json']), false),
      { schemaVersion: 1, product: 'com.creatorworks.hub.mcp-router', platform: 'linux', arch: 'x86_64', protocol: 1, sha256: prepared.files['router-for-package'].sha256 });
    // API requests cannot execute a candidate. Recheck the immutable snapshots at
    // this whole data-only phase boundary instead of rereading a large ZIP per tree node.
    recheck();
    const fresh = await provenance.fresh({ plan, handoff, preparedFile: files['prepared-unix.json'] }, services.request || provenance.api);
    recheck();
    const freshFile = path.join(work, 'fresh-api.json'); write(freshFile, JSON.stringify(fresh, null, 2));
    const freshRecord = capture(freshFile, 128 * 1024);
    const args = original.TRANSFER.map(name => files[name]);
    const message = 'Unsigned transfer checked. No payload execution, signing, activation or release acceptance.';
    assert.equal(run(selected.transfer, ['verify', ...args]), message);
    const raw = path.join(work, 'original016');
    assert.equal(run(selected.transfer, ['extract', ...args, raw]), message);
    function recheckRaw() {
      original.inventory(raw, [...Object.keys(prepared.files), 'prepared-unix.json']);
      for (const [name, record] of Object.entries(prepared.files)) unchanged(path.join(raw, name), { size: record.size, sha256: record.sha256 });
      unchanged(path.join(raw, 'prepared-unix.json'), inputRecords['prepared-unix.json']);
    }
    recheckRaw();
    const unsigned = structuredClone(manifest); delete unsigned.managedRouting;
    assert.deepEqual(metadata.parse(fs.readFileSync(path.join(raw, 'builtin-manifest.json'))), unsigned);
    assert.deepEqual(metadata.parse(fs.readFileSync(path.join(raw, 'mcp-runtime.json')), false), runtimeDescriptor(unsigned, '0.1.16'));
    builder.verifyStage(path.join(raw, 'modules'), unsigned);
    const baselineExpected = { zip: inputRecords['baseline016.zip'], files: Object.fromEntries(Object.keys(metadata.BASELINE_MEMBERS)
      .map(name => [name, plan.baseline016.pins[name]])) };
    const baselineExpectedFile = path.join(work, 'baseline-expected.json'); write(baselineExpectedFile, JSON.stringify(baselineExpected));
    const baselineDirectory = path.join(work, 'baseline016');
    const staged = JSON.parse(run('python', ['-B', selected.baseline, '--stage-baseline', files['baseline016.zip'], baselineExpectedFile, baselineDirectory]));
    assert.deepEqual(staged, { scope: 'pinned016-zip-staging-only', files: baselineExpected.files, releaseReady: false });
    const baselineFiles = Object.fromEntries(Object.entries(metadata.BASELINE_MEMBERS).map(([name, member]) =>
      [name, path.join(baselineDirectory, name === 'deb' ? 'baseline016.deb' : path.posix.basename(member))]));
    const baselineBytes = Object.fromEntries(Object.entries(baselineFiles).map(([name, file]) => [name, bytes(file, plan.baseline016.pins[name])]));
    metadata.validateBaseline(plan, baselineBytes, handoff);
    finite.validateElf(baselineBytes.rawHub);
    for (const witness of builder.PORTABLE_ROOT_WITNESSES) assert.ok(baselineBytes.rawHub.includes(Buffer.from(witness)), 'Baseline016 portable Root binding missing');
    function allOriginals() {
      recheck(); recheckRaw(); unchanged(freshFile, freshRecord);
      for (const [name, file] of Object.entries(baselineFiles)) unchanged(file, plan.baseline016.pins[name]);
    }
    allOriginals();
    fs.mkdirSync(output, { mode: 0o700 });
    for (const name of INPUTS) copy(files[name], path.join(output, name), inputRecords[name]);
    copy(pinnedPlan, path.join(output, 'plan.json'), planRecord);
    write(path.join(output, 'baseline016-api.json'), JSON.stringify(fresh.baseline, null, 2));
    write(path.join(output, 'root017-api.json'), JSON.stringify(fresh.root, null, 2));
    const runtime = metadata.runtimeBytes(manifest), runtimeFile = path.join(output, 'runtime017.json'); write(runtimeFile, runtime);
    const immutable = new Map([...INPUTS, 'plan.json', 'baseline016-api.json', 'root017-api.json', 'runtime017.json']
      .map(name => [path.join(output, name), capture(path.join(output, name), limit(name))]));
    function recheckOutput() { for (const [file, record] of immutable) unchanged(file, record); }
    allOriginals(); recheckOutput();
    // No key is selected until all original signatures, carrier, fresh API/source and baseline Root checks pass.
    const key = approved.signingKey(root);
    const authorized = new Map([[runtimeFile, runtime]]); let sequence = 0;
    function signBody(body) {
      assert.equal([...authorized.keys()][sequence], body, 'Exactly runtime017 then derivation017 may be signed');
      assert.ok(sequence < 2 && fs.readFileSync(body).equals(authorized.get(body)), 'Unapproved signing body');
      allOriginals(); recheckOutput();
      const before = metadata.record(authorized.get(body)); unchanged(body, before);
      const temporary = path.join(work, `signing-input-${sequence++}.json`); copy(body, temporary, before);
      const signature = approved.signDetached(temporary, key);
      assert.ok(Buffer.isBuffer(signature) && signature.length > 0 && signature.length <= 4096, 'Bounded detached signature required');
      unchanged(temporary, before); unchanged(body, before); allOriginals(); recheckOutput();
      const signatureFile = path.join(output, body === runtimeFile ? 'runtime017.minisig' : 'derivation017.minisig');
      write(signatureFile, signature); immutable.set(signatureFile, metadata.record(signature));
      verify(body, signatureFile); allOriginals(); recheckOutput();
      return signature;
    }
    const runtimeSignature = signBody(runtimeFile);
    const derived = metadata.derivationBytes(plan, handoff, prepared, oldRecords, runtime, runtimeSignature);
    const derivationFile = path.join(output, 'derivation017.json'); write(derivationFile, derived);
    immutable.set(derivationFile, metadata.record(derived)); authorized.set(derivationFile, derived);
    signBody(derivationFile); assert.equal(sequence, 2);
    const completed = assembly.inputs(output, planSha256); completed.recheck();
    metadata.verifySignatures(completed.files, completed.records, selected.verifier, run);
    allOriginals(); recheckOutput(); completed.recheck();
    return { profile: fixture.PROFILE, output, planSha256, derivation: completed.records['derivation017.json'],
      authorizedBodiesSigned: 2, original016Preserved: true, privateKeyIncluded: false, ...fixture.FLAGS };
  } catch { throw Error(FAILURE); }
}
function cli(args) {
  assert.equal(args.length, 8, 'Use --input VERIFIED_016 --plan APPROVED_PLAN --plan-sha256 INDEPENDENT_SHA256 --output NEW_DIRECTORY');
  assert.deepEqual(args.filter((_, i) => i % 2 === 0), ['--input', '--plan', '--plan-sha256', '--output']);
  return { input: args[1], plan: args[3], planSha256: args[5], output: args[7] };
}
module.exports = { INPUTS, FAILURE, limit, tools, bytes, cli, sign };
if (require.main === module) {
  Promise.resolve().then(() => sign(cli(process.argv.slice(2)))).then(value => console.log(JSON.stringify(value)))
    .catch(() => { console.error(FAILURE); process.exitCode = 1; });
}
