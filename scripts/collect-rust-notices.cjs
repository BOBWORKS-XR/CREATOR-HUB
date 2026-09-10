const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const overrides = require('./license-sources.json');

function overrideLicenseFiles(pkg, root) {
  const group = overrides.groups.find(group => group.packages.some(([name, version]) => name === pkg.name && version === pkg.version));
  if (!group) return [];
  const entry = group.packages.find(([name, version]) => name === pkg.name && version === pkg.version);
  const vcs = JSON.parse(fs.readFileSync(path.join(root, '.cargo_vcs_info.json'), 'utf8'));
  if (vcs.git?.sha1 !== entry[2]) throw Error(`Upstream license revision differs for ${pkg.name}@${pkg.version}.`);
  return group.files.map(source => {
    const file = path.join(__dirname, 'license-overrides', group.id, source.name);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (hash !== source.sha256) throw Error(`Upstream license bytes changed for ${pkg.name}.`);
    return { file, name: source.name, upstream: source.url };
  });
}

function licenseFiles(root, declared) {
  const files = new Set();
  function visit(file, depth = 0) {
    if (depth > 4) throw Error('License directory nesting exceeds the limit.');
    const resolved = path.resolve(file);
    if (!resolved.startsWith(path.resolve(root) + path.sep)) throw Error('License file escapes its package.');
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) throw Error('License symlinks are not supported.');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(resolved)) visit(path.join(resolved, name), depth + 1);
    } else if (stat.isFile()) {
      if (stat.size > 2 * 1024 * 1024) throw Error('License file exceeds the size limit.');
      files.add(resolved);
    }
  }
  if (declared) visit(path.resolve(root, declared));
  for (const name of fs.readdirSync(root)) {
    if (/^(licen[sc]es?|copying|copyright|notices?|unlicen[sc]e)([._-].*)?$/i.test(name)) visit(path.join(root, name));
  }
  return [...files].sort();
}

function productionPackages(metadata) {
  if (!metadata.resolve?.root) throw Error('Cargo metadata has no single application root.');
  const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
  const seen = new Set();
  function walk(id) {
    if (seen.has(id)) return;
    seen.add(id);
    const node = nodes.get(id);
    if (!node) throw Error('Cargo dependency graph is incomplete.');
    for (const dependency of node.deps) {
      if (dependency.dep_kinds.some(kind => kind.kind !== 'dev')) walk(dependency.pkg);
    }
  }
  walk(metadata.resolve.root);
  return metadata.packages.filter(pkg => seen.has(pkg.id) && pkg.id !== metadata.resolve.root)
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

function collect(metadata, extras) {
  const notices = [];
  const inventory = [];
  const missing = [];
  for (const pkg of productionPackages(metadata)) {
    const root = path.dirname(pkg.manifest_path);
    let files = licenseFiles(root, pkg.license_file).map(file => ({ file, name: path.relative(root, file).replaceAll('\\', '/') }));
    if (!files.length) files = overrideLicenseFiles(pkg, root);
    if (!files.length) { missing.push(`${pkg.name}@${pkg.version} (${pkg.license || 'no declared license'})`); continue; }
    const item = { name: pkg.name, version: pkg.version, license: pkg.license, repository: pkg.repository, files: [] };
    notices.push(`\n=== ${pkg.name} ${pkg.version} ===\nDeclared license: ${pkg.license || 'See included license files'}\nSource: ${pkg.source?.startsWith('registry+') ? `https://crates.io/crates/${pkg.name}/${pkg.version}` : pkg.repository || 'See package source'}\n`);
    for (const { file, name, upstream } of files) {
      const bytes = fs.readFileSync(file);
      item.files.push({ name, ...(upstream && { upstream }), sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
      notices.push(`\n--- ${name} ---\n${upstream ? `Original license source: ${upstream}\n` : ''}${bytes.toString('utf8')}\n`);
    }
    inventory.push(item);
  }
  if (missing.length) throw Error(`Missing original license files; review before redistribution:\n${missing.join('\n')}`);
  for (const file of extras) notices.push(`\n=== Additional notice: ${path.basename(file)} ===\n${fs.readFileSync(file, 'utf8')}\n`);
  return { text: `Third-party license notices\nOriginal terms are retained; these dependencies are not relicensed under the app's MIT license.\n${notices.join('')}`, inventory };
}

function main() {
  const [manifest, appLicense, output, ...extras] = process.argv.slice(2);
  if (!manifest || !appLicense || !output) throw Error('Usage: node collect-rust-notices.cjs CARGO-MANIFEST APP-LICENSE OUTPUT-DIRECTORY [EXTRA-NOTICES...]');
  const result = spawnSync('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc', '--manifest-path', path.resolve(manifest)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000, windowsHide: true });
  if (result.status !== 0) throw Error(`Cargo license inventory failed: ${(result.stderr || result.error?.message || '').slice(-3000)}`);
  const data = collect(JSON.parse(result.stdout), extras);
  fs.mkdirSync(output, { recursive: true });
  fs.copyFileSync(appLicense, path.join(output, 'LICENSE.txt'));
  fs.writeFileSync(path.join(output, 'THIRD_PARTY_NOTICES.txt'), data.text);
  fs.writeFileSync(path.join(output, 'rust-dependencies.json'), `${JSON.stringify({ schemaVersion: 1, platform: 'windows-x86_64', packages: data.inventory }, null, 2)}\n`);
  process.stdout.write(`Collected original notices for ${data.inventory.length} Rust dependencies.\n`);
}

module.exports = { licenseFiles, overrideLicenseFiles, productionPackages, collect };
if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } }
