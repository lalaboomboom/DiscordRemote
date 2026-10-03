import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { AgentJob, AgentSnapshot, AgentTerminalRecord } from "./agent-hub.js";
import { ActionQueue } from "./action-queue.js";
import { HostExecutor } from "./hosts.js";
import { ManagedTerminal } from "./pty-protocol.js";
import { ensurePtySupervisor, PtyClient, PtyTerminal } from "./pty-client.js";
import { localPlatform, requireWorkingDirectory } from "./platform.js";
import { createManagedTmux, ManagedTmuxTerminal, TerminalKey, tmuxRunner } from "./core.js";
import { ManagedSessionStore } from "./managed-sessions.js";
import { AgentVscodeRelay } from "./agent-vscode.js";
import { validCodexEventRequest } from "./codex-events.js";

/** The network client can restart without owning or terminating terminal processes. */
export class AgentRuntime {
  readonly generation = randomBytes(16).toString("hex");
  private terminalGeneration: string;
  private terminals = new Map<string, ManagedTerminal>();
  private pty?: PtyClient;
  private queues = new ActionQueue();
  private store: ManagedSessionStore;
  private executor: HostExecutor;
  private readonly vscode: AgentVscodeRelay;
  private constructor(readonly machine: string, readonly state: string, readonly cwd: string) {
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const generationFile = resolve(state, "terminal-generation");
    if (!existsSync(generationFile)) writeFileSync(generationFile, randomBytes(16).toString("hex"), { flag: "wx", mode: 0o600 });
    this.terminalGeneration = readFileSync(generationFile, "utf8");
    if (!/^[a-f0-9]{32}$/.test(this.terminalGeneration)) throw new Error("Invalid agent generation.");
    this.store = new ManagedSessionStore(resolve(state, "tmux-sessions.json"));
    this.executor = new HostExecutor({ id: machine, label: machine, kind: "local", cwd }, process.cwd());
    this.vscode = new AgentVscodeRelay(machine, resolve(process.env.REMOTE_OPERATOR_VSCODE_BRIDGE_DIRECTORY || state));
  }
  static async start(machine: string, state: string, cwd: string): Promise<AgentRuntime> {
    if (!/^agent-[a-f0-9]{16}$/.test(machine)) throw new Error("Invalid machine identity.");
    requireWorkingDirectory(cwd, localPlatform());
    const runtime = new AgentRuntime(machine, state, cwd);
    if (process.platform === "win32") runtime.pty = await ensurePtySupervisor(state);
    else for (const record of runtime.store.load()) runtime.terminals.set(record.id, new ManagedTmuxTerminal(record, tmuxRunner(process.env.TMUX_BIN || "tmux", record.socket)));
    return runtime;
  }
  private record(terminal: ManagedTerminal): AgentTerminalRecord {
    return { ...terminal.record, generation: terminal instanceof PtyTerminal ? terminal.record.generation : this.terminalGeneration };
  }
  async snapshot(): Promise<AgentSnapshot> {
    if (this.pty) for (const record of await this.pty.list()) this.terminals.set(record.id, new PtyTerminal(record, this.pty));
    return { generation: this.generation, terminals: [...this.terminals.values()].map(t => this.record(t)).slice(-256), vscode: this.vscode.inventory() };
  }
  async dispatch(job: AgentJob): Promise<unknown> {
    if (!job || job.machine !== this.machine || job.generation !== this.generation || !/^[a-f0-9]{32}$/.test(job.id) || !Number.isSafeInteger(job.deadline) || job.deadline < Date.now() || job.deadline > Date.now() + 90_000) throw new Error("Stale or wrong-machine request.");
    const claims = resolve(this.state, "actions"); mkdirSync(claims, { recursive: true, mode: 0o700 });
    // A crash after claim grants no permission to replay any side effect.
    writeFileSync(resolve(claims, job.id), String(job.deadline), { flag: "wx", mode: 0o600 });
    const key = job.op === "codex-events" ? "codex-events" : ["run", "profile", "writeFile", "removeFile", "cleanup"].includes(job.op) ? "host" : String(job.args.id ?? "create");
    return this.queues.run(key, async () => {
      if (Date.now() > job.deadline) throw new Error("Expired queued request.");
      const a = job.args;
      if (job.op.startsWith("vscode-")) return this.vscode.dispatch(job);
      if (job.op === "codex-events") {
        if (!validCodexEventRequest(a)) throw new Error("Invalid Codex event request.");
        const result = await this.executor.readCodexEvents(a);
        if (Date.now() > job.deadline) throw new Error("Expired Codex event read.");
        return result;
      }
      if (job.op === "profile") { requireWorkingDirectory(String(a.cwd), localPlatform()); if (!statSync(String(a.cwd)).isDirectory()) throw new Error("Directory unavailable."); if (process.platform === "linux") await tmuxRunner(process.env.TMUX_BIN || "tmux", `agent-${this.machine}`)(["-V"]); return true; }
      if (job.op === "run") return this.executor.run(String(a.command), Number(a.timeoutMs), String(a.cwd));
      if (job.op === "writeFile") { if (typeof a.base64 !== "string" || a.base64.length > 5_600_000) throw new Error("File too large."); await this.executor.writeFile(String(a.path), Buffer.from(a.base64, "base64"), String(a.cwd)); return true; }
      if (job.op === "removeFile") { await this.executor.removeFile(String(a.path), String(a.cwd)); return true; }
      if (job.op === "cleanup") { await this.executor.cleanupAttachmentInbox(Number(a.maxAgeMs), String(a.cwd)); return true; }
      if (job.op === "create") {
        const kind = a.kind; if (kind !== "shell" && kind !== "bash" && kind !== "codex") throw new Error("Invalid terminal kind.");
        const cwd = String(a.cwd), requestId = String(a.requestId);
        requireWorkingDirectory(cwd, localPlatform());
        if (!/^[A-Za-z0-9:_-]{1,160}$/.test(requestId)) throw new Error("Invalid creation identity.");
        let terminal: ManagedTerminal;
        if (this.pty) { if (kind === "bash") throw new Error("Choose Default shell on Windows."); terminal = await this.pty.create(cwd, this.machine, kind, requestId); }
        else {
          const file = resolve(this.state, `create-${createHash("sha256").update(requestId).digest("hex")}`);
          writeFileSync(file, "claimed", { flag: "wx", mode: 0o600 });
          const socket = `agent-${this.machine}`;
          const created = await createManagedTmux(tmuxRunner(process.env.TMUX_BIN || "tmux", socket), kind === "shell" ? "bash" : kind, cwd, this.machine, socket);
          this.store.add(created.record); terminal = created.terminal;
        }
        this.terminals.set(terminal.record.id, terminal); return this.record(terminal);
      }
      const terminal = this.terminals.get(String(a.id));
      if (!terminal || this.record(terminal).generation !== a.terminalGeneration) throw new Error("Unknown or stale terminal generation.");
      if (job.op === "status") return terminal.status();
      if (job.op === "output") return terminal.output(Number(a.lines));
      if (job.op === "send") { await terminal.send(String(a.text)); return true; }
      if (job.op === "key") { await terminal.pressKey(a.key as TerminalKey); return true; }
      if (job.op === "stop") { if (!/\bdead=1\b|\balive=false\b/.test(await terminal.status())) await terminal.stop(); return true; }
      throw new Error("Unsupported agent operation.");
    });
  }
}
