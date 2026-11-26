'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const target=require('./public-update-025.cjs');
const direct=require('./native-outgoing-direct-019.cjs');
function checkReport(report,name=process.env.CREATOR_OUTGOING_CASE,harness=process.env.GITHUB_SHA,tag=process.env.EXPECTED_TAG_COMMIT){
  target.validateBinding();assert.ok(Object.hasOwn(target.CASES,name));
  assert.equal(report.kind,target.KIND);assert.equal(report.sourceCommit,target.binding.target.source.commit);
  assert.equal(report.harnessSource,harness);assert.deepEqual(report.baseline,target.configFor().baseline);assert.deepEqual(report.pins,target.configFor().pins);
  assert.equal(report.lastTool,target.CASES[name][0]);assert.equal(report.restore,target.CASES[name][1]==='true');
  assert.equal(report.restoredLastTool,report.restore?report.lastTool:null);
  for(const flag of ['passed','publicDiscovery','nativeUpdateAccepted','automaticRestart','cancelPreserved','existingConnectionSurvived',
    'newConnectionVerified','restorationVerified','policyRestored','settingsPreserved','targetMcpRuntimeVerified','installedResourcesVerifiedBeforeAndAfter',
    'heldGenerationRetained','activeRouteUnchangedAfterCancel','normalRestartPreserved','fixtureEvidencePreservedAfterCleanup','codexSettingsPreserved'])assert.equal(report[flag],true,flag);
  for(const flag of ['labDiscovery','liveAiAcceptance','releaseReady'])assert.equal(report[flag],false,flag);
  assert.deepEqual(report.pageErrors||[],[]);assert.equal(report.error,undefined);
  assert.equal(report.installedSha256,target.binding.target.executable.sha256);
  assert.equal(report.beforeInstalledSha256,target.binding.baseline.executable.sha256);
  assert.equal(report.installedRegistryVersion,'0.1.28');
  assert.deepEqual(report.appDiscovery,{currentVersion:'0.1.27',availableVersion:'0.1.28',preview:true});
  assert.deepEqual(report.preservedProjectScope,['automatic-restart','normal-restart']);
  assert.deepEqual(report.beforePeVersion,[0, 1, 27, 0]);assert.deepEqual(report.afterPeVersion,[0, 1, 28, 0]);
  assert.deepEqual(report.resourceProbe,{phase:'after-automatic-root',attempts:1,passed:true});
  const roots=[report.beforeRoot,report.afterRoot,report.normalRestartRoot];assert.equal(new Set(roots.map(r=>r.pid)).size,3);
  for(const r of roots){assert.equal(r.kernelIdentityVerified,true);assert.match(r.startTicks,/^[1-9][0-9]*$/);assert.equal(r.image.toLowerCase(),roots[0].image.toLowerCase());}
  assert.ok(BigInt(roots[0].startTicks)<BigInt(report.approvalLowerBoundTicks));assert.ok(BigInt(roots[1].startTicks)>BigInt(report.approvalLowerBoundTicks));
  assert.ok(BigInt(roots[2].startTicks)>BigInt(roots[1].startTicks));assert.deepEqual(report.beforeNormalRestart,report.afterRoot);
  for(const [version,route]of [['0.1.27',report.beforeRoute],['0.1.28',report.afterRoute]]){
    const item=version==='0.1.27'?target.binding.baseline:target.binding.target;
    assert.deepEqual(route,{schemaVersion:1,generation:item.generation,descriptorSha256:item.manifest.managedRouting.files['routing/runtime.json']});
  }
  assert.equal(report.heldServerVersion.version,'2.7.10');
  for(const key of ['reconnectedServerVersion','freshOldServerVersion'])assert.equal(report[key].version,'2.7.11');
  assert.deepEqual(report.heldProcessesAfter,report.heldProcessesBefore);
  target.assertFreshConnection(report.heldProcessesBefore,report.reconnectedProcesses,report.profile);
  target.assertFreshConnection(report.freshOldProcesses,report.reconnectedProcesses,report.profile,'0.1.28');
  const unassisted=require('./unassisted-028.cjs');
  for(const [phase,view] of [['automatic',report.restoredLastTool || 'home'],['normal','home']]){
    unassisted.check(report.unassisted[phase],target.binding,phase,view,
      rows=>target.assertFreshConnection(report.heldProcessesBefore,rows,report.profile));
  }
  assert.equal(new Set([...report.heldProcessesBefore,...report.reconnectedProcesses,...report.freshOldProcesses].map(r=>r.pid)).size,6);
  const proof=report.publicProof;assert.equal(proof.authenticatedDownload,false);assert.equal(proof.lab,false);assert.equal(proof.fixture,false);
  assert.equal(proof.harnessSource,harness);assert.equal(proof.bindingSha256,target.bindingSha256);assert.equal(proof.releaseId,target.binding.publication.releaseId);
  assert.match(tag || '',/^[a-f0-9]{40}$/);assert.equal(proof.tagCommit,tag);
  assert.equal(proof.stageReceiptSha256,target.STAGE_SHA256);
  assert.deepEqual(report.manualCapabilityRetention,require('./sdk-retention-023.cjs').proof(report.lastTool,report.restore));
  assert.equal(report.clientReview,undefined);assert.equal(report.clientConnectionsUnchanged,true);
  assert.equal(report.codexBeforeSha256,report.codexAfterSha256);assert.match(report.codexBeforeSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(report.sdkMetadata,{checked:[{version:'4.0.25',mismatch:true,profile:'creator',tested:true,filesUnchanged:true},
    {version:'4.0.27',mismatch:false,profile:'creator',tested:false,filesUnchanged:true}],lookupNonBlocking:true,afterNormalRestartLookupNonBlocking:true});
  assert.equal(report.sdkLookups?.length,2);
  for(const [i,e]of report.sdkLookups.entries()){
    assert.equal(e.phase,['after-automatic-update','after-normal-restart'][i]);assert.equal(typeof e.manualRetry,'boolean');assert.equal(typeof e.before?.text,'string');
    assert.equal(e.after.status,'Ready');assert.equal(e.after.controlsDisabled,false);assert.equal(e.after.buttonDisabled,false);assert.equal(e.after.busy,'false');assert.equal(e.after.errorVisible,false);
    if(e.mode==='offline'){assert.equal(e.after.text,'Latest SDK could not be checked. Installed versions are still shown below.');assert.equal(e.version,undefined);}
    else{assert.equal(e.mode,'live');assert.match(e.version,/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);assert.equal(e.after.text,'Latest Creator SDK: '+e.version);}
  }
  return true;
}
function collect(){
  target.assertAdmission();const dirs=fs.readdirSync(path.resolve('artifacts')).filter(n=>/^native-suite-\d+$/.test(n));assert.equal(dirs.length,1);
  const dir=path.resolve('artifacts',dirs[0]),reportBytes=target.readBounded(path.join(dir,'outgoing-report.json'),2*1024*1024),report=JSON.parse(reportBytes);
  checkReport(report);require('./public-preservation-025.cjs').checkMigrationReceipt(report);
  const before=direct.readEvidence(report.codexBefore.capture),after=direct.readEvidence(report.codexAfter.capture);
  assert.equal(target.hash(before),report.codexBeforeSha256);assert.ok(before.equals(after));assert.ok(direct.readEvidence(report.codexAfter.file).equals(after));
  const feed=target.readBounded(path.join(target.directory(),'public-feed.json'),256*1024),input=target.readBounded(path.join(target.directory(),'public-input-binding.json'),32768);
  const tag=target.readBounded(path.join(target.directory(),'public-tag.json'),32768);
  assert.deepEqual(report.publicProof,{...target.proofFor(feed,tag),inputBindingSha256:target.hash(input)});
  const acceptance={schemaVersion:1,case:process.env.CREATOR_OUTGOING_CASE,publicDiscovery:true,nativeUpdateAccepted:true,
    harnessSource:process.env.GITHUB_SHA,bindingSha256:target.bindingSha256,releaseId:target.binding.publication.releaseId,
    qualificationSha256:target.binding.qualificationSha256,stageReceiptSha256:target.STAGE_SHA256,tagCommit:report.publicProof.tagCommit,
    reportSha256:target.hash(reportBytes),inputBindingSha256:target.hash(input),cleanupVerified:true};
  fs.writeFileSync(path.join(dir,'public-acceptance.json'),JSON.stringify(acceptance,null,2),{flag:'wx'});
  console.log(JSON.stringify({passed:true,case:acceptance.case,reportSha256:acceptance.reportSha256}));
}
module.exports={checkReport,collect};
if(require.main===module)try{collect();}catch(e){console.error(e.stack);process.exitCode=1;}
