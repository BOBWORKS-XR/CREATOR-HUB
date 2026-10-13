// Disposable prerequisite probe. Current Unix packages cannot earn full hosting acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPOSITORY = 'BOBWORKS-XR/CREATOR-HUB';
const REPOSITORY_ID = 1364807512;
const TARGETS = {
  linux: { platform: 'linux', arch: 'x86_64', os: 'Linux', runnerArch: 'X64', job: 'candidate (ubuntu-22.04)' },
  'macos-arm64': { platform: 'macos', arch: 'aarch64', os: 'macOS', runnerArch: 'ARM64', job: 'candidate (macos-latest)' },
  'macos-intel': { platform: 'macos', arch: 'x86_64', os: 'macOS', runnerArch: 'X64', job: 'candidate (macos-15-intel)' },
};
const BLOCKERS = [
  { id: 'experimental-producer-capture', classification: 'missing-capture', evidence: 'scripts/build-unified.cjs',
    detail: 'The explicit experimental writable producer requires --experimental-unix plus --managed, compiles the backend feature and sets Hub writable mode. It has not been executed/accepted; default experimental packages remain read-only.' },
  { id: 'managed-route', classification: 'prerequisite', evidence: 'modules/mcp/launcher/src-tauri/src/hosted_unix.rs',
    detail: 'Writable Unix MCP requires a signed managed route, not a direct mutable Node target. No key is selected by this probe.' },
  { id: 'client-review-capture', classification: 'missing-capture', evidence: 'modules/mcp/launcher/src-tauri/src/settings_review_admission.rs',
    detail: 'Single/batch review and recovery now use compiled internal-module admission: Windows, or Linux/macOS with the backend experimental feature. Native Unix review remains unaccepted; runtime flags cannot enable production admission.' },
  { id: 'product-review-capture', classification: 'missing-capture', evidence: 'modules/mcp/launcher/src-tauri/src/settings_review_admission.rs',
    detail: 'Product review shares the implemented experimental admission; native dialog/workflow/router/ownership and preservation acceptance is still uncaptured.' },
  { id: 'native-gui-driver', classification: 'missing-capture', evidence: 'scripts/native-builtin-smoke.cjs',
    detail: 'The full built-in acceptance harness remains Windows-only. Native Linux and Mac owned-window helper contracts exist and their fixtures pass, but they are not yet integrated with an accepted packaged GUI/migration/update run.' },
];

