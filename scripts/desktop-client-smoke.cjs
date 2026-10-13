// Preparation only: direct Claude Desktop health smoke, not production acceptance.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const STAGE_NAME = 'managed-route-20261013-04';
const REVIEWED_HASHES = Object.freeze({
  privateNode: 'c6335d08331c23d68b9f2b18adb102002d76ef150b47248e954c507e0d033664',
  server: '260f221b3cae45700e08180cccb762f0802a3e143f051f0dcf10d5dd6ca1d5e3',
});
const MAX_BYTES = 2 * 1024 * 1024;
const LABEL = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SCOPE = 'Direct Claude Desktop health-smoke preparation only; no client/tool run or production pass claimed.';
const SAFE_ENV = new Set(['UNITY_PROJECT_PATH', 'CREATOR_WORKS_TOOL_GROUPS', 'CREATOR_WORKS_CONFIG_OWNER', 'CREATOR_WORKS_MCP_ROOT']);
const own = (object, key) => Object.hasOwn(object, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
class SmokeError extends Error {}
function refuse(message) { throw new SmokeError(message); }

function rejectLinks(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) refuse('Linked paths are not supported. Nothing was changed.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === path.dirname(current)) break;
  }
}

function readBounded(file, optional = false) {
  rejectLinks(file);
  let fd;
  try { fd = fs.openSync(file, 'r'); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) refuse('Settings/evidence must be regular files of at most 2 MiB.');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let size = 0, count;
    while (size < bytes.length && (count = fs.readSync(fd, bytes, size, bytes.length - size, null))) size += count;
    if (size > MAX_BYTES) refuse('Settings/evidence exceed 2 MiB.');
    return bytes.subarray(0, size);
  } finally { fs.closeSync(fd); }
}

