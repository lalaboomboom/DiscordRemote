import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerminalChannel, TerminalChannelCreation } from "../apps/discord/terminal-channel-create.js";
import { terminalProvisionDirectory } from "../apps/discord/terminal-directory.js";
import { CategoryBindingRecord, ChannelBindingStore } from "../apps/discord/topology.js";

type Channel = { id: string; parentId: string | null };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "terminal-create-"));
  const category: CategoryBindingRecord = { guildId: "123456789012345678", categoryId: "223456789012345678", hostId: "local", defaultCwd: "/default", createdAt: 1, updatedAt: 1 };
  const channel: Channel = { id: "323456789012345678", parentId: null };
  const bindings = new ChannelBindingStore(join(directory, "bindings.json"));
  const events: string[] = []; let now = 100;
  const options: TerminalChannelCreation<Channel> = {
    category, platform: "linux", cwd: "/different project", deadline: 1000, bindings, now: () => now,
    currentCategory: () => category,
    probe: async cwd => { events.push(`probe:${cwd}`); },
    createPrivate: async () => { events.push("private"); return channel; },
    link: async value => { events.push("parent"); value.parentId = category.categoryId; return value; },
    remove: async () => { events.push("delete"); },
    provision: async value => { events.push(`start:${terminalProvisionDirectory(category, "linux", bindings.get(value.id))}`); },
  };
  return { category, channel, bindings, events, options, expire: () => { now = 1000; }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("explicit directory is durable before a delayed parent event can choose the category default", async () => {
  const f = fixture();
  try {
    f.options.link = async channel => {
      assert.equal(channel.parentId, null);
      const stored = new ChannelBindingStore(f.bindings.file).get(channel.id)!;
      assert.equal(stored.cwd, "/different project"); assert.equal(stored.provisioningDeadline, 1000);
      f.category.defaultCwd = "/new default";
      assert.equal(terminalProvisionDirectory(f.category, "linux", stored), "/different project");
      channel.parentId = f.category.categoryId;
      f.events.push("parent"); return channel;
    };
    await createTerminalChannel(f.options);
    assert.deepEqual(f.events, ["probe:/different project", "private", "parent", "start:/different project"]);
  } finally { f.cleanup(); }
});

test("invalid paths, failed preflight, expiry and changed machine start no Discord channel or process", async () => {
  for (const fault of ["relative", "missing", "expired", "changed host"] as const) {
    const f = fixture();
    try {
      if (fault === "relative") f.options.cwd = "relative";
      else f.options.probe = async () => {
        if (fault === "missing") throw new Error("Directory absent");
        if (fault === "expired") f.expire();
        if (fault === "changed host") f.category.hostId = "replacement";
      };
      // Category snapshot must remain immutable while the registry may change.
      if (fault === "changed host") f.options.category = { ...f.category };
      await assert.rejects(createTerminalChannel(f.options));
      assert.deepEqual(f.events, []); assert.equal(f.bindings.list().length, 0);
    } finally { f.cleanup(); }
  }
});

test("expiry after private create removes only the fresh unbound channel and starts no terminal", async () => {
  const f = fixture();
  try {
    f.options.createPrivate = async () => { f.events.push("private"); f.expire(); return f.channel; };
    await assert.rejects(createTerminalChannel(f.options), /expired/);
    assert.deepEqual(f.events, ["probe:/different project", "private", "delete"]);
    assert.equal(f.bindings.list().length, 0);
  } finally { f.cleanup(); }
});

test("an ambiguous parent failure retains the exact cwd/deadline reservation without starting another process", async () => {
  const f = fixture();
  try {
    f.options.link = async () => { throw new Error("Discord reply lost"); };
    await assert.rejects(createTerminalChannel(f.options), /reply lost/);
    const saved = new ChannelBindingStore(f.bindings.file).get(f.channel.id)!;
    assert.equal(saved.cwd, "/different project"); assert.equal(saved.provisioningDeadline, 1000);
    assert.deepEqual(f.events, ["probe:/different project", "private"]);
  } finally { f.cleanup(); }
});

test("changed parent, host or persisted directory after link never reaches process creation", async () => {
  for (const fault of ["parent", "host", "cwd", "expired"] as const) {
    const f = fixture();
    try {
      f.options.category = { ...f.category };
      f.options.link = async channel => {
        channel.parentId = fault === "parent" ? "423456789012345678" : f.category.categoryId;
        if (fault === "host") f.category.hostId = "replacement";
        if (fault === "cwd") f.bindings.set({ ...f.bindings.get(channel.id)!, cwd: "/replacement" });
        if (fault === "expired") f.expire();
        return channel;
      };
      await assert.rejects(createTerminalChannel(f.options));
      assert.equal(f.bindings.list().length, 1);
      assert.ok(!f.events.some(event => event.startsWith("start:")));
    } finally { f.cleanup(); }
  }
});

test("existing bindings are not overwritten or deleted by a conflicting creation result", async () => {
  const f = fixture();
  try {
    const prior = { guildId: f.category.guildId, categoryId: f.category.categoryId, channelId: f.channel.id,
      hostId: "local", cwd: "/original", status: "ready" as const, terminalId: "tmux-0123456789", createdAt: 1, updatedAt: 1 };
    f.bindings.set(prior);
    await assert.rejects(createTerminalChannel(f.options), /unbound/);
    assert.deepEqual(f.bindings.get(f.channel.id), prior);
    assert.deepEqual(f.events, ["probe:/different project", "private"]);
  } finally { f.cleanup(); }
});
