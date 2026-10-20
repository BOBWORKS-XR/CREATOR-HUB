param(
    [Parameter(Mandatory=$true)][int]$TargetPid,
    [Parameter(Mandatory=$true)][string]$Executable,
    [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedSha256,
    [ValidateSet('state','close','cancel')][string]$Action = 'state',
    [long]$DialogHandle = 0
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') { throw 'Native lifecycle acceptance requires a disposable GitHub-hosted Windows runner.' }
$process = Get-Process -Id $TargetPid -ErrorAction Stop
if ([IO.Path]::GetFullPath($process.Path) -ine [IO.Path]::GetFullPath($Executable)) { throw 'Native lifecycle process identity changed.' }
if ((Get-FileHash -LiteralPath $Executable).Hash.ToLowerInvariant() -cne $ExpectedSha256) { throw 'Unapproved lifecycle executable.' }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SetupLifecycleWindow {
    private delegate bool Visit(IntPtr h, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Visit cb, IntPtr data);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr h, string name);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr h, StringBuilder value, int size);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder value, int size);
    public static string Text(IntPtr h) { var value=new StringBuilder(1024); GetWindowText(h,value,value.Capacity); return value.ToString(); }
    public static string Class(IntPtr h) { var value=new StringBuilder(256); GetClassName(h,value,value.Capacity); return value.ToString(); }
    public static IntPtr[] ForProcess(uint expected) {
        var found = new List<IntPtr>();
        EnumWindows((h, _) => { uint pid; GetWindowThreadProcessId(h, out pid); if (pid == expected) found.Add(h); return true; }, IntPtr.Zero);
        return found.ToArray();
    }
}
'@
$windows = @([SetupLifecycleWindow]::ForProcess($TargetPid))
$handles = @($windows | Where-Object { [SetupLifecycleWindow]::GetProp($_,'CreatorSuite.LifecycleProtocol').ToInt64() -eq 1 })
if ($handles.Count -ne 1) { throw 'Expected one exact owned lifecycle window.' }
$hwnd = $handles[0]
$dialogs = @($windows | Where-Object { [SetupLifecycleWindow]::Class($_) -ceq '#32770' -and [SetupLifecycleWindow]::IsWindowVisible($_) })
if ($Action -eq 'close' -and -not [SetupLifecycleWindow]::PostMessage($hwnd,0x10,[IntPtr]::Zero,[IntPtr]::Zero)) { throw 'WM_CLOSE could not be posted.' }
if ($Action -eq 'cancel') {
    if ($dialogs.Count -ne 1 -or $dialogs[0].ToInt64() -ne $DialogHandle) { throw 'Observed owned chooser identity changed or is ambiguous.' }
    $dialog = $dialogs[0]
    $owner = [SetupLifecycleWindow]::GetWindow($dialog,4)
    # Tauri's unparented blocking picker may have no owner; the exact app PID is still required.
    if ($owner -ne [IntPtr]::Zero -and $owner -ne $hwnd) { throw 'Chooser has an unexpected owner.' }
    $cancel = [SetupLifecycleWindow]::GetDlgItem($dialog,2)
    [uint32]$controlPid = 0
    $null = [SetupLifecycleWindow]::GetWindowThreadProcessId($cancel,[ref]$controlPid)
    if ($cancel -eq [IntPtr]::Zero -or $controlPid -ne $TargetPid -or [SetupLifecycleWindow]::GetParent($cancel) -ne $dialog -or [SetupLifecycleWindow]::Text($cancel) -cne 'Cancel' -or -not [SetupLifecycleWindow]::IsWindowEnabled($cancel)) { throw 'Exact native Cancel control is not ready.' }
    if (-not [SetupLifecycleWindow]::PostMessage($dialog,0x111,[IntPtr]2,$cancel)) { throw 'Native chooser cancellation failed.' }
}
[pscustomobject]@{
    pid=$TargetPid; hwnd=$hwnd.ToInt64()
    protocol=[SetupLifecycleWindow]::GetProp($hwnd,'CreatorSuite.LifecycleProtocol').ToInt64()
    busy=[SetupLifecycleWindow]::GetProp($hwnd,'CreatorSuite.LauncherBusy').ToInt64()
    closing=[SetupLifecycleWindow]::GetProp($hwnd,'CreatorSuite.Closing').ToInt64()
    dialogs=@($dialogs | ForEach-Object { [pscustomobject]@{handle=$_.ToInt64();title=[SetupLifecycleWindow]::Text($_);class=[SetupLifecycleWindow]::Class($_);owner=[SetupLifecycleWindow]::GetWindow($_,4).ToInt64()} })
} | ConvertTo-Json -Depth 4 -Compress
