const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');

const REPO = 'BOBWORKS-XR/CREATOR-HUB';
const TERMS = Object.freeze({ title: 'Terms of use and risk acknowledgement',
  checkbox: 'I have read and agree to these terms, including the risk assumption and liability limitations above.',
  continue: 'Accept and continue' });
const AUTO_DOWNLOAD = 'Download verified updates automatically';
const AUTO_DOWNLOAD_KEY = 'creator-hub.auto-download';
const WEBKIT_ROOT = 'Library/WebKit/com.creatorworks.hub/WebsiteData';
const ITEM_SCHEMA = 'CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL)';
const BASELINE_SOURCE = '35a16a45814d821d65b5d203628478449174cd55';
const BASELINES = Object.freeze({
  X64: Object.freeze({ name: 'Creator.Hub_0.1.12_x64.dmg', size: 5397091,
    sha256: '1eeec9bc53903b43ed0466ee97caa66f86f9725d40d3129ebfac717bd4b9528f' }),
  ARM64: Object.freeze({ name: 'Creator.Hub_0.1.12_aarch64.dmg', size: 5102365,
    sha256: '5254e7cb372526e15ec1f51ae4962e7ace5436df45d1897ce5a2a71170092fce' }),
});
const LIMIT = 512 * 1024 * 1024;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const CANDIDATE = Object.freeze({ runId: '38442820243',
  headSha: 'cef6f60310e88349e57951a2bbe0213e86fd05e7',
  sourceSha: 'dcbd0f8c84bd3ab5d6b463972f7701c5e3541a2e',
  artifacts: Object.freeze({
    X64: Object.freeze({ id: 11838031910, size: 5436847, dmgSize: 5468115,
      dmgSha256: '3a62251de7eac0dccd0cdf10052b0745263c981cf72ca562df5c0fb1a9f50389',
      sha256: '9a215d6d2d1a9cdd180d37ce036d56896baead24cfff3e3368cd43cdf2a997ab' }),
    ARM64: Object.freeze({ id: 11837072258, size: 5154053, dmgSize: 5181127,
      dmgSha256: 'ebdbec2ef2e98b682cc107a926bcd683f39c9cca59b7eb621a72406c94a976a2',
      sha256: '3ccbc6f62528490f696045fbe8a4575936d89fec617aabf09b70b526038530b8' }),
  }),
});
const PROBE_FILES = Object.freeze(['scripts/native-mac-maintenance-smoke.cjs',
  'scripts/native-mac-maintenance-smoke.test.cjs', 'scripts/native-mac-window.swift',
  '.github/workflows/mac-maintenance-validation.yml', 'docs/MAC-MAINTENANCE-VALIDATION.md']);
const REVIEWED_TEST_ONLY_FILES = Object.freeze([
  'scripts/native-linux-maintenance-smoke.cjs', 'scripts/native-linux-maintenance-smoke.test.cjs',
  'scripts/native-linux-window.py', '.github/workflows/linux-maintenance-validation.yml',
  'scripts/flatpak-native-smoke.cjs', 'scripts/flatpak-native-smoke.test.cjs',
  '.github/workflows/flatpak-maintenance-validation.yml', 'docs/FLATPAK-NATIVE-VALIDATION.md',
  '.github/workflows/windows-candidate.yml', 'scripts/Test-InstalledCandidate.ps1',
  'scripts/self-update-baselines.test.cjs',
  '.github/workflows/maintenance-signed-update-lab.yml',
  'scripts/maintenance-signed-update.test.cjs',
  'tests/fixtures/maintenance-signed-update/README.md',
  'tests/fixtures/maintenance-signed-update/creator-hub-windows-x86_64.json',
  'tests/fixtures/maintenance-signed-update/creator-hub-windows-x86_64.json.minisig',
  'tests/fixtures/maintenance-signed-update/latest.json',
  'scripts/flatpak-xres-window-pid.c',
]);
const TREE_EXCLUSIONS = Object.freeze([...PROBE_FILES, ...REVIEWED_TEST_ONLY_FILES]);

function options(env = process.env) {
  const input = { runId: env.CREATOR_MAC_CANDIDATE_RUN_ID, headSha: env.CREATOR_MAC_HEAD_SHA,
    sourceSha: env.CREATOR_MAC_SOURCE_SHA,
    dmgSha256: env.CREATOR_MAC_DMG_SHA256, executableSha256: env.CREATOR_MAC_EXECUTABLE_SHA256 || null,
    architecture: env.RUNNER_ARCH, lane: env.CREATOR_MAC_LANE };
  assert.match(input.runId || '', /^[1-9][0-9]{0,15}$/);
  assert.match(input.sourceSha || '', /^[a-f0-9]{40}$/);
  assert.match(input.headSha || '', /^[a-f0-9]{40}$/);
  for (const name of ['runId', 'headSha', 'sourceSha']) assert.equal(input[name], CANDIDATE[name], 'Unreviewed candidate identity');
  assert.match(input.dmgSha256 || '', /^[a-f0-9]{64}$/);
  if (input.executableSha256 !== null) assert.match(input.executableSha256, /^[a-f0-9]{64}$/);
  assert.ok(Object.hasOwn(BASELINES, input.architecture), 'Only Mac Intel and ARM are admitted');
  assert.equal(input.dmgSha256, CANDIDATE.artifacts[input.architecture].dmgSha256, 'Unreviewed DMG hash');
  assert.ok(['fresh', 'manual-upgrade', 'legacy-preferences'].includes(input.lane));
  return input;
}

function guard(env = process.env, platform = process.platform, arch = process.arch, node = process.versions.node) {
  assert.equal(platform, 'darwin', 'Native actions require macOS');
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted', 'No user machine or self-hosted runner');
  assert.equal(env.RUNNER_OS, 'macOS');
  assert.equal(env.GITHUB_REPOSITORY, REPO);
  assert.equal(Number(node.split('.')[0]), 24, 'Use the repository Node 24 runtime');
  assert.equal(arch, env.RUNNER_ARCH === 'X64' ? 'x64' : 'arm64');
  options(env);
}

function contained(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  assert.ok(relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative),
    'Path must remain strictly inside the owned root');
  return path.resolve(target);
}

