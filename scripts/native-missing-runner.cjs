'use strict';
// Installs only on an admitted disposable GitHub-hosted runner.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const target=require('./windows-outgoing-019-target.cjs'),hooks=require('./missing-server.cjs'),proof=require('./evidence.cjs');
const ROOT=path.resolve(__dirname,'..');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function retry(fn,seconds=40){let error;for(const end=Date.now()+seconds*1000;Date.now()<end;await delay(250))try{return await fn();}catch(e){error=e;}throw error||Error('Timed out');}
async function main(){
  target.assertHost();assert.equal(process.env.EXPECTED_HARNESS_COMMIT,process.env.GITHUB_SHA);
  const caseName=process.env.CREATOR_MISSING_CASE;assert.ok(['fresh-025-approve','fresh-025-cancel','stopped-024-upgrade'].includes(caseName));
  const binding=target.binding;
  const local=process.env.LOCALAPPDATA,roaming=process.env.APPDATA,home=process.env.USERPROFILE;
  for(const p of [local,roaming,home])assert.ok(path.win32.isAbsolute(p));
  for(const p of [path.join(local,'Creator Hub'),path.join(local,'CreatorHub'),path.join(home,'.creator-hub'),path.join(roaming,'creator-works-mcp'),path.join(roaming,'banter-mcp'),path.join(home,'.claude.json'),path.join(home,'.codex/config.toml')])assert.equal(fs.existsSync(p),false,'Nonempty profile refused: '+p);
  const data=path.join(ROOT,'artifacts/outgoing-019/data'),hub=path.join(local,'Creator Hub/creator-hub.exe');
  const out=path.join(ROOT,'artifacts','native-suite-'+Date.now());fs.mkdirSync(out,{recursive:true});
  const ps=(name,args=[])=>execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(ROOT,'scripts',name),...args],{encoding:'utf8',windowsHide:true,timeout:30000});
  const inventory=()=>JSON.parse(ps('native-outgoing-process-019.ps1').replace(/^\uFEFF/,''));
  const record=pid=>{const rows=inventory().filter(r=>r.pid===pid);assert.equal(rows.length,1);assert.equal(rows[0].kernelIdentityVerified,true);return rows[0];};
  const hashFile=p=>proof.hash(hooks.plain(p,512*1024*1024));
  let processRecord,browser,page,policyEnabled=false,currentVersion;
  const report={passed:false,case:caseName,fixtureOnly:true,harnessSource:process.env.GITHUB_SHA,targetSource:binding.target.source,qualificationSha256:binding.target.verificationReceiptSha256};
  const native=(action,value)=>{assert.deepEqual(record(processRecord.pid),processRecord);return ps('native-window.ps1',['-TargetPid',String(processRecord.pid),'-ExpectedExecutable',hub,'-Action',action,...(value?['-Value',value]:[])]);};
  const {chromium}=require('@playwright/test');
  const {assertOwnedDebugging}=require('./windows-incoming-016.cjs');
  const c={admitted:true,case:caseName,local,roaming,home,out,targetRootSha256:binding.target.executable.sha256,
    router:target.managedLocations(local,'0.1.25',home).command,
    server:path.join(target.managedLocations(local,'0.1.25',home).payload,'mcp/server/creator-works-mcp.mjs')};
  c.assertRoot=async(version,pin)=>{assert.equal(currentVersion,version);assert.deepEqual(record(processRecord.pid),processRecord);assert.equal(hashFile(hub),pin);target.assertInstalledResources(path.dirname(hub),version);assert.equal(await page.evaluate(()=>CreatorHubNative.version),version);};
  c.nativeTrace=()=>page.evaluate(()=>window.__missingNativeCalls);
  c.chooseNative=async(title,button,optional=false)=>{
    const choose=()=>{const windows=JSON.parse(native('snapshot'));const match=windows.filter(w=>w.title===title);assert.equal(match.length,1,'Missing exact dialog: '+title);assert.ok(match[0].controls.some(r=>r.name===button));native('button',button);};
    if(optional){choose();return;}await retry(choose,50);
  };
  c.waitMoveComplete=async()=>{await page.waitForFunction(()=>{const d=document.querySelector('#convergence-dialog');return d?.open&&d.getAttribute('aria-busy')==='false'&&document.querySelector('#convergence-title')?.textContent==='Move complete';},null,{timeout:90000});};
  async function launch(version){
    const child=spawn(hub,[],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9238'}});
    processRecord=await retry(()=>record(child.pid));currentVersion=version;
    const debug=()=>assertOwnedDebugging(JSON.parse(ps('native-startup-diagnostics.ps1').replace(/^\uFEFF/,'')),processRecord.pid,hub);
    await retry(debug,90);browser=await retry(()=>chromium.connectOverCDP('http://127.0.0.1:9238'),90);debug();
    page=await retry(()=>{const p=browser.contexts().flatMap(x=>x.pages()).find(x=>x.url().includes('tauri.localhost'));assert.ok(p);return p;});
    await page.addInitScript(()=>{let native;window.__missingNativeCalls=[];Object.defineProperty(window,'CreatorHubNative',{configurable:true,get:()=>native,set:value=>{native=Object.freeze({...value,invoke(command,args){window.__missingNativeCalls.push({command});return value.invoke(command,args);}});}});});
    await page.reload();await page.waitForFunction(()=>window.CreatorHubNative);c.page=page;
    await page.waitForFunction(()=>document.querySelector('#usage-terms-dialog')?.open||document.querySelector('#convergence-dialog')?.open||!document.querySelector('#check-updates')?.disabled,null,{timeout:90000});
    if(await page.locator('#usage-terms-dialog').isVisible()){await page.locator('#usage-terms-checkbox').check();await page.locator('#usage-terms-continue').click();}
    await page.waitForFunction(()=>document.querySelector('#convergence-dialog')?.open||!document.querySelector('#check-updates')?.disabled,null,{timeout:90000});
    await c.assertRoot(version,version==='0.1.24'?binding.baseline.executable.sha256:binding.target.executable.sha256);
  }
  async function close(){const before=processRecord;native('close');await retry(()=>assert.equal(inventory().some(p=>p.pid===before.pid&&p.startTicks===before.startTicks),false));processRecord=null;await browser.close();browser=null;page=null;return before;}
  c.normalRestart=async()=>{const before=await close();await launch('0.1.25');const after=processRecord;assert.notEqual(before.pid,after.pid);return{before,after};};
  c.readOnlyHandshake=async entry=>{
    assert.equal(entry.command,c.router);assert.deepEqual(entry.args,[]);
    const {Client}=require(path.join(ROOT,'product/modules/mcp/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js'));
    const {StdioClientTransport}=require(path.join(ROOT,'product/modules/mcp/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js'));
    const client=new Client({name:'missing-server-acceptance',version:'1.0.0'},{capabilities:{}});
    const transport=new StdioClientTransport({command:entry.command,args:entry.args,env:{...process.env,...entry.env},stderr:'ignore'});
    try{await client.connect(transport);assert.equal(client.getServerVersion().version,'2.7.10');const r=await client.callTool({name:'get_mcp_reference',arguments:{source:'graph-performance',query:'FixedUpdate',limit:1}});assert.notEqual(r.isError,true);assert.equal(JSON.parse(r.content[0].text).success,true);return{source:'saved-client',serverVersion:'2.7.10',tool:'get_mcp_reference',success:true};}finally{await client.close();}
  };
  function install(version){const pin=version==='0.1.24'?binding.baseline.installer:binding.target.installer,file=path.join(data,`Creator.Hub_${version}_x64-setup.exe`);assert.equal(hashFile(file),pin.sha256);execFileSync(file,['/S','/NS'],{windowsHide:true,timeout:180000,stdio:'pipe'});target.assertInstalledResources(path.dirname(hub),version);}
  try{
    assert.equal(inventory().some(r=>/creator-hub\.exe$/i.test(r.image)),false);
    hooks.seed(c);install(caseName==='stopped-024-upgrade'?'0.1.24':'0.1.25');
    policyEnabled=true;ps('native-webview-policy.ps1',['-Action','Enable','-StateFile',path.join(out,'webview-policy.json')]);
    if(caseName==='stopped-024-upgrade'){await launch('0.1.24');await hooks.produce024(c);await close();install('0.1.25');}
    await launch('0.1.25');await hooks.recover025(c);await hooks.finish(c);
    proof.verifyRegression(c.regression,name=>hooks.plain(path.join(out,name)),{baseline:{executableSha256:binding.baseline.executable.sha256}});
    report.regression=c.regression;report.passed=true;
  }catch(e){report.error=String(e.stack||e);report.regression=c.regression;try{if(page)await page.screenshot({path:path.join(out,'failure.png')});}catch{}}
  finally{
    try{if(processRecord)await close();report.rootClosed=true;}catch(e){report.passed=false;report.cleanupError=String(e);}
    try{if(policyEnabled)ps('native-webview-policy.ps1',['-Action','Restore','-StateFile',path.join(out,'webview-policy.json')]);report.policyRestored=true;}catch(e){report.passed=false;report.policyError=String(e);}
    fs.writeFileSync(path.join(out,'missing-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  }
  console.log(JSON.stringify({passed:report.passed,out}));assert.equal(report.passed,true,report.error||report.cleanupError);
}
module.exports={main};if(require.main===module)main().catch(e=>{console.error(String(e.stack||e).slice(0,12000));process.exitCode=1;});
