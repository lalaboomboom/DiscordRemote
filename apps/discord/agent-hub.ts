import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SessionError } from "./errors.js";
import { HostPlatform, validWorkingDirectory } from "./platform.js";
import { PTY_KEY_PROTOCOL } from "./pty-protocol.js";

export interface AgentTerminalRecord { id: string; machine: string; label: string; cwd: string; kind: string; generation: string; keyProtocol?: typeof PTY_KEY_PROTOCOL }
export interface AgentVscodeSession {
  id: string; machine: string; label: string; cwd: string | null; instance: string; generation: string;
  pid: number | null; alive: boolean; shared: boolean; platform: HostPlatform; remote: boolean;
  sourceMachine: string; cwdSource?: "shellIntegration" | "creationOptions" | "workspace"; inputProtocol?: "paced-submit-v1"; providerVersion?: string;
}
export interface AgentMachine { id: string; label: string; platform: HostPlatform; cwd: string; tokenHash: string; revoked: boolean; guildId: string; ownerId: string }
export interface AgentSnapshot { generation: string; terminals: AgentTerminalRecord[]; vscode?: AgentVscodeSession[] }
export interface AgentPresence { id: string; label: string; platform: HostPlatform; cwd: string; online: boolean; lastSeen: number | null; terminalCount: number; vscodeCount?: number; sharedVscodeCount?: number }
export interface AgentJob { id: string; machine: string; generation: string; deadline: number; op: string; args: Record<string, unknown> }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function coordinatorUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Coordinator URL must be an origin without credentials/path/query.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Coordinator requires HTTPS, or a loopback HTTP endpoint through an authenticated tunnel.");
  return url;
}
export function validAgentVscodeSession(value: unknown, machine: Pick<AgentMachine, "id" | "platform">): value is AgentVscodeSession {
  if (!value || typeof value !== "object") return false;
  const record = value as AgentVscodeSession;
  return typeof record.id === "string" && /^vsc-[a-f0-9]{16}-[a-f0-9]{8}$/.test(record.id)
    && typeof record.instance === "string" && /^[a-f0-9]{16}$/.test(record.instance) && record.id.startsWith(`vsc-${record.instance}-`)
    && record.machine === machine.id && record.platform === machine.platform
    && typeof record.generation === "string" && /^[a-f0-9]{32}$/.test(record.generation)
    && typeof record.label === "string" && record.label.length <= 160
    && typeof record.sourceMachine === "string" && record.sourceMachine.length > 0 && record.sourceMachine.length <= 200 && !/[\x00-\x1f\x7f]/.test(record.sourceMachine)
    && (record.pid === null || Number.isSafeInteger(record.pid) && record.pid > 0)
    && typeof record.alive === "boolean" && typeof record.shared === "boolean" && typeof record.remote === "boolean"
    && (record.providerVersion === undefined || typeof record.providerVersion === "string" && record.providerVersion.length <= 40)
    && (record.inputProtocol === undefined || record.inputProtocol === "paced-submit-v1") && (!record.shared || record.inputProtocol === "paced-submit-v1")
    && (record.cwd === null || validWorkingDirectory(record.cwd, record.remote ? undefined : record.platform))
    && (record.cwdSource === undefined || ["shellIntegration", "creationOptions", "workspace"].includes(record.cwdSource));
}
export function validSnapshot(value: unknown, machine: AgentMachine): value is AgentSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as AgentSnapshot;
  if (!(typeof v.generation === "string" && /^[a-f0-9]{32}$/.test(v.generation) && Array.isArray(v.terminals) && v.terminals.length <= 256
    && v.terminals.every(r => r && typeof r.id === "string" && /^(pty-[a-f0-9]{32}|tmux-[a-f0-9]{10})$/.test(r.id) && r.machine === machine.id
      && typeof r.label === "string" && r.label.length <= 160 && validWorkingDirectory(r.cwd, machine.platform)
      && ["shell", "bash", "codex"].includes(r.kind) && typeof r.generation === "string" && /^[a-f0-9]{32}$/.test(r.generation)
      && (r.keyProtocol === undefined || r.id.startsWith("pty-") && r.keyProtocol === PTY_KEY_PROTOCOL)))) return false;
  if (v.vscode !== undefined && (!Array.isArray(v.vscode) || v.vscode.length > 256 || !v.vscode.every(record => validAgentVscodeSession(record, machine)))) return false;
  const ids = [...v.terminals, ...(v.vscode ?? [])].map(record => record.id);
  return new Set(ids).size === ids.length;
}

