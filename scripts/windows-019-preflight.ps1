$ErrorActionPreference = 'Stop'
$files = @('native-window-019.ps1', 'native-self-update-lab-019.ps1', 'native-incoming-migration-owned-close-019.ps1')
foreach ($name in $files) {
    $file = Join-Path $PSScriptRoot $name
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw "PowerShell parse failed: $name" }
    if ($name -ceq 'native-self-update-lab-019.ps1') {
        $parameters = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
        foreach ($parameter in @('ContractPath', 'BaselineInstallerPath', 'TimeoutSeconds', 'CleanupWatch', 'Scenario', 'Incoming019', 'Outgoing019')) {
            if ($parameters -cnotcontains $parameter) { throw "Missing named argument: $parameter" }
        }
    }
}
Write-Output '019 PowerShell syntax and lifecycle named parameters verified; no native execution.'
