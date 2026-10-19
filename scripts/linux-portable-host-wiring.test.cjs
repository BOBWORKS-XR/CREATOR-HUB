'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { yaml } = require('playwright-core/lib/utilsBundle');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');

test('Linux source workflow actually compiles and tests the default-off portable host', () => {
  const workflow = yaml.parse(read('.github/workflows/linux-integrated-features.yml'), { uniqueKeys: true });
  assert.equal(workflow.permissions.contents, 'read');
  assert.deepEqual(Object.keys(workflow.jobs), ['native-libraries']);
  const job = workflow.jobs['native-libraries'];
  assert.equal(job['runs-on'], 'ubuntu-22.04');
  assert.equal(job['timeout-minutes'], 30);
  assert.equal(job.steps[0].with['persist-credentials'], false);
  assert.match(job.if, /refs\/heads\/validation\/linux-integrated-features/);
  const scripts = job.steps.filter(step => step.run).map(step => step.run).join('\n');
  for (const mode of ['clippy', 'test']) {
    const command = scripts.split('\n').find(line => line.startsWith(`cargo ${mode} --locked --manifest-path src-tauri/Cargo.toml `));
    assert.ok(command, `real Root ${mode} missing`);
    assert.match(command, /--features [^\n ]*experimental-linux-portable-host/);
    assert.match(scripts, new RegExp(`cargo ${mode} --locked --manifest-path native/linux-portable-deployment/Cargo\\.toml `));
  }
  assert.ok(!scripts.includes('--ignored'));
  for (const forbidden of ['cargo tauri build', 'publish-hub', 'gh release', 'flatpak install', 'dpkg --install', 'macos']) {
    assert.ok(!scripts.includes(forbidden), forbidden);
  }
});

test('portable guard is Linux-only, optional and runs before native GUI initialization', () => {
  const cargo = read('src-tauri/Cargo.toml');
  assert.match(cargo, /default = \["custom-protocol"\]/);
  assert.match(cargo, /experimental-linux-portable-host = \["dep:creator-hub-linux-portable-deployment", "integrated-features", "experimental-flatpak-host"\]/);
  const linuxDependencies = cargo.split('[target.\'cfg(target_os = "linux")\'.dependencies]')[1].split('\n[')[0];
  assert.ok(linuxDependencies.includes('creator-hub-linux-portable-deployment = { path = "../native/linux-portable-deployment", optional = true }'));
  const main = read('src-tauri/src/main.rs');
  const guard = '#[cfg(all(target_os = "linux", feature = "experimental-linux-portable-host"))]';
  assert.equal(main.split(guard).length - 1, 2);
  assert.ok(main.indexOf('linux_portable_host::admit_startup()') < main.indexOf('    configure_linux_webkit();'));
  const hook = read('src-tauri/src/linux_portable_host.rs');
  assert.ok(hook.includes('HostSession::capture()'));
  assert.ok(hook.includes('Store::open(session.store_path())'));
  assert.ok(hook.includes('store\n        .bind_current_process(&expected)'));
  assert.ok(!hook.includes('Store::create('));
  assert.ok(!hook.includes('install_reviewed('));
});
