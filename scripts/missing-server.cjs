'use strict';
// Hooks for the retained native runner. All paths are disposable runner fixtures.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {hash,checkStoppedRecord,checkSettings,checkClient}=require('./evidence.cjs');
const OLD_ROOT='69a5a90fe30c0d23d5ef08f6ed7f0820ba3dfba1851b448205493cee2e595000';
function guard(c){assert.equal(c.admitted,true,'Native fixture requires runner admission');assert.ok(['stopped-024-upgrade','fresh-025-cancel','fresh-025-approve'].includes(c.case));
  for(const k of ['home','local','roaming','out'])assert.ok(path.win32.isAbsolute(c[k]));assert.ok(path.basename(c.out).startsWith('native-suite-'));}
function plain(file,max=2*1024*1024){for(let p=file;;p=path.dirname(p)){assert.equal(fs.lstatSync(p).isSymbolicLink(),false);if(p===path.dirname(p))break;}
  const s=fs.lstatSync(file);assert.ok(s.isFile()&&s.nlink===1&&s.size>0&&s.size<=max);const b=fs.readFileSync(file);assert.equal(b.length,s.size);return b;}
function writeNew(file,b){assert.equal(fs.existsSync(file),false,'Existing runner fixture refused');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,b,{flag:'wx'});}
function row(c,label,file){const b=plain(file),name='missing-'+label+'.bin',destination=path.join(c.out,name);writeNew(destination,b);return{file:name,bytes:b.length,sha256:hash(b)};}
const captureBytes=(c,r)=>plain(path.join(c.out,r.file));
function fixturePaths(c){return{current:path.join(c.roaming,'creator-works-mcp/launcher-config.json'),legacy:path.join(c.roaming,'banter-mcp/launcher-config.json'),
  client:path.join(c.home,'.codex/config.toml'),jsonClient:path.join(c.home,'.claude.json'),
  old:path.join(c.local,'Creator Works MCP/server/creator-works-mcp.mjs'),node:path.join(c.local,'Creator Works MCP/server/runtime/node.exe'),
  batch:path.join(c.local,'CreatorHub/convergence/move-v1.json'),kept:path.join(c.local,'CreatorHub/convergence/kept-setup-v1.json')};}
function seed(c){guard(c);const p=fixturePaths(c);assert.equal(fs.existsSync(p.old),false);assert.equal(fs.existsSync(p.node),false);assert.equal(fs.existsSync(p.batch),false);
  const projectFiles=[],projects=['current-project','legacy-project'].map(name=>{
    const root=path.join(c.out,'missing-projects',name);
    for(const[n,text]of [['Packages/manifest.json','{"dependencies":{}}\n'],['Packages/packages-lock.json','{"dependencies":{}}\n'],['ProjectSettings/ProjectVersion.txt','m_EditorVersion: 6000.3.21f1\n'],['Assets/untouched.txt','Disposable fixture; never opened in Unity.\n']]){const file=path.join(root,n);writeNew(file,text);projectFiles.push({path:file,before:row(c,'project-'+projectFiles.length+'-before',file)});}
    return root;
  });
  const channel=(name,i)=>({id:name,name,unity_project_path:projects[i],scene_path:null,enabled:true,futureChannel:{keep:name}});
  const current={channels:[channel('current',0)],active_channel_id:'current',mcp_server_path:p.old,auto_start:false,
    enable_custom_scripts:false,allow_all_tests:false,tool_groups:'core,banter',automatic_update_checks:false,futureOption:{keep:'current'}};
  const legacy={...current,channels:[channel('legacy',1)],active_channel_id:'legacy',tool_groups:'all',futureOption:{keep:'legacy'}};
  writeNew(p.current,JSON.stringify(current,null,2)+'\n');writeNew(p.legacy,JSON.stringify(legacy,null,2)+'\r\n');
  // The JSON client owns the regression. Codex is an unrelated preservation sentinel.
  writeNew(p.jsonClient,JSON.stringify({preferences:{sentinel:'keep'},mcpServers:{
    'creator-works':{command:p.node,args:[p.old],timeout:37,env:{UNITY_PROJECT_PATH:projects[0],CUSTOM:'keep'}},
    other:{command:'unrelated-preserved',args:['do-not-run'],env:{KEEP:'exact'}}}},null,2)+'\n');
  writeNew(p.client,'model = "synthetic-preserve"\n[mcp_servers.unrelated]\ncommand = "keep"\n');
  const r={case:c.case,fixtureOnly:true,missingOfficialServer:!fs.existsSync(p.old),oldServerCreated:false,
    currentBefore:row(c,'current-before',p.current),legacyBefore:row(c,'legacy-before',p.legacy),clientBefore:row(c,'client-before',p.jsonClient),
    codexBefore:row(c,'codex-before',p.client),projectFiles,uiActions:[],nativeDialogs:[]};
  c.regression=r;c.fixturePaths=p;return r;
}
async function ui(c,id){const element=c.page.locator('#convergence-'+id);await element.waitFor({state:'visible'});assert.equal(await element.isEnabled(),true);await element.click();c.regression.uiActions.push(id);}
async function choose(c,title,button){await c.chooseNative(title,button);c.regression.nativeDialogs.push({title,button});}
async function open(c){if(!await c.page.locator('#convergence-dialog').isVisible())await ui(c,'reopen');await c.page.locator('#convergence-dialog').waitFor({state:'visible'});}
async function stopped(c){await c.page.waitForFunction(()=>{const d=document.querySelector('#convergence-dialog');return d?.open&&d.getAttribute('aria-busy')==='false'&&!document.querySelector('#convergence-error').hidden;},null,{timeout:90000});
  assert.equal(await c.page.locator('#convergence-move').isVisible(),false);const b=plain(c.fixturePaths.batch);checkStoppedRecord(b);return b;}
