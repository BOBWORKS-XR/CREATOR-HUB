const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const smoke = require('./native-linux-maintenance-smoke.cjs');
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux' };

test('native Linux install harness refuses non-disposable or wrong architecture before file access', () => {
  for (const [environment, platform, arch] of [[{}, 'linux', 'x64'], [env, 'win32', 'x64'], [env, 'linux', 'arm64'],
    [{ ...env, RUNNER_ENVIRONMENT: 'self-hosted' }, 'linux', 'x64']]) {
    assert.throws(() => smoke.runner(environment, platform, arch), /disposable/i);
  }
  smoke.runner(env, 'linux', 'x64');
  const result = spawnSync(process.execPath, [require.resolve('./native-linux-maintenance-smoke.cjs'), 'deb', '/missing', '/missing-output'], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Disposable/);
});
test('only exact separately built AppImage/DEB candidates are admitted', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-linux-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, smoke.PINS.deb.name);
  fs.writeFileSync(file, 'wrong');
  assert.throws(() => smoke.candidate(file, 'deb'));
  assert.throws(() => smoke.candidate(file, 'rpm'), /Unsupported/);
  assert.equal(smoke.SOURCE, 'cef6f60310e88349e57951a2bbe0213e86fd05e7');
  assert.ok(Object.isFrozen(smoke.PINS) && Object.values(smoke.PINS).every(Object.isFrozen));
});

function binding() {
  const b = smoke.BUILD;
  return {
    run: {id:b.runId,run_attempt:1,head_sha:smoke.SOURCE,status:'completed',conclusion:'success',event:'pull_request',
      path:'.github/workflows/ci.yml',repository:{id:b.repositoryId,full_name:b.repository},
      head_repository:{id:b.repositoryId,full_name:b.repository},
      pull_requests:[{number:22,head:{sha:smoke.SOURCE,repo:{id:b.repositoryId}},base:{repo:{id:b.repositoryId}}}]},
    artifact: {id:b.artifactId,name:`hub-development-Linux-X64-${smoke.MERGE}`,expired:false,
      size_in_bytes:b.archiveBytes,digest:`sha256:${b.archiveSha256}`,
      workflow_run:{id:b.runId,head_sha:smoke.SOURCE,repository_id:b.repositoryId,head_repository_id:b.repositoryId}},
    merge: {sha:smoke.MERGE,tree:b.tree,message:`Merge ${smoke.SOURCE} into ${b.base}`,parents:[b.base,smoke.SOURCE]},
    source: {sha:smoke.SOURCE,tree:b.tree},
    linuxJob: {name:'Hub (Linux)',status:'completed',conclusion:'success',run_id:b.runId,run_attempt:1},
  };
}

test('cef6 artifact label is the PR merge SHA, admitted only with exact head/parents/tree/attempt', () => {
  assert.notEqual(smoke.SOURCE, smoke.MERGE);
  assert.deepEqual(smoke.BUILD, {runId:38442820243,attempt:1,artifactId:11836328901,repositoryId:1364807512,
    repository:'BOBWORKS-XR/CREATOR-HUB',base:'35a16a45814d821d65b5d203628478449174cd55',
    tree:'71c584be90aba7f28b67edda1c61782972d1f760',archiveBytes:96986707,
    archiveSha256:'06f7df107a253419d9305872b90b2c166c838f6d6071912cb9683638b0d3d88f'});
  const receipt = smoke.validateBinding(binding());
  assert.equal(receipt.source, smoke.SOURCE); assert.equal(receipt.mergeSource, smoke.MERGE);
  assert.equal(receipt.archiveBytes, 96986707); assert.ok(Object.isFrozen(smoke.BUILD));
});

