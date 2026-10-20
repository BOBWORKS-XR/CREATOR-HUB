// One failed-CI Intel archive, diagnostic repack only. No source rebuild or signing.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const worker = require('./macos-dmg.cjs');
const unix = require('./unix-package-payload.cjs');
const { moduleFiles } = require('./build-unified.cjs');

const PIN = Object.freeze({ repository: 'BOBWORKS-XR/CREATOR-HUB', repositoryId: 1364807512,
  workflow: '.github/workflows/unified-unix-candidate.yml', workflowId: 382663584,
  runId: 38469742692, runAttempt: 1, jobId: 115545435770, artifactId: 11853171218,
  head: 'edc59c55f336cda496c373f2475e94becf9e797e', merge: '64d8bf746ae48ca6c3709554d23bee9d2f8cb595',
  base: '35a16a45814d821d65b5d203628478449174cd55', tree: '516200e15ea2ecf7c11d3a9f0e93e5d8bc5b78ef',
  zipBytes: 54307809, zipSha256: '234b8d395ae3bc22a2d3e19e0be6a8a8e22e13adc636414a12589ba8e88ecad2',
  tarBytes: 54843140, tarSha256: 'b4f17dca258794290801effbafb38beba1ca526a11c2eb8f2ab4176534a72a26',
  rawTarBytes: 171824128, manifestBytes: 1457, manifestSha256: '6315d6444a933e34074ff67c9e37fac691804fcfdcf0a3a8e516867c4b0dfe0f' });
const FALSE_GATES = Object.freeze({ releaseReady: false, productAccepted: false, migrationAccepted: false,
  updateAccepted: false, nativeGuiAccepted: false, managedGuiAccepted: false, sourcePackageAdmitted: false });
const requireValue = (v, message) => { if (!v) throw Error(message); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => file.startsWith(root + path.sep);

function admission(env, platform, arch) {
  requireValue(platform === 'darwin' && arch === 'x64', 'Pinned source is Intel only; native matching Mac required.');
  requireValue(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
    && env.RUNNER_OS === 'macOS' && env.RUNNER_ARCH === 'X64' && env.CREATOR_MACOS_DMG_EXPERIMENT === '1',
  'Explicit disposable Intel Mac packaging runner required.');
  unix.packageEnvironment(env, 'macos');
  requireValue(env.CREATOR_MACOS_DMG_REPACK === '1' && env.GITHUB_REPOSITORY === PIN.repository
    && env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/validation/mac-dmg-repack-014',
  'Dedicated disposable diagnostic push lane required.');
}

function parseArgs(args) {
  requireValue(args.length === 4 && args[0] === '--target' && args[1] === 'macos-intel' && args[2] === '--output',
    'Use --target macos-intel --output NEW_ABSOLUTE_RUNNER_TEMP_DIRECTORY; no source-pin overrides.');
  requireValue(path.isAbsolute(args[3]) && path.resolve(args[3]) === args[3], 'New absolute output required.');
  return args[3];
}

function validateSource({ run, job, artifact, head, merge }) {
  assert.equal(run.id, PIN.runId); assert.equal(run.head_sha, PIN.head); assert.equal(run.run_attempt, PIN.runAttempt);
  assert.equal(run.path, PIN.workflow); assert.equal(run.workflow_id, PIN.workflowId);
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'failure'); assert.equal(run.event, 'pull_request');
  assert.equal(run.head_branch, 'feature/unified-creator-hub');
  for (const r of [run.repository, run.head_repository]) {
    assert.equal(r.id, PIN.repositoryId); assert.equal(r.full_name, PIN.repository);
  }
  assert.ok(Array.isArray(run.pull_requests) && run.pull_requests.length <= 1);
  for (const pr of run.pull_requests) {
    assert.equal(pr.number, 21); assert.equal(pr.head.sha, PIN.head); assert.equal(pr.base.sha, PIN.base);
    assert.equal(pr.head.repo.id, PIN.repositoryId); assert.equal(pr.base.repo.id, PIN.repositoryId);
  }
  assert.equal(head.sha, PIN.head); assert.equal(head.tree.sha, PIN.tree);
  assert.equal(merge.sha, PIN.merge); assert.equal(merge.tree.sha, PIN.tree);
  assert.deepEqual(merge.parents.map(p => p.sha), [PIN.base, PIN.head]);
  assert.equal(job.id, PIN.jobId); assert.equal(job.run_id, PIN.runId); assert.equal(job.run_attempt, PIN.runAttempt);
  assert.equal(job.head_sha, PIN.head); assert.equal(job.name, 'candidate (macos-15-intel)');
  assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'failure');
  assert.deepEqual(job.labels, ['macos-15-intel']); assert.equal(job.runner_group_name, 'GitHub Actions');
  const build = job.steps.filter(s => s.name === 'Build and inspect real included payloads (MCP deliberately read-only)');
  const retained = job.steps.filter(s => s.name === 'Retain the actual failed Mac DMG inputs without changing their signatures');
  assert.equal(build.length, 1); assert.equal(build[0].conclusion, 'failure');
  assert.equal(retained.length, 1); assert.equal(retained[0].conclusion, 'success');
  assert.equal(artifact.id, PIN.artifactId); assert.equal(artifact.expired, false);
  assert.equal(artifact.name, `unified-unix-candidate-macOS-X64-${PIN.merge}`);
  assert.equal(artifact.digest, `sha256:${PIN.zipSha256}`); assert.equal(artifact.size_in_bytes, PIN.zipBytes);
  assert.equal(artifact.workflow_run.id, PIN.runId); assert.equal(artifact.workflow_run.head_sha, PIN.head);
  assert.equal(artifact.workflow_run.repository_id, PIN.repositoryId); assert.equal(artifact.workflow_run.head_repository_id, PIN.repositoryId);
  const start = Date.parse(job.started_at), created = Date.parse(artifact.created_at), end = Date.parse(job.completed_at);
  assert.ok(Number.isFinite(start) && Number.isFinite(created) && Number.isFinite(end) && start <= created && created <= end);
  return { ...PIN, sourceConclusion: 'failure', sourcePrMetadataPresent: run.pull_requests.length === 1,
    scope: 'retained-failed-CI-input-provenance-only', ...FALSE_GATES };
}

