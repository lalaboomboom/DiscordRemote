import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { SessionError } from "./errors.js";
import { validWorkingDirectory, requireWorkingDirectory } from "./platform.js";

const DISCORD_ID = /^\d{17,20}$/;
const HOST_ID = /^[A-Za-z0-9_.-]{1,80}$/;

export type ChannelProvisionStatus = "provisioning" | "ready" | "failed" | "orphaned" | "stopped";

export interface GuildSetupRecord {
  guildId: string;
  ownerId: string;
  orchestratorChannelId: string;
  version: 1;
  updatedAt: number;
}

export interface CategoryBindingRecord {
  guildId: string;
  categoryId: string;
  hostId: string;
  /** Human-readable project/profile label; older state files may omit it. */
  label?: string;
  defaultCwd: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelBindingRecord {
  guildId: string;
  channelId: string;
  categoryId: string;
  hostId: string;
  cwd: string;
  status: ChannelProvisionStatus;
  /** Original creation deadline; a delayed channel event must not start expired work. */
  provisioningDeadline?: number;
  terminalId?: string;
  /** External providers keep their original generation pinned to this channel. */
  terminalGeneration?: string;
  provider?: "tmux" | "conpty" | "vscode" | "vscode-agent";
  /** Enrolled VS Code UI relay; hostId remains the actual terminal machine. */
  relayMachine?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

function validSetup(value: unknown): value is GuildSetupRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<GuildSetupRecord>;
  return record.version === 1
    && typeof record.guildId === "string" && DISCORD_ID.test(record.guildId)
    && typeof record.ownerId === "string" && DISCORD_ID.test(record.ownerId)
    && typeof record.orchestratorChannelId === "string" && DISCORD_ID.test(record.orchestratorChannelId)
    && Number.isSafeInteger(record.updatedAt) && (record.updatedAt ?? 0) > 0;
}

function validCategory(value: unknown): value is CategoryBindingRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<CategoryBindingRecord>;
  return typeof record.guildId === "string" && DISCORD_ID.test(record.guildId)
    && typeof record.categoryId === "string" && DISCORD_ID.test(record.categoryId)
    && typeof record.hostId === "string" && HOST_ID.test(record.hostId)
    && (record.label === undefined || (typeof record.label === "string" && record.label.length >= 1 && record.label.length <= 100))
    && validWorkingDirectory(record.defaultCwd)
    && Number.isSafeInteger(record.createdAt) && (record.createdAt ?? 0) > 0
    && Number.isSafeInteger(record.updatedAt) && (record.updatedAt ?? 0) > 0;
}

function validChannel(value: unknown): value is ChannelBindingRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ChannelBindingRecord>;
  return typeof record.guildId === "string" && DISCORD_ID.test(record.guildId)
    && typeof record.channelId === "string" && DISCORD_ID.test(record.channelId)
    && typeof record.categoryId === "string" && DISCORD_ID.test(record.categoryId)
    && typeof record.hostId === "string" && HOST_ID.test(record.hostId)
    && validWorkingDirectory(record.cwd)
    && (record.status === "provisioning" || record.status === "ready" || record.status === "failed" || record.status === "orphaned" || record.status === "stopped")
    && (record.provisioningDeadline === undefined || (Number.isSafeInteger(record.provisioningDeadline) && record.provisioningDeadline > 0))
    && (record.terminalId === undefined || /^(?:tmux-[a-f0-9]{10}|pty-[a-f0-9]{32}|vsc-[a-f0-9]{16}-[a-f0-9]{8})$/.test(record.terminalId))
    && (record.terminalGeneration === undefined || /^[a-f0-9]{32}$/.test(record.terminalGeneration))
    && (record.provider === undefined || ["tmux", "conpty", "vscode", "vscode-agent"].includes(record.provider))
    && (record.relayMachine === undefined || (record.provider === "vscode-agent"
      && typeof record.relayMachine === "string" && /^agent-[a-f0-9]{16}$/.test(record.relayMachine)))
    && (record.provider !== "vscode-agent" || record.relayMachine !== undefined || /^agent-[a-f0-9]{16}$/.test(record.hostId))
    && (!record.terminalId?.startsWith("vsc-") || ((record.provider === "vscode" || record.provider === "vscode-agent")
      && typeof record.terminalGeneration === "string" && /^[a-f0-9]{32}$/.test(record.terminalGeneration)))
    && (record.provider !== "vscode" && record.provider !== "vscode-agent" || Boolean(record.terminalId?.startsWith("vsc-")))
    && (record.error === undefined || (typeof record.error === "string" && record.error.length <= 500))
    && Number.isSafeInteger(record.createdAt) && (record.createdAt ?? 0) > 0
    && Number.isSafeInteger(record.updatedAt) && (record.updatedAt ?? 0) > 0;
}

function atomicWrite(file: string, value: unknown): void {
  const parent = dirname(file);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, file);
}

export function validateDiscordId(value: string, field = "Discord ID"): void {
  if (!DISCORD_ID.test(value)) throw new SessionError(`${field} is invalid.`);
}

export function validateHostId(value: string): void {
  if (!HOST_ID.test(value)) throw new SessionError("Machine must be a configured host ID.");
}

