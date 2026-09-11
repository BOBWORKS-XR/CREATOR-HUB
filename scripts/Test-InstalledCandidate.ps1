param(
    [Parameter(Mandatory = $true)][string]$CandidateDirectory,
    [ValidateSet('clean', 'alpha.3', 'alpha.4')][string]$HubBaseline = 'clean'
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Real installation acceptance is restricted to a disposable GitHub-hosted Windows runner.'
}
$repo = Split-Path $PSScriptRoot -Parent
$output = (Resolve-Path -LiteralPath $CandidateDirectory).Path
$allowed = [IO.Path]::GetFullPath((Join-Path $repo 'dist')) + '\'
if (-not $output.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Candidate must belong to this checkout.' }
$version = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$installer = Join-Path $output "Creator-Hub-$version-Windows-setup.exe"
$expectedExe = Join-Path $output 'extracted\creator-hub.exe'
$installed = Join-Path $env:LOCALAPPDATA 'Creator Hub'
$data = Join-Path $env:LOCALAPPDATA 'CreatorHub'
$productKey = 'HKCU:\Software\Creator Works\Creator Hub'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Creator Hub'
foreach ($path in @($installed, $data, $productKey, $uninstallKey)) {
    if (Test-Path -LiteralPath $path) { throw "Not a clean runner: $path exists." }
}
if (Get-Process -Name creator-hub -ErrorAction SilentlyContinue) { throw 'A Hub process already exists.' }
$checks = [Collections.Generic.List[object]]::new()
$report = [ordered]@{ passed = $false; version = $version; baseline = $HubBaseline; guiStartupTested = $false; sameVersionUpdateTested = $false; crossVersionUpdateTested = $false; selfUpdateTested = $false }
$owned = $null
$gui = $null
function Hash([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Require($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Run-Installer([string]$Arguments, [int]$Expected, [string]$Label, [string]$InstallerPath = $installer) {
    $psi = [Diagnostics.ProcessStartInfo]::new($InstallerPath)
    $psi.Arguments = $Arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $child = [Diagnostics.Process]::Start($psi)
    try {
        Require ($child.WaitForExit(180000)) "$Label exceeded its deadline; no process was force-closed."
        $checks.Add([pscustomobject]@{ test = $Label; exitCode = $child.ExitCode; expectedExitCode = $Expected; elapsedMilliseconds = $timer.ElapsedMilliseconds; passed = ($child.ExitCode -eq $Expected) })
        if ($child.ExitCode -ne $Expected) {
            $report.failureProcesses = @(Get-Process -Name creator-hub -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path)
            # Probe only after a failure so a warmup cannot mask a cold-start defect.
            $probeInfo = [Diagnostics.ProcessStartInfo]::new($expectedExe)
            $probeInfo.Arguments = '--installer-preflight'
            $probeInfo.UseShellExecute = $false
            $probeInfo.CreateNoWindow = $true
            $probe = [Diagnostics.Process]::Start($probeInfo)
            $probeTimer = [Diagnostics.Stopwatch]::StartNew()
            try {
                $finished = $probe.WaitForExit(30000)
                $report.postFailureGuardProbe = @{ method = 'native-toolhelp'; finished = $finished; exitCode = $(if ($finished) { $probe.ExitCode } else { $null }); elapsedMilliseconds = $probeTimer.ElapsedMilliseconds }
            } finally { $probe.Dispose() }
        }
        Require ($child.ExitCode -eq $Expected) "$Label returned $($child.ExitCode), expected $Expected."
    } finally { $child.Dispose() }
}
function Snapshot {
    [pscustomobject]@{
        files = @(Get-ChildItem -LiteralPath $installed -Recurse -File | Sort-Object FullName | ForEach-Object {
            [pscustomobject]@{ name = $_.FullName.Substring($installed.Length); hash = Hash $_.FullName; modified = $_.LastWriteTimeUtc.Ticks }
        })
        data = Hash (Join-Path $data 'ci-settings-sentinel.json')
        version = (Get-ItemProperty -LiteralPath $uninstallKey).DisplayVersion
        folder = (Get-Item -LiteralPath $productKey).GetValue('')
    } | ConvertTo-Json -Depth 5 -Compress
}
try {
    $report.installerSha256 = Hash $installer
    $report.expectedExecutableSha256 = Hash $expectedExe
    if ($HubBaseline -ne 'clean') {
        $baseline = if ($HubBaseline -eq 'alpha.4') {
            @{ Version = '0.1.0-alpha.4'; Installer = '425f0e6d5399227f9e5e257ad2b5c2e9fc57b6e58ed27a56d1f13b29c93e67c9'; Exe = 'b789ae255dd220a1ebe0493b7264f24846efb594c8b5bd8b85e5e891f22d9a4e' }
        } else {
            @{ Version = '0.1.0-alpha.3'; Installer = '1a2239d83171b94849ba96a8e235daf4f3e50faff24ccb63e9f8d44e1d7c5fda'; Exe = '0f24647616177a85936a66fbcc31c55ba929712cd4153b8aecc5bd060b380f00' }
        }
        $baselineInstaller = Join-Path $output "Creator-Hub-$($baseline.Version)-Windows-setup.exe"
        Require (-not (Test-Path -LiteralPath $baselineInstaller)) 'Baseline installer path already exists.'
        Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v$($baseline.Version)/Creator-Hub-$($baseline.Version)-Windows-setup.exe" -OutFile $baselineInstaller -TimeoutSec 120
        Require ((Hash $baselineInstaller) -eq $baseline.Installer) 'Public baseline installer hash differs.'
        Run-Installer '/S /NS' 0 "Install verified public Hub $HubBaseline baseline" $baselineInstaller
        Require ((Hash (Join-Path $installed 'creator-hub.exe')) -eq $baseline.Exe) 'Public baseline installed executable differs.'
        Require ((Get-ItemProperty -LiteralPath $uninstallKey).DisplayVersion -eq $baseline.Version) 'Baseline installed version differs.'
    } else {
        Run-Installer '/S /NS' 0 'Clean Hub installation'
        Require ((Hash (Join-Path $installed 'creator-hub.exe')) -eq (Hash $expectedExe)) 'Installed Hub differs from extracted installer payload.'
    }
    $null = New-Item -ItemType Directory -Path $data
    [IO.File]::WriteAllText((Join-Path $data 'ci-settings-sentinel.json'), '{"preserve":"fixture"}')
    [IO.File]::WriteAllText((Join-Path $installed 'ci-unmanaged-sentinel.txt'), 'preserve fixture content')
    $before = Snapshot
    $fixture = Join-Path $output ('installed-guard-fixture-' + [Guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $fixture
    $fixtureExe = Join-Path $fixture 'creator-hub.exe'
    $stopFile = Join-Path $fixture 'stop'
    Copy-Item -LiteralPath (Get-Command node.exe).Source -Destination $fixtureExe
    $psi = [Diagnostics.ProcessStartInfo]::new($fixtureExe)
    $psi.Arguments = '"{0}" "{1}"' -f (Join-Path $PSScriptRoot 'owned-hub-fixture.cjs'), $stopFile
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $owned = [Diagnostics.Process]::Start($psi)
    $ready = $owned.StandardOutput.ReadLineAsync()
    Require ($ready.Wait(10000) -and $ready.Result -eq 'ready' -and -not $owned.WaitForExit(500)) 'Owned Hub fixture failed to stay alive.'
    Run-Installer ('/S /NS /UPDATE /D=' + $installed) 10 'Installed Hub update refuses an active Hub'
    Require (-not $owned.HasExited) 'Installer stopped the fixture.'
    Require ((Snapshot) -ceq $before) 'Blocked update changed installed files, settings or registration.'
    [IO.File]::WriteAllText($stopFile, 'exit')
    Require ($owned.WaitForExit(10000) -and $owned.ExitCode -eq 0) 'Owned fixture did not exit cooperatively.'
    Run-Installer ('/S /NS /UPDATE /D=' + $installed) 0 'Installed Hub update succeeds after cooperative exit'
    Require ((Hash (Join-Path $installed 'creator-hub.exe')) -eq (Hash $expectedExe)) 'Updated Hub differs from installer payload.'
    foreach ($name in @('LICENSE.txt', 'THIRD_PARTY_NOTICES.txt', 'rust-dependencies.json')) {
        Require ((Hash (Join-Path $installed ('licenses\' + $name))) -eq (Hash (Join-Path $output ('licenses\' + $name)))) "Installed license differs: $name"
    }
    Require ((Get-Content -LiteralPath (Join-Path $data 'ci-settings-sentinel.json') -Raw) -ceq '{"preserve":"fixture"}') 'Settings sentinel changed.'
    Require ((Get-Content -LiteralPath (Join-Path $installed 'ci-unmanaged-sentinel.txt') -Raw) -ceq 'preserve fixture content') 'Unmanaged sentinel changed.'
    Require ((Get-ItemProperty -LiteralPath $uninstallKey).DisplayVersion -eq $version) 'Installed version is incorrect.'
    $report.sameVersionUpdateTested = $HubBaseline -eq 'clean'
    $report.crossVersionUpdateTested = $HubBaseline -ne 'clean'
    $report.installedExecutableSha256 = Hash (Join-Path $installed 'creator-hub.exe')

    # Open the real packaged GUI on the disposable worker, not a metadata-only stub.
    $gui = Start-Process -FilePath (Join-Path $installed 'creator-hub.exe') -PassThru -WindowStyle Hidden
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        Start-Sleep -Milliseconds 250
        $gui.Refresh()
        Require (-not $gui.HasExited) "Installed Hub exited during startup: $($gui.ExitCode)."
    } while ($gui.MainWindowHandle -eq 0 -and [DateTime]::UtcNow -lt $deadline)
    Require ($gui.MainWindowHandle -ne 0) 'Installed Hub did not create its main window.'
    Require (-not $gui.WaitForExit(2000)) 'Installed Hub exited just after creating its window.'
    $report.guiStartupTested = $true
    $report.windowTitle = $gui.MainWindowTitle
    # Startup checks/downloads may still hold the app open; only request normal close.
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        [void]$gui.CloseMainWindow()
        if ($gui.WaitForExit(1000)) { break }
    } while ([DateTime]::UtcNow -lt $deadline)
    Require ($gui.HasExited -and $gui.ExitCode -eq 0) 'Hub did not close normally after startup.'
    $report.passed = $true
} catch {
    $report.error = $_.Exception.Message
    throw
} finally {
    if ($owned) {
        if (-not $owned.HasExited) { [IO.File]::WriteAllText($stopFile, 'exit'); [void]$owned.WaitForExit(10000) }
        if ($owned.HasExited) { $report.fixtureExitCode = $owned.ExitCode; $report.fixtureStderr = $owned.StandardError.ReadToEnd() }
        $owned.Dispose()
    }
    if ($gui) { if (-not $gui.HasExited) { [void]$gui.CloseMainWindow() }; $gui.Dispose() }
    $report.checks = @($checks.ToArray())
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'installed-acceptance.json') -Encoding UTF8
    # The disposable worker owns cleanup. Never delete product directories here.
}
