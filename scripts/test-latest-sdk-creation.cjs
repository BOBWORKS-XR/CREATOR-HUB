'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const preferences = require('./test-support/unity-preferences-guard.cjs');
const root = path.resolve(__dirname, '..');
function sourceBinding() {
  return Object.fromEntries(['creation_sdk.rs', 'logic.rs', 'lib.rs', 'sdk_requirements.rs', 'ProjectSetupValidator.cs']
    .map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(root,
      'modules/project-setup/src-tauri/src', name))).digest('hex')]));
}

function run(args) {
  if (process.platform !== 'win32' || args.join(' ') !== '--approved-vs-preferences-restore') {
    throw new Error('Windows and explicit preference backup/restore approval are required.');
  }
  const guard = preferences.createGuard({ approved: true });
  guard.requireNoUnity();
  const before = guard.capture();
  const source = sourceBinding();
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-latest-sdk-creation-'));
  const beforePath = path.join(output, 'preferences-before.json');
  fs.writeFileSync(beforePath, JSON.stringify(before, null, 2), { flag: 'wx' });
  fs.writeFileSync(path.join(output, 'source-before.json'), JSON.stringify(source, null, 2), { flag: 'wx' });
  const log = fs.openSync(path.join(output, 'creation.log'), 'wx');
  let child, restoration, failure;
  console.log(`Disposable creation and exact preference backup: ${output}`);
  try {
    if (!preferences.same(before, guard.capture())) throw new Error('Preferences changed before the test.');
    guard.requireNoUnity();
    child = spawnSync('cargo', [
      'test', '--release', '--locked', '--offline', '--lib',
      '--manifest-path', 'modules/project-setup/src-tauri/Cargo.toml',
      'logic::tests::unity_creation_smoke', '--', '--ignored', '--exact', '--nocapture', '--test-threads=1',
    ], {
      cwd: root, windowsHide: true,
      stdio: ['ignore', log, log], timeout: 40 * 60 * 1000,
      env: { ...process.env, CREATOR_SETUP_SMOKE_PARENT: output,
        CREATOR_SETUP_SMOKE_NAME: 'LatestStableSdk', CREATOR_SETUP_CREATION_PREFS_GUARDED: 'yes' },
    });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`Creation test exited ${child.status}; inspect creation.log.`);
  } catch (error) {
    failure = error;
  } finally {
    fs.closeSync(log);
    try {
      guard.requireNoUnity();
      const after = guard.capture();
      fs.writeFileSync(path.join(output, 'preferences-after.json'), JSON.stringify(after, null, 2), { flag: 'wx' });
      const savedBefore = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
      if (!preferences.same(before, savedBefore)) throw new Error('Saved preference backup changed.');
      restoration = guard.restore(savedBefore, after);
    } catch (error) {
      failure = new AggregateError([failure, error].filter(Boolean), 'Creation or exact preference restoration failed. Backups retained.');
    }
  }
  if (JSON.stringify(sourceBinding()) !== JSON.stringify(source)) {
    failure = new Error('Creation source changed during the run; retain the result as diagnostic only.');
  }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({
    success: !failure, project: path.join(output, 'LatestStableSdk'),
    exitCode: child?.status, restoration, error: failure?.message,
  }, null, 2), { flag: 'wx' });
  console.log(`Result: ${path.join(output, 'result.json')}`);
  if (failure) throw failure;
}

if (require.main === module) {
  try { run(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { run };
