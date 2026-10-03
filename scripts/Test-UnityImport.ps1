param([string]$EditorVersion = '6000.3.21f1')
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$editor = Join-Path 'C:\Program Files\Unity\Hub\Editor' "$EditorVersion\Editor\Unity.exe"
if (-not (Test-Path -LiteralPath $editor)) { throw "Unity $EditorVersion is not installed." }
$fixture = Join-Path $repo ('artifacts\plugins-import-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path "$fixture\Assets\Editor\PluginTests", "$fixture\Packages", "$fixture\ProjectSettings" | Out-Null
[IO.File]::WriteAllText("$fixture\ProjectSettings\ProjectVersion.txt", "m_EditorVersion: $EditorVersion`n")
New-Item -ItemType File -Path "$fixture\.import-test-fixture" | Out-Null
Copy-Item -LiteralPath "$repo\unity\com.creatorworks.plugins" -Destination "$fixture\Packages" -Recurse
Copy-Item -LiteralPath "$PSScriptRoot\unity\manifest.json" -Destination "$fixture\Packages\manifest.json"
Copy-Item -LiteralPath "$PSScriptRoot\unity\CreatorWorks.Plugins.Editor.Tests.asmdef", "$PSScriptRoot\unity\CreatorPluginsImportSmoke.cs" -Destination "$fixture\Assets\Editor\PluginTests"
Copy-Item -LiteralPath "$repo\tests\fixtures\community\start-location.json" -Destination "$fixture\listing.json"
Write-Output "Fixture: $fixture"
$process = Start-Process -FilePath $editor -ArgumentList @('-projectPath', "`"$fixture`"", '-executeMethod', 'CreatorPluginsImportSmoke.Run', '-logFile', "`"$fixture\editor.log`"") -WindowStyle Hidden -PassThru
if (-not $process.WaitForExit(240000)) { throw "Test still running: PID $($process.Id). Inspect $fixture\editor.log. No process was killed." }
$resultPath = Join-Path $fixture 'import-result.json'
if (-not (Test-Path -LiteralPath $resultPath)) { Get-Content "$fixture\editor.log" -Tail 60; throw 'Unity did not produce the import result.' }
$result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
$result | ConvertTo-Json -Depth 4
if (-not $result.passed) { throw "Real archive import checks failed. See $resultPath" }
