# Read-only, finite disposable-runner inventory. No command lines, environment or process actions.
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or $env:RUNNER_OS -cne 'Windows') {
    [Console]::Error.WriteLine('Outgoing process capture refused: disposable GitHub-hosted Windows runner required.')
    exit 1
}
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OutgoingProcessImage {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder image, ref int size);
}
'@
$names = "Name = 'creator-hub.exe' OR Name = 'creator-project-setup.exe' OR Name = 'creator-works-mcp-launcher.exe' OR Name = 'creator-hub-mcp-router.exe' OR Name = 'node.exe'"
$entries = @(Get-CimInstance Win32_Process -Filter $names)
if ($entries.Count -gt 128) { throw 'Outgoing process count exceeds finite bound.' }
$records = foreach ($entry in $entries) {
    $process = $null
    try {
        $process = [Diagnostics.Process]::GetProcessById($entry.ProcessId)
        $handle = $process.SafeHandle
        $startTicks = $process.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
        # CIM's creation timestamp exposes microseconds; retain the full kernel ticks below.
        if ($process.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmss.ffffff') -cne $entry.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmss.ffffff')) { throw 'CIM/kernel start identity differs.' }
        $image = [Text.StringBuilder]::new(32768); $length = $image.Capacity
        if (-not [OutgoingProcessImage]::QueryFullProcessImageName($handle.DangerousGetHandle(), 0, $image, [ref]$length)) {
            throw 'Kernel image unavailable.'
        }
        if ($process.HasExited -or $process.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) -cne $startTicks -or
            [IO.Path]::GetFullPath($entry.ExecutablePath) -ine [IO.Path]::GetFullPath($image.ToString())) { throw 'Process identity changed during capture.' }
        [PSCustomObject]@{ pid = [int]$entry.ProcessId; parentPid = [int]$entry.ParentProcessId; startTicks = $startTicks;
            image = $image.ToString(); kernelIdentityVerified = $true }
    } finally { if ($process) { $process.Dispose() } }
}
ConvertTo-Json -InputObject @($records) -Depth 3 -Compress
