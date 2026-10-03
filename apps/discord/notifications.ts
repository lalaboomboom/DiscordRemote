import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexEventCursor, CodexEventRequest, CodexEventResult, validCodexEventCursor, validCodexEventResponse } from "./codex-events.js";
import { redact } from "./core.js";
import { SessionError } from "./errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^\d{17,20}$/;
const EXPIRY_MS = 120_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export interface NotificationTarget {
  guildId: string; channelId: string; machine: string; terminalId: string;
  provider: string; generation: string; cwd: string;
}
export interface NotificationBinding extends NotificationTarget {
  subscriptionId: string; threadId: string; lines: number; enabledAt: number;
  cursor: CodexEventCursor; state: "watching" | "paused"; reason?: string;
  claimedTurns: Array<{ turnId: string; at: number }>;
}
export interface NotificationMessage {
  content: string; allowedMentions: { parse: [] };
  files?: Array<{ attachment: Buffer; name: string }>;
}

function sameTarget(a: NotificationTarget, b: NotificationTarget): boolean {
  return ["guildId", "channelId", "machine", "terminalId", "provider", "generation", "cwd"]
    .every(key => a[key as keyof NotificationTarget] === b[key as keyof NotificationTarget]);
}
function validTarget(value: NotificationTarget): boolean {
  return ID.test(value.guildId) && ID.test(value.channelId)
    && typeof value.machine === "string" && value.machine.length > 0 && value.machine.length <= 100
    && typeof value.terminalId === "string" && /^(tmux-[a-f0-9]{10}|pty-[a-f0-9]{32}|vsc-[a-f0-9]{16}-[a-f0-9]{8})$/.test(value.terminalId)
    && ["tmux", "conpty", "vscode", "vscode-agent"].includes(value.provider)
    && /^[a-f0-9]{32}$/.test(value.generation) && typeof value.cwd === "string" && value.cwd.length > 0 && value.cwd.length <= 500;
}

/** Private state contains offsets and identities, never prompts or terminal output. */
export class NotificationStore {
  constructor(readonly file: string) {}
  list(): NotificationBinding[] {
    if (!existsSync(this.file)) return [];
    if (statSync(this.file).size > 2 * 1024 * 1024) throw new SessionError("Notification state exceeds its size limit.");
    const document = JSON.parse(readFileSync(this.file, "utf8")) as { version?: unknown; bindings?: unknown };
    if (document.version !== 1 || !Array.isArray(document.bindings) || document.bindings.length > 128) throw new SessionError("Invalid notification state.");
    for (const row of document.bindings as NotificationBinding[]) {
      if (!row || !validTarget(row) || !/^[a-f0-9]{32}$/.test(row.subscriptionId) || !UUID.test(row.threadId)
        || !Number.isInteger(row.lines) || row.lines < 50 || row.lines > 70 || !Number.isSafeInteger(row.enabledAt)
        || !validCodexEventCursor(row.cursor) || !["watching", "paused"].includes(row.state)
        || !Array.isArray(row.claimedTurns) || row.claimedTurns.length > 256
        || !row.claimedTurns.every(turn => turn && UUID.test(turn.turnId) && Number.isSafeInteger(turn.at))
        || (row.reason !== undefined && (typeof row.reason !== "string" || row.reason.length > 300))) throw new SessionError("Invalid notification binding.");
    }
    const rows = document.bindings as NotificationBinding[];
    if (new Set(rows.map(row => row.channelId)).size !== rows.length) throw new SessionError("Duplicate notification channel.");
    return rows;
  }
  get(channelId: string): NotificationBinding | undefined { return this.list().find(row => row.channelId === channelId); }
  set(row: NotificationBinding): void {
    const rows = this.list().filter(value => value.channelId !== row.channelId);
    if (rows.length >= 128) throw new SessionError("Notification channel limit reached.");
    rows.push(row); this.save(rows);
  }
  remove(channelId: string): void { this.save(this.list().filter(row => row.channelId !== channelId)); }
  private save(bindings: NotificationBinding[]): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = this.file + "." + randomBytes(8).toString("hex") + ".tmp";
    writeFileSync(temporary, JSON.stringify({ version: 1, bindings }, null, 2), { flag: "wx", mode: 0o600 });
    renameSync(temporary, this.file);
  }
}

