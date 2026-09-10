param([string]$OutputName = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$version = (Get-Content -LiteralPath (Join-Path $root 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version
if (-not $OutputName) { $OutputName = "Creator-Hub-$version-Windows" }
if ($OutputName -notmatch '^Creator-Hub-[A-Za-z0-9.-]+$' -or $OutputName.Contains('..')) { throw 'Choose a simple Creator-Hub output name.' }
$output = Join-Path $root "dist\$OutputName"
if (Test-Path -LiteralPath $output) { throw 'Installer output already exists. Choose a new name; existing artifacts are immutable.' }
$variables = @('CREATOR_SETUP_HOST_SHA256', 'CREATOR_MCP_HOST_SHA256', 'CREATOR_MCP_HOST_READONLY_EVENTS', 'CREATOR_MCP_HOST_WRITABLE')
$saved = @{}
try {
    # The installer ships only Hub. Development payload pins must never leak in.
    foreach ($key in $variables) { $saved[$key] = [Environment]::GetEnvironmentVariable($key); [Environment]::SetEnvironmentVariable($key, $null) }
    Push-Location $root
    try { & npm.cmd run build -- --bundles nsis; if ($LASTEXITCODE -ne 0) { throw 'Hub installer build failed.' } } finally { Pop-Location }
    $target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $root 'src-tauri\target' }
    $installer = Join-Path $target "release\bundle\nsis\Creator Hub_${version}_x64-setup.exe"
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'Expected versioned NSIS artifact was not produced.' }
    [void](New-Item -ItemType Directory -Path $output)
    Copy-Item -LiteralPath $installer -Destination (Join-Path $output "Creator-Hub-${version}-Windows-setup.exe")
    Copy-Item -LiteralPath (Join-Path $target 'release\creator-hub.exe') -Destination $output
    Copy-Item -LiteralPath (Join-Path $root 'docs\INSTALLABLE-PREVIEW.md') -Destination (Join-Path $output 'README.md')
    $hashes = Get-ChildItem -LiteralPath $output -File | ForEach-Object { "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.Name)" }
    $hashes | Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Encoding ascii
    Write-Output $output
    Write-Output $hashes
} finally {
    foreach ($key in $variables) { [Environment]::SetEnvironmentVariable($key, $saved[$key]) }
}
