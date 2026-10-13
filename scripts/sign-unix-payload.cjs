// Local build signing only. No native acceptance, payload execution or assembly.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { collect, json } = require('./collect-unix-payload-binding.cjs');
const { validateBinding } = require('./unix-payload-binding.cjs');
const routing = require('./managed-router-package.cjs');
const { verifyStage } = require('./build-unified.cjs');
const { runtimeDescriptor } = require('./mcp-runtime-descriptor.cjs');

const ROOT = path.resolve(__dirname, '..');
const META = 128 * 1024;
const TRANSFER = ['modules.tar.gz', 'prepared-unix.json', 'transfer-binding.json'];
const ROUTING = ['routing/router.json', 'routing/router.minisig', 'routing/runtime.json', 'routing/runtime.minisig'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function absolute(file) {
  assert.ok(typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file, 'Canonical absolute paths required');
  for (let part = file;; part = path.dirname(part)) {
    try { assert.equal(fs.lstatSync(part).isSymbolicLink(), false, 'Redirected path refused'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(part) === part) break;
  }
  return file;
}
function inside(file, root) {
  absolute(file); absolute(root);
  const relative = path.relative(root, file);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Path escaped the owned artifact scope');
}
function capture(file, limit, cargoTool = false) {
  absolute(file);
  const named = fs.lstatSync(file, { bigint: true });
  assert.ok(named.isFile() && (cargoTool ? named.nlink > 0n : named.nlink === 1n)
    && named.size > 0n && named.size <= BigInt(limit), 'Bounded regular single-link input required');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  const fields = ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'];
  const same = (a, b) => fields.every(field => a[field] === b[field]);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    assert.ok(same(named, before), 'Input replaced before capture');
    const digest = crypto.createHash('sha256'), buffer = Buffer.alloc(65536);
    let total = 0;
    for (let count; (count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
      total += count; assert.ok(total <= limit, 'Input exceeded capture bound'); digest.update(buffer.subarray(0, count));
    }
    absolute(file);
    assert.ok(same(before, fs.fstatSync(fd, { bigint: true })) && same(before, fs.lstatSync(file, { bigint: true }))
      && total === Number(before.size), 'Input changed during capture');
    return { sha256: digest.digest('hex'), size: total };
  } finally { fs.closeSync(fd); }
}
function read(file, limit = META, canonical = true) {
  const record = capture(file, limit), bytes = fs.readFileSync(file);
  assert.equal(hash(bytes), record.sha256, 'Metadata changed after capture');
  const value = JSON.parse(bytes);
  if (canonical) assert.equal(bytes.toString('utf8').trim(), JSON.stringify(value, null, 2), 'Noncanonical or duplicate metadata fields');
  return { value, record };
}
function unchanged(file, record, cargoTool = false) { assert.deepEqual(capture(file, record.size, cargoTool), record, 'Pinned bytes changed'); }
function copy(file, output, record) {
  unchanged(file, record); absolute(output);
  fs.copyFileSync(file, output, fs.constants.COPYFILE_EXCL);
  unchanged(output, record); unchanged(file, record);
}
function inventory(root, names) {
  const allowed = new Set(names), found = new Set();
  const dirs = new Set(names.flatMap(name => {
    const result = [];
    for (let dir = path.posix.dirname(name); dir !== '.'; dir = path.posix.dirname(dir)) result.push(dir);
    return result;
  }));
  function walk(dir, prefix = '') {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + item.name, file = path.join(dir, item.name);
      absolute(file);
      if (item.isDirectory()) { assert.ok(dirs.has(name), 'Unlisted artifact directory'); walk(file, `${name}/`); }
      else { assert.ok(allowed.has(name), 'Unlisted artifact file'); found.add(name); }
    }
  }
  absolute(root); walk(root);
  assert.deepEqual([...found].sort(), [...allowed].sort(), 'Artifact file set differs');
}
function compactProof(proof) {
  const { expected, run, artifact, commit, jobs } = proof.binding;
  const select = (value, names) => Object.fromEntries(names.map(name => [name, value[name]]));
  return { expected,
    run: { ...select(run, ['id', 'head_sha', 'run_attempt', 'status', 'conclusion', 'path', 'event', 'head_branch']),
      repository: select(run.repository, ['id', 'full_name']), head_repository: select(run.head_repository, ['id', 'full_name']) },
    artifact: { ...select(artifact, ['id', 'name', 'digest', 'size_in_bytes', 'expired', 'created_at']),
      workflow_run: select(artifact.workflow_run, ['id', 'head_sha', 'repository_id', 'head_repository_id']) },
    commit: { sha: commit.sha, tree: { sha: commit.tree.sha } },
    jobs: jobs.filter(job => job.name === proof.verified.job).map(job => select(job, ['name', 'run_id', 'run_attempt', 'status', 'conclusion', 'started_at', 'completed_at'])) };
}

function signPayload(inputs, services = {}) {
  const root = services.root || ROOT, execute = services.execute || execFileSync;
  const approved = services.signer || routing;
  assert.equal(services.platform || process.platform, 'win32', 'This local acquisition path requires Windows PowerShell');
  const { pins, zip, prepared, output, transferExe, verifierExe } = inputs;
  for (const file of [pins, zip, prepared, output, transferExe, verifierExe]) absolute(file);
  const artifacts = path.join(root, 'artifacts');
  for (const file of [zip, prepared, output]) inside(file, artifacts);
  assert.equal(fs.existsSync(output), false, 'Signed output is immutable');
  inside(pins, path.dirname(root));
  assert.ok(!pins.startsWith(path.dirname(prepared) + path.sep), 'Independent pins cannot come from extracted candidate input');
  assert.equal(transferExe, path.join(root, 'native/unix-transfer/target/release/creator-hub-unix-transfer.exe'), 'Use the fixed reviewed cargo-built transfer tool');
  assert.equal(verifierExe, path.join(root, 'src-tauri/target/release/examples/verify-package-input.exe'), 'Use the fixed reviewed production-key verifier');
  const extractor = path.join(root, 'scripts/extract-unix-transfer.ps1');
  // Cargo's fixed executable outputs are hard-linked to deps on this host.
  // This exception never applies to candidate inputs, metadata, or the extractor.
  const tools = [transferExe, verifierExe, extractor].map(file => [file,
    capture(file, file === extractor ? META : 256 * 1024 * 1024, file !== extractor), file !== extractor]);
  const initialPins = read(pins), initialPrepared = read(prepared);
  const proof = collect(json(pins), prepared, services.request);
  const pin = validateBinding(proof.binding);
  const apiProof = compactProof(proof);
  assert.deepEqual(validateBinding({ ...apiProof, prepared: proof.binding.prepared }), pin, 'Serialized API proof differs');
  const zipRecord = capture(zip, 768 * 1024 * 1024);
  assert.deepEqual(zipRecord, { sha256: pin.zipSha256, size: pin.zipBytes }, 'Original ZIP differs from fresh API proof');
  const work = fs.mkdtempSync(path.join(artifacts, 'unix-sign-work-'));
  const acquired = path.join(work, 'transfer'), raw = path.join(work, 'raw');
  function run(command, args, timeout = 180000) {
    for (const [file, record, cargoTool] of tools) unchanged(file, record, cargoTool);
    const result = execute(command, args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 65536 });
    for (const [file, record, cargoTool] of tools) unchanged(file, record, cargoTool);
    return String(result).trim();
  }
  const extraction = JSON.parse(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', extractor,
    '-ZipPath', zip, '-ExpectedSha256', pin.zipSha256, '-ExpectedBytes', String(pin.zipBytes), '-OutputDirectory', acquired]));
  assert.deepEqual(extraction, { downloadedZipVerified: true, transferContentsVerified: false, releaseReady: false });
  inventory(acquired, TRANSFER);
  const transferFiles = Object.fromEntries(TRANSFER.map(name => [name, capture(path.join(acquired, name), name === 'modules.tar.gz' ? 256 * 1024 * 1024 : META)]));
  assert.deepEqual(transferFiles['prepared-unix.json'], initialPrepared.record, 'ZIP receipt differs from independently staged receipt');
  const args = [path.join(acquired, 'modules.tar.gz'), path.join(acquired, 'prepared-unix.json'), path.join(acquired, 'transfer-binding.json')];
  const transferMessage = 'Unsigned transfer checked. No payload execution, signing, activation or release acceptance.';
  assert.equal(run(transferExe, ['verify', ...args]), transferMessage, 'Rust transfer verification did not complete');
  assert.equal(run(transferExe, ['extract', ...args, raw]), transferMessage, 'Rust extraction did not complete');
  inventory(raw, [...Object.keys(proof.binding.prepared.files), 'prepared-unix.json']);
  unchanged(path.join(raw, 'prepared-unix.json'), initialPrepared.record);
  for (const [name, record] of Object.entries(proof.binding.prepared.files)) {
    assert.deepEqual(capture(path.join(raw, name), record.size), { sha256: record.sha256, size: record.size }, 'Extracted raw member differs');
  }
  const manifest = read(path.join(raw, 'builtin-manifest.json')).value;
  assert.deepEqual(Object.keys(manifest).sort(), ['arch', 'modules', 'platform', 'schemaVersion']);
  assert.equal(manifest.platform, pin.platform); assert.equal(manifest.arch, pin.arch);
  for (const entry of Object.values(manifest.modules || {})) assert.deepEqual(Object.keys(entry).sort(), ['executable', 'files', 'version']);
  verifyStage(path.join(raw, 'modules'), manifest);
  for (const module of Object.values(manifest.modules)) for (const [name, expected] of Object.entries(module.files)) {
    assert.equal(expected, proof.binding.prepared.files[`modules/${name}`].sha256, 'Manifest differs from original native record');
  }
  const runtimePath = path.join(raw, 'mcp-runtime.json');
  const runtimeRecord = capture(runtimePath, 32768);
  const runtimeBytes = fs.readFileSync(runtimePath), runtime = JSON.parse(runtimeBytes);
  assert.equal(hash(runtimeBytes), runtimeRecord.sha256);
  assert.equal(runtimeBytes.toString('utf8'), JSON.stringify(runtime), 'Runtime signing body must remain exact canonical bytes');
  assert.deepEqual(runtime, runtimeDescriptor(manifest, pin.version), 'Runtime target/version differs');
  function recheckInput() {
    unchanged(pins, initialPins.record); unchanged(prepared, initialPrepared.record); unchanged(zip, zipRecord);
    for (const name of TRANSFER) unchanged(path.join(acquired, name), transferFiles[name]);
  }
  function recheckRaw() {
    for (const [name, record] of Object.entries(proof.binding.prepared.files)) {
      unchanged(path.join(raw, name), { sha256: record.sha256, size: record.size });
    }
    unchanged(path.join(raw, 'prepared-unix.json'), initialPrepared.record);
  }
  recheckInput();
  fs.mkdirSync(output, { mode: 0o700 });
  for (const name of TRANSFER) copy(path.join(acquired, name), path.join(output, name), transferFiles[name]);
  recheckRaw();
  function verifySignature(metadata, signature) {
    const body = capture(metadata, META), sig = capture(signature, 4096);
    assert.equal(run(verifierExe, [metadata, signature], 30000),
      `Verified trusted package signature: ${body.sha256}. No activation or client changes.`, 'Production-key signature verification did not complete');
    unchanged(metadata, body); unchanged(signature, sig);
  }
  const authorizedBodies = new Map([
    [path.join(raw, 'modules/routing/router.json'), Buffer.from(JSON.stringify({ schemaVersion: 1,
      product: 'com.creatorworks.hub.mcp-router', platform: pin.platform, arch: pin.arch, protocol: 1,
      sha256: proof.binding.prepared.files['router-for-package'].sha256 }))],
    [path.join(raw, 'modules/routing/runtime.json'), runtimeBytes],
  ]);
  let sequence = 0;
  // All acquisition, core decoding and raw/metadata checks precede key selection.
  try {
    const key = approved.signingKey(root);
    const sign = file => {
      assert.ok(authorizedBodies.has(file), 'Signing is restricted to exact router/runtime/handoff bodies');
      const before = capture(file, META);
      const authorized = authorizedBodies.get(file);
      assert.deepEqual(before, { sha256: hash(authorized), size: authorized.length }, 'Generated signing body differs from reviewed target');
      const index = sequence++;
      const signingInput = path.join(work, `signing-input-${index}.json`);
      copy(file, signingInput, before);
      const signature = approved.signDetached(signingInput, key);
      assert.ok(Buffer.isBuffer(signature) && signature.length > 0 && signature.length <= 4096, 'Bounded detached signature required');
      unchanged(file, before); unchanged(signingInput, before);
      const check = path.join(work, `signature-${index}.minisig`);
      fs.writeFileSync(check, signature, { flag: 'wx', mode: 0o600 });
      verifySignature(file, check);
      return signature;
    };
    manifest.managedRouting = routing.prepare(raw, manifest, path.join(raw, 'router-for-package'), runtimePath, sign);
    const routerName = routing.routeFiles(pin.platform)[0];
    assert.equal(manifest.managedRouting.files[routerName], proof.binding.prepared.files['router-for-package'].sha256, 'Original native router bytes changed');
    verifyStage(path.join(raw, 'modules'), manifest);
    fs.mkdirSync(path.join(output, 'routing'), { mode: 0o700 });
    const routingMetadata = {};
    for (const name of ROUTING) {
      const file = path.join(raw, 'modules', name), record = capture(file, name.endsWith('.minisig') ? 4096 : META);
      copy(file, path.join(output, name), record);
      fs.chmodSync(path.join(output, name), 0o644);
      routingMetadata[name] = { ...record, mode: 0o644 };
    }
    for (const name of ['router', 'runtime']) verifySignature(path.join(output, `routing/${name}.json`), path.join(output, `routing/${name}.minisig`));
    const payloadFiles = {};
    for (const module of Object.values(manifest.modules)) for (const name of Object.keys(module.files)) payloadFiles[name] = proof.binding.prepared.files[`modules/${name}`];
    payloadFiles[routerName] = proof.binding.prepared.files['router-for-package'];
    Object.assign(payloadFiles, routingMetadata);
    assert.equal(Object.keys(payloadFiles).length, 15, 'Exact pre-wrapper payload required');
    assert.deepEqual(Object.fromEntries(Object.entries(payloadFiles).map(([name, record]) => [name, record.sha256])),
      { ...manifest.modules.mcp.files, ...manifest.modules.setup.files, ...manifest.managedRouting.files });
    const p = proof.binding.prepared;
    const handoff = { schemaVersion: 1, product: 'com.creatorworks.hub.unix-signed-handoff', hubVersion: pin.version,
      platform: p.platform, arch: p.arch, rustTarget: p.rustTarget, mcpMode: p.mcpMode, compiledFlags: p.compiledFlags,
      source: p.source, apiProof, transferFiles, routingMetadata, builtinManifest: manifest, payloadFiles,
      privateKeyIncluded: false, nativeGuiAccepted: false, releaseReady: false };
    const bytes = Buffer.from(JSON.stringify(handoff, null, 2));
    assert.ok(bytes.length <= META, 'Handoff exceeds offline verifier metadata bound');
    recheckInput();
    for (const name of TRANSFER) unchanged(path.join(output, name), transferFiles[name]);
    recheckRaw();
    for (const name of ROUTING) unchanged(path.join(output, name), { sha256: routingMetadata[name].sha256, size: routingMetadata[name].size });
    const handoffPath = path.join(output, 'handoff.json');
    fs.writeFileSync(handoffPath, bytes, { flag: 'wx', mode: 0o644 });
    fs.chmodSync(handoffPath, 0o644);
    authorizedBodies.set(handoffPath, bytes);
    const signature = sign(handoffPath);
    const signaturePath = path.join(output, 'handoff.minisig');
    fs.writeFileSync(signaturePath, signature, { flag: 'wx', mode: 0o644 });
    fs.chmodSync(signaturePath, 0o644);
    verifySignature(handoffPath, signaturePath);
    unchanged(handoffPath, { sha256: hash(bytes), size: bytes.length });
    unchanged(signaturePath, { sha256: hash(signature), size: signature.length });
    recheckInput();
    recheckRaw();
    for (const name of TRANSFER) unchanged(path.join(output, name), transferFiles[name]);
    for (const name of ROUTING) unchanged(path.join(output, name), { sha256: routingMetadata[name].sha256, size: routingMetadata[name].size });
    inventory(output, [...TRANSFER, ...ROUTING, 'handoff.json', 'handoff.minisig']);
    return { output, handoffSha256: hash(bytes), handoffSignatureSha256: hash(signature), target: pin.target,
      privateKeyIncluded: false, nativeGuiAccepted: false, releaseReady: false };
  } catch { throw Error('Local signing or post-sign verification failed. Partial output and owned scratch evidence are retained; assembly remains blocked.'); }
}

module.exports = { signPayload, compactProof, capture };
if (require.main === module) {
  try {
    assert.equal(process.argv.length, 8, 'Use ABS_PINS_JSON ABS_ORIGINAL_ZIP ABS_PREPARED_JSON ABS_NEW_OUTPUT ABS_TRANSFER_EXE ABS_VERIFIER_EXE');
    const [pins, zip, prepared, output, transferExe, verifierExe] = process.argv.slice(2);
    console.log(JSON.stringify(signPayload({ pins, zip, prepared, output, transferExe, verifierExe })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
