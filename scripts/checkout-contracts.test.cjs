const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const lfFiles = [
  'native/flatpak-native-activation/com.creatorworks.hub.Host.service',
  'packaging/flatpak/com.creatorworks.hub.desktop',
  'native/flatpak-host-launch/src/linux/identity.rs',
  'src-tauri/src/main.rs',
  '.github/workflows/linux-deb-helper-fixtures-014.yml',
];

test('a fresh autocrlf checkout retains exact Unix protocol/source bytes and frozen fixture bytes', t => {
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'hub-checkout-contract-')));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), parent);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
  const git = (args, input) => execFileSync('git', args, { cwd: directory, env, input, windowsHide: true });
  git(['init', '--quiet']);
  const ordinary = 'ordinary-windows.txt';
  const protectedFiles = ['tests/fixtures/checkout-contract.minisig',
    'unity/com.creatorworks.plugins/Editor/CheckoutContract.cs'];
  const files = new Map([
    ['.gitattributes', fs.readFileSync(path.join(root, '.gitattributes'))],
    ...lfFiles.map(name => [name, fs.readFileSync(path.join(root, name))]),
    [ordinary, Buffer.from('normal Windows checkout\n')],
    ...protectedFiles.map(name => [name, Buffer.from('frozen signed bytes\n')]),
  ]);
  for (const [name, bytes] of files) {
    const object = git(['hash-object', '-w', '--stdin'], bytes).toString().trim();
    git(['update-index', '--add', '--cacheinfo', `100644,${object},${name}`]);
  }
  const checkout = path.join(directory, 'checkout');
  fs.mkdirSync(checkout);
  git(['-c', 'core.autocrlf=true', 'checkout-index', '--all', `--prefix=${checkout.replaceAll('\\', '/')}/`]);
  assert.deepEqual(fs.readFileSync(path.join(checkout, ordinary)), Buffer.from('normal Windows checkout\r\n'),
    'The fixture must exercise actual Git CRLF checkout conversion');
  for (const name of [...lfFiles, ...protectedFiles]) {
    const actual = fs.readFileSync(path.join(checkout, name));
    assert.deepEqual(actual, files.get(name), `Checkout changed exact contract bytes: ${name}`);
    assert.equal(actual.includes(13), false, `LF contract acquired carriage returns: ${name}`);
  }
});
