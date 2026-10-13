'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const { generate, sha256, FINISH_ARGS } = require('./flatpak-package.cjs');

const REPO = 'BOBWORKS-XR/CREATOR-HUB';
const ID = 'com.creatorworks.hub';
const APP = `app/${ID}/x86_64/experimental`;
const PLATFORM = 'runtime/org.gnome.Platform/x86_64/50';
const SDK = 'runtime/org.gnome.Sdk/x86_64/50';
const FIXTURE_RUNTIME = 'runtime/org.gnome.Platform/x86_64/50-validation-fixture';
const PROBE_FILES = Object.freeze(['scripts/flatpak-native-smoke.cjs', 'scripts/flatpak-native-smoke.test.cjs',
  '.github/workflows/flatpak-maintenance-validation.yml', 'docs/FLATPAK-NATIVE-VALIDATION.md']);
const REVIEWED_TEST_ONLY_FILES = Object.freeze([
  'scripts/native-linux-maintenance-smoke.cjs', 'scripts/native-linux-maintenance-smoke.test.cjs',
  'scripts/native-linux-window.py', '.github/workflows/linux-maintenance-validation.yml',
  'scripts/native-mac-maintenance-smoke.cjs', 'scripts/native-mac-maintenance-smoke.test.cjs',
  'scripts/native-mac-window.swift', '.github/workflows/mac-maintenance-validation.yml',
  'docs/MAC-MAINTENANCE-VALIDATION.md', '.github/workflows/windows-candidate.yml',
  'scripts/Test-InstalledCandidate.ps1', 'scripts/self-update-baselines.test.cjs',
]);
const TREE_EXCLUSIONS = Object.freeze([...PROBE_FILES, ...REVIEWED_TEST_ONLY_FILES]);
const PHASES = ['harness-source-tree', 'binding', 'native-package', 'native-beforeimage', 'runtime', 'build-export',
  'install', 'sandbox', 'candidate-gui', 'app-update', 'fixture-gui', 'runtime-generation', 'preservation'];
const BLOCKERS = [
  { id: 'linux-companion-management', classification: 'Correct as-is',
    evidence: 'This candidate explicitly has unsupported Linux MCP/Setup management (supported:false); the GUI must finish with a clear unsupported state, not check forever. No Linux management is claimed.' },
  { id: 'trusted-native-ui-contract', classification: 'Unknown / needs capture',
    evidence: 'Main native-linux-window.py uses host PID/executable SHA and AT-SPI; its reviewed Flatpak namespace/artifact contract is not supplied. Need trusted IPC, disabled Update Hub, direct download/install refusal, rendered resources and consent. OCR is not command acceptance.' },
  { id: 'unity-host-launch', classification: 'Unknown / needs capture',
    evidence: 'No host Unity/editor/helper artifact supplied. Sandbox host-project path denial is captured; actual Unity creation/import/launch remains untested.' },
  { id: 'ai-client-and-companion-boundary', classification: 'Unknown / needs capture',
    evidence: 'No reviewed Linux AI-client/companion artifacts or host broker. No host-spawn wrapper or parent/consent relaxation is authorized.' },
  { id: 'settings-migration', classification: 'Unknown / needs capture',
    evidence: 'Native and Flatpak XDG roots are distinct. Sentinel preservation is not reviewed preference/project migration or rollback.' },
  { id: 'process-ownership', classification: 'Unknown / needs capture',
    evidence: 'Host sentinel visibility/survival is tested; real hosted backend busy/cancel/close authority is not supplied.' },
];

function requireThat(value, message) { if (!value) throw Error(message); }
function parseArgs(args) {
  const [mode, ...rest] = args;
  requireThat(['init', 'tree', 'bind', 'run', 'finalize'].includes(mode), 'Expected init, tree, bind, run or finalize');
  const options = { mode };
  const keys = new Set(['root', 'source-run', 'source-commit', 'artifact-id', 'artifact-sha256',
    'artifact-bytes', 'deb-sha256', 'deb-bytes', 'job-status']);
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].slice(2);
    requireThat(rest[i].startsWith('--') && keys.has(key) && !Object.hasOwn(options, key)
      && rest[i + 1] && !rest[i + 1].startsWith('--'), 'Invalid or duplicate argument');
    options[key] = rest[i + 1];
  }
  return options;
}

