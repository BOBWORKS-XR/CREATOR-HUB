const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, 'native-legacy-uninstall-retention.ps1');
const windowsOnly = { skip: process.platform !== 'win32' };
function powershell(body, env = {}) {
  const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; . '" + script.replaceAll("'", "''") + "'; " + body], {
    encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
const expectRefusal = String.raw`
function Refuses([scriptblock]$Action) {
    $rejected=$false; try { & $Action | Out-Null } catch { $rejected=$true }
    if (-not $rejected) { throw 'Fixture unexpectedly accepted a forbidden case.' }
}
`;
function temporary(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'legacy-retention-unit-')));
  t.after(() => {
    assert.equal(fs.realpathSync(root), root); assert.equal(path.dirname(root), parent);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function sourceFixture() {
  return {
    repository: { id: 1122046548, full_name: 'BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP', private: false },
    release: { id: 402569194, tag_name: 'v2.7.7', target_commitish: '9cd12e28d1dd05057b84166d4718a5d6369eff93',
      draft: false, prerelease: false, assets: [{ id: 608030196, name: 'Creator.Works.MCP_2.7.7_x64-setup.exe',
        size: 27059109, state: 'uploaded', digest: 'sha256:fa0b0ebc39043bf276de73763d380c001c84d1efd24dca9f9c2427b120a5afe0',
        browser_download_url: 'https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases/download/v2.7.7/Creator.Works.MCP_2.7.7_x64-setup.exe' }] },
    reference: { ref: 'refs/tags/v2.7.7', object: { type: 'commit', sha: '9cd12e28d1dd05057b84166d4718a5d6369eff93' } },
  };
}

test('public baseline pins match independently checked release bytes, IDs and source commits', windowsOnly, () => {
  const pins = JSON.parse(powershell("@(Get-LegacyPin 'mcp'; Get-LegacyPin 'setup') | ConvertTo-Json -Depth 4 -Compress"));
  assert.deepEqual(pins.map(p => [p.version, p.bytes, p.sha256]), [
    ['2.7.7', 27059109, 'fa0b0ebc39043bf276de73763d380c001c84d1efd24dca9f9c2427b120a5afe0'],
    ['0.3.7', 2961298, '223bbc00bf7f861efe1760310a4be4cbedfc9829c4d3841fae0a84038bc7e47b'],
  ]);
  assert.deepEqual(pins.map(p => p.assetId), [608030196, 608029072]);
  assert.deepEqual(pins.map(p => p.source), ['9cd12e28d1dd05057b84166d4718a5d6369eff93', '4a76945272560f9e0d2b93296a5223bf3e891eb2']);
  powershell(expectRefusal + "Refuses { Get-LegacyPin 'other' }");
});

test('pure runner contract rejects every missing/changed admission field without native inspection', windowsOnly, () => {
  powershell(expectRefusal + String.raw`
    $valid=@{platform='Win32NT';bits=64;pwsh=7;actions='true';environment='github-hosted';os='Windows';arch='X64';optIn='1';repository='BOBWORKS-XR/CREATOR-HUB';ref='refs/heads/validation/legacy-retention-014';event='push'}
    Assert-LegacyRunner $valid
    foreach($field in @($valid.Keys)) { $bad=$valid.Clone();$bad[$field]='0';Refuses { Assert-LegacyRunner $bad } }
  `);
});

test('production CLI refuses local and self-hosted contexts before creating any output or reading registries', windowsOnly, t => {
  const root = temporary(t), output = path.join(root, 'must-not-create');
  for (const env of [{ GITHUB_ACTIONS: 'false', CREATOR_LEGACY_RETENTION_EXPERIMENT: '' },
    { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted', CREATOR_LEGACY_RETENTION_EXPERIMENT: '1' }]) {
    const result = spawnSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-Product', 'mcp', '-OutputDirectory', output],
      { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, ...env } });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /disposable GitHub-hosted Windows X64/);
    assert.doesNotMatch(result.stderr, /registry|already exists|Get-Item|Cannot find/i);
    assert.equal(fs.existsSync(output), false);
  }
});

test('primary metadata binds repo, public release, tag source, asset ID/name/URL/bytes/SHA and uniqueness', windowsOnly, () => {
  const mutations = [b => b.repository.id++, b => b.repository.full_name = 'other/repo', b => b.repository.private = true, b => b.release.id++,
    b => b.release.tag_name = 'v2.7.6', b => b.release.target_commitish = 'main', b => b.release.draft = true,
    b => b.release.prerelease = true, b => b.reference.object.sha = 'a'.repeat(40), b => b.reference.object.type = 'tag',
    b => b.release.assets[0].id++, b => b.release.assets[0].size++, b => b.release.assets[0].digest = 'sha256:' + 'a'.repeat(64),
    b => b.release.assets[0].state = 'new', b => b.release.assets[0].browser_download_url += '?other',
    b => b.release.assets.push(structuredClone(b.release.assets[0]))];
  const cases = mutations.map(mutate => { const b = sourceFixture(); mutate(b); return b; });
  powershell(expectRefusal + String.raw`
    $pin=Get-LegacyPin 'mcp';$good=$env:LEGACY_GOOD | ConvertFrom-Json
    $asset=Assert-LegacySource $pin $good.repository $good.release $good.reference
    if($asset.id -ne 608030196) { throw 'Wrong accepted asset.' }
    foreach($bad in ($env:LEGACY_BAD | ConvertFrom-Json)) { Refuses { Assert-LegacySource $pin $bad.repository $bad.release $bad.reference } }
  `, { LEGACY_GOOD: JSON.stringify(sourceFixture()), LEGACY_BAD: JSON.stringify(cases) });
});

test('native installer/uninstaller environment excludes auth, runtime injection and inherited loader/module overrides', windowsOnly, () => {
  const env = JSON.parse(powershell(String.raw`
    Get-LegacyNativeEnvironment @{SystemRoot='C:\Windows';USERPROFILE='C:\fixture';APPDATA='C:\fixture\Roaming';LOCALAPPDATA='C:\fixture\Local';
      GH_TOKEN='fake-secret';GITHUB_TOKEN='fake-secret';TAURI_SIGNING_PRIVATE_KEY='fake-secret';NODE_OPTIONS='--inspect';PSModulePath='untrusted';PATH='untrusted';CREATOR_MCP_HOST_WRITABLE='1'} 'C:\fixture\tmp' | ConvertTo-Json -Compress
  `));
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'TAURI_SIGNING_PRIVATE_KEY', 'NODE_OPTIONS', 'CREATOR_MCP_HOST_WRITABLE']) assert.equal(env[name], undefined);
  assert.equal(env.TEMP, 'C:\\fixture\\tmp'); assert.equal(env.TMP, env.TEMP);
  assert.equal(env.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  assert.doesNotMatch(JSON.stringify(env), /fake-secret|untrusted/);
});

