'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {checkSettings,checkClient,checkStoppedRecord}=require('./evidence.cjs');
const bytes=x=>Buffer.from(JSON.stringify(x));
function fixture(){
 const a={active_channel_id:'a',channels:[{id:'a',unity_project_path:'C:\\projects\\a'}],mcp_server_path:'C:\\missing.mjs',future:{keep:true},auto_start:false};
 const b={...a,active_channel_id:'b',channels:[{id:'b',unity_project_path:'C:\\projects\\b'}],future:{keep:false}};
 const merged={...a,channels:[...a.channels,...b.channels]};return{a,b,merged};
}
test('cancel keeps the reviewed project merge and current preferences, without changing the runtime path',()=>{
 const {a,b,merged}=fixture();checkSettings(bytes(a),bytes(b),bytes(merged),bytes(merged),a.mcp_server_path);
 for(const mutate of [v=>v.future.keep=false,v=>v.auto_start=true,v=>v.channels.pop(),v=>v.channels.push(v.channels[0]),v=>v.mcp_server_path='C:\\unapproved.mjs',v=>v.active_channel_id='b']){
  const changed=structuredClone(merged);mutate(changed);assert.throws(()=>checkSettings(bytes(a),bytes(b),bytes(changed),bytes(merged),a.mcp_server_path));
 }
});
test('approval only changes the reviewed runtime path and preserves all other preferences',()=>{
 const {a,b,merged}=fixture();merged.mcp_server_path='C:\\approved.mjs';checkSettings(bytes(a),bytes(b),bytes(merged),bytes(merged),merged.mcp_server_path);
 assert.throws(()=>checkSettings(bytes(a),bytes(b),bytes(merged),bytes(b),merged.mcp_server_path));
});
test('client review permits only routing fields and preserves unrelated connections',()=>{
 const before={mcpServers:{'creator-works':{command:'old',args:['old.mjs'],env:{KEEP:'exact'},timeout:37},other:{command:'keep'}},preferences:{keep:true}};
 const after=structuredClone(before);Object.assign(after.mcpServers['creator-works'],{command:'router',args:[],env:{KEEP:'exact',CREATOR_WORKS_CONFIG_OWNER:'creator-hub-v1',CREATOR_WORKS_LAUNCHER_CONFIG:'current'}});
 checkClient(bytes(before),bytes(after),'router');after.mcpServers.other.command='changed';assert.throws(()=>checkClient(bytes(before),bytes(after),'router'));
});
test('cleanly stopped journal differs from an interrupted or completed one',()=>{
 checkStoppedRecord(bytes({phase:'connections',outcome:'stopped',retry_blocked:false}));
 for(const value of [{phase:'cleanup',outcome:'complete',retry_blocked:false},{phase:'connections',outcome:'stopped',retry_blocked:true}])assert.throws(()=>checkStoppedRecord(bytes(value)));
});
