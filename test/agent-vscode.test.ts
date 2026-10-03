import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHub, AgentJob } from "../apps/discord/agent-hub.js";
import { AgentRuntime } from "../apps/discord/agent-runtime.js";
import { AgentVscodeRelay } from "../apps/discord/agent-vscode.js";
import { localPlatform } from "../apps/discord/platform.js";

const instance = "a".repeat(16), terminalGeneration = "b".repeat(32), rawId = `vsc-${instance}-12345678`;
function extensionFixture(machine: string) {
  const directory = mkdtempSync(join(tmpdir(), "agent-vscode-")), ipc = join(directory, "vscode"); mkdirSync(ipc);
  const received: Record<string, unknown>[] = [];
  let session = { id:rawId, instance, generation:terminalGeneration, label:"existing Codex", machine:"source UI machine", cwd:directory,
    pid:1234, alive:true, shared:true, platform:localPlatform(), remote:false, cwdSource:"shellIntegration", inputProtocol:"paced-submit-v1" };
  function publish(changes: Record<string, unknown> = {}, updatedAt = Date.now()) {
    session = { ...session, ...changes };
    writeFileSync(join(ipc, `instance-${instance}.json`), JSON.stringify({ instance, updatedAt, inputProtocol:session.inputProtocol, sessions:[session,
      { ...session, id:`vsc-${instance}-abcdef12`, label:"unshared shell", shared:false }] }));
  }
  publish();
  const handled = new Set<string>();
  const timer = setInterval(() => {
    for (const name of readdirSync(ipc)) {
      if (!name.endsWith(".request.json")) continue;
      const request = JSON.parse(readFileSync(join(ipc, name), "utf8"));
      if (handled.has(request.requestId)) continue; handled.add(request.requestId);
      received.push(request);
      const okay = request.instance === instance && request.sessionId === rawId && request.generation === session.generation
        && session.alive && session.shared && request.expiresAt > Date.now();
      writeFileSync(join(ipc, name.replace(/\.request\.json$/, ".response.json")), JSON.stringify({ requestId:request.requestId,
        sessionId:request.sessionId, generation:request.generation, ok:okay, output:okay ? (request.action === "output" ? "old output\nEXISTING_CODEX_MARKER" : "alive=true external=vscode") : undefined }));
      try { unlinkSync(join(ipc, name)); } catch {}
    }
  }, 5);
  return { directory, ipc, received, publish, relay:new AgentVscodeRelay(machine, directory),
    cleanup() { clearInterval(timer); rmSync(directory, { recursive:true, force:true }); } };
}
function job(machine: string, op: string, args: Record<string, unknown> = {}): AgentJob {
  return { id:"c".repeat(32), machine, generation:"d".repeat(32), deadline:Date.now()+5000, op,
    args:{ id:rawId, terminalGeneration, ...args } };
}

test("external relay discovers all tabs and controls only the fresh shared exact generation", { timeout:10000 }, async () => {
  const machine = "agent-"+"e".repeat(16), f = extensionFixture(machine);
  try {
    const inventory = f.relay.inventory();
    assert.equal(inventory.length, 2); assert.equal(inventory[0].machine, machine);
    assert.equal(inventory[0].sourceMachine, "source UI machine"); assert.equal(inventory[1].shared, false);
    assert.match(String(await f.relay.dispatch(job(machine, "vscode-output", { lines:1 }))), /^EXISTING_CODEX_MARKER$/);
    assert.equal(await f.relay.dispatch(job(machine, "vscode-send", { text:"literal; $(not a host command)" })), true);
    assert.equal(await f.relay.dispatch(job(machine, "vscode-key", { key:"ctrl-c" })), true);
    assert.deepEqual(f.received.map(request => request.action), ["output", "submit", "key"]);
    assert.equal(f.received[1].text, "literal; $(not a host command)");
    assert.ok(f.received.every(request => typeof request.expiresAt === "number" && request.expiresAt <= Date.now()+5000));
    const count = f.received.length;
    await assert.rejects(f.relay.dispatch(job("agent-"+"f".repeat(16), "vscode-send", { text:"wrong machine" })), /wrong-machine/);
    await assert.rejects(f.relay.dispatch(job(machine, "vscode-send", { text:"old generation", terminalGeneration:"f".repeat(32) })), /generation/);
    for (const state of [{ shared:false }, { shared:true, alive:false }, { alive:true, generation:"0".repeat(32) }]) {
      f.publish(state); await assert.rejects(f.relay.dispatch(job(machine, "vscode-send", { text:"must not route" })));
    }
    f.publish({ generation:terminalGeneration });
    f.publish({ inputProtocol:undefined });
    assert.equal(f.relay.inventory()[0].shared, false);
    await assert.rejects(f.relay.dispatch(job(machine, "vscode-send", { text:"legacy extension must not receive control" })));
    f.publish({ inputProtocol:"paced-submit-v1" });
    await assert.rejects(f.relay.dispatch({ ...job(machine, "vscode-send", { text:"expired" }), deadline:Date.now()-1 }), /Expired/);
    await assert.rejects(f.relay.dispatch(job(machine, "vscode-stop")), /cannot be created or stopped/);
    f.publish({}, Date.now()-20_000);
    await assert.rejects(f.relay.dispatch(job(machine, "vscode-send", { text:"disconnected" })));
    assert.equal(f.received.length, count);
  } finally { f.cleanup(); }
});

