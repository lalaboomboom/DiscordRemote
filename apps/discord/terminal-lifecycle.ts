import { SessionError } from "./errors.js";
import { ChannelBindingRecord, ChannelBindingStore } from "./topology.js";
import { ChannelSessionStore } from "./channel-sessions.js";
import { ManagedTerminal } from "./pty-protocol.js";

export function isStoppedBinding(binding?: ChannelBindingRecord): boolean {
  return binding?.status === "stopped" || (binding?.status === "orphaned" && binding.error === "Stopped by owner.");
}

/** Both managed providers share this lifecycle. A failed stop never deletes a
 * channel; a failed delete retains the stopped binding for a safe close retry. */
export async function terminalLifecycle(options: {
  action: "stop" | "close";
  confirm: boolean;
  channelId: string;
  parentId?: string;
  protectedChannel: boolean;
  bindings: ChannelBindingStore;
  selections: ChannelSessionStore;
  terminal?: ManagedTerminal;
  stop: (id: string) => Promise<unknown>;
  beforeDelete: () => Promise<void>;
  deleteChannel: () => Promise<void>;
}): Promise<{ alreadyStopped: boolean; deleted: boolean }> {
  const { bindings, selections, channelId } = options;
  if (!options.confirm) throw new SessionError("Use confirm:true to stop or close this terminal.");
  if (options.protectedChannel) throw new SessionError("The operator/bootstrap channel cannot be stopped or deleted. Use a child terminal channel.");
  const binding = bindings.get(channelId);
  if (!binding || binding.categoryId !== options.parentId) throw new SessionError("This channel is not bound to its original machine category; no lifecycle action performed.");
  if (binding.status === "provisioning") throw new SessionError("Terminal creation is in progress; wait before stopping or closing it.");
  const alreadyStopped = isStoppedBinding(binding);
  if (!alreadyStopped) {
    if (!binding.terminalId || !options.terminal || options.terminal.record.id !== binding.terminalId
      || options.terminal.record.machine !== binding.hostId) throw new SessionError("The exact managed terminal is unavailable. Its stop cannot be verified, so the channel was kept. Inspect the host before cleanup.");
    await options.stop(binding.terminalId);
    bindings.set({ ...binding, status: "stopped", error: "Stopped by owner.", updatedAt: Date.now() });
  }
  selections.remove(channelId);
  if (options.action === "close") {
    // Acknowledge while the channel still exists; don't edit a deleted reply later.
    await options.beforeDelete();
    try { await options.deleteChannel(); }
    catch { throw new SessionError("Terminal is stopped, but Discord could not delete the channel. Fix channel permissions and retry /terminal close confirm:true."); }
    bindings.remove(channelId);
    return { alreadyStopped, deleted: true };
  }
  return { alreadyStopped, deleted: false };
}
