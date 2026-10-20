const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pkg = require('./flatpak-package.cjs');
const runner = require('./flatpak-disposable.cjs');
const stdio = { MEMBER: pkg.ROUTING[0], INPUT: pkg.ROUTER_INPUT, OUTPUT: pkg.ROUTER_OUTPUT };

function elf(suffix = '') {
  const bytes = Buffer.alloc(64); Buffer.from([127, 69, 76, 70, 2, 1]).copy(bytes);
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(62, 18);
  return Buffer.concat([bytes, Buffer.from(suffix)]);
}

const recipe = () => JSON.parse(pkg.read(path.join(pkg.RECIPE, `${pkg.ID}.json`), 65536));
function fixture(t, managed = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-flatpak-fixture-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('creator-flatpak-fixture-') && !fs.lstatSync(root).isSymbolicLink());
    fs.rmSync(root, { recursive: true, force: true });
  });
  const input = path.join(root, 'input'); fs.mkdirSync(input);
  const members = [...pkg.MEMBERS, ...(managed ? pkg.ROUTING : [])];
  const hashes = Object.fromEntries(members.map(name => [name, pkg.sha256(name)]));
  const payload = Buffer.from('Synthetic opaque archive: only the shared native decoder verifies members.');
  const manifest = { schemaVersion: 1, platform: 'linux', arch: 'x86_64', modules: {
    mcp: { executable: pkg.MEMBERS[0], version: '2.7.7', files: Object.fromEntries(pkg.MEMBERS.slice(0, 9).map(name => [name, hashes[name]])) },
    setup: { executable: pkg.MEMBERS[9], version: '0.3.7', files: { [pkg.MEMBERS[9]]: hashes[pkg.MEMBERS[9]] } },
  }, ...(managed ? { managedRouting: { protocol: 1, files: Object.fromEntries(pkg.ROUTING.map(name => [name, hashes[name]])) } } : {}),
  payloadArchive: { schemaVersion: 1, file: 'modules.tar.gz', ...pkg.record(payload), unpackedSize: members.length,
    files: Object.fromEntries(members.map(name => [name, { size: 1,
      mode: [pkg.MEMBERS[0], pkg.MEMBERS[2], pkg.MEMBERS[9], pkg.ROUTING[0]].includes(name) ? 0o755 : 0o644 }])) } };
  const router = managed ? elf('synthetic raw assembly router') : null;
  if (router) {
    manifest.managedRouting.files[stdio.MEMBER] = pkg.sha256(router);
    manifest.payloadArchive.files[stdio.MEMBER].size = router.length;
    manifest.payloadArchive.unpackedSize += router.length - 1;
  }
  const descriptor = Buffer.from(JSON.stringify(manifest, null, 2));
  const bytes = { 'creator-hub': elf(descriptor), 'builtin-manifest.json': descriptor, 'modules.tar.gz': payload,
    ...(router ? { [stdio.INPUT]: router } : {}) };
  for (const [name, value] of Object.entries(bytes)) {
    fs.mkdirSync(path.dirname(path.join(input, name)), { recursive: true });
    fs.writeFileSync(path.join(input, name), value);
  }
  const pins = { schemaVersion: 1, version: '0.1.14', platform: 'linux', arch: 'x86_64',
    mcpMode: managed ? 'writable' : 'read-only', sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40),
    runId: 1, runAttempt: 1, inputArtifactSha256: 'c'.repeat(64), files: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, pkg.record(value)])) };
  return { root, input, pins, manifest, bytes, destination: path.join(root, 'stage') };
}
function rewrite(f) {
  const descriptor = Buffer.from(JSON.stringify(f.manifest, null, 2));
  f.bytes['creator-hub'] = elf(descriptor); f.bytes['builtin-manifest.json'] = descriptor;
  for (const [name, bytes] of Object.entries(f.bytes)) {
    fs.writeFileSync(path.join(f.input, name), bytes); f.pins.files[name] = pkg.record(bytes);
  }
}
const metadata = () => `[Application]\nname=${pkg.ID}\nruntime=org.gnome.Platform/x86_64/50\nsdk=org.gnome.Sdk/x86_64/50\ncommand=creator-hub\n[Context]\nshared=ipc;\nsockets=wayland;fallback-x11;\ndevices=dri;\n`;
const env = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', CREATOR_FLATPAK_PACKAGE_TEST: '1',
  RUNNER_TEMP: path.resolve(os.tmpdir()) });

