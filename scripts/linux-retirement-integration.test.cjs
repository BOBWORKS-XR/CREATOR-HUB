const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function linuxRetirementCaller(source) {
  const command = source.indexOf('pub async fn retire_convergence_apps(');
  assert.ok(command >= 0, 'Legacy retirement command remains explicit');
  const start = source.indexOf('if let Some(native) = plan.retirement_linux.take()', command);
  const end = source.indexOf('finish_without_retirement(plan, |plan|', start);
  assert.ok(start > command && end > start, 'Linux caller boundaries are ordered');
  return source.slice(start, end);
}

test('Linux migration route is nondefault and excluded from Windows compilation', () => {
  const manifest = read('src-tauri/Cargo.toml');
  assert.match(manifest, /default = \["custom-protocol"\]/);
  assert.match(manifest, /experimental-linux-migration = \[\]/);
  const main = read('src-tauri/src/main.rs');
  for (const module of ['convergence_linux', 'linux_retirement']) {
    assert.ok(main.includes(`#[cfg(all(target_os = "linux", feature = "experimental-linux-migration"))]\nmod ${module};`));
  }
  const source = read('src-tauri/src/convergence.rs');
  assert.ok(source.includes('require_no_retirement(plan, &legacy_apps()?)?;'));
  assert.ok(source.includes('crate::convergence_linux::pending()?'));
});

test('only native DEB and finite native-derived MCP/Setup path sets reach helper preparation', () => {
  const source = read('src-tauri/src/convergence_linux.rs');
  const inspect = source.slice(source.indexOf('pub fn inspect('), source.indexOf('pub fn inspect_retained('));
  assert.ok(inspect.indexOf('native_deb()?') < inspect.indexOf('targets(paths)?'));
  assert.ok(inspect.indexOf('targets(paths)?') < inspect.indexOf('Self::inspect_targets('));
  const capture = source.slice(source.indexOf('fn inspect_targets('), source.indexOf('pub fn retained_only('));
  assert.ok(capture.indexOf('journals()?') < capture.indexOf('linux_retirement::Plan::inspect(target)?'));
  assert.ok(capture.indexOf('idle(target)?') < capture.indexOf('linux_retirement::Plan::inspect(target)?'));
  assert.ok(source.includes('path.as_os_str() == std::ffi::OsStr::new(executable(*target))'));
  assert.ok(source.includes('if found.contains(&target)'));
  assert.ok(source.includes('if found.is_empty()'));
  assert.ok(source.includes('retained_only && originals.contains(&target)'));
  for (const [name, executable, desktop] of [
    ['MCP', '/usr/bin/creator-works-mcp-launcher', 'Creator Works MCP.desktop'],
    ['SETUP', '/usr/bin/creator-project-setup', 'Creator Project Setup.desktop'],
  ]) {
    assert.ok(source.includes(`const ${name}: &str = "${executable}";`));
    assert.ok(source.includes(`const ${name}_GUI: [&str; 5]`));
    assert.ok(source.includes(`/usr/share/applications/${desktop}`));
  }
  assert.ok(capture.includes('gui_retirement_snapshot(&paths, router)'));
  assert.ok(source.includes('Target::native()?.package != "deb"'));
});

