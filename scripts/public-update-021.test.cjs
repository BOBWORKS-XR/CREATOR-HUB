'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const api = require('./public-update-021.cjs');
const reader = require('./windows-021-public-acceptance.cjs');
const encode = v => Buffer.from(JSON.stringify(v));
const UNIT_FIXTURE = {"binding":{"schemaVersion":1,"kind":"public-020-to-021","baseline":{"source":{"commit":"9b65dd7aedc2eb224755db3d733a7fb19e8e8f62","tree":"3048c4b2c8e5004024191dbb29f5651e5d6bb7e8"},"version":"0.1.20","asset":"Creator.Hub_0.1.20_x64-setup.exe","installer":{"bytes":38461485,"sha256":"2915ffac9b1c39f5facbd4030eb6addf837e0d414b96835e0f0be1564577666b"},"executable":{"bytes":19594240,"sha256":"06908120c81f471e9774edbe5a2d09fa3c985357eea373e29e75404d1f133cf5"},"manifest":{"schemaVersion":1,"platform":"windows","arch":"x86_64","modules":{"mcp":{"executable":"mcp/creator-works-mcp-launcher.exe","version":"2.7.8","files":{"mcp/creator-works-mcp-launcher.exe":"6f0135705c5f894e8abb217b7440d774b36be940087d98e2c7019ea07dd506d7","mcp/server/creator-works-mcp.mjs":"a6b309038ccc369299ed194e2f7e494c271aa1106ed6884a5f385a091d22de99","mcp/server/runtime/node.exe":"c6335d08331c23d68b9f2b18adb102002d76ef150b47248e954c507e0d033664","mcp/server/runtime/LICENSE":"8efdacdc1cfa3460aeb7fe98e3c54337b971d5da70e6eee292b73b981acb220c","mcp/server/runtime/VERSION":"98182b41c9ce3357797985cf12dc3b0124490ef88bc918a905373e7688e6aec9","mcp/server/unity-extension/Editor/BanterMCPBridge.cs":"14c3b9d112f4bec70cb63237b532e913e726aba0d7c3e8ed4e2fc4d26713a130","mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png":"f3f68baa0d887de92e6cf7aba8beae7ff8ea5c44b13444f018413041ade19ea7","mcp/server/LICENSE":"b1cfe8ff7191d3e9c6c6b0f832adcd2ebece8e6070ef72d2f7afc1c082fb757f","mcp/server/THIRD_PARTY_NOTICES.md":"3596f4ad9f49cd460fa4da49ce3f1b92ad2f67113270b96d361e7e27ae0460af"}},"setup":{"executable":"setup/creator-project-setup.exe","version":"0.3.7","files":{"setup/creator-project-setup.exe":"be1f9827869636234d1f7e4ccf90f28b9332fb4fae1393542599b9fea22efb58"}}},"managedRouting":{"protocol":1,"files":{"routing/creator-hub-mcp-router.exe":"7bdd33b3dba91fae11ac97a845d2dc71f2ea25b932a54a86c25aaba1af7489da","routing/router.json":"ac18d34c91690d2ac1f22a8b3950e6415ee2895e77d93c999b17655aecffb01e","routing/router.minisig":"da54fb3c0aabbc0d510f4cd7b9f56d7da68221306411e4507099945341caa81e","routing/runtime.json":"44242fd365b2eacb062e74dc0a0764610ee38ac06355c93ae79c4dc505bba333","routing/runtime.minisig":"265c731df1738a69a3852e757dee0c3e6ce1b934ec2eb62d8959dd0236e69665"}}},"generation":"9f866910d3113caac0e9c6a6db2df326c0f64c33e5b46300d6960f28cf2189aa","sourceUnchanged":true,"buildExitCode":0,"verificationReceiptSha256":"99972a7c38bdc8ad6549c0d5bd30782aa7cd25cd8760239dd854857f12b79a00","releaseId":435215396,"assetId":713452102},"target":{"source":{"commit":"35411a704707cba5915f77d51bf156e4ec8ce251","tree":"4f80b815406aedf577a3f9cb78c1f7fd6caf968b"},"version":"0.1.21","asset":"Creator.Hub_0.1.21_x64-setup.exe","installer":{"bytes":38469639,"sha256":"09dd6563e5e93a533f7ddedc600c785f56d123f55d1e29a8eada6ab3941cf2b3"},"executable":{"bytes":19592704,"sha256":"b29fe05699196383bbd376f23af934fe9f603761c3de285f16e6c4a3095222f5"},"manifest":{"schemaVersion":1,"platform":"windows","arch":"x86_64","modules":{"mcp":{"executable":"mcp/creator-works-mcp-launcher.exe","version":"2.7.9","files":{"mcp/creator-works-mcp-launcher.exe":"0edc1da931e7e8f8bdd28d8de65397a7ab76ac784111c936cd6b6e78c0b652e2","mcp/server/creator-works-mcp.mjs":"115adb67aedce3f88ae798872f1c269d992cf410b50755138033eda6484b8d29","mcp/server/runtime/node.exe":"c6335d08331c23d68b9f2b18adb102002d76ef150b47248e954c507e0d033664","mcp/server/runtime/LICENSE":"8efdacdc1cfa3460aeb7fe98e3c54337b971d5da70e6eee292b73b981acb220c","mcp/server/runtime/VERSION":"98182b41c9ce3357797985cf12dc3b0124490ef88bc918a905373e7688e6aec9","mcp/server/unity-extension/Editor/BanterMCPBridge.cs":"b8c863926455876cdf618089ade4d179c3dc34efbd6dc41f3e612893c98aa7a7","mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png":"f3f68baa0d887de92e6cf7aba8beae7ff8ea5c44b13444f018413041ade19ea7","mcp/server/LICENSE":"b1cfe8ff7191d3e9c6c6b0f832adcd2ebece8e6070ef72d2f7afc1c082fb757f","mcp/server/THIRD_PARTY_NOTICES.md":"3596f4ad9f49cd460fa4da49ce3f1b92ad2f67113270b96d361e7e27ae0460af"}},"setup":{"executable":"setup/creator-project-setup.exe","version":"0.3.7","files":{"setup/creator-project-setup.exe":"1f307fa96ccd1ac83673a89743a7bd4de4d58dbaa8e778b5c65f8fd4e56ca216"}}},"managedRouting":{"protocol":1,"files":{"routing/creator-hub-mcp-router.exe":"e20ebdeff12ae3d3952324ad3ef4253d99632b66d2ec95807ae5039c291f42ba","routing/router.json":"52b5b10c24c782f0b8b8b3c6bbf2f6d39794245cb0e85f98311ed381f44fb384","routing/router.minisig":"2481f98e7e899834ac865e6ea14921da090a797d276fc82e0350afb8f6ac8aba","routing/runtime.json":"a935daded657eef08abd7d8b910fa7b1104e6511f17f5f40f133397d0035b5b4","routing/runtime.minisig":"e220e3ea3eb43aa9635059f74d4e1c2e43a4ec080c035fda148dc078bb24d19c"}}},"generation":"b699e71e7db1b12940aaa500ceda1f8a0ff5ce99bb29c7dd9309bc962bd5b11b","verificationReceiptSha256":"3aeebc8a492b8d698b2d49b7bf30d7fb843e98d77fecc191e2874b59010f6fdc","sourceUnchanged":true,"buildExitCode":0,"descriptor":{"bytes":505,"sha256":"2a5ef416550d19f711f103e861b00bf55ed22a86cfd3e65080b18e2e7bced724"},"descriptorSignature":{"bytes":305,"sha256":"2089048100a505c6479bf1f3d4d5d1892e7956aabd74c616416a4c2fcb8437a9"},"latest":{"bytes":690,"sha256":"3aaf7d60f4bbae0156a6377ac233f86c39a951639e342eeaf6ea2ba384377428"}},"originalLatest":{"version":"0.1.21","notes":"Private candidate acceptance only; not published.","platforms":{"windows-x86_64":{"signature":"dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUK2F5K1IyZ2ZXTWZDS1Z2UlFyQVBsZ3JoNGQxcUV0Q053Yno2bFFzOWVLYnkvVVhTeVlUTWE3V0lURklBNlNncllMVWtETXhnV0NMZkR2OGdtanlmZ2N6WFFhbFpFK2dBPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzOTk5ODY2CWZpbGU6c2lnbmluZy1pbnB1dC0xLmV4ZQpoS0FGVVpsMFdjRG9ZWWxRL09xNFd3amFZa3JSZktDMWowVzRUdkM2NjZwQVI4RlhMeCtEaGViSVdCSnlpZm9tMkNjRC9jcGVIbWJiTVBvTGlIWS9DUT09Cg==","url":"https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.21/Creator.Hub_0.1.21_x64-setup.exe"}}},"stagedPublic":{"releaseId":437086314,"tag":"v0.1.21","assets":{"creator-hub-windows-x86_64.json":{"id":718652893,"size":505,"sha256":"2a5ef416550d19f711f103e861b00bf55ed22a86cfd3e65080b18e2e7bced724"},"creator-hub-windows-x86_64.json.minisig":{"id":718652897,"size":305,"sha256":"2089048100a505c6479bf1f3d4d5d1892e7956aabd74c616416a4c2fcb8437a9"},"Creator.Hub_0.1.21_x64-setup.exe":{"id":718652892,"size":38469639,"sha256":"09dd6563e5e93a533f7ddedc600c785f56d123f55d1e29a8eada6ab3941cf2b3"},"Creator.Hub_0.1.21_x64-setup.exe.sig":{"id":718652895,"size":409,"sha256":"9a9e1bb9d401cdf6226be4e37e6103ca97f0900ac6ed5b58e72022d0732d24d1"},"latest.json":{"id":718652890,"size":776,"sha256":"ec7af64224e61ca94b3caf69a1178ebeb976d39473199a42d6d7df668fe18056"},"SHA256SUMS.txt":{"id":718652928,"size":484,"sha256":"26ba8de99dd971023c6eb6c8146d258ce510d2e9d398a098663596a12386f6a5"}}},"publication":null,"sdkInputs":{"package.json":"d67e82432c892f87c8a27c5f72624951a6b2b4d3ddd49e2ce4483c8608cd7fdd","package-lock.json":"75e240002bfe551d107ab584994ddebeeb325d7d2a083ec7e80d85a17b21cf81"}},"sidecars":{"creator-hub-windows-x86_64.json":"{\n  \"schemaVersion\": 1,\n  \"appId\": \"creator-hub\",\n  \"version\": \"0.1.21\",\n  \"platform\": \"windows\",\n  \"architecture\": \"x86_64\",\n  \"packageType\": \"nsis\",\n  \"assetName\": \"Creator.Hub_0.1.21_x64-setup.exe\",\n  \"byteLength\": 38469639,\n  \"sha256\": \"09dd6563e5e93a533f7ddedc600c785f56d123f55d1e29a8eada6ab3941cf2b3\",\n  \"executableSha256\": \"b29fe05699196383bbd376f23af934fe9f603761c3de285f16e6c4a3095222f5\",\n  \"identityProtocol\": 0,\n  \"lifecycleProtocol\": 0,\n  \"installerProtocol\": 1,\n  \"minHubVersion\": \"0.1.19\"\n}\n","creator-hub-windows-x86_64.json.minisig":"untrusted comment: signature from tauri secret key\nRUT+ay+R2gfWMa2f9UZNW9sRr95cywtMiNl3NrUIar2Cil/V/bIzgaidcFTAGAnk13d5+Obo+wF7Dr6qtVxrfaXnAZqotI/XLAs=\ntrusted comment: timestamp:1793999862\tfile:signing-input-0.json\nt6Zaqoy5r9aoj8pINMPpPC07GvKVO4W7oio+mTwqUZN0fiIGJX/eNhAMpYe5PSY4Hdsh1+LlA0aUKQXj73MyDw==\n","Creator.Hub_0.1.21_x64-setup.exe.sig":"dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUK2F5K1IyZ2ZXTWZDS1Z2UlFyQVBsZ3JoNGQxcUV0Q053Yno2bFFzOWVLYnkvVVhTeVlUTWE3V0lURklBNlNncllMVWtETXhnV0NMZkR2OGdtanlmZ2N6WFFhbFpFK2dBPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzOTk5ODY2CWZpbGU6c2lnbmluZy1pbnB1dC0xLmV4ZQpoS0FGVVpsMFdjRG9ZWWxRL09xNFd3amFZa3JSZktDMWowVzRUdkM2NjZwQVI4RlhMeCtEaGViSVdCSnlpZm9tMkNjRC9jcGVIbWJiTVBvTGlIWS9DUT09Cg==\n","latest.json":"{\n  \"version\": \"0.1.21\",\n  \"notes\": \"Safer session-only project registration, bounded project listings, and opt-in native inventory reading. Existing settings are retained.\",\n  \"platforms\": {\n    \"windows-x86_64\": {\n      \"signature\": \"dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUK2F5K1IyZ2ZXTWZDS1Z2UlFyQVBsZ3JoNGQxcUV0Q053Yno2bFFzOWVLYnkvVVhTeVlUTWE3V0lURklBNlNncllMVWtETXhnV0NMZkR2OGdtanlmZ2N6WFFhbFpFK2dBPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzOTk5ODY2CWZpbGU6c2lnbmluZy1pbnB1dC0xLmV4ZQpoS0FGVVpsMFdjRG9ZWWxRL09xNFd3amFZa3JSZktDMWowVzRUdkM2NjZwQVI4RlhMeCtEaGViSVdCSnlpZm9tMkNjRC9jcGVIbWJiTVBvTGlIWS9DUT09Cg==\",\n      \"url\": \"https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.21/Creator.Hub_0.1.21_x64-setup.exe\"\n    }\n  }\n}\n","SHA256SUMS.txt":"09dd6563e5e93a533f7ddedc600c785f56d123f55d1e29a8eada6ab3941cf2b3  Creator.Hub_0.1.21_x64-setup.exe\n9a9e1bb9d401cdf6226be4e37e6103ca97f0900ac6ed5b58e72022d0732d24d1  Creator.Hub_0.1.21_x64-setup.exe.sig\n2a5ef416550d19f711f103e861b00bf55ed22a86cfd3e65080b18e2e7bced724  creator-hub-windows-x86_64.json\n2089048100a505c6479bf1f3d4d5d1892e7956aabd74c616416a4c2fcb8437a9  creator-hub-windows-x86_64.json.minisig\nec7af64224e61ca94b3caf69a1178ebeb976d39473199a42d6d7df668fe18056  latest.json\n"}};
function publishedBinding() {
  const b = structuredClone(UNIT_FIXTURE.binding);
  b.publication = { ...structuredClone(b.stagedPublic), tagCommit: b.target.source.commit, draft: false, prerelease: false };
  return b;
}
function loadWith(b) {
  const file = path.join(__dirname, 'public-update-021.cjs'), mod = { exports: {} }, real = createRequire(file);
  new Function('require', 'module', 'exports', '__dirname', fs.readFileSync(file, 'utf8'))(
    n => n === './fixtures/public-update-021-binding.json' ? b : real(n), mod, mod.exports, __dirname);
  return mod.exports;
}
function environment(a = api) {
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_JOB: 'acceptance', GITHUB_RUN_ATTEMPT: '1', GITHUB_REF: a.REF,
    GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/.github/workflows/self-update-acceptance.yml@${a.REF}`,
    GITHUB_SHA: 'a'.repeat(40), EXPECTED_HARNESS_COMMIT: 'a'.repeat(40), CREATOR_PUBLIC_BINDING_SHA256: a.bindingSha256,
    CREATOR_PUBLIC_UPDATE_021: '1', CREATOR_SELF_UPDATE_TARGET_VERSION: '0.1.21', CREATOR_OUTGOING_CASE: 'mcp-restore',
    CREATOR_OUTGOING_LAST_TOOL: 'mcp', CREATOR_OUTGOING_RESTORE: 'true' };
}
function feed(b) {
  return encode([{ id: b.publication.releaseId, tag_name: 'v0.1.21', draft: false, prerelease: false,
    assets: Object.entries(b.publication.assets).map(([name, p]) => ({ name, ...p, digest: 'sha256:' + p.sha256, browser_download_url: api.url('0.1.21', name) })) },
  { id: b.baseline.releaseId, tag_name: 'v0.1.20', draft: false, prerelease: false, assets: [{ name: api.BASELINE_ASSET,
    id: b.baseline.assetId, size: b.baseline.installer.bytes, digest: 'sha256:' + b.baseline.installer.sha256,
    browser_download_url: api.url('0.1.20', api.BASELINE_ASSET) }] }]);
}
test('pending binding fails before runtime admission', () => {
  if (!api.binding.publication) assert.throws(() => api.assertAdmission(environment(), 'win32'), /pending/);
  else api.assertAdmission(environment(), 'win32');
});
test('exact finite public metadata accepted in simulation only', () => { const b = publishedBinding(); api.publication(b); api.checkRelease(feed(b), b); });
for (const key of ['HTTPS_PROXY', 'http_proxy', 'NO_PROXY', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'GH_TOKEN',
  'CREATOR_SELF_UPDATE_LAB_CONFIG', 'CREATOR_HOSTED_UPDATE_FIXTURE', 'CREATOR_MIGRATED_PROFILE']) {
  test('rejects environment injection: ' + key, () => {
    const a = loadWith(publishedBinding()); assert.throws(() => a.assertAdmission({ ...environment(a), [key]: 'injected' }, 'win32'));
  });
}
test('rejects self-hosted, wrong hash, wrong case, wrong version and rerun', () => {
  const a = loadWith(publishedBinding()), env = environment(a); a.assertAdmission(env, 'win32');
  for (const patch of [{ RUNNER_ENVIRONMENT: 'self-hosted' }, { EXPECTED_HARNESS_COMMIT: 'b'.repeat(40) },
    { CREATOR_PUBLIC_BINDING_SHA256: 'b'.repeat(64) }, { CREATOR_OUTGOING_RESTORE: 'false' },
    { CREATOR_SELF_UPDATE_TARGET_VERSION: '0.1.22' }, { GITHUB_RUN_ATTEMPT: '2' }]) assert.throws(() => a.assertAdmission({ ...env, ...patch }, 'win32'));
  assert.throws(() => a.assertAdmission(env, 'linux'));
});
test('refuses private draft, wrong installer, missing asset and replayed baseline', () => {
  for (const mutate of [b => b.publication.releaseId = 437053575, b => b.publication.draft = true,
    b => b.publication.assets[api.ASSET].sha256 = 'c'.repeat(64), b => delete b.publication.assets['latest.json']]) {
    const b = publishedBinding(); mutate(b); assert.throws(() => api.publication(b));
  }
  for (const mutate of [r => r[0].draft = true, r => r[0].assets[0].digest = 'bad',
    r => r[0].assets[0].browser_download_url = 'https://localhost/fake', r => r[1].id++,
    r => r[1].tag_name = 'v0.1.18']) {
    const b = publishedBinding(), rows = JSON.parse(feed(b)); mutate(rows);
    assert.throws(() => api.checkRelease(encode(rows), b));
  }
});
test('public network helper rejects lab URL and enforces bound without network', async () => {
  let calls = 0;
  const fetcher = async (url, options) => { calls++; assert.equal(options.headers.Authorization, undefined);
    return { ok: true, body: [Buffer.from('abc')] }; };
  await assert.rejects(api.publicBytes('https://localhost/latest.json', 10, fetcher)); assert.equal(calls, 0);
  await assert.rejects(api.publicBytes(api.FEED, 2, fetcher));
  assert.equal((await api.publicBytes(api.FEED, 3, fetcher)).toString(), 'abc');
});
test('restart is observed, not relaunched or same PID', () => {
  const before = { pid: 1, image: 'C:/test/creator-hub.exe', startTicks: '100', kernelIdentityVerified: true };
  const after = { ...before, pid: 2, startTicks: '300' };
  api.checkRestart(before, after, '200');
  assert.throws(() => api.checkRestart(before, { ...after, pid: 1 }, '200'));
  assert.throws(() => api.checkRestart(before, { ...after, startTicks: '199' }, '200'));
});
test('native driver keeps real cancellation and changed generation guards', () => {
  const text = fs.readFileSync(path.join(__dirname, 'native-public-update-021.cjs'), 'utf8'); new vm.Script(text);
  assert.ok(text.indexOf('target.assertAdmission()') < text.indexOf('target.readConfig('));
  for (const needed of ["button('Not now')", "button('Update Hub')", "active('0.1.20'), report.beforeRoute",
    'target.checkRestart(', 'assert.notEqual(report.afterRoute.generation, report.beforeRoute.generation)',
    'target.assertGenerationProcess', 'await preserved()', 'report.sdkCleanupVerified = true', 'target.verifySdk()']) assert.ok(text.includes(needed), needed);
  assert.ok(!/CREATOR_SELF_UPDATE_LAB_|startLabProxy|self-update-outgoing-019-feed/.test(text));
});
test('finite reader accepts only exact R2 and six staged assets', () => {
  const b = publishedBinding(); const q = { version: '0.1.21', platform: 'windows-x86_64', candidate: {
    sourceCommit: b.target.source.commit, sourceTree: b.target.source.tree, installerSha256: b.target.installer.sha256,
    executableSha256: b.target.executable.sha256 }, draft: { id: b.publication.releaseId, assets: b.publication.assets } };
  reader.requireTarget(q, b);
  for (const mutate of [v => v.version = '0.1.20', v => v.candidate.sourceCommit = 'f'.repeat(40),
    v => v.candidate.executableSha256 = 'f'.repeat(64), v => v.draft.id = 437053575, v => v.draft.assets['latest.json'].sha256 = 'f'.repeat(64)]) {
    const changed = structuredClone(q); mutate(changed); assert.throws(() => reader.requireTarget(changed, b));
  }
});
test('workflow remains manual, read-only and three-case with one aggregate', () => {
  const y = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/self-update-acceptance.yml'), 'utf8');
  assert.ok(y.includes('workflow_dispatch:')); assert.ok(!/\n  push:|contents: write|gh release|build-unified|cargo build/.test(y));
  for (const name of ['mcp-restore', 'setup-restore', 'setup-no-restore', 'hub-public-self-update-021', 'merge-multiple: true']) assert.ok(y.includes(name));
});
function evidenceFixture(caseName = 'mcp-restore') {
  const b = publishedBinding(), a = loadWith(b), env = environment(a);
  const bytes = feed(b), bindingHash = api.hash(encode(b));
  const pin = { harnessCommit: env.GITHUB_SHA, bindingSha256: bindingHash, inputBindingSha256: '' };
  const input = { schemaVersion: 1, kind: b.kind, harnessSource: pin.harnessCommit, bindingSha256: bindingHash,
    source: b.target.source, releaseId: b.publication.releaseId, tagCommit: b.publication.tagCommit,
    publicFeedUrl: api.FEED, publicFeedSha256: api.hash(bytes), feed: api.checkRelease(bytes, b),
    baseline: a.configFor(path.resolve('artifacts/public-update-021-input')).baseline,
    pins: a.configFor(path.resolve('artifacts/public-update-021-input')).pins,
    authenticatedDownload: false, lab: false, fixture: false };
  pin.inputBindingSha256 = api.hash(encode(input));
  const proc = (pid, version, ticks = '100') => ({ pid, startTicks: ticks, kernelIdentityVerified: true,
    image: `C:/test/runtime-generations/windows-x86_64/${b[version].generation}/mcp/server/runtime/node.exe` });
  const rootProc = (pid, ticks) => ({ pid, startTicks: ticks, kernelIdentityVerified: true, image: 'C:/test/creator-hub.exe' });
  const route = item => ({ schemaVersion: 1, descriptorSha256: item.manifest.managedRouting.files['routing/runtime.json'], generation: item.generation });
  const restore = api.CASES[caseName][1] === 'true';
  const settings = { 'test-only-settings': { exists: true, sha256: 'c'.repeat(64) } };
  const preferences = { 'auto-download': false, 'preview-channel': false, 'restore-hosted-views': restore };
  const report = { kind: b.kind, harnessSource: pin.harnessCommit, sourceCommit: b.target.source.commit,
    baseline: input.baseline, lastTool: api.CASES[caseName][0], restore, restoredLastTool: restore ? api.CASES[caseName][0] : null,
    beforePeVersion: [0, 1, 20, 0], afterPeVersion: [0, 1, 21, 0], beforeRoot: rootProc(10, '100'), afterRoot: rootProc(20, '300'), approvalLowerBoundTicks: '200',
    resourceProbe: { phase: 'after-automatic-root', attempts: 1, passed: true }, beforeRoute: route(b.baseline), afterRoute: route(b.target),
    heldServerVersion: { version: '2.7.8' }, reconnectedServerVersion: { version: '2.7.9' },
    heldProcessesBefore: [proc(30, 'baseline'), proc(31, 'baseline')], heldProcessesAfter: [proc(30, 'baseline'), proc(31, 'baseline')],
    reconnectedProcesses: [proc(40, 'target', '400'), proc(41, 'target', '400')],
    settingsBefore: settings, settingsAfter: settings, preferencesBefore: preferences, preferencesAfter: preferences,
    publicProof: { ...input, inputBindingSha256: pin.inputBindingSha256 } };
  for (const k of ['passed', 'publicDiscovery', 'nativeUpdateAccepted', 'automaticRestart', 'cancelPreserved', 'settingsPreserved',
    'existingConnectionSurvived', 'newConnectionVerified', 'restorationVerified', 'changedMcpGenerationProven',
    'installedResourcesVerifiedBeforeAndAfter', 'heldGenerationRetained', 'activeRouteUnchangedAfterCancel',
    'sdkCleanupVerified', 'rootCleanupVerified', 'sentinelCleanupVerified', 'policyRestored']) report[k] = true;
  for (const k of ['labDiscovery', 'liveAiAcceptance', 'releaseReady', 'harnessAdditionalLaunch', 'userMachineUsed']) report[k] = false;
  const q = { version: '0.1.21', platform: 'windows-x86_64', candidate: { sourceCommit: b.target.source.commit,
    sourceTree: b.target.source.tree, installerSha256: b.target.installer.sha256, executableSha256: b.target.executable.sha256 },
    draft: { id: b.publication.releaseId, assets: b.publication.assets } };
  const bodies = Object.fromEntries(api.ASSETS.filter(n => n !== api.ASSET).map(n => [n, fs.readFileSync(path.join(__dirname, 'fixtures/public021', n))]));
  return { b, q, pin, input, report, bytes, bodies, caseName };
}
function validate(f) { return reader.validateEvidence(f.q, f.b, f.report, f.input, f.bytes, f.bodies, f.pin, f.caseName); }
test('reader checks all three synthetic case reports against reviewed public sidecars (synthetic reports)', () => {
  for (const name of reader.CASES) validate(evidenceFixture(name));
});
test('reader rejects changed settings, lab evidence, stale generation, source, cleanup and sidecar', () => {
  for (const mutate of [f => f.report.settingsAfter = {}, f => f.report.labDiscovery = true,
    f => f.report.afterRoute.generation = f.b.baseline.generation, f => f.report.reconnectedServerVersion.version = '2.7.8',
    f => f.report.sourceCommit = 'b'.repeat(40), f => f.report.sdkCleanupVerified = false,
    f => f.bodies['latest.json'] = Buffer.from('{}'), f => f.report.heldProcessesAfter = []]) {
    const f = evidenceFixture(); mutate(f); assert.throws(() => validate(f));
  }
});
function zip(rows) {
  const local = [], central = []; let offset = 0;
  for (const [name, body] of rows) {
    const n = Buffer.from(name), h = Buffer.alloc(30), c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(body.length, 22); h.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(body.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    local.push(h, n, body); central.push(c, n); offset += h.length + n.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(rows.length, 8); end.writeUInt16LE(rows.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function remoteFixture() {
  const cases = reader.CASES.map(n => evidenceFixture(n)), f = cases[0];
  const bindingBytes = encode(f.b), workflow = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/self-update-acceptance.yml'));
  const review = { kind: 'windows-021-public-harness-review', version: '0.1.21', baselineVersion: '0.1.20',
    releaseId: f.q.draft.id, qualificationSha256: 'd'.repeat(64), harnessCommit: f.pin.harnessCommit,
    harnessTree: 'c'.repeat(40), workflowSha256: api.hash(workflow), bindingSha256: api.hash(bindingBytes) };
  const rows = cases.flatMap(c => [[`${c.caseName}/outgoing-report.json`, encode(c.report)],
    [`${c.caseName}/public-input-binding.json`, encode(c.input)], [`${c.caseName}/public-feed.json`, c.bytes],
    ...Object.entries(c.bodies).map(([name, bytes]) => [`${c.caseName}/${name}`, bytes])]);
  const archive = zip(rows), directory = fs.mkdtempSync(path.join(__dirname, 'reader-fixture-'));
  const options = { publicRun: '100', publicArtifactSha256: api.hash(archive), publicReview: path.join(directory, 'review.json'),
    publicReviewSha256: api.hash(encode(review)), sha256: review.qualificationSha256, association: f.b.publication.tagCommit };
  fs.writeFileSync(options.publicReview, encode(review), { flag: 'wx' });
  const repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' };
  const jobs = [...reader.CASES.map(n => 'acceptance-' + n), 'evidence'].map((name, i) => ({ id: i + 1, name, run_id: 100,
    run_attempt: 1, head_sha: review.harnessCommit, status: 'completed', conclusion: 'success',
    labels: [name === 'evidence' ? 'ubuntu-latest' : 'windows-latest'], started_at: '2026-11-05T10:00:00Z', completed_at: '2026-11-05T10:02:00Z' }));
  const responses = new Map([
    ['actions/runs/100', { id: 100, run_attempt: 1, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
      head_sha: review.harnessCommit, head_branch: 'validation/windows-public-update-021-20261106', path: reader.WORKFLOW, repository: repo, head_repository: repo }],
    [`git/commits/${review.harnessCommit}`, { sha: review.harnessCommit, tree: { sha: review.harnessTree } }],
    [`git/trees/${review.harnessTree}?recursive=1`, { sha: review.harnessTree, truncated: false, tree: [
      { type: 'blob', path: reader.WORKFLOW, sha: 'e'.repeat(40) }, { type: 'blob', path: reader.BINDING, sha: 'f'.repeat(40) }] }],
    [`git/blobs/${'e'.repeat(40)}`, { sha: 'e'.repeat(40), encoding: 'base64', size: workflow.length, content: workflow.toString('base64') }],
    [`git/blobs/${'f'.repeat(40)}`, { sha: 'f'.repeat(40), encoding: 'base64', size: bindingBytes.length, content: bindingBytes.toString('base64') }],
    ['actions/runs/100/jobs?per_page=100', { total_count: 4, jobs }],
    ['actions/runs/100/artifacts?per_page=100', { artifacts: [{ id: 500, name: 'hub-public-self-update-021', size_in_bytes: archive.length,
      expired: false, digest: 'sha256:' + api.hash(archive), created_at: '2026-11-05T10:01:00Z',
      workflow_run: { id: 100, head_sha: review.harnessCommit, repository_id: repo.id, head_repository_id: repo.id } }] }],
  ]);
  const io = { request: async r => { assert.ok(responses.has(r), r); return responses.get(r); },
    download: async (r, bound) => { assert.equal(r, 'actions/artifacts/500/zip'); assert.equal(bound, archive.length + 1); return archive; } };
  return { ...f, io, options, responses };
}
test('verify(qualification, options) reads one aggregate with all three original reports', async () => {
  const f = remoteFixture(), result = await reader.verify(f.q, f.options, f.io);
  assert.equal(result.publicAcceptance, true); assert.equal(result.version, '0.1.21');
  assert.equal(result.association, f.options.association); assert.equal(result.qualificationSha256, f.options.sha256);
  assert.deepEqual(result.cases.map(c => c.case), reader.CASES);
});
test('remote reader refuses failed jobs, wrong repo, artifact replay, and archive corruption', async () => {
  for (const mutate of [f => f.responses.get('actions/runs/100').head_repository.id++,
    f => f.responses.get('actions/runs/100/jobs?per_page=100').jobs[0].conclusion = 'failure',
    f => f.responses.get('actions/runs/100/artifacts?per_page=100').artifacts[0].workflow_run.id++,
    f => f.options.publicArtifactSha256 = 'f'.repeat(64), f => f.options.association = 'f'.repeat(40)]) {
    const f = remoteFixture(); mutate(f); await assert.rejects(reader.verify(f.q, f.options, f.io));
  }
});