function writeNew(file, bytes) {
  if (bytes.length > MAX_BYTES) refuse('Evidence exceeds 2 MiB.');
  rejectLinks(file);
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function writeJson(file, value) { writeNew(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`)); }

function parse(bytes) {
  const text = bytes.toString('utf8');
  let value;
  try { value = JSON.parse(text); }
  catch { refuse('Invalid JSON. Nothing was changed; no backup was made.'); }
  if (!Buffer.from(text).equals(bytes) || !object(value)) refuse('Settings must be a UTF-8 JSON object.');
  // JSON.parse validates grammar; token spans retain original bytes and detect duplicate keys.
  const frames = [];
  let rootEnd, serversEnd;
  for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g)) {
    const word = token[0], parent = frames.at(-1);
    if (word === '{' || word === '[') {
      frames.push({ object: word === '{', keyNext: word === '{', keys: new Set(), root: !parent,
        servers: frames.length === 1 && parent.key === 'mcpServers' });
    } else if (word === '}' || word === ']') {
      const frame = frames.pop();
      if (frame.root) rootEnd = token.index;
      if (frame.servers) serversEnd = token.index;
    } else if (word === ',') {
      if (parent.object) parent.keyNext = true;
    } else if (word.startsWith('"') && parent.object && parent.keyNext) {
      const key = JSON.parse(word);
      if (parent.keys.has(key)) refuse('Duplicate JSON key/entry. Nothing was changed; no backup was made.');
      parent.keys.add(key); parent.key = key; parent.keyNext = false;
    }
  }
  if (own(value, 'mcpServers') && !object(value.mcpServers)) refuse('mcpServers must be a JSON object.');
  return { value, text, rootEnd, serversEnd };
}

function rejectCredentials(config) {
  const pending = [config];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (/-----BEGIN .*PRIVATE KEY|\b(?:Bearer|Basic)\s+\S+|\b(?:sk-|gh[pousr]_|github_pat_|AIza)[a-z0-9_-]+|:\/\/[^\s/]*@|(?:api[-_]?key|token|password|secret)\s*[=:]|--(?:api[-_]?key|token|password|secret)\b/i.test(value)) {
        refuse('Potential credential material in settings. Refused without backup; values are withheld.');
      }
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (/auth|token|password|credential|secret|api[_-]?key|private[_-]?key|cookie|headers?/i.test(key)) {
          refuse('Potential credential field in settings. Refused without backup; values are withheld.');
        }
        pending.push(child);
      }
    }
  }
  for (const server of Object.values(config.mcpServers || {})) {
    if (!object(server)) refuse('Existing MCP entries must be objects. Refused without backup.');
    if (!own(server, 'env')) continue;
    if (!object(server.env) || Object.entries(server.env).some(([key, value]) => !SAFE_ENV.has(key) || typeof value !== 'string')) {
      refuse('Existing server env contains an unreviewed key/value. Refused without backup; values are withheld.');
    }
  }
}

function addEntry(before, name, entry) {
  const parsed = parse(before ?? Buffer.from('{}\n'));
  rejectCredentials(parsed.value);
  if (own(parsed.value.mcpServers || {}, name)) refuse('Acceptance entry already exists. Nothing was changed; no backup was made.');
  const hasServers = own(parsed.value, 'mcpServers');
  const position = hasServers ? parsed.serversEnd : parsed.rootEnd;
  const occupied = Object.keys(hasServers ? parsed.value.mcpServers : parsed.value).length > 0;
  const addition = `${occupied ? ',' : ''}\n${JSON.stringify(hasServers ? name : 'mcpServers')}:${JSON.stringify(hasServers ? entry : { [name]: entry })}\n`;
  const bytes = Buffer.from(parsed.text.slice(0, position) + addition + parsed.text.slice(position));
  if (bytes.length > MAX_BYTES) refuse('Prepared settings would exceed 2 MiB. Nothing was changed.');
  return bytes;
}

function desktopConfigPath() {
  if (!process.env.APPDATA || !path.isAbsolute(process.env.APPDATA)) refuse('Windows APPDATA is unavailable.');
  return path.join(process.env.APPDATA, 'Claude', 'claude_desktop_config.json');
}
function locations(options = {}) {
  if (process.platform !== 'win32') refuse('This preparation harness supports Windows Claude Desktop only.');
  // Fixture injection is module-only; the CLI exposes no config or hash overrides.
  return { configPath: path.resolve(options.testOnly?.configPath || desktopConfigPath()),
    evidenceRoot: path.resolve(options.testOnly?.evidenceRoot || path.join(ROOT, 'artifacts')) };
}
function packagePaths(stage) {
  stage = path.resolve(stage);
  if (path.basename(stage) !== STAGE_NAME) refuse('Use the reviewed managed-route-20261013-04 candidate stage.');
  return { stage, privateNode: path.join(stage, 'modules/mcp/server/runtime/node.exe'),
    server: path.join(stage, 'modules/mcp/server/creator-works-mcp.mjs') };
}
function fileHash(file) {
  rejectLinks(file);
  const fd = fs.openSync(file, 'r'), hash = crypto.createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
  try {
    if (!fs.fstatSync(fd).isFile()) refuse('Package payload must be a regular file.');
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
function packageHashes(files, reviewed = REVIEWED_HASHES) {
  const manifestBytes = readBounded(path.join(files.stage, 'builtin-manifest.json'));
  const manifest = parse(manifestBytes).value;
  const hashes = { manifest: sha256(manifestBytes), privateNode: fileHash(files.privateNode), server: fileHash(files.server) };
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'windows'
    || manifest.modules?.mcp?.files?.['mcp/server/runtime/node.exe'] !== hashes.privateNode
    || manifest.modules?.mcp?.files?.['mcp/server/creator-works-mcp.mjs'] !== hashes.server) refuse('Private Node/server do not match the candidate manifest.');
  if (hashes.privateNode !== reviewed.privateNode || hashes.server !== reviewed.server) refuse('Private Node/server differ from the reviewed candidate hashes.');
  return hashes;
}
function entryFor(files, project) {
  return { command: files.privateNode, args: [files.server],
    env: { UNITY_PROJECT_PATH: project, CREATOR_WORKS_TOOL_GROUPS: 'none' } };
}

// File.Replace retains the ACTUAL displaced bytes, unlike a read + rename backup.
// Pre/post checks are not a global CAS against other processes renaming the path.
function replaceReviewed(configPath, before, after, evidence, phase) {
  const operation = path.join(evidence, `${phase}-${crypto.randomUUID()}`);
  fs.mkdirSync(operation, { mode: 0o700 });
  const expected = path.join(operation, 'reviewed-before.json');
  const next = path.join(operation, 'next.json');
  const actual = path.join(operation, 'actual-before.json');
  if (before !== null) writeNew(expected, before);
  if (after !== null) writeNew(next, after);
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  const script = `
$ErrorActionPreference = 'Stop'
$target = ${literal(configPath)}
$expected = ${before === null ? '$null' : literal(expected)}
$next = ${after === null ? '$null' : literal(next)}
$actual = ${literal(actual)}
function Read-Bounded($file) {
  if (([IO.File]::GetAttributes($file) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 44 }
  $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($stream.Length -gt ${MAX_BYTES}) { exit 44 }
    $bytes = New-Object byte[] ([int]$stream.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
      if ($count -eq 0) { exit 44 }
      $offset += $count
    }
    return ,$bytes
  } finally { $stream.Dispose() }
}
function Matches($a, $b) {
  if ($a.Length -ne $b.Length) { return $false }
  for ($i = 0; $i -lt $a.Length; $i++) { if ($a[$i] -ne $b[$i]) { return $false } }
  return $true
}
try {
  if ($null -eq $expected) {
    if ([IO.File]::Exists($target)) { exit 41 }
    [IO.File]::Move($next, $target)
  } else {
    if (-not [IO.File]::Exists($target)) { exit 41 }
    if (-not (Matches (Read-Bounded $target) (Read-Bounded $expected))) { exit 41 }
    if ([IO.File]::Exists($actual)) { exit 44 }
    if ($null -eq $next) { [IO.File]::Move($target, $actual) }
    else { [IO.File]::Replace($next, $target, $actual) }
    if (-not (Matches (Read-Bounded $actual) (Read-Bounded $expected))) { exit 42 }
  }
  exit 0
} catch { exit 44 }
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, stdio: 'ignore', timeout: 15000 });
  if (result.status !== 0) {
    const reason = result.status === 41 ? 'Config changed before the native operation; it was not overwritten.'
      : result.status === 42 ? 'Concurrent replacement detected; actual displaced bytes retained. No blind rollback was attempted.'
        : 'Native operation failed or was interrupted; inspect retained evidence before retrying.';
    refuse(`${reason} Backup/evidence: ${operation}`);
  }
  const current = readBounded(configPath, true);
  if (after === null ? current !== null : current === null || !current.equals(after)) {
    refuse(`Config changed after the native operation; no rollback was attempted. Backup/evidence: ${operation}`);
  }
  return { actualBefore: before === null ? null : actual, beforeSha256: before === null ? null : sha256(before),
    afterSha256: after === null ? null : sha256(after), concurrency: 'Native retained-before-image check; not a global CAS.' };
}

