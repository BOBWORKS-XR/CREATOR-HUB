'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const name = process.env.CREATOR_OUTGOING_CASE;
assert.ok(['mcp-restore', 'setup-restore', 'setup-no-restore'].includes(name));
const out = path.resolve('artifacts/public-case', name);
assert.equal(fs.existsSync(out), false); fs.mkdirSync(out, { recursive: true });
const native = fs.readdirSync('artifacts').filter(n => /^native-suite-\d+$/.test(n));
assert.ok(native.length <= 1, 'Do not mix runs');
const input = path.resolve('artifacts/public-update-022-input');
for (const dir of [input, ...native.map(n => path.resolve('artifacts', n))]) {
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir)) {
    if (!/^(?:outgoing-report\.json|public-feed\.json|public-input-binding\.json|latest\.json|SHA256SUMS\.txt|creator-hub-windows-x86_64\.json(?:\.minisig)?|Creator\.Hub_0\.1\.21_x64-setup\.exe\.sig|[a-z-]+\.png|webview-policy\.json)$/.test(file)) continue;
    const source = path.join(dir, file), st = fs.lstatSync(source);
    assert.ok(st.isFile() && !st.isSymbolicLink() && st.size <= 8 * 1024 * 1024);
    fs.copyFileSync(source, path.join(out, file), fs.constants.COPYFILE_EXCL);
  }
}
