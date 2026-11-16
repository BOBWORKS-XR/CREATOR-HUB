'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const target=require('./public-update-025.cjs'),direct=require('./native-outgoing-direct-019.cjs');
const hash=target.hash;
function checkMigrationReceipt(report) {
  const {profile,clients}=report;
  assert.deepEqual(Object.keys(profile).sort(),['home','local','roaming']);
  for(const folder of Object.values(profile))assert.ok(path.win32.isAbsolute(folder)&&!folder.split(/[\\/]/).includes('..'));
  const captures=path.dirname(clients.selectedBefore.capture);
  assert.equal(path.dirname(captures),path.resolve(__dirname,'../artifacts'));
  const capture=(row,file,name)=>{assert.equal(row.file,file);assert.equal(row.capture,path.join(captures,name));const bytes=direct.readEvidence(row.capture);assert.equal(bytes.length,row.bytes);assert.equal(hash(bytes),row.sha256);return bytes;};
  const pairs=[['selected',path.join(profile.home,'.claude.json'),'claude'],['old',path.join(profile.home,'.gemini/config/mcp_config.json'),'old-client'],['currentSettings',path.join(profile.roaming,'creator-works-mcp/launcher-config.json'),'settings'],['oldSettings',path.join(profile.roaming,'banter-mcp/launcher-config.json'),'old-settings']];
  for(const [key,file,name] of pairs) {
    const before=capture(clients[key+'Before'],file,name+'-before.json'),after=capture(clients[key+'After'],file,name+'-after.json');
    assert.ok(before.equals(after));assert.ok(direct.readEvidence(file).equals(before));
    if(key==='selected'||key==='old')assert.ok(capture(clients.afterUpdateCancel[key],file,name+'-update-cancel.json').equals(before));
  }
  assert.equal(report.clientReview,undefined);assert.equal(report.clientConnectionsUnchanged,true);
  const old=target.managedLocations(profile.local,'0.1.24',profile.home),next=target.managedLocations(profile.local,'0.1.25',profile.home);
  assert.equal(old.command,next.command);assert.equal(old.active,next.active);assert.equal(old.payload,next.payload);
  target.assertActiveResources(profile.local,'0.1.24',report.beforeRoute,false,profile.home);
  target.assertActiveResources(profile.local,'0.1.25',report.afterRoute,true,profile.home);
  target.assertInstalledResources(path.join(profile.local,'Creator Hub'),'0.1.25');
  target.assertFreshConnection(report.heldProcessesBefore,report.reconnectedProcesses,profile);
  target.assertFreshConnection(report.freshOldProcesses,report.reconnectedProcesses,profile);
  assert.equal(new Set([...report.heldProcessesBefore,...report.freshOldProcesses,...report.reconnectedProcesses].map(p=>p.pid)).size,6);
  assert.equal(report.freshOldServerVersion.version,'2.7.10');
  assert.deepEqual(report.sdkMetadata,{checked:[{version:'4.0.25',mismatch:true,profile:'creator',tested:true,filesUnchanged:true},{version:'4.0.27',mismatch:false,profile:'creator',tested:false,filesUnchanged:true}],lookupNonBlocking:true,afterNormalRestartLookupNonBlocking:true});
  assert.equal(report.sdkLookups?.length,2);
  for(const [i,e] of report.sdkLookups.entries()) {
    assert.equal(e.phase,['after-automatic-update','after-normal-restart'][i]);assert.equal(typeof e.manualRetry,'boolean');
    assert.equal(typeof e.before?.text,'string');assert.equal(e.after?.status,'Ready');assert.equal(e.after.controlsDisabled,false);
    assert.equal(e.after.busy,'false');assert.equal(e.after.errorVisible,false);assert.equal(e.after.buttonDisabled,false);
    if(e.mode==='offline') {assert.equal(e.after.text,'Latest SDK could not be checked. Installed versions are still shown below.');assert.equal(e.version,undefined);}
    else {assert.equal(e.mode,'live');assert.match(e.version,/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);assert.equal(e.after.text,'Latest Creator SDK: '+e.version);}
  }
}

module.exports={checkMigrationReceipt};
