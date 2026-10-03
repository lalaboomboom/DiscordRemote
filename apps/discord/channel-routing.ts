import { SessionError } from "./errors.js";
import type { CategoryBindingRecord, ChannelBindingRecord } from "./topology.js";

const DISCORD_ID = /^\d{17,20}$/;
const TERMINAL_ID = /^(?:tmux-[a-f0-9]{10}|pty-[a-f0-9]{32}|vsc-[a-f0-9]{16}-[a-f0-9]{8})$/;

export interface BoundTerminalChannelContext {
  guildId: string | null;
  channelId: string;
  parentId: string | null;
  bootstrapChannelId?: string;
  orchestratorChannelId?: string;
  binding?: ChannelBindingRecord;
  category?: CategoryBindingRecord;
}

/** Channel authorization is independent of legacy selections and terminal lifecycle. */
export function isBoundTerminalChannel(context: BoundTerminalChannelContext): boolean {
  const { guildId, channelId, parentId, bootstrapChannelId, orchestratorChannelId, binding, category } = context;
  if (!guildId || !parentId || !DISCORD_ID.test(guildId) || !DISCORD_ID.test(channelId) || !DISCORD_ID.test(parentId)
    || channelId === bootstrapChannelId || channelId === orchestratorChannelId || !binding || !category) return false;
  return binding.guildId === guildId && binding.channelId === channelId
    && binding.categoryId === parentId && category.guildId === guildId && category.categoryId === parentId
    && Boolean(binding.hostId) && binding.hostId === category.hostId;
}

/** Resolve only a ready channel's exact persisted ID; there is no demo/selection fallback. */
export function requireBoundTerminalId(context: BoundTerminalChannelContext): string {
  if (!isBoundTerminalChannel(context)) {
    throw new SessionError("This channel is not bound to a terminal. Use /terminal attach or /terminal create-channel in the operator.");
  }
  const binding = context.binding!;
  if (binding.status !== "ready") throw new SessionError("This terminal channel is not ready. Inspect /status before sending input.");
  if (!binding.terminalId || !TERMINAL_ID.test(binding.terminalId)) {
    throw new SessionError("This channel has no valid bound terminal. Inspect /status before sending input.");
  }
  return binding.terminalId;
}
