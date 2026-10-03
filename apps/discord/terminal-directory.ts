import { SessionError } from "./errors.js";
import { requireWorkingDirectory, type HostPlatform } from "./platform.js";
import type { CategoryBindingRecord, ChannelBindingRecord } from "./topology.js";

/** Choose a new terminal's directory before probing or creating its channel.
 * The category directory is a default, not an existing channel's authority. */
export function terminalCreateDirectory(category: CategoryBindingRecord, platform: HostPlatform, requestedCwd?: string | null): string {
  const cwd = requestedCwd ?? category.defaultCwd;
  requireWorkingDirectory(cwd, platform);
  return cwd;
}

/** Return the channel's persisted directory without adopting a changed default.
 * Callers separately enforce channel parent, lifecycle and terminal identity. */
export function boundTerminalDirectory(category: CategoryBindingRecord, binding: ChannelBindingRecord, platform: HostPlatform): string {
  if (binding.guildId !== category.guildId || binding.categoryId !== category.categoryId || binding.hostId !== category.hostId) {
    throw new SessionError("Terminal channel does not match its registered machine category; no directory was substituted.");
  }
  requireWorkingDirectory(binding.cwd, platform);
  return binding.cwd;
}

/** A fresh ChannelCreate has no binding and uses the category default. An
 * explicit create persists its chosen directory before linking the parent.
 * This does not authorize replay of a historical/ambiguous provisioning job. */
export function terminalProvisionDirectory(category: CategoryBindingRecord, platform: HostPlatform, existing?: ChannelBindingRecord): string {
  if (!existing) return terminalCreateDirectory(category, platform);
  const cwd = boundTerminalDirectory(category, existing, platform);
  if (existing.status !== "provisioning" || existing.terminalId !== undefined || existing.provider !== undefined
    || existing.terminalGeneration !== undefined || existing.relayMachine !== undefined || existing.error !== undefined) {
    throw new SessionError("Existing terminal binding cannot start another process; no directory was substituted.");
  }
  return cwd;
}