function fileHash(file, limit) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    requireValue(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(limit)
      && before.uid === BigInt(process.getuid?.() ?? Number(before.uid)), 'Owned bounded single-link file required.');
    const h = crypto.createHash('sha256'), block = Buffer.alloc(65536);
    let total = 0, count;
    while ((count = fs.readSync(fd, block, 0, block.length, null))) {
      total += count; requireValue(total <= limit, 'File grew beyond bound.'); h.update(block.subarray(0, count));
    }
    const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true });
    for (const key of ['dev', 'ino', 'mode', 'size', 'uid', 'nlink', 'mtimeNs', 'ctimeNs']) {
      requireValue(before[key] === after[key] && after[key] === named[key], 'File identity changed during capture.');
    }
    requireValue(BigInt(total) === before.size, 'File length changed.');
    return { sha256: h.digest('hex'), bytes: total };
  } finally { fs.closeSync(fd); }
}

// Standard parsers, but no general archive extraction: physical TAR headers are
// checked before BSD tar sees the exact pinned, link-free 26-entry app archive.
const ARCHIVE_SCRIPT = String.raw`
import sys,os,io,json,zipfile,tarfile,gzip,hashlib,stat
spec=json.loads(sys.argv[1]); source=sys.argv[2]; dest=sys.argv[3]
def check(v,s):
    if not v: raise RuntimeError(s)
def sha(b): return hashlib.sha256(b).hexdigest()
data=open(source,'rb').read(spec['zipBytes']+1)
check(len(data)==spec['zipBytes'] and sha(data)==spec['zipSha256'],'ZIP pin mismatch')
check(os.path.realpath(dest)==dest and os.path.isdir(dest) and not os.listdir(dest),'New unredirected empty input root required')
names={'builtin-manifest.json','dmg-failure-inputs/bundle_dmg.sh','dmg-failure-inputs/signed-app-before-dmg.tar.gz'}
with zipfile.ZipFile(io.BytesIO(data)) as z:
    infos=z.infolist()
    check(len(infos)==3 and {i.filename for i in infos}==names,'Unexpected/duplicate ZIP member')
    for i in infos:
        check(not i.is_dir() and not i.flag_bits&1 and stat.S_ISREG(i.external_attr>>16),'Nonregular/encrypted ZIP member')
    check(z.getinfo('builtin-manifest.json').file_size==spec['manifestBytes'],'Manifest bound differs')
    check(z.getinfo('dmg-failure-inputs/signed-app-before-dmg.tar.gz').file_size==spec['tarBytes'],'TAR bound differs')
    manifest=z.read('builtin-manifest.json'); archive=z.read('dmg-failure-inputs/signed-app-before-dmg.tar.gz')
check(sha(manifest)==spec['manifestSha256'] and sha(archive)==spec['tarSha256'],'Selected member hash mismatch')
with gzip.GzipFile(fileobj=io.BytesIO(archive)) as g: raw=g.read(spec['rawTarBytes']+1)
check(len(raw)==spec['rawTarBytes'],'Uncompressed TAR bound differs')
expected=spec['paths']; directories=set(spec['directories']); rows=[]; seen=set(); pos=0; ended=False
while pos+512<=len(raw):
    block=raw[pos:pos+512]
    if block==bytes(512):
        check(raw[pos:pos+1024]==bytes(1024) and not any(raw[pos:]),'Malformed/trailing TAR data')
        ended=True; break
    m=tarfile.TarInfo.frombuf(block,'utf-8','strict')
    check(m.type in (tarfile.REGTYPE,tarfile.DIRTYPE) and not m.linkname and not m.pax_headers,'Links/extensions/special TAR types refused')
    name=m.name.rstrip('/') if m.isdir() else m.name
    check(m.name in (name,name+'/') and name in expected and name not in seen,'Unexpected/duplicate/noncanonical TAR path')
    check(m.isdir()==(name in directories),'TAR file/directory type differs from reviewed layout')
    check(m.mode==expected[name] and (not m.isdir() or m.size==0) and 0<=m.size<=128*1024*1024,'TAR mode/size refused')
    check(m.uid>=0 and m.gid>=0 and isinstance(m.mtime,int) and m.mtime>0,'TAR metadata refused')
    end=pos+512+m.size; check(end<=len(raw),'Truncated TAR member')
    row={'path':name,'mode':m.mode,'size':m.size,'type':'directory' if m.isdir() else 'file','mtime':m.mtime,'uid':m.uid,'gid':m.gid}
    if not m.isdir(): row['sha256']=sha(raw[pos+512:end])
    rows.append(row); seen.add(name); pos=pos+512+((m.size+511)//512)*512
    check(len(rows)<=26,'TAR entry bound exceeded')
check(ended and seen==set(expected) and len(rows)==26,'Incomplete reviewed TAR app layout')
for name,blob in [('builtin-manifest.json',manifest),('signed-app-before-dmg.tar.gz',archive)]:
    with open(os.path.join(dest,name),'xb') as out: out.write(blob)
print(json.dumps({'members':rows,'linkCount':0,'extensionCount':0,'zipSha256':sha(data),'tarSha256':sha(archive),'manifestSha256':sha(manifest)}))
`;

