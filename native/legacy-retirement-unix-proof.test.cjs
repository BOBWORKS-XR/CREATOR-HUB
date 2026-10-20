'use strict';

// Evidence-format regressions only. No legacy process, installation or cleanup.
const test = require('node:test');
const assert = require('node:assert/strict');
const proof = require('../docs/evidence/legacy-unix-public-package-pins-014.json');

const packages = new Map(proof.packages.map(row => [row.asset, row]));
const sha256 = /^[0-9a-f]{64}$/;
const serverNames = [
  'LICENSE', 'THIRD_PARTY_NOTICES.md', 'creator-works-mcp.mjs',
  'runtime/LICENSE', 'runtime/VERSION', 'runtime/node', 'runtime/node.exe',
  'unity-extension/Editor/BanterMCPBridge.cs',
  'unity-extension/Editor/CreatorWorksMCPLogo.png',
].sort();

function member(pkg, suffix) {
  const rows = pkg.members.filter(row => row.member.endsWith(`/${suffix}`));
  assert.equal(rows.length, 1, `${pkg.asset}: exact single ${suffix}`);
  return rows[0];
}

test('passive package proof cannot be confused with native acceptance', () => {
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.nativeAcceptance, false);
  assert.match(proof.purpose, /not discovery, retirement authority/);
  assert.deepEqual(Object.keys(proof).sort(), [
    'schemaVersion', 'purpose', 'nativeAcceptance', 'capturedAt',
    'extraction', 'sources', 'packages',
  ].sort());
  assert.equal(packages.size, 10);
  assert.equal(proof.packages.length, 10);
});

test('exact published package digests stay format-specific', () => {
  const expected = [
    ['Creator.Works.MCP-2.7.7-1.x86_64.rpm', 96657620, '9217fbdfd814d168b2b501bf6bb82661dfcf0482b95b4a67b285d29391dcfa75'],
    ['Creator.Works.MCP_2.7.7_aarch64.dmg', 83146047, 'e4e8ac91938cc32f53c8390003ad6eed0d577d46931083c3182d87df66e5ba78'],
    ['Creator.Works.MCP_2.7.7_amd64.AppImage', 126319096, '75829fe6def919eb5ff9cc9560d4211e86d316069dfa3c6fc652df3c8fbb09de'],
    ['Creator.Works.MCP_2.7.7_amd64.deb', 96666824, 'db47aed5f5acd4e00e8e0782361444de228c4181eeea4970f90116f1f16cf10b'],
    ['Creator.Works.MCP_2.7.7_x64.dmg', 85872792, 'ef6efca28df84da4f5ea01f4bcee24e8ae77964d84b65c3b9a808fbdb755a79e'],
    ['Creator.Project.Setup-0.3.7-1.x86_64.rpm', 5966708, 'f1842a30b18e2e7505b4707b5c49ca41485e8d53f728fa715a5ad46fcbd0e853'],
    ['Creator.Project.Setup_0.3.7_aarch64.dmg', 4424902, 'addb89d072b65ea8def467c9ee35382103b922b40490b8394a1fdb19c841c3d6'],
    ['Creator.Project.Setup_0.3.7_amd64.AppImage', 85748216, '9a9af495d4809784c2b2edb718426f414956338136a72cdea90a069182f25ee5'],
    ['Creator.Project.Setup_0.3.7_amd64.deb', 5966970, 'be18f23450146e71a2960e2110474f6e0409a9521a3ced308b7fd6a6d584c63d'],
    ['Creator.Project.Setup_0.3.7_x64.dmg', 4691680, 'd7b131c74c2187ee0f4ccb24bf3a73df1f600e3c3785d0cc2f30044302a96a7a'],
  ];
  for (const [asset, bytes, hash] of expected) {
    const pkg = packages.get(asset);
    assert.equal(pkg.packageBytes, bytes);
    assert.equal(pkg.packageSha256, hash);
    assert.equal(new URL(pkg.packageUrl).hostname, 'github.com');
    assert.equal(decodeURIComponent(new URL(pkg.packageUrl).pathname).split('/').at(-1), asset);
    assert.equal(pkg.targetCommit, pkg.product === 'mcp'
      ? '9cd12e28d1dd05057b84166d4718a5d6369eff93'
      : '4a76945272560f9e0d2b93296a5223bf3e891eb2');
  }
});

