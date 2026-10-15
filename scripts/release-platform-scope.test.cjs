const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const workflow = name => fs.readFileSync(path.join(__dirname, '../.github/workflows', name), 'utf8');
function disabled(name, job) {
  const section = workflow(name).split('  ' + job + ':')[1];
  assert.ok(section, 'Retain historical job ' + name + ':' + job);
  assert.ok(section.startsWith('\n    if: ${{ false }} # macOS support suspended')
    || section.startsWith('\r\n    if: ${{ false }} # macOS support suspended'),
  'Mac job must refuse scheduling: ' + name + ':' + job);
}

test('release promotion is Windows-only, not Linux or Flatpak publication', () => {
  const release = workflow('release.yml');
  assert.match(release, /\bwindows-x86_64\b/, 'Use the exact Windows release target, not a generic ready flag');
  assert.doesNotMatch(release, /label: (?:Linux|macOS)|--bundles\s+(?:appimage|deb|rpm|dmg)|tauri-apps\/tauri-action|flatpak(?:-builder|\s+build-export)/i);
  assert.doesNotMatch(release, /- os: macos-/);
});

test('Windows-only publication preserves active Linux development CI', () => {
  const ci = workflow('ci.yml');
  assert.match(ci, /os: \[windows-latest, ubuntu-22\.04\]/);
  const linux = ci.match(/^  hub-linux:\r?\n([\s\S]*?)(?=^  [\w-]+:|(?![\s\S]))/m);
  assert.ok(linux, 'Retain the Linux development job');
  assert.match(linux[1], /runs-on: ubuntu-22\.04/);
  assert.doesNotMatch(linux[1], /if: \$\{\{ false \}\}/);
  assert.match(linux[1], /cargo clippy --release --locked --manifest-path src-tauri\/Cargo\.toml --all-targets -- -D warnings/);
  assert.match(linux[1], /npm run build -- --bundles appimage,deb,rpm/);
  assert.match(linux[1], /Retain development packages \(not a release\)/);
  assert.doesNotMatch(ci, /contents: write|gh release (?:create|upload|edit)|tauri-apps\/tauri-action/);
  disabled('ci.yml', 'hub-macos');
});

test('native Linux payload and helper workflows cannot select a Mac runner', () => {
  for (const name of ['unix-managed-payload.yml', 'unified-unix-candidate.yml', 'native-gui-helpers.yml']) {
    const source = workflow(name);
    assert.match(source, /os: \[ubuntu-22\.04\]/);
    assert.doesNotMatch(source, /os:.*macos|options:.*macos/);
  }
  const acceptance = workflow('unix-hosted-acceptance.yml');
  assert.match(acceptance, /options: \[linux\]/);
  assert.doesNotMatch(acceptance, /runs-on:.*macos/);
  const assembly = workflow('unix-managed-assembly.yml');
  assert.ok(assembly.includes("assert.equal(process.env.TARGET,'linux','macOS support is suspended')"));
  assert.doesNotMatch(assembly, /runs-on:.*matrix\.os|runs-on:.*macos/);
});

test('historical Mac-only diagnostics remain preserved but every job is disabled', () => {
  for (const [name, jobs] of [
    ['macos-dmg-repack.yml', ['repack']],
    ['native-mac-gui-admission.yml', ['admission']],
    ['native-macos-app-probe.yml', ['probe']],
    ['native-macos-launch-control.yml', ['select-control', 'control']],
    ['native-macos-legacy-retirement-probe.yml', ['legacy-baseline']],
  ]) for (const job of jobs) disabled(name, job);
});
