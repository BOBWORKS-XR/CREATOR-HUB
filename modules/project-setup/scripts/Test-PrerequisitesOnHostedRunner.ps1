$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or $env:CREATOR_SETUP_ACCEPT_TEST_LICENSES -ne 'true') {
    throw 'This installation test requires an approved disposable GitHub-hosted Windows runner.'
}
$repo = Split-Path $PSScriptRoot -Parent
$stdout = Join-Path $repo 'prerequisite-install.log'
$stderr = Join-Path $repo 'prerequisite-install.stderr.log'
$activity = Join-Path $repo 'prerequisite-activity.ndjson'
$command = (Get-Command cargo.exe -CommandType Application).Source
$child = Start-Process -FilePath $command -WorkingDirectory $repo -ArgumentList @(
    'test', '--release', '--locked', '--manifest-path', 'src-tauri/Cargo.toml',
    'bootstrap::tests::disposable_install_smoke', '--', '--ignored', '--exact', '--nocapture'
) -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr

function Read-NewOutput([string]$Path, [ref]$Position) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        [void]$stream.Seek($Position.Value, [IO.SeekOrigin]::Begin)
        $reader = [IO.StreamReader]::new($stream)
        $text = $reader.ReadToEnd()
        $Position.Value = $stream.Position
        if ($text.Length -gt 0) { Write-Host $text.TrimEnd() }
    } finally { $stream.Dispose() }
}

$outPosition = 0L
$errPosition = 0L
$lastCapture = [DateTime]::MinValue
while (-not $child.WaitForExit(1000)) {
    Read-NewOutput $stdout ([ref]$outPosition)
    Read-NewOutput $stderr ([ref]$errPosition)
    if (((Get-Date) - $lastCapture).TotalSeconds -lt 30) { continue }
    $lastCapture = Get-Date
    # Read only this disposable test's Unity/installer metadata. Never log command
    # lines, environment values, account records, or unrelated process details.
    $processes = @(Get-Process | Where-Object { $_.ProcessName -like 'Unity*' -or $_.Id -eq $child.Id } | ForEach-Object {
        [ordered]@{ name=$_.ProcessName; pid=$_.Id; cpuSeconds=$_.CPU; responding=$_.Responding; window=$_.MainWindowTitle }
    })
    $cache = Join-Path $env:APPDATA 'UnityHub/downloads'
    $files = @()
    if (Test-Path -LiteralPath $cache -PathType Container) {
        $files = @(Get-ChildItem -LiteralPath $cache -File -Depth 2 | Select-Object -First 30 | ForEach-Object {
            [ordered]@{ name=$_.Name; bytes=$_.Length; modifiedUtc=$_.LastWriteTimeUtc.ToString('o') }
        })
    }
    $editor = Join-Path $env:ProgramFiles 'Unity/Hub/Editor/6000.3.21f1/Editor/Unity.exe'
    $sample = [ordered]@{
        atUtc=[DateTime]::UtcNow.ToString('o'); processes=$processes; downloads=$files
        editorPresent=(Test-Path -LiteralPath $editor -PathType Leaf)
        systemFreeBytes=(Get-PSDrive -Name ([IO.Path]::GetPathRoot($env:ProgramFiles)).TrimEnd('\', ':')).Free
    } | ConvertTo-Json -Depth 5 -Compress
    Add-Content -LiteralPath $activity -Value $sample -Encoding utf8
    Write-Host "INSTALL_ACTIVITY $sample"
}
$child.WaitForExit()
Read-NewOutput $stdout ([ref]$outPosition)
Read-NewOutput $stderr ([ref]$errPosition)
$code = $child.ExitCode
$child.Dispose()
exit $code
