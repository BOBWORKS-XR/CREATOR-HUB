param(
    [Parameter(Mandatory = $true)][string]$CandidateDirectory,
    [ValidateSet('0.2.2', '0.3.0-alpha.1', '0.3.0-alpha.2', '0.3.0-alpha.6', '0.3.0')][string]$BaselineVersion = '0.2.2'
)
$ErrorActionPreference = 'Stop'
# This script runs real installers. Check the environment before resolving targets.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Real installation acceptance is restricted to a disposable GitHub-hosted Windows runner.'
}
Set-StrictMode -Version Latest
$repo = Split-Path $PSScriptRoot -Parent
$candidateRoot = (Resolve-Path -LiteralPath $CandidateDirectory).Path
$allowed = [IO.Path]::GetFullPath((Join-Path $repo 'dist')) + '\'
if (-not $candidateRoot.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Candidate must belong to this checkout.' }
$pin = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installed-acceptance-pin.json') -Raw | ConvertFrom-Json
$baselinePin = $pin.baselines.$BaselineVersion
$version = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
if ($version -cne $pin.version) { throw 'Review the version-specific acceptance pin before testing another candidate.' }
$installer = Join-Path $candidateRoot "Creator-Project-Setup-$version-Windows-setup.exe"
$payload = Join-Path $candidateRoot 'installed-payload\creator-project-setup.exe'
$installRoot = Join-Path $env:LOCALAPPDATA 'Creator Project Setup'
$installedExe = Join-Path $installRoot 'creator-project-setup.exe'
$dataRoots = @(
    (Join-Path $env:LOCALAPPDATA 'com.creatorworks.projectsetup'),
    (Join-Path $env:APPDATA 'com.creatorworks.projectsetup'),
    (Join-Path $env:LOCALAPPDATA 'CreatorProjectSetup')
)
$productKey = 'HKCU:\Software\Creator Works\Creator Project Setup'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Creator Project Setup'
foreach ($path in (@($installRoot, $productKey, $uninstallKey) + $dataRoots)) {
    if (Test-Path -LiteralPath $path) { throw "Not a clean runner: $path already exists." }
}
if (Get-Process -Name creator-project-setup -ErrorAction SilentlyContinue) { throw 'A Setup process already exists.' }
$output = Join-Path $repo 'dist\installed-acceptance'
if (Test-Path -LiteralPath $output) { throw 'Use a fresh runner for each installed acceptance run.' }
$null = New-Item -ItemType Directory -Path $output
$fixtureRoot = Join-Path $output ('owned-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $fixtureRoot
$stopFile = Join-Path $fixtureRoot 'stop'
$owned = $null
$gui = $null
$checks = [Collections.Generic.List[object]]::new()
$report = [ordered]@{
    passed = $false; version = $version; candidateRunId = $pin.runId; candidateSource = $pin.sourceRevision
    runner = $env:RUNNER_OS; productionUserMachineUsed = $false; publicationReady = $false
    installedUpgradeTested = $false; guiStartupTested = $false; guiNormalCloseTested = $false
    baselineVersion = $BaselineVersion
    settingsEvidence = 'Synthetic sentinels only. No project, repair receipt or real user preferences were created.'
    notTested = @('Unity/project creation or repair', 'Interactive installer UI', 'Busy project creation',
        'Historical uninstaller', 'Hub adoption or self-update', 'macOS/Linux')
}
function Require($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Files([string]$Root) {
    @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
        [pscustomobject]@{ name = $_.FullName.Substring($Root.Length); hash = Hash $_.FullName; length = $_.Length; modified = $_.LastWriteTimeUtc.Ticks }
    })
}
function Registry([string]$Path) {
    $root = Get-Item -LiteralPath $Path
    @(@($root) + @(Get-ChildItem -LiteralPath $Path -Recurse) | Sort-Object Name | ForEach-Object {
        $key = $_
        [pscustomobject]@{ name = $key.Name; values = @($key.GetValueNames() | Sort-Object | ForEach-Object {
            [pscustomobject]@{ name = $_; kind = $key.GetValueKind($_).ToString(); value = $key.GetValue($_, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
        }) }
    })
}
function Snapshot {
    [ordered]@{
        files = Files $installRoot
        data = @($dataRoots | ForEach-Object { [pscustomobject]@{ root = $_; files = Files $_ } })
        product = Registry $productKey
        uninstall = Registry $uninstallKey
    } | ConvertTo-Json -Depth 12
}
function Run-Installer([string]$Path, [string]$Arguments, [int]$Expected, [string]$Label) {
    $psi = [Diagnostics.ProcessStartInfo]::new($Path)
    $psi.Arguments = $Arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $child = [Diagnostics.Process]::Start($psi)
    try {
        Require ($child.WaitForExit(180000)) "$Label exceeded its deadline; no process was force-closed."
        $checks.Add([pscustomobject]@{ test = $Label; pid = $child.Id; exitCode = $child.ExitCode; expected = $Expected; passed = $child.ExitCode -eq $Expected })
        Require ($child.ExitCode -eq $Expected) "$Label returned $($child.ExitCode), expected $Expected."
    } finally { $child.Dispose() }
}
function Close-Fixture {
    if ($null -eq $script:owned) { return }
    $child = $script:owned
    if (-not $child.HasExited) { [IO.File]::WriteAllText($stopFile, 'exit') }
    Require ($child.WaitForExit(10000)) 'Owned fixture did not exit cooperatively; no force-close was attempted.'
    $report.fixtureExitCode = $child.ExitCode
    $report.fixtureStderr = $child.StandardError.ReadToEnd()
    Require ($child.ExitCode -eq 0) "Owned fixture failed with exit $($child.ExitCode)."
    $child.Dispose()
    $script:owned = $null
}
try {
    Require ((Hash $installer) -ceq $pin.installerSha256) 'Candidate installer hash mismatch.'
    Require ((Hash $payload) -ceq $pin.executableSha256) 'Extracted candidate executable hash mismatch.'
    $candidate = Get-Content -LiteralPath (Join-Path $candidateRoot 'candidate-report.json') -Raw | ConvertFrom-Json
    Require ($candidate.sourceRevision -ceq $pin.sourceRevision -and $candidate.version -ceq $version -and $candidate.artifactChecksPassed) 'Candidate report does not match the pinned tested source.'
    $report.candidateSourceDirty = $candidate.sourceDirty
    Require (-not $candidate.sourceDirty) 'Only a source-clean final candidate may pass this release acceptance.'
    Require ($candidate.checks.packagedLicenseNotices -and $candidate.checks.portableZipVerified) 'Candidate has no verified license-complete packaging evidence.'
    $report.installerSha256 = Hash $installer
    $report.executableSha256 = Hash $payload
    $baseline = Join-Path $output "baseline-$BaselineVersion.exe"
    Invoke-WebRequest -Uri $baselinePin.url -OutFile $baseline
    Require ((Hash $baseline) -ceq $baselinePin.installerSha256) 'Public baseline hash mismatch.'
    $report.baselineSha256 = Hash $baseline
    # /R is absent. Neither installer is allowed to launch the app automatically.
    Run-Installer $baseline ('/S /NS /D=' + $installRoot) 0 "Clean public $BaselineVersion installation"
    Require ((Hash $installedExe) -ceq $baselinePin.executableSha256) 'Baseline installed EXE hash mismatch.'
    Require ((Get-ItemProperty -LiteralPath $uninstallKey).DisplayVersion -ceq $BaselineVersion) 'Baseline registry version mismatch.'
    Require ((Get-Item -LiteralPath $productKey).GetValue('') -eq $installRoot) 'Baseline registration path mismatch.'
    $sentinels = @()
    foreach ($root in $dataRoots) {
        $null = New-Item -ItemType Directory -Path $root
        $sentinels += Join-Path $root 'ci-preservation-sentinel.json'
    }
    $sentinels += Join-Path $installRoot 'ci-unmanaged-sentinel.json'
    foreach ($path in $sentinels) { [IO.File]::WriteAllText($path, '{"ciSentinel":"preserve-this-exact-file"}') }
    $sentinelHashes = @($sentinels | ForEach-Object { [pscustomobject]@{ path = $_; hash = Hash $_ } })
    $before = Snapshot
    [IO.File]::WriteAllText((Join-Path $output 'before-refusal.json'), $before)

    # Use a same-name owned process, not a real project-creation operation.
    $fixtureExe = Join-Path $fixtureRoot 'creator-project-setup.exe'
    Copy-Item -LiteralPath (Get-Command node.exe -ErrorAction Stop).Source -Destination $fixtureExe
    $psi = [Diagnostics.ProcessStartInfo]::new($fixtureExe)
    $psi.Arguments = '"{0}" "{1}"' -f (Join-Path $PSScriptRoot 'owned-setup-fixture.cjs'), $stopFile
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $owned = [Diagnostics.Process]::Start($psi)
    $report.fixturePid = $owned.Id
    $ready = $owned.StandardOutput.ReadLineAsync()
    Require ($ready.Wait(10000) -and $ready.Result -ceq 'fixture-ready' -and -not $owned.WaitForExit(500)) 'Owned fixture failed to stay alive before testing the installer.'
    Run-Installer $installer ('/S /NS /UPDATE /D=' + $installRoot) 10 'Hub update arguments refuse an active Setup'
    Require (-not $owned.HasExited) 'Installer stopped the owned fixture.'
    $after = Snapshot
    [IO.File]::WriteAllText((Join-Path $output 'after-refusal.json'), $after)
    Require ($after -ceq $before) 'Blocked upgrade changed files, data or registration.'
    $checks.Add([pscustomobject]@{ test = 'Refusal preserved every snapshotted file and registry value'; passed = $true })
    Close-Fixture

    Run-Installer $installer ('/S /NS /UPDATE /D=' + $installRoot) 0 'Installed update succeeds after cooperative fixture exit'
    Require ((Hash $installedExe) -ceq $pin.executableSha256) 'Updated installed EXE differs from extracted candidate payload.'
    Require ((Get-ItemProperty -LiteralPath $uninstallKey).DisplayVersion -ceq $version) 'Registry version did not advance.'
    Require ((Get-Item -LiteralPath $productKey).GetValue('') -eq $installRoot) 'Updated registration path changed.'
    foreach ($notice in $candidate.notices.files) {
        Require ((Hash (Join-Path $installRoot $notice.name)) -ceq $notice.sha256) "Installed license notice differs from candidate: $($notice.name)"
    }
    $report.installedLicenseNoticesVerified = $true
    foreach ($sentinel in $sentinelHashes) { Require ((Hash $sentinel.path) -ceq $sentinel.hash) "Preservation sentinel changed: $($sentinel.path)" }
    [IO.File]::WriteAllText((Join-Path $output 'after-upgrade.json'), (Snapshot))
    $identity = & node -e "const v=require(process.argv[1]); console.log(JSON.stringify(v.probe(process.argv[2],process.argv[3])));" (Join-Path $PSScriptRoot 'verify-windows-candidate.cjs') $installedExe $version
    Require ($LASTEXITCODE -eq 0) 'Installed identity or unsupported-argument check failed.'
    $report.installedIdentity = $identity | ConvertFrom-Json
    $report.installedUpgradeTested = $true
    $checks.Add([pscustomobject]@{ test = 'Installed payload, identity, version and sentinels match'; passed = $true })

    # This tests a real packaged window, not metadata or the browser mock.
    $gui = Start-Process -FilePath $installedExe -PassThru -WindowStyle Hidden
    $report.guiPid = $gui.Id
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 250
        $gui.Refresh()
        if ($gui.HasExited) { throw "Installed Setup exited during startup: $($gui.ExitCode)." }
    } while ($gui.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $deadline)
    Require ($gui.MainWindowHandle -ne 0 -and $gui.MainWindowTitle -ceq 'Creator Project Setup') 'Installed Setup did not create the expected main window.'
    Require (-not $gui.WaitForExit(2000)) 'Installed Setup exited just after creating its window.'
    $report.guiStartupTested = $true
    $report.windowTitle = $gui.MainWindowTitle
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        [void]$gui.CloseMainWindow()
        if ($gui.WaitForExit(1000)) { break }
    } while ([DateTime]::UtcNow -lt $deadline)
    Require ($gui.HasExited) 'Installed Setup did not close normally; no force-close was attempted.'
    Require ($gui.ExitCode -eq 0) "Installed Setup returned $($gui.ExitCode) after normal close."
    $report.guiNormalCloseTested = $true
    foreach ($sentinel in $sentinelHashes) { Require ((Hash $sentinel.path) -ceq $sentinel.hash) 'GUI smoke changed a preservation sentinel.' }
    $report.passed = $true
} catch {
    $report.error = $_.Exception.Message
    throw
} finally {
    try {
        Close-Fixture
        if ($gui) {
            if (-not $gui.HasExited) { [void]$gui.CloseMainWindow(); [void]$gui.WaitForExit(10000) }
            $report.guiExited = $gui.HasExited
            $gui.Dispose()
        }
    } catch {
        $report.passed = $false
        $report.cleanupError = $_.Exception.Message
        throw
    } finally {
        $report.checks = @($checks.ToArray())
        $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $output 'installed-acceptance.json') -Encoding UTF8
        # The disposable runner owns cleanup. Never delete product directories.
    }
}
