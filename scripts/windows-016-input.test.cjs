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
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { windowsHide: true, timeout: 15000 }).status === 0;
const installer = { id: 680325441, name: 'Creator.Hub_0.1.16_x64-settings-v5-setup.exe', output: 'Creator.Hub_0.1.16_x64-setup.exe', size: 38216528,
  state: 'uploaded', digest: 'sha256:898e57b1f3dd87b0f871965eb955d54cc88a573a3b879303805defa829d1b89a' };
const metadata = [
  { id: 102, name: 'creator-hub-windows-x86_64-settings-v5.json', output: 'creator-hub-windows-x86_64.json', size: 512, state: 'uploaded', digest: `sha256:${'a'.repeat(64)}` },
  { id: 103, name: 'creator-hub-windows-x86_64-settings-v5.json.minisig', output: 'creator-hub-windows-x86_64.json.minisig', size: 297, state: 'uploaded', digest: `sha256:${'b'.repeat(64)}` },
  { id: 104, name: 'latest-settings-v5.json', output: 'latest.json', size: 745, state: 'uploaded', digest: `sha256:${'c'.repeat(64)}` },
];
function fixture(signed = false) {
  const env = { DESCRIPTOR_ID: '', DESCRIPTOR_BYTES: '', DESCRIPTOR_SHA256: '',
    MINISIG_ID: '', MINISIG_BYTES: '', MINISIG_SHA256: '', MANIFEST_ID: '', MANIFEST_BYTES: '', MANIFEST_SHA256: '' };
  if (signed) for (const [index, prefix] of ['DESCRIPTOR', 'MINISIG', 'MANIFEST'].entries()) {
    const asset = metadata[index]; env[`${prefix}_ID`] = String(asset.id); env[`${prefix}_BYTES`] = String(asset.size);
    env[`${prefix}_SHA256`] = asset.digest.slice(7);
  }
  return { env, release: { id: 424919952, draft: true, prerelease: true, tag_name: 'lab-windows-menu-merge-20261027', assets: structuredClone([installer, ...metadata]) },
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
  if($Method -cne 'Get' -or $Uri -cne 'https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases/424919952'){throw 'Unexpected metadata request'}
  $gets.Add($Uri); return $fixture.release
}
function Invoke-WebRequest { param($Method,$Uri,$Headers,$OutFile,$MaximumRedirection,$TimeoutSec)
  if($Method -cne 'Get' -or $Uri -cnotmatch '^https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases/assets/[0-9]+$'){throw 'Unexpected download request'}
  $downloads.Add([IO.Path]::GetFileName($OutFile))
}
function Get-Item { param($LiteralPath)
  $asset=@($fixture.release.assets | Where-Object output -CEQ ([IO.Path]::GetFileName($LiteralPath)))[0]
  return @{Length=([long]$asset.size + [int]$fixture.badSize)}
}
function Get-FileHash { param($LiteralPath,$Algorithm)
  if($Algorithm -cne 'SHA256'){throw 'Unexpected hash algorithm'}
  $asset=@($fixture.release.assets | Where-Object output -CEQ ([IO.Path]::GetFileName($LiteralPath)))[0]
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
  assert.match(workflow, /push:\s+branches: \[validation\/windows-menu-merge-20261027\]/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch'/);
  assert.equal((workflow.match(/^        type: string$/gm) || []).length, 9);
  assert.doesNotMatch(workflow, /installer_asset_id|INSTALLER_ID|required: true/);
  assert.ok(script.includes("id='680325441';bytes=38216528L;sha='898e57b1f3dd87b0f871965eb955d54cc88a573a3b879303805defa829d1b89a'"));
  assert.ok(script.includes("name='Creator.Hub_0.1.16_x64-setup.exe';sourceName='Creator.Hub_0.1.16_x64-settings-v5-setup.exe'"));
  for (const asset of metadata) assert.ok(script.includes(`name='${asset.output}';sourceName='${asset.name}'`));
  assert.ok(script.includes('$assets[0].name -cne $row.sourceName'));
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

test('fresh stages only v5 under the canonical output name while preserving old v2, v3 and v4 transport assets', { skip: !hasPwsh }, () => {
  const data = fixture();
  data.release.assets.push({ id: 679977699, name: installer.output, state: 'uploaded', size: 38214608,
    digest: 'sha256:390b63dee018c8b9aa0b0039d086c2f697df69ddd68d3ebf96359b4d40bae075' });
  data.release.assets.push({ id: 680035905, name: 'Creator.Hub_0.1.16_x64-settings-v3-setup.exe', state: 'uploaded', size: 38224253,
    digest: 'sha256:c7885a1e898a4dcc887ca275cf9483c0067002f9157bcc1dbc443b2e060ff1bc' });
  data.release.assets.push({ id: 680176209, name: 'Creator.Hub_0.1.16_x64-settings-v4-setup.exe', state: 'uploaded', size: 38207720,
    digest: 'sha256:35c9b066ecab363bf6151e00ab97b1da46ca07c6fa9c2e28453f8990d5b63a66' });
  const result = run(data);
  assert.equal(result.passed, true, result.failure);
  assert.deepEqual(result.downloads, [installer.output]); assert.equal(result.created, 1); assert.equal(result.gets.length, 1);
});

test('incoming stages only the fixed optional three files with independent hash and size pins', { skip: !hasPwsh }, () => {
  const data = fixture(true);
  data.release.assets.push(...metadata.map((asset, index) => ({ id: 200 + index, name: asset.output,
    state: 'uploaded', size: asset.size, digest: `sha256:${'d'.repeat(64)}` })));
  const result = run(data);
  assert.equal(result.passed, true, result.failure);
  assert.deepEqual(result.downloads, [installer.output, ...metadata.map(asset => asset.output)]);
});

test('canonical V3 or V4 metadata names cannot substitute for independently pinned V5 source names', { skip: !hasPwsh }, () => {
  for (const asset of metadata) {
    for (const oldName of [asset.output, asset.name.replace('settings-v5', 'settings-v4')]) {
      const data = fixture(true);
      data.release.assets.find(row => row.id === asset.id).name = oldName;
      const result = run(data);
      assert.equal(result.passed, false); assert.deepEqual(result.downloads, []); assert.equal(result.created, 0);
    }
  }
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
  for (const mutate of [f => f.release.id++, f => f.release.id = 411494394, f => f.release.draft = false,
    f => f.release.prerelease = false, f => f.release.tag_name = 'v0.1.16', f => f.release.assets[0].id++,
    f => f.release.assets[0].name = 'installer.exe', f => f.release.assets[0].name = installer.output,
    f => f.release.assets[0].id = 679977699, f => f.release.assets[0].state = 'new',
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