test('persistent store list is finite and excludes the product install directory', windowsOnly, () => {
  const result = JSON.parse(powershell(String.raw`
    @{mcp=(Get-LegacyStores (Get-LegacyPin 'mcp') 'C:\fixture\Roaming' 'C:\fixture\Local');
      setup=(Get-LegacyStores (Get-LegacyPin 'setup') 'C:\fixture\Roaming' 'C:\fixture\Local')} | ConvertTo-Json -Depth 5 -Compress
  `));
  assert.equal(result.mcp.length, 5); assert.equal(result.setup.length, 3);
  assert.ok(result.mcp.some(s => s.path === 'C:\\fixture\\Local\\creator-works-mcp'));
  assert.ok(result.mcp.some(s => s.path === 'C:\\fixture\\Roaming\\banter-mcp'));
  assert.ok(result.setup.some(s => s.path === 'C:\\fixture\\Local\\CreatorProjectSetup'));
  for (const s of [...result.mcp, ...result.setup]) assert.doesNotMatch(s.path, /\\Creator Works MCP|\\Creator Project Setup/);
});

test('NSIS waitable command keeps _?= last and unquoted with spaces, rejects namespace/argument escapes', windowsOnly, () => {
  assert.equal(powershell("Get-LegacyUninstallArguments 'C:\\Disposable Profile\\AppData\\Local\\Creator Works MCP'"),
    '/S _?=C:\\Disposable Profile\\AppData\\Local\\Creator Works MCP');
  powershell(expectRefusal + String.raw`
    foreach($root in @('relative','C:\fixture\..\other','\\server\share\app','C:\fixture" /UPDATE','C:\fixture:alternate','C:\fixture*')) {
      Refuses { Get-LegacyUninstallArguments $root }
    }
  `);
});

