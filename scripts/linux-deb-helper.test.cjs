'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const crate = path.join(root, 'native/linux-deb-retirement');
const source = name => fs.readFileSync(path.join(crate, 'src', name), 'utf8');
const proof = JSON.parse(fs.readFileSync(path.join(root, 'docs/evidence/linux-deb-retention-014.json')));
const pattern = /pin!\(\s*"([^"]+)",\s*(\d+),\s*(0o[0-7]+),\s*"([a-f0-9]{64})",\s*"([a-f0-9]{32})",\s*(true|false)\s*,?\s*\)/g;
const pins = Array.from(source('pins.rs').matchAll(pattern), m => ({ path: m[1], bytes: Number(m[2]), mode: parseInt(m[3].slice(2), 8), sha256: m[4], md5: m[5], retained: m[6] === 'true' }));

test('compiled pins match permanent runtime and public package evidence', () => {
  assert.equal(pins.length, 14);
  const retained = pins.filter(p => p.retained);
  assert.equal(retained.length, 9);
  for (const measured of proof.originalRuntime.files) {
    const pin = retained.find(p => p.path === `usr/lib/Creator Works MCP/server/${measured.path}`);
    assert.ok(pin, measured.path);
    assert.equal(pin.bytes, measured.bytes);
    assert.equal(pin.sha256, measured.sha256);
    assert.equal(pin.mode, parseInt(measured.mode, 8));
  }
  assert.deepEqual(pins.filter(p => !p.retained).map(p => '/' + p.path).sort(), proof.omittedPathsAndOwnershipVerifiedAbsent.slice().sort());
  const publicPins = JSON.parse(fs.readFileSync(path.join(root, 'docs/evidence/legacy-unix-public-package-pins-014.json')));
  for (const member of publicPins.packages.find(p => p.asset === 'Creator.Works.MCP_2.7.7_amd64.deb').members) {
    const pin = pins.find(p => p.path === member.member);
    assert.equal(pin?.bytes, member.bytes);
    assert.equal(pin?.sha256, member.sha256);
  }
});

test('default stays closed and experimental installer has only the fixed handoff', () => {
  const code = source('linux.rs').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /"--(?:install|remove|purge|force[^" ]*)"|pkexec|sudo|remove_file|remove_dir|setuid\(/);
  assert.match(code, /libc::F_SETLK/);
  assert.match(code, /lock-frontend/);
  assert.match(code, /#\[cfg\(feature = "experimental-transaction"\)\]\s*mod transaction/);
  assert.match(code, /env_clear\(\)/);
  assert.match(code, /O_NOFOLLOW/);
  assert.match(code, /create_new\(true\)/);
  assert.match(source('main.rs'), /Action::Retire[\s\S]*?INSTALL_REFUSAL/);
  const manifest = fs.readFileSync(path.join(crate, 'Cargo.toml'), 'utf8');
  assert.match(manifest, /default = \[\]/);
  const transaction = source('linux/transaction.rs');
  assert.match(transaction, /env\("DPKG_FRONTEND_LOCKED", "1"\)/);
  assert.match(transaction, /arg\("--install"\)\s*\.arg\(candidate\)/);
  assert.doesNotMatch(transaction, /\.kill\(|remove_file|remove_dir|"--force|sudo|pkexec/);
  assert.ok(transaction.indexOf('mark_attempt(&candidate, target)') < transaction.indexOf('held.handoff('));
  assert.ok(transaction.indexOf('installed(true)') > transaction.indexOf('held.handoff('));
  assert.match(code, /private\.join\(new_stage_name\(\)\?\)/);
});

test('frontend CI builds the default helper before running its CLI assertions', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8').split('  frontend:')[1].split('  hub-windows:')[0];
  const build = ci.indexOf('cargo build --locked --manifest-path native/linux-deb-retirement/Cargo.toml --no-default-features');
  assert.ok(build >= 0);
  assert.ok(build < ci.indexOf('npm run test:scripts'));
  assert.match(ci, /workspaces: native\/linux-deb-retirement/);
});

