const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { baselines, registrationArray, outputMetadata, errorMetadata, pinnedPreflight, parseProbeOutput,
  PREFLIGHT, CIM_DIAGNOSTIC, failureDiagnostics, readOnlyProbe } = require('./native-installed-baseline.cjs');
const diagnosticSource = fs.readFileSync(path.join(__dirname, 'native-installed-baseline.cjs'), 'utf8');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const originalScript = fs.readFileSync(path.resolve(__dirname, '..', PREFLIGHT.retainedPath));

function isolatedModule({ filesystem = fs, execute = () => assert.fail('No real command permitted'),
  spawn = () => assert.fail('No real process permitted'), time = () => 0,
  timeout = () => 1, clear = () => {}, wait = () => {} } = {}) {
  const module = { exports: {} };
  const context = { module, __dirname, __filename: path.join(__dirname, 'native-installed-baseline.cjs'), Buffer,
    process: { env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
      LOCALAPPDATA: path.resolve(__dirname, '../artifacts/virtual-local'), SystemRoot: path.resolve(__dirname, '../artifacts/virtual-windows') },
    platform: 'win32', execPath: 'owned-fixture-node', argv: [] }, performance: { now: time },
    setTimeout: timeout, clearTimeout: clear, SharedArrayBuffer, Int32Array, Atomics: { wait },
    require(name) {
      if (name === 'node:fs') return filesystem;
      if (name === 'node:child_process') return { execFileSync: execute, spawn };
      return require(name);
    },
  };
  vm.runInNewContext(diagnosticSource, context);
  return { api: module.exports, context };
}

test('original failure capture retains byte lengths/hashes but never error messages or raw output', () => {
  const secret = Buffer.from('DO-NOT-ECHO-AUTH-OR-ENV');
  const record = errorMetadata({ status: 10, code: 'ETIMEDOUT', signal: null, message: secret.toString(), stdout: secret, output: [null, null, Buffer.from('stderr')] });
  assert.equal(record.exitCode, 10); assert.equal(record.errorCode, 'ETIMEDOUT');
  assert.equal(record.stdout.capturedBytes, secret.length); assert.equal(record.stdout.sha256, hash(secret));
  assert.equal(record.stderr.capturedBytes, 6); assert.equal(JSON.stringify(record).includes(secret.toString()), false);
  const oversized = outputMetadata(Buffer.alloc(65537, 65));
  assert.equal(oversized.capturedBytes, 65537); assert.equal(oversized.hashCoversFullOutput, false);
  assert.equal(oversized.sha256, hash(Buffer.alloc(65536, 65)));
  assert.equal(outputMetadata(null).available, false);
});

test('retained preflight reconstructs exact pinned9cd12 bytes, not current same-name modified source', () => {
  const lf = pinnedPreflight(originalScript);
  assert.equal(lf.bytes.length, 3329); assert.equal(hash(lf.bytes), PREFLIGHT.sha256);
  assert.equal(lf.provenance.sourceCommit, '9cd12e28d1dd05057b84166d4718a5d6369eff93');
  const crlf = pinnedPreflight(Buffer.from(lf.bytes.toString().replace(/\n/g, '\r\n')));
  assert.equal(crlf.provenance.crlfNormalized, true); assert.ok(crlf.bytes.equals(lf.bytes));
  assert.throws(() => pinnedPreflight(Buffer.concat([lf.bytes, Buffer.from('# changed')])));
  const changed = Buffer.from(lf.bytes); changed[10] ^= 1;
  assert.throws(() => pinnedPreflight(changed), /Original preflight SHA differs/);
  assert.throws(() => pinnedPreflight(Buffer.alloc(65537)), /Bounded/);
  assert.doesNotMatch(lf.bytes.toString(), /Stop-Process|taskkill|\.Kill\(|WriteAll|Set-Item|FileMode\]::(?:Create|Truncate)/i);
});

