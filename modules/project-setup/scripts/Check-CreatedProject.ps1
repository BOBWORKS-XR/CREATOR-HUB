param(
    [Parameter(Mandatory)][string]$ProjectPath,
    [Parameter(Mandatory)][string]$UnityExe,
    [switch]$ConfigureVisualScripting
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $ProjectPath).Path
$statusFolder = Join-Path $root '.creator-project-setup'
$receipt = Get-Content -LiteralPath (Join-Path $statusFolder 'setup-receipt.json') -Raw | ConvertFrom-Json
if ($receipt.projectPath -ne $root) { throw 'The setup receipt does not belong to this project.' }
if (Test-Path -LiteralPath (Join-Path $root 'Temp\UnityLockfile')) { throw 'Close this Unity project before checking it.' }
if (!(Test-Path -LiteralPath $UnityExe -PathType Leaf)) { throw 'Unity executable not found.' }
$validator = Join-Path $root 'Assets\Editor\CreatorProjectSetupValidator.cs'
if (Test-Path -LiteralPath $validator) { throw 'A validator already exists. It was not overwritten.' }
$audit = Join-Path $statusFolder ('audit-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $audit | Out-Null
$settings = Join-Path $root 'ProjectSettings\VisualScriptingSettings.asset'
if (Test-Path -LiteralPath $settings) { Copy-Item -LiteralPath $settings -Destination $audit }

function Get-ProtectedHashes {
    $files = Get-ChildItem -LiteralPath (Join-Path $root 'Assets'),(Join-Path $root 'Packages'),(Join-Path $root 'ProjectSettings') -File -Recurse |
        Where-Object { $_.Extension -in '.unity','.prefab','.mat' -or $_.DirectoryName -eq (Join-Path $root 'Packages') -or ($_.DirectoryName -eq (Join-Path $root 'ProjectSettings') -and $_.Name -ne 'VisualScriptingSettings.asset') }
    @($files | Sort-Object FullName | ForEach-Object { [pscustomobject]@{ path=$_.FullName.Substring($root.Length); hash=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } })
}
$before = Get-ProtectedHashes
$before | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $audit 'protected-before.json')
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\src-tauri\src\ProjectSetupValidator.cs') -Raw
$versions = @{
    EDITOR_VERSION=$receipt.recipe.editorVersion
    CREATOR_SDK_VERSION=$receipt.recipe.creatorSdkVersion
    URP_VERSION=$receipt.recipe.urpVersion
    INPUT_SYSTEM_VERSION=$receipt.recipe.inputSystemVersion
}
foreach ($key in $versions.Keys) {
    $value = [string]$versions[$key]
    if ($value -notmatch '^[0-9A-Za-z.]+$') { throw "Invalid recipe value: $key" }
    $source = $source.Replace("@@$key@@", $value)
}
if ($source.Contains('@@')) { throw 'Unresolved validation template marker.' }
[IO.File]::WriteAllText($validator, $source)

function Invoke-UnityCheck([string]$Method) {
    $log = Join-Path $audit ($Method.ToLowerInvariant() + '.log')
    $arguments = '-batchmode -nographics -projectPath "{0}" -buildTarget Android -executeMethod CreatorWorks.ProjectSetupValidator.{1} -logFile "{2}"' -f $root,$Method,$log
    $process = Start-Process -FilePath $UnityExe -ArgumentList $arguments -PassThru -WindowStyle Hidden
    if (!$process.WaitForExit(1800000)) {
        $process.Kill()
        $process.WaitForExit()
        throw "Unity timed out. See $log"
    }
    if ($process.ExitCode -ne 0) { throw "Unity $Method failed ($($process.ExitCode)). See $log" }
}
try {
    if ($ConfigureVisualScripting) { Invoke-UnityCheck 'Configure' }
    Invoke-UnityCheck 'Validate'
    $validation = Get-Content -LiteralPath (Join-Path $statusFolder 'unity-validation.json') -Raw | ConvertFrom-Json
    if (!$validation.success) { throw 'Project validation failed.' }
    $after = Get-ProtectedHashes
    $after | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $audit 'protected-after.json')
    $changes = @(Compare-Object $before $after -Property path,hash)
    [pscustomobject]@{ validation=$validation; protectedFileCount=$before.Count; protectedFilesUnchanged=($changes.Count -eq 0); changes=$changes } |
        ConvertTo-Json -Depth 8 | Tee-Object -FilePath (Join-Path $audit 'audit-result.json')
    if ($changes.Count) { throw 'Protected files changed. Review the audit before continuing.' }
}
finally {
    Remove-Item -LiteralPath $validator -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath ($validator + '.meta') -ErrorAction SilentlyContinue
}