test('built CLI refuses retirement and every arbitrary path/unsupported action', () => {
  const binary = path.join(crate, 'target/debug', `creator-hub-linux-deb-retirement${process.platform === 'win32' ? '.exe' : ''}`);
  assert.ok(fs.existsSync(binary), 'Run cargo build --locked for this crate first');
  for (const args of [['retire-mcp-2.7.7'], ['retire-setup-0.3.7'], ['prepare-mcp-2.7.7', '/tmp/user.deb'], ['--root=/tmp'], ['prepare-setup-0.3.7']]) {
    const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'refused');
    assert.equal(report.installationEnabled, false);
    assert.equal(report.packageTransactionStarted, false);
    assert.equal(report.experimentalTransactionCompiled, false, 'Node harness must use the separate default build');
  }
  if (process.platform !== 'linux') {
    for (const args of [[], ['inspect'], ['inspect-retained-mcp-2.7.7'], ['inspect-setup-0.3.7'], ['inspect-retained-setup-0.3.7'], ['prepare-mcp-2.7.7']]) {
      const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 2);
      assert.match(JSON.parse(result.stdout).reason, /Native Linux only/);
    }
  }
});

test('retained MCP inspection independently validates the fixed package without retry-marker admission or writes', () => {
  const branch = source('linux.rs').split('Action::InspectRetainedMcp => {')[1]?.split('Action::Inspect => {')[0];
  assert.ok(branch);
  assert.match(branch, /installed\(true\)\?;/);
  assert.ok(branch.indexOf('installed(true)?') < branch.indexOf('retained_inspection_report()'));
  assert.doesNotMatch(branch, /refuse_prior_attempt|prepare\(|transaction::|write_new|create_directory/);
  const installed = source('linux.rs').split('fn installed(compatibility: bool)')[1].split('fn create_directory')[0];
  for (const check of ['compatibility_state', 'installed_metadata', 'compatibility_listing', 'resource(pin', 'Retired path still present/unreadable', 'Retired path still has package ownership']) {
    assert.ok(installed.includes(check), check);
  }
});

test('Setup pins match the exact public DEB and admit only the finite experimental transaction', () => {
  const evidence = JSON.parse(fs.readFileSync(path.join(root, 'docs/evidence/legacy-unix-public-package-pins-014.json')));
  const published = evidence.packages.find(p => p.asset === 'Creator.Project.Setup_0.3.7_amd64.deb');
  const setup = source('setup.rs');
  assert.ok(setup.includes(published.packageSha256));
  assert.ok(setup.includes(String(published.packageBytes)));
  for (const pin of [...published.control, ...published.members]) {
    assert.ok(setup.includes(pin.sha256), pin.member);
  }
  const notice = Buffer.from(JSON.parse(setup.match(/pub const NOTICE: &\[u8\] = b("(?:[^"\\]|\\.)*");/)[1]));
  assert.equal(notice.length, 200);
  assert.ok(setup.includes(crypto.createHash('sha256').update(notice).digest('hex')));
  assert.ok(setup.includes(crypto.createHash('md5').update(notice).digest('hex')));
  assert.doesNotMatch(source('lib.rs'), /\["prepare-setup-/);
  assert.match(source('lib.rs'), /\["retire-setup-0\.3\.7"\] => Ok\(Action::RetireSetup\)/);
  assert.match(source('main.rs'), /Action::Retire \| Action::RetireSetup[\s\S]*?INSTALL_REFUSAL/);
  assert.doesNotMatch(setup, /Command::|sudo|pkexec|remove_file|remove_dir|"--(?:install|remove|purge)"/);
});

test('Setup verifier admits no scripts, foreign owner, pre-existing notice or user-data payload', () => {
  const native = source('linux/setup.rs');
  for (const check of ['contract::state', 'contract::installed_metadata', 'contract::listing',
    'info_members(false)', 'contract::MD5_SHA256', 'Target::Setup', 'resource(pin',
    'Foreign/shared Setup resource ownership', 'original_notice_absent()', 'Unknown Setup tombstone namespace member']) {
    assert.ok(native.includes(check), check);
  }
  assert.ok(native.indexOf('refuse_prior_attempt_for(Target::Setup)?') < native.indexOf('let work = private.join('));
  assert.match(native, /entries\.len\(\) == 1/);
  assert.match(native, /count < 4/);
  assert.match(native, /archive::verify_controls/);
  assert.match(native, /archive::verify_data/);
  assert.doesNotMatch(native, /sudo|pkexec|remove_file|remove_dir|"--(?:install|remove|purge)"|setuid\(/);
  const transaction = source('linux/transaction.rs');
  for (const call of ['setup::prepare_locked(&held)?', 'setup::verify_candidate(&candidate)?', 'setup::installed(true)']) {
    assert.ok(transaction.includes(call), call);
  }
  assert.ok(transaction.indexOf('mark_attempt(&candidate, target)') < transaction.indexOf('held.handoff('));
  assert.ok(transaction.indexOf('setup::installed(true)') > transaction.indexOf('held.handoff('));
  assert.ok(transaction.includes('Path::new(target.private()).join(ATTEMPT)'));
  assert.match(transaction, /manual\(e, Some\(started\)\)/);
  assert.ok(transaction.indexOf('Interrupts::register()?') < transaction.indexOf('mark_attempt(&candidate, target)'));
  assert.match(transaction, /held\.handoff\(\|\| \{\s*require\(!interrupts\.requested\(\), "Interrupted before dpkg spawn"\)\?;\s*let mut child = cmd\.spawn\(\)\?;\s*started = true;/);
  assert.match(transaction, /e\.kind\(\) == std::io::ErrorKind::Interrupted => continue/);
  assert.ok(transaction.includes('Helper interrupted while waiting; review package state and protected logs'));
  assert.ok(transaction.includes('Helper interrupted during post-verification'));
  assert.doesNotMatch(transaction, /\.kill\(|remove_file|remove_dir|"--force/);
});

test('Setup read-only inspection independently re-queries state and rejects false absence', () => {
  const inspect = source('linux/setup.rs').split('pub(super) fn inspect(retained_only: bool)')[1].split('#[cfg(feature')[0];
  for (const check of ['queried_state()?', 'installed(false)?', 'installed(true)?', 'info_members(true)?',
    'unowned_absent', 'original_notice_absent()?', 'metadata.unchanged()?', 'queried_state()? == state']) {
    assert.ok(inspect.includes(check), check);
  }
  assert.doesNotMatch(inspect, /refuse_prior_attempt|prepare_locked|write_new|create_directory|transaction::/);
});

test('post-auth fixed GUI writer guard is retained across the entire transaction', () => {
  const transaction = source('linux/transaction.rs');
  const acquire = 'let _gui_guard = gui::acquire(target)?;';
  assert.ok(transaction.indexOf(acquire) > transaction.indexOf('privileged_image()?'));
  assert.ok(transaction.indexOf('refuse_prior_attempt_for(target)?') < transaction.indexOf(acquire));
  assert.ok(transaction.indexOf(acquire) < transaction.indexOf('prepare_locked(&held)?'));
  assert.ok(transaction.indexOf(acquire) < transaction.indexOf('setup::prepare_locked(&held)?'));
  assert.ok(transaction.indexOf(acquire) < transaction.indexOf('mark_attempt(&candidate, target)'));
  assert.ok(transaction.indexOf(acquire) < transaction.indexOf('held.handoff('));
  assert.doesNotMatch(transaction, /drop\(_gui_guard\)|let _ = gui::/);
  const gui = source('linux/gui.rs').split('#[cfg(test)]')[0];
  for (const required of ['usr/bin/creator-works-mcp-launcher', 'usr/bin/creator-project-setup',
    'copy_pinned(&image', 'open(&path, libc::O_RDONLY)', 'open(&path, libc::O_WRONLY)',
    '_image: File', '_writer: File', 'stamp(&writer.metadata()?)', 'stamp(&image.metadata()?)']) {
    assert.ok(gui.includes(required), required);
  }
  assert.ok(gui.indexOf('copy_pinned(&image') < gui.indexOf('open(&path, libc::O_WRONLY)'));
  assert.doesNotMatch(gui, /Command::|\.kill\(|libc::kill|\/proc|PKEXEC_UID|O_CREAT|O_TRUNC|write_all|\.write\(/);
  assert.match(source('linux.rs'), /access \| libc::O_NOFOLLOW \| libc::O_CLOEXEC \| libc::O_NONBLOCK/);
});

test('writer kernel fixtures cover busy, held, renamed/deleted, close and binding failures', () => {
  const gui = source('linux/gui.rs');
  for (const scenario of ['busy_image_refuses_guard_and_preserves_bytes_modes',
    'held_guard_blocks_exec_but_allows_rename_and_unlink_without_byte_changes',
    'changed_stamp_or_replacement_inode_refuses_binding', 'libc::ETXTBSY',
    'libc::FD_CLOEXEC', 'drop(child)', 'drop(guard)', 'exec_ok(&deleted)']) {
    assert.ok(gui.includes(scenario), scenario);
  }
  assert.doesNotMatch(gui.split('#[cfg(test)]')[0], /ManualRepair|transaction-attempted/);
  assert.doesNotMatch(gui, /\.kill\(|libc::kill|pidfd_send_signal/);
  assert.match(source('lib.rs'), /"packageTransactionStarted": manual\.map/);
});

test('prepared native script refuses this host before any build or native probe', () => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  if (!fs.existsSync(bash)) return;
  const script = path.join(__dirname, 'linux-deb-helper-native-check.sh');
  const syntax = spawnSync(bash, ['-n', script], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(syntax.error);
  assert.equal(syntax.status, 0);
  const result = spawnSync(bash, [script], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, CREATOR_LINUX_DEB_HELPER_FIXTURES: '', GITHUB_ACTIONS: '' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Refused: opted-in, unprivileged disposable/);
});

test('new fixture workflow is one guarded push-only job without privilege or product builds', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/linux-deb-helper-fixtures-014.yml'), 'utf8');
  assert.match(workflow, /branches: \[validation\/linux-deb-helper-fixtures-014\]/);
  for (const file of ['.github/workflows/linux-deb-helper-fixtures-014.yml', 'native/linux-deb-retirement/**',
    'scripts/linux-deb-helper-fixtures-probe.py', 'scripts/linux-deb-helper-fixtures.test.py',
    'scripts/linux-deb-helper-native-check.sh', 'scripts/linux-deb-helper.test.cjs']) {
    assert.ok(workflow.includes(`      - ${file}\n`), file);
  }
  assert.match(workflow, /github\.repository_id == '1364807512'/);
  assert.match(workflow, /github\.repository == 'BOBWORKS-XR\/CREATOR-HUB'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/validation\/linux-deb-helper-fixtures-014'/);
  assert.match(workflow, /github\.event_name == 'push'/);
  assert.match(workflow, /runs-on: ubuntu-22\.04/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /run: python3 -B scripts\/linux-deb-helper-fixtures-probe.py/);
  assert.doesNotMatch(workflow, /workflow_dispatch|pull_request|schedule:|matrix:|sudo|pkexec|apt-get|cargo build|npm |src-tauri|modules\//);
  const native = fs.readFileSync(path.join(__dirname, 'linux-deb-helper-native-check.sh'), 'utf8');
  assert.match(native, /GITHUB_REF:-.*validation\/linux-deb-helper-fixtures-014/);
  assert.match(native, /GITHUB_EVENT_NAME:-.*push/);
  assert.doesNotMatch(native.replace(/^\s*#.*$/gm, ''), /sudo|pkexec|apt-get|--install|src-tauri|modules\//);
  const capture = fs.readFileSync(path.join(__dirname, 'linux-deb-helper-fixtures-probe.py'), 'utf8');
  assert.doesNotMatch(capture, /sudo|pkexec|apt-get|["']--(?:install|remove|purge)["']|src-tauri|modules\//);
  assert.match(capture, /"productionGates": dict\.fromkeys\(GATES, False\)/);
});