test('post-failure preflight only classifies exact known messages; zero/unknown output cannot prove original busy', () => {
  for (const [message, expected] of [
    ['The selected MCP launcher or private runtime is still running.', 'selected-process-running'],
    ['An MCP file is locked by another process.', 'selected-file-locked'],
    ['Process or file-access verification failed. Check permissions and retry; no files were changed.', 'verification-unavailable'],
    ['', 'no-message'], ['DO-NOT-ECHO', 'unrecognized-output'],
  ]) {
    const result = parseProbeOutput(Buffer.from(`${message}\r\n`), 'preflight');
    assert.equal(result.classification, expected); assert.equal(JSON.stringify(result).includes('DO-NOT-ECHO'), false);
  }
});

test('CIM parser keeps explicit scoped rows and phase metadata, preserving empty versus unavailable', () => {
  const record = { pid: 123, name: 'node.exe', executablePath: null, startStamp: '2026-10-14T18:00:00.000Z' };
  const result = parseProbeOutput(Buffer.from(`CW_DIAG:entry\nCW_DIAG:before-cim\nCW_DIAG_PROCESSES=${JSON.stringify([record])}\nCW_DIAG:after-cim\n`), 'cim');
  assert.deepEqual(JSON.parse(JSON.stringify(result.records)), [record]);
  assert.deepEqual(result.phases, ['entry', 'before-cim', 'after-cim']);
  assert.deepEqual(parseProbeOutput(Buffer.from('CW_DIAG_PROCESSES=[]\n'), 'cim').records, []);
  assert.equal(parseProbeOutput(Buffer.from('CW_DIAG:entry\n'), 'cim').records, undefined);
  for (const records of [[{ ...record, commandLine: 'DO-NOT-ECHO' }], [{ ...record, name: 'foreign.exe' }], [{ ...record, executablePath: 'x'.repeat(4097) }]]) {
    const refused = parseProbeOutput(Buffer.from(`CW_DIAG_PROCESSES=${JSON.stringify(records)}\n`), 'cim');
    assert.equal(refused.outputRefused, true); assert.equal(JSON.stringify(refused).includes('DO-NOT-ECHO'), false);
  }
});

test('PowerShell metadata parser accepts only known command fields and bounded error types', () => {
  const metadata = { version: '5.1', edition: 'Desktop', pid: 99, psHome: 'C:/Windows/PowerShell', is64Bit: true,
    commands: ['Get-CimInstance', 'Join-Path'].map(name => ({ name, type: 'Cmdlet', source: 'Known module', version: '1.0', modulePath: 'C:/Windows/module.psd1', assemblyPath: 'C:/Windows/module.dll' })) };
  const result = parseProbeOutput(Buffer.from(`CW_DIAG_METADATA=${JSON.stringify(metadata)}\nCW_DIAG_ERROR={"type":"System.Exception","hresult":-1,"category":"InvalidOperation"}\n`), 'cim');
  assert.deepEqual(JSON.parse(JSON.stringify(result.metadata)), metadata); assert.equal(result.error.hresult, -1);
  const refused = parseProbeOutput(Buffer.from(`CW_DIAG_METADATA=${JSON.stringify({ ...metadata, env: 'DO-NOT-ECHO' })}\n`), 'cim');
  assert.equal(refused.outputRefused, true); assert.equal(JSON.stringify(refused).includes('DO-NOT-ECHO'), false);
});

test('new diagnostics refuse local execution before any source/output/process inspection', async () => {
  assert.throws(() => failureDiagnostics({}, baselines[1], 'never-inspected'), /restricted to a disposable/);
  await assert.rejects(readOnlyProbe('never-launched', [], 'preflight'), /restricted to a disposable/);
});

