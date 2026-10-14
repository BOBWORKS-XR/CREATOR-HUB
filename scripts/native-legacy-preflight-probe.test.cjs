const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PUBLIC_INSTALLER, MODES, admission, validateReceipt } = require('./native-legacy-preflight-probe.cjs');

const source = fs.readFileSync(path.join(__dirname, 'native-legacy-preflight-probe.cjs'), 'utf8');
const native = fs.readFileSync(path.join(__dirname, 'native-legacy-preflight-probe.ps1'), 'utf8');
const admitted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
  RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', CREATOR_LEGACY_PREFLIGHT_PROBE: '1',
  SystemRoot: 'C:\\Windows' };

function receipt() {
  return {
    scope: 'unchanged-public-277-first-dialog-cancel-only', mode: 'first-dialog-cancel',
    nativeInstallDirectory: 'C:\\Users\\runneradmin\\AppData\\Local\\Creator Works MCP', freshNamespaceVerified: true,
    installerSha256: PUBLIC_INSTALLER.sha256,
    installerBytes: PUBLIC_INSTALLER.bytes, installerPid: 4000, installerStart: '2026-10-14T18:00:00Z',
    installerIs64Bit: false,
    firstDialog: { title: 'Creator Works MCP Setup', handle: 101, class: '#32770', processId: 4000,
      controls: [{ name: 'Setup could not verify access to Creator Works MCP files. Check result: timeout',
        id: '65535', type: 'ControlType.Text', processId: 4000 },
      { name: 'Cancel', id: '2', type: 'ControlType.Button', processId: 4000 }] },
    laterDialogs: [], classification: 'preflight-unavailable',
    powerShellChildren: [{ pid: 4001, parentPid: 4000, observedAt: '2026-10-14T18:00:01Z',
      image: 'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe', imageSha256: 'a'.repeat(64),
      is64Bit: false, observationError: null, stoppedAt: '2026-10-14T18:00:03Z', exitStatus: 1 }], observerError: null,
    cancelPosted: true, confirmationPosted: false, installerExited: true, installerExitCode: 10,
    defaultDirectoryAbsent: true, uninstallRegistrationAbsent: true, productRegistrationAbsent: true,
    installerBytesUnchanged: true, error: null,
    originalNsExecReturnCaptured: false, originalPowerShellModulesCaptured: false,
    installerRerun: false, processesKilled: false, installAccepted: false, releaseReady: false,
  };
}
const decode = (value, mode) => validateReceipt(Buffer.from(JSON.stringify(value)), mode);
function silentReceipt() {
  return { ...receipt(), scope: 'unchanged-public-277-silent-observation-only', mode: 'silent-observe',
    firstDialog: null, classification: 'silent-exited', cancelPosted: false };
}

function isolated({ env = admitted, filesystem, spawn = () => assert.fail('No real worker permitted'),
  timeout = () => 1, hash = PUBLIC_INSTALLER.sha256 } = {}) {
  const module = { exports: {} };
  const deniedFilesystem = new Proxy({}, { get() { assert.fail('No filesystem access before admission'); } });
  vm.runInNewContext(source, { module, __dirname, Buffer, console, setTimeout: timeout, clearTimeout: () => {},
    process: { env, platform: 'win32', argv: [] }, require(name) {
      if (name === 'node:fs') return filesystem || deniedFilesystem;
      if (name === 'node:child_process') return { spawn };
      if (name === 'node:crypto') return { createHash: () => ({ update() { return this; }, digest: () => hash }) };
      return require(name);
    } });
  return module.exports;
}

test('exact public installer binding agrees with the independent baseline, not the candidate', () => {
  const baseline = require('./native-installed-baseline.cjs').baselines.find(item => item.product === 'Creator Works MCP');
  assert.equal(PUBLIC_INSTALLER.sha256, baseline.sha256);
  assert.equal(PUBLIC_INSTALLER.asset, baseline.asset);
  assert.equal(PUBLIC_INSTALLER.bytes, 27059109);
});

