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