export class AgentHub {
  private machines: AgentMachine[];
  private pairs = new Map<string, number>();
  private live = new Map<string, { snapshot: AgentSnapshot; seen: number }>();
  private pending = new Map<string, { job: AgentJob; sent: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private attempts: number[] = [];
  onSnapshot?: (machine: AgentMachine, snapshot: AgentSnapshot) => void;
  constructor(readonly file: string, readonly guildId: string, readonly ownerId: string) {
    this.machines = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).machines : [];
    if (!Array.isArray(this.machines) || this.machines.some(m => !/^agent-[a-f0-9]{16}$/.test(m.id) || !/^[a-f0-9]{64}$/.test(m.tokenHash) || m.guildId !== guildId || m.ownerId !== ownerId || !["win32", "linux"].includes(m.platform) || !validWorkingDirectory(m.cwd, m.platform))) throw new Error("Invalid/scoped agent registry; refusing startup.");
  }
  private save() { mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }); const tmp = `${this.file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify({ version: 1, machines: this.machines }), { mode: 0o600 }); renameSync(tmp, this.file); }
  list(): AgentMachine[] { return structuredClone(this.machines.filter(m => !m.revoked)); }
  online(id: string, now = Date.now()): boolean {
    const live = this.live.get(id);
    const age = now - (live?.seen ?? 0);
    return Boolean(live && age >= 0 && age < 8000);
  }
  /** Non-secret observations for the coordinator heartbeat and local diagnostics. */
  presence(now = Date.now()): AgentPresence[] {
    return this.machines.filter(machine => !machine.revoked).map(machine => {
      const live = this.live.get(machine.id);
      return { id: machine.id, label: machine.label, platform: machine.platform, cwd: machine.cwd,
        online: this.online(machine.id, now), lastSeen: live?.seen ?? null,
        terminalCount: live?.snapshot.terminals.length ?? 0,
        ...(live?.snapshot.vscode ? { vscodeCount: live.snapshot.vscode.length, sharedVscodeCount: live.snapshot.vscode.filter(session => session.alive && session.shared).length } : {}) };
    });
  }
  issuePair(): string {
    for (const [key, expiry] of this.pairs) if (expiry < Date.now()) this.pairs.delete(key);
    if (this.pairs.size >= 16) throw new SessionError("Too many pending pairings; wait five minutes.");
    const code = randomBytes(24).toString("hex"); this.pairs.set(digest(code), Date.now() + 300_000); return code;
  }
  enroll(code: string, label: string, platform: HostPlatform, cwd: string) {
    this.attempts = this.attempts.filter(time => Date.now() - time < 60_000);
    if (this.attempts.length >= 20) throw new Error("Pair rate limit reached.");
    this.attempts.push(Date.now());
    const hash = digest(code), expiry = this.pairs.get(hash);
    if (!expiry || expiry < Date.now()) throw new Error("Pair code expired or invalid.");
    if (typeof label !== "string" || !label.trim() || label.length > 100 || !["linux", "win32"].includes(platform) || !validWorkingDirectory(cwd, platform)) throw new Error("Invalid agent metadata.");
    if (this.list().length >= 32) throw new Error("Agent capacity reached.");
    const token = randomBytes(32).toString("hex");
    const machine: AgentMachine = { id: `agent-${randomBytes(8).toString("hex")}`, label, platform, cwd, tokenHash: digest(token), revoked: false, guildId: this.guildId, ownerId: this.ownerId };
    this.pairs.delete(hash); this.machines.push(machine); this.save();
    return { machine: machine.id, token, guildId: this.guildId, ownerId: this.ownerId };
  }
  authenticate(id: string, token: string): AgentMachine {
    const machine = this.machines.find(m => m.id === id && !m.revoked);
    if (!machine || !safeEqual(machine.tokenHash, digest(token))) throw new Error("Agent unauthorized.");
    return machine;
  }
  revoke(id: string): void {
    const machine = this.machines.find(m => m.id === id);
    if (!machine) throw new SessionError("Agent not found.");
    machine.revoked = true; this.save(); this.live.delete(id);
    for (const [key, request] of this.pending) if (request.job.machine === id) this.finish(key, undefined, "Agent revoked; in-flight outcome may be unknown.");
  }
  poll(machine: AgentMachine, snapshot: AgentSnapshot): AgentJob[] {
    if (!validSnapshot(snapshot, machine)) throw new Error("Invalid agent snapshot.");
    const prior = this.live.get(machine.id);
    if (prior && prior.snapshot.generation !== snapshot.generation) for (const [id, p] of this.pending) if (p.job.machine === machine.id) this.finish(id, undefined, "Agent reconnected; request not replayed.");
    this.live.set(machine.id, { snapshot, seen: Date.now() }); this.onSnapshot?.(machine, snapshot);
    const jobs: AgentJob[] = [];
    for (const p of this.pending.values()) if (p.job.machine === machine.id && !p.sent && p.job.deadline > Date.now()) { p.sent = true; jobs.push(p.job); }
    return jobs;
  }
  request<T>(machine: string, op: string, args: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    if (!this.online(machine)) return Promise.reject(new SessionError("Machine is offline; action was not dispatched."));
    if (this.pending.size >= 64) return Promise.reject(new SessionError("Agent request queue is full."));
    const job: AgentJob = { id: randomBytes(16).toString("hex"), machine, generation: this.live.get(machine)!.snapshot.generation, deadline: Date.now() + timeoutMs, op, args };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.finish(job.id, undefined, "Agent request timed out; outcome unknown. Do not replay input."), timeoutMs);
      this.pending.set(job.id, { job, sent: false, resolve: value => resolve(value as T), reject, timer });
    });
  }
  result(machine: AgentMachine, id: string, result: unknown, error?: string): void {
    const p = this.pending.get(id);
    if (!p || !p.sent || p.job.machine !== machine.id) throw new Error("Unknown or wrong-machine result.");
    this.finish(id, result, error);
  }
  private finish(id: string, result: unknown, error?: string) {
    const p = this.pending.get(id); if (!p) return; clearTimeout(p.timer); this.pending.delete(id);
    if (error) p.reject(new SessionError(error.slice(0, 300))); else p.resolve(result);
  }
  close() { for (const id of this.pending.keys()) this.finish(id, undefined, "Coordinator disconnected; no replay."); }
  async handle(req: IncomingMessage, res: ServerResponse) {
    try {
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += chunk.length; if (size > 6 * 1024 * 1024) throw new Error("Frame too large."); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let result: unknown;
      if (req.url === "/pair") result = this.enroll(String(body.code ?? ""), body.label, body.platform, body.cwd);
      else {
        const machine = this.authenticate(String(body.machine ?? ""), (req.headers.authorization ?? "").replace(/^Bearer /, ""));
        if (req.url === "/poll") result = this.poll(machine, body.snapshot);
        else if (req.url === "/result") { this.result(machine, body.id, body.result, typeof body.error === "string" ? body.error : undefined); result = true; }
        else throw new Error("Unknown route.");
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ result }));
    } catch { if (!res.headersSent) res.writeHead(403, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Agent request rejected." })); }
  }
  async listen(port: number, host = "127.0.0.1", tls?: { key: Buffer; cert: Buffer }) {
    if (!tls && host !== "127.0.0.1" && host !== "::1") throw new Error("Plaintext coordinator must listen on loopback only.");
    const handler = (req: IncomingMessage, res: ServerResponse) => { void this.handle(req, res); };
    const server = tls ? createSecureServer(tls, handler) : createServer(handler);
    server.requestTimeout = 10_000; server.headersTimeout = 5000; server.maxConnections = 64;
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(port, host, done); });
    server.on("close", () => this.close()); return server;
  }
}
