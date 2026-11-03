param([string]$ScriptPath = (Join-Path $PSScriptRoot 'native-self-update-outgoing-018.ps1'))
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0 -or $null -eq $ast.ParamBlock) { throw 'Actual outgoing script parsing failed.' }
# Execute only its real parameter declaration, never the native lifecycle body.
$body = @'
[pscustomobject]@{ContractPath=$ContractPath;BaselineInstallerPath=$BaselineInstallerPath;TimeoutSeconds=$TimeoutSeconds;Outgoing018=$Outgoing018.IsPresent;Scenario=$Scenario}
'@
$probe = [scriptblock]::Create($ast.ParamBlock.Extent.Text + "`n" + $body)
$parameters = @{Outgoing018=$true;ContractPath='C:\ci-probe\contract.json';BaselineInstallerPath='C:\ci-probe\baseline.exe';TimeoutSeconds=480}
$bound = & $probe @parameters
if ($bound.ContractPath -cne $parameters.ContractPath -or $bound.BaselineInstallerPath -cne $parameters.BaselineInstallerPath -or
    $bound.TimeoutSeconds -ne 480 -or $bound.Outgoing018 -ne $true -or $bound.Scenario -cne 'public-stable') {
    throw 'Actual outgoing named-parameter binding failed.'
}
[pscustomobject]@{parserErrors=0;namedParametersBound=$true;nativeBodyExecuted=$false} | ConvertTo-Json -Compress
