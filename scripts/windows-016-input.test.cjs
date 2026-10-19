const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { reviewReceipt, applications } = require('./release-descriptor.cjs');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-016-input.yml'), 'utf8');
const block = workflow.match(/        run: \|\r?\n([\s\S]*?)(?=\r?\n      - uses:)/);
assert.ok(block, 'Expected one inline data-only staging block');
const script = block[1].split(/\r?\n/).map(line => line.replace(/^          /, '')).join('\n');
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { windowsHide: true }).status === 0;
const installer = { id: 656964817, name: 'Creator.Hub_0.1.16_x64-setup.exe', size: 37839600,
  state: 'uploaded', digest: 'sha256:7229cfcf919dc3a9e27a459fd482cbbe059fd54caa9ad379b2a75c8baa113a20' };
const metadata = [
  { id: 102, name: 'creator-hub-windows-x86_64.json', size: 512, state: 'uploaded', digest: `sha256:${'a'.repeat(64)}` },
  { id: 103, name: 'creator-hub-windows-x86_64.json.minisig', size: 297, state: 'uploaded', digest: `sha256:${'b'.repeat(64)}` },
  { id: 104, name: 'latest.json', size: 745, state: 'uploaded', digest: `sha256:${'c'.repeat(64)}` },
];
function fixture(signed = false) {
  const env = { DESCRIPTOR_ID: '', DESCRIPTOR_BYTES: '', DESCRIPTOR_SHA256: '',
    MINISIG_ID: '', MINISIG_BYTES: '', MINISIG_SHA256: '', MANIFEST_ID: '', MANIFEST_BYTES: '', MANIFEST_SHA256: '' };
  if (signed) for (const [index, prefix] of ['DESCRIPTOR', 'MINISIG', 'MANIFEST'].entries()) {
    const asset = metadata[index]; env[`${prefix}_ID`] = String(asset.id); env[`${prefix}_BYTES`] = String(asset.size);
    env[`${prefix}_SHA256`] = asset.digest.slice(7);
  }
  return { env, release: { id: 411494394, draft: true, tag_name: 'v0.1.13-validation', assets: structuredClone([installer, ...metadata]) },
    directoryExists: false, fileExists: false, badSize: false, badHash: false };
}
function run(data) {
  // No network/filesystem I/O: all commands that could fetch or write are test doubles.
  const harness = `
$ErrorActionPreference='Stop'
$fixture='${JSON.stringify(data).replaceAll("'", "''")}' | ConvertFrom-Json
$env:GH_TOKEN='TEST_ONLY_TOKEN'
foreach($property in $fixture.env.PSObject.Properties) { [Environment]::SetEnvironmentVariable($property.Name,[string]$property.Value,'Process') }
$gets=[Collections.Generic.List[string]]::new()
$downloads=[Collections.Generic.List[string]]::new()
$created=0
function Test-Path { param($LiteralPath) if([IO.Path]::GetFileName($LiteralPath) -ceq 'windows-016-input'){return $fixture.directoryExists}; return $fixture.fileExists }
function New-Item { param($ItemType,$Path) if($ItemType -cne 'Directory'){throw 'Unexpected write'}; $script:created++ }
function Invoke-RestMethod { param($Method,$Uri,$Headers,$TimeoutSec)
  if($Method -cne 'Get' -or $Uri -cne 'https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases/411494394'){throw 'Unexpected metadata request'}
  $gets.Add($Uri); return $fixture.release
}
function Invoke-WebRequest { param($Method,$Uri,$Headers,$OutFile,$MaximumRedirection,$TimeoutSec)
  if($Method -cne 'Get' -or $Uri -cnotmatch '^https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases/assets/[0-9]+$'){throw 'Unexpected download request'}
  $downloads.Add([IO.Path]::GetFileName($OutFile))
}
function Get-Item { param($LiteralPath)
  $asset=@($fixture.release.assets | Where-Object name -CEQ ([IO.Path]::GetFileName($LiteralPath)))[0]
  return @{Length=([long]$asset.size + [int]$fixture.badSize)}
}
function Get-FileHash { param($LiteralPath,$Algorithm)
  if($Algorithm -cne 'SHA256'){throw 'Unexpected hash algorithm'}
  $asset=@($fixture.release.assets | Where-Object name -CEQ ([IO.Path]::GetFileName($LiteralPath)))[0]
  return @{Hash=$(if($fixture.badHash){'D'*64}else{$asset.digest.Substring(7).ToUpperInvariant()})}
}
$passed=$false;$failure=$null
try {
${script}
  $passed=$true
} catch { $failure=$_.Exception.Message }
@{passed=$passed;failure=$failure;gets=@($gets);downloads=@($downloads);created=$created} | ConvertTo-Json -Compress
`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL|AUTHORIZATION/i.test(name)));
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', harness], { env, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /TEST_ONLY_TOKEN/);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

