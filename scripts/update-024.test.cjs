'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const Module=require('node:module');
const generated=path.basename(__dirname)==='scripts';
const base=generated?path.resolve(__dirname,'..'):path.join(__dirname,'source');
const scripts=path.join(base,'scripts');
const read=n=>fs.readFileSync(path.join(scripts,n),'utf8');
function load(name,replacements={},virtualDir=scripts) {
  const file=path.join(virtualDir,name),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(scripts);
  const actual=m.require.bind(m);m.require=n=>Object.hasOwn(replacements,n)?replacements[n]:actual(n);
  m._compile(read(name),file);return m.exports;
}
function fixture() {
  const b=JSON.parse(read('fixtures/windows-outgoing-019-binding.json'));
  b.enabled=true;
  const old=b.baseline,manifest=structuredClone(old.manifest);
  manifest.managedRouting.files['routing/runtime.json']='a'.repeat(64);
  manifest.managedRouting.files['routing/runtime.minisig']='b'.repeat(64);
  const pin={bytes:5,sha256:'c'.repeat(64)};
  const source=b.target.source.commit?b.target.source:{commit:'d'.repeat(40),tree:'e'.repeat(40)};
  b.target={source,version:'0.1.24',asset:'Creator.Hub_0.1.24_x64-setup.exe',
    installer:pin,executable:{bytes:6,sha256:'d'.repeat(64)},manifest,generation:old.generation,sourceUnchanged:true,buildExitCode:0,
    verificationReceiptSha256:'e'.repeat(64),descriptor:pin,descriptorSignature:pin,latest:pin,
    privateRelease:{id:999,tag:'lab-windows-sdk-labels-024-20261116',source:source.commit,assets:Object.fromEntries([
      'Creator.Hub_0.1.24_x64-setup.exe','creator-hub-windows-x86_64.json','creator-hub-windows-x86_64.json.minisig','latest.json'
    ].map((n,i)=>[n,{id:800+i,...pin}]))}};
  b.fixtureQualification={kind:'sdk-labels-024-signed-candidate',source:b.target.source,sha256:b.target.verificationReceiptSha256,
    sourceUnchanged:true,buildExitCode:0,inputCount:1605,payloadFiles:15,fixtureUsableForOutgoingTest:true,
    productionSourceGuardException:false,productionApproval:false,outgoingNativeAccepted:false,published:false,releaseReady:false};
  return b;
}
test('pending candidate fails closed and only one MCP restore lane exists',()=>{
  const target=load('windows-outgoing-019-target.cjs');
  if(target.binding.enabled) target.validateBinding();
  else assert.throws(()=>target.validateBinding(),/Pending/);
  assert.deepEqual(target.CASES,{'mcp-restore':['mcp','true']});
});
test('same physical router and generation are valid while wrong baselines fail',()=>{
  const b=fixture(),target=load('windows-outgoing-019-target.cjs',{'./fixtures/windows-outgoing-019-binding.json':b});
  target.validateBinding();
  const old=target.managedLocations('C:\\Fixture\\Local','0.1.23','C:\\Fixture');
  const next=target.managedLocations('C:\\Fixture\\Local','0.1.24','C:\\Fixture');
  assert.deepEqual(old,next);assert.match(old.command,/\.creator-hub.*router-v2/);
  for(const change of [x=>x.baseline.version='0.1.22',x=>x.baseline.executable.sha256='a'.repeat(64),
    x=>x.target.manifest.modules.mcp.version='2.7.11',x=>x.target.generation='a'.repeat(64),x=>x.target.privateRelease.tag='unreviewed',
    x=>x.target.manifest.managedRouting.files['routing/router.json']='a'.repeat(64)]){
    const bad=structuredClone(b);change(bad);assert.throws(()=>target.validateBindingShape(bad));
  }
});
test('target runner rejects personal hosts and unbound workflow invocation',()=>{
  const b=fixture(),target=load('windows-outgoing-019-target.cjs',{'./fixtures/windows-outgoing-019-binding.json':b});
  assert.throws(()=>target.assertHost({},'win32'));
  assert.throws(()=>target.assertHost({},'linux'));
  assert.throws(()=>target.assertAdmission(process.env,process.platform));
});
test('automatic restart still requires a new physical process and exact 024 PE',async()=>{
  const d=load('windows-outgoing-019-driver.cjs');
  const row={pid:20,parentPid:1,startTicks:'200',image:'C:\\Fixture\\Creator Hub\\creator-hub.exe',kernelIdentityVerified:true};
  let seen=false,verified=false;
  await d.observeAutomaticSuccessor({hub:row.image,previousPid:10,expectedSha256:'a',inventory:()=>[row],hashFile:()=> 'a',
    peVersion:n=>{assert.equal(n,24);return [0,1,24,0]},onObserved:()=>{seen=true},verifyResources:()=>{verified=true},wait:async f=>f()});
  assert.ok(seen&&verified);
  await assert.rejects(d.observeAutomaticSuccessor({hub:row.image,previousPid:20,inventory:()=>[row],wait:async f=>f()}));
});
test('fresh transports use new PIDs even though command paths and versions are identical',()=>{
  const b=fixture(),t=load('windows-outgoing-019-target.cjs',{'./fixtures/windows-outgoing-019-binding.json':b});
  const profile={home:'C:\\Fixture',local:'C:\\Fixture\\Local'};
  const route=t.managedLocations(profile.local,'0.1.23',profile.home);
  const rows=n=>[{pid:n,parentPid:1,startTicks:String(n),image:route.command,kernelIdentityVerified:true},
    {pid:n+1,parentPid:n,startTicks:String(n+1),image:path.join(route.payload,'mcp/server/runtime/node.exe'),kernelIdentityVerified:true}];
  t.assertFreshConnection(rows(10),rows(20),profile);
  assert.throws(()=>t.assertFreshConnection(rows(10),rows(10),profile));
});
test('reader requires unchanged clients and removes migration-success claims',()=>{
  const code=read('windows-outgoing-019-input.cjs');
  assert.match(code,/report\.clientReview,undefined/);assert.match(code,/before\.equals\(after\)/);
  assert.match(code,/report\.clientConnectionsUnchanged,true/);
  assert.doesNotMatch(code,/assertReviewedClientMigration|assertMigrationEvidence/);
  const driver=read('windows-outgoing-019-driver.cjs');
  assert.doesNotMatch(driver,/direct\.migrateExistingClaude|direct\.assertReviewedClientMigration|direct\.assertMigrationEvidence/);
  assert.match(driver,/sdkMetadata=/);assert.match(driver,/lookupNonBlocking=true/);
});

