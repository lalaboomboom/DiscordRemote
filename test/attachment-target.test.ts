import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentSession, resolveAttachmentTarget, validateAttachmentTarget } from "../apps/discord/attachment-target.js";
import { HostTarget } from "../apps/discord/hosts.js";
import { CategoryBindingRecord, ChannelBindingRecord, ChannelBindingStore } from "../apps/discord/topology.js";

const guildId = "700000000000000001", categoryId = "700000000000000006", channelId = "700000000000000008";
const id = `vsc-${"a".repeat(16)}-12345678`, generation = "b".repeat(32);
const agentId = "agent-" + "c".repeat(16), secondAgentId = "agent-" + "d".repeat(16);
const local: HostTarget = { id: "local", label: "Coordinator PC", kind: "local", platform: "linux", cwd: "/project" };
const gpu: HostTarget = { id: "gpu", label: "RTX", kind: "ssh", platform: "linux", cwd: "/datasets/project", host: "gpu.internal", user: "owner", port: 22 };
const msi: HostTarget = { id: agentId, label: "windows-workstation", kind: "agent", platform: "win32", cwd: "D:\\Project" };
const other: HostTarget = { ...msi, id: secondAgentId, label: "Other laptop" };
const targets = [local, gpu, msi, other];
const encoded = (object: object) => "ssh-remote+" + Buffer.from(JSON.stringify(object)).toString("hex");
const session: AttachmentSession = { id, machine: "coordinator-pc", provider: "vscode", cwd: "/project", generation,
  platform: "linux", remote: false, alive: true, shared: true, reachable: true, inputProtocol: "paced-submit-v1", cwdSource: "shellIntegration" };
const category = (host: HostTarget): CategoryBindingRecord => ({ guildId, categoryId, hostId: host.id, defaultCwd: host.cwd, createdAt: 1, updatedAt: 1 });
function binding(host: HostTarget, candidate: AttachmentSession, relayMachine?: string): ChannelBindingRecord {
  return { guildId, channelId, categoryId, hostId: host.id, cwd: candidate.cwd!, terminalId: candidate.id,
    terminalGeneration: candidate.generation, provider: candidate.provider as ChannelBindingRecord["provider"],
    ...(relayMachine ? { relayMachine } : {}), status: "ready", createdAt: 1, updatedAt: 1 };
}

test("coordinator-local VS Code attachment preserves the raw UI identity while using the configured local host", () => {
  const resolved = validateAttachmentTarget(targets, session, category(local));
  assert.equal(resolved.host, local);
  assert.deepEqual(resolved.identity, { machine: "coordinator-pc", generation, provider: "vscode" });
  assert.equal(resolved.relayMachine, undefined);
  assert.deepEqual(validateAttachmentTarget(targets, session, category(local), binding(local, session)), resolved);
  assert.equal(resolveAttachmentTarget(targets, { ...session, shared: false }).host, local); // Discovery does not grant input.
  assert.doesNotThrow(() => validateAttachmentTarget(targets, { ...session, cwd: "/another-project" }, category(local)));
});

test("local Remote-SSH authority decodes uniquely but remains unchanged in the input identity", () => {
  for (const machine of ["ssh-remote+gpu", "ssh-remote+gpu.internal", "gpu", encoded({ hostName: "gpu" }), encoded({ hostname: "gpu.internal" })]) {
    const remote = { ...session, machine, remote: true, cwd: gpu.cwd };
    const resolved = validateAttachmentTarget(targets, remote, category(gpu));
    assert.equal(resolved.host, gpu); assert.equal(resolved.relayMachine, undefined);
    assert.deepEqual(resolved.identity, { machine, generation, provider: "vscode" });
    assert.deepEqual(validateAttachmentTarget(targets, remote, category(gpu), binding(gpu, remote)), resolved);
    assert.throws(() => validateAttachmentTarget(targets, remote, category(local)), /machine must match/);
  }
});

