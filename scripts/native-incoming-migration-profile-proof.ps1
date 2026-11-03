# Read-only diagnostic. Checks assume a trusted hosted runner and no hostile same-account
# process. Path checks are not handle-bound and do not resist a compromised runner.
$ErrorActionPreference = 'Stop'
$stage = 'ADMISSION'
try {
    if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
        $env:RUNNER_OS -cne 'Windows' -or $env:RUNNER_ARCH -cne 'X64' -or
        $env:GITHUB_REPOSITORY -cne 'BOBWORKS-XR/CREATOR-HUB' -or $env:GITHUB_REPOSITORY_ID -cne '1364807512' -or
        $env:GITHUB_EVENT_NAME -cne 'workflow_dispatch' -or $env:GITHUB_JOB -cne 'profile-proof-diagnostic' -or
        $env:GITHUB_REF -cne 'refs/heads/validation/windows-menu-merge-20261027' -or
        $env:GITHUB_WORKFLOW_REF -cne 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-incoming-016.yml@refs/heads/validation/windows-menu-merge-20261027' -or
        $env:CREATOR_PROFILE_PROOF_DIAGNOSTIC -cne '1' -or $env:GITHUB_RUN_ATTEMPT -cne '1' -or $env:GITHUB_RUN_ID -cnotmatch '^[1-9][0-9]*$' -or
        $env:GITHUB_SHA -cnotmatch '^[a-f0-9]{40}$' -or $env:GITHUB_SHA -cne $env:CREATOR_INCOMING_MIGRATION_SOURCE) { throw 'Runner admission refused.' }
    $stage = 'REQUEST'
    $buffer = [char[]]::new(32769)
    $count = [Console]::In.ReadBlock($buffer, 0, $buffer.Length)
    if ($count -lt 1 -or $count -gt 32768) { throw 'Invalid proof request.' }
    $request = ( -join $buffer[0..($count - 1)] ) | ConvertFrom-Json
    if (@($request.PSObject.Properties).Count -ne 1 -or @($request.paths).Count -lt 1 -or @($request.paths).Count -gt 64) { throw 'Invalid proof request.' }
    $stage = 'TOKEN'
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try { $sid = $identity.User.Value } finally { $identity.Dispose() }
    if ($sid -cnotmatch '^S-1-5-21-(?:[0-9]+-){3}[0-9]+$') { throw 'User SID unavailable.' }
    $stage = 'PROFILE_REGISTRY'
    $registry = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $sid
    $registered = [Environment]::ExpandEnvironmentVariables((Get-ItemPropertyValue -LiteralPath $registry -Name ProfileImagePath))
    $profile = [IO.Path]::GetFullPath([Environment]::GetFolderPath('UserProfile'))
    $stage = 'PROFILE_MATCH'
    if ([IO.Path]::GetFullPath($registered) -ine $profile -or [IO.Path]::GetFullPath($env:USERPROFILE) -ine $profile -or
        [IO.Path]::GetFullPath([Environment]::GetFolderPath('ApplicationData')) -ine [IO.Path]::GetFullPath($env:APPDATA) -or
        [IO.Path]::GetFullPath([Environment]::GetFolderPath('LocalApplicationData')) -ine [IO.Path]::GetFullPath($env:LOCALAPPDATA)) { throw 'Token profile differs.' }
    $stage = 'PROFILE_OWNER_READ'
    $owner = (Get-Acl -LiteralPath $profile).GetOwner([Security.Principal.SecurityIdentifier]).Value
    $stage = 'PROFILE_OWNER_MISMATCH'
    $ownerCategory = if ($owner -ceq $sid) { 'TOKEN' } elseif ($owner -ceq 'S-1-5-32-544') { 'ADMINISTRATORS' } elseif ($owner -ceq 'S-1-5-18') { 'SYSTEM' } else { 'OTHER' }
    if ($owner -cne $sid) { throw 'Profile owner differs from token.' }
    $stage = 'ROOTS'
    $roots = @($profile, [IO.Path]::GetFullPath($env:GITHUB_WORKSPACE), [IO.Path]::GetFullPath($env:RUNNER_TEMP))
    foreach ($candidate in @($request.paths)) {
        $stage = 'PATH_INPUT'
        if ($candidate -isnot [string] -or $candidate.Length -gt 4096 -or $candidate -cnotmatch '^[A-Za-z]:\\') { throw 'Invalid proof path.' }
        $full = [IO.Path]::GetFullPath($candidate)
        $stage = 'PATH_SCOPE'
        if (-not @($roots | Where-Object { $full.StartsWith($_.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or $full -ieq $_ }).Count) { throw 'Proof path outside runner roots.' }
        for ($part = $full; $part; $part = [IO.Path]::GetDirectoryName($part)) {
            $stage = 'PATH_ATTRIBUTES'
            try { $attributes = [IO.File]::GetAttributes($part) }
            catch [IO.FileNotFoundException] { continue }
            catch [IO.DirectoryNotFoundException] { continue }
            $stage = 'PATH_REPARSE'
            if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point refused.' }
            if (($attributes -band [IO.FileAttributes]::Directory) -and
                ($part -ieq $profile -or $part.StartsWith($profile.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase))) {
                $stage = 'PROFILE_ACL_READ'
                $acl = Get-Acl -LiteralPath $part
                $writeRights = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Modify -bor
                    [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
                    [Security.AccessControl.FileSystemRights]::TakeOwnership
                $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
                $stage = 'PROFILE_ACL_WRITE'
                foreach ($rule in $rules) {
                    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
                        ($rule.FileSystemRights -band $writeRights) -and
                        $rule.IdentityReference.Value -cnotin @($sid, 'S-1-5-18', 'S-1-5-32-544')) { throw 'Profile directory grants unexpected write access.' }
                }
            }
        }
    }
    $stage = 'OUTPUT'
    [ordered]@{kind='incoming-migration-profile-proof'; sid=$sid; ownerSid=$owner; profile=$profile;
        appData=[IO.Path]::GetFullPath($env:APPDATA); localAppData=[IO.Path]::GetFullPath($env:LOCALAPPDATA);
        pathsChecked=@($request.paths).Count; handleBound=$false; compromisedRunnerResistance=$false} | ConvertTo-Json -Compress
} catch {
    if ($stage -ceq 'PROFILE_OWNER_MISMATCH' -and $ownerCategory -cin @('ADMINISTRATORS', 'SYSTEM', 'OTHER')) {
        [Console]::Error.WriteLine('PROFILE_PROOF_REFUSED:' + $stage + ':' + $ownerCategory)
    } else { [Console]::Error.WriteLine('PROFILE_PROOF_REFUSED:' + $stage) }
    exit 1
}
