import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
import { terminalEnvironment, tmuxRunner, TmuxRunner, validateInput } from "./core.js";
import { SessionError } from "./errors.js";
import { runPasswordSsh } from "./ssh-password.js";
import { HostPlatform, localPlatform, requireWorkingDirectory, windowsEnvironment, windowsShell } from "./platform.js";
import { CodexEventRequest, CodexEventResponse, readCodexEvents, validCodexEventRequest, validCodexEventResponse } from "./codex-events.js";
import { CODEX_EVENTS_SSH_COMMAND } from "./codex-events-ssh.js";

export interface HostTarget {
  id: string;
  label: string;
  kind: "local" | "ssh" | "agent";
  platform?: HostPlatform;
  cwd: string;
  host?: string;
  user?: string;
  port?: number;
  password?: string;
  hostKeySha256?: string;
}

interface HostRegistryEntry {
  id?: unknown;
  label?: unknown;
  kind?: unknown;
  platform?: unknown;
  cwd?: unknown;
  host?: unknown;
  user?: unknown;
  port?: unknown;
  passwordEnv?: unknown;
  hostKeySha256?: unknown;
}

export interface HostResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
}

const HOST_PART = /^[A-Za-z0-9_.-]+$/;
const USER_PART = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function firstValue(...values: (string | undefined)[]): string | undefined {
  return values.map(value => value?.trim()).find(Boolean);
}

function splitHost(value: string): { host: string; user?: string } {
  const at = value.lastIndexOf("@");
  if (at < 1) return { host: value };
  return { user: value.slice(0, at), host: value.slice(at + 1) };
}

function validateTarget(target: HostTarget): HostTarget {
  if (target.hostKeySha256 !== undefined && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(target.hostKeySha256)) throw new SessionError("Invalid pinned SSH host fingerprint.");
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(target.id) || !target.label || target.label.length > 160) throw new SessionError("Invalid host target configuration.");
  requireWorkingDirectory(target.cwd, hostPlatform(target));
  if (target.kind === "local") return target;
  if (!target.host || !HOST_PART.test(target.host) || target.host.startsWith("-")) throw new SessionError("SSH host must be a plain hostname, alias or IP address.");
  if (!target.user || !USER_PART.test(target.user) || !target.port || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new SessionError("SSH user or port is invalid.");
  return target;
}

function registryFile(root: string, values: Record<string, string>): string {
  const configured = values.REMOTE_OPERATOR_HOSTS_FILE?.trim();
  return configured ? resolve(root, configured) : resolve(root, ".remote-operator/hosts.json");
}