function prepare(stage, label, options) {
  if (!LABEL.test(label || '')) refuse('Provide a unique lowercase alphanumeric/hyphen label (maximum 64 characters).');
  const { configPath, evidenceRoot } = locations(options), files = packagePaths(stage);
  const evidence = path.join(evidenceRoot, label), project = path.join(evidence, 'fixture-project');
  rejectLinks(evidence); rejectLinks(configPath);
  if (fs.existsSync(evidence)) refuse('Evidence directory already exists. Use a new label.');
  const reviewed = options?.testOnly?.reviewedHashes || REVIEWED_HASHES;
  const hashes = packageHashes(files, reviewed);
  const before = readBounded(configPath, true), name = `creator-hub-acceptance-${label}`;
  const after = addEntry(before, name, entryFor(files, project));
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.mkdirSync(evidence, { mode: 0o700 });
  fs.mkdirSync(project); fs.mkdirSync(path.join(project, 'Assets'));
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (before !== null) writeNew(path.join(evidence, 'config.before.json'), before);
  writeNew(path.join(evidence, 'config.expected.json'), after);
  const receipt = { schemaVersion: 1, scope: SCOPE, label, name, ...files, configPath, project,
    beforeExists: before !== null, beforeSha256: before === null ? null : sha256(before),
    expectedSha256: sha256(after), packageHashesBefore: hashes };
  writeJson(path.join(evidence, 'prepare.json'), receipt);
  const result = replaceReviewed(configPath, before, after, evidence, 'prepare');
  const hashesAfter = packageHashes(files, reviewed);
  if (JSON.stringify(hashes) !== JSON.stringify(hashesAfter)) refuse(`Candidate changed during preparation. Restore using: ${evidence}`);
  writeJson(path.join(evidence, 'prepared.json'), { scope: SCOPE, status: 'prepared, not tested', ...result, packageHashesAfter: hashesAfter });
  return { scope: SCOPE, status: 'prepared, not tested', evidence, name,
    restore: `node scripts/desktop-client-smoke.cjs restore "${evidence}"` };
}

