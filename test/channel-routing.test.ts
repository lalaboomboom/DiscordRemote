import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelSessionStore } from "../apps/discord/channel-sessions.js";
import { isBoundTerminalChannel, requireBoundTerminalId, type BoundTerminalChannelContext } from "../apps/discord/channel-routing.js";
import { SessionError } from "../apps/discord/errors.js";
import type { CategoryBindingRecord, ChannelBindingRecord } from "../apps/discord/topology.js";

const guildId = "123456789012345678", categoryId = "223456789012345678";
const channelId = "323456789012345678", bootstrapChannelId = "423456789012345678", orchestratorChannelId = "523456789012345678";
const category: CategoryBindingRecord = { guildId, categoryId, hostId: "local", defaultCwd: "/project", createdAt: 1, updatedAt: 1 };
const binding: ChannelBindingRecord = { guildId, categoryId, channelId, hostId: "local", cwd: "/project", status: "ready",
  terminalId: "tmux-0123456789", provider: "tmux", createdAt: 1, updatedAt: 1 };
const context: BoundTerminalChannelContext = { guildId, channelId, parentId: categoryId, bootstrapChannelId, orchestratorChannelId, binding, category };

function rejectsControl(value: BoundTerminalChannelContext): void {
  assert.equal(isBoundTerminalChannel(value), false);
  assert.throws(() => requireBoundTerminalId(value), SessionError);
}

test("ready managed and shared-provider channels resolve only their exact persisted terminal IDs", () => {
  const variants: Array<Partial<ChannelBindingRecord>> = [
    { terminalId: "tmux-0123456789", provider: "tmux" },
    { terminalId: `pty-${"a".repeat(32)}`, provider: "conpty", hostId: "agent-0123456789abcdef" },
    { terminalId: `vsc-${"b".repeat(16)}-${"c".repeat(8)}`, provider: "vscode", terminalGeneration: "d".repeat(32) },
    { terminalId: `vsc-${"e".repeat(16)}-${"f".repeat(8)}`, provider: "vscode-agent", terminalGeneration: "1".repeat(32),
      hostId: "gpu-server", relayMachine: "agent-0123456789abcdef" },
  ];
  for (const variant of variants) {
    const bound = { ...binding, ...variant };
    const value = { ...context, binding: bound, category: { ...category, hostId: bound.hostId } };
    assert.equal(isBoundTerminalChannel(value), true);
    assert.equal(requireBoundTerminalId(value), bound.terminalId);
  }
});

test("legacy operator and unbound selections cannot grant terminal access or supply a fallback ID", () => {
  const directory = mkdtempSync(join(tmpdir(), "discord-channel-routing-"));
  try {
    const selections = new ChannelSessionStore(join(directory, "channel-sessions.json"));
    selections.set(orchestratorChannelId, binding.terminalId!);
    selections.set(channelId, "demo");
    for (const selectedChannel of [orchestratorChannelId, channelId]) {
      const value = { ...context, channelId: selectedChannel, binding: undefined, selectedSessionId: selections.get(selectedChannel) };
      assert.ok(value.selectedSessionId);
      rejectsControl(value);
    }
    const missingId = { ...context, binding: { ...binding, terminalId: undefined }, selectedSessionId: selections.get(orchestratorChannelId) };
    assert.equal(isBoundTerminalChannel(missingId), true);
    assert.throws(() => requireBoundTerminalId(missingId), SessionError);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("operator and bootstrap channels stay protected even when a matching terminal binding exists", () => {
  rejectsControl({ ...context, orchestratorChannelId: channelId });
  rejectsControl({ ...context, bootstrapChannelId: channelId });
});

test("moved channels and mismatched guild, category or physical host cannot control a terminal", () => {
  const other = "623456789012345678";
  const mismatches: BoundTerminalChannelContext[] = [
    { ...context, guildId: null },
    { ...context, guildId: other },
    { ...context, channelId: other },
    { ...context, parentId: null },
    { ...context, parentId: other },
    { ...context, binding: undefined },
    { ...context, category: undefined },
    { ...context, binding: { ...binding, guildId: other } },
    { ...context, binding: { ...binding, channelId: other } },
    { ...context, binding: { ...binding, categoryId: other } },
    { ...context, category: { ...category, guildId: other } },
    { ...context, category: { ...category, categoryId: other } },
    { ...context, category: { ...category, hostId: "gpu-server" } },
    { ...context, binding: { ...binding, hostId: "agent-0123456789abcdef" } },
    { ...context, binding: { ...binding, hostId: "" }, category: { ...category, hostId: "" } },
  ];
  for (const mismatch of mismatches) rejectsControl(mismatch);
});

test("stopped and unresolved bindings remain authorized for status/lifecycle but never for input", () => {
  for (const status of ["stopped", "provisioning", "failed", "orphaned"] as const) {
    const value = { ...context, binding: { ...binding, status } };
    assert.equal(isBoundTerminalChannel(value), true);
    assert.throws(() => requireBoundTerminalId(value), SessionError);
  }
});

test("a ready binding cannot resolve demo, missing or unsupported terminal IDs", () => {
  for (const terminalId of [undefined, "", "demo", "unknown-session", `${binding.terminalId}-other`]) {
    const value = { ...context, binding: { ...binding, terminalId } };
    assert.equal(isBoundTerminalChannel(value), true);
    assert.throws(() => requireBoundTerminalId(value), SessionError);
  }
});
