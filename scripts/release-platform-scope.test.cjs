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

test('active release and router CI target only Windows and Linux', () => {
  const release = workflow('release.yml');
  assert.match(release, /- os: windows-latest/);
  assert.match(release, /- os: ubuntu-22\.04/);
  assert.doesNotMatch(release, /- os: macos-/);
  assert.match(workflow('ci.yml'), /os: \[windows-latest, ubuntu-22\.04\]/);
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