test('local, self-hosted, wrong repository, architecture and missing explicit admission refuse before inspection', async () => {
  for (const [key, value] of [['GITHUB_ACTIONS', 'false'], ['RUNNER_ENVIRONMENT', 'self-hosted'],
    ['RUNNER_OS', 'Linux'], ['RUNNER_ARCH', 'ARM64'], ['GITHUB_REPOSITORY', 'foreign/repository'],
    ['CREATOR_LEGACY_PREFLIGHT_PROBE', undefined]]) {
    const env = { ...admitted, [key]: value };
    assert.throws(() => admission(env, 'win32'));
    await assert.rejects(isolated({ env }).probe('never-inspected'));
  }
  assert.throws(() => admission(admitted, 'linux'));
});

test('receipt captures original owned dialog and observed child image/bitness but never invents internal nsExec trace', () => {
  const decoded = decode(receipt());
  assert.equal(decoded.capturedAndCancelled, true);
  assert.match(decoded.report.firstDialog.controls[0].name, /Check result: timeout/);
  assert.equal(decoded.report.powerShellChildren[0].is64Bit, false);
  assert.equal(decoded.report.powerShellChildren[0].exitStatus, 1);
  assert.equal(decoded.report.originalNsExecReturnCaptured, false);
  assert.equal(decoded.report.originalPowerShellModulesCaptured, false);
  assert.equal(decoded.report.installAccepted, false);
  assert.equal(decoded.report.releaseReady, false);
});

test('vanished child or no child observation stays unknown, not an inferred 64-bit shell', () => {
  for (const powerShellChildren of [[], [{ pid: 4001, parentPid: 4000, observedAt: '2026-10-14T18:00:01Z',
    image: null, imageSha256: null, is64Bit: null, observationError: 'process-query-unavailable',
    stoppedAt: null, exitStatus: null }]]) {
    const decoded = decode({ ...receipt(), powerShellChildren });
    assert.equal(decoded.capturedAndCancelled, true);
    assert.deepEqual(decoded.report.powerShellChildren, powerShellChildren);
  }
});

test('missing dialog, unverified cancellation, installed files/registration, drift and native error cannot pass', () => {
  for (const change of [{ firstDialog: null }, { cancelPosted: false }, { installerExited: false, installerExitCode: null },
    { firstDialog: { ...receipt().firstDialog, controls: [receipt().firstDialog.controls[0]] } },
    { defaultDirectoryAbsent: false }, { uninstallRegistrationAbsent: false }, { productRegistrationAbsent: false },
    { observerError: { type: 'System.InvalidOperationException', hresult: -1 } }, { installerBytesUnchanged: false },
    { error: { type: 'System.InvalidOperationException', hresult: -1 } }]) {
    assert.equal(decode({ ...receipt(), ...change }).capturedAndCancelled, false);
  }
});

test('wrong pin, foreign dialog/child, extra raw metadata, oversized captures and invented acceptance refuse', () => {
  for (const change of [{ installerSha256: 'b'.repeat(64) }, { installerBytes: 1 },
    { firstDialog: { ...receipt().firstDialog, processId: 9000 } },
    { powerShellChildren: [{ ...receipt().powerShellChildren[0], parentPid: 9000 }] },
    { powerShellChildren: [{ ...receipt().powerShellChildren[0], commandLine: 'DO-NOT-ECHO' }] },
    { powerShellChildren: [{ ...receipt().powerShellChildren[0], exitStatus: -1 }] },
    { powerShellChildren: [{ ...receipt().powerShellChildren[0], stoppedAt: null }] },
    { installerExited: false }, { freshNamespaceVerified: false },
    { firstDialog: { ...receipt().firstDialog, controls: Array(129).fill(receipt().firstDialog.controls[0]) } },
    { firstDialog: { ...receipt().firstDialog, controls: [{ ...receipt().firstDialog.controls[0], name: 'x'.repeat(8193) }] } },
    ...['installAccepted', 'releaseReady', 'installerRerun', 'processesKilled', 'originalNsExecReturnCaptured',
      'originalPowerShellModulesCaptured'].map(field => ({ [field]: true }))]) {
    assert.throws(() => decode({ ...receipt(), ...change }));
  }
  assert.throws(() => validateReceipt(Buffer.alloc(262145)));
});

