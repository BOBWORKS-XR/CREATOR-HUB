# VM-only transport lifecycle, not an update acceptance receipt. Requires pwsh 7.
param([string]$ContractPath = '', [string]$BaselineInstallerPath = '', [int]$TimeoutSeconds = 300, [switch]$CleanupWatch,
    [ValidateSet('public-stable','unified-outgoing-14-15')][string]$Scenario = 'public-stable', [switch]$Incoming016)
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') {
    [Console]::Error.WriteLine('Lab lifecycle refused: disposable GitHub-hosted Windows runner required.')
    exit 1
}
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows) {
    [Console]::Error.WriteLine('Lab lifecycle requires Windows pwsh 7.')
    exit 1
}

function Resolve-LabFile([string]$Path) {
    if (-not [IO.Path]::IsPathFullyQualified($Path)) { throw 'Absolute input path required.' }
    $full = [IO.Path]::GetFullPath($Path)
    for ($entry = $full; $entry; $entry = [IO.Path]::GetDirectoryName($entry)) {
        $item = Get-Item -LiteralPath $entry -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked input refused.' }
    }
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw 'Input file unavailable.' }
    return $full
}

function Resolve-LabBaseline([string]$Path) {
    $full = Resolve-LabFile $Path
    $item = Get-Item -LiteralPath $full
    if ($item.Length -lt 1 -or $item.Length -gt 512MB) { throw 'Baseline installer size refused.' }
    $pin = '0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18'
    if ((Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin) { throw 'Unmodified public 0.1.12 baseline installer required.' }
    return $full
}

function Resolve-UnifiedOutgoingLabBaseline([string]$Path) {
    $full = Resolve-LabFile $Path
    $item = Get-Item -LiteralPath $full
    if ($item.Length -lt 1 -or $item.Length -gt 512MB) { throw 'Baseline installer size refused.' }
    $pin = '284820f92de487e8a0f1bb5b3b99cafe5e073f0402a9350a2ea6e76fa9543157'
    if ((Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant() -cne $pin) { throw 'Exact accepted B05 0.1.14 baseline installer required; no B02/B03 or version masquerade.' }
    return $full
}

function Resolve-LabNode {
    # Application lookup can return several PATH matches; use the first, not a joined array.
    $matches = @(Get-Command node.exe -CommandType Application)
    if (-not $matches.Count) { throw 'Node executable unavailable.' }
    return Resolve-LabFile $matches[0].Source
}

function New-LabStartInfo([string]$Executable, [string[]]$Arguments, [string]$ProxyUrl = '') {
    $info = [Diagnostics.ProcessStartInfo]::new($Executable)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    $info.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $info.WorkingDirectory = Split-Path $PSScriptRoot -Parent
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    # Edit only the cloned child environment. Never read signing-key files or log credentials.
    foreach ($name in @($info.Environment.Keys)) {
        if ($name -match '(?i)(SIGNING|PRIVATE_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)' -or
            $name -match '^(?i:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE)$') {
            [void]$info.Environment.Remove($name)
        }
    }
    if ($ProxyUrl) {
        if ($ProxyUrl -cnotmatch '^http://127\.0\.0\.1:[1-9][0-9]{0,4}$' -or ([uri]$ProxyUrl).Port -gt 65535) { throw 'Non-loopback proxy refused.' }
        $info.Environment['HTTPS_PROXY'] = $ProxyUrl
        $info.Environment['HTTP_PROXY'] = $ProxyUrl
        $info.Environment['NO_PROXY'] = '127.0.0.1,localhost,::1'
    }
    return $info
}

function Get-LabImagePath($Process) {
    # MainModule can be null during loader startup; query the owned process handle instead.
    if (-not ('CreatorHubLabProcessImage' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class CreatorHubLabProcessImage {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageNameW(SafeProcessHandle process, uint flags, StringBuilder name, ref uint size);
    public static string Read(SafeProcessHandle process) {
        var name = new StringBuilder(32768);
        uint size = (uint)name.Capacity;
        if (!QueryFullProcessImageNameW(process, 0, name, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (size == 0 || size >= name.Capacity || name.Length != size) throw new InvalidOperationException("Invalid process image length.");
        return name.ToString();
    }
}
'@
    }
    return [CreatorHubLabProcessImage]::Read($Process.SafeHandle)
}

function Get-LabProcessRecord($Process, [string]$ExpectedPath) {
    $actualPath = Get-LabImagePath $Process
    if (-not [string]::Equals($actualPath, $ExpectedPath, [StringComparison]::OrdinalIgnoreCase)) {
        # Only executable identity, never argv/environment or private transport material.
        $script:processIdentityFailure = [ordered]@{pid=$Process.Id; expectedImage=$ExpectedPath; actualImage=$actualPath}
        throw 'Owned process image mismatch.'
    }
    return [ordered]@{ pid = $Process.Id; executablePath = $ExpectedPath; startTimeTicks = $Process.StartTime.ToUniversalTime().Ticks.ToString() }
}

function Test-LabProcess($Record) {
    $process = $null
    try {
        $process = [Diagnostics.Process]::GetProcessById([int]$Record.pid)
        return (-not $process.HasExited -and $process.StartTime.ToUniversalTime().Ticks.ToString() -ceq $Record.startTimeTicks -and
            [string]::Equals((Get-LabImagePath $process), $Record.executablePath, [StringComparison]::OrdinalIgnoreCase))
    } catch [ArgumentException] { return $false }
    finally { if ($process) { $process.Dispose() } }
}

function Stop-LabProcess($Record) {
    $process = $null
    try {
        $process = [Diagnostics.Process]::GetProcessById([int]$Record.pid)
        if ($process.HasExited) { return }
        if ($process.StartTime.ToUniversalTime().Ticks.ToString() -cne $Record.startTimeTicks -or
            -not [string]::Equals((Get-LabImagePath $process), $Record.executablePath, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refused to stop an unowned process.' }
        # No name-wide or process-tree kills: descendant runtime ownership belongs to the driver.
        $process.Kill()
        if (-not $process.WaitForExit(5000)) { throw 'Owned process did not stop.' }
    } catch [ArgumentException] { return }
    finally { if ($process) { $process.Dispose() } }
}

function Open-LabRootStore {
    # The disposable VM administrator store avoids CurrentUser protected-root interaction.
    # Never request elevation or run this helper outside its literal hosted-runner guard.
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Disposable runner administrator token required.' }
    } finally { $identity.Dispose() }
    $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'LocalMachine')
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite -bor [Security.Cryptography.X509Certificates.OpenFlags]::OpenExistingOnly)
    return $store
}

function Assert-LabRootAbsent($Store, $Certificate) {
    if ($Store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $Certificate.Thumbprint, $false).Count) { throw 'Pre-existing trust entry refused.' }
}

function Remove-LabRoot($Store, $Certificate) {
    $matches = $Store.Certificates.Find([Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $Certificate.Thumbprint, $false)
    foreach ($entry in $matches) {
        try {
            if ($entry.HasPrivateKey -or [Convert]::ToBase64String($entry.RawData) -cne [Convert]::ToBase64String($Certificate.RawData)) { throw 'Trust ownership mismatch; preserving entry.' }
            $Store.Remove($entry)
        } finally { $entry.Dispose() }
    }
    Assert-LabRootAbsent $Store $Certificate
}

function Read-LabLine($Reader, [int]$Milliseconds = 10000) {
    $task = $Reader.ReadLineAsync()
    if (-not $task.Wait($Milliseconds)) { throw 'Control channel timeout.' }
    $line = $task.GetAwaiter().GetResult()
    if (-not $line -or $line.Length -gt 32768) { throw 'Invalid control frame.' }
    return $line
}

function Get-LabFailure([string]$Phase, $Record) {
    $allowed = @('timeout', 'baseline', 'contract', 'feed-path', 'driver-path', 'node-path', 'pwsh-path',
        'validator-start', 'validator-result', 'certificates', 'root-store', 'watcher-start', 'watcher-arm',
        'root-add', 'proxy-start', 'proxy-register', 'proxy-ready', 'system-tls', 'driver-start', 'driver-register', 'driver-wait')
    if ($Phase -cnotin $allowed) { $Phase = 'unknown' }
    $class = $Record.Exception.GetType().FullName
    if ($class -cnotmatch '^[A-Za-z0-9_.+`]+$') { $class = 'unknown' }
    # Never include messages, exception data, command text, paths or control frames.
    return [ordered]@{phase=$Phase; exceptionClass=$class; hResult=[int]$Record.Exception.HResult;
        scriptLine=[int]$Record.InvocationInfo.ScriptLineNumber}
}

function Set-LabPhase {
    param([ValidateSet('timeout', 'baseline', 'contract', 'feed-path', 'driver-path', 'node-path', 'pwsh-path',
        'validator-start', 'validator-result', 'certificates', 'root-store', 'watcher-start', 'watcher-arm',
        'root-add', 'proxy-start', 'proxy-register', 'proxy-ready', 'system-tls', 'driver-start', 'driver-register', 'driver-wait',
        'cleanup-driver', 'cleanup-proxy', 'cleanup-root', 'cleanup-watcher', 'cleanup-resources')][string]$Value)
    $script:phase = $Value
    [ordered]@{kind='lab-lifecycle-phase'; phase=$Value} | ConvertTo-Json -Compress
}

# The watcher receives only public DER and verified process identities, never the PFX/password.
# Arm it before adding trust so helper termination still removes exactly its newly owned root.
if ($CleanupWatch) {
    $watchRoot = $null; $watchStore = $null; $watchInput = $null; $armed = $false; $watchFailed = $false
    $owned = [Collections.Generic.List[object]]::new()
    try {
        # Console.In can synchronously block ReadLineAsync; use an actual asynchronous pipe reader.
        $watchInput = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false, $true), $false, 4096, $true)
        $control = Read-LabLine $watchInput | ConvertFrom-Json
        if ($control.timeoutSeconds -lt 1 -or $control.timeoutSeconds -gt 540) { throw 'Invalid watch deadline.' }
        $watchRoot = [Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String($control.rootDer))
        if ($watchRoot.HasPrivateKey -or $watchRoot.Subject -cnotmatch '^CN=Creator Hub lab [a-f0-9]{32}$' -or -not (Test-LabProcess $control.owner)) { throw 'Invalid cleanup ownership.' }
        $watchStore = Open-LabRootStore
        Assert-LabRootAbsent $watchStore $watchRoot
        $armed = $true
        [Console]::Out.WriteLine('{"kind":"lab-cleanup-armed"}')
        $deadline = [DateTime]::UtcNow.AddSeconds($control.timeoutSeconds)
        $next = $watchInput.ReadLineAsync()
        while ((Test-LabProcess $control.owner) -and [DateTime]::UtcNow -lt $deadline) {
            if ($next.IsCompleted) {
                $line = $next.GetAwaiter().GetResult()
                if ($null -eq $line) { break }
                if ($line.Length -gt 4096 -or $owned.Count -ge 3) { throw 'Invalid ownership frame.' }
                $record = $line | ConvertFrom-Json
                if (-not (Test-LabProcess $record)) { throw 'Process identity unavailable.' }
                $parent = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$record.pid) -Property ParentProcessId
                if ($parent.ParentProcessId -ne [int]$control.owner.pid) { throw 'Non-child process refused.' }
                $owned.Add($record)
                [Console]::Out.WriteLine('{"kind":"lab-process-registered"}')
                $next = $watchInput.ReadLineAsync()
            }
            Start-Sleep -Milliseconds 100
        }
    } catch { $watchFailed = $true }
    finally {
        foreach ($record in $owned) { try { Stop-LabProcess $record } catch { $watchFailed = $true } }
        if ($armed) { try { Remove-LabRoot $watchStore $watchRoot } catch { $watchFailed = $true } }
        if ($watchStore) { $watchStore.Dispose() }
        if ($watchRoot) { $watchRoot.Dispose() }
        if ($watchInput) { $watchInput.Dispose() }
    }
    [Console]::Out.WriteLine((@{kind='lab-cleanup-finished'; cleanupVerified=(-not $watchFailed)} | ConvertTo-Json -Compress))
    if ($watchFailed) { exit 1 }
    exit 0
}

# Reuse the reviewed feed API; secrets enter on a bounded stdin frame, not node argv.
$proxyBootstrap = @'
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Windows') {
  process.stderr.write('Lab adapter refused.\n'); process.exit(1);
}
const lab = require(process.argv[1]);
lab.assertRunner();
async function main() {
  const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(lab.readBounded(process.argv[2], lab.LIMITS.metadata)));
  const contract = lab.loadContract(config);
  if (process.argv[3] === 'validate') {
    console.log(JSON.stringify({ kind: 'lab-contract-validated', targetVersion: contract.targetVersion,
      installerSha256: contract.pins.installer, executableSha256: contract.pins.executable }));
    return;
  }
  if (process.argv[3] !== 'serve') throw Error('Mode refused');
  let stopped = false, stop;
  const stopping = new Promise(resolve => { stop = () => { stopped = true; resolve(); }; });
  process.stdin.once('end', stop); process.stdin.once('close', stop);
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let input = Buffer.alloc(0), pfx, control, proxy;
  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => finish(Error('Control timeout')), 10000);
      function finish(error) {
        clearTimeout(deadline); process.stdin.removeListener('data', data);
        process.stdin.removeListener('end', ended); process.stdin.removeListener('error', finish);
        error ? reject(error) : resolve();
      }
      function ended() { finish(Error('Missing TLS frame')); }
      function data(chunk) {
        if (input.length + chunk.length > 96 * 1024) { finish(Error('Control bound')); return; }
        const joined = Buffer.concat([input, chunk]); input.fill(0); input = joined;
        const end = input.indexOf(10);
        if (end < 0) return;
        if (end !== input.length - 1) { finish(Error('Extra control input')); return; }
        try {
          control = JSON.parse(input.subarray(0, end).toString('utf8'));
          if (Object.keys(control).sort().join(',') !== 'passphrase,pfx' || typeof control.pfx !== 'string' || typeof control.passphrase !== 'string') throw Error('TLS frame');
          pfx = Buffer.from(control.pfx, 'base64');
          if (!pfx.length || pfx.length > 64 * 1024 || pfx.toString('base64') !== control.pfx) throw Error('PFX bound');
          finish();
        } catch { finish(Error('TLS frame')); }
      }
      process.stdin.on('data', data); process.stdin.once('end', ended); process.stdin.once('error', finish);
    });
    process.stdin.on('data', stop); process.stdin.on('error', stop);
    if (stopped) throw Error('Owner disconnected');
    proxy = await lab.startLabProxy(contract, { pfx, passphrase: control.passphrase });
    input.fill(0); pfx.fill(0); control.pfx = ''; control.passphrase = '';
    console.log(JSON.stringify({ kind: 'lab-feed-ready', proxyUrl: proxy.proxyUrl }));
    const expiry = setTimeout(stop, lab.LIMITS.durationMs);
    try { await stopping; } finally { clearTimeout(expiry); }
    await proxy.close();
    const report = proxy.report();
    console.log(JSON.stringify({ kind: 'lab-feed-stopped', servedRouteCount: report.requests.length, rejectedRequestCount: report.rejectedRequestCount,
      rejectionSummary: report.rejectionSummary, rejectionOverflow: report.rejectionOverflow }));
  } finally {
    input.fill(0); if (pfx) pfx.fill(0);
    if (control) { control.pfx = ''; control.passphrase = ''; }
    if (proxy) await proxy.close();
    process.stdin.destroy();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
main().catch(() => { process.stderr.write('Lab adapter refused or failed.\n'); process.exitCode = 1; });
'@

function Test-LabSystemTls([string]$ProxyUrl, [string]$HostName, [string]$LeafThumbprint) {
    $tcp = [Net.Sockets.TcpClient]::new(); $tls = $null
    try {
        $endpoint = [uri]$ProxyUrl
        if (-not $tcp.ConnectAsync('127.0.0.1', $endpoint.Port).Wait(10000)) { throw 'Loopback connection timeout.' }
        $stream = $tcp.GetStream(); $stream.ReadTimeout = 10000; $stream.WriteTimeout = 10000
        $request = [Text.Encoding]::ASCII.GetBytes("CONNECT ${HostName}:443 HTTP/1.1`r`nHost: ${HostName}:443`r`n`r`n")
        $stream.Write($request, 0, $request.Length)
        $response = ''
        while (-not $response.EndsWith("`r`n`r`n")) {
            $value = $stream.ReadByte()
            if ($value -lt 0 -or $response.Length -ge 512) { throw 'CONNECT response refused.' }
            $response += [char]$value
        }
        if ($response -cne "HTTP/1.1 200 Connection Established`r`n`r`n") { throw 'CONNECT refused.' }
        # No validation callback or custom trust: Windows validates the default system chain/hostname.
        $tls = [Net.Security.SslStream]::new($stream, $false)
        if (-not $tls.AuthenticateAsClientAsync($HostName).Wait(10000) -or -not $tls.IsAuthenticated -or -not $tls.IsEncrypted) { throw 'System TLS probe failed.' }
        if ($tls.RemoteCertificate.GetCertHashString() -cne $LeafThumbprint) { throw 'Unexpected TLS leaf.' }
    } finally { if ($tls) { $tls.Dispose() }; $tcp.Dispose() }
}

$rootStore = $null; $publicRoot = $null; $ca = $null; $leaf = $null; $unsignedLeaf = $null
$caKey = $null; $leafKey = $null; $pfx = $null; $passwordBytes = $null; $password = $null; $tlsControl = $null
$validator = $null; $watcher = $null; $proxy = $null; $driver = $null
$validatorRecord = $null; $proxyRecord = $null; $driverRecord = $null; $watcherRecord = $null
$trustOwned = $false; $failed = $false; $cleanupVerified = $true; $systemTlsVerified = $false
$driverExitCode = $null; $feedResult = $null; $rootThumbprint = $null; $leafThumbprint = $null
$phase = 'timeout'; $failureDetails = $null
$script:processIdentityFailure = $null
$actualScope = if ($Incoming016) { 'exact-public14-to-direct16-lab-only' }
    elseif ($Scenario -ceq 'public-stable') { 'unmodified-public-0.1.12-lab-only' }
    else { 'accepted-unmodified-B05-0.1.14-to-outer-only-0.1.15-fixture-lab-only' }
try {
    Set-LabPhase 'timeout'
    if ($Incoming016 -and $Scenario -cne 'public-stable') { throw 'Incoming16 cannot be combined with a historical scenario.' }
    if ($TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 480) { throw 'Driver timeout must be 1..480 seconds.' }
    # The exact five-route proxy cannot bootstrap either baseline. Stage reviewed bytes beforehand.
    Set-LabPhase 'baseline'
    if ($Incoming016) {
        if (Test-Path Env:CREATOR_HOSTED_UPDATE_FIXTURE) { throw 'Incoming16 baseline fixture refused.' }
        $BaselineInstallerPath = Resolve-UnifiedOutgoingLabBaseline $BaselineInstallerPath
    } elseif ($Scenario -ceq 'public-stable') {
        $BaselineInstallerPath = Resolve-LabBaseline $BaselineInstallerPath
    } else {
        if (Test-Path Env:CREATOR_HOSTED_UPDATE_FIXTURE) { throw 'Outgoing baseline version masquerade refused.' }
        $BaselineInstallerPath = Resolve-UnifiedOutgoingLabBaseline $BaselineInstallerPath
    }
    Set-LabPhase 'contract'
    $ContractPath = Resolve-LabFile $ContractPath
    Set-LabPhase 'feed-path'
    if ($Incoming016) {
        $feedPath = Resolve-LabFile (Join-Path $PSScriptRoot 'windows-incoming-016.cjs')
    } elseif ($Scenario -ceq 'public-stable') {
        $feedPath = Resolve-LabFile (Join-Path $PSScriptRoot 'self-update-lab-feed.cjs')
    } else {
        $feedPath = Resolve-LabFile (Join-Path $PSScriptRoot 'native-unified-outgoing-target.cjs')
    }
    Set-LabPhase 'driver-path'
    if ($Scenario -ceq 'public-stable') {
        $driverPath = Resolve-LabFile (Join-Path $PSScriptRoot 'native-self-update-smoke.cjs')
    } else {
        $driverPath = Resolve-LabFile (Join-Path $PSScriptRoot 'native-unified-outgoing-smoke.cjs')
    }
    Set-LabPhase 'node-path'
    $nodePath = Resolve-LabNode
    Set-LabPhase 'pwsh-path'
    $pwshPath = Resolve-LabFile (Join-Path $PSHOME 'pwsh.exe')
    # Compile the image-query adapter before any short-lived child is launched.
    $ownerProcess = [Diagnostics.Process]::GetCurrentProcess()
    try { $owner = Get-LabProcessRecord $ownerProcess $pwshPath } finally { $ownerProcess.Dispose() }
    Set-LabPhase 'validator-start'
    $validator = [Diagnostics.Process]::new()
    $validator.StartInfo = New-LabStartInfo $nodePath @('-e', $proxyBootstrap, $feedPath, $ContractPath, 'validate')
    [void]$validator.Start(); $validatorRecord = Get-LabProcessRecord $validator $nodePath
    $validatorErrorDrain = $validator.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
    Set-LabPhase 'validator-result'
    $validated = Read-LabLine $validator.StandardOutput | ConvertFrom-Json
    if ($validated.kind -cne 'lab-contract-validated' -or -not $validator.WaitForExit(10000) -or $validator.ExitCode -ne 0) { throw 'Reviewed contract refused.' }

    Set-LabPhase 'certificates'
    $caKey = [Security.Cryptography.RSACng]::new(2048)
    $leafKey = [Security.Cryptography.RSACng]::new(2048)
    if (-not $caKey.Key.IsEphemeral -or -not $leafKey.Key.IsEphemeral) { throw 'Persistent private keys refused.' }
    $now = [DateTimeOffset]::UtcNow
    $caRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new(('CN=Creator Hub lab ' + [guid]::NewGuid().ToString('N')), $caKey, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $caRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $true, 0, $true))
    $caRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign, $true))
    $ca = $caRequest.CreateSelfSigned($now.AddMinutes(-1), $now.AddMinutes(20))
    $leafRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=github.com', $leafKey, [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $leafRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
    $leafRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment, $true))
    $eku = [Security.Cryptography.OidCollection]::new(); [void]$eku.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
    $leafRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $false))
    $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddDnsName('github.com'); $san.AddDnsName('api.github.com')
    $leafRequest.CertificateExtensions.Add($san.Build())
    $serial = [byte[]]::new(16); [Security.Cryptography.RandomNumberGenerator]::Fill($serial); $serial[0] = 1
    $unsignedLeaf = $leafRequest.Create($ca, $now.AddMinutes(-1), $now.AddMinutes(15), $serial)
    $leaf = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($unsignedLeaf, $leafKey)
    $leafThumbprint = $leaf.Thumbprint
    $publicRoot = [Security.Cryptography.X509Certificates.X509Certificate2]::new($ca.RawData)
    if ($publicRoot.HasPrivateKey) { throw 'Root store must receive only public DER.' }
    $rootThumbprint = $publicRoot.Thumbprint
    $passwordBytes = [byte[]]::new(32); [Security.Cryptography.RandomNumberGenerator]::Fill($passwordBytes)
    $password = [Convert]::ToBase64String($passwordBytes)
    $pfx = $leaf.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password)
    # Dispose the CA signing key before trust exists. No private certificate is ever stored/imported.
    $leaf.Dispose(); $leaf = $null; $unsignedLeaf.Dispose(); $unsignedLeaf = $null
    $ca.Dispose(); $ca = $null; $leafKey.Dispose(); $leafKey = $null; $caKey.Dispose(); $caKey = $null

    Set-LabPhase 'root-store'
    $rootStore = Open-LabRootStore
    Assert-LabRootAbsent $rootStore $publicRoot
    Set-LabPhase 'watcher-start'
    $watcher = [Diagnostics.Process]::new()
    $watcher.StartInfo = New-LabStartInfo $pwshPath @('-NoProfile', '-NonInteractive', '-File', $PSCommandPath, '-CleanupWatch')
    [void]$watcher.Start(); $watcherRecord = Get-LabProcessRecord $watcher $pwshPath
    $watcherErrorDrain = $watcher.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
    $watcher.StandardInput.WriteLine((@{rootDer=[Convert]::ToBase64String($publicRoot.RawData); owner=$owner; timeoutSeconds=($TimeoutSeconds + 60)} | ConvertTo-Json -Depth 4 -Compress))
    $watcher.StandardInput.Flush()
    Set-LabPhase 'watcher-arm'
    $armed = Read-LabLine $watcher.StandardOutput | ConvertFrom-Json
    if ($armed.kind -cne 'lab-cleanup-armed') { throw 'Cleanup watcher unavailable.' }
    Assert-LabRootAbsent $rootStore $publicRoot
    $trustOwned = $true
    Set-LabPhase 'root-add'
    $rootStore.Add($publicRoot)

    Set-LabPhase 'proxy-start'
    $proxy = [Diagnostics.Process]::new()
    $proxy.StartInfo = New-LabStartInfo $nodePath @('-e', $proxyBootstrap, $feedPath, $ContractPath, 'serve')
    [void]$proxy.Start(); $proxyRecord = Get-LabProcessRecord $proxy $nodePath
    $proxyErrorDrain = $proxy.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
    Set-LabPhase 'proxy-register'
    $watcher.StandardInput.WriteLine(($proxyRecord | ConvertTo-Json -Compress)); $watcher.StandardInput.Flush()
    $registered = Read-LabLine $watcher.StandardOutput | ConvertFrom-Json
    if ($registered.kind -cne 'lab-process-registered') { throw 'Proxy ownership not registered.' }
    $tlsControl = @{pfx=[Convert]::ToBase64String($pfx); passphrase=$password} | ConvertTo-Json -Compress
    $proxy.StandardInput.WriteLine($tlsControl); $proxy.StandardInput.Flush()
    [Array]::Clear($pfx, 0, $pfx.Length); $pfx = $null
    [Array]::Clear($passwordBytes, 0, $passwordBytes.Length); $passwordBytes = $null; $password = $null; $tlsControl = $null
    Set-LabPhase 'proxy-ready'
    $ready = Read-LabLine $proxy.StandardOutput | ConvertFrom-Json
    if ($ready.kind -cne 'lab-feed-ready' -or $ready.proxyUrl -cnotmatch '^http://127\.0\.0\.1:[1-9][0-9]{0,4}$' -or ([uri]$ready.proxyUrl).Port -gt 65535) { throw 'Proxy readiness refused.' }
    Set-LabPhase 'system-tls'
    Test-LabSystemTls $ready.proxyUrl 'github.com' $leafThumbprint
    Test-LabSystemTls $ready.proxyUrl 'api.github.com' $leafThumbprint
    $systemTlsVerified = $true
    [ordered]@{kind='lab-lifecycle-ready'; scenario=$Scenario; actualScope=$actualScope; liveAiAcceptance=$false; productAcceptance=$false; releaseReady=$false;
        labDiscovery=$true; publicDiscovery=$false; nativeAcceptanceTested=$false; systemTlsVerified=$true; trustScope='disposable-vm-local-machine';
        proxyUrl=$ready.proxyUrl; rootThumbprint=$publicRoot.Thumbprint; leafThumbprint=$leafThumbprint; proxy=$proxyRecord; cleanupWatcher=$watcherRecord} | ConvertTo-Json -Depth 4 -Compress

    Set-LabPhase 'driver-start'
    $driver = [Diagnostics.Process]::new()
    $driver.StartInfo = New-LabStartInfo $nodePath @($driverPath) $ready.proxyUrl
    $driver.StartInfo.Environment['CREATOR_SELF_UPDATE_LAB_CONFIG'] = $ContractPath
    $driver.StartInfo.Environment['CREATOR_SELF_UPDATE_LAB_BASELINE'] = $BaselineInstallerPath
    $driver.StartInfo.Environment['CREATOR_SELF_UPDATE_TARGET_VERSION'] = $validated.targetVersion
    $driver.StartInfo.Environment['CREATOR_SELF_UPDATE_INSTALLER_SHA256'] = $validated.installerSha256
    $driver.StartInfo.Environment['CREATOR_SELF_UPDATE_EXECUTABLE_SHA256'] = $validated.executableSha256
    [void]$driver.Start(); $driverRecord = Get-LabProcessRecord $driver $nodePath
    $driverOutputDrain = $driver.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
    $driverErrorDrain = $driver.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
    Set-LabPhase 'driver-register'
    $watcher.StandardInput.WriteLine(($driverRecord | ConvertTo-Json -Compress)); $watcher.StandardInput.Flush()
    $registered = Read-LabLine $watcher.StandardOutput | ConvertFrom-Json
    if ($registered.kind -cne 'lab-process-registered') { throw 'Driver ownership not registered.' }
    $driver.StandardInput.Close()
    Set-LabPhase 'driver-wait'
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while (-not $driver.WaitForExit(200)) {
        if ($proxy.HasExited -or $watcher.HasExited -or [DateTime]::UtcNow -ge $deadline) { throw 'Transport/driver lifetime ended.' }
    }
    $driverExitCode = $driver.ExitCode
    if ($driverExitCode -ne 0) { throw 'Driver did not succeed.' }
} catch {
    $failed = $true
    $failureDetails = Get-LabFailure $phase $_
    [Console]::Error.WriteLine('Lab lifecycle refused or failed; no native/public acceptance established.')
} finally {
    Set-LabPhase 'cleanup-driver'
    foreach ($record in @($driverRecord, $validatorRecord)) {
        if ($record) { try { Stop-LabProcess $record } catch { $cleanupVerified = $false } }
    }
    Set-LabPhase 'cleanup-proxy'
    if ($proxy) {
        try {
            $proxy.StandardInput.Close()
            if (-not $proxy.WaitForExit(5000)) { Stop-LabProcess $proxyRecord }
            if ($proxy.ExitCode -eq 0) {
                $feedResult = Read-LabLine $proxy.StandardOutput 1000 | ConvertFrom-Json
                if ($feedResult.kind -cne 'lab-feed-stopped') { throw 'Missing transport result.' }
            }
        } catch { $cleanupVerified = $false; if ($proxyRecord) { try { Stop-LabProcess $proxyRecord } catch { $cleanupVerified = $false } } }
    }
    Set-LabPhase 'cleanup-root'
    if ($trustOwned) { try { Remove-LabRoot $rootStore $publicRoot } catch { $cleanupVerified = $false } }
    Set-LabPhase 'cleanup-watcher'
    if ($watcher) {
        try {
            $watcher.StandardInput.Close()
            if (-not $watcher.WaitForExit(10000)) { throw 'Cleanup watcher did not finish.' }
            $cleaned = Read-LabLine $watcher.StandardOutput 1000 | ConvertFrom-Json
            if ($cleaned.kind -cne 'lab-cleanup-finished' -or $cleaned.cleanupVerified -ne $true -or $watcher.ExitCode -ne 0) { throw 'Watcher cleanup unverified.' }
        } catch { $cleanupVerified = $false }
    }
    Set-LabPhase 'cleanup-resources'
    if ($pfx) { [Array]::Clear($pfx, 0, $pfx.Length) }
    if ($passwordBytes) { [Array]::Clear($passwordBytes, 0, $passwordBytes.Length) }
    $password = $null; $tlsControl = $null
    foreach ($resource in @($leaf, $unsignedLeaf, $ca, $leafKey, $caKey, $publicRoot, $rootStore, $driver, $proxy, $validator, $watcher)) { if ($resource) { $resource.Dispose() } }
}
[ordered]@{kind='lab-lifecycle-result'; lifecycleSucceeded=(-not $failed -and $cleanupVerified); cleanupVerified=$cleanupVerified;
    scenario=$Scenario; actualScope=$actualScope; liveAiAcceptance=$false; productAcceptance=$false;
    systemTlsVerified=$systemTlsVerified; trustScope='disposable-vm-local-machine'; labDiscovery=$true; publicDiscovery=$false; nativeAcceptanceTested=$false; releaseReady=$false;
    driverExitCode=$driverExitCode; failureDetails=$failureDetails; processIdentityFailure=$script:processIdentityFailure; rootThumbprint=$rootThumbprint; leafThumbprint=$leafThumbprint; driver=$driverRecord; proxy=$proxyRecord; cleanupWatcher=$watcherRecord;
    servedRouteCount=$(if ($feedResult) { $feedResult.servedRouteCount } else { $null });
    rejectedRequestCount=$(if ($feedResult) { $feedResult.rejectedRequestCount } else { $null });
    rejectionSummary=$(if ($feedResult) { @($feedResult.rejectionSummary) } else { @() });
    rejectionOverflow=$(if ($feedResult) { $feedResult.rejectionOverflow } else { $null })} | ConvertTo-Json -Depth 4 -Compress
if ($failed -or -not $cleanupVerified) { exit 1 }
exit 0
