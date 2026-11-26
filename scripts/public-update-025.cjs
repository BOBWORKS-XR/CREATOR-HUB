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
const KIND = 'public-027-to-028';
const ASSET = 'Creator.Hub_0.1.28_x64-setup.exe';
const BASELINE_ASSET = 'Creator.Hub_0.1.27_x64-setup.exe';
const NAMES = [ASSET, 'creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig', 'latest.json'];
const FEED = 'https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases?per_page=10';
const TAG = 'https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/git/ref/tags/v0.1.28';
const BRANCH = 'codex/windows-public-028';
const WORKFLOW = 'windows-outgoing-019.yml';
const RELEASE_ID = 459784740;
const ASSET_IDS = [797228771, 797231552, 797231617, 797231703];
const STAGE_SHA256 = '47924a347e6bff17a2734a191d00be0d9a3f8e4093f5b3ba8a794f78a3bf7525';
const TAG_COMMIT = '68b4b74192f762e76ec1489bb144d3bcd35bef4f';
const CASES = { 'mcp-restore': ['mcp', 'true'], 'setup-restore': ['setup', 'true'], 'setup-no-restore': ['setup', 'false'] };
const bindingSha256 = hash(fs.readFileSync(path.join(__dirname, 'fixtures/public-update-025-binding.json')));
const url = (version, name) => `https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v${version}/${name}`;
const EXPECTED = {
  "baseline": {
    "version": "0.1.27",
    "asset": "Creator.Hub_0.1.27_x64-setup.exe",
    "source": {
      "commit": "1598962f4edefd1831e973b0b069bcd8b725df93",
      "tree": "8363e87e58a03bc91d8ea660d9c444fd27d5eddb"
    },
    "installer": {
      "bytes": 38744117,
      "sha256": "3ef9ce5cc25a00e59b466dee216a8c7d20d63c5c981796f2e2318380af6d37b0"
    },
    "executable": {
      "bytes": 19987968,
      "sha256": "6233f80b86b70ca8e965e81724a2ff3f7daf8aaaef58d6a06fad528f30715ccb"
    },
    "manifest": {
      "schemaVersion": 1,
      "platform": "windows",
      "arch": "x86_64",
      "modules": {
        "mcp": {
          "executable": "mcp/creator-works-mcp-launcher.exe",
          "version": "2.7.10",
          "files": {
            "mcp/creator-works-mcp-launcher.exe": "ed654b669dd094ccd2bca373e42932ae5f58607b05db39286f2bc8579ebff4e2",
            "mcp/server/creator-works-mcp.mjs": "fb1958548f3c071b2b595e98946452c53b5a1b9fa1e419e06f4ec87f0c72f412",
            "mcp/server/runtime/node.exe": "c6335d08331c23d68b9f2b18adb102002d76ef150b47248e954c507e0d033664",
            "mcp/server/runtime/LICENSE": "8efdacdc1cfa3460aeb7fe98e3c54337b971d5da70e6eee292b73b981acb220c",
            "mcp/server/runtime/VERSION": "98182b41c9ce3357797985cf12dc3b0124490ef88bc918a905373e7688e6aec9",
            "mcp/server/unity-extension/Editor/BanterMCPBridge.cs": "fe21aefe30c7b48e3b9c487905a75a807371397006138852701bc287fc7570cd",
            "mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png": "f3f68baa0d887de92e6cf7aba8beae7ff8ea5c44b13444f018413041ade19ea7",
            "mcp/server/LICENSE": "b1cfe8ff7191d3e9c6c6b0f832adcd2ebece8e6070ef72d2f7afc1c082fb757f",
            "mcp/server/THIRD_PARTY_NOTICES.md": "3596f4ad9f49cd460fa4da49ce3f1b92ad2f67113270b96d361e7e27ae0460af"
          }
        },
        "setup": {
          "executable": "setup/creator-project-setup.exe",
          "version": "0.3.7",
          "files": {
            "setup/creator-project-setup.exe": "abafc45e89f6688284bc306d6da62775dbb194662dc369976becb48e5c09156f"
          }
        }
      },
      "managedRouting": {
        "protocol": 1,
        "files": {
          "routing/creator-hub-mcp-router.exe": "6f959f6f8919538084d26c1800868aaa3b7b18545cba96de3e0b04782115a967",
          "routing/router.json": "5760ee356aa49fc79f9fba3db281e0e628d0a187491d26312aa6cdb604b5e2e3",
          "routing/router.minisig": "8c8a3d64532900a6079eb5d164b0706777a420450db78d053269d7840372fa00",
          "routing/runtime.json": "dd0c1928cc14b9e5d8f5347a3f501e92d106d424da64b972199841ea9fe1584d",
          "routing/runtime.minisig": "e3575febdee81d4e76d603ef33ea8421ef72e7ad7472a94a583a646af3081759"
        }
      }
    },
    "generation": "df0ec83365a0ed5e235c784243531676467e56bfeafce43c818d5309022c2b54",
    "sourceUnchanged": true,
    "buildExitCode": 0,
    "verificationReceiptSha256": "ce7986d0fdd6bc74822ef24839cea67391d7c61c1a226c0df414262ae07ccbb9",
    "descriptor": {
      "bytes": 505,
      "sha256": "0b080b7de2e1548962fa62efbc86fe4a39a708e05173633f4f35894d1dfb637f"
    },
    "descriptorSignature": {
      "bytes": 316,
      "sha256": "31d3f46e983c1b7c56fa6d3d7c4c0657580835043b4987ee8bbbde2f27d36e07"
    },
    "latest": {
      "bytes": 816,
      "sha256": "40944ded7690d5f57796177da517eb18ddb102b79bb06d7b7d472421eddc6ada"
    },
    "releaseId": 457371653,
    "assetId": 788972386
  },
  "target": {
    "source": {
      "commit": "989bccc6d6e204dc581b662d59b2a0f3471b35b1",
      "tree": "834540a1cb1cde1d415d11b0ffdb423c63debb43"
    },
    "version": "0.1.28",
    "asset": "Creator.Hub_0.1.28_x64-setup.exe",
    "manifest": {
      "schemaVersion": 1,
      "platform": "windows",
      "arch": "x86_64",
      "modules": {
        "mcp": {
          "executable": "mcp/creator-works-mcp-launcher.exe",
          "version": "2.7.11",
          "files": {
            "mcp/creator-works-mcp-launcher.exe": "7c8d15c44b2ddb73ad6a1eec29cc81f933dd976c0bdae94f77bfad121d669bdf",
            "mcp/server/creator-works-mcp.mjs": "546c600b242a3d60dd084889bdd9c9a5756eb0312bc410fd661cb5150259cf52",
            "mcp/server/runtime/node.exe": "c6335d08331c23d68b9f2b18adb102002d76ef150b47248e954c507e0d033664",
            "mcp/server/runtime/LICENSE": "8efdacdc1cfa3460aeb7fe98e3c54337b971d5da70e6eee292b73b981acb220c",
            "mcp/server/runtime/VERSION": "98182b41c9ce3357797985cf12dc3b0124490ef88bc918a905373e7688e6aec9",
            "mcp/server/unity-extension/Editor/BanterMCPBridge.cs": "c9768042cb2d1b34f5cbf78297b1fcd771b59ca8808693d5362b8084c633bcec",
            "mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png": "f3f68baa0d887de92e6cf7aba8beae7ff8ea5c44b13444f018413041ade19ea7",
            "mcp/server/LICENSE": "b1cfe8ff7191d3e9c6c6b0f832adcd2ebece8e6070ef72d2f7afc1c082fb757f",
            "mcp/server/THIRD_PARTY_NOTICES.md": "3596f4ad9f49cd460fa4da49ce3f1b92ad2f67113270b96d361e7e27ae0460af"
          }
        },
        "setup": {
          "executable": "setup/creator-project-setup.exe",
          "version": "0.3.7",
          "files": {
            "setup/creator-project-setup.exe": "a95315eb9759e9e177e3daac44bd3f53b722b34cbe396919cfc022454b3c4924"
          }
        }
      },
      "managedRouting": {
        "protocol": 1,
        "files": {
          "routing/creator-hub-mcp-router.exe": "230af0a95cc7ca5d4ee421d192be084a0a1cfaea56788b0fefeffae9eb98721c",
          "routing/router.json": "cdddc5932a85a294940d488ebbbc7373d4943798b0f436de98b246087783b845",
          "routing/router.minisig": "c10e03a2444e82b5591c0bef3c1b4dcdc28b091da097c87f7219249ea9dae4c0",
          "routing/runtime.json": "0d0365bf506d297290dfa801ddec544a5b04c30bcd21cb7f444e0618312f8659",
          "routing/runtime.minisig": "74536ef4f0fe248dad2b5e2fe9dd914196fdf321ebc9faf66f340eabd319286f"
        }
      }
    },
    "generation": "6c1f40b5e940562342fb9035c7e39330b436b5d6d06dc2973a8d99bbb6851c6c",
    "installer": {
      "bytes": 38833740,
      "sha256": "1cb612c8cff49950004d0c429cf4b4ddb9adf2e2821ab72e31e8351490cad1b1"
    },
    "executable": {
      "bytes": 20132864,
      "sha256": "0d0dac1967c65c1f0ba1373949122596825751e87a9a2c27030794d89a6856f8"
    },
    "sourceUnchanged": true,
    "buildExitCode": 0,
    "verificationReceiptSha256": "84ef51ace83dfe9c679a361d8dabdbee2b6820e2fd7388b12ba9209f3981be42",
    "descriptor": {
      "bytes": 505,
      "sha256": "64263fc22c0127689f63f0a497152c3be2952eca30fb64ce332c78ad0787925e"
    },
    "descriptorSignature": {
      "bytes": 316,
      "sha256": "19b15b0e98199491f603239410a034e84f27e9d323a93892929062aa0145f293"
    },
    "latest": {
      "bytes": 706,
      "sha256": "67e3ce13d85604cd53fa5d2efbf3517bbc6366e307298f4a5f16bc0b9df434c4"
    }
  },
  "originalLatest": {
    "version": "0.1.28",
    "notes": "Windows project connections and builder guidance.",
    "platforms": {
      "windows-x86_64": {
        "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUK2F5K1IyZ2ZXTVpnVjJrdThSTnhZaU9keEt2amU5MEFQMjF5ODMxVy9oMmVsdjZCdHVDclgyRHFmTU52OGRCcUVEa0gzQkdvbEc4aXlHdTYrUi9BSkROVHVZSnZnQ0FVPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzk1NjU0MTM2CWZpbGU6Q3JlYXRvci5IdWJfMC4xLjI4X3g2NC1zZXR1cC5leGUKTDQ4UE1rdmlTYWVVaGtRQXdFNmlpbnpKVVJraTNVZmI4cHVXYS9RaHh6R3JVSzVsQy80Tm1YTDFVdW85TzZVRVZYNnZhM1MyOUROQ1BsUkpFN3QxQ1E9PQo=",
        "url": "https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.28/Creator.Hub_0.1.28_x64-setup.exe"
      }
    }
  }
};
function validateBinding(value=binding) {
  assert.equal(value.enabled,true,'Public readback pins pending');assert.equal(value.kind,KIND);assert.equal(value.publicOnly,true);
  assert.deepEqual(value.baseline,EXPECTED.baseline);assert.deepEqual(value.originalLatest,EXPECTED.originalLatest);
  assert.deepEqual(value.target,EXPECTED.target);
  assert.equal(value.qualificationSha256,EXPECTED.target.verificationReceiptSha256);
  assert.equal(typeof value.publicNotes,'string');assert.ok(value.publicNotes.trim());assert.ok(Buffer.byteLength(value.publicNotes)<=8192);
  assert.equal(value.publicNotes,EXPECTED.originalLatest.notes);
  assert.ok(!/private|not published|not release-qualified/i.test(value.publicNotes));
  assert.ok(value.target.latest.bytes>0&&value.target.latest.bytes<=32768);assert.match(value.target.latest.sha256,/^[a-f0-9]{64}$/);
  const p=value.publication;assert.ok(p);assert.equal(p.tag,'v0.1.28');assert.equal(p.draft,false);assert.equal(p.prerelease,true);
  assert.equal(value.stageReceiptSha256,STAGE_SHA256);assert.equal(p.releaseId,RELEASE_ID);
  assert.deepEqual(Object.keys(p.assets).sort(),[...NAMES].sort());
  const pins=[value.target.installer,value.target.descriptor,value.target.descriptorSignature,value.target.latest],ids=new Set([value.baseline.assetId]);
  for(const [i,n]of NAMES.entries()){const a=p.assets[n];assert.equal(a.id,ASSET_IDS[i]);assert.ok(!ids.has(a.id));ids.add(a.id);assert.deepEqual({bytes:a.size,sha256:a.sha256},pins[i]);}
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
  assert.equal(env.EXPECTED_TAG_COMMIT, TAG_COMMIT, 'Exact tag gate commit required');
  assert.equal(env.CREATOR_PUBLIC_BINDING_SHA256, bindingSha256);
  assert.ok(Object.hasOwn(CASES, env.CREATOR_OUTGOING_CASE));
  assert.deepEqual([env.CREATOR_OUTGOING_LAST_TOOL, env.CREATOR_OUTGOING_RESTORE], CASES[env.CREATOR_OUTGOING_CASE]);
  for (const [key, value] of Object.entries(env)) if (/^(?:https?_proxy|all_proxy|no_proxy|node_options|node_use_env_proxy|node_tls_reject_unauthorized|node_extra_ca_certs|ssl_cert_file|ssl_cert_dir|curl_ca_bundle|requests_ca_bundle|gh_token|github_token|creator_.*(?:lab|fixture|migrated|incoming|outgoing_config|outgoing_review).*)$/i.test(key)) {
    assert.ok(value === undefined || value === '', `Public transport refuses ${key}`);
  }
}
function checkRelease(bytes) {
  const p = validateBinding(), summary = inspectFeed(bytes, '0.1.28');
  assert.equal(summary.previousStable, '0.1.27');
  assert.ok(summary.headroom>=4096,'Public feed must retain publication headroom');
  const releases = JSON.parse(bytes), selected = releases.filter(r => r.tag_name === p.tag);
  const stable = releases.filter(r => !r.draft && !r.prerelease)
    .map(r => String(r.tag_name).replace(/^v/, '')).filter(v => semver.valid(v) && !semver.prerelease(v)).sort(semver.rcompare);
  assert.equal(stable[0], '0.1.27', 'Only the exact newest public stable is admitted');
  assert.ok(!releases.some(x=>!x.draft && /^v/.test(x.tag_name) && semver.valid(x.tag_name.slice(1)) && semver.gt(x.tag_name.slice(1),'0.1.28'))); assert.equal(selected.length, 1); const r = selected[0];
  assert.equal(r.id, p.releaseId); assert.equal(r.draft, false); assert.equal(r.prerelease, true);
  assert.equal(r.target_commitish, binding.target.source.commit);
  assert.equal(r.assets.length, NAMES.length);
  for (const name of NAMES) {
    const rows = r.assets.filter(a => a.name === name); assert.equal(rows.length, 1);
    const a = rows[0], pin = p.assets[name];
    assert.equal(a.id, pin.id); assert.equal(a.size, pin.size); assert.equal(a.digest, `sha256:${pin.sha256}`);
    assert.equal(a.state, 'uploaded'); assert.equal(a.browser_download_url, url('0.1.28', name));
  }
  const old = releases.filter(r => r.tag_name === 'v0.1.27'); assert.equal(old.length, 1);
  assert.equal(old[0].id, binding.baseline.releaseId); assert.equal(old[0].draft, false); assert.equal(old[0].prerelease, false);
  const assets = old[0].assets.filter(a => a.name === BASELINE_ASSET); assert.equal(assets.length, 1);
  assert.equal(assets[0].id, binding.baseline.assetId); assert.equal(assets[0].size, binding.baseline.installer.bytes);
  assert.equal(assets[0].digest, `sha256:${binding.baseline.installer.sha256}`);
  assert.equal(assets[0].browser_download_url, url('0.1.27', BASELINE_ASSET));
  return summary;
}
async function publicBytes(address, max, fetcher = fetch) {
  assert.ok(address === FEED || address === TAG || address === url('0.1.27', BASELINE_ASSET) || NAMES.some(n => address === url('0.1.28', n)));
  const response = await fetcher(address, { headers: { 'User-Agent': 'Creator-Hub-public-acceptance/0.1.28' },
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
    baseline: { version: '0.1.27', installer: binding.baseline.installer.sha256, exe: binding.baseline.executable.sha256 },
    targetVersion: '0.1.28', pins: { descriptor: binding.target.descriptor.sha256, descriptorSignature: binding.target.descriptorSignature.sha256,
      installer: binding.target.installer.sha256, executable: binding.target.executable.sha256, manifest: binding.target.latest.sha256 },
    runtime: { baselineDescriptor: binding.baseline.manifest.managedRouting.files['routing/runtime.json'], targetDescriptor: binding.target.manifest.managedRouting.files['routing/runtime.json'] } };
}
function assertBound(config) { assert.deepEqual(config, configFor()); }
function readConfig(file) {
  assert.equal(file, path.join(directory(), 'config.json'));
  const config = JSON.parse(resources.readBounded(file, 32768)); assertBound(config); return config;
}
function checkTag(bytes, expected = process.env.EXPECTED_TAG_COMMIT) {
  assert.equal(expected, TAG_COMMIT);
  const row=JSON.parse(bytes);
  assert.equal(row.ref,'refs/tags/v0.1.28');
  assert.equal(row.object?.type,'commit');
  assert.equal(row.object.sha,expected);
}
function proofFor(bytes, tag, env = process.env) {
  checkTag(tag, env.EXPECTED_TAG_COMMIT);
  return { schemaVersion: 1, kind: KIND, harnessSource: env.GITHUB_SHA, bindingSha256,
    source: binding.target.source, releaseId: validateBinding().releaseId, tagCommit: env.EXPECTED_TAG_COMMIT,
    stageReceiptSha256: STAGE_SHA256,
    publicFeedUrl: FEED, publicFeedSha256: hash(bytes), publicTagSha256: hash(tag), feed: checkRelease(bytes), baseline: configFor().baseline,
    pins: configFor().pins, authenticatedDownload: false, lab: false, fixture: false };
}
function checkSidecars(dir) {
  const latest = JSON.parse(resources.readBounded(path.join(dir, 'latest.json'), 32768));
  const a = { ...latest }, b = { ...binding.originalLatest }; delete a.notes; delete b.notes;
  assert.deepEqual(a, b, 'Only public notes may differ'); assert.equal(latest.notes, binding.publicNotes);
  assert.equal(latest.platforms['windows-x86_64'].url, url('0.1.28', ASSET));
}
async function prepare() {
  assertAdmission(); const dir = directory(); assert.equal(fs.existsSync(dir), false); fs.mkdirSync(dir, { recursive: true });
  const feed = await publicBytes(FEED, 256 * 1024); checkRelease(feed);
  const tag = await publicBytes(TAG, 32768); checkTag(tag);
  fs.writeFileSync(path.join(dir, 'public-feed.json'), feed, { flag: 'wx' });
  fs.writeFileSync(path.join(dir, 'public-tag.json'), tag, { flag: 'wx' });
  const pins = { ...binding.publication.assets, [BASELINE_ASSET]: { size: binding.baseline.installer.bytes, sha256: binding.baseline.installer.sha256 } };
  for (const [name, pin] of Object.entries(pins)) {
    const bytes = await publicBytes(url(name === BASELINE_ASSET ? '0.1.27' : '0.1.28', name), pin.size);
    assert.equal(bytes.length, pin.size); assert.equal(hash(bytes), pin.sha256);
    fs.writeFileSync(path.join(dir, name), bytes, { flag: 'wx' });
  }
  checkSidecars(dir);
  fs.writeFileSync(path.join(dir, 'public-input-binding.json'), JSON.stringify(proofFor(feed, tag), null, 2), { flag: 'wx' });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(configFor(), null, 2), { flag: 'wx' });
}
function loadContract(config) {
  assertAdmission(); assertBound(config); const dir = directory();
  const bytes = resources.readBounded(path.join(dir, 'public-feed.json'), 256 * 1024);
  const tag = resources.readBounded(path.join(dir, 'public-tag.json'), 32768);
  const proof = proofFor(bytes, tag), input = resources.readBounded(path.join(dir, 'public-input-binding.json'), 32768);
  assert.deepEqual(JSON.parse(input), proof);
  for (const [name, pin] of Object.entries(binding.publication.assets)) {
    const b = resources.readBounded(path.join(dir, name), pin.size); assert.equal(b.length, pin.size); assert.equal(hash(b), pin.sha256);
  }
  resources.readHash(path.join(dir, BASELINE_ASSET), binding.baseline.installer.sha256);
  checkSidecars(dir); return { ...proof, inputBindingSha256: hash(input) };
}
module.exports = { ...resources, hash, KIND, ASSET, BASELINE_ASSET, NAMES, CASES, FEED, BRANCH, WORKFLOW, url, binding, bindingSha256,
  STAGE_SHA256, TAG_COMMIT, validateBinding, assertAdmission, checkRelease, checkTag, publicBytes, directory, configFor, assertBound, readConfig, proofFor, loadContract, prepare };
if (require.main === module) {
  if (process.argv[2] === 'preflight') {
    validateBinding();
    console.log(JSON.stringify({ releaseId: RELEASE_ID, stageReceiptSha256: STAGE_SHA256, bindingSha256, publicDiscovery: false }));
  } else {
    assert.equal(process.argv[2], 'prepare');
    prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
