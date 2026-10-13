const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('macOS bundles use ad-hoc signing and CI verifies the app in each DMG', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');

  assert.equal(config.bundle.macOS.signingIdentity, '-');
  assert.match(workflow, /Verify ad-hoc signed app inside macOS DMG/);
  assert.match(workflow, /codesign --verify --deep --strict/);
  assert.match(workflow, /Signature=adhoc/);
});

test('Apple Silicon minimum matches its observed Mach-O floor without raising Intel requirements', () => {
  const overlay = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.arm64.conf.json'), 'utf8'));
  assert.deepEqual(overlay, { bundle: { macOS: { minimumSystemVersion: '11.0' } } });
  const base = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  assert.equal(base.bundle.macOS.minimumSystemVersion, undefined);
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /if \[ "\$RUNNER_ARCH" = ARM64 \]; then[\s\S]*--config src-tauri\/tauri.arm64.conf.json/);
  assert.match(ci, /PlistBuddy -c 'Print :LSMinimumSystemVersion'/);
  const release = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
  assert.match(release, /label: macOS Apple silicon\s+args: --bundles dmg --config src-tauri\/tauri.arm64.conf.json/);
  assert.match(release, /label: macOS Intel\s+args: --bundles dmg\s/);
});

test('superseded PR build runs are cancelled rather than rebuilt concurrently', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /group: creator-hub-ci-\$\{\{ github.event.pull_request.number \|\| github.ref \}\}/);
  assert.match(ci, /cancel-in-progress: true/);
  assert.ok(ci.indexOf('Validate workflow structure before native builds') < ci.indexOf('Hub (Windows)'));
  assert.match(ci, /actionlint_1\.7\.12_linux_amd64.tar.gz/);
  assert.match(ci, /8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8/);
  assert.equal((ci.match(/needs: frontend/g) || []).length, 3);
});
