param([string]$MakeNsis = "$env:LOCALAPPDATA\tauri\NSIS\makensis.exe")
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$root = Join-Path $repo ("artifacts\installer-guard-" + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $root)
$exe = Join-Path $root 'guard-fixture.exe'
$guard = Join-Path $repo 'src-tauri\windows\installer-hooks.nsh'
& $MakeNsis /V2 "/DGUARD_FILE=$guard" "/DFIXTURE_EXE=$exe" (Join-Path $PSScriptRoot 'installer-guard-fixture.nsi')
if ($LASTEXITCODE -ne 0) { throw 'No-install guard fixture failed to compile.' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$fixtureNode = Join-Path $root 'creator-hub.exe'
Copy-Item -LiteralPath $node -Destination $fixtureNode
$before = @(Get-Process -Name creator-hub -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$psi = [Diagnostics.ProcessStartInfo]::new($fixtureNode)
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.Arguments = '-e "process.stdin.once(''data'',()=>process.exit(0));process.stdout.write(''ready\n'')"'
$owned = [Diagnostics.Process]::Start($psi)
$report = [ordered]@{ passed=$false; guardSha256=(Get-FileHash -LiteralPath $guard -Algorithm SHA256).Hash.ToLowerInvariant(); fixture=$exe }
try {
    $ready = $owned.StandardOutput.ReadLineAsync()
    if (-not $ready.Wait(10000) -or $ready.Result -ne 'ready') { throw 'Owned fixture did not start.' }
    $run = Start-Process -FilePath $exe -ArgumentList '/S' -PassThru -WindowStyle Hidden
    if (-not $run.WaitForExit(20000)) { throw "Guard did not exit: inspect fixture PID $($run.Id). No process was stopped." }
    $report.exitCode = $run.ExitCode
    $report.writeSectionReached = Test-Path -LiteralPath (Join-Path $root 'install-section.reached')
    $report.fixtureSurvived = -not $owned.HasExited
    $report.existingSurvived = @($before | Where-Object { -not (Get-Process -Id $_ -ErrorAction SilentlyContinue) }).Count -eq 0
    if ($report.exitCode -ne 10 -or $report.writeSectionReached -or -not $report.fixtureSurvived -or -not $report.existingSurvived) { throw 'Guard refusal was not proven.' }
    $update = Start-Process -FilePath $exe -ArgumentList '/S /UPDATE' -PassThru -WindowStyle Hidden
    if (-not $update.WaitForExit(20000)) { throw 'Update guard exceeded its bounded exit wait.' }
    $report.updateRefusedActiveHub = $update.ExitCode -eq 10 -and -not $owned.HasExited -and -not (Test-Path -LiteralPath (Join-Path $root 'install-section.reached'))
    $update.Dispose()
    if (-not $report.updateRefusedActiveHub) { throw 'The /UPDATE flag bypassed the running-app guard.' }
    $report.updateAcceptedAfterExit = $null
    if ($before.Count -eq 0) {
        $update = Start-Process -FilePath $exe -ArgumentList '/S /UPDATE' -PassThru -WindowStyle Hidden
        Start-Sleep -Milliseconds 750
        $owned.StandardInput.WriteLine('exit')
        $owned.StandardInput.Close()
        if (-not $owned.WaitForExit(10000)) { throw 'Owned update fixture did not exit cooperatively.' }
        if (-not $update.WaitForExit(20000)) { throw 'Update guard did not complete after cooperative exit.' }
        $report.updateAcceptedAfterExit = $update.ExitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $root 'install-section.reached'))
        $update.Dispose()
        if (-not $report.updateAcceptedAfterExit) { throw 'The update handoff did not proceed after cooperative exit.' }
    }
    $report.passed = $true
} finally {
    if (-not $owned.HasExited) { $owned.StandardInput.WriteLine('exit'); $owned.StandardInput.Close() }
    if (-not $owned.WaitForExit(10000)) { throw "Owned fixture did not exit cooperatively: $($owned.Id)" }
    $owned.Dispose()
    $report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'report.json') -Encoding UTF8
    Write-Output ($report | ConvertTo-Json)
}
