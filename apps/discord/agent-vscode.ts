import { AgentJob, AgentVscodeSession, validAgentVscodeSession } from "./agent-hub.js";
import { SessionError } from "./errors.js";
import { TerminalKey } from "./core.js";
import { localPlatform } from "./platform.js";
import { vscodeInventory, VscodeTerminal } from "./vscode.js";

/** Observe external terminals through their local extension; never own their processes. */
export class AgentVscodeRelay {
  constructor(readonly machine: string, readonly directory: string) {}
  inventory(): AgentVscodeSession[] {
    const records: AgentVscodeSession[] = vscodeInventory(this.directory).map(session => ({
      ...session, machine: this.machine, sourceMachine: session.machine, cwd: session.cwd ?? null,
      shared: session.shared && session.inputProtocol === "paced-submit-v1",
    }));
    const counts = new Map<string, number>();
    for (const record of records) counts.set(record.id, (counts.get(record.id) ?? 0) + 1);
    return records.filter(record => counts.get(record.id) === 1 && validAgentVscodeSession(record, { id: this.machine, platform: localPlatform() })).slice(0, 256);
  }
  async dispatch(job: AgentJob): Promise<unknown> {
    if (job.machine !== this.machine || !Number.isSafeInteger(job.deadline) || job.deadline <= Date.now()) throw new SessionError("Expired or wrong-machine VS Code request.");
    const id = job.args.id, generation = job.args.terminalGeneration;
    if (typeof id !== "string" || typeof generation !== "string" || !/^[a-f0-9]{32}$/.test(generation)) throw new SessionError("Invalid VS Code terminal identity.");
    const session = this.inventory().find(record => record.id === id);
    if (!session?.alive || !session.shared || session.inputProtocol !== "paced-submit-v1" || session.generation !== generation) throw new SessionError("VS Code terminal is closed, unshared, disconnected or changed generation. Update the extension and share it locally before controlling it.");
    const terminal = new VscodeTerminal(this.directory, id, generation, job.deadline);
    if (job.op === "vscode-status") return terminal.status();
    if (job.op === "vscode-output") return terminal.output(Number(job.args.lines));
    if (job.op === "vscode-send") {
      if (typeof job.args.text !== "string") throw new SessionError("VS Code input must be text.");
      await terminal.send(job.args.text); return true;
    }
    if (job.op === "vscode-key") { await terminal.pressKey(job.args.key as TerminalKey); return true; }
    throw new SessionError("Unsupported external terminal operation; VS Code terminals cannot be created or stopped by the agent.");
  }
}