function archiveSpec() {
  const paths = {};
  const directories = new Set(['Creator Hub.app']);
  const files = ['Contents/Info.plist', 'Contents/Resources/icon.icns', 'Contents/_CodeSignature/CodeResources',
    'Contents/MacOS/creator-hub', ...[...moduleFiles('mcp', 'macos'), ...moduleFiles('setup', 'macos')].map(n => `Contents/Resources/modules/${n}`)];
  const executables = new Set(['Contents/MacOS/creator-hub', 'Contents/Resources/modules/mcp/creator-works-mcp-launcher',
    'Contents/Resources/modules/setup/creator-project-setup', 'Contents/Resources/modules/mcp/server/runtime/node',
    'Contents/Resources/modules/mcp/server/creator-works-mcp.mjs']);
  paths['Creator Hub.app'] = 0o755;
  for (const name of files) {
    const full = `Creator Hub.app/${name}`; paths[full] = executables.has(name) ? 0o755 : 0o644;
    for (let dir = path.posix.dirname(full); dir !== '.'; dir = path.posix.dirname(dir)) {
      paths[dir] = 0o755; directories.add(dir);
    }
  }
  assert.equal(Object.keys(paths).length, 26);
  assert.equal(directories.size, 12);
  return { ...PIN, paths, directories: [...directories] };
}

