'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const p=require('./flatpak-native-activation.cjs');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'creator-native-activation-'));
  t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('creator-native-activation-'));fs.rmSync(root,{recursive:true,force:true});});
  const launcher=path.join(root,'launcher');const elf=Buffer.alloc(80);Buffer.from([127,69,76,70,2,1,1]).copy(elf);elf.writeUInt16LE(3,16);elf.writeUInt16LE(62,18);fs.writeFileSync(launcher,elf);
  return{root,launcher,elf,destination:path.join(root,'stage'),pins:{schemaVersion:1,version:p.version(),sourceCommit:'a'.repeat(40),sourceTree:'b'.repeat(40),launcherSha256:p.hash(elf),launcherSize:elf.length}};
}
test('production bootstrap bus NAME PATH INTERFACE and unit Start are tied to actual Root source',()=>{
  const root=fs.readFileSync(path.join(p.ROOT,'src-tauri/src/flatpak_bootstrap.rs'),'utf8');
  const rust=fs.readFileSync(path.join(p.NATIVE,'src/lib.rs'),'utf8');
  for(const name of ['NAME','PATH','INTERFACE']){
    const real=root.match(new RegExp(`const ${name}: &str = "([^"]+)";`));
    const declared=rust.match(new RegExp(`pub const ${name}: &str = "([^"]+)";`));
    assert.ok(real&&declared);assert.equal(declared[1],real[1]);
  }
  assert.ok(root.includes("<method name='Start'/>"));assert.ok(root.includes('parameters.get::<()>().is_none()'));
  assert.equal(p.NAME,'com.creatorworks.hub.Host');assert.ok(!p.service().includes('com.creatorworks.hub.Host1'));
});
test('launcher source calls only fixed Start and fixed installer OpenURI, never a host command relay',()=>{
  const source=fs.readFileSync(path.join(p.NATIVE,'src/linux.rs'),'utf8');
  assert.equal((source.match(/bus\.call_sync\(/g)||[]).length,2);
  for(const value of ['Some(&().to_variant())','Some(VariantTy::UNIT)','contract::METHOD','org.freedesktop.portal.OpenURI','15_000'])assert.ok(source.includes(value),value);
  for(const value of ['Command::','flatpak-spawn','--host','pkexec','std::fs','get_text','read_to_string','loop {'])assert.ok(!source.includes(value),value);
  assert.ok(source.indexOf('close_dialog(&dialog)')<source.indexOf('activate() {'));
});
test('permissions have no network, host filesystem, whole bus, device or process grants',()=>{
  assert.deepEqual(p.PERMISSIONS,['--socket=wayland','--socket=fallback-x11','--talk-name=com.creatorworks.hub.Host']);
  const recipe=p.recipe();assert.deepEqual(recipe['finish-args'],p.PERMISSIONS);
  assert.equal(recipe.branch,'native-activation-test');assert.equal(recipe.command,p.COMMAND);
  for(const token of ['filesystem','share=network','flatpak-spawn','session-bus','system-bus','device=all','allow=devel','modules.tar.gz','mcp-router'])assert.ok(!JSON.stringify(recipe).includes(token),token);
});
test('service overlay is normal user session activation, with no new systemd or polkit policy',()=>{
  assert.equal(p.service().toString(),`[D-BUS Service]\nName=${p.NAME}\nExec=/usr/bin/creator-hub --flatpak-activate\n`);
  assert.equal(p.SERVICE,'usr/share/dbus-1/services/com.creatorworks.hub.Host.service');
  for(const word of ['User=','SystemdService=','/bin/sh','sudo','pkexec','mcp','setup'])assert.ok(!p.service().includes(word));
});
test('source version bound to native Hub and disclosure names unsupported hosts/outside sandbox',()=>{
  assert.equal(p.version(),JSON.parse(fs.readFileSync(path.join(p.ROOT,'package.json'))).version);
  const rust=fs.readFileSync(path.join(p.NATIVE,'src/lib.rs'),'utf8');
  for(const text of ['outside the Flatpak sandbox','DEB installation','RPM, AppImage and SteamOS','releases/tag/v{VERSION}'])assert.ok(rust.includes(text),text);
  assert.ok(p.metainfo(p.version()).includes('outside its sandbox'));
});
test('trusted release verifier embeds actual Root public key, no runtime trust key or bool bypass',()=>{
  const rust=fs.readFileSync(path.join(p.NATIVE,'src/lib.rs'),'utf8');
  assert.ok(rust.includes('include_str!("../../../src-tauri/src/catalog-key.pub")'));
  assert.ok(rust.includes('key.verify(bytes, &signature, false)'));
  assert.ok(rust.indexOf('verify(&key, &bytes')<rust.indexOf('let value = descriptor(&bytes)'));
  assert.match(rust,/verify\(\s*&key,\s*&installer,/);
  assert.ok(rust.includes('TEST ONLY installers cannot authorize'));
  for(const bad of ['std::env::var("KEY','skip_signature','trusted: bool','pub fn verify(key'])assert.ok(!rust.includes(bad));
});
test('offline stage has one launcher, existing icon/license, fixed overlay and all readiness false',t=>{
  const f=fixture(t),record=p.prepare(f.launcher,f.pins,f.destination);
  assert.equal(record.nativeInstallerVerified,false);assert.equal(record.activationRunsOutsideSandbox,true);
  for(const k of Object.keys(p.ACCEPTANCE))assert.equal(record[k],false,k);
  assert.equal(Object.keys(record.files).length,7);
  assert.ok(!Object.keys(record.files).some(n=>/modules|mcp|setup/.test(n)));
  assert.equal(record.files[`native-deb-overlay/${p.SERVICE}`].sha256,p.hash(p.service()));
  assert.deepEqual(fs.readFileSync(path.join(f.destination,`flatpak-input/share/icons/hicolor/128x128/apps/${p.ID}.png`)),fs.readFileSync(path.join(p.ROOT,'src-tauri/icons/128x128.png')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.destination,`${p.ID}.json`))),p.recipe());
});
test('wrong launcher bytes size architecture and version fail before staging',t=>{
  for(const what of ['hash','size','arch','version','extra']){
    const f=fixture(t);
    if(what==='hash')f.pins.launcherSha256='f'.repeat(64);
    if(what==='size')f.pins.launcherSize++;
    if(what==='version')f.pins.version='0.0.1';
    if(what==='extra')f.pins.trusted=true;
    if(what==='arch'){f.elf.writeUInt16LE(183,18);fs.writeFileSync(f.launcher,f.elf);f.pins.launcherSha256=p.hash(f.elf);}
    assert.throws(()=>p.prepare(f.launcher,f.pins,f.destination),undefined,what);assert.equal(fs.existsSync(f.destination),false);
  }
});
test('existing stage cannot be overwritten and signed native package is never inferred from launcher pins',t=>{
  const f=fixture(t);fs.mkdirSync(f.destination);fs.writeFileSync(path.join(f.destination,'keep'),'sentinel');
  assert.throws(()=>p.prepare(f.launcher,f.pins,f.destination));assert.equal(fs.readFileSync(path.join(f.destination,'keep'),'utf8'),'sentinel');
  assert.equal(p.ACCEPTANCE.nativeHelperInstalled,false);
});
