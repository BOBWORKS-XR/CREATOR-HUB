$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows) { throw 'Windows pwsh 7 required.' }
$workflow = Join-Path $PSScriptRoot '../.github/workflows/windows-017-production.yml'
$blocks = @()
$name = ''
$lines = [IO.File]::ReadAllLines($workflow)
for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i] -match '^      - name: (.+)$') { $name = $Matches[1] }
    if ($lines[$i] -eq '        run: |') {
        $body = @()
        while ($i + 1 -lt $lines.Length -and $lines[$i + 1].StartsWith('          ')) {
            $i++; $body += $lines[$i].Substring(10)
        }
        $blocks += [pscustomobject]@{ Name = $name; Code = ($body -join "`n") }
    }
}
if ($blocks.Count -lt 5) { throw 'Workflow PowerShell blocks were not captured.' }
foreach ($block in $blocks) {
    $tokens = $null; $errors = $null
    [void][Management.Automation.Language.Parser]::ParseInput($block.Code, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ($errors | Out-String) }
}
$files = @('native-self-update-lab-017.ps1', 'native-incoming-migration-owned-close-017.ps1', 'preflight-powershell.ps1')
$lifecycleAst = $null
foreach ($file in $files) {
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ($errors | Out-String) }
    if ($file -eq 'native-self-update-lab-017.ps1') { $lifecycleAst = $ast }
}
$lifecycle = @($blocks | Where-Object Name -CEQ 'Actual signed update and automatic restart with production metadata')
if ($lifecycle.Count -ne 1) { throw 'Exact incoming invocation unavailable.' }
if (-not $lifecycle[0].Code.Contains('native-self-update-lab-017.ps1 @parameters')) { throw 'Named parameter splat required.' }
$assertions = @'
if ($TimeoutSeconds -ne 480 -or -not $ContractPath.EndsWith('config.json') -or -not $BaselineInstallerPath.EndsWith('baseline.exe')) { throw 'Named parameter value mismatch.' }
if ($Incoming017.IsPresent -ne ($env:CREATOR_PRODUCTION_017_BASELINE -ceq '0.1.14')) { throw 'Incoming switch mismatch.' }
if ($CleanupWatch -or $Outgoing017 -or $Scenario -cne 'public-stable') { throw 'Unexpected lifecycle mode.' }
'@
$functionText = 'function Test-Binding {' + $lifecycleAst.ParamBlock.Extent.Text + "`n" + $assertions + "`n}"
$tokens = $null; $errors = $null
[void][Management.Automation.Language.Parser]::ParseInput($functionText, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
. ([scriptblock]::Create($functionText))
$probe = $lifecycle[0].Code.Replace('& ./scripts/native-self-update-lab-017.ps1', 'Test-Binding').Replace('| Tee-Object artifacts/production-017-control/lifecycle.jsonl', '| Out-Null')
$saved = $env:CREATOR_PRODUCTION_017_BASELINE
try {
    foreach ($version in @('0.1.12', '0.1.14')) {
        $env:CREATOR_PRODUCTION_017_BASELINE = $version
        $global:LASTEXITCODE = 0
        & ([scriptblock]::Create($probe))
    }
} finally { $env:CREATOR_PRODUCTION_017_BASELINE = $saved }
[pscustomobject]@{ passed = $true; powershellProcess = $PID; astFiles = $files.Count; workflowBlocks = $blocks.Count; namedBindingCases = 2; productExecuted = $false } | ConvertTo-Json -Compress