test("agent Remote-SSH attachment binds the physical SSH machine and separately pins the original Windows agent relay", () => {
  const remote: AttachmentSession = { ...session, provider: "vscode-agent", machine: agentId, platform: "win32", remote: true,
    sourceMachine: encoded({ hostName: "gpu" }), cwd: gpu.cwd };
  const resolved = validateAttachmentTarget(targets, remote, category(gpu));
  assert.equal(resolved.host, gpu); assert.equal(resolved.relayMachine, agentId);
  assert.deepEqual(resolved.identity, { machine: agentId, generation, provider: "vscode-agent" });
  assert.deepEqual(validateAttachmentTarget(targets, remote, category(gpu), binding(gpu, remote, agentId)), resolved);
  assert.throws(() => validateAttachmentTarget(targets, remote, category(msi)), /machine must match/);
  assert.throws(() => validateAttachmentTarget(targets, remote, category(gpu), binding(gpu, remote)), /original terminal/);
  assert.throws(() => validateAttachmentTarget(targets, { ...remote, machine: secondAgentId }, category(gpu), binding(gpu, remote, agentId)), /original terminal/);
});

test("ordinary enrolled Windows tabs keep Windows cwd identity and allow only the equivalent legacy nonremote relay binding", () => {
  const candidate: AttachmentSession = { ...session, provider: "vscode-agent", machine: agentId, sourceMachine: "windows-workstation", platform: "win32", cwd: "d:/Project/" };
  const resolved = validateAttachmentTarget(targets, candidate, category(msi));
  assert.equal(resolved.host, msi); assert.equal(resolved.relayMachine, agentId);
  assert.deepEqual(validateAttachmentTarget(targets, candidate, category(msi), binding(msi, candidate)), resolved);
  for (const cwd of ["D:\\project", "E:\\Project", "D:\\Other"]) {
    assert.doesNotThrow(() => validateAttachmentTarget(targets, { ...candidate, cwd }, category(msi), binding(msi, candidate)));
  }
  for (const cwd of ["/Project", "Project", "D:relative", "D:\\Other\n"]) {
    assert.throws(() => validateAttachmentTarget(targets, { ...candidate, cwd }, category(msi)));
  }
  assert.throws(() => validateAttachmentTarget(targets, { ...candidate, machine: "windows-workstation" }, category(msi)), /not configured/);
  assert.throws(() => validateAttachmentTarget(targets, { ...candidate, platform: "linux" }, category(msi)), /UI host/);
  const windowsLocal = { ...local, platform: "win32" as const, cwd: "D:\\Project" };
  assert.equal(validateAttachmentTarget([windowsLocal], { ...candidate, provider: "vscode", machine: "personal-pc" }, category(windowsLocal)).host, windowsLocal);
});

test("unknown, WSL, malformed and ambiguous Remote-SSH sources never fall back to the UI machine", () => {
  const remote: AttachmentSession = { ...session, provider: "vscode-agent", machine: agentId, platform: "win32", remote: true, cwd: gpu.cwd };
  for (const sourceMachine of [undefined, "missing", "wsl", "wsl+Ubuntu", "dev-container+1234", "ssh-remote", "ssh-remote+deadbeef", "gpu\n", encoded({ hostName: "gpu", hostname: "local" })]) {
    assert.throws(() => resolveAttachmentTarget(targets, { ...remote, sourceMachine }));
  }
  for (const sourceMachine of ["local", agentId]) assert.throws(() => resolveAttachmentTarget(targets, { ...remote, sourceMachine }), /actual configured SSH/);
  const duplicate = { ...gpu, id: "another-gpu" };
  assert.throws(() => resolveAttachmentTarget([...targets, duplicate], { ...remote, sourceMachine: "gpu.internal" }), /No configured host matches/);
  // A known exact ID stays authoritative even if another target reuses its display label.
  assert.equal(resolveAttachmentTarget([...targets, { ...duplicate, label: "gpu" }], { ...remote, sourceMachine: "gpu" }).host, gpu);
  assert.throws(() => resolveAttachmentTarget(targets, { ...session, machine: "ssh-remote+gpu" }), /conflicts/);
  assert.throws(() => resolveAttachmentTarget(targets, { ...remote, remote: false, sourceMachine: "wsl+Ubuntu", cwd: msi.cwd }), /conflicts/);
});

