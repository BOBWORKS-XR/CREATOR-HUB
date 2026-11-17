'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),Module=require('node:module');
const scripts=path.basename(__dirname)==='scripts'?__dirname:path.join(__dirname,'source/scripts');
const read=name=>fs.readFileSync(path.join(scripts,name),'utf8');
function load(name,replacements={},virtualDir=scripts){const file=path.join(virtualDir,name),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(scripts);
  const actual=m.require.bind(m);m.require=n=>Object.hasOwn(replacements,n)?replacements[n]:actual(n);m._compile(read(name),file);return m.exports;}
function enabled(){const b=JSON.parse(read('fixtures/public-update-025-binding.json'));if(b.enabled)return b;
  b.enabled=true;b.publicNotes='Creator SDK labels and read-only latest version checks.';
  const latest={...b.originalLatest,notes:b.publicNotes},body=Buffer.from(JSON.stringify(latest));
  b.target.latest={bytes:body.length,sha256:require('node:crypto').createHash('sha256').update(body).digest('hex')};
  const names=['Creator.Hub_0.1.26_x64-setup.exe','creator-hub-windows-x86_64.json','creator-hub-windows-x86_64.json.minisig','latest.json'];
  const pins=[b.target.installer,b.target.descriptor,b.target.descriptorSignature,b.target.latest];
  b.publication={releaseId:999999,tag:'v0.1.26',tagCommit:b.target.source.commit,draft:false,prerelease:false,
    assets:Object.fromEntries(names.map((name,i)=>[name,{id:900000+i,size:pins[i].bytes,sha256:pins[i].sha256}]))};return b;}
const bound=()=>load('public-update-025.cjs',{'./fixtures/public-update-025-binding.json':enabled()});
function env(t){return {GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Windows',RUNNER_ARCH:'X64',
  GITHUB_REPOSITORY:'BOBWORKS-XR/CREATOR-HUB',GITHUB_REPOSITORY_ID:'1364807512',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_JOB:'acceptance',GITHUB_RUN_ATTEMPT:'1',
  GITHUB_REF:'refs/heads/'+t.BRANCH,GITHUB_WORKFLOW_REF:'BOBWORKS-XR/CREATOR-HUB/.github/workflows/'+t.WORKFLOW+'@refs/heads/'+t.BRANCH,
  GITHUB_SHA:'a'.repeat(40),EXPECTED_HARNESS_COMMIT:'a'.repeat(40),CREATOR_PUBLIC_BINDING_SHA256:t.bindingSha256,
  CREATOR_OUTGOING_CASE:'mcp-restore',CREATOR_OUTGOING_LAST_TOOL:'mcp',CREATOR_OUTGOING_RESTORE:'true'};}
