// Linux resources are opaque to linuxdeploy; raw module digests remain authoritative.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const FILE = 'modules.tar.gz';
const MAX_ARCHIVE = 256 * 1024 * 1024;
const MAX_FILE = 256 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const rawFiles = manifest => ({ ...manifest.modules.mcp.files, ...manifest.modules.setup.files, ...manifest.managedRouting?.files });
const modeFor = (manifest, name) => [manifest.modules.mcp.executable, manifest.modules.setup.executable,
  'mcp/server/runtime/node', ...(manifest.managedRouting ? ['routing/creator-hub-mcp-router'] : [])].includes(name) ? 0o755 : 0o644;

function validateBinding(manifest) {
  const binding = manifest.payloadArchive;
  const files = rawFiles(manifest);
  if (manifest.platform !== 'linux' || !binding || Object.keys(binding).sort().join(',') !== 'file,files,schemaVersion,sha256,size,unpackedSize'
    || binding.schemaVersion !== 1 || binding.file !== FILE || !/^[a-f0-9]{64}$/.test(binding.sha256)
    || !Number.isSafeInteger(binding.size) || binding.size <= 0 || binding.size > MAX_ARCHIVE
    || Object.keys(binding.files).sort().join('\n') !== Object.keys(files).sort().join('\n')) throw Error('Invalid Linux module archive binding.');
  let total = 0;
  for (const [name, record] of Object.entries(binding.files)) {
    if (!require('./build-unified.cjs').relativeFile(name) || Buffer.byteLength(name) > 100 || /[^\x20-\x7e]/.test(name)
      || !/^[a-f0-9]{64}$/.test(files[name]) || Object.keys(record).sort().join(',') !== 'mode,size'
      || !Number.isSafeInteger(record.size) || record.size < 0 || record.size > MAX_FILE || record.mode !== modeFor(manifest, name)) throw Error('Invalid module archive member binding.');
    total += record.size;
  }
  if (!Number.isSafeInteger(total) || total > MAX_TOTAL || binding.unpackedSize !== total) throw Error('Invalid module archive size binding.');
  return files;
}

function create(root, manifest, destination, execute = execFileSync) {
  if (manifest.platform !== 'linux' || manifest.payloadArchive) throw Error('Only a fresh Linux raw payload may be archived.');
  require('./build-unified.cjs').verifyStage(root, manifest);
  const files = Object.fromEntries(Object.keys(rawFiles(manifest)).sort().map(name => {
    const stat = fs.lstatSync(path.join(root, name));
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== modeFor(manifest, name)) throw Error(`Invalid raw module archive mode: ${name}`);
    return [name, { size: stat.size, mode: modeFor(manifest, name) }];
  }));
  const tar = execute('tar', ['--format=ustar', '--owner=0', '--group=0', '--numeric-owner', '--mtime=@0', '--no-recursion',
    '-cf', '-', '-C', root, '--', ...Object.keys(files)], { maxBuffer: MAX_TOTAL + 1024 * 1024, stdio: 'pipe' });
  const bytes = zlib.gzipSync(tar);
  const binding = { schemaVersion: 1, file: FILE, sha256: digest(bytes), size: bytes.length,
    unpackedSize: Object.values(files).reduce((sum, file) => sum + file.size, 0), files };
  validateBinding({ ...manifest, payloadArchive: binding });
  fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o644 });
  return binding;
}

function verify(file, manifest, decoder, execute = execFileSync) {
  const files = validateBinding(manifest);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== manifest.payloadArchive.size || stat.size > MAX_ARCHIVE) throw Error('Module archive is missing, redirected or oversized.');
  if (digest(fs.readFileSync(file)) !== manifest.payloadArchive.sha256) throw Error('Build-bound module archive changed.');
  if (typeof decoder !== 'string' || !path.isAbsolute(decoder)) throw Error('The shared native archive decoder is required.');
  const result = JSON.parse(execute(decoder, ['verify', file], {
    input: JSON.stringify(manifest), timeout: 180000, maxBuffer: 65536, stdio: 'pipe', encoding: 'utf8',
  }));
  if (!result || Object.keys(result).sort().join(',') !== 'files' || !result.files
    || Object.keys(result.files).sort().join('\n') !== Object.keys(files).sort().join('\n')
    || Object.entries(files).some(([name, hash]) => result.files[name] !== hash)) throw Error('Native archive decoder did not verify the exact raw file map.');
  return result.files;
}
module.exports = { FILE, MAX_ARCHIVE, MAX_FILE, MAX_TOTAL, modeFor, rawFiles, validateBinding, create, verify };
