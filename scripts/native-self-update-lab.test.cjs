// Portable/static tests and deliberately refused local invocations only. No live VM flag trio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

const helper = path.join(__dirname, 'native-self-update-lab.ps1');
const source = fs.readFileSync(helper, 'utf8');
const bootstrap = source.match(/\$proxyBootstrap = @'\r?\n([\s\S]*?)\r?\n'@/)[1];
const runner = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows' };
const publicContract = { targetVersion: '0.1.13', pins: { installer: '1'.repeat(64), executable: '2'.repeat(64) } };
const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
const hasPwsh = !probe.error && probe.status === 0;
const outgoingWorkflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/native-unified-outgoing-lab.yml'), 'utf8');
const workflowBlocks = [...outgoingWorkflow.matchAll(/^        run: \|\r?\n((?:          [^\r\n]*(?:\r?\n|$))+)/gm)]
  .map(match => match[1].replace(/^          /gm, ''));

function powershell(command, env = process.env) {
  // Always poison an actual subprocess guard, including on CI. Mock runner objects stay in vm only.
  return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
}

function isolatedFunctions(names, body) {
  // Parse/extract only whitelisted pure or mocked functions; never execute the script body.
  assert.ok(names.every(name => ['New-LabStartInfo', 'Resolve-LabBaseline', 'Resolve-UnifiedOutgoingLabBaseline', 'Resolve-LabNode', 'Assert-LabRootAbsent', 'Remove-LabRoot', 'Get-LabFailure', 'Get-LabProcessRecord', 'Get-LabImagePath', 'Set-LabPhase'].includes(name)));
  const result = powershell(`$ErrorActionPreference='Stop'; $PSScriptRoot='${__dirname.replaceAll("'", "''")}'; $tokens=$null; $errors=$null;
    $ast=[System.Management.Automation.Language.Parser]::ParseFile('${helper.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors);
    foreach ($name in @(${names.map(name => `'${name}'`).join(',')})) {
      $node=$ast.FindAll({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $name},$true)[0];
      # An AST-derived scriptblock has no script-file root; supply only that test fixture literal.
      $definition=$node.Extent.Text.Replace('$PSScriptRoot', "'${__dirname.replaceAll("'", "''")}'");
      . ([scriptblock]::Create($definition))
    }
    ${body}`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

function isolatedOutgoingEntries(body) {
  const block = workflowBlocks.find(value => value.includes('function Assert-OutgoingEntries'));
  assert.ok(block);
  const encoded = Buffer.from(block).toString('base64');
  const result = powershell(`$ErrorActionPreference='Stop'; $tokens=$null; $errors=$null;
    $code=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));
    $ast=[System.Management.Automation.Language.Parser]::ParseInput($code,[ref]$tokens,[ref]$errors);
    if ($errors.Count) { throw 'Invalid workflow syntax' }
    $nodes=@($ast.FindAll({param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -ceq 'Assert-OutgoingEntries'},$true));
    if ($nodes.Count -ne 1) { throw 'Missing exact pure archive validator' }
    . ([scriptblock]::Create($nodes[0].Extent.Text));
    ${body}`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

function adapter({ env = runner, mode = 'serve', failStart = false } = {}) {
  const stdin = new EventEmitter(), processMock = new EventEmitter();
  stdin.destroy = () => { stdin.destroyed = true; stdin.emit('close'); };
  const output = [], errors = [], calls = [], timers = new Map();
  const mockProxy = {
    proxyUrl: 'http://127.0.0.1:12345', closeCount: 0,
    async close() { this.closeCount++; },
    report() { return { requests: [{ host: 'github.com', path: '/public', sha256: 'public-hash' }], rejectedRequestCount: 2 }; },
  };
  const lab = {
    LIMITS: { metadata: 32768, durationMs: 600000 },
    assertRunner() { calls.push('guard'); },
    readBounded(file, size) { calls.push(['read', file, size]); return Buffer.from('{"reviewed":"existing inputs"}'); },
    loadContract(config) { calls.push(['contract', config]); return publicContract; },
    async startLabProxy(contract, tls) {
      calls.push(['start', contract, tls]);
      if (failStart) throw Error('NEVER-LOG-SECRET');
      return mockProxy;
    },
  };
  Object.assign(processMock, { env, argv: ['node', '/reviewed/feed.cjs', '/reviewed/config.json', mode], stdin,
    stderr: { write(value) { errors.push(value); } }, exit(code) { throw Error(`exit:${code}`); }, exitCode: undefined });
  const context = { Buffer, TextDecoder, process: processMock, console: { log(value) { output.push(JSON.parse(value)); } },
    require(name) { calls.push(['require', name]); if (name === '/reviewed/feed.cjs') return lab; throw Error('Unexpected dependency'); },
    setTimeout(fn, ms) { const timer = setTimeout(fn, ms); timers.set(timer, { fn, ms }); return timer; },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
  };
  const completion = vm.runInNewContext(bootstrap, context);
  return { stdin, process: processMock, output, errors, calls, mockProxy, completion,
    fireTimer(ms) { const [timer, callback] = [...timers].find(([, callback]) => callback.ms === ms); clearTimeout(timer); timers.delete(timer); callback.fn(); },
    dispose() { for (const timer of timers.keys()) clearTimeout(timer); } };
}

const frame = value => Buffer.from(`${JSON.stringify(value)}\n`);
const tlsFixture = { pfx: Buffer.from('NOT A CERTIFICATE OR PRIVATE KEY').toString('base64'), passphrase: 'NEVER-LOG-SECRET' };
const turn = () => new Promise(resolve => setImmediate(resolve));

test('PowerShell syntax parses without executing helper or issuing certificates', { skip: !hasPwsh }, () => {
  const result = powershell(`$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${helper.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors); if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('literal actual-environment guard precedes settings, input reads, functions and watch dispatch', () => {
  const guardEnd = source.indexOf('$ErrorActionPreference');
  const guard = source.slice(0, guardEnd);
  for (const [name, value] of Object.entries(runner)) assert.ok(guard.includes(`$env:${name} -cne '${value}'`));
  assert.match(guard, /exit 1/);
  assert.doesNotMatch(guard, /Get-Item|Get-Content|Get-Command|GetEnvironmentVariable|X509Store|RSACng|Start\(/);
  assert.ok(source.indexOf('if ($CleanupWatch)') > guardEnd);
  assert.doesNotMatch(source, /\[hashtable\]\$Env|\[string\]\$Runner/);
});

test('local refusal for every missing/wrong flag and cleanup mode occurs before inspection', { skip: !hasPwsh }, () => {
  const badEnvs = [
    { ...runner, GITHUB_ACTIONS: 'false' }, { ...runner, GITHUB_ACTIONS: 'TRUE' },
    { ...runner, RUNNER_ENVIRONMENT: 'self-hosted' }, { ...runner, RUNNER_ENVIRONMENT: 'GitHub-hosted' },
    { ...runner, RUNNER_OS: 'Linux' }, { ...runner, RUNNER_OS: 'windows' },
    { ...runner, GITHUB_ACTIONS: '' }, { ...runner, RUNNER_ENVIRONMENT: '' }, { ...runner, RUNNER_OS: '' },
  ];
  for (const env of badEnvs) {
    for (const watch of [false, true]) {
      const command = `function global:Get-Item { throw 'LOCAL_INSPECTION_SENTINEL' }; function global:Get-Command { throw 'LOCAL_INSPECTION_SENTINEL' }; function global:Test-Path { throw 'LOCAL_INSPECTION_SENTINEL' }; & '${helper.replaceAll("'", "''")}' -ContractPath 'Z:\\ABSENT-SECRET-PATH.json' ${watch ? '-CleanupWatch' : ''}`;
      // At least one flag always mismatches; never launch with the complete live runner flag trio.
      const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
        env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000, windowsHide: true,
      });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Lab lifecycle refused: disposable GitHub-hosted Windows runner required/);
      assert.doesNotMatch(result.stderr, /LOCAL_INSPECTION_SENTINEL|ABSENT-SECRET-PATH/);
    }
  }
});

