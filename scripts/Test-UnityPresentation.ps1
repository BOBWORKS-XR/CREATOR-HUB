param([string]$EditorVersion = '6000.3.21f1')
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$editor = Join-Path 'C:\Program Files\Unity\Hub\Editor' "$EditorVersion\Editor\Unity.exe"
if (-not (Test-Path -LiteralPath $editor)) { throw "Unity $EditorVersion is not installed." }
$fixture = Join-Path $repo ('artifacts\plugins-presentation-' + $EditorVersion + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path (Join-Path $fixture 'Assets\Editor\PluginTests'), (Join-Path $fixture 'Packages'), (Join-Path $fixture 'ProjectSettings') | Out-Null
[IO.File]::WriteAllText((Join-Path $fixture 'ProjectSettings\ProjectVersion.txt'), "m_EditorVersion: $EditorVersion`n")
New-Item -ItemType File -Path (Join-Path $fixture '.presentation-test-fixture') | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'unity\com.creatorworks.plugins') -Destination (Join-Path $fixture 'Packages') -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'unity\manifest.json') -Destination (Join-Path $fixture 'Packages\manifest.json')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'unity\CreatorWorks.Plugins.Editor.Tests.asmdef'), (Join-Path $PSScriptRoot 'unity\CreatorPluginsPresentationSmoke.cs') -Destination (Join-Path $fixture 'Assets\Editor\PluginTests')
Copy-Item -LiteralPath (Join-Path $repo 'tests\fixtures\community\start-location.json') -Destination (Join-Path $fixture 'listing.json')
$log = Join-Path $fixture 'batch.log'
Write-Output "Fixture: $fixture"
$process = Start-Process -FilePath $editor -ArgumentList @('-batchmode', '-projectPath', "`"$fixture`"", '-executeMethod', 'CreatorPluginsPresentationSmoke.Run', '-logFile', "`"$log`"") -WindowStyle Hidden -PassThru
if (-not $process.WaitForExit(240000)) { throw "Test still running: PID $($process.Id). Inspect $log. No process was killed." }
$resultPath = Join-Path $fixture 'presentation-result.json'
if (-not (Test-Path -LiteralPath $resultPath)) { Get-Content -LiteralPath $log -Tail 65; throw 'Unity did not produce the test result.' }
$result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
$result | ConvertTo-Json -Depth 4
if (-not $result.passed) { throw "Unity presentation checks failed. See $resultPath" }