export function validateWorkingDirectory(value: string): void {
  requireWorkingDirectory(value);
}

export function categoryDisplayName(label: string, fallback = "machine"): string {
  const clean = label.replace(/[\r\n]/g, " ").trim().replace(/\s+/g, " ");
  const value = clean || fallback;
  return value.slice(0, 100);
}

export function channelDisplayName(name: string, fallback = "terminal"): string {
  const clean = name.toLowerCase().replace(/[^a-z0-9-_ ]/g, "").trim().replace(/\s+/g, "-");
  const value = clean || fallback;
  return value.slice(0, 100);
}

export class GuildSetupStore {
  constructor(readonly file: string) {}

  get(guildId: string): GuildSetupRecord | undefined {
    validateDiscordId(guildId, "Guild ID");
    const setups = this.read();
    return setups.find(setup => setup.guildId === guildId);
  }

  set(record: GuildSetupRecord): void {
    if (!validSetup(record)) throw new SessionError("Cannot persist invalid guild setup.");
    const setups = this.read().filter(setup => setup.guildId !== record.guildId);
    setups.push(record);
    atomicWrite(this.file, { version: 1, setups });
  }

  private read(): GuildSetupRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      const doc = JSON.parse(readFileSync(this.file, "utf8"));
      if (!doc || doc.version !== 1 || !Array.isArray(doc.setups) || !doc.setups.every(validSetup)) throw new Error("invalid");
      return doc.setups;
    } catch {
      throw new SessionError("Saved guild setup is invalid. Inspect .discord-bridge/guild-setup.json.");
    }
  }
}

export class CategoryBindingStore {
  constructor(readonly file: string) {}

  list(guildId?: string): CategoryBindingRecord[] {
    if (guildId) validateDiscordId(guildId, "Guild ID");
    return this.read().filter(binding => !guildId || binding.guildId === guildId);
  }

  get(categoryId: string): CategoryBindingRecord | undefined {
    validateDiscordId(categoryId, "Category ID");
    return this.read().find(binding => binding.categoryId === categoryId);
  }

  findByHost(guildId: string, hostId: string): CategoryBindingRecord | undefined {
    validateDiscordId(guildId, "Guild ID");
    validateHostId(hostId);
    return this.read().find(binding => binding.guildId === guildId && binding.hostId === hostId);
  }

  findByHostAndCwd(guildId: string, hostId: string, cwd: string): CategoryBindingRecord | undefined {
    validateDiscordId(guildId, "Guild ID");
    validateHostId(hostId);
    validateWorkingDirectory(cwd);
    return this.read().find(binding => binding.guildId === guildId && binding.hostId === hostId && binding.defaultCwd === cwd);
  }

  set(record: CategoryBindingRecord): void {
    if (!validCategory(record)) throw new SessionError("Cannot persist invalid category binding.");
    const normalized = { ...record, label: record.label ?? record.hostId };
    // Multiple project profiles may belong to the same host. Category ID is
    // the durable identity; host/cwd duplicates are handled by the caller.
    const bindings = this.read().filter(binding => binding.categoryId !== record.categoryId);
    bindings.push(normalized);
    atomicWrite(this.file, { version: 1, bindings });
  }

  remove(categoryId: string): void {
    validateDiscordId(categoryId, "Category ID");
    atomicWrite(this.file, { version: 1, bindings: this.read().filter(binding => binding.categoryId !== categoryId) });
  }

  private read(): CategoryBindingRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      const doc = JSON.parse(readFileSync(this.file, "utf8"));
      if (!doc || doc.version !== 1 || !Array.isArray(doc.bindings) || !doc.bindings.every(validCategory)) throw new Error("invalid");
      return doc.bindings;
    } catch {
      throw new SessionError("Saved category bindings are invalid. Inspect .discord-bridge/category-bindings.json.");
    }
  }
}

export class ChannelBindingStore {
  constructor(readonly file: string) {}

  list(guildId?: string): ChannelBindingRecord[] {
    if (guildId) validateDiscordId(guildId, "Guild ID");
    return this.read().filter(binding => !guildId || binding.guildId === guildId);
  }

  get(channelId: string): ChannelBindingRecord | undefined {
    validateDiscordId(channelId, "Channel ID");
    return this.read().find(binding => binding.channelId === channelId);
  }

  set(record: ChannelBindingRecord): void {
    if (!validChannel(record)) throw new SessionError("Cannot persist invalid terminal channel binding.");
    const bindings = this.read().filter(binding => binding.channelId !== record.channelId);
    bindings.push(record);
    atomicWrite(this.file, { version: 1, bindings });
  }

  remove(channelId: string): void {
    validateDiscordId(channelId, "Channel ID");
    atomicWrite(this.file, { version: 1, bindings: this.read().filter(binding => binding.channelId !== channelId) });
  }

  private read(): ChannelBindingRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      const doc = JSON.parse(readFileSync(this.file, "utf8"));
      if (!doc || doc.version !== 1 || !Array.isArray(doc.bindings) || !doc.bindings.every(validChannel)) throw new Error("invalid");
      return doc.bindings;
    } catch {
      throw new SessionError("Saved terminal channel bindings are invalid. Inspect .discord-bridge/channel-bindings.json.");
    }
  }
}
