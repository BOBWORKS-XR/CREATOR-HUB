'use strict';
// Protected local writer: exactly manifest then private qualification descriptor.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const c = require('./private-portable-016-contract.cjs');
const base = require('./linux-016-portable-package.cjs');
const production = base.production016();
const routing = require('./managed-router-package.cjs');
const { capture } = require('./sign-unix-payload.cjs');

const ROOT = path.resolve(__dirname, '..');
const FAILURE = 'Private portable016 preflight, signing or postverification failed. Partial owned evidence is retained; no qualification or publication is accepted.';
const OVERSIZE = 'Portable manifest exceeds the unchanged 128 KiB production verifier; stop before signing';
const VERIFIER = 'src-tauri/target/release/examples/verify-package-input.exe';
const RECEIPT = 'private-qualification-receipt.json';
function absolute(file) {
  assert.ok(typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file);
  for (let next = file;; next = path.dirname(next)) {
    try { assert.equal(fs.lstatSync(next).isSymbolicLink(), false, 'Redirected path refused'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(next) === next) break;
  }
}
function inside(file, parent) {
  absolute(file); absolute(parent); const relative = path.relative(parent, file);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function inventory(directory, names) {
  absolute(directory); assert.ok(fs.lstatSync(directory).isDirectory());
  assert.deepEqual(fs.readdirSync(directory).sort(), [...names].sort(), 'Exact bounded file inventory required');
  for (const name of names) { const file = path.join(directory, name); absolute(file); const s = fs.lstatSync(file); assert.ok(s.isFile() && s.nlink === 1); }
}
function api(route) {
  return JSON.parse(execFileSync('gh', ['api', `repos/BOBWORKS-XR/CREATOR-HUB/${route}`],
    { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 }));
}
async function fresh(plan, binding, request) {
  const p = plan.producer;
  const packaging = { run: await request(`actions/runs/${p.runId}`), job: await request(`actions/jobs/${p.jobId}`),
    workflow: await request(`actions/workflows/${p.workflowId}`), artifact: await request(`actions/artifacts/${p.artifactId}`),
    commit: await request(`git/commits/${p.sourceCommit}`) };
  c.validateAPI(plan, packaging);
  const a = binding.pins, v = binding.privateProof, e = v.expected;
  const routes = [`actions/runs/${a.runId}`, `actions/jobs/${a.jobId}`, `actions/workflows/${a.workflowId}`,
    `git/commits/${a.sourceCommit}`, `actions/artifacts/${a.artifactId}`, `actions/artifacts/${a.receiptsArtifactId}`,
    `actions/runs/${e.runId}/attempts/${e.runAttempt}/jobs?per_page=100`, `actions/runs/${e.runId}`,
    `actions/artifacts/${e.artifactId}`, `git/commits/${e.sourceCommit}`, `actions/jobs/${v.jobId}`];
  const replies = new Map(); for (const route of routes) if (!replies.has(route)) replies.set(route, await request(route));
  const original = production.collect(a, { expected: e, prepared: v.prepared, artifactSize: v.artifactSize, jobId: v.jobId }, route => {
    assert.ok(replies.has(route)); return replies.get(route);
  });
  return { packaging, original };
}
async function sign({ input, plan: planFile, planSha256, output }, services = {}) {
  const root = services.root || ROOT, execute = services.execute || execFileSync, approved = services.signer || routing;
  try {
    assert.equal(services.platform || process.platform, 'win32', 'Use the fixed Windows production-key verifier');
    for (const file of [root, input, planFile, output]) absolute(file);
    inside(input, path.join(root, 'artifacts')); inside(output, path.join(root, 'artifacts')); inside(planFile, path.dirname(root));
    assert.equal(path.extname(input), '.zip'); assert.equal(fs.existsSync(output), false, 'Signed output is immutable');
    assert.ok(!planFile.startsWith(path.dirname(input) + path.sep) && !planFile.startsWith(output + path.sep), 'Plan must be independent of candidate input/output');
    assert.match(planSha256, /^[a-f0-9]{64}$/);
    const held = new Map();
    const identity = file => { const s = fs.lstatSync(file, { bigint: true }); return [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs, s.birthtimeNs]; };
    function remember(file, maximum, tool = false) {
      absolute(file); const before = identity(file), record = capture(file, maximum, tool);
      assert.deepEqual(identity(file), before); held.set(file, { record, identity: before, tool }); return record;
    }
    function unchanged(file) {
      const pinned = held.get(file); assert.ok(pinned); absolute(file);
      assert.deepEqual(identity(file), pinned.identity, 'Held file identity changed');
      assert.deepEqual(capture(file, pinned.record.size, pinned.tool), pinned.record, 'Held file bytes changed');
      assert.deepEqual(identity(file), pinned.identity, 'Held file identity changed');
    }
    function bytes(file) { unchanged(file); const value = fs.readFileSync(file); assert.deepEqual(c.record(value), held.get(file).record); unchanged(file); return value; }
    function write(file, value) { fs.writeFileSync(file, value, { flag: 'wx', mode: 0o600 }); remember(file, value.length); }
    function copy(source, file) {
      unchanged(source); absolute(file); fs.copyFileSync(source, file, fs.constants.COPYFILE_EXCL);
      const actual = remember(file, held.get(source).record.size); assert.deepEqual(actual, held.get(source).record); unchanged(source);
    }
    const planRecord = remember(planFile, c.SIGNED_META); assert.equal(planRecord.sha256, planSha256, 'Independent plan SHA differs');
    const plan = c.parse(bytes(planFile), c.SIGNED_META);
    if (plan.files?.[c.UNSIGNED]?.size > c.SIGNED_META) throw Error(OVERSIZE);
    c.validatePlan(plan);
    assert.deepEqual(remember(input, base.LIMITS.zip), plan.producer.zip, 'Original producer ZIP differs');
    const verifier = path.join(root, VERIFIER); assert.deepEqual(remember(verifier, base.LIMITS.file, true), plan.verifier, 'Fixed production verifier differs');
    const work = fs.mkdtempSync(path.join(root, 'artifacts/private-portable016-sign-work-')); fs.chmodSync(work, 0o700);
    const zip = path.join(work, 'producer.zip'), snapshotPlan = path.join(work, 'plan.json'); copy(input, zip); copy(planFile, snapshotPlan);
    const staged = path.join(work, 'producer');
    function recheck() { for (const file of held.keys()) unchanged(file); if (fs.existsSync(staged)) inventory(staged, c.FILES); }
    function run(program, args, options = {}) {
      recheck(); const value = execute(program, args, { encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 65536, ...options }); recheck(); return String(value ?? '').trim();
    }
    base.stageZip(zip, staged, plan.files, c.FILES, (_program, args, options) => run('python', args, options));
    inventory(staged, c.FILES);
    for (const name of c.FILES) assert.deepEqual(remember(path.join(staged, name), c.limit(name)), plan.files[name]);
    const bodies = Object.fromEntries(c.FILES.map(name => [name, bytes(path.join(staged, name))]));
    const checked = c.validateOutput(plan, bodies); recheck();
    const request = async route => { recheck(); const result = await (services.request || api)(route); recheck(); return result; };
    const proof = await fresh(plan, checked.receipt.producer, request), proofBytes = c.json(proof);
    assert.ok(proofBytes.length <= c.META, 'Fresh API proof exceeds bound'); recheck();
    fs.mkdirSync(output, { mode: 0o700 });
    const names = c.FILES.map(name => name === c.UNSIGNED ? c.MANIFEST : name);
    for (const name of c.FILES) copy(path.join(staged, name), path.join(output, name === c.UNSIGNED ? c.MANIFEST : name));
    copy(snapshotPlan, path.join(output, 'plan.json')); write(path.join(output, 'fresh-api.json'), proofBytes);
    const descriptorFile = path.join(output, c.DESCRIPTOR); write(descriptorFile, c.json(checked.descriptor));
    const authorized = [path.join(output, c.MANIFEST), descriptorFile], signatures = {};
    const expectedOutput = [...names, 'plan.json', 'fresh-api.json', c.DESCRIPTOR];
    function recheckOutput() { recheck(); inventory(output, expectedOutput); }
    recheckOutput();
    // Protected helper alone selects/accesses the existing key; no environment or key bytes are read here.
    const key = approved.signingKey(root); let sequence = 0;
    for (const body of authorized) {
      assert.equal(authorized[sequence], body); assert.ok(sequence < 2); recheckOutput();
      const temporary = path.join(work, `signing-input-${sequence++}.json`); copy(body, temporary);
      const signature = approved.signDetached(temporary, key);
      assert.ok(Buffer.isBuffer(signature) && signature.length > 0 && signature.length <= 4096 && signature.toString('utf8').startsWith('untrusted comment:'), 'Bounded plain Minisign signature required');
      recheckOutput();
      const signatureFile = `${body}.minisig`; write(signatureFile, signature); expectedOutput.push(path.basename(signatureFile));
      const bodyHash = held.get(body).record.sha256;
      assert.equal(run(verifier, [body, signatureFile]), `Verified trusted package signature: ${bodyHash}. No activation or client changes.`, 'Production signature verification refused');
      signatures[path.basename(signatureFile)] = held.get(signatureFile).record; recheckOutput();
    }
    assert.equal(sequence, 2);
    c.validateOutput(plan, Object.fromEntries(c.FILES.map(name => [name, bytes(path.join(output, name === c.UNSIGNED ? c.MANIFEST : name))])));
    for (const body of authorized) {
      assert.equal(run(verifier, [body, `${body}.minisig`]), `Verified trusted package signature: ${held.get(body).record.sha256}. No activation or client changes.`);
    }
    recheckOutput();
    const receipt = { schemaVersion: 1, profile: c.PROFILE, acceptanceOnly: true, version: c.VERSION,
      planSha256, producer: plan.producer, rootSource: plan.rootSource, inputZip: plan.producer.zip,
      files: Object.fromEntries(names.map(name => [name, held.get(path.join(output, name)).record])),
      descriptor: held.get(descriptorFile).record, signatures, authorizedBodiesSigned: 2, privateKeyIncluded: false, ...c.FLAGS };
    write(path.join(output, RECEIPT), c.json(receipt)); expectedOutput.push(RECEIPT); recheckOutput();
    return { profile: c.PROFILE, output, planSha256, acceptanceOnly: true, authorizedBodiesSigned: 2,
      manifest: plan.files[c.UNSIGNED], descriptor: held.get(descriptorFile).record, privateKeyIncluded: false, ...c.FLAGS };
  } catch (error) { throw Error(error?.message === OVERSIZE ? OVERSIZE : FAILURE); }
}
function cli(args) {
  assert.equal(args.length, 8); assert.deepEqual(args.filter((_, index) => index % 2 === 0), ['--input', '--plan', '--plan-sha256', '--output']);
  return { input: args[1], plan: args[3], planSha256: args[5], output: args[7] };
}
module.exports = { FAILURE, OVERSIZE, VERIFIER, RECEIPT, absolute, inside, inventory, api, fresh, sign, cli };
if (require.main === module) Promise.resolve().then(() => sign(cli(process.argv.slice(2))))
  .then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error?.message === OVERSIZE ? OVERSIZE : FAILURE); process.exitCode = 1; });