function verifyExtracted(app, archive) {
  const inventory = worker.appInventory(app);
  const expected = archive.members.map(m => ({ path: m.path === 'Creator Hub.app' ? '' : m.path.slice('Creator Hub.app/'.length),
    type: m.type, mode: m.mode, ...(m.type === 'file' ? { size: m.size, sha256: m.sha256 } : {}) }));
  const order = list => [...list].sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(order(inventory.entries), order(expected), 'Extracted app differs from reviewed TAR bytes/modes/types.');
  for (const m of archive.members) {
    const file = path.join(path.dirname(app), m.path);
    assert.equal(Math.trunc(fs.lstatSync(file).mtimeMs / 1000), m.mtime, 'Original TAR mtime was not preserved.');
  }
  return inventory;
}

function verifyMounted(source, extracted, manifest, descriptor, hubSha256) {
  const result = unix.verifyResources(path.join(extracted, 'Contents/Resources/modules'), manifest);
  const image = fs.readFileSync(path.join(extracted, 'Contents/MacOS/creator-hub'));
  requireValue(hash(image) === hubSha256 && image.includes(descriptor), 'Mounted DMG Hub/embedded original manifest differs.');
  const tree = worker.appInventory(extracted);
  requireValue(tree.sha256 === source.sha256, 'Mounted/extracted whole signed app differs from original.');
  return { treeSha256: tree.sha256, hubSha256, files: result };
}

