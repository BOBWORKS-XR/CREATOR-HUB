// Diagnostics only: preserves originals and reproduces linuxdeploy's ELF operation on new copies.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const [root, patchelf] = process.argv.slice(2);
if (process.platform !== 'linux' || !root || !patchelf) throw Error('Use Linux with EVIDENCE_ROOT and retained PATCHELF.');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'original/builtin-manifest.json')));
const output = path.join(root, 'elf-reproduction');
fs.mkdirSync(output);
const files = { ...manifest.modules.mcp.files, ...manifest.modules.setup.files, '@hub': null };
const rows = [];
for (const [name, bound] of Object.entries(files)) {
  const relative = name === '@hub' ? 'usr/bin/creator-hub' : `usr/lib/Creator Hub/modules/${name}`;
  const deb = path.join(root, 'evidence-deb', relative);
  const app = path.join(root, 'evidence-appimage/squashfs-root', relative);
  const before = fs.readFileSync(deb);
  const after = fs.readFileSync(app);
  if (bound && hash(before) !== bound) throw Error(`DEB is not the bound baseline: ${name}`);
  const row = { name, bound, debSha256: hash(before), appImageSha256: hash(after), debSize: before.length, appImageSize: after.length };
  if (!before.equals(after)) {
    const runpath = name === '@hub' ? '$ORIGIN/../lib' : '$ORIGIN';
    const copy = path.join(output, name === '@hub' ? 'creator-hub' : name);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    const bytes = Buffer.from(before);
    if (name === '@hub') {
      const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_DEB');
      const offset = bytes.indexOf(marker);
      if (offset < 0 || bytes.indexOf(marker, offset + 1) !== -1) throw Error('Expected the single DEB bundle marker.');
      bytes.write('APP', offset + marker.length - 3, 'ascii');
    }
    fs.writeFileSync(copy, bytes, { flag: 'wx' });
    execFileSync(patchelf, ['--set-rpath', runpath, copy]);
    const reproduced = fs.readFileSync(copy);
    row.operation = { runpath, tauriMarker: name === '@hub' ? 'DEB -> APP' : null };
    row.reproducedSha256 = hash(reproduced);
    row.exactReproduction = reproduced.equals(after);
    row.readelfBefore = execFileSync('readelf', ['-d', deb], { encoding: 'utf8' });
    row.readelfAfter = execFileSync('readelf', ['-d', app], { encoding: 'utf8' });
  }
  rows.push(row);
}
const packages = Object.fromEntries(fs.readdirSync(path.join(root, 'original/native-packages')).map(name => [name,
  hash(fs.readFileSync(path.join(root, 'original/native-packages', name)))]));
const report = { run: '38326950304', job: '115067721792', packages,
  patchelfVersion: execFileSync(patchelf, ['--version'], { encoding: 'utf8' }).trim(),
  linuxdeployToolSha256: hash(fs.readFileSync(path.join(root, 'linuxdeploy-x86_64.AppImage'))), rows };
fs.writeFileSync(path.join(root, 'elf-mutation-evidence.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify(rows.map(({ name, operation, exactReproduction }) => ({ name, operation, exactReproduction })), null, 2));
