'use strict';
// Public-only input and receipt boundary. No private transport or updater substitution.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const resources = require('./public-resources-025.cjs');
const binding = require('./fixtures/public-update-025-binding.json');
const { inspectFeed } = require('./check-release-feed.cjs');
const semver = require('semver');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const KIND = 'public-024-to-025';
const ASSET = 'Creator.Hub_0.1.25_x64-setup.exe';
const BASELINE_ASSET = 'Creator.Hub_0.1.24_x64-setup.exe';
const NAMES = [ASSET, 'creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig', 'latest.json'];
const FEED = 'https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases?per_page=10';
const BRANCH = 'codex/windows-public-missing-server-025';
const WORKFLOW = 'windows-outgoing-019.yml';
const CASES = { 'mcp-restore': ['mcp', 'true'], 'setup-restore': ['setup', 'true'], 'setup-no-restore': ['setup', 'false'] };
const bindingSha256 = hash(fs.readFileSync(path.join(__dirname, 'fixtures/public-update-025-binding.json')));
const url = (version, name) => `https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v${version}/${name}`;
const EXPECTED={"baseline":{"version":"0.1.24","asset":"Creator.Hub_0.1.24_x64-setup.exe","source":{"commit":"9e46f1a9212df4f56b4b7e1188e2afb8e33e264a","tree":"6567eb46f1d3bc70f94131dcfef79d1251896fcf"},"installer":{"bytes":38701568,"sha256":"ef8d0e3e59e25fbdfdc24ad3e739e568d4ddf8714dcd7bde6a0498045fe80db1"},"executable":{"bytes":19933696,"sha256":"69a5a90fe30c0d23d5ef08f6ed7f0820ba3dfba1851b448205493cee2e595000"},"manifest":{"schemaVersion":1,"platform":"windows","arch":"x86_64","modules":{"mcp":{"executable":"mcp/creator-works-mcp-launcher.exe","version":"2.7.10","files":{"mcp/creator-works-mcp-launcher.exe":"ed654b669dd094ccd2bca373e42932ae5f58607b05db39286f2bc8579ebff4e2","mcp/server/creator-works-mcp.mjs":"fb1958548f3c071b2b595e98946452c53b5a1b9fa1e419e06f4ec87f0c72f412","mcp/server/runtime/node.exe":"c6335d08331c23d68b9f2b18adb102002d76ef150b47248e954c507e0d033664","mcp/server/runtime/LICENSE":"8efdacdc1cfa3460aeb7fe98e3c54337b971d5da70e6eee292b73b981acb220c","mcp/server/runtime/VERSION":"98182b41c9ce3357797985cf12dc3b0124490ef88bc918a905373e7688e6aec9","mcp/server/unity-extension/Editor/BanterMCPBridge.cs":"fe21aefe30c7b48e3b9c487905a75a807371397006138852701bc287fc7570cd","mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png":"f3f68baa0d887de92e6cf7aba8beae7ff8ea5c44b13444f018413041ade19ea7","mcp/server/LICENSE":"b1cfe8ff7191d3e9c6c6b0f832adcd2ebece8e6070ef72d2f7afc1c082fb757f","mcp/server/THIRD_PARTY_NOTICES.md":"3596f4ad9f49cd460fa4da49ce3f1b92ad2f67113270b96d361e7e27ae0460af"}},"setup":{"executable":"setup/creator-project-setup.exe","version":"0.3.7","files":{"setup/creator-project-setup.exe":"abafc45e89f6688284bc306d6da62775dbb194662dc369976becb48e5c09156f"}}},"managedRouting":{"protocol":1,"files":{"routing/creator-hub-mcp-router.exe":"6f959f6f8919538084d26c1800868aaa3b7b18545cba96de3e0b04782115a967","routing/router.json":"5760ee356aa49fc79f9fba3db281e0e628d0a187491d26312aa6cdb604b5e2e3","routing/router.minisig":"8c8a3d64532900a6079eb5d164b0706777a420450db78d053269d7840372fa00","routing/runtime.json":"030b0ea3e01e0a367b145df958ace040a5f31b3c95a522a0702d128f4fd965ae","routing/runtime.minisig":"9cc21ac19bbacaa6d8d42ac5950ef5eb629e41fe6c12e496ced6040c71e23ccd"}}},"generation":"df0ec83365a0ed5e235c784243531676467e56bfeafce43c818d5309022c2b54","sourceUnchanged":true,"buildExitCode":0,"verificationReceiptSha256":"926d0645ebba86f874f99b80dee372e13b69742c78431b8405dc59efc6041e3a","releaseId":447323263,"assetId":755655839},"target":{"version":"0.1.25","asset":"Creator.Hub_0.1.25_x64-setup.exe","source":{"commit":"46e610c51bb525e868e7caf4a21a2a7c2fcb3160","tree":"0cf5954df3d40d9c7ee073fb06e9c61f401e908a"},"installer":{"bytes":38708024,"sha256":"8521ed72e9fbee31c8a379bce0204288926862939dced9b4153164a1c7c71b6c"},"executable":{"bytes":19940352,"sha256":"9fc2da9340995f4fe5b7f1f4dfb1a6b28449970934d6aaca4c8ab971e791b27c"},"manifest":{"schemaVersion":1,"platform":"windows","arch":"x86_64","modules":{"mcp":{"executable":"mcp/creator-works-mcp-launcher.exe","version":"2.7.10","files":{"mcp/creator-works-mcp-launcher.exe":"ed654b669dd094ccd2bca373e42932ae5f58607b05db39286f2bc8579ebff4e2","mcp/server/creator-works-mcp.mjs":"fb1958548f3c071b2b595e98946452c53b5a1b9fa1e419e06f4ec87f0c72f412","mcp/server/runtime/node.exe":"c6335d08331c23d68b9f2b18adb102002d76ef150b47248e954c507e0d033664","mcp/server/runtime/LICENSE":"8efdacdc1cfa3460aeb7fe98e3c54337b971d5da70e6eee292b73b981acb220c","mcp/server/runtime/VERSION":"98182b41c9ce3357797985cf12dc3b0124490ef88bc918a905373e7688e6aec9","mcp/server/unity-extension/Editor/BanterMCPBridge.cs":"fe21aefe30c7b48e3b9c487905a75a807371397006138852701bc287fc7570cd","mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png":"f3f68baa0d887de92e6cf7aba8beae7ff8ea5c44b13444f018413041ade19ea7","mcp/server/LICENSE":"b1cfe8ff7191d3e9c6c6b0f832adcd2ebece8e6070ef72d2f7afc1c082fb757f","mcp/server/THIRD_PARTY_NOTICES.md":"3596f4ad9f49cd460fa4da49ce3f1b92ad2f67113270b96d361e7e27ae0460af"}},"setup":{"executable":"setup/creator-project-setup.exe","version":"0.3.7","files":{"setup/creator-project-setup.exe":"abafc45e89f6688284bc306d6da62775dbb194662dc369976becb48e5c09156f"}}},"managedRouting":{"protocol":1,"files":{"routing/creator-hub-mcp-router.exe":"6f959f6f8919538084d26c1800868aaa3b7b18545cba96de3e0b04782115a967","routing/router.json":"5760ee356aa49fc79f9fba3db281e0e628d0a187491d26312aa6cdb604b5e2e3","routing/router.minisig":"8c8a3d64532900a6079eb5d164b0706777a420450db78d053269d7840372fa00","routing/runtime.json":"d4349430fb0f884d51981ffd5d520893c49035433dd22536389eac7d5093ce53","routing/runtime.minisig":"20919231cf1808c9b9fef33fb8c6ba8ebd1aa3f70d723efa04ac80e0040108fa"}}},"generation":"df0ec83365a0ed5e235c784243531676467e56bfeafce43c818d5309022c2b54","sourceUnchanged":true,"buildExitCode":0,"verificationReceiptSha256":"472a956ade47ada940fc512dffa9595b124f1bb3f0d8151e1aa33e6dc8d1b29a","descriptor":{"bytes":505,"sha256":"e38dc5fb40acd07712c4ddced0af82e849c363570b32a6a55954cc17d028dc6f"},"descriptorSignature":{"bytes":300,"sha256":"628b0c43414a36e57fd1b7d9791c70d4679112a28648d3ae7865e6f301e928d9"},"latest":{"bytes":705,"sha256":"36f6be558b5058be6453c389ce3c25c279438f4b810728f55cef21d7fabc64a4"}},"originalLatest":{"version":"0.1.25","notes":"Private Windows 0.1.25 missing-server recovery candidate. Not published.","platforms":{"windows-x86_64":{"signature":"dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUK2F5K1IyZ2ZXTVVUMWtVcnlWZnhoOVRncmpxQ2lFWEFZc2FSZEVFMldac0d5U1oyN1htNWFJd0hPaEM1b0JENjlOY29TeTdoY1pvVVhBUklBc25RUk5zRWJjY3BOTEFJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0ODY4OTE0CWZpbGU6aW5zdGFsbGVyLmV4ZQpod1RubnVBOVlGUm5GdU9jcW8xdEo4eDNBd0VhTndlRW9EV3VQNEhrTnhEeGE3KzdUaDl0NHdPb1U1eWJlTjNQQVpuc1cvUFdOZWVGN1I2MEJBNkRDZz09Cg==","url":"https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.25/Creator.Hub_0.1.25_x64-setup.exe"}}}};
function validateBinding(value=binding) {
  assert.equal(value.enabled,true,'Public readback pins pending');assert.equal(value.kind,KIND);assert.equal(value.publicOnly,true);
  assert.deepEqual(value.baseline,EXPECTED.baseline);assert.deepEqual(value.originalLatest,EXPECTED.originalLatest);
  const target={...value.target,latest:EXPECTED.target.latest};assert.deepEqual(target,EXPECTED.target);
  assert.equal(value.qualificationSha256,EXPECTED.target.verificationReceiptSha256);
  assert.equal(typeof value.publicNotes,'string');assert.ok(value.publicNotes.trim());assert.ok(Buffer.byteLength(value.publicNotes)<=8192);
  assert.ok(!/private|not published|not release-qualified/i.test(value.publicNotes));
  assert.ok(value.target.latest.bytes>0&&value.target.latest.bytes<=32768);assert.match(value.target.latest.sha256,/^[a-f0-9]{64}$/);
  const p=value.publication;assert.ok(p);assert.equal(p.tag,'v0.1.25');assert.equal(p.draft,false);assert.equal(p.prerelease,false);
  assert.equal(p.tagCommit,EXPECTED.target.source.commit);assert.ok(Number.isSafeInteger(p.releaseId)&&p.releaseId>0);
  assert.ok(![447075046,447214271].includes(p.releaseId));assert.deepEqual(Object.keys(p.assets).sort(),[...NAMES].sort());
  const pins=[value.target.installer,value.target.descriptor,value.target.descriptorSignature,value.target.latest],ids=new Set([value.baseline.assetId]);
  for(const [i,n]of NAMES.entries()){const a=p.assets[n];assert.ok(Number.isSafeInteger(a.id)&&a.id>0&&!ids.has(a.id));ids.add(a.id);assert.deepEqual({bytes:a.size,sha256:a.sha256},pins[i]);}
  return p;
}
function assertAdmission(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32'); validateBinding();
  for (const [key, expected] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'acceptance',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_REF: `refs/heads/${BRANCH}`,
    GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/.github/workflows/${WORKFLOW}@refs/heads/${BRANCH}` })) assert.equal(env[key], expected, key);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/); assert.equal(env.EXPECTED_HARNESS_COMMIT, env.GITHUB_SHA);
  assert.equal(env.CREATOR_PUBLIC_BINDING_SHA256, bindingSha256);
  assert.ok(Object.hasOwn(CASES, env.CREATOR_OUTGOING_CASE));
  assert.deepEqual([env.CREATOR_OUTGOING_LAST_TOOL, env.CREATOR_OUTGOING_RESTORE], CASES[env.CREATOR_OUTGOING_CASE]);
  for (const [key, value] of Object.entries(env)) if (/^(?:https?_proxy|all_proxy|no_proxy|node_options|node_use_env_proxy|node_tls_reject_unauthorized|node_extra_ca_certs|ssl_cert_file|ssl_cert_dir|curl_ca_bundle|requests_ca_bundle|gh_token|github_token|creator_.*(?:lab|fixture|migrated|incoming|outgoing_config|outgoing_review).*)$/i.test(key)) {
    assert.ok(value === undefined || value === '', `Public transport refuses ${key}`);
  }
}
function checkRelease(bytes) {
  const p = validateBinding(), summary = inspectFeed(bytes, '0.1.25');
  assert.equal(summary.previousStable, '0.1.24');
  assert.ok(summary.headroom>=4096,'Public feed must retain publication headroom');
  const releases = JSON.parse(bytes), selected = releases.filter(r => r.tag_name === p.tag);
  const stable = releases.filter(r => !r.draft && !r.prerelease)
    .map(r => String(r.tag_name).replace(/^v/, '')).filter(v => semver.valid(v) && !semver.prerelease(v)).sort(semver.rcompare);
  assert.equal(stable[0], '0.1.25', 'Only the exact newest public stable is admitted');
  assert.equal(selected.length, 1); const r = selected[0];
  assert.equal(r.id, p.releaseId); assert.equal(r.draft, false); assert.equal(r.prerelease, false);
  assert.equal(r.assets.length, NAMES.length);
  for (const name of NAMES) {
    const rows = r.assets.filter(a => a.name === name); assert.equal(rows.length, 1);
    const a = rows[0], pin = p.assets[name];
    assert.equal(a.id, pin.id); assert.equal(a.size, pin.size); assert.equal(a.digest, `sha256:${pin.sha256}`);
    assert.equal(a.state, 'uploaded'); assert.equal(a.browser_download_url, url('0.1.25', name));
  }
  const old = releases.filter(r => r.tag_name === 'v0.1.24'); assert.equal(old.length, 1);
  assert.equal(old[0].id, binding.baseline.releaseId); assert.equal(old[0].draft, false); assert.equal(old[0].prerelease, false);
  const assets = old[0].assets.filter(a => a.name === BASELINE_ASSET); assert.equal(assets.length, 1);
  assert.equal(assets[0].id, binding.baseline.assetId); assert.equal(assets[0].size, binding.baseline.installer.bytes);
  assert.equal(assets[0].digest, `sha256:${binding.baseline.installer.sha256}`);
  assert.equal(assets[0].browser_download_url, url('0.1.24', BASELINE_ASSET));
  return summary;
}
async function publicBytes(address, max, fetcher = fetch) {
  assert.ok(address === FEED || address === url('0.1.24', BASELINE_ASSET) || NAMES.some(n => address === url('0.1.25', n)));
  const response = await fetcher(address, { headers: { 'User-Agent': 'Creator-Hub-public-acceptance/0.1.25' },
    signal: AbortSignal.timeout(max > 1048576 ? 180000 : 30000) });
  assert.equal(response.ok, true, `Public HTTP ${response.status}`);
  const parts = []; let length = 0;
  for await (const part of response.body) { length += part.length; assert.ok(length <= max); parts.push(part); }
  assert.ok(length > 0); return Buffer.concat(parts);
}
const directory = () => path.resolve('artifacts/public-update-025-input');
function configFor(dir = directory()) {
  validateBinding();
  return { schemaVersion: 1, kind: KIND, directory: dir, sourceCommit: binding.target.source.commit,
    baseline: { version: '0.1.24', installer: binding.baseline.installer.sha256, exe: binding.baseline.executable.sha256 },
    targetVersion: '0.1.25', pins: { descriptor: binding.target.descriptor.sha256, descriptorSignature: binding.target.descriptorSignature.sha256,
      installer: binding.target.installer.sha256, executable: binding.target.executable.sha256, manifest: binding.target.latest.sha256 },
    runtime: { baselineDescriptor: binding.baseline.manifest.managedRouting.files['routing/runtime.json'], targetDescriptor: binding.target.manifest.managedRouting.files['routing/runtime.json'] } };
}
function assertBound(config) { assert.deepEqual(config, configFor()); }
function readConfig(file) {
  assert.equal(file, path.join(directory(), 'config.json'));
  const config = JSON.parse(resources.readBounded(file, 32768)); assertBound(config); return config;
}
function proofFor(bytes, env = process.env) {
  return { schemaVersion: 1, kind: KIND, harnessSource: env.GITHUB_SHA, bindingSha256,
    source: binding.target.source, releaseId: validateBinding().releaseId, tagCommit: binding.publication.tagCommit,
    publicFeedUrl: FEED, publicFeedSha256: hash(bytes), feed: checkRelease(bytes), baseline: configFor().baseline,
    pins: configFor().pins, authenticatedDownload: false, lab: false, fixture: false };
}
function checkSidecars(dir) {
  const latest = JSON.parse(resources.readBounded(path.join(dir, 'latest.json'), 32768));
  const a = { ...latest }, b = { ...binding.originalLatest }; delete a.notes; delete b.notes;
  assert.deepEqual(a, b, 'Only public notes may differ'); assert.equal(latest.notes, binding.publicNotes);
  assert.equal(latest.platforms['windows-x86_64'].url, url('0.1.25', ASSET));
}
async function prepare() {
  assertAdmission(); const dir = directory(); assert.equal(fs.existsSync(dir), false); fs.mkdirSync(dir, { recursive: true });
  const feed = await publicBytes(FEED, 256 * 1024); checkRelease(feed);
  fs.writeFileSync(path.join(dir, 'public-feed.json'), feed, { flag: 'wx' });
  const pins = { ...binding.publication.assets, [BASELINE_ASSET]: { size: binding.baseline.installer.bytes, sha256: binding.baseline.installer.sha256 } };
  for (const [name, pin] of Object.entries(pins)) {
    const bytes = await publicBytes(url(name === BASELINE_ASSET ? '0.1.24' : '0.1.25', name), pin.size);
    assert.equal(bytes.length, pin.size); assert.equal(hash(bytes), pin.sha256);
    fs.writeFileSync(path.join(dir, name), bytes, { flag: 'wx' });
  }
  checkSidecars(dir);
  fs.writeFileSync(path.join(dir, 'public-input-binding.json'), JSON.stringify(proofFor(feed), null, 2), { flag: 'wx' });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(configFor(), null, 2), { flag: 'wx' });
}
function loadContract(config) {
  assertAdmission(); assertBound(config); const dir = directory();
  const bytes = resources.readBounded(path.join(dir, 'public-feed.json'), 256 * 1024);
  const proof = proofFor(bytes), input = resources.readBounded(path.join(dir, 'public-input-binding.json'), 32768);
  assert.deepEqual(JSON.parse(input), proof);
  for (const [name, pin] of Object.entries(binding.publication.assets)) {
    const b = resources.readBounded(path.join(dir, name), pin.size); assert.equal(b.length, pin.size); assert.equal(hash(b), pin.sha256);
  }
  resources.readHash(path.join(dir, BASELINE_ASSET), binding.baseline.installer.sha256);
  checkSidecars(dir); return { ...proof, inputBindingSha256: hash(input) };
}
module.exports = { ...resources, hash, KIND, ASSET, BASELINE_ASSET, NAMES, CASES, FEED, BRANCH, WORKFLOW, url, binding, bindingSha256,
  validateBinding, assertAdmission, checkRelease, publicBytes, directory, configFor, assertBound, readConfig, proofFor, loadContract, prepare };
if (require.main === module) {
  assert.equal(process.argv[2], 'prepare');
  prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
}