export function completionMessage(output: string, lines: number, secrets: string[] = []): NotificationMessage {
  const clean = redact(output, secrets).trimEnd().split("\n").slice(-lines).join("\n");
  const bytes = Buffer.from(clean, "utf8");
  const truncated = bytes.length > MAX_OUTPUT_BYTES;
  const bounded = truncated ? bytes.subarray(bytes.length - MAX_OUTPUT_BYTES).toString("utf8").replace(/^\uFFFD+/, "") : clean;
  const label = `Codex hoàn tất lượt trả lời. ${lines} dòng terminal gần nhất tại thời điểm bot đọc; đây không phải xác nhận training đã xong.`;
  if (!bounded) return { content: label + "\nTerminal chưa có output để hiển thị.", allowedMentions: { parse: [] } };
  const content = label + "\n```text\n" + bounded + "\n```";
  if (!truncated && !bounded.includes("```") && content.length <= 1900) return { content, allowedMentions: { parse: [] } };
  return { content: label + (truncated ? "\nOutput vượt 64 KiB; file đã được giới hạn." : "\nOutput đầy đủ trong file đính kèm."),
    files: [{ attachment: Buffer.from(bounded, "utf8"), name: "terminal-output.txt" }], allowedMentions: { parse: [] } };
}

interface NotificationOptions {
  describe: (channelId: string) => Promise<NotificationTarget>;
  read: (target: NotificationTarget, request: CodexEventRequest) => Promise<CodexEventResult>;
  capture: (target: NotificationTarget, lines: number) => Promise<string>;
  send: (binding: NotificationBinding, message: NotificationMessage, stillCurrent: () => boolean) => Promise<unknown>;
  secrets?: string[]; now?: () => number; wait?: (ms: number) => Promise<unknown>;
}

/** Native completion triggers a single snapshot. No idle detection or input actions. */
export class CodexNotifications {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stopped = false;
  private connected = true;
  private connectionEpoch = 0;
  private intents = new Map<string, string>();
  private readonly now: () => number;
  constructor(readonly store: NotificationStore, readonly options: NotificationOptions) { this.now = options.now ?? Date.now; }

