param([ValidateSet('fresh','upgrade')][string]$Case)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:GITHUB_REPOSITORY -cne 'BOBWORKS-XR/CREATOR-HUB' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:GITHUB_JOB -cne 'manual' -or $env:GITHUB_SHA -cne $env:EXPECTED_HARNESS_COMMIT -or
    $env:GH_TOKEN -or $env:GITHUB_TOKEN) { throw 'Only the disposable manual-setup job is allowed.' }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class FieldInstallerWindows {
    private delegate bool Visit(IntPtr handle, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Visit visit, IntPtr data);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint owner);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr handle);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr w, IntPtr l);
    public static IntPtr[] ForProcess(uint processId) {
        var windows = new List<IntPtr>();
        EnumWindows((handle, unused) => {
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            if (owner == processId && IsWindowVisible(handle)) windows.Add(handle);
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
}
'@
$binding = Get-Content -Raw -LiteralPath 'scripts/fixtures/windows-outgoing-019-binding.json' | ConvertFrom-Json
$inputFolder = (Resolve-Path -LiteralPath 'artifacts/outgoing-019/data').ProviderPath
$dest = Join-Path $env:LOCALAPPDATA 'Creator Hub/creator-hub.exe'
$reg = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Creator Hub'
$trace = [Collections.Generic.List[string]]::new()
$observed = [Collections.Generic.List[string]]::new()
$sentinels = [ordered]@{
    (Join-Path $env:LOCALAPPDATA 'CreatorHub/field-test-project-settings.json') = '{"project":"fixture-only","keep":true}'
    (Join-Path $env:APPDATA 'creator-works-mcp/field-test-settings.json') = '{"preferences":"fixture-only"}'
}
function Pin([string]$File, [string]$Hash) {
    if ((Get-FileHash -LiteralPath $File).Hash -ine $Hash) { throw 'Wrong installer or installed image.' }
}
function ControlByName($Controls, [string]$Name, $Type) {
    @($Controls | Where-Object { $_.Current.IsEnabled -and -not $_.Current.IsOffscreen -and $_.Current.ControlType -eq $Type -and
        ($_.Current.Name -replace '[&]', '').Trim() -ceq $Name }) | Select-Object -First 1
}
function Click($Element) {
    $control = [IntPtr]$Element.Current.NativeWindowHandle
    if ($Element.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $control -ne [IntPtr]::Zero) {
        $parent = [FieldInstallerWindows]::GetParent($control)
        [uint32]$owner = 0
        [void][FieldInstallerWindows]::GetWindowThreadProcessId($parent, [ref]$owner)
        $id = [FieldInstallerWindows]::GetDlgCtrlID($control)
        if ($owner -ne $run.Id -or $id -le 0 -or $id -gt 65535 -or
            -not [FieldInstallerWindows]::PostMessage($parent, 0x111, [IntPtr]$id, $control)) { throw 'Owned wizard button could not be invoked.' }
        return
    }
    $pattern = $null
    if ($Element.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)) {
        $pattern.Select()
    } elseif ($Element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) {
        $pattern.Invoke()
    } else { throw 'Expected installer control does not expose an automation action.' }
}

if ((Test-Path -LiteralPath $dest) -or (Test-Path -LiteralPath $reg)) { throw 'Expected a clean hosted runner.' }
$next = Join-Path $inputFolder $binding.target.asset
Pin $next $binding.target.installer.sha256
if ($Case -ceq 'upgrade') {
    $old = Join-Path $inputFolder $binding.baseline.asset
    Pin $old $binding.baseline.installer.sha256
    $previous = Start-Process -FilePath $old -ArgumentList '/S' -WindowStyle Hidden -PassThru
    try {
        if (-not $previous.WaitForExit(90000) -or $previous.ExitCode -ne 0) { throw 'Baseline install failed.' }
    } finally {
        if (-not $previous.HasExited) { $previous.Kill(); $previous.WaitForExit() }
        $previous.Dispose()
    }
    Pin $dest $binding.baseline.executable.sha256
    if ((Get-ItemPropertyValue -LiteralPath $reg -Name DisplayVersion) -cne '0.1.26') { throw 'Wrong registered baseline.' }
    foreach ($file in $sentinels.Keys) {
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))
        $s=[IO.File]::Open($file, 'CreateNew', 'Write')
        try { $bytes=[Text.Encoding]::UTF8.GetBytes($sentinels[$file]); $s.Write($bytes, 0, $bytes.Length) } finally { $s.Dispose() }
    }
}