test("remote attachment requires a reported terminal cwd instead of a workspace guess", () => {
  const remote = { ...session, machine: "ssh-remote+gpu", remote: true, cwd: gpu.cwd };
  for (const cwdSource of ["shellIntegration", "creationOptions"] as const) {
    assert.doesNotThrow(() => validateAttachmentTarget(targets, { ...remote, cwdSource }, category(gpu)));
  }
  for (const cwdSource of ["workspace", undefined] as const) {
    assert.throws(() => validateAttachmentTarget(targets, { ...remote, cwdSource }, category(gpu)), /workspace fallback|missing cwd/);
  }
  assert.doesNotThrow(() => validateAttachmentTarget(targets, { ...session, cwdSource: "workspace" }, category(local)));
});

test("stale generation, unshared/offline tabs and changed physical category targets fail closed", () => {
  const pinned = binding(local, session);
  for (const patch of [{ shared: false }, { alive: false }, { reachable: false }, { inputProtocol: undefined }, { generation: "invalid" }, { generation: "e".repeat(32) }, { machine: "coordinator\nother" }, { cwd: null }]) {
    assert.throws(() => validateAttachmentTarget(targets, { ...session, ...patch }, category(local), pinned));
  }
  assert.throws(() => validateAttachmentTarget(targets, session, category(local), { ...pinned, terminalGeneration: undefined }), /original terminal/);
  const remote = { ...session, machine: "ssh-remote+gpu.internal", remote: true, cwd: gpu.cwd };
  const original = binding(gpu, remote), replacement = { ...gpu, id: "replacement" };
  assert.throws(() => validateAttachmentTarget([local, replacement], remote, category(replacement), original), /original terminal/);
  assert.doesNotThrow(() => validateAttachmentTarget(targets, remote, { ...category(gpu), defaultCwd: "/another" }, original));
});

test("same-generation shared tabs may cd while their saved diagnostic folder and routing identity remain pinned", () => {
  const remote: AttachmentSession = { ...session, provider: "vscode-agent", machine: agentId, platform: "win32", remote: true,
    sourceMachine: encoded({ hostName: "gpu" }), cwd: "/datasets/other-project" };
  const pinnedRemote = binding(gpu, { ...remote, cwd: gpu.cwd }, agentId);
  const windows = { ...session, provider: "vscode-agent", machine: agentId, sourceMachine: "windows-workstation", platform: "win32" as const, cwd: "E:\\Another" };
  const pinnedWindows = binding(msi, { ...windows, cwd: msi.cwd }, agentId);
  const cases = [
    { candidate: { ...session, cwd: "/another-project" }, host: local, pinned: binding(local, session) },
    { candidate: remote, host: gpu, pinned: pinnedRemote },
    { candidate: windows, host: msi, pinned: pinnedWindows },
  ];
  for (const { candidate, host, pinned } of cases) {
    const before = structuredClone(pinned);
    assert.equal(validateAttachmentTarget(targets, candidate, category(host), pinned).host, host);
    assert.deepEqual(pinned, before); // cd does not rewrite the diagnostic/project default.
    for (const patch of [{ id: `vsc-${"a".repeat(16)}-87654321` }, { generation: "e".repeat(32) }, { shared: false }, { alive: false }]) {
      assert.throws(() => validateAttachmentTarget(targets, { ...candidate, ...patch }, category(host), pinned));
    }
  }
  assert.throws(() => validateAttachmentTarget(targets, { ...remote, machine: secondAgentId }, category(gpu), pinnedRemote), /original terminal/);
  assert.throws(() => validateAttachmentTarget(targets, remote, category(local), pinnedRemote), /machine must match/);
  assert.throws(() => validateAttachmentTarget(targets, remote, category(gpu), { ...pinnedRemote, cwd: "D:\\WrongOS" }), /absolute Linux/);
  assert.throws(() => validateAttachmentTarget(targets, windows, category(msi), { ...pinnedWindows, cwd: "/wrong-os" }), /absolute Windows/);
});

