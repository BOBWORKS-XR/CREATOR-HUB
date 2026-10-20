// Public disposable vectors only; the random private key never leaves this process.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { testSigner } = require('./generate-router-test-fixtures.cjs');
const root = path.resolve(__dirname, '../native/mcp-router/tests/bootstrap-fixtures');
if (fs.existsSync(root)) throw Error('Bootstrap fixtures already exist; do not overwrite accepted vectors.');
const signer = testSigner();
fs.mkdirSync(root);
fs.writeFileSync(path.join(root, 'public.txt'), signer.publicKey, { flag: 'wx' });
for (const [platform, arch] of [['windows', 'x86_64'], ['linux', 'x86_64'], ['macos', 'aarch64'], ['macos', 'x86_64']]) {
  for (const name of ['a', 'b', 'foreign']) {
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1,
      product: name === 'foreign' ? 'another.product' : 'com.creatorworks.hub.mcp-router',
      platform, arch, protocol: 1, sha256: crypto.createHash('sha256').update(`router-${name}`).digest('hex') }));
    const prefix = path.join(root, `${platform}-${arch}-${name}`);
    fs.writeFileSync(`${prefix}.json`, bytes, { flag: 'wx' });
    fs.writeFileSync(`${prefix}.minisig`, signer.sign(bytes), { flag: 'wx' });
  }
}
console.log('Public bootstrap test vectors generated; no production key used or saved.');
