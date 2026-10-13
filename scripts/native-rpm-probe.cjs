// Read-only container parsing on a disposable runner; no package installation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Linux') {
  throw Error('RPM diagnostics require a disposable GitHub-hosted Linux runner.');
}
const root = path.resolve(process.argv[2] || '');
const reportFile = path.resolve(process.argv[3] || '');
if (process.argv.length !== 4 || fs.existsSync(reportFile)) throw Error('Supply a retained artifact and a new report path.');
const directory = path.join(root, 'native-packages');
const packages = fs.readdirSync(directory).filter(name => name.endsWith('.rpm'));
if (packages.length !== 1) throw Error('Expected one retained RPM.');
const file = path.join(directory, packages[0]);
if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw Error('RPM must be a regular retained file.');
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { timeout: 180000, maxBuffer: 1024 * 1024, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
  return { exitCode: result.status, signal: result.signal, error: result.error?.code,
    ...(capture ? { stdout: result.stdout?.toString('utf8').slice(-4096) || '' } : {}),
    stderr: result.stderr?.toString('utf8').slice(-4096) || '' };
}
const report = { scope: 'Retained RPM parsing and resource extraction; not installation, GUI or release acceptance.',
  sourceRevision: process.env.GITHUB_SHA, packageRun: process.env.CANDIDATE_RUN,
  package: packages[0], sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  rpmVersion: run('rpm', ['--version'], true),
  rpmQuery: run('rpm', ['--query', '--package', '--queryformat', '%{NAME} %{VERSION} %{ARCH} %{PAYLOADFORMAT} %{PAYLOADCOMPRESSOR}\n', file], true),
  rpmIntegrity: run('rpm', ['--checksig', '--nosignature', file], true),
  rpm2cpio: run('rpm2cpio', [file]),
  bsdtar: run('bsdtar', ['-tf', file]) };
try {
  const { extract, verifyResources } = require('./unix-package-payload.cjs');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'builtin-manifest.json'), 'utf8'));
  if (manifest.platform !== 'linux' || manifest.arch !== 'x86_64') throw Error('Unexpected retained native target.');
  const output = `${reportFile}.extracted`;
  extract(file, 'rpm', output, 'Creator Hub');
  const files = verifyResources(path.join(output, 'usr/lib/Creator Hub/modules'), manifest);
  report.extraction = { passed: true, resourceCount: Object.keys(files).length };
} catch (error) {
  report.extraction = { passed: false, error: error.message };
}
fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
if (report.rpmQuery.exitCode !== 0 || report.rpmIntegrity.exitCode !== 0 || report.bsdtar.exitCode !== 0 || !report.extraction.passed) process.exitCode = 1;
