param([Parameter(Mandatory)][string]$Folder)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $Folder).ProviderPath
$temp = Join-Path $root 'temp'
$env:TEMP = $temp
$env:TMP = $temp
$env:CREATOR_HUB_GUARD_FIXTURE_ROOT = $root
$fixture = Join-Path $root 'transient-guard-fixture.exe'
$targetFile = Join-Path $root 'lock-target.txt'
$marker = Join-Path $root 'lock-held.txt'
$process = Start-Process -FilePath $fixture -ArgumentList '/S' -PassThru -WindowStyle Hidden
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $target = ''
    while (-not $target -and -not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        try { $target = [IO.File]::ReadAllText($targetFile) } catch [IO.IOException] { Start-Sleep -Milliseconds 50 }
    }
    if ($target -notmatch '^[A-Za-z]:\\') { throw 'Fixture target not received.' }
    $fullTarget = [IO.Path]::GetFullPath($target)
    if (-not $fullTarget.StartsWith($temp + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($fullTarget) -ne 'creator-hub-preflight.exe') { throw 'Fixture target escaped its temporary directory.' }
    $held = [IO.File]::Open($fullTarget, 'Open', 'Read', 'None')
    try {
        [IO.File]::WriteAllText($marker, 'locked')
        Start-Sleep -Milliseconds 1800
    } finally {
        $held.Dispose()
    }
    if (-not $process.WaitForExit(18000)) { throw 'Fixture did not complete after releasing the lock.' }
    exit $process.ExitCode
} finally {
    if (-not $process.HasExited) {
        $process.Kill()
        $process.WaitForExit()
    }
    $process.Dispose()
}