for (const [name, change] of [
  ['run id', b => b.run.id++], ['failed run', b => b.run.conclusion='failure'],
  ['head equals label', b => b.run.head_sha=smoke.MERGE], ['attempt', b => b.run.run_attempt=2],
  ['repository', b => b.run.repository.id++], ['fork', b => b.run.head_repository.id++],
  ['workflow', b => b.run.path='.github/workflows/other.yml'], ['PR', b => b.run.pull_requests[0].number=23],
  ['PR head repository', b => b.run.pull_requests[0].head.repo.id++],
  ['malformed live PR head', b => b.run.pull_requests[0].head.sha='invalid'], ['source', b => b.source.sha=smoke.MERGE],
  ['source tree', b => b.source.tree='0'.repeat(40)], ['merge tree', b => b.merge.tree='0'.repeat(40)],
  ['merge parents', b => b.merge.parents.reverse()], ['merge label', b => b.merge.sha=smoke.SOURCE],
  ['artifact id', b => b.artifact.id++], ['artifact name', b => b.artifact.name=`hub-development-Linux-X64-${smoke.SOURCE}`],
  ['artifact hash', b => b.artifact.digest='sha256:'+'0'.repeat(64)], ['artifact size', b => b.artifact.size_in_bytes++],
  ['expired artifact', b => b.artifact.expired=true], ['artifact source', b => b.artifact.workflow_run.head_sha=smoke.MERGE],
  ['artifact run', b => b.artifact.workflow_run.id++], ['artifact fork', b => b.artifact.workflow_run.head_repository_id++],
  ['Linux job', b => b.linuxJob.conclusion='failure'], ['Linux attempt', b => b.linuxJob.run_attempt=2],
]) {
  test(`native Linux binding refuses ${name}`, () => {
    const value = binding(); change(value); assert.throws(() => smoke.validateBinding(value));
  });
}

test('actual 38448524827 binding failure: live PR head advanced but immutable cef6 build identity did not', () => {
  // Redacted actual GET /actions/runs/38442820243 fields captured after dispatch; no token or private payload.
  const actualRun = {
    id: 38442820243, status: 'completed', conclusion: 'success', run_attempt: 1,
    head_sha: 'cef6f60310e88349e57951a2bbe0213e86fd05e7',
    repository: { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' },
    head_repository: { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' },
    pull_requests: [{ number: 22,
      head: { sha: '23f93c2e5b7089a2b2621345f44431a58205fb92', repo: { id: 1364807512 } },
      base: { repo: { id: 1364807512 } } }],
  };
  const value = binding(); Object.assign(value.run, actualRun);
  assert.notEqual(value.run.pull_requests[0].head.sha, smoke.SOURCE);
  assert.equal(smoke.validateBinding(value).source, smoke.SOURCE);
  // A mutable PR association never substitutes for any immutable source identity.
  for (const change of [b => b.run.head_sha=actualRun.pull_requests[0].head.sha,
    b => b.artifact.workflow_run.head_sha=actualRun.pull_requests[0].head.sha,
    b => b.merge.parents[1]=actualRun.pull_requests[0].head.sha,
    b => b.source.sha=actualRun.pull_requests[0].head.sha,
    b => b.source.tree='0'.repeat(40), b => b.artifact.digest='sha256:'+'0'.repeat(64)]) {
    const changed = structuredClone(value); change(changed); assert.throws(() => smoke.validateBinding(changed));
  }
});

test('all three downloaded package hashes are pinned without enabling an RPM runtime lane', () => {
  assert.deepEqual(Object.keys(smoke.PINS), ['appimage','deb']);
  assert.deepEqual(Object.keys(smoke.PACKAGES), ['appimage','deb','rpm']);
  for (const [kind, bytes, sha] of [
    ['appimage',85760504,'66cf009f442c87ee5666727c4559db9360afe7480ace1031326b315c930d3718'],
    ['deb',5994552,'c173d83b83cbc8d04d033df76a3fe85779009992a8ae026dcf2057818c15e562'],
    ['rpm',5994700,'48771bbe48acb62093d867a1833b03e52743bc592e2742686fd1fb58ece3efbe'],
  ]) {
    assert.equal(smoke.PACKAGES[kind].bytes, bytes); assert.equal(smoke.PACKAGES[kind].sha256, sha);
    assert.ok(Object.isFrozen(smoke.PACKAGES[kind]));
  }
  assert.ok(Object.isFrozen(smoke.PACKAGES));
});

test('artifact ZIP wrong length or hash cannot pass the binding gate', () => {
  assert.throws(() => smoke.validateArchive(Buffer.from('wrong')), /byte length/);
  assert.throws(() => smoke.validateArchive(Buffer.alloc(smoke.BUILD.archiveBytes)), /digest/);
});

test('binding and all-format package checks are required before any native output/install', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-binding-input-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'native-binding.json'), JSON.stringify(binding()));
  fs.mkdirSync(path.join(root,'appimage'));
  fs.writeFileSync(path.join(root,'appimage',smoke.PINS.appimage.name),'wrong');
  assert.throws(() => smoke.validateInputs(root), /byte length/);
  const bad = binding(); bad.run.id++;
  fs.writeFileSync(path.join(root,'native-binding.json'),JSON.stringify(bad));
  assert.throws(() => smoke.validateInputs(root), /binding differs/);
  const source = fs.readFileSync(require.resolve('./native-linux-maintenance-smoke.cjs'),'utf8');
  const main = source.slice(source.indexOf('async function main()'));
  assert.ok(main.indexOf('validateInputs(') < main.indexOf('fs.mkdirSync(output)'));
});

