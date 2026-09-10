param(
    [Parameter(Mandatory=$true)][int]$TargetPid,
    [Parameter(Mandatory=$true)][string]$ExpectedExecutable,
    [ValidateSet('snapshot','file','button','close')][string]$Action = 'snapshot',
    [string]$Value
)
$ErrorActionPreference = 'Stop'
$process = Get-Process -Id $TargetPid -ErrorAction Stop
if ([IO.Path]::GetFullPath($process.Path) -ine [IO.Path]::GetFullPath($ExpectedExecutable)) { throw 'Process identity changed.' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class NativeTestWindows {
    private delegate bool Visit(IntPtr h, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Visit cb, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr root, Visit cb, IntPtr data);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr h, StringBuilder value, int size);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetWindowText(IntPtr h, string value);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder value, int size);
    public static string Text(IntPtr h) { var value=new StringBuilder(32768); GetWindowText(h,value,value.Capacity); return value.ToString(); }
    public static string Class(IntPtr h) { var value=new StringBuilder(256); GetClassName(h,value,value.Capacity); return value.ToString(); }
    public static uint ProcessId(IntPtr h) { uint pid; GetWindowThreadProcessId(h,out pid); return pid; }
    public static IntPtr FileEdit(IntPtr root) {
        IntPtr result=IntPtr.Zero;
        EnumChildWindows(root,(h,_)=> { var name=new StringBuilder(256); GetClassName(h,name,256); if(GetDlgCtrlID(h)==1148 && name.ToString()=="Edit") result=h; return true; },IntPtr.Zero);
        return result;
    }
    public static IntPtr[] ForProcess(uint pid) {
        var result = new List<IntPtr>();
        EnumWindows((h, _) => { uint owner; GetWindowThreadProcessId(h, out owner); if(owner == pid) result.Add(h); return true; }, IntPtr.Zero);
        return result.ToArray();
    }
}
'@
$handles = [NativeTestWindows]::ForProcess($TargetPid)
if ($Action -eq 'close') {
    $closeHandles = @($handles | Where-Object { [NativeTestWindows]::Text($_) -like 'Creator Hub*' })
    if ($closeHandles.Count -ne 1) { throw 'Expected exactly one owned Creator Hub window to close.' }
    if (-not [NativeTestWindows]::PostMessage($closeHandles[0], 0x10, [IntPtr]::Zero, [IntPtr]::Zero)) { throw "Could not post the owned close request: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())." }
    'WM_CLOSE posted to the exact owned Hub window.'
    exit
}
if ($Action -eq 'file') {
    foreach ($handle in $handles) {
        $edit = [NativeTestWindows]::FileEdit($handle)
        if ($edit -eq [IntPtr]::Zero) { continue }
        if (-not [NativeTestWindows]::SetWindowText($edit, $Value)) { throw 'Could not set the native file picker path.' }
        if ([NativeTestWindows]::Text($edit) -ne $Value) { throw 'Native file picker path did not match.' }
        [void][NativeTestWindows]::PostMessage($handle, 0x111, [IntPtr]1, [IntPtr]::Zero)
        exit
    }
    throw 'Native file picker edit control was not found.'
}
$windows = @($handles | ForEach-Object { [Windows.Automation.AutomationElement]::FromHandle($_) })
if ($Action -eq 'snapshot') {
    $result = foreach ($window in $windows) {
        $children = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
        [PSCustomObject]@{ title = $window.Current.Name; handle = $window.Current.NativeWindowHandle; class = [NativeTestWindows]::Class([IntPtr]$window.Current.NativeWindowHandle); controls = @($children | ForEach-Object { [PSCustomObject]@{ name=$_.Current.Name; id=$_.Current.AutomationId; type=$_.Current.ControlType.ProgrammaticName; handle=$_.Current.NativeWindowHandle; processId=$_.Current.ProcessId; parent=[NativeTestWindows]::GetParent([IntPtr]$_.Current.NativeWindowHandle).ToInt64() } }) }
    }
    ConvertTo-Json -InputObject @($result) -Depth 4 -Compress
    exit
}
foreach ($window in $windows) {
    if ($Action -eq 'button') {
        $matchesByName = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Value))
        if ($matchesByName.Count -gt 1) { throw 'Requested dialog control is ambiguous.' }
        $button = if ($matchesByName.Count -eq 1) { $matchesByName[0] } else { $null }
        if ($null -ne $button) {
            if ($button.Current.AutomationId -match '^CommandButton_(1000|1001)$') {
                $id = [int]$Matches[1]
                $dialog = [IntPtr]$window.Current.NativeWindowHandle
                $titles = @{
                    'Install' = @('Install Creator app'); 'Cancel' = @('Install Creator app')
                    'Enable MCP controls' = @('Open MCP in Creator Hub?'); 'Open read-only preview' = @('Open MCP in Creator Hub?')
                    'Open in Hub' = @('Open Setup in Creator Hub?'); 'Not now' = @('Open MCP in Creator Hub?', 'Open Setup in Creator Hub?')
                    'Close view' = @('Close hosted app?'); 'Keep open' = @('Close hosted app?')
                }
                if (-not $titles.ContainsKey($Value) -or $window.Current.Name -cnotin $titles[$Value]) { throw 'Requested task dialog title does not match the expected action.' }
                if ([NativeTestWindows]::Class($dialog) -ne '#32770' -or [NativeTestWindows]::ProcessId($dialog) -ne $TargetPid -or $button.Current.ProcessId -ne $TargetPid) { throw 'Requested task dialog does not belong to the expected process.' }
                if (-not [NativeTestWindows]::IsWindowVisible($dialog) -or -not $button.Current.IsEnabled -or $button.Current.IsOffscreen) { throw 'Requested task dialog control is not ready.' }
                # RFD custom TaskDialog controls can share a proxy HWND. TDM_CLICK_BUTTON uses their observed UIA ID.
                if (-not [NativeTestWindows]::PostMessage($dialog, 0x466, [IntPtr]$id, [IntPtr]::Zero)) { throw "Could not invoke the owned task dialog button: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())." }
                exit
            }
            if ($button.Current.NativeWindowHandle -ne 0) {
                $control = [IntPtr]$button.Current.NativeWindowHandle
                $id = [NativeTestWindows]::GetDlgCtrlID($control)
                $parent = [NativeTestWindows]::GetParent($control)
                if ($id -le 0 -or $id -gt 65535 -or $parent -ne [IntPtr]$window.Current.NativeWindowHandle) { throw 'Requested button is not a direct owned dialog control.' }
                # BM_CLICK is unreliable for inactive hidden dialogs. Use the actual control ID.
                [void][NativeTestWindows]::PostMessage($parent, 0x111, [IntPtr]$id, $control)
            }
            else { $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke() }
            exit
        }
    }
}
throw "Requested test control was not found: $Action $Value"
