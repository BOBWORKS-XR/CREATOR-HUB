'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const target=require('./public-update-023.cjs');
const direct=require('./native-outgoing-direct-019.cjs');
function checkReport(report, name=process.env.CREATOR_OUTGOING_CASE, harness=process.env.GITHUB_SHA) {
  target.validateBinding(); assert.ok(Object.hasOwn(target.CASES,name));
  assert.equal(report.kind,target.KIND); assert.equal(report.sourceCommit,target.binding.target.source.commit);
  assert.equal(report.harnessSource,harness);
  assert.deepEqual(report.baseline,target.configFor().baseline); assert.deepEqual(report.pins,target.configFor().pins);
  assert.equal(report.lastTool,target.CASES[name][0]); assert.equal(report.restore,target.CASES[name][1]==='true');
  assert.equal(report.restoredLastTool,report.restore?report.lastTool:null);
  for(const flag of ['passed','publicDiscovery','nativeUpdateAccepted','automaticRestart','cancelPreserved','existingConnectionSurvived',
    'newConnectionVerified','restorationVerified','policyRestored','settingsPreserved','targetMcpRuntimeVerified',
    'installedResourcesVerifiedBeforeAndAfter','heldGenerationRetained','activeRouteUnchangedAfterCancel','normalRestartPreserved',
    'fixtureEvidencePreservedAfterCleanup','codexSettingsPreserved']) assert.equal(report[flag],true,flag);
  for(const flag of ['labDiscovery','liveAiAcceptance','releaseReady']) assert.equal(report[flag],false,flag);
  assert.equal(report.installedSha256,target.binding.target.executable.sha256);
  assert.deepEqual(report.beforePeVersion,[0,1,22,0]); assert.deepEqual(report.afterPeVersion,[0,1,23,0]);
  assert.deepEqual(report.resourceProbe,{phase:'after-automatic-root',attempts:1,passed:true});
  const before=report.beforeRoot, after=report.afterRoot, normal=report.normalRestartRoot;
  for(const r of [before,after,normal]) {assert.equal(r.kernelIdentityVerified,true);assert.match(r.startTicks,/^[0-9]+$/);}
  assert.equal(new Set([before.pid,after.pid,normal.pid]).size,3);
  assert.equal(before.image.toLowerCase(),after.image.toLowerCase());assert.equal(after.image.toLowerCase(),normal.image.toLowerCase());
  assert.ok(BigInt(before.startTicks)<BigInt(report.approvalLowerBoundTicks));
  assert.ok(BigInt(after.startTicks)>BigInt(report.approvalLowerBoundTicks));
  assert.ok(BigInt(normal.startTicks)>BigInt(after.startTicks));
  assert.equal(report.beforeRoute.generation,target.binding.baseline.generation);
  assert.equal(report.afterRoute.generation,target.binding.target.generation);
  assert.equal(report.heldServerVersion.version,'2.7.9');assert.equal(report.reconnectedServerVersion.version,'2.7.10');
  assert.deepEqual(report.heldProcessesBefore,report.heldProcessesAfter);
  target.assertFreshConnection(report.heldProcessesBefore,report.reconnectedProcesses,report.profile);
  target.assertFreshConnection(report.freshOldProcesses,report.reconnectedProcesses,report.profile);
  assert.equal(report.publicProof.authenticatedDownload,false);assert.equal(report.publicProof.lab,false);assert.equal(report.publicProof.fixture,false);
  assert.equal(report.publicProof.harnessSource,report.harnessSource);assert.equal(report.publicProof.bindingSha256,target.bindingSha256);
  assert.equal(report.publicProof.releaseId,target.binding.publication.releaseId);
  assert.deepEqual(report.manualCapabilityRetention,require('./sdk-retention-023.cjs').proof(report.lastTool,report.restore));
  assert.equal(report.codexBeforeSha256,report.codexAfterSha256);
}
function collect() {
  target.assertAdmission();
  const dirs=fs.readdirSync(path.resolve('artifacts')).filter(n=>/^native-suite-\d+$/.test(n));assert.equal(dirs.length,1);
  const dir=path.resolve('artifacts',dirs[0]);
  const reportBytes=target.readBounded(path.join(dir,'outgoing-report.json'),2*1024*1024),report=JSON.parse(reportBytes);
  checkReport(report); require('./public-migration-023.cjs').checkMigrationReceipt(report);
  assert.equal(target.hash(direct.readEvidence(report.codexBefore.capture)),report.codexBeforeSha256);
  assert.ok(direct.readEvidence(report.codexBefore.capture).equals(direct.readEvidence(report.codexAfter.capture)));
  assert.ok(direct.readEvidence(report.codexAfter.file).equals(direct.readEvidence(report.codexAfter.capture)));
  const inputDir=target.directory(), feed=target.readBounded(path.join(inputDir,'public-feed.json'),256*1024);
  const input=target.readBounded(path.join(inputDir,'public-input-binding.json'),32768);
  assert.deepEqual(report.publicProof,{...target.proofFor(feed),inputBindingSha256:target.hash(input)});
  const evidenceDir=path.join(dir,'proof-files');fs.mkdirSync(evidenceDir);
  const proofs=[];
  const save=original=>{
    if(proofs.some(p=>p.original===original))return;
    const bytes=direct.readEvidence(original),name=`${proofs.length}.bin`;
    fs.writeFileSync(path.join(evidenceDir,name),bytes,{flag:'wx'});
    proofs.push({original,name,bytes:bytes.length,sha256:target.hash(bytes)});
  };
  for(const row of report.clientReview.evidence.files) save(row.file);
  save(report.settingsView.file || report.settingsView.path);
  for(const c of [report.codexBefore,report.codexAfter])save(c.capture);
  fs.writeFileSync(path.join(dir,'proof-files.json'),JSON.stringify(proofs,null,2),{flag:'wx'});
  const acceptance={schemaVersion:1,case:process.env.CREATOR_OUTGOING_CASE,publicDiscovery:true,nativeUpdateAccepted:true,
    harnessSource:process.env.GITHUB_SHA,bindingSha256:target.bindingSha256,releaseId:target.binding.publication.releaseId,
    qualificationSha256:target.binding.qualificationSha256,reportSha256:target.hash(reportBytes),inputBindingSha256:target.hash(input),
    proofFilesSha256:target.hash(fs.readFileSync(path.join(dir,'proof-files.json'))),cleanupVerified:true};
  fs.writeFileSync(path.join(dir,'public-acceptance.json'),JSON.stringify(acceptance,null,2),{flag:'wx'});
  console.log(JSON.stringify({passed:true,case:acceptance.case,reportSha256:acceptance.reportSha256}));
}
module.exports={checkReport,collect};
if(require.main===module)try{collect();}catch(error){console.error(error.message);process.exitCode=1;}
