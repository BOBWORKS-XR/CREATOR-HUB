const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');

const SOURCE = 'cef6f60310e88349e57951a2bbe0213e86fd05e7';
const MERGE = 'dcbd0f8c84bd3ab5d6b463972f7701c5e3541a2e';
const BUILD = Object.freeze({ runId: 38442820243, attempt: 1, artifactId: 11836328901,
  repositoryId: 1364807512, repository: 'BOBWORKS-XR/CREATOR-HUB',
  base: '35a16a45814d821d65b5d203628478449174cd55', tree: '71c584be90aba7f28b67edda1c61782972d1f760',
  archiveBytes: 96986707, archiveSha256: '06f7df107a253419d9305872b90b2c166c838f6d6071912cb9683638b0d3d88f' });
const PINS = Object.freeze({
  appimage: Object.freeze({ name: 'Creator Hub_0.1.13_amd64.AppImage', sha256: '66cf009f442c87ee5666727c4559db9360afe7480ace1031326b315c930d3718', bytes: 85760504,
    oldName: 'Creator.Hub_0.1.12_amd64.AppImage', oldSha256: 'b2d161cc9fc98522d25a11d1c649994fed591c07a2d0ad3e89976fe985f454c4' }),
  deb: Object.freeze({ name: 'Creator Hub_0.1.13_amd64.deb', sha256: 'c173d83b83cbc8d04d033df76a3fe85779009992a8ae026dcf2057818c15e562', bytes: 5994552,
    oldName: 'Creator.Hub_0.1.12_amd64.deb', oldSha256: 'a1d20fb23544356d90ab2314b6d430b274220e97d9129815eea731ac39c7ffd2' }),
});
const PACKAGES = Object.freeze({ ...PINS,
  rpm: Object.freeze({ name: 'Creator Hub-0.1.13-1.x86_64.rpm', bytes: 5994700,
    sha256: '48771bbe48acb62093d867a1833b03e52743bc592e2742686fd1fb58ece3efbe' }) });
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function validateBinding(binding) {
  const { run: r, artifact: a, merge: m, source: s, linuxJob: j } = binding;
  assert.ok(r.id === BUILD.runId && r.run_attempt === BUILD.attempt && r.head_sha === SOURCE
    && r.status === 'completed' && r.conclusion === 'success' && r.event === 'pull_request'
    && r.path === '.github/workflows/ci.yml' && r.repository.id === BUILD.repositoryId
    && r.repository.full_name === BUILD.repository && r.head_repository.id === BUILD.repositoryId
    && r.head_repository.full_name === BUILD.repository, 'Native run/source/repository/attempt binding differs');
  // The run API's nested PR head follows the live PR; immutable run/artifact/merge source checks bind the built bytes.
  assert.ok(r.pull_requests.some(p => p.number === 22 && /^[a-f0-9]{40}$/.test(p.head.sha)
    && p.head.repo.id === BUILD.repositoryId && p.base.repo.id === BUILD.repositoryId), 'Native PR22 binding differs');
  assert.ok(s.sha === SOURCE && s.tree === BUILD.tree && m.sha === MERGE && m.tree === BUILD.tree
    && m.message === `Merge ${SOURCE} into ${BUILD.base}`, 'Native source/merge tree binding differs');
  assert.deepEqual(m.parents, [BUILD.base, SOURCE], 'Native PR merge parents differ');
  assert.ok(a.id === BUILD.artifactId && a.name === `hub-development-Linux-X64-${MERGE}`
    && a.expired === false && a.size_in_bytes === BUILD.archiveBytes && a.digest === `sha256:${BUILD.archiveSha256}`
    && a.workflow_run.id === BUILD.runId && a.workflow_run.head_sha === SOURCE
    && a.workflow_run.repository_id === BUILD.repositoryId && a.workflow_run.head_repository_id === BUILD.repositoryId,
  'Native immutable artifact/run/source/digest/size binding differs');
  assert.ok(j.name === 'Hub (Linux)' && j.status === 'completed' && j.conclusion === 'success'
    && j.run_id === BUILD.runId && j.run_attempt === BUILD.attempt, 'Native Linux job attempt differs');
  return { source: SOURCE, mergeSource: MERGE, sourceTree: BUILD.tree, sourceRun: BUILD.runId,
    runAttempt: BUILD.attempt, artifactId: BUILD.artifactId, archiveSha256: BUILD.archiveSha256, archiveBytes: BUILD.archiveBytes };
}
function validateArchive(bytes) {
  assert.equal(bytes.length, BUILD.archiveBytes, 'Native artifact ZIP byte length differs');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), BUILD.archiveSha256, 'Native artifact ZIP digest differs');
}
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
function validateInputs(directory) {
  const bindingFile = path.join(directory, 'native-binding.json'); regular(bindingFile);
  assert.ok(fs.statSync(bindingFile).size <= 16384, 'Native binding receipt exceeds limit');
  const binding = validateBinding(JSON.parse(fs.readFileSync(bindingFile, 'utf8')));
  for (const [kind, pin] of Object.entries(PACKAGES)) {
    const file = path.join(directory, kind, pin.name); regular(file);
    assert.equal(fs.statSync(file).size, pin.bytes, `Exact ${kind} byte length differs`);
    assert.equal(hash(file), pin.sha256, `Exact ${kind} SHA256 differs`);
  }
  return { ...binding, packages: PACKAGES, rpmInstalledOrRun: false };
}
function command(exe, args, extra = {}) {
  return execFileSync(exe, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, ...extra });
}
const AUTO_DOWNLOAD = 'Download verified updates automatically';
function processStart(pid, read = file => fs.readFileSync(file, 'utf8')) {
  const stat = read(`/proc/${pid}/stat`);
  assert.ok(stat.length < 4096 && stat.startsWith(`${pid} (`), 'Invalid owned process stat');
  assert.ok(stat.lastIndexOf(')') > stat.indexOf('('), 'Invalid owned process command field');
  const start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
  assert.match(start || '', /^[0-9]+$/, 'Invalid owned process start time');
  return start;
}
function preferenceState(snapshot) {
  const messages = [`${AUTO_DOWNLOAD} could not be saved:`, 'Saved preferences could not be verified:', 'This preference could not be saved:'];
  assert.ok(!snapshot.nodes.some(n => n.showing && messages.some(m => `${n.name} ${n.text}`.includes(m))), 'Native preference hydration/save error is visible');
  const matches = snapshot.nodes.filter(n => n.checkbox === true && n.name === AUTO_DOWNLOAD && n.showing === true);
  assert.equal(matches.length, 1, 'Expected one exact visible auto-download checkbox');
  const n = matches[0];
  assert.ok(n.enabled === true && n.sensitive === true && n.busy === false && n.defunct === false && n.mixed === false,
    'Auto-download checkbox is not hydrated/enabled/actionable');
  assert.equal(typeof n.checked, 'boolean', 'Auto-download checked state is unavailable');
  return { name: n.name, checked: n.checked, enabled: true, sensitive: true };
}
async function checkPreference(probe, mode, poll = retry) {
  assert.ok(['set-off', 'expect-off'].includes(mode), 'Unknown preference regression mode');
  const before = await poll(() => preferenceState(probe('snapshot')));
  let action = null;
  if (mode === 'set-off') {
    assert.equal(before.checked, true, 'Expected ON before the real OFF action');
    action = probe('test-auto-download-off'); // Never retry an action whose delivery may already have succeeded.
    assert.equal(action.actionCount, 1); assert.equal(action.action, 'uncheck');
  }
  const after = await poll(() => {
    const current = preferenceState(probe('snapshot'));
    assert.equal(current.checked, false, 'Native auto-download OFF was not retained');
    return current;
  });
  return { mode, before, action, after, storageInjected: false };
}
function nativePreferenceRecord(profile) {
  const file = path.join(profile, 'data/CreatorHub/preferences/hub-preferences.json');
  if (!fs.existsSync(file)) return { available: false };
  regular(file); assert.ok(fs.statSync(file).size <= 2048, 'Native preference record exceeds bounds');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['autoDownload', 'preview', 'restoreHostedViews', 'schemaVersion']);
  assert.equal(saved.schemaVersion, 1);
  const flags = Object.fromEntries(['preview', 'autoDownload', 'restoreHostedViews'].map(key => {
    assert.equal(typeof saved[key], 'boolean', 'Native preference flag is invalid'); return [key, saved[key]];
  }));
  assert.equal(flags.autoDownload, false, 'Normal-exit native record did not retain OFF');
  return { available: true, flags };
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
  let requested = false;
  await retry(async () => {
    if (child.exitCode !== null) {
      assert.equal(child.exitCode, 0, 'Owned GUI crashed before normal close');
      return;
    }
    assert.equal(fingerprint(`/proc/${child.pid}/exe`), expected, 'Owned process identity changed before close');
    operations.identity?.();
    const id = window();
    operations.identity?.();
    request('wmctrl', ['-ic', `0x${Number(id).toString(16)}`]);
    requested = true;
    await pause(500);
    assert.equal(child.exitCode, 0, 'Normal close has not completed');
  }, operations.seconds ?? 10);
  return { requested, exitCode: child.exitCode };
}
async function gui(file, expected, version, profile, output, freshTerms, preferenceMode) {
  const env = { ...process.env, HOME: path.join(profile, 'home'), XDG_DATA_HOME: path.join(profile, 'data'),
    XDG_CONFIG_HOME: path.join(profile, 'config'), XDG_CACHE_HOME: path.join(profile, 'cache'),
    CREATOR_SYNTHETIC_TERMS_TEST: '1', CREATOR_NATIVE_PREFERENCES_TEST: '1', GTK_A11Y: 'always', NO_AT_BRIDGE: '0' };
  for (const dir of [env.HOME, env.XDG_DATA_HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME]) fs.mkdirSync(dir, { recursive: true });
  const log = fs.openSync(path.join(output, `gui-${version}.log`), 'wx');
  const child = spawn(file, [], { env, stdio: ['ignore', log, log] });
  fs.closeSync(log);
  let launchError, failure;
  child.on('error', error => { launchError = error; });
  let startTime;
  const identity = () => {
    assert.equal(launchError, undefined, 'Owned GUI failed to launch');
    assert.equal(child.exitCode, null, 'Owned GUI exited before observation');
    assert.equal(child.signalCode, null, 'Owned GUI was terminated before observation');
    assert.equal(processStart(child.pid), startTime, 'Owned GUI start time changed');
    assert.equal(hash(`/proc/${child.pid}/exe`), expected, 'Owned GUI executable changed');
  };
  const probe = action => {
    identity();
    const result = JSON.parse(command('/usr/bin/python3', [path.join(__dirname, 'native-linux-window.py'), action, String(child.pid), expected, startTime], { env }));
    identity(); assert.equal(result.pid, child.pid); assert.equal(result.startTime, startTime);
    if (action === 'snapshot') fs.writeFileSync(path.join(output, `last-accessibility-${version}.json`), JSON.stringify(result, null, 2));
    return result;
  };
  const text = snapshot => snapshot.nodes.filter(node => node.showing).map(node => `${node.name} ${node.text}`).join('\n');
  const window = () => {
    const ids = command('xdotool', ['search', '--onlyvisible', '--pid', String(child.pid)]).trim().split('\n').filter(Boolean);
    assert.equal(ids.length, 1, 'Expected one owned visible window');
    assert.match(ids[0], /^[1-9][0-9]*$/, 'Invalid owned window ID');
    return ids[0];
  };
  try {
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 1, 'Owned GUI did not start');
  startTime = processStart(child.pid);
  const ownedWindow = await retry(window);
  await retry(identity);
  fs.writeFileSync(path.join(output, `mountinfo-${version}.txt`), fs.readFileSync(`/proc/${child.pid}/mountinfo`));
  if (fs.existsSync(`/proc/${child.pid}/fdinfo/1023`)) {
    fs.writeFileSync(path.join(output, `runtime-dir-fdinfo-${version}.txt`), fs.readFileSync(`/proc/${child.pid}/fdinfo/1023`));
  }
  command('xdotool', ['windowsize', ownedWindow, '1100', '860']);
  identity();
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
  const preference = await checkPreference(probe, preferenceMode);
  fs.writeFileSync(path.join(output, `preference-${version}.json`), JSON.stringify(preference, null, 2), { flag: 'wx' });
  fs.writeFileSync(path.join(output, `preference-accessibility-${version}.json`), JSON.stringify(probe('snapshot'), null, 2), { flag: 'wx' });
  const id = await retry(window);
  const screenshot = path.join(output, `gui-${version}.png`);
  identity();
  command('import', ['-window', id, screenshot]);
  identity();
  const pixels = JSON.parse(command('/usr/bin/python3', ['-c',
    'import json,sys;from PIL import Image;im=Image.open(sys.argv[1]).convert("RGB");im=im.crop((0,32,im.width,im.height-32));colors=im.getcolors(im.width*im.height);print(json.dumps({"width":im.width,"height":im.height,"colors":len(colors),"foreground":im.width*im.height-max(c[0] for c in colors)}))', screenshot]));
  assert.ok(pixels.width >= 560 && pixels.height >= 400 && pixels.colors > 32 && pixels.foreground > 1000, 'Native window content is blank or incorrectly framed');
  const closed = await closeOwned(child, expected, window, { identity });
  assert.equal(closed.requested, true, 'Normal owned window close was not requested');
  preference.normalExitCode = closed.exitCode;
  preference.normalCloseRequested = closed.requested;
  preference.nativeRecordAfterExit = nativePreferenceRecord(profile);
  fs.writeFileSync(path.join(output, `preference-${version}.json`), JSON.stringify(preference, null, 2));
  return { pid: child.pid, startTime, exitCode: child.exitCode, executableSha256: expected, pixels, preference,
    terms: freshTerms ? 'synthetic-acknowledgement-only' : 'persisted-test-acknowledgement' };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (failure && !launchError && child.exitCode === null) {
      try {
        identity();
        command('import', ['-window', window(), path.join(output, `failed-gui-${version}.png`)]);
      } catch (error) { failure.message += `; failure capture unavailable: ${error.message}`; }
    }
    // Close only the fingerprinted owned window, including when capture fails.
    try { if (!launchError) await closeOwned(child, expected, window, { identity }); }
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
  const binding = validateInputs(path.resolve(directory, '..'));
  fs.mkdirSync(output);
  const report = { passed: false, releaseReady: false, ...binding,
    kind, nativeGuiTested: false, manualUpgradeTested: false, signedUpdateTested: false,
    automaticRestartTested: false, preferencePersistenceTested: false,
    nativeCompanionManagementTested: false, userMachineUsed: false, phases: [] };
  try {
    const fresh = path.join(output, 'fresh'); fs.mkdirSync(fresh);
    const preserved = protection(fresh);
    const installed = kind === 'appimage' ? image(packageFile, output) : deb(packageFile, '0.1.13', output);
    const freshTarget = kind === 'appimage' ? manualImage(packageFile, path.join(fresh, 'Creator-Hub.AppImage')) : installed.exe;
    report.phases.push({ phase: 'fresh-native-install', gui: await gui(freshTarget, installed.sha256, '0.1.13', fresh, output, true, 'set-off') });
    const freshRelaunch = path.join(output, 'fresh-relaunch'); fs.mkdirSync(freshRelaunch);
    report.phases.push({ phase: 'fresh-off-normal-relaunch', gui: await gui(freshTarget, installed.sha256, '0.1.13', fresh, freshRelaunch, false, 'expect-off') });
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
    report.phases.push({ phase: 'public-012-before-upgrade', gui: await gui(upgradeTarget, oldInstalled.sha256, '0.1.12', upgrade, oldGuiOutput, true, 'set-off') });
    const oldRelaunch = path.join(output, 'old-relaunch'); fs.mkdirSync(oldRelaunch);
    report.phases.push({ phase: 'public-012-off-normal-relaunch', gui: await gui(upgradeTarget, oldInstalled.sha256, '0.1.12', upgrade, oldRelaunch, false, 'expect-off') });
    unchanged(before);
    const upgraded = kind === 'appimage' ? installed : deb(packageFile, '0.1.13', output);
    const afterGuiOutput = path.join(output, 'upgraded-gui'); fs.mkdirSync(afterGuiOutput);
    if (kind === 'appimage') manualImage(packageFile, upgradeTarget, pin.oldSha256);
    report.phases.push({ phase: 'manual-upgrade-013', gui: await gui(upgradeTarget, upgraded.sha256, '0.1.13', upgrade, afterGuiOutput, false, 'expect-off') });
    const upgradedRelaunch = path.join(output, 'upgraded-relaunch'); fs.mkdirSync(upgradedRelaunch);
    report.phases.push({ phase: 'upgraded-off-normal-relaunch', gui: await gui(upgradeTarget, upgraded.sha256, '0.1.13', upgrade, upgradedRelaunch, false, 'expect-off') });
    unchanged(before);
    report.manualUpgradeTested = true;
    report.preferencePersistenceTested = true;
    report.passed = true;
    console.log(JSON.stringify(report));
  } catch (error) {
    report.failure = String(error.message).slice(0, 2000);
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  }
}
module.exports = { runner, candidate, manualImage, closeOwned, hash, PINS, PACKAGES, SOURCE, MERGE, BUILD,
  validateBinding, validateArchive, validateInputs, processStart, preferenceState, checkPreference, nativePreferenceRecord, AUTO_DOWNLOAD };
if (require.main === module) main().catch(error => { console.error(`Native Linux smoke failed: ${error.message}`); process.exitCode = 1; });