test('only the exact existing Node driver gets scoped proxy/config and candidate pins from validated contract', () => {
  assert.match(source, /\$driverPath = Resolve-LabFile \(Join-Path \$PSScriptRoot 'native-self-update-smoke\.cjs'\)/);
  assert.match(source, /\$driver\.StartInfo = New-LabStartInfo \$nodePath @\(\$driverPath\) \$ready\.proxyUrl/);
  assert.match(source, /Environment\['CREATOR_SELF_UPDATE_LAB_CONFIG'\] = \$ContractPath/);
  assert.match(source, /Environment\['CREATOR_SELF_UPDATE_LAB_BASELINE'\] = \$BaselineInstallerPath/);
  assert.doesNotMatch(source, /ChildExecutable|ChildArgument|Invoke-Expression|cmd\.exe/);
  assert.match(source, /Environment\['CREATOR_SELF_UPDATE_TARGET_VERSION'\] = \$validated\.targetVersion/);
  assert.match(source, /Environment\['CREATOR_SELF_UPDATE_INSTALLER_SHA256'\] = \$validated\.installerSha256/);
  assert.match(source, /Environment\['CREATOR_SELF_UPDATE_EXECUTABLE_SHA256'\] = \$validated\.executableSha256/);
  assert.doesNotMatch(source, /baseline\.(?:installer|exe)\s*=|CREATOR_HOSTED_UPDATE_FIXTURE.*=/);
  assert.doesNotMatch(source, /SetEnvironmentVariable|\$env:\w+\s*=|netsh|Internet Settings|Set-ItemProperty|hosts\b|dnsclient/i);
  assert.match(source, /Environment\['HTTPS_PROXY'\] = \$ProxyUrl/);
  assert.match(source, /Environment\['HTTP_PROXY'\] = \$ProxyUrl/);
  assert.match(source, /Environment\['NO_PROXY'\] = '127\.0\.0\.1,localhost,::1'/);
});

