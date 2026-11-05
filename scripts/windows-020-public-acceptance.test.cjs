'use strict';
// Generated pure reader regressions. Embedded public metadata is test data, not native acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const reader = require('./windows-020-public-acceptance.cjs');
const api = require('./windows-020-public-contract.cjs');
const archiveTools = require('./public-update-evidence-io.cjs');
const encode = v => Buffer.from(JSON.stringify(v));
const FIXTURE_BINDING = {
  "schemaVersion": 1,
  "kind": "public-019-to-020",
  "baseline": {
    "source": {
      "commit": "ed3e7dabc2e83fea8b7cadce63bbeb502fed2306",
      "tree": "bd6328c41871465fe64e65e3f9d53c6f2ba0ed8d"
    },
    "version": "0.1.19",
    "asset": "Creator.Hub_0.1.19_x64-setup.exe",
    "installer": {
      "bytes": 38353697,
      "sha256": "1a0d85127827b854dcdd3ae89f4c5e2aca3824b81623f1b9b05e022871ee6419"
    },
    "executable": {
      "bytes": 19591168,
      "sha256": "5bd277950ac6409b6820005e28767bbd3dd1281ea84e5f87f9b1990ffcda5d12"
    },
    "manifest": {
      "schemaVersion": 1,
      "platform": "windows",
      "arch": "x86_64",
      "modules": {
        "mcp": {
          "executable": "mcp/creator-works-mcp-launcher.exe",
          "version": "2.7.7",
          "files": {
            "mcp/creator-works-mcp-launcher.exe": "eb6473270bb9899f89b608205e50e7ffed3aa14b80d7e8661ec39e00642cb26e",
            "mcp/server/creator-works-mcp.mjs": "24adc371d6e4cfe7c257e0f466a5e5f0fce6b26178714221ac85f08d9f443a78",
            "mcp/server/runtime/node.exe": "c6335d08331c23d68b9f2b18adb102002d76ef150b47248e954c507e0d033664",
            "mcp/server/runtime/LICENSE": "8efdacdc1cfa3460aeb7fe98e3c54337b971d5da70e6eee292b73b981acb220c",
            "mcp/server/runtime/VERSION": "98182b41c9ce3357797985cf12dc3b0124490ef88bc918a905373e7688e6aec9",
            "mcp/server/unity-extension/Editor/BanterMCPBridge.cs": "b9272bef3538c31a959759b27b95ff592466667eb4d6919cef1aba7b3acaa1da",
            "mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png": "f3f68baa0d887de92e6cf7aba8beae7ff8ea5c44b13444f018413041ade19ea7",
            "mcp/server/LICENSE": "b1cfe8ff7191d3e9c6c6b0f832adcd2ebece8e6070ef72d2f7afc1c082fb757f",
            "mcp/server/THIRD_PARTY_NOTICES.md": "5e9f0fe9b73afe7c6c056a33124ead3110fc03c309f845e9dd6c76b0a9b00560"
          }
        },
        "setup": {
          "executable": "setup/creator-project-setup.exe",
          "version": "0.3.7",
          "files": {
            "setup/creator-project-setup.exe": "f66a4527b9d0c01337a6f6e3efd02e98bff5efdddcd0cd4c5b3c9ca6a5704b33"
          }
        }
      },
      "managedRouting": {
        "protocol": 1,
        "files": {
          "routing/creator-hub-mcp-router.exe": "2a68f35dc96a18c9b97de26d669961dbe1835f96f9fa2599cb4f1d4298aca74d",
          "routing/router.json": "eb089c1edc7013dced329cef2893b23400c0e228739dd95484ffbeb0abaea777",
          "routing/router.minisig": "f304e479b0820f1f91e6061455c537a6dc32b5e006fc735e42e6645b4d5d5747",
          "routing/runtime.json": "85a9408940ae424960d63c7f3c7cb2364d34432d5866dc6a80fb80e1e762c433",
          "routing/runtime.minisig": "fadb42106e2ebff5e0cdb0a6d40a64ea6dfc12d86877a19ca88bddc934235132"
        }
      }
    },
    "generation": "6336e342a58cedbdc1aca8e44ac128803a696f3998f84a7263d79ab4b2d500ad",
    "verificationReceiptSha256": "b15c19cf8854b39bacb83afd731e0a4bd715427ae0989834cf96cfd321fb999f",
    "sourceUnchanged": true,
    "buildExitCode": 0,
    "assetId": 708915966,
    "releaseId": 433720791
  },
  "target": {
    "source": {
      "commit": "9b65dd7aedc2eb224755db3d733a7fb19e8e8f62",
      "tree": "3048c4b2c8e5004024191dbb29f5651e5d6bb7e8"
    },
    "version": "0.1.20",
    "asset": "Creator.Hub_0.1.20_x64-setup.exe",
    "installer": {
      "bytes": 38461485,
      "sha256": "2915ffac9b1c39f5facbd4030eb6addf837e0d414b96835e0f0be1564577666b"
    },
    "executable": {
      "bytes": 19594240,
      "sha256": "06908120c81f471e9774edbe5a2d09fa3c985357eea373e29e75404d1f133cf5"
    },
    "manifest": {
      "schemaVersion": 1,
      "platform": "windows",
      "arch": "x86_64",
      "modules": {
        "mcp": {
          "executable": "mcp/creator-works-mcp-launcher.exe",
          "version": "2.7.8",
          "files": {
            "mcp/creator-works-mcp-launcher.exe": "6f0135705c5f894e8abb217b7440d774b36be940087d98e2c7019ea07dd506d7",
            "mcp/server/creator-works-mcp.mjs": "a6b309038ccc369299ed194e2f7e494c271aa1106ed6884a5f385a091d22de99",
            "mcp/server/runtime/node.exe": "c6335d08331c23d68b9f2b18adb102002d76ef150b47248e954c507e0d033664",
            "mcp/server/runtime/LICENSE": "8efdacdc1cfa3460aeb7fe98e3c54337b971d5da70e6eee292b73b981acb220c",
            "mcp/server/runtime/VERSION": "98182b41c9ce3357797985cf12dc3b0124490ef88bc918a905373e7688e6aec9",
            "mcp/server/unity-extension/Editor/BanterMCPBridge.cs": "14c3b9d112f4bec70cb63237b532e913e726aba0d7c3e8ed4e2fc4d26713a130",
            "mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png": "f3f68baa0d887de92e6cf7aba8beae7ff8ea5c44b13444f018413041ade19ea7",
            "mcp/server/LICENSE": "b1cfe8ff7191d3e9c6c6b0f832adcd2ebece8e6070ef72d2f7afc1c082fb757f",
            "mcp/server/THIRD_PARTY_NOTICES.md": "3596f4ad9f49cd460fa4da49ce3f1b92ad2f67113270b96d361e7e27ae0460af"
          }
        },
        "setup": {
          "executable": "setup/creator-project-setup.exe",
          "version": "0.3.7",
          "files": {
            "setup/creator-project-setup.exe": "be1f9827869636234d1f7e4ccf90f28b9332fb4fae1393542599b9fea22efb58"
          }
        }
      },
      "managedRouting": {
        "protocol": 1,
        "files": {
          "routing/creator-hub-mcp-router.exe": "7bdd33b3dba91fae11ac97a845d2dc71f2ea25b932a54a86c25aaba1af7489da",
          "routing/router.json": "ac18d34c91690d2ac1f22a8b3950e6415ee2895e77d93c999b17655aecffb01e",
          "routing/router.minisig": "da54fb3c0aabbc0d510f4cd7b9f56d7da68221306411e4507099945341caa81e",
          "routing/runtime.json": "44242fd365b2eacb062e74dc0a0764610ee38ac06355c93ae79c4dc505bba333",
          "routing/runtime.minisig": "265c731df1738a69a3852e757dee0c3e6ce1b934ec2eb62d8959dd0236e69665"
        }
      }
    },
    "generation": "9f866910d3113caac0e9c6a6db2df326c0f64c33e5b46300d6960f28cf2189aa",
    "verificationReceiptSha256": "70250ab5f7994141c6f78cafdfe7a8ab69e9247780dfd7809d34e44612caf021",
    "sourceUnchanged": true,
    "buildExitCode": 0,
    "descriptor": {
      "bytes": 505,
      "sha256": "e7e27ca43a1cfb39bd2ae774b56e7b3ccb994dcbf30d9881d489d63d01f8cbec"
    },
    "descriptorSignature": {
      "bytes": 305,
      "sha256": "47e095c2d78edf28d5ef7ab56a0d15d6935548c112687bd347c9ea6e9aa1d770"
    },
    "latest": {
      "bytes": 690,
      "sha256": "1abd4177f6128e4c59f19c5a9247bbcd579e8ae71fb455b5bba5bb1385c8cf0a"
    }
  },
  "publication": null,
  "originalLatest": {
    "version": "0.1.20",
    "notes": "Private candidate acceptance only; not published.",
    "platforms": {
      "windows-x86_64": {
        "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUK2F5K1IyZ2ZXTWZ6TThvb0ZsME1vanZocm5jMSt0eTByMUNLcjFpMFExQURqUEs3RmpiaUF3QmIrZlkrbzB1QldHY2w5YU1rdk5XRGZ2RjNHbnBGeTJtSlpQMlhncVFNPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzODgwOTMzCWZpbGU6c2lnbmluZy1pbnB1dC0xLmV4ZQpZNm5xN3pUczJGL25DcUlWdUlHNlZBZ0p0WjkrWWJZMmxXVHRSQU1lSWZwcFl0eU9kS05na2JNQm5qU3FkSFZIeUZrSEcyNkNBd2Rjakw4bVBxOElEUT09Cg==",
        "url": "https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.20/Creator.Hub_0.1.20_x64-setup.exe"
      }
    }
  },
  "stagedPublic": {
    "releaseId": 435215396,
    "tag": "v0.1.20",
    "assets": {
      "creator-hub-windows-x86_64.json": {
        "id": 713452112,
        "size": 505,
        "sha256": "e7e27ca43a1cfb39bd2ae774b56e7b3ccb994dcbf30d9881d489d63d01f8cbec"
      },
      "creator-hub-windows-x86_64.json.minisig": {
        "id": 713452111,
        "size": 305,
        "sha256": "47e095c2d78edf28d5ef7ab56a0d15d6935548c112687bd347c9ea6e9aa1d770"
      },
      "Creator.Hub_0.1.20_x64-setup.exe": {
        "id": 713452102,
        "size": 38461485,
        "sha256": "2915ffac9b1c39f5facbd4030eb6addf837e0d414b96835e0f0be1564577666b"
      },
      "Creator.Hub_0.1.20_x64-setup.exe.sig": {
        "id": 713452101,
        "size": 409,
        "sha256": "b67bdb99e332d9d48bf5164a449605ea21d09a9b7009f377ab86c16f433d253d"
      },
      "latest.json": {
        "id": 713452113,
        "size": 744,
        "sha256": "0cd43ab6e5851b6170ea529ff3ac16ce92472db0c431c8896103b189318df805"
      },
      "SHA256SUMS.txt": {
        "id": 713452141,
        "size": 484,
        "sha256": "6fcd0af20a4e464faabb4949307acae169aeafdd3018f2b91d992e53b7aa226d"
      }
    }
  }
};
const SIDECARS = {
  "creator-hub-windows-x86_64.json": "{\n  \"schemaVersion\": 1,\n  \"appId\": \"creator-hub\",\n  \"version\": \"0.1.20\",\n  \"platform\": \"windows\",\n  \"architecture\": \"x86_64\",\n  \"packageType\": \"nsis\",\n  \"assetName\": \"Creator.Hub_0.1.20_x64-setup.exe\",\n  \"byteLength\": 38461485,\n  \"sha256\": \"2915ffac9b1c39f5facbd4030eb6addf837e0d414b96835e0f0be1564577666b\",\n  \"executableSha256\": \"06908120c81f471e9774edbe5a2d09fa3c985357eea373e29e75404d1f133cf5\",\n  \"identityProtocol\": 0,\n  \"lifecycleProtocol\": 0,\n  \"installerProtocol\": 1,\n  \"minHubVersion\": \"0.1.19\"\n}\n",
  "creator-hub-windows-x86_64.json.minisig": "untrusted comment: signature from tauri secret key\nRUT+ay+R2gfWMfSktXXdWGG5Uxg1Px7y1qqfvDQSltmw2pw1KHSx/CJhjtnG1mFS2NX3w3nNx5l3O6WEchoBfkPUNP4PY9Uomw8=\ntrusted comment: timestamp:1793880931\tfile:signing-input-0.json\n9n3a9QBgYD/wWbtbLswQwyUh9i40SVWj4LMAIffHL1mHrx+fyHvvwQ073RvbAF6apAQZkAVmLlPe2EbxC263Cw==\n",
  "Creator.Hub_0.1.20_x64-setup.exe.sig": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUK2F5K1IyZ2ZXTWZ6TThvb0ZsME1vanZocm5jMSt0eTByMUNLcjFpMFExQURqUEs3RmpiaUF3QmIrZlkrbzB1QldHY2w5YU1rdk5XRGZ2RjNHbnBGeTJtSlpQMlhncVFNPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzODgwOTMzCWZpbGU6c2lnbmluZy1pbnB1dC0xLmV4ZQpZNm5xN3pUczJGL25DcUlWdUlHNlZBZ0p0WjkrWWJZMmxXVHRSQU1lSWZwcFl0eU9kS05na2JNQm5qU3FkSFZIeUZrSEcyNkNBd2Rjakw4bVBxOElEUT09Cg==\n",
  "latest.json": "{\n  \"version\": \"0.1.20\",\n  \"notes\": \"MCP safety fixes, refreshed Creator SDK node catalogue and docs, and advisory graph-performance checks.\",\n  \"platforms\": {\n    \"windows-x86_64\": {\n      \"signature\": \"dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUK2F5K1IyZ2ZXTWZ6TThvb0ZsME1vanZocm5jMSt0eTByMUNLcjFpMFExQURqUEs3RmpiaUF3QmIrZlkrbzB1QldHY2w5YU1rdk5XRGZ2RjNHbnBGeTJtSlpQMlhncVFNPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkzODgwOTMzCWZpbGU6c2lnbmluZy1pbnB1dC0xLmV4ZQpZNm5xN3pUczJGL25DcUlWdUlHNlZBZ0p0WjkrWWJZMmxXVHRSQU1lSWZwcFl0eU9kS05na2JNQm5qU3FkSFZIeUZrSEcyNkNBd2Rjakw4bVBxOElEUT09Cg==\",\n      \"url\": \"https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.20/Creator.Hub_0.1.20_x64-setup.exe\"\n    }\n  }\n}\n",
  "SHA256SUMS.txt": "2915ffac9b1c39f5facbd4030eb6addf837e0d414b96835e0f0be1564577666b  Creator.Hub_0.1.20_x64-setup.exe\nb67bdb99e332d9d48bf5164a449605ea21d09a9b7009f377ab86c16f433d253d  Creator.Hub_0.1.20_x64-setup.exe.sig\ne7e27ca43a1cfb39bd2ae774b56e7b3ccb994dcbf30d9881d489d63d01f8cbec  creator-hub-windows-x86_64.json\n47e095c2d78edf28d5ef7ab56a0d15d6935548c112687bd347c9ea6e9aa1d770  creator-hub-windows-x86_64.json.minisig\n0cd43ab6e5851b6170ea529ff3ac16ce92472db0c431c8896103b189318df805  latest.json\n"
};
function publishedBinding() {
  const b = structuredClone(FIXTURE_BINDING);
  b.publication = { ...structuredClone(b.stagedPublic), tagCommit: b.target.source.commit, draft: false, prerelease: false };
  return b;
}
function environment() { return { GITHUB_SHA: 'a'.repeat(40) }; }
function loadWith(b) {
  return { configFor: () => ({
    baseline: { version: '0.1.19', installer: b.baseline.installer.sha256, exe: b.baseline.executable.sha256 },
    pins: { descriptor: b.target.descriptor.sha256, descriptorSignature: b.target.descriptorSignature.sha256,
      installer: b.target.installer.sha256, executable: b.target.executable.sha256, manifest: b.publication.assets['latest.json'].sha256 }
  }) };
}
function feed(b) {
  return encode([{ id: b.publication.releaseId, tag_name: 'v0.1.20', draft: false, prerelease: false,
    assets: Object.entries(b.publication.assets).map(([name,p]) => ({ name, ...p, digest: 'sha256:' + p.sha256, browser_download_url: api.url('0.1.20', name) })) },
    { id: b.baseline.releaseId, tag_name: 'v0.1.19', draft: false, prerelease: false, assets: [{ name: api.BASELINE_ASSET,
      id: b.baseline.assetId, size: b.baseline.installer.bytes, digest: 'sha256:' + b.baseline.installer.sha256, browser_download_url: api.url('0.1.19', api.BASELINE_ASSET) }] }]);
}
function evidenceFixture(caseName = 'mcp-restore') {
  const b = publishedBinding(), a = loadWith(b), env = environment(a);
  const bytes = feed(b), bindingHash = api.hash(encode(b));
  const pin = { harnessCommit: env.GITHUB_SHA, bindingSha256: bindingHash, inputBindingSha256: '' };
  const input = { schemaVersion: 1, kind: b.kind, harnessSource: pin.harnessCommit, bindingSha256: bindingHash,
    source: b.target.source, releaseId: b.publication.releaseId, tagCommit: b.publication.tagCommit,
    publicFeedUrl: api.FEED, publicFeedSha256: api.hash(bytes), feed: api.checkRelease(bytes, b),
    baseline: a.configFor(path.resolve('artifacts/public-update-020-input')).baseline,
    pins: a.configFor(path.resolve('artifacts/public-update-020-input')).pins,
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
    beforePeVersion: [0, 1, 19, 0], afterPeVersion: [0, 1, 20, 0], beforeRoot: rootProc(10, '100'), afterRoot: rootProc(20, '300'), approvalLowerBoundTicks: '200',
    resourceProbe: { phase: 'after-automatic-root', attempts: 1, passed: true }, beforeRoute: route(b.baseline), afterRoute: route(b.target),
    heldServerVersion: { version: '2.7.7' }, reconnectedServerVersion: { version: '2.7.8' },
    heldProcessesBefore: [proc(30, 'baseline'), proc(31, 'baseline')], heldProcessesAfter: [proc(30, 'baseline'), proc(31, 'baseline')],
    reconnectedProcesses: [proc(40, 'target', '400'), proc(41, 'target', '400')],
    settingsBefore: settings, settingsAfter: settings, preferencesBefore: preferences, preferencesAfter: preferences,
    publicProof: { ...input, inputBindingSha256: pin.inputBindingSha256 } };
  for (const k of ['passed', 'publicDiscovery', 'nativeUpdateAccepted', 'automaticRestart', 'cancelPreserved', 'settingsPreserved',
    'existingConnectionSurvived', 'newConnectionVerified', 'restorationVerified', 'changedMcpGenerationProven',
    'installedResourcesVerifiedBeforeAndAfter', 'heldGenerationRetained', 'activeRouteUnchangedAfterCancel',
    'sdkCleanupVerified', 'rootCleanupVerified', 'sentinelCleanupVerified', 'policyRestored']) report[k] = true;
  for (const k of ['labDiscovery', 'liveAiAcceptance', 'releaseReady', 'harnessAdditionalLaunch', 'userMachineUsed']) report[k] = false;
  const q = { version: '0.1.20', platform: 'windows-x86_64', candidate: { sourceCommit: b.target.source.commit,
    sourceTree: b.target.source.tree, installerSha256: b.target.installer.sha256, executableSha256: b.target.executable.sha256 },
    draft: { id: b.publication.releaseId, assets: b.publication.assets } };
  const bodies = Object.fromEntries(api.ASSETS.filter(n => n !== api.ASSET).map(n => [n, Buffer.from(SIDECARS[n])]));
  return { b, q, pin, input, report, bytes, bodies, caseName };
}
function validate(f) { return reader.validateEvidence(f.q, f.b, f.report, f.input, f.bytes, f.bodies, f.pin, f.caseName); }
test('reader checks all three synthetic case reports against real staged sidecars', () => {
  for (const name of reader.CASES) validate(evidenceFixture(name));
});
test('reader rejects changed settings, lab evidence, stale generation, source, cleanup and sidecar', () => {
  for (const mutate of [f => f.report.settingsAfter = {}, f => f.report.labDiscovery = true,
    f => f.report.afterRoute.generation = f.b.baseline.generation, f => f.report.reconnectedServerVersion.version = '2.7.7',
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
  const bindingBytes = encode(f.b), workflow = Buffer.from('TEST ONLY reviewed workflow bytes; no native workflow dependency');
  const review = { kind: 'windows-020-public-harness-review', version: '0.1.20', baselineVersion: '0.1.19',
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
      head_sha: review.harnessCommit, head_branch: 'validation/windows-public-update-020-20261105', path: reader.WORKFLOW, repository: repo, head_repository: repo }],
    [`git/commits/${review.harnessCommit}`, { sha: review.harnessCommit, tree: { sha: review.harnessTree } }],
    [`git/trees/${review.harnessTree}?recursive=1`, { sha: review.harnessTree, truncated: false, tree: [
      { type: 'blob', path: reader.WORKFLOW, sha: 'e'.repeat(40) }, { type: 'blob', path: reader.BINDING, sha: 'f'.repeat(40) }] }],
    [`git/blobs/${'e'.repeat(40)}`, { sha: 'e'.repeat(40), encoding: 'base64', size: workflow.length, content: workflow.toString('base64') }],
    [`git/blobs/${'f'.repeat(40)}`, { sha: 'f'.repeat(40), encoding: 'base64', size: bindingBytes.length, content: bindingBytes.toString('base64') }],
    ['actions/runs/100/jobs?per_page=100', { total_count: 4, jobs }],
    ['actions/runs/100/artifacts?per_page=100', { artifacts: [{ id: 500, name: 'hub-public-self-update-020', size_in_bytes: archive.length,
      expired: false, digest: 'sha256:' + api.hash(archive), created_at: '2026-11-05T10:01:00Z',
      workflow_run: { id: 100, head_sha: review.harnessCommit, repository_id: repo.id, head_repository_id: repo.id } }] }],
  ]);
  const io = { request: async r => { assert.ok(responses.has(r), r); return responses.get(r); },
    download: async (r, bound) => { assert.equal(r, 'actions/artifacts/500/zip'); assert.equal(bound, archive.length + 1); return archive; } };
  return { ...f, io, options, responses };
}
test('verify(qualification, options) reads one aggregate with all three original reports', async () => {
  const f = remoteFixture(), result = await reader.verify(f.q, f.options, f.io);
  assert.equal(result.publicAcceptance, true); assert.equal(result.version, '0.1.20');
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

test('standalone runtime closure does not load adapter, resources, binding, native driver or workflow', () => {
  const local = Object.keys(require.cache).filter(p => path.dirname(p) === __dirname).map(p => path.basename(p));
  assert.deepEqual(local.sort(), ['check-release-feed.cjs','public-update-evidence-io.cjs','windows-020-public-acceptance.cjs','windows-020-public-acceptance.test.cjs','windows-020-public-contract.cjs'].sort());
  assert.deepEqual(Object.keys(api).sort(), ['hash','KIND','ASSET','BASELINE_ASSET','CASES','FEED','ASSETS','url','publication','checkRelease','checkRestart'].sort());
  assert.equal(reader.WORKFLOW, '.github/workflows/self-update-acceptance.yml');
});
test('pure contract retains pending, lab and stale-public refusals', () => {
  assert.throws(() => api.publication(FIXTURE_BINDING), /pending/);
  for (const mutate of [b => b.publication.draft=true, b => b.publication.releaseId=435162323,
    b => b.publication.assets[api.ASSET].sha256='f'.repeat(64)]) {
    const b=publishedBinding(); mutate(b); assert.throws(() => api.publication(b));
  }
  for (const mutate of [r => r[0].draft=true, r => r[1].tag_name='v0.1.18',
    r => r[0].assets[0].browser_download_url='https://localhost/fake']) {
    const b=publishedBinding(), r=JSON.parse(feed(b)); mutate(r); assert.throws(() => api.checkRelease(encode(r), b));
  }
});
test('standalone exact target and review hashes cannot be substituted', async () => {
  for (const mutate of [f => f.q.version='0.1.19', f => f.q.candidate.sourceCommit='f'.repeat(40),
    f => f.options.publicReviewSha256='f'.repeat(64), f => f.options.sha256='f'.repeat(64)]) {
    const f=remoteFixture(); mutate(f); await assert.rejects(reader.verify(f.q, f.options, f.io));
  }
});
test('evidence I/O remains read-only and rejects ambiguous archive members', () => {
  const calls=[];
  const get=archiveTools.createGhReader((command,args) => { calls.push({command,args}); return Buffer.from('{}'); });
  assert.equal(get('actions/runs/100',1024).toString(),'{}');
  assert.equal(calls[0].command,'gh'); assert.deepEqual(calls[0].args,['api','repos/BOBWORKS-XR/CREATOR-HUB/actions/runs/100']);
  assert.throws(() => get('graphql',1024));
  const duplicate=zip([['x/report.json',Buffer.from('{}')],['x/report.json',Buffer.from('{}')]]);
  assert.throws(() => archiveTools.readZipMember(duplicate,'x/report.json'));
});
