'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { yaml } = require('playwright-core/lib/utilsBundle');
const root = path.resolve(__dirname, '..');

for (const name of ['linux-portable-deployment.yml', 'linux-integrated-features.yml']) {
  test(`${name} tests the native restart feature without enabling packaging or publishing`, () => {
    const source = fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8');
    const workflow = yaml.parse(source, { uniqueKeys: true });
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    const commands = [];
    const jobs = name === 'linux-portable-deployment.yml'
      ? [workflow.jobs.primitives] : Object.values(workflow.jobs);
    for (const job of jobs) {
      assert.equal(job['runs-on'], 'ubuntu-22.04');
      assert.match(job.if, /github.repository_id == '1364807512'/);
      assert.match(job.if, /refs\/heads\/validation\//);
      for (const step of job.steps) {
        if (!step.run) continue;
        const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/usr/bin/bash';
        const parsed = spawnSync(bash, ['-n'], { input: step.run, encoding: 'utf8', timeout: 5000, windowsHide: true, shell: false });
        assert.equal(parsed.status, 0, parsed.stderr || parsed.error?.message);
        commands.push(...step.run.split('\n'));
      }
    }
    for (const command of ['clippy', 'test']) {
      const prefix = `cargo ${command} --locked --manifest-path native/linux-portable-deployment/Cargo.toml `;
      const matching = commands.filter(line => line.startsWith(prefix));
      assert.ok(matching.some(line => !line.includes('--features')), 'Keep default-off coverage');
      assert.ok(matching.some(line => line.includes('--features experimental-restart --')), 'Run actual Linux protocol tests');
      if (name === 'linux-integrated-features.yml') {
        const rootPrefix = `cargo ${command} --locked --manifest-path src-tauri/Cargo.toml `;
        const rootCommands = commands.filter(line => line.startsWith(rootPrefix));
        assert.ok(rootCommands.some(line => line.includes('experimental-linux-portable-host --')));
        assert.ok(rootCommands.some(line => line.includes('experimental-linux-portable-update --')));
      }
    }
    const explicitPermissionTests = name === 'linux-integrated-features.yml'
      ? ['umask_002', 'default_acl'].map(suffix => `cargo test --locked --manifest-path src-tauri/Cargo.toml --features integrated-features,experimental-flatpak-host,linux-production-migration,experimental-linux-portable-update projects::tests::live_linux_helper_preparation_${suffix} -- --exact --ignored --test-threads=1 --nocapture`)
      : [];
    assert.deepEqual(commands.filter(line => line.includes('--ignored')), explicitPermissionTests);
    assert.doesNotMatch(commands.join('\n'), /tauri build|gh release|publish-hub|signer sign|flatpak install|dpkg --install|macos/);
  });
}

test('Linux integration validates structured workflow contracts early and keeps compilation cache on failure', () => {
  const workflow = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/linux-integrated-features.yml'), 'utf8'));
  const steps = workflow.jobs['native-libraries'].steps;
  assert.equal(steps.find(step => step.uses === 'Swatinem/rust-cache@v2').with['cache-on-failure'], true);
  const preflight = steps.findIndex(step => step.run?.includes('scripts/linux-portable-signed-controls.test.cjs'));
  assert.ok(preflight >= 0);
  assert.ok(steps[preflight].run.includes('scripts/linux-portable-restart-ci.test.cjs'));
  const compile = steps.findIndex(step => step.run?.includes('cargo clippy'));
  assert.ok(preflight < compile);
});

test('Linux integration runs MCP server tests before bundling and native compilation', () => {
  const workflow = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/linux-integrated-features.yml'), 'utf8'));
  const steps = workflow.jobs['native-libraries'].steps;
  const commands = steps.flatMap(step => String(step.run || '').split(/\r?\n/).map(line => line.trim()));
  const install = commands.indexOf('npm ci --prefix modules/mcp');
  const test = commands.indexOf('npm --prefix modules/mcp test');
  const bundle = commands.indexOf('npm --prefix modules/mcp run release:launcher');
  const compile = commands.findIndex(command => command.startsWith('cargo clippy'));
  assert.ok(install >= 0 && test > install, 'Run the actual MCP suite after installing its locked dependencies');
  assert.ok(bundle > test && compile > bundle, 'Fail MCP tests before bundling or native compilation');
  const step = steps.find(step => String(step.run || '').split(/\r?\n/).includes('npm --prefix modules/mcp test'));
  assert.match(step.run, /^set -euo pipefail\n/);
  assert.equal(step['continue-on-error'], undefined);
  assert.equal(step.if, undefined);
});
