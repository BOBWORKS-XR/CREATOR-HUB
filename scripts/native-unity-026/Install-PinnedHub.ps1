#Requires -Version 7.4
[CmdletBinding()]
param([Parameter(Mandatory)][ValidateSet('4.0.1','3.21.1')][string] $Version)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ARCH -cne 'X64' -or
    $env:GITHUB_REPOSITORY -cne 'BOBWORKS-XR/CREATOR-HUB' -or
    $env:GITHUB_REF -cne 'refs/heads/codex/windows-unity-hub-026-acceptance') {
    throw 'Use only the reviewed, disposable Windows CI job.'
}

$root = Join-Path $env:RUNNER_TEMP 'CreatorHub026-install-probe'
$null = New-Item -Path $root -ItemType Directory
$asset = if ($Version -eq '4.0.1') { "UnityHubSetup-$Version-x64.msix" } else { "UnityHubSetup-$Version-x64.exe" }
$expected = if ($Version -eq '4.0.1') { '18eadb4b68330e4cff7b8e8241e3713a6b7fafe112ab51d7a24f086bdd35f18f' } else { '9f62430abe9cd88f73b813118ef5a6634618c275a3f3e5df7128226cc489a63b' }
$installer = Join-Path $root $asset
Invoke-WebRequest -Uri "https://public-cdn.cloud.unity3d.com/hub/prod/$Version/$asset" -OutFile $installer -TimeoutSec 120
if ((Get-FileHash -LiteralPath $installer).Hash -ine $expected) { throw 'Unity Hub download hash mismatch.' }
$signature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Unity Technologies') {
    throw 'Unity Hub installer signature did not verify.'
}
if ($Version -eq '4.0.1') {
    Import-Module Appx -UseWindowsPowerShell
    if (Get-AppxPackage -Name UnityTechnologies.UnityHub) { throw 'Expected a clean Hub 4 runner.' }
    Add-AppxPackage -Path $installer
    $pkg = @(Get-AppxPackage -Name UnityTechnologies.UnityHub)
    if ($pkg.Count -ne 1 -or $pkg[0].Version.ToString() -cne '4.0.1.65535' -or
        $pkg[0].PackageFamilyName -cne 'UnityTechnologies.UnityHub_2vrhnee42bhxm') { throw 'Wrong installed Hub 4 package.' }
} else {
    $hub = Join-Path $env:ProgramFiles 'Unity Hub\Unity Hub.exe'
    if (Test-Path -LiteralPath $hub) { throw 'Expected a clean Hub 3 runner.' }
    $process = Start-Process -FilePath $installer -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
    $installedVersion = (Get-Item -LiteralPath $hub).VersionInfo.ProductVersion
    if ($process.ExitCode -ne 0 -or $installedVersion -notmatch '^3\.21\.1(?:\.65535)?$') { throw 'Wrong installed Hub 3 executable.' }
}

$helper = Join-Path $root 'unity-windows-x64.exe'
Invoke-WebRequest -Uri 'https://public-cdn.cloud.unity3d.com/hub/prod/cli/1.0.0-beta.9/unity-windows-x64.exe' -OutFile $helper -TimeoutSec 120
$null = New-Item -Path "$env:ProgramData\CreatorHub026-disposable-runner" -ItemType File
$env:CREATOR_HUB_026_DISPOSABLE_RUNNER = 'registry-only'
Write-Output "Pinned Unity Hub $Version installed. Running independent CLI registry probe, not a desktop or Editor test."
& (Join-Path $PSScriptRoot 'Invoke-RegistryProbe.ps1') -HelperPath $helper
