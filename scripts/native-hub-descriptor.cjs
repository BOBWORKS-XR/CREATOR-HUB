const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const semver = require('semver');
const { validVersion, applications } = require('./release-descriptor.cjs');
const { signingKey, signDetached } = require('./managed-router-package.cjs');

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
  return { platform, architecture, packageType, extension, updaterKey,
    descriptor: `creator-hub-${platform}-${architecture}${platform === 'linux' ? `-${packageType}` : ''}.json`,
    scope: `native-${name}-signed-update-restart`,
  };
}

function review(receipt, descriptor, selected) {
  const approval = semver.prerelease(descriptor.version) ? 'approvedForPrerelease' : 'approvedForStable';
  if (!validVersion(descriptor.version) || receipt?.schemaVersion !== 1 || receipt[approval] !== true || receipt.installerProtocol !== 1 || receipt.installerScope !== selected.scope) {
    throw Error('Exact reviewed native signed-update/restart acceptance is required. Windows NSIS receipts cannot authorize native packages.');
  }
  for (const field of ['appId', 'version', 'platform', 'architecture', 'packageType', 'byteLength', 'sha256', 'executableSha256']) {
    if (receipt[field] !== descriptor[field]) throw Error(`Native acceptance does not match the exact artifact: ${field}.`);
  }
  if (!validVersion(receipt.minHubVersion) || ![0, 1].includes(receipt.identityProtocol) || ![0, 1].includes(receipt.lifecycleProtocol)) throw Error('Invalid native protocol receipt.');
  for (const check of ['discovery', 'cancelPreserves', 'installRestart', 'installedHash', 'settingsPreserved', 'connectionsPreserved']) {
    if (receipt.checks?.[check] !== true) throw Error(`Native acceptance is incomplete: ${check}.`);
  }
  if (!Array.isArray(receipt.evidence) || !receipt.evidence.length || receipt.evidence.some(url => typeof url !== 'string' || !/^https:\/\/github\.com\/BOBWORKS-XR\/CREATOR-HUB\/actions\/runs\/[0-9]+$/.test(url))) throw Error('Native acceptance must identify the Hub acceptance runs.');
  return Object.fromEntries(['identityProtocol', 'lifecycleProtocol', 'installerProtocol', 'minHubVersion'].map(key => [key, receipt[key]]));
}

function updater(version, asset, signature, selected) {
  const decoded = Buffer.from(signature, 'base64');
  if (!validVersion(version) || !asset.endsWith(selected.extension) || !/^[a-zA-Z0-9._-]+$/.test(asset) || asset.includes('..') || decoded.toString('base64') !== signature || !decoded.toString('utf8').startsWith('untrusted comment:')) throw Error('Invalid native updater artifact or signature.');
  return { version, notes: 'Creator Hub update.', platforms: { [selected.updaterKey]: { signature, url: `https://github.com/BOBWORKS-XR/${applications.hub.repo}/releases/download/v${version}/${asset}` } } };
}

async function main() {
  const [name, version, packageFile, executable, output, receiptFile] = process.argv.slice(2);
  if (!receiptFile || process.argv.length !== 8 || !validVersion(version)) throw Error('Usage: native-hub-descriptor.cjs TARGET VERSION PACKAGE EXACT-INSTALLED-EXE OUTPUT REVIEWED-RECEIPT');
  const selected = target(name);
  const asset = path.basename(packageFile);
  if (!asset.endsWith(selected.extension) || !/^[a-zA-Z0-9._-]+$/.test(asset) || asset.includes('..')) throw Error('Use the exact public native package asset name.');
  const byteLength = fs.statSync(packageFile).size;
  if (byteLength <= 0 || byteLength > 512 * 1024 * 1024) throw Error('Native package is outside the supported size range.');
  const descriptor = { schemaVersion: 1, appId: 'creator-hub', version,
    platform: selected.platform, architecture: selected.architecture, packageType: selected.packageType,
    assetName: asset, byteLength, sha256: await hash(packageFile), executableSha256: await hash(executable) };
  if (fs.statSync(receiptFile).size > 32768) throw Error('Native acceptance receipt is too large.');
  Object.assign(descriptor, review(JSON.parse(fs.readFileSync(receiptFile, 'utf8').replace(/^\uFEFF/, '')), descriptor, selected));
  const key = signingKey(path.resolve(__dirname, '..'));
  fs.mkdirSync(output, { recursive: true });
  const staged = path.resolve(output, asset);
  await stageAccepted(packageFile, staged, descriptor);
  const file = path.resolve(output, selected.descriptor);
  fs.writeFileSync(file, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: 'wx' });
  fs.writeFileSync(`${file}.minisig`, signDetached(file, key), { flag: 'wx' });
  signDetached(staged, key);
  const manifest = updater(version, asset, fs.readFileSync(`${staged}.sig`, 'utf8').trim(), selected);
  fs.writeFileSync(path.resolve(output, `latest-${name}.json`), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(`Created immutable signed ${name} update inputs. Merge platform entries only after exact native acceptance; do not replace published files.`);
}

module.exports = { target, review, updater, stageAccepted };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
