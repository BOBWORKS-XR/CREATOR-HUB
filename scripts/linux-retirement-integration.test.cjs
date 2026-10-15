const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

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

test('only native DEB and exact native-derived MCP location can reach helper preparation', () => {
  const source = read('src-tauri/src/convergence_linux.rs');
  const inspect = source.slice(source.indexOf('pub fn inspect('), source.indexOf('pub fn recheck('));
  assert.ok(inspect.indexOf('native_deb()?') < inspect.indexOf('linux_retirement::Plan::inspect()'));
  assert.ok(inspect.indexOf('paths != [PathBuf::from(MCP)]') < inspect.indexOf('linux_retirement::Plan::inspect()'));
  assert.ok(inspect.indexOf('pending()?') < inspect.indexOf('linux_retirement::Plan::inspect()'));
  assert.ok(inspect.indexOf('idle()?') < inspect.indexOf('linux_retirement::Plan::inspect()'));
  assert.ok(source.includes('Target::native()?.package != "deb"'));
});

test('write-ahead review survives uncertain outcomes and only native Cancel clears its pending state', () => {
  const source = read('src-tauri/src/convergence_linux.rs');
  const retire = source.slice(source.indexOf('pub fn retire_after_native_review('));
  assert.ok(retire.indexOf('save(State::ReviewRequired)?') < retire.indexOf('self.helper.retire_after_native_review()?'));
  assert.match(retire, /Outcome::Cancelled => save\(State::Cancelled\)\?/);
  const finish = source.slice(source.indexOf('pub fn complete_review('));
  assert.ok(finish.indexOf('self.helper.verify_retained()?') < finish.indexOf('save(State::Verified)'));
  assert.ok(finish.indexOf('self.dependencies') < finish.indexOf('save(State::Verified)'));
  assert.ok(!source.includes('State::ReviewRequired =>'));
});

test('helper client checks independent installed state after the one mutation attempt', () => {
  const source = read('src-tauri/src/linux_retirement.rs');
  assert.ok(source.includes('inspect-retained-mcp-2.7.7'));
  const retire = source.slice(source.indexOf('pub fn retire_after_native_review('));
  assert.ok(retire.indexOf('run(Action::Retire)') < retire.indexOf('self.verify_retained()?'));
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
  for (const forbidden of ['windows-latest', 'macos-', 'dpkg --install', 'cargo build', 'gh release', 'secrets.']) {
    assert.ok(!source.includes(forbidden), forbidden);
  }
});