async function startMove(c,clientChoice){
  await open(c);const before=JSON.parse(plain(c.fixturePaths.current));await ui(c,'move');await choose(c,'Move to Hub','Move to Hub');
  if(clientChoice)await choose(c,'Review unverified MCP connections',clientChoice);
  // The service applies client plans before reviewing the settings-server path.
  if(clientChoice==='Move reviewed connections'&&before.mcp_server_path!==c.server)await choose(c,'Keep MCP settings working in Hub','Use Hub runtime');
}
async function produce024(c){guard(c);assert.equal(c.case,'stopped-024-upgrade');const r=c.regression;await c.assertRoot('0.1.24',OLD_ROOT);
  await startMove(c,null);await stopped(c);
  const text=await c.page.locator('#convergence-error').textContent();assert.match(text,/previous MCP server is missing/);
  r.baselineFailure=text;r.baselineVersion='0.1.24';r.baselineRootSha256=OLD_ROOT;r.baselineMoveCount=r.uiActions.filter(x=>x==='move').length;assert.equal(r.baselineMoveCount,1);
  r.stopped024Batch=row(c,'024-stopped-batch',c.fixturePaths.batch);assert.equal(fs.existsSync(c.fixturePaths.kept),false);
  r.currentAfter024Stop=row(c,'current-after-024-stop',c.fixturePaths.current);r.legacyAfter024Stop=row(c,'legacy-after-024-stop',c.fixturePaths.legacy);r.trace=await c.nativeTrace();
  assert.ok(plain(c.fixturePaths.jsonClient).equals(captureBytes(c,r.clientBefore)));await ui(c,'later');
  return r;
}
function findRetained(c,file,before){const dir=path.join(path.dirname(file),'.creator-hub-settings-backups');assert.ok(fs.existsSync(dir),'Native before-backup directory missing');
  const names=fs.readdirSync(dir);assert.ok(names.length>0&&names.length<=256);const matches=[];
  for(const name of names){const p=path.join(dir,name);assert.equal(fs.lstatSync(p).isSymbolicLink(),false);if(fs.lstatSync(p).isFile()&&plain(p).equals(before))matches.push(p);}
  assert.ok(matches.length>0,'Exact native before backup not found');return matches.sort()[0];}
async function keep(c,label){await open(c);await ui(c,'keep-current');await choose(c,'Keep my current setup','Keep my current setup');
  await c.page.locator('#convergence-title').filter({hasText:'Current setup kept'}).waitFor({state:'visible'});
  const receipt=JSON.parse(plain(c.fixturePaths.kept));assert.equal(receipt.active,true);assert.equal(receipt.batch_sha256,hash(plain(c.fixturePaths.batch)));
  c.regression[label]=row(c,label,c.fixturePaths.kept);await ui(c,'later');}
