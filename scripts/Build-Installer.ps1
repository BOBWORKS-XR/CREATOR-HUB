param([string]$OutputName = '', [string]$HostedPins = '')
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
    # Ignore ambient developer pins. Only a reviewed, explicit receipt can enable hosting.
    foreach ($key in $variables) { $saved[$key] = [Environment]::GetEnvironmentVariable($key); [Environment]::SetEnvironmentVariable($key, $null) }
    $pins = $null
    if ($HostedPins) {
        $pins = Get-Content -LiteralPath $HostedPins -Raw | ConvertFrom-Json
        if ($pins.schemaVersion -ne 1) { throw 'Unsupported hosted acceptance receipt.' }
        foreach ($app in @('setup', 'mcp')) {
            $entry = $pins.$app
            if ($entry.executableSha256 -cnotmatch '^[a-f0-9]{64}$' -or $entry.installerSha256 -cnotmatch '^[a-f0-9]{64}$' -or
                $entry.acceptanceRun -notmatch '^[0-9]+$' -or -not $entry.version -or -not $entry.assetName) { throw "Incomplete accepted $app package receipt." }
        }
        $env:CREATOR_SETUP_HOST_SHA256 = $pins.setup.executableSha256
        $env:CREATOR_MCP_HOST_SHA256 = $pins.mcp.executableSha256
        $env:CREATOR_MCP_HOST_WRITABLE = '1'
    }
    [void](New-Item -ItemType Directory -Path $output)
    $licenses = Join-Path $output 'licenses'
    & node (Join-Path $PSScriptRoot 'collect-rust-notices.cjs') (Join-Path $root 'src-tauri\Cargo.toml') (Join-Path $root 'LICENSE') $licenses (Join-Path $root 'src\icons\LICENSE-lucide') (Join-Path $root 'THIRD_PARTY_NOTICES.md')
    if ($LASTEXITCODE -ne 0) { throw 'Dependency notice collection failed.' }
    $resources = [ordered]@{}
    foreach ($name in @('LICENSE.txt', 'THIRD_PARTY_NOTICES.txt', 'rust-dependencies.json')) { $resources[(Join-Path $licenses $name)] = 'licenses/' + $name }
    $overlay = Join-Path $output 'tauri-notices.json'
    $json = @{ bundle = @{ resources = $resources } } | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText($overlay, $json, [Text.UTF8Encoding]::new($false))
    Push-Location $root
    try { & npm.cmd run build -- --bundles nsis --config $overlay -- --locked; if ($LASTEXITCODE -ne 0) { throw 'Hub installer build failed.' } } finally { Pop-Location }
    $target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $root 'src-tauri\target' }
    $installer = Join-Path $target "release\bundle\nsis\Creator Hub_${version}_x64-setup.exe"
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'Expected versioned NSIS artifact was not produced.' }
    if ($HostedPins) { Copy-Item -LiteralPath $HostedPins -Destination (Join-Path $output 'hosted-pins.json') }
    Copy-Item -LiteralPath $installer -Destination (Join-Path $output "Creator-Hub-${version}-Windows-setup.exe")
    Copy-Item -LiteralPath (Join-Path $target 'release\creator-hub.exe') -Destination $output
    Copy-Item -LiteralPath (Join-Path $root 'docs\INSTALLABLE-PREVIEW.md') -Destination (Join-Path $output 'README.md')
    Copy-Item -LiteralPath (Join-Path $root 'docs\HOTFIX-ALPHA5.md') -Destination $output
    $hashes = Get-ChildItem -LiteralPath $output -File | ForEach-Object { "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.Name)" }
    $hashes | Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Encoding ascii
    Write-Output $output
    Write-Output $hashes
} finally {
    foreach ($key in $variables) { [Environment]::SetEnvironmentVariable($key, $saved[$key]) }
}