test('SDK lookup accepts strict live or offline outcomes and retries only an unstarted check',async()=>{
  const {checkSdkLookup}=load('windows-outgoing-019-driver.cjs');
  const state=text=>({text,status:'Ready',controlsDisabled:false,buttonDisabled:false,busy:'false',errorVisible:false});
  async function check(initial,terminal,failWait=false) {
    let value=state(initial),clicks=0;const report={};
    const field=selector=>({
      '[data-field="sdk-latest"]':{textContent:value.text},'[data-field="status"]':{textContent:value.status},
      '[data-field="controls"]':{disabled:value.controlsDisabled},'[data-field="sdk-check"]':{disabled:value.buttonDisabled},
      '[data-field="error"]':{hidden:!value.errorVisible},
    })[selector];
    const context={document:{querySelector:selector=>selector==='#feature-mcp'?{querySelector:field,getAttribute:()=>value.busy}:null}};
    const evaluate=fn=>require('node:vm').runInNewContext('('+fn.toString()+')()',context);
    const page={evaluate:async fn=>evaluate(fn),locator:selector=>({click:async()=>{
      assert.equal(selector,'#feature-mcp [data-field="sdk-check"]');clicks++;
    }}),waitForFunction:async fn=>{
      value=terminal;if(failWait){assert.equal(evaluate(fn),false);throw Error('fixture timeout');}
      assert.equal(evaluate(fn),true);
    }};
    const pending=checkSdkLookup(page,report,'after-automatic-update');
    return {pending,report,clicks:()=>clicks};
  }
  for(const text of ['Latest Creator SDK: 4.0.27','Latest SDK could not be checked. Installed versions are still shown below.']) {
    const run=await check(text,state(text));await run.pending;
    assert.equal(run.clicks(),0);assert.equal(run.report.sdkLookups[0].mode,text.startsWith('Latest Creator SDK:')?'live':'offline');
  }
  const retry=await check('Latest Creator SDK not checked.',state('Latest Creator SDK: 4.0.27'));
  await retry.pending;assert.equal(retry.clicks(),1);assert.equal(retry.report.sdkLookups[0].manualRetry,true);
  const inFlight=await check('Checking latest Creator SDK...',state('Latest Creator SDK: 4.0.27'));
  await inFlight.pending;assert.equal(inFlight.clicks(),0);
  for(const invalid of ['Latest Creator SDK: 4.0.27-beta','Latest Creator SDK: 04.0.27','Unknown response']) {
    const bad=await check(invalid,state(invalid));await assert.rejects(bad.pending);
    assert.equal(bad.report.sdkLookups[0].after.text,invalid);
  }
  const locked=await check('Latest Creator SDK: 4.0.27',{...state('Latest Creator SDK: 4.0.27'),controlsDisabled:true});
  await assert.rejects(locked.pending);
  const timeout=await check('Checking latest Creator SDK...',state('Checking latest Creator SDK...'),true);
  await assert.rejects(timeout.pending,/fixture timeout/);assert.equal(timeout.report.sdkLookups[0].after.text,'Checking latest Creator SDK...');
});
test('generated scripts parse including full native PowerShell and inherited helper closures',()=>{
  for(const n of ['windows-outgoing-019-driver.cjs','windows-outgoing-019-target.cjs','windows-outgoing-019-input.cjs',
    'self-update-outgoing-019-feed.cjs','native-outgoing-direct-019.cjs','sdk-registry-denial-023.cjs']) {
    new (require('node:vm').Script)(read(n),{filename:n});
    assert.equal(typeof load(n),'object');
  }
  const {spawnSync}=require('node:child_process');
  const file=path.join(scripts,'native-self-update-outgoing-019.ps1').replaceAll("'","''");
  const r=spawnSync('pwsh',['-NoProfile','-Command',`$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$t,[ref]$e);if($e.Count){$e|Out-String|Write-Error;exit 1}`],{encoding:'utf8',windowsHide:true});
  assert.equal(r.status,0,r.stdout+r.stderr);
});
test('workflow preserves isolated TLS transport and contains no build publish or dispatch',()=>{
  const yaml=require('playwright-core/lib/utilsBundle').yaml;
  const w=yaml.parse(fs.readFileSync(path.join(base,'.github/workflows/windows-outgoing-019.yml'),'utf8'));
  assert.deepEqual(Object.keys(w.jobs),['preflight','acceptance']);assert.equal(w.jobs.acceptance.strategy,undefined);
  assert.equal(w.jobs.acceptance.env.CREATOR_OUTGOING_CASE,'mcp-restore');
  assert.equal(w.jobs.acceptance.env.CREATOR_OUTGOING_LAST_TOOL,'mcp');assert.equal(w.jobs.acceptance.env.CREATOR_OUTGOING_RESTORE,'true');
  const ps=read('native-self-update-outgoing-019.ps1');
  assert.match(ps,/GITHUB_ACTIONS/);assert.match(ps,/RUNNER_ENVIRONMENT/);assert.match(ps,/startLabProxy/);
  assert.match(ps,/baselineVersion -cne '0\.1\.23'/);assert.match(ps,/targetVersion -cne '0\.1\.24'/);
  assert.doesNotMatch(JSON.stringify(w),/gh release|gh workflow|cargo build|npm run build|make_latest/);
});

