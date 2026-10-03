import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { SessionError } from "./errors.js";
import { TerminalControl, TerminalKey, validateInput } from "./core.js";
import { HostPlatform, localPlatform, validWorkingDirectory } from "./platform.js";

export type VscodeCwdSource = "shellIntegration" | "creationOptions" | "workspace";

export interface VscodeSession {
  id: string;
  label: string;
  machine: string;
  cwd?: string | null;
  instance: string;
  pid: number | null;
  alive: boolean;
  shared: boolean;
  generation: string;
  /** UI host OS. Remote-SSH/WSL cwd may belong to a different target OS. */
  platform: HostPlatform;
  remote: boolean;
  cwdSource?: VscodeCwdSource;
  inputProtocol?: "paced-submit-v1";
  providerVersion?: string;
}
const INSTANCE = /^[a-f0-9]{16}$/;
const SESSION = /^vsc-[a-f0-9]{16}-[a-f0-9]{8}$/;

/** Compare valid SemVer precedence with the first modified-key provider. */
function supportsShiftLeft(version: string | undefined): boolean {
  if (typeof version !== "string") return false;
  const parsed = version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/);
  if (!parsed || parsed[4]?.split(".").some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return false;
  const parts = parsed.slice(1, 4).map(Number), minimum = [0, 1, 7];
  if (!parts.every(Number.isSafeInteger)) return false;
  for (let index = 0; index < minimum.length; index++) {
    if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
  }
  return parsed[4] === undefined;
}

export function requireShiftLeftProvider(version: string | undefined): void {
  if (!supportsShiftLeft(version)) {
    throw new SessionError("Shift + Left requires Remote Operator Terminal 0.1.7 or newer. Safely update the extension host, then share this tab again.");
  }
}

export function vscodeInventory(stateDir: string, now = Date.now()): VscodeSession[] {
  const dir = join(stateDir, "vscode");
  if (!existsSync(dir)) return [];
  const results: VscodeSession[] = [];
  for (const file of readdirSync(dir)) {
    if (!/^instance-[a-f0-9]{16}\.json$/.test(file)) continue;
    try {
      const doc = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (!INSTANCE.test(doc.instance) || !Number.isFinite(doc.updatedAt)
        || now - doc.updatedAt > 15_000 || doc.updatedAt > now + 5000 || !Array.isArray(doc.sessions)) continue;
      for (const session of doc.sessions) {
        const platform = session.platform ?? doc.platform ?? localPlatform();
        const remote = session.remote ?? doc.remote ?? false;
        const generation = session.generation ?? createHash("sha256").update(String(session.id)).digest("hex").slice(0, 32);
        if (!SESSION.test(session.id) || !session.id.startsWith(`vsc-${doc.instance}-`)
          || typeof session.label !== "string" || session.label.length > 100
          || typeof session.machine !== "string" || session.machine.length > 200
          || (platform !== "linux" && platform !== "win32") || typeof remote !== "boolean"
          || (doc.remote !== undefined && remote !== doc.remote)
          || typeof generation !== "string" || !/^[a-f0-9]{32}$/.test(generation)
          || (doc.inputProtocol === "paced-submit-v1" && typeof session.generation !== "string")
          || (session.cwd !== undefined && session.cwd !== null && !validWorkingDirectory(session.cwd, remote ? undefined : platform))
          || (session.cwdSource !== undefined && !["shellIntegration", "creationOptions", "workspace"].includes(session.cwdSource))
          || typeof session.alive !== "boolean"
          || (session.shared !== undefined && typeof session.shared !== "boolean")) continue;
        if (doc.inputProtocol === "paced-submit-v1" && typeof session.shared !== "boolean") continue;
        // Before discovery was added, metadata contained shared sessions only.
        // Treat that older format as shared, while requiring new records to say so.
        results.push({
          id: session.id,
          label: session.label,
          machine: session.machine,
          cwd: session.cwd ?? null,
          instance: doc.instance,
          pid: Number.isSafeInteger(session.pid) && session.pid > 0 ? session.pid : null,
          alive: session.alive,
          shared: session.shared ?? true,
          generation,
          platform,
          remote,
          ...(session.cwdSource ? { cwdSource: session.cwdSource } : {}),
          ...(doc.inputProtocol === "paced-submit-v1" ? { inputProtocol: "paced-submit-v1" as const } : {}),
          ...(typeof doc.providerVersion === "string" && doc.providerVersion.length <= 40 ? { providerVersion: doc.providerVersion } : {}),
        });
      }
    } catch { /* Invalid or interrupted provider metadata never authorizes input. */ }
  }
  return results;
}

