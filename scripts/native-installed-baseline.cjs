const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

const baselines = [
  { product: 'Creator Hub', repo: 'CREATOR-HUB', version: '0.1.12', asset: 'Creator.Hub_0.1.12_x64-setup.exe', sha256: '0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18', binary: 'creator-hub.exe' },
  { product: 'Creator Works MCP', repo: 'CREATOR-WORKS-UNITY-MCP', version: '2.7.7', asset: 'Creator.Works.MCP_2.7.7_x64-setup.exe', sha256: 'fa0b0ebc39043bf276de73763d380c001c84d1efd24dca9f9c2427b120a5afe0', binary: 'creator-works-mcp-launcher.exe' },
  { product: 'Creator Project Setup', repo: 'CREATOR-PROJECT-SETUP', version: '0.3.7', asset: 'Creator.Project.Setup_0.3.7_x64-setup.exe', sha256: '223bbc00bf7f861efe1760310a4be4cbedfc9829c4d3841fae0a84038bc7e47b', binary: 'creator-project-setup.exe' },
];
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const PREFLIGHT = Object.freeze({ sourceCommit: '9cd12e28d1dd05057b84166d4718a5d6369eff93',
  sourcePath: 'launcher/src-tauri/windows/installer-preflight.ps1',
  retainedPath: 'modules/mcp/launcher/src-tauri/windows/installer-preflight.ps1',
  size: 3329, sha256: '42858c4e86296fcdf966b170e946063cdf91c59c9341e8fdb7783d96ec737000' });
const DIAGNOSTIC_TIMEOUT = 15000, OUTPUT_LIMIT = 65536, RECEIPT_LIMIT = 256 * 1024;
const PROCESS_NAMES = ['node.exe', 'node', 'creator-hub.exe', 'creator-works-mcp-launcher.exe',
  'creator-project-setup.exe', 'bantworks-mcp-launcher.exe', 'banter-mcp-launcher.exe'];
