import { test } from "node:test";
import assert from "node:assert/strict";
import { PTY_SUBMIT_GAP_MS, submitPtyInput } from "../apps/discord/pty-input.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyClient, PtyTerminal } from "../apps/discord/pty-client.js";
import { PTY_KEY_PROTOCOL, PtyRecord } from "../apps/discord/pty-protocol.js";
import { AgentHub, AgentTerminalRecord, validSnapshot } from "../apps/discord/agent-hub.js";
import { AgentTerminal } from "../apps/discord/agent-client.js";

test("submit waits before its only Enter; burst-sensitive consumer receives one submission", async () => {
  let clock = 1000;
  let text = "", lastCharacter = 0, submissions = 0;
  const consume = (input: string) => {
    if (input === "\r") {
      if (clock - lastCharacter <= 120) text += "\n";
      else submissions++;
    } else { text += input; lastCharacter = clock; }
  };
  await submitPtyInput("Một prompt", consume, () => true, 3000, async ms => { clock += ms; }, () => clock);
  assert.equal(text, "Một prompt");
  assert.equal(submissions, 1);
});

test("expired, invalid or closed input never writes; loss after text never retries Enter", async () => {
  const writes: string[] = [];
  let alive = true, clock = 1000;
  const write = (text: string) => { writes.push(text); };
  await assert.rejects(submitPtyInput("hello", write, () => true, clock + PTY_SUBMIT_GAP_MS, async () => {}, () => clock), /no input sent/);
  await assert.rejects(submitPtyInput("hello", write, () => false, 3000), /exited/);
  await assert.rejects(submitPtyInput("bad\ninput", write, () => true, 3000), /one line/);
  assert.deepEqual(writes, []);
  await assert.rejects(submitPtyInput("hello", write, () => alive, 3000, async () => { alive = false; }, () => clock), /Enter was not sent/);
  assert.deepEqual(writes, ["hello"]);
  writes.length = 0; alive = true;
  await assert.rejects(submitPtyInput("next", write, () => alive, 3000, async () => { clock = 3000; }, () => clock), /Enter was not sent/);
  assert.deepEqual(writes, ["next"]);
});

test("uncertain transport failures never replay text or Enter", async () => {
  const writes: string[] = [];
  await assert.rejects(submitPtyInput("hello", text => { writes.push(text); throw new Error("pipe lost"); }, () => true, Date.now() + 1000), /pipe lost/);
  assert.deepEqual(writes, ["hello"]);
});

test("old ConPTY records block Shift + Left before RPC while preserving the original keys", async () => {
  class RecordingClient extends PtyClient {
    readonly calls: { op: string; args: Record<string, unknown> }[] = [];
    override async request<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
      this.calls.push({ op, args }); return undefined as T;
    }
  }
  const client = new RecordingClient({ version: 1, port: 1, token: "f".repeat(64), generation: "b".repeat(32), pid: 1 });
  const record: PtyRecord = { id: `pty-${"a".repeat(32)}`, label: "Existing terminal", machine: "local", cwd: "D:\\Project",
    kind: "shell", provider: "conpty", generation: "b".repeat(32), createdAt: 1, alive: true };
  const old = new PtyTerminal(record, client);
  await assert.rejects(old.pressKey("shift-left"), /unavailable.*safely upgrade.*terminals are closed/);
  assert.deepEqual(client.calls, []);
  for (const key of ["enter", "ctrl-c", "escape", "tab", "up", "down", "left", "right"] as const) {
    await old.pressKey(key);
    assert.deepEqual(client.calls.at(-1), { op: "key", args: { id: record.id, key } });
  }
  const current = new PtyTerminal({ ...record, keyProtocol: PTY_KEY_PROTOCOL }, client);
  await current.pressKey("shift-left");
  assert.deepEqual(client.calls.at(-1), { op: "key", args: { id: record.id, key: "shift-left" } });
  assert.equal(client.calls.length, 9);
});

test("agent ConPTY capabilities remain backward compatible and block unsupported keys before dispatch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "conpty-key-capability-"));
  const hub = new AgentHub(join(directory, "agents.json"), "700000000000000001", "800000000000000002");
  try {
    const pair = hub.enroll(hub.issuePair(), "windows-workstation", "win32", "D:\\Project"), machine = hub.authenticate(pair.machine, pair.token);
    const record: AgentTerminalRecord = { id: `pty-${"a".repeat(32)}`, machine: machine.id, label: "Existing terminal",
      cwd: "D:\\Project", kind: "shell", generation: "b".repeat(32) };
    const oldSnapshot = { generation: "c".repeat(32), terminals: [record] };
    const currentRecord = { ...record, keyProtocol: PTY_KEY_PROTOCOL }, currentSnapshot = { ...oldSnapshot, terminals: [currentRecord] };
    assert.equal(validSnapshot(oldSnapshot, machine), true);
    assert.equal(validSnapshot(currentSnapshot, machine), true);
    assert.equal(validSnapshot({ ...oldSnapshot, terminals: [{ ...record, keyProtocol: "unknown" }] }, machine), false);
    assert.equal(validSnapshot({ ...oldSnapshot, terminals: [{ ...record, keyProtocol: true }] }, machine), false);
    assert.equal(validSnapshot({ ...currentSnapshot, terminals: [{ ...currentRecord, id: "tmux-1234567890" }] }, machine), false);
    hub.poll(machine, oldSnapshot);
    const old = new AgentTerminal(record, hub);
    await assert.rejects(old.pressKey("shift-left"), /unavailable.*safely upgrade.*terminals are closed/);
    assert.deepEqual(hub.poll(machine, oldSnapshot), []);
    for (const key of ["enter", "ctrl-c", "escape", "tab", "up", "down", "left", "right"] as const) {
      const pending = old.pressKey(key), jobs = hub.poll(machine, oldSnapshot);
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].op, "key");
      assert.deepEqual(jobs[0].args, { key, id: record.id, terminalGeneration: record.generation });
      hub.result(machine, jobs[0].id, true); await pending;
    }
    hub.poll(machine, currentSnapshot);
    const pending = new AgentTerminal(currentRecord, hub).pressKey("shift-left"), jobs = hub.poll(machine, currentSnapshot);
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0].args, { key: "shift-left", id: record.id, terminalGeneration: record.generation });
    hub.result(machine, jobs[0].id, true); await pending;
    assert.deepEqual(hub.poll(machine, currentSnapshot), []);
    const linuxPair = hub.enroll(hub.issuePair(), "Linux", "linux", "/tmp"), linux = hub.authenticate(linuxPair.machine, linuxPair.token);
    const tmux = { ...record, id: "tmux-1234567890", machine: linux.id, cwd: "/tmp" }, linuxSnapshot = { ...oldSnapshot, terminals: [tmux] };
    hub.poll(linux, linuxSnapshot);
    const tmuxPending = new AgentTerminal(tmux, hub).pressKey("shift-left"), tmuxJobs = hub.poll(linux, linuxSnapshot);
    assert.equal(tmuxJobs.length, 1);
    assert.equal(tmuxJobs[0].args.key, "shift-left");
    hub.result(linux, tmuxJobs[0].id, true); await tmuxPending;
  } finally { hub.close(); rmSync(directory, { recursive: true, force: true }); }
});
