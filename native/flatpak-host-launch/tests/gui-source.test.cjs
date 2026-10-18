'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, 'src', name), 'utf8');
const install = read('linux/gui_install.rs');
const gui = read('linux/gui.rs');
const identity = read('linux/identity.rs');
const protocol = read('gui_protocol.rs');

test('production native pin is compiled and checked before all installation work', () => {
  assert.match(install, /option_env!\("CREATOR_FLATPAK_GUI_SHA256"\)/);
  assert.ok(install.indexOf('let hash = compiled_hash()?') < install.indexOf('let uid = identity::uid()?'));
  assert.match(install, /app\/com\.creatorworks\.hub\/x86_64\/stable/);
  assert.match(install, /runtime\/org\.gnome\.Platform\/x86_64\/50/);
  assert.match(install, /const FLATPAK: &str = "\/usr\/bin\/flatpak"/);
  assert.match(install, /identity::directory\(Path::new\("\/usr\/bin"\), 0, false\)/);
  for (const forbidden of ['GITHUB_ACTIONS', 'RUNNER_TEMP', 'FLATPAK_USER_DIR', 'flatpak-spawn', 'sh -c', 'Command::new("sh")']) {
    assert.ok(!install.includes(forbidden), forbidden);
  }
  assert.match(install, /\.env_clear\(\)/);
  assert.match(install, /"--command=\/app\/bin\/creator-hub"/);
});

test('production reuses the actual kernel proof and keeps echo grant semantics separate', () => {
  assert.match(gui, /identity::sender\(message, self\.sender, self\.owner, self\.installed\.uid\)/);
  assert.match(gui, /identity::deployment_image\(/);
  assert.match(gui, /sandbox: identity::Sandbox::Gui\(/);
  assert.match(identity, /sandbox: Sandbox::Echo\(root\)/);
  assert.match(identity, /Sandbox::Echo\(root\) => replacement_refusal/);
  assert.match(identity, /Sandbox::Gui\(_\) => Err\("replacement-deployment"\)/);
  assert.match(identity, /"shared" if gui => &\["ipc", "network"\]/);
  assert.match(identity, /gui-environment-override/);
  assert.match(identity, /missing-bootstrap-policy/);
  assert.match(gui, /self\.sender = Some\(self\.checked\(&message, deadline\)\?\)/);
});

test('GUI policy matches the actual bootstrap NAME, never its INTERFACE or a stale independent name', () => {
  const bootstrap = fs.readFileSync(path.resolve(root, '../../src-tauri/src/flatpak_bootstrap.rs'), 'utf8');
  const doc = fs.readFileSync(path.join(root, 'GUI-ADMISSION.md'), 'utf8');
  const literal = (source, key) => {
    const matches = [...source.matchAll(new RegExp(`^const ${key}: &str = "([A-Za-z0-9_.]+)";\\r?$`, 'gm'))];
    assert.equal(matches.length, 1, `Exactly one literal bootstrap ${key} required`);
    return matches[0][1];
  };
  const check = (bootstrapSource, policySource, documentation) => {
    const name = literal(bootstrapSource, 'NAME');
    const iface = literal(bootstrapSource, 'INTERFACE');
    assert.notEqual(name, iface, 'The bus name and interface are distinct contracts');
    const allowed = [...policySource.matchAll(/if key != "([A-Za-z0-9_.]+)" \|\| value != "talk"/g)];
    const required = [...policySource.matchAll(/"Session Bus Policy"\.to_owned\(\),\s*"([A-Za-z0-9_.]+)"\.to_owned\(\),/g)];
    assert.equal(allowed.length, 1); assert.equal(required.length, 1);
    assert.equal(allowed[0][1], name, 'GUI allowlist must match the real bootstrap NAME');
    assert.equal(required[0][1], name, 'GUI required policy must match the real bootstrap NAME');
    assert.ok(documentation.includes(`\`${name}=talk\``), 'Document the real bus policy');
    assert.ok(!documentation.includes(`\`${iface}=talk\``), 'An interface is not a bus policy name');
  };
  check(bootstrap, identity, doc);
  const name = literal(bootstrap, 'NAME');
  const iface = literal(bootstrap, 'INTERFACE');
  assert.throws(() => check(bootstrap.replace(`"${name}"`, '"com.creatorworks.hub.OtherHost"'), identity, doc));
  for (const wrong of [iface, 'com.creatorworks.HubHost1']) {
    assert.throws(() => check(bootstrap, identity.replaceAll(name, wrong), doc.replaceAll(name, wrong)));
  }
  assert.throws(() => check(`${bootstrap}\nconst NAME: &str = "duplicate";\n`, identity, doc));
});

test('GUI full hash is admission-only; held/fresh image and root stamps refuse all drift', () => {
  assert.match(install, /identity::GuiImagePin::admit\(/);
  const admission = identity.slice(identity.indexOf('impl GuiImagePin'), identity.indexOf('pub(crate) struct Deployment'));
  assert.equal((admission.match(/digest\(/g) || []).length, 1);
  const held = admission.slice(admission.indexOf('fn held('));
  assert.ok(!held.includes('digest('));
  assert.match(held, /Stamp::of\(actual\)/);
  assert.match(held, /Stamp::of\(installed\)/);
  assert.match(held, /Stamp::of\(mounted\)/);
  assert.match(identity, /ctime: \(m\.ctime\(\), m\.ctime_nsec\(\)\)/);
  assert.match(identity, /mtime: \(m\.mtime\(\), m\.mtime_nsec\(\)\)/);
  assert.match(identity, /Sandbox::Echo\(_\) => digest\(actual, profile\.executable_hash, deadline\)/);
  assert.match(identity, /Sandbox::Gui\(pin\) => pin\.image\(&actual, &installed\)/);
});

test('FD3 is borrowed and shape-checked before ownership; never publicly exposed', () => {
  assert.ok(gui.indexOf('BorrowedFd::borrow_raw(3)') < gui.indexOf('OwnedFd::from_raw_fd(3)'));
  assert.match(gui, /INHERITED_ADOPTED\.swap\(true, Ordering::AcqRel\)/);
  assert.match(gui, /libc::FD_CLOEXEC/);
  for (const method of ['pub fn from_raw_fd', 'pub fn raw_fd', 'pub fn into_raw_fd', 'pub fn from_trusted']) assert.ok(!gui.includes(method), method);
  assert.match(gui, /wire::exact\(&accepted, Kind::Accepted, 0, result\.session\)/);
  assert.match(gui, /wire::exact\(&challenge, Kind::Challenge, 0, challenge\.session\)/);
});

test('32 inflight, session-bound response tokens, finite chunks and nonfatal idle are explicit', () => {
  assert.match(protocol, /const INFLIGHT: usize = 32/);
  assert.match(protocol, /const PACKET: usize = 16 \* 1024/);
  assert.match(protocol, /const LIMIT: usize = 2 \* 1024 \* 1024/);
  assert.match(gui, /request\.session != self\.session/);
  assert.match(gui, /Err\("deadline"\) if first => return Ok\(None\)/);
  assert.match(gui, /deadline = Instant::now\(\) \+ EXCHANGE/);
  assert.match(gui, /result\.map_err\(\|r\| self\.fail\(r\)\)/);
  for (const forbidden of ['tauri::', 'AppHandle', 'load_config', 'create_project', 'std::fs::write']) assert.ok(!gui.includes(forbidden), forbidden);
});
