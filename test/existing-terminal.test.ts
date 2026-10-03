import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHub, AgentMachine, AgentSnapshot, AgentVscodeSession } from "../apps/discord/agent-hub.js";
import { RemoteVscodeRegistry, RemoteVscodeTerminal } from "../apps/discord/remote-vscode.js";
import { validateExistingAttachment } from "../apps/discord/existing-terminal.js";
import { ChannelSessionStore } from "../apps/discord/channel-sessions.js";
import { CategoryBindingRecord, ChannelBindingRecord, ChannelBindingStore } from "../apps/discord/topology.js";

const guildId = "700000000000000001";
const ownerId = "800000000000000002";
const categoryId = "700000000000000006";
const channelId = "700000000000000008";
const otherChannelId = "700000000000000007";
const instance = "a".repeat(16);
const sessionId = `vsc-${instance}-12345678`;
const generation = "b".repeat(32);
const runtimeGeneration = "c".repeat(32);

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "existing-terminal-"));
  const hub = new AgentHub(join(directory, "agents.json"), guildId, ownerId);
  const registry = new RemoteVscodeRegistry(hub);
  const localIds = new Set<string>();
  hub.onSnapshot = (machine, snapshot) => registry.sync(machine.id, snapshot.vscode ?? [], localIds);
  const enroll = (label: string): AgentMachine => {
    const pair = hub.enroll(hub.issuePair(), label, "win32", "D:\\Project");
    return hub.authenticate(pair.machine, pair.token);
  };
  const machine = enroll("windows-workstation");
  const second = enroll("Other laptop");
  const record: AgentVscodeSession = {
    id: sessionId, instance, generation, machine: machine.id, label: "Existing Codex",
    cwd: "D:\\Project", cwdSource: "shellIntegration", sourceMachine: "windows-workstation",
    platform: "win32", remote: false, alive: true, shared: true, pid: 1234,
    inputProtocol: "paced-submit-v1",
  };
  const snapshot = (records: AgentVscodeSession[] = [record]): AgentSnapshot => ({ generation: runtimeGeneration, terminals: [], vscode: records });
  return { directory, hub, registry, localIds, machine, second, record, snapshot,
    cleanup() { hub.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("remote VS Code discovery follows scoped agent snapshots and old snapshots remain compatible", () => {
  const f = fixture();
  try {
    f.hub.poll(f.machine, f.snapshot());
    assert.deepEqual(f.registry.get(sessionId), f.record);
    const copy = f.registry.get(sessionId)!;
    copy.machine = f.second.id;
    const list = f.registry.list();
    list[0].generation = "d".repeat(32);
    assert.deepEqual(f.registry.get(sessionId), f.record);
    f.hub.poll(f.machine, { generation: runtimeGeneration, terminals: [] });
    assert.deepEqual(f.registry.list(), []);
    assert.equal(f.hub.online(f.machine.id), true);
  } finally { f.cleanup(); }
});

test("identity collisions reject whole batches without losing the previously observed terminal", () => {
  const f = fixture();
  try {
    f.hub.poll(f.machine, f.snapshot());
    const prior = f.registry.list();
    const other = { ...f.record, id: `vsc-${instance}-87654321`, machine: f.second.id };
    assert.throws(() => f.registry.sync(f.second.id, [other, { ...f.record, machine: f.second.id }]), /collision/);
    assert.deepEqual(f.registry.list(), prior);
    assert.throws(() => f.registry.sync(f.machine.id, [f.record], new Set([sessionId])), /collision/);
    assert.deepEqual(f.registry.list(), prior);
    assert.throws(() => f.registry.sync(f.machine.id, [f.record, { ...f.record, generation: "d".repeat(32) }]), /Duplicate/);
    assert.deepEqual(f.registry.list(), prior);
    assert.throws(() => f.registry.sync(f.machine.id, [other]), /collision/);
    assert.deepEqual(f.registry.list(), prior);
  } finally { f.cleanup(); }
});

test("external operations carry the original machine and terminal generation and dispatch once", async () => {
  const f = fixture();
  try {
    f.hub.poll(f.machine, f.snapshot());
    f.hub.poll(f.second, { generation: runtimeGeneration, terminals: [] });
    const terminal = new RemoteVscodeTerminal(f.record, f.registry);
    for (const action of [
      { op: "vscode-status", args: {}, invoke: () => terminal.status(), result: "alive=true pid=1234" },
      { op: "vscode-output", args: { lines: 30 }, invoke: () => terminal.output(30), result: "3973" },
      { op: "vscode-send", args: { text: "Write-Output (137 * 29)" }, invoke: () => terminal.send("Write-Output (137 * 29)"), result: true },
      { op: "vscode-key", args: { key: "enter" }, invoke: () => terminal.pressKey("enter"), result: true },
      { op: "vscode-key", args: { key: "ctrl-c" }, invoke: () => terminal.interrupt(), result: true },
    ]) {
      const pending = action.invoke();
      assert.deepEqual(f.hub.poll(f.second, { generation: runtimeGeneration, terminals: [] }), []);
      const jobs = f.hub.poll(f.machine, f.snapshot());
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].machine, f.machine.id);
      assert.equal(jobs[0].generation, runtimeGeneration);
      assert.equal(jobs[0].op, action.op);
      assert.deepEqual(jobs[0].args, { ...action.args, id: sessionId, terminalGeneration: generation });
      assert.deepEqual(f.hub.poll(f.machine, f.snapshot()), []);
      f.hub.result(f.machine, jobs[0].id, action.result);
      const result = await pending;
      if (action.op === "vscode-output" || action.op === "vscode-status") assert.equal(result, action.result);
      assert.throws(() => f.hub.result(f.machine, jobs[0].id, action.result), /Unknown/);
    }
    assert.throws(() => terminal.output(0), /Lines/);
    assert.throws(() => terminal.output(101), /Lines/);
    await assert.rejects(terminal.send("line one\nline two"), /Input/);
    assert.deepEqual(f.hub.poll(f.machine, f.snapshot()), []);
    assert.equal("stop" in terminal, false);
  } finally { f.cleanup(); }
});