test('fixed silent mode can capture exit 10 or 0 but cannot silently claim installation acceptance', () => {
  assert.deepEqual(MODES, ['first-dialog-cancel', 'silent-observe']);
  for (const installerExitCode of [0, 10]) {
    const decoded = decode({ ...silentReceipt(), installerExitCode, defaultDirectoryAbsent: false,
      uninstallRegistrationAbsent: installerExitCode !== 0 }, 'silent-observe');
    assert.equal(decoded.observationComplete, true);
    assert.equal(decoded.silentExitObserved, true);
    assert.equal(decoded.capturedAndCancelled, false);
    assert.equal(decoded.report.installAccepted, false);
    assert.equal(decoded.report.originalNsExecReturnCaptured, false);
    assert.equal(decoded.report.releaseReady, false);
  }
  for (const change of [{ installerExited: false, installerExitCode: null }, { installerBytesUnchanged: false },
    { error: { type: 'System.InvalidOperationException', hresult: -1 } },
    { observerError: { type: 'System.InvalidOperationException', hresult: -1 } }]) {
    assert.equal(decode({ ...silentReceipt(), ...change }, 'silent-observe').observationComplete, false);
  }
  assert.throws(() => decode(silentReceipt()));
  assert.throws(() => decode(receipt(), 'silent-observe'));
  assert.throws(() => decode({ ...silentReceipt(), cancelPosted: true }, 'silent-observe'));
  assert.throws(() => decode({ ...silentReceipt(), installAccepted: true }, 'silent-observe'));
});

test('custom diagnostic modes refuse before filesystem or any worker', async () => {
  for (const mode of ['/S', 'install', 'silent-observe /D=C:\\other', '', { mode: 'silent-observe' }]) {
    await assert.rejects(isolated().probe('never-inspected', mode));
  }
});

function fakeFiles({ modified = false, linked = false, bytes = PUBLIC_INSTALLER.bytes, report = receipt() } = {}) {
  let made = 0;
  const filesystem = {
    realpathSync: file => file,
    lstatSync: () => ({ isSymbolicLink: () => linked, isFile: () => true, nlink: 1, size: bytes }),
    readFileSync: file => file.endsWith('report.json') ? Buffer.from(JSON.stringify(report)) : Buffer.from('never executed'),
    mkdtempSync: prefix => { made++; return `${prefix}fixture`; }, existsSync: () => !modified,
  };
  return { filesystem, made: () => made };
}
const installer = path.resolve(__dirname, '../artifacts/public-fixture', PUBLIC_INSTALLER.asset);

test('unowned input, wrong name/size/SHA and links refuse before worker launch or output creation', async () => {
  for (const change of [{ file: path.resolve(__dirname, PUBLIC_INSTALLER.asset) },
    { file: `${installer}.modified` }, { bytes: 1 }, { linked: true }, { hash: 'b'.repeat(64) }]) {
    const fixture = fakeFiles(change);
    const api = isolated({ filesystem: fixture.filesystem, hash: change.hash });
    await assert.rejects(api.probe(change.file || installer));
    assert.equal(fixture.made(), 0);
  }
});

