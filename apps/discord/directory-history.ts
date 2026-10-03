import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SessionError } from "./errors.js";
import { HostPlatform, sameWorkingDirectory, validWorkingDirectory } from "./platform.js";

interface DirectoryHistoryItem {
  guildId: string;
  hostId: string;
  cwd: string;
  platform: HostPlatform;
  updatedAt: number;
}

const maximumPerHost = 4;
const maximumItems = 1024;
const maximumFileBytes = 4 * 1024 * 1024;
const savedError = "Saved working-directory history is invalid; repair or restore it before recording another directory.";

function validScope(guildId: unknown, hostId: unknown, platform: unknown): platform is HostPlatform {
  return typeof guildId === "string" && /^\d{17,20}$/.test(guildId)
    && typeof hostId === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(hostId)
    && (platform === "linux" || platform === "win32");
}

function requireScope(guildId: string, hostId: string, platform: HostPlatform): void {
  if (!validScope(guildId, hostId, platform)) throw new SessionError("Working-directory history requires a valid guild, configured host ID and target platform.");
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

/** Only explicit, successfully used channel directories belong in this store. */
export class DirectoryHistoryStore {
  constructor(readonly file: string, private readonly clock: () => number = Date.now) {}

  initialize(): void {
    const items = this.read();
    try { lstatSync(this.file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new SessionError(savedError);
      this.write(items);
    }
  }

  list(guildId: string, hostId: string, platform: HostPlatform): string[] {
    requireScope(guildId, hostId, platform);
    return this.read().filter(item => item.guildId === guildId && item.hostId === hostId && item.platform === platform)
      .slice(0, maximumPerHost).map(item => item.cwd);
  }

  record(guildId: string, hostId: string, cwd: string, platform: HostPlatform): void {
    requireScope(guildId, hostId, platform);
    if (!validWorkingDirectory(cwd, platform)) throw new SessionError("Working-directory history requires an absolute path for the target OS, at most 500 characters.");
    const items = this.read();
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now <= 0) throw new SessionError("Working-directory history clock is invalid.");
    const updatedAt = Math.max(now, (items[0]?.updatedAt ?? 0) + 1);
    if (!Number.isSafeInteger(updatedAt)) throw new SessionError("Working-directory history clock exceeds its supported range.");
    const retained = items.filter(item => !(item.guildId === guildId && item.hostId === hostId
      && item.platform === platform && sameWorkingDirectory(item.cwd, cwd, platform)));
    const next: DirectoryHistoryItem[] = [{ guildId, hostId, cwd, platform, updatedAt }];
    let hostCount = 1;
    for (const item of retained) {
      if (item.guildId === guildId && item.hostId === hostId && ++hostCount > maximumPerHost) continue;
      next.push(item);
      if (next.length === maximumItems) break;
    }
    this.write(next);
  }

  private read(): DirectoryHistoryItem[] {
    let raw: unknown;
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.size > maximumFileBytes) throw new Error("Unsupported history file");
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new SessionError(savedError);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SessionError(savedError);
    const document = raw as Record<string, unknown>;
    if (!exactKeys(document, ["version", "items"]) || document.version !== 1 || !Array.isArray(document.items)
      || document.items.length > maximumItems) throw new SessionError(savedError);
    const items: DirectoryHistoryItem[] = [];
    const byHost = new Map<string, DirectoryHistoryItem[]>();
    for (const value of document.items) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new SessionError(savedError);
      const item = value as Record<string, unknown>;
      if (!exactKeys(item, ["guildId", "hostId", "cwd", "platform", "updatedAt"])
        || !validScope(item.guildId, item.hostId, item.platform) || !validWorkingDirectory(item.cwd, item.platform)
        || !Number.isSafeInteger(item.updatedAt) || (item.updatedAt as number) <= 0) throw new SessionError(savedError);
      const checked = item as unknown as DirectoryHistoryItem;
      // IDs cannot contain NUL; this keeps guild and physical-host scopes distinct.
      const scope = `${checked.guildId}\0${checked.hostId}`;
      const group = byHost.get(scope) ?? [];
      if (group.length >= maximumPerHost || group.some(prior => prior.platform === checked.platform
        && sameWorkingDirectory(prior.cwd, checked.cwd, checked.platform))) throw new SessionError(savedError);
      group.push(checked);
      byHost.set(scope, group);
      items.push(checked);
    }
    return items.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private write(items: DirectoryHistoryItem[]): void {
    const temporary = `${this.file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify({ version: 1, items }), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.file);
    } catch {
      throw new SessionError("Working-directory history could not be saved.");
    } finally {
      try { unlinkSync(temporary); } catch { /* An atomic rename already removed the temporary file. */ }
    }
  }
}