test('registration identity cannot authorize MSI, machine scope, extra flags, wrong version/path or publisher', windowsOnly, () => {
  powershell(expectRefusal + String.raw`
    $pin=Get-LegacyPin 'mcp';$root='C:\fixture\Local\Creator Works MCP'
    $good=@{hive='CurrentUser';view='Registry64';DisplayName=$pin.product;DisplayVersion=$pin.version;Publisher=$pin.publisher;
      InstallLocation=('"'+$root+'"');UninstallString=('"'+(Join-Path $root 'uninstall.exe')+'"');QuietUninstallString=$null}
    Assert-LegacyRegistrations @([pscustomobject]$good) $pin $root
    $alias=$good.Clone();$alias.view='Registry32';Assert-LegacyRegistrations @([pscustomobject]$good;[pscustomobject]$alias) $pin $root
    foreach($change in @(@('hive','LocalMachine'),@('view','Registry32'),@('DisplayVersion','2.7.6'),@('Publisher','Other'),
      @('InstallLocation','C:\outside'),@('UninstallString','msiexec /x {unknown}'),@('QuietUninstallString','extra flags'))) {
      $bad=$good.Clone();$bad[$change[0]]=$change[1];Refuses { Assert-LegacyRegistrations @([pscustomobject]$bad) $pin $root }
    }
    Refuses { Assert-LegacyRegistrations @() $pin $root }
  `);
});

test('nonzero, timeout and incomplete logs fail instead of accepting an apparent tool pass', windowsOnly, () => {
  powershell(expectRefusal + String.raw`
    Assert-LegacyToolExit $true 0 $true
    Refuses { Assert-LegacyToolExit $true 10 $true }
    Refuses { Assert-LegacyToolExit $false $null $false }
    Refuses { Assert-LegacyToolExit $true 0 $false }
  `);
});

test('original error, preservation drift, incomplete seeding or missing removal override a passed receipt', windowsOnly, () => {
  powershell(expectRefusal + String.raw`
    foreach($fault in @('none','original','caught-empty','preservation','seeding','removal')) {
      $report=@{status='passed';error=$null;caughtFailure=$false;errors=@();registrationAndPayloadAbsent=$true;retentionPassed=$false;
        releaseReady=$true;productAccepted=$true;migrationAccepted=$true}
      $count=5
      if($fault -eq 'original') { $report.error='original tool failure' }
      if($fault -eq 'caught-empty') { $report.caughtFailure=$true;$report.error='' }
      if($fault -eq 'preservation') { $report.errors=@('persistent store drift') }
      if($fault -eq 'seeding') { $count=4 }
      if($fault -eq 'removal') { $report.registrationAndPayloadAbsent=$false }
      Complete-LegacyReport $report $count 5
      if($report.releaseReady -or $report.productAccepted -or $report.migrationAccepted) { throw 'Acceptance flag escaped.' }
      if(($fault -eq 'none') -ne $report.retentionPassed) { throw 'Failure was masked by a passed receipt.' }
      if($fault -eq 'original' -and $report.error -cne 'original tool failure') { throw 'Original error was lost.' }
    }
  `);
});

test('directory identity ignores changed child mtime but retains original creation and owner', windowsOnly, t => {
  const root = temporary(t), store = path.join(root, 'store'); fs.mkdirSync(store);
  powershell(String.raw`
    $store=Join-Path $env:LEGACY_UNIT_ROOT 'store';$before=Get-LegacyRootIdentity $store
    $directory=Get-Item -LiteralPath $store;$directory.LastWriteTimeUtc=[DateTime]::UtcNow.AddMinutes(-10)
    Assert-LegacyRetained $before (Get-LegacyRootIdentity $store)
    if($before.PSObject.Properties.Name -contains 'modified') { throw 'Directory mtime became an identity field.' }
  `, { LEGACY_UNIT_ROOT: root });
});

test('residual removal plan rejects changed root, file identity, hash or non-uninstaller path', windowsOnly, () => {
  powershell(expectRefusal + String.raw`
    $root=[pscustomobject]@{path='C:\fixture\Local\Creator Works MCP';created=123;owner='fixture-owner'}
    $file=[pscustomobject]@{path=(Join-Path $root.path 'uninstall.exe');sha256=('a'*64);bytes=1234;created=123;modified=456}
    Assert-LegacyResidual $root $root $file $file
    $badRoot=$root.PSObject.Copy();$badRoot.created=999;Refuses { Assert-LegacyResidual $root $badRoot $file $file }
    foreach($field in @('sha256','path','bytes','created','modified')) {
      $bad=$file.PSObject.Copy();$bad.$field='different';Refuses { Assert-LegacyResidual $root $root $file $bad }
    }
    $outside=$file.PSObject.Copy();$outside.path='C:\outside\uninstall.exe';Refuses { Assert-LegacyResidual $root $root $outside $outside }
  `);
});