test('staging has one private GET-only data job, no checkout, dependency/code execution, decoding or release writes', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /push:\s+branches: \[validation\/windows-016-input\]/);
  assert.equal((workflow.match(/^        type: string$/gm) || []).length, 9);
  assert.doesNotMatch(workflow, /installer_asset_id|INSTALLER_ID|required: true/);
  assert.ok(script.includes("id='656964817';bytes=37839600L;sha='7229cfcf919dc3a9e27a459fd482cbbe059fd54caa9ad379b2a75c8baa113a20'"));
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.match(workflow, /stage:[\s\S]*permissions:\s+contents: write/);
  assert.match(workflow, /name: windows-016-acceptance-input/);
  assert.match(workflow, /runs-on: windows-latest/);
  assert.doesNotMatch(workflow, /checkout@|setup-node@|npm |cargo |node |Expand-Archive|FromBase64|ConvertFrom-Json|Invoke-Expression|Start-Process|\.exe['"]?\s+-|gh release|workflow run|SkipCertificateCheck|PreserveAuthorizationOnRedirect|\b(?:Post|Patch|Put|Delete)\b|if: always/);
  assert.deepEqual([...script.matchAll(/Invoke-(?:RestMethod|WebRequest) -Method (\w+)/g)].map(match => match[1]), ['Get', 'Get']);
  assert.ok(script.indexOf('Exact private asset metadata differs') < script.indexOf('New-Item -ItemType Directory'));
  assert.ok(script.indexOf('Downloaded byte/hash pin differs') < script.indexOf('Write-Output'));
  assert.doesNotMatch(script, /-Force|Set-Content|Add-Content|Remove-Item|Move-Item|Copy-Item/);
});

test('fresh stages exactly one pinned installer even when the private draft contains other assets', { skip: !hasPwsh }, () => {
  const result = run(fixture());
  assert.equal(result.passed, true, result.failure);
  assert.deepEqual(result.downloads, [installer.name]); assert.equal(result.created, 1); assert.equal(result.gets.length, 1);
});

test('incoming stages only the fixed optional three files with independent hash and size pins', { skip: !hasPwsh }, () => {
  const result = run(fixture(true));
  assert.equal(result.passed, true, result.failure);
  assert.deepEqual(result.downloads, [installer.name, ...metadata.map(asset => asset.name)]);
});

test('partial metadata, unsafe IDs, repeated IDs, invalid pins and size bounds refuse before HTTP or writes', { skip: !hasPwsh }, () => {
  for (const mutate of [f => { Object.assign(f.env, fixture(true).env); f.env.DESCRIPTOR_ID = '102;Write-Output unsafe'; },
    f => { Object.assign(f.env, fixture(true).env); f.env.DESCRIPTOR_ID = '../102'; },
    f => f.env.DESCRIPTOR_ID = '102', f => { Object.assign(f.env, fixture(true).env); f.env.MINISIG_ID = String(installer.id); },
    f => { Object.assign(f.env, fixture(true).env); f.env.DESCRIPTOR_SHA256 = 'A'.repeat(64); },
    f => { Object.assign(f.env, fixture(true).env); f.env.MINISIG_BYTES = '4097'; },
    f => { Object.assign(f.env, fixture(true).env); f.env.MANIFEST_BYTES = '32769'; }]) {
    const data = fixture(); mutate(data); const result = run(data);
    assert.equal(result.passed, false); assert.deepEqual(result.gets, []); assert.deepEqual(result.downloads, []); assert.equal(result.created, 0);
  }
});

test('wrong release identity, published release, stale asset identity/size/hash or duplicate assets refuse before download', { skip: !hasPwsh }, () => {
  for (const mutate of [f => f.release.id++, f => f.release.draft = false, f => f.release.tag_name = 'v0.1.16', f => f.release.assets[0].id++,
    f => f.release.assets[0].name = 'installer.exe', f => f.release.assets[0].state = 'new',
    f => f.release.assets[0].size++, f => f.release.assets[0].digest = `sha256:${'d'.repeat(64)}`,
    f => f.release.assets.push(structuredClone(f.release.assets[0]))]) {
    const data = fixture(); mutate(data); const result = run(data);
    assert.equal(result.passed, false); assert.deepEqual(result.downloads, []); assert.equal(result.created, 0);
  }
});

test('no clobber and post-download byte/hash verification remain mandatory', { skip: !hasPwsh }, () => {
  for (const property of ['directoryExists', 'fileExists', 'badSize', 'badHash']) {
    const data = fixture(); data[property] = true; const result = run(data);
    assert.equal(result.passed, false);
    assert.equal(result.downloads.length, ['badSize', 'badHash'].includes(property) ? 1 : 0);
  }
});

test('fresh-only native evidence cannot authorize reviewed guarded-update protocol or migration claims', () => {
  const descriptor = { appId: 'creator-hub', version: '0.1.16', byteLength: 123, sha256: 'a'.repeat(64), executableSha256: 'b'.repeat(64) };
  const fresh = { passed: true, freshInstallAccepted: true, migrationAccepted: false, releaseReady: false,
    installerSha256: descriptor.sha256, executableSha256: descriptor.executableSha256 };
  assert.throws(() => reviewReceipt(fresh, descriptor, applications.hub), /reviewed stable receipt/);
  const fieldsOnly = { ...fresh, ...descriptor, schemaVersion: 1, approvedForStable: true, identityProtocol: 0, lifecycleProtocol: 0,
    installerProtocol: 1, minHubVersion: '0.1.14', installerScope: 'fresh-nsis-default-location',
    evidence: ['https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/123'] };
  assert.throws(() => reviewReceipt(fieldsOnly, descriptor, applications.hub), /guarded NSIS update path/);
  assert.throws(() => reviewReceipt({ ...fieldsOnly, migrationAccepted: true }, descriptor, applications.hub), /guarded NSIS update path/);
});
