param(
    [Parameter(Mandatory=$true)][string]$Installer,
    [Parameter(Mandatory=$true)][string]$OutputDirectory,
    [ValidateSet('first-dialog-cancel', 'silent-observe')][string]$Mode = 'first-dialog-cancel'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$admission = @{
    GITHUB_ACTIONS='true'; RUNNER_ENVIRONMENT='github-hosted'; RUNNER_OS='Windows'; RUNNER_ARCH='X64'
    GITHUB_REPOSITORY='BOBWORKS-XR/CREATOR-HUB'; CREATOR_LEGACY_PREFLIGHT_PROBE='1'
}
foreach ($key in $admission.Keys) {
    if ([Environment]::GetEnvironmentVariable($key) -cne $admission[$key]) { throw 'Disposable legacy-probe admission required.' }
}
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Disposable x64 Windows runner required.' }

function AssertPlainPath([string]$Path) {
    $part = [IO.Path]::GetFullPath($Path)
    while ($part) {
        $item = Get-Item -LiteralPath $part -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Redirected diagnostic path refused.' }
        $part = [IO.Path]::GetDirectoryName($part)
    }
}
$artifacts = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\artifacts')).TrimEnd('\') + '\'
$Installer = [IO.Path]::GetFullPath($Installer)
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $Installer.StartsWith($artifacts, [StringComparison]::OrdinalIgnoreCase) -or
    -not $OutputDirectory.StartsWith($artifacts, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($Installer) -cne 'Creator.Works.MCP_2.7.7_x64-setup.exe' -or
    [IO.Path]::GetFileName($OutputDirectory) -notmatch '\Alegacy-preflight-[A-Za-z0-9]+\z') {
    throw 'Owned public installer and diagnostic directory required.'
}
AssertPlainPath $Installer
AssertPlainPath $OutputDirectory
if (-not (Get-Item -LiteralPath $OutputDirectory).PSIsContainer -or
    @(Get-ChildItem -LiteralPath $OutputDirectory -Force).Count -ne 0) { throw 'New empty diagnostic directory required.' }
$installDirectory = Join-Path $env:LOCALAPPDATA 'Creator Works MCP'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Creator Works MCP'
$productKey = 'HKCU:\Software\Creator Works\Creator Works MCP'
if ((Test-Path -LiteralPath $installDirectory) -or (Test-Path -LiteralPath $uninstallKey) -or
    (Test-Path -LiteralPath $productKey)) { throw 'Fresh disposable MCP baseline required; no retry or existing install inspection.' }

$receipt = [ordered]@{
    scope=if ($Mode -ceq 'silent-observe') {'unchanged-public-277-silent-observation-only'} else {'unchanged-public-277-first-dialog-cancel-only'}
    mode=$Mode; nativeInstallDirectory=$installDirectory; freshNamespaceVerified=$true
    installerSha256='fa0b0ebc39043bf276de73763d380c001c84d1efd24dca9f9c2427b120a5afe0'
    installerBytes=27059109; installerPid=$null; installerStart=$null; installerIs64Bit=$null; firstDialog=$null; laterDialogs=@()
    classification='not-observed'; powerShellChildren=@(); observerError=$null
    cancelPosted=$false; confirmationPosted=$false; installerExited=$false; installerExitCode=$null
    defaultDirectoryAbsent=$true; uninstallRegistrationAbsent=$true; productRegistrationAbsent=$true; installerBytesUnchanged=$false; error=$null
    originalNsExecReturnCaptured=$false; originalPowerShellModulesCaptured=$false
    installerRerun=$false; processesKilled=$false; installAccepted=$false; releaseReady=$false
}
function ErrorIdentity($Record) {
    return [ordered]@{ type=$Record.Exception.GetType().FullName; hresult=$Record.Exception.HResult }
}
$image = $null; $algorithm = $null; $installerProcess = $null; $subscription = $null; $stopSubscription = $null
$sourceIdentifier = 'CreatorLegacyPreflight-' + [Guid]::NewGuid().ToString('N')
$stopIdentifier = $sourceIdentifier + '-Stop'
try {
    # Keep the immutable public input open without write/delete sharing throughout observation.
    $image = [IO.File]::Open($Installer, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    if ($image.Length -ne $receipt.installerBytes -or
        [BitConverter]::ToString($algorithm.ComputeHash($image)).Replace('-','').ToLowerInvariant() -cne $receipt.installerSha256) {
        throw 'Exact public 2.7.7 installer bytes required.'
    }
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class LegacyPreflightWitness {
    private delegate bool Visit(IntPtr h, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Visit cb, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr root, Visit cb, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr h);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr h, StringBuilder text, int size);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool PostMessage(IntPtr h, uint message, IntPtr w, IntPtr l);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder text, ref uint size);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool IsWow64Process(IntPtr h, out bool wow64);
    [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr h);
    public static uint Owner(IntPtr h) { uint pid; GetWindowThreadProcessId(h,out pid); return pid; }
    public static string Class(IntPtr h) { var text=new StringBuilder(256); GetClassName(h,text,text.Capacity); return text.ToString(); }
    public static IntPtr[] Dialogs(uint pid) {
        var result=new List<IntPtr>();
        EnumWindows((h,_)=> { if(Owner(h)==pid && IsWindowVisible(h) && Class(h)=="#32770") result.Add(h); return true; },IntPtr.Zero);
        return result.ToArray();
    }
    public static bool Button(IntPtr dialog, uint pid, int id, bool post) {
        if(Owner(dialog)!=pid || Class(dialog)!="#32770" || !IsWindowVisible(dialog) || (id!=2 && id!=6)) return false;
        IntPtr control=IntPtr.Zero;
        EnumChildWindows(dialog,(h,_)=> { if(GetParent(h)==dialog && Owner(h)==pid && GetDlgCtrlID(h)==id && Class(h)=="Button" && IsWindowVisible(h) && IsWindowEnabled(h)) control=h; return true; },IntPtr.Zero);
        return control!=IntPtr.Zero && (!post || PostMessage(dialog,0x111,(IntPtr)id,control));
    }
    public static string[] Image(uint pid, long startedBy = long.MaxValue) {
        IntPtr handle=OpenProcess(0x1000,false,pid);
        if(handle==IntPtr.Zero) return new[]{null,null,"process-query-unavailable"};
        try {
            long created, exited, kernel, user;
            if(!GetProcessTimes(handle,out created,out exited,out kernel,out user) || created>startedBy) return new[]{null,null,"process-start-identity-unavailable"};
            var text=new StringBuilder(32768); uint size=(uint)text.Capacity; bool wow64;
            if(!QueryFullProcessImageName(handle,0,text,ref size) || !IsWow64Process(handle,out wow64)) return new[]{null,null,"process-image-or-bitness-unavailable"};
            return new[]{text.ToString(),wow64 ? "32" : "64",null};
        } finally { CloseHandle(handle); }
    }
}
'@
    function ReadDialog([IntPtr]$Handle) {
        if ([LegacyPreflightWitness]::Owner($Handle) -ne $receipt.installerPid) { throw 'Dialog owner changed.' }
        $window = [Windows.Automation.AutomationElement]::FromHandle($Handle)
        $title = $window.Current.Name
        if ($title.Length -gt 4096) { throw 'Dialog title exceeds its bound.' }
        $children = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
        if ($children.Count -gt 128) { throw 'Dialog control count exceeds its bound.' }
        $controls = @(); $total = $title.Length
        foreach ($child in $children) {
            $current = $child.Current
            if ($current.ProcessId -ne $receipt.installerPid) { throw 'Foreign dialog control refused.' }
            $total += $current.Name.Length
            if ($current.Name.Length -gt 8192 -or $total -gt 32768) { throw 'Dialog text exceeds its bound.' }
            $controls += [ordered]@{ name=$current.Name; id=$current.AutomationId; type=$current.ControlType.ProgrammaticName; processId=$current.ProcessId }
        }
        return [ordered]@{ title=$title; handle=$Handle.ToInt64(); class=[LegacyPreflightWitness]::Class($Handle); processId=$receipt.installerPid; controls=@($controls) }
    }
    function ReadStarts {
        foreach ($event in @(Get-Event -SourceIdentifier $sourceIdentifier -ErrorAction SilentlyContinue)) {
            try {
                $started = $event.SourceEventArgs.NewEvent
                # Do not inspect command lines or images of unrelated processes.
                if ([int]$started.ParentProcessID -ne $receipt.installerPid -or $started.ProcessName -ine 'powershell.exe') { continue }
                if ($receipt.powerShellChildren.Count -ge 8) { throw 'Installer child observation exceeds its bound.' }
                $details = [LegacyPreflightWitness]::Image([uint32]$started.ProcessID, [long]$started.TIME_CREATED)
                $hash = $null
                $known = @((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'),
                    (Join-Path $env:SystemRoot 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'))
                if ($null -ne $details[0] -and $details[0] -iin $known) {
                    $hash = (Get-FileHash -LiteralPath $details[0] -Algorithm SHA256).Hash.ToLowerInvariant()
                }
                $receipt.powerShellChildren += [ordered]@{ pid=[int]$started.ProcessID; parentPid=[int]$started.ParentProcessID
                    observedAt=[DateTime]::FromFileTimeUtc([long]$started.TIME_CREATED).ToString('o')
                    image=$details[0]; imageSha256=$hash; is64Bit=if ($null -eq $details[1]) {$null} else {$details[1] -eq '64'}
                    observationError=$details[2]; stoppedAt=$null; exitStatus=$null }
            } catch { $receipt.observerError = ErrorIdentity $_ }
            finally { Remove-Event -EventIdentifier $event.EventIdentifier -ErrorAction SilentlyContinue }
        }
    }
    function ReadStops {
        foreach ($event in @(Get-Event -SourceIdentifier $stopIdentifier -ErrorAction SilentlyContinue)) {
            try {
                $stopped = $event.SourceEventArgs.NewEvent
                # Retain only this installer's observed direct PowerShell children, never unrelated stop metadata.
                $child = @($receipt.powerShellChildren | Where-Object { $_.pid -eq [int]$stopped.ProcessID })
                if ($child.Count -ne 1) { continue }
                $time = [DateTime]::FromFileTimeUtc([long]$stopped.TIME_CREATED)
                if ($time -lt [DateTime]::Parse($child[0].observedAt).ToUniversalTime()) { continue }
                $child[0].stoppedAt = $time.ToString('o')
                $child[0].exitStatus = [long]$stopped.ExitStatus
            } catch { $receipt.observerError = ErrorIdentity $_ }
            finally { Remove-Event -EventIdentifier $event.EventIdentifier -ErrorAction SilentlyContinue }
        }
    }
    # Subscribe before launching the immutable installer; a vanished child remains explicitly unobservable.
    $subscription = Register-CimIndicationEvent -Namespace root/cimv2 -Query "SELECT * FROM Win32_ProcessStartTrace WHERE ProcessName = 'powershell.exe'" -SourceIdentifier $sourceIdentifier
    $stopSubscription = Register-CimIndicationEvent -Namespace root/cimv2 -Query "SELECT * FROM Win32_ProcessStopTrace WHERE ProcessName = 'powershell.exe'" -SourceIdentifier $stopIdentifier
    $start = [Diagnostics.ProcessStartInfo]::new($Installer)
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    # This literal is the only installation switch admitted; no /D, UPDATE, replay, repair or argv execution.
    if ($Mode -ceq 'silent-observe') { $start.Arguments = '/S' }
    if ((Test-Path -LiteralPath $installDirectory) -or (Test-Path -LiteralPath $uninstallKey) -or
        (Test-Path -LiteralPath $productKey)) { throw 'Fresh owned namespace changed before installer launch.' }
    $installerProcess = [Diagnostics.Process]::Start($start)
    $receipt.installerPid = $installerProcess.Id
    $receipt.installerStart = $installerProcess.StartTime.ToUniversalTime().ToString('o')
    $identity = [LegacyPreflightWitness]::Image([uint32]$receipt.installerPid)
    if ($null -ne $identity[1]) { $receipt.installerIs64Bit = $identity[1] -eq '64' }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $limit = if ($Mode -ceq 'silent-observe') {180000} else {30000}
    while ($clock.ElapsedMilliseconds -lt $limit) {
        ReadStarts
        ReadStops
        if ($installerProcess.HasExited) { break }
        $identity = [LegacyPreflightWitness]::Image([uint32]$receipt.installerPid)
        if ($null -eq $identity[0] -or $identity[0] -ine $Installer) { throw 'Installer process identity changed or became unavailable.' }
        $dialogs = @([LegacyPreflightWitness]::Dialogs([uint32]$receipt.installerPid))
        if ($null -eq $receipt.firstDialog -and $dialogs.Count -eq 1) {
            $receipt.firstDialog = ReadDialog $dialogs[0]
            $text = ($receipt.firstDialog.controls | ForEach-Object { $_.name }) -join "`n"
            $receipt.classification = if ($text.Contains('Creator Works MCP files are in use.')) { 'preflight-busy' }
                elseif ($text.Contains('Setup could not verify access to Creator Works MCP files.')) { 'preflight-unavailable' }
                elseif ($text -match 'Welcome to.*Creator Works MCP|Setup will guide you') { 'installer-page' }
                else { 'unrecognized-dialog' }
            if ($Mode -ceq 'silent-observe') { Start-Sleep -Milliseconds 100; continue }
            $cancel = @($receipt.firstDialog.controls | Where-Object {
                $_.type -ceq 'ControlType.Button' -and $_.id -ceq '2' -and $_.name.Replace('&','').Trim() -ceq 'Cancel'
            })
            if ($cancel.Count -ne 1 -or $installerProcess.HasExited -or
                -not [LegacyPreflightWitness]::Button($dialogs[0], [uint32]$receipt.installerPid, 2, $true)) {
                throw 'First owned dialog has no ready Cancel control; no alternative action permitted.'
            }
            $receipt.cancelPosted = $true
        } elseif ($Mode -ceq 'first-dialog-cancel' -and $receipt.cancelPosted -and -not $receipt.confirmationPosted -and $dialogs.Count -eq 1) {
            $candidate = ReadDialog $dialogs[0]
            $confirmation = @('Are you sure you want to quit?', 'Are you sure you want to quit the setup?',
                'Are you sure you want to quit Creator Works MCP Setup?', 'Are you sure you want to quit Creator Works MCP 2.7.7 Setup?')
            $lines = @($candidate.controls | ForEach-Object { $_.name.Trim() })
            $yes = @($candidate.controls | Where-Object {
                $_.type -ceq 'ControlType.Button' -and $_.id -ceq '6' -and $_.name.Replace('&','').Trim() -ceq 'Yes'
            })
            if (@($confirmation | Where-Object { $_ -cin $lines }).Count -eq 1 -and
                $yes.Count -eq 1 -and -not $installerProcess.HasExited -and
                [LegacyPreflightWitness]::Button($dialogs[0], [uint32]$receipt.installerPid, 6, $false)) {
                $receipt.laterDialogs += $candidate
                if (-not [LegacyPreflightWitness]::Button($dialogs[0], [uint32]$receipt.installerPid, 6, $true)) { throw 'Owned quit confirmation changed.' }
                $receipt.confirmationPosted = $true
            }
        }
        Start-Sleep -Milliseconds 100
    }
    # Briefly drain already-subscribed events after exit, without rerunning or extending the install deadline.
    if ($installerProcess.HasExited) {
        for ($drain = 0; $drain -lt 10; $drain++) { ReadStarts; ReadStops; Start-Sleep -Milliseconds 100 }
    }
    ReadStarts; ReadStops
    if ($Mode -ceq 'silent-observe' -and $null -eq $receipt.firstDialog) {
        $receipt.classification = if ($installerProcess.HasExited) {'silent-exited'} else {'silent-not-exited'}
    }
} catch { $receipt.error = ErrorIdentity $_ }
finally {
    if ($null -ne $installerProcess) {
        $receipt.installerExited = $installerProcess.HasExited
        if ($receipt.installerExited) { $receipt.installerExitCode = $installerProcess.ExitCode }
        $installerProcess.Dispose() # Disposal is not termination; an uncertain dialog is left to the disposable VM owner.
    }
    if ($null -ne $subscription) { Unregister-Event -SourceIdentifier $sourceIdentifier -ErrorAction SilentlyContinue }
    if ($null -ne $stopSubscription) { Unregister-Event -SourceIdentifier $stopIdentifier -ErrorAction SilentlyContinue }
    Get-Event -SourceIdentifier $sourceIdentifier -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
    Get-Event -SourceIdentifier $stopIdentifier -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
    $receipt.defaultDirectoryAbsent = -not (Test-Path -LiteralPath $installDirectory)
    $receipt.uninstallRegistrationAbsent = -not (Test-Path -LiteralPath $uninstallKey)
    $receipt.productRegistrationAbsent = -not (Test-Path -LiteralPath $productKey)
    if ($null -ne $image -and $null -ne $algorithm) {
        $image.Position = 0
        $receipt.installerBytesUnchanged = $image.Length -eq $receipt.installerBytes -and
            [BitConverter]::ToString($algorithm.ComputeHash($image)).Replace('-','').ToLowerInvariant() -ceq $receipt.installerSha256
    }
    if ($null -ne $image) { $image.Dispose() }
    if ($null -ne $algorithm) { $algorithm.Dispose() }
    $json = ConvertTo-Json -InputObject $receipt -Depth 8
    if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 262144) { throw 'Diagnostic receipt exceeds its bound.' }
    $destination = Join-Path $OutputDirectory 'report.json'
    $output = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $bytes = [Text.Encoding]::UTF8.GetBytes($json); $output.Write($bytes,0,$bytes.Length) } finally { $output.Dispose() }
}