test("real authenticated agent HTTP relays existing VS Code IPC without owned process operations or replay", { skip:process.platform!=="linux", timeout:15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-vscode-http-")), hub = new AgentHub(join(root, "hub.json"), "700000000000000001", "700000000000000002");
  const pair = hub.enroll(hub.issuePair(), "existing UI", localPlatform(), root), f = extensionFixture(pair.machine);
  const state = join(f.directory, "agent"); mkdirSync(state);
  const originalBridge = process.env.REMOTE_OPERATOR_VSCODE_BRIDGE_DIRECTORY;
  process.env.REMOTE_OPERATOR_VSCODE_BRIDGE_DIRECTORY = f.directory;
  let server: Awaited<ReturnType<AgentHub["listen"]>> | undefined;
  try {
    const runtime = await AgentRuntime.start(pair.machine, state, root);
    if (originalBridge === undefined) delete process.env.REMOTE_OPERATOR_VSCODE_BRIDGE_DIRECTORY; else process.env.REMOTE_OPERATOR_VSCODE_BRIDGE_DIRECTORY = originalBridge;
    server = await hub.listen(0); const address = server.address(); assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    async function post(route: string, body: Record<string, unknown>, token = pair.token) {
      const response = await fetch(origin+route, { method:"POST", headers:{ authorization:`Bearer ${token}`, "Content-Type":"application/json" }, body:JSON.stringify({ machine:pair.machine, ...body }) });
      return { status:response.status, result:(await response.json() as { result:unknown }).result };
    }
    const snapshot = await runtime.snapshot(); assert.equal(snapshot.terminals.length, 0); assert.equal(snapshot.vscode?.length, 2);
    assert.equal((await post("/poll", { snapshot }, "wrong-token")).status, 403);
    assert.equal((await post("/poll", { snapshot })).status, 200);
    const pending = hub.request(pair.machine, "vscode-send", { id:rawId, terminalGeneration, text:"PROMPT_ONCE" });
    const delivered = (await post("/poll", { snapshot:await runtime.snapshot() })).result as AgentJob[]; assert.equal(delivered.length, 1);
    assert.deepEqual((await post("/poll", { snapshot:await runtime.snapshot() })).result, []);
    const result = await runtime.dispatch(delivered[0]);
    assert.equal((await post("/result", { id:delivered[0].id, result })).status, 200); assert.equal(await pending, true);
    await assert.rejects(runtime.dispatch(delivered[0]), /EEXIST/);
    await assert.rejects(runtime.dispatch({ ...delivered[0], id:"1".repeat(32), machine:"agent-"+"f".repeat(16) }), /wrong-machine/);
    f.publish({ shared:false });
    await assert.rejects(runtime.dispatch({ ...delivered[0], id:"2".repeat(32) }), /unshared/);
    f.publish({ shared:true, generation:"f".repeat(32) });
    await assert.rejects(runtime.dispatch({ ...delivered[0], id:"3".repeat(32) }), /generation/);
    await assert.rejects(runtime.dispatch({ ...delivered[0], id:"4".repeat(32), op:"stop" }), /Unknown or stale/);
    assert.equal(f.received.length, 1); assert.equal(f.received[0].action, "submit");
    assert.equal((await runtime.snapshot()).terminals.length, 0);
  } finally {
    if (originalBridge === undefined) delete process.env.REMOTE_OPERATOR_VSCODE_BRIDGE_DIRECTORY; else process.env.REMOTE_OPERATOR_VSCODE_BRIDGE_DIRECTORY = originalBridge;
    hub.close(); if (server) await new Promise<void>(done => server!.close(() => done())); f.cleanup(); rmSync(root, { recursive:true, force:true });
  }
});