function noLinks(target) {
  for (let current = path.resolve(target);;) {
    // Callers canonicalize macOS's system-owned /var and /tmp aliases first.
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat) assert.ok(!stat.isSymbolicLink(), `Refusing link: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function boundedFile(file, max = LIMIT) {
  noLinks(file);
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && stat.size > 0 && stat.size <= max, 'Invalid or oversized file');
  return fs.readFileSync(file);
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

function validateBinding(run, artifact, input, headCommit, sourceCommit) {
  assert.equal(run.id, Number(input.runId));
  assert.equal(run.head_sha, input.headSha, 'Candidate run/head mismatch');
  assert.equal(run.repository?.full_name, REPO);
  assert.equal(run.head_repository?.full_name, REPO, 'Fork packages are not admitted');
  assert.equal(run.path, '.github/workflows/ci.yml');
  assert.equal(run.status, 'completed', 'Do not dispatch another build; wait for the existing CI');
  assert.equal(run.conclusion, 'success', 'Original failed CI is a blocker');
  assert.ok(['pull_request', 'push', 'workflow_dispatch'].includes(run.event));
  assert.equal(headCommit.sha, input.headSha);
  assert.equal(sourceCommit.sha, input.sourceSha);
  assert.match(headCommit.tree?.sha || '', /^[a-f0-9]{40}$/);
  assert.equal(sourceCommit.tree?.sha, headCommit.tree.sha, 'Artifact checkout tree differs from reviewed head');
  if (input.sourceSha !== input.headSha) {
    assert.equal(run.event, 'pull_request', 'Different checkout SHA requires an exact PR merge');
    assert.equal(sourceCommit.parents?.length, 2);
    // GitHub returns the PR's current head here, not the historical run head.
    const prs = run.pull_requests.filter(pr => pr.number === 22
      && pr.head.repo?.id === run.repository.id && pr.base.repo?.id === run.repository.id);
    assert.equal(prs.length, 1, 'PR head/base binding missing or ambiguous');
    assert.deepEqual(sourceCommit.parents.map(p => p.sha), [BASELINE_SOURCE, input.headSha], 'PR merge parents mismatch');
  }
  assert.equal(artifact.name, `hub-development-macOS-${input.architecture}-${input.sourceSha}`);
  assert.equal(artifact.expired, false);
  assert.equal(artifact.workflow_run?.id, Number(input.runId));
  assert.equal(artifact.workflow_run?.head_sha, input.headSha);
  assert.equal(artifact.workflow_run?.repository_id, run.repository.id);
  assert.equal(artifact.workflow_run?.head_repository_id, run.repository.id);
  assert.match(artifact.digest || '', /^sha256:[a-f0-9]{64}$/, 'GitHub artifact archive digest is required');
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= LIMIT);
  assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0);
  const pin = CANDIDATE.artifacts[input.architecture];
  assert.equal(artifact.id, pin.id);
  assert.equal(artifact.digest, `sha256:${pin.sha256}`);
  assert.equal(artifact.size_in_bytes, pin.size);
  return { id: artifact.id, name: artifact.name, size: artifact.size_in_bytes,
    sha256: artifact.digest.slice(7), runId: run.id, runUrl: run.html_url, headSha: run.head_sha,
    sourceSha: input.sourceSha, treeSha: sourceCommit.tree.sha, parents: sourceCommit.parents.map(p => p.sha),
    runAttempt: run.run_attempt, workflow: run.path };
}

function validateSource(config, pkg, toolchain) {
  assert.equal(pkg.version, '0.1.13');
  assert.equal(config.version, '0.1.13');
  assert.equal(config.productName, 'Creator Hub');
  assert.equal(config.identifier, 'com.creatorworks.hub');
  assert.equal(config.bundle?.macOS?.signingIdentity, '-', 'This lane expects the existing ad-hoc CI package');
  assert.match(toolchain, /channel\s*=\s*"1\.99\.0"/);
  return { version: config.version, identifier: config.identifier, signingIdentity: '-',
    configuredMinimumSystemVersion: config.bundle.macOS.minimumSystemVersion ?? null, rust: '1.99.0' };
}

function zipEntry(listing, architecture) {
  const entries = listing.trim().split(/\r?\n/);
  assert.equal(entries.length, 1, 'CI Mac artifact must contain exactly one DMG, no extraction tree');
  const suffix = architecture === 'X64' ? 'x64' : 'aarch64';
  assert.match(entries[0], new RegExp(`^Creator[ .]Hub_0\\.1\\.13_${suffix}\\.dmg$`));
  return entries[0];
}

function parseLocalTree(text) {
  return text.split('\0').filter(Boolean).map(row => {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t([^\0]+)$/.exec(row);
    assert.ok(match, 'Unexpected git tree record');
    return { mode: match[1], type: match[2], sha: match[3], path: match[4] };
  });
}

function verifyProductTree(remote, local) {
  const product = entries => entries.filter(e => e.type !== 'tree' && !TREE_EXCLUSIONS.includes(e.path))
    .map(({ path: name, mode, type, sha }) => ({ path: name, mode, type, sha }))
    .sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(product(local), product(remote), 'Non-probe checkout tree differs from the accepted artifact source');
  return { unchanged: true, comparison: 'all-blob-modes-and-hashes-except-sixteen-explicit-reviewed-testing-paths',
    excludedPaths: TREE_EXCLUSIONS, comparedFiles: product(remote).length };
}

function command(exe, args, allowFailure = false, extraEnv = {}) {
  const child = spawnSync(exe, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ...extraEnv, GH_TOKEN: '', GITHUB_TOKEN: '' } });
  const result = { status: child.status ?? -1, stdout: String(child.stdout || ''),
    stderr: String(child.stderr || child.error?.message || '') };
  if (result.status !== 0 && !allowFailure) throw Error(`${exe} failed: ${JSON.stringify(result)}`);
  return result;
}

async function api(resource) {
  const response = await fetch(`https://api.github.com/repos/${REPO}/${resource}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) },
    redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200, `Read-only GitHub API ${resource}: ${response.status}`);
  const bytes = await response.text();
  assert.ok(Buffer.byteLength(bytes) <= 2 * 1024 * 1024);
  return JSON.parse(bytes);
}

async function sourceFile(name, sha) {
  const result = await api(`contents/${name}?ref=${sha}`);
  assert.equal(result.type, 'file');
  assert.equal(result.encoding, 'base64');
  assert.ok(result.size > 0 && result.size <= 128 * 1024);
  return Buffer.from(result.content, 'base64').toString('utf8');
}

