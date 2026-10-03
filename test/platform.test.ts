import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validWorkingDirectory, windowsEnvironment, sameWorkingDirectory } from "../apps/discord/platform.js";
import { HostExecutor, hostForMachine } from "../apps/discord/hosts.js";
import { ChannelBindingStore, CategoryBindingStore } from "../apps/discord/topology.js";
import { ChannelSessionStore } from "../apps/discord/channel-sessions.js";

test("target OS paths are independent of the coordinator OS", () => {
  for (const path of ["D:\\Projects\\Demo", "C:/Project with spaces/Việt", "\\\\server\\share\\project"]) {
    assert.equal(validWorkingDirectory(path, "win32"), true, path);
    assert.equal(validWorkingDirectory(path, "linux"), false, path);
  }
  assert.equal(validWorkingDirectory("/datasets/project", "linux"), true);
  assert.equal(validWorkingDirectory("/datasets/project", "win32"), false);
  for (const path of ["C:relative", "\\relative", "relative", "\\\\?\\C:\\project", "C:\\bad\npath"]) assert.equal(validWorkingDirectory(path, "win32"), false, path);
});

test("Windows native environment excludes bot and SSH secrets", () => {
  const env = windowsEnvironment({ Path: "C:\\Windows", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\fixture", DISCORD_BOT_TOKEN: "secret", SSH_PASSWORD: "secret", AWS_SECRET_ACCESS_KEY: "secret" });
  assert.deepEqual(env, { Path: "C:\\Windows", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\fixture" });
});

test("Windows diagnostics preserve Unicode stdout/stderr and the command exit code", { skip: process.platform !== "win32" }, async () => {
  const host = new HostExecutor({ id: "local", label: "Windows", kind: "local", cwd: process.cwd() }, process.cwd());
  const result = await host.run("[Console]::Write('Tiếng Việt'); [Console]::Error.Write('Lỗi kiểm thử'); exit 7");
  assert.equal(result.stdout, "Tiếng Việt");
  assert.equal(result.stderr, "Lỗi kiểm thử");
  assert.equal(result.code, 7);
});

test("attach compares paths using the target OS and preserves case-sensitive boundaries", () => {
  assert.equal(sameWorkingDirectory("D:\\Projects\\Demo\\", "D:/Projects/Demo", "win32"), true);
  assert.equal(sameWorkingDirectory("/home/alice/Projects/Demo/", "/home/alice/Projects/Demo", "linux"), true);
  assert.equal(sameWorkingDirectory("/home/alice/Projects/Demo", "/home/alice/Projects/demo", "linux"), false);
  assert.equal(sameWorkingDirectory("D:\\Projects\\Demo", "D:\\Projects\\demo", "win32"), false);
  assert.equal(sameWorkingDirectory("D:\\Projects\\Demo", "E:\\Projects\\Demo", "win32"), false);
  assert.throws(() => sameWorkingDirectory("D:\\Projects\\Demo", "/home/alice", "linux"));
});

test("machine IDs take precedence over aliases and ambiguous aliases fail closed", () => {
  const targets = [{ id: "one", label: "two", kind: "ssh" as const, cwd: "/", host: "shared" }, { id: "two", label: "other", kind: "ssh" as const, cwd: "/", host: "shared" }];
  assert.equal(hostForMachine(targets, "two").id, "two");
  assert.throws(() => hostForMachine(targets, "shared"));
});

test("unknown machine never falls back to the single SSH target", () => {
  assert.throws(() => hostForMachine([{ id: "gpu", label: "GPU", kind: "ssh", cwd: "/", host: "gpu", user: "owner", port: 22 }], "wrong-machine"), /No configured host/);
});

test("topology persists native paths and ConPTY IDs without changing legacy tmux IDs", () => {
  const dir = mkdtempSync(join(tmpdir(), "platform-stores-"));
  try {
    const guildId = "123456789012345678", categoryId = "223456789012345678", channelId = "323456789012345678";
    const terminalId = `pty-${"a".repeat(32)}`;
    const categories = new CategoryBindingStore(join(dir, "categories.json"));
    categories.set({ guildId, categoryId, hostId: "local", defaultCwd: "D:\\Projects\\Demo", createdAt: 1, updatedAt: 1 });
    assert.equal(categories.get(categoryId)?.defaultCwd, "D:\\Projects\\Demo");
    const channels = new ChannelBindingStore(join(dir, "channels.json"));
    channels.set({ guildId, categoryId, channelId, hostId: "local", cwd: "D:\\Projects\\Demo", terminalId, status: "ready", createdAt: 1, updatedAt: 1 });
    assert.equal(channels.get(channelId)?.terminalId, terminalId);
    const selections = new ChannelSessionStore(join(dir, "selections.json"));
    for (const id of [terminalId, "tmux-1234567890"]) { selections.set(channelId, id); assert.equal(selections.get(channelId), id); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