test("offline, unshared, closed, removed and changed-generation tabs never queue input", async () => {
  const f = fixture();
  try {
    const terminal = new RemoteVscodeTerminal(f.record, f.registry);
    f.registry.sync(f.machine.id, [f.record]);
    await assert.rejects(terminal.send("offline"), /disconnected/);
    assert.deepEqual(f.hub.poll(f.machine, f.snapshot()), []);
    for (const patch of [{ shared: false }, { alive: false }, { generation: "d".repeat(32) }]) {
      const records = [{ ...f.record, ...patch }];
      f.hub.poll(f.machine, f.snapshot(records));
      await assert.rejects(terminal.send("blocked"), /unshared, closed or disconnected/);
      await assert.rejects(terminal.interrupt(), /unshared, closed or disconnected/);
      assert.deepEqual(f.hub.poll(f.machine, f.snapshot(records)), []);
    }
    f.hub.poll(f.machine, f.snapshot([]));
    await assert.rejects(terminal.status(), /disconnected/);
    assert.deepEqual(f.hub.poll(f.machine, f.snapshot([])), []);
    // A legacy discovered tab may be visible, but cannot authorize modern IPC.
    f.registry.sync(f.machine.id, [{ ...f.record, inputProtocol: undefined }]);
    await assert.rejects(terminal.send("legacy"), /disconnected/);
    assert.deepEqual(f.hub.poll(f.machine, f.snapshot()), []);
    f.hub.revoke(f.machine.id);
    await assert.rejects(terminal.send("revoked"), /disconnected/);
  } finally { f.cleanup(); }
});

test("remote Shift + Left checks the current loaded provider before queueing, while older hosts retain other keys", async () => {
  const f = fixture();
  try {
    const terminal = new RemoteVscodeTerminal(f.record, f.registry);
    for (const providerVersion of [undefined, "0.1.6", "0.1.7-alpha", "0.1.7oops"]) {
      const snapshot = f.snapshot([{ ...f.record, providerVersion }]);
      f.hub.poll(f.machine, snapshot);
      await assert.rejects(terminal.pressKey("shift-left"), /0\.1\.7.*Safely update.*share/);
      assert.deepEqual(f.hub.poll(f.machine, snapshot), []);
    }
    const complete = async (key: Parameters<RemoteVscodeTerminal["pressKey"]>[0], snapshot: AgentSnapshot) => {
      const pending = terminal.pressKey(key);
      const jobs = f.hub.poll(f.machine, snapshot);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].machine, f.machine.id);
      assert.equal(jobs[0].op, "vscode-key");
      assert.deepEqual(jobs[0].args, { key, id: sessionId, terminalGeneration: generation });
      f.hub.result(f.machine, jobs[0].id, true);
      await pending;
      assert.deepEqual(f.hub.poll(f.machine, snapshot), []);
    };
    // The terminal wrapper predates these snapshots; use current provider facts.
    for (const providerVersion of ["0.1.7", "0.1.10", "0.2.0"]) {
      const snapshot = f.snapshot([{ ...f.record, providerVersion }]);
      f.hub.poll(f.machine, snapshot);
      await complete("shift-left", snapshot);
    }
    const old = f.snapshot([{ ...f.record, providerVersion: "0.1.6" }]);
    f.hub.poll(f.machine, old);
    for (const key of ["enter", "ctrl-c", "escape", "tab", "up", "down", "left", "right"] as const) await complete(key, old);
  } finally { f.cleanup(); }
});

