import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { TerminalKey } from "./core.js";
import { SessionError } from "./errors.js";
import { windowsEnvironment } from "./platform.js";
import { ManagedTerminal, PtyRecord, SupervisorEndpoint, requirePtyKeyProtocol } from "./pty-protocol.js";

export class PtyClient {
  constructor(readonly endpoint: SupervisorEndpoint) {}
  async request<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${this.endpoint.port}/rpc`, {
      method: "POST", headers: { authorization: `Bearer ${this.endpoint.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...args, op, generation: this.endpoint.generation, actionId: randomBytes(16).toString("hex"), deadline: Date.now() + 15_000 }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json() as { error?: string; result: T };
    if (!response.ok) throw new SessionError(body.error ?? "Supervisor request failed; do not retry input automatically.");
    return body.result;
  }
  list(): Promise<PtyRecord[]> { return this.request("list"); }
  async create(cwd: string, machine: string, kind: "shell" | "codex", requestId: string): Promise<PtyTerminal> {
    return new PtyTerminal(await this.request<PtyRecord>("create", { cwd, machine, kind, requestId }), this);
  }
}

export class PtyTerminal implements ManagedTerminal {
  constructor(readonly record: PtyRecord, readonly client: PtyClient) {}
  status(): Promise<string> { return this.client.request("status", { id: this.record.id }); }
  output(lines: number): Promise<string> { return this.client.request("output", { id: this.record.id, lines }); }
  send(text: string): Promise<void> { return this.client.request("send", { id: this.record.id, text }); }
  async pressKey(key: TerminalKey): Promise<void> {
    requirePtyKeyProtocol(this.record, key);
    await this.client.request("key", { id: this.record.id, key });
  }
  interrupt(): Promise<void> { return this.pressKey("ctrl-c"); }
  stop(): Promise<void> { return this.client.request("stop", { id: this.record.id }); }
}

export function readPtyClient(state: string): PtyClient | undefined {
  const file = resolve(state, "pty-supervisor.json");
  if (!existsSync(file)) return;
  const endpoint = JSON.parse(readFileSync(file, "utf8")) as SupervisorEndpoint;
  if (endpoint.version !== 1 || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^[a-f0-9]{64}$/.test(endpoint.token) || !/^[a-f0-9]{32}$/.test(endpoint.generation) || !Number.isSafeInteger(endpoint.pid) || endpoint.pid < 1) throw new SessionError("Invalid supervisor endpoint.");
  return new PtyClient(endpoint);
}

export async function ensurePtySupervisor(state: string): Promise<PtyClient> {
  const current = readPtyClient(state);
  if (current) {
    try { await current.request("describe"); return current; }
    catch {
      try { process.kill(current.endpoint.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return start(); throw error; }
      throw new SessionError("Supervisor PID exists but cannot be authenticated; refusing to replace it.");
    }
  }
  return start();

  async function start(): Promise<PtyClient> {
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const log = openSync(resolve(state, "pty-supervisor.log"), "a");
    const entry = fileURLToPath(new URL("./pty-supervisor.js", import.meta.url));
    const child = spawn(process.execPath, [entry, state], { detached: true, windowsHide: true, stdio: ["ignore", log, log], env: windowsEnvironment(process.env) });
    closeSync(log);
    let spawnError: Error | undefined;
    child.on("error", error => { spawnError = error; });
    child.unref();
    for (let i = 0; i < 60; i++) {
      await delay(100);
      if (spawnError) throw new SessionError("Could not launch ConPTY supervisor.");
      try { const client = readPtyClient(state); if (client) { await client.request("describe"); return client; } } catch {}
    }
    throw new SessionError("ConPTY supervisor did not become ready. Inspect pty-supervisor.log.");
  }
}