test('full receipt validates actual captured files and refuses mutation without migration claims',t=>{
  const dir=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'update024-'));
  t.after(()=>{
    const resolved=path.resolve(dir),temp=path.resolve(require('node:os').tmpdir());
    assert.equal(path.dirname(resolved),temp);assert.ok(path.basename(resolved).startsWith('update024-'));
    fs.rmSync(resolved,{recursive:true,force:true});
  });
  const virtualScripts=path.join(dir,'scripts'),captures=path.join(dir,'artifacts/native-suite-123');
  fs.mkdirSync(captures,{recursive:true});
  const binding=fixture(),realTarget=load('windows-outgoing-019-target.cjs',{'./fixtures/windows-outgoing-019-binding.json':binding});
  const config=realTarget.configFor(path.join(dir,'input'));
  const profile={home:path.join(dir,'home'),local:path.join(dir,'home/Local'),roaming:path.join(dir,'home/Roaming')};
  const route=realTarget.managedLocations(profile.local,'0.1.23',profile.home);
  const realDirect=load('native-outgoing-direct-019.cjs');
  const resourceChecks=[];
  const target={...realTarget,assertBound:v=>assert.deepEqual(v,config),assertActiveResources:(local,version,value,current)=>{
    assert.equal(local,profile.local);assert.equal(current,version==='0.1.24');resourceChecks.push(version);
  },assertInstalledResources:(folder,version)=>{assert.equal(folder,path.join(profile.local,'Creator Hub'));assert.equal(version,'0.1.24');resourceChecks.push('installed');}};
  const collector=load('windows-outgoing-019-input.cjs',{'./windows-outgoing-019-target.cjs':target,'./native-outgoing-direct-019.cjs':realDirect,
    './sdk-retention-023.cjs':require(path.join(scripts,'sdk-retention-023.cjs')),'./sdk-registry-denial-023.cjs':load('sdk-registry-denial-023.cjs')},virtualScripts);
  const cap=(file,name,bytes)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);const capture=path.join(captures,name);fs.writeFileSync(capture,bytes);return {file,capture,bytes:bytes.length,sha256:realTarget.hash(bytes)};};
  const clients={};
  const settings=require(path.join(scripts,'sdk-retention-023.cjs')).settings('mcp',true);
  const pairs=[['selected',path.join(profile.home,'.claude.json'),'claude',Buffer.from('{"mcpServers":{"other":{"command":"keep"}}}')],
    ['old',path.join(profile.home,'.gemini/config/mcp_config.json'),'old-client',Buffer.from('{}')],
    ['currentSettings',path.join(profile.roaming,'creator-works-mcp/launcher-config.json'),'settings',Buffer.from(settings)],
    ['oldSettings',path.join(profile.roaming,'banter-mcp/launcher-config.json'),'old-settings',Buffer.from(settings.replaceAll('\n','\r\n'))]];
  clients.afterUpdateCancel={};
  for(const [key,file,name,bytes]of pairs){clients[key+'Before']=cap(file,name+'-before.json',bytes);clients[key+'After']=cap(file,name+'-after.json',bytes);
    if(['selected','old'].includes(key))clients.afterUpdateCancel[key]=cap(file,name+'-update-cancel.json',bytes);}
  const processes=n=>[{pid:n,parentPid:1,image:route.command,startTicks:String(n),kernelIdentityVerified:true},
    {pid:n+1,parentPid:n,image:path.join(route.payload,'mcp/server/runtime/node.exe'),startTicks:String(n+1),kernelIdentityVerified:true}];
  const root=n=>({pid:n,startTicks:String(n),image:path.join(profile.local,'Creator Hub/creator-hub.exe'),kernelIdentityVerified:true});
  const report={kind:target.KIND,sourceCommit:binding.target.source.commit,baseline:config.baseline,pins:config.pins,lastTool:'mcp',restore:true,restoredLastTool:'mcp',profile,clients,
    clientConnectionsUnchanged:true,manualCapabilityRetention:require(path.join(scripts,'sdk-retention-023.cjs')).proof('mcp',true),
    beforePeVersion:[0,1,23,0],afterPeVersion:[0,1,24,0],beforeRoot:root(1),afterRoot:root(2),normalRestartRoot:root(3),beforeNormalRestart:root(2),
    resourceProbe:{phase:'after-automatic-root',attempts:1,passed:true},heldProcessesBefore:processes(10),heldProcessesAfter:processes(10),
    reconnectedProcesses:processes(20),freshOldProcesses:processes(30),heldServerVersion:{version:'2.7.10'},reconnectedServerVersion:{version:'2.7.10'},freshOldServerVersion:{version:'2.7.10'},
    beforeRoute:{generation:binding.baseline.generation},afterRoute:{generation:binding.target.generation},
    sdkMetadata:{checked:[{version:'4.0.25',mismatch:true,profile:'creator',tested:true,filesUnchanged:true},{version:'4.0.27',mismatch:false,profile:'creator',tested:false,filesUnchanged:true}],lookupNonBlocking:true,afterNormalRestartLookupNonBlocking:true},
    sdkLookups:['after-automatic-update','after-normal-restart'].map(phase=>({phase,manualRetry:false,
      before:{text:'Checking latest Creator SDK...'},mode:'offline',after:{text:'Latest SDK could not be checked. Installed versions are still shown below.',
        status:'Ready',controlsDisabled:false,buttonDisabled:false,busy:'false',errorVisible:false}})),
    publicDiscovery:false,liveAiAcceptance:false,releaseReady:false};
  for(const k of ['passed','nativeUpdateAccepted','automaticRestart','cancelPreserved','existingConnectionSurvived','newConnectionVerified','restorationVerified','policyRestored','settingsPreserved','acceptanceOnly','targetMcpRuntimeVerified','installedResourcesVerifiedBeforeAndAfter','heldGenerationRetained','activeRouteUnchangedAfterCancel','normalRestartPreserved','fixtureEvidencePreservedAfterCleanup'])report[k]=true;
  const lifecycle=[{kind:'lab-lifecycle-result',scenario:target.KIND,actualScope:'exact-direct23-to-qualified24-acceptance-fixture-lab-only',lifecycleSucceeded:true,cleanupVerified:true,systemTlsVerified:true,labDiscovery:true,publicDiscovery:false,productAcceptance:false,releaseReady:false,driverExitCode:0,servedRouteCount:5,rejectedRequestCount:0}];
  collector.checkReceipt(report,lifecycle,config,{CREATOR_OUTGOING_CASE:'mcp-restore'});
  assert.deepEqual(resourceChecks,['0.1.23','0.1.24','installed']);
  const live=structuredClone(report);
  for(const e of live.sdkLookups){e.mode='live';e.version='4.0.27';e.after.text='Latest Creator SDK: 4.0.27';}
  collector.checkReceipt(live,lifecycle,config,{CREATOR_OUTGOING_CASE:'mcp-restore'});
  for(const change of [r=>r.clientConnectionsUnchanged=false,r=>r.normalRestartRoot=r.afterRoot,r=>r.sdkMetadata.lookupNonBlocking=false,
    r=>r.sdkLookups[0].mode='live',r=>r.sdkLookups[0].after.controlsDisabled=true,r=>r.sdkLookups[1].phase='after-automatic-update',r=>r.clientReview={approved:true}]){
    const bad=structuredClone(report);change(bad);assert.throws(()=>collector.checkReceipt(bad,lifecycle,config,{CREATOR_OUTGOING_CASE:'mcp-restore'}));}
  fs.writeFileSync(clients.selectedAfter.capture,'changed');
  assert.throws(()=>collector.checkReceipt(report,lifecycle,config,{CREATOR_OUTGOING_CASE:'mcp-restore'}));
});