test('unit-only filesystem before-image detects modified/missing/hidden files and refuses redirects', windowsOnly, t => {
  const root = temporary(t), store = path.join(root, 'store'); fs.mkdirSync(store);
  fs.writeFileSync(path.join(store, 'sentinel.json'), '{"synthetic":true}');
  powershell(expectRefusal + String.raw`
    $root=$env:LEGACY_UNIT_ROOT;$store=Join-Path $root 'store';Assert-LegacyPath $store $root
    $before=Get-LegacyInventory $store;Assert-LegacyRetained $before (Get-LegacyInventory $store)
    [IO.File]::WriteAllText((Join-Path $store 'hidden'), 'extra')
    $hidden=Get-Item -LiteralPath (Join-Path $store 'hidden');$hidden.Attributes=$hidden.Attributes -bor [IO.FileAttributes]::Hidden
    Refuses { Assert-LegacyRetained $before (Get-LegacyInventory $store) }
    $hidden.Attributes=[IO.FileAttributes]::Normal;Remove-Item -LiteralPath $hidden.FullName
    [IO.File]::WriteAllText((Join-Path $store 'sentinel.json'),'changed');Refuses { Assert-LegacyRetained $before (Get-LegacyInventory $store) }
    Refuses { Get-LegacyFileProof (Join-Path $store 'sentinel.json') 1 }
    Remove-Item -LiteralPath (Join-Path $store 'sentinel.json');Refuses { Assert-LegacyRetained $before (Get-LegacyInventory $store) }
    Refuses { Assert-LegacyPath (Join-Path $root 'store\..\outside') $root }
  `, { LEGACY_UNIT_ROOT: root });
  const target = path.join(root, 'target'), link = path.join(root, 'link'); fs.mkdirSync(target); fs.symlinkSync(target, link, 'junction');
  powershell(expectRefusal + "Refuses { Assert-LegacyPath (Join-Path $env:LEGACY_UNIT_ROOT 'link\\file') $env:LEGACY_UNIT_ROOT }", { LEGACY_UNIT_ROOT: root });
});

test('PowerShell AST parses and native workflow stays scoped, build-free and failure-preserving', windowsOnly, () => {
  assert.equal(powershell(String.raw`
    $tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseFile($env:LEGACY_UNIT_SCRIPT,[ref]$tokens,[ref]$errors) | Out-Null
    if($errors.Count) { throw ($errors | Out-String) };'parsed'
  `, { LEGACY_UNIT_SCRIPT: script }), 'parsed');
  const source = fs.readFileSync(script, 'utf8');
  assert.match(source, /Assert-LiveLegacyRunner\s+\$ErrorActionPreference/);
  assert.match(source, /\$psi\.Arguments = Get-LegacyUninstallArguments \$installRoot/);
  assert.match(source, /Remove-Item -LiteralPath \$uninstaller/);
  assert.doesNotMatch(source, /Remove-Item[^\r\n]*-(?:Recurse|Force)|Stop-Process|\.Kill\(|taskkill|Invoke-Expression|Set-ItemProperty|Remove-Item[^\r\n]*HK/);
  assert.match(source, /releaseReady = \$false/); assert.match(source, /\$Report\.status = 'failed'/);
  assert.match(source, /catch \{ \$failure = \$_; \$report\.caughtFailure = \$true; \$report\.status = 'failed'/);
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/native-legacy-uninstall-retention.yml'), 'utf8');
  assert.match(workflow, /contents: read/); assert.match(workflow, /runs-on: windows-2025/);
  assert.match(workflow, /product: \[mcp, setup\]/); assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /include-hidden-files: true/);
  assert.match(workflow, /branches: \['validation\/legacy-retention-014'\]/);
  assert.match(workflow, /paths: \['\.github\/workflows\/native-legacy-uninstall-retention\.yml'\]/);
  assert.doesNotMatch(workflow, /pull_request/);
  assert.doesNotMatch(workflow, /cargo|build:unified|assemble-unix|secrets\.|npm ci|permissions:\s+write/);
});
