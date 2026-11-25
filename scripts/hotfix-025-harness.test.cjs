'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const target=require('./windows-outgoing-019-target.cjs'),direct=require('./native-outgoing-direct-019.cjs'),driver=require('./windows-outgoing-019-driver.cjs');
test('exact immutable signed inputs and all three lanes are admitted',()=>{target.validateBinding();assert.deepEqual(Object.keys(target.CASES),['mcp-restore','setup-restore','setup-no-restore']);});
test('direct protocol accepts baseline and candidate but refuses wrong builds',()=>{for(const version of ['0.1.27','0.1.28'])direct.assertProtocol({version,protocol:1,integrated:true,services:{integrated:true,features:['setup','mcp']}},version);assert.throws(()=>direct.assertProtocol({version:'0.1.23'},'0.1.23'));});
test('automatic replacement checks new process and exact PE version',async()=>{const row={pid:20,image:'C:\\test\\creator-hub.exe',startTicks:'200',kernelIdentityVerified:true};let checked=false;await driver.observeAutomaticSuccessor({hub:row.image,previousPid:10,expectedSha256:'a',inventory:()=>[row],hashFile:()=> 'a',peVersion:n=>{assert.equal(n,28);return[0,1,28,0];},onObserved:()=>{},verifyResources:()=>{checked=true;},wait:async fn=>fn()});assert.equal(checked,true);});
test('native host restriction rejects personal machines before operations',()=>{assert.throws(()=>target.assertHost({},'win32'));});
test('shared command stays put; fresh sessions use the new payload',()=>{const old=target.managedLocations('C:/Local','0.1.27','C:/Home'),fresh=target.managedLocations('C:/Local','0.1.28','C:/Home');assert.equal(old.command,fresh.command);assert.equal(old.active,fresh.active);assert.notEqual(old.payload,fresh.payload);});
test('native output and restart ordering meet retained helper contracts',()=>{const runner=fs.readFileSync(path.join(__dirname,'native-missing-runner.cjs'),'utf8');assert.ok(runner.includes("'native-suite-'+Date.now()"));assert.ok(!runner.includes("'native-suite-'+caseName"));const d=fs.readFileSync(path.join(__dirname,'windows-outgoing-019-driver.cjs'),'utf8');assert.ok(d.includes("await show(lastTool); await direct.showHome(page)"));});

test('Windows Editor lookup compares physical path spelling without equating different roots',()=>{
  assert.ok(driver.sameWindowsEditorPath('D:/Unity Editors/6000.3.21f1/Editor/Unity.exe', path.win32.join('d:/', 'Unity Editors', '6000.3.21f1', 'Editor', 'Unity.exe')));
  assert.equal(driver.sameWindowsEditorPath('D:/Unity/6000.3.21f1/Editor/Unity.exe','D:/Other/6000.3.21f1/Editor/Unity.exe'),false);
});

test('relabeling the old generation or server cannot qualify',()=>{for(const key of ['generation','manifest']) {const b=structuredClone(target.binding);b.target[key]=b.baseline[key];assert.throws(()=>target.validateBindingShape(b));}});
