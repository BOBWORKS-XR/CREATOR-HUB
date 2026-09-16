# Test-only version fixture. Never publish these installer bytes.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Hosted update fixture builds are restricted to disposable GitHub-hosted Windows runners.'
}
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$targetVersion = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if ($targetVersion -ne '0.1.6') { throw 'Review the test-only version fixture before reusing it for another release.' }
$fixtureVersion = '0.1.5'
$files = @('package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock')
$originals = @{}
$changes = @()
$utf8 = [Text.UTF8Encoding]::new($false)
$revision = (& git -C $root rev-parse HEAD).Trim()
try {
    foreach ($file in $files) {
        $full = Join-Path $root $file
        $originals[$file] = [IO.File]::ReadAllBytes($full)
        $content = [IO.File]::ReadAllText($full)
        if ($file.EndsWith('.json')) {
            $json = $content | ConvertFrom-Json -AsHashtable
            if ($json.version -ne $targetVersion) { throw "Unexpected version in $file" }
            $json.version = $fixtureVersion
            if ($file -eq 'package-lock.json') { $json.packages[''].version = $fixtureVersion }
            $content = $json | ConvertTo-Json -Depth 100
        } elseif ($file.EndsWith('Cargo.toml')) {
            $pattern = '(?m)^version = "0\.1\.6"\r?$'
            if ([regex]::Matches($content, $pattern).Count -ne 1) { throw 'Ambiguous Cargo package version.' }
            $content = [regex]::Replace($content, $pattern, 'version = "0.1.5"')
        } else {
            $pattern = '(name = "creator-hub"\r?\nversion = ")0\.1\.6(")'
            if ([regex]::Matches($content, $pattern).Count -ne 1) { throw 'Ambiguous Cargo lock package.' }
            $content = [regex]::Replace($content, $pattern, '${1}0.1.5${2}')
        }
        [IO.File]::WriteAllText($full, $content, $utf8)
        $changes += @{ path = $file; fixtureSha256 = (Get-FileHash -LiteralPath $full).Hash.ToLowerInvariant() }
    }
    $changed = @(& git -C $root diff --name-only)
    if (@($changed | Where-Object { $_ -notin $files }).Count) { throw 'Fixture changed runtime source outside version manifests.' }
    & (Join-Path $PSScriptRoot 'Build-Installer.ps1') -OutputName 'Creator-Hub-hosted-update-fixture' -HostedPins (Join-Path $PSScriptRoot 'prerelease-apps.json')
    $dir = Join-Path $root 'dist/Creator-Hub-hosted-update-fixture'
    $installer = Join-Path $dir "Creator-Hub-$fixtureVersion-Windows-setup.exe"
    # Bind installed bytes, not the pre-packaging executable. Match the main
    # candidate gate, including the installer's exact preflight payload.
    $extracted = Join-Path $dir 'extracted'
    if (Test-Path -LiteralPath $extracted) { throw 'Fixture extraction output already exists.' }
    $sevenZip = (Get-Command 7z.exe -ErrorAction SilentlyContinue).Source
    if (-not $sevenZip) { $sevenZip = 'C:\Program Files\7-Zip\7z.exe' }
    & $sevenZip x $installer ('-o' + $extracted) '-y' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Fixture installer extraction failed.' }
    $exe = Join-Path $extracted 'creator-hub.exe'
    if ((Get-FileHash -LiteralPath $exe).Hash -ne (Get-FileHash -LiteralPath (Join-Path $extracted '$PLUGINSDIR/creator-hub-preflight.exe')).Hash) {
        throw 'Fixture preflight and installed payload differ.'
    }
    $receipt = @{ testOnly = $true; scope = '0.1.6 runtime with version-only 0.1.5 fixture; not public stable'; sourceRevision = $revision;
        fromVersion = $fixtureVersion; toVersion = $targetVersion; changes = $changes;
        installerPath = $installer; executablePath = $exe;
        installerSha256 = (Get-FileHash -LiteralPath $installer).Hash.ToLowerInvariant();
        executableSha256 = (Get-FileHash -LiteralPath $exe).Hash.ToLowerInvariant() }
    [IO.File]::WriteAllText((Join-Path $dir 'fixture.json'), ($receipt | ConvertTo-Json -Depth 10), $utf8)
} finally {
    foreach ($file in $originals.Keys) { [IO.File]::WriteAllBytes((Join-Path $root $file), $originals[$file]) }
}