test('member pins are bounded archive evidence, never absolute install paths', () => {
  assert.equal(proof.packages.reduce((count, pkg) => count + pkg.members.length, 0), 79);
  for (const pkg of packages.values()) {
    assert.equal(new Set(pkg.members.map(row => row.member)).size, pkg.members.length);
    for (const row of [...pkg.members, ...pkg.control]) {
      assert(!row.member.startsWith('/'));
      assert(!row.member.includes('\\'));
      assert(!row.member.split('/').includes('..'));
      assert(Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes < 128 * 1024 * 1024);
      if (row.symbolicLink) {
        assert(pkg.asset.endsWith('.AppImage'));
        assert.equal(row.sha256, undefined);
        assert.match(row.symbolicLink, /^usr\/share\/applications\/[^/]+\.desktop$/);
      } else {
        assert.match(row.sha256, sha256);
      }
    }
  }
});

test('all five MCP formats retain nine independently pinned resource names', () => {
  for (const pkg of packages.values()) {
    const server = pkg.members.filter(row => row.member.includes('/server/'));
    assert.equal(server.length, pkg.product === 'mcp' ? 9 : 0);
    if (pkg.product !== 'mcp') continue;
    assert.deepEqual(server.map(row => row.member.split('/server/')[1]).sort(), serverNames);
    const bundle = member(pkg, 'server/creator-works-mcp.mjs');
    assert.equal(bundle.bytes, 1221209);
    assert.equal(bundle.sha256, '8d7cbe21d3b3691d6b1aa052846d6ee36f4274c18bd4228c6d4a73583be74149');
    const node = member(pkg, 'server/runtime/node');
    const alias = member(pkg, 'server/runtime/node.exe');
    assert.equal(alias.bytes, node.bytes);
    assert.equal(alias.sha256, node.sha256);
  }
});

test('complete Mac bundle surfaces are pinned without runtime removal authority', () => {
  for (const pkg of packages.values()) {
    if (!pkg.asset.endsWith('.dmg')) continue;
    const product = pkg.product === 'mcp' ? 'Creator Works MCP' : 'Creator Project Setup';
    assert.equal(pkg.members.length, pkg.product === 'mcp' ? 13 : 4);
    const prefix = `${product}/${product}.app/Contents/`;
    assert(pkg.members.every(row => row.member.startsWith(prefix)));
    for (const suffix of ['Info.plist', '_CodeSignature/CodeResources', 'Resources/icon.icns']) {
      member(pkg, suffix);
    }
    member(pkg, `MacOS/${pkg.product === 'mcp' ? 'creator-works-mcp-launcher' : 'creator-project-setup'}`);
  }
});

test('same-size Setup DEB and RPM GUIs are not interchangeable', () => {
  const deb = member(packages.get('Creator.Project.Setup_0.3.7_amd64.deb'), 'creator-project-setup');
  const rpm = member(packages.get('Creator.Project.Setup-0.3.7-1.x86_64.rpm'), 'creator-project-setup');
  assert.equal(deb.bytes, rpm.bytes);
  assert.notEqual(deb.sha256, rpm.sha256);
  assert.equal(deb.sha256, 'f9c3a25c062b68cafed0c46b762532bed72127635015587324119a02d63b2944');
  assert.equal(rpm.sha256, '56e0bc61cbadba67c991b4c65521c8af9da096723838c85de187aa71741394d1');
});

test('MCP AppImage does not inherit DEB/RPM executable pins', () => {
  const image = packages.get('Creator.Works.MCP_2.7.7_amd64.AppImage');
  const deb = packages.get('Creator.Works.MCP_2.7.7_amd64.deb');
  const rpm = packages.get('Creator.Works.MCP-2.7.7-1.x86_64.rpm');
  for (const suffix of ['creator-works-mcp-launcher', 'server/runtime/node']) {
    assert.equal(member(deb, suffix).sha256, member(rpm, suffix).sha256);
    assert.notEqual(member(image, suffix).sha256, member(deb, suffix).sha256);
  }
  assert.equal(image.members.find(row => row.symbolicLink).symbolicLink,
    'usr/share/applications/Creator Works MCP.desktop');
});

test('DEB control capture contains no invented removal-retention script', () => {
  for (const pkg of packages.values()) {
    if (pkg.asset.endsWith('.deb')) {
      assert.deepEqual(pkg.control.map(row => row.member).sort(), ['control', 'md5sums']);
    } else {
      assert.deepEqual(pkg.control, []);
    }
  }
});