function loadRegistryTargets(root: string, values: Record<string, string>): HostTarget[] | undefined {
  const file = registryFile(root, values);
  if (!existsSync(file)) return undefined;
  let document: unknown;
  try { document = JSON.parse(readFileSync(file, "utf8")); } catch { throw new SessionError("Could not parse the remote operator host registry."); }
  if (!document || typeof document !== "object" || !Array.isArray((document as { hosts?: unknown }).hosts)) {
    throw new SessionError("Host registry must contain a hosts array.");
  }
  const records = (document as { hosts: unknown[] }).hosts;
  if (records.length < 1 || records.length > 32) throw new SessionError("Host registry must contain 1–32 hosts.");
  const targets: HostTarget[] = [];
  for (const value of records) {
    if (!value || typeof value !== "object") throw new SessionError("Host registry contains an invalid entry.");
    const entry = value as HostRegistryEntry;
    const id = typeof entry.id === "string" ? entry.id : "";
    const label = typeof entry.label === "string" ? entry.label : id;
    const kind = entry.kind === "local" || entry.kind === "ssh" ? entry.kind : undefined;
    if (entry.platform !== undefined && entry.platform !== "win32" && entry.platform !== "linux") throw new SessionError("Host platform must be win32 or linux.");
    const platform = entry.platform as HostPlatform | undefined;
    if (kind === "local" && platform !== undefined && platform !== localPlatform()) throw new SessionError("Local host platform does not match this machine.");
    if (kind === "ssh" && platform === "win32") throw new SessionError("Remote Windows requires a paired agent; SSH profiles currently support Linux only.");
    const cwd = typeof entry.cwd === "string" ? entry.cwd : kind === "local" ? root : "/";
    if (!kind || !id || !label) throw new SessionError("Each host registry entry needs id, label and kind.");
    if (kind === "local") {
      targets.push(validateTarget({ id, label, kind, cwd, ...(platform ? { platform } : {}) }));
      continue;
    }
    const host = typeof entry.host === "string" ? entry.host : "";
    const user = typeof entry.user === "string" ? entry.user : "";
    const port = typeof entry.port === "number" ? entry.port : Number(entry.port ?? 22);
    const passwordEnv = typeof entry.passwordEnv === "string" ? entry.passwordEnv.trim() : "";
    const password = passwordEnv ? values[passwordEnv] : undefined;
    if ("password" in entry) throw new SessionError(`Host registry entry ${id} must reference passwordEnv; do not store a password in the registry file.`);
    const hostKeySha256 = typeof entry.hostKeySha256 === "string" ? entry.hostKeySha256 : undefined;
    targets.push(validateTarget({ id, label, kind, cwd, host, user, port, password, hostKeySha256, ...(platform ? { platform } : {}) }));
  }
  const ids = new Set<string>();
  for (const target of targets) {
    if (ids.has(target.id)) throw new SessionError(`Host registry contains duplicate ID ${target.id}.`);
    ids.add(target.id);
  }
  if (!targets.some(target => target.kind === "local" && target.id === "local")) {
    targets.unshift({ id: "local", label: "local", kind: "local", cwd: root });
  }
  return targets;
}

/** Load host targets without exposing passwords in returned labels or errors. */
export function loadHostTargets(root: string, env: NodeJS.ProcessEnv = process.env): HostTarget[] {
  const values: Record<string, string> = {};
  const file = resolve(root, ".env.ssh");
  if (existsSync(file)) {
    try { Object.assign(values, parseEnv(readFileSync(file, "utf8"))); } catch { throw new SessionError("Could not parse .env.ssh."); }
  }
  for (const [key, value] of Object.entries(env)) if (value !== undefined) values[key] = value;
  const registryTargets = loadRegistryTargets(root, values);
  if (registryTargets) return registryTargets;
  const local: HostTarget = { id: "local", label: "local", kind: "local", cwd: root };
  const rawHost = firstValue(values.REMOTE_OPERATOR_SSH_HOST, values.SSH_HOST, values.host);
  if (!rawHost) return [local];
  const split = splitHost(rawHost);
  const user = firstValue(values.REMOTE_OPERATOR_SSH_USER, values.SSH_USER, values.user, split.user);
  const host = split.host;
  const portValue = firstValue(values.REMOTE_OPERATOR_SSH_PORT, values.SSH_PORT, values.port) ?? "22";
  const port = Number(portValue);
  const id = firstValue(values.REMOTE_OPERATOR_SSH_ID, values.SSH_ALIAS, values.SSH_NAME, values.name) ?? "remote";
  const label = firstValue(values.REMOTE_OPERATOR_SSH_LABEL, values.SSH_LABEL, values.label) ?? id;
  const cwd = firstValue(values.REMOTE_OPERATOR_SSH_CWD, values.SSH_CWD, values.cwd) ?? "/";
  const password = firstValue(values.REMOTE_OPERATOR_SSH_PASSWORD, values.SSH_PASSWORD, values.password);
  const hostKeySha256 = firstValue(values.REMOTE_OPERATOR_SSH_HOST_KEY_SHA256, values.SSH_HOST_KEY_SHA256);
  return [local, validateTarget({ id, label, kind: "ssh", cwd, host, user, port, password, hostKeySha256 })];
}

