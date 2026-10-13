import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const main = fs.readFileSync('launcher/src-tauri/src/main.rs', 'utf8');
const lifecycle = fs.readFileSync('launcher/src-tauri/src/lifecycle.rs', 'utf8');

test('writable Windows UI reserves settings ownership after read-only entries and before building UI', () => {
  const entry = main.slice(main.indexOf('fn main()'));
  assert.ok(entry.indexOf('hosted::run()') < entry.indexOf('GuiWriteOwner::current_user()'));
  assert.ok(entry.indexOf('GuiWriteOwner::current_user()') < entry.indexOf('tauri::Builder::default()'));
  assert.match(entry, /let _gui_owner = match/);
  const owner = fs.readFileSync('launcher/src-tauri/src/gui_owner.rs', 'utf8');
  assert.match(owner, /dirs::config_dir\(\)/);
  assert.match(owner, /\.share_mode\(0\)/);
  assert.match(owner, /\.truncate\(false\)/);
});

test('every app command uses a completion-lifetime guard and async additions require an audit', () => {
  const invoke = main.match(/\.invoke_handler\(\|invoke\| \{([\s\S]*?)\n\s*\}\)\s*\.build\(/)?.[1];
  assert.ok(invoke, 'the app dispatch closure must be present');
  const guards = new RegExp([
    String.raw`^\s*#\[cfg\(unix\)\]`,
    String.raw`if !invoke\s*\.message\s*\.webview_ref\(\)`,
    String.raw`\.try_state::<gui_owner::GuiWriteOwner>\(\)`,
    String.raw`\.is_some_and\(\|owner\|\s*owner\.ensure_current\(\)\.is_ok\(\)\)`,
    String.raw`\{\s*invoke\.resolver\.reject\("[^"\r\n]+"\);`,
    String.raw`return true;\s*\}`,
    String.raw`let Ok\(_command\) = lifecycle::LIFECYCLE\.command\(\) else \{`,
    String.raw`invoke\s*\.resolver\s*\.reject\("[^"\r\n]+"\);`,
    String.raw`return true;\s*\};`,
  ].join(String.raw`\s*`));
  assert.match(invoke, guards, 'ownership and lifecycle failures must return before app dispatch');
  for (const unsafeDispatch of [
    invoke.replace('#[cfg(unix)]', '#[cfg(windows)]'),
    invoke.replace('if !invoke', 'if invoke'),
    invoke.replace('owner.ensure_current().is_ok()', 'true'),
    invoke.replace('return true;', ''),
    invoke.replace('lifecycle::LIFECYCLE.command()', 'Ok(())'),
  ]) {
    assert.doesNotMatch(unsafeDispatch, guards, 'the contract must reject a bypassed guard');
  }
  assert.match(invoke, /handler\(invoke\)\s*$/);
  assert.doesNotMatch(invoke, /\bdrop\(_command\)/);
  assert.doesNotMatch(main, /#\[tauri::command[^\]]*async|#\[tauri::command[^\]]*\]\s*async fn/);
});

test('native close and exit share the atomic guard, not frontend busy detection', () => {
  assert.match(main, /\.on_window_event\(lifecycle::window_event\)/);
  assert.match(main, /\.run\(lifecycle::run_event\)/);
  assert.match(lifecycle, /CloseRequested \{ api, \.\. \}[\s\S]*?request_close\(\)[\s\S]*?api.prevent_close/);
  assert.match(lifecycle, /ExitRequested \{ api, \.\. \}[\s\S]*?request_close\(\)[\s\S]*?api.prevent_exit/);
  assert.match(lifecycle, /CreatorSuite.LifecycleProtocol/);
  assert.match(lifecycle, /CreatorSuite.LauncherBusy/);
  assert.match(lifecycle, /CreatorSuite.Closing/);
  assert.doesNotMatch(lifecycle, /std::fs|std::net|Command::|TerminateProcess|KillProcess|std::process::exit/);
});

test('new installer and uninstaller replace the force-kill macro with refusal', () => {
  const hook = fs.readFileSync('launcher/src-tauri/windows/installer-hooks.nsh', 'utf8');
  assert.match(hook, /!macroundef CheckIfAppIsRunning/);
  assert.match(hook, /!macro CheckIfAppIsRunning executableName productName/);
  const guard = fs.readFileSync('launcher/src-tauri/windows/installer-preflight.ps1', 'utf8');
  assert.match(hook, /MUI_CUSTOMFUNCTION_GUIINIT CreatorMcpPreflight/);
  assert.match(hook, /NSIS_HOOK_PREUNINSTALL/);
  assert.match(hook, /Call un\.CreatorMcpPreflight/);
  assert.match(hook, /\$CreatorPreflightPassed != 1/);
  assert.match(guard, /Get-CimInstance Win32_Process/);
  assert.match(hook, /unrelated Node processes will not be closed/);
  assert.match(hook, /IfSilent creator_preflight_cancel\s+MessageBox MB_ICONEXCLAMATION\|MB_YESNOCANCEL/);
  assert.match(hook, /IDYES creator_preflight_disconnect IDNO creator_preflight_retry\s+Goto creator_preflight_cancel/);
  assert.doesNotMatch(hook + guard, /KillProcess|Stop-Process|taskkill|TerminateProcess/);
});