test('workflow binds and hashes the exact ZIP/packages before disposable provisioning', () => {
  const workflow = fs.readFileSync(path.join(__dirname,'../.github/workflows/linux-maintenance-validation.yml'),'utf8');
  assert.match(workflow,/validateBinding\(binding\)/); assert.match(workflow,/validateArchive\(bytes\)/);
  assert.match(workflow,/getArtifact[\s\S]*artifact_id: BUILD.artifactId/);
  assert.match(workflow,/listJobsForWorkflowRunAttempt[\s\S]*attempt_number: BUILD.attempt/);
  assert.match(workflow,/matches.length !== 1/);
  assert.match(workflow,/git diff --exit-code cef6f60310e88349e57951a2bbe0213e86fd05e7 HEAD/);
  assert.ok(workflow.indexOf('validateArchive(bytes)') < workflow.indexOf('sudo apt-get'));
  assert.ok(workflow.indexOf('validateInputs(') < workflow.indexOf('sudo apt-get'));
  assert.match(workflow,/assert len\(files\) == 3/);
  assert.match(workflow,/hashlib.sha256\(data\).hexdigest\(\) == pin\['sha256'\]/);
  assert.match(workflow,/package: \[appimage, deb\]/);
  assert.match(workflow,/artifacts\/native-input\/native-binding.json/);
  assert.doesNotMatch(workflow,/38423134520|288d3d60a8108d6ff41729b63705af3598721f60|da87dfb1f815653f23737a98766b5eaa8a525dc4|contents: write|actions: write|workflow run|release upload/);
});
test('native evidence cannot turn manual installer/GUI smoke into signed update acceptance', () => {
  const source = fs.readFileSync(require.resolve('./native-linux-maintenance-smoke.cjs'), 'utf8');
  assert.match(source, /releaseReady: false/);
  assert.match(source, /signedUpdateTested: false/);
  assert.match(source, /automaticRestartTested: false/);
  assert.match(source, /nativeCompanionManagementTested: false/);
  assert.doesNotMatch(source, /WEBKIT_DISABLE_SANDBOX|NODE_TLS_REJECT_UNAUTHORIZED|SIGKILL|pkill|killall|--no-sandbox/);
  assert.match(source, /wmctrl.*\['-ic'/);
});

test('manual AppImage upgrade replaces the installed file and preserves its exact before-image', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-manual-image-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, 'public-old'); const newer = path.join(root, 'candidate'); const installed = path.join(root, 'Hub.AppImage');
  fs.writeFileSync(old, 'old'); fs.writeFileSync(newer, 'new');
  smoke.manualImage(old, installed);
  assert.throws(() => smoke.manualImage(newer, installed));
  assert.throws(() => smoke.manualImage(newer, installed, 'a'.repeat(64)));
  smoke.manualImage(newer, installed, smoke.hash(old));
  assert.equal(fs.readFileSync(installed, 'utf8'), 'new');
  assert.equal(fs.readFileSync(`${installed}.before-update`, 'utf8'), 'old');
  assert.equal(fs.readFileSync(old, 'utf8'), 'old');
  assert.equal(fs.readFileSync(newer, 'utf8'), 'new');
});

test('crashed owned exits cannot be counted as normal close', async () => {
  await assert.rejects(smoke.closeOwned({ pid: 42, exitCode: 1 }, 'pin', () => '123', { seconds: 0.001 }), /crashed/);
  assert.deepEqual(await smoke.closeOwned({ pid: 42, exitCode: 0 }, 'pin', () => { throw Error('No window needed after normal exit'); }),
    { requested: false, exitCode: 0 });
});