test('one hidden observer worker is launched with original environment; no installer arguments or retries', async () => {
  const fixture = fakeFiles({ bytes: PUBLIC_INSTALLER.bytes });
  fixture.filesystem.lstatSync = file => ({ isSymbolicLink: () => false, isFile: () => true, nlink: 1,
    size: file.endsWith('report.json') ? JSON.stringify(receipt()).length : PUBLIC_INSTALLER.bytes });
  const worker = new EventEmitter(); worker.unref = () => {};
  let calls = 0, deadline;
  const api = isolated({ filesystem: fixture.filesystem, spawn(program, args, options) {
    calls++; assert.match(program, /System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
    assert.equal(options.windowsHide, true); assert.equal(options.env, undefined); assert.equal(options.timeout, undefined);
    assert.equal(options.stdio, 'ignore'); assert.ok(Array.from(args).includes(installer));
    assert.equal(Array.from(args).some(arg => ['/S', '/UPDATE', '/NS'].includes(arg)), false);
    return worker;
  }, timeout: (_callback, ms) => { deadline = ms; return 1; } });
  const pending = api.probe(installer); worker.emit('close', 0);
  const result = await pending;
  assert.equal(calls, 1); assert.equal(deadline, 45000); assert.equal(result.capturedAndCancelled, true);
  assert.equal(result.observationComplete, true);
});

test('silent observer passes only fixed mode to its worker, keeps original environment and one bounded attempt', async () => {
  const report = silentReceipt();
  const fixture = fakeFiles({ report });
  fixture.filesystem.lstatSync = file => ({ isSymbolicLink: () => false, isFile: () => true, nlink: 1,
    size: file.endsWith('report.json') ? JSON.stringify(report).length : PUBLIC_INSTALLER.bytes });
  const worker = new EventEmitter(); worker.unref = () => {};
  let calls = 0, deadline;
  const api = isolated({ filesystem: fixture.filesystem, spawn(_program, args, options) {
    calls++; assert.equal(options.env, undefined); assert.equal(options.timeout, undefined);
    assert.deepEqual(Array.from(args).slice(-2), ['-Mode', 'silent-observe']);
    assert.equal(Array.from(args).includes('/S'), false);
    return worker;
  }, timeout: (_callback, ms) => { deadline = ms; return 1; } });
  const pending = api.probe(installer, 'silent-observe'); worker.emit('close', 0);
  const result = await pending;
  assert.equal(calls, 1); assert.equal(deadline, 195000);
  assert.equal(result.silentExitObserved, true); assert.equal(result.capturedAndCancelled, false);
});

test('worker observation expiration records incomplete evidence without killing or rerunning anything', async () => {
  const fixture = fakeFiles({ modified: true });
  const worker = new EventEmitter(); let expired, unreferenced = 0, calls = 0;
  worker.unref = () => { unreferenced++; }; worker.kill = () => assert.fail('No process kill permitted');
  const api = isolated({ filesystem: fixture.filesystem, spawn: () => { calls++; return worker; },
    timeout: callback => { expired = callback; return 1; } });
  const pending = api.probe(installer); expired();
  const result = await pending;
  assert.equal(result.workerObservationExpired, true); assert.equal(result.capturedAndCancelled, false);
  assert.equal(calls, 1); assert.equal(unreferenced, 1);
});

test('a successful-shaped receipt cannot mask observer failure or expiration', async () => {
  for (const expired of [false, true]) {
    const fixture = fakeFiles();
    fixture.filesystem.lstatSync = file => ({ isSymbolicLink: () => false, isFile: () => true, nlink: 1,
      size: file.endsWith('report.json') ? JSON.stringify(receipt()).length : PUBLIC_INSTALLER.bytes });
    const worker = new EventEmitter(); worker.unref = () => {}; let deadline;
    const api = isolated({ filesystem: fixture.filesystem, spawn: () => worker,
      timeout: callback => { deadline = callback; return 1; } });
    const pending = api.probe(installer);
    if (expired) deadline(); else worker.emit('close', 1);
    assert.equal((await pending).capturedAndCancelled, false);
  }
});

test('dedicated workflow admits only the fixed push tuple or input-free manual dispatch on separate fresh VMs', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/native-legacy-preflight-probe.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/); assert.match(workflow, /contents: read/);
  assert.match(workflow.replaceAll('\r\n', '\n'), /\non:\n  workflow_dispatch:\n  push:\n    branches: \[validation\/legacy-preflight-014\]\n    paths: \['\.github\/workflows\/native-legacy-preflight-probe\.yml'\]\npermissions:/);
  assert.match(workflow, /mode: \[first-dialog-cancel, silent-observe\]/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /runs-on: windows-latest/); assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /CREATOR_LEGACY_PREFLIGHT_PROBE: '1'/);
  assert.match(workflow, /PUBLIC_INSTALLER/); assert.match(workflow, /Get-FileHash.*SHA256/);
  assert.match(workflow, /native-legacy-preflight-probe\.cjs artifacts\/legacy-preflight-input\//);
  assert.match(workflow, /if: always\(\)/); assert.match(workflow, /artifacts\/legacy-preflight-\*\/report\.json/);
  assert.doesNotMatch(workflow, /secrets\.|GH_TOKEN|GITHUB_TOKEN|contents: write|continue-on-error|inputs:|cargo |Build-|workflow_call|schedule:|node.*\|.*Tee-Object/);
});

