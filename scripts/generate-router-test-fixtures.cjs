// Generates only public disposable test vectors. No production key is used.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { moduleFiles } = require('./build-unified.cjs');

function testSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const id = crypto.randomBytes(8);
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return {
    publicKey: `untrusted comment: DISPOSABLE TEST KEY - NOT A RELEASE KEY\n${Buffer.concat([Buffer.from('Ed'), id, raw]).toString('base64')}\n`,
    sign(bytes) {
      const signature = crypto.sign(null, crypto.createHash('blake2b512').update(bytes).digest(), privateKey);
      const comment = 'disposable router test fixture';
      const global = crypto.sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
      return `untrusted comment: DISPOSABLE TEST SIGNATURE\n${Buffer.concat([Buffer.from('ED'), id, signature]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`;
    },
  };
}

function generate() {
  const directory = path.resolve(__dirname, '../native/mcp-router/tests/fixtures');
  if (fs.existsSync(directory)) throw Error('Test vectors already exist; do not overwrite accepted fixtures.');
  fs.mkdirSync(directory, { recursive: true });
  const signer = testSigner();
  fs.writeFileSync(path.join(directory, 'public.txt'), signer.publicKey, { flag: 'wx' });
  for (const [platform, arch] of [['windows', 'x86_64'], ['linux', 'x86_64'], ['macos', 'aarch64'], ['macos', 'x86_64']]) {
    for (const [name, hubVersion, server] of [['a', '0.1.12', 'server-a'], ['b', '0.1.13', 'server-b'], ['collision', '0.1.12', 'server-b']]) {
      const files = Object.fromEntries(moduleFiles('mcp', platform).sort().map(name => [name,
        crypto.createHash('sha256').update(name.endsWith('.mjs') ? server : `payload:${name}`).digest('hex')]));
      const descriptor = { schemaVersion: 1, product: 'com.creatorworks.hub.mcp-runtime', hubVersion,
        platform, arch, module: { executable: `mcp/creator-works-mcp-launcher${platform === 'windows' ? '.exe' : ''}`,
          version: '2.7.7', files } };
      const bytes = Buffer.from(JSON.stringify(descriptor));
      const prefix = path.join(directory, `${platform}-${arch}-${name}`);
      fs.writeFileSync(`${prefix}.json`, bytes, { flag: 'wx' });
      fs.writeFileSync(`${prefix}.minisig`, signer.sign(bytes), { flag: 'wx' });
    }
  }
  console.log('Created public signed router test vectors; the ephemeral private key was not saved.');
}

module.exports = { testSigner };
if (require.main === module) generate();
