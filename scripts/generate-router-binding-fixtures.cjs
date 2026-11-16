// Public disposable vectors. This generator never reads a release private key.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {testSigner} = require('./generate-router-test-fixtures.cjs');
const out = path.resolve(__dirname, '../native/mcp-router/tests/binding-fixtures');
if (fs.existsSync(out)) throw Error('Refusing to overwrite existing vectors');
fs.mkdirSync(out);
const signer = testSigner();
fs.writeFileSync(path.join(out, 'public.txt'), signer.publicKey, {flag:'wx'});
for (const binding of [1,2,3]) {
  const identity = {schemaVersion:1,product:'com.creatorworks.hub.mcp-router',platform:'windows',arch:'x86_64',protocol:1,
    ...(binding === 1 ? {} : {storeBinding:binding}),
    sha256:crypto.createHash('sha256').update(`router-binding-${binding}`).digest('hex')};
  const bytes = Buffer.from(JSON.stringify(identity));
  fs.writeFileSync(path.join(out,`${binding}.json`),bytes,{flag:'wx'});
  fs.writeFileSync(path.join(out,`${binding}.minisig`),signer.sign(bytes),{flag:'wx'});
}
