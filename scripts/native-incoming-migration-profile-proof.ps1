# Read-only diagnostic. Checks assume a trusted hosted runner and no hostile same-account
# process. Path checks are not handle-bound and do not resist a compromised runner.
$ErrorActionPreference = 'Stop'
try {
    if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
        $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ARCH -cne 'X64' -or
        $env:GITHUB_REPOSITORY -cne 'BOBWORKS-XR/CREATOR-HUB' -or $env:GITHUB_REPOSITORY_ID -cne '1364807512' -or
        $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:GITHUB_JOB -cne 'profile-proof-diagnostic' -or
        $env:GITHUB_REF -cne 'refs/heads/validation/windows-menu-merge-20261027' -or
        $env:GITHUB_WORKFLOW_REF -cne 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-incoming-016.yml@refs/heads/validation/windows-menu-merge-20261027' -or
        $env:CREATOR_PROFILE_PROOF_DIAGNOSTIC -cne '1' -or $env:GITHUB_RUN_ATTEMPT -cne '1' -or $env:GITHUB_RUN_ID -cnotmatch '^[1-9][0-9]*$' -or
        $env:GITHUB_SHA -cnotmatch '^[a-f0-9]{40}$' -or $env:GITHUB_SHA -cne $env:CREATOR_INCOMING_MIGRATION_SOURCE) { throw 'Runner admission refused.' }
    $buffer = [char[]]::new(32769)
    $count = [Console]::In.ReadBlock($buffer, 0, $buffer.Length)
    if ($count -lt 1 -or $count -gt 32768) { throw 'Invalid proof request.' }
    $request = ( -join $buffer[0..($count - 1)] ) | ConvertFrom-Json
    if (@($request.PSObject.Properties).Count -ne 1 -or @($request.paths).Count -lt 1 -or @($request.paths).Count -gt 64) { throw 'Invalid proof request.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try { $sid = $identity.User.Value } finally { $identity.Dispose() }
    if ($sid -cnotmatch '^S-1-5-21-(?:[0-9]+-){3}[0-9]+$') { throw 'User SID unavailable.' }
    $registry = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $sid
    $registered = [Environment]::ExpandEnvironmentVariables((Get-ItemPropertyValue -LiteralPath $registry -Name ProfileImagePath))
    $profile = [IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile'))
    if ([IO.Path]::GetFullPath($registered) -ine $profile -or [IO.Path]::GetFullPath($env:USERPROFILE) -ine $profile -or
        [IO.Path]::GetFullPath([Environment]::GetFolderPath('ApplicationData')) -ine [IO.Path]::GetFullPath($env:APPDATA) -or
        [IO.Path]::GetFullPath([Environment]::GetFolderPath('LocalApplicationData')) -ine [IO.Path]::GetFullPath($env:LOCALAPPDATA)) { throw 'Token profile differs.' }
    $owner = (Get-Acl -LiteralPath $profile).GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -cne $sid) { throw 'Profile owner differs from token.' }
    $roots = @($profile, [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE), [IO.Path]::GetFullPath($env:RUNNER_TEMP))
    foreach ($candidate in @($request.paths)) {
        if ($candidate -isnot [string] -or $candidate.Length -gt 4096 -or $candidate -cnotmatch '^[A-Za-z]:\\') { throw 'Invalid proof path.' }
        $full = [IO.Path]::GetFullPath($candidate)
        if (-not @($roots | Where-Object { $full.StartsWith($_.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or $full -ieq $_ }).Count) { throw 'Proof path outside runner roots.' }
        for ($part = $full; $part; $part = [IO.Path]::GetDirectoryName($part)) {
            try { $attributes = [IO.File]::GetAttributes($part) }
            catch [IO.FileNotFoundException] { continue }
            catch [IO.DirectoryNotFoundException] { continue }
            if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point refused.' }
            if (($attributes -band [IO.FileAttributes]::Directory) -and
                ($part -ieq $profile -or $part.StartsWith($profile.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase))) {
                $acl = Get-Acl -LiteralPath $part
                $writeRights = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Modify -bor
                    [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
                    [Security.AccessControl.FileSystemRights]::TakeOwnership
                foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
                    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                        ($rule.FileSystemRights -band $writeRights) -and
                        $rule.IdentityReference.Value -cnotin @($sid, 'S-1-5-18', 'S-1-5-32-544')) { throw 'Profile directory grants unexpected write access.' }
                }
            }
        }
    }
    [ordered]@{kind='incoming-migration-profile-proof'; sid=$sid; ownerSid=$owner; profile=$profile;
        appData=[IO.Path]::GetFullPath($env:APPDATA); localAppData=[IO.Path]::GetFullPath($env:LOCALAPPDATA);
        pathsChecked=@($request.paths).Count; handleBound=$false; compromisedRunnerResistance=$false} | ConvertTo-Json -Compress
} catch { [Console]::Error.WriteLine('Profile proof refused.'); exit 1 }
