const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function verifyBundleMarker(raw, installed) {
  const token = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
  const offset = raw.indexOf(token);
  assert.ok(offset >= 0 && raw.indexOf(token, offset + 1) === -1, 'Expected one Tauri bundle marker');
  const expected = Buffer.from(raw);
  expected.write('NSS', offset + token.length - 3, 'ascii');
  assert.deepEqual(installed, expected, 'Installer differs beyond the documented NSIS bundle marker');
}

function extract(installer, output, rawExecutable, manifest) {
  assert.equal(fs.existsSync(output), false, 'Installer extraction must use a new directory');
  const sevenZip = process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, '7-Zip/7z.exe') : '';
  assert.ok(fs.existsSync(sevenZip), '7-Zip is required to inspect actual installer payloads');
  execFileSync(sevenZip, ['x', installer, `-o${output}`, '-y'], { windowsHide: true, timeout: 120000, stdio: 'pipe' });
  const executable = path.join(output, 'creator-hub.exe');
  verifyBundleMarker(fs.readFileSync(rawExecutable), fs.readFileSync(executable));
  assert.deepEqual(fs.readFileSync(path.join(output, '$PLUGINSDIR/creator-hub-preflight.exe')), fs.readFileSync(executable), 'Preflight must equal the actual installed launcher');
  require('./build-unified.cjs').verifyStage(path.join(output, 'modules'), manifest);
  return executable;
}
module.exports = { verifyBundleMarker, extract };
