import { createHash } from "node:crypto";
import { SessionError } from "./errors.js";
import { sameWorkingDirectory, validWorkingDirectory, type HostPlatform } from "./platform.js";

export interface DirectoryChoiceContext {
  guildId: string;
  /** Exact registered physical host ID, never its display name or UI relay. */
  hostId: string;
  platform: HostPlatform;
  recent: readonly string[];
  defaultCwd: string;
}
export interface DirectoryChoice { name: string; value: string }

const REFERENCE_PREFIX = "cwd-ref:";
const REFERENCE = /^cwd-ref:[a-f0-9]{64}$/;

function candidates(context: DirectoryChoiceContext): Array<{ cwd: string; label: "Recent" | "Default" }> {
  const result: Array<{ cwd: string; label: "Recent" | "Default" }> = [];
  for (const cwd of context.recent) {
    if (!validWorkingDirectory(cwd, context.platform)
      || result.some(item => sameWorkingDirectory(item.cwd, cwd, context.platform))) continue;
    result.push({ cwd, label: "Recent" });
    if (result.length === 4) break;
  }
  if (validWorkingDirectory(context.defaultCwd, context.platform)
    && !result.some(item => sameWorkingDirectory(item.cwd, context.defaultCwd, context.platform))) {
    result.push({ cwd: context.defaultCwd, label: "Default" });
  }
  return result;
}

function reference(context: DirectoryChoiceContext, cwd: string): string {
  const scope = JSON.stringify(["cwd-ref-v1", context.guildId, context.hostId, context.platform, cwd]);
  return REFERENCE_PREFIX + createHash("sha256").update(scope).digest("hex");
}

/** Discord choice names/string values are at most 100 characters; paths are never truncated. */
export function directoryChoices(context: DirectoryChoiceContext & { query: string }): DirectoryChoice[] {
  const needle = context.query.toLowerCase();
  return candidates(context).filter(item => item.cwd.toLowerCase().includes(needle)).map(item => {
    let name = `${item.label}: ${item.cwd}`.slice(0, 100);
    if (/[\uD800-\uDBFF]$/.test(name)) name = name.slice(0, -1);
    return { name, value: item.cwd.length <= 100 ? item.cwd : reference(context, item.cwd) };
  });
}

/** Only current, exact-scope references resolve; typed paths retain downstream validation. */
export function resolveDirectoryChoice(context: DirectoryChoiceContext & { value: string | null }): string | null {
  if (context.value === null || !context.value.startsWith(REFERENCE_PREFIX)) return context.value;
  if (REFERENCE.test(context.value)) {
    const candidate = candidates(context).find(item => reference(context, item.cwd) === context.value);
    if (candidate) return candidate.cwd;
  }
  throw new SessionError("Directory suggestion expired or belongs to another machine. Choose a current suggestion or enter an absolute path.");
}
