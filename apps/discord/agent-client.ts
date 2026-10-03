import { AgentHub, AgentMachine, AgentTerminalRecord, validSnapshot } from "./agent-hub.js";
import { HostExecutor, HostResult } from "./hosts.js";
import { TerminalKey } from "./core.js";
import { ManagedTerminal, requirePtyKeyProtocol } from "./pty-protocol.js";
import { CodexEventRequest, CodexEventResponse, validCodexEventRequest, validCodexEventResponse } from "./codex-events.js";
import { requireWorkingDirectory } from "./platform.js";

export class AgentHostExecutor extends HostExecutor {
  constructor(readonly machine: AgentMachine, readonly hub: AgentHub) {
    super({ id: machine.id, label: machine.label, platform: machine.platform, kind: "agent", cwd: machine.cwd }, ".");
  }
  override run(command: string, timeoutMs = 15_000, cwd = this.target.cwd): Promise<HostResult> { return this.hub.request(this.machine.id, "run", { command, timeoutMs, cwd }, timeoutMs + 5000); }
  override async writeFile(path: string, data: Buffer, cwd = this.target.cwd) { await this.hub.request(this.machine.id, "writeFile", { path, base64: data.toString("base64"), cwd }, 60_000); }
  override async removeFile(path: string, cwd = this.target.cwd) { await this.hub.request(this.machine.id, "removeFile", { path, cwd }); }
  override async cleanupAttachmentInbox(maxAgeMs: number, cwd = this.target.cwd) { await this.hub.request(this.machine.id, "cleanup", { maxAgeMs, cwd }); }
  override async readCodexEvents(request: CodexEventRequest): Promise<CodexEventResponse> {
    if (!validCodexEventRequest(request)) throw new Error("Invalid Codex event request.");
    requireWorkingDirectory(request.cwd, this.machine.platform);
    const response = await this.hub.request<unknown>(this.machine.id, "codex-events", { ...request }, 15_000);
    if (!validCodexEventResponse(response) || response.threadId !== request.threadId || response.cwd !== request.cwd) throw new Error("Invalid Codex event response.");
    return response;
  }
  async profile(cwd: string) { await this.hub.request(this.machine.id, "profile", { cwd }); }
  async create(kind: string, cwd: string, requestId: string) {
    const record = await this.hub.request<AgentTerminalRecord>(this.machine.id, "create", { kind, cwd, requestId });
    if (!validSnapshot({ generation: "0".repeat(32), terminals: [record] }, this.machine) || record.cwd !== cwd) throw new Error("Agent returned an invalid terminal identity.");
    return new AgentTerminal(record, this.hub);
  }
}
export class AgentTerminal implements ManagedTerminal {
  constructor(readonly record: AgentTerminalRecord, readonly hub: AgentHub) {}
  private call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> { return this.hub.request(this.record.machine, op, { ...args, id: this.record.id, terminalGeneration: this.record.generation }); }
  status(): Promise<string> { return this.call("status"); }
  output(lines: number): Promise<string> { return this.call("output", { lines }); }
  send(text: string): Promise<void> { return this.call("send", { text }); }
  async pressKey(key: TerminalKey): Promise<void> {
    if (this.record.id.startsWith("pty-")) requirePtyKeyProtocol(this.record, key);
    await this.call("key", { key });
  }
  interrupt(): Promise<void> { return this.pressKey("ctrl-c"); }
  stop(): Promise<void> { return this.call("stop"); }
}
