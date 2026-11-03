param(
    [Parameter(Mandatory=$true)][int]$TargetPid,
    [Parameter(Mandatory=$true)][string]$StartTicks,
    [Parameter(Mandatory=$true)][string]$ExpectedExecutable
)
$ErrorActionPreference = 'Stop'
$requested = $false
$process = $null
try {
    if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
        $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ARCH -cne 'X64' -or
        $env:GITHUB_REPOSITORY -cne 'BOBWORKS-XR/CREATOR-HUB' -or $env:GITHUB_REPOSITORY_ID -cne '1364807512' -or
        $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:GITHUB_JOB -cne 'incoming-migration' -or
        $env:GITHUB_REF -cne 'refs/heads/validation/windows-menu-merge-20261027' -or
        $env:GITHUB_WORKFLOW_REF -cne 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-017-production.yml@refs/heads/validation/windows-menu-merge-20261027' -or
        $env:CREATOR_PRODUCTION_017_MIGRATION -cne '1' -or $env:GITHUB_RUN_ATTEMPT -cne '1' -or
        $env:GITHUB_SHA -cnotmatch '^[a-f0-9]{40}$' -or $env:GITHUB_SHA -cne $env:CREATOR_PRODUCTION_017_SOURCE) {
        throw 'Runner admission refused.'
    }
    if ($TargetPid -le 0 -or $StartTicks -cnotmatch '^[1-9][0-9]{0,18}$' -or
        $ExpectedExecutable -cnotmatch '^[A-Za-z]:\\' -or $env:LOCALAPPDATA -cnotmatch '^[A-Za-z]:\\') {
        throw 'Invalid captured identity.'
    }
    $expected = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Creator Hub/creator-hub.exe'))
    if ([IO.Path]::GetFullPath($ExpectedExecutable) -ine $expected) { throw 'Unexpected executable.' }
    if ((Get-FileHash -LiteralPath $expected -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'ae1d15ff3919ee9947e21d8542bcab50abf044e1bf047ce2c87abac4ccebfdc9') {
        throw 'R8 executable differs.'
    }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class IncomingMigrationOwnedWindow {
  private delegate bool Visit(IntPtr h, IntPtr data);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool QueryFullProcessImageName(SafeProcessHandle process, int flags, StringBuilder image, ref int size);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Visit callback, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder value, int size);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder value, int size);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr window, uint message, IntPtr w, IntPtr l);
  public static IntPtr[] Windows(uint pid) {
    var result = new List<IntPtr>();
    EnumWindows((window, data) => { uint owner; GetWindowThreadProcessId(window, out owner); if (owner == pid) result.Add(window); return true; }, IntPtr.Zero);
    return result.ToArray();
  }
}
'@
    $process = [Diagnostics.Process]::GetProcessById($TargetPid)
    $handle = $process.SafeHandle
    $image = [Text.StringBuilder]::new(32768); $size = $image.Capacity
    if ($process.HasExited -or $process.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) -cne $StartTicks -or
        -not [IncomingMigrationOwnedWindow]::QueryFullProcessImageName($handle, 0, $image, [ref]$size) -or
        [IO.Path]::GetFullPath($image.ToString()) -ine $expected) { throw 'Captured process identity differs.' }
    $windows = @([IncomingMigrationOwnedWindow]::Windows([uint32]$TargetPid) | Where-Object {
        $class = [Text.StringBuilder]::new(256); $title = [Text.StringBuilder]::new(1024)
        [void][IncomingMigrationOwnedWindow]::GetClassName($_, $class, $class.Capacity)
        [void][IncomingMigrationOwnedWindow]::GetWindowText($_, $title, $title.Capacity)
        $class.ToString() -ceq 'Tauri Window' -and $title.ToString() -cin @('Creator Hub - Development Preview', 'Creator Hub 0.1.16 - Settings Upgrade Test 2026-10-27')
    })
    if ($windows.Count -ne 1 -or $process.HasExited -or
        $process.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) -cne $StartTicks) { throw 'Owned window unavailable.' }
    $owner = [uint32]0
    [void][IncomingMigrationOwnedWindow]::GetWindowThreadProcessId($windows[0], [ref]$owner)
    if ($owner -ne $TargetPid -or -not [IncomingMigrationOwnedWindow]::PostMessage($windows[0], 0x10, [IntPtr]::Zero, [IntPtr]::Zero)) {
        throw 'Owned close request refused.'
    }
    $requested = $true
    if (-not $process.WaitForExit(30000)) { throw 'Owned process exit unverified.' }
    [ordered]@{kind='incoming-migration-owned-close-only'; state='verified'; pid=$TargetPid; startTicks=$StartTicks;
        executable=$expected; exitCode=$process.ExitCode; migrationContinuationAvailable=$false; releaseReady=$false} | ConvertTo-Json -Compress
    if ($process.ExitCode -ne 0) { exit 1 }
} catch {
    [ordered]@{kind='incoming-migration-owned-close-only'; state='unknown'; closeRequested=$requested;
        migrationContinuationAvailable=$false; releaseReady=$false} | ConvertTo-Json -Compress
    exit 1
} finally { if ($process) { $process.Dispose() } }