test('owned native probe records actual exit, bytes and EOF without echoing raw stdout/stderr', async () => {
  const child = new EventEmitter(); child.pid = 77; child.unref = () => {};
  for (const name of ['stdout', 'stderr']) { child[name] = new EventEmitter(); child[name].destroy = () => {}; }
  let timeoutMs;
  const { api } = isolatedModule({ spawn: (program, args, options) => {
    assert.equal(program, 'fixture-native-powershell'); assert.equal(options.windowsHide, true);
    assert.equal(options.env, undefined); assert.equal(options.timeout, undefined); return child;
  }, timeout: (_callback, ms) => { timeoutMs = ms; return 1; } });
  const pending = api.readOnlyProbe('fixture-native-powershell', [], 'preflight');
  child.stdout.emit('data', Buffer.from('An MCP file is locked by another process.\r\n'));
  child.stderr.emit('data', Buffer.from('DO-NOT-ECHO'));
  child.stdout.emit('end'); child.stderr.emit('end'); child.emit('exit', 10, null); child.emit('close');
  const result = await pending;
  assert.equal(timeoutMs, 15000); assert.equal(result.exitCode, 10); assert.equal(result.pid, 77);
  assert.equal(result.stdout.eof, true); assert.equal(result.stderr.eof, true);
  assert.equal(result.stderr.observedBytes, 11); assert.equal(result.classification, 'selected-file-locked');
  assert.equal(JSON.stringify(result).includes('DO-NOT-ECHO'), false);
});

test('deadline distinguishes a still-running probe from exited child with undrained pipes; never kills/retries', async () => {
  for (const exited of [false, true]) {
    const child = new EventEmitter(); child.pid = 78; let unref = 0, deadline;
    child.unref = () => { unref++; }; child.kill = () => assert.fail('No diagnostic kill');
    for (const name of ['stdout', 'stderr']) { child[name] = new EventEmitter(); child[name].destroy = () => {}; }
    let time = 0, launches = 0;
    const { api } = isolatedModule({ spawn: () => { launches++; return child; }, time: () => time,
      timeout: callback => { deadline = callback; return 1; } });
    const pending = api.readOnlyProbe('fixture-native-powershell', [], 'cim');
    child.stdout.emit('data', Buffer.from('CW_DIAG:entry\n'));
    if (exited) child.emit('exit', 0, null);
    time = 15000; deadline();
    const result = await pending;
    assert.equal(result.deadlineReached, true); assert.equal(result.elapsedMs, 15000);
    assert.equal(result.exitCode, exited ? 0 : null); assert.equal(result.stdout.eof, false); assert.equal(result.stderr.eof, false);
    assert.equal(launches, 1); assert.equal(unref, 1); assert.deepEqual(Array.from(result.phases), ['entry']);
  }
});

