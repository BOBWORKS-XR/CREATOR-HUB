param(
    [string]$SetupSource = (Join-Path $PSScriptRoot '..\..\CREATOR-PROJECT-SETUP'),
    [string]$McpPreview = '',
    [string]$McpSha256 = '',
    [switch]$McpLifecyclePreview,
    [switch]$McpWritablePreview,
    [string]$OutputName = ''
)
$ErrorActionPreference = 'Stop'
$hub = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($OutputName -and $OutputName -notmatch '^Creator-Hub-[A-Za-z0-9-]+$') { throw 'OutputName must be a Creator-Hub name inside dist, not a path.' }
$setup = [IO.Path]::GetFullPath($SetupSource)
if (-not (Test-Path -LiteralPath (Join-Path $setup 'src-tauri\Cargo.toml'))) { throw 'Project Setup source was not found.' }
$oldTarget = $env:CARGO_TARGET_DIR
$oldHash = $env:CREATOR_SETUP_HOST_SHA256
$oldMcpHash = $env:CREATOR_MCP_HOST_SHA256
$oldMcpEvents = $env:CREATOR_MCP_HOST_READONLY_EVENTS
$oldMcpWritable = $env:CREATOR_MCP_HOST_WRITABLE
if ([bool]$McpPreview -ne [bool]$McpSha256) { throw 'Supply both -McpPreview and -McpSha256, or neither.' }
if ($McpLifecyclePreview -and -not $McpPreview) { throw 'Lifecycle preview requires an explicitly hash-pinned MCP preview.' }
if ($McpWritablePreview -and -not $McpPreview) { throw 'Writable preview requires an explicitly hash-pinned MCP with its server payload.' }
$output = Join-Path $hub $(if ($McpPreview) { 'dist\Creator-Hub-Hosted-Apps-Preview' } else { 'dist\Creator-Hub-Hosted-Setup-Preview' })
if ($OutputName) { $output = Join-Path (Join-Path $hub 'dist') $OutputName }
if (Test-Path -LiteralPath $output) { throw 'Preview output already exists. Choose a new OutputName; existing pairs are immutable.' }
if ($McpPreview) {
    $McpPreview = (Resolve-Path -LiteralPath $McpPreview).Path
    if ($McpSha256 -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $McpPreview -Algorithm SHA256).Hash -ne $McpSha256) { throw 'MCP preview hash did not match. Nothing was built or copied.' }
    $server = Join-Path (Split-Path -Parent $McpPreview) 'server'
    if ($McpWritablePreview) {
        foreach ($file in @('creator-works-mcp.mjs', 'runtime/node.exe', 'runtime/LICENSE', 'runtime/VERSION', 'unity-extension/Editor/BanterMCPBridge.cs', 'unity-extension/Editor/CreatorWorksMCPLogo.png', 'LICENSE', 'THIRD_PARTY_NOTICES.md')) {
            if (-not (Test-Path -LiteralPath (Join-Path $server $file) -PathType Leaf)) { throw "Missing MCP payload: $file" }
        }
        foreach ($item in @(Get-Item -LiteralPath $server) + @(Get-ChildItem -LiteralPath $server -Recurse -Force)) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'MCP payload cannot contain links or junctions.' }
        }
    }
}
try {
    $env:CREATOR_MCP_HOST_SHA256 = $McpSha256.ToLowerInvariant()
    $env:CREATOR_MCP_HOST_READONLY_EVENTS = $(if ($McpLifecyclePreview) { '1' } else { '' })
    $env:CREATOR_MCP_HOST_WRITABLE = $(if ($McpWritablePreview) { '1' } else { '' })
    $env:CARGO_TARGET_DIR = Join-Path $setup 'src-tauri\target'
    Push-Location $setup
    try { & npm.cmd run build -- --no-bundle; if ($LASTEXITCODE -ne 0) { throw 'Setup build failed.' } } finally { Pop-Location }
    $setupExe = Join-Path $env:CARGO_TARGET_DIR 'release\creator-project-setup.exe'
    $env:CREATOR_SETUP_HOST_SHA256 = (Get-FileHash -LiteralPath $setupExe -Algorithm SHA256).Hash.ToLowerInvariant()
    Push-Location $hub
    try { & npm.cmd run build -- --no-bundle; if ($LASTEXITCODE -ne 0) { throw 'Hub build failed.' } } finally { Pop-Location }
    [void](New-Item -ItemType Directory -Path $output)
    Copy-Item -LiteralPath $setupExe -Destination (Join-Path $output 'creator-project-setup.exe') -Force
    Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release\creator-hub.exe') -Destination (Join-Path $output 'creator-hub.exe') -Force
    if ($McpPreview) {
        $mcpDirectory = Join-Path $output 'apps\mcp'
        [void](New-Item -ItemType Directory -Path $mcpDirectory -Force)
        $mcpDestination = Join-Path $mcpDirectory 'creator-works-mcp-launcher.exe'
        Copy-Item -LiteralPath $McpPreview -Destination $mcpDestination -Force
        if ((Get-FileHash -LiteralPath $mcpDestination -Algorithm SHA256).Hash -ne $McpSha256) { throw 'Copied MCP failed verification. Do not use this preview.' }
        if ($McpWritablePreview) { Copy-Item -LiteralPath $server -Destination (Join-Path $mcpDirectory 'server') -Recurse }
    }
    Copy-Item -LiteralPath (Join-Path $hub 'docs\HOSTED-PREVIEW.md') -Destination (Join-Path $output 'README.md') -Force
    $hashes = @(Get-ChildItem -LiteralPath $output -Filter '*.exe' | ForEach-Object { $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); "$hash  $($_.Name)" })
    if ($McpPreview) { $hashes += "$($McpSha256.ToLowerInvariant())  apps/mcp/creator-works-mcp-launcher.exe" }
    if ($McpWritablePreview) {
        $hashes += @(Get-ChildItem -LiteralPath (Join-Path $output 'apps/mcp/server') -File -Recurse | ForEach-Object {
            $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            "$hash  $($_.FullName.Substring($output.Length + 1).Replace('\', '/'))"
        })
    }
    $hashes | Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Encoding ascii
    Write-Output "Built preview pair: $output"
    Write-Output $hashes
} finally {
    $env:CARGO_TARGET_DIR = $oldTarget
    $env:CREATOR_SETUP_HOST_SHA256 = $oldHash
    $env:CREATOR_MCP_HOST_SHA256 = $oldMcpHash
    $env:CREATOR_MCP_HOST_READONLY_EVENTS = $oldMcpEvents
    $env:CREATOR_MCP_HOST_WRITABLE = $oldMcpWritable
}
