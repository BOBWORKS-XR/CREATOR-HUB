const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const native = process.platform === 'win32';
const script = path.join(__dirname, 'extract-unix-transfer.ps1');
const quote = value => `'${value.replaceAll("'", "''")}'`;

function fixture(t, names = ['modules.tar.gz', 'prepared-unix.json', 'transfer-binding.json']) {
  const parent = path.resolve(__dirname, '../artifacts');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'transfer-zip-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'input'); fs.mkdirSync(source);
  for (const name of names) fs.writeFileSync(path.join(source, name), `Synthetic ${name}, not an actual transfer.`);
  const archive = path.join(root, 'input.zip');
  const made = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${quote(source)}, ${quote(archive)})`],
  { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(made.status, 0, made.stderr);
  const bytes = fs.readFileSync(archive);
  const output = path.join(root, 'extracted');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const run = (hash = digest, length = bytes.length) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script,
    '-ZipPath', archive, '-ExpectedSha256', hash, '-ExpectedBytes', String(length), '-OutputDirectory', output],
  { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { root, output, run };
}

test('Windows transfer ZIP extraction verifies pinned bytes but not inner payload authority', { skip: !native }, t => {
  const f = fixture(t); const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { downloadedZipVerified: true, transferContentsVerified: false, releaseReady: false });
  assert.equal(fs.readdirSync(f.output).length, 3);
  assert.notEqual(f.run().status, 0, 'Existing evidence cannot be replaced');
});

test('wrong ZIP hashes and sizes refuse before extraction', { skip: !native }, t => {
  const f = fixture(t);
  assert.notEqual(f.run('0'.repeat(64)).status, 0);
  assert.equal(fs.existsSync(f.output), false);
  assert.notEqual(f.run(undefined, 1).status, 0);
  assert.equal(fs.existsSync(f.output), false);
});

test('a hash-pinned ZIP with unexpected members still refuses without extraction', { skip: !native }, t => {
  const f = fixture(t, ['modules.tar.gz', 'prepared-unix.json', 'unexpected.json']);
  const result = f.run();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /exactly its three bounded files/);
  assert.equal(fs.existsSync(f.output), false);
});