test('per-product write-ahead review survives unknown results and second Cancel cannot clear first', () => {
  const source = read('src-tauri/src/convergence_linux.rs');
  const retire = source.slice(source.indexOf('pub fn retire_after_native_review('));
  assert.ok(retire.indexOf('save(app.target, State::ReviewRequired)?') < retire.indexOf('app.helper.retire_after_native_review()?'));
  assert.match(retire, /Outcome::Cancelled => \{\s+save\(app.target, State::Cancelled\)\?/);
  assert.ok(retire.includes('!completed.is_empty()'));
  assert.ok(retire.includes('Cleanup partially completed; a later system authorization was cancelled.'));
  assert.ok(source.includes('Target::Mcp => "linux-retirement-v1.json"'));
  assert.ok(source.includes('Target::Setup => "linux-retirement-setup-v1.json"'));
  const finish = source.slice(source.indexOf('pub fn complete_review('));
  assert.ok(finish.indexOf('if !self.outcome_reviewed.get()') < finish.indexOf('save(app.target, State::Verified)'));
  assert.ok(finish.indexOf('self.recheck_with(&completed)?') < finish.indexOf('save(app.target, State::Verified)'));
  const recheck = source.slice(source.indexOf('fn recheck_with('), source.indexOf('pub fn retire_after_native_review('));
  for (const guard of ['journals()?', 'idle(app.target)?', 'app.dependencies.recheck()', 'app.helper.verify_retained()?', 'app.helper.recheck_baseline()?']) {
    assert.ok(recheck.includes(guard), guard);
  }
  assert.ok(!source.includes('State::ReviewRequired =>'));
});

test('helper client checks independent installed state after the one mutation attempt', () => {
  const source = read('src-tauri/src/linux_retirement.rs');
  for (const command of ['inspect-retained-mcp-2.7.7', 'inspect-setup-0.3.7', 'inspect-retained-setup-0.3.7', 'retire-setup-0.3.7']) {
    assert.ok(source.includes(command), command);
  }
  assert.ok(source.includes('fn command(target: Target, action: Action) -> Command'));
  assert.ok(!source.includes('#[serde(default)]'));
  const retire = source.slice(source.indexOf('pub fn retire_after_native_review('));
  assert.ok(retire.indexOf('run(self.target, Action::Retire)') < retire.indexOf('self.verify_retained()?'));
  assert.ok(!source.includes('.kill(') && !source.includes('.terminate('));
  for (const forbidden of ['Command::new("sh")', 'Command::new("sudo")', 'pkill', 'killall', 'auth.json']) {
    assert.ok(!source.includes(forbidden), forbidden);
  }
});

test('preflight has one Linux job, no app installation or publication, and tests before Root compilation', () => {
  const source = read('.github/workflows/linux-migration-preflight-014.yml');
  assert.ok(source.includes('branches: [validation/linux-migration-preflight-014]'));
  assert.ok(source.includes('runs-on: ubuntu-22.04'));
  assert.ok(source.includes('paths: [.github/workflows/linux-migration-preflight-014.yml]'));
  assert.ok(source.indexOf('scripts/linux-retirement-integration.test.cjs') < source.indexOf('sudo apt-get'));
  assert.ok(source.indexOf('cargo build --locked --manifest-path native/linux-deb-retirement/Cargo.toml') < source.indexOf('node --test'));
  assert.ok(source.indexOf('cargo test --locked --manifest-path native/flatpak-host-reader/Cargo.toml') < source.indexOf('sudo apt-get'));
  assert.ok(source.includes('--features experimental-transaction --target-dir native/linux-deb-retirement/target/experimental'));
  for (const forbidden of ['windows-latest', 'macos-', 'dpkg --install', 'cargo build --manifest-path src-tauri', 'gh release', 'secrets.']) {
    assert.ok(!source.includes(forbidden), forbidden);
  }
});

test('recovered completion independently inspects retained state and never replays a transaction', () => {
  const source = read('src-tauri/src/convergence_linux.rs');
  const inspect = source.slice(source.indexOf('pub fn inspect_retained('), source.indexOf('pub fn retained_only('));
  assert.ok(inspect.includes('Self::inspect_targets(&[], router)'));
  assert.ok(inspect.includes('linux_retirement::Plan::inspect_retained(target)?'));
  const retire = source.slice(source.indexOf('pub fn retire_after_native_review('));
  assert.match(retire, /if app.retained_only \{[\s\S]*?continue;\s+\}/);
  assert.ok(retire.indexOf('if app.retained_only') < retire.indexOf('save(app.target, State::ReviewRequired)?'));
  assert.ok(retire.indexOf('self.recheck_with(&completed)?') < retire.indexOf('app.helper.retire_after_native_review()?'));
});

test('Root caller keeps backup, journal, router, explicit approval and missing-GUI checks', () => {
  const source = read('src-tauri/src/convergence.rs');
  const caller = linuxRetirementCaller(source);
  for (const guard of ['can_retain(plan)?', 'fresh_runtime.generation != runtime.generation', 'fresh_router.command != router.command',
    'native.recheck()?', '.blocking_show()', 'if !approved', 'if !legacy_apps()?.is_empty()', 'native.complete_review()?']) {
    assert.ok(caller.includes(guard), guard);
  }
  const mutation = caller.indexOf('native.retire_after_native_review()?');
  assert.ok(caller.indexOf('preflight()?') < mutation);
  assert.ok(caller.indexOf('preflight()?;', mutation) > mutation);
  assert.ok(source.includes('for backup in &plan.retained_images'));
  assert.ok(source.includes('backup.recheck()?'));
  const helper = read('native/linux-deb-retirement/src/main.rs');
  assert.match(helper, /cfg\(not\(feature = "experimental-transaction"\)\)/);
  assert.ok(helper.includes('Action::Retire | Action::RetireSetup'));
  assert.ok(helper.includes('return Err(INSTALL_REFUSAL.into())'));
});

test('Linux native review covers Setup and partial cancellation without granting release acceptance', () => {
  const source = read('src-tauri/src/convergence.rs');
  const caller = linuxRetirementCaller(source);
  for (const text of ['Only exact MCP 2.7.7 and Project Setup 0.3.7 packages are eligible',
    'one fixed non-executable retirement notice', 'each unretired app',
    'Cancelling a later system prompt does not undo earlier cleanup',
    'settings and any pending outcome review were kept', 'not release acceptance']) {
    assert.ok(caller.includes(text), text);
  }
  assert.ok(!caller.includes('Retire the verified standalone MCP 2.7.7 DEB launcher?'));
  const helper = read('src-tauri/src/linux_retirement.rs');
  assert.ok(helper.includes('pending for manual package-state review even if the original package is still installed'));
});

test('an earlier batch completion call cannot truncate the legacy Linux caller checks', () => {
  const source = read('src-tauri/src/convergence.rs');
  const original = linuxRetirementCaller(source);
  assert.equal(linuxRetirementCaller(`finish_without_retirement(plan, |plan| unrelated);\n${source}`), original);
  assert.ok(original.includes('can_retain(plan)?'));
  assert.ok(original.includes('Only exact MCP 2.7.7 and Project Setup 0.3.7 packages are eligible'));
});