  async enable(channelId: string, threadId: string, lines = 60): Promise<NotificationBinding> {
    threadId = threadId.toLowerCase();
    if (!UUID.test(threadId)) throw new SessionError("Use the exact Codex Session/thread UUID. Read it with /send text:/status followed by /output; do not choose by folder.");
    if (!Number.isInteger(lines) || lines < 50 || lines > 70) throw new SessionError("Notification lines must be between 50 and 70.");
    const nonce = randomBytes(16).toString("hex"); this.intents.set(channelId, nonce);
    const target = await this.options.describe(channelId);
    if (!validTarget(target)) throw new SessionError("This channel has no supported live terminal identity.");
    const result = await this.read(target, { threadId, cwd: target.cwd });
    const fresh = await this.options.describe(channelId);
    if (this.intents.get(channelId) !== nonce || !sameTarget(target, fresh)) throw new SessionError("Notification target changed while enabling; no subscription installed.");
    const row: NotificationBinding = { ...target, subscriptionId: nonce, threadId, lines, enabledAt: this.now(),
      cursor: result.cursor, state: "watching", claimedTurns: [] };
    this.store.set(row); return row;
  }
  disable(channelId: string): void { this.intents.set(channelId, randomBytes(16).toString("hex")); this.store.remove(channelId); }
  isActive(row: NotificationBinding): boolean {
    const current = this.store.get(row.channelId);
    return !this.stopped && this.connected && current?.subscriptionId === row.subscriptionId && current.state === "watching";
  }
  pauseForInput(terminalId: string, input: string): void {
    if (!/^\/(resume|new|fork|clear|quit|exit|logout)(?:\s|$)/i.test(input)) return;
    for (const row of this.store.list().filter(row => row.terminalId === terminalId)) this.pause(row, "Codex may change thread. Read /status and enable /notify again with the current Session UUID.");
  }
  status(channelId: string): string {
    const row = this.store.get(channelId);
    if (!row) return "Notification: off. /notify on thread:<Codex Session UUID> lines:60 enables future native completions.";
    return `Notification: ${row.state}; thread ${row.threadId}; last ${row.lines} terminal lines.`
      + (!this.connected ? "\nDelivery is paused while Discord reconnects or the notification reader/state is unavailable. If it persists, repair the state and restart the coordinator; terminal input is unaffected." : "")
      + (row.reason ? `\n${row.reason}` : "");
  }
  async start(): Promise<void> {
    this.stopped = false; await this.resume();
    if (!this.timer && !this.stopped) {
      this.timer = setInterval(() => {
        void this.pollOnce().catch(() => {
          this.transportLost();
          console.error("Notification state/read failed; delivery paused. Inspect /notify status. No private contents logged.");
        });
      }, 5000);
      this.timer.unref();
    }
  }
  transportLost(): void { this.connectionEpoch++; this.connected = false; }
  async resume(): Promise<void> {
    const epoch = ++this.connectionEpoch;
    this.connected = false;
    // Restart/reconnect subscribes at EOF again, never replays the disconnected interval.
    for (const row of this.store.list().filter(row => row.state === "watching")) {
      try {
        const fresh = await this.options.describe(row.channelId);
        if (epoch !== this.connectionEpoch || this.stopped) return;
        if (!sameTarget(row, fresh)) throw new SessionError("Terminal identity changed; enable /notify again explicitly.");
        const result = await this.read(row, { threadId: row.threadId, cwd: row.cwd });
        if (epoch !== this.connectionEpoch || this.stopped) return;
        const current = this.store.get(row.channelId);
        if (current?.subscriptionId === row.subscriptionId && current.state === "watching") this.store.set({ ...current, cursor: result.cursor, enabledAt: this.now() });
      } catch (error) { if (epoch === this.connectionEpoch && !this.stopped) this.pause(row, error instanceof SessionError ? error.message : "Native event reader is unavailable; inspect the machine and enable /notify again."); }
    }
    if (!this.stopped && epoch === this.connectionEpoch) this.connected = true;
  }
  close(): void { this.connectionEpoch++; this.stopped = true; this.connected = false; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private async read(target: NotificationTarget, request: CodexEventRequest): Promise<CodexEventResult> {
    const result = await this.options.read(target, request);
    if (!validCodexEventResponse(result) || result.threadId !== request.threadId || result.cwd !== request.cwd) throw new SessionError("Native event reader returned a different or invalid thread identity.");
    return result;
  }
  private pause(row: NotificationBinding, reason: string): void {
    const current = this.store.get(row.channelId);
    if (current?.subscriptionId !== row.subscriptionId) return;
    this.store.set({ ...current, state: "paused", reason: redact(reason, this.options.secrets).slice(0, 300) });
  }
  async pollOnce(): Promise<void> {
    if (this.busy || this.stopped || !this.connected) return;
    const epoch = this.connectionEpoch;
    const activeEpoch = () => epoch === this.connectionEpoch && !this.stopped && this.connected;
    this.busy = true;
    try {
      for (const row of this.store.list().filter(row => row.state === "watching")) {
        if (!activeEpoch() || !this.isActive(row)) continue;
        try {
          const fresh = await this.options.describe(row.channelId);
          if (!activeEpoch() || !this.isActive(row)) continue;
          if (!sameTarget(row, fresh)) throw new SessionError("Terminal identity changed; enable /notify again explicitly.");
          const result = await this.read(row, { threadId: row.threadId, cwd: row.cwd, cursor: row.cursor });
          const current = this.store.get(row.channelId);
          if (!activeEpoch() || !current || current.subscriptionId !== row.subscriptionId || !this.isActive(row)) continue;
          // Persist the cursor before any outbound operation. Ambiguous Discord sends are never retried.
          this.store.set({ ...current, cursor: result.cursor });
          for (const event of result.events) {
            const active = this.store.get(row.channelId);
            if (!activeEpoch() || !active || !this.isActive(row) || !UUID.test(event.turnId) || !Number.isSafeInteger(event.completedAt)
              || event.completedAt < active.enabledAt || event.completedAt > this.now() + 5000 || this.now() - event.completedAt > EXPIRY_MS
              || active.claimedTurns.some(turn => turn.turnId === event.turnId)) continue;
            this.store.set({ ...active, claimedTurns: [...active.claimedTurns, { turnId: event.turnId, at: this.now() }].slice(-256) });
            await (this.options.wait ?? delay)(250); // Let the TUI render its final event.
            if (!activeEpoch() || !this.isActive(row)) continue;
            const beforeCapture = await this.options.describe(row.channelId);
            if (!activeEpoch() || !this.isActive(row) || !sameTarget(row, beforeCapture)) continue;
            const output = await this.options.capture(row, row.lines);
            if (!activeEpoch() || !this.isActive(row) || this.now() - event.completedAt > EXPIRY_MS) continue;
            const beforeSend = await this.options.describe(row.channelId);
            if (!activeEpoch() || !this.isActive(row) || !sameTarget(row, beforeSend)) continue;
            await this.options.send(row, completionMessage(output, row.lines, this.options.secrets), () => activeEpoch() && this.isActive(row));
          }
        } catch (error) { if (activeEpoch()) this.pause(row, error instanceof SessionError ? error.message : "Notification could not be delivered. It will not be retried; inspect /output, then enable /notify again."); }
      }
    } finally { this.busy = false; }
  }
}
