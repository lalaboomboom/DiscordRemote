import { constants, BigIntStats } from "node:fs";
import { FileHandle, lstat, open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { SessionError } from "./errors.js";
import { HostPlatform, localPlatform, sameWorkingDirectory, validWorkingDirectory } from "./platform.js";

export interface CodexEventCursor { relativePath: string; fileIdentity: string; offset: number }
export interface CodexEventRequest { threadId: string; cwd: string; cursor?: CodexEventCursor }
export interface CodexEventResult {
  threadId: string; cwd: string; cursor: CodexEventCursor;
  events: Array<{ turnId: string; completedAt: number }>;
}
export type CodexEventResponse = CodexEventResult;

// Keep these bounds and cursor semantics aligned with the read-only SSH adapter.
export const CODEX_EVENT_LIMITS = { fileBytes: 512 * 1024 * 1024, scanEntries: 10_000, chunkBytes: 1024 * 1024, events: 128 } as const;
const UUID = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const uuid = new RegExp(`^${UUID}$`);
const relativePath = new RegExp(`^sessions/(\\d{4})/(\\d{2})/(\\d{2})/rollout-(\\d{4})-(\\d{2})-(\\d{2})T\\d{2}-\\d{2}-\\d{2}-(${UUID})\\.jsonl$`);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));

function pathThread(value: string): string | undefined {
  const match = relativePath.exec(value);
  return match && match[1] === match[4] && match[2] === match[5] && match[3] === match[6] ? match[7] : undefined;
}
export function validCodexEventCursor(value: unknown): value is CodexEventCursor {
  return record(value) && onlyKeys(value, ["relativePath", "fileIdentity", "offset"]) && typeof value.relativePath === "string" && !!pathThread(value.relativePath)
    && typeof value.fileIdentity === "string" && /^\d+:\d+:\d+$/.test(value.fileIdentity) && value.fileIdentity.length <= 100
    && Number.isSafeInteger(value.offset) && Number(value.offset) >= 0 && Number(value.offset) <= CODEX_EVENT_LIMITS.fileBytes;
}
export function validCodexEventRequest(value: unknown): value is CodexEventRequest {
  return record(value) && onlyKeys(value, ["threadId", "cwd", "cursor"]) && typeof value.threadId === "string" && uuid.test(value.threadId) && validWorkingDirectory(value.cwd)
    && (value.cursor === undefined || validCodexEventCursor(value.cursor) && pathThread(value.cursor.relativePath) === value.threadId);
}
export function validCodexEventResponse(value: unknown): value is CodexEventResult {
  return record(value) && onlyKeys(value, ["threadId", "cwd", "cursor", "events"]) && typeof value.threadId === "string" && uuid.test(value.threadId) && validWorkingDirectory(value.cwd)
    && validCodexEventCursor(value.cursor) && pathThread(value.cursor.relativePath) === value.threadId
    && Array.isArray(value.events) && value.events.length <= CODEX_EVENT_LIMITS.events
    && value.events.every(event => record(event) && onlyKeys(event, ["turnId", "completedAt"]) && typeof event.turnId === "string" && uuid.test(event.turnId)
      && Number.isSafeInteger(event.completedAt) && Number(event.completedAt) > 0 && Number(event.completedAt) <= 8_640_000_000_000_000);
}

const unavailable = () => new SessionError("Codex event source is unavailable or unsupported; notifications are paused.");
const changed = () => new SessionError("Codex event source changed or was truncated; notifications are paused. Subscribe again explicitly.");

async function assertPath(home: string, relative: string): Promise<string> {
  let path = home;
  for (const part of relative.split("/")) {
    path = join(path, part);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw unavailable();
  }
  return path;
}

/** Discover by exact UUID only; ordering, cwd and recency never select a source. */
async function findSource(home: string, threadId: string): Promise<string> {
  const candidates: string[] = [];
  let scanned = 0;
  async function visit(parts: string[]): Promise<void> {
    const directory = parts.join("/");
    await assertPath(home, directory);
    const entries = await opendir(join(home, ...parts));
    for await (const entry of entries) {
      if (++scanned > CODEX_EVENT_LIMITS.scanEntries) throw unavailable();
      if (parts.length < 4) {
        const pattern = parts.length === 1 ? /^\d{4}$/ : /^\d{2}$/;
        if (entry.isDirectory() && pattern.test(entry.name)) await visit([...parts, entry.name]);
      } else {
        const relative = [...parts, entry.name].join("/");
        if (pathThread(relative) === threadId) {
          if (entry.isSymbolicLink() || !entry.isFile()) throw unavailable();
          candidates.push(relative);
          if (candidates.length > 1) throw unavailable();
        }
      }
    }
  }
  await visit(["sessions"]);
  if (candidates.length !== 1) throw unavailable();
  return candidates[0];
}

