import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHub, AgentVscodeSession, coordinatorUrl, validSnapshot } from "../apps/discord/agent-hub.js";

const guild = "700000000000000001", owner = "700000000000000002";
function fixture() { const root = mkdtempSync(join(tmpdir(), "agent-hub-")); const hub = new AgentHub(join(root, "agents.json"), guild, owner); return { root, hub, cleanup() { hub.close(); rmSync(root, {recursive:true,force:true}); } }; }
test("external VS Code snapshot is optional, bounded, machine scoped and separate from owned terminals", () => {
  const f = fixture();
  try {
    const pair = f.hub.enroll(f.hub.issuePair(), "windows-workstation", "win32", "D:\\Project"), machine = f.hub.authenticate(pair.machine, pair.token);
    const record: AgentVscodeSession = { id:"vsc-"+"a".repeat(16)+"-12345678", machine:machine.id, label:"existing Codex", cwd:"D:\\Project",
      instance:"a".repeat(16), generation:"b".repeat(32), pid:1234, alive:true, shared:true, platform:"win32", remote:false, sourceMachine:"windows-workstation", cwdSource:"shellIntegration", inputProtocol:"paced-submit-v1" };
    const snapshot = { generation:"c".repeat(32), terminals:[], vscode:[record] };
    assert.equal(validSnapshot({ generation:snapshot.generation, terminals:[] }, machine), true);
    assert.equal(validSnapshot(snapshot, machine), true);
    assert.equal(validSnapshot({ ...snapshot, vscode:[{ ...record, machine:"agent-"+"f".repeat(16) }] }, machine), false);
    assert.equal(validSnapshot({ ...snapshot, vscode:[record, record] }, machine), false);
    assert.equal(validSnapshot({ ...snapshot, vscode:Array(257).fill(record) }, machine), false);
    assert.equal(validSnapshot({ ...snapshot, vscode:null }, machine), false);
    assert.equal(validSnapshot({ ...snapshot, vscode:[null] }, machine), false);
    assert.equal(validSnapshot({ ...snapshot, terminals:[null] }, machine), false);
    for (const changes of [{ instance:"d".repeat(16) }, { generation:"old" }, { pid:-1 }, { platform:"linux" }, { cwd:"/datasets/project" }, { cwdSource:"guess" }, { sourceMachine:"x\nwrong" }, { inputProtocol:undefined }, { inputProtocol:"legacy" }]) {
      assert.equal(validSnapshot({ ...snapshot, vscode:[{ ...record, ...changes }] }, machine), false);
    }
    assert.equal(validSnapshot({ ...snapshot, vscode:[{ ...record, remote:true, cwd:"/datasets/project" }] }, machine), true);
    assert.equal(validSnapshot({ ...snapshot, vscode:[{ ...record, cwd:null }] }, machine), true);
    assert.equal(validSnapshot({ ...snapshot, vscode:[{ ...record, shared:false, inputProtocol:undefined }] }, machine), true);
    f.hub.poll(machine, snapshot);
    const presence = f.hub.presence()[0];
    assert.equal(presence.terminalCount, 0); assert.equal(presence.vscodeCount, 1); assert.equal(presence.sharedVscodeCount, 1);
    f.hub.poll(machine, { ...snapshot, vscode:[{ ...record, shared:false }] });
    assert.equal(f.hub.presence()[0].vscodeCount, 1); assert.equal(f.hub.presence()[0].sharedVscodeCount, 0);
  } finally { f.cleanup(); }
});
test("agent presence reports current connectivity without credentials or stale online status", () => {
  const f = fixture();
  try {
    const pair = f.hub.enroll(f.hub.issuePair(), "windows-workstation", "win32", "D:\\Project");
    const machine = f.hub.authenticate(pair.machine, pair.token);
    assert.deepEqual(f.hub.presence(), [{ id: machine.id, label: "windows-workstation", platform: "win32", cwd: "D:\\Project", online: false, lastSeen: null, terminalCount: 0 }]);
    f.hub.poll(machine, { generation: "a".repeat(32), terminals: [{ id: "pty-" + "b".repeat(32), machine: machine.id, label: "terminal", cwd: "D:\\Project", kind: "shell", generation: "c".repeat(32) }] });
    const live = f.hub.presence()[0];
    assert.equal(live.online, true);
    assert.equal(live.terminalCount, 1);
    assert.equal(f.hub.online(machine.id, live.lastSeen!), true);
    assert.equal(f.hub.online(machine.id, live.lastSeen! - 1), false);
    assert.equal(f.hub.presence(live.lastSeen! - 1)[0].online, false);
    assert.equal(f.hub.online(machine.id, live.lastSeen! + 8000), false);
    assert.equal(f.hub.presence(live.lastSeen! + 8000)[0].online, false);
    assert.ok(!JSON.stringify(live).includes(pair.token));
    assert.ok(!JSON.stringify(live).includes(machine.tokenHash));
    assert.equal(new AgentHub(f.hub.file, guild, owner).presence()[0].online, false);
    f.hub.revoke(machine.id);
    assert.deepEqual(f.hub.presence(), []);
  } finally { f.cleanup(); }
});
test("pairing is single-use, scoped, hashed at rest and revocable across restarts", () => {
  const f=fixture(); try {
    const code=f.hub.issuePair(); const pair=f.hub.enroll(code,"Windows","win32","D:\\Project");
    assert.throws(()=>f.hub.enroll(code,"other","linux","/tmp"));
    assert.ok(!readFileSync(f.hub.file,"utf8").includes(pair.token));
    assert.ok(!readFileSync(f.hub.file,"utf8").includes(code));
    const restored=new AgentHub(f.hub.file,guild,owner);
    assert.equal(restored.authenticate(pair.machine,pair.token).platform,"win32");
    assert.throws(()=>restored.authenticate(pair.machine,"wrong"));
    assert.throws(()=>new AgentHub(f.hub.file,guild,"700000000000000003"));
    restored.revoke(pair.machine); assert.throws(()=>restored.authenticate(pair.machine,pair.token));
    assert.equal(new AgentHub(f.hub.file,guild,owner).list().length,0);
  } finally { f.cleanup(); }
});
test("jobs target exact machine/generation, are dispatched once and are rejected on reconnect", async () => {
  const f=fixture(); try {
    const pair=f.hub.enroll(f.hub.issuePair(),"Linux","linux","/tmp"); const machine=f.hub.authenticate(pair.machine,pair.token);
    const snapshot={generation:"a".repeat(32),terminals:[]};
    await assert.rejects(f.hub.request(machine.id,"send",{}),/offline/);
    f.hub.poll(machine,snapshot);
    const pending=f.hub.request(machine.id,"send",{text:"once"});
    const jobs=f.hub.poll(machine,snapshot); assert.equal(jobs.length,1);
    assert.equal(f.hub.poll(machine,snapshot).length,0);
    assert.throws(()=>f.hub.result({...machine,id:"wrong"},jobs[0].id,true));
    f.hub.result(machine,jobs[0].id,true); assert.equal(await pending,true);
    assert.throws(()=>f.hub.result(machine,jobs[0].id,true));
    const uncertain=f.hub.request(machine.id,"send",{}); const rejection=assert.rejects(uncertain,/reconnected/);
    f.hub.poll(machine,{generation:"b".repeat(32),terminals:[]}); await rejection;
    const revoked=f.hub.request(machine.id,"send",{}); const revokeRejection=assert.rejects(revoked,/revoked/); f.hub.revoke(machine.id); await revokeRejection;
  } finally { f.cleanup(); }
});
test("coordinator rejects insecure remote URLs, bad snapshots and unauthenticated HTTP", async () => {
  assert.throws(()=>coordinatorUrl("http://example.com")); assert.throws(()=>coordinatorUrl("https://user:secret@example.com"));
  assert.equal(coordinatorUrl("http://127.0.0.1:1234").hostname,"127.0.0.1");
  const f=fixture(); const server=await f.hub.listen(0);
  try {
    const address=server.address(); assert.ok(address && typeof address!=="string");
    const response=await fetch(`http://127.0.0.1:${address.port}/poll`,{method:"POST",body:'{"machine":"bad"}'}); assert.equal(response.status,403);
    const pair=f.hub.enroll(f.hub.issuePair(),"Windows","win32","D:\\P"); const machine=f.hub.authenticate(pair.machine,pair.token);
    assert.equal(validSnapshot({generation:"x",terminals:[]},machine),false);
    assert.equal(validSnapshot({generation:"a".repeat(32),terminals:[{id:"pty-"+"a".repeat(32),machine:"other",generation:"a".repeat(32),cwd:"D:\\P",kind:"shell",label:"x"}]},machine),false);
    await assert.rejects(f.hub.listen(0,"0.0.0.0"),/loopback/);
  } finally { await new Promise<void>(done=>server.close(()=>done())); f.cleanup(); }
});