# Exercise the real wizard with no /S, /P or /UPDATE argument.
$run = Start-Process -FilePath $next -PassThru
try {
    $button = [Windows.Automation.ControlType]::Button
    $radio = [Windows.Automation.ControlType]::RadioButton
    $phase = 'intro'
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    while (-not $run.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 350
        try {
            foreach ($handle in [FieldInstallerWindows]::ForProcess([uint32]$run.Id)) {
                $win = [Windows.Automation.AutomationElement]::FromHandle($handle)
                $controls = $win.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
                $labels = @($controls | Where-Object { $_.Current.ControlType -in @($button,$radio) -and -not $_.Current.IsOffscreen } |
                    ForEach-Object { $_.Current.Name }) -join ' | '
                $seen = $phase + ': ' + $win.Current.Name + ': ' + $labels
                if (-not $observed.Contains($seen) -and $observed.Count -lt 20) { $observed.Add($seen) }
                if (@($controls | Where-Object { $_.Current.Name -match 'Error opening file for writing|temporary safety check|could not continue the installation' }).Count) {
                    throw 'Unexpected blocking wizard dialog.'
                }
                $select = ControlByName $controls 'Do not uninstall' $radio
                if ($select -and -not $trace.Contains('keep-existing-install')) {
                    Click $select
                    $trace.Add('keep-existing-install')
                }
                $install = ControlByName $controls 'Install' $button
                $finish = ControlByName $controls 'Finish' $button
                $advance = ControlByName $controls 'Next >' $button
                if ($phase -eq 'intro' -and $install) {
                    if ($Case -eq 'upgrade' -and -not $trace.Contains('keep-existing-install')) { throw 'Upgrade choice was never seen.' }
                    Click $install
                    $trace.Add('Install clicked')
                    $phase = 'installed'
                    break
                } elseif ($phase -eq 'installed' -and $finish) {
                    Click $finish
                    $trace.Add('Finish clicked')
                    $phase = 'finished'
                    break
                } elseif ($phase -eq 'intro' -and $advance -and $trace.Count -lt 9) {
                    Click $advance
                    $trace.Add('Next clicked')
                    break
                }
            }
        } catch [Windows.Automation.ElementNotAvailableException] { continue }
    }
    if (-not $run.HasExited -or $run.ExitCode -ne 0 -or $phase -cne 'finished') { throw 'Manual install did not complete.' }
    Pin $dest $binding.target.executable.sha256
    if ((Get-Item -LiteralPath $dest).VersionInfo.ProductVersion -cne '0.1.27' -or
        (Get-ItemPropertyValue -LiteralPath $reg -Name DisplayVersion) -cne '0.1.27') { throw 'Wrong installed version.' }
    if ($Case -ceq 'upgrade') {
        foreach ($file in $sentinels.Keys) {
            if ([IO.File]::ReadAllText($file) -cne $sentinels[$file]) { throw 'Saved fixture data changed.' }
        }
    }
    [pscustomobject]@{ case=$Case; source=$binding.target.source.commit; manualWizard=$true; steps=$trace.ToArray();
        installerSha256=$binding.target.installer.sha256; installedSha256=$binding.target.executable.sha256;
        installedVersion='0.1.27'; fixtureSettingsPreserved=($Case -ceq 'upgrade') } |
        ConvertTo-Json -Depth 6 | Set-Content -LiteralPath 'artifacts/outgoing-019/manual-wizard.json' -Encoding UTF8
} finally {
    [pscustomobject]@{ case=$Case; phase=$phase; steps=$trace.ToArray(); windows=$observed.ToArray(); exited=$run.HasExited } |
        ConvertTo-Json -Depth 6 | Set-Content -LiteralPath 'artifacts/outgoing-019/manual-trace.json' -Encoding UTF8
    if (-not $run.HasExited) { $run.Kill(); $run.WaitForExit() }
    $run.Dispose()
}
