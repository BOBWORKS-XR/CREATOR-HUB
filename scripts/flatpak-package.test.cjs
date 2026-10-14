const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pkg = require('./flatpak-package.cjs');
const runner = require('./flatpak-disposable.cjs');

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
  const payload = Buffer.from('Synthetic archive: staging does not claim native member verification.');
  const manifest = { schemaVersion: 1, platform: 'linux', arch: 'x86_64', modules: {
    mcp: { executable: pkg.MEMBERS[0], version: '2.7.7', files: Object.fromEntries(pkg.MEMBERS.slice(0, 9).map(name => [name, hashes[name]])) },
    setup: { executable: pkg.MEMBERS[9], version: '0.3.7', files: { [pkg.MEMBERS[9]]: hashes[pkg.MEMBERS[9]] } },
  }, ...(managed ? { managedRouting: { protocol: 1, files: Object.fromEntries(pkg.ROUTING.map(name => [name, hashes[name]])) } } : {}),
  payloadArchive: { schemaVersion: 1, file: 'modules.tar.gz', ...pkg.record(payload), unpackedSize: members.length,
    files: Object.fromEntries(members.map(name => [name, { size: 1,
      mode: [pkg.MEMBERS[0], pkg.MEMBERS[2], pkg.MEMBERS[9], pkg.ROUTING[0]].includes(name) ? 0o755 : 0o644 }])) } };
  const descriptor = Buffer.from(JSON.stringify(manifest, null, 2));
  const header = Buffer.alloc(64); Buffer.from([127, 69, 76, 70, 2, 1]).copy(header);
  header.writeUInt16LE(3, 16); header.writeUInt16LE(62, 18);
  const bytes = { 'creator-hub': Buffer.concat([header, descriptor]), 'builtin-manifest.json': descriptor, 'modules.tar.gz': payload };
  for (const [name, value] of Object.entries(bytes)) fs.writeFileSync(path.join(input, name), value);
  const pins = { schemaVersion: 1, version: '0.1.14', platform: 'linux', arch: 'x86_64',
    mcpMode: managed ? 'writable' : 'read-only', sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40),
    runId: 1, runAttempt: 1, inputArtifactSha256: 'c'.repeat(64), files: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, pkg.record(value)])) };
  return { root, input, pins, manifest, bytes, destination: path.join(root, 'stage') };
}
const metadata = () => `[Application]\nname=${pkg.ID}\nruntime=org.gnome.Platform/x86_64/50\nsdk=org.gnome.Sdk/x86_64/50\ncommand=creator-hub\n[Context]\nshared=ipc;\nsockets=wayland;fallback-x11;\ndevices=dri;\n`;
const env = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', CREATOR_FLATPAK_PACKAGE_TEST: '1',
  RUNNER_TEMP: path.resolve(os.tmpdir()) });

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
test('runtime linkage requires the native loader and rejects missing libraries/symbol versions', () => {
  const known = 'linux-vdso.so.1 (0x1)\nlibc.so.6 => /usr/lib/libc.so.6 (0x2)\n/lib64/ld-linux-x86-64.so.2 (0x3)';
  assert.equal(runner.linkageMatches(known), true);
  for (const text of ['', 'fixture-only', `${known}\nlibwebkit2gtk-4.1.so.0 => not found`,
    `${known}\nversion GLIBC_2.99 not found`, `${known}\nELF error`, 'not a dynamic executable']) assert.equal(runner.linkageMatches(text), false);
  assert.ok(runner.ABI_SCRIPT.endsWith('2>&1'), 'Capture linker stderr within the bounded probe output');
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
  assert.ok(!/shell:\s*true|flatpak-spawn|--filesystem|--allow=devel|--force-clean|--delete-data|\['kill'|\['uninstall'|sudo/.test(source));
  assert.ok(!runner.ABI_SCRIPT.includes('creator-hub --')); assert.ok(runner.ABI_SCRIPT.includes('ldd /app/bin/creator-hub'));
});

test('real package workflow installs locked Node dependencies before contract tests or staging', () => {
  const source = fs.readFileSync(path.join(__dirname, '../.github/workflows/flatpak-package-014.yml'), 'utf8');
  const dependencies = source.indexOf('run: npm ci --ignore-scripts');
  const preflight = source.indexOf('run: node --test scripts/flatpak-package.test.cjs');
  const download = source.indexOf('downloadArtifact(');
  assert.ok(dependencies >= 0 && dependencies < preflight && preflight < download);
  assert.ok(source.includes("assert.equal(run.conclusion,'success')"));
  assert.ok(source.includes("assert.equal(artifact.expired,false)"));
  assert.ok(source.includes('11916403015'));
  assert.ok(source.includes('e875b1cd071a42f9c264295b05425708df2e0d4574aa0d88e9136e919ce6f780'));
  assert.doesNotMatch(source, /contents: write|--filesystem|--allow=devel|flatpak-spawn|release (?:create|edit|upload)/);
});