export function hostForMachine(targets: HostTarget[], machine?: string): HostTarget {
  if (!machine || machine === "local") return targets.find(target => target.id === "local")!;
  const exact = targets.find(target => target.id === machine);
  if (exact) return exact;
  const aliases = targets.filter(target => target.label === machine || target.host === machine);
  if (aliases.length === 1) return aliases[0];
  throw new SessionError(`No configured host matches machine ${machine}. Bind the machine before using host controls.`);
}

export function hostPlatform(target: HostTarget): HostPlatform {
  return target.platform ?? (target.kind === "local" ? localPlatform() : "linux");
}

export function hostTargetConnection(target: HostTarget): string {
  if (target.kind === "agent") return `${target.label} · agent · ${target.platform} · ${target.cwd}`;
  if (target.kind === "local") return `${target.label} · local · ${target.cwd}`;
  return `${target.label} · SSH ${target.user}@${target.host}:${target.port} · ${target.cwd}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Refuse symlinks/junctions at every generated attachment component. */
function safeLocalAttachment(cwd: string, relativePath: string): string {
  const base = realpathSync(cwd);
  let current = base;
  for (const part of relativePath.split("/")) {
    current = resolve(current, part);
    if (!current.startsWith(base.endsWith(sep) ? base : base + sep)) throw new SessionError("Attachment path escaped the working directory.");
    try { if (lstatSync(current).isSymbolicLink()) throw new SessionError("Attachment path contains a symlink or junction."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return current;
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; input?: string | Buffer; secretInput?: string },
): Promise<HostResult> {
  return new Promise(resolveResult => {
    const started = Date.now();
    const child = spawn(command, args, {
      windowsHide: true,
      detached: process.platform !== "win32",
      cwd: options.cwd,
      env: options.env,
      stdio: options.secretInput === undefined ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let timeoutFallback: NodeJS.Timeout | undefined;
    const collect = (buffer: Buffer[], chunk: Buffer) => {
      if (size >= 512 * 1024) return;
      const remaining = 512 * 1024 - size;
      const part = chunk.subarray(0, remaining);
      buffer.push(part);
      size += part.length;
    };
    child.stdout.on("data", chunk => collect(stdout, chunk));
    child.stderr.on("data", chunk => collect(stderr, chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutFallback = setTimeout(() => {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
        resolveResult({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") + "\nDiagnostic timed out; descendant termination could not be confirmed.", code: child.exitCode, signal: child.signalCode, timedOut: true, durationMs: Date.now() - started });
      }, 2000);
      if (!child.pid || child.exitCode !== null) return;
      if (process.platform === "win32") {
        // Only the subprocess tree created for this bounded diagnostic.
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => { child.kill(); });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    }, options.timeoutMs);
    child.on("error", error => {
      clearTimeout(timer);
      clearTimeout(timeoutFallback);
      resolveResult({ stdout: "", stderr: error.message, code: null, signal: null, timedOut, durationMs: Date.now() - started });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(timeoutFallback);
      resolveResult({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), code, signal, timedOut, durationMs: Date.now() - started });
    });
    if (options.secretInput !== undefined) {
      const secret = child.stdio[3];
      if (secret && "write" in secret) {
        secret.write(options.secretInput);
        secret.end();
      }
    }
    child.stdin.on("error", () => {}); // Process exit/early stdin close is reported via its result.
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

export class HostExecutor {
  constructor(readonly target: HostTarget, private readonly root: string) {}

  private async execute(command: string, timeoutMs: number, cwdOverride?: string, input?: string | Buffer, totalBudget = false): Promise<HostResult> {
    if (this.target.kind === "agent") throw new SessionError("Agent operations require the authenticated agent transport.");
    const cwd = cwdOverride ?? this.target.cwd;
    requireWorkingDirectory(cwd, hostPlatform(this.target));
    if (this.target.kind === "local") {
      if (hostPlatform(this.target) === "win32") {
        const utf8Command = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ${command}`;
        return runProcess(windowsShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", utf8Command], {
          cwd, env: windowsEnvironment(process.env), timeoutMs, input,
        });
      }
      return runProcess("/bin/sh", ["-lc", command], {
        cwd,
        env: terminalEnvironment(process.env),
        timeoutMs,
        input,
      });
    }
    const remoteCommand = `cd -- ${shellQuote(cwd)} && ${command}`;
    const sshArgs = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "NumberOfPasswordPrompts=1", "-p", String(this.target.port), `${this.target.user}@${this.target.host}`, remoteCommand];
    const password = this.target.password;
    if (password) return runPasswordSsh(this.target, remoteCommand, timeoutMs, input, "openssh", totalBudget ? Date.now() + timeoutMs : undefined);
    return runProcess("ssh", sshArgs, {
      env: process.platform === "win32" ? windowsEnvironment(process.env) : terminalEnvironment(process.env),
      timeoutMs: timeoutMs + (totalBudget ? 0 : 10_000),
      input,
    });
  }

  async run(command: string, timeoutMs = 15_000, cwdOverride?: string): Promise<HostResult> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60_000) throw new SessionError("Host command timeout must be 500–60000 ms.");
    if (!command || command.length > 500 || /[\x00-\x1f\x7f]/.test(command)) throw new SessionError("Host command must be one line, 1–500 characters, without control characters.");
    return this.execute(command, timeoutMs, cwdOverride);
  }

  /** Read only the exact CLI thread's native completion metadata. This is
   * independent of shell input and never reads or returns prompt contents. */
  async readCodexEvents(request: CodexEventRequest): Promise<CodexEventResponse> {
    if (!validCodexEventRequest(request)) throw new SessionError("Invalid Codex event request.");
    requireWorkingDirectory(request.cwd, hostPlatform(this.target));
    if (this.target.kind === "local") return readCodexEvents(request, { platform: hostPlatform(this.target) });
    if (this.target.kind !== "ssh") throw new SessionError("Agent events require the authenticated agent transport.");
    // Fixed cwd and program; both requested cwd and cursor travel as JSON stdin.
    const result = await this.execute(CODEX_EVENTS_SSH_COMMAND, 15_000, "/", JSON.stringify(request), true);
    if (result.timedOut || result.code !== 0) throw new SessionError(result.timedOut ? "Codex event read timed out." : "Codex event metadata unavailable or unsafe.");
    let response: unknown;
    try { response = JSON.parse(result.stdout); } catch { throw new SessionError("Invalid Codex event response."); }
    if (!validCodexEventResponse(response) || response.threadId !== request.threadId || response.cwd !== request.cwd) throw new SessionError("Invalid Codex event response.");
    return response;
  }

  /** Internal provider operation for quoted tmux argv; never exposed as /run. */
  async runInternal(command: string, timeoutMs = 15_000): Promise<HostResult> {
    if (!command || command.length > 10_000 || /[\x00\r\n]/.test(command)) throw new SessionError("Internal host command is invalid.");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60_000) throw new SessionError("Host command timeout must be 500–60000 ms.");
    return this.execute(command, timeoutMs);
  }

  /** Write a generated attachment below cwd without exposing an arbitrary
   * path or shell command to the remote host. The SSH path intentionally uses
   * stdin so attachment bytes never appear in command-line arguments. */
  async writeFile(relativePath: string, data: Buffer, cwdOverride?: string): Promise<void> {
    if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\")
      || relativePath.split("/").some(part => !part || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part))) {
      throw new SessionError("Attachment path is invalid.");
    }
    if (!Buffer.isBuffer(data) || data.length > 4 * 1024 * 1024) throw new SessionError("Attachment is too large.");
    const cwd = cwdOverride ?? this.target.cwd;
    requireWorkingDirectory(cwd, hostPlatform(this.target));
    if (this.target.kind === "local") {
      const base = resolve(cwd);
      const destination = safeLocalAttachment(base, relativePath);
      if (destination !== base && !destination.startsWith(base + sep)) throw new SessionError("Attachment path escaped the terminal working directory.");
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, data, { mode: 0o600 });
      return;
    }
    const directory = dirname(relativePath);
    const command = `umask 077 && mkdir -p -- ${shellQuote(directory)} && cat > ${shellQuote(relativePath)}`;
    const result = await this.execute(command, 60_000, cwd, data);
    if (result.code !== 0 || result.timedOut) throw new SessionError(result.timedOut ? "Remote attachment upload timed out." : "Remote attachment upload failed.");
  }

  async removeFile(relativePath: string, cwdOverride?: string): Promise<void> {
    if (!relativePath || relativePath.startsWith("/") || relativePath.includes("\\")
      || relativePath.split("/").some(part => !part || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part))) {
      throw new SessionError("Attachment path is invalid.");
    }
    const cwd = cwdOverride ?? this.target.cwd;
    requireWorkingDirectory(cwd, hostPlatform(this.target));
    if (this.target.kind === "local") {
      const base = resolve(cwd);
      const destination = safeLocalAttachment(base, relativePath);
      if (destination !== base && !destination.startsWith(base + sep)) throw new SessionError("Attachment path escaped the terminal working directory.");
      try { unlinkSync(destination); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return;
    }
    const result = await this.execute(`rm -f -- ${shellQuote(relativePath)}`, 30_000, cwd);
    if (result.code !== 0 || result.timedOut) throw new SessionError("Remote attachment cleanup failed.");
  }

  async cleanupAttachmentInbox(maxAgeMs: number, cwdOverride?: string): Promise<void> {
    if (!Number.isInteger(maxAgeMs) || maxAgeMs < 60_000) throw new SessionError("Attachment cleanup age is invalid.");
    const cwd = cwdOverride ?? this.target.cwd;
    requireWorkingDirectory(cwd, hostPlatform(this.target));
    if (this.target.kind === "local") {
      const inbox = safeLocalAttachment(cwd, ".discord-bridge/inbox");
      let names: string[];
      try { names = readdirSync(inbox); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const cutoff = Date.now() - maxAgeMs;
      for (const name of names) {
        if (!/^[0-9A-Za-z_-]+-[0-9]+-[A-Za-z0-9._-]+$/.test(name)) continue;
        const path = safeLocalAttachment(cwd, `.discord-bridge/inbox/${name}`);
        try {
          if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return;
    }
    const minutes = Math.max(1, Math.ceil(maxAgeMs / 60_000));
    const result = await this.execute(`if [ -d .discord-bridge/inbox ]; then find .discord-bridge/inbox -maxdepth 1 -type f -mmin +${minutes} -delete; fi`, 30_000, cwd);
    if (result.code !== 0 || result.timedOut) throw new SessionError("Remote attachment cleanup failed.");
  }
}

export function hostTmuxRunner(executor: HostExecutor, target: HostTarget, socket: string): TmuxRunner {
  if (target.kind === "local") return tmuxRunner(process.env.TMUX_BIN || "tmux", socket);
  return async args => {
    const command = ["tmux", "-L", socket, "-f", "/dev/null", ...args].map(shellQuote).join(" ");
    const result = await executor.runInternal(command);
    if (result.code !== 0 || result.timedOut) throw new SessionError(result.timedOut ? "Remote tmux command timed out." : "Remote tmux command failed.");
    return result.stdout;
  };
}

export function formatHostResult(result: HostResult): string {
  const status = result.timedOut ? "timeout" : result.code === 0 ? "exit=0" : `exit=${result.code ?? "unknown"}`;
  return `host ${status} (${result.durationMs}ms)\nstdout:\n${result.stdout || "(empty)"}\nstderr:\n${result.stderr || "(empty)"}`;
}