test('reviewed replacement pair binds distinct actual writable Root 14 artifacts, not a future update', () => {
  const plan = JSON.parse(pkg.read(path.join(pkg.RECIPE, 'replacement-014-inputs.json'), 65536));
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.scope, 'same-version-flatpak-package-replacement-only');
  assert.equal(plan.ref, pkg.REF);
  assert.deepEqual(plan.acceptance, { ...pkg.acceptance(), updateReady: false });
  for (const [name, id, size, runId, source, hubSha] of [
    ['baseline', 11857940858, 119406235, 38481240964, '216273ac80d1674ef5986f2d60b2650b33f48544',
      'e20d2ef60514b6eb3db4e561846336f59223dcc365c80865eab010a4f5cb4bff'],
    ['replacement', 11916403015, 119481169, 38607998719, '7eb00ad8a61db307c71bb95459ac85b7a957088d',
      '1ba7eabe233e9cce35b480b8651abb8b0496a519e55e13613b67720b406e54d9'],
  ]) {
    const input = plan[name]; pkg.validatePins(input.pins);
    assert.equal(input.artifactId, id); assert.equal(input.artifactSize, size);
    assert.equal(input.artifactName, `signed-unix-hub-linux-${runId}-1`);
    assert.equal(input.pins.runId, runId); assert.equal(input.pins.runAttempt, 1);
    assert.equal(input.pins.sourceCommit, source); assert.equal(input.pins.mcpMode, 'writable');
    assert.equal(input.pins.files['creator-hub'].sha256, hubSha);
    assert.equal(input.assemblyReceipt.size, 875); assert.match(input.assemblyReceipt.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(plan.baseline.pins.version, plan.replacement.pins.version);
  for (const name of pkg.INPUTS) assert.notEqual(plan.baseline.pins.files[name].sha256, plan.replacement.pins.files[name].sha256);
  assert.notEqual(plan.baseline.pins.sourceCommit, plan.replacement.pins.sourceCommit);
  const source = pkg.read(path.join(__dirname, 'flatpak-disposable.cjs'), 65536).toString();
  assert.ok(source.includes('Identical Hub bytes cannot prove package replacement'));
  assert.ok(source.includes('No replacement deployment'));
});

test('exact offline local-source recipe has no host, network, devel or bus grants', () => {
  pkg.validateRecipe(recipe());
  assert.deepEqual(recipe()['finish-args'], pkg.PERMISSIONS);
  for (const grant of ['--filesystem=home', '--filesystem=host', '--filesystem=host-os', '--filesystem=xdg-config',
    '--share=network', '--socket=session-bus', '--socket=system-bus', '--allow=devel', '--talk-name=org.freedesktop.Flatpak',
    '--talk-name=com.creatorworks.hub.HostMcp1']) {
    const changed = recipe(); changed['finish-args'].push(grant); assert.throws(() => pkg.validateRecipe(changed));
  }
});
test('recipe refuses executable overrides, downloads, broadening and stripping', () => {
  for (const mutate of [r => { r.command = 'sh'; }, r => { r.modules[0].sources[0].path = '../foreign'; },
    r => { r.modules[0].sources[0] = { type: 'archive', url: 'https://example.invalid/payload' }; },
    r => { r.modules[0]['build-commands'].push('flatpak-spawn --host sh'); }, r => { r['build-options'].strip = true; },
    r => { r['build-options']['no-debuginfo'] = false; }, r => { r['build-options']['build-args'] = ['--filesystem=host']; }]) {
    const changed = recipe(); mutate(changed); assert.throws(() => pkg.validateRecipe(changed));
  }
});
test('desktop, icon, resources, version and Hub license have exact identities', () => {
  const desktop = pkg.read(path.join(pkg.RECIPE, `${pkg.ID}.desktop`), 8192).toString();
  assert.equal(desktop, `[Desktop Entry]\nType=Application\nName=Creator Hub\nExec=creator-hub\nIcon=${pkg.ID}\nTerminal=false\nCategories=Development;\n`);
  const xml = pkg.read(path.join(pkg.RECIPE, `${pkg.ID}.metainfo.xml`), 8192).toString();
  assert.ok(xml.includes(`<id>${pkg.ID}</id>`)); assert.ok(xml.includes(`${pkg.ID}.desktop`));
  assert.ok(xml.includes('version="0.1.14"')); assert.ok(xml.includes('<project_license>MIT</project_license>'));
  assert.ok(recipe().modules[0]['build-commands'].some(line => line.includes('share/licenses/')));
  assert.ok(recipe().modules[0]['build-commands'].some(line => line.includes("'/app/lib/Creator Hub/modules.tar.gz'")));
});
test('optional AppStream composition is disabled and exact XML uses the proven builder appdata location', t => {
  assert.equal(recipe()['appstream-compose'], false);
  const changed = recipe(); changed['appstream-compose'] = true;
  assert.throws(() => pkg.validateRecipe(changed));
  const f = fixture(t, true); const receipt = pkg.prepare(f.input, f.pins, f.destination);
  const name = `share/appdata/${pkg.ID}.appdata.xml`;
  assert.equal(pkg.OUTPUTS[4], name);
  assert.deepEqual(receipt.files[name], pkg.record(pkg.read(path.join(pkg.RECIPE, `${pkg.ID}.metainfo.xml`), 8192)));
  assert.equal(fs.existsSync(path.join(f.destination, 'flatpak-input', `share/metainfo/${pkg.ID}.metainfo.xml`)), false);
  const rerouted = recipe(); rerouted.modules[0]['build-commands'][4] =
    `install -Dm644 ${name} /app/share/metainfo/${pkg.ID}.metainfo.xml`;
  assert.throws(() => pkg.validateRecipe(rerouted));
});
test('stages only six pinned files, without claiming archive, host or migration acceptance', t => {
  const f = fixture(t); const receipt = pkg.prepare(f.input, f.pins, f.destination);
  assert.deepEqual(pkg.verifyStage(f.destination, receipt), f.manifest);
  assert.equal(receipt.archiveMembersVerified, false);
  for (const name of Object.keys(pkg.acceptance())) assert.equal(receipt[name], false);
  assert.deepEqual(pkg.read(path.join(f.destination, 'flatpak-input', pkg.OUTPUTS[0])), f.bytes['creator-hub']);
  assert.deepEqual(pkg.read(path.join(f.destination, 'flatpak-input', pkg.OUTPUTS[1])), f.bytes['modules.tar.gz']);
  assert.throws(() => pkg.prepare(f.input, f.pins, f.destination), /EEXIST/);
});
test('managed routing input map and archive bytes survive unchanged without signature acceptance', t => {
  const f = fixture(t, true); const receipt = pkg.prepare(f.input, f.pins, f.destination);
  const actual = pkg.verifyStage(f.destination, receipt);
  assert.deepEqual(actual.managedRouting, f.manifest.managedRouting);
  assert.equal(Object.keys(actual.payloadArchive.files).length, 15);
  assert.equal(receipt.mcpAccepted, false); assert.equal(receipt.migrationAccepted, false);
  assert.equal(Object.keys(receipt.files).length, 7);
  assert.deepEqual(pkg.read(path.join(f.destination, 'flatpak-input', stdio.OUTPUT)), f.bytes[stdio.INPUT]);
  assert.deepEqual(receipt.files[stdio.OUTPUT], { size: actual.payloadArchive.files[stdio.MEMBER].size,
    sha256: actual.managedRouting.files[stdio.MEMBER] });
});

test('read-only inputs have no callable router; writable recipe installs the exact fixed executable', t => {
  const f = fixture(t); const receipt = pkg.prepare(f.input, f.pins, f.destination);
  assert.equal(Object.keys(receipt.files).length, 6);
  assert.equal(fs.existsSync(path.join(f.destination, 'flatpak-input', stdio.OUTPUT)), false);
  assert.equal(recipe().modules[0]['build-commands'].at(-1),
    `if test -f ${stdio.OUTPUT}; then install -Dm755 ${stdio.OUTPUT} /app/${stdio.OUTPUT}; fi`);
  for (const command of [`install -Dm755 bin/creator-hub /app/${stdio.OUTPUT}`,
    `install -Dm755 ${stdio.OUTPUT} /app/bin/router`, `chmod 777 /app/${stdio.OUTPUT}`]) {
    const changed = recipe(); changed.modules[0]['build-commands'].splice(-1, 1, command);
    assert.throws(() => pkg.validateRecipe(changed));
  }
});

test('historical three-file writable pins are readable but cannot authorize staging or recheck', t => {
  const f = fixture(t, true), historical = structuredClone(f.pins);
  delete historical.files[stdio.INPUT]; pkg.validatePins(historical);
  assert.throws(() => pkg.prepare(f.input, historical, f.destination), /independently reviewed raw router pin is required/);
  assert.equal(fs.existsSync(f.destination), false);
  const receipt = pkg.prepare(f.input, f.pins, f.destination);
  delete receipt.provenance.files[stdio.INPUT];
  assert.throws(() => pkg.verifyStage(f.destination, receipt), /independently reviewed raw router pin is required/);
});

test('read-only, alternate-path, extra and malformed raw-router pins refuse', t => {
  for (const mutate of [p => { p.mcpMode = 'read-only'; }, p => {
    p.files['modules/routing/../creator-hub-mcp-router'] = p.files[stdio.INPUT]; delete p.files[stdio.INPUT];
  }, p => { p.files['arbitrary-router'] = p.files[stdio.INPUT]; }, p => { p.files[stdio.INPUT].size = 0; },
  p => { p.files[stdio.INPUT].sha256 = 'not-a-hash'; }]) {
    const f = fixture(t, true); mutate(f.pins);
    assert.throws(() => pkg.prepare(f.input, f.pins, f.destination));
    assert.equal(fs.existsSync(f.destination), false);
  }
});

test('missing or tampered libexec copy refuses even when its receipt is edited', t => {
  const f = fixture(t, true); const receipt = pkg.prepare(f.input, f.pins, f.destination);
  const file = path.join(f.destination, 'flatpak-input', stdio.OUTPUT);
  fs.writeFileSync(file, elf('substitute'));
  assert.throws(() => pkg.verifyStage(f.destination, receipt), /Staged bytes changed/);
  receipt.files[stdio.OUTPUT] = pkg.record(pkg.read(file));
  assert.throws(() => pkg.verifyStage(f.destination, receipt), /independently reviewed raw router pin/);
  fs.unlinkSync(file);
  assert.throws(() => pkg.verifyStage(f.destination, receipt), /Unexpected staged file/);
});

test('libexec hard links and redirected ancestors are refused', t => {
  const f = fixture(t, true); const receipt = pkg.prepare(f.input, f.pins, f.destination);
  const directory = path.join(f.destination, 'flatpak-input', 'libexec');
  const file = path.join(directory, 'creator-hub-mcp-router'), linked = path.join(f.root, 'linked-router');
  fs.linkSync(file, linked);
  assert.throws(() => pkg.verifyStage(f.destination, receipt), /Bounded ordinary/);
  fs.unlinkSync(linked);
  const moved = path.join(f.root, 'redirected-libexec'); fs.renameSync(directory, moved);
  fs.symlinkSync(moved, directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => pkg.verifyStage(f.destination, receipt), /Redirected path/);
});

test('Linux stage recheck refuses changed router executable modes', { skip: process.platform !== 'linux' }, t => {
  const f = fixture(t, true); const receipt = pkg.prepare(f.input, f.pins, f.destination);
  const file = path.join(f.destination, 'flatpak-input', stdio.OUTPUT);
  for (const mode of [0o644, 0o777, 0o4755]) {
    fs.chmodSync(file, mode); assert.throws(() => pkg.verifyStage(f.destination, receipt), /mode differs/);
  }
  fs.chmodSync(file, 0o755); pkg.verifyStage(f.destination, receipt);
});

test('raw router pin, routing digest, bound size, native ELF and mode must match before stage writes', t => {
  for (const kind of ['pin', 'digest', 'size', 'elf', 'mode']) {
    const f = fixture(t, true);
    if (kind === 'digest') f.manifest.managedRouting.files[stdio.MEMBER] = 'd'.repeat(64);
    if (kind === 'size') { f.manifest.payloadArchive.files[stdio.MEMBER].size++; f.manifest.payloadArchive.unpackedSize++; }
    if (kind === 'elf') {
      f.bytes[stdio.INPUT][18] = 183;
      f.manifest.managedRouting.files[stdio.MEMBER] = pkg.sha256(f.bytes[stdio.INPUT]);
    }
    if (kind === 'mode') f.manifest.payloadArchive.files[stdio.MEMBER].mode = 0o644;
    rewrite(f);
    if (kind === 'pin') f.pins.files[stdio.INPUT].sha256 = 'd'.repeat(64);
    assert.throws(() => pkg.prepare(f.input, f.pins, f.destination));
    assert.equal(fs.existsSync(f.destination), false, `${kind} must refuse before stage creation`);
  }
});

test('fourth input refuses missing, changed, hard-linked, redirected and non-file raw routers', t => {
  for (const kind of ['missing', 'changed', 'hardlink', 'redirected', 'directory', 'empty']) {
    const f = fixture(t, true), file = path.join(f.input, stdio.INPUT);
    if (kind === 'missing') fs.unlinkSync(file);
    if (kind === 'changed') fs.appendFileSync(file, 'changed');
    if (kind === 'hardlink') fs.linkSync(file, path.join(f.root, 'linked'));
    if (kind === 'redirected') {
      const directory = path.dirname(file), moved = path.join(f.root, 'redirected-routing');
      fs.renameSync(directory, moved); fs.symlinkSync(moved, directory, process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (kind === 'directory') { fs.unlinkSync(file); fs.mkdirSync(file); }
    if (kind === 'empty') fs.writeFileSync(file, '');
    assert.throws(() => pkg.prepare(f.input, f.pins, f.destination), undefined, kind);
    assert.equal(fs.existsSync(f.destination), false);
  }
});

test('raw-router input drift after copying refuses publication of a stage receipt', t => {
  const f = fixture(t, true), write = fs.writeFileSync;
  const target = path.join(f.destination, 'flatpak-input', stdio.OUTPUT);
  t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    const result = write(file, ...args);
    if (file === target) write(path.join(f.input, stdio.INPUT), elf('changed after copy'));
    return result;
  });
  assert.throws(() => pkg.prepare(f.input, f.pins, f.destination), /Input drift: modules\/routing\/creator-hub-mcp-router/);
  assert.equal(fs.existsSync(path.join(f.destination, 'flatpak-stage.json')), false);
});

test('managed archive remains opaque and unchanged; packaging adds no TAR or zlib decoder', t => {
  const f = fixture(t, true);
  const receipt = pkg.prepare(f.input, f.pins, f.destination);
  assert.deepEqual(pkg.read(path.join(f.destination, 'flatpak-input', pkg.OUTPUTS[1])), f.bytes['modules.tar.gz']);
  assert.equal(receipt.archiveMembersVerified, false);
  assert.equal(fs.existsSync(path.join(__dirname, 'flatpak-mcp-stdio-archive.cjs')), false);
  const source = fs.readFileSync(path.join(__dirname, 'flatpak-package.cjs'), 'utf8');
  assert.doesNotMatch(source, /flatpak-mcp-stdio-archive|node:zlib|crc32|inflate|gunzip/);
});
test('producer-mode mismatch refuses before creating a stage', t => {
  const f = fixture(t); f.pins.mcpMode = 'writable';
  assert.throws(() => pkg.prepare(f.input, f.pins, f.destination), /producer mode/);
  assert.equal(fs.existsSync(f.destination), false);
});
test('old version, missing provenance, altered pins and extra inputs refuse', t => {
  const f = fixture(t);
  for (const mutate of [p => { p.version = '0.1.13'; }, p => { delete p.sourceTree; }, p => { p.runId = 0; },
    p => { p.files['creator-hub'].sha256 = 'd'.repeat(64); }, p => { p.files['arbitrary'] = p.files['creator-hub']; }]) {
    const changed = structuredClone(f.pins); mutate(changed);
    assert.throws(() => pkg.prepare(f.input, changed, f.destination)); assert.equal(fs.existsSync(f.destination), false);
  }
});
test('modified inputs, missing inputs and unembedded descriptor refuse before writes', t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.input, 'modules.tar.gz'), 'changed');
  assert.throws(() => pkg.prepare(f.input, f.pins, f.destination), /Reviewed input differs/);
  fs.writeFileSync(path.join(f.input, 'modules.tar.gz'), f.bytes['modules.tar.gz']);
  fs.writeFileSync(path.join(f.input, 'creator-hub'), f.bytes['creator-hub'].subarray(0, 64));
  f.pins.files['creator-hub'] = pkg.record(f.bytes['creator-hub'].subarray(0, 64));
  assert.throws(() => pkg.prepare(f.input, f.pins, f.destination), /embedded descriptor/);
  fs.unlinkSync(path.join(f.input, 'builtin-manifest.json'));
  assert.throws(() => pkg.prepare(f.input, f.pins, f.destination), /ENOENT/);
});
test('ELF machine, class, endianness and executable shape must match', t => {
  const f = fixture(t); pkg.validateElf(f.bytes['creator-hub']);
  for (const [offset, value] of [[0, 0], [4, 1], [5, 2], [16, 1], [18, 183]]) {
    const changed = Buffer.from(f.bytes['creator-hub']); changed[offset] = value; assert.throws(() => pkg.validateElf(changed));
  }
  assert.throws(() => pkg.validateElf(Buffer.alloc(63)));
});
test('unexpected archive members, unsigned raw descriptor and wrong module versions refuse', t => {
  const f = fixture(t, true);
  for (const mutate of [m => { m.modules.mcp.version = '2.7.8'; }, m => { delete m.payloadArchive; },
    m => { m.managedRouting.files['routing/foreign'] = 'd'.repeat(64); },
    m => { m.payloadArchive.files[pkg.MEMBERS[0]].mode = 0o644; }]) {
    const changed = structuredClone(f.manifest); mutate(changed); assert.throws(() => pkg.validateDescriptor(changed));
  }
});
test('staged changes and additional files are not authorized by a receipt', t => {
  const f = fixture(t); const receipt = pkg.prepare(f.input, f.pins, f.destination);
  const file = path.join(f.destination, 'flatpak-input', pkg.OUTPUTS[0]); fs.appendFileSync(file, 'changed');
  assert.throws(() => pkg.verifyStage(f.destination, receipt), /Staged bytes changed/);
  fs.writeFileSync(file, f.bytes['creator-hub']);
  fs.writeFileSync(path.join(f.destination, 'flatpak-input', 'foreign'), 'foreign');
  assert.throws(() => pkg.verifyStage(f.destination, receipt), /Unexpected staged file/);
});
test('bounded reads refuse hard-linked inputs, directories and oversized files', t => {
  const f = fixture(t); const original = path.join(f.input, 'creator-hub'); const linked = path.join(f.root, 'linked');
  fs.linkSync(original, linked); assert.throws(() => pkg.read(original), /Bounded ordinary/);
  assert.deepEqual(pkg.read(original, pkg.LIMIT, true), f.bytes['creator-hub']);
  assert.throws(() => pkg.read(f.input)); assert.throws(() => pkg.read(linked, 10));
});
test('symlinked ancestor refuses without opening any target file', t => {
  const f = fixture(t); const link = path.join(f.root, 'redirect');
  fs.symlinkSync(f.input, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => pkg.read(path.join(link, 'creator-hub')), /Redirected path/);
});
test('disposable admission refuses user PC, sandbox, wrong repo and missing opt-in', () => {
  runner.admission(env(), 'linux', 'x64');
  for (const [name, value] of [['GITHUB_ACTIONS', 'false'], ['RUNNER_ENVIRONMENT', 'self-hosted'], ['CREATOR_FLATPAK_PACKAGE_TEST', '0'],
    ['GITHUB_REPOSITORY', 'foreign/repo'], ['GITHUB_REPOSITORY_ID', '1'], ['FLATPAK_ID', pkg.ID], ['NODE_OPTIONS', '--inspect']]) {
    assert.throws(() => runner.admission({ ...env(), [name]: value }, 'linux', 'x64'));
  }
  assert.throws(() => runner.admission(env(), 'win32', 'x64')); assert.throws(() => runner.admission(env(), 'linux', 'arm64'));
});
test('child environment contains only owned directories and finite OS constants', () => {
  const root = path.resolve(os.tmpdir(), 'not-created-flatpak-env-fixture'); const child = runner.childEnvironment(root);
  for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'GNUPGHOME', 'FLATPAK_USER_DIR']) {
    assert.ok(path.relative(root, child[name]) && !path.relative(root, child[name]).startsWith('..'));
  }
  assert.deepEqual(Object.keys(child).sort(), ['FLATPAK_FANCY_OUTPUT', 'FLATPAK_TTY_PROGRESS', 'FLATPAK_USER_DIR', 'GNUPGHOME', 'HOME', 'LANG', 'LC_ALL',
    'PATH', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR']);
  assert.equal(child.DBUS_SESSION_BUS_ADDRESS, undefined); assert.equal(child.GITHUB_TOKEN, undefined);
});
test('deployed metadata allows exact graphics only and refuses grant/env/bus injection', () => {
  runner.parseMetadata(metadata());
  for (const text of [metadata().replace('ipc;', 'ipc;network;'), `${metadata()}filesystems=home;\n`,
    `${metadata()}[Session Bus Policy]\norg.freedesktop.Flatpak=talk\n`, `${metadata()}[Environment]\nLD_PRELOAD=foreign\n`,
    metadata().replace('command=creator-hub', 'command=sh'), metadata().replace('devices=dri;', 'devices=all;'),
    metadata().replace('sockets=wayland;fallback-x11;', 'sockets=session-bus;'), `${metadata()}[Context]\n`,
    `${metadata()}shared=ipc;\n`]) assert.throws(() => runner.parseMetadata(text));
});
test('Flatpak 1.12.7 captured fallback metadata accepts only the exact canonical three socket bits', () => {
  // Run 38615166143, build-0/metadata; fixture bytes are pinned to the retained artifact.
  const captured = `[Application]\nname=${pkg.ID}\nruntime=org.gnome.Platform/x86_64/50\nsdk=org.gnome.Sdk/x86_64/50\ncommand=creator-hub\n\n[Context]\nshared=ipc;\nsockets=x11;wayland;fallback-x11;\ndevices=dri;\n`;
  assert.equal(Buffer.byteLength(captured), 195);
  assert.equal(pkg.sha256(captured), '5d3028ba3e3a7273d57680b9c8531e17dacb82099d0ba7767941df69b3edd707');
  assert.equal(runner.parseMetadata(captured).Context.sockets, 'x11;wayland;fallback-x11;');
  runner.parseMetadata(captured.replace('x11;wayland;fallback-x11;', 'fallback-x11;x11;wayland;'));
  for (const sockets of ['x11;wayland;', 'x11;', 'x11;wayland;fallback-x11;session-bus;',
    'x11;fallback-x11;', 'x11;wayland;fallback-x11;x11;', 'x11;wayland;fallback-x11;wayland;',
    'x11;wayland;fallback-x11;fallback-x11;', 'x11;wayland;fallback-x11;system-bus;']) {
    assert.throws(() => runner.parseMetadata(captured.replace(/^sockets=.*$/m, `sockets=${sockets}`)), /Sandbox permission differs/);
  }
  for (const text of [`${captured}[Environment]\nPATH=/foreign\n`,
    `${captured}[Session Bus Policy]\norg.freedesktop.Flatpak=talk\n`,
    `${captured}[System Bus Policy]\norg.foreign=talk\n`, `${captured}env=FOREIGN\n`,
    `${captured}sockets=x11;wayland;fallback-x11;\n`, `${captured}[Context]\n`,
    captured.replace('ipc;', 'ipc;network;'), `${captured}filesystems=home;\n`]) {
    assert.throws(() => runner.parseMetadata(text));
  }
  assert.deepEqual(recipe()['finish-args'], pkg.PERMISSIONS);
  assert.equal(recipe()['finish-args'].includes('--socket=x11'), false);
});
test('runtime linkage requires the native loader and rejects missing libraries/symbol versions', () => {
  const known = 'linux-vdso.so.1 (0x1)\nlibc.so.6 => /usr/lib/libc.so.6 (0x2)\n/lib64/ld-linux-x86-64.so.2 (0x3)';
  assert.equal(runner.linkageMatches(known), true);
  for (const text of ['', 'fixture-only', `${known}\nlibwebkit2gtk-4.1.so.0 => not found`,
    `${known}\nversion GLIBC_2.99 not found`, `${known}\nELF error`, 'not a dynamic executable']) assert.equal(runner.linkageMatches(text), false);
  assert.ok(runner.ABI_SCRIPT.endsWith('2>&1'), 'Capture linker stderr within the bounded probe output');
});
test('captured Platform linkage does not mistake resolved libgpg-error for a diagnostic', () => {
  // Selected unmodified rows from run 38617207622's retained Platform probe.
  const captured = [
    '\tlibssl.so.3 => /usr/lib/x86_64-linux-gnu/libssl.so.3 (0x00007f6fdd1ea000)',
    '\tlibcrypto.so.3 => /usr/lib/x86_64-linux-gnu/libcrypto.so.3 (0x00007f6fdbc00000)',
    '\tlibwebkit2gtk-4.1.so.0 => /usr/lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0 (0x00007f6fd5a00000)',
    '\tlibgtk-3.so.0 => /usr/lib/x86_64-linux-gnu/libgtk-3.so.0 (0x00007f6fd5200000)',
    '\tlibjavascriptcoregtk-4.1.so.0 => /usr/lib/x86_64-linux-gnu/libjavascriptcoregtk-4.1.so.0 (0x00007f6fd2e00000)',
    '\t/lib64/ld-linux-x86-64.so.2 (0x00007f6fdd2fe000)',
    '\tlibgpg-error.so.0 => /usr/lib/x86_64-linux-gnu/libgpg-error.so.0 (0x00007f6fd0344000)',
  ].join('\n');
  assert.equal(Buffer.byteLength(captured), 579);
  assert.equal(pkg.sha256(captured), 'abb34ddf5c86516edda132a79d5eb643bb4887528a6c98c68347b7d51f871156');
  assert.equal(runner.linkageMatches(captured), true);
  assert.deepEqual(runner.linkageDiagnostics(captured), { loaderFound: true, resolvedLineCount: 7,
    unrecognizedLineCount: 0, unrecognizedLines: [], selectedLibraries: Object.fromEntries([
      'libssl.so.3', 'libcrypto.so.3', 'libwebkit2gtk-4.1.so.0', 'libgtk-3.so.0',
      'libjavascriptcoregtk-4.1.so.0', 'libgpg-error.so.0',
    ].map(name => [name, `/usr/lib/x86_64-linux-gnu/${name}`])) });
});
test('linkage rows refuse real diagnostics, unresolved paths and malformed or missing loader proof', () => {
  const loader = '/lib64/ld-linux-x86-64.so.2 (0x3)';
  assert.equal(runner.linkageMatches(`libinvalid-error.so => /usr/lib/libinvalid-error.so (0x1)\n${loader}`), true);
  for (const line of ['libgpg-error.so.0 => not found', '/app/bin/creator-hub: version GLIBC_2.99 not found',
    'ERROR: ld.so: object cannot be preloaded', 'ELF error', 'invalid ELF header', 'not a dynamic executable',
    'undefined symbol: known_function', 'libssl.so.3 => relative/libssl.so.3 (0x1)',
    'libssl.so.3 => /usr/lib/libssl.so.3', 'libssl.so.3 => /usr/lib/libssl.so.3 (not found)',
    '/lib64/ld-linux-x86-64.so.2 (0x3) ignored warning']) {
    const text = `${loader}\n${line}`;
    assert.equal(runner.linkageMatches(text), false);
    assert.equal(runner.linkageDiagnostics(text).unrecognizedLineCount, 1);
  }
  for (const text of ['ld-linux-x86-64.so.2', 'linux-vdso.so.1 (0x1)',
    'libssl.so.3 => /usr/lib/libssl.so.3 (0x1)']) assert.equal(runner.linkageMatches(text), false);
});
test('static linkage diagnostics keep existing output bound and limit refusal summaries', () => {
  assert.throws(() => runner.linkageDiagnostics('x'.repeat(65537)), /Bounded linker output/);
  const diagnostics = runner.linkageDiagnostics(Array(12).fill('x'.repeat(400)).join('\n'));
  assert.equal(diagnostics.unrecognizedLineCount, 12);
  assert.equal(diagnostics.unrecognizedLines.length, 8);
  assert.ok(diagnostics.unrecognizedLines.every(line => line.length === 300));
  const source = pkg.read(path.join(__dirname, 'flatpak-disposable.cjs'), 65536).toString();
  assert.ok(source.includes('report.builds[index].linkageDiagnostics = linkageDiagnostics(linkage);'));
  assert.ok(source.includes('{ timeout: 30000, maxBuffer: 65536 }'));
});
test('runner source confines install/update to owned exact ref and does not launch the product', () => {
  const source = pkg.read(path.join(__dirname, 'flatpak-disposable.cjs'), 65536).toString();
  assert.ok(source.includes('env: childEnv')); assert.ok(source.includes('timeout: 600000')); assert.ok(source.includes('maxBuffer: 1024 * 1024'));
  assert.ok(source.includes("['--arch=x86_64', '--sandbox', '--disable-download'"));
  assert.ok(source.includes("['update', '--user', '--noninteractive', '--assumeyes', '--no-deps', '--no-related', pkg.REF]"));
  assert.ok(source.includes("['run', '--user', '--sandbox', '--command=sh', pkg.REF, '-c', ABI_SCRIPT]"));
  assert.ok(source.includes('archive.verify(')); assert.ok(source.includes('pkg.verifyStage(source, receipt)'));
  assert.ok(source.includes('report.packageInstalled = true;'));
  assert.ok(source.includes('report.builds.every(build => build.runtimeLinkProbePassed === true)'));
  assert.ok(source.includes('report.builds.length === stages.length'), 'A partial two-input run cannot claim all linker probes passed');
  assert.ok(!/shell:\s*true|flatpak-spawn|--filesystem|--allow=devel|--force-clean|--delete-data|\['kill'|\['uninstall'|sudo/.test(source));
  assert.ok(!runner.ABI_SCRIPT.includes('creator-hub --')); assert.ok(runner.ABI_SCRIPT.includes('ldd /app/bin/creator-hub'));
});

test('real package workflow installs locked Node dependencies before contract tests or staging', () => {
  const source = fs.readFileSync(path.join(__dirname, '../.github/workflows/flatpak-package-014.yml'), 'utf8');
  const dependencies = source.indexOf('run: npm ci --ignore-scripts');
  const preflight = source.indexOf('run: node --test scripts/flatpak-package.test.cjs');
  const download = source.indexOf('downloadInputs(github,context)');
  assert.ok(dependencies >= 0 && dependencies < preflight && preflight < download);
  const verifier = pkg.read(path.join(__dirname, 'flatpak-replacement-source.cjs'), 65536).toString();
  assert.ok(verifier.includes("assert.equal(run.conclusion, 'success')"));
  assert.ok(verifier.includes("assert.equal(artifact.expired, false)"));
  const pair = JSON.parse(pkg.read(path.join(pkg.RECIPE, 'replacement-014-inputs.json'), 65536));
  assert.equal(pair.replacement.artifactId, 11916403015);
  assert.equal(pair.replacement.pins.inputArtifactSha256, 'e875b1cd071a42f9c264295b05425708df2e0d4574aa0d88e9136e919ce6f780');
  assert.doesNotMatch(source, /contents: write|--filesystem|--allow=devel|flatpak-spawn|release (?:create|edit|upload)/);
});