async function download(url, file, expected, authorization = false) {
  let response = await fetch(url, { redirect: authorization ? 'manual' : 'follow',
    headers: authorization && process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {},
    signal: AbortSignal.timeout(180000) });
  if (authorization && response.status === 302) {
    const location = new URL(response.headers.get('location'));
    assert.equal(location.protocol, 'https:');
    assert.equal(location.username + location.password, '');
    // Never forward the read-only API token to the signed archive download URL.
    response = await fetch(location, { redirect: 'error', signal: AbortSignal.timeout(180000) });
  }
  assert.equal(response.status, 200, `Download failed: ${response.status}`);
  let size = 0;
  const hash = crypto.createHash('sha256');
  async function* checkBytes(stream) {
    for await (const bytes of stream) {
      size += bytes.length;
      assert.ok(size <= expected.size && size <= LIMIT, 'Oversized download');
      hash.update(bytes);
      yield bytes;
    }
  }
  await pipeline(checkBytes(Readable.fromWeb(response.body)), fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  assert.equal(size, expected.size, 'Download length mismatch');
  assert.equal(hash.digest('hex'), expected.sha256, 'Download hash mismatch');
}

async function prepare(out, input, report) {
  const run = await api(`actions/runs/${input.runId}`);
  const artifacts = await api(`actions/runs/${input.runId}/artifacts?per_page=100`);
  assert.ok(artifacts.total_count <= 100, 'Artifact list needs explicit review, not truncated selection');
  const matches = artifacts.artifacts.filter(a => a.name === `hub-development-macOS-${input.architecture}-${input.sourceSha}`);
  assert.equal(matches.length, 1, 'Missing or ambiguous exact CI Mac artifact');
  const artifact = validateBinding(run, matches[0], input, await api(`git/commits/${input.headSha}`),
    await api(`git/commits/${input.sourceSha}`));
  report.artifact = artifact;
  const source = validateSource(JSON.parse(await sourceFile('src-tauri/tauri.conf.json', input.sourceSha)),
    JSON.parse(await sourceFile('package.json', input.sourceSha)), await sourceFile('rust-toolchain.toml', input.sourceSha));
  if (input.architecture === 'ARM64') {
    const overlay = JSON.parse(await sourceFile('src-tauri/tauri.arm64.conf.json', input.sourceSha));
    assert.deepEqual(overlay, { bundle: { macOS: { minimumSystemVersion: '11.0' } } }, 'Unreviewed ARM minimum override');
    source.configuredMinimumSystemVersion = overlay.bundle.macOS.minimumSystemVersion;
  }
  const sourceTree = await api(`git/trees/${artifact.treeSha}?recursive=1`);
  assert.equal(sourceTree.truncated, false, 'Product tree comparison must not be truncated');
  assert.equal(sourceTree.sha, artifact.treeSha);
  const checkoutSha = command('git', ['rev-parse', 'HEAD']).stdout.trim();
  assert.equal(checkoutSha, process.env.GITHUB_SHA, 'Harness checkout differs from workflow execution SHA');
  const productTree = { ...verifyProductTree(sourceTree.tree, parseLocalTree(command('git', ['ls-tree', '-r', '-z', 'HEAD']).stdout)),
    sourceSha: input.sourceSha, checkoutSha };
  report.productTree = productTree;
  const zip = path.join(out, 'candidate-artifact.zip');
  await download(`https://api.github.com/repos/${REPO}/actions/artifacts/${artifact.id}/zip`, zip, artifact, true);
  const entry = zipEntry(command('/usr/bin/unzip', ['-Z1', zip]).stdout, input.architecture);
  const candidate = path.join(out, 'candidate.dmg');
  const bytes = execFileSync('/usr/bin/unzip', ['-p', zip, entry], {
    maxBuffer: CANDIDATE.artifacts[input.architecture].dmgSize + 1, timeout: 60000 });
  assert.equal(bytes.length, CANDIDATE.artifacts[input.architecture].dmgSize);
  assert.equal(digest(bytes), input.dmgSha256, 'Candidate DMG hash differs from reviewed input');
  fs.writeFileSync(candidate, bytes, { flag: 'wx', mode: 0o600 });
  let baseline = null;
  if (input.lane === 'manual-upgrade') {
    const release = await api('releases/tags/v0.1.12');
    assert.equal(release.draft, false);
    assert.equal(release.prerelease, false);
    assert.equal(release.tag_name, 'v0.1.12');
    assert.equal(release.target_commitish, BASELINE_SOURCE);
    const pin = BASELINES[input.architecture];
    const assets = release.assets.filter(a => a.name === pin.name);
    assert.equal(assets.length, 1);
    assert.equal(assets[0].size, pin.size);
    assert.equal(assets[0].digest, `sha256:${pin.sha256}`);
    const url = `https://github.com/${REPO}/releases/download/v0.1.12/${pin.name}`;
    assert.equal(assets[0].browser_download_url, url);
    await download(url, path.join(out, 'baseline.dmg'), pin);
    baseline = { ...pin, sourceSha: BASELINE_SOURCE, sourceKind: 'unmodified-public-0.1.12-dmg' };
  }
  const binding = { schemaVersion: 1, releaseLine: 'separate-apps', input, artifact, source, productTree, baseline };
  writeJson(path.join(out, 'binding.json'), binding);
  report.binding = binding;
  report.passed = true;
}

function numericVersion(value) {
  assert.match(value || '', /^\d+\.\d+(?:\.\d+)?$/, 'Minimum OS must be an explicit numeric version');
  return value.split('.').map(Number);
}

function atLeast(actual, minimum) {
  const a = numericVersion(actual), b = numericVersion(minimum);
  for (let index = 0; index < 3; index++) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) > (b[index] || 0);
  }
  return true;
}

function validateBundle(meta, expected) {
  assert.equal(meta.identifier, 'com.creatorworks.hub');
  assert.equal(meta.shortVersion, expected.version);
  assert.equal(meta.bundleVersion, expected.version);
  assert.equal(meta.executable, 'creator-hub');
  assert.equal(meta.architectures.trim(), expected.architecture === 'X64' ? 'x86_64' : 'arm64');
  assert.ok(atLeast(meta.hostOS, meta.minimumOS), 'Bundle minimum OS exceeds this runner');
  const minima = [];
  let minimumField = null;
  for (const raw of meta.loadCommands.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('cmd ')) {
      minimumField = line === 'cmd LC_BUILD_VERSION' ? 'minos' : line === 'cmd LC_VERSION_MIN_MACOSX' ? 'version' : null;
    } else if (minimumField) {
      const match = new RegExp(`^${minimumField} (\\d+\\.\\d+(?:\\.\\d+)?)$`).exec(line);
      if (match) minima.push(match[1]);
    }
  }
  assert.ok(minima.length, 'Missing Mach-O minimum OS');
  for (const minimum of minima) assert.ok(atLeast(meta.hostOS, minimum), 'Executable minimum OS exceeds this runner');
  if (expected.configuredMinimumSystemVersion) assert.equal(meta.minimumOS, expected.configuredMinimumSystemVersion);
  assert.match(meta.signature, /(?:^|\n)Signature=adhoc(?:\r?\n|$)/);
  if (expected.executableSha256) assert.equal(meta.executableSha256, expected.executableSha256);
  return { ...meta, executableMinimumOS: minima,
    bundleMinimumCoversExecutable: minima.every(v => atLeast(meta.minimumOS, v)),
    publisherSignatureVerified: false, notarizationVerified: false };
}

function inspectBundle(app, expected, run = command) {
  noLinks(app);
  const plist = path.join(app, 'Contents', 'Info.plist');
  const executable = path.join(app, 'Contents', 'MacOS', 'creator-hub');
  const read = name => run('/usr/libexec/PlistBuddy', ['-c', `Print :${name}`, plist]).stdout.trim();
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const signature = run('/usr/bin/codesign', ['--display', '--verbose=4', app], true);
  assert.equal(signature.status, 0);
  const policy = run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app], true);
  return validateBundle({ identifier: read('CFBundleIdentifier'), shortVersion: read('CFBundleShortVersionString'),
    bundleVersion: read('CFBundleVersion'), executable: read('CFBundleExecutable'), minimumOS: read('LSMinimumSystemVersion'),
    hostOS: run('/usr/bin/sw_vers', ['-productVersion']).stdout.trim(),
    architectures: run('/usr/bin/lipo', ['-archs', executable]).stdout,
    loadCommands: run('/usr/bin/otool', ['-l', executable]).stdout,
    signature: signature.stdout + signature.stderr, gatekeeper: policy,
    executableSha256: digest(boundedFile(executable)) }, expected);
}

function sentinelFiles(home) {
  const support = path.join(home, 'Library', 'Application Support');
  return [
    ['hub-preferences-opaque', path.join(home, 'Library', 'WebKit', 'com.creatorworks.hub')],
    ['hub-adoption-opaque', path.join(support, 'CreatorHub')],
    ['hub-projects-opaque', path.join(support, 'CreatorHub')],
    ['mcp-settings-current-opaque', path.join(support, 'creator-works-mcp')],
    ['mcp-settings-legacy-opaque', path.join(support, 'banter-mcp')],
    ['setup-cache-opaque', path.join(support, 'Creator Project Setup')],
    ['setup-receipt-opaque', path.join(support, 'Creator Project Setup')],
    ['client-entry-opaque', path.join(support, 'Claude')],
    ['mcp-install-fixture', path.join(home, 'Applications', 'Creator Works MCP.fixture')],
    ['setup-install-fixture', path.join(home, 'Applications', 'Creator Project Setup.fixture')],
    ['unmanaged-install-sibling', path.join(home, 'Applications')],
    ['unmanaged-project-content', path.join(home, 'Documents', 'mac-maintenance-project.fixture')],
  ].map(([label, root]) => ({ label, file: contained(home, path.join(root, '.maintenance-ci', `${label}.bin`)) }));
}

function seedSentinels(home) {
  return sentinelFiles(home).map(({ label, file }) => {
    noLinks(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(73), { flag: 'wx', mode: 0o600 });
    return { label, file, sha256: digest(boundedFile(file)), size: fs.statSync(file).size,
      mode: fs.statSync(file).mode & 0o777, fixtureKind: 'opaque-sentinel-not-effective-app-settings-or-real-companion' };
  });
}

