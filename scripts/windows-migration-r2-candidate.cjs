'use strict';
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { readBounded } = require('./read-bounded-input.cjs');

// R2 is a source archive plus overlay and three normalized Cargo manifests,
// not a clean product commit. Hashes bind the retained build evidence bytes.
const TARGET = Object.freeze({ version: '0.1.16', asset: 'Creator.Hub_0.1.16_x64-setup.exe', bytes: 38213208,
  productSource: 'source-receipt-sha256:a6eeac26841ad4dc7aa20e6480cc1ff185e0aa0458fa6611b70d681e812844e9',
  installer: '7326d054ac23b7ac560e2c3488933203a33f0033586b1c33988ce7f316e4c51a',
  exe: 'fac846563720eb4dae665a814ea28d0556800ebaf75aba7e8ee0be7f1979a5cd' });
const productProvenance = () => ({ productSource: TARGET.productSource, builtFromDirtyWorktree: true, sourceSnapshotBuilt: false,
  buildSourceBase: 'cf6c2db2a4260e02206c91133878ff82bf3bb084', buildSourceFileCount: 1189,
  buildInputDigest: 'bd07866cc0c80eb433ce963862b4c44e4d6712616e80b5ce06131e2306711288',
  sourceSnapshotTestOnlyDifferences: [], sourceUnchanged: true,
  buildInputsSha256: 'ce08980312f1107870a20a5c850bc683f4aed6d51b30b0bc223f6a34ad48d575',
  buildResultSha256: '78cf43f002c9a10c86987925b137932383481415d0d90c96ab1f2292ab9bbe2e',
  sourcePreparation: 'three Cargo.toml files normalized CRLF to LF before R2 build' });
function installer(file) {
  const bytes = readBounded(file, TARGET.bytes);
  assert.equal(bytes.length, TARGET.bytes); assert.equal(hash(bytes), TARGET.installer);
  return file;
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shared = () => require('./windows-incoming-016.cjs');
if (require.main === module) {
  assert.equal(process.argv.length, 3);
  installer(path.join(process.argv[2], TARGET.asset));
}
module.exports = { TARGET, productProvenance, installer, hash,
  showPage: (...args) => shared().showPage(...args),
  assertOwnedDebugging: (...args) => shared().assertOwnedDebugging(...args) };