async function run(output) {
  const env = process.env;
  admission(env, process.platform, process.arch);
  worker.assertNativeRunner(true);
  const temporary = fs.realpathSync(env.RUNNER_TEMP);
  requireValue(inside(temporary, output) && fs.realpathSync(path.dirname(output)) === path.dirname(output), 'New output must be within canonical runner temp.');
  fs.mkdirSync(output, { mode: 0o700 });
  const input = path.join(output, 'input'), logs = path.join(output, 'logs');
  fs.mkdirSync(input, { mode: 0o700 }); fs.mkdirSync(logs, { mode: 0o700 });
  const reportFile = path.join(output, 'repack-report.json');
  const report = { schemaVersion: 1, scope: 'readonly14-failed-Intel-app-headless-repack-diagnostic', status: 'failed',
    ...FALSE_GATES, tools: [], baselineOrigin: 'diagnostic capture from verified failed-CI archive; no independent old signed-Hub baseline',
    harnessCommit: env.GITHUB_SHA, harnessRunId: env.GITHUB_RUN_ID };
  let source, app, preserved, descriptor, failure;
  const originalArchives = [];
  const ghHome = path.join(output, 'gh-home'); fs.mkdirSync(ghHome, { mode: 0o700 });
  function command(file, args, outputFile, api = false) {
    const index = report.tools.length + 1;
    const stdout = outputFile || path.join(logs, `${index}.stdout`), stderr = path.join(logs, `${index}.stderr`);
    const record = { file, args, stdout: path.relative(output, stdout), stderr: path.relative(output, stderr) };
    report.tools.push(record);
    const out = fs.openSync(stdout, 'wx'), err = fs.openSync(stderr, 'wx');
    try {
      // Sync unix.extract adapter: file-backed stdio, no implicit timeout/maxBuffer kill.
      // The disposable job deadline bounds hangs; no recovery process signals are sent.
      execFileSync(file, args, { cwd: output, stdio: ['ignore', out, err],
        env: api ? { PATH: env.PATH, HOME: ghHome, GH_CONFIG_DIR: ghHome, GH_HOST: 'github.com', GH_TOKEN: env.GH_TOKEN }
          : { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: output, TMPDIR: output, LANG: 'C', LC_ALL: 'C' } });
      record.exitCode = 0;
    } catch (error) {
      Object.assign(record, { exitCode: error.status ?? null, signal: error.signal ?? null, error: error.message });
      throw error;
    } finally { fs.closeSync(out); fs.closeSync(err); }
    return stdout;
  }
  const api = route => {
    const file = command('gh', ['api', '--hostname', 'github.com', `repos/${PIN.repository}/${route}`], undefined, true);
    requireValue(fs.statSync(file).size <= 2 * 1024 * 1024, 'API response exceeds bound.');
    return JSON.parse(fs.readFileSync(file));
  };
  try {
    const binding = { run: api(`actions/runs/${PIN.runId}`), job: api(`actions/jobs/${PIN.jobId}`),
      artifact: api(`actions/artifacts/${PIN.artifactId}`), head: api(`git/commits/${PIN.head}`), merge: api(`git/commits/${PIN.merge}`) };
    report.source = validateSource(binding);
    fs.writeFileSync(path.join(output, 'source-binding.json'), JSON.stringify(binding, null, 2), { flag: 'wx' });
    const zip = path.join(output, 'original-artifact.zip');
    command('gh', ['api', '--hostname', 'github.com', `repos/${PIN.repository}/actions/artifacts/${PIN.artifactId}/zip`], zip, true);
    assert.deepEqual(fileHash(zip, PIN.zipBytes), { sha256: PIN.zipSha256, bytes: PIN.zipBytes }, 'Actual ZIP hash/size differs.');
    originalArchives.push({ path: zip, sha256: PIN.zipSha256, bytes: PIN.zipBytes });
    const metadataFile = command('/usr/bin/python3', ['-c', ARCHIVE_SCRIPT, JSON.stringify(archiveSpec()), zip, input]);
    requireValue(fs.statSync(metadataFile).size <= 32768, 'Archive preflight exceeds bound.');
    const archive = JSON.parse(fs.readFileSync(metadataFile)); report.archive = archive;
    const tar = path.join(input, 'signed-app-before-dmg.tar.gz'), manifestFile = path.join(input, 'builtin-manifest.json');
    assert.deepEqual(fileHash(tar, PIN.tarBytes), { sha256: PIN.tarSha256, bytes: PIN.tarBytes });
    originalArchives.push({ path: tar, sha256: PIN.tarSha256, bytes: PIN.tarBytes });
    assert.deepEqual(fileHash(manifestFile, PIN.manifestBytes), { sha256: PIN.manifestSha256, bytes: PIN.manifestBytes });
    const tree = path.join(input, 'app-tree'); fs.mkdirSync(tree, { mode: 0o700 });
    command('/usr/bin/tar', ['-xpf', tar, '-C', tree, '--no-same-owner']);
    app = path.join(tree, 'Creator Hub.app');
    source = verifyExtracted(app, archive);
    descriptor = fs.readFileSync(manifestFile); const manifest = JSON.parse(descriptor);
    requireValue(manifest.platform === 'macos' && manifest.arch === 'x86_64' && !manifest.managedRouting && !manifest.payloadArchive,
      'Only the original read-only Intel descriptor is supported.');
    const hub = path.join(app, 'Contents/MacOS/creator-hub');
    const hubPin = fileHash(hub, 128 * 1024 * 1024);
    requireValue(fs.readFileSync(hub).includes(descriptor), 'Original signed Hub does not embed this exact descriptor.');
    report.originalResources = unix.verifyResources(path.join(app, 'Contents/Resources/modules'), manifest);
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    const plist = path.join(app, 'Contents/Info.plist');
    for (const [key, expected] of [['CFBundleIdentifier', 'com.creatorworks.hub'], ['CFBundleShortVersionString', '0.1.14']]) {
      const value = command('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]);
      assert.equal(fs.readFileSync(value, 'utf8').trim(), expected);
    }
    requireValue(worker.appInventory(app).sha256 === source.sha256, 'Source drifted before producer pin capture.');
    preserved = [manifestFile, hub, ...Object.keys(report.originalResources).map(name => path.join(app, 'Contents/Resources/modules', name))]
      .map(file => ({ path: file, sha256: fileHash(file, 128 * 1024 * 1024).sha256 }));
    assert.ok(preserved.length <= 16);
    fs.writeFileSync(path.join(output, 'diagnostic-original-pins.json'), JSON.stringify({ baselineOrigin: report.baselineOrigin,
      hubSha256: hubPin.sha256, appTreeSha256: source.sha256, preservedFiles: preserved, ...FALSE_GATES }, null, 2), { flag: 'wx' });
    const produced = await worker.createDmg({ experimental: true, sourceApp: app, destination: path.join(output, 'headless-readonly14-intel.dmg'),
      mcpMode: 'read-only', dataScope: { root: input, manifestFile, manifestSha256: PIN.manifestSha256,
        hubSha256: hubPin.sha256, appTreeSha256: source.sha256, preservedFiles: preserved } });
    report.producer = produced;
    const extracted = path.join(output, 'independent-extract');
    unix.extract(produced.dmg.path, 'dmg', extracted, 'Creator Hub', (file, args) => {
      assert.equal(file, 'hdiutil'); assert.ok(['attach', 'detach'].includes(args[0]));
      return command('/usr/bin/hdiutil', args);
    });
    const extractedApp = path.join(extracted, 'Creator Hub.app');
    report.independentDmgPayload = verifyMounted(source, extractedApp, manifest, descriptor, hubPin.sha256);
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', extractedApp]);
    verifyMounted(source, extractedApp, manifest, descriptor, hubPin.sha256);
    assert.deepEqual(fileHash(produced.dmg.path, 512 * 1024 * 1024), { sha256: produced.dmg.sha256, bytes: produced.dmg.bytes });
    report.headlessDmgContainerVerified = true; report.readOnlyPayloadVerified = true;
    report.normalOwnedDetachVerified = report.tools.some(t => t.file === '/usr/bin/hdiutil' && t.args[0] === 'detach' && t.exitCode === 0);
    requireValue(report.normalOwnedDetachVerified, 'Owned normal detach was not confirmed.');
    report.status = 'passed';
  } catch (error) {
    failure = error; report.error = error.message; if (error.reportFile) report.producerFailureReport = error.reportFile;
  } finally {
    const errors = [];
    for (const item of originalArchives) try {
      assert.deepEqual(fileHash(item.path, item.bytes), { sha256: item.sha256, bytes: item.bytes }, 'Original retained archive changed.');
    } catch (error) { errors.push(error.message); }
    if (originalArchives.length) report.originalArchivesUnchanged = errors.length === 0;
    if (source) try {
      const after = worker.appInventory(app);
      requireValue(isDeepStrictEqual(source, after), 'Original source app bytes/modes/identity changed.');
      report.rootAndInnerSourceUnchanged = true;
    } catch (error) { errors.push(error.message); report.rootAndInnerSourceUnchanged = false; }
    if (preserved) for (const item of preserved) try {
      requireValue(fileHash(item.path, 128 * 1024 * 1024).sha256 === item.sha256, 'Original pinned caller bytes changed.');
    } catch (error) { errors.push(error.message); }
    if (errors.length) { report.status = 'failed'; report.preservationErrors = errors; }
    Object.assign(report, FALSE_GATES);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), { flag: 'wx' });
    if (failure || errors.length) {
      const error = failure || Error(errors.join('; ')); error.reportFile = reportFile; throw error;
    }
  }
  return report;
}

module.exports = { PIN, FALSE_GATES, ARCHIVE_SCRIPT, admission, parseArgs, validateSource, archiveSpec, verifyExtracted, verifyMounted, run };
if (require.main === module) {
  (async () => {
    admission(process.env, process.platform, process.arch);
    const report = await run(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify({ status: report.status, report: path.join(parseArgs(process.argv.slice(2)), 'repack-report.json'), ...FALSE_GATES }));
  })().catch(error => { console.error(JSON.stringify({ error: error.message, reportFile: error.reportFile, ...FALSE_GATES })); process.exitCode = 1; });
}
