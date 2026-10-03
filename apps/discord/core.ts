import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);

export interface Config {
  token: string;
  ownerId: string;
  guildId: string;
  channelId?: string;
  allowedUserIds?: readonly string[];
}
const DISCORD_ID = /^\d{17,20}$/;
const MAX_TRUSTED_USERS = 32;

/** The enrollment owner stays authoritative; explicit trusted IDs share bot access. */
export function trustedDiscordUserIds(config: Pick<Config, "ownerId" | "allowedUserIds">): string[] {
  const users = [config.ownerId, ...(config.allowedUserIds ?? [])];
  if (!users.every(value => typeof value === "string" && DISCORD_ID.test(value))) throw new Error("Discord trusted users must be numeric IDs with 17–20 digits.");
  const unique = [...new Set(users)];
  if (users.length > MAX_TRUSTED_USERS + 1 || unique.length > MAX_TRUSTED_USERS) throw new Error("Configure at most 32 trusted Discord users including the owner.");
  return unique;
}

export function configFromEnv(env: NodeJS.ProcessEnv): Config {
  const token = env.DISCORD_BOT_TOKEN?.trim();
  if (!token || /^(your|replace|example)/i.test(token)) throw new Error("Set DISCORD_BOT_TOKEN in .env.discord");
  const id = (key: string, optional = false): string | undefined => {
    const value = env[key]?.trim();
    if (!value && optional) return undefined;
    if (!value || !DISCORD_ID.test(value)) throw new Error(`Set a numeric ${key} in .env.discord`);
    return value;
  };
  const ownerId = id("DISCORD_OWNER_ID")!;
  const allowedRaw = env.DISCORD_ALLOWED_USER_IDS?.trim();
  const allowedUserIds = allowedRaw ? allowedRaw.split(",").map(value => value.trim()) : [];
  if (allowedRaw && (allowedRaw.length > MAX_TRUSTED_USERS * 32 || allowedUserIds.length > MAX_TRUSTED_USERS
    || !allowedUserIds.every(value => DISCORD_ID.test(value)))) throw new Error("DISCORD_ALLOWED_USER_IDS must be a bounded comma-separated list of numeric IDs with 17–20 digits.");
  const trusted = trustedDiscordUserIds({ ownerId, allowedUserIds });
  return { token, ownerId, guildId: id("DISCORD_GUILD_ID")!, channelId: id("DISCORD_CHANNEL_ID", true),
    ...(allowedRaw ? { allowedUserIds: trusted.filter(value => value !== ownerId) } : {}) };
}

export function authorized(config: Config, userId: string, guildId: string | null, channelId: string | null): boolean {
  return authorizedGuild(config, userId, guildId) && (!config.channelId || channelId === config.channelId);
}

/** Trusted-user and guild check used by the category topology. Channel access is
 * resolved separately from the persisted orchestrator/category bindings. */
export function authorizedGuild(config: Config, userId: string, guildId: string | null): boolean {
  return guildId === config.guildId && trustedDiscordUserIds(config).includes(userId);
}

export function validateInput(text: string): void {
  if (!text || text.length > 500 || /[\x00-\x1f\x7f]/.test(text)) {
    throw new Error("Input must be one line, 1–500 characters, without control characters.");
  }
}

export function redact(text: string, secrets: string[] = []): string {
  let result = stripVTControlCharacters(text);
  for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
  return result
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:mfa\.[\w-]{20,}|[\w-]{23,28}\.[\w-]{6}\.[\w-]{27,})\b/g, "[REDACTED TOKEN]")
    .replace(/\b(authorization\s*:\s*(?:bearer|bot)\s+)\S+/gi, "$1[REDACTED]")
    .replace(/\b([\w-]*(?:token|secret|password|api[_-]?key)[\w-]*\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s]+)/gi, "$1[REDACTED]")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/`/g, "ˋ");
}

export function formatOutput(text: string, secrets: string[], session = "terminal"): string {
  const clean = redact(text, secrets).trimEnd();
  const tail = clean.length > 1650 ? "… (truncated)\n" + clean.slice(-1650) : clean;
  return `Terminal ${session} — captured output (not a verified progress summary):\n\`\`\`text\n` + (tail || "(empty)") + "\n```";
}

