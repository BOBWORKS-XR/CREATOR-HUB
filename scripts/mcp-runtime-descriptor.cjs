// Produces deterministic signing input; unsigned metadata never authorizes routing.
const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');

function runtimeDescriptor(manifest, hubVersion) {
  if (typeof hubVersion !== 'string' || semver.valid(hubVersion) !== hubVersion || semver.parse(hubVersion).build.length) {
    throw Error('Runtime metadata requires a canonical Hub version without build metadata.');
  }
  const { moduleFiles } = require('./build-unified.cjs');
  if (manifest?.schemaVersion !== 1 || !['windows', 'linux', 'macos'].includes(manifest.platform)
    || !['x86_64', 'aarch64'].includes(manifest.arch)) throw Error('Invalid runtime native target.');
  const source = manifest.modules?.mcp;
  const expected = moduleFiles('mcp', manifest.platform).sort();
  if (!source || source.executable !== expected.find(file => file.includes('/creator-works-mcp-launcher'))
    || typeof source.version !== 'string' || semver.valid(source.version) !== source.version || !source.files
    || Object.keys(source.files).sort().join(',') !== expected.join(',')
    || Object.values(source.files).some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) {
    throw Error('Invalid or incomplete runtime module identity.');
  }
  return { schemaVersion: 1, product: 'com.creatorworks.hub.mcp-runtime', hubVersion,
    platform: manifest.platform, arch: manifest.arch,
    module: { executable: source.executable, version: source.version,
      files: Object.fromEntries(expected.map(name => [name, source.files[name]])) } };
}

function writeRuntimeDescriptor(directory, manifest, hubVersion) {
  const { verifyStage } = require('./build-unified.cjs');
  verifyStage(path.join(directory, 'modules'), manifest);
  const bytes = Buffer.from(JSON.stringify(runtimeDescriptor(manifest, hubVersion)));
  if (bytes.length > 32 * 1024) throw Error('Runtime signing input exceeds the router limit.');
  const file = path.join(directory, 'mcp-runtime.json');
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  return file;
}

module.exports = { runtimeDescriptor, writeRuntimeDescriptor };
