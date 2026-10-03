const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function relativeFile(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_./-]+$/.test(name)
    && !name.startsWith('/') && !name.split('/').some(part => ['', '.', '..'].includes(part));
}
function verifyStage(directory, manifest) {
  if (manifest.schemaVersion !== 1 || !['windows', 'linux', 'macos'].includes(manifest.platform)
    || !['x86_64', 'aarch64'].includes(manifest.arch)
    || Object.keys(manifest.modules || {}).sort().join(',') !== 'mcp,setup') throw Error('Invalid built-in manifest.');
  for (const [id, entry] of Object.entries(manifest.modules)) {
    if (!relativeFile(entry.executable) || !entry.executable.startsWith(`${id}/`)
      || !Object.hasOwn(entry.files, entry.executable)) throw Error('Invalid module executable.');
    for (const [name, hash] of Object.entries(entry.files)) {
      if (!relativeFile(name) || !name.startsWith(`${id}/`) || !/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid module file.');
      const file = path.join(directory, name);
      if (fs.lstatSync(file).isSymbolicLink() || sha256(file) !== hash) throw Error(`Bundled module changed: ${name}`);
    }
  }
}
function build(label) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(label || '')) throw Error('Provide a unique, simple build name.');
  const platform = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
  if (!platform || !arch || (platform !== 'macos' && arch !== 'x86_64')) throw Error('Unsupported native build host.');
  if (platform !== 'windows') throw Error('Unified native hosting is currently a Windows candidate only. Cross-platform hosting acceptance is still required.');
  const output = path.join(root, 'artifacts', 'unified', label);
  if (fs.existsSync(output)) throw Error('Build output exists. Use a new name; artifacts are immutable.');
  const npm = process.env.npm_execpath;
  if (!npm || !fs.existsSync(npm)) throw Error('Run this builder through npm run build:unified.');
  fs.mkdirSync(output, { recursive: true });
  const run = (args, cwd, env = process.env) => execFileSync(process.execPath, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  run([npm, 'run', 'release:launcher'], path.join(root, 'modules/mcp'));
  const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
  const extension = platform === 'windows' ? '.exe' : '';
  const manifest = { schemaVersion: 1, platform, arch, modules: {} };
  const resources = {};
  for (const [id, source, binary] of [
    ['mcp', 'modules/mcp/launcher', 'creator-works-mcp-launcher'],
    ['setup', 'modules/project-setup', 'creator-project-setup'],
  ]) {
    const cwd = path.join(root, source);
    const target = path.resolve(process.env[`CREATOR_${id.toUpperCase()}_TARGET_DIR`] || path.join(cwd, 'src-tauri/target'));
    const env = { ...process.env, CARGO_TARGET_DIR: target, CREATOR_HUB_INTERNAL_MODULE: '1' };
    run([cli, 'build', '--no-bundle', '--', '--locked'], cwd, env);
    const files = {};
    const copy = (sourceFile, name) => {
      const dest = path.join(output, 'modules', name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(sourceFile, dest, fs.constants.COPYFILE_EXCL);
      if (platform !== 'windows' && (name.endsWith(binary) || name.endsWith('/runtime/node'))) fs.chmodSync(dest, 0o755);
      if (platform === 'macos' && (name.endsWith(binary) || name.endsWith('/runtime/node'))) {
        execFileSync('codesign', ['--force', '--sign', '-', dest], { stdio: 'inherit' });
      }
      files[name] = sha256(dest);
      resources[dest] = `modules/${name}`;
    };
    const executable = `${id}/${binary}${extension}`;
    copy(path.join(target, 'release', binary + extension), executable);
    if (id === 'mcp') {
      const mcp = path.join(root, 'modules/mcp');
      for (const [sourceFile, name] of [
        ['release/creator-works-mcp.mjs', 'creator-works-mcp.mjs'],
        [`release/runtime/node${extension}`, `runtime/node${extension}`],
        ['release/runtime/LICENSE', 'runtime/LICENSE'], ['release/runtime/VERSION', 'runtime/VERSION'],
        ['unity-extension/Editor/BanterMCPBridge.cs', 'unity-extension/Editor/BanterMCPBridge.cs'],
        ['unity-extension/Editor/CreatorWorksMCPLogo.png', 'unity-extension/Editor/CreatorWorksMCPLogo.png'],
        ['LICENSE', 'LICENSE'], ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
      ]) copy(path.join(mcp, sourceFile), `mcp/server/${name}`);
    }
    const version = JSON.parse(fs.readFileSync(path.join(cwd, 'src-tauri/tauri.conf.json'))).version;
    manifest.modules[id] = { executable, version, files };
  }
  verifyStage(path.join(output, 'modules'), manifest);
  const descriptor = path.join(output, 'builtin-manifest.json');
  fs.writeFileSync(descriptor, JSON.stringify(manifest, null, 2));
  const overlay = path.join(output, 'tauri-unified.json');
  fs.writeFileSync(overlay, JSON.stringify({ bundle: { resources } }, null, 2));
  const env = { ...process.env, CREATOR_BUILTIN_MANIFEST: descriptor,
    CREATOR_MCP_HOST_WRITABLE: platform === 'windows' ? '1' : '0', CREATOR_MCP_HOST_READONLY_EVENTS: '1',
    CARGO_TARGET_DIR: path.resolve(process.env.CARGO_TARGET_DIR || path.join(root, 'src-tauri/target')) };
  run([cli, 'build', '--no-bundle', '--config', overlay, '--', '--locked'], root, env);
  fs.copyFileSync(path.join(env.CARGO_TARGET_DIR, 'release', `creator-hub${extension}`), path.join(output, `creator-hub${extension}`));
  console.log(`Local unified candidate: ${output}. Not a release or migration acceptance.`);
  return output;
}
module.exports = { relativeFile, verifyStage, build };
if (require.main === module) {
  try { if (process.argv.length !== 3) throw Error('Provide one build name.'); build(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
