'use strict';
// Isolated offline recipe + native DEB overlay. No installation or signing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const NATIVE = path.join(ROOT, 'native/flatpak-native-activation');
const ID = 'com.creatorworks.hub', NAME = `${ID}.Host`, COMMAND = 'creator-hub-flatpak-activate';
const SERVICE = `usr/share/dbus-1/services/${NAME}.service`;
const PERMISSIONS = ['--socket=wayland', '--socket=fallback-x11', `--talk-name=${NAME}`];
const ACCEPTANCE = Object.freeze({ nativeHelperInstalled: false, nativeRootWiringAccepted: false,
  flatpakActivationAccepted: false, settingsPreserved: false, signedUpdateAccepted: false,
  restartAccepted: false, steamDeckAccepted: false, releaseReady: false });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function read(file, max = 1024 * 1024) {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file);
  for(let p=file;;p=path.dirname(p)) { assert.equal(fs.lstatSync(p).isSymbolicLink(),false); if(p===path.dirname(p))break; }
  const before=fs.statSync(file);assert.ok(before.isFile()&&before.nlink===1&&before.size>0&&before.size<=max);
  const fd=fs.openSync(file,'r');
  try {
    const opened=fs.fstatSync(fd);for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(opened[key],before[key]);
    const bytes=Buffer.alloc(before.size+1);let length=0,count;
    while(length<bytes.length&&(count=fs.readSync(fd,bytes,length,bytes.length-length,null))>0)length+=count;
    for(const info of [fs.fstatSync(fd),fs.statSync(file)])for(const key of ['dev','ino','size','mtimeMs','ctimeMs'])assert.equal(info[key],before[key]);
    assert.equal(length,before.size);return bytes.subarray(0,length);
  }finally{fs.closeSync(fd);}
}
function version() {
  const toml=read(path.join(NATIVE,'Cargo.toml')).toString('utf8');
  const match=toml.match(/^version = "([0-9]+\.[0-9]+\.[0-9]+)"$/m);assert.ok(match,'Fixed release version required');
  assert.equal(match[1],JSON.parse(read(path.join(ROOT,'package.json'))).version,'Native launcher must match the intended Hub source version');
  return match[1];
}
function service() {
  const bytes=read(path.join(NATIVE,`${NAME}.service`),4096);
  assert.equal(bytes.toString('utf8'),`[D-BUS Service]\nName=${NAME}\nExec=/usr/bin/creator-hub --flatpak-activate\n`);
  return bytes;
}
function recipe() {
  return {'app-id':ID,branch:'native-activation-test',runtime:'org.gnome.Platform','runtime-version':'50',sdk:'org.gnome.Sdk',
    command:COMMAND,'appstream-compose':false,'build-options':{strip:false,'no-debuginfo':true},'finish-args':[...PERMISSIONS],
    modules:[{name:'creator-hub-native-window-launcher',buildsystem:'simple',sources:[{type:'dir',path:'flatpak-input'}],
      'build-commands':[`install -Dm755 bin/${COMMAND} /app/bin/${COMMAND}`,
        ...[`share/applications/${ID}.desktop`,`share/icons/hicolor/128x128/apps/${ID}.png`,`share/appdata/${ID}.appdata.xml`,`share/licenses/${ID}/LICENSE`]
          .map(file=>`install -Dm644 ${file} /app/${file}`)]}]};
}
function metainfo(v) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<component type="desktop-application">\n  <id>${ID}</id>\n  <metadata_license>CC0-1.0</metadata_license>\n  <project_license>MIT</project_license>\n  <name>Creator Hub</name>\n  <summary>Launch native Creator Hub on supported DEB hosts</summary>\n  <description><p>This Flatpak is a launcher. Creator Hub runs outside its sandbox using host settings. A separately installed, signature-verified native Creator Hub DEB is required. This path does not support RPM, AppImage or SteamOS host installation.</p></description>\n  <launchable type="desktop-id">${ID}.desktop</launchable>\n  <url type="homepage">https://github.com/BOBWORKS-XR/CREATOR-HUB</url>\n  <releases><release version="${v}"/></releases>\n</component>\n`;
}
function prepare(launcher,pins,destination) {
  assert.deepEqual(Object.keys(pins).sort(),['launcherSha256','launcherSize','schemaVersion','sourceCommit','sourceTree','version']);
  const v=version();assert.equal(pins.schemaVersion,1);assert.equal(pins.version,v);
  for(const key of ['sourceCommit','sourceTree'])assert.match(pins[key],/^[a-f0-9]{40}$/);
  assert.match(pins.launcherSha256,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(pins.launcherSize)&&pins.launcherSize>=64&&pins.launcherSize<=64*1024*1024);
  const elf=read(launcher,64*1024*1024);assert.equal(elf.length,pins.launcherSize);assert.equal(hash(elf),pins.launcherSha256);
  assert.ok(elf.subarray(0,7).equals(Buffer.from([127,69,76,70,2,1,1]))&&elf.readUInt16LE(18)===62,'Linux x86_64 launcher ELF only');
  assert.ok([2,3].includes(elf.readUInt16LE(16)),'Executable launcher required');
  const hostService=service();
  const files={
    [`flatpak-input/bin/${COMMAND}`]:elf,
    [`flatpak-input/share/applications/${ID}.desktop`]:Buffer.from(`[Desktop Entry]\nType=Application\nName=Creator Hub\nComment=Starts native Hub outside the Flatpak sandbox; DEB host required\nExec=${COMMAND}\nIcon=${ID}\nTerminal=false\nCategories=Development;\n`),
    [`flatpak-input/share/appdata/${ID}.appdata.xml`]:Buffer.from(metainfo(v)),
    [`flatpak-input/share/icons/hicolor/128x128/apps/${ID}.png`]:read(path.join(ROOT,'src-tauri/icons/128x128.png')),
    [`flatpak-input/share/licenses/${ID}/LICENSE`]:read(path.join(ROOT,'LICENSE')),
    [`native-deb-overlay/${SERVICE}`]:hostService,
    [`${ID}.json`]:Buffer.from(JSON.stringify(recipe(),null,2)+'\n'),
  };
  assert.ok(path.isAbsolute(destination)&&path.resolve(destination)===destination);
  for(let p=path.dirname(destination);;p=path.dirname(p)){assert.equal(fs.lstatSync(p).isSymbolicLink(),false);if(p===path.dirname(p))break;}
  fs.mkdirSync(destination,{mode:0o700});
  const inventory={};
  for(const [name,bytes] of Object.entries(files)){
    const output=path.join(destination,name),mode=name===`flatpak-input/bin/${COMMAND}`?0o755:0o644;
    fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o755});fs.writeFileSync(output,bytes,{flag:'wx',mode});
    if(process.platform==='linux')fs.chmodSync(output,mode);
    inventory[name]={size:bytes.length,sha256:hash(bytes),mode};
  }
  assert.equal(hash(read(launcher,64*1024*1024)),pins.launcherSha256,'Launcher input drift');
  const record={schemaVersion:1,scope:'isolated-native-activation-packaging-only',version:v,provenance:pins,
    nativeProfile:'linux-x86_64-deb/Host1',nativeServicePath:`/${SERVICE}`,nativeServiceSha256:hash(hostService),
    nativeInstallerRequired:true,nativeInstallerVerified:false,activationRunsOutsideSandbox:true,
    unsupportedHostInstallations:['rpm','appimage','steamos','linux-x86-32'],permissions:[...PERMISSIONS],files:inventory,...ACCEPTANCE};
  fs.writeFileSync(path.join(destination,'flatpak-native-activation-stage.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
  return record;
}
if(require.main===module){
  try{
    assert.equal(process.argv.length,5,'Use flatpak-native-activation.cjs LAUNCHER REVIEWED_PINS NEW_STAGE. No native installation occurs.');
    const result=prepare(path.resolve(process.argv[2]),JSON.parse(read(path.resolve(process.argv[3]))),path.resolve(process.argv[4]));
    console.log(JSON.stringify({scope:result.scope,nativeInstallerVerified:false,...ACCEPTANCE}));
  }catch(error){console.error(String(error.message).slice(0,1000));process.exitCode=1;}
}
module.exports={ROOT,NATIVE,ID,NAME,COMMAND,SERVICE,PERMISSIONS,ACCEPTANCE,hash,read,version,service,recipe,metainfo,prepare};