test('finite feed admits exact 023-to-024 shape and rejects drift without opening a listener',()=>{
  const feed=load('self-update-outgoing-019-feed.cjs'),hash=b=>require('node:crypto').createHash('sha256').update(b).digest('hex');
  const installer=Buffer.from('unit fixture; not a signed installer');
  const signature=Buffer.from('untrusted comment: UNIT FIXTURE ONLY\n');
  const descriptor=Buffer.from(JSON.stringify({schemaVersion:1,appId:'creator-hub',version:'0.1.24',platform:'windows',architecture:'x86_64',packageType:'nsis',assetName:'Creator.Hub_0.1.24_x64-setup.exe',byteLength:installer.length,sha256:hash(installer),executableSha256:'a'.repeat(64),identityProtocol:0,lifecycleProtocol:0,installerProtocol:1,minHubVersion:'0.1.19'}));
  const manifest=Buffer.from(JSON.stringify({version:'0.1.24',notes:'unit only',platforms:{'windows-x86_64':{url:'https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.24/Creator.Hub_0.1.24_x64-setup.exe',signature:signature.toString('base64')}}}));
  const input={targetVersion:'0.1.24',baseline:{version:'0.1.23',installer:'b'.repeat(64),exe:'c'.repeat(64)},descriptor,descriptorSignature:signature,installer,manifest,pins:{descriptor:hash(descriptor),descriptorSignature:hash(signature),installer:hash(installer),manifest:hash(manifest),executable:'a'.repeat(64)}};
  const contract=feed.createDirectOutgoing019Contract(input);
  assert.equal(contract.actualScope.kind,'direct-outgoing-023-024');assert.equal(contract.routes.length,5);
  for(const mutate of [i=>i.baseline.version='0.1.22',i=>i.targetVersion='0.1.25',i=>i.baseline.exe=i.pins.executable,i=>i.installer=Buffer.from('tampered')]){
    const bad=structuredClone(input);mutate(bad);assert.throws(()=>feed.createDirectOutgoing019Contract(bad));
  }
});
