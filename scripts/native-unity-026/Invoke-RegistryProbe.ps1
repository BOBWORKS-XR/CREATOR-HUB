#Requires -Version 7.4
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $HelperPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $IsWindows -or [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
    throw 'This probe requires Windows x64.'
}
if ($env:CREATOR_HUB_026_DISPOSABLE_RUNNER -cne 'registry-only' -or
    -not (Test-Path -LiteralPath "$env:ProgramData\CreatorHub026-disposable-runner" -PathType Leaf)) {
    throw 'Refusing to run outside a provisioned disposable test runner.'
}

$expectedHash = '325c5f4d0a241121034e0c066b3d6169ef776cd33b73b1489d5c151440c77876'
$helper = Get-Item -LiteralPath $HelperPath
if ($helper -isnot [IO.FileInfo] -or $helper.Extension -ine '.exe' -or
    $helper.Length -ne 20835248 -or (Get-FileHash -LiteralPath $helper.FullName).Hash -ine $expectedHash) {
    throw 'Helper does not match the candidate Windows x64 beta.9 pin.'
}

$root = Join-Path $env:SystemDrive 'CreatorHub026RegistryProbe'
# Create once. Do not adopt or clean up an existing run directory.
$null = New-Item -ItemType Directory -Path $root
$project = Join-Path $root ('Registry Probe ' + [guid]::NewGuid().ToString('N'))
foreach ($dir in 'Assets', 'Packages', 'ProjectSettings') {
    $null = New-Item -ItemType Directory -Path (Join-Path $project $dir)
}
Set-Content -LiteralPath (Join-Path $project 'Packages/manifest.json') -Value '{"dependencies":{}}' -Encoding ascii
Set-Content -LiteralPath (Join-Path $project 'ProjectSettings/ProjectVersion.txt') -Encoding ascii -Value @(
    'm_EditorVersion: 6000.3.21f1'
    'm_EditorVersionWithRevision: 6000.3.21f1 (c02631ffc030)'
)

function Invoke-Helper([string] $Verb) {
    $start = [Diagnostics.ProcessStartInfo]::new($helper.FullName)
    $start.WorkingDirectory = $root
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.Environment['UNITY_NO_CONSENT_PROMPT'] = '1'
    foreach ($argument in @('projects', $Verb, $project, '--json', '--non-interactive', '--no-banner', '--no-pager')) {
        $start.ArgumentList.Add($argument)
    }
    $process = [Diagnostics.Process]::Start($start)
    try {
        $process.StandardInput.Close()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        $clock = [Diagnostics.Stopwatch]::StartNew()
        if (-not $process.WaitForExit(45000)) {
            $process.Kill($true)
            throw "Helper $Verb timed out; inspect the isolated runner before any retry."
        }
        $drains = [Threading.Tasks.Task[]] @($stdout, $stderr)
        if (-not [Threading.Tasks.Task]::WaitAll($drains, [Math]::Max(0, 45000 - [int]$clock.ElapsedMilliseconds))) {
            throw "Helper $Verb did not close its output streams."
        }
        $response = $null
        if ($process.ExitCode -eq 0 -and $stdout.Result.Length -le 4194304) {
            $response = ConvertFrom-Json -InputObject $stdout.Result -AsHashtable -ErrorAction SilentlyContinue
        }
        $exactMatches = $null
        if ($Verb -eq 'list' -and $response -is [Collections.IDictionary] -and
            $response['success'] -is [bool] -and $response['success'] -and $response['data'] -is [array]) {
            $exactMatches = @($response['data'] | Where-Object {
                $_ -is [Collections.IDictionary] -and $_['path'] -is [string] -and
                $_['path'].Replace('/', '\') -ieq $project
            }).Count
        }
        [ordered]@{ exitCode = $process.ExitCode; exactMatches = $exactMatches }
    } finally {
        $process.Dispose()
    }
}

$receipt = [ordered]@{
    scope = 'Registry-only; no desktop registration or Editor acceptance'
    completed = $false
    opened = $false
    helperSha256 = $expectedHash
    project = $project
    before = $null
    add = $null
    after = $null
}
try {
    $receipt.before = Invoke-Helper 'list'
    if ($null -eq $receipt.before.exactMatches -or $receipt.before.exactMatches -ne 0) {
        throw 'Before-list was not a successful JSON list with zero exact fixture matches.'
    }
    $receipt.add = Invoke-Helper 'add'
    $receipt.after = Invoke-Helper 'list'
    if ($receipt.add.exitCode -ne 0 -or $receipt.after.exactMatches -ne 1) {
        throw 'No clean absent-to-present transition. Do not retry on the same fixture.'
    }
    $receipt.completed = $true
} finally {
    $file = Join-Path $root 'registry-only.json'
    $receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $file -Encoding utf8
    Write-Host "Registry-only evidence: $file"
}