test("terminal-specific folders accept valid Linux/Windows paths and reject invalid or wrong-OS reports", () => {
  for (const cwd of ["/another-project", "/", "/datasets/experiments/run-1"]) {
    assert.doesNotThrow(() => validateAttachmentTarget(targets, { ...session, cwd }, category(local)));
  }
  for (const cwd of [undefined, null, "", "relative", "D:\\Windows", "/bad\npath"]) {
    assert.throws(() => validateAttachmentTarget(targets, { ...session, cwd }, category(local)), /valid absolute/);
  }
  const windows = { ...session, provider: "vscode-agent", machine: agentId, sourceMachine: "windows-workstation", platform: "win32" as const };
  for (const cwd of ["D:\\Other", "E:/Training/", "\\\\server\\share\\Project"]) {
    assert.doesNotThrow(() => validateAttachmentTarget(targets, { ...windows, cwd }, category(msi)));
  }
  for (const cwd of [undefined, null, "", "relative", "D:relative", "/linux", "\\\\?\\C:\\Device", "D:\\bad\npath"]) {
    assert.throws(() => validateAttachmentTarget(targets, { ...windows, cwd }, category(msi)), /valid absolute/);
  }
});

test("managed existing terminals retain exact host IDs and cannot attach using display aliases", () => {
  const candidate = { id: "tmux-1234567890", machine: gpu.id, provider: "tmux", cwd: gpu.cwd };
  assert.equal(validateAttachmentTarget(targets, candidate, category(gpu)).host, gpu);
  assert.throws(() => validateAttachmentTarget(targets, { ...candidate, machine: gpu.host! }, category(gpu)), /not configured/);
  assert.throws(() => resolveAttachmentTarget(targets, { ...candidate, id: "demo" }), /supported existing/);
  const ownProject = { ...candidate, cwd: "/datasets/another-project" };
  const pinned = binding(gpu, ownProject);
  assert.doesNotThrow(() => validateAttachmentTarget(targets, ownProject, category(gpu), pinned));
  assert.throws(() => validateAttachmentTarget(targets, ownProject, category(gpu), { ...pinned, cwd: "/datasets/wrong-record" }), /recorded directory/);
  assert.throws(() => validateAttachmentTarget(targets, { ...ownProject, cwd: "/datasets/changed-record" }, category(gpu), pinned), /recorded directory/);
});

test("stored external channel bindings preserve relay identity and reject missing or foreign relay fields without writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "attachment-bindings-"));
  try {
    const file = join(directory, "channels.json"), store = new ChannelBindingStore(file);
    const remote = { ...session, provider: "vscode-agent", machine: agentId, platform: "win32" as const, remote: true, sourceMachine: "gpu", cwd: gpu.cwd };
    const persisted = binding(gpu, remote, agentId);
    store.set(persisted);
    assert.deepEqual(new ChannelBindingStore(file).get(channelId), persisted);
    const before = readFileSync(file, "utf8");
    for (const patch of [{ relayMachine: undefined }, { relayMachine: "windows-workstation" }, { relayMachine: "local" }, { provider: "vscode" }, { provider: "tmux" }]) {
      assert.throws(() => store.set({ ...persisted, ...patch } as ChannelBindingRecord), /invalid terminal channel binding/);
      assert.equal(readFileSync(file, "utf8"), before);
    }
    const legacy = binding(msi, { ...remote, remote: false, cwd: msi.cwd });
    store.set(legacy);
    assert.deepEqual(new ChannelBindingStore(file).get(channelId), legacy);
    const localBinding = binding(local, session); store.set(localBinding);
    assert.deepEqual(new ChannelBindingStore(file).get(channelId), localBinding);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
