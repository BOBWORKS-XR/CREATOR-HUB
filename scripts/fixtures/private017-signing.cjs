'use strict';
// All data, tools and signatures here are synthetic. No private key exists or is read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const m = require('../private-linux-update-fixture-017-metadata.cjs');
const writer = require('../sign-private-linux-update-fixture-017.cjs');
const original = require('../assemble-unix-payload.cjs');
const builder = require('../build-unified.cjs');
const native = require('../native-linux-016-input.cjs');
const { validateBinding } = require('../unix-payload-binding.cjs');
const { compactProof } = require('../sign-unix-payload.cjs');
const { runtimeDescriptor } = require('../mcp-runtime-descriptor.cjs');
const { data, json, elf } = require('./private-linux-update-fixture-017.cjs');
const signature = body => Buffer.from(`untrusted comment: Synthetic ${m.hash(body)}`);
function create(t, fault = '') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'private017-sign-unit-')));
  t.after(() => {
    assert.equal(fs.realpathSync(root), root); assert.ok(path.basename(root).startsWith('private017-sign-unit-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  function put(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; }
  const f = data(), manifest = structuredClone(f.manifest), raw = {};
  for (const module of Object.values(manifest.modules)) for (const name of Object.keys(module.files)) {
    const value = Buffer.from(`Never-executed private fixture ${name}`); raw[`modules/${name}`] = value;
    module.files[name] = m.hash(value); f.prepared.files[`modules/${name}`] = { ...f.prepared.files[`modules/${name}`], ...m.record(value) };
  }
  const unsigned = structuredClone(manifest); delete unsigned.managedRouting;
  raw['builtin-manifest.json'] = json(unsigned); raw['mcp-runtime.json'] = Buffer.from(JSON.stringify(runtimeDescriptor(unsigned, '0.1.16')));
  raw['router-for-package'] = elf('original-router');
  for (const [name, value] of Object.entries(raw)) f.prepared.files[name] = { ...f.prepared.files[name], ...m.record(value) };
  f.files['prepared-unix.json'] = json(f.prepared);
  f.files['routing/router.json'] = Buffer.from(JSON.stringify({ schemaVersion: 1, product: 'com.creatorworks.hub.mcp-router',
    platform: 'linux', arch: 'x86_64', protocol: 1, sha256: m.hash(raw['router-for-package']) }));
  f.files['routing/runtime.json'] = raw['mcp-runtime.json'];
  for (const name of ['router', 'runtime']) f.files[`routing/${name}.minisig`] = signature(f.files[`routing/${name}.json`]);
  f.handoff.routingMetadata = Object.fromEntries(original.ROUTING.map(name => [name, { ...m.record(f.files[name]), mode: 0o644 }]));
  f.handoff.payloadFiles = Object.fromEntries(Object.keys(raw).filter(name => name.startsWith('modules/')).map(name => [name.slice(8), f.prepared.files[name]]));
  f.handoff.payloadFiles['routing/creator-hub-mcp-router'] = f.prepared.files['router-for-package'];
  Object.assign(f.handoff.payloadFiles, f.handoff.routingMetadata);
  manifest.managedRouting.files = Object.fromEntries(Object.entries(f.handoff.payloadFiles).filter(([name]) => name.startsWith('routing/')).map(([name, pin]) => [name, pin.sha256]));
  f.handoff.builtinManifest = manifest;
  f.handoff.transferFiles = Object.fromEntries(original.TRANSFER.map(name => [name, m.record(f.files[name])]));
  const binding = { ...f.handoff.apiProof, prepared: f.prepared };
  f.handoff.apiProof = compactProof({ binding, verified: validateBinding(binding) });
  f.files['handoff.json'] = json(f.handoff); f.files['handoff.minisig'] = signature(f.files['handoff.json']);
  f.plan.original016 = Object.fromEntries(original.INPUTS.map(name => [name, m.record(f.files[name])]));
  f.baseBytes.manifest = json({ ...structuredClone(manifest), payloadArchive: { sha256: 'a'.repeat(64) } });
  f.baseBytes.rawHub = Buffer.concat([elf(builder.PORTABLE_ROOT_WITNESSES.join('\n')), f.baseBytes.manifest]);
  const receipt = JSON.parse(f.baseBytes.assemblyReceipt);
  receipt.handoffSha256 = m.hash(f.files['handoff.json']); receipt.privateSource = f.handoff.source;
  receipt.productionMigration.rawHub = receipt.portableHostBuild.rawHub = m.record(f.baseBytes.rawHub);
  f.baseBytes.assemblyReceipt = json(receipt);
  for (const [name, value] of Object.entries(f.baseBytes)) f.plan.baseline016.pins[name] = m.record(value);
  const input = path.join(root, 'artifacts/input');
  for (const name of writer.INPUTS) put(path.join(input, name), f.files[name]);
  const planFile = put(path.join(root, 'approved-plan.json'), json(f.plan));
  const inputs = { input, plan: planFile, planSha256: m.hash(json(f.plan)), output: path.join(root, 'artifacts/signed017') };
  const tools = writer.tools(root);
  for (const file of Object.values(tools)) put(file, 'Synthetic fixed verifier. Never executed.');
  const treeMap = new Map(), trie = {};
  for (const name of native.PRIVATE_PATHS) {
    const parts = name.split('/'); let current = trie;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i], full = parts.slice(0, i + 1).join('/');
      current[part] ||= { path: part, type: i === parts.length - 1 && !['modules/mcp', 'modules/project-setup', 'native/mcp-router'].includes(name) ? 'blob' : 'tree',
        sha: m.hash(Buffer.from(full)).slice(0, 40), children: {} };
      current = current[part].children;
    }
  }
  function populate(children) {
    for (const row of Object.values(children)) if (row.type === 'tree') {
      treeMap.set(row.sha, { truncated: false, tree: Object.values(row.children).map(({ children: _, ...entry }) => entry) }); populate(row.children);
    }
  }
  populate(trie);
  const roots = [f.handoff.apiProof.commit, f.baselineApi.commit, f.rootApi.commit];
  for (const c of roots) treeMap.set(c.tree.sha, { truncated: false, tree: Object.values(trie).map(({ children: _, ...entry }) => entry) });
  if (fault === 'private-source') {
    const rootTree = structuredClone(treeMap.get(f.rootApi.commit.tree.sha));
    const tauri = rootTree.tree.find(row => row.path === 'src-tauri');
    const tauriTree = structuredClone(treeMap.get(tauri.sha)); tauri.sha = '7'.repeat(40);
    const src = tauriTree.tree.find(row => row.path === 'src');
    const srcTree = structuredClone(treeMap.get(src.sha)); src.sha = '8'.repeat(40);
    srcTree.tree.find(row => row.path === 'catalog-key.pub').sha = '9'.repeat(40);
    treeMap.set(f.rootApi.commit.tree.sha, rootTree); treeMap.set(tauri.sha, tauriTree); treeMap.set(src.sha, srcTree);
  }
  const calls = [], requests = []; let keys = 0, signatures = 0;
  const key = path.join(root, 'no-such-key');
  async function request(route) {
    requests.push(route);
    const p = f.handoff.apiProof;
    let response;
    if (route === `actions/runs/${p.expected.runId}`) response = p.run;
    else if (route === `actions/artifacts/${p.expected.artifactId}`) response = p.artifact;
    else if (route.includes('/jobs?')) response = { total_count: p.jobs.length, jobs: p.jobs };
    else if (route === `actions/runs/${f.plan.baseline016.assembly.runId}`) response = f.baselineApi.run;
    else if (route === `actions/jobs/${f.plan.baseline016.assembly.jobId}`) response = f.baselineApi.job;
    else if (route === `actions/artifacts/${f.plan.baseline016.assembly.artifactId}`) response = f.baselineApi.artifact;
    else if (route.startsWith('git/commits/')) response = roots.find(c => c.sha === route.slice(12));
    else if (route.startsWith('git/trees/')) response = treeMap.get(route.slice(10));
    else if (route.startsWith('contents/')) {
      const name = route.slice(9).split('?')[0];
      const value = { version: fault === 'source-version' ? '0.1.16' : '0.1.17', ...(name === 'package-lock.json' ? { packages: { '': { version: '0.1.17' } } } : {}) };
      const body = json(value); response = { path: name, type: 'file', encoding: 'base64', sha: 'a'.repeat(40), size: body.length, content: body.toString('base64') };
    }
    assert.ok(response, `Unexpected fixture API route ${route}`);
    const copy = structuredClone(response);
    if (fault === 'original-api' && route === `actions/runs/${p.expected.runId}`) copy.conclusion = 'failure';
    if (fault === 'baseline-api' && route === `actions/jobs/${f.plan.baseline016.assembly.jobId}`) copy.head_sha = 'a'.repeat(40);
    if (fault === 'root-api' && route === `git/commits/${f.plan.rootSource.sourceCommit}`) copy.tree.sha = 'a'.repeat(40);
    if (fault === 'tree-truncated' && route.startsWith('git/trees/')) copy.truncated = true;
    if (fault === 'api-input-drift') fs.appendFileSync(path.join(input, 'modules.tar.gz'), 'changed');
    return copy;
  }
  function execute(program, args) {
    calls.push({ program, args: [...args] });
    if (program === tools.verifier) {
      const body = fs.readFileSync(args[0]), sig = fs.readFileSync(args[1]);
      assert.ok(sig.equals(signature(body)), 'Mock production verifier refused');
      if (fault === 'post-output-drift' && path.dirname(args[0]) === inputs.output) fs.appendFileSync(path.join(inputs.output, 'modules.tar.gz'), 'changed');
      return `Verified trusted package signature: ${m.hash(body)}. No activation or client changes.`;
    }
    if (program === tools.transfer) {
      if (fault === 'carrier') throw Error('Mock transfer refused');
      assert.deepEqual(args.slice(1, 4).map(file => fs.readFileSync(file)), original.TRANSFER.map(name => f.files[name]));
      if (args[0] === 'extract') {
        for (const [name, value] of Object.entries(raw)) put(path.join(args[4], name), fault === 'raw' && name.includes('runtime/node') ? 'changed' : value);
        put(path.join(args[4], 'prepared-unix.json'), f.files['prepared-unix.json']);
      } else assert.equal(args[0], 'verify');
      return 'Unsigned transfer checked. No payload execution, signing, activation or release acceptance.';
    }
    assert.equal(program, 'python'); assert.deepEqual(args.slice(0, 3), ['-B', tools.baseline, '--stage-baseline']);
    if (fault === 'baseline-zip') throw Error('Mock baseline ZIP refused');
    const destination = args[5];
    for (const [name, member] of Object.entries(m.BASELINE_MEMBERS)) put(path.join(destination, name === 'deb' ? 'baseline016.deb' : path.posix.basename(member)),
      fault === 'baseline-root' && name === 'rawHub' ? 'changed' : f.baseBytes[name]);
    const expected = JSON.parse(fs.readFileSync(args[4]));
    return JSON.stringify({ scope: 'pinned016-zip-staging-only', files: expected.files, releaseReady: false });
  }
  const signer = {
    signingKey(selected) {
      assert.equal(selected, root); assert.equal(fs.existsSync(key), false); keys++;
      if (fault === 'key-failure') throw Error('PRIVATE DETAIL MUST NOT ESCAPE');
      return key;
    },
    signDetached(file, selected) {
      assert.equal(selected, key); assert.equal(fs.existsSync(key), false); signatures++;
      assert.ok(file.includes('private017-sign-work-')); assert.ok(!file.startsWith(inputs.output + path.sep));
      const body = fs.readFileSync(file), result = signature(body);
      if (fault === 'sign-failure' || fault === 'second-sign-failure' && signatures === 2) throw Error('PRIVATE DETAIL MUST NOT ESCAPE');
      if (fault === 'body-drift') fs.appendFileSync(file, 'changed');
      if (fault === 'input-drift') fs.appendFileSync(path.join(input, 'modules.tar.gz'), 'changed');
      if (fault === 'plan-drift') fs.appendFileSync(planFile, 'changed');
      if (fault === 'tool-drift') fs.appendFileSync(tools.verifier, 'changed');
      if (fault === 'output-drift') fs.appendFileSync(path.join(inputs.output, 'plan.json'), 'changed');
      if (fault === 'raw-drift') fs.appendFileSync(path.join(path.dirname(file), 'original016/mcp-runtime.json'), 'changed');
      put(`${file}.sig`, result.toString('base64'));
      return fault === 'signature' ? Buffer.from('invalid') : fault === 'signature-size' ? Buffer.alloc(4097) : result;
    },
  };
  return { ...f, root, raw, inputs, tools, calls, requests, services: { root, platform: 'win32', execute, request, signer }, count: () => ({ keys, signatures }), put };
}
module.exports = { create, signature };
