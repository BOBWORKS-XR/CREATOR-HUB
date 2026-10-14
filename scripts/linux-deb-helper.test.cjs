'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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
  assert.ok(transaction.indexOf('mark_attempt(&candidate)') < transaction.indexOf('held.handoff('));
  assert.ok(transaction.indexOf('installed(true)') > transaction.indexOf('held.handoff('));
  assert.match(code, /private\.join\(new_stage_name\(\)\?\)/);
});

test('built CLI refuses retirement and every arbitrary path/unsupported action', () => {
  const binary = path.join(crate, 'target/debug', `creator-hub-linux-deb-retirement${process.platform === 'win32' ? '.exe' : ''}`);
  assert.ok(fs.existsSync(binary), 'Run cargo build --locked for this crate first');
  for (const args of [['retire-mcp-2.7.7'], ['prepare-mcp-2.7.7', '/tmp/user.deb'], ['--root=/tmp'], ['prepare-setup-0.3.7']]) {
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
    for (const args of [[], ['inspect'], ['prepare-mcp-2.7.7']]) {
      const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 2);
      assert.match(JSON.parse(result.stdout).reason, /Native Linux only/);
    }
  }
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
  assert.match(workflow, /paths: \['\.github\/workflows\/linux-deb-helper-fixtures-014.yml'\]/);
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
