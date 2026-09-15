param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This local installer baseline requires Windows.' }
$root = Split-Path $PSScriptRoot -Parent
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root ('artifacts\upgrade-baseline-' + [guid]::NewGuid().ToString('N')) }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Baseline output exists; never replace earlier evidence.' }
$apps = @(
    @{ Name='Creator Hub'; Exe='creator-hub.exe' },
    @{ Name='Creator Project Setup'; Exe='creator-project-setup.exe' },
    @{ Name='Creator Works MCP'; Exe='creator-works-mcp-launcher.exe' }
)
$inventory = foreach ($app in $apps) {
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $app.Name
    $registration = if (Test-Path -LiteralPath $key) { Get-ItemProperty -LiteralPath $key } else { $null }
    $directory = Join-Path $env:LOCALAPPDATA $app.Name
    $exe = Join-Path $directory $app.Exe
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Expected installed app unavailable: $exe" }
    $item = Get-Item -LiteralPath $exe
    [ordered]@{name=$app.Name; path=$exe; executableVersion=$item.VersionInfo.ProductVersion; registeredVersion=$registration.DisplayVersion; registeredLocation=$registration.InstallLocation; sha256=(Get-FileHash -LiteralPath $exe).Hash.ToLowerInvariant()}
}
$files = @(
    (Join-Path $env:LOCALAPPDATA 'CreatorHub\creator-project-setup.json'),
    (Join-Path $env:LOCALAPPDATA 'CreatorHub\creator-works-mcp.json'),
    (Join-Path $env:LOCALAPPDATA 'CreatorHub\projects.json'),
    (Join-Path $env:APPDATA 'creator-works-mcp\launcher-config.json'),
    (Join-Path $env:APPDATA 'creator-works-mcp\hosted-operation-outcomes.json'),
    (Join-Path $env:APPDATA 'banter-mcp\launcher-config.json')
)
New-Item -ItemType Directory -Path $OutputDirectory | Out-Null
$records = foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { [ordered]@{path=$file; existed=$false}; continue }
    $item = Get-Item -LiteralPath $file
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 4MB) { throw "Unexpected settings file: $file" }
    $before = (Get-FileHash -LiteralPath $file).Hash
    $saved = Join-Path $OutputDirectory ([guid]::NewGuid().ToString('N') + '.backup')
    Copy-Item -LiteralPath $file -Destination $saved
    $after = (Get-FileHash -LiteralPath $file).Hash
    if ($before -ne $after -or $before -ne (Get-FileHash -LiteralPath $saved).Hash) { throw 'Settings changed during capture. Preserve this partial capture and make a new baseline when idle.' }
    [ordered]@{path=$file; existed=$true; backup=(Split-Path $saved -Leaf); sha256=$before.ToLowerInvariant()}
}
$processes = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('creator-hub.exe','creator-project-setup.exe','creator-works-mcp-launcher.exe') -or
    ($_.Name -eq 'node.exe' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith((Join-Path $env:LOCALAPPDATA 'Creator Works MCP\'), [StringComparison]::OrdinalIgnoreCase))
} | Select-Object ProcessId,Name,ExecutablePath
$report = [ordered]@{capturedUtc=[DateTime]::UtcNow.ToString('o'); inventory=@($inventory); settings=@($records); running=@($processes); appsReplaced=$false; publicationAuthorized=$false; note='Known JSON settings only; no authentication files or browser profile copied. Re-capture when apps are idle immediately before installation.'}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'baseline.json') -Encoding utf8NoBOM
[ordered]@{baseline=$OutputDirectory; installed=@($inventory | ForEach-Object { $_.name + ' ' + $_.executableVersion }); settingsBackedUp=@($records | Where-Object {$_.existed}).Count; activeProcesses=@($processes).Count; installerPreflightStillRequired=$true} | ConvertTo-Json -Depth 3
