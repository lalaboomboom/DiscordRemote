import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionError } from "../apps/discord/errors.js";
import { terminalCreateDirectory, terminalProvisionDirectory, boundTerminalDirectory } from "../apps/discord/terminal-directory.js";
import { ChannelBindingStore, type CategoryBindingRecord, type ChannelBindingRecord } from "../apps/discord/topology.js";

const category: CategoryBindingRecord = { guildId: "123456789012345678", categoryId: "223456789012345678", hostId: "local",
  defaultCwd: "/default-project", createdAt: 1, updatedAt: 1 };
const pending: ChannelBindingRecord = { guildId: category.guildId, categoryId: category.categoryId, channelId: "323456789012345678",
  hostId: category.hostId, cwd: "/chosen project", status: "provisioning", provisioningDeadline: 60_000, createdAt: 2, updatedAt: 2 };

test("creation chooses an explicit absolute directory or the category default without modifying the path", () => {
  assert.equal(terminalCreateDirectory(category, "linux"), category.defaultCwd);
  assert.equal(terminalCreateDirectory(category, "linux", null), category.defaultCwd);
  const literal = "/chosen project/../project with spaces/";
  assert.equal(terminalCreateDirectory(category, "linux", literal), literal);
  assert.equal(terminalCreateDirectory({ ...category, defaultCwd: "D:\\wrong-os-default" }, "linux", "/valid-override"), "/valid-override");
  const windows = { ...category, defaultCwd: "D:\\Projects\\Demo" };
  assert.equal(terminalCreateDirectory(windows, "win32"), "D:\\Projects\\Demo");
  assert.equal(terminalCreateDirectory(windows, "win32", "D:\\Other Project\\"), "D:\\Other Project\\");
  assert.equal(terminalCreateDirectory(windows, "win32", "\\\\server\\share\\project"), "\\\\server\\share\\project");
});

test("creation refuses empty, relative, wrong-OS and device paths before any provisioning", () => {
  for (const cwd of ["", "relative", "~/project", "D:\\Projects\\Demo", "/project\nother", "/" + "a".repeat(500)]) {
    assert.throws(() => terminalCreateDirectory(category, "linux", cwd), SessionError);
  }
  for (const cwd of ["", "/project", "D:relative", "\\project", "\\\\?\\D:\\project", "\\\\.\\pipe\\project"]) {
    assert.throws(() => terminalCreateDirectory(category, "win32", cwd), SessionError);
  }
  assert.throws(() => terminalCreateDirectory(category, "win32"), SessionError);
});

test("provisioning reads a durable pending override while plain channel creation uses the latest default", () => {
  const directory = mkdtempSync(join(tmpdir(), "terminal-directory-"));
  try {
    const file = join(directory, "channel-bindings.json");
    new ChannelBindingStore(file).set(pending);
    const restored = new ChannelBindingStore(file).get(pending.channelId)!;
    const changedDefault = { ...category, defaultCwd: "/another-default", updatedAt: 3 };
    assert.equal(terminalProvisionDirectory(changedDefault, "linux", restored), pending.cwd);
    assert.equal(terminalProvisionDirectory(changedDefault, "linux"), changedDefault.defaultCwd);
    assert.equal(restored.cwd, pending.cwd);
    assert.equal(restored.provisioningDeadline, pending.provisioningDeadline);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("provisioning refuses mismatched or previously resolved bindings instead of falling back to the default", () => {
  const changedBindings: ChannelBindingRecord[] = [
    { ...pending, guildId: "423456789012345678" },
    { ...pending, categoryId: "423456789012345678" },
    { ...pending, hostId: "gpu-server" },
    ...(["ready", "failed", "orphaned", "stopped"] as const).map(status => ({ ...pending, status })),
    { ...pending, terminalId: "tmux-0123456789" },
    { ...pending, provider: "tmux" },
    { ...pending, terminalGeneration: "a".repeat(32) },
    { ...pending, relayMachine: "agent-0123456789abcdef" },
    { ...pending, error: "creation result unknown" },
    { ...pending, cwd: "relative" },
    { ...pending, cwd: "D:\\wrong-os" },
  ];
  for (const binding of changedBindings) assert.throws(() => terminalProvisionDirectory(category, "linux", binding), SessionError);
});

test("bound directories survive category default changes for both live and stopped terminals", () => {
  for (const status of ["ready", "stopped"] as const) {
    const binding = { ...pending, status, terminalId: "tmux-0123456789" };
    assert.equal(boundTerminalDirectory(category, binding, "linux"), pending.cwd);
    assert.equal(boundTerminalDirectory({ ...category, defaultCwd: "/changed-default" }, binding, "linux"), pending.cwd);
  }
  const windows = { ...category, hostId: "agent-0123456789abcdef", defaultCwd: "D:\\New Default" };
  const binding = { ...pending, hostId: windows.hostId, cwd: "D:\\Original Project" };
  assert.equal(boundTerminalDirectory(windows, binding, "win32"), binding.cwd);
});

test("bound directories reject changed machine/category/guild or invalid target-OS cwd", () => {
  for (const changed of [
    { ...category, guildId: "423456789012345678" },
    { ...category, categoryId: "423456789012345678" },
    { ...category, hostId: "gpu-server" },
  ]) assert.throws(() => boundTerminalDirectory(changed, pending, "linux"), SessionError);
  assert.throws(() => boundTerminalDirectory(category, { ...pending, cwd: "relative" }, "linux"), SessionError);
  assert.throws(() => boundTerminalDirectory(category, pending, "win32"), SessionError);
});
