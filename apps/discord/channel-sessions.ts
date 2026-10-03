import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { SessionError } from "./errors.js";

const CHANNEL_ID = /^\d{17,20}$/;
const SESSION_ID = /^(?:demo|vsc-[a-f0-9]{16}-[a-f0-9]{8}|tmux-[a-f0-9]{10}|pty-[a-f0-9]{32})$/;
export interface ChannelTargetIdentity { machine: string; generation: string; provider: "vscode" | "vscode-agent" }

/** Persist the selected terminal by Discord channel, never by label or position. */
export class ChannelSessionStore {
  constructor(readonly file: string) {}

  get(channelId: string): string | undefined {
    this.validateChannel(channelId);
    return this.read().channels.get(channelId);
  }

  identity(channelId: string): ChannelTargetIdentity | undefined {
    this.validateChannel(channelId);
    return this.read().targets.get(channelId);
  }

  set(channelId: string, sessionId: string, identity?: ChannelTargetIdentity): void {
    this.validateChannel(channelId);
    this.validateSession(sessionId);
    if (identity && (!sessionId.startsWith("vsc-") || !validIdentity(identity))) throw new SessionError("Invalid external terminal identity.");
    const saved = this.read();
    saved.channels.set(channelId, sessionId);
    if (identity) saved.targets.set(channelId, identity); else saved.targets.delete(channelId);
    this.write(saved);
  }

  remove(channelId: string): void {
    this.validateChannel(channelId);
    const saved = this.read();
    saved.channels.delete(channelId); saved.targets.delete(channelId);
    this.write(saved);
  }

  private read(): { channels: Map<string, string>; targets: Map<string, ChannelTargetIdentity> } {
    if (!existsSync(this.file)) return { channels: new Map(), targets: new Map() };
    try {
      const doc = JSON.parse(readFileSync(this.file, "utf8"));
      if (!doc || doc.version !== 1 || !doc.channels || typeof doc.channels !== "object" || Array.isArray(doc.channels)) {
        throw new Error("Invalid document");
      }
      const channels = new Map<string, string>();
      for (const [channelId, sessionId] of Object.entries(doc.channels)) {
        this.validateChannel(channelId);
        if (typeof sessionId !== "string") throw new Error("Invalid session ID");
        this.validateSession(sessionId);
        channels.set(channelId, sessionId);
      }
      const targets = new Map<string, ChannelTargetIdentity>();
      if (doc.targets !== undefined) {
        if (!doc.targets || typeof doc.targets !== "object" || Array.isArray(doc.targets)) throw new Error("Invalid identities");
        for (const [channel, identity] of Object.entries(doc.targets)) {
          if (!channels.get(channel)?.startsWith("vsc-") || !validIdentity(identity)) throw new Error("Invalid identity");
          targets.set(channel, identity);
        }
      }
      return { channels, targets };
    } catch {
      throw new SessionError("Saved channel selections are invalid. Inspect .discord-bridge/channel-sessions.json.");
    }
  }

  private write(saved: { channels: Map<string, string>; targets: Map<string, ChannelTargetIdentity> }): void {
    const parent = dirname(this.file);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, channels: Object.fromEntries(saved.channels), targets: Object.fromEntries(saved.targets) }), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  private validateChannel(channelId: string): void {
    if (!CHANNEL_ID.test(channelId)) throw new SessionError("Channel selection requires a valid Discord channel ID.");
  }

  private validateSession(sessionId: string): void {
    if (!SESSION_ID.test(sessionId)) throw new SessionError("Invalid terminal session ID.");
  }
}

function validIdentity(value: unknown): value is ChannelTargetIdentity {
  if (!value || typeof value !== "object") return false;
  const target = value as ChannelTargetIdentity;
  return typeof target.machine === "string" && target.machine.length > 0 && target.machine.length <= 200
    && /^[a-f0-9]{32}$/.test(target.generation) && ["vscode", "vscode-agent"].includes(target.provider);
}
