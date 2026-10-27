'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const outgoing = require('./windows-outgoing-017.cjs');
const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-outgoing-017-input.yml'), 'utf8');
const match = workflow.match(/        run: \|\r?\n([\s\S]*?)(?=\r?\n      - uses:)/);
assert.ok(match);
const script = match[1].split(/\r?\n/).map(line => line.replace(/^          /, '')).join('\n');
const pinBlock = /# BEGIN REVIEWED OUTGOING PINS[\s\S]*?# END REVIEWED OUTGOING PINS/;
assert.ok(pinBlock.test(script));
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
function fixture() {
  const rows = Object.entries(outgoing.LIMITS).map(([name, limit], index) => ({ name,
    sourceName: index === 0 ? 'Creator.Hub_0.1.16_x64-settings-v5-setup.exe' : `test-outgoing17-${name}`,
    id: String(index === 0 ? 680325441 : 101 + index), bytes: index === 0 ? 38216528 : 123,
    sha: index === 0 ? '898e57b1f3dd87b0f871965eb955d54cc88a573a3b879303805defa829d1b89a' : String(index).repeat(64), limit }));
  return { rows, receipt: 'a'.repeat(64), review: 'b'.repeat(64), inputReview: 'b'.repeat(64),
    release: { id: 424919952, draft: true, prerelease: true, tag_name: 'lab-windows-menu-merge-20261027',
      assets: rows.map(row => ({ id: Number(row.id), name: row.sourceName, size: row.bytes, digest: `sha256:${row.sha}`, state: 'uploaded' })) },
    directoryExists: false, fileExists: false, badSize: false, badHash: false };
}
function run(data, original = false) {
  // Only the reviewed-constant block is parameterized. Every HTTP/filesystem
  // cmdlet is mocked; the real stager, installer and trust helpers are never run.
  const code = original ? script : script.replace(pinBlock, '$receiptSha256=$fixture.receipt\n$reviewSha256=$fixture.review\n$rows=@($fixture.rows)');
  const harness = `
$ErrorActionPreference='Stop'
$fixture='${JSON.stringify(data).replaceAll("'", "''")}' | ConvertFrom-Json
$env:GH_TOKEN='TEST_ONLY_NEVER_REAL'
$env:INPUT_REVIEW_SHA256=$fixture.inputReview
$gets=[Collections.Generic.List[string]]::new()
$downloads=[Collections.Generic.List[string]]::new()
$created=0
function Test-Path { param($LiteralPath) if([IO.Path]::GetFileName($LiteralPath) -ceq 'windows-outgoing-017-input'){return $fixture.directoryExists};return $fixture.fileExists }
function New-Item { param($ItemType,$Path) if($ItemType -cne 'Directory'){throw 'Unexpected write'};$script:created++ }
function Invoke-RestMethod { param($Method,$Uri,$Headers,$TimeoutSec)
  if($Method -cne 'Get' -or $Uri -cne 'https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases/424919952'){throw 'Unexpected metadata request'}
  $gets.Add($Uri);return $fixture.release
}
function Invoke-WebRequest { param($Method,$Uri,$Headers,$OutFile,$MaximumRedirection,$TimeoutSec)
  if($Method -cne 'Get' -or $Uri -cnotmatch '^https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases/assets/[0-9]+$'){throw 'Unexpected download request'}
  $downloads.Add([IO.Path]::GetFileName($OutFile))
}
function Get-Item { param($LiteralPath)
  $row=@($fixture.rows|Where-Object name -CEQ ([IO.Path]::GetFileName($LiteralPath)))[0]
  return @{Length=([long]$row.bytes+[int]$fixture.badSize)}
}
function Get-FileHash { param($LiteralPath,$Algorithm)
  if($Algorithm -cne 'SHA256'){throw 'Unexpected hash algorithm'}
  $row=@($fixture.rows|Where-Object name -CEQ ([IO.Path]::GetFileName($LiteralPath)))[0]
  return @{Hash=$(if($fixture.badHash){'F'*64}else{$row.sha.ToUpperInvariant()})}
}
$passed=$false;$failure=$null
try {
${code}
  $passed=$true
} catch {$failure=$_.Exception.Message}
@{passed=$passed;failure=$failure;gets=@($gets);downloads=@($downloads);created=$created}|ConvertTo-Json -Compress
`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIAL|AUTHORIZATION/i.test(name)));
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', harness],
    { env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /TEST_ONLY_NEVER_REAL/);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}
