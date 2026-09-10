$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Native startup diagnostics are restricted to a disposable GitHub-hosted Windows runner.'
}
$result = [ordered]@{
    processes = @(Get-CimInstance Win32_Process -Filter "Name = 'creator-hub.exe' OR Name = 'msedgewebview2.exe'" | Select-Object ProcessId,ParentProcessId,SessionId,ExecutablePath,CommandLine)
    listeners = @(Get-NetTCPConnection -LocalPort 9238 -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,State,OwningProcess)
    policies = @()
}
foreach ($path in @('HKLM:\SOFTWARE\Policies\Microsoft\Edge', 'HKCU:\SOFTWARE\Policies\Microsoft\Edge', 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2', 'HKCU:\SOFTWARE\Policies\Microsoft\Edge\WebView2')) {
    if (Test-Path -LiteralPath $path) {
        $key = Get-Item -LiteralPath $path
        $result.policies += [PSCustomObject]@{ path = $path; remoteDebuggingAllowed = $key.GetValue('RemoteDebuggingAllowed'); developerToolsAvailability = $key.GetValue('DeveloperToolsAvailability') }
    }
}
$result | ConvertTo-Json -Depth 5 -Compress