test('diagnostic source retains original install deadline/env and performs only failure-specific scoped probes', () => {
  assert.match(diagnosticSource, /try \{ execFileSync\(installer, \['\/S'\], \{ windowsHide: true, timeout: 180000, stdio: 'pipe' \}\); \}/);
  assert.equal((diagnosticSource.match(/failureDiagnostics\(error, b, out\)/g) || []).length, 1);
  assert.match(diagnosticSource, /catch \(diagnosticError\).*original: errorMetadata\(error\)/);
  assert.match(diagnosticSource, /catch \(writeError\).*error.baselineReportWriteError/);
  assert.match(diagnosticSource, /throw error;/);
  assert.match(diagnosticSource, /2 \* DIAGNOSTIC_TIMEOUT \+ 2000/);
  assert.match(diagnosticSource, /result\.partial\.json/); assert.match(diagnosticSource, /fs\.renameSync\(partial/);
  assert.match(diagnosticSource, /post-failure-read-only-not-original-nsExec-trace/);
  assert.match(diagnosticSource, /originalNsExecTraceCaptured: false/);
  assert.match(diagnosticSource, /chosenShellIs64Bit: cim\.metadata\?\.is64Bit \?\? null/);
  assert.match(diagnosticSource, /originalNsExecShellBitnessVerified: false/);
  assert.doesNotMatch(diagnosticSource, /originalNsExecShellBitnessVerified: true/);
  assert.match(CIM_DIAGNOSTIC, /-Property ProcessId,Name,ExecutablePath,CreationDate -OperationTimeoutSec 8/);
  assert.match(CIM_DIAGNOSTIC, /Get-Command -Name Get-CimInstance,Join-Path/);
  assert.doesNotMatch(CIM_DIAGNOSTIC, /CommandLine|\.Definition|\$env:|Stop-Process|taskkill|\.Kill\(|Get-Content/i);
  assert.doesNotMatch(diagnosticSource, /child\.kill|worker\.kill|killSignal|env_clear|\.env\s*=|process\.env\[[^\]]+\]\s*=/);
});

test('diagnostic and report-write failures preserve the same original installer exception, without another install/seed', () => {
  for (const writeFails of [false, true]) {
    const original = Object.assign(Error('Original installer refusal'), { status: 10,
      stdout: Buffer.from('DO-NOT-ECHO-ORIGINAL'), stderr: Buffer.alloc(0) });
    const installerBytes = Buffer.from('synthetic never-executed installer');
    let report, installerCalls = 0, seedCalls = 0, diagnosticReads = 0;
    const filesystem = {
      existsSync: () => false, mkdirSync: () => {},
      readFileSync: file => file.endsWith('-setup.exe') ? installerBytes : Buffer.from('synthetic GUI'),
      realpathSync: () => { diagnosticReads++; throw Object.assign(Error('Bounded diagnostic fixture unavailable'), { code: 'EACCES' }); },
      writeFileSync(file, bytes) {
        assert.ok(file.endsWith('installed-baseline.json'));
        if (writeFails) throw Object.assign(Error('Report unavailable'), { code: 'EACCES' });
        report = JSON.parse(bytes);
      },
    };
    const { api } = isolatedModule({ filesystem, execute: (program, args, options) => {
      if (program === 'gh') return '';
      assert.ok(program.endsWith('-setup.exe')); assert.deepEqual(Array.from(args), ['/S']);
      assert.equal(options.timeout, 180000); assert.equal(options.env, undefined);
      installerCalls++;
      if (program.includes('Creator.Works.MCP')) throw original;
      return '';
    } });
    // Change only the isolated module's synthetic pins, never public source inputs.
    for (const baseline of api.baselines) baseline.sha256 = hash(installerBytes);
    assert.throws(() => api.install('upgrade', 'never-reached-candidate', path.resolve(__dirname, '../artifacts/virtual-suite'), () => { seedCalls++; }), error => error === original);
    assert.equal(installerCalls, 2); assert.equal(seedCalls, 0); assert.equal(diagnosticReads, 1);
    if (writeFails) assert.equal(original.baselineReportWriteError.errorCode, 'EACCES');
    else {
      assert.equal(report.exitCode, 10); assert.equal(report.failedInstaller, 'Creator Works MCP');
      assert.equal(report.failureDiagnostics.original.stdout.capturedBytes, original.stdout.length);
      assert.equal(report.failureDiagnostics.originalNsExecShellBitnessVerified, false);
      assert.equal(report.failureDiagnostics.diagnosticError.errorCode, 'EACCES');
      assert.equal(report.creatorProcesses, null); assert.equal(JSON.stringify(report).includes('DO-NOT-ECHO'), false);
    }
  }
});

test('installed candidate helper refuses local and self-hosted runners before filesystem access', () => {
  for (const env of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_OS: 'Windows' }]) {
    const result = spawnSync(process.execPath, ['-e', "require('./scripts/native-installed-baseline.cjs').install('upgrade','missing','missing')"], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restricted to a disposable GitHub-hosted Windows runner/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  }
});
test('installed acceptance pins all three public installers and separates direct install from signed update', () => {
  assert.deepEqual(baselines.map(b => b.version), ['0.1.12', '2.7.7', '0.3.7']);
  for (const baseline of baselines) assert.match(baseline.sha256, /^[a-f0-9]{64}$/);
  const source = fs.readFileSync(path.join(__dirname, 'native-installed-baseline.cjs'), 'utf8');
  assert.match(source, /not signed in-app updater acceptance/);
  assert.ok(source.indexOf('seedBeforeInstall();') < source.indexOf('execFileSync(installer, installerArguments', source.indexOf('seedBeforeInstall();')));
});

