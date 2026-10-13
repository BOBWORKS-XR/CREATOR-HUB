const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');

const SOURCE = '288d3d60a8108d6ff41729b63705af3598721f60';
const MERGE = 'da87dfb1f815653f23737a98766b5eaa8a525dc4';
const PINS = Object.freeze({
  appimage: Object.freeze({ name: 'Creator Hub_0.1.13_amd64.AppImage', sha256: '967cf1a0c0b0d6de7a5b15152da3f5cc2bb70c7d8ab8cdd06d6590d6b5e96d0e', bytes: 85768696,
    oldName: 'Creator.Hub_0.1.12_amd64.AppImage', oldSha256: 'b2d161cc9fc98522d25a11d1c649994fed591c07a2d0ad3e89976fe985f454c4' }),
  deb: Object.freeze({ name: 'Creator Hub_0.1.13_amd64.deb', sha256: 'b95d71ab62ae75b38d2e653eee3d21eacba4869027d2c1fa01495065c429b3e0', bytes: 6004284,
    oldName: 'Creator.Hub_0.1.12_amd64.deb', oldSha256: 'a1d20fb23544356d90ab2314b6d430b274220e97d9129815eea731ac39c7ffd2' }),
});
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function runner(env = process.env, platform = process.platform, arch = process.arch) {
  assert.ok(platform === 'linux' && arch === 'x64' && env.GITHUB_ACTIONS === 'true'
    && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.RUNNER_OS === 'Linux', 'Disposable GitHub-hosted Linux x86_64 runner required');
}
function regular(file) {
  assert.ok(path.isAbsolute(file), 'Absolute file path required');
  for (let item = file; ; item = path.dirname(item)) {
    assert.equal(fs.lstatSync(item).isSymbolicLink(), false, 'Linked file ancestry refused');
    if (item === path.dirname(item)) break;
  }
  assert.ok(fs.statSync(file).isFile(), 'Regular file required');
}
function candidate(file, kind) {
  assert.ok(Object.hasOwn(PINS, kind), 'Unsupported native test package');
  regular(file);
  const pin = PINS[kind];
  assert.equal(path.basename(file), pin.name);
  assert.equal(fs.statSync(file).size, pin.bytes);
  assert.equal(hash(file), pin.sha256, 'Exact reviewed native CI artifact required');
  return pin;
}
function command(exe, args, extra = {}) {
  return execFileSync(exe, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, ...extra });
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function retry(action, seconds = 40) {
  let last;
  for (const end = Date.now() + seconds * 1000; Date.now() < end;) {
    try { return await action(); } catch (error) { last = error; await delay(500); }
  }
  throw last;
}
function protection(root) {
  const files = ['data/CreatorHub/adoptions-lab.json', 'config/creator-works-mcp/launcher-config.json',
    'config/creator-project-setup/native-flow-sentinel.json', 'project-unmanaged/README.txt', 'data/ai-client-lab-sentinel.json'];
  return files.map((name, index) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ synthetic: true, marker: index }), { flag: 'wx' });
    return { file, sha256: hash(file) };
  });
}
function unchanged(files) { for (const file of files) assert.equal(hash(file.file), file.sha256, 'Protected synthetic data changed'); }
function manualImage(source, target, expectedOld = null) {
  regular(source);
  if (expectedOld === null) {
    assert.equal(fs.existsSync(target), false);
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  } else {
    regular(target);
    assert.equal(hash(target), expectedOld, 'Installed old AppImage changed before upgrade');
    const backup = `${target}.before-update`;
    fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    assert.equal(hash(backup), expectedOld);
    const staged = `${target}.new`;
    fs.copyFileSync(source, staged, fs.constants.COPYFILE_EXCL);
    assert.equal(hash(staged), hash(source));
    assert.equal(hash(target), expectedOld, 'Old AppImage changed during staging');
    fs.renameSync(staged, target);
    assert.equal(hash(backup), expectedOld, 'Old package backup was not preserved');
  }
  assert.equal(hash(target), hash(source));
  fs.chmodSync(target, 0o755);
  return target;
}
function image(file, output) {
  const root = fs.mkdtempSync(path.join(output, 'appimage-extract-'));
  fs.chmodSync(file, 0o755);
  command(file, ['--appimage-extract'], { cwd: root });
  const exe = path.join(root, 'squashfs-root/usr/bin/creator-hub');
  regular(exe);
  return { exe, sha256: hash(exe) };
}
function deb(file, version, output) {
  assert.equal(command('dpkg-deb', ['--show', '--showformat=${Package}\n${Version}\n${Architecture}\n', file]), `creator-hub\n${version}\namd64\n`);
  const root = fs.mkdtempSync(path.join(output, 'deb-extract-'));
  command('dpkg-deb', ['--extract', file, root]);
  const exe = path.join(root, 'usr/bin/creator-hub');
  regular(exe);
  command('sudo', ['dpkg', '--install', file]);
  assert.equal(hash('/usr/bin/creator-hub'), hash(exe), 'Actual installed executable differs');
  return { exe: '/usr/bin/creator-hub', sha256: hash(exe) };
}
async function closeOwned(child, expected, window, operations = {}) {
  const fingerprint = operations.hash || hash;
  const request = operations.command || command;
  const pause = operations.delay || delay;
  await retry(async () => {
    if (child.exitCode !== null) {
      assert.equal(child.exitCode, 0, 'Owned GUI crashed before normal close');
      return;
    }
    assert.equal(fingerprint(`/proc/${child.pid}/exe`), expected, 'Owned process identity changed before close');
    const id = window();
    request('wmctrl', ['-ic', `0x${Number(id).toString(16)}`]);
    await pause(500);
    assert.equal(child.exitCode, 0, 'Normal close has not completed');
  }, operations.seconds ?? 10);
}
async function gui(file, expected, version, profile, output, freshTerms) {
  const env = { ...process.env, HOME: path.join(profile, 'home'), XDG_DATA_HOME: path.join(profile, 'data'),
    XDG_CONFIG_HOME: path.join(profile, 'config'), XDG_CACHE_HOME: path.join(profile, 'cache'),
    CREATOR_SYNTHETIC_TERMS_TEST: '1', GTK_A11Y: 'always', NO_AT_BRIDGE: '0' };
  for (const dir of [env.HOME, env.XDG_DATA_HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME]) fs.mkdirSync(dir, { recursive: true });
  const log = fs.openSync(path.join(output, `gui-${version}.log`), 'wx');
  const child = spawn(file, [], { env, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  let launchError, failure;
  child.on('error', error => { launchError = error; });
  const probe = action => JSON.parse(command('/usr/bin/python3', [path.join(__dirname, 'native-linux-window.py'), action, String(child.pid), expected], { env }));
  const text = snapshot => snapshot.nodes.filter(node => node.showing).map(node => `${node.name} ${node.text}`).join('\n');
  const window = () => {
    const ids = command('xdotool', ['search', '--onlyvisible', '--pid', String(child.pid)]).trim().split('\n').filter(Boolean);
    assert.equal(ids.length, 1, 'Expected one owned visible window');
    assert.match(ids[0], /^[1-9][0-9]*$/, 'Invalid owned window ID');
    return ids[0];
  };
  try {
  const ownedWindow = await retry(window);
  assert.equal(hash(`/proc/${child.pid}/exe`), expected);
  fs.writeFileSync(path.join(output, `mountinfo-${version}.txt`), fs.readFileSync(`/proc/${child.pid}/mountinfo`));
  if (fs.existsSync(`/proc/${child.pid}/fdinfo/1023`)) {
    fs.writeFileSync(path.join(output, `runtime-dir-fdinfo-${version}.txt`), fs.readFileSync(`/proc/${child.pid}/fdinfo/1023`));
  }
  command('xdotool', ['windowsize', ownedWindow, '1100', '860']);
  const snapshot = await retry(() => {
    assert.equal(launchError, undefined, 'Owned GUI failed to launch');
    assert.equal(child.exitCode, null);
    const current = probe('snapshot');
    if (freshTerms) assert.match(text(current), /Terms of use and risk acknowledgement/);
    return current;
  });
  if (freshTerms) {
    assert.match(text(snapshot), /Terms of use and risk acknowledgement/);
    probe('test-terms-checkbox');
    await retry(() => probe('test-terms-accept'));
  }
  const ready = await retry(() => {
    const current = probe('snapshot');
    fs.writeFileSync(path.join(output, `last-accessibility-${version}.json`), JSON.stringify(current, null, 2));
    assert.doesNotMatch(text(current), /Terms of use and risk acknowledgement/, 'Terms gate is still visible');
    assert.match(text(current), /Creator Works MCP/);
    assert.match(text(current), new RegExp(version.replaceAll('.', '\\.')));
    return current;
  });
  fs.writeFileSync(path.join(output, `accessibility-${version}.json`), JSON.stringify(ready, null, 2), { flag: 'wx' });
  const id = await retry(window);
  const screenshot = path.join(output, `gui-${version}.png`);
  command('import', ['-window', id, screenshot]);
  const pixels = JSON.parse(command('/usr/bin/python3', ['-c',
    'import json,sys;from PIL import Image;im=Image.open(sys.argv[1]).convert("RGB");im=im.crop((0,32,im.width,im.height-32));colors=im.getcolors(im.width*im.height);print(json.dumps({"width":im.width,"height":im.height,"colors":len(colors),"foreground":im.width*im.height-max(c[0] for c in colors)}))', screenshot]));
  assert.ok(pixels.width >= 560 && pixels.height >= 400 && pixels.colors > 32 && pixels.foreground > 1000, 'Native window content is blank or incorrectly framed');
  await closeOwned(child, expected, window);
  return { pid: child.pid, exitCode: child.exitCode, executableSha256: expected, pixels, terms: freshTerms ? 'synthetic-acknowledgement-only' : 'persisted-test-acknowledgement' };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (failure && !launchError && child.exitCode === null) {
      try {
        assert.equal(hash(`/proc/${child.pid}/exe`), expected);
        command('import', ['-window', window(), path.join(output, `failed-gui-${version}.png`)]);
      } catch (error) { failure.message += `; failure capture unavailable: ${error.message}`; }
    }
    // Close only the fingerprinted owned window, including when capture fails.
    try { if (!launchError) await closeOwned(child, expected, window); }
    catch (error) {
      if (failure) failure.message += `; normal owned cleanup failed: ${error.message}`;
      else throw error;
    }
  }
}
async function main() {
  runner();
  assert.equal(process.argv.length, 5, 'Use KIND CANDIDATE_DIRECTORY NEW_OUTPUT');
  const [kind, directory, output] = process.argv.slice(2);
  assert.ok(Object.hasOwn(PINS, kind) && path.isAbsolute(directory) && path.isAbsolute(output));
  assert.equal(fs.existsSync(output), false, 'Output must be new');
  const packageFile = path.join(directory, PINS[kind].name);
  const pin = candidate(packageFile, kind);
  fs.mkdirSync(output);
  const report = { passed: false, releaseReady: false, source: SOURCE, mergeSource: MERGE, sourceRun: '38423134520',
    kind, nativeGuiTested: false, manualUpgradeTested: false, signedUpdateTested: false,
    automaticRestartTested: false, nativeCompanionManagementTested: false, userMachineUsed: false, phases: [] };
  try {
    const fresh = path.join(output, 'fresh'); fs.mkdirSync(fresh);
    const preserved = protection(fresh);
    const installed = kind === 'appimage' ? image(packageFile, output) : deb(packageFile, '0.1.13', output);
    const freshTarget = kind === 'appimage' ? manualImage(packageFile, path.join(fresh, 'Creator-Hub.AppImage')) : installed.exe;
    report.phases.push({ phase: 'fresh-native-install', gui: await gui(freshTarget, installed.sha256, '0.1.13', fresh, output, true) });
    unchanged(preserved);
    report.nativeGuiTested = true;
    const upgrade = path.join(output, 'upgrade'); fs.mkdirSync(upgrade);
    const before = protection(upgrade);
    const old = path.join(output, pin.oldName);
    command('curl', ['--fail', '--location', '--silent', '--show-error', '--max-time', '120', '--output', old,
      `https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.12/${pin.oldName}`], { timeout: 130000 });
    assert.equal(hash(old), pin.oldSha256, 'Unmodified public 0.1.12 package differs');
    const oldInstalled = kind === 'appimage' ? image(old, output) : deb(old, '0.1.12', output);
    const oldGuiOutput = path.join(output, 'old-gui'); fs.mkdirSync(oldGuiOutput);
    const upgradeTarget = kind === 'appimage' ? manualImage(old, path.join(upgrade, 'Creator-Hub.AppImage')) : oldInstalled.exe;
    report.phases.push({ phase: 'public-012-before-upgrade', gui: await gui(upgradeTarget, oldInstalled.sha256, '0.1.12', upgrade, oldGuiOutput, true) });
    unchanged(before);
    const upgraded = kind === 'appimage' ? installed : deb(packageFile, '0.1.13', output);
    const afterGuiOutput = path.join(output, 'upgraded-gui'); fs.mkdirSync(afterGuiOutput);
    if (kind === 'appimage') manualImage(packageFile, upgradeTarget, pin.oldSha256);
    report.phases.push({ phase: 'manual-upgrade-013', gui: await gui(upgradeTarget, upgraded.sha256, '0.1.13', upgrade, afterGuiOutput, false) });
    unchanged(before);
    report.manualUpgradeTested = true;
    report.passed = true;
    console.log(JSON.stringify(report));
  } catch (error) {
    report.failure = String(error.message).slice(0, 2000);
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  }
}
module.exports = { runner, candidate, manualImage, closeOwned, hash, PINS, SOURCE, MERGE };
if (require.main === module) main().catch(error => { console.error(`Native Linux smoke failed: ${error.message}`); process.exitCode = 1; });
