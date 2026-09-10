const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

async function hash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function main() {
  const [app, version, installer, executable, output] = process.argv.slice(2);
  const ids = { mcp: 'creator-works-mcp', setup: 'creator-project-setup' };
  if (!Object.hasOwn(ids, app) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version || '') || !output || process.argv.length !== 7) {
    throw Error('Usage: node scripts/release-descriptor.cjs mcp|setup VERSION INSTALLER EXTRACTED-LAUNCHER OUTPUT-DIRECTORY');
  }
  const key = process.env.CREATOR_HUB_SIGNING_KEY_PATH;
  if (!key || !path.isAbsolute(key)) throw Error('Set CREATOR_HUB_SIGNING_KEY_PATH to the private catalog key outside the repository.');
  const asset = path.basename(installer);
  if (!/^[a-zA-Z0-9._-]+\.exe$/.test(asset) || asset.includes('..')) throw Error('Use the exact public installer asset filename.');
  const bytes = fs.statSync(installer).size;
  if (bytes <= 0 || bytes > 512 * 1024 * 1024) throw Error('Installer size is outside the supported range.');
  // Protocols default to legacy. Promotion requires separate native/package acceptance.
  const descriptor = {
    schemaVersion: 1, appId: ids[app], version, platform: 'windows', architecture: 'x86_64',
    packageType: 'nsis', assetName: asset, byteLength: bytes, sha256: await hash(installer),
    executableSha256: await hash(executable), identityProtocol: 0, lifecycleProtocol: 0,
    installerProtocol: 0, minHubVersion: '0.1.0-alpha.1',
  };
  fs.mkdirSync(output, { recursive: true });
  const file = path.resolve(output, 'creator-hub-windows-x86_64.json');
  fs.writeFileSync(file, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: 'wx' });
  const cli = require.resolve('@tauri-apps/cli/tauri.js');
  const result = spawnSync(process.execPath, [cli, 'signer', 'sign', '-f', key, file], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.CREATOR_HUB_SIGNING_PASSWORD || '' },
  });
  if (result.status !== 0) throw Error('Descriptor signing failed. Signing output is withheld to protect key material.');
  const signature = Buffer.from(fs.readFileSync(`${file}.sig`, 'utf8').trim(), 'base64').toString('utf8');
  if (!signature.startsWith('untrusted comment:')) throw Error('Unexpected signature format.');
  fs.writeFileSync(`${file}.minisig`, signature, { flag: 'wx' });
  process.stdout.write(`Created signed descriptor for ${ids[app]} ${version}. Verify before uploading.\n`);
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
