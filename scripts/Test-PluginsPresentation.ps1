param([string[]]$UnityVersions = @('2022.3.39f1', '6000.3.21f1'))
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
foreach ($version in $UnityVersions) {
    $project = Join-Path $root ('artifacts\plugins-media-' + $version + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
    $editor = Join-Path 'C:\Program Files\Unity\Hub\Editor' "$version\Editor\Unity.exe"
    if (-not (Test-Path -LiteralPath $editor)) { throw "Missing test Editor: $version" }
    New-Item -ItemType Directory -Path "$project\Assets\Editor\PluginTests","$project\Packages","$project\ProjectSettings" | Out-Null
    Copy-Item "$root\scripts\unity\manifest.json" "$project\Packages\manifest.json"
    Copy-Item "$root\unity\com.creatorworks.plugins" "$project\Packages" -Recurse
    Copy-Item "$root\scripts\unity\CreatorPluginsPresentationSmoke.cs","$root\scripts\unity\CreatorWorks.Plugins.Editor.Tests.asmdef" "$project\Assets\Editor\PluginTests"
    Copy-Item "$root\tests\fixtures\community\start-location.json" "$project\listing.json"
    [IO.File]::WriteAllText("$project\.presentation-test-fixture", 'disposable gallery test')
    [IO.File]::WriteAllText("$project\ProjectSettings\ProjectVersion.txt", "m_EditorVersion: $version`n")
    $process = Start-Process -FilePath $editor -ArgumentList @('-batchmode','-projectPath',('"' + $project + '"'),'-executeMethod','CreatorPluginsPresentationSmoke.Run','-logFile',('"' + "$project\batch.log" + '"')) -WindowStyle Hidden -PassThru
    $lockObserved = $false
    $probeDeadline = [DateTime]::UtcNow.AddSeconds(30)
    while (-not $process.HasExited -and [DateTime]::UtcNow -lt $probeDeadline -and -not $lockObserved) {
        $lock = Join-Path $project 'Temp\UnityLockfile'
        if (Test-Path -LiteralPath $lock) {
            try {
                $probe = [IO.File]::Open($lock, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
                $probe.Dispose()
            } catch {
                $exception = $_.Exception
                while ($exception.InnerException) { $exception = $exception.InnerException }
                if (($exception.HResult -band 0xffff) -in @(32,33)) { $lockObserved = $true }
                else { throw }
            }
        }
        if (-not $lockObserved) { Start-Sleep -Milliseconds 100 }
    }
    if (-not $process.WaitForExit(240000)) { throw "Disposable test still running at $project (PID $($process.Id)); inspect its log before closing it." }
    if (-not $lockObserved) { throw "Live Unity lock ownership was not observed: $project" }
    if (-not (Test-Path "$project\presentation-result.json")) { throw "Missing test result: $project\batch.log" }
    $report = Get-Content "$project\presentation-result.json" -Raw | ConvertFrom-Json
    if (-not $report.passed) { throw "Gallery test failed: $($report.error)" }
    Write-Output "$version passed $($report.checks.Count) Editor checks; live Editor lock denied exclusive access: $project\presentation-result.json"
}
