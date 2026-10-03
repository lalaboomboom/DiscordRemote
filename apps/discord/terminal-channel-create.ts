import { SessionError } from "./errors.js";
import { HostPlatform, sameWorkingDirectory } from "./platform.js";
import { boundTerminalDirectory, terminalCreateDirectory } from "./terminal-directory.js";
import { CategoryBindingRecord, ChannelBindingStore } from "./topology.js";

interface CreatedChannel { id: string; parentId: string | null }
export interface TerminalChannelCreation<T extends CreatedChannel> {
  category: CategoryBindingRecord;
  platform: HostPlatform;
  cwd?: string | null;
  deadline: number;
  bindings: ChannelBindingStore;
  currentCategory: () => CategoryBindingRecord | undefined;
  probe: (cwd: string) => Promise<unknown>;
  createPrivate: () => Promise<T>;
  link: (channel: T) => Promise<T>;
  remove: (channel: T) => Promise<unknown>;
  provision: (channel: T) => Promise<void>;
  now?: () => number;
}

/** Reserve the explicit directory before a parent/Gateway event can provision.
 * Existing records survive uncertain parent/provision failures for inspection. */
export async function createTerminalChannel<T extends CreatedChannel>(options: TerminalChannelCreation<T>): Promise<T> {
  const { category, bindings } = options, now = options.now ?? Date.now;
  const cwd = terminalCreateDirectory(category, options.platform, options.cwd);
  const check = (channelId?: string) => {
    if (now() >= options.deadline) throw new SessionError("Terminal creation expired; no further creation was performed.");
    const current = options.currentCategory();
    if (!current || current.guildId !== category.guildId || current.categoryId !== category.categoryId || current.hostId !== category.hostId) throw new SessionError("Category machine changed during terminal creation.");
    if (channelId) {
      const binding = bindings.get(channelId);
      if (!binding || !sameWorkingDirectory(boundTerminalDirectory(current, binding, options.platform), cwd, options.platform)) throw new SessionError("Terminal directory binding changed during creation.");
    }
  };
  check();
  await options.probe(cwd);
  check();
  const created = await options.createPrivate();
  try {
    check();
    if (created.parentId !== null || bindings.get(created.id)) throw new SessionError("New terminal channel must be private and unbound before reservation.");
    bindings.set({ guildId: category.guildId, channelId: created.id, categoryId: category.categoryId,
      hostId: category.hostId, cwd, status: "provisioning", provisioningDeadline: options.deadline, createdAt: now(), updatedAt: now() });
  } catch (error) {
    if (created.parentId === null && !bindings.get(created.id)) await options.remove(created).catch(() => undefined);
    throw error;
  }
  // Once persisted, never replace it or start another channel after ambiguity.
  const linked = await options.link(created);
  check(created.id);
  if (linked.id !== created.id || linked.parentId !== category.categoryId) throw new SessionError("New terminal channel moved during creation; its binding was retained.");
  await options.provision(linked);
  return linked;
}
