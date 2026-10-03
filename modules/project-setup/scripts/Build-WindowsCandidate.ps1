param(
    [string]$TargetDirectory,
    [string]$OutputDirectory,
    [string]$SevenZip = "$env:ProgramFiles\7-Zip\7z.exe"
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Windows x64 is required.' }
$repo = Split-Path $PSScriptRoot -Parent
if (-not $TargetDirectory) { $TargetDirectory = Join-Path $repo 'dist\prerelease-target' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repo ("dist\windows-candidate-" + [Guid]::NewGuid().ToString('N')) }
$TargetDirectory = [IO.Path]::GetFullPath($TargetDirectory)
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$sharedTarget = [IO.Path]::GetFullPath((Join-Path $repo 'src-tauri\target'))
if ($TargetDirectory.TrimEnd('\') -eq $sharedTarget.TrimEnd('\')) { throw 'Use a dedicated candidate target, not the shared src-tauri/target.' }
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Output already exists; choose a new directory.' }
if (-not (Test-Path -LiteralPath $SevenZip -PathType Leaf)) { throw '7-Zip is required for extraction; the installer is never run.' }
$version = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
& node -e 'process.exit(require(process.argv[1]).validVersion(process.argv[2]) ? 0 : 1)' (Join-Path $PSScriptRoot 'verify-windows-candidate.cjs') $version
if ($LASTEXITCODE -ne 0) { throw 'Use a canonical stable or prerelease version without build metadata.' }
[void](New-Item -ItemType Directory -Path $OutputDirectory)
$originalTarget = $env:CARGO_TARGET_DIR
$env:CARGO_TARGET_DIR = $TargetDirectory
Push-Location $repo
try {
    $noticesTool = Join-Path $repo 'dist\notices-tool'
    $pin = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'notices-tool.json') -Raw | ConvertFrom-Json
    $revision = & git -C $noticesTool rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $revision -cne $pin.revision) { throw 'Checkout the pinned notices tool under dist/notices-tool before packaging.' }
    $toolDiff = & git -C $noticesTool diff HEAD --name-only
    if ($LASTEXITCODE -ne 0 -or $toolDiff) { throw 'The pinned notice tooling checkout has changes.' }
    $licenses = Join-Path $OutputDirectory 'licenses'
    & node (Join-Path $noticesTool 'scripts\collect-rust-notices.cjs') (Join-Path $repo 'src-tauri\Cargo.toml') (Join-Path $repo 'LICENSE') $licenses (Join-Path $repo 'src\icons\LICENSE-lucide') (Join-Path $repo 'docs\THIRD-PARTY-ASSETS.md')
    if ($LASTEXITCODE -ne 0) { throw 'Original dependency license collection failed.' }
    $resources = [ordered]@{}
    foreach ($name in @('LICENSE.txt', 'THIRD_PARTY_NOTICES.txt', 'rust-dependencies.json')) {
        $resources[(Join-Path $licenses $name)] = 'licenses/' + $name
    }
    # Release-only resources keep ordinary development independent of generated notices.
    $overlay = Join-Path $OutputDirectory 'tauri-notices.json'
    @{ bundle = @{ resources = $resources } } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $overlay -Encoding utf8NoBOM
    & node node_modules/@tauri-apps/cli/tauri.js build --config $overlay --ci --no-sign --no-bundle -- --locked 2>&1 | Tee-Object -FilePath (Join-Path $OutputDirectory 'portable-build.log')
    if ($LASTEXITCODE -ne 0) { throw 'Portable candidate build failed.' }
    $portable = Join-Path $OutputDirectory 'portable-before-bundling.exe'
    Copy-Item -LiteralPath (Join-Path $TargetDirectory 'release\creator-project-setup.exe') -Destination $portable
    & node node_modules/@tauri-apps/cli/tauri.js build --config $overlay --ci --no-sign --bundles nsis -- --locked 2>&1 | Tee-Object -FilePath (Join-Path $OutputDirectory 'installer-build.log')
    if ($LASTEXITCODE -ne 0) { throw 'NSIS candidate build failed.' }
    $installer = Join-Path $TargetDirectory "release\bundle\nsis\Creator Project Setup_${version}_x64-setup.exe"
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'Expected versioned x64 installer is missing.' }
    $guardOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Test-InstallerGuard.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'No-install guard fixture failed.' }
    $guardReport = [string]($guardOutput | Select-Object -Last 1)
    & node (Join-Path $PSScriptRoot 'verify-windows-candidate.cjs') --installer $installer --portable $portable --seven-zip $SevenZip --output (Join-Path $OutputDirectory 'candidate') --guard-report $guardReport --licenses $licenses
    if ($LASTEXITCODE -ne 0) { throw 'Candidate artifact verification failed.' }
    Write-Output "Candidate evidence: $OutputDirectory"
} finally {
    Pop-Location
    $env:CARGO_TARGET_DIR = $originalTarget
}