const CIM_DIAGNOSTIC = String.raw`$ErrorActionPreference='Stop'
Write-Output 'CW_DIAG:entry'
try {
  Write-Output 'CW_DIAG:before-command'
  $commands=@(Get-Command -Name Get-CimInstance,Join-Path -ErrorAction Stop)
  $metadata=[ordered]@{version=$PSVersionTable.PSVersion.ToString(); edition=[string]$PSVersionTable.PSEdition; pid=$PID; psHome=$PSHOME; is64Bit=[Environment]::Is64BitProcess; commands=@($commands | ForEach-Object { [ordered]@{name=$_.Name; type=[string]$_.CommandType; source=$_.Source; version=[string]$_.Version; modulePath=$_.Module.Path; assemblyPath=$_.ImplementingType.Assembly.Location} })}
  Write-Output ('CW_DIAG_METADATA='+(ConvertTo-Json -InputObject $metadata -Depth 6 -Compress))
  Write-Output 'CW_DIAG:after-command'
  if (@($commands | Where-Object { $_.CommandType -ne 'Cmdlet' -or ($_.Name -eq 'Get-CimInstance' -and $_.Source -ne 'CimCmdlets') -or ($_.Name -eq 'Join-Path' -and $_.Source -ne 'Microsoft.PowerShell.Management') }).Count -ne 0) { throw 'Unexpected native command metadata.' }
  Write-Output 'CW_DIAG:before-cim'
  $processes=@(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe' OR Name = 'node' OR Name = 'creator-hub.exe' OR Name = 'creator-works-mcp-launcher.exe' OR Name = 'creator-project-setup.exe' OR Name = 'bantworks-mcp-launcher.exe' OR Name = 'banter-mcp-launcher.exe'" -Property ProcessId,Name,ExecutablePath,CreationDate -OperationTimeoutSec 8 -ErrorAction Stop)
  if ($processes.Count -gt 128) { throw 'Process diagnostic exceeds its bound.' }
  $records=@($processes | Sort-Object ProcessId | ForEach-Object { [ordered]@{pid=$_.ProcessId; name=$_.Name; executablePath=$_.ExecutablePath; startStamp=if ($null -eq $_.CreationDate) {$null} else {$_.CreationDate.ToUniversalTime().ToString('o')} } })
  Write-Output ('CW_DIAG_PROCESSES='+(ConvertTo-Json -InputObject $records -Depth 4 -Compress))
  Write-Output 'CW_DIAG:after-cim'
  exit 0
} catch {
  Write-Output ('CW_DIAG_ERROR='+(ConvertTo-Json -InputObject @{type=$_.Exception.GetType().FullName; hresult=$_.Exception.HResult; category=[string]$_.CategoryInfo.Category} -Compress))
  exit 11
}
`;
const PREFLIGHT_MESSAGES = new Map([
  ['The selected MCP launcher or private runtime is still running.', 'selected-process-running'],
  ['Windows did not reveal a candidate process path; Setup cannot safely rule out this MCP runtime.', 'candidate-path-unavailable'],
  ['An MCP file is locked by another process.', 'selected-file-locked'],
  ['Process or file-access verification failed. Check permissions and retry; no files were changed.', 'verification-unavailable'],
]);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function outputMetadata(value) {
  if (!Buffer.isBuffer(value) && typeof value !== 'string') return { available: false, capturedBytes: null };
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return { available: true, capturedBytes: bytes.length, sha256: digest(bytes.subarray(0, OUTPUT_LIMIT)), hashCoversFullOutput: bytes.length <= OUTPUT_LIMIT };
}
function errorMetadata(error) {
  return { exitCode: Number.isInteger(error?.status) ? error.status : null,
    errorCode: /^[A-Z0-9_]{1,32}$/.test(error?.code || '') ? error.code : null,
    signal: /^SIG[A-Z0-9]{1,16}$/.test(error?.signal || '') ? error.signal : null,
    stdout: outputMetadata(error?.stdout ?? error?.output?.[1]), stderr: outputMetadata(error?.stderr ?? error?.output?.[2]) };
}
function pinnedPreflight(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length <= OUTPUT_LIMIT, 'Bounded retained preflight required');
  // Git checkouts may use CRLF. Execute only the resulting exact original LF bytes.
  const original = Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'));
  assert.equal(original.length, PREFLIGHT.size, 'Original preflight size differs');
  assert.equal(digest(original), PREFLIGHT.sha256, 'Original preflight SHA differs');
  return { bytes: original, provenance: { ...PREFLIGHT, checkoutSha256: digest(bytes), crlfNormalized: !bytes.equals(original) } };
}
function parseProbeOutput(bytes, kind) {
  const text = bytes.toString('utf8');
  if (kind === 'preflight') return { classification: text.trim() === '' ? 'no-message' : PREFLIGHT_MESSAGES.get(text.trim()) || 'unrecognized-output' };
  const result = { phases: [] };
  const keys = (value, expected) => assert.deepEqual(Object.keys(value).sort(), expected.split(' ').sort());
  const string = value => assert.ok(typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f]/.test(value));
  try {
    for (const line of text.split(/\r?\n/)) {
      if (/^CW_DIAG:(entry|before-command|after-command|before-cim|after-cim)$/.test(line)) result.phases.push(line.slice(8));
      else if (line.startsWith('CW_DIAG_METADATA=')) {
        assert.equal(result.metadata, undefined);
        const value = JSON.parse(line.slice(17)); keys(value, 'version edition pid psHome is64Bit commands');
        for (const name of ['version', 'edition', 'psHome']) string(value[name]);
        assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.is64Bit === 'boolean');
        assert.ok(Array.isArray(value.commands) && value.commands.length === 2);
        for (const command of value.commands) {
          keys(command, 'name type source version modulePath assemblyPath');
          assert.ok(['Get-CimInstance', 'Join-Path'].includes(command.name));
          for (const name of Object.keys(command)) { if (command[name] !== null) string(command[name]); }
        }
        result.metadata = value;
      } else if (line.startsWith('CW_DIAG_PROCESSES=')) {
        assert.equal(result.records, undefined);
        const values = JSON.parse(line.slice(18)); assert.ok(Array.isArray(values) && values.length <= 128);
        for (const value of values) {
          keys(value, 'pid name executablePath startStamp');
          assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0 && PROCESS_NAMES.includes(value.name));
          if (value.executablePath !== null) string(value.executablePath);
          if (value.startStamp !== null) { string(value.startStamp); assert.ok(Number.isFinite(Date.parse(value.startStamp))); }
        }
        result.records = values;
      } else if (line.startsWith('CW_DIAG_ERROR=')) {
        assert.equal(result.error, undefined);
        const value = JSON.parse(line.slice(14)); keys(value, 'type hresult category');
        assert.ok(/^[A-Za-z0-9_.]{1,256}$/.test(value.type) && /^[A-Za-z]{1,64}$/.test(value.category) && Number.isInteger(value.hresult));
        result.error = value;
      } else if (line) throw Error('Unrecognized diagnostic output');
    }
    assert.ok(result.phases.length <= 5 && new Set(result.phases).size === result.phases.length);
    return result;
  } catch { return { phases: result.phases.slice(0, 5), outputRefused: true }; }
}
function readDiagnostic(file, limit, systemFile = false) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && (systemFile || stat.nlink === 1) && stat.size <= limit, 'Ordinary bounded diagnostic file required');
  return fs.readFileSync(file);
}
function ownedDiagnosticOutput(out) {
  const artifacts = fs.realpathSync(path.resolve(__dirname, '../artifacts'));
  const relative = path.relative(artifacts, path.resolve(out));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Owned diagnostic output required');
  for (let part = path.resolve(out);; part = path.dirname(part)) {
    assert.equal(fs.lstatSync(part).isSymbolicLink(), false, 'Redirected diagnostic output refused');
    if (path.relative(artifacts, part) === '') break;
    assert.notEqual(path.dirname(part), part, 'Diagnostic ancestor escaped its artifact root');
  }
  return fs.realpathSync(out);
}
function diagnosticFixture(request) {
  const artifacts = fs.realpathSync(path.resolve(__dirname, '../artifacts'));
  const fixture = fs.realpathSync(path.dirname(request));
  const relative = path.relative(artifacts, fixture);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    && path.basename(fixture).startsWith('baseline-diagnostic-'), 'Owned diagnostic fixture required');
  assert.equal(path.basename(request), 'request.json');
  return fixture;
}
async function readOnlyProbe(program, args, kind) {
  requireDisposable();
  const started = performance.now();
  return new Promise(resolve => {
    let child, timer, done = false, exitCode = null, signal = null, errorCode = null;
    const streams = { stdout: { bytes: 0, chunks: [], retained: 0, eof: false }, stderr: { bytes: 0, chunks: [], retained: 0, eof: false } };
    function finish(deadlineReached) {
      if (done) return; done = true; clearTimeout(timer);
      const output = Object.fromEntries(Object.entries(streams).map(([name, value]) => [name, {
        observedBytes: value.bytes, retainedBytes: value.retained, sha256: digest(Buffer.concat(value.chunks)), eof: value.eof, truncated: value.bytes > value.retained } ]));
      const receipt = { kind, pid: child?.pid || null, exitCode, signal, errorCode, deadlineReached,
        elapsedMs: Math.round(performance.now() - started), ...output, ...parseProbeOutput(Buffer.concat(streams.stdout.chunks), kind) };
      // A deadline stops observation, not a process. Never kill or retry a probe.
      child?.unref(); child?.stdout?.destroy(); child?.stderr?.destroy(); resolve(receipt);
    }
    try {
      child = spawn(program, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const [name, state] of Object.entries(streams)) {
        child[name].on('data', chunk => {
          state.bytes += chunk.length; const retain = Math.min(chunk.length, OUTPUT_LIMIT - state.retained);
          if (retain) { state.chunks.push(chunk.subarray(0, retain)); state.retained += retain; }
        });
        child[name].on('end', () => { state.eof = true; });
        child[name].on('error', () => { errorCode = 'PIPE_READ_ERROR'; });
      }
      child.on('exit', (code, value) => { exitCode = code; signal = value; });
      child.on('error', error => { errorCode = errorMetadata(error).errorCode; finish(false); });
      child.on('close', () => finish(false));
      timer = setTimeout(() => finish(true), DIAGNOSTIC_TIMEOUT);
    } catch (error) { errorCode = errorMetadata(error).errorCode; finish(false); }
  });
}
async function diagnosticWorker(request) {
  requireDisposable();
  assert.equal(process.platform, 'win32', 'Native Windows diagnostic required');
  const fixture = diagnosticFixture(request);
  const expected = { product: baselines[1].product, installerSha256: baselines[1].sha256, scriptSha256: PREFLIGHT.sha256 };
  assert.deepEqual(JSON.parse(readDiagnostic(request, 4096)), expected, 'Original diagnostic binding differs');
  const script = path.join(fixture, 'original-preflight.ps1');
  assert.equal(digest(readDiagnostic(script, PREFLIGHT.size)), PREFLIGHT.sha256);
  const program = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  assert.ok(path.isAbsolute(program) && !program.startsWith('\\\\') && !/[\x00-\x1f]/.test(program));
  const programSha256 = digest(readDiagnostic(program, 32 * 1024 * 1024, true));
  const prefix = ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass'];
  const installDir = path.join(process.env.LOCALAPPDATA, baselines[1].product);
  const preflight = await readOnlyProbe(program, [...prefix, '-File', script, '-InstallDir', `${installDir}\\.`], 'preflight');
  const cim = await readOnlyProbe(program, [...prefix, '-Command', CIM_DIAGNOSTIC], 'cim');
  const receipt = { scope: 'post-failure-read-only-not-original-nsExec-trace', program, programSha256,
    scriptSha256: digest(readDiagnostic(script, PREFLIGHT.size)), cimScriptSha256: digest(Buffer.from(CIM_DIAGNOSTIC)),
    preflight, cim, originalNsExecTraceCaptured: false,
    chosenShellIs64Bit: cim.metadata?.is64Bit ?? null, originalNsExecShellBitnessVerified: false,
    preflightAccess: 'Original Open/ReadWrite/None overwrite-access reservation; no write or truncate',
    installerRerun: false, processesKilled: false, environmentChanged: false };
  const partial = path.join(fixture, 'result.partial.json');
  fs.writeFileSync(partial, JSON.stringify(receipt), { flag: 'wx' });
  fs.renameSync(partial, path.join(fixture, 'result.json'));
}
function failureDiagnostics(error, baseline, out) {
  requireDisposable();
  const result = { original: errorMetadata(error), interpretation: 'NSIS exit 10 is not proof of busy; original preflight cause and shell context are unknown',
    originalNsExecShellBitnessVerified: false, releaseReady: false };
  if (baseline.product !== baselines[1].product) return { ...result, probeSkipped: 'No reviewed preflight replay for this baseline' };
  try {
    assert.equal(process.platform, 'win32', 'Native Windows diagnostic required');
    const fixture = fs.mkdtempSync(path.join(ownedDiagnosticOutput(out), 'baseline-diagnostic-'));
    result.fixture = path.relative(out, fixture);
    const request = path.join(fixture, 'request.json'); diagnosticFixture(request);
    const pinned = pinnedPreflight(readDiagnostic(path.resolve(__dirname, '..', PREFLIGHT.retainedPath), OUTPUT_LIMIT));
    result.source = pinned.provenance;
    fs.writeFileSync(path.join(fixture, 'original-preflight.ps1'), pinned.bytes, { flag: 'wx' });
    fs.writeFileSync(request, JSON.stringify({ product: baselines[1].product, installerSha256: baselines[1].sha256, scriptSha256: PREFLIGHT.sha256 }), { flag: 'wx' });
    const worker = spawn(process.execPath, [__filename, '--baseline-failure-diagnostics', request], { windowsHide: true, stdio: 'ignore' });
    worker.on('error', () => {}); worker.unref();
    result.workerPid = worker.pid || null;
    if (!worker.pid) return { ...result, workerReceipt: null, workerSpawned: false };
    const receipt = path.join(fixture, 'result.json'), wait = new Int32Array(new SharedArrayBuffer(4));
    // Callers remain synchronous; only this owned worker writes the bounded receipt.
    const started = performance.now(), deadline = started + 2 * DIAGNOSTIC_TIMEOUT + 2000;
    while (!fs.existsSync(receipt) && performance.now() < deadline) Atomics.wait(wait, 0, 0, 25);
    result.elapsedMs = Math.round(performance.now() - started);
    result.workerReceipt = fs.existsSync(receipt) ? JSON.parse(readDiagnostic(receipt, RECEIPT_LIMIT)) : null;
    result.workerDeadlineReached = result.workerReceipt === null;
  } catch (diagnosticError) { result.diagnosticError = errorMetadata(diagnosticError); }
  return result;
}
function registrationArray(names) {
  assert.ok(names.every(name => baselines.some(b => b.product === name)), 'Unknown registration');
  return `@(${names.map(name => `'${name.replaceAll("'", "''")}'`).join(',')})`;
}
function requireDisposable() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Windows') {
    throw Error('Installed unified acceptance is restricted to a disposable GitHub-hosted Windows runner.');
  }
}
function install(mode, candidate, out, seedBeforeInstall = () => {}) {
  requireDisposable();
  assert.ok(['fresh', 'upgrade'].includes(mode), 'Unknown installed acceptance mode');
  const installs = baselines.map(b => ({ ...b, directory: path.join(process.env.LOCALAPPDATA, b.product) }));
  for (const b of installs) assert.equal(fs.existsSync(b.directory), false, 'Runner must start without Creator installs');
  const report = { mode, scope: 'Direct unsigned candidate installation/reinstallation, not signed in-app updater acceptance', baselines: [] };
  if (mode === 'upgrade') {
    for (const b of installs) {
      const downloads = path.join(out, b.repo); fs.mkdirSync(downloads);
      execFileSync('gh', ['release', 'download', `v${b.version}`, '--repo', `BOBWORKS-XR/${b.repo}`, '--pattern', b.asset, '--dir', downloads], { windowsHide: true, timeout: 120000, stdio: 'pipe' });
      const installer = path.join(downloads, b.asset);
      assert.equal(sha256(installer), b.sha256, 'Published baseline installer changed');
      try { execFileSync(installer, ['/S'], { windowsHide: true, timeout: 180000, stdio: 'pipe' }); }
      catch (error) {
        report.failedInstaller = b.product;
        report.failedInstallerSha256 = b.sha256;
        report.exitCode = error.status ?? null; report.errorCode = error.code ?? null; report.signal = error.signal ?? null;
        try { report.failureDiagnostics = failureDiagnostics(error, b, out); }
        catch (diagnosticError) { report.failureDiagnostics = { original: errorMetadata(error), diagnosticError: errorMetadata(diagnosticError), originalNsExecShellBitnessVerified: false }; }
        report.creatorProcesses = report.failureDiagnostics.workerReceipt?.cim?.records ?? null;
        try { fs.writeFileSync(path.join(out, 'installed-baseline.json'), JSON.stringify(report, null, 2)); }
        catch (writeError) { error.baselineReportWriteError = errorMetadata(writeError); }
        throw error;
      }
      b.before = sha256(path.join(b.directory, b.binary));
      report.baselines.push({ product: b.product, version: b.version, installerSha256: b.sha256, executableSha256: b.before });
    }
  }
  fs.writeFileSync(path.join(out, 'installed-baseline.json'), JSON.stringify(report, null, 2));
  seedBeforeInstall();
  const metadata = JSON.parse(fs.readFileSync(path.join(candidate, 'installer-checksum.json')));
  assert.equal(metadata.acceptanceOnly, true); assert.equal(metadata.signed, false);
  const installer = path.join(candidate, 'installer.exe');
  assert.equal(sha256(installer), metadata.sha256);
  const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'builtin-manifest.json')));
  const expectedExecutable = require('./installer-payload.cjs').extract(installer, path.join(out, 'expected-installer-payload'), path.join(candidate, 'creator-hub.exe'), manifest);
  if (metadata.installedExecutableSha256) assert.equal(sha256(expectedExecutable), metadata.installedExecutableSha256);
  const installerArguments = mode === 'upgrade' ? ['/UPDATE', '/S', '/NS'] : ['/S'];
  execFileSync(installer, installerArguments, { windowsHide: true, timeout: 180000, stdio: 'pipe' });
  report.installerArguments = installerArguments;
  report.installerScope = mode === 'upgrade' ? 'guarded-nsis-update-default-location-no-msi' : 'fresh-nsis-default-location';
  const directory = installs[0].directory;
  assert.equal(sha256(path.join(directory, 'creator-hub.exe')), sha256(expectedExecutable), 'Installed Hub must match the exact packaged candidate');
  if (mode === 'upgrade') {
    assert.notEqual(sha256(path.join(directory, 'creator-hub.exe')), installs[0].before, 'The published Hub must actually have been replaced');
    for (const b of installs.slice(1)) assert.equal(sha256(path.join(b.directory, b.binary)), b.before, 'Legacy app must not be silently replaced or uninstalled');
  }
  report.candidateInstallerSha256 = metadata.sha256;
  report.installedHubSha256 = sha256(path.join(directory, 'creator-hub.exe'));
  report.passed = true;
  fs.writeFileSync(path.join(out, 'installed-baseline.json'), JSON.stringify(report, null, 2));
  return { directory, expectedRegistrations: mode === 'upgrade' ? installs.map(b => b.product) : ['Creator Hub'], oldMcp: installs[1].directory };
}
module.exports = { install, requireDisposable, baselines, registrationArray, outputMetadata, errorMetadata,
  pinnedPreflight, parseProbeOutput, PREFLIGHT, CIM_DIAGNOSTIC, readOnlyProbe, failureDiagnostics };
if (require.main === module && process.argv[2] === '--baseline-failure-diagnostics') {
  diagnosticWorker(process.argv[3]).catch(() => { process.exitCode = 1; });
}
