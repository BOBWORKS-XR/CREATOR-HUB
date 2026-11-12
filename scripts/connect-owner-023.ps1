param([ValidateRange(1,65535)][int]$ClientPort, [ValidateRange(1,65535)][int]$ProxyPort)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:GITHUB_REPOSITORY -cne 'BOBWORKS-XR/CREATOR-HUB' -or
    $env:GITHUB_REF -cne 'refs/heads/validation/windows-sdk-capability-023-20261112-r5' -or
    $env:GITHUB_JOB -cne 'acceptance') { throw 'Disposable diagnostic job required.' }
$rows = @(Get-NetTCPConnection -State Established -LocalPort $ClientPort -RemotePort $ProxyPort -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -eq '127.0.0.1' -and $_.RemoteAddress -eq '127.0.0.1' } |
    Select-Object -First 2)
$result = @($rows | ForEach-Object {
    $item = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$_.OwningProcess)
    if ($item -and $item.ExecutablePath) {
        @{ pid = [int]$item.ProcessId; parentPid = [int]$item.ParentProcessId; image = [string]$item.ExecutablePath }
    }
})
ConvertTo-Json -InputObject $result -Depth 3 -Compress
