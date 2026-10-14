const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const diagnostics = require('./native-macos-root-diagnostics.cjs');
const probe = require('./native-macos-app-probe.cjs');
const owner = { process: { pid: 47, startSeconds: 1792003497, startMicroseconds: 377487 }, window: { id: 29, pid: 47 } };
const now = 1792003517378;
const fence = () => ({ command: 'bitmap-fence', cgWindowFenceVerified: true, permissionRequestsPerformed: false,
  actionAttempted: false, process: structuredClone(owner.process), window: structuredClone(owner.window) });
const records = (...items) => Buffer.from(items.map(item => JSON.stringify(item)).join('\n'));
const entry = () => ({ timestamp: new Date(now - 1000).toISOString(), processID: 47, subsystem: 'com.apple.WebKit', eventMessage: 'fixture only' });
function workflowScript(source, stepName) {
  const section = source.replace(/\r\n/g, '\n').split(`      - name: ${stepName}\n`)[1];
  assert.ok(section, `missing step ${stepName}`);
  const block = section.match(/          script: \|\n((?: {12}.*(?:\n|$))*)/)[1];
  return block.split('\n').map(line => line.slice(12)).join('\n');
}

test('ordinary control is explicit14/disposable and strips HOME coercion/injection/secrets; private default unchanged', () => {
  diagnostics.launchControl('direct-ordinary', { CREATOR_MACOS_LAUNCH_CONTROL: '1' }, '0.1.14');
  for (const sample of [['unknown', '1', '0.1.14'], ['direct-private', undefined, '0.1.14'], ['direct-ordinary', '1', '0.1.13']]) {
    assert.throws(() => diagnostics.launchControl(sample[0], { CREATOR_MACOS_LAUNCH_CONTROL: sample[1] }, sample[2]));
  }
  const profile = diagnostics.ordinaryProfile({ HOME: '/Users/runner', TMPDIR: '/var/folders/owned/', USER: 'runner',
    GH_TOKEN: 'must-not-copy', DYLD_INSERT_LIBRARIES: 'must-not-copy', CFFIXED_USER_HOME: '/foreign', XDG_CONFIG_HOME: '/foreign' });
  assert.deepEqual(profile, { HOME: '/Users/runner', TMPDIR: '/var/folders/owned/', USER: 'runner', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  assert.throws(() => diagnostics.ordinaryProfile({ HOME: '/Users/ordinary-person', TMPDIR: '/tmp/' }));
  const args = ['--app', '/tmp/Root.app', '--hub-sha256', 'a'.repeat(64), '--output', '/tmp/new',
    '--expected-version', '0.1.14', '--assembly-receipt', '/tmp/signed-unix-assembly.json', '--assembly-receipt-sha256', 'b'.repeat(64)];
  assert.equal(probe.options([...args, '--launch-context', 'launchservices-ordinary']).launchContext, 'launchservices-ordinary');
  assert.throws(() => probe.options([...args.slice(0, 6), '--launch-context', 'direct-private']));
  assert.throws(() => probe.options([...args, '--launch-context', 'remote-debug-unowned']));
});
test('log command has only numeric owned Root predicate and finite lifetime/size; no global WebKit or private logging', () => {
  const plan = diagnostics.logPlan(owner, now);
  assert.equal(plan.file, '/usr/bin/log'); assert.ok(plan.argv.includes('processIdentifier == 47'));
  assert.equal(plan.maxBytes, 512 * 1024); assert.equal(plan.timeoutMilliseconds, 5000);
  assert.ok(plan.argv.includes('120s'));
  assert.doesNotMatch(plan.argv.join(' '), /WebContent|--privacy|--archive|collect|config|sudo/);
  for (const altered of [0, -1, '47 OR TRUEPREDICATE', 0x80000000]) {
    assert.throws(() => diagnostics.logPlan({ ...owner, process: { ...owner.process, pid: altered } }, now));
  }
  assert.throws(() => diagnostics.logPlan(owner, now + 120000));
  assert.throws(() => diagnostics.logPlan(owner, owner.process.startSeconds * 1000));
});
test('numeric PID plus kernel lifetime filter refuses foreign/malformed/large logs and excludes earlier reuse', () => {
  const plan = diagnostics.logPlan(owner, now);
  const current = entry(); assert.deepEqual(diagnostics.parseLog(records(current, { finished: 1 }), plan), [current]);
  assert.deepEqual(diagnostics.parseLog(records({ ...current, timestamp: new Date(plan.started - 1000).toISOString() }), plan), []);
  assert.throws(() => diagnostics.parseLog(records({ ...current, processID: 48 }), plan));
  assert.throws(() => diagnostics.parseLog(records({ ...current, timestamp: 'unknown' }), plan));
  assert.throws(() => diagnostics.parseLog(Buffer.alloc(512 * 1024 + 1), plan));
  assert.throws(() => diagnostics.parseLog(Buffer.from([0xff]), plan));
  assert.throws(() => diagnostics.parseLog(Buffer.from('malformed'), plan));
  assert.throws(() => diagnostics.parseLog(records(...Array(257).fill(current)), plan));
  assert.throws(() => diagnostics.parseLog(records({ ...current, eventMessage: 'x'.repeat(8193) }), plan));
});
test('readonly log diagnostic rechecks exact native Root and window even after tool failure; no WebContent ownership guesses', async () => {
  const calls = [];
  const io = { now: () => now, fence: async stage => { calls.push(stage); return fence(); },
    run: async () => ({ exitCode: 0, signal: null, bytes: records(entry()) }) };
  const result = await diagnostics.diagnostic(owner, io);
  assert.equal(result.completed, true); assert.deepEqual(calls, ['before', 'after']);
  assert.match(result.webContentScope, /no WebContent/);
  for (const flag of ['actionAttempted', 'permissionRequestsPerformed', 'nativeGuiAccepted', 'mcpAccepted', 'migrationAccepted', 'updateAccepted', 'releaseReady']) assert.equal(result[flag], false);
  const badBefore = await diagnostics.diagnostic(owner, { ...io, fence: async () => ({ ...fence(), process: { ...owner.process, startSeconds: 1 } }), run: async () => { throw Error('must not run'); } });
  assert.equal(badBefore.completed, false); assert.match(badBefore.reason, /fence/);
  const badAfter = await diagnostics.diagnostic(owner, { ...io, fence: async stage => stage === 'before' ? fence() : { ...fence(), window: { id: 30 } } });
  assert.equal(badAfter.completed, false);
  for (const failure of [{ exitCode: 1, signal: null }, { exitCode: 0, signal: 'SIGTERM' }, { exitCode: 0, signal: null, overflow: true }, { exitCode: 0, signal: null, timedOut: true }]) {
    const beforeCalls = calls.length;
    assert.equal((await diagnostics.diagnostic(owner, { ...io, run: async () => failure })).completed, false);
    assert.deepEqual(calls.slice(beforeCalls), ['before', 'after']);
  }
});
test('bounded output abandons only log tool streams without any signal or Root/peer process action', async () => {
  const task = new EventEmitter(); task.stdout = new PassThrough(); task.stderr = new PassThrough(); task.pid = 99;
  let unreferenced = false; task.unref = () => { unreferenced = true; };
  task.kill = () => { throw Error('No process may be signalled'); };
  const plan = diagnostics.logPlan(owner, now);
  const pending = diagnostics.runLog(plan, {}, (file, argv) => { assert.equal(file, '/usr/bin/log'); assert.deepEqual(argv, plan.argv); return task; });
  task.stdout.write(Buffer.alloc(plan.maxBytes + 1));
  const result = await pending; assert.equal(result.overflow, true); assert.equal(result.toolPid, 99);
  assert.equal(unreferenced, true); assert.equal(result.toolLifetimeUncertain, true); assert.equal(result.bytes.length, 0);
  assert.equal(result.stdoutBytesReceived, plan.maxBytes + 1); assert.ok(result.elapsedMilliseconds >= 0);
});
test('log tool status retains timeout/overflow/exit distinction before the after-fence, without raw error or log text', async () => {
  for (const failure of [
    { exitCode: null, signal: null, timedOut: true, toolLifetimeUncertain: true },
    { exitCode: null, signal: null, overflow: true, toolLifetimeUncertain: true },
    { exitCode: 1, signal: null, error: 'EPERM', toolLifetimeUncertain: false },
    { exitCode: null, signal: 'SIGTERM', toolLifetimeUncertain: false },
  ]) {
    const output = { toolPid: 99, stdoutBytesReceived: 41, elapsedMilliseconds: 5001,
      bytes: Buffer.from('not retained in status'), ...failure };
    for (const afterRefused of [false, true]) {
      const calls = [];
      const result = await diagnostics.diagnostic(owner, { now: () => now,
        fence: async stage => { calls.push(stage); return afterRefused && stage === 'after' ? {} : fence(); }, run: async () => output });
      assert.equal(result.completed, false); assert.deepEqual(calls, ['before', 'after']);
      assert.deepEqual(result.plan, diagnostics.logPlan(owner, now));
      assert.deepEqual(result.toolStatus, diagnostics.logToolStatus(output));
      assert.equal(result.toolLifetimeUncertain, failure.toolLifetimeUncertain);
      assert.equal(result.reason, afterRefused ? 'diagnostic-owned-root-fence-unverified' : 'diagnostic-log-tool-refused-or-bounded-out');
      assert.equal(result.entries, undefined); assert.equal(result.toolStatus.bytes, undefined);
      assert.equal(result.actionAttempted, false); assert.equal(result.nativeGuiAccepted, false);
    }
  }
  const thrown = await diagnostics.diagnostic(owner, { now: () => now, fence: async () => fence(), run: async () => { throw Error('fixture'); } });
  assert.equal(thrown.toolStatus.threw, true); assert.equal(thrown.toolLifetimeUncertain, true);
});
test('malformed tool metadata remains unknown and cannot copy arbitrary fields or change diagnostic acceptance', () => {
  const result = diagnostics.logToolStatus({ toolPid: '47', exitCode: -1, signal: 'private/path', error: 'private/path',
    timedOut: 'true', overflow: 'true', stdoutBytesReceived: Infinity, elapsedMilliseconds: NaN, bytes: 'private text', actionAllowed: true });
  assert.deepEqual(result, { threw: false, toolPid: null, exitCode: null, signal: 'unknown', errorCode: null,
    timedOut: false, overflow: false, stdoutBytesReceived: null, stdoutBytesRetained: null, elapsedMilliseconds: null });
  assert.equal(diagnostics.logToolStatus(null, true).threw, true);
});
test('timeout status preserves finite budget and uncertain tool lifetime without signalling any process', async () => {
  const task = new EventEmitter(); task.stdout = new PassThrough(); task.stderr = new PassThrough(); task.pid = 99;
  task.unref = () => {}; task.kill = () => { throw Error('No signals'); };
  const plan = { ...diagnostics.logPlan(owner, now), timeoutMilliseconds: 20 };
  const result = await diagnostics.runLog(plan, {}, () => task);
  assert.equal(result.timedOut, true); assert.equal(result.overflow, undefined);
  assert.equal(result.toolLifetimeUncertain, true); assert.equal(result.stdoutBytesReceived, 0);
  task.emit('close', 0, null); assert.equal(result.timedOut, true); assert.equal(result.exitCode, null);
  assert.equal(diagnostics.logPlan(owner, now).timeoutMilliseconds, 5000);
});
test('log tool error preserves unknown lifetime and a bounded error code, never an assumed clean exit', async () => {
  const task = new EventEmitter(); task.stdout = new PassThrough(); task.stderr = new PassThrough(); task.pid = 99;
  const pending = diagnostics.runLog(diagnostics.logPlan(owner, now), {}, () => task);
  task.emit('error', Object.assign(Error('must not copy this message'), { code: 'EACCES' }));
  const result = await pending;
  assert.equal(result.exitCode, null); assert.equal(result.toolLifetimeUncertain, true);
  assert.equal(diagnostics.logToolStatus(result).errorCode, 'EACCES');
  assert.equal(JSON.stringify(diagnostics.logToolStatus(result)).includes('must not copy'), false);
});
test('source keeps AX authority/refusal/deadlines, measured20s control bitmap and genuine direct-only exit receipt', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-macos-app-probe.cjs'), 'utf8');
  assert.match(source, /native-package-identity-refused/); assert.match(source, /systemUptime \+ 20/);
  assert.match(source, /controlBitmapAgeMilliseconds >= 20000/);
  assert.match(source, /No invented Node ChildProcess/);
  assert.doesNotMatch(source, /ownedExit\s*=\s*\{[^}]*code:\s*0/);
  assert.match(source, /if \(report.rootFailureDiagnostics.toolLifetimeUncertain === true\) diagnosticToolUncertain = true/);
  assert.doesNotMatch(source, /rootFailureDiagnostics.toolLifetimeUncertain === true\) toolUncertain = true/);
  const close = source.split("'readonly-code-signature'")[1].split('if (child) await waitExit')[0];
  assert.match(close, /if \(rootPid && owner && !ownedExit && !toolUncertain\)/);
  assert.doesNotMatch(close, /!diagnosticToolUncertain/);
  assert.match(close, /sameImage\(pin\(path.join\(output, 'owner.json'\), 8192\).image, ownerImage\)/);
  assert.match(close, /\['close', path.join\(output, 'owner.json'\)\], 'normal-close', 15000, helper.image/);
  assert.match(source, /toolUncertain !== false \|\| diagnosticToolUncertain !== false/);
  const swift = fs.readFileSync(path.join(__dirname, 'native-macos-launchservices.swift'), 'utf8');
  assert.ok(swift.indexOf('GITHUB_ACTIONS') < swift.indexOf('NSWorkspace.shared'));
  assert.match(swift, /configuration\.createsNewApplicationInstance = true/);
  assert.match(swift, /configuration\.environment = profile/);
  assert.match(swift, /rootExitStatusKnown.*false/);
  assert.doesNotMatch(swift, /AXPress|AXUIElementPerformAction|terminate\(|kill\(|Authorization|TCC|security/);
});
test('same-package workflow pins original failed-run package steps independently and never rebuilds/signs/changes payload or privileges', () => {
  const source = fs.readFileSync(path.join(__dirname, '../.github/workflows/native-macos-launch-control.yml'), 'utf8');
  for (const value of ['38615878801', '17b769ad2d8c4a005520459749170895d75ff05b',
    '11919728492', '11919859477', 'e3487449c031dac861cdcc92a012588dcfae58cbb88b1f575c30984ede869fbb',
    '294615a337b1eb527df57c0fb3a9aba239aae204812d8a7b7b680d3698282767',
    '16ef1b41718fb3381fc4a02a26eeaa5a573ec748438e97ea0c91cbe0cc1b37c1',
    '85f7a1f9401d540e3fb8f6ddb5b83d3a3ff8681ad7b7f21c80cad085fcaffca5']) assert.ok(source.includes(value));
  assert.match(source, /options: \[selected-three, ls-arm, ls-intel, intel-ordinary\]/);
  assert.match(source, /matrix: \$\{\{ fromJSON\(needs.select-control.outputs.matrix\) \}\}/);
  assert.doesNotMatch(source, /context: \[direct-private|target: \[macos-arm64/);
  assert.match(source, /artifact\.workflow_run\.head_sha,run\.head_sha/);
  assert.match(source, /packageStepsVerified:true,originalGuiJobFailed:true,nativeGuiAccepted:false,releaseReady:false/);
  assert.match(source, /count==e\.file_size/); assert.match(source, /len\(names\)==len\(set\(names\)\)/);
  assert.match(source, /unix\.verifyResources/); assert.match(source, /codesign.*--verify/);
  assert.match(source, /--launch-context "\$LAUNCH_CONTEXT"/);
  assert.doesNotMatch(source, /cargo |tauri build|build:unified|signingKey|codesign.*--sign|sudo|id-token:|contents: write|actions: write|xattr|WEBKIT_DISABLE|DYLD_|osascript/);
});

test('exact workflow selector emits only LS ARM/LS Intel/Intel ordinary or one exact case; unknown contexts fail before output', () => {
  const source = fs.readFileSync(path.join(__dirname, '../.github/workflows/native-macos-launch-control.yml'), 'utf8');
  const block = workflowScript(source, 'Select only the three admitted follow-up contexts');
  const selectionJob = source.split('  select-control:')[1].split('\n  control:')[0];
  assert.match(selectionJob, /permissions: \{\}/);
  assert.match(selectionJob, /CONTROL_CASE: \$\{\{ github.event_name == 'push' && 'selected-three' \|\| inputs.control_case \}\}/);
  assert.doesNotMatch(selectionJob, /checkout|github.rest|download|spawn|execFile|writeFile|GH_TOKEN/);
  const expected = [
    ['ls-arm', 'launchservices-ordinary', 'macos-arm64', 'macos-latest', 11919728492, 116030795575],
    ['ls-intel', 'launchservices-ordinary', 'macos-intel', 'macos-15-intel', 11919859477, 116030795486],
    ['intel-ordinary', 'direct-ordinary', 'macos-intel', 'macos-15-intel', 11919859477, 116030795486],
  ];
  function execute(selection, writes) {
    vm.runInNewContext(block, { require, process: { env: { CONTROL_CASE: selection } }, core: {
      setOutput: (name, value) => { assert.equal(name, 'matrix'); writes.push(JSON.parse(value)); },
    } });
  }
  const writes = []; execute('selected-three', writes); assert.equal(writes.length, 1);
  const { include } = writes[0];
  assert.deepEqual(include.map(c => [c.case, c.context, c.target, c.os, c.artifact, c.job]), expected);
  assert.deepEqual(include[1].zip, include[2].zip); assert.deepEqual(include[1].hub, include[2].hub);
  for (const item of include) {
    const outputs = []; execute(item.case, outputs); assert.deepEqual(outputs, [{ include: [item] }]);
  }
  for (const invalid of [undefined, '', 'all', 'direct-private', 'arm-ordinary', 'macos-intel', 'ls-arm,ls-intel', '[]', '{}', '__proto__']) {
    const outputs = []; assert.throws(() => execute(invalid, outputs)); assert.deepEqual(outputs, []);
  }
});
test('actual workflow qualification refuses drift/expired ZIP or a failed package step before recording any admission', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../.github/workflows/native-macos-launch-control.yml'), 'utf8');
  const block = workflowScript(source, 'Independently qualify original packaged artifact, not the failed GUI job as acceptance');
  const fixture = () => ({
    run: { id: 38615878801, head_sha: '17b769ad2d8c4a005520459749170895d75ff05b', path: '.github/workflows/unix-managed-assembly.yml', event: 'push', status: 'completed', run_attempt: 1, conclusion: 'failure' },
    artifact: { id: 11919728492, name: 'signed-unix-hub-macos-arm64-38615878801-1', expired: false,
      digest: 'sha256:e3487449c031dac861cdcc92a012588dcfae58cbb88b1f575c30984ede869fbb', size_in_bytes: 107558637,
      workflow_run: { id: 38615878801, head_sha: '17b769ad2d8c4a005520459749170895d75ff05b', repository_id: 1364807512, head_repository_id: 1364807512 } },
    job: { id: 116030795575, run_id: 38615878801, run_attempt: 1, name: 'assembly (macos-arm64, macos-latest)', steps: [
      'Verify trusted handoff and compile only the outer native Hub', 'Bind the actual packaged Mac app, native version and primary assembly receipt',
      'Retain signed build evidence, not publication or migration acceptance'].map(name => ({ name, conclusion: 'success' })) },
  });
  async function execute(input, writes) {
    const api = { getWorkflowRun: async () => ({ data: input.run }), getArtifact: async () => ({ data: input.artifact }),
      getJobForWorkflowRun: async () => ({ data: input.job }) };
    return vm.runInNewContext(`(async()=>{${block}})()`, { require: name => name === 'node:fs' ?
      { writeFileSync: (file, value, options) => { assert.equal(options.flag, 'wx'); writes.push(JSON.parse(value)); } } : require(name),
    github: { rest: { actions: api } }, context: { repo: { owner: 'fixture-only', repo: 'fixture-only' } },
    process: { env: { ARTIFACT: '11919728492', ZIP_SHA256: 'e3487449c031dac861cdcc92a012588dcfae58cbb88b1f575c30984ede869fbb', ZIP_BYTES: '107558637',
      TARGET: 'macos-arm64', PRIMARY_JOB: '116030795575', RUNNER_TEMP: '/fixture-only' } } });
  }
  const writes = []; await execute(fixture(), writes);
  assert.equal(writes.length, 1); assert.equal(writes[0].originalGuiJobFailed, true);
  assert.equal(writes[0].nativeGuiAccepted, false); assert.equal(writes[0].releaseReady, false);
  for (const change of [value => value.run.id++, value => value.run.head_sha = 'a'.repeat(40), value => value.run.event = 'workflow_dispatch',
    value => value.artifact.id++, value => value.artifact.digest = 'sha256:' + 'a'.repeat(64), value => value.artifact.workflow_run.repository_id++,
    value => value.artifact.expired = true, value => value.artifact.workflow_run.head_sha = 'b'.repeat(40),
    value => value.artifact.name = 'other', value => value.artifact.size_in_bytes++,
    value => value.job.run_id++, value => value.job.run_attempt++, value => value.job.name = 'assembly (macos-intel, macos-15-intel)',
    value => value.job.steps[0].conclusion = 'failure', value => value.job.steps.pop()]) {
    const input = fixture(), outputs = []; change(input);
    await assert.rejects(execute(input, outputs)); assert.deepEqual(outputs, []);
  }
});