function restore(folder, options) {
  const { configPath, evidenceRoot } = locations(options), evidence = path.resolve(folder);
  const label = path.basename(evidence);
  if (!LABEL.test(label) || path.dirname(evidence) !== evidenceRoot) refuse('Restore requires a unique evidence folder directly inside artifacts.');
  rejectLinks(evidence);
  const receipt = parse(readBounded(path.join(evidence, 'prepare.json'))).value;
  if (receipt.schemaVersion !== 1 || receipt.scope !== SCOPE || receipt.label !== label || receipt.configPath !== configPath
    || receipt.name !== `creator-hub-acceptance-${label}` || receipt.project !== path.join(evidence, 'fixture-project')
    || typeof receipt.beforeExists !== 'boolean' || typeof receipt.stage !== 'string') refuse('Unreviewed or inconsistent preparation receipt.');
  const files = packagePaths(receipt.stage);
  if (receipt.privateNode !== files.privateNode || receipt.server !== files.server) refuse('Unreviewed candidate paths in receipt.');
  const before = receipt.beforeExists ? readBounded(path.join(evidence, 'config.before.json')) : null;
  if ((before === null ? null : sha256(before)) !== receipt.beforeSha256) refuse('Original backup hash differs. No restore attempted.');
  const expected = readBounded(path.join(evidence, 'config.expected.json'));
  if (sha256(expected) !== receipt.expectedSha256 || !expected.equals(addEntry(before, receipt.name, entryFor(files, receipt.project)))) {
    refuse('Reviewed test bytes differ. No restore attempted.');
  }
  const current = readBounded(configPath, true);
  if (current === null || !current.equals(expected)) refuse(`Config changed; unknown changes kept. No restore attempted. Backup/evidence: ${evidence}`);
  if (fs.existsSync(path.join(evidence, 'restored.json'))) refuse('Restore evidence already exists. No further change attempted.');
  const result = replaceReviewed(configPath, expected, before, evidence, 'restore');
  writeJson(path.join(evidence, 'restored.json'), { scope: SCOPE, status: 'restored', ...result, originalExisted: receipt.beforeExists });
  return { scope: SCOPE, status: 'restored', evidence, afterSha256: result.afterSha256 };
}

function main(args = process.argv.slice(2)) {
  try {
    let result;
    if (args[0] === 'prepare' && args.length === 3) {
      // The CLI cannot redirect the real config or substitute another candidate stage.
      if (path.resolve(args[1]) !== path.join(ROOT, 'artifacts', 'unified', STAGE_NAME)) refuse('Use this checkout\'s exact reviewed candidate stage.');
      result = prepare(args[1], args[2]);
    } else if (args[0] === 'restore' && args.length === 2) result = restore(args[1]);
    else refuse('Usage: desktop-client-smoke.cjs prepare STAGE UNIQUE-LABEL | restore UNIQUE-EVIDENCE-FOLDER');
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof SmokeError ? error.message : 'Preparation/restore filesystem failure. Values and native output are withheld; inspect any retained evidence.');
    process.exitCode = 1;
  }
}

module.exports = { prepare, restore, addEntry, parse, rejectCredentials, replaceReviewed, sha256, MAX_BYTES, main };
if (require.main === module) main();
