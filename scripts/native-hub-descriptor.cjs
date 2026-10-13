const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { validVersion, applications } = require('./release-descriptor.cjs');

const releaseVersion = '0.1.13';
const releaseLine = 'separate-apps';
const checks = Object.freeze(['discovery', 'cancelPreserves', 'installRestart', 'installedHash',
  'settingsPreserved', 'connectionsPreserved', 'companionInstallsPreserved']);

async function hash(file) {
  const digest = crypto.createHash('sha256');
  for await (const data of fs.createReadStream(file)) digest.update(data);
  return digest.digest('hex');
}

async function stageAccepted(source, destination, descriptor) {
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  if (fs.statSync(destination).size !== descriptor.byteLength || await hash(destination) !== descriptor.sha256) {
    throw Error('Native package changed while staging. Nothing was signed; retained output needs inspection.');
  }
}

function target(name) {
  const choices = {
    'macos-x86_64-app': ['macos', 'x86_64', 'app', '.app.tar.gz', 'darwin-x86_64-app'],
    'macos-aarch64-app': ['macos', 'aarch64', 'app', '.app.tar.gz', 'darwin-aarch64-app'],
    'linux-x86_64-appimage': ['linux', 'x86_64', 'appimage', '.AppImage', 'linux-x86_64-appimage'],
    'linux-x86_64-deb': ['linux', 'x86_64', 'deb', '.deb', 'linux-x86_64-deb'],
    'linux-x86_64-rpm': ['linux', 'x86_64', 'rpm', '.rpm', 'linux-x86_64-rpm'],
  };
  if (!Object.hasOwn(choices, name)) throw Error('Unsupported native Hub update target.');
  const [platform, architecture, packageType, extension, updaterKey] = choices[name];
  return Object.freeze({ platform, architecture, packageType, extension, updaterKey,
    descriptor: `creator-hub-${platform}-${architecture}${platform === 'linux' ? `-${packageType}` : ''}.json`,
    scope: `native-${name}-signed-update-restart`,
  });
}

function validateTarget(selected) {
  const expected = target(`${selected?.platform}-${selected?.architecture}-${selected?.packageType}`);
  for (const field of Object.keys(expected)) {
    if (selected[field] !== expected[field]) throw Error(`Invalid native Hub target: ${field}.`);
  }
}

function validAsset(asset, selected) {
  return typeof asset === 'string' && asset.length <= 160 && asset.endsWith(selected.extension)
    && /^[a-zA-Z0-9._-]+$/.test(asset) && !asset.includes('..');
}

function validateDescriptor(descriptor, selected) {
  validateTarget(selected);
  if (descriptor?.schemaVersion !== 1 || descriptor.appId !== applications.hub.id
    || descriptor.version !== releaseVersion || descriptor.platform !== selected.platform
    || descriptor.architecture !== selected.architecture || descriptor.packageType !== selected.packageType) {
    throw Error('Native descriptor must identify Creator Hub 0.1.13 and the exact platform, architecture and package.');
  }
  if (!validAsset(descriptor.assetName, selected) || !Number.isSafeInteger(descriptor.byteLength)
    || descriptor.byteLength <= 0 || descriptor.byteLength > 512 * 1024 * 1024
    || !/^[a-f0-9]{64}$/.test(descriptor.sha256 || '') || !/^[a-f0-9]{64}$/.test(descriptor.executableSha256 || '')) {
    throw Error('Invalid native Hub artifact identity.');
  }
}

function review(receipt, descriptor, selected) {
  validateDescriptor(descriptor, selected);
  if (receipt?.schemaVersion !== 1 || receipt.releaseLine !== releaseLine
    || receipt.approvedForStable !== true || receipt.installerProtocol !== 1 || receipt.installerScope !== selected.scope) {
    throw Error('Exact reviewed 0.1.13 separate-app native signed-update/restart acceptance is required. Package integrity, unified and Windows NSIS receipts cannot authorize native packages.');
  }
  for (const field of ['appId', 'version', 'platform', 'architecture', 'packageType', 'byteLength', 'sha256', 'executableSha256']) {
    if (receipt[field] !== descriptor[field]) throw Error(`Native acceptance does not match the exact artifact: ${field}.`);
  }
  if (!validVersion(receipt.minHubVersion) || ![0, 1].includes(receipt.identityProtocol)
    || ![0, 1].includes(receipt.lifecycleProtocol)) throw Error('Invalid native protocol receipt.');
  for (const check of checks) {
    if (receipt.checks?.[check] !== true) throw Error(`Native acceptance is incomplete: ${check}.`);
  }
  if (!Array.isArray(receipt.evidence) || !receipt.evidence.length || receipt.evidence.some(url =>
    typeof url !== 'string' || !/^https:\/\/github\.com\/BOBWORKS-XR\/CREATOR-HUB\/actions\/runs\/[0-9]+$/.test(url))) {
    throw Error('Native acceptance must identify the Hub acceptance runs.');
  }
  // Keep the signed schema unchanged; line admission is bound to the receipt and exact hashes.
  return Object.fromEntries(['identityProtocol', 'lifecycleProtocol', 'installerProtocol', 'minHubVersion'].map(key => [key, receipt[key]]));
}

