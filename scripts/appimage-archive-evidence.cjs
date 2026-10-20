// Repackages only retained, hash-verified raw resources; no client/app installation.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const archive = require('./module-archive.cjs');
const unix = require('./unix-package-payload.cjs');
const [root, decoder] = process.argv.slice(2);
if (process.platform !== 'linux' || !root || !decoder) throw Error('Use Linux with EVIDENCE_ROOT and the shared native DECODER.');
const original = JSON.parse(fs.readFileSync(path.join(root, 'original/builtin-manifest.json')));
const manifest = structuredClone(original);
const source = path.join(root, 'evidence-deb/usr/lib/Creator Hub/modules');
const expected = unix.verifyResources(source, original);
const native = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-appimage-raw-pipe-'));
const raw = path.join(native, 'raw');
const destination = path.join(root, 'archive-pipe');
fs.mkdirSync(destination);
for (const name of Object.keys(expected)) {
  const file = path.join(raw, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fs.readFileSync(path.join(source, name)), { mode: archive.modeFor(manifest, name), flag: 'wx' });
}
const file = path.join(destination, archive.FILE);
manifest.payloadArchive = archive.create(raw, manifest, file);
const hashes = archive.verify(file, manifest, decoder);
const decoded = path.join(native, 'decoded');
execFileSync(decoder, ['extract', file, decoded], { input: JSON.stringify(manifest), maxBuffer: 65536 });
const restored = unix.verifyResources(decoded, manifest);
const nodeVersion = execFileSync(path.join(decoded, 'mcp/server/runtime/node'), ['--version'], { encoding: 'utf8' }).trim();
const report = { sourceRun: '38326950304', sourceJob: '115067721792', nativeFixture: native,
  archive: manifest.payloadArchive, files: hashes, restored, privateNodeVersion: nodeVersion,
  rawModuleMapUnchanged: JSON.stringify(original.modules) === JSON.stringify(manifest.modules),
  experimental: true, writableGuiAccepted: false, releaseReady: false,
  packageAcceptance: false, note: 'Native archive/decoder pipe of exact DEB raw files, not a newly built AppImage.' };
fs.writeFileSync(path.join(destination, 'bound-archive-manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
fs.writeFileSync(path.join(destination, 'native-archive-pipe.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ verifiedFiles: Object.keys(hashes).length, privateNodeVersion: nodeVersion,
  rawModuleMapUnchanged: report.rawModuleMapUnchanged, archiveSha256: manifest.payloadArchive.sha256, nativeFixture: native, packageAcceptance: false }));
