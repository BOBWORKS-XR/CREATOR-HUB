// CI-only packaging of frozen native bytes. Never builds, signs, installs or opens Hub.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const finite = require('./flatpak-package.cjs');
const { capture } = require('./sign-unix-payload.cjs');
const archive = require('./module-archive.cjs');
const unix = require('./unix-package-payload.cjs');

const BRANCH = 'refs/heads/validation/linux-integrated-portable-fixture';
const FEATURES = 'integrated-features,experimental-flatpak-host,experimental-linux-migration';
const TARGET = 'x86_64-unknown-linux-gnu';
const PRODUCER = Object.freeze({
  source: '5065fb1112b9e96978e40e64503fa979f559baae', run: 39134487363, attempt: 1,
  job: 117696169938, artifact: 12139109123, name: 'signed-unix-hub-linux-39134487363-1',
  size: 182723403, sha256: '71a2a4e42a1b1e2fe5e1e64f363f7d3c06444b03b5d2177b2e4565ad8a710c4c',
});
const INPUTS = Object.freeze(Object.fromEntries(Object.entries({
  'creator-hub': { size: 27369792, sha256: '2e653b3b97513a2a2d41040be85441472f6f945d54255da6d283eb769648f081' },
  'modules.tar.gz': { size: 55572917, sha256: 'fe12889dea4b9843b108de6f7d3fe0175ab06f496cd8e62553879bc377c9b44e' },
  'builtin-manifest.json': { size: 3663, sha256: 'cabbc045eea9b29901f44d4b0c4cb1da1ffdf570821003a5118b25edb6a84996' },
}).map(([name, pin]) => [name, Object.freeze(pin)])));
const acceptance = () => Object.fromEntries(['nativeLinuxAccepted', 'steamOSAccepted', 'directPagesAccepted',
  'migrationAccepted', 'retirementAccepted', 'flatpakAccepted', 'signedUpdateAccepted', 'portableUpdateAccepted',
  'restartAccepted', 'releaseReady'].map(name => [name, false]));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function admission(env, platform, arch) {
  assert.equal(platform, 'linux'); assert.equal(arch, 'x64');
  for (const [name, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REPOSITORY_ID: '1364807512', GITHUB_REF: BRANCH })) assert.equal(env[name], value, name);
  assert.ok(['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME));
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  for (const name of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[name] || '', /^[1-9][0-9]*$/);
  assert.ok(!Object.keys(env).some(name => /^(LD_|DYLD_|TAURI_|APPLE_|CREATOR_HUB_SIGNING_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSL_CERT_|WEBKIT_|APPIMAGE$|APPDIR$|RUSTFLAGS$|CARGO_ENCODED_RUSTFLAGS$)/.test(name)
    || name.toLowerCase().endsWith('proxy')), 'Runtime, compiler, trust and signing overrides refused');
  assert.ok(!env.FLATPAK_ID, 'Disposable native host required');
}

function verifyProducer(run, job, item) {
  assert.equal(run.id, PRODUCER.run); assert.equal(run.head_sha, PRODUCER.source);
  assert.equal(run.run_attempt, 1); assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
  assert.equal(run.event, 'workflow_dispatch'); assert.equal(run.repository.id, 1364807512);
  assert.equal(run.path, '.github/workflows/unix-managed-assembly.yml');
  assert.equal(run.head_branch, 'validation/linux-integrated-candidate-014');
  assert.equal(job.id, PRODUCER.job); assert.equal(job.run_id, PRODUCER.run); assert.equal(job.conclusion, 'success');
  assert.match(job.name, /^assembly \(linux,/);
  assert.equal(item.id, PRODUCER.artifact); assert.equal(item.name, PRODUCER.name); assert.equal(item.expired, false);
  assert.equal(item.size_in_bytes, PRODUCER.size); assert.equal(item.digest, `sha256:${PRODUCER.sha256}`);
  for (const [key, value] of Object.entries({ id: PRODUCER.run, head_sha: PRODUCER.source,
    repository_id: 1364807512, head_repository_id: 1364807512 })) assert.equal(item.workflow_run[key], value);
}

// Standard ZIP/TAR readers, fixed outputs only; no archive-controlled extraction paths.
const ZIP_STAGE = String.raw`
import hashlib,json,os,stat,sys,zipfile
from pathlib import Path
source,output=map(Path,sys.argv[1:]); pins=json.load(sys.stdin)
with zipfile.ZipFile(source) as z:
    entries=z.infolist(); assert 0<len(entries)<=64 and sum(e.file_size for e in entries)<=768*1024*1024
    names=set()
    for e in entries:
        name=e.filename
        assert name not in names and '\\' not in name and ':' not in name and not name.startswith('/')
        assert all(p not in ('','.','..') for p in name.rstrip('/').split('/'))
        assert stat.S_IFMT(e.external_attr>>16) in (0,stat.S_IFREG,stat.S_IFDIR)
        assert 0<=e.file_size<=256*1024*1024 and not e.flag_bits&1
        names.add(name)
    assert set(pins)<=names
    output.mkdir(mode=0o700)
    for name,pin in pins.items():
        assert name in ('creator-hub','modules.tar.gz','builtin-manifest.json')
        e=z.getinfo(name); assert not e.is_dir() and e.file_size==pin['size']
        data=z.read(e); assert len(data)==pin['size'] and hashlib.sha256(data).hexdigest()==pin['sha256']
        with (output/name).open('xb') as stream: stream.write(data)
        os.chmod(output/name,0o755 if name=='creator-hub' else 0o644)
`;
const MODULE_CHECK = String.raw`
import hashlib,json,sys,tarfile
m=json.load(sys.stdin); binding=m['payloadArchive']; pins={**m['modules']['mcp']['files'],**m['modules']['setup']['files'],**m['managedRouting']['files']}
found={}; total=0
with tarfile.open(sys.argv[1],mode='r|gz') as t:
    for item in t:
        assert len(found)<32 and item.name in pins and item.name not in found
        pin=binding['files'][item.name]
        assert item.isfile() and item.type==tarfile.REGTYPE and not item.pax_headers
        assert item.size==pin['size'] and item.mode==pin['mode'] and item.uid==item.gid==0
        assert 0<=item.size<=256*1024*1024
        total+=item.size; assert total<=512*1024*1024
        digest=hashlib.sha256(); count=0
        with t.extractfile(item) as f:
            for block in iter(lambda:f.read(65536),b''):
                count+=len(block); assert count<=item.size; digest.update(block)
        assert count==item.size and digest.hexdigest()==pins[item.name]
        found[item.name]=digest.hexdigest()
assert set(found)==set(pins) and total==binding['unpackedSize']
print(json.dumps({'files':found}))
`;

function read(file, limit) {
  const before = capture(file, limit), bytes = finite.read(file, limit);
  assert.deepEqual({ size: bytes.length, sha256: hash(bytes) }, before);
  assert.deepEqual(capture(file, limit), before);
  return bytes;
}
function exact(file, pin) {
  const bytes = read(file, pin.size);
  assert.deepEqual({ size: bytes.length, sha256: hash(bytes) }, pin, 'Frozen input changed');
  return bytes;
}
function inputs(directory) {
  const bytes = Object.fromEntries(Object.entries(INPUTS).map(([name, pin]) => [name, exact(path.join(directory, name), pin)]));
  const manifest = JSON.parse(bytes['builtin-manifest.json']);
  finite.validateDescriptor(manifest); archive.validateBinding(manifest);
  assert.deepEqual({ size: manifest.payloadArchive.size, sha256: manifest.payloadArchive.sha256 }, INPUTS['modules.tar.gz']);
  finite.validateElf(bytes['creator-hub']);
  assert.ok(bytes['creator-hub'].includes(bytes['builtin-manifest.json']), 'Compiled manifest differs');
  marker(bytes['creator-hub']);
  return { bytes, manifest };
}
function marker(raw) {
  const token = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK'), at = raw.indexOf(token);
  assert.ok(at >= 0 && raw.indexOf(token, at + 1) === -1, 'Exactly one raw Tauri marker required');
  return at;
}
function overlay(payload) {
  return { version: '0.1.14', build: { beforeBundleCommand: null }, bundle: { active: true,
    targets: ['appimage'], createUpdaterArtifacts: false, externalBin: [],
    resources: { [payload]: 'modules.tar.gz' }, linux: { appimage: { files: {}, bundleMediaFramework: false } } } };
}
function bundleArgs(root, config) {
  return [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'bundle', '--ci', '--no-sign',
    '--bundles', 'appimage', '--target', TARGET, '--features', FEATURES, '--config', config];
}
function moduleCheck(file, manifest, run) {
  const result = JSON.parse(run('python3', ['-B', '-c', MODULE_CHECK, file], { input: JSON.stringify(manifest), maxBuffer: 65536 }));
  assert.deepEqual(result, { files: archive.rawFiles(manifest) });
  return result.files;
}
function inventory(root) {
  const result = {}; let total = 0, count = 0;
  function visit(directory, prefix = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = prefix + name, file = path.join(directory, name), stat = fs.lstatSync(file);
      assert.ok(++count <= 20000 && !stat.isBlockDevice() && !stat.isCharacterDevice() && !stat.isFIFO() && !stat.isSocket());
      assert.equal(stat.mode & 0o7000, 0, 'Privileged file modes refused');
      if (stat.isSymbolicLink()) {
        const resolved = fs.realpathSync(file), rel = path.relative(root, resolved);
        assert.ok(rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel), 'AppDir link escapes package');
        result[relative] = { link: fs.readlinkSync(file), resolved: rel.split(path.sep).join('/') };
      } else if (stat.isDirectory()) visit(file, `${relative}/`);
      else {
        assert.ok(stat.isFile()); total += stat.size; assert.ok(total <= 1024 * 1024 * 1024, 'AppDir exceeds bound');
        result[relative] = { ...capture(file, 256 * 1024 * 1024), mode: stat.mode & 0o777 };
      }
    }
  }
  finite.ordinary(root); visit(root);
  assert.ok(!Object.keys(result).some(name => /(?:creator-hub-deb-retirement-helper|com\.creatorworks\.hub\.Host\.service|com\.creatorworks\.hub\.retire)/.test(name)),
    'Portable fixture must not ship the DEB helper/policy/service');
  assert.ok(!fs.existsSync(path.join(root, 'usr/lib/Creator Hub/modules')), 'Raw private ELF resources refused');
  return result;
}
function dependencies(files) {
  const requirements = {
    webkit: /(?:^|\/)libwebkit2gtk-4\.1\.so(?:\.\d+)*$/,
    javascriptCore: /(?:^|\/)libjavascriptcoregtk-4\.1\.so(?:\.\d+)*$/,
    webProcess: /\/webkit2gtk-4\.1\/WebKitWebProcess$/,
    networkProcess: /\/webkit2gtk-4\.1\/WebKitNetworkProcess$/,
    injectedBundle: /\/webkit2gtk-4\.1\/injected-bundle\/libwebkit2gtkinjectedbundle\.so$/,
  };
  return Object.fromEntries(Object.entries(requirements).map(([name, pattern]) => {
    const matches = Object.keys(files).filter(file => pattern.test(file));
    assert.ok(matches.length > 0 && matches.length <= 8, `Missing or ambiguous packaged dependency: ${name}`);
    return [name, matches];
  }));
}
function inside(file, root) {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file && fs.realpathSync(path.dirname(file)) === path.dirname(file));
  const relative = path.relative(root, file);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function packageFixture(root, zip, output, services = {}) {
  const env = services.env || process.env;
  admission(env, services.platform || process.platform, services.arch || process.arch);
  assert.equal(fs.realpathSync(root), root);
  const temp = fs.realpathSync(env.RUNNER_TEMP); inside(zip, temp); inside(output, temp);
  assert.equal(fs.existsSync(output), false, 'Fresh owned output required');
  exact(zip, { size: PRODUCER.size, sha256: PRODUCER.sha256 });
  const execute = services.execute || execFileSync;
  const git = args => String(execute('git', args, { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 65536 })).trim();
  assert.equal(git(['rev-parse', 'HEAD']), env.GITHUB_SHA);
  assert.equal(git(['status', '--porcelain=v1', '--untracked-files=normal']), '', 'Clean fixture checkout required');
  const config = JSON.parse(read(path.join(root, 'src-tauri/tauri.conf.json'), 65536));
  const npm = JSON.parse(read(path.join(root, 'package.json'), 65536));
  assert.equal(config.productName, 'Creator Hub'); assert.equal(config.version, '0.1.14');
  assert.equal(npm.version, '0.1.14'); assert.equal(npm.devDependencies['@tauri-apps/cli'], '2.11.4');
  assert.ok(!config.build.beforeBundleCommand && !config.bundle.resources && !config.bundle.externalBin);
  assert.equal(fs.existsSync(path.join(root, 'src-tauri/tauri.linux.conf.json')), false, 'Unreviewed platform overlay refused');
  fs.mkdirSync(output, { mode: 0o700 });
  const child = { PATH: env.PATH, HOME: path.join(output, 'home'), XDG_CACHE_HOME: path.join(output, 'cache'),
    XDG_CONFIG_HOME: path.join(output, 'config'), XDG_DATA_HOME: path.join(output, 'data'),
    CARGO_HOME: path.join(output, 'cargo'), RUSTUP_HOME: env.RUSTUP_HOME || path.join(env.HOME, '.rustup'),
    CARGO_TARGET_DIR: path.join(output, 'target'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', CI: 'true', NO_STRIP: '1' };
  for (const name of ['HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CARGO_HOME']) fs.mkdirSync(child[name], { mode: 0o700 });
  const run = (command, args, options = {}) => execute(command, args, { cwd: root, env: child,
    encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024, windowsHide: true, ...options });
  const receipt = { schemaVersion: 1, scope: 'frozen-integrated-appimage-packaging-dependency-smoke-only',
    fixtureSource: env.GITHUB_SHA, producer: PRODUCER, inputs: INPUTS, rootRecompiled: false,
    privatePayloadRecompiled: false, payloadResigned: false, applicationLaunched: false,
    updatePolicy: 'manual-replacement-after-closing-Hub-only; automatic portable update unimplemented',
    ...acceptance() };
  const save = () => fs.writeFileSync(path.join(output, 'fixture-receipt.json'), JSON.stringify(receipt, null, 2));
  try {
    const input = path.join(output, 'input');
    run('python3', ['-B', '-c', ZIP_STAGE, zip, input], { input: JSON.stringify(INPUTS) });
    const baseline = inputs(input); moduleCheck(path.join(input, archive.FILE), baseline.manifest, run);
    const release = path.join(child.CARGO_TARGET_DIR, TARGET, 'release'); fs.mkdirSync(release, { recursive: true });
    const binary = path.join(release, 'creator-hub'); fs.writeFileSync(binary, baseline.bytes['creator-hub'], { flag: 'wx', mode: 0o755 });
    const configFile = path.join(output, 'portable-overlay.json');
    fs.writeFileSync(configFile, JSON.stringify(overlay(path.join(input, archive.FILE)), null, 2), { flag: 'wx' });
    receipt.cliVersion = String(run(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), '--version'])).trim();
    assert.equal(receipt.cliVersion, 'tauri-cli 2.11.4');
    run(process.execPath, bundleArgs(root, configFile), { stdio: 'inherit', timeout: 900000 });
    exact(binary, INPUTS['creator-hub']);
    const bundles = path.join(release, 'bundle/appimage');
    const packages = fs.readdirSync(bundles).filter(name => name.endsWith('.AppImage'));
    assert.deepEqual(packages, ['Creator Hub_0.1.14_amd64.AppImage']);
    const image = path.join(output, packages[0]);
    fs.copyFileSync(path.join(bundles, packages[0]), image, fs.constants.COPYFILE_EXCL); fs.chmodSync(image, 0o755);
    receipt.appImage = capture(image, 512 * 1024 * 1024);
    const extracted = path.join(output, 'extracted'); unix.extract(image, 'appimage', extracted, 'Creator Hub', run);
    const appdir = path.join(extracted, 'squashfs-root'), installed = path.join(appdir, 'usr/bin/creator-hub');
    const payload = path.join(appdir, 'usr/lib/Creator Hub/modules.tar.gz');
    exact(payload, INPUTS['modules.tar.gz']);
    const after = read(installed, 64 * 1024 * 1024);
    for (const [name, file] of [['raw', path.join(input, 'creator-hub')], ['packaged', installed]]) {
      for (const [kind, args] of [['dynamic', ['--dynamic']], ['versions', ['--version-info']]]) {
        const text = String(run('/usr/bin/readelf', [...args, file], { maxBuffer: 256 * 1024 }));
        fs.writeFileSync(path.join(output, `${name}-${kind}.txt`), text, { flag: 'wx' });
      }
    }
    // Current Root links linuxdeploy's exact RUNPATH already. Do not bless new ELF rewrites.
    unix.verifyLinuxHub(baseline.bytes['creator-hub'], after, 'appimage');
    assert.ok(after.includes(baseline.bytes['builtin-manifest.json']));
    receipt.rootTransform = 'only UNK -> APP bundle marker; no other ELF change';
    const files = inventory(appdir); receipt.dependencies = dependencies(files);
    receipt.moduleFiles = moduleCheck(payload, baseline.manifest, run);
    fs.writeFileSync(path.join(output, 'appdir-inventory.json'), JSON.stringify(files, null, 2), { flag: 'wx' });
    const tools = path.join(child.XDG_CACHE_HOME, 'tauri');
    receipt.unpinnedUpstreamPackagingTools = fs.existsSync(tools) ? Object.fromEntries(fs.readdirSync(tools).sort()
      .map(name => [name, capture(path.join(tools, name), 128 * 1024 * 1024)])) : {};
    assert.ok(Object.keys(receipt.unpinnedUpstreamPackagingTools).length <= 8);
    inputs(input); exact(zip, { size: PRODUCER.size, sha256: PRODUCER.sha256 });
    assert.equal(git(['status', '--porcelain=v1', '--untracked-files=normal']), '', 'Bundling changed tracked source');
    receipt.packagingCompleted = true; save(); return receipt;
  } catch (error) {
    receipt.packagingCompleted = false; receipt.error = String(error.message).slice(0, 2000); save(); throw error;
  }
}

module.exports = { BRANCH, FEATURES, TARGET, PRODUCER, INPUTS, ZIP_STAGE, MODULE_CHECK, acceptance, admission,
  verifyProducer, read, exact, inputs, marker, overlay, bundleArgs, moduleCheck, inventory, dependencies, packageFixture };
if (require.main === module) {
  assert.equal(process.argv.length, 5, 'Use ROOT EXACT_PRODUCER_ZIP NEW_RUNNER_TEMP_OUTPUT');
  console.log(JSON.stringify(packageFixture(...process.argv.slice(2))));
}
