'use strict';
const assert=require('node:assert/strict');
function check(r,binding,phase,view,verifyProcesses) {
  assert.equal(r.phase,phase);assert.equal(r.view,view);assert.equal(r.configUnchanged,true);
  assert.equal(r.version,binding.target.manifest.modules.mcp.version,'First unassisted client used the wrong runtime');
  assert.equal(r.generation,binding.target.generation,'Wrong generation before review');
  assert.equal(r.roundTrip,true,'No successful MCP tool response');verifyProcesses(r.processes);
}
async function observe({phase,view,selectedBefore,specBytes,command,open,roundTrip,inspect,active,binding,verifyProcesses,record}) {
  const r={phase,view};
  let client;
  try {
    const bytes=specBytes();r.configUnchanged=bytes.equals(selectedBefore);assert.equal(r.configUnchanged,true);
    const spec=JSON.parse(bytes).mcpServers['creator-works'];assert.equal(spec.command,command);
    const session=open(spec);client=session.client;await client.connect(session.transport);
    r.version=client.getServerVersion().version;await roundTrip(client);r.roundTrip=true;
    // Record the actual selector even when it is old. Do not run a repair, retry the client, or click review.
    r.generation=active();
    assert.equal(r.version,binding.target.manifest.modules.mcp.version,'First unassisted client used the wrong runtime');
    r.processes=await inspect(session.transport);check(r,binding,phase,view,verifyProcesses);
    return r;
  } finally {
    try { if(client)await client.close(); } finally {record(r);}
  }
}
module.exports={check,observe};