function verifySentinels(sentinels) {
  for (const before of sentinels) {
    assert.equal(digest(boundedFile(before.file)), before.sha256, `Protected sentinel changed: ${before.label}`);
    assert.equal(fs.statSync(before.file).size, before.size);
    assert.equal(fs.statSync(before.file).mode & 0o777, before.mode);
  }
  return sentinels.map(s => ({ label: s.label, sha256: s.sha256, unchanged: true }));
}

function storageCheck(condition, reason) {
  if (!condition) throw Object.assign(Error(reason), { storageReason: reason });
}

function storageFile(file, max) {
  noLinks(file);
  let before;
  try { before = fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  storageCheck(before.isFile() && before.nlink === 1n, 'not-single-owned-file');
  storageCheck(!process.getuid || before.uid === BigInt(process.getuid()), 'foreign-file-owner');
  storageCheck(before.size <= BigInt(max), 'file-size-bound');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const identity = stat => ({ device: String(stat.dev), inode: String(stat.ino), owner: String(stat.uid),
      size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), mode: Number(stat.mode) });
    assert.deepEqual(identity(opened), identity(before));
    const bytes = Buffer.alloc(Number(opened.size));
    let read = 0;
    while (read < bytes.length) {
      const count = fs.readSync(fd, bytes, read, bytes.length - read, read);
      storageCheck(count > 0, 'source-drift');
      read += count;
    }
    assert.deepEqual(identity(fs.fstatSync(fd, { bigint: true })), identity(before));
    assert.deepEqual(identity(fs.lstatSync(file, { bigint: true })), identity(before));
    return { bytes, receipt: { ...identity(before), sha256: digest(bytes) } };
  } finally { fs.closeSync(fd); }
}

