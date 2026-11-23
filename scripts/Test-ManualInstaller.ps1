param([ValidateSet('fresh','upgrade')][string]$Case)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:GITHUB_REPOSITORY -cne 'BOBWORKS-XR/CREATOR-HUB' -or $env:RUNNER_OS -cne 'Windows' -or
    $env:GITHUB_JOB -cne 'manual' -or $env:GITHUB_SHA -cne $env:EXPECTED_HARNESS_COMMIT -or
    $env:GH_TOKEN -or $env:GITHUB_TOKEN) { throw 'Only the disposable manual-setup job is allowed.' }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class FieldInstallerWindows {
    private delegate bool Visit(IntPtr handle, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Visit visit, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, Visit visit, IntPtr data);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint owner);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr handle);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr handle);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern int GetClassNameW(IntPtr handle, StringBuilder result, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, EntryPoint = "SendMessageTimeoutW")]
    private static extern IntPtr ReadText(IntPtr handle, uint message, UIntPtr w, StringBuilder l, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll", ExactSpelling = true, EntryPoint = "SendMessageTimeoutW")]
    private static extern IntPtr ReadState(IntPtr handle, uint message, UIntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
    public static string Text(IntPtr handle) {
        var text = new StringBuilder(1024); UIntPtr ignored;
        ReadText(handle, 0x000D, (UIntPtr)1024, text, 2, 500, out ignored);
        return text.ToString().Replace("&", "").Trim();
    }
    public static string Class(IntPtr handle) {
        var text = new StringBuilder(128);
        GetClassNameW(handle, text, 128);
        return text.ToString();
    }
    public static bool SetChecked(IntPtr handle, bool check) {
        UIntPtr state;
        if (ReadState(handle, 0x00F1, (UIntPtr)(check ? 1 : 0), IntPtr.Zero, 2, 500, out state) == IntPtr.Zero) return false;
        return ReadState(handle, 0x00F0, UIntPtr.Zero, IntPtr.Zero, 2, 500, out state) != IntPtr.Zero && state.ToUInt64() == (check ? 1UL : 0UL);
    }
    public sealed class Control {
        public IntPtr Handle;
        public string Caption;
        public string Kind;
        public bool Enabled;
    }
    public static Control[] Children(IntPtr parent, uint processId) {
        var children = new List<Control>();
        EnumChildWindows(parent, (handle, unused) => {
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            if (owner == processId && IsWindowVisible(handle) && children.Count < 48) {
                var kind = Class(handle);
                if (kind == "Button" || kind == "Static")
                    children.Add(new Control { Handle = handle, Caption = Text(handle), Kind = kind, Enabled = IsWindowEnabled(handle) });
            }
            return true;
        }, IntPtr.Zero);
        return children.ToArray();
    }
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
function ControlByName($Controls, [string[]]$Names) {
    @($Controls | Where-Object { $_.Enabled -and $_.Kind -ceq 'Button' -and $_.Caption -cin $Names }) | Select-Object -First 1
}
function Click($Element) {
    $control = $Element.Handle
    $parent = [FieldInstallerWindows]::GetParent($control)
    [uint32]$owner = 0
    [void][FieldInstallerWindows]::GetWindowThreadProcessId($parent, [ref]$owner)
    $id = [FieldInstallerWindows]::GetDlgCtrlID($control)
    if ($owner -ne $run.Id -or $id -le 0 -or $id -gt 65535 -or -not [FieldInstallerWindows]::IsWindowEnabled($control) -or
        -not [FieldInstallerWindows]::PostMessage($parent, 0x111, [IntPtr]$id, $control)) { throw 'Owned wizard button could not be invoked.' }
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
    $phase = 'intro'
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    while (-not $run.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 350
        foreach ($handle in [FieldInstallerWindows]::ForProcess([uint32]$run.Id)) {
                $controls = [FieldInstallerWindows]::Children($handle,[uint32]$run.Id)
                $labels = @($controls | Where-Object { $_.Kind -eq 'Button' } | ForEach-Object { $_.Caption }) -join ' | '
                $seen = $phase + ': ' + [FieldInstallerWindows]::Text($handle) + ': ' + $labels
                if (-not $observed.Contains($seen) -and $observed.Count -lt 20) { $observed.Add($seen) }
                if (@($controls | Where-Object { $_.Caption -match 'Error opening file for writing|temporary safety check|could not continue the installation' }).Count) {
                    throw 'Unexpected blocking wizard dialog.'
                }
                $select = ControlByName $controls 'Do not uninstall'
                if ($select -and -not $trace.Contains('keep-existing-install')) {
                    $remove = ControlByName $controls 'Uninstall before installing'
                    if (-not $remove -or -not [FieldInstallerWindows]::SetChecked($remove.Handle, $false) -or
                        -not [FieldInstallerWindows]::SetChecked($select.Handle, $true)) { throw 'Could not confirm in-place upgrade selection.' }
                    $trace.Add('keep-existing-install')
                }
                $install = ControlByName $controls 'Install'
                $finish = ControlByName $controls 'Finish'
                $advance = ControlByName $controls @('Next >','Next')
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
