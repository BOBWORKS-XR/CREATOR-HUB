param([Parameter(Mandatory=$true)][ValidateSet('Enable','Restore')][string]$Action, [Parameter(Mandatory=$true)][string]$StateFile)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'WebView test policy is restricted to a disposable GitHub-hosted Windows runner.'
}
$root = [IO.Path]::GetFullPath((Join-Path (Split-Path $PSScriptRoot -Parent) 'artifacts')) + '\'
$folder = (Resolve-Path -LiteralPath (Split-Path $StateFile -Parent)).Path
if (-not $folder.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path $folder -Leaf) -notmatch '^native-suite-[0-9]+$' -or (Split-Path $StateFile -Leaf) -ne 'webview-policy.json') { throw 'Use an owned native-suite artifact directory.' }
$entries = @(
    @{ path = 'SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'; value = '--remote-debugging-port=9238' }
)
$name = 'creator-hub.exe'
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
try {
    if ($Action -eq 'Enable') {
        if (Test-Path -LiteralPath $StateFile) { throw 'Test policy receipt already exists.' }
        foreach ($entry in $entries) {
            $key = $base.OpenSubKey($entry.path)
            try {
                if ($key -and $key.GetValueNames() -contains $name) { throw 'Existing app policy found; refusing to replace it.' }
            } finally { if ($key) { $key.Dispose() } }
        }
        $groups = & whoami.exe /groups /fo csv /nh | ConvertFrom-Csv -Header Name,Type,SID,Attributes
        $integrity = @($groups | Where-Object { $_.SID -match '^S-1-16-[0-9]+$' } | Select-Object SID,Name)
        @{ schemaVersion = 1; app = $name; view = 'Registry64'; expected = $entries; runnerIntegrity = $integrity } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StateFile -Encoding UTF8
        foreach ($entry in $entries) {
            $key = $base.CreateSubKey($entry.path)
            try { $key.SetValue($name, $entry.value, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
        }
        'Enabled app-specific loopback CDP policy on disposable worker.'
    } else {
        if (-not (Test-Path -LiteralPath $StateFile)) { exit 0 }
        $receipt = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
        if ($receipt.schemaVersion -ne 1 -or $receipt.app -ne $name -or $receipt.view -ne 'Registry64') { throw 'Invalid test policy receipt.' }
        foreach ($entry in $entries) {
            $key = $base.OpenSubKey($entry.path, $true)
            if (-not $key) { continue }
            try {
                if ($key.GetValueNames() -contains $name) {
                    if ($key.GetValueKind($name) -ne [Microsoft.Win32.RegistryValueKind]::String -or $key.GetValue($name) -cne $entry.value) { throw 'App policy changed; refusing to overwrite it.' }
                    $key.DeleteValue($name)
                }
            } finally { $key.Dispose() }
        }
        "Removed only this test run's app-specific overrides; existing policies untouched."
    }
} finally { $base.Dispose() }