// Production calls this only on hosted disposable CI, after a verified normal exit.
// Paths are source-derived candidates, not an attestation of the active WebKit store.
function captureWebKitPreference(home, scratchRoot, hooks = {}) {
  const result = { status: 'unknown', candidatePathScope: 'source-derived-default-store-tauri-localhost-only',
    expectedOrigin: 'tauri://localhost', activeStoreBound: false, rootCause: 'unknown', key: AUTO_DOWNLOAD_KEY,
    startedAt: new Date().toISOString(), candidates: [], sourceUnchanged: false };
  let scratch;
  try {
    const root = contained(home, path.join(home, ...WEBKIT_ROOT.split('/')));
    noLinks(root);
    if (fs.existsSync(root)) {
      const stat = fs.lstatSync(root);
      storageCheck(stat.isDirectory() && (!process.getuid || stat.uid === process.getuid()), 'foreign-store-root');
      result.rootIdentity = { device: String(stat.dev), inode: String(stat.ino), owner: String(stat.uid), mode: stat.mode };
    }
    const observed = new Map();
    const read = (relative, max) => {
      const file = contained(root, path.join(root, ...relative.split('/')));
      const value = storageFile(file, max);
      observed.set(file, { max, value });
      return value;
    };
    const salt = read('Default/salt', 8);
    if (salt) storageCheck(salt.bytes.length === 8, 'unsupported-salt');
    const relatives = ['LocalStorage/tauri_localhost_0.localstorage'];
    if (salt) {
      const hash = crypto.createHash('sha256').update(result.expectedOrigin, 'utf8').update(salt.bytes).digest('base64url');
      relatives.push(`Default/${hash}/${hash}/LocalStorage/localstorage.sqlite3`);
      result.saltIdentity = salt.receipt; // No salt bytes are recorded.
    }
    const copies = [];
    for (const relative of relatives) {
      const candidate = { relativePath: relative, files: {} };
      const files = [];
      for (const [suffix, max] of [['', 2 * 1024 * 1024], ['-wal', 2 * 1024 * 1024], ['-shm', 128 * 1024], ['-journal', 2 * 1024 * 1024]]) {
        const value = read(relative + suffix, max);
        candidate.files[suffix || 'database'] = value?.receipt || null;
        if (value) files.push({ suffix, bytes: value.bytes });
      }
      result.candidates.push(candidate);
      storageCheck(!candidate.files['-journal'], 'unsupported-rollback-journal');
      storageCheck(candidate.files.database || !files.length, 'orphan-sidecar');
      if (candidate.files.database) copies.push({ candidate, files });
    }
    storageCheck(copies.length === 1, copies.length ? 'ambiguous-candidates' : 'missing-candidate');
    noLinks(scratchRoot);
    scratch = fs.mkdtempSync(path.join(scratchRoot, 'creator-mac-storage-'));
    fs.chmodSync(scratch, 0o700);
    const { candidate, files } = copies[0];
    const copiedDb = contained(scratch, path.join(scratch, 'store.sqlite3'));
    for (const { suffix, bytes } of files) fs.writeFileSync(copiedDb + suffix, bytes, { flag: 'wx', mode: 0o600 });
    hooks.afterCopy?.();
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(copiedDb, { readOnly: true, timeout: 1000, allowExtension: false });
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF');
      const schema = db.prepare("SELECT type, sql FROM sqlite_schema WHERE name=? LIMIT 2").all('ItemTable');
      candidate.itemTableSchemaSha256 = schema.length === 1 && typeof schema[0].sql === 'string' ? digest(Buffer.from(schema[0].sql)) : null;
      storageCheck(schema.length === 1 && schema[0].type === 'table'
        && [ITEM_SCHEMA, ITEM_SCHEMA.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ')].includes(schema[0].sql), 'unsupported-item-schema');
      candidate.itemTableSchema = schema[0].sql;
      const values = db.prepare('SELECT typeof(value) AS type, length(value) AS size, substr(value,1,64) AS raw FROM ItemTable WHERE key=? LIMIT 2').all(AUTO_DOWNLOAD_KEY);
      storageCheck(values.length <= 1, 'ambiguous-key');
      result.keyObservation = values.length ? { type: values[0].type, size: values[0].size } : { type: 'missing', size: 0, raw: null };
      if (values.length) {
        const value = values[0];
        storageCheck(value.type === 'blob' && value.size <= 64 && value.size % 2 === 0, 'unsupported-key-type-or-bound');
        const raw = Buffer.from(value.raw);
        result.keyObservation.rawHex = raw.toString('hex');
        result.keyObservation.encoding = 'UTF-16LE';
        result.keyObservation.raw = raw.toString('utf16le');
        storageCheck(['true', 'false'].includes(result.keyObservation.raw), 'unsupported-key-value');
      }
    } finally { db.close(); }
    hooks.beforeRecheck?.();
    for (const [file, before] of observed) {
      const after = storageFile(file, before.max);
      storageCheck(JSON.stringify(after?.receipt || null) === JSON.stringify(before.value?.receipt || null), 'source-drift');
    }
    result.sourceUnchanged = true;
    result.status = 'candidate-key-captured-active-store-unbound';
  } catch (error) {
    result.status = 'unknown';
    result.error = error.storageReason || 'capture-unavailable';
    delete result.keyObservation;
  } finally {
    if (scratch) {
      try {
        noLinks(scratch);
        fs.rmSync(contained(scratchRoot, scratch), { recursive: true });
      } catch { result.status = 'unknown'; result.error = 'scratch-cleanup-failed'; delete result.keyObservation; }
    }
    result.finishedAt = new Date().toISOString();
  }
  return result;
}

function termsState(snapshot) {
  const nodes = snapshot.axNodes || [];
  const hints = nodes.filter(n => [TERMS.checkbox, TERMS.continue].includes(n.AXTitle?.trim()));
  if (hints.length) {
    const checks = hints.filter(n => n.AXRole === 'AXCheckBox' && n.AXTitle === TERMS.checkbox);
    const buttons = hints.filter(n => n.AXRole === 'AXButton' && n.AXTitle === TERMS.continue);
    return hints.length === 2 && checks.length === 1 && buttons.length === 1 ? 'terms' : 'incomplete';
  }
  return nodes.some(n => n.AXRole !== 'AXGroup'
    && /terms of use|risk acknowledgement|accept and continue|agree to these terms/i.test(
      `${n.AXTitle || ''}\n${n.AXDescription || ''}\n${n.AXValue || ''}`)) ? 'incomplete' : 'none';
}

function hasTermsGroup(snapshot) {
  return (snapshot.axNodes || []).some(n => n.AXRole === 'AXGroup'
    && (n.AXTitle === TERMS.title || n.AXDescription === TERMS.title));
}

function bodyKind(snapshot) {
  const nodes = snapshot.axNodes || [];
  const terms = termsState(snapshot);
  if (terms === 'terms') return 'terms';
  if (terms === 'incomplete') return 'chrome-or-unready';
  const text = nodes.map(n => `${n.AXTitle || ''}\n${n.AXValue || ''}`).join('\n');
  if (!nodes.some(n => n.AXRole === 'AXWebArea') || !/\bCreator Works MCP\b/.test(text)) return 'chrome-or-unready';
  // Intel WebKit can retain the closed dialog's empty labelled AXGroup.
  if (hasTermsGroup(snapshot)) {
    const preferences = nodes.filter(n => n.AXRole === 'AXCheckBox' && n.AXTitle === AUTO_DOWNLOAD);
    if (preferences.length !== 1 || preferences[0].AXEnabled !== 'true'
      || !['0', '1'].includes(preferences[0].AXValue)) return 'chrome-or-unready';
  }
  return 'body';
}

function validateBody(snapshot, kind) {
  assert.equal(snapshot.finishedLaunching, true);
  assert.equal(snapshot.windows?.length, 1, 'Exactly one owned visible app window is required');
  assert.equal(snapshot.axReadable, true);
  assert.equal(snapshot.axTruncated, false, 'Incomplete AX trees cannot establish body/terms state');
  assert.ok(snapshot.axNodes.some(n => n.AXRole === 'AXWebArea'), 'Window chrome is not a WebKit body');
  assert.equal(bodyKind(snapshot), kind, kind === 'body' ? 'Terms returned or rendered MCP body is absent' : 'Fresh synthetic terms gate is absent');
}

function termsControl(snapshot, action) {
  assert.ok(['test-terms-checkbox', 'test-terms-accept'].includes(action));
  validateBody(snapshot, 'terms');
  assert.equal(guiBlockers({ accessibilityTrusted: true, screenCaptureAllowed: true, hasDisplay: true }, snapshot, true).length, 0,
    'Possible security/privacy prompt prevents synthetic terms interaction');
  const checks = snapshot.axNodes.filter(n => n.AXRole === 'AXCheckBox' && n.AXTitle === TERMS.checkbox);
  const buttons = snapshot.axNodes.filter(n => n.AXRole === 'AXButton' && n.AXTitle === TERMS.continue);
  assert.equal(checks.length, 1, 'Exact terms checkbox is missing or ambiguous');
  assert.equal(buttons.length, 1, 'Exact terms continue button is missing or ambiguous');
  assert.equal(checks[0].AXValue, action === 'test-terms-checkbox' ? '0' : '1', 'Unexpected synthetic terms check state');
  assert.equal((action === 'test-terms-checkbox' ? checks[0] : buttons[0]).AXEnabled, 'true', 'Terms control is not enabled');
}

function autoDownloadControl(snapshot, expectedValue) {
  assert.ok(['1', '0'].includes(expectedValue));
  validateBody(snapshot, 'body');
  assert.deepEqual(guiBlockers({ accessibilityTrusted: true, screenCaptureAllowed: true, hasDisplay: true }, snapshot), [],
    'Possible terms/security/privacy prompt prevents synthetic preference interaction');
  const matches = snapshot.axNodes.filter(n => n.AXRole === 'AXCheckBox' && n.AXTitle === AUTO_DOWNLOAD);
  assert.equal(matches.length, 1, 'Exact auto-download checkbox is missing or ambiguous');
  assert.equal(matches[0].AXEnabled, 'true', 'Auto-download checkbox is not enabled');
  assert.equal(matches[0].AXValue, expectedValue, 'Unexpected auto-download checkbox state');
}

function preferenceSnapshot(snapshot, launched, expectedValue) {
  for (const key of ['pid', 'bundleIdentifier', 'bundlePath', 'executablePath']) {
    assert.equal(snapshot[key], launched[key], `Preference snapshot ownership mismatch: ${key}`);
  }
  autoDownloadControl(snapshot, expectedValue);
}

function preferenceReceipt(result, launched, version = '0.1.13') {
  assert.ok(['0.1.12', '0.1.13'].includes(version));
  for (const key of ['pid', 'bundleIdentifier', 'bundlePath', 'executablePath']) {
    assert.equal(result[key], launched[key], `Preference action ownership mismatch: ${key}`);
  }
  for (const [key, value] of Object.entries({ action: version === '0.1.12' ? 'test-legacy-auto-download-off' : 'test-auto-download-off', axAction: 'AXPress',
    controlRole: 'AXCheckBox', controlTitle: AUTO_DOWNLOAD, beforeValue: '1', requestedValue: '0',
    targetVersion: version, syntheticTestOnly: true, customerConsent: false, userMachineUsed: false })) {
    assert.equal(result[key], value, `Preference action receipt mismatch: ${key}`);
  }
}

function validatePixels(pixels) {
  for (const key of ['width', 'height', 'sampledPixels', 'distinctColors', 'nonBackgroundSamples']) {
    assert.ok(Number.isSafeInteger(pixels[key]) && pixels[key] >= 0, `Invalid PNG pixel metric: ${key}`);
  }
  assert.ok(pixels.width >= 560 && pixels.height >= 400 && pixels.width <= 4096 && pixels.height <= 4096);
  assert.equal(pixels.chromeExcluded, true, 'Title chrome must not establish body rendering');
  assert.deepEqual(pixels.bodyCrop, { x: Math.floor(pixels.width * 6 / 100), y: Math.floor(pixels.height * 20 / 100),
    width: Math.floor(pixels.width * 88 / 100), height: Math.floor(pixels.height * 60 / 100) }, 'Unexpected body crop');
  assert.ok(pixels.sampledPixels > 1000 && pixels.sampledPixels <= 300000);
  assert.ok(pixels.distinctColors > 32 && pixels.distinctColors <= pixels.sampledPixels);
  assert.ok(pixels.nonBackgroundSamples > 1000 && pixels.nonBackgroundSamples <= pixels.sampledPixels,
    'Rendered body PNG is blank or insufficiently framed');
}

function guiBlockers(capability, snapshot, syntheticFreshTerms = false) {
  const reasons = [];
  if (!capability.accessibilityTrusted) reasons.push('existing-accessibility-capability-absent');
  if (!capability.screenCaptureAllowed) reasons.push('existing-screen-capture-capability-absent');
  if (!capability.hasDisplay) reasons.push('interactive-display-absent');
  if (snapshot) {
    if (!snapshot.finishedLaunching || !snapshot.windows?.length) reasons.push('owned-visible-window-not-observed');
    if (capability.accessibilityTrusted && (!snapshot.axReadable || !snapshot.axNodes?.length || snapshot.axTruncated)) {
      reasons.push('owned-AX-tree-unreadable-or-incomplete');
    }
    const text = JSON.stringify(snapshot.axNodes || []);
    const terms = termsState(snapshot);
    if (terms === 'incomplete' || (terms === 'none' && hasTermsGroup(snapshot) && bodyKind(snapshot) !== 'body')) {
      reasons.push('terms-controls-or-body-unready-no-interaction-performed');
    } else if (!syntheticFreshTerms && terms === 'terms') {
      reasons.push('legal-acknowledgement-requires-human-no-acceptance-performed');
    }
    if (/privacy|security|permission|allow access|damaged|cannot be opened|unidentified developer/i.test(text)) {
      reasons.push('possible-security-privacy-prompt-no-interaction-performed');
    }
  }
  return reasons;
}

function newReport(input) {
  return { schemaVersion: 1, scope: 'macos-hub-native-install-manual-upgrade-synthetic-terms-rendering-and-auto-download-relaunch',
    releaseLine: 'separate-apps', input, passed: false, releaseReady: false, userMachineUsed: false,
    executionSourceSha: process.env.GITHUB_SHA || null,
    historicalFailures: [{ runUrl: `https://github.com/${REPO}/actions/runs/38392823489`,
      evidence: 'docs/MAINTENANCE-0.1.13-GATES.md#first-native-ci-findings',
      retained: true, replacedByThisReport: false }],
    historicalNativeReports: [{ runUrl: `https://github.com/${REPO}/actions/runs/38402267985`,
      evidence: `artifacts/mac-body-${input.architecture === 'X64' ? 'intel' : 'arm'}-38402267985/native-report.json`,
      scope: 'macos-hub-native-install-manual-upgrade-and-read-only-gui-probe',
      status: 'blocked', failureCount: 0, releaseReady: false, retained: true, replacedByThisReport: false,
      blockers: ['gatekeeper-assessment-not-accepted-no-policy-bypass',
        ...(input.architecture === 'ARM64' ? ['declared-bundle-minimum-below-executable-minimum'] : []),
        'legal-acknowledgement-requires-human-no-acceptance-performed'] }],
    sourceKind: input.lane === 'fresh' ? 'exact-ci-0.1.13-fresh-dmg-install' : 'unmodified-public-0.1.12-manual-dmg-upgrade',
    updater: { tested: false, publicDiscovery: false, nativeCancellation: false, consent: false,
      automaticRestart: false, reason: 'Public 0.1.12 native in-app updater is Windows-only; manual launches are not updater restart proof.' },
    syntheticTerms: { testOnly: true, customerConsent: false, actions: [] }, termsPersistenceTested: false,
    syntheticPreference: { testOnly: true, customerConsent: false, controlTitle: AUTO_DOWNLOAD, actions: [] },
    webkitPreferenceDiagnostics: { acceptanceEvidence: false, activeStoreBound: false, rootCause: 'unknown', captures: [] },
    autoDownloadPreferencePersistenceTested: false,
    effectivePreferencesScope: input.lane === 'legacy-preferences' ? 'public-0.1.12-auto-download-off-migration-and-0.1.13-relaunch' : '0.1.13-auto-download-normal-quit-relaunch-only',
    legacyAutoDownloadMigrationTested: false, otherBrowserPreferencesTested: false,
    aiWorkflowTested: false, unityWorkflowTested: false,
    effectivePreferencesTested: false, realCompanionInstallsTested: false, liveClientReconnectTested: false,
    blockers: [], failures: [], launches: [], mounts: [], cleanup: [] };
}

async function runLane(report, ops) {
  const input = report.input;
  const owned = [];
  const captureStopped = async (launched, stopped) => {
    if (!stopped.normalQuitRequested || stopped.alreadyExited || !stopped.exited || stopped.forceKillPerformed !== false) return;
    const row = report.launches.find(row => row.pid === launched.pid);
    let captured;
    try { captured = await ops.captureStorage(launched, stopped); }
    catch { captured = { status: 'unknown', error: 'capture-unavailable' }; }
    report.webkitPreferenceDiagnostics.captures.push({ version: row.version, purpose: row.purpose,
      pid: launched.pid, normalExitVerified: true, ...captured });
  };
  try {
    report.capability = await ops.probe();
    report.blockers.push(...guiBlockers(report.capability));
    await ops.preflight();
    const legacyPreferences = input.lane === 'legacy-preferences';
    const versions = input.lane === 'fresh' ? ['0.1.13'] : ['0.1.12', '0.1.13'];
    for (const version of versions) {
      report.currentPhase = `install-${version}`;
      const installed = await ops.install(version);
      (report.installs ||= []).push(installed);
      if (installed.bundle?.gatekeeper?.status !== 0) report.blockers.push('gatekeeper-assessment-not-accepted-no-policy-bypass');
      if (installed.bundle?.bundleMinimumCoversExecutable === false) report.blockers.push('declared-bundle-minimum-below-executable-minimum');
      if (!report.sentinels) report.sentinels = await ops.seed();
      const canInspect = report.capability.accessibilityTrusted && report.capability.screenCaptureAllowed && report.capability.hasDisplay;
      for (const purpose of canInspect ? ['initial', 'relaunch'] : ['initial']) {
        report.currentPhase = `launch-${version}-${purpose}`;
        const launched = await ops.launch(version);
        assert.ok(Number.isSafeInteger(launched.pid) && launched.pid > 0, 'Real installed GUI PID is required');
        assert.equal(launched.bundleIdentifier, 'com.creatorworks.hub');
        assert.equal(launched.bundlePath, installed.appPath);
        assert.equal(launched.executablePath, installed.executablePath);
        assert.ok(!report.launches.some(l => l.pid === launched.pid), 'Every normal open must have a distinct PID');
        owned.push(launched);
        const row = { version, purpose, ...launched, captures: [], method: 'NSWorkspace-normal-open-not-updater-restart' };
        report.launches.push(row);
        let snapshot = await ops.snapshot(launched);
        row.snapshot = snapshot;
        const freshTerms = version === versions[0] && purpose === 'initial';
        const blockers = guiBlockers(report.capability, snapshot, canInspect && freshTerms);
        report.blockers.push(...blockers);
        if (canInspect && !blockers.length) {
          const capture = async kind => {
            validateBody(snapshot, kind);
            const captured = await ops.capture(launched, `${version}-${purpose}-${kind}`, kind);
            assert.equal(captured.pid, launched.pid);
            assert.equal(captured.bodyKind, kind);
            assert.match(captured.sha256, /^[a-f0-9]{64}$/);
            assert.equal(captured.screenshot, `owned-gui-${version}-${purpose}-${kind}-${launched.pid}.png`);
            validatePixels(captured.pixels);
            row.captures.push({ kind, ...captured });
          };
          if (freshTerms) {
            report.currentPhase = `synthetic-terms-${version}`;
            termsControl(snapshot, 'test-terms-checkbox');
            await capture('terms');
            for (const action of ['test-terms-checkbox', 'test-terms-accept']) {
              termsControl(snapshot, action);
              const result = await ops.pressTerms(launched, action);
              assert.equal(result.pid, launched.pid);
              assert.equal(result.bundlePath, installed.appPath);
              assert.equal(result.executablePath, installed.executablePath);
              assert.equal(result.bundleIdentifier, 'com.creatorworks.hub');
              assert.equal(result.action, action);
              assert.equal(result.axAction, 'AXPress');
              assert.equal(result.syntheticTestOnly, true);
              assert.equal(result.customerConsent, false);
              assert.equal(result.userMachineUsed, false);
              report.syntheticTerms.actions.push({ version, ...result });
              snapshot = await ops.waitSnapshot(launched, action === 'test-terms-checkbox' ? 'checked' : 'body');
            }
            row.afterTermsSnapshot = snapshot;
          }
          report.currentPhase = `rendered-body-${version}-${purpose}`;
          await capture('body');
          row.renderedBodyVerified = true;
          row.persistedSyntheticTerms = !freshTerms;
          if ((version === '0.1.13' || legacyPreferences) && (purpose === 'initial' || report.launches.some(previous =>
            previous.version === version && previous.purpose === 'initial' && previous.autoDownloadOffVerified === true))) {
            report.currentPhase = `auto-download-${version}-${purpose}`;
            if (purpose === 'initial' && (!legacyPreferences || version === '0.1.12')) {
              preferenceSnapshot(snapshot, launched, '1');
              row.beforeAutoDownloadSnapshot = snapshot;
              const result = legacyPreferences ? await ops.pressLegacyAutoDownloadOff(launched) : await ops.pressAutoDownloadOff(launched);
              preferenceReceipt(result, launched, version);
              report.syntheticPreference.actions.push({ version, ...result });
              snapshot = await ops.waitSnapshot(launched, 'auto-download-off');
              row.afterAutoDownloadSnapshot = snapshot;
            } else {
              row.relaunchedAutoDownloadSnapshot = snapshot;
            }
            preferenceSnapshot(snapshot, launched, '0');
            row.autoDownloadOffVerified = true;
          }
        }
        report.currentPhase = `normal-quit-${version}-${purpose}`;
        launched.quitAttempted = true;
        const stopped = await ops.quit(launched);
        report.cleanup.push({ version, purpose, pid: launched.pid, ...stopped });
        assert.equal(stopped.normalQuitRequested, true, 'Owned process did not receive normal quit');
        assert.equal(stopped.alreadyExited === true, false, 'An earlier exit is not normal-quit proof');
        assert.equal(stopped.exited, true, 'Owned app did not quit normally; replacement is refused');
        assert.equal(stopped.forceKillPerformed, false, 'Force termination is outside this probe');
        owned.pop();
        await captureStopped(launched, stopped);
        report.preservation = await ops.preserve(report.sentinels);
      }
    }
    report.termsPersistenceTested = versions.every(version => report.launches.some(row =>
      row.version === version && row.purpose === 'relaunch' && row.renderedBodyVerified === true));
    report.autoDownloadPreferencePersistenceTested = report.syntheticPreference.actions.length === 1
      && ['initial', 'relaunch'].every(purpose => report.launches.some(row => row.version === '0.1.13'
        && row.purpose === purpose && row.autoDownloadOffVerified === true));
    report.effectivePreferencesTested = report.autoDownloadPreferencePersistenceTested;
    report.legacyAutoDownloadMigrationTested = legacyPreferences && report.autoDownloadPreferencePersistenceTested
      && report.syntheticPreference.actions[0]?.version === '0.1.12'
      && report.launches.length === 4 && report.launches.every(row => row.autoDownloadOffVerified === true);
    if (input.lane !== 'fresh') report.manualUpgradeTermsPreserved = report.termsPersistenceTested
      && report.launches.filter(row => row.version === '0.1.13').every(row => row.persistedSyntheticTerms === true);
    report.packageAndManualChecksPassed = true;
  } catch (error) {
    report.failures.push({ phase: report.currentPhase || 'preflight', error: String(error.stack || error) });
  } finally {
    for (const launched of owned) {
      if (launched.quitAttempted) continue;
      try {
        const stopped = await ops.quit(launched);
        report.cleanup.push({ pid: launched.pid, ...stopped });
        if (!stopped.normalQuitRequested || stopped.alreadyExited || !stopped.exited || stopped.forceKillPerformed !== false) {
          report.failures.push({ phase: 'cleanup', error: 'Owned normal-quit proof incomplete; no retry or force kill attempted' });
        }
        await captureStopped(launched, stopped);
      } catch (error) { report.failures.push({ phase: 'cleanup', error: String(error) }); }
    }
    if (report.sentinels) {
      try { report.finalPreservation = await ops.preserve(report.sentinels); }
      catch (error) { report.failures.push({ phase: 'final-preservation', error: String(error) }); }
    }
    try { await ops.detach(); } catch (error) { report.failures.push({ phase: 'detach', error: String(error) }); }
    report.blockers = [...new Set(report.blockers)];
    report.status = report.failures.length ? 'failed' : report.blockers.length ? 'blocked' : 'passed-bounded-scope-only';
    report.passed = report.packageAndManualChecksPassed === true && !report.failures.length && !report.blockers.length;
    // This bounded harness cannot produce a signed-update/restart receipt, even if every check passes.
    report.releaseReady = false;
  }
  return report;
}

function nativeOperations(out, binding, report) {
  const home = fs.realpathSync(os.homedir());
  const applications = contained(home, path.join(home, 'Applications'));
  const app = contained(applications, path.join(applications, 'Creator Hub.app'));
  const helper = path.join(out, 'native-mac-window');
  const activeMounts = [];
  let storeWasAbsent = false;
  const window = (args, synthetic = '') => {
    assert.ok(['', 'terms', 'preference'].includes(synthetic));
    const result = JSON.parse(command(helper, args, false,
      { CREATOR_MAC_SYNTHETIC_TERMS_TEST: synthetic === 'terms' ? '1' : '',
        CREATOR_MAC_SYNTHETIC_PREFERENCE_TEST: synthetic === 'preference' ? '1' : '' }).stdout);
    if (result.error) throw Error(`Native Mac helper: ${result.error}`);
    return result;
  };
  const observe = async (launched, wanted = 'either') => {
    let snapshot;
    for (const end = Date.now() + 60000; Date.now() < end;) {
      snapshot = window(['snapshot', String(launched.pid), app, launched.executablePath]);
      if (!report.capability.accessibilityTrusted) return snapshot;
      if (snapshot.finishedLaunching && snapshot.windows.length === 1 && snapshot.axReadable && !snapshot.axTruncated) {
        const kind = bodyKind(snapshot);
        const preferences = snapshot.axNodes.filter(node => node.AXRole === 'AXCheckBox' && node.AXTitle === AUTO_DOWNLOAD);
        const bodyReady = kind === 'body' && preferences.length === 1 && preferences[0].AXEnabled === 'true'
          && ['0', '1'].includes(preferences[0].AXValue);
        if (wanted === 'either' && (kind === 'terms' || bodyReady)) return snapshot;
        if (wanted === 'body' && bodyReady) return snapshot;
        if (wanted === 'checked') {
          try { termsControl(snapshot, 'test-terms-accept'); return snapshot; } catch {}
        }
        if (wanted === 'auto-download-off') {
          try { preferenceSnapshot(snapshot, launched, '0'); return snapshot; } catch {}
        }
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw Error(`Native WebKit ${wanted} state unavailable; chrome is not rendered-app acceptance`);
  };
  return {
    probe: () => window(['probe']),
    preflight: () => {
      noLinks(home); noLinks(app); noLinks(helper);
      assert.equal(fs.existsSync(app), false, 'Refusing to replace an existing app');
      assert.equal(fs.existsSync('/Applications/Creator Hub.app'), false, 'System-wide Hub must not be touched');
      assert.equal(window(['inventory']).running.length, 0, 'An unrelated running Hub exists');
      const store = path.join(home, 'Library', 'WebKit', 'com.creatorworks.hub');
      noLinks(store);
      storeWasAbsent = !fs.existsSync(store);
      fs.mkdirSync(applications, { recursive: true });
    },
    install: version => {
      const dmg = path.join(out, version === '0.1.12' ? 'baseline.dmg' : 'candidate.dmg');
      const expectedHash = version === '0.1.12' ? BASELINES[binding.input.architecture].sha256 : binding.input.dmgSha256;
      assert.equal(digest(boundedFile(dmg)), expectedHash);
      const mount = path.join(out, `mount-${version}`);
      fs.mkdirSync(mount);
      // A possibly partial attach is retained for a normal detach on failure, never a force detach.
      activeMounts.push(mount);
      command('/usr/bin/hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount]);
      report.mounts.push({ version, mount, attached: true });
      const source = path.join(mount, 'Creator Hub.app');
      const expected = { version, architecture: binding.input.architecture,
        ...(version === '0.1.13' ? { executableSha256: binding.input.executableSha256,
          configuredMinimumSystemVersion: binding.source.configuredMinimumSystemVersion } : {}) };
      const before = inspectBundle(source, expected);
      if (fs.existsSync(app)) {
        assert.equal(version, '0.1.13');
        assert.equal(window(['inventory']).running.length, 0, 'Never replace a running app');
        noLinks(app);
        const backup = path.join(out, 'retained-public-0.1.12.app');
        assert.equal(fs.existsSync(backup), false);
        fs.renameSync(app, backup);
        report.retainedBaselineApp = backup;
      }
      command('/usr/bin/ditto', [source, app]);
      const after = inspectBundle(app, { ...expected, executableSha256: before.executableSha256 });
      command('/usr/bin/hdiutil', ['detach', mount]);
      activeMounts.pop();
      return { version, dmgSha256: expectedHash, appPath: app,
        executablePath: path.join(app, 'Contents', 'MacOS', 'creator-hub'), bundle: after,
        method: version === '0.1.13' && binding.input.lane !== 'fresh' ? 'manual-dmg-replacement-old-app-retained' : 'fresh-dmg-copy',
        rollback: 'Original app retained; a failed replacement is not hidden or retried automatically' };
    },
    seed: () => seedSentinels(home),
    preserve: sentinels => verifySentinels(sentinels),
    launch: () => window(['launch', app]),
    snapshot: launched => observe(launched),
    waitSnapshot: (launched, wanted) => observe(launched, wanted),
    pressTerms: (launched, action) => {
      guard();
      assert.ok(['test-terms-checkbox', 'test-terms-accept'].includes(action));
      return window([action, String(launched.pid), app, launched.executablePath], 'terms');
    },
    pressAutoDownloadOff: launched => {
      guard();
      return window(['test-auto-download-off', String(launched.pid), app, launched.executablePath], 'preference');
    },
    pressLegacyAutoDownloadOff: launched => {
      guard();
      return window(['test-legacy-auto-download-off', String(launched.pid), app, launched.executablePath], 'preference');
    },
    capture: (launched, label, kind) => {
      const snapshot = window(['snapshot', String(launched.pid), app, launched.executablePath]);
      validateBody(snapshot, kind);
      assert.deepEqual(guiBlockers(report.capability, snapshot, kind === 'terms'), [], 'Capture state has a GUI blocker');
      assert.equal(window(['probe']).screenCaptureAllowed, true, 'Existing capture capability disappeared');
      const screenshot = contained(out, path.join(out, `owned-gui-${label}-${launched.pid}.png`));
      assert.equal(fs.existsSync(screenshot), false);
      command('/usr/sbin/screencapture', ['-x', '-l', String(snapshot.windows[0].id), screenshot]);
      const after = window(['snapshot', String(launched.pid), app, launched.executablePath]);
      validateBody(after, kind);
      assert.deepEqual(guiBlockers(report.capability, after, kind === 'terms'), [], 'Capture state gained a GUI blocker');
      assert.equal(after.windows[0].id, snapshot.windows[0].id, 'Owned capture window changed');
      const pixels = window(['pixels', screenshot]);
      return { pid: launched.pid, bodyKind: kind, windowId: snapshot.windows[0].id,
        screenshot: path.basename(screenshot), sha256: digest(boundedFile(screenshot, 64 * 1024 * 1024)), pixels };
    },
    quit: launched => window(['quit', String(launched.pid), app, launched.executablePath]),
    captureStorage: () => {
      guard();
      if (!storeWasAbsent) return { status: 'unknown', error: 'store-preexisted-disposable-lane' };
      if (window(['inventory']).running.length) return { status: 'unknown', error: 'hub-still-running' };
      const temp = fs.realpathSync(process.env.RUNNER_TEMP);
      contained(temp, out);
      return captureWebKitPreference(home, temp);
    },
    detach: () => {
      const errors = [];
      for (const mount of activeMounts) {
        const result = command('/usr/bin/hdiutil', ['detach', mount], true);
        report.cleanup.push({ mount, detach: result });
        if (result.status !== 0) errors.push(result);
      }
      assert.equal(errors.length, 0, `Normal detach failed; mount retained: ${JSON.stringify(errors)}`);
    },
  };
}

async function main() {
  guard();
  const input = options();
  const temp = fs.realpathSync(process.env.RUNNER_TEMP);
  const out = contained(temp, process.env.CREATOR_MAC_WORK_DIR);
  noLinks(out);
  const mode = process.argv[2];
  assert.ok(['--download', '--run'].includes(mode) && process.argv.length === 3);
  if (mode === '--download') fs.mkdirSync(out, { mode: 0o700 });
  else assert.ok(fs.lstatSync(out).isDirectory());
  const report = newReport(input);
  try {
    if (mode === '--download') await prepare(out, input, report);
    else {
      const binding = JSON.parse(boundedFile(path.join(out, 'binding.json'), 32768));
      assert.equal(binding.schemaVersion, 1);
      assert.equal(binding.releaseLine, 'separate-apps');
      assert.deepEqual(binding.input, input);
      assert.equal(digest(boundedFile(path.join(out, 'candidate-artifact.zip'))), binding.artifact.sha256);
      report.binding = binding;
      report.guiHelperSha256 = digest(boundedFile(path.join(out, 'native-mac-window')));
      await runLane(report, nativeOperations(out, binding, report));
    }
  } catch (error) {
    report.status = 'failed';
    report.failures.push({ phase: mode, error: String(error.stack || error) });
  }
  report.releaseReady = false;
  writeJson(path.join(out, mode === '--download' ? 'download-report.json' : 'native-report.json'), report);
  console.log(JSON.stringify({ out, status: report.status || (report.passed ? 'download-verified' : 'failed'),
    passed: report.passed, releaseReady: false, blockers: report.blockers, failures: report.failures }, null, 2));
  process.exitCode = report.failures.length ? 1 : report.blockers.length ? 2 : report.passed ? 0 : 1;
}

module.exports = { BASELINES, BASELINE_SOURCE, CANDIDATE, TERMS, AUTO_DOWNLOAD, PROBE_FILES, REVIEWED_TEST_ONLY_FILES, TREE_EXCLUSIONS,
  options, guard, contained, noLinks, digest, validateBinding, AUTO_DOWNLOAD_KEY, WEBKIT_ROOT, ITEM_SCHEMA, captureWebKitPreference,
  parseLocalTree, verifyProductTree,
  validateSource, zipEntry, validateBundle, atLeast, sentinelFiles, seedSentinels, verifySentinels,
  termsState, bodyKind, validateBody, termsControl, autoDownloadControl, preferenceSnapshot, preferenceReceipt,
  validatePixels, guiBlockers, newReport, runLane };
if (require.main === module) main().catch(error => { console.error(String(error.stack || error)); process.exitCode = 1; });