test('normal close checks owned executable and requests only its window', async () => {
  const child = { pid: 42, exitCode: null };
  const calls = [];
  const receipt = await smoke.closeOwned(child, 'pin', () => '123', {
    hash: file => { calls.push(file); return 'pin'; },
    command: (exe, args) => { calls.push([exe, args]); child.exitCode = 0; },
    delay: async () => {},
  });
  assert.deepEqual(receipt, { requested: true, exitCode: 0 });
  assert.deepEqual(calls, ['/proc/42/exe', ['wmctrl', ['-ic', '0x7b']]]);
  child.exitCode = null;
  await assert.rejects(smoke.closeOwned(child, 'pin', () => '123', {
    hash: () => 'changed', command: () => assert.fail('No close authority'), seconds: 0.001,
  }), /identity changed/);
});

test('failed capture has normal owned cleanup and terms readiness is bounded', () => {
  const source = fs.readFileSync(require.resolve('./native-linux-maintenance-smoke.cjs'), 'utf8');
  assert.match(source, /finally \{[\s\S]*closeOwned\(child, expected, window, \{ identity \}\)/);
  assert.match(source, /snapshot = await retry\([\s\S]*if \(freshTerms\) assert\.match/);
  assert.match(source, /windowsize', ownedWindow, '1100', '860'/);
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/linux-maintenance-validation.yml'), 'utf8');
  assert.match(workflow, /git diff --exit-code[^\n]*\bunity\b/);
});

function checkbox(overrides = {}) {
  return { checkbox: true, name: smoke.AUTO_DOWNLOAD, showing: true, enabled: true, sensitive: true,
    checked: true, busy: false, defunct: false, mixed: false, text: '', ...overrides };
}
for (const [name, nodes] of [
  ['absent', []], ['duplicate', [checkbox(), checkbox()]], ['wrong label', [checkbox({ name: 'Download automatically' })]],
  ['wrong role', [checkbox({ checkbox: false })]], ['hidden', [checkbox({ showing: false })]],
  ['disabled hydration', [checkbox({ enabled: false, checked: false })]], ['insensitive', [checkbox({ sensitive: false })]],
  ['busy save', [checkbox({ busy: true })]], ['destroyed', [checkbox({ defunct: true })]],
  ['mixed', [checkbox({ mixed: true })]], ['unknown checked', [checkbox({ checked: undefined })]],
  ['save error', [checkbox({ checked: false }), { showing: true, name: `${smoke.AUTO_DOWNLOAD} could not be saved: failed`, text: '' }]],
  ['hydration error', [checkbox({ checked: false }), { showing: true, name: 'Saved preferences could not be verified: failed', text: '' }]],
]) {
  test(`preference observation refuses ${name}`, () => assert.throws(() => smoke.preferenceState({ nodes })));
}

test('OFF action occurs exactly once after hydrated ON, then only OFF observations are polled', async () => {
  const calls = []; let observations = 0;
  const proof = await smoke.checkPreference(action => {
    calls.push(action);
    if (action === 'test-auto-download-off') return { action: 'uncheck', actionCount: 1 };
    observations++;
    return { nodes: [checkbox({ checked: observations === 1 })] };
  }, 'set-off', async fn => fn());
  assert.deepEqual(calls, ['snapshot', 'test-auto-download-off', 'snapshot']);
  assert.equal(proof.before.checked, true); assert.equal(proof.after.checked, false);
  assert.equal(proof.storageInjected, false);
});

test('relaunch checks OFF without acting, and ON or disabled cannot falsely pass', async () => {
  const read = state => action => { assert.equal(action, 'snapshot'); return { nodes: [checkbox(state)] }; };
  const off = await smoke.checkPreference(read({ checked: false }), 'expect-off', async fn => fn());
  assert.equal(off.action, null); assert.equal(off.after.checked, false);
  await assert.rejects(smoke.checkPreference(read({ checked: true }), 'expect-off', async fn => fn()), /not retained/);
  await assert.rejects(smoke.checkPreference(read({ enabled: false, checked: false }), 'expect-off', async fn => fn()), /hydrated/);
});

test('hydration polling is read-only; refused/failed OFF delivery is never retried', async () => {
  let polls = 0, actions = 0;
  const proof = await smoke.checkPreference(action => {
    if (action !== 'snapshot') { actions++; return { action: 'uncheck', actionCount: 1 }; }
    polls++; return { nodes: [checkbox({ enabled: polls > 1, checked: polls < 3 })] };
  }, 'set-off', async fn => {
    try { return fn(); } catch { return fn(); }
  });
  assert.equal(actions, 1); assert.equal(proof.after.checked, false);
  actions = 0;
  await assert.rejects(smoke.checkPreference(action => {
    if (action === 'snapshot') return { nodes: [checkbox()] };
    actions++; throw Error('Native action delivery failed');
  }, 'set-off', async fn => fn()), /delivery failed/);
  assert.equal(actions, 1);
});

test('an already OFF fresh checkbox cannot be mislabeled as a real ON-to-OFF action', async () => {
  await assert.rejects(smoke.checkPreference(action => {
    assert.equal(action, 'snapshot'); return { nodes: [checkbox({ checked: false })] };
  }, 'set-off', async fn => fn()), /Expected ON/);
});

test('owned process start parser handles comm parentheses and rejects absent or malformed identity', () => {
  const valid = `42 (Hub (native)) S ${Array(18).fill('0').join(' ')} 12345 0`;
  assert.equal(smoke.processStart(42, () => valid), '12345');
  for (const invalid of ['', valid.replace('42 (', '43 ('), '42 (no closing', valid.replace('12345', 'invalid')]) {
    assert.throws(() => smoke.processStart(42, () => invalid));
  }
});

test('start-time drift prevents normal-close authority even when executable hash matches', async () => {
  let requests = 0;
  await assert.rejects(smoke.closeOwned({ pid: 42, exitCode: null }, 'same-image', () => '123', {
    hash: () => 'same-image', identity: () => { throw Error('Owned GUI start time changed'); },
    command: () => requests++, seconds: 0.001,
  }), /start time changed/);
  assert.equal(requests, 0);
});

test('optional native record reads only bounded three-boolean preference evidence', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-pref-record-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(smoke.nativePreferenceRecord(root), { available: false });
  const file = path.join(root, 'data/CreatorHub/preferences/hub-preferences.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { schemaVersion: 1, preview: true, autoDownload: false, restoreHostedViews: true };
  fs.writeFileSync(file, JSON.stringify(record));
  assert.deepEqual(smoke.nativePreferenceRecord(root), { available: true,
    flags: { preview: true, autoDownload: false, restoreHostedViews: true } });
  for (const bad of [{ ...record, autoDownload: true }, { ...record, autoDownload: 'false' },
    { ...record, schemaVersion: 2 }, { ...record, unrelated: 'never upload' }]) {
    fs.writeFileSync(file, JSON.stringify(bad)); assert.throws(() => smoke.nativePreferenceRecord(root));
  }
  fs.writeFileSync(file, ' '.repeat(2049)); assert.throws(() => smoke.nativePreferenceRecord(root), /bounds/);
});

test('AT-SPI action and process guards run without GI or a real native application in unit fixtures', () => {
  const python = String.raw`
import hashlib, importlib.util, pathlib, sys, tempfile, types
spec = importlib.util.spec_from_file_location('probe_fixture', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
names = ('SHOWING', 'ENABLED', 'SENSITIVE', 'CHECKED', 'DEFUNCT', 'BUSY', 'INDETERMINATE')
a = types.SimpleNamespace(Role=types.SimpleNamespace(CHECK_BOX='checkbox'), StateType=types.SimpleNamespace(**{k:k for k in names}))
class Node:
    def __init__(self):
        self.states = set(names[:4]); self.calls = 0; self.verb = 'uncheck'; self.actions = 1; self.accept = True; self.role = 'checkbox'; self.label = m.AUTO_DOWNLOAD
    def get_role(self): return self.role
    def get_state_set(self): return self
    def contains(self, state): return state in self.states
    def get_action_iface(self): return self
    def get_n_actions(self): return self.actions
    def get_name(self, i=None): return self.label if i is None else self.verb
    def do_action(self, i):
        assert i == 0
        self.calls += 1
        return self.accept
faults = ('success', 'disabled', 'insensitive', 'unchecked', 'hidden', 'busy', 'defunct', 'mixed', 'duplicate', 'wrong-label', 'wrong-role', 'wrong-action', 'multiple-actions', 'refused', 'pre-drift', 'post-drift', 'pre-state-drift', 'pre-name-drift')
for fault in faults:
    n = Node(); label = m.AUTO_DOWNLOAD; checks = [0]
    for f, state in (('disabled','ENABLED'),('insensitive','SENSITIVE'),('unchecked','CHECKED'),('hidden','SHOWING')):
        if fault == f: n.states.remove(state)
    for f, state in (('busy','BUSY'),('defunct','DEFUNCT'),('mixed','INDETERMINATE')):
        if fault == f: n.states.add(state)
    if fault == 'wrong-label': label += ' another'; n.label = label
    if fault == 'wrong-role': n.role = 'button'
    if fault == 'wrong-action': n.verb = 'click'
    if fault == 'multiple-actions': n.actions = 2
    if fault == 'refused': n.accept = False
    nodes = [(n,label,'')]
    if fault == 'duplicate': nodes.append((Node(),label,''))
    def identity():
        checks[0] += 1
        if (fault == 'pre-drift' and checks[0] == 1) or (fault == 'post-drift' and checks[0] == 2): raise RuntimeError('owned identity drift')
        if fault == 'pre-state-drift': n.states.remove('CHECKED')
        if fault == 'pre-name-drift': n.label += ' another'
    failed = False
    try: m.auto_download_off(nodes,a,identity)
    except RuntimeError: failed = True
    assert failed == (fault != 'success'), fault
    assert n.calls == (1 if fault in ('success','refused','post-drift') else 0), fault
with tempfile.TemporaryDirectory() as root:
    root = pathlib.Path(root); p = root/'42'; p.mkdir()
    raw = '42 (Hub (native)) S ' + '0 '*18 + '12345 0'
    (p/'stat').write_text(raw); (p/'exe').write_bytes(b'owned')
    sha = hashlib.sha256(b'owned').hexdigest()
    m.verify_process(42,sha,'12345',root)
    for field, value in (('stat',raw.replace('12345','12346').encode()),('exe',b'different')):
        (p/'stat').write_text(raw); (p/'exe').write_bytes(b'owned'); (p/field).write_bytes(value)
        try: m.verify_process(42,sha,'12345',root)
        except RuntimeError: pass
        else: raise AssertionError('identity drift accepted')
print('18 action cases and 3 process identity cases passed')
`;
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', python,
    path.join(__dirname, 'native-linux-window.py')], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /18 action cases/);
});

test('fresh, public12 and upgraded profiles require OFF normal-exit relaunch proof with separate capture dirs', () => {
  const source = fs.readFileSync(require.resolve('./native-linux-maintenance-smoke.cjs'), 'utf8');
  const helper = fs.readFileSync(path.join(__dirname,'native-linux-window.py'),'utf8');
  const workflow = fs.readFileSync(path.join(__dirname,'../.github/workflows/linux-maintenance-validation.yml'),'utf8');
  for (const directory of ['fresh-relaunch','old-relaunch','upgraded-relaunch']) {
    assert.ok(source.includes(`'${directory}'`)); assert.ok(workflow.includes(`/${directory}/*.json`));
    assert.ok(workflow.includes(`/${directory}/*.png`));
  }
  assert.match(source, /preferencePersistenceTested: false/);
  assert.ok(source.indexOf("phase: 'upgraded-off-normal-relaunch'") < source.indexOf('report.preferencePersistenceTested = true'));
  assert.match(source, /expected, startTime\], \{ env \}/);
  assert.match(source, /await closeOwned\(child, expected, window, \{ identity \}\);[\s\S]*closed.requested, true[\s\S]*nativePreferenceRecord\(profile\)/);
  assert.match(helper, /identity_check\(\)[\s\S]*interface.do_action\(0\)[\s\S]*identity_check\(\)/);
  assert.doesNotMatch(helper, /set_text|grab_focus|mouse|xdotool|storage|do_action\(.*\).*for/);
});
