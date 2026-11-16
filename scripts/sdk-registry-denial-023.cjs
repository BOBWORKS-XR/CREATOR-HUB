'use strict';
const assert=require('node:assert/strict');
function verifySdkRegistryDenial(lifecycle,report) {
  for(const k of ['rejectionOverflow','connectDiagnosticOverflow','connectTraceOverflow'])assert.equal(lifecycle[k]??0,0,k);
  const count=lifecycle.rejectedRequestCount;assert.ok(Number.isInteger(count)&&count>=0&&count<=6);
  const rows=v=>Array.isArray(v)?v:v==null?[]:[v];
  if(!count){for(const k of ['rejectionSummary','connectDiagnostics','connectTrace'])assert.deepEqual(rows(lifecycle[k]),[]);return;}
  assert.deepEqual(rows(lifecycle.rejectionSummary),[{kind:'connect-policy',code:null,count}]);
  assert.deepEqual(rows(lifecycle.connectDiagnostics),[{authority:'[redacted]',headPresent:false,singleHost:true,duplicateHost:false,hostHeaderMatchesAuthority:false,sensitiveHeadersPresent:false,count}]);
  const traces=rows(lifecycle.connectTrace);assert.equal(traces.length,count);const seen=new Map();
  for(const t of traces){assert.deepEqual(t.target,{kind:'dns',host:'greenfield-registry.sdq.st',port:443});assert.equal(t.hostHeaderMatchesAuthority,true);
    for(const p of [t.clientPort,t.proxyPort])assert.ok(Number.isInteger(p)&&p>=1&&p<=65535);assert.notEqual(t.clientPort,t.proxyPort);
    assert.equal(t.owner.status,'observed');assert.equal(t.owner.processes.length,1);const p=t.owner.processes[0];
    const r=[report.beforeRoot,report.afterRoot,report.normalRestartRoot].find(r=>r.pid===p.pid);assert.ok(r&&r.kernelIdentityVerified);
    assert.deepEqual(p,{pid:r.pid,parentPid:r.parentPid,image:r.image});const n=(seen.get(r.pid)||0)+1;seen.set(r.pid,n);assert.ok(n<=2);}
  return {expectedSdkRegistryDenials:count,unexpectedDenials:0,sdkRegistryConnectionAdmitted:false};
}
module.exports={verifySdkRegistryDenial};
