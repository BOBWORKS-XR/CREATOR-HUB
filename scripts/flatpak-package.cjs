'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'packaging', 'flatpak');
const ID = 'com.creatorworks.hub';
const VERSION = '0.1.13';
const MAX_DEB = 256 * 1024 * 1024;
const MAX_TAR = 512 * 1024 * 1024;
const FINISH_ARGS = Object.freeze([
  '--socket=wayland', '--socket=fallback-x11', '--share=ipc',
  '--device=dri', '--share=network',
]);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function noLinks(filename) {
  for (let item = path.resolve(filename); ; item = path.dirname(item)) {
    try {
      if (fs.lstatSync(item).isSymbolicLink()) throw new Error(`Symbolic link/junction refused: ${item}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (path.dirname(item) === item) break;
  }
}

function parseMetadata(bytes) {
  // dpkg-deb --showformat is the parser; accept only its exact three-field contract.
  const fields = bytes.toString('utf8').split('\n');
  if (fields.length !== 4 || fields[3] !== '' || fields[0] !== 'creator-hub'
      || fields[1] !== VERSION || fields[2] !== 'amd64') {
    throw new Error('Native DEB must identify creator-hub, version 0.1.13, architecture amd64');
  }
  return { package: fields[0], version: fields[1], architecture: fields[2] };
}

function manifest(files) {
  return {
    id: ID,
    branch: 'experimental',
    runtime: 'org.gnome.Platform',
    'runtime-version': '50',
    sdk: 'org.gnome.Sdk',
    command: 'creator-hub',
    'finish-args': [...FINISH_ARGS],
    'build-options': { strip: false, 'no-debuginfo': true },
    modules: [{
      name: 'creator-hub-native-deb',
      buildsystem: 'simple',
      // Do not skip this module on other architectures: missing sources must fail.
      'build-commands': [
        'test "${FLATPAK_ARCH:?}" = x86_64',
        'tar --extract --file=payload.tar --directory=/app --same-permissions --no-same-owner',
        `install -Dm644 ${ID}.desktop /app/share/applications/${ID}.desktop`,
        `install -Dm644 ${ID}.metainfo.xml /app/share/metainfo/${ID}.metainfo.xml`,
        'python3 payload.py verify inventory.json /app',
      ],
      sources: Object.entries(files).map(([filename, bytes]) => ({
        type: 'file', path: filename, sha256: sha256(bytes), 'only-arches': ['x86_64'],
      })),
    }],
  };
}

function parseSnapshot(native, parent, expectedHash, invoke) {
  const directory = fs.mkdtempSync(path.join(parent, '.flatpak-native-snapshot-'));
  const filename = path.join(directory, 'native.deb');
  let failure;
  try {
    noLinks(directory);
    fs.chmodSync(directory, 0o700);
    fs.writeFileSync(filename, native, { flag: 'wx', mode: 0o400 });
    fs.chmodSync(directory, 0o500);
    const verify = () => {
      noLinks(filename);
      const stat = fs.statSync(filename);
      if (!stat.isFile() || stat.size !== native.length || stat.size > MAX_DEB
          || sha256(fs.readFileSync(filename)) !== expectedHash) {
        throw new Error('Hashed native parser snapshot changed');
      }
    };
    const parse = (args, limit) => {
      verify();
      const result = invoke('dpkg-deb', [...args, filename], undefined, limit);
      verify();
      return result;
    };
    // --show reads only the control member; piping the entire DEB can produce EPIPE.
    // Both commands open the same sealed copy, never the mutable caller's filename.
    return {
      metadata: parseMetadata(parse(['--show', '--showformat=${Package}\n${Version}\n${Architecture}\n'], 4096)),
      data: parse(['--fsys-tarfile'], MAX_TAR),
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      noLinks(filename);
      fs.chmodSync(directory, 0o700);
      if (fs.existsSync(filename)) {
        fs.chmodSync(filename, 0o600);
        fs.unlinkSync(filename);
      }
      fs.rmdirSync(directory);
    } catch (error) {
      if (!failure) throw error;
      failure.message += `; snapshot cleanup refused: ${error.message}`;
    }
  }
}

function generate(options, { run = execFileSync, python = process.platform === 'win32' ? 'python' : 'python3' } = {}) {
  if (!options || typeof options.deb !== 'string' || !path.isAbsolute(options.deb)
      || typeof options.output !== 'string' || !path.isAbsolute(options.output)
      || !/^[0-9a-f]{64}$/.test(options.sha256 || '')) {
    throw new Error('Require absolute --deb and --output paths and an exact lowercase --sha256');
  }
  noLinks(options.deb);
  noLinks(options.output);
  if (fs.existsSync(options.output)) throw new Error('Output already exists; immutable output cannot be reused');
  if (!fs.statSync(path.dirname(options.output)).isDirectory()) throw new Error('Output parent must exist');

  const fd = fs.openSync(options.deb, 'r');
  let native;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 8 || stat.size > MAX_DEB) throw new Error('DEB is not a bounded regular file');
    native = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (native.length > MAX_DEB || sha256(native) !== options.sha256) throw new Error('Native DEB SHA256 mismatch');
  const invoke = (tool, args, input, limit) => {
    try {
      return run(tool, args, {
        input, maxBuffer: limit, timeout: 120000, windowsHide: true,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        env: { ...process.env, LC_ALL: 'C' },
      });
    } catch (error) {
      if (tool === 'dpkg-deb') {
        const stderr = Buffer.isBuffer(error.stderr) ? error.stderr.toString('utf8') : String(error.stderr || '');
        // The native harness records error.message; retain diagnostics without input/stdout/env dumps.
        error.message = `${JSON.stringify([tool, ...args])} failed (${error.code || error.status || 'unknown'}): `
          + `${error.message.slice(0, 2048)}; stderr: ${stderr.slice(0, 8192)}`;
      }
      throw error;
    }
  };
  const { metadata, data } = parseSnapshot(native, path.dirname(options.output), options.sha256, invoke);
  const helper = fs.readFileSync(path.join(ASSETS, 'payload.py'));
  const inspect = args => invoke(python, ['-B', '-c', helper.toString('utf8'), ...args], data, MAX_TAR);
  const inventory = inspect(['inspect']);
  const report = JSON.parse(inventory.toString('utf8'));
  if (report.schemaVersion !== 1 || report.executable !== 'bin/creator-hub' || !Array.isArray(report.entries)) {
    throw new Error('Unexpected payload parser contract');
  }
  const payload = inspect(['repack']);
  const files = {
    'payload.tar': payload,
    'inventory.json': inventory,
    'payload.py': helper,
    [`${ID}.desktop`]: fs.readFileSync(path.join(ASSETS, `${ID}.desktop`)),
    [`${ID}.metainfo.xml`]: fs.readFileSync(path.join(ASSETS, `${ID}.metainfo.xml`)),
  };
  const generatedManifest = Buffer.from(`${JSON.stringify(manifest(files), null, 2)}\n`);
  const all = { ...files, 'native.deb': native, [`${ID}.json`]: generatedManifest,
    'runtime-50-evidence.json': fs.readFileSync(path.join(ASSETS, 'runtime-50-evidence.json')) };
  const receipt = {
    schemaVersion: 1, status: 'experimental', releaseReady: false,
    appId: ID, version: VERSION, architecture: 'x86_64',
    native: { ...metadata, sha256: options.sha256, byteLength: native.length },
    runtime: { id: 'org.gnome.Platform', branch: '50',
      provenanceFile: 'runtime-50-evidence.json', contentsVerifiedInSandbox: false },
    files: Object.fromEntries(Object.entries(all).map(([name, bytes]) => [name, {
      sha256: sha256(bytes), byteLength: bytes.length,
    }])),
    blockers: ['unity-host-launch', 'host-project-paths', 'ai-client-and-companion-boundary',
      'process-ownership', 'settings-migration', 'flatpak-update-route', 'runtime-abi-and-gui'],
  };

  fs.mkdirSync(options.output, { mode: 0o755 }); // Exclusive reservation, even for an empty old directory.
  for (const [name, bytes] of Object.entries(all)) {
    fs.writeFileSync(path.join(options.output, name), bytes, { flag: 'wx', mode: 0o444 });
  }
  // A failed output is retained for inspection and never has this completion receipt.
  fs.writeFileSync(path.join(options.output, 'package-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx', mode: 0o444,
  });
  fs.chmodSync(options.output, 0o555);
  return receipt;
}

function parseArgs(args) {
  const options = {};
  const names = new Map([['--deb', 'deb'], ['--sha256', 'sha256'], ['--output', 'output']]);
  for (let i = 0; i < args.length; i += 2) {
    const name = names.get(args[i]);
    if (!name || options[name] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Usage: node scripts/flatpak-package.cjs --deb ABSOLUTE.deb --sha256 EXACT_SHA256 --output NEW_ABSOLUTE_DIRECTORY');
    }
    options[name] = args[i + 1];
  }
  return options;
}

if (require.main === module) {
  try {
    const receipt = generate(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ status: receipt.status, releaseReady: false, nativeSha256: receipt.native.sha256 }));
  } catch (error) {
    console.error(`Flatpak experiment refused: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { generate, parseArgs, parseMetadata, manifest, sha256, FINISH_ARGS };
