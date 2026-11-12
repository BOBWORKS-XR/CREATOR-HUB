'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const api = require('./public-update-022.cjs');
const reader = require('./windows-022-public-acceptance.cjs');
const encode = v => Buffer.from(JSON.stringify(v));
const UNIT_FIXTURE = {"binding":{"schemaVersion":1,"kind":"public-021-to-022","baseline":{"source":{"commit":"35411a704707cba5915f77d51bf156e4ec8ce251","tree":"4f80b815406aedf577a3f9cb78c1f7fd6caf968b"},"version":"0.1.21","asset":"Creator.Hub_0.1.21_x64-setup.exe","installer":{"bytes":38469639,"sha256":"09dd6563e5e93a533f7ddedc600c785f56d123f55d1e29a8eada6ab3941cf2b3"},"executable":{"bytes":19592704,"sha256":"b29fe05699196383bbd376f23af934fe9f603761c3de285f16e6c4a3095222f5"},"manifest":{"schemaVersion":1,"platform":"windows","arch":"x86_64","modules":{"mcp":{"executable":"mcp/creator-works-mcp-launcher.exe","version":"2.7.9","files":{"mcp/creator-works-mcp-launcher.exe":"0edc1da931e7e8f8bdd28d8de65397a7ab76ac784111c936cd6b6e78c0b652e2","mcp/server/creator-works-mcp.mjs":"115adb67aedce3f88ae798872f1c269d992cf410b50755138033eda6484b8d29","mcp/server/runtime/node.exe":"c6335d08331c23d68b9f2b18adb102002d76ef150b47248e954c507e0d033664","mcp/server/runtime/LICENSE":"8efdacdc1cfa3460aeb7fe98e3c54337b971d5da70e6eee292b73b981acb220c","mcp/server/runtime/VERSION":"98182b41c9ce3357797985cf12dc3b0124490ef88bc918a905373e7688e6aec9","mcp/server/unity-extension/Editor/BanterMCPBridge.cs":"b8c863926455876cdf618089ade4d179c3dc34efbd6dc41f3e612893c98aa7a7","mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png":"f3f68baa0d887de92e6cf7aba8beae7ff8ea5c44b13444f018413041ade19ea7","mcp/server/LICENSE":"b1cfe8ff7191d3e9c6c6b0f832adcd2ebece8e6070ef72d2f7afc1c082fb757f","mcp/server/THIRD_PARTY_NOTICES.md":"3596f4ad9f49cd460fa4da49ce3f1b92ad2f67113270b96d361e7e27ae0460af"}},"setup":{"executable":"setup/creator-project-setup.exe","version":"0.3.7","files":{"setup/creator-project-setup.exe":"1f307fa96ccd1ac83673a89743a7bd4de4d58dbaa8e778b5c65f8fd4e56ca216"}}},"managedRouting":{"protocol":1,"files":{"routing/creator-hub-mcp-router.exe":"e20ebdeff12ae3d3952324ad3ef4253d99632b66d2ec95807ae5039c291f42ba","routing/router.json":"52b5b10c24c782f0b8b8b3c6bbf2f6d39794245cb0e85f98311ed381f44fb384","routing/router.minisig":"2481f98e7e899834ac865e6ea14921da090a797d276fc82e0350afb8f6ac8aba","routing/runtime.json":"a935daded657eef08abd7d8b910fa7b1104e6511f17f5f40f133397d0035b5b4","routing/runtime.minisig":"e220e3ea3eb43aa9635059f74d4e1c2e43a4ec080c035fda148dc078bb24d19c"}}},"generation":"b699e71e7db1b12940aaa500ceda1f8a0ff5ce99bb29c7dd9309bc962bd5b11b","sourceUnchanged":true,"buildExitCode":0,"verificationReceiptSha256":"de62c38471fce7b85598c7deaf576a1fbf60a528bf811db07f5080cb429d1262","releaseId":437086314,"assetId":718652892},"target":{"source":{"commit":"8f7916161e993d8cfc3c200e98895dda865819c4","tree":"78f73b22cbccf28c9ec8b6907de733e6343390e2"},"version":"0.1.22","asset":"Creator.Hub_0.1.22_x64-setup.exe","installer":{"bytes":38495864,"sha256":"2bd535e7f3ea90821bb97878e5d97bfa06a90ff0127bef28f8d8a64f2eb7deea"},"executable":{"bytes":19613184,"sha256":"73a2afa5cb2ff4fbfbb1d6458efa6d179441cb9336803228ffbc910ee3f94245"},"manifest":{"schemaVersion":1,"platform":"windows","arch":"x86_64","modules":{"mcp":{"executable":"mcp/creator-works-mcp-launcher.exe","version":"2.7.9","files":{"mcp/creator-works-mcp-launcher.exe":"a0e7c58cbff544b8baf81ec7d31381ab2428736ea0982b8e1380754792f88346","mcp/server/creator-works-mcp.mjs":"115adb67aedce3f88ae798872f1c269d992cf410b50755138033eda6484b8d29","mcp/server/runtime/node.exe":"c6335d08331c23d68b9f2b18adb102002d76ef150b47248e954c507e0d033664","mcp/server/runtime/LICENSE":"8efdacdc1cfa3460aeb7fe98e3c54337b971d5da70e6eee292b73b981acb220c","mcp/server/runtime/VERSION":"98182b41c9ce3357797985cf12dc3b0124490ef88bc918a905373e7688e6aec9","mcp/server/unity-extension/Editor/BanterMCPBridge.cs":"b8c863926455876cdf618089ade4d179c3dc34efbd6dc41f3e612893c98aa7a7","mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png":"f3f68baa0d887de92e6cf7aba8beae7ff8ea5c44b13444f018413041ade19ea7","mcp/server/LICENSE":"b1cfe8ff7191d3e9c6c6b0f832adcd2ebece8e6070ef72d2f7afc1c082fb757f","mcp/server/THIRD_PARTY_NOTICES.md":"3596f4ad9f49cd460fa4da49ce3f1b92ad2f67113270b96d361e7e27ae0460af"}},"setup":{"executable":"setup/creator-project-setup.exe","version":"0.3.7","files":{"setup/creator-project-setup.exe":"52f3b7ff6e3954a91409317633ddd14ce9058c57d419ae8a00a5a51a84bc4c52"}}},"managedRouting":{"protocol":1,"files":{"routing/creator-hub-mcp-router.exe":"8b8e7ad1bded306c4e0cf13990c8a6aab7f4e77f99ce4f802f53050da51f6eef","routing/router.json":"9cd2f7eb4ee4a1e1ee0743cd85119d85f119ebe9c7acb4f911c8da8d62f7350d","routing/router.minisig":"aee726bfabe7e3424937e1b49a384c31f3c20187a9601e5d0245d74b0a1d40d7","routing/runtime.json":"2f3d21c3c4aa128164bb6e027fd102f29683cfb0865ea52faf5bb2e029a33473","routing/runtime.minisig":"ce07a82a499aad3808ceaaaf8e8f62317ee0484f07cbb42050db107b6c505dfb"}}},"generation":"46fe996be063a9480db57bc1f75b63a09419aa2a279231d71890f9919d526ee3","verificationReceiptSha256":"3bf72ace5aec8a8dcba438c1e5700d795b678240d1a2e79a28702238919bad2c","sourceUnchanged":true,"buildExitCode":0,"descriptor":{"bytes":505,"sha256":"45e2afdf21b49bf8da492f1f39da144eee1570d49dbc86a666114e8faf81bdea"},"descriptorSignature":{"bytes":305,"sha256":"a7bf55751fd3295f0fa37cbf59ca8492a08436c9ce5e4c2b19755081c2427869"},"latest":{"bytes":690,"sha256":"e2de78f62a9076f2322ced2b43b21de33d0cb44030e6578e8724ff06c8db6494"}},"originalLatest":{"version":"0.1.22","notes":"Private candidate acceptance only; not published.","platforms":{"windows-x86_64":{"signature":"dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUK2F5K1IyZ2ZXTVlnS0FSeTR2Y3Z6RTNBZTRJVFZ4aVg4UzZaMkdMaGZzemFrd0JMUWZyOUcvYzJONDJHMy8zV05sMUhpa2FJNHJYZVo5V21tb1ZWdWZsbGgva2x5UHdrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0NDg4NTkyCWZpbGU6c2lnbmluZy1pbnB1dC0xLmV4ZQpJQmJQRXpXWUJPMCtOVVZwMFJIeXd2MFZ4TmxDaXlaL2FLeXYza3BwT3dZMmRzYVZCSnB5aERScGxvY3l6Ni8rRzlUU1cwYklweDVTSDRiaDhJNmxEQT09Cg==","url":"https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.22/Creator.Hub_0.1.22_x64-setup.exe"}}},"stagedPublic":{"releaseId":442967050,"tag":"v0.1.22","assets":{"creator-hub-windows-x86_64.json":{"id":739544100,"size":505,"sha256":"45e2afdf21b49bf8da492f1f39da144eee1570d49dbc86a666114e8faf81bdea"},"creator-hub-windows-x86_64.json.minisig":{"id":739544105,"size":305,"sha256":"a7bf55751fd3295f0fa37cbf59ca8492a08436c9ce5e4c2b19755081c2427869"},"Creator.Hub_0.1.22_x64-setup.exe":{"id":739544096,"size":38495864,"sha256":"2bd535e7f3ea90821bb97878e5d97bfa06a90ff0127bef28f8d8a64f2eb7deea"},"Creator.Hub_0.1.22_x64-setup.exe.sig":{"id":739544102,"size":409,"sha256":"2f818b677580ce2da6eb7f84dd06b2a7affa7f2c62bd273731e32b3362e6225b"},"latest.json":{"id":739544092,"size":1013,"sha256":"0deb98984f136cf530e3d87df17f2d23f004b521329ab78b63f825fff59b99b3"},"SHA256SUMS.txt":{"id":739544140,"size":484,"sha256":"70613887b04404570380062bfff9348a3b3cbc51621bcd527dc7041ecfc103d6"}}},"publication":{"releaseId":442967050,"tag":"v0.1.22","tagCommit":"75358cf4a783f51a359898b1d4f9bfe2e256b35f","draft":false,"prerelease":false,"assets":{"creator-hub-windows-x86_64.json":{"id":739544100,"size":505,"sha256":"45e2afdf21b49bf8da492f1f39da144eee1570d49dbc86a666114e8faf81bdea"},"creator-hub-windows-x86_64.json.minisig":{"id":739544105,"size":305,"sha256":"a7bf55751fd3295f0fa37cbf59ca8492a08436c9ce5e4c2b19755081c2427869"},"Creator.Hub_0.1.22_x64-setup.exe":{"id":739544096,"size":38495864,"sha256":"2bd535e7f3ea90821bb97878e5d97bfa06a90ff0127bef28f8d8a64f2eb7deea"},"Creator.Hub_0.1.22_x64-setup.exe.sig":{"id":739544102,"size":409,"sha256":"2f818b677580ce2da6eb7f84dd06b2a7affa7f2c62bd273731e32b3362e6225b"},"latest.json":{"id":739544092,"size":1013,"sha256":"0deb98984f136cf530e3d87df17f2d23f004b521329ab78b63f825fff59b99b3"},"SHA256SUMS.txt":{"id":739544140,"size":484,"sha256":"70613887b04404570380062bfff9348a3b3cbc51621bcd527dc7041ecfc103d6"}}},"sdkInputs":{"package.json":"d67e82432c892f87c8a27c5f72624951a6b2b4d3ddd49e2ce4483c8608cd7fdd","package-lock.json":"75e240002bfe551d107ab584994ddebeeb325d7d2a083ec7e80d85a17b21cf81"}},"sidecars":{"creator-hub-windows-x86_64.json":"{\n  \"schemaVersion\": 1,\n  \"appId\": \"creator-hub\",\n  \"version\": \"0.1.22\",\n  \"platform\": \"windows\",\n  \"architecture\": \"x86_64\",\n  \"packageType\": \"nsis\",\n  \"assetName\": \"Creator.Hub_0.1.22_x64-setup.exe\",\n  \"byteLength\": 38495864,\n  \"sha256\": \"2bd535e7f3ea90821bb97878e5d97bfa06a90ff0127bef28f8d8a64f2eb7deea\",\n  \"executableSha256\": \"73a2afa5cb2ff4fbfbb1d6458efa6d179441cb9336803228ffbc910ee3f94245\",\n  \"identityProtocol\": 0,\n  \"lifecycleProtocol\": 0,\n  \"installerProtocol\": 1,\n  \"minHubVersion\": \"0.1.19\"\n}\n","creator-hub-windows-x86_64.json.minisig":"untrusted comment: signature from tauri secret key\nRUT+ay+R2gfWMdiaEnIEdQ+5bcBCT0ww2lYp5HTe/pAwyEjDw3LHvxWVkEdZBxIyUyuCXCmw8HbrMAsZAU+GEEdb0tSbxjvl+AA=\ntrusted comment: timestamp:1794488588\tfile:signing-input-0.json\noLwjdlTbXVEPVmfMSvgaicn7dSA1on41VgesmMhzdH/DXAHGL5VU0nraNAQqH95T70HjRL7A2tK+aiEBmPGRAQ==\n","Creator.Hub_0.1.22_x64-setup.exe.sig":"dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUK2F5K1IyZ2ZXTVlnS0FSeTR2Y3Z6RTNBZTRJVFZ4aVg4UzZaMkdMaGZzemFrd0JMUWZyOUcvYzJONDJHMy8zV05sMUhpa2FJNHJYZVo5V21tb1ZWdWZsbGgva2x5UHdrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0NDg4NTkyCWZpbGU6c2lnbmluZy1pbnB1dC0xLmV4ZQpJQmJQRXpXWUJPMCtOVVZwMFJIeXd2MFZ4TmxDaXlaL2FLeXYza3BwT3dZMmRzYVZCSnB5aERScGxvY3l6Ni8rRzlUU1cwYklweDVTSDRiaDhJNmxEQT09Cg==\n","latest.json":"{\n  \"version\": \"0.1.22\",\n  \"notes\": \"New projects select the latest stable Creator SDK from verified registry metadata, with explicit retry or a tested fallback if lookup fails. Clearer updater installation messages, project-lock diagnostics and MCP connection status. Existing projects and preferences are preserved. New official builds are Windows only; older Mac/Linux releases and source remain available.\",\n  \"platforms\": {\n    \"windows-x86_64\": {\n      \"signature\": \"dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUK2F5K1IyZ2ZXTVlnS0FSeTR2Y3Z6RTNBZTRJVFZ4aVg4UzZaMkdMaGZzemFrd0JMUWZyOUcvYzJONDJHMy8zV05sMUhpa2FJNHJYZVo5V21tb1ZWdWZsbGgva2x5UHdrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk0NDg4NTkyCWZpbGU6c2lnbmluZy1pbnB1dC0xLmV4ZQpJQmJQRXpXWUJPMCtOVVZwMFJIeXd2MFZ4TmxDaXlaL2FLeXYza3BwT3dZMmRzYVZCSnB5aERScGxvY3l6Ni8rRzlUU1cwYklweDVTSDRiaDhJNmxEQT09Cg==\",\n      \"url\": \"https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.22/Creator.Hub_0.1.22_x64-setup.exe\"\n    }\n  }\n}\n","SHA256SUMS.txt":"2bd535e7f3ea90821bb97878e5d97bfa06a90ff0127bef28f8d8a64f2eb7deea  Creator.Hub_0.1.22_x64-setup.exe\n2f818b677580ce2da6eb7f84dd06b2a7affa7f2c62bd273731e32b3362e6225b  Creator.Hub_0.1.22_x64-setup.exe.sig\n45e2afdf21b49bf8da492f1f39da144eee1570d49dbc86a666114e8faf81bdea  creator-hub-windows-x86_64.json\na7bf55751fd3295f0fa37cbf59ca8492a08436c9ce5e4c2b19755081c2427869  creator-hub-windows-x86_64.json.minisig\n0deb98984f136cf530e3d87df17f2d23f004b521329ab78b63f825fff59b99b3  latest.json\n"}};
function publishedBinding() {
  const b = structuredClone(UNIT_FIXTURE.binding);
  b.publication = { ...structuredClone(b.stagedPublic), tagCommit: b.target.source.commit, draft: false, prerelease: false };
  return b;
}
function loadWith(b) {
  const file = path.join(__dirname, 'public-update-022.cjs'), mod = { exports: {} }, real = createRequire(file);
  new Function('require', 'module', 'exports', '__dirname', fs.readFileSync(file, 'utf8'))(
    n => n === './fixtures/public-update-022-binding.json' ? b : real(n), mod, mod.exports, __dirname);
  return mod.exports;
}
function environment(a = api) {
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_JOB: 'acceptance', GITHUB_RUN_ATTEMPT: '1', GITHUB_REF: a.REF,
    GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/.github/workflows/self-update-acceptance.yml@${a.REF}`,
    GITHUB_SHA: 'a'.repeat(40), EXPECTED_HARNESS_COMMIT: 'a'.repeat(40), CREATOR_PUBLIC_BINDING_SHA256: a.bindingSha256,
    CREATOR_PUBLIC_UPDATE_022: '1', CREATOR_SELF_UPDATE_TARGET_VERSION: '0.1.22', CREATOR_OUTGOING_CASE: 'mcp-restore',
    CREATOR_OUTGOING_LAST_TOOL: 'mcp', CREATOR_OUTGOING_RESTORE: 'true' };
}
function feed(b) {
  return encode([{ id: b.publication.releaseId, tag_name: 'v0.1.22', draft: false, prerelease: false,
    assets: Object.entries(b.publication.assets).map(([name, p]) => ({ name, ...p, digest: 'sha256:' + p.sha256, browser_download_url: api.url('0.1.22', name) })) },
  { id: b.baseline.releaseId, tag_name: 'v0.1.21', draft: false, prerelease: false, assets: [{ name: api.BASELINE_ASSET,
    id: b.baseline.assetId, size: b.baseline.installer.bytes, digest: 'sha256:' + b.baseline.installer.sha256,
    browser_download_url: api.url('0.1.21', api.BASELINE_ASSET) }] }]);
}
test('pending binding fails before runtime admission', () => {
  if (!api.binding.publication) assert.throws(() => api.assertAdmission(environment(), 'win32'), /pending/);
  else api.assertAdmission(environment(), 'win32');
});
test('exact finite public metadata accepted in simulation only', () => { const b = publishedBinding(); api.publication(b); api.checkRelease(feed(b), b); });
for (const key of ['HTTPS_PROXY', 'http_proxy', 'NO_PROXY', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'GH_TOKEN',
  'CREATOR_SELF_UPDATE_LAB_CONFIG', 'CREATOR_HOSTED_UPDATE_FIXTURE', 'CREATOR_MIGRATED_PROFILE', 'CREATOR_PRODUCTION_022_CONFIG']) {
  test('rejects environment injection: ' + key, () => {
    const a = loadWith(publishedBinding()); assert.throws(() => a.assertAdmission({ ...environment(a), [key]: 'injected' }, 'win32'));
  });
}
test('rejects self-hosted, wrong hash, wrong case, wrong version and rerun', () => {
  const a = loadWith(publishedBinding()), env = environment(a); a.assertAdmission(env, 'win32');
  for (const patch of [{ RUNNER_ENVIRONMENT: 'self-hosted' }, { EXPECTED_HARNESS_COMMIT: 'b'.repeat(40) },
    { CREATOR_PUBLIC_BINDING_SHA256: 'b'.repeat(64) }, { CREATOR_OUTGOING_RESTORE: 'false' },
    { CREATOR_SELF_UPDATE_TARGET_VERSION: '0.1.23' }, { GITHUB_RUN_ATTEMPT: '2' }]) assert.throws(() => a.assertAdmission({ ...env, ...patch }, 'win32'));
  assert.throws(() => a.assertAdmission(env, 'linux'));
});
test('refuses private draft, wrong installer, missing asset and replayed baseline', () => {
  for (const mutate of [b => b.publication.releaseId = 442957039, b => b.publication.draft = true,
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
  const text = fs.readFileSync(path.join(__dirname, 'native-public-update-022.cjs'), 'utf8'); new vm.Script(text);
  assert.ok(text.indexOf('target.assertAdmission()') < text.indexOf('target.readConfig('));
  for (const needed of ["button('Not now')", "button('Update Hub')", "active('0.1.21'), report.beforeRoute",
    'target.checkRestart(', 'assert.equal(report.afterRoute.generation, target.binding.target.generation)',
    'target.assertGenerationProcess', 'await preserved()', 'report.sdkCleanupVerified = true', 'target.verifySdk()']) assert.ok(text.includes(needed), needed);
  assert.ok(!/CREATOR_SELF_UPDATE_LAB_|startLabProxy|self-update-outgoing-019-feed/.test(text));
});
test('finite reader accepts only exact R2 and six staged assets', () => {
  const b = publishedBinding(); const q = { version: '0.1.22', platform: 'windows-x86_64', candidate: {
    sourceCommit: b.target.source.commit, sourceTree: b.target.source.tree, installerSha256: b.target.installer.sha256,
    executableSha256: b.target.executable.sha256 }, draft: { id: b.publication.releaseId, assets: b.publication.assets } };
  reader.requireTarget(q, b);
  for (const mutate of [v => v.version = '0.1.21', v => v.candidate.sourceCommit = 'f'.repeat(40),
    v => v.candidate.executableSha256 = 'f'.repeat(64), v => v.draft.id = 442957039, v => v.draft.assets['latest.json'].sha256 = 'f'.repeat(64)]) {
    const changed = structuredClone(q); mutate(changed); assert.throws(() => reader.requireTarget(changed, b));
  }
});
test('workflow remains manual, read-only and three-case with one aggregate', () => {
  const y = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/self-update-acceptance.yml'), 'utf8');
  assert.ok(y.includes('workflow_dispatch:')); assert.ok(!/\n  push:|contents: write|gh release|build-unified|cargo build/.test(y));
  for (const name of ['mcp-restore', 'setup-restore', 'setup-no-restore', 'hub-public-self-update-022', 'merge-multiple: true']) assert.ok(y.includes(name));
});
function evidenceFixture(caseName = 'mcp-restore') {
  const b = publishedBinding(), a = loadWith(b), env = environment(a);
  const bytes = feed(b), bindingHash = api.hash(encode(b));
  const pin = { harnessCommit: env.GITHUB_SHA, bindingSha256: bindingHash, inputBindingSha256: '' };
  const input = { schemaVersion: 1, kind: b.kind, harnessSource: pin.harnessCommit, bindingSha256: bindingHash,
    source: b.target.source, releaseId: b.publication.releaseId, tagCommit: b.publication.tagCommit,
    publicFeedUrl: api.FEED, publicFeedSha256: api.hash(bytes), feed: api.checkRelease(bytes, b),
    baseline: a.configFor(path.resolve('artifacts/public-update-022-input')).baseline,
    pins: a.configFor(path.resolve('artifacts/public-update-022-input')).pins,
    authenticatedDownload: false, lab: false, fixture: false };
  pin.inputBindingSha256 = api.hash(encode(input));
  const proc = (pid, version, ticks = '100') => ({ pid, startTicks: ticks, kernelIdentityVerified: true,
    image: `C:/test/creator-hub/runtime-generations/windows-x86_64/${b[version].generation}/mcp/server/runtime/node.exe`, parentPid: pid - 1 });
  const rootProc = (pid, ticks) => ({ pid, startTicks: ticks, kernelIdentityVerified: true, image: 'C:/test/creator-hub.exe' });
  const route = item => ({ schemaVersion: 1, descriptorSha256: item.manifest.managedRouting.files['routing/runtime.json'], generation: item.generation });
  const restore = api.CASES[caseName][1] === 'true';
  const settings = { 'test-only-settings': { exists: true, sha256: 'c'.repeat(64) } };
  const preferences = { 'auto-download': false, 'preview-channel': false, 'restore-hosted-views': restore };
  const report = { kind: b.kind, harnessSource: pin.harnessCommit, sourceCommit: b.target.source.commit,
    baseline: input.baseline, lastTool: api.CASES[caseName][0], restore, restoredLastTool: restore ? api.CASES[caseName][0] : null,
    beforePeVersion: [0, 1, 21, 0], afterPeVersion: [0, 1, 22, 0], beforeRoot: rootProc(10, '100'), afterRoot: rootProc(20, '300'), approvalLowerBoundTicks: '200',
    resourceProbe: { phase: 'after-automatic-root', attempts: 1, passed: true }, beforeRoute: route(b.baseline), afterRoute: route(b.target),
    heldServerVersion: { version: '2.7.9' }, reconnectedServerVersion: { version: '2.7.9' },
    heldProcessesBefore: [rootProc(30, '100'), proc(31, 'baseline')], heldProcessesAfter: [rootProc(30, '100'), proc(31, 'baseline')],
    reconnectedProcesses: [rootProc(40, '400'), proc(41, 'target', '400')],
    settingsBefore: settings, settingsAfter: settings, preferencesBefore: preferences, preferencesAfter: preferences,
    publicProof: { ...input, inputBindingSha256: pin.inputBindingSha256 } };
  for (const k of ['passed', 'publicDiscovery', 'nativeUpdateAccepted', 'automaticRestart', 'cancelPreserved', 'settingsPreserved',
    'existingConnectionSurvived', 'newConnectionVerified', 'restorationVerified', 'targetMcpRuntimeVerified',
    'installedResourcesVerifiedBeforeAndAfter', 'heldGenerationRetained', 'activeRouteUnchangedAfterCancel',
    'sdkCleanupVerified', 'rootCleanupVerified', 'sentinelCleanupVerified', 'policyRestored']) report[k] = true;
  for (const k of ['labDiscovery', 'liveAiAcceptance', 'releaseReady', 'harnessAdditionalLaunch', 'userMachineUsed']) report[k] = false;
  const q = { version: '0.1.22', platform: 'windows-x86_64', candidate: { sourceCommit: b.target.source.commit,
    sourceTree: b.target.source.tree, installerSha256: b.target.installer.sha256, executableSha256: b.target.executable.sha256 },
    draft: { id: b.publication.releaseId, assets: b.publication.assets } };
  const bodies = Object.fromEntries(api.ASSETS.filter(n => n !== api.ASSET).map(n => [n, fs.readFileSync(path.join(__dirname, 'fixtures/public022', n))]));
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
  const review = { kind: 'windows-022-public-harness-review', version: '0.1.22', baselineVersion: '0.1.21',
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
      head_sha: review.harnessCommit, head_branch: 'validation/windows-public-update-022-20261112', path: reader.WORKFLOW, repository: repo, head_repository: repo }],
    [`git/commits/${review.harnessCommit}`, { sha: review.harnessCommit, tree: { sha: review.harnessTree } }],
    [`git/trees/${review.harnessTree}?recursive=1`, { sha: review.harnessTree, truncated: false, tree: [
      { type: 'blob', path: reader.WORKFLOW, sha: 'e'.repeat(40) }, { type: 'blob', path: reader.BINDING, sha: 'f'.repeat(40) }] }],
    [`git/blobs/${'e'.repeat(40)}`, { sha: 'e'.repeat(40), encoding: 'base64', size: workflow.length, content: workflow.toString('base64') }],
    [`git/blobs/${'f'.repeat(40)}`, { sha: 'f'.repeat(40), encoding: 'base64', size: bindingBytes.length, content: bindingBytes.toString('base64') }],
    ['actions/runs/100/jobs?per_page=100', { total_count: 4, jobs }],
    ['actions/runs/100/artifacts?per_page=100', { artifacts: [{ id: 500, name: 'hub-public-self-update-022', size_in_bytes: archive.length,
      expired: false, digest: 'sha256:' + api.hash(archive), created_at: '2026-11-05T10:01:00Z',
      workflow_run: { id: 100, head_sha: review.harnessCommit, repository_id: repo.id, head_repository_id: repo.id } }] }],
  ]);
  const io = { request: async r => { assert.ok(responses.has(r), r); return responses.get(r); },
    download: async (r, bound) => { assert.equal(r, 'actions/artifacts/500/zip'); assert.equal(bound, archive.length + 1); return archive; } };
  return { ...f, io, options, responses };
}
test('verify(qualification, options) reads one aggregate with all three original reports', async () => {
  const f = remoteFixture(), result = await reader.verify(f.q, f.options, f.io);
  assert.equal(result.publicAcceptance, true); assert.equal(result.version, '0.1.22');
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


test('R4 same-version rebuild is bound to exact target bytes', () => {
  assert.equal(api.binding.baseline.manifest.modules.mcp.version, '2.7.9');
  assert.equal(api.binding.target.manifest.modules.mcp.version, '2.7.9');
  assert.notEqual(api.binding.baseline.generation, api.binding.target.generation);
  assert.notEqual(api.binding.baseline.manifest.modules.mcp.files['mcp/creator-works-mcp-launcher.exe'], api.binding.target.manifest.modules.mcp.files['mcp/creator-works-mcp-launcher.exe']);
});
test('fresh runtime rejects PID replay, wrong parent, identity, root, and generation', () => {
  for (const mutate of [f => f.report.reconnectedProcesses[0].pid = f.report.heldProcessesBefore[0].pid,
    f => f.report.reconnectedProcesses[1].parentPid++, f => f.report.reconnectedProcesses[1].kernelIdentityVerified = false,
    f => f.report.reconnectedProcesses[1].image = f.report.heldProcessesBefore[1].image,
    f => f.report.reconnectedProcesses[1].image = f.report.reconnectedProcesses[1].image.replace('C:/test/', 'C:/foreign/'),
    f => f.report.reconnectedProcesses[0].image = 'C:/foreign/router.exe']) {
    const f = evidenceFixture(); mutate(f); assert.throws(() => validate(f));
  }
});
test('all report preservation and cleanup flags remain mandatory', () => {
  for (const flag of ['automaticRestart', 'cancelPreserved', 'settingsPreserved', 'existingConnectionSurvived', 'newConnectionVerified',
    'targetMcpRuntimeVerified', 'installedResourcesVerifiedBeforeAndAfter', 'heldGenerationRetained', 'activeRouteUnchangedAfterCancel',
    'sdkCleanupVerified', 'rootCleanupVerified', 'sentinelCleanupVerified', 'policyRestored']) {
    const f = evidenceFixture(); f.report[flag] = false; assert.throws(() => validate(f), flag);
  }
});
test('no local native command or PowerShell is needed by this test suite', () => {
  const text = fs.readFileSync(path.join(__dirname, 'native-public-update-022.cjs'), 'utf8');
  assert.equal((text.match(/spawn\(hub,/g) || []).length, 1);
  assert.ok(text.includes('target.assertFreshConnection(sdkRecords, [router, nodes[0]])'));
  assert.ok(text.includes('assert.equal(report.afterRoute.generation, target.binding.target.generation)'));
});
test('collector preserves exact 022 signature in all three cases without copying installers', () => {
  const { spawnSync } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(process.env.TEMP || __dirname, 'public-collector-regression-'));
  const input = path.join(directory, 'artifacts/public-update-022-input');
  fs.mkdirSync(input, { recursive: true });
  const signature = Buffer.from('exact original signature bytes\r\n');
  fs.writeFileSync(path.join(input, 'Creator.Hub_0.1.22_x64-setup.exe.sig'), signature);
  fs.writeFileSync(path.join(input, 'Creator.Hub_0.1.21_x64-setup.exe.sig'), 'wrong version');
  fs.writeFileSync(path.join(input, 'Creator.Hub_0.1.22_x64-setup.exe'), 'not collected');
  for (const name of ['mcp-restore', 'setup-restore', 'setup-no-restore']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'collect-public-update-022.cjs')], {
      cwd: directory, env: { ...process.env, CREATOR_OUTGOING_CASE: name }, timeout: 15000, windowsHide: true, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const output = path.join(directory, 'artifacts/public-case', name);
    assert.deepEqual(fs.readFileSync(path.join(output, 'Creator.Hub_0.1.22_x64-setup.exe.sig')), signature);
    assert.equal(fs.existsSync(path.join(output, 'Creator.Hub_0.1.21_x64-setup.exe.sig')), false);
    assert.equal(fs.existsSync(path.join(output, 'Creator.Hub_0.1.22_x64-setup.exe')), false);
  }
});