/** Claim before acting; a crash may lose an action but never replays one. */
export function claimInteraction(dir: string, id: string, created: number, now = Date.now()): boolean {
  if (!/^\d{17,20}$/.test(id) || created > now + 5000 || now - created > 60_000) return false;
  mkdirSync(join(dir, "seen"), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(dir, "seen", id), "claimed\n", { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export function audit(dir: string, event: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, "audit.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 });
}

export type TmuxRunner = (args: string[]) => Promise<string>;

export const TERMINAL_KEYS = ["enter", "ctrl-c", "escape", "tab", "up", "down", "left", "right", "shift-left"] as const;
export type TerminalKey = typeof TERMINAL_KEYS[number];

export interface TerminalControl {
  status(): Promise<string>;
  output(lines: number): Promise<string>;
  send(text: string, deadline?: number): Promise<void>;
  pressKey(key: TerminalKey): Promise<void>;
  interrupt(): Promise<void>;
}

export function tmuxKey(key: TerminalKey): string {
  return ({
    "enter": "Enter",
    "ctrl-c": "C-c",
    "escape": "Escape",
    "tab": "Tab",
    "up": "Up",
    "down": "Down",
    "left": "Left",
    "right": "Right",
    "shift-left": "S-Left",
  } as const)[key];
}

export const TMUX_SUBMIT_GAP_MS = 250;
export const TMUX_INPUT_VERSION = "paced-enter-v1";
const TMUX_STATUS_FORMAT = `session=#{session_name} pane=#{pane_id} pid=#{pane_pid} dead=#{pane_dead} exit=#{pane_dead_status} program=#{pane_current_command} inputProtocol=${TMUX_INPUT_VERSION}`;

function tmuxIdentity(status: string): string | undefined {
  return status.match(/^session=(\S+) pane=(%\d+) pid=([1-9]\d*) dead=0(?:\s|$)/)?.slice(1).join("\0");
}

/** Codex treats a burst of literal keys as a paste. Let that burst settle before
 * one Enter; successful transport still does not acknowledge the app's receipt. */
export async function submitTmuxInput(
  text: string,
  run: TmuxRunner,
  target: string,
  deadline: number,
  wait: (ms: number) => Promise<unknown> = delay,
  now: () => number = Date.now,
): Promise<void> {
  validateInput(text);
  const canStart = () => Number.isSafeInteger(deadline) && deadline - now() > TMUX_SUBMIT_GAP_MS;
  if (!canStart()) throw new Error("Request expires before submit; no input sent.");
  const readIdentity = async () => tmuxIdentity((await run(["display-message", "-p", "-t", target, TMUX_STATUS_FORMAT])).trim());
  const original = await readIdentity();
  if (!original) throw new Error("Terminal is unavailable or exited; no input sent.");
  if (!canStart()) throw new Error("Request expires before submit; no input sent.");
  await run(["send-keys", "-t", target, "-l", "--", text]);
  await wait(TMUX_SUBMIT_GAP_MS);
  const current = now() < deadline ? await readIdentity().catch(() => undefined) : undefined;
  if (now() >= deadline || current !== original) throw new Error("Text was delivered but Enter was not sent: terminal changed, exited or request expired. Inspect output; do not automatically retry.");
  await run(["send-keys", "-t", target, "Enter"]);
}

export class TmuxTerminal implements TerminalControl {
  protected target: string;
  constructor(
    protected readonly run: TmuxRunner,
    readonly pane: string,
    readonly label = "tmux",
    readonly machine = "local",
  ) {
    if (!/^%\d+$/.test(pane)) throw new Error("Invalid tmux pane ID");
    this.target = pane;
  }

  async status(): Promise<string> {
    return (await this.run(["display-message", "-p", "-t", this.target,
      TMUX_STATUS_FORMAT])).trim();
  }

  async output(lines: number): Promise<string> {
    if (!Number.isInteger(lines) || lines < 1 || lines > 100) throw new Error("Lines must be between 1 and 100");
    const result = await this.run(["capture-pane", "-p", "-J", "-t", this.target, "-S", "-100"]);
    return result.trimEnd().split("\n").slice(-lines).join("\n");
  }

  async send(text: string, deadline = Date.now() + 60_000): Promise<void> {
    await submitTmuxInput(text, this.run, this.target, deadline);
  }

  async pressKey(key: TerminalKey): Promise<void> {
    await this.run(["send-keys", "-t", this.target, tmuxKey(key)]);
  }

  async interrupt(): Promise<void> {
    await this.pressKey("ctrl-c");
  }
}

export type ManagedKind = "bash" | "codex";

export interface ManagedSessionRecord {
  id: string;
  label: string;
  machine: string;
  kind: ManagedKind;
  pane: string;
  tmuxSession: string;
  socket: string;
  cwd: string;
  createdAt: number;
}

export class ManagedTmuxTerminal extends TmuxTerminal {
  constructor(readonly record: ManagedSessionRecord, run: TmuxRunner) {
    super(run, record.pane, record.label, record.machine);
    // Pane numbers may be reused after a server restart. Scope the ID to the
    // unique original session so an old channel cannot hit a new session.
    this.target = `=${record.tmuxSession}:.${record.pane}`;
  }

  async stop(): Promise<void> {
    await this.run(["kill-session", "-t", `=${this.record.tmuxSession}`]);
  }
}

export async function createManagedTmux(
  run: TmuxRunner,
  kind: ManagedKind,
  cwd: string,
  machine = "local",
  socket = "discord-bridge",
  labelPrefix: string = kind,
): Promise<{ record: ManagedSessionRecord; terminal: ManagedTmuxTerminal }> {
  if (!/^\/[^\0\r\n]{0,499}$/.test(cwd)) throw new Error("Working directory must be an absolute path under 500 characters.");
  const suffix = randomBytes(5).toString("hex");
  const tmuxSession = `remote-operator-${kind}-${suffix}`;
  const command = kind === "codex" ? "codex" : "/bin/bash";
  const pane = (await run(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", tmuxSession,
    "-x", "140", "-y", "40", "-c", cwd, command])).trim();
  const record: ManagedSessionRecord = {
    id: `tmux-${suffix}`,
    label: `${labelPrefix} — ${tmuxSession}`,
    machine,
    kind,
    pane,
    tmuxSession,
    socket,
    cwd,
    createdAt: Date.now(),
  };
  return { record, terminal: new ManagedTmuxTerminal(record, run) };
}

/** Never pass bot credentials or the caller's full environment to tmux. */
export function terminalEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: env.HOME, USER: env.USER,
    LANG: "C.UTF-8", TERM: "xterm-256color" };
}

export function tmuxRunner(binary: string, socket: string): TmuxRunner {
  return async (args) => {
    const env = terminalEnvironment(process.env);
    if (binary.includes("/")) env.LD_LIBRARY_PATH = resolve(dirname(binary), "../lib/x86_64-linux-gnu");
    const { stdout } = await execFileAsync(binary, ["-L", socket, "-f", "/dev/null", ...args], {
      env, timeout: 5000, maxBuffer: 512 * 1024,
    });
    return stdout;
  };
}