test('native source observes before starting, holds public bytes, and permits only Cancel then exact quit confirmation', () => {
  assert.ok(native.indexOf('foreach ($key in $admission.Keys)') < native.indexOf('Get-Item'));
  assert.ok(native.indexOf("Register-CimIndicationEvent -Namespace") < native.indexOf('[Diagnostics.Process]::Start($start)'));
  assert.match(native, /\[IO\.FileShare\]::Read\)/);
  assert.match(native, /\$image\.Length -ne \$receipt\.installerBytes/);
  assert.match(native, /id!=2 && id!=6/);
  assert.match(native, /\$cancel\.Count -ne 1 -or \$installerProcess\.HasExited/);
  assert.match(native, /\.Trim\(\) -ceq 'Cancel'/);
  assert.match(native, /\.Trim\(\) -ceq 'Yes'/);
  assert.match(native, /ParentProcessID -ne \$receipt\.installerPid/);
  assert.match(native, /\$started\.ProcessName -ine 'powershell\.exe'/);
  assert.match(native, /Are you sure you want to quit Creator Works MCP Setup\?/);
  assert.match(native, /\.HasExited/);
  assert.match(native, /installerBytesUnchanged =/);
  assert.match(native, /\[ValidateSet\('first-dialog-cancel', 'silent-observe'\)\]/);
  assert.match(native, /if \(\$Mode -ceq 'silent-observe'\) \{ \$start\.Arguments = '\/S' \}/);
  assert.equal((native.match(/\.Arguments\s*=/g) || []).length, 1);
  assert.match(native, /\$limit = if \(\$Mode -ceq 'silent-observe'\) \{180000\} else \{30000\}/);
  assert.match(native, /if \(\$Mode -ceq 'silent-observe'\) \{ Start-Sleep -Milliseconds 100; continue \}/);
  assert.match(native, /Win32_ProcessStopTrace WHERE ProcessName = 'powershell\.exe'/);
  assert.match(native, /\$receipt\.powerShellChildren \| Where-Object \{ \$_.pid -eq \[int\]\$stopped\.ProcessID \}/);
  assert.match(native, /\$child\[0\]\.exitStatus = \[long\]\$stopped\.ExitStatus/);
  assert.match(native, /GetProcessTimes/);
  assert.match(native, /created>startedBy/);
  assert.doesNotMatch(native, /Stop-Process|taskkill|TerminateProcess|\.Kill\(|CommandLine|\.ArgumentList|\/UPDATE|\/TIMEOUT|InstallFiles|InvokePattern/);
  assert.doesNotMatch(source, /\.kill\(|killSignal|execFileSync|process\.env\[[^\]]+\]\s*=/);
});
