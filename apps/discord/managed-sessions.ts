import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { ManagedKind, ManagedSessionRecord } from "./core.js";
import { SessionError } from "./errors.js";

export const MANAGED_SESSION_ID = /^tmux-[a-f0-9]{10}$/;

function validRecord(value: unknown): value is ManagedSessionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ManagedSessionRecord>;
  return typeof record.id === "string" && MANAGED_SESSION_ID.test(record.id)
    && typeof record.label === "string" && record.label.length > 0 && record.label.length <= 160
    && typeof record.machine === "string" && record.machine.length > 0 && record.machine.length <= 200
    && (record.kind === "bash" || record.kind === "codex")
    && typeof record.pane === "string" && /^%\d+$/.test(record.pane)
    && typeof record.tmuxSession === "string" && /^[A-Za-z0-9_.-]{1,120}$/.test(record.tmuxSession)
    && typeof record.socket === "string" && /^[A-Za-z0-9_.-]{1,120}$/.test(record.socket)
    && typeof record.cwd === "string" && /^\/[^\0\r\n]{0,499}$/.test(record.cwd)
    && Number.isSafeInteger(record.createdAt) && (record.createdAt ?? 0) > 0;
}

/** Persist only non-secret tmux identity; the process itself remains authoritative. */
export class ManagedSessionStore {
  constructor(readonly file: string) {}

  load(): ManagedSessionRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      const doc = JSON.parse(readFileSync(this.file, "utf8"));
      if (!doc || doc.version !== 1 || !Array.isArray(doc.sessions) || !doc.sessions.every(validRecord)) throw new Error("invalid");
      return doc.sessions;
    } catch {
      throw new SessionError("Saved managed sessions are invalid. Inspect .discord-bridge/managed-sessions.json.");
    }
  }

  save(sessions: ManagedSessionRecord[]): void {
    if (!sessions.every(validRecord)) throw new SessionError("Cannot persist an invalid managed session.");
    const parent = dirname(this.file);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, sessions }), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  add(record: ManagedSessionRecord): void {
    const sessions = this.load().filter(item => item.id !== record.id);
    sessions.push(record);
    this.save(sessions);
  }

  remove(id: string): void {
    if (!MANAGED_SESSION_ID.test(id)) throw new SessionError("Invalid managed session ID.");
    this.save(this.load().filter(record => record.id !== id));
  }
}

export function managedKind(value: string): ManagedKind {
  if (value !== "bash" && value !== "codex") throw new SessionError("Session kind must be bash or codex.");
  return value;
}
