'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const target=require('./public-update-023.cjs');
const binding=target.binding;
function environment(){return {GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',RUNNER_OS:'Windows',RUNNER_ARCH:'X64',
  GITHUB_REPOSITORY:'BOBWORKS-XR/CREATOR-HUB',GITHUB_REPOSITORY_ID:'1364807512',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_JOB:'acceptance',GITHUB_RUN_ATTEMPT:'1',
  GITHUB_REF:`refs/heads/${target.BRANCH}`,GITHUB_WORKFLOW_REF:`BOBWORKS-XR/CREATOR-HUB/.github/workflows/${target.WORKFLOW}@refs/heads/${target.BRANCH}`,
  GITHUB_SHA:'a'.repeat(40),EXPECTED_HARNESS_COMMIT:'a'.repeat(40),CREATOR_PUBLIC_BINDING_SHA256:target.bindingSha256,
  CREATOR_OUTGOING_CASE:'mcp-restore',CREATOR_OUTGOING_LAST_TOOL:'mcp',CREATOR_OUTGOING_RESTORE:'true'};}
function feed(){const p=binding.publication;return Buffer.from(JSON.stringify([
  {id:p.releaseId,tag_name:p.tag,draft:false,prerelease:false,assets:Object.entries(p.assets).map(([name,a])=>({name,id:a.id,size:a.size,digest:`sha256:${a.sha256}`,state:'uploaded',browser_download_url:target.url('0.1.23',name)}))},
  {id:binding.baseline.releaseId,tag_name:'v0.1.22',draft:false,prerelease:false,assets:[{name:target.BASELINE_ASSET,id:binding.baseline.assetId,size:binding.baseline.installer.bytes,digest:`sha256:${binding.baseline.installer.sha256}`,browser_download_url:target.url('0.1.22',target.BASELINE_ASSET)}]}
]));}
test('exact four-asset R17 public binding and immutable022 accepted',()=>{target.validateBinding();assert.equal(target.checkRelease(feed()).previousStable,'0.1.22');});
test('public host admission accepts only bound Windows runner',()=>{target.assertAdmission(environment(),'win32');assert.throws(()=>target.assertAdmission(environment(),'linux'));assert.throws(()=>target.assertAdmission({...environment(),GITHUB_SHA:'b'.repeat(40)},'win32'));});
for(const name of ['HTTPS_PROXY','http_proxy','GH_TOKEN','GITHUB_TOKEN','NODE_EXTRA_CA_CERTS','CREATOR_SELF_UPDATE_LAB_CONFIG','CREATOR_HOSTED_UPDATE_FIXTURE'])test(`refuses ${name}`,()=>assert.throws(()=>target.assertAdmission({...environment(),[name]:'forbidden'},'win32')));
for(const change of ['private','draft','asset','old','newer'])test(`refuses ${change} feed`,()=>{const a=JSON.parse(feed());if(change==='private')a[0].id=447044552;if(change==='draft')a[0].draft=true;if(change==='asset')a[0].assets[0].digest='sha256:'+'0'.repeat(64);if(change==='old')a[1].assets[0].id++;if(change==='newer')a.push({tag_name:'v0.1.24',draft:false,prerelease:false,assets:[]});assert.throws(()=>target.checkRelease(Buffer.from(JSON.stringify(a))));});
test('public downloader refuses private or arbitrary route before fetch',async()=>{let called=false;await assert.rejects(target.publicBytes('https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases/assets/123',100,()=>{called=true;}));assert.equal(called,false);});
test('anonymous download is bounded and carries no authorization',async()=>{let opts;const body=await target.publicBytes(target.FEED,3,async(u,o)=>{opts=o;return {ok:true,body:[Buffer.from('abc')]};});assert.equal(body.toString(),'abc');assert.deepEqual(Object.keys(opts.headers),['User-Agent']);await assert.rejects(target.publicBytes(target.FEED,2,async()=>({ok:true,body:[Buffer.from('abc')]})));});
test('public notes retain exact installer signature/url',()=>{assert.equal(binding.target.latest.sha256,'f33a4db80c4d9f3d0ce4b413b4f3485a7b529e6aa428026b6cf7aedc54e3ec32');assert.equal(binding.originalLatest.platforms['windows-x86_64'].url,target.url('0.1.23',target.ASSET));});
test('driver remains parsed native flow without proxy or version fixture',()=>{const code=fs.readFileSync(path.join(__dirname,'native-public-update-023.cjs'),'utf8');new vm.Script(code);assert.doesNotMatch(code,/CREATOR_SELF_UPDATE_LAB_|startLabProxy/);for(const s of ["button('Not now')","button('Update Hub')","native('close')",'observeAutomaticSuccessor','codexBeforeSha256','codexAfterSha256',"page.locator('#check-updates').click()"] )assert.ok(code.includes(s),s);});
test('normal restart remains separate from automatic replacement',()=>{const code=fs.readFileSync(path.join(__dirname,'native-public-update-023.cjs'),'utf8');assert.ok(code.indexOf('observeAutomaticSuccessor({ hub')<code.indexOf('report.beforeNormalRestart = rootRecord'));assert.equal((code.match(/child = spawn\(hub/g)||[]).length,2);});