export function vscodeSessions(stateDir: string, now = Date.now()): VscodeSession[] {
  return vscodeInventory(stateDir, now).filter(session => session.shared);
}

export class VscodeTerminal implements TerminalControl {
  constructor(readonly dir: string, readonly id: string, readonly expectedGeneration?: string, readonly deadline?: number) {}

  private async request(action: "status" | "output" | "send" | "submit" | "key" | "interrupt", text?: string, key?: TerminalKey): Promise<string> {
    const session = vscodeSessions(this.dir).find(s => s.id === this.id);
    if (!session?.alive || !session.shared) throw new SessionError("VS Code terminal is closed, not shared or disconnected. Share it locally before controlling it.");
    if (action === "key" && key === "shift-left") requireShiftLeftProvider(session.providerVersion);
    if (["send", "submit", "key", "interrupt"].includes(action) && session.inputProtocol !== "paced-submit-v1") throw new SessionError("VS Code input requires Remote Operator Terminal 0.1.6. Upgrade and safely restart the extension host, then share this tab again.");
    if (this.expectedGeneration !== undefined && session.generation !== this.expectedGeneration) throw new SessionError("VS Code terminal generation changed; request was not sent.");
    if (this.deadline !== undefined && (!Number.isSafeInteger(this.deadline) || this.deadline <= Date.now())) throw new SessionError("VS Code request expired; input was not sent.");
    if (text !== undefined) validateInput(text);
    const ipc = join(this.dir, "vscode");
    mkdirSync(ipc, { recursive: true, mode: 0o700 });
    const requestId = randomBytes(16).toString("hex");
    const base = join(ipc, `${session.instance}-${requestId}`);
    const pending = base + ".request.json";
    const result = base + ".response.json";
    const temp = base + ".tmp";
    const expiresAt = Math.min(Date.now() + 10_000, this.deadline ?? Infinity);
    writeFileSync(temp, JSON.stringify({ requestId, instance: session.instance, sessionId: session.id, generation: session.generation, action, text, key, expiresAt }), { flag: "wx", mode: 0o600 });
    renameSync(temp, pending);
    try {
      while (Date.now() < expiresAt) {
        if (existsSync(result)) {
          const reply = JSON.parse(readFileSync(result, "utf8"));
          const wrongGeneration = session.inputProtocol === "paced-submit-v1" ? reply.generation !== session.generation : reply.generation !== undefined && reply.generation !== session.generation;
          if (reply.requestId !== requestId || reply.sessionId !== session.id || wrongGeneration || !reply.ok || typeof reply.output !== "string") {
            throw new SessionError("VS Code could not complete the request. Inspect the terminal before retrying.");
          }
          const current = vscodeSessions(this.dir).find(candidate => candidate.id === this.id);
          if (!current?.shared || !current.alive || current.generation !== session.generation) throw new SessionError("VS Code terminal closed, unshared or changed while the request was pending.");
          return reply.output;
        }
        await setTimeout(Math.min(100, Math.max(1, expiresAt - Date.now())));
      }
      throw new SessionError("VS Code request timed out and will not be replayed. Check output before retrying input.");
    } finally {
      for (const path of [pending, result]) { try { unlinkSync(path); } catch {} }
    }
  }

  status(): Promise<string> { return this.request("status"); }
  async output(lines: number): Promise<string> {
    if (!Number.isInteger(lines) || lines < 1 || lines > 100) throw new SessionError("Lines must be 1–100.");
    return (await this.request("output")).trimEnd().split("\n").slice(-lines).join("\n");
  }
  async send(text: string): Promise<void> {
    // One provider request prevents another request from interleaving between
    // literal text and the paced submit key. No failed request is replayed.
    await this.request("submit", text);
  }
  async pressKey(key: TerminalKey): Promise<void> { await this.request("key", undefined, key); }
  async interrupt(): Promise<void> { await this.pressKey("ctrl-c"); }
}
