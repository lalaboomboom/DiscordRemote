import { AgentHub, AgentVscodeSession } from "./agent-hub.js";
import { SessionError } from "./errors.js";
import { TerminalControl, TerminalKey, validateInput } from "./core.js";
import { requireShiftLeftProvider } from "./vscode.js";

/** Discovery is independent of permission to control a tab. */
export class RemoteVscodeRegistry {
  private records = new Map<string, AgentVscodeSession>();
  constructor(readonly hub: AgentHub) {}

  sync(machine: string, records: AgentVscodeSession[], localIds: Set<string> = new Set()): void {
    if (new Set(records.map(record => record.id)).size !== records.length) throw new SessionError("Duplicate VS Code terminal identity; no session was retargeted.");
    // Validate the entire batch before changing previously observed ownership.
    for (const record of records) {
      const previous = this.records.get(record.id);
      if (record.machine !== machine || localIds.has(record.id) || (previous && previous.machine !== machine)) {
        throw new SessionError("VS Code terminal identity collision; no session was retargeted.");
      }
    }
    for (const [id, record] of this.records) if (record.machine === machine) this.records.delete(id);
    for (const record of records) this.records.set(record.id, structuredClone(record));
  }

  list(): AgentVscodeSession[] { return [...this.records.values()].map(record => structuredClone(record)); }
  get(id: string): AgentVscodeSession | undefined {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }
  require(id: string, generation: string): AgentVscodeSession {
    const record = this.get(id);
    if (!record || record.generation !== generation || !record.alive || !record.shared
      || record.inputProtocol !== "paced-submit-v1" || !this.hub.online(record.machine)) {
      throw new SessionError("VS Code tab is unshared, closed or disconnected; input was not redirected. Share the original tab again and inspect /sessions.");
    }
    return record;
  }
}

/** The enrolled agent relays IPC to the UI extension; it never owns this process. */
export class RemoteVscodeTerminal implements TerminalControl {
  constructor(readonly record: AgentVscodeSession, readonly registry: RemoteVscodeRegistry) {}
  private async call<T>(operation: string, args: Record<string, unknown> = {}): Promise<T> {
    const current = this.registry.require(this.record.id, this.record.generation);
    if (operation === "key" && args.key === "shift-left") requireShiftLeftProvider(current.providerVersion);
    return this.registry.hub.request(this.record.machine, `vscode-${operation}`, {
      ...args, id: this.record.id, terminalGeneration: this.record.generation,
    });
  }
  status(): Promise<string> { return this.call("status"); }
  output(lines: number): Promise<string> {
    if (!Number.isInteger(lines) || lines < 1 || lines > 100) throw new SessionError("Lines must be 1–100.");
    return this.call("output", { lines });
  }
  async send(text: string): Promise<void> { validateInput(text); await this.call("send", { text }); }
  async pressKey(key: TerminalKey): Promise<void> { await this.call("key", { key }); }
  async interrupt(): Promise<void> { await this.pressKey("ctrl-c"); }
}
