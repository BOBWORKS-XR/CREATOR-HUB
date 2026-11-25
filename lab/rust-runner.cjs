'use strict';
const fs=require('node:fs'),p=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),cp=require('node:child_process');
const src=p.resolve('product'),lab=p.resolve('harness/lab'),bind=JSON.parse(fs.readFileSync(p.join(lab,'binding.json'))),repo='BOBWORKS-XR/CREATOR-HUB',out=p.resolve('native-results');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),read=f=>fs.readFileSync(f),wf=p.resolve('harness/.github/workflows/windows-outgoing-019.yml');
const exec=(cmd,args,opts={})=>cp.execFileSync(cmd,args,{windowsHide:true,maxBuffer:100*1024*1024,timeout:240000,...opts});
const mf=p.join(lab,'manifest.json'),manifest=JSON.parse(read(mf)),tmp='D:\\t28',stage='D:\\s28';
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.env.GITHUB_REPOSITORY,repo);assert.equal(process.env.GITHUB_REF,'refs/heads/codex/windows-028-revised-1795607720993-rust-fixtures');
assert.equal(exec('git',['rev-parse','HEAD'],{cwd:src}).toString().trim(),bind.source);
assert.equal(exec('git',['rev-parse','HEAD^{tree}'],{cwd:src}).toString().trim(),bind.tree);
assert.equal(exec('git',['rev-parse','HEAD'],{cwd:p.dirname(lab)}).toString().trim(),process.env.GITHUB_SHA);
assert.equal(sha(read(mf)),bind.manifest);assert.ok(read(wf).includes(bind.source));
const put=(f,v)=>fs.writeFileSync(f,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
if(process.argv[2]==='prepare'){
  fs.mkdirSync(out);fs.mkdirSync(stage);fs.mkdirSync(tmp);
  const root='repos/'+repo+'/releases/',r=JSON.parse(exec('gh',['api',root+bind.id]));
  assert.equal(r.draft,true);assert.equal(r.published_at,null);assert.equal(r.target_commitish,bind.source);assert.equal(r.tag_name,bind.tag);
  const a=r.assets.find(x=>x.id===bind.asset);assert.equal(a.digest,'sha256:'+bind.installer);
  const bytes=exec('gh',['api',root+'assets/'+bind.asset,'-H','Accept: application/octet-stream']);assert.equal(sha(bytes),bind.installer);assert.equal(bytes.length,a.size);
  const input=p.join(stage,'input.exe');fs.writeFileSync(input,bytes,{flag:'wx'});
  exec('7z',['x','-y','-o'+stage,input]);
  const confRoot=p.join(src,'modules/mcp/launcher/src-tauri'),release=p.join(src,'modules/mcp/release');
  const conf=JSON.parse(read(p.join(confRoot,'tauri.conf.json'))),entries=Object.entries(conf.bundle.resources);
  assert.equal(entries.length,9);
  for(const [declared,name] of entries){
    const f=p.resolve(confRoot,declared),rel='mcp/'+(name==='server/runtime/node'?'server/runtime/node.exe':name);
    const hash=manifest.modules.mcp.files[rel],b=read(p.join(stage,'modules',rel));assert.equal(sha(b),hash);
    if(f.startsWith(release+p.sep)&&!fs.existsSync(f)){fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,b,{flag:'wx'});}
    assert.equal(sha(read(f)),hash);
  }
  put(p.join(out,'inputs.json'),{...bind,harness:process.env.GITHUB_SHA,resources:entries.length});return;
}
assert.equal(process.argv[2],'test');assert.ok(!Object.hasOwn(process.env,'GH_TOKEN'));
const env={...process.env,TEMP:tmp,TMP:tmp,CARGO_TARGET_DIR:'D:\\r28',CREATOR_BUILTIN_MANIFEST:mf,CREATOR_HUB_INTEGRATED_MCP_PAYLOAD:p.join(stage,'modules/mcp/server'),CREATOR_MCP_HOST_WRITABLE:'1',CREATOR_MCP_HOST_READONLY_EVENTS:'1'};
const hub=['--manifest-path','src-tauri/Cargo.toml','--features','integrated-features'],mcp=['--manifest-path','modules/mcp/launcher/src-tauri/Cargo.toml','--features','integrated-service','--lib'];
const runs=[['witness',[...hub,'convergence::stores::tests::convergence_backup_cannot_cross_store_identity','--','--exact','--test-threads=1'],1],['hub',[...hub,'--','--test-threads=1'],538],['migration',[...mcp,'client_migration::','--','--test-threads=1'],65],['scope',[...mcp,'client_config_status::','--','--test-threads=1'],5],['connection',[...mcp,'project_connection::','--','--test-threads=1'],1]];
const rows=[];for(const [name,args,min] of runs){
  const f=p.join(out,name+'.log'),fd=fs.openSync(f,'wx');let result;
  try{result=cp.spawnSync('cargo',['+1.99.0','test','--release','--locked',...args],{cwd:src,env,stdio:['ignore',fd,fd],windowsHide:true,timeout:3000000});}finally{fs.closeSync(fd);}
  const log=read(f).toString(),m=/test result: ok\. (\d+) passed; 0 failed; (\d+) ignored;/.exec(log);
  const row={name,exit:result.status,count:Number(m?.[1]??0),ignored:Number(m?.[2]??0),passed:!result.error&&result.status===0&&Number(m?.[1])>=min,logSha256:sha(read(f))};
  rows.push(row);put(p.join(out,name+'.json'),row);console.log(row);
  if(!row.passed&&!log.includes('running 1 test')&&!log.includes('running 552 tests'))break;
}
const passed=rows.length===runs.length&&rows.every(r=>r.passed);put(p.join(out,'result.json'),{...bind,harness:process.env.GITHUB_SHA,passed,rows});if(!passed)process.exitCode=1;