function updater(version, asset, signature, selected) {
  validateTarget(selected);
  const decoded = typeof signature === 'string' ? Buffer.from(signature, 'base64') : Buffer.alloc(0);
  if (version !== releaseVersion || !validAsset(asset, selected) || !signature
    || decoded.toString('base64') !== signature || !decoded.toString('utf8').startsWith('untrusted comment:')) {
    throw Error('Invalid 0.1.13 native updater artifact or signature.');
  }
  return { version, notes: 'Creator Hub update.', platforms: { [selected.updaterKey]: {
    signature, url: `https://github.com/BOBWORKS-XR/${applications.hub.repo}/releases/download/v${version}/${asset}`,
  } } };
}

async function prepareDescriptor(name, version, packageFile, executable, receiptFile) {
  if (version !== releaseVersion) throw Error('This producer accepts only the 0.1.13 separate-app release.');
  const selected = target(name);
  const descriptor = { schemaVersion: 1, appId: applications.hub.id, version,
    platform: selected.platform, architecture: selected.architecture, packageType: selected.packageType,
    assetName: path.basename(packageFile), byteLength: fs.statSync(packageFile).size,
    sha256: await hash(packageFile), executableSha256: await hash(executable) };
  if (fs.statSync(receiptFile).size > 32768) throw Error('Native acceptance receipt is too large.');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8').replace(/^\uFEFF/, ''));
  Object.assign(descriptor, review(receipt, descriptor, selected));
  return { selected, descriptor };
}

function detachedSigner() {
  const key = process.env.CREATOR_HUB_SIGNING_KEY_PATH;
  if (!key || !path.isAbsolute(key)) throw Error('Set CREATOR_HUB_SIGNING_KEY_PATH to the private catalog key outside the repository.');
  const relativeKey = path.relative(fs.realpathSync(path.join(__dirname, '..')), fs.realpathSync(key));
  if (!relativeKey.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeKey)) throw Error('The private signing key must be outside this repository.');
  const cli = require.resolve('@tauri-apps/cli/tauri.js');
  return file => {
    if (fs.existsSync(`${file}.sig`)) throw Error('Signature already exists; refusing to replace it.');
    const result = spawnSync(process.execPath, [cli, 'signer', 'sign', '-f', key, file], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
      env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.CREATOR_HUB_SIGNING_PASSWORD || '' },
    });
    if (result.status !== 0) throw Error('Signing failed. Signing output is withheld to protect key material.');
    const signature = fs.readFileSync(`${file}.sig`, 'utf8').trim();
    const decoded = Buffer.from(signature, 'base64');
    if (decoded.toString('base64') !== signature || !decoded.toString('utf8').startsWith('untrusted comment:')) {
      throw Error('Unexpected signature format.');
    }
    return { encoded: signature, detached: decoded.toString('utf8') };
  };
}

async function main() {
  const [name, version, packageFile, executable, output, receiptFile] = process.argv.slice(2);
  if (process.argv.length !== 8 || !receiptFile) {
    throw Error('Usage: native-hub-descriptor.cjs TARGET 0.1.13 PACKAGE EXACT-INSTALLED-EXE OUTPUT REVIEWED-RECEIPT');
  }
  const { selected, descriptor } = await prepareDescriptor(name, version, packageFile, executable, receiptFile);
  // Key access is CLI-only and follows receipt validation; unit tests never instantiate this signer.
  const sign = detachedSigner();
  fs.mkdirSync(output, { recursive: true });
  const staged = path.resolve(output, descriptor.assetName);
  await stageAccepted(packageFile, staged, descriptor);
  const file = path.resolve(output, selected.descriptor);
  fs.writeFileSync(file, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: 'wx' });
  fs.writeFileSync(`${file}.minisig`, sign(file).detached, { flag: 'wx' });
  const manifest = updater(version, descriptor.assetName, sign(staged).encoded, selected);
  fs.writeFileSync(path.resolve(output, `latest-${name}.json`), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(`Created immutable signed ${name} inputs for the 0.1.13 separate-app release. Nothing was published; merge native entries only after exact acceptance.`);
}

module.exports = { target, review, updater, stageAccepted, prepareDescriptor };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
