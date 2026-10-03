import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelBindingStore, ChannelBindingRecord } from "../apps/discord/topology.js";
import { ChannelSessionStore } from "../apps/discord/channel-sessions.js";
import { isStoppedBinding, terminalLifecycle } from "../apps/discord/terminal-lifecycle.js";
import { ManagedTerminal } from "../apps/discord/pty-protocol.js";
import { ActionQueue } from "../apps/discord/action-queue.js";
import { fitDiscordMessage } from "../apps/discord/messages.js";

const channelId = "323456789012345678", categoryId = "223456789012345678";
function fixture(provider: "tmux" | "conpty" = "conpty") {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  const bindings = new ChannelBindingStore(join(dir, "bindings.json"));
  const selections = new ChannelSessionStore(join(dir, "selected.json"));
  const id = provider === "conpty" ? `pty-${"a".repeat(32)}` : "tmux-1234567890";
  const binding: ChannelBindingRecord = { guildId: "123456789012345678", channelId, categoryId, hostId: "local", cwd: provider === "conpty" ? "D:\\Projects\\Demo" : "/tmp/project", status: "ready", terminalId: id, createdAt: 1, updatedAt: 1 };
  bindings.set(binding); selections.set(channelId, id);
  const events: string[] = [];
  const terminal = { record: { id, machine: "local" } } as ManagedTerminal;
  const options = { action: "close" as "stop" | "close", confirm: true, channelId, parentId: categoryId, protectedChannel: false, bindings, selections, terminal,
    stop: async (target: string) => { assert.equal(target, id); events.push("stop"); },
    beforeDelete: async () => { events.push("receipt"); }, deleteChannel: async () => { events.push("delete"); } };
  return { options, events, binding, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

for (const provider of ["conpty", "tmux"] as const) test(`${provider} close stops the exact managed terminal, replies before deletion and clears routing`, async () => {
  const f = fixture(provider);
  try {
    assert.equal((await terminalLifecycle(f.options)).deleted, true);
    assert.deepEqual(f.events, ["stop", "receipt", "delete"]);
    assert.equal(f.options.bindings.get(channelId), undefined);
    assert.equal(f.options.selections.get(channelId), undefined);
  } finally { f.dispose(); }
});

test("stop is durable/idempotent; close after stop or bot restart needs no live terminal", async () => {
  const f = fixture();
  try {
    await terminalLifecycle({ ...f.options, action: "stop" });
    assert.ok(isStoppedBinding(f.options.bindings.get(channelId)));
    assert.equal((await terminalLifecycle({ ...f.options, action: "stop", terminal: undefined })).alreadyStopped, true);
    await terminalLifecycle({ ...f.options, terminal: undefined });
    assert.deepEqual(f.events, ["stop", "receipt", "delete"]);
  } finally { f.dispose(); }
});

test("failed Discord delete preserves stopped state and retry never stops twice", async () => {
  const f = fixture();
  try {
    await assert.rejects(terminalLifecycle({ ...f.options, deleteChannel: async () => { throw new Error("Missing access"); } }), /Terminal is stopped/);
    assert.ok(isStoppedBinding(f.options.bindings.get(channelId)));
    await terminalLifecycle({ ...f.options, terminal: undefined });
    assert.equal(f.events.filter(x => x === "stop").length, 1);
    assert.equal(f.options.bindings.get(channelId), undefined);
  } finally { f.dispose(); }
});

test("failed or uncertain stop never deletes channel or discards its routing", async () => {
  const f = fixture();
  try {
    await assert.rejects(terminalLifecycle({ ...f.options, stop: async () => { throw new Error("offline"); } }), /offline/);
    assert.deepEqual(f.events, []);
    assert.equal(f.options.bindings.get(channelId)?.status, "ready");
    assert.equal(f.options.selections.get(channelId), f.binding.terminalId);
  } finally { f.dispose(); }
});

test("lifecycle fails closed on missing confirmation, protected/moved channel and wrong/stale session", async () => {
  const f = fixture();
  try {
    for (const patch of [{ confirm: false }, { protectedChannel: true }, { parentId: "423456789012345678" }, { terminal: undefined }, { terminal: { record: { id: f.binding.terminalId, machine: "wrong" } } as ManagedTerminal }]) {
      await assert.rejects(terminalLifecycle({ ...f.options, ...patch }));
    }
    for (const status of ["provisioning", "failed"] as const) {
      f.options.bindings.set({ ...f.binding, status, terminalId: undefined });
      await assert.rejects(terminalLifecycle(f.options));
    }
    assert.deepEqual(f.events, []);
  } finally { f.dispose(); }
});

test("orphaned category binding is not evidence a process stopped; legacy explicit stop is recognized", async () => {
  const f = fixture();
  try {
    f.options.bindings.set({ ...f.binding, status: "orphaned", error: "Machine category was unbound." });
    await terminalLifecycle(f.options);
    assert.equal(f.events[0], "stop");
    f.events.length = 0;
    f.options.bindings.set({ ...f.binding, terminalId: undefined, status: "orphaned", error: "Stopped by owner." });
    await terminalLifecycle({ ...f.options, terminal: undefined });
    assert.deepEqual(f.events, ["receipt", "delete"]);
  } finally { f.dispose(); }
});

test("a bounded host diagnostic cannot block another queue; same-session actions stay ordered after errors", async () => {
  const queue = new ActionQueue();
  let unblock!: () => void;
  const blocked = queue.run("host:local", () => new Promise<void>(resolve => { unblock = resolve; }));
  await new Promise<void>(resolve => setImmediate(resolve));
  const events: string[] = [];
  await queue.run("session:one", async () => { events.push("interrupt"); });
  assert.deepEqual(events, ["interrupt"]);
  const failing = queue.run("session:one", async () => { events.push("first"); throw new Error("failed"); });
  const second = queue.run("session:one", async () => { events.push("second"); });
  await assert.rejects(failing); await second;
  assert.deepEqual(events, ["interrupt", "first", "second"]);
  unblock(); await blocked;
});

test("long host results fit Discord including command/target headers and fences", () => {
  const result = fitDiscordMessage("Target: " + "x".repeat(500) + "\n```\n" + "a".repeat(4000));
  assert.ok(result.length <= 1900);
  assert.equal((result.match(/```/g) ?? []).length % 2, 0);
  assert.match(result, /truncated/);
});