test("attachment validates physical Windows host and terminal cwd without forcing the category default folder", () => {
  const f = fixture();
  try {
    const category: CategoryBindingRecord = { guildId, categoryId, hostId: f.machine.id,
      defaultCwd: "D:/Project/", label: "Windows project", createdAt: 1, updatedAt: 1 };
    assert.doesNotThrow(() => validateExistingAttachment(f.record, category, "win32"));
    for (const cwd of ["D:\\Elsewhere", "D:\\project", "E:/Training/"]) {
      assert.doesNotThrow(() => validateExistingAttachment({ ...f.record, cwd }, category, "win32"));
    }
    for (const changes of [{ remote: true }, { shared: false }, { alive: false }, { machine: f.second.id }, { cwd: "relative" }, { cwd: "/datasets/project" }, { cwd: "D:relative" }, { cwd: null }]) {
      assert.throws(() => validateExistingAttachment({ ...f.record, ...changes }, category, "win32"));
    }
    const remote = { ...f.record, remote: true, cwd: "/datasets/project", sourceMachine: "gpu-server" };
    assert.throws(() => validateExistingAttachment(remote, category, "win32"), /Remote-SSH.*physical SSH host/);
    const linuxCategory = { ...category, hostId: "gpu", defaultCwd: "/datasets/default" };
    assert.doesNotThrow(() => validateExistingAttachment({ id: "tmux-1234567890", machine: "gpu", cwd: "/datasets/another" }, linuxCategory, "linux"));
  } finally { f.cleanup(); }
});

test("channel selections retain legacy IDs and persist exact external identities across restart", () => {
  const f = fixture();
  try {
    const file = join(f.directory, "channel-sessions.json");
    writeFileSync(file, JSON.stringify({ version: 1, channels: { [channelId]: sessionId, [otherChannelId]: "demo" } }));
    const store = new ChannelSessionStore(file);
    assert.equal(store.get(channelId), sessionId);
    assert.equal(store.identity(channelId), undefined);
    const identity = { machine: f.machine.id, generation, provider: "vscode-agent" as const };
    store.set(channelId, sessionId, identity);
    const restarted = new ChannelSessionStore(file);
    assert.equal(restarted.get(channelId), sessionId);
    assert.deepEqual(restarted.identity(channelId), identity);
    assert.equal(restarted.get(otherChannelId), "demo");
    assert.equal(restarted.identity(otherChannelId), undefined);
    assert.ok(!readFileSync(file, "utf8").includes(f.machine.tokenHash));
    restarted.set(channelId, `vsc-${instance}-87654321`);
    assert.equal(restarted.identity(channelId), undefined);
    restarted.set(channelId, sessionId, identity);
    restarted.set(channelId, "tmux-1234567890");
    assert.equal(restarted.identity(channelId), undefined);
    restarted.set(channelId, sessionId, identity);
    assert.throws(() => restarted.set(channelId, "tmux-1234567890", identity), /external terminal identity/);
    assert.equal(restarted.get(channelId), sessionId);
    restarted.remove(channelId);
    assert.equal(new ChannelSessionStore(file).get(channelId), undefined);
    assert.equal(new ChannelSessionStore(file).identity(channelId), undefined);
  } finally { f.cleanup(); }
});

test("invalid or detached external selection identities fail closed without rewriting saved selections", () => {
  const f = fixture();
  try {
    const file = join(f.directory, "channel-sessions.json");
    const identity = { machine: f.machine.id, generation, provider: "vscode-agent" };
    for (const targets of [
      { [otherChannelId]: identity },
      { [channelId]: { ...identity, generation: "changed" } },
      { [channelId]: { ...identity, provider: "tmux" } },
    ]) {
      const saved = JSON.stringify({ version: 1, channels: { [channelId]: sessionId }, targets });
      writeFileSync(file, saved);
      assert.throws(() => new ChannelSessionStore(file).get(channelId), /Saved channel selections/);
      assert.equal(readFileSync(file, "utf8"), saved);
    }
  } finally { f.cleanup(); }
});

test("external category bindings retain provider, machine and original generation across restart", () => {
  const f = fixture();
  try {
    const file = join(f.directory, "channel-bindings.json");
    const store = new ChannelBindingStore(file);
    const external: ChannelBindingRecord = { guildId, channelId, categoryId, hostId: f.machine.id,
      cwd: "D:\\Project", status: "ready", terminalId: sessionId, terminalGeneration: generation,
      provider: "vscode-agent", createdAt: 1, updatedAt: 1 };
    store.set(external);
    assert.deepEqual(new ChannelBindingStore(file).get(channelId), external);
    for (const patch of [
      { terminalGeneration: "old" }, { terminalGeneration: undefined },
      { provider: "unknown" }, { provider: undefined }, { provider: "tmux" },
      { terminalId: "tmux-1234567890" }, { terminalId: `pty-${"a".repeat(32)}` },
      { terminalId: undefined },
    ]) {
      assert.throws(() => store.set({ ...external, ...patch } as ChannelBindingRecord), /invalid terminal channel binding/);
      assert.deepEqual(store.get(channelId), external);
    }
    const legacy: ChannelBindingRecord = { ...external, channelId: otherChannelId, hostId: "local",
      cwd: "/tmp/project", terminalId: "tmux-1234567890", terminalGeneration: undefined, provider: undefined };
    store.set(legacy);
    assert.equal(new ChannelBindingStore(file).get(otherChannelId)?.terminalId, legacy.terminalId);
    assert.deepEqual(new ChannelBindingStore(file).get(channelId), external);
  } finally { f.cleanup(); }
});