async function recover025(c){guard(c);const r=c.regression;await c.assertRoot('0.1.25',c.targetRootSha256);
  if(c.case==='stopped-024-upgrade'){
    r.afterUpdateBatch=row(c,'after-update-batch',c.fixturePaths.batch);assert.ok(captureBytes(c,r.afterUpdateBatch).equals(captureBytes(c,r.stopped024Batch)));
    assert.ok(plain(c.fixturePaths.jsonClient).equals(captureBytes(c,r.clientBefore)));r.afterUpdateTrace=await c.nativeTrace();
    assert.deepEqual(r.afterUpdateTrace.filter(e=>['move_to_hub','prepare_convergence','migrate_convergence_connections','retire_convergence_apps','keep_current_convergence'].includes(e.command)),[]);
    // The explicit native decision backs up this historical attempt; it is not success.
    await keep(c,'kept-024-attempt');r.keepCurrentApproved=true;
    const retained=findRetained(c,c.fixturePaths.batch,captureBytes(c,r.stopped024Batch));r.retainedStoppedBatch=row(c,'retained-024-batch',retained);
    r.completedMigration=false;r.nativeConsent=true;return r;
  }
  if(c.case==='fresh-025-cancel'){
    await startMove(c,'Keep existing');await stopped(c);r.clientAfterCancel=row(c,'client-after-cancel',c.fixturePaths.jsonClient);
    assert.ok(captureBytes(c,r.clientAfterCancel).equals(captureBytes(c,r.clientBefore)));r.cancelled025Batch=row(c,'025-cancelled-batch',c.fixturePaths.batch);
    r.trace=await c.nativeTrace();r.nativeConsent=true;r.completedMigration=false;await ui(c,'later');return r;
  }
  await startMove(c,'Move reviewed connections');
  // Only this known optional finish dialog may be handled while awaiting completion.
  await c.waitMoveComplete(async()=>{try{await c.chooseNative('Finish Creator Hub migration','Finish migration',true);return true;}catch{return false;}});
  const batch=JSON.parse(plain(c.fixturePaths.batch));assert.equal(batch.phase,'cleanup');assert.equal(batch.outcome,'complete');assert.equal(batch.retry_blocked,true);
  r.completedBatch=row(c,'025-completed-batch',c.fixturePaths.batch);r.trace=await c.nativeTrace();r.completedMigration=true;
  assert.equal(r.nativeDialogs.filter(x=>x.title==='Review unverified MCP connections'&&x.button==='Move reviewed connections').length,1);
  r.nativeConsent=true;await ui(c,'later');return r;
}
async function finish(c){const r=c.regression,p=c.fixturePaths;assert.equal(fs.existsSync(p.old),false);assert.equal(fs.existsSync(p.node),false);
  r.server=c.server;r.router=c.router;r.currentAfter=row(c,'current-after',p.current);r.legacyAfter=row(c,'legacy-after',p.legacy);r.clientAfter=row(c,'client-after',p.jsonClient);
  if(c.case==='fresh-025-approve'){checkSettings(captureBytes(c,r.currentBefore),captureBytes(c,r.legacyBefore),captureBytes(c,r.currentAfter),captureBytes(c,r.legacyAfter),c.server);
    checkClient(captureBytes(c,r.clientBefore),captureBytes(c,r.clientAfter),c.router);}
  else assert.ok(captureBytes(c,r.clientAfter).equals(captureBytes(c,r.clientBefore)));
  r.currentBackup=row(c,'current-backup',findRetained(c,p.current,captureBytes(c,r.currentBefore)));
  r.legacyBackup=row(c,'legacy-backup',findRetained(c,p.legacy,captureBytes(c,r.legacyBefore)));
  if(c.case==='fresh-025-approve')r.clientBackup=row(c,'client-backup',findRetained(c,p.jsonClient,captureBytes(c,r.clientBefore)));
  assert.ok(plain(p.client).equals(captureBytes(c,r.codexBefore)));
  for(const item of r.projectFiles){item.after=row(c,'project-'+r.projectFiles.indexOf(item)+'-after',item.path);assert.ok(captureBytes(c,item.before).equals(captureBytes(c,item.after)));}
  const before={current:plain(p.current),legacy:plain(p.legacy),client:plain(p.jsonClient),batch:plain(p.batch)};
  const restart=await c.normalRestart();assert.notEqual(restart.before.pid,restart.after.pid);assert.ok(BigInt(restart.after.startTicks)>BigInt(restart.before.startTicks));r.restart=restart;
  for(const[k,file]of Object.entries({current:p.current,legacy:p.legacy,client:p.jsonClient,batch:p.batch}))assert.ok(plain(file).equals(before[k]));
  r.normalRestart=true;if(c.case==='fresh-025-cancel'){r.afterRestartBatch=row(c,'after-restart-batch',p.batch);return r;}
  if(c.case==='stopped-024-upgrade')return r;
  const handshake=await c.readOnlyHandshake(JSON.parse(plain(p.jsonClient)).mcpServers['creator-works']);
  assert.equal(handshake.serverVersion,'2.7.10');assert.equal(handshake.tool,'get_mcp_reference');assert.equal(handshake.success,true);r.handshake=handshake;r.mcpReadOnly=true;
  return r;
}
module.exports={guard,plain,fixturePaths,seed,produce024,recover025,finish,findRetained};
