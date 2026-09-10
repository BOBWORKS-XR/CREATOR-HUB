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
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr root, Visit cb, IntPtr data);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr h, StringBuilder value, int size);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetWindowText(IntPtr h, string value);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder value, int size);
    public static string Text(IntPtr h) { var value=new StringBuilder(32768); GetWindowText(h,value,value.Capacity); return value.ToString(); }
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
    foreach ($handle in $handles) {
        if ([NativeTestWindows]::Text($handle) -like 'Creator Hub*') { [void][NativeTestWindows]::PostMessage($handle, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) }
    }
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
        [PSCustomObject]@{ title = $window.Current.Name; handle = $window.Current.NativeWindowHandle; controls = @($children | ForEach-Object { [PSCustomObject]@{ name=$_.Current.Name; id=$_.Current.AutomationId; type=$_.Current.ControlType.ProgrammaticName } }) }
    }
    ConvertTo-Json -InputObject @($result) -Depth 4 -Compress
    exit
}
foreach ($window in $windows) {
    if ($Action -eq 'button') {
        $button = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $Value))
        if ($null -ne $button) {
            if ($button.Current.NativeWindowHandle -ne 0) { [void][NativeTestWindows]::PostMessage([IntPtr]$button.Current.NativeWindowHandle, 0xF5, [IntPtr]::Zero, [IntPtr]::Zero) }
            else { $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke() }
            exit
        }
    }
}
throw "Requested test control was not found: $Action $Value"
