import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AgentHub, AgentJob } from "../apps/discord/agent-hub.js";
import { AgentRuntime } from "../apps/discord/agent-runtime.js";
import { AgentHostExecutor, AgentTerminal } from "../apps/discord/agent-client.js";
import { readPtyClient } from "../apps/discord/pty-client.js";

test("real agent HTTP + native provider: creation, Unicode files, diagnostics, reconnect, no replay, close", {skip:process.env.REMOTE_OPERATOR_LIVE_TESTS!=="1"||!["win32","linux"].includes(process.platform),timeout:60_000}, async()=>{
  const windows=process.platform==="win32";
  const parent=resolve(".discord-bridge/tests");mkdirSync(parent,{recursive:true});const state=mkdtempSync(join(parent,"agent-"));
  const project=join(state,"Dự án spaces");mkdirSync(project);
  const hub=new AgentHub(join(state,"hub.json"),"700000000000000001","700000000000000002");
  const pair=hub.enroll(hub.issuePair(),"test",windows?"win32":"linux",project);const machine=hub.authenticate(pair.machine,pair.token);
  const server=await hub.listen(0);const address=server.address();assert.ok(address&&typeof address!=="string");
  const url=`http://127.0.0.1:${address.port}`;
  let runtime=await AgentRuntime.start(machine.id,state,project), stopped=false;
  async function post(path:string,body:Record<string,unknown>){const r=await fetch(url+path,{method:"POST",headers:{authorization:`Bearer ${pair.token}`},body:JSON.stringify({machine:machine.id,...body})});assert.equal(r.status,200);return (await r.json() as {result:unknown}).result;}
  const loop=(async()=>{while(!stopped){const jobs=await post("/poll",{snapshot:await runtime.snapshot()}) as AgentJob[];for(const job of jobs){void runtime.dispatch(job).then(result=>post("/result",{id:job.id,result}),()=>post("/result",{id:job.id,error:"operation failed"}));}await delay(30);}})();
  let terminal:AgentTerminal|undefined;
  try {
    while(!hub.online(machine.id))await delay(20);
    const executor=new AgentHostExecutor(machine,hub);await executor.profile(project);
    terminal=await executor.create("shell",project,"test:agent");
    await terminal.send(windows?"[Console]::WriteLine(('AGENT_RESULT_' + (7*13)))":"printf 'AGENT_RESULT_%s\\n' $((7*13))");
    for(let i=0;i<60;i++){if((await terminal.output(40)).includes('AGENT_RESULT_91'))break;await delay(100);}
    assert.ok((await terminal.output(40)).includes('AGENT_RESULT_91'));
    await executor.writeFile('.discord-bridge/inbox/test-0-request.txt',Buffer.from('Tiếng Việt'),project);
    assert.equal(readFileSync(join(project,'.discord-bridge/inbox/test-0-request.txt'),'utf8'),'Tiếng Việt');
    assert.equal((await executor.run(windows?'[Console]::Write(6*7)':"printf %s $((6*7))",1000,project)).stdout,'42');
    const originalId=terminal.record.id;const supervisor=readPtyClient(state);
    const previousGeneration=runtime.generation;
    runtime=await AgentRuntime.start(machine.id,state,project);
    assert.notEqual(runtime.generation,previousGeneration);
    await delay(100);
    if(supervisor)assert.equal(readPtyClient(state)!.endpoint.pid,supervisor.endpoint.pid);
    assert.ok((await runtime.snapshot()).terminals.some(r=>r.id===originalId));
    await terminal.send(windows?"[Console]::WriteLine(('RECONNECTED_' + (4*4)))":"printf 'RECONNECTED_%s\\n' $((4*4))");
    for(let i=0;i<60;i++){if((await terminal.output(40)).includes('RECONNECTED_16'))break;await delay(100);}
    assert.ok((await terminal.output(40)).includes('RECONNECTED_16'));
    const job:AgentJob={id:'a'.repeat(32),machine:machine.id,generation:runtime.generation,deadline:Date.now()+5000,op:'run',args:{command:windows?'[Console]::Write(1)':'printf 1',timeoutMs:1000,cwd:project}};
    await runtime.dispatch(job);await assert.rejects(runtime.dispatch(job));
    await assert.rejects(runtime.dispatch({...job,id:'b'.repeat(32),generation:previousGeneration}));
    await terminal.stop();if(windows)assert.match(await terminal.status(),/alive=false/);else await assert.rejects(terminal.status());
    if(!windows){
      const replacement=await executor.create("shell",project,"test:replacement");
      try { await assert.rejects(terminal.send("printf MUST_NOT_RUN")); assert.ok(!(await replacement.output(40)).includes("MUST_NOT_RUN")); }
      finally { await replacement.stop(); }
    }
    await executor.removeFile('.discord-bridge/inbox/test-0-request.txt',project);
    hub.revoke(machine.id);await assert.rejects(terminal.send('must not execute'),/offline/);
  } finally {
    if(terminal && hub.online(machine.id))await terminal.stop().catch(()=>{});
    stopped=true;await loop.catch(()=>{});hub.close();await new Promise<void>(done=>server.close(()=>done()));
    const supervisor=readPtyClient(state);if(supervisor)process.kill(supervisor.endpoint.pid);
    await delay(600);assert.ok(state.startsWith(parent+sep));rmSync(state,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
});