function feed(t){const p=t.binding.publication;return Buffer.from(JSON.stringify([
  {id:p.releaseId,tag_name:p.tag,draft:false,prerelease:false,assets:Object.entries(p.assets).map(([name,a])=>({name,id:a.id,size:a.size,digest:'sha256:'+a.sha256,state:'uploaded',browser_download_url:t.url('0.1.26',name)}))},
  {id:t.binding.baseline.releaseId,tag_name:'v0.1.25',draft:false,prerelease:false,assets:[{name:t.BASELINE_ASSET,id:t.binding.baseline.assetId,size:t.binding.baseline.installer.bytes,digest:'sha256:'+t.binding.baseline.installer.sha256,browser_download_url:t.url('0.1.25',t.BASELINE_ASSET)}]}
]));}
test('pending public pins refuse admission; qualified public shape and three finite lanes accepted',()=>{
  const t=load('public-update-025.cjs');if(t.binding.enabled)t.validateBinding();else assert.throws(()=>t.validateBinding(),/pending/);
  const live=bound();live.validateBinding();assert.deepEqual(Object.keys(live.CASES),['mcp-restore','setup-restore','setup-no-restore']);
  assert.equal(live.WORKFLOW,'windows-outgoing-019.yml');assert.equal(live.checkRelease(feed(live)).previousStable,'0.1.25');
});
test('public admission rejects auth proxy TLS overrides and wrong workflow before requests',()=>{
  const t=bound();t.assertAdmission(env(t),'win32');
  for(const key of ['GH_TOKEN','GITHUB_TOKEN','HTTPS_PROXY','http_proxy','ALL_PROXY','NO_PROXY','NODE_OPTIONS','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','CREATOR_SELF_UPDATE_LAB_CONFIG','CREATOR_HOSTED_UPDATE_FIXTURE'])
    assert.throws(()=>t.assertAdmission({...env(t),[key]:'forbidden'},'win32'),key);
  assert.throws(()=>t.assertAdmission({...env(t),GITHUB_WORKFLOW_REF:'wrong'},'win32'));
});
test('public feed rejects wrong assets baseline private and newer releases plus exhausted headroom',()=>{
  const t=bound();for(const change of [a=>a[0].draft=true,a=>a[0].id=447214271,a=>a[0].assets[0].digest='sha256:'+'0'.repeat(64),
    a=>a[1].assets[0].id++,a=>a.push({tag_name:'v0.1.27',draft:false,prerelease:false,assets:[]}),a=>a[0].body='x'.repeat(255*1024)]){
    const a=JSON.parse(feed(t));change(a);assert.throws(()=>t.checkRelease(Buffer.from(JSON.stringify(a))));}
});
test('binding cannot change installer source payload generation or use private release',()=>{
  const t=bound();for(const change of [b=>b.target.installer.sha256='0'.repeat(64),b=>b.target.source.commit='0'.repeat(40),
    b=>b.target.generation='0'.repeat(64),b=>b.target.privateRelease={},b=>b.baseline.version='0.1.22',b=>b.publication.releaseId=447214271]){
    const b=enabled();change(b);assert.throws(()=>t.validateBinding(b));}
});
test('anonymous public downloader admits only exact URLs and bounds bytes',async()=>{
  const t=bound();let calls=0;
  await assert.rejects(t.publicBytes('https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases/assets/123',10,()=>{calls++;}));assert.equal(calls,0);
  const result=await t.publicBytes(t.FEED,3,async(url,options)=>{assert.deepEqual(Object.keys(options.headers),['User-Agent']);return{ok:true,body:[Buffer.from('abc')]};});assert.equal(result.toString(),'abc');
  await assert.rejects(t.publicBytes(t.FEED,2,async()=>({ok:true,body:[Buffer.from('abc')]})));
});
test('public resources preserve identical router-v2 paths and hash real bytes',()=>{
  const r=load('public-resources-025.cjs');assert.deepEqual(r.managedLocations('C:\\Fixture\\Local','0.1.25','C:\\Fixture'),r.managedLocations('C:\\Fixture\\Local','0.1.26','C:\\Fixture'));
  const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'public024-')),file=path.join(dir,'data');
  try{const b=Buffer.from('fixture');fs.writeFileSync(file,b);r.readHash(file,require('node:crypto').createHash('sha256').update(b).digest('hex'));assert.throws(()=>r.readHash(file,'0'.repeat(64)));}
  finally{fs.unlinkSync(file);fs.rmdirSync(dir);}
});
test('generated driver retains native cancellation two restarts and SDK terminal-state predicates',async()=>{
  const text=read('native-public-update-025.cjs');new vm.Script(text);assert.doesNotMatch(text,/CREATOR_SELF_UPDATE_LAB_|startLabProxy|migrateExistingClaude|assertReviewedClientMigration/);
  for(const s of ["button('Not now')","button('Update Hub')","native('close')",'observeAutomaticSuccessor','codexBeforeSha256','codexAfterSha256',"page.locator('#check-updates').click()"] )assert.ok(text.includes(s),s);
  const d=load('native-public-update-025.cjs'),state={text:'Latest Creator SDK: 4.0.27',disabled:false};let clicks=0;
  const fields={'sdk-latest':()=>({textContent:state.text}),'sdk-check':()=>({disabled:false}),status:()=>({textContent:'Ready'}),controls:()=>({disabled:state.disabled}),error:()=>({hidden:true})};
  const document={querySelector:()=>({querySelector:s=>fields[s.match(/"([^"]+)"/)[1]](),getAttribute:()=> 'false'})};
  const evalFn=fn=>vm.runInNewContext('('+fn.toString()+')()',{document});
  const page={evaluate:async f=>evalFn(f),waitForFunction:async f=>assert.equal(evalFn(f),true),locator:()=>({click:async()=>{clicks++;}})};
  const report={};await d.checkSdkLookup(page,report,'after-automatic-update');assert.equal(report.sdkLookups[0].mode,'live');assert.equal(clicks,0);
  state.disabled=true;await assert.rejects(d.checkSdkLookup(page,{},'after-normal-restart'));
});
test('workflow is read-only public transport with no installer TLS fixture and exact product checkout',()=>{
  const yaml=require('playwright-core/lib/utilsBundle').yaml,w=yaml.parse(fs.readFileSync(path.join(scripts,'../.github/workflows/windows-outgoing-019.yml'),'utf8'));
  assert.deepEqual(w.permissions,{contents:'read'});assert.equal(w.jobs.acceptance.permissions,undefined);assert.equal(w.on.push,undefined);
  assert.equal(w.jobs.acceptance.strategy.matrix.include.length,3);
  const text=JSON.stringify(w);assert.doesNotMatch(text,/GH_TOKEN|GITHUB_TOKEN|startLab|native-self-update|cargo build|gh release|gh workflow|https_proxy/i);
  assert.ok(text.includes('f7f2fd17965985de68ac29cc5c2fe3820c8f905f'));assert.ok(text.includes('sdk-metadata-'));
});
test('full public collector checks file preservation SDK outcomes and all three lane reports',t=>{
  const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'public024-collector-'));
  t.after(()=>{assert.equal(path.dirname(dir),path.resolve(require('node:os').tmpdir()));assert.ok(path.basename(dir).startsWith('public024-collector-'));fs.rmSync(dir,{recursive:true,force:true});});
  const target=bound(),virtual=path.join(dir,'scripts'),captures=path.join(dir,'artifacts/native-suite-123');fs.mkdirSync(captures,{recursive:true});
  const profile={home:path.join(dir,'home'),local:path.join(dir,'home/Local'),roaming:path.join(dir,'home/Roaming')},route=target.managedLocations(profile.local,'0.1.25',profile.home);
  const cap=(file,name,b)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,b);const saved=path.join(captures,name);fs.writeFileSync(saved,b);return{file,capture:saved,bytes:b.length,sha256:target.hash(b)};};
  const clients={afterUpdateCancel:{}};
  for(const[key,file,name]of [['selected',path.join(profile.home,'.claude.json'),'claude'],['old',path.join(profile.home,'.gemini/config/mcp_config.json'),'old-client'],['currentSettings',path.join(profile.roaming,'creator-works-mcp/launcher-config.json'),'settings'],['oldSettings',path.join(profile.roaming,'banter-mcp/launcher-config.json'),'old-settings']]){
    const b=Buffer.from('{}');clients[key+'Before']=cap(file,name+'-before.json',b);clients[key+'After']=cap(file,name+'-after.json',b);
    if(['selected','old'].includes(key))clients.afterUpdateCancel[key]=cap(file,name+'-update-cancel.json',b);
  }
  const rows=n=>[{pid:n,parentPid:1,startTicks:String(n),image:route.command,kernelIdentityVerified:true},{pid:n+1,parentPid:n,startTicks:String(n+1),image:path.join(route.payload,'mcp/server/runtime/node.exe'),kernelIdentityVerified:true}];
  const root=n=>({pid:n,startTicks:String(n),image:path.join(profile.local,'Creator Hub/creator-hub.exe'),kernelIdentityVerified:true});
  const resourceChecks=[],mock={...target,assertActiveResources:(local,v)=>resourceChecks.push(v),assertInstalledResources:()=>resourceChecks.push('installed')};
  const collector=load('public-preservation-025.cjs',{'./public-update-025.cjs':mock,'./native-outgoing-direct-019.cjs':load('native-outgoing-direct-019.cjs')},virtual),check=load('public-evidence-025.cjs',{'./public-update-025.cjs':target});
  const base={kind:target.KIND,sourceCommit:target.binding.target.source.commit,harnessSource:'a'.repeat(40),baseline:target.configFor().baseline,pins:target.configFor().pins,
    clients,profile,beforePeVersion:[0,1,25,0],afterPeVersion:[0,1,26,0],beforeRoot:root(1),afterRoot:root(3),normalRestartRoot:root(4),beforeNormalRestart:root(3),approvalLowerBoundTicks:'2',
    resourceProbe:{phase:'after-automatic-root',attempts:1,passed:true},heldProcessesBefore:rows(10),heldProcessesAfter:rows(10),reconnectedProcesses:rows(20),freshOldProcesses:rows(30),
    heldServerVersion:{version:'2.7.10'},reconnectedServerVersion:{version:'2.7.10'},freshOldServerVersion:{version:'2.7.10'},
    beforeRoute:{schemaVersion:1,generation:target.binding.baseline.generation,descriptorSha256:target.binding.baseline.manifest.managedRouting.files['routing/runtime.json']},
    afterRoute:{schemaVersion:1,generation:target.binding.target.generation,descriptorSha256:target.binding.target.manifest.managedRouting.files['routing/runtime.json']},
    publicProof:{authenticatedDownload:false,lab:false,fixture:false,harnessSource:'a'.repeat(40),bindingSha256:target.bindingSha256,releaseId:target.binding.publication.releaseId},
    installedSha256:target.binding.target.executable.sha256,codexBeforeSha256:'b'.repeat(64),codexAfterSha256:'b'.repeat(64),clientConnectionsUnchanged:true,
    sdkMetadata:{checked:[{version:'4.0.25',mismatch:true,profile:'creator',tested:true,filesUnchanged:true},{version:'4.0.27',mismatch:false,profile:'creator',tested:false,filesUnchanged:true}],lookupNonBlocking:true,afterNormalRestartLookupNonBlocking:true},
    sdkLookups:['after-automatic-update','after-normal-restart'].map(phase=>({phase,manualRetry:false,before:{text:'Checking latest Creator SDK...'},mode:'live',version:'4.0.27',after:{text:'Latest Creator SDK: 4.0.27',status:'Ready',controlsDisabled:false,buttonDisabled:false,busy:'false',errorVisible:false}})),
    labDiscovery:false,liveAiAcceptance:false,releaseReady:false};
  for(const flag of ['passed','publicDiscovery','nativeUpdateAccepted','automaticRestart','cancelPreserved','existingConnectionSurvived','newConnectionVerified','restorationVerified','policyRestored','settingsPreserved','targetMcpRuntimeVerified','installedResourcesVerifiedBeforeAndAfter','heldGenerationRetained','activeRouteUnchangedAfterCancel','normalRestartPreserved','fixtureEvidencePreservedAfterCleanup','codexSettingsPreserved'])base[flag]=true;
  for(const[name,[tool,restore]]of Object.entries(target.CASES)){
    const r={...base,lastTool:tool,restore:restore==='true',restoredLastTool:restore==='true'?tool:null,manualCapabilityRetention:require(path.join(scripts,'sdk-retention-023.cjs')).proof(tool,restore==='true')};
    assert.equal(check.checkReport(r,name,'a'.repeat(40)),true);collector.checkMigrationReceipt(r);
    for(const alter of [x=>x.sdkLookups[0].after.controlsDisabled=true,x=>x.clientReview={},x=>x.normalRestartRoot=x.afterRoot,x=>x.publicProof.authenticatedDownload=true]){const bad=structuredClone(r);alter(bad);assert.throws(()=>check.checkReport(bad,name,'a'.repeat(40)));}
  }
  assert.equal(resourceChecks.length,9);fs.writeFileSync(clients.selectedAfter.capture,'changed');assert.throws(()=>collector.checkMigrationReceipt(base));
});
test('normal restore lane selects its requested last tool after MCP guide check',()=>{
  assert.ok(read('native-public-update-025.cjs').includes("await show('mcp'); await continueMcpGuide(page);\n    await show(lastTool); await direct.showHome(page);"));
});
