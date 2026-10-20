const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Linux actual install follows catalog and separate signature verification, never the pathname installer', () => {
  const source = read('src-tauri/src/self_update.rs');
  const install = source.slice(source.indexOf('pub async fn install_hub_update('), source.indexOf('#[cfg(test)]'));
  assert.ok(install.indexOf('key.verify(&bytes, &signature, false)') < install.indexOf('crate::linux_update::install('));
  assert.match(install, /#\[cfg\(target_os = "linux"\)\][\s\S]*?linux_update::install\(&bytes, release\.byte_length, &release\.sha256/);
  assert.match(install, /Outcome::Cancelled\s*\{\s*return Ok\("Hub update cancelled at system authorization/);
  assert.ok(install.indexOf('Outcome::Cancelled') < install.indexOf('handle.request_restart()'));
  assert.match(install, /#\[cfg\(not\(any\(target_os = "macos", target_os = "linux"\)\)\)\]\s*update\.install\(bytes\)/);
});

test('unsupported package or missing system installer refuses before native update confirmation and view suspension', () => {
  const source = read('src-tauri/src/self_update.rs');
  assert.match(source, /let target = Target::native\(\)\?;\s*crate::linux_update::preflight\(target\.package\)\?;/);
  const install = source.slice(source.indexOf('pub async fn install_hub_update('));
  assert.ok(install.indexOf('let installed = installed_location(&handle)?;') < install.indexOf('let approved = handle.dialog()'));
  assert.ok(install.indexOf('let installed = installed_location(&handle)?;') < install.indexOf('suspend_for_update('));
});

test('production updater contains neither the permissive fixture policy nor a password or sudo fallback', () => {
  const source = read('src-tauri/src/linux_update.rs');
  for (const absent of ['policy_xml', 'polkit.Result.YES', 'fixture.rules', 'sudo', 'zenity', 'kdialog', 'shell=True']) {
    assert.ok(!source.includes(absent), absent);
  }
  assert.ok(source.includes('"--disable-internal-agent"'));
  assert.ok(source.includes('F_SEAL_WRITE') && source.includes('F_SEAL_GROW') && source.includes('F_SEAL_SHRINK') && source.includes('F_SEAL_SEAL'));
});
