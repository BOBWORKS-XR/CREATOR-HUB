// Synthetic unit input only. These bytes/signatures must never reach a native lane.
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./unix-payload-binding.cjs');
const m = require('../private-linux-update-fixture-017-metadata.cjs');
const p = require('../private-linux-update-fixture-017.cjs');
const retirement = require('../linux-retirement-package.cjs');
const { moduleFiles } = require('../build-unified.cjs');
const { runtimeDescriptor } = require('../mcp-runtime-descriptor.cjs');
function json(value) { return Buffer.from(JSON.stringify(value, null, 2)); }
function elf(label) {
  const header = Buffer.alloc(64); Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(header);
  header.writeUInt16LE(3, 16); header.writeUInt16LE(62, 18);
  return Buffer.concat([header, Buffer.from(label)]);
}
function data() {
  const binding = fixture('linux'), prepared = binding.prepared;
  binding.expected.version = prepared.hubVersion = '0.1.16'; binding.run.head_branch = 'validation/unix-payload-016';
  const modules = Object.fromEntries(['mcp', 'setup'].map(id => {
    const names = moduleFiles(id, 'linux');
    return [id, { executable: names[0], version: id === 'mcp' ? '2.7.7' : '0.3.7',
      files: Object.fromEntries(names.map(name => [name, prepared.files[`modules/${name}`].sha256])) }];
  }));
  const manifest = { schemaVersion: 1, platform: 'linux', arch: 'x86_64', modules };
  const files = { 'modules.tar.gz': Buffer.from('synthetic-carrier-not-an-archive'), 'transfer-binding.json': json({ synthetic: true }),
    'routing/router.json': Buffer.from(JSON.stringify({ schemaVersion: 1, product: 'com.creatorworks.hub.mcp-router', platform: 'linux',
      arch: 'x86_64', protocol: 1, sha256: prepared.files['router-for-package'].sha256 })),
    'routing/runtime.json': Buffer.from(JSON.stringify(runtimeDescriptor(manifest, '0.1.16'))),
    'routing/router.minisig': Buffer.from('SYNTHETIC ORIGINAL ROUTER SIGNATURE'),
    'routing/runtime.minisig': Buffer.from('SYNTHETIC ORIGINAL RUNTIME SIGNATURE') };
  files['prepared-unix.json'] = json(prepared);
  const routingMetadata = Object.fromEntries(Object.keys(files).filter(name => name.startsWith('routing/'))
    .map(name => [name, { ...m.record(files[name]), mode: 0o644 }]));
  const payloadFiles = {};
  for (const module of Object.values(modules)) for (const name of Object.keys(module.files)) payloadFiles[name] = prepared.files[`modules/${name}`];
  payloadFiles['routing/creator-hub-mcp-router'] = prepared.files['router-for-package']; Object.assign(payloadFiles, routingMetadata);
  manifest.managedRouting = { protocol: 1, files: Object.fromEntries(Object.entries(payloadFiles).filter(([name]) => name.startsWith('routing/'))
    .map(([name, value]) => [name, value.sha256])) };
  const { prepared: _unused, ...apiProof } = binding;
  const handoff = { schemaVersion: 1, product: 'com.creatorworks.hub.unix-signed-handoff', hubVersion: '0.1.16', platform: 'linux', arch: 'x86_64',
    rustTarget: prepared.rustTarget, mcpMode: prepared.mcpMode, compiledFlags: prepared.compiledFlags, source: prepared.source, apiProof,
    transferFiles: Object.fromEntries(['modules.tar.gz', 'prepared-unix.json', 'transfer-binding.json'].map(name => [name, m.record(files[name])])),
    routingMetadata, builtinManifest: manifest, payloadFiles, privateKeyIncluded: false, nativeGuiAccepted: false, releaseReady: false };
  files['handoff.json'] = json(handoff); files['handoff.minisig'] = Buffer.from('SYNTHETIC ORIGINAL HANDOFF SIGNATURE');
  const originalRecords = Object.fromEntries(Object.entries(files).map(([name, value]) => [name, m.record(value)]));
  const sourceCommit = 'c'.repeat(40), sourceTree = 'd'.repeat(40), rootSource = { sourceCommit: 'e'.repeat(40), sourceTree: 'f'.repeat(40) };
  const helper = elf('original-production-helper'), policy = fs.readFileSync(path.join(__dirname, '../../packaging/linux/com.creatorworks.hub.deb-retirement.production-016.policy'));
  const service = retirement.SERVICE_BYTES;
  const baseManifest = { ...structuredClone(manifest), payloadArchive: { sha256: 'a'.repeat(64) } };
  const baseBytes = { deb: Buffer.from('SYNTHETIC BASELINE DEB'), manifest: json(baseManifest) };
  baseBytes.rawHub = Buffer.concat([elf('baseline-Root16'), baseBytes.manifest]);
  const stagedFiles = { [retirement.HELPER]: { ...m.record(helper), mode: 0o755, uid: 0, gid: 0 },
    [retirement.POLICY]: { ...m.record(policy), mode: 0o644, uid: 0, gid: 0 } };
  const staging = { schemaVersion: 2, acceptanceOnly: true, sourceCommit, platform: 'linux', arch: 'x86_64',
    rootFeature: retirement.PRODUCTION_ROOT_FEATURE, helperFeature: retirement.PRODUCTION_HELPER_FEATURE,
    files: stagedFiles, profile: retirement.PRODUCTION_PROFILE, productionContract: retirement.PRODUCTION_CONTRACT, ...retirement.FLAGS };
  const proof = { schemaVersion: 1, profile: retirement.PRODUCTION_PROFILE, sourceCommit, sourceTree,
    compiledFeatures: [...p.FEATURES], rawHub: m.record(baseBytes.rawHub), staging };
  baseBytes.assemblyReceipt = json({ schemaVersion: 1, platform: 'linux', arch: 'x86_64', hubVersion: '0.1.16', assemblyCommit: sourceCommit,
    handoffSha256: originalRecords['handoff.json'].sha256, privateSource: prepared.source,
    compiledFeatures: [...p.FEATURES], productionMigration: proof, portableHostBuild: { schemaVersion: 1, version: '0.1.16', target: 'x86_64-unknown-linux-gnu',
      sourceCommit, sourceTree, compiledFeatures: [...p.FEATURES], startupImageBinding: 1, rawHub: m.record(baseBytes.rawHub) },
    privateModulesRecompiled: false, privateModulesResigned: false, nativeGuiAccepted: false, releaseReady: false });
  const zip = Buffer.from('SYNTHETIC BASELINE ZIP'), assembly = { sourceCommit, sourceTree, runId: 1001, runAttempt: 1, jobId: 1002,
    artifactId: 1003, zipBytes: zip.length, zipSha256: m.hash(zip) };
  const plan = { schemaVersion: 1, product: m.PRODUCT, hubVersion: p.VERSION, platform: 'linux', arch: 'x86_64', rootSource,
    original016: structuredClone(originalRecords), baseline016: { assembly, pins: { ...Object.fromEntries(Object.entries(baseBytes).map(([key, raw]) => [key, m.record(raw)])),
      hub: m.record(elf('baseline-installed-root')), helper: m.record(helper), policy: m.record(policy), service: m.record(service) } }, ...p.FLAGS };
  const run = { ...structuredClone(binding.run), id: assembly.runId, head_sha: sourceCommit, head_branch: 'validation/linux-integrated-candidate-016',
    event: 'workflow_dispatch', path: '.github/workflows/unix-managed-assembly.yml' };
  const job = { ...structuredClone(binding.jobs[0]), id: assembly.jobId, run_id: assembly.runId, head_sha: sourceCommit, name: 'assembly (linux, ubuntu-22.04)' };
  const artifact = { ...structuredClone(binding.artifact), id: assembly.artifactId, name: 'signed-unix-hub-linux-1001-1',
    size_in_bytes: zip.length, digest: `sha256:${m.hash(zip)}`, workflow_run: { ...binding.artifact.workflow_run, id: assembly.runId, head_sha: sourceCommit } };
  const baselineApi = { run, job, artifact, commit: { sha: sourceCommit, tree: { sha: sourceTree } } }, rootApi = { commit: { sha: rootSource.sourceCommit, tree: { sha: rootSource.sourceTree } } };
  files['plan.json'] = json(plan); files['baseline016.zip'] = zip;
  files['baseline016-api.json'] = json(baselineApi); files['root017-api.json'] = json(rootApi);
  files['runtime017.json'] = m.runtimeBytes(manifest); files['runtime017.minisig'] = Buffer.from('SYNTHETIC NEW RUNTIME SIGNATURE');
  files['derivation017.json'] = m.derivationBytes(plan, handoff, prepared, originalRecords, files['runtime017.json'], files['runtime017.minisig']);
  files['derivation017.minisig'] = Buffer.from('SYNTHETIC NEW WRAPPER SIGNATURE');
  return { files, plan, handoff, prepared, originalRecords, manifest, baseBytes, baselineApi, rootApi };
}
module.exports = { data, json, elf };
