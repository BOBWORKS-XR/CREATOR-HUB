'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const hook = path.join(root, 'src-tauri/windows/installer-hooks.nsh');

test('Retry repeats the unchanged preflight; silent cancellation remains fail-closed', () => {
  const source = fs.readFileSync(hook, 'utf8');
  const macro = source.slice(source.indexOf('!macro CheckIfAppIsRunning'), source.indexOf('!macroend', source.indexOf('!macro CheckIfAppIsRunning')));
  assert.match(macro, /\$\{Do\}[\s\S]+--installer-preflight-wait[\s\S]+--installer-preflight/);
  assert.match(macro, /MB_ICONSTOP\|MB_RETRYCANCEL[\s\S]+\/SD IDCANCEL IDRETRY \+3\s+SetErrorLevel 10\s+Abort\s+\$\{EndIf\}\s+\$\{LoopUntil\} \$0 == "0"/);
  assert.doesNotMatch(source, /taskkill|Stop-Process|ExecShell|RMDir|DeleteReg|SetRegView/i);
  for (const entry of ['Function CreatorHubEarlyPreflight', '!macro NSIS_HOOK_PREINSTALL', '!macro NSIS_HOOK_PREUNINSTALL']) {
    const block = source.slice(source.indexOf(entry));
    assert.match(block, /!insertmacro CheckIfAppIsRunning "creator-hub.exe" "Creator Hub"/);
  }
});

test('a refused visible install exposes its owner before the warning, but silent installs do not', () => {
  const source = fs.readFileSync(hook, 'utf8');
  assert.match(source, /\$\{If\} \$0 != "0"\s+;[^\r\n]+\s+\$\{IfNot\} \$\{Silent\}\s+SendMessage \$HWNDPARENT \$\{WM_SETTEXT\} 0 "STR:\$\{productName\}"\s+ShowWindow \$HWNDPARENT \$\{SW_SHOW\}\s+BringToFront\s+\$\{EndIf\}\s+;[^\r\n]+\s+MessageBox MB_ICONSTOP\|MB_RETRYCANCEL/);
  assert.match(source, /\/SD IDCANCEL IDRETRY \+3\s+SetErrorLevel 10\s+Abort/);
});

const nsis = path.join(process.env.LOCALAPPDATA || '', 'tauri/NSIS/makensis.exe');
const native = process.platform === 'win32' && fs.existsSync(nsis);
test('temporary extraction errors get bounded retries and never skip the guard', () => {
  const source = fs.readFileSync(hook, 'utf8');
  const extraction = source.slice(source.indexOf('!macro CreatorHubExtractPreflight'), source.indexOf('!macroundef'));
  assert.match(extraction, /SetOverwrite try\s+File[^\r\n]+\s+SetOverwrite lastused\s+\$\{IfNot\} \$\{Errors\}\s+\$\{ExitDo\}/);
  assert.match(extraction, /\$4 >= 12[\s\S]+\/SD IDCANCEL IDRETRY \+3\s+SetErrorLevel 11\s+Abort\s+StrCpy \$4 0[\s\S]+Sleep 500/);
  assert.match(source, /!insertmacro CreatorHubExtractPreflight[^\r\n]+[\s\S]+nsExec::ExecToStack/);
});
test('the real hook compiles into the no-install guard fixture', { skip: process.platform !== 'win32' || !fs.existsSync(nsis) }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-installer-retry-'));
  const file = path.join(folder, 'guard-fixture.exe');
  try {
    const result = spawnSync(nsis, ['/V2', `/DGUARD_FILE=${hook}`, `/DCREATOR_HUB_PREFLIGHT_EXE=${process.execPath}`,
      `/DFIXTURE_EXE=${file}`, path.join(__dirname, 'installer-guard-fixture.nsi')],
    { windowsHide: true, timeout: 30000, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
    assert.ok(fs.statSync(file).size > 0);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(folder);
  }
});

test('an OS-locked preflight payload cannot be executed or bypassed in silent install', { skip: !native }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-installer-file-lock-'));
  const file = path.join(folder, 'locked-guard-fixture.exe');
  const reached = path.join(folder, 'install-section.reached');
  try {
    const compiled = spawnSync(nsis, ['/V2', '/DLOCK_PREFLIGHT_FIXTURE', `/DGUARD_FILE=${hook}`,
      `/DCREATOR_HUB_PREFLIGHT_EXE=${process.execPath}`, `/DFIXTURE_EXE=${file}`,
      path.join(__dirname, 'installer-guard-fixture.nsi')],
    { windowsHide: true, timeout: 30000, encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message || compiled.stdout);
    const child = spawnSync(file, ['/S'], { cwd: folder, windowsHide: true, timeout: 30000 });
    assert.equal(child.status, 11, child.error?.message || 'Expected preflight extraction failure, not guard refusal');
    assert.equal(fs.existsSync(reached), false, 'Nothing can reach installation after extraction fails');
  } finally {
    if (fs.existsSync(reached)) fs.unlinkSync(reached);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(folder);
  }
});

test('a short-lived no-share handle clears during retries and the native guard still runs', { skip: !native }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-installer-transient-lock-'));
  const files = ['guard.nsi', 'guard.exe', 'transient-guard-fixture.exe', 'lock-target.txt', 'lock-held.txt', 'install-section.reached', 'guard-ran.txt'];
  const [helperSource, helper, fixture, , , reached, guardRan] = files.map(n => path.join(folder, n));
  const temp = path.join(folder, 'temp');
  try {
    fs.mkdirSync(temp);
    fs.writeFileSync(helperSource, 'Unicode true\nRequestExecutionLevel user\nSilentInstall silent\n'
      + 'Name "Disposable synthetic guard"\nOutFile "${OUTPUT}"\nSection\n'
      + 'ReadEnvStr $0 CREATOR_HUB_GUARD_FIXTURE_ROOT\nStrCmp $0 "" +4\n'
      + 'FileOpen $1 "$0\\guard-ran.txt" w\nFileWrite $1 "checked"\nFileClose $1\n'
      + 'SetErrorLevel 0\nSectionEnd\n', { flag: 'wx' });
    for (const args of [[`/DOUTPUT=${helper}`, helperSource],
      ['/DTRANSIENT_PREFLIGHT_FIXTURE', `/DGUARD_FILE=${hook}`,
        `/DCREATOR_HUB_PREFLIGHT_EXE=${helper}`, `/DFIXTURE_EXE=${fixture}`, path.join(__dirname, 'installer-guard-fixture.nsi')]]) {
      const compiled = spawnSync(nsis, ['/V2', ...args], { windowsHide: true, timeout: 30000, encoding: 'utf8' });
      assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message || compiled.stdout);
    }
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
      path.join(__dirname, 'installer-transient-lock-fixture.ps1'), '-Folder', folder],
    { cwd: folder, windowsHide: true, timeout: 32000, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr || run.error?.message || run.stdout);
    assert.equal(fs.readFileSync(guardRan, 'utf8'), 'checked');
    assert.equal(fs.readFileSync(reached, 'utf8'), 'reached');
  } finally {
    for (const file of files.map(name => path.join(folder, name))) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(temp);
    fs.rmdirSync(folder);
  }
});