test('baseline is a mandatory absolute pre-staged pin check before any certificate/proxy setup', () => {
  const baselinePin = '0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18';
  assert.match(source, /\[string\]\$BaselineInstallerPath = ''/);
  // Parameter(Mandatory) would prompt before the VM guard; validation must happen after refusal.
  assert.doesNotMatch(source, /Parameter\(Mandatory/);
  assert.ok(source.includes(`$pin = '${baselinePin}'`));
  assert.equal(require('./self-update-baselines.cjs').selectBaseline('0.1.13').installer, baselinePin);
  assert.match(source, /Get-FileHash -LiteralPath \$full -Algorithm SHA256/);
  assert.match(source, /\$full = Resolve-LabFile \$Path/);
  const check = source.indexOf('$BaselineInstallerPath = Resolve-LabBaseline $BaselineInstallerPath');
  assert.ok(check > source.indexOf('$ErrorActionPreference'));
  assert.ok(check < source.indexOf('$caKey = [Security.Cryptography.RSACng]::new(2048)'));
  assert.ok(check < source.indexOf('$rootStore = Open-LabRootStore'));
  assert.ok(check < source.indexOf('$proxy.Start();'));
  assert.doesNotMatch(source, /Invoke-WebRequest|DownloadFile|DownloadString|Start-BitsTransfer|releases\/download/i);
});

test('mock baseline checker accepts only the original reviewed hash and refuses missing/oversized inputs', { skip: !hasPwsh }, () => {
  const output = isolatedFunctions(['Resolve-LabBaseline'], `
    $script:pin='0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18'; $script:bytes=1234; $script:hashCalls=0;
    function Resolve-LabFile($Path) { if ($Path -ne 'C:\\reviewed\\Creator-Hub-0.1.12-Windows-setup.exe') { throw 'Absolute staged input required' }; return $Path }
    function Get-Item { param($LiteralPath); return @{Length=$script:bytes} }
    function Get-FileHash { param($LiteralPath,$Algorithm); if ($Algorithm -ne 'SHA256') { throw 'Wrong algorithm' }; $script:hashCalls++; return @{Hash=$script:pin.ToUpperInvariant()} }
    $path='C:\\reviewed\\Creator-Hub-0.1.12-Windows-setup.exe';
    if ((Resolve-LabBaseline $path) -ne $path -or $script:hashCalls -ne 1) { throw 'Original baseline not checked' }
    $script:pin='a' * 64; $refused=$false; try { [void](Resolve-LabBaseline $path) } catch { $refused=$true }; if (-not $refused) { throw 'Changed installer accepted' }
    foreach ($badPath in @('', 'relative.exe', 'C:\\missing.exe')) {
      $before=$script:hashCalls; $refused=$false; try { [void](Resolve-LabBaseline $badPath) } catch { $refused=$true };
      if (-not $refused -or $script:hashCalls -ne $before) { throw 'Invalid baseline path not refused first' }
    }
    foreach ($length in @(0, 536870913)) {
      $script:bytes=$length; $before=$script:hashCalls; $refused=$false; try { [void](Resolve-LabBaseline $path) } catch { $refused=$true };
      if (-not $refused -or $script:hashCalls -ne $before) { throw 'Invalid baseline size not refused first' }
    }
    'original-baseline-required'`);
  assert.equal(output, 'original-baseline-required');
});

test('scenario allowlist preserves public-stable default and uses only the fixed outgoing feed/driver names', () => {
  assert.match(source, /ValidateSet\('public-stable','unified-outgoing-14-15'\)\]\[string\]\$Scenario = 'public-stable'/);
  assert.match(source, /\$feedPath = Resolve-LabFile \(Join-Path \$PSScriptRoot 'native-unified-outgoing-target\.cjs'\)/);
  assert.match(source, /\$driverPath = Resolve-LabFile \(Join-Path \$PSScriptRoot 'native-unified-outgoing-smoke\.cjs'\)/);
  assert.match(source, /Resolve-UnifiedOutgoingLabBaseline \$BaselineInstallerPath/);
  assert.match(source, /Test-Path Env:CREATOR_HOSTED_UPDATE_FIXTURE/);
  const check = source.indexOf('$BaselineInstallerPath = Resolve-UnifiedOutgoingLabBaseline $BaselineInstallerPath');
  assert.ok(check < source.indexOf('$caKey = [Security.Cryptography.RSACng]::new(2048)'));
  assert.ok(check < source.indexOf('$rootStore.Add($publicRoot)'));
  assert.doesNotMatch(source.slice(0, source.indexOf('$ErrorActionPreference')), /\$(?:DriverPath|FeedPath|ChildExecutable|ChildArgument)/);
  assert.match(source, /actualScope=\$actualScope; liveAiAcceptance=\$false; productAcceptance=\$false/);
  assert.match(source, /accepted-unmodified-B03-0\.1\.14-to-outer-only-0\.1\.15-fixture-lab-only/);
});

test('both literal scenarios still refuse local execution before files, processes or trust', { skip: !hasPwsh }, () => {
  for (const scenario of ['public-stable', 'unified-outgoing-14-15']) {
    const result = powershell(`function global:Get-Item { throw 'LOCAL_INSPECTION_SENTINEL' };
      & '${helper.replaceAll("'", "''")}' -Scenario '${scenario}' -ContractPath 'Z:\\ABSENT-CONTRACT.json' -BaselineInstallerPath 'Z:\\ABSENT-INSTALLER.exe'`);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /disposable GitHub-hosted Windows runner required/);
    assert.doesNotMatch(result.stderr, /LOCAL_INSPECTION_SENTINEL|ABSENT-CONTRACT|ABSENT-INSTALLER/);
  }
});

test('dedicated outgoing workflow freezes one private ZIP and separates write-token staging from read-only execution', () => {
  assert.match(outgoingWorkflow, /workflow_dispatch:/);
  assert.doesNotMatch(outgoingWorkflow, /inputs:|push:|workflow_call:|schedule:/);
  const staging = outgoingWorkflow.slice(outgoingWorkflow.indexOf('  stage-input:'), outgoingWorkflow.indexOf('  outgoing-lab:'));
  const execution = outgoingWorkflow.slice(outgoingWorkflow.indexOf('  outgoing-lab:'));
  assert.match(staging, /permissions:\r?\n      contents: write/);
  assert.match(staging, /releases\/411494394/);
  assert.match(staging, /id -ne 641402829/);
  assert.match(staging, /outgoing-lab-reviewed-a914bb9-20261014\.zip/);
  assert.match(staging, /size -ne 76991135/);
  assert.match(staging, /digest -cne 'sha256:aafe6f60c5c46ad1e49af1c18f0a74a3e97582c397264076164556e30944822a'/);
  assert.match(staging, /releases\/assets\/641402829/);
  assert.match(staging, /Get-FileHash.*aafe6f60c5c46ad1e49af1c18f0a74a3e97582c397264076164556e30944822a/);
  assert.doesNotMatch(staging, /checkout|setup-node|node |npm |cargo |Expand-Archive|ExtractToFile|Process\]::Start|Get-Content|\.ps1|release.*(?:edit|upload)|secrets\./);
  assert.match(execution, /permissions:\r?\n      contents: read/);
  assert.match(execution, /persist-credentials: false/);
  assert.doesNotMatch(execution, /GH_TOKEN|GITHUB_TOKEN|github\.token|secrets\./);
  assert.match(execution, /directory: root, builtinManifestPath: path\.join\(root, 'builtin-manifest\.json'\)/);
  assert.match(execution, /const contract = target\.loadContract\(config\)/);
  assert.ok(execution.indexOf('target.loadContract(config)') < execution.indexOf('& ./scripts/native-self-update-lab.ps1'));
  assert.match(execution, /-Scenario 'unified-outgoing-14-15'/);
  assert.match(execution, /-TimeoutSeconds 480/);
  assert.match(execution, /\$result = \$LASTEXITCODE/);
  assert.match(execution, /\$null -eq \$result -or \$result -ne 0/);
  assert.doesNotMatch(execution, /continue-on-error|CREATOR_HOSTED_UPDATE_FIXTURE|SkipCertificateCheck|TLS_REJECT|ServerCertificateValidationCallback/);
  const capture = execution.slice(execution.indexOf('      - name: Retain scoped reports'));
  assert.match(capture, /if: always\(\)/);
  assert.match(capture, /native-suite-\*\/report\.json/);
  assert.match(capture, /native-suite-\*\/\*\.png/);
  assert.doesNotMatch(capture.slice(capture.indexOf('          path: |')), /fixture\.zip|baseline\.exe|lab-config\.json|\.pfx|webview|native-suite-\*\/\s*$/im);
  assert.match(execution, /publicDiscovery: false, liveAiAcceptance: false, productAcceptance: false/);
  assert.match(execution, /signaturesVerifiedHere: false/);
});

