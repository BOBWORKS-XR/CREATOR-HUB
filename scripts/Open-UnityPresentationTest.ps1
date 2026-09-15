$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$fixture = Join-Path $repo ('artifacts\plugins-presentation-ui-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path (Join-Path $fixture 'Assets\Editor\PluginTests'), (Join-Path $fixture 'Packages'), (Join-Path $fixture 'ProjectSettings') | Out-Null
New-Item -ItemType File -Path (Join-Path $fixture '.presentation-ui-fixture') | Out-Null
[IO.File]::WriteAllText((Join-Path $fixture 'ProjectSettings\ProjectVersion.txt'), "m_EditorVersion: 6000.3.21f1`n")
Copy-Item -LiteralPath (Join-Path $repo 'unity\com.creatorworks.plugins') -Destination (Join-Path $fixture 'Packages') -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'unity\manifest.json') -Destination (Join-Path $fixture 'Packages\manifest.json')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'unity\CreatorWorks.Plugins.Editor.Tests.asmdef'), (Join-Path $PSScriptRoot 'unity\CreatorPluginsPresentationInteractive.cs') -Destination (Join-Path $fixture 'Assets\Editor\PluginTests')
Copy-Item -LiteralPath (Join-Path $repo 'tests\fixtures\community\start-location.json') -Destination (Join-Path $fixture 'listing.json')
$process = Start-Process -FilePath 'C:\Program Files\Unity\Hub\Editor\6000.3.21f1\Editor\Unity.exe' -ArgumentList @('-projectPath', "`"$fixture`"", '-executeMethod', 'CreatorPluginsPresentationInteractive.Open', '-logFile', "`"$fixture\interactive.log`"") -WindowStyle Normal -PassThru
[pscustomobject]@{fixture=$fixture; pid=$process.Id} | ConvertTo-Json
