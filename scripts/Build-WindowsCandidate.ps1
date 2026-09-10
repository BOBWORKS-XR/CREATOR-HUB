param([string]$OutputName = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if (-not $OutputName) { $OutputName = "Creator-Hub-$version-Windows-Candidate" }
& (Join-Path $PSScriptRoot 'Build-Installer.ps1') -OutputName $OutputName
$output = Join-Path $root "dist\$OutputName"
$installer = Join-Path $output "Creator-Hub-$version-Windows-setup.exe"
$extracted = Join-Path $output 'extracted'
$sevenZip = (Get-Command 7z.exe -ErrorAction SilentlyContinue).Source
if (-not $sevenZip) { $sevenZip = 'C:\Program Files\7-Zip\7z.exe' }
& $sevenZip x $installer ('-o' + $extracted) '-y' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Installer extraction failed.' }
$installedExe = Join-Path $extracted 'creator-hub.exe'
if (-not (Test-Path -LiteralPath $installedExe -PathType Leaf)) { throw 'Installer launcher payload is missing.' }
$guard = (& (Join-Path $PSScriptRoot 'Test-InstallerGuard.ps1') | Out-String) | ConvertFrom-Json
if (-not $guard.passed) { throw 'The installer running-app guard failed.' }
$report = [ordered]@{
    version = $version
    installerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    executableSha256 = (Get-FileHash -LiteralPath $installedExe -Algorithm SHA256).Hash.ToLowerInvariant()
    guard = $guard
    installedUpgradeTested = $false
    selfUpdateTested = $false
    publicationReady = $false
}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'candidate-report.json') -Encoding UTF8
$files = Get-ChildItem -LiteralPath $output -Recurse -File | Where-Object { $_.Name -ne 'SHA256SUMS.txt' }
$hashes = foreach ($file in $files) {
    $relative = $file.FullName.Substring($output.Length + 1).Replace('\', '/')
    "$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $relative"
}
$hashes | Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt') -Encoding ascii
Write-Output ($report | ConvertTo-Json -Depth 6)
