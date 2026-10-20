param(
  [Parameter(Mandatory=$true)][string]$ZipPath,
  [Parameter(Mandatory=$true)][string]$ExpectedSha256,
  [Parameter(Mandatory=$true)][long]$ExpectedBytes,
  [Parameter(Mandatory=$true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression

function Assert-ArtifactPath([string]$Path) {
  if (-not [IO.Path]::IsPathRooted($Path)) { throw 'Absolute artifact paths are required.' }
  $full = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../artifacts'))
  if (-not $full.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Transfer extraction stays inside this checkout artifacts directory.'
  }
  for ($part = $full; $part; $part = [IO.Path]::GetDirectoryName($part)) {
    if (Test-Path -LiteralPath $part) {
      $item = Get-Item -LiteralPath $part -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected artifact path refused.' }
    }
    if ($part -eq [IO.Path]::GetPathRoot($part)) { break }
  }
  return $full
}

$ZipPath = Assert-ArtifactPath $ZipPath
$OutputDirectory = Assert-ArtifactPath $OutputDirectory
if ($ExpectedSha256 -cnotmatch '^[a-f0-9]{64}$' -or $ExpectedBytes -le 0 -or $ExpectedBytes -gt 805306368) {
  throw 'An independently pinned bounded ZIP is required.'
}
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Never replace previous extracted evidence.' }
$file = [IO.File]::Open($ZipPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
$archive = $null
$hash = [Security.Cryptography.SHA256]::Create()
try {
  if ($file.Length -ne $ExpectedBytes) { throw 'ZIP size differs.' }
  $actual = [BitConverter]::ToString($hash.ComputeHash($file)).Replace('-', '').ToLowerInvariant()
  if ($actual -cne $ExpectedSha256) { throw 'ZIP hash differs.' }
  $file.Position = 0
  $archive = [IO.Compression.ZipArchive]::new($file, [IO.Compression.ZipArchiveMode]::Read, $true)
  $names = @('modules.tar.gz', 'prepared-unix.json', 'transfer-binding.json')
  $found = @($archive.Entries | ForEach-Object { $_.FullName })
  if ($found.Count -ne 3 -or @(Compare-Object -ReferenceObject $names -DifferenceObject $found -CaseSensitive).Count -ne 0) {
    throw 'The transfer ZIP must contain exactly its three bounded files, without directories or duplicates.'
  }
  foreach ($entry in $archive.Entries) {
    $type = ($entry.ExternalAttributes -shr 16) -band 0xF000
    $limit = if ($entry.FullName -ceq 'modules.tar.gz') { 268435456L } else { 131072L }
    if ($type -notin @(0, 0x8000) -or $entry.Length -le 0 -or $entry.Length -gt $limit) {
      throw 'Unsupported ZIP entry type or size.'
    }
  }
  [IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
  $buffer = [byte[]]::new(65536)
  foreach ($entry in $archive.Entries) {
    $input = $entry.Open()
    $output = [IO.File]::Open((Join-Path $OutputDirectory $entry.FullName), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $total = 0L
      while (($size = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $total += $size
        if ($total -gt $entry.Length) { throw 'ZIP entry grew beyond its declared bound.' }
        $output.Write($buffer, 0, $size)
      }
      if ($total -ne $entry.Length) { throw 'ZIP entry was truncated.' }
      $output.Flush($true)
    } finally { $input.Dispose(); $output.Dispose() }
  }
  @{ downloadedZipVerified=$true; transferContentsVerified=$false; releaseReady=$false } | ConvertTo-Json -Compress
} finally {
  if ($archive) { $archive.Dispose() }
  $hash.Dispose()
  $file.Dispose()
}
