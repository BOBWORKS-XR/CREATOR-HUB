'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { gzipSync } = require('node:zlib');
const { generate, parseArgs, parseMetadata, manifest, sha256, FINISH_ARGS } = require('./flatpak-package.cjs');

const ASSETS = path.resolve(__dirname, '..', 'packaging', 'flatpak');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const HELPER = fs.readFileSync(path.join(ASSETS, 'payload.py'), 'utf8');
const ID = 'com.creatorworks.hub';
const DESKTOP = '[Desktop Entry]\nName=Creator Hub\nExec=creator-hub\nIcon=creator-hub\nType=Application\nTerminal=false\nCategories=Development;\n';

function elf() {
  const bytes = Buffer.alloc(120);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(bytes);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(62, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(1, 56);
  return bytes;
}

const file = (name, data, mode = 0o644) => ({ name, data: Buffer.from(data).toString('base64'), mode });
function members() {
  return [
    { name: './', type: 'directory', mode: 0o755 },
    { name: 'usr/bin', type: 'directory', mode: 0o755 },
    file('usr/bin/creator-hub', elf(), 0o751),
    { name: 'usr/lib/Creator Hub', type: 'directory', mode: 0o750 },
    file('usr/lib/Creator Hub/tool', '#!/bin/sh\nexit 0\n', 0o711),
    file('usr/lib/Creator Hub/data with spaces.bin', Buffer.from([0, 255, 1, 0, 254]), 0o640),
    file('usr/share/applications/Creator Hub.desktop', DESKTOP),
    file('usr/share/icons/hicolor/128x128/apps/creator-hub.png', Buffer.from('\x89PNG\r\n\x1a\n', 'latin1')),
    file('usr/share/doc/Creator Hub/changelog.gz', gzipSync(Buffer.from('native changelog')), 0o644),
  ];
}

function tarFixture(entries) {
  return execFileSync(PYTHON, ['-B', '-c', `
import base64, io, json, sys, tarfile
output = io.BytesIO()
with tarfile.open(fileobj=output, mode='w', format=tarfile.PAX_FORMAT) as archive:
    for item in json.load(sys.stdin):
        member = tarfile.TarInfo(item['name'])
        member.mode = item.get('mode', 0o644)
        data = base64.b64decode(item.get('data', ''))
        kind = item.get('type', 'file')
        member.type = {'file': tarfile.REGTYPE, 'directory': tarfile.DIRTYPE,
                       'symlink': tarfile.SYMTYPE, 'hardlink': tarfile.LNKTYPE,
                       'fifo': tarfile.FIFOTYPE}[kind]
        member.linkname = item.get('link', '')
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data) if kind == 'file' else None)
sys.stdout.buffer.write(output.getvalue())
`], { input: JSON.stringify(entries), maxBuffer: 8 * 1024 * 1024, windowsHide: true });
}

function inspect(data) {
  return JSON.parse(execFileSync(PYTHON, ['-B', '-c', HELPER, 'inspect'], {
    input: data, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  }));
}

function scopedTemp(t) {
  const directory = fs.mkdtempSync(path.join(ASSETS, '.test-'));
  t.after(() => {
    assert.equal(path.dirname(directory), ASSETS);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) fs.chmodSync(path.join(directory, entry.name), 0o755);
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

// Synthetic ar/DEB bytes are test fixtures, never production identity evidence.
function debFixture(data) {
  const control = tarFixture([file('control', 'Package: creator-hub\nVersion: 0.1.13\nArchitecture: amd64\nMaintainer: Fixture <fixture@example.invalid>\nDescription: Synthetic test fixture\n')]);
  function arMember(name, bytes) {
    const header = `${name.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(bytes.length).padEnd(10)}\x60\n`;
    assert.equal(header.length, 60);
    return Buffer.concat([Buffer.from(header), bytes, bytes.length % 2 ? Buffer.from('\n') : Buffer.alloc(0)]);
  }
  return Buffer.concat([Buffer.from('!<arch>\n'), arMember('debian-binary', Buffer.from('2.0\n')),
    arMember('control.tar.gz', gzipSync(control)), arMember('data.tar.gz', gzipSync(data))]);
}

function setup(t) {
  const root = scopedTemp(t);
  const data = tarFixture(members());
  const native = debFixture(data);
  const deb = path.join(root, 'misleading-arm64-name.deb');
  fs.writeFileSync(deb, native);
  const options = { deb, sha256: sha256(native), output: path.join(root, 'new-output') };
  const calls = [];
  const run = (tool, args, opts) => {
    if (tool !== 'dpkg-deb') return execFileSync(tool, args, opts);
    assert.equal(opts.input, undefined, 'DEB bytes must not be piped to dpkg-deb');
    assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
    const snapshot = args.at(-1);
    assert.notEqual(snapshot, deb, 'Never parse the mutable original filename');
    assert.ok(path.isAbsolute(snapshot));
    assert.equal(fs.lstatSync(snapshot).isSymbolicLink(), false);
    const bytes = fs.readFileSync(snapshot);
    calls.push({ args, input: opts.input, bytes });
    if (args[0] === '--show') return Buffer.from('creator-hub\n0.1.13\namd64\n');
    assert.deepEqual(args, ['--fsys-tarfile', snapshot]);
    return data;
  };
  return { options, native, data, run, calls };
}

test('argument and exact maintenance metadata contracts reject drift/injection', () => {
  assert.deepEqual(parseArgs(['--deb', '/native.deb', '--sha256', 'a'.repeat(64), '--output', '/new']), {
    deb: '/native.deb', sha256: 'a'.repeat(64), output: '/new',
  });
  for (const args of [['--force'], ['--deb'], ['--deb', 'x', '--deb', 'y'], ['--runtime', '47'], ['--deb', '--output']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.deepEqual(parseMetadata(Buffer.from('creator-hub\n0.1.13\namd64\n')), {
    package: 'creator-hub', version: '0.1.13', architecture: 'amd64',
  });
  for (const text of ['creator-hub\n0.1.12\namd64\n', 'unified-creator-hub\n0.1.13\namd64\n',
    'creator-hub\n0.1.13\ni386\n', 'creator-hub\n0.1.13\narm64\n',
    'creator-hub\n0.1.13\namd64', 'creator-hub\n0.1.13\namd64\nextra\n']) {
    assert.throws(() => parseMetadata(Buffer.from(text)));
  }
});

test('hash pin is mandatory and wrong pins fail before invoking any parser or reserving output', t => {
  const fixture = setup(t);
  for (const hash of [undefined, '', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(64) + '\n']) {
    assert.throws(() => generate({ ...fixture.options, sha256: hash }, { run: () => assert.fail('parser called') }));
    assert.equal(fs.existsSync(fixture.options.output), false);
  }
  assert.throws(() => generate({ ...fixture.options, deb: 'relative.deb' }));
  assert.throws(() => generate({ ...fixture.options, output: 'relative' }));
});

test('exact snapshot, resources, executable and modes survive deterministic repacking', t => {
  const fixture = setup(t);
  const receipt = generate(fixture.options, { run: fixture.run });
  assert.equal(receipt.releaseReady, false);
  assert.equal(receipt.status, 'experimental');
  assert.equal(receipt.runtime.contentsVerifiedInSandbox, false);
  assert.equal(receipt.native.sha256, fixture.options.sha256);
  assert.deepEqual(fs.readFileSync(path.join(fixture.options.output, 'native.deb')), fixture.native);
  assert.equal(fixture.calls.length, 2);
  for (const call of fixture.calls) assert.deepEqual(call.bytes, fixture.native);
  const snapshot = fixture.calls[0].args.at(-1);
  assert.equal(fixture.calls[1].args.at(-1), snapshot);
  assert.equal(fs.existsSync(path.dirname(snapshot)), false, 'Private parser snapshot cleaned after success');
  const inventory = JSON.parse(fs.readFileSync(path.join(fixture.options.output, 'inventory.json')));
  const executable = inventory.entries.find(entry => entry.path === 'bin/creator-hub');
  assert.equal(executable.mode, 0o751);
  assert.equal(executable.sha256, sha256(elf()));
  assert.equal(inventory.entries.find(entry => entry.path === 'lib/Creator Hub/tool').mode, 0o711);
  assert.equal(inventory.entries.find(entry => entry.path === 'lib/Creator Hub').mode, 0o750);
  assert.equal(inventory.entries.find(entry => entry.path.endsWith('data with spaces.bin')).mode, 0o640);
  const payload = fs.readFileSync(path.join(fixture.options.output, 'payload.tar'));
  const actual = JSON.parse(execFileSync(PYTHON, ['-B', '-c', `
import hashlib, io, json, sys, tarfile
with tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read()), mode='r:') as archive:
    print(json.dumps([{'path': member.name, 'mode': member.mode,
                      'sha256': hashlib.sha256(archive.extractfile(member).read()).hexdigest()}
                     for member in archive if member.isfile()]))
`], { input: payload, windowsHide: true }));
  for (const entry of inventory.entries.filter(entry => entry.type === 'file')) {
    assert.deepEqual(actual.find(item => item.path === entry.path), {
      path: entry.path, mode: entry.mode, sha256: entry.sha256,
    });
  }
  for (const [name, details] of Object.entries(receipt.files)) {
    const bytes = fs.readFileSync(path.join(fixture.options.output, name));
    assert.equal(sha256(bytes), details.sha256);
    assert.equal(bytes.length, details.byteLength);
  }
  const second = { ...fixture.options, output: path.join(path.dirname(fixture.options.output), 'second') };
  generate(second, { run: fixture.run });
  assert.deepEqual(fs.readFileSync(path.join(second.output, 'payload.tar')), payload);
});

test('existing outputs including empty directories refuse all rewriting', t => {
  const fixture = setup(t);
  fs.mkdirSync(fixture.options.output);
  assert.throws(() => generate(fixture.options, { run: () => assert.fail('parser called') }), /already exists/);
  const marker = path.join(fixture.options.output, 'retained');
  fs.writeFileSync(marker, 'keep');
  assert.throws(() => generate(fixture.options), /already exists/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
});

test('parser failures and malformed DEB metadata cannot emit a completed package', t => {
  const fixture = setup(t);
  assert.throws(() => generate(fixture.options, { run: () => { throw new Error('dpkg failure'); } }), /dpkg failure/);
  assert.equal(fs.existsSync(fixture.options.output), false);
  assert.throws(() => generate(fixture.options, { run: () => Buffer.from('other\n0.1.13\namd64\n') }));
  assert.equal(fs.existsSync(fixture.options.output), false);
});

test('both dpkg parsers receive a sealed hash-verified snapshot with stdin closed', t => {
  const fixture = setup(t);
  const run = (tool, args, options) => {
    if (tool === 'dpkg-deb') {
      const snapshot = args.at(-1);
      assert.equal(options.input, undefined);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      assert.deepEqual(fs.readFileSync(snapshot), fixture.native);
      assert.equal(path.dirname(path.dirname(snapshot)), path.dirname(fixture.options.output));
      if (process.platform !== 'win32') {
        assert.equal(fs.statSync(snapshot).mode & 0o777, 0o400);
        assert.equal(fs.statSync(path.dirname(snapshot)).mode & 0o777, 0o500);
      }
    }
    return fixture.run(tool, args, options);
  };
  generate(fixture.options, { run });
  assert.equal(fixture.calls.length, 2);
  assert.equal(fs.existsSync(path.dirname(fixture.calls[0].args.at(-1))), false);
});

test('changing the sealed snapshot fails its post-parser hash before another parser or output', t => {
  const fixture = setup(t);
  let snapshot;
  let calls = 0;
  const run = (tool, args) => {
    assert.equal(tool, 'dpkg-deb');
    assert.equal(args[0], '--show');
    calls++;
    snapshot = args.at(-1);
    fs.chmodSync(snapshot, 0o600);
    fs.writeFileSync(snapshot, Buffer.alloc(fixture.native.length));
    return Buffer.from('creator-hub\n0.1.13\namd64\n');
  };
  assert.throws(() => generate(fixture.options, { run }), /Hashed native parser snapshot changed/);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(fixture.options.output), false);
  assert.equal(fs.existsSync(path.dirname(snapshot)), false);
  assert.deepEqual(fs.readFileSync(fixture.options.deb), fixture.native);
});

for (const action of ['--show', '--fsys-tarfile']) {
  test(`parser error ${action} retains command/stderr and cleans snapshot without publishing bytes`, t => {
    const fixture = setup(t);
    let snapshot;
    const fault = Object.assign(new Error('original parser fault'), {
      code: 'EPIPE', status: 2, stderr: Buffer.from('specific dpkg diagnostic\n' + 's'.repeat(20000)),
      stdout: Buffer.from('BINARY_STDOUT_MUST_NOT_BE_LOGGED'),
    });
    const run = (tool, args, options) => {
      if (tool === 'dpkg-deb' && args[0] === action) {
        snapshot = args.at(-1);
        throw fault;
      }
      return fixture.run(tool, args, options);
    };
    assert.throws(() => generate(fixture.options, { run }), error => {
      assert.equal(error, fault);
      assert.equal(error.code, 'EPIPE');
      assert.equal(error.status, 2);
      assert.match(error.message, /dpkg-deb/);
      assert.ok(error.message.includes(action));
      assert.match(error.message, /original parser fault/);
      assert.match(error.message, /specific dpkg diagnostic/);
      assert.equal(error.message.includes('BINARY_STDOUT_MUST_NOT_BE_LOGGED'), false);
      assert.ok(error.message.length < 12000, 'Bounded report diagnostics');
      return true;
    });
    assert.equal(fs.existsSync(fixture.options.output), false);
    assert.equal(fs.existsSync(path.dirname(snapshot)), false);
  });
}

test('changing the input filename after hashing cannot replace the parsed/output snapshot', t => {
  const fixture = setup(t);
  const run = (tool, args, options) => {
    if (tool === 'dpkg-deb' && args[0] === '--show') fs.writeFileSync(fixture.options.deb, 'changed after snapshot');
    return fixture.run(tool, args, options);
  };
  generate(fixture.options, { run });
  assert.deepEqual(fs.readFileSync(path.join(fixture.options.output, 'native.deb')), fixture.native);
  assert.equal(fs.readFileSync(fixture.options.deb, 'utf8'), 'changed after snapshot');
});

test('an output reservation race refuses to replace the other output', t => {
  const fixture = setup(t);
  const run = (tool, args, options) => {
    if (tool === PYTHON && args.at(-1) === 'repack') {
      fs.mkdirSync(fixture.options.output);
      fs.writeFileSync(path.join(fixture.options.output, 'owned-elsewhere'), 'keep');
    }
    return fixture.run(tool, args, options);
  };
  assert.throws(() => generate(fixture.options, { run }), /EEXIST/);
  assert.deepEqual(fs.readdirSync(fixture.options.output), ['owned-elsewhere']);
});

test('archive byte and member-count limits fail closed through the real parser', () => {
  const data = tarFixture(members());
  execFileSync(PYTHON, ['-B', '-c', `
import sys
namespace = {'__name__': 'fixture'}
exec(sys.argv[1], namespace)
data = sys.stdin.buffer.read()
namespace['MAX_BYTES'] = len(data) - 1
try:
    namespace['inspect'](data)
    raise AssertionError('byte limit accepted')
except ValueError as error:
    assert 'limit' in str(error)
namespace['MAX_BYTES'] = len(data) + 1
namespace['MAX_ENTRIES'] = 2
try:
    namespace['inspect'](data)
    raise AssertionError('member limit accepted')
except ValueError as error:
    assert 'Too many' in str(error)
`, HELPER], { input: data, windowsHide: true });
});

test('no links/junctions in input or output ancestry', t => {
  const fixture = setup(t);
  const link = path.join(path.dirname(fixture.options.deb), 'linked');
  fs.symlinkSync(path.dirname(fixture.options.deb), link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => generate({ ...fixture.options, deb: path.join(link, path.basename(fixture.options.deb)) }), /link/i);
  assert.throws(() => generate({ ...fixture.options, output: path.join(link, 'output') }), /link/i);
});

test('manifest restricts sources to x86_64, pins every source, retains binaries and minimizes permissions', () => {
  const files = { 'payload.tar': Buffer.from('fixture'), 'inventory.json': Buffer.from('{}') };
  const value = manifest(files);
  assert.equal(value.id, ID);
  assert.equal(value.branch, 'experimental');
  assert.equal(value['runtime-version'], '50');
  assert.deepEqual(value['build-options'], { strip: false, 'no-debuginfo': true });
  assert.deepEqual(value['finish-args'], [...FINISH_ARGS]);
  assert.ok(value.modules[0]['build-commands'].includes('test "${FLATPAK_ARCH:?}" = x86_64'));
  assert.ok(value.modules[0]['build-commands'].includes('python3 payload.py verify inventory.json /app'));
  for (const source of value.modules[0].sources) {
    assert.deepEqual(source['only-arches'], ['x86_64']);
    assert.equal(source.sha256, sha256(files[source.path]));
  }
  assert.equal(/--filesystem=|--socket=(session|system)-bus|--talk-name=org\.freedesktop\.Flatpak|disable.*(tls|signature)/i.test(JSON.stringify(value)), false);
});

for (const bad of ['../escape', '/absolute', 'usr/lib/Creator Hub/../escape', 'usr//bin/extra',
  'usr/lib/Creator Hub/./extra', 'usr/lib/Creator Hub/back\\slash', 'usr/lib/Creator Hub/new\nline']) {
  test(`unsafe archive path refused: ${JSON.stringify(bad)}`, () => {
    assert.throws(() => inspect(tarFixture([...members(), file(bad, 'unsafe')])), /Unsafe tar path/);
  });
}

for (const type of ['symlink', 'hardlink', 'fifo']) {
  test(`unsupported archive type refused: ${type}`, () => {
    assert.throws(() => inspect(tarFixture([...members(), {
      name: 'usr/lib/Creator Hub/link', type, link: '/etc/passwd',
    }])), /special tar members/);
  });
}

test('duplicates, unsupported layout, special modes and file-as-parent are rejected', () => {
  assert.throws(() => inspect(tarFixture([...members(), file('usr/bin/creator-hub', elf())])), /Duplicate/);
  assert.throws(() => inspect(tarFixture([...members(), file('usr/bin/unexpected', elf())])), /Unknown native/);
  assert.throws(() => inspect(tarFixture([...members(), file('usr/lib/Creator Hub/setuid', 'x', 0o4755)])), /Special permission/);
  assert.throws(() => inspect(tarFixture([...members(), file('usr/lib/Creator Hub/tool/child', 'x')])), /parent directory/);
});

for (const [label, mutate] of [
  ['ELF32', data => { data[4] = 1; }], ['big-endian', data => { data[5] = 2; }],
  ['ARM64', data => { data.writeUInt16LE(183, 18); }], ['relocatable', data => { data.writeUInt16LE(1, 16); }],
  ['header size', data => { data.writeUInt16LE(60, 52); }],
  ['program headers', data => { data.writeBigUInt64LE(4096n, 32); }],
]) {
  test(`native executable architecture/header refused: ${label}`, () => {
    const data = elf();
    mutate(data);
    const entries = members();
    entries[2] = file('usr/bin/creator-hub', data, 0o755);
    assert.throws(() => inspect(tarFixture(entries)), /ELF|x86_64/);
  });
}

test('bundled ELF resources are architecture-checked too', () => {
  const data = elf();
  data.writeUInt16LE(183, 18);
  assert.throws(() => inspect(tarFixture([...members(), file('usr/lib/Creator Hub/extra.so', data)])), /x86_64/);
});

test('desktop structured identity, executable bit and required assets are mandatory', () => {
  for (const text of [DESKTOP.replace('Name=Creator Hub', 'Name=Other'),
    DESKTOP.replace('Exec=creator-hub', 'Exec=sh -c creator-hub'),
    DESKTOP.replace('Icon=creator-hub', 'Icon=other'), DESKTOP + 'Exec=other\n',
    DESKTOP + 'DBusActivatable=true\n', DESKTOP + '[Desktop Action Extra]\nExec=other\n']) {
    const entries = members();
    entries[6] = file(entries[6].name, text);
    assert.throws(() => inspect(tarFixture(entries)), /desktop|option/i);
  }
  const entries = members();
  entries[2].mode = 0o644;
  assert.throws(() => inspect(tarFixture(entries)), /not executable/);
  for (const index of [2, 6, 7]) {
    assert.throws(() => inspect(tarFixture(members().filter((_, i) => i !== index))), /required/);
  }
  assert.throws(() => inspect(Buffer.from('not a tar')), /refused/i);
});

test('generated desktop and XML identify this experiment without unification or supported claims', () => {
  const desktop = fs.readFileSync(path.join(ASSETS, `${ID}.desktop`), 'utf8');
  const xml = fs.readFileSync(path.join(ASSETS, `${ID}.metainfo.xml`), 'utf8');
  const parsed = JSON.parse(execFileSync(PYTHON, ['-B', '-c', `
import configparser, json, sys, xml.etree.ElementTree as ET
desktop = configparser.ConfigParser(interpolation=None)
desktop.read_string(sys.argv[1])
root = ET.fromstring(sys.argv[2])
print(json.dumps({'exec': desktop['Desktop Entry']['Exec'], 'icon': desktop['Desktop Entry']['Icon'],
                  'id': root.findtext('id'), 'desktop': root.find('launchable').text,
                  'name': root.findtext('name'), 'type': root.attrib['type']}))
`, desktop, xml], { windowsHide: true }));
  assert.deepEqual(parsed, { exec: 'creator-hub', icon: ID, id: ID, desktop: `${ID}.desktop`,
    name: 'Creator Hub (Flatpak Experiment)', type: 'desktop-application' });
  assert.equal(/unified|32.bit/i.test(desktop + xml), false);
  assert.match(xml, /not a supported installation/);
});

test('installed-payload verifier refuses altered bytes and modes', t => {
  const root = scopedTemp(t);
  execFileSync(PYTHON, ['-B', '-c', `
import json, os, sys
namespace = {'__name__': 'fixture'}
exec(sys.argv[1], namespace)
root = namespace['Path'](sys.argv[2])
target = root / 'test-file'
target.write_bytes(b'original')
target.chmod(0o644)
item = {'path': 'test-file', 'type': 'file', 'mode': 0o644, 'byteLength': 8,
        'sha256': namespace['hashlib'].sha256(b'original').hexdigest()}
inventory = {'schemaVersion': 1, 'entries': [item]}
if os.name != 'nt':
    namespace['verify'](inventory, root)
    target.chmod(0o600)
    try:
        namespace['verify'](inventory, root)
        raise AssertionError('changed mode accepted')
    except ValueError:
        pass
    target.chmod(0o644)
else:
    item['mode'] = namespace['stat'].S_IMODE(target.stat().st_mode)
    namespace['verify'](inventory, root)
target.write_bytes(b'corrupt!')
try:
    namespace['verify'](inventory, root)
    raise AssertionError('changed bytes accepted')
except ValueError:
    pass
`, HELPER, root], { windowsHide: true });
});

test('real dpkg-deb integration on Linux or an explicitly selected existing WSL distro', {
  skip: process.platform !== 'linux' && !process.env.FLATPAK_TEST_WSL_DISTRO,
}, t => {
  const fixture = setup(t);
  const run = (tool, args, options) => {
    if (tool !== 'dpkg-deb' || process.platform !== 'win32') return execFileSync(tool, args, options);
    const snapshot = execFileSync('wsl.exe', ['-d', process.env.FLATPAK_TEST_WSL_DISTRO,
      '--exec', 'wslpath', '-u', args.at(-1)], { encoding: 'utf8', windowsHide: true }).trim();
    return execFileSync('wsl.exe', ['-d', process.env.FLATPAK_TEST_WSL_DISTRO,
      '--exec', tool, ...args.slice(0, -1), snapshot], options);
  };
  const receipt = generate(fixture.options, { run });
  assert.equal(receipt.native.package, 'creator-hub');
  assert.equal(receipt.releaseReady, false);
  if (process.env.FLATPAK_TEST_VALIDATE === '1') {
    const linuxRun = (tool, args, cwd) => process.platform === 'win32'
      ? execFileSync('wsl.exe', ['-d', process.env.FLATPAK_TEST_WSL_DISTRO,
        ...(cwd ? ['--cd', cwd] : []), '--exec', tool, ...args], {
        timeout: 120000, windowsHide: true,
      }) : execFileSync(tool, args, { cwd });
    const linuxPath = filename => process.platform === 'win32'
      ? linuxRun('wslpath', ['-u', filename]).toString('utf8').trim() : filename;
    const filename = linuxPath(path.join(fixture.options.output, `${ID}.json`));
    const parsed = JSON.parse(linuxRun('flatpak-builder', ['--show-manifest', filename],
      linuxPath(path.dirname(fixture.options.output))));
    assert.equal(parsed['runtime-version'], '50');
    linuxRun('desktop-file-validate', [linuxPath(path.join(fixture.options.output, `${ID}.desktop`))]);
    linuxRun('appstreamcli', ['validate', '--no-net', linuxPath(path.join(fixture.options.output, `${ID}.metainfo.xml`))]);
  }
});

test('disposable hosted Linux automatically parses a real multi-megabyte DEB without stdin EPIPE', {
  skip: process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true'
    || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Linux',
}, t => {
  // Existing CI supplies dpkg-deb/Python. Missing tools fail; this test never provisions or installs.
  execFileSync('dpkg-deb', ['--version'], { timeout: 30000 });
  const root = scopedTemp(t);
  const resource = randomBytes(2 * 1024 * 1024);
  resource[0] = 0;
  const data = tarFixture([...members(), file('usr/lib/Creator Hub/pipe-regression.bin', resource, 0o640)]);
  const native = debFixture(data);
  assert.ok(native.length > 1024 * 1024, 'Incompressible DEB must exceed ordinary pipe buffering');
  const deb = path.join(root, 'synthetic-013-amd64.deb');
  fs.writeFileSync(deb, native);
  const output = path.join(root, 'generated');
  const calls = [];
  const run = (tool, args, options) => {
    if (tool === 'dpkg-deb') {
      assert.equal(options.input, undefined);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      assert.notEqual(args.at(-1), deb);
      assert.deepEqual(fs.readFileSync(args.at(-1)), native);
      calls.push({ args, snapshot: args.at(-1) });
      if (args[0] === '--show') fs.writeFileSync(deb, 'original filename changed after hashing');
    }
    return execFileSync(tool, args, options);
  };
  const receipt = generate({ deb, sha256: sha256(native), output }, { run });
  assert.equal(receipt.releaseReady, false);
  assert.equal(receipt.native.package, 'creator-hub');
  assert.equal(receipt.native.version, '0.1.13');
  assert.equal(receipt.native.architecture, 'amd64');
  assert.equal(receipt.native.sha256, sha256(native));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].snapshot, calls[1].snapshot);
  assert.equal(fs.existsSync(path.dirname(calls[0].snapshot)), false);
  assert.deepEqual(fs.readFileSync(path.join(output, 'native.deb')), native);
  const inventory = JSON.parse(fs.readFileSync(path.join(output, 'inventory.json')));
  const savedResource = inventory.entries.find(entry => entry.path === 'lib/Creator Hub/pipe-regression.bin');
  assert.equal(savedResource.sha256, sha256(resource));
  assert.equal(savedResource.byteLength, resource.length);
  assert.equal(savedResource.mode, 0o640);
});
