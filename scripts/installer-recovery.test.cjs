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
  assert.equal((source.match(/^\s*BringToFront\s*$/gm) || []).length, 1);
  assert.match(source, /\/SD IDCANCEL IDRETRY \+3\s+SetErrorLevel 10\s+Abort/);
});

const nsis = path.join(process.env.LOCALAPPDATA || '', 'tauri/NSIS/makensis.exe');
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