function runner(env = process.env, platform = process.platform, arch = process.arch) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'Disposable GitHub runner required');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(env.CREATOR_UNIX_HOSTED_EXPERIMENT, '1', 'Explicit experiment opt-in required');
  assert.ok(['linux', 'darwin'].includes(platform) && ['x64', 'arm64'].includes(arch));
  assert.equal(env.RUNNER_OS, platform === 'linux' ? 'Linux' : 'macOS');
  assert.equal(env.RUNNER_ARCH, arch === 'x64' ? 'X64' : 'ARM64');
  assert.equal(env.FLATPAK_ID, undefined, 'This is not a Flatpak host broker');
}
function validateBinding(b) {
  const { expected: e, run: r, artifact: a, source, build, jobs } = b;
  const target = TARGETS[e.target];
  assert.ok(target, 'Unknown native target');
  for (const id of [e.runId, e.artifactId]) assert.ok(Number.isSafeInteger(id) && id > 0);
  for (const sha of [e.sourceCommit, e.buildCommit]) assert.match(sha, /^[a-f0-9]{40}$/);
  assert.match(e.zipSha256, /^[a-f0-9]{64}$/);
  assert.equal(r.id, e.runId); assert.equal(r.head_sha, e.sourceCommit);
  assert.equal(r.status, 'completed'); assert.equal(r.conclusion, 'success');
  assert.equal(r.path, '.github/workflows/unified-unix-candidate.yml');
  for (const repo of [r.repository, r.head_repository]) {
    assert.equal(repo.id, REPOSITORY_ID); assert.equal(repo.full_name, REPOSITORY);
  }
  assert.equal(source.sha, e.sourceCommit); assert.equal(build.sha, e.buildCommit);
  assert.match(source.tree.sha, /^[a-f0-9]{40}$/); assert.equal(build.tree.sha, source.tree.sha, 'Merge/source tree differs');
  if (r.event === 'pull_request') {
    assert.match(e.baseCommit, /^[a-f0-9]{40}$/);
    assert.deepEqual(build.parents.map(p => p.sha), [e.baseCommit, e.sourceCommit], 'Exact merge parents required');
  } else {
    assert.equal(r.event, 'workflow_dispatch'); assert.equal(e.buildCommit, e.sourceCommit);
    assert.equal(e.baseCommit, '');
  }
  assert.equal(a.id, e.artifactId); assert.equal(a.expired, false);
  assert.equal(a.name, `unified-unix-candidate-${target.os}-${target.runnerArch}-${e.buildCommit}`);
  assert.equal(a.digest, `sha256:${e.zipSha256}`);
  assert.ok(Number.isSafeInteger(a.size_in_bytes) && a.size_in_bytes > 0 && a.size_in_bytes <= 768 * 1024 * 1024);
  assert.equal(a.workflow_run.id, e.runId); assert.equal(a.workflow_run.head_sha, e.sourceCommit);
  assert.equal(a.workflow_run.repository_id, REPOSITORY_ID); assert.equal(a.workflow_run.head_repository_id, REPOSITORY_ID);
  assert.ok(Number.isSafeInteger(r.run_attempt) && r.run_attempt > 0);
  const selected = jobs.filter(j => j.name === target.job);
  assert.equal(selected.length, 1, 'Exactly one native packaging job required');
  assert.equal(selected[0].run_id, e.runId); assert.equal(selected[0].run_attempt, r.run_attempt);
  assert.equal(selected[0].status, 'completed'); assert.equal(selected[0].conclusion, 'success');
  return { ...e, sourceTree: source.tree.sha, runAttempt: r.run_attempt, zipBytes: a.size_in_bytes, ...target };
}
function regular(file, root) {
  const relative = path.relative(root, file);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Path escaped scoped root');
  for (let part = file;; part = path.dirname(part)) {
    assert.equal(fs.lstatSync(part).isSymbolicLink(), false, 'Redirected path refused');
    if (part === root) break;
  }
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && stat.nlink === 1, 'Regular unlinked input required');
  return stat;
}
function hash(file) {
  const digest = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
  try { for (let size; (size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) digest.update(buffer.subarray(0, size)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
}
function readJson(root, name) {
  const file = path.join(root, name);
  assert.ok(regular(file, root).size <= 1024 * 1024, 'Metadata exceeds bound');
  return { bytes: fs.readFileSync(file), value: JSON.parse(fs.readFileSync(file, 'utf8')) };
}
function blockedReport() {
  return { schemaVersion: 1, scope: 'experimental-unix-hosted-prerequisites', passed: false, releaseReady: false,
    status: 'blocked', nativeGuiTested: false, nativeConsentTested: false, hostedOperationsTested: false,
    clientMigrationTested: false, processCleanupTested: false, actualAiTested: false, unitySdkTested: false,
    userMachineUsed: false, checks: [], blockers: BLOCKERS.map(b => ({ ...b })) };
}
function inspectCandidate(candidate, output, binding, archive, decoder, execute = execFileSync) {
  const report = blockedReport();
  try {
    const pin = validateBinding(binding);
    report.binding = pin;
    assert.equal(regular(archive, path.dirname(archive)).size, pin.zipBytes);
    assert.equal(hash(archive), pin.zipSha256, 'Downloaded ZIP differs');
    const descriptor = readJson(candidate, 'builtin-manifest.json');
    const integrity = readJson(candidate, 'unix-package-integrity.json').value;
    const experiment = readJson(candidate, 'experimental-unix.json').value;
    for (const record of [descriptor.value, integrity, experiment]) {
      assert.equal(record.platform, pin.platform); assert.equal(record.arch, pin.arch);
    }
    for (const record of [integrity, experiment]) {
      assert.equal(record.schemaVersion, 1); assert.equal(record.mcpMode, 'read-only');
      assert.equal(record.writableGuiAccepted, false); assert.equal(record.releaseReady, false);
    }
    assert.equal(integrity.integrityPassed, true, 'Producer packaging failed');
    const format = pin.platform === 'linux' ? 'deb' : 'dmg';
    const packages = integrity.packages.filter(p => p.format === format);
    assert.equal(packages.length, 1);
    const item = packages[0];
    assert.match(item.path, format === 'deb' ? /^native-packages\/[^/\\]+\.deb$/ : /^native-packages\/[^/\\]+\.dmg$/);
    assert.match(item.sha256, /^[a-f0-9]{64}$/); assert.match(item.hubSha256, /^[a-f0-9]{64}$/);
    const file = path.join(candidate, item.path);
    assert.ok(regular(file, candidate).size <= 512 * 1024 * 1024, 'Native container exceeds bound');
    assert.equal(hash(file), item.sha256, 'Native container differs');
    const extracted = path.join(output, 'extracted');
    const unix = require('./unix-package-payload.cjs');
    unix.extract(file, format, extracted, 'Creator Hub', execute);
    const hub = path.join(extracted, pin.platform === 'linux' ? 'usr/bin/creator-hub' : 'Creator Hub.app/Contents/MacOS/creator-hub');
    regular(hub, extracted); assert.equal(hash(hub), item.hubSha256, 'Packaged Hub differs');
    assert.ok(fs.readFileSync(hub).includes(descriptor.bytes), 'Exact compile-bound descriptor missing');
    let files;
    if (pin.platform === 'linux') {
      const payload = path.join(extracted, 'usr/lib/Creator Hub/modules.tar.gz');
      regular(payload, extracted);
      files = require('./module-archive.cjs').verify(payload, descriptor.value, decoder, execute);
    } else {
      files = unix.verifyResources(path.join(extracted, 'Creator Hub.app/Contents/Resources/modules'), descriptor.value);
      execute('codesign', ['--verify', '--deep', '--strict', path.join(extracted, 'Creator Hub.app')], { timeout: 30000, stdio: 'pipe' });
    }
    assert.deepEqual(files, item.files, 'Producer/extracted payload map differs');
    report.checks.push('Exact API/ZIP/native container/Hub/compile-bound descriptor/raw module hashes verified; no app installed or opened');
    report.package = { format, sha256: item.sha256, hubSha256: item.hubSha256, files };
    report.packageIntegrityTested = true;
  } catch (error) {
    report.status = 'failed'; report.error = String(error.message).slice(0, 2000);
    if (error instanceof AggregateError) report.originalFailures = error.errors.slice(0, 4).map(e => String(e.message).slice(0, 500));
  }
  // No fixture, clean teardown, or packaging result may promote native acceptance.
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  return report;
}

// Synthetic receipt contract only: this never drives a GUI, authorizes a parent, or writes client settings.
function validateFixture(trace) {
  assert.equal(trace.synthetic, true); assert.equal(trace.experimentalFeature, 'experimental-unix-hosting');
  assert.equal(trace.storageInjected, false); assert.equal(trace.actualAiUsed, false);
  assert.deepEqual(Object.keys(trace.beforeImages).sort(), ['client-config', 'launcher-settings', 'project-sentinel']);
  for (const digest of Object.values(trace.beforeImages)) assert.match(digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(trace.beforeImages, trace.afterImages, 'Old settings/client entries/project sentinel changed');
  assert.ok(Number.isSafeInteger(trace.unrelatedNodeBefore.pid) && trace.unrelatedNodeBefore.pid > 1);
  assert.match(trace.unrelatedNodeBefore.startTime, /^[0-9]+$/);
  assert.match(trace.unrelatedNodeBefore.exeSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(trace.unrelatedNodeBefore, trace.unrelatedNodeAfter, 'Unrelated Node identity changed');
  assert.equal(trace.events.length, 8, 'Unexpected/missing lifecycle event');
  for (const app of ['mcp', 'setup']) {
    const events = trace.events.filter(e => e.app === app);
    assert.deepEqual(events.map(e => e.phase), ['decline', 'retry-open', 'harmless-probe', 'normal-close']);
    for (const e of events) {
      assert.equal(e.privatePipes, true); assert.equal(e.exactDirectParent, true); assert.equal(e.payloadBound, true);
      assert.equal(e.identityBefore, e.identityAfter); assert.match(e.identityBefore, /^[a-f0-9]{64}$/);
    }
    assert.equal(events[0].nativeConsent, 'declined'); assert.equal(events[0].backendExited, true);
    assert.equal(events[0].writes, 0); assert.equal(events[0].retryEnabled, true);
    assert.equal(events[1].nativeConsent, 'approved'); assert.equal(events[1].effectiveMode, app === 'mcp' ? 'writable' : 'setup');
    assert.equal(events[2].command, app === 'mcp' ? 'get_hosted_snapshot' : 'get_recipe');
    assert.equal(events[2].ok, true); assert.equal(events[2].writes, 0);
    assert.equal(events[3].requested, true); assert.equal(events[3].exitCode, 0);
    assert.equal(events[3].backendExited, true); assert.equal(events[3].survivors, 0);
  }
  return { contractFixturePassed: true, nativeGuiTested: false, passed: false, releaseReady: false };
}
function main() {
  runner();
  assert.equal(process.argv.length, 7, 'Use CANDIDATE NEW_OUTPUT BINDING_JSON ZIP DECODER_OR_DASH');
  const [candidate, output, bindingFile, archive, decoder] = process.argv.slice(2).map((p, i) => i === 4 && p === '-' ? p : path.resolve(p));
  const temporary = path.resolve(process.env.RUNNER_TEMP);
  assert.equal(path.dirname(output), temporary, 'Output must be an isolated runner-temp child');
  assert.equal(fs.existsSync(output), false, 'Evidence is write-once');
  assert.equal(fs.realpathSync(temporary), temporary, 'Runner temp is redirected');
  fs.mkdirSync(output, { mode: 0o700 });
  let report;
  try {
    const binding = readJson(path.dirname(bindingFile), path.basename(bindingFile)).value;
    const pin = validateBinding(binding);
    assert.equal(process.platform, pin.platform === 'linux' ? 'linux' : 'darwin');
    assert.equal(process.arch, pin.arch === 'x86_64' ? 'x64' : 'arm64');
    report = inspectCandidate(candidate, output, binding, archive, decoder);
  } catch (error) {
    report = { ...blockedReport(), status: 'failed', error: String(error.message).slice(0, 2000) };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify({ status: report.status, blockers: report.blockers.map(b => b.id), releaseReady: false }));
  process.exitCode = 1; // Intentional hold, including an integrity-only success.
}
module.exports = { TARGETS, REPOSITORY, REPOSITORY_ID, runner, validateBinding, regular, hash, blockedReport, inspectCandidate, validateFixture };
if (require.main === module) { try { main(); } catch (error) { console.error(String(error.message).slice(0, 2000)); process.exitCode = 1; } }