test('all dedicated workflow PowerShell blocks parse without downloading, extracting or touching trust', { skip: !hasPwsh }, () => {
  assert.equal(workflowBlocks.length, 4);
  for (const block of workflowBlocks) {
    const encoded = Buffer.from(block).toString('base64');
    const result = powershell(`$tokens=$null; $errors=$null;
      $code=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));
      [void][System.Management.Automation.Language.Parser]::ParseInput($code,[ref]$tokens,[ref]$errors);
      if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }`);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});

test('pure seven-entry archive guard refuses extras, aliases, duplicate, link, directory, empty and oversized files', { skip: !hasPwsh }, () => {
  const result = isolatedOutgoingEntries(`
    function Entries {
      @('baseline.exe','builtin-manifest.json','fixture-receipt.json','Creator_Hub_0.1.15_x64-acceptance-only-setup.exe',
        'creator-hub-windows-x86_64.json','creator-hub-windows-x86_64.json.minisig','latest.json') | ForEach-Object {
        [pscustomobject]@{FullName=$_;ExternalAttributes=0;Length=10}
      }
    }
    $entries=@(Entries); Assert-OutgoingEntries $entries;
    $entries[0].ExternalAttributes=0x8000 -shl 16; Assert-OutgoingEntries $entries;
    foreach ($change in @('missing','extra','traversal','case','duplicate','symlink','reparse','directory','empty','metadata-bound','signature-bound','installer-bound')) {
      $entries=@(Entries);
      switch ($change) {
        'missing' { $entries=$entries[0..5] }
        'extra' { $entries+= [pscustomobject]@{FullName='extra.exe';ExternalAttributes=0;Length=10} }
        'traversal' { $entries[0].FullName='../baseline.exe' }
        'case' { $entries[0].FullName='Baseline.exe' }
        'duplicate' { $entries[1].FullName='baseline.exe' }
        'symlink' { $entries[0].ExternalAttributes=0xA000 -shl 16 }
        'reparse' { $entries[0].ExternalAttributes=0x400 }
        'directory' { $entries[0].ExternalAttributes=0x10 }
        'empty' { $entries[0].Length=0 }
        'metadata-bound' { $entries[1].Length=32769 }
        'signature-bound' { $entries[5].Length=4097 }
        'installer-bound' { $entries[0].Length=536870913 }
      }
      $refused=$false; try { Assert-OutgoingEntries $entries } catch { $refused=$true };
      if (-not $refused) { throw ('Invalid archive shape accepted: '+$change) }
    }
    'exact-bounded-regular-seven-only'`);
  assert.equal(result, 'exact-bounded-regular-seven-only');
});

test('mock outgoing baseline accepts B03 only, never public12/B02/masquerade or malformed files', { skip: !hasPwsh }, () => {
  const pin = require('./self-update-lab-feed.cjs').UNIFIED_OUTGOING_BASELINE.installer;
  assert.ok(source.includes(`$pin = '${pin}'`));
  const output = isolatedFunctions(['Resolve-UnifiedOutgoingLabBaseline'], `
    $script:pin='${pin}'; $script:bytes=1234; $script:hashCalls=0;
    function Resolve-LabFile($Path) { if ($Path -cne 'C:\\reviewed\\B03-installer.exe') { throw 'Invalid input' }; return $Path }
    function Get-Item { param($LiteralPath); return @{Length=$script:bytes} }
    function Get-FileHash { param($LiteralPath,$Algorithm); if ($Algorithm -cne 'SHA256') { throw 'Wrong algorithm' }; $script:hashCalls++; return @{Hash=$script:pin.ToUpperInvariant()} }
    $path='C:\\reviewed\\B03-installer.exe';
    if ((Resolve-UnifiedOutgoingLabBaseline $path) -cne $path -or $script:hashCalls -ne 1) { throw 'B03 not checked' }
    foreach ($badPin in @('0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18','b3a42b8d67ef94edefa9cefa9e3791a196febb9d88a2163d38dcfed49c09c13d','a' * 64)) {
      $script:pin=$badPin; $refused=$false; try { [void](Resolve-UnifiedOutgoingLabBaseline $path) } catch { $refused=$true };
      if (-not $refused) { throw 'Foreign baseline accepted' }
    }
    foreach ($length in @(0,536870913)) {
      $script:bytes=$length; $before=$script:hashCalls; $refused=$false; try { [void](Resolve-UnifiedOutgoingLabBaseline $path) } catch { $refused=$true };
      if (-not $refused -or $script:hashCalls -ne $before) { throw 'Invalid size not refused first' }
    }
    'exact-B03-only'`);
  assert.equal(output, 'exact-B03-only');
});

test('isolated child environment strips credentials/bypass, scopes loopback and preserves parent values', { skip: !hasPwsh }, () => {
  const output = isolatedFunctions(['New-LabStartInfo'], `
    $env:HTTPS_PROXY='http://unrelated.invalid:9999'; $env:NO_PROXY='github.com'; $env:ALL_PROXY='http://unrelated.invalid:9998';
    $env:NODE_OPTIONS='unreviewed-preload'; $env:NODE_TLS_REJECT_UNAUTHORIZED='0'; $env:CREATOR_HUB_SIGNING_KEY_PATH='DO-NOT-OPEN';
    $env:GITHUB_TOKEN='DO-NOT-LOG'; $env:TAURI_SIGNING_PRIVATE_KEY='DO-NOT-LOG'; $env:CREATOR_SELF_UPDATE_INSTALLER_SHA256='reviewed-driver-value';
    $info=New-LabStartInfo 'C:\\fixtures\\node.exe' @('C:\\driver path\\native-self-update-smoke.cjs') 'http://127.0.0.1:12345';
    if ($info.Environment['HTTPS_PROXY'] -ne 'http://127.0.0.1:12345' -or $info.Environment['HTTP_PROXY'] -ne 'http://127.0.0.1:12345' -or $info.Environment['NO_PROXY'] -ne '127.0.0.1,localhost,::1') { throw 'Child proxy mismatch' }
    foreach ($name in @('ALL_PROXY','NODE_OPTIONS','NODE_TLS_REJECT_UNAUTHORIZED','CREATOR_HUB_SIGNING_KEY_PATH','GITHUB_TOKEN','TAURI_SIGNING_PRIVATE_KEY')) { if ($info.Environment.ContainsKey($name)) { throw 'Unsafe child environment' } }
    if ($info.Environment['CREATOR_SELF_UPDATE_INSTALLER_SHA256'] -ne 'reviewed-driver-value') { throw 'Driver contract input changed' }
    if ($env:HTTPS_PROXY -ne 'http://unrelated.invalid:9999' -or $env:NO_PROXY -ne 'github.com' -or $env:NODE_TLS_REJECT_UNAUTHORIZED -ne '0' -or $env:CREATOR_HUB_SIGNING_KEY_PATH -ne 'DO-NOT-OPEN') { throw 'Parent environment changed' }
    if ($info.UseShellExecute -or -not $info.CreateNoWindow -or $info.ArgumentList.Count -ne 1) { throw 'Process invocation mismatch' }
    foreach ($url in @('http://evil.test:443','http://127.0.0.1:65536','https://127.0.0.1:12345','http://user@127.0.0.1:12345')) {
      $refused=$false; try { [void](New-LabStartInfo 'C:\\fixtures\\node.exe' @() $url) } catch { $refused=$true }; if (-not $refused) { throw 'Bad proxy admitted' }
    }
    'environment-preserved'`);
  assert.equal(output, 'environment-preserved');
});

test('Node PATH lookup validates only its first application match and refuses missing/linked input', { skip: !hasPwsh }, () => {
  const output = isolatedFunctions(['Resolve-LabNode'], `
    $script:matches=@([pscustomobject]@{Source='C:\\first\\node.exe'},[pscustomobject]@{Source='C:\\second\\node.exe'});
    $script:checked=[Collections.Generic.List[string]]::new();
    function Get-Command { param($Name,$CommandType); if ($Name -cne 'node.exe' -or $CommandType -cne 'Application') { throw 'Wrong lookup' }; return $script:matches }
    function Resolve-LabFile($Path) { $script:checked.Add($Path); if ($Path -cne 'C:\\first\\node.exe') { throw 'Invalid/linked path' }; return $Path }
    if ((Resolve-LabNode) -cne 'C:\\first\\node.exe' -or $script:checked.Count -ne 1) { throw 'Joined or wrong Node path' }
    $script:matches=@(); $refused=$false; try { [void](Resolve-LabNode) } catch { $refused=$true }; if (-not $refused -or $script:checked.Count -ne 1) { throw 'Missing Node admitted' }
    $script:matches=@([pscustomobject]@{Source='C:\\linked\\node.exe'},[pscustomobject]@{Source='C:\\first\\node.exe'});
    $refused=$false; try { [void](Resolve-LabNode) } catch { $refused=$true }; if (-not $refused -or $script:checked.Count -ne 2) { throw 'Invalid first path fell back' }
    'first-node-path-validated'`);
  assert.equal(output, 'first-node-path-validated');
});

test('mocked Root cleanup preserves unrelated trust, is idempotent and refuses foreign/private entries', { skip: !hasPwsh }, () => {
  const output = isolatedFunctions(['Assert-LabRootAbsent', 'Remove-LabRoot'], `
    function Entry($thumb,$bytes,$private=$false) {
      $item=[pscustomobject]@{Thumbprint=$thumb;RawData=[byte[]]$bytes;HasPrivateKey=$private;Disposed=$false};
      $item | Add-Member ScriptMethod Dispose { $this.Disposed=$true }; return $item
    }
    function Store($entries) {
      $finder=[pscustomobject]@{entries=[Collections.Generic.List[object]]::new()}; foreach ($entry in $entries) { $finder.entries.Add($entry) }
      $finder | Add-Member ScriptMethod Find { param($type,$thumb,$valid); return @($this.entries | Where-Object { $_.Thumbprint -eq $thumb }) }
      $store=[pscustomobject]@{Certificates=$finder;removed=[Collections.Generic.List[string]]::new()};
      $store | Add-Member ScriptMethod Remove { param($entry); [void]$this.Certificates.entries.Remove($entry); $this.removed.Add($entry.Thumbprint) }; return $store
    }
    $owned=Entry 'OWNED' @(1,2,3); $unrelated=Entry 'UNRELATED' @(4,5,6); $store=Store @($owned,$unrelated);
    $refused=$false; try { Assert-LabRootAbsent $store $owned } catch { $refused=$true }; if (-not $refused -or $store.removed.Count) { throw 'Pre-existing entry admitted' }
    Remove-LabRoot $store $owned; Remove-LabRoot $store $owned;
    if ($store.removed.Count -ne 1 -or $store.Certificates.entries.Count -ne 1 -or $unrelated.Disposed -or -not $owned.Disposed) { throw 'Unrelated trust changed or cleanup not idempotent' }
    foreach ($foreign in @((Entry 'OWNED' @(8,9)), (Entry 'OWNED' @(1,2,3) $true))) {
      $store=Store @($foreign,$unrelated); $refused=$false;
      try { Remove-LabRoot $store $owned } catch { $refused=$true }
      if (-not $refused -or $store.removed.Count -or $store.Certificates.entries.Count -ne 2) { throw 'Unowned entry removed' }
    }
    'unrelated-trust-preserved'`);
  assert.equal(output, 'unrelated-trust-preserved');
});

test('source requires VM/admin guard and ephemeral keys disposed before public-only machine Root insertion', () => {
  assert.match(source, /\$caKey = \[Security\.Cryptography\.RSACng\]::new\(2048\)/);
  assert.match(source, /-not \$caKey\.Key\.IsEphemeral -or -not \$leafKey\.Key\.IsEphemeral/);
  assert.match(source, /X509Store\]::new\('Root', 'LocalMachine'\)/);
  assert.match(source, /IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/);
  assert.ok(source.indexOf('Disposable runner administrator token required.') < source.indexOf("X509Store]::new('Root', 'LocalMachine')"));
  assert.doesNotMatch(source, /-Verb\s+RunAs|runas\.exe|UNPROTECTED_FLAG/);
  assert.match(source, /trustScope='disposable-vm-local-machine'/);
  assert.match(source, /X509Certificate2\]::new\(\$ca\.RawData\)/);
  assert.ok(source.indexOf('$caKey.Dispose(); $caKey = $null') < source.indexOf('$rootStore.Add($publicRoot)'));
  assert.doesNotMatch(source, /New-SelfSignedCertificate|Import-PfxCertificate|PersistKeySet|MachineKeySet|WriteAll|Set-Content|Out-File|Remove-Item/);
  assert.match(source, /\$san\.AddDnsName\('github\.com'\); \$san\.AddDnsName\('api\.github\.com'\)/);
  assert.equal((source.match(/AddDnsName\(/g) || []).length, 2);
  assert.match(source, /'1\.3\.6\.1\.5\.5\.7\.3\.1'/);
  assert.match(source, /X509BasicConstraintsExtension\]::new\(\$true, \$true, 0, \$true\)/);
});

