const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const semver = require('semver');

const applications = {
  mcp: { id: 'creator-works-mcp', repo: 'CREATOR-WORKS-UNITY-MCP' },
  setup: { id: 'creator-project-setup', repo: 'CREATOR-PROJECT-SETUP' },
  hub: { id: 'creator-hub', repo: 'CREATOR-HUB' },
};

function validVersion(version) {
  const parsed = typeof version === 'string' && semver.parse(version);
  return Boolean(parsed && parsed.version === version && !parsed.build.length);
}

function reviewReceipt(receipt, descriptor, application) {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.approvedForPrerelease !== true || !semver.prerelease(descriptor.version)) {
    throw Error('A reviewed prerelease receipt is required to change protocol claims.');
  }
  for (const key of ['appId', 'version', 'byteLength', 'sha256', 'executableSha256']) {
    if (receipt[key] !== descriptor[key]) throw Error(`Receipt does not match the exact artifact: ${key}.`);
  }
  for (const key of ['identityProtocol', 'lifecycleProtocol', 'installerProtocol']) {
    if (![0, 1].includes(receipt[key])) throw Error(`Invalid reviewed protocol: ${key}.`);
  }
  if (!validVersion(receipt.minHubVersion)) throw Error('Invalid reviewed minimum Hub version.');
  if (!Array.isArray(receipt.evidence) || receipt.evidence.length === 0 || receipt.evidence.some(url =>
    typeof url !== 'string' || !new RegExp(`^https://github\\.com/BOBWORKS-XR/${application.repo}/actions/runs/[0-9]+$`).test(url))) {
    throw Error('Receipt must identify this app\'s GitHub acceptance runs.');
  }
  if (receipt.installerProtocol === 1 && receipt.installerScope !== 'guarded-nsis-update-default-location-no-msi') {
    throw Error('Installer acceptance must explicitly scope the guarded NSIS update path.');
  }
  return Object.fromEntries(['identityProtocol', 'lifecycleProtocol', 'installerProtocol', 'minHubVersion'].map(key => [key, receipt[key]]));
}

function updaterManifest(application, version, asset, signature) {
  if (!validVersion(version) || !/^[a-zA-Z0-9._-]+\.exe$/.test(asset) || asset.includes('..')) throw Error('Invalid updater release.');
  const decoded = Buffer.from(signature, 'base64');
  if (!signature || decoded.toString('base64') !== signature || !decoded.toString('utf8').startsWith('untrusted comment:')) throw Error('Invalid updater signature.');
  return { version, notes: 'Creator Hub prerelease update.', platforms: {
    'windows-x86_64': { signature, url: `https://github.com/BOBWORKS-XR/${application.repo}/releases/download/v${version}/${asset}` },
  } };
}

async function hash(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function main() {
  const [app, version, installer, executable, output, receiptPath] = process.argv.slice(2);
  if (!Object.hasOwn(applications, app) || !validVersion(version) || !output || ![7, 8].includes(process.argv.length)) {
    throw Error('Usage: node scripts/release-descriptor.cjs mcp|setup|hub VERSION INSTALLER EXTRACTED-LAUNCHER OUTPUT-DIRECTORY [REVIEWED-RECEIPT]');
  }
  const key = process.env.CREATOR_HUB_SIGNING_KEY_PATH;
  if (!key || !path.isAbsolute(key)) throw Error('Set CREATOR_HUB_SIGNING_KEY_PATH to the private catalog key outside the repository.');
  const relativeKey = path.relative(fs.realpathSync(path.join(__dirname, '..')), fs.realpathSync(key));
  if (!relativeKey.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeKey)) throw Error('The private signing key must be outside this repository.');
  const asset = path.basename(installer);
  if (!/^[a-zA-Z0-9._-]+\.exe$/.test(asset) || asset.includes('..')) throw Error('Use the exact public installer asset filename.');
  const bytes = fs.statSync(installer).size;
  if (bytes <= 0 || bytes > 512 * 1024 * 1024) throw Error('Installer size is outside the supported range.');
  // Protocols default to legacy. Promotion requires separate native/package acceptance.
  const descriptor = {
    schemaVersion: 1, appId: applications[app].id, version, platform: 'windows', architecture: 'x86_64',
    packageType: 'nsis', assetName: asset, byteLength: bytes, sha256: await hash(installer),
    executableSha256: await hash(executable), identityProtocol: 0, lifecycleProtocol: 0,
    installerProtocol: 0, minHubVersion: '0.1.0-alpha.1',
  };
  if (receiptPath) {
    if (fs.statSync(receiptPath).size > 32 * 1024) throw Error('Receipt is too large.');
    Object.assign(descriptor, reviewReceipt(JSON.parse(fs.readFileSync(receiptPath, 'utf8').replace(/^\uFEFF/, '')), descriptor, applications[app]));
  }
  if (app === 'hub' && descriptor.installerProtocol !== 1) throw Error('Hub update publication requires reviewed native installer acceptance.');
  fs.mkdirSync(output, { recursive: true });
  const file = path.resolve(output, 'creator-hub-windows-x86_64.json');
  fs.writeFileSync(file, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: 'wx' });
  const cli = require.resolve('@tauri-apps/cli/tauri.js');
  function sign(target) {
    if (fs.existsSync(`${target}.sig`)) throw Error('Signature already exists; refusing to replace it.');
    const result = spawnSync(process.execPath, [cli, 'signer', 'sign', '-f', key, target], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
      env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.CREATOR_HUB_SIGNING_PASSWORD || '' },
    });
    if (result.status !== 0) throw Error('Signing failed. Signing output is withheld to protect key material.');
  }
  sign(file);
  const signature = Buffer.from(fs.readFileSync(`${file}.sig`, 'utf8').trim(), 'base64').toString('utf8');
  if (!signature.startsWith('untrusted comment:')) throw Error('Unexpected signature format.');
  fs.writeFileSync(`${file}.minisig`, signature, { flag: 'wx' });
  if (app === 'hub') {
    // Sign an owned copy of the exact accepted installer, never alter CI evidence.
    const staged = path.resolve(output, asset);
    fs.copyFileSync(installer, staged, fs.constants.COPYFILE_EXCL);
    sign(staged);
    const installerSignature = fs.readFileSync(`${staged}.sig`, 'utf8').trim();
    const manifest = updaterManifest(applications[app], version, asset, installerSignature);
    fs.writeFileSync(path.resolve(output, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  }
  process.stdout.write(`Created signed descriptor for ${applications[app].id} ${version}. Verify before uploading.\n`);
}
module.exports = { applications, validVersion, reviewReceipt, updaterManifest };
if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