test('only the validation registration push and manual branch-bound GET-only data job exist', () => {
  assert.match(workflow, /on:\s+push:\s+branches: \[validation\/windows-menu-merge-20261027\]\s+workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request:|workflow_run:|schedule:|workflow_call:/);
  const jobs = workflow.split(/\r?\njobs:\r?\n/)[1];
  assert.deepEqual([...jobs.matchAll(/^  ([a-zA-Z0-9_-]+):/gm)].map(m => m[1]), ['stage']);
  assert.match(jobs, /^  stage:\r?\n    if: github.repository == 'BOBWORKS-XR\/CREATOR-HUB' && github.event_name == 'workflow_dispatch' && github.ref == 'refs\/heads\/validation\/windows-menu-merge-20261027'/);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.match(jobs, /permissions:\s+contents: write/);
  assert.match(workflow, /runs-on: windows-latest/);
  assert.doesNotMatch(workflow, /checkout@|setup-node@|npm |cargo |node |Expand-Archive|FromBase64|Invoke-Expression|Start-Process|gh release|workflow run|SkipCertificateCheck|PreserveAuthorizationOnRedirect|\b(?:Post|Patch|Put|Delete)\b|if: always/);
  assert.deepEqual([...script.matchAll(/Invoke-(?:RestMethod|WebRequest) -Method (\w+)/g)].map(m => m[1]), ['Get', 'Get']);
  assert.doesNotMatch(script, /-Force|Set-Content|Add-Content|Remove-Item|Move-Item|Copy-Item|native-self-update|signingKey/);
});
test('output is exactly the six admission filenames, never an incoming artifact or helper code', () => {
  assert.match(workflow, /name: windows-outgoing-017-acceptance-input/);
  assert.doesNotMatch(workflow, /name: windows-016-acceptance-input/);
  const files = [...workflow.matchAll(/^            windows-outgoing-017-input\/([^\r\n]+)$/gm)].map(m => m[1]);
  assert.deepEqual(files.sort(), Object.keys(outgoing.LIMITS).sort());
  assert.match(workflow, /compression-level: 0/); assert.match(workflow, /if-no-files-found: error/);
  assert.ok(script.includes("id='680325441';bytes=38216528L;sha='898e57b1f3dd87b0f871965eb955d54cc88a573a3b879303805defa829d1b89a'"));
  assert.ok(script.indexOf('Exact private asset metadata differs') < script.indexOf('New-Item -ItemType Directory'));
});
test('mismatched independent review refuses checked-in pins before HTTP or writes', () => {
  const result = run(fixture(), true);
  assert.equal(result.passed, false); assert.match(result.failure, /Completed Root17 receipt/);
  assert.deepEqual(result.gets, []); assert.deepEqual(result.downloads, []); assert.equal(result.created, 0);
});
test('actual checked-in PowerShell pins match the immutable reviewed file and approved asset identities', () => {
  const metadata = `${script.match(pinBlock)[0]}\n@{receipt=$receiptSha256;review=$reviewSha256;rows=$rows}|ConvertTo-Json -Depth 5 -Compress`;
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', metadata],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const pins = JSON.parse(result.stdout.trim());
  const bytes = fs.readFileSync(path.join(__dirname, 'windows-outgoing-017-review.json'));
  assert.equal(pins.review, 'a1d91e39e42f3fdbdbb072323971994db43f559e122cabd893586178ed0fc56f');
  const review = outgoing.reviewBytes(bytes, pins.review);
  assert.equal(pins.receipt, review.receiptSha256);
  assert.deepEqual(pins.rows.map(row => [row.name, row.sourceName, row.id]), [
    [outgoing.BASELINE, 'Creator.Hub_0.1.16_x64-settings-v5-setup.exe', '680325441'],
    [outgoing.TARGET, 'Creator_Hub_0.1.17_x64-settings-v5-acceptance-only-setup.exe', '680911010'],
    [outgoing.DESCRIPTOR, 'outgoing-017-settings-v5-creator-hub-windows-x86_64.json', '680911028'],
    [`${outgoing.DESCRIPTOR}.minisig`, 'outgoing-017-settings-v5-creator-hub-windows-x86_64.json.minisig', '680911014'],
    ['latest.json', 'outgoing-017-settings-v5-latest.json', '680911024'],
    [outgoing.TEMPLATE, 'outgoing-017-settings-v5-template.json', '680911019'],
  ]);
  assert.deepEqual(Object.fromEntries(pins.rows.map(row => [row.name, { bytes: row.bytes, sha256: row.sha }])), review.files);
  assert.deepEqual(Object.fromEntries(pins.rows.map(row => [row.name, row.limit])), outgoing.LIMITS);
});
test('six exact reviewed files stage while unrelated incoming and historical assets remain ignored', () => {
  const f = fixture(); f.release.assets.push({ id: 679977699, name: outgoing.BASELINE, state: 'uploaded', size: 38214608,
    digest: 'sha256:390b63dee018c8b9aa0b0039d086c2f697df69ddd68d3ebf96359b4d40bae075' });
  const result = run(f);
  assert.equal(result.passed, true, result.failure); assert.equal(result.gets.length, 1); assert.equal(result.created, 1);
  assert.deepEqual(result.downloads, f.rows.map(row => row.name));
});
test('missing receipt/review or any incomplete/ambiguous asset pin refuses before HTTP', () => {
  for (const mutate of [f => f.receipt = '', f => f.review = '', f => f.inputReview = 'c'.repeat(64),
    f => f.rows.pop(), f => f.rows[5].name = 'extra.cjs', f => f.rows[1].id = '',
    f => f.rows[1].id = '102;unsafe', f => f.rows[1].id = f.rows[0].id,
    f => f.rows[1].sourceName = '../payload.exe', f => f.rows[1].sourceName = f.rows[0].sourceName,
    f => f.rows[1].bytes = 0, f => f.rows[1].bytes = 65 * 1024 * 1024, f => f.rows[2].bytes = 32769,
    f => f.rows[3].bytes = 4097, f => f.rows[4].sha = '0'.repeat(64), f => f.rows[5].sha = 'pending']) {
    const f = fixture(); mutate(f); const result = run(f);
    assert.equal(result.passed, false); assert.deepEqual(result.gets, []); assert.deepEqual(result.downloads, []); assert.equal(result.created, 0);
  }
});
test('wrong draft identity, published state or any asset metadata mismatch refuses before download', () => {
  for (const mutate of [f => f.release.id++, f => f.release.draft = false, f => f.release.prerelease = false,
    f => f.release.tag_name = 'v0.1.17', f => f.release.assets[1].id++, f => f.release.assets[2].name = 'incoming.json',
    f => f.release.assets[3].size++, f => f.release.assets[4].state = 'new', f => f.release.assets[5].digest = `sha256:${'f'.repeat(64)}`,
    f => f.release.assets.push(structuredClone(f.release.assets[1]))]) {
    const f = fixture(); mutate(f); const result = run(f);
    assert.equal(result.passed, false); assert.equal(result.gets.length, 1); assert.deepEqual(result.downloads, []); assert.equal(result.created, 0);
  }
});
test('no-clobber and downloaded size/hash checks remain mandatory', () => {
  for (const field of ['directoryExists', 'fileExists', 'badSize', 'badHash']) {
    const f = fixture(); f[field] = true; const result = run(f);
    assert.equal(result.passed, false);
    assert.equal(result.downloads.length, ['badSize', 'badHash'].includes(field) ? 1 : 0);
  }
});