test('system TLS has no custom validation, DNS override, trust bypass or relay', () => {
  assert.match(source, /SslStream\]::new\(\$stream, \$false\)/);
  assert.match(source, /AuthenticateAsClientAsync\(\$HostName\)/);
  assert.match(source, /Test-LabSystemTls \$ready\.proxyUrl 'github\.com'/);
  assert.match(source, /Test-LabSystemTls \$ready\.proxyUrl 'api\.github\.com'/);
  assert.doesNotMatch(source, /ServerCertificateValidationCallback|RemoteCertificateValidationCallback|CustomRootTrust|rejectUnauthorized\s*:\s*false|SkipCertificateCheck|DangerousAccept|curl.*--insecure/i);
  assert.doesNotMatch(bootstrap, /https\.request|net\.connect|dns\.|connectHost|createServer|writeFile/);
  assert.match(bootstrap, /lab\.startLabProxy\(contract, \{ pfx, passphrase: control\.passphrase \}\)/);
});

test('TLS control stays off argv/files/logs and is bounded and scrubbed after errors', () => {
  assert.match(source, /StandardInput\.WriteLine\(\$tlsControl\)/);
  assert.match(source, /New-LabStartInfo \$nodePath @\('-e', \$proxyBootstrap, \$feedPath, \$ContractPath, 'serve'\)/);
  assert.doesNotMatch(source, /ArgumentList\.Add\(\$(?:pfx|password|tlsControl)/i);
  assert.match(bootstrap, /96 \* 1024/);
  assert.match(bootstrap, /64 \* 1024/);
  assert.match(bootstrap, /input\.fill\(0\); if \(pfx\) pfx\.fill\(0\)/);
  assert.match(source, /StandardOutput\.BaseStream\.CopyToAsync\(\[IO\.Stream\]::Null\)/);
  assert.match(source, /StandardError\.BaseStream\.CopyToAsync\(\[IO\.Stream\]::Null\)/);
  assert.doesNotMatch(source, /WriteLine\(\$_|error\.stack|error\.message|CommandLine|Authorization.*=/);
});

test('cleanup is armed before trust, covers partially failed add, and verifies exact bytes/absence', () => {
  assert.ok(source.indexOf("if ($armed.kind -cne 'lab-cleanup-armed')") < source.indexOf('$rootStore.Add($publicRoot)'));
  assert.ok(source.indexOf('$trustOwned = $true') < source.indexOf('$rootStore.Add($publicRoot)'));
  assert.match(source, /FindByThumbprint, \$Certificate\.Thumbprint, \$false/);
  assert.match(source, /\$entry\.HasPrivateKey -or \[Convert\]::ToBase64String\(\$entry\.RawData\) -cne \[Convert\]::ToBase64String\(\$Certificate\.RawData\)/);
  assert.match(source, /\$Store\.Remove\(\$entry\)/);
  assert.match(source, /Assert-LabRootAbsent \$Store \$Certificate/);
  assert.match(source, /if \(\$trustOwned\) \{ try \{ Remove-LabRoot \$rootStore \$publicRoot/);
  assert.match(source, /if \(\$armed\) \{ try \{ Remove-LabRoot \$watchStore \$watchRoot/);
  assert.match(source, /Test-LabProcess \$control\.owner/);
  assert.match(source, /\$watcher\.StandardInput\.Close\(\)/);
});

test('only recorded own PID/image/start-time identities may be stopped; no runtime tree kill', () => {
  assert.match(source, /StartTime\.ToUniversalTime\(\)\.Ticks\.ToString\(\) -cne \$Record\.startTimeTicks/);
  assert.match(source, /\(Get-LabImagePath \$process\), \$Record\.executablePath/);
  assert.match(source, /\$parent\.ParentProcessId -ne \[int\]\$control\.owner\.pid/);
  assert.match(source, /\$process\.Kill\(\)/);
  assert.doesNotMatch(source, /Kill\(\$true\)|taskkill|Stop-Process|Get-Process -Name|GetProcessesByName/i);
  assert.match(source, /TimeoutSeconds -gt 480/);
});

test('public metadata never claims update acceptance or signature verification', () => {
  assert.match(source, /nativeAcceptanceTested=\$false; releaseReady=\$false/);
  assert.doesNotMatch(source, /nativeAcceptanceTested\s*=\s*\$true|releaseReady\s*=\s*\$true|signaturesVerifiedByHarness\s*=\s*\$true/);
  assert.match(source, /labDiscovery=\$true; publicDiscovery=\$false/);
  assert.doesNotMatch(bootstrap, /console\.log\((?:control|input|report|config)|JSON\.stringify\((?:control|report|config)\)/);
});

test('helper sets an explicit caller exit code for success as well as refusal', () => {
  assert.match(source, /if \(\$failed -or -not \$cleanupVerified\) \{ exit 1 \}\r?\nexit 0\s*$/);
});

test('failure diagnostics expose only allowlisted phase, exception class, numeric code and line', { skip: !hasPwsh }, () => {
  const output = isolatedFunctions(['Get-LabFailure'], `
    try { throw 'NEVER-LOG-SECRET-CONTROL-FRAME' } catch { $record=$_ }
    $safe=Get-LabFailure 'baseline' $record;
    if ($safe.phase -cne 'baseline' -or $safe.exceptionClass -cne 'System.Management.Automation.RuntimeException') { throw 'Missing phase/class' }
    if (($safe.Keys | Sort-Object) -join ',' -cne 'exceptionClass,hResult,phase,scriptLine') { throw 'Unexpected diagnostic fields' }
    if ($safe.hResult -isnot [int] -or $safe.scriptLine -isnot [int]) { throw 'Non-numeric diagnostic' }
    $unknown=Get-LabFailure 'NEVER-LOG-SECRET' $record;
    if ($unknown.phase -cne 'unknown') { throw 'Untrusted phase exposed' }
    $json=$safe | ConvertTo-Json -Compress;
    if ($json -match 'NEVER-LOG|CONTROL-FRAME') { throw 'Secret exposed' }
    'safe-failure-diagnostics'`);
  assert.equal(output, 'safe-failure-diagnostics');
});

test('live phase capture emits only allowlisted stage without command, path or control material', { skip: !hasPwsh }, () => {
  const output = isolatedFunctions(['Set-LabPhase'], `
    $phaseJson=Set-LabPhase 'root-add'; $record=$phaseJson | ConvertFrom-Json;
    if ($record.kind -cne 'lab-lifecycle-phase' -or $record.phase -cne 'root-add' -or $script:phase -cne 'root-add') { throw 'Missing phase' }
    if (($record.PSObject.Properties.Name | Sort-Object) -join ',' -cne 'kind,phase') { throw 'Unexpected phase data' }
    $refused=$false; try { [void](Set-LabPhase 'NEVER-LOG-SECRET') } catch { $refused=$true };
    if (-not $refused -or $script:phase -cne 'root-add') { throw 'Invalid phase admitted' }
    'safe-phase-capture'`);
  assert.equal(output, 'safe-phase-capture');
});

test('image mismatch diagnostic preserves refusal and includes only PID and executable paths', { skip: !hasPwsh }, () => {
  const output = isolatedFunctions(['Get-LabProcessRecord'], `
    function Get-LabImagePath($Process) { return $Process.MainModule.FileName }
    $process=[pscustomobject]@{Id=123;MainModule=@{FileName='C:\\other\\pwsh.exe'};CommandLine='NEVER-LOG-SECRET';StartTime=[DateTime]::UtcNow};
    $script:processIdentityFailure=$null; $refused=$false;
    try { [void](Get-LabProcessRecord $process 'C:\\reviewed\\pwsh.exe') } catch { $refused=$true }
    if (-not $refused -or $script:processIdentityFailure.actualImage -cne 'C:\\other\\pwsh.exe') { throw 'Mismatch accepted or uncaptured' }
    if (($script:processIdentityFailure.Keys | Sort-Object) -join ',' -cne 'actualImage,expectedImage,pid') { throw 'Unwanted diagnostic fields' }
    if (($script:processIdentityFailure | ConvertTo-Json -Compress) -match 'NEVER-LOG-SECRET') { throw 'Command material exposed' }
    $script:processIdentityFailure=$null; $process.MainModule.FileName='C:\\REVIEWED\\PWSH.EXE';
    $record=Get-LabProcessRecord $process 'C:\\reviewed\\pwsh.exe';
    if ($record.pid -ne 123 -or $null -ne $script:processIdentityFailure) { throw 'Valid image refused' }
    'image-mismatch-remains-refused'`);
  assert.equal(output, 'image-mismatch-remains-refused');
});

test('Windows image query reads a benign owned CLI child immediately, without MainModule or trust setup', { skip: !hasPwsh || process.platform !== 'win32' }, () => {
  const output = isolatedFunctions(['Get-LabImagePath', 'Get-LabProcessRecord'], `
    $expected=Join-Path $PSHOME 'pwsh.exe';
    $owner=[Diagnostics.Process]::GetCurrentProcess();
    try { [void](Get-LabProcessRecord $owner $expected) } finally { $owner.Dispose() }
    $info=[Diagnostics.ProcessStartInfo]::new($expected); $info.UseShellExecute=$false; $info.CreateNoWindow=$true;
    foreach ($arg in @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Milliseconds 200')) { $info.ArgumentList.Add($arg) }
    $child=[Diagnostics.Process]::new(); $child.StartInfo=$info;
    try {
      [void]$child.Start(); $record=Get-LabProcessRecord $child $expected;
      if ($record.pid -ne $child.Id -or -not [string]::Equals($record.executablePath,$expected,[StringComparison]::OrdinalIgnoreCase)) { throw 'Wrong process image' }
      if (-not $child.WaitForExit(5000)) { throw 'CLI fixture did not exit' }
    } finally { $child.Dispose() }
    'owned-cli-image-verified'`);
  assert.equal(output, 'owned-cli-image-verified');
  assert.doesNotMatch(source, /\.MainModule/);
  assert.match(source, /QueryFullProcessImageNameW\(process, 0, name, ref size\)/);
  assert.ok(source.indexOf('$owner = Get-LabProcessRecord $ownerProcess $pwshPath') < source.indexOf('$validator.Start();'));
});

test('adapter refuses every bad runner before requiring modules or reading contract', () => {
  for (const name of Object.keys(runner)) {
    assert.throws(() => adapter({ env: { ...runner, [name]: 'wrong' } }), /exit:1/);
  }
});

test('adapter prevalidates reviewed contract without consuming TLS or starting proxy', async () => {
  const a = adapter({ mode: 'validate' });
  try {
    await a.completion;
    assert.deepEqual(a.output, [{ kind: 'lab-contract-validated', targetVersion: publicContract.targetVersion,
      installerSha256: publicContract.pins.installer, executableSha256: publicContract.pins.executable }]);
    assert.equal(a.calls.filter(call => call[0] === 'start').length, 0);
    assert.equal(a.process.exitCode, undefined);
  } finally { a.dispose(); }
});

test('adapter sends readiness, closes on owner EOF, and emits only public counts', async () => {
  const a = adapter();
  try {
    a.stdin.emit('data', frame(tlsFixture)); await turn();
    assert.deepEqual(a.output, [{ kind: 'lab-feed-ready', proxyUrl: 'http://127.0.0.1:12345' }]);
    const supplied = a.calls.find(call => call[0] === 'start')[2];
    assert.ok(supplied.pfx.every(byte => byte === 0), 'PFX buffer erased after TLS context creation');
    a.stdin.emit('end'); await a.completion;
    assert.deepEqual(a.output[1], { kind: 'lab-feed-stopped', servedRouteCount: 1, rejectedRequestCount: 2 });
    assert.ok(a.mockProxy.closeCount >= 1);
    assert.doesNotMatch(JSON.stringify(a.output), /NEVER-LOG-SECRET|NOT A CERTIFICATE|public-hash/);
  } finally { a.dispose(); }
});

test('adapter failure is sanitized and erases supplied PFX, including start failure', async () => {
  const a = adapter({ failStart: true });
  try {
    a.stdin.emit('data', frame(tlsFixture)); await a.completion;
    assert.equal(a.process.exitCode, 1);
    assert.deepEqual(a.output, []);
    assert.equal(a.errors.join(''), 'Lab adapter refused or failed.\n');
    assert.ok(a.calls.find(call => call[0] === 'start')[2].pfx.every(byte => byte === 0));
    assert.equal(a.stdin.destroyed, true);
  } finally { a.dispose(); }
});

test('malformed/oversized/extra TLS frames are refused without private material in output', async () => {
  for (const value of [frame({ ...tlsFixture, secret: 'NEVER-LOG-SECRET' }), frame({ ...tlsFixture, pfx: 'not-base64!' }),
    Buffer.alloc(96 * 1024 + 1, 65), Buffer.concat([frame(tlsFixture), Buffer.from('EXTRA')]), Buffer.from('{SECRET}\n')]) {
    const a = adapter();
    try {
      a.stdin.emit('data', value); await a.completion;
      assert.equal(a.process.exitCode, 1);
      assert.equal(a.calls.filter(call => call[0] === 'start').length, 0);
      assert.deepEqual(a.output, []);
      assert.equal(a.errors.join(''), 'Lab adapter refused or failed.\n');
    } finally { a.dispose(); }
  }
});

test('owner cancellation before TLS and SIGTERM after readiness are bounded graceful closure', async () => {
  const early = adapter();
  try {
    early.stdin.emit('end'); await early.completion;
    assert.equal(early.process.exitCode, 1);
    assert.equal(early.calls.filter(call => call[0] === 'start').length, 0);
  } finally { early.dispose(); }
  const running = adapter();
  try {
    running.stdin.emit('data', frame(tlsFixture)); await turn();
    running.process.emit('SIGTERM'); await running.completion;
    assert.equal(running.process.exitCode, undefined);
    assert.ok(running.mockProxy.closeCount >= 1);
    assert.equal(running.stdin.destroyed, true);
  } finally { running.dispose(); }
});

test('TLS input timeout refuses and proxy duration timeout closes without using real TLS', async () => {
  const waiting = adapter();
  try {
    waiting.fireTimer(10000); await waiting.completion;
    assert.equal(waiting.process.exitCode, 1);
    assert.equal(waiting.calls.filter(call => call[0] === 'start').length, 0);
    assert.equal(waiting.errors.join(''), 'Lab adapter refused or failed.\n');
  } finally { waiting.dispose(); }
  const running = adapter();
  try {
    running.stdin.emit('data', frame(tlsFixture)); await turn();
    running.fireTimer(600000); await running.completion;
    assert.equal(running.process.exitCode, undefined);
    assert.ok(running.mockProxy.closeCount >= 1);
  } finally { running.dispose(); }
});

test('fragmented TLS stdin is assembled without accepting trailing control or logging secrets', async () => {
  const a = adapter();
  try {
    const data = frame(tlsFixture);
    a.stdin.emit('data', data.subarray(0, 20));
    assert.equal(a.calls.filter(call => call[0] === 'start').length, 0);
    a.stdin.emit('data', data.subarray(20)); await turn();
    a.stdin.emit('close'); await a.completion;
    assert.equal(a.process.exitCode, undefined);
    assert.equal(a.output[0].kind, 'lab-feed-ready');
    assert.doesNotMatch(JSON.stringify(a.output) + a.errors.join(''), /NEVER-LOG-SECRET|NOT A CERTIFICATE/);
  } finally { a.dispose(); }
});
