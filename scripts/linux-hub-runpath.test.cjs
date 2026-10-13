const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('Linux link-time RUNPATH is unchanged by the actual AppImage patchelf operation', { skip: process.platform !== 'linux' || process.env.CREATOR_NATIVE_ARCHIVE_TESTS !== '1' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-runpath-'));
  try {
    const file = path.join(directory, 'hub');
    execFileSync(process.env.RUSTC || 'rustc', [path.join(__dirname, 'fixtures/linux-runpath.rs'), '-o', file,
      '-C', 'link-arg=-Wl,--enable-new-dtags,-rpath,$ORIGIN/../lib']);
    const before = fs.readFileSync(file);
    assert.match(execFileSync('readelf', ['-d', file], { encoding: 'utf8' }), /\(RUNPATH\).*\[\$ORIGIN\/\.\.\/lib\]/);
    execFileSync(process.env.CREATOR_TEST_PATCHELF || 'patchelf', ['--set-rpath', '$ORIGIN/../lib', file]);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.match(fs.readFileSync(path.join(__dirname, '../src-tauri/build.rs'), 'utf8'),
      /cargo:rustc-link-arg-bin=creator-hub=-Wl,--enable-new-dtags,-rpath,\$ORIGIN\/\.\.\/lib/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
