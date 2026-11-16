'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const CASES=['mcp-restore','setup-restore','setup-no-restore','stopped-024-upgrade','fresh-025-cancel','fresh-025-approve'];
function validateBinding(b){
  assert.equal(b.schemaVersion,1);assert.equal(b.enabled,true,'025 signed candidate pins pending');assert.equal(b.kind,'missing-server-025-acceptance');
  assert.ok(['private','public'].includes(b.mode));assert.equal(b.baseline.version,'0.1.24');assert.equal(b.baseline.releaseId,447323263);assert.equal(b.baseline.assetId,755655839);
  assert.equal(b.baseline.installerSha256,'ef8d0e3e59e25fbdfdc24ad3e739e568d4ddf8714dcd7bde6a0498045fe80db1');
  assert.equal(b.baseline.executableSha256,'69a5a90fe30c0d23d5ef08f6ed7f0820ba3dfba1851b448205493cee2e595000');
  assert.deepEqual(b.cases,CASES);assert.equal(b.target.version,'0.1.25');assert.equal(b.target.mcpVersion,'2.7.10');
  for(const key of ['installerSha256','executableSha256','generation'])assert.match(b.target[key],/^[a-f0-9]{64}$/);
  assert.match(b.qualificationSha256,/^[a-f0-9]{64}$/);assert.match(b.target.source.commit,/^[a-f0-9]{40}$/);assert.match(b.target.source.tree,/^[a-f0-9]{40}$/);
  assert.notEqual(b.target.executableSha256,b.baseline.executableSha256);
}
function checkStoppedRecord(bytes){const b=JSON.parse(bytes);assert.equal(b.phase,'connections');assert.equal(b.outcome,'stopped');assert.equal(b.retry_blocked,true);return b;}
function checkSettings(beforeCurrent,beforeLegacy,afterCurrent,afterLegacy,server){
  const before=JSON.parse(beforeCurrent),legacy=JSON.parse(beforeLegacy),after=JSON.parse(afterCurrent),oldAfter=JSON.parse(afterLegacy);
  const expected={...before,mcp_server_path:server,channels:[...before.channels]};
  for(const channel of legacy.channels)if(!expected.channels.some(c=>c.unity_project_path===channel.unity_project_path))expected.channels.push(channel);
  assert.deepEqual(after,expected,'Only missing projects and the explicitly reviewed runtime path may change');
  assert.deepEqual(oldAfter,expected,'Merged legacy store must match the reviewed current preferences');
  assert.equal(after.active_channel_id,before.active_channel_id);assert.notEqual(before.channels[0].unity_project_path,legacy.channels[0].unity_project_path);
}
function checkClient(beforeBytes,afterBytes,router){
  const before=JSON.parse(beforeBytes),after=JSON.parse(afterBytes);const expected=structuredClone(before);
  expected.mcpServers['creator-works'].command=router;expected.mcpServers['creator-works'].args=[];
  // Native owner/config selectors may be added, but unrelated environment is exact.
  const env=after.mcpServers['creator-works'].env;
  assert.equal(env.CREATOR_WORKS_CONFIG_OWNER,'creator-hub-v1');assert.equal(typeof env.CREATOR_WORKS_LAUNCHER_CONFIG,'string');
  expected.mcpServers['creator-works'].env={...expected.mcpServers['creator-works'].env,
    CREATOR_WORKS_CONFIG_OWNER:env.CREATOR_WORKS_CONFIG_OWNER,CREATOR_WORKS_LAUNCHER_CONFIG:env.CREATOR_WORKS_LAUNCHER_CONFIG};
  assert.deepEqual(after,expected,'Client delta exceeds reviewed command/args and owned selectors');
}
function verifyRegression(r,get,binding){
  assert.ok(['stopped-024-upgrade','fresh-025-cancel','fresh-025-approve'].includes(r.case));assert.equal(r.fixtureOnly,true);assert.equal(r.nativeConsent,true);
  assert.equal(r.missingOfficialServer,true);assert.equal(r.oldServerCreated,false);assert.equal(r.normalRestart,true);
  const capture=row=>{const b=get(row.file);assert.equal(b.length,row.bytes);assert.equal(hash(b),row.sha256);return b;};
  const current=capture(r.currentBefore),legacy=capture(r.legacyBefore),client=capture(r.clientBefore);
  assert.notDeepEqual(JSON.parse(current).channels,JSON.parse(legacy).channels);
  if(r.case==='fresh-025-approve'){
    checkSettings(current,legacy,capture(r.currentAfter),capture(r.legacyAfter),r.server);
    checkClient(client,capture(r.clientAfter),r.router);assert.ok(capture(r.clientBackup).equals(client),'Exact client before backup missing');
    assert.equal(r.mcpReadOnly,true);assert.equal(r.handshake.source,'saved-client');
  }else assert.ok(capture(r.clientAfter).equals(client),'Stopped/kept case changed the client');
  assert.ok(capture(r.currentBackup).equals(current));assert.ok(capture(r.legacyBackup).equals(legacy));
  for(const row of r.projectFiles){const a=capture(row.before),b=capture(row.after);assert.ok(a.equals(b),'Disposable project file changed');}
  assert.equal(r.trace.filter(e=>e.command==='move_to_hub').length,1,'Exactly one explicit Move per fresh fixture');
  if(r.case==='stopped-024-upgrade'){
    assert.equal(r.baselineRootSha256,binding.baseline.executableSha256);assert.equal(r.baselineVersion,'0.1.24');assert.match(r.baselineFailure,/previous MCP server is missing/);
    const batch=capture(r.stopped024Batch);checkStoppedRecord(batch);assert.ok(capture(r.afterUpdateBatch).equals(batch),'Update rewrote historical stopped journal');
    assert.ok(capture(r.retainedStoppedBatch).equals(batch),'Historical batch backup missing');
    assert.equal(r.keepCurrentApproved,true);assert.equal(r.baselineMoveCount,1);
    assert.deepEqual(r.afterUpdateTrace.filter(e=>['move_to_hub','prepare_convergence','migrate_convergence_connections','retire_convergence_apps','keep_current_convergence'].includes(e.command)),[],'Automatic startup replayed a mutation');
    assert.equal(r.completedMigration,false);
  }else if(r.case==='fresh-025-cancel'){
    checkStoppedRecord(capture(r.cancelled025Batch));assert.ok(capture(r.afterRestartBatch).equals(capture(r.cancelled025Batch)));assert.equal(r.completedMigration,false);
  }else{
    const done=JSON.parse(capture(r.completedBatch));assert.equal(done.phase,'cleanup');assert.equal(done.outcome,'complete');assert.equal(done.retry_blocked,true);assert.equal(r.completedMigration,true);
  }
  return true;
}
module.exports={hash,CASES,validateBinding,checkStoppedRecord,checkSettings,checkClient,verifyRegression};
