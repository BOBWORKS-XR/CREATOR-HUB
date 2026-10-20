# Fixed preset only. The shared owner must add this preset without changing the public12 default.
param([string]$ContractPath = '', [string]$BaselineInstallerPath = '', [int]$TimeoutSeconds = 480)
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') {
    [Console]::Error.WriteLine('Outgoing lab refused: disposable GitHub-hosted Windows runner required.')
    exit 1
}
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows) { throw 'Windows pwsh 7 required.' }
$lifecycle = Join-Path $PSScriptRoot 'native-self-update-lab.ps1'
$command = Get-Command -Name $lifecycle -CommandType ExternalScript
if (-not $command.Parameters.ContainsKey('Scenario')) { throw 'Owner integration required: fixed unified-outgoing-14-15 lifecycle preset.' }
& $lifecycle -Scenario 'unified-outgoing-14-15' -ContractPath $ContractPath -BaselineInstallerPath $BaselineInstallerPath -TimeoutSeconds $TimeoutSeconds
exit $LASTEXITCODE
