import { TerminalControl, TerminalKey } from "./core.js";
import { SessionError } from "./errors.js";

export const PTY_KEY_PROTOCOL = "named-keys-v2" as const;

/** Existing supervisors keep their processes and cannot acquire new keys from a build. */
export function requirePtyKeyProtocol(record: { keyProtocol?: string }, key: TerminalKey): void {
  if (key === "shift-left" && record.keyProtocol !== PTY_KEY_PROTOCOL) {
    throw new SessionError("Shift + Left is unavailable in this running Windows terminal supervisor. Keep its terminals running; safely upgrade the supervisor after all managed terminals are closed.");
  }
}

export interface PtyRecord {
  id: string;
  label: string;
  machine: string;
  cwd: string;
  kind: "shell" | "codex";
  provider: "conpty";
  generation: string;
  createdAt: number;
  alive: boolean;
  /** Absent on supervisors started before modified named keys were supported. */
  keyProtocol?: typeof PTY_KEY_PROTOCOL;
}

export interface ManagedTerminal extends TerminalControl {
  record: { id: string; label: string; machine: string; cwd: string; kind: string };
  stop(): Promise<void>;
}

export interface SupervisorEndpoint {
  version: 1;
  port: number;
  token: string;
  generation: string;
  pid: number;
}