function identity(stat: BigIntStats): string {
  // Linux Python stat has no portable birthtime; its SSH adapter uses this same dev:ino:0 identity.
  return `${stat.dev}:${stat.ino}:${process.platform === "win32" ? stat.birthtimeNs : 0}`;
}
function decodeLine(bytes: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (record(value)) return value;
  } catch { /* Do not include private transcript text in an error. */ }
  throw unavailable();
}
async function readAt(file: FileHandle, offset: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  const result = await file.read(bytes, 0, length, offset);
  return bytes.subarray(0, result.bytesRead);
}
function completionTime(value: unknown): number | undefined {
  let time: number;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    time = value < 1_000_000_000_000 ? value * 1000 : value;
  } else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
    const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || Number(value.slice(11, 13)) > 23
      || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return undefined;
    const zone = /[+-](\d{2}):(\d{2})$/.exec(value);
    if (zone && (Number(zone[1]) > 23 || Number(zone[2]) > 59)) return undefined;
    time = Date.parse(value);
  } else return undefined;
  return Number.isSafeInteger(time) && time > 0 && time <= 8_640_000_000_000_000 ? time : undefined;
}

/** Read native completion identities only. Never return prompts, replies or other transcript contents. */
export async function readCodexEvents(
  request: CodexEventRequest,
  options: { codexHome?: string; platform?: HostPlatform } = {},
): Promise<CodexEventResult> {
  if (!validCodexEventRequest(request)) throw new SessionError("Invalid Codex event request.");
  const platform = options.platform ?? localPlatform();
  if (!validWorkingDirectory(request.cwd, platform)) throw new SessionError("Invalid Codex event working directory.");
  const configuredHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  if (!isAbsolute(configuredHome)) throw unavailable();
  let file: FileHandle | undefined;
  try {
    const home = await realpath(resolve(configuredHome));
    const relative = request.cursor?.relativePath ?? await findSource(home, request.threadId);
    const path = await assertPath(home, relative);
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(CODEX_EVENT_LIMITS.fileBytes)) throw unavailable();
    const size = Number(before.size);
    const fileIdentity = identity(before);
    if (request.cursor && (request.cursor.fileIdentity !== fileIdentity || request.cursor.offset > size)) throw changed();
    const header = await readAt(file, 0, Math.min(size, CODEX_EVENT_LIMITS.chunkBytes));
    const headerEnd = header.indexOf(10);
    if (headerEnd < 0) throw unavailable();
    const metadata = decodeLine(header.subarray(0, headerEnd));
    const payload = metadata.payload;
    if (metadata.type !== "session_meta" || !record(payload) || payload.id !== request.threadId || payload.source !== "cli"
      || !validWorkingDirectory(payload.cwd, platform) || !sameWorkingDirectory(payload.cwd, request.cwd, platform)) throw unavailable();
    // Only the FIRST native metadata binds a thread. Later imported parent metadata is not a new identity.
    let offset = request.cursor?.offset ?? size;
    if (offset < headerEnd + 1) throw changed();
    const events: CodexEventResult["events"] = [];
    if (request.cursor && offset < size) {
      const bytes = await readAt(file, offset, Math.min(size - offset, CODEX_EVENT_LIMITS.chunkBytes));
      const prior = offset ? await readAt(file, offset - 1, 1) : Buffer.from([10]);
      let position = 0;
      if (prior[0] !== 10) {
        // Subscription at EOF may land inside a record. Never emit the completion begun before subscription.
        const firstEnd = bytes.indexOf(10);
        position = firstEnd < 0 ? bytes.length : firstEnd + 1;
        offset += position;
      }
      while (position < bytes.length) {
        const end = bytes.indexOf(10, position);
        if (end < 0) {
          if (bytes.length - position >= CODEX_EVENT_LIMITS.chunkBytes) throw unavailable();
          break; // Keep offset at the preceding LF until a new partial record is complete.
        }
        const value = decodeLine(bytes.subarray(position, end));
        position = end + 1;
        offset = (request.cursor.offset ?? 0) + position;
        if (value.type === "event_msg") {
          if (!record(value.payload) || typeof value.payload.type !== "string") throw unavailable();
          if (value.payload.type === "task_complete") {
            const turnId = value.payload.turn_id;
            const completedAt = completionTime(value.payload.completed_at === undefined ? value.timestamp : value.payload.completed_at);
            if (typeof turnId !== "string" || !uuid.test(turnId) || completedAt === undefined) throw unavailable();
            const reply = value.payload.last_agent_message;
            if (reply !== undefined && reply !== null && typeof reply !== "string") throw unavailable();
            // Some older native completions have no final reply. They must not announce that Codex replied.
            if (typeof reply !== "string" || !reply.trim()) continue;
            events.push({ turnId, completedAt });
            if (events.length >= CODEX_EVENT_LIMITS.events) break;
          }
        }
      }
    }
    const after = await file.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!after.isFile() || current.isSymbolicLink() || identity(after) !== fileIdentity || identity(current) !== fileIdentity
      || after.size < before.size || after.size < BigInt(offset) || after.size > BigInt(CODEX_EVENT_LIMITS.fileBytes)) throw changed();
    return { threadId: request.threadId, cwd: request.cwd, cursor: { relativePath: relative, fileIdentity, offset }, events };
  } catch (error) {
    if (error instanceof SessionError) throw error;
    throw request.cursor ? changed() : unavailable();
  } finally { await file?.close(); }
}
