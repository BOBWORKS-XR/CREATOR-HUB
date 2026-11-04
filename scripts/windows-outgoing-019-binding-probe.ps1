param([string]$ScriptPath = (Join-Path $PSScriptRoot 'native-self-update-outgoing-019.ps1'))
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0 -or $null -eq $ast.ParamBlock) { throw 'Actual outgoing script parsing failed.' }
$processErrors = $null; $processTokens = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'native-outgoing-process-019.ps1'), [ref]$processTokens, [ref]$processErrors)
if ($processErrors.Count -ne 0) { throw 'Outgoing process inventory parsing failed.' }
# Execute only its real parameter declaration, never the native lifecycle body.
$body = @'
[pscustomobject]@{ContractPath=$ContractPath;BaselineInstallerPath=$BaselineInstallerPath;TimeoutSeconds=$TimeoutSeconds;Outgoing019=$Outgoing019.IsPresent;Scenario=$Scenario}
'@
$probe = [scriptblock]::Create($ast.ParamBlock.Extent.Text + "`n" + $body)
$parameters = @{Outgoing019=$true;ContractPath='C:\ci-probe\contract.json';BaselineInstallerPath='C:\ci-probe\baseline.exe';TimeoutSeconds=480}
$bound = & $probe @parameters
if ($bound.ContractPath -cne $parameters.ContractPath -or $bound.BaselineInstallerPath -cne $parameters.BaselineInstallerPath -or
    $bound.TimeoutSeconds -ne 480 -or $bound.Outgoing019 -ne $true -or $bound.Scenario -cne 'public-stable') {
    throw 'Actual outgoing named-parameter binding failed.'
}
[pscustomobject]@{parserErrors=0;parsedScripts=2;namedParametersBound=$true;nativeBodyExecuted=$false} | ConvertTo-Json -Compress
