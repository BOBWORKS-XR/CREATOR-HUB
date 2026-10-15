// Source/manifest checks only. These do not compile Rust or execute host settings reads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const crate = path.join(root, 'native/flatpak-host-reader');
const linux = fs.readFileSync(path.join(crate, 'src/linux.rs'), 'utf8');
const api = fs.readFileSync(path.join(crate, 'src/lib.rs'), 'utf8');

test('isolated unpublished library metadata resolves locked and offline without a build', () => {
  const result = spawnSync('cargo', ['metadata', '--locked', '--offline', '--no-deps', '--format-version', '1',
    '--manifest-path', path.join(crate, 'Cargo.toml')], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536, windowsHide: true });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(result.stdout), pkg = metadata.packages[0];
  assert.equal(metadata.packages.length, 1); assert.equal(metadata.workspace_members.length, 1);
  assert.equal(pkg.name, 'creator-hub-flatpak-host-reader'); assert.deepEqual(pkg.publish, []);
  assert.deepEqual(pkg.targets.map(target => target.kind).sort(), [['bin'], ['lib']]);
  assert.equal(pkg.targets.find(target => target.kind.includes('bin')).name, 'creator-hub-flatpak-host-inspect');
  assert.deepEqual(pkg.dependencies.map(dependency => [dependency.name, dependency.req, dependency.target]),
    [['libc', '=0.2.190', 'cfg(target_os = "linux")']]);
});

test('native source is parsed and formatted without invoking a compiler or settings reader', () => {
  const result = spawnSync('rustfmt', ['--check', '--edition', '2021', '--config', 'skip_children=true',
    path.join(crate, 'src/lib.rs'), path.join(crate, 'src/linux.rs'), path.join(crate, 'src/linux/tests.rs'),
    path.join(crate, 'src/main.rs'), path.join(crate, 'src/cli.rs')],
  { encoding: 'utf8', timeout: 15000, maxBuffer: 65536, windowsHide: true });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('local diagnostic entrypoint cannot become a broker or return raw settings', () => {
  const cli = fs.readFileSync(path.join(crate, 'src/cli.rs'), 'utf8');
  const main = fs.readFileSync(path.join(crate, 'src/main.rs'), 'utf8');
  assert.match(cli, /args\.len\(\) != 2 \|\| args\[1\] != "inspect-local"/);
  assert.ok(cli.indexOf('return Err(Error::Invocation)') < cli.indexOf('let statuses = inspect()'));
  assert.match(main, /native\.inspect_status\(setting\)/);
  assert.doesNotMatch(main, /native\.inspect\(/);
  assert.doesNotMatch(main + cli, /stdin\(|std::net|dbus|flatpak-spawn|Command::new|serde_json::from|read_to_end/);
  assert.ok(cli.includes('externalCallerAuthenticated\\\":false'));
  assert.ok(cli.includes('hostIntegrationAccepted\\\":false'));
});

test('only native-process identity and layout hints enter the API; there is no remote peer authority or writer', () => {
  assert.match(linux, /libc::getresuid/); assert.match(linux, /libc::getresgid/); assert.match(linux, /libc::getpwuid_r/);
  assert.deepEqual([...linux.matchAll(/std::env::var_os\("([^"]+)"\)/g)].map(match => match[1]).sort(),
    ['FLATPAK_ID', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']);
  assert.match(linux, /symlink_metadata\("\/\.flatpak-info"\)/);
  assert.match(api, /pub fn current_user\(\)/);
  assert.match(api, /pub fn inspect\(&mut self, setting: Setting\)/);
  assert.doesNotMatch(api + linux, /std::net|std::process|dbus|flatpak-spawn|libc::(?:write|rename|unlink|mkdir|chmod|chown)|fs::(?:write|create)|File::create|O_(?:CREAT|WRONLY|RDWR|TRUNC|APPEND)/);
});

test('source retains fixed bounds and no-follow object pinning, with a separate verified procfs reopen', () => {
  for (const token of ['O_PATH', 'O_NOFOLLOW', 'O_CLOEXEC', 'O_NOATIME', 'PROC_SUPER_MAGIC', 'meta.nlink() != 1',
    'file.setting().limit()', 'take(limit as u64 + 1)', 'current.stamps != bound.stamps', 'regular(&named.metadata()?']) {
    assert.ok(linux.includes(token), `Missing source contract: ${token}`);
  }
  const recipe = JSON.parse(fs.readFileSync(path.join(root, 'packaging/flatpak/com.creatorworks.hub.json'), 'utf8'));
  assert.deepEqual(recipe['finish-args'], ['--socket=wayland', '--socket=fallback-x11', '--device=dri', '--share=ipc']);
  assert.equal(recipe.modules.length, 1);
});
