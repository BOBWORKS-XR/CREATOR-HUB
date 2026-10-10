param(
    [string]$MakeNsis = "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe",
    [switch]$ExpectLegacyPage
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$root = Join-Path $repo ("dist\installer-guard-" + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $root)
$exe = Join-Path $root 'guard-fixture.exe'
$marker = Join-Path $root 'legacy-page.reached'
$guard = Join-Path $repo 'src-tauri\windows\installer-hooks.nsh'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$fixtureNode = Join-Path $root 'creator-project-setup.exe'
Copy-Item -LiteralPath $node -Destination $fixtureNode
$existing = @(Get-Process -Name creator-project-setup -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
& $MakeNsis /V2 "/DGUARD_FILE=$guard" "/DFIXTURE_EXE=$exe" (Join-Path $PSScriptRoot 'installer-guard-fixture.nsi')
if ($LASTEXITCODE -ne 0) { throw 'Could not compile the no-install NSIS fixture.' }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SetupGuardWindows {
    public sealed class Observation {
        public long Window;
        public string Message;
        public bool GuardDialog;
        public int ButtonId;
        public bool AcknowledgementAttempted;
        public bool Posted;
        public int Error;
    }
    private delegate bool Visit(IntPtr h, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Visit cb, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr root, Visit cb, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder text, int length);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr h);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    public static Observation[] Inspect(uint pid, bool acknowledgeDialog) {
        var result = new List<Observation>();
        EnumWindows((h, _) => {
            uint owner; GetWindowThreadProcessId(h, out owner);
            if (owner != pid) return true;
            var texts = new List<string>();
            IntPtr acknowledge = IntPtr.Zero;
            EnumChildWindows(h, (c, d) => {
                var s = new StringBuilder(4096); GetWindowText(c, s, s.Capacity);
                texts.Add(s.ToString());
                if (s.ToString() == "OK") acknowledge = c;
                return true;
            }, IntPtr.Zero);
            var message = string.Join("\n", texts);
            var observation = new Observation {
                Window = h.ToInt64(), Message = message,
                GuardDialog = message.Contains("Setup will not force-close it."),
                ButtonId = acknowledge == IntPtr.Zero ? 0 : GetDlgCtrlID(acknowledge)
            };
            if (acknowledgeDialog && observation.GuardDialog && observation.ButtonId > 0 && observation.ButtonId <= 65535 && GetParent(acknowledge) == h) {
                // BM_CLICK can fail on inactive dialogs. Send the matched OK
                // control's BN_CLICKED notification using its observed ID.
                observation.AcknowledgementAttempted = true;
                observation.Posted = PostMessage(h, 0x111, new IntPtr(observation.ButtonId), acknowledge);
                observation.Error = observation.Posted ? 0 : Marshal.GetLastWin32Error();
            }
            result.Add(observation);
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
}
'@

$psi = [Diagnostics.ProcessStartInfo]::new($fixtureNode)
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
# Keep this owned fake app alive independently of stdin readiness, until the
# harness sends its exact release marker.
$psi.Arguments = '-e "const hold=setInterval(()=>{},1000);let input='''';process.stdin.setEncoding(''utf8'');process.stdin.on(''data'',chunk=>{input+=chunk;if(input.trim()===''exit''){clearInterval(hold);process.exit(0)}});process.stdout.write(''ready\n'')"'
$owned = [Diagnostics.Process]::Start($psi)
$fixtureError = $owned.StandardError.ReadToEndAsync()
$run = $null
$result = [ordered]@{ guardSha256=(Get-FileHash -LiteralPath $guard -Algorithm SHA256).Hash.ToLowerInvariant(); legacyExpected=[bool]$ExpectLegacyPage; passed=$false }
$observations = [Collections.Generic.List[object]]::new()
$seenObservations = [Collections.Generic.HashSet[string]]::new()
try {
    $ready = $owned.StandardOutput.ReadLineAsync()
    if (-not $ready.Wait(10000) -or $ready.Result -ne 'ready') { throw 'Fixture process did not become ready.' }
    $result.fixturePid = $owned.Id
    if ($owned.HasExited) { throw 'Fixture exited before the installer test could start.' }
    $run = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden
    $result.installerFixturePid = $run.Id
    $dialog = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not $run.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        $result.lastWindows = @([SetupGuardWindows]::Inspect($run.Id, $true))
        foreach ($observed in $result.lastWindows) {
            if ($observed.GuardDialog) {
                $dialog = $observed.Message
                if ($seenObservations.Add(($observed | ConvertTo-Json -Compress))) { $observations.Add($observed) }
            }
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $run.HasExited) {
        $processes = @(Get-CimInstance Win32_Process)
        $ownedIds = [Collections.Generic.HashSet[uint32]]::new()
        [void]$ownedIds.Add([uint32]$run.Id)
        for ($depth = 0; $depth -lt 8; $depth++) {
            foreach ($process in $processes) {
                if ($ownedIds.Contains([uint32]$process.ParentProcessId)) { [void]$ownedIds.Add([uint32]$process.ProcessId) }
            }
        }
        $result.timedOutProcessTree = @($processes | Where-Object { $ownedIds.Contains([uint32]$_.ProcessId) } |
            Select-Object ProcessId, ParentProcessId, CreationDate, ExecutablePath, CommandLine)
        throw "Fixture did not exit; inspect only its PID $($run.Id). No process was killed."
    }
    $run.WaitForExit()
    $result.exitCode = $run.ExitCode
    $result.legacyPageReached = Test-Path -LiteralPath $marker
    $result.dialog = $dialog
    $result.fixtureSurvived = -not $owned.HasExited
    $result.existingProcessesSurvived = @($existing | Where-Object { -not (Get-Process -Id $_ -ErrorAction SilentlyContinue) }).Count -eq 0
    if (-not $result.fixtureSurvived) { throw 'Fake app exited unexpectedly; installer refusal cannot be evaluated.' }
    if ($ExpectLegacyPage) {
        if (-not $result.legacyPageReached -or $result.exitCode -ne 0) { throw 'Baseline did not reach the legacy page.' }
    } elseif ($result.legacyPageReached -or $result.exitCode -ne 10 -or -not $dialog) {
        throw 'Early refusal was not proven before the legacy page.'
    }
    if (-not $result.fixtureSurvived -or -not $result.existingProcessesSurvived) { throw 'A protected process exited during the test.' }
    $result.passed = $true
} catch {
    $result.failure = $_.Exception.Message
    throw
} finally {
    $result.dialog = $dialog
    $result.guardObservations = $observations.ToArray()
    $result.legacyPageReached = Test-Path -LiteralPath $marker
    $result.fixtureSurvived = -not $owned.HasExited
    $result.existingProcessesSurvived = @($existing | Where-Object { -not (Get-Process -Id $_ -ErrorAction SilentlyContinue) }).Count -eq 0
    if ($run) {
        $result.installerFixtureExited = $run.HasExited
        if ($run.HasExited) { $result.exitCode = $run.ExitCode }
        else { $result.lastWindows = @([SetupGuardWindows]::Inspect($run.Id, $false)) }
    }
    if (-not $owned.HasExited) { $owned.StandardInput.WriteLine('exit'); $owned.StandardInput.Close() }
    $fixtureClosed = $owned.WaitForExit(10000)
    if ($fixtureClosed) { $result.fixtureExitCode = $owned.ExitCode }
    else { $result.cleanupFailure = "Owned fixture Node did not exit cooperatively: $($owned.Id)" }
    $result.fixtureStderr = if ($fixtureError.Wait(1000)) { $fixtureError.Result } else { 'stderr capture did not complete' }
    $owned.Dispose()
    if ($run -and $run.HasExited) { $run.Dispose() }
    $result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $root 'report.json') -Encoding UTF8
    Write-Output (Join-Path $root 'report.json')
    if (-not $fixtureClosed) { throw $result.cleanupFailure }
}