test('PowerShell registration arrays preserve empty, one and three item counts', { skip: process.platform !== 'win32' }, () => {
  for (const names of [[], ['Creator Hub'], baselines.map(b => b.product)]) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', `$items=${registrationArray(names)}; $items.Count`], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(Number(result.stdout.trim()), names.length);
  }
  assert.throws(() => registrationArray(['unknown']), /Unknown registration/);
});

test('native migration dialog buttons are allowlisted without relaxing process or title checks', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-window.ps1'), 'utf8');
  assert.match(source, /'Move connection' = @\('Review existing MCP connection'\)/);
  assert.ok(source.includes("'Keep existing' = @('Review existing MCP connection', 'Review existing MCP connections', 'Keep MCP settings working in Hub', 'Move to unified Creator Hub', 'Retire standalone Creator apps')"));
  for (const [button, title] of [['Back up and continue', 'Move to unified Creator Hub'],
    ['Move selected connections', 'Review existing MCP connections'],
    ['Move server path', 'Keep MCP settings working in Hub'], ['Finish migration', 'Retire standalone Creator apps']]) {
    assert.ok(source.includes(`'${button}' = @('${title}')`));
  }
  assert.match(source, /window.Current.Name -cnotin \$titles\[\$Value\]/);
  assert.match(source, /ProcessId\(\$dialog\) -ne \$TargetPid/);
});

test('migration acceptance parses TOML and compares real paths rather than encoded source strings', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-builtin-smoke.cjs'), 'utf8');
  assert.match(source, /tomllib.load/);
  assert.match(source, /verifyMigratedTarget\(entry, descriptor, report.runtimeGeneration, process.env.LOCALAPPDATA\)/);
  const targets = fs.readFileSync(path.join(__dirname, 'native-managed-target.cjs'), 'utf8');
  assert.match(targets, /fs.realpathSync\(entry.command\)/);
  assert.match(targets, /assert.deepEqual\(entry.args, \[\]/);
  assert.doesNotMatch(source, /content.includes\(report.runtimeGeneration/);
});

test('upgrade acceptance executes the actual guarded NSIS update arguments', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-installed-baseline.cjs'), 'utf8');
  assert.match(source, /mode === 'upgrade' \? \['\/UPDATE', '\/S', '\/NS'\] : \['\/S'\]/);
  assert.match(source, /execFileSync\(installer, installerArguments/);
  assert.match(source, /report.installerScope = mode === 'upgrade' \? 'guarded-nsis-update-default-location-no-msi'/);
});

test('installed migration coverage keeps Setup/legacy settings and includes the Desktop adapter', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-builtin-smoke.cjs'), 'utf8');
  assert.match(source, /'banter-mcp', 'launcher-config.json'/);
  assert.match(source, /'CreatorProjectSetup', 'editor-roots.json'/);
  assert.match(source, /id: 'claudeDesktop'.*'Claude', 'claude_desktop_config.json'/);
  assert.match(source, /verifyRetainedStores\('Real installer'\)/);
  assert.match(source, /verifyRetainedStores\(`\$\{app\} consent declined`\)/);
  assert.match(source, /verifyRetainedStores\(`\$\{app\} embedded operation`\)/);
  assert.match(source, /verifyRetainedStores\('Closing module views'\)/);
  assert.match(source, /verifyRetainedStores\('Failed payload and recovered retry'\)/);
  assert.match(source, /fresh profiles remain absent/);
});

test('built-in installation refusal retries only the exact startup busy response with a deadline', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-builtin-smoke.cjs'), 'utf8');
  const probe = source.slice(source.indexOf('  let denied;'), source.indexOf("  report.checks.push('Separate module installation"));
  assert.match(probe, /if \(denied !== 'Another Hub operation is already running\.'\) break;/);
  assert.match(probe, /Date.now\(\) < installationProbeDeadline/);
  assert.match(probe, /assert.match\(denied, \/built into this Hub\//);
  assert.doesNotMatch(probe, /catch|continue-on-error|\.includes\('operation'\)/);
});