function noLinks(filename) {
  for (let item = path.resolve(filename); ; item = path.dirname(item)) {
    try { requireThat(!fs.lstatSync(item).isSymbolicLink(), 'Link/junction refused'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(item) === item) return;
  }
}

function hostedRoot(options, env = process.env, platform = process.platform, arch = process.arch) {
  requireThat(platform === 'linux' && arch === 'x64' && env.GITHUB_ACTIONS === 'true'
    && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.RUNNER_OS === 'Linux'
    && env.RUNNER_ARCH === 'X64' && env.GITHUB_REPOSITORY === REPO,
  'Only disposable GitHub-hosted Linux x86_64 in the exact repository is allowed; no PC/WSL/self-hosted installs');
  requireThat(path.isAbsolute(env.RUNNER_TEMP || '') && path.isAbsolute(options.root || ''), 'Absolute runner root required');
  const expected = path.join(env.RUNNER_TEMP, 'creator-flatpak-validation');
  requireThat(path.resolve(options.root) === expected, 'Root must be the dedicated RUNNER_TEMP directory');
  noLinks(expected);
  return expected;
}

function requestIdentity(options) {
  for (const key of ['source-run', 'artifact-id']) {
    requireThat(/^[1-9][0-9]{0,15}$/.test(options[key] || '') && Number.isSafeInteger(Number(options[key])), `Exact ${key} required`);
  }
  requireThat(/^[a-f0-9]{40}$/.test(options['source-commit'] || ''), 'Exact lowercase source commit required');
  requireThat(/^[a-f0-9]{64}$/.test(options['deb-sha256'] || ''), 'Exact reviewed DEB SHA256 required');
  requireThat(/^[a-f0-9]{64}$/.test(options['artifact-sha256'] || ''), 'Exact artifact archive SHA256 required');
  for (const key of ['artifact-bytes', 'deb-bytes']) {
    requireThat(/^[1-9][0-9]{0,8}$/.test(options[key] || '') && Number(options[key]) <= 256 * 1024 * 1024, `Bounded reviewed ${key} required`);
  }
  return { runId: Number(options['source-run']), artifactId: Number(options['artifact-id']),
    sourceCommit: options['source-commit'], artifactSha256: options['artifact-sha256'], artifactBytes: Number(options['artifact-bytes']),
    debSha256: options['deb-sha256'], debBytes: Number(options['deb-bytes']) };
}

// GitHub PR runs record the source head; CI names its artifact with github.sha (often the merge commit).
function validateBinding(binding, request) {
  const { run, artifact, commit, source, linuxJob } = binding || {};
  requireThat(run?.id === request.runId && run.repository?.full_name === REPO
    && Number.isSafeInteger(run.repository.id) && run.repository.id > 0
    && Number.isSafeInteger(run.run_attempt) && run.run_attempt >= 1
    && run.head_repository?.full_name === REPO && run.event === 'pull_request'
    && run.path === '.github/workflows/ci.yml' && run.status === 'completed' && run.conclusion === 'success'
    && run.head_sha === request.sourceCommit && run.head_branch === 'fix/hub-013-platform-flatpak'
    && run.pull_requests?.some(pr => pr.number === 22 && pr.base?.repo?.full_name === REPO), 'Run is not the requested successful PR22 CI source');
  requireThat(artifact?.id === request.artifactId && artifact.expired === false
    && artifact.size_in_bytes === request.artifactBytes
    && artifact.digest === `sha256:${request.artifactSha256}`
    && artifact.workflow_run?.id === request.runId && artifact.workflow_run.head_sha === request.sourceCommit
    && artifact.workflow_run.repository_id === run.repository.id
    && artifact.workflow_run.head_repository_id === run.repository.id, 'Artifact is not bound to that repository/run/source');
  const match = /^hub-development-Linux-X64-([a-f0-9]{40})$/.exec(artifact.name || '');
  requireThat(match && commit?.sha === match[1] && (commit.sha === request.sourceCommit
    || (commit.parents?.length === 2 && commit.parents[1].sha === request.sourceCommit
      && commit.commit?.message?.startsWith(`Merge ${request.sourceCommit} into `))), 'Artifact build commit is not the exact source or its PR merge');
  requireThat(source?.sha === request.sourceCommit && /^[a-f0-9]{40}$/.test(source.commit?.tree?.sha || '')
    && source.commit.tree.sha === commit.commit?.tree?.sha, 'PR merge tree differs from requested source tree; require separately reviewed merged inputs');
  requireThat(linuxJob?.name === 'Hub (Linux)' && linuxJob.conclusion === 'success'
    && linuxJob.run_id === request.runId && linuxJob.run_attempt === run.run_attempt, 'Requested run attempt lacks successful Linux build');
  return { repository: REPO, pr: 22, runId: run.id, runAttempt: run.run_attempt,
    sourceCommit: request.sourceCommit, sourceTree: source.commit.tree.sha, buildCommit: commit.sha, artifactId: artifact.id,
    artifactName: artifact.name, artifactDigest: artifact.digest, debSha256: request.debSha256 };
}

function readJson(file, limit = 128 * 1024) {
  noLinks(file);
  requireThat(fs.statSync(file).isFile() && fs.statSync(file).size <= limit, 'JSON evidence exceeds contract');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function initialReport(request = null) {
  return { schemaVersion: 1, experiment: 'allplatformmaintenance0.1.13-flatpak', releaseLine: 'separate-apps',
    releaseReady: false, status: 'incomplete', started: new Date().toISOString(), request,
    fixture: { artifactVersion: '0.1.13', currentSourceVersion: '0.1.13', publishable: false,
      unification: false, scope: 'same-version OSTree generation update; not new-version/update-footer proof, a GNOME upgrade or full product acceptance' },
    checks: PHASES.map(name => ({ name, status: 'pending' })), blockers: [...BLOCKERS], failures: [] };
}
function finalizeReport(report, jobStatus) {
  report.releaseReady = false;
  for (const check of report.checks) {
    if (check.status === 'pending') Object.assign(check, { status: 'blocked', reason: 'Prerequisite failed or workflow never reached this phase' });
  }
  if (jobStatus !== 'success') report.failures.push({ phase: 'workflow', message: `Workflow status: ${jobStatus}` });
  report.status = report.failures.length ? 'failed' : 'experimental-blocked';
  report.finished = new Date().toISOString();
  return report;
}

function inventorySnapshot(files) {
  return files.map(file => {
    noLinks(file);
    const stat = fs.statSync(file);
    requireThat(stat.isFile() && stat.size <= 256 * 1024 * 1024, 'Protected file must be bounded/regular');
    return { file, mode: stat.mode & 0o777, byteLength: stat.size, sha256: sha256(fs.readFileSync(file)) };
  });
}

function parsePs(text) {
  return text.trim().split('\n').filter(Boolean).map(line => {
    const [instance, application, pid, childPid] = line.trim().split(/\s+/);
    requireThat(/^[0-9]+$/.test(instance) && /^[0-9]+$/.test(pid) && /^[0-9]+$/.test(childPid), 'Unexpected flatpak ps columns');
    return { instance, application, pid: Number(pid), childPid: Number(childPid) };
  });
}

function ocrLines(tsv) {
  const groups = new Map();
  for (const row of tsv.trim().split('\n').slice(1)) {
    const c = row.split('\t');
    if (c.length < 12 || c[0] !== '5' || Number(c[10]) < 35 || !c[11].trim()) continue;
    const key = c.slice(1, 5).join(':');
    const words = groups.get(key) || [];
    words.push({ text: c[11], left: Number(c[6]), top: Number(c[7]), width: Number(c[8]), height: Number(c[9]) });
    groups.set(key, words);
  }
  return [...groups.values()].map(words => ({ text: words.map(w => w.text).join(' '),
    x: words[0].left + Math.min(words[0].width / 2, 20), y: words[0].top + words[0].height / 2 }));
}

const FIXTURE_TRANSFORM = `
import configparser, io, json, sys
data = json.load(sys.stdin)
parser = configparser.ConfigParser(interpolation=None, strict=True)
parser.optionxform = str
parser.read_string(data['metadata'])
assert parser['Application']['name'] == 'com.creatorworks.hub'
assert parser['Application']['runtime'] == 'org.gnome.Platform/x86_64/50'
parser['Application']['runtime'] = 'org.gnome.Platform/x86_64/50-validation-fixture'
output = io.StringIO()
parser.write(output, space_around_delimiters=False)
print(json.dumps({'metadata':output.getvalue(), 'xml':data['xml']}))
`;
function fixtureMetadata(metadata, xml, run = spawnSync) {
  const result = run(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', FIXTURE_TRANSFORM], {
    input: JSON.stringify({ metadata, xml }), encoding: 'utf8', timeout: 30000, maxBuffer: 128 * 1024, windowsHide: true,
  });
  requireThat(result.status === 0, 'Unexpected candidate runtime/AppStream metadata');
  return JSON.parse(result.stdout);
}

function permissionMetadata(metadata, run = spawnSync) {
  const result = run(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', `
import configparser, json, sys
p = configparser.ConfigParser(interpolation=None, strict=True)
p.optionxform = str
p.read_string(sys.stdin.read())
c = p['Context']
assert set(c) <= {'shared','sockets','devices','filesystems','features'}
for key, values in {'shared':{'ipc','network'}, 'sockets':{'wayland','fallback-x11'}, 'devices':{'dri'}}.items():
    assert set(filter(None, c.get(key,'').split(';'))) == values, key
assert not c.get('filesystems','') and not c.get('features','')
for section in ('Session Bus Policy','System Bus Policy','Environment'):
    assert not dict(p[section]) if p.has_section(section) else True, section
print(json.dumps(dict(c)))
`], { input: metadata, encoding: 'utf8', timeout: 30000, maxBuffer: 65536, windowsHide: true });
  requireThat(result.status === 0, 'Installed sandbox permissions exceed minimal GUI/network contract');
  return JSON.parse(result.stdout);
}

const EXTRACT_DEB = `
import json, os, pathlib, stat, sys, zipfile
archive, destination = sys.argv[1:]
with zipfile.ZipFile(archive) as z:
    names = set()
    debs = []
    total = 0
    assert len(z.infolist()) <= 32, 'Too many artifact entries'
    for item in z.infolist():
        name = item.orig_filename.rstrip('/')
        assert item.filename == item.orig_filename, 'Normalized artifact path refused'
        parts = name.split('/')
        assert name and not name.startswith('/') and chr(92) not in name
        assert all(p not in ('', '.', '..') for p in parts)
        assert all(32 <= ord(c) < 127 for c in name), 'Unsafe artifact path'
        assert name not in names, 'Duplicate artifact path'
        names.add(name)
        mode = item.external_attr >> 16
        assert not stat.S_ISLNK(mode) and not (mode & 0o7000), 'Artifact links/special modes refused'
        if item.is_dir():
            continue
        assert stat.S_IFMT(mode) in (0, stat.S_IFREG), 'Special artifact file'
        assert pathlib.PurePosixPath(name).suffix in ('.deb', '.rpm', '.AppImage'), 'Unexpected CI artifact file'
        assert 0 < item.file_size <= 256 * 1024 * 1024
        total += item.file_size
        assert total <= 512 * 1024 * 1024, 'Expanded artifact exceeds limit'
        if name.endswith('.deb'):
            debs.append(item)
    assert len(debs) == 1, 'Artifact requires exactly one DEB'
    os.mkdir(destination, 0o700)
    target = pathlib.Path(destination) / 'native.deb'
    with z.open(debs[0]) as source, target.open('xb') as output:
        count = 0
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            count += len(chunk)
            assert count <= debs[0].file_size
            output.write(chunk)
    assert count == debs[0].file_size
    print(json.dumps({'member':debs[0].filename, 'byteLength':count}))
`;

class Experiment {
  constructor(root, report, run = spawnSync) {
    this.root = root;
    this.report = report;
    this.run = run;
    this.evidence = path.join(root, 'evidence');
    this.home = path.join(root, 'home');
    this.userRepo = path.join(this.home, '.local/share/flatpak/repo');
    this.repo = path.join(root, 'experimental-repo');
    this.env = { PATH: process.env.PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: this.home,
      XDG_DATA_HOME: path.join(this.home, '.local/share'), XDG_CONFIG_HOME: path.join(this.home, '.config'),
      XDG_CACHE_HOME: path.join(this.home, '.cache'), XDG_RUNTIME_DIR: path.join(root, 'xdg-runtime'),
      FLATPAK_USER_DIR: path.join(this.home, '.local/share/flatpak'), FLATPAK_SYSTEM_DIR: path.join(root, 'system-flatpak'),
      GNUPGHOME: path.join(root, 'ephemeral-signing'), DISPLAY: process.env.DISPLAY,
      DEBIAN_FRONTEND: 'noninteractive',
      XAUTHORITY: process.env.XAUTHORITY, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS };
    this.commands = [];
  }
  save() { this.report.releaseReady = false; writeJson(path.join(this.evidence, 'report.json'), this.report); }
  tree() {
    const invoke = args => this.command('git', ['-C', path.resolve(__dirname, '..'), ...args]).stdout.trim();
    const head = invoke(['rev-parse', 'HEAD^{commit}']);
    requireThat(/^[a-f0-9]{40}$/.test(process.env.VALIDATION_HARNESS_COMMIT || '')
      && head === process.env.VALIDATION_HARNESS_COMMIT, 'Harness checkout is not the requested workflow head ref');
    const source = invoke(['rev-parse', `${this.report.request.sourceCommit}^{commit}`]);
    requireThat(source === this.report.request.sourceCommit, 'Fetched candidate source ref drift');
    const changed = invoke(['diff', '--no-renames', '--name-only', source, head]).split('\n').filter(Boolean);
    requireThat(changed.every(file => TREE_EXCLUSIONS.includes(file)), 'Harness HEAD changes product/packaging/runtime or unreviewed files outside the finite test-only exclusions; select matching candidate artifacts');
    requireThat(invoke(['status', '--porcelain', '--untracked-files=all']) === '', 'Harness checkout is dirty');
    return { harnessCommit: head, candidateCommit: source, sourceTree: invoke(['rev-parse', `${source}^{tree}`]),
      harnessOnlyChanges: changed, excludedPaths: TREE_EXCLUSIONS, productTreeMatches: true };
  }
  command(tool, args, { input, timeout = 120000, allowFailure = false } = {}) {
    const result = this.run(tool, args, { input, env: this.env, timeout, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    const record = { tool, args, status: result.status, signal: result.signal || null,
      error: result.error?.message, stdout: (result.stdout || '').slice(-65536), stderr: (result.stderr || '').slice(-65536) };
    this.commands.push(record);
    writeJson(path.join(this.evidence, 'commands.json'), this.commands);
    requireThat(allowFailure || (!result.error && result.status === 0), `${tool} failed (${result.status ?? result.error?.code}); see bounded commands.json`);
    return { ...record, stdout: result.stdout || '', stderr: result.stderr || '' };
  }
  flat(args, opts) { return this.command('flatpak', args, opts).stdout.trim(); }
  commit(ref) {
    const value = this.flat(['info', '--user', '--show-commit', ref]);
    requireThat(/^[a-f0-9]{64}$/.test(value), 'Invalid installed commit');
    return value;
  }
  async phase(name, fn) {
    const check = this.report.checks.find(item => item.name === name);
    try { check.evidence = await fn(); check.status = 'passed'; }
    catch (error) {
      check.status = 'failed'; check.reason = error.message;
      this.report.failures.push({ phase: name, message: error.message });
      throw error;
    } finally { this.save(); }
  }
  trust(remote) {
    const value = this.command('ostree', [`--repo=${this.userRepo}`, 'config', 'get', `remote "${remote}".gpg-verify`]).stdout.trim();
    requireThat(value === 'true', `${remote} must verify GPG commits`);
    return value;
  }
  resources() {
    const location = this.flat(['info', '--user', '--show-location', APP]);
    requireThat(location.startsWith(`${this.home}/.local/share/flatpak/app/${ID}/x86_64/experimental/`), 'Deployment outside isolated installation');
    const inventory = readJson(path.join(this.root, 'inputs/inventory.json'), 2 * 1024 * 1024);
    this.command('python3', ['-B', path.join(this.root, 'inputs/payload.py'), 'verify',
      path.join(this.root, 'inputs/inventory.json'), path.join(location, 'files')]);
    const main = inventory.entries.find(item => item.path === 'bin/creator-hub');
    requireThat(main && main.sha256 === sha256(fs.readFileSync(path.join(location, 'files/bin/creator-hub'))), 'Installed executable drift');
    return { location, executableSha256: main.sha256, entriesVerified: inventory.entries.length };
  }
  export(build, subject) {
    this.flat(['build-export', ...this.signing, `--subject=${subject}`, this.repo, build, 'experimental'], { timeout: 600000 });
    this.flat(['build-update-repo', ...this.signing, this.repo], { timeout: 600000 });
    const value = this.command('ostree', [`--repo=${this.repo}`, 'rev-parse', APP]).stdout.trim();
    requireThat(/^[a-f0-9]{64}$/.test(value), 'Invalid exported commit');
    return value;
  }
  runtimeGeneration(number) {
    this.flat(['build-commit-from', ...this.signing, '--force', '--untrusted',
      '--timestamp=NOW',
      `--src-repo=${this.userRepo}`, `--src-ref=${this.report.runtime.platformCommit}`,
      `--subject=VALIDATION ONLY identical GNOME50 content generation ${number}`,
      this.repo, FIXTURE_RUNTIME], { timeout: 600000 });
    this.flat(['build-update-repo', ...this.signing, this.repo], { timeout: 600000 });
    return this.command('ostree', [`--repo=${this.repo}`, 'rev-parse', FIXTURE_RUNTIME]).stdout.trim();
  }
  identicalRuntime(first, second) {
    const difference = this.command('ostree', [`--repo=${this.userRepo}`, 'diff', '--fs-diff', first, second]).stdout.trim();
    requireThat(difference === '', 'Fixture runtime filesystem changed; cannot claim an identical-content generation');
    return { first, second, filesystemDiffEmpty: true };
  }
  async gui(label) {
    requireThat(parsePs(this.flat(['ps', '--columns=instance,application,pid,child-pid']))
      .every(instance => instance.application !== ID), 'Existing Flatpak app instance; no capture/adoption or broad kill');
    const log = fs.openSync(path.join(this.evidence, `${label}-launch.log`), 'wx', 0o600);
    const child = spawn('flatpak', ['run', '--user', APP], { env: this.env, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    let launchError;
    child.on('error', error => { launchError = error; });
    let instance;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const capture = window => {
      const filename = path.join(this.evidence, `${label}.png`);
      this.command('import', ['-window', window, filename]);
      const tsv = this.command('tesseract', [filename, 'stdout', 'tsv']).stdout;
      const lines = ocrLines(tsv);
      fs.writeFileSync(path.join(this.evidence, `${label}-ocr.txt`), lines.map(line => line.text).join('\n'));
      return lines;
    };
    try {
      let window;
      for (let end = Date.now() + 60000; Date.now() < end;) {
        requireThat(!launchError && child.exitCode === null, `Native GUI exited before capture: ${launchError?.message || child.exitCode}`);
        const matches = parsePs(this.flat(['ps', '--columns=instance,application,pid,child-pid'])).filter(row => row.application === ID);
        requireThat(matches.length <= 1, 'Multiple experimental instances; refusing ambiguous GUI/cleanup');
        instance = matches[0];
        const windows = this.command('xdotool', ['search', '--onlyvisible', '--name', '^Creator Hub'], { allowFailure: true });
        if (instance && windows.status === 0 && /^[0-9]+\s*$/.test(windows.stdout)) { window = windows.stdout.trim(); break; }
        await sleep(500);
      }
      requireThat(window && instance, 'No unique native Creator Hub window/Flatpak instance');
      const info = this.flat(['enter', instance.instance, 'cat', '/.flatpak-info']);
      requireThat(info.includes(`name=${ID}`), 'Window capture has no matching Flatpak instance');
      fs.writeFileSync(path.join(this.evidence, `${label}-context.txt`), info);
      const windowPid = / = ([0-9]+)\s*$/.exec(this.command('xprop', ['-id', window, '_NET_WM_PID']).stdout)?.[1];
      requireThat(windowPid, 'Native window has no process identity');
      this.flat(['enter', instance.instance, 'sh', '-c', `test "$(readlink /proc/${windowPid}/exe)" = /app/bin/creator-hub`]);
      this.command('xdotool', ['windowsize', window, '1100', '1000']);
      let lines;
      for (let end = Date.now() + 30000; Date.now() < end;) {
        lines = capture(window);
        if (lines.some(line => /I have read and agree/.test(line.text))) break;
        if (lines.some(line => /Updates are managed by Flatpak/i.test(line.text))) break;
        await sleep(1000);
      }
      if (lines.some(line => /I have read and agree/.test(line.text))) {
        // Exercise the real checkbox/button. Never seed acceptance storage or inject into the WebKit page.
        for (const expression of [/I have read and agree/, /Accept and continue/]) {
          const choices = lines.filter(line => expression.test(line.text));
          requireThat(choices.length === 1, 'Consent control OCR is ambiguous; no guessed clicks');
          const choice = choices[0];
          this.command('xdotool', ['mousemove', '--window', window, String(Math.round(choice.x)), String(Math.round(choice.y)), 'click', '1']);
          await sleep(1000);
          lines = capture(window);
        }
      }
      for (let end = Date.now() + 60000; Date.now() < end;) {
        lines = capture(window);
        if (lines.some(line => /Updates are managed by Flatpak/i.test(line.text))) break;
        await sleep(2000);
      }
      const text = lines.map(line => line.text).join('\n');
      requireThat(/Creator Hub/.test(text) && /0\.1\.13/.test(text)
        && /Updates are managed by Flatpak/i.test(text) && /Native installers cannot/i.test(text), 'Native rendered identity/Flatpak updater refusal not observed');
      requireThat(/App management is not supported on Linux/i.test(text.replace(/\s+/g, ' ')), 'Linux unsupported management state not observed (no forever-checking acceptance)');
      const pixels = JSON.parse(this.command('/usr/bin/python3', ['-c',
        'from PIL import Image, ImageStat; import json,sys; im=Image.open(sys.argv[1]).convert("RGB"); s=ImageStat.Stat(im); print(json.dumps({"width":im.width,"height":im.height,"stddev":s.stddev,"colors":len(im.resize((160,120)).getcolors(19200) or [])}))',
        path.join(this.evidence, `${label}.png`)]).stdout);
      requireThat(pixels.width >= 560 && pixels.height >= 480 && pixels.colors > 50 && pixels.stddev.some(value => value > 10), 'Blank/unframed native pixels');
      return { instance, screenshot: `${label}.png`, pixels, nativeVersionObserved: '0.1.13',
        renderedFlatpakRefusal: true, directUpdaterInvocationTested: false,
        linuxManagementUnsupportedObserved: true, syntheticTermsFixture: true,
        contextFile: `${label}-context.txt`,
        resources: this.resources(), scope: 'X11 native WebKit window + OCR/pixels, not trusted IPC/full product acceptance' };
    } finally {
      if (instance) this.command('flatpak', ['kill', instance.instance], { allowFailure: true });
      if (child.exitCode === null && !launchError) {
        await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(5000)]);
        if (child.exitCode === null) child.kill('SIGTERM');
      }
      const logFile = path.join(this.evidence, `${label}-launch.log`);
      const size = fs.statSync(logFile).size;
      if (size > 65536) {
        const descriptor = fs.openSync(logFile, 'r');
        const tail = Buffer.alloc(65536);
        try { fs.readSync(descriptor, tail, 0, tail.length, size - tail.length); }
        finally { fs.closeSync(descriptor); }
        fs.writeFileSync(logFile, tail);
      }
    }
  }
  async execute() {
    hostedRoot({ root: this.root });
    const inputs = path.join(this.root, 'inputs');
    const build = path.join(this.root, 'build');
    let protectedFiles;
    let before;
    let sentinel;
    try {
      await this.phase('harness-source-tree', () => this.tree());
      await this.phase('binding', () => validateBinding(readJson(path.join(this.root, 'binding.json')), this.report.request));
      await this.phase('native-package', () => {
        const archive = path.join(this.root, 'source-artifact.zip');
        noLinks(archive);
        const binding = readJson(path.join(this.root, 'binding.json'));
        requireThat(fs.statSync(archive).isFile() && fs.statSync(archive).size === binding.artifact.size_in_bytes,
          'Archive does not match bound artifact size');
        requireThat(sha256(fs.readFileSync(archive)) === this.report.request.artifactSha256, 'Artifact archive SHA256 mismatch');
        this.report.archive = { sha256: this.report.request.artifactSha256, byteLength: binding.artifact.size_in_bytes,
          zipDigestVerified: true };
        this.command('python3', ['-B', '-c', EXTRACT_DEB, archive, path.join(this.root, 'download')]);
        const files = [];
        const visit = (directory, depth = 0) => {
          requireThat(depth <= 8, 'Artifact nesting exceeds contract');
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            requireThat(!entry.isSymbolicLink(), 'Artifact links refused');
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(file, depth + 1);
            else if (entry.name.endsWith('.deb')) files.push(file);
          }
        };
        visit(path.join(this.root, 'download'));
        requireThat(files.length === 1, 'Exact Linux artifact must contain one DEB');
        requireThat(fs.statSync(files[0]).size === this.report.request.debBytes, 'Reviewed native DEB byte length mismatch');
        return generate({ deb: files[0], sha256: this.report.request.debSha256, output: inputs });
      });
      await this.phase('native-beforeimage', () => {
        this.command('sudo', ['apt-get', 'install', '-y', '--no-install-recommends', path.join(inputs, 'native.deb')], { timeout: 600000 });
        const metadata = this.command('dpkg-query', ['-W', '-f=${Package}\n${Version}\n${Architecture}\n', 'creator-hub']).stdout;
        requireThat(metadata === 'creator-hub\n0.1.13\namd64\n', 'Installed native package drift');
        const native = this.command('dpkg-query', ['-L', 'creator-hub']).stdout.trim().split('\n')
          .filter(file => fs.existsSync(file) && fs.lstatSync(file).isFile());
        requireThat(native.includes('/usr/bin/creator-hub') && native.length < 10000, 'Unexpected native installation');
        const fixtures = [
          ['.local/share/CreatorHub/flatpak-validation-preserve.json', '{"nativeOnly":true,"preference":"keep"}\n'],
          ['.config/creator-works-mcp/launcher-config.json', '{"fixture":true,"managed":false}\n'],
          ['.config/flatpak-validation-ai/client.json', '{"fixture":true,"doNotMigrate":true}\n'],
          ['UnityValidation/Assets/keep.txt', 'protected synthetic project; no Unity acceptance\n'],
          [`.var/app/${ID}/data/CreatorHub/flatpak-validation-preserve.json`, '{"sandboxOnly":true,"preference":"keep"}\n'],
        ];
        for (const [name, bytes] of fixtures) {
          const file = path.join(this.home, name);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
        }
        protectedFiles = [...native, ...fixtures.map(([name]) => path.join(this.home, name))];
        before = inventorySnapshot(protectedFiles);
        writeJson(path.join(this.evidence, 'beforeimage.json'), before);
        sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: this.env, stdio: 'ignore' });
        return { nativeInstalled: true, simultaneousNativeGuiTested: false, protectedFiles: before.length, hostSentinelPid: sentinel.pid };
      });
      await this.phase('runtime', () => {
        for (const directory of [this.env.XDG_RUNTIME_DIR, this.env.GNUPGHOME, this.env.FLATPAK_SYSTEM_DIR]) fs.mkdirSync(directory, { mode: 0o700, recursive: true });
        this.flat(['remote-add', '--user', 'flathub', 'https://dl.flathub.org/repo/flathub.flatpakrepo']);
        requireThat(this.trust('flathub') === 'true', 'Flathub GPG policy missing');
        this.flat(['install', '--user', '-y', '--noninteractive', 'flathub', PLATFORM, SDK], { timeout: 1200000 });
        const commits = {};
        for (const ref of [PLATFORM, SDK]) {
          const commit = this.commit(ref);
          const raw = this.command('ostree', [`--repo=${this.userRepo}`, 'show', '--raw', commit]).stdout;
          requireThat(!/ostree\.endoflife(?:-rebase)?/.test(raw), 'GNOME50 runtime/SDK is EOL or rebased');
          fs.writeFileSync(path.join(this.evidence, ref === PLATFORM ? 'runtime-metadata.txt' : 'sdk-metadata.txt'), raw);
          commits[ref === PLATFORM ? 'platformCommit' : 'sdkCommit'] = commit;
        }
        const libraries = this.flat(['run', '--user', '--command=sh', PLATFORM, '-c',
          'test -f /usr/manifest.json && find /usr/lib -name "libwebkit2gtk-4.1.so*" -o -name "libjavascriptcoregtk-4.1.so*"']);
        requireThat(libraries.includes('libwebkit2gtk-4.1.so.0') && libraries.includes('libjavascriptcoregtk-4.1.so.0'), 'GNOME50 installed runtime lacks 4.1 ABI libraries');
        fs.writeFileSync(path.join(this.evidence, 'runtime-manifest.json'), this.flat(['run', '--user', '--command=cat', PLATFORM, '/usr/manifest.json']));
        this.report.runtime = { ...commits, ref: PLATFORM, sdk: SDK, libraries, gpgCommitVerification: true };
        this.command('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', '', '--quick-generate-key',
          'Disposable Flatpak validation <flatpak-validation@example.invalid>', 'rsa2048', 'sign', '1d']);
        const fingerprint = this.command('gpg', ['--batch', '--with-colons', '--list-keys']).stdout
          .split('\n').find(line => line.startsWith('fpr:'))?.split(':')[9];
        requireThat(/^[A-F0-9]{40}$/.test(fingerprint || ''), 'Ephemeral signing identity unavailable');
        this.command('gpg', ['--batch', '--output', path.join(this.root, 'ephemeral-public.gpg'), '--export', fingerprint]);
        this.signing = [`--gpg-sign=${fingerprint}`, `--gpg-homedir=${this.env.GNUPGHOME}`];
        return this.report.runtime;
      });
      await this.phase('build-export', () => {
        const manifest = readJson(path.join(inputs, `${ID}.json`));
        assert.deepEqual(manifest['finish-args'], [...FINISH_ARGS]);
        requireThat(manifest['runtime-version'] === '50' && manifest.branch === 'experimental', 'Manifest scope drift');
        this.command('flatpak-builder', ['--user', '--arch=x86_64', '--disable-rofiles-fuse', '--disable-cache',
          build, path.join(inputs, `${ID}.json`)], { timeout: 1200000 });
        this.report.candidateCommit = this.export(build, 'VALIDATION ONLY exact native 0.1.13 candidate');
        return { exportedCommit: this.report.candidateCommit, productionKeyUsed: false };
      });
      await this.phase('install', () => {
        this.flat(['remote-add', '--user', `--gpg-import=${this.root}/ephemeral-public.gpg`, 'validation', this.repo]);
        this.trust('validation');
        this.flat(['install', '--user', '-y', '--noninteractive', '--no-related', 'validation', APP], { timeout: 600000 });
        requireThat(this.commit(APP) === this.report.candidateCommit, 'Installed candidate differs from exported commit');
        const metadata = this.flat(['info', '--user', '--show-metadata', APP]);
        fs.writeFileSync(path.join(this.evidence, 'app-metadata.txt'), metadata);
        return { ...this.resources(), permissions: permissionMetadata(metadata) };
      });
      await this.phase('sandbox', () => {
        const pid = sentinel.pid;
        const probe = this.flat(['run', '--user', '--command=sh', APP, '-c',
          'set -eu; test "$FLATPAK_ID" = com.creatorworks.hub; test -f /.flatpak-info; ' +
          'printf "config=%s\\ndata=%s\\n" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"; ' +
          `test ! -e "$HOME/UnityValidation/Assets/keep.txt"; test ! -e "$HOME/.local/share/CreatorHub/flatpak-validation-preserve.json"; ` +
          `test ! -e /proc/${pid}; printf "hostPathsDenied=true\\nhostProcessDenied=true\\n"; ` +
          'ldd /app/bin/creator-hub']);
        requireThat(!probe.includes('not found'), 'Native binary has unresolved runtime dependencies');
        requireThat(probe.includes(`/.var/app/${ID}/config`) && probe.includes(`/.var/app/${ID}/data`), 'Unexpected sandbox XDG paths');
        fs.writeFileSync(path.join(this.evidence, 'sandbox-probe.txt'), probe);
        return { hostProjectPathDenied: true, nativeDataPathDenied: true, hostSentinelNotVisible: true,
          xdgIsolated: true, dependenciesResolved: true, hostLaunchAttempted: false };
      });
      // GUI failure is retained but does not prevent the independent, integrity-bound repository trial.
      try { await this.phase('candidate-gui', () => this.gui('candidate')); } catch { /* Recorded by phase. */ }
      await this.phase('app-update', () => {
        const runtime = this.runtimeGeneration(1);
        this.flat(['install', '--user', '-y', '--noninteractive', '--no-related', 'validation', FIXTURE_RUNTIME], { timeout: 600000 });
        requireThat(this.commit(FIXTURE_RUNTIME) === runtime, 'Fixture runtime install drift');
        const runtimePayloadProof = this.identicalRuntime(this.report.runtime.platformCommit, runtime);
        const fixture = path.join(this.root, 'fixture-build');
        fs.cpSync(build, fixture, { recursive: true, dereference: false });
        const xmlFile = path.join(fixture, `files/share/metainfo/${ID}.metainfo.xml`);
        const changed = fixtureMetadata(fs.readFileSync(path.join(fixture, 'metadata'), 'utf8'), fs.readFileSync(xmlFile, 'utf8'));
        fs.writeFileSync(path.join(fixture, 'metadata'), changed.metadata);
        fs.writeFileSync(xmlFile, changed.xml);
        const marker = path.join(fixture, 'files/share/flatpak-validation/fixture.json');
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        const fixtureIdentity = { ...this.report.fixture, generation: 2, candidateCommit: this.report.candidateCommit,
          sourceCommit: this.report.request.sourceCommit, nativeDebSha256: this.report.request.debSha256 };
        writeJson(marker, fixtureIdentity);
        const fixtureCommit = this.export(fixture, 'VALIDATION ONLY same-version OSTree generation update; native executable remains 0.1.13');
        requireThat(fixtureCommit !== this.report.candidateCommit, 'App fixture did not create a new commit');
        this.flat(['update', '--user', '-y', '--noninteractive', '--no-related', '--no-deps', APP], { timeout: 600000 });
        requireThat(this.commit(APP) === fixtureCommit, 'Actual Flatpak app update did not deploy fixture');
        const location = this.resources();
        assert.deepEqual(readJson(path.join(location.location, 'files/share/flatpak-validation/fixture.json')), fixtureIdentity);
        requireThat(this.flat(['info', '--user', '--show-runtime', APP]) === FIXTURE_RUNTIME.slice(8), 'Fixture runtime was not selected');
        this.report.fixtureCommit = fixtureCommit;
        this.report.fixtureRuntimeCommit = runtime;
        return { candidateCommit: this.report.candidateCommit, fixtureCommit, nativeVersion: '0.1.13',
          nativeBytesUnchanged: true, marker: fixtureIdentity, runtime, runtimePayloadProof, scope: this.report.fixture.scope };
      });
      try { await this.phase('fixture-gui', () => this.gui('fixture')); } catch { /* Recorded by phase. */ }
      await this.phase('runtime-generation', async () => {
        const second = this.runtimeGeneration(2);
        requireThat(second !== this.report.fixtureRuntimeCommit, 'No new fixture runtime generation');
        this.flat(['update', '--user', '-y', '--noninteractive', '--no-related', '--no-deps', FIXTURE_RUNTIME], { timeout: 600000 });
        requireThat(this.commit(FIXTURE_RUNTIME) === second && this.commit(APP) === this.report.fixtureCommit, 'Runtime update changed the wrong deployment');
        requireThat(this.commit(PLATFORM) === this.report.runtime.platformCommit && this.commit(SDK) === this.report.runtime.sdkCommit, 'Official GNOME50 refs changed');
        const runtimePayloadProof = this.identicalRuntime(this.report.fixtureRuntimeCommit, second);
        this.report.runtimeGeneration = { before: this.report.fixtureRuntimeCommit, after: second,
          runtimePayloadChanged: false, runtimePayloadProof, officialRefsUnchanged: true };
        return { ...this.report.runtimeGeneration, gui: await this.gui('runtime-generation'),
          scope: 'Locally signed identical-content runtime generation only' };
      });
    } finally {
      try {
        if (before) await this.phase('preservation', () => {
          const after = inventorySnapshot(protectedFiles);
          writeJson(path.join(this.evidence, 'afterimage.json'), after);
          assert.deepEqual(after, before, 'Protected native/app/AI/project fixtures changed');
          requireThat(sentinel.exitCode === null, 'Unrelated host sentinel was stopped');
          return { nativeInstallAndSentinelsUnchanged: true, unrelatedProcessAlive: true, migrationTested: false };
        });
      } finally {
        if (sentinel?.exitCode === null) sentinel.kill('SIGTERM');
        if (fs.existsSync(this.env.GNUPGHOME)) this.command('gpgconf', ['--kill', 'gpg-agent'], { allowFailure: true });
      }
    }
  }
}

async function main(options) {
  const root = hostedRoot(options);
  const evidence = path.join(root, 'evidence');
  const filename = path.join(evidence, 'report.json');
  if (options.mode === 'init') {
    requireThat(!fs.existsSync(root), 'Disposable experiment root already exists; no reuse');
    fs.mkdirSync(root, { mode: 0o700 });
    fs.mkdirSync(evidence, { mode: 0o700 });
    fs.mkdirSync(path.join(root, 'home'), { mode: 0o700 });
    const report = initialReport();
    writeJson(filename, report);
    try {
      report.request = requestIdentity(options);
      writeJson(filename, report);
    } catch (error) {
      report.failures.push({ phase: 'preflight', message: error.message });
      report.status = 'failed';
      writeJson(filename, report);
      throw error;
    }
    return;
  }
  if (options.mode === 'finalize' && !fs.existsSync(filename)) {
    fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
    writeJson(filename, initialReport());
  }
  const report = readJson(filename);
  if (options.mode === 'finalize') {
    writeJson(filename, finalizeReport(report, options['job-status'] || 'unknown'));
    return;
  }
  const experiment = new Experiment(root, report);
  if (options.mode === 'tree') {
    await experiment.phase('harness-source-tree', () => experiment.tree());
    return;
  }
  if (options.mode === 'bind') {
    await experiment.phase('binding', () => validateBinding(readJson(path.join(root, 'binding.json')), report.request));
    return;
  }
  try {
    await experiment.execute();
    requireThat(report.failures.length === 0, 'Experimental checks failed; original diagnostics retained in report.json');
  }
  finally { experiment.save(); }
}

module.exports = { parseArgs, hostedRoot, requestIdentity, validateBinding, initialReport, finalizeReport,
  inventorySnapshot, parsePs, ocrLines, fixtureMetadata, permissionMetadata, EXTRACT_DEB, Experiment, PHASES,
  PROBE_FILES, REVIEWED_TEST_ONLY_FILES, TREE_EXCLUSIONS, REPO, APP, PLATFORM, SDK, FIXTURE_RUNTIME };
if (require.main === module) {
  main(parseArgs(process.argv.slice(2))).catch(error => { console.error(`Flatpak native validation refused: ${error.message}`); process.exitCode = 1; });
}
