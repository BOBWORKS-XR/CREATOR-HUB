param(
    [ValidateSet('mcp', 'setup')][string]$Product = 'mcp',
    [string]$OutputDirectory = '',
    [string]$AdapterTestExecutable = '',
    [ValidateSet('removal', 'retirement')][string]$AdapterMode = 'removal'
)

function Require-Legacy($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Get-LegacyPin([string]$Id) {
    $common = @{ publisher = 'Creator Works'; owner = 'BOBWORKS-XR' }
    switch ($Id) {
        'mcp' { [pscustomobject]($common + @{
            id = 'mcp'; product = 'Creator Works MCP'; repo = 'CREATOR-WORKS-UNITY-MCP'; repoId = 1122046548
            version = '2.7.7'; source = '9cd12e28d1dd05057b84166d4718a5d6369eff93'; releaseId = 402569194
            assetId = 608030196; asset = 'Creator.Works.MCP_2.7.7_x64-setup.exe'; bytes = 27059109
            sha256 = 'fa0b0ebc39043bf276de73763d380c001c84d1efd24dca9f9c2427b120a5afe0'
            executable = 'creator-works-mcp-launcher.exe'; bundleId = 'com.creatorworks.unitymcp.preview'
        }) }
        'setup' { [pscustomobject]($common + @{
            id = 'setup'; product = 'Creator Project Setup'; repo = 'CREATOR-PROJECT-SETUP'; repoId = 1363655227
            version = '0.3.7'; source = '4a76945272560f9e0d2b93296a5223bf3e891eb2'; releaseId = 402568854
            assetId = 608029072; asset = 'Creator.Project.Setup_0.3.7_x64-setup.exe'; bytes = 2961298
            sha256 = '223bbc00bf7f861efe1760310a4be4cbedfc9829c4d3841fae0a84038bc7e47b'
            executable = 'creator-project-setup.exe'; bundleId = 'com.creatorworks.projectsetup'
        }) }
        default { throw 'Only the two reviewed legacy releases are admitted.' }
    }
}

# Pure guards are callable by unit fixtures; the native entry point always uses live context.
function Assert-LegacyRunner($Context) {
    Require-Legacy ($Context.platform -ceq 'Win32NT' -and $Context.bits -eq 64 -and $Context.pwsh -ge 7 -and
        $Context.actions -ceq 'true' -and $Context.environment -ceq 'github-hosted' -and
        $Context.os -ceq 'Windows' -and $Context.arch -ceq 'X64' -and $Context.optIn -ceq '1' -and
        $Context.repository -ceq 'BOBWORKS-XR/CREATOR-HUB' -and
        $Context.ref -ceq 'refs/heads/validation/legacy-retention-014' -and
        $Context.event -cin @('push', 'workflow_dispatch')) 'Explicit disposable GitHub-hosted Windows X64 runner required before inspection.'
}

function Assert-LiveLegacyRunner {
    Assert-LegacyRunner @{
        platform = [Environment]::OSVersion.Platform.ToString(); bits = [IntPtr]::Size * 8; pwsh = $PSVersionTable.PSVersion.Major
        actions = $env:GITHUB_ACTIONS; environment = $env:RUNNER_ENVIRONMENT; os = $env:RUNNER_OS
        arch = $env:RUNNER_ARCH; optIn = $env:CREATOR_LEGACY_RETENTION_EXPERIMENT; repository = $env:GITHUB_REPOSITORY
        ref = $env:GITHUB_REF; event = $env:GITHUB_EVENT_NAME
    }
}

function Assert-LegacySource($Pin, $Repository, $Release, $Reference) {
    $repoName = "$($Pin.owner)/$($Pin.repo)"
    Require-Legacy ($Repository.id -eq $Pin.repoId -and $Repository.full_name -ceq $repoName -and
        $Repository.private -eq $false) 'Exact public release repository binding differs.'
    Require-Legacy ($Release.id -eq $Pin.releaseId -and $Release.tag_name -ceq "v$($Pin.version)" -and
        $Release.target_commitish -ceq $Pin.source -and $Release.draft -eq $false -and $Release.prerelease -eq $false) 'Exact public release binding differs.'
    Require-Legacy ($Reference.ref -ceq "refs/tags/v$($Pin.version)" -and $Reference.object.type -ceq 'commit' -and
        $Reference.object.sha -ceq $Pin.source) 'Immutable release tag source differs.'
    $assets = @($Release.assets | Where-Object { $_.name -ceq $Pin.asset })
    Require-Legacy ($assets.Count -eq 1) 'Expected one exact official installer asset.'
    $asset = $assets[0]
    Require-Legacy ($asset.id -eq $Pin.assetId -and $asset.size -eq $Pin.bytes -and $asset.state -ceq 'uploaded' -and
        $asset.digest -ceq "sha256:$($Pin.sha256)" -and
        $asset.browser_download_url -ceq "https://github.com/$repoName/releases/download/v$($Pin.version)/$($Pin.asset)") 'Release asset identity/size/digest/URL differs.'
    return $asset
}

function Get-LegacyNativeEnvironment([Collections.IDictionary]$Source, [string]$Temporary) {
    $result = @{}
    foreach ($name in @('SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
        'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
        'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS')) {
        if ($Source[$name]) { $result[$name] = [string]$Source[$name] }
    }
    $system = [IO.Path]::Combine([string]$Source['SystemRoot'], 'System32')
    $result['PATH'] = "$system;$($Source['SystemRoot']);$system\WindowsPowerShell\v1.0"
    $result['PSModulePath'] = "$system\WindowsPowerShell\v1.0\Modules"
    $result['TEMP'] = $Temporary; $result['TMP'] = $Temporary
    return $result
}

function Assert-LegacyPath([string]$Path, [string]$Root) {
    Require-Legacy ([IO.Path]::IsPathFullyQualified($Path) -and -not $Path.StartsWith('\\') -and
        [IO.Path]::GetFullPath($Path) -ceq $Path -and $Path -notmatch '[\x00-\x1f"<>|?*]' -and
        $Path.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) 'Path must remain strictly inside its exact canonical fixture root.'
    for ($part = $Path; $part; $part = [IO.Path]::GetDirectoryName($part)) {
        if (Test-Path -LiteralPath $part) {
            $item = Get-Item -LiteralPath $part -Force
            Require-Legacy (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Redirected fixture path refused.'
        }
    }
}

function Get-LegacyFileProof([string]$Path, [long]$Limit = 134217728) {
    $before = Get-Item -LiteralPath $Path -Force
    Require-Legacy (-not $before.PSIsContainer -and ($before.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 -and
        $before.Length -gt 0 -and $before.Length -le $Limit) 'Bounded regular fixture file required.'
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try { $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant() }
    finally { $stream.Dispose() }
    $after = Get-Item -LiteralPath $Path -Force
    Require-Legacy ($before.Length -eq $after.Length -and $before.CreationTimeUtc.Ticks -eq $after.CreationTimeUtc.Ticks -and
        $before.LastWriteTimeUtc.Ticks -eq $after.LastWriteTimeUtc.Ticks) 'Fixture file changed during capture.'
    return [pscustomobject]@{ path = $Path; sha256 = $hash; bytes = $after.Length
        created = $after.CreationTimeUtc.Ticks; modified = $after.LastWriteTimeUtc.Ticks }
}

function Get-LegacyRootIdentity([string]$Root) {
    $item = Get-Item -LiteralPath $Root -Force
    Require-Legacy ($item.PSIsContainer -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'Owned ordinary fixture directory required.'
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $owner = (Get-Acl -LiteralPath $Root).GetOwner([Security.Principal.SecurityIdentifier]).Value
    Require-Legacy ($owner -in @($identity.User.Value, $identity.Owner.Value)) 'Fixture directory owner differs from runner token.'
    # Deleting children legitimately changes directory mtime; creation/owner must stay fixed.
    return [pscustomobject]@{ path = $item.FullName; created = $item.CreationTimeUtc.Ticks; owner = $owner }
}

function Get-LegacyInventory([string]$Root) {
    $rows = [Collections.Generic.List[object]]::new()
    function Visit-Legacy([string]$Directory, [int]$Depth) {
        Require-Legacy ($Depth -le 16) 'Fixture tree depth exceeded.'
        foreach ($item in @(Get-ChildItem -LiteralPath $Directory -Force | Sort-Object Name)) {
            Assert-LegacyPath $item.FullName $Root
            Require-Legacy ($rows.Count -lt 256) 'Fixture inventory entry bound exceeded.'
            $relative = $item.FullName.Substring($Root.Length + 1)
            if ($item.PSIsContainer) {
                $rows.Add([pscustomobject]@{ name = $relative; type = 'directory' })
                Visit-Legacy $item.FullName ($Depth + 1)
            } else {
                $proof = Get-LegacyFileProof $item.FullName
                $rows.Add([pscustomobject]@{ name = $relative; type = 'file'; sha256 = $proof.sha256; bytes = $proof.bytes
                    created = $proof.created; modified = $proof.modified })
            }
        }
    }
    Visit-Legacy $Root 0
    return ,$rows.ToArray()
}

function Assert-LegacyRetained($Before, $After) {
    Require-Legacy (($Before | ConvertTo-Json -Depth 6 -Compress) -ceq ($After | ConvertTo-Json -Depth 6 -Compress)) 'Synthetic persistent store bytes/paths/metadata changed.'
}

function Get-LegacyStores($Pin, [string]$Roaming, [string]$Local) {
    $stores = @([pscustomobject]@{ label = 'bundle-roaming'; path = Join-Path $Roaming $Pin.bundleId },
        [pscustomobject]@{ label = 'bundle-local'; path = Join-Path $Local $Pin.bundleId })
    if ($Pin.id -ceq 'mcp') {
        $stores += @([pscustomobject]@{ label = 'mcp-settings'; path = Join-Path $Roaming 'creator-works-mcp' },
            [pscustomobject]@{ label = 'mcp-legacy-settings'; path = Join-Path $Roaming 'banter-mcp' },
            [pscustomobject]@{ label = 'mcp-persistent-server'; path = Join-Path $Local 'creator-works-mcp' })
    } else { $stores += [pscustomobject]@{ label = 'setup-persistent'; path = Join-Path $Local 'CreatorProjectSetup' } }
    return ,$stores
}

function Convert-LegacyRegistryRecord([Collections.IDictionary]$Record) {
    $named = [ordered]@{}
    foreach ($entry in $Record.GetEnumerator()) {
        $name = if ([string]$entry.Key -ceq '') { 'defaultValue' } else { [string]$entry.Key }
        Require-Legacy (-not $named.Contains($name)) 'Registry report field collision; unnamed value must not be lost.'
        $named[$name] = $entry.Value
    }
    return [pscustomobject]$named
}

function Get-LegacyRegistrations($Pin, [switch]$Manufacturer) {
    $subkey = if ($Manufacturer) { "Software\Creator Works\$($Pin.product)" }
        else { "Software\Microsoft\Windows\CurrentVersion\Uninstall\$($Pin.product)" }
    $records = @()
    foreach ($hive in @('CurrentUser', 'LocalMachine')) { foreach ($view in @('Registry64', 'Registry32')) {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive, [Microsoft.Win32.RegistryView]::$view)
        try {
            $key = $base.OpenSubKey($subkey, $false)
            if ($key) { try {
                $record = [ordered]@{ hive = $hive; view = $view; key = $subkey }
                foreach ($name in @('', 'DisplayName', 'DisplayVersion', 'Publisher', 'InstallLocation', 'UninstallString', 'QuietUninstallString')) {
                    $record[$name] = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                }
                $records += (Convert-LegacyRegistryRecord $record)
            } finally { $key.Dispose() } }
        } finally { $base.Dispose() }
    } }
    return $records
}

function Get-LegacyUninstallArguments([string]$Root) {
    Require-Legacy ([IO.Path]::IsPathFullyQualified($Root) -and [IO.Path]::GetFullPath($Root) -ceq $Root -and
        -not $Root.StartsWith('\\') -and $Root -notmatch '[\x00-\x1f"<>|?*]' -and -not $Root.Substring(2).Contains(':')) 'Exact ordinary NSIS uninstall directory required.'
    return '/S _?=' + $Root
}

function Assert-LegacyRegistrations($Records, $Pin, [string]$Root) {
    Require-Legacy (@($Records).Count -ge 1 -and @($Records).Count -le 2 -and
        @($Records | Where-Object { $_.view -ceq 'Registry64' }).Count -eq 1) 'Expected current-user X64 registration (shared HKCU views may alias).'
    foreach ($record in $Records) {
        Require-Legacy ($record.hive -ceq 'CurrentUser' -and $record.DisplayName -ceq $Pin.product -and
            $record.DisplayVersion -ceq $Pin.version -and $record.Publisher -ceq $Pin.publisher -and
            $record.InstallLocation -ceq ('"' + $Root + '"') -and
            $record.UninstallString -ceq ('"' + (Join-Path $Root 'uninstall.exe') + '"') -and
            [string]::IsNullOrEmpty($record.QuietUninstallString)) 'Installed registration differs from exact official fixture.'
    }
}

function Assert-LegacyToolExit([bool]$Finished, $ExitCode, [bool]$LogsDrained) {
    Require-Legacy $Finished 'Owned tool exceeded deadline; no process was killed; disposable job teardown is required.'
    Require-Legacy ($ExitCode -eq 0) "Owned tool returned nonzero exit code: $ExitCode."
    Require-Legacy $LogsDrained 'Owned tool logs did not finish; result is not accepted.'
}

function Assert-LegacyResidual($OriginalRoot, $CurrentRoot, $OriginalFile, $CurrentFile) {
    Require-Legacy (($OriginalRoot | ConvertTo-Json -Compress) -ceq ($CurrentRoot | ConvertTo-Json -Compress)) 'Residual install-root identity changed.'
    Require-Legacy ($OriginalFile.path -ceq (Join-Path $OriginalRoot.path 'uninstall.exe') -and
        ($OriginalFile | ConvertTo-Json -Compress) -ceq ($CurrentFile | ConvertTo-Json -Compress)) 'Residual uninstaller path/hash/identity changed; removal refused.'
}

function Complete-LegacyReport($Report, [int]$Seeded, [int]$Expected) {
    $operationAccepted = $Report.registrationAndPayloadAbsent -or $Report.guiRetiredCompatibilityRetained
    if ($Report.caughtFailure -or $Report.error -or $Report.errors.Count -gt 0 -or $Seeded -ne $Expected -or -not $operationAccepted) {
        $Report.status = 'failed'
    }
    $Report.retentionPassed = $Report.status -ceq 'passed'
    $Report.releaseReady = $false; $Report.productAccepted = $false; $Report.migrationAccepted = $false
}

function Invoke-LegacyRetention([string]$Id, [string]$Output) {
    Assert-LiveLegacyRunner
    $ErrorActionPreference = 'Stop'
    $pin = Get-LegacyPin $Id
    Assert-LegacyPath $Output ([IO.Path]::GetFullPath($env:RUNNER_TEMP))
    Require-Legacy (-not (Test-Path -LiteralPath $Output)) 'A new output directory is required; failures are never overwritten.'
    $null = New-Item -ItemType Directory -Path $Output
    $null = Get-LegacyRootIdentity $Output
    $logs = Join-Path $Output 'logs'; $null = New-Item -ItemType Directory -Path $logs
    $temporary = Join-Path $Output 'tool-temp'; $null = New-Item -ItemType Directory -Path $temporary
    $ghHome = Join-Path $Output 'gh-home'; $null = New-Item -ItemType Directory -Path $ghHome
    $nativeEnv = Get-LegacyNativeEnvironment ([Environment]::GetEnvironmentVariables()) $temporary
    $report = [ordered]@{ schemaVersion = 1; scope = 'disposable-official-legacy-uninstall-retention-only'; status = 'failed'
        product = $Id; pin = $pin; runId = $env:GITHUB_RUN_ID; harnessSource = $env:GITHUB_SHA
        releaseReady = $false; productAccepted = $false; migrationAccepted = $false; retentionPassed = $false
        registrationAndPayloadAbsent = $false; guiRetiredCompatibilityRetained = $false; adapterMode = $AdapterMode
        caughtFailure = $false; error = $null
        tools = [Collections.Generic.List[object]]::new(); persistentStores = @(); errors = @() }
    $failure = $null; $installerProof = $null; $seeded = @(); $before = @(); $installRoot = $null
    function Tool([string]$File, [string[]]$Arguments, [string]$Label, [int]$Timeout = 120000, [switch]$GitHub) {
        Assert-LiveLegacyRunner
        $record = [ordered]@{ label = $Label; file = $File; arguments = $Arguments; exitCode = $null; finished = $false
            stdout = "logs/$($report.tools.Count).stdout"; stderr = "logs/$($report.tools.Count).stderr" }
        $report.tools.Add($record)
        $psi = [Diagnostics.ProcessStartInfo]::new($File)
        if ($Label -ceq 'uninstall-exact-owned-baseline') {
            Require-Legacy ($File -ceq $uninstaller -and $Arguments.Count -eq 2 -and $Arguments[0] -ceq '/S' -and
                $Arguments[1] -ceq "_?=$installRoot") 'Only the exact owned NSIS uninstall command is admitted.'
            # ArgumentList quotes paths containing spaces; NSIS explicitly forbids that for _?=.
            $psi.Arguments = Get-LegacyUninstallArguments $installRoot
        } else { foreach ($argument in $Arguments) { $psi.ArgumentList.Add($argument) } }
        $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true; $psi.WindowStyle = 'Hidden'; $psi.WorkingDirectory = $Output
        $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.Environment.Clear()
        foreach ($entry in $nativeEnv.GetEnumerator()) { $psi.Environment[$entry.Key] = $entry.Value }
        if ($Label -cin @('run-root-pinned-removal-adapter', 'run-root-pinned-retirement-adapter')) {
            foreach ($name in @('GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH', 'GITHUB_REPOSITORY', 'GITHUB_REF', 'CREATOR_LEGACY_RETENTION_EXPERIMENT')) {
                $psi.Environment[$name] = [Environment]::GetEnvironmentVariable($name)
            }
            $psi.Environment['CREATOR_LEGACY_RETENTION_PRODUCT'] = $pin.id
            if ($AdapterMode -ceq 'retirement') { $psi.Environment['CREATOR_LEGACY_RETIREMENT_EXPERIMENT'] = '1' }
        }
        if ($GitHub) {
            $psi.Environment['GH_TOKEN'] = $env:GH_TOKEN; $psi.Environment['GH_CONFIG_DIR'] = $ghHome
            $psi.Environment['GH_HOST'] = 'github.com'; $psi.Environment['HOME'] = $ghHome
        }
        $out = [IO.File]::Open((Join-Path $Output $record.stdout), 'CreateNew', 'Write', 'Read')
        $err = [IO.File]::Open((Join-Path $Output $record.stderr), 'CreateNew', 'Write', 'Read')
        $child = $null
        try {
            $child = [Diagnostics.Process]::Start($psi); $record.pid = $child.Id; $record.startedUtc = $child.StartTime.ToUniversalTime().ToString('o')
            $outTask = $child.StandardOutput.BaseStream.CopyToAsync($out); $errTask = $child.StandardError.BaseStream.CopyToAsync($err)
            $record.finished = $child.WaitForExit($Timeout)
            if ($record.finished) { $record.exitCode = $child.ExitCode } else { $record.toolMayStillRun = $true }
            $drained = $record.finished -and $outTask.Wait(5000) -and $errTask.Wait(5000)
            Assert-LegacyToolExit $record.finished $record.exitCode $drained
        } catch { $record.error = $_.Exception.Message; throw }
        finally { if ($child) { $child.Dispose() }; $out.Dispose(); $err.Dispose() }
        return (Join-Path $Output $record.stdout)
    }
    function Api([string]$Route) {
        $file = Tool $gh @('api', '--hostname', 'github.com', $Route) 'primary-api' -GitHub
        Require-Legacy ((Get-Item -LiteralPath $file).Length -le 2097152) 'Primary API response exceeds bound.'
        return (Get-Content -LiteralPath $file -Raw | ConvertFrom-Json)
    }
    try {
        $local = [Environment]::GetFolderPath('LocalApplicationData'); $roaming = [Environment]::GetFolderPath('ApplicationData')
        Require-Legacy ($local -ceq $env:LOCALAPPDATA -and $roaming -ceq $env:APPDATA) 'Native profile folders differ from inherited paths.'
        $installRoot = Join-Path $local $pin.product; Assert-LegacyPath $installRoot $local
        $stores = Get-LegacyStores $pin $roaming $local
        foreach ($store in $stores) { Assert-LegacyPath $store.path $(if ($store.path.StartsWith($roaming + '\')) { $roaming } else { $local }) }
        Require-Legacy (-not (Test-Path -LiteralPath $installRoot)) 'Legacy install root already exists; refusing adoption.'
        Require-Legacy (@(Get-LegacyRegistrations $pin).Count -eq 0 -and @(Get-LegacyRegistrations $pin -Manufacturer).Count -eq 0) 'Legacy registration already exists; refusing adoption.'
        foreach ($store in $stores) { Require-Legacy (-not (Test-Path -LiteralPath $store.path)) 'Persistent store already exists; no existing data is read or overwritten.' }
        Require-Legacy (-not (Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($pin.executable)) -ErrorAction SilentlyContinue)) 'Legacy app is already running; nothing will be stopped.'
        $report.cleanBeforeInstall = $true
        $gh = (Get-Command gh.exe -ErrorAction Stop).Source
        $repoRoute = "repos/$($pin.owner)/$($pin.repo)"
        $binding = [ordered]@{ repository = Api $repoRoute; release = Api "$repoRoute/releases/tags/v$($pin.version)"
            reference = Api "$repoRoute/git/ref/tags/v$($pin.version)" }
        $asset = Assert-LegacySource $pin $binding.repository $binding.release $binding.reference
        $binding | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $Output 'source-binding.json') -NoNewline
        $download = Tool $gh @('api', '--hostname', 'github.com', "$repoRoute/releases/assets/$($asset.id)", '-H', 'Accept: application/octet-stream') 'download-exact-official-installer' -GitHub
        $installer = Join-Path $Output $pin.asset
        [IO.File]::Copy($download, $installer, $false)
        $installerProof = Get-LegacyFileProof $installer $pin.bytes
        Require-Legacy ($installerProof.bytes -eq $pin.bytes -and $installerProof.sha256 -ceq $pin.sha256) 'Downloaded installer bytes/SHA differ from reviewed primary release asset.'
        $report.installer = $installerProof
        $payload = Join-Path $Output 'extracted-launcher'; $null = New-Item -ItemType Directory -Path $payload
        $sevenZip = (Get-Command 7z.exe -ErrorAction Stop).Source
        $null = Tool $sevenZip @('x', $installer, "-o$payload", $pin.executable) 'extract-exact-launcher-only'
        $expected = Get-LegacyFileProof (Join-Path $payload $pin.executable)
        Require-Legacy (@(Get-ChildItem -LiteralPath $payload -Force).Count -eq 1) 'Unexpected launcher extraction layout.'
        $report.extractedLauncher = $expected
        $null = Tool $installer @('/S') 'install-exact-published-baseline' 180000
        Assert-LegacyPath $installRoot $local
        $rootIdentity = Get-LegacyRootIdentity $installRoot
        $registration = @(Get-LegacyRegistrations $pin)
        Assert-LegacyRegistrations $registration $pin $installRoot
        $launcher = Get-LegacyFileProof (Join-Path $installRoot $pin.executable)
        Require-Legacy ($launcher.sha256 -ceq $expected.sha256) 'Installed launcher differs from exact installer payload.'
        $uninstaller = Join-Path $installRoot 'uninstall.exe'; Assert-LegacyPath $uninstaller $installRoot
        $originalUninstaller = Get-LegacyFileProof $uninstaller 16777216
        $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($uninstaller)
        $report.uninstaller = [ordered]@{ provenance = 'generated by fresh pinned official installer in this job'
            file = $originalUninstaller; fileVersion = $version.FileVersion; productVersion = $version.ProductVersion
            registeredVersion = $pin.version; registration = $registration }
        [IO.File]::Copy($uninstaller, (Join-Path $Output 'generated-uninstaller-before.exe'), $false)
        $before = Get-LegacyInventory $installRoot
        $report.installedBefore = $before
        $report | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath (Join-Path $Output 'before-uninstall.json') -NoNewline
        $images = Join-Path $Output 'synthetic-before-images'; $null = New-Item -ItemType Directory -Path $images
        foreach ($store in $stores) {
            Require-Legacy (-not (Test-Path -LiteralPath $store.path)) 'Installer unexpectedly created a persistent store; refusing to overwrite it.'
            $null = New-Item -ItemType Directory -Path $store.path
            $null = Get-LegacyRootIdentity $store.path
            $seeded += $store
            $report.persistentStores = $seeded
            $name = if ($store.label -in @('mcp-settings', 'mcp-legacy-settings')) { 'launcher-config.json' }
                elseif ($store.label -ceq 'setup-persistent') { 'editor-roots.json' } else { 'retention-sentinel.json' }
            $text = if ($name -ceq 'editor-roots.json') { '["C:/synthetic-only/no-editor"]' }
                else { '{"syntheticRetentionFixture":true,"unknownEntry":"keep","channels":[],"auto_start":false}' }
            [IO.File]::WriteAllText((Join-Path $store.path $name), $text)
            $nested = if ($store.label -ceq 'mcp-persistent-server') { 'server' } elseif ($store.label -ceq 'setup-persistent') { 'logs' } else { 'nested' }
            $dir = Join-Path $store.path $nested; $null = New-Item -ItemType Directory -Path $dir
            [IO.File]::WriteAllBytes((Join-Path $dir 'retention-sentinel.bin'), [byte[]](0, 1, 2, 127, 128, 255))
            $store | Add-Member -NotePropertyName before -NotePropertyValue (Get-LegacyInventory $store.path)
            $store | Add-Member -NotePropertyName identity -NotePropertyValue (Get-LegacyRootIdentity $store.path)
            Copy-Item -LiteralPath $store.path -Destination (Join-Path $images $store.label) -Recurse
        }
        $report.persistentStores = $seeded
        $report | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath (Join-Path $Output 'seeded-before-uninstall.json') -NoNewline
        Assert-LegacyRegistrations (Get-LegacyRegistrations $pin) $pin $installRoot
        Assert-LegacyResidual $rootIdentity (Get-LegacyRootIdentity $installRoot) $originalUninstaller (Get-LegacyFileProof $uninstaller 16777216)
        if ($AdapterTestExecutable) {
            $workspace = [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
            Assert-LegacyPath $AdapterTestExecutable $workspace
            Require-Legacy ([IO.Path]::GetDirectoryName($AdapterTestExecutable) -ceq (Join-Path $workspace 'src-tauri\target\debug\deps') -and
                [IO.Path]::GetFileName($AdapterTestExecutable) -cmatch '^creator_hub-[a-f0-9]{16}\.exe$') 'Exact freshly compiled Root unit-test executable required.'
            $adapter = Get-LegacyFileProof $AdapterTestExecutable
            $report.adapterTest = $adapter
            $selector = if ($AdapterMode -ceq 'retirement') { 'legacy_retirement_windows::tests::native_windows_pinned_retirement' }
                else { 'legacy_removal_windows::tests::native_windows_pinned_removal' }
            $null = Tool $AdapterTestExecutable @('--exact', $selector, '--ignored', '--nocapture') "run-root-pinned-$AdapterMode-adapter" 240000
            Assert-LegacyRetained $adapter (Get-LegacyFileProof $AdapterTestExecutable)
        } else {
            Require-Legacy ($AdapterMode -ceq 'removal') 'Retirement requires the exact Root adapter test; no fallback uninstaller is allowed.'
            # _?= must be last and unquoted, even with spaces; no shell/registry command execution.
            $null = Tool $uninstaller @('/S', "_?=$installRoot") 'uninstall-exact-owned-baseline' 180000
        }
        Require-Legacy (@(Get-LegacyRegistrations $pin).Count -eq 0) 'Legacy app registration survived uninstall.'
        Require-Legacy (-not (Test-Path -LiteralPath (Join-Path $installRoot $pin.executable))) 'Legacy executable survived uninstall.'
        foreach ($entry in $before | Where-Object { $_.type -ceq 'file' -and $_.name -cne 'uninstall.exe' }) {
            if ($AdapterMode -ceq 'retirement' -and $entry.name.StartsWith('server\', [StringComparison]::Ordinal)) {
                $after = Get-LegacyFileProof (Join-Path $installRoot $entry.name)
                Require-Legacy ($after.sha256 -ceq $entry.sha256 -and $after.bytes -eq $entry.bytes -and
                    $after.created -eq $entry.created -and $after.modified -eq $entry.modified) 'Compatibility server changed during GUI retirement.'
                continue
            }
            Require-Legacy (-not (Test-Path -LiteralPath (Join-Path $installRoot $entry.name))) 'A known installed payload file survived uninstall; no cleanup deletion is attempted.'
        }
        if (Test-Path -LiteralPath $uninstaller) {
            Assert-LegacyPath $uninstaller $installRoot
            Assert-LegacyResidual $rootIdentity (Get-LegacyRootIdentity $installRoot) $originalUninstaller (Get-LegacyFileProof $uninstaller 16777216)
            Remove-Item -LiteralPath $uninstaller
            Require-Legacy (-not (Test-Path -LiteralPath $uninstaller)) 'Exact residual uninstaller removal failed.'
            $report.exactResidualUninstallerRemoved = $true
        }
        if ($AdapterMode -ceq 'removal' -and (Test-Path -LiteralPath $installRoot)) {
            Assert-LegacyPath $installRoot $local
            Assert-LegacyRetained $rootIdentity (Get-LegacyRootIdentity $installRoot)
            Require-Legacy (@(Get-ChildItem -LiteralPath $installRoot -Force).Count -eq 0) 'Install root has residual entries; no recursive cleanup is allowed.'
            Remove-Item -LiteralPath $installRoot
        }
        if ($AdapterMode -ceq 'removal') {
            Require-Legacy (-not (Test-Path -LiteralPath $installRoot)) 'Owned fixture install root survived normal uninstall/empty-root removal.'
        } else {
            Require-Legacy (-not (Test-Path -LiteralPath $uninstaller)) 'Destructive old uninstaller was not retired.'
            $report.guiRetiredCompatibilityRetained = $true
            $report.compatibilityRuntimeRetained = ($Id -ceq 'mcp')
        }
        $report.registrationAndPayloadAbsent = $AdapterMode -ceq 'removal'
        $report.status = 'passed'
    } catch { $failure = $_; $report.caughtFailure = $true; $report.status = 'failed'; $report.error = $_.Exception.Message }
    finally {
        if ($installRoot) { try {
            $report.registrationsAfter = @(Get-LegacyRegistrations $pin)
            if (Test-Path -LiteralPath $installRoot) { $report.installedAfter = Get-LegacyInventory $installRoot }
        } catch { $report.errors += $_.Exception.Message } }
        if ($report.caughtFailure -and $AdapterTestExecutable) { try {
            $adapterLog = @($report.tools | Where-Object { $_.label -cin @('run-root-pinned-removal-adapter', 'run-root-pinned-retirement-adapter') })
            if ($adapterLog.Count -eq 1) {
                $path = Join-Path $Output $adapterLog[0].stderr
                $item = Get-Item -LiteralPath $path
                if ($item.Length -le 65536) { Write-Host ([IO.File]::ReadAllText($path)) }
                else { Write-Host 'Native adapter failure log exceeds the console bound; full evidence retained in artifact.' }
            }
        } catch { Write-Host 'Native adapter console diagnostic unavailable; original failure remains in retained report.' } }
        foreach ($store in $seeded) { try {
            Require-Legacy ($null -ne $store.before) 'Synthetic store seeding failed before capture.'
            Assert-LegacyRetained $store.identity (Get-LegacyRootIdentity $store.path)
            Assert-LegacyRetained $store.before (Get-LegacyInventory $store.path)
        } catch { $report.errors += $_.Exception.Message } }
        if ($installerProof) { try { Assert-LegacyRetained $installerProof (Get-LegacyFileProof $installer $pin.bytes) }
            catch { $report.errors += $_.Exception.Message } }
        Complete-LegacyReport $report $seeded.Count $(if ($Id -ceq 'mcp') { 5 } else { 3 })
        $report | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath (Join-Path $Output 'retention-report.json') -NoNewline
    }
    if ($failure) { throw $failure }
    Require-Legacy $report.retentionPassed 'Retention checks failed; preserved reports contain original and preservation errors.'
    return [pscustomobject]$report
}

if ($MyInvocation.InvocationName -ne '.') {
    Assert-LiveLegacyRunner
    Invoke-LegacyRetention $Product $OutputDirectory | Select-Object status, retentionPassed, releaseReady, productAccepted, migrationAccepted | ConvertTo-Json -Compress
}
